// Guard for the reported bug (screenshot 2026-07-26): "dumbbell curls with
// 45-pound dumbbells for 8 reps, 3 sets" and "bench press at 110 pounds for 10
// reps, 3 sets" BOTH landed in one tracker named LIFTING, with the exercise
// demoted to an `activityType` value. Each lift carries its own weight
// progression, so merging them makes the chart meaningless.
//
// Root cause was contradictory prompt rules: the multi-exercise rule said
// 'Pick the specific exercise name for each trackerName', while the activity
// architecture block said 'Weight Lifting → trackerName: "Lifting"'. These
// tests pin the routing instructions and the identity math that keeps a named
// lift from being absorbed by a generic Lifting tracker.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { trackerNamesMatch } from "../shared/tracker-identity";
import { inferTrackerShape } from "../shared/tracker-shapes";
import { buildExtractionSystemPrompt } from "../server/ai-bulk-log";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("strength routing instructions", () => {
  const engine = read("server/ai-engine.ts");

  it("no longer tells the model to bucket every lift into 'Lifting'", () => {
    expect(engine).not.toContain(`Weight Lifting → trackerName: "Lifting"`);
  });

  it("names a tracker per exercise, with Lifting only as the unnamed fallback", () => {
    expect(engine).toContain(`STRENGTH TRAINING = ONE TRACKER PER EXERCISE`);
    expect(engine).toContain(`trackerName: "Dumbbell Curls"`);
    expect(engine).toContain(`trackerName: "Bench Press"`);
    expect(engine).toMatch(/Only fall back to\s+trackerName "Lifting" when the user names NO exercise at all/);
  });

  it("asks for canonical weight/reps/sets keys, not weightLbs", () => {
    expect(engine).toContain("Use the canonical keys weight / reps / sets for lifts");
  });

  it("the bulk extractor carries the same rule and overrides tracker reuse", () => {
    const prompt = buildExtractionSystemPrompt({
      nowISO: "2026-07-26T12:00:00Z",
      trackerNames: ["Lifting", "Running"],
      profileNames: ["Me"],
      habitNames: [],
    });
    expect(prompt).toContain("one tracker PER EXERCISE");
    expect(prompt).toContain(`trackerName "Dumbbell Curls"`);
    expect(prompt).toContain(`trackerName "Bench Press"`);
    // The reuse rule must not swallow a named lift into the existing bucket.
    expect(prompt).toContain(`an existing "Lifting" tracker is NOT a match for a named exercise`);
  });
});

describe("named lifts stay distinct from a generic Lifting tracker", () => {
  it("does not treat Bench Press / Dumbbell Curls as the Lifting tracker", () => {
    expect(trackerNamesMatch("Bench Press", "Lifting")).toBe(false);
    expect(trackerNamesMatch("Dumbbell Curls", "Lifting")).toBe(false);
  });

  it("keeps the two lifts distinct from each other", () => {
    expect(trackerNamesMatch("Bench Press", "Dumbbell Curls")).toBe(false);
  });

  it("still reuses the same lift under a wordier name", () => {
    expect(trackerNamesMatch("Bench Press", "Morning Bench Press")).toBe(true);
  });

  it("gives each lift the strength shape (weight/reps/sets), not a bare value", () => {
    for (const name of ["Bench Press", "Dumbbell Curls", "Squat", "Deadlift"]) {
      const fields = (inferTrackerShape(name) || []).map((f: any) => f.name);
      expect(fields, `${name} shape`).toContain("weight");
      expect(fields, `${name} shape`).toContain("reps");
      expect(fields, `${name} shape`).toContain("sets");
    }
  });
});
