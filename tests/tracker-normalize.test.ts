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

// ── Per-set lift values (the 2026-08-02 "3 pounds / 2 pounds" report) ────────
// The chat logged a lift's load per set as a STRING ("weight":"70/80/80"), so
// the weight field was never numeric. The card then borrowed the only number it
// could find — the SET COUNT — and printed it as pounds. The normalizer is the
// chokepoint every writer goes through, so it is where a numeric field is
// guaranteed to end up holding a number.
describe("normalizeTrackerEntry — per-set lift values", () => {
  const lift = {
    name: "Incline Dumbbell Press", category: "fitness", unit: null,
    fields: [
      { name: "weight", type: "number", unit: "lbs", isPrimary: true },
      { name: "reps", type: "number", unit: "reps" },
      { name: "sets", type: "number", unit: "sets" },
    ],
  } as any;

  it("stores the top set as a number and keeps the per-set detail", () => {
    const { values } = normalizeTrackerEntry(lift, {
      reps: "10/8/6", sets: 3, weight: "70/80/80", intensity: "high", totalVolume: 2100,
    });
    expect(values.weight).toBe(80);            // heaviest set — never a string
    expect(typeof values.weight).toBe("number");
    expect(values.weightPerSet).toBe("70/80/80");
    expect(values.reps).toBe(8);               // the reps done at 80 lbs
    expect(values.repsPerSet).toBe("10/8/6");
    expect(values.sets).toBe(3);
    expect(values.totalVolume).toBe(1820);     // 70×10 + 80×8 + 80×6, corrected
    expect(values.intensity).toBe("high");
  });

  it("lands every spelling of the load on the same field", () => {
    // Jul 26 logged "weightLbs", Jul 27 logged "weight" — one tracker ended up
    // with two half-filled fields. Both must resolve to `weight` now.
    const a = normalizeTrackerEntry(lift, { weightLbs: 50, reps: 10, sets: 3 }).values;
    expect(a.weight).toBe(50);
    expect(a.weightLbs).toBeUndefined();
    const b = normalizeTrackerEntry(lift, { weight: 50, reps: 10, sets: 3 }).values;
    expect(b.weight).toBe(50);
  });

  it("derives the set count from the list when the model omitted it", () => {
    const { values } = normalizeTrackerEntry(lift, { weight: "70/80/80", reps: "10/8/6" });
    expect(values.sets).toBe(3);
  });

  it("leaves a blood-pressure reading alone (120/80 is not two sets)", () => {
    const bp = {
      name: "Blood Pressure", category: "health", unit: "mmHg",
      fields: [
        { name: "systolic", type: "number", unit: "mmHg", isPrimary: true },
        { name: "diastolic", type: "number", unit: "mmHg" },
      ],
    } as any;
    const { values } = normalizeTrackerEntry(bp, { systolic: 120, diastolic: 80 });
    expect(values.systolic).toBe(120);
    expect(values.diastolic).toBe(80);
    expect(values.sets).toBeUndefined();
  });
});
