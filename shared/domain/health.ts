// shared/domain/health.ts — measurement-aware health classification.
//
// The reference table (shared/wellness-canon CANONICAL_METRICS) is the single
// source of both the displayed range and the classification, so "Normal:
// 60–100" and the flag on 58 can never come from different tables. What was
// missing:
//
//   • blood pressure judged the PAIR and stamped both halves with the pair's
//     flag, so a diastolic 76 read "Elevated" under a range that said "< 80";
//   • heart-rate readings carried no measurement context — a 171 bpm peak
//     during a run and a 58 bpm morning reading were the same metric, and
//     workout readings were silently DROPPED rather than classified;
//   • "Athletic" appeared with no rule explaining why a value under the range
//     was not "Low".
//
// Every reading here is `{ value, unit, timestamp, measurementType,
// activityContext }`; classification uses the metric's own range, per half
// for blood pressure, and a good-side label always carries its rule.
//
// Pure. Pinned by tests/consistency-layer-health.test.ts.

import {
  CANONICAL_METRICS, getCanonicalMetric, resolveCanonicalMetric, flagAgainstReference,
  formatReference, toCanonicalUnit, isRestingHeartRateReading,
  type CanonicalMetric, type RangeFlag,
} from "../wellness-canon";
import { classifyBloodPressure, type BloodPressureCategory } from "../blood-pressure";

export type ActivityContext = "resting" | "workout" | "recovery" | "general";
export type MeasurementType = string; // a canonical metric id, e.g. "heart_rate", "bp_systolic"

export interface HealthReading {
  value: number;
  unit?: string | null;
  timestamp: string;
  measurementType: MeasurementType;
  activityContext?: ActivityContext | null;
  /** Free-text the reading came with (notes / context field). */
  note?: string | null;
}

export interface ReferenceRange {
  metricId: string;
  label: string;
  unit: string;
  low?: number;
  high?: number;
  /** Values above `high` but below this are "elevated", not "high". */
  highFrom?: number;
  /** "60–100 bpm" — the text every surface displays. */
  text: string | null;
}

/** The ONE reference range for a metric — what is displayed AND what classifies. */
export function referenceRangeFor(metricId: string): ReferenceRange | null {
  const m = getCanonicalMetric(metricId);
  if (!m) return null;
  return { metricId: m.id, label: m.label, unit: m.unit, low: m.ref?.low, high: m.ref?.high, highFrom: m.ref?.highFrom, text: formatReference(m) ?? null };
}

export interface ReadingVerdict {
  metricId: string;
  metricLabel: string;
  value: number;
  unit: string;
  flag: RangeFlag;
  /** Pill text: "Normal", "Elevated", "High", "Low", "Athletic", "Workout". */
  label: string;
  /** Whether the flag is a concern. A good-side label is not. */
  concern: boolean;
  reference: ReferenceRange | null;
  /** The explicit rule behind a special label, so it never contradicts the range. */
  rule: string | null;
  activityContext: ActivityContext;
}

const EXERCISE_NOTE = /\b(run|running|ran|jog|workout|work\s?out|exercis|training|cardio|hiit|cycl|bike|biking|hike|hiking|swim|sprint|during|peak|max(imum)?|active|zone)\b/i;
const RECOVERY_NOTE = /\b(recovery|post[- ]?workout|after|cool[- ]?down)\b/i;

/** Infer the context of a reading that did not state one. */
export function inferActivityContext(values: Record<string, any> | null | undefined, note?: string | null): ActivityContext {
  const text = String(note ?? "");
  if (RECOVERY_NOTE.test(text)) return "recovery";
  if (EXERCISE_NOTE.test(text)) return "workout";
  if (!isRestingHeartRateReading(values)) {
    const joined = Object.values(values || {}).filter((v) => typeof v === "string").join(" ");
    return RECOVERY_NOTE.test(joined) ? "recovery" : "workout";
  }
  return "general";
}

function labelForFlag(m: CanonicalMetric, flag: RangeFlag): { label: string; concern: boolean; rule: string | null } {
  if (flag === "normal") return { label: "Normal", concern: false, rule: null };
  if (flag === "unknown") return { label: "—", concern: false, rule: null };
  if (flag === "elevated") return { label: "Elevated", concern: true, rule: null };
  const special = m.flagLabels?.[flag];
  if (special) {
    const rule = m.id === "heart_rate" || m.id === "resting_hr"
      ? `A resting heart rate under ${m.ref?.low ?? 60} bpm is typical for a trained heart, so it is "${special}" rather than "Low".`
      : `${m.label} on this side of the range is "${special}" by rule.`;
    return { label: special, concern: false, rule };
  }
  return { label: flag === "high" ? "High" : "Low", concern: true, rule: null };
}

/**
 * Classify one reading against ITS metric's range. A workout heart rate is
 * not judged against the resting range at all — it is labelled by context.
 */
export function classifyReading(reading: HealthReading): ReadingVerdict {
  const m = getCanonicalMetric(reading.measurementType) ?? resolveCanonicalMetric(reading.measurementType);
  const ctx: ActivityContext = reading.activityContext ?? inferActivityContext(null, reading.note);
  if (!m) {
    return { metricId: reading.measurementType, metricLabel: reading.measurementType, value: reading.value, unit: reading.unit ?? "", flag: "unknown", label: "—", concern: false, reference: null, rule: null, activityContext: ctx };
  }
  const value = toCanonicalUnit(m, reading.value, reading.unit);
  const isHeart = m.id === "heart_rate" || m.id === "resting_hr";
  if (isHeart && (ctx === "workout" || ctx === "recovery")) {
    return {
      metricId: m.id, metricLabel: m.label, value, unit: m.unit, flag: "unknown",
      label: ctx === "workout" ? "Workout" : "Recovery", concern: false, reference: referenceRangeFor(m.id),
      rule: "The 60–100 bpm range describes a resting heart rate; a reading taken during or after exercise is reported by context, not against it.",
      activityContext: ctx,
    };
  }
  const flag = flagAgainstReference(m, value);
  const { label, concern, rule } = labelForFlag(m, flag);
  return { metricId: m.id, metricLabel: m.label, value, unit: m.unit, flag, label, concern, reference: referenceRangeFor(m.id), rule, activityContext: ctx };
}

export interface BloodPressureReadingVerdict {
  systolic: ReadingVerdict;
  diastolic: ReadingVerdict;
  /** The pair's category by the standard table. */
  category: BloodPressureCategory;
  overallLabel: string;
  sentence: string;
}

/**
 * Blood pressure: each half against ITS OWN range, plus the pair's category.
 * 121/76 → systolic Elevated (120–129), diastolic Normal (< 80), pair Elevated.
 */
export function classifyBloodPressureReading(systolic: number, diastolic: number, timestamp = ""): BloodPressureReadingVerdict {
  const sys = classifyReading({ value: systolic, timestamp, measurementType: "bp_systolic", activityContext: "resting" });
  const dia = classifyReading({ value: diastolic, timestamp, measurementType: "bp_diastolic", activityContext: "resting" });
  const pair = classifyBloodPressure(systolic, diastolic);
  return { systolic: sys, diastolic: dia, category: pair.category, overallLabel: pair.label, sentence: pair.sentence };
}

export interface RestingHeartRateResult {
  /** Mean of resting/general readings only; null when there are none. */
  average: number | null;
  latest: HealthReading | null;
  countUsed: number;
  countExcluded: number;
  verdict: ReadingVerdict | null;
}

/** Resting heart rate from a mixed series — workout and recovery readings are left out. */
export function restingHeartRate(readings: readonly HealthReading[]): RestingHeartRateResult {
  const resting = readings.filter((r) => {
    const ctx = r.activityContext ?? inferActivityContext(null, r.note);
    return ctx === "resting" || ctx === "general";
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const excluded = readings.length - resting.length;
  if (resting.length === 0) return { average: null, latest: null, countUsed: 0, countExcluded: excluded, verdict: null };
  const avg = resting.reduce((s, r) => s + r.value, 0) / resting.length;
  const latest = resting[resting.length - 1];
  return {
    average: Math.round(avg * 10) / 10, latest, countUsed: resting.length, countExcluded: excluded,
    verdict: classifyReading({ ...latest, measurementType: "resting_hr", activityContext: "resting" }),
  };
}

export interface TrendResult {
  metricId: string;
  activityContext: ActivityContext;
  earlier: number | null;
  later: number | null;
  change: number | null;
  direction: "up" | "down" | "flat" | "unknown";
}

/** Trend over equivalent readings only (same metric, same context). */
export function contextTrend(readings: readonly HealthReading[], metricId: string, context: ActivityContext, splitAtISO: string): TrendResult {
  const same = readings.filter((r) => r.measurementType === metricId && (r.activityContext ?? inferActivityContext(null, r.note)) === context);
  const mean = (xs: HealthReading[]) => xs.length ? xs.reduce((s, r) => s + r.value, 0) / xs.length : null;
  const earlier = mean(same.filter((r) => r.timestamp < splitAtISO));
  const later = mean(same.filter((r) => r.timestamp >= splitAtISO));
  const change = earlier !== null && later !== null ? Math.round((later - earlier) * 10) / 10 : null;
  return { metricId, activityContext: context, earlier, later, change, direction: change === null ? "unknown" : change > 0.5 ? "up" : change < -0.5 ? "down" : "flat" };
}

/** Build a HealthReading from a tracker entry, stamping the context. */
export function readingFromTrackerEntry(metricId: string, entry: { values?: Record<string, any> | null; notes?: string | null; timestamp: string }, field: string, unit?: string | null): HealthReading | null {
  const raw = entry.values?.[field];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return null;
  const explicit = String(entry.values?.activityContext ?? entry.values?.measurementContext ?? "").toLowerCase();
  const activityContext: ActivityContext = explicit === "resting" || explicit === "workout" || explicit === "recovery" || explicit === "general"
    ? (explicit as ActivityContext) : inferActivityContext(entry.values, entry.notes);
  return { value, unit: unit ?? null, timestamp: entry.timestamp, measurementType: metricId, activityContext, note: entry.notes ?? null };
}

export { CANONICAL_METRICS };
