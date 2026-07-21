// Pins shared/entity-classify — the semantic classification layer that maps
// free-form entity names ("Xanax", "Bench Press", "Pickleball") to tracker
// categories before any DB write, so recognizable things never land in the
// meaningless "custom" bucket (user report 2026-07-20).
import { describe, it, expect } from "vitest";
import {
  classifyEntity, normalizeEntityName, editDistance, isValidTrackerCategory,
} from "../shared/entity-classify";

describe("normalizeEntityName", () => {
  it("lowercases, strips dose tokens, punctuation, and filler", () => {
    expect(normalizeEntityName("Xanax 0.5mg")).toBe("xanax");
    expect(normalizeEntityName("My Daily Multivitamin Tracker")).toBe("multivitamin");
    expect(normalizeEntityName("Push-Ups!")).toBe("push ups");
    expect(normalizeEntityName("  Amoxicillin 500 mg  ")).toBe("amoxicillin");
  });
});

describe("classifyEntity — medications", () => {
  const meds = ["Xanax", "xanax 0.5mg", "Tylenol", "Ibuprofen", "Amoxicillin",
    "Lexapro", "Ozempic", "Adderall", "Albuterol", "Lisinopril", "Prednisone",
    "Benadryl", "Metformin", "Vyvanse", "Ambien"];
  for (const m of meds) {
    it(`${m} → medication (high)`, () => {
      const r = classifyEntity(m);
      expect(r.category, m).toBe("medication");
      expect(r.confidence, m).toBe("high");
    });
  }

  it("recognizes supplements as medication-category", () => {
    expect(classifyEntity("Fish Oil").category).toBe("medication");
    expect(classifyEntity("Creatine").category).toBe("medication");
    expect(classifyEntity("Vitamin D3").category).toBe("medication");
    expect(classifyEntity("Fish Oil").kind).toBe("supplement");
  });

  it("catches common typos via fuzzy matching", () => {
    expect(classifyEntity("Ibuprofin").category).toBe("medication");
    expect(classifyEntity("Amoxicilin").category).toBe("medication");
    expect(classifyEntity("Tylenoll").category).toBe("medication");
  });

  it("dose-shaped values classify as medication even for unknown drug names", () => {
    const r = classifyEntity("Zylorphan", { values: { dosage: 50, taken: true } });
    expect(r.category).toBe("medication");
    expect(r.confidence).toBe("medium");
  });
});

describe("classifyEntity — exercises and sports", () => {
  const fitness = ["Push-Ups", "Pull Ups", "Bench Press", "Squats", "Deadlifts",
    "Bicep Curls", "Kettlebell Swings", "Jump Rope", "HIIT", "Elliptical",
    "Pickleball", "Basketball", "Jiu Jitsu", "Rock Climbing", "Yoga", "Stretching",
    "Swimming", "Running", "Cycling"];
  for (const f of fitness) {
    it(`${f} → fitness (high)`, () => {
      const r = classifyEntity(f);
      expect(r.category, f).toBe("fitness");
      expect(r.confidence, f).toBe("high");
    });
  }

  it("blocks fitness for pet/errand contexts", () => {
    expect(classifyEntity("Dog Walking").category).toBe("lifestyle");
    expect(classifyEntity("Running Errands").category).not.toBe("fitness");
  });
});

describe("classifyEntity — keyword waterfall parity", () => {
  it("keeps the legacy bucket ordering", () => {
    expect(classifyEntity("Mood").category).toBe("mental");
    expect(classifyEntity("Video Games").category).toBe("lifestyle");
    expect(classifyEntity("Protein Shake Intake").category).toBe("nutrition");
    expect(classifyEntity("Blood Pressure").category).toBe("health");
    expect(classifyEntity("Plant Watering").category).toBe("lifestyle");
    expect(classifyEntity("Spending").category).toBe("finance");
    expect(classifyEntity("Screen Time").category).toBe("habit");
    expect(classifyEntity("Deep Work").category).toBe("productivity");
    expect(classifyEntity("Sleep Quality").category).toBe("sleep");
  });
});

describe("classifyEntity — unknowns", () => {
  it("returns custom/none for unrecognizable names", () => {
    for (const name of ["Zorbulon", "Widget Frobnication", ""]) {
      const r = classifyEntity(name);
      expect(r.category, name).toBe("custom");
      expect(r.confidence, name).toBe("none");
    }
  });

  it("does not fuzzy-hijack long unrelated phrases", () => {
    expect(classifyEntity("Morning Pages Written For The Novel").category).not.toBe("medication");
  });
});

describe("helpers", () => {
  it("editDistance caps and computes", () => {
    expect(editDistance("ibuprofin", "ibuprofen", 2)).toBe(1);
    expect(editDistance("abc", "xyz", 2)).toBeGreaterThan(2);
  });
  it("isValidTrackerCategory accepts the vocabulary and rejects junk", () => {
    expect(isValidTrackerCategory("medication")).toBe(true);
    expect(isValidTrackerCategory("Fitness")).toBe(true);
    expect(isValidTrackerCategory("drugs")).toBe(false);
    expect(isValidTrackerCategory(null)).toBe(false);
  });
});
