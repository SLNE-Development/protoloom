import { isPublicAuthPath } from "@/server/auth";
import { getServerContext } from "@/server/context";

const AUTH_PREFIX = "/api/auth";

/**
 * Better Auth endpoints (`/api/auth/*`), resolved per request so builds never open a database pool.
 * Only the endpoints the UI calls are served; any other Better Auth route answers 404 so it can't
 * bypass the app's own permission checks, invariants and audit log.
 */
function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const path = pathname.startsWith(AUTH_PREFIX) ? pathname.slice(AUTH_PREFIX.length).replace(/\/+$/, "") : "";
  if (!isPublicAuthPath(path)) return Promise.resolve(new Response("Not Found", { status: 404 }));
  return getServerContext().auth.handler(req);
}

export { handle as GET, handle as POST };
