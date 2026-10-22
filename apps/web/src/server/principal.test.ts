import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { RegistryError } from "@weaver/core";
import { apiKeyPermission, apikey, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAuth, type Auth, type AuthEnv } from "./auth";
import { getPrincipal } from "./principal";

const env: AuthEnv = {
  BETTER_AUTH_SECRET: "principal-secret-principal-secret-0123",
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
    .values({ id: randomUUID(), name: role, email: `${randomUUID()}@example.com`, role, createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

async function createKey(userId: string) {
  const created = await auth.api.createApiKey({ body: { userId, name: "ci" } });
  await db.insert(apiKeyPermission).values([
    { apiKeyId: created.id, repository: "main", groupPrefix: "dev.surf", access: "write" },
    { apiKeyId: created.id, repository: "public", groupPrefix: null, access: "read" },
  ]);
  return created;
}

function bearer(key: string) {
  return new Request("http://localhost:3000/api/v1/x", { headers: { authorization: `Bearer ${key}` } });
}

async function expectUnauthorized(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RegistryError);
  expect((error as RegistryError).code).toBe("unauthorized");
}

describe("getPrincipal", () => {
  it("returns anonymous without credentials", async () => {
    const principal = await getPrincipal(new Request("http://localhost:3000/api/v1/x"), { db, auth });
    expect(principal).toEqual({ kind: "anonymous" });
  });

  it("resolves a valid key to its owner's role and permission entries", async () => {
    const owner = await createUser("maintainer");
    const key = await createKey(owner.id);
    const principal = await getPrincipal(bearer(key.key), { db, auth });
    expect(principal).toEqual({
      kind: "apikey",
      keyId: key.id,
      userId: owner.id,
      role: "maintainer",
      permissions: expect.arrayContaining([
        { repository: "main", groupPrefix: "dev.surf", access: "write" },
        { repository: "public", groupPrefix: null, access: "read" },
      ]),
    });
    if (principal.kind === "apikey") expect(principal.permissions).toHaveLength(2);
  });

  it("rejects garbage, empty, expired and revoked keys", async () => {
    await expectUnauthorized(getPrincipal(bearer("not-a-real-key"), { db, auth }));
    await expectUnauthorized(
      getPrincipal(new Request("http://localhost/", { headers: { authorization: "Bearer " } }), { db, auth }),
    );

    const owner = await createUser("maintainer");
    const expired = await createKey(owner.id);
    await db.update(apikey).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(apikey.id, expired.id));
    await expectUnauthorized(getPrincipal(bearer(expired.key), { db, auth }));

    const revoked = await createKey(owner.id);
    await db.delete(apikey).where(eq(apikey.id, revoked.id));
    await expectUnauthorized(getPrincipal(bearer(revoked.key), { db, auth }));

    const disabled = await createKey(owner.id);
    await db.update(apikey).set({ enabled: false }).where(eq(apikey.id, disabled.id));
    await expectUnauthorized(getPrincipal(bearer(disabled.key), { db, auth }));
  });

  it("uses the owner's current role on every request", async () => {
    const owner = await createUser("maintainer");
    const key = await createKey(owner.id);
    expect(await getPrincipal(bearer(key.key), { db, auth })).toMatchObject({ role: "maintainer" });
    await db.update(user).set({ role: "viewer" }).where(eq(user.id, owner.id));
    expect(await getPrincipal(bearer(key.key), { db, auth })).toMatchObject({ role: "viewer" });
  });

  it("rejects a key whose owner is banned, and accepts it again once the ban expired", async () => {
    const owner = await createUser("maintainer");
    const key = await createKey(owner.id);
    await db.update(user).set({ banned: true }).where(eq(user.id, owner.id));
    await expectUnauthorized(getPrincipal(bearer(key.key), { db, auth }));

    await db.update(user).set({ banExpires: new Date(Date.now() - 1000) }).where(eq(user.id, owner.id));
    expect(await getPrincipal(bearer(key.key), { db, auth })).toMatchObject({ kind: "apikey" });
  });

  it("resolves a session cookie to a user principal", async () => {
    const member = await createUser("viewer");
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(member.id);
    const signed = `${session.token}.${await makeSignature(session.token, env.BETTER_AUTH_SECRET)}`;
    const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
    const principal = await getPrincipal(new Request("http://localhost:3000/", { headers: { cookie } }), { db, auth });
    expect(principal).toEqual({ kind: "user", userId: member.id, role: "viewer" });
  });
});
