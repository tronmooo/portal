/**
 * Pure unit tests pinning the canonical shared calculation modules — no
 * server, no network. These are the single-source-of-truth implementations
 * the audit consolidated; if any assertion here changes, every dashboard
 * tile / server endpoint that shows "the same number" changes with it.
 *
 *  (a) shared/asset-value.ts  — resolveAssetValue / resolveLiabilityBalance
 *  (b) shared/obligation-windows.ts — toMonthlyAmount exact fractions
 *  (c) shared/streak.ts — streak semantics (consecutive, gaps, grace, target)
 *  (d) shared/spending-baseline.ts — category sums / totals / anomalies
 */
import { describe, it, expect } from "vitest";
import {
  parseMoney,
  resolveAssetValue,
  resolveLiabilityBalance,
  resolveLiabilityValue,
} from "@shared/asset-value";
import { toMonthlyAmount } from "@shared/obligation-windows";
import { calculateStreak } from "@shared/streak";
import {
  sumByCategory,
  totalSpend,
  detectCategoryAnomalies,
  expenseAmount,
  UNCATEGORIZED,
  type ExpenseLike,
} from "@shared/spending-baseline";

describe("contract: shared calculation parity", () => {
  describe("parseMoney (shared/asset-value.ts)", () => {
    it("parses plain numbers, currency strings, and k/m/b suffixes", () => {
      expect(parseMoney(1234.56)).toBe(1234.56);
      expect(parseMoney("$25,000")).toBe(25000);
      expect(parseMoney("$25k")).toBe(25000);
      expect(parseMoney("40k")).toBe(40000);
      expect(parseMoney("1.2m")).toBe(1_200_000);
      expect(parseMoney(null)).toBe(0);
      expect(parseMoney(undefined)).toBe(0);
      expect(parseMoney("")).toBe(0);
      expect(parseMoney(NaN)).toBe(0);
    });
  });

  describe("resolveAssetValue (shared/asset-value.ts)", () => {
    it("reads top-level camelCase and snake_case fields", () => {
      expect(resolveAssetValue({ currentValue: 50_000 })).toBe(50_000);
      expect(resolveAssetValue({ current_value: 50_000 })).toBe(50_000);
      expect(resolveAssetValue({ estimatedValue: "40k" })).toBe(40_000);
    });

    it("accepts both a bare fields object and a profile with .fields (dual signature)", () => {
      const fields = { housing: { current_value: "$350,000" } };
      expect(resolveAssetValue(fields)).toBe(350_000);
      expect(resolveAssetValue({ id: "p1", type: "property", fields })).toBe(350_000);
    });

    it("walks nested namespaces: housing, other, finance, vehicle, investment", () => {
      expect(resolveAssetValue({ other: { value: "$25k" } })).toBe(25_000);
      expect(resolveAssetValue({ finance: { balance: 1234.56 } })).toBe(1234.56);
      expect(resolveAssetValue({ vehicle: { purchase_price: "18,500" } })).toBe(18_500);
      expect(resolveAssetValue({ vehicles: { currentValue: 9_000 } })).toBe(9_000);
      expect(resolveAssetValue({ investment: { current_value: 77_000 } })).toBe(77_000);
    });

    it("honors documented precedence: currentValue beats purchasePrice; skips non-positive candidates", () => {
      expect(resolveAssetValue({ currentValue: 100, purchasePrice: 999 })).toBe(100);
      expect(resolveAssetValue({ currentValue: 0, purchasePrice: 999 })).toBe(999);
      expect(resolveAssetValue({ marketValue: "$12k", value: 5 })).toBe(12_000);
    });

    it("returns 0 for empty / missing / malformed input", () => {
      expect(resolveAssetValue({})).toBe(0);
      expect(resolveAssetValue(null)).toBe(0);
      expect(resolveAssetValue(undefined)).toBe(0);
      expect(resolveAssetValue({ fields: null })).toBe(0);
      expect(resolveAssetValue({ currentValue: "not a number" })).toBe(0);
    });
  });

  describe("resolveLiabilityBalance (shared/asset-value.ts)", () => {
    it("reads canonical currentBalance first, in both casings and namespaces", () => {
      expect(resolveLiabilityBalance({ currentBalance: 12_000 })).toBe(12_000);
      expect(resolveLiabilityBalance({ current_balance: "$12,000" })).toBe(12_000);
      expect(resolveLiabilityBalance({ finance: { currentBalance: 8_000 } })).toBe(8_000);
      expect(resolveLiabilityBalance({ loan: { remaining_balance: "$8,500" } })).toBe(8_500);
      // currentBalance wins over the generic balance key:
      expect(resolveLiabilityBalance({ currentBalance: 100, balance: 999 })).toBe(100);
    });

    it("accepts a profile with .fields (dual signature)", () => {
      expect(resolveLiabilityBalance({ id: "l1", fields: { outstandingBalance: "22k" } })).toBe(22_000);
    });

    it("sums nested finance.loans[] balances when no scalar balance is present", () => {
      expect(resolveLiabilityBalance({ finance: { loans: [{ balance: 5_000 }, { balance: "2k" }] } })).toBe(7_000);
      // Scalar balance still wins over the loans[] sum:
      expect(resolveLiabilityBalance({ balance: 100, finance: { loans: [{ balance: 5_000 }] } })).toBe(100);
    });

    it("returns 0 for empty input, and resolveLiabilityValue is the same function (server alias)", () => {
      expect(resolveLiabilityBalance({})).toBe(0);
      expect(resolveLiabilityBalance(null)).toBe(0);
      expect(resolveLiabilityValue).toBe(resolveLiabilityBalance);
    });
  });

  describe("toMonthlyAmount (shared/obligation-windows.ts) — EXACT fractions, not 4.33/2.17", () => {
    it("weekly: amount * 52/12 exactly", () => {
      expect(toMonthlyAmount(100, "weekly")).toBe(100 * (52 / 12));
      expect(toMonthlyAmount(100, "week")).toBe(100 * (52 / 12));
      // Not the truncated multiplier:
      expect(toMonthlyAmount(100, "weekly")).not.toBe(433);
    });

    it("biweekly: amount * 26/12 exactly (all spellings)", () => {
      for (const f of ["biweekly", "bi-weekly", "fortnightly", "every-2-weeks"]) {
        expect(toMonthlyAmount(100, f)).toBe(100 * (26 / 12));
      }
      expect(toMonthlyAmount(100, "biweekly")).not.toBe(217);
    });

    it("daily: amount * 365/12 exactly", () => {
      expect(toMonthlyAmount(12, "daily")).toBe(365);
      expect(toMonthlyAmount(1, "day")).toBe(365 / 12);
    });

    it("monthly identity; quarterly /3; semiannual /6; annual /12", () => {
      expect(toMonthlyAmount(100, "monthly")).toBe(100);
      expect(toMonthlyAmount(300, "quarterly")).toBe(100);
      expect(toMonthlyAmount(600, "semi-annual")).toBe(100);
      expect(toMonthlyAmount(1200, "yearly")).toBe(100);
      expect(toMonthlyAmount(1200, "annual")).toBe(100);
    });

    it("string amounts, unknown/missing frequency (treated as monthly), and junk", () => {
      expect(toMonthlyAmount("100", "weekly")).toBe(100 * (52 / 12));
      expect(toMonthlyAmount(100, "custom")).toBe(100);
      expect(toMonthlyAmount(100, null)).toBe(100);
      expect(toMonthlyAmount(100, undefined)).toBe(100);
      expect(toMonthlyAmount(0, "weekly")).toBe(0);
      expect(toMonthlyAmount("not a number", "weekly")).toBe(0);
    });
  });

  describe("calculateStreak (shared/streak.ts)", () => {
    const TODAY = "2026-06-10";

    it("consecutive days through today: current === longest === run length", () => {
      expect(calculateStreak(["2026-06-08", "2026-06-09", "2026-06-10"], { today: TODAY }))
        .toEqual({ current: 3, longest: 3 });
    });

    it("a gap breaks the streak; current counts only the most recent run", () => {
      expect(calculateStreak(["2026-06-05", "2026-06-06", "2026-06-09", "2026-06-10"], { today: TODAY }))
        .toEqual({ current: 2, longest: 2 });
      // Longest run is in the past, current run is shorter:
      expect(calculateStreak(["2026-06-04", "2026-06-05", "2026-06-06", "2026-06-10"], { today: TODAY }))
        .toEqual({ current: 1, longest: 3 });
    });

    it("yesterday counts (one-day grace), but a last check-in 2+ days ago means current = 0", () => {
      expect(calculateStreak(["2026-06-08", "2026-06-09"], { today: TODAY }))
        .toEqual({ current: 2, longest: 2 });
      expect(calculateStreak(["2026-06-06", "2026-06-07"], { today: TODAY }))
        .toEqual({ current: 0, longest: 2 });
    });

    it("targetPerDay: a day only counts when its check-in count reaches the target", () => {
      // 06-10 has 2 check-ins (complete), 06-09 only 1 (incomplete) → streak of 1.
      expect(calculateStreak(["2026-06-10", "2026-06-10", "2026-06-09"], { today: TODAY, targetPerDay: 2 }))
        .toEqual({ current: 1, longest: 1 });
      // Both days hit the target → streak of 2.
      expect(calculateStreak(
        ["2026-06-10", "2026-06-10", "2026-06-09", "2026-06-09"],
        { today: TODAY, targetPerDay: 2 },
      )).toEqual({ current: 2, longest: 2 });
    });

    it("countsByDate pre-aggregation takes precedence over the date list", () => {
      expect(calculateStreak([], {
        today: TODAY,
        targetPerDay: 2,
        countsByDate: { "2026-06-10": 3, "2026-06-09": 1 },
      })).toEqual({ current: 1, longest: 1 });
    });

    it("no check-ins → zero streaks", () => {
      expect(calculateStreak([], { today: TODAY })).toEqual({ current: 0, longest: 0 });
    });
  });

  describe("spending baseline (shared/spending-baseline.ts)", () => {
    const expenses: ExpenseLike[] = [
      { amount: 10, category: "food", date: "2026-06-01" },
      { amount: "5", category: "food", date: "2026-06-03" },
      { amount: 7, category: "gas", date: "2026-06-05" },
      { amount: 3, category: "", date: "2026-06-07" },      // → uncategorized
      { amount: -4, category: "food", date: "2026-05-30" }, // magnitude, previous month
    ];

    it("expenseAmount is the absolute magnitude; junk is 0", () => {
      expect(expenseAmount({ amount: -4 })).toBe(4);
      expect(expenseAmount({ amount: "12.5" })).toBe(12.5);
      expect(expenseAmount({ amount: "junk" })).toBe(0);
      expect(expenseAmount({})).toBe(0);
    });

    it("sumByCategory buckets by category with uncategorized fallback", () => {
      expect(sumByCategory(expenses)).toEqual({
        food: 19, // 10 + 5 + |-4|
        gas: 7,
        [UNCATEGORIZED]: 3,
      });
    });

    it("totalSpend respects the month window (YYYY-MM string prefix, timezone-stable)", () => {
      expect(totalSpend(expenses)).toBe(29);
      expect(totalSpend(expenses, { month: "2026-06" })).toBe(25);
      expect(totalSpend(expenses, { month: "2026-05" })).toBe(4);
      expect(totalSpend(expenses, { sinceDateStr: "2026-06-05" })).toBe(10);
    });

    it("detectCategoryAnomalies flags only above-threshold categories with severity tiers", () => {
      const thresholds = { minBaseline: 10, ratio: 1.5, minAbsDelta: 20, highPctDelta: 75 };
      const baseline = { food: 100, coffee: 2, rent: 100 };
      const current = { food: 200, coffee: 50, rent: 130 };
      const anomalies = detectCategoryAnomalies(current, baseline, thresholds);
      // coffee skipped (baseline 2 < minBaseline 10); rent skipped (130 < 150 ratio gate).
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({ category: "food", current: 200, baseline: 100, pctDelta: 100, severity: "high" });

      // Medium severity when above gates but under highPctDelta:
      const medium = detectCategoryAnomalies({ food: 160 }, { food: 100 }, thresholds);
      expect(medium).toHaveLength(1);
      expect(medium[0].severity).toBe("medium");

      // Categories with current spend but NO baseline history are never flagged:
      expect(detectCategoryAnomalies({ newcat: 500 }, {}, thresholds)).toHaveLength(0);
    });
  });
});
