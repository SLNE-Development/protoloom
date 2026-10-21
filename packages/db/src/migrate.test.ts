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
});
