import type { Metadata } from "next";
import Link from "next/link";
import { PackageIcon, SearchIcon } from "lucide-react";
import { Button } from "@weaver/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@weaver/ui/components/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@weaver/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weaver/ui/components/table";
import { KindBadge, PageContainer, PageHeader, Panel, RelativeTime, VisibilityBadge } from "@/components/browse-ui";
import { artifactHref, listingMetadataInput, repositoryHref } from "@/lib/browse";
import { pageMetadata } from "@/lib/seo";
import { visibleRepository } from "@/server/browse-metadata";
import { orNotFound } from "@/server/page-data";
import { requirePageAccess } from "@/server/session";
import { api } from "@/trpc/server";

type Params = { repo: string };

/** Canonical URL and description; private repositories are kept out of search engines. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { repo } = await params;
  const info = await visibleRepository(repo);
  return pageMetadata(listingMetadataInput({ repository: repo, visibility: info?.visibility ?? null, description: info?.description }));
}

/** The artifacts of one repository, optionally filtered by `?q=` on group or name. */
export default async function RepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const [{ repo }, query] = await Promise.all([params, searchParams]);
  await requirePageAccess(repositoryHref(repo));
  const q = (Array.isArray(query.q) ? query.q[0] : query.q)?.trim() ?? "";
  const [artifacts, repositories] = await Promise.all([
    orNotFound(api.browse.artifacts({ repository: repo, search: q || undefined }), repositoryHref(repo)),
    api.browse.repositories(),
  ]);
  const info = repositories.find((r) => r.name === repo);
  const groups = new Set(artifacts.map((a) => a.group)).size;

  return (
    <PageContainer>
      <PageHeader
        crumbs={[{ label: "Browse", href: "/browse" }, { label: repo, mono: true }]}
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono">{repo}</span>
            {info && <VisibilityBadge visibility={info.visibility} />}
          </span>
        }
        meta={
          <>
            {info?.description && <span className="text-sm">{info.description}</span>}
            {info && (
              <span className="font-mono">
                {info.artifactCount} artifacts · {info.versionCount} versions
              </span>
            )}
          </>
        }
      />

      <form action={repositoryHref(repo)} className="flex max-w-md gap-2" role="search">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput name="q" defaultValue={q} placeholder="Filter by group or name" aria-label="Filter artifacts" />
        </InputGroup>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {artifacts.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PackageIcon />
            </EmptyMedia>
            <EmptyTitle>{q ? "No matching artifacts" : "No artifacts yet"}</EmptyTitle>
            <EmptyDescription>
              {q ? (
                <>
                  Nothing in <code>{repo}</code> matches <code>{q}</code>.{" "}
                  <Link href={repositoryHref(repo)}>Clear the filter</Link>
                </>
              ) : (
                "Publish to this repository from Gradle with publishProtos."
              )}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Panel>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Artifact</TableHead>
                <TableHead className="hidden sm:table-cell">Group</TableHead>
                <TableHead>Latest</TableHead>
                <TableHead className="hidden text-right md:table-cell">Versions</TableHead>
                <TableHead className="pr-4 text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {artifacts.map((a) => (
                <TableRow key={`${a.group}:${a.name}`}>
                  <TableCell className="max-w-0 pl-4">
                    <div className="flex min-w-0 flex-col">
                      <Link href={artifactHref(repo, a.group, a.name)} className="truncate font-mono text-[13px] font-medium hover:underline">
                        {a.name}
                      </Link>
                      <span className="truncate font-mono text-[11px] text-muted-foreground sm:hidden">{a.group}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">{a.group}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        href={artifactHref(repo, a.group, a.name, a.latestVersion)}
                        className="font-mono text-[13px] hover:underline"
                        aria-label={`${a.name} ${a.latestVersion}`}
                      >
                        {a.latestVersion}
                      </Link>
                      <KindBadge version={a.latestVersion} className="hidden sm:inline-flex" />
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-right font-mono tabular-nums md:table-cell">{a.versionCount}</TableCell>
                  <TableCell className="pr-4 text-right text-xs text-muted-foreground">
                    <RelativeTime date={a.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="border-t bg-surface px-4 py-1.5 text-[11px] text-muted-foreground">
            {artifacts.length} {artifacts.length === 1 ? "artifact" : "artifacts"} in {groups} {groups === 1 ? "group" : "groups"}
            {q && ` matching “${q}”`}
          </p>
        </Panel>
      )}
    </PageContainer>
  );
}
