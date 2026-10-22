import { eq } from "drizzle-orm";
import { RegistryError, type KeyPermission, type Principal, type Role } from "@weaver/core";
import { repoPermission, repository, user, type Db } from "@weaver/db";
import type { Auth } from "./auth";
import { getServerContext } from "./context";
import { effectiveRole } from "./roles";

function unauthorized(message = "Invalid API key"): RegistryError {
  return new RegistryError("unauthorized", message);
}

/** The owner's current role, or `null` when the user is missing or banned right now. */
export async function loadActiveRole(db: Db, userId: string): Promise<Role | null> {
  const [owner] = await db
    .select({ role: user.role, banned: user.banned, banExpires: user.banExpires })
    .from(user)
    .where(eq(user.id, userId));
  if (!owner) return null;
  const banned = owner.banned === true && (owner.banExpires === null || owner.banExpires.getTime() > Date.now());
  return banned ? null : effectiveRole(owner.role);
}

/** The token of an `Authorization: Bearer <token>` header; `""` for an empty bearer, `null` without one. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer(?:\s+(.*))?$/i);
  return match ? (match[1] ?? "").trim() : null;
}

/**
 * Resolves who is making `req`. A bearer token must be a valid, unexpired, enabled API key whose
 * owner is not banned, or this throws `RegistryError("unauthorized")`; the principal carries the
 * owner's role as stored now (so a demotion takes effect on the next request) and the key's
 * permission entries. Without a bearer, a Better Auth session cookie yields a user principal;
 * with neither, the request is anonymous.
 */
export async function getPrincipal(
  req: Request,
  deps: { db: Db; auth: Auth } = getServerContext(),
): Promise<Principal> {
  const { db, auth } = deps;
  const token = bearerToken(req);

  if (token !== null) {
    if (!token) throw unauthorized();
    const result = await auth.api.verifyApiKey({ body: { key: token } });
    if (!result.valid || !result.key) throw unauthorized();
    const keyId = result.key.id;
    const userId = result.key.referenceId;
    const role = await loadActiveRole(db, userId);
    if (!role) throw unauthorized();
    const rows = await db
      .select({
        repository: repository.name,
        groupPrefix: repoPermission.groupPrefix,
        access: repoPermission.access,
      })
      .from(repoPermission)
      .innerJoin(repository, eq(repository.id, repoPermission.repositoryId))
      .where(eq(repoPermission.apiKeyId, keyId));
    const permissions: KeyPermission[] = rows;
    return { kind: "apikey", keyId, userId, role, permissions };
  }

  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return { kind: "anonymous" };
  const role = await loadActiveRole(db, session.user.id);
  if (!role) throw unauthorized("Account is banned");
  return { kind: "user", userId: session.user.id, role };
}
