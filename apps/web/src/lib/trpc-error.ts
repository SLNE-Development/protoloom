/** Reading tRPC client errors for toasts and inline messages. */

/** The tRPC error code (`CONFLICT`, `SERVICE_UNAVAILABLE`, …) of an error, or `null`. */
export function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const data = (error as { data?: { code?: unknown } | null }).data;
  return typeof data?.code === "string" ? data.code : null;
}

/** The message the server sent, or a generic fallback. */
export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong";
}

/** Why "Run now" could not start a cleanup job, in words an admin can act on. */
export function runNowErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case "SERVICE_UNAVAILABLE":
      return "Valkey is not reachable, so the cleanup job could not be queued. Nothing was deleted. Check the Valkey service and try again.";
    case "PRECONDITION_FAILED":
      return "Background jobs are not configured on this server (VALKEY_URL is unset), so cleanups can't run. Nothing was deleted.";
    default:
      return errorMessage(error);
  }
}
