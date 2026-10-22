import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { protoArtifact, protoBuild, protoBuildFile, protoDependency, protoVersion, repository, type Db, type Tx } from "@weaver/db";
import type { ProtoFile } from "../archive.js";
import { formatCoordinate, type Coordinate } from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canAccess, type Principal } from "../permissions.js";
import { readRepositoryConfig, type ProtoHostedConfig } from "../repos/config.js";
import type { Lookup, ResolvedNode } from "../resolution.js";
import type { StoreId, StoreSet } from "../storage/index.js";
import type { validateProtos } from "../validation.js";

/** Dependencies shared by the registry operations. */
export interface RegistryContext {
  db: Db;
  /** Proto archives are written to `stores.primary` and read from the store their build names. */
  stores: StoreSet;
  validate: typeof validateProtos;
}

/** A database handle or an open transaction. */
export type Queryable = Db | Tx;

/** A row of the `repository` table. */
export type RepositoryRow = typeof repository.$inferSelect;
/** A row of the `proto_build` table. */
export type BuildRow = typeof protoBuild.$inferSelect;

/** Where a stored blob lives: the store it was written to and its key there. */
export interface BlobRef {
  store: StoreId;
  storageKey: string;
}

/**
 * The settings of a hosted proto repository, read from `repo.config` with defaults filled in.
 * Mirrors and groups accept no publishes; `invalid_request` for them.
 */
export function hostedProtoConfig(repo: Pick<RepositoryRow, "name" | "kind" | "config">): ProtoHostedConfig {
  if (repo.kind !== "hosted") {
    throw new RegistryError("invalid_request", `Repository ${repo.name} is a ${repo.kind}; publish to a hosted repository`);
  }
  return readRepositoryConfig({ name: repo.name, format: "proto", kind: "hosted", config: repo.config });
}

/** The `resolutionPriority` of a proto repository; mirrors and groups have none and rank at the default 100. */
function resolutionPriority(repo: RepositoryRow): number {
  if (repo.kind !== "hosted") return 100;
  return readRepositoryConfig({ name: repo.name, format: "proto", kind: "hosted", config: repo.config }).resolutionPriority;
}

/**
 * Deletes a blob whose rows are already gone (or never committed). A failure, or a store that is
 * no longer configured, only leaves an orphaned blob behind, so it is logged with the key instead
 * of failing the operation.
 */
export async function deleteBlobLogged(stores: StoreSet, blob: BlobRef): Promise<void> {
  const store = stores.get(blob.store);
  if (!store) {
    console.warn(`weaver: cannot delete orphaned blob ${blob.storageKey}: store ${blob.store} is not configured`);
    return;
  }
  try {
    await store.delete(blob.storageKey);
  } catch (error) {
    console.warn(`weaver: failed to delete orphaned blob ${blob.storageKey}`, error);
  }
}

/** Loads a proto repository by name; null when no proto repository has that name. */
export async function findRepository(db: Queryable, name: string): Promise<RepositoryRow | null> {
  const [row] = await db
    .select()
    .from(repository)
    .where(and(eq(repository.name, name), eq(repository.format, "proto")));
  return row ?? null;
}

/** Loads the named proto repositories in the given order, skipping unknown names and duplicates. */
export async function findRepositories(db: Queryable, names: string[]): Promise<RepositoryRow[]> {
  const unique = [...new Set(names)];
  if (unique.length === 0) return [];
  const rows = await db
    .select()
    .from(repository)
    .where(and(inArray(repository.name, unique), eq(repository.format, "proto")));
  const byName = new Map(rows.map((r) => [r.name, r]));
  return unique.flatMap((n) => byName.get(n) ?? []);
}

/**
 * Repositories consulted when resolving the dependencies of a publish: the target repository
 * first, then every other proto repository by ascending `resolutionPriority`, then name. A lower
 * `resolutionPriority` wins: a dependency found in a priority-5 repository is used over the same
 * coordinate in a priority-10 repository.
 */
export async function publishRepositoryOrder(db: Queryable, target: RepositoryRow): Promise<RepositoryRow[]> {
  const others = await db
    .select()
    .from(repository)
    .where(and(ne(repository.id, target.id), eq(repository.format, "proto")))
    .orderBy(asc(repository.name));
  // A stable sort keeps the database's name order within equal priorities.
  others.sort((a, b) => resolutionPriority(a) - resolutionPriority(b));
  return [target, ...others];
}

/**
 * Finds the newest build (highest build number) of a version in a repository, or exactly build
 * `buildNumber` when given; null when absent.
 */
export async function findLatestBuild(
  db: Queryable,
  repositoryId: string,
  c: Coordinate,
  buildNumber?: number,
): Promise<BuildRow | null> {
  const [row] = await db
    .select({ build: protoBuild })
    .from(protoBuild)
    .innerJoin(protoVersion, eq(protoVersion.id, protoBuild.versionId))
    .innerJoin(protoArtifact, eq(protoArtifact.id, protoVersion.artifactId))
    .where(
      and(
        eq(protoArtifact.repositoryId, repositoryId),
        eq(protoArtifact.group, c.group),
        eq(protoArtifact.name, c.name),
        eq(protoVersion.version, c.version),
        buildNumber === undefined ? undefined : eq(protoBuild.buildNumber, buildNumber),
      ),
    )
    .orderBy(desc(protoBuild.buildNumber))
    .limit(1);
  return row?.build ?? null;
}

/** The declared direct dependencies of a build, sorted by `group:name`. */
export async function loadDependencies(db: Queryable, buildId: string): Promise<Coordinate[]> {
  const rows = await db
    .select({ group: protoDependency.depGroup, name: protoDependency.depName, version: protoDependency.depVersion })
    .from(protoDependency)
    .where(eq(protoDependency.buildId, buildId))
    .orderBy(asc(protoDependency.depGroup), asc(protoDependency.depName));
  return rows;
}

/** The proto files of the given builds, grouped by build id. */
export async function loadFiles(db: Queryable, buildIds: string[]): Promise<Map<string, ProtoFile[]>> {
  const out = new Map<string, ProtoFile[]>(buildIds.map((id) => [id, []]));
  if (buildIds.length === 0) return out;
  const rows = await db
    .select()
    .from(protoBuildFile)
    .where(inArray(protoBuildFile.buildId, buildIds))
    .orderBy(asc(protoBuildFile.path));
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
