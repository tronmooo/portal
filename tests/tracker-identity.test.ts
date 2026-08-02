import { describe, it, expect } from "vitest";
import {
  trackerIdentityKey, trackerNamesMatch, findIdentityMatches,
  trackerDomainsCompatible, isBodyWeightName, bodyWeightWorkoutReroute,
} from "@shared/tracker-identity";

// Root-cause guard for the duplicate-tracker bug: the same subject arriving with
// different wording ("Multivitamin" vs "Supplement Multivitamin") must collapse
// to one identity so it reuses the existing tracker instead of duplicating.
describe("trackerIdentityKey", () => {
  it("collapses supplement wording variations to one key", () => {
    const k = trackerIdentityKey("Multivitamin");
    expect(trackerIdentityKey("Supplement Multivitamin")).toBe(k);
    expect(trackerIdentityKey("Daily Multivitamin")).toBe(k);
    expect(trackerIdentityKey("My Multivitamin Supplement")).toBe(k);
    expect(trackerIdentityKey("Multivitamin (2)")).toBe(k);
  });

  it("collapses Fish Oil wording variations", () => {
    const k = trackerIdentityKey("Fish Oil");
    expect(k).toBe("fishoil");
    expect(trackerIdentityKey("Fish Oil Supplement")).toBe(k);
    expect(trackerIdentityKey("Daily Fish Oil softgel")).toBe(k);
  });

  it("keeps distinct subjects distinct", () => {
    expect(trackerIdentityKey("Vitamin D")).not.toBe(trackerIdentityKey("Vitamin C"));
    expect(trackerIdentityKey("Multivitamin")).not.toBe(trackerIdentityKey("Fish Oil"));
    expect(trackerIdentityKey("Amoxicillin")).not.toBe(trackerIdentityKey("Lisinopril"));
  });

  it("falls back to a stable key when the name is all noise words", () => {
    expect(trackerIdentityKey("Supplements")).toBeTruthy();
    expect(trackerIdentityKey("My Meds")).toBeTruthy();
  });
});

describe("trackerNamesMatch", () => {
  it("matches supplement wording variations", () => {
    expect(trackerNamesMatch("Multivitamin", "Supplement Multivitamin")).toBe(true);
    expect(trackerNamesMatch("Multivitamin", "Daily Multivitamin")).toBe(true);
    expect(trackerNamesMatch("Fish Oil", "Fish Oil Supplement")).toBe(true);
  });

  it("matches compound names by containment", () => {
    expect(trackerNamesMatch("Bench Press", "Morning Bench Press")).toBe(true);
  });

  it("does NOT match unrelated trackers", () => {
    expect(trackerNamesMatch("Leg Press", "Bench Press")).toBe(false);
    expect(trackerNamesMatch("Multivitamin", "Fish Oil")).toBe(false);
    expect(trackerNamesMatch("Running", "Cycling")).toBe(false);
    expect(trackerNamesMatch("Vitamin D", "Vitamin C")).toBe(false);
  });

  it("short fragments cannot swallow other names", () => {
    // "oil" must not match "Fish Oil" as a standalone tracker fragment.
    expect(trackerNamesMatch("Oil", "Fish Oil")).toBe(false);
    expect(trackerNamesMatch("Run", "Marathon Run")).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(trackerNamesMatch("", "Multivitamin")).toBe(false);
    expect(trackerNamesMatch(null, undefined)).toBe(false);
  });
});

describe("findIdentityMatches", () => {
  const trackers = [
    { id: "mv", name: "Multivitamin", linkedProfiles: ["self"] },
    { id: "fo", name: "Fish Oil", linkedProfiles: ["self"] },
    { id: "run", name: "Running", linkedProfiles: ["self"] },
  ];

  it("finds the existing Multivitamin tracker for a worded variant", () => {
    const m = findIdentityMatches(trackers, "Supplement Multivitamin");
    expect(m.map((t) => t.id)).toEqual(["mv"]);
  });

  it("returns nothing for a genuinely new subject", () => {
    expect(findIdentityMatches(trackers, "Creatine")).toEqual([]);
  });
});

// ── Domain guards (user report 2026-08-02) ──────────────────────────────────
// Containment is right for supplements but was merging two families it should
// never touch: a workout into the body-weight tracker, and a lift variant into
// the base lift.
describe("body weight is never an activity", () => {
  it("does not match the Weight tracker to a workout", () => {
    // "weight" ⊂ "weightlifting" — this containment logged a 45-minute lifting
    // session into the body-weight tracker and added sets/reps/duration to it.
    expect(trackerNamesMatch("Weight", "Weight Lifting")).toBe(false);
    expect(trackerNamesMatch("Weight", "Weighted Pull-Ups")).toBe(false);
    expect(trackerNamesMatch("Weight", "Weight Training")).toBe(false);
    expect(trackerNamesMatch("Weight", "Lifting")).toBe(false);
    expect(trackerDomainsCompatible("Weight", "Weight Lifting")).toBe(false);
  });

  it("still matches genuine body-weight wording", () => {
    expect(trackerNamesMatch("Weight", "Body Weight")).toBe(true);
    expect(trackerNamesMatch("Weight", "My Weight")).toBe(true);
    expect(trackerNamesMatch("Weight", "Weight (2)")).toBe(true);
    expect(isBodyWeightName("Weight")).toBe(true);
    expect(isBodyWeightName("Weight Lifting")).toBe(false);
  });
});

describe("each exercise variant keeps its own tracker", () => {
  it("does not fold a variant into the base lift", () => {
    expect(trackerNamesMatch("Bench Press", "Incline Bench Press")).toBe(false);
    expect(trackerNamesMatch("Bench Press", "Dumbbell Bench Press")).toBe(false);
    expect(trackerNamesMatch("Bench Press", "Close Grip Bench Press")).toBe(false);
    expect(trackerNamesMatch("Press", "Shoulder Press")).toBe(false);
    expect(trackerNamesMatch("Curls", "Bicep Curls")).toBe(false);
    expect(trackerNamesMatch("Row", "Seated Cable Row")).toBe(false);
  });

  it("keeps the distinct presses distinct", () => {
    const presses = ["Bench Press", "Incline Dumbbell Press", "Shoulder Press", "Leg Press"];
    for (const a of presses) {
      for (const b of presses) {
        if (a !== b) expect(trackerNamesMatch(a, b), `${a} vs ${b}`).toBe(false);
      }
    }
  });

  it("still collapses wording that does NOT change the exercise", () => {
    expect(trackerNamesMatch("Bench Press", "Morning Bench Press")).toBe(true);
    expect(trackerNamesMatch("Bench Press", "Bench Press (2)")).toBe(true);
    expect(trackerNamesMatch("Bench Press", "My Bench Press Log")).toBe(true);
    // Legacy per-person names must still find their tracker.
    expect(trackerNamesMatch("Bench Press", "Bench Press - Bob")).toBe(true);
  });

  it("leaves the supplement behavior it was built for intact", () => {
    expect(trackerNamesMatch("Multivitamin", "Supplement Multivitamin")).toBe(true);
    expect(trackerNamesMatch("Fish Oil", "Fish Oil Supplement")).toBe(true);
    expect(trackerNamesMatch("Creatine", "Creatine Monohydrate")).toBe(true);
  });
});

describe("bodyWeightWorkoutReroute", () => {
  it("sends a workout addressed to Weight to its own tracker", () => {
    // The exact entry found in the database, sitting in the Weight tracker.
    expect(bodyWeightWorkoutReroute("Weight", {
      duration: 45, intensity: "moderate", activityType: "weight lifting", caloriesBurned: 270,
    })).toBe("Weight Lifting");
  });

  it("sends a lift to the exercise's own tracker, load and all", () => {
    // `weight` here is the bar, not the person — it must still reroute.
    expect(bodyWeightWorkoutReroute("Weight", {
      exercise: "Incline Dumbbell Press", weight: 80, reps: 8, sets: 3,
    })).toBe("Incline Dumbbell Press");
  });

  it("leaves a real scale reading alone", () => {
    expect(bodyWeightWorkoutReroute("Weight", { weight: 184.2 })).toBeNull();
    expect(bodyWeightWorkoutReroute("Weight", { weight: 184.2, _notes: "after the gym" })).toBeNull();
    // Weighed in after a workout: the reading is real, so it stays.
    expect(bodyWeightWorkoutReroute("Weight", { weight: 183.8, activityType: "cardio" })).toBeNull();
  });

  it("never touches a tracker that isn't body weight", () => {
    expect(bodyWeightWorkoutReroute("Bench Press", { weight: 185, reps: 5, sets: 3 })).toBeNull();
    expect(bodyWeightWorkoutReroute("Running", { distance: 3.2, duration: 28 })).toBeNull();
  });

  it("falls back to a generic name when the workout is unnamed", () => {
    expect(bodyWeightWorkoutReroute("Weight", { duration: 45, caloriesBurned: 270 })).toBe("Workout");
    expect(bodyWeightWorkoutReroute("Weight", { exercise: "weight", sets: 3, reps: 10, weightLbs: 50 })).toBe("Workout");
  });
});
