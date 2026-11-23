// Automatic valuation updates (owner, 2026-11-23): opening an asset checks for
// a current value, the history keeps real moves only, and the profile's graph,
// recent change and projection are arithmetic over what is stored.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest: vi.fn(), BROWSER_TIMEZONE: "UTC" };
});

import { refreshOnOpen, SWEEP_RECHECK_MS } from "@/hooks/useAssetValuation";
import { appendValuationHistory } from "../server/valuation/storage-codec";
import { projectDepreciation, recentChange, seriesInRange, valueSeries } from "@shared/asset-depreciation";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const snap = (over: any = {}) => ({
  record: { status: "valued", value: 300, valuedAt: new Date(NOW - 3_600_000).toISOString(), checkedAt: new Date(NOW - 3_600_000).toISOString() },
  supported: true, inputFingerprint: "fp", mode: "auto", freshness: { fresh: true, reason: null, detail: "" }, ...over,
}) as any;

describe("opening an asset asks for a current value", () => {
  it("a tracked asset not checked in the last few minutes is refreshed, forcing past the server's window", () => {
    expect(refreshOnOpen(snap(), NOW)).toEqual({ refresh: true, force: true });
  });
  it("one checked moments ago is left alone — opening the tab and then the profile asks once", () => {
    const fresh = snap({ record: { status: "valued", value: 300, checkedAt: new Date(NOW - (SWEEP_RECHECK_MS - 1000)).toISOString() } });
    expect(refreshOnOpen(fresh, NOW)).toEqual({ refresh: false, force: false });
  });
  it("a stale one is refreshed without force (the server already agrees)", () => {
    expect(refreshOnOpen(snap({ freshness: { fresh: false, reason: "scheduled", detail: "" } }), NOW)).toEqual({ refresh: true, force: false });
  });
  it("a value the user sets themselves is never re-estimated, and an unsupported record is never asked", () => {
    expect(refreshOnOpen(snap({ mode: "manual" }), NOW).refresh).toBe(false);
    expect(refreshOnOpen(snap({ supported: false }), NOW).refresh).toBe(false);
    expect(refreshOnOpen(null, NOW).refresh).toBe(false);
  });
});

describe("history keeps real moves, not a point per visit", () => {
  const rec = (valuedAt: string, value: number, over: any = {}) => ({
    valuedAt, status: "valued", value, low: value * 0.9, high: value * 1.1, confidence: 0.6,
    methodology: [], inputFingerprint: "fp", refreshReason: "scheduled", ...over,
  }) as any;
  it("an unchanged estimate adds nothing; a changed one adds a point", () => {
    let h = appendValuationHistory([], rec("2026-11-01T00:00:00Z", 300));
    h = appendValuationHistory(h, rec("2026-11-10T00:00:00Z", 300));
    h = appendValuationHistory(h, rec("2026-11-20T00:00:00Z", 300));
    expect(h.map((e) => e.valuedAt)).toEqual(["2026-11-01T00:00:00Z"]); // first seen is kept
    h = appendValuationHistory(h, rec("2026-11-23T00:00:00Z", 280));
    expect(h.map((e) => e.value)).toEqual([300, 280]);
    // Back to an earlier figure is a move too.
    h = appendValuationHistory(h, rec("2026-11-24T00:00:00Z", 300));
    expect(h.map((e) => e.value)).toEqual([300, 280, 300]);
  });
  it("the same run written twice is still one entry", () => {
    const h = appendValuationHistory(appendValuationHistory([], rec("2026-11-01T00:00:00Z", 300)), rec("2026-11-01T00:00:00Z", 300));
    expect(h).toHaveLength(1);
  });
});

describe("the value graph, the latest change and the projection", () => {
  const now = new Date(NOW);
  const history = [
    { valuedAt: "2026-06-01T00:00:00Z", value: 400, status: "valued" },
    { valuedAt: "2026-11-10T00:00:00Z", value: 320, status: "valued" },
    { valuedAt: "2026-11-15T00:00:00Z", value: null, status: "error" },   // not a value
  ];
  it("the series is the purchase, every valuation that produced a value, and today", () => {
    const s = valueSeries({ history, purchasePrice: 899, purchaseDate: "2024-03-02", currentValue: 306, now });
    expect(s.map((p) => p.value)).toEqual([899, 400, 320, 306]);
    expect(s[0].at.slice(0, 10)).toBe("2024-03-02");
  });
  it("a purchase with no calendar date is not placed on the time axis", () => {
    const s = valueSeries({ history, purchasePrice: 899, purchaseDate: "2024", currentValue: 306, now });
    expect(s.map((p) => p.value)).toEqual([400, 320, 306]);
  });
  it("a range starts at its edge with the value held from before it", () => {
    const s = valueSeries({ history, purchasePrice: 899, purchaseDate: "2024-03-02", currentValue: 306, now });
    const month = seriesInRange(s, "1m", now);
    expect(month.map((p) => p.value)).toEqual([400, 320, 306]);          // 400 carried to the edge
    expect(seriesInRange(s, "all", now)).toHaveLength(4);
  });
  it("the latest change is against the last DIFFERENT value", () => {
    const s = valueSeries({ history, currentValue: 306, now });
    expect(recentChange(s)).toMatchObject({ delta: -14, since: "2026-11-10T00:00:00Z" });
    expect(recentChange([{ at: "2026-11-01T00:00:00Z", value: 300 }])).toBeNull();
  });
  it("a projection needs a dated purchase, six months owned and a value that fell", () => {
    const p = projectDepreciation({ purchasePrice: 899, purchaseDate: "2024-03-02", currentValue: 306, now });
    expect(p).not.toBeNull();
    expect(p!.annualRatePct).toBeGreaterThan(20);
    expect(p!.inOneYear).toBeLessThan(306);
    expect(projectDepreciation({ purchasePrice: 899, purchaseDate: null, currentValue: 306, now })).toBeNull();
    expect(projectDepreciation({ purchasePrice: 899, purchaseDate: "2026-09-01", currentValue: 800, now })).toBeNull(); // under six months
    expect(projectDepreciation({ purchasePrice: 300, purchaseDate: "2024-03-02", currentValue: 350, now })).toBeNull(); // it gained
    expect(projectDepreciation({ purchasePrice: 899, purchaseDate: "2025-11-01", currentValue: 20, now })).toBeNull();  // an implausible rate
  });
  it("the projection never goes under the salvage value", () => {
    const p = projectDepreciation({ purchasePrice: 899, purchaseDate: "2024-03-02", currentValue: 306, salvageValue: 290, now });
    expect(p!.inOneYear).toBe(290);
  });
});
