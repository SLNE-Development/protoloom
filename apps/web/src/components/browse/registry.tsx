import { Suspense, type ReactNode } from "react";
import type { Format, Repo } from "@weaver/core";
import { api } from "@/trpc/server";
import { ProtoArtifactList } from "./proto-artifact-list";

/** The proto browse view: the repository's artifacts with a `?q=` filter. */
async function ProtoRepositoryView({ repo }: { repo: Repo }) {
  const artifacts = await api.browse.artifacts({ repository: repo.name });
  return (
    <>
      <p className="-mt-3 font-mono text-xs text-muted-foreground">
        {artifacts.length} artifacts · {artifacts.reduce((sum, a) => sum + a.versionCount, 0)} versions
      </p>
      <Suspense>
        <ProtoArtifactList repository={repo.name} kind={repo.kind} artifacts={artifacts} />
      </Suspense>
    </>
  );
}

/**
 * The browse view of each format, rendered by `/browse/[repo]` below the common header. A format
 * without an entry shows a "not available yet" empty state; each format plan adds its entry.
 */
export const BROWSE_VIEWS: Partial<Record<Format, (props: { repo: Repo }) => ReactNode>> = {
  proto: ProtoRepositoryView,
};
