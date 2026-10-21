import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";

// Built with path.join rather than `new URL("../drizzle", import.meta.url)`, which bundlers
// (Next.js/Turbopack) try to resolve as a module. The folder ships next to the compiled package.
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/** Applies all pending SQL migrations from the package's `drizzle` folder. */
export async function migrate(db: Db): Promise<void> {
  await drizzleMigrate(db, { migrationsFolder });
}
