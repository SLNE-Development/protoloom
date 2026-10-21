import type { ReactNode } from "react";
import { TRPCReactProvider } from "@/trpc/client";

/**
 * Frame of the admin pages. Provides TanStack Query and the tRPC client to the admin screens until
 * the root layout mounts the provider for the whole app; a nested provider then reuses the same
 * browser QueryClient, so this wrapper stays harmless.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return <TRPCReactProvider>{children}</TRPCReactProvider>;
}
