// Deterministic exercise routing — the backstop behind the "why is it all
// LIFTING?" report (screenshot 2026-07-26).
//
// The prompts ask for one tracker per exercise, but a prompt is a suggestion.
// shared/exercise-routing runs on EVERY tracker write, so a generic bucket name
// with the real exercise in the values gets re-routed no matter which path
// produced it. These tables cover the breadth the user asked for — lifts,
// bodyweight, machines, classes and sports — not just the two in the report.
import { describe, it, expect } from "vitest";
import {
  isGenericWorkoutTracker, exerciseLabelFromValues, titleCaseExercise,
  resolveExerciseTracker,
} from "../shared/exercise-routing";
import { inferTrackerShape, shapeForNewTracker, inferShapeFromValues } from "../shared/tracker-shapes";

describe("isGenericWorkoutTracker", () => {
  const buckets = [
    "Lifting", "lifting", "Weight Lifting", "Weightlifting", "Weights",
    "Strength", "Strength Training", "Resistance Training", "Powerlifting",
    "Workout", "Workouts", "Morning Workout", "Gym", "Gym Session",
    "My Daily Gym Routine", "Exercise", "Fitness", "Cardio", "Sports",
    "Activity", "Conditioning", "Circuit",
  ];
  for (const name of buckets) {
    it(`treats "${name}" as a bucket`, () => {
      expect(isGenericWorkoutTracker(name)).toBe(true);
    });
  }

  const specific = [
    "Bench Press", "Dumbbell Curls", "Romanian Deadlift", "Lat Pulldown",
    "Leg Press", "Hip Thrust", "Face Pulls", "Power Clean", "Pull-Ups",
    "Burpees", "Plank", "Wall Sit", "Elliptical", "Rowing", "Spin Class",
    "Pilates", "Basketball", "Pickleball", "Jiu-Jitsu", "Bouldering",
    // Body-weight measurement — looks bucket-ish, is not.
    "Weight", "Body Weight", "Body Fat",
    // A bucket word plus a real subject is still specific.
    "Strength Circuit Rows", "Gym Bench Press",
  ];
  for (const name of specific) {
    it(`treats "${name}" as specific`, () => {
      expect(isGenericWorkoutTracker(name)).toBe(false);
    });
  }
});

describe("titleCaseExercise", () => {
  const cases: [string, string][] = [
    ["bench press", "Bench Press"],
    ["dumbbell curls", "Dumbbell Curls"],
    ["t-bar row", "T-Bar Row"],
    ["pull-ups", "Pull-Ups"],
    ["romanian deadlift", "Romanian Deadlift"],
    ["rdl", "RDL"],
    ["hiit", "HIIT"],
    ["jiu-jitsu", "Jiu-Jitsu"],
    ["  spin   class ", "Spin Class"],
  ];
  for (const [input, want] of cases) {
    it(`"${input}" → "${want}"`, () => expect(titleCaseExercise(input)).toBe(want));
  }
});

describe("exerciseLabelFromValues", () => {
  it("reads the label from any of the keys a model reaches for", () => {
    expect(exerciseLabelFromValues({ exercise: "Bench Press" })).toBe("Bench Press");
    expect(exerciseLabelFromValues({ activityType: "pickleball" })).toBe("pickleball");
    expect(exerciseLabelFromValues({ movement: "power clean" })).toBe("power clean");
    expect(exerciseLabelFromValues({ lift: "front squat" })).toBe("front squat");
    expect(exerciseLabelFromValues({ activity_type: "rowing" })).toBe("rowing");
    expect(exerciseLabelFromValues({ sport: "bouldering" })).toBe("bouldering");
  });

  it("prefers the most explicit key when several are present", () => {
    expect(exerciseLabelFromValues({ type: "strength", exercise: "Hip Thrust" })).toBe("Hip Thrust");
  });

  it("rejects labels that are themselves buckets or aren't names", () => {
    expect(exerciseLabelFromValues({ activityType: "strength" })).toBeNull();
    expect(exerciseLabelFromValues({ activityType: "workout" })).toBeNull();
    expect(exerciseLabelFromValues({ activityType: "cardio" })).toBeNull();
    expect(exerciseLabelFromValues({ activityType: "3x10" })).toBeNull();
    expect(exerciseLabelFromValues({ activityType: 45 as any })).toBeNull();
    expect(exerciseLabelFromValues({ weight: 110, reps: 10 })).toBeNull();
    expect(exerciseLabelFromValues(null)).toBeNull();
  });
});

describe("resolveExerciseTracker — the reported case and its whole family", () => {
  // Every row: a bucket tracker name + values carrying the real exercise.
  const reroutes: Array<[string, Record<string, any>, string]> = [
    // The exact report
    ["Lifting", { activityType: "Dumbbell Curls", weight: 45, reps: 8, sets: 3 }, "Dumbbell Curls"],
    ["Lifting", { activityType: "Bench Press", weight: 110, reps: 10, sets: 3 }, "Bench Press"],
    // Other lifts, other bucket spellings
    ["Weight Lifting", { exercise: "romanian deadlift", weight: 185 }, "Romanian Deadlift"],
    ["Weights", { movement: "lat pulldown", weight: 120 }, "Lat Pulldown"],
    ["Strength Training", { activityType: "hip thrust", weight: 225 }, "Hip Thrust"],
    ["Gym", { exercise: "leg press", weight: 300, reps: 12 }, "Leg Press"],
    ["Workout", { activityType: "power clean", weight: 135 }, "Power Clean"],
    ["Morning Gym Session", { exercise: "face pulls", weight: 40 }, "Face Pulls"],
    // Bodyweight
    ["Workout", { activityType: "pull-ups", reps: 12, sets: 3 }, "Pull-Ups"],
    ["Exercise", { exercise: "burpees", reps: 50 }, "Burpees"],
    ["Fitness", { activityType: "wall sit", duration: 90 }, "Wall Sit"],
    // Machines & classes
    ["Cardio", { activityType: "elliptical", duration: 30 }, "Elliptical"],
    ["Cardio", { activityType: "stair climber", duration: 20 }, "Stair Climber"],
    ["Workout", { activityType: "spin class", duration: 45 }, "Spin Class"],
    ["Fitness", { activityType: "pilates", duration: 50 }, "Pilates"],
    // Sports
    ["Sports", { activityType: "pickleball", duration: 60 }, "Pickleball"],
    ["Activity", { sport: "jiu-jitsu", duration: 90 }, "Jiu-Jitsu"],
    ["Sports", { activityType: "bouldering", duration: 75 }, "Bouldering"],
    // An exercise the catalog has never heard of still gets its own tracker.
    ["Lifting", { exercise: "Jefferson curl", weight: 65 }, "Jefferson Curl"],
    ["Workout", { activityType: "sandbag over shoulder", reps: 20 }, "Sandbag Over Shoulder"],
  ];
  for (const [bucket, values, want] of reroutes) {
    it(`"${bucket}" + ${JSON.stringify(values).slice(0, 44)}… → "${want}"`, () => {
      expect(resolveExerciseTracker(bucket, values)?.trackerName).toBe(want);
    });
  }

  const leaveAlone: Array<[string, Record<string, any>, string]> = [
    ["Bench Press", { activityType: "bench press", weight: 110 }, "already specific"],
    ["Dumbbell Curls", { weight: 45, reps: 8 }, "already specific, no label"],
    ["Lifting", { duration: 45 }, "no exercise named — the bucket is correct"],
    ["Lifting", { activityType: "strength" }, "label is a bucket too"],
    ["Gym", {}, "empty values"],
    ["Weight", { weight: 178 }, "body-weight measurement, not a workout bucket"],
    ["Running", { distance: 3 }, "specific cardio tracker"],
    ["Nutrition", { item: "Chicken Sandwich" }, "not a workout at all"],
    ["Lifting", { activityType: "  lifting  " }, "label restates the bucket"],
  ];
  for (const [name, values, why] of leaveAlone) {
    it(`leaves "${name}" alone — ${why}`, () => {
      expect(resolveExerciseTracker(name, values)).toBeNull();
    });
  }

  it("reports where the diversion came from, for the audit log", () => {
    const r = resolveExerciseTracker("Lifting", { activityType: "bench press" });
    expect(r).toEqual({ trackerName: "Bench Press", from: "Lifting", via: "activityType" });
  });
});

describe("every routed exercise lands on a shape that makes physical sense", () => {
  const expectations: Array<[string, string[]]> = [
    // Lifts → weight/reps/sets
    ["Bench Press", ["weight", "reps", "sets"]],
    ["Dumbbell Curls", ["weight", "reps", "sets"]],
    ["Hammer Curls", ["weight", "reps", "sets"]],
    ["Romanian Deadlift", ["weight", "reps", "sets"]],
    ["Lat Pulldown", ["weight", "reps", "sets"]],
    ["Leg Press", ["weight", "reps", "sets"]],
    ["Incline Press", ["weight", "reps", "sets"]],
    ["Seated Cable Row", ["weight", "reps", "sets"]],
    ["Lateral Raise", ["weight", "reps", "sets"]],
    ["Tricep Pushdown", ["weight", "reps", "sets"]],
    ["Hip Thrust", ["weight", "reps", "sets"]],
    ["Power Clean", ["weight", "reps", "sets"]],
    ["Chest Fly", ["weight", "reps", "sets"]],
    ["Bulgarian Split Squat", ["weight", "reps", "sets"]],
    // Rep-counted bodyweight → reps/sets, no phantom weight
    ["Pull-Ups", ["reps", "sets"]],
    ["Burpees", ["reps", "sets"]],
    ["Russian Twists", ["reps", "sets"]],
    // Timed holds → seconds
    ["Plank", ["duration", "sets"]],
    ["Wall Sit", ["duration", "sets"]],
    // Cardio & classes → duration
    ["Elliptical", ["duration"]],
    ["Stair Climber", ["duration"]],
    ["Jump Rope", ["duration"]],
    ["Rowing", ["distance", "duration"]],
    ["Hiking", ["distance", "duration"]],
    // Sports → duration + effort
    ["Basketball", ["duration", "caloriesBurned"]],
    ["Pickleball", ["duration", "caloriesBurned"]],
    ["Jiu-Jitsu", ["duration", "caloriesBurned"]],
    ["Bouldering", ["duration", "caloriesBurned"]],
    ["Pilates", ["duration", "caloriesBurned"]],
  ];
  for (const [name, wanted] of expectations) {
    it(`${name} → ${wanted.join("/")}`, () => {
      const fields = (inferTrackerShape(name) || []).map((f: any) => f.name);
      for (const w of wanted) expect(fields, `${name} fields: ${fields.join(",")}`).toContain(w);
    });
  }

  it("keeps rep-only moves free of a weight field", () => {
    expect((inferTrackerShape("Pull-Ups") || []).map((f: any) => f.name)).not.toContain("weight");
  });

  it("does not let lift patterns swallow lookalike trackers", () => {
    // Bare "press"/"row"/"curl" patterns would have broken all three of these.
    const bp = (inferTrackerShape("Blood Pressure") || []).map((f: any) => f.name);
    expect(bp).toContain("systolic");
    const rowing = (inferTrackerShape("Rowing") || []).map((f: any) => f.name);
    expect(rowing).not.toContain("reps");
    const curling = (inferTrackerShape("Curling") || []).map((f: any) => f.name);
    expect(curling).not.toContain("weight");
  });
});

// ── New-tracker field shaping ───────────────────────────────────────────────
// The auto-create path used to build a new tracker's fields VERBATIM from the
// AI's value keys, with no units — which is how a `weightLbs` column with no
// unit came to exist and render as "45 weightLbs". shapeForNewTracker is the
// one helper both create paths now use.
describe("shapeForNewTracker", () => {
  const names = (fields: any[]) => fields.map((f: any) => f.name);
  const unitOf = (fields: any[], name: string) => fields.find((f: any) => f.name === name)?.unit;

  it("gives a known lift canonical fields WITH units, not the raw value keys", () => {
    const fields = shapeForNewTracker("Bench Press", "fitness", {
      activityType: "bench press", weightLbs: 110, reps: 10, sets: 3,
    });
    expect(unitOf(fields, "weight")).toBe("lbs");
    expect(unitOf(fields, "reps")).toBe("reps");
    // The aliased source key must NOT become a second, unit-less column.
    expect(names(fields)).not.toContain("weightLbs");
    // Genuinely extra keys survive as their own fields.
    expect(names(fields)).toContain("activityType");
  });

  it("shapes an exercise the catalog has never heard of from its values", () => {
    const lift = shapeForNewTracker("Jefferson Curl", "fitness", { weight: 65, reps: 10 });
    expect(unitOf(lift, "weight")).toBe("lbs");
    expect(unitOf(lift, "reps")).toBe("reps");

    const repOut = shapeForNewTracker("Sandbag Over Shoulder", "fitness", { reps: 20, sets: 4 });
    expect(unitOf(repOut, "reps")).toBe("reps");
    expect(names(repOut)).not.toContain("weight");

    const sport = shapeForNewTracker("Underwater Hockey", "fitness", { duration: 45, caloriesBurned: 300 });
    expect(unitOf(sport, "duration")).toBe("min");
  });

  it("falls back to the raw keys when the values aren't exercise-shaped", () => {
    const fields = shapeForNewTracker("Mystery Thing", "custom", { note: "hi", widgets: 3 });
    expect(names(fields).sort()).toEqual(["note", "widgets"]);
  });

  it("lets the generic Lifting bucket record a bare duration", () => {
    const fields = shapeForNewTracker("Lifting", "fitness", { duration: 45 });
    expect(unitOf(fields, "duration")).toBe("min");
  });
});

describe("inferShapeFromValues", () => {
  const names = (f: any[] | null) => (f || []).map((x: any) => x.name);
  it("reads weight+reps as a lift, reps alone as a rep-out, duration+effort as a sport", () => {
    expect(names(inferShapeFromValues({ weight: 100, reps: 5 }))).toContain("sets");
    expect(names(inferShapeFromValues({ reps: 20 }))).toEqual(["reps", "sets"]);
    expect(names(inferShapeFromValues({ duration: 30, caloriesBurned: 200 }))).toContain("intensity");
  });
  it("sees through aliased keys", () => {
    expect(names(inferShapeFromValues({ weightLbs: 100, repetitions: 5 }))).toContain("weight");
  });
  it("returns null for non-exercise values", () => {
    expect(inferShapeFromValues({ calories: 430, item: "Sandwich" })).toBeNull();
    expect(inferShapeFromValues({})).toBeNull();
    expect(inferShapeFromValues(null)).toBeNull();
  });
});
