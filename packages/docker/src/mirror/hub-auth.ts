import type { UpstreamView } from "@weaver/core";

/** An upstream of a mirror with its decrypted secret, as the mirror engine hands it to its hooks. */
export type UpstreamWithSecret = UpstreamView & { secret: string | null };

/** A parsed `Bearer` challenge: where to fetch a token and for which service and scope. */
export interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

/** Fetches and caches bearer tokens of token-protected upstream registries (Docker Hub, GHCR, distribution). */
export interface HubAuth {
  /** The cached `Bearer <token>` for the upstream and scope, or null when none is cached or it expired. */
  authorize(upstream: UpstreamWithSecret, scope: string): Promise<string | null>;
  /**
   * Answers a 401 challenge: fetches a token from the challenge's realm (with the upstream's basic credentials,
   * when it has some), caches it and resolves to `Bearer <token>`; null for a non-Bearer challenge or a failed fetch.
   */
  onChallenge(challenge: string, upstream: UpstreamWithSecret): Promise<string | null>;
}

/** How long before its `expires_in` a token stops being reused. */
const EXPIRY_MARGIN_MS = 30_000;
/** The token lifetime the token spec assumes when the realm sends no `expires_in`. */
const DEFAULT_EXPIRES_IN_S = 60;
/** How long a token request may take. */
const TOKEN_TIMEOUT_MS = 30_000;
/** The most cached tokens kept; beyond it expired, then oldest, entries are dropped. */
const MAX_CACHED = 1000;

/** Parses `Bearer realm="…",service="…",scope="…"`; null for other schemes or without a realm. */
export function parseChallenge(header: string): BearerChallenge | null {
  const m = /^\s*bearer\s+(.*)$/is.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  const param = /([a-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))\s*(?:,|$)/gi;
  for (const p of m[1]!.matchAll(param)) {
    params[p[1]!.toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : p[3]!;
  }
  if (!params.realm) return null;
  const out: BearerChallenge = { realm: params.realm };
  if (params.service !== undefined) out.service = params.service;
  if (params.scope !== undefined) out.scope = params.scope;
  return out;
}

/** The Authorization header for a token request: the upstream's basic credentials, or none. */
function realmAuthorization(upstream: UpstreamWithSecret): string | null {
  if (upstream.authType !== "basic" || !upstream.username || upstream.secret === null) return null;
  return `Basic ${Buffer.from(`${upstream.username}:${upstream.secret}`).toString("base64")}`;
}

/**
 * Creates a {@link HubAuth} whose tokens are cached per (upstream id, scope) for `expires_in` (default 60 s)
 * minus 30 s. Concurrent challenges for the same key share one token request.
 */
export function createHubAuth(fetchImpl: typeof fetch, now: () => Date): HubAuth {
  const cache = new Map<string, { authorization: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string | null>>();
  const keyOf = (upstream: UpstreamWithSecret, scope: string) => `${upstream.id}\n${scope}`;

  function remember(key: string, authorization: string, lifetimeMs: number): void {
    if (lifetimeMs <= 0) return;
    const t = now().getTime();
    cache.delete(key);
    if (cache.size >= MAX_CACHED) {
      for (const [k, v] of cache) if (v.expiresAt <= t) cache.delete(k);
      while (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { authorization, expiresAt: t + lifetimeMs });
  }

  async function fetchToken(challenge: BearerChallenge, upstream: UpstreamWithSecret): Promise<{ token: string; expiresIn: number } | null> {
    let url: URL;
    try {
      url = new URL(challenge.realm);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (challenge.service !== undefined) url.searchParams.set("service", challenge.service);
    if (challenge.scope !== undefined) url.searchParams.set("scope", challenge.scope);
    const headers: Record<string, string> = { accept: "application/json" };
    const authorization = realmAuthorization(upstream);
    if (authorization) headers.authorization = authorization;
    try {
      const res = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        console.warn(`weaver:docker token request to ${url.origin}${url.pathname} answered ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { token?: unknown; access_token?: unknown; expires_in?: unknown };
      const token = typeof body.token === "string" && body.token ? body.token : body.access_token;
      if (typeof token !== "string" || !token) return null;
      const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_IN_S;
      return { token, expiresIn };
    } catch (error) {
      console.warn(`weaver:docker token request to ${url.origin}${url.pathname} failed`, error);
      return null;
    }
  }

  return {
    authorize(upstream, scope) {
      const entry = cache.get(keyOf(upstream, scope));
      if (!entry) return Promise.resolve(null);
      if (entry.expiresAt <= now().getTime()) {
        cache.delete(keyOf(upstream, scope));
        return Promise.resolve(null);
      }
      return Promise.resolve(entry.authorization);
    },

    onChallenge(header, upstream) {
      const challenge = parseChallenge(header);
      if (!challenge) return Promise.resolve(null);
      const key = keyOf(upstream, challenge.scope ?? "");
      const running = inflight.get(key);
      if (running) return running;
      const request = fetchToken(challenge, upstream)
        .then((result) => {
          if (!result) return null;
          const authorization = `Bearer ${result.token}`;
          remember(key, authorization, result.expiresIn * 1000 - EXPIRY_MARGIN_MS);
          return authorization;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },
  };
}
