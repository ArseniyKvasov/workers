#!/usr/bin/env bash
#
# Workers Platform — production deploy with blue/green slots.
#
#   ./deploy/production.sh deploy    (default) backup -> build -> start new slot
#                                    -> health check -> switch nginx -> stop old slot
#   ./deploy/production.sh status    show slots, containers, health, last backup
#   ./deploy/production.sh rollback  redeploy previous image via the same flow
#
# Zero downtime: nginx keeps serving the active slot until the new container
# passes /health + /ready (which also guarantees worker warm-up completed).
# The old slot is removed only after the switch.
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env.production}"
STATE_FILE="${SCRIPT_DIR}/.active-slot"
PREV_IMAGE_FILE="${SCRIPT_DIR}/.previous-image"

BLUE_CONTAINER="workers-app-blue"
GREEN_CONTAINER="workers-app-green"
MAIN_CONTAINER="workers-app"
NGINX_CONTAINER="workers-nginx"
NETWORK="workers-network"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [deploy|status|rollback]

Environment:
  ENV_FILE                    env file to load (default: deploy/.env.production)
  SKIP_BACKUP=1               skip S3 backup (dangerous; deploy refuses by default)
  NGINX_MANAGED_EXTERNALLY=1  do not touch nginx, only print the switch command
  HEALTH_TIMEOUT              seconds to wait for the new slot (default: 120)
EOF
}

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die "env file not found: $ENV_FILE (copy deploy/.env.production.example)"
  fi
  # Export KEY=VALUE lines via temp file (process substitution is flaky in some shells)
  local tmp_env
  tmp_env="$(mktemp)"
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" > "$tmp_env"
  set -a
  # shellcheck disable=SC1090
  source "$tmp_env"
  set +a
  rm -f "$tmp_env"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    die "missing required env var: $name (set it in $ENV_FILE)"
  fi
}

# ---------------------------------------------------------------------------
# Slot helpers
# ---------------------------------------------------------------------------
container_for_slot() { case "$1" in blue) echo "workers-app-blue" ;; green) echo "workers-app-green" ;; esac; }
port_for_slot()      { case "$1" in blue) echo "3100" ;; green) echo "3200" ;; esac; }

slot_is_healthy() {
  local container="$1"
  docker exec "$container" node -e "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

active_slot() {
  local from_state="${1:-}"
  if [[ -f "$STATE_FILE" && -z "$from_state" ]]; then
    from_state="$(cat "$STATE_FILE")"
  fi
  case "$from_state" in
    blue|green) echo "$from_state"; return 0 ;;
  esac
  local blue_healthy green_healthy
  blue_healthy=$(docker exec workers-app-blue node -e "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && echo true || echo false)
  green_healthy=$(docker exec workers-app-green node -e "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && echo true || echo false)
  if [[ "$blue_healthy" == "true" && "$green_healthy" == "false" ]]; then echo blue
  elif [[ "$green_healthy" == "true" && "$blue_healthy" == "false" ]]; then echo green
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Backups (S3) — deploy refuses to continue if the backup fails
# ---------------------------------------------------------------------------
timestamp() { date -u +"%Y%m%dT%H%M%SZ"; }

run_pg_dump() {
  docker exec workers-postgres pg_dump --no-owner --no-privileges -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-workers_platform}"
}

do_backup() {
  local stamp backup_prefix pg_ok=0 data_ok=0
  stamp="$(timestamp)"
  backup_prefix="s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX}/${stamp}"

  if [[ "${SKIP_BACKUP:-0}" == "1" ]]; then
    warn "SKIP_BACKUP=1 — skipping S3 backup (deploy continues WITHOUT a safety net)"
    return 0
  fi
  command -v aws > /dev/null 2>&1 || die "aws CLI not found; install it or set SKIP_BACKUP=1"
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
    || die "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set"

  log "backup: postgres -> ${backup_prefix}/postgres.sql.gz"
  if run_pg_dump | gzip | aws s3 cp - "${backup_prefix}/postgres.sql.gz" \
      ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"}; then
    pg_ok=1
  else
    warn "postgres backup FAILED"
  fi

  log "backup: data dir -> ${backup_prefix}/data.tgz"
  if docker run --rm -v workers-data:/data -v "$(pwd):/backup" alpine \
      tar -czf - -C /data . | aws s3 cp - "${backup_prefix}/data.tgz" \
        ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"}; then
    data_ok=1
  else
    warn "data dir backup FAILED"
  fi

  if [[ "$pg_ok" != "1" || "$data_ok" != "1" ]]; then
    die "backup incomplete (pg=$pg_ok data=$data_ok) — refusing to deploy. Fix S3/credentials or set SKIP_BACKUP=1 explicitly."
  fi

  apply_backup_retention
}

apply_backup_retention() {
  local keep="${BACKUP_RETENTION:-14}"
  [[ "$keep" =~ ^[0-9]+$ ]] || keep=14
  local ep=(); [[ -n "${S3_ENDPOINT:-}" ]] && ep=(--endpoint-url "$S3_ENDPOINT")

  # Delete the oldest backups beyond the retention window
  aws s3 ls "s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX}/" "${ep[@]}" 2>/dev/null \
    | awk '{print $NF}' | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r \
    | tail -n +$((keep + 1)) \
    | while read -r old; do
        aws s3 rm --recursive "s3://${S3_BACKUP_BUCKET}/${S3_BACKUP_PREFIX}/${old}" "${ep[@]}" > /dev/null 2>&1 || true
        log "backup retention: removed $old"
      done
}

# ---------------------------------------------------------------------------
# Nginx
# ---------------------------------------------------------------------------
switch_nginx() {
  local target_slot="$1" template rendered active_container
  template="${SCRIPT_DIR}/nginx.conf.template"
  rendered="${SCRIPT_DIR}/nginx.conf.rendered"
  [[ -f "$template" ]] || die "nginx template not found: $template"

  active_container="workers-app-${target_slot}"
  sed -e "s/__DOMAIN__/${DOMAIN}/g" -e "s/__ACTIVE_CONTAINER__/${active_container}/g" "$template" > "$rendered"

  if [[ "${NGINX_MANAGED_EXTERNALLY:-0}" == "1" ]]; then
    warn "NGINX_MANAGED_EXTERNALLY=1 — apply manually:"
    warn "  install $rendered to /etc/nginx/sites-available/workers-platform.conf and reload nginx"
    return 0
  fi

  docker cp "$rendered" workers-nginx:/etc/nginx/templates/default.conf.template
  docker exec workers-nginx nginx -t || die "nginx config test failed — keeping old config"
  docker exec workers-nginx nginx -s reload || die "nginx reload failed"
  log "nginx: traffic switched to port ${active_port} (${DOMAIN})"
}

# ---------------------------------------------------------------------------
# Docker slot management
# ---------------------------------------------------------------------------
build_image() {
  local tag="${IMAGE_NAME:-workers-platform}"
  local version
  version="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo latest)"
  tag="${tag}:${version}"
  log "building image ${tag}"
  docker build -t "$tag" "$ROOT_DIR" > /dev/null
  echo "$tag"
}

start_slot() {
  local slot="$1" image="$2" container port
  container="workers-app-${slot}"
  port=$([[ "$slot" == "blue" ]] && echo 3100 || echo 3200)

  docker rm -f "$container" > /dev/null 2>&1 || true
  log "starting ${container} (image ${image}, port ${port})"

  docker run -d --name "$container" \
    --network workers-network \
    --restart unless-stopped \
    -e PORT=3000 \
    -e NODE_ENV=production \
    -e DATABASE_URL="postgresql://${POSTGRES_USER:-postgres}:${POSTGRES_PASSWORD:-postgres}@postgres:5432/${POSTGRES_DB:-workers_platform}" \
    -e REDIS_URL=redis://redis:6379 \
    -e SECRETS_MASTER_KEY="${SECRETS_MASTER_KEY}" \
    -e API_KEY="${API_KEY}" \
    -e DOMAIN="${DOMAIN}" \
    -e BLUE_PORT=3100 \
    -e GREEN_PORT=3200 \
    -e DATA_DIR=/data \
    -e EGRESS_ALLOWED_DOMAINS="${EGRESS_ALLOWED_DOMAINS}" \
    -e LOG_LEVEL="${LOG_LEVEL:-info}" \
    -e RUNTIME_LOG_LEVEL="${RUNTIME_LOG_LEVEL:-warn}" \
    -e SERVICE_NAME=workers-platform \
    -v workers-data:/data \
    --memory "${CONTAINER_MEMORY:-2g}" \
    --cpus "${CONTAINER_CPUS:-2}" \
    "$image" > /dev/null
}

stop_slot() {
  local slot="$1" container
  container="workers-app-${slot}"
  if docker ps --format '{{.Names}}' | grep -qx "$container"; then
    log "stopping ${container} (${2:-old slot})"
    docker stop -t 35 "$container" > /dev/null
  fi
  docker rm -f "$container" > /dev/null 2>&1 || true
}

wait_healthy() {
  local slot="$1" timeout="${HEALTH_TIMEOUT:-120}" waited=0
  local container="workers-app-${slot}"

  while (( waited < timeout )); do
    if docker exec "$container" node -e "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      log "slot ${slot} is healthy (after ${waited}s, warm-up complete)"
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  warn "last /ready response from ${container}:"
  docker exec "$container" node -e "fetch('http://localhost:3000/ready').then(r=>console.log(r.status, r.ok)).catch(e=>console.error(e))" 2>&1 | head -c 500 || true
  echo
  return 1
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd_deploy() {
  local incoming_image="${1:-}"

  require_env DOMAIN; require_env BLUE_PORT; require_env GREEN_PORT
  require_env POSTGRES_USER; require_env POSTGRES_PASSWORD; require_env POSTGRES_DB
  require_env SECRETS_MASTER_KEY; require_env API_KEY; require_env DOMAIN

  local active target
  if ! active="$(active_slot)"; then
    warn "cannot determine active slot (no state file, no healthy slot) — assuming first deploy"
    active=""
  fi

  if [[ -n "$active" ]]; then
    target="$( [[ "$active" == "blue" ]] && echo green || echo blue )"
  else
    target="blue"
  fi

  log "active slot: ${active:-none}, deploying into: $target"
  do_backup

  local image
  if [[ -n "$incoming_image" ]]; then
    image="$incoming_image"
  else
    image="$(build_image)"
  fi

  start_slot "$target" "$image"

  if ! wait_healthy "$target"; then
    err "new slot ${target} failed health checks — rolling back to old slot"
    stop_slot "$target" "(failed slot)"
    die "deploy aborted; ${active:-none} slot untouched"
  fi

  switch_nginx "$target"

  # Verify through nginx
  if [[ "${NGINX_MANAGED_EXTERNALLY:-0}" != "1" ]]; then
    if curl -fsS -m 10 "http://localhost/health" > /dev/null 2>&1; then
      log "public health probe OK"
    else
      warn "public health probe failed — old slot kept, check nginx"
      die "deploy incomplete: new slot healthy directly, but probe via nginx failed"
    fi
  fi

  if [[ -n "$active" ]]; then
    docker inspect --format '{{.Config.Image}}' "workers-app-${active}" > "${PREV_IMAGE_FILE}" 2>/dev/null || true
    stop_slot "$active"
  fi

  echo "$target" > "${STATE_FILE}"
  log "deploy complete: slot=${target} image=${image}"
  log "workers were warmed up from the catalog before the traffic switch (zero downtime)"
}

cmd_rollback() {
  require_env DOMAIN; require_env BLUE_PORT; require_env GREEN_PORT

  [[ -f "$PREV_IMAGE_FILE" ]] || die "no previous image recorded — nothing to roll back to"
  local previous_image
  previous_image="$(cat "$PREV_IMAGE_FILE")"

  local active target
  active="$(active_slot)" || die "cannot determine active slot"
  target="$( [[ "$active" == "blue" ]] && echo green || echo blue )"

  log "rollback: redeploying ${previous_image} into slot ${target}"
  cmd_deploy "$previous_image"
}

cmd_status() {
  echo "== slots =="
  for slot in blue green; do
    local container="workers-app-${slot}"
    local running health
    running=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container" && echo yes || echo no)
    if docker exec "$container" node -e "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      health=healthy
    else
      health=unhealthy
    fi
    printf '  %-5s container=%-20s running=%-3s health=%s\n' "$slot" "$container" "$running" "$health"
  done
  if [[ -f "$STATE_FILE" ]]; then
    echo "active slot: $(cat "$STATE_FILE")"
  else
    echo "active slot: unknown (no state file)"
  fi
  [[ -f "$PREV_IMAGE_FILE" ]] && echo "previous image: $(cat "$PREV_IMAGE_FILE")"
  echo "domain: ${DOMAIN:-?}"
}

# ---------------------------------------------------------------------------
main() {
  local cmd="${1:-deploy}"
  case "$cmd" in
    deploy)   shift; load_env; cmd_deploy "${1:-}" ;;
    rollback) load_env; cmd_rollback ;;
    status)   load_env; cmd_status ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage; die "unknown command: $cmd" ;;
  esac
}

main "$@"