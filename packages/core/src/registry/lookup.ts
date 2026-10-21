import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { artifact, build, buildFile, dependency, repository, version, type Db, type Tx } from "@protoloom/db";
import type { ProtoFile } from "../archive.js";
import { formatCoordinate, type Coordinate } from "../coordinates.js";
import { canAccess, type Principal } from "../permissions.js";
import type { Lookup, ResolvedNode } from "../resolution.js";
import type { BlobStore } from "../storage/index.js";
import type { validateProtos } from "../validation.js";

/** Dependencies shared by the registry operations. */
export interface RegistryContext {
  db: Db;
  blobs: BlobStore;
  validate: typeof validateProtos;
}

/** A database handle or an open transaction. */
export type Queryable = Db | Tx;

export type RepositoryRow = typeof repository.$inferSelect;
export type BuildRow = typeof build.$inferSelect;

/**
 * Deletes a blob whose rows are already gone (or never committed). A failure only leaves an
 * orphaned blob behind, so it is logged with the key instead of failing the operation.
 */
export async function deleteBlobLogged(blobs: BlobStore, key: string): Promise<void> {
  try {
    await blobs.delete(key);
  } catch (error) {
    console.warn(`protoloom: failed to delete orphaned blob ${key}`, error);
  }
}

/** Loads a repository by name; null when it does not exist. */
export async function findRepository(db: Queryable, name: string): Promise<RepositoryRow | null> {
  const [row] = await db.select().from(repository).where(eq(repository.name, name));
  return row ?? null;
}

/** Loads the named repositories in the given order, skipping unknown names and duplicates. */
export async function findRepositories(db: Queryable, names: string[]): Promise<RepositoryRow[]> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];
  const rows = await db.select().from(repository).where(inArray(repository.name, unique));
  const byName = new Map(rows.map((r) => [r.name, r]));
  return unique.flatMap((n) => byName.get(n) ?? []);
}

/**
 * Repositories consulted when resolving the dependencies of a publish: the target repository
 * first, then every other repository by ascending `resolutionPriority`, then name. A lower
 * `resolutionPriority` wins: a dependency found in a priority-5 repository is used over the same
 * coordinate in a priority-10 repository.
 */
export async function publishRepositoryOrder(db: Queryable, target: RepositoryRow): Promise<RepositoryRow[]> {
  const others = await db
    .select()
    .from(repository)
    .where(ne(repository.id, target.id))
    .orderBy(asc(repository.resolutionPriority), asc(repository.name));
  return [target, ...others];
}

/** Finds the newest build (highest build number) of a version in a repository; null when absent. */
export async function findLatestBuild(
  db: Queryable,
  repositoryId: string,
  c: Coordinate,
): Promise<BuildRow | null> {
  const [row] = await db
    .select({ build })
    .from(build)
    .innerJoin(version, eq(version.id, build.versionId))
    .innerJoin(artifact, eq(artifact.id, version.artifactId))
    .where(
      and(
        eq(artifact.repositoryId, repositoryId),
        eq(artifact.group, c.group),
        eq(artifact.name, c.name),
        eq(version.version, c.version),
      ),
    )
    .orderBy(desc(build.buildNumber))
    .limit(1);
  return row?.build ?? null;
}

/** The declared direct dependencies of a build, sorted by `group:name`. */
export async function loadDependencies(db: Queryable, buildId: string): Promise<Coordinate[]> {
  const rows = await db
    .select({ group: dependency.depGroup, name: dependency.depName, version: dependency.depVersion })
    .from(dependency)
    .where(eq(dependency.buildId, buildId))
    .orderBy(asc(dependency.depGroup), asc(dependency.depName));
  return rows;
}

/** The proto files of the given builds, grouped by build id. */
export async function loadFiles(db: Queryable, buildIds: string[]): Promise<Map<string, ProtoFile[]>> {
  const out = new Map<string, ProtoFile[]>(buildIds.map((id) => [id, []]));
  if (buildIds.length === 0) return out;
  const rows = await db
    .select()
    .from(buildFile)
    .where(inArray(buildFile.buildId, buildIds))
    .orderBy(asc(buildFile.path));
  for (const row of rows) out.get(row.buildId)?.push({ path: row.path, content: row.content });
  return out;
}

/** A {@link Lookup} plus the build id behind every coordinate it found, keyed by `group:name:version`. */
export interface RegistryLookup {
  lookup: Lookup;
  buildIds: Map<string, string>;
}

/**
 * Builds a {@link Lookup} over `repositories` in order for a principal. Repositories the principal
 * can't read for the coordinate's group are skipped, so hidden artifacts look exactly like missing
 * ones. Snapshot versions resolve to their newest build.
 */
export function createLookup(db: Queryable, p: Principal, repositories: RepositoryRow[]): RegistryLookup {
  const buildIds = new Map<string, string>();
  const lookup: Lookup = async (c) => {
    for (const repo of repositories) {
      if (!canAccess(p, repo, c.group, "read")) continue;
      const found = await findLatestBuild(db, repo.id, c);
      if (!found) continue;
      buildIds.set(formatCoordinate(c), found.id);
      const node: ResolvedNode = {
        coordinate: { group: c.group, name: c.name, version: c.version },
        repository: repo.name,
        buildNumber: found.buildNumber,
        sha256: found.sha256,
        dependencies: await loadDependencies(db, found.id),
      };
      return node;
    }
    return null;
  };
  return { lookup, buildIds };
}

/** Advisory-lock key serializing every mutation of one version in one repository. */
export function versionLockKey(repositoryName: string, c: Coordinate): string {
  return `${repositoryName}:${formatCoordinate(c)}`;
}
