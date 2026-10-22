import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { RegistryError, type CommittedAsset, type FormatDeps, type Principal, type Repo } from "@weaver/core";
import { npmError, npmJson } from "./http.js";
import { isValidNewPackageName, tarballFile, type PackageName } from "./names.js";
import {
  ABBREVIATED_TYPE,
  abbreviate,
  rewriteTarballs,
  wantsAbbreviated,
  type Packument,
  type VersionManifest,
} from "./packument.js";
import { formatRev, type NpmStore } from "./store.js";

/** Largest accepted publish body (JSON with the base64 tarball): 256 MiB. */
export const MAX_PUBLISH_BYTES = 256 * 1024 * 1024;

/** Strict semantic version, as the npm registry requires for published versions. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** What serving one request of a hosted npm repository works with. */
export interface HostedContext {
  deps: FormatDeps;
  store: NpmStore;
  repo: Repo;
  principal: Principal;
}

/** Own-property assignment that is safe for untrusted keys such as `__proto__`. */
function setOwn<V>(target: Record<string, V>, key: string, value: V): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `${publicUrl}/npm/${repo}`: the base every tarball URL served from the repository starts with. */
function baseOf(ctx: HostedContext): string {
  return `${ctx.deps.publicUrl}/npm/${ctx.repo.name}`;
}

/** The asset path of a tarball: `<name>/-/<file>`. */
function tarballPath(name: PackageName, file: string): string {
  return `${name.full}/-/${file}`;
}

/** Reads a request body into memory, failing with 413 once it exceeds `limit` bytes (declared or actual). */
export async function readBody(req: Request, limit: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new RegistryError("payload_too_large", "request body too large");
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new RegistryError("payload_too_large", "request body too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Answers HEAD with the headers of `res` and no body. */
function forMethod(req: Request, res: Response): Response {
  if (req.method.toUpperCase() !== "HEAD") return res;
  return new Response(null, { status: res.status, headers: res.headers });
}

/** `GET/HEAD <name>`: the full packument with `_rev`, or the abbreviated one when the Accept header asks for it. */
export async function servePackument(ctx: HostedContext, name: PackageName, req: Request): Promise<Response> {
  const found = await ctx.store.get(ctx.repo.id, name.full);
  if (!found) return npmError(404, "not found");
  const doc = rewriteTarballs({ ...found.document, _rev: formatRev(found.rev, found.document) }, baseOf(ctx));
  const res = wantsAbbreviated(req.headers.get("accept"))
    ? npmJson(abbreviate(doc), { headers: { "content-type": ABBREVIATED_TYPE, vary: "Accept" } })
    : npmJson(doc, { headers: { vary: "Accept" } });
  return forMethod(req, res);
}

/** `GET/HEAD <name>/<spec>`: one version manifest, `spec` being a dist-tag first, then a version. */
export async function serveVersion(ctx: HostedContext, name: PackageName, spec: string, req: Request): Promise<Response> {
  const found = await ctx.store.get(ctx.repo.id, name.full);
  if (!found) return npmError(404, "not found");
  const doc = found.document;
  const tags = doc["dist-tags"] ?? {};
  const version = Object.hasOwn(tags, spec) ? tags[spec]! : spec;
  const versions = doc.versions ?? {};
  if (!Object.hasOwn(versions, version)) return npmError(404, `version not found: ${spec}`);
  const single: Record<string, VersionManifest> = {};
  setOwn(single, version, versions[version]!);
  const rewritten = rewriteTarballs({ name: doc.name, versions: single }, baseOf(ctx));
  return forMethod(req, npmJson(rewritten.versions[version]));
}

/** `GET/HEAD <name>/-/<file>`: streams a hosted tarball; GET records a download. */
export async function serveTarball(ctx: HostedContext, name: PackageName, file: string, req: Request): Promise<Response> {
  const path = tarballPath(name, file);
  const row = await ctx.deps.assets.find(ctx.repo.id, path);
  if (!row || row.origin !== "hosted") return npmError(404, "not found");
  const headers = { "content-type": "application/octet-stream", "content-length": String(row.size) };
  if (req.method.toUpperCase() === "HEAD") return new Response(null, { status: 200, headers });
  const read = await ctx.deps.assets.open(row);
  if (!read) return npmError(404, "not found");
  await ctx.deps.usage({ repositoryId: ctx.repo.id, assetId: row.id, path, action: "download", bytes: row.size, principal: ctx.principal });
  const body = Readable.toWeb(read.body) as NodeReadableStream<Uint8Array> as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: 200, headers });
}

/** Whether a client-sent `integrity` string agrees with the tarball's digests (unknown algorithms are ignored). */
function integrityMatches(integrity: string, digests: { sha1: Buffer; sha512: Buffer }): boolean {
  for (const token of integrity.trim().split(/\s+/)) {
    const dash = token.indexOf("-");
    if (dash < 0) return false;
    const algo = token.slice(0, dash).toLowerCase();
    const value = token.slice(dash + 1).split("?")[0]!;
    const expected = algo === "sha512" ? digests.sha512 : algo === "sha1" ? digests.sha1 : null;
    if (expected && value !== expected.toString("base64")) return false;
  }
  return true;
}

/** The single version, manifest and tarball of a publish body, after validating it against the URL name. */
function parsePublish(name: PackageName, body: unknown) {
  if (!isRecord(body)) throw new RegistryError("invalid_request", "invalid publish body");
  const attachments = body["_attachments"];
  if (!isRecord(attachments) || Object.keys(attachments).length === 0) {
    throw new RegistryError("invalid_request", "nothing to publish: the body has no attachments");
  }
  if (body["name"] !== name.full) throw new RegistryError("invalid_request", "package name in the body does not match the URL");
  if (!isValidNewPackageName(name.full)) throw new RegistryError("invalid_request", `invalid package name: ${name.full}`);
  const versions = body["versions"];
  const versionKeys = isRecord(versions) ? Object.keys(versions) : [];
  const attachmentKeys = Object.keys(attachments);
  if (versionKeys.length !== 1 || attachmentKeys.length !== 1) {
    throw new RegistryError("invalid_request", "a publish must contain exactly one version and one attachment");
  }
  const version = versionKeys[0]!;
  const manifest = (versions as Record<string, unknown>)[version];
  if (!SEMVER.test(version)) throw new RegistryError("invalid_request", `invalid version: ${version}`);
  if (!isRecord(manifest) || manifest["version"] !== version || (manifest["name"] !== undefined && manifest["name"] !== name.full)) {
    throw new RegistryError("invalid_request", "the version manifest does not match the package");
  }
  const attachment = attachments[attachmentKeys[0]!];
  if (!isRecord(attachment) || typeof attachment["data"] !== "string") throw new RegistryError("invalid_request", "invalid attachment");
  const tarball = Buffer.from(attachment["data"], "base64");
  if (tarball.length === 0) throw new RegistryError("invalid_request", "empty attachment");
  if (typeof attachment["length"] === "number" && attachment["length"] !== tarball.length) {
    // The digests are verified anyway; a wrong length is a client quirk, not a reason to refuse.
    console.warn(`weaver: npm publish of ${name.full}@${version}: attachment length ${attachment["length"]} differs from ${tarball.length} decoded bytes`);
  }
  const tags = body["dist-tags"];
  const distTags: Record<string, string> = {};
  if (tags !== undefined) {
    if (!isRecord(tags)) throw new RegistryError("invalid_request", "invalid dist-tags");
    for (const [tag, value] of Object.entries(tags)) {
      if (tag === "" || encodeURIComponent(tag) !== tag || typeof value !== "string") {
        throw new RegistryError("invalid_request", `invalid dist-tag: ${tag}`);
      }
      setOwn(distTags, tag, value);
    }
  }
  return { version, manifest, tarball, distTags, body };
}

/** `PUT <name>` with attachments: validates the single new version, stores its tarball and adds it to the packument. */
export async function publish(ctx: HostedContext, name: PackageName, req: Request): Promise<Response> {
  const raw = await readBody(req, MAX_PUBLISH_BYTES);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new RegistryError("invalid_request", "invalid JSON body");
  }
  const { version, manifest, tarball, distTags, body } = parsePublish(name, parsedJson);

  const sha1 = createHash("sha1").update(tarball).digest();
  const sha512 = createHash("sha512").update(tarball).digest();
  const dist = isRecord(manifest["dist"]) ? manifest["dist"] : {};
  const shasum = present(dist["shasum"]);
  if (shasum !== undefined && (typeof shasum !== "string" || shasum.toLowerCase() !== sha1.toString("hex"))) {
    throw new RegistryError("invalid_request", "integrity mismatch");
  }
  const integrity = present(dist["integrity"]);
  if (integrity !== undefined && (typeof integrity !== "string" || !integrityMatches(integrity, { sha1, sha512 }))) {
    throw new RegistryError("invalid_request", "integrity mismatch");
  }

  const file = tarballFile(name, version);
  const path = tarballPath(name, file);
  const stored: VersionManifest = {
    ...manifest,
    name: name.full,
    version,
    dist: { ...dist, shasum: sha1.toString("hex"), integrity: `sha512-${sha512.toString("base64")}`, tarball: path },
  };
  const { deps, repo, store } = ctx;
  // Streamed to the store before the package lock is taken, so a publish holds one pool connection at a time.
  const staged = await deps.assets.stage({ repo, body: Readable.from([tarball]), origin: "hosted", contentLength: tarball.length });
  let result: { rev: number; document: Packument; committed: CommittedAsset };
  try {
    result = await store.locked(repo.id, name.full, async (tx) => {
      const current = await store.get(repo.id, name.full, tx);
      const doc: Packument = current
        ? structuredClone(current.document)
        : { _id: name.full, name: name.full, "dist-tags": {}, versions: {}, time: {} };
      doc["dist-tags"] = isRecord(doc["dist-tags"]) ? doc["dist-tags"] : {};
      doc.versions = isRecord(doc.versions) ? doc.versions : {};
      doc.time = isRecord(doc.time) ? doc.time : {};
      if (publishedBefore(doc, version)) {
        throw new RegistryError("immutable", `You cannot publish over the previously published versions: ${version}.`);
      }
      for (const [tag, target] of Object.entries(distTags)) {
        if (target !== version && !Object.hasOwn(doc.versions, target)) {
          throw new RegistryError("invalid_request", `dist-tag ${tag} points to an unknown version: ${target}`);
        }
      }

      const committed = await deps.assets.commit(tx, staged, {
        path,
        contentType: "application/octet-stream",
        component: { namespace: name.scope, name: name.bare, version, metadata: stored },
      });

      const now = new Date().toISOString();
      setOwn(doc.versions, version, stored);
      for (const [tag, target] of Object.entries(distTags)) setOwn(doc["dist-tags"], tag, target);
      if (!Object.hasOwn(doc["dist-tags"], "latest")) setOwn(doc["dist-tags"], "latest", version);
      setOwn(doc.time, version, now);
      setOwn(doc.time, "modified", now);
      if (!Object.hasOwn(doc.time, "created")) setOwn(doc.time, "created", now);
      const readme = typeof body["readme"] === "string" ? body["readme"] : manifest["readme"];
      if (typeof readme === "string") doc.readme = readme;
      const description = typeof body["description"] === "string" ? body["description"] : manifest["description"];
      if (typeof description === "string") doc.description = description;
      if (Array.isArray(manifest["keywords"])) doc["keywords"] = manifest["keywords"];
      const rev = await store.save(tx, repo.id, name.full, doc, current?.rev ?? null);
      return { rev, document: doc, committed };
    });
  } catch (error) {
    // The transaction rolled back the asset row and any component it created; only the object is left.
    await deps.assets.discard(staged);
    throw error;
  }
  await result.committed.finish();

  const asset = result.committed.asset;
  await deps.usage({ repositoryId: repo.id, assetId: asset.id, path, action: "upload", bytes: tarball.length, principal: ctx.principal });
  return npmJson({ ok: true, id: name.full, rev: formatRev(result.rev, result.document) }, { status: 201 });
}

/** A digest field the client sent, or undefined when it is missing, null or blank. */
function present(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

/** The version without build metadata (`1.0.0+b` is `1.0.0`). */
function withoutBuild(version: string): string {
  const plus = version.indexOf("+");
  return plus < 0 ? version : version.slice(0, plus);
}

/**
 * Whether the version, or one differing from it only in build metadata, is or was published: present in
 * `versions` or left as a tombstone in `time`.
 */
function publishedBefore(doc: Packument, version: string): boolean {
  const base = withoutBuild(version);
  const keys = [...Object.keys(doc.versions), ...Object.keys(doc.time).filter((k) => k !== "created" && k !== "modified")];
  return keys.some((k) => withoutBuild(k) === base);
}
