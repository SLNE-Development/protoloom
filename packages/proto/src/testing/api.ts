import { RegistryError, type FormatHandler, type Principal } from "@weaver/core";
import type { ProtoService } from "../service.js";
import { HOPS_HEADER, versionInfoToJson } from "../wire.js";

/** The JSON error answer for `error`, mirroring the `/api/v1` error shape. */
function errorResponse(error: unknown): Response {
  if (error instanceof RegistryError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  throw error;
}

/**
 * A minimal `/api/v1` proto read API over `service`, answering as `principal`: the version list,
 * manifest and archive routes below `repos/<repo>/artifacts/<group>/<name>`, which is all a proto
 * mirror asks of its upstream. It stands in for a remote Weaver instance in tests.
 */
export function protoReadApi(service: ProtoService, principal: Principal): FormatHandler {
  return async (req, rest) => {
    const segments = rest.split("/").map(decodeURIComponent);
    const [repos, repository, artifacts, group, name, version, archive, ...extra] = segments;
    if (repos !== "repos" || artifacts !== "artifacts" || !repository || !group || !name || extra.length > 0) {
      return errorResponse(new RegistryError("not_found", `No route for ${rest}`));
    }
    const hops = Number(req.headers.get(HOPS_HEADER) ?? "0");
    const build = new URL(req.url).searchParams.get("build");
    const select = build === null ? {} : { buildNumber: Number(build) };
    try {
      if (version === undefined) {
        const versions = await service.listVersions(principal, repository, group, name, hops);
        return Response.json({ versions: versions.map((v) => ({ ...v, updatedAt: v.updatedAt.toISOString() })) });
      }
      const c = { group, name, version };
      if (archive === undefined) {
        return Response.json(versionInfoToJson(await service.getManifest(principal, repository, c, select, hops)));
      }
      if (archive !== "archive") return errorResponse(new RegistryError("not_found", `No route for ${rest}`));
      const method = req.method === "HEAD" ? "HEAD" : "GET";
      const got = await service.archive(principal, repository, c, select, method, hops);
      const headers: Record<string, string> = { "content-type": "application/gzip" };
      if (got.size !== null) headers["content-length"] = String(got.size);
      if (got.sha256 !== null) headers["x-weaver-sha256"] = got.sha256;
      return new Response(got.body, { headers });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
