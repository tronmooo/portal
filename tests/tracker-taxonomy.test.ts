// Pins the tracker taxonomy: one shape catalog decides what a tracker IS, and
// one resolver decides what category it belongs to.
//
// QA report 2026-07-25:
//   "Tire Pressure for the Ford F150 is rendered as a lifting tracker:
//    'Lifted 35 lbs.' Tire pressure should use PSI and vehicle-specific
//    language."
//   "'Pushups' is classified under Other instead of Fitness."
import { describe, it, expect } from "vitest";
import { inferTrackerShape, inferTrackerShapeId } from "../shared/tracker-shapes";
import {
  resolveTrackerCategory,
  categoryNeedsResolution,
  normalizeCategory,
  classifyEntity,
} from "../shared/entity-classify";
import { classifyTrackerPresentation } from "../shared/tracker-presentation";

describe("shape catalog keeps domains apart", () => {
  it("identifies tire pressure as a vehicle PSI tracker, not a press", () => {
    expect(inferTrackerShapeId("Tire Pressure")).toBe("tire_pressure");
    const fields = inferTrackerShape("Tire Pressure")!;
    const primary = fields.find(f => f.isPrimary)!;
    expect(primary.name).toBe("pressure");
    expect(primary.unit).toBe("PSI");
    // Crucially it is NOT the lift shape, whose primary is weight in lbs.
    expect(fields.some(f => f.name === "weight")).toBe(false);
  });

  it("still routes real presses to the lift shape", () => {
    expect(inferTrackerShapeId("Bench Press")).toBe("bench_press");
    expect(inferTrackerShapeId("Overhead Press")).toBe("overhead");
    expect(inferTrackerShape("Bench Press")!.some(f => f.name === "weight")).toBe(true);
  });

  it("keeps blood pressure a paired vitals reading", () => {
    expect(inferTrackerShapeId("Blood Pressure")).toBe("blood_pressure");
    // A tracker named for either half of the pair resolves to the SAME shape,
    // so systolic and diastolic can never become two separate metrics.
    expect(inferTrackerShapeId("Systolic")).toBe("blood_pressure");
    expect(inferTrackerShapeId("Diastolic")).toBe("blood_pressure");
    const bp = inferTrackerShape("Systolic")!;
    expect(bp.map(f => f.name)).toEqual(expect.arrayContaining(["systolic", "diastolic"]));
  });

  it("renders a systolic-named tracker as one dual series, not a lone number", () => {
    const p = classifyTrackerPresentation({
      name: "Systolic",
      category: "health",
      fields: inferTrackerShape("Systolic")!,
    });
    expect(p.metricKind).toBe("dual");
    expect(p.chartStyle).toBe("dual");
    expect(p.unit).toBe("mmHg");
  });

  it("does not let a health tracker pick up vehicle units", () => {
    // "Fish Oil" must not become motor oil quarts.
    expect(inferTrackerShapeId("Fish Oil", "supplement")).toBe("supplement");
    expect(inferTrackerShapeId("Fish Oil", "medication")).toBe("supplement");
  });

  it("gives a medication tracker a dose field with a unit", () => {
    // "Wellbutrin 500 lacks a visible unit" — the shape supplies mg.
    const fields = inferTrackerShape("Wellbutrin", "medication")
      ?? inferTrackerShape("medication", "medication")!;
    const dosage = fields.find(f => f.name === "dosage");
    expect(dosage?.unit).toBe("mg");
  });
});

describe("resolveTrackerCategory — one precedence order for every write path", () => {
  it("files Pushups under Fitness even when the caller says 'other'", () => {
    // The reported bug: a model-supplied "other" beat a HIGH-confidence
    // dictionary match, and "other" isn't even a valid category.
    expect(classifyEntity("Pushups").category).toBe("fitness");
    expect(resolveTrackerCategory("Pushups", { supplied: "other" })).toMatchObject({
      category: "fitness",
      source: "dictionary",
    });
    expect(resolveTrackerCategory("Pushups", { supplied: "custom" }).category).toBe("fitness");
    expect(resolveTrackerCategory("Pushups").category).toBe("fitness");
  });

  it("never emits an invalid category", () => {
    expect(resolveTrackerCategory("Wingsuit Flying", { supplied: "other" }).category).toBe("custom");
    expect(resolveTrackerCategory("Wingsuit Flying", { supplied: "" }).category).toBe("custom");
    expect(resolveTrackerCategory("Wingsuit Flying", { supplied: 42 as any }).category).toBe("custom");
  });

  it("accepts the model's judgment for entities the dictionaries don't know", () => {
    const r = resolveTrackerCategory("Wingsuit Flying", { supplied: "fitness" });
    expect(r).toMatchObject({ category: "fitness", source: "supplied", remember: true });
  });

  it("prefers a dictionary match over a stale learned mapping", () => {
    const r = resolveTrackerCategory("Bench Press", { learned: "habit" });
    expect(r).toMatchObject({ category: "fitness", source: "dictionary" });
  });

  it("uses a learned mapping when nothing else knows the entity", () => {
    const r = resolveTrackerCategory("Wingsuit Flying", { learned: "lifestyle" });
    expect(r).toMatchObject({ category: "lifestyle", source: "learned", remember: false });
  });

  it("does not re-remember what it already knew", () => {
    expect(resolveTrackerCategory("Pushups", { supplied: "fitness" }).remember).toBe(false);
  });
});

describe("categoryNeedsResolution / normalizeCategory", () => {
  it("treats junk values as unresolved so the self-heal pass rescues them", () => {
    expect(categoryNeedsResolution("other")).toBe(true); // the stranded case
    expect(categoryNeedsResolution("custom")).toBe(true);
    expect(categoryNeedsResolution(null)).toBe(true);
    expect(categoryNeedsResolution("")).toBe(true);
    expect(categoryNeedsResolution("fitness")).toBe(false);
  });

  it("normalizes case and rejects unknown names", () => {
    expect(normalizeCategory("Fitness")).toBe("fitness");
    expect(normalizeCategory(" MEDICATION ")).toBe("medication");
    expect(normalizeCategory("other")).toBeNull();
  });
});
