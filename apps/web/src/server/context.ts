import { createBlobStoreFromEnv, createRegistry, deriveSecretKey, type BlobStore, type Registry } from "@weaver/core";
import { createDb, type Db } from "@weaver/db";
import { env } from "../env";
import { createAuth, type Auth } from "./auth";

/** Process-wide server dependencies. */
export interface ServerContext {
  db: Db;
  blobs: BlobStore;
  auth: Auth;
  /** The registry service over `db` and `blobs`. */
  registry: Registry;
  /** AES key for upstream credentials, derived once from `BETTER_AUTH_SECRET`. */
  secretKey: Buffer;
}

// Kept on globalThis so dev-mode module reloads reuse the same pool instead of leaking one per reload.
const globalForContext = globalThis as typeof globalThis & { __weaverServerContext?: ServerContext };

/** The lazily created server dependencies, built once per process from `env`. */
export function getServerContext(): ServerContext {
  if (!globalForContext.__weaverServerContext) {
    const db = createDb(env.DATABASE_URL);
    // The blob store reads only the validated STORAGE_* / S3_* values; the cast bridges to the
    // ProcessEnv parameter type (which Next.js augments with a required NODE_ENV).
    const storageEnv: Record<string, string | undefined> = { ...env };
    const blobs = createBlobStoreFromEnv(storageEnv as NodeJS.ProcessEnv);
    globalForContext.__weaverServerContext = {
      db,
      blobs,
      auth: createAuth(db),
      registry: createRegistry({ db, blobs }),
      secretKey: deriveSecretKey(env.BETTER_AUTH_SECRET),
    };
  }
  return globalForContext.__weaverServerContext;
}
