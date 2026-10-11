#!/usr/bin/env bash
# Runs the whole stack on the host WITHOUT Docker, for the Playwright tests in e2e/:
# a throwaway Postgres 16, the api, the worker (ticking every 2s) and the built SPA served by
# `vite preview` on :8080, proxying /api to the api like Caddy does.
#
#   scripts/e2e-local.sh up      start everything on a FRESH database, then wait until ready
#   scripts/e2e-local.sh down    stop everything and delete the database
#   scripts/e2e-local.sh status  show what is running
#
# Then: pnpm test:e2e   (the first-run spec needs a fresh database: `down` then `up` to reset)
#
# Needs Postgres 16 binaries (PG_BIN, default /usr/lib/postgresql/16/bin). Logs and state are
# in E2E_DIR (default /tmp/tracker-e2e). Ports: WEB_PORT 8080, API_PORT 3000, PG_PORT 55432.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${E2E_DIR:-/tmp/tracker-e2e}"
pg_bin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
pg_port="${PG_PORT:-55432}"
api_port="${API_PORT:-3000}"
web_port="${WEB_PORT:-8080}"
db_url="postgres://postgres@127.0.0.1:${pg_port}/tracker"

# Postgres refuses to run as root (as in some sandboxes); drop to the postgres user then.
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

stop_pid() { # name
  local f="$dir/$1.pid"
  if [ -f "$f" ]; then
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
}

down() {
  stop_pid web
  stop_pid worker
  stop_pid api
  if [ -d "$dir/pg" ]; then as_pg "$pg_bin/pg_ctl" -D "$dir/pg" -m fast stop >/dev/null 2>&1 || true; fi
  rm -rf "$dir"
}

wait_for() { # description, url
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "$2"; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for $1 ($2); see logs in $dir" >&2
  exit 1
}

up() {
  down
  mkdir -p "$dir"
  if [ "$(id -u)" = 0 ]; then chown postgres "$dir"; chmod 755 "$dir"; fi

  as_pg "$pg_bin/initdb" -D "$dir/pg" -U postgres --auth=trust >/dev/null
  as_pg "$pg_bin/pg_ctl" -D "$dir/pg" -w -l "$dir/postgres.log" \
    -o "-p $pg_port -h 127.0.0.1 -k $dir" start >/dev/null
  as_pg "$pg_bin/createdb" -h 127.0.0.1 -p "$pg_port" -U postgres tracker

  cd "$root"
  pnpm --filter @tracker/web build >"$dir/web-build.log" 2>&1

  # The api applies the migrations on start; the worker's ticks need them.
  # PUBLIC_BASE_URL lets the api's Origin check accept the browser's http://localhost:8080
  # (vite preview rewrites Host to the api's; Caddy in compose keeps it).
  DATABASE_URL="$db_url" HOST=127.0.0.1 PORT="$api_port" PUBLIC_BASE_URL="http://localhost:${web_port}" \
    nohup pnpm --filter @tracker/api exec tsx src/main.ts >"$dir/api.log" 2>&1 &
  echo $! >"$dir/api.pid"
  wait_for "the api" "http://127.0.0.1:${api_port}/api/health"

  DATABASE_URL="$db_url" TICK_INTERVAL_MS=2000 HEARTBEAT_FILE="$dir/heartbeat" \
    nohup pnpm --filter @tracker/worker exec tsx src/main.ts >"$dir/worker.log" 2>&1 &
  echo $! >"$dir/worker.pid"

  VITE_API_PROXY_TARGET="http://127.0.0.1:${api_port}" \
    nohup pnpm --filter @tracker/web exec vite preview --host 127.0.0.1 --port "$web_port" --strictPort \
    >"$dir/web.log" 2>&1 &
  echo $! >"$dir/web.pid"
  wait_for "the web app" "http://127.0.0.1:${web_port}/api/health"

  echo "Stack is up on http://localhost:${web_port} (logs in $dir). Run: pnpm test:e2e"
}

status() {
  for n in api worker web; do
    if [ -f "$dir/$n.pid" ] && kill -0 "$(cat "$dir/$n.pid")" 2>/dev/null; then echo "$n: running"; else echo "$n: stopped"; fi
  done
  as_pg "$pg_bin/pg_ctl" -D "$dir/pg" status 2>&1 | head -1 || true
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
