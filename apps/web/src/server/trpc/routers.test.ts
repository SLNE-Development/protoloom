import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { ValkeyContainer, type StartedValkeyContainer } from "@testcontainers/valkey";
import { eq, sql } from "drizzle-orm";
import {
  createLocalStore,
  createRegistry,
  packArchive,
  type Principal,
  type ProtoFile,
  type Registry,
  type Role,
} from "@weaver/core";
import { apikey, apiKeyPermission, auditEvent, build, cleanupPolicy, invite, session, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createQueue, producerConnection, type CleanupQueue } from "@weaver/jobs";
import { createAuth, type Auth, type AuthEnv } from "../auth";
import { API_KEY_PREFIX } from "./routers/keys";
import { appRouter, createCaller } from "./root";
import { createTrpcContext, INTERNAL_ERROR_MESSAGE, type TrpcContext } from "./init";

const BASE = "http://localhost:3000";

const authEnv: AuthEnv = {
  BETTER_AUTH_SECRET: "trpc-test-secret-trpc-test-secret-012345",
  BETTER_AUTH_URL: BASE,
  INITIAL_ADMIN: undefined,
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;
let auth: Auth;
let registry: Registry;
let blobDir: string;
let valkey: StartedValkeyContainer;
let liveQueue: CleanupQueue;
let deadQueue: CleanupQueue;

const people = { admin: "", maintainer: "", viewer: "" };

const anonymous: Principal = { kind: "anonymous" };
const asUser = (userId: string, role: Role): Principal => ({ kind: "user", userId, role });
const admin = () => asUser(people.admin, "admin");
const maintainer = () => asUser(people.maintainer, "maintainer");
const viewer = () => asUser(people.viewer, "viewer");

/** A publishing key principal with write access to both fixture repositories. */
const publisher = (): Principal => ({
  kind: "apikey",
  keyId: "fixture-key",
  userId: people.maintainer,
  role: "admin",
  permissions: [
    { repository: "shared", groupPrefix: null, access: "write" },
    { repository: "internal", groupPrefix: null, access: "write" },
  ],
});

function contextFor(principal: Principal, overrides: Partial<TrpcContext> = {}): TrpcContext {
  return {
    db,
    registry,
    auth,
    principal,
    settings: { anonymousView: false },
    publicUrl: BASE,
    cleanupQueue: () => liveQueue,
    ...overrides,
  };
}

function call(principal: Principal, overrides: Partial<TrpcContext> = {}) {
  return createCaller(contextFor(principal, overrides));
}

const anonymousViewOn = { settings: { anonymousView: true } };

async function createUser(role: string, name = `${role} user`) {
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name, email: `${randomUUID()}@example.com`, role, createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";`).join("\n");
  return { path, content: `syntax = "proto3";\npackage ${pkg};\n${importLines}\n${body}\n` };
}

const moneyFiles = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }")];
const orderFiles = [
  proto("acme/order/v1/order.proto", "message Order { acme.money.v1.Money total = 1; }", ["acme/money/v1/money.proto"]),
];

async function publish(repository: string, coordinate: string, files: ProtoFile[], dependencies: string[] = []) {
  const [group, name, version] = coordinate.split(":") as [string, string, string];
  await registry.publish(publisher(), {
    repository,
    manifest: { group, name, version, dependencies },
    archive: await packArchive(files),
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

beforeAll(async () => {
  [testDb, valkey] = await Promise.all([startTestDb(), new ValkeyContainer("valkey/valkey:9.1.2-alpine").start()]);
  db = testDb.db;
  auth = createAuth(db, authEnv);
  blobDir = await mkdtemp(join(tmpdir(), "weaver-trpc-"));
  registry = createRegistry({ db, blobs: createLocalStore(blobDir) });
  liveQueue = createQueue(producerConnection(valkey.getConnectionUrl()));
  deadQueue = createQueue(producerConnection("redis://127.0.0.1:1"), { onError: () => undefined });
});

afterAll(async () => {
  await Promise.all([liveQueue?.close(), deadQueue?.close().catch(() => undefined)]);
  await testDb?.stop();
  await valkey?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE repository, audit_event, invite, apikey, "user" CASCADE`);
  people.admin = (await createUser("admin", "Ada Admin")).id;
  people.maintainer = (await createUser("maintainer", "Max Maintainer")).id;
  people.viewer = (await createUser("viewer", "Vic Viewer")).id;
  await call(admin()).repositories.create({ name: "shared", visibility: "public", description: "Public contracts" });
  await call(admin()).repositories.create({ name: "internal", visibility: "private" });
});

describe("createTrpcContext", () => {
  it("builds an anonymous context with the stored settings and the public URL", async () => {
    await call(admin()).settings.update({ anonymousView: true });
    const ctx = await createTrpcContext({ headers: new Headers() }, { db, registry, auth });
    expect(ctx.principal).toEqual({ kind: "anonymous" });
    expect(ctx.settings).toEqual({ anonymousView: true });
    expect(ctx.publicUrl).toBe(BASE);
    await call(admin()).settings.update({ anonymousView: false });
  });

  it("refuses invalid credentials with UNAUTHORIZED", async () => {
    const context = createTrpcContext({ headers: new Headers({ authorization: "Bearer nope" }) }, { db, registry, auth });
    const error = await context.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("UNAUTHORIZED");
  });
});

describe("procedures", () => {
  it("refuses anonymous browsing while anonymous view is off", async () => {
    expect(await codeOf(call(anonymous).browse.repositories())).toBe("UNAUTHORIZED");
  });

  it("lets anonymous visitors browse only public repositories while anonymous view is on", async () => {
    const repos = await call(anonymous, anonymousViewOn).browse.repositories();
    expect(repos.map((r) => r.name)).toEqual(["shared"]);
    const all = await call(viewer()).browse.repositories();
    expect(all.map((r) => r.name)).toEqual(["internal", "shared"]);
  });

  it("requires a signed-in user for authed procedures and the role for maintainer and admin ones", async () => {
    expect(await codeOf(call(anonymous, anonymousViewOn).keys.list())).toBe("UNAUTHORIZED");
    expect(await codeOf(call(viewer()).repositories.create({ name: "mine", visibility: "private" }))).toBe("FORBIDDEN");
    expect(await codeOf(call(viewer()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0" }))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(call(maintainer()).users.list())).toBe("FORBIDDEN");
  });

  it("formats registry errors with their code and details over HTTP", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    await publish("shared", "acme:order:1.0.0", orderFiles, ["acme:money:1.0.0"]);
    const res = await fetchRequestHandler({
      endpoint: "/api/trpc",
      router: appRouter,
      req: new Request(`${BASE}/api/trpc/versions.delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { repository: "shared", coordinate: "acme:money:1.0.0" } }),
      }),
      createContext: () => contextFor(maintainer()),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { json: { data: Record<string, unknown> } } };
    expect(body.error.json.data).toMatchObject({
      code: "CONFLICT",
      registry: {
        code: "has_dependents",
        details: { dependents: [{ repository: "shared", coordinate: "acme:order:1.0.0" }], hiddenDependents: 0 },
      },
    });
  });
});

describe("browse", () => {
  beforeEach(async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    await publish("shared", "acme:money:1.1.0", moneyFiles);
    await publish("shared", "acme:order:1.0.0", orderFiles, ["acme:money:1.0.0"]);
    await publish("internal", "corp.secret:vault:2.0.0", moneyFiles);
  });

  it("hides a private repository's versions from anonymous visitors as not found", async () => {
    const caller = call(anonymous, anonymousViewOn);
    expect(await codeOf(caller.browse.version({ repository: "internal", coordinate: "corp.secret:vault:2.0.0" }))).toBe(
      "NOT_FOUND",
    );
    expect(await codeOf(caller.browse.artifacts({ repository: "internal" }))).toBe("NOT_FOUND");
  });

  it("returns a version with string coordinates and its readable dependents", async () => {
    const info = await call(anonymous, anonymousViewOn).browse.version({
      repository: "shared",
      coordinate: "acme:money:1.0.0",
    });
    expect(info).toMatchObject({
      repository: "shared",
      coordinate: "acme:money:1.0.0",
      buildNumber: 1,
      dependencies: [],
      files: ["acme/money/v1/money.proto"],
      dependents: [{ repository: "shared", coordinate: "acme:order:1.0.0" }],
    });
    expect(info.createdAt).toBeInstanceOf(Date);
    const order = await call(viewer()).browse.version({ repository: "shared", coordinate: "acme:order:1.0.0" });
    expect(order.dependencies).toEqual(["acme:money:1.0.0"]);
  });

  it("rejects a malformed coordinate as a bad request", async () => {
    expect(await codeOf(call(viewer()).browse.version({ repository: "shared", coordinate: "nope" }))).toBe("BAD_REQUEST");
  });

  it("lists artifacts and versions, and serves files", async () => {
    const caller = call(viewer());
    expect(await caller.browse.artifacts({ repository: "shared" })).toEqual([
      { group: "acme", name: "money", latestVersion: "1.1.0", versionCount: 2, updatedAt: expect.any(Date) },
      { group: "acme", name: "order", latestVersion: "1.0.0", versionCount: 1, updatedAt: expect.any(Date) },
    ]);
    expect((await caller.browse.artifacts({ repository: "shared", search: "ORD" })).map((a) => a.name)).toEqual(["order"]);
    const versions = await caller.browse.versions({ repository: "shared", group: "acme", name: "money" });
    expect(versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    const file = await caller.browse.file({
      repository: "shared",
      coordinate: "acme:money:1.0.0",
      path: "acme/money/v1/money.proto",
    });
    expect(file.content).toContain("message Money");
  });

  it("searches group, name and group:name case-insensitively across browsable repositories", async () => {
    const byName = await call(viewer()).browse.search({ query: "MONEY" });
    expect(byName).toEqual([{ repository: "shared", group: "acme", name: "money", latestVersion: "1.1.0" }]);
    const byCoordinate = await call(viewer()).browse.search({ query: "acme:ord" });
    expect(byCoordinate.map((r) => r.name)).toEqual(["order"]);
    const byGroup = await call(viewer()).browse.search({ query: "corp.SEC" });
    expect(byGroup).toEqual([{ repository: "internal", group: "corp.secret", name: "vault", latestVersion: "2.0.0" }]);
    expect(await call(anonymous, anonymousViewOn).browse.search({ query: "vault" })).toEqual([]);
    expect(await call(viewer()).browse.search({ query: "a", limit: 1 })).toHaveLength(1);
    expect(await call(viewer()).browse.search({ query: "100%_" })).toEqual([]);
  });

  it("scopes dashboard stats to what the caller can see", async () => {
    const all = await call(viewer()).dashboard.stats();
    expect(all).toMatchObject({ repositories: 2, artifacts: 3, versions: 4 });
    expect(all.recentPublishes[0]).toMatchObject({ repository: "internal", coordinate: "corp.secret:vault:2.0.0" });
    const visible = await call(anonymous, anonymousViewOn).dashboard.stats();
    expect(visible).toMatchObject({ repositories: 1, artifacts: 2, versions: 3 });
    expect(visible.recentPublishes.map((p) => p.repository)).not.toContain("internal");
  });

  it("shows the publisher's name, and no raw user id once the user is deleted", async () => {
    const before = await call(viewer()).dashboard.stats();
    expect(before.recentPublishes[0]?.publishedBy).toBe("Max Maintainer");
    const version = { repository: "shared", coordinate: "acme:money:1.0.0" };
    expect((await call(viewer()).browse.version(version)).publishedBy).toBe("Max Maintainer");

    await db.update(build).set({ publishedByUserId: "deleted-user-id" });
    const after = await call(viewer()).dashboard.stats();
    expect(after.recentPublishes.map((p) => p.publishedBy)).toEqual(after.recentPublishes.map(() => null));
    expect((await call(viewer()).browse.version(version)).publishedBy).toBeNull();
  });
});

describe("versions.delete", () => {
  it("deletes through the registry and reports dependents as a conflict", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    await publish("shared", "acme:order:1.0.0", orderFiles, ["acme:money:1.0.0"]);
    expect(await codeOf(call(maintainer()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0" }))).toBe(
      "CONFLICT",
    );
    expect(
      await codeOf(call(maintainer()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0", force: true })),
    ).toBe("FORBIDDEN");
    await call(admin()).versions.delete({ repository: "shared", coordinate: "acme:money:1.0.0", force: true });
    expect(await codeOf(call(admin()).browse.version({ repository: "shared", coordinate: "acme:money:1.0.0" }))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("keys", () => {
  it("refuses write entries for a viewer", async () => {
    const create = call(viewer()).keys.create({
      name: "ci",
      permissions: [{ repository: "shared", groupPrefix: null, access: "write" }],
    });
    expect(await codeOf(create)).toBe("FORBIDDEN");
    expect(await db.select().from(apikey)).toEqual([]);
  });

  it("creates a key once with its secret and never lists the secret", async () => {
    const created = await call(maintainer()).keys.create({
      name: "ci",
      expiresInDays: 30,
      permissions: [
        { repository: "shared", groupPrefix: "acme", access: "write" },
        { repository: "internal", access: "read" },
      ],
    });
    expect(created.key.startsWith(API_KEY_PREFIX)).toBe(true);

    const listed = await call(maintainer()).keys.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: created.id,
      name: "ci",
      userId: people.maintainer,
      ownerName: "Max Maintainer",
      permissions: expect.arrayContaining([
        { repository: "shared", groupPrefix: "acme", access: "write" },
        { repository: "internal", groupPrefix: null, access: "read" },
      ]),
    });
    expect(listed[0]!.expiresAt).toBeInstanceOf(Date);
    expect(JSON.stringify(listed)).not.toContain(created.key);
    expect(listed[0]).not.toHaveProperty("key");

    // The key works against the REST principal resolution with its permissions.
    const verified = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verified.valid).toBe(true);
    const [audit] = await db.select().from(auditEvent).where(eq(auditEvent.action, "key.create"));
    expect(audit).toMatchObject({ actorType: "user", actorId: people.maintainer, target: created.id });
  });

  it("rejects unknown repositories", async () => {
    const create = call(maintainer()).keys.create({
      name: "ci",
      permissions: [{ repository: "ghost", access: "read" }],
    });
    expect(await codeOf(create)).toBe("BAD_REQUEST");
    expect(await db.select().from(apikey)).toEqual([]);
  });

  it("deletes the Better Auth key again when storing its permissions fails", async () => {
    const spy = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("insert failed"));
    try {
      const create = call(maintainer()).keys.create({ name: "ci", permissions: [{ repository: "shared", access: "read" }] });
      await expect(create).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await db.select().from(apikey)).toEqual([]);
  });

  it("lets owners revoke their keys, and admins list and revoke all keys", async () => {
    const own = await call(maintainer()).keys.create({ name: "mine", permissions: [{ repository: "shared", access: "read" }] });
    const other = await call(viewer()).keys.create({ name: "theirs", permissions: [{ repository: "shared", access: "read" }] });

    expect((await call(viewer()).keys.list()).map((k) => k.name)).toEqual(["theirs"]);
    expect(await codeOf(call(viewer()).keys.list({ all: true }))).toBe("FORBIDDEN");
    expect((await call(admin()).keys.list({ all: true })).map((k) => k.name).sort()).toEqual(["mine", "theirs"]);

    expect(await codeOf(call(viewer()).keys.revoke({ id: own.id }))).toBe("NOT_FOUND");
    await call(maintainer()).keys.revoke({ id: own.id });
    await call(admin()).keys.revoke({ id: other.id });
    expect(await db.select().from(apikey)).toEqual([]);
    expect(await db.select().from(apiKeyPermission)).toEqual([]);
  });
});

describe("repositories", () => {
  it("creates, reads, updates and lists repositories, refusing duplicates", async () => {
    const caller = call(admin());
    expect(await codeOf(caller.repositories.create({ name: "shared", visibility: "public" }))).toBe("CONFLICT");
    expect(await codeOf(caller.repositories.create({ name: "Bad Name", visibility: "public" }))).toBe("BAD_REQUEST");
    const updated = await caller.repositories.update({ name: "internal", allowRedeploy: true, resolutionPriority: 5 });
    expect(updated).toMatchObject({ name: "internal", allowRedeploy: true, resolutionPriority: 5, visibility: "private" });
    expect(await caller.repositories.get({ name: "internal" })).toMatchObject({ allowRedeploy: true, artifactCount: 0 });
    expect((await caller.repositories.list()).map((r) => r.name)).toEqual(["internal", "shared"]);
    expect(await codeOf(caller.repositories.get({ name: "ghost" }))).toBe("NOT_FOUND");
    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["repository.create", "repository.update"]));
  });

  it("deletes only repositories without artifacts", async () => {
    await publish("shared", "acme:money:1.0.0", moneyFiles);
    expect(await codeOf(call(admin()).repositories.delete({ name: "shared" }))).toBe("PRECONDITION_FAILED");
    await call(admin()).repositories.delete({ name: "internal" });
    expect((await call(admin()).repositories.list()).map((r) => r.name)).toEqual(["shared"]);
  });
});

describe("policies", () => {
  beforeEach(async () => {
    for (let i = 0; i < 3; i++) await publish("shared", "acme:money:1.0.0-SNAPSHOT", moneyFiles);
  });

  it("previews candidates without deleting anything", async () => {
    const caller = call(admin());
    const policy = await caller.policies.upsert({ repository: "shared", kind: "keep_last_snapshot_builds", value: 1 });
    expect(policy).toMatchObject({ kind: "keep_last_snapshot_builds", value: 1, enabled: true, groupPrefix: null });
    expect(await caller.policies.list({ repository: "shared" })).toHaveLength(1);

    const candidates = await caller.policies.preview({ repository: "shared" });
    expect(candidates).toEqual([
      expect.objectContaining({ repository: "shared", coordinate: "acme:money:1.0.0-SNAPSHOT", buildNumber: 1 }),
      expect.objectContaining({ repository: "shared", coordinate: "acme:money:1.0.0-SNAPSHOT", buildNumber: 2 }),
    ]);
    expect(await db.select().from(build)).toHaveLength(3);
  });

  it("updates and deletes policies", async () => {
    const caller = call(admin());
    const created = await caller.policies.upsert({ repository: "shared", kind: "delete_stale_snapshots", value: 30 });
    const updated = await caller.policies.upsert({
      repository: "shared",
      id: created.id,
      kind: "delete_stale_snapshots",
      value: 60,
      enabled: false,
    });
    expect(updated).toMatchObject({ id: created.id, value: 60, enabled: false });
    await caller.policies.delete({ id: created.id });
    expect(await db.select().from(cleanupPolicy)).toEqual([]);
    expect(await codeOf(caller.policies.delete({ id: created.id }))).toBe("NOT_FOUND");
  });

  it("enqueues a cleanup job with run now and reports its state", async () => {
    const { jobId } = await call(admin()).policies.runNow({ repository: "shared" });
    const status = await call(admin()).policies.job({ jobId });
    expect(status).toEqual({ state: "waiting", result: null, failedReason: null });
    expect(await codeOf(call(admin()).policies.runNow({ repository: "ghost" }))).toBe("NOT_FOUND");
  });

  it("fails fast with a clear error when Valkey is unreachable", async () => {
    const started = Date.now();
    const error = await call(admin(), { cleanupQueue: () => deadQueue })
      .policies.runNow({ repository: "shared" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("SERVICE_UNAVAILABLE");
    expect((error as TRPCError).message).toMatch(/job queue/i);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("reports a missing Valkey configuration", async () => {
    const runNow = call(admin(), { cleanupQueue: () => null }).policies.runNow({ repository: "shared" });
    expect(await codeOf(runNow)).toBe("PRECONDITION_FAILED");
  });
});

describe("invites", () => {
  it("creates a one-time absolute URL, storing only the token hash", async () => {
    const created = await call(admin()).invites.create({ role: "maintainer", expiresInDays: 7, note: "for Bea" });
    expect(created.url).toMatch(new RegExp(`^${BASE}/invite/[A-Za-z0-9_-]{43}$`));
    const token = created.url.split("/").pop()!;
    const [row] = await db.select().from(invite).where(eq(invite.id, created.id));
    expect(row!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);

    const listed = await call(admin()).invites.list();
    expect(listed).toEqual([
      expect.objectContaining({ id: created.id, role: "maintainer", note: "for Bea", status: "open", createdByName: "Ada Admin" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(await codeOf(call(maintainer()).invites.create({ role: "admin", expiresInDays: 1 }))).toBe("FORBIDDEN");
  });

  it("lists used and expired invites and revokes open ones", async () => {
    const used = await call(admin()).invites.create({ role: "viewer", expiresInDays: 1 });
    const expired = await call(admin()).invites.create({ role: "viewer", expiresInDays: 1 });
    const open = await call(admin()).invites.create({ role: "viewer", expiresInDays: 30 });
    await db.update(invite).set({ usedAt: new Date(), usedByUserId: people.viewer }).where(eq(invite.id, used.id));
    await db.update(invite).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invite.id, expired.id));

    const statuses = Object.fromEntries((await call(admin()).invites.list()).map((i) => [i.id, i.status]));
    expect(statuses).toEqual({ [used.id]: "used", [expired.id]: "expired", [open.id]: "open" });

    expect(await codeOf(call(admin()).invites.revoke({ id: used.id }))).toBe("PRECONDITION_FAILED");
    await call(admin()).invites.revoke({ id: open.id });
    expect((await call(admin()).invites.list()).map((i) => i.id).sort()).toEqual([used.id, expired.id].sort());
    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["invite.create", "invite.revoke"]));
  });
});

describe("users", () => {
  it("refuses to demote, ban or remove the last admin", async () => {
    const caller = call(admin());
    expect(await codeOf(caller.users.setRole({ userId: people.admin, role: "maintainer" }))).toBe("PRECONDITION_FAILED");
    // Another caller with admin rights (the stored role is what counts for the last-admin rule).
    const other = call(asUser(people.maintainer, "admin"));
    expect(await codeOf(other.users.ban({ userId: people.admin }))).toBe("PRECONDITION_FAILED");
    expect(await codeOf(other.users.remove({ userId: people.admin }))).toBe("PRECONDITION_FAILED");

    await caller.users.setRole({ userId: people.maintainer, role: "admin" });
    await caller.users.setRole({ userId: people.admin, role: "viewer" });
    const roles = Object.fromEntries((await caller.users.list()).map((u) => [u.id, u.role]));
    expect(roles).toEqual({ [people.admin]: "viewer", [people.maintainer]: "admin", [people.viewer]: "viewer" });
  });

  it("refuses to let admins ban or remove their own account", async () => {
    await call(admin()).users.setRole({ userId: people.maintainer, role: "admin" });
    const self = call(admin());
    const banSelf = self.users.ban({ userId: people.admin });
    await expect(banSelf).rejects.toThrow("You can't ban your own account");
    expect(await codeOf(self.users.ban({ userId: people.admin }))).toBe("FORBIDDEN");
    await expect(self.users.remove({ userId: people.admin })).rejects.toThrow("You can't remove your own account");
    expect(await codeOf(self.users.remove({ userId: people.admin }))).toBe("FORBIDDEN");
    expect((await self.users.list()).find((u) => u.id === people.admin)).toMatchObject({ banned: false, role: "admin" });
  });

  it("bans (ending sessions), unbans and removes users, auditing every change", async () => {
    const authCtx = await auth.$context;
    await authCtx.internalAdapter.createSession(people.viewer);
    const caller = call(admin());

    await caller.users.ban({ userId: people.viewer, reason: "spam" });
    expect(await db.select().from(session).where(eq(session.userId, people.viewer))).toEqual([]);
    expect((await caller.users.list()).find((u) => u.id === people.viewer)).toMatchObject({ banned: true, banReason: "spam" });

    await caller.users.unban({ userId: people.viewer });
    expect((await caller.users.list()).find((u) => u.id === people.viewer)).toMatchObject({ banned: false, banReason: null });

    await call(viewer()).keys.create({ name: "ci", permissions: [{ repository: "shared", access: "read" }] });
    await caller.users.remove({ userId: people.viewer });
    expect((await caller.users.list()).map((u) => u.id)).not.toContain(people.viewer);
    expect(await db.select().from(apikey)).toEqual([]);
    expect(await codeOf(caller.users.remove({ userId: people.viewer }))).toBe("NOT_FOUND");

    const actions = (await db.select({ action: auditEvent.action }).from(auditEvent)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user.ban", "user.unban", "user.remove"]));
  });
});

describe("settings", () => {
  it("returns only the anonymous view flag to anyone and lets admins change it", async () => {
    expect(await call(anonymous).settings.get()).toEqual({ anonymousView: false });
    expect(await codeOf(call(maintainer()).settings.update({ anonymousView: true }))).toBe("FORBIDDEN");
    expect(await call(admin()).settings.update({ anonymousView: true })).toEqual({ anonymousView: true });
    await call(admin()).settings.update({ anonymousView: false });
  });
});

describe("audit", () => {
  it("pages through entries newest first and filters by action", async () => {
    for (let i = 0; i < 5; i++) await call(admin()).invites.create({ role: "viewer", expiresInDays: 1 });
    const caller = call(admin());

    const first = await caller.audit.list({ limit: 3, action: "invite" });
    expect(first.items).toHaveLength(3);
    expect(first.items[0]).toMatchObject({ action: "invite.create", actorType: "user", actorName: "Ada Admin" });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await caller.audit.list({ limit: 3, action: "invite", cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
    const times = [...first.items, ...second.items].map((e) => e.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    expect((await caller.audit.list({ action: "repository.create" })).items).toHaveLength(2);
    expect(await caller.audit.actions()).toEqual(["invite.create", "repository.create"]);
    expect(await codeOf(call(maintainer()).audit.list({}))).toBe("FORBIDDEN");
  });
});

describe("review follow-ups", () => {
  it("drops key scopes of a deleted repository, so a new one with the same name doesn't inherit them", async () => {
    await call(maintainer()).keys.create({
      name: "ci",
      permissions: [
        { repository: "internal", access: "write" },
        { repository: "shared", access: "read" },
      ],
    });
    await call(admin()).repositories.delete({ name: "internal" });
    expect((await db.select().from(apiKeyPermission)).map((p) => p.repository)).toEqual(["shared"]);

    await call(admin()).repositories.create({ name: "internal", visibility: "private" });
    const [key] = await call(maintainer()).keys.list();
    expect(key!.permissions).toEqual([{ repository: "shared", groupPrefix: null, access: "read" }]);
  });

  it("updates only the policy fields that were sent", async () => {
    const caller = call(admin());
    const created = await caller.policies.upsert({
      repository: "shared",
      kind: "delete_not_downloaded",
      value: 30,
      includeReleases: true,
      groupPrefix: "acme",
      enabled: false,
    });
    const updated = await caller.policies.upsert({ repository: "shared", id: created.id, value: 90 });
    expect(updated).toMatchObject({
      kind: "delete_not_downloaded",
      value: 90,
      includeReleases: true,
      groupPrefix: "acme",
      enabled: false,
    });
    expect(await codeOf(caller.policies.upsert({ repository: "shared", kind: "delete_stale_snapshots" }))).toBe("BAD_REQUEST");
  });

  it("audits run now with the job id", async () => {
    const { jobId } = await call(admin()).policies.runNow({ repository: "shared" });
    const entries = await db.select().from(auditEvent).where(eq(auditEvent.action, "policy.runNow"));
    expect(entries).toEqual([
      expect.objectContaining({ actorType: "user", actorId: people.admin, target: "shared", details: { jobId } }),
    ]);
  });

  it("hides the message and stack of unexpected errors from clients and logs them", async () => {
    const failing: Registry = {
      ...registry,
      getManifest: () => Promise.reject(new Error("connect to db.internal:5432 failed, password hunter2")),
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await fetchRequestHandler({
        endpoint: "/api/trpc",
        router: appRouter,
        req: new Request(
          `${BASE}/api/trpc/browse.version?input=${encodeURIComponent(JSON.stringify({ json: { repository: "shared", coordinate: "acme:money:1.0.0" } }))}`,
        ),
        createContext: () => contextFor(viewer(), { registry: failing }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain("hunter2");
      const body = JSON.parse(text) as { error: { json: { message: string; data: Record<string, unknown> } } };
      expect(body.error.json.message).toBe(INTERNAL_ERROR_MESSAGE);
      expect(body.error.json.data).not.toHaveProperty("stack");
      expect(logged).toHaveBeenCalledOnce();
      expect(String(logged.mock.calls[0]?.[1])).toContain("hunter2");
    } finally {
      logged.mockRestore();
    }
  });

  describe("an API key limited to a group prefix", () => {
    const scoped = (): Principal => ({
      kind: "apikey",
      keyId: "scoped-key",
      userId: people.viewer,
      role: "viewer",
      permissions: [{ repository: "internal", groupPrefix: "corp.secret", access: "read" }],
    });

    beforeEach(async () => {
      await publish("shared", "acme:money:1.0.0", moneyFiles);
      await publish("internal", "corp.secret:vault:2.0.0", moneyFiles);
      await publish("internal", "corp.secret:vault:2.1.0", moneyFiles);
      await publish("internal", "corp.other:ledger:1.0.0", moneyFiles);
    });

    it("sees only its groups in repository counts, artifacts, search and the dashboard", async () => {
      const caller = call(scoped());
      const repos = Object.fromEntries((await caller.browse.repositories()).map((r) => [r.name, r]));
      expect(repos.internal).toMatchObject({ artifactCount: 1, versionCount: 2 });
      expect(repos.shared).toMatchObject({ artifactCount: 1, versionCount: 1 });

      expect((await caller.browse.artifacts({ repository: "internal" })).map((a) => a.group)).toEqual(["corp.secret"]);
      expect(await caller.browse.search({ query: "corp" })).toEqual([
        { repository: "internal", group: "corp.secret", name: "vault", latestVersion: "2.1.0" },
      ]);

      const stats = await caller.dashboard.stats();
      expect(stats).toMatchObject({ repositories: 2, artifacts: 2, versions: 3 });
      expect(stats.recentPublishes.map((p) => p.coordinate)).not.toContain("corp.other:ledger:1.0.0");

      const full = Object.fromEntries((await call(viewer()).browse.repositories()).map((r) => [r.name, r]));
      expect(full.internal).toMatchObject({ artifactCount: 2, versionCount: 3 });
    });
  });
});
