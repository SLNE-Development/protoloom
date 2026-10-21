import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { BetterAuthOptions, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import type { Role } from "@protoloom/core";
import { invite, user, type Db } from "@protoloom/db";
import { hashInviteToken, readInviteToken } from "./invite";

/** Shown when someone without an invite tries to create an account. */
export const INVITE_REQUIRED_MESSAGE = "You need an invite to join this Protoloom.";

const ROLES: readonly Role[] = ["admin", "maintainer", "viewer"];

type Decision = { kind: "initial-admin" } | { kind: "invite"; inviteId: string };

type ValidateUserInfo = NonNullable<NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]>;
type UserCreateHooks = NonNullable<NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["user"]>["create"]>;

/** `INITIAL_ADMIN` split into provider and account key; `null` when unset or malformed. */
export function parseInitialAdmin(value: string | undefined): { provider: "github" | "discord"; key: string } | null {
  const match = value?.match(/^(github|discord):(.+)$/);
  if (!match) return null;
  return { provider: match[1] as "github" | "discord", key: match[2]! };
}

function refusal() {
  return { error: "invite_required", errorDescription: INVITE_REQUIRED_MESSAGE };
}

function refusalError() {
  return new APIError("FORBIDDEN", { code: "invite_required", message: INVITE_REQUIRED_MESSAGE });
}

/**
 * The single gate every user creation passes. Better Auth calls `validateUserInfo` with the
 * `create-user` action and the raw provider profile right before it inserts a user; the gate
 * allows the insert only for
 * - the first-admin rule: no admin exists yet and the provider account equals `INITIAL_ADMIN`
 *   (GitHub login compared case-insensitively, Discord numeric user id), or
 * - a valid, unexpired, unused invite whose token arrived in this request's signed invite cookie.
 *
 * Its decision is remembered for the request's endpoint context. The `user.create.before` hook
 * then claims the invite atomically (so one link creates at most one user) and sets the role; the
 * `after` hook records which user used the invite. Any creation the gate did not approve, such as
 * the admin plugin's create-user endpoint, is refused. Sign-in and linking of existing users are
 * not gated here.
 */
export function createUserGate(opts: { db: Db; secret: string; initialAdmin: string | undefined }) {
  const { db, secret } = opts;
  const initialAdmin = parseInitialAdmin(opts.initialAdmin);
  const decisions = new WeakMap<object, Decision>();

  async function adminExists(): Promise<boolean> {
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(sql`'admin' = any(string_to_array(${user.role}, ','))`)
      .limit(1);
    return rows.length > 0;
  }

  function matchesInitialAdmin(providerId: string, profile: Record<string, unknown> | undefined): boolean {
    if (!initialAdmin || !profile || providerId !== initialAdmin.provider) return false;
    if (initialAdmin.provider === "github") {
      return typeof profile.login === "string" && profile.login.toLowerCase() === initialAdmin.key.toLowerCase();
    }
    return String(profile.id ?? "") === initialAdmin.key;
  }

  async function findUsableInvite(ctx: GenericEndpointContext) {
    const cookieHeader = ctx.headers?.get("cookie") ?? ctx.request?.headers.get("cookie");
    const token = readInviteToken(cookieHeader, secret);
    if (!token) return null;
    const [row] = await db
      .select({ id: invite.id })
      .from(invite)
      .where(and(eq(invite.tokenHash, hashInviteToken(token)), isNull(invite.usedAt), gt(invite.expiresAt, new Date())))
      .limit(1);
    return row ?? null;
  }

  const validateUserInfo: ValidateUserInfo = async ({ source }, ctx) => {
    if (source.action !== "create-user") return;
    if (source.method !== "oauth" || !source.oauth || !ctx) return refusal();

    let decision: Decision | null = null;
    if (matchesInitialAdmin(source.oauth.providerId, source.oauth.profile) && !(await adminExists())) {
      decision = { kind: "initial-admin" };
    } else {
      const usable = await findUsableInvite(ctx);
      if (usable) decision = { kind: "invite", inviteId: usable.id };
    }
    if (!decision) return refusal();
    decisions.set(ctx, decision);
  };

  const create = {
    before: async (_user, ctx) => {
      const decision = ctx ? decisions.get(ctx) : undefined;
      if (!decision) throw refusalError();
      if (decision.kind === "initial-admin") return { data: { role: "admin" } };

      const [claimed] = await db
        .update(invite)
        .set({ usedAt: new Date() })
        .where(and(eq(invite.id, decision.inviteId), isNull(invite.usedAt), gt(invite.expiresAt, new Date())))
        .returning({ role: invite.role });
      if (!claimed || !ROLES.includes(claimed.role as Role)) throw refusalError();
      return { data: { role: claimed.role } };
    },
    after: async (created, ctx) => {
      const decision = ctx ? decisions.get(ctx) : undefined;
      if (ctx) decisions.delete(ctx);
      if (decision?.kind === "invite") {
        await db.update(invite).set({ usedByUserId: created.id }).where(eq(invite.id, decision.inviteId));
      }
    },
  } satisfies UserCreateHooks;

  return { validateUserInfo, databaseHooks: { user: { create } } };
}
