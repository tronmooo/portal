// ─── Tracker entry normalization ────────────────────────────────────
// Every code path that writes a tracker entry — chat (ai-engine
// log_tracker_entry case), document extraction confirm
// (routes /api/extraction-confirm), and any future ingestor — must
// produce the same shape:
//   - field names mapped to the tracker's actual fields
//   - numeric values parsed (strip unit suffix like "99°F" → 99)
//   - values converted to the tracker's canonical unit
//
// Without this, an AI logging "temperature: 99" from chat and a
// document extractor logging "value: 98.4 °F" produce two records
// the UI can't display side-by-side. This module makes them match.

import type { Tracker, TrackerField } from "../shared/schema";

// ── Aliases that map AI/document-supplied field names → tracker fields ──
// LHS = source key (lowercased), RHS = canonical field name we'll try
// to find on the tracker. If the tracker has a field with that name we
// rename the incoming key; otherwise we leave the key as-is (the parent
// flow surfaces unknown fields to the user).
const FIELD_ALIASES: Record<string, string> = {
  // generic
  steps: "value", count: "value", amount: "value", total: "value",
  score: "value", reading: "value", number: "value",
  // duration
  time: "duration", minutes: "duration", hours: "duration", length: "duration",
  // distance
  miles: "distance", km: "distance", kilometers: "distance",
  meters: "distance", mi: "distance",
  // weight
  lbs: "weight", lb: "weight", pounds: "weight",
  kg: "weight", kilograms: "weight", mass: "weight",
  // temperature
  temp: "temperature", temperature: "temperature",
  // blood pressure
  sys: "systolic", dia: "diastolic",
  // heart rate
  bpm: "heart_rate", hr: "heart_rate", pulse: "heart_rate",
  // sleep
  sleep: "hours", "sleep_hours": "hours",
};

// ── Unit detection / conversion ─────────────────────────────────────

// Strip unit suffix from a string value: "99°F" → 99, "180 lbs" → 180,
// "5.2 km" → 5.2. Returns the numeric value AND the detected unit so
// the caller can convert.
function parseNumericWithUnit(raw: any): { value: number; unit: string | null } | null {
  if (raw == null) return null;
  if (typeof raw === "number" && isFinite(raw)) return { value: raw, unit: null };
  if (typeof raw !== "string") return null;

  const s = raw.trim();
  if (!s) return null;

  // Match leading number (with optional sign / decimal) followed by an
  // optional unit. Allow common units, °C, °F, %, etc.
  const m = s.match(/^([-+]?\d+(?:\.\d+)?)\s*([a-zA-Z°%]+)?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!isFinite(value)) return null;
  const unit = (m[2] || "").trim() || null;
  return { value, unit };
}

// Normalize unit strings to a small set of canonical tags so conversion
// math is straightforward.
function canonUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  const lc = u.toLowerCase().replace(/[°\s]/g, "");
  if (lc === "f" || lc === "fahrenheit") return "F";
  if (lc === "c" || lc === "celsius") return "C";
  if (lc === "kg" || lc === "kilogram" || lc === "kilograms") return "kg";
  if (lc === "lb" || lc === "lbs" || lc === "pound" || lc === "pounds") return "lb";
  if (lc === "km" || lc === "kilometer" || lc === "kilometers") return "km";
  if (lc === "mi" || lc === "mile" || lc === "miles") return "mi";
  if (lc === "m" || lc === "meter" || lc === "meters") return "m";
  if (lc === "ft" || lc === "feet" || lc === "foot") return "ft";
  if (lc === "%" || lc === "percent" || lc === "percentage") return "%";
  if (lc === "bpm") return "bpm";
  if (lc === "mmhg") return "mmHg";
  return u; // unknown — leave as-is
}

// Convert a numeric value between units. Returns null if no conversion
// is possible (different dimensions, unknown unit).
function convertUnit(value: number, fromUnit: string | null, toUnit: string | null): number | null {
  const a = canonUnit(fromUnit);
  const b = canonUnit(toUnit);
  if (!a || !b || a === b) return value; // same unit or unknown → pass through

  // Temperature
  if (a === "F" && b === "C") return ((value - 32) * 5) / 9;
  if (a === "C" && b === "F") return (value * 9) / 5 + 32;

  // Mass
  if (a === "kg" && b === "lb") return value * 2.2046226218;
  if (a === "lb" && b === "kg") return value / 2.2046226218;

  // Distance
  if (a === "km" && b === "mi") return value / 1.609344;
  if (a === "mi" && b === "km") return value * 1.609344;
  if (a === "m" && b === "ft") return value * 3.280839895;
  if (a === "ft" && b === "m") return value / 3.280839895;
  if (a === "km" && b === "m") return value * 1000;
  if (a === "m" && b === "km") return value / 1000;

  return null; // incompatible dimensions
}

// ── Tracker primary field resolution ────────────────────────────────
// The "primary" field is what charts/cards display. Prefer
// field.isPrimary===true, fall back to the first numeric field, fall
// back to the first field.
function findPrimaryFieldName(tracker: Pick<Tracker, "fields" | "category" | "name">): string | null {
  const fields = tracker.fields || [];
  if (fields.length === 0) return null;
  const primary = fields.find(f => (f as any).isPrimary === true);
  if (primary) return primary.name;
  const numeric = fields.find(f => f.type === "number");
  if (numeric) return numeric.name;
  return fields[0].name;
}

// Resolve a source key (e.g. "temperature", "Temp", "STEPS") to the
// tracker's actual field name. Strategy:
//   1. Exact case-insensitive match against tracker fields → use that
//   2. Alias match (FIELD_ALIASES) → if alias target exists, use it
//   3. Fallback: if there's exactly one numeric/primary field AND the value
//      is itself numeric, map to it
//   4. Otherwise: leave the original key untouched (caller may warn)
function resolveFieldName(
  sourceKey: string,
  tracker: Pick<Tracker, "fields" | "category" | "name">,
  rawValue?: any
): string {
  const fields = tracker.fields || [];
  const lc = sourceKey.toLowerCase();

  // 1. Exact case-insensitive match
  for (const f of fields) {
    if (String(f.name).toLowerCase() === lc) return f.name;
  }

  // 2. Alias lookup
  const aliasTarget = FIELD_ALIASES[lc];
  if (aliasTarget) {
    for (const f of fields) {
      if (String(f.name).toLowerCase() === aliasTarget) return f.name;
    }
  }

  // 3. Single-field tracker: if there's only one numeric field, the user
  // probably meant that one (Body Temperature tracker has one field "value";
  // AI says "temperature: 99" → map to "value"). BUT only when the incoming
  // value is actually numeric — otherwise a stray field like
  // wakeTime:"5:30 AM" would clobber a Sleep tracker's "hours" field with a
  // time string. Non-numeric strays keep their own key (preserved as a
  // secondary field) instead of corrupting the headline metric.
  const numericFields = fields.filter(f => f.type === "number");
  if (numericFields.length === 1 && parseNumericWithUnit(rawValue) !== null) {
    return numericFields[0].name;
  }

  // 4. Bail out
  return sourceKey;
}

// Parse a clock time ("11:00 PM", "5:30 AM", "23:00", "5 AM", "7") into
// minutes-since-midnight, or null if it isn't a time. Used to turn a sleep
// bedtime/waketime pair into a duration.
export function parseClockTime(raw: any): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && isFinite(raw)) {
    // bare hour like 23 or 5 — only meaningful as a 24h hour
    if (raw >= 0 && raw <= 24) return Math.round(raw * 60) % 1440;
    return null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (h > 23 || min > 59) return null;
  if (mer === "am") { if (h === 12) h = 0; }
  else if (mer === "pm") { if (h !== 12) h += 12; }
  return (h * 60 + min) % 1440;
}

// Field-name candidates for a sleep session's start and end.
const BEDTIME_KEYS = ["bedtime", "bedtime ", "sleepstart", "start", "starttime", "sleepat", "wentToBed".toLowerCase(), "tobed", "asleep"];
const WAKETIME_KEYS = ["waketime", "wakeuptime", "wakeup", "wake", "end", "endtime", "awake", "gotup"];

// Is this tracker a sleep tracker whose headline should be hours slept?
function isSleepTracker(tracker: Pick<Tracker, "fields" | "category" | "name">): boolean {
  const n = String(tracker.name || "").toLowerCase();
  const c = String((tracker as any).category || "").toLowerCase();
  if (n.includes("sleep") || c.includes("sleep")) return true;
  return false;
}

// ── Main normalizer ─────────────────────────────────────────────────
// Takes raw {field: value} from chat or doc extraction and returns
// {field: value} aligned with the tracker's schema and unit.
//
//  - Field names: remapped via resolveFieldName (alias / exact / single-numeric)
//  - Values:     numeric strings have unit suffix stripped
//  - Units:      converted to tracker.unit (or matching field.unit) if both known
//  - _notes:     passed through untouched
//
// Returns a NEW object; never mutates input.
export function normalizeTrackerEntry(
  tracker: Pick<Tracker, "fields" | "category" | "name" | "unit">,
  rawValues: Record<string, any>
): { values: Record<string, any>; warnings: string[] } {
  const out: Record<string, any> = {};
  const warnings: string[] = [];
  const trackerUnit = (tracker as any).unit as string | undefined;

  for (const [k, v] of Object.entries(rawValues || {})) {
    if (k === "_notes") { out._notes = v; continue; }

    // Resolve field name (value-aware: a non-numeric stray never gets mapped
    // onto a lone numeric field)
    const canonicalKey = resolveFieldName(k, tracker, v);
    if (canonicalKey !== k) {
      warnings.push(`Renamed field "${k}" → "${canonicalKey}"`);
    }

    // Find the field on the tracker to learn its unit (if any)
    const fieldDef = (tracker.fields || []).find(
      f => String(f.name).toLowerCase() === canonicalKey.toLowerCase()
    );
    const fieldUnit = fieldDef?.unit;

    // Parse numeric + unit suffix
    const parsed = parseNumericWithUnit(v);
    if (parsed) {
      const { value, unit: sourceUnit } = parsed;
      // Target unit: prefer field-level unit, fall back to tracker-level
      const targetUnit = fieldUnit || trackerUnit || null;
      if (sourceUnit && targetUnit && canonUnit(sourceUnit) !== canonUnit(targetUnit)) {
        const converted = convertUnit(value, sourceUnit, targetUnit);
        if (converted != null) {
          // round to 2 decimals — temperature/weight don't need more
          out[canonicalKey] = Math.round(converted * 100) / 100;
          warnings.push(`Converted ${value} ${sourceUnit} → ${out[canonicalKey]} ${targetUnit}`);
          continue;
        }
      }
      // No conversion needed (or impossible): store the parsed number
      out[canonicalKey] = value;
      continue;
    }

    // Non-numeric: pass through as-is
    out[canonicalKey] = v;
  }

  // ── Sleep duration synthesis ───────────────────────────────────────
  // "I slept from 11 PM to 5:30 AM" arrives as bedtime/waketime strings with
  // NO numeric hours. Compute the duration so the headline reads "6.5 hr"
  // instead of dumping the wake-time string into the hours field. Also fixes
  // the case where a non-numeric time leaked into the primary field.
  if (isSleepTracker(tracker)) {
    const primaryName = findPrimaryFieldName(tracker);
    const lcOut: Record<string, { key: string; val: any }> = {};
    for (const [k, v] of Object.entries(out)) lcOut[k.toLowerCase()] = { key: k, val: v };
    const findVal = (cands: string[]) => { for (const c of cands) if (lcOut[c]) return lcOut[c].val; return undefined; };

    const primaryVal = primaryName ? out[primaryName] : undefined;
    const primaryIsNumber = typeof primaryVal === "number" && isFinite(primaryVal);

    if (primaryName && !primaryIsNumber) {
      const bed = parseClockTime(findVal(BEDTIME_KEYS));
      const wake = parseClockTime(findVal(WAKETIME_KEYS));
      if (bed != null && wake != null) {
        const hrs = Math.round((((wake - bed + 1440) % 1440) / 60) * 100) / 100;
        if (hrs > 0) {
          // If a time string had been mis-routed into the primary field, drop it.
          if (typeof primaryVal === "string" && parseClockTime(primaryVal) != null) delete out[primaryName];
          out[primaryName] = hrs;
          warnings.push(`Computed sleep duration ${hrs} hr from bedtime/wake time`);
        }
      } else if (typeof primaryVal === "string" && parseClockTime(primaryVal) != null) {
        // A lone time string sitting in the hours field with no pair to
        // compute from — move it to wakeTime so the headline isn't a clock.
        if (out.wakeTime == null && out.waketime == null) out.wakeTime = primaryVal;
        delete out[primaryName];
        warnings.push(`Moved stray time "${primaryVal}" out of the ${primaryName} field`);
      }
    }
  }

  return { values: out, warnings };
}

// Re-export for callers that want the helper directly
export { findPrimaryFieldName, parseNumericWithUnit, convertUnit, canonUnit };
