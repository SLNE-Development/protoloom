import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createLocalStore, createRegistry, packArchive, RegistryError, type ProtoFile } from "@protoloom/core";
import { apiKeyPermission, repository, user, type Db } from "@protoloom/db";
import { startTestDb } from "@protoloom/db/testing";
import { createAuth, type Auth, type AuthEnv } from "@/server/auth";
import type { ServerContext } from "@/server/context";
import { handle } from "@/server/http";
import { POST as resolveRoute } from "./resolve/route";
import { GET as listRoute } from "./repos/[repo]/artifacts/[group]/[name]/route";
import {
  DELETE as deleteRoute,
  GET as manifestRoute,
  PUT as publishRoute,
} from "./repos/[repo]/artifacts/[group]/[name]/[version]/route";
import {
  GET as archiveRoute,
  HEAD as archiveHead,
} from "./repos/[repo]/artifacts/[group]/[name]/[version]/archive/route";

const holder = vi.hoisted(() => ({ ctx: undefined as ServerContext | undefined }));

vi.mock("@/server/context", () => ({
  getServerContext: () => {
    if (!holder.ctx) throw new Error("test server context is not initialised");
    return holder.ctx;
  },
}));

const BASE = "http://localhost:3000";

const authEnv: AuthEnv = {
  BETTER_AUTH_SECRET: "api-test-secret-api-test-secret-0123456",
  BETTER_AUTH_URL: BASE,
  INITIAL_ADMIN: undefined,
  GITHUB_CLIENT_ID: "gh-id",
  GITHUB_CLIENT_SECRET: "gh-secret",
  DISCORD_CLIENT_ID: undefined,
  DISCORD_CLIENT_SECRET: undefined,
};

type Params = { repo: string; group: string; name: string; version: string };

let testDb: Awaited<ReturnType<typeof startTestDb>>;
let db: Db;
let auth: Auth;
let blobDir: string;

/** API keys used across the tests; created once, permissions refer to repositories by name. */
const keys = { maintainer: "", reader: "", admin: "", viewerOwned: "" };

function proto(path: string, body: string, imports: string[] = []): ProtoFile {
  const pkg = path.replace(/\/[^/]+$/, "").replaceAll("/", ".");
  const importLines = imports.map((i) => `import "${i}";`).join("\n");
  return { path, content: `syntax = "proto3";\npackage ${pkg};\n${importLines}\n${body}\n` };
}

const moneyFiles = [proto("acme/money/v1/money.proto", "message Money { int64 cents = 1; }")];
const orderFiles = [
  proto("acme/order/v1/order.proto", "message Order { acme.money.v1.Money total = 1; }", ["acme/money/v1/money.proto"]),
];

async function createUser(role: string) {
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({ id: randomUUID(), name: `${role} user`, email: `${randomUUID()}@example.com`, role, createdAt: now, updatedAt: now })
    .returning();
  return row!;
}

async function createKey(role: string, permissions: { repository: string; access: "read" | "write" }[]) {
  const owner = await createUser(role);
  const created = await auth.api.createApiKey({ body: { userId: owner.id, name: `${role}-key` } });
  await db
    .insert(apiKeyPermission)
    .values(permissions.map((p) => ({ apiKeyId: created.id, repository: p.repository, groupPrefix: null, access: p.access })));
  return created.key;
}

function headers(token?: string, extra: Record<string, string> = {}): Record<string, string> {
  return token ? { authorization: `Bearer ${token}`, ...extra } : extra;
}

function artifactUrl(p: Params, suffix = ""): string {
  return `${BASE}/api/v1/repos/${p.repo}/artifacts/${p.group}/${p.name}/${p.version}${suffix}`;
}

const ctxOf = <T>(params: T) => ({ params: Promise.resolve(params) });

async function publish(
  p: Params,
  opts: { token?: string; files?: ProtoFile[]; dependencies?: string[]; manifest?: object; query?: string } = {},
): Promise<Response> {
  const form = new FormData();
  const manifest = opts.manifest ?? { group: p.group, name: p.name, version: p.version, dependencies: opts.dependencies ?? [] };
  form.set("manifest", JSON.stringify(manifest));
  const archive = await packArchive(opts.files ?? moneyFiles);
  form.set("archive", new Blob([new Uint8Array(archive)], { type: "application/gzip" }), "archive.tar.gz");
  const req = new Request(artifactUrl(p, opts.query ?? ""), { method: "PUT", headers: headers(opts.token), body: form });
  return publishRoute(req, ctxOf(p));
}

async function errorOf(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
  expect(typeof body.error.message).toBe("string");
  return body.error;
}

const money: Params = { repo: "releases", group: "acme", name: "money", version: "1.0.0" };
const order: Params = { repo: "releases", group: "acme", name: "order", version: "1.0.0" };

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  auth = createAuth(db, authEnv);
  blobDir = await mkdtemp(join(tmpdir(), "protoloom-api-"));
  const blobs = createLocalStore(blobDir);
  holder.ctx = { db, blobs, auth, registry: createRegistry({ db, blobs }) };
  keys.maintainer = await createKey("maintainer", [
    { repository: "releases", access: "write" },
    { repository: "private", access: "write" },
  ]);
  keys.reader = await createKey("maintainer", [{ repository: "private", access: "read" }]);
  keys.admin = await createKey("admin", [{ repository: "releases", access: "write" }]);
  keys.viewerOwned = await createKey("viewer", [{ repository: "releases", access: "write" }]);
});

afterAll(async () => {
  holder.ctx = undefined;
  await testDb?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE repository, audit_event CASCADE`);
  await db.insert(repository).values([
    { name: "releases", visibility: "public", allowSnapshots: false },
    { name: "private", visibility: "private" },
  ]);
});

describe("PUT publish", () => {
  it("publishes, then lists the version, serves the manifest and the archive", async () => {
    const res = await publish(money, { token: keys.maintainer });
    expect(res.status).toBe(201);
    const published = (await res.json()) as { coordinate: string; buildNumber: number; sha256: string; redeployed: boolean };
    expect(published).toEqual({
      coordinate: "acme:money:1.0.0",
      buildNumber: 1,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      redeployed: false,
    });

    const list = await listRoute(
      new Request(`${BASE}/api/v1/repos/releases/artifacts/acme/money`),
      ctxOf({ repo: "releases", group: "acme", name: "money" }),
    );
    expect(list.status).toBe(200);
    const { versions } = (await list.json()) as { versions: { version: string; isSnapshot: boolean; latestBuild: number; updatedAt: string }[] };
    expect(versions).toEqual([
      { version: "1.0.0", isSnapshot: false, latestBuild: 1, updatedAt: expect.any(String) },
    ]);
    expect(new Date(versions[0]!.updatedAt).toISOString()).toBe(versions[0]!.updatedAt);

    const manifest = await manifestRoute(new Request(artifactUrl(money)), ctxOf(money));
    expect(manifest.status).toBe(200);
    const info = (await manifest.json()) as Record<string, unknown>;
    expect(info).toMatchObject({
      repository: "releases",
      coordinate: "acme:money:1.0.0",
      buildNumber: 1,
      sha256: published.sha256,
      files: ["acme/money/v1/money.proto"],
      dependencies: [],
    });
    expect(new Date(info.createdAt as string).toISOString()).toBe(info.createdAt);

    const archive = await archiveRoute(new Request(artifactUrl(money, "/archive")), ctxOf(money));
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect(archive.headers.get("x-protoloom-sha256")).toBe(published.sha256);
    expect(archive.headers.get("content-disposition")).toBe('attachment; filename="money-1.0.0.tar.gz"');
    const bytes = Buffer.from(await archive.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(published.sha256);
  });

  it("rejects publishing an existing release as immutable", async () => {
    expect((await publish(money, { token: keys.maintainer })).status).toBe(201);
    const again = await publish(money, { token: keys.maintainer });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("immutable");
  });

  it("requires a token (401) with write access (403) on a private repository", async () => {
    const target = { ...money, repo: "private" };
    const anonymous = await publish(target);
    expect(anonymous.status).toBe(401);
    expect((await errorOf(anonymous)).code).toBe("unauthorized");

    const readOnly = await publish(target, { token: keys.reader });
    expect(readOnly.status).toBe(403);
    expect((await errorOf(readOnly)).code).toBe("forbidden");
  });

  it("rejects an invalid token with 401", async () => {
    const res = await publish(money, { token: "not-a-key" });
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("unauthorized");
  });

  it("rejects a manifest that does not match the URL with 400", async () => {
    const res = await publish(money, {
      token: keys.maintainer,
      manifest: { group: "acme", name: "money", version: "2.0.0", dependencies: [] },
    });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_request");
  });

  it("rejects a request without the multipart fields with 400", async () => {
    const form = new FormData();
    form.set("manifest", "{not json");
    const req = new Request(artifactUrl(money), { method: "PUT", headers: headers(keys.maintainer), body: form });
    const res = await publishRoute(req, ctxOf(money));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_request");
  });

  it("rejects an oversized Content-Length with 413 before reading the body", async () => {
    const req = new Request(artifactUrl(money), {
      method: "PUT",
      headers: headers(keys.maintainer, { "content-length": String(10 * 1024 * 1024 + 64 * 1024 + 1) }),
      body: "x",
    });
    const res = await publishRoute(req, ctxOf(money));
    expect(res.status).toBe(413);
    expect((await errorOf(res)).code).toBe("payload_too_large");
  });

  it("rejects a body larger than the limit with 413 even without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 12) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const req = new Request(artifactUrl(money), {
      method: "PUT",
      headers: headers(keys.maintainer, { "content-type": "multipart/form-data; boundary=x" }),
      body,
      duplex: "half",
    } as RequestInit);
    const res = await publishRoute(req, ctxOf(money));
    expect(res.status).toBe(413);
  });
});

describe("POST resolve", () => {
  it("returns the transitive artifacts with absolute archive URLs", async () => {
    expect((await publish(money, { token: keys.maintainer })).status).toBe(201);
    const published = await publish(order, { token: keys.maintainer, files: orderFiles, dependencies: ["acme:money:1.0.0"] });
    expect(published.status).toBe(201);

    const res = await resolveRoute(
      new Request(`${BASE}/api/v1/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositories: ["releases"], dependencies: ["acme:order:1.0.0"] }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: Record<string, unknown>[]; conflicts: unknown[] };
    expect(body.conflicts).toEqual([]);
    expect(body.artifacts).toEqual([
      {
        repository: "releases",
        coordinate: "acme:money:1.0.0",
        group: "acme",
        name: "money",
        version: "1.0.0",
        buildNumber: 1,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        archiveUrl: `${BASE}/api/v1/repos/releases/artifacts/acme/money/1.0.0/archive`,
      },
      {
        repository: "releases",
        coordinate: "acme:order:1.0.0",
        group: "acme",
        name: "order",
        version: "1.0.0",
        buildNumber: 1,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        archiveUrl: `${BASE}/api/v1/repos/releases/artifacts/acme/order/1.0.0/archive`,
      },
    ]);
  });

  it("leaves excluded group:name keys and their subtrees out of the resolution", async () => {
    expect((await publish(money, { token: keys.maintainer })).status).toBe(201);
    expect(
      (await publish(order, { token: keys.maintainer, files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status,
    ).toBe(201);

    const resolveWith = (body: object) =>
      resolveRoute(new Request(`${BASE}/api/v1/resolve`, { method: "POST", body: JSON.stringify(body) }));

    const withoutMoney = await resolveWith({
      repositories: ["releases"],
      dependencies: ["acme:order:1.0.0"],
      exclude: ["acme:money"],
    });
    expect(withoutMoney.status).toBe(200);
    const body = (await withoutMoney.json()) as { artifacts: { coordinate: string }[]; conflicts: unknown[] };
    expect(body.artifacts.map((a) => a.coordinate)).toEqual(["acme:order:1.0.0"]);

    const withoutOrder = await resolveWith({
      repositories: ["releases"],
      dependencies: ["acme:order:1.0.0", "acme:local:9.9.9"],
      exclude: ["acme:order", "acme:local"],
    });
    expect(withoutOrder.status).toBe(200);
    expect(((await withoutOrder.json()) as { artifacts: unknown[] }).artifacts).toEqual([]);

    const invalid = await resolveWith({ repositories: ["releases"], dependencies: [], exclude: ["acme:money:1.0.0"] });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).code).toBe("invalid_request");
  });

  it("rejects a malformed body with 400", async () => {
    const res = await resolveRoute(
      new Request(`${BASE}/api/v1/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repositories: ["releases"], dependencies: ["not-a-coordinate"] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("invalid_request");
  });

  it("reports a missing dependency as 404", async () => {
    const res = await resolveRoute(
      new Request(`${BASE}/api/v1/resolve`, {
        method: "POST",
        body: JSON.stringify({ repositories: ["releases"], dependencies: ["acme:missing:1.0.0"] }),
      }),
    );
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("not_found");
  });
});

describe("DELETE", () => {
  async function publishBoth() {
    expect((await publish(money, { token: keys.maintainer })).status).toBe(201);
    expect(
      (await publish(order, { token: keys.maintainer, files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status,
    ).toBe(201);
  }

  const del = (p: Params, token?: string, query = "") =>
    deleteRoute(new Request(artifactUrl(p, query), { method: "DELETE", headers: headers(token) }), ctxOf(p));

  it("refuses with 409 has_dependents, and lets an admin force it", async () => {
    await publishBoth();
    const blocked = await del(money, keys.maintainer);
    expect(blocked.status).toBe(409);
    const error = await errorOf(blocked);
    expect(error.code).toBe("has_dependents");
    expect(error.details).toEqual({
      dependents: [{ repository: "releases", coordinate: { group: "acme", name: "order", version: "1.0.0" } }],
      hiddenDependents: 0,
    });

    const maintainerForce = await del(money, keys.maintainer, "?force=true");
    expect(maintainerForce.status).toBe(403);

    const forced = await del(money, keys.admin, "?force=true");
    expect(forced.status).toBe(204);
    expect(await forced.text()).toBe("");
    expect((await manifestRoute(new Request(artifactUrl(money)), ctxOf(money))).status).toBe(404);
  });

  it("deletes a version without dependents with 204", async () => {
    await publishBoth();
    expect((await del(order, keys.maintainer)).status).toBe(204);
  });

  it("requires authentication (401) and the delete permission (403)", async () => {
    await publishBoth();
    expect((await del(order)).status).toBe(401);
    expect((await del(order, keys.viewerOwned)).status).toBe(403);
  });
});

describe("GET manifest and HEAD archive", () => {
  async function downloadCount(p: Params): Promise<number> {
    const res = await manifestRoute(new Request(artifactUrl(p)), ctxOf(p));
    return ((await res.json()) as { downloadCount: number }).downloadCount;
  }

  it("lists dependencies as group:name:version strings, like the coordinate", async () => {
    expect((await publish(money, { token: keys.maintainer })).status).toBe(201);
    expect(
      (await publish(order, { token: keys.maintainer, files: orderFiles, dependencies: ["acme:money:1.0.0"] })).status,
    ).toBe(201);
    const res = await manifestRoute(new Request(artifactUrl(order)), ctxOf(order));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ coordinate: "acme:order:1.0.0", dependencies: ["acme:money:1.0.0"] });
  });

  it("does not count reading the manifest as a download", async () => {
    expect((await publish(money, { token: keys.maintainer })).status).toBe(201);
    await downloadCount(money);
    expect(await downloadCount(money)).toBe(0);
  });

  it("answers HEAD on the archive with its headers only, without counting a download", async () => {
    const published = (await (await publish(money, { token: keys.maintainer })).json()) as { sha256: string };
    const get = await archiveRoute(new Request(artifactUrl(money, "/archive")), ctxOf(money));
    const size = (await get.arrayBuffer()).byteLength;
    expect(await downloadCount(money)).toBe(1);

    const head = await archiveHead(new Request(artifactUrl(money, "/archive"), { method: "HEAD" }), ctxOf(money));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/gzip");
    expect(head.headers.get("content-length")).toBe(String(size));
    expect(head.headers.get("x-protoloom-sha256")).toBe(published.sha256);
    expect(head.headers.get("content-disposition")).toBe('attachment; filename="money-1.0.0.tar.gz"');
    expect(await head.text()).toBe("");
    expect(await downloadCount(money)).toBe(1);
  });

  it("answers HEAD with 404 for a version the caller can't read", async () => {
    const hidden = { ...money, repo: "private" };
    expect((await publish(hidden, { token: keys.maintainer })).status).toBe(201);
    const head = await archiveHead(new Request(artifactUrl(hidden, "/archive"), { method: "HEAD" }), ctxOf(hidden));
    expect(head.status).toBe(404);
  });
});

describe("unknown repository", () => {
  const ghost: Params = { repo: "ghost", group: "acme", name: "money", version: "1.0.0" };

  it("answers 404 not_found on every route", async () => {
    const list = await listRoute(
      new Request(`${BASE}/api/v1/repos/ghost/artifacts/acme/money`),
      ctxOf({ repo: "ghost", group: "acme", name: "money" }),
    );
    expect(list.status).toBe(404);
    expect((await errorOf(list)).code).toBe("not_found");
    expect((await manifestRoute(new Request(artifactUrl(ghost)), ctxOf(ghost))).status).toBe(404);
    expect((await archiveRoute(new Request(artifactUrl(ghost, "/archive")), ctxOf(ghost))).status).toBe(404);
    expect((await publish(ghost, { token: keys.maintainer })).status).toBe(404);
  });

  it("does not disclose a private repository to anonymous readers", async () => {
    expect((await publish({ ...money, repo: "private" }, { token: keys.maintainer })).status).toBe(201);
    const hidden = { ...money, repo: "private" };
    expect((await manifestRoute(new Request(artifactUrl(hidden)), ctxOf(hidden))).status).toBe(404);
    const visible = await manifestRoute(new Request(artifactUrl(hidden), { headers: headers(keys.reader) }), ctxOf(hidden));
    expect(visible.status).toBe(200);
  });
});

describe("handle", () => {
  it("maps RegistryError to its status and body", async () => {
    const res = await handle(async () => {
      throw new RegistryError("validation_failed", "bad protos", { issues: [] });
    })();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "validation_failed", message: "bad protos", details: { issues: [] } } });
  });

  it("hides unknown errors behind a generic 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handle(async () => {
      throw new Error("database password is hunter2");
    })();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).not.toContain("hunter2");
    expect(body.error.code).toBe("internal_error");
    spy.mockRestore();
  });
});
