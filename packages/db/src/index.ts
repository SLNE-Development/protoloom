import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { migrate } from "./migrate.js";

/** Drizzle database handle bound to the Protoloom schema. */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

/** Transaction handle passed to `db.transaction` callbacks. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Opens a node-postgres pool for `url` and wraps it in a schema-aware drizzle instance. */
export function createDb(url: string): Db {
  return drizzle(new pg.Pool({ connectionString: url }), { schema });
}
