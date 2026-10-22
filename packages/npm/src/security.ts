import type { FormatDeps, Repo } from "@weaver/core";
import { npmError, npmJson } from "./http.js";
import { readBody } from "./hosted.js";
import { forwardUpstream } from "./upstream.js";

/** The `audits` / `audits/quick` answer for a dependency tree without advisories. */
export const NO_ADVISORIES_QUICK: unknown = {
  actions: [],
  advisories: {},
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    dependencies: 0,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 0,
  },
};

/** The security endpoints below `-/npm/v1/security/` that Weaver answers. */
const SECURITY_PATHS = new Set(["advisories/bulk", "audits", "audits/quick"]);

/** Largest audit request body read into memory to forward it (and retry it on the next upstream): 64 MiB. */
export const MAX_AUDIT_BYTES = 64 * 1024 * 1024;

/** Client request headers sent upstream with an audit: the body's type and encoding, and npm's client identification. */
const AUDIT_HEADERS = ["content-type", "content-encoding", "user-agent", "npm-command", "npm-session", "npm-scope", "npm-in-ci"] as const;

/** The answer of a repository that knows no advisories: `{}` for the bulk endpoint, {@link NO_ADVISORIES_QUICK} for audits. */
async function noAdvisories(req: Request, path: string): Promise<Response> {
  await req.body?.cancel().catch(() => undefined);
  return npmJson(path === "advisories/bulk" ? {} : NO_ADVISORIES_QUICK);
}

/**
 * Forwards an audit request to a mirror's upstreams with the raw body and its `content-type`/`content-encoding`
 * (never the client's credentials), passing the answer through; the hosted answer when the mirror is offline or
 * every upstream answered 404. An unreachable upstream fails with `upstream_unavailable` (502), so a broken
 * upstream never reads as "no advisories".
 */
async function forwardAudit(deps: FormatDeps, mirror: Repo, req: Request, path: string): Promise<Response> {
  const body = await readBody(req, MAX_AUDIT_BYTES);
  const headers = new Headers({ accept: "application/json" });
  for (const name of AUDIT_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const res = await forwardUpstream(deps, mirror, `-/npm/v1/security/${path}`, { method: "POST", headers, body });
  if (res === null) return noAdvisories(req, path);
  const out = new Headers(res.headers);
  if (!out.has("content-type")) out.set("content-type", "application/json");
  return new Response(res.body, { status: res.status, headers: out });
}

/**
 * `POST -/npm/v1/security/{advisories/bulk,audits,audits/quick}`: hosted repositories know no advisories (`{}` for
 * bulk, {@link NO_ADVISORIES_QUICK} for audits); mirrors forward the request upstream; groups forward it to their
 * first mirror member, or give the hosted answer without one. Other paths answer 404, other methods 405. The caller
 * has checked read access.
 */
export async function handleSecurity(deps: FormatDeps, repo: Repo, req: Request, path: string): Promise<Response> {
  if (!SECURITY_PATHS.has(path)) return npmError(404, "not found");
  if (req.method.toUpperCase() !== "POST") return npmError(405, "method not allowed", { allow: "POST" });
  if (repo.kind === "mirror") return forwardAudit(deps, repo, req, path);
  if (repo.kind === "group") {
    const mirror = (await deps.repos.members(repo.id)).find((m) => m.kind === "mirror");
    if (mirror) return forwardAudit(deps, mirror, req, path);
  }
  return noAdvisories(req, path);
}
