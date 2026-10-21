import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { repository } from "./schema/index.js";
import { startTestDb } from "./testing.js";

describe("schema migrations", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("applies defaults to a freshly inserted repository", async () => {
    const { db } = testDb;
    await db.insert(repository).values({ name: "main" });
    const [row] = await db.select().from(repository).where(eq(repository.name, "main"));
    expect(row?.visibility).toBe("private");
    expect(row?.allowRedeploy).toBe(false);
    expect(row?.allowReleases).toBe(true);
    expect(row?.resolutionPriority).toBe(100);
  });

  it("indexes api_key_permission by api_key_id", async () => {
    const { rows } = await testDb.db.$client.query(
      "select indexdef from pg_indexes where tablename = 'api_key_permission' and indexname = 'api_key_permission_api_key_id_idx'",
    );
    expect(rows).toEqual([{ indexdef: expect.stringContaining("(api_key_id)") }]);
  });

  it("creates the deleted_release tombstone table keyed by repository and coordinate", async () => {
    const { rows } = await testDb.db.$client.query(
      "select indexdef from pg_indexes where tablename = 'deleted_release' and indexname like '%_pk'",
    );
    expect(rows).toEqual([{ indexdef: expect.stringContaining('(repository_id, "group", name, version)') }]);
  });
});
