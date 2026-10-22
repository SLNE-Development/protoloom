import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Db } from "@weaver/db";
import type { AssetRow, AssetService, ComponentRef } from "../content/assets.js";
import { RegistryError } from "../errors.js";
import type { MirrorConfig } from "../repos/config.js";
import { matchesRules } from "../repos/rules.js";
import type { Repo, RepoService, UpstreamView } from "../repos/service.js";
import type { ServerSettings } from "../settings.js";
import type { StoreId, StoreSet } from "../storage/index.js";
import {
  discardBody,
  forwardableHeaders,
  isDecoded,
  requestUpstream,
  UPSTREAM_TIMEOUT_MS,
  UpstreamFetchError,
  upstreamAuthorization,
  upstreamUrl,
  type UpstreamWithSecret,
} from "./upstream.js";

/** Whether content never changes once published (artifacts, blobs) or is revalidated after the metadata TTL (indexes, tags). */
export type ContentClass = "immutable" | "metadata";

/** How a mirror served a request relative to its cache. */
export type CacheResult = "hit" | "miss" | "bypass" | "stale";

/** One request to a mirror repository. */
export interface MirrorFetch {
  /** kind must be "mirror" */
  repo: Repo;
  /** relative to each upstream base URL */
  path: string;
  /** what rules match against */
  subject: string;
  class: ContentClass;
  method?: "GET" | "HEAD";
  /** forwarded (accept, etc.) */
  headers?: Record<string, string>;
  /** Links a cached asset to this component. */
  component?: ComponentRef;
  /** Called on a 401 with WWW-Authenticate; returns an Authorization header value to retry once with, or null. */
  onChallenge?: (challenge: string, upstream: UpstreamView & { secret: string | null }) => Promise<string | null>;
}

/** What a mirror answered: the status, headers and body to send, and where they came from. */
export interface MirrorResponse {
  status: number;
  headers: Headers;
  /** null for HEAD. */
  body: ReadableStream<Uint8Array> | null;
  cache: CacheResult;
  /** The cached asset served (hit, stale); null when the response came from an upstream. */
  asset: AssetRow | null;
  /** The upstream URL that answered; null when served from the cache. */
  upstreamUrl: string | null;
}

/** Serves mirror repositories from their upstreams, optionally caching what they return. */
export interface MirrorEngine {
  /** null = not found: rules reject, offline without cache, or every upstream answered 404. Upstream 5xx/network errors with no usable cache throw RegistryError("upstream_unavailable"). */
  fetch(req: MirrorFetch): Promise<MirrorResponse | null>;
  /** Resolves once every cache write started so far has finished or failed. */
  drain(): Promise<void>;
}

/** What the mirror engine works with. */
export interface MirrorEngineDeps {
  db: Db;
  stores: StoreSet;
  repos: RepoService;
  assets: AssetService;
  settings: () => Promise<ServerSettings>;
  fetchImpl?: typeof fetch;
  /** How long an upstream may take to send response headers; defaults to {@link UPSTREAM_TIMEOUT_MS}. */
  upstreamTimeoutMs?: number;
}

type UpstreamOutcome =
  | { kind: "response"; response: Response; url: string }
  | { kind: "not_found" }
  | { kind: "failed"; failures: string[] };

/**
 * Splits `source` into two streams that each receive every chunk. Unlike `ReadableStream.tee`, a
 * chunk is read only once every open branch wants one, so a slow branch slows the source instead
 * of the other branch's chunks piling up in memory. A cancelled branch stops counting; the source
 * is cancelled when both are.
 */
export function teeWithBackpressure<T>(source: ReadableStream<T>): [ReadableStream<T>, ReadableStream<T>] {
  const reader = source.getReader();
  interface Branch {
    controller: ReadableStreamDefaultController<T> | null;
    open: boolean;
    /** Resolves the branch's pending pull. */
    wake: (() => void) | null;
  }
  const branches: Branch[] = [
    { controller: null, open: true, wake: null },
    { controller: null, open: true, wake: null },
  ];
  let reading = false;
  let finished = false;

  function settle(branch: Branch): void {
    const wake = branch.wake;
    branch.wake = null;
    wake?.();
  }

  function step(): void {
    if (reading || finished) return;
    const open = branches.filter((b) => b.open);
    if (open.length === 0) {
      finished = true;
      reader.cancel().catch(() => undefined);
      return;
    }
    if (!open.every((b) => b.wake !== null)) return;
    reading = true;
    reader.read().then(
      ({ done, value }) => {
        reading = false;
        if (done) finished = true;
        for (const branch of branches) {
          if (branch.open) {
            if (done) {
              branch.open = false;
              branch.controller!.close();
            } else {
              branch.controller!.enqueue(value);
            }
          }
          settle(branch);
        }
      },
      (error: unknown) => {
        reading = false;
        finished = true;
        for (const branch of branches) {
          if (branch.open) {
            branch.open = false;
            branch.controller!.error(error);
          }
          settle(branch);
        }
      },
    );
  }

  const branchStream = (branch: Branch) =>
    new ReadableStream<T>({
      start(controller) {
        branch.controller = controller;
      },
      pull() {
        return new Promise<void>((resolve) => {
          branch.wake = resolve;
          step();
        });
      },
      cancel() {
        branch.open = false;
        settle(branch);
        step();
      },
    });
  return [branchStream(branches[0]!), branchStream(branches[1]!)];
}

/** Whether a cached asset may be served without asking an upstream. */
function isFresh(asset: AssetRow, contentClass: ContentClass): boolean {
  if (contentClass === "immutable") return true;
  return asset.expiresAt !== null && asset.expiresAt.getTime() > Date.now();
}

/** The byte count of a `content-length` header, or undefined when absent or malformed. */
function parseLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : undefined;
}

/** The response headers describing a cached asset. */
function assetHeaders(asset: AssetRow): Headers {
  const headers = new Headers();
  if (asset.contentType) headers.set("content-type", asset.contentType);
  headers.set("content-length", String(asset.size));
  headers.set("etag", `"${asset.sha256}"`);
  headers.set("last-modified", asset.updatedAt.toUTCString());
  return headers;
}

/** Creates the mirror engine over the repositories, their upstreams and the asset store. */
export function createMirrorEngine(deps: MirrorEngineDeps): MirrorEngine {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const pending = new Set<Promise<unknown>>();

  /** The store cached objects go to: the mirror's, else the server default, else the primary when that one is not configured. */
  async function cacheStore(config: MirrorConfig): Promise<StoreId> {
    const wanted = config.cache.store ?? (await deps.settings()).defaultCacheStore;
    return deps.stores.get(wanted) ? wanted : deps.stores.primary.id;
  }

  /** Serves a cached asset and marks it accessed; null when its object is gone. */
  async function serveAsset(asset: AssetRow, method: "GET" | "HEAD", cache: "hit" | "stale"): Promise<MirrorResponse | null> {
    let body: ReadableStream<Uint8Array> | null = null;
    if (method === "GET") {
      const read = await deps.assets.open(asset).catch((error: unknown) => {
        console.warn(`weaver: cannot read cached asset ${asset.path}`, error);
        return null;
      });
      if (!read) return null;
      body = Readable.toWeb(read.body) as unknown as ReadableStream<Uint8Array>;
    }
    await deps.assets.touch(asset.id).catch((error: unknown) => console.warn(`weaver: cannot touch cached asset ${asset.path}`, error));
    return { status: 200, headers: assetHeaders(asset), body, cache, asset, upstreamUrl: null };
  }

  /** Sends the request to one upstream, retrying once with the `onChallenge` credentials after a 401 challenge. */
  async function ask(req: MirrorFetch, method: "GET" | "HEAD", upstream: UpstreamWithSecret, url: string): Promise<Response> {
    const send = (authorization: string | null) =>
      requestUpstream(fetchImpl, url, { method, headers: req.headers ?? {}, authorization, timeoutMs });
    const response = await send(upstreamAuthorization(upstream));
    const challenge = response.status === 401 ? response.headers.get("www-authenticate") : null;
    if (challenge === null || !req.onChallenge) return response;
    const authorization = await req.onChallenge(challenge, upstream);
    if (authorization === null) return response;
    await discardBody(response);
    return send(authorization);
  }

  /** Asks the upstreams in order; the first answer other than 404, 5xx or a network error wins. */
  async function askUpstreams(req: MirrorFetch, method: "GET" | "HEAD"): Promise<UpstreamOutcome> {
    const failures: string[] = [];
    for (const upstream of await deps.repos.upstreamsWithSecrets(req.repo.id)) {
      const url = upstreamUrl(upstream.url, req.path);
      let response: Response;
      try {
        response = await ask(req, method, upstream, url);
      } catch (error) {
        if (!(error instanceof UpstreamFetchError)) throw error;
        failures.push(error.message);
        continue;
      }
      if (response.status === 404) {
        await discardBody(response);
        continue;
      }
      if (response.status >= 500) {
        await discardBody(response);
        failures.push(`${url} answered ${response.status}`);
        continue;
      }
      return { kind: "response", response, url };
    }
    return failures.length > 0 ? { kind: "failed", failures } : { kind: "not_found" };
  }

  /** Streams a 200 GET answer to the client and into the cache at once; the asset row appears once the store write completes. */
  async function cacheThrough(req: MirrorFetch, config: MirrorConfig, response: Response, url: string): Promise<MirrorResponse> {
    const store = await cacheStore(config);
    const expiresAt = req.class === "metadata" ? new Date(Date.now() + config.cache.metadataTtlSeconds * 1000) : null;
    const [client, toStore] = teeWithBackpressure(response.body!);
    const write = deps.assets
      .put({
        repo: req.repo,
        path: req.path,
        body: Readable.fromWeb(toStore as unknown as NodeReadableStream<Uint8Array>),
        contentType: response.headers.get("content-type"),
        origin: "cache",
        store,
        expiresAt,
        component: req.component,
        contentLength: isDecoded(response.headers) ? undefined : parseLength(response.headers.get("content-length")),
      })
      .catch((error: unknown) => {
        console.warn(`weaver: caching ${req.repo.name}/${req.path} from ${url} failed`, error);
      })
      .finally(() => pending.delete(write));
    pending.add(write);
    return { status: response.status, headers: forwardableHeaders(response.headers), body: client, cache: "miss", asset: null, upstreamUrl: url };
  }

  return {
    async fetch(req) {
      const { repo } = req;
      if (repo.kind !== "mirror") throw new RegistryError("invalid_request", `Repository ${repo.name} is not a mirror`);
      const config = repo.config as MirrorConfig;
      if (!matchesRules(config.rules, req.subject)) return null;
      const method = req.method ?? "GET";

      const existing = config.cache.enabled || config.offline ? await deps.assets.find(repo.id, req.path) : null;
      if (config.offline) {
        return existing ? serveAsset(existing, method, isFresh(existing, req.class) ? "hit" : "stale") : null;
      }
      if (existing && isFresh(existing, req.class)) {
        const served = await serveAsset(existing, method, "hit");
        if (served) return served;
      }

      const outcome = await askUpstreams(req, method);
      if (outcome.kind === "response") {
        const { response, url } = outcome;
        if (config.cache.enabled && method === "GET" && response.status === 200 && response.body !== null) {
          return cacheThrough(req, config, response, url);
        }
        let body = response.body;
        if (method === "HEAD" && body !== null) {
          await discardBody(response);
          body = null;
        }
        return { status: response.status, headers: forwardableHeaders(response.headers), body, cache: "bypass", asset: null, upstreamUrl: url };
      }
      if (outcome.kind === "not_found") return null;

      if (existing) {
        const served = await serveAsset(existing, method, "stale");
        if (served) return served;
      }
      throw new RegistryError("upstream_unavailable", `No upstream of ${repo.name} could serve ${req.path}`, { failures: outcome.failures });
    },

    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
