import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createDb, repository, setting, user } from "@protoloom/db";
import { BASE_URL, STATE_FILE, USERS } from "./fixtures";
import { loginAs } from "./helpers";

/** A throwaway user the users-table tests ban, promote and remove (seeded users keep their sessions). */
const TEMP_USER = { id: "e2e-admin-spec-temp", name: "Tess Temp", email: "temp@e2e.test", role: "viewer" } as const;

const PUBLIC_REPO = "admin-spec-public";
const PRIVATE_REPO = "admin-spec-private";

function openDb() {
  const { databaseUrl } = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { databaseUrl: string };
  return createDb(databaseUrl);
}

/** Resets "Allow anonymous view" to its default (off); the e2e database is shared by every spec. */
async function resetAnonymousView(): Promise<void> {
  const db = openDb();
  try {
    await db.delete(setting).where(eq(setting.key, "anonymousView"));
  } finally {
    await db.$client.end();
  }
}

const sidebar = (page: Page) => page.locator("[data-slot=sidebar]");

test.beforeAll(async () => {
  const db = openDb();
  try {
    const now = new Date();
    await db
      .insert(user)
      .values({ ...TEMP_USER, emailVerified: true, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await db
      .insert(repository)
      .values([
        { name: PUBLIC_REPO, visibility: "public", description: "Public protos" },
        { name: PRIVATE_REPO, visibility: "private" },
      ])
      .onConflictDoNothing();
  } finally {
    await db.$client.end();
  }
});

test.describe("invites", () => {
  test("an admin creates a viewer invite whose link is shown exactly once", async ({ page, browser }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users");
    await page.getByRole("tab", { name: "Invites" }).click();
    await page.getByRole("button", { name: "Create invite" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "viewer" }).click();
    await dialog.getByLabel("Expires in (days)").fill("3");
    await dialog.getByLabel("Note").fill("Invite from the admin spec");
    await dialog.getByRole("button", { name: "Create invite" }).click();

    const link = dialog.getByLabel("Invite link");
    await expect(link).toHaveValue(new RegExp(`^${BASE_URL}/invite/[A-Za-z0-9_-]+$`));
    await expect(dialog.getByText("won't be shown again")).toBeVisible();
    const url = await link.inputValue();
    const token = url.split("/invite/")[1]!;

    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole("row", { name: /Invite from the admin spec/ });
    await expect(row).toContainText("open");
    await expect(row).toContainText(USERS.admin.name);

    await page.reload();
    await expect(page.getByRole("row", { name: /Invite from the admin spec/ })).toBeVisible();
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
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/users?tab=invites");
    await page.getByRole("button", { name: "Create invite" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note").fill("Invite to revoke");
    await dialog.getByRole("button", { name: "Create invite" }).click();
    const url = await dialog.getByLabel("Invite link").inputValue();
    await dialog.getByRole("button", { name: "Done" }).click();

    const row = page.getByRole("row", { name: /Invite to revoke/ });
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
    await expect(page.getByRole("row", { name: new RegExp(TEMP_USER.email) })).toHaveCount(0);
  });
});

test.describe("settings", () => {
  test.afterEach(resetAnonymousView);

  test("allowing anonymous view lets visitors browse public repositories only", async ({ page, browser }) => {
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
      // The repository list page belongs to the browse screens; ask the API the page uses directly.
      const response = await visitor.request.get("/api/trpc/browse.repositories");
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as { result: { data: { json: { name: string }[] } } };
      const names = body.result.data.json.map((repo) => repo.name);
      expect(names).toContain(PUBLIC_REPO);
      expect(names).not.toContain(PRIVATE_REPO);

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
  test("lists changes and filters them by action", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/admin/audit");
    const table = page.getByRole("table");
    await expect(table.getByText("invite.create").first()).toBeVisible();
    await expect(table.getByText("user.remove").first()).toBeVisible();

    await page.getByRole("combobox", { name: "Action" }).click();
    await page.getByRole("option", { name: "invite.create" }).click();
    await expect(table.getByText("user.remove")).toHaveCount(0);
    const first = table.getByRole("row", { name: /invite\.create/ }).first();
    await expect(first).toContainText(USERS.admin.name);

    await first.getByRole("button", { name: "Show details" }).click();
    await expect(table.getByText(/"role":\s*"viewer"|"role":\s*"maintainer"/).first()).toBeVisible();
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
