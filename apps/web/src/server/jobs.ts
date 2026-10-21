import { createQueue, producerConnection, type CleanupQueue } from "@protoloom/jobs";
import { env } from "@/env";

// Kept on globalThis so dev-mode module reloads reuse one connection instead of leaking one per reload.
const globalForJobs = globalThis as typeof globalThis & { __protoloomCleanupQueue?: CleanupQueue };

/**
 * The process-wide producer queue for cleanup jobs, opened lazily with a fail-fast connection
 * (see `producerConnection`); `null` when `VALKEY_URL` is not configured.
 */
export function getCleanupQueue(): CleanupQueue | null {
  if (!env.VALKEY_URL) return null;
  globalForJobs.__protoloomCleanupQueue ??= createQueue(producerConnection(env.VALKEY_URL));
  return globalForJobs.__protoloomCleanupQueue;
}
