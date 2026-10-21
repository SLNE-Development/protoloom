import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@protoloom/ui/components/theme-provider";
import { Toaster } from "@protoloom/ui/components/sonner";
import { defaultMetadata } from "@/lib/seo";
import { TRPCReactProvider } from "@/trpc/client";
import "@protoloom/ui/globals.css";

/** Site-wide metadata: base URL, the "%s · Protoloom" title template, description and share card defaults. */
export function generateMetadata(): Metadata {
  return defaultMetadata();
}

/**
 * Root of every page: the design system's global styles (Geist / Geist Mono come with them), the
 * light / dark / system theme (next-themes sets the class on <html>, hence the hydration warning
 * suppression), TanStack Query with the tRPC client, and the toast outlet.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-svh">
        <ThemeProvider>
          <TRPCReactProvider>
            {children}
            <Toaster position="bottom-right" />
          </TRPCReactProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
