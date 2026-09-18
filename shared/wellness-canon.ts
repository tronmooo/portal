// ── Canonical wellness metrics ───────────────────────────────────────────────
// ONE id per health metric, with one canonical unit, one plausible range and
// (for lab values) one reference range.
//
// Why this exists
// ---------------
// Wellness derived everything by regex-matching tracker NAMES at each call
// site, so the same measurement arrived under several identities and nothing
// checked the number itself. The tab showed:
//
//   * the same metric several times — Nutrition ×3, Hydration ×2, HDL ×3,
//     BMI ×3, Triglycerides ×3 — because "HDL", "HDL Cholesterol" and
//     "Lipid Panel — HDL" were three trackers and nothing knew they were one
//     metric;
//   * values that cannot exist — HbA1c 179 %, HDL 170 mg/dL, BMI 47 beside
//     26.4 — because the write guard only bounded a handful of field NAMES
//     ("weight", "systolic", …) and a lab value logged in a field called
//     "value" was bounded by nothing.
//
// Every wellness surface resolves a tracker through `resolveCanonicalMetric`
// here, so two spellings of one metric collapse to one id, and every write
// path validates through `validateCanonicalValue`, so an impossible value is
// rejected at the door instead of being averaged into an insight later.
//
// Pure, dependency-free and shared: server/tracker-entry-guard.ts (writes) and
// client/src/lib/wellness-data.ts (reads) use the same table, so what the app
// refuses to store and what it knows how to read can never drift apart.
// (The one import is the pure blood-pressure table, which imports nothing.)

import { classifyBloodPressure, bloodPressureFlag, type BloodPressureCategory } from "./blood-pressure";

export type MetricPanel =
  | "vitals"        // blood pressure, heart rate, temperature, SpO2
  | "body"          // weight, BMI, body fat, waist, height
  | "sleep"
  | "activity"
  | "hydration"     // water intake — a daily TOTAL, not a reading
  | "lipids"
  | "metabolic"
  | "cbc"
  | "thyroid"
  | "vitamins"
  | "other";

/** Human label for each panel, in the order the Labs section renders them. */
export const PANEL_LABELS: Record<MetricPanel, string> = {
  vitals: "Vitals",
  body: "Body",
  sleep: "Sleep",
  activity: "Activity",
  hydration: "Hydration",
  lipids: "Lipids",
  metabolic: "Metabolic",
  cbc: "Complete Blood Count",
  thyroid: "Thyroid",
  vitamins: "Vitamins & Minerals",
  other: "Other",
};

/** Panels the Labs section shows, in order. Everything else is not a lab. */
export const LAB_PANELS: MetricPanel[] = ["lipids", "metabolic", "cbc", "thyroid", "vitamins"];

export type MetricDirection = "higher_better" | "lower_better" | "band";

export interface CanonicalMetric {
  /** Stable id. One per real-world measurement. */
  id: string;
  label: string;
  panel: MetricPanel;
  /** Canonical unit. Values are compared and displayed in this unit. */
  unit: string;
  /**
   * Physically possible range in the canonical unit. A value outside this is
   * not "unusual", it is wrong — a mis-keyed entry, a percent stored as a raw
   * number, or two metrics logged into one field. Writes are rejected and
   * stored history outside it is ignored on read.
   */
  plausible: [number, number];
  /**
   * Typical healthy range, used to flag a lab value as out of range.
   * `highFrom`: values above `high` but below this are "elevated" (borderline),
   * not "high" — the AHA blood-pressure bands (QA 2026-09-18 BUG-09).
   */
  ref?: { low?: number; high?: number; highFrom?: number };
  direction: MetricDirection;
  /**
   * Alternative units this metric is commonly logged in, with the factor that
   * converts INTO the canonical unit. Used to bound-check a value that was
   * logged in kg when the canon speaks lb.
   */
  altUnits?: Record<string, number>;
  /**
   * Name patterns that mean this metric. Matched against the tracker name, its
   * category and the field name. Order matters: the registry is scanned top to
   * bottom, so a specific metric ("HDL") must come before a general one
   * ("cholesterol") or it would never be reached.
   */
  match: RegExp;
  /** Patterns that disqualify a match — "cholesterol ratio" is not cholesterol. */
  exclude?: RegExp;
  /**
   * What to call a value on one side of the reference range when the plain
   * "Low"/"High" would mislead: a resting heart rate under 60 is "Athletic",
   * not a problem.
   */
  flagLabels?: Partial<Record<"low" | "high", string>>;
}

// The registry. Ordered most-specific → most-general within each panel, and
// lab panels come before the general vitals so "Lipid Panel — HDL" resolves to
// hdl rather than to a generic cholesterol row.
export const CANONICAL_METRICS: CanonicalMetric[] = [
  // ── Lipids ────────────────────────────────────────────────────────────────
  { id: "hdl", label: "HDL", panel: "lipids", unit: "mg/dL", plausible: [5, 150], ref: { low: 40 }, direction: "higher_better",
    match: /\bhdl\b|high[-\s]?density/i },
  { id: "ldl", label: "LDL", panel: "lipids", unit: "mg/dL", plausible: [10, 500], ref: { high: 100 }, direction: "lower_better",
    match: /\bldl\b|low[-\s]?density/i },
  { id: "triglycerides", label: "Triglycerides", panel: "lipids", unit: "mg/dL", plausible: [10, 2000], ref: { high: 150 }, direction: "lower_better",
    match: /triglyceride|\btrig\b/i },
  { id: "non_hdl", label: "Non-HDL cholesterol", panel: "lipids", unit: "mg/dL", plausible: [10, 600], ref: { high: 130 }, direction: "lower_better",
    match: /non[-\s]?hdl/i },
  { id: "cholesterol_ratio", label: "Cholesterol ratio", panel: "lipids", unit: "ratio", plausible: [0.5, 20], ref: { high: 5 }, direction: "lower_better",
    match: /chol\w*\s*(ratio|\/\s*hdl)|\bratio\b/i },
  { id: "total_cholesterol", label: "Total cholesterol", panel: "lipids", unit: "mg/dL", plausible: [50, 800], ref: { high: 200 }, direction: "lower_better",
    match: /cholesterol|lipid/i, exclude: /ratio|non[-\s]?hdl|\bhdl\b|\bldl\b/i },

  // ── Metabolic ─────────────────────────────────────────────────────────────
  // HbA1c is a PERCENT. "179" was a fasting glucose logged into the A1c
  // tracker; the plausible ceiling of 20 turns that into a rejected write.
  { id: "hba1c", label: "HbA1c", panel: "metabolic", unit: "%", plausible: [2, 20], ref: { high: 5.7 }, direction: "lower_better",
    match: /hba1c|\ba1c\b|glycated|glycosylated/i },
  { id: "glucose", label: "Glucose", panel: "metabolic", unit: "mg/dL", plausible: [10, 800], ref: { low: 70, high: 99 }, direction: "band",
    match: /glucose|blood\s*sugar/i, exclude: /average|\bag\b/i },
  { id: "insulin", label: "Insulin", panel: "metabolic", unit: "µIU/mL", plausible: [0.1, 300], ref: { high: 25 }, direction: "lower_better",
    match: /\binsulin\b/i },
  { id: "sodium", label: "Sodium", panel: "metabolic", unit: "mmol/L", plausible: [90, 200], ref: { low: 135, high: 145 }, direction: "band",
    match: /\bsodium\b|\bna\b/i },
  { id: "potassium", label: "Potassium", panel: "metabolic", unit: "mmol/L", plausible: [1, 10], ref: { low: 3.5, high: 5.2 }, direction: "band",
    match: /\bpotassium\b|\bk\+?\b/i },
  { id: "chloride", label: "Chloride", panel: "metabolic", unit: "mmol/L", plausible: [60, 150], ref: { low: 98, high: 107 }, direction: "band",
    match: /\bchloride\b/i },
  { id: "co2", label: "CO₂", panel: "metabolic", unit: "mmol/L", plausible: [5, 50], ref: { low: 22, high: 29 }, direction: "band",
    match: /\bco2\b|bicarbonate/i },
  { id: "bun", label: "BUN", panel: "metabolic", unit: "mg/dL", plausible: [1, 200], ref: { low: 7, high: 20 }, direction: "band",
    match: /\bbun\b|urea\s*nitrogen/i },
  { id: "creatinine", label: "Creatinine", panel: "metabolic", unit: "mg/dL", plausible: [0.1, 20], ref: { low: 0.6, high: 1.3 }, direction: "band",
    match: /creatinine/i },
  { id: "egfr", label: "eGFR", panel: "metabolic", unit: "mL/min", plausible: [1, 200], ref: { low: 60 }, direction: "higher_better",
    match: /egfr|glomerular/i },
  { id: "calcium", label: "Calcium", panel: "metabolic", unit: "mg/dL", plausible: [3, 20], ref: { low: 8.6, high: 10.3 }, direction: "band",
    match: /\bcalcium\b/i },
  { id: "albumin", label: "Albumin", panel: "metabolic", unit: "g/dL", plausible: [0.5, 8], ref: { low: 3.5, high: 5 }, direction: "band",
    match: /\balbumin\b/i, exclude: /globulin\s*ratio/i },
  { id: "alt", label: "ALT", panel: "metabolic", unit: "U/L", plausible: [1, 2000], ref: { high: 44 }, direction: "lower_better",
    match: /\balt\b|\bsgpt\b/i },
  { id: "ast", label: "AST", panel: "metabolic", unit: "U/L", plausible: [1, 2000], ref: { high: 40 }, direction: "lower_better",
    match: /\bast\b|\bsgot\b/i },
  { id: "alkaline_phosphatase", label: "Alkaline phosphatase", panel: "metabolic", unit: "U/L", plausible: [5, 1000], ref: { low: 44, high: 121 }, direction: "band",
    match: /alkaline|\balp\b/i },
  { id: "bilirubin", label: "Bilirubin", panel: "metabolic", unit: "mg/dL", plausible: [0.05, 30], ref: { high: 1.2 }, direction: "lower_better",
    match: /bilirubin/i },
  { id: "uric_acid", label: "Uric acid", panel: "metabolic", unit: "mg/dL", plausible: [0.5, 25], ref: { high: 7 }, direction: "lower_better",
    match: /uric\s*acid/i },

  // ── CBC ───────────────────────────────────────────────────────────────────
  { id: "wbc", label: "WBC", panel: "cbc", unit: "K/µL", plausible: [0.1, 200], ref: { low: 4, high: 11 }, direction: "band",
    match: /\bwbc\b|white\s*blood/i },
  { id: "rbc", label: "RBC", panel: "cbc", unit: "M/µL", plausible: [0.5, 12], ref: { low: 4.2, high: 5.9 }, direction: "band",
    match: /\brbc\b|red\s*blood/i },
  { id: "hemoglobin", label: "Hemoglobin", panel: "cbc", unit: "g/dL", plausible: [2, 25], ref: { low: 13, high: 17 }, direction: "band",
    match: /h(a)?emoglobin|\bhgb\b|\bhb\b/i, exclude: /glycated|a1c/i },
  { id: "hematocrit", label: "Hematocrit", panel: "cbc", unit: "%", plausible: [5, 75], ref: { low: 38, high: 50 }, direction: "band",
    match: /h(a)?ematocrit|\bhct\b/i },
  { id: "platelets", label: "Platelets", panel: "cbc", unit: "K/µL", plausible: [1, 2000], ref: { low: 150, high: 400 }, direction: "band",
    match: /platelet|\bplt\b/i },
  { id: "mcv", label: "MCV", panel: "cbc", unit: "fL", plausible: [30, 150], ref: { low: 80, high: 100 }, direction: "band",
    match: /\bmcv\b/i },
  { id: "rdw", label: "RDW", panel: "cbc", unit: "%", plausible: [5, 40], ref: { low: 11.5, high: 15 }, direction: "band",
    match: /\brdw\b/i },

  // ── Thyroid ───────────────────────────────────────────────────────────────
  { id: "tsh", label: "TSH", panel: "thyroid", unit: "µIU/mL", plausible: [0.001, 200], ref: { low: 0.45, high: 4.5 }, direction: "band",
    match: /\btsh\b|thyroid\s*stimulating/i },
  { id: "free_t4", label: "Free T4", panel: "thyroid", unit: "ng/dL", plausible: [0.05, 20], ref: { low: 0.82, high: 1.77 }, direction: "band",
    match: /free\s*t4|\bft4\b|thyroxine/i },
  { id: "free_t3", label: "Free T3", panel: "thyroid", unit: "pg/mL", plausible: [0.2, 30], ref: { low: 2, high: 4.4 }, direction: "band",
    match: /free\s*t3|\bft3\b|triiodothyronine/i },

  // ── Vitamins & minerals ───────────────────────────────────────────────────
  { id: "vitamin_d", label: "Vitamin D", panel: "vitamins", unit: "ng/mL", plausible: [1, 200], ref: { low: 30, high: 100 }, direction: "band",
    match: /vitamin\s*d\b|25[-\s]?oh/i },
  { id: "vitamin_b12", label: "Vitamin B12", panel: "vitamins", unit: "pg/mL", plausible: [20, 5000], ref: { low: 200, high: 900 }, direction: "band",
    match: /b\s?12|cobalamin/i },
  { id: "ferritin", label: "Ferritin", panel: "vitamins", unit: "ng/mL", plausible: [1, 5000], ref: { low: 30, high: 400 }, direction: "band",
    match: /ferritin/i },
  { id: "iron", label: "Iron", panel: "vitamins", unit: "µg/dL", plausible: [5, 1000], ref: { low: 50, high: 180 }, direction: "band",
    match: /\biron\b/i, exclude: /ferritin|binding/i },
  { id: "magnesium", label: "Magnesium", panel: "vitamins", unit: "mg/dL", plausible: [0.3, 10], ref: { low: 1.7, high: 2.4 }, direction: "band",
    match: /magnesium/i },

  // ── Vitals ────────────────────────────────────────────────────────────────
  // Blood pressure is a PAIR: the verdict every screen shows comes from
  // shared/blood-pressure.ts (classifyBloodPressure — normal < 120/80,
  // elevated 120–129, stage 1 130–139 / 80–89, …; bloodPressureVerdict below
  // wraps it). The single-value refs here describe the "normal" band for each
  // half only; `highFrom: 130` keeps a lone systolic 121 reading "Elevated"
  // rather than "High" (QA 2026-09-18 BUG-09 / F-33).
  { id: "bp_systolic", label: "Systolic", panel: "vitals", unit: "mmHg", plausible: [50, 300], ref: { low: 90, high: 119, highFrom: 130 }, direction: "band",
    match: /systolic|\bsbp\b/i },
  { id: "bp_diastolic", label: "Diastolic", panel: "vitals", unit: "mmHg", plausible: [20, 200], ref: { low: 60, high: 79 }, direction: "band",
    match: /diastolic|\bdbp\b/i },
  // Resting heart rate: 60–100 bpm is the adult norm; under 60 is what a
  // trained heart does, so it is labelled "Athletic", never "Low".
  { id: "resting_hr", label: "Resting heart rate", panel: "vitals", unit: "bpm", plausible: [25, 200], ref: { low: 60, high: 100 }, direction: "lower_better",
    flagLabels: { low: "Athletic" },
    match: /resting\s*(heart|hr|pulse)|\brhr\b/i },
  { id: "hrv", label: "HRV", panel: "vitals", unit: "ms", plausible: [1, 500], direction: "higher_better",
    match: /\bhrv\b|heart\s*rate\s*variability/i },
  // A plain "Heart rate" tracker is read as RESTING heart rate: readings that
  // carry an exercise context are left out (see isRestingHeartRateReading),
  // so a 171 bpm peak logged mid-run never averages with a 58 bpm morning
  // reading.
  { id: "heart_rate", label: "Heart rate", panel: "vitals", unit: "bpm", plausible: [25, 250], ref: { low: 60, high: 100 }, direction: "band",
    flagLabels: { low: "Athletic" },
    match: /heart\s*rate|\bpulse\b|\bbpm\b|\bhr\b/i, exclude: /variability|resting|\bhrv\b/i },
  { id: "spo2", label: "Blood oxygen", panel: "vitals", unit: "%", plausible: [50, 100], ref: { low: 95 }, direction: "higher_better",
    match: /spo2|blood\s*oxygen|oxygen\s*sat/i },
  { id: "respiratory_rate", label: "Respiratory rate", panel: "vitals", unit: "br/min", plausible: [4, 60], ref: { low: 12, high: 20 }, direction: "band",
    match: /respirat|breath(ing)?\s*rate/i },
  { id: "body_temp", label: "Body temperature", panel: "vitals", unit: "°F", plausible: [86, 113], ref: { low: 97, high: 99.5 }, direction: "band",
    altUnits: { c: 1, "°c": 1, celsius: 1 }, // offset conversion — see toCanonicalUnit
    match: /body\s*temp|temperature|\btemp\b/i,
    // Not every temperature is a person. A weather, room, fridge or pool
    // reading is a perfectly good tracker and -5 is a perfectly good value.
    exclude: /weather|outdoor|outside|ambient|room|house|fridge|refrigerat|freezer|oven|grill|pool|hot\s*tub|water\s*temp|air\b|garage|greenhouse|brew|coffee|engine/i },

  // ── Body ──────────────────────────────────────────────────────────────────
  // Deliberately after the lab panels: a "Weight" tracker is body weight, but
  // "Lipid Panel" fields never reach here.
  { id: "bmi", label: "BMI", panel: "body", unit: "", plausible: [8, 90], ref: { low: 18.5, high: 25 }, direction: "band",
    match: /\bbmi\b|body\s*mass\s*index/i },
  { id: "body_fat", label: "Body fat", panel: "body", unit: "%", plausible: [2, 70], ref: { low: 10, high: 25 }, direction: "band",
    match: /body\s*fat|\bbf%?\b|fat\s*percent/i },
  { id: "waist", label: "Waist", panel: "body", unit: "in", plausible: [15, 90], direction: "lower_better",
    altUnits: { cm: 0.393701, centimeters: 0.393701 },
    match: /waist/i },
  { id: "height", label: "Height", panel: "body", unit: "in", plausible: [20, 100], direction: "band",
    altUnits: { cm: 0.393701, centimeters: 0.393701, m: 39.3701, meters: 39.3701 },
    match: /\bheight\b/i },
  { id: "weight", label: "Weight", panel: "body", unit: "lbs", plausible: [20, 1000], direction: "lower_better",
    altUnits: { kg: 2.20462, kgs: 2.20462, kilograms: 2.20462, st: 14, stone: 14 },
    match: /\bweight\b|body\s*mass\b|\bmass\b/i, exclude: /lift|bench|squat|press|dead\s*lift|plate|dumbbell|barbell|index/i },

  // ── Sleep ─────────────────────────────────────────────────────────────────
  { id: "sleep_hours", label: "Sleep", panel: "sleep", unit: "h", plausible: [0, 24], ref: { low: 7, high: 9 }, direction: "band",
    altUnits: { min: 1 / 60, mins: 1 / 60, minutes: 1 / 60 },
    match: /\bsleep\b|time\s*asleep|sleep\s*duration/i, exclude: /quality|score|debt/i },

  // ── Activity ──────────────────────────────────────────────────────────────
  { id: "steps", label: "Steps", panel: "activity", unit: "steps", plausible: [0, 200000], direction: "higher_better",
    match: /\bsteps?\b|step\s*count|pedometer/i },
  { id: "exercise_minutes", label: "Exercise", panel: "activity", unit: "min", plausible: [0, 1440], direction: "higher_better",
    match: /exercise\s*(minutes|time)|active\s*minutes|workout\s*(minutes|duration)/i },
  { id: "distance", label: "Distance", panel: "activity", unit: "mi", plausible: [0, 300], direction: "higher_better",
    altUnits: { km: 0.621371, kilometers: 0.621371, m: 0.000621371, meters: 0.000621371 },
    match: /\bdistance\b|\bmiles\b|\bmileage\b/i },

  // ── Hydration ─────────────────────────────────────────────────────────────
  // QA 2026-09-18 (F-38): "drank 40oz of water" reached the dashboard's Water
  // tile but the Wellness tab had no hydration anywhere. Same tracker match
  // as lib/wellness-metrics (name says hydration/water), summed per day.
  { id: "hydration", label: "Water", panel: "hydration", unit: "oz", plausible: [0, 400], direction: "higher_better",
    altUnits: { ml: 0.033814, milliliters: 0.033814, l: 33.814, liter: 33.814, liters: 33.814, cup: 8, cups: 8 },
    match: /hydrat|\bwater\b/i,
    exclude: /temp|pool|plant|bill|heater|filter|softener|weight/i },
];

/**
 * Was this heart-rate reading taken at rest?
 *
 * A "Heart Rate" tracker collects whatever the person logs: a 58 bpm morning
 * reading and a 171 bpm peak during a run. Averaging the two ("Avg 114.5")
 * describes nothing. When an entry says what it was — a context/kind/type
 * field, or a note, that names a workout — it is not a resting reading and
 * every resting-HR surface leaves it out. An entry with no context counts.
 */
const EXERCISE_CONTEXT =
  /\b(run|running|ran|jog|workout|work\s?out|exercis|training|cardio|hiit|cycl|bike|biking|walk|hike|hiking|swim|sprint|during|peak|max(imum)?|active|post|after|recovery|zone)\b/i;
const CONTEXT_KEY = /^(context|kind|type|activity|activity_?type|state|when|condition|measured_?during|situation|notes?|_notes)$/i;

export function isRestingHeartRateReading(values: Record<string, any> | null | undefined): boolean {
  for (const [key, raw] of Object.entries(values || {})) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (!CONTEXT_KEY.test(key)) continue;
    if (EXERCISE_CONTEXT.test(raw)) return false;
  }
  return true;
}

const BY_ID = new Map(CANONICAL_METRICS.map((m) => [m.id, m]));

export function getCanonicalMetric(id: string): CanonicalMetric | undefined {
  return BY_ID.get(id);
}

/**
 * Resolve free text (a tracker name, its category, a field name) to the one
 * metric it measures, or null when it isn't a wellness metric at all —
 * "Guitar practice", "Video games" and "Bathroom visits" all resolve to null,
 * which is how the Wellness tab stops rendering them.
 */
export function resolveCanonicalMetric(...parts: Array<string | null | undefined>): CanonicalMetric | null {
  const hay = parts.filter(Boolean).join(" ").trim();
  if (!hay) return null;
  for (const m of CANONICAL_METRICS) {
    if (m.exclude && m.exclude.test(hay)) continue;
    if (m.match.test(hay)) return m;
  }
  return null;
}

/** Convert a value logged in `unit` into the metric's canonical unit. */
export function toCanonicalUnit(metric: CanonicalMetric, value: number, unit?: string | null): number {
  if (!Number.isFinite(value)) return NaN;
  const u = String(unit || "").trim().toLowerCase().replace(/[.\s]/g, "");
  if (!u) return value;
  // Temperature is an offset conversion, not a factor.
  if (metric.id === "body_temp") {
    if (/^(c|°c|celsius)$/.test(u)) return value * 9 / 5 + 32;
    return value;
  }
  const factor = metric.altUnits?.[u];
  return factor ? value * factor : value;
}

export interface CanonValidation {
  ok: boolean;
  /** The value expressed in the canonical unit (whatever the outcome). */
  canonical: number;
  /** Set when `ok` is false — a sentence naming what is impossible. */
  error?: string;
}

/**
 * Is this a value the metric can physically take? Rejects the class of entry
 * that produced "HbA1c 179 %" and "BMI 47 next to 26.4": a number that belongs
 * to a different metric, or a mis-keyed one.
 */
export function validateCanonicalValue(
  metric: CanonicalMetric,
  value: number,
  unit?: string | null,
): CanonValidation {
  const canonical = toCanonicalUnit(metric, value, unit);
  if (!Number.isFinite(canonical)) {
    return { ok: false, canonical, error: `${metric.label} must be a number.` };
  }
  const [lo, hi] = metric.plausible;
  if (canonical < lo || canonical > hi) {
    const u = metric.unit ? ` ${metric.unit}` : "";
    return {
      ok: false,
      canonical,
      error: `${metric.label} ${round(canonical)}${u} is outside the possible range (${lo}–${hi}${u}). Check the value or the unit.`,
    };
  }
  return { ok: true, canonical };
}

function round(n: number): number {
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

/** "elevated" = above the healthy band but under the threshold that counts as
 *  high (the blood-pressure band between normal and stage 1). */
export type RangeFlag = "low" | "elevated" | "high" | "normal" | "unknown";

/** Where a value sits against the metric's reference range. */
export function flagAgainstReference(metric: CanonicalMetric, canonicalValue: number): RangeFlag {
  const ref = metric.ref;
  if (!ref || !Number.isFinite(canonicalValue)) return "unknown";
  if (ref.low != null && canonicalValue < ref.low) return "low";
  if (ref.high != null && canonicalValue > ref.high) {
    if (ref.highFrom != null && canonicalValue < ref.highFrom) return "elevated";
    return "high";
  }
  return "normal";
}

/** The pill text for a flag: "Low" / "High" / "Elevated", or the metric's own
 *  word for that side ("Athletic" for a resting heart rate under 60). */
export function flagLabelFor(metric: CanonicalMetric, flag: RangeFlag): string | null {
  if (flag === "normal" || flag === "unknown") return null;
  if (flag === "elevated") return "Elevated";
  return metric.flagLabels?.[flag] ?? (flag === "high" ? "High" : "Low");
}

/** Is this flag a concern (as opposed to normal, unknown, or a good-side
 *  label such as "Athletic")? */
export function flagIsConcern(metric: CanonicalMetric, flag: RangeFlag): boolean {
  if (flag === "normal" || flag === "unknown") return false;
  if (flag === "elevated") return true;
  return !metric.flagLabels?.[flag];
}

/** Human word for a flag: "High", "Elevated", "Low" — "" when in range. */
export function rangeFlagLabel(flag: RangeFlag): string {
  return flag === "high" ? "High" : flag === "elevated" ? "Elevated" : flag === "low" ? "Low" : "";
}

// ── Blood pressure: one verdict for every screen ────────────────────────────
// QA 2026-09-18 BUG-09 / F-33: the Trackers card said "121/76 — within a
// normal range" (in range, green) while the Wellness tab said "Systolic 121 —
// High". A blood pressure is a PAIR, so the category is decided on both
// numbers together by shared/blood-pressure.ts (classifyBloodPressure); this
// is the same verdict in the card's vocabulary ("In range" / "Elevated" /
// "High" / "Crisis" / "Low"). Both halves carry the pair's flag, which is what
// the Wellness rows (bodyVitals) show, so the two surfaces cannot disagree.

export type BloodPressureLabel = "Low" | "In range" | "Elevated" | "High" | "Crisis";

export interface BloodPressureVerdict {
  label: BloodPressureLabel;
  /** The pair's flag (crisis and both hypertension stages read as "high"). */
  flag: RangeFlag;
  /** The flag the Wellness "Systolic" row carries — the pair's verdict. */
  systolicFlag: RangeFlag;
  /** The flag the Wellness "Diastolic" row carries — the pair's verdict. */
  diastolicFlag: RangeFlag;
  /** The finer category from shared/blood-pressure.ts. */
  category: BloodPressureCategory;
  /** A sentence for the card's insight line. */
  summary: string;
}

const BP_LABEL: Record<BloodPressureCategory, BloodPressureLabel> = {
  low: "Low", normal: "In range", elevated: "Elevated", high_stage1: "High", high_stage2: "High", crisis: "Crisis",
};

export function bloodPressureVerdict(
  systolic: number | null | undefined,
  diastolic: number | null | undefined,
): BloodPressureVerdict | null {
  const sys = typeof systolic === "number" && Number.isFinite(systolic) ? systolic : null;
  const dia = typeof diastolic === "number" && Number.isFinite(diastolic) ? diastolic : null;
  if (sys == null && dia == null) return null;
  // A lone half is judged against its own band (the other half is unknown).
  if (sys == null || dia == null) {
    const m = getCanonicalMetric(sys == null ? "bp_diastolic" : "bp_systolic")!;
    const flag = flagAgainstReference(m, (sys ?? dia) as number);
    const category: BloodPressureCategory =
      flag === "low" ? "low" : flag === "elevated" ? "elevated" : flag === "high" ? "high_stage1" : "normal";
    const reading = `${sys ?? "—"}/${dia ?? "—"}`;
    const label = BP_LABEL[category];
    const summary = label === "In range" ? `Blood pressure is ${reading} — within a normal range.` : `${reading} is ${label.toLowerCase()}.`;
    return { label, flag, systolicFlag: sys == null ? "unknown" : flag, diastolicFlag: dia == null ? "unknown" : flag, category, summary };
  }
  const v = classifyBloodPressure(sys, dia);
  const flag = bloodPressureFlag(v.category);
  return { label: BP_LABEL[v.category], flag, systolicFlag: flag, diastolicFlag: flag, category: v.category, summary: v.sentence };
}

/** "70–100 bpm", "< 100 mg/dL", "> 40 mg/dL" — or undefined when no range. */
export function formatReference(metric: CanonicalMetric): string | undefined {
  const ref = metric.ref;
  if (!ref) return undefined;
  const u = metric.unit ? ` ${metric.unit}` : "";
  if (ref.low != null && ref.high != null) return `${ref.low}–${ref.high}${u}`;
  if (ref.high != null) return `< ${ref.high}${u}`;
  if (ref.low != null) return `> ${ref.low}${u}`;
  return undefined;
}
