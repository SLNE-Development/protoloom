import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { NewRepository } from "./new-repository";

export const metadata: Metadata = { title: "New repository" };

/** Create a repository (admins only). */
export default async function NewRepositoryPage() {
  await requireRole("admin", "/repositories/new");
  return <NewRepository />;
}
