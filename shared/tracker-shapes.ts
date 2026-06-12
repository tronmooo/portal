// shared/tracker-shapes.ts
// =============================================================================
// Tracker shape inference — heal misconfigured trackers at read time.
// =============================================================================
//
// Many trackers in the wild were created with a single bare "value" field and
// no unit (or a wrong unit like "min" on a Bench Press tracker). When that
// happens, the dashboard and profile pages can only show bare numbers — the
// user has no idea whether 200 means pounds, reps, or minutes.
//
// This module looks at the tracker's NAME (and optionally category) and returns
// a canonical field shape that makes physical sense — e.g. "Bench Press" gets
// (weight lbs, reps, sets, rpe); "Running" gets (distance mi, duration min,
// pace min/mi); "Calories" gets (calories kcal, protein g, carbs g, fat g).
//
// The shape is applied non-destructively as `effectiveFields` at read time.
// Existing entries are NOT rewritten — they keep their original `values` —
// but the renderer can now label them correctly (the most common single-value
// log gets attributed to the primary field of the inferred shape).
// =============================================================================

import type { TrackerField } from "./schema";

export interface TrackerShape {
  /** Stable id of the shape, e.g. "bench_press", "running", "nutrition". */
  id: string;
  /** Field schema in display order. First entry is treated as the primary. */
  fields: Required<Pick<TrackerField, "name" | "type">> &
    Pick<TrackerField, "unit" | "options" | "isPrimary"> &
    { name: string; type: TrackerField["type"]; unit?: string; isPrimary?: boolean; options?: string[] };
}

// =============================================================================
// Canonical shapes — keep these tight. Each shape is a real-world activity or
// measurement with units that make physical sense. When in doubt, leave the
// tracker alone (returning null) rather than guessing.
// =============================================================================

const LIFT_SHAPE: TrackerField[] = [
  { name: "weight", type: "number", unit: "lbs", isPrimary: true },
  { name: "reps",   type: "number", unit: "reps" },
  { name: "sets",   type: "number", unit: "sets" },
  { name: "rpe",    type: "number", unit: "/10" },
];

const RUN_SHAPE: TrackerField[] = [
  { name: "distance", type: "number", unit: "mi", isPrimary: true },
  { name: "duration", type: "number", unit: "min" },
  { name: "pace",     type: "number", unit: "min/mi" },
  { name: "heart_rate", type: "number", unit: "bpm" },
];

const RIDE_SHAPE: TrackerField[] = [
  { name: "distance", type: "number", unit: "mi", isPrimary: true },
  { name: "duration", type: "number", unit: "min" },
  { name: "elevation", type: "number", unit: "ft" },
  { name: "avg_speed", type: "number", unit: "mph" },
];

const SWIM_SHAPE: TrackerField[] = [
  { name: "distance", type: "number", unit: "yd", isPrimary: true },
  { name: "duration", type: "number", unit: "min" },
  { name: "laps",     type: "number", unit: "laps" },
];

const NUTRITION_SHAPE: TrackerField[] = [
  { name: "calories", type: "number", unit: "kcal", isPrimary: true },
  { name: "protein",  type: "number", unit: "g" },
  { name: "carbs",    type: "number", unit: "g" },
  { name: "fat",      type: "number", unit: "g" },
  { name: "fiber",    type: "number", unit: "g" },
  { name: "meal",     type: "text"   },
];

const HYDRATION_SHAPE: TrackerField[] = [
  { name: "amount", type: "number", unit: "oz", isPrimary: true },
];

const WEIGHT_SHAPE: TrackerField[] = [
  { name: "weight", type: "number", unit: "lbs", isPrimary: true },
];

const BODY_FAT_SHAPE: TrackerField[] = [
  { name: "body_fat", type: "number", unit: "%", isPrimary: true },
];

const SLEEP_SHAPE: TrackerField[] = [
  { name: "duration", type: "number", unit: "hr", isPrimary: true },
  { name: "quality",  type: "select", options: ["poor", "fair", "good", "excellent"] },
  { name: "bedtime",  type: "text" },
  { name: "wake_time", type: "text" },
];

const STEPS_SHAPE: TrackerField[] = [
  { name: "steps", type: "number", unit: "steps", isPrimary: true },
];

const BP_SHAPE: TrackerField[] = [
  { name: "systolic",  type: "number", unit: "mmHg", isPrimary: true },
  { name: "diastolic", type: "number", unit: "mmHg" },
  { name: "pulse",     type: "number", unit: "bpm" },
];

const HEART_RATE_SHAPE: TrackerField[] = [
  { name: "heart_rate", type: "number", unit: "bpm", isPrimary: true },
];

const MOOD_SHAPE: TrackerField[] = [
  { name: "mood",  type: "select", options: ["awful", "bad", "ok", "good", "great"], isPrimary: true },
  { name: "energy", type: "number", unit: "/10" },
  { name: "notes", type: "text" },
];

const MEDITATION_SHAPE: TrackerField[] = [
  { name: "duration", type: "number", unit: "min", isPrimary: true },
  { name: "type",     type: "text" },
];

const STRETCH_SHAPE: TrackerField[] = [
  { name: "duration", type: "number", unit: "min", isPrimary: true },
  { name: "focus",    type: "text" },
];

const PUSHUP_SHAPE: TrackerField[] = [
  { name: "reps", type: "number", unit: "reps", isPrimary: true },
  { name: "sets", type: "number", unit: "sets" },
];

const PLANK_SHAPE: TrackerField[] = [
  { name: "duration", type: "number", unit: "sec", isPrimary: true },
  { name: "sets",     type: "number", unit: "sets" },
];

const MILEAGE_SHAPE: TrackerField[] = [
  { name: "miles", type: "number", unit: "mi", isPrimary: true },
];

const EXPENSE_SHAPE: TrackerField[] = [
  { name: "amount",   type: "number", unit: "$", isPrimary: true },
  { name: "category", type: "text" },
  { name: "merchant", type: "text" },
];

// =============================================================================
// PATTERN → SHAPE table. Each pattern is a substring (case-insensitive) tested
// against the tracker name. First match wins, so list specific patterns before
// generic ones. Category is used as a tiebreaker for generic names like
// "lifting" that could mean weight or step-count depending on the user's intent.
// =============================================================================

interface ShapeEntry {
  id: string;
  fields: TrackerField[];
  /** Name patterns (lowercased, substring match). */
  patterns: string[];
  /** Optional category constraint for tiebreaking. */
  category?: string;
}

const CATALOG: ShapeEntry[] = [
  // --- Specific lifts ------------------------------------------------------
  { id: "bench_press",  fields: LIFT_SHAPE, patterns: ["bench press", "bench-press", "bench"] },
  { id: "squat",        fields: LIFT_SHAPE, patterns: ["squat"] },
  { id: "deadlift",     fields: LIFT_SHAPE, patterns: ["deadlift"] },
  { id: "overhead",     fields: LIFT_SHAPE, patterns: ["overhead press", "shoulder press", "ohp"] },
  { id: "row",          fields: LIFT_SHAPE, patterns: ["barbell row", "bent over row", "pendlay row"] },
  { id: "curl",         fields: LIFT_SHAPE, patterns: ["bicep curl", "barbell curl", "dumbbell curl"] },
  // Generic "Lifting" / "Weights" — use the same lift shape.
  { id: "lifting",      fields: LIFT_SHAPE, patterns: ["lifting", "weight lifting", "weightlifting", "weights", "strength"] },
  // --- Bodyweight ----------------------------------------------------------
  { id: "pushup",       fields: PUSHUP_SHAPE, patterns: ["push-up", "pushup", "push up", "pull-up", "pullup", "pull up", "chin-up", "chinup", "chin up", "dip"] },
  { id: "plank",        fields: PLANK_SHAPE, patterns: ["plank"] },
  // --- Cardio --------------------------------------------------------------
  { id: "running",      fields: RUN_SHAPE, patterns: ["running", "run", "jog", "jogging", "treadmill"] },
  { id: "cycling",      fields: RIDE_SHAPE, patterns: ["cycling", "biking", "bike ride", "bicycle"] },
  { id: "swimming",     fields: SWIM_SHAPE, patterns: ["swimming", "swim"] },
  { id: "mileage",      fields: MILEAGE_SHAPE, patterns: ["mileage", "vehicle miles", "car miles"] },
  // --- Stretch / mind ------------------------------------------------------
  { id: "stretching",   fields: STRETCH_SHAPE, patterns: ["stretch", "stretching", "mobility", "yoga"] },
  { id: "meditation",   fields: MEDITATION_SHAPE, patterns: ["meditation", "meditate", "mindfulness", "breathwork"] },
  // --- Body --------------------------------------------------------------
  { id: "weight",       fields: WEIGHT_SHAPE, patterns: ["body weight", "bodyweight", "scale weight"], category: "weight" },
  // Bare "Weight" (without "lifting"/"press") — weight category only.
  { id: "weight_solo",  fields: WEIGHT_SHAPE, patterns: ["weight"], category: "weight" },
  { id: "body_fat",     fields: BODY_FAT_SHAPE, patterns: ["body fat", "bodyfat", "body-fat"] },
  // --- Sleep ---------------------------------------------------------------
  { id: "sleep",        fields: SLEEP_SHAPE, patterns: ["sleep", "rest", "shut-eye"] },
  // --- Steps / activity ----------------------------------------------------
  { id: "steps",        fields: STEPS_SHAPE, patterns: ["step count", "steps", "pedometer"] },
  // --- Vitals --------------------------------------------------------------
  { id: "blood_pressure", fields: BP_SHAPE, patterns: ["blood pressure", "bp", "systolic", "diastolic"] },
  { id: "heart_rate",   fields: HEART_RATE_SHAPE, patterns: ["heart rate", "resting heart", "rhr", "hr"] },
  // --- Nutrition -----------------------------------------------------------
  { id: "nutrition",    fields: NUTRITION_SHAPE, patterns: ["calorie", "calories", "kcal", "macros", "nutrition", "meal", "diet", "food log", "food"] },
  { id: "hydration",    fields: HYDRATION_SHAPE, patterns: ["water", "hydration", "fluid"] },
  // --- Mood ----------------------------------------------------------------
  { id: "mood",         fields: MOOD_SHAPE, patterns: ["mood", "feeling"] },
  // --- Finance -------------------------------------------------------------
  { id: "expense",      fields: EXPENSE_SHAPE, patterns: ["expense", "spending", "purchase"] },
];

/**
 * Look up the canonical shape for a tracker by name + optional category.
 *
 * Returns a deep-cloned field list (caller may mutate). Returns null when no
 * pattern matches — the caller should keep whatever fields the tracker has.
 */
export function inferTrackerShape(name: string, category?: string): TrackerField[] | null {
  const haystack = (name || "").toLowerCase().trim();
  if (!haystack) return null;
  const cat = (category || "").toLowerCase().trim();

  for (const entry of CATALOG) {
    if (entry.category && entry.category !== cat) continue;
    for (const pat of entry.patterns) {
      if (haystack.includes(pat)) {
        return entry.fields.map(f => ({ ...f }));
      }
    }
  }
  return null;
}

/**
 * Apply the canonical shape on top of whatever fields the tracker has.
 *
 * Rules:
 *  - If the tracker has no fields at all, use the inferred shape verbatim.
 *  - If the tracker has fields but none of them are numeric AND a shape is
 *    inferred, use the inferred shape (the existing fields are likely junk
 *    like a single "value" with unit "min" on a Bench Press tracker).
 *  - If the tracker has any numeric field, KEEP the user's fields and only
 *    inject missing canonical fields after them (preserves user intent).
 *  - If no shape matches, return the tracker's own fields unchanged.
 *
 * The returned list always carries an isPrimary somewhere — the first
 * field is promoted to primary if none was marked.
 */
export function effectiveTrackerFields(
  name: string,
  category: string | undefined,
  rawFields: TrackerField[] | undefined,
  rawUnit: string | undefined,
): TrackerField[] {
  const fields = Array.isArray(rawFields) ? rawFields.filter(Boolean) : [];
  const inferred = inferTrackerShape(name, category);

  // Case 1: no explicit fields. Use inferred when available, otherwise a
  // single-value placeholder so the renderer has something to label.
  if (fields.length === 0) {
    if (inferred) return ensurePrimary(inferred);
    return ensurePrimary([{ name: "value", type: "number", unit: rawUnit || "", isPrimary: true }]);
  }

  // Case 2: explicit fields exist but none are numeric. The shape was
  // probably wrong (e.g. a single text field) — replace with inferred.
  const hasNumeric = fields.some(f => f.type === "number" || f.type === "duration");
  if (!hasNumeric && inferred) return ensurePrimary(inferred);

  // Case 3: explicit numeric fields exist. Trust the user; inject any
  // canonical fields that are missing AFTER the existing ones so the user
  // sees the extra context if they care to log it. Preserve user units.
  if (inferred) {
    const existingNames = new Set(fields.map(f => f.name.toLowerCase()));
    const augmented = [...fields];
    for (const inf of inferred) {
      if (!existingNames.has(inf.name.toLowerCase())) augmented.push({ ...inf, isPrimary: false });
    }
    // Special case: if the user's only numeric field has a clearly wrong unit
    // (e.g. "min" on a Bench Press tracker) AND the inferred primary unit is
    // different, override the unit on that field so the headline reads right.
    if (inferred[0] && augmented[0] && augmented[0].name === fields[0].name) {
      const userUnit = (augmented[0].unit || rawUnit || "").toLowerCase();
      const inferredUnit = (inferred[0].unit || "").toLowerCase();
      const looksWrong = userUnit && inferredUnit && userUnit !== inferredUnit &&
        // Only override common obviously-wrong unit collisions, not exotic ones.
        ["min", "sec", "minutes", "seconds"].includes(userUnit) &&
        !["min", "sec", "minutes", "seconds", "min/mi", "min/km"].includes(inferredUnit);
      if (looksWrong) {
        augmented[0] = { ...augmented[0], unit: inferred[0].unit };
      }
    }
    return ensurePrimary(augmented);
  }

  return ensurePrimary(fields);
}

function ensurePrimary(fields: TrackerField[]): TrackerField[] {
  if (fields.length === 0) return fields;
  if (fields.some(f => f.isPrimary)) return fields;
  return fields.map((f, i) => (i === 0 ? { ...f, isPrimary: true } : f));
}

/**
 * Resolve the unit to display in the headline for a tracker. Uses the
 * effective primary field's unit when present, then the tracker's own
 * unit, then empty string.
 */
export function effectiveTrackerUnit(
  effective: TrackerField[],
  rawUnit: string | undefined,
): string {
  const primary = effective.find(f => f.isPrimary) || effective[0];
  return primary?.unit || rawUnit || "";
}
