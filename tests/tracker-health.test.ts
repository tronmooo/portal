import { describe, it, expect } from "vitest";
import { getCanonicalGroup, computeHealthScore, CANONICAL_GROUP_MAP } from "../client/src/lib/tracker-health";

// Parity tests for the logic extracted from pages/trackers.tsx (2026-07-08).
// These pin the observable behavior so the extraction (and any future edits to
// the lib) can't silently drift from what the trackers page always did.

describe("getCanonicalGroup", () => {
  it("maps exact categories through CANONICAL_GROUP_MAP", () => {
    expect(getCanonicalGroup("health")).toBe("Health");
    expect(getCanonicalGroup("sleep")).toBe("Health");
    expect(getCanonicalGroup("mood")).toBe("Mental & Wellness");
    expect(getCanonicalGroup("steps")).toBe("Fitness");
    expect(getCanonicalGroup("medication")).toBe("Medication");
    expect(getCanonicalGroup("gaming")).toBe("Lifestyle");
    expect(getCanonicalGroup("budget")).toBe("Finance");
    expect(getCanonicalGroup("habit")).toBe("Habits & Routines");
    expect(getCanonicalGroup("work")).toBe("Productivity");
    expect(getCanonicalGroup("custom")).toBe("Other");
  });

  it("is case/whitespace insensitive on exact matches", () => {
    expect(getCanonicalGroup("  Health ")).toBe("Health");
    expect(getCanonicalGroup("GAMING")).toBe("Lifestyle");
  });

  it("falls back to keyword matching for compound categories", () => {
    expect(getCanonicalGroup("Metabolic Panel - Fasting")).toBe("Health");
    expect(getCanonicalGroup("Vitals (morning)")).toBe("Health");
    expect(getCanonicalGroup("morning workout routine")).toBe("Fitness");
    expect(getCanonicalGroup("PlayStation time")).toBe("Lifestyle");
    expect(getCanonicalGroup("monthly spend review")).toBe("Finance");
  });

  it("returns Other for empty/unknown categories", () => {
    expect(getCanonicalGroup("")).toBe("Other");
    expect(getCanonicalGroup(undefined as any)).toBe("Other");
    expect(getCanonicalGroup("zzz-unmatched")).toBe("Other");
  });

  it("keeps the exact-match table intact (spot-check the map)", () => {
    expect(CANONICAL_GROUP_MAP["cbc"]).toBe("Health");
    expect(CANONICAL_GROUP_MAP["weight"]).toBe("Fitness");
    expect(CANONICAL_GROUP_MAP["journal"]).toBe("Mental & Wellness");
  });
});

describe("computeHealthScore", () => {
  const tracker = (category: string, entries: any[]): any => ({
    id: "t1", name: "t", category, entries,
  });
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();

  it("returns null with no health/fitness trackers", () => {
    expect(computeHealthScore([])).toBeNull();
    expect(computeHealthScore([tracker("finance", [{ timestamp: now, values: {}, computed: {} }])])).toBeNull();
  });

  it("returns null when health trackers have no scoreable factors", () => {
    // Old entry, no computed metrics → no factors at all
    expect(computeHealthScore([tracker("health", [{ timestamp: old, values: {}, computed: {} }])])).toBeNull();
  });

  it("scores a normal BMI + recent activity as (100 + 75) / 2", () => {
    const t = tracker("health", [{ timestamp: now, values: {}, computed: { bmi: 22 } }]);
    expect(computeHealthScore([t])).toBe(Math.round((100 + 75) / 2));
  });

  it("scores blood pressure categories and sleep quality", () => {
    const t = tracker("vitals", [{
      timestamp: old, // no recent-activity bonus
      values: {},
      computed: { bloodPressureCategory: "normal", sleepQuality: "good" },
    }]);
    // (100 BP + 80 sleep) / 2 = 90
    expect(computeHealthScore([t])).toBe(90);
  });

  it("uses only the LAST entry for computed metrics", () => {
    const t = tracker("health", [
      { timestamp: old, values: {}, computed: { bmi: 40 } },
      { timestamp: old, values: {}, computed: { bmi: 22 } },
    ]);
    expect(computeHealthScore([t])).toBe(100); // last entry's bmi=22 → 100, no recent bonus
  });
});
