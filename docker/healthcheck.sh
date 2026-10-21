#!/bin/sh
# Container health check for both processes of the image (see docker/entrypoint.sh):
#   worker  healthy while its node process runs (it has no HTTP port)
#   web     healthy when GET /api/health answers 2xx
# The worker is found by its command line, which works with or without an init process as PID 1.
# The web server can't be found that way (Next.js renames its process to "next-server"), so any
# container without a running worker gets the HTTP check; a worker container whose worker died
# fails it too.
set -u

worker_running() {
  for cmdline in /proc/[0-9]*/cmdline; do
    # `case` instead of grep: a grep process would carry the pattern in its own command line.
    case "$(tr '\0' ' ' < "$cmdline" 2>/dev/null)" in
      *apps/worker/dist/index.js*) return 0 ;;
    esac
  done
  return 1
}

if worker_running; then
  exit 0
fi
exec node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
