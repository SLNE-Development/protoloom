import type { UpstreamView } from "../repos/service.js";

/** An upstream of a mirror with its decrypted secret, as the engine contacts it. */
export type UpstreamWithSecret = UpstreamView & { secret: string | null };

/** How long an upstream may take to send response headers before the request is abandoned. */
export const UPSTREAM_TIMEOUT_MS = 30_000;

/** Response headers that describe a connection or a hop rather than the content, never forwarded to clients. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Thrown when an upstream could not be reached or sent no response headers in time. */
export class UpstreamFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamFetchError";
  }
}

/** The URL of `path` below the upstream base URL `base`; exactly one slash joins them. */
export function upstreamUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** The Authorization header value the upstream's stored credentials yield, or null for none. */
export function upstreamAuthorization(upstream: UpstreamWithSecret): string | null {
  switch (upstream.authType) {
    case "none":
      return null;
    case "basic":
      return `Basic ${Buffer.from(`${upstream.username ?? ""}:${upstream.secret ?? ""}`).toString("base64")}`;
    case "bearer":
      return upstream.secret === null ? null : `Bearer ${upstream.secret}`;
  }
}

/**
 * Whether the response body was decoded by `fetch` (it was sent with a content encoding), so the
 * upstream's `content-length` and `content-encoding` no longer describe the bytes the client gets.
 */
export function isDecoded(headers: Headers): boolean {
  const encoding = headers.get("content-encoding");
  return encoding !== null && encoding.trim() !== "" && encoding.trim().toLowerCase() !== "identity";
}

/** The upstream response headers worth forwarding to a client: no hop-by-hop headers, no stale encoding or length. */
export function forwardableHeaders(upstream: Headers): Headers {
  const decoded = isDecoded(upstream);
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (HOP_HEADERS.has(name)) return;
    if (decoded && (name === "content-encoding" || name === "content-length")) return;
    out.append(name, value);
  });
  return out;
}

/**
 * Sends one request to an upstream. Rejects with {@link UpstreamFetchError} on network errors and
 * when no response headers arrive within `timeoutMs`; the body itself may take longer.
 */
export async function requestUpstream(
  fetchImpl: typeof fetch,
  url: string,
  opts: { method: "GET" | "HEAD"; headers: Record<string, string>; authorization: string | null; timeoutMs: number },
): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.delete("authorization");
  headers.delete("host");
  if (opts.authorization !== null) headers.set("authorization", opts.authorization);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new UpstreamFetchError(`${url} sent no response within ${opts.timeoutMs} ms`)), opts.timeoutMs);
  try {
    return await fetchImpl(url, { method: opts.method, headers, signal: controller.signal, redirect: "follow" });
  } catch (error) {
    if (error instanceof UpstreamFetchError) throw error;
    if (controller.signal.aborted && controller.signal.reason instanceof UpstreamFetchError) throw controller.signal.reason;
    throw new UpstreamFetchError(`Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Releases a response body that is not going to be read. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is gone already; nothing to release.
  }
}
