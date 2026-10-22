import { and, asc, count, countDistinct, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { compareVersions, isValidGroup, isValidName, parseCoordinate, type Format, type Kind, type Principal, type RepositoryConfig } from "@weaver/core";
import { protoArtifact, protoVersion, repository, type Db } from "@weaver/db";
import { browseProcedure, router } from "../init";
import {
  browsableRepositories,
  canReadGroup,
  coordinateString,
  coordinateText,
  escapeLike,
  notFound,
  repositoryName,
  requireBrowsableRepository,
  type RepositoryRow,
} from "../helpers";

/** A repository as browsers see it: no config or upstreams, which only admins also receive. */
export interface BrowseRepo {
  name: string;
  format: Format;
  kind: Kind;
  description: string | null;
  visibility: "public" | "private";
  dockerRoot: boolean;
  /** Mirrors only: whether caching is on. */
  cacheEnabled: boolean | null;
  /** Admins only. */
  id?: string;
  /** Admins only. */
  config?: RepositoryConfig;
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

/**
 * Artifact and version counts per repository id, counting only the groups the principal may read
 * (API keys can be limited to group prefixes).
 */
async function countsByRepository(db: Db, p: Principal, repos: RepositoryRow[]) {
  const out = new Map<string, { artifactCount: number; versionCount: number }>();
  if (repos.length === 0) return out;
  const byId = new Map(repos.map((r) => [r.id, r]));
  const rows = await db
    .select({
      repositoryId: protoArtifact.repositoryId,
      group: protoArtifact.group,
      artifactCount: countDistinct(protoArtifact.id),
      versionCount: count(protoVersion.id),
    })
    .from(protoArtifact)
    .leftJoin(protoVersion, eq(protoVersion.artifactId, protoArtifact.id))
    .where(inArray(protoArtifact.repositoryId, [...byId.keys()]))
    .groupBy(protoArtifact.repositoryId, protoArtifact.group);
  for (const row of rows) {
    if (!canReadGroup(p, byId.get(row.repositoryId)!, row.group)) continue;
    const sum = out.get(row.repositoryId) ?? { artifactCount: 0, versionCount: 0 };
    sum.artifactCount += row.artifactCount;
    sum.versionCount += row.versionCount;
    out.set(row.repositoryId, sum);
  }
  return out;
}

/** The versions of the given artifacts, grouped by artifact id. */
async function versionsByArtifact(db: Db, artifactIds: string[]) {
  const out = new Map<string, { version: string; updatedAt: Date }[]>();
  if (artifactIds.length === 0) return out;
  const rows = await db
    .select({ artifactId: protoVersion.artifactId, version: protoVersion.version, updatedAt: protoVersion.updatedAt })
    .from(protoVersion)
    .where(inArray(protoVersion.artifactId, artifactIds));
  for (const row of rows) {
    const list = out.get(row.artifactId) ?? [];
    list.push({ version: row.version, updatedAt: row.updatedAt });
    out.set(row.artifactId, list);
  }
  return out;
}

/** Read-only browsing of repositories, artifacts, versions and files, scoped to what the caller may read. */
export const browseRouter = router({
  /** Repositories the caller may browse, by name, with format, kind and (proto) artifact and version counts. */
  repositories: browseProcedure.query(async ({ ctx }) => {
    const repos = await browsableRepositories(ctx.db, ctx.principal);
    const counts = await countsByRepository(ctx.db, ctx.principal, repos);
    return repos.map((repo) => ({
      name: repo.name,
      format: repo.format,
      kind: repo.kind,
      description: repo.description,
      visibility: repo.visibility,
      artifactCount: counts.get(repo.id)?.artifactCount ?? 0,
      versionCount: counts.get(repo.id)?.versionCount ?? 0,
      createdAt: repo.createdAt,
    }));
  }),

  /**
   * One repository the caller may browse, for the per-format browse views; `NOT_FOUND` when hidden
   * or missing. Admins get the full repository including its config; everyone else a reduced view
   * without mirror rules or cache settings.
   */
  repository: browseProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }): Promise<BrowseRepo> => {
    await requireBrowsableRepository(ctx.db, ctx.principal, input.name);
    const repo = await ctx.repos.get(input.name);
    if (!repo) throw notFound(`Repository ${input.name} was not found`);
    const cache = (repo.config as { cache?: { enabled?: boolean } }).cache;
    const reduced: BrowseRepo = {
      name: repo.name,
      format: repo.format,
      kind: repo.kind,
      description: repo.description,
      visibility: repo.visibility,
      dockerRoot: repo.dockerRoot,
      cacheEnabled: repo.kind === "mirror" ? cache?.enabled === true : null,
    };
    const isAdmin = ctx.principal.kind === "user" && ctx.principal.role === "admin";
    return isAdmin ? { ...reduced, id: repo.id, config: repo.config } : reduced;
  }),

  /** The artifacts of a proto repository (`BAD_REQUEST` for other formats), optionally filtered by a case-insensitive `search` on group or name. */
  artifacts: browseProcedure
    .input(z.object({ repository: repositoryName, search: z.string().trim().max(200).optional() }))
    .query(async ({ ctx, input }): Promise<ArtifactSummary[]> => {
      const repo = await requireBrowsableRepository(ctx.db, ctx.principal, input.repository, { format: "proto" });
      const pattern = input.search ? `%${escapeLike(input.search)}%` : null;
      const rows = await ctx.db
        .select({ id: protoArtifact.id, group: protoArtifact.group, name: protoArtifact.name })
        .from(protoArtifact)
        .where(
          and(
            eq(protoArtifact.repositoryId, repo.id),
            pattern
              ? or(
                  ilike(protoArtifact.group, pattern),
                  ilike(protoArtifact.name, pattern),
                  ilike(sql`${protoArtifact.group} || ':' || ${protoArtifact.name}`, pattern),
                )
              : undefined,
          ),
        )
        .orderBy(asc(protoArtifact.group), asc(protoArtifact.name));
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
              .select({ id: repository.id, name: repository.name, visibility: repository.visibility })
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
