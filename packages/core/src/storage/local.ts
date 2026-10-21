import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { BlobStore } from "./index.js";

/** Blob store backed by a directory on the local filesystem; keys map to relative paths under `root`. */
export function createLocalStore(root: string): BlobStore {
  const base = resolve(root);

  /** Maps a key to an absolute path inside `root`, rejecting anything that could escape it. */
  function pathFor(key: string): string {
    if (key === "" || key.includes("\0")) throw new Error("Invalid storage key: must be non-empty");
    // Only a whole ".." segment can climb out; names like "foo..bar" are fine.
    if (key.split(/[/\\]/).includes("..")) {
      throw new Error(`Invalid storage key "${key}": must not contain ".." segments`);
    }
    if (isAbsolute(key) || key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`Invalid storage key "${key}": must be relative`);
    }
    const full = resolve(base, key);
    if (!full.startsWith(base + sep)) {
      throw new Error(`Invalid storage key "${key}": resolves outside the storage root`);
    }
    return full;
  }

  return {
    async put(key, data) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, target);
      } catch (error) {
        await rm(tmp, { force: true });
        throw error;
      }
    },

    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
