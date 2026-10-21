import { getServerContext } from "@/server/context";

/** Better Auth endpoints (`/api/auth/*`), resolved per request so builds never open a database pool. */
function handle(req: Request): Promise<Response> {
  return getServerContext().auth.handler(req);
}

export { handle as GET, handle as POST };
