import { protoCleanup, type CleanupRegistry } from "@weaver/core";
import { mavenCleanup } from "@weaver/maven";
import { npmCleanup } from "@weaver/npm";

/** The format cleanups the worker runs, by format. */
export function cleanupRegistry(): CleanupRegistry {
  return { proto: protoCleanup, maven: mavenCleanup, npm: npmCleanup };
}
