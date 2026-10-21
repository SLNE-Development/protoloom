import "server-only";

import { api } from "@/trpc/server";

/**
 * Visibility and description of a repository as the visitor sees it, or `null` when they can't
 * browse it (unknown, private to them, or anonymous view off). For page metadata only.
 */
export async function visibleRepository(
  name: string,
): Promise<{ visibility: "public" | "private"; description: string | null } | null> {
  try {
    const repo = (await api.browse.repositories()).find((r) => r.name === name);
    return repo ? { visibility: repo.visibility, description: repo.description } : null;
  } catch {
    return null;
  }
}
