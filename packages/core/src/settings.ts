import { eq } from "drizzle-orm";
import { setting, type Db } from "@weaver/db";
import { recordAudit } from "./audit.js";
import { RegistryError } from "./errors.js";
import { isAdmin, type Principal } from "./permissions.js";

/** Server-wide settings that admins change on the Settings page. */
export interface ServerSettings {
  /** Whether visitors who aren't logged in may browse public repositories in the web UI. */
  anonymousView: boolean;
}

const DEFAULTS: ServerSettings = { anonymousView: false };

/** Reads the server settings, falling back to the defaults for keys never stored or stored with the wrong type. */
export async function getSettings(db: Db): Promise<ServerSettings> {
  const [row] = await db.select({ value: setting.value }).from(setting).where(eq(setting.key, "anonymousView"));
  return { anonymousView: typeof row?.value === "boolean" ? row.value : DEFAULTS.anonymousView };
}

/** Applies a partial update as an admin, audited as `settings.update`, and returns the resulting settings. */
export async function updateSettings(
  db: Db,
  patch: Partial<ServerSettings>,
  actor: Principal,
): Promise<ServerSettings> {
  if (!isAdmin(actor)) throw new RegistryError("forbidden", "Only admins can change server settings");
  const entries = Object.entries(patch).filter(([key, value]) => key in DEFAULTS && value !== undefined);
  if (entries.length > 0) {
    await db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
      }
      await recordAudit(tx, { actor, action: "settings.update", target: "settings", details: Object.fromEntries(entries) });
    });
  }
  return getSettings(db);
}
