import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isValidRepositoryName } from "@/lib/names";
import { requireRole } from "@/server/session";
import { RepositorySettings } from "./repository-settings";

type Params = { params: Promise<{ repo: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { repo } = await params;
  return { title: `${repo} settings` };
}

/** Settings and cleanup policies of one repository (admins only). */
export default async function RepositorySettingsPage({ params }: Params) {
  const { repo } = await params;
  await requireRole("admin", `/repositories/${repo}/settings`);
  if (!isValidRepositoryName(repo)) notFound();
  return <RepositorySettings name={repo} />;
}
