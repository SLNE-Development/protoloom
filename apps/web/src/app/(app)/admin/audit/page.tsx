import type { Metadata } from "next";
import { requireRole } from "@/server/session";
import { AdminPage } from "../_components/admin-page";
import { AuditLog } from "./audit-log";

export const metadata: Metadata = { title: "Audit log · Protoloom" };

/** The audit log: every change made through the UI, the API or by the system, newest first. */
export default async function AuditPage() {
  await requireRole("admin", "/admin/audit");
  return (
    <AdminPage title="Audit log" description="Every change to repositories, artifacts, keys, users and settings, newest first.">
      <AuditLog />
    </AdminPage>
  );
}
