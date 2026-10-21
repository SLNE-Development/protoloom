import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValkeyContainer, type StartedValkeyContainer } from "@testcontainers/valkey";
import {
  CLEANUP_QUEUE,
  createQueue,
  enqueueCleanup,
  getJobState,
  redisConnection,
  scheduleDailyCleanup,
  type CleanupQueue,
} from "./index.js";

describe("jobs", () => {
  let valkey: StartedValkeyContainer;
  let queue: CleanupQueue;

  beforeAll(async () => {
    valkey = await new ValkeyContainer("valkey/valkey:9.1.2-alpine").start();
    queue = createQueue(redisConnection(valkey.getConnectionUrl()));
  });

  afterAll(async () => {
    await queue?.close();
    await valkey?.stop();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it("uses the protoloom-cleanup queue", () => {
    expect(queue.name).toBe(CLEANUP_QUEUE);
    expect(CLEANUP_QUEUE).toBe("protoloom-cleanup");
  });

  it("enqueues a repository cleanup that waits for a worker", async () => {
    const jobId = await enqueueCleanup(queue, "releases");
    expect(jobId).toEqual(expect.any(String));

    expect(await getJobState(queue, jobId)).toEqual({ state: "waiting", result: null, failedReason: null });
    const job = await queue.getJob(jobId);
    expect(job?.data).toEqual({ kind: "cleanup:repo", repository: "releases" });
    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toMatchObject({ type: "exponential" });
  });

  it("reports unknown for a job id that does not exist", async () => {
    expect(await getJobState(queue, "missing")).toEqual({ state: "unknown", result: null, failedReason: null });
  });

  it("registers the daily scheduler once, however often it is upserted", async () => {
    await scheduleDailyCleanup(queue);
    await scheduleDailyCleanup(queue);

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({ key: "cleanup-daily", pattern: "0 3 * * *" });
    expect(schedulers[0]?.template?.data).toEqual({ kind: "cleanup:all" });
    expect(schedulers[0]?.template?.opts).toMatchObject({ attempts: 3, backoff: { type: "exponential" } });
  });
});
