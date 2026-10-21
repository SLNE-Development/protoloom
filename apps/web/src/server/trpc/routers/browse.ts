import { and, asc, count, countDistinct, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { compareVersions, isValidGroup, isValidName, parseCoordinate, type Principal } from "@protoloom/core";
import { artifact, repository, version, type Db } from "@protoloom/db";
import { browseProcedure, router } from "../init";
import {
  browsableRepositories,
  canReadGroup,
  coordinateString,
  coordinateText,
  escapeLike,
  repositoryName,
  requireBrowsableRepository,
  type RepositoryRow,
} from "../helpers";

/** Most matches `browse.search` returns. */
export const SEARCH_LIMIT_MAX = 20;

/** Rows scanned per search before the permission filter and the limit apply. */
const SEARCH_SCAN = 200;

/** One artifact found by `browse.search`. */
export interface SearchResult {
  repository: string;
  group: string;
  name: string;
  latestVersion: string;
}

/** One artifact of a repository as `browse.artifacts` lists it. */
export interface ArtifactSummary {
  group: string;
  name: string;
  latestVersion: string;
  versionCount: number;
  updatedAt: Date;
}

/** The newest of `versions` by version order, or `null` for none. */
function newest(versions: string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

/** Artifact and version counts per repository id. */
async function countsByRepository(db: Db, repositoryIds: string[]) {
  const out = new Map<string, { artifactCount: number; versionCount: number }>();
  if (repositoryIds.length === 0) return out;
  const rows = await db
    .select({
      repositoryId: artifact.repositoryId,
      artifactCount: countDistinct(artifact.id),
      versionCount: count(version.id),
    })
    .from(artifact)
    .leftJoin(version, eq(version.artifactId, artifact.id))
    .where(inArray(artifact.repositoryId, repositoryIds))
    .groupBy(artifact.repositoryId);
  for (const row of rows) out.set(row.repositoryId, { artifactCount: row.artifactCount, versionCount: row.versionCount });
  return out;
}

/** The versions of the given artifacts, grouped by artifact id. */
async function versionsByArtifact(db: Db, artifactIds: string[]) {
  const out = new Map<string, { version: string; updatedAt: Date }[]>();
  if (artifactIds.length === 0) return out;
  const rows = await db
    .select({ artifactId: version.artifactId, version: version.version, updatedAt: version.updatedAt })
    .from(version)
    .where(inArray(version.artifactId, artifactIds));
  for (const row of rows) {
    const list = out.get(row.artifactId) ?? [];
    list.push({ version: row.version, updatedAt: row.updatedAt });
    out.set(row.artifactId, list);
  }
  return out;
}

/** Artifacts matching `query` (case-insensitive, on group, name or `group:name`) in the repositories. */
export async function searchArtifacts(
  db: Db,
  p: Principal,
  repos: RepositoryRow[],
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  if (repos.length === 0) return [];
  const pattern = `%${escapeLike(query)}%`;
  const byId = new Map(repos.map((r) => [r.id, r]));
  const rows = await db
    .select({ id: artifact.id, repositoryId: artifact.repositoryId, group: artifact.group, name: artifact.name })
    .from(artifact)
    .innerJoin(repository, eq(repository.id, artifact.repositoryId))
    .where(
      and(
        inArray(artifact.repositoryId, [...byId.keys()]),
        or(
          ilike(artifact.group, pattern),
          ilike(artifact.name, pattern),
          ilike(sql`${artifact.group} || ':' || ${artifact.name}`, pattern),
        ),
      ),
    )
    .orderBy(asc(artifact.group), asc(artifact.name), asc(repository.name))
    .limit(SEARCH_SCAN);
  const readable = rows.filter((row) => canReadGroup(p, byId.get(row.repositoryId)!, row.group));
  const versions = await versionsByArtifact(db, readable.map((row) => row.id));
  const results: SearchResult[] = [];
  for (const row of readable) {
    const latestVersion = newest((versions.get(row.id) ?? []).map((v) => v.version));
    if (latestVersion === null) continue;
    results.push({ repository: byId.get(row.repositoryId)!.name, group: row.group, name: row.name, latestVersion });
    if (results.length === limit) break;
  }
  return results;
}

/** Read-only browsing of repositories, artifacts, versions and files, scoped to what the caller may read. */
export const browseRouter = router({
  /** Repositories the caller may browse, by name, with artifact and version counts. */
  repositories: browseProcedure.query(async ({ ctx }) => {
    const repos = await browsableRepositories(ctx.db, ctx.principal);
    const counts = await countsByRepository(
      ctx.db,
      repos.map((r) => r.id),
    );
    return repos.map((repo) => ({
      name: repo.name,
      description: repo.description,
      visibility: repo.visibility,
      artifactCount: counts.get(repo.id)?.artifactCount ?? 0,
      versionCount: counts.get(repo.id)?.versionCount ?? 0,
      createdAt: repo.createdAt,
    }));
  }),

  /**
   * Artifacts whose group, name or `group:name` contains `query` (case-insensitive) across every
   * repository the caller may browse, with their latest version. Used by the command dialog.
   */
  search: browseProcedure
    .input(z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).default(10) }))
    .query(async ({ ctx, input }): Promise<SearchResult[]> => {
      const repos = await browsableRepositories(ctx.db, ctx.principal);
      return searchArtifacts(ctx.db, ctx.principal, repos, input.query, input.limit);
    }),

  /** The artifacts of a repository, optionally filtered by a case-insensitive `search` on group or name. */
  artifacts: browseProcedure
    .input(z.object({ repository: repositoryName, search: z.string().trim().max(200).optional() }))
    .query(async ({ ctx, input }): Promise<ArtifactSummary[]> => {
      const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository);
      const pattern = input.search ? `%${escapeLike(input.search)}%` : null;
      const rows = await ctx.db
        .select({ id: artifact.id, group: artifact.group, name: artifact.name })
        .from(artifact)
        .where(
          and(
            eq(artifact.repositoryId, repo.id),
            pattern
              ? or(
                  ilike(artifact.group, pattern),
                  ilike(artifact.name, pattern),
                  ilike(sql`${artifact.group} || ':' || ${artifact.name}`, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(asc(artifact.group), asc(artifact.name));
      const readable = rows.filter((row) => canReadGroup(ctx.principal, repo, row.group));
      const versions = await versionsByArtifact(ctx.db, readable.map((row) => row.id));
      return readable.flatMap((row) => {
        const list = versions.get(row.id) ?? [];
        const latestVersion = newest(list.map((v) => v.version));
        if (latestVersion === null) return [];
        const updatedAt = new Date(Math.max(...list.map((v) => v.updatedAt.getTime())));
        return [{ group: row.group, name: row.name, latestVersion, versionCount: list.length, updatedAt }];
      });
    }),

  /** The versions of an artifact, newest first. */
  versions: browseProcedure
    .input(
      z.object({
        repository: repositoryName,
        group: z.string().refine(isValidGroup, "Invalid group"),
        name: z.string().refine(isValidName, "Invalid artifact name"),
      }),
    )
    .query(({ ctx, input }) => ctx.registry.listVersions(ctx.principal, input.repository, input.group, input.name)),

  /**
   * A version's metadata (its newest build) with the coordinate, dependencies and dependents as
   * `group:name:version` strings. Dependents in repositories the caller can't read are left out.
   */
  version: browseProcedure
    .input(z.object({ repository: repositoryName, coordinate: coordinateString }))
    .query(async ({ ctx, input }) => {
      const c = parseCoordinate(input.coordinate);
      const info = await ctx.registry.getManifest(ctx.principal, input.repository, c);
      const dependents = await ctx.registry.listDependents(c);
      const names = [...new Set(dependents.map((d) => d.repository))];
      const repos =
        names.length === 0
          ? []
          : await ctx.db
              .select({ name: repository.name, visibility: repository.visibility })
              .from(repository)
              .where(inArray(repository.name, names));
      const byName = new Map(repos.map((r) => [r.name, r]));
      return {
        ...info,
        coordinate: coordinateText(info.coordinate),
        dependencies: info.dependencies.map(coordinateText),
        dependents: dependents
          .filter((d) => {
            const repo = byName.get(d.repository);
            return repo !== undefined && canReadGroup(ctx.principal, repo, d.coordinate.group);
          })
          .map((d) => ({ repository: d.repository, coordinate: coordinateText(d.coordinate) })),
      };
    }),

  /** One proto file of a version's newest build. */
  file: browseProcedure
    .input(z.object({ repository: repositoryName, coordinate: coordinateString, path: z.string().min(1).max(1024) }))
    .query(async ({ ctx, input }) => {
      const content = await ctx.registry.getFile(ctx.principal, input.repository, parseCoordinate(input.coordinate), input.path);
      return { path: input.path, content };
    }),
});
