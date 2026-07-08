// Button-inventory guard for the hub tabs. A live Playwright click-through
// isn't viable in this sandbox (no @playwright/test, no local backend — the
// smoke suite hits the deployed portol.me with credentials), so button
// behavior is proven two ways: the jsdom render tests (money-overview /
// wellness-overview) assert the primary buttons fire their callbacks, and THIS
// test guards that every critical action testid still exists in source — so an
// action can never silently lose its automation/QA hook.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

// file → the testids that MUST exist in it (the interactive controls QA and the
// AI-parity effort rely on being able to find/drive).
const REQUIRED: Record<string, string[]> = {
  "client/src/pages/dashboard.tsx": [
    "stat-card-open-tasks", "stat-card-monthly-spend", "stat-card-habits-today",
    "stat-card-journal-streak", "stat-card-expiring-docs",
    "fw-drill-spending", "fw-drill-income", "fw-drill-cashflow", "fw-drill-networth",
    "btn-customize",
  ],
  "client/src/components/finance/MoneyOverview.tsx": [
    "money-networth", "money-cashflow", "money-spend", "money-add-expense",
    "money-budgets-header", "money-asset-", "money-liability-", "money-pay-",
  ],
  "client/src/components/wellness/WellnessOverview.tsx": [
    "wellness-kpi-score", "wellness-habit-", "wellness-med-toggle-",
    "wellness-log-hydration", "wellness-log-weight", "wellness-log-sleep",
    "wellness-log-mood", "wellness-log-steps",
  ],
  "client/src/components/dashboard/TaskHabitPopups.tsx": [
    "button-add-task", "btn-new-habit-add",
  ],
  "client/src/components/dashboard/HeroKPIPopups.tsx": [
    "budget-add-submit",
  ],
  "client/src/components/dashboard/quick-add/QuickAddDialog.tsx": [
    "btn-quick-add-",
  ],
};

describe("hub button inventory", () => {
  for (const [file, ids] of Object.entries(REQUIRED)) {
    it(`${file.split("/").pop()} exposes its action testids`, () => {
      const src = read(file);
      // The id may appear as data-testid="id", data-testid={`id-${x}`}, or be
      // passed to a wrapper via testId="id" — a plain substring match confirms
      // the (distinctive) hook still exists regardless of which form is used.
      const missing = ids.filter((id) => !src.includes(id));
      expect(missing, `${file} missing testids: ${missing.join(", ")}`).toEqual([]);
    });
  }
});
