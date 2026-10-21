import { expect, test, type Page } from "@playwright/test";
import { USERS } from "./fixtures";
import { loginAs } from "./helpers";

/** Picks `option` in the Radix select whose trigger has the accessible name `trigger`, inside `scope`. */
async function choose(page: Page, scope: ReturnType<Page["locator"]>, trigger: string, option: string) {
  await scope.getByRole("combobox", { name: trigger }).click();
  await page.getByRole("option", { name: new RegExp(`^${option}`) }).click();
}

test.describe.serial("repositories and API keys", () => {
  test("an admin creates a private repository and lands on its settings", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/repositories");
    await page.getByRole("link", { name: "New repository" }).first().click();
    await expect(page).toHaveURL("/repositories/new");

    // Client-side validation of the name.
    await page.getByLabel("Name", { exact: true }).fill("Team Private");
    await page.getByRole("button", { name: "Create repository" }).click();
    await expect(page.getByText("Use lowercase letters, digits and dashes")).toBeVisible();

    await page.getByLabel("Name", { exact: true }).fill("team-private");
    await page.getByLabel("Description").fill("Protos only the team can see");
    await page.getByRole("radio", { name: "Private" }).check();
    await page.getByRole("button", { name: "Create repository" }).click();

    await expect(page).toHaveURL("/repositories/team-private/settings");
    await expect(page.getByText("Lower wins.")).toBeVisible();
    await page.goto("/repositories");
    const row = page.getByTestId("repository-team-private");
    await expect(row).toContainText("private");
    await expect(row).toContainText("Protos only the team can see");
  });

  test("settings save, and a cleanup policy can be added, previewed and run", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/repositories/team-private/settings");

    await page.getByLabel("Resolution priority").fill("10");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Settings saved")).toBeVisible();

    await page.getByRole("button", { name: "Add policy" }).click();
    const dialog = page.getByRole("dialog", { name: "Add cleanup policy" });
    await dialog.getByRole("radio", { name: "Delete not downloaded" }).click();
    await dialog.getByLabel("Days").fill("90");
    await dialog.getByLabel("Group prefix").fill("com..bad");
    await dialog.getByRole("button", { name: "Add policy" }).click();
    await expect(dialog.getByText("Not a valid group")).toBeVisible();
    await dialog.getByLabel("Group prefix").fill("com.acme");
    await dialog.getByRole("checkbox", { name: "Include releases" }).check();
    await expect(dialog.getByText("Releases will be deleted")).toBeVisible();
    await dialog.getByRole("button", { name: "Add policy" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("cell", { name: /Delete snapshots and releases not downloaded for 90 days/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: "com.acme.*" })).toBeVisible();

    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByTestId("preview-empty")).toHaveText("Nothing to clean up right now.");
    await page.keyboard.press("Escape");

    // The e2e server has no VALKEY_URL, so Run now explains why it can't start.
    await page.getByRole("button", { name: "Run now" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Run cleanup" }).click();
    await expect(page.getByTestId("run-status")).toContainText("VALKEY_URL is unset");
  });

  test("an admin creates a key whose secret is shown exactly once", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/keys");
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByLabel("Name").fill("ci-team");
    const row = dialog.getByTestId("permission-row").first();
    await choose(page, row, "Repository", "team-private");
    await choose(page, row, "Access", "write");
    await dialog.getByRole("button", { name: "Create key" }).click();

    const secret = page.getByTestId("api-key-secret");
    await expect(secret).toHaveText(/^pl_/);
    const value = (await secret.textContent())!;
    await expect(page.getByText("You won't see this key again")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    const listed = page.getByTestId("api-key-row").filter({ hasText: "ci-team" });
    await expect(listed).toContainText("write team-private");
    await expect(page.getByText(value)).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("api-key-row").filter({ hasText: "ci-team" })).toBeVisible();
    expect(await page.content()).not.toContain(value);
  });

  test("an admin revokes a key after confirming", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/keys");
    const row = page.getByTestId("api-key-row").filter({ hasText: "ci-team" });
    await row.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke key" }).click();
    await expect(row).toHaveCount(0);
  });

  test("a viewer's key dialog offers only read access, and repository settings stay admin-only", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    await page.goto("/keys");
    await page.getByRole("button", { name: "Create key" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create API key" });
    await dialog.getByRole("combobox", { name: "Access" }).click();
    const options = page.getByRole("option");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("read");
    await page.keyboard.press("Escape");

    await page.goto("/repositories");
    await expect(page.getByTestId("repository-team-private")).toBeVisible();
    await expect(page.getByRole("link", { name: "New repository" })).toHaveCount(0);
    await page.goto("/repositories/team-private/settings");
    await expect(page).toHaveURL("/dashboard");
  });
});
