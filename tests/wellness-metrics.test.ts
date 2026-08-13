import { describe, it, expect } from "vitest";
import {
  readMetric, readDailyTotal, extractVitals, primaryFieldOf, countWellnessTrackers,
  readActivity, isActivityTracker,
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

// ─────────────────────────────────────────────────────────────────────────────
// "I walked a mile today, why is it blank?" (user report 2026-08-13).
//
// A tracker named "Walking" matched neither /steps/ nor /exercise/, so a logged
// walk rendered "—" on the Executive card AND on the Wellness tab's Activity
// tile while showing up in Recent Activity. Activity is now recognised by the
// tracker's name OR the shape of its fields, and what the tile shows degrades
// honestly: minutes → distance → "a session happened".
// ─────────────────────────────────────────────────────────────────────────────
describe("activity is recognised however the user named it", () => {
  const NOW = new Date("2026-08-13T18:00:00Z");
  const todayEntry = (values: Record<string, any>, computed?: any) => ({
    id: "e1", values, computed: computed || {}, timestamp: NOW.toISOString(),
  }) as any;

  it("recognises the names people actually use for a workout", () => {
    for (const name of ["Walking", "Morning Run", "Cycling", "Gym", "Yoga", "Swim", "Hike", "Peloton"]) {
      expect(isActivityTracker(tracker({ name })), name).toBe(true);
    }
    // And by shape, whatever it is called.
    expect(isActivityTracker(tracker({
      name: "Sunday Loop", fields: [{ name: "distance", type: "number" }],
    }))).toBe(true);
    // Not everything is activity.
    expect(isActivityTracker(tracker({ name: "Blood Pressure" }))).toBe(false);
  });

  it("counts a walk logged as distance", () => {
    const t = tracker({
      id: "w", name: "Walking", category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
      entries: [todayEntry({ distance: 1 })],
    });
    const a = readActivity([t], { now: NOW });
    expect(a.distance).toBe(1);
    expect(a.distanceUnit).toBe("mi");
    expect(a.sessions).toBe(1);
  });

  it("counts a walk logged only as calories burned — the reported case", () => {
    // THE bug: "Walking: 82 cal" was in Recent Activity while the tile said "—".
    const t = tracker({
      id: "w", name: "Walking",
      fields: [{ name: "cal", type: "number", isPrimary: true }],
      entries: [todayEntry({ cal: 82 })],
    });
    const a = readActivity([t], { now: NOW });
    expect(a.caloriesBurned).toBe(82);
    // No duration and no distance, but something DID happen.
    expect(a.minutes).toBeNull();
    expect(a.distance).toBeNull();
    expect(a.sessions).toBe(1);
  });

  it("reads steps off a field, not just off a tracker named Steps", () => {
    const t = tracker({
      id: "w", name: "Walking",
      fields: [{ name: "steps", type: "number", isPrimary: true }],
      entries: [todayEntry({ steps: 2100 })],
    });
    expect(readActivity([t], { now: NOW }).steps).toBe(2100);
    // …and it reaches the vitals the tiles render.
    expect(extractVitals([t], { now: NOW }).steps.value).toBe(2100);
  });

  it("picks up server-computed duration and burn", () => {
    const t = tracker({
      id: "w", name: "Workout",
      fields: [{ name: "note", type: "text" }],
      entries: [todayEntry({ note: "loop" }, { durationMinutes: 42, caloriesBurned: 300 })],
    });
    const a = readActivity([t], { now: NOW });
    expect(a.minutes).toBe(42);
    expect(a.caloriesBurned).toBe(300);
  });

  it("never counts yesterday as today, but a 7-day window does", () => {
    const yesterday = new Date(NOW.getTime() - 26 * 3600000).toISOString();
    const t = tracker({
      id: "w", name: "Walking",
      fields: [{ name: "distance", type: "number", unit: "mi" }],
      entries: [{ id: "e0", values: { distance: 3 }, computed: {}, timestamp: yesterday }] as any,
    });
    expect(readActivity([t], { now: NOW }).sessions).toBe(0);
    expect(readActivity([t], { now: NOW, days: 7 }).distance).toBe(3);
  });

  it("keeps a burn out of the calorie INTAKE metric", () => {
    // Burning 500 must never read as eating 500.
    const walk = tracker({
      id: "w", name: "Walking", fields: [{ name: "calories", type: "number" }],
      entries: [todayEntry({ calories: 500 })],
    });
    const v = extractVitals([walk], { now: NOW });
    expect(v.activity.caloriesBurned).toBe(500);
    expect(v.calories.value).toBeNull();
  });
});
