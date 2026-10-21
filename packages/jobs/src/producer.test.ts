import { afterEach, describe, expect, it } from "vitest";
import { ValkeyContainer } from "@testcontainers/valkey";
import {
  createQueue,
  enqueueCleanup,
  getJobState,
  producerConnection,
  QueueUnavailableError,
  type CleanupQueue,
} from "./index.js";

/** Producers (the web app) must answer quickly while Valkey is unreachable instead of hanging. */
describe("producer queue while Valkey is down", () => {
  const queues: CleanupQueue[] = [];

  afterEach(async () => {
    await Promise.all(queues.splice(0).map((q) => q.close().catch(() => undefined)));
  });

  function open(url: string, errors: unknown[] = []): CleanupQueue {
    const queue = createQueue(producerConnection(url), { onError: (error) => errors.push(error) });
    queues.push(queue);
    return queue;
  }

  it("rejects enqueueing within the timeout when Valkey is unreachable from the start", async () => {
    const errors: unknown[] = [];
    const queue = open("redis://127.0.0.1:1", errors);
    const started = Date.now();
    await expect(enqueueCleanup(queue, "releases", { timeoutMs: 1_500 })).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(4_000);
    await expect(getJobState(queue, "1", { timeoutMs: 1_500 })).rejects.toBeInstanceOf(QueueUnavailableError);
    // Connection errors reach the error listener instead of crashing the process.
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects enqueueing quickly once a connected Valkey stops", async () => {
    const valkey = await new ValkeyContainer("valkey/valkey:9.1.2-alpine").start();
    const queue = open(valkey.getConnectionUrl());
    expect(await enqueueCleanup(queue, "releases")).toEqual(expect.any(String));

    await valkey.stop();
    const started = Date.now();
    await expect(enqueueCleanup(queue, "releases", { timeoutMs: 3_000 })).rejects.toBeInstanceOf(QueueUnavailableError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
