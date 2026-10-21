import { and, asc, eq, max, sql } from "drizzle-orm";
import { artifact, build, buildFile, dependency, repository, user, version } from "@protoloom/db";
import { compareVersions, formatCoordinate, type Coordinate } from "../coordinates.js";
import { RegistryError } from "../errors.js";
import { canAccess, canForce, type Principal } from "../permissions.js";
import { resolveGraph, type Resolution, type ResolveOptions } from "../resolution.js";
import {
  createLookup,
  findLatestBuild,
  findRepositories,
  findRepository,
  loadDependencies,
  type BuildRow,
  type Queryable,
  type RegistryContext,
  type RepositoryRow,
} from "./lookup.js";

/** Summary of one version of an artifact. */
export interface VersionSummary {
  version: string;
  isSnapshot: boolean;
  latestBuild: number;
  updatedAt: Date;
}

/** Full metadata of a version, describing its newest build. */
export interface VersionInfo {
  repository: string;
  coordinate: Coordinate;
  buildNumber: number;
  sha256: string;
  sizeBytes: number;
  dependencies: Coordinate[];
  files: string[];
  publishedBy: string | null;
  downloadCount: number;
  createdAt: Date;
  builds: { buildNumber: number; createdAt: Date; sha256: string }[];
}

/** A version that declares a dependency on some coordinate. */
export interface Dependent {
  repository: string;
  coordinate: Coordinate;
}

function notFound(what: string): RegistryError {
  return new RegistryError("not_found", `${what} was not found`);
}

/**
 * Loads a repository the principal may read for `group`. Missing and unreadable repositories both
 * throw the same `not_found`, so private repositories are not disclosed.
 */
export async function readableRepository(
  db: Queryable,
  p: Principal,
  name: string,
  group: string,
): Promise<RepositoryRow> {
  const repo = await findRepository(db, name);
  if (!repo || !canAccess(p, repo, group, "read")) throw notFound(`Repository ${name}`);
  return repo;
}

/** The newest build of a version in a readable repository; throws `not_found` otherwise. */
async function readableBuild(
  db: Queryable,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
): Promise<{ repo: RepositoryRow; build: BuildRow }> {
  const repo = await readableRepository(db, p, repositoryName, c.group);
  const found = await findLatestBuild(db, repo.id, c);
  if (!found) throw notFound(`Version ${formatCoordinate(c)}`);
  return { repo, build: found };
}

/** Lists the versions of an artifact, newest version first. */
export async function listVersions(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  group: string,
  name: string,
): Promise<VersionSummary[]> {
  const repo = await readableRepository(ctx.db, p, repositoryName, group);
  const rows = await ctx.db
    .select({
      version: version.version,
      isSnapshot: version.isSnapshot,
      updatedAt: version.updatedAt,
      latestBuild: max(build.buildNumber),
    })
    .from(version)
    .innerJoin(artifact, eq(artifact.id, version.artifactId))
    .innerJoin(build, eq(build.versionId, version.id))
    .where(and(eq(artifact.repositoryId, repo.id), eq(artifact.group, group), eq(artifact.name, name)))
    .groupBy(version.id);
  if (rows.length === 0) throw notFound(`Artifact ${group}:${name}`);
  return rows
    .map((r) => ({ ...r, latestBuild: r.latestBuild ?? 0 }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Metadata of a version; snapshots describe their newest build. */
export async function getManifest(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
): Promise<VersionInfo> {
  const { repo, build: latest } = await readableBuild(ctx.db, p, repositoryName, c);
  const [files, dependencies, builds, publisher] = await Promise.all([
    ctx.db
      .select({ path: buildFile.path })
      .from(buildFile)
      .where(eq(buildFile.buildId, latest.id))
      .orderBy(asc(buildFile.path)),
    loadDependencies(ctx.db, latest.id),
    ctx.db
      .select({ buildNumber: build.buildNumber, createdAt: build.createdAt, sha256: build.sha256 })
      .from(build)
      .where(eq(build.versionId, latest.versionId))
      .orderBy(asc(build.buildNumber)),
    latest.publishedByUserId
      ? ctx.db.select({ name: user.name }).from(user).where(eq(user.id, latest.publishedByUserId))
      : Promise.resolve([]),
  ]);
  return {
    repository: repo.name,
    coordinate: { group: c.group, name: c.name, version: c.version },
    buildNumber: latest.buildNumber,
    sha256: latest.sha256,
    sizeBytes: latest.sizeBytes,
    dependencies,
    files: files.map((f) => f.path),
    publishedBy: publisher[0]?.name ?? latest.publishedByUserId,
    downloadCount: latest.downloadCount,
    createdAt: latest.createdAt,
    builds,
  };
}

/** Returns the archive of a version's newest build and counts the download on that build. */
export async function download(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
): Promise<{ data: Buffer; sha256: string; filename: string }> {
  const { build: served } = await readableBuild(ctx.db, p, repositoryName, c);
  const data = await ctx.blobs.get(served.storageKey);
  if (!data) throw new Error(`Archive blob ${served.storageKey} is missing from storage`);
  await ctx.db
    .update(build)
    .set({ downloadCount: sql`${build.downloadCount} + 1`, lastDownloadedAt: new Date() })
    .where(eq(build.id, served.id));
  return { data, sha256: served.sha256, filename: `${c.name}-${c.version}.tar.gz` };
}

/** Returns one proto file of a version's newest build. */
export async function getFile(
  ctx: RegistryContext,
  p: Principal,
  repositoryName: string,
  c: Coordinate,
  path: string,
): Promise<string> {
  const { build: latest } = await readableBuild(ctx.db, p, repositoryName, c);
  const [row] = await ctx.db
    .select({ content: buildFile.content })
    .from(buildFile)
    .where(and(eq(buildFile.buildId, latest.id), eq(buildFile.path, path)));
  if (!row) throw notFound(`File ${path}`);
  return row.content;
}

/** Resolves `roots` against `repositories` in order, as seen by the principal; see {@link resolveGraph} for `options`. */
export async function resolve(
  ctx: RegistryContext,
  p: Principal,
  repositories: string[],
  roots: Coordinate[],
  options: ResolveOptions = {},
): Promise<Resolution> {
  const repos = await findRepositories(ctx.db, repositories);
  return resolveGraph(roots, createLookup(ctx.db, p, repos).lookup, options);
}

/** A dependent plus its repository's visibility, so callers can filter by read access. */
export interface DependentRow extends Dependent {
  visibility: "public" | "private";
}

/** Every version, in any repository, whose builds declare a dependency on `c`. */
export async function listDependents(db: Queryable, c: Coordinate): Promise<Dependent[]> {
  return (await findDependents(db, c)).map(({ repository, coordinate }) => ({ repository, coordinate }));
}

/** Like {@link listDependents}, also carrying each dependent repository's visibility. */
export async function findDependents(db: Queryable, c: Coordinate): Promise<DependentRow[]> {
  const rows = await db
    .selectDistinct({
      repository: repository.name,
      visibility: repository.visibility,
      group: artifact.group,
      name: artifact.name,
      version: version.version,
    })
    .from(dependency)
    .innerJoin(build, eq(build.id, dependency.buildId))
    .innerJoin(version, eq(version.id, build.versionId))
    .innerJoin(artifact, eq(artifact.id, version.artifactId))
    .innerJoin(repository, eq(repository.id, artifact.repositoryId))
    .where(
      and(eq(dependency.depGroup, c.group), eq(dependency.depName, c.name), eq(dependency.depVersion, c.version)),
    )
    .orderBy(asc(repository.name), asc(artifact.group), asc(artifact.name), asc(version.version));
  return rows.map((r) => ({
    repository: r.repository,
    visibility: r.visibility,
    coordinate: { group: r.group, name: r.name, version: r.version },
  }));
}

/**
 * Allows removing or replacing a version only when nothing depends on it, or when an admin forces
 * it. Throws `has_dependents` without `force`, and `forbidden` when a non-admin forces. The error
 * lists only the dependents the caller can read; the others are counted in `hiddenDependents`.
 * Returns whether the action is forced past existing dependents.
 */
export function assertNoDependents(
  p: Principal,
  c: Coordinate,
  dependents: DependentRow[],
  force: boolean | undefined,
): boolean {
  if (dependents.length === 0) return false;
  if (!force) {
    const visible = dependents
      .filter((d) => canAccess(p, { name: d.repository, visibility: d.visibility }, d.coordinate.group, "read"))
      .map(({ repository: repo, coordinate }) => ({ repository: repo, coordinate }));
    throw new RegistryError(
      "has_dependents",
      `${formatCoordinate(c)} is depended on by ${dependents.length} version(s)`,
      { dependents: visible, hiddenDependents: dependents.length - visible.length },
    );
  }
  if (!canForce(p)) throw new RegistryError("forbidden", "Only admins can force past dependents");
  return true;
}
