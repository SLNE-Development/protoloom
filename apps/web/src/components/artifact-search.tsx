"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PackageIcon } from "lucide-react";
import { CommandGroup, CommandItem } from "@protoloom/ui/components/command";
import { artifactHref } from "@/lib/browse";
import { useTRPC } from "@/trpc/client";
import type { ArtifactSearchProps } from "./command-menu";

/** Characters needed before the dialog searches artifacts. */
const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * The command dialog's "Artifacts" group: live `browse.search` results for the typed query
 * (debounced, from two characters on). Enter opens the artifact page.
 */
export function ArtifactSearch({ query, onNavigate }: ArtifactSearchProps) {
  const trpc = useTRPC();
  const term = useDebounced(query.trim(), DEBOUNCE_MS);
  const enabled = term.length >= MIN_QUERY && query.trim().length >= MIN_QUERY;
  const { data } = useQuery({
    ...trpc.browse.search.queryOptions({ query: term, limit: 8 }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  if (!enabled || !data || data.length === 0) return null;
  return (
    <CommandGroup heading="Artifacts">
      {data.map((result) => {
        const coordinate = `${result.group}:${result.name}`;
        return (
          <CommandItem
            key={`${result.repository}/${coordinate}`}
            // cmdk filters items by value and keywords; the server already matched them, so the
            // typed query is a keyword too and the results are never filtered away.
            value={`artifact ${result.repository} ${coordinate}`}
            keywords={[query, result.group, result.name, result.repository]}
            onSelect={() => onNavigate(artifactHref(result.repository, result.group, result.name))}
          >
            <PackageIcon />
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{coordinate}</span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {result.repository} · {result.latestVersion}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
