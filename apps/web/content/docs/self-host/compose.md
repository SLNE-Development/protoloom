---
title: Docker Compose
description: Run the web app, worker, Postgres and Valkey from one compose file, with storage on a volume or S3, and upgrade safely.
section: Self-hosting
order: 1
---

Protoloom ships as one Docker image, `ghcr.io/slne-development/protoloom`. The same image runs the web app (`web`) and the background worker (`worker`). The repository's `docker-compose.prod.yml` wires them up with PostgreSQL and Valkey.

You need Docker with Compose, a domain with HTTPS in front of the server, and a GitHub or Discord OAuth app.

## 1. Get the compose file

```sh
git clone https://github.com/slne-development/protoloom.git
cd protoloom
cp .env.example .env
```

`docker-compose.prod.yml` runs four services:

| Service | What it does |
| --- | --- |
| `app` | The web app and REST API on port 3000. Applies database migrations on start. |
| `worker` | Runs cleanup policies (daily and on demand). Starts once `app` is healthy. |
| `postgres` | PostgreSQL 17, data in the `postgres-data` volume. |
| `valkey` | Job queue for the worker, data in the `valkey-data` volume. |

Archives are stored in the `storage-data` volume, shared by `app` and `worker`.

## 2. Fill in `.env`

Set at least these:

```dotenv title=".env"
POSTGRES_PASSWORD=<a long random password>
BETTER_AUTH_SECRET=<output of: openssl rand -base64 48>
BETTER_AUTH_URL={{url}}
INITIAL_ADMIN=github:<your GitHub login>
GITHUB_CLIENT_ID=<from your GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from your GitHub OAuth app>
```

- `BETTER_AUTH_URL` is the public **https** URL people open. It is used for OAuth callbacks, secure cookies and every link the app produces, and is never taken from the request.
- `INITIAL_ADMIN` is required on a fresh instance. Without it nobody can sign in. See [Users, roles and invites](/docs/admin/users#the-first-admin).
- Configure at least one OAuth provider, GitHub or Discord, with both its id and secret. The app refuses to start otherwise.

Every variable is listed in the [Configuration reference](/docs/self-host/config).

## 3. Register the OAuth app

Create an OAuth app with your provider and set its callback URL:

| Provider | Where | Callback URL |
| --- | --- | --- |
| GitHub | Settings → Developer settings → OAuth Apps | `{{url}}/api/auth/callback/github` |
| Discord | Developer Portal → Applications → OAuth2 | `{{url}}/api/auth/callback/discord` |

Copy the client id and secret into `.env`.

## 4. Start the stack

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

This builds the image from the checked-out source. To run the published image instead, add a `compose.override.yml` next to it:

```yaml title="compose.override.yml"
services:
  app:
    image: ghcr.io/slne-development/protoloom:latest
    pull_policy: always
  worker:
    image: ghcr.io/slne-development/protoloom:latest
    pull_policy: always
```

Then start with `docker compose -f docker-compose.prod.yml -f compose.override.yml up -d`. Pin a version tag instead of `latest` if you want upgrades only when you choose.

The app is healthy once `GET /api/health` answers. Check with:

```sh
docker compose -f docker-compose.prod.yml ps
```

## 5. Put HTTPS in front

The app listens on plain HTTP on port 3000 (`APP_PORT` changes the host port). Put a TLS-terminating reverse proxy in front of it, such as Caddy, Traefik, nginx or a Cloudflare Tunnel, and point your domain at it. `BETTER_AUTH_URL` must be that public https URL.

```text title="Caddyfile"
{{host}} {
    reverse_proxy 127.0.0.1:3000
}
```

## 6. Sign in as the first admin

Open `{{url}}/login` and sign in with the account from `INITIAL_ADMIN`. You become `admin`. Then:

1. Create your repositories: [Repositories](/docs/admin/repositories).
2. Invite your team: [Users, roles and invites](/docs/admin/users#invite-someone).
3. Optionally remove `INITIAL_ADMIN` from `.env`. It is ignored once an admin exists.

## Store archives on S3

The default is the `storage-data` volume (`STORAGE_DRIVER=local`). To use any S3-compatible store instead, set in `.env`:

```dotenv title=".env"
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.example.net   # leave empty for AWS
S3_BUCKET=protoloom
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
```

With `S3_ENDPOINT` set, path-style addressing is used, which works with MinIO, SeaweedFS, Garage and most other providers. Create the bucket before you start. To run SeaweedFS next to Protoloom, copy the `seaweedfs` and `seaweedfs-init` services from `docker-compose.coolify.yml`.

## Back up

Back up two things:

- **The database.** `docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U protoloom protoloom > protoloom.sql`
- **The archives.** The `storage-data` volume, or your S3 bucket.

The database holds users, keys, versions and the file contents shown in the browser; the archives are what clients download. Restore both from the same point in time.

## Upgrade

1. Back up, as above.
2. Get the new version: `git pull` (when building from source), or change the image tag.
3. Run `docker compose -f docker-compose.prod.yml up -d --build` (or `pull` then `up -d` for the published image).

The `app` container applies pending database migrations before it starts serving, and `worker` waits until `app` is healthy. To skip migrations on a start, set `RUN_MIGRATIONS=false` on the `app` service.

## Logs

```sh
docker compose -f docker-compose.prod.yml logs -f app worker
```

The image runs as the unprivileged `node` user. The worker logs `protoloom-worker: processing cleanup jobs` when it is ready.
