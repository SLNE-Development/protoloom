# Protoloom

A self-hosted registry for `.proto` files. Publish versioned proto bundles from Gradle, resolve their
dependencies, and fetch them in any project with the Gradle plugin or the `protoloom` CLI.

- **Web app and REST API** (Next.js): repositories, versions, dependency graph, API keys, invites.
- **Worker** (BullMQ on Valkey): background jobs, same image as the web app.
- **Storage**: local disk or any S3-compatible store. **Database**: PostgreSQL.
- **Login**: GitHub and Discord OAuth only. Users join through invite links; the first admin is set with `INITIAL_ADMIN`.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/web` | Next.js app (UI, REST API, tRPC) |
| `apps/worker` | BullMQ worker |
| `packages/core`, `packages/db`, `packages/ui` | Shared logic, Drizzle schema + migrations, UI components |
| `packages/cli` | The `protoloom` CLI |
| `gradle-plugin` | Gradle plugin `dev.protoloom` |
| `docker/` | Dockerfile and entrypoint |

## Local development

Requirements: Node 22+, pnpm (via corepack), Docker, a JDK 21 for the Gradle plugin.

```sh
corepack enable
pnpm install
docker compose up -d          # postgres + seaweedfs (S3) for development
cp .env.example .env          # then fill in the values
pnpm dev
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

End-to-end smoke test (builds the production image, publishes with Gradle, fetches with the CLI):

```sh
pnpm build
bash scripts/e2e-smoke.sh     # ends with SMOKE OK
```

## Configuration

All variables are validated at startup (`apps/web/src/env.ts`). Empty values count as unset.

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `VALKEY_URL` | yes | Valkey/Redis URL used by BullMQ, e.g. `redis://localhost:6379`. |
| `STORAGE_DRIVER` | yes | `local` or `s3`. |
| `STORAGE_LOCAL_PATH` | with `local` | Directory for stored archives (the image uses `/data/storage`). |
| `S3_ENDPOINT` | with `s3` | S3 endpoint URL (empty for AWS). |
| `S3_BUCKET` | with `s3` | Bucket name. |
| `S3_REGION` | with `s3` | Region, e.g. `us-east-1`. |
| `S3_ACCESS_KEY_ID` | with `s3` | S3 access key. |
| `S3_SECRET_ACCESS_KEY` | with `s3` | S3 secret key. |
| `BETTER_AUTH_SECRET` | yes | Session signing secret, e.g. `openssl rand -base64 48`. |
| `BETTER_AUTH_URL` | yes | Public **https** base URL, e.g. `https://protos.example.com`. Used for OAuth callbacks, trusted origin, secure cookies and every absolute URL the app produces. Never derived from the request host or a platform URL. |
| `INITIAL_ADMIN` | first deploy | First admin: `github:<login>` or `discord:<user id>`. While no admin exists, that account may sign in and becomes `admin`. Login is OAuth-only and joining needs an invite, so a fresh instance without it has no way to sign in. Inert once an admin exists (you may remove it afterwards). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | one provider | GitHub OAuth app. Both or neither. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | one provider | Discord OAuth app. Both or neither. |

At least one OAuth provider must be fully configured, otherwise the app refuses to start.

OAuth callback URLs to register with the providers:

- GitHub: `${BETTER_AUTH_URL}/api/auth/callback/github`
- Discord: `${BETTER_AUTH_URL}/api/auth/callback/discord`

Signing in never creates accounts or links by email. A user joins through an invite link
(`/invite/<token>`, created by an admin) and connects further providers on the Account page (`/account`).

Client variables: `PROTOLOOM_URL` (registry base URL) and `PROTOLOOM_TOKEN` (API key), used by the CLI and the Gradle plugin.

Compose-only variables: `POSTGRES_PASSWORD` and `APP_PORT` (default `3000`) in `docker-compose.prod.yml`.

## Gradle plugin

```kotlin
// build.gradle.kts
plugins {
    id("dev.protoloom") version "0.1.0"
}

group = "com.example"
version = "1.2.0"

// PROTOLOOM_URL and PROTOLOOM_TOKEN are read from the environment by default.
protoloom {
    repositories("releases")            // lookup order for dependencies
    publishing {
        repository.set("releases")      // receives release versions
        snapshotRepository.set("snapshots")
        group.set("com.example")
        name.set("orders-api")
        // source defaults to src/main/proto, version to project.version
    }
}

dependencies {
    protoloom("com.example:common-types:2.0.0")
    protoloom(project(":shared-protos"))
}
```

- `./gradlew publishProtos` uploads the bundle. Releases are immutable unless the repository allows redeploys; `-SNAPSHOT` versions always create a new build.
- `./gradlew fetchProtos` resolves the declared dependencies (transitively) into `build/protoloom/protos/`; read it through `protoloom.protosDir`.

## CLI

```sh
npm install --global protoloom   # or: npx protoloom fetch
```

`protoloom.json`:

```json
{
  "repositories": ["releases"],
  "dependencies": ["com.example:common-types:2.0.0"],
  "outDir": "./protos"
}
```

```sh
export PROTOLOOM_URL=https://protos.example.com
export PROTOLOOM_TOKEN=...        # only needed for private repositories
protoloom fetch [--config protoloom.json] [--out ./protos]
```

## Deploy with Docker Compose

`docker-compose.prod.yml` runs the app, the worker (same image, command `worker`), PostgreSQL and Valkey.
The app container applies database migrations on start; the worker waits for the app to be healthy.

```sh
cp .env.example .env
# set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, BETTER_AUTH_URL, one OAuth provider and, for the first
# deploy, INITIAL_ADMIN (without it nobody can sign in to a fresh instance)
docker compose -f docker-compose.prod.yml up -d --build
```

Put a TLS-terminating reverse proxy in front of port 3000 and set `BETTER_AUTH_URL` to its https URL.
Storage defaults to the `storage-data` volume; for S3 set `STORAGE_DRIVER=s3` and the `S3_*` variables.

The image runs as a non-root user, exposes port 3000 and has a healthcheck on `/api/health`.
Commands: `web` (default, migrates first) and `worker`. Set `RUN_MIGRATIONS=true|false` to override the migration default.

## Deploy on Coolify

Create a **Docker Compose** resource from this repository and select `docker-compose.coolify.yml`.
It contains `protoloom` (web), `worker`, `postgres`, `valkey`, `seaweedfs` (bundled S3 storage, bucket created
by a one-shot init container) and `seaweedfs-admin` (the `weed admin` panel).

Coolify generates the database credentials, `BETTER_AUTH_SECRET` and the SeaweedFS keys. You set, in the
Environment Variables tab:

| Variable | Notes |
| --- | --- |
| `BETTER_AUTH_URL` | **Required.** Your public https URL, e.g. `https://protos.example.com`. |
| `INITIAL_ADMIN` | **Required for the first deploy** (`github:<login>` or `discord:<user id>`); without it nobody can sign in to a fresh instance. It is optional in the compose file, so you can remove it once the first admin exists. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | At least one complete pair. |
| `STORAGE_DRIVER` | Optional. `s3` (default, bundled SeaweedFS) or `local` (the `storage-data` volume). |
| `S3_*` | Optional. Point at an external S3 instead of the bundled one. |

**Storage services always start.** The default is the bundled SeaweedFS: `seaweedfs`, `seaweedfs-init` (creates
the bucket, safe to re-run on every redeploy) and `seaweedfs-admin` always start, and `protoloom` waits for
`seaweedfs-init`, regardless of `STORAGE_DRIVER`. To use local storage or an external S3 instead:

1. Set the variables: `STORAGE_DRIVER=local`, or `STORAGE_DRIVER=s3` with `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
2. Edit `docker-compose.coolify.yml` (for example in a fork): delete the `seaweedfs`, `seaweedfs-init` and
   `seaweedfs-admin` services, the `seaweedfs-init` entry under `protoloom` -> `depends_on`, and the
   `seaweedfs-data` and `seaweedfs-admin-data` volumes.

**`BETTER_AUTH_URL` versus the service URL.** In Coolify you assign a domain to the `protoloom` service
(`SERVICE_FQDN_PROTOLOOM_3000`). That value only tells the proxy where to route traffic. With a Cloudflare Tunnel
the URL Coolify knows is plain `http://`, while OAuth callbacks, secure cookies and all links need `https://`.
So `BETTER_AUTH_URL` is a separate required variable you set to the public https URL, and the app never derives
a URL from the request or from the service FQDN. The app trusts `X-Forwarded-Proto` / `X-Forwarded-Host` from the
proxy but still builds URLs from `BETTER_AUTH_URL` only.

Register these OAuth callback URLs:

- GitHub: `https://<your-domain>/api/auth/callback/github`
- Discord: `https://<your-domain>/api/auth/callback/discord`

**SeaweedFS admin panel.** `seaweedfs-admin` gets its own domain (`SERVICE_FQDN_SEAWEEDFSADMIN_23646`) and is
always password protected: Coolify generates `SERVICE_USER_SEAWEEDFSADMIN` and `SERVICE_PASSWORD_SEAWEEDFSADMIN`
(visible in the Environment Variables tab); the password is handed to `weed admin` through a private options file,
not on the command line. Remove the service from the compose file if you do not want the panel.
