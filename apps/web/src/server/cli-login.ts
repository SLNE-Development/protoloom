import { TRPCError } from "@trpc/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { encryptSecret, maxKeyAccess, type Format, type Kind, type Principal, type Role } from "@weaver/core";
import { apikey, npmLoginSession, repository, type Db } from "@weaver/db";
import type { KeyFormValues } from "@/lib/api-keys";
import { issueApiKey, type IssueKeyInput } from "./api-keys";
import type { Auth } from "./auth";

/**
 * What the browser login page shows for a session id: a pending session with the repository the CLI
 * targeted, when it was started and when it expires, or `gone` (missing, expired or already answered).
 */
export type CliLoginView =
  | { state: "pending"; repository: { name: string; format: Format; kind: Kind }; createdAt: Date; expiresAt: Date }
  | { state: "gone" };

const GONE = "This login link has expired. Run npm login again.";

/** Loads the login session `id` for the browser page; see {@link CliLoginView}. */
export async function loadCliLogin(db: Db, id: string): Promise<CliLoginView> {
  const [row] = await db
    .select({
      status: npmLoginSession.status,
      createdAt: npmLoginSession.createdAt,
      expiresAt: npmLoginSession.expiresAt,
      name: repository.name,
      format: repository.format,
      kind: repository.kind,
    })
    .from(npmLoginSession)
    .innerJoin(repository, eq(repository.id, npmLoginSession.repositoryId))
    .where(eq(npmLoginSession.id, id))
    .limit(1);
  if (!row || row.status !== "pending" || row.expiresAt.getTime() <= Date.now()) return { state: "gone" };
  return {
    state: "pending",
    repository: { name: row.name, format: row.format, kind: row.kind },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Approves the login session `id`: issues an API key for `principal` with `input` (validated exactly
 * like the keys dialog) and stores it encrypted with `secretKey` for the CLI to collect once. The
 * session is re-checked as pending and unexpired in the same statement that approves it; when that
 * matches no row (expired, denied, approved meanwhile) the new key is deleted again and the call
 * fails with `NOT_FOUND`.
 */
export async function approveCliLogin(
  deps: { db: Db; auth: Auth; secretKey: Buffer },
  principal: Extract<Principal, { kind: "user" }>,
  id: string,
  input: IssueKeyInput,
): Promise<void> {
  const { db, secretKey } = deps;
  // Fail fast without creating a key that would be deleted right away.
  if ((await loadCliLogin(db, id)).state !== "pending") throw new TRPCError({ code: "NOT_FOUND", message: GONE });
  const created = await issueApiKey(deps, principal, input);
  let approved = false;
  try {
    approved = await db.transaction(async (tx) => {
      const rows = await tx
        .update(npmLoginSession)
        .set({ status: "approved", userId: principal.userId, tokenCiphertext: encryptSecret(secretKey, created.key) })
        .where(and(eq(npmLoginSession.id, id), eq(npmLoginSession.status, "pending"), gt(npmLoginSession.expiresAt, sql`now()`)))
        .returning({ id: npmLoginSession.id });
      return rows.length === 1;
    });
  } finally {
    if (!approved) await db.delete(apikey).where(eq(apikey.id, created.id));
  }
  if (!approved) throw new TRPCError({ code: "NOT_FOUND", message: GONE });
}

/** Denies the login session `id` if it is still pending and unexpired; the CLI's next poll gets 403. */
export async function denyCliLogin(db: Db, id: string): Promise<void> {
  await db
    .update(npmLoginSession)
    .set({ status: "denied" })
    .where(and(eq(npmLoginSession.id, id), eq(npmLoginSession.status, "pending"), gt(npmLoginSession.expiresAt, sql`now()`)));
}

/** `yyyy-mm-dd` of `date` in UTC. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Pre-filled form: name "npm login <yyyy-mm-dd>", expiry "90", one row for the target repo with write
 * when the role allows (and the repository is not a group, which is read-only), read otherwise.
 */
export function defaultCliLoginForm(repo: string, role: Role, today: Date, kind: Kind = "hosted"): KeyFormValues {
  const access = maxKeyAccess(role) === "write" && kind !== "group" ? "write" : "read";
  return { name: `npm login ${isoDay(today)}`, expiry: "90", permissions: [{ repository: repo, groupPrefix: "", access }] };
}
