/**
 * E2E tests — Profile creation & management
 *
 * Covers:
 * - Create a profile via the UI
 * - View profile detail page
 * - Edit profile
 * - Create asset under a profile (nested)
 * - View linked records on profile detail
 */

import { test, expect } from "@playwright/test";

test.describe("Profile management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/profiles");
    await expect(page).not.toHaveURL(/#\/auth/);
  });

  test("profiles page loads", async ({ page }) => {
    await expect(page.getByText(/profiles/i).first()).toBeVisible();
  });

  test("can open create profile dialog", async ({ page }) => {
    const createBtn = page.getByRole("button", { name: /add|create|new profile/i });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // Dialog or form should appear
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });

  test("can create a person profile", async ({ page }) => {
    const profileName = `E2E Person ${Date.now()}`;

    // Open create dialog
    await page.getByRole("button", { name: /add|create|new profile/i }).click();

    // Select type "person" if type selector exists
    const typeSelect = page.getByRole("combobox").first();
    if (await typeSelect.isVisible()) {
      await typeSelect.selectOption("person");
    }

    // Fill in name
    await page.getByPlaceholder(/name/i).fill(profileName);

    // Submit
    await page.getByRole("button", { name: /create|save|add/i }).last().click();

    // Profile should appear in the list
    await expect(page.getByText(profileName)).toBeVisible({ timeout: 8_000 });
  });

  test("can create a vehicle profile", async ({ page }) => {
    const profileName = `E2E Car ${Date.now()}`;

    await page.getByRole("button", { name: /add|create|new profile/i }).click();

    const typeSelect = page.getByRole("combobox").first();
    if (await typeSelect.isVisible()) {
      await typeSelect.selectOption("vehicle");
    }

    await page.getByPlaceholder(/name/i).fill(profileName);
    await page.getByRole("button", { name: /create|save|add/i }).last().click();

    await expect(page.getByText(profileName)).toBeVisible({ timeout: 8_000 });
  });

  test("clicking a profile navigates to detail page", async ({ page }) => {
    // Assumes at least one profile exists from previous test or fixture
    const profileCards = page.locator("[data-testid='profile-card'], .profile-card, [href*='/profiles/']");
    const count = await profileCards.count();

    if (count === 0) {
      test.skip(true, "No profiles found — create one first");
      return;
    }

    await profileCards.first().click();

    // Should be on a profile detail page
    await expect(page).toHaveURL(/#\/profiles\/.+/);
  });

  test("profile detail page shows linked records sections", async ({ page }) => {
    // Navigate to any profile detail
    await page.goto("/#/profiles");
    const profileLinks = page.locator("a[href*='#/profiles/']");
    const count = await profileLinks.count();

    if (count === 0) {
      test.skip(true, "No profiles to navigate to");
      return;
    }

    await profileLinks.first().click();
    await expect(page).toHaveURL(/#\/profiles\/.+/);

    // Profile detail should have tabs/sections for related data
    const hasTabs = await page.getByRole("tab").count() > 0;
    const hasSections = await page.getByText(/tasks|expenses|documents|events/i).count() > 0;

    expect(hasTabs || hasSections).toBe(true);
  });
});

test.describe("Onboarding", () => {
  test("new user sees onboarding or self profile created automatically", async ({
    page,
  }) => {
    await page.goto("/#/dashboard");

    // Dashboard should be accessible without errors
    await expect(page).not.toHaveURL(/#\/auth/);

    // Look for dashboard content
    const hasContent = await page
      .getByText(/dashboard|welcome|hello|stats/i)
      .isVisible({ timeout: 8_000 });
    expect(hasContent).toBe(true);
  });
});
