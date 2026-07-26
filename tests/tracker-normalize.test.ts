import { describe, it, expect } from "vitest";
import { normalizeTrackerEntry, parseClockTime } from "../server/tracker-normalize";

// Regression for the reported bug: "I slept from 11 PM to 5:30 AM" logged
// "5:30 AM" into the Sleep tracker's hours field (a clock time, not a
// duration) and dropped quality. Root cause: the normalizer force-mapped any
// stray field onto the lone numeric field, and never computed sleep duration.

const sleepTracker = {
  name: "Sleep",
  category: "health",
  unit: "hr",
  fields: [
    { name: "hours", type: "number", unit: "hr", isPrimary: true },
    { name: "quality", type: "text" },
  ],
} as any;

const tempTracker = {
  name: "Body Temperature",
  category: "health",
  unit: "F",
  fields: [{ name: "value", type: "number", unit: "F" }],
} as any;

describe("parseClockTime", () => {
  it("parses 12-hour and 24-hour clock strings", () => {
    expect(parseClockTime("11:00 PM")).toBe(23 * 60);
    expect(parseClockTime("5:30 AM")).toBe(5 * 60 + 30);
    expect(parseClockTime("12:00 AM")).toBe(0);
    expect(parseClockTime("12:00 PM")).toBe(12 * 60);
    expect(parseClockTime("23:00")).toBe(23 * 60);
    expect(parseClockTime("not a time")).toBeNull();
    expect(parseClockTime("6.5")).toBeNull(); // a decimal duration is not a clock time
    expect(parseClockTime(23)).toBe(23 * 60); // bare 24h hour as a number
  });
});

describe("normalizeTrackerEntry — sleep duration (the reported bug)", () => {
  it("computes hours from a bedtime/waketime range and keeps secondaries", () => {
    const { values } = normalizeTrackerEntry(sleepTracker, {
      bedtime: "11:00 PM", wakeTime: "5:30 AM", quality: "fair",
    });
    expect(values.hours).toBe(6.5);          // 11pm → 5:30am = 6.5h, not "5:30 AM"
    expect(values.quality).toBe("fair");      // secondary characteristic preserved
    expect(values.bedtime).toBe("11:00 PM");
    expect(values.wakeTime).toBe("5:30 AM");
  });

  it("never leaves a clock time sitting in the numeric hours field", () => {
    // AI mistakenly puts the wake time directly in hours.
    const { values } = normalizeTrackerEntry(sleepTracker, { hours: "5:30 AM" });
    expect(values.hours).toBeUndefined();     // not the corrupted "5:30 AM"
    expect(values.wakeTime).toBe("5:30 AM");  // moved out of the headline field
  });

  it("honors an explicit numeric hours value", () => {
    const { values } = normalizeTrackerEntry(sleepTracker, { hours: 6.5, quality: "fair" });
    expect(values.hours).toBe(6.5);
    expect(values.quality).toBe("fair");
  });
});

describe("normalizeTrackerEntry — a remap must not clobber an exact-matched field (2026-06-25)", () => {
  // Steps tracker with a SINGLE numeric field. Logging {steps:9800, distance:4.6}
  // used to store steps=4.6 — the unknown "distance" was remapped onto the lone
  // numeric "steps" field, overwriting the real step count.
  const steps = {
    name: "Steps", category: "fitness", unit: "steps",
    fields: [{ name: "steps", type: "number", unit: "steps", isPrimary: true }],
  } as any;

  it("keeps the exact-matched value and does not let a stray numeric clobber it", () => {
    const { values } = normalizeTrackerEntry(steps, { steps: 9800, distance: 4.6 });
    expect(values.steps).toBe(9800);     // not 4.6
    expect(values.distance).toBe(4.6);   // stray kept under its own name
  });

  it("is order-independent (stray listed first still doesn't win)", () => {
    const { values } = normalizeTrackerEntry(steps, { distance: 4.6, steps: 9800 });
    expect(values.steps).toBe(9800);
    expect(values.distance).toBe(4.6);
  });
});

describe("normalizeTrackerEntry — multiple numerics must not collapse onto a lone field (2026-06-25)", () => {
  // A freshly-created tracker often has a single generic "value" field. Logging
  // a multi-metric entry used to collapse every number onto "value" (last wins),
  // losing the rest — a Workout {weight:135, reps:10, sets:3} became {value:3}.
  const generic = {
    name: "Workout", category: "fitness", unit: "",
    fields: [{ name: "value", type: "number", isPrimary: true }],
  } as any;

  it("keeps each named metric distinct instead of collapsing onto 'value'", () => {
    const { values } = normalizeTrackerEntry(generic, { exercise: "Bench Press", weight: 135, reps: 10, sets: 3 });
    expect(values.weight).toBe(135);
    expect(values.reps).toBe(10);
    expect(values.sets).toBe(3);
    expect(values.exercise).toBe("Bench Press");
    expect(values.value).toBeUndefined(); // nothing collapsed onto the lone field
  });

  it("still maps a SINGLE numeric onto the lone field (temperature:99 → value)", () => {
    const temp = { name: "Body Temperature", category: "health", unit: "°F",
      fields: [{ name: "value", type: "number", isPrimary: true }] } as any;
    const { values } = normalizeTrackerEntry(temp, { temperature: 99 });
    expect(values.value).toBe(99);
  });
});

describe("normalizeTrackerEntry — generic value maps to the primary field", () => {
  const hydration = {
    name: "Hydration", category: "health", unit: "oz",
    fields: [
      { name: "ounces", type: "number", unit: "oz", isPrimary: true },
      { name: "glasses", type: "number" },
    ],
  } as any;

  it("maps a generic 'amount' onto the primary numeric field (the 0 oz bug)", () => {
    // "drank 24 ounces" → AI logs {amount:24}; must land on ounces, not a stray.
    const { values } = normalizeTrackerEntry(hydration, { amount: 24 });
    expect(values.ounces).toBe(24);
    expect(values.amount).toBeUndefined();
  });

  it("strips a unit suffix while mapping ('24 oz' → 24 on ounces)", () => {
    const { values } = normalizeTrackerEntry(hydration, { amount: "24 oz" });
    expect(values.ounces).toBe(24);
  });

  it("does not hijack a non-numeric generic value", () => {
    const { values } = normalizeTrackerEntry(hydration, { amount: "a lot" });
    expect(values.ounces).toBeUndefined();
    expect(values.amount).toBe("a lot");
  });
});

describe("normalizeTrackerEntry — single-numeric mapping is value-aware", () => {
  it("still maps a numeric stray onto the lone numeric field", () => {
    const { values } = normalizeTrackerEntry(tempTracker, { temperature: "99°F" });
    expect(values.value).toBe(99);
  });

  it("does NOT map a NON-numeric stray onto the lone numeric field", () => {
    // Previously "mood: happy" would clobber value="happy"; now it's preserved.
    const { values } = normalizeTrackerEntry(tempTracker, { mood: "happy" });
    expect(values.value).toBeUndefined();
    expect(values.mood).toBe("happy");
  });
});

// Regression for the reported bug (screenshot 2026-07-26): a lift logged from
// chat arrived as { activityType, weightLbs, reps, sets }. "weightLbs" matched
// no field on the Bench Press tracker, so it persisted as its own stray column
// and the entry card read "110 weightLbs" instead of "110 lbs" — and the
// strength enrichment (weight × reps × sets) never fired because it looks for
// `weight`.
const benchPress = {
  name: "Bench Press",
  category: "fitness",
  fields: [
    { name: "weight", type: "number", unit: "lbs", isPrimary: true },
    { name: "reps", type: "number", unit: "reps" },
    { name: "sets", type: "number", unit: "sets" },
    { name: "rpe", type: "number", unit: "/10" },
  ],
} as any;

describe("normalizeTrackerEntry — strength lifts", () => {
  it("maps weightLbs onto the tracker's canonical weight field", () => {
    const { values } = normalizeTrackerEntry(benchPress, {
      activityType: "bench press", weightLbs: 110, reps: 10, sets: 3,
    });
    expect(values.weight).toBe(110);
    expect(values.weightLbs).toBeUndefined();
    expect(values.reps).toBe(10);
    expect(values.sets).toBe(3);
    // The exercise label stays as its own field — it is not a metric.
    expect(values.activityType).toBe("bench press");
  });

  it("maps repetitions/set aliases too", () => {
    const { values } = normalizeTrackerEntry(benchPress, { lbs: 45, repetitions: 8, set: 3 });
    expect(values.weight).toBe(45);
    expect(values.reps).toBe(8);
    expect(values.sets).toBe(3);
  });

  it("keeps each lift metric distinct — no collapse onto one numeric field", () => {
    const { values } = normalizeTrackerEntry(benchPress, { weightLbs: 110, reps: 10, sets: 3 });
    expect([values.weight, values.reps, values.sets]).toEqual([110, 10, 3]);
  });
});
