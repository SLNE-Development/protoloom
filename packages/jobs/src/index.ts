import { Queue, type ConnectionOptions, type DefaultJobOptions, type JobState } from "bullmq";

/** Name of the BullMQ queue that carries cleanup jobs. */
export const CLEANUP_QUEUE = "protoloom-cleanup";

/** Id of the job scheduler that runs every repository's cleanup policies once a day. */
export const DAILY_SCHEDULER_ID = "cleanup-daily";

/** Cron pattern of the daily cleanup: 03:00 server time. */
export const DAILY_CLEANUP_PATTERN = "0 3 * * *";

/** Payload of a cleanup job: all repositories, or a single one ("run now"). */
export type CleanupJobData = { kind: "cleanup:all" } | { kind: "cleanup:repo"; repository: string };

/** Return value of a finished cleanup job. */
export interface CleanupJobResult {
  deleted: number;
}

export type CleanupQueue = Queue<CleanupJobData, CleanupJobResult>;

/** Where a job stands, with its result once completed or its failure reason once failed. */
export interface CleanupJobStatus {
  state: JobState | "unknown";
  result: CleanupJobResult | null;
  failedReason: string | null;
}

/**
 * Retry a failing job at most three times with exponential backoff, and keep finished jobs
 * around for a day (at most 1000) so the UI can still poll their outcome.
 */
export const CLEANUP_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { age: 86_400, count: 1000 },
  removeOnFail: { age: 7 * 86_400, count: 1000 },
};

/**
 * Connection options for a Valkey/Redis URL such as `redis://localhost:6379`. Commands wait for
 * a reconnect instead of failing after a few retries, as BullMQ workers require.
 */
export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

/** Opens the cleanup queue on the given connection with {@link CLEANUP_JOB_OPTIONS} as job defaults. */
export function createQueue(connection: ConnectionOptions): CleanupQueue {
  return new Queue<CleanupJobData, CleanupJobResult>(CLEANUP_QUEUE, {
    connection,
    defaultJobOptions: CLEANUP_JOB_OPTIONS,
  });
}

/** Enqueues a cleanup of one repository and returns the job id. */
export async function enqueueCleanup(queue: CleanupQueue, repository: string): Promise<string> {
  const job = await queue.add("cleanup:repo", { kind: "cleanup:repo", repository });
  if (!job.id) throw new Error("BullMQ returned a job without an id");
  return job.id;
}

/** Looks up a cleanup job; `state` is `unknown` when the id does not exist (or was already removed). */
export async function getJobState(queue: CleanupQueue, jobId: string): Promise<CleanupJobStatus> {
  const job = await queue.getJob(jobId);
  if (!job) return { state: "unknown", result: null, failedReason: null };
  const state = await job.getState();
  return {
    state,
    result: state === "completed" ? (job.returnvalue ?? null) : null,
    failedReason: state === "failed" ? (job.failedReason ?? null) : null,
  };
}

/** Creates or updates the daily cleanup scheduler; calling it again never adds a second one. */
export async function scheduleDailyCleanup(queue: CleanupQueue): Promise<void> {
  await queue.upsertJobScheduler(
    DAILY_SCHEDULER_ID,
    { pattern: DAILY_CLEANUP_PATTERN },
    { name: "cleanup:all", data: { kind: "cleanup:all" }, opts: CLEANUP_JOB_OPTIONS },
  );
}
