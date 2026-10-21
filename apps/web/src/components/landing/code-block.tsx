import type { ReactNode } from "react";
import { cn } from "@protoloom/ui/lib/utils";

/**
 * Styles for Shiki output from ./highlight: light colours are inline, dark ones come from
 * `--shiki-dark`; long lines scroll inside the block instead of widening the page.
 */
export const codeClasses = cn(
  "min-w-0 font-mono text-[12px] leading-[1.65] sm:text-[12.5px]",
  "[&_pre]:overflow-x-auto [&_pre]:px-4 [&_pre]:py-3.5 [&_pre]:outline-none",
  "[&_pre:focus-visible]:ring-2 [&_pre:focus-visible]:ring-ring/40 [&_pre:focus-visible]:ring-inset",
  "dark:[&_span[style]]:text-(--shiki-dark)!",
  "[&_.ln]:inline-block [&_.ln]:w-[2.2em] [&_.ln]:text-muted-foreground/60 [&_.ln]:select-none",
);

/** Pre-highlighted HTML from {@link highlight}. */
export function CodeHtml({ html, label, className }: { html: string; label?: string; className?: string }) {
  return <div role={label ? "region" : undefined} aria-label={label} className={cn(codeClasses, className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A terminal transcript; lines are given as nodes so prompts and results can be coloured. */
export function Terminal({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className={cn(
        "overflow-x-auto rounded-md border bg-surface px-3 py-2.5 font-mono text-[12px] leading-[1.65] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
    >
      {children}
    </pre>
  );
}
