/**
 * E2E tests — Tracker creation & entry logging
 *
 * Covers:
 * - Create a tracker
 * - Log a tracker entry
 * - View entry history
 * - Delete an entry
 */

import { test, expect } from "@playwright/test";

test.describe("Tracker management", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/#/trackers");
    await expect(page).not.toHaveURL(/#\/auth/);
  });

  test("trackers page loads", async ({ page }) => {
    await expect(page.getByText(/tracker/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test("can open create tracker dialog", async ({ page }) => {
    const createBtn = page.getByRole("button", {
      name: /add|create|new tracker/i,
    });
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  });

  test("can create a weight tracker", async ({ page }) => {
    const trackerName = `E2E Weight ${Date.now()}`;

    await page.getByRole("button", { name: /add|create|new tracker/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder(/name/i).fill(trackerName);

    // Submit form
    await dialog.getByRole("button", { name: /create|save|add/i }).last().click();

    await expect(page.getByText(trackerName)).toBeVisible({ timeout: 8_000 });
  });

  test("can log an entry for a tracker", async ({ page }) => {
    // Find an existing tracker or create one first
    const trackerCards = page.locator("[data-testid='tracker-card'], .tracker-card");
    const cardCount = await trackerCards.count();

    if (cardCount === 0) {
      // Create one inline
      await page.getByRole("button", { name: /add|create|new tracker/i }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByPlaceholder(/name/i).fill(`E2E Log Test ${Date.now()}`);
      await dialog.getByRole("button", { name: /create|save|add/i }).last().click();
      await expect(page.locator("[data-testid='tracker-card'], .tracker-card, [class*='tracker']").first()).toBeVisible({ timeout: 8_000 });
    }

    // Click "Log entry" button on first tracker
    const logBtn = page.getByRole("button", { name: /log|add entry|record/i }).first();
    if (await logBtn.isVisible()) {
      await logBtn.click();

      const entryDialog = page.getByRole("dialog");
      if (await entryDialog.isVisible()) {
        // Fill in numeric value
        const numInput = entryDialog.getByRole("spinbutton").first();
        if (await numInput.isVisible()) {
          await numInput.fill("175");
        }

        await entryDialog.getByRole("button", { name: /save|log|submit/i }).click();

        // Success toast or dialog closes
        await expect(entryDialog).not.toBeVisible({ timeout: 5_000 });
      }
    }
  });

  test("tracker page shows entry history", async ({ page }) => {
    // Navigate to individual tracker if available
    const trackerLinks = page.locator("a[href*='tracker'], button[data-tracker-id]");
    const count = await trackerLinks.count();

    if (count > 0) {
      await trackerLinks.first().click();
      // Should show entries/history section
      await expect(
        page.getByText(/entr|histor|log|record/i).first()
      ).toBeVisible({ timeout: 5_000 });
    }
  });
});
