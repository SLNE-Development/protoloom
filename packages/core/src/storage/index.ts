import { createLocalStore } from "./local.js";
import { createS3Store } from "./s3.js";

/**
 * Storage for published archives. The registry writes keys as
 * `{repository}/{group}/{name}/{version}/{uuid}.tar.gz`, with a fresh uuid per build so a redeploy
 * never overwrites the blob it replaces. The key is stored on the build row (`build.storageKey`);
 * readers use that value and never derive keys.
 */
export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  /** Resolves to `null` when the key does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Does not throw when the key does not exist. */
  delete(key: string): Promise<void>;
}

export { createLocalStore } from "./local.js";
export { createS3Store, type S3StoreOptions } from "./s3.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** Builds the blob store selected by `STORAGE_DRIVER` (`local` or `s3`); throws on missing config. */
export function createBlobStoreFromEnv(env: NodeJS.ProcessEnv): BlobStore {
  const driver = env.STORAGE_DRIVER;
  switch (driver) {
    case "local":
      return createLocalStore(required(env, "STORAGE_LOCAL_PATH"));
    case "s3":
      return createS3Store({
        endpoint: env.S3_ENDPOINT || undefined,
        bucket: required(env, "S3_BUCKET"),
        region: required(env, "S3_REGION"),
        accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
      });
    default:
      throw new Error(`Invalid or missing STORAGE_DRIVER "${driver ?? ""}": expected "local" or "s3"`);
  }
}
