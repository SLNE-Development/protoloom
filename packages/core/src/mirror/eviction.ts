import { and, asc, eq } from "drizzle-orm";
import { asset, repository, type Db } from "@weaver/db";
import type { AssetRow, AssetService } from "../content/assets.js";
import { readRepositoryConfig, type MirrorConfig } from "../repos/config.js";

/** What one eviction run removed: repositories that lost assets, deleted asset count, and bytes freed. */
export interface EvictionResult {
  repositories: number;
  assetsDeleted: number;
  bytesFreed: number;
}

/** When a cache asset was last used; an asset that was never read counts from its creation. */
function lastUsed(row: AssetRow): number {
  return (row.lastAccessedAt ?? row.createdAt).getTime();
}

/**
 * For each mirror with caching enabled: deletes cache assets idle longer than `maxAgeDays`, then the
 * least recently accessed ones until the total size is at most `maxSizeBytes`. Also deletes all cache
 * assets of mirrors whose caching is disabled. Hosted assets are never touched.
 */
export async function evictCaches(deps: { db: Db; assets: AssetService; now?: Date }): Promise<EvictionResult> {
  const { db, assets } = deps;
  const now = deps.now ?? new Date();
  const result: EvictionResult = { repositories: 0, assetsDeleted: 0, bytesFreed: 0 };

  const mirrors = await db.select().from(repository).where(eq(repository.kind, "mirror")).orderBy(asc(repository.name));
  for (const repo of mirrors) {
    const { cache } = readRepositoryConfig({
      name: repo.name,
      format: repo.format,
      kind: "mirror",
      config: repo.config,
    }) as MirrorConfig;
    const rows: AssetRow[] = await db
      .select()
      .from(asset)
      .where(and(eq(asset.repositoryId, repo.id), eq(asset.origin, "cache")))
      .orderBy(asc(asset.path));

    let doomed: AssetRow[];
    if (!cache.enabled) {
      doomed = rows;
    } else {
      const cutoff = cache.maxAgeDays === null ? null : now.getTime() - cache.maxAgeDays * 86_400_000;
      doomed = cutoff === null ? [] : rows.filter((row) => lastUsed(row) < cutoff);
      if (cache.maxSizeBytes !== null) {
        const gone = new Set(doomed.map((row) => row.id));
        const kept = rows.filter((row) => !gone.has(row.id)).sort((a, b) => lastUsed(a) - lastUsed(b));
        let total = kept.reduce((sum, row) => sum + row.size, 0);
        for (const row of kept) {
          if (total <= cache.maxSizeBytes) break;
          doomed.push(row);
          total -= row.size;
        }
      }
    }

    let deleted = 0;
    for (const row of doomed) {
      try {
        await assets.delete(row);
        deleted++;
        result.assetsDeleted++;
        result.bytesFreed += row.size;
      } catch (error) {
        console.warn(`weaver: failed to evict cached asset ${row.path} of repository ${repo.name}`, error);
      }
    }
    if (deleted > 0) result.repositories++;
  }
  return result;
}
