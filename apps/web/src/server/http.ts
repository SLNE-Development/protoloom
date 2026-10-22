import {
  isValidGroup,
  isValidName,
  isValidRepositoryName,
  isValidVersion,
  RegistryError,
  type Coordinate,
} from "@weaver/core";
import { env } from "@/env";

/** Body of every REST error response. */
export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** A JSON response with the given status. */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The REST error response for a registry error: its status, code, message and details. */
export function errorResponse(error: RegistryError): Response {
  const body: ErrorBody = { error: { code: error.code, message: error.message } };
  if (error.details !== undefined) body.error.details = error.details;
  return json(body, error.status);
}

/**
 * Wraps a route handler: a thrown {@link RegistryError} becomes its REST error response, and any
 * other error is logged and answered with a generic 500 that reveals nothing about its cause.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      console.error("weaver: unhandled error in API route", error);
      const body: ErrorBody = { error: { code: "internal_error", message: "Internal server error" } };
      return json(body, 500);
    }
  };
}

/** Shorthand for an `invalid_request` error. */
export function invalidRequest(message: string, details?: unknown): RegistryError {
  return new RegistryError("invalid_request", message, details);
}

/** Whether the request carries `?force=true`. */
export function forceParam(req: Request): boolean {
  return new URL(req.url).searchParams.get("force") === "true";
}

/** Path parameters of the artifact routes. */
export interface ArtifactParams {
  repo: string;
  group: string;
  name: string;
}

/** Path parameters of the version routes. */
export interface VersionParams extends ArtifactParams {
  version: string;
}

/** Checks the repository, group and name path segments; throws `invalid_request` when malformed. */
export function checkArtifactParams(params: ArtifactParams): void {
  if (!isValidRepositoryName(params.repo)) throw invalidRequest(`Invalid repository name "${params.repo}"`);
  if (!isValidGroup(params.group)) throw invalidRequest(`Invalid group "${params.group}"`);
  if (!isValidName(params.name)) throw invalidRequest(`Invalid artifact name "${params.name}"`);
}

/** The coordinate addressed by a version route; throws `invalid_request` when a segment is malformed. */
export function versionCoordinate(params: VersionParams): Coordinate {
  checkArtifactParams(params);
  if (!isValidVersion(params.version)) throw invalidRequest(`Invalid version "${params.version}"`);
  return { group: params.group, name: params.name, version: params.version };
}

/**
 * The absolute URL of one build's archive, built from the public base URL (`BETTER_AUTH_URL`),
 * never from the request host. Pinning the build keeps a snapshot download consistent with the
 * resolve answer (build number, sha256) even when a newer build is published in between.
 */
export function archiveUrl(repository: string, c: Coordinate, buildNumber: number): string {
  const base = env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const segments = [repository, "artifacts", c.group, c.name, c.version].map(encodeURIComponent).join("/");
  return `${base}/api/v1/repos/${segments}/archive?build=${buildNumber}`;
}

/**
 * The build number in `?build=<n>`, or undefined without one; throws `invalid_request` unless it
 * is a positive integer.
 */
export function buildParam(req: Request): number | undefined {
  const raw = new URL(req.url).searchParams.get("build");
  if (raw === null) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw invalidRequest(`Invalid build number "${raw}"`);
  return Number(raw);
}

/**
 * Reads the request body, refusing with `payload_too_large` as soon as it exceeds `maxBytes`,
 * whether or not the client sent a `Content-Length`.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new RegistryError("payload_too_large", `Request body exceeds ${maxBytes} bytes`);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Parses a JSON request body of at most `maxBytes`; throws `invalid_request` when it is not JSON. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBodyLimited(req, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidRequest("Request body must be valid JSON");
  }
}
