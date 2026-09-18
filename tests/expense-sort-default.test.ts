import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { sortExpenses } from "@shared/expense-view";

/**
 * Regression guard for "expenses should always start out as the most recent
 * expenses in chronological order" (2026-09-18).
 *
 * The list already defaulted to `date-desc`, but the chosen sort was persisted
 * in localStorage — so once the user picked "Amount: high → low" the Expenses
 * list opened amount-sorted on every later visit ($1,200 Tires from Aug 11 on
 * top of yesterday's payment). The fix stops restoring the sort from storage:
 * the page always mounts on newest-first, while category and date range stay
 * persisted.
 */
const FINANCE = join(process.cwd(), "client/src/pages/finance.tsx");

describe("expenses open on newest first", () => {
  it("sortBy initializes to date-desc without reading localStorage", () => {
    const src = readFileSync(FINANCE, "utf8");
    const line = src
      .split("\n")
      .find((l) => l.includes("useState<ExpenseSort>"));
    expect(line, "sortBy useState<ExpenseSort> initializer not found").toBeTruthy();
    expect(line!).toContain('"date-desc"');
    expect(
      line!.includes("localStorage"),
      "sortBy must not be restored from localStorage — the list has to open newest-first every time",
    ).toBe(false);
  });

  it("does not persist the chosen sort back to localStorage", () => {
    const src = readFileSync(FINANCE, "utf8");
    expect(
      /setItem\(\s*["']portol_exp_sort["']/.test(src),
      "the expense sort must not be written to localStorage",
    ).toBe(false);
  });

  it("date-desc really orders newest first", () => {
    const rows = [
      { description: "Tires", amount: 1200, date: "2026-08-11" },
      { description: "Dodge Ram 2025 Auto Loan payment", amount: 912.4, date: "2026-09-17" },
      { description: "Auto Insurance", amount: 186.42, date: "2026-08-15" },
    ];
    expect(sortExpenses(rows, "date-desc").map((r) => r.date)).toEqual([
      "2026-09-17",
      "2026-08-15",
      "2026-08-11",
    ]);
  });
});
