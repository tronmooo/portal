import { describe, it, expect } from "vitest";
import {
  readMetric, readDailyTotal, extractVitals, primaryFieldOf, countWellnessTrackers,
} from "../client/src/lib/wellness-metrics";
import type { Tracker } from "../shared/schema";

function tracker(partial: Partial<Tracker>): Tracker {
  return {
    id: "t", name: "T", category: "health", unit: "", icon: "",
    fields: [{ name: "value", type: "number" }],
    entries: [], linkedProfiles: [], createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  } as Tracker;
}

const ISO = (d: string) => new Date(d).toISOString();

describe("wellness-metrics", () => {
  it("primaryFieldOf prefers isPrimary, then number, then first", () => {
    expect(primaryFieldOf(tracker({ fields: [{ name: "a", type: "text" }, { name: "b", type: "number", isPrimary: true }] }))).toBe("b");
    expect(primaryFieldOf(tracker({ fields: [{ name: "a", type: "text" }, { name: "n", type: "number" }] }))).toBe("n");
    expect(primaryFieldOf(tracker({ fields: [{ name: "only", type: "text" }] }))).toBe("only");
    expect(primaryFieldOf(tracker({ fields: [] }))).toBe("value");
  });

  it("readMetric returns the newest value + reversed series + change%", () => {
    const t = tracker({
      name: "Weight", category: "health", unit: "lbs",
      fields: [{ name: "weight", type: "number", unit: "lbs", isPrimary: true }],
      entries: [
        { id: "e1", values: { weight: 176 }, computed: {}, timestamp: ISO("2026-07-03") },
        { id: "e2", values: { weight: 178 }, computed: {}, timestamp: ISO("2026-07-01") },
      ] as any,
    });
    const m = readMetric([t], [/weight/]);
    expect(m.value).toBe(176);
    expect(m.unit).toBe("lbs");
    expect(m.series).toEqual([178, 176]); // oldest→newest
    expect(m.changePct).toBeCloseTo(((176 - 178) / 178) * 100, 4);
    expect(m.trackerId).toBe("t");
  });

  it("readMetric ignores out-of-order timestamps (picks true latest)", () => {
    const t = tracker({
      name: "HR", category: "health", fields: [{ name: "bpm", type: "number", isPrimary: true }],
      entries: [
        { id: "e1", values: { bpm: 60 }, computed: {}, timestamp: ISO("2026-06-01") },
        { id: "e2", values: { bpm: 54 }, computed: {}, timestamp: ISO("2026-07-05") },
        { id: "e3", values: { bpm: 58 }, computed: {}, timestamp: ISO("2026-06-15") },
      ] as any,
    });
    expect(readMetric([t], [/hr/, /heart/]).value).toBe(54);
  });

  it("readMetric returns empty metric when nothing matches", () => {
    const m = readMetric([tracker({ name: "Weight" })], [/glucose/]);
    expect(m.value).toBeNull();
    expect(m.trackerId).toBeNull();
    expect(m.series).toEqual([]);
  });

  it("readDailyTotal sums today's entries", () => {
    const now = new Date("2026-07-08T20:00:00Z");
    const t = tracker({
      name: "Hydration", category: "health", unit: "oz",
      fields: [{ name: "ounces", type: "number", isPrimary: true }],
      entries: [
        { id: "e1", values: { ounces: 16 }, computed: {}, timestamp: ISO("2026-07-08T09:00:00Z") },
        { id: "e2", values: { ounces: 24 }, computed: {}, timestamp: ISO("2026-07-08T13:00:00Z") },
        { id: "e3", values: { ounces: 99 }, computed: {}, timestamp: ISO("2026-07-07T13:00:00Z") },
      ] as any,
    });
    expect(readDailyTotal([t], [/hydration|water/], { now }).value).toBe(40);
  });

  it("readDailyTotal falls back to latest when nothing logged today", () => {
    const now = new Date("2026-07-08T20:00:00Z");
    const t = tracker({
      name: "Steps", category: "fitness",
      fields: [{ name: "steps", type: "number", isPrimary: true }],
      entries: [{ id: "e1", values: { steps: 7842 }, computed: {}, timestamp: ISO("2026-07-06T09:00:00Z") }] as any,
    });
    expect(readDailyTotal([t], [/steps/], { now }).value).toBe(7842);
  });

  it("extractVitals splits blood pressure into systolic/diastolic fields", () => {
    const bp = tracker({
      id: "bp", name: "Blood Pressure", category: "health",
      fields: [
        { name: "systolic", type: "number", unit: "mmHg", isPrimary: true },
        { name: "diastolic", type: "number", unit: "mmHg" },
      ],
      entries: [{ id: "e1", values: { systolic: 118, diastolic: 76 }, computed: {}, timestamp: ISO("2026-07-08") }] as any,
    });
    const v = extractVitals([bp]);
    expect(v.bloodPressureSys.value).toBe(118);
    expect(v.bloodPressureDia.value).toBe(76);
  });

  it("countWellnessTrackers counts health/fitness/mental groups only", () => {
    const list = [
      tracker({ id: "1", category: "health" }),
      tracker({ id: "2", category: "fitness" }),
      tracker({ id: "3", category: "mood" }),      // Mental & Wellness
      tracker({ id: "4", category: "finance" }),   // excluded
    ];
    expect(countWellnessTrackers(list)).toBe(3);
  });
});
