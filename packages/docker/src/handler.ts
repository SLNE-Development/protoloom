import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RegistryError,
  canAccess,
  type FormatDeps,
  type FormatFactory,
  type FormatHandler,
  type Principal,
} from "@weaver/core";
import { DockerError, errorResponse } from "./errors.js";
import { isDigest } from "./media-types.js";
import { parseRoute, type Route } from "./route.js";
import { resolveTarget } from "./target.js";

/** Settings of a docker handler. */
export interface DockerOptions {
  /** Directory where in-progress blob uploads are staged. */
  uploadDir: string;
  /** The clock, for tests. */
  now?: () => Date;
}

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 401 error telling a client where to fetch a bearer token. */
function challenge(publicUrl: string): DockerError {
  const host = new URL(publicUrl).host;
  return new DockerError(401, "UNAUTHORIZED", "authentication required", undefined, {
    "www-authenticate": `Bearer realm="${publicUrl}/v2/token",service="${host}"`,
  });
}

/** Maps a thrown value to an OCI error response; unexpected errors are logged and become 500 `UNKNOWN`. */
function toResponse(err: unknown, publicUrl: string): Response {
  if (err instanceof DockerError) return errorResponse(err);
  if (err instanceof RegistryError) {
    switch (err.code) {
      case "unauthorized":
        return errorResponse(challenge(publicUrl));
      case "forbidden":
        return errorResponse(new DockerError(403, "DENIED", err.message));
      case "not_found":
        return errorResponse(new DockerError(404, "NAME_UNKNOWN", err.message));
      case "upstream_unavailable":
        return errorResponse(new DockerError(502, "UNAVAILABLE", "upstream unavailable"));
    }
  }
  console.error("weaver:docker request failed", err);
  return errorResponse(new DockerError(500, "UNKNOWN", "internal error"));
}

/** Rejects digests and upload ids that are malformed, before any lookup. */
function validate(route: Route): void {
  if ((route.kind === "blob" || route.kind === "referrers") && !isDigest(route.digest)) {
    throw new DockerError(400, "DIGEST_INVALID", "invalid digest", { digest: route.digest });
  }
  if (route.kind === "upload" && !UPLOAD_ID.test(route.uploadId)) {
    throw new DockerError(404, "BLOB_UPLOAD_UNKNOWN", "unknown upload", { uploadId: route.uploadId });
  }
}

/** The typed error for a manifest path whose reference is neither a valid tag nor digest, or null when `rest` is not a manifest path. */
function invalidReference(rest: string): DockerError | null {
  const m = rest.match(/^.+\/manifests\/([^/]+)$/);
  if (!m) return null;
  const reference = m[1]!;
  return reference.includes(":")
    ? new DockerError(400, "DIGEST_INVALID", "invalid digest", { reference })
    : new DockerError(400, "MANIFEST_INVALID", "invalid manifest reference", { reference });
}

/** Builds the docker handler for the `/v2` mount: routing, authentication challenge, authorization and error mapping. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- uploads arrive with the upload routes
export function createDockerHandlerWith(deps: FormatDeps, _opts: DockerOptions): FormatHandler {
  async function dispatch(req: Request, rest: string): Promise<Response> {
    const route = parseRoute(rest);
    if (!route) {
      throw invalidReference(rest) ?? new DockerError(404, "UNSUPPORTED", "unknown route");
    }
    validate(route);
    const principal: Principal = await deps.principal(req);

    if (route.kind === "base") {
      if (principal.kind === "anonymous") throw challenge(deps.publicUrl);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "docker-distribution-api-version": "registry/2.0" },
      });
    }
    if (route.kind === "token") throw new DockerError(501, "UNSUPPORTED", "token endpoint is not available yet");

    const target = await resolveTarget(deps.repos, route.name);
    if (!target) {
      if (principal.kind === "anonymous") throw challenge(deps.publicUrl);
      throw new DockerError(404, "NAME_UNKNOWN", "repository name not known to registry", { name: route.name });
    }
    const access = req.method === "GET" || req.method === "HEAD" ? "read" : "write";
    if (!canAccess(principal, target.repo, "", access)) {
      if (principal.kind === "anonymous") throw challenge(deps.publicUrl);
      throw new DockerError(403, "DENIED", "requested access to the resource is denied", { name: route.name });
    }
    throw new DockerError(501, "UNSUPPORTED", `${route.kind} is not implemented yet`);
  }

  return async (req, rest) => {
    try {
      return await dispatch(req, rest);
    } catch (err) {
      return toResponse(err, deps.publicUrl);
    }
  };
}

/** The docker handler with uploads staged in `WEAVER_DOCKER_UPLOAD_DIR` (default `<tmpdir>/weaver-uploads`). */
export const createDockerHandler: FormatFactory = (deps) =>
  createDockerHandlerWith(deps, { uploadDir: process.env.WEAVER_DOCKER_UPLOAD_DIR ?? join(tmpdir(), "weaver-uploads") });
