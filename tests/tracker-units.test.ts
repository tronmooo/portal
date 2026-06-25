import { describe, it, expect } from "vitest";
import { resolveTrackerUnit, isAdherenceTracker } from "@shared/tracker-units";
import { classifyTrackerPresentation } from "@shared/tracker-presentation";

// The structural guarantee: there is ONE unit per (tracker, field), and every
// view that needs it gets the SAME value. These tests pin the precedence ladder
// and prove the presentation engine and the resolver never disagree.

describe("resolveTrackerUnit — precedence", () => {
  it("declared field unit always wins", () => {
    const t = { name: "Whatever", category: "custom", fields: [{ name: "x", type: "number", unit: "widgets", isPrimary: true }] };
    expect(resolveTrackerUnit(t, "x")).toBe("widgets");
  });

  it("adherence trackers never carry a guessed physical unit", () => {
    expect(resolveTrackerUnit({ name: "Fish Oil", category: "supplement", fields: [{ name: "dosage", type: "number" }] })).toBe("");
    expect(resolveTrackerUnit({ name: "Multivitamin", category: "health", fields: [{ name: "value", type: "number" }] })).toBe("");
    expect(resolveTrackerUnit({ name: "Amoxicillin", category: "medication", fields: [{ name: "dosage", type: "number" }, { name: "adherence", type: "select" }] })).toBe("");
  });

  it("declared tracker unit applies to the primary metric", () => {
    const t = { name: "Hydration", category: "health", unit: "oz", fields: [{ name: "amount", type: "number", isPrimary: true }] };
    expect(resolveTrackerUnit(t, "amount")).toBe("oz");
  });

  it("canonical field-name table fills in when nothing is declared", () => {
    expect(resolveTrackerUnit({ name: "Steps", fields: [{ name: "steps", type: "number", isPrimary: true }] }, "steps")).toBe("steps");
    expect(resolveTrackerUnit({ name: "Glucose", fields: [{ name: "glucose", type: "number", isPrimary: true }] }, "glucose")).toBe("mg/dL");
    expect(resolveTrackerUnit({ name: "HR", fields: [{ name: "bpm", type: "number", isPrimary: true }] }, "bpm")).toBe("bpm");
  });

  it("uses ONE spelling per unit (no lb/lbs or cal/kcal drift)", () => {
    expect(resolveTrackerUnit({ name: "Weight", fields: [{ name: "weight", type: "number", isPrimary: true }] }, "weight")).toBe("lbs");
    expect(resolveTrackerUnit({ name: "Calories", fields: [{ name: "calories", type: "number", isPrimary: true }] }, "calories")).toBe("kcal");
  });

  it("falls back to the tracker name only for a generic primary field", () => {
    // "Guitar" with a generic "activity" field → minutes.
    expect(resolveTrackerUnit({ name: "Guitar Practice", fields: [{ name: "activity", type: "number", isPrimary: true }] }, "activity")).toBe("min");
  });

  it("never guesses a cross-domain unit (Fish Oil is NOT motor-oil quarts)", () => {
    expect(resolveTrackerUnit({ name: "Fish Oil", category: "supplement", fields: [{ name: "value", type: "number" }] }, "value")).not.toBe("qt");
    // A real oil change still resolves to quarts.
    expect(resolveTrackerUnit({ name: "Oil Change", category: "vehicle", fields: [{ name: "value", type: "number", isPrimary: true }] }, "value")).toBe("qt");
  });

  it("returns empty rather than guessing wrong for an unknowable field", () => {
    expect(resolveTrackerUnit({ name: "Mystery", fields: [{ name: "blorp", type: "number", isPrimary: true }] }, "blorp")).toBe("");
  });
});

describe("the presentation engine and the resolver agree", () => {
  const trackers = [
    { name: "Hydration", category: "health", unit: "oz", fields: [{ name: "ounces", type: "number", isPrimary: true }] },
    { name: "Weight", category: "health", fields: [{ name: "weight", type: "number", isPrimary: true }] },
    { name: "Glucose", category: "health", fields: [{ name: "glucose", type: "number", isPrimary: true }] },
    { name: "Steps", category: "fitness", fields: [{ name: "steps", type: "number", isPrimary: true }] },
    { name: "Heart Rate", category: "health", fields: [{ name: "bpm", type: "number", isPrimary: true }] },
    { name: "Fish Oil", category: "supplement", fields: [{ name: "dosage", type: "number" }, { name: "adherence", type: "select" }] },
  ];
  for (const t of trackers) {
    it(`${t.name}: presentation.unit === resolveTrackerUnit(primary)`, () => {
      const pres = classifyTrackerPresentation(t as any);
      // Non-dual trackers: the presentation unit is exactly the resolver's.
      if (pres.metricKind !== "dual") {
        expect(pres.unit).toBe(resolveTrackerUnit(t as any, pres.primaryField || undefined));
      }
    });
  }
});

describe("isAdherenceTracker", () => {
  it("detects by category, dose-shape, and name", () => {
    expect(isAdherenceTracker({ category: "medication" })).toBe(true);
    expect(isAdherenceTracker({ name: "Multivitamin" })).toBe(true);
    expect(isAdherenceTracker({ name: "X", fields: [{ name: "dosage", type: "number" }, { name: "taken", type: "boolean" }] })).toBe(true);
    expect(isAdherenceTracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }] })).toBe(false);
  });
});
