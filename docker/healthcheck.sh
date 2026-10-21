#!/bin/sh
# Container health check for both processes of the image (see docker/entrypoint.sh):
#   web     healthy when GET /api/health answers 2xx
#   worker  healthy while its node process runs (it has no HTTP port)
# The process is found by its command line, so this works with or without an init process as PID 1.
set -u

running() {
  for cmdline in /proc/[0-9]*/cmdline; do
    # `case` instead of grep: a grep process would carry the pattern in its own command line.
    case "$(tr '\0' ' ' < "$cmdline" 2>/dev/null)" in
      *"$1"*) return 0 ;;
    esac
  done
  return 1
}

if running "apps/worker/dist/index.js"; then
  exit 0
fi
if running "apps/web/server.js"; then
  exec node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
fi
exit 1
