"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@protoloom/ui/components/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@protoloom/ui/components/alert";
import { Button } from "@protoloom/ui/components/button";
import { Input } from "@protoloom/ui/components/input";
import { Label } from "@protoloom/ui/components/label";
import { Skeleton } from "@protoloom/ui/components/skeleton";
import { Spinner } from "@protoloom/ui/components/spinner";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { VisibilityBadge } from "@/components/manage/visibility-badge";
import { toRepositoryInput, type RepositorySettingsValues } from "@/lib/repository-settings";
import { errorCode, errorMessage } from "@/lib/trpc-error";
import { useTRPC, type RouterOutputs } from "@/trpc/client";
import { RepositoryForm } from "../../repository-form";
import { CleanupPolicies } from "./cleanup-policies";

type Repository = RouterOutputs["repositories"]["get"];

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function toFormValues(repo: Repository): RepositorySettingsValues {
  return {
    name: repo.name,
    description: repo.description ?? "",
    visibility: repo.visibility,
    allowRedeploy: repo.allowRedeploy,
    allowReleases: repo.allowReleases,
    allowSnapshots: repo.allowSnapshots,
    resolutionPriority: repo.resolutionPriority,
  };
}

/** General settings, cleanup policies and deletion of one repository. */
export function RepositorySettings({ name }: { name: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const repo = useQuery(trpc.repositories.get.queryOptions({ name }));

  const update = useMutation(
    trpc.repositories.update.mutationOptions({
      onSuccess: (updated) => {
        queryClient.setQueryData(trpc.repositories.get.queryKey({ name }), updated);
        void queryClient.invalidateQueries({ queryKey: trpc.repositories.list.queryKey() });
        toast.success("Settings saved");
      },
      onError: (error) => toast.error("Couldn't save the settings", { description: errorMessage(error) }),
    }),
  );

  const header = (
    <PageHeader
      back={{ href: "/repositories", label: "Repositories" }}
      title={
        <span className="flex items-center gap-2">
          <span className="font-mono">{name}</span>
          {repo.data && <VisibilityBadge visibility={repo.data.visibility} />}
        </span>
      }
      description={
        repo.data
          ? `${repo.data.artifactCount} artifacts · ${repo.data.versionCount} versions · ${repo.data.policyCount} cleanup policies`
          : undefined
      }
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={`/browse/${name}`}>
            <ExternalLinkIcon />
            Browse
          </Link>
        </Button>
      }
    />
  );

  if (repo.isError) {
    return (
      <PageBody>
        {header}
        <Alert variant="destructive">
          <AlertTitle>{errorCode(repo.error) === "NOT_FOUND" ? "Repository not found" : "Couldn't load the repository"}</AlertTitle>
          <AlertDescription>{errorMessage(repo.error)}</AlertDescription>
        </Alert>
      </PageBody>
    );
  }

  return (
    <PageBody>
      {header}
      <Section title="General" description="Who can see this repository and which versions it accepts.">
        {repo.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <RepositoryForm
            key={name}
            mode="edit"
            defaultValues={toFormValues(repo.data)}
            submitting={update.isPending}
            onSubmit={(values) => update.mutateAsync(toRepositoryInput({ ...values, name }))}
          />
        )}
      </Section>

      <Section
        title="Cleanup policies"
        description="Rules that delete old builds and versions. They run every night at 03:00 server time; preview them first."
      >
        <CleanupPolicies repository={name} />
      </Section>

      {repo.data && <DangerZone repo={repo.data} />}
    </PageBody>
  );
}

/** Deleting the repository, only while it is empty, after typing its name. */
function DangerZone({ repo }: { repo: Repository }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState("");
  const remove = useMutation(
    trpc.repositories.delete.mutationOptions({
      onSuccess: async () => {
        toast.success(`Repository ${repo.name} deleted`);
        await queryClient.invalidateQueries({ queryKey: trpc.repositories.list.queryKey() });
        router.push("/repositories");
      },
      onError: (error) => toast.error("Couldn't delete the repository", { description: errorMessage(error) }),
    }),
  );
  const empty = repo.artifactCount === 0;

  return (
    <Section title="Danger zone" description="Irreversible actions.">
      <div className="flex flex-col gap-3 rounded-md border border-destructive/40 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid gap-1">
          <span className="text-sm font-medium">Delete this repository</span>
          <span className="text-xs text-muted-foreground">
            {empty
              ? "Removes the repository, its cleanup policies and API key permissions on it."
              : `It still holds ${repo.artifactCount} artifacts. Delete them first.`}
          </span>
        </div>
        <AlertDialog onOpenChange={(open) => !open && setConfirm("")}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={!empty}>
              <Trash2Icon />
              Delete repository
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {repo.name}?</AlertDialogTitle>
              <AlertDialogDescription>This can't be undone. Type the repository name to confirm.</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-2">
              <Label htmlFor="confirm-repo-name" className="sr-only">
                Repository name
              </Label>
              <Input
                id="confirm-repo-name"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                placeholder={repo.name}
                autoComplete="off"
                className="font-mono"
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={confirm !== repo.name || remove.isPending}
                onClick={() => remove.mutate({ name: repo.name })}
              >
                {remove.isPending && <Spinner />}
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Section>
  );
}
