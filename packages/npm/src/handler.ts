import { canAccess, canReadThroughGroup, RegistryError, type FormatFactory, type Principal, type Repo } from "@weaver/core";
import { npmError, npmJson, toNpmResponse } from "./http.js";
import { publish, servePackument, serveTarball, serveVersion, type HostedContext } from "./hosted.js";
import { parseNpmPath, type NpmRoute } from "./route.js";
import { createNpmStore } from "./store.js";

/** Route kinds that address one package; writes to them are refused on mirrors and groups. */
const PACKAGE_KINDS = new Set<NpmRoute["kind"]>(["packument", "version", "tarball", "distTags"]);

/** The 405 answer listing the methods a route accepts. */
function methodNotAllowed(allow: string): Response {
  return npmError(405, "method not allowed", { allow });
}

/** Throws 401 for anonymous and 403 for authenticated principals lacking `access` on the repository. */
function authorize(principal: Principal, repo: Repo, access: "read" | "write"): void {
  const ok =
    access === "write"
      ? canAccess(principal, repo, "", "write")
      : repo.kind === "group"
        ? canReadThroughGroup(principal, repo)
        : canAccess(principal, repo, "", "read");
  if (ok) return;
  if (principal.kind === "anonymous") throw new RegistryError("unauthorized", "authentication required");
  throw new RegistryError("forbidden", `no ${access} access to repository ${repo.name}`);
}

/** Serves one package route of a hosted repository. */
async function serveHosted(ctx: HostedContext, route: NpmRoute, req: Request, method: string): Promise<Response> {
  const read = method === "GET" || method === "HEAD";
  switch (route.kind) {
    case "packument":
      if (read) return servePackument(ctx, route.name, req);
      if (method === "PUT") return publish(ctx, route.name, req);
      return methodNotAllowed("GET, HEAD, PUT");
    case "version":
      return read ? serveVersion(ctx, route.name, route.spec, req) : methodNotAllowed("GET, HEAD");
    case "tarball":
      return read ? serveTarball(ctx, route.name, route.file, req) : methodNotAllowed("GET, HEAD");
    default:
      return npmError(404, "not found");
  }
}

/**
 * Creates the handler of the `/npm` mount: parses the path, loads the repository (format `npm`, else 404), refuses
 * package writes to mirrors and groups with 405 before authentication, authorizes, then dispatches by route kind.
 */
export const createNpmHandler: FormatFactory = (deps) => {
  const store = createNpmStore(deps.db);
  return async (req, rest) => {
    try {
      const parsed = parseNpmPath(rest);
      if (!parsed) return npmError(404, "not found");
      const repo = await deps.repos.get(parsed.repo);
      if (!repo || repo.format !== "npm") return npmError(404, "not found");
      const { route } = parsed;
      const method = req.method.toUpperCase();
      const read = method === "GET" || method === "HEAD";

      if (route.kind === "ping") return read ? npmJson({}) : methodNotAllowed("GET, HEAD");
      if (route.kind === "unsupported") return npmError(404, "not supported by Weaver");
      if (!PACKAGE_KINDS.has(route.kind)) return npmError(404, "not found");
      if (!read && repo.kind !== "hosted") return methodNotAllowed("GET, HEAD");

      const principal = await deps.principal(req);
      authorize(principal, repo, read ? "read" : "write");
      if (repo.kind !== "hosted") return npmError(404, "not found");
      return await serveHosted({ deps, store, repo, principal }, route, req, method);
    } catch (error) {
      return toNpmResponse(error);
    }
  };
};
