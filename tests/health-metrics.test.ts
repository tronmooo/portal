import { describe, it, expect } from "vitest";
import {
  HEALTH_METRICS,
  getHealthMetric,
  trackerMatchesMetric,
  toCanonical,
  roundForMetric,
  aggregateDaily,
  HEALTHKIT_TYPE_MAP,
  HEALTH_CONNECT_TYPE_MAP,
  healthImportSchema,
  HEALTH_IMPORT_CHUNK_SIZE,
  connectionPrefKey,
  providerTag,
} from "../shared/health-metrics";
import { CANONICAL_GROUP_MAP } from "../client/src/lib/tracker-health";

const byId = (id: string) => {
  const m = getHealthMetric(id);
  if (!m) throw new Error(`no metric ${id}`);
  return m;
};

describe("health-metrics registry", () => {
  it("has unique ids and unique tracker names", () => {
    const ids = HEALTH_METRICS.map((m) => m.id);
    const names = HEALTH_METRICS.map((m) => m.trackerName.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every category is a known CANONICAL_GROUP_MAP key", () => {
    for (const m of HEALTH_METRICS) {
      expect(CANONICAL_GROUP_MAP[m.category], `${m.id} → category "${m.category}"`).toBeTruthy();
    }
  });

  it("every metric's primary field exists in its own field schema", () => {
    for (const m of HEALTH_METRICS) {
      const names = m.fields.map((f) => f.name);
      expect(names, m.id).toContain(m.field);
      for (const extra of m.extraFields || []) expect(names, m.id).toContain(extra);
    }
  });

  // ── The collision guard ───────────────────────────────────────────────────
  // extractVitals() picks the FIRST tracker matching its regex, and tracker
  // order is not guaranteed. If someone renames a registry entry into another
  // vital's pattern, that vital silently starts reading the wrong tracker.
  // These assertions make such a rename fail loudly instead.

  const VITAL_PATTERNS: Record<string, RegExp[]> = {
    weight: [/weight/, /\bmass\b/],
    heartRate: [/heart\s*rate/, /\bhr\b/, /pulse/],
    restingHeartRate: [/resting\s*(heart|hr)/, /rhr/],
    bodyTemp: [/temp/, /temperature/],
    glucose: [/glucose|blood\s*sugar/],
    cholesterol: [/cholesterol|lipid/],
    bmi: [/\bbmi\b/],
    sleep: [/sleep/],
    hydration: [/hydration|water/],
    calories: [/calorie|kcal|energy intake|nutrition/],
    steps: [/steps|step count/],
    mood: [/mood/],
    bloodPressure: [/blood\s*pressure|(^|\b)bp(\b|$)/],
  };

  /** Which vitals would extractVitals() resolve this tracker name to? */
  function vitalsMatched(name: string, category: string): string[] {
    const hay = `${name} ${category}`.toLowerCase();
    return Object.entries(VITAL_PATTERNS)
      .filter(([, pats]) => pats.some((p) => p.test(hay)))
      .map(([vital]) => vital);
  }

  it("Active Energy does not masquerade as the calorie-intake vital", () => {
    const m = byId("active_energy");
    expect(vitalsMatched(m.trackerName, m.category)).not.toContain("calories");
  });

  it("HRV does not masquerade as the heart-rate vital", () => {
    const m = byId("hrv");
    const matched = vitalsMatched(m.trackerName, m.category);
    expect(matched).not.toContain("heartRate");
    expect(matched).not.toContain("restingHeartRate");
  });

  it("each vital-bearing metric matches its own vital", () => {
    const expected: Record<string, string> = {
      steps: "steps",
      sleep: "sleep",
      weight: "weight",
      bmi: "bmi",
      hydration: "hydration",
      blood_glucose: "glucose",
      body_temp: "bodyTemp",
      heart_rate: "heartRate",
      resting_heart_rate: "restingHeartRate",
      blood_pressure: "bloodPressure",
      dietary_energy: "calories",
    };
    for (const [metricId, vital] of Object.entries(expected)) {
      const m = byId(metricId);
      expect(vitalsMatched(m.trackerName, m.category), `${metricId}`).toContain(vital);
    }
  });

  it("no metric other than heart_rate/resting_heart_rate touches the heart-rate vitals", () => {
    const allowed = new Set(["heart_rate", "resting_heart_rate", "blood_pressure"]);
    for (const m of HEALTH_METRICS) {
      if (allowed.has(m.id)) continue;
      const matched = vitalsMatched(m.trackerName, m.category);
      expect(matched, `${m.id} ("${m.trackerName}")`).not.toContain("heartRate");
    }
  });
});

describe("trackerMatchesMetric", () => {
  it("matches on exact name, case- and whitespace-insensitively", () => {
    const steps = byId("steps");
    expect(trackerMatchesMetric({ name: "Steps" }, steps)).toBe(true);
    expect(trackerMatchesMetric({ name: "  steps " }, steps)).toBe(true);
    expect(trackerMatchesMetric({ name: "STEPS" }, steps)).toBe(true);
  });

  it("matches aliases so an existing tracker is reused, not duplicated", () => {
    expect(trackerMatchesMetric({ name: "Step Count" }, byId("steps"))).toBe(true);
    expect(trackerMatchesMetric({ name: "Body Weight" }, byId("weight"))).toBe(true);
  });

  it("does not match unrelated trackers", () => {
    expect(trackerMatchesMetric({ name: "Bench Press" }, byId("weight"))).toBe(false);
    expect(trackerMatchesMetric({ name: "" }, byId("steps"))).toBe(false);
    expect(trackerMatchesMetric(null, byId("steps"))).toBe(false);
  });
});

describe("toCanonical", () => {
  it("converts weight to pounds", () => {
    expect(toCanonical(byId("weight"), 80, "kg")).toBeCloseTo(176.37, 1);
    expect(toCanonical(byId("weight"), 176, "lbs")).toBe(176);
  });

  it("converts distance to miles", () => {
    expect(toCanonical(byId("distance_walked"), 5, "km")).toBeCloseTo(3.107, 3);
    expect(toCanonical(byId("distance_walked"), 1609.34, "m")).toBeCloseTo(1, 3);
  });

  it("converts sleep to hours", () => {
    expect(toCanonical(byId("sleep"), 27000, "s")).toBeCloseTo(7.5, 5);
    expect(toCanonical(byId("sleep"), 450, "min")).toBeCloseTo(7.5, 5);
  });

  it("converts hydration to ounces", () => {
    expect(toCanonical(byId("hydration"), 1, "L")).toBeCloseTo(33.81, 2);
    expect(toCanonical(byId("hydration"), 500, "mL")).toBeCloseTo(16.91, 2);
  });

  it("converts glucose and temperature", () => {
    expect(toCanonical(byId("blood_glucose"), 5.5, "mmol/L")).toBeCloseTo(99.1, 1);
    expect(toCanonical(byId("body_temp"), 37, "C")).toBeCloseTo(98.6, 1);
  });

  it("expands 0-1 fractions to percentages", () => {
    expect(toCanonical(byId("blood_oxygen"), 0.97, "fraction")).toBeCloseTo(97, 5);
  });

  it("passes through when the unit is missing or unrecognised", () => {
    expect(toCanonical(byId("weight"), 176, undefined)).toBe(176);
    expect(toCanonical(byId("weight"), 176, "furlongs")).toBe(176);
  });

  it("rounds counts to whole numbers and measurements to 2dp", () => {
    expect(roundForMetric(byId("steps"), 8214.4)).toBe(8214);
    expect(roundForMetric(byId("weight"), 176.3698)).toBe(176.37);
  });
});

describe("aggregateDaily", () => {
  it("sums additive metrics per day", () => {
    const rows = aggregateDaily([
      { metric: "steps", day: "2026-08-01", value: 3000 },
      { metric: "steps", day: "2026-08-01", value: 5214 },
      { metric: "steps", day: "2026-08-02", value: 1000 },
    ]);
    expect(rows).toEqual([
      { metric: "steps", day: "2026-08-01", value: 8214 },
      { metric: "steps", day: "2026-08-02", value: 1000 },
    ]);
  });

  it("averages sampled metrics per day", () => {
    const rows = aggregateDaily([
      { metric: "heart_rate", day: "2026-08-01", value: 60 },
      { metric: "heart_rate", day: "2026-08-01", value: 80 },
    ]);
    expect(rows[0].value).toBe(70);
  });

  it("keeps the last sample for latest-wins metrics", () => {
    const rows = aggregateDaily([
      { metric: "weight", day: "2026-08-01", value: 178 },
      { metric: "weight", day: "2026-08-01", value: 176 },
    ]);
    expect(rows[0].value).toBe(176);
  });

  it("converts units before aggregating", () => {
    const rows = aggregateDaily([
      { metric: "weight", day: "2026-08-01", value: 80, unit: "kg" },
    ]);
    expect(rows[0].value).toBeCloseTo(176.37, 2);
  });

  it("carries the second value for blood pressure", () => {
    const rows = aggregateDaily([
      { metric: "blood_pressure", day: "2026-08-01", value: 118, value2: 76 },
    ]);
    expect(rows[0]).toEqual({ metric: "blood_pressure", day: "2026-08-01", value: 118, value2: 76 });
  });

  it("drops unknown metrics, bad days and non-finite values without throwing", () => {
    const rows = aggregateDaily([
      { metric: "not_a_metric", day: "2026-08-01", value: 1 },
      { metric: "steps", day: "08/01/2026", value: 1 },
      { metric: "steps", day: "2026-08-01", value: NaN },
      { metric: "steps", day: "2026-08-01", value: 500 },
    ]);
    expect(rows).toEqual([{ metric: "steps", day: "2026-08-01", value: 500 }]);
  });

  it("returns rows in a stable metric-then-day order", () => {
    const rows = aggregateDaily([
      { metric: "steps", day: "2026-08-02", value: 1 },
      { metric: "heart_rate", day: "2026-08-01", value: 60 },
      { metric: "steps", day: "2026-08-01", value: 1 },
    ]);
    expect(rows.map((r) => `${r.metric}:${r.day}`)).toEqual([
      "heart_rate:2026-08-01",
      "steps:2026-08-01",
      "steps:2026-08-02",
    ]);
  });
});

describe("provider type maps", () => {
  it("maps every HealthKit type to a real metric", () => {
    for (const [hk, id] of Object.entries(HEALTHKIT_TYPE_MAP)) {
      expect(getHealthMetric(id), `${hk} → ${id}`).toBeTruthy();
    }
  });

  it("maps every Health Connect type to a real metric", () => {
    for (const [hc, id] of Object.entries(HEALTH_CONNECT_TYPE_MAP)) {
      expect(getHealthMetric(id), `${hc} → ${id}`).toBeTruthy();
    }
  });

  it("covers the core HealthKit identifiers", () => {
    expect(HEALTHKIT_TYPE_MAP.HKQuantityTypeIdentifierStepCount).toBe("steps");
    expect(HEALTHKIT_TYPE_MAP.HKQuantityTypeIdentifierRestingHeartRate).toBe("resting_heart_rate");
    expect(HEALTHKIT_TYPE_MAP.HKCategoryTypeIdentifierSleepAnalysis).toBe("sleep");
  });
});

describe("wire contract", () => {
  it("accepts a well-formed payload", () => {
    const parsed = healthImportSchema.safeParse({
      provider: "file",
      rows: [{ metric: "steps", day: "2026-08-01", value: 8214 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown metrics, bad days and bad providers", () => {
    expect(healthImportSchema.safeParse({ provider: "file", rows: [{ metric: "nope", day: "2026-08-01", value: 1 }] }).success).toBe(false);
    expect(healthImportSchema.safeParse({ provider: "file", rows: [{ metric: "steps", day: "8/1/26", value: 1 }] }).success).toBe(false);
    expect(healthImportSchema.safeParse({ provider: "dropbox", rows: [{ metric: "steps", day: "2026-08-01", value: 1 }] }).success).toBe(false);
  });

  it("rejects an over-sized chunk", () => {
    const rows = Array.from({ length: HEALTH_IMPORT_CHUNK_SIZE + 1 }, (_, i) => ({
      metric: "steps", day: "2026-08-01", value: i,
    }));
    expect(healthImportSchema.safeParse({ provider: "file", rows }).success).toBe(false);
  });

  it("builds reserved preference and tag keys", () => {
    expect(connectionPrefKey("apple_health")).toBe("health_conn_apple_health");
    expect(connectionPrefKey("apple_health").startsWith("health_")).toBe(true);
    expect(providerTag("file")).toBe("src:file");
  });
});
