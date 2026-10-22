#!/usr/bin/env bash
# End-to-end smoke test: boots docker-compose.prod.yml from a fresh image build, seeds an admin +
# `releases` repo + API key, publishes a proto bundle with the Gradle plugin, checks that buf
# validation rejects a broken bundle, fetches the bundle back with the CLI, runs a cleanup job
# through the worker and checks the public pages. Tears everything down afterwards.
#
# Requires: docker (compose v2), a JDK for Gradle, node, curl, tar, and `pnpm install && pnpm build`
# already run (packages/cli/dist, packages/db/dist and esbuild for the seed bundle). The seed
# (apps/web/scripts/seed-smoke.mjs) is not part of the image; it is bundled here and copied into
# the app container. Prints SMOKE OK on success.
set -euo pipefail

# Git Bash on Windows would rewrite container paths such as /app/... into Windows paths.
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="weaver-smoke"
PORT="${SMOKE_PORT:-3100}"
URL="http://localhost:${PORT}"
WORK="$(mktemp -d)"
# With path conversion off, hand Windows binaries (docker, node, curl) a C:/... path on Git Bash.
if command -v cygpath >/dev/null 2>&1; then
  WORK="$(cygpath -m "$WORK")"
  ROOT="$(cygpath -m "$ROOT")"
fi
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

fail() { echo "SMOKE FAILED: $*" >&2; exit 1; }
rand() { node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"; }

cat >"$ENV_FILE" <<ENV
WEAVER_IMAGE=weaver:smoke
POSTGRES_PASSWORD=$(rand)
BETTER_AUTH_SECRET=$(rand)
BETTER_AUTH_URL=${URL}
APP_PORT=${PORT}
INITIAL_ADMIN=github:smoke-admin
GITHUB_CLIENT_ID=smoke-client-id
GITHUB_CLIENT_SECRET=smoke-client-secret
ENV

echo "==> 1. build and start the stack"
compose up -d --build --wait --wait-timeout 300

echo "==> waiting for /api/health"
for i in $(seq 1 90); do
  if curl -fsS "${URL}/api/health" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 90 ] && fail "app did not become healthy"
  sleep 2
done

echo "==> 2. seed admin, 'releases' repository and API key"
# The seed is not in the image: bundle it into one file here and copy it into the running container.
"$ROOT/apps/web/node_modules/.bin/esbuild" "$ROOT/apps/web/scripts/seed-smoke.mjs" --bundle --platform=node \
  --format=esm --target=node22 --log-level=warning --external:pg-native \
  "--banner:js=import { createRequire as __seedCreateRequire } from 'node:module'; const require = __seedCreateRequire(import.meta.url);" \
  --outfile="$WORK/seed-smoke.mjs"
docker cp "$WORK/seed-smoke.mjs" "$(compose ps -q app):/tmp/seed-smoke.mjs"
TOKEN="$(compose exec -T -e WEAVER_SMOKE_SEED=1 app node /tmp/seed-smoke.mjs | tail -n 1 | tr -d '\r\n')"
case "$TOKEN" in pl_*) ;; *) fail "seed printed no API key (got '${TOKEN}')" ;; esac

echo "==> 3. publish with the Gradle plugin"
export WEAVER_URL="$URL" WEAVER_TOKEN="$TOKEN"
(cd scripts/fixtures/gradle-sample && ../../../gradle-plugin/gradlew --no-daemon --console=plain publishProtos)

echo "==> 4. buf validation rejects a bundle with a missing import"
BROKEN="$WORK/broken"
mkdir -p "$BROKEN/broken/v1"
printf 'syntax = "proto3";\npackage broken.v1;\nimport "missing/v1/nope.proto";\nmessage Broken { missing.v1.Nope nope = 1; }\n' \
  >"$BROKEN/broken/v1/broken.proto"
(cd "$BROKEN" && tar -czf ../broken.tar.gz broken)
printf '{"group":"dev.smoke","name":"broken","version":"1.0.0","dependencies":[]}' >"$WORK/broken.json"
STATUS="$(curl -sS -o "$WORK/broken-response.json" -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "manifest=<$WORK/broken.json" \
  -F "archive=@$WORK/broken.tar.gz;type=application/gzip" \
  "${URL}/api/v1/repos/releases/artifacts/dev.smoke/broken/1.0.0")"
[ "$STATUS" = "422" ] || fail "broken bundle: expected 422, got ${STATUS}: $(cat "$WORK/broken-response.json")"
grep -q '"validation_failed"' "$WORK/broken-response.json" || fail "broken bundle: $(cat "$WORK/broken-response.json")"
grep -q 'missing/v1/nope.proto' "$WORK/broken-response.json" || fail "broken bundle: $(cat "$WORK/broken-response.json")"

echo "==> 5. fetch with the CLI"
SAMPLE="$WORK/node-sample"
cp -r scripts/fixtures/node-sample "$SAMPLE"
(cd "$SAMPLE" && node "$ROOT/packages/cli/dist/index.js" fetch)

echo "==> 6. assert the fetched proto"
FOUND="$(find "$SAMPLE/protos" -type f -path '*smoke/v1/hello.proto' | head -n 1)"
if [ -z "$FOUND" ]; then
  find "$SAMPLE" -type f >&2 || true
  fail "expected smoke/v1/hello.proto under $SAMPLE/protos"
fi
grep -q "message Hello" "$FOUND" || fail "$FOUND has no message Hello"

echo "==> 7. the worker processes a cleanup job"
# Enqueued with @weaver/jobs (the web app's code path) against the stack's Valkey.
compose exec -T -w /app/apps/worker worker node --input-type=module -e '
import { createQueue, enqueueCleanup, getJobState, producerConnection } from "@weaver/jobs";
const queue = createQueue(producerConnection(process.env.VALKEY_URL));
try {
  const id = await enqueueCleanup(queue, "releases");
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await getJobState(queue, id);
    if (status.state === "completed") { console.log(`cleanup job ${id} completed: ${JSON.stringify(status.result)}`); break; }
    if (status.state === "failed") throw new Error(`cleanup job ${id} failed: ${status.failedReason}`);
    if (Date.now() > deadline) throw new Error(`cleanup job ${id} still ${status.state} after 60s`);
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  await queue.close();
}
'

echo "==> 8. public pages"
for path in / /docs /sitemap.xml /opengraph-image /og/docs /api/health; do
  STATUS="$(curl -sS -o "$WORK/page" -w '%{http_code}' "${URL}${path}")"
  [ "$STATUS" = "200" ] || fail "GET ${path}: expected 200, got ${STATUS}"
  echo "    ${path} 200"
done
TYPE="$(curl -sS -o "$WORK/page" -w '%{content_type}' "${URL}/opengraph-image")"
case "$TYPE" in image/png*) ;; *) fail "/opengraph-image content type ${TYPE}" ;; esac
grep -q '"ok":true' <(curl -sS "${URL}/api/health") || fail "/api/health body"

echo "SMOKE OK"
