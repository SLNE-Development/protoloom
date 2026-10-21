import "server-only";

import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";

/**
 * Awaits a tRPC call of a page and turns "doesn't exist / can't be read / malformed path" into the
 * 404 page. Private repositories answer `NOT_FOUND` to outsiders, so nothing is disclosed.
 */
export async function orNotFound<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof TRPCError && (error.code === "NOT_FOUND" || error.code === "BAD_REQUEST")) notFound();
    throw error;
  }
}
