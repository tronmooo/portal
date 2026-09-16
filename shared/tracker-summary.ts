// ── Tracker "today" summary — one line that says what actually happened ──────
//
// Every surface that shows a tracker (dashboard card, detail header, the med
// suite) used to compose its own one-liner, and the medication case got it
// wrong in a way that hid data: a supplement was reported as a BOOLEAN
// ("✓ Taken today") when a medication or supplement can genuinely have many
// occurrences in one day (9 AM / 1 PM / 7 PM). Counting is the only honest
// summary, so this module counts:
//
//   Multivitamin → "2 doses today"       (+ "Last: 4m ago")
//   Water        → "64 oz today"
//   Soccer       → "30 min · ~280 cal"
//   Squats       → "12 reps × 3 sets"
//   Weight       → "184.6 lb"
//   Bathroom     → "3 visits today"
//
// Calories on a session line come from shared/fitness-metrics (the app's one
// MET/body-weight engine) — this module only formats what that returns, and
// marks an estimate with "~" so a guess is never shown as measured data.
//
// Pure and clock-injectable so tests can pin every line.

import type { Tracker, TrackerEntry } from "./schema";
import { parseFrequencyToDosesPerDay } from "./medication-refills";
// Unit spelling is decided in ONE place (shared/tracker-units.ts) — see the
// no-inline-unit-guessing contract. This module never invents a unit.
import { displayUnit } from "./tracker-units";
// Calories are the fitness engine's job, not this module's — one MET table,
// one body-weight resolution, one confidence model.
import {
  classifyFitnessActivity,
  isCalorieBearingActivity,
  readFitnessFacts,
  estimateCaloriesBurned,
} from "./fitness-metrics";

/** Population average adult body mass, used when we don't know the person's. */

const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (v: unknown) => norm(v).replace(/[^a-z0-9 ]/g, " ");

function numeric(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string" || !/\d/.test(v)) return null;
  const n = parseFloat(v.replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : null;
}

/** First numeric value among `keys`, in order. */
function pick(values: Record<string, any> | undefined, ...keys: string[]): number | null {
  if (!values) return null;
  for (const k of keys) {
    const n = numeric(values[k]);
    if (n != null) return n;
  }
  return null;
}

function fmt(n: number, dp = 1): string {
  if (!isFinite(n)) return "0";
  const rounded = Math.round(n * 10 ** dp) / 10 ** dp;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(dp);
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// ── Occurrence trackers ──────────────────────────────────────────────────────

/**
 * A CONCENTRATION unit — an amount per unit volume ("ng/mL", "mg/dL",
 * "nmol/L", "EU/dL"). This is what separates a lab RESULT from a DOSE: a dose
 * is an amount ("500 mg", "2 tablets"), a blood level is an amount per volume.
 *
 * It matters because a "Vitamin D" tracker whose unit is ng/mL is a blood
 * panel reading, and matching it on the word "vitamin" put a dose ledger —
 * adherence, doses-taken tally, "log another dose" — over a lab value.
 */
export function isConcentrationUnit(unit: string | null | undefined): boolean {
  const u = String(unit ?? "").toLowerCase().replace(/\s+/g, "");
  if (!u.includes("/")) return false;
  return /\/(l|dl|ml|cl|100ml|mm3|mcl|µl|ul|kg|g|mg)$/.test(u);
}

/** Does this tracker read a lab VALUE rather than record a dose? */
export function isLabValueTracker(tracker: Tracker): boolean {
  if (isConcentrationUnit(tracker.unit)) return true;
  return (tracker.fields || []).some((f) => isConcentrationUnit(f.unit));
}

/** Is this a medication/supplement tracker (dose-shaped, many per day)? */
export function isDoseTracker(tracker: Tracker): boolean {
  // A blood level is never a dose, however the tracker is named.
  if (isLabValueTracker(tracker)) return false;
  const cat = norm(tracker.category);
  if (cat === "medication" || cat === "prescription" || cat === "supplement") return true;
  const fieldNames = (tracker.fields || []).map((f) => norm(f.name));
  if (fieldNames.includes("adherence")) return true;
  if ((fieldNames.includes("dosage") || fieldNames.includes("dose")) &&
      (fieldNames.includes("taken") || fieldNames.includes("drug") || fieldNames.includes("drugname"))) return true;
  if ((tracker.entries || []).some((e) => e?.values && ("adherence" in e.values || "timeTaken" in e.values))) return true;
  return /\b(medication|supplement|vitamin|multivitamin|pill|capsule|softgel|tablet|gummy|lozenge|prescription|rx|dose|omega|fish oil|creatine|probiotic|melatonin|magnesium|biotin|collagen)\b/
    .test(words(tracker.name));
}

/** The noun for one occurrence of this tracker ("dose", "visit", "log"). */
export function occurrenceNoun(tracker: Tracker): string {
  if (isDoseTracker(tracker)) return "dose";
  const s = words(tracker.name);
  if (/\b(bathroom|restroom|toilet|pee|poop|urinat|bowel|stool|diaper)\b/.test(s)) return "visit";
  if (/\b(smoke|smoking|cigarette|vape|drink|alcohol|coffee|caffeine|snack|meal)\b/.test(s)) {
    if (/\b(smoke|smoking|cigarette)\b/.test(s)) return "cigarette";
    if (/\b(coffee)\b/.test(s)) return "cup";
    if (/\b(meal|snack)\b/.test(s)) return "meal";
    return "drink";
  }
  return "log";
}

/** A tracker whose entries ARE the measurement — you count them, not read them. */
export function isOccurrenceTracker(tracker: Tracker): boolean {
  return occurrenceNoun(tracker) !== "log";
}

// ── Relative time ────────────────────────────────────────────────────────────

/** "4m", "2h", "3d" — the compact form the cards use. */
export function shortAgo(timestamp: string | number | Date, now: number = Date.now()): string {
  const ts = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (!isFinite(ts)) return "";
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

// ── The summary ──────────────────────────────────────────────────────────────

export interface TrackerSummaryOpts {
  now?: number;
  /** Person's body mass, for weight-scaled calorie estimates. */
  bodyWeightKg?: number | null;
  /** Local day key (YYYY-MM-DD). Defaults to the runtime's local day. */
  todayKey?: string;
}

/**
 * Which shape the summary resolved to. Callers that already have a richer
 * second line for a plain reading ("+2 lb this month") use this to keep it,
 * while still taking the summary for the shapes it says more about.
 */
export type SummaryShape =
  | "dose" | "strength" | "session" | "occurrence" | "additive" | "measurement" | "empty";

export interface TrackerSummary {
  /** The headline one-liner, e.g. "2 doses today" or "30 min · ~280 cal". */
  line: string;
  /** How `line` was derived. */
  shape: SummaryShape;
  /** "Last: 4m ago" — set when the tracker logged something today. */
  lastLine: string;
  /** Occurrences logged today (doses, visits, sessions). */
  countToday: number;
  /** Newest entry's timestamp, or null when the tracker is empty. */
  lastTimestamp: string | null;
  /** Calories, when the summary derived or read any. */
  calories: number | null;
  /** True when `calories` was estimated rather than logged (renders as "~"). */
  caloriesEstimated: boolean;
}

const dayKeyOf = (ts: string | number | Date) => {
  const d = ts instanceof Date ? ts : new Date(ts);
  return isFinite(d.getTime()) ? d.toLocaleDateString("en-CA") : "";
};

function sortedEntries(tracker: Tracker): TrackerEntry[] {
  return (tracker.entries || [])
    .slice()
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
}

/**
 * The canonical one-line summary for a tracker. Shape is decided from the data
 * the entries actually carry, not from a per-tracker hardcode.
 */
export function summarizeTrackerToday(tracker: Tracker, opts: TrackerSummaryOpts = {}): TrackerSummary {
  const now = Number.isFinite(opts.now as number) ? (opts.now as number) : Date.now();
  const todayKey = opts.todayKey || new Date(now).toLocaleDateString("en-CA");
  const entries = sortedEntries(tracker);
  const last = entries[0];
  const todays = entries.filter((e) => dayKeyOf(e.timestamp) === todayKey);
  const base: TrackerSummary = {
    line: "",
    shape: "empty",
    lastLine: "",
    countToday: todays.length,
    lastTimestamp: last?.timestamp ? String(last.timestamp) : null,
    calories: null,
    caloriesEstimated: false,
  };
  if (!last) return base;
  if (todays.length > 0) base.lastLine = `Last: ${shortAgo(last.timestamp, now)}`;

  const name = tracker.name || "";
  const fields = tracker.fields || [];
  const fieldUnit = (n: string) => fields.find((f) => norm(f.name) === norm(n))?.unit || "";

  // ── Dose trackers: COUNT, never a boolean. Three doses today are three
  //    independent occurrences, and the summary must say so.
  if (isDoseTracker(tracker)) {
    base.shape = "dose";
    const noun = occurrenceNoun(tracker);
    if (todays.length > 0) {
      base.line = `${todays.length} ${plural(todays.length, noun)} today`;
    } else {
      const perDay = parseFrequencyToDosesPerDay(
        [tracker.unit, tracker.name, last.values?.frequency].map((x) => String(x || "")).join(" "),
      );
      base.line = perDay >= 1 && Number.isInteger(perDay) && perDay > 1
        ? `0 of ${perDay} doses today`
        : "No doses today";
      base.lastLine = `Last: ${shortAgo(last.timestamp, now)}`;
    }
    return base;
  }

  // ── Strength-shaped: "12 reps × 3 sets" (optionally "185 lb × 12 reps × 3 sets")
  const reps = pick(last.values, "reps", "rep_count", "repetitions");
  const sets = pick(last.values, "sets", "set_count");
  if (reps != null || sets != null) {
    base.shape = "strength";
    const liftWeight = pick(last.values, "weight", "lbs", "load");
    const wUnit = displayUnit(fieldUnit("weight") || tracker.unit || "lb");
    const parts: string[] = [];
    if (liftWeight != null && liftWeight > 0) parts.push(`${fmt(liftWeight, 0)}${wUnit ? ` ${wUnit}` : ""}`);
    if (reps != null) parts.push(`${fmt(reps, 0)} ${plural(reps, "rep")}`);
    if (sets != null) parts.push(`${fmt(sets, 0)} ${plural(sets, "set")}`);
    base.line = parts.join(" × ");
    return base;
  }

  // ── Session-shaped: a duration, optionally with calories. "30 min · ~280 cal"
  //    Calorie math is NOT reimplemented here — shared/fitness-metrics owns it
  //    (owner-scoped body weight, ACSM MET expression, confidence and basis).
  const minutes = pick(last.values, "duration", "minutes", "mins", "durationMinutes", "time", "sessionLength");
  const loggedCals = pick(last.values, "caloriesBurned", "calories_burned", "caloriesBurnt") ??
    numeric((last as any).computed?.caloriesBurned);
  const activity = classifyFitnessActivity(tracker.name || "", tracker.category || "");
  const isSportish = isCalorieBearingActivity(activity) ||
    norm(tracker.category) === "fitness" || norm(tracker.category) === "sports";
  if (minutes != null && minutes > 0 && (isSportish || loggedCals != null)) {
    base.shape = "session";
    const parts = [`${fmt(minutes, 0)} min`];
    const facts = readFitnessFacts(last.values, activity, (tracker.fields || []) as any);
    const est = estimateCaloriesBurned(activity, facts, { bodyWeightKg: opts.bodyWeightKg ?? null });
    if (est && est.value > 0) {
      base.calories = Math.round(est.value);
      base.caloriesEstimated = est.estimated;
      parts.push(`${est.estimated ? "~" : ""}${base.calories} cal`);
    }
    base.line = parts.join(" · ");
    return base;
  }

  // ── Occurrence trackers (bathroom visits, cigarettes, cups of coffee):
  //    the meaningful number is HOW MANY happened today, and a per-entry count
  //    field ("visits: 2") adds to that rather than replacing it.
  if (isOccurrenceTracker(tracker) && todays.length > 0) {
    base.shape = "occurrence";
    const noun = occurrenceNoun(tracker);
    const counted = todays.reduce(
      (s, e) => s + (pick(e.values, "count", "visits", "times", "occurrences", "quantity", "qty") ?? 1),
      0,
    );
    const n = Math.round(counted) || todays.length;
    base.line = `${n} ${plural(n, noun)} today`;
    return base;
  }

  // ── Additive: today's running TOTAL, not the last sip. "64 oz today"
  const primaryField =
    fields.find((f) => f.isPrimary)?.name ||
    fields.find((f) => norm(f.type) === "number")?.name ||
    fields[0]?.name ||
    "value";
  const unit = displayUnit(fieldUnit(primaryField) || tracker.unit || "");
  const isAdditive = /\b(water|hydrat|drink|fluid|intake|steps|calorie|kcal|distance|spend|spent|money|mileage)\b/
    .test(words(name));
  const todayTotal = todays.reduce((s, e) => s + (pick(e.values, primaryField) ?? 0), 0);
  if (isAdditive && todays.length > 0 && todayTotal !== 0) {
    base.shape = "additive";
    base.line = `${fmt(todayTotal, todayTotal % 1 === 0 ? 0 : 1)}${unit ? ` ${unit}` : ""} today`;
    return base;
  }

  // ── Measurement: the latest reading. "184.6 lb"
  const reading = pick(last.values, primaryField) ??
    (() => {
      for (const [k, v] of Object.entries(last.values || {})) {
        if (String(k).startsWith("_")) continue;
        const n = numeric(v);
        if (n != null) return n;
      }
      return null;
    })();
  if (reading != null) {
    base.shape = "measurement";
    base.line = `${fmt(reading, reading % 1 === 0 ? 0 : 1)}${unit ? ` ${unit}` : ""}`;
    return base;
  }

  // ── No number anywhere: it's an occurrence log. "3 visits today"
  if (todays.length > 0) {
    base.shape = "occurrence";
    const noun = occurrenceNoun(tracker);
    base.line = `${todays.length} ${plural(todays.length, noun)} today`;
    return base;
  }
  base.shape = "measurement";
  base.line = `Last logged ${shortAgo(last.timestamp, now)}`;
  return base;
}
