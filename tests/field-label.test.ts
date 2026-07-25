import { describe, it, expect } from "vitest";
import { humanizeFieldName, trackerFieldLabel } from "../shared/field-label";

describe("humanizeFieldName", () => {
  it("splits camelCase — the exact keys the 2026-07-25 audit saw raw", () => {
    expect(humanizeFieldName("caloriesBurned")).toBe("Calories Burned");
    expect(humanizeFieldName("paceMinutesPerMile")).toBe("Pace Minutes Per Mile");
    expect(humanizeFieldName("heartRate")).toBe("Heart Rate");
    expect(humanizeFieldName("speedMph")).toBe("Speed MPH");
    expect(humanizeFieldName("steps")).toBe("Steps");
  });

  it("handles the snake_case shapes in tracker-shapes.ts", () => {
    expect(humanizeFieldName("heart_rate")).toBe("Heart Rate");
    expect(humanizeFieldName("avg_speed")).toBe("Avg Speed");
    expect(humanizeFieldName("distance")).toBe("Distance");
  });

  it("keeps acronyms and unit tokens uppercase", () => {
    expect(humanizeFieldName("rpe")).toBe("RPE");
    expect(humanizeFieldName("resting_hr")).toBe("Resting HR");
    expect(humanizeFieldName("bmi")).toBe("BMI");
  });

  it("does not mangle already-spaced or PascalCase names", () => {
    expect(humanizeFieldName("Blood Pressure")).toBe("Blood Pressure");
    expect(humanizeFieldName("CaloriesBurned")).toBe("Calories Burned");
  });

  it("returns the key unchanged when there is nothing to split", () => {
    expect(humanizeFieldName("")).toBe("");
    expect(humanizeFieldName("_")).toBe("_");
  });
});

describe("trackerFieldLabel", () => {
  it("prefers an explicit label", () => {
    expect(trackerFieldLabel({ name: "rpe", label: "Effort (1-10)" })).toBe("Effort (1-10)");
  });

  it("falls back to the derived name for blank or missing labels", () => {
    expect(trackerFieldLabel({ name: "caloriesBurned" })).toBe("Calories Burned");
    expect(trackerFieldLabel({ name: "caloriesBurned", label: "   " })).toBe("Calories Burned");
  });
});
