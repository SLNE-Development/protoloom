"use client";

import { AppError } from "@/components/app-error";

/** Error boundary of the app pages (inside the shell). */
export default function AppErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppError error={error} reset={reset} backHref="/dashboard" backLabel="Go to the dashboard" />;
}
