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
    // 2026-07-10 dynamic redesign: the five quick-log buttons render from one
    // template literal (`wellness-quicklog-${kind}`), so the guard matches the
    // shared prefix + the onQuickLog hook that drives all of them.
    "wellness-quicklog-", "onQuickLog",
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

// ── Per-row busy gating ──────────────────────────────────────────────────────
// A list of rows sharing ONE mutation must not share ONE busy flag. Gating a
// per-row button on `someMutation.isPending` disables EVERY row while a single
// write is in flight — the "I marked one habit done, it wouldn't let me mark
// the second" report (2026-07-25). These surfaces now gate on usePendingIds();
// this guard keeps the shared-flag form from creeping back in.
const ROW_ACTION_FILES = [
  "client/src/components/dashboard/TaskHabitPopups.tsx",
  "client/src/components/dashboard/BriefingPopups.tsx",
  "client/src/components/ProfileSharedTabs.tsx",
];

describe("per-row action buttons stay independently tappable", () => {
  for (const file of ROW_ACTION_FILES) {
    it(`${file.split("/").pop()} gates row actions per id, not on a shared isPending`, () => {
      const src = read(file);
      expect(src).toContain("usePendingIds");
      // Row-level toggles/logs must not be disabled by a whole-list flag.
      const shared = [...src.matchAll(/disabled=\{(\w+)\.isPending\}/g)].map(m => m[1]);
      const rowMutations = ["toggleMutation", "checkinMutation", "deleteCheckinMutation",
        "payBill", "skipBill", "updateGoal", "dismiss", "undoMutation"];
      const leaked = shared.filter(name => rowMutations.includes(name));
      expect(leaked, `${file} gates row buttons on shared isPending: ${leaked.join(", ")}`).toEqual([]);
    });
  }

  it("the habits popup exposes a per-habit toggle hook", () => {
    const src = read("client/src/components/dashboard/TaskHabitPopups.tsx");
    expect(src).toContain("habit-toggle-");
  });
});
