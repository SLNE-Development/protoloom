import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createTrpcContext } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The tRPC endpoint of the management UI (`/api/trpc/<procedure>`). */
function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    // Unexpected failures are logged by the error formatter in server/trpc/init.ts.
    createContext: () => createTrpcContext({ headers: req.headers }),
  });
}

export { handler as GET, handler as POST };
