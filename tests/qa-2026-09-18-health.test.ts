// tests/qa-2026-09-18-health.test.ts
//
// QA 2026-09-18 — health, wellness and trackers (findings F-32 … F-43).
// Pure-logic pins for the shared rules every surface now reads:
//
//   F-32  an empty score tells "nothing logged today" from "no source";
//   F-33  ONE blood-pressure verdict for a pair (121/76 = Elevated everywhere);
//   F-34  a nutrition average is calories per day, never an entry count;
//   F-35  a heart-rate series is RESTING readings; 60–100 with "Athletic" below;
//   F-36  one calorie figure per activity entry — logged wins, else the estimate;
//   F-37  one duration and one distance per session, clock strings ignored;
//   F-38  hydration is a Wellness signal fed by the same tracker as the dashboard;
//   F-39  score = weighted mean of COUNTED components; hours→minutes once;
//   F-40  "needs attention" = out of range, overdue, or a bad trend — never "has data";
//   F-41  a logged value speaks with its unit ("181.2 lbs"), not its field name;
//   F-42  one habit rule for the card, the modal and the streak chip;
//   F-43  the chat recap is one line per item and never invents a sleep quality.
// The rendered copy is pinned in tests/qa-2026-09-18-health.dom.test.tsx.
import { describe, it, expect } from "vitest";
import { classifyBloodPressure, bloodPressureCategory, bloodPressureFlag } from "@shared/blood-pressure";
import { isRestingHeartRateReading, getCanonicalMetric, flagLabelFor, flagAgainstReference, resolveCanonicalMetric } from "@shared/wellness-canon";
import {
  collectMetrics, todaySignals, bodyVitals, activityHistory, wellnessScore, sourceState, anySourceConnected, hoursToMinutes,
} from "@shared/wellness-readout";
import { averagePerDay, summarizeTrackerToday } from "@shared/tracker-summary";
import { trackerNeedsAttention, attentionReason, usualGapDays, favorableDirectionFor } from "@shared/tracker-attention";
import { formatLoggedValues } from "@shared/tracker-units";
import { bestHabitStreak, habitsDayRollup } from "@shared/habit-progress";
import { isHabitDoneOn } from "@shared/habit-schedule";
import { buildTurnRecap } from "@shared/quick-log";
import { summarizeOpDetail, buildBulkReply } from "../server/ai-bulk-log";
import { stripUnstatedSleepQuality } from "../server/tracker-normalize";
import { extractVitals } from "../client/src/lib/wellness-metrics";

const NOW = new Date("2026-09-18T15:00:00Z");
const daysAgo = (n: number, hour = 15) => {
  const d = new Date(NOW.getTime() - n * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const tracker = (over: any): any => ({
  id: over.id || `t-${over.name}`, name: over.name, category: over.category || "health",
  unit: over.unit || "", fields: over.fields || [{ name: "value", type: "number" }],
  entries: over.entries || [], linkedProfiles: [],
});
const entry = (values: any, at: string, extra: any = {}) => ({ id: `e-${at}-${JSON.stringify(values)}`, values, timestamp: at, ...extra });

// ── F-33 ─────────────────────────────────────────────────────────────────────
describe("F-33 one blood-pressure verdict for a pair", () => {
  it("121/76 is Elevated — the same word on the card, the server and the Wellness tab", () => {
    expect(classifyBloodPressure(121, 76)).toMatchObject({ category: "elevated", label: "Elevated", tone: "warn" });
    expect(bloodPressureCategory(118, 76)).toBe("normal");
    expect(bloodPressureCategory(121, 82)).toBe("high_stage1");   // diastolic decides too
    expect(bloodPressureCategory(135, 76)).toBe("high_stage1");
    expect(bloodPressureCategory(142, 76)).toBe("high_stage2");
    expect(bloodPressureCategory(181, 76)).toBe("crisis");
    expect(bloodPressureCategory(85, 55)).toBe("low");
  });

  it("the Wellness Body & vitals rows carry the pair's verdict, not a single-value 'High'", () => {
    const rows = bodyVitals(collectMetrics([
      tracker({ name: "Blood Pressure", entries: [entry({ systolic: 121, diastolic: 76 }, daysAgo(0))] }),
    ], { now: NOW })).flatMap((p) => p.rows);
    const sys = rows.find((r) => r.metricId === "bp_systolic")!;
    const dia = rows.find((r) => r.metricId === "bp_diastolic")!;
    expect(sys.flag).toBe("elevated");
    expect(sys.flagLabel).toBe("Elevated");
    expect(dia.flag).toBe("elevated");
    expect(sys.reference).toBe("< 120 mmHg");
    expect(dia.reference).toBe("< 80 mmHg");
    expect(bloodPressureFlag("high_stage1")).toBe("high");
  });
});

// ── F-34 ─────────────────────────────────────────────────────────────────────
describe("F-34 nutrition average is calories per day", () => {
  it("averages the calorie field by day — never the entry count", () => {
    const entries = [
      entry({ item: "Chicken Sandwich", calories: 430, servings: 1 }, daysAgo(0)),
      entry({ item: "Salad", calories: 320, servings: 1 }, daysAgo(0, 12)),
      entry({ item: "Oatmeal", calories: 250, servings: 2 }, daysAgo(1)),
    ];
    // Day 1: 430 + 320 = 750; day 2: 250 → (750 + 250) / 2.
    expect(averagePerDay(entries, (e) => e.values?.calories)).toBe(500);
    // The old average was over the primary field — a serving count — "2 cal".
    expect(averagePerDay(entries, (e) => e.values?.calories)).not.toBe(2);
    expect(averagePerDay([], () => 1)).toBeNull();
    expect(averagePerDay([entry({ item: "Water" }, daysAgo(0))], (e) => e.values?.calories)).toBeNull();
  });
});

// ── F-35 ─────────────────────────────────────────────────────────────────────
describe("F-35 a heart-rate series is resting readings", () => {
  it("a reading with an exercise context is not a resting reading; one without counts", () => {
    expect(isRestingHeartRateReading({ heart_rate: 171, context: "during run" })).toBe(false);
    expect(isRestingHeartRateReading({ heart_rate: 150, type: "workout peak" })).toBe(false);
    expect(isRestingHeartRateReading({ heart_rate: 58, _notes: "after my morning run" })).toBe(false);
    expect(isRestingHeartRateReading({ heart_rate: 58 })).toBe(true);
    expect(isRestingHeartRateReading({ heart_rate: 61, context: "morning, seated" })).toBe(true);
  });

  it("the Wellness series and the recovery signal ignore the 171 logged mid-run", () => {
    const m = collectMetrics([
      tracker({ name: "Heart Rate", fields: [{ name: "heart_rate", type: "number", unit: "bpm", isPrimary: true }], entries: [
        entry({ heart_rate: 60 }, daysAgo(2)),
        entry({ heart_rate: 171, context: "during run" }, daysAgo(1)),
        entry({ heart_rate: 58 }, daysAgo(0)),
      ] }),
    ], { now: NOW });
    expect(m.get("heart_rate")!.readings.map((r) => r.value)).toEqual([60, 58]);
    expect(m.get("heart_rate")!.previous!.value).toBe(60); // "171 → 58" never appears
  });

  it("resting HR reference is 60–100 and below it reads Athletic, not Low", () => {
    for (const id of ["heart_rate", "resting_hr"]) {
      const metric = getCanonicalMetric(id)!;
      expect(metric.ref).toEqual({ low: 60, high: 100 });
      expect(flagLabelFor(metric, flagAgainstReference(metric, 58))).toBe("Athletic");
      expect(flagLabelFor(metric, flagAgainstReference(metric, 72))).toBeNull();
      expect(flagLabelFor(metric, flagAgainstReference(metric, 108))).toBe("High");
    }
    const rows = bodyVitals(collectMetrics([
      tracker({ name: "Heart Rate", entries: [entry({ value: 58 }, daysAgo(0))] }),
    ], { now: NOW })).flatMap((p) => p.rows);
    expect(rows[0].flagLabel).toBe("Athletic");
    expect(bodyVitals(collectMetrics([tracker({ name: "Heart Rate", entries: [entry({ value: 58 }, daysAgo(0))] })], { now: NOW }))[0].outOfRange).toBe(0);
  });
});

// ── F-36 ─────────────────────────────────────────────────────────────────────
describe("F-36 one calorie figure per activity entry", () => {
  const walking = (values: any, computed: any = {}) => tracker({
    name: "Walking", category: "fitness",
    fields: [{ name: "duration", type: "number", unit: "min", isPrimary: true }, { name: "caloriesBurned", type: "number", unit: "kcal" }],
    entries: [entry(values, daysAgo(0), { computed })],
  });

  it("a calorie count the person logged is shown as-is and never re-estimated", () => {
    const s = summarizeTrackerToday(walking({ duration: 34, caloriesBurned: 139 }), { now: NOW.getTime(), calorieContext: { bodyWeightKg: 90 } });
    expect(s.line).toBe("34 min · 139 cal");
    expect(s.caloriesEstimated).toBe(false);
  });

  it("the tally line leaves calories to the card's pill when asked, so one walk shows one number", () => {
    const s = summarizeTrackerToday(walking({ duration: 34 }), { now: NOW.getTime(), calorieContext: { bodyWeightKg: 90 }, includeCalories: false });
    expect(s.line).toBe("34 min");
    expect(s.calories).toBeGreaterThan(0);           // still computed for callers that want it
    expect(s.caloriesEstimated).toBe(true);
  });

  it("an estimate the engine mirrored into values at log time is not treated as user-logged", () => {
    const t = walking(
      { duration: 34, caloriesBurned: 139, _enrichment: { estimated: { caloriesBurned: { value: 139 } } } },
      { caloriesBurned: 139, caloriesBurnedSource: "estimated", caloriesBurnedMethod: "MET" },
    );
    const s = summarizeTrackerToday(t, { now: NOW.getTime(), calorieContext: { bodyWeightKg: 90 } });
    expect(s.calories).toBe(139);                     // the stored estimate, not a second one
    expect(s.caloriesEstimated).toBe(true);
    expect(s.line).toBe("34 min · ~139 cal");
  });
});

// ── F-37 ─────────────────────────────────────────────────────────────────────
describe("F-37 activity roll-ups match the entries", () => {
  it("a 2 mi / 19 min run stored three ways is still 19 minutes and 2 miles", () => {
    const run = entry(
      { distance: 2, duration: 19, durationMinutes: 19, pace: "9:30", time: "7:30" },
      daysAgo(1),
      { computed: { durationMinutes: 19 } },
    );
    const groups = activityHistory([tracker({ name: "Running", category: "fitness", entries: [run] })], { now: NOW });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ sessions: 1, minutes: 19, distance: 2 });
  });

  it("thirteen such runs read as 13 sessions · 247 min · 26 mi, not 709 min", () => {
    const entries = Array.from({ length: 13 }, (_, i) => entry(
      { distance: 2, duration: 19, durationMinutes: 19 }, daysAgo(i + 1), { computed: { durationMinutes: 19 } },
    ));
    const [g] = activityHistory([tracker({ name: "Running", category: "fitness", entries })], { now: NOW });
    expect(g).toMatchObject({ sessions: 13, minutes: 13 * 19, distance: 26 });
  });

  it("a workout logged with a clock time is 45 minutes, not 655", () => {
    const entries = Array.from({ length: 4 }, (_, i) => entry({ duration: 45, time: "6:10 PM" }, daysAgo(i + 1)));
    const [g] = activityHistory([tracker({ name: "Core Workout", category: "fitness", entries })], { now: NOW });
    expect(g).toMatchObject({ sessions: 4, minutes: 180 });
  });
});

// ── F-38 ─────────────────────────────────────────────────────────────────────
describe("F-38 hydration is a Wellness signal", () => {
  const hydration = tracker({
    name: "Hydration", fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    entries: [
      entry({ ounces: 64 }, daysAgo(2)), entry({ ounces: 48 }, daysAgo(1)),
      entry({ ounces: 24 }, daysAgo(0, 13)), entry({ ounces: 16 }, daysAgo(0, 14)),
    ],
  });

  it("sums today's water into one tile, against a 30-day baseline of daily totals", () => {
    const s = todaySignals(collectMetrics([hydration], { now: NOW, timezone: "UTC" }));
    const water = s.find((x) => x.key === "hydration")!;
    expect(water.label).toBe("Water");
    expect(water.value).toBe(40);
    expect(water.unit).toBe("oz");
    expect(water.avg30).toBe(56);          // (64 + 48) / 2 — today excluded
    expect(water.series).toEqual([64, 48, 40]);
    expect(sourceState(collectMetrics([hydration], { now: NOW, timezone: "UTC" })).hydration).toBe(true);
  });

  it("reads the SAME tracker and total the dashboard's Water tile shows", () => {
    expect(extractVitals([hydration], { now: NOW }).hydration.value).toBe(40);
    expect(resolveCanonicalMetric("Hydration", "health", "ounces")?.id).toBe("hydration");
    expect(resolveCanonicalMetric("Water Temperature", "home", "value")).toBeNull();
    expect(resolveCanonicalMetric("Weight", "health", "weight")?.id).toBe("weight");
  });

  it("says nothing was logged today (with the last date) once water has ever been tracked", () => {
    const old = tracker({ name: "Water", entries: [entry({ value: 40 }, daysAgo(3))] });
    const water = todaySignals(collectMetrics([old], { now: NOW, timezone: "UTC" })).find((x) => x.key === "hydration")!;
    expect(water.value).toBeNull();
    expect(water.lastAt).toBe(daysAgo(3));
    expect(todaySignals(collectMetrics([], { now: NOW })).find((x) => x.key === "hydration")!.lastAt).toBeNull();
  });
});

// ── F-32 / F-39 ──────────────────────────────────────────────────────────────
describe("F-32 an empty score knows whether anything is connected", () => {
  it("is connected when a source has history but nothing today; not when there is no source", () => {
    const stale = wellnessScore(collectMetrics([
      tracker({ name: "Sleep", unit: "h", entries: [entry({ value: 7 }, daysAgo(5))] }),
    ], { now: NOW }));
    expect(stale.value).toBeNull();
    expect(stale.connected).toBe(true);
    const none = wellnessScore(collectMetrics([], { now: NOW }));
    expect(none.value).toBeNull();
    expect(none.connected).toBe(false);
    expect(anySourceConnected({ sleep: false, activity: false, recovery: false, labs: false, body: true })).toBe(true);
    expect(anySourceConnected({ sleep: false, activity: false, recovery: false, labs: false, body: false })).toBe(false);
  });
});

describe("F-39 the score is a weighted mean over counted components only", () => {
  it("one component scored 100 is a score of 100", () => {
    const score = wellnessScore(collectMetrics([
      tracker({ name: "Sleep", unit: "h", entries: [entry({ value: 8 }, daysAgo(0))] }),
    ], { now: NOW }));
    expect(score.components.find((c) => c.key === "sleep")).toMatchObject({ score: 100, weight: 1 });
    expect(score.value).toBe(100);
  });

  it("a 6.7 h night scores 88 and says so; its weight is a separate number", () => {
    const score = wellnessScore(collectMetrics([
      tracker({ name: "Sleep", unit: "h", entries: [entry({ value: 6.5 }, daysAgo(0))] }),
    ], { now: NOW }));
    expect(score.components[0].score).toBe(88);
    expect(score.components[0].weight).toBe(1);
    expect(score.value).toBe(88);
  });

  it("converts hours to minutes ONE way: 0.3 h is 18 min", () => {
    expect(hoursToMinutes(0.3)).toBe(18);
    expect(hoursToMinutes(-0.3)).toBe(-18);
    expect(hoursToMinutes(0.25)).toBe(15);
  });
});

// ── F-40 ─────────────────────────────────────────────────────────────────────
describe("F-40 needs attention means out of range, overdue, or a bad trend", () => {
  const daily = Array.from({ length: 10 }, (_, i) => daysAgo(i + 1));
  const monthly = [daysAgo(20), daysAgo(50), daysAgo(80), daysAgo(110)];

  it("an out-of-range badge is attention; freshness badges are not", () => {
    for (const label of ["High", "Crisis", "Elevated", "Low", "Incomplete", "Due", "Stage 1 high"]) {
      expect(attentionReason({ statusLabel: label, entryTimestamps: daily, now: NOW.getTime() })).toBe("out_of_range");
    }
    for (const label of ["In range", "Normal", "Today", "This week", "This month", "Stale", "Taken", "Goal met"]) {
      expect(trackerNeedsAttention({ statusLabel: label, entryTimestamps: daily, now: NOW.getTime() })).toBe(false);
    }
  });

  it("a monthly tracker logged three weeks ago is on schedule; silent for 70 days it is overdue", () => {
    expect(usualGapDays(monthly)).toBe(30);
    expect(trackerNeedsAttention({ statusLabel: "This month", entryTimestamps: monthly, now: NOW.getTime() })).toBe(false);
    const lapsed = [daysAgo(70), daysAgo(100), daysAgo(130), daysAgo(160)];
    expect(attentionReason({ statusLabel: "Stale", entryTimestamps: lapsed, now: NOW.getTime() })).toBe("overdue");
  });

  it("a daily tracker silent for three days is overdue; two entries never are", () => {
    const lapsed = Array.from({ length: 8 }, (_, i) => daysAgo(i + 3));
    expect(attentionReason({ entryTimestamps: lapsed, now: NOW.getTime() })).toBe("overdue");
    expect(trackerNeedsAttention({ entryTimestamps: [daysAgo(40), daysAgo(41)], now: NOW.getTime() })).toBe(false);
  });

  it("merely having data, or not being logged today, is never attention", () => {
    expect(trackerNeedsAttention({ statusLabel: "In range", entryTimestamps: [daysAgo(1)], now: NOW.getTime() })).toBe(false);
    expect(trackerNeedsAttention({ statusLabel: null, entryTimestamps: daily, trendPct: 3, favorableDirection: "up", now: NOW.getTime() })).toBe(false);
  });

  it("a trend the wrong way for the metric is attention", () => {
    expect(attentionReason({ entryTimestamps: daily, trendPct: 12, favorableDirection: "down", now: NOW.getTime() })).toBe("negative_trend");
    expect(attentionReason({ entryTimestamps: daily, trendPct: -15, favorableDirection: "up", now: NOW.getTime() })).toBe("negative_trend");
    expect(attentionReason({ entryTimestamps: daily, trendPct: -15, favorableDirection: "down", now: NOW.getTime() })).toBeNull();
    expect(attentionReason({ entryTimestamps: daily, trendPct: -15, favorableDirection: "neutral", now: NOW.getTime() })).toBeNull();
    expect(favorableDirectionFor("Weight")).toBe("down");
    expect(favorableDirectionFor("Sleep")).toBe("up");
    expect(favorableDirectionFor("Guitar practice")).toBe("neutral");
  });
});

// ── F-41 ─────────────────────────────────────────────────────────────────────
describe("F-41 a logged value speaks with its unit", () => {
  it("181.2 weight → 181.2 lbs, from the tracker name alone or from its fields", () => {
    expect(formatLoggedValues({ weight: 181.2 }, "Weight")).toEqual(["181.2 lbs"]);
    expect(formatLoggedValues({ weight: 82.4 }, { name: "Weight", fields: [{ name: "weight", type: "number", unit: "kg" }] })).toEqual(["82.4 kg"]);
    expect(formatLoggedValues({ hours: 6.5 }, "Sleep")).toEqual(["6.5 hr"]);
    expect(formatLoggedValues({ ounces: 40 }, "Hydration")).toEqual(["40 oz"]);
    expect(formatLoggedValues({ systolic: 121, diastolic: 76 }, "Blood Pressure")).toEqual(["121 mmHg", "76 mmHg"]);
  });

  it("keeps labels, drops metadata, and never prints a field name as a unit", () => {
    expect(formatLoggedValues({ item: "Chicken Sandwich", calories: 430, _notes: "lunch" }, "Nutrition")).toEqual(["Chicken Sandwich", "430 kcal"]);
    expect(formatLoggedValues({ count: 1, method: "blunt" }, "Cannabis")).toEqual(["1 count", "blunt"]);
    expect(formatLoggedValues({ taken: true, dosage: "10 mg" }, "Lisinopril")).toEqual(["taken", "dosage 10 mg"]);
    expect(formatLoggedValues({ weight: 181.2 }, "Weight").join(" ")).not.toMatch(/weight/);
  });
});

// ── F-42 ─────────────────────────────────────────────────────────────────────
describe("F-42 one habit rule for the card, the modal and the streak chip", () => {
  const today = "2026-09-18";
  const habits = [
    { id: "a", name: "Morning Water", frequency: "daily", targetPerDay: 1, currentStreak: 1, checkins: [{ date: today }] },
    { id: "b", name: "Vitamins", frequency: "daily", targetPerDay: 2, currentStreak: 0, checkins: [{ date: today }] },
    { id: "c", name: "Stretch", frequency: "daily", targetPerDay: 1, currentStreak: 2, checkins: [{ date: today }] },
    { id: "d", name: "Read", frequency: "daily", targetPerDay: 1, currentStreak: 0, checkins: [] },
    { id: "e", name: "Gym", frequency: "weekly", targetDays: [1], targetPerDay: 1, currentStreak: 5, checkins: [] }, // not due on a Friday
    { id: "f", name: "Old", frequency: "daily", targetPerDay: 1, currentStreak: 9, archivedAt: "2026-01-01", checkins: [] },
  ];

  it("counts habits complete over habits due, and agrees with isHabitDoneOn", () => {
    const active = habits.filter((h) => !h.archivedAt);
    const r = habitsDayRollup(active, today);
    expect(`${r.habitsComplete}/${r.habitsScheduled}`).toBe("2/4");
    expect(r.habitsComplete).toBe(active.filter((h) => isHabitDoneOn(h, today) && r.habitsScheduled > 0 && h.frequency === "daily").length);
    // The occurrence ratio is a different number and must not be shown as the habit count.
    expect(`${r.completed}/${r.required}`).toBe("3/5");
  });

  it("the best streak ignores archived habits and reads the live currentStreak", () => {
    expect(bestHabitStreak(habits)).toBe(5);
    expect(bestHabitStreak(habits.filter((h) => h.frequency === "daily"))).toBe(2);
    expect(bestHabitStreak([])).toBe(0);
  });
});

// ── F-43 ─────────────────────────────────────────────────────────────────────
describe("F-43 the chat recap is one line per item and invents nothing", () => {
  it("renders weight, sleep and water as three lines with units and no leaked field names", () => {
    const ops = [
      { trackerName: "Weight", values: { weight: 181.2 } },
      { trackerName: "Sleep", values: { hours: 6.5 } },
      { trackerName: "Hydration", values: { ounces: 40 } },
    ];
    const text = buildTurnRecap(ops.map((o) => ({ status: "ok" as const, tool: "log_tracker_entry", label: o.trackerName, detail: summarizeOpDetail(o) })));
    expect(text).toBe("Logged 3 of 3:\n- Weight 181.2 lbs\n- Sleep 6.5 hr\n- Hydration 40 oz");
    expect(text).not.toMatch(/Logged:|via |weight 181|hours 6|ounces 40|quality/);
  });

  it("the bulk reply uses the same list shape", () => {
    const reply = buildBulkReply([
      { index: 0, raw: "weighed 181.2", tool: "log_tracker_entry", status: "ok", trackerName: "Weight", detail: summarizeOpDetail({ trackerName: "Weight", values: { weight: 181.2 } }) },
      { index: 1, raw: "slept 6.5", tool: "log_tracker_entry", status: "ok", trackerName: "Sleep", detail: summarizeOpDetail({ trackerName: "Sleep", values: { hours: 6.5 } }) },
    ], []);
    expect(reply).toBe("Logged 2 of 2 actions:\n- Weight — 181.2 lbs\n- Sleep — 6.5 hr");
  });

  it("drops a sleep quality the user never described, and keeps one they did", () => {
    const msg = "weighed myself this morning, 181.2 lbs, slept from 11 to 5:30, drank 40oz of water so far";
    expect(stripUnstatedSleepQuality("Sleep", { hours: 6.5, quality: "fair", bedtime: "11:00 PM" }, msg))
      .toEqual({ hours: 6.5, bedtime: "11:00 PM" });
    expect(stripUnstatedSleepQuality("Sleep", { hours: 6.5, quality: "poor" }, "slept 6.5 hours, pretty poorly"))
      .toEqual({ hours: 6.5, quality: "poor" });
    // Only sleep is touched, and only when the message is known.
    expect(stripUnstatedSleepQuality("Coffee", { cups: 1, quality: "good" }, msg)).toEqual({ cups: 1, quality: "good" });
    expect(stripUnstatedSleepQuality("Sleep", { hours: 6.5, quality: "fair" }, "")).toEqual({ hours: 6.5, quality: "fair" });
  });
});
