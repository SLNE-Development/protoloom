import { encryptSecret } from "@weaver/core";
import { npmLoginSession, user } from "@weaver/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./test/harness.js";
import { hashPollSecret, LOGIN_SESSION_TTL_MS } from "./login.js";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
  await h.createRepo({ name: "npm-hosted", format: "npm", kind: "hosted", visibility: "private" });
  await h.db.insert(user).values([
    { id: "user-admin", name: "Ada Admin", email: "admin@example.com" },
    { id: "user-writer", name: "writer", email: "writer@example.com" },
  ]);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts a web login on `npm-hosted` and returns the session id and the poll secret. */
async function startLogin(): Promise<{ id: string; secret: string; loginUrl: string; doneUrl: string }> {
  const res = await h.call("POST", "npm-hosted/-/v1/login", { json: { hostname: "laptop" } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { loginUrl: string; doneUrl: string };
  const id = body.loginUrl.split("/").pop()!;
  const secret = body.doneUrl.split("/").pop()!;
  return { id, secret, ...body };
}

/** Polls the `doneUrl` of a session by its secret. */
function poll(secret: string): Promise<Response> {
  return h.call("GET", `npm-hosted/-/v1/login/done/${secret}`);
}

describe("npm whoami", () => {
  it("whoami returns the token owner's name", async () => {
    const res = await h.call("GET", "npm-hosted/-/whoami", { token: h.tokens.writer });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ username: "writer" });
    const session = await h.call("GET", "npm-hosted/-/whoami", { token: h.tokens.admin });
    expect(await session.json()).toEqual({ username: "Ada Admin" });
  });

  it("whoami anonymous is 401", async () => {
    const res = await h.call("GET", "npm-hosted/-/whoami");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Weaver"');
  });
});

describe("npm web login", () => {
  it("web login round trip", async () => {
    const { id, secret, loginUrl, doneUrl } = await startLogin();
    expect(loginUrl.startsWith("https://weaver.slne.dev/cli-login/")).toBe(true);
    expect(doneUrl).toBe(`https://weaver.slne.dev/npm/npm-hosted/-/v1/login/done/${secret}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const pending = await poll(secret);
    expect(pending.status).toBe(202);
    expect(pending.headers.get("retry-after")).toBe("2");
    expect(await pending.json()).toEqual({});

    await h.db
      .update(npmLoginSession)
      .set({ status: "approved", userId: "user-writer", tokenCiphertext: encryptSecret(h.deps.secretKey, "wv_tok") })
      .where(eq(npmLoginSession.id, id));
    const done = await poll(secret);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ token: "wv_tok" });

    const again = await poll(secret);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "login session not found or expired" });
  });

  it("denied login is 403 and removed", async () => {
    const { id, secret } = await startLogin();
    await h.db.update(npmLoginSession).set({ status: "denied" }).where(eq(npmLoginSession.id, id));
    const res = await poll(secret);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "login was denied" });
    expect(await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id))).toEqual([]);
  });

  it("expired session is 404", async () => {
    const { id, secret } = await startLogin();
    const [row] = await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(LOGIN_SESSION_TTL_MS - 5_000);
    expect(row!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(LOGIN_SESSION_TTL_MS);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const res = await poll(secret);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "login session not found or expired" });
  });

  it("starting a login deletes expired sessions", async () => {
    const { id } = await startLogin();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await startLogin();
    expect(await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id))).toEqual([]);
  });

  it("poll secret is not stored in plain text", async () => {
    const { id, secret } = await startLogin();
    const [row] = await h.db.select().from(npmLoginSession).where(eq(npmLoginSession.id, id));
    expect(row!.pollHash).not.toBe(secret);
    expect(row!.pollHash).toBe(hashPollSecret(secret));
    expect(row!.pollHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.status).toBe("pending");
    expect(row!.tokenCiphertext).toBeNull();
  });

  it("login only accepts POST", async () => {
    const res = await h.call("GET", "npm-hosted/-/v1/login");
    expect(res.status).toBe(405);
  });
});

describe("npm legacy login", () => {
  it("legacy login accepts a token as password", async () => {
    const res = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", {
      json: { _id: "org.couchdb.user:writer", name: "writer", password: h.tokens.writer, type: "user", roles: [] },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "org.couchdb.user:writer", token: h.tokens.writer });
  });

  it("legacy login rejects a non-token password with 401", async () => {
    const wrong = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer", password: "hunter2" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "use a Weaver access token as the password" });
    const session = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer", password: h.tokens.admin } });
    expect(session.status).toBe(401);
    const missing = await h.call("PUT", "npm-hosted/-/user/org.couchdb.user:writer", { json: { name: "writer" } });
    expect(missing.status).toBe(401);
  });
});
