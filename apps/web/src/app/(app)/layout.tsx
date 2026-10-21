import type { ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { DASHBOARD_PATH, PATH_HEADER, decideAccess } from "@/lib/access";
import { getAppSession } from "@/server/session";

/**
 * Frame of every app page. Loads the session and settings on the server and applies the access
 * gate: anonymous visitors only get in with anonymous view on (dashboard and browse pages), admin
 * pages are for admins. The gate runs when the layout renders (full page loads); client-side
 * navigation is covered by the proxy's cookie check and by authorization on every data access.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const [{ user, settings }, requestHeaders] = await Promise.all([getAppSession(), headers()]);
  const path = requestHeaders.get(PATH_HEADER) ?? DASHBOARD_PATH;
  const decision = decideAccess({ path, role: user?.role ?? null, anonymousView: settings.anonymousView });
  if (decision.kind === "redirect") redirect(decision.to);
  return <AppShell user={user}>{children}</AppShell>;
}
