import { expect, test, type Locator, type Page } from "@playwright/test";
import { USERS } from "./fixtures";
import { loginAs } from "./helpers";

/**
 * Repository, cleanup policy and API key management. Every test creates what it needs under a
 * name unique to the run, so tests don't depend on each other and survive retries on the shared
 * e2e database.
 */

/** A repository name unique to this test run, e.g. `keys-lq3x9a-k2`. */
function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Calls a tRPC mutation as the page's signed-in user (superjson wire format). */
async function trpcMutation<T>(page: Page, path: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/trpc/${path}`, { data: { json: input } });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return ((await response.json()) as { result: { data: { json: T } } }).result.data.json;
}

async function createRepository(page: Page, name: string): Promise<void> {
  await trpcMutation(page, "repositories.create", { name, visibility: "private" });
}

/** Picks `option` in the Radix select whose trigger has the accessible name `trigger`, inside `scope`. */
async function choose(page: Page, scope: Locator, trigger: string, option: string) {
  await scope.getByRole("combobox", { name: trigger }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("an admin creates a private repository and lands on its settings", async ({ page }) => {
  const name = uniqueName("ui");
  await loginAs(page, USERS.admin.id);
  await page.goto("/repositories");
  await page.getByRole("link", { name: "New repository" }).first().click();
  await expect(page).toHaveURL("/repositories/new");

  // Client-side validation of the name.
  await page.getByLabel("Name", { exact: true }).fill("Team Private");
  await page.getByRole("button", { name: "Create repository" }).click();
  await expect(page.getByText("Use lowercase letters, digits and dashes")).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Description").fill("Protos only the team can see");
  await page.getByRole("radio", { name: "Private" }).check();
  await page.getByRole("button", { name: "Create repository" }).click();

  await expect(page).toHaveURL(`/repositories/${name}/settings`);
  await expect(page.getByText("Lower wins.")).toBeVisible();
  await page.goto("/repositories");
  const row = page.getByTestId(`repository-${name}`);
  await expect(row).toContainText("private");
  await expect(row).toContainText("Protos only the team can see");
});

test("repository settings save and keep unsaved edits while policies change", async ({ page }) => {
  const name = uniqueName("settings");
  await loginAs(page, USERS.admin.id);
  await createRepository(page, name);
  await page.goto(`/repositories/${name}/settings`);

  await page.getByLabel("Resolution priority").fill("10");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Resolution priority")).toHaveValue("10");

  // An unsaved edit survives a policy change, which refetches the repository.
  await page.getByLabel("Description").fill("Draft description");
  await page.getByRole("button", { name: "Add policy" }).click();
  const dialog = page.getByRole("dialog", { name: "Add cleanup policy" });
  await dialog.getByRole("button", { name: "Add policy" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("1 cleanup policies")).toBeVisible();
  await expect(page.getByLabel("Description")).toHaveValue("Draft description");
});

test("a cleanup policy can be added, edited, toggled, previewed and run", async ({ page }) => {
  const name = uniqueName("policies");
  await loginAs(page, USERS.admin.id);
  await createRepository(page, name);
  await page.goto(`/repositories/${name}/settings`);

  await page.getByRole("button", { name: "Add policy" }).click();
  const add = page.getByRole("dialog", { name: "Add cleanup policy" });
  await add.getByRole("radio", { name: "Delete not downloaded" }).click();
  await add.getByLabel("Days").fill("90");
  await add.getByLabel("Group prefix").fill("com..bad");
  await add.getByRole("button", { name: "Add policy" }).click();
  await expect(add.getByText("Not a valid group")).toBeVisible();
  await add.getByLabel("Group prefix").fill("com.acme");
  await add.getByRole("checkbox", { name: "Include releases" }).check();
  await expect(add.getByText("Releases will be deleted")).toBeVisible();
  await add.getByRole("button", { name: "Add policy" }).click();
  await expect(add).toBeHidden();
  await expect(page.getByRole("cell", { name: /Delete snapshots and releases not downloaded for 90 days/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "com.acme.*" })).toBeVisible();

  // Edit: switch the rule and its value; the dialog opens with the stored values.
  await page.getByRole("button", { name: "Edit policy" }).click();
  const edit = page.getByRole("dialog", { name: "Edit cleanup policy" });
  await expect(edit.getByLabel("Days")).toHaveValue("90");
  await expect(edit.getByLabel("Group prefix")).toHaveValue("com.acme");
  await edit.getByRole("radio", { name: "Keep last N snapshot builds" }).click();
  await edit.getByLabel("Builds to keep").fill("3");
  await edit.getByRole("button", { name: "Save policy" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("cell", { name: /Keep the last 3 builds of each snapshot/ })).toBeVisible();

  // Toggle: disabling the only policy disables Preview and Run now; enabling brings them back.
  const toggle = page.getByRole("switch", { name: "Disable policy" });
  await toggle.click();
  await expect(page.getByText("Policy disabled")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Enable policy" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Preview" })).toBeDisabled();
  await page.getByRole("switch", { name: "Enable policy" }).click();
  await expect(page.getByRole("switch", { name: "Disable policy" })).toBeChecked();

  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByTestId("preview-empty")).toHaveText("Nothing to clean up right now.");
  await page.keyboard.press("Escape");

  // The e2e server has no VALKEY_URL, so Run now explains why it can't start.
  await page.getByRole("button", { name: "Run now" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Run cleanup" }).click();
  await expect(page.getByTestId("run-status")).toContainText("VALKEY_URL is unset");
  await expect(page.getByRole("button", { name: "Run now" })).toBeEnabled();
});

test("an admin creates a key whose secret is shown exactly once", async ({ page }) => {
  const repo = uniqueName("keys");
  const keyName = uniqueName("ci").slice(0, 32);
  await loginAs(page, USERS.admin.id);
  await createRepository(page, repo);
  await page.goto("/keys");
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByLabel("Name").fill(keyName);
  const row = dialog.getByTestId("permission-row").first();
  await choose(page, row, "Repository", repo);
  await choose(page, row, "Access", "write");
  await dialog.getByRole("button", { name: "Create key" }).click();

  const secret = page.getByTestId("api-key-secret");
  await expect(secret).toHaveText(/^pl_/);
  const value = (await secret.textContent())!;
  await expect(page.getByText("You won't see this key again")).toBeVisible();
  // Neither Escape nor a click outside closes the dialog while the secret is on screen.
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 5);
  await expect(secret).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  const listed = page.getByTestId("api-key-row").filter({ hasText: keyName });
  await expect(listed).toContainText(`write ${repo}`);
  await expect(page.getByText(value)).toHaveCount(0);

  // Reopening the dialog starts from an empty form, not from the previous secret.
  await page.getByRole("button", { name: "Create key" }).first().click();
  await expect(page.getByRole("dialog", { name: "Create API key" }).getByLabel("Name")).toHaveValue("");
  await expect(page.getByTestId("api-key-secret")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page.getByTestId("api-key-row").filter({ hasText: keyName })).toBeVisible();
  expect(await page.content()).not.toContain(value);
});

test("an admin revokes a key after confirming", async ({ page }) => {
  const repo = uniqueName("revoke");
  const keyName = uniqueName("old").slice(0, 32);
  await loginAs(page, USERS.admin.id);
  await createRepository(page, repo);
  await trpcMutation(page, "keys.create", { name: keyName, permissions: [{ repository: repo, access: "read" }] });

  await page.goto("/keys");
  const row = page.getByTestId("api-key-row").filter({ hasText: keyName });
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke key" }).click();
  await expect(row).toHaveCount(0);
});

test("a viewer gets read-only keys and no repository administration", async ({ browser }) => {
  const repo = uniqueName("viewer");
  const adminPage = await browser.newPage();
  await loginAs(adminPage, USERS.admin.id);
  await createRepository(adminPage, repo);
  await adminPage.close();

  const page = await browser.newPage();
  await loginAs(page, USERS.viewer.id);
  await page.goto("/keys");
  await page.getByRole("button", { name: "Create key" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create API key" });
  await dialog.getByRole("combobox", { name: "Access" }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toHaveText("read");
  await page.keyboard.press("Escape");

  await page.goto("/repositories");
  await expect(page.getByTestId(`repository-${repo}`)).toBeVisible();
  await expect(page.getByRole("link", { name: "New repository" })).toHaveCount(0);
  await page.goto("/repositories/new");
  await expect(page).toHaveURL("/dashboard");
  await page.goto(`/repositories/${repo}/settings`);
  await expect(page).toHaveURL("/dashboard");
  await page.close();
});
