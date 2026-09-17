// ─── Tracker entry value guard: one gate for every write path ───────────────
//
// There were three regimes for validating a tracker entry's values: the POST
// route had numeric coercion and sanity bounds, smart-entry had normalization
// but no bounds, and the five AI quick-log lanes had neither — so "log 8000
// hours of sleep" stored happily from chat while the same value 400'd from the
// form. The guard is pure and lives in one file; both storages' logEntry (and
// updateTrackerEntry) run it, so every one of the 17 call sites inherits it
// with no per-site code.
//
// Coercion is idempotent (a clean number passes through untouched), so a path
// that already validated loses nothing by being validated again.

import {
  resolveCanonicalMetric,
  validateCanonicalValue,
} from "../shared/wellness-canon";

export interface TrackerFieldish {
  name: string;
  type?: string;
  unit?: string | null;
}

/** Identity of the tracker being written to, so the guard can tell WHICH
 *  metric a bare `value` field is carrying. Optional: a caller that doesn't
 *  know keeps the old field-name-only behaviour. */
export interface TrackerContext {
  name?: string | null;
  category?: string | null;
  unit?: string | null;
}

export interface GuardResult {
  values: Record<string, any>;
  /** Human-readable rejection. Set ⇒ the entry must not be written. */
  error?: string;
}

/** Fields that can never be negative. Temperature, elevation, P/L can. */
const NON_NEGATIVE = new Set([
  "calories", "weight", "distance", "duration", "steps", "heartRate", "bpm",
  "systolic", "diastolic",
]);

const NUMERIC_TYPES = new Set(["number", "integer", "decimal"]);

// Keys that are numeric by nature whatever the tracker declares. An entry
// may carry keys the tracker's field list doesn't name (AI lanes, legacy
// shapes); without this, `{ weight: "abc" }` stored happily on a tracker
// whose declared field is `value`, and every chart that read it crashed.
const KNOWN_NUMERIC_KEYS = new Set([
  "weight", "calories", "caloriesBurned", "distance", "steps", "heartRate", "bpm", "pulse",
  "systolic", "diastolic", "sbp", "dbp", "hours", "glucose", "temperature", "reps", "sets",
]);
const META_KEYS = new Set(["_notes", "notes", "timestamp"]);

/**
 * Coerce and sanity-check one entry's values against its tracker's fields.
 * Returns the (possibly coerced) values, or an `error` that names the first
 * impossible value. Never throws.
 */
export function sanitizeTrackerEntryValues(
  fields: ReadonlyArray<TrackerFieldish> | null | undefined,
  rawValues: Record<string, any> | null | undefined,
  tracker?: TrackerContext | null,
): GuardResult {
  const values: Record<string, any> = { ...(rawValues || {}) };

  // ── Numeric coercion for numeric-typed fields ────────────────────────────
  // "Chicken Sandwich" in a numeric field used to store as a string and crash
  // every chart that called toFixed() on it.
  const numericFieldNames = new Set(
    (fields || [])
      .filter((f) => f && NUMERIC_TYPES.has(String(f.type)))
      .map((f) => f.name),
  );
  for (const k of Object.keys(values)) {
    if (META_KEYS.has(k) || k.startsWith("_")) continue;
    if (!numericFieldNames.has(k) && !KNOWN_NUMERIC_KEYS.has(k)) continue;
    const raw = values[k];
    if (raw == null || raw === "") continue;
    if (typeof raw === "number") {
      if (!isFinite(raw)) return { values, error: `"${k}" must be a number (got ${raw}).` };
      continue;
    }
    const s = String(raw).trim();
    const stripped = s.replace(/[$,\s]/g, "").replace(/[a-zA-Z\/%]+$/g, "");
    const n = parseFloat(stripped);
    if (!isFinite(n) || stripped === "" || !/\d/.test(stripped)) {
      return { values, error: `"${k}" expects a number. Received "${s}" — use a numeric value (e.g. 12.5).` };
    }
    values[k] = n;
  }

  // ── Reject an entry whose every meaningful value is empty ────────────────
  const meaningful = Object.keys(values).filter((k) => !META_KEYS.has(k) && !k.startsWith("_"));
  const hasValue = meaningful.some((k) => {
    const v = values[k];
    return v !== null && v !== undefined && v !== "" && !(typeof v === "number" && isNaN(v));
  });
  if (meaningful.length > 0 && !hasValue) {
    return { values, error: "At least one value is required. Cannot log an empty entry." };
  }
  // No keys at all on a tracker that HAS fields is the same empty entry: the
  // POST route accepted `{ values: {} }` and stored a row with nothing in it.
  // (A field-less occurrence tracker — "Meditation", logged by the tap — keeps
  // logging `{}`; the row itself is the record there.)
  if (meaningful.length === 0 && Array.isArray(fields) && fields.length > 0) {
    return { values, error: "At least one value is required. Cannot log an empty entry." };
  }

  // ── NaN / negatives ──────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== "number") continue;
    if (isNaN(v)) return { values, error: "All values must be valid numbers" };
    if (v < 0 && NON_NEGATIVE.has(k)) return { values, error: `${k} cannot be negative` };
  }

  // ── Sanity bounds — reject obviously impossible values ───────────────────
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== "number" || k.startsWith("_")) continue;
    if (k === "weight" && v > 1000) return { values, error: `Weight ${v} lbs is unrealistic. Max: 1000 lbs.` };
    if ((k === "systolic" || k === "sbp") && v > 300) return { values, error: `Systolic ${v} is unrealistic. Max: 300.` };
    if ((k === "diastolic" || k === "dbp") && v > 200) return { values, error: `Diastolic ${v} is unrealistic. Max: 200.` };
    if ((k === "heartRate" || k === "bpm" || k === "pulse") && v > 250) return { values, error: `Heart rate ${v} is unrealistic. Max: 250.` };
    if (k === "hours" && v > 24) return { values, error: `Sleep ${v} hours is impossible. Max: 24.` };
    if (k === "calories" && v > 20000) return { values, error: `${v} calories is unrealistic. Max: 20,000.` };
    if (v > 100000) return { values, error: `Value ${v} for "${k}" exceeds maximum (100,000).` };
  }

  // ── Canonical metric bounds ──────────────────────────────────────────────
  // The rules above bound a value by the name of the FIELD it landed in, which
  // says nothing about a lab tracker whose only field is called "value": that
  // is how "HbA1c 179 %" and "HDL 170 mg/dL" were stored. Resolve what the
  // tracker actually measures and bound the number against THAT metric's
  // physically possible range (shared/wellness-canon.ts — the same table the
  // Wellness tab reads with).
  //
  // Requires the tracker's identity: a bare field called "temperature" says
  // nothing about whether it is a fever or a fridge, so a caller that doesn't
  // know which tracker it is writing to keeps the field-name rules above and
  // nothing more.
  // A DOSE is not a blood level. A supplement tracker named "Vitamin D"
  // resolves to the vitamin-D lab metric (1–200 ng/mL), so "2000 IU" —
  // an ordinary daily dose — was refused as "outside the possible range".
  // A medication/supplement tracker, or a dose-shaped field, is bounded by the
  // field-name rules above only.
  const doseTracker = /^(medication|medications|supplement|supplements|meds?)$/i.test(String(tracker?.category || "").trim());
  const DOSE_KEY = /^(dosage|dose|doses|units?|iu|mg|mcg|ml|pills?|tablets?|capsules?|drops?|puffs?|completions|taken|servings?)$/i;
  for (const [k, v] of Object.entries(values)) {
    if (!tracker?.name && !tracker?.category) break;
    if (typeof v !== "number" || META_KEYS.has(k) || k.startsWith("_")) continue;
    if (doseTracker || DOSE_KEY.test(k)) continue;
    const metric = resolveCanonicalMetric(tracker?.name, tracker?.category, k);
    if (!metric) continue;
    const unit =
      (fields || []).find((f) => f && f.name === k)?.unit || tracker?.unit || "";
    const check = validateCanonicalValue(metric, v, unit);
    if (!check.ok) return { values, error: check.error };
  }

  return { values };
}
