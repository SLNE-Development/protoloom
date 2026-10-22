import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditEvent, build, deletedRelease, repository } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { packArchive, type ProtoFile } from "../archive.js";
import type { Coordinate } from "../coordinates.js";
import type { RegistryError } from "../errors.js";
import type { KeyPermission, Principal, Role } from "../permissions.js";
import { createLocalStore, type BlobStore } from "../storage/index.js";
import { validateProtos } from "../validation.js";
import { createRegistry, type Manifest, type Registry } from "./index.js";

const anonymous: Principal = { kind: "anonymous" };

function key(role: Role, permissions: KeyPermission[], keyId = `key-${role}`): Principal {
  return { kind: "apikey", keyId, userId: `user-${role}`, role, permissions };
}

const write = (repo: string): KeyPermission => ({ repository: repo, groupPrefix: null, access: "write" });
const read = (repo: string): KeyPermission => ({ repository: repo, groupPrefix: null, access: "read" });

const maintainer = key("maintainer", [write("releases"), write("snapshots"), read("shared")]);
const admin = key("admin", [write("releases"), write("snapshots")], "key-admin");

const coord = (group: string, name: string, version: string): Coordinate => ({ group, name, version });

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";`).join("\n");
  return { path, content: `syntax = "proto3";\npackage ${pkg};\n${importLines}\n${body}\n` };
}

function manifest(group: string, name: string, version: string, dependencies: string[] = []): Manifest {
  return { group, name, version, dependencies };
}

async function expectError(promise: Promise<unknown>, code: string): Promise<RegistryError> {
  try {
    await promise;
  } catch (error) {
    expect((error as RegistryError).code).toBe(code);
    return error as RegistryError;
  }
  throw new Error(`expected RegistryError ${code}, but the call succeeded`);
}

describe("registry", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let blobs: BlobStore;
  let registry: Registry;

  const moneyFiles = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }")];
  const orderFiles = (v = "Order") => [
    proto(
      "acme/order/v1/order.proto",
      `message ${v} { acme.money.v1.Money total = 1; }`,
      ["acme/money/v1/money.proto"],
    ),
  ];

  async function insertRepo(name: string, values: Partial<typeof repository.$inferInsert> = {}) {
    await testDb.db.insert(repository).values({ name, ...values });
  }

  async function publishMoney(
    principal = maintainer,
    repo = "releases",
    version = "1.0.0",
    files = moneyFiles,
  ) {
    return registry.publish(principal, {
      repository: repo,
      manifest: manifest("acme", "money", version),
      archive: await packArchive(files),
    });
  }

  async function publishOrder(principal = maintainer, repo = "releases", deps = ["acme:money:1.0.0"]) {
    return registry.publish(principal, {
      repository: repo,
      manifest: manifest("acme", "order", "1.0.0", deps),
      archive: await packArchive(orderFiles()),
    });
  }

  async function auditActions(): Promise<{ action: string; forced: boolean; target: string }[]> {
    return testDb.db
      .select({ action: auditEvent.action, forced: auditEvent.forced, target: auditEvent.target })
      .from(auditEvent)
      .orderBy(auditEvent.at);
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-registry-"));
    blobs = createLocalStore(blobDir);
    registry = createRegistry({ db: testDb.db, blobs });
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
    await insertRepo("releases", { allowSnapshots: false });
    await insertRepo("snapshots", { allowReleases: false });
  });

  it("publishes a release as build 1 and exposes files and dependencies", async () => {
    const money = await publishMoney();
    expect(money).toMatchObject({ coordinate: coord("acme", "money", "1.0.0"), buildNumber: 1, redeployed: false });
    expect(money.sha256).toMatch(/^[0-9a-f]{64}$/);

    await publishOrder();
    const info = await registry.getManifest(maintainer, "releases", coord("acme", "order", "1.0.0"));
    expect(info.files).toEqual(["acme/order/v1/order.proto"]);
    expect(info.dependencies).toEqual([coord("acme", "money", "1.0.0")]);
    expect(info.buildNumber).toBe(1);
    // The fixture principal has no user row, as after the publisher was deleted: no raw id leaks.
    expect(info.publishedBy).toBeNull();
    expect(info.builds).toHaveLength(1);

    const file = await registry.getFile(maintainer, "releases", coord("acme", "order", "1.0.0"), "acme/order/v1/order.proto");
    expect(file).toContain("message Order");

    const versions = await registry.listVersions(maintainer, "releases", "acme", "money");
    expect(versions).toEqual([
      expect.objectContaining({ version: "1.0.0", isSnapshot: false, latestBuild: 1 }),
    ]);
  });

  it("publishes and downloads a name containing '..' on local storage", async () => {
    await registry.publish(maintainer, {
      repository: "releases",
      manifest: manifest("acme", "foo..bar", "1.0.0"),
      archive: await packArchive(moneyFiles),
    });
    const downloaded = await registry.download(maintainer, "releases", coord("acme", "foo..bar", "1.0.0"));
    expect(downloaded.filename).toBe("foo..bar-1.0.0.tar.gz");
  });

  it("records the publishing key and user on the build", async () => {
    await publishMoney();
    const [row] = await testDb.db.select().from(build);
    expect(row?.publishedByKeyId).toBe("key-maintainer");
    expect(row?.publishedByUserId).toBe("user-maintainer");
  });

  it("rejects republishing an immutable release and replaces it when redeploy is allowed", async () => {
    await publishMoney();
    await expectError(publishMoney(), "immutable");

    await testDb.db.update(repository).set({ allowRedeploy: true }).where(eq(repository.name, "releases"));
    const [before] = await testDb.db.select().from(build);
    const replaced = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];
    const result = await publishMoney(maintainer, "releases", "1.0.0", replaced);
    expect(result).toMatchObject({ buildNumber: 1, redeployed: true });

    const file = await registry.getFile(maintainer, "releases", coord("acme", "money", "1.0.0"), "acme/money/v1/money.proto");
    expect(file).toContain("currency");
    const builds = await testDb.db.select().from(build);
    expect(builds).toHaveLength(1);
    expect(await blobs.get(before!.storageKey)).toBeNull();
    expect(await blobs.get(builds[0]!.storageKey)).not.toBeNull();
  });

  it("blocks redeploying a release that has dependents unless an admin forces it", async () => {
    await testDb.db.update(repository).set({ allowRedeploy: true }).where(eq(repository.name, "releases"));
    await publishMoney();
    await publishOrder();

    const blocked = await expectError(publishMoney(), "has_dependents");
    expect(blocked.details).toEqual({
      dependents: [{ repository: "releases", coordinate: coord("acme", "order", "1.0.0") }],
      hiddenDependents: 0,
    });

    await expectError(
      registry.publish(maintainer, {
        repository: "releases",
        manifest: manifest("acme", "money", "1.0.0"),
        archive: await packArchive(moneyFiles),
        force: true,
      }),
      "forbidden",
    );

    const forced = await registry.publish(admin, {
      repository: "releases",
      manifest: manifest("acme", "money", "1.0.0"),
      archive: await packArchive(moneyFiles),
      force: true,
    });
    expect(forced.redeployed).toBe(true);
    const audit = await auditActions();
    expect(audit.at(-1)).toMatchObject({ action: "redeploy", forced: true });
  });

  it("creates a new build for every snapshot publish and serves the newest", async () => {
    for (const expected of [1, 2, 3]) {
      const r = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
      expect(r.buildNumber).toBe(expected);
    }
    const info = await registry.getManifest(maintainer, "snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"));
    expect(info.buildNumber).toBe(3);
    expect(info.builds.map((b) => b.buildNumber)).toEqual([1, 2, 3]);
  });

  it("downloads a specific snapshot build on request, and not_found once it is gone", async () => {
    const snapshot = coord("acme", "money", "1.0.0-SNAPSHOT");
    const first = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
    const changed = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];
    const second = await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT", changed);
    expect(second.sha256).not.toBe(first.sha256);

    expect((await registry.download(maintainer, "snapshots", snapshot)).sha256).toBe(second.sha256);
    expect((await registry.download(maintainer, "snapshots", snapshot, { buildNumber: 1 })).sha256).toBe(first.sha256);
    expect((await registry.getManifest(maintainer, "snapshots", snapshot, { buildNumber: 1 })).sha256).toBe(first.sha256);
    await expectError(registry.download(maintainer, "snapshots", snapshot, { buildNumber: 3 }), "not_found");

    await testDb.db.delete(build).where(eq(build.buildNumber, 1));
    await expectError(registry.download(maintainer, "snapshots", snapshot, { buildNumber: 1 }), "not_found");
  });

  /** A registry whose validation holds publishes until two arrive, then lets both into their transactions at once. */
  function racingRegistry(): Registry {
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((r) => (release = r));
    return createRegistry({
      db: testDb.db,
      blobs,
      validate: async () => {
        if (++arrived === 2) release();
        await together;
        return [];
      },
    });
  }

  // The version upsert's row lock already serializes these two transactions; the advisory lock is a
  // second guard. What this pins down is the outcome: distinct, consecutive build numbers.
  it("gives concurrent snapshot publishes distinct consecutive build numbers", async () => {
    const racing = racingRegistry();
    const publishSnapshot = async () =>
      racing.publish(maintainer, {
        repository: "snapshots",
        manifest: manifest("acme", "money", "1.0.0-SNAPSHOT"),
        archive: await packArchive(moneyFiles),
      });
    const results = await Promise.all([publishSnapshot(), publishSnapshot()]);
    expect(results.map((r) => r.buildNumber).sort()).toEqual([1, 2]);
  });

  it("lets only one of two concurrent publishes of the same release win", async () => {
    const racing = racingRegistry();
    const publishRelease = async () =>
      racing.publish(maintainer, {
        repository: "releases",
        manifest: manifest("acme", "money", "1.0.0"),
        archive: await packArchive(moneyFiles),
      });
    const results = await Promise.allSettled([publishRelease(), publishRelease()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected?.reason as RegistryError).code).toBe("immutable");
    const keys = (await testDb.db.select({ storageKey: build.storageKey }).from(build)).map((r) => r.storageKey);
    expect(keys).toHaveLength(1);
  });

  it("rejects a release that depends on a snapshot", async () => {
    await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
    await expectError(
      registry.publish(key("maintainer", [write("releases"), read("snapshots")]), {
        repository: "releases",
        manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0-SNAPSHOT"]),
        archive: await packArchive(orderFiles()),
      }),
      "validation_failed",
    );
  });

  it("does not disclose a private repository the key can't read when publishing", async () => {
    const outsider = key("maintainer", [write("snapshots")], "key-outsider");
    const hidden = await expectError(publishMoney(outsider, "releases"), "not_found");
    const missing = await expectError(publishMoney(outsider, "absent"), "not_found");
    expect(hidden.message.replace("releases", "X")).toBe(missing.message.replace("absent", "X"));
  });

  it("rejects version kinds the repository does not accept", async () => {
    await expectError(publishMoney(maintainer, "releases", "1.0.0-SNAPSHOT"), "invalid_request");
    await expectError(publishMoney(maintainer, "snapshots", "1.0.0"), "invalid_request");
  });

  it("rejects an invalid manifest", async () => {
    await expectError(
      registry.publish(maintainer, {
        repository: "releases",
        manifest: { group: "Acme!", name: "money", version: "1.0.0", dependencies: [] },
        archive: await packArchive(moneyFiles),
      }),
      "invalid_request",
    );
  });

  it("rejects an undeclared import with the offending path", async () => {
    await publishMoney();
    const error = await expectError(publishOrder(maintainer, "releases", []), "validation_failed");
    const issues = (error.details as { issues: { path: string }[] }).issues;
    expect(issues[0]?.path).toBe("acme/order/v1/order.proto");
  });

  it("rejects files that collide with a dependency", async () => {
    await publishMoney();
    await expectError(
      registry.publish(maintainer, {
        repository: "releases",
        manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
        archive: await packArchive([...moneyFiles, ...orderFiles()]),
      }),
      "validation_failed",
    );
  });

  /** A registry using real validation that records the dependency files of every publish. */
  function spyingRegistry(): { registry: Registry; dependencyFiles: ProtoFile[][] } {
    const dependencyFiles: ProtoFile[][] = [];
    return {
      dependencyFiles,
      registry: createRegistry({
        db: testDb.db,
        blobs,
        validate: async (input) => {
          dependencyFiles.push(input.dependencyFiles);
          return validateProtos(input);
        },
      }),
    };
  }

  const currencyMoney = [
    proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }\nmessage Currency { string code = 1; }"),
  ];
  const currencyOrder = [
    proto("acme/order/v1/order.proto", "message Order { acme.money.v1.Currency currency = 1; }", [
      "acme/money/v1/money.proto",
    ]),
  ];

  it("validates against the dependency copy in the repository with the lowest resolutionPriority", async () => {
    // Inserted, and named, in the opposite order of their priority so neither decides the outcome.
    await insertRepo("alpha", { resolutionPriority: 10 });
    await insertRepo("zeta", { resolutionPriority: 5 });
    await publishMoney(key("maintainer", [write("alpha")], "key-alpha"), "alpha");
    await publishMoney(key("maintainer", [write("zeta")], "key-zeta"), "zeta", "1.0.0", currencyMoney);

    const spy = spyingRegistry();
    const reader = key("maintainer", [write("releases"), read("alpha"), read("zeta")], "key-reader");
    const result = await spy.registry.publish(reader, {
      repository: "releases",
      manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
      archive: await packArchive(currencyOrder),
    });
    expect(result.buildNumber).toBe(1);
    expect(spy.dependencyFiles).toEqual([currencyMoney]);
  });

  it("skips repositories the publishing key can't read when resolving dependencies", async () => {
    await insertRepo("shared", { resolutionPriority: 10 });
    await insertRepo("other", { resolutionPriority: 5 });
    const sharedWriter = key("maintainer", [write("shared")], "key-shared");
    const otherWriter = key("maintainer", [write("other")], "key-other");
    // "other" has the lower priority value but this key can't read it, so "shared" is used.
    await publishMoney(otherWriter, "other");
    await publishMoney(sharedWriter, "shared");

    await publishOrder();
    const resolution = await registry.resolve(maintainer, ["releases", "shared"], [coord("acme", "order", "1.0.0")]);
    expect(resolution.nodes.map((n) => `${n.repository}/${n.coordinate.name}`)).toEqual([
      "shared/money",
      "releases/order",
    ]);
  });

  it("prefers the target repository over higher-priority repositories", async () => {
    await insertRepo("shared", { resolutionPriority: 1 });
    await publishMoney(key("maintainer", [write("shared")], "key-shared"), "shared");
    await publishMoney(maintainer, "releases", "1.0.0", currencyMoney);
    const spy = spyingRegistry();
    await spy.registry.publish(maintainer, {
      repository: "releases",
      manifest: manifest("acme", "order", "1.0.0", ["acme:money:1.0.0"]),
      archive: await packArchive(currencyOrder),
    });
    expect(spy.dependencyFiles).toEqual([currencyMoney]);
  });

  it("does not resolve dependencies from private repositories the key can't read", async () => {
    await insertRepo("hidden");
    await publishMoney(key("maintainer", [write("hidden")], "key-hidden"), "hidden");
    const error = await expectError(publishOrder(), "validation_failed");
    expect(error.message).toMatch(/dependency not found/i);
  });

  it("requires write permission and authentication to publish", async () => {
    await expectError(publishMoney(key("maintainer", [read("releases")])), "forbidden");
    await testDb.db.update(repository).set({ visibility: "public" }).where(eq(repository.name, "releases"));
    await expectError(publishMoney(key("maintainer", [])), "forbidden");
    await testDb.db.update(repository).set({ visibility: "private" }).where(eq(repository.name, "releases"));
    await expectError(publishMoney(key("viewer", [write("releases")])), "forbidden");
    await expectError(publishMoney({ kind: "user", userId: "u1", role: "admin" }), "forbidden");
    await expectError(publishMoney(anonymous), "unauthorized");
  });

  it("hides private artifacts from anonymous resolution like missing ones", async () => {
    await insertRepo("private");
    await publishMoney(key("maintainer", [write("private")], "key-private"), "private");
    const hidden = await expectError(
      registry.resolve(anonymous, ["private"], [coord("acme", "money", "1.0.0")]),
      "not_found",
    );
    const missing = await expectError(
      registry.resolve(anonymous, ["private"], [coord("acme", "absent", "1.0.0")]),
      "not_found",
    );
    expect(hidden.message.replace("money", "X")).toBe(missing.message.replace("absent", "X"));
  });

  it("reads public repositories anonymously and hides private ones", async () => {
    await testDb.db.update(repository).set({ visibility: "public" }).where(eq(repository.name, "releases"));
    await publishMoney();
    const info = await registry.getManifest(anonymous, "releases", coord("acme", "money", "1.0.0"));
    expect(info.files).toEqual(["acme/money/v1/money.proto"]);

    await insertRepo("private");
    await publishMoney(key("maintainer", [write("private")], "key-private"), "private");
    await expectError(registry.getManifest(anonymous, "private", coord("acme", "money", "1.0.0")), "not_found");
    await expectError(registry.listVersions(anonymous, "private", "acme", "money"), "not_found");
    await expectError(registry.download(anonymous, "private", coord("acme", "money", "1.0.0")), "not_found");
  });

  it("counts downloads on the served build", async () => {
    const published = await publishMoney();
    const download = await registry.download(maintainer, "releases", coord("acme", "money", "1.0.0"));
    expect(download.sha256).toBe(published.sha256);
    expect(download.filename).toBe("money-1.0.0.tar.gz");
    expect(download.data.length).toBeGreaterThan(0);

    const info = await registry.getManifest(maintainer, "releases", coord("acme", "money", "1.0.0"));
    expect(info.downloadCount).toBe(1);
    const [row] = await testDb.db.select().from(build);
    expect(row?.lastDownloadedAt).toBeInstanceOf(Date);
  });

  it("lists dependents across repositories", async () => {
    await publishMoney();
    await publishOrder();
    expect(await registry.listDependents(coord("acme", "money", "1.0.0"))).toEqual([
      { repository: "releases", coordinate: coord("acme", "order", "1.0.0") },
    ]);
    expect(await registry.listDependents(coord("acme", "order", "1.0.0"))).toEqual([]);
  });

  it("blocks deleting a depended-on version", async () => {
    await publishMoney();
    await publishOrder();
    const blocked = await expectError(
      registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0")),
      "has_dependents",
    );
    expect(blocked.details).toEqual({
      dependents: [{ repository: "releases", coordinate: coord("acme", "order", "1.0.0") }],
      hiddenDependents: 0,
    });
    await expectError(
      registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0"), { force: true }),
      "forbidden",
    );
    expect(await testDb.db.select().from(build)).toHaveLength(2);
  });

  it("deletes a version without dependents including its blobs", async () => {
    await publishMoney();
    await publishOrder();
    const keysBefore = (await testDb.db.select({ storageKey: build.storageKey }).from(build)).map((r) => r.storageKey);

    await registry.deleteVersion(maintainer, "releases", coord("acme", "order", "1.0.0"));
    await expectError(registry.getManifest(maintainer, "releases", coord("acme", "order", "1.0.0")), "not_found");
    const keysAfter = (await testDb.db.select({ storageKey: build.storageKey }).from(build)).map((r) => r.storageKey);
    expect(keysAfter).toHaveLength(1);
    const removed = keysBefore.filter((k) => !keysAfter.includes(k));
    expect(removed).toHaveLength(1);
    expect(await blobs.get(removed[0]!)).toBeNull();

    // With its only dependent gone, money can be deleted too.
    await registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0"));
    expect(await testDb.db.select().from(build)).toHaveLength(0);
  });

  describe("re-publishing a deleted release", () => {
    const money = coord("acme", "money", "1.0.0");
    const changed = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; string currency = 2; }")];

    const tombstones = () => testDb.db.select().from(deletedRelease);

    it("records a tombstone with the deleted archive's sha256", async () => {
      const published = await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      const rows = await tombstones();
      expect(rows).toEqual([
        expect.objectContaining({ group: "acme", name: "money", version: "1.0.0", sha256: published.sha256 }),
      ]);
    });

    it("refuses different content while redeploy is off", async () => {
      await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      const error = await expectError(publishMoney(maintainer, "releases", "1.0.0", changed), "immutable");
      expect(error.message).toBe(
        "Release acme:money:1.0.0 was deleted; re-publishing is only allowed with identical content (or enable redeploy)",
      );
      expect(await tombstones()).toHaveLength(1);
      expect(await testDb.db.select().from(build)).toHaveLength(0);
    });

    it("allows identical content and removes the tombstone", async () => {
      const first = await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      const again = await publishMoney();
      expect(again).toMatchObject({ sha256: first.sha256, buildNumber: 1, redeployed: false });
      expect(await tombstones()).toHaveLength(0);
    });

    it("allows different content when the repository allows redeploy", async () => {
      await publishMoney();
      await registry.deleteVersion(maintainer, "releases", money);
      await testDb.db.update(repository).set({ allowRedeploy: true }).where(eq(repository.name, "releases"));
      await expect(publishMoney(maintainer, "releases", "1.0.0", changed)).resolves.toMatchObject({ buildNumber: 1 });
      expect(await tombstones()).toHaveLength(0);
    });

    it("leaves snapshots unaffected", async () => {
      await publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT");
      await registry.deleteVersion(maintainer, "snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"));
      expect(await tombstones()).toHaveLength(0);
      await expect(publishMoney(maintainer, "snapshots", "1.0.0-SNAPSHOT", changed)).resolves.toMatchObject({
        buildNumber: 1,
      });
    });

    it("scopes tombstones to the repository", async () => {
      await insertRepo("other");
      const other = key("maintainer", [write("releases"), write("other")]);
      await publishMoney(other);
      await registry.deleteVersion(other, "releases", money);
      await expect(publishMoney(other, "other", "1.0.0", changed)).resolves.toMatchObject({ buildNumber: 1 });
    });
  });

  it("lists only readable dependents and counts the hidden ones", async () => {
    await insertRepo("hidden");
    await publishMoney();
    await publishOrder();
    await publishOrder(key("maintainer", [write("hidden"), read("releases")], "key-hidden"), "hidden");

    const blocked = await expectError(
      registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0")),
      "has_dependents",
    );
    expect(blocked.details).toEqual({
      dependents: [{ repository: "releases", coordinate: coord("acme", "order", "1.0.0") }],
      hiddenDependents: 1,
    });
    // Users browse every repository, so an admin user sees both dependents.
    const asAdminUser = await expectError(
      registry.deleteVersion({ kind: "user", userId: "u-admin", role: "admin" }, "releases", coord("acme", "money", "1.0.0")),
      "has_dependents",
    );
    expect(asAdminUser.details).toMatchObject({ hiddenDependents: 0 });
    expect((asAdminUser.details as { dependents: unknown[] }).dependents).toHaveLength(2);
  });

  it("lets an admin force-delete a depended-on version", async () => {
    await publishMoney();
    await publishOrder();
    await registry.deleteVersion(admin, "releases", coord("acme", "money", "1.0.0"), { force: true });
    const audit = await auditActions();
    expect(audit.at(-1)).toMatchObject({ action: "delete", forced: true, target: "releases/acme:money:1.0.0" });
  });

  it("requires delete permission", async () => {
    await publishMoney();
    await expectError(
      registry.deleteVersion(key("viewer", [read("releases")]), "releases", coord("acme", "money", "1.0.0")),
      "forbidden",
    );
    await expectError(registry.deleteVersion(anonymous, "releases", coord("acme", "money", "1.0.0")), "unauthorized");
  });

  it("writes an audit row for every mutation", async () => {
    await testDb.db.update(repository).set({ allowRedeploy: true }).where(eq(repository.name, "releases"));
    await publishMoney();
    await publishMoney();
    await registry.deleteVersion(maintainer, "releases", coord("acme", "money", "1.0.0"));
    const audit = await auditActions();
    expect(audit.map((a) => a.action)).toEqual(["publish", "redeploy", "delete"]);
    expect(audit.every((a) => a.target === "releases/acme:money:1.0.0" && !a.forced)).toBe(true);
    const actors = await testDb.db
      .select({ actorType: auditEvent.actorType, actorId: auditEvent.actorId })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "publish")));
    expect(actors).toEqual([{ actorType: "apikey", actorId: "key-maintainer" }]);
  });
});
