import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBlobStoreFromEnv, type BlobStore } from "./index.js";
import { createLocalStore } from "./local.js";
import { createS3Store } from "./s3.js";

function sharedSuite(name: string, make: () => Promise<{ store: BlobStore; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let store: BlobStore;
    let cleanup: () => Promise<void>;
    const prefix = `t${Date.now()}`;
    const key = (n: string) => `${prefix}/repo/dev.group/name/1.0.0/${n}.tar.gz`;

    const created = new Set<string>();

    beforeAll(async () => {
      const made = await make();
      cleanup = made.cleanup;
      store = {
        ...made.store,
        put: (k, d) => {
          created.add(k);
          return made.store.put(k, d);
        },
      };
    });
    afterAll(async () => {
      for (const k of created) await store.delete(k);
      await cleanup();
    });

    it("put then get returns the same bytes", async () => {
      const data = Buffer.from([0, 1, 2, 255, 128, 7]);
      await store.put(key("1"), data);
      expect((await store.get(key("1")))?.equals(data)).toBe(true);
    });

    it("overwrites an existing key", async () => {
      await store.put(key("2"), Buffer.from("a"));
      await store.put(key("2"), Buffer.from("b"));
      expect((await store.get(key("2")))?.toString()).toBe("b");
    });

    it("returns null for a missing key", async () => {
      expect(await store.get(key("missing"))).toBeNull();
    });

    it("delete then get returns null", async () => {
      await store.put(key("3"), Buffer.from("x"));
      await store.delete(key("3"));
      expect(await store.get(key("3"))).toBeNull();
    });

    it("deleting a missing key does not throw", async () => {
      await expect(store.delete(key("nope"))).resolves.toBeUndefined();
    });
  });
}

sharedSuite("local store", async () => {
  const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
  return { store: createLocalStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
});

describe("local store specifics", () => {
  it("rejects keys containing '..'", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await expect(store.put("../x", Buffer.from("a"))).rejects.toThrow(/\.\./);
      await expect(store.get("../x")).rejects.toThrow(/\.\./);
      await expect(store.delete("a/../../x")).rejects.toThrow(/\.\./);
      await expect(store.get("a\\..\\..\\x")).rejects.toThrow(/\.\./);
      await expect(store.get("a/..")).rejects.toThrow(/\.\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts '..' inside a path segment, as in the artifact name foo..bar", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      const key = "releases/acme/foo..bar/1.0.0-rc..1/archive.tar.gz";
      await store.put(key, Buffer.from("a"));
      expect(await store.get(key)).toEqual(Buffer.from("a"));
      await store.delete(key);
      expect(await store.get(key)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects absolute and empty keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await expect(store.put("/abs", Buffer.from("a"))).rejects.toThrow();
      await expect(store.put("", Buffer.from("a"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind after put", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await store.put("a/b/c.tar.gz", Buffer.from("a"));
      expect(await readdir(join(root, "a", "b"))).toEqual(["c.tar.gz"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const s3Endpoint = process.env.S3_TEST_ENDPOINT;
describe.skipIf(!s3Endpoint)("s3 store", () => {
  const s3Opts = {
    endpoint: s3Endpoint,
    bucket: process.env.S3_TEST_BUCKET ?? "weaver",
    region: "us-east-1",
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "minioadmin",
  };
  sharedSuite("s3 (S3-compatible server)", async () => ({
    store: createS3Store(s3Opts),
    cleanup: async () => {},
  }));

  it("throws (rather than returning null) when the bucket does not exist", async () => {
    const store = createS3Store({ ...s3Opts, bucket: "weaver-no-such-bucket" });
    await expect(store.get("a/b/c.tar.gz")).rejects.toThrow();
  });
});

describe("createBlobStoreFromEnv", () => {
  it("creates a local store", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createBlobStoreFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: root });
      await store.put("k/v", Buffer.from("z"));
      expect((await store.get("k/v"))?.toString()).toBe("z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates an s3 store when fully configured", () => {
    const store = createBlobStoreFromEnv({
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "b",
      S3_REGION: "r",
      S3_ACCESS_KEY_ID: "a",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(typeof store.put).toBe("function");
  });

  it("throws on missing or invalid config", () => {
    expect(() => createBlobStoreFromEnv({})).toThrow(/STORAGE_DRIVER/);
    expect(() => createBlobStoreFromEnv({ STORAGE_DRIVER: "ftp" })).toThrow(/STORAGE_DRIVER/);
    expect(() => createBlobStoreFromEnv({ STORAGE_DRIVER: "local" })).toThrow(/STORAGE_LOCAL_PATH/);
    expect(() => createBlobStoreFromEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(/S3_REGION/);
  });
});
