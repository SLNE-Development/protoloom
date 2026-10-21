# Protoloom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Protoloom, a self-hosted, versioned, authenticated registry for `.proto` files with a Next.js management UI, a Gradle plugin and a Node CLI.

**Architecture:** A pnpm + Turborepo monorepo. `packages/core` holds all registry rules (coordinates, archives, permissions, resolution, validation, publish/delete, cleanup) behind plain TypeScript functions that take a Drizzle `db` and a `BlobStore`. `apps/web` (Next.js App Router) is a thin shell: Better Auth, REST route handlers under `/api/v1` for clients, tRPC for the UI, and an in-process scheduler. The Gradle plugin (Kotlin) and the CLI (TypeScript) are thin clients of the REST API, and resolution happens on the server.

**Tech Stack:** Node 22+, TypeScript (strict), pnpm, Turborepo, Next.js (App Router), React, Tailwind v4, shadcn/ui, tRPC v11 + TanStack Query, Drizzle ORM + drizzle-kit, Postgres 17, Better Auth (admin + API key plugins), `@bufbuild/buf` (proto validation), `tar` (archives), `@aws-sdk/client-s3`, `croner`, `shiki`, Vitest, `@testcontainers/postgresql`, Playwright, tsup (CLI). Gradle plugin: Kotlin, JVM 21 toolchain, `java-gradle-plugin`, kotlinx.serialization, JUnit 5, Gradle TestKit.

**Spec:** `docs/superpowers/specs/2026-10-21-protoloom-design.md`

## Global Constraints

- Product name **Protoloom**; npm scope `@protoloom/*`; CLI package and binary `protoloom`; Gradle plugin id `dev.protoloom`, group `dev.protoloom`.
- Env vars (server): `DATABASE_URL`, `STORAGE_DRIVER` (`local` | `s3`), `STORAGE_LOCAL_PATH`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
- Env vars (clients): `PROTOLOOM_URL`, `PROTOLOOM_TOKEN`.
- Gradle output root: `build/protoloom/protos/`. CLI config file: `protoloom.json`, default `outDir` `./protos`.
- Roles: `admin`, `maintainer`, `viewer`. Sign-up disabled.
- Releases are immutable unless the repository has `allowRedeploy = true` (default `false`). `-SNAPSHOT` versions always create a new build.
- A release may not depend on a snapshot.
- "Allow anonymous view" setting defaults to **off** and gates only the web UI. Anonymous REST reads of public repositories always work.
- Deleting or redeploying a version that has dependents in any repository → `409 has_dependents`, unless `force` is set by an **admin**.
- Archive limits (*plan's call*): archive ≤ 10 MiB, ≤ 1000 files, each file ≤ 1 MiB, every entry a relative path ending in `.proto`, no `..` segments, no absolute paths, no symlinks.
- Name rules (*plan's call*): repository `^[a-z0-9][a-z0-9-]{0,62}$`; group `^[a-z0-9_]+(\.[a-z0-9_-]+)*$`; name `^[a-z0-9][a-z0-9._-]{0,99}$`; version `^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?$`, max 64 chars.
- REST error body: `{ "error": { "code": string, "message": string, "details"?: unknown } }`. Codes and statuses: `invalid_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `immutable` 409, `has_dependents` 409, `payload_too_large` 413, `validation_failed` 422.
- **UI:** every clickable element (buttons, links, menu items, tabs, checkboxes, switches, selects, table rows with actions) shows `cursor: pointer`. Apply it once in `packages/ui` (base layer and component classes), not per page.
- **UI:** do **not** use the default shadcn neutral/"paper" theme. The user chose scheme **A · Ink**, and the controller ruled direction **1 · Console** (see Task 2b). Theme switching uses **next-themes** (light / dark / system).
- **UI:** English only. No i18n framework.
- **UI:** a **Ctrl+K / Cmd+K command dialog** is available on every app page (see Task 15).
- Every UI screen uses components from `@protoloom/ui`; no ad-hoc re-styled HTML controls where a ui component exists.
- Pin exact dependency versions at install time (no `^` in `package.json`), and use the latest stable versions available at install time.
- Commits: Conventional Commits in English, ending with the `Co-Authored-By` trailer from the session.

## Review Focus

1. **Group-prefix matching**: a key scoped to `dev.surf` must match `dev.surf` and `dev.surf.economy` but **not** `dev.surfboard`. Test in Task 5.
2. **Malicious archives**: entries like `../../etc/passwd`, `/abs.proto`, symlinks, non-`.proto` files and gzip bombs over the limits must be rejected with `invalid_request` or `payload_too_large`, and nothing may be written outside a temp dir. Test in Task 4.
3. **Role downgrade after key creation**: a maintainer creates a write key and is then demoted to viewer. The key must stop granting write immediately, because the role ceiling is checked at request time. The same applies to banned users (the key stops working). Test in Task 5 (pure) and Task 12 (principal).
4. **Concurrent snapshot publishes**: two publishes of the same `-SNAPSHOT` at once must get distinct, consecutive build numbers. Test in Task 10.
5. **Private data through side channels**: `/resolve` must not reveal that a private artifact exists to a caller without read access. The lookup treats unreadable repositories as absent. The UI's anonymous browse must not list private repositories even when anonymous view is on. Tests in Task 10 and Task 14.

---

## File Structure

```
package.json, pnpm-workspace.yaml, turbo.json, .gitignore, .npmrc, .nvmrc
packages/config/            tsconfig.base.json, tsconfig.node.json, tsconfig.next.json, eslint.config.js, vitest.shared.ts
packages/ui/                shadcn monorepo package: src/components/*, src/styles/globals.css (theme), src/lib/utils.ts, src/components/logo.tsx
packages/db/                src/schema/{auth,registry,settings,audit}.ts, src/index.ts (createDb), src/migrate.ts, drizzle/ (migrations), src/testing.ts (testcontainers helper)
packages/core/src/
  errors.ts                 RegistryError + codes
  coordinates.ts            parse/format/validate/compare versions
  archive.ts                extract/pack/sha256/limits
  permissions.ts            Principal, canAccess, role ceilings
  storage/{index,local,s3}.ts  BlobStore + drivers
  validation.ts             buf-based compile check
  resolution.ts             graph resolution (pure, injected lookup) + collisions
  registry/{index,publish,read,delete,lookup}.ts  DB-backed registry service
  cleanup.ts                plan/apply cleanup policies
  audit.ts                  recordAudit
  settings.ts               get/update server settings
apps/web/
  src/server/auth.ts        Better Auth instance
  src/server/principal.ts   request → Principal
  src/server/context.ts     db, blobs, registry singletons
  src/server/bootstrap.ts   first admin
  src/server/scheduler.ts   daily cleanup with advisory lock
  src/instrumentation.ts
  src/app/api/v1/...        REST route handlers
  src/app/api/auth/[...all]/route.ts
  src/server/trpc/{init,root}.ts, routers/*.ts
  src/app/(app)/...         UI pages
  e2e/                      Playwright
packages/cli/src/{index,config,fetch,client}.ts
gradle-plugin/              settings.gradle.kts, build.gradle.kts, src/main/kotlin/dev/protoloom/gradle/*, src/test/kotlin/...
docker/Dockerfile, docker/entrypoint.sh, docker-compose.yml (dev: postgres + minio), docker-compose.prod.yml
scripts/e2e-smoke.sh
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.npmrc`, `.nvmrc`, `packages/config/*`, `packages/core/package.json` + `packages/core/src/index.ts` + `packages/core/src/smoke.test.ts`

**Interfaces:**
- Produces: shared configs `@protoloom/config/tsconfig.node.json`, `@protoloom/config/tsconfig.next.json`, `@protoloom/config/eslint`, `@protoloom/config/vitest.shared`; root scripts `build`, `lint`, `typecheck`, `test`, `dev`, each running `turbo run <task>`.

- [ ] **Step 1:** Run `git init` (the repo doesn't exist yet). Commit the existing `docs/` as `docs: add protoloom design, plan and logos`.
- [ ] **Step 2:** Create the root workspace (`packages/*`, `apps/*`), `turbo.json` with tasks `build` (outputs `dist/**`, `.next/**` excluding `.next/cache/**`), `lint`, `typecheck`, `test`, `dev` (persistent, no cache). Add `.gitignore` for node, Next, Gradle and `build/`.
- [ ] **Step 3:** Create `packages/config` with strict TS (`"strict": true, "noUncheckedIndexedAccess": true, "module": "NodeNext"` for node and `"Bundler"` for next), a flat ESLint config with typescript-eslint, and a Vitest shared config.
- [ ] **Step 4:** Create the `packages/core` skeleton (ESM, `"type": "module"`, build with `tsc`) and the test `smoke.test.ts`: `expect(1 + 1).toBe(2)`.
- [ ] **Step 5:** Run `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test`. Expected: all pass.
- [ ] **Step 6:** Commit with `build: scaffold turborepo workspace`.

### Task 2a: UI package with all shadcn components

**Files:**
- Create: `packages/ui/**` (via shadcn monorepo init), `packages/ui/src/components/logo.tsx`; copy `docs/brand/protoloom-icon.svg` and `protoloom-icon-inverted.svg` into `packages/ui/src/assets/`

**Interfaces:**
- Produces: imports `@protoloom/ui/components/<name>` (for example `@protoloom/ui/components/button`), `@protoloom/ui/lib/utils` (`cn`), `@protoloom/ui/globals.css`, and `Logo({ variant?: "icon" | "full", className?: string })`, which shows the inverted icon in dark mode.

- [ ] **Step 1:** Initialize shadcn in monorepo mode so the components live in `packages/ui` (Tailwind v4). Then run `shadcn add --all` from inside `packages/ui`.
- [ ] **Step 2:** Add `cursor-pointer` globally. In `globals.css` `@layer base`, add `button:not(:disabled), [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], a[href], label[for], select, summary { cursor: pointer; }` and `:disabled, [aria-disabled="true"], [data-disabled] { cursor: not-allowed; }`. Also check that components which render non-native elements (Radix triggers, `SelectItem`, `DropdownMenuItem`, `CommandItem`) get `cursor-pointer` in their class list, and patch the component files where they set `cursor-default`.
- [ ] **Step 3:** Add the `Logo` component, rendering the SVGs inline.
- [ ] **Step 4:** Add a test `packages/ui/src/cursor.test.ts` that reads every file in `src/components/*.tsx` and asserts none contains `cursor-default` on an interactive element. Assert `expect(offenders).toEqual([])`, where offenders are files matching `/cursor-default/`.
- [ ] **Step 5:** Run `pnpm --filter @protoloom/ui typecheck test`. Expected: pass.
- [ ] **Step 6:** Commit with `feat(ui): add shadcn component package with pointer cursors`.

### Task 2b: Design system theme: scheme **A · Ink**, direction **1 · Console**

The user chose scheme A · Ink and asked for next-themes. The direction wasn't named; the controller ruled Console because it fits the Ctrl+K command palette and the developer audience.

**Files:**
- Modify: `packages/ui/src/styles/globals.css` (tokens for `:root` and `.dark`, radius, fonts), plus component class tweaks the direction requires.
- Create: `packages/ui/src/components/theme-provider.tsx` (wraps `next-themes` `ThemeProvider` with `attribute="class"`, `defaultTheme="system"`, `enableSystem`, `disableTransitionOnChange`) and `packages/ui/src/components/theme-toggle.tsx` (Light / Dark / System dropdown).

**Ink tokens** (hex; convert to oklch or keep hex in the CSS variables):

| Token | Light | Dark |
|---|---|---|
| `--background` | `#ffffff` | `#0a0a0a` |
| `--card` / `--popover` | `#ffffff` | `#111111` |
| surface / `--muted` | `#fafafa` | `#111111` (muted surface `#1a1a1a`) |
| `--foreground` | `#0a0a0a` | `#ededed` |
| `--muted-foreground` | `#6b6b6b` | `#8f8f8f` |
| `--border` / `--input` | `#e6e6e6` | `#262626` |
| `--primary` / `--primary-foreground` | `#0a0a0a` / `#ffffff` | `#fafafa` / `#0a0a0a` |
| `--secondary`, `--accent` | `#f2f2f2` | `#1a1a1a` |
| `--ring` | `#0a0a0a` | `#fafafa` |
| `--link` (new) | `#1f5eff` | `#7aa2ff` |
| `--release` / `--release-soft` (new) | `#15803d` / `#e6f4ea` | `#4ade80` / `#0f2417` |
| `--snapshot` / `--snapshot-soft` (new) | `#b45309` / `#fdf1e3` | `#f59e0b` / `#2a1f0d` |
| `--destructive` | `#dc2626` | `#f87171` |
| `--sidebar` / `--sidebar-foreground` | `#0a0a0a` / `#e5e5e5` | `#000000` / `#ededed` |
| `--sidebar-accent` | `rgb(229 229 229 / 12%)` | `rgb(237 237 237 / 12%)` |
| `--chart-1..5` | `#0a0a0a`, `#1f5eff`, `#15803d`, `#b45309`, `#6b6b6b` | `#ededed`, `#7aa2ff`, `#4ade80`, `#f59e0b`, `#8f8f8f` |

**Console direction:** Geist (UI) and Geist Mono (coordinates, versions, code) via `next/font` or `@fontsource`. Radius `0.375rem` (6px), hairline borders, compact table rows, a dark sidebar in both modes. Expose Tailwind utilities for the new tokens (`text-link`, `bg-release-soft`, `text-snapshot`, and so on) through `@theme inline`.

- [ ] **Step 1:** Implement the tokens for `:root` and `.dark`, the fonts, the radius, the Tailwind theme mappings, `ThemeProvider` and `ThemeToggle`.
- [ ] **Step 2:** Add a `packages/ui/src/theme.test.ts` asserting that `globals.css` defines `--link`, `--release` and `--snapshot` in both `:root` and `.dark`, that the light `--background` is white (`#ffffff` or `oklch(1 0 0)`), and that `--radius` is `0.375rem`.
- [ ] **Step 3:** Run `pnpm --filter @protoloom/ui test typecheck`. Expected: pass. Commit with `feat(ui): add ink design system theme`.

### Task 3: Coordinates and versions

**Files:**
- Create: `packages/core/src/errors.ts`, `packages/core/src/coordinates.ts`
- Test: `packages/core/src/coordinates.test.ts`

**Interfaces:**
- Produces:
  - `type ErrorCode = "invalid_request" | "unauthorized" | "forbidden" | "not_found" | "immutable" | "has_dependents" | "payload_too_large" | "validation_failed"`
  - `class RegistryError extends Error { code: ErrorCode; status: number; details?: unknown; constructor(code, message, details?) }`. The status comes from the code table in Global Constraints.
  - `interface Coordinate { group: string; name: string; version: string }`
  - `parseCoordinate(s: string): Coordinate` (throws `RegistryError("invalid_request")`), `formatCoordinate(c): string`
  - `isValidRepositoryName/isValidGroup/isValidName/isValidVersion(s: string): boolean`
  - `isSnapshot(version: string): boolean` (true when the version ends with `-SNAPSHOT`)
  - `compareVersions(a: string, b: string): number`

- [ ] **Step 1: Write failing tests.**
  - `parseCoordinate("dev.surf.economy:economy-contracts:1.4.0")` equals `{group:"dev.surf.economy", name:"economy-contracts", version:"1.4.0"}`.
  - `parseCoordinate("a:b")` and `parseCoordinate("Dev:x:1")` throw with code `invalid_request`.
  - `isSnapshot("1.5.0-SNAPSHOT")` is true and `isSnapshot("1.5.0")` is false.
  - `compareVersions`: `1.10.0 > 1.9.0`, `1.0 == 1.0.0`, `1.5.0 > 1.5.0-SNAPSHOT`, `1.5.0-rc.2 > 1.5.0-rc.1`, `1.5.0-rc.10 > 1.5.0-rc.9`, `2.0.0-SNAPSHOT > 1.9.9`.
  - Each name regex from Global Constraints accepts one valid and rejects one invalid example.
- [ ] **Step 2:** Run `pnpm --filter @protoloom/core test coordinates`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Comparison: compare numeric parts left to right, treating missing parts as 0. Then a version without a qualifier is greater than one with a qualifier. Then compare qualifiers by `.`-separated segments: two numeric segments compare as numbers, otherwise as strings, and a shorter qualifier is smaller.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): add coordinates and version comparison`.

### Task 4: Archives

**Files:**
- Create: `packages/core/src/archive.ts`
- Test: `packages/core/src/archive.test.ts`

**Interfaces:**
- Produces: `interface ProtoFile { path: string; content: string }`; `LIMITS = { archiveBytes: 10 * 1024 * 1024, files: 1000, fileBytes: 1024 * 1024 }`; `extractArchive(data: Buffer): Promise<ProtoFile[]>` (sorted by path); `packArchive(files: ProtoFile[]): Promise<Buffer>` (tar.gz, deterministic: sorted entries, mtime 0); `sha256(data: Buffer): string` (lowercase hex).

- [ ] **Step 1: Write failing tests.**
  - Round trip: `extractArchive(await packArchive(files))` equals `files` sorted.
  - Packing the same files twice produces the same `sha256`.
  - Rejects with `invalid_request`: an entry `../evil.proto`, an entry `/abs.proto`, a symlink entry, an entry `readme.md`, and an empty archive.
  - Rejects with `payload_too_large`: an archive over `LIMITS.archiveBytes`, 1001 files, and one file over 1 MiB after decompression (build a gzip of 2 MiB of repeated bytes, which also covers the gzip bomb).
  - Normalizes `./a/b.proto` to `a/b.proto`, and rejects duplicate paths after normalization.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement** with `tar` (`tar.t`/`Parser`) reading from memory. Count decompressed bytes while streaming and abort once over the limit. Never touch the file system.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): add safe proto archive handling`.

### Task 5: Permissions

**Files:**
- Create: `packages/core/src/permissions.ts`
- Test: `packages/core/src/permissions.test.ts`

**Interfaces:**
- Produces:
  - `type Role = "admin" | "maintainer" | "viewer"`; `type Access = "read" | "write"`
  - `interface KeyPermission { repository: string; groupPrefix: string | null; access: Access }`
  - `type Principal = { kind: "anonymous" } | { kind: "user"; userId: string; role: Role } | { kind: "apikey"; keyId: string; userId: string; role: Role; permissions: KeyPermission[] }`
  - `interface RepoRef { name: string; visibility: "public" | "private" }`
  - `groupMatches(prefix: string | null, group: string): boolean`
  - `maxKeyAccess(role: Role): Access` (viewer → `read`, others → `write`)
  - `canAccess(p: Principal, repo: RepoRef, group: string, access: Access): boolean`
  - `canDeleteVersions(p: Principal, repo: RepoRef, group: string): boolean`
  - `canForce(p: Principal): boolean` (admin user, or an admin's key)
  - `isAdmin(p: Principal): boolean`

- [ ] **Step 1: Write failing tests** (table-driven):
  - Anonymous: reads public repos, can't read private ones, never writes.
  - User (any role): reads all repos, and `canAccess(...,"write")` is false (publishing only happens through keys).
  - Key `{repository:"private", groupPrefix:"dev.surf", access:"write"}` owned by a maintainer: can write `dev.surf` and `dev.surf.economy`, can't write `dev.surfboard`, can't write repository `public`, but can read `public` because public repositories are readable by everyone.
  - Same key owned by a viewer (demoted): read is true, write is false.
  - A `read` entry never grants write.
  - `canDeleteVersions`: maintainer or admin user → true; viewer user → false; a key with write access on the repository and a maintainer owner → true; anonymous → false.
  - `canForce`: admin user → true, maintainer → false.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Effective key access is the entry's access capped by `maxKeyAccess(role)`.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): add permission model`.

### Task 6: Database schema

**Files:**
- Create: `packages/db/package.json`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/auth.ts` (generated by Better Auth CLI for user/session/account/verification/apikey with the admin plugin fields `role`, `banned`, `banReason`, `banExpires`, `impersonatedBy`), `packages/db/src/schema/registry.ts`, `packages/db/src/schema/settings.ts`, `packages/db/src/schema/audit.ts`, `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `packages/db/src/testing.ts`, `packages/db/drizzle/*`
- Test: `packages/db/src/migrate.test.ts`

**Interfaces:**
- Produces:
  - `createDb(url: string): Db` (node-postgres pool + drizzle with schema); `type Db`; `type Tx`
  - `migrate(db: Db): Promise<void>`
  - `startTestDb(): Promise<{ db: Db; url: string; stop(): Promise<void> }>` (testcontainers `postgres:17-alpine`, migrated)
  - Tables (camelCase TS, snake_case SQL):
    - `repository { id uuid pk, name text unique, description text, visibility enum('public','private') default 'private', allowRedeploy bool default false, allowReleases bool default true, allowSnapshots bool default true, resolutionPriority int default 100, createdAt }`
    - `artifact { id, repositoryId fk cascade, group text, name text, createdAt; unique(repositoryId, group, name) }`
    - `version { id, artifactId fk cascade, version text, isSnapshot bool, createdAt, updatedAt; unique(artifactId, version) }`
    - `build { id, versionId fk cascade, buildNumber int, storageKey text, sha256 text, sizeBytes int, publishedByUserId text null, publishedByKeyId text null, downloadCount int default 0, lastDownloadedAt timestamptz null, createdAt; unique(versionId, buildNumber) }`
    - `buildFile { buildId fk cascade, path text, content text; pk(buildId, path) }`
    - `dependency { buildId fk cascade, depGroup text, depName text, depVersion text; pk(buildId, depGroup, depName); index(depGroup, depName, depVersion) }`
    - `cleanupPolicy { id, repositoryId fk cascade, kind enum('keep_last_snapshot_builds','delete_stale_snapshots','delete_not_downloaded'), value int, includeReleases bool default false, groupPrefix text null, enabled bool default true, createdAt }`
    - `apiKeyPermission { id, apiKeyId text fk→apikey.id cascade, repository text, groupPrefix text null, access enum('read','write') }`
    - `setting { key text pk, value jsonb }`
    - `auditEvent { id, at timestamptz default now, actorType enum('user','apikey','anonymous','system'), actorId text null, action text, target text, details jsonb null, forced bool default false }`

- [ ] **Step 1: Write a failing test** in `migrate.test.ts`: `startTestDb()` succeeds, and inserting a repository then selecting it by name returns `visibility === "private"` and `allowRedeploy === false`.
- [ ] **Step 2:** Run `pnpm --filter @protoloom/db test`. Expected: FAIL.
- [ ] **Step 3:** Write the schema and generate the migration with `drizzle-kit generate`. Generate the Better Auth schema with the Better Auth CLI, using the same plugin set Task 12 configures (`admin`, `apiKey`), and commit it.
- [ ] **Step 4:** Run the test. Expected: PASS. Commit with `feat(db): add registry schema and migrations`.

### Task 7: Blob storage

**Files:**
- Create: `packages/core/src/storage/index.ts`, `local.ts`, `s3.ts`
- Test: `packages/core/src/storage/storage.test.ts`
- Create: `docker-compose.yml` with `postgres:17-alpine` (5432) and `minio/minio` (9000, bucket created by an init container)

**Interfaces:**
- Produces: `interface BlobStore { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Buffer | null>; delete(key: string): Promise<void> }`; `createLocalStore(root: string)`; `createS3Store(opts: { endpoint?: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string })` (path-style addressing when `endpoint` is set); `createBlobStoreFromEnv(env: NodeJS.ProcessEnv): BlobStore` (throws on missing config).
- Key format: `{repository}/{group}/{name}/{version}/{buildNumber}.tar.gz`. `createLocalStore` rejects keys containing `..`.

- [ ] **Step 1: Write failing tests,** shared and run against both drivers: put, then get returns the same bytes; getting a missing key returns `null`; delete then get returns `null`; deleting a missing key doesn't throw. The local store also rejects `../x`. The S3 suite runs only when `S3_TEST_ENDPOINT` is set (`describe.skipIf`).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The local store writes atomically (temp file + rename) and creates directories.
- [ ] **Step 4:** Run the tests (local), then run with `docker compose up -d minio` and `S3_TEST_ENDPOINT=http://localhost:9000`. Expected: PASS. Commit with `feat(core): add local and s3 blob storage`.

### Task 8: Proto validation

**Files:**
- Create: `packages/core/src/validation.ts`
- Test: `packages/core/src/validation.test.ts`

**Interfaces:**
- Produces: `interface ValidationIssue { path: string; line?: number; column?: number; message: string }`; `validateProtos(input: { files: ProtoFile[]; dependencyFiles: ProtoFile[] }): Promise<ValidationIssue[]>` (empty array means valid).

- [ ] **Step 1: Write failing tests:**
  - A valid file importing `google/protobuf/timestamp.proto` returns `[]`.
  - A syntax error returns one issue whose `path === "a/v1/a.proto"` and whose `line` is set.
  - `import "b/v1/b.proto"` with `b` absent from `dependencyFiles` returns an issue for `a/v1/a.proto` whose message mentions `b/v1/b.proto`.
  - The same import with `b` present in `dependencyFiles` returns `[]`.
  - A transitive chain (a → b → c, with b and c both in `dependencyFiles`) returns `[]`.
  - A file path present in both `files` and `dependencyFiles` returns an issue mentioning a duplicate.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement** with the pinned `@bufbuild/buf` binary. Write `files` to `<tmp>/src`, `dependencyFiles` to `<tmp>/deps`, and a `buf.yaml` with `version: v2` and `modules: [{path: src}, {path: deps}]`. Run `buf build --path src --error-format json -o -` (discard the output), parse the JSON issues, map the paths back by stripping the `src/` prefix, and always delete the temp dir. Resolve the binary path from `@bufbuild/buf` with `require.resolve`, so it works in dev and Docker. Check for duplicate paths before running buf.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): validate protos with buf`.

### Task 9: Dependency resolution (pure)

**Files:**
- Create: `packages/core/src/resolution.ts`
- Test: `packages/core/src/resolution.test.ts`

**Interfaces:**
- Produces:
  - `interface ResolvedNode { coordinate: Coordinate; repository: string; buildNumber: number; sha256: string; dependencies: Coordinate[] }`
  - `type Lookup = (c: Coordinate) => Promise<ResolvedNode | null>`
  - `interface Conflict { group: string; name: string; requested: string[]; selected: string }`
  - `interface Resolution { nodes: ResolvedNode[]; conflicts: Conflict[] }` (nodes sorted by `group:name`)
  - `resolveGraph(roots: Coordinate[], lookup: Lookup): Promise<Resolution>`
  - `findPathCollisions(entries: { coordinate: Coordinate; paths: string[] }[]): { path: string; coordinates: string[] }[]`

- [ ] **Step 1: Write failing tests** using an in-memory lookup:
  - Linear chain a → b → c resolves 3 nodes.
  - Diamond: a → b:1.0 and a → c, c → b:2.0. Selects b:2.0, reports a conflict `{group, name:"b", requested:["1.0","2.0"], selected:"2.0"}`, and drops deps only b:1.0 had.
  - A cycle a → b → a terminates and returns 2 nodes.
  - A missing dep throws `RegistryError("not_found")` whose `details.path` is `["g:a:1", "g:missing:1"]`.
  - Roots requesting two versions of the same artifact select the highest.
  - `findPathCollisions` reports `x/y.proto` claimed by two coordinates.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `selected: Map<"group:name", version>` and every requested version per key. Run a worklist from the roots: when a higher version of a key is encountered, replace it and enqueue that version. Look up each `(key, version)` at most once. When the worklist is empty, walk again from the roots following only selected versions to collect the final node set. Conflicts are keys with more than one distinct requested version.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): add dependency graph resolution`.

### Task 10: Registry service (publish, read, resolve, delete, audit)

**Files:**
- Create: `packages/core/src/audit.ts`, `packages/core/src/registry/{index,lookup,publish,read,delete}.ts`
- Test: `packages/core/src/registry/registry.test.ts` (uses `startTestDb`, `createLocalStore(tmp)`)

**Interfaces:**
- Consumes: Tasks 3–9 and `Db` from Task 6.
- Produces:
  - `recordAudit(tx: Tx, e: { actor: Principal | "system"; action: string; target: string; details?: unknown; forced?: boolean }): Promise<void>`
  - `manifestSchema` (zod): `{ group, name, version, dependencies: string[] }`; `type Manifest`
  - `createRegistry(deps: { db: Db; blobs: BlobStore; validate?: typeof validateProtos }): Registry`
  - `Registry.publish(p: Principal, input: { repository: string; manifest: Manifest; archive: Buffer; force?: boolean }): Promise<{ coordinate: Coordinate; buildNumber: number; sha256: string; redeployed: boolean }>`
  - `Registry.listVersions(p, repository: string, group: string, name: string): Promise<{ version: string; isSnapshot: boolean; latestBuild: number; updatedAt: Date }[]>`
  - `Registry.getManifest(p, repository: string, c: Coordinate): Promise<VersionInfo>`, where `VersionInfo = { repository; coordinate; buildNumber; sha256; sizeBytes; dependencies: Coordinate[]; files: string[]; publishedBy: string | null; downloadCount: number; createdAt: Date; builds: { buildNumber: number; createdAt: Date; sha256: string }[] }`
  - `Registry.download(p, repository, c): Promise<{ data: Buffer; sha256: string; filename: string }>` (increments `downloadCount` and sets `lastDownloadedAt` on the served build)
  - `Registry.getFile(p, repository, c, path: string): Promise<string>`
  - `Registry.resolve(p, repositories: string[], roots: Coordinate[]): Promise<Resolution>`
  - `Registry.listDependents(c: Coordinate): Promise<{ repository: string; coordinate: Coordinate }[]>`
  - `Registry.deleteVersion(p, repository, c, opts?: { force?: boolean }): Promise<void>`

- [ ] **Step 1: Write failing tests** (each one sets up repos and keys through direct inserts or helper factories):
  - A valid publish to `releases` returns `buildNumber: 1`. `getManifest` lists the files and the declared deps.
  - Re-publishing the same release with `allowRedeploy = false` throws `immutable`. With `allowRedeploy = true` it succeeds with `redeployed: true`, and the content is replaced.
  - Redeploying a release that has a dependent throws `has_dependents`, with details listing the dependent. With `force: true` by an admin key it succeeds and the audit row has `forced = true`. With `force: true` by a maintainer it throws `forbidden`.
  - Publishing `1.0.0-SNAPSHOT` three times gives builds 1, 2, 3. `getManifest(…"1.0.0-SNAPSHOT")` returns build 3.
  - Two `Promise.all` concurrent snapshot publishes produce builds `{1, 2}`, using `pg_advisory_xact_lock(hashtext(repo||group||name||version))` inside the transaction.
  - A release depending on a `-SNAPSHOT` throws `validation_failed`.
  - A repo with `allowSnapshots = false` rejects a snapshot with `invalid_request`.
  - An undeclared import throws `validation_failed`, with `details.issues[0].path` set.
  - A dependency in another repo readable by the key resolves, ordered target repo first, then by `resolutionPriority`. A dependency only in a private repo the key can't read throws `validation_failed` ("dependency not found").
  - Without write permission, publishing throws `forbidden`. As anonymous it throws `unauthorized`.
  - `resolve` as anonymous over `["private"]` containing the artifact throws `not_found`, the same as for a missing artifact (Review Focus 5).
  - `download` increments `downloadCount` to 1.
  - `deleteVersion` with a dependent throws `has_dependents`. Without dependents it removes the rows and the blobs (`blobs.get(key)` returns `null`).
  - Every mutation writes an audit row (`publish`, `redeploy`, `delete`).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`lookup.ts`** builds a `Lookup` for a principal and an ordered repository list. It returns `null` for repositories the principal can't read. For snapshots it picks the highest `buildNumber`.
  - **`publish.ts`** runs these steps in order:
    1. Check permission.
    2. Parse the manifest, and check that the version kind is allowed.
    3. `extractArchive`.
    4. Existing-release checks: immutable, dependents, force.
    5. Resolve deps with publish ordering, then check collisions.
    6. Load dependency files from `buildFile`.
    7. Run `validate`.
    8. Write the blob.
    9. In one transaction with the advisory lock: upsert artifact and version, insert or replace the build, insert `buildFile` and `dependency` rows, update `version.updatedAt`, then `recordAudit`.

    A redeploy replaces build 1 and deletes the old blob after commit.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): add registry publish, read, resolve and delete`.

### Task 11: Cleanup policies and settings

**Files:**
- Create: `packages/core/src/cleanup.ts`, `packages/core/src/settings.ts`
- Test: `packages/core/src/cleanup.test.ts`, `packages/core/src/settings.test.ts`

**Interfaces:**
- Produces:
  - `interface CleanupCandidate { repository: string; coordinate: Coordinate; buildNumber: number | null /* null = whole version */; reason: string }`
  - `planCleanup(db: Db, repository: string, now: Date): Promise<CleanupCandidate[]>`
  - `applyCleanup(db: Db, blobs: BlobStore, repository: string, now: Date): Promise<CleanupCandidate[]>`
  - `runAllCleanups(db: Db, blobs: BlobStore, now: Date): Promise<number>` (takes `pg_try_advisory_lock(727001)` and returns 0 if not acquired)
  - `interface ServerSettings { anonymousView: boolean }`; `getSettings(db): Promise<ServerSettings>` (default `{ anonymousView: false }`); `updateSettings(db, patch: Partial<ServerSettings>, actor: Principal): Promise<ServerSettings>` (audited)

- [ ] **Step 1: Write failing tests:**
  - `keep_last_snapshot_builds` with value 2 and builds 1–5 plans builds 1, 2, 3. It never removes the newest build, and a value below 1 is treated as 1.
  - `delete_stale_snapshots` with value 30: a snapshot updated 31 days ago is planned as a whole version, one updated 29 days ago is not, and a release updated 400 days ago is not.
  - `delete_not_downloaded` with value 90 and `includeReleases = false` skips releases. With `true` it includes them. A version never downloaded uses `createdAt`.
  - A `groupPrefix` filter limits candidates (using `groupMatches`).
  - Disabled policies plan nothing.
  - A candidate version that a non-candidate version depends on (in any repo) is excluded.
  - `applyCleanup` deletes rows and blobs and writes audit rows with `actorType = 'system'` and `action = 'cleanup.delete'`.
  - `getSettings` on an empty db returns `{ anonymousView: false }`. After `updateSettings({ anonymousView: true })` it returns true.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(core): add cleanup policies and server settings`.

### Task 12: Web app foundation: auth, principal, bootstrap, scheduler

**Files:**
- Create: `apps/web` (Next.js App Router, `output: "standalone"`, `src/` dir, depends on `@protoloom/ui`, `@protoloom/core`, `@protoloom/db`), `src/server/env.ts` (zod-validated env), `src/server/context.ts`, `src/server/auth.ts`, `src/app/api/auth/[...all]/route.ts`, `src/server/principal.ts`, `src/server/bootstrap.ts`, `src/server/scheduler.ts`, `src/instrumentation.ts`
- Test: `apps/web/src/server/principal.test.ts`, `apps/web/src/server/bootstrap.test.ts`

**Interfaces:**
- Produces:
  - `getServerContext(): { db: Db; blobs: BlobStore; registry: Registry; auth: Auth }` (lazy singletons)
  - `auth`: Better Auth with the drizzle adapter, `emailAndPassword: { enabled: true, disableSignUp: true }`, plugins `admin({ defaultRole: "viewer", adminRoles: ["admin"] })` with roles `admin | maintainer | viewer`, and `apiKey({ rateLimit: { enabled: false }, enableMetadata: true })`. Rate limiting is off so Gradle builds aren't throttled.
  - `getPrincipal(req: Request): Promise<Principal>`. A `Bearer` header goes through `auth.api.verifyApiKey`. An invalid, expired or revoked key throws `RegistryError("unauthorized")`, and so does a banned owner. Otherwise the owner's current role is loaded together with the `apiKeyPermission` rows. Without a bearer, the session cookie gives a user principal, and with neither the result is anonymous.
  - `bootstrapAdmin(): Promise<void>`: when the user table is empty and both `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, it creates that user with role `admin`.
  - `startScheduler()`: `croner` at `0 3 * * *` calls `runAllCleanups`.
  - `instrumentation.ts` `register()`: only when `NEXT_RUNTIME === "nodejs"`, it runs `migrate`, then `bootstrapAdmin`, then `startScheduler`.

- [ ] **Step 1: Write failing tests** against `startTestDb` with the auth instance built from the test db:
  - No header returns anonymous.
  - A valid key for a maintainer returns `{kind:"apikey", role:"maintainer", permissions:[...]}`.
  - Garbage, expired and revoked keys throw `unauthorized`.
  - Changing the owner's role to viewer makes the next `getPrincipal` return `role: "viewer"` (Review Focus 3).
  - A banned owner throws `unauthorized`.
  - `bootstrapAdmin` creates exactly one admin and is a no-op on the second call.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Check the installed Better Auth version's docs for the exact API key plugin import path and method names before writing the code.
- [ ] **Step 4:** Run the tests and `pnpm --filter web build`. Expected: PASS. Commit with `feat(web): add auth, principal resolution and scheduler`.

### Task 13: REST API `/api/v1`

**Files:**
- Create: `apps/web/src/server/http.ts` (`handle(fn)`: maps `RegistryError` to the error body/status and unknown errors to 500 with a generic message), and these route handlers:
  - `src/app/api/v1/repos/[repo]/artifacts/[group]/[name]/route.ts` (GET list versions)
  - `.../[group]/[name]/[version]/route.ts` (PUT publish, GET manifest, DELETE delete)
  - `.../[version]/archive/route.ts` (GET download)
  - `src/app/api/v1/resolve/route.ts` (POST)
- Test: `apps/web/src/app/api/v1/api.test.ts` (calls the exported handlers with `new Request(...)` against a test db)

**Interfaces:**
- Consumes: `getPrincipal`, `Registry`.
- Produces (the Gradle plugin and the CLI rely on these exactly):
  - `PUT` publish: `multipart/form-data` with field `manifest` (JSON string, `Manifest`) and field `archive` (file, tar.gz); query `?force=true` is optional. Responses: `201` with `{ coordinate: "g:n:v", buildNumber, sha256, redeployed }`, or an error. The URL's group/name/version must equal the manifest's, otherwise `invalid_request`. A `Content-Length` over `LIMITS.archiveBytes + 64 KiB` gets `413`.
  - `GET` list: `200` with `{ versions: [{ version, isSnapshot, latestBuild, updatedAt }] }`.
  - `GET` manifest: `200` with `VersionInfo` as JSON (coordinate formatted as string, dates in ISO format).
  - `GET` archive: `200`, `content-type: application/gzip`, header `x-protoloom-sha256`, body = bytes.
  - `DELETE`: `204`; query `?force=true` is optional.
  - `POST /api/v1/resolve`: body `{ repositories: string[], dependencies: string[] }`, response `200` with `{ artifacts: [{ repository, coordinate: "g:n:v", group, name, version, buildNumber, sha256, archiveUrl }], conflicts: Conflict[] }`. `archiveUrl` is absolute, built from `BETTER_AUTH_URL`, and points at the archive route.

- [ ] **Step 1: Write failing tests:**
  - Publish 201, then list includes the version, the manifest has the files, and the archive has a matching `x-protoloom-sha256`.
  - Publishing again gives 409 with `error.code === "immutable"`.
  - Publishing without a token to a private repo gives 401. With a read-only key it gives 403.
  - A URL/manifest mismatch gives 400.
  - Resolve returns the transitive artifacts with archive URLs.
  - DELETE with dependents gives 409 `has_dependents`; with `?force=true` as an admin key it gives 204.
  - An unknown repository gives 404.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Set `export const runtime = "nodejs"` and `dynamic = "force-dynamic"` on every route.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(web): add registry REST api`.

### Task 14: tRPC routers

**Files:**
- Create: `apps/web/src/server/trpc/init.ts`, `apps/web/src/server/trpc/root.ts`, routers `repositories.ts`, `browse.ts`, `keys.ts`, `users.ts`, `settings.ts`, `audit.ts`, `policies.ts`, `dashboard.ts`; `src/app/api/trpc/[trpc]/route.ts`; `src/trpc/client.tsx` (React provider) and `src/trpc/server.ts` (RSC caller)
- Test: `apps/web/src/server/trpc/routers.test.ts` (uses `appRouter.createCaller(ctx)`)

**Interfaces:**
- Produces:
  - Context: `{ db, registry, principal: Principal, settings: ServerSettings }`.
  - Procedures:
    - `browseProcedure`: anonymous is allowed only when `settings.anonymousView` is on, and then sees public repositories only; otherwise `UNAUTHORIZED`.
    - `authedProcedure`: a user principal.
    - `maintainerProcedure`: role maintainer or admin.
    - `adminProcedure`: role admin.
  - Routers:
    - `browse`: `repositories()`, `search({ query, limit≤20 })` (case-insensitive match on group, name or `group:name` across all repositories the caller can browse; returns `{ repository, group, name, latestVersion }[]`, used by the command dialog), `artifacts({repository, search?})`, `versions({repository, group, name})`, `version({repository, coordinate})` (returns `VersionInfo` plus `dependents`), `file({repository, coordinate, path})`
    - `repositories` (admin): `list`, `get`, `create`, `update`, `delete`. Delete is allowed only when the repository has no artifacts, otherwise `PRECONDITION_FAILED`.
    - `policies` (admin): `list({repository})`, `upsert`, `delete`, `preview({repository})` (returns `planCleanup`), `runNow({repository})` (returns `applyCleanup`)
    - `keys` (authed): `list` (own keys; admins can pass `all: true`), `create({ name, expiresInDays?: number, permissions: KeyPermission[] })` (returns `{ id, key }`; this is the only time the secret is returned), `revoke({ id })` (own keys, or any key for admins). `create` rejects `write` entries for a viewer with `FORBIDDEN`, and rejects unknown repository names.
    - `users` (admin): `list`, `create({ email, name, password, role })`, `setRole`, `ban`, `unban`, `remove`, `resetPassword`. Every one is audited. The last remaining admin can't be demoted, banned or removed.
    - `settings`: `get` (any caller, returns only `anonymousView`), `update` (admin)
    - `audit` (admin): `list({ cursor?, limit≤100, action? })`
    - `dashboard` (browse): `stats()` returning `{ repositories, artifacts, versions, recentPublishes: [...] }`, scoped to what the caller can see
    - `versions` (maintainer): `delete({ repository, coordinate, force? })` (delegates to `registry.deleteVersion`)

- [ ] **Step 1: Write failing tests:**
  - Anonymous `browse.repositories` with `anonymousView` off throws `UNAUTHORIZED`. With it on, the result lists only public repos (Review Focus 5).
  - Anonymous `browse.version` for a private repo throws `NOT_FOUND`.
  - A viewer calling `keys.create` with a write entry throws `FORBIDDEN`. A maintainer gets back a key string starting with Better Auth's prefix, and a later `keys.list` result doesn't contain the secret.
  - A viewer calling `repositories.create` throws `FORBIDDEN`.
  - Demoting the last admin throws `PRECONDITION_FAILED`.
  - `policies.preview` returns candidates without deleting anything.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. Commit with `feat(web): add trpc routers`.

### Task 15: UI shell, login, dashboard, browse

**Depends on:** Tasks 2a and 14. It can start before 2b is finished, because it only uses tokens and never hard-coded colors.

**Files:**
- Create: `apps/web/src/app/layout.tsx` (imports `@protoloom/ui/globals.css`, wraps everything in `ThemeProvider` from `@protoloom/ui` (next-themes, light/dark/system), with `suppressHydrationWarning` on `<html>`), `src/components/command-menu.tsx`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx` (sidebar shell using `@protoloom/ui` `Sidebar`, `Logo`, user menu; nav items filtered by role; anonymous visitors see Browse only plus a "Sign in" button), `src/app/(app)/page.tsx` (dashboard), `src/app/(app)/browse/[repo]/page.tsx`, `src/app/(app)/browse/[repo]/[group]/[name]/page.tsx`, `src/app/(app)/browse/[repo]/[group]/[name]/[version]/page.tsx`, `src/components/proto-viewer.tsx` (shiki `proto` grammar, themes that follow light/dark), `src/components/usage-snippet.tsx`, `src/middleware.ts` (cookie presence check only)

**Interfaces:**
- Consumes: the tRPC routers from Task 14.
- Gating: `(app)/layout.tsx` loads the principal and settings server-side. Anonymous visitors with `anonymousView` off are redirected to `/login?next=…`. With it on, pages other than `/browse/*` and `/` redirect to `/login`.
- The version page shows, as tabs or sections:
  - **Files:** a file tree on the left, the viewer on the right.
  - **Dependencies:** links to each dependency.
  - **Dependents.**
  - **Builds:** snapshots only.
  - **Details:** sha256 with copy, publisher, downloads, created.
  - **Usage:** a Gradle `protoloom("g:n:v")` snippet and a `protoloom.json` snippet.
  - A **delete** button for maintainers, which opens a dialog. On `has_dependents` the dialog lists the dependents, and admins get "Delete anyway", which requires typing the coordinate.

- **Command dialog** (`command-menu.tsx`, mounted in `(app)/layout.tsx`): `Ctrl+K` / `Cmd+K` toggles it (shadcn `CommandDialog`), and so does a "Search… Ctrl K" button in the sidebar header. It has these groups:
  - **Artifacts:** live results from `browse.search` (debounced 150 ms, shown once at least 2 characters are typed). Enter opens the artifact page.
  - **Go to:** Dashboard, Browse, Repositories, API keys, Users, Settings, Audit log. Filtered by role; anonymous visitors see only Dashboard and Browse.
  - **Actions:** "Create API key" (opens `/keys?create=1`, which opens the dialog), "Create repository" (admin), "Copy coordinate" (only on a version page, copies `g:n:v`), "Copy Gradle snippet" (version page), and "Theme: Light / Dark / System".
  - **Account:** "Sign out", or "Sign in" when anonymous.

  The dialog is the same on every page. Page-specific actions come from a small React context (`useCommandActions(actions)`) that a page registers on mount.
- [ ] **Step 1: Write a failing Playwright test** in `e2e/browse.spec.ts`. It starts the app with a seeded db through Playwright `webServer` and a `globalSetup` that uses `startTestDb`, seeds the admin and publishes a fixture artifact through `registry.publish`. The test:
  - visits `/` anonymously and expects a redirect to `/login`
  - logs in as admin and opens the version page
  - expects the file tree to contain `money.proto` and the viewer to show `message Money`
  - expects the Usage tab to contain `protoloom("dev.example:demo:1.0.0")`
  - expects `getComputedStyle(button).cursor === "pointer"` for the first sidebar link and the delete button
  - presses `Control+K`, types `demo`, expects an option `dev.example:demo` and presses Enter, which lands on the artifact page. Presses `Control+K` again, picks "Theme: Dark", and expects `<html>` to have class `dark`.
- [ ] **Step 2:** Run `pnpm --filter web e2e browse`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the e2e test. Expected: PASS. Commit with `feat(web): add app shell, login and artifact browser`.

### Task 16: Management UI: repositories, policies, keys, users, settings, audit

**Depends on:** Task 15.

**Files:**
- Create: `src/app/(app)/repositories/page.tsx`, `repositories/new/page.tsx`, `repositories/[repo]/settings/page.tsx` (General form: description, visibility, allow redeploy, accept releases/snapshots, resolution priority; a Cleanup policies section: table + add/edit dialog, a Preview button that shows candidates in a dialog, a Run now button with confirmation), `src/app/(app)/keys/page.tsx` (table: name, permissions summary, expiry, last used, revoke; Create dialog with a permission row editor — repository select, group prefix input, access select limited by role — and a one-time secret display with copy and the warning "You won't see this key again"), `src/app/(app)/admin/users/page.tsx`, `admin/settings/page.tsx` (an "Allow anonymous view" switch with a description), `admin/audit/page.tsx` (infinite table, action filter)
- Test: `apps/web/e2e/manage.spec.ts`

- [ ] **Step 1: Write a failing Playwright test:**
  - Admin creates a repo `team-private` (private), then creates a key with write on `team-private`. The secret is visible once. After closing the dialog and reloading, the secret text doesn't appear anywhere on the page.
  - Toggling anonymous view on lets a fresh browser context visit `/browse/public-repo` without logging in, and `team-private` isn't listed.
  - Admin creates a viewer user. Logged in as that viewer, the Users and Settings nav items are absent, and the key dialog's access select offers only `read`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. Forms use `@protoloom/ui` `Form` with zod, and toasts use `sonner`.
- [ ] **Step 4:** Run it. Expected: PASS. Commit with `feat(web): add management screens`.

### Task 17: Node CLI

**Files:**
- Create: `packages/cli/package.json` (name `protoloom`, `bin: { protoloom: "dist/index.js" }`, built with tsup), `src/index.ts`, `src/config.ts`, `src/client.ts`, `src/fetch.ts`
- Test: `packages/cli/src/fetch.test.ts` (a `node:http` stub server implementing `/api/v1/resolve` and the archive route)

**Interfaces:**
- Consumes: the REST contract from Task 13, and `packArchive`/`extractArchive` from `@protoloom/core` (bundled by tsup).
- Produces:
  - `protoloom fetch [--config protoloom.json] [--out <dir>]`
  - Config zod schema `{ url?: string, repositories: string[], dependencies: string[], outDir?: string }`. `PROTOLOOM_URL` overrides `url`, and one of the two is required. `PROTOLOOM_TOKEN` is optional; when present it's sent as Bearer.
  - `fetchProtos(opts: { url; token?; repositories; dependencies; outDir; cacheDir }): Promise<{ artifacts: number; files: number }>`
  - Cache: `cacheDir` defaults to `node_modules/.cache/protoloom`, falling back to `~/.cache/protoloom`. Archives are stored as `<sha256>.tar.gz` and reused when present.

- [ ] **Step 1: Write failing tests:**
  - Two resolved artifacts get written to `outDir` with their paths intact.
  - Stale files in `outDir` from a previous run are removed.
  - A second run with an unchanged sha makes no archive request (the stub counts requests).
  - An archive whose sha doesn't match `x-protoloom-sha256` or the resolve's `sha256` fails with a message naming the coordinate.
  - Two artifacts with the same path fail and name both.
  - A 401 from the server prints `error.message` and exits with code 1.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Write into `outDir.tmp`, then rename over `outDir`.
- [ ] **Step 4:** Run the tests and `pnpm --filter protoloom build`, then `node packages/cli/dist/index.js --help`. Expected: PASS, and the help lists `fetch`. Commit with `feat(cli): add protoloom fetch`.

### Task 18: Gradle plugin: remote publish and fetch

**Files:**
- Create: `gradle-plugin/settings.gradle.kts`, `gradle-plugin/build.gradle.kts` (plugin id `dev.protoloom`, implementation class `dev.protoloom.gradle.ProtoloomPlugin`, `maven-publish` with the repository URL and credentials from `PUBLISH_URL`, `PUBLISH_USERNAME` and `PUBLISH_PASSWORD`), the Gradle wrapper (latest stable), and `src/main/kotlin/dev/protoloom/gradle/`:
  - `ProtoloomExtension.kt`: `url: Property<String>` (convention: env `PROTOLOOM_URL`), `token: Property<String>` (convention: env `PROTOLOOM_TOKEN`), `repositories(vararg names)`: `ListProperty<String>`, and `publishing {}` → `PublishingSpec { repository; snapshotRepository (optional, used when the version ends with -SNAPSHOT); group; name; version (convention: project.version); source: DirectoryProperty (convention src/main/proto) }`
  - `ProtoloomClient.kt` (java.net.http + kotlinx.serialization): `resolve`, `download`, `publish`, which map the error body to `GradleException("<code>: <message>")`
  - `FetchProtosTask.kt` (output `build/protoloom/protos`, `upToDateWhen { false }`, cache in `<gradleUserHome>/caches/protoloom/<sha256>.tar.gz`, extraction via `project.tarTree` equivalent `ArchiveOperations.tarTree(resources.gzip(file))`)
  - `PublishProtosTask.kt` (packs `source` with only `**/*.proto` into tar.gz, deterministic: `isPreserveFileTimestamps = false`, `isReproducibleFileOrder = true`; builds the manifest; PUT)
  - `ProtoloomPlugin.kt` (creates the `protoloom` configuration and the tasks `fetchProtos` and `publishProtos` in group `protoloom`)
- Test: `gradle-plugin/src/test/kotlin/dev/protoloom/gradle/RemoteTest.kt` (TestKit + a `com.sun.net.httpserver.HttpServer` stub)

**Interfaces:**
- Consumes: the REST contract from Task 13.
- Produces: `FetchProtosTask.outputDir: DirectoryProperty`, exposed as `protoloom.protosDir` (a `Provider<Directory>`) so other plugins (surf-tide) can wire `fetchProtos` in as a task dependency through the provider.

- [ ] **Step 1: Write failing TestKit tests:**
  - With `protoloom("dev.example:a:1.0.0")`, `fetchProtos` sends a resolve body `{repositories:["releases"], dependencies:["dev.example:a:1.0.0"]}` (asserted in the stub), and `build/protoloom/protos/a/v1/a.proto` exists.
  - A second run downloads nothing new (the stub counts).
  - `publishProtos` sends multipart with a manifest whose `dependencies == ["dev.example:a:1.0.0"]` and an archive containing only the `.proto` files.
  - With a `-SNAPSHOT` version and `snapshotRepository = "snapshots"`, it PUTs to `/repos/snapshots/...`.
  - A 409 response fails the build with output containing `immutable:`.
  - A missing URL fails with a message naming `PROTOLOOM_URL`.
- [ ] **Step 2:** Run `cd gradle-plugin && ./gradlew test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the plugin compatible with the configuration cache (no `project` access at execution time) and test with `--configuration-cache`.
- [ ] **Step 4:** Run `./gradlew test`. Expected: PASS. Commit with `feat(gradle): add protoloom plugin with publish and fetch`.

### Task 19: Gradle plugin: local module dependencies

**Files:**
- Create: `gradle-plugin/src/main/kotlin/dev/protoloom/gradle/LocalModules.kt`, `LocalManifestTask.kt`
- Modify: `ProtoloomPlugin.kt`, `FetchProtosTask.kt`, `PublishProtosTask.kt`
- Test: `gradle-plugin/src/test/kotlin/dev/protoloom/gradle/LocalModulesTest.kt`

**Interfaces:**
- Design:
  - Attribute `Usage` = `"protoloom-protos"`.
  - Configuration `protoloomLocalApi` (dependency scope). The plugin mirrors every `ProjectDependency` added to `protoloom` into it via `protoloom.dependencies.withType<ProjectDependency>().all { … }`.
  - Consumable `protoloomElements` (extends `protoloomLocalApi`) exposes two artifacts with `artifactType` `protoloom-source` (the `publishing.source` dir) and `protoloom-manifest` (a JSON file from `LocalManifestTask`: `{ "coordinate": "g:n:v" | null, "external": ["g:n:v", ...] }`, where `external` holds this module's direct external `protoloom` deps).
  - Resolvable `protoloomLocalClasspath` (extends `protoloomLocalApi`) with artifact views selecting each `artifactType`.
  - **Fetch:** the external roots are the module's own direct externals plus the `external` lists of all resolved local manifests, sent in one `/resolve`. Local source dirs and remote archives go into the same output dir. Duplicate paths fail with `GradleException` naming both origins.
  - **Publish:** the manifest dependencies are the direct externals plus, for each direct project dependency, its manifest `coordinate`. A `null` coordinate fails with "Module :x has no protoloom.publishing block".

- [ ] **Step 1: Write failing TestKit tests** on a multi-project build: `:contracts` has `a.proto` and `protoloom("dev.example:remote:1.0.0")`, and `:service` has `protoloom(project(":contracts"))`.
  - `:service:fetchProtos` output contains `a.proto` from contracts plus the remote files, and the stub received `dependencies:["dev.example:remote:1.0.0"]`.
  - After editing `contracts/src/main/proto/a.proto`, re-running shows the new content.
  - `:service:publishProtos` manifest dependencies include `dev.example:contracts:1.0.0`.
  - `:contracts` without a publishing block makes `:service:publishProtos` fail with the message above.
  - A duplicate path between local and remote fails.
  - Everything is also run with `--configuration-cache`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `./gradlew test`. Expected: PASS. Commit with `feat(gradle): support local module proto dependencies`.

### Task 20: Docker image and end-to-end smoke test

**Files:**
- Create: `docker/Dockerfile` (multi-stage: `node:22-bookworm-slim` with pnpm via corepack, `turbo prune web --docker`, install, build; the runtime copies the Next standalone output, `.next/static`, `public`, the `@bufbuild/buf` binary package, the `packages/db/drizzle` migrations and a compiled `migrate` script; runs as a non-root user; `EXPOSE 3000`; `HEALTHCHECK` on `/api/health`), `docker/entrypoint.sh`, `apps/web/src/app/api/health/route.ts` (returns `{ ok: true }` after a `select 1`), `docker-compose.prod.yml` (app + postgres, with commented S3 env vars), `scripts/e2e-smoke.sh`, `README.md` (run, configure, Gradle/CLI usage)

- [ ] **Step 1: Write the smoke script.** It runs:
  1. `docker compose -f docker-compose.prod.yml up -d --build` and waits for health.
  2. Creates a key through the API: logs in with `ADMIN_EMAIL`/`ADMIN_PASSWORD` via Better Auth's sign-in endpoint and calls tRPC `keys.create`, or uses a seed script.
  3. Creates a `releases` repo through tRPC.
  4. Runs a sample Gradle build in `scripts/fixtures/gradle-sample` (using the plugin from `gradle-plugin` via `includeBuild`) with `publishProtos`.
  5. Runs `node packages/cli/dist/index.js fetch` in `scripts/fixtures/node-sample`.
  6. Asserts the expected `.proto` file exists.
- [ ] **Step 2:** Run `bash scripts/e2e-smoke.sh`. Expected: it fails before the Dockerfile exists.
- [ ] **Step 3:** Write the Dockerfile, the entrypoint (`node migrate.js && exec node apps/web/server.js`) and the health route.
- [ ] **Step 4:** Run `bash scripts/e2e-smoke.sh`. Expected: it ends with `SMOKE OK`. Commit with `build: add docker image and e2e smoke test`.

---

## Execution order and parallelism

- Task 1 runs first.
- Then these run in parallel: 2a, 3, 4, 5, 6, 7, 9 and 18. The Gradle plugin only needs the REST contract written in Task 13's Interfaces.
- 8 after 4. 10 after 3–9. 11 after 10. 12 after 6 + 10 + 11. 13 after 12. 14 after 12. 17 after 4 (stub-based). 19 after 18.
- 15 after 2a + 14. 16 after 15. 2b after the user's design choice, and it can land any time before the final review. 20 last.
