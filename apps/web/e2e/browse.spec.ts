import { expect, test, type Page } from "@playwright/test";
import { USERS } from "./fixtures";
import { loginAs } from "./helpers";

const VERSION_PAGE = "/browse/releases/dev.example/demo/1.0.0";

const sidebar = (page: Page) => page.locator("[data-slot=sidebar]");
const cursorOf = (locator: import("@playwright/test").Locator) => locator.evaluate((el) => getComputedStyle(el).cursor);

test.describe("artifact browser", () => {
  test("anonymous visitors are sent to the login page while anonymous view is off", async ({ page }) => {
    await page.goto(VERSION_PAGE);
    await expect(page).toHaveURL(`/login?next=${encodeURIComponent(VERSION_PAGE)}`);
  });

  test("the dashboard shows counts and recent publishes", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/dashboard");
    await expect(page.getByTestId("stat-artifacts")).toContainText("3");
    await expect(page.getByTestId("stat-repositories")).toContainText("2");
    const recent = page.getByTestId("recent-publishes");
    await expect(recent.getByRole("link", { name: "dev.example:orders:1.0.0" })).toBeVisible();
    await expect(recent.getByText("1.1.0-SNAPSHOT").first()).toBeVisible();
  });

  test("browse lists repositories, then artifacts, then versions", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/browse");
    await page.getByRole("link", { name: "releases", exact: true }).click();
    await expect(page).toHaveURL("/browse/releases");
    await page.getByRole("link", { name: "demo", exact: true }).click();
    await expect(page).toHaveURL("/browse/releases/dev.example/demo");
    await page.getByRole("link", { name: "1.0.0", exact: true }).click();
    await expect(page).toHaveURL(VERSION_PAGE);
  });

  test("the version page shows files, usage, details and dependents", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);

    const tree = page.getByRole("navigation", { name: "Files" });
    await expect(tree.getByRole("link", { name: "money.proto" })).toBeVisible();
    await tree.getByRole("link", { name: "money.proto" }).click();
    await expect(page.getByTestId("proto-viewer")).toContainText("message Money");

    await page.getByRole("tab", { name: "Usage" }).click();
    await expect(page.getByRole("tabpanel")).toContainText('protoloom("dev.example:demo:1.0.0")');

    await page.getByRole("tab", { name: /Dependents/ }).click();
    await expect(page.getByRole("tabpanel").getByRole("link", { name: "dev.example:orders:1.0.0" })).toBeVisible();

    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("sha256");

    expect(await cursorOf(sidebar(page).getByRole("link").first())).toBe("pointer");
    expect(await cursorOf(page.getByRole("button", { name: "Delete version" }))).toBe("pointer");
  });

  test("deleting a version with dependents lists them and lets admins force it", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await page.getByRole("button", { name: "Delete version" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog.getByText("dev.example:orders:1.0.0")).toBeVisible();
    const force = dialog.getByRole("button", { name: "Delete anyway" });
    await expect(force).toBeDisabled();
    await dialog.getByLabel(/Type/).fill("dev.example:demo:1.0.0");
    await expect(force).toBeEnabled();
    // Leave the fixture in place for the other tests.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("snapshot versions list their builds", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto("/browse/snapshots/dev.example/demo/1.1.0-SNAPSHOT");
    await page.getByRole("tab", { name: /Builds/ }).click();
    await expect(page.getByRole("tabpanel").getByRole("row")).toHaveCount(3);
  });

  test("viewers can't delete versions", async ({ page }) => {
    await loginAs(page, USERS.viewer.id);
    await page.goto(VERSION_PAGE);
    await expect(page.getByRole("heading", { name: /demo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete version" })).toHaveCount(0);
  });

  test("public artifacts get a share card, private ones stay out of search engines", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/og\/artifact\/releases\/dev\.example\/demo\/1\.0\.0$/);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

    await page.goto("/browse/snapshots/dev.example/demo/1.1.0-SNAPSHOT");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
  });

  test("Ctrl+K finds artifacts and switches the theme", async ({ page }) => {
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await expect(page.getByRole("heading", { name: /demo/ })).toBeVisible();

    await page.keyboard.press("Control+K");
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder(/Search/).fill("demo");
    const option = dialog.getByRole("option", { name: /dev\.example:demo/ }).first();
    await expect(option).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/browse\/(releases|snapshots)\/dev\.example\/demo$/);

    await page.keyboard.press("Control+K");
    await dialog.getByPlaceholder(/Search/).fill("theme dark");
    await expect(dialog.getByRole("option", { name: "Theme: Dark" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  });

  test("version pages register Copy coordinate in the command dialog", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await loginAs(page, USERS.admin.id);
    await page.goto(VERSION_PAGE);
    await expect(page.getByRole("heading", { name: /demo/ })).toBeVisible();
    await page.keyboard.press("Control+K");
    await page.getByRole("dialog").getByRole("option", { name: "Copy coordinate" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("dev.example:demo:1.0.0");
  });
});
