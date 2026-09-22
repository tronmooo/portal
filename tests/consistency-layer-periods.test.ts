// Consistency layer — financial periods, test data (req. tests 10, 11, 18).
import { describe, expect, it } from "vitest";
import {
  periodTotals, monthPeriodOf, currentMonthActual, ledgerItemFromExpense, ledgerBucketOf,
  dataEnvironmentOf, forEnvironment, markAsTestData, isTestRecord,
} from "../shared/domain";

const today = "2026-09-22";
const items = [
  ledgerItemFromExpense({ description: "Groceries", amount: 120, date: "2026-09-10" }),
  ledgerItemFromExpense({ description: "Internet Bill", amount: 80, date: "2026-10-12" }),
  ledgerItemFromExpense({ description: "Phone Bill", amount: 65, date: "2026-09-28" }),
  { date: "2026-09-25", amount: 912.4, status: "scheduled" as const },
  { date: "2026-09-30", amount: 200, status: "projected" as const },
  { date: "2026-09-20", amount: 40, status: "pending" as const },
];

describe("10. Future expenses are excluded from current-month actual spending", () => {
  it("an Internet bill dated Oct 12 does not count toward September, and a future-dated September row is not actual", () => {
    const t = periodTotals(items, { todayISO: today, period: monthPeriodOf(today) });
    expect(t.actual).toBe(120);
    expect(t.pending).toBe(40);
    expect(currentMonthActual(items, today)).toBe(120);
    expect(ledgerBucketOf({ date: "2026-09-28", amount: 65 }, today)).toBe("scheduled");
  });
});

describe("11. Future scheduled expenses appear only in forecast totals", () => {
  it("scheduled and forecast are separate from actual and never merged silently", () => {
    const t = periodTotals(items, { todayISO: today, period: monthPeriodOf(today) });
    expect(t.scheduled).toBe(912.4 + 65);
    expect(t.forecast).toBe(200);
    expect(t.committed).toBe(160);
    expect(t.projected).toBe(160 + 912.4 + 65 + 200);
    expect(t.counts).toEqual({ actual: 1, pending: 1, scheduled: 2, forecast: 1 });
  });
});

describe("18. QA/test records are excluded from production totals", () => {
  it("flagged, tagged and name-pattern test rows all resolve to the test environment", () => {
    expect(dataEnvironmentOf({ name: "QA Phone Bill" })).toBe("test");
    expect(dataEnvironmentOf({ name: "Phone Bill", isTestData: true })).toBe("test");
    expect(dataEnvironmentOf({ name: "Phone Bill", tags: ["env:test"] })).toBe("test");
    expect(dataEnvironmentOf({ name: "Phone Bill", environment: "demo" })).toBe("demo");
    expect(dataEnvironmentOf({ name: "Phone Bill" })).toBe("production");
    expect(isTestRecord(markAsTestData({ name: "Phone Bill" }))).toBe(true);
  });
  it("production totals leave test rows out unless explicitly asked", () => {
    const rows = [
      { name: "Phone Bill", date: "2026-09-10", amount: 65 },
      markAsTestData({ name: "QA Phone Bill", date: "2026-09-15", amount: 999 }),
    ];
    expect(forEnvironment(rows).map((r) => r.name)).toEqual(["Phone Bill"]);
    expect(forEnvironment(rows, { includeTest: true })).toHaveLength(2);
    const ledger = rows.map((r) => ({ date: r.date, amount: r.amount, isTestData: isTestRecord(r) }));
    expect(periodTotals(ledger, { todayISO: today, period: monthPeriodOf(today) }).actual).toBe(65);
    expect(periodTotals(ledger, { todayISO: today, period: monthPeriodOf(today), includeTestData: true }).actual).toBe(1064);
  });
});
