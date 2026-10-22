import { UnrecoverableError, Worker, type ConnectionOptions } from "bullmq";
import { applyCleanup, createAssetService, evictCaches, RegistryError, runAllCleanups, type StoreSet } from "@weaver/core";
import type { Db } from "@weaver/db";
import {
  createQueue,
  MAINTENANCE_QUEUE,
  scheduleDailyCleanup,
  scheduleHourlyEviction,
  type MaintenanceJobData,
} from "@weaver/jobs";

/** What the worker needs: the database, the object stores and the Valkey connection. */
export interface WorkerDeps {
  db: Db;
  stores: StoreSet;
  connection: ConnectionOptions;
}

/** A started worker; `close` waits for the running job, then disconnects. */
export interface RunningWorker {
  worker: Worker<MaintenanceJobData, unknown>;
  close(): Promise<void>;
}

/**
 * Runs one maintenance job, dispatching on `data.kind`. An unknown repository can never succeed, so
 * it fails the job at once instead of spending its retries.
 */
export async function processMaintenanceJob(deps: WorkerDeps, data: MaintenanceJobData): Promise<unknown> {
  const now = new Date();
  switch (data.kind) {
    case "cleanup:all":
      return { deleted: await runAllCleanups(deps.db, deps.stores, now) };
    case "cleanup:repo":
      try {
        return { deleted: (await applyCleanup(deps.db, deps.stores, data.repository, now)).length };
      } catch (error) {
        if (error instanceof RegistryError && error.code === "not_found") throw new UnrecoverableError(error.message);
        throw error;
      }
    case "evict:all":
      return evictCaches({ db: deps.db, assets: createAssetService({ db: deps.db, stores: deps.stores }), now });
    case "docker:gc":
      // The docker format registers its garbage collection later; until then the job does nothing.
      console.log("weaver: docker:gc is not implemented yet; skipping");
      return { skipped: true };
    default:
      throw new UnrecoverableError(`Unknown maintenance job kind ${JSON.stringify((data as { kind?: unknown }).kind)}`);
  }
}

/**
 * Upserts the `cleanup-daily` and `evict-hourly` schedulers (idempotent) and starts a worker that
 * processes maintenance jobs one at a time.
 */
export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const queue = createQueue(deps.connection);
  try {
    await scheduleDailyCleanup(queue);
    await scheduleHourlyEviction(queue);
  } finally {
    await queue.close();
  }
  const worker = new Worker<MaintenanceJobData, unknown>(MAINTENANCE_QUEUE, (job) => processMaintenanceJob(deps, job.data), {
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
