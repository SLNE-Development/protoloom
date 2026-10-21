import type { ReactNode } from "react";
import { TRPCReactProvider } from "@/trpc/client";

/**
 * Provides the tRPC client to the API keys page. Remove once the root layout mounts
 * `TRPCReactProvider` for the whole app; both use the same browser QueryClient, so nesting is harmless.
 */
export default function KeysLayout({ children }: { children: ReactNode }) {
  return <TRPCReactProvider>{children}</TRPCReactProvider>;
}
