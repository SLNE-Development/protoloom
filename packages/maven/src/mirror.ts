import { RegistryError, matchesRules, type ContentClass, type MirrorConfig, type MirrorResponse, type Repo } from "@weaver/core";
import { checksumGeneratable, digestOf } from "./checksum.js";
import type { MavenContext } from "./context.js";
import { counted, generatedResponse } from "./hosted.js";
import { classifyStoredPath, mirrorSubjects, type MavenPath } from "./path.js";

/** A Maven path that names a file (not a directory). */
type MirrorTarget = Exclude<MavenPath, { type: "directory" }>;

/** Upstream response headers passed on to the client. */
const KEPT_HEADERS = ["content-type", "content-length", "last-modified", "etag"] as const;

/** Largest upstream `maven-metadata.xml` read into memory. */
const METADATA_LIMIT = 16 * 1024 * 1024;

/**
 * How a mirror caches a path: release files never change; snapshot files, metadata (and their
 * checksums) and every other path are revalidated after the metadata TTL.
 */
export function contentClassFor(target: MirrorTarget): ContentClass {
  if (target.type === "file") return target.snapshot ? "metadata" : "immutable";
  return "metadata";
}

/**
 * The subjects rules are matched against: every {@link mirrorSubjects} reading plus, for each
 * `groupId:artifactId`, its dotted form `groupId.artifactId`. Rules name groupId prefixes, so a
 * pattern such as `com.evil.*` covers the artifacts of group `com.evil` as well as its subgroups.
 */
function ruleCandidates(target: MirrorTarget): string[] {
  const out = new Set<string>();
  for (const subject of mirrorSubjects(target)) {
    out.add(subject);
    if (subject.includes(":")) out.add(subject.replace(":", "."));
  }
  return [...out];
}

/**
 * The rule subject to hand the mirror engine, or null when the rules reject the path. A path is
 * allowed iff the allow list is empty or some candidate subject matches it, and no candidate
 * matches the deny list; the returned subject is a candidate that passes the rules on its own.
 */
function allowedSubject(repo: Repo, target: MirrorTarget): string | null {
  const { rules } = repo.config as MirrorConfig;
  const candidates = ruleCandidates(target);
  if (candidates.some((c) => !matchesRules({ allow: [], deny: rules.deny }, c))) return null;
  return candidates.find((c) => matchesRules(rules, c)) ?? null;
}

/** Cancels an unused mirror body so the upstream connection and any cache write are released. */
async function discard(res: MirrorResponse): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Turns an upstream 401/403 into `upstream_unavailable`: the handler answers 401 with a client
 * Basic challenge, and upstream credentials are not the client's to fix.
 */
async function rejectUpstreamAuth(repo: Repo, path: string, res: MirrorResponse): Promise<void> {
  if (res.status !== 401 && res.status !== 403) return;
  await discard(res);
  throw new RegistryError("upstream_unavailable", `The upstream of ${repo.name} refused ${path} with ${res.status}`);
}

/** Fetches a rule-checked path (`subject` from {@link allowedSubject}) through the mirror engine; null when not found. */
async function fetchThrough(ctx: MavenContext, repo: Repo, target: MirrorTarget, subject: string, method: "GET" | "HEAD"): Promise<MirrorResponse | null> {
  const res = await ctx.deps.mirror.fetch({
    repo,
    path: target.path,
    subject,
    class: contentClassFor(target),
    method,
    component: target.type === "file" ? { namespace: target.groupId, name: target.artifactId, version: target.version } : undefined,
  });
  if (res) await rejectUpstreamAuth(repo, target.path, res);
  return res;
}

/** A checksum the upstream does not have, generated from the cached file it belongs to; null when not cached. */
async function cachedChecksum(ctx: MavenContext, repo: Repo, target: MirrorTarget): Promise<Response | null> {
  if (target.checksum === null || !checksumGeneratable(target.basePath)) return null;
  const base = await ctx.deps.assets.find(repo.id, target.basePath);
  return base ? generatedResponse(ctx, digestOf(base, target.checksum), "text/plain") : null;
}

/**
 * Serves a path of a mirror repository through the mirror engine (rules, cache, upstreams), keeping
 * only the status and the content headers of the answer. A checksum the upstream lacks is generated
 * from the cached file. Downloads of counted files are recorded with the cache result.
 * null = not found here (lets groups continue); throws RegistryError("upstream_unavailable").
 */
export async function readMirror(ctx: MavenContext, repo: Repo, target: MirrorTarget): Promise<Response | null> {
  const subject = allowedSubject(repo, target);
  if (subject === null) return null;
  const method = ctx.method === "HEAD" ? "HEAD" : "GET";
  const res = await fetchThrough(ctx, repo, target, subject, method);
  if (res === null) return cachedChecksum(ctx, repo, target);

  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (method === "GET" && res.status === 200 && counted(target)) {
    const length = Number(res.headers.get("content-length"));
    await ctx.deps.usage({
      repositoryId: repo.id,
      assetId: res.asset?.id ?? null,
      path: target.path,
      action: "download",
      cache: res.cache,
      bytes: res.asset?.size ?? (Number.isSafeInteger(length) ? length : 0),
      principal: ctx.principal,
    });
  }
  return new Response(res.body, { status: res.status, headers });
}

/** Reads a mirror body as UTF-8 text, failing with `upstream_unavailable` beyond {@link METADATA_LIMIT} bytes. */
async function readText(repo: Repo, path: string, body: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > METADATA_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("upstream_unavailable", `${path} of ${repo.name} is larger than ${METADATA_LIMIT} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Upstream (or cached) metadata XML for a mirror directory, or null; throws RegistryError("upstream_unavailable"). */
export async function mirrorMetadataXml(ctx: MavenContext, repo: Repo, dir: string): Promise<string | null> {
  const path = dir === "" ? "maven-metadata.xml" : `${dir}/maven-metadata.xml`;
  const target = classifyStoredPath(path) as MirrorTarget;
  const subject = allowedSubject(repo, target);
  if (subject === null) return null;
  const res = await fetchThrough(ctx, repo, target, subject, "GET");
  if (res === null) return null;
  if (res.status !== 200 || res.body === null) {
    await discard(res);
    return null;
  }
  return readText(repo, path, res.body);
}
