import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { AdminPage } from "../_components/admin-page";
import { AnonymousViewSetting } from "./anonymous-view-setting";

export const metadata: Metadata = { title: "Settings" };

/** Server-wide settings. */
export default async function SettingsPage() {
  const { settings } = await requireRole("admin", "/admin/settings");
  return (
    <AdminPage title="Settings" description="Server-wide settings of this Protoloom.">
      <div className="max-w-3xl">
        <AnonymousViewSetting initial={settings.anonymousView} />
      </div>
    </AdminPage>
  );
}
