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
import { holdStoredEstimate, isValuationNoise } from "../server/valuation/service";
import { ASSET_SUMMARY_FAST_MODEL, slimAssetSummaryData } from "@shared/asset-summary-prompt";
import { readFileSync } from "node:fs";
import { projectDepreciation, recentChange, seriesInRange, valueSeries } from "@shared/asset-depreciation";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const snap = (over: any = {}) => ({
  record: { status: "valued", value: 300, valuedAt: new Date(NOW - 3_600_000).toISOString(), checkedAt: new Date(NOW - 3_600_000).toISOString() },
  supported: true, inputFingerprint: "fp", mode: "auto", freshness: { fresh: true, reason: null, detail: "" }, ...over,
}) as any;

describe("opening an asset asks for a current value", () => {
  it("a tracked asset not checked in the last day is refreshed, forcing past the server's window", () => {
    const old = snap({ record: { status: "valued", value: 300, checkedAt: new Date(NOW - 25 * 3_600_000).toISOString() } });
    expect(refreshOnOpen(old, NOW)).toEqual({ refresh: true, force: true });
  });
  it("one checked an hour ago is NOT re-researched: an estimate is ~40 s of web research, and the window is a day", () => {
    expect(SWEEP_RECHECK_MS).toBe(24 * 60 * 60_000);
    expect(refreshOnOpen(snap(), NOW)).toEqual({ refresh: false, force: false });
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

describe("research noise is not a change in value", () => {
  const rec = (value: number, over: any = {}) => ({
    status: "valued", value, low: value * 0.9, high: value * 1.1, confidence: 0.9, confidenceLabel: "high",
    valuedAt: "2026-11-23T10:00:00Z", checkedAt: "2026-11-23T10:00:00Z", inputFingerprint: "fp", ...over,
  }) as any;
  it("a move under 2% with the same inputs is noise; 2% and over is a move", () => {
    expect(isValuationNoise(rec(18000), rec(17820))).toBe(true); // 1%
    expect(isValuationNoise(rec(18000), rec(18200))).toBe(true);
    expect(isValuationNoise(rec(18000), rec(17600))).toBe(false); // 2.2%
    expect(isValuationNoise(rec(483), rec(510))).toBe(false);
  });
  it("changed inputs, a first estimate or a failed run are never noise", () => {
    expect(isValuationNoise(rec(18000), rec(17900, { inputFingerprint: "other" }))).toBe(false);
    expect(isValuationNoise(null, rec(17900))).toBe(false);
    expect(isValuationNoise(rec(18000, { status: "error" }), rec(17900))).toBe(false);
    expect(isValuationNoise(rec(18000), rec(17900, { status: "error" }))).toBe(false);
  });
  it("holding keeps the stored figures and their date, with the new run's check time", () => {
    const held = holdStoredEstimate(rec(18000), rec(17820, { valuedAt: "2026-11-24T10:00:00Z", checkedAt: "2026-11-24T10:00:00Z" }));
    expect(held.value).toBe(18000);
    expect(held.low).toBe(16200);
    expect(held.valuedAt).toBe("2026-11-23T10:00:00Z");
    expect(held.checkedAt).toBe("2026-11-24T10:00:00Z");
  });
  it("the refresh applies the rule before deciding whether anything changed", () => {
    const src = readFileSync("server/valuation/service.ts", "utf8");
    const at = src.indexOf("if (isValuationNoise(previous, record))");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf("const changed = record.status"));
  });
});

describe("the asset summary is the small, fast request", () => {
  it("keeps the recent part of each list and every other key", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    const slim = slimAssetSummaryData({ name: "CR-V", fields: { year: 2019 }, documents: many(30), expenses: many(50), timeline: many(40), trackers: [{ name: "Miles", entries: many(15) }], tasks: many(3), events: undefined });
    expect(slim.name).toBe("CR-V");
    expect(slim.fields).toEqual({ year: 2019 });
    expect(slim.documents).toHaveLength(8);
    expect(slim.documents[7]).toEqual({ i: 29 });
    expect(slim.expenses).toHaveLength(20);
    expect(slim.timeline).toHaveLength(8);
    expect(slim.trackers[0].entries).toHaveLength(5);
    expect(slim.tasks).toHaveLength(3);
    expect(slim.events).toEqual([]);
  });
  it("the route uses the fast model and the slim record for an owned thing, never for an account", () => {
    const src = readFileSync("server/routes.ts", "utf8");
    expect(src).toContain("const slim = ASSET_SUMMARY_TYPES.has(detail.type) && !isAccountProfile(detail);");
    expect(src).toContain("process.env.ANTHROPIC_SUMMARY_FAST_MODEL || ASSET_SUMMARY_FAST_MODEL");
    expect(src).toContain("slimAssetSummaryData(profileData)");
    expect(ASSET_SUMMARY_FAST_MODEL).toMatch(/haiku/);
  });
  it("the card says a rewrite is under way while the old text stays", () => {
    const src = readFileSync("client/src/pages/profile-detail.tsx", "utf8");
    expect(src).toContain('{isFetching && <span className="text-[11px] text-primary" data-testid="ai-summary-updating">Updating summary…</span>}');
  });
});
