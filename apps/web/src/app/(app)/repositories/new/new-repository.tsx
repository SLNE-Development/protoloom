"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@protoloom/ui/components/button";
import { PageBody, PageHeader } from "@/components/manage/page-header";
import { NEW_REPOSITORY_DEFAULTS, toRepositoryInput } from "@/lib/repository-settings";
import { errorMessage } from "@/lib/trpc-error";
import { useTRPC } from "@/trpc/client";
import { RepositoryForm } from "../repository-form";

/** The create form; on success it opens the new repository's settings. */
export function NewRepository() {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const create = useMutation(
    trpc.repositories.create.mutationOptions({
      onSuccess: async (repo) => {
        toast.success(`Repository ${repo.name} created`);
        await queryClient.invalidateQueries({ queryKey: trpc.repositories.list.queryKey() });
        router.push(`/repositories/${repo.name}/settings`);
      },
      onError: (error) => toast.error("Couldn't create the repository", { description: errorMessage(error) }),
    }),
  );

  return (
    <PageBody>
      <PageHeader
        back={{ href: "/repositories", label: "Repositories" }}
        title="New repository"
        description="Artifacts are published into a repository. You can change everything except the name later."
      />
      <RepositoryForm
        mode="create"
        defaultValues={NEW_REPOSITORY_DEFAULTS}
        submitting={create.isPending}
        onSubmit={(values) => create.mutateAsync(toRepositoryInput(values))}
        footer={
          <Button asChild variant="ghost" size="sm">
            <Link href="/repositories">Cancel</Link>
          </Button>
        }
      />
    </PageBody>
  );
}
