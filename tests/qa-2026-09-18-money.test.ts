// tests/qa-2026-09-18-money.test.ts
//
// QA 2026-09-18, money findings (net worth, income, assets, expenses).
//
//   • F-10  the "this month" net-worth delta is measured against a real
//           30-day baseline rebuilt from the items themselves — an asset that
//           merely got ENTERED inside the window is not a monthly gain.
//   • F-11  an income record is the authority for its amount on the calendar;
//           an "income" recurring date typed onto the calendar no longer wins.
//   • F-13  INCOME · MTD counts a stream only once its pay day has arrived.
//   • F-14  an expected paycheck a received twin covers is satisfied, not
//           overdue, and an identical paycheck is not created twice.
import { describe, it, expect } from "vitest";
import { netWorthChange, reconstructNetWorthBaseline, itemValueAt, acquisitionDateOf } from "@shared/net-worth-change";
import { dedupeSeries, type CalendarSeries } from "@shared/calendar-occurrences";
import { seriesFromIncomes } from "@shared/calendar-adapters";
import {
  sumMonthlyIncomeForMonth, sumMonthIncome, latePaychecks, paycheckStatus, findDuplicatePaycheck, isSatisfiedExpectedPaycheck,
} from "@shared/obligation-windows";

describe("F-11 one amount per income source", () => {
  const owner = "p-self";
  const incomeRecord = seriesFromIncomes([{ id: "inc1", description: "Northwind Logistics", amount: 95_000, frequency: "yearly", date: "2026-01-15", linkedProfiles: [owner] }])[0];
  const typedRule: CalendarSeries = {
    id: "event:e1", kind: "income", title: "Northwind Logistics", baseDate: "2026-01-15", recurrence: "yearly", amount: 105_000,
    source: { system: "event", id: "e1", profileId: owner, ownerIds: [owner] } as any,
  };

  it("the Finance income record wins the merge whichever was adapted first", () => {
    for (const order of [[typedRule, incomeRecord], [incomeRecord, typedRule]]) {
      const merged = dedupeSeries(order);
      expect(merged).toHaveLength(1);
      expect(merged[0].series.source.system).toBe("income");
      expect(merged[0].series.amount).toBe(95_000);
      expect(merged[0].duplicateIds).toEqual(["event:e1"]);
    }
  });
});

describe("F-13 INCOME · MTD only counts income received by today", () => {
  const streams = [
    { description: "Monthly Paycheck", amount: 1_000, frequency: "monthly", date: "2026-09-30" },
    { description: "Salary", amount: 3_000, frequency: "monthly", date: "2026-06-01" },
    { description: "Bonus", amount: 500, frequency: "once", date: "2026-09-25" },
  ];
  it("a stream whose first pay day is still ahead is not income yet", () => {
    expect(sumMonthlyIncomeForMonth(streams, "2026-09", "2026-09-18")).toBe(3_000);
    expect(sumMonthlyIncomeForMonth(streams, "2026-09", "2026-09-30")).toBe(4_500);
  });
  it("a whole past month is unchanged", () => {
    expect(sumMonthlyIncomeForMonth(streams, "2026-09")).toBe(4_500);
    expect(sumMonthlyIncomeForMonth(streams, "2026-10")).toBe(4_000);
  });
  it("received paychecks still count in the to-date figure", () => {
    expect(sumMonthIncome(streams, [{ confirmed: true, received_date: "2026-09-09", amount: 2_000 }], "2026-09", "2026-09-18")).toBe(5_000);
  });
});

describe("F-14 a received twin satisfies an expected paycheck", () => {
  const received = { id: "a", source: "Employer", amount: 2_000, expected_date: "2026-09-09", confirmed: true, received_date: "2026-09-09" };
  const expected = { id: "b", source: "Monthly Income", amount: 2_000, expected_date: "2026-09-09", confirmed: false };
  const other = { id: "c", source: "Side gig", amount: 400, expected_date: "2026-09-10", confirmed: false };
  const all = [received, expected, other];

  it("is not late and reads as covered", () => {
    expect(isSatisfiedExpectedPaycheck(expected, all)).toBe(true);
    expect(latePaychecks(all, "2026-09-18").map((p) => p.id)).toEqual(["c"]);
    expect(paycheckStatus(expected, all, "2026-09-18")).toBe("satisfied");
    expect(paycheckStatus(other, all, "2026-09-18")).toBe("overdue");
    expect(paycheckStatus(received, all, "2026-09-18")).toBe("received");
    expect(paycheckStatus({ ...other, expected_date: "2026-09-25" }, all, "2026-09-18")).toBe("upcoming");
  });
  it("a different amount or day is a different deposit", () => {
    expect(isSatisfiedExpectedPaycheck({ ...expected, amount: 2_100 }, all)).toBe(false);
    expect(isSatisfiedExpectedPaycheck({ ...expected, expected_date: "2026-09-10" }, all)).toBe(false);
  });
  it("creating an identical paycheck finds the existing row", () => {
    expect(findDuplicatePaycheck(all, { source: " employer ", amount: 2000, expected_date: "2026-09-09T00:00:00Z" })?.id).toBe("a");
    expect(findDuplicatePaycheck(all, { source: "Employer", amount: 2000, expected_date: "2026-09-23" })).toBeNull();
  });
});

describe("F-10 net-worth change: a young snapshot table is not a monthly gain", () => {
  const today = "2026-09-18";
  const cutoff = "2026-08-19";

  it("long-held assets entered this month baseline at their first known value, not 0", () => {
    // The $1.6M household: every asset was entered on Sep 16, no valuation
    // history, no purchase dates. The two-day-old snapshot table cannot
    // supply a 30-day row.
    const items = [
      { value: 1_200_000, createdAt: "2026-09-16T10:00:00Z" },
      { value: 400_000, createdAt: "2026-09-16T10:05:00Z" },
      { value: 8_127, createdAt: "2026-09-16T10:06:00Z" },
    ];
    const baseline = reconstructNetWorthBaseline(items, cutoff, null);
    expect(baseline).toEqual({ date: cutoff, netWorth: 1_608_127, reconstructed: true });
    const c = netWorthChange([{ snapshotDate: "2026-09-16", netWorth: 119_874 }], 1_608_127, today, baseline);
    expect(c!.monthly).toBe(true);
    expect(c!.delta).toBe(0);
    expect(c!.pct).toBe(0);
  });

  it("a $75 profile whose first snapshot row was 0 reads no gain", () => {
    const baseline = reconstructNetWorthBaseline([{ value: 75, createdAt: "2026-09-17T00:00:00Z" }], cutoff, null);
    const c = netWorthChange([{ snapshotDate: "2026-09-16", netWorth: 0 }, { snapshotDate: "2026-09-17", netWorth: 75 }], 75, today, baseline);
    expect(c!.delta).toBe(0);
    expect(c!.monthly).toBe(true);
  });

  it("an asset genuinely acquired inside the window does count", () => {
    const items = [
      { value: 100_000, createdAt: "2026-09-16T00:00:00Z" },
      { value: 30_000, createdAt: "2026-09-16T00:00:00Z", acquiredOn: "2026-09-10" },
    ];
    const baseline = reconstructNetWorthBaseline(items, cutoff, null)!;
    expect(baseline.netWorth).toBe(100_000);
    const c = netWorthChange([], 130_000, today, baseline)!;
    expect(c.delta).toBe(30_000);
    expect(c.pct).toBeCloseTo(30, 6);
  });

  it("a stored row is corrected for items entered after it was written", () => {
    // Row from Aug 1 knew about $50k; a $200k house entered Sep 16 (bought
    // 2019) and a $20k loan entered the same day were not in it.
    const stored = { snapshotDate: "2026-08-01", netWorth: 50_000 };
    const items = [
      { value: 50_000, createdAt: "2026-07-01T00:00:00Z" },
      { value: 200_000, createdAt: "2026-09-16T00:00:00Z", acquiredOn: "2019-05-01" },
      { value: 20_000, sign: -1 as const, createdAt: "2026-09-16T00:00:00Z" },
    ];
    const baseline = reconstructNetWorthBaseline(items, cutoff, stored)!;
    expect(baseline).toEqual({ date: "2026-08-01", netWorth: 230_000, reconstructed: true });
    const c = netWorthChange([{ snapshotDate: "2026-08-01", netWorth: 50_000 }], 231_000, today, baseline)!;
    expect(c.delta).toBe(1_000);
    expect(c.monthly).toBe(true);
  });

  it("a stored row that already knew every item is used as-is", () => {
    const stored = { snapshotDate: "2026-08-01", netWorth: 50_000 };
    const baseline = reconstructNetWorthBaseline([{ value: 55_000, createdAt: "2026-07-01T00:00:00Z" }], cutoff, stored)!;
    expect(baseline).toEqual({ date: "2026-08-01", netWorth: 50_000, reconstructed: false });
  });

  it("valuation history on or before the cutoff is the item's value then", () => {
    const item = {
      value: 1_150,
      history: [
        { date: "2026-09-01T00:00:00Z", value: 1_330 },
        { date: "2026-08-10T00:00:00Z", value: 1_400 },
        { date: "2026-07-01T00:00:00Z", value: null },
      ],
    };
    expect(itemValueAt(item, cutoff)).toBe(1_400);
    // Only history AFTER the cutoff → its first known value, not today's.
    expect(itemValueAt({ value: 1_150, history: [{ date: "2026-09-01", value: 1_330 }] }, cutoff)).toBe(1_330);
    // Acquired after the cutoff → nothing at the cutoff.
    expect(itemValueAt({ value: 1_150, acquiredOn: "2026-09-02" }, cutoff)).toBe(0);
  });

  it("reads the purchase date from the usual field spellings", () => {
    expect(acquisitionDateOf({ purchaseDate: "2019-05-01" })).toBe("2019-05-01");
    expect(acquisitionDateOf({ vehicle: { purchase_date: "2024-02-10T00:00:00Z" } })).toBe("2024-02-10");
    expect(acquisitionDateOf({ housing: { closingDate: "2021-11-30" } })).toBe("2021-11-30");
    expect(acquisitionDateOf({ purchaseDate: "soon" })).toBeNull();
    expect(acquisitionDateOf(null)).toBeNull();
  });

  it("without a server baseline, a delta from a young row is not labelled monthly", () => {
    const c = netWorthChange([{ snapshotDate: "2026-09-16", netWorth: 119_874 }], 1_608_127, today)!;
    expect(c.monthly).toBe(false);
    expect(c.pct).toBeNull();
    expect(c.baselineDate).toBe("2026-09-16");
  });
});
