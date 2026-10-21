import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { auditEvent, createDb, repository, session, setting, user } from "@protoloom/db";
import { BASE_URL, STATE_FILE, USERS, sessionToken } from "./fixtures";
import { loginAs } from "./helpers";

/**
 * A throwaway user the users-table tests promote, ban and remove, so the seeded users keep their
 * roles and sessions. Reset before every test, so a retry starts from the same state.
 */
const TEMP_USER = { id: "e2e-admin-spec-temp", name: "Tess Temp", email: "temp@e2e.test" } as const;

/** Makes names this run creates unique, so a retry against the same database doesn't collide. */
const RUN = Date.now().toString(36);

const PUBLIC_REPO = "admin-spec-public";
const PRIVATE_REPO = "admin-spec-private";

const DAY = 24 * 60 * 60 * 1000;

function openDb() {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { databaseUrl: string };
  return createDb(databaseUrl);
}

async function withDb(work: (db: ReturnType<typeof openDb>) => Promise<unknown>): Promise<void> {
  const db = openDb();
  try {
    await work(db);
  } finally {
    await db.$client.end();
  }
}

/** Resets "Allow anonymous view" to its default (off); the e2e database is shared by every spec. */
async function resetAnonymousView(): Promise<void> {
  await withDb((db) => db.delete(setting).where(eq(setting.key, "anonymousView")));
}

/** (Re)creates the temp user as an unbanned user with `role` and a session `loginAs` can use. */
async function resetTempUser(role: "admin" | "viewer" = "viewer"): Promise<void> {
  await withDb(async (db) => {
    const now = new Date();
    await db
      .insert(user)
      .values({ ...TEMP_USER, role, emailVerified: true, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: user.id, set: { role, banned: false, banReason: null, banExpires: null } });
    await db
      .insert(session)
      .values({
        id: `session-${TEMP_USER.id}`,
        token: sessionToken(TEMP_USER.id),
        userId: TEMP_USER.id,
        expiresAt: new Date(now.getTime() + 7 * DAY),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({ target: session.id, set: { expiresAt: new Date(now.getTime() + 7 * DAY) } });
  });
}

const sidebar = (page: Page) => page.locator("[data-slot=sidebar]");

test.beforeAll(async () => {
  await withDb((db) =>
    db
      .insert(repository)
      .values([
        { name: PUBLIC_REPO, visibility: "public", description: "Public protos" },
        { name: PRIVATE_REPO, visibility: "private" },
      ])
      .onConflictDoNothing(),
  );
});

test.describe("invites", () => {
  test("an admin creates a viewer invite whose link is shown exactly once", async ({ page, browser }) => {
    const note = `Admin spec invite ${RUN}`;
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users");
    await page.getByRole("tab", { name: "Invites" }).click();
    await page.getByRole("button", { name: "Create invite" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "viewer" }).click();
    await dialog.getByLabel("Expires in (days)").fill("3");
    await dialog.getByLabel("Note").fill(note);
    await dialog.getByRole("button", { name: "Create invite" }).click();

    const link = dialog.getByRole("textbox", { name: "Invite link" });
    await expect(link).toHaveValue(new RegExp(`^${BASE_URL}/invite/[A-Za-z0-9_-]+$`));
    await expect(dialog.getByText("won't be shown again")).toBeVisible();
    const url = await link.inputValue();
    const token = url.split("/invite/")[1]!;

    // Only "Done" closes the dialog while the link is shown.
    await page.keyboard.press("Escape");
    await expect(link).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("row", { name: new RegExp(note) });
    await expect(row).toContainText("open");
    await expect(row).toContainText(USERS.admin.name);

    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(note) })).toBeVisible();
    expect(await page.content()).not.toContain(token);

    const anonymous = await browser.newContext();
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto(url);
      await expect(visitor.getByRole("heading", { name: "You're invited to Protoloom" })).toBeVisible();
      await expect(visitor.getByTestId("invite-role")).toHaveText("viewer");
      await expect(visitor.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
    } finally {
      await anonymous.close();
    }
  });

  test("a revoked invite disappears and its link stops working", async ({ page, browser }) => {
    const note = `Invite to revoke ${RUN}`;
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users?tab=invites");
    await page.getByRole("button", { name: "Create invite" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note").fill(note);
    await dialog.getByRole("button", { name: "Create invite" }).click();
    const url = await dialog.getByRole("textbox", { name: "Invite link" }).inputValue();
    await dialog.getByRole("button", { name: "Done" }).click();

    const row = page.getByRole("row", { name: new RegExp(note) });
    await row.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke invite" }).click();
    await expect(row).toHaveCount(0);

    const anonymous = await browser.newContext();
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto(url);
      await expect(visitor.getByRole("heading", { name: "Invite not found" })).toBeVisible();
    } finally {
      await anonymous.close();
    }
  });
});

test.describe("users", () => {
  test.beforeEach(() => resetTempUser());

  test("the last admin can't be demoted, banned or removed", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users");
    const row = page.getByRole("row", { name: new RegExp(USERS.admin.email) });
    await expect(row.getByRole("combobox", { name: "Role" })).toBeDisabled();
    await expect(row.getByRole("button", { name: "Ban" })).toBeDisabled();
    await expect(row.getByRole("button", { name: "Remove" })).toBeDisabled();
    await expect(row).toContainText("Last admin");
  });

  test("an admin changes a role, bans, unbans and removes a user", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users");
    const row = page.getByRole("row", { name: new RegExp(TEMP_USER.email) });

    await row.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "maintainer" }).click();
    await expect(page.getByText(`${TEMP_USER.name} is now a maintainer`)).toBeVisible();
    await expect(row.getByRole("combobox", { name: "Role" })).toHaveText("maintainer");

    await row.getByRole("button", { name: "Ban" }).click();
    const ban = page.getByRole("dialog");
    await ban.getByLabel("Reason").fill("Testing bans");
    await ban.getByRole("button", { name: "Ban user" }).click();
    await expect(row.getByText("Banned", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Unban" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Unban user" }).click();
    await expect(row.getByText("Banned", { exact: true })).toHaveCount(0);

    await row.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove user" }).click();
    await expect(page.getByText("User removed")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(TEMP_USER.email) })).toHaveCount(0);
  });

  test("promoting to admin asks first, and admins can't ban or remove themselves", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users");
    const temp = page.getByRole("row", { name: new RegExp(TEMP_USER.email) });
    await temp.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "admin" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(`Make ${TEMP_USER.name} an admin?`);
    await confirm.getByRole("button", { name: "Make admin" }).click();
    await expect(page.getByText(`${TEMP_USER.name} is now an admin`)).toBeVisible();

    // No longer the last admin: the own role can change, but banning or removing yourself can't.
    const self = page.getByRole("row", { name: new RegExp(USERS.admin.email) });
    await expect(self).not.toContainText("Last admin");
    await expect(self.getByRole("combobox", { name: "Role" })).toBeEnabled();
    await expect(self.getByRole("button", { name: "Ban" })).toBeDisabled();
    await expect(self.getByRole("button", { name: "Remove" })).toBeDisabled();

    await self.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "viewer" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("You'll lose admin access immediately");
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await expect(self.getByRole("combobox", { name: "Role" })).toHaveText("admin");
  });

  test("an admin who demotes themselves lands on the dashboard without admin nav", async ({ page }) => {
    await resetTempUser("admin");
    await loginAs(page, TEMP_USER.id);
    await page.goto("/admin/users");
    const self = page.getByRole("row", { name: new RegExp(TEMP_USER.email) });
    await self.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "maintainer" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Give up admin access" }).click();

    await expect(page).toHaveURL("/dashboard");
    await expect(sidebar(page).getByRole("link", { name: "Repositories", exact: true })).toBeVisible();
    await expect(sidebar(page).getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
  });
});

test.describe("settings", () => {
  test.afterEach(resetAnonymousView);

  test("allowing anonymous view lets visitors browse public repositories only", async ({ page, browser }) => {
    await resetAnonymousView();
    const anonymous = await browser.newContext();
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto("/dashboard");
      await expect(visitor).toHaveURL("/login?next=%2Fdashboard");

      await loginAs(page, USERS.admin.id);
      await page.goto("/admin/settings");
      const toggle = page.getByRole("switch", { name: "Allow anonymous view" });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(page.getByText("Anonymous view is on")).toBeVisible();

      await visitor.goto("/dashboard");
      await expect(visitor).toHaveURL("/dashboard");
      await visitor.goto("/browse");
      await expect(visitor).toHaveURL("/browse");
      await expect(visitor.getByRole("link", { name: PUBLIC_REPO, exact: true })).toBeVisible();
      await expect(visitor.getByRole("link", { name: PRIVATE_REPO, exact: true })).toHaveCount(0);

      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await visitor.goto("/dashboard");
      await expect(visitor).toHaveURL("/login?next=%2Fdashboard");
    } finally {
      await anonymous.close();
    }
  });
});

test.describe("audit log", () => {
  const inviteTarget = `audit-spec-invite-${RUN}`;
  const removeTarget = `audit-spec-removed-${RUN}`;

  test.beforeEach(async () => {
    await withDb((db) =>
      db.insert(auditEvent).values([
        {
          actorType: "user",
          actorId: USERS.admin.id,
          action: "invite.create",
          target: inviteTarget,
          details: { role: "viewer", note: `audit ${RUN}` },
        },
        { actorType: "system", action: "user.remove", target: removeTarget, forced: true },
      ]),
    );
  });

  test("lists changes and filters them by action", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/audit");
    const table = page.getByRole("table");
    const invite = table.getByRole("row", { name: new RegExp(inviteTarget) });
    const removal = table.getByRole("row", { name: new RegExp(removeTarget) });
    await expect(invite).toContainText(USERS.admin.name);
    await expect(removal).toContainText("System");
    await expect(removal).toContainText("forced");

    await page.getByRole("combobox", { name: "Action" }).click();
    await page.getByRole("option", { name: "invite.create" }).click();
    await expect(removal).toHaveCount(0);
    await expect(table.getByText("user.remove")).toHaveCount(0);

    await invite.getByRole("button", { name: "Show details" }).click();
    await expect(table.getByText(`"note": "audit ${RUN}"`)).toBeVisible();
  });
});

test.describe("viewers", () => {
  test("don't see the admin nav and are kept out of admin pages", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    await page.goto("/dashboard");
    const nav = sidebar(page);
    await expect(nav.getByRole("link", { name: "API keys", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);

    for (const path of ["/admin/users", "/admin/settings", "/admin/audit"]) {
      await page.goto(path);
      await expect(page).toHaveURL("/dashboard");
    }
  });
});
