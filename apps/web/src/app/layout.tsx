import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@protoloom/ui/components/theme-provider";
import { Toaster } from "@protoloom/ui/components/sonner";
import "@protoloom/ui/globals.css";

export const metadata: Metadata = {
  title: "Protoloom",
  description: "Self-hosted registry for .proto files",
};

/**
 * Root of every page: the design system's global styles (Geist / Geist Mono come with them), the
 * light / dark / system theme (next-themes sets the class on <html>, hence the hydration warning
 * suppression) and the toast outlet.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-svh">
        <ThemeProvider>
          {children}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
