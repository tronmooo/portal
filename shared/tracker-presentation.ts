// Dynamic tracker presentation — the "common sense" engine that decides, from
// ANY tracker's fields/category/name/data, HOW it should be summarized and
// charted. This is the system behind a tracker feeling purpose-built without
// hardcoding a component per type: hydration sums to a daily total, weight
// shows the latest reading + range, a medication shows adherence, blood
// pressure shows a dual systolic/diastolic series, etc.
//
// Pure + unit-tested so the classification is provable and reusable by every
// view (detail overview, dashboard card, AI chart).

import { classifyMetric } from "./chart-data";
import { resolveTrackerUnit, isAdherenceTracker } from "./tracker-units";

export type MetricKind =
  | "additive"     // sum over a period: water, calories, miles, minutes, $ spent
  | "measurement"  // a reading at a point in time: weight, glucose, body temp
  | "adherence"    // did/didn't take it: medication & supplements
  | "dual"         // two paired numbers: blood pressure (systolic/diastolic)
  | "categorical"  // a 1–N rating / mood scale
  | "unknown";

export type Aggregation = "sum" | "avg" | "last";
export type ChartStyle = "bar" | "line" | "dual" | "adherence" | "none";
export type KpiId =
  | "total" | "avgPerActive" | "peak" | "daysLogged"
  | "latest" | "average" | "low" | "high"
  | "adherencePct" | "dosesLogged"
  | "latestPair" | "avgSystolic" | "avgDiastolic" | "readings";

export interface TrackerLike {
  name?: string;
  category?: string;
  unit?: string | null;
  fields?: Array<{ name: string; type?: string; unit?: string; isPrimary?: boolean }>;
}

export interface TrackerPresentation {
  metricKind: MetricKind;
  primaryField: string | null;
  unit: string;
  aggregation: Aggregation;
  chartStyle: ChartStyle;
  kpis: KpiId[];
  goalCapable: boolean;
  /** human label for the metric, e.g. "Water", "Systolic/Diastolic" */
  label: string;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function fieldNames(t: TrackerLike): string[] {
  return (t.fields || []).map((f) => norm(f.name));
}

// Adherence detection lives in tracker-units (single definition); alias it here
// so the rest of this module reads naturally.
const isAdherence = isAdherenceTracker;

// Is this blood pressure (a paired systolic/diastolic reading)?
function isDual(t: TrackerLike): boolean {
  const fns = fieldNames(t);
  if (fns.includes("systolic") && fns.includes("diastolic")) return true;
  const n = String(t.name || "").toLowerCase();
  return /blood\s*pressure|(^|\s)bp(\s|$)/.test(n);
}

// Pick the primary numeric field: declared primary → first numeric → first.
function pickPrimary(t: TrackerLike): { name: string | null; type?: string } {
  const fields = t.fields || [];
  const primary = fields.find((f) => f.isPrimary && (f.type === "number" || f.type === undefined));
  if (primary) return { name: primary.name, type: primary.type };
  const numeric = fields.find((f) => f.type === "number");
  if (numeric) return { name: numeric.name, type: numeric.type };
  const first = fields.find((f) => f.name && f.name.toLowerCase() !== "_notes" && f.name.toLowerCase() !== "notes");
  return { name: first?.name ?? null, type: first?.type };
}

export function classifyTrackerPresentation(t: TrackerLike): TrackerPresentation {
  // 1) Medication / supplement → adherence.
  if (isAdherence(t)) {
    return {
      metricKind: "adherence", primaryField: null, unit: "",
      aggregation: "last", chartStyle: "adherence",
      kpis: ["adherencePct", "dosesLogged"], goalCapable: false,
      label: t.name || "Medication",
    };
  }

  // 2) Blood pressure → dual series.
  if (isDual(t)) {
    return {
      metricKind: "dual", primaryField: "systolic", unit: t.unit || "mmHg",
      aggregation: "last", chartStyle: "dual",
      kpis: ["latestPair", "avgSystolic", "avgDiastolic", "readings"], goalCapable: false,
      label: "Systolic/Diastolic",
    };
  }

  const primary = pickPrimary(t);
  const field = primary.name;

  // 3) Non-numeric primary (a text rating tracker with no numeric field) → unknown.
  if (!field) {
    return {
      metricKind: "unknown", primaryField: null, unit: t.unit || "",
      aggregation: "last", chartStyle: "none", kpis: [], goalCapable: false,
      label: t.name || "Tracker",
    };
  }

  const unit = resolveTrackerUnit(t, field);
  // chart-data's classifyMetric covers most fields; extend it with volume/count
  // context (hydration, drinks, reps) so a "Hydration" tracker measured in
  // ounces/cups/mL SUMS to a daily total instead of being treated as a reading.
  const f0 = norm(field);
  const additiveByContext =
    /(ounce|^oz$|cup|glass|ml|millilit|liter|litre|intake|serving|^reps?$|^sets?$|^laps?$|drink)/.test(f0) ||
    /(water|hydrat)/.test(norm(t.name));
  const mode = additiveByContext ? "sum" : classifyMetric(field); // "sum" | "last"

  if (mode === "sum") {
    // Additive: a daily TOTAL is the meaningful number → bars.
    return {
      metricKind: "additive", primaryField: field, unit,
      aggregation: "sum", chartStyle: "bar",
      kpis: ["total", "avgPerActive", "peak", "daysLogged"], goalCapable: true,
      label: field.charAt(0).toUpperCase() + field.slice(1),
    };
  }

  // Measurement: latest reading is meaningful → line.
  const f = norm(field);
  const categorical = /(mood|rating|score|stress|energy|pain|satisfaction|happiness)/.test(f);
  return {
    metricKind: categorical ? "categorical" : "measurement",
    primaryField: field, unit,
    aggregation: "last", chartStyle: "line",
    kpis: ["latest", "average", "low", "high"], goalCapable: true,
    label: field.charAt(0).toUpperCase() + field.slice(1),
  };
}
