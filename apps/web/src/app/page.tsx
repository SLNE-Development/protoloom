import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@protoloom/ui/components/logo";
import { DASHBOARD_PATH } from "@/lib/access";
import { getAppSession } from "@/server/session";

/**
 * Public landing page (placeholder; the final content follows separately). Signed-in users go
 * straight to the dashboard; anonymous visitors always see this page.
 */
export default async function LandingPage() {
  const { user } = await getAppSession();
  if (user) redirect(DASHBOARD_PATH);
  return (
    <main data-testid="landing" className="flex min-h-svh flex-col items-center justify-center gap-6 px-4">
      <Logo variant="full" />
      <Link href="/login" className="text-sm text-link underline-offset-4 hover:underline">
        Sign in
      </Link>
    </main>
  );
}
