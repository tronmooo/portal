import { describe, it, expect } from "vitest";
import { classifyTrackerPresentation } from "../shared/tracker-presentation";

// The dynamic tracker engine: from ANY tracker's fields/category/name, derive
// the right metric kind, unit, aggregation, chart style, and KPI cards — so the
// UI adapts automatically instead of hardcoding a component per type.

const T = (over: any) => classifyTrackerPresentation(over);

describe("classifyTrackerPresentation — covers the data variations", () => {
  it("medication (category) → adherence", () => {
    const p = T({ name: "Lisinopril", category: "medication", fields: [{ name: "dosage", type: "text" }, { name: "taken", type: "boolean" }] });
    expect(p.metricKind).toBe("adherence");
    expect(p.chartStyle).toBe("adherence");
    expect(p.kpis).toContain("adherencePct");
  });

  it("supplement by FIELDS even when mis-categorized (Fish Oil) → adherence", () => {
    const p = T({ name: "Fish Oil", category: "custom", fields: [{ name: "drug", type: "text" }, { name: "dosage", type: "text" }, { name: "taken", type: "text" }] });
    expect(p.metricKind).toBe("adherence");
  });

  it("supplement by NAME (Multivitamin) → adherence", () => {
    const p = T({ name: "Multivitamin", category: "health", fields: [{ name: "value", type: "number" }] });
    expect(p.metricKind).toBe("adherence");
  });

  it("blood pressure → dual systolic/diastolic", () => {
    const p = T({ name: "Blood Pressure", category: "health", unit: "mmHg", fields: [{ name: "systolic", type: "number", isPrimary: true }, { name: "diastolic", type: "number" }] });
    expect(p.metricKind).toBe("dual");
    expect(p.chartStyle).toBe("dual");
    expect(p.unit).toBe("mmHg");
  });

  it("heart rate → measurement in bpm (NOT confused with BP)", () => {
    const p = T({ name: "Heart Rate", category: "health", fields: [{ name: "bpm", type: "number", isPrimary: true }] });
    expect(p.metricKind).toBe("measurement");
    expect(p.chartStyle).toBe("line");
    expect(p.unit).toBe("bpm");
  });

  it("hydration (ounces) → additive daily total (bars)", () => {
    const p = T({ name: "Hydration", category: "health", unit: "oz", fields: [{ name: "ounces", type: "number", isPrimary: true }, { name: "glasses", type: "number" }] });
    expect(p.metricKind).toBe("additive");
    expect(p.aggregation).toBe("sum");
    expect(p.chartStyle).toBe("bar");
    expect(p.kpis).toEqual(["total", "avgPerActive", "peak", "daysLogged"]);
  });

  it("weight → measurement (line, latest/range)", () => {
    const p = T({ name: "Weight", category: "health", unit: "lbs", fields: [{ name: "weight", type: "number", isPrimary: true }] });
    expect(p.metricKind).toBe("measurement");
    expect(p.aggregation).toBe("last");
    expect(p.kpis).toEqual(["latest", "average", "low", "high"]);
  });

  it("calories / nutrition macro → additive (bars)", () => {
    const p = T({ name: "Calories", category: "nutrition", fields: [{ name: "calories", type: "number", isPrimary: true }] });
    expect(p.metricKind).toBe("additive");
    expect(p.chartStyle).toBe("bar");
  });

  it("running distance → additive (weekly volume)", () => {
    const p = T({ name: "Running", category: "fitness", unit: "miles", fields: [{ name: "distance", type: "number", isPrimary: true }] });
    expect(p.metricKind).toBe("additive");
  });

  it("sleep → measurement (hours, line)", () => {
    const p = T({ name: "Sleep", category: "health", unit: "hours", fields: [{ name: "hours", type: "number", isPrimary: true }] });
    expect(p.metricKind).toBe("measurement");
  });

  it("mood / rating → categorical (line on a scale)", () => {
    const p = T({ name: "Mood", category: "mental", fields: [{ name: "rating", type: "number", isPrimary: true }] });
    expect(p.metricKind).toBe("categorical");
    expect(p.chartStyle).toBe("line");
  });

  it("unit is inferred when the tracker doesn't declare one", () => {
    expect(T({ name: "Steps", category: "fitness", fields: [{ name: "steps", type: "number", isPrimary: true }] }).unit).toBe("steps");
    expect(T({ name: "Glucose", category: "health", fields: [{ name: "glucose", type: "number", isPrimary: true }] }).unit).toBe("mg/dL");
  });

  it("text-only tracker with no numeric field → unknown/none (graceful)", () => {
    const p = T({ name: "Journal", category: "custom", fields: [{ name: "notes", type: "text" }] });
    expect(p.metricKind).toBe("unknown");
    expect(p.chartStyle).toBe("none");
  });
});
