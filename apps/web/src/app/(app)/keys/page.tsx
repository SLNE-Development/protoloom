import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { KeysManager } from "./keys-manager";

export const metadata: Metadata = { title: "API keys" };

/** The signed-in user's API keys (admins can also see everyone's). `?create=1` opens the create dialog. */
export default async function KeysPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ user }, params] = await Promise.all([requireRole("viewer", "/keys"), searchParams]);
  return <KeysManager role={user.role} openCreate={params.create === "1"} />;
}
