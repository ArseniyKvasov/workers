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
PostgreSQL   Dragonfly     libSQL files
(каталог)    (KV/Queues)   (D1 данные)
```

- **Runtime**: workerd (встроен через Miniflare 3 — официальный embed-слой, на котором
  работает сам `wrangler dev`). Изолированные V8 изоляты, горячая перезагрузка версий.
- **Шим**: перед каждым воркером инжектится платформенная прослойка, которая
  превращает service-биндинги в привычный API: `env.MY_DB.prepare()`,
  `env.CACHE.get()`, `env.JOBS.send()`, `env.SECRETS.get()`.
- **Каталог**: PostgreSQL (Drizzle ORM) — воркеры, версии, биндинги, секреты, аудит, usage.
- **Секреты**: AES-256-GCM + HKDF (per-worker ключи из мастер-ключа), никогда не в plaintext.

## Быстрый старт

```bash
# 1. Зависимости
pnpm install

# 2. Инфраструктура (PostgreSQL + Dragonfly + Prometheus + Grafana)
docker compose up -d

# 3. Конфигурация
cp .env.example .env
openssl rand -base64 32   # вставить в SECRETS_MASTER_KEY в .env

# 4. Миграции каталога
pnpm db:migrate

# 5. Запуск
pnpm --filter @platform/control-plane dev

# 6. Создать API ключ
curl -s http://localhost:3000/api/api-keys -X POST \
  -H 'Content-Type: application/json' -d '{"name":"first"}' | jq -r .data.key
```

Замечание: первый запуск API требует ключа только для `/api/*` — `/health`, `/ready`,
`/metrics` и `/version` открыты. Чтобы создать самый первый ключ, кратко разрешите
bootstrap: запустите с `BOOTSTRAP_OPEN_API=1`, создайте ключ командой выше и
перезапустите. (Альтернатива: вставить ключ напрямую в таблицу `api_keys`.)

## Пример: деплой воркера

```bash
# 1. Создать воркер
WORKER=$(curl -s http://localhost:3000/api/workers \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"name":"my-connector"}' | jq -r .data.id)

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

# 4. Задеплоить код (echo-env.js в examples/)
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

## API

Auth: `Authorization: Bearer wpk_...` для всех `/api/*`. Открытые: `/health`, `/ready`, `/metrics`, `/version`.

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/workers` | Создать воркер (имя, лимиты) |
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

## Лимиты и безопасность

- **Per-worker**: `cpu_ms` (workerd CPU limit), `memory_mb`, `concurrency` (429 при превышении)
- **Deploy**: код ≤ 5 MB, бандл esbuild in-memory
- **Egress**: allowlist доменов через `EGRESS_ALLOWED_DOMAINS` (пусто = запрет всего),
  SSRF-защита (блок localhost, private IP ranges RFC1918/CGNAT/link-local, metadata endpoints),
  DNS rebinding protection, metering egress байт
- **Секреты**: шифрование AES-256-GCM, per-worker HKDF-ключи, авто-редакция в логах,
  значения не возвращаются через API
- **Auth**: API-ключи (wpk_), sha256-хеш, timing-safe сравнение, rate limiting (token bucket)
- **Аудит**: все mutating-операции пишутся в `audit_logs` с actor/IP/UA

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

## Разработка

```bash
pnpm install
docker compose up -d postgres dragonfly
cp .env.example .env  # заполнить SECRETS_MASTER_KEY
pnpm db:migrate
pnpm build            # все пакеты
pnpm test             # bindings (D1 локально, Redis при наличии), runtime (egress)
pnpm --filter @platform/control-plane dev
```

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
