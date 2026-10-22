import { protoCleanup, type CleanupRegistry } from "@weaver/core";
import { mavenCleanup } from "@weaver/maven";

/** The format cleanups the web server previews with, by format. */
export function cleanupRegistry(): CleanupRegistry {
  return { proto: protoCleanup, maven: mavenCleanup };
}
