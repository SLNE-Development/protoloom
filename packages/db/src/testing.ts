import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDb, migrate, type Db } from "./index.js";

/** Starts a throwaway `postgres:17-alpine` container and returns a migrated database. */
export async function startTestDb(): Promise<{ db: Db; url: string; stop(): Promise<void> }> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  const db = createDb(url);
  await migrate(db);
  return {
    db,
    url,
    async stop() {
      await db.$client.end();
      await container.stop();
    },
  };
}
