import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createTrpcContext } from "@/server/trpc/init";
import { appRouter, createCaller } from "@/server/trpc/root";
import { makeQueryClient } from "./query-client";

/** The tRPC context of the current request (principal from the session cookie), built once per request. */
const createContext = cache(async () => createTrpcContext({ headers: new Headers(await headers()) }));

/** The QueryClient of the current request, for prefetching into `<HydrationBoundary>`. */
export const getQueryClient = cache(makeQueryClient);

/**
 * Options proxy for Server Components: `await getQueryClient().prefetchQuery(trpc.browse.version.queryOptions(input))`,
 * then render `<HydrationBoundary state={dehydrate(getQueryClient())}>` so client components reuse the data.
 */
export const trpc = createTRPCOptionsProxy({ ctx: createContext, router: appRouter, queryClient: getQueryClient });

/**
 * Direct server-side caller for Server Components and server actions:
 * `const stats = await api.dashboard.stats()`. Errors are `TRPCError`s.
 */
export const api = createCaller(createContext);
