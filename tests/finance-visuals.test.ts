// Pure helpers behind the Finance visuals (donut slices, period bars, KPI
// deltas, axis ticks). The components only render what these return.
import { describe, it, expect } from "vitest";
import {
  rankSlices, breakdownSlices, periodLabel, monthTitle, periodPoints, trendMonths,
  singleCurrency, pctChange, axisDollars, firstChangePct, OTHER_KEY, CATEGORY_PALETTE, OTHER_HS,
} from "../client/src/components/finance/finance-visuals";
import type { BreakdownRow } from "../shared/finance-calc";

const row = (key: string, amount: number, currency = "usd", extra: Partial<BreakdownRow> = {}): BreakdownRow =>
  ({ key, label: key, amount, currency, count: 1, sharePct: null, ...extra } as BreakdownRow);

describe("rankSlices", () => {
  it("ranks highest first with shares that sum to 100", () => {
    const { slices, total } = rankSlices([
      { key: "a", label: "A", amount: 10 },
      { key: "b", label: "B", amount: 30 },
      { key: "c", label: "C", amount: 60 },
    ]);
    expect(total).toBe(100);
    expect(slices.map((s) => s.key)).toEqual(["c", "b", "a"]);
    expect(slices.map((s) => s.share)).toEqual([60, 30, 10]);
    expect(slices[0].hs).toBe(CATEGORY_PALETTE[0]);
  });

  it("folds the tail past max-1 into one grey Other slice", () => {
    const items = [50, 40, 30, 20, 10].map((amount, i) => ({ key: `k${i}`, label: `L${i}`, amount }));
    const { slices, total } = rankSlices(items, { max: 3 });
    expect(total).toBe(150);
    expect(slices).toHaveLength(3);
    const other = slices[2];
    expect(other.key).toBe(OTHER_KEY);
    expect(other.isOther).toBe(true);
    expect(other.hs).toBe(OTHER_HS);
    expect(other.amount).toBe(60);
    expect(other.label).toBe("Other (3)");
  });

  it("drops non-positive and non-finite amounts, and is empty when nothing is left", () => {
    expect(rankSlices([{ key: "r", label: "Refund", amount: -5 }, { key: "n", label: "N", amount: NaN }]))
      .toEqual({ slices: [], total: 0 });
  });

  it("orders ties by label so the ranking is stable", () => {
    const { slices } = rankSlices([
      { key: "z", label: "Zed", amount: 5 },
      { key: "a", label: "Alpha", amount: 5 },
    ]);
    expect(slices.map((s) => s.key)).toEqual(["a", "z"]);
  });
});

describe("breakdownSlices", () => {
  it("shows the currency with the most rows and reports the others (no conversion)", () => {
    const r = breakdownSlices([row("food", 500), row("rent", 2000), row("travel", 900, "eur")]);
    expect(r.currency).toBe("usd");
    expect(r.total).toBe(2500);
    expect(r.slices.map((s) => s.key)).toEqual(["rent", "food"]);
    expect(r.otherCurrencies).toEqual(["eur"]);
  });

  it("is empty with no rows", () => {
    expect(breakdownSlices([])).toEqual({ currency: null, slices: [], total: 0, otherCurrencies: [] });
  });
});

describe("period labels", () => {
  it("labels months and ISO weeks", () => {
    expect(periodLabel("2026-10")).toBe("Oct");
    expect(periodLabel("2026-W07")).toBe("W7");
    expect(periodLabel("groceries")).toBe("groceries");
    expect(monthTitle("2026-03-01")).toBe("Mar 2026");
    expect(monthTitle(null)).toBeNull();
  });

  it("periodPoints sorts oldest first in one currency", () => {
    const r = periodPoints([row("2026-10", 300), row("2026-08", 100), row("2026-09", 200), row("2026-09", 999, "eur")]);
    expect(r.currency).toBe("usd");
    expect(r.points).toEqual([
      { label: "Aug", value: 100 }, { label: "Sep", value: 200 }, { label: "Oct", value: 300 },
    ]);
  });
});

describe("trendMonths", () => {
  it("lays out January to now for this year", () => {
    expect(trendMonths("year", "2026-03-15")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });
  it("lays out the last six months across a year boundary for all time", () => {
    expect(trendMonths("all", "2026-02-10")).toEqual(["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"]);
  });
  it("has no trend for short ranges or a bad date", () => {
    expect(trendMonths("month", "2026-02-10")).toEqual([]);
    expect(trendMonths("30d", "2026-02-10")).toEqual([]);
    expect(trendMonths("year", "garbage")).toEqual([]);
  });
});

describe("KPI helpers", () => {
  it("singleCurrency only answers for exactly one currency", () => {
    expect(singleCurrency({ usd: 1200 })).toEqual({ currency: "usd", amount: 1200 });
    expect(singleCurrency({ usd: 1, eur: 2 })).toBeNull();
    expect(singleCurrency({})).toBeNull();
    expect(singleCurrency(null)).toBeNull();
  });

  it("pctChange needs a positive base", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(50, 0)).toBeNull();
    expect(pctChange(null, 100)).toBeNull();
  });

  it("firstChangePct rounds the first currency's change", () => {
    expect(firstChangePct({ usd: 12.6 })).toBe(13);
    expect(firstChangePct({ usd: null })).toBeNull();
    expect(firstChangePct(undefined)).toBeNull();
  });

  it("axisDollars abbreviates thousands through the shared formatter", () => {
    expect(axisDollars(800)).toBe("$800");
    expect(axisDollars(1000)).toBe("$1k");
    expect(axisDollars(1500)).toBe("$1.5k");
    expect(axisDollars(12_400)).toBe("$12k");
    expect(axisDollars(-1500)).toBe("-$1.5k");
  });
});
