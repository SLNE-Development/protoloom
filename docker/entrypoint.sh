#!/bin/sh
# Container entrypoint: optionally migrates the database, then execs the requested process.
#
#   entrypoint.sh web      Next.js server (default); runs migrations first
#   entrypoint.sh worker   BullMQ worker; does NOT migrate (the web container owns migrations)
#   entrypoint.sh <cmd..>  any other command is exec'd as is
#
# RUN_MIGRATIONS=true|false overrides the per-command default.
set -eu

cmd="${1:-web}"
[ "$#" -gt 0 ] && shift

case "$cmd" in
  web) run_migrations="${RUN_MIGRATIONS:-true}" ;;
  *)   run_migrations="${RUN_MIGRATIONS:-false}" ;;
esac

if [ "$run_migrations" = "true" ]; then
  echo "entrypoint: running database migrations"
  node /app/migrate/run.mjs
fi

case "$cmd" in
  web)    exec node apps/web/server.js "$@" ;;
  worker) exec node apps/worker/dist/index.js "$@" ;;
  *)      exec "$cmd" "$@" ;;
esac
