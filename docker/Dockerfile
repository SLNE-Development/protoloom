# syntax=docker/dockerfile:1
# One image for both processes: `web` (Next.js standalone server) and `worker` (BullMQ worker).
# Select the process with the container command (see docker/entrypoint.sh).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- base: node + pnpm via corepack (version comes from package.json "packageManager") ----
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# ---- pruner: reduce the monorepo to what web + worker need ----
FROM base AS pruner
COPY . .
RUN npm install --global turbo@2.11.10 \
 && turbo prune web @protoloom/worker --docker

# ---- builder: install, build both apps, assemble the runtime tree under /out ----
FROM base AS builder
# Dependency layer: only manifests + lockfile, so source edits do not bust the install cache.
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=pruner /repo/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=pruner /repo/.npmrc ./.npmrc
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
# The env schema (t3-env) must not run at build time; real values arrive at runtime.
ENV SKIP_ENV_VALIDATION=1
RUN pnpm turbo run build --filter=web --filter=@protoloom/worker

# Runtime tree:
#   /out/app            Next standalone server (apps/web/server.js), static assets, public/
#   /out/app/apps/worker  self-contained worker (dist + prod node_modules), via `pnpm deploy`
#   /out/migrate        self-contained @protoloom/db (dist + drizzle migrations + prod node_modules)
#   /out/buf            @bufbuild/buf packages with the Linux binary
RUN mkdir -p /out/app \
 && cp -r apps/web/.next/standalone/. /out/app/ \
 && mkdir -p /out/app/apps/web/.next \
 && cp -r apps/web/.next/static /out/app/apps/web/.next/static \
 && if [ -d apps/web/public ]; then cp -r apps/web/public /out/app/apps/web/public; fi
# `pnpm deploy` packs with npm-packlist, which falls back to .gitignore (it lists dist/): drop it first.
RUN rm -f .gitignore \
 && pnpm --filter=@protoloom/worker deploy --legacy --prod /out/app/apps/worker \
 && pnpm --filter=@protoloom/db deploy --legacy --prod /out/migrate
COPY docker/migrate.mjs /out/migrate/run.mjs
# buf ships its binary in a per-platform optional package; pnpm installs only the one matching the
# build platform (@bufbuild/buf-linux-x64 or -arm64). Copy @bufbuild/buf plus that package into
# /out/buf/node_modules/@bufbuild and fail the build if no binary is found.
RUN mkdir -p /out/buf/node_modules/@bufbuild \
 && for d in node_modules/.pnpm/@bufbuild+buf@*/node_modules/@bufbuild/buf \
             node_modules/.pnpm/@bufbuild+buf-linux-*/node_modules/@bufbuild/buf-linux-*; do \
      [ -e "$d" ] && cp -rL "$d" /out/buf/node_modules/@bufbuild/; \
    done; \
    ls /out/buf/node_modules/@bufbuild/buf-linux-*/bin/buf

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    STORAGE_LOCAL_PATH=/data/storage \
    BUF_BIN=/opt/buf/bin/buf
WORKDIR /app
# `node` (uid 1000) ships with the base image.
COPY --from=builder --chown=node:node /out/app/ /app/
COPY --from=builder --chown=node:node /out/migrate/ /app/migrate/
COPY --from=builder /out/buf/ /opt/buf-pkgs/
# Stable path for the buf binary regardless of CPU architecture.
RUN mkdir -p /opt/buf/bin /data/storage \
 && ln -s "$(ls /opt/buf-pkgs/node_modules/@bufbuild/buf-linux-*/bin/buf | head -n1)" /opt/buf/bin/buf \
 && ln -s /opt/buf/bin/buf /usr/local/bin/buf \
 && chown -R node:node /data
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
VOLUME ["/data/storage"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["web"]
