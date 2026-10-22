import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { asset, component, type Db } from "@weaver/db";
import { RegistryError } from "../errors.js";
import type { Repo } from "../repos/service.js";
import type { ObjectRead, StoreId, StoreSet } from "../storage/index.js";

/** One stored file of a repository: where its bytes live, their digests, and whether it was published or cached. */
export interface AssetRow {
  id: string;
  repositoryId: string;
  componentId: string | null;
  path: string;
  store: StoreId;
  storageKey: string;
  size: number;
  contentType: string | null;
  md5: string;
  sha1: string;
  sha256: string;
  sha512: string;
  origin: "hosted" | "cache";
  /** When cached metadata must be revalidated upstream; null for hosted and immutable assets. */
  expiresAt: Date | null;
  lastAccessedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The coordinate of a component (a Maven GAV, an npm package version, a Docker tag); empty strings where a format has none. */
export interface ComponentRef {
  namespace: string;
  name: string;
  version: string;
  /** Format-specific details; replaces the stored metadata when given. */
  metadata?: Record<string, unknown>;
}

/** What {@link AssetService.put} stores. */
export interface PutAssetInput {
  repo: Repo;
  path: string;
  body: Readable;
  contentType?: string | null;
  origin: "hosted" | "cache";
  /** The store to write to; defaults to the primary store. */
  store?: StoreId;
  expiresAt?: Date | null;
  /** Links the asset to this component, creating the component when needed. */
  component?: ComponentRef;
  /** The expected body length; a body of another length fails the put and writes nothing. */
  contentLength?: number;
  /** Aborting it fails the put and writes nothing. */
  signal?: AbortSignal;
}

/** Stored files of non-proto repositories: rows in `asset`, bytes in the object stores. */
export interface AssetService {
  /** The asset at `path` in the repository, or null. */
  find(repoId: string, path: string): Promise<AssetRow | null>;
  /** The assets whose path starts with `prefix` (taken literally), by path. */
  list(repoId: string, prefix: string): Promise<AssetRow[]>;
  /** Streams into the store under key `<repoId>/<origin>/<uuid>`, then upserts the row (replacing and deleting the previous object on conflict). */
  put(input: PutAssetInput): Promise<AssetRow>;
  /** Opens the asset's bytes, optionally an inclusive range; null when the object or its store is gone. */
  open(asset: AssetRow, range?: { start: number; end?: number }): Promise<ObjectRead | null>;
  /** Deletes the row, then the object; a failed object delete is only logged. */
  delete(asset: AssetRow): Promise<void>;
  /** Sets `lastAccessedAt` to now. */
  touch(assetId: string): Promise<void>;
  /** Creates or updates the component at `ref` in the repository and returns its id. */
  upsertComponent(repoId: string, ref: ComponentRef): Promise<string>;
}

type AssetTableRow = typeof asset.$inferSelect;

function toAssetRow(row: AssetTableRow): AssetRow {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    componentId: row.componentId,
    path: row.path,
    store: row.store,
    storageKey: row.storageKey,
    size: row.size,
    contentType: row.contentType,
    md5: row.md5,
    sha1: row.sha1,
    sha256: row.sha256,
    sha512: row.sha512,
    origin: row.origin,
    expiresAt: row.expiresAt,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `value` with the LIKE wildcards `%`, `_` and the escape character `\` escaped. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Creates the asset service over the database and the object stores. */
export function createAssetService(deps: { db: Db; stores: StoreSet }): AssetService {
  const { db, stores } = deps;

  /** Deletes an object whose row is gone; failures and unconfigured stores only leave an orphan and are logged. */
  async function deleteObject(store: StoreId, key: string): Promise<void> {
    const target = stores.get(store);
    if (!target) {
      console.warn(`weaver: cannot delete orphaned asset object ${key}: store ${store} is not configured`);
      return;
    }
    try {
      await target.delete(key);
    } catch (error) {
      console.warn(`weaver: failed to delete orphaned asset object ${key}`, error);
    }
  }

  async function upsertComponent(repoId: string, ref: ComponentRef): Promise<string> {
    const [row] = await db
      .insert(component)
      .values({ repositoryId: repoId, namespace: ref.namespace, name: ref.name, version: ref.version, metadata: ref.metadata ?? {} })
      .onConflictDoUpdate({
        target: [component.repositoryId, component.namespace, component.name, component.version],
        set: ref.metadata === undefined ? { updatedAt: new Date() } : { metadata: ref.metadata, updatedAt: new Date() },
      })
      .returning({ id: component.id });
    return row!.id;
  }

  return {
    async find(repoId, path) {
      const [row] = await db
        .select()
        .from(asset)
        .where(and(eq(asset.repositoryId, repoId), eq(asset.path, path)));
      return row ? toAssetRow(row) : null;
    },

    async list(repoId, prefix) {
      const rows = await db
        .select()
        .from(asset)
        .where(and(eq(asset.repositoryId, repoId), like(asset.path, `${escapeLike(prefix)}%`)))
        .orderBy(asc(asset.path));
      return rows.map(toAssetRow);
    },

    async put(input) {
      const storeId = input.store ?? stores.primary.id;
      const store = stores.get(storeId);
      if (!store) throw new RegistryError("invalid_request", `Storage "${storeId}" is not configured`);
      const key = `${input.repo.id}/${input.origin}/${randomUUID()}`;
      const written = await store.put(key, input.body, { contentLength: input.contentLength, signal: input.signal });

      let previous: { store: StoreId; storageKey: string } | null = null;
      let row: AssetTableRow;
      try {
        const componentId = input.component ? await upsertComponent(input.repo.id, input.component) : null;
        const values = {
          repositoryId: input.repo.id,
          componentId,
          path: input.path,
          store: storeId,
          storageKey: key,
          size: written.size,
          contentType: input.contentType ?? null,
          md5: written.md5,
          sha1: written.sha1,
          sha256: written.sha256,
          sha512: written.sha512,
          origin: input.origin,
          expiresAt: input.expiresAt ?? null,
        };
        row = await db.transaction(async (tx) => {
          // Serializes puts to one path, so the replaced object is always the one this put saw.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset:${input.repo.id}:${input.path}`}, 0))`);
          const [existing] = await tx
            .select({ store: asset.store, storageKey: asset.storageKey })
            .from(asset)
            .where(and(eq(asset.repositoryId, input.repo.id), eq(asset.path, input.path)));
          previous = existing ?? null;
          const [upserted] = await tx
            .insert(asset)
            .values(values)
            .onConflictDoUpdate({
              target: [asset.repositoryId, asset.path],
              set: { ...values, updatedAt: new Date() },
            })
            .returning();
          return upserted!;
        });
      } catch (error) {
        await deleteObject(storeId, key);
        throw error;
      }
      const replaced = previous as { store: StoreId; storageKey: string } | null;
      if (replaced && replaced.storageKey !== key) await deleteObject(replaced.store, replaced.storageKey);
      return toAssetRow(row);
    },

    async open(row, range) {
      const store = stores.get(row.store);
      if (!store) {
        console.warn(`weaver: cannot open asset ${row.path}: store ${row.store} is not configured`);
        return null;
      }
      return store.get(row.storageKey, range ? { range } : undefined);
    },

    async delete(row) {
      await db.delete(asset).where(eq(asset.id, row.id));
      await deleteObject(row.store, row.storageKey);
    },

    async touch(assetId) {
      await db.update(asset).set({ lastAccessedAt: new Date() }).where(eq(asset.id, assetId));
    },

    upsertComponent,
  };
}
