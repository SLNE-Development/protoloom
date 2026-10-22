import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { updateSettings } from "@weaver/core";
import { user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAuth, type Auth, type AuthEnv } from "./auth";
import { resolveAppSession } from "./session";

const env: AuthEnv = {
  BETTER_AUTH_SECRET: "session-secret-session-secret-0123456",
  BETTER_AUTH_URL: "http://localhost:3000",
  INITIAL_ADMIN: undefined,
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;
let auth: Auth;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  auth = createAuth(db, env);
});

afterAll(async () => {
  await testDb?.stop();
});

async function createUser(role: string) {
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name: `A ${role}`, email: `${randomUUID()}@example.com`, role, createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

async function sessionHeaders(userId: string) {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const signed = `${session.token}.${await makeSignature(session.token, env.BETTER_AUTH_SECRET)}`;
  return new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}` });
}

describe("resolveAppSession", () => {
  it("is anonymous without a session and carries the stored settings", async () => {
    expect(await resolveAppSession(new Headers(), { db, auth })).toEqual({
      principal: { kind: "anonymous" },
      user: null,
      settings: { anonymousView: false },
    });

    const admin = await createUser("admin");
    await updateSettings(db, { anonymousView: true }, { kind: "user", userId: admin.id, role: "admin" });
    const result = await resolveAppSession(new Headers(), { db, auth });
    expect(result.settings).toEqual({ anonymousView: true });
    await updateSettings(db, { anonymousView: false }, { kind: "user", userId: admin.id, role: "admin" });
  });

  it("resolves a session cookie to the user with their current role", async () => {
    const member = await createUser("maintainer");
    const headers = await sessionHeaders(member.id);
    const result = await resolveAppSession(headers, { db, auth });
    expect(result.principal).toEqual({ kind: "user", userId: member.id, role: "maintainer" });
    expect(result.user).toEqual({ id: member.id, name: member.name, email: member.email, image: null, role: "maintainer" });

    await db.update(user).set({ role: "viewer" }).where(eq(user.id, member.id));
    expect((await resolveAppSession(headers, { db, auth })).principal).toMatchObject({ role: "viewer" });
  });

  it("treats a banned user as anonymous", async () => {
    const member = await createUser("viewer");
    const headers = await sessionHeaders(member.id);
    await db.update(user).set({ banned: true }).where(eq(user.id, member.id));
    const result = await resolveAppSession(headers, { db, auth });
    expect(result.principal).toEqual({ kind: "anonymous" });
    expect(result.user).toBeNull();
  });
});
