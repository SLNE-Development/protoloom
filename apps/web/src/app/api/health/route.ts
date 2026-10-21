import { sql } from "drizzle-orm";
import { getServerContext } from "@/server/context";

// Always probes the database; never served from a cache.
export const dynamic = "force-dynamic";

/**
 * Liveness and readiness probe for container healthchecks and load balancers. No authentication.
 * Answers `200 { ok: true }` once `select 1` succeeds, `503 { ok: false }` when the database
 * can't be reached; the error itself is only logged, never returned.
 */
export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  try {
    await getServerContext().db.execute(sql`select 1`);
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    console.error("health: database check failed", error);
    return Response.json({ ok: false }, { status: 503, headers });
  }
}
