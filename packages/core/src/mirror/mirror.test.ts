import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { asset } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createAssetService, type AssetService } from "../content/assets.js";
import { deriveSecretKey } from "../crypto.js";
import { RegistryError } from "../errors.js";
import type { Principal } from "../permissions.js";
import type { MirrorConfig } from "../repos/config.js";
import { createRepoService, type Repo, type RepoService, type UpstreamInput } from "../repos/index.js";
import type { ServerSettings } from "../settings.js";
import { createStoreSetFromEnv, type StoreSet } from "../storage/index.js";
import { createMirrorEngine, teeWithBackpressure, type MirrorEngine, type MirrorResponse } from "./index.js";

const admin: Principal = { kind: "user", userId: "admin-user", role: "admin" };

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A local upstream: `handler` answers, `hits` records every request as `METHOD path`. */
interface Upstream {
  server: Server;
  base: string;
  hits: string[];
  auth: Array<string | undefined>;
  handler: Handler;
}

async function startUpstream(prefix = "/repo"): Promise<Upstream> {
  const upstream: Upstream = {
    server: createServer((req, res) => {
      upstream.hits.push(`${req.method} ${req.url}`);
      upstream.auth.push(req.headers.authorization);
      upstream.handler(req, res);
    }),
    base: "",
    hits: [],
    auth: [],
    handler: (_req, res) => res.writeHead(404).end(),
  };
  await new Promise<void>((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  upstream.base = `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}${prefix}`;
  return upstream;
}

/** Serves `files` (path below the prefix -> body) and 404s everything else. */
function serve(files: Record<string, string>, contentType = "text/plain"): Handler {
  return (req, res) => {
    const path = req.url!.replace(/^\/repo\//, "");
    const body = files[path];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

async function readText(response: MirrorResponse): Promise<string> {
  return new Response(response.body).text();
}

async function filesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

describe("mirror engine", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let stores: StoreSet;
  let repos: RepoService;
  let assets: AssetService;
  let engine: MirrorEngine;
  let up: Upstream;
  let up2: Upstream;
  const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });

  async function mirror(config: Record<string, unknown> = {}, upstreams?: UpstreamInput[]): Promise<Repo> {
    return repos.create(admin, {
      name: "central",
      format: "maven",
      kind: "mirror",
      config,
      upstreams: upstreams ?? [{ url: up.base, authType: "none" }],
    });
  }

  const cached = { cache: { enabled: true } };

  async function assetRows() {
    return testDb.db.select().from(asset);
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    blobDir = await mkdtemp(join(tmpdir(), "weaver-mirror-"));
    stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("mirror-test") });
    assets = createAssetService({ db: testDb.db, stores });
    up = await startUpstream();
    up2 = await startUpstream();
  });

  afterAll(async () => {
    for (const u of [up, up2]) {
      u?.server.closeAllConnections();
      await new Promise((resolve) => u?.server.close(resolve));
    }
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await testDb.db.execute(sql`TRUNCATE repository, usage_event, audit_event CASCADE`);
    await rm(blobDir, { recursive: true, force: true });
    for (const u of [up, up2]) {
      u.hits = [];
      u.auth = [];
      u.handler = (_req, res) => res.writeHead(404).end();
    }
    engine = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings });
  });

  afterEach(async () => {
    // Cache writes outlive their response; let them finish before the next test truncates the tables.
    await engine.drain();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cache disabled: streams upstream body and writes no asset", async () => {
    up.handler = serve({ "a/b.jar": "jar-bytes" }, "application/java-archive");
    const repo = await mirror();
    const res = await engine.fetch({ repo, path: "a/b.jar", subject: "a/b.jar", class: "immutable" });
    expect(res).toMatchObject({ status: 200, cache: "bypass", asset: null, upstreamUrl: `${up.base}/a/b.jar` });
    expect(res!.headers.get("content-type")).toBe("application/java-archive");
    expect(await readText(res!)).toBe("jar-bytes");
    await engine.drain();
    expect(await assetRows()).toHaveLength(0);
    expect(await filesIn(blobDir)).toEqual([]);
  });

  it("cache enabled: first request miss, second hit without contacting upstream", async () => {
    up.handler = serve({ "a/b.jar": "jar-bytes" }, "application/java-archive");
    const repo = await mirror(cached);
    const first = await engine.fetch({ repo, path: "a/b.jar", subject: "a/b.jar", class: "immutable" });
    expect(first).toMatchObject({ status: 200, cache: "miss" });
    expect(await readText(first!)).toBe("jar-bytes");
    await engine.drain();
    const rows = await assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "cache", path: "a/b.jar", size: 9, contentType: "application/java-archive", expiresAt: null, store: "local" });
    expect(rows[0]!.storageKey.startsWith(`${repo.id}/cache/`)).toBe(true);

    const second = await engine.fetch({ repo, path: "a/b.jar", subject: "a/b.jar", class: "immutable" });
    expect(second).toMatchObject({ status: 200, cache: "hit", upstreamUrl: null });
    expect(second!.asset!.id).toBe(rows[0]!.id);
    expect(second!.headers.get("content-length")).toBe("9");
    expect(second!.headers.get("content-type")).toBe("application/java-archive");
    expect(await readText(second!)).toBe("jar-bytes");
    expect(up.hits).toEqual(["GET /repo/a/b.jar"]);
    expect((await assets.find(repo.id, "a/b.jar"))!.lastAccessedAt).toBeInstanceOf(Date);
  });

  it("metadata expires after ttl and is refetched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    let version = "v1";
    up.handler = (req, res) => res.writeHead(200, { "content-type": "application/xml" }).end(version);
    const repo = await mirror({ cache: { enabled: true, metadataTtlSeconds: 60 } });
    const req = { repo, path: "a/maven-metadata.xml", subject: "a/maven-metadata.xml", class: "metadata" as const };

    expect(await readText((await engine.fetch(req))!)).toBe("v1");
    await engine.drain();
    expect((await assetRows())[0]!.expiresAt).toEqual(new Date("2026-01-01T00:01:00Z"));

    version = "v2";
    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    const hit = await engine.fetch(req);
    expect(hit!.cache).toBe("hit");
    expect(await readText(hit!)).toBe("v1");

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    const refetched = await engine.fetch(req);
    expect(refetched!.cache).toBe("miss");
    expect(await readText(refetched!)).toBe("v2");
    await engine.drain();
    const rows = await assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiresAt).toEqual(new Date("2026-01-01T00:02:01Z"));
    expect(up.hits).toHaveLength(2);
    expect(await filesIn(blobDir)).toHaveLength(1);
  });

  it("upstream down with cached expired metadata serves stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    up.handler = (_req, res) => res.writeHead(200).end("meta");
    const repo = await mirror({ cache: { enabled: true, metadataTtlSeconds: 60 } });
    const req = { repo, path: "m.xml", subject: "m.xml", class: "metadata" as const };
    await readText((await engine.fetch(req))!);
    await engine.drain();

    vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
    up.handler = (_req, res) => res.writeHead(503).end("down");
    const stale = await engine.fetch(req);
    expect(stale).toMatchObject({ status: 200, cache: "stale" });
    expect(await readText(stale!)).toBe("meta");

    up.handler = (req) => req.socket.destroy();
    const staleAgain = await engine.fetch(req);
    expect(staleAgain!.cache).toBe("stale");
    expect(await readText(staleAgain!)).toBe("meta");
  });

  it("upstream failure without a cached asset throws upstream_unavailable", async () => {
    up.handler = (_req, res) => res.writeHead(502).end("bad gateway");
    const repo = await mirror(cached);
    const error = await engine.fetch({ repo, path: "x", subject: "x", class: "immutable" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("upstream_unavailable");
    expect((error as RegistryError).status).toBe(502);
  });

  it("times out an upstream that sends no response headers", async () => {
    up.handler = () => undefined; // never answers
    engine = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings, upstreamTimeoutMs: 200 });
    const repo = await mirror();
    const error = await engine.fetch({ repo, path: "slow", subject: "slow", class: "immutable" }).catch((e: unknown) => e);
    expect((error as RegistryError).code).toBe("upstream_unavailable");
    up.server.closeAllConnections();
  });

  it("offline serves cache only and returns null on miss without contacting upstream", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    up.handler = serve({ "m.xml": "meta" });
    let repo = await mirror({ cache: { enabled: true, metadataTtlSeconds: 60 } });
    await readText((await engine.fetch({ repo, path: "m.xml", subject: "m.xml", class: "metadata" }))!);
    await engine.drain();
    repo = await repos.update(admin, "central", { config: { offline: true } });
    up.hits = [];

    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const res = await engine.fetch({ repo, path: "m.xml", subject: "m.xml", class: "metadata" });
    expect(res!.status).toBe(200);
    expect(["hit", "stale"]).toContain(res!.cache);
    expect(await readText(res!)).toBe("meta");
    expect(await engine.fetch({ repo, path: "other.jar", subject: "other.jar", class: "immutable" })).toBeNull();
    expect(up.hits).toEqual([]);
  });

  it("tries upstreams in order and skips 404s", async () => {
    up.handler = serve({});
    up2.handler = serve({ "x.jar": "from-second" });
    const repo = await mirror(cached, [
      { url: up.base, authType: "none" },
      { url: up2.base, authType: "none" },
    ]);
    const res = await engine.fetch({ repo, path: "x.jar", subject: "x.jar", class: "immutable" });
    expect(res).toMatchObject({ status: 200, upstreamUrl: `${up2.base}/x.jar` });
    expect(await readText(res!)).toBe("from-second");
    expect(up.hits).toEqual(["GET /repo/x.jar"]);
    expect(up2.hits).toEqual(["GET /repo/x.jar"]);

    expect(await engine.fetch({ repo, path: "none.jar", subject: "none.jar", class: "immutable" })).toBeNull();
  });

  it("deny rule returns null without contacting upstream", async () => {
    up.handler = serve({ "com/evil/x.jar": "evil" });
    const repo = await mirror({ rules: { deny: ["com/evil/*"] } });
    expect(await engine.fetch({ repo, path: "com/evil/x.jar", subject: "com/evil/x.jar", class: "immutable" })).toBeNull();
    expect(up.hits).toEqual([]);
  });

  it("basic credentials are sent as Authorization", async () => {
    up.handler = serve({ "x": "ok" });
    const repo = await mirror({}, [{ url: up.base, authType: "basic", username: "alice", secret: "s3cret" }]);
    await readText((await engine.fetch({ repo, path: "x", subject: "x", class: "immutable" }))!);
    expect(up.auth).toEqual([`Basic ${Buffer.from("alice:s3cret").toString("base64")}`]);
  });

  it("bearer credentials are sent as Authorization", async () => {
    up.handler = serve({ "x": "ok" });
    const repo = await mirror({}, [{ url: up.base, authType: "bearer", secret: "tok" }]);
    await readText((await engine.fetch({ repo, path: "x", subject: "x", class: "immutable" }))!);
    expect(up.auth).toEqual(["Bearer tok"]);
  });

  it("onChallenge result is used for one retry", async () => {
    up.handler = (req, res) => {
      if (req.headers.authorization === "Bearer granted") return void res.writeHead(200).end("secret-content");
      res.writeHead(401, { "www-authenticate": 'Bearer realm="https://auth.example/token",service="registry"' }).end();
    };
    const repo = await mirror();
    const onChallenge = vi.fn().mockResolvedValue("Bearer granted");
    const res = await engine.fetch({ repo, path: "v2/x/manifests/1", subject: "x", class: "metadata", onChallenge });
    expect(res!.status).toBe(200);
    expect(await readText(res!)).toBe("secret-content");
    expect(onChallenge).toHaveBeenCalledOnce();
    expect(onChallenge.mock.calls[0]![0]).toBe('Bearer realm="https://auth.example/token",service="registry"');
    expect(onChallenge.mock.calls[0]![1]).toMatchObject({ url: up.base, authType: "none", secret: null });
    expect(up.auth).toEqual([undefined, "Bearer granted"]);

    // A retry that is refused again is passed through, without a second challenge round.
    onChallenge.mockResolvedValue("Bearer wrong");
    const refused = await engine.fetch({ repo, path: "v2/x/manifests/1", subject: "x", class: "metadata", onChallenge });
    expect(refused!.status).toBe(401);
    expect(onChallenge).toHaveBeenCalledTimes(2);
  });

  it("HEAD never writes the cache", async () => {
    up.handler = serve({ "h.jar": "head-body" });
    const repo = await mirror(cached);
    const res = await engine.fetch({ repo, path: "h.jar", subject: "h.jar", class: "immutable", method: "HEAD" });
    expect(res).toMatchObject({ status: 200, body: null, asset: null });
    expect(res!.headers.get("content-length")).toBe("9");
    await engine.drain();
    expect(await assetRows()).toHaveLength(0);
    expect(up.hits).toEqual(["HEAD /repo/h.jar"]);
  });

  it("aborted upstream leaves no asset row and no object", async () => {
    up.handler = (_req, res) => {
      res.writeHead(200, { "content-length": 100_000 });
      res.write(Buffer.alloc(10_000, 1), () => setTimeout(() => res.socket?.destroy(), 20));
    };
    const repo = await mirror(cached);
    const res = await engine.fetch({ repo, path: "big.bin", subject: "big.bin", class: "immutable" });
    expect(res!.status).toBe(200);
    await expect(readText(res!)).rejects.toThrow();
    await engine.drain();
    expect(await assetRows()).toHaveLength(0);
    expect(await filesIn(blobDir)).toEqual([]);
  });

  it("two concurrent misses for the same path both receive the full body and leave exactly one asset row", async () => {
    const body = "x".repeat(200_000);
    const waiting: ServerResponse[] = [];
    up.handler = (_req, res) => {
      waiting.push(res);
      if (waiting.length < 2) return;
      for (const r of waiting) r.writeHead(200, { "content-length": body.length }).end(body);
    };
    const repo = await mirror(cached);
    const req = { repo, path: "c.jar", subject: "c.jar", class: "immutable" as const };
    const [a, b] = await Promise.all([engine.fetch(req), engine.fetch(req)]);
    const [ta, tb] = await Promise.all([readText(a!), readText(b!)]);
    expect(ta).toBe(body);
    expect(tb).toBe(body);
    await engine.drain();
    const rows = await assetRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.size).toBe(body.length);
    expect(await filesIn(blobDir)).toHaveLength(1);
  });

  it("falls back to the primary store when the cache store is no longer configured, and rejects non-mirrors", async () => {
    up.handler = serve({ "x": "ok" });
    const created = await mirror(cached);
    // Creating a mirror with an unconfigured store is refused, so this simulates s3 being removed later.
    const config = created.config as MirrorConfig;
    const repo: Repo = { ...created, config: { ...config, cache: { ...config.cache, store: "s3" } } };
    await readText((await engine.fetch({ repo, path: "x", subject: "x", class: "immutable" }))!);
    await engine.drain();
    expect((await assetRows())[0]!.store).toBe("local");

    const hosted = await repos.create(admin, { name: "hosted", format: "maven", kind: "hosted" });
    await expect(engine.fetch({ repo: hosted, path: "x", subject: "x", class: "immutable" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("teeWithBackpressure", () => {
  /** A source of `n` numbered chunks that counts how many were pulled. */
  function counted(n: number) {
    const state = { pulled: 0 };
    const stream = new ReadableStream<number>({
      pull(controller) {
        if (state.pulled === n) return controller.close();
        controller.enqueue(state.pulled++);
      },
    }, { highWaterMark: 0 });
    return { stream, state };
  }

  async function all<T>(stream: ReadableStream<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<T>) out.push(chunk);
    return out;
  }

  it("delivers every chunk to both branches and does not run ahead of the slower one", async () => {
    const { stream, state } = counted(100);
    const [a, b] = teeWithBackpressure(stream);
    const fast = all(a);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // b has not been read, so only a few chunks may have been pulled from the source.
    expect(state.pulled).toBeLessThanOrEqual(3);
    const slow = await all(b);
    expect(await fast).toEqual(slow);
    expect(slow).toHaveLength(100);
  });

  it("keeps feeding one branch after the other is cancelled", async () => {
    const { stream } = counted(10);
    const [a, b] = teeWithBackpressure(stream);
    await b.cancel();
    expect(await all(a)).toHaveLength(10);
  });

  it("errors both branches when the source errors", async () => {
    const source = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1);
        controller.error(new Error("boom"));
      },
    });
    const [a, b] = teeWithBackpressure(source);
    await expect(all(a)).rejects.toThrow("boom");
    await expect(all(b)).rejects.toThrow("boom");
  });
});
