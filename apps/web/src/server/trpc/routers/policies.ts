import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { planCleanup } from "@protoloom/core";
import { cleanupPolicy } from "@protoloom/db";
import { enqueueCleanup, getJobState, type CleanupJobStatus } from "@protoloom/jobs";
import { adminProcedure, router, type TrpcContext } from "../init";
import { audited, coordinateText, groupPrefix, notFound, repositoryName, requireRepository } from "../helpers";

/** A cleanup rule of a repository. */
export interface CleanupPolicy {
  id: string;
  kind: "keep_last_snapshot_builds" | "delete_stale_snapshots" | "delete_not_downloaded";
  /** N builds to keep, or X days, depending on `kind`. */
  value: number;
  includeReleases: boolean;
  groupPrefix: string | null;
  enabled: boolean;
  createdAt: Date;
}

/** What a cleanup run would delete: one snapshot build, or a whole version when `buildNumber` is null. */
export interface CleanupPreviewItem {
  repository: string;
  coordinate: string;
  buildNumber: number | null;
  reason: string;
}

const policyColumns = {
  id: cleanupPolicy.id,
  kind: cleanupPolicy.kind,
  value: cleanupPolicy.value,
  includeReleases: cleanupPolicy.includeReleases,
  groupPrefix: cleanupPolicy.groupPrefix,
  enabled: cleanupPolicy.enabled,
  createdAt: cleanupPolicy.createdAt,
};

const policyInput = z.object({
  repository: repositoryName,
  /** Present to update an existing policy of the repository; omitted to create one. */
  id: z.uuid().optional(),
  kind: z.enum(["keep_last_snapshot_builds", "delete_stale_snapshots", "delete_not_downloaded"]),
  value: z.number().int().min(1).max(36_500),
  includeReleases: z.boolean().default(false),
  groupPrefix,
  enabled: z.boolean().default(true),
});

function requireQueue(ctx: TrpcContext) {
  const queue = ctx.cleanupQueue();
  if (!queue) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Background jobs are not configured (VALKEY_URL is unset)" });
  }
  return queue;
}

/** Cleanup policies per repository (admin): edit, preview (dry run) and run now as a background job. */
export const policiesRouter = router({
  list: adminProcedure.input(z.object({ repository: repositoryName })).query(async ({ ctx, input }): Promise<CleanupPolicy[]> => {
    const repo = await requireRepository(ctx.db, input.repository);
    return ctx.db
      .select(policyColumns)
      .from(cleanupPolicy)
      .where(eq(cleanupPolicy.repositoryId, repo.id))
      .orderBy(asc(cleanupPolicy.createdAt), asc(cleanupPolicy.id));
  }),

  /** Creates a policy, or updates the one with `id`; `NOT_FOUND` when `id` is not a policy of the repository. */
  upsert: adminProcedure.input(policyInput).mutation(async ({ ctx, input }): Promise<CleanupPolicy> => {
    const { repository: repoName, id, ...fields } = input;
    return audited(
      ctx.db,
      (policy: CleanupPolicy) => ({
        actor: ctx.principal,
        action: id ? "policy.update" : "policy.create",
        target: `${repoName}/${policy.id}`,
        details: fields,
      }),
      async (tx) => {
        const repo = await requireRepository(tx, repoName);
        if (!id) {
          return (await tx.insert(cleanupPolicy).values({ ...fields, repositoryId: repo.id }).returning(policyColumns))[0]!;
        }
        const [updated] = await tx
          .update(cleanupPolicy)
          .set(fields)
          .where(and(eq(cleanupPolicy.id, id), eq(cleanupPolicy.repositoryId, repo.id)))
          .returning(policyColumns);
        if (!updated) throw notFound(`Cleanup policy ${id} was not found in ${repoName}`);
        return updated;
      },
    );
  }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await audited(ctx.db, { actor: ctx.principal, action: "policy.delete", target: input.id }, async (tx) => {
      const removed = await tx.delete(cleanupPolicy).where(eq(cleanupPolicy.id, input.id)).returning({ id: cleanupPolicy.id });
      if (removed.length === 0) throw notFound(`Cleanup policy ${input.id} was not found`);
    });
    return { id: input.id };
  }),

  /** What the repository's enabled policies would delete right now (dry run; deletes nothing). */
  preview: adminProcedure
    .input(z.object({ repository: repositoryName }))
    .query(async ({ ctx, input }): Promise<CleanupPreviewItem[]> => {
      const candidates = await planCleanup(ctx.db, input.repository, new Date());
      return candidates.map((c) => ({ ...c, coordinate: coordinateText(c.coordinate) }));
    }),

  /**
   * Enqueues a `cleanup:repo` job for the repository and returns its id; poll `policies.job`.
   * `SERVICE_UNAVAILABLE` within a few seconds when Valkey is down.
   */
  runNow: adminProcedure.input(z.object({ repository: repositoryName })).mutation(async ({ ctx, input }) => {
    await requireRepository(ctx.db, input.repository);
    const jobId = await enqueueCleanup(requireQueue(ctx), input.repository);
    return { jobId };
  }),

  /** State of a cleanup job, with its result once completed or the failure reason once failed. */
  job: adminProcedure
    .input(z.object({ jobId: z.string().min(1).max(200) }))
    .query(({ ctx, input }): Promise<CleanupJobStatus> => getJobState(requireQueue(ctx), input.jobId)),
});
