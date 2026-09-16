// shared/fitness-metrics.ts
// =============================================================================
// THE semantic layer for fitness/workout measurements — and the ONE calorie
// estimator the whole app shares.
// =============================================================================
//
// WHY THIS FILE EXISTS
// -------------------
// A tracker entry is a bag of numbers: `{ reps: 12, sets: 3 }`. Every renderer
// used to pick "the primary number" out of that bag positionally — the first
// declared field, or the first numeric value it happened to iterate — and then
// label it with the unit its *template* expected. On the Squats card the
// template was the bench-press template, whose unit is pounds, and the first
// numeric value in the bag was `sets`. That is how a tracker whose subline
// truthfully read "12 reps · 3 sets" grew a headline reading **"3 lbs"**.
//
// The defect is not a wrong string. It is that the number lost its MEANING
// somewhere between storage and rendering, and the renderer re-invented one.
//
// THE RULE (enforced by tests/fitness-metrics.test.ts)
// ---------------------------------------------------
// A number's unit comes from the NAME OF THE FIELD IT WAS STORED UNDER (plus
// that field's declared unit) — never from its magnitude, never from its
// position, never from a sibling field, and never from the template that
// happens to be rendering it. A value stored as `sets` is a count of sets in
// every view, forever. If we cannot name a value's metric, we do not render it
// as a measurement at all.
//
// WHAT LIVES HERE
// ---------------
//   1. readFitnessFacts()       raw `values` → semantically typed facts
//   2. classifyFitnessActivity() tracker name/category → activity descriptor
//   3. estimateCaloriesBurned()  THE canonical calorie service
//   4. buildFitnessDisplay()     deterministic display selection per activity
//
// Pure, no I/O, no React — so the server (write-time `computed`), the tracker
// cards, the dashboard, Wellness, and the AI all produce the SAME numbers and
// the SAME units for the same entry.
// =============================================================================

/** Kilograms per pound. Defined HERE (rather than imported from the
 *  estimation engine) so the dependency runs one way: estimation-engine →
 *  fitness-metrics. The engine re-exports it, so existing importers are
 *  unaffected. */
export const KG_PER_LB = 0.45359237;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The metric vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every distinct KIND of quantity a fitness entry can hold. These are semantic
 * identities, not units: `resistance` may be recorded in lb or kg, but it is
 * never the same thing as `sets` however similar the two numbers look.
 */
export type FitnessMetricKind =
  | "resistance"     // external load moved: barbell, dumbbell, machine, added weight
  | "reps"           // repetitions within a set
  | "sets"           // number of sets
  | "duration"       // time spent, canonically minutes
  | "distance"       // canonically miles
  | "caloriesBurned" // energy expenditure
  | "heartRate"      // average/peak bpm
  | "steps"          // step count
  | "bodyWeight"     // the PERSON's weight — an input to calorie math, not a lift
  | "pace"           // min per mile
  | "speed"          // mph
  | "elevation"      // feet climbed
  | "incline"        // percent grade
  | "laps"
  | "exerciseCount"  // "12 exercises" in a strength session
  | "rpe";           // rate of perceived exertion, /10

/**
 * Canonical display unit per metric kind. One spelling, one place.
 *
 * This is NOT a competing copy of shared/tracker-units. That module answers
 * "what unit does this tracker FIELD display in?" and its first and highest
 * precedence rule is the field's own declared unit. readFitnessFacts obeys the
 * same rule: a declared `kg` / `sec` / `km` always wins, and this table is only
 * the fallback for a metric whose field declared nothing — so `reps` reads
 * "reps" and never inherits the unit of whatever template is rendering it.
 */
export const FITNESS_METRIC_UNIT: Record<FitnessMetricKind, string> = {
  resistance: "lbs",
  reps: "reps",
  sets: "sets",
  duration: "min",
  distance: "mi",
  caloriesBurned: "cal",
  heartRate: "bpm",
  steps: "steps",
  bodyWeight: "lbs",
  pace: "min/mi",
  speed: "mph",
  elevation: "ft",
  incline: "%",
  laps: "laps",
  exerciseCount: "exercises",
  rpe: "/10",
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Field name → metric kind
// ─────────────────────────────────────────────────────────────────────────────
//
// A CLOSED table. A key that is not in it has no known metric identity, and an
// unidentified number is never promoted to a headline measurement — that is the
// exact failure mode ("first number I found must be the weight") this replaces.

const normKey = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** key (normalised) → metric kind. */
const METRIC_BY_KEY: Record<string, FitnessMetricKind> = {
  // ── resistance / external load ──
  resistance: "resistance", resistanceweight: "resistance", load: "resistance",
  weightlifted: "resistance", liftweight: "resistance", addedweight: "resistance",
  externalweight: "resistance", barweight: "resistance", plateweight: "resistance",
  lbs: "resistance", lb: "resistance", pounds: "resistance",
  kg: "resistance", kgs: "resistance", kilograms: "resistance",
  weightlbs: "resistance", weightkg: "resistance",
  // NOTE: bare `weight` is deliberately ABSENT — it means "the load" on a
  // barbell lift and "the person" on a scale tracker. resolveAmbiguousWeight()
  // decides using the activity, never using the number.

  // ── counts ──
  reps: "reps", rep: "reps", repetitions: "reps", repcount: "reps", repsperset: "reps",
  sets: "sets", set: "sets", setcount: "sets", numsets: "sets",
  laps: "laps", lap: "laps",
  exercises: "exerciseCount", exercisecount: "exerciseCount", movements: "exerciseCount",
  steps: "steps", stepcount: "steps", stepstaken: "steps",

  // ── time ──
  duration: "duration", durationminutes: "duration", minutes: "duration",
  mins: "duration", min: "duration", timeminutes: "duration", activeminutes: "duration",
  elapsed: "duration", elapsedminutes: "duration", durationmin: "duration",
  durationseconds: "duration", seconds: "duration", secs: "duration",

  // ── distance ──
  distance: "distance", distancemiles: "distance", miles: "distance", mi: "distance",
  distancekm: "distance", kilometers: "distance", kilometres: "distance", km: "distance",
  meters: "distance", metres: "distance", yards: "distance", yd: "distance",

  // ── energy ──
  caloriesburned: "caloriesBurned", caloriesburnt: "caloriesBurned",
  calsburned: "caloriesBurned", burnedcalories: "caloriesBurned",
  energyburned: "caloriesBurned", kcalburned: "caloriesBurned",
  // NOTE: bare `calories` is ABSENT — on Nutrition it is intake, on a workout
  // it is expenditure. resolveAmbiguousCalories() decides from the activity.

  // ── physiology ──
  heartrate: "heartRate", hr: "heartRate", bpm: "heartRate", pulse: "heartRate",
  avgheartrate: "heartRate", averageheartrate: "heartRate", avghr: "heartRate",

  // ── cardio derivatives ──
  pace: "pace", paceminutespermile: "pace", pacepermile: "pace",
  speed: "speed", speedmph: "speed", avgspeed: "speed", averagespeed: "speed", mph: "speed",
  elevation: "elevation", elevationgain: "elevation", elevationft: "elevation", ascent: "elevation",
  incline: "incline", grade: "incline",

  // ── effort ──
  rpe: "rpe", perceivedexertion: "rpe",

  // ── the person ──
  bodyweight: "bodyWeight", bodyweightlbs: "bodyWeight", scaleweight: "bodyWeight",
};

/** Keys that carry the per-metric unit for a sibling value (`distanceUnit`). */
const UNIT_SUFFIXES = ["unit", "units"];

// ─────────────────────────────────────────────────────────────────────────────
// 3. Activity taxonomy + MET table
// ─────────────────────────────────────────────────────────────────────────────

export type FitnessActivityKind =
  | "strength"         // external resistance is expected and meaningful
  | "bodyweight"       // reps/sets against one's own body; load only if logged
  | "isometric"        // held positions — plank, wall sit, dead hang
  | "cardio_distance"  // distance is the headline: run, walk, ride, swim, row
  | "cardio_duration"  // time is the headline: elliptical, HIIT, jump rope
  | "sport"            // time is the headline, MET from the sport
  | "flexibility"      // yoga, stretching, mobility
  | "generic_workout"  // known to be exercise, shape unknown
  | "non_fitness";     // not an activity at all — no calorie claim is made

/** MET values by intensity. Source: Compendium of Physical Activities (2011). */
export interface MetProfile { light: number; moderate: number; vigorous: number }

export interface FitnessActivity {
  /** Stable id, e.g. "squat", "basketball". */
  id: string;
  kind: FitnessActivityKind;
  /** Human label for the activity. */
  label: string;
  met: MetProfile;
  /** Typical minutes per mile, for cardio whose duration was not logged. */
  defaultPaceMinPerMile?: number;
}

const MET_STRENGTH: MetProfile = { light: 3.5, moderate: 5.0, vigorous: 6.0 };
const MET_CALISTHENIC: MetProfile = { light: 3.0, moderate: 3.8, vigorous: 8.0 };
const MET_ISOMETRIC: MetProfile = { light: 2.8, moderate: 3.8, vigorous: 4.5 };
const MET_FLEX: MetProfile = { light: 2.3, moderate: 3.0, vigorous: 4.0 };
const MET_GENERIC: MetProfile = { light: 3.0, moderate: 4.5, vigorous: 6.0 };

interface ActivityEntry extends FitnessActivity { patterns: RegExp }

/**
 * Ordered, specific-before-generic. Matched on the tracker/exercise NAME.
 * `\b` anchored so "Tire Pressure" can never reach the bench-press row — the
 * substring bug that produced "Lifted 35 lbs" on a vehicle tracker.
 */
const ACTIVITY_CATALOG: ActivityEntry[] = [
  // ── Strength: barbell / dumbbell / machine ────────────────────────────────
  { id: "bench_press", kind: "strength", label: "Bench Press", met: MET_STRENGTH, patterns: /\b(bench\s*press|chest\s*press|incline\s*press|decline\s*press)\b/i },
  { id: "shoulder_press", kind: "strength", label: "Shoulder Press", met: MET_STRENGTH, patterns: /\b(shoulder\s*press|overhead\s*press|military\s*press|ohp)\b/i },
  { id: "leg_press", kind: "strength", label: "Leg Press", met: MET_STRENGTH, patterns: /\bleg\s*press\b/i },
  { id: "deadlift", kind: "strength", label: "Deadlift", met: MET_STRENGTH, patterns: /\b(deadlift|rdl|romanian\s*deadlift)\b/i },
  { id: "squat", kind: "strength", label: "Squat", met: MET_STRENGTH, patterns: /\b(squat|squats|hack\s*squat|front\s*squat|goblet\s*squat)\b/i },
  { id: "row", kind: "strength", label: "Row", met: MET_STRENGTH, patterns: /\b(barbell\s*row|bent[-\s]*over\s*row|pendlay\s*row|seated\s*row|cable\s*row|dumbbell\s*row)\b/i },
  { id: "curl", kind: "strength", label: "Curl", met: MET_STRENGTH, patterns: /\b(curl|curls|bicep|biceps)\b/i },
  { id: "extension", kind: "strength", label: "Extension", met: MET_STRENGTH, patterns: /\b(tricep|triceps|leg\s*extension|leg\s*curl|lat\s*pulldown|pulldown|pull\s*down|fly|flye|raise|shrug|press\s*machine)\b/i },
  { id: "strength_training", kind: "strength", label: "Strength Training", met: MET_STRENGTH, patterns: /\b(strength|weight\s*lifting|weightlifting|lifting|weights|resistance\s*training|powerlifting|gym\s*session)\b/i },
  // Catch-all for the long tail of loaded movements ("Incline Dumbbell Press",
  // "Kettlebell Swing", "Cable Crossover"). `\b…\b` anchoring is what keeps
  // "Tire Pressure" / "Blood Pressure" out — `press` never matches `pressure`.
  { id: "resistance_movement", kind: "strength", label: "Resistance Exercise", met: MET_STRENGTH, patterns: /\b(press|dumbbell|barbell|kettlebell|cable|machine|smith|hamstring|quad|glute|delt|trap|lat)\b/i },

  // ── Bodyweight ────────────────────────────────────────────────────────────
  { id: "pushup", kind: "bodyweight", label: "Push-ups", met: MET_CALISTHENIC, patterns: /\b(push[-\s]?ups?|pushups?|press[-\s]?ups?)\b/i },
  { id: "pullup", kind: "bodyweight", label: "Pull-ups", met: MET_CALISTHENIC, patterns: /\b(pull[-\s]?ups?|pullups?|chin[-\s]?ups?|chinups?|dips?)\b/i },
  { id: "situp", kind: "bodyweight", label: "Sit-ups", met: MET_CALISTHENIC, patterns: /\b(sit[-\s]?ups?|situps?|crunch(es)?|leg\s*raises?|russian\s*twists?)\b/i },
  { id: "burpee", kind: "bodyweight", label: "Burpees", met: { light: 6, moderate: 8, vigorous: 10 }, patterns: /\b(burpees?|mountain\s*climbers?|jumping\s*jacks?)\b/i },
  { id: "lunge", kind: "bodyweight", label: "Lunges", met: MET_CALISTHENIC, patterns: /\b(lunges?|step[-\s]?ups?|glute\s*bridges?)\b/i },
  { id: "core", kind: "bodyweight", label: "Core Workout", met: MET_CALISTHENIC, patterns: /\b(core|abs|abdominal|six[-\s]?pack)\b/i },
  { id: "calisthenics", kind: "bodyweight", label: "Calisthenics", met: MET_CALISTHENIC, patterns: /\b(calisthenics|bodyweight)\b/i },

  // ── Isometric ─────────────────────────────────────────────────────────────
  { id: "plank", kind: "isometric", label: "Plank", met: MET_ISOMETRIC, patterns: /\b(planks?|wall\s*sits?|dead\s*hangs?|hollow\s*holds?)\b/i },

  // ── Cardio, distance-shaped ───────────────────────────────────────────────
  { id: "running", kind: "cardio_distance", label: "Running", met: { light: 6, moderate: 9.8, vigorous: 11.8 }, defaultPaceMinPerMile: 10, patterns: /\b(runn?ing|runs?|ran|jogg?(ing|ed)?|sprints?|treadmill|5k|10k|marathon)\b/i },
  { id: "walking", kind: "cardio_distance", label: "Walking", met: { light: 2.8, moderate: 3.5, vigorous: 5.0 }, defaultPaceMinPerMile: 20, patterns: /\b(walk(ing|ed|s)?|stroll(ing)?|steps?|pedometer)\b/i },
  { id: "hiking", kind: "cardio_distance", label: "Hiking", met: { light: 4.5, moderate: 6.0, vigorous: 7.8 }, defaultPaceMinPerMile: 25, patterns: /\b(hik(e|ing)|trek(king)?|backpacking)\b/i },
  { id: "cycling", kind: "cardio_distance", label: "Cycling", met: { light: 4.0, moderate: 8.0, vigorous: 10.0 }, defaultPaceMinPerMile: 5, patterns: /\b(cycl(e|ing)|bik(e|ing)|bicycle|spin\s*class|peloton)\b/i },
  { id: "swimming", kind: "cardio_distance", label: "Swimming", met: { light: 5.8, moderate: 7.0, vigorous: 9.8 }, defaultPaceMinPerMile: 30, patterns: /\b(swim(ming)?|swam|freestyle|backstroke|breaststroke)\b/i },
  { id: "rowing", kind: "cardio_distance", label: "Rowing", met: { light: 4.8, moderate: 7.0, vigorous: 8.5 }, defaultPaceMinPerMile: 8, patterns: /\b(row(ing)?|erg|kayak(ing)?|canoe(ing)?|paddle\s*board)\b/i },

  // ── Cardio, duration-shaped ───────────────────────────────────────────────
  { id: "hiit", kind: "cardio_duration", label: "HIIT", met: { light: 6, moderate: 8, vigorous: 10 }, patterns: /\b(hiit|circuit\s*training|crossfit|bootcamp|tabata|metcon)\b/i },
  { id: "jump_rope", kind: "cardio_duration", label: "Jump Rope", met: { light: 8.8, moderate: 11.8, vigorous: 12.3 }, patterns: /\b(jump\s*rope|skipping\s*rope|jump\s*roping)\b/i },
  { id: "elliptical", kind: "cardio_duration", label: "Elliptical", met: { light: 4.6, moderate: 5.0, vigorous: 7.0 }, patterns: /\b(elliptical|cross\s*trainer)\b/i },
  { id: "stair_climber", kind: "cardio_duration", label: "Stair Climber", met: { light: 6.0, moderate: 8.8, vigorous: 9.8 }, patterns: /\b(stair(master|\s*climber|s)?|step\s*mill)\b/i },
  { id: "cardio", kind: "cardio_duration", label: "Cardio", met: { light: 4.0, moderate: 6.0, vigorous: 8.0 }, patterns: /\b(cardio|aerobics?|conditioning)\b/i },

  // ── Sports ────────────────────────────────────────────────────────────────
  { id: "basketball", kind: "sport", label: "Basketball", met: { light: 4.5, moderate: 6.5, vigorous: 8.0 }, patterns: /\b(basketball|hoops|pickup\s*ball)\b/i },
  { id: "soccer", kind: "sport", label: "Soccer", met: { light: 5.0, moderate: 7.0, vigorous: 10.0 }, patterns: /\b(soccer|football\s*\(?club\)?|futsal)\b/i },
  { id: "football", kind: "sport", label: "Football", met: { light: 4.0, moderate: 6.0, vigorous: 8.0 }, patterns: /\b(football|flag\s*football)\b/i },
  { id: "tennis", kind: "sport", label: "Tennis", met: { light: 5.0, moderate: 7.3, vigorous: 8.0 }, patterns: /\b(tennis)\b/i },
  { id: "pickleball", kind: "sport", label: "Pickleball", met: { light: 4.0, moderate: 5.5, vigorous: 6.5 }, patterns: /\b(pickle\s*ball|pickleball|paddle\s*ball|racquetball|squash)\b/i },
  { id: "badminton", kind: "sport", label: "Badminton", met: { light: 4.5, moderate: 5.5, vigorous: 7.0 }, patterns: /\b(badminton|table\s*tennis|ping\s*pong)\b/i },
  { id: "volleyball", kind: "sport", label: "Volleyball", met: { light: 3.0, moderate: 4.0, vigorous: 6.0 }, patterns: /\b(volleyball)\b/i },
  { id: "baseball", kind: "sport", label: "Baseball", met: { light: 4.0, moderate: 5.0, vigorous: 6.0 }, patterns: /\b(baseball|softball|batting\s*practice)\b/i },
  { id: "hockey", kind: "sport", label: "Hockey", met: { light: 6.0, moderate: 8.0, vigorous: 10.0 }, patterns: /\b(hockey|ice\s*skating|roller\s*blading)\b/i },
  { id: "golf", kind: "sport", label: "Golf", met: { light: 3.5, moderate: 4.8, vigorous: 5.3 }, patterns: /\b(golf|driving\s*range)\b/i },
  { id: "martial_arts", kind: "sport", label: "Martial Arts", met: { light: 5.3, moderate: 7.8, vigorous: 10.3 }, patterns: /\b(boxing|kickbox(ing)?|martial\s*arts|karate|judo|jiu[-\s]*jitsu|bjj|muay\s*thai|wrestling|mma)\b/i },
  { id: "climbing", kind: "sport", label: "Climbing", met: { light: 5.8, moderate: 8.0, vigorous: 11.0 }, patterns: /\b(climb(ing)?|boulder(ing)?|rock\s*wall)\b/i },
  { id: "skiing", kind: "sport", label: "Skiing", met: { light: 4.3, moderate: 7.0, vigorous: 9.0 }, patterns: /\b(ski(ing)?|snowboard(ing)?)\b/i },
  { id: "surfing", kind: "sport", label: "Surfing", met: { light: 3.0, moderate: 5.0, vigorous: 6.0 }, patterns: /\b(surf(ing)?|windsurf(ing)?)\b/i },
  { id: "dancing", kind: "sport", label: "Dancing", met: { light: 3.0, moderate: 5.0, vigorous: 7.8 }, patterns: /\b(danc(e|ing)|zumba|ballet|salsa)\b/i },
  { id: "skating", kind: "sport", label: "Skating", met: { light: 4.0, moderate: 7.0, vigorous: 9.0 }, patterns: /\b(skate(boarding)?|skating)\b/i },

  // ── Flexibility / mind-body ───────────────────────────────────────────────
  { id: "yoga", kind: "flexibility", label: "Yoga", met: { light: 2.5, moderate: 3.0, vigorous: 4.0 }, patterns: /\b(yoga|vinyasa|hatha|ashtanga)\b/i },
  { id: "pilates", kind: "flexibility", label: "Pilates", met: { light: 2.8, moderate: 3.0, vigorous: 4.0 }, patterns: /\b(pilates|barre)\b/i },
  { id: "stretching", kind: "flexibility", label: "Stretching", met: MET_FLEX, patterns: /\b(stretch(ing)?|mobility|foam\s*roll(ing)?|warm[-\s]*up|cool[-\s]*down)\b/i },

  // ── Known-to-be-exercise, shape unknown ───────────────────────────────────
  { id: "workout", kind: "generic_workout", label: "Workout", met: MET_GENERIC, patterns: /\b(workout|work\s*out|exercise|training|session\s*at\s*the\s*gym|gym)\b/i },
];

/**
 * Names that LOOK like exercise but are not the user exercising. Checked first
 * so a supplement, a vehicle reading, or a vital sign can never be handed a MET
 * value and told how many calories it burned.
 */
const NON_FITNESS = /\b(fish\s*oil|omega|multi\s*vitamin|vitamin|creatine|magnesium|melatonin|probiotic|supplement|medication|prescription|dose|dosage|blood\s*pressure|heart\s*rate|glucose|blood\s*sugar|body\s*fat|tire\s*pressure|oil\s*change|odometer|fuel|mileage|mpg|battery|charge|hydration|water|coffee|caffeine|nutrition|calorie\s*intake|meal|food|sleep|mood|journal|bathroom|weight\s*\(?scale\)?|scale\s*weight|body\s*weight)\b/i;

const NON_FITNESS_CATEGORIES = new Set([
  "medication", "prescription", "supplement", "nutrition", "sleep", "mood",
  "mental", "finance", "vehicle", "home", "weight", "productivity",
]);

const GENERIC_WORKOUT: FitnessActivity = {
  id: "workout", kind: "generic_workout", label: "Workout", met: MET_GENERIC,
};
const NOT_FITNESS: FitnessActivity = {
  id: "non_fitness", kind: "non_fitness", label: "Tracker", met: MET_GENERIC,
};

/**
 * Classify a tracker (or a logged `exercise`/`activityType` value) into an
 * activity descriptor. Returns a `non_fitness` descriptor — never null — so
 * callers always have something to branch on, and so a non-activity can never
 * silently fall through to a workout template.
 */
export function classifyFitnessActivity(
  name: string | null | undefined,
  category?: string | null,
): FitnessActivity {
  const n = String(name ?? "").trim();
  const cat = String(category ?? "").trim().toLowerCase();

  // A health/vehicle/nutrition tracker is not an activity, whatever its name
  // collides with. ("Body Weight" contains "weight"; "Fish Oil" contains "oil".)
  if (NON_FITNESS_CATEGORIES.has(cat)) {
    // …unless the name itself is unmistakably an exercise (a "Squats" tracker
    // miscategorised as `weight` is still squats).
    const hit = n ? ACTIVITY_CATALOG.find(a => a.patterns.test(n)) : undefined;
    if (!hit || hit.kind === "cardio_distance" || NON_FITNESS.test(n)) return { ...NOT_FITNESS };
    return stripPatterns(hit);
  }
  if (!n) return cat === "fitness" ? { ...GENERIC_WORKOUT } : { ...NOT_FITNESS };
  if (NON_FITNESS.test(n)) return { ...NOT_FITNESS };

  const hit = ACTIVITY_CATALOG.find(a => a.patterns.test(n));
  if (hit) return stripPatterns(hit);
  if (cat === "fitness") return { ...GENERIC_WORKOUT };
  return { ...NOT_FITNESS };
}

function stripPatterns(a: ActivityEntry): FitnessActivity {
  const { patterns, ...rest } = a;
  return { ...rest };
}

/** Is this activity one we are willing to attribute calorie expenditure to? */
export function isCalorieBearingActivity(a: FitnessActivity): boolean {
  return a.kind !== "non_fitness";
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reading semantic facts out of a raw entry
// ─────────────────────────────────────────────────────────────────────────────

export type Intensity = "light" | "moderate" | "vigorous";

export interface FitnessFacts {
  /** External load, in the unit it is displayed in. Absent unless LOGGED. */
  resistance?: { value: number; unit: string };
  reps?: number;
  sets?: number;
  /** Minutes. */
  duration?: number;
  /** Miles, plus the unit the user logged it in for display. */
  distance?: { value: number; unit: string };
  /** Miles — always normalised, used for math. */
  distanceMiles?: number;
  /** Calories found on the entry itself. */
  caloriesLogged?: number;
  /**
   * True when that number was written by an estimator (the chat estimation
   * engine mirrors its estimates into `values`), NOT stated by the user. An
   * estimate that has been round-tripped through storage must never be
   * promoted to "logged" — that is how a guess acquires false authority.
   */
  caloriesLoggedWasEstimated?: boolean;
  heartRate?: number;
  steps?: number;
  pace?: number;
  speed?: number;
  elevation?: number;
  incline?: number;
  laps?: number;
  exerciseCount?: number;
  rpe?: number;
  intensity?: Intensity;
  /** The subject's own body weight, when the ENTRY carried it. */
  bodyWeightLbs?: number;
  /** Keys we could not give a metric identity to. Never rendered as a metric. */
  unknownKeys: string[];
}

export interface FitnessField { name: string; unit?: string | null; type?: string }

const num = (v: unknown): number | null => {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
};

const MASS_UNITS = /^(kg|kgs|kilogram|kilograms)$/i;
const KM_UNITS = /^(km|kilometer|kilometers|kilometre|kilometres)$/i;
const M_UNITS = /^(m|meter|meters|metre|metres)$/i;
const YD_UNITS = /^(yd|yds|yard|yards)$/i;
const SEC_UNITS = /^(s|sec|secs|second|seconds)$/i;
const HR_UNITS = /^(h|hr|hrs|hour|hours)$/i;

const INTENSITY_WORDS: Array<[RegExp, Intensity]> = [
  [/^(1|low|light|easy|gentle|recovery|casual)$/i, "light"],
  [/^(2|mod|moderate|medium|steady|normal)$/i, "moderate"],
  [/^(3|high|hard|vigorous|intense|max|maximal|extreme|all\s*out)$/i, "vigorous"],
];

function readIntensity(raw: unknown): Intensity | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  for (const [re, level] of INTENSITY_WORDS) if (re.test(s)) return level;
  return undefined;
}

/**
 * Bare `weight` is the one genuinely ambiguous key in the vocabulary. It is
 * resolved from the ACTIVITY — never from the number. On a barbell lift it is
 * the load; on a scale/bodyweight tracker it is the person.
 */
function resolveAmbiguousWeight(activity: FitnessActivity): FitnessMetricKind {
  if (activity.kind === "strength") return "resistance";
  if (activity.kind === "bodyweight" || activity.kind === "isometric") return "resistance"; // added weight, only ever explicit
  if (activity.kind === "non_fitness") return "bodyWeight";
  return "resistance";
}

/** Bare `calories`: expenditure on an activity, intake on a nutrition tracker. */
function resolveAmbiguousCalories(activity: FitnessActivity): FitnessMetricKind | null {
  return isCalorieBearingActivity(activity) ? "caloriesBurned" : null;
}

/** The metric identity of a raw entry key, or null when we cannot name it. */
export function metricKindForKey(key: string, activity: FitnessActivity): FitnessMetricKind | null {
  const k = normKey(key);
  if (!k) return null;
  if (k === "weight") return resolveAmbiguousWeight(activity);
  if (k === "calories" || k === "kcal" || k === "cal") return resolveAmbiguousCalories(activity);
  return METRIC_BY_KEY[k] ?? null;
}

/**
 * Turn a raw `values` bag into semantically typed facts.
 *
 * `fields` supplies DECLARED units (the tracker's own schema), which is how a
 * Plank's `duration` in seconds and a Squat's `weight` in kilograms are read
 * correctly. Nothing here ever looks at a value's magnitude to decide what it
 * is — that is precisely the inference this module exists to forbid.
 */
export interface EnrichmentProvenance {
  estimated?: Record<string, { value: number } | undefined>;
}

export function readFitnessFacts(
  values: Record<string, any> | null | undefined,
  activity: FitnessActivity,
  fields?: FitnessField[] | null,
  enrichment?: EnrichmentProvenance | null,
): FitnessFacts {
  const facts: FitnessFacts = { unknownKeys: [] };
  const v = values || {};
  const unitOf = (key: string): string => {
    const declared = (fields || []).find(f => normKey(f.name) === normKey(key))?.unit;
    if (declared) return String(declared).trim();
    // `distanceUnit` / `weight_units` siblings.
    for (const suf of UNIT_SUFFIXES) {
      for (const cand of [`${key}${suf}`, `${key}_${suf}`, `${key}${suf[0].toUpperCase()}${suf.slice(1)}`]) {
        const raw = v[cand];
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
    }
    return "";
  };

  for (const [rawKey, rawVal] of Object.entries(v)) {
    if (rawKey.startsWith("_")) continue;
    const k = normKey(rawKey);
    // Unit sibling keys are metadata for another value, not measurements.
    if (/(unit|units)$/.test(k) && k !== "units") continue;

    if (k === "intensity" || k === "effort" || k === "difficulty") {
      const lvl = readIntensity(rawVal);
      if (lvl) facts.intensity = lvl;
      continue;
    }
    if (k === "exercise" || k === "activitytype" || k === "activity" || k === "type" || k === "notes" || k === "note") continue;

    const kind = metricKindForKey(rawKey, activity);
    const n = num(rawVal);
    if (kind == null) {
      if (n != null) facts.unknownKeys.push(rawKey);
      continue;
    }
    if (n == null) continue;
    const unit = unitOf(rawKey);

    switch (kind) {
      case "resistance": {
        // The KEY names the unit when the key is a unit word (`kg: 60`).
        const keyUnit = MASS_UNITS.test(k) ? "kg" : /^(lbs|lb|pounds)$/.test(k) ? "lbs" : "";
        const u = unit || keyUnit || (k === "weightkg" ? "kg" : k === "weightlbs" ? "lbs" : FITNESS_METRIC_UNIT.resistance);
        if (n > 0) facts.resistance = { value: n, unit: u };
        break;
      }
      case "bodyWeight": {
        const u = unit || (MASS_UNITS.test(k) ? "kg" : FITNESS_METRIC_UNIT.bodyWeight);
        facts.bodyWeightLbs = MASS_UNITS.test(u) ? n / KG_PER_LB : n;
        break;
      }
      case "reps": facts.reps = n; break;
      case "sets": facts.sets = n; break;
      case "duration": {
        const u = unit || (SEC_UNITS.test(k) || k === "durationseconds" ? "sec" : "");
        facts.duration = SEC_UNITS.test(u) ? n / 60 : HR_UNITS.test(u) ? n * 60 : n;
        break;
      }
      case "distance": {
        const keyUnit = KM_UNITS.test(k) || k === "distancekm" ? "km" : M_UNITS.test(k) ? "m" : YD_UNITS.test(k) ? "yd" : "";
        const u = unit || keyUnit || FITNESS_METRIC_UNIT.distance;
        facts.distance = { value: n, unit: u };
        facts.distanceMiles = KM_UNITS.test(u) ? n * 0.621371
          : M_UNITS.test(u) ? n * 0.000621371
          : YD_UNITS.test(u) ? n * 0.000568182
          : n;
        break;
      }
      case "caloriesBurned": if (n > 0) facts.caloriesLogged = n; break;
      case "heartRate": facts.heartRate = n; break;
      case "steps": facts.steps = n; break;
      case "pace": facts.pace = n; break;
      case "speed": facts.speed = n; break;
      case "elevation": facts.elevation = n; break;
      case "incline": facts.incline = n; break;
      case "laps": facts.laps = n; break;
      case "exerciseCount": facts.exerciseCount = n; break;
      case "rpe": facts.rpe = n; break;
    }
  }

  // Provenance check: the estimation engine mirrors its own estimates into
  // `values`, so a `caloriesBurned` key is not proof the user stated one.
  const estCal = enrichment?.estimated?.caloriesBurned?.value;
  if (facts.caloriesLogged != null && estCal != null && Math.abs(estCal - facts.caloriesLogged) < 1) {
    facts.caloriesLoggedWasEstimated = true;
  }

  // RPE is a stated effort level; use it when no intensity word was logged.
  if (!facts.intensity && facts.rpe != null) {
    facts.intensity = facts.rpe >= 8 ? "vigorous" : facts.rpe >= 5 ? "moderate" : "light";
  }
  return facts;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE canonical calorie estimator
// ─────────────────────────────────────────────────────────────────────────────

/** Population fallback when the owner has no recorded body weight. */
export const DEFAULT_BODY_WEIGHT_KG = 70;
/** Below this we decline to publish a number rather than fake precision. */
export const MIN_CALORIE_CONFIDENCE = 0.3;

/** Working assumptions for turning reps × sets into time under load. */
export const SECONDS_PER_REP = 3;
export const SECONDS_REST_PER_SET = 60;

export interface CalorieContext {
  /** The OWNER of the activity — never the logged-in viewer. */
  bodyWeightKg?: number | null;
  ageYears?: number | null;
  sex?: "male" | "female" | null;
  /** Label for the person the weight came from, for the method string. */
  ownerLabel?: string | null;
}

export type CalorieBasis =
  | "logged"
  | "heart_rate"
  | "met_duration"
  | "met_distance"
  | "met_reps";

export interface CalorieEstimate {
  /** kcal. */
  value: number;
  /** `false` only when the user (or a device) stated the number themselves. */
  estimated: boolean;
  basis: CalorieBasis;
  /** Human-readable derivation, surfaced in tooltips and AI answers. */
  method: string;
  confidence: number;
  /** True when no owner body weight was available and the default was used. */
  usedDefaultWeight: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** MET × 3.5 × kg / 200 × minutes — the standard ACSM expression. */
export function metCalories(met: number, weightKg: number, minutes: number): number {
  return (met * 3.5 * weightKg) / 200 * minutes;
}

function metForIntensity(a: FitnessActivity, intensity: Intensity | undefined): number {
  return a.met[intensity ?? "moderate"];
}

/**
 * Minutes of activity implied by a strength/bodyweight set scheme. Compendium
 * resistance-training METs describe a whole session INCLUDING inter-set rest,
 * so rest is counted here too.
 */
export function minutesFromSetScheme(reps: number | undefined, sets: number | undefined): number | null {
  const s = sets != null && sets > 0 ? sets : reps != null ? 1 : null;
  if (s == null) return null;
  const r = reps != null && reps > 0 ? reps : 10;
  return (s * (r * SECONDS_PER_REP + SECONDS_REST_PER_SET)) / 60;
}

/**
 * THE calorie number for a fitness entry. Every surface — write-time
 * `computed`, the tracker card, the dashboard, Wellness, activity history, the
 * AI's answers, and aggregates — must call THIS, so the same workout can never
 * report two different burns.
 *
 * Precedence:
 *   1. explicitly logged calories → returned verbatim, `estimated: false`
 *   2. heart-rate equation, when HR + duration + weight + age + sex are known
 *   3. MET × body weight × duration (duration logged, or derived from
 *      distance/pace for cardio, or from reps × sets for resistance work)
 *
 * Returns null when there is not enough to be responsible about — an omitted
 * number is always better than an invented one.
 */
export function estimateCaloriesBurned(
  activity: FitnessActivity,
  facts: FitnessFacts,
  ctx: CalorieContext = {},
): CalorieEstimate | null {
  // 1. Explicit always wins — but only when it really was explicit.
  if (facts.caloriesLogged != null && facts.caloriesLogged > 0 && !facts.caloriesLoggedWasEstimated) {
    return {
      value: Math.round(facts.caloriesLogged),
      estimated: false,
      basis: "logged",
      method: "Logged by you",
      confidence: 1,
      usedDefaultWeight: false,
    };
  }
  if (!isCalorieBearingActivity(activity)) return null;

  // 2. Body weight — the OWNER's, or a labelled population default.
  const ownerKg = ctx.bodyWeightKg != null && ctx.bodyWeightKg > 20 && ctx.bodyWeightKg < 400
    ? ctx.bodyWeightKg
    : (facts.bodyWeightLbs != null && facts.bodyWeightLbs > 40 ? facts.bodyWeightLbs * KG_PER_LB : null);
  const usedDefaultWeight = ownerKg == null;
  const weightKg = ownerKg ?? DEFAULT_BODY_WEIGHT_KG;
  const whose = usedDefaultWeight
    ? `population-average weight ${DEFAULT_BODY_WEIGHT_KG} kg`
    : `${ctx.ownerLabel ? `${ctx.ownerLabel}'s` : "profile"} weight ${Math.round(weightKg)} kg`;

  // 3. How long was the activity? Each source carries its own confidence.
  let minutes: number | null = facts.duration != null && facts.duration > 0 ? facts.duration : null;
  let durationBasis = "logged duration";
  let durationConfidence = 1;

  if (minutes == null && facts.distanceMiles != null && facts.distanceMiles > 0) {
    const paceMin = facts.pace != null && facts.pace > 0
      ? facts.pace
      : facts.speed != null && facts.speed > 0
        ? 60 / facts.speed
        : activity.defaultPaceMinPerMile ?? null;
    if (paceMin != null) {
      minutes = facts.distanceMiles * paceMin;
      durationBasis = facts.pace || facts.speed ? "distance ÷ logged pace" : `distance ÷ typical ${activity.label.toLowerCase()} pace`;
      durationConfidence = facts.pace || facts.speed ? 0.85 : 0.62;
    }
  }
  if (minutes == null && (activity.kind === "strength" || activity.kind === "bodyweight")) {
    const m = minutesFromSetScheme(facts.reps, facts.sets);
    if (m != null) {
      minutes = m;
      durationBasis = `${facts.sets ?? 1} set(s) × ${facts.reps ?? 10} reps at ${SECONDS_PER_REP}s/rep + ${SECONDS_REST_PER_SET}s rest`;
      // reps + sets describes the work done; sets alone does not — a bare
      // "3 sets" falls below the floor below and gets no calorie claim at all.
      durationConfidence = facts.reps != null ? (facts.sets != null ? 0.62 : 0.52) : 0.34;
    }
  }
  if (minutes == null || !(minutes > 0)) return null;

  // 4. Heart-rate equation when every input it needs is genuinely known.
  //    (Keytel et al. 2005 — the standard published regression.)
  if (
    facts.heartRate != null && facts.heartRate >= 60 && facts.heartRate <= 220 &&
    !usedDefaultWeight && ctx.ageYears != null && ctx.ageYears > 0 && ctx.sex
  ) {
    const hr = facts.heartRate, age = ctx.ageYears, kg = weightKg;
    const perMin = ctx.sex === "female"
      ? (-20.4022 + 0.4472 * hr - 0.1263 * kg + 0.074 * age) / 4.184
      : (-55.0969 + 0.6309 * hr + 0.1988 * kg + 0.2017 * age) / 4.184;
    if (perMin > 0) {
      const kcal = perMin * minutes;
      const confidence = Math.min(0.9, 0.75 * durationConfidence + 0.1);
      if (confidence >= MIN_CALORIE_CONFIDENCE) {
        return {
          value: roundCalories(kcal),
          estimated: true,
          basis: "heart_rate",
          method: `Heart-rate equation at ${Math.round(hr)} bpm × ${round1(minutes)} min (${whose})`,
          confidence,
          usedDefaultWeight,
        };
      }
    }
  }

  // 5. MET × weight × time.
  let met = metForIntensity(activity, facts.intensity);
  const notes: string[] = [];

  // Speed-aware METs for the activities where speed dominates expenditure.
  if (activity.kind === "cardio_distance" && facts.distanceMiles != null && minutes > 0) {
    const mph = facts.distanceMiles / (minutes / 60);
    const speedMet = speedMetFor(activity.id, mph);
    if (speedMet != null) { met = speedMet; notes.push(`${round1(mph)} mph`); }
  }
  // Lifting an external load is harder than the same scheme unloaded — and an
  // unloaded set scheme must not be priced as if a barbell were on it.
  // The downgrade needs EVIDENCE that the work was unloaded: a logged set
  // scheme with no resistance. A duration-only "Strength Training — 45 min"
  // says nothing about load, so it keeps the session-level moderate MET.
  const hasSetScheme = facts.reps != null || facts.sets != null;
  if (facts.intensity == null && hasSetScheme &&
      (activity.kind === "strength" || activity.kind === "bodyweight" || activity.kind === "isometric")) {
    met = facts.resistance ? activity.met.moderate : activity.met.light;
  }
  if (facts.incline != null && facts.incline > 0) met *= 1 + Math.min(facts.incline, 20) / 100;

  const kcal = metCalories(met, weightKg, minutes);
  if (!(kcal > 0)) return null;

  // Two independent discounts: how well we know the DURATION, and whether the
  // body weight is the owner's or a population stand-in.
  const confidence = Math.min(0.8, durationConfidence * (usedDefaultWeight ? 0.62 : 0.8));
  if (confidence < MIN_CALORIE_CONFIDENCE) return null;

  return {
    value: roundCalories(kcal),
    estimated: true,
    basis: durationBasis === "logged duration" ? "met_duration"
      : durationBasis.startsWith("distance") ? "met_distance" : "met_reps",
    method: `MET ${round1(met)}${notes.length ? ` (${notes.join(", ")})` : ""} × ${whose} × ${round1(minutes)} min — from ${durationBasis}`,
    confidence,
    usedDefaultWeight,
  };
}

/** Compendium speed brackets for the activities where pace dominates MET. */
function speedMetFor(activityId: string, mph: number): number | null {
  if (!Number.isFinite(mph) || mph <= 0) return null;
  if (activityId === "running") {
    if (mph >= 10) return 16;
    if (mph >= 8) return 13.5;
    if (mph >= 6.7) return 11;
    if (mph >= 6) return 9.8;
    if (mph >= 5) return 8.3;
    return 6;
  }
  if (activityId === "walking") {
    if (mph >= 4.5) return 6.3;
    if (mph >= 4) return 5;
    if (mph >= 3.5) return 4.3;
    if (mph >= 2.8) return 3.5;
    return 2.8;
  }
  if (activityId === "cycling") {
    if (mph >= 16) return 12;
    if (mph >= 14) return 10;
    if (mph >= 12) return 8;
    if (mph >= 10) return 6.8;
    return 4;
  }
  return null;
}

/** Calories are an estimate; render them at estimate-sized precision. */
function roundCalories(kcal: number): number {
  if (kcal < 10) return Math.round(kcal);
  if (kcal < 100) return Math.round(kcal);
  return Math.round(kcal / 5) * 5;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Owner body weight resolution
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_WEIGHT_KEYS = ["weight", "weightLbs", "weight_lbs", "bodyWeight", "body_weight", "weightKg", "weight_kg"];

/**
 * The body weight to use for an activity, taken from the ACTIVITY'S OWNER.
 *
 * Callers must pass the owner's profile — the person the entry belongs to
 * (`entry.profileId`, falling back to the tracker's linked profile) — NOT the
 * signed-in user. Sarah's basketball game is priced with Sarah's weight even
 * when Bob is the one looking at the dashboard.
 */
export function ownerBodyWeightKg(
  profile: { name?: string; fields?: Record<string, any> } | null | undefined,
): number | null {
  const f = profile?.fields || {};
  for (const key of PROFILE_WEIGHT_KEYS) {
    const raw = f[key];
    if (raw == null || raw === "") continue;
    const kg = parseBodyWeightToKg(raw, /kg/i.test(key));
    if (kg != null) return kg;
  }
  return null;
}

const PROFILE_AGE_KEYS = ["age", "ageYears"];
const PROFILE_DOB_KEYS = ["dateOfBirth", "date_of_birth", "dob", "birthday", "birthDate", "birth_date"];
const PROFILE_SEX_KEYS = ["sex", "gender", "biologicalSex"];

/**
 * Build the calorie context for the person an activity BELONGS TO.
 *
 * Callers resolve the owner (entry.profileId → the tracker's linked profile)
 * and pass that profile here. Passing the viewer's profile instead is the bug
 * this signature exists to make obvious: Sarah's workout must never be priced
 * with Bob's body weight because Bob happens to be the one looking.
 */
export function calorieContextForOwner(
  profile: { name?: string; fields?: Record<string, any> } | null | undefined,
  now: Date = new Date(),
): CalorieContext {
  const f = profile?.fields || {};
  const ctx: CalorieContext = {
    bodyWeightKg: ownerBodyWeightKg(profile),
    ownerLabel: profile?.name ?? null,
  };

  for (const k of PROFILE_AGE_KEYS) {
    const n = num(f[k]);
    if (n != null && n > 0 && n < 130) { ctx.ageYears = Math.round(n); break; }
  }
  if (ctx.ageYears == null) {
    for (const k of PROFILE_DOB_KEYS) {
      const raw = f[k];
      if (!raw) continue;
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) continue;
      const years = (now.getTime() - d.getTime()) / (365.2425 * 86400000);
      if (years > 0 && years < 130) { ctx.ageYears = Math.round(years); break; }
    }
  }
  for (const k of PROFILE_SEX_KEYS) {
    const v = String(f[k] ?? "").trim().toLowerCase();
    if (/^(m|male|man|boy)$/.test(v)) { ctx.sex = "male"; break; }
    if (/^(f|female|woman|girl)$/.test(v)) { ctx.sex = "female"; break; }
  }
  return ctx;
}

/**
 * "185", "185 lbs", "84 kg", "300 lb (136.1 kg)" → kilograms.
 *
 * The app stores a profile weight the way it was entered, and its own field
 * formatter writes the metric mirror in parentheses — real rows look like
 * "184.6 lbs (83.7 kg)". So this scans for the FIRST number that carries a
 * mass unit rather than requiring the whole string to be one; an anchored
 * parse silently returned null for those rows, and every activity belonging to
 * that person was then priced with the population default instead of their
 * actual body weight.
 *
 * A BARE number is read as pounds only when the field NAME did not say
 * kilograms — a unit-from-name decision, never a unit-from-magnitude one.
 */
const MASS_READING = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilograms?|kilos?|lbs?|pounds?|stone|st)\b/g;

export function parseBodyWeightToKg(raw: unknown, keyImpliesKg = false): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return keyImpliesKg ? raw : raw * KG_PER_LB;
  }
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // First unit-qualified reading wins: it is the value the user actually
  // typed, with any parenthetical conversion trailing it.
  MASS_READING.lastIndex = 0;
  for (let m = MASS_READING.exec(s); m; m = MASS_READING.exec(s)) {
    const n = Number(m[1].replace(",", "."));
    if (!Number.isFinite(n) || n <= 0) continue;
    const u = m[2];
    if (/^(kgs?|kilograms?|kilos?)$/.test(u)) return n;
    if (/^(stone|st)$/.test(u)) return n * 6.35029;
    return n * KG_PER_LB;
  }

  // No unit anywhere — a bare number, possibly with thousands separators.
  const bare = s.match(/^([\d,]+(?:\.\d+)?)$/);
  if (!bare) return null;
  const n = Number(bare[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return keyImpliesKg ? n : n * KG_PER_LB;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Deterministic display selection
// ─────────────────────────────────────────────────────────────────────────────

export interface FitnessPrimary { value: number; unit: string; metric: FitnessMetricKind }

export interface FitnessDisplay {
  activity: FitnessActivity;
  /** The headline measurement. Null when the entry holds no nameable metric. */
  primary: FitnessPrimary | null;
  /** Supporting lines, already formatted ("12 reps × 3 sets", "9:40 /mi"). */
  detail: string[];
  /** Calories line, or null when we declined to estimate. */
  calories: CalorieEstimate | null;
  /** One-sentence summary for the card body. */
  sentence: string;
}

const fmt = (n: number, maxDp = 1): string => {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
  return n.toLocaleString(undefined, { maximumFractionDigits: maxDp });
};

const plural = (n: number, one: string, many: string) => (Math.abs(n) === 1 ? one : many);

/** "12 reps × 3 sets" / "25 reps × 1 set" / "12 reps". Never mentions weight. */
export function formatRepScheme(facts: FitnessFacts): string | null {
  const parts: string[] = [];
  if (facts.reps != null) parts.push(`${fmt(facts.reps, 0)} ${plural(facts.reps, "rep", "reps")}`);
  if (facts.sets != null) parts.push(`${fmt(facts.sets, 0)} ${plural(facts.sets, "set", "sets")}`);
  return parts.length ? parts.join(" × ") : null;
}

/** "~18 cal burned" / "18 cal burned" when the user logged it. */
export function formatCalories(c: CalorieEstimate | null | undefined): string | null {
  if (!c) return null;
  return `${c.estimated ? "~" : ""}${c.value.toLocaleString()} cal burned`;
}

/**
 * Choose what a fitness card shows, from the activity and the facts ALONE.
 *
 * Priority, per activity kind:
 *   strength   → resistance (only if actually logged) → reps → sets → duration
 *   bodyweight → reps → duration → sets
 *   isometric  → duration → sets
 *   cardio_distance → distance → duration → steps
 *   cardio_duration / sport / flexibility → duration → distance
 *
 * `sets` is never promoted into the resistance slot, and resistance is never
 * invented: a card shows a weight if and only if a weight was recorded.
 */
export function buildFitnessDisplay(
  activity: FitnessActivity,
  facts: FitnessFacts,
  calories: CalorieEstimate | null,
): FitnessDisplay {
  const primary = pickPrimary(activity, facts);
  const detail: string[] = [];

  const scheme = formatRepScheme(facts);
  const showScheme = scheme && primary?.metric !== "reps";
  const schemeIsPrimaryLine = scheme && primary?.metric === "reps";

  if (primary?.metric === "resistance") {
    if (scheme) detail.push(scheme);
    if (facts.duration != null) detail.push(`${fmt(facts.duration)} min`);
  } else if (schemeIsPrimaryLine) {
    if (scheme) detail.push(scheme);
    if (facts.resistance) detail.push(`${fmt(facts.resistance.value)} ${facts.resistance.unit}`);
    if (facts.duration != null) detail.push(`${fmt(facts.duration)} min`);
  } else {
    if (facts.resistance) detail.push(`${fmt(facts.resistance.value)} ${facts.resistance.unit}`);
    if (showScheme && scheme) detail.push(scheme);
    if (primary?.metric !== "duration" && facts.duration != null) detail.push(`${fmt(facts.duration)} min`);
    if (primary?.metric !== "distance" && facts.distance) detail.push(`${fmt(facts.distance.value, 2)} ${facts.distance.unit}`);
  }
  if (facts.steps != null && primary?.metric !== "steps") detail.push(`${Math.round(facts.steps).toLocaleString()} steps`);
  if (facts.exerciseCount != null) detail.push(`${fmt(facts.exerciseCount, 0)} ${plural(facts.exerciseCount, "exercise", "exercises")}`);
  if (facts.laps != null) detail.push(`${fmt(facts.laps, 0)} ${plural(facts.laps, "lap", "laps")}`);
  if (facts.heartRate != null) detail.push(`${Math.round(facts.heartRate)} bpm`);

  const calLine = formatCalories(calories);
  // The headline is already on the card, so the sentence repeats it only when
  // no detail line already carries it — otherwise a reps-led card reads
  // "12 reps · 12 reps × 3 sets".
  const primaryToken = primary ? `${fmt(primary.value)} ${primary.unit}` : null;
  const primaryCovered = !!primaryToken && detail.some((d) => d === primaryToken || d.startsWith(`${primaryToken} ×`));
  const sentence = [
    primaryCovered ? null : primaryToken,
    ...detail,
    calLine,
  ].filter(Boolean).join(" · ");

  return { activity, primary, detail, calories, sentence };
}

function pickPrimary(activity: FitnessActivity, f: FitnessFacts): FitnessPrimary | null {
  const resistance = f.resistance ? { value: f.resistance.value, unit: f.resistance.unit, metric: "resistance" as const } : null;
  const reps = f.reps != null ? { value: f.reps, unit: FITNESS_METRIC_UNIT.reps, metric: "reps" as const } : null;
  const sets = f.sets != null ? { value: f.sets, unit: FITNESS_METRIC_UNIT.sets, metric: "sets" as const } : null;
  const duration = f.duration != null ? { value: f.duration, unit: FITNESS_METRIC_UNIT.duration, metric: "duration" as const } : null;
  const distance = f.distance ? { value: f.distance.value, unit: f.distance.unit, metric: "distance" as const } : null;
  const steps = f.steps != null ? { value: f.steps, unit: FITNESS_METRIC_UNIT.steps, metric: "steps" as const } : null;
  const cals = f.caloriesLogged != null ? { value: f.caloriesLogged, unit: FITNESS_METRIC_UNIT.caloriesBurned, metric: "caloriesBurned" as const } : null;

  const order: Array<FitnessPrimary | null> =
      activity.kind === "strength"        ? [resistance, reps, sets, duration, distance, cals]
    : activity.kind === "bodyweight"      ? [reps, duration, sets, resistance, cals]
    : activity.kind === "isometric"       ? [duration, sets, reps, cals]
    : activity.kind === "cardio_distance" ? [distance, duration, steps, cals]
    : /* duration-shaped */                 [duration, distance, steps, reps, cals];

  return order.find(Boolean) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. One-call convenience wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface FitnessEntryInput {
  trackerName?: string | null;
  category?: string | null;
  fields?: FitnessField[] | null;
  values: Record<string, any>;
  /**
   * Provenance from shared/estimation-engine, as persisted on the entry
   * (`computed.enrichment`) or still riding in `values._enrichment`. Used to
   * tell a user-stated calorie count from a mirrored estimate.
   */
  enrichment?: EnrichmentProvenance | null;
}

/**
 * The calorie number for an entry that has already been STORED.
 *
 * Aggregates ("342 calories burned today"), history rows and the dashboard all
 * read entries back out of the database, and must agree with the card sitting
 * next to them. Precedence:
 *
 *   1. `computed.caloriesBurnedSource` present → this estimator wrote it; trust
 *      it verbatim (and it is already the same number a recompute would give).
 *   2. otherwise recompute from the entry's own facts — which is how rows
 *      written before the estimator existed start reading correctly WITHOUT
 *      rewriting a single stored row.
 *   3. only if a recompute is not possible, fall back to whatever legacy
 *      `computed.caloriesBurned` the old per-activity formulas left behind,
 *      clearly marked as an estimate of unknown provenance.
 */
export function caloriesForStoredEntry(
  tracker: { name?: string | null; category?: string | null; fields?: FitnessField[] | null },
  entry: { values?: Record<string, any> | null; computed?: Record<string, any> | null } | null | undefined,
  ctx: CalorieContext = {},
): CalorieEstimate | null {
  if (!entry) return null;
  const computed = entry.computed || {};
  if (computed.caloriesBurnedSource && typeof computed.caloriesBurned === "number") {
    return {
      value: computed.caloriesBurned,
      estimated: computed.caloriesBurnedSource === "estimated",
      basis: computed.caloriesBurnedSource === "estimated" ? "met_duration" : "logged",
      method: computed.caloriesBurnedMethod || "",
      confidence: typeof computed.caloriesBurnedConfidence === "number" ? computed.caloriesBurnedConfidence : 1,
      usedDefaultWeight: !!computed.caloriesUsedDefaultWeight,
    };
  }
  const fresh = analyzeFitnessEntry({
    trackerName: tracker.name,
    category: tracker.category,
    fields: tracker.fields,
    values: entry.values || {},
    enrichment: computed.enrichment ?? null,
  }, ctx).calories;
  if (fresh) return fresh;
  if (typeof computed.caloriesBurned === "number" && computed.caloriesBurned > 0) {
    return {
      value: Math.round(computed.caloriesBurned),
      estimated: true,
      basis: "met_duration",
      method: "Estimated when this entry was logged",
      confidence: 0.4,
      usedDefaultWeight: true,
    };
  }
  return null;
}

/**
 * Read an entry end-to-end: classify, extract facts, price the calories, and
 * decide the display. THE entry point every surface should use.
 */
export function analyzeFitnessEntry(input: FitnessEntryInput, ctx: CalorieContext = {}): FitnessDisplay {
  // A logged `exercise`/`activityType` names the movement more precisely than
  // the tracker does ("Workout" tracker, entry says "squats").
  const stated = [input.values?.exercise, input.values?.activityType, input.values?.activity]
    .find((s): s is string => typeof s === "string" && s.trim() !== "");
  let activity = classifyFitnessActivity(input.trackerName, input.category);
  if (activity.kind === "non_fitness" || activity.kind === "generic_workout") {
    const fromValue = stated ? classifyFitnessActivity(stated, input.category) : null;
    if (fromValue && fromValue.kind !== "non_fitness") activity = fromValue;
  }
  const enrichment = input.enrichment ?? (input.values as any)?._enrichment ?? null;
  const facts = readFitnessFacts(input.values, activity, input.fields, enrichment);
  const calories = estimateCaloriesBurned(activity, facts, ctx);
  return buildFitnessDisplay(activity, facts, calories);
}
