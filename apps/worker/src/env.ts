import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Validates the worker's environment: the database, Valkey, and the blob storage settings.
 * Empty strings count as unset. Per-driver storage requirements (a path for `local`, bucket and
 * credentials for `s3`) are enforced by `createBlobStoreFromEnv`.
 */
export function loadEnv(runtimeEnv: Record<string, string | undefined>) {
  return createEnv({
    server: {
      DATABASE_URL: z.url(),
      VALKEY_URL: z.url(),
      STORAGE_DRIVER: z.enum(["local", "s3"]),
      STORAGE_LOCAL_PATH: z.string().optional(),
      S3_ENDPOINT: z.url().optional(),
      S3_BUCKET: z.string().optional(),
      S3_REGION: z.string().optional(),
      S3_ACCESS_KEY_ID: z.string().optional(),
      S3_SECRET_ACCESS_KEY: z.string().optional(),
    },
    runtimeEnv,
    emptyStringAsUndefined: true,
    isServer: true,
  });
}

export type WorkerEnv = ReturnType<typeof loadEnv>;
