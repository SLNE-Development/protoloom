import { protoCleanup, type CleanupRegistry } from "@weaver/core";

/** The format cleanups the worker runs, by format. */
export function cleanupRegistry(): CleanupRegistry {
  return { proto: protoCleanup };
}
