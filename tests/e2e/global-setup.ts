/**
 * Playwright global setup — authenticates once and saves storage state.
 * Runs before all E2E tests via the "setup" project.
 *
 * Requires: TEST_EMAIL and TEST_PASSWORD environment variables.
 * The test user must already exist in Supabase (or set up via /api/auth/signup).
 */

import { test as setup, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const AUTH_FILE = path.join(__dirname, ".auth", "user.json");

const TEST_EMAIL = process.env.TEST_EMAIL || "testuser@example.com";
const TEST_PASSWORD = process.env.TEST_PASSWORD || "TestPass123!";

setup("authenticate", async ({ page }) => {
  // If auth state file already exists and is recent, reuse it
  if (fs.existsSync(AUTH_FILE)) {
    const stat = fs.statSync(AUTH_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 55 * 60 * 1000) {
      // < 55 minutes old — reuse (JWT expires at 60min)
      return;
    }
  }

  await page.goto("/#/auth");

  // Click "Sign In" tab if needed
  const signInTab = page.getByRole("tab", { name: /sign in/i });
  if (await signInTab.isVisible()) {
    await signInTab.click();
  }

  await page.getByPlaceholder(/email/i).fill(TEST_EMAIL);
  await page.getByPlaceholder(/password/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  // Wait for redirect away from auth page
  await expect(page).toHaveURL(/#\/(dashboard|$)/, { timeout: 15_000 });

  // Save auth state (cookies + localStorage + sessionStorage)
  await page.context().storageState({ path: AUTH_FILE });
});
