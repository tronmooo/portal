// Derived values are per-entity, never shared (user report: "Sarah Miller and
// I both played basketball for 20 minutes" gave BOTH people ~140 cal).
//
// The primary facts — basketball, 20 minutes — are genuinely shared. The
// derived one is not: calories come from MET × THAT PERSON'S weight × hours.
// This file pins the math and the fallback ladder
//   explicit value → that entity's stored weight → population default
// at the level where the arithmetic actually lives. The end-to-end
// two-profile path is pinned by tests/multi-profile-derived-values.test.ts.
import { describe, it, expect } from "vitest";
import {
  enrichActivityEntry,
  messageClaimsCaloriesFor,
  MIN_SAVE_CONFIDENCE,
  DEFAULT_WEIGHT_KG,
  parseWeightToKg,
} from "@shared/estimation-engine";
import {
  resolveActivityMet,
  intensityMultiplier,
  KNOWN_ACTIVITY_TERMS,
  DEFAULT_ACTIVITY_MET,
} from "@shared/activity-met";

// The two weights from the QA scenario.
const USER_KG = parseWeightToKg("150 lbs")!;   // ≈68.0
const SARAH_KG = parseWeightToKg("300 lbs")!;  // ≈136.1
const BALL = { activityType: "basketball", duration: 20 };

describe("MET vocabulary", () => {
  it("every activity term the classifier knows resolves to a MET", () => {
    const unmatched = KNOWN_ACTIVITY_TERMS.filter((t) => !resolveActivityMet(t).matched);
    expect(unmatched).toEqual([]);
  });

  it("prefers the longest phrase so specific sports beat their substrings", () => {
    expect(resolveActivityMet("table tennis").met).not.toBe(resolveActivityMet("tennis").met);
    expect(resolveActivityMet("rock climbing").key).toBe("rock climbing");
  });

  it("finds the activity inside a worded tracker name", () => {
    expect(resolveActivityMet("Morning Basketball").key).toBe("basketball");
  });

  it("falls back to a generic MET for an unknown activity instead of refusing", () => {
    const r = resolveActivityMet("kabaddi");
    expect(r.matched).toBe(false);
    expect(r.met).toBe(DEFAULT_ACTIVITY_MET);
  });

  it("moderate is the unstated default; light and intense scale it", () => {
    expect(intensityMultiplier("").stated).toBe(false);
    expect(intensityMultiplier("").mult).toBe(1);
    expect(intensityMultiplier("light").mult).toBeCloseTo(0.85, 2);
    expect(intensityMultiplier("intense").mult).toBeCloseTo(1.15, 2);
    expect(intensityMultiplier("3").mult).toBeCloseTo(1.15, 2);
  });
});

describe("QA (a) — both weights known: same game, different calories", () => {
  const user = enrichActivityEntry("basketball", BALL, { weightKg: USER_KG });
  const sarah = enrichActivityEntry("basketball", BALL, { weightKg: SARAH_KG });

  it("produces an estimate for each person", () => {
    expect(user.estimated.caloriesBurned?.value).toBeGreaterThan(0);
    expect(sarah.estimated.caloriesBurned?.value).toBeGreaterThan(0);
  });

  it("the two numbers differ, scaling with body weight", () => {
    const a = user.estimated.caloriesBurned!.value;
    const b = sarah.estimated.caloriesBurned!.value;
    expect(b).not.toBe(a);
    expect(b / a).toBeCloseTo(SARAH_KG / USER_KG, 1);
  });

  it("shares the primary facts — same MET, same duration", () => {
    expect(user.canonical.durationSeconds).toBe(sarah.canonical.durationSeconds);
    expect(user.estimated.caloriesBurned?.method).toContain("MET 6.5 (basketball, moderate)");
    expect(sarah.estimated.caloriesBurned?.method).toContain("MET 6.5 (basketball, moderate)");
  });

  it("each method names that person's own weight", () => {
    expect(user.estimated.caloriesBurned?.method).toContain("profile weight 68kg");
    expect(sarah.estimated.caloriesBurned?.method).toContain("profile weight 136kg");
  });
});

describe("QA (b) — one weight missing: standard default, never the other person's", () => {
  const user = enrichActivityEntry("basketball", BALL, { weightKg: USER_KG });
  const sarah = enrichActivityEntry("basketball", BALL, {}); // no stored weight

  it("still estimates rather than blanking or asking", () => {
    expect(sarah.estimated.caloriesBurned?.value).toBeGreaterThan(0);
    expect(sarah.estimated.caloriesBurned!.confidence).toBeGreaterThanOrEqual(MIN_SAVE_CONFIDENCE);
  });

  it("uses the population default and says so", () => {
    expect(sarah.estimated.caloriesBurned?.method).toContain(`default weight ${DEFAULT_WEIGHT_KG}kg`);
    expect(sarah.assumptions.map((a) => a.assumption)).toContain("Used population default weight");
  });

  it("does NOT inherit the other person's weight", () => {
    expect(sarah.estimated.caloriesBurned?.method).not.toContain("68kg");
    expect(sarah.estimated.caloriesBurned!.value).not.toBe(user.estimated.caloriesBurned!.value);
  });

  it("knowing the weight is worth more confidence than not", () => {
    expect(user.estimated.caloriesBurned!.confidence)
      .toBeGreaterThan(sarah.estimated.caloriesBurned!.confidence);
  });
});

describe("QA (c) — neither weight known: two independent standard estimates", () => {
  const a = enrichActivityEntry("basketball", BALL, {});
  const b = enrichActivityEntry("basketball", BALL, {});

  it("both are estimated, both savable, no invented characteristics", () => {
    expect(a.estimated.caloriesBurned!.confidence).toBeGreaterThanOrEqual(MIN_SAVE_CONFIDENCE);
    expect(b.estimated.caloriesBurned!.confidence).toBeGreaterThanOrEqual(MIN_SAVE_CONFIDENCE);
    expect(a.estimated.caloriesBurned!.value).toBe(b.estimated.caloriesBurned!.value);
    // Equal because both used the SAME default — arrived at independently.
    expect(a.assumptions.map((x) => x.assumption)).toContain("Used population default weight");
  });
});

describe("the context is one entity's, and only that entity's", () => {
  it("a populated context and an empty one cannot produce the same answer", () => {
    const withWeight = enrichActivityEntry("basketball", BALL, { weightKg: USER_KG });
    const without = enrichActivityEntry("basketball", BALL, {});
    expect(withWeight.estimated.caloriesBurned!.value)
      .not.toBe(without.estimated.caloriesBurned!.value);
  });

  it("an implausible weight is ignored in favour of the default", () => {
    const e = enrichActivityEntry("basketball", BALL, { weightKg: 3 });
    expect(e.estimated.caloriesBurned?.method).toContain("default weight");
  });
});

describe("explicit user values win, and nothing is invented", () => {
  it("a stated calorie count is never overwritten", () => {
    const e = enrichActivityEntry("basketball", { ...BALL, caloriesBurned: 300 }, { weightKg: USER_KG });
    expect(e.estimated.caloriesBurned).toBeUndefined();
  });

  it("no duration means no calories conjured from nothing", () => {
    expect(enrichActivityEntry("basketball", { activityType: "basketball" }, { weightKg: USER_KG })
      .estimated.caloriesBurned).toBeUndefined();
    expect(enrichActivityEntry("basketball", { duration: 0 }, { weightKg: USER_KG })
      .estimated.caloriesBurned).toBeUndefined();
  });

  it("an unknown activity still logs, at lower confidence, with the reason recorded", () => {
    const e = enrichActivityEntry("kabaddi", { duration: 30 }, { weightKg: USER_KG });
    expect(e.estimated.caloriesBurned?.value).toBeGreaterThan(0);
    expect(e.estimated.caloriesBurned!.confidence).toBeGreaterThanOrEqual(MIN_SAVE_CONFIDENCE);
    expect(e.assumptions.map((a) => a.assumption))
      .toContain("Unrecognized activity — used generic moderate-activity MET");
  });

  it("stated intensity is used; unstated registers the moderate assumption", () => {
    const hard = enrichActivityEntry("basketball", { ...BALL, intensity: "intense" }, { weightKg: USER_KG });
    const easy = enrichActivityEntry("basketball", { ...BALL, intensity: "light" }, { weightKg: USER_KG });
    const plain = enrichActivityEntry("basketball", BALL, { weightKg: USER_KG });
    expect(hard.estimated.caloriesBurned!.value).toBeGreaterThan(plain.estimated.caloriesBurned!.value);
    expect(easy.estimated.caloriesBurned!.value).toBeLessThan(plain.estimated.caloriesBurned!.value);
    expect(plain.assumptions.map((a) => a.assumption)).toContain("Assumed moderate intensity");
    expect(hard.assumptions.map((a) => a.assumption)).not.toContain("Assumed moderate intensity");
  });

  it("swimming — previously calorie-less — now estimates from weight", () => {
    const e = enrichActivityEntry("swimming", { activityType: "swimming", duration: 30 }, { weightKg: USER_KG });
    expect(e.estimated.caloriesBurned?.method).toContain("swimming");
  });
});

describe("messageClaimsCaloriesFor — one person's stated calories stay theirs", () => {
  const msg = "Sarah Miller and I both played basketball, I burned 300 calories";

  it("credits the clause's own speaker", () => {
    expect(messageClaimsCaloriesFor(msg, "Me", true)).toBe(true);
  });

  it("does not leak that claim to the other person", () => {
    expect(messageClaimsCaloriesFor(msg, "Sarah Miller", false)).toBe(false);
  });

  it("credits a named person when the clause names them", () => {
    expect(messageClaimsCaloriesFor("Sarah burned 400 calories", "Sarah Miller", false)).toBe(true);
  });

  it("a message with no calorie talk claims nothing", () => {
    const plain = "Sarah Miller and I both played basketball for 20 minutes";
    expect(messageClaimsCaloriesFor(plain, "Sarah Miller", false)).toBe(false);
    expect(messageClaimsCaloriesFor(plain, "Me", true)).toBe(false);
  });

  it("an unattributable calorie mention resolves to nobody (strip, then estimate)", () => {
    expect(messageClaimsCaloriesFor("that was 300 calories", "Sarah Miller", false)).toBe(false);
  });
});
