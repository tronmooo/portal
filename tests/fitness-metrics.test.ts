/**
 * Fitness measurement semantics + the canonical calorie estimator.
 *
 * The bug these pin: a Squats entry stored as `{ reps: 12, sets: 3 }` rendered
 * a headline of "3 lbs" — the bench-press card template printed "the first
 * number it could find" and labelled it with the unit the TEMPLATE expected,
 * not the unit the FIELD meant. Every assertion below exists to keep a number's
 * meaning attached to the key it was stored under, from ingestion to render.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  analyzeFitnessEntry,
  buildFitnessDisplay,
  calorieContextForOwner,
  caloriesForStoredEntry,
  classifyFitnessActivity,
  estimateCaloriesBurned,
  formatCalories,
  formatRepScheme,
  metricKindForKey,
  minutesFromSetScheme,
  ownerBodyWeightKg,
  parseBodyWeightToKg,
  readFitnessFacts,
  DEFAULT_BODY_WEIGHT_KG,
  KG_PER_LB,
} from "../shared/fitness-metrics";
import { computeSecondaryData } from "../server/storage";
import { normalizeTrackerEntry } from "../server/tracker-normalize";
import { readActivity } from "../client/src/lib/wellness-metrics";
import { buildWellnessCards } from "../client/src/lib/wellness-dynamic";

const SARAH = { name: "Sarah", fields: { weight: "135 lbs", sex: "female", age: 34 } };
const BOB = { name: "Bob", fields: { weight: 210 } };
const NO_WEIGHT = { name: "Casey", fields: {} };

const show = (d: ReturnType<typeof analyzeFitnessEntry>) =>
  [d.primary ? `${d.primary.value} ${d.primary.unit}` : "", ...d.detail, formatCalories(d.calories) ?? ""].join(" | ");

// ───────────────────────────────────────────────────────────────────────────
describe("1. Squats: 12 reps, 3 sets, no resistance", () => {
  const d = analyzeFitnessEntry(
    { trackerName: "Squats", category: "fitness", values: { reps: 12, sets: 3 } },
    calorieContextForOwner(SARAH),
  );

  it("shows the rep scheme, not a weight", () => {
    expect(d.primary).toEqual({ value: 12, unit: "reps", metric: "reps" });
    expect(d.detail).toContain("12 reps × 3 sets");
  });

  it("NEVER renders the set count as pounds — the reported defect", () => {
    expect(show(d)).not.toMatch(/\b3\s*lbs?\b/);
    expect(show(d)).not.toMatch(/\blbs?\b/);
    expect(d.primary!.metric).not.toBe("resistance");
  });

  it("does not invent a resistance value that was never logged", () => {
    expect(d.detail.join(" ")).not.toMatch(/lbs|kg/);
  });

  it("still estimates calories, marked as an estimate", () => {
    expect(d.calories?.estimated).toBe(true);
    expect(d.calories!.value).toBeGreaterThan(5);
    expect(d.calories!.value).toBeLessThan(60);
    expect(formatCalories(d.calories)).toMatch(/^~\d+ cal burned$/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("2. Squats: 60 lbs, 10 reps, 3 sets", () => {
  const d = analyzeFitnessEntry(
    { trackerName: "Squats", category: "fitness", values: { weight: 60, reps: 10, sets: 3 } },
    calorieContextForOwner(SARAH),
  );

  it("leads with the real resistance", () => {
    expect(d.primary).toEqual({ value: 60, unit: "lbs", metric: "resistance" });
  });

  it("keeps the rep scheme alongside it", () => {
    expect(d.detail).toContain("10 reps × 3 sets");
  });

  it("burns more than the same scheme unloaded", () => {
    const unloaded = analyzeFitnessEntry(
      { trackerName: "Squats", category: "fitness", values: { reps: 10, sets: 3 } },
      calorieContextForOwner(SARAH),
    );
    expect(d.calories!.value).toBeGreaterThan(unloaded.calories!.value);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("3. Push-ups: 25 reps, 1 set", () => {
  const d = analyzeFitnessEntry(
    { trackerName: "Pushups", category: "fitness", values: { reps: 25, sets: 1 } },
    calorieContextForOwner(BOB),
  );

  it("reads '25 reps × 1 set'", () => {
    expect(d.primary).toEqual({ value: 25, unit: "reps", metric: "reps" });
    expect(d.detail).toContain("25 reps × 1 set");
  });

  it("never shows the person's body weight as resistance lifted", () => {
    expect(show(d)).not.toMatch(/210|95\b/);
    expect(show(d)).not.toMatch(/lbs/);
  });

  it("uses the body weight internally for the calorie estimate only", () => {
    const heavier = analyzeFitnessEntry(
      { trackerName: "Pushups", category: "fitness", values: { reps: 25, sets: 1 } },
      calorieContextForOwner({ name: "Heavy", fields: { weight: 300 } }),
    );
    expect(heavier.calories!.value).toBeGreaterThan(d.calories!.value);
    expect(heavier.primary).toEqual(d.primary);
  });

  it("shows an explicitly added weight when the user logged one", () => {
    const weighted = analyzeFitnessEntry(
      { trackerName: "Pull-ups", category: "fitness", values: { reps: 8, sets: 3, addedWeight: 25 } },
      calorieContextForOwner(BOB),
    );
    expect(weighted.detail).toContain("25 lbs");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("4. Basketball: 30 minutes", () => {
  const d = analyzeFitnessEntry(
    { trackerName: "Basketball", category: "fitness", values: { duration: 30 } },
    calorieContextForOwner(BOB),
  );

  it("shows 30 min, never pounds", () => {
    expect(d.primary).toEqual({ value: 30, unit: "min", metric: "duration" });
    expect(show(d)).not.toMatch(/lbs|reps|sets/);
  });

  it("prices it with the owner's weight via MET", () => {
    expect(d.calories!.basis).toBe("met_duration");
    expect(d.calories!.usedDefaultWeight).toBe(false);
    expect(d.calories!.method).toContain("Bob's weight");
    expect(d.calories!.value).toBeGreaterThan(150);
    expect(d.calories!.value).toBeLessThan(500);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("5. Running: 2 miles in 20 minutes", () => {
  const d = analyzeFitnessEntry(
    { trackerName: "Running", category: "fitness", values: { distance: 2, duration: 20 } },
    calorieContextForOwner(BOB),
  );

  it("shows distance and duration in their own units", () => {
    expect(d.primary).toEqual({ value: 2, unit: "mi", metric: "distance" });
    expect(d.detail).toContain("20 min");
  });

  it("calculates calories from the resulting speed", () => {
    expect(d.calories!.value).toBeGreaterThan(100);
    expect(d.calories!.method).toMatch(/mph/);
  });

  it("walking with steps shows distance + steps and no weight", () => {
    const w = analyzeFitnessEntry(
      { trackerName: "Walking", category: "fitness", values: { distance: 3.2, steps: 7400 } },
      calorieContextForOwner(BOB),
    );
    expect(w.primary!.unit).toBe("mi");
    expect(w.detail).toContain("7,400 steps");
    expect(show(w)).not.toMatch(/lbs/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("6 & 7. Calories use the ACTIVITY OWNER's weight, not the viewer's", () => {
  const values = { duration: 45 };
  const sarah = analyzeFitnessEntry({ trackerName: "Soccer", category: "fitness", values }, calorieContextForOwner(SARAH));
  const bob = analyzeFitnessEntry({ trackerName: "Soccer", category: "fitness", values }, calorieContextForOwner(BOB));

  it("Sarah's activity uses Sarah's profile weight", () => {
    expect(sarah.calories!.method).toContain("Sarah's weight");
    expect(sarah.calories!.method).toContain(`${Math.round(135 * KG_PER_LB)} kg`);
  });

  it("Bob's activity uses Bob's profile weight", () => {
    expect(bob.calories!.method).toContain("Bob's weight");
    expect(bob.calories!.method).toContain(`${Math.round(210 * KG_PER_LB)} kg`);
  });

  it("the two never collide — a heavier owner burns more for the same session", () => {
    expect(bob.calories!.value).toBeGreaterThan(sarah.calories!.value);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("8. No body weight on file", () => {
  it("falls back to a labelled population average, at lower confidence", () => {
    const d = analyzeFitnessEntry(
      { trackerName: "Basketball", category: "fitness", values: { duration: 30 } },
      calorieContextForOwner(NO_WEIGHT),
    );
    expect(d.calories!.usedDefaultWeight).toBe(true);
    expect(d.calories!.method).toContain(`population-average weight ${DEFAULT_BODY_WEIGHT_KG} kg`);
    expect(d.calories!.estimated).toBe(true);
    const known = analyzeFitnessEntry(
      { trackerName: "Basketball", category: "fitness", values: { duration: 30 } },
      calorieContextForOwner(BOB),
    );
    expect(d.calories!.confidence).toBeLessThan(known.calories!.confidence);
  });

  it("declines entirely rather than fake precision from too little", () => {
    // Bare "3 sets": nothing says how much work was done.
    const d = analyzeFitnessEntry(
      { trackerName: "Squats", category: "fitness", values: { sets: 3 } },
      calorieContextForOwner(NO_WEIGHT),
    );
    expect(d.calories).toBeNull();
    expect(d.primary).toEqual({ value: 3, unit: "sets", metric: "sets" });
  });

  it("never attributes a burn to a non-activity tracker", () => {
    for (const name of ["Fish Oil", "Hydration", "Nutrition", "Blood Pressure", "Tire Pressure", "Bathroom Visits"]) {
      const d = analyzeFitnessEntry({ trackerName: name, category: "health", values: { duration: 30, value: 3 } }, calorieContextForOwner(BOB));
      expect(d.calories, name).toBeNull();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("9. Explicitly logged calories win over any estimate", () => {
  const d = analyzeFitnessEntry(
    { trackerName: "Basketball", category: "fitness", values: { duration: 30, caloriesBurned: 412 } },
    calorieContextForOwner(BOB),
  );

  it("is preserved verbatim and marked as not estimated", () => {
    expect(d.calories).toMatchObject({ value: 412, estimated: false, basis: "logged" });
    expect(formatCalories(d.calories)).toBe("412 cal burned");
  });

  it("a mirrored ESTIMATE in values is not promoted to 'logged'", () => {
    const d2 = analyzeFitnessEntry({
      trackerName: "Walking", category: "fitness",
      values: { distance: 2, duration: 40, caloriesBurned: 999 },
      enrichment: { estimated: { caloriesBurned: { value: 999 } } },
    }, calorieContextForOwner(BOB));
    expect(d2.calories!.estimated).toBe(true);
    expect(d2.calories!.value).not.toBe(999);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("10. Historical strength entries: sets never become pounds", () => {
  // The shapes real trackers were created with, in the orders they occur.
  const legacyShapes = [
    { name: "Squats", fields: [{ name: "sets", type: "number" }, { name: "reps", type: "number" }], values: { sets: 3, reps: 12 } },
    { name: "Pushups", fields: [{ name: "sets", type: "number" }, { name: "reps", type: "number" }], values: { sets: 1, reps: 25 } },
    // A tracker healed onto the lift shape (weight is declared but never logged).
    { name: "Bench Press", fields: [{ name: "weight", type: "number", unit: "lbs", isPrimary: true }, { name: "reps", type: "number" }, { name: "sets", type: "number" }], values: { reps: 8, sets: 4 } },
    { name: "Core Workout", fields: [{ name: "value", type: "number" }], values: { sets: 3, reps: 20 } },
  ];

  for (const t of legacyShapes) {
    it(`${t.name}: no pounds anywhere in the card`, () => {
      const d = analyzeFitnessEntry({ trackerName: t.name, category: "fitness", fields: t.fields as any, values: t.values }, calorieContextForOwner(BOB));
      expect(show(d)).not.toMatch(/\blbs?\b|\bkg\b|pounds/i);
      expect(d.primary!.metric === "sets" || d.primary!.metric === "reps").toBe(true);
    });
  }

  it("the metric of a key never depends on the value's magnitude", () => {
    const squat = classifyFitnessActivity("Squats", "fitness");
    for (const n of [1, 3, 12, 45, 225, 1000]) {
      expect(readFitnessFacts({ sets: n }, squat).sets).toBe(n);
      expect(readFitnessFacts({ sets: n }, squat).resistance).toBeUndefined();
      expect(readFitnessFacts({ reps: n }, squat).reps).toBe(n);
      expect(readFitnessFacts({ reps: n }, squat).resistance).toBeUndefined();
    }
  });

  it("an unnameable number is never promoted to a measurement", () => {
    const squat = classifyFitnessActivity("Squats", "fitness");
    const facts = readFitnessFacts({ mysteryNumber: 3 }, squat);
    expect(facts.resistance).toBeUndefined();
    expect(facts.unknownKeys).toEqual(["mysteryNumber"]);
    expect(buildFitnessDisplay(squat, facts, null).primary).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("unit conversion normalises before the calorie math", () => {
  it("kg resistance stays kg on screen", () => {
    const d = analyzeFitnessEntry({
      trackerName: "Squats", category: "fitness",
      fields: [{ name: "weight", unit: "kg" }],
      values: { weight: 60, reps: 5, sets: 5 },
    }, calorieContextForOwner(BOB));
    expect(d.primary).toEqual({ value: 60, unit: "kg", metric: "resistance" });
  });

  it("lb and kg body weights that mean the same person agree on calories", () => {
    const lbs = calorieContextForOwner({ name: "A", fields: { weight: "180 lbs" } });
    const kg = calorieContextForOwner({ name: "A", fields: { weight: "81.65 kg" } });
    expect(lbs.bodyWeightKg!).toBeCloseTo(kg.bodyWeightKg!, 1);
    const values = { duration: 30 };
    const a = analyzeFitnessEntry({ trackerName: "Tennis", category: "fitness", values }, lbs);
    const b = analyzeFitnessEntry({ trackerName: "Tennis", category: "fitness", values }, kg);
    expect(a.calories!.value).toBe(b.calories!.value);
  });

  it("reads body weight from lb, kg and bare numbers", () => {
    expect(parseBodyWeightToKg("180 lbs")).toBeCloseTo(81.65, 1);
    expect(parseBodyWeightToKg("82 kg")).toBe(82);
    expect(parseBodyWeightToKg(180)).toBeCloseTo(81.65, 1);      // bare → lbs
    expect(parseBodyWeightToKg(82, true)).toBe(82);              // key said kg
    expect(ownerBodyWeightKg({ fields: { weightKg: 82 } })).toBe(82);
    expect(ownerBodyWeightKg({ fields: {} })).toBeNull();
    expect(ownerBodyWeightKg(null)).toBeNull();
  });

  it("km distance and second durations normalise for the math but display as logged", () => {
    const d = analyzeFitnessEntry({
      trackerName: "Running", category: "fitness",
      fields: [{ name: "distance", unit: "km" }],
      values: { distance: 5, duration: 28 },
    }, calorieContextForOwner(BOB));
    expect(d.primary).toEqual({ value: 5, unit: "km", metric: "distance" });
    expect(d.calories!.value).toBeGreaterThan(150);

    const plank = analyzeFitnessEntry({
      trackerName: "Plank", category: "fitness",
      fields: [{ name: "duration", unit: "sec" }],
      values: { duration: 90 },
    }, calorieContextForOwner(BOB));
    expect(plank.calories!.method).toContain("1.5 min");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("one estimator, one number, everywhere", () => {
  const values = { duration: 30 };
  const ctx = calorieContextForOwner(BOB);

  it("the card and the stored `computed` agree exactly", () => {
    const card = analyzeFitnessEntry({ trackerName: "Basketball", category: "fitness", values }, ctx);
    const stored = computeSecondaryData("Basketball", "fitness", values, ctx, null);
    expect(stored.caloriesBurned).toBe(card.calories!.value);
    expect(stored.caloriesBurnedSource).toBe("estimated");
    expect(stored.caloriesUsedDefaultWeight).toBe(false);
    expect(stored.caloriesBurnedMethod).toBe(card.calories!.method);
  });

  it("stored calories are flagged `logged` when the user stated them", () => {
    const stored = computeSecondaryData("Basketball", "fitness", { duration: 30, caloriesBurned: 400 }, ctx, null);
    expect(stored).toMatchObject({ caloriesBurned: 400, caloriesBurnedSource: "logged" });
  });

  it("nutrition intake is untouched by the burn estimator", () => {
    const stored = computeSecondaryData("Nutrition", "nutrition", { calories: 430, protein: 30 }, ctx, null);
    expect(stored.caloriesConsumed).toBe(430);
    expect(stored.caloriesBurned).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("ingestion cannot fabricate a resistance value", () => {
  const squats = {
    name: "Squats", category: "fitness", unit: undefined,
    fields: [{ name: "weight", type: "number" as const, unit: "lbs", isPrimary: true }, { name: "reps", type: "number" as const }, { name: "sets", type: "number" as const }],
  };

  it("a bare count is NOT collapsed onto the weight field", () => {
    const { values } = normalizeTrackerEntry(squats as any, { count: 3 });
    expect(values.weight).toBeUndefined();
  });

  it("a real weight still lands on the weight field", () => {
    expect(normalizeTrackerEntry(squats as any, { lbs: 135 }).values.weight).toBe(135);
    expect(normalizeTrackerEntry(squats as any, { weight: "60 kg" }).values.weight).toBeCloseTo(132.28, 1);
  });

  it("hydration's generic-quantity collapse is unaffected", () => {
    const hydration = { name: "Hydration", category: "health", unit: "oz", fields: [{ name: "ounces", type: "number" as const, unit: "oz", isPrimary: true }] };
    expect(normalizeTrackerEntry(hydration as any, { amount: 24 }).values.ounces).toBe(24);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("activity classification", () => {
  const cases: Array<[string, string, string]> = [
    ["Squats", "squat", "strength"],
    ["Shoulder Press", "shoulder_press", "strength"],
    ["Incline Dumbbell Press", "resistance_movement", "strength"],
    ["Pushups", "pushup", "bodyweight"],
    ["Core Workout", "core", "bodyweight"],
    ["Plank", "plank", "isometric"],
    ["Basketball", "basketball", "sport"],
    ["Running", "running", "cardio_distance"],
    ["Yoga", "yoga", "flexibility"],
    ["Jump Rope", "jump_rope", "cardio_duration"],
  ];
  for (const [name, id, kind] of cases) {
    it(`${name} → ${id} (${kind})`, () => {
      const a = classifyFitnessActivity(name, "fitness");
      expect(a.id).toBe(id);
      expect(a.kind).toBe(kind);
    });
  }

  it("name collisions with other domains do not become workouts", () => {
    expect(classifyFitnessActivity("Tire Pressure", "vehicle").kind).toBe("non_fitness");
    expect(classifyFitnessActivity("Blood Pressure", "health").kind).toBe("non_fitness");
    expect(classifyFitnessActivity("Fish Oil", "supplement").kind).toBe("non_fitness");
    expect(classifyFitnessActivity("Body Weight", "weight").kind).toBe("non_fitness");
  });

  it("on a body-weight tracker, `weight` means the person; on a lift, the load", () => {
    expect(metricKindForKey("weight", classifyFitnessActivity("Weight", "weight"))).toBe("bodyWeight");
    expect(metricKindForKey("weight", classifyFitnessActivity("Squats", "fitness"))).toBe("resistance");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("helpers", () => {
  it("formats rep schemes with correct singulars and no weight", () => {
    expect(formatRepScheme({ reps: 12, sets: 3, unknownKeys: [] })).toBe("12 reps × 3 sets");
    expect(formatRepScheme({ reps: 25, sets: 1, unknownKeys: [] })).toBe("25 reps × 1 set");
    expect(formatRepScheme({ reps: 1, sets: 1, unknownKeys: [] })).toBe("1 rep × 1 set");
    expect(formatRepScheme({ unknownKeys: [] })).toBeNull();
  });

  it("turns a set scheme into time under load, counting rest", () => {
    expect(minutesFromSetScheme(12, 3)).toBeCloseTo(4.8, 2);
    expect(minutesFromSetScheme(undefined, undefined)).toBeNull();
  });

  it("MET math is the standard ACSM expression", () => {
    const d = estimateCaloriesBurned(
      classifyFitnessActivity("Basketball", "fitness"),
      { duration: 60, unknownKeys: [] },
      { bodyWeightKg: 70 },
    );
    // MET 6.5 × 3.5 × 70 / 200 × 60 = 477.75 → rounded to the nearest 5
    expect(d!.value).toBe(480);
  });

  it("reads age and sex off the owner profile for the heart-rate path", () => {
    const ctx = calorieContextForOwner(SARAH);
    expect(ctx).toMatchObject({ ageYears: 34, sex: "female", ownerLabel: "Sarah" });
    const d = analyzeFitnessEntry(
      { trackerName: "Cycling", category: "fitness", values: { duration: 40, heartRate: 150 } },
      ctx,
    );
    expect(d.calories!.basis).toBe("heart_rate");
    expect(d.detail).toContain("150 bpm");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the reported Trackers dashboard, card by card", () => {
  // Exactly the trackers visible in the bug report, with the values their
  // sublines proved they held. `BIG` is the card headline, `SUB` the line
  // under the title.
  const OWNER = { name: "Poop", fields: { weight: "185 lb" } };
  const CARDS: Array<{ name: string; category: string; values: Record<string, any>; big: string | null; sub: string; cals: boolean }> = [
    { name: "Incline Dumbbell Press", category: "fitness", values: { weight: 60, reps: 10, sets: 3 }, big: "60 lbs", sub: "10 reps × 3 sets", cals: true },
    { name: "Shoulder Press", category: "fitness", values: { weight: 50, reps: 10, sets: 3 }, big: "50 lbs", sub: "10 reps × 3 sets", cals: true },
    // The two that were wrong: the first numeric value was the SET COUNT.
    { name: "Squats", category: "fitness", values: { sets: 3, reps: 12 }, big: "12 reps", sub: "12 reps × 3 sets", cals: true },
    { name: "Pushups", category: "fitness", values: { sets: 1, reps: 25 }, big: "25 reps", sub: "25 reps × 1 set", cals: true },
    { name: "Core Workout", category: "fitness", values: { sets: 3, reps: 20 }, big: "20 reps", sub: "20 reps × 3 sets", cals: true },
    { name: "Basketball", category: "fitness", values: { duration: 30 }, big: "30 min", sub: "", cals: true },
    // Not activities — their cards are untouched and claim no burn.
    { name: "Hydration", category: "health", values: { ounces: 20 }, big: null, sub: "", cals: false },
    { name: "Nutrition", category: "nutrition", values: { calories: 430 }, big: null, sub: "", cals: false },
    { name: "Bathroom Visits", category: "health", values: { count: 1 }, big: null, sub: "", cals: false },
    { name: "Coffee", category: "health", values: { cups: 1 }, big: null, sub: "", cals: false },
    { name: "Fish Oil", category: "supplement", values: { dosage: 1000 }, big: null, sub: "", cals: false },
  ];

  for (const c of CARDS) {
    it(`${c.name}`, () => {
      const d = analyzeFitnessEntry({ trackerName: c.name, category: c.category, values: c.values }, calorieContextForOwner(OWNER));
      if (c.big === null) {
        expect(d.activity.kind).toBe("non_fitness");
        expect(d.calories).toBeNull();
        return;
      }
      expect(`${d.primary!.value} ${d.primary!.unit}`).toBe(c.big);
      expect(d.detail.join(" · ")).toBe(c.sub);
      expect(d.calories != null).toBe(c.cals);
      // The whole defect in one line: no card may print pounds for a number
      // that is not a weight.
      if (!/lbs/.test(c.big)) expect(show(d)).not.toMatch(/\blbs?\b/);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
describe("contract: the trackers page owns no fitness unit of its own", () => {
  const src = readFileSync(new URL("../client/src/pages/trackers.tsx", import.meta.url), "utf8");

  it("the bench-press card template — which printed every metric as pounds — is gone", () => {
    expect(src, 'the "Lifted N lbs" sentence must not return').not.toMatch(/Lifted \$\{/);
    expect(src, 'a `kind === "bench"` template must not return').not.toMatch(/kind === "bench"\)\s*\{/);
  });

  it("no fitness template falls back to a hardcoded weight unit", () => {
    // `|| "lbs"` is only legitimate on the BODY-WEIGHT card, where the metric
    // really is a weight. Anywhere else it is the bug: a unit chosen by the
    // template rather than by the field.
    const offenders = src
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\|\|\s*"lbs"/.test(line))
      .filter(([, line]) => !/primaryUnit/.test(line));
    expect(offenders, `hardcoded lbs fallback at ${offenders.map(([n]) => n).join(", ")}`).toEqual([]);
  });

  it("the compact list view reads its headline from the semantic layer too", () => {
    // That column used `fields.find(isPrimary) || fields[0]`, which on a
    // Squats tracker shaped [activityType, sets, reps, …] is a TEXT field —
    // so the list printed "strength" as the latest measurement, and bare
    // unlabelled numbers for every other workout.
    const start = src.indexOf('const pf = t.fields.find(fld => fld.isPrimary)');
    const end = src.indexOf('kind: "tracker"', start);
    expect(start, "list-view row builder not found").toBeGreaterThan(-1);
    expect(end, "tracker row push not found").toBeGreaterThan(start);
    const listBlock = src.slice(start, end);
    expect(listBlock).toMatch(/buildFitnessDisplay/);
    expect(listBlock).toMatch(/classifyFitnessActivity/);
  });

  it("renders the calorie estimate from the shared service, not a local formula", () => {
    expect(src).toMatch(/analyzeFitnessEntry/);
    expect(src).toMatch(/calorieContextForOwner/);
    // A local `cal/min` or `cal/mile` table on the page would be a second
    // estimator and would drift from the server's stored value.
    expect(src).not.toMatch(/cal\s*\/\s*(min|mile)/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("stored entries read back consistently (no data rewrite needed)", () => {
  const tracker = { name: "Basketball", category: "fitness", fields: null };
  const ctx = calorieContextForOwner(BOB);

  it("trusts a value this estimator wrote", () => {
    const stored = computeSecondaryData("Basketball", "fitness", { duration: 30 }, ctx, null);
    const read = caloriesForStoredEntry(tracker, { values: { duration: 30 }, computed: stored }, ctx);
    expect(read!.value).toBe(stored.caloriesBurned);
    expect(read!.estimated).toBe(true);
  });

  it("preserves a user-logged value across the round trip", () => {
    const stored = computeSecondaryData("Basketball", "fitness", { duration: 30, caloriesBurned: 400 }, ctx, null);
    const read = caloriesForStoredEntry(tracker, { values: { duration: 30, caloriesBurned: 400 }, computed: stored }, ctx);
    expect(read).toMatchObject({ value: 400, estimated: false });
  });

  it("recomputes a legacy row rather than trusting the old per-activity formula", () => {
    // What the pre-fix code stored for a 2-mile run: distance × 100.
    const legacy = { caloriesBurned: 200, distanceMiles: 2 };
    const read = caloriesForStoredEntry(
      { name: "Running", category: "fitness", fields: null },
      { values: { distance: 2, duration: 20 }, computed: legacy },
      ctx,
    );
    expect(read!.value).not.toBe(200);
    expect(read!.method).toMatch(/MET/);
  });

  it("keeps a legacy number only when nothing can be recomputed", () => {
    const read = caloriesForStoredEntry(
      { name: "Kickboxing", category: "fitness", fields: null },
      { values: {}, computed: { caloriesBurned: 180 } },
      ctx,
    );
    expect(read).toMatchObject({ value: 180, estimated: true });
  });

  it("returns nothing for a non-activity, whatever a legacy row claims", () => {
    expect(caloriesForStoredEntry(
      { name: "Fish Oil", category: "supplement", fields: null },
      { values: { dosage: 1000 }, computed: {} },
      ctx,
    )).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("the Wellness / Executive activity roll-up quotes the same number", () => {
  const ctx = calorieContextForOwner(BOB);
  const mkTracker = (values: Record<string, any>, computed: Record<string, any>) => ({
    id: "t1", name: "Basketball", category: "fitness", unit: "min",
    fields: [{ name: "duration", type: "number", unit: "min" }, { name: "caloriesBurned", type: "number", unit: "kcal" }],
    linkedProfiles: ["p-bob"],
    entries: [{ id: "e1", values, computed, timestamp: new Date().toISOString(), profileId: "p-bob" }],
  });
  const profiles = [{ id: "p-bob", ...BOB }];

  it("counts an entry's calories exactly once, even when values AND computed carry them", () => {
    const values = { duration: 30, caloriesBurned: 400 };
    const stored = computeSecondaryData("Basketball", "fitness", values, ctx, null);
    const a = readActivity([mkTracker(values, stored) as any], { profiles });
    // 400, not 800 — the roll-up used to add both sources.
    expect(a.caloriesBurned).toBe(400);
  });

  it("matches the tracker card for an estimated entry", () => {
    const values = { duration: 30 };
    const stored = computeSecondaryData("Basketball", "fitness", values, ctx, null);
    const card = analyzeFitnessEntry({ trackerName: "Basketball", category: "fitness", values }, ctx);
    const a = readActivity([mkTracker(values, stored) as any], { profiles });
    expect(a.caloriesBurned).toBe(card.calories!.value);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("profile weights as they are ACTUALLY stored", () => {
  // Verbatim from the production `profiles.fields->>'weight'` column. The
  // app's own field formatter appends the metric mirror in parentheses, and an
  // anchored parse returned null for those rows — so every activity belonging
  // to that person was silently priced with the population default instead of
  // their real body weight.
  const REAL: Array<[unknown, number | null]> = [
    ["300 lb (136.1 kg)", 136.1],
    ["184.6 lbs (83.7 kg)", 83.7],
    ["51 lbs", 23.1],
    [180, 81.6],
    ["", null],
    ["N/A", null],
    [null, null],
  ];
  for (const [raw, kg] of REAL) {
    it(`${JSON.stringify(raw)} → ${kg ?? "null"} kg`, () => {
      const got = parseBodyWeightToKg(raw);
      if (kg == null) expect(got).toBeNull();
      else expect(got!).toBeCloseTo(kg, 0);
    });
  }

  it("the imperial value and its own parenthetical metric mirror agree", () => {
    expect(parseBodyWeightToKg("300 lb (136.1 kg)")!).toBeCloseTo(136.1, 0);
    expect(parseBodyWeightToKg("136.1 kg")!).toBeCloseTo(136.1, 1);
  });

  it("a compound-weight owner is NOT priced with the population default", () => {
    const sarah = calorieContextForOwner({ name: "Sarah Miller", fields: { weight: "300 lb (136.1 kg)", gender: "Female" } });
    expect(sarah.bodyWeightKg!).toBeCloseTo(136.1, 0);
    const d = analyzeFitnessEntry({ trackerName: "Basketball", category: "fitness", values: { duration: 30 } }, sarah);
    expect(d.calories!.usedDefaultWeight).toBe(false);
    expect(d.calories!.method).toContain("Sarah Miller's weight");
    // Roughly double the 70 kg default's burn, because she is roughly double it.
    const anon = analyzeFitnessEntry({ trackerName: "Basketball", category: "fitness", values: { duration: 30 } }, calorieContextForOwner({ name: "X", fields: {} }));
    expect(d.calories!.value).toBeGreaterThan(anon.calories!.value * 1.7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Wellness cards label the fitness metric they show", () => {
  const mk = (name: string, fields: any[], values: Record<string, any>) => ({
    id: name, name, category: "fitness", fields,
    entries: [{ id: "e", values, computed: {}, timestamp: new Date().toISOString() }],
  });

  it("a Squats tracker shaped [activityType, sets, reps] leads with reps, not a bare set count", () => {
    const [card] = buildWellnessCards([
      mk("Squats", [{ name: "activityType", type: "text" }, { name: "sets", type: "number" }, { name: "reps", type: "number" }], { reps: 12, sets: 3 }),
    ] as any);
    expect(card.value).toBe(12);
    expect(card.unit).toBe("reps");
  });

  it("a weightLbs field with no declared unit is still labelled lbs", () => {
    const [card] = buildWellnessCards([
      mk("Shoulder Press", [{ name: "weightLbs", type: "number" }, { name: "sets", type: "number" }, { name: "reps", type: "number" }], { reps: 10, sets: 3, weightLbs: 50 }),
    ] as any);
    expect(card.value).toBe(50);
    expect(card.unit).toBe("lbs");
  });

  it("a duration sport reads in minutes", () => {
    const [card] = buildWellnessCards([
      mk("Basketball", [{ name: "activityType", type: "text" }, { name: "duration", type: "number" }], { duration: 30, activityType: "basketball" }),
    ] as any);
    expect(card.value).toBe(30);
    expect(card.unit).toBe("min");
  });

  it("a sets-only entry says sets — never an unlabelled number, never pounds", () => {
    const [card] = buildWellnessCards([
      mk("Squats", [{ name: "weight", type: "number", unit: "lbs" }, { name: "sets", type: "number" }, { name: "reps", type: "number" }], { sets: 3 }),
    ] as any);
    expect(card.value).toBe(3);
    expect(card.unit).toBe("sets");
  });

  it("non-fitness trackers keep their existing field-declared unit", () => {
    const [card] = buildWellnessCards([
      { id: "h", name: "Hydration", category: "health", unit: "oz",
        fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
        entries: [{ id: "e", values: { ounces: 20 }, computed: {}, timestamp: new Date().toISOString() }] },
    ] as any);
    expect(card.value).toBe(20);
    expect(card.unit).toBe("oz");
  });
});
