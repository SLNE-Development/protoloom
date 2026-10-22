import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStoreSetFromEnv, getBuffer, putBuffer, type ObjectStore } from "./index.js";
import { createLocalStore } from "./local.js";
import { createS3Store } from "./s3.js";

const MiB = 1024 * 1024;

/** Yields `total` deterministic bytes in 1 MiB chunks, so the body is never held as one buffer while streaming. */
function generated(total: number): { stream: () => Readable; bytes: () => Buffer } {
  const chunk = (i: number) => {
    const out = Buffer.alloc(Math.min(MiB, total - i * MiB));
    for (let j = 0; j < out.length; j++) out[j] = (i * 31 + j * 7 + (j >> 8)) & 0xff;
    return out;
  };
  const count = Math.ceil(total / MiB);
  return {
    stream: () =>
      Readable.from(
        (function* () {
          for (let i = 0; i < count; i++) yield chunk(i);
        })(),
      ),
    bytes: () => Buffer.concat(Array.from({ length: count }, (_, i) => chunk(i))),
  };
}

function digestsOf(data: Buffer) {
  const hex = (alg: string) => createHash(alg).update(data).digest("hex");
  return { md5: hex("md5"), sha1: hex("sha1"), sha256: hex("sha256"), sha512: hex("sha512") };
}

async function readAll(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

function sharedSuite(name: string, make: () => Promise<{ store: ObjectStore; cleanup: () => Promise<void> }>) {
  describe(name, () => {
    let store: ObjectStore;
    let cleanup: () => Promise<void>;
    const prefix = `t${Date.now()}`;
    const key = (n: string) => `${prefix}/repo/dev.group/name/1.0.0/${n}.tar.gz`;

    const created = new Set<string>();

    beforeAll(async () => {
      const made = await make();
      cleanup = made.cleanup;
      const inner = made.store;
      store = {
        id: inner.id,
        put: (k, d, o) => {
          created.add(k);
          return inner.put(k, d, o);
        },
        get: (k, o) => inner.get(k, o),
        head: (k) => inner.head(k),
        delete: (k) => inner.delete(k),
        deleteMany: (ks) => inner.deleteMany(ks),
      };
    });
    afterAll(async () => {
      await store.deleteMany([...created]);
      await cleanup();
    });

    it("put then get returns the same bytes", async () => {
      const data = Buffer.from([0, 1, 2, 255, 128, 7]);
      await putBuffer(store, key("1"), data);
      expect((await getBuffer(store, key("1")))?.equals(data)).toBe(true);
    });

    it("overwrites an existing key", async () => {
      await putBuffer(store, key("2"), Buffer.from("a"));
      await putBuffer(store, key("2"), Buffer.from("b"));
      expect((await getBuffer(store, key("2")))?.toString()).toBe("b");
    });

    it("returns null for a missing key", async () => {
      expect(await store.get(key("missing"))).toBeNull();
      expect(await getBuffer(store, key("missing"))).toBeNull();
    });

    it("delete then get returns null", async () => {
      await putBuffer(store, key("3"), Buffer.from("x"));
      await store.delete(key("3"));
      expect(await store.get(key("3"))).toBeNull();
    });

    it("deleting a missing key does not throw", async () => {
      await expect(store.delete(key("nope"))).resolves.toBeUndefined();
    });

    it("put streams a 20 MiB generated stream and returns size and all four digests", async () => {
      const gen = generated(20 * MiB);
      const result = await store.put(key("big"), gen.stream());
      const expected = gen.bytes();
      expect(result).toEqual({ size: expected.length, ...digestsOf(expected) });
      const read = await store.get(key("big"));
      expect(read?.size).toBe(expected.length);
      expect(read?.range).toBeUndefined();
      expect((await readAll(read!.body)).equals(expected)).toBe(true);
    }, 120_000);

    it("put of a buffer returns its digests", async () => {
      const data = randomBytes(1000);
      expect(await store.put(key("buf"), data)).toEqual({ size: 1000, ...digestsOf(data) });
    });

    it("put aborted via signal leaves no object", async () => {
      const controller = new AbortController();
      let sent = 0;
      const body = new Readable({
        read() {
          sent++;
          if (sent === 3) controller.abort();
          this.push(Buffer.alloc(MiB, sent));
        },
      });
      await expect(store.put(key("aborted"), body, { signal: controller.signal })).rejects.toThrow();
      expect(await store.head(key("aborted"))).toBeNull();
    }, 60_000);

    it("put already aborted leaves no object", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.put(key("pre-aborted"), Buffer.from("x"), { signal: controller.signal }),
      ).rejects.toThrow();
      expect(await store.head(key("pre-aborted"))).toBeNull();
    });

    it("get with range returns exactly the requested bytes", async () => {
      const data = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
      await putBuffer(store, key("range"), data);
      const read = await store.get(key("range"), { range: { start: 10, end: 19 } });
      expect(read?.range).toEqual({ start: 10, end: 19 });
      expect(read?.size).toBe(100);
      const body = await readAll(read!.body);
      expect(body.length).toBe(10);
      expect(body.equals(data.subarray(10, 20))).toBe(true);
    });

    it("get with an open-ended range reads to the end", async () => {
      const data = Buffer.from(Array.from({ length: 50 }, (_, i) => i));
      await putBuffer(store, key("range-open"), data);
      const read = await store.get(key("range-open"), { range: { start: 40 } });
      expect(read?.range).toEqual({ start: 40, end: 49 });
      expect((await readAll(read!.body)).equals(data.subarray(40))).toBe(true);
    });

    it("get with a range starting past the end rejects with RangeError", async () => {
      await putBuffer(store, key("range-past"), Buffer.from("0123456789"));
      await expect(store.get(key("range-past"), { range: { start: 10 } })).rejects.toBeInstanceOf(RangeError);
      expect(await store.get(key("range-past-missing"), { range: { start: 0, end: 1 } })).toBeNull();
    });

    it("head returns size; missing key returns null", async () => {
      await putBuffer(store, key("head"), Buffer.from("hello"));
      expect(await store.head(key("head"))).toEqual({ size: 5 });
      expect(await store.head(key("head-missing"))).toBeNull();
    });

    it("deleteMany ignores missing keys", async () => {
      await putBuffer(store, key("dm1"), Buffer.from("1"));
      await putBuffer(store, key("dm2"), Buffer.from("2"));
      await expect(store.deleteMany([key("dm1"), key("dm-missing"), key("dm2")])).resolves.toBeUndefined();
      expect(await store.head(key("dm1"))).toBeNull();
      expect(await store.head(key("dm2"))).toBeNull();
      await expect(store.deleteMany([])).resolves.toBeUndefined();
    });
  });
}

sharedSuite("local store", async () => {
  const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
  return { store: createLocalStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
});

describe("local store specifics", () => {
  it("has id local", () => {
    expect(createLocalStore(tmpdir()).id).toBe("local");
  });

  it("rejects keys containing '..'", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await expect(putBuffer(store, "../x", Buffer.from("a"))).rejects.toThrow(/\.\./);
      await expect(store.get("../x")).rejects.toThrow(/\.\./);
      await expect(store.head("../x")).rejects.toThrow(/\.\./);
      await expect(store.delete("a/../../x")).rejects.toThrow(/\.\./);
      await expect(store.deleteMany(["a/../../x"])).rejects.toThrow(/\.\./);
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
      await putBuffer(store, key, Buffer.from("a"));
      expect(await getBuffer(store, key)).toEqual(Buffer.from("a"));
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
      await expect(putBuffer(store, "/abs", Buffer.from("a"))).rejects.toThrow();
      await expect(putBuffer(store, "", Buffer.from("a"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind after put", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      await putBuffer(store, "a/b/c.tar.gz", Buffer.from("a"));
      expect(await readdir(join(root, "a", "b"))).toEqual(["c.tar.gz"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind after an aborted put", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const store = createLocalStore(root);
      const controller = new AbortController();
      const body = new Readable({
        read() {
          controller.abort();
          this.push(Buffer.alloc(1024));
        },
      });
      await expect(store.put("a/b/c.tar.gz", body, { signal: controller.signal })).rejects.toThrow();
      expect(await readdir(join(root, "a", "b"))).toEqual([]);
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

  it("has id s3", () => {
    expect(createS3Store(s3Opts).id).toBe("s3");
  });

  it("throws (rather than returning null) when the bucket does not exist", async () => {
    const store = createS3Store({ ...s3Opts, bucket: "weaver-no-such-bucket" });
    await expect(store.get("a/b/c.tar.gz")).rejects.toThrow();
  });
});

describe("createStoreSetFromEnv", () => {
  const s3Env = {
    S3_BUCKET: "b",
    S3_REGION: "r",
    S3_ACCESS_KEY_ID: "a",
    S3_SECRET_ACCESS_KEY: "s",
  };

  it("creates a local primary store", async () => {
    const root = await mkdtemp(join(tmpdir(), "weaver-blob-"));
    try {
      const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: root });
      expect(stores.primary.id).toBe("local");
      expect(stores.configured()).toEqual(["local"]);
      await putBuffer(stores.primary, "k/v", Buffer.from("z"));
      expect((await getBuffer(stores.primary, "k/v"))?.toString()).toBe("z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates an s3 primary store when fully configured", () => {
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "s3", ...s3Env });
    expect(stores.primary.id).toBe("s3");
    expect(stores.get("s3")).toBe(stores.primary);
    expect(stores.get("local")).toBeNull();
    expect(stores.configured()).toEqual(["s3"]);
  });

  it("configures both stores when both are set and picks primary by STORAGE_DRIVER", () => {
    const env = { STORAGE_LOCAL_PATH: tmpdir(), ...s3Env };
    const local = createStoreSetFromEnv({ ...env, STORAGE_DRIVER: "local" });
    expect(local.primary.id).toBe("local");
    expect(local.configured()).toEqual(["local", "s3"]);
    expect(local.get("local")).toBe(local.primary);
    expect(local.get("s3")?.id).toBe("s3");

    const s3 = createStoreSetFromEnv({ ...env, STORAGE_DRIVER: "s3" });
    expect(s3.primary.id).toBe("s3");
    expect(s3.configured()).toEqual(["local", "s3"]);
    expect(s3.get("local")?.id).toBe("local");
  });

  it('get("s3") is null when S3_BUCKET is unset', () => {
    const stores = createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: tmpdir() });
    expect(stores.get("s3")).toBeNull();
  });

  it("throws on missing or invalid config", () => {
    expect(() => createStoreSetFromEnv({})).toThrow(/STORAGE_DRIVER/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "ftp" })).toThrow(/STORAGE_DRIVER/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "local" })).toThrow(/STORAGE_LOCAL_PATH/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "s3" })).toThrow(/S3_BUCKET/);
    expect(() => createStoreSetFromEnv({ STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(/S3_REGION/);
    expect(() =>
      createStoreSetFromEnv({ STORAGE_DRIVER: "local", STORAGE_LOCAL_PATH: tmpdir(), S3_BUCKET: "b" }),
    ).toThrow(/S3_REGION/);
  });
});
