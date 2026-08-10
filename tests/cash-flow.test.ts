// Pins shared/cash-flow.ts — net cash flow across BOTH sides of the ledger.
//
// The load-bearing behaviour: PROJECTED (the month's whole plan) and ACTUAL
// (what really moved) are computed separately and never blended. Reporting
// only projected would let an unpaid future paycheck make the user look richer
// than they are; reporting only actual would hide a month that is on track.

import { describe, it, expect } from "vitest";
import {
  computeCashFlow,
  totalOutflow,
  totalInflow,
  monthBounds,
  describeCashFlow,
  signed,
  type OutflowLine,
} from "@shared/cash-flow";
import { generateIncomeSchedule, type Incomeish } from "@shared/income-schedule";

const TODAY = "2026-08-20";

// $2,000 twice a month = $4,000 · plus $2,000 rent received on the 1st = $6,000.
const incomes: Incomeish[] = [
  { id: "pay", amount: 2000, frequency: "semimonthly", startDate: "2026-01-01" },
  { id: "rent", amount: 2000, frequency: "monthly", startDate: "2026-01-01" },
];

// $4,350 going out: $2,000 mortgage + $350 utilities (both paid), $2,000 more
// due later in the month.
const outflows: OutflowLine[] = [
  { date: "2026-08-01", amount: 2000, settled: true, label: "Mortgage", kind: "bill" },
  { date: "2026-08-05", amount: 350, settled: true, label: "Utilities", kind: "bill" },
  { date: "2026-08-28", amount: 2000, settled: false, label: "Card payment", kind: "liability" },
];

describe("monthBounds", () => {
  it("covers the whole month including a short February", () => {
    expect(monthBounds("2026-08-20")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(monthBounds("2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthBounds("2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });
});

describe("outflow totals", () => {
  it("counts every planned line as projected and only settled ones as actual", () => {
    const t = totalOutflow(outflows);
    expect(t.projected).toBe(4350);
    expect(t.actual).toBe(2350);
    expect(t.outstanding).toBe(2000);
    expect(t.count).toBe(3);
  });

  it("ignores skipped lines on both sides", () => {
    const t = totalOutflow([...outflows, { date: "2026-08-15", amount: 999, settled: false, skipped: true }]);
    expect(t.projected).toBe(4350);
    expect(t.count).toBe(3);
  });
});

describe("inflow totals", () => {
  it("mirrors the outflow shape from generated income occurrences", () => {
    const occ = generateIncomeSchedule(incomes[0], [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-08-31",
    });
    const t = totalInflow(occ);
    expect(t.projected).toBe(4000); // 2 pay dates
    expect(t.actual).toBe(0);       // nothing received yet
    expect(t.outstanding).toBe(4000);
  });
});

describe("the month's net", () => {
  it("$6,000 in against $4,350 out ends August at +$1,650 projected", () => {
    const summary = computeCashFlow({
      start: "2026-08-01", end: "2026-08-31", todayISO: TODAY,
      incomes, outflows,
    });
    expect(summary.income.projected).toBe(6000);
    expect(summary.outgoing.projected).toBe(4350);
    expect(summary.projectedNet).toBe(1650);
  });

  it("keeps actual separate: unreceived pay never counts as money in hand", () => {
    // Only the Aug 1 rent and the Aug 1 paycheck actually landed: $4,000 in.
    const receipts: Record<string, any[]> = {
      pay: [{ id: "r1", occurrenceDate: "2026-08-01", receivedDate: "2026-08-01", amount: 2000 }],
      rent: [{ id: "r2", occurrenceDate: "2026-08-01", receivedDate: "2026-08-01", amount: 2000 }],
    };
    const summary = computeCashFlow({
      start: "2026-08-01", end: "2026-08-31", todayISO: TODAY,
      incomes, receiptsFor: (id) => receipts[id] || [], outflows,
    });
    expect(summary.projectedNet).toBe(1650);              // the plan
    expect(summary.income.actual).toBe(4000);
    expect(summary.outgoing.actual).toBe(2350);
    expect(summary.actualNet).toBe(1650);                 // 4000 − 2350
    expect(summary.remainingToReceive).toBe(2000);
    expect(summary.remainingToPay).toBe(2000);
    // Actual can never exceed what actually happened on either side.
    expect(summary.income.actual).toBeLessThanOrEqual(summary.income.projected);
  });

  it("reports a NEGATIVE net when outgoing beats income — no clamping", () => {
    const summary = computeCashFlow({
      start: "2026-08-01", end: "2026-08-31", todayISO: TODAY,
      incomes: [{ id: "pay", amount: 1000, frequency: "monthly", startDate: "2026-01-05" }],
      outflows: [{ date: "2026-08-10", amount: 2500, settled: true }],
    });
    expect(summary.projectedNet).toBe(-1500);
    // The paycheck's date has passed with nothing received, so it counts
    // toward the plan but NOT toward what actually happened — actual is worse
    // than projected, which is exactly the situation the split exists to show.
    expect(summary.income.actual).toBe(0);
    expect(summary.actualNet).toBe(-2500);
    expect(signed(summary.projectedNet)).toBe("-$1,500");
  });

  it("a skipped income occurrence drops out of the month entirely", () => {
    const summary = computeCashFlow({
      start: "2026-08-01", end: "2026-08-31", todayISO: TODAY,
      incomes: [{
        ...incomes[1],
        fields: { occurrences: { "2026-08-01": { status: "skipped" } } },
      }],
      outflows: [],
    });
    expect(summary.income.projected).toBe(0);
    expect(summary.projectedNet).toBe(0);
  });

  it("counts a three-paycheck month three times, not 2.17 times", () => {
    // Biweekly anchored on Jan 2 2026 lands on Jul 3, Jul 17 and Jul 31 — the
    // kind of month a frequency-annualized average silently gets wrong.
    const summary = computeCashFlow({
      start: "2026-07-01", end: "2026-07-31", todayISO: "2026-07-20",
      incomes: [{ id: "pay", amount: 1000, frequency: "biweekly", startDate: "2026-01-02" }],
      outflows: [],
    });
    expect(summary.income.count).toBe(3);
    expect(summary.income.projected).toBe(3000);
  });

  it("phrases both numbers in one line", () => {
    const summary = computeCashFlow({
      start: "2026-08-01", end: "2026-08-31", todayISO: TODAY,
      incomes: [{ id: "pay", amount: 2470, frequency: "monthly", startDate: "2026-08-01" }],
      receiptsFor: () => [{ id: "r", occurrenceDate: "2026-08-01", receivedDate: "2026-08-01", amount: 2470 }],
      outflows: [{ date: "2026-08-02", amount: 1650, settled: true }],
    });
    expect(describeCashFlow(summary, "August"))
      .toBe("Projected August net: +$820 · Actual so far: +$820");
  });
});
