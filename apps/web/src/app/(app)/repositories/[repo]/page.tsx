import { redirect } from "next/navigation";

/** `/repositories/<name>` has no page of its own; its settings are the repository's admin view. */
export default async function RepositoryPage({ params }: { params: Promise<{ repo: string }> }) {
  const { repo } = await params;
  redirect(`/repositories/${encodeURIComponent(repo)}/settings`);
}
