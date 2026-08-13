// ── Wellness metric extraction (pure, no React) ──────────────────────────────
// The Wellness tab is a health OVERVIEW rendered from the SAME data everything
// else reads — the shared `["/api/trackers", …]` query. This module turns that
// raw Tracker[] into the handful of numbers the dashboard cards need (weight,
// blood pressure, resting HR, sleep, hydration, calories, steps, mood, …).
//
// Because Wellness, the Trackers grid, and the Executive dashboard all derive
// from the same tracker array and write through the same invalidation, logging
// a value anywhere updates all of them — there is no separate wellness store.
//
// Unit-tested in tests/wellness-metrics.test.ts.

import type { Tracker, TrackerEntry } from "@shared/schema";
import { getCanonicalGroup } from "./tracker-health";

export interface WellnessMetric {
  /** Latest numeric value, or null when no numeric entry exists. */
  value: number | null;
  unit: string;
  trackerId: string | null;
  trackerName: string | null;
  primaryField: string | null;
  /** Last ~14 values oldest→newest for a sparkline. */
  series: number[];
  /** ISO timestamp of the latest entry, or null. */
  loggedAt: string | null;
  /** % change latest-vs-previous entry, or null. */
  changePct: number | null;
}

const EMPTY: WellnessMetric = {
  value: null, unit: "", trackerId: null, trackerName: null,
  primaryField: null, series: [], loggedAt: null, changePct: null,
};

/** The tracker's primary field — mirrors trackers.tsx: first isPrimary, else
 *  first number field, else first field, else "value". */
export function primaryFieldOf(t: Tracker): string {
  return (
    t.fields?.find((f) => f.isPrimary)?.name ||
    t.fields?.find((f) => f.type === "number")?.name ||
    t.fields?.[0]?.name ||
    "value"
  );
}

/** Entries newest→oldest (defensive copy; server order isn't guaranteed). */
function entriesNewestFirst(t: Tracker): TrackerEntry[] {
  return (t.entries || [])
    .slice()
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

/** Read a single metric from the first tracker whose name OR category matches
 *  any of the patterns. Matching is by tracker identity, not entry contents. */
export function readMetric(
  trackers: Tracker[] | undefined | null,
  patterns: RegExp[],
  opts: { field?: string; unit?: string } = {},
): WellnessMetric {
  if (!Array.isArray(trackers) || trackers.length === 0) return { ...EMPTY };
  const match = trackers.find((t) => {
    const hay = `${t.name || ""} ${t.category || ""}`.toLowerCase();
    return patterns.some((p) => p.test(hay));
  });
  if (!match) return { ...EMPTY };

  const field = opts.field || primaryFieldOf(match);
  const ordered = entriesNewestFirst(match);
  const nums = ordered
    .map((e) => Number(e.values?.[field]))
    .filter((n) => Number.isFinite(n));
  const value = nums.length > 0 ? nums[0] : null;
  const prev = nums.length > 1 ? nums[1] : null;
  const changePct =
    value != null && prev != null && prev !== 0
      ? ((value - prev) / Math.abs(prev)) * 100
      : null;
  const series = nums.slice(0, 14).reverse(); // oldest→newest
  const unit =
    opts.unit ??
    (match.fields?.find((f) => f.name === field)?.unit || match.unit || "");

  return {
    value,
    unit,
    trackerId: match.id,
    trackerName: match.name,
    primaryField: field,
    series,
    loggedAt: ordered[0]?.timestamp || null,
    changePct,
  };
}

// ── Activity ─────────────────────────────────────────────────────────────────
// "I walked a mile today, why is it blank?" (2026-08-13).
//
// Steps and Exercise were read by matching a tracker whose NAME said "steps" or
// "exercise". A tracker called "Walking" — the obvious name for a walk — matched
// neither, so a logged mile rendered as "—" on the Executive card AND on the
// Wellness tab's Activity tile, while the same entry showed up in Recent
// Activity. The data was connected; the lookup was too literal.
//
// Two changes fix that class of miss for good:
//   1. Activity is recognised by the SHAPE of the tracker as well as its name —
//      any of the ways a person names a workout, plus any tracker carrying a
//      steps/distance/duration field.
//   2. What the tile shows degrades honestly: minutes if duration is logged,
//      else distance, else the number of sessions. A walk with only a calorie
//      field still says "1 session" instead of pretending nothing happened.

/**
 * The ways people name the thing they did.
 *
 * Written as STEMS anchored only at the start of a word: "Cycling", "Walked"
 * and "Runs" are all the same activity, and a trailing \b would have matched
 * none of them. Deliberately excludes bare "weight" — that is the body-weight
 * tracker, not a workout — while still catching "weights" and "lifting".
 */
export const ACTIVITY_RE =
  /\b(?:exercis|workout|work\s?out|activit|active|train|fitness|gym|cardio|walk|step|run|jog|hik|cycl|bik|bicycl|swim|row|elliptic|treadmill|yoga|pilates|stretch|strength|lift|weights|sport|tennis|basketball|soccer|golf|climb|ski|skat|danc|peloton|marathon|cross\s?fit)/i;

const DURATION_FIELD_RE = /(duration|minutes?|\bmins?\b|\btime\b|active)/i;
const DISTANCE_FIELD_RE = /(distance|miles?|\bmi\b|kilometers?|\bkm\b|meters?|laps?)/i;
const STEPS_FIELD_RE = /step/i;
const CALORIE_FIELD_RE = /(calorie|kcal|\bcal\b|burn)/i;

/** Does this tracker record physical activity? Name/category first, then shape. */
export function isActivityTracker(t: Tracker): boolean {
  if (ACTIVITY_RE.test(`${t.name || ""} ${t.category || ""}`)) return true;
  return (t.fields || []).some((f) =>
    STEPS_FIELD_RE.test(f.name || "") || DISTANCE_FIELD_RE.test(f.name || ""));
}

export interface ActivitySummary {
  /** Minutes logged today, when any activity tracker records a duration. */
  minutes: number | null;
  /** Distance logged today, with the unit it was logged in. */
  distance: number | null;
  distanceUnit: string;
  /** Steps logged today — from a steps FIELD on any tracker, not just a
   *  tracker named "Steps". */
  steps: number | null;
  /** Activity entries logged today. The honest floor: something happened. */
  sessions: number;
  /** Calories BURNED today. Deliberately separate from intake — a burn must
   *  never be added to the food the tile counts. */
  caloriesBurned: number | null;
  /** Activity trackers that exist at all, so a caller can say "not tracked
   *  yet" rather than "nothing today" when there is no tracker to log into. */
  trackerCount: number;
}

const EMPTY_ACTIVITY: ActivitySummary = {
  minutes: null, distance: null, distanceUnit: "mi", steps: null,
  sessions: 0, caloriesBurned: null, trackerCount: 0,
};

/**
 * Today's physical activity, summed across every tracker that records some.
 *
 * One reader for the whole app: the Wellness tab's Activity tile, the Executive
 * card's Steps and Exercise tiles and the trackers page all resolve a walk the
 * same way, so they cannot disagree about whether it happened.
 */
export function readActivity(
  trackers: Tracker[] | undefined | null,
  opts: { now?: Date; days?: number } = {},
): ActivitySummary {
  if (!Array.isArray(trackers) || trackers.length === 0) return { ...EMPTY_ACTIVITY };
  const now = opts.now || new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  // days = 1 (default) means today; a larger window is a rolling N days, which
  // is what the Wellness tab's weekly Exercise card counts.
  const days = Math.max(1, Math.floor(opts.days ?? 1));
  const cutoff = days > 1 ? now.getTime() - (days - 1) * 86400000 : 0;
  const isToday = (ts: string) => {
    const t = new Date(ts);
    if (isNaN(t.getTime())) return false;
    if (days > 1) return t.getTime() >= cutoff && t.getTime() <= now.getTime() + 86400000;
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
  };

  let minutes = 0, distance = 0, steps = 0, burned = 0, sessions = 0;
  let sawMinutes = false, sawDistance = false, sawSteps = false, sawBurn = false;
  let distanceUnit = "", trackerCount = 0;

  for (const t of trackers) {
    if (!isActivityTracker(t)) continue;
    trackerCount++;
    const unitOf = (field: string) =>
      (t.fields || []).find((f) => f.name === field)?.unit || t.unit || "";
    for (const e of t.entries || []) {
      if (!e?.timestamp || !isToday(e.timestamp)) continue;
      let counted = false;
      // Server-computed values count too: a fitness entry can carry
      // `computed.caloriesBurned` / `computed.durationMinutes` with nothing of
      // the sort in `values`.
      const computed = (e as any).computed || {};
      const cb = Number(computed.caloriesBurned);
      if (Number.isFinite(cb) && cb > 0) { burned += cb; sawBurn = true; }
      const cd = Number(computed.durationMinutes);
      if (Number.isFinite(cd) && cd > 0) { minutes += cd; sawMinutes = true; }
      for (const [field, raw] of Object.entries(e.values || {})) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) continue;
        // Steps before distance: a "steps" field is not a distance even though
        // both describe how far you went.
        if (STEPS_FIELD_RE.test(field)) { steps += n; sawSteps = true; counted = true; continue; }
        if (DURATION_FIELD_RE.test(field)) { minutes += n; sawMinutes = true; counted = true; continue; }
        if (DISTANCE_FIELD_RE.test(field)) {
          distance += n; sawDistance = true; counted = true;
          if (!distanceUnit) distanceUnit = unitOf(field) || "mi";
          continue;
        }
        if (CALORIE_FIELD_RE.test(field)) { burned += n; sawBurn = true; counted = true; continue; }
      }
      // An entry with no field we recognise is still a session — the user
      // logged something, and "—" would be a lie.
      sessions += counted || Object.keys(e.values || {}).length > 0 ? 1 : 0;
    }
  }

  return {
    minutes: sawMinutes ? minutes : null,
    distance: sawDistance ? distance : null,
    distanceUnit: distanceUnit || "mi",
    steps: sawSteps ? steps : null,
    sessions,
    caloriesBurned: sawBurn ? burned : null,
    trackerCount,
  };
}

/** Sum today's numeric entries for a matched tracker (for additive metrics like
 *  hydration / steps / calories where the daily total, not the last reading,
 *  is what matters). Falls back to the latest value when nothing logged today. */
export function readDailyTotal(
  trackers: Tracker[] | undefined | null,
  patterns: RegExp[],
  opts: { field?: string; unit?: string; now?: Date } = {},
): WellnessMetric {
  const base = readMetric(trackers, patterns, opts);
  if (!base.trackerId || !Array.isArray(trackers)) return base;
  const match = trackers.find((t) => t.id === base.trackerId)!;
  const field = base.primaryField || primaryFieldOf(match);
  const now = opts.now || new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const isToday = (ts: string) => {
    const t = new Date(ts);
    return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
  };
  const todays = (match.entries || [])
    .filter((e) => isToday(e.timestamp))
    .map((e) => Number(e.values?.[field]))
    .filter((n) => Number.isFinite(n));
  if (todays.length === 0) return base;
  return { ...base, value: todays.reduce((s, n) => s + n, 0) };
}

// ── Named vitals bundle ──────────────────────────────────────────────────────
// One call → the metrics every Wellness card needs. Patterns are permissive so
// custom-named trackers ("Morning Weight", "Sleep Hours") still resolve.

export interface WellnessVitals {
  weight: WellnessMetric;
  bloodPressureSys: WellnessMetric;
  bloodPressureDia: WellnessMetric;
  heartRate: WellnessMetric;
  restingHeartRate: WellnessMetric;
  bodyTemp: WellnessMetric;
  glucose: WellnessMetric;
  cholesterol: WellnessMetric;
  bmi: WellnessMetric;
  sleep: WellnessMetric;
  hydration: WellnessMetric;
  calories: WellnessMetric;
  steps: WellnessMetric;
  mood: WellnessMetric;
  weightUnit: string;
  /** Today's movement, however it was logged (see readActivity). */
  activity: ActivitySummary;
}

export function extractVitals(
  trackers: Tracker[] | undefined | null,
  opts: { now?: Date } = {},
): WellnessVitals {
  const bp = trackers?.find((t) => /blood\s*pressure|(^|\b)bp(\b|$)/.test(`${t.name} ${t.category}`.toLowerCase()));
  const bpSys = bp
    ? readMetric([bp], [/.*/], { field: bp.fields?.find((f) => /sys/i.test(f.name))?.name || "systolic", unit: "mmHg" })
    : { ...EMPTY };
  const bpDia = bp
    ? readMetric([bp], [/.*/], { field: bp.fields?.find((f) => /dia/i.test(f.name))?.name || "diastolic", unit: "mmHg" })
    : { ...EMPTY };
  const activity = readActivity(trackers, opts);
  // A dedicated Steps tracker still wins (it carries the 14-day series the
  // sparkline and the popup chart draw). When there isn't one, today's steps
  // fall back to whatever activity trackers recorded — which is how a
  // "Walking" tracker's steps reach the tile.
  const stepsMetric = readDailyTotal(trackers, [/steps|step count|pedometer/], { unit: "steps", ...opts });
  const steps: WellnessMetric = stepsMetric.value != null || activity.steps == null
    ? stepsMetric
    : { ...EMPTY, value: activity.steps, unit: "steps" };
  return {
    activity,
    weight: readMetric(trackers, [/weight/, /\bmass\b/]),
    bloodPressureSys: bpSys,
    bloodPressureDia: bpDia,
    heartRate: readMetric(trackers, [/heart\s*rate/, /\bhr\b/, /pulse/], { unit: "bpm" }),
    restingHeartRate: readMetric(trackers, [/resting\s*(heart|hr)/, /rhr/], { unit: "bpm" }),
    bodyTemp: readMetric(trackers, [/temp/, /temperature/], { unit: "°F" }),
    glucose: readMetric(trackers, [/glucose|blood\s*sugar/], { unit: "mg/dL" }),
    cholesterol: readMetric(trackers, [/cholesterol|lipid/]),
    bmi: readMetric(trackers, [/\bbmi\b/]),
    sleep: readMetric(trackers, [/sleep/], { unit: "h" }),
    hydration: readDailyTotal(trackers, [/hydration|water/], { unit: "oz" }),
    calories: readDailyTotal(trackers, [/calorie|kcal|energy intake|nutrition/], { unit: "kcal" }),
    steps,
    mood: readMetric(trackers, [/mood/], { unit: "/ 10" }),
    weightUnit: readMetric(trackers, [/weight/]).unit || "lbs",
  };
}

/** A 0–100 wellness score. Reuses the shared health-score logic so the Wellness
 *  KPI and the hub strip's HEALTH chip never disagree. */
export { computeHealthScore as computeWellnessScore } from "./tracker-health";

/** Count of distinct trackers that roll up into the Health/Fitness/Mental
 *  groups — used for the "N trackers" caption and empty-state gating. */
export function countWellnessTrackers(trackers: Tracker[] | undefined | null): number {
  if (!Array.isArray(trackers)) return 0;
  return trackers.filter((t) => {
    const g = getCanonicalGroup(t.category);
    return g === "Health" || g === "Fitness" || g === "Mental & Wellness";
  }).length;
}
