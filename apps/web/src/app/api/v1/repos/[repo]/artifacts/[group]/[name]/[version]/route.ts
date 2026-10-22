import { formatCoordinate, LIMITS, RegistryError, type Manifest, type VersionInfo } from "@weaver/core";
import { getServerContext } from "@/server/context";
import {
  forceParam,
  handle,
  invalidRequest,
  json,
  readBodyLimited,
  versionCoordinate,
  type VersionParams,
} from "@/server/http";
import { getPrincipal } from "@/server/principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<VersionParams> };

/** Room for the multipart framing and the manifest on top of the largest allowed archive. */
const MAX_PUBLISH_BODY = LIMITS.archiveBytes + 64 * 1024;

/** Reads the `manifest` (JSON) and `archive` (file) fields of a multipart publish body. */
async function readPublishForm(req: Request): Promise<{ manifest: unknown; archive: Buffer }> {
  const body = await readBodyLimited(req, MAX_PUBLISH_BODY);
  let form: FormData;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw invalidRequest("Expected a multipart/form-data body with fields manifest and archive");
  }
  const manifestField = form.get("manifest");
  const archiveField = form.get("archive");
  if (typeof manifestField !== "string") throw invalidRequest("Missing multipart field manifest (JSON)");
  if (!(archiveField instanceof Blob)) throw invalidRequest("Missing multipart file field archive (tar.gz)");
  if (archiveField.size > LIMITS.archiveBytes) {
    throw new RegistryError("payload_too_large", `The archive exceeds ${LIMITS.archiveBytes} bytes`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestField) as unknown;
  } catch {
    throw invalidRequest("The manifest field must be valid JSON");
  }
  return { manifest, archive: Buffer.from(await archiveField.arrayBuffer()) };
}

/**
 * `PUT`: publishes a version from a multipart body (`manifest` JSON, `archive` tar.gz). The URL's
 * group, name and version must match the manifest. `?force=true` lets an admin redeploy past
 * dependents. Answers `201` with `{ coordinate, buildNumber, sha256, redeployed }`.
 */
export const PUT = handle(async (req: Request, { params }: Context) => {
  const p = await params;
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PUBLISH_BODY) {
    throw new RegistryError("payload_too_large", `Request body exceeds ${MAX_PUBLISH_BODY} bytes`);
  }
  const c = versionCoordinate(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  if (principal.kind === "anonymous") throw new RegistryError("unauthorized", "Publishing requires an API key");

  const { manifest, archive } = await readPublishForm(req);
  const m = manifest as Partial<Manifest> | null;
  if (typeof m !== "object" || m === null || m.group !== c.group || m.name !== c.name || m.version !== c.version) {
    throw invalidRequest(`The manifest coordinate must equal the URL coordinate ${formatCoordinate(c)}`);
  }
  const result = await ctx.registry.publish(principal, {
    repository: p.repo,
    manifest: manifest as Manifest,
    archive,
    force: forceParam(req),
  });
  return json(
    {
      coordinate: formatCoordinate(result.coordinate),
      buildNumber: result.buildNumber,
      sha256: result.sha256,
      redeployed: result.redeployed,
    },
    201,
  );
});

/**
 * `VersionInfo` as sent over REST: the coordinate and the dependencies as `group:name:version`
 * strings, dates as ISO strings.
 */
function toJson(info: VersionInfo) {
  return {
    ...info,
    coordinate: formatCoordinate(info.coordinate),
    dependencies: info.dependencies.map(formatCoordinate),
  };
}

/** `GET`: the metadata of a version's newest build. */
export const GET = handle(async (req: Request, { params }: Context) => {
  const p = await params;
  const c = versionCoordinate(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  return json(toJson(await ctx.registry.getManifest(principal, p.repo, c)));
});

/**
 * `DELETE`: deletes a version with all its builds. Needs the version-delete permission; blocked
 * by dependents (`409 has_dependents`) unless an admin passes `?force=true`. Answers `204`.
 */
export const DELETE = handle(async (req: Request, { params }: Context) => {
  const p = await params;
  const c = versionCoordinate(p);
  const ctx = getServerContext();
  const principal = await getPrincipal(req, ctx);
  await ctx.registry.deleteVersion(principal, p.repo, c, { force: forceParam(req) });
  return new Response(null, { status: 204 });
});
