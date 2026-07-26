// shared/field-aliases.ts
// =============================================================================
// Source-key → canonical-field aliases. ONE table, shared by every writer.
// =============================================================================
//
// LHS = the key an AI / document extractor supplied (lowercased), RHS = the
// canonical field name we try to find on the tracker. If the tracker has a
// field with that name the incoming key is renamed; otherwise the key is left
// alone (the caller surfaces unknown fields).
//
// This lives in shared/ because TWO decisions must agree: the normalizer that
// renames an incoming key, and the tracker-creation path that decides which
// fields a brand-new tracker gets. When they disagreed, a lift logged as
// `weightLbs` created a unit-less `weightLbs` COLUMN on the new tracker and the
// entry card read "45 weightLbs" instead of "45 lbs" (user screenshot
// 2026-07-26).
// =============================================================================

export const FIELD_ALIASES: Record<string, string> = {
  // generic
  steps: "value", count: "value", amount: "value", total: "value",
  score: "value", reading: "value", number: "value",
  // duration
  time: "duration", minutes: "duration", hours: "duration", length: "duration",
  // distance
  miles: "distance", km: "distance", kilometers: "distance",
  meters: "distance", mi: "distance",
  // weight — including the unit-suffixed keys models like to emit for lifts.
  // Without these, "45 weightLbs" persisted as its own stray field and the card
  // read "45 weightLbs" instead of "45 lbs" (user screenshot 2026-07-26).
  // NOTE: kg-suffixed keys are deliberately absent — a bare number under
  // `weightKg` would be relabeled as lbs with no conversion.
  lbs: "weight", lb: "weight", pounds: "weight",
  weightlbs: "weight", weight_lbs: "weight", weightpounds: "weight",
  weightused: "weight", weight_used: "weight",
  kg: "weight", kilograms: "weight", mass: "weight",
  // strength sets/reps — every spelling a model reaches for
  repetitions: "reps", rep: "reps", repcount: "reps", rep_count: "reps",
  numreps: "reps", repsperset: "reps", reps_per_set: "reps",
  set: "sets", setcount: "sets", set_count: "sets", numsets: "sets",
  totalsets: "sets",
  // effort / duration variants
  durationmin: "duration", duration_min: "duration", durationminutes: "duration",
  mins: "duration", timespent: "duration", time_spent: "duration",
  effort: "intensity",
  caloriesburned: "caloriesBurned", calories_burned: "caloriesBurned",
  caloriesburnt: "caloriesBurned", kcal: "calories",
  heartrate: "heart_rate", avghr: "heart_rate", averageheartrate: "heart_rate",
  // temperature
  temp: "temperature", temperature: "temperature",
  // blood pressure
  sys: "systolic", dia: "diastolic",
  // heart rate
  bpm: "heart_rate", hr: "heart_rate", pulse: "heart_rate",
  // sleep
  sleep: "hours", "sleep_hours": "hours",
};

/** Canonical name a source key would normalize to (itself when unaliased). */
export function canonicalFieldKey(sourceKey: string): string {
  const lc = String(sourceKey || "").toLowerCase();
  return FIELD_ALIASES[lc] || lc;
}
