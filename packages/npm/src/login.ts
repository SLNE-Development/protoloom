import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, RegistryError, type FormatDeps, type Repo } from "@weaver/core";
import { npmLoginSession, user } from "@weaver/db";
import { and, eq, lt } from "drizzle-orm";
import { BASIC_CHALLENGE, npmError, npmJson } from "./http.js";

/** How long a browser login session stays valid after `POST /-/v1/login`: 10 minutes. */
export const LOGIN_SESSION_TTL_MS = 600_000;

const NOT_FOUND = "login session not found or expired";
const LEGACY_REJECTED = "use a Weaver access token as the password";

/** The 401 answer of a legacy login whose password is not a Weaver API key. */
function rejectLegacy(): Response {
  return npmError(401, LEGACY_REJECTED, { "www-authenticate": BASIC_CHALLENGE });
}

/** The hex SHA-256 of a poll secret, the only form in which it is stored. */
export function hashPollSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** A fresh random 32-byte value, base64url-encoded. */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Answers `GET /-/whoami` with the `user.name` of the token or session owner; anonymous callers get 401. */
export async function handleWhoami(deps: FormatDeps, req: Request): Promise<Response> {
  const principal = await deps.principal(req);
  if (principal.kind === "anonymous") throw new RegistryError("unauthorized", "authentication required");
  const [row] = await deps.db.select({ name: user.name }).from(user).where(eq(user.id, principal.userId)).limit(1);
  if (!row) throw new RegistryError("unauthorized", "authentication required");
  return npmJson({ username: row.name });
}

/**
 * Answers `POST /-/v1/login` (npm web login): deletes expired sessions, stores a new pending session for `repo` with
 * the poll secret only as its hash, and returns the browser `loginUrl` and the CLI's polling `doneUrl`.
 */
export async function startWebLogin(deps: FormatDeps, repo: Repo): Promise<Response> {
  const now = new Date();
  await deps.db.delete(npmLoginSession).where(lt(npmLoginSession.expiresAt, now));
  const id = randomToken();
  const secret = randomToken();
  await deps.db.insert(npmLoginSession).values({
    id,
    pollHash: hashPollSecret(secret),
    repositoryId: repo.id,
    expiresAt: new Date(now.getTime() + LOGIN_SESSION_TTL_MS),
  });
  return npmJson({
    loginUrl: `${deps.publicUrl}/cli-login/${id}`,
    doneUrl: `${deps.publicUrl}/npm/${encodeURIComponent(repo.name)}/-/v1/login/done/${secret}`,
  });
}

/**
 * Answers the CLI polling `GET /-/v1/login/done/<secret>`: pending → 202 with `retry-after: 2`; approved → the token,
 * handed out exactly once (the row is deleted in the same statement that reads it); denied → 403 and the row is
 * deleted; missing, expired or for another repository → 404.
 */
export async function pollWebLogin(deps: FormatDeps, repo: Repo, secret: string): Promise<Response> {
  const pollHash = hashPollSecret(secret);
  const [row] = await deps.db.select().from(npmLoginSession).where(eq(npmLoginSession.pollHash, pollHash)).limit(1);
  if (!row || row.repositoryId !== repo.id) return npmError(404, NOT_FOUND);
  if (row.expiresAt.getTime() <= Date.now()) {
    await deps.db.delete(npmLoginSession).where(eq(npmLoginSession.id, row.id));
    return npmError(404, NOT_FOUND);
  }
  if (row.status === "pending") return npmJson({}, { status: 202, headers: { "retry-after": "2" } });
  if (row.status === "denied") {
    await deps.db.delete(npmLoginSession).where(eq(npmLoginSession.id, row.id));
    return npmError(403, "login was denied");
  }
  const [taken] = await deps.db
    .delete(npmLoginSession)
    .where(and(eq(npmLoginSession.id, row.id), eq(npmLoginSession.status, "approved")))
    .returning({ tokenCiphertext: npmLoginSession.tokenCiphertext });
  if (!taken?.tokenCiphertext) return npmError(404, NOT_FOUND);
  return npmJson({ token: decryptSecret(deps.secretKey, taken.tokenCiphertext) });
}

/** Reads the request body as a JSON object, or an empty object when it is missing or not a JSON object. */
async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Answers the legacy couchdb login `PUT /-/user/org.couchdb.user:<user>` (yarn berry): the `password` must be a Weaver
 * API key, which is returned as the token; any other password, including a browser session, is 401.
 */
export async function legacyLogin(deps: FormatDeps, req: Request, pathUser: string): Promise<Response> {
  const body = await jsonObject(req);
  const password = typeof body["password"] === "string" ? body["password"] : "";
  const name = typeof body["name"] === "string" && body["name"] !== "" ? body["name"] : pathUser.replace(/^org\.couchdb\.user:/, "");
  if (password === "") return rejectLegacy();
  let kind: string;
  try {
    const principal = await deps.principal(new Request(req.url, { headers: { authorization: `Bearer ${password}` } }));
    kind = principal.kind;
  } catch (error) {
    if (error instanceof RegistryError) return rejectLegacy();
    throw error;
  }
  if (kind !== "apikey") return rejectLegacy();
  return npmJson({ ok: true, id: `org.couchdb.user:${name}`, token: password }, { status: 201 });
}
