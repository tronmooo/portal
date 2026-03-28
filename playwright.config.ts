import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5000";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // Sequential for auth state sharing
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
    // Hash-based routing — ensure we don't get confused by hash changes
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    // Setup project: authenticate once and save state
    {
      name: "setup",
      testMatch: "**/e2e/global-setup.ts",
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        storageState: "tests/e2e/.auth/user.json",
      },
      dependencies: ["setup"],
    },
  ],

  // Start the dev server automatically for local runs
  webServer: process.env.CI
    ? undefined
    : {
        command: "npm run dev",
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 30_000,
      },
});
