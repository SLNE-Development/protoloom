import { TRPCError } from "@trpc/server";
import { count, countDistinct, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  defaultRepositoryConfig,
  RegistryError,
  RESOLUTION_PRIORITY_MAX,
  type Format,
  type Kind,
  type ProtoHostedConfig,
  type Repo,
} from "@weaver/core";
import { cleanupPolicy, protoArtifact, protoVersion, repository, type Db } from "@weaver/db";
import { adminProcedure, router } from "../init";
import { repositoryName } from "../helpers";

/** Repository settings an admin can set; omitted fields keep their current (or default) value. */
const repositorySettings = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  allowRedeploy: z.boolean().optional(),
  allowReleases: z.boolean().optional(),
  allowSnapshots: z.boolean().optional(),
  /** Lower wins when dependencies are looked up across repositories at publish time. */
  resolutionPriority: z.number().int().min(0).max(RESOLUTION_PRIORITY_MAX).optional(),
});

/** A repository with its settings and content counts, as the admin pages show it. */
export interface RepositoryDetails {
  name: string;
  format: Format;
  kind: Kind;
  description: string | null;
  visibility: "public" | "private";
  /** Proto settings of a hosted proto repository; the proto defaults for every other repository. */
  allowRedeploy: boolean;
  allowReleases: boolean;
  allowSnapshots: boolean;
  resolutionPriority: number;
  createdAt: Date;
  artifactCount: number;
  versionCount: number;
  policyCount: number;
}

/** The proto settings of a repository, or the proto defaults when it is not a hosted proto repository. */
function protoConfigOf(repo: Repo): ProtoHostedConfig {
  return repo.format === "proto" && repo.kind === "hosted"
    ? (repo.config as ProtoHostedConfig)
    : defaultRepositoryConfig("proto", "hosted");
}

async function withCounts(db: Db, repos: Repo[]): Promise<RepositoryDetails[]> {
  const ids = repos.map((r) => r.id);
  const [contents, policies, created] =
    ids.length === 0
      ? [[], [], []]
      : await Promise.all([
          db
            .select({ repositoryId: protoArtifact.repositoryId, artifacts: countDistinct(protoArtifact.id), versions: count(protoVersion.id) })
            .from(protoArtifact)
            .leftJoin(protoVersion, eq(protoVersion.artifactId, protoArtifact.id))
            .where(inArray(protoArtifact.repositoryId, ids))
            .groupBy(protoArtifact.repositoryId),
          db
            .select({ repositoryId: cleanupPolicy.repositoryId, policies: count() })
            .from(cleanupPolicy)
            .where(inArray(cleanupPolicy.repositoryId, ids))
            .groupBy(cleanupPolicy.repositoryId),
          db.select({ id: repository.id, createdAt: repository.createdAt }).from(repository).where(inArray(repository.id, ids)),
        ]);
  const contentById = new Map(contents.map((row) => [row.repositoryId, row]));
  const policiesById = new Map(policies.map((row) => [row.repositoryId, row.policies]));
  const createdById = new Map(created.map((row) => [row.id, row.createdAt]));
  return repos.map((repo) => ({
    name: repo.name,
    format: repo.format,
    kind: repo.kind,
    description: repo.description,
    visibility: repo.visibility,
    ...protoConfigOf(repo),
    createdAt: createdById.get(repo.id)!,
    artifactCount: contentById.get(repo.id)?.artifacts ?? 0,
    versionCount: contentById.get(repo.id)?.versions ?? 0,
    policyCount: policiesById.get(repo.id) ?? 0,
  }));
}

/** The proto settings present in `input`, as a config patch. */
function settingsPatch(input: Partial<ProtoHostedConfig>): Partial<ProtoHostedConfig> {
  const patch: Partial<ProtoHostedConfig> = {};
  if (input.allowRedeploy !== undefined) patch.allowRedeploy = input.allowRedeploy;
  if (input.allowReleases !== undefined) patch.allowReleases = input.allowReleases;
  if (input.allowSnapshots !== undefined) patch.allowSnapshots = input.allowSnapshots;
  if (input.resolutionPriority !== undefined) patch.resolutionPriority = input.resolutionPriority;
  return patch;
}

/** Whether the service refused a name that is already taken. */
function isNameTaken(error: unknown): boolean {
  const details = error instanceof RegistryError ? (error.details as { field?: unknown; reason?: unknown } | undefined) : undefined;
  return details?.field === "name" && details.reason === "taken";
}

function notFound(name: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `Repository ${name} was not found` });
}

/** Repository management (admin), delegated to the repository service, which audits every change. */
export const repositoriesRouter = router({
  list: adminProcedure.query(async ({ ctx }) => withCounts(ctx.db, await ctx.repos.list())),

  get: adminProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }) => {
    const repo = await ctx.repos.get(input.name);
    if (!repo) throw notFound(input.name);
    const [details] = await withCounts(ctx.db, [repo]);
    return details!;
  }),

  /** Creates a hosted proto repository; `CONFLICT` when the name is taken. */
  create: adminProcedure.input(repositorySettings.extend({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    const { name, description, visibility } = input;
    try {
      const created = await ctx.repos.create(ctx.principal, {
        name,
        format: "proto",
        kind: "hosted",
        description,
        visibility,
        config: settingsPatch(input),
      });
      const [details] = await withCounts(ctx.db, [created]);
      return details!;
    } catch (error) {
      // No `cause`: the domain-error middleware would map the RegistryError back to BAD_REQUEST.
      if (isNameTaken(error)) throw new TRPCError({ code: "CONFLICT", message: `Repository ${name} already exists` });
      throw error;
    }
  }),

  /** Changes the given settings of a repository; the proto settings apply to hosted proto repositories only. */
  update: adminProcedure.input(repositorySettings.extend({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    const { name, description, visibility, ...settings } = input;
    const config = settingsPatch(settings);
    const updated = await ctx.repos.update(ctx.principal, name, {
      description,
      visibility,
      config: Object.keys(config).length > 0 ? config : undefined,
    });
    const [details] = await withCounts(ctx.db, [updated]);
    return details!;
  }),

  /** Deletes an empty repository; `PRECONDITION_FAILED` while it still holds artifacts. */
  delete: adminProcedure.input(z.object({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    const repo = await ctx.repos.get(input.name);
    if (!repo) throw notFound(input.name);
    const [used] = await ctx.db.select({ id: protoArtifact.id }).from(protoArtifact).where(eq(protoArtifact.repositoryId, repo.id)).limit(1);
    if (used) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Repository ${input.name} still contains artifacts; delete them first`,
      });
    }
    // Key scopes reference the repository row, so they go with it (a later namesake inherits none).
    await ctx.repos.delete(ctx.principal, input.name);
    return { name: input.name };
  }),
});
