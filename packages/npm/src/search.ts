import { discardBody, RegistryError, type FormatDeps, type Repo } from "@weaver/core";
import { npmJson } from "./http.js";
import type { Packument } from "./packument.js";
import { createNpmStore } from "./store.js";
import { forwardUpstream } from "./upstream.js";

/** The answer of `GET -/v1/search`, as registry.npmjs.org sends it. */
export interface SearchResult {
  objects: Array<{
    package: { name: string; version: string; description?: string; keywords?: string[]; date: string; links: Record<string, string> };
    score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
    searchScore: number;
  }>;
  total: number;
  time: string;
}

/** One entry of {@link SearchResult.objects}. */
type SearchObject = SearchResult["objects"][number];

/** Results per page when the client names no `size`. */
const DEFAULT_SIZE = 20;
/** Largest page a client can ask for. */
const MAX_SIZE = 250;
/** Largest upstream search answer read into memory to merge it into a group's results: 16 MiB. */
const MAX_UPSTREAM_SEARCH_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative integer query parameter, or `fallback` when it is missing or not one. */
function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

/** The `text`, `size` (default 20, 1..250) and `from` (default 0) of a search request. */
function searchParams(url: URL): { text: string; size: number; from: number } {
  const size = Math.min(MAX_SIZE, Math.max(1, intParam(url, "size", DEFAULT_SIZE)));
  return { text: url.searchParams.get("text") ?? "", size, from: intParam(url, "from", 0) };
}

/** The links a packument names: its homepage, repository and bug tracker URLs, where present. */
function linksOf(doc: Packument): Record<string, string> {
  const links: Record<string, string> = {};
  const latest = doc.versions?.[doc["dist-tags"]?.["latest"] ?? ""];
  const source = { ...latest, ...doc } as Record<string, unknown>;
  if (typeof source["homepage"] === "string") links["homepage"] = source["homepage"];
  const repository = source["repository"];
  const repoUrl = typeof repository === "string" ? repository : isRecord(repository) ? repository["url"] : undefined;
  if (typeof repoUrl === "string") links["repository"] = repoUrl;
  const bugs = source["bugs"];
  const bugsUrl = typeof bugs === "string" ? bugs : isRecord(bugs) ? bugs["url"] : undefined;
  if (typeof bugsUrl === "string") links["bugs"] = bugsUrl;
  return links;
}

/** A hosted packument as a search entry: its `latest` version (else the last listed), score and search score `1`. */
function hostedObject(doc: Packument): SearchObject {
  const versions = Object.keys(doc.versions ?? {});
  const tagged = doc["dist-tags"]?.["latest"];
  const version = typeof tagged === "string" ? tagged : (versions[versions.length - 1] ?? "");
  const time = doc.time ?? {};
  const date = time[version] ?? time["modified"] ?? new Date(0).toISOString();
  const pkg: SearchObject["package"] = { name: doc.name, version, date, links: linksOf(doc) };
  if (typeof doc.description === "string") pkg.description = doc.description;
  const keywords = doc["keywords"];
  if (Array.isArray(keywords)) pkg.keywords = keywords.filter((k): k is string => typeof k === "string");
  return { package: pkg, score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } }, searchScore: 1 };
}

/** Searches hosted repositories; an empty list of repositories finds nothing. */
async function searchHosted(deps: FormatDeps, repoIds: string[], url: URL): Promise<{ total: number; objects: SearchObject[] }> {
  const { text, size, from } = searchParams(url);
  const found = await createNpmStore(deps.db).search(repoIds, text, size, from);
  return { total: found.total, objects: found.documents.map(hostedObject) };
}

/** Forwards a search to a mirror's upstreams with the client's query string; null when offline or every upstream 404s. */
function forwardSearch(deps: FormatDeps, mirror: Repo, url: URL): Promise<Response | null> {
  return forwardUpstream(deps, mirror, "-/v1/search", { method: "GET", headers: new Headers({ accept: "application/json" }), search: url.search });
}

/** Reads an upstream search answer as JSON; null when it is too large, unreadable or not a search answer. */
async function readUpstreamResult(res: Response): Promise<{ total: number; objects: SearchObject[] } | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_UPSTREAM_SEARCH_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed["objects"])) return null;
    const objects = parsed["objects"].filter(
      (o): o is SearchObject => isRecord(o) && isRecord(o["package"]) && typeof o["package"]["name"] === "string",
    );
    const total = typeof parsed["total"] === "number" && Number.isFinite(parsed["total"]) ? parsed["total"] : objects.length;
    return { total, objects };
  } catch {
    return null;
  }
}

/** A search answer stamped with the current time. */
function result(total: number, objects: SearchObject[]): Response {
  const body: SearchResult = { objects, total, time: new Date().toUTCString() };
  return npmJson(body);
}

/**
 * Searches a group: the hosted members' results first (one query over all of them, paged by `size`/`from`), then
 * the upstream results of the first mirror member (the query passed through as is), deduplicated by package name;
 * `total` is the hosted total plus the upstream total. An unavailable or unusable upstream is skipped (logged).
 */
async function searchGroup(deps: FormatDeps, group: Repo, url: URL): Promise<Response> {
  const members = await deps.repos.members(group.id);
  const hosted = await searchHosted(
    deps,
    members.filter((m) => m.kind === "hosted").map((m) => m.id),
    url,
  );
  const mirror = members.find((m) => m.kind === "mirror");
  let upstream: { total: number; objects: SearchObject[] } | null = null;
  if (mirror) {
    try {
      const res = await forwardSearch(deps, mirror, url);
      if (res !== null) {
        if (res.status === 200) upstream = await readUpstreamResult(res);
        else await discardBody(res);
      }
    } catch (err) {
      if (!(err instanceof RegistryError && err.code === "upstream_unavailable")) throw err;
      console.warn(`weaver: npm group ${group.name} search skipped member ${mirror.name}: ${err.message}`);
    }
  }
  const seen = new Set(hosted.objects.map((o) => o.package.name));
  const objects = [...hosted.objects];
  for (const o of upstream?.objects ?? []) {
    if (seen.has(o.package.name)) continue;
    seen.add(o.package.name);
    objects.push(o);
  }
  return result(hosted.total + (upstream?.total ?? 0), objects);
}

/**
 * `GET -/v1/search?text=&size=&from=`: hosted repositories search their packages by name, description and keyword
 * (exact name first; size default 20, max 250); mirrors forward the query string upstream and pass the answer
 * through (an offline mirror or an upstream 404 finds nothing); groups combine both, see {@link searchGroup}.
 */
export async function handleSearch(deps: FormatDeps, repo: Repo, url: URL): Promise<Response> {
  if (repo.kind === "hosted") {
    const found = await searchHosted(deps, [repo.id], url);
    return result(found.total, found.objects);
  }
  if (repo.kind === "group") return searchGroup(deps, repo, url);
  const res = await forwardSearch(deps, repo, url);
  if (res === null) return result(0, []);
  const headers = new Headers(res.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(res.body, { status: res.status, headers });
}
