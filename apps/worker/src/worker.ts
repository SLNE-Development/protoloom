import { UnrecoverableError, Worker, type ConnectionOptions } from "bullmq";
import { applyCleanup, RegistryError, runAllCleanups, type StoreSet } from "@weaver/core";
import type { Db } from "@weaver/db";
import {
  CLEANUP_QUEUE,
  createQueue,
  scheduleDailyCleanup,
  type CleanupJobData,
  type CleanupJobResult,
} from "@weaver/jobs";

/** What the worker needs: the database, the object stores and the Valkey connection. */
export interface WorkerDeps {
  db: Db;
  stores: StoreSet;
  connection: ConnectionOptions;
}

/** A started worker; `close` waits for the running job, then disconnects. */
export interface RunningWorker {
  worker: Worker<CleanupJobData, CleanupJobResult>;
  close(): Promise<void>;
}

/**
 * Runs one cleanup job. An unknown repository can never succeed, so it fails the job at once
 * instead of spending its retries.
 */
export async function processCleanupJob(deps: WorkerDeps, data: CleanupJobData): Promise<CleanupJobResult> {
  const now = new Date();
  if (data.kind === "cleanup:all") return { deleted: await runAllCleanups(deps.db, deps.stores, now) };
  try {
    return { deleted: (await applyCleanup(deps.db, deps.stores, data.repository, now)).length };
  } catch (error) {
    if (error instanceof RegistryError && error.code === "not_found") throw new UnrecoverableError(error.message);
    throw error;
  }
}

/**
 * Upserts the daily `cleanup-daily` scheduler (idempotent) and starts a worker that processes
 * cleanup jobs one at a time.
 */
export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const queue = createQueue(deps.connection);
  try {
    await scheduleDailyCleanup(queue);
  } finally {
    await queue.close();
  }
  const worker = new Worker<CleanupJobData, CleanupJobResult>(CLEANUP_QUEUE, (job) => processCleanupJob(deps, job.data), {
    connection: deps.connection,
    concurrency: 1,
  });
  worker.on("failed", (job, error) => {
    console.error(`weaver-worker: job ${job?.id ?? "?"} (${job?.name ?? "?"}) failed`, error);
  });
  worker.on("error", (error) => {
    console.error("weaver-worker: worker error", error);
  });
  await worker.waitUntilReady();
  return { worker, close: () => worker.close() };
}
