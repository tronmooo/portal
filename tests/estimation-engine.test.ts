// Pins the deterministic normalization + estimation engine
// (shared/estimation-engine.ts): unit conversion, exact derivations vs
// labeled estimates, provenance/confidence/assumptions, profile-based
// hierarchy (personal history > height > population default), and the rule
// that explicit user values are NEVER overwritten.
import { describe, it, expect } from "vitest";
import {
  enrichWalkRunEntry,
  enrichHydrationEntry,
  enrichSleepEntry,
  derivePersonalMetrics,
  parseHeightToCm,
  parseWeightToKg,
  convertDistanceToMeters,
  convertVolumeToMl,
  convertWeightToKg,
  calculateDurationFromTimes,
  estimateStrideMeters,
  summarizeEnrichment,
  MIN_SAVE_CONFIDENCE,
  METERS_PER_MILE,
} from "@shared/estimation-engine";

describe("unit conversion", () => {
  it("distance to canonical meters", () => {
    expect(convertDistanceToMeters(1, "mile")).toBeCloseTo(1609.344, 2);
    expect(convertDistanceToMeters(2, "km")).toBe(2000);
    expect(convertDistanceToMeters(100, "m")).toBe(100);
    expect(convertDistanceToMeters(1, "banana")).toBeNull();
  });
  it("volume to canonical ml", () => {
    expect(convertVolumeToMl(32, "oz")).toBeCloseTo(946.35, 1);
    expect(convertVolumeToMl(1, "l")).toBe(1000);
    expect(convertVolumeToMl(2, "cups")).toBeCloseTo(473.18, 1);
  });
  it("weight to canonical kg", () => {
    expect(convertWeightToKg(180, "lbs")).toBeCloseTo(81.65, 1);
    expect(convertWeightToKg(80, "kg")).toBe(80);
  });
  it("height parsing", () => {
    expect(parseHeightToCm("5'10")).toBeCloseTo(177.8, 1);
    expect(parseHeightToCm("178 cm")).toBe(178);
    expect(parseHeightToCm("70 in")).toBeCloseTo(177.8, 1);
    expect(parseHeightToCm(178)).toBe(178);
    expect(parseHeightToCm(70)).toBeCloseTo(177.8, 1);
  });
  it("weight parsing", () => {
    expect(parseWeightToKg("180 lbs")).toBeCloseTo(81.65, 1);
    expect(parseWeightToKg("82 kg")).toBe(82);
    expect(parseWeightToKg(180)).toBeCloseTo(81.65, 1);
  });
});

describe("walking — distance only ('I walked one mile')", () => {
  const e = enrichWalkRunEntry("walking", { distance: 1 }, { heightCm: 178, weightKg: 82 });

  it("estimates steps, duration, and calories — all labeled, all with confidence", () => {
    expect(e.estimated.steps?.value).toBeGreaterThan(1500);
    expect(e.estimated.steps?.value).toBeLessThan(3000);
    expect(e.estimated.steps?.source).toBe("estimated");
    expect(e.estimated.steps?.confidence).toBeGreaterThanOrEqual(MIN_SAVE_CONFIDENCE);
    expect(e.estimated.duration?.value).toBeGreaterThan(10);
    expect(e.estimated.caloriesBurned?.value).toBeGreaterThan(40);
    expect(e.canonical.distanceMeters).toBeCloseTo(METERS_PER_MILE, 0);
  });

  it("registers assumptions for every estimate", () => {
    const fields = e.assumptions.map((a) => a.field);
    expect(fields).toContain("steps");
    expect(fields).toContain("duration");
    expect(fields).toContain("caloriesBurned");
    for (const a of e.assumptions) {
      expect(a.valueUsed).toBeTruthy();
      expect(a.confidence).toBeGreaterThan(0);
    }
  });

  it("height-based stride beats population default in confidence", () => {
    const noProfile = enrichWalkRunEntry("walking", { distance: 1 }, {});
    expect(e.estimated.steps!.confidence).toBeGreaterThan(noProfile.estimated.steps!.confidence);
  });
});

describe("walking — steps only ('I walked 12,000 steps')", () => {
  it("estimates distance from steps and keeps steps exact", () => {
    const e = enrichWalkRunEntry("walking", { steps: 12000 }, { heightCm: 178 });
    expect(e.estimated.distance?.value).toBeGreaterThan(3);
    expect(e.estimated.distance?.value).toBeLessThan(8);
    expect(e.estimated.steps).toBeUndefined(); // explicit — never re-derived
  });
});

describe("walking — duration only ('I walked for 30 minutes')", () => {
  it("estimates distance and steps via pace assumption", () => {
    const e = enrichWalkRunEntry("walking", { duration: 30 }, { heightCm: 178 });
    expect(e.estimated.distance?.value).toBeGreaterThan(0.8);
    expect(e.estimated.steps?.value).toBeGreaterThan(1000);
    expect(e.estimated.duration).toBeUndefined();
  });
});

describe("walking — distance + duration ('1 mile in 18 minutes')", () => {
  const e = enrichWalkRunEntry("walking", { distance: 1, duration: 18 }, { weightKg: 82 });
  it("pace and speed are CALCULATED (exact inputs), not estimated", () => {
    expect(e.calculated.paceMinutesPerMile?.value).toBe(18);
    expect(e.calculated.paceMinutesPerMile?.source).toBe("calculated");
    expect(e.calculated.paceMinutesPerMile?.confidence).toBe(1);
    expect(e.calculated.speedMph?.value).toBeCloseTo(3.33, 1);
    expect(e.estimated.duration).toBeUndefined();
  });
  it("canonical mirrors are populated", () => {
    expect(e.canonical.paceSecondsPerMile).toBe(1080);
    expect(e.canonical.durationSeconds).toBe(1080);
  });
});

describe("explicit values are never overwritten ('1 mile and 2,400 steps')", () => {
  it("keeps both user values; no steps estimate is produced", () => {
    const e = enrichWalkRunEntry("walking", { distance: 1, steps: 2400 }, { heightCm: 178 });
    expect(e.estimated.steps).toBeUndefined();
    expect(e.estimated.distance).toBeUndefined();
  });
  it("explicit calories are respected", () => {
    const e = enrichWalkRunEntry("walking", { distance: 1, caloriesBurned: 130 }, { weightKg: 82 });
    expect(e.estimated.caloriesBurned).toBeUndefined();
  });
});

describe("metric units ('I walked 2 kilometers')", () => {
  it("converts km → miles as CALCULATED and estimates the rest", () => {
    const e = enrichWalkRunEntry("walking", { distanceKm: 2 }, { heightCm: 178 });
    expect(e.calculated.distance?.value).toBeCloseTo(1.24, 1);
    expect(e.calculated.distance?.source).toBe("calculated");
    expect(e.canonical.distanceMeters).toBeCloseTo(2000, 0);
    expect(e.estimated.steps?.value).toBeGreaterThan(2000);
  });
});

describe("personal history hierarchy", () => {
  const historyEntries = [
    { values: { distance: 1.2, steps: 2650 }, timestamp: new Date(Date.now() - 2 * 864e5).toISOString() },
    { values: { distance: 2, steps: 4380 }, timestamp: new Date(Date.now() - 4 * 864e5).toISOString() },
  ];

  it("derives personal steps-per-mile from history (weighted)", () => {
    const m = derivePersonalMetrics(historyEntries);
    expect(m.samples).toBe(2);
    expect(m.stepsPerMile).toBeGreaterThan(2100);
    expect(m.stepsPerMile).toBeLessThan(2300);
  });

  it("personal ratio beats height-based stride and raises confidence", () => {
    const personal = derivePersonalMetrics(historyEntries);
    const withHistory = enrichWalkRunEntry("walking", { distance: 1 }, { heightCm: 178, personal });
    const withoutHistory = enrichWalkRunEntry("walking", { distance: 1 }, { heightCm: 178 });
    // ≈2,194 steps/mile personal average — the estimate should sit near it.
    expect(withHistory.estimated.steps!.value).toBeGreaterThan(2100);
    expect(withHistory.estimated.steps!.value).toBeLessThan(2300);
    expect(withHistory.estimated.steps!.confidence).toBeGreaterThan(withoutHistory.estimated.steps!.confidence);
    expect(withHistory.estimated.steps!.method).toContain("personal");
  });

  it("one unusual entry cannot swing the learned value drastically", () => {
    const withOutlier = derivePersonalMetrics([
      ...historyEntries,
      { values: { distance: 1, steps: 900 }, timestamp: new Date(Date.now() - 60 * 864e5).toISOString() }, // old outlier
    ]);
    expect(withOutlier.stepsPerMile).toBeGreaterThan(2000); // recency weighting protects the average
  });

  it("ignores garbage ratios", () => {
    const m = derivePersonalMetrics([{ values: { distance: 1, steps: 6 }, timestamp: new Date().toISOString() }]);
    expect(m.stepsPerMile).toBeUndefined();
  });
});

describe("running", () => {
  it("'I ran 5K in 28 minutes' — distance converted, pace calculated", () => {
    const e = enrichWalkRunEntry("running", { distanceKm: 5, duration: 28 }, { weightKg: 82 });
    expect(e.calculated.distance?.value).toBeCloseTo(3.11, 1);
    expect(e.calculated.paceMinutesPerMile?.value).toBeCloseTo(9, 0);
    expect(e.estimated.caloriesBurned?.value).toBeGreaterThan(200);
  });
});

describe("hydration", () => {
  it("'3 bottles of water' → labeled ounce estimate with assumption", () => {
    const e = enrichHydrationEntry({ containerCount: 3, containerType: "bottle" });
    expect(e.estimated.ounces?.value).toBeCloseTo(50.7, 0);
    expect(e.estimated.ounces?.source).toBe("estimated");
    expect(e.assumptions[0].assumption).toContain("bottle");
  });
  it("explicit ounces are exact — no estimate", () => {
    const e = enrichHydrationEntry({ ounces: 32 });
    expect(e.estimated.ounces).toBeUndefined();
    expect(e.canonical.volumeMl).toBeCloseTo(946, 0);
  });
});

describe("sleep", () => {
  it("'slept from 11:30 PM to 7:10 AM' → 7.67h CALCULATED across midnight", () => {
    expect(calculateDurationFromTimes("11:30 PM", "7:10 AM")).toBeCloseTo(7.67, 1);
    const e = enrichSleepEntry({ bedtime: "11:30 PM", wakeTime: "7:10 AM" });
    expect(e.calculated.hours?.value).toBeCloseTo(7.67, 1);
    expect(e.calculated.hours?.source).toBe("calculated");
  });
  it("explicit hours pass through with canonical seconds", () => {
    const e = enrichSleepEntry({ hours: 7.5 });
    expect(e.canonical.durationSeconds).toBe(27000);
    expect(Object.keys(e.estimated)).toHaveLength(0);
  });
});

describe("stride + summary", () => {
  it("stride from height uses the walking coefficient", () => {
    const s = estimateStrideMeters(178, "walking");
    expect(s.stride).toBeCloseTo(0.74, 1);
    expect(s.basis).toBe("height");
    expect(estimateStrideMeters(null, "walking").basis).toBe("default");
  });
  it("summarizeEnrichment marks estimates with ≈ and never hides them", () => {
    const e = enrichWalkRunEntry("walking", { distance: 1 }, { heightCm: 178, weightKg: 82 });
    const s = summarizeEnrichment(e);
    expect(s).toContain("≈");
    expect(s).toContain("(estimated)");
    expect(s).toContain("steps");
  });
});

// ─── Canonical-units upgrade (user report 2026-07-16: "60 min" primary in a
// miles history + "_enrichment: [object Object]" leaking into the UI) ────────

import {
  enrichStrengthEntry,
  applyEnrichmentToValues,
  splitEnrichmentFromValues,
} from "@shared/estimation-engine";

describe("applyEnrichmentToValues — canonical primary always present", () => {
  it("duration-only run gets an estimated distance applied into values", () => {
    const values: Record<string, any> = { duration: 60 };
    const e = enrichWalkRunEntry("running", values, {});
    const applied = applyEnrichmentToValues(values, e);
    expect(applied).toContain("distance");
    expect(values.distance, "distance (miles) must be stored so the history never mixes units").toBeCloseTo(6, 0);
    // provenance still marks it estimated
    expect(e.estimated.distance.source).toBe("estimated");
  });

  it("never overwrites explicit values and skips sub-threshold estimates", () => {
    const values: Record<string, any> = { distance: 1, steps: 2400 };
    const e = enrichWalkRunEntry("walking", values, {});
    applyEnrichmentToValues(values, e);
    expect(values.distance).toBe(1);
    expect(values.steps).toBe(2400);
    const low = { canonical: {}, calculated: {}, estimated: { steps: { value: 99, source: "estimated" as const, confidence: 0.1 } }, assumptions: [] };
    const v2: Record<string, any> = {};
    expect(applyEnrichmentToValues(v2, low)).toEqual([]);
    expect(v2.steps).toBeUndefined();
  });
});

describe("splitEnrichmentFromValues", () => {
  it("moves the provenance blob out of values", () => {
    const e = enrichWalkRunEntry("walking", { distance: 1 }, {});
    const raw = { distance: 1, steps: 2100, _enrichment: e };
    const split = splitEnrichmentFromValues(raw);
    expect(split.values._enrichment).toBeUndefined();
    expect(split.values.distance).toBe(1);
    expect(split.enrichment).toBe(e);
    expect(splitEnrichmentFromValues({ a: 1 }).enrichment).toBeNull();
    expect(splitEnrichmentFromValues(null).values).toEqual({});
  });
});

describe("cycling", () => {
  it("duration-only ride estimates miles from default speed, no steps", () => {
    const values: Record<string, any> = { duration: 30 };
    const e = enrichWalkRunEntry("cycling", values, {});
    expect(e.estimated.distance.value).toBeCloseTo(6, 0); // 30 min @ 5 min/mile ≈ 12 mph
    expect(e.estimated.steps, "cycling has no step metric").toBeUndefined();
  });

  it("distance + duration gives calculated speed and estimated calories", () => {
    const e = enrichWalkRunEntry("cycling", { distance: 12, duration: 60 }, { weightKg: 80 });
    expect(e.calculated.speedMph.value).toBe(12);
    expect(e.calculated.speedMph.source).toBe("calculated");
    expect(e.estimated.caloriesBurned.value).toBeGreaterThan(400); // MET 8 × 80kg × 1h = 640
  });
});

describe("calories → distance (weakest signal)", () => {
  it("estimates miles from calories alone using profile weight", () => {
    const e = enrichWalkRunEntry("running", { caloriesBurned: 480 }, { weightKg: 75 });
    // 480 / (1.6 × 75) = 4 miles
    expect(e.estimated.distance.value).toBeCloseTo(4, 0);
    expect(e.estimated.distance.confidence).toBeLessThanOrEqual(0.5);
    expect(e.assumptions.some(a => a.field === "distance")).toBe(true);
  });

  it("does not fire when a better signal exists", () => {
    const e = enrichWalkRunEntry("running", { caloriesBurned: 480, duration: 30 }, { weightKg: 75 });
    expect(e.estimated.distance?.method || "").not.toContain("kcal/mile");
  });
});

describe("sleep minutes → hours", () => {
  it('"slept 430 minutes" stores 7.17 hours as calculated', () => {
    const e = enrichSleepEntry({ minutes: 430 });
    expect(e.calculated.hours.value).toBeCloseTo(7.17, 2);
    expect(e.calculated.hours.source).toBe("calculated");
    const values: Record<string, any> = { minutes: 430 };
    applyEnrichmentToValues(values, e);
    expect(values.hours).toBeCloseTo(7.17, 2);
  });
});

describe("strength volume", () => {
  it("weight × reps × sets → calculated totalVolume", () => {
    const e = enrichStrengthEntry({ weight: 185, reps: 5, sets: 3 });
    expect(e.calculated.totalVolume.value).toBe(2775);
    expect(e.calculated.totalVolume.source).toBe("calculated");
    expect(e.calculated.totalVolume.confidence).toBe(1);
  });

  it("defaults sets to 1 and respects an explicit volume", () => {
    expect(enrichStrengthEntry({ weight: 100, reps: 10 }).calculated.totalVolume.value).toBe(1000);
    expect(enrichStrengthEntry({ weight: 100, reps: 10, totalVolume: 999 }).calculated.totalVolume).toBeUndefined();
  });
});
