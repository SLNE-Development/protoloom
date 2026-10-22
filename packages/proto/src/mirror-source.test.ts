import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAssetService,
  createMirrorEngine,
  createRepoService,
  createStoreSetFromEnv,
  deriveSecretKey,
  RegistryError,
  type AssetService,
  type FormatHandler,
  type MirrorEngine,
  type Principal,
  type Repo,
  type RepoService,
  type ServerSettings,
} from "@weaver/core";
import { user } from "@weaver/db";
import { startTestDb } from "@weaver/db/testing";
import { createMirrorSource, type ProtoMirrorSource } from "./mirror-source.js";
import { serveFormatHandler, type HandlerUpstream } from "./testing/upstream.js";

const ARCHIVE = Buffer.from("fake tar.gz bytes of acme:money");
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const CREATED = "2026-10-01T12:00:00.000Z";

/** The canned `/api/v1` manifest of `acme:money:<version>`. */
function manifestJson(version: string, buildNumber: number) {
  return {
    repository: "up",
    coordinate: `acme:money:${version}`,
    buildNumber,
    sha256: ARCHIVE_SHA,
    sizeBytes: ARCHIVE.length,
    dependencies: [],
    files: ["acme/money/v1/money.proto"],
    publishedBy: "Ada",
    downloadCount: 3,
    createdAt: CREATED,
    builds: [{ buildNumber, createdAt: CREATED, sha256: ARCHIVE_SHA }],
  };
}

/** A remote Weaver serving `acme:money` 1.0.0 (build 1) and 1.0.0-SNAPSHOT (build 3) in repo `up`. */
const cannedApi: FormatHandler = (req, rest) => {
  const json = (body: unknown) => Response.json(body);
  switch (rest) {
    case "repos/up/artifacts/acme/money":
      return Promise.resolve(
        json({
          versions: [
            { version: "1.0.0-SNAPSHOT", isSnapshot: true, latestBuild: 3, updatedAt: CREATED },
            { version: "1.0.0", isSnapshot: false, latestBuild: 1, updatedAt: CREATED },
          ],
        }),
      );
    case "repos/up/artifacts/acme/money/1.0.0":
      return Promise.resolve(json(manifestJson("1.0.0", 1)));
    case "repos/up/artifacts/acme/money/1.0.0-SNAPSHOT":
      return Promise.resolve(json(manifestJson("1.0.0-SNAPSHOT", 3)));
    case "repos/up/artifacts/acme/money/1.0.0/archive":
    case "repos/up/artifacts/acme/money/1.0.0-SNAPSHOT/archive":
      return Promise.resolve(
        new Response(req.method === "HEAD" ? null : ARCHIVE, {
          headers: {
            "content-type": "application/gzip",
            "content-length": String(ARCHIVE.length),
            "x-weaver-sha256": ARCHIVE_SHA,
          },
        }),
      );
    default:
      return Promise.resolve(Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 }));
  }
};

async function readAll(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

describe("proto mirror source", () => {
  let testDb: Awaited<ReturnType<typeof startTestDb>>;
  let blobDir: string;
  let repos: RepoService;
  let assets: AssetService;
  let engine: MirrorEngine;
  let source: ProtoMirrorSource;
  let up: HandlerUpstream;
  const admin: Principal = { kind: "user", userId: "proto-admin", role: "admin" };
  const settings = (): Promise<ServerSettings> => Promise.resolve({ anonymousView: false, defaultCacheStore: "local" });
  const release = { group: "acme", name: "money", version: "1.0.0" };
  const snapshot = { group: "acme", name: "money", version: "1.0.0-SNAPSHOT" };

  /** Creates mirror `name` of the remote repo `up`. */
  function mirror(config: Record<string, unknown> = {}, name = "proto-mirror"): Promise<Repo> {
    return repos.create(admin, {
      name,
      format: "proto",
      kind: "mirror",
      config,
      upstreams: [{ url: `${up.origin}/api/v1/repos/up`, authType: "none" }],
    });
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    await testDb.db.insert(user).values({ id: admin.kind === "user" ? admin.userId : "", name: "Admin", email: "admin@weaver.test", role: "admin" });
    blobDir = await mkdtemp(join(tmpdir(), "weaver-proto-"));
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: blobDir });
    repos = createRepoService({ db: testDb.db, stores, secretKey: deriveSecretKey("proto-test") });
    assets = createAssetService({ db: testDb.db, stores });
    engine = createMirrorEngine({ db: testDb.db, stores, repos, assets, settings });
    source = createMirrorSource({ mirror: engine });
    up = await serveFormatHandler(cannedApi);
  });

  afterAll(async () => {
    await up?.close();
    await testDb?.stop();
    if (blobDir) await rm(blobDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    up.hits = [];
    up.handler = cannedApi;
  });

  afterEach(async () => {
    await engine.drain();
    for (const repo of await repos.list()) await repos.delete(admin, repo.name);
  });

  it("node maps an upstream manifest to a ResolvedNode", async () => {
    const repo = await mirror();
    expect(await source.node(repo, release, 0)).toEqual({
      coordinate: { group: "acme", name: "money", version: "1.0.0" },
      repository: "proto-mirror",
      buildNumber: 1,
      sha256: ARCHIVE_SHA,
      dependencies: [],
    });
    expect(up.hits.map((h) => h.url)).toEqual(["/api/v1/repos/up/artifacts/acme/money/1.0.0"]);
  });

  it("versions and manifest map the upstream JSON", async () => {
    const repo = await mirror();
    expect(await source.versions(repo, "acme", "money", 0)).toEqual([
      { version: "1.0.0-SNAPSHOT", isSnapshot: true, latestBuild: 3, updatedAt: new Date(CREATED) },
      { version: "1.0.0", isSnapshot: false, latestBuild: 1, updatedAt: new Date(CREATED) },
    ]);
    const info = await source.manifest(repo, release, 0);
    expect(info).toMatchObject({
      repository: "proto-mirror",
      coordinate: release,
      buildNumber: 1,
      createdAt: new Date(CREATED),
      builds: [{ buildNumber: 1, createdAt: new Date(CREATED), sha256: ARCHIVE_SHA }],
    });
  });

  it("upstream 404 is null", async () => {
    const repo = await mirror();
    expect(await source.node(repo, { group: "acme", name: "missing", version: "1.0.0" }, 0)).toBeNull();
    expect(await source.versions(repo, "acme", "missing", 0)).toBeNull();
    expect(await source.archive(repo, { group: "acme", name: "missing", version: "1.0.0" }, undefined, 0, "GET")).toBeNull();
  });

  it("deny rule acme:* returns null without contacting upstream", async () => {
    const repo = await mirror({ rules: { deny: ["acme:*"] } });
    expect(await source.node(repo, release, 0)).toBeNull();
    expect(await source.versions(repo, "acme", "money", 0)).toBeNull();
    expect(await source.archive(repo, release, 1, 0, "GET")).toBeNull();
    expect(up.hits).toHaveLength(0);
  });

  it("non-JSON or schema-invalid upstream body is upstream_unavailable", async () => {
    const repo = await mirror();
    up.handler = () => Promise.resolve(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
    await expect(source.versions(repo, "acme", "money", 0)).rejects.toMatchObject({ code: "upstream_unavailable" });
    up.handler = () => Promise.resolve(Response.json({ versions: "x" }));
    const error = await source.versions(repo, "acme", "money", 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistryError);
    expect(error).toMatchObject({
      code: "upstream_unavailable",
      message: "Upstream of proto-mirror did not answer as a Weaver proto API",
    });
    await expect(source.node(repo, release, 0)).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("a non-2xx answer other than 404 is upstream_unavailable", async () => {
    const repo = await mirror();
    up.handler = () => Promise.resolve(Response.json({ error: { code: "forbidden", message: "no" } }, { status: 403 }));
    await expect(source.manifest(repo, release, 0)).rejects.toMatchObject({ code: "upstream_unavailable" });
    await expect(source.archive(repo, release, 1, 0, "GET")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("release archive is cached as immutable and snapshot archive as metadata", async () => {
    const repo = await mirror({ cache: { enabled: true } });
    const first = await source.archive(repo, release, 1, 0, "GET");
    expect(first).toMatchObject({ status: 200, cache: "miss", sha256: ARCHIVE_SHA, size: ARCHIVE.length });
    expect(await readAll(first!.body)).toEqual(ARCHIVE);
    const snap = await source.archive(repo, snapshot, 3, 0, "GET");
    expect(await readAll(snap!.body)).toEqual(ARCHIVE);
    await engine.drain();

    const releaseAsset = await assets.find(repo.id, "artifacts/acme/money/1.0.0/archive?build=1");
    expect(releaseAsset).not.toBeNull();
    expect(releaseAsset!.expiresAt).toBeNull();
    const snapshotAsset = await assets.find(repo.id, "artifacts/acme/money/1.0.0-SNAPSHOT/archive?build=3");
    expect(snapshotAsset).not.toBeNull();
    expect(Math.abs(snapshotAsset!.expiresAt!.getTime() - (Date.now() + 1800_000))).toBeLessThan(60_000);

    const hit = await source.archive(repo, release, 1, 0, "GET");
    expect(hit).toMatchObject({ status: 200, cache: "hit", sha256: ARCHIVE_SHA, size: ARCHIVE.length });
    expect(await readAll(hit!.body)).toEqual(ARCHIVE);
  });

  it("mirror path with query string reaches upstream verbatim", async () => {
    const repo = await mirror();
    const got = await source.archive(repo, snapshot, 3, 0, "GET");
    await readAll(got!.body);
    expect(up.hits.map((h) => h.url)).toEqual(["/api/v1/repos/up/artifacts/acme/money/1.0.0-SNAPSHOT/archive?build=3"]);
  });

  it("hops header is incremented", async () => {
    const repo = await mirror();
    await source.versions(repo, "acme", "money", 1);
    expect(up.hits[0]!.headers["x-weaver-hops"]).toBe("2");
    expect(up.hits[0]!.headers.accept).toBe("application/json");
  });

  it("cache off streams the archive and reports bypass", async () => {
    const repo = await mirror();
    const got = await source.archive(repo, release, undefined, 0, "GET");
    expect(got).toMatchObject({ status: 200, cache: "bypass", sha256: ARCHIVE_SHA, size: ARCHIVE.length });
    expect(await readAll(got!.body)).toEqual(ARCHIVE);
    await engine.drain();
    expect(await assets.find(repo.id, "artifacts/acme/money/1.0.0/archive")).toBeNull();
    expect(up.hits.map((h) => h.url)).toEqual(["/api/v1/repos/up/artifacts/acme/money/1.0.0/archive"]);
  });

  it("HEAD archive has no body", async () => {
    const repo = await mirror();
    const got = await source.archive(repo, release, 1, 0, "HEAD");
    expect(got).toMatchObject({ status: 200, body: null, sha256: ARCHIVE_SHA, size: ARCHIVE.length });
  });
});
