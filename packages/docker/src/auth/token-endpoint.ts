import { randomUUID } from "node:crypto";
import { RegistryError, type FormatDeps, type Principal } from "@weaver/core";
import { DockerError, errorResponse } from "../errors.js";
import { parseRoute } from "../route.js";
import { resolveTarget, type Target } from "../target.js";
import { permits, serviceHost } from "./authorize.js";
import { parseScopes, signToken, tokenKey, type AccessEntry, type DockerClaims } from "./jwt.js";

const TOKEN_TTL_SECONDS = 300;

/** The target of a scope name, or null when the name is malformed, names only a repository, or is unknown. */
async function scopeTarget(deps: FormatDeps, name: string): Promise<Target | null> {
  try {
    if (parseRoute(`${name}/tags/list`)?.kind !== "tags") return null;
    return await resolveTarget(deps.repos, name);
  } catch (err) {
    if (err instanceof DockerError) return null;
    throw err;
  }
}

/**
 * Grants the requested access per entry: pull needs read (of the group, for a group), push and delete
 * need write and are never granted on mirror or group targets. Entries with nothing granted are dropped.
 */
export async function grantAccess(deps: FormatDeps, p: Principal, requested: AccessEntry[]): Promise<AccessEntry[]> {
  const granted: AccessEntry[] = [];
  for (const entry of requested) {
    const target = await scopeTarget(deps, entry.name);
    if (!target) continue;
    const actions = entry.actions.filter((a) => permits(p, target.repo, a));
    if (actions.length > 0) granted.push({ type: "repository", name: entry.name, actions });
  }
  return granted;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "docker-distribution-api-version": "registry/2.0" },
  });
}

/** Resolves the principal of a token request; bad credentials become `401 UNAUTHORIZED`. */
async function authenticate(deps: FormatDeps, req: Request): Promise<Principal> {
  try {
    return await deps.principal(req);
  } catch (err) {
    if (err instanceof RegistryError && err.code === "unauthorized") {
      throw new DockerError(401, "UNAUTHORIZED", "incorrect username or password");
    }
    throw err;
  }
}

/** Reads the principal and requested scopes of a GET query or a POST `grant_type=password` form, or the response to send instead. */
async function readRequest(deps: FormatDeps, req: Request): Promise<{ principal: Principal; scopes: string[] } | Response> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { principal: await authenticate(deps, req), scopes: new URL(req.url).searchParams.getAll("scope") };
  }
  if (req.method !== "POST") throw new DockerError(405, "UNSUPPORTED", "the token endpoint takes GET or POST");
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(400, { error: "invalid_request" });
  const form = new URLSearchParams(await req.text());
  if (form.get("grant_type") !== "password") return json(400, { error: "unsupported_grant_type" });
  const credentials = Buffer.from(`${form.get("username") ?? ""}:${form.get("password") ?? ""}`).toString("base64");
  const authReq = new Request(req.url, { headers: { authorization: `Basic ${credentials}` } });
  return { principal: await authenticate(deps, authReq), scopes: form.getAll("scope") };
}

/**
 * Serves `/v2/token`: `GET ?service=&scope=` authenticated through `deps.principal` (anonymous without
 * credentials), or `POST` form `grant_type=password` (containerd). Answers `{token, access_token,
 * expires_in: 300, issued_at}` with a JWT holding only the granted access; bad credentials → `401 UNAUTHORIZED`.
 */
export async function handleToken(deps: FormatDeps, req: Request, now: Date = new Date()): Promise<Response> {
  try {
    const read = await readRequest(deps, req);
    if (read instanceof Response) return read;
    const { principal: p } = read;
    const iat = Math.floor(now.getTime() / 1000);
    const claims: DockerClaims = {
      iss: "weaver",
      aud: serviceHost(deps.publicUrl),
      sub: p.kind === "anonymous" ? "anonymous" : p.userId,
      iat,
      nbf: iat,
      exp: iat + TOKEN_TTL_SECONDS,
      jti: randomUUID(),
      access: await grantAccess(deps, p, parseScopes(read.scopes)),
      wv:
        p.kind === "anonymous"
          ? { kind: "anonymous" }
          : p.kind === "user"
            ? { kind: "user", userId: p.userId, role: p.role }
            : { kind: "apikey", userId: p.userId, keyId: p.keyId, role: p.role },
    };
    const token = signToken(tokenKey(deps.secretKey), claims);
    return json(200, {
      token,
      access_token: token,
      expires_in: TOKEN_TTL_SECONDS,
      issued_at: new Date(iat * 1000).toISOString(),
    });
  } catch (err) {
    if (err instanceof DockerError) return errorResponse(err);
    throw err;
  }
}
