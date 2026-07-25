// Pins the per-exercise field scoping for lifting logs.
//
// Regression source: user report 2026-07-25 —
//   "Dumbbells I did 45 pounds 10 reps each three times I ran a mile bench
//    pressed 145 pounds 10 reps each and I walked for a mile"
// logged TWO lifting entries that BOTH claimed 3 sets. "three times" belongs
// only to the dumbbell clause; the bench press never had a set count stated.
import { describe, it, expect } from "vitest";
import {
  parseLiftingClause,
  splitLiftingSegments,
  scopeLiftingValues,
  isLiftingEntry,
  liftingRecordFromValues,
  formatLiftingDetail,
  liftingSetsNote,
} from "@shared/lifting-scope";

const REPORTED_MESSAGE =
  "Dumbbells I did 45 pounds 10 reps each three times I ran a mile bench pressed 145 pounds 10 reps each and I walked for a mile";

describe("parseLiftingClause", () => {
  it("reads weight, reps and 'three times' as sets", () => {
    expect(parseLiftingClause("Dumbbells I did 45 pounds 10 reps each three times")).toEqual({
      weight: 45, weightUnit: "lb", reps: 10, sets: 3,
    });
  });

  it("leaves sets null when the clause never states one", () => {
    expect(parseLiftingClause("bench pressed 145 pounds 10 reps each")).toEqual({
      weight: 145, weightUnit: "lb", reps: 10, sets: null,
    });
  });

  it("reads 3x10 shorthand as sets × reps with a bare load", () => {
    expect(parseLiftingClause("bench press 135 for 3x10")).toEqual({
      weight: 135, weightUnit: null, reps: 10, sets: 3,
    });
  });

  it("reads '3 sets of 10 reps at 145 lbs'", () => {
    expect(parseLiftingClause("squats 3 sets of 10 reps at 145 lbs")).toEqual({
      weight: 145, weightUnit: "lb", reps: 10, sets: 3,
    });
  });

  it("reads a load-only clause with no rep or set count", () => {
    expect(parseLiftingClause("incline dumbbells 40lb")).toEqual({
      weight: 40, weightUnit: "lb", reps: null, sets: null,
    });
  });

  it("reads kilograms", () => {
    expect(parseLiftingClause("deadlift 100 kg 5 reps twice")).toEqual({
      weight: 100, weightUnit: "kg", reps: 5, sets: 2,
    });
  });

  it("never mistakes a rep count for a load", () => {
    expect(parseLiftingClause("curls 10 reps").weight).toBeNull();
  });
});

describe("splitLiftingSegments", () => {
  it("scopes each clause to its own exercise and stops at cardio", () => {
    const segs = splitLiftingSegments(REPORTED_MESSAGE);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe("Dumbbells I did 45 pounds 10 reps each three times");
    expect(segs[1].text).toBe("bench pressed 145 pounds 10 reps each");
  });

  it("gives the dumbbell clause 3 sets and the bench press none", () => {
    const [dumbbell, bench] = splitLiftingSegments(REPORTED_MESSAGE);
    expect(dumbbell).toMatchObject({ weight: 45, weightUnit: "lb", reps: 10, sets: 3 });
    expect(bench).toMatchObject({ weight: 145, weightUnit: "lb", reps: 10, sets: null });
  });

  it("returns independent objects — mutating one never touches the next", () => {
    const segs = splitLiftingSegments(REPORTED_MESSAGE);
    segs[0].sets = 99;
    expect(segs[1].sets).toBeNull();
    expect(splitLiftingSegments(REPORTED_MESSAGE)[0].sets).toBe(3);
  });

  it("finds no segments in a pure cardio message", () => {
    expect(splitLiftingSegments("I ran a mile and I walked for a mile")).toHaveLength(0);
  });
});

describe("scopeLiftingValues — the reported bug", () => {
  // What the model emitted: "three times" leaked onto the bench press.
  const modelDumbbell = { activityType: "dumbbell", exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 };
  const modelBench = { activityType: "bench press", exercise: "Bench Press", weight: 145, reps: 10, sets: 3 };

  function scopeBoth() {
    const claimedIndexes = new Set<number>();
    const dumbbell = scopeLiftingValues({ message: REPORTED_MESSAGE, trackerName: "Lifting", values: modelDumbbell, claimedIndexes });
    const bench = scopeLiftingValues({ message: REPORTED_MESSAGE, trackerName: "Lifting", values: modelBench, claimedIndexes });
    return { dumbbell: dumbbell.values, bench: bench.values, dumbbellRes: dumbbell, benchRes: bench };
  }

  it("saves the exact two lifting records the user described", () => {
    const { dumbbell, bench } = scopeBoth();

    expect(dumbbell.weight).toBe(45);
    expect(dumbbell.reps).toBe(10);
    expect(dumbbell.sets).toBe(3);
    expect(dumbbell.weightUnit).toBe("lb");

    expect(bench.weight).toBe(145);
    expect(bench.reps).toBe(10);
    expect(bench.weightUnit).toBe("lb");
    // The user never gave a bench-press set count — nothing may be carried in.
    expect(liftingRecordFromValues(bench).sets).toBeNull();
    expect("sets" in bench).toBe(false);
  });

  it("reports the leaked field it dropped", () => {
    const { benchRes } = scopeBoth();
    expect(benchRes.matched).toBe(true);
    expect(benchRes.dropped).toContain("sets");
    expect(benchRes.clause).toBe("bench pressed 145 pounds 10 reps each");
  });

  it("keeps the exercise identity of each entry intact", () => {
    const { dumbbell, bench } = scopeBoth();
    expect(dumbbell.exercise).toBe("Dumbbells");
    expect(bench.exercise).toBe("Bench Press");
  });

  it("never mutates the caller's values object", () => {
    scopeBoth();
    expect(modelBench.sets).toBe(3); // the original is untouched…
    expect(scopeBoth().bench).not.toBe(modelBench); // …and a new object comes back
  });
});

describe("scopeLiftingValues — field leakage in both directions", () => {
  it("sets specified for only the FIRST exercise", () => {
    const msg = "dumbbells 45 pounds 10 reps three times then bench press 145 pounds 10 reps";
    const claimedIndexes = new Set<number>();
    const a = scopeLiftingValues({ message: msg, values: { exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 }, claimedIndexes }).values;
    const b = scopeLiftingValues({ message: msg, values: { exercise: "Bench Press", weight: 145, reps: 10, sets: 3 }, claimedIndexes }).values;
    expect(a.sets).toBe(3);
    expect(liftingRecordFromValues(b).sets).toBeNull();
  });

  it("sets specified for only the SECOND exercise", () => {
    const msg = "dumbbells 45 pounds 10 reps then bench press 145 pounds 10 reps three times";
    const claimedIndexes = new Set<number>();
    const a = scopeLiftingValues({ message: msg, values: { exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 }, claimedIndexes }).values;
    const b = scopeLiftingValues({ message: msg, values: { exercise: "Bench Press", weight: 145, reps: 10, sets: 3 }, claimedIndexes }).values;
    expect(liftingRecordFromValues(a).sets).toBeNull();
    expect(b.sets).toBe(3);
  });

  it("neither exercise specifying sets", () => {
    const msg = "dumbbells 45 pounds 10 reps and bench press 145 pounds 10 reps";
    const claimedIndexes = new Set<number>();
    const a = scopeLiftingValues({ message: msg, values: { exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 }, claimedIndexes }).values;
    const b = scopeLiftingValues({ message: msg, values: { exercise: "Bench Press", weight: 145, reps: 10, sets: 3 }, claimedIndexes }).values;
    expect(liftingRecordFromValues(a).sets).toBeNull();
    expect(liftingRecordFromValues(b).sets).toBeNull();
  });

  it("no weight or rep leakage between consecutive exercises", () => {
    const msg = "squats 225 pounds 5 reps three times then curls 30 pounds";
    const claimedIndexes = new Set<number>();
    // The model copied EVERY field from the squat onto the curl.
    const squat = scopeLiftingValues({ message: msg, values: { exercise: "Squats", weight: 225, reps: 5, sets: 3 }, claimedIndexes }).values;
    const curl = scopeLiftingValues({ message: msg, values: { exercise: "Curls", weight: 225, reps: 5, sets: 3 }, claimedIndexes }).values;
    expect(squat).toMatchObject({ weight: 225, reps: 5, sets: 3 });
    expect(curl.weight).toBe(30);
    expect(liftingRecordFromValues(curl).reps).toBeNull();
    expect(liftingRecordFromValues(curl).sets).toBeNull();
  });

  it("corrects a weight the model attributed to the wrong exercise", () => {
    const msg = "bench press 145 pounds 10 reps and squats 225 pounds 5 reps";
    const claimedIndexes = new Set<number>();
    const bench = scopeLiftingValues({ message: msg, values: { exercise: "Bench Press", weight: 145, reps: 10 }, claimedIndexes }).values;
    const squat = scopeLiftingValues({ message: msg, values: { exercise: "Squats", weight: 145, reps: 10 }, claimedIndexes }).values;
    expect(bench.weight).toBe(145);
    expect(squat.weight).toBe(225);
    expect(squat.reps).toBe(5);
  });

  it("passes values through untouched when no clause matches the exercise", () => {
    const res = scopeLiftingValues({
      message: "bench press 145 pounds 10 reps and squats 225 pounds",
      values: { exercise: "Leg Press", weight: 300, reps: 8, sets: 4 },
    });
    expect(res.matched).toBe(false);
    expect(res.values).toEqual({ exercise: "Leg Press", weight: 300, reps: 8, sets: 4 });
  });
});

describe("isLiftingEntry — cardio stays out of the lifting path", () => {
  it("recognises strength-shaped entries", () => {
    expect(isLiftingEntry("Lifting", { exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 })).toBe(true);
    expect(isLiftingEntry("Bench Press", { weight: 145, reps: 10 })).toBe(true);
    expect(isLiftingEntry("Lifting", { exercise: "Pushups", reps: 20 })).toBe(true);
  });

  it("never claims a running, walking or body-weight entry", () => {
    expect(isLiftingEntry("Running", { distance: 1, duration: 10, caloriesBurned: 113 })).toBe(false);
    expect(isLiftingEntry("Walking", { distance: 1, steps: 2100 })).toBe(false);
    expect(isLiftingEntry("Weight", { weight: 180 })).toBe(false);
    expect(isLiftingEntry("Hydration", { ounces: 24 })).toBe(false);
  });
});

describe("rendering the mobile cards", () => {
  it("renders the two reported cards exactly as specified", () => {
    const dumbbell = liftingRecordFromValues({ exercise: "Dumbbells", weight: 45, weightUnit: "lb", reps: 10, sets: 3 });
    const bench = liftingRecordFromValues({ exercise: "Bench Press", weight: 145, weightUnit: "lb", reps: 10 });

    expect(formatLiftingDetail(dumbbell)).toBe("45 lb · 3 sets × 10 reps");
    expect(liftingSetsNote(dumbbell)).toBeNull();

    expect(formatLiftingDetail(bench)).toBe("145 lb · 10 reps");
    expect(liftingSetsNote(bench)).toBe("Sets not specified");
  });

  it("defaults the unit to lb when the entry has none", () => {
    expect(formatLiftingDetail(liftingRecordFromValues({ exercise: "Squats", weight: 225, reps: 5, sets: 3 })))
      .toBe("225 lb · 3 sets × 5 reps");
  });

  it("never hides the set count behind other fields", () => {
    // The old card joined the first four values only, so `sets` fell off the
    // end of {activityType, exercise, weight, reps, sets}.
    const rec = liftingRecordFromValues({ activityType: "dumbbell", exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 });
    expect(formatLiftingDetail(rec)).toContain("3 sets");
  });
});
