import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, PORT, STATE_FILE, serverEnv } from "./e2e/fixtures";

/**
 * End-to-end tests against `next dev` on a throwaway database (`e2e/serve.ts`), seeded by
 * `e2e/global-setup.ts`. Tests share one database, so they run serially. Run with
 * `pnpm --filter web e2e` (Docker must be running).
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: "./.e2e/results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.ts",
    url: `${BASE_URL}/login`,
    // Never reuse a server: one started outside the tests would run against a real database.
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { ...serverEnv(), E2E_PORT: String(PORT), E2E_STATE_FILE: STATE_FILE },
  },
});
