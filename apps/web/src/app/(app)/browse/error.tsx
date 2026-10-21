"use client";

import { AppError } from "@/components/app-error";

/** Error boundary of the artifact browser. */
export default function BrowseError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppError error={error} reset={reset} backHref="/browse" backLabel="Browse repositories" />;
}
