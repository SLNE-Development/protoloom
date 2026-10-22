import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { maxKeyAccess, recordAudit, type KeyPermission } from "@weaver/core";
import { apikey, apiKeyPermission, repository, user } from "@weaver/db";
import { authedProcedure, router } from "../init";
import { groupPrefix, notFound, repositoryName } from "../helpers";

/** Prefix of every API key secret Weaver issues, so leaked keys are recognisable. */
export const API_KEY_PREFIX = "pl_";

/** An API key as listed: never the secret, only its first characters (`start`). */
export interface ApiKeySummary {
  id: string;
  name: string | null;
  /** The first characters of the secret, for recognising a key. */
  start: string | null;
  userId: string;
  ownerName: string | null;
  enabled: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  permissions: KeyPermission[];
}

const permissionInput = z.object({
  repository: repositoryName,
  groupPrefix,
  access: z.enum(["read", "write"]),
});

/** Personal API keys: create (the secret is shown once), list, revoke. */
export const keysRouter = router({
  /** The caller's keys, newest first; admins may pass `all: true` for every user's keys. */
  list: authedProcedure
    .input(z.object({ all: z.boolean().default(false) }).optional())
    .query(async ({ ctx, input }): Promise<ApiKeySummary[]> => {
      const all = input?.all ?? false;
      if (all && ctx.principal.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
      const keys = await ctx.db
        .select({
          id: apikey.id,
          name: apikey.name,
          start: apikey.start,
          userId: apikey.referenceId,
          ownerName: user.name,
          enabled: apikey.enabled,
          expiresAt: apikey.expiresAt,
          lastUsedAt: apikey.lastRequest,
          createdAt: apikey.createdAt,
        })
        .from(apikey)
        .leftJoin(user, eq(user.id, apikey.referenceId))
        .where(all ? undefined : eq(apikey.referenceId, ctx.principal.userId))
        .orderBy(desc(apikey.createdAt));
      const permissions =
        keys.length === 0
          ? []
          : await ctx.db
              .select({
                apiKeyId: apiKeyPermission.apiKeyId,
                repository: apiKeyPermission.repository,
                groupPrefix: apiKeyPermission.groupPrefix,
                access: apiKeyPermission.access,
              })
              .from(apiKeyPermission)
              .where(
                inArray(
                  apiKeyPermission.apiKeyId,
                  keys.map((k) => k.id),
                ),
              );
      return keys.map((key) => ({
        ...key,
        enabled: key.enabled ?? true,
        permissions: permissions
          .filter((p) => p.apiKeyId === key.id)
          .map(({ repository: repo, groupPrefix: prefix, access }) => ({ repository: repo, groupPrefix: prefix, access })),
      }));
    }),

  /**
   * Creates a key for the caller and returns `{ id, key }`; the only time the secret is returned.
   * Viewers may only grant `read` (`FORBIDDEN` otherwise); unknown repositories are `BAD_REQUEST`.
   */
  create: authedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(32),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        permissions: z.array(permissionInput).min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { principal } = ctx;
      if (maxKeyAccess(principal.role) === "read" && input.permissions.some((p) => p.access === "write")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Viewers can only create read-only keys" });
      }
      const names = [...new Set(input.permissions.map((p) => p.repository))];
      const known = new Set(
        (await ctx.db.select({ name: repository.name }).from(repository).where(inArray(repository.name, names))).map((r) => r.name),
      );
      const unknown = names.filter((name) => !known.has(name));
      if (unknown.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown repositories: ${unknown.join(", ")}` });
      }

      const created = await ctx.auth.api.createApiKey({
        body: {
          userId: principal.userId,
          name: input.name,
          prefix: API_KEY_PREFIX,
          expiresIn: input.expiresInDays ? input.expiresInDays * 86_400 : null,
        },
      });
      try {
        await ctx.db.transaction(async (tx) => {
          await tx.insert(apiKeyPermission).values(input.permissions.map((p) => ({ ...p, apiKeyId: created.id })));
          await recordAudit(tx, {
            actor: principal,
            action: "key.create",
            target: created.id,
            details: { name: input.name, expiresInDays: input.expiresInDays ?? null, permissions: input.permissions },
          });
        });
      } catch (error) {
        // A key without its permission rows must not survive.
        await ctx.db.delete(apikey).where(eq(apikey.id, created.id));
        throw error;
      }
      return { id: created.id, key: created.key };
    }),

  /** Revokes (deletes) one of the caller's keys, or any key for admins; `NOT_FOUND` otherwise. */
  revoke: authedProcedure.input(z.object({ id: z.string().min(1).max(200) })).mutation(async ({ ctx, input }) => {
    const { principal } = ctx;
    const owned = principal.role === "admin" ? undefined : eq(apikey.referenceId, principal.userId);
    await ctx.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(apikey)
        .where(and(eq(apikey.id, input.id), owned))
        .returning({ id: apikey.id, name: apikey.name, userId: apikey.referenceId });
      if (!removed) throw notFound(`API key ${input.id} was not found`);
      await recordAudit(tx, {
        actor: principal,
        action: "key.revoke",
        target: removed.id,
        details: { name: removed.name, userId: removed.userId },
      });
    });
    return { id: input.id };
  }),
});
