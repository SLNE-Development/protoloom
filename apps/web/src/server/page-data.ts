import "server-only";

import { notFound, redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { loginPath } from "@/lib/access";

/**
 * Awaits a tRPC call of the page at `path` and maps the expected failures to pages:
 * `UNAUTHORIZED` (signed out, or anonymous view switched off) goes to the login page and back;
 * `NOT_FOUND`, `FORBIDDEN` and `BAD_REQUEST` (malformed path segments) show the 404 page. Private
 * repositories answer `NOT_FOUND` to outsiders, so nothing is disclosed.
 */
export async function orNotFound<T>(call: Promise<T>, path: string): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === "UNAUTHORIZED") redirect(loginPath(path));
      if (error.code === "NOT_FOUND" || error.code === "FORBIDDEN" || error.code === "BAD_REQUEST") notFound();
    }
    throw error;
  }
}
