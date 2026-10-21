#!/usr/bin/env bash
# End-to-end smoke test: boots docker-compose.prod.yml, seeds an admin + `releases` repo + API key,
# publishes a proto bundle with the Gradle plugin and fetches it back with the CLI.
#
# Requires: docker (compose v2), a JDK for Gradle, node, and `pnpm build` already run
# (packages/cli/dist). Prints SMOKE OK on success.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="protoloom-smoke"
PORT="${SMOKE_PORT:-3100}"
URL="http://localhost:${PORT}"
# Command run inside the app container; must print the API key as its LAST stdout line.
SEED_CMD="${SMOKE_SEED_CMD:-node apps/web/scripts/seed-smoke.mjs}"
WORK="$(mktemp -d)"
ENV_FILE="$WORK/smoke.env"

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.prod.yml "$@"; }

cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -f "$ENV_FILE" ]; then
    echo "--- smoke failed, container logs ---" >&2
    compose logs --tail=80 >&2 || true
  fi
  if [ -f "$ENV_FILE" ]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

rand() { node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"; }

cat >"$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$(rand)
BETTER_AUTH_SECRET=$(rand)
BETTER_AUTH_URL=${URL}
APP_PORT=${PORT}
INITIAL_ADMIN=github:smoke-admin
GITHUB_CLIENT_ID=smoke-client-id
GITHUB_CLIENT_SECRET=smoke-client-secret
ENV

echo "==> 1. build and start the stack"
compose up -d --build

echo "==> waiting for /api/health"
for i in $(seq 1 90); do
  if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 90 ]; then echo "app did not become healthy" >&2; exit 1; fi
  sleep 2
done

echo "==> 2. seed admin, 'releases' repository and API key"
# The seed also creates the `releases` repository, which covers the "create the repo" step.
TOKEN="$(compose exec -T app sh -c "$SEED_CMD" | tail -n 1 | tr -d '\r\n')"
if [ -z "$TOKEN" ]; then echo "seed printed no API key" >&2; exit 1; fi

echo "==> 3. publish with the Gradle plugin"
export PROTOLOOM_URL="$URL" PROTOLOOM_TOKEN="$TOKEN"
(cd scripts/fixtures/gradle-sample && ../../../gradle-plugin/gradlew --no-daemon --console=plain publishProtos)

echo "==> 4. fetch with the CLI"
SAMPLE="$WORK/node-sample"
cp -r scripts/fixtures/node-sample "$SAMPLE"
(cd "$SAMPLE" && node "$ROOT/packages/cli/dist/index.js" fetch)

echo "==> 5. assert"
FOUND="$(find "$SAMPLE/protos" -type f -path '*smoke/v1/hello.proto' | head -n 1)"
if [ -z "$FOUND" ]; then
  echo "expected smoke/v1/hello.proto under $SAMPLE/protos" >&2
  find "$SAMPLE" -type f >&2 || true
  exit 1
fi
grep -q "message Hello" "$FOUND"

echo "SMOKE OK"
