import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Applies all pending SQL migrations from the package's `drizzle` folder. */
export async function migrate(db: Db): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder });
}
