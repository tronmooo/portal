// ── Tracker summary lines + weight-scaled calories (shared/tracker-summary) ──
//
// Pins the reported bug: a supplement logged once must NOT read as a boolean
// "taken today", and a second dose the same day must count as a second dose.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  summarizeTrackerToday,
  isDoseTracker,
  isOccurrenceTracker,
  isLabValueTracker,
  isConcentrationUnit,
  occurrenceNoun,
  shortAgo,
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

describe("a lab VALUE is never a dose ledger", () => {
  // Reported with a screenshot of "Vitamin D · 3 entries · ng/mL · health"
  // wearing the medication UI: adherence, a dose tally, "log another dose".
  it("tells a concentration unit from a dose unit", () => {
    for (const u of ["ng/mL", "mg/dL", "nmol/L", "EU/dL", "µg/L", "mIU/L", "pg/mL", "g/dL"]) {
      expect(isConcentrationUnit(u)).toBe(true);
    }
    for (const u of ["mg", "mcg", "IU", "g", "mL", "tablet", "capsule", "oz", "", null]) {
      expect(isConcentrationUnit(u)).toBe(false);
    }
  });

  it("does not treat a ng/mL Vitamin D panel as a medication", () => {
    const lab = tracker({
      name: "Vitamin D", category: "health", unit: "ng/mL",
      fields: [{ name: "level", type: "number", unit: "ng/mL", isPrimary: true }],
      entries: [entry(at(11, 11), { level: 42 })],
    });
    expect(isLabValueTracker(lab)).toBe(true);
    expect(isDoseTracker(lab)).toBe(false);
    const s = summarizeTrackerToday(lab, { now: NOW });
    expect(s.line).toBe("42 ng/mL");
    expect(s.shape).toBe("measurement");
  });

  it("still treats a Vitamin D SUPPLEMENT (dosed in IU) as a dose tracker", () => {
    const supp = tracker({
      name: "Vitamin D", category: "health", unit: "IU",
      fields: [{ name: "dosage", type: "number", unit: "IU" }, { name: "adherence", type: "select" }],
      entries: [entry(at(9, 0), { adherence: "taken" }), entry(at(21, 0, -1), { adherence: "taken" })],
    });
    expect(isLabValueTracker(supp)).toBe(false);
    expect(isDoseTracker(supp)).toBe(true);
    expect(summarizeTrackerToday(supp, { now: NOW }).line).toBe("1 dose today");
  });
});

describe("EVERY explicit log action is an occurrence, not a re-send", () => {
  // The reported bug was medication-shaped, but the cause is general: two
  // identical logs minutes apart are two events on ANY tracker.
  // Every file that creates a tracker entry from a user action. Keep this in
  // step with the sweep: `grep -rn '/entries`' client/src`.
  const CLIENT = [
    "client/src/pages/trackers.tsx",
    "client/src/pages/profile-detail.tsx",
  ];

  it("no client POST to /entries omits allowDuplicate", () => {
    const offenders: string[] = [];
    for (const rel of CLIENT) {
      const src = readFileSync(resolve(__dirname, "..", rel), "utf8");
      // Each POST call site, sliced to the end of its argument object.
      const re = /apiRequest\(\s*["']POST["'],\s*`\/api\/trackers\/\$\{[^`]*\}\/entries`/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const chunk = src.slice(m.index, m.index + 700);
        const call = chunk.slice(0, chunk.indexOf("});") >= 0 ? chunk.indexOf("});") + 3 : 700);
        if (!call.includes("allowDuplicate")) {
          offenders.push(`${rel} @ ${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("covers every log surface, not just the medication button", () => {
    const counts = CLIENT.map(rel => {
      const src = readFileSync(resolve(__dirname, "..", rel), "utf8");
      return (src.match(/allowDuplicate: true/g) || []).length;
    });
    // trackers page: med button + entry form + quick-log + undo-restore.
    // profile detail: log dialog + optimistic log.
    expect(counts[0]).toBeGreaterThanOrEqual(4);
    expect(counts[1]).toBeGreaterThanOrEqual(2);
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

  it("derives adherence from the shared dose math, not a magic /7 divisor", () => {
    // A med added today has no week to be adherent to; computeMissedDoses
    // clamps the expectation to the tracker's own createdAt, which the old
    // inline `Math.max(7, …)` divisor did not — it opened at 14%.
    expect(SRC).toContain("computeMissedDoses(tracker, { days: 7 })");
    expect(SRC).not.toMatch(/weekTaken \/ Math\.max\(7/);
  });

  it("routes fitness cards through the one fitness engine, not a local guess", () => {
    // The old `kind === "bench"` branch read `primaryField` as the lifted
    // weight, so Squats rendered "Lifted 12 reps × 12 × 3 sets". That branch is
    // gone: shared/fitness-metrics decides the headline metric (pinned by
    // tests/fitness-metrics.test.ts), and this page must not re-derive it.
    expect(SRC).not.toContain('if (kind === "bench")');
    expect(SRC).toContain("fitnessForLatestEntry(tracker, last, fitnessCtx)");
  });

  it("resolves body weight ONCE, from the activity's owner", () => {
    // Two resolutions diverge; the owner-scoped one is correct (Sarah's game
    // is priced with Sarah's weight, not the viewer's).
    expect(SRC).toContain("calorieContextForOwner(ownerProfile)");
    expect(SRC).not.toContain("useBodyWeightKg");
    // The tally line is priced with the SAME owner context as the calorie pill.
    expect(SRC).toContain("calorieContext: fitnessCtx");
  });

  it("headlines an occurrence tracker with TODAY'S COUNT, not the last row", () => {
    // A Bathroom tracker storing `visits: 1` per log showed a big "1" over a
    // subline that correctly read "3 visits today" — the same
    // one-log-is-the-whole-day error as the badge, in the headline.
    const i = SRC.indexOf("// An OCCURRENCE tracker's headline is TODAY'S COUNT");
    expect(i).toBeGreaterThan(0);
    const block = SRC.slice(i, i + 900);
    expect(block).toContain('occ.shape === "occurrence" && occ.countToday > 0');
    expect(block).toContain("bigPrimary: String(occ.countToday)");
  });

  it("keeps an occurrence tracker with entries out of the No Data pile", () => {
    // A Bathroom tracker logs no number — the entries ARE the measurement —
    // so the generic fallback used to report hasData:false and hide it.
    expect(SRC).toContain('if (occ.shape === "occurrence" && occ.countToday > 0)');
  });
});
