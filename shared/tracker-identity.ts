// shared/tracker-identity.ts
// =============================================================================
// Canonical tracker identity & matching — ONE source of truth for the question
// "do these two tracker names refer to the same thing?".
// =============================================================================
//
// Trackers were being duplicated whenever the same subject arrived with
// different wording: a pre-existing "Multivitamin" tracker plus a new
// "Supplement Multivitamin" / "Daily Multivitamin" because the engine only did
// exact/substring name matching. This module reduces a name to a stable
// IDENTITY KEY by stripping noise words (supplement, daily, my, pills, …) and
// punctuation, so all of those collapse to the same key and match.
//
// Pure + unit-tested. Used by the AI engine for BOTH log_tracker_entry tracker
// resolution and create_tracker dedup, so the two never disagree.
// =============================================================================

import { isStrengthShaped } from "./strength-entry";

// Words that carry no identity. "Daily Multivitamin", "Multivitamin Supplement"
// and "Multivitamin" are the SAME tracker. Note these only strip as WHOLE
// tokens, never substrings — "Multivitamin" is one token and survives, while
// "Vitamin D" keeps the disambiguating "d".
const NOISE_WORDS = new Set([
  "supplement", "supplements", "supp", "supps",
  "daily", "morning", "evening", "nightly", "my", "the", "a", "an", "of",
  "tracker", "log", "logger", "intake", "tracking",
  "pill", "pills", "tablet", "tablets", "capsule", "capsules",
  "softgel", "softgels", "gummy", "gummies", "dose", "doses", "dosage",
  "med", "meds", "medication", "medications", "prescription", "rx",
]);

/**
 * Reduce a tracker name to a stable identity key.
 *  - lowercased, punctuation → spaces
 *  - trailing auto-number "(2)" removed
 *  - noise words removed (whole-token only)
 *  - remaining tokens joined with no separator
 *
 * "Multivitamin"            → "multivitamin"
 * "Supplement Multivitamin" → "multivitamin"
 * "Daily Multivitamin"      → "multivitamin"
 * "Fish Oil"                → "fishoil"
 * "Fish Oil Supplement"     → "fishoil"
 * "Vitamin D"               → "vitamind"   (distinct from "Vitamin C" → "vitaminc")
 * "Supplements"             → "supplements" (all-noise → de-noised fallback)
 */
export function trackerIdentityKey(name: string | null | undefined): string {
  const raw = String(name ?? "").toLowerCase();
  const noNum = raw.replace(/\s*\(\d+\)\s*$/, " ");
  const tokens = noNum
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = tokens.filter((t) => !NOISE_WORDS.has(t));
  const key = meaningful.join("");
  // If every token was noise (e.g. literally "Supplements" or "My Meds"),
  // fall back to the de-noised full string so the name still has a stable key.
  return key || tokens.join("");
}

// ── Domain guards ───────────────────────────────────────────────────────────
// Containment ("one name contains the other") is right for supplements — the
// bug this module was built for — but WRONG for two other families, and both
// misfired in production (user report 2026-08-02):
//
//   • BODY WEIGHT vs EXERCISE. "Weight" is contained in "Weight Lifting" and in
//     "Weighted Pull-Ups", so a workout matched the body-weight tracker and was
//     logged into it: a 45-minute lifting session became a row in the tracker
//     that plots what the scale said, permanently adding sets/reps/duration
//     fields to it. Body weight is a MEASUREMENT of the person; a workout is an
//     ACTIVITY. They are never the same tracker.
//
//   • VARIANTS OF A LIFT. "Bench Press" is contained in "Incline Bench Press"
//     and "Dumbbell Bench Press" — but those are DIFFERENT exercises with
//     different loads, and each deserves its own tracker and its own history.
//     A qualifier like incline / dumbbell / close-grip changes the exercise;
//     a noise word like "morning" does not (and is already stripped from the
//     identity key, so "Morning Bench Press" still matches "Bench Press").

/** Names that mean "what the scale says", and nothing else. */
const BODY_WEIGHT_KEYS = new Set(["weight", "bodyweight", "scaleweight", "bodyweightlbs", "weightlbs", "myweight"]);

/** Is this the body-weight tracker (a measurement), not an activity? */
export function isBodyWeightName(name: string | null | undefined): boolean {
  return BODY_WEIGHT_KEYS.has(trackerIdentityKey(name));
}

/**
 * Words that make a lift a DIFFERENT lift. Equipment, angle, grip, stance,
 * limb, and the muscle worked all change the movement — "Incline Dumbbell
 * Press" is not "Bench Press". Deliberately does NOT include time-of-day or
 * ownership words ("morning", a person's name), so those still collapse.
 */
const EXERCISE_QUALIFIERS = new Set([
  // equipment
  "dumbbell", "dumbell", "db", "barbell", "bb", "cable", "machine", "smith", "kettlebell", "band", "banded",
  "ez", "rope", "bar", "trapbar", "hex", "landmine", "plate", "bodyweight", "weighted", "assisted",
  // angle / stance / position
  "incline", "decline", "flat", "seated", "standing", "kneeling", "lying", "prone", "supine",
  "bent", "upright", "split", "bulgarian", "sumo", "romanian", "rdl", "deficit", "pause", "paused",
  "hack", "front", "back", "overhead", "behind", "neck", "box", "floor",
  // grip
  "close", "wide", "narrow", "grip", "reverse", "neutral", "underhand", "overhand", "hammer",
  "preacher", "concentration", "spider", "pendlay", "pistol",
  // limb / side
  "single", "one", "unilateral", "alternating", "arm", "leg", "lateral", "rear", "side",
  // muscle / region — what makes "Shoulder Press" ≠ "Leg Press" ≠ "Chest Press"
  "shoulder", "chest", "leg", "legs", "calf", "calves", "tricep", "triceps", "bicep", "biceps",
  "lat", "lats", "delt", "delts", "glute", "glutes", "hamstring", "quad", "quads", "hip", "ab", "abs",
  "skull", "wrist", "forearm", "trap", "traps", "pec", "pecs",
  // activity words that are never a body measurement
  "lift", "lifts", "lifting", "workout", "session", "training",
]);

/** Tokens of a name after noise removal (the pieces the key is built from). */
function identityTokens(name: string | null | undefined): string[] {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !NOISE_WORDS.has(t));
}

/**
 * Could these two names ever be the same tracker? A hard guard applied BEFORE
 * any fuzzy matching — including the engine's substring search — so neither a
 * workout nor a lift variant can be absorbed by a tracker that means something
 * else. Same-name pairs always stay compatible.
 */
export function trackerDomainsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = trackerIdentityKey(a);
  const kb = trackerIdentityKey(b);
  if (!ka || !kb || ka === kb) return true;
  // Body weight is a measurement of the person, never an activity.
  if (isBodyWeightName(a) !== isBodyWeightName(b)) return false;
  // A qualifier that only one name carries makes it a different exercise.
  const ta = new Set(identityTokens(a));
  const tb = new Set(identityTokens(b));
  for (const t of EXERCISE_QUALIFIERS) {
    if (ta.has(t) !== tb.has(t)) return false;
  }
  return true;
}

/**
 * Do two tracker names refer to the same tracker? True when their identity
 * keys are equal, or (for compound names) one key fully contains the other and
 * both are long enough that the containment is meaningful (so "Bench Press" and
 * "Morning Bench Press" match, while "Leg Press" and "Bench Press" do not).
 *
 * Containment never crosses a domain guard: "Weight" ≠ "Weight Lifting" and
 * "Bench Press" ≠ "Incline Bench Press", however much text they share.
 */
export function trackerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = trackerIdentityKey(a);
  const kb = trackerIdentityKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (!trackerDomainsCompatible(a, b)) return false;
  // Conservative containment for compound names. Require the shorter key to be
  // at least 5 chars so short fragments ("oil", "run") can't swallow others.
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 5 && long.includes(short)) return true;
  return false;
}

// A workout can also reach the body-weight tracker by NAME alone: the model
// calls log_tracker_entry(trackerName:"Weight") for "45 min of weight lifting",
// which matches exactly, so no name guard can catch it. The entry itself is the
// evidence — a set/rep/duration log is not something a scale can produce.
const WORKOUT_KEYS = /^(activitytype|exercise|workout|sets?|reps?|duration|caloriesburned|calories|intensity|distance|pace|heartrate|totalvolume)$/;

const titleCase = (s: string) =>
  s.trim().replace(/\s+/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Should this entry be logged somewhere other than the body-weight tracker it
 * was addressed to? Returns the tracker name it belongs in, or null to keep it.
 *
 *   ("Weight", {activityType:"weight lifting", duration:45}) → "Weight Lifting"
 *   ("Weight", {exercise:"Bench Press", weight:185, reps:5, sets:3}) → "Bench Press"
 *   ("Weight", {weight:184.2})                                → null (a real reading)
 *
 * A lift always reroutes even though it carries a numeric `weight` — that is
 * the LOAD on the bar, not the person on the scale.
 */
export function bodyWeightWorkoutReroute(
  trackerName: string | null | undefined,
  values: Record<string, any> | null | undefined,
): string | null {
  if (!isBodyWeightName(trackerName) || !values || typeof values !== "object") return null;

  const keys = Object.keys(values).filter((k) => !k.startsWith("_") && values[k] != null && values[k] !== "");
  const workoutKeys = keys.filter((k) => WORKOUT_KEYS.test(k.toLowerCase().replace(/[^a-z]/g, "")));
  const isLift = isStrengthShaped(values);
  if (!isLift && workoutKeys.length === 0) return null;

  // A scale reading present alongside activity fields (e.g. "weighed in after
  // the gym") still belongs to body weight — unless the entry is a lift, where
  // `weight` is the load.
  if (!isLift) {
    const scale = values.weight ?? values.bodyWeight ?? values.body_weight;
    const n = typeof scale === "number" ? scale : parseFloat(String(scale ?? ""));
    if (isFinite(n)) return null;
  }

  const named = [values.exercise, values.activityType, values.workout]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find((v) => v.length > 0);
  const target = named ? titleCase(named) : "Workout";
  // Never bounce it straight back into body weight.
  return isBodyWeightName(target) ? "Workout" : target;
}

export interface TrackerIdentityLike {
  id?: string;
  name?: string | null;
  category?: string | null;
  linkedProfiles?: string[];
}

/**
 * Return every tracker whose identity matches `queryName`. This is the set the
 * caller (engine) then narrows by profile via pickTrackerForLog. Matching is
 * intentionally broader than exact-name so a logged subject reuses the existing
 * tracker instead of spawning a numbered/worded duplicate.
 */
export function findIdentityMatches<T extends TrackerIdentityLike>(
  trackers: T[],
  queryName: string | null | undefined,
): T[] {
  if (!queryName) return [];
  return trackers.filter((t) => trackerNamesMatch(t.name, queryName));
}
