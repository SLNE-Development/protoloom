import type { Metadata } from "next";
import { getAppSession } from "@/server/session";

export const metadata: Metadata = { title: "Dashboard · Protoloom" };

/** Dashboard placeholder; the real dashboard (counts, recent publishes) replaces it. */
export default async function DashboardPage() {
  const { user } = await getAppSession();
  return (
    <div className="flex flex-col gap-1 px-6 py-6">
      <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        {user ? `Welcome back, ${user.name}.` : "Browse the public repositories of this registry."}
      </p>
    </div>
  );
}
