/**
 * Rules 12 & 15 — finance totals over the manual `expenses` ledger come from
 * ONE shared calc (shared/expense-ledger), and the savings rate has one
 * definition: (income − spend) / income, null when income ≤ 0.
 */
import { describe, it, expect } from "vitest";
import {
  sumExpenses, monthlySpend, spendByCategory, savingsRate, savingsRatePct,
  filterLedger, rowsInMonth, LEDGER_MANUAL, LEDGER_CONNECTED,
} from "@shared/expense-ledger";
import { financialSnapshot } from "../server/ai-financial-snapshot";

const rows = [
  { id: "a", amount: 100, category: "food", date: "2026-09-01", linkedProfiles: ["self"] },
  { id: "b", amount: 50.5, category: "food", date: "2026-09-15", linkedProfiles: ["self"] },
  { id: "c", amount: 200, category: "transport", date: "2026-08-30", linkedProfiles: ["kid"] },
  { id: "d", amount: -20, category: "food", date: "2026-09-16", linkedProfiles: ["self"] }, // refund
  { id: "e", amount: "35", category: "", date: "2026-09-20T10:00:00Z", linkedProfiles: [] },
  { id: "f", amount: 9, category: "food", date: "2026-09-21", linkedProfiles: ["self"], isTestData: true },
];

describe("sumExpenses / monthlySpend", () => {
  it("sums signed amounts exactly like the inline reduces did", () => {
    expect(sumExpenses(rows)).toBeCloseTo(374.5, 6);
    expect(sumExpenses([])).toBe(0);
    expect(sumExpenses(null)).toBe(0);
  });

  it("filters by inclusive date bounds, owner and test-data flag", () => {
    expect(sumExpenses(rows, { from: "2026-09-01", to: "2026-09-15" })).toBeCloseTo(150.5, 6);
    expect(sumExpenses(rows, { ownerIds: ["kid"] })).toBe(200);
    expect(sumExpenses(rows, { includeTestData: false })).toBeCloseTo(365.5, 6);
    expect(filterLedger(rows, { ownerIds: ["self"] }).map((r) => r.id)).toEqual(["a", "b", "d", "f"]);
  });

  it("monthlySpend is the month's rows through the same sum", () => {
    expect(rowsInMonth(rows, "2026-09").map((r) => r.id)).toEqual(["a", "b", "d", "e", "f"]);
    expect(monthlySpend(rows, "2026-09")).toBeCloseTo(174.5, 6);
    expect(monthlySpend(rows, "2026-09")).toBe(sumExpenses(rowsInMonth(rows, "2026-09")));
    expect(monthlySpend(rows, "2026-08")).toBe(200);
    expect(monthlySpend(rows, "2026-07")).toBe(0);
  });
});

describe("spendByCategory", () => {
  it("buckets by the caller's key function; blank categories fall to general", () => {
    expect(spendByCategory(rows)).toEqual({ food: 139.5, transport: 200, general: 35 });
    const upper = spendByCategory(rows, { keyOf: (c) => String(c || "other").toUpperCase(), from: "2026-09-01" });
    expect(upper).toEqual({ FOOD: 139.5, OTHER: 35 });
  });
});

describe("savingsRate — one definition", () => {
  it("(income − spend) / income; null when income ≤ 0", () => {
    expect(savingsRate(1000, 250)).toBeCloseTo(0.75, 9);
    expect(savingsRate(1000, 1200)).toBeCloseTo(-0.2, 9);
    expect(savingsRate(0, 100)).toBeNull();
    expect(savingsRate(-5, 0)).toBeNull();
    expect(savingsRatePct(1000, 250)).toBe(75);
    expect(savingsRatePct(3000, 1234)).toBe(59);
    expect(savingsRatePct(0, 0)).toBeNull();
  });
});

describe("the AI financial snapshot reports the manual ledger through the shared calc", () => {
  it("thisMonthSpend equals monthlySpend and the payload says which ledger it is", () => {
    const snap = financialSnapshot({
      allProfiles: [],
      obligations: [],
      expenses: rows,
      timezone: "UTC",
    });
    // The month is the caller's current month; compare against the shared calc for that same month.
    expect(snap.thisMonthSpend).toBe(monthlySpend(rows, snap.month));
    expect(snap.ledger).toBe(LEDGER_MANUAL);
    expect(LEDGER_MANUAL).not.toBe(LEDGER_CONNECTED);
  });
});
