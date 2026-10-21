import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { BlobStore } from "./index.js";

export interface S3StoreOptions {
  /** Custom endpoint (MinIO etc.). When set, path-style addressing is used. */
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Blob store backed by an S3-compatible bucket. */
export function createS3Store(opts: S3StoreOptions): BlobStore {
  const client = new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const Bucket = opts.bucket;

  return {
    async put(key, data) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: data }));
    },

    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) return null;
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (error) {
        // Only a missing object counts as "not found"; NoSuchBucket (also a 404) is a real error.
        if (error instanceof S3ServiceException && (error.name === "NoSuchKey" || error.name === "NotFound")) {
          return null;
        }
        throw error;
      }
    },

    async delete(key) {
      // S3 DeleteObject succeeds for missing keys.
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
  };
}
