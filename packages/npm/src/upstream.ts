import {
  discardBody,
  RegistryError,
  UPSTREAM_TIMEOUT_MS,
  upstreamAuthorization,
  upstreamUrl,
  type FormatDeps,
  type MirrorConfig,
  type Repo,
} from "@weaver/core";

/** Client request headers never sent upstream: credentials, cookies and transport settings (`fetch` negotiates its own encoding). */
const STRIPPED_REQUEST_HEADERS = ["accept-encoding", "authorization", "connection", "content-length", "cookie", "host", "proxy-authorization", "transfer-encoding"];

/** Upstream response headers dropped: they describe the encoded transfer `fetch` already decoded, the connection, or upstream cookies. */
const STRIPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"];

/**
 * Forwards one request to the mirror's upstreams in order (first non-404 wins), 30 s header timeout, upstream auth applied.
 * Returns null when offline or every upstream answered 404. Strips content-encoding, content-length, transfer-encoding, connection.
 *
 * Network errors, timeouts, 5xx, 429, 401 and 403 count as failures and try the next upstream; when no upstream
 * answered usefully and at least one failed, this throws `RegistryError("upstream_unavailable")`, so an upstream
 * credential problem never reaches the client as an authentication challenge. The client's own credentials and
 * cookies are never forwarded. `search` is the query string, with or without the leading `?`.
 */
export async function forwardUpstream(
  deps: FormatDeps,
  repo: Repo,
  path: string,
  init: { method: string; headers: Headers; body?: Uint8Array | null; search?: string },
): Promise<Response | null> {
  if (repo.kind !== "mirror") throw new RegistryError("invalid_request", `Repository ${repo.name} is not a mirror`);
  if ((repo.config as MirrorConfig).offline) return null;
  const method = init.method.toUpperCase();
  const query = init.search ? (init.search.startsWith("?") ? init.search : `?${init.search}`) : "";
  const failures: string[] = [];
  for (const upstream of await deps.repos.upstreamsWithSecrets(repo.id)) {
    const url = `${upstreamUrl(upstream.url, path)}${query === "?" ? "" : query}`;
    const headers = new Headers(init.headers);
    for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
    const authorization = upstreamAuthorization(upstream);
    if (authorization !== null) headers.set("authorization", authorization);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no response within ${UPSTREAM_TIMEOUT_MS} ms`)), UPSTREAM_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : (init.body ?? undefined),
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 404) {
      await discardBody(response);
      continue;
    }
    if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
      await discardBody(response);
      failures.push(`${url} answered ${response.status}`);
      continue;
    }
    const out = new Headers(response.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) out.delete(name);
    return new Response(method === "HEAD" ? null : response.body, { status: response.status, headers: out });
  }
  if (failures.length === 0) return null;
  console.warn(`weaver: npm upstream request ${method} ${path} of ${repo.name} failed`, failures);
  throw new RegistryError("upstream_unavailable", `no upstream of ${repo.name} could answer`);
}
