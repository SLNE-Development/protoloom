import { createRegistry, createStoreSetFromEnv, type Registry, type StoreSet } from "@weaver/core";
import { createDb, type Db } from "@weaver/db";
import { env } from "../env";
import { createAuth, type Auth } from "./auth";

/** Process-wide server dependencies. */
export interface ServerContext {
  db: Db;
  /** The configured object stores; hosted writes go to `stores.primary`. */
  stores: StoreSet;
  auth: Auth;
  /** The registry service over `db` and `stores`. */
  registry: Registry;
}

// Kept on globalThis so dev-mode module reloads reuse the same pool instead of leaking one per reload.
const globalForContext = globalThis as typeof globalThis & { __weaverServerContext?: ServerContext };

/** The lazily created server dependencies, built once per process from `env`. */
export function getServerContext(): ServerContext {
  if (!globalForContext.__weaverServerContext) {
    const db = createDb(env.DATABASE_URL);
    // The object stores read only the validated STORAGE_* / S3_* values.
    const stores = createStoreSetFromEnv(env);
    globalForContext.__weaverServerContext = {
      db,
      stores,
      auth: createAuth(db),
      registry: createRegistry({ db, stores }),
    };
  }
  return globalForContext.__weaverServerContext;
}
