import { createBlobStoreFromEnv, type BlobStore } from "@protoloom/core";
import { createDb, type Db } from "@protoloom/db";
import { env } from "../env";
import { createAuth, type Auth } from "./auth";

/** Process-wide server dependencies. */
export interface ServerContext {
  db: Db;
  blobs: BlobStore;
  auth: Auth;
}

// Kept on globalThis so dev-mode module reloads reuse the same pool instead of leaking one per reload.
const globalForContext = globalThis as typeof globalThis & { __protoloomServerContext?: ServerContext };

/** The lazily created server dependencies, built once per process from `env`. */
export function getServerContext(): ServerContext {
  if (!globalForContext.__protoloomServerContext) {
    const db = createDb(env.DATABASE_URL);
    // The blob store reads only the validated STORAGE_* / S3_* values; the cast bridges to the
    // ProcessEnv parameter type (which Next.js augments with a required NODE_ENV).
    const storageEnv: Record<string, string | undefined> = { ...env };
    globalForContext.__protoloomServerContext = {
      db,
      blobs: createBlobStoreFromEnv(storageEnv as NodeJS.ProcessEnv),
      auth: createAuth(db),
    };
  }
  return globalForContext.__protoloomServerContext;
}
