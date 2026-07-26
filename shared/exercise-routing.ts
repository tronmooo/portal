// shared/exercise-routing.ts
// =============================================================================
// Deterministic exercise routing — pure, no I/O.
// =============================================================================
//
// User report (screenshot 2026-07-26): "dumbbell curls with 45 lb dumbbells,
// 8 reps, 3 sets" and "bench press at 110 for 10 reps, 3 sets" BOTH landed in
// one tracker named LIFTING, with the real exercise demoted to an
// `activityType` VALUE. Each lift owns its own weight progression, so merging
// them makes the chart meaningless — 110 lb bench and 45 lb curls on one line.
//
// The prompts now ask for one tracker per exercise, but a prompt is a
// suggestion. This module is the deterministic backstop that runs on EVERY
// tracker write, no matter which path produced it (chat tool call, bulk
// extractor, document extraction): when the tracker name is a generic bucket
// ("Lifting", "Workout", "Gym Session", "Cardio", "Sports") AND the values
// carry the specific exercise, the entry is re-routed to a tracker named for
// that exercise.
//
// It is deliberately conservative: a specific tracker name is NEVER rewritten,
// and a generic label ("strength", "cardio") never becomes a tracker name.
//
// Pinned by tests/exercise-routing.test.ts.
// =============================================================================

/** Tokens that carry no exercise identity on their own. A tracker name made up
 *  ENTIRELY of these is a bucket, not an exercise. */
const GENERIC_TOKENS = new Set([
  // strength buckets. "weight" is generic only in COMBINATION ("Weight
  // Lifting") — the standalone body-weight tracker is protected by
  // NEVER_GENERIC below.
  "lifting", "lift", "lifts", "lifted", "weightlifting", "weight", "weights",
  "strength", "resistance", "training", "train", "powerlifting", "bodybuilding",
  // session buckets
  "workout", "workouts", "working", "out", "gym", "exercise", "exercises",
  "exercising", "fitness", "conditioning", "circuit", "crosstraining",
  // cardio / sport buckets
  "cardio", "aerobic", "aerobics", "sport", "sports", "athletics",
  // activity buckets
  "activity", "activities", "movement", "physical",
]);

/** Words that decorate a name without changing what it tracks. Stripped before
 *  the generic test so "Morning Gym Session" reads as the bucket "gym". */
const DECORATOR_TOKENS = new Set([
  "my", "the", "a", "an", "of", "for", "todays", "today", "daily", "weekly",
  "morning", "afternoon", "evening", "night", "nightly", "am", "pm",
  "session", "sessions", "routine", "routines", "log", "logs", "logging",
  "tracker", "tracking", "day", "days", "time", "class", "practice",
]);

/** Names that LOOK bucket-ish but are real, distinct trackers. "Weight" is the
 *  body-weight measurement; "Weight Lifting" is the bucket. */
const NEVER_GENERIC = new Set(["weight", "bodyweight", "body weight", "body fat", "scale weight"]);

/** Value keys that may carry the specific exercise, most explicit first. */
const EXERCISE_LABEL_KEYS = [
  "exercise", "exerciseName", "exercise_name",
  "lift", "liftName", "movement",
  "activityType", "activity_type", "activityName", "activity",
  "workoutType", "workout_type", "sport", "discipline",
  "type", "name",
];

/** Acronyms that must stay upper-cased through title-casing. */
const ACRONYMS = new Set([
  "rdl", "ohp", "hiit", "amrap", "emom", "bw", "kb", "db", "bb", "gvt",
  "sldl", "rfess", "ghr", "ttb", "hspu", "mu", "ez",
]);

function tokenize(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Is this tracker name a generic workout bucket rather than a specific
 * exercise? True when every meaningful token is a bucket word.
 *
 *   "Lifting"           → true      "Bench Press"     → false
 *   "Weight Lifting"    → true      "Leg Press"       → false
 *   "Morning Gym"       → true      "Weight"          → false (body weight)
 *   "Strength Training" → true      "Strength Circuit Row" → false
 */
export function isGenericWorkoutTracker(name: string | null | undefined): boolean {
  const normalized = tokenize(name).join(" ");
  if (!normalized) return false;
  if (NEVER_GENERIC.has(normalized)) return false;
  const meaningful = tokenize(name).filter(t => !DECORATOR_TOKENS.has(t));
  if (meaningful.length === 0) return false;
  return meaningful.every(t => GENERIC_TOKENS.has(t));
}

/**
 * Title-case an exercise label for use as a tracker name, preserving acronyms
 * and hyphenated compounds.
 *
 *   "bench press"      → "Bench Press"
 *   "dumbbell curls"   → "Dumbbell Curls"
 *   "t-bar row"        → "T-Bar Row"
 *   "rdl"              → "RDL"
 */
export function titleCaseExercise(label: string | null | undefined): string {
  const raw = String(label ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  return raw
    .split(" ")
    .map(word =>
      word
        .split("-")
        .map(part => {
          const lc = part.toLowerCase();
          if (!lc) return part;
          if (ACRONYMS.has(lc)) return lc.toUpperCase();
          // Keep an already-capitalized interior ("McGill") intact.
          if (/[A-Z]/.test(part.slice(1))) return part;
          return lc.charAt(0).toUpperCase() + lc.slice(1);
        })
        .join("-"),
    )
    .join(" ");
}

/**
 * Pull the specific exercise out of an entry's values, or null when the values
 * only describe the bucket. Rejects labels that are themselves generic, are
 * not text, or are too long to be an exercise name.
 */
export function exerciseLabelFromValues(values: Record<string, any> | null | undefined): string | null {
  if (!values || typeof values !== "object") return null;
  for (const key of EXERCISE_LABEL_KEYS) {
    const raw = (values as any)[key];
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    if (!label || label.length > 60) continue;
    // Must read as a NAME, not a prescription: "3x10", "3", "5x5" are set/rep
    // notation. Accept a word of 3+ letters ("row", "rdl") or a multi-word
    // phrase ("v up"), which no rep notation produces.
    const words = tokenize(label);
    const namely = /[a-z]{3}/i.test(label) || (words.length > 1 && words.every(w => /[a-z]/i.test(w)));
    if (!namely) continue;
    if (isGenericWorkoutTracker(label)) continue; // "strength", "workout"
    if (words.length === 0) continue;
    return label;
  }
  return null;
}

export interface ExerciseRouting {
  /** The tracker name the entry should actually be written to. */
  trackerName: string;
  /** The generic bucket it was diverted from (for logging). */
  from: string;
  /** The values key the exercise name came from. */
  via: string;
}

/**
 * The whole point of this module: given what a caller WANTS to log, return the
 * corrected tracker name, or null when nothing needs to change.
 *
 *   ("Lifting", { activityType: "bench press", weight: 110 })
 *      → { trackerName: "Bench Press", from: "Lifting", via: "activityType" }
 *   ("Bench Press", { weight: 110 })          → null (already specific)
 *   ("Lifting", { duration: 45 })             → null (no exercise named)
 *   ("Lifting", { activityType: "strength" }) → null (label is a bucket too)
 */
export function resolveExerciseTracker(
  trackerName: string | null | undefined,
  values: Record<string, any> | null | undefined,
): ExerciseRouting | null {
  const current = String(trackerName ?? "").trim();
  if (!current || !isGenericWorkoutTracker(current)) return null;
  const label = exerciseLabelFromValues(values);
  if (!label) return null;
  const resolved = titleCaseExercise(label);
  if (!resolved) return null;
  // Already the same tracker, just differently cased — nothing to divert.
  if (tokenize(resolved).join(" ") === tokenize(current).join(" ")) return null;
  const via = EXERCISE_LABEL_KEYS.find(k => typeof (values as any)?.[k] === "string"
    && String((values as any)[k]).trim().toLowerCase() === label.toLowerCase()) || "activityType";
  return { trackerName: resolved, from: current, via };
}
