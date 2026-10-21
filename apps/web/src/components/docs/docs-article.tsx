"use client";

import { useEffect, useRef } from "react";

/**
 * The rendered Markdown of a docs page. The HTML comes from the repository's own content files
 * (rendered on the server by `renderDoc`), never from user input. Copy buttons on code blocks
 * copy the block's text and briefly show "Copied".
 */
export function DocsArticle({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onClick = async (event: MouseEvent) => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-copy]");
      const code = button?.closest(".docs-code")?.querySelector("pre")?.textContent;
      if (!button || code == null) return;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "Copied";
        button.setAttribute("data-copied", "");
      } catch {
        button.textContent = "Press Ctrl C";
      }
      const timer = setTimeout(() => {
        button.textContent = "Copy";
        button.removeAttribute("data-copied");
        timers.delete(timer);
      }, 1600);
      timers.add(timer);
    };
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
      timers.forEach(clearTimeout);
    };
  }, [html]);

  return <div ref={ref} className="docs-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
