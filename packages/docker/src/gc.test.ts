import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerBlob, dockerBlobLink, dockerUpload } from "@weaver/db";
import { DOCKER_GC_GRACE_MS, runDockerGc } from "./gc.js";
import {
  descriptorOf,
  digestOf,
  pushBlob,
  pushManifest,
  randomBlob,
  startDockerTestRegistry,
  type DockerTestRegistry,
} from "./testing.js";

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const HOUR = 60 * 60 * 1000;

describe("docker garbage collection", () => {
  let reg: DockerTestRegistry;
  let key: string;

  beforeAll(async () => {
    reg = await startDockerTestRegistry();
    await reg.createRepo({ name: "one", format: "docker", kind: "hosted" });
    await reg.createRepo({ name: "two", format: "docker", kind: "hosted" });
    key = reg.tokenFor([
      { repo: "one", access: "write" },
      { repo: "two", access: "write" },
    ]);
  });
  afterAll(async () => {
    await reg?.stop();
  });
  beforeEach(async () => {
    await reg.deps.db.execute(sql`TRUNCATE docker_blob, docker_blob_link, docker_manifest, docker_manifest_ref, docker_tag, docker_upload CASCADE`);
  });

  /** A time `ms` from now. */
  const later = (ms: number) => new Date(Date.now() + ms);
  const gc = (now: Date) => runDockerGc({ db: reg.deps.db, stores: reg.deps.stores, now });

  /** Pushes a config and one layer of `size` bytes to `name`; resolves to the manifest and the layer. */
  async function image(name: string, seed: number, size = 1000) {
    const config = Buffer.from(JSON.stringify({ os: "linux", architecture: "amd64", seed }));
    const layer = randomBlob(seed, size);
    expect((await pushBlob(reg, name, config, key)).status).toBe(201);
    expect((await pushBlob(reg, name, layer, key)).status).toBe(201);
    const manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST, config: descriptorOf(config, OCI_CONFIG), layers: [descriptorOf(layer, OCI_LAYER)] };
    return { manifest, config, layer, digest: digestOf(Buffer.from(JSON.stringify(manifest))) };
  }

  async function blobRow(digest: string) {
    const [row] = await reg.deps.db.select().from(dockerBlob).where(eq(dockerBlob.digest, digest));
    return row;
  }

  async function objectExists(storageKey: string): Promise<boolean> {
    return (await reg.deps.stores.primary.head(storageKey)) !== null;
  }

  it("deletes a blob whose only manifest was deleted", async () => {
    const img = await image("one/app", 1, 1234);
    expect((await pushManifest(reg, "one/app", "v1", img.manifest, key)).status).toBe(201);
    expect((await reg.call("DELETE", `one/app/manifests/${img.digest}`, { token: key })).status).toBe(202);
    const layer = (await blobRow(digestOf(img.layer)))!;

    const result = await gc(later(25 * HOUR));

    expect(await blobRow(digestOf(img.layer))).toBeUndefined();
    expect(await objectExists(layer.storageKey)).toBe(false);
    expect(result.linksDeleted).toBe(2);
    expect(result.blobsDeleted).toBe(2);
    expect(result.bytesFreed).toBe(1234 + img.config.length);
  });

  it("keeps recently uploaded unreferenced blobs", async () => {
    const img = await image("one/fresh", 2);
    const result = await gc(later(HOUR));

    expect(result).toEqual({ linksDeleted: 0, blobsDeleted: 0, bytesFreed: 0, uploadsDeleted: 0 });
    const layer = (await blobRow(digestOf(img.layer)))!;
    expect(layer).toBeDefined();
    expect(await objectExists(layer.storageKey)).toBe(true);
    expect((await pushManifest(reg, "one/fresh", "v1", img.manifest, key)).status).toBe(201);
  });

  it("keeps a blob still referenced by another repo's manifest", async () => {
    const a = await image("one/shared", 3);
    const b = await image("two/shared", 3);
    expect(b.digest).toBe(a.digest);
    expect((await pushManifest(reg, "one/shared", "v1", a.manifest, key)).status).toBe(201);
    expect((await pushManifest(reg, "two/shared", "v1", b.manifest, key)).status).toBe(201);
    expect((await reg.call("DELETE", `one/shared/manifests/${a.digest}`, { token: key })).status).toBe(202);

    const result = await gc(later(25 * HOUR));

    expect(result.linksDeleted).toBe(2);
    expect(result.blobsDeleted).toBe(0);
    const layer = (await blobRow(digestOf(a.layer)))!;
    expect(await objectExists(layer.storageKey)).toBe(true);
    const pull = await reg.call("GET", `two/shared/blobs/${digestOf(b.layer)}`, { token: key });
    expect(pull.status).toBe(200);
  });

  it("keeps blobs referenced only by a child manifest of an index", async () => {
    const child = await image("one/multi", 4);
    expect((await pushManifest(reg, "one/multi", child.digest, child.manifest, key)).status).toBe(201);
    const index = {
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [{ ...descriptorOf(Buffer.from(JSON.stringify(child.manifest)), OCI_MANIFEST), platform: { os: "linux", architecture: "amd64" } }],
    };
    expect((await pushManifest(reg, "one/multi", "latest", index, key)).status).toBe(201);

    const result = await gc(later(25 * HOUR));

    expect(result).toMatchObject({ linksDeleted: 0, blobsDeleted: 0 });
    expect((await reg.call("GET", `one/multi/blobs/${digestOf(child.layer)}`, { token: key })).status).toBe(200);
  });

  it("deletes upload rows idle for 25 h", async () => {
    const res = await reg.call("POST", "one/upload/blobs/uploads/", { token: key });
    expect(res.status).toBe(202);
    const id = res.headers.get("docker-upload-uuid")!;

    expect((await gc(later(HOUR))).uploadsDeleted).toBe(0);
    const result = await gc(later(25 * HOUR));

    expect(result.uploadsDeleted).toBe(1);
    expect(await reg.deps.db.select().from(dockerUpload).where(eq(dockerUpload.id, id))).toHaveLength(0);
  });

  it("relinking during gc keeps the blob", async () => {
    const img = await image("one/relink", 5);
    const digest = digestOf(img.layer);
    // Age everything past the grace period, then delete the manifest-less links' last chance at a manifest.
    const old = new Date(Date.now() - DOCKER_GC_GRACE_MS - HOUR);
    await reg.deps.db.update(dockerBlobLink).set({ createdAt: old });
    await reg.deps.db.update(dockerBlob).set({ lastLinkedAt: old });

    const result = await runDockerGc({
      db: reg.deps.db,
      stores: reg.deps.stores,
      // A concurrent upload of the same digest upserts the blob after the links were swept.
      beforeBlobDelete: async () => {
        await reg.deps.db.update(dockerBlob).set({ lastLinkedAt: sql`now()` }).where(eq(dockerBlob.digest, digest));
      },
    });

    expect(result.linksDeleted).toBe(2);
    expect(result.blobsDeleted).toBe(1);
    const layer = (await blobRow(digest))!;
    expect(layer).toBeDefined();
    expect(await objectExists(layer.storageKey)).toBe(true);
  });
});
