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
 * Connection options for a BullMQ **worker** on a Valkey/Redis URL such as
 * `redis://localhost:6379`. Commands wait for a reconnect instead of failing after a few retries,
 * as BullMQ workers require. Producers use {@link producerConnection} instead.
 */
export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null };
}

/**
 * Connection options for a **producer** queue (the web app enqueueing jobs). While Valkey is
 * unreachable, commands fail at once instead of waiting in an offline queue (one retry per
 * request), so a request handler can report the outage. The connection keeps reconnecting in the
 * background and recovers when Valkey is back.
 */
export function producerConnection(url: string): ConnectionOptions {
  return { url, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 2_000 };
}

/** Default upper bound for a producer operation before it reports the queue as unavailable. */
export const PRODUCER_TIMEOUT_MS = 5_000;

/** Thrown by producer operations when Valkey can't be reached in time. */
export class QueueUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("The job queue (Valkey) is unavailable", { cause });
    this.name = "QueueUnavailableError";
  }
}

/** Options of producer operations. */
export interface ProducerOptions {
  /** Give up after this many milliseconds (default {@link PRODUCER_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Awaits `operation`, turning its failure or a run longer than `timeoutMs` into
 * {@link QueueUnavailableError}. (A connection that never became ready makes BullMQ wait forever.)
 */
async function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueUnavailableError()), timeoutMs);
  });
  // A rejection that arrives after the timeout won must not surface as an unhandled rejection.
  operation.catch(() => undefined);
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    throw error instanceof QueueUnavailableError ? error : new QueueUnavailableError(error);
  } finally {
    clearTimeout(timer);
  }
}

/** Options of {@link createQueue}. */
export interface QueueOptions {
  /** Receives connection errors (default: logged), so they never go unhandled. */
  onError?: (error: Error) => void;
}

/**
 * Opens the cleanup queue on the given connection with {@link CLEANUP_JOB_OPTIONS} as job
 * defaults and an `error` listener attached.
 */
export function createQueue(connection: ConnectionOptions, options: QueueOptions = {}): CleanupQueue {
  const queue = new Queue<CleanupJobData, CleanupJobResult>(CLEANUP_QUEUE, {
    connection,
    defaultJobOptions: CLEANUP_JOB_OPTIONS,
  });
  queue.on("error", options.onError ?? ((error: Error) => console.error("protoloom: cleanup queue error:", error.message)));
  return queue;
}

/** Length of the window in which manual runs of one repository share a job id. */
export const MANUAL_RUN_WINDOW_MS = 60_000;

/**
 * The deterministic id of a manual cleanup of `repository` started at `now`:
 * `cleanup-repo-<repository>-<minute bucket>` (BullMQ forbids `:` in custom ids).
 */
export function manualCleanupJobId(repository: string, now: Date = new Date()): string {
  return `cleanup-repo-${repository}-${Math.floor(now.getTime() / MANUAL_RUN_WINDOW_MS)}`;
}

/**
 * Enqueues a cleanup of one repository and returns the job id. Throws
 * {@link QueueUnavailableError} when Valkey can't be reached within the timeout.
 *
 * The job id is {@link manualCleanupJobId}: BullMQ ignores an add whose id already exists (while
 * the job is queued, running, or kept after finishing), so every run requested for the same
 * repository within the same minute, including a retry after an add that timed out but was
 * delivered, maps to one job and the cleanup runs once. Such a request returns the existing job's id.
 */
export async function enqueueCleanup(
  queue: CleanupQueue,
  repository: string,
  options: ProducerOptions & { now?: Date } = {},
): Promise<string> {
  const job = await withinTimeout(
    queue.add(
      "cleanup:repo",
      { kind: "cleanup:repo", repository },
      { jobId: manualCleanupJobId(repository, options.now) },
    ),
    options.timeoutMs ?? PRODUCER_TIMEOUT_MS,
  );
  if (!job.id) throw new Error("BullMQ returned a job without an id");
  return job.id;
}

/**
 * Looks up a cleanup job; `state` is `unknown` when the id does not exist (or was already
 * removed). Throws {@link QueueUnavailableError} when Valkey can't be reached within the timeout.
 */
export async function getJobState(
  queue: CleanupQueue,
  jobId: string,
  options: ProducerOptions = {},
): Promise<CleanupJobStatus> {
  const lookup = async (): Promise<CleanupJobStatus> => {
    const job = await queue.getJob(jobId);
    if (!job) return { state: "unknown", result: null, failedReason: null };
    const state = await job.getState();
    return {
      state,
      result: state === "completed" ? (job.returnvalue ?? null) : null,
      failedReason: state === "failed" ? (job.failedReason ?? null) : null,
    };
  };
  return withinTimeout(lookup(), options.timeoutMs ?? PRODUCER_TIMEOUT_MS);
}

/** Creates or updates the daily cleanup scheduler; calling it again never adds a second one. */
export async function scheduleDailyCleanup(queue: CleanupQueue): Promise<void> {
  await queue.upsertJobScheduler(
    DAILY_SCHEDULER_ID,
    { pattern: DAILY_CLEANUP_PATTERN },
    { name: "cleanup:all", data: { kind: "cleanup:all" }, opts: CLEANUP_JOB_OPTIONS },
  );
}
