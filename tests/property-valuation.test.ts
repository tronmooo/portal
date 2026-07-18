// Deterministic canonical valuation estimator — the fix for the "Portol shows a
// long vendor range / different value on every refresh" bug (2103 Alexis Court).
//
// Screenshot B showed Portol reporting ~$1,550,000 with a competing range
// $1,182,000–$1,987,600 (Redfin $1,760,648, Zillow $1,987,600, CoreLogic
// $1,524,300, Collateral Analytics $1,182,000). The headline was chosen by the
// LLM in prose, so it drifted between refreshes. These tests pin the code-side
// estimator so identical evidence always yields ONE stable number.
import { describe, it, expect } from "vitest";
import {
  computeCanonicalValuation,
  roundCanonicalValue,
  resolveSourceWeight,
} from "../shared/property-valuation";

const NOW = new Date("2026-07-18T00:00:00Z");

const alexisCourtSources = [
  { source: "Redfin", value: 1760648, asOf: "2026-07" },
  { source: "Zillow", value: 1987600, asOf: "2026-07" },
  { source: "CoreLogic", value: 1524300, asOf: "2026-07" },
  { source: "Collateral Analytics", value: 1182000, asOf: "2026-07" },
];

describe("computeCanonicalValuation — one canonical number", () => {
  it("returns exactly one value for the 2103 Alexis Court evidence", () => {
    const r = computeCanonicalValuation(alexisCourtSources, { now: NOW })!;
    expect(r).not.toBeNull();
    // Weighted median (institutional AVMs weigh 1.5, portals 1.0) → CoreLogic $1,524,300 → $1,524,000.
    expect(r.value).toBe(1524000);
    expect(r.accepted).toHaveLength(4);
    expect(r.rejected).toHaveLength(0);
    // Spread is retained ONLY as labeled inputs, never as the answer.
    expect(r.spreadLow).toBe(1182000);
    expect(r.spreadHigh).toBe(1987600);
  });

  it("is invariant to source ordering (identical evidence → identical value)", () => {
    const a = computeCanonicalValuation(alexisCourtSources, { now: NOW })!;
    const shuffled = [alexisCourtSources[2], alexisCourtSources[0], alexisCourtSources[3], alexisCourtSources[1]];
    const b = computeCanonicalValuation(shuffled, { now: NOW })!;
    expect(a.value).toBe(b.value);
    expect(a.confidence).toBe(b.confidence);
  });

  it("repeated calls over the same evidence never drift", () => {
    const values = Array.from({ length: 25 }, () =>
      computeCanonicalValuation(alexisCourtSources, { now: NOW })!.value);
    expect(new Set(values).size).toBe(1);
  });

  it("accepts money-like strings for source values", () => {
    const r = computeCanonicalValuation([
      { source: "Zillow", value: "$1,987,600" },
      { source: "Redfin", value: "1,760,648" },
      { source: "CoreLogic", value: "$1,524,300" },
      { source: "Collateral Analytics", value: "1182000" },
    ], { now: NOW })!;
    expect(r.value).toBe(1524000);
  });
});

describe("computeCanonicalValuation — rejects bad inputs deterministically", () => {
  it("rejects invalid (non-positive / non-numeric) estimates", () => {
    const r = computeCanonicalValuation([
      { source: "Zillow", value: 1987600 },
      { source: "Redfin", value: 0 },
      { source: "CoreLogic", value: "n/a" },
      { source: "Collateral Analytics", value: 1524300 },
    ], { now: NOW })!;
    expect(r.accepted.map((a) => a.source).sort()).toEqual(["Collateral Analytics", "Zillow"]);
    expect(r.rejected.some((x) => x.reason === "invalid")).toBe(true);
  });

  it("rejects stale estimates older than the max age window", () => {
    const r = computeCanonicalValuation([
      { source: "Zillow", value: 1987600, asOf: "2026-07" },
      { source: "Redfin", value: 1760648, asOf: "2026-06" },
      { source: "CoreLogic", value: 900000, asOf: "2020-01" }, // stale
    ], { now: NOW, maxAgeMonths: 18 })!;
    expect(r.rejected.some((x) => x.reason === "stale" && x.source === "CoreLogic")).toBe(true);
    expect(r.accepted.some((a) => a.source === "CoreLogic")).toBe(false);
  });

  it("dedupes repeated sources (keeps freshest) and identical values", () => {
    const r = computeCanonicalValuation([
      { source: "Zillow", value: 1900000, asOf: "2026-01" },
      { source: "Zillow", value: 1987600, asOf: "2026-07" }, // fresher wins
      { source: "Redfin", value: 1760648, asOf: "2026-07" },
      { source: "Homes.com", value: 1760648, asOf: "2026-07" }, // duplicate value
    ], { now: NOW })!;
    expect(r.rejected.some((x) => x.reason === "duplicate")).toBe(true);
    const zillow = r.accepted.find((a) => a.source === "Zillow")!;
    expect(zillow.value).toBe(1987600);
    // Only one entry survives for the 1,760,648 value.
    expect(r.accepted.filter((a) => a.value === 1760648)).toHaveLength(1);
  });

  it("rejects gross outliers via the ratio rule", () => {
    const r = computeCanonicalValuation([
      { source: "Zillow", value: 1987600 },
      { source: "Redfin", value: 1760648 },
      { source: "CoreLogic", value: 1524300 },
      { source: "Collateral Analytics", value: 1182000 },
      { source: "SomeBadFeed", value: 175 }, // clearly a per-sqft misparse
    ], { now: NOW })!;
    expect(r.rejected.some((x) => x.reason === "outlier" && x.source === "SomeBadFeed")).toBe(true);
    expect(r.value).toBe(1524000); // unchanged by the outlier
  });

  it("returns null when nothing valid remains", () => {
    expect(computeCanonicalValuation([], { now: NOW })).toBeNull();
    expect(computeCanonicalValuation([{ source: "X", value: 0 }], { now: NOW })).toBeNull();
  });
});

describe("stable rounding + source weighting", () => {
  it("rounds by magnitude deterministically", () => {
    expect(roundCanonicalValue(1524300)).toBe(1524000); // >=100k → nearest $1k
    expect(roundCanonicalValue(20134)).toBe(20100);     // >=10k → nearest $100
    expect(roundCanonicalValue(4237)).toBe(4240);       // >=1k → nearest $10
    expect(roundCanonicalValue(742)).toBe(742);         // <1k → nearest $1
    expect(roundCanonicalValue(0)).toBe(0);
    expect(roundCanonicalValue(-5)).toBe(0);
  });

  it("weights institutional AVMs above portals above unknown sources", () => {
    expect(resolveSourceWeight("CoreLogic").weight).toBeGreaterThan(resolveSourceWeight("Zillow").weight);
    expect(resolveSourceWeight("Zillow").weight).toBeGreaterThan(resolveSourceWeight("Homes.com").weight);
    expect(resolveSourceWeight("SomeRandomBlog").weight).toBe(0.5);
    expect(resolveSourceWeight("zestimate").name).toBe("Zillow");
  });

  it("single high-confidence source is capped at medium confidence", () => {
    const r = computeCanonicalValuation([{ source: "Zillow", value: 1987600 }], { now: NOW })!;
    expect(r.value).toBe(1988000);
    expect(r.confidence).not.toBe("high");
  });
});
