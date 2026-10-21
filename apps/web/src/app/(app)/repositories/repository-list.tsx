"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { DatabaseIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@protoloom/ui/components/alert";
import { Button } from "@protoloom/ui/components/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@protoloom/ui/components/empty";
import { Skeleton } from "@protoloom/ui/components/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@protoloom/ui/components/table";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { AcceptsBadges, VisibilityBadge } from "@/components/manage/visibility-badge";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";

/** Repository table. Admins see settings, counts and policies (`repositories.list`); others a read-only list (`browse.repositories`). */
export function RepositoryList({ isAdmin }: { isAdmin: boolean }) {
  const trpc = useTRPC();
  const admin = useQuery({ ...trpc.repositories.list.queryOptions(), enabled: isAdmin });
  const browse = useQuery({ ...trpc.browse.repositories.queryOptions(), enabled: !isAdmin });
  const query = isAdmin ? admin : browse;

  const newButton = isAdmin && (
    <Button asChild size="sm">
      <Link href="/repositories/new">
        <PlusIcon />
        New repository
      </Link>
    </Button>
  );

  return (
    <PageBody wide>
      <PageHeader
        title="Repositories"
        description={
          isAdmin
            ? "Where artifacts are published. Settings decide who sees a repository and what it accepts."
            : "Where artifacts are published. Only admins can change repository settings."
        }
        actions={newButton}
      />

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load repositories</AlertTitle>
          <AlertDescription>{errorMessage(query.error)}</AlertDescription>
        </Alert>
      ) : query.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : query.data.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DatabaseIcon />
            </EmptyMedia>
            <EmptyTitle>No repositories yet</EmptyTitle>
            <EmptyDescription>
              {isAdmin
                ? "Create a repository, then publish artifacts to it with the Gradle plugin or the CLI."
                : "An admin needs to create a repository before anything can be published."}
            </EmptyDescription>
          </EmptyHeader>
          {newButton && <EmptyContent>{newButton}</EmptyContent>}
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Name</TableHead>
                <TableHead>Visibility</TableHead>
                {isAdmin && <TableHead>Accepts</TableHead>}
                {isAdmin && <TableHead className="text-right">Priority</TableHead>}
                <TableHead className="text-right">Artifacts</TableHead>
                <TableHead className="text-right">Versions</TableHead>
                {isAdmin && <TableHead className="text-right">Policies</TableHead>}
                {isAdmin && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isAdmin && admin.data
                ? admin.data.map((repo) => (
                    <TableRow key={repo.name} data-testid={`repository-${repo.name}`}>
                      <TableCell className="max-w-80 pl-3">
                        <Link href={`/repositories/${repo.name}/settings`} className="font-mono font-medium hover:underline">
                          {repo.name}
                        </Link>
                        {repo.description && <p className="truncate text-xs text-muted-foreground">{repo.description}</p>}
                      </TableCell>
                      <TableCell>
                        <VisibilityBadge visibility={repo.visibility} />
                      </TableCell>
                      <TableCell>
                        <AcceptsBadges releases={repo.allowReleases} snapshots={repo.allowSnapshots} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{repo.resolutionPriority}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{repo.artifactCount}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{repo.versionCount}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{repo.policyCount}</TableCell>
                      <TableCell className="pr-3 text-right">
                        <Button asChild variant="ghost" size="icon-sm" aria-label={`Settings of ${repo.name}`}>
                          <Link href={`/repositories/${repo.name}/settings`}>
                            <SettingsIcon />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                : browse.data?.map((repo) => (
                    <TableRow key={repo.name} data-testid={`repository-${repo.name}`}>
                      <TableCell className="max-w-80 pl-3">
                        <Link href={`/browse/${repo.name}`} className="font-mono font-medium hover:underline">
                          {repo.name}
                        </Link>
                        {repo.description && <p className="truncate text-xs text-muted-foreground">{repo.description}</p>}
                      </TableCell>
                      <TableCell>
                        <VisibilityBadge visibility={repo.visibility} />
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{repo.artifactCount}</TableCell>
                      <TableCell className="pr-3 text-right font-mono tabular-nums">{repo.versionCount}</TableCell>
                    </TableRow>
                  ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageBody>
  );
}
