import { describe, it, expect } from "vitest";
import { summarizeLiftEntry } from "../client/src/lib/lift-summary";

// The 2026-08-02 report, reproduced from the actual rows in the database:
// the Incline Dumbbell Press card read "3 lbs" and Shoulder Press read "2 lbs".
// Those were the SET COUNTS. The tracker had been created by the chat, which
// stored the load as a per-set string, so `weight`/`reps` were auto-created as
// TEXT fields and `sets` became the tracker's first numeric field.
const CHAT_CREATED_TRACKER = {
  name: "Incline Dumbbell Press", category: "fitness", unit: null,
  fields: [
    { name: "activityType", type: "text" },
    { name: "exercise", type: "text" },
    { name: "sets", type: "number" },
    { name: "reps", type: "text" },
    { name: "weightLbs", type: "text" },
    { name: "notes", type: "text" },
    { name: "caloriesBurned", type: "number" },
    { name: "intensity", type: "text" },
    { name: "weight", type: "text" },
    { name: "totalVolume", type: "number" },
  ],
} as any;

const ENTRY = {
  reps: "10/8/6", sets: 3, notes: "70s×10, 80s×8, 80s×6", weight: "70/80/80",
  intensity: "high", totalVolume: 2100, activityType: "Incline Dumbbell Press", caloriesBurned: 45,
};

// The canonical lift shape, for comparison.
const LIFT_TRACKER = {
  name: "Bench Press", category: "fitness", unit: "lbs",
  fields: [
    { name: "weight", type: "number", unit: "lbs", isPrimary: true },
    { name: "reps", type: "number", unit: "reps" },
    { name: "sets", type: "number", unit: "sets" },
  ],
} as any;

describe("summarizeLiftEntry — the reported bug", () => {
  it("headlines the load, not the set count, for a per-set entry", () => {
    const s = summarizeLiftEntry(CHAT_CREATED_TRACKER, ENTRY);
    expect(s.value).toBe("80");        // heaviest set
    expect(s.unit).toBe("lbs");
    expect(s.value).not.toBe("3");     // the set count, which used to be shown
    expect(s.subline).toBe("70/80/80 lbs · 10/8/6 reps · 3 sets");
    expect(s.insight).toBe("Lifted 70/80/80 lbs × 10/8/6 reps × 3 sets.");
  });

  it("NEVER labels a count with a weight unit", () => {
    // No load anywhere in the entry — the card must fall back to the count with
    // the count's own unit. This is the exact case that produced "3 lbs".
    const s = summarizeLiftEntry(CHAT_CREATED_TRACKER, { sets: 3, reps: 10, caloriesBurned: 45 });
    expect(s.value).toBe("3");
    expect(s.unit).toBe("sets");
    expect(s.insight).toBe("3 sets × 10 reps logged.");
  });

  it("falls back to reps when only reps were logged", () => {
    const s = summarizeLiftEntry(CHAT_CREATED_TRACKER, { reps: 12 });
    expect(s.value).toBe("12");
    expect(s.unit).toBe("reps");
  });

  it("shows nothing rather than a fabricated unit when there is no data", () => {
    const s = summarizeLiftEntry(CHAT_CREATED_TRACKER, { intensity: "high" });
    expect(s.hasData).toBe(false);
    expect(s.unit).toBe("");          // used to be a hardcoded "lbs"
  });
});

describe("summarizeLiftEntry — normal lifts", () => {
  it("summarizes a scalar entry on the canonical lift shape", () => {
    const s = summarizeLiftEntry(LIFT_TRACKER, { weight: 185, reps: 5, sets: 3 });
    expect(s.value).toBe("185");
    expect(s.unit).toBe("lbs");
    expect(s.subline).toBe("5 reps · 3 sets");
    expect(s.insight).toBe("Lifted 185 lbs × 5 reps × 3 sets.");
  });

  it("takes the unit from the field the load came from", () => {
    // A tracker that declares kg must never be relabeled lbs.
    const kgTracker = {
      name: "Squat", category: "fitness", unit: "kg",
      fields: [{ name: "weight", type: "number", unit: "kg", isPrimary: true }, { name: "reps", type: "number" }],
    } as any;
    const s = summarizeLiftEntry(kgTracker, { weight: 100, reps: 5, sets: 5 });
    expect(s.unit).toBe("kg");
    expect(s.insight).toContain("100 kg");
  });

  it("reads the load from a weightLbs-style key", () => {
    const s = summarizeLiftEntry(CHAT_CREATED_TRACKER, { weightLbs: 50, sets: 3, reps: 10 });
    expect(s.value).toBe("50");
    expect(s.unit).toBe("lbs");
  });
});

describe("summarizeLiftEntry — healed entries keep their per-set detail", () => {
  it("shows the sets the user actually did", () => {
    const s = summarizeLiftEntry(LIFT_TRACKER, {
      weight: 80, weightPerSet: "70/80/80", reps: 8, repsPerSet: "10/8/6", sets: 3, totalVolume: 1820,
    });
    expect(s.value).toBe("80");
    expect(s.unit).toBe("lbs");
    expect(s.subline).toBe("70/80/80 lbs · 10/8/6 reps · 3 sets");
  });
});
