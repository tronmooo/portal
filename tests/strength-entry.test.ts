import { describe, it, expect } from "vitest";
import {
  parseSetList, formatSetList, readStrengthEntry, expandStrengthSetLists,
  isStrengthShaped, isWeightFieldName, isRepsFieldName, isSetsFieldName,
} from "../shared/strength-entry";

// Regression for the 2026-08-02 report: the Incline Dumbbell Press card read
// "3 lbs" and Shoulder Press read "2 lbs" — those numbers were the SET COUNTS,
// stamped with a hardcoded "lbs". Root cause: the chat logged the load as a
// per-set string ("70/80/80"), which nothing could read as a number, so the
// card fell back to any number it could find and labeled it pounds.
//
// These are the exact entries from the two trackers in the report.
const SHOULDER_PRESS = {
  reps: "12/10", sets: 2, notes: "60s×12, 70s×10", weight: "60/70",
  intensity: "moderate", totalVolume: 1440, activityType: "Shoulder Press", caloriesBurned: 35,
};
const INCLINE_PRESS = {
  reps: "10/8/6", sets: 3, notes: "70s×10, 80s×8, 80s×6", weight: "70/80/80",
  intensity: "high", totalVolume: 2100, activityType: "Incline Dumbbell Press", caloriesBurned: 45,
};
// The same workout logged the day before under a different key spelling.
const INCLINE_PRESS_LBS_KEY = {
  reps: "10/8/6", sets: 3, exercise: "Incline Dumbbell Press",
  intensity: "high", weightLbs: "70/80/80", caloriesBurned: 45,
};

describe("parseSetList", () => {
  it("parses slash- and comma-separated per-set values", () => {
    expect(parseSetList("70/80/80")).toEqual([70, 80, 80]);
    expect(parseSetList("60/70")).toEqual([60, 70]);
    expect(parseSetList("70, 80, 80")).toEqual([70, 80, 80]);
    expect(parseSetList("70lb/80lb")).toEqual([70, 80]);
    expect(parseSetList("22.5/25")).toEqual([22.5, 25]);
  });

  it("rejects anything that is not a clean list of numbers", () => {
    expect(parseSetList("70")).toBeNull();          // a single value is not a list
    expect(parseSetList("heavy/light")).toBeNull();
    expect(parseSetList("70/")).toBeNull();         // handled as one part
    expect(parseSetList("70/eighty")).toBeNull();
    expect(parseSetList(70)).toBeNull();            // already a number
    expect(parseSetList(null)).toBeNull();
    expect(parseSetList("")).toBeNull();
  });
});

describe("field-name predicates", () => {
  it("recognises every spelling of the load field", () => {
    for (const k of ["weight", "weightLbs", "weight_lbs", "lbs", "kg", "load", "bodyWeight"]) {
      expect(isWeightFieldName(k)).toBe(true);
    }
    // Not a load — these are counts, a derived total, and the per-set detail.
    for (const k of ["sets", "reps", "totalVolume", "caloriesBurned", "weightPerSet"]) {
      expect(isWeightFieldName(k)).toBe(false);
    }
    expect(isRepsFieldName("reps")).toBe(true);
    expect(isSetsFieldName("sets")).toBe(true);
    expect(isRepsFieldName("sets")).toBe(false);
  });
});

describe("readStrengthEntry", () => {
  it("reads the top set out of per-set lists (the reported entries)", () => {
    const r = readStrengthEntry(INCLINE_PRESS);
    expect(r.weight).toBe(80);            // heaviest set, NOT the set count
    expect(r.weightKey).toBe("weight");
    expect(r.weightPerSet).toEqual([70, 80, 80]);
    expect(r.reps).toBe(8);               // reps done AT the heaviest set (80×8)
    expect(r.repsPerSet).toEqual([10, 8, 6]);
    expect(r.sets).toBe(3);

    const s = readStrengthEntry(SHOULDER_PRESS);
    expect(s.weight).toBe(70);
    expect(s.reps).toBe(10);
    expect(s.sets).toBe(2);
  });

  it("never reports a set/rep count as the weight", () => {
    // No load logged at all — weight must stay null rather than borrow `sets`.
    const r = readStrengthEntry({ sets: 3, reps: 10, caloriesBurned: 45 });
    expect(r.weight).toBeNull();
    expect(r.weightKey).toBeNull();
    expect(r.sets).toBe(3);
    expect(r.reps).toBe(10);
  });

  it("reads any spelling of the load field and reports which one it used", () => {
    const r = readStrengthEntry(INCLINE_PRESS_LBS_KEY);
    expect(r.weight).toBe(80);
    expect(r.weightKey).toBe("weightLbs"); // so the caller resolves THAT field's unit
    const scalar = readStrengthEntry({ weightLbs: 50, sets: 3, reps: 10 });
    expect(scalar.weight).toBe(50);
    expect(scalar.reps).toBe(10);
  });

  it("prefers `weight` when an entry carries two spellings", () => {
    const r = readStrengthEntry({ weight: 100, weightLbs: 50, reps: 5, sets: 1 });
    expect(r.weight).toBe(100);
    expect(r.weightKey).toBe("weight");
  });

  it("computes volume exactly per set, and by multiplication for scalars", () => {
    // 70×10 + 80×8 + 80×6 = 1820. (The chat had stored 2100 on this entry —
    // it did the multiplication itself and got it wrong.)
    expect(readStrengthEntry({ ...INCLINE_PRESS, totalVolume: undefined }).totalVolume).toBe(1820);
    // 60×12 + 70×10 = 1420 (the chat had stored 1440).
    expect(readStrengthEntry({ ...SHOULDER_PRESS, totalVolume: undefined }).totalVolume).toBe(1420);
    expect(readStrengthEntry({ weight: 185, reps: 5, sets: 3 }).totalVolume).toBe(2775);
    // An explicit total is never overwritten.
    expect(readStrengthEntry({ weight: 185, reps: 5, sets: 3, totalVolume: 9 }).totalVolume).toBe(9);
  });

  it("does not partially parse a list into a number (the parseFloat trap)", () => {
    // parseFloat("70/80/80") === 70 — a silent wrong answer. Lists go through
    // parseSetList or nothing.
    const r = readStrengthEntry({ weight: "70/80/80" });
    expect(r.weightPerSet).toEqual([70, 80, 80]);
    expect(r.weight).toBe(80);
    // A genuinely unreadable value yields null, not a guess.
    expect(readStrengthEntry({ weight: "heavy", reps: 5 }).weight).toBeNull();
  });
});

describe("isStrengthShaped", () => {
  it("is true for lift entries and false for everything else", () => {
    expect(isStrengthShaped(INCLINE_PRESS)).toBe(true);
    expect(isStrengthShaped({ weightLbs: 50, sets: 3, reps: 10 })).toBe(true);
    expect(isStrengthShaped({ weight: 184 })).toBe(false);              // body weight log
    expect(isStrengthShaped({ systolic: 120, diastolic: 80 })).toBe(false);
    expect(isStrengthShaped({ distance: 3.2, duration: 28 })).toBe(false);
    expect(isStrengthShaped(null)).toBe(false);
  });
});

describe("expandStrengthSetLists", () => {
  it("turns per-set strings into numbers without losing the detail", () => {
    const { values, warnings } = expandStrengthSetLists(INCLINE_PRESS);
    expect(values.weight).toBe(80);
    expect(values.weightPerSet).toBe("70/80/80");
    expect(values.reps).toBe(8);
    expect(values.repsPerSet).toBe("10/8/6");
    expect(values.sets).toBe(3);
    expect(values.notes).toBe("70s×10, 80s×8, 80s×6"); // untouched
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("corrects a total volume the model got wrong", () => {
    // The chat stored totalVolume 2100 on this entry; the sets it recorded
    // add up to 70×10 + 80×8 + 80×6 = 1820.
    expect(expandStrengthSetLists(INCLINE_PRESS).values.totalVolume).toBe(1820);
    expect(expandStrengthSetLists(SHOULDER_PRESS).values.totalVolume).toBe(1420);
  });

  it("keeps the load under whatever key it arrived on", () => {
    const { values } = expandStrengthSetLists(INCLINE_PRESS_LBS_KEY);
    expect(values.weightLbs).toBe(80);
    expect(values.weightLbsPerSet).toBe("70/80/80");
  });

  it("derives the set count from the list when it wasn't stated", () => {
    const { values } = expandStrengthSetLists({ weight: "70/80/80", reps: "10/8/6" });
    expect(values.sets).toBe(3);
  });

  it("leaves non-lift entries completely alone", () => {
    // "120/80" must never be read as a two-set list.
    const bp = { systolic: 120, diastolic: 80, reading: "120/80" };
    expect(expandStrengthSetLists(bp).values).toEqual(bp);
    const scalars = { weight: 185, reps: 5, sets: 3 };
    expect(expandStrengthSetLists(scalars).values).toEqual(scalars);
  });
});
