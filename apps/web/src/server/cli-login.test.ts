import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { decryptSecret, deriveSecretKey, type Principal, type Role } from "@weaver/core";
import { apikey, npmLoginSession, repository, user, type Db } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { hashPollSecret, LOGIN_SESSION_TTL_MS } from "@weaver/npm";
import { createAuth, type Auth, type AuthEnv } from "./auth";
import { approveCliLogin, defaultCliLoginForm, denyCliLogin, loadCliLogin } from "./cli-login";
import { getPrincipal } from "./principal";

const env: AuthEnv = {
  BETTER_AUTH_SECRET: "cli-login-secret-cli-login-secret-0123",
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
const secretKey = deriveSecretKey(env.BETTER_AUTH_SECRET);
let npmRepoId = "";

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  auth = createAuth(db, env);
  const [row] = await db
    .insert(repository)
    .values({ name: "npm-hosted", visibility: "private", format: "npm", kind: "hosted" })
    .returning({ id: repository.id });
  npmRepoId = row!.id;
  await db.insert(repository).values({ name: "npm-group", visibility: "private", format: "npm", kind: "group" });
});

afterAll(async () => {
  await testDb?.stop();
});

/** Inserts a user with `role` and returns its session principal. */
async function createUser(role: Role): Promise<Extract<Principal, { kind: "user" }>> {
  const now = new Date();
  const id = randomUUID();
  await db.insert(user).values({ id, name: role, email: `${id}@example.com`, role, createdAt: now, updatedAt: now });
  return { kind: "user", userId: id, role };
}

/** Inserts a login session for `npm-hosted` that expires `ttlMs` from now; returns its id. */
async function createSession(ttlMs = LOGIN_SESSION_TTL_MS): Promise<string> {
  const id = randomUUID();
  await db.insert(npmLoginSession).values({
    id,
    pollHash: hashPollSecret(randomUUID()),
    repositoryId: npmRepoId,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return id;
}

/** The API keys owned by `userId`. */
function keysOf(userId: string) {
  return db.select({ id: apikey.id }).from(apikey).where(eq(apikey.referenceId, userId));
}

/** The TRPCError code a promise rejects with. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TRPCError);
  return (error as TRPCError).code;
}

const writeInput = {
  name: "npm login",
  expiresInDays: 90,
  permissions: [{ repository: "npm-hosted", groupPrefix: null, access: "write" as const }],
};

describe("cli login", () => {
  it("shows a pending session with its repository and creation time", async () => {
    const id = await createSession();
    const view = await loadCliLogin(db, id);
    expect(view.state).toBe("pending");
    if (view.state !== "pending") return;
    expect(view.repository).toEqual({ name: "npm-hosted", format: "npm", kind: "hosted" });
    expect(view.createdAt).toBeInstanceOf(Date);
    expect(view.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await loadCliLogin(db, "nope")).toEqual({ state: "gone" });
    expect(await loadCliLogin(db, await createSession(-1_000))).toEqual({ state: "gone" });
  });

  it("approve issues a key with the chosen permissions and stores it encrypted", async () => {
    const owner = await createUser("maintainer");
    const id = await createSession();
    await approveCliLogin({ db, auth, secretKey }, owner, id, writeInput);
    const [row] = await db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.status).toBe("approved");
    expect(row!.userId).toBe(owner.userId);
    expect(row!.tokenCiphertext).not.toBeNull();
    const key = decryptSecret(secretKey, row!.tokenCiphertext!);
    expect(row!.tokenCiphertext).not.toContain(key);
    const principal = await getPrincipal(new Request("http://localhost:3000/npm/x", { headers: { authorization: `Bearer ${key}` } }), {
      db,
      auth,
    });
    expect(principal).toMatchObject({
      kind: "apikey",
      userId: owner.userId,
      permissions: [{ repositoryId: npmRepoId, repository: "npm-hosted", groupPrefix: null, access: "write" }],
    });
    expect(await loadCliLogin(db, id)).toEqual({ state: "gone" });
  });

  it("viewer gets read only by default", () => {
    const d = new Date("2026-10-22T12:00:00Z");
    const form = defaultCliLoginForm("npm-hosted", "viewer", d);
    expect(form.permissions[0]!.access).toBe("read");
    expect(defaultCliLoginForm("npm-hosted", "maintainer", d)).toEqual({
      name: "npm login 2026-10-22",
      expiry: "90",
      permissions: [{ repository: "npm-hosted", groupPrefix: "", access: "write" }],
    });
    expect(defaultCliLoginForm("npm-group", "admin", d, "group").permissions[0]!.access).toBe("read");
  });

  it("viewer asking for write is FORBIDDEN", async () => {
    const viewer = await createUser("viewer");
    const id = await createSession();
    expect(await codeOf(approveCliLogin({ db, auth, secretKey }, viewer, id, writeInput))).toBe("FORBIDDEN");
    expect(await keysOf(viewer.userId)).toEqual([]);
    expect((await loadCliLogin(db, id)).state).toBe("pending");
  });

  it("write on a group is rejected like in the keys dialog", async () => {
    const owner = await createUser("maintainer");
    const id = await createSession();
    const input = { ...writeInput, permissions: [{ repository: "npm-group", groupPrefix: null, access: "write" as const }] };
    expect(await codeOf(approveCliLogin({ db, auth, secretKey }, owner, id, input))).toBe("BAD_REQUEST");
    expect(await keysOf(owner.userId)).toEqual([]);
  });

  it("approving an expired session fails and leaves no key", async () => {
    const owner = await createUser("maintainer");
    const id = await createSession(-1_000);
    expect(await codeOf(approveCliLogin({ db, auth, secretKey }, owner, id, writeInput))).toBe("NOT_FOUND");
    expect(await keysOf(owner.userId)).toEqual([]);
    const [row] = await db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.status).toBe("pending");
    expect(row!.tokenCiphertext).toBeNull();
  });

  it("approving twice fails the second time", async () => {
    const owner = await createUser("maintainer");
    const id = await createSession();
    await approveCliLogin({ db, auth, secretKey }, owner, id, writeInput);
    const [first] = await db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(await codeOf(approveCliLogin({ db, auth, secretKey }, owner, id, writeInput))).toBe("NOT_FOUND");
    expect(await keysOf(owner.userId)).toHaveLength(1);
    const [second] = await db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(second!.tokenCiphertext).toBe(first!.tokenCiphertext);
  });

  it("concurrent approvals issue exactly one key", async () => {
    const owner = await createUser("maintainer");
    const id = await createSession();
    const results = await Promise.allSettled([
      approveCliLogin({ db, auth, secretKey }, owner, id, writeInput),
      approveCliLogin({ db, auth, secretKey }, owner, id, writeInput),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await keysOf(owner.userId)).toHaveLength(1);
  });

  it("deny marks the row denied", async () => {
    const id = await createSession();
    await denyCliLogin(db, id);
    const [row] = await db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.status).toBe("denied");
    expect(row!.tokenCiphertext).toBeNull();
    expect(await loadCliLogin(db, id)).toEqual({ state: "gone" });
  });
});
