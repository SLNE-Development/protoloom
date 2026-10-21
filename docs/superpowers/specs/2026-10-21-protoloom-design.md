# Protoloom — Design

Date: 2026-10-21

## Intent

Protoloom is a self-hosted registry for `.proto` files, in the spirit of Reposilite (Maven) and Verdaccio (npm). Teams publish versioned bundles of `.proto` files from Gradle. Kotlin/Java projects (via a Gradle plugin) and Node.js projects (via a small CLI) pull those bundles plus all their dependencies into a build folder. From there, other tooling (the separate surf-tide Gradle plugin, protobuf-es, and so on) takes over.

**The registry is only a registry.** It stores, validates, versions, secures and serves `.proto` files. It does not generate code.

## Goals

- Store artifacts with Maven-style coordinates `group:name:version`. Each artifact is a bundle of `.proto` files.
- Artifacts declare dependencies on other artifacts. Pulling an artifact resolves and downloads its whole dependency tree.
- Multiple named repositories per server (for example `public` and `private`, or `releases` and `snapshots`), each with its own settings.
- Releases are immutable unless the repository allows redeploy. `-SNAPSHOT` versions are always overwritable, as in Maven.
- Validate on publish: the protos must compile, and every import must come from the artifact itself, a declared dependency, or the protobuf well-known types.
- Authentication with user accounts and roles for the web UI, plus API keys for clients. Both use Better Auth.
- API keys carry permissions per repository: read or write, optionally limited to a group prefix.
- Cleanup policies per repository.
- A management web UI for repositories, artifacts, API keys, users and policies.
- A Gradle plugin (publish + fetch) and a Node CLI (fetch).
- Ships as one Docker image backed by Postgres, with storage on local disk or S3.

## Non-goals

- Any code generation (no Kotlin, Java or TypeScript output, no service stubs).
- Compatibility with the Maven or npm wire protocols. Clients are our own Gradle plugin and CLI.
- Proxying or mirroring other registries.
- Breaking-change detection between versions (buf breaking and similar).
- Version ranges in dependencies. Versions are exact.
- SSO/OIDC login (Better Auth could add it later).
- Publishing from the Node CLI. Publishing happens from Gradle.

## Anti-goals (failure even if it "works")

- A release gets overwritten in a repository where redeploy is off.
- Private protos are readable anonymously or by a key without read permission on that repository and path.
- A cleanup policy deletes a release that no rule explicitly targeted.
- An API key secret can be viewed again after creation, or is stored in plain text.
- A published artifact that doesn't compile, or that only compiles because of files not declared as dependencies.

## Constraints (decided by the user)

- TypeScript, Node.js, **Turborepo** monorepo.
- **Next.js + TypeScript + Tailwind + shadcn + Drizzle + tRPC.**
- A shared **`ui` package** containing all shadcn components, used throughout the app.
- **Better Auth** for users, roles and API keys.
- **Postgres**, with storage on **S3 or local disk**, selectable by configuration.
- Runs as a **Docker container**.
- Gradle plugin credentials come from **environment variables**.
- Each repository has a setting that decides whether **redeploying releases** is allowed.

## Domain model

### Repository
- `name` (URL-safe, unique), `description`
- `visibility`: `public` (anonymous read) or `private` (needs a key or a logged-in user)
- `allowRedeploy`: boolean, default `false`. When `false`, publishing an existing release version is rejected with `409`. When `true`, the release is replaced.
- `allowSnapshots` / `allowReleases`: which version kinds the repository accepts (both by default). *Builder's call, mirroring Reposilite's releases/snapshots split.*
- Cleanup policies (below)

### Artifact and version
- Coordinates: `group` (reverse-DNS, for example `dev.surf.economy`), `name` (for example `economy-contracts`), `version` (SemVer-ish string; a `-SNAPSHOT` suffix marks a snapshot).
- A version holds a set of `.proto` files under their import paths (for example `surf/economy/v1/money.proto`), a list of declared dependencies (exact coordinates), a SHA-256 checksum, the publishing key or user, the publish time and a download count.
- **Snapshots:** each publish of `1.5.0-SNAPSHOT` creates a new *build* (timestamp and build number, as in Maven). Fetching `1.5.0-SNAPSHOT` returns the newest build. Older builds stay until a cleanup policy removes them.
- **A release may not depend on a snapshot** (Maven convention). Publishing such a release is rejected.

### Dependency resolution (*my call*)
- Clients configure an ordered list of repositories, like a Gradle `repositories {}` block.
- Resolution happens **on the server**: the client sends root coordinates and the ordered repository list, and the server returns the full resolved set with download URLs. This keeps the Gradle plugin and the CLI thin and consistent with each other.
- Each coordinate is looked up in the repositories in order. The first one where it exists and is readable by the caller wins.
- Version conflicts in the tree resolve to the **highest version**, as in Gradle. The resolution result reports any conflicts it resolved.
- Two different artifacts in a resolved tree that contain the same file path are an error.
- At publish time, dependencies are resolved against the target repository first, then the other repositories the publishing key can read, in a server-defined priority order (a repository setting).

### Validation on publish
- Compile the artifact's files together with its resolved dependencies and the bundled well-known types (`google/protobuf/*.proto`).
- Reject (`422`) with a readable error list when compilation fails, or when an import isn't satisfied by the artifact's own files, a declared dependency (direct or transitive), or the well-known types.
- *Builder's call on the tool:* shipping `buf` or `protoc` in the Docker image and running it as a subprocess is the expected approach, since JS proto parsers are not strict enough. It must be pinned and available in dev as well.

## Auth and permissions

- **Better Auth** with email/password, the admin plugin (roles, user management) and the API key plugin.
- **Sign-up is disabled.** Admins create users. The first admin is bootstrapped from env vars (`ADMIN_EMAIL`, `ADMIN_PASSWORD`) when no users exist.
- **Roles (*my call*):**
  - `admin`: everything, including users, repositories, policies and all keys.
  - `maintainer`: browse everything, delete artifacts and versions, create their own keys with read/write permissions.
  - `viewer`: browse everything, create their own read-only keys.
- Logged-in users can browse all repositories in the UI according to their role.
- **Anonymous view (decided by the user, like Reposilite):** a server setting, "Allow anonymous view", that admins toggle on the Settings page and that is off by default. When it's on, visitors who aren't logged in can browse **public** repositories in the web UI: the artifact browser, version pages and the proto viewer, all read-only. Private repositories, keys, users, settings and the audit log are never visible anonymously. When it's off, the UI shows only the login page to anonymous visitors.
  - *My call:* anonymous **API** reads of public repositories (Gradle/CLI without a key) follow repository visibility only and don't depend on this toggle. That way public contracts can be fetched in CI without a key even when the UI is closed.

- **API keys:**
  - Each key belongs to a user and has a name, an optional expiry, a last-used time and a list of permission entries `{ repository, groupPrefix?, access: read | write }`. Write implies read.
  - The secret is shown once and stored hashed. Keys can be revoked.
- Clients send `Authorization: Bearer <key>`. Anonymous requests can read public repositories only.
- Gradle env vars (names are the builder's call): `PROTOLOOM_URL`, `PROTOLOOM_TOKEN`.

### Deleting or redeploying depended-on versions (decided by the user)
- When a version is deleted by hand, or a release is replaced through redeploy, and other versions depend on it in **any** repository, the action is **blocked**. The response (API `409`, UI dialog) lists the dependent artifacts.
- Admins can force it with an explicit confirmation (UI: "Delete anyway", typing the coordinate; API: `?force=true`, admin only). Forced actions are flagged in the audit log.
- This requires tracking dependents across repositories: a dependency edge table, indexed by the depended-on coordinate.

## Cleanup policies

Per repository, a list of rules, each enabled or disabled:
- **Keep last N snapshot builds** per snapshot version.
- **Delete snapshot versions** with no publish in X days.
- **Delete versions not downloaded in X days.** Applies to snapshots only by default, and applies to releases only when the rule explicitly says so.
- Optional group-prefix filter per rule.

Protoloom runs as a **single instance** (*my call*; HA with several replicas is a non-goal). The scheduler still takes a Postgres advisory lock, and snapshot build numbers are assigned inside a transaction, so overlapping runs or concurrent publishes stay safe.

Policies run on a daily schedule. The UI offers **"preview" (dry run)**, which lists what would be deleted, and **"run now"**. Every deletion is written to the audit log. A version that a retained version depends on is never deleted.

## Audit log (*my call*, kept small)
Records publish, redeploy, delete, cleanup deletions, key create/revoke, user and repository changes, with actor, time and target. It can be viewed in the UI (admin).

## Registry HTTP API (for clients)

Versioned under `/api/v1`. JSON, with archives as `.tar.gz`. Shape (exact paths are the builder's call):
- `PUT  /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}`: multipart with `manifest` (JSON: coordinates and dependencies) and `archive` (protos). Returns `201`, `409` (immutable), `422` (validation) or `403`.
- `GET  /api/v1/repos/{repo}/artifacts/{group}/{name}`: list versions.
- `GET  /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}`: manifest (snapshots resolved to the latest build).
- `GET  /api/v1/repos/{repo}/artifacts/{group}/{name}/{version}/archive`: download the archive (counts a download).
- `POST /api/v1/resolve`: `{ repositories: [...], dependencies: ["g:n:v", ...] }` returns the resolved list with checksums and archive URLs, plus resolved conflicts.

The management UI uses **tRPC** separately. The REST API is for the Gradle plugin and the CLI only.

## Clients

### Gradle plugin (Kotlin, in `gradle-plugin/`, built with Gradle, not Turborepo)
```kotlin
plugins { id("<group>.protoloom") version "x" }

protoloom {
    url = providers.environmentVariable("PROTOLOOM_URL")
    token = providers.environmentVariable("PROTOLOOM_TOKEN")
    repositories("releases", "snapshots")
    publishing {
        repository = "releases"           // or picked by -SNAPSHOT
        group = "dev.surf.economy"
        name = "economy-contracts"
        version = project.version
        source = layout.projectDirectory.dir("src/main/proto")
    }
}

dependencies {
    protoloom("dev.surf.economy:economy-contracts:1.4.0")  // published artifact
    protoloom(project(":contracts"))                        // module in the same build
}
```
- **Local modules (decided by the user):** `protoloom(project(":contracts"))` uses the protos of another module in the same build directly, without publishing first.
  - The plugin publishes each module's `source` as an outgoing configuration/variant. Gradle wires the task dependencies, so changes in `:contracts` are picked up on the next build.
  - The local module's own `protoloom` dependencies flow through transitively. Remote dependencies of all local modules are resolved together in one `/resolve` call, and local files and remote files are merged into the same output root.
  - A file path that exists in both a local module and a remote artifact is an error, the same as two remote artifacts colliding.
  - On `publishProtos`, a project dependency is written into the manifest as that module's coordinates (`group:name:version` from its `protoloom.publishing` block). Publishing fails if the module has no publishing block, or if its version isn't published yet. The server validates that as usual.
- `publishProtos`: packs `source` and uses the `protoloom` configuration as the artifact's declared dependencies.
- `fetchProtos`: calls `/resolve` and extracts every resolved artifact into **one merged proto root**, `build/protoloom/protos/`, keeping import paths intact so `import "surf/economy/v1/money.proto"` just works. The task exposes this directory as an output, so surf-tide (or anything else) can wire it in. Releases are cached; snapshots are re-checked.
- Tested with Gradle TestKit against a running server or a stub.
- The plugin ID, group and publishing target are the builder's call.

### Node CLI (`packages/cli`)
- `protoloom fetch` reads `protoloom.json` (url, repositories, dependencies, outDir). The token comes from `PROTOLOOM_TOKEN`.
- It writes the same merged layout into `outDir` (default `./protos`).
- It is meant to run from a pnpm script (`"postinstall"` or `"protos": "protoloom fetch"`) or in CI.

## Web UI (Next.js + shadcn from `packages/ui`)
- **Login.** Public repositories are also browsable without a login when anonymous view is on.
- **Dashboard:** counts, recent publishes.
- **Repositories:** list, create, edit (visibility, allow redeploy, accepted version kinds, resolution priority, cleanup policies with preview and run now).
- **Artifact browser:** repository → group → artifact → versions. A version page shows files with a syntax-highlighted proto viewer, dependencies, dependents, snapshot builds, checksum, publisher, download count, and a usage snippet for Gradle and the CLI. Maintainers and admins can delete.
- **API keys:** create (permission editor, expiry; the secret is shown once), list, revoke.
- **Users (admin):** create, change role, ban/remove, reset password.
- **Settings (admin):** server-wide options, starting with "Allow anonymous view".
- **Audit log (admin).**

## Monorepo layout

```
apps/web          Next.js: UI, tRPC, REST /api/v1, Better Auth routes, scheduler
packages/ui       all shadcn components + Tailwind config/theme
packages/db       Drizzle schema, migrations, client
packages/core     registry logic: coordinates, versions, resolution, permissions, validation, storage drivers, policies
packages/cli      Node fetch CLI
packages/config   shared tsconfig / eslint
gradle-plugin/    Kotlin Gradle plugin (Gradle build)
docker/           Dockerfile, docker-compose (postgres + minio for dev)
```
pnpm workspaces. Turborepo handles build, lint, typecheck and test for the TS packages.

## Configuration (env)
`DATABASE_URL`, `STORAGE_DRIVER` (`local` | `s3`), `STORAGE_LOCAL_PATH`, `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Migrations run on container start.

## Left to the builder
- Exact REST paths and error body format.
- The proto compiler (`buf` or `protoc`) and how it's bundled.
- The scheduler mechanism (in-process via Next.js `instrumentation.ts` or a separate small worker process in the same image).
- Test strategy details (Vitest for `core`, integration tests against Postgres, Playwright for key UI flows are the expected default).
- The Gradle plugin ID, group and publishing target, and the CLI's npm package name.
- Visual design of the UI within shadcn.
