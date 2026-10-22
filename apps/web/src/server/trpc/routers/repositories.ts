import { TRPCError } from "@trpc/server";
import { asc, count, countDistinct, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiKeyPermission, artifact, cleanupPolicy, repository, version, type Db } from "@weaver/db";
import { adminProcedure, router } from "../init";
import { audited, repositoryName, requireRepository, type RepositoryRow } from "../helpers";

/** Repository settings an admin can set; omitted fields keep their current (or default) value. */
const repositorySettings = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  allowRedeploy: z.boolean().optional(),
  allowReleases: z.boolean().optional(),
  allowSnapshots: z.boolean().optional(),
  /** Lower wins when dependencies are looked up across repositories at publish time. */
  resolutionPriority: z.number().int().min(0).max(100_000).optional(),
});

/** A repository with its settings and content counts, as the admin pages show it. */
export interface RepositoryDetails {
  name: string;
  description: string | null;
  visibility: "public" | "private";
  allowRedeploy: boolean;
  allowReleases: boolean;
  allowSnapshots: boolean;
  resolutionPriority: number;
  createdAt: Date;
  artifactCount: number;
  versionCount: number;
  policyCount: number;
}

async function withCounts(db: Db, repos: RepositoryRow[]): Promise<RepositoryDetails[]> {
  const ids = repos.map((r) => r.id);
  const [contents, policies] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({ repositoryId: artifact.repositoryId, artifacts: countDistinct(artifact.id), versions: count(version.id) })
            .from(artifact)
            .leftJoin(version, eq(version.artifactId, artifact.id))
            .where(inArray(artifact.repositoryId, ids))
            .groupBy(artifact.repositoryId),
          db
            .select({ repositoryId: cleanupPolicy.repositoryId, policies: count() })
            .from(cleanupPolicy)
            .where(inArray(cleanupPolicy.repositoryId, ids))
            .groupBy(cleanupPolicy.repositoryId),
        ]);
  const contentById = new Map(contents.map((row) => [row.repositoryId, row]));
  const policiesById = new Map(policies.map((row) => [row.repositoryId, row.policies]));
  return repos.map(({ id, ...repo }) => ({
    ...repo,
    artifactCount: contentById.get(id)?.artifacts ?? 0,
    versionCount: contentById.get(id)?.versions ?? 0,
    policyCount: policiesById.get(id) ?? 0,
  }));
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** Repository management (admin). Every change is audited. */
export const repositoriesRouter = router({
  list: adminProcedure.query(async ({ ctx }) =>
    withCounts(ctx.db, await ctx.db.select().from(repository).orderBy(asc(repository.name))),
  ),

  get: adminProcedure.input(z.object({ name: repositoryName })).query(async ({ ctx, input }) => {
    const [details] = await withCounts(ctx.db, [await requireRepository(ctx.db, input.name)]);
    return details!;
  }),

  /** Creates a repository; `CONFLICT` when the name is taken. */
  create: adminProcedure.input(repositorySettings.extend({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    try {
      const created = await audited(
        ctx.db,
        { actor: ctx.principal, action: "repository.create", target: input.name, details: input },
        async (tx) => (await tx.insert(repository).values(input).returning())[0]!,
      );
      const [details] = await withCounts(ctx.db, [created]);
      return details!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new TRPCError({ code: "CONFLICT", message: `Repository ${input.name} already exists` });
      }
      throw error;
    }
  }),

  /** Changes the given settings of a repository. */
  update: adminProcedure.input(repositorySettings.extend({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    const { name, ...patch } = input;
    const updated = await audited(
      ctx.db,
      { actor: ctx.principal, action: "repository.update", target: name, details: patch },
      async (tx) => {
        const repo = await requireRepository(tx, name);
        if (Object.keys(patch).length === 0) return repo;
        return (await tx.update(repository).set(patch).where(eq(repository.id, repo.id)).returning())[0]!;
      },
    );
    const [details] = await withCounts(ctx.db, [updated]);
    return details!;
  }),

  /** Deletes an empty repository; `PRECONDITION_FAILED` while it still holds artifacts. */
  delete: adminProcedure.input(z.object({ name: repositoryName })).mutation(async ({ ctx, input }) => {
    await audited(ctx.db, { actor: ctx.principal, action: "repository.delete", target: input.name }, async (tx) => {
      const repo = await requireRepository(tx, input.name, { forUpdate: true });
      const [used] = await tx.select({ id: artifact.id }).from(artifact).where(eq(artifact.repositoryId, repo.id)).limit(1);
      if (used) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Repository ${input.name} still contains artifacts; delete them first`,
        });
      }
      await tx.delete(repository).where(eq(repository.id, repo.id));
      // Key scopes name repositories by name; a later repository with the same name must not inherit them.
      await tx.delete(apiKeyPermission).where(eq(apiKeyPermission.repository, repo.name));
    });
    return { name: input.name };
  }),
});
