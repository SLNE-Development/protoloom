"use client";

import { FileTextIcon, HashIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@protoloom/ui/components/command";
import { Kbd } from "@protoloom/ui/components/kbd";
import type { DocSearchEntry } from "@/lib/docs";

/**
 * The docs search: a button in the top bar and `Ctrl K` / `Cmd K` open a command dialog that
 * filters pages (by title, section and description) and their sections (by heading).
 */
export function DocsSearch({ entries }: { entries: DocSearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-60 items-center gap-2 rounded-md border bg-background px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label="Search docs"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">Search docs</span>
        <Kbd className="ml-auto hidden border font-mono sm:inline-flex">Ctrl K</Kbd>
      </button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search docs" description="Find a page or a section of the docs">
        <CommandInput placeholder="Search docs…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Pages">
            {entries.map((entry) => (
              <CommandItem
                key={entry.path}
                value={`${entry.title} ${entry.path}`}
                keywords={[entry.section, entry.description]}
                onSelect={() => go(entry.path)}
              >
                <FileTextIcon aria-hidden="true" />
                <span>{entry.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">{entry.section}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Sections">
            {entries.flatMap((entry) =>
              entry.headings.map((heading) => (
                <CommandItem
                  key={`${entry.path}#${heading.id}`}
                  value={`${heading.text} ${entry.path}#${heading.id}`}
                  keywords={[entry.title]}
                  onSelect={() => go(`${entry.path}#${heading.id}`)}
                >
                  <HashIcon aria-hidden="true" />
                  <span className="truncate">{heading.text}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{entry.title}</span>
                </CommandItem>
              )),
            )}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
