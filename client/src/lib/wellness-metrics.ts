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
}

export function extractVitals(trackers: Tracker[] | undefined | null): WellnessVitals {
  const bp = trackers?.find((t) => /blood\s*pressure|(^|\b)bp(\b|$)/.test(`${t.name} ${t.category}`.toLowerCase()));
  const bpSys = bp
    ? readMetric([bp], [/.*/], { field: bp.fields?.find((f) => /sys/i.test(f.name))?.name || "systolic", unit: "mmHg" })
    : { ...EMPTY };
  const bpDia = bp
    ? readMetric([bp], [/.*/], { field: bp.fields?.find((f) => /dia/i.test(f.name))?.name || "diastolic", unit: "mmHg" })
    : { ...EMPTY };
  return {
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
    steps: readDailyTotal(trackers, [/steps|step count/], { unit: "steps" }),
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
