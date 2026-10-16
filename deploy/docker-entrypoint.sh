#!/bin/sh
# Workers Platform — container entrypoint.
#
# Rebuilds DATABASE_URL / REDIS_URL from discrete POSTGRES_*/REDIS_* parts with
# proper percent-encoding of passwords, then execs the app.
#
# WHY: docker-compose.yml and deploy/production.sh historically interpolated
# ${POSTGRES_PASSWORD} / ${REDIS_PASSWORD} RAW into URLs. Any password with
# @ / : ? # % (etc.) produced an unparseable URL -> "postgres auth failed" at
# startup, or a half-working API whose auth died minutes later. Hex passwords
# happened to work, which made the bug intermittent and confusing.
#
# The entrypoint makes EVERY password safe: it always rebuilds the URLs from
# parts when POSTGRES_HOST / REDIS_HOST are set (compose + blue/green slots
# always set them; local dev without them keeps DATABASE_URL as-is).
set -eu

urlencode() {
  # percent-encode a string for use in a URL userinfo part
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] ?? ""))' "$1"
}

if [ -n "${POSTGRES_HOST:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
  _pg_user="${POSTGRES_USER:-postgres}"
  _pg_db="${POSTGRES_DB:-workers_platform}"
  _pg_port="${POSTGRES_PORT:-5432}"
  _pg_pass_enc="$(urlencode "$POSTGRES_PASSWORD")"
  export DATABASE_URL="postgresql://${_pg_user}:${_pg_pass_enc}@${POSTGRES_HOST}:${_pg_port}/${_pg_db}"
  unset _pg_user _pg_db _pg_port _pg_pass_enc
fi

if [ -n "${REDIS_HOST:-}" ] && [ -n "${REDIS_PASSWORD:-}" ]; then
  _re_port="${REDIS_PORT:-6379}"
  _re_pass_enc="$(urlencode "$REDIS_PASSWORD")"
  export REDIS_URL="redis://:${_re_pass_enc}@${REDIS_HOST}:${_re_port}"
  unset _re_port _re_pass_enc
fi

# Fail fast with a clear message (the in-app preflight repeats these checks
# with retries, but an early explicit error is easier to spot in docker logs).
#
# Strictness depends on what is being launched: the control plane itself
# REQUIRES both vars, but utility commands (migrate-cli, backup shells,
# one-off node -e) only need DATABASE_URL — requiring the master key there
# broke `./deploy/production.sh` migrations, which run without it.
_running_server=0
for _arg in "$@"; do
  case "$_arg" in
    *control-plane/dist/main.js) _running_server=1; break ;;
  esac
done
unset _arg

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL is not set and could not be built from POSTGRES_* parts" >&2
  exit 1
fi
if [ -z "${SECRETS_MASTER_KEY:-}" ]; then
  if [ "$_running_server" -eq 1 ]; then
    echo "[entrypoint] FATAL: SECRETS_MASTER_KEY is not set" >&2
    exit 1
  else
    echo "[entrypoint] WARN: SECRETS_MASTER_KEY is not set (not required for utility command: $1)" >&2
  fi
fi
if [ "$_running_server" -eq 1 ] && [ -z "${API_KEY:-}" ]; then
  echo "[entrypoint] WARN: API_KEY is not set — every /api/* request will 401" >&2
fi

exec "$@"
