import { sql } from "drizzle-orm";
import type { StoreId, StoreSet } from "@weaver/core";
import type { Db } from "@weaver/db";

/** How long links, blobs and uploads are kept after their last activity before garbage collection may remove them. */
export const DOCKER_GC_GRACE_MS = 24 * 60 * 60 * 1000;

/** What one garbage collection run removed. */
export interface DockerGcResult {
  /** Blob links removed because no manifest of their image references them. */
  linksDeleted: number;
  /** Blob rows removed (their objects are deleted afterwards). */
  blobsDeleted: number;
  /** Total size of the removed blobs, in bytes. */
  bytesFreed: number;
  /** Upload rows removed after being idle for the grace period. */
  uploadsDeleted: number;
}

/** What {@link runDockerGc} works with. */
export interface DockerGcDeps {
  db: Db;
  stores: StoreSet;
  /** The time the run treats as now (default: the current time); the grace period counts back from it. */
  now?: Date;
  /** Test hook: runs after links were swept and before unlinked blobs are deleted. */
  beforeBlobDelete?: () => Promise<void>;
}

/** The number of rows a raw `DELETE ... RETURNING` result holds. */
function rowCount(result: { rows?: unknown[] } | unknown[]): number {
  return Array.isArray(result) ? result.length : (result.rows?.length ?? 0);
}

/** The rows of a raw query result. */
function rowsOf<T>(result: { rows?: unknown[] } | unknown[]): T[] {
  return (Array.isArray(result) ? result : (result.rows ?? [])) as T[];
}

/**
 * Garbage-collects docker storage: 1) deletes upload rows idle longer than {@link DOCKER_GC_GRACE_MS};
 * 2) deletes blob links older than the grace period whose digest no manifest of the same repository/image
 * references (config, layers, and so the layers of an index's child manifests, which are manifests themselves);
 * 3) deletes blob rows with no link left, referenced by no manifest anywhere and last linked before the grace
 * period, then their objects. Objects are deleted only after the rows are gone, so a crash leaves orphaned
 * objects but never rows pointing at missing bytes. A blob linked or re-uploaded meanwhile has a fresh
 * `last_linked_at` and is kept. Manifests are never deleted here.
 */
export async function runDockerGc(deps: DockerGcDeps): Promise<DockerGcResult> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - DOCKER_GC_GRACE_MS);

  const uploads = await deps.db.execute(sql`
    DELETE FROM docker_upload WHERE updated_at < ${cutoff} RETURNING id`);

  const links = await deps.db.execute(sql`
    DELETE FROM docker_blob_link l
    WHERE l.created_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM docker_manifest_ref r
        JOIN docker_manifest m ON m.id = r.manifest_id
        WHERE m.repository_id = l.repository_id AND m.image = l.image AND r.digest = l.digest AND r.kind = 'blob'
      )
    RETURNING l.digest`);

  await deps.beforeBlobDelete?.();

  const blobs = rowsOf<{ store: StoreId; storage_key: string; size: string | number }>(
    await deps.db.execute(sql`
      DELETE FROM docker_blob b
      WHERE b.last_linked_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM docker_blob_link l WHERE l.blob_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM docker_manifest_ref r WHERE r.digest = b.digest AND r.kind = 'blob')
      RETURNING b.store, b.storage_key, b.size`),
  );

  const byStore = new Map<StoreId, string[]>();
  for (const b of blobs) byStore.set(b.store, [...(byStore.get(b.store) ?? []), b.storage_key]);
  for (const [id, keys] of byStore) {
    const store = deps.stores.get(id);
    if (!store) {
      console.warn(`weaver: docker gc left ${keys.length} object(s) in unconfigured store ${id}`);
      continue;
    }
    await store.deleteMany(keys);
  }

  return {
    linksDeleted: rowCount(links),
    blobsDeleted: blobs.length,
    bytesFreed: blobs.reduce((sum, b) => sum + Number(b.size), 0),
    uploadsDeleted: rowCount(uploads),
  };
}
