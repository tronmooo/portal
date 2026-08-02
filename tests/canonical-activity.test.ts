// Pins canonical tracker resolution (shared/canonical-activity.ts): unit and
// phrasing variants of the same activity must land on ONE tracker instead of
// spawning "Walking Distance" / "Steps Walked" / "Daily Walk" duplicates.
import { describe, it, expect } from "vitest";
import { resolveCanonicalActivity, redirectWorkoutLog } from "@shared/canonical-activity";

describe("resolveCanonicalActivity", () => {
  it("maps every walking variant to the canonical Walking tracker", () => {
    for (const name of ["Walking Distance", "Walking Miles", "Steps Walked", "Daily Walk", "Walking Activity", "walk", "walked", "went for a walk", "Steps", "stroll"]) {
      expect(resolveCanonicalActivity(name)?.trackerName, name).toBe("Walking");
    }
  });

  it("maps running variants to Running (and beats the walking pattern)", () => {
    for (const name of ["Running", "run", "Morning Jog", "jogging", "ran"]) {
      expect(resolveCanonicalActivity(name)?.trackerName, name).toBe("Running");
    }
  });

  it("maps hydration and sleep variants", () => {
    expect(resolveCanonicalActivity("Water Intake")?.trackerName).toBe("Hydration");
    expect(resolveCanonicalActivity("water")?.trackerName).toBe("Hydration");
    expect(resolveCanonicalActivity("Sleep")?.trackerName).toBe("Sleep");
    expect(resolveCanonicalActivity("napped")?.trackerName).toBe("Sleep");
  });

  it("does not hijack different domains that share a keyword", () => {
    expect(resolveCanonicalActivity("Plant Watering")).toBeNull();
    expect(resolveCanonicalActivity("Dog Walking")).toBeNull();
    expect(resolveCanonicalActivity("Soccer")).toBeNull();
    expect(resolveCanonicalActivity("Cannabis")).toBeNull();
    expect(resolveCanonicalActivity("Guitar Practice")).toBeNull();
    expect(resolveCanonicalActivity("")).toBeNull();
  });
});

// Pins the workout-vs-body-weight guard (2026-08-02 report: Weighted Pull-Ups
// sets were filed into the body-weight "Weight" tracker). A workout-shaped
// entry aimed at a body-weight tracker must redirect to the exercise's own
// tracker — or refuse with a question when no exercise is named.
describe("redirectWorkoutLog", () => {
  it("redirects a sets/reps entry aimed at Weight to the exercise's tracker", () => {
    const r = redirectWorkoutLog("Weight", {
      sets: 3, reps: "8/6/12", weight: "+35/+45/bodyweight", activityType: "Weighted Pull-Ups",
    });
    expect(r).toEqual({ kind: "redirect", trackerName: "Weighted Pull-Ups" });
  });

  it("prefers the exercise field over activityType", () => {
    const r = redirectWorkoutLog("Weight", { sets: 3, exercise: "Bench Press", activityType: "strength" });
    expect(r).toEqual({ kind: "redirect", trackerName: "Bench Press" });
  });

  it("asks for the exercise when a workout names none", () => {
    expect(redirectWorkoutLog("Weight", { sets: 3, reps: 10 })).toEqual({ kind: "needs_exercise" });
  });

  it("covers Body Weight phrasing of the target tracker", () => {
    const r = redirectWorkoutLog("Body Weight", { sets: 5, exercise: "Squats" });
    expect(r).toEqual({ kind: "redirect", trackerName: "Squats" });
  });

  it("leaves genuine weigh-ins alone", () => {
    expect(redirectWorkoutLog("Weight", { weight: 184.2 })).toBeNull();
    expect(redirectWorkoutLog("Weight", { weight: 184.2, notes: "morning" })).toBeNull();
  });

  it("never touches non-weight trackers", () => {
    expect(redirectWorkoutLog("Bench Press", { sets: 3, reps: 5, weight: 135 })).toBeNull();
    expect(redirectWorkoutLog("Weighted Pull-Ups", { sets: 3, reps: "8/6/12" })).toBeNull();
  });
});
