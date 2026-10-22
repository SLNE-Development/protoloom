/** OCI distribution error codes (plus the Weaver-specific `UNAVAILABLE` and `UNKNOWN`). */
export type DockerErrorCode =
  | "BLOB_UNKNOWN"
  | "BLOB_UPLOAD_INVALID"
  | "BLOB_UPLOAD_UNKNOWN"
  | "DIGEST_INVALID"
  | "MANIFEST_BLOB_UNKNOWN"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNKNOWN"
  | "NAME_INVALID"
  | "NAME_UNKNOWN"
  | "SIZE_INVALID"
  | "UNAUTHORIZED"
  | "DENIED"
  | "UNSUPPORTED"
  | "TOOMANYREQUESTS"
  | "RANGE_INVALID"
  | "UNAVAILABLE"
  | "UNKNOWN";

/** An error carrying the HTTP status, OCI code, optional detail and extra headers of the response it maps to. */
export class DockerError extends Error {
  /** Builds an error that {@link errorResponse} renders as an OCI error response. */
  constructor(
    readonly status: number,
    readonly code: DockerErrorCode,
    message: string,
    readonly detail?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "DockerError";
  }
}

/** Renders a {@link DockerError} as an OCI error response with the `registry/2.0` version header. */
export function errorResponse(e: DockerError): Response {
  return new Response(JSON.stringify({ errors: [{ code: e.code, message: e.message, detail: e.detail ?? null }] }), {
    status: e.status,
    headers: {
      ...e.headers,
      "content-type": "application/json",
      "docker-distribution-api-version": "registry/2.0",
    },
  });
}
