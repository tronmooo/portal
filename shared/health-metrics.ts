// shared/health-metrics.ts
// =============================================================================
// Canonical health-metric registry for imported health data.
// =============================================================================
//
// Portol already has a health data model: trackers. The Wellness page, the
// health score, the Executive tab and the AI all read vitals out of trackers by
// NAME (see client/src/lib/wellness-metrics.ts extractVitals). So imported
// health data doesn't need new tables — it needs to land in trackers whose
// names, categories and field keys the rest of the app already recognises.
//
// This registry is that contract. For each metric we pin down:
//   - trackerName  the tracker to find-or-create. MUST satisfy the extractVitals
//                  regex for the vital it represents, and MUST NOT accidentally
//                  satisfy a DIFFERENT vital's regex (see the naming notes
//                  below — this is easy to get wrong and the collision is
//                  silent).
//   - category     a key in CANONICAL_GROUP_MAP (client/src/lib/tracker-health)
//                  so the tracker rolls up into Health / Fitness / Mental.
//   - field        the value key inside TrackerEntry.values. Matches the field
//                  names in shared/tracker-shapes.ts so shape inference applies.
//   - unit         the canonical unit. Everything is converted to this on the
//                  way in, so a tracker never mixes kg and lbs.
//   - agg          how to collapse many same-day samples into one daily entry.
//
// NAMING COLLISIONS — read before renaming anything here:
//   readMetric() picks the FIRST tracker whose "name + category" matches any of
//   its patterns, and tracker order is not guaranteed. So a badly-named tracker
//   silently steals another vital:
//     "Calories Burned" matches /calorie/ and would become the INTAKE metric.
//        -> named "Active Energy" instead.
//     "Heart Rate Variability" matches /heart\s*rate/ and would become heart
//        rate. -> named "HRV" ( /\bhr\b/ does not match "hrv", no word boundary
//        between r and v ).
//   "Resting Heart Rate" unavoidably matches both /resting\s*(heart|hr)/ and
//   /heart\s*rate/; that one is handled by the `exclude` option on readMetric.
//   tests/health-metrics.test.ts asserts all of this so a future rename can't
//   regress it silently.
// =============================================================================

import { z } from "zod";
import type { TrackerField } from "./schema";

/** How to collapse multiple same-day samples into a single daily entry. */
export type HealthAgg = "sum" | "avg" | "latest" | "max";

export interface HealthMetricDef {
  /** Stable id used on the wire and in the HealthKit / Health Connect maps. */
  id: string;
  /** Human label for the import preview UI. */
  label: string;
  /** Tracker to find-or-create. See the naming-collision notes above. */
  trackerName: string;
  /** Tracker category — must be a CANONICAL_GROUP_MAP key. */
  category: string;
  /** Primary value key written into TrackerEntry.values. */
  field: string;
  /** Canonical unit. Incoming values are converted to this. */
  unit: string;
  /** Daily aggregation rule. */
  agg: HealthAgg;
  /** Extra field keys this metric writes (blood pressure writes two). */
  extraFields?: string[];
  /** Existing tracker names we should reuse rather than creating a duplicate. */
  aliases?: string[];
  /** Field schema used when the tracker has to be created. */
  fields: TrackerField[];
}

// -----------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------

export const HEALTH_METRICS: HealthMetricDef[] = [
  {
    id: "steps",
    label: "Steps",
    trackerName: "Steps",
    category: "steps",
    field: "steps",
    unit: "steps",
    agg: "sum",
    aliases: ["step count", "pedometer", "daily steps"],
    fields: [{ name: "steps", type: "number", unit: "steps", isPrimary: true }],
  },
  {
    id: "distance_walked",
    label: "Walking Distance",
    trackerName: "Walking Distance",
    category: "fitness",
    field: "distance",
    unit: "mi",
    agg: "sum",
    aliases: ["walking + running distance", "distance walked"],
    fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
  },
  {
    id: "active_energy",
    // NOT "Calories Burned" — that matches /calorie/ and would hijack the
    // calorie-INTAKE vital on the Wellness page.
    label: "Active Energy",
    trackerName: "Active Energy",
    category: "fitness",
    field: "energy",
    unit: "kcal",
    agg: "sum",
    aliases: ["active energy burned", "move"],
    fields: [{ name: "energy", type: "number", unit: "kcal", isPrimary: true }],
  },
  {
    id: "exercise_minutes",
    label: "Exercise Minutes",
    trackerName: "Exercise Minutes",
    category: "fitness",
    field: "minutes",
    unit: "min",
    agg: "sum",
    aliases: ["exercise time", "active minutes"],
    fields: [{ name: "minutes", type: "number", unit: "min", isPrimary: true }],
  },
  {
    id: "heart_rate",
    label: "Heart Rate",
    trackerName: "Heart Rate",
    category: "vitals",
    field: "heart_rate",
    unit: "bpm",
    agg: "avg",
    aliases: ["pulse"],
    fields: [{ name: "heart_rate", type: "number", unit: "bpm", isPrimary: true }],
  },
  {
    id: "resting_heart_rate",
    label: "Resting Heart Rate",
    trackerName: "Resting Heart Rate",
    category: "vitals",
    field: "heart_rate",
    unit: "bpm",
    agg: "avg",
    aliases: ["rhr", "resting hr"],
    fields: [{ name: "heart_rate", type: "number", unit: "bpm", isPrimary: true }],
  },
  {
    id: "hrv",
    // NOT "Heart Rate Variability" — that matches /heart\s*rate/ and would
    // hijack the heart-rate vital.
    label: "HRV",
    trackerName: "HRV",
    category: "vitals",
    field: "hrv",
    unit: "ms",
    agg: "avg",
    aliases: ["heart rate variability", "sdnn"],
    fields: [{ name: "hrv", type: "number", unit: "ms", isPrimary: true }],
  },
  {
    id: "vo2_max",
    label: "VO2 Max",
    trackerName: "VO2 Max",
    category: "fitness",
    field: "vo2_max",
    unit: "mL/kg·min",
    agg: "latest",
    aliases: ["vo2max", "cardio fitness"],
    fields: [{ name: "vo2_max", type: "number", unit: "mL/kg·min", isPrimary: true }],
  },
  {
    id: "blood_oxygen",
    label: "Blood Oxygen",
    trackerName: "Blood Oxygen",
    category: "vitals",
    field: "spo2",
    unit: "%",
    agg: "avg",
    aliases: ["spo2", "oxygen saturation"],
    fields: [{ name: "spo2", type: "number", unit: "%", isPrimary: true }],
  },
  {
    id: "respiratory_rate",
    label: "Respiratory Rate",
    trackerName: "Respiratory Rate",
    category: "vitals",
    field: "breaths",
    unit: "br/min",
    agg: "avg",
    aliases: ["breathing rate"],
    fields: [{ name: "breaths", type: "number", unit: "br/min", isPrimary: true }],
  },
  {
    id: "sleep",
    label: "Sleep",
    trackerName: "Sleep",
    category: "sleep",
    field: "duration",
    unit: "hr",
    agg: "sum",
    aliases: ["sleep analysis", "time asleep"],
    fields: [
      { name: "duration", type: "number", unit: "hr", isPrimary: true },
      { name: "quality", type: "select", options: ["poor", "fair", "good", "excellent"] },
    ],
  },
  {
    id: "weight",
    label: "Weight",
    trackerName: "Weight",
    category: "weight",
    field: "weight",
    unit: "lbs",
    agg: "latest",
    aliases: ["body weight", "bodyweight", "scale weight"],
    fields: [{ name: "weight", type: "number", unit: "lbs", isPrimary: true }],
  },
  {
    id: "body_fat",
    label: "Body Fat",
    trackerName: "Body Fat",
    category: "health",
    field: "body_fat",
    unit: "%",
    agg: "latest",
    aliases: ["bodyfat", "body fat percentage"],
    fields: [{ name: "body_fat", type: "number", unit: "%", isPrimary: true }],
  },
  {
    id: "bmi",
    label: "BMI",
    trackerName: "BMI",
    category: "health",
    field: "bmi",
    unit: "",
    agg: "latest",
    aliases: ["body mass index"],
    fields: [{ name: "bmi", type: "number", isPrimary: true }],
  },
  {
    id: "blood_pressure",
    label: "Blood Pressure",
    trackerName: "Blood Pressure",
    category: "vitals",
    field: "systolic",
    unit: "mmHg",
    agg: "latest",
    extraFields: ["diastolic"],
    aliases: ["bp"],
    fields: [
      { name: "systolic", type: "number", unit: "mmHg", isPrimary: true },
      { name: "diastolic", type: "number", unit: "mmHg" },
      { name: "pulse", type: "number", unit: "bpm" },
    ],
  },
  {
    id: "blood_glucose",
    label: "Blood Glucose",
    trackerName: "Blood Glucose",
    category: "health",
    field: "glucose",
    unit: "mg/dL",
    agg: "avg",
    aliases: ["glucose", "blood sugar"],
    fields: [{ name: "glucose", type: "number", unit: "mg/dL", isPrimary: true }],
  },
  {
    id: "body_temp",
    label: "Body Temperature",
    trackerName: "Body Temperature",
    category: "vitals",
    field: "temperature",
    unit: "°F",
    agg: "avg",
    aliases: ["temperature", "body temp"],
    fields: [{ name: "temperature", type: "number", unit: "°F", isPrimary: true }],
  },
  {
    id: "hydration",
    label: "Hydration",
    trackerName: "Hydration",
    category: "hydration",
    field: "amount",
    unit: "oz",
    agg: "sum",
    aliases: ["water", "water intake", "fluid"],
    fields: [{ name: "amount", type: "number", unit: "oz", isPrimary: true }],
  },
  {
    id: "mindful_minutes",
    label: "Mindfulness",
    trackerName: "Mindfulness",
    category: "mental",
    field: "duration",
    unit: "min",
    agg: "sum",
    aliases: ["mindful minutes", "meditation"],
    fields: [{ name: "duration", type: "number", unit: "min", isPrimary: true }],
  },
  {
    id: "dietary_energy",
    label: "Nutrition",
    trackerName: "Nutrition",
    category: "nutrition",
    field: "calories",
    unit: "kcal",
    agg: "sum",
    aliases: ["calories", "food log", "diet"],
    fields: [
      { name: "calories", type: "number", unit: "kcal", isPrimary: true },
      { name: "protein", type: "number", unit: "g" },
      { name: "carbs", type: "number", unit: "g" },
      { name: "fat", type: "number", unit: "g" },
    ],
  },
];

const BY_ID = new Map(HEALTH_METRICS.map((m) => [m.id, m]));

export function getHealthMetric(id: string): HealthMetricDef | undefined {
  return BY_ID.get(id);
}

export const HEALTH_METRIC_IDS = HEALTH_METRICS.map((m) => m.id);

/**
 * Does an existing tracker correspond to this metric? Exact name match first,
 * then the alias list. Case- and whitespace-insensitive so "steps " and "Steps"
 * both reuse the user's existing tracker rather than creating a second one.
 */
export function trackerMatchesMetric(
  tracker: { name?: string; category?: string } | null | undefined,
  metric: HealthMetricDef,
): boolean {
  const name = String(tracker?.name || "").trim().toLowerCase();
  if (!name) return false;
  if (name === metric.trackerName.toLowerCase()) return true;
  return (metric.aliases || []).some((a) => name === a.toLowerCase());
}

// -----------------------------------------------------------------------------
// Unit conversion
// -----------------------------------------------------------------------------
// Health sources are inconsistent: HealthKit reports kilograms on a metric
// locale and pounds on a US one, sleep in seconds or minutes, distance in
// metres or miles. We normalise to the registry's canonical unit so a tracker
// never ends up mixing units across entries (which would silently corrupt every
// average and sparkline downstream).

const LB_PER_KG = 2.2046226218;
const MI_PER_KM = 0.621371192;
const MI_PER_M = MI_PER_KM / 1000;
const OZ_PER_L = 33.8140226;

/** Normalise a unit string for comparison: lowercase, no spaces or periods. */
function normUnit(unit: string | null | undefined): string {
  return String(unit || "").trim().toLowerCase().replace(/[\s.]/g, "");
}

/**
 * Convert `value` from `unit` into the canonical unit for `metric`.
 * An unrecognised or absent unit is assumed to already be canonical — health
 * exports frequently omit the unit, and refusing the sample would be worse than
 * taking it at face value.
 */
export function toCanonical(
  metric: HealthMetricDef,
  value: number,
  unit?: string | null,
): number {
  if (!Number.isFinite(value)) return NaN;
  const u = normUnit(unit);
  if (!u) return value;

  switch (metric.unit) {
    case "lbs":
      if (u === "kg" || u === "kilogram" || u === "kilograms") return value * LB_PER_KG;
      if (u === "g" || u === "gram" || u === "grams") return (value / 1000) * LB_PER_KG;
      if (u === "st" || u === "stone") return value * 14;
      return value;

    case "mi":
      if (u === "km" || u === "kilometer" || u === "kilometers") return value * MI_PER_KM;
      if (u === "m" || u === "meter" || u === "meters") return value * MI_PER_M;
      if (u === "ft" || u === "feet") return value / 5280;
      if (u === "yd" || u === "yard" || u === "yards") return value / 1760;
      return value;

    case "hr":
      if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") return value / 3600;
      if (u === "ms") return value / 3600000;
      if (u === "min" || u === "mins" || u === "minute" || u === "minutes") return value / 60;
      if (u === "d" || u === "day" || u === "days") return value * 24;
      return value;

    case "min":
      if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") return value / 60;
      if (u === "ms") return value / 60000;
      if (u === "hr" || u === "h" || u === "hour" || u === "hours") return value * 60;
      return value;

    case "oz":
      if (u === "ml" || u === "milliliter" || u === "milliliters") return (value / 1000) * OZ_PER_L;
      if (u === "l" || u === "liter" || u === "liters") return value * OZ_PER_L;
      if (u === "cup" || u === "cups") return value * 8;
      return value;

    case "mg/dL":
      // mmol/L → mg/dL for glucose specifically (the factor is analyte-dependent).
      if (u === "mmol/l" || u === "mmoll") return value * 18.0182;
      return value;

    case "°F":
      if (u === "c" || u === "°c" || u === "degc" || u === "celsius") return value * 9 / 5 + 32;
      if (u === "k" || u === "kelvin") return (value - 273.15) * 9 / 5 + 32;
      return value;

    case "kcal":
      if (u === "cal" || u === "calorie" || u === "calories") return value / 1000;
      if (u === "kj" || u === "kilojoule" || u === "kilojoules") return value / 4.184;
      return value;

    case "%":
      // HealthKit reports body fat and SpO2 as a 0–1 fraction.
      if (u === "fraction" || u === "ratio") return value * 100;
      return value;

    default:
      return value;
  }
}

/** Round to a sensible precision for the metric so we don't store 8214.000000001. */
export function roundForMetric(metric: HealthMetricDef, value: number): number {
  if (!Number.isFinite(value)) return NaN;
  // Counts are whole numbers; measurements keep two decimals.
  const whole = metric.unit === "steps" || metric.unit === "kcal" || metric.unit === "mmHg";
  if (whole) return Math.round(value);
  return Math.round(value * 100) / 100;
}

// -----------------------------------------------------------------------------
// Daily aggregation
// -----------------------------------------------------------------------------

export interface HealthSample {
  /** Registry metric id. */
  metric: string;
  /** Local calendar day, "YYYY-MM-DD". */
  day: string;
  value: number;
  unit?: string | null;
  /** Second value for two-valued metrics (diastolic on blood pressure). */
  value2?: number | null;
}

export interface DailyRow {
  metric: string;
  day: string;
  value: number;
  value2?: number;
}

interface Bucket {
  sum: number;
  count: number;
  max: number;
  latest: number;
  sum2: number;
  count2: number;
  latest2: number;
  hasSecond: boolean;
}

/**
 * Collapse raw samples into one row per (metric, day) using the registry's agg
 * rule. Samples must arrive in chronological order for "latest" to mean the
 * latest — the parsers guarantee this, and re-sorting a multi-year export in
 * memory would be wasteful.
 *
 * Unknown metric ids and non-finite values are dropped rather than throwing:
 * a health export routinely contains record types we don't model, and one bad
 * row should never abort an import of 30,000 good ones.
 */
export function aggregateDaily(samples: HealthSample[]): DailyRow[] {
  const buckets = new Map<string, Bucket>();

  for (const s of samples) {
    const def = BY_ID.get(s.metric);
    if (!def) continue;
    const value = roundForMetric(def, toCanonical(def, Number(s.value), s.unit));
    if (!Number.isFinite(value)) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.day)) continue;

    const key = `${s.metric} ${s.day}`;
    let b = buckets.get(key);
    if (!b) {
      b = { sum: 0, count: 0, max: -Infinity, latest: 0, sum2: 0, count2: 0, latest2: 0, hasSecond: false };
      buckets.set(key, b);
    }
    b.sum += value;
    b.count += 1;
    if (value > b.max) b.max = value;
    b.latest = value;

    if (def.extraFields?.length && s.value2 != null) {
      const v2 = roundForMetric(def, toCanonical(def, Number(s.value2), s.unit));
      if (Number.isFinite(v2)) {
        b.sum2 += v2;
        b.count2 += 1;
        b.latest2 = v2;
        b.hasSecond = true;
      }
    }
  }

  const out: DailyRow[] = [];
  for (const [key, b] of buckets) {
    const sep = key.indexOf(" ");
    const metric = key.slice(0, sep);
    const day = key.slice(sep + 1);
    const def = BY_ID.get(metric)!;
    const row: DailyRow = { metric, day, value: reduce(def.agg, b) };
    if (b.hasSecond) row.value2 = reduce2(def.agg, b);
    out.push(row);
  }
  // Stable order: metric, then day. Makes chunking deterministic and tests readable.
  out.sort((a, b) => (a.metric === b.metric ? a.day.localeCompare(b.day) : a.metric.localeCompare(b.metric)));
  return out;
}

function reduce(agg: HealthAgg, b: Bucket): number {
  switch (agg) {
    case "sum": return round2(b.sum);
    case "avg": return b.count ? round2(b.sum / b.count) : 0;
    case "max": return b.max === -Infinity ? 0 : b.max;
    case "latest":
    default: return b.latest;
  }
}

function reduce2(agg: HealthAgg, b: Bucket): number {
  switch (agg) {
    case "sum": return round2(b.sum2);
    case "avg": return b.count2 ? round2(b.sum2 / b.count2) : 0;
    case "max":
    case "latest":
    default: return b.latest2;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------------------
// Provider type maps
// -----------------------------------------------------------------------------

/** Apple Health export.xml `Record type="..."` → registry metric id. */
export const HEALTHKIT_TYPE_MAP: Record<string, string> = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance_walked",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_energy",
  HKQuantityTypeIdentifierAppleExerciseTime: "exercise_minutes",
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_heart_rate",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv",
  HKQuantityTypeIdentifierVO2Max: "vo2_max",
  HKQuantityTypeIdentifierOxygenSaturation: "blood_oxygen",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratory_rate",
  HKCategoryTypeIdentifierSleepAnalysis: "sleep",
  HKQuantityTypeIdentifierBodyMass: "weight",
  HKQuantityTypeIdentifierBodyFatPercentage: "body_fat",
  HKQuantityTypeIdentifierBodyMassIndex: "bmi",
  HKQuantityTypeIdentifierBloodPressureSystolic: "blood_pressure",
  HKQuantityTypeIdentifierBloodGlucose: "blood_glucose",
  HKQuantityTypeIdentifierBodyTemperature: "body_temp",
  HKQuantityTypeIdentifierDietaryWater: "hydration",
  HKCategoryTypeIdentifierMindfulSession: "mindful_minutes",
  HKQuantityTypeIdentifierDietaryEnergyConsumed: "dietary_energy",
};

/**
 * Diastolic arrives as its own HealthKit record and has to be folded into the
 * systolic sample rather than mapped to a metric of its own.
 */
export const HEALTHKIT_DIASTOLIC_TYPE = "HKQuantityTypeIdentifierBloodPressureDiastolic";

/** Android Health Connect record type → registry metric id. */
export const HEALTH_CONNECT_TYPE_MAP: Record<string, string> = {
  Steps: "steps",
  Distance: "distance_walked",
  ActiveCaloriesBurned: "active_energy",
  ExerciseSession: "exercise_minutes",
  HeartRate: "heart_rate",
  RestingHeartRate: "resting_heart_rate",
  HeartRateVariabilityRmssd: "hrv",
  Vo2Max: "vo2_max",
  OxygenSaturation: "blood_oxygen",
  RespiratoryRate: "respiratory_rate",
  SleepSession: "sleep",
  Weight: "weight",
  BodyFat: "body_fat",
  BloodPressure: "blood_pressure",
  BloodGlucose: "blood_glucose",
  BodyTemperature: "body_temp",
  Hydration: "hydration",
  MindfulnessSession: "mindful_minutes",
  NutritionRecord: "dietary_energy",
};

// -----------------------------------------------------------------------------
// Wire contract
// -----------------------------------------------------------------------------

export const HEALTH_PROVIDERS = ["apple_health", "health_connect", "file"] as const;
export type HealthProvider = (typeof HEALTH_PROVIDERS)[number];

/** Tag applied to every entry this pipeline writes. Untagged entries are the
 *  user's own hand-logged readings and are never touched. */
export const HEALTH_IMPORT_TAG = "health-import";

/** Per-provider tag so a disconnect+purge only removes that provider's rows. */
export function providerTag(provider: string): string {
  return `src:${provider}`;
}

/** Preference key holding a provider's connection state. Server-written only —
 *  "health_" is in PREF_KEY_PREFIX_DENY so the client cannot forge it. */
export function connectionPrefKey(provider: string): string {
  return `health_conn_${provider}`;
}

/**
 * Max daily rows per request. A five-year backfill across the full registry is
 * ~36k rows; at 1000 per chunk that's 37 requests, each comfortably inside the
 * 10mb body cap and the 60s Vercel function budget.
 */
export const HEALTH_IMPORT_CHUNK_SIZE = 1000;

export const dailyRowSchema = z.object({
  metric: z.string().refine((m) => BY_ID.has(m), { message: "Unknown health metric" }),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD"),
  value: z.number().finite(),
  value2: z.number().finite().optional(),
});

export const healthImportSchema = z.object({
  provider: z.enum(HEALTH_PROVIDERS),
  rows: z.array(dailyRowSchema).min(1).max(HEALTH_IMPORT_CHUNK_SIZE),
  /** Chunk bookkeeping so the server can stamp connection state on the last one. */
  chunk: z.object({ index: z.number().int().min(0), total: z.number().int().min(1) }).optional(),
  /** Batch id returned by the first chunk, threaded through the rest so all
   *  chunks of one import land in a single undoable ledger row. */
  batchId: z.string().optional(),
});

export type HealthImportPayload = z.infer<typeof healthImportSchema>;
