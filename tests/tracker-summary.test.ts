// ── Tracker summary lines + weight-scaled calories (shared/tracker-summary) ──
//
// Pins the reported bug: a supplement logged once must NOT read as a boolean
// "taken today", and a second dose the same day must count as a second dose.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  summarizeTrackerToday,
  estimateActivityCalories,
  metForActivity,
  resolveBodyWeightKg,
  isDoseTracker,
  isOccurrenceTracker,
  occurrenceNoun,
  shortAgo,
  DEFAULT_BODY_WEIGHT_KG,
} from "@shared/tracker-summary";
import { displayUnit } from "@shared/tracker-units";

// A fixed clock so every line is deterministic. 2026-09-16, 9:54 AM local.
const NOW = new Date(2026, 8, 16, 9, 54, 0).getTime();
const at = (h: number, m = 0, dayOffset = 0) =>
  new Date(2026, 8, 16 + dayOffset, h, m, 0).toISOString();

function tracker(over: Record<string, any> = {}): any {
  return {
    id: "t1",
    name: "Multivitamin",
    category: "medication",
    unit: null,
    fields: [],
    entries: [],
    linkedProfiles: [],
    createdAt: at(8, 0, -30),
    ...over,
  };
}

const entry = (timestamp: string, values: Record<string, any> = {}) => ({
  id: `e-${timestamp}`,
  timestamp,
  values,
  computed: {},
});

describe("medication / supplement doses are COUNTED, never a boolean", () => {
  it("reports one dose as '1 dose today' with a last-taken line", () => {
    const t = tracker({ entries: [entry(at(9, 50), { adherence: "taken", drug: "Multivitamin" })] });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.line).toBe("1 dose today");
    expect(s.shape).toBe("dose");
    expect(s.countToday).toBe(1);
    expect(s.lastLine).toBe("Last: 4m ago");
  });

  it("counts THREE doses on the same day as three independent occurrences", () => {
    const t = tracker({
      entries: [
        entry(at(9, 0), { adherence: "taken" }),
        entry(at(13, 0), { adherence: "taken" }),
        entry(at(19, 0), { adherence: "taken" }),
      ],
    });
    // Evaluated at end of day so all three are in the past.
    const endOfDay = new Date(2026, 8, 16, 21, 0, 0).getTime();
    const s = summarizeTrackerToday(t, { now: endOfDay });
    expect(s.countToday).toBe(3);
    expect(s.line).toBe("3 doses today");
  });

  it("identical values minutes apart still count separately (no trackerId+date merge)", () => {
    const same = { adherence: "taken", drug: "Multivitamin", dosage: 1 };
    const t = tracker({
      entries: [entry(at(9, 50), same), entry(at(9, 52), { ...same })],
    });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.countToday).toBe(2);
    expect(s.line).toBe("2 doses today");
  });

  it("says no doses today — and how many were expected — when today is empty", () => {
    const t = tracker({
      name: "Lisinopril (twice daily)",
      entries: [entry(at(19, 0, -1), { adherence: "taken" })],
    });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.countToday).toBe(0);
    expect(s.line).toBe("0 of 2 doses today");
    expect(s.lastLine).toContain("Last:");
  });

  it("recognizes dose trackers by category, adherence field, and supplement name", () => {
    expect(isDoseTracker(tracker())).toBe(true);
    expect(isDoseTracker(tracker({ name: "Fish Oil", category: "custom" }))).toBe(true);
    expect(isDoseTracker(tracker({ name: "Lisinopril", category: "health", fields: [{ name: "adherence" }] }))).toBe(true);
    expect(isDoseTracker(tracker({ name: "Soccer", category: "fitness" }))).toBe(false);
  });
});

describe("the other tracker shapes each get their own honest line", () => {
  it("Water sums today's intake: '64 oz today'", () => {
    const t = tracker({
      name: "Water",
      category: "health",
      fields: [{ name: "amount", type: "number", unit: "oz", isPrimary: true }],
      entries: [
        entry(at(8, 0), { amount: 32 }),
        entry(at(9, 30), { amount: 32 }),
        entry(at(20, 0, -1), { amount: 100 }),
      ],
    });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.line).toBe("64 oz today");
    expect(s.shape).toBe("additive");
  });

  it("Soccer shows duration and weight-scaled calories: '30 min · ~280 cal'", () => {
    const t = tracker({
      name: "Soccer",
      category: "fitness",
      fields: [{ name: "duration", type: "number", unit: "min", isPrimary: true }],
      entries: [entry(at(8, 30), { duration: 30, activityType: "soccer" })],
    });
    // 184.6 lb ≈ 83.7 kg; soccer MET 7 → 7 × 83.7 × 0.5h ≈ 293 kcal.
    const s = summarizeTrackerToday(t, { now: NOW, bodyWeightKg: 83.7 });
    expect(s.line).toMatch(/^30 min · ~\d+ cal$/);
    expect(s.shape).toBe("session");
    expect(s.caloriesEstimated).toBe(true);
    expect(s.calories).toBeGreaterThan(250);
    expect(s.calories).toBeLessThan(340);
  });

  it("uses an explicitly logged calorie count as-is (no tilde)", () => {
    const t = tracker({
      name: "Soccer",
      category: "fitness",
      fields: [{ name: "duration", type: "number", unit: "min" }],
      entries: [entry(at(8, 30), { duration: 30, caloriesBurned: 265 })],
    });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.line).toBe("30 min · 265 cal");
    expect(s.caloriesEstimated).toBe(false);
  });

  it("Squats show the set structure: '12 reps × 3 sets'", () => {
    const t = tracker({
      name: "Squats",
      category: "fitness",
      fields: [{ name: "reps", type: "number" }, { name: "sets", type: "number" }],
      entries: [entry(at(7, 0), { reps: 12, sets: 3 })],
    });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.line).toBe("12 reps × 3 sets");
    expect(s.shape).toBe("strength");
  });

  it("a loaded lift keeps its weight: '185 lb × 8 reps × 3 sets'", () => {
    const t = tracker({
      name: "Bench Press",
      category: "fitness",
      fields: [{ name: "weight", type: "number", unit: "lbs" }, { name: "reps", type: "number" }, { name: "sets", type: "number" }],
      entries: [entry(at(7, 0), { weight: 185, reps: 8, sets: 3 })],
    });
    expect(summarizeTrackerToday(t, { now: NOW }).line).toBe("185 lb × 8 reps × 3 sets");
  });

  it("Weight shows the reading itself: '184.6 lb'", () => {
    const t = tracker({
      name: "Weight",
      category: "health",
      unit: "lbs",
      fields: [{ name: "weight", type: "number", unit: "lbs", isPrimary: true }],
      entries: [entry(at(6, 30), { weight: 184.6 })],
    });
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.line).toBe("184.6 lb");
    // A plain reading: the card keeps its own richer subline for this shape.
    expect(s.shape).toBe("measurement");
  });

  it("Bathroom counts occurrences: '3 visits today'", () => {
    const t = tracker({
      name: "Bathroom",
      category: "health",
      fields: [],
      entries: [entry(at(7, 0)), entry(at(8, 15)), entry(at(9, 40))],
    });
    expect(occurrenceNoun(t)).toBe("visit");
    expect(isOccurrenceTracker(t)).toBe(true);
    const s = summarizeTrackerToday(t, { now: NOW });
    expect(s.line).toBe("3 visits today");
    expect(s.shape).toBe("occurrence");
  });

  it("an occurrence entry carrying its own count adds to the tally", () => {
    const t = tracker({
      name: "Bathroom",
      category: "health",
      fields: [{ name: "visits", type: "number" }],
      entries: [entry(at(7, 0), { visits: 2 }), entry(at(9, 0), { visits: 1 })],
    });
    expect(summarizeTrackerToday(t, { now: NOW }).line).toBe("3 visits today");
  });

  it("an empty tracker summarizes to nothing rather than a fake zero", () => {
    const s = summarizeTrackerToday(tracker({ entries: [] }), { now: NOW });
    expect(s.line).toBe("");
    expect(s.shape).toBe("empty");
    expect(s.countToday).toBe(0);
    expect(s.lastTimestamp).toBeNull();
  });
});

describe("calories are MET × body weight × hours", () => {
  it("scales with the person's own weight", () => {
    const light = estimateActivityCalories({ activityName: "Soccer", minutes: 30, bodyWeightKg: 60 })!;
    const heavy = estimateActivityCalories({ activityName: "Soccer", minutes: 30, bodyWeightKg: 100 })!;
    expect(light.calories).toBe(Math.round(7 * 60 * 0.5));
    expect(heavy.calories).toBe(Math.round(7 * 100 * 0.5));
    expect(heavy.calories).toBeGreaterThan(light.calories);
    expect(light.weightKnown).toBe(true);
  });

  it("falls back to the population standard when the weight is unknown", () => {
    const est = estimateActivityCalories({ activityName: "Soccer", minutes: 60 })!;
    expect(est.weightKnown).toBe(false);
    expect(est.weightKg).toBe(DEFAULT_BODY_WEIGHT_KG);
    expect(est.calories).toBe(Math.round(7 * DEFAULT_BODY_WEIGHT_KG * 1));
    expect(est.method).toContain("default weight");
  });

  it("ignores an implausible weight rather than scaling to it", () => {
    const est = estimateActivityCalories({ activityName: "Soccer", minutes: 30, bodyWeightKg: 4 })!;
    expect(est.weightKnown).toBe(false);
    expect(est.weightKg).toBe(DEFAULT_BODY_WEIGHT_KG);
  });

  it("intensity moves the MET up and down", () => {
    const base = estimateActivityCalories({ activityName: "Soccer", minutes: 30, bodyWeightKg: 80 })!;
    const hard = estimateActivityCalories({ activityName: "Soccer", minutes: 30, bodyWeightKg: 80, intensity: "intense" })!;
    const easy = estimateActivityCalories({ activityName: "Soccer", minutes: 30, bodyWeightKg: 80, intensity: "light" })!;
    expect(hard.calories).toBeGreaterThan(base.calories);
    expect(easy.calories).toBeLessThan(base.calories);
  });

  it("knows the MET of common activities and admits when it doesn't", () => {
    expect(metForActivity("Soccer")).toBe(7);
    expect(metForActivity("Evening Yoga")).toBe(2.5);
    expect(metForActivity("Quarterly Budget Review")).toBeNull();
    expect(estimateActivityCalories({ activityName: "Quarterly Budget Review", minutes: 30 })).toBeNull();
  });

  it("returns nothing for a zero or missing duration", () => {
    expect(estimateActivityCalories({ activityName: "Soccer", minutes: 0 })).toBeNull();
    expect(estimateActivityCalories({ activityName: "Soccer", minutes: NaN as any })).toBeNull();
  });
});

describe("resolveBodyWeightKg", () => {
  it("prefers the profile's own stated weight", () => {
    const kg = resolveBodyWeightKg({ profileFields: { weight: "184.6 lbs" } });
    expect(kg).toBeGreaterThan(83);
    expect(kg).toBeLessThan(84.5);
  });

  it("falls back to the newest weight-tracker reading", () => {
    const weightTracker = tracker({
      name: "Weight",
      category: "health",
      unit: "lbs",
      fields: [{ name: "weight", type: "number", unit: "lbs" }],
      entries: [entry(at(6, 0, -3), { weight: 190 }), entry(at(6, 0), { weight: 184.6 })],
    });
    const kg = resolveBodyWeightKg({ profileFields: {}, trackers: [weightTracker], now: NOW })!;
    expect(Math.round(kg)).toBe(84); // 184.6 lb, not the older 190
  });

  it("returns null when nobody recorded a weight", () => {
    expect(resolveBodyWeightKg({ profileFields: {}, trackers: [] })).toBeNull();
  });
});

describe("formatting helpers", () => {
  it("shortAgo reads in the units a person would use", () => {
    expect(shortAgo(NOW - 30_000, NOW)).toBe("just now");
    expect(shortAgo(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(shortAgo(NOW - 3 * 3600_000, NOW)).toBe("3h ago");
    expect(shortAgo(NOW - 2 * 86400_000, NOW)).toBe("2d ago");
  });

  it("displayUnit normalizes the shorthand units", () => {
    expect(displayUnit("lbs")).toBe("lb");
    expect(displayUnit("minutes")).toBe("min");
    expect(displayUnit("oz")).toBe("oz");
    expect(displayUnit("")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source guards for the reported UI regression. The med suite lives inside an
// 8k-line page component that can't be mounted in isolation, so these pin the
// two lines that caused the bug: the log button must not be gated on a
// "taken today" flag, and each press must opt out of the entry dedup.
// ─────────────────────────────────────────────────────────────────────────────
describe("the medication suite never gates logging on a taken-today flag", () => {
  const SRC = readFileSync(resolve(__dirname, "../client/src/pages/trackers.tsx"), "utf8");

  it("has no takenToday flag left to gate the log button with", () => {
    expect(SRC).not.toMatch(/\btakenToday\b/);
    expect(SRC).not.toContain("Taken today");
  });

  it("renders the log-dose button unconditionally", () => {
    const i = SRC.indexOf('data-testid="button-log-dose"');
    expect(i).toBeGreaterThan(0);
    // Nothing between the button and the preceding comment block conditions it.
    const before = SRC.slice(Math.max(0, i - 700), i);
    expect(before).not.toMatch(/\{\s*!\w*[Tt]aken\w*\s*&&/);
  });

  it("marks every dose log as a deliberate duplicate so none is swallowed", () => {
    expect(SRC).toContain("allowDuplicate: true");
  });

  it("counts today's doses instead of testing for one", () => {
    expect(SRC).toMatch(/const dosesToday = todayEntries\.length/);
  });
});
