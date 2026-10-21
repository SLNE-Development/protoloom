import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";
import { getSettings, RegistryError, type ErrorCode, type Principal, type Registry, type ServerSettings } from "@protoloom/core";
import type { Db } from "@protoloom/db";
import { QueueUnavailableError, type CleanupQueue } from "@protoloom/jobs";
import type { Auth } from "../auth";
import { getServerContext } from "../context";
import { getCleanupQueue } from "../jobs";
import { getPrincipal } from "../principal";
import { env } from "@/env";

/** Everything a tRPC procedure can use. Built per request by {@link createTrpcContext}. */
export interface TrpcContext {
  db: Db;
  registry: Registry;
  auth: Auth;
  /** Who is calling: a signed-in user (session cookie), an API key, or anonymous. */
  principal: Principal;
  /** Server settings as stored when the request started. */
  settings: ServerSettings;
  /** The public base URL (`BETTER_AUTH_URL`) for absolute links such as invite URLs. */
  publicUrl: string;
  /** The producer queue for cleanup jobs, or `null` when `VALKEY_URL` is not configured. */
  cleanupQueue: () => CleanupQueue | null;
}

/** A user principal, as authed procedures see it. */
export type UserPrincipal = Extract<Principal, { kind: "user" }>;

/**
 * Builds the context for one request from its headers: resolves the principal (a banned user is
 * refused with `UNAUTHORIZED`) and loads the server settings.
 */
export async function createTrpcContext(
  opts: { headers: Headers },
  deps: Pick<TrpcContext, "db" | "registry" | "auth"> = getServerContext(),
): Promise<TrpcContext> {
  let principal: Principal;
  try {
    principal = await getPrincipal(new Request(env.BETTER_AUTH_URL, { headers: opts.headers }), deps);
  } catch (error) {
    if (error instanceof RegistryError) throw new TRPCError({ code: "UNAUTHORIZED", message: error.message, cause: error });
    throw error;
  }
  return {
    db: deps.db,
    registry: deps.registry,
    auth: deps.auth,
    principal,
    settings: await getSettings(deps.db),
    publicUrl: env.BETTER_AUTH_URL,
    cleanupQueue: getCleanupQueue,
  };
}

const TRPC_CODE_BY_REGISTRY_CODE: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
  invalid_request: "BAD_REQUEST",
  unauthorized: "UNAUTHORIZED",
  forbidden: "FORBIDDEN",
  not_found: "NOT_FOUND",
  immutable: "CONFLICT",
  has_dependents: "CONFLICT",
  payload_too_large: "PAYLOAD_TOO_LARGE",
  validation_failed: "UNPROCESSABLE_CONTENT",
};

/** Registry error code and details, carried to the client in `error.data.registry`. */
export interface RegistryErrorData {
  code: ErrorCode;
  details: unknown;
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const registry: RegistryErrorData | null =
      error.cause instanceof RegistryError ? { code: error.cause.code, details: error.cause.details ?? null } : null;
    return {
      ...shape,
      data: {
        ...shape.data,
        registry,
        zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;

/** Turns domain errors thrown by procedures into tRPC errors with a matching code. */
const domainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) {
    const cause = result.error.cause;
    if (cause instanceof RegistryError) {
      throw new TRPCError({ code: TRPC_CODE_BY_REGISTRY_CODE[cause.code], message: cause.message, cause });
    }
    if (cause instanceof QueueUnavailableError) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: `${cause.message}; try again later`, cause });
    }
  }
  return result;
});

/** Any caller, signed in or not. */
export const publicProcedure = t.procedure.use(domainErrors);

/**
 * Browsing: anonymous callers only while the "Allow anonymous view" setting is on (they then see
 * public repositories only, which the routers enforce through the principal); otherwise `UNAUTHORIZED`.
 */
export const browseProcedure = publicProcedure.use(({ ctx, next }) => {
  if (ctx.principal.kind === "anonymous" && !ctx.settings.anonymousView) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to browse this Protoloom" });
  }
  return next();
});

/** A signed-in user (session). API keys and anonymous callers get `UNAUTHORIZED`. */
export const authedProcedure = publicProcedure.use(({ ctx, next }) => {
  const principal = ctx.principal;
  if (principal.kind !== "user") throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first" });
  return next({ ctx: { principal } });
});

/** A signed-in maintainer or admin; viewers get `FORBIDDEN`. */
export const maintainerProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.role === "viewer") throw new TRPCError({ code: "FORBIDDEN", message: "Maintainers and admins only" });
  return next();
});

/** A signed-in admin; everyone else gets `FORBIDDEN`. */
export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.principal.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Admins only" });
  return next();
});
