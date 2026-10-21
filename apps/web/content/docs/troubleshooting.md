---
title: Troubleshooting
description: Fix the common failures, including 401 and 403 from Gradle or the CLI, invites that don't work, OAuth callback mismatches and storage errors.
section: Help
order: 1
---

Find the message you see, then follow the fix. Gradle prints server errors as `<code>: <message>`, the CLI as `error: <message>`. Every code is listed in the [REST API](/docs/api#errors) reference.

## 401 or 403 from Gradle or the CLI

| Message | Cause | Fix |
| --- | --- | --- |
| `unauthorized: Publishing requires an API key` | No token was sent. | Export `PROTOLOOM_TOKEN`, or set `protoloom.token`. In CI, check the secret is passed into the step's environment. |
| `unauthorized: Invalid API key` | The key is wrong, expired or revoked, or its owner was banned or removed. | Create a new key under **API keys** and replace the secret. |
| `forbidden: No write access to <group> in <repository>` | The key can read the repository but has no `write` entry covering the group. | Add a `write` entry for that repository with a group prefix that covers the group. Check the prefix: `dev.surf` covers `dev.surf.economy` but not `dev.surfboard`. |
| `forbidden: …` although the key has `write` | The key's owner is a `viewer`. Keys can't do more than their owner's role allows. | Ask an admin to make the owner a `maintainer`, or create the key from a maintainer account. |
| `not_found: Repository <name> was not found` | The repository doesn't exist, or the key has no entry for it. Private repositories you can't read look missing. | Check the spelling in `repositories(...)`/`publishing.repository`, then the key's entries. |
| `unauthorized` even for a public repository | A stale or empty token is sent. A bad token is rejected even where no token is needed. | Unset `PROTOLOOM_TOKEN`, or fix it. |

To check a key quickly:

```sh
curl -i -X POST {{url}}/api/v1/resolve \
  -H "Authorization: Bearer $PROTOLOOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repositories":["releases"],"dependencies":[]}'
```

`200` with `{"artifacts":[],"conflicts":[]}` means the key is valid.

## "No Protoloom server URL configured"

Gradle couldn't find a URL. Set `PROTOLOOM_URL={{url}}`, or `protoloom { url = "…" }`. The CLI says `No registry url: set PROTOLOOM_URL or url in the config file`.

## "Could not reach" or a timeout

`Protoloom publish failed: could not reach …` (Gradle) or `Cannot reach …` / `Request to … timed out after 60s` (CLI). Check the URL, your network or VPN, and that the server is up: `{{url}}/api/health` should answer.

## Publishing fails

| Message | Fix |
| --- | --- |
| `immutable: … already exists in … and releases are immutable` | Bump the version, or use a `-SNAPSHOT` version while iterating. See [Versions and snapshots](/docs/versions). |
| `has_dependents: … is depended on by N version(s)` | A redeploy of a release others use. Publish a new version instead. |
| `invalid_request: Repository … does not accept snapshots` (or releases) | Publish snapshots to the snapshot repository: set `publishing.snapshotRepository`. |
| `validation_failed: Proto validation failed` | A compile error or an import that no declared dependency provides. See [Validation on publish](/docs/validation). |
| `validation_failed: Dependency not found: …` | The dependency isn't published in any repository your key can read. Publish it first, or give the key read access. |
| `validation_failed: A release may not depend on snapshot …` | Release the dependency first. |
| `No .proto files found in …` | Your files aren't under `src/main/proto`. Move them or set `publishing.source`. |
| `protoloom.publishing.<option> is not set.` | Add the option to the `publishing` block. `version` comes from `project.version` when that is set. |
| `payload_too_large: …` | Over 10 MiB, 1000 files or 1 MiB per file. Split the artifact. |

## Fetching fails

| Message | Fix |
| --- | --- |
| `not_found: Dependency … was not found` | The coordinate isn't in any listed repository you can read. Check the version, add the repository to your list, or use a key with read access. |
| `File … is provided by both … and …` / `Path "…" is provided by both …` | Two artifacts contain the same file. See [Dependencies and resolution](/docs/resolution#provided-by-both-errors). |
| `protoloom.repositories is empty` | Add `repositories("…")` to the `protoloom` block. |
| `… exists and wasn't created by protoloom` (CLI) | `outDir` points at an existing folder the CLI didn't create. Choose another `outDir` or delete the folder. |
| `Checksum mismatch for …` | The download was corrupted or changed on the way. Run again; if it persists, check proxies between you and the server. |
| `warning: Version conflict: …` | Not an error. Two artifacts ask for different versions; the highest wins. |

## Invite not working

| What you see | Cause | Fix |
| --- | --- | --- |
| "You need an invite to join this Protoloom." after signing in | The invite wasn't remembered by your browser: more than 15 minutes passed since you opened the link, you used another browser or a private window, or cookies are blocked. | Open the invite link again in the same browser and sign in right away. |
| The invite page says the invite is expired or used | Invites work once and expire after 1 to 30 days. | Ask an admin for a new invite. |
| "You need an invite …" when signing in with your second provider | You never connected that provider. Protoloom doesn't link accounts by email. | Sign in with the provider you joined with and connect the other one on **Account**. See [Join an instance](/docs/join#connect-a-second-provider). |
| Nobody can sign in to a new instance | No admin exists and `INITIAL_ADMIN` isn't set or doesn't match. | Set `INITIAL_ADMIN=github:<login>` or `discord:<user id>` and restart. See [The first admin](/docs/admin/users#the-first-admin). |

## OAuth callback mismatch

GitHub shows "The redirect_uri is not associated with this application", or Discord shows "Invalid OAuth2 redirect_uri".

The callback URL Protoloom sends is built from `BETTER_AUTH_URL`. It must match the one registered with the provider exactly, including `https`, the host, the port and no trailing slash:

- GitHub: `{{url}}/api/auth/callback/github`
- Discord: `{{url}}/api/auth/callback/discord`

Common causes:

- `BETTER_AUTH_URL` is `http://…` behind a proxy or Cloudflare Tunnel. Set it to the public `https://` URL. See [Coolify](/docs/self-host/coolify#set-better_auth_url).
- The OAuth app was registered for another domain, or for `localhost` during testing.
- `BETTER_AUTH_URL` has a path or a different subdomain than the one people open.

If sign-in completes but you land signed out, the cookie was rejected: the site was opened on a different host than `BETTER_AUTH_URL`, or `BETTER_AUTH_URL` is https but the site is opened over http.

## The app doesn't start

The web app checks its configuration on start and logs `Invalid environment variables: …` with the names of the problems:

- `configure at least one OAuth provider (GitHub or Discord); login is OAuth only`: set one complete pair.
- `GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together` (or the Discord pair): set both or neither.
- `INITIAL_ADMIN: must be github:<login> or discord:<user id>`: fix the format.
- `BETTER_AUTH_SECRET`: at least 32 characters.

The worker exits at start when `VALKEY_URL` or `DATABASE_URL` is missing.

## Storage errors

| Message | Fix |
| --- | --- |
| `Missing required environment variable STORAGE_LOCAL_PATH` | With `STORAGE_DRIVER=local`, set the path (the image uses `/data/storage`) and mount a volume there. |
| `Missing required environment variable S3_BUCKET` (or `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`) | Set every `S3_*` variable for `STORAGE_DRIVER=s3`. |
| `Invalid or missing STORAGE_DRIVER` | Use `local` or `s3`. |
| Publishes fail with `internal_error` and the log shows `NoSuchBucket` | Create the bucket. On Coolify, check that `seaweedfs-init` completed. |
| `Archive blob … is missing from storage` in the log | The database points at an archive the store doesn't have: storage was reset or web and worker use different volumes. Restore the storage backup that matches the database. |
| `EACCES` writing to `/data/storage` | The container runs as `node` (uid 1000). Make the mounted directory writable for it. |

## Cleanup doesn't delete anything

- Check the worker is running: `docker compose logs worker` should show `processing cleanup jobs`.
- Use **Preview** on the repository's settings page. If it lists nothing, the rules don't match: releases are only deleted by a "not downloaded" rule with **Include releases**, the newest snapshot build is always kept, and anything a remaining version depends on is kept. See [Cleanup policies](/docs/admin/cleanup#what-is-never-deleted).
