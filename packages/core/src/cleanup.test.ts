import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { artifact, auditEvent, build, cleanupPolicy, dependency, repository, version } from "@protoloom/db";
import { startTestDb } from "@protoloom/db/testing";
import { applyCleanup, planCleanup, runAllCleanups, type CleanupCandidate } from "./cleanup.js";
import type { Coordinate } from "./coordinates.js";
import { createLocalStore, type BlobStore } from "./storage/index.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-21T03:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

const coord = (group: string, name: string, v: string): Coordinate => ({ group, name, version: v });

interface SeedOptions {
  builds?: number;
  createdAt?: Date;
  updatedAt?: Date;
  lastDownloadedAt?: Date | null;
  dependsOn?: Coordinate[];
}

describe("cleanup", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let blobs: BlobStore;

  const repoIds = new Map<string, string>();

  async function insertRepo(name: string): Promise<void> {
    const [row] = await testDb.db.insert(repository).values({ name }).returning({ id: repository.id });
    repoIds.set(name, row!.id);
  }

  async function addPolicy(repo: string, values: Omit<typeof cleanupPolicy.$inferInsert, "repositoryId">) {
    await testDb.db.insert(cleanupPolicy).values({ repositoryId: repoIds.get(repo)!, ...values });
  }

  /** Inserts a version with `builds` builds (numbered from 1), a blob per build and the given dependencies on every build. */
  async function seed(repo: string, c: Coordinate, opts: SeedOptions = {}): Promise<string[]> {
    const created = opts.createdAt ?? daysAgo(1);
    const [art] = await testDb.db
      .insert(artifact)
      .values({ repositoryId: repoIds.get(repo)!, group: c.group, name: c.name })
      .onConflictDoUpdate({ target: [artifact.repositoryId, artifact.group, artifact.name], set: { name: c.name } })
      .returning({ id: artifact.id });
    const [ver] = await testDb.db
      .insert(version)
      .values({
        artifactId: art!.id,
        version: c.version,
        isSnapshot: c.version.endsWith("-SNAPSHOT"),
        createdAt: created,
        updatedAt: opts.updatedAt ?? created,
      })
      .returning({ id: version.id });
    const keys: string[] = [];
    for (let n = 1; n <= (opts.builds ?? 1); n++) {
      const storageKey = `${repo}/${c.group}/${c.name}/${c.version}/${randomUUID()}.tar.gz`;
      await blobs.put(storageKey, Buffer.from(`build ${n}`));
      keys.push(storageKey);
      const [b] = await testDb.db
        .insert(build)
        .values({
          versionId: ver!.id,
          buildNumber: n,
          storageKey,
          sha256: "0".repeat(64),
          sizeBytes: 7,
          createdAt: created,
          lastDownloadedAt: opts.lastDownloadedAt ?? null,
        })
        .returning({ id: build.id });
      for (const d of opts.dependsOn ?? []) {
        await testDb.db
          .insert(dependency)
          .values({ buildId: b!.id, depGroup: d.group, depName: d.name, depVersion: d.version });
      }
    }
    return keys;
  }

  async function buildNumbers(repo: string, c: Coordinate): Promise<number[]> {
    const rows = await testDb.db
      .select({ n: build.buildNumber })
      .from(build)
      .innerJoin(version, eq(version.id, build.versionId))
      .innerJoin(artifact, eq(artifact.id, version.artifactId))
      .where(
        and(
          eq(artifact.repositoryId, repoIds.get(repo)!),
          eq(artifact.group, c.group),
          eq(artifact.name, c.name),
          eq(version.version, c.version),
        ),
      )
      .orderBy(asc(build.buildNumber));
    return rows.map((r) => r.n);
  }

  /** Resolves once some session is blocked waiting for an advisory lock. */
  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const { rows } = await testDb.db.$client.query(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      );
      if ((rows[0] as { n: number }).n > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no session started waiting for an advisory lock");
  }

  const summary = (candidates: CleanupCandidate[]) =>
    candidates.map((x) => `${x.coordinate.name}:${x.coordinate.version}#${x.buildNumber ?? "all"}`);

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "protoloom-cleanup-"));
    blobs = createLocalStore(blobDir);
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
    repoIds.clear();
    await insertRepo("snapshots");
    await insertRepo("other");
  });

  describe("keep_last_snapshot_builds", () => {
    it("plans every build but the newest N", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 5 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 2 });

      const plan = await planCleanup(testDb.db, "snapshots", NOW);
      expect(summary(plan)).toEqual(["money:1.0.0-SNAPSHOT#1", "money:1.0.0-SNAPSHOT#2", "money:1.0.0-SNAPSHOT#3"]);
      expect(plan[0]).toMatchObject({ repository: "snapshots", coordinate: coord("acme", "money", "1.0.0-SNAPSHOT") });
      expect(plan[0]!.reason).toMatch(/keep last 2/);
    });

    it("treats a value below 1 as 1, so the newest build always stays", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 0 });

      expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual([
        "money:1.0.0-SNAPSHOT#1",
        "money:1.0.0-SNAPSHOT#2",
      ]);
    });

    it("never touches releases", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0"));
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
      expect(await planCleanup(testDb.db, "snapshots", NOW)).toEqual([]);
    });
  });

  describe("delete_stale_snapshots", () => {
    it("plans snapshots not published for X days as whole versions and skips releases", async () => {
      await seed("snapshots", coord("acme", "old", "1.0.0-SNAPSHOT"), { builds: 2, updatedAt: daysAgo(31) });
      await seed("snapshots", coord("acme", "fresh", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(29) });
      await seed("snapshots", coord("acme", "ancient", "1.0.0"), { updatedAt: daysAgo(400) });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual(["old:1.0.0-SNAPSHOT#all"]);
    });
  });

  describe("delete_not_downloaded", () => {
    beforeEach(async () => {
      await seed("snapshots", coord("acme", "unused", "1.0.0-SNAPSHOT"), { lastDownloadedAt: daysAgo(91) });
      await seed("snapshots", coord("acme", "used", "1.0.0-SNAPSHOT"), {
        createdAt: daysAgo(200),
        lastDownloadedAt: daysAgo(10),
      });
      await seed("snapshots", coord("acme", "never", "1.0.0-SNAPSHOT"), { createdAt: daysAgo(100) });
      await seed("snapshots", coord("acme", "new", "1.0.0-SNAPSHOT"), { createdAt: daysAgo(5) });
      await seed("snapshots", coord("acme", "release", "1.0.0"), { createdAt: daysAgo(300) });
    });

    it("skips releases unless the rule includes them, and falls back to createdAt when never downloaded", async () => {
      await addPolicy("snapshots", { kind: "delete_not_downloaded", value: 90 });
      expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual([
        "never:1.0.0-SNAPSHOT#all",
        "unused:1.0.0-SNAPSHOT#all",
      ]);
    });

    it("includes releases when the rule says so", async () => {
      await addPolicy("snapshots", { kind: "delete_not_downloaded", value: 90, includeReleases: true });
      expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual([
        "never:1.0.0-SNAPSHOT#all",
        "release:1.0.0#all",
        "unused:1.0.0-SNAPSHOT#all",
      ]);
    });
  });

  it("limits candidates to the rule's group prefix at a dot boundary", async () => {
    await seed("snapshots", coord("dev.surf", "a", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60) });
    await seed("snapshots", coord("dev.surf.economy", "b", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60) });
    await seed("snapshots", coord("dev.surfboard", "c", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60) });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30, groupPrefix: "dev.surf" });

    expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual(["a:1.0.0-SNAPSHOT#all", "b:1.0.0-SNAPSHOT#all"]);
  });

  it("plans nothing for disabled policies", async () => {
    await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3, updatedAt: daysAgo(60) });
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1, enabled: false });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30, enabled: false });

    expect(await planCleanup(testDb.db, "snapshots", NOW)).toEqual([]);
  });

  it("collapses build candidates into a whole-version candidate of the same version", async () => {
    await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3, updatedAt: daysAgo(60) });
    await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

    expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual(["money:1.0.0-SNAPSHOT#all"]);
  });

  it("excludes a candidate that a retained version in any repository depends on", async () => {
    const money = coord("acme", "money", "1.0.0-SNAPSHOT");
    const unused = coord("acme", "unused", "1.0.0-SNAPSHOT");
    await seed("snapshots", money, { updatedAt: daysAgo(60) });
    await seed("snapshots", unused, { updatedAt: daysAgo(60) });
    await seed("other", coord("acme", "order", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60), dependsOn: [money] });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

    expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual(["unused:1.0.0-SNAPSHOT#all"]);
  });

  it("keeps a dependency chain whose head is retained, and deletes a chain that is removed completely", async () => {
    const base = coord("acme", "base", "1.0.0-SNAPSHOT");
    const mid = coord("acme", "mid", "1.0.0-SNAPSHOT");
    // mid -> base, both stale; top -> mid is fresh, so mid stays and therefore base stays.
    await seed("snapshots", base, { updatedAt: daysAgo(60) });
    await seed("snapshots", mid, { updatedAt: daysAgo(60), dependsOn: [base] });
    await seed("snapshots", coord("acme", "top", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(1), dependsOn: [mid] });
    // leaf -> root, both stale and nothing retained depends on them.
    const root = coord("acme", "root", "1.0.0-SNAPSHOT");
    await seed("snapshots", root, { updatedAt: daysAgo(60) });
    await seed("snapshots", coord("acme", "leaf", "1.0.0-SNAPSHOT"), { updatedAt: daysAgo(60), dependsOn: [root] });
    await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

    expect(summary(await planCleanup(testDb.db, "snapshots", NOW))).toEqual([
      "leaf:1.0.0-SNAPSHOT#all",
      "root:1.0.0-SNAPSHOT#all",
    ]);
    const applied = await applyCleanup(testDb.db, blobs, "snapshots", NOW);
    expect(summary(applied)).toEqual(["leaf:1.0.0-SNAPSHOT#all", "root:1.0.0-SNAPSHOT#all"]);
    expect(await buildNumbers("snapshots", root)).toEqual([]);
    expect(await buildNumbers("snapshots", base)).toEqual([1]);
  });

  it("throws not_found for an unknown repository", async () => {
    await expect(planCleanup(testDb.db, "nope", NOW)).rejects.toMatchObject({ code: "not_found" });
  });

  describe("applyCleanup", () => {
    it("deletes rows and blobs and audits each deletion as the system", async () => {
      const money = coord("acme", "money", "1.0.0-SNAPSHOT");
      const stale = coord("acme", "stale", "1.0.0-SNAPSHOT");
      const moneyKeys = await seed("snapshots", money, { builds: 4 });
      const staleKeys = await seed("snapshots", stale, { builds: 2, updatedAt: daysAgo(60) });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 2 });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      const applied = await applyCleanup(testDb.db, blobs, "snapshots", NOW);
      expect(summary(applied)).toEqual([
        "money:1.0.0-SNAPSHOT#1",
        "money:1.0.0-SNAPSHOT#2",
        "stale:1.0.0-SNAPSHOT#all",
      ]);

      expect(await buildNumbers("snapshots", money)).toEqual([3, 4]);
      expect(await buildNumbers("snapshots", stale)).toEqual([]);
      const staleArtifact = await testDb.db.select().from(artifact).where(eq(artifact.name, "stale"));
      expect(staleArtifact).toEqual([]);

      expect(await blobs.get(moneyKeys[0]!)).toBeNull();
      expect(await blobs.get(moneyKeys[1]!)).toBeNull();
      expect(await blobs.get(moneyKeys[2]!)).not.toBeNull();
      expect(await blobs.get(moneyKeys[3]!)).not.toBeNull();
      for (const k of staleKeys) expect(await blobs.get(k)).toBeNull();

      const audits = await testDb.db
        .select({ actorType: auditEvent.actorType, action: auditEvent.action, target: auditEvent.target })
        .from(auditEvent)
        .orderBy(asc(auditEvent.target));
      expect(audits).toEqual([
        { actorType: "system", action: "cleanup.delete", target: "snapshots/acme:money:1.0.0-SNAPSHOT#1" },
        { actorType: "system", action: "cleanup.delete", target: "snapshots/acme:money:1.0.0-SNAPSHOT#2" },
        { actorType: "system", action: "cleanup.delete", target: "snapshots/acme:stale:1.0.0-SNAPSHOT" },
      ]);

      expect(await applyCleanup(testDb.db, blobs, "snapshots", NOW)).toEqual([]);
    });

    it("skips a stale version that was published again after planning", async () => {
      const money = coord("acme", "money", "1.0.0-SNAPSHOT");
      await seed("snapshots", money, { updatedAt: daysAgo(60) });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      // Hold the version's lock (as a concurrent publish would), let cleanup plan and block on it,
      // then "publish" by bumping updatedAt before releasing the lock.
      const holder = await testDb.db.$client.connect();
      try {
        await holder.query("select pg_advisory_lock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        const applying = applyCleanup(testDb.db, blobs, "snapshots", NOW);
        await waitForLockWaiter();
        await testDb.db.update(version).set({ updatedAt: NOW });
        await holder.query("select pg_advisory_unlock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        expect(await applying).toEqual([]);
      } finally {
        holder.release();
      }
      expect(await buildNumbers("snapshots", money)).toEqual([1]);
    });

    it("skips a version that gained a dependent after planning", async () => {
      const money = coord("acme", "money", "1.0.0-SNAPSHOT");
      await seed("snapshots", money, { updatedAt: daysAgo(60) });
      await addPolicy("snapshots", { kind: "delete_stale_snapshots", value: 30 });

      const holder = await testDb.db.$client.connect();
      try {
        await holder.query("select pg_advisory_lock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        const applying = applyCleanup(testDb.db, blobs, "snapshots", NOW);
        await waitForLockWaiter();
        await seed("other", coord("acme", "order", "1.0.0"), { dependsOn: [money] });
        await holder.query("select pg_advisory_unlock(hashtext($1))", ["snapshots:acme:money:1.0.0-SNAPSHOT"]);
        expect(await applying).toEqual([]);
      } finally {
        holder.release();
      }
      expect(await buildNumbers("snapshots", money)).toEqual([1]);
    });
  });

  describe("runAllCleanups", () => {
    it("applies every repository's policies and returns the number of deletions", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3 });
      await seed("other", coord("acme", "order", "1.0.0-SNAPSHOT"), { builds: 2 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });
      await addPolicy("other", { kind: "keep_last_snapshot_builds", value: 1 });

      expect(await runAllCleanups(testDb.db, blobs, NOW)).toBe(3);
      expect(await buildNumbers("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"))).toEqual([3]);
      expect(await buildNumbers("other", coord("acme", "order", "1.0.0-SNAPSHOT"))).toEqual([2]);
    });

    it("returns 0 without deleting when another session holds the cleanup lock", async () => {
      await seed("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"), { builds: 3 });
      await addPolicy("snapshots", { kind: "keep_last_snapshot_builds", value: 1 });

      const holder = await testDb.db.$client.connect();
      try {
        await holder.query("select pg_advisory_lock(727001)");
        expect(await runAllCleanups(testDb.db, blobs, NOW)).toBe(0);
        expect(await buildNumbers("snapshots", coord("acme", "money", "1.0.0-SNAPSHOT"))).toEqual([1, 2, 3]);
      } finally {
        await holder.query("select pg_advisory_unlock(727001)");
        holder.release();
      }
      expect(await runAllCleanups(testDb.db, blobs, NOW)).toBe(2);
    });
  });
});
