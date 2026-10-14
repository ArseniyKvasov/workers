#!/usr/bin/env bash
#
# Workers Platform — production deploy with blue/green slots (zero downtime).
#
#   ./deploy/production.sh [deploy] [IMAGE]   preflight -> backup -> build ->
#                                             migrate -> start new slot ->
#                                             health check -> update nginx site
#                                             conf -> graceful reload ->
#                                             public probe -> stop old slot
#   ./deploy/production.sh preflight          checks only (safe, read-only-ish)
#   ./deploy/production.sh status             show slots, health, nginx target
#   ./deploy/production.sh rollback           redeploy previous image, same flow
#
# How zero downtime is achieved:
#   1. The currently serving slot keeps handling traffic the whole time.
#   2. The new slot is started alongside it and must pass /ready
#      (postgres+redis reachable AND worker warm-up from catalog finished)
#      before it receives any traffic.
#   3. Only the nginx *site* config is replaced (atomically) and nginx is
#      asked for a graceful `reload` — existing connections are NOT dropped.
#   4. The old slot is stopped (SIGTERM, 35s drain) only after the new slot
#      answers health probes through nginx.
#
# What this script deliberately does NOT do ("does not manage all of nginx"):
#   - it never touches /etc/nginx/nginx.conf or any other site;
#   - it never installs/enables/disables sites, never runs certbot;
#   - it never starts, stops or *restarts* nginx (restart drops connections).
#   It only rewrites ONE file ($NGINX_CONFIG_PATH) and runs ONE graceful
#   reload command (overridable via $NGINX_RELOAD_CMD, skippable via
#   NGINX_MANAGED_EXTERNALLY=1 or --no-reload).
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
STATE_FILE="${SCRIPT_DIR}/.active-slot"
PREV_IMAGE_FILE="${SCRIPT_DIR}/.previous-image"
RENDERED_FILE="${SCRIPT_DIR}/nginx.conf.rendered"

BLUE_CONTAINER="workers-app-blue"
GREEN_CONTAINER="workers-app-green"
NETWORK="workers-network"  # default; resolve_network() refines it at runtime
INTERNAL_PORT="3000"   # port the app listens on INSIDE every slot container
NO_RELOAD=0

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [deploy [IMAGE] | preflight | status | rollback] [--no-reload]

Commands:
  deploy [IMAGE]  full zero-downtime deploy (default). Uses IMAGE if given,
                  otherwise builds from git HEAD.
  preflight       run pre-deploy checks only, deploy nothing.
  status          show slots, health, nginx target, last backup.
  rollback        redeploy the previously serving image via the same flow.

Options:
  --no-reload     render + install nginx site conf but skip the reload
                  (traffic stays on the old slot until you reload manually).

Environment:
  ENV_FILE                    env file to load (default: .env in project root)
  SKIP_BACKUP=1               skip S3 backup (deploy refuses by default)
  SKIP_MIGRATE=1              skip DB migrations (default: run from new image)
  NGINX_MANAGED_EXTERNALLY=1  only render the site conf, print manual steps,
                              do not install / test / reload anything
  NGINX_CONFIG_PATH           nginx *site* conf to update
                              (default: /etc/nginx/sites-available/workers-platform.conf)
  NGINX_RELOAD_CMD            graceful reload command
                              (default: sudo nginx -s reload)
  NGINX_TEST_CMD              config test command (default: sudo nginx -t)
  TLS_CERT_FILE / TLS_KEY_FILE  TLS cert paths (default: letsencrypt live dir
                              for $DOMAIN; 443 block added only if both exist)
  PUBLIC_HEALTH_URL           probe through nginx after switch
                              (default: http://127.0.0.1/health)
  HEALTH_TIMEOUT              seconds to wait for the new slot (default: 180)
  BACKUP_RETENTION            how many recent backups to keep (default: 14)
  DOCKER_NETWORK              docker network for slots (default: auto-detected
                              from the postgres container)
EOF
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die "env file not found: $ENV_FILE (copy .env.example to .env and configure)"
  fi
  local tmp_env
  tmp_env="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$tmp_env'" RETURN
  # Strip comments/exports/blank lines; keep only plain KEY=... assignments.
  sed -e 's/^[[:space:]]*export[[:space:]]\+//' -e 's/[[:space:]]*#[^"'\'']*$//' \
    "$ENV_FILE" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "$tmp_env" || true
  set -a
  # shellcheck disable=SC1090
  source "$tmp_env"
  set +a
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    die "missing required env var: $name (set it in $ENV_FILE)"
  fi
}

blue_port()  { echo "${BLUE_PORT:-3100}"; }
green_port() { echo "${GREEN_PORT:-3200}"; }

# Percent-encode a string for use in a URL userinfo part (passwords with
# @ / : ? # % break raw interpolation into DATABASE_URL / REDIS_URL).
urlencode() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1] ?? ""))' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
  else
    printf '%s' "$1"
  fi
}

# DATABASE_URL with the password safely encoded (never interpolate raw).
encoded_database_url() {
  local pass_enc
  pass_enc="$(urlencode "${POSTGRES_PASSWORD:-}")"
  printf 'postgresql://%s:%s@postgres:5432/%s' \
    "${POSTGRES_USER:-postgres}" "$pass_enc" "${POSTGRES_DB:-workers_platform}"
}

# REDIS_URL with the password safely encoded. NOTE: blue/green slots used to
# start with `redis://redis:6379` (NO password) while redis requires one —
# every slot failed redis auth and /ready never passed. Never drop this again.
encoded_redis_url() {
  local pass_enc
  pass_enc="$(urlencode "${REDIS_PASSWORD:-}")"
  printf 'redis://:%s@redis:6379' "$pass_enc"
}

container_for_slot() { case "$1" in blue) echo "$BLUE_CONTAINER" ;; green) echo "$GREEN_CONTAINER" ;; *) die "unknown slot: $1" ;; esac; }
port_for_slot()      { case "$1" in blue) blue_port ;; green) green_port ;; *) die "unknown slot: $1" ;; esac; }
other_slot()         { case "$1" in blue) echo green ;; green) echo blue ;; *) die "unknown slot: $1" ;; esac; }

resolve_network() {
  # docker compose prefixes network names with the project name
  # (e.g. myproj_workers-network), so reuse the network postgres actually
  # lives on instead of assuming a hardcoded name.
  # Explicit override wins: DOCKER_NETWORK=foo ./deploy/production.sh deploy
  if [[ -n "${DOCKER_NETWORK:-}" ]]; then echo "$DOCKER_NETWORK"; return 0; fi
  local net
  net="$(docker container inspect workers-postgres \
    --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' 2>/dev/null \
    | grep -vxE 'bridge|host|none' | head -n 1 || true)"
  if [[ -n "${net:-}" ]]; then echo "$net"; else echo "$NETWORK"; fi
}

# Port the app listens on inside a running slot container (default 3000).
container_port() {
  local container="$1" p
  p="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null \
    | sed -n 's/^PORT=//p' | tail -n 1 || true)"
  [[ -n "${p:-}" ]] && echo "$p" || echo "$INTERNAL_PORT"
}

probe_ready() {
  # $1 = container name. True when /ready answers 200.
  local container="$1" port
  port="$(container_port "$container")"
  docker exec "$container" node -e \
    "fetch('http://localhost:${port}/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

active_slot() {
  # Prefer the recorded state; fall back to probing when it is missing.
  if [[ -f "$STATE_FILE" ]]; then
    local recorded
    recorded="$(tr -d '[:space:]' < "$STATE_FILE")"
    case "$recorded" in blue|green) echo "$recorded"; return 0 ;; esac
  fi
  local blue_ok=0 green_ok=0
  container_running "$BLUE_CONTAINER"  && probe_ready "$BLUE_CONTAINER"  && blue_ok=1 || true
  container_running "$GREEN_CONTAINER" && probe_ready "$GREEN_CONTAINER" && green_ok=1 || true
  if   [[ "$blue_ok" == "1" && "$green_ok" == "0" ]]; then echo blue
  elif [[ "$green_ok" == "1" && "$blue_ok" == "0" ]]; then echo green
  else return 1
  fi
}

# ---------------------------------------------------------------------------
# Preflight — fail fast before touching anything stateful
# ---------------------------------------------------------------------------
preflight() {
  local failures=0
  check() { # $1 = description, $@ = command...
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then log "preflight ok: $desc"
    else err "preflight FAIL: $desc"; failures=$((failures + 1)); fi
  }

  log "preflight: checking deploy prerequisites..."
  NETWORK="$(resolve_network)"
  log "preflight: using docker network $NETWORK"

  check "docker daemon reachable" docker info
  [[ -f "${SCRIPT_DIR}/nginx.conf.template" ]] \
    && log "preflight ok: nginx template present" \
    || { err "preflight FAIL: nginx template missing"; failures=$((failures + 1)); }
  [[ -f "${ROOT_DIR}/Dockerfile" ]] \
    && log "preflight ok: Dockerfile present" \
    || { err "preflight FAIL: Dockerfile missing"; failures=$((failures + 1)); }

  local missing=()
  for v in DOMAIN SECRETS_MASTER_KEY API_KEY POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB REDIS_PASSWORD; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  if [[ "${#missing[@]}" -eq 0 ]]; then log "preflight ok: required env vars set"
  else err "preflight FAIL: missing env vars: ${missing[*]}"; failures=$((failures + 1)); fi

  # SECRETS_MASTER_KEY must decode to exactly 32 bytes (AES-256); the app
  # refuses to boot otherwise, so catch it here before touching anything.
  if command -v node >/dev/null 2>&1; then
    if SMK="${SECRETS_MASTER_KEY:-}" node -e 'const b=Buffer.from(process.env.SMK||"","base64"); process.exit(b.length===32?0:1)'; then
      log "preflight ok: SECRETS_MASTER_KEY decodes to 32 bytes"
    else
      err "preflight FAIL: SECRETS_MASTER_KEY must be 32 bytes base64 (openssl rand -base64 32)"
      failures=$((failures + 1))
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if SMK="${SECRETS_MASTER_KEY:-}" python3 -c 'import base64,os,sys; sys.exit(0 if len(base64.b64decode(os.environ.get("SMK",""))) == 32 else 1)'; then
      log "preflight ok: SECRETS_MASTER_KEY decodes to 32 bytes"
    else
      err "preflight FAIL: SECRETS_MASTER_KEY must be 32 bytes base64 (openssl rand -base64 32)"
      failures=$((failures + 1))
    fi
  else
    warn "preflight: neither node nor python3 found — skipping SECRETS_MASTER_KEY length check"
  fi

  # BOOTSTRAP_OPEN_API disables auth on POST /api/api-keys; refuse to deploy
  # it enabled unless explicitly overridden (one-shot bootstrap recovery).
  if [[ "${BOOTSTRAP_OPEN_API:-}" == "1" && "${ALLOW_BOOTSTRAP:-0}" != "1" ]]; then
    err "preflight FAIL: BOOTSTRAP_OPEN_API=1 leaves POST /api/api-keys unauthenticated"
    failures=$((failures + 1))
  else
    log "preflight ok: bootstrap API lock is closed"
  fi

  if [[ "$(blue_port)" == "$(green_port)" ]]; then
    err "preflight FAIL: BLUE_PORT and GREEN_PORT must differ"
    failures=$((failures + 1))
  else
    log "preflight ok: slot ports blue=$(blue_port) green=$(green_port)"
  fi

  # Infra the new slot depends on must already run (deploy never starts them).
  for c in workers-postgres workers-redis; do
    if container_running "$c"; then log "preflight ok: container $c running"
    else err "preflight FAIL: container $c not running (start it: docker compose up -d postgres redis)"
      failures=$((failures + 1)); fi
  done
  docker network inspect "$NETWORK" >/dev/null 2>&1 \
    && log "preflight ok: network $NETWORK exists" \
    || { err "preflight FAIL: network $NETWORK missing (override with DOCKER_NETWORK=<name>)"; failures=$((failures + 1)); }

  # Live auth checks: can we ACTUALLY log into postgres and redis with the
  # configured credentials? This catches wrong/rotated passwords and the
  # classic "DATABASE_URL with an unencoded special char" BEFORE the deploy.
  if container_running workers-postgres; then
    if docker run --rm --network "$NETWORK" \
        -e PGPASSWORD="${POSTGRES_PASSWORD:-}" \
        postgres:16-alpine \
        psql -h postgres -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-workers_platform}" \
        -tAc "SELECT 1" 2>/dev/null | grep -q 1; then
      log "preflight ok: postgres auth works (SELECT 1)"
    else
      err "preflight FAIL: cannot authenticate to postgres as '${POSTGRES_USER:-postgres}' on db '${POSTGRES_DB:-workers_platform}'"
      err "  check POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB in $ENV_FILE"
      failures=$((failures + 1))
    fi
  fi
  if container_running workers-redis; then
    if docker exec workers-redis redis-cli -a "${REDIS_PASSWORD:-}" --no-auth-warning ping 2>/dev/null | grep -q PONG; then
      log "preflight ok: redis auth works (PING -> PONG)"
    else
      err "preflight FAIL: cannot authenticate to redis (wrong REDIS_PASSWORD?)"
      failures=$((failures + 1))
    fi
  fi

  # Slot host ports must be free (or belong to our own previous slot).
  for slot in blue green; do
    local p
    p="$(port_for_slot "$slot")"
    if (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${p} ") \
      || (command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1); then
      warn "preflight: host port $p (slot $slot) is already listening — deploy will replace the container, ensure it is ours"
    else
      log "preflight ok: host port $p (slot $slot) free"
    fi
  done

  # S3 backup prerequisites (unless explicitly skipped).
  if [[ "${SKIP_BACKUP:-0}" == "1" ]]; then
    warn "preflight: SKIP_BACKUP=1 — backup checks skipped"
  else
    command -v aws >/dev/null 2>&1 \
      && log "preflight ok: aws CLI present" \
      || { err "preflight FAIL: aws CLI not found (or set SKIP_BACKUP=1)"; failures=$((failures + 1)); }
    if [[ -z "${S3_BACKUP_BUCKET:-}" ]]; then
      err "preflight FAIL: S3_BACKUP_BUCKET not set (or set SKIP_BACKUP=1)"
      failures=$((failures + 1))
    else
      log "preflight ok: S3 backup target s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX:-workers-platform}/"
    fi
  fi

  # We must be able to install the single site conf (directly or via sudo).
  if [[ "${NGINX_MANAGED_EXTERNALLY:-0}" == "1" ]]; then
    warn "preflight: NGINX_MANAGED_EXTERNALLY=1 — nginx install/reload checks skipped"
  else
    local cfg="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/workers-platform.conf}"
    if [[ -w "$cfg" || -w "$(dirname "$cfg")" ]]; then
      log "preflight ok: nginx site conf writable ($cfg)"
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      log "preflight ok: nginx site conf installable via sudo ($cfg)"
    else
      err "preflight FAIL: cannot write $cfg and passwordless sudo unavailable"
      failures=$((failures + 1))
    fi
    # Best-effort: is our site actually loaded by nginx? A missing
    # sites-enabled symlink means nginx serves the default server (404)
    # even though the deploy flow itself succeeds up to the public probe.
    local effective
    effective="$(nginx -T 2>/dev/null || sudo nginx -T 2>/dev/null || true)"
    if [[ -z "${effective:-}" ]]; then
      warn "preflight: cannot dump effective nginx config (nginx -T failed) — skipping site check"
    elif ! grep -q "workers_platform_app" <<<"$effective"; then
      err "preflight FAIL: nginx does not load our site (no workers_platform_app upstream) — symlink it:"
      err "  ln -s $cfg /etc/nginx/sites-enabled/workers-platform.conf && nginx -t && nginx -s reload"
      failures=$((failures + 1))
    else
      log "preflight ok: nginx loads our site conf"
    fi
  fi

  # Free disk (images + pg dump need room).
  local free_kb
  free_kb="$(df -k "$ROOT_DIR" | awk 'NR==2 {print $4}')"
  if [[ "${free_kb:-0}" -ge 2097152 ]]; then
    log "preflight ok: disk free $((free_kb / 1024)) MB"
  else
    err "preflight FAIL: less than 2 GB free on $(df "$ROOT_DIR" | awk 'NR==2 {print $1}') (${free_kb:-?} KB)"
    failures=$((failures + 1))
  fi

  if [[ "$failures" -gt 0 ]]; then
    die "preflight failed with $failures problem(s) — fix them and re-run"
  fi
  log "preflight: all checks passed"
}

# ---------------------------------------------------------------------------
# Backups (S3) — deploy refuses to continue if the backup fails
# ---------------------------------------------------------------------------
timestamp() { date -u +"%Y%m%dT%H%M%SZ"; }

s3_args() {
  # Print endpoint args for aws cli when S3_ENDPOINT is set (S3-compatible storage).
  if [[ -n "${S3_ENDPOINT:-}" ]]; then printf '%s' "--endpoint-url $S3_ENDPOINT"; fi
}

check_s3_auth() {
  # Static keys win when set; otherwise require a working IAM role/instance profile.
  if [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
    return 0
  fi
  # shellcheck disable=SC2046
  if aws sts get-caller-identity $(s3_args) >/dev/null 2>&1; then
    log "backup: using ambient AWS credentials (IAM role / instance profile)"
    return 0
  fi
  die "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set and no IAM role credentials found"
}

run_pg_dump() {
  docker exec workers-postgres pg_dump --no-owner --no-privileges \
    -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-workers_platform}"
}

do_backup() {
  if [[ "${SKIP_BACKUP:-0}" == "1" ]]; then
    warn "SKIP_BACKUP=1 — deploying WITHOUT a backup safety net"
    return 0
  fi
  command -v aws >/dev/null 2>&1 || die "aws CLI not found; install it or set SKIP_BACKUP=1"
  require_env S3_BACKUP_BUCKET
  check_s3_auth

  local stamp backup_prefix pg_ok=0 data_ok=0
  stamp="$(timestamp)"
  backup_prefix="s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX:-workers-platform}/${stamp}"

  log "backup: postgres -> ${backup_prefix}/postgres.sql.gz"
  # shellcheck disable=SC2046
  if run_pg_dump | gzip | aws s3 cp - "${backup_prefix}/postgres.sql.gz" $(s3_args); then
    pg_ok=1
  else
    warn "postgres backup FAILED"
  fi

  log "backup: data dir -> ${backup_prefix}/data.tgz"
  # shellcheck disable=SC2046
  if docker run --rm -v workers-data:/data:ro alpine \
      tar -czf - -C /data . 2>/dev/null | aws s3 cp - "${backup_prefix}/data.tgz" $(s3_args); then
    data_ok=1
  else
    warn "data dir backup FAILED"
  fi

  if [[ "$pg_ok" != "1" || "$data_ok" != "1" ]]; then
    die "backup incomplete (pg=$pg_ok data=$data_ok) — refusing to deploy. Fix S3/credentials or set SKIP_BACKUP=1 explicitly."
  fi
  log "backup complete: $backup_prefix"

  apply_backup_retention
}

apply_backup_retention() {
  local keep="${BACKUP_RETENTION:-14}"
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=14
  local base="s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX:-workers-platform}/"
  local listed old
  # shellcheck disable=SC2046
  listed="$(aws s3 ls "$base" $(s3_args) 2>/dev/null | awk '{print $NF}' \
    | sed 's:/$::' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r || true)"
  [[ -z "$listed" ]] && return 0
  echo "$listed" | tail -n +"$((keep + 1))" | while read -r old; do
    [[ -z "$old" ]] && continue
    # shellcheck disable=SC2046
    if aws s3 rm --recursive "${base}${old}/" $(s3_args) >/dev/null 2>&1; then
      log "backup retention: removed $old (keeping last $keep)"
    fi
  done
}

# ---------------------------------------------------------------------------
# Nginx site conf — scoped update only; never manages the whole nginx
# ---------------------------------------------------------------------------
render_nginx_conf() {
  local target_slot="$1" template active_port
  template="${SCRIPT_DIR}/nginx.conf.template"
  [[ -f "$template" ]] || die "nginx template not found: $template"
  active_port="$(port_for_slot "$target_slot")"

  # Escape sed-special chars in DOMAIN (&, \, |).
  local domain_escaped
  domain_escaped="$(printf '%s' "$DOMAIN" | sed -e 's/[\\/&|]/\\&/g')"

  sed -e "s|__DOMAIN__|${domain_escaped}|g" \
      -e "s|__ACTIVE_PORT__|${active_port}|g" \
      "$template" > "$RENDERED_FILE"

  if grep -vE '^[[:space:]]*#' "$RENDERED_FILE" | grep -Eq '__[A-Z_]+__'; then
    err "unreplaced placeholders left in rendered nginx conf:"
    grep -Eo '__[A-Z_]+__' "$RENDERED_FILE" | sort -u >&2 || true
    die "nginx template uses unknown placeholders (expected __DOMAIN__, __ACTIVE_PORT__)"
  fi

  # TLS: append the 443 block only when the cert already exists, so deploys
  # neither reference missing files nor wipe a working TLS setup.
  # (certbot --nginx would be wiped on the next deploy — use certonly --webroot.)
  local cert="${TLS_CERT_FILE:-/etc/letsencrypt/live/${DOMAIN}/fullchain.pem}"
  local key="${TLS_KEY_FILE:-/etc/letsencrypt/live/${DOMAIN}/privkey.pem}"
  if [[ -f "$cert" && -f "$key" ]]; then
    local snippet="${SCRIPT_DIR}/nginx.tls-snippet.template"
    [[ -f "$snippet" ]] || die "nginx TLS snippet not found: $snippet"
    local cert_escaped key_escaped
    cert_escaped="$(printf '%s' "$cert" | sed -e 's/[\\&|]/\\&/g')"
    key_escaped="$(printf '%s' "$key" | sed -e 's/[\\&|]/\\&/g')"
    sed -e "s|__DOMAIN__|${domain_escaped}|g" \
        -e "s|__ACTIVE_PORT__|${active_port}|g" \
        -e "s|__TLS_CERT__|${cert_escaped}|g" \
        -e "s|__TLS_KEY__|${key_escaped}|g" \
        "$snippet" >> "$RENDERED_FILE"
    if grep -vE '^[[:space:]]*#' "$RENDERED_FILE" | grep -Eq '__[A-Z_]+__'; then
      die "unreplaced placeholders left in TLS snippet"
    fi
    log "nginx: TLS enabled for ${DOMAIN} (443)"
  else
    log "nginx: no cert at ${cert} — serving plain HTTP on 80"
  fi
  log "nginx: rendered site conf for slot ${target_slot} (127.0.0.1:${active_port})"
}

install_nginx_conf() {
  # Atomically replace ONLY the site conf; keep a backup to roll back the file.
  local config_path="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/workers-platform.conf}"
  local backup="${RENDERED_FILE}.prev"

  if [[ -f "$config_path" ]]; then cp "$config_path" "$backup" 2>/dev/null || true; fi

  if [[ -w "$config_path" || (! -e "$config_path" && -w "$(dirname "$config_path")") ]]; then
    local tmp_new
    tmp_new="$(mktemp "$(dirname "$config_path")/.workers-platform.XXXXXX")"
    cp "$RENDERED_FILE" "$tmp_new"
    mv "$tmp_new" "$config_path"
  elif command -v sudo >/dev/null 2>&1; then
    local tmp_new
    tmp_new="$(mktemp)"
    cp "$RENDERED_FILE" "$tmp_new"
    sudo cp "$tmp_new" "$config_path"
    rm -f "$tmp_new"
  else
    die "cannot write $config_path (no permission, no sudo)"
  fi
  log "nginx: site conf updated ($config_path)"
}

test_nginx_conf() {
  local test_cmd="${NGINX_TEST_CMD:-sudo nginx -t}"
  local output
  if output="$(bash -c "$test_cmd" 2>&1)"; then
    echo "$output" | tail -n 5 >&2 || true
    log "nginx: config test passed"
  else
    # Print exact nginx error before rollback so user knows the cause
    # (e.g. broken TLS snippet, missing cert path, syntax error).
    local error_full="${output:-(no nginx output)}"
    err "nginx config test FAILED — exact error:"
    echo "$error_full" | sed 's/^/  /' >&2 || true
    # Show which file was tested (site conf or snippet) for faster debug.
    local tls_cert_path="${TLS_CERT_FILE:-/etc/letsencrypt/live/${DOMAIN}/fullchain.pem}"
    local tls_key_path="${TLS_KEY_FILE:-/etc/letsencrypt/live/${DOMAIN}/privkey.pem}"
    if grep -q "listen 443 ssl" "$RENDERED_FILE" 2>/dev/null; then
      err "  TLS snippet (443) included; cert=${tls_cert_path}; key=${tls_key_path}; snippet file=${SCRIPT_DIR}/nginx.tls-snippet.template"
    else
      err "  TLS snippet NOT included (443 missing); check site conf syntax or upstream definition."
      err "  Rendered conf: $RENDERED_FILE"
    fi

    # Restore previous site conf so a bad render can never break nginx.
    local config_path="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/workers-platform.conf}"
    if [[ -f "${RENDERED_FILE}.prev" ]]; then
      warn "restoring previous site conf from ${RENDERED_FILE}.prev"
      if [[ -w "$config_path" ]]; then cp "${RENDERED_FILE}.prev" "$config_path"
      elif command -v sudo >/dev/null 2>&1; then sudo cp "${RENDERED_FILE}.prev" "$config_path"; fi
    fi
    die "nginx config test failed — old slot (${STATE_FILE:-unknown}) still serving, deploy aborted"
  fi
}

reload_nginx() {
  if [[ "$NO_RELOAD" == "1" ]]; then
    warn "--no-reload: site conf installed but nginx NOT reloaded; traffic still on the old slot"
    return 1
  fi
  local reload_cmd="${NGINX_RELOAD_CMD:-sudo nginx -s reload}"
  # Graceful reload only: workers finish in-flight requests, no dropped connections.
  if bash -c "$reload_cmd"; then
    log "nginx: gracefully reloaded (zero downtime, existing connections kept)"
  else
    die "nginx reload failed — new slot healthy but traffic not switched; old slot still serving"
  fi
  return 0
}

switch_nginx() {
  local target_slot="$1"
  render_nginx_conf "$target_slot"

  if [[ "${NGINX_MANAGED_EXTERNALLY:-0}" == "1" ]]; then
    warn "NGINX_MANAGED_EXTERNALLY=1 — apply manually, then stop the old slot:"
    warn "  install ${RENDERED_FILE}"
    warn "      to ${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/workers-platform.conf}"
    warn "  nginx -t && nginx -s reload   # graceful, keeps connections"
    warn "  docker stop -t 35 $(container_for_slot "$(active_slot 2>/dev/null || echo "$target_slot")")"
    return 1
  fi

  install_nginx_conf
  test_nginx_conf
  reload_nginx
}

# ---------------------------------------------------------------------------
# Docker slot management
# ---------------------------------------------------------------------------
build_image() {
  local tag="${IMAGE_NAME:-workers-platform}"
  local version build_log
  version="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo latest)"
  tag="${tag}:${version}"
  build_log="${SCRIPT_DIR}/.build.log"
  log "building image ${tag} (log: ${build_log})"
  if docker build -t "$tag" "$ROOT_DIR" >"$build_log" 2>&1; then
    log "image built: ${tag}"
  else
    err "docker build failed — last 30 lines:"
    tail -n 30 "$build_log" >&2 || true
    die "aborting deploy; old slot untouched"
  fi
  echo "$tag"
}

# Ensure the target database exists (connects to default 'postgres' DB)
ensure_database() {
  local db_name="${POSTGRES_DB:-workers_platform}"
  log "ensure_database: checking if '${db_name}' exists"
  if docker run --rm --network "$NETWORK" \
      -e PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" \
      postgres:16-alpine \
      psql -h postgres -U "${POSTGRES_USER:-postgres}" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db_name}'" 2>/dev/null | grep -q 1; then
    log "ensure_database: '${db_name}' already exists"
  else
    log "ensure_database: creating '${db_name}'"
    docker run --rm --network "$NETWORK" \
      -e PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" \
      postgres:16-alpine \
      psql -h postgres -U "${POSTGRES_USER:-postgres}" -d postgres -c "CREATE DATABASE ${db_name}" >&2
    log "ensure_database: created '${db_name}'"
  fi
}

run_migrations() {
  local image="$1"
  if [[ "${SKIP_MIGRATE:-0}" == "1" ]]; then
    warn "SKIP_MIGRATE=1 — skipping DB migrations"
    return 0
  fi
  ensure_database
  log "migrations: applying from image ${image} (backup already taken)"
  if docker run --rm --network "$NETWORK" \
      -e DATABASE_URL="$(encoded_database_url)" \
      "$image" node packages/catalog/dist/migrate-cli.js >&2; then
    log "migrations: up to date"
  else
    die "migrations failed — aborting before any traffic switch (restore from S3 backup if needed)"
  fi
}

start_slot() {
  local slot="$1" image="$2" container port
  container="$(container_for_slot "$slot")"
  port="$(port_for_slot "$slot")"

  docker rm -f "$container" >/dev/null 2>&1 || true
  log "starting ${container} (image ${image}, 127.0.0.1:${port} -> ${INTERNAL_PORT})"

  # Env must mirror docker-compose app service. In particular REDIS_URL MUST
  # carry the password (redis runs with --requirepass) and both URLs MUST use
  # percent-encoded passwords (see encoded_*_url). Discrete POSTGRES_*/REDIS_*
  # parts are passed too so the image entrypoint can rebuild the URLs itself.
  docker run -d --name "$container" \
    --network "$NETWORK" \
    --restart unless-stopped \
    -p "127.0.0.1:${port}:${INTERNAL_PORT}" \
    -e PORT="$INTERNAL_PORT" \
    -e NODE_ENV=production \
    -e DATABASE_URL="$(encoded_database_url)" \
    -e POSTGRES_USER="${POSTGRES_USER:-postgres}" \
    -e POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
    -e POSTGRES_DB="${POSTGRES_DB:-workers_platform}" \
    -e POSTGRES_HOST=postgres \
    -e POSTGRES_PORT=5432 \
    -e REDIS_URL="$(encoded_redis_url)" \
    -e REDIS_PASSWORD="${REDIS_PASSWORD:-}" \
    -e REDIS_HOST=redis \
    -e REDIS_PORT=6379 \
    -e SECRETS_MASTER_KEY="${SECRETS_MASTER_KEY}" \
    -e API_KEY="${API_KEY}" \
    -e DOMAIN="${DOMAIN}" \
    -e BLUE_PORT="$(blue_port)" \
    -e GREEN_PORT="$(green_port)" \
    -e DATA_DIR=/data \
    -e EGRESS_ALLOWED_DOMAINS="${EGRESS_ALLOWED_DOMAINS:-}" \
    -e INGRESS_RATE_LIMIT_PER_MINUTE="${INGRESS_RATE_LIMIT_PER_MINUTE:-300}" \
    -e INGRESS_RATE_LIMIT_BURST="${INGRESS_RATE_LIMIT_BURST:-50}" \
    -e API_RATE_LIMIT_PER_MINUTE="${API_RATE_LIMIT_PER_MINUTE:-600}" \
    -e API_RATE_LIMIT_BURST="${API_RATE_LIMIT_BURST:-100}" \
    -e MAX_BODY_BYTES="${MAX_BODY_BYTES:-10485760}" \
    -e TRUSTED_PROXIES="${TRUSTED_PROXIES:-}" \
    -e CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-}" \
    -e METRICS_TOKEN="${METRICS_TOKEN:-}" \
    -e EGRESS_TIMEOUT_MS="${EGRESS_TIMEOUT_MS:-120000}" \
    -e LOG_LEVEL="${LOG_LEVEL:-info}" \
    -e RUNTIME_LOG_LEVEL="${RUNTIME_LOG_LEVEL:-warn}" \
    -e SERVICE_NAME=workers-platform \
    -e HEALTH_CHECK_TIMEOUT_MS="${HEALTH_CHECK_TIMEOUT_MS:-5000}" \
    -v workers-data:/data \
    --memory "${CONTAINER_MEMORY:-2g}" \
    --cpus "${CONTAINER_CPUS:-2}" \
    "$image" >/dev/null
}

stop_slot() {
  local slot="$1" container
  container="$(container_for_slot "$slot")"
  if container_running "$container"; then
    log "stopping ${container} (${2:-old slot}, 35s graceful drain)"
    docker stop -t 35 "$container" >/dev/null
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}

wait_healthy() {
  local slot="$1" timeout="${HEALTH_TIMEOUT:-180}" waited=0
  local container
  container="$(container_for_slot "$slot")"

  while (( waited < timeout )); do
    if probe_ready "$container"; then
      log "slot ${slot} is healthy (after ${waited}s; warm-up complete)"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "slot ${slot} failed /ready within ${timeout}s; last response:"
  local port
  port="$(container_port "$container")"
  docker exec "$container" node -e \
    "fetch('http://localhost:${port}/ready').then(async r=>console.log(r.status, await r.text())).catch(e=>console.error(String(e)))" \
    2>&1 | head -c 1000 || true
  echo >&2
  docker logs --tail 30 "$container" >&2 || true
  return 1
}

probe_public() {
  local url="${PUBLIC_HEALTH_URL:-http://127.0.0.1/health}"
  if curl -fsS -m 10 -H "Host: ${DOMAIN}" "$url" >/dev/null 2>&1; then
    log "public probe OK (${url}, Host: ${DOMAIN})"
  else
    die "public probe FAILED (${url}) — new slot healthy directly but not via nginx; old slot still serving, check nginx"
  fi
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_deploy() {
  local incoming_image="${1:-}"

  preflight
  ensure_database
  do_backup

  local active="" target
  if active="$(active_slot)"; then
    target="$(other_slot "$active")"
  else
    warn "cannot determine active slot (first deploy?) — deploying into: blue"
    active=""
    target="blue"
  fi
  log "active slot: ${active:-none}, deploying into: $target"

  local image
  if [[ -n "$incoming_image" ]]; then
    docker image inspect "$incoming_image" >/dev/null 2>&1 \
      || die "image not found locally: $incoming_image (docker pull it first)"
    image="$incoming_image"
  else
    image="$(build_image)"
  fi

  run_migrations "$image"
  start_slot "$target" "$image"

  if ! wait_healthy "$target"; then
    err "new slot ${target} failed health checks — removing it, old slot untouched"
    stop_slot "$target" "(failed slot)"
    die "deploy aborted; active slot '${active:-none}' still serving"
  fi

  local switched=0
  if switch_nginx "$target"; then
    switched=1
  fi

  if [[ "$switched" == "1" ]]; then
    probe_public
    if [[ -n "$active" ]]; then
      docker inspect --format '{{.Config.Image}}' "$(container_for_slot "$active")" > "$PREV_IMAGE_FILE" 2>/dev/null || true
      stop_slot "$active" "previous slot"
    fi
    echo "$target" > "$STATE_FILE"
    docker image prune -f --filter "dangling=true" >/dev/null 2>&1 || true
    log "deploy complete: slot=${target} image=${image}"
  else
    warn "nginx switch deferred (external management / --no-reload):"
    warn "  new slot ${target} is healthy but NOT serving traffic yet;"
    warn "  old slot '${active:-none}' still serving — nothing was stopped."
  fi
}

cmd_rollback() {
  [[ -f "$PREV_IMAGE_FILE" ]] || die "no previous image recorded — nothing to roll back to"
  local previous_image
  previous_image="$(tr -d '[:space:]' < "$PREV_IMAGE_FILE")"
  [[ -n "$previous_image" ]] || die "previous image file is empty"
  docker image inspect "$previous_image" >/dev/null 2>&1 \
    || die "previous image no longer present locally: $previous_image (cannot roll back)"
  log "rollback: redeploying ${previous_image} via the standard flow"
  cmd_deploy "$previous_image"
}

cmd_status() {
  if [[ -z "${DOMAIN:-}" ]]; then warn "DOMAIN not set in $ENV_FILE"; fi
  echo "== slots =="
  for slot in blue green; do
    local container running health image
    container="$(container_for_slot "$slot")"
    running="no"; health="unknown"; image="-"
    if container_running "$container"; then
      running="yes"
      image="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || echo '?')"
      if probe_ready "$container"; then health="healthy"; else health="unhealthy"; fi
    fi
    printf '  %-5s container=%-18s port=%-5s running=%-3s health=%-9s image=%s\n' \
      "$slot" "$container" "$(port_for_slot "$slot")" "$running" "$health" "$image"
  done
  if [[ -f "$STATE_FILE" ]]; then echo "active slot: $(cat "$STATE_FILE")"
  else echo "active slot: unknown (no state file)"; fi
  [[ -f "$PREV_IMAGE_FILE" ]] && echo "previous image: $(cat "$PREV_IMAGE_FILE")"
  local cfg="${NGINX_CONFIG_PATH:-/etc/nginx/sites-available/workers-platform.conf}"
  if [[ -f "$cfg" ]]; then
    echo "nginx site conf: $cfg -> $(grep -E '^\s*server\s+127' "$cfg" 2>/dev/null | head -n 1 | tr -d ' ;' || echo '?')"
  else
    echo "nginx site conf: $cfg (not installed)"
  fi
  echo "domain: ${DOMAIN:-?}"
  if [[ "${SKIP_BACKUP:-0}" != "1" && -n "${S3_BACKUP_BUCKET:-}" ]] && command -v aws >/dev/null 2>&1; then
    echo "last backup: $(aws s3 ls "s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX:-workers-platform}/" 2>/dev/null | sort | tail -n 1 || echo '?')"
  fi
}

# ---------------------------------------------------------------------------
main() {
  local cmd="deploy"
  if [[ $# -gt 0 ]]; then
    case "$1" in
      deploy|preflight|status|rollback) cmd="$1"; shift ;;
      --no-reload) cmd="deploy" ;;
      -h|--help|help) usage; exit 0 ;;
      *) usage; die "unknown command: $1" ;;
    esac
  fi
  for arg in "$@"; do
    case "$arg" in
      --no-reload) NO_RELOAD=1 ;;
      -h|--help) usage; exit 0 ;;
      *) if [[ "$cmd" == "deploy" && -z "${DEPLOY_IMAGE:-}" ]]; then DEPLOY_IMAGE="$arg"
         else usage; die "unexpected argument: $arg"; fi ;;
    esac
  done

  case "$cmd" in
    deploy)    load_env; cmd_deploy "${DEPLOY_IMAGE:-}" ;;
    preflight) load_env; preflight ;;
    rollback)  load_env; cmd_rollback ;;
    status)    load_env; cmd_status ;;
  esac
}

main "$@"
