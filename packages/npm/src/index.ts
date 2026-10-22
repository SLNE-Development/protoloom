import { npmError } from "./http.js";

export type { PackageName } from "./names.js";
export type { NpmRoute } from "./route.js";
export type { AbbreviatedPackument, Packument, VersionManifest } from "./packument.js";

/** Creates the request handler for `/npm/*`; a stub answering 404 until the handler is implemented. */
export function createNpmHandler(): (req: Request) => Promise<Response> {
  return () => Promise.resolve(npmError(404, "not found"));
}
