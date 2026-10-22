import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { pipeline } from "node:stream";
import type { Readable } from "node:stream";
import { assertContentLength, HashingStream, toReadable } from "./hashing.js";
import { resolveRange, type ObjectStore } from "./object-store.js";

/** Connection settings for an S3-compatible bucket. */
export interface S3StoreOptions {
  /** Custom endpoint (MinIO etc.). When set, path-style addressing is used. */
  endpoint?: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const PART_SIZE = 8 * 1024 * 1024;
const QUEUE_SIZE = 4;
const DELETE_BATCH = 1000;

/**
 * Object store backed by an S3-compatible bucket. Puts are multipart uploads (8 MiB parts, 4 in
 * flight), so an object only exists once the upload completes.
 */
export function createS3Store(opts: S3StoreOptions): ObjectStore {
  const client = new S3Client({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
  });
  const Bucket = opts.bucket;

  return {
    id: "s3",

    async put(key, body, putOpts = {}) {
      const { signal, contentLength } = putOpts;
      signal?.throwIfAborted();
      const source = toReadable(body);
      const hasher = new HashingStream();
      // Destroys both streams on error, so the upload sees a failed body instead of hanging.
      pipeline(source, hasher, () => {});
      const upload = new Upload({
        client,
        params: { Bucket, Key: key, Body: hasher },
        partSize: PART_SIZE,
        queueSize: QUEUE_SIZE,
        leavePartsOnError: false,
      });
      const onAbort = () => {
        source.destroy(signal?.reason instanceof Error ? signal.reason : new Error("Upload aborted"));
        void upload.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await upload.done();
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      // The upload can win a race against a late abort; make sure an aborted put leaves nothing.
      if (signal?.aborted) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
        signal.throwIfAborted();
      }
      const result = hasher.result();
      try {
        assertContentLength(result, contentLength);
      } catch (error) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
        throw error;
      }
      return result;
    },

    async get(key, getOpts = {}) {
      const { range } = getOpts;
      if (range) resolveRange(range, Number.MAX_SAFE_INTEGER); // validate shape before the request
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket,
            Key: key,
            ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
          }),
        );
        if (!res.Body) return null;
        const bodyStream = res.Body as Readable;
        if (!range) return { body: bodyStream, size: res.ContentLength ?? 0 };
        const parsed = parseContentRange(res.ContentRange);
        if (!parsed) {
          bodyStream.destroy();
          throw new Error(`S3 returned no usable Content-Range for a range request on "${key}"`);
        }
        return { body: bodyStream, size: parsed.size, range: { start: parsed.start, end: parsed.end } };
      } catch (error) {
        // Only a missing object counts as "not found"; NoSuchBucket (also a 404) is a real error.
        if (error instanceof S3ServiceException && (error.name === "NoSuchKey" || error.name === "NotFound")) {
          return null;
        }
        if (error instanceof S3ServiceException && error.name === "InvalidRange") {
          throw new RangeError(`Range ${range?.start}-${range?.end ?? ""} is not satisfiable for "${key}"`, {
            cause: error,
          });
        }
        throw error;
      }
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: res.ContentLength ?? 0 };
      } catch (error) {
        // HEAD responses carry no error body, so a missing bucket is indistinguishable from a missing key.
        if (error instanceof S3ServiceException && (error.name === "NotFound" || error.name === "NoSuchKey")) {
          return null;
        }
        throw error;
      }
    },

    async delete(key) {
      // S3 DeleteObject succeeds for missing keys.
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        const res = await client.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }),
        );
        const failed = (res.Errors ?? []).filter((e) => e.Code !== "NoSuchKey");
        if (failed.length > 0) {
          const first = failed[0]!;
          throw new Error(`Failed to delete ${failed.length} object(s), first "${first.Key}": ${first.Code} ${first.Message}`);
        }
      }
    },
  };
}

/** Parses `bytes <start>-<end>/<size>`; returns `null` for anything else (including an unknown size `*`). */
function parseContentRange(header: string | undefined): { start: number; end: number; size: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? "");
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), size: Number(match[3]) };
}
