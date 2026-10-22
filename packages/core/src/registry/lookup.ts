import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { protoArtifact, protoBuild, protoBuildFile, protoDependency, protoVersion, repository, type Db, type Tx } from "@weaver/db";
import type { ProtoFile } from "../archive.js";
import { formatCoordinate, type Coordinate } from "../coordinates.js";
import { canAccess, canReadThroughGroup, type Principal } from "../permissions.js";
import type { ProtoHostedConfig } from "../repos/config.js";
import { toRepo, type Repo, type RepoService } from "../repos/service.js";
import type { Lookup, ResolvedNode } from "../resolution.js";
import type { StoreId, StoreSet } from "../storage/index.js";
import type { validateProtos } from "../validation.js";

/** Dependencies shared by the registry operations. */
export interface RegistryContext {
  db: Db;
  /** Proto archives are written to `stores.primary` and read from the store their build names. */
  stores: StoreSet;
  /** Loads repositories, their groups and group members. */
  repos: RepoService;
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

/** The settings of a hosted proto repository; the caller has checked `repo.kind === "hosted"`. */
export function hostedProtoConfig(repo: Repo): ProtoHostedConfig {
  return repo.config as ProtoHostedConfig;
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

/** Loads a proto repository row by name; null when no proto repository has that name. */
export async function findRepository(db: Queryable, name: string): Promise<RepositoryRow | null> {
  const [row] = await db
    .select()
    .from(repository)
    .where(and(eq(repository.name, name), eq(repository.format, "proto")));
  return row ?? null;
}

/**
 * Whether the principal may read `repo` for at least one proto group by its own permissions: a
 * public repository, a user, or a key with an entry for it (whose group prefix the lookup then
 * checks per coordinate).
 */
function mayReadSomeGroup(p: Principal, repo: Repo): boolean {
  if (canAccess(p, repo, "", "read")) return true;
  return p.kind === "apikey" && p.permissions.some((entry) => entry.repositoryId === repo.id);
}

/** The repositories a publish resolves its dependencies in, and which of them the publisher reads through a group. */
export interface PublishSources {
  /** The target first, then the other readable hosted proto repositories (see {@link publishRepositoryOrder}). */
  repositories: Repo[];
  /** Ids of the repositories readable through a group the publisher can read; read without further checks. */
  groupGranted: Set<string>;
}

/**
 * The repositories and group grants behind {@link publishRepositoryOrder}. A hosted repository is
 * kept when the publisher may read it directly (for some group) or through a group containing it
 * that the publisher can read; groups add access, not order.
 */
export async function publishSources(db: Queryable, repos: RepoService, p: Principal, target: Repo): Promise<PublishSources> {
  const rows = await db
    .select()
    .from(repository)
    .where(and(eq(repository.format, "proto"), eq(repository.kind, "hosted"), ne(repository.id, target.id)))
    .orderBy(asc(repository.name));
  // A stable sort keeps the name order within equal priorities. Sorting the leniently read config
  // (instead of casting the JSON in SQL) also ranks a damaged stored value at the default.
  const others = rows.map(toRepo).sort((a, b) => hostedProtoConfig(a).resolutionPriority - hostedProtoConfig(b).resolutionPriority);

  const groupGranted = new Set<string>();
  const repositories: Repo[] = [];
  for (const repo of [target, ...others]) {
    const groups = await repos.groupsContaining(repo.id);
    if (groups.some((g) => canReadThroughGroup(p, g))) groupGranted.add(repo.id);
    if (repo === target || groupGranted.has(repo.id) || mayReadSomeGroup(p, repo)) repositories.push(repo);
  }
  return { repositories, groupGranted };
}

/**
 * Hosted proto repositories consulted for a publish's dependencies, in order: the target first,
 * then every other hosted proto repository the publisher can read (directly or through a readable
 * group) by ascending `resolutionPriority`, then name. A lower `resolutionPriority` wins: a
 * dependency found in a priority-5 repository is used over the same coordinate in a priority-10
 * repository. Mirrors and groups are never consulted.
 */
export async function publishRepositoryOrder(db: Queryable, repos: RepoService, p: Principal, target: Repo): Promise<Repo[]> {
  return (await publishSources(db, repos, p, target)).repositories;
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

/** The resolved node of build `found` of `c` in `repo`. */
export async function nodeOf(db: Queryable, repo: Pick<Repo, "name">, c: Coordinate, found: BuildRow): Promise<ResolvedNode> {
  return {
    coordinate: { group: c.group, name: c.name, version: c.version },
    repository: repo.name,
    buildNumber: found.buildNumber,
    sha256: found.sha256,
    dependencies: await loadDependencies(db, found.id),
  };
}

/** A {@link Lookup} plus the build id behind every coordinate it found, keyed by `group:name:version`. */
export interface RegistryLookup {
  lookup: Lookup;
  buildIds: Map<string, string>;
}

/**
 * Builds a {@link Lookup} over `repositories` in order for a principal. Repositories in
 * `groupGranted` (read through a group) are read without further checks; the others are skipped
 * when the principal can't read them for the coordinate's group, so hidden artifacts look exactly
 * like missing ones. Snapshot versions resolve to their newest build.
 */
export function createLookup(
  db: Queryable,
  p: Principal,
  repositories: Repo[],
  groupGranted: ReadonlySet<string> = new Set(),
): RegistryLookup {
  const buildIds = new Map<string, string>();
  const lookup: Lookup = async (c) => {
    for (const repo of repositories) {
      if (!groupGranted.has(repo.id) && !canAccess(p, repo, c.group, "read")) continue;
      const found = await findLatestBuild(db, repo.id, c);
      if (!found) continue;
      buildIds.set(formatCoordinate(c), found.id);
      return nodeOf(db, repo, c, found);
    }
    return null;
  };
  return { lookup, buildIds };
}

/** Advisory-lock key serializing every mutation of one version in one repository. */
export function versionLockKey(repositoryName: string, c: Coordinate): string {
  return `${repositoryName}:${formatCoordinate(c)}`;
}
