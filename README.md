# Workers Platform

Self-hosted платформа для запуска Cloudflare Workers-совместимого кода с биндингами
**D1** (SQL), **KV**, **Queues** и **Secrets** — управляемая через REST API и CLI.

## Архитектура

```
┌─────────────────────────────────────────────────────┐
│                Control Plane (Hono API)             │
│  workers, versions, D1, KV, queues, secrets, audit  │
└───────────────┬─────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────┐
│          Runtime: workerd via Miniflare              │
│  изолят на воркер + шим (env.D1/KV/QUEUE/SECRETS)   │
│  service bindings: D1→libSQL, KV/Queue→Dragonfly    │
│  outboundService: egress allowlist + SSRF защита    │
└───────────────┬─────────────────────────────────────┘
                │
   ┌────────────┼──────────────┐
   ▼            ▼              ▼
PostgreSQL   Redis         libSQL files
(каталог)    (KV/Queues)   (D1 данные)
```

- **Runtime**: workerd (встроен через Miniflare 3 — официальный embed-слой, на котором
  работает сам `wrangler dev`). Изолированные V8 изоляты, горячая перезагрузка версий.
- **Шим**: перед каждым воркером инжектится платформенная прослойка, которая
  превращает service-биндинги в привычный API: `env.MY_DB.prepare()`,
  `env.CACHE.get()`, `env.JOBS.send()`, `env.SECRETS.get()`.
- **Каталог**: PostgreSQL (Drizzle ORM) — воркеры, версии, биндинги, секреты, аудит, usage.
- **Секреты**: AES-256-GCM + HKDF (per-worker ключи из мастер-ключа), никогда не в plaintext.

---

## Быстрый старт (Production)

```bash
# 1. Клонируй репозиторий
git clone https://github.com/ArseniyKvasov/workers.git
cd workers

# 2. Настрой конфигурацию
cp .env.example .env
# Отредактируй .env: заполни SECRETS_MASTER_KEY, API_KEY, DOMAIN, S3_* и т.д.
# Минимум: SECRETS_MASTER_KEY, API_KEY, DOMAIN

# 2a. Сгенерируй ключи
openssl rand -base64 32   # → SECRETS_MASTER_KEY
openssl rand -hex 16 | sed 's/^/wpk_/'  # → API_KEY

# 3. Запусти инфраструктуру (Postgres, Redis, App, Nginx)
docker compose up -d

# 4. Создай папку для D1 данных
sudo mkdir -p /var/lib/workers-platform && sudo chown -R 1000:1000 /var/lib/workers-platform

# 4. Миграции БД
docker compose exec app node --require dotenv/config packages/catalog/dist/migrate-cli.js

# 5. Создай первый API ключ (bootstrap)
docker compose exec app node --require dotenv/config -e "
const { generateApiKey } = require('./packages/api/dist/auth.js');
const { createCatalogDb } = require('./packages/catalog/dist/client.js');
const { ApiKeysRepository } = require('./packages/catalog/dist/repositories2.js');
const { db } = createCatalogDb({ databaseUrl: process.env.DATABASE_URL });
const repo = new ApiKeysRepository(db);
const { key } = generateApiKey();
repo.create({ name: 'initial', prefix: key.split('_')[1], hash: require('crypto').createHash('sha256').update(key).digest('hex') });
console.log('API_KEY:', key);
"
```

### Проверка работы

```bash
# Health checks
curl http://localhost:8080/health
curl http://localhost:8080/ready

# Публичный ingress воркера (без auth, через nginx; адрес — последние 6 символов UUID)
curl -X POST https://<uuid-last-6>.workers.fastclass.ru -d '{"action":"test"}'

# Management API (требует API_KEY из .env)
curl -H "Authorization: Bearer $API_KEY" http://localhost:8080/api/workers
```

---

## Разработка (Local Dev)

```bash
# 1. Зависимости
pnpm install

# 2. Инфраструктура для разработки (Postgres + Redis)
docker compose up -d postgres redis

# 3. Конфигурация для локальной разработки
cp .env.example .env
# Отредактируй .env: DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/workers_platform
# REDIS_URL=redis://host.docker.internal:6380

# 4. Миграции
pnpm db:migrate

# 5. Сборка
pnpm build

# 6. Запуск dev-сервера (hot reload)
pnpm --filter @platform/control-plane dev

# 7. Создать API ключ (bootstrap)
curl -s http://localhost:3000/api/api-keys -X POST \
  -H 'Content-Type: application/json' -d '{"name":"first"}' | jq -r .data.key
```

---

## Пример: деплой воркера

```bash
# 1. Создать воркер (id генерируется автоматически)
WORKER=$(curl -s http://localhost:3000/api/workers \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{}' | jq -r .data.id)

# 2. Создать ресурсы
curl -s http://localhost:3000/api/d1 -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"worker_id\":\"$WORKER\",\"name\":\"lms_db\",\"schema_sql\":\"CREATE TABLE courses (id INTEGER PRIMARY KEY, name TEXT)\"}"
curl -s http://localhost:3000/api/kv -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d "{\"worker_id\":\"$WORKER\",\"name\":\"cache\"}"

# 3. Секрет
curl -s "http://localhost:3000/api/secrets?worker_id=$WORKER" -X PUT \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"LMS_TOKEN":"secret-value"}'

# 4. Задеплоить код
cat > /tmp/worker.js <<'EOF'
export default {
  async fetch(request, env, ctx) {
    const row = await env.LMS_DB.prepare("SELECT name FROM courses LIMIT 1").first("name");
    await env.CACHE.put("last-name", row ?? "none");
    const token = env.SECRETS.get("LMS_TOKEN");
    return Response.json({ course: row, tokenPresent: Boolean(token) });
  },
};
EOF

curl -s "http://localhost:3000/api/workers/$WORKER/versions" -X POST \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"code\":$(jq -Rs . /tmp/worker.js),\"manifest\":{\"bindings\":{\"d1_databases\":[\"lms_db\"],\"kv_namespaces\":[\"cache\"]}}}"

# 5. Вызвать
curl -s "http://localhost:3000/api/workers/$WORKER/invoke" -X POST \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"method":"GET","path":"/"}' | jq .
```

---

## API

**Workers публичны**: любой может вызвать воркер через `https://<uuid-last-6>.workers.fastclass.ru` — любой метод, путь,
query и тело форвардятся в изолят напрямую:

```bash
curl -s "https://$WORKER_LAST_6.workers.fastclass.ru?since=1" -X POST -d '{"action":"sync"}'
```

**Management API** (`/api/*` — деплой, секреты, D1, KV, логи и т.д.) — только с API-ключом:
- **Static ключ из `.env`** (`API_KEY=wpk_...`) — для сервер-сервер и CLI
- **DB-ключи** через `POST /api/api-keys` (показывается один раз)

Auth: `Authorization: Bearer wpk_...` для всех `/api/*`. Открытые без auth:
`<uuid-last-6>.workers.fastclass.ru`, `/health`, `/ready`, `/metrics`, `/version`.

| Метод | Путь | Описание |
|-------|------|----------|
| ANY | `https://<uuid-last-6>.workers.fastclass.ru/*` | **Публичный ingress к воркеру по последним 6 символам UUID** (без auth; путь/query/body форвардятся) |
| POST | `/api/workers` | Создать воркер (лимиты; UUID генерируется автоматически) — auth |
| GET | `/api/workers` | Список (limit/offset) |
| GET/PATCH/DELETE | `/api/workers/:id` | Детали / обновить / удалить |
| POST | `/api/workers/:id/versions` | **Деплой**: JSON `{code, manifest}` или multipart `code`+`manifest` |
| GET | `/api/workers/:id/versions` | История версий |
| POST | `/api/workers/:id/versions/:vid/promote` | Сделать production (hot reload) |
| POST | `/api/workers/:id/rollback` | Откат на предыдущую версию |
| POST | `/api/workers/:id/invoke` | Синхронный вызов: `{method, path, body}` |
| GET | `/api/workers/:id/usage?from&to` | Аналитика: requests, cpu, d1 rows, kv ops |
| GET | `/api/workers/:id/logs` | SSE стрим логов |
| POST | `/api/d1` | Создать D1 БД (+ schema_sql) |
| POST | `/api/d1/:workerId/:name/query` | Выполнить SQL |
| POST | `/api/d1/:workerId/:name/migrate` | Применить миграции |
| POST | `/api/kv` | Создать KV namespace |
| POST | `/api/kv/:workerId/:ns/bulk` | Bulk put/delete (до 10k) |
| GET | `/api/kv/:workerId/:ns/keys` | Листинг ключей (prefix/cursor) |
| POST | `/api/queues` | Создать очередь |
| POST | `/api/queues/:workerId/:q/messages` | Push сообщение |
| GET | `/api/queues/:workerId/:q/metrics` | Глубина + DLQ |
| PUT | `/api/secrets?worker_id=` | Upsert секретов (шифруются) |
| GET | `/api/secrets?worker_id=` | Список имён (значения не возвращаются) |
| POST | `/api/api-keys` | Создать API ключ (показывается один раз) |
| GET | `/metrics` | Prometheus-метрики |
| GET | `/health`, `/ready` | Liveness / readiness |

---

## Blue/Green Deploy (zero downtime)

```bash
# Статус
./deploy/production.sh status

# Деплой (бэкап в S3 -> build -> новый слот -> health -> nginx switch -> stop old)
./deploy/production.sh

# Откат
./deploy/production.sh rollback
```

### Как работает zero downtime deploy:

1. **Бэкап в S3** в начале деплоя (pg_dump каталога + tar D1-данных). Если бэкап не удался — деплой прерывается (`SKIP_BACKUP=1` для отключения).
2. **Build** нового Docker образа.
3. **Новый контейнер** стартует на свободном слоте (blue на 3100, green на 3200) в Docker сети `workers-network`. Nginx продолжает слать трафик в активный слот.
3. **Health check** — ждёт `/ready` (до 120с). Важно: сервер слушает порт только **после** warm-up (восстановление воркеров из каталога). Health check не прошёл → новый слот удаляется, старый не тронут.
4. **Nginx switch** — рендер шаблона с `__DOMAIN__`/`__ACTIVE_CONTAINER__` → `nginx -t` → reload (без обрыва соединений).
5. Только после переключения останавливается старый слот (SIGTERM → graceful shutdown 30s).

### Переменные окружения для деплоя (в `.env`):

| Переменная | Описание | Пример |
|------------|----------|--------|
| `SECRETS_MASTER_KEY` | 32-байтный base64 ключ для шифрования секретов | `openssl rand -base64 32` |
| `API_KEY` | Static ключ для management API | `wpk_` + `openssl rand -hex 16` |
| `SITE_URL` | Канонический URL; hostname становится `DOMAIN` и базой wildcard | `https://workers.fastclass.ru` |
| `DOMAIN` | Публичный домен (fallback, если `SITE_URL` не задан) | `workers.fastclass.ru` |
| `S3_BACKUP_BUCKET` | S3 бакет для бэкапов | `my-backups` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS credentials для S3 бэкапов | |
| `S3_ENDPOINT` | Для S3-совместимых (MinIO, Selectel, Yandex) | `https://s3.example.com` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Postgres credentials | `postgres` / `postgres` / `workers_platform` |
| `POSTGRES_HOST_PORT` | Порт Postgres на хосте | `5432` |
| `REDIS_HOST_PORT` | Порт Redis на хосте | `6380` |
| `APP_HOST_PORT` | Порт приложения на хосте | `3000` |
| `NGINX_HTTP_PORT` / `NGINX_HTTPS_PORT` | Nginx порты | `8080` / `8443` |
| `EGRESS_ALLOWED_DOMAINS` | Куда воркеры могут ходить (fetch) | `api.moodle.org,*.instructure.com` |

**TLS:** сертификат (`TLS_CERT_FILE`/`TLS_KEY_FILE`) должен быть предоставлен заранее. При его отсутствии deploy прервётся с ошибкой.

### Команды деплоя

```bash
./deploy/production.sh          # полный деплой (дефолт)
./deploy/production.sh status   # статус слотов, контейнеров, health
./deploy/production.sh rollback # откат на предыдущую версию

# Переменные окружения для deploy скрипта:
SKIP_BACKUP=1 ./deploy/production.sh          # пропустить S3 бэкап
NGINX_MANAGED_EXTERNALLY=1 ./deploy/production.sh  # не трогать nginx
```

---

## Разработка (Local Dev)

```bash
# 1. Зависимости
pnpm install

# 2. Инфраструктура для разработки (Postgres + Redis)
docker compose up -d postgres redis

# 3. Конфигурация для локальной разработки
cp .env.example .env
# Отредактируй .env:
# DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/workers_platform
# REDIS_URL=redis://host.docker.internal:6380

# 4. Миграции
pnpm db:migrate

# 5. Сборка
pnpm build

# 6. Запуск dev-сервера (hot reload)
pnpm --filter @platform/control-plane dev

# 7. Создать API ключ (bootstrap)
curl -s http://localhost:3000/api/api-keys -X POST \
  -H 'Content-Type: application/json' -d '{"name":"first"}' | jq -r .data.key
```

---

## CLI

```bash
cd apps/cli && pnpm build && pnpm link --global

workers config:set http://localhost:3000 wpk_...
workers worker create my-connector
workers worker deploy <id> ./worker.js
workers worker invoke <id> / -X POST -b '{"hello":"world"}'
workers d1 create <id> lms_db --schema schema.sql
workers d1 query <id> lms_db "SELECT * FROM courses"
workers secret put <id> LMS_TOKEN value
workers queue create <id> jobs && workers queue push <id> jobs '{"a":1}'
```

---

## Production

- Dockerfile (multi-stage, non-root, tini, healthcheck) — `docker build -t workers-platform .`
- Prometheus: `infra/prometheus.yml`, Grafana с autoprovisioned datasource на :3001
- Graceful shutdown: SIGTERM → стоп соединений → drain изолятов (30s) → exit
- Readiness: `/ready` проверяет PostgreSQL и Redis

## Известные ограничения (MVP)

- Логи изолятов: SSE-эндпоинт отдаёт heartbeat; захват `console.log` из воркеров
  планируется (сейчас метрики запросов и ошибки доступны через `/metrics`)
- Egress allowlist задается глобально (env); per-worker allowlist — на этапе 2
- Durable Objects, service bindings (воркер→воркер), R2 — не входят в MVP
- Rate limiter in-memory (per-process); для кластера подключите Redis-бэкенд
