import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { RepositoryList } from "./repository-list";

export const metadata: Metadata = { title: "Repositories" };

/** Every repository; admins also get counts, settings and "New repository". */
export default async function RepositoriesPage() {
  const { user } = await requireRole("viewer", "/repositories");
  return <RepositoryList isAdmin={user.role === "admin"} />;
}
