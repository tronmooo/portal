// Deterministic normalization + estimation engine — pure, no I/O, no LLM.
//
// The language model's job is to extract WHAT the user said ("I walked 1
// mile"); this module's job is all math: unit conversion into canonical
// units, exact derivations (distance + duration → pace), and labeled
// estimation of missing secondary metrics (distance → steps via stride).
// Every non-explicit value carries provenance {source, confidence, method}
// and every assumption is registered, so the app can always explain where a
// number came from and never passes an estimate off as user data.
//
// Pinned by tests/estimation-engine.test.ts.

// ─── Provenance ──────────────────────────────────────────────────────────────

export type ValueSource =
  | "user"               // stated verbatim in the message
  | "calculated"         // derived mathematically from exact user values only
  | "estimated"          // needed assumptions/profile data/history
  | "device"
  | "document"
  | "historical_pattern"
  | "default";

export interface ProvenancedValue {
  value: number;
  source: ValueSource;
  confidence: number; // 0..1
  method?: string;
}

export interface Assumption {
  field: string;
  assumption: string;
  valueUsed: string;
  confidence: number;
}

export interface Enrichment {
  activityType?: string;
  /** Canonical-unit mirrors of explicit values (meters, seconds, ml, kg). */
  canonical: Record<string, number>;
  /** Exact derivations from user-supplied values only. */
  calculated: Record<string, ProvenancedValue>;
  /** Values that required assumptions, profile data, or history. */
  estimated: Record<string, ProvenancedValue>;
  assumptions: Assumption[];
}

/** Below this confidence an estimate is not saved as a metric at all. */
export const MIN_SAVE_CONFIDENCE = 0.35;

const emptyEnrichment = (activityType?: string): Enrichment => ({
  activityType,
  canonical: {},
  calculated: {},
  estimated: {},
  assumptions: [],
});

// ─── Unit conversion (canonical: meters, seconds, ml, kg, kcal) ─────────────

export const METERS_PER_MILE = 1609.344;
export const METERS_PER_KM = 1000;
export const ML_PER_FLOZ = 29.5735;
export const KG_PER_LB = 0.45359237;

export function convertDistanceToMeters(value: number, unit: string): number | null {
  if (!isFinite(value)) return null;
  const u = String(unit || "").toLowerCase().replace(/[.\s]/g, "");
  if (["mi", "mile", "miles"].includes(u)) return value * METERS_PER_MILE;
  if (["km", "kilometer", "kilometers", "kilometre", "kilometres", "k"].includes(u)) return value * METERS_PER_KM;
  if (["m", "meter", "meters", "metre", "metres"].includes(u)) return value;
  if (["ft", "foot", "feet"].includes(u)) return value * 0.3048;
  if (["yd", "yard", "yards"].includes(u)) return value * 0.9144;
  return null;
}

export function convertVolumeToMl(value: number, unit: string): number | null {
  if (!isFinite(value)) return null;
  const u = String(unit || "").toLowerCase().replace(/[.\s]/g, "");
  if (["ml", "milliliter", "milliliters", "millilitre", "millilitres"].includes(u)) return value;
  if (["l", "liter", "liters", "litre", "litres"].includes(u)) return value * 1000;
  if (["oz", "floz", "ounce", "ounces"].includes(u)) return value * ML_PER_FLOZ;
  if (["cup", "cups"].includes(u)) return value * 8 * ML_PER_FLOZ;
  if (["gal", "gallon", "gallons"].includes(u)) return value * 128 * ML_PER_FLOZ;
  return null;
}

export function convertWeightToKg(value: number, unit: string): number | null {
  if (!isFinite(value)) return null;
  const u = String(unit || "").toLowerCase().replace(/[.\s]/g, "");
  if (["kg", "kgs", "kilogram", "kilograms"].includes(u)) return value;
  if (["lb", "lbs", "pound", "pounds"].includes(u)) return value * KG_PER_LB;
  if (["g", "gram", "grams"].includes(u)) return value / 1000;
  if (["st", "stone"].includes(u)) return value * 6.35029;
  return null;
}

/** "5'10", "5 ft 10", "70 in", "178 cm", 178 → centimeters. */
export function parseHeightToCm(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && isFinite(raw)) {
    if (raw >= 90 && raw <= 250) return raw;          // already cm
    if (raw >= 36 && raw < 90) return raw * 2.54;      // inches
    if (raw >= 3 && raw <= 8) return raw * 30.48;      // feet
    return null;
  }
  const s = String(raw).trim().toLowerCase();
  const ftIn = s.match(/(\d)\s*(?:'|ft|feet|foot)\s*(\d{1,2})?/);
  if (ftIn) return parseInt(ftIn[1], 10) * 30.48 + (ftIn[2] ? parseInt(ftIn[2], 10) * 2.54 : 0);
  const cm = s.match(/(\d{2,3}(?:\.\d+)?)\s*cm/);
  if (cm) return parseFloat(cm[1]);
  const inches = s.match(/(\d{2,3}(?:\.\d+)?)\s*(?:in|inch|inches|")/);
  if (inches) return parseFloat(inches[1]) * 2.54;
  const bare = parseFloat(s);
  if (isFinite(bare)) return parseHeightToCm(bare);
  return null;
}

/** "180 lbs", "82 kg", 180 → kilograms (bare numbers 80-400 read as lbs). */
export function parseWeightToKg(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && isFinite(raw)) {
    if (raw >= 80 && raw <= 500) return raw * KG_PER_LB; // bare imperial default
    if (raw >= 30 && raw < 80) return raw;               // plausible kg
    return null;
  }
  const s = String(raw).trim().toLowerCase();
  const kg = s.match(/(\d{2,3}(?:\.\d+)?)\s*(?:kg|kilo)/);
  if (kg) return parseFloat(kg[1]);
  const lb = s.match(/(\d{2,3}(?:\.\d+)?)\s*(?:lb|lbs|pound)/);
  if (lb) return parseFloat(lb[1]) * KG_PER_LB;
  const bare = parseFloat(s);
  if (isFinite(bare)) return parseWeightToKg(bare);
  return null;
}

/** "11:30 PM" → minutes since midnight, or null. */
function clockToMinutes(raw: string): number | null {
  const m = String(raw || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3]) {
    h = h % 12;
    if (/^p/i.test(m[3])) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Sleep duration in hours from bed/wake clock times, crossing midnight if needed. */
export function calculateDurationFromTimes(bedtime: string, wakeTime: string): number | null {
  const bed = clockToMinutes(bedtime);
  const wake = clockToMinutes(wakeTime);
  if (bed == null || wake == null) return null;
  let mins = wake - bed;
  if (mins <= 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

// ─── Personal metrics learned from the profile's own history ────────────────

export interface PersonalMetrics {
  stepsPerMile?: number;
  paceMinutesPerMile?: number;
  samples: number;
}

/**
 * Weighted personal averages from the ACTIVE PROFILE'S recent entries — never
 * another profile's data. Recent entries weigh more (half-life ~14 days), so
 * one unusual entry can't swing the learned value drastically.
 */
export function derivePersonalMetrics(
  entries: Array<{ values?: Record<string, any>; timestamp?: string }>,
  now: Date = new Date(),
): PersonalMetrics {
  let ratioWeight = 0, ratioSum = 0, paceWeight = 0, paceSum = 0, samples = 0;
  for (const e of entries || []) {
    const v = e?.values || {};
    const miles = numeric(v.distance ?? v.miles ?? v.distanceMiles);
    const steps = numeric(v.steps);
    const minutes = numeric(v.duration ?? v.minutes ?? v.durationMinutes);
    const ageDays = e.timestamp ? Math.max(0, (now.getTime() - new Date(e.timestamp).getTime()) / 86400000) : 30;
    const w = Math.pow(0.5, ageDays / 14);
    let used = false;
    if (miles && miles > 0.05 && steps && steps > 50) {
      const ratio = steps / miles;
      if (ratio > 700 && ratio < 5000) { ratioSum += ratio * w; ratioWeight += w; used = true; }
    }
    if (miles && miles > 0.05 && minutes && minutes > 1) {
      const pace = minutes / miles;
      if (pace > 4 && pace < 60) { paceSum += pace * w; paceWeight += w; used = true; }
    }
    if (used) samples++;
  }
  return {
    stepsPerMile: ratioWeight > 0 ? Math.round(ratioSum / ratioWeight) : undefined,
    paceMinutesPerMile: paceWeight > 0 ? Math.round((paceSum / paceWeight) * 10) / 10 : undefined,
    samples,
  };
}

// ─── Stride / steps ──────────────────────────────────────────────────────────

const WALK_STRIDE_COEFF = 0.415; // stride ≈ height × coeff
const RUN_STRIDE_COEFF = 0.65;
const DEFAULT_STRIDE_M = 0.76;   // population average walking stride
const DEFAULT_WALK_PACE_MIN_PER_MILE = 20;
const DEFAULT_RUN_PACE_MIN_PER_MILE = 10;
const DEFAULT_WEIGHT_KG = 70;

export function estimateStrideMeters(heightCm: number | null, activity: "walking" | "running"): { stride: number; basis: "height" | "default" } {
  const coeff = activity === "running" ? RUN_STRIDE_COEFF : WALK_STRIDE_COEFF;
  if (heightCm && heightCm > 90 && heightCm < 250) {
    return { stride: (heightCm / 100) * coeff, basis: "height" };
  }
  return { stride: activity === "running" ? DEFAULT_STRIDE_M * 1.35 : DEFAULT_STRIDE_M, basis: "default" };
}

// ─── Walking / running enrichment ────────────────────────────────────────────

export interface ActivityProfileContext {
  heightCm?: number | null;
  weightKg?: number | null;
  personal?: PersonalMetrics | null;
}

function numeric(v: any): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return isFinite(n) ? n : null;
}

const round = (n: number, dp = 0) => { const f = 10 ** dp; return Math.round(n * f) / f; };

/**
 * Enrich a walking/running entry. `explicit` holds ONLY what the user stated
 * (normalized keys: distance [miles unless distanceKm], steps, duration
 * [minutes], caloriesBurned, intensity). Explicit values are NEVER replaced;
 * derivable gaps become calculated (all inputs exact) or estimated (needed
 * an assumption), each with confidence + registered assumptions.
 */
export function enrichWalkRunEntry(
  activity: "walking" | "running",
  explicit: Record<string, any>,
  ctx: ActivityProfileContext = {},
): Enrichment {
  const out = emptyEnrichment(activity);
  const personal = ctx.personal && ctx.personal.samples > 0 ? ctx.personal : null;

  // ── explicit facts, converted to working units ──
  let miles = numeric(explicit.distance ?? explicit.miles ?? explicit.distanceMiles);
  const km = numeric(explicit.distanceKm ?? explicit.kilometers ?? explicit.km);
  if (miles == null && km != null) {
    miles = km * METERS_PER_KM / METERS_PER_MILE;
    out.calculated.distance = { value: round(miles, 2), source: "calculated", confidence: 1, method: "kilometers converted to miles" };
  }
  const steps = numeric(explicit.steps);
  const minutes = numeric(explicit.duration ?? explicit.minutes ?? explicit.durationMinutes);
  const explicitCalories = numeric(explicit.caloriesBurned ?? explicit.calories);
  const intensity = typeof explicit.intensity === "string" ? explicit.intensity.toLowerCase() : null;

  const distanceExplicit = miles != null;
  const stepsExplicit = steps != null;
  const durationExplicit = minutes != null;

  // ── canonical mirrors of what we know exactly ──
  if (miles != null) out.canonical.distanceMeters = round(miles * METERS_PER_MILE, 1);
  if (minutes != null) out.canonical.durationSeconds = round(minutes * 60);

  // ── stride / steps-per-mile source hierarchy: personal history → height → default ──
  const strideInfo = estimateStrideMeters(ctx.heightCm ?? null, activity);
  const stepsPerMileFromStride = METERS_PER_MILE / strideInfo.stride;
  const stepsPerMile = personal?.stepsPerMile ?? stepsPerMileFromStride;
  const stepsBasis: { source: ValueSource; confidence: number; method: string } = personal?.stepsPerMile
    ? { source: "estimated", confidence: 0.8, method: `personal average of ${personal.samples} recent entries (${personal.stepsPerMile} steps/mile)` }
    : strideInfo.basis === "height"
      ? { source: "estimated", confidence: 0.65, method: `stride length estimated from height (${round(strideInfo.stride, 2)} m)` }
      : { source: "estimated", confidence: 0.45, method: `population-average stride (${round(strideInfo.stride, 2)} m)` };

  const paceDefault = activity === "running" ? DEFAULT_RUN_PACE_MIN_PER_MILE : DEFAULT_WALK_PACE_MIN_PER_MILE;
  const paceSource: { pace: number; source: ValueSource; confidence: number; method: string } = personal?.paceMinutesPerMile
    ? { pace: personal.paceMinutesPerMile, source: "estimated", confidence: 0.75, method: `personal average pace (${personal.paceMinutesPerMile} min/mile)` }
    : { pace: paceDefault, source: "estimated", confidence: 0.45, method: `default ${activity} pace (${paceDefault} min/mile)` };

  // ── derive missing fields, never overwriting explicit ones ──

  // pace + speed: calculated when distance AND duration are exact.
  if (distanceExplicit && durationExplicit && miles! > 0) {
    const paceMin = minutes! / miles!;
    out.calculated.paceMinutesPerMile = { value: round(paceMin, 1), source: "calculated", confidence: 1, method: "duration ÷ distance" };
    out.calculated.speedMph = { value: round(60 / paceMin, 2), source: "calculated", confidence: 1, method: "distance ÷ duration" };
    out.canonical.paceSecondsPerMile = round(paceMin * 60);
    out.canonical.speedMetersPerSecond = round((miles! * METERS_PER_MILE) / (minutes! * 60), 2);
  }

  // distance from steps.
  let workingMiles = miles;
  if (!distanceExplicit && stepsExplicit) {
    const estMiles = steps! / stepsPerMile;
    out.estimated.distance = { value: round(estMiles, 2), source: stepsBasis.source, confidence: stepsBasis.confidence, method: `steps ÷ ${round(stepsPerMile)} steps/mile — ${stepsBasis.method}` };
    out.assumptions.push({ field: "distance", assumption: stepsBasis.method, valueUsed: `${round(stepsPerMile)} steps/mile`, confidence: stepsBasis.confidence });
    workingMiles = estMiles;
    out.canonical.distanceMeters = round(estMiles * METERS_PER_MILE, 1);
  }

  // distance from duration (pace assumption).
  if (!distanceExplicit && !stepsExplicit && durationExplicit) {
    const estMiles = minutes! / paceSource.pace;
    const conf = Math.min(paceSource.confidence, 0.7);
    out.estimated.distance = { value: round(estMiles, 2), source: paceSource.source, confidence: conf, method: paceSource.method };
    out.assumptions.push({ field: "distance", assumption: paceSource.method, valueUsed: `${paceSource.pace} min/mile`, confidence: conf });
    workingMiles = estMiles;
    out.canonical.distanceMeters = round(estMiles * METERS_PER_MILE, 1);
  }

  // steps from distance.
  if (!stepsExplicit && workingMiles != null) {
    const conf = distanceExplicit ? stepsBasis.confidence : Math.max(0.3, stepsBasis.confidence - 0.15);
    if (conf >= MIN_SAVE_CONFIDENCE) {
      out.estimated.steps = { value: Math.round(workingMiles * stepsPerMile), source: stepsBasis.source, confidence: conf, method: stepsBasis.method };
      out.assumptions.push({ field: "steps", assumption: stepsBasis.method, valueUsed: `${round(stepsPerMile)} steps/mile`, confidence: conf });
    }
  }

  // duration from distance (pace assumption).
  if (!durationExplicit && workingMiles != null) {
    const conf = distanceExplicit ? Math.min(paceSource.confidence, 0.76) : Math.max(0.3, paceSource.confidence - 0.2);
    if (conf >= MIN_SAVE_CONFIDENCE) {
      out.estimated.duration = { value: round(workingMiles * paceSource.pace, 1), source: paceSource.source, confidence: conf, method: paceSource.method };
      out.assumptions.push({ field: "duration", assumption: paceSource.method, valueUsed: `${paceSource.pace} min/mile`, confidence: conf });
      out.canonical.durationSeconds = round(workingMiles * paceSource.pace * 60);
    }
  }

  // calories: keep explicit; otherwise MET-based estimate.
  if (explicitCalories == null && workingMiles != null) {
    const weightKg = ctx.weightKg && ctx.weightKg > 20 ? ctx.weightKg : DEFAULT_WEIGHT_KG;
    const weightKnown = !!(ctx.weightKg && ctx.weightKg > 20);
    const paceMin = out.calculated.paceMinutesPerMile?.value
      ?? (durationExplicit && workingMiles > 0 ? minutes! / workingMiles : paceSource.pace);
    const mph = 60 / paceMin;
    let met: number;
    if (activity === "running") met = Math.max(6, 1.61 * mph);
    else met = mph >= 3.5 ? 5.0 : mph >= 2.8 ? 3.5 : 3.0;
    if (intensity === "intense" || intensity === "hard" || intensity === "vigorous") met *= 1.15;
    if (intensity === "light" || intensity === "easy") met *= 0.85;
    const hours = (out.canonical.durationSeconds ?? workingMiles * paceSource.pace * 60) / 3600;
    const kcal = met * weightKg * hours;
    const conf = Math.max(0.35, Math.min(0.7, (weightKnown ? 0.6 : 0.4) + (durationExplicit ? 0.1 : 0)));
    out.estimated.caloriesBurned = {
      value: Math.round(kcal),
      source: "estimated",
      confidence: conf,
      method: `MET ${round(met, 1)} × ${weightKnown ? "profile" : "default"} weight ${round(weightKg)}kg × ${round(hours, 2)}h`,
    };
    out.assumptions.push({
      field: "caloriesBurned",
      assumption: weightKnown ? "Used profile weight" : "Used population default weight",
      valueUsed: `${round(weightKg)} kg`,
      confidence: conf,
    });
  }

  return out;
}

// ─── Hydration ───────────────────────────────────────────────────────────────

const CONTAINER_ML: Record<string, { ml: number; label: string }> = {
  bottle: { ml: 16.9 * ML_PER_FLOZ, label: "16.9 oz bottle" },
  glass: { ml: 8 * ML_PER_FLOZ, label: "8 oz glass" },
  cup: { ml: 8 * ML_PER_FLOZ, label: "8 oz cup" },
  mug: { ml: 12 * ML_PER_FLOZ, label: "12 oz mug" },
  can: { ml: 12 * ML_PER_FLOZ, label: "12 oz can" },
  sip: { ml: 28, label: "28 ml sip" },
};

/** "4 bottles" → ounces, labeled as an estimate unless the size was stated. */
export function enrichHydrationEntry(explicit: Record<string, any>): Enrichment {
  const out = emptyEnrichment("hydration");
  const ounces = numeric(explicit.ounces ?? explicit.oz);
  const mlExplicit = numeric(explicit.ml ?? explicit.milliliters);
  if (ounces != null) { out.canonical.volumeMl = round(ounces * ML_PER_FLOZ); return out; }
  if (mlExplicit != null) {
    out.canonical.volumeMl = round(mlExplicit);
    out.calculated.ounces = { value: round(mlExplicit / ML_PER_FLOZ, 1), source: "calculated", confidence: 1, method: "ml converted to oz" };
    return out;
  }
  const count = numeric(explicit.containerCount ?? explicit.count ?? explicit.bottles ?? explicit.glasses ?? explicit.cups);
  let type = String(explicit.containerType || "").toLowerCase();
  if (!type) {
    if (explicit.bottles != null) type = "bottle";
    else if (explicit.glasses != null) type = "glass";
    else if (explicit.cups != null) type = "cup";
  }
  const container = CONTAINER_ML[type];
  if (count != null && container) {
    const ml = count * container.ml;
    out.estimated.ounces = { value: round(ml / ML_PER_FLOZ, 1), source: "estimated", confidence: 0.55, method: `${count} × assumed ${container.label}` };
    out.canonical.volumeMl = round(ml);
    out.assumptions.push({ field: "ounces", assumption: `Assumed standard ${type} size`, valueUsed: container.label, confidence: 0.55 });
  }
  return out;
}

// ─── Sleep ───────────────────────────────────────────────────────────────────

/** Duration from bed/wake times is CALCULATED (exact inputs), not estimated. */
export function enrichSleepEntry(explicit: Record<string, any>): Enrichment {
  const out = emptyEnrichment("sleep");
  const hours = numeric(explicit.hours);
  if (hours != null) { out.canonical.durationSeconds = round(hours * 3600); return out; }
  const bed = explicit.bedtime ? String(explicit.bedtime) : null;
  const wake = explicit.wakeTime ? String(explicit.wakeTime) : null;
  if (bed && wake) {
    const h = calculateDurationFromTimes(bed, wake);
    if (h != null) {
      out.calculated.hours = { value: h, source: "calculated", confidence: 0.95, method: `from ${bed} to ${wake}` };
      out.canonical.durationSeconds = round(h * 3600);
    }
  }
  return out;
}

// ─── Compact human summary for replies/cards ─────────────────────────────────

const FIELD_LABELS: Record<string, (v: number) => string> = {
  steps: (v) => `${Math.round(v).toLocaleString()} steps`,
  distance: (v) => `${v} mi`,
  duration: (v) => `${v} min`,
  caloriesBurned: (v) => `${Math.round(v)} cal`,
  paceMinutesPerMile: (v) => `${v} min/mile pace`,
  speedMph: (v) => `${v} mph`,
  ounces: (v) => `${v} oz`,
  hours: (v) => `${v} h`,
};

/** "≈2,150 steps, ≈20 min (estimated)" — for the chat reply and cards. */
export function summarizeEnrichment(e: Enrichment | null | undefined): string {
  if (!e) return "";
  const parts: string[] = [];
  for (const [k, pv] of Object.entries(e.calculated)) {
    const label = FIELD_LABELS[k]?.(pv.value) ?? `${pv.value} ${k}`;
    parts.push(label);
  }
  const est: string[] = [];
  for (const [k, pv] of Object.entries(e.estimated)) {
    const label = FIELD_LABELS[k]?.(pv.value) ?? `${pv.value} ${k}`;
    est.push(`≈${label}`);
  }
  if (est.length) parts.push(`${est.join(", ")} (estimated)`);
  return parts.join(" · ");
}
