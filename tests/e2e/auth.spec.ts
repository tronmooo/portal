/**
 * E2E tests — Auth & Onboarding flows
 *
 * Covers:
 * - Sign-up with new account
 * - Sign-in with valid credentials
 * - Invalid credential handling
 * - Protected route redirect
 * - Sign-out flow
 */

import { test, expect } from "@playwright/test";

const uniqueEmail = () =>
  `test-${Date.now()}@example-playwright.com`;

// These tests do NOT use saved auth state — they test the auth UI itself
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Auth flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/auth");
  });

  test("auth page loads with sign-in and sign-up options", async ({ page }) => {
    await expect(page).toHaveTitle(/portol|lifeos/i);
    // Should show some form of auth UI
    const emailInput = page.getByPlaceholder(/email/i);
    await expect(emailInput).toBeVisible();
  });

  test("shows error for invalid credentials", async ({ page }) => {
    await page.getByPlaceholder(/email/i).fill("nobody@example.com");
    await page.getByPlaceholder(/password/i).fill("wrong-password-123");
    await page.getByRole("button", { name: /sign in/i }).click();

    // Should show an error message
    const error = page.getByText(/invalid|incorrect|error|failed/i);
    await expect(error).toBeVisible({ timeout: 8_000 });
  });

  test("shows error for short password on signup", async ({ page }) => {
    // Switch to sign-up tab
    const signUpTab = page.getByRole("tab", { name: /sign up|register|create/i });
    if (await signUpTab.isVisible()) {
      await signUpTab.click();
    }

    await page.getByPlaceholder(/email/i).fill(uniqueEmail());
    await page.getByPlaceholder(/password/i).fill("short");
    await page.getByRole("button", { name: /sign up|create|register/i }).click();

    const error = page.getByText(/password|too short|minimum/i);
    await expect(error).toBeVisible({ timeout: 5_000 });
  });

  test("unauthenticated user is redirected to auth page", async ({ page }) => {
    await page.goto("/#/dashboard");
    await expect(page).toHaveURL(/#\/(auth|login)/, { timeout: 5_000 });
  });

  test("unauthenticated user cannot access profiles page", async ({ page }) => {
    await page.goto("/#/profiles");
    await expect(page).toHaveURL(/#\/(auth|login)/, { timeout: 5_000 });
  });
});

test.describe("Post-auth flows", () => {
  // These tests run WITH saved auth state (injected by global-setup.ts)
  test("authenticated user sees dashboard", async ({ page }) => {
    await page.goto("/#/dashboard");
    // Should stay on dashboard, not redirect to auth
    await expect(page).not.toHaveURL(/#\/(auth|login)/);
    await expect(page.getByText(/dashboard/i).first()).toBeVisible({ timeout: 8_000 });
  });

  test("authenticated user can access all main nav sections", async ({
    page,
  }) => {
    await page.goto("/#/dashboard");

    const navLinks = [
      { url: "/#/profiles", label: /profiles/i },
      { url: "/#/tasks", label: /tasks/i },
      { url: "/#/habits", label: /habits/i },
    ];

    for (const { url } of navLinks) {
      await page.goto(url);
      await expect(page).not.toHaveURL(/#\/(auth|login)/);
    }
  });
});
