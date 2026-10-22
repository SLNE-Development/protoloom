import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValkeyContainer, type StartedValkeyContainer } from "@testcontainers/valkey";
import { asc, sql } from "drizzle-orm";
import { artifact, build, cleanupPolicy, repository, version } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createLocalStore, type BlobStore } from "@weaver/core";
import {
  createQueue,
  enqueueCleanup,
  getJobState,
  redisConnection,
  type CleanupJobStatus,
  type CleanupQueue,
} from "@weaver/jobs";
import { loadEnv } from "./env.js";
import { startWorker, type RunningWorker } from "./worker.js";

describe("worker", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let valkey: StartedValkeyContainer;
  let blobDir: string;
  let blobs: BlobStore;
  let queue: CleanupQueue;
  const running: RunningWorker[] = [];

  async function start(): Promise<RunningWorker> {
    const w = await startWorker({ db: testDb.db, blobs, connection: redisConnection(valkey.getConnectionUrl()) });
    running.push(w);
    return w;
  }

  async function waitForFinish(jobId: string): Promise<CleanupJobStatus> {
    for (let i = 0; i < 400; i++) {
      const status = await getJobState(queue, jobId);
      if (status.state === "completed" || status.state === "failed") return status;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`job ${jobId} did not finish`);
  }

  beforeAll(async () => {
    [testDb, valkey] = await Promise.all([
      startTestDb(),
      new ValkeyContainer("valkey/valkey:9.1.2-alpine").start(),
    ]);
    blobDir = await mkdtemp(join(tmpdir(), "weaver-worker-"));
    blobs = createLocalStore(blobDir);
    queue = createQueue(redisConnection(valkey.getConnectionUrl()));
  });

  afterAll(async () => {
    await queue?.close();
    await testDb?.stop();
    await valkey?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await testDb.db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((w) => w.close()));
  });

  it("runs a repository cleanup job and leaves the newest builds", async () => {
    const [repo] = await testDb.db.insert(repository).values({ name: "snapshots" }).returning();
    await testDb.db.insert(cleanupPolicy).values({ repositoryId: repo!.id, kind: "keep_last_snapshot_builds", value: 2 });
    const [art] = await testDb.db
      .insert(artifact)
      .values({ repositoryId: repo!.id, group: "acme", name: "money" })
      .returning();
    const [ver] = await testDb.db
      .insert(version)
      .values({ artifactId: art!.id, version: "1.0.0-SNAPSHOT", isSnapshot: true })
      .returning();
    for (let n = 1; n <= 4; n++) {
      const storageKey = `snapshots/acme/money/1.0.0-SNAPSHOT/${randomUUID()}.tar.gz`;
      await blobs.put(storageKey, Buffer.from(`build ${n}`));
      await testDb.db
        .insert(build)
        .values({ versionId: ver!.id, buildNumber: n, storageKey, sha256: "0".repeat(64), sizeBytes: 7 });
    }

    await start();
    const jobId = await enqueueCleanup(queue, "snapshots");
    expect(await waitForFinish(jobId)).toEqual({ state: "completed", result: { deleted: 2 }, failedReason: null });

    const remaining = await testDb.db.select({ n: build.buildNumber }).from(build).orderBy(asc(build.buildNumber));
    expect(remaining.map((r) => r.n)).toEqual([3, 4]);
  });

  it("registers a single daily scheduler when started twice", async () => {
    await start();
    await start();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toEqual([expect.objectContaining({ key: "cleanup-daily", pattern: "0 3 * * *" })]);
  });

  it("fails a job for an unknown repository at once instead of retrying it", async () => {
    await start();
    const jobId = await enqueueCleanup(queue, "nope");

    const status = await waitForFinish(jobId);
    expect(status.state).toBe("failed");
    expect(status.failedReason).toMatch(/nope was not found/);
    const job = await queue.getJob(jobId);
    expect(job?.opts.attempts).toBe(3);
    expect(job?.attemptsMade).toBe(1);
  });
});

describe("loadEnv", () => {
  const base = {
    DATABASE_URL: "postgres://weaver:weaver@localhost:5432/weaver",
    VALKEY_URL: "redis://localhost:6379",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_PATH: "/data",
  };

  it("accepts a complete environment", () => {
    expect(loadEnv(base)).toMatchObject({ VALKEY_URL: "redis://localhost:6379", STORAGE_DRIVER: "local" });
  });

  it("rejects a missing VALKEY_URL and treats empty strings as unset", () => {
    expect(() => loadEnv({ ...base, VALKEY_URL: "" })).toThrow();
  });

  it("rejects an unknown storage driver", () => {
    expect(() => loadEnv({ ...base, STORAGE_DRIVER: "ftp" })).toThrow();
  });
});
