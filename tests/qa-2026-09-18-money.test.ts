// tests/qa-2026-09-18-money.test.ts
//
// QA 2026-09-18, money findings (net worth, income, assets, expenses).
//
//   • F-10  the "this month" net-worth delta is measured against a real
//           30-day baseline rebuilt from the items themselves — an asset that
//           merely got ENTERED inside the window is not a monthly gain.
import { describe, it, expect } from "vitest";
import { netWorthChange, reconstructNetWorthBaseline, itemValueAt, acquisitionDateOf } from "@shared/net-worth-change";

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
