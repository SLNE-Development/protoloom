import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditEvent } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import type { Principal } from "./permissions.js";
import { getSettings, updateSettings } from "./settings.js";

const admin: Principal = { kind: "user", userId: "user-admin", role: "admin" };
const maintainer: Principal = { kind: "user", userId: "user-maintainer", role: "maintainer" };

describe("settings", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;

  beforeAll(async () => {
    testDb = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE setting, audit_event`);
  });

  it("defaults to anonymous view off on an empty database", async () => {
    expect(await getSettings(testDb.db)).toEqual({ anonymousView: false });
  });

  it("persists an update, returns the new settings and audits the change", async () => {
    expect(await updateSettings(testDb.db, { anonymousView: true }, admin)).toEqual({ anonymousView: true });
    expect(await getSettings(testDb.db)).toEqual({ anonymousView: true });

    expect(await updateSettings(testDb.db, { anonymousView: false }, admin)).toEqual({ anonymousView: false });
    expect(await getSettings(testDb.db)).toEqual({ anonymousView: false });

    const audits = await testDb.db
      .select({ actorType: auditEvent.actorType, actorId: auditEvent.actorId, action: auditEvent.action, details: auditEvent.details })
      .from(auditEvent)
      .orderBy(auditEvent.at);
    expect(audits).toEqual([
      { actorType: "user", actorId: "user-admin", action: "settings.update", details: { anonymousView: true } },
      { actorType: "user", actorId: "user-admin", action: "settings.update", details: { anonymousView: false } },
    ]);
  });

  it("leaves settings untouched for an empty patch", async () => {
    await updateSettings(testDb.db, { anonymousView: true }, admin);
    expect(await updateSettings(testDb.db, {}, admin)).toEqual({ anonymousView: true });
  });

  it("refuses updates from non-admins", async () => {
    await expect(updateSettings(testDb.db, { anonymousView: true }, maintainer)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await getSettings(testDb.db)).toEqual({ anonymousView: false });
  });
});
