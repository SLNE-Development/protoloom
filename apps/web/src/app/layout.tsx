import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@protoloom/ui/components/theme-provider";
import "@protoloom/ui/globals.css";

export const metadata: Metadata = {
  title: "Protoloom",
  description: "Self-hosted registry for .proto files",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
