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
import { canonicalFieldKey } from "./field-aliases";

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

// Loaded carries: the load is the metric, distance/time are secondary.
const CARRY_SHAPE: TrackerField[] = [
  { name: "weight",   type: "number", unit: "lbs", isPrimary: true },
  { name: "distance", type: "number", unit: "ft" },
  { name: "duration", type: "number", unit: "sec" },
  { name: "sets",     type: "number", unit: "sets" },
];

// Machine / class cardio where TIME is what the user actually logs
// (elliptical, stair climber, jump rope, HIIT, spin, rucking).
const CARDIO_MACHINE_SHAPE: TrackerField[] = [
  { name: "duration",       type: "number", unit: "min", isPrimary: true },
  { name: "distance",       type: "number", unit: "mi" },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
  { name: "heart_rate",     type: "number", unit: "bpm" },
];

// Rowing ergometer — meters, not miles.
const ROW_ERG_SHAPE: TrackerField[] = [
  { name: "distance",       type: "number", unit: "m", isPrimary: true },
  { name: "duration",       type: "number", unit: "min" },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
];

// Sports & classes: duration + effort. Covers everything from basketball to
// jiu-jitsu to pilates, so a sport logged from chat never lands on a bare
// "value" field.
const SPORT_SHAPE: TrackerField[] = [
  { name: "duration",       type: "number", unit: "min", isPrimary: true },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
  { name: "intensity",      type: "select", options: ["light", "moderate", "intense"] },
  { name: "heart_rate",     type: "number", unit: "bpm" },
];

// The generic "Lifting"/"Weights" bucket — correct only when the user names no
// exercise. It needs duration too, since a bucket log is usually "lifted for
// 45 minutes" rather than a specific set.
const LIFT_BUCKET_SHAPE: TrackerField[] = [
  { name: "weight",   type: "number", unit: "lbs", isPrimary: true },
  { name: "reps",     type: "number", unit: "reps" },
  { name: "sets",     type: "number", unit: "sets" },
  { name: "duration", type: "number", unit: "min" },
];

const MILEAGE_SHAPE: TrackerField[] = [
  { name: "miles", type: "number", unit: "mi", isPrimary: true },
];

const EXPENSE_SHAPE: TrackerField[] = [
  { name: "amount",   type: "number", unit: "$", isPrimary: true },
  { name: "category", type: "text" },
  { name: "merchant", type: "text" },
];

// Medication & supplement (adherence). The dose form (tablet/softgel/capsule)
// lives in `unit`; numeric strength is `dosage`. The presence of dosage +
// adherence/drug is what makes classifyTrackerPresentation treat this as an
// adherence tracker (dose grid + streak), NOT a physical-quantity metric. This
// is why "Fish Oil"/"Multivitamin"/"Amoxicillin" must land here and never on a
// vehicle shape like oil_change (the "Fish Oil → qt" bug).
const MEDICATION_SHAPE: TrackerField[] = [
  { name: "drug",      type: "text", isPrimary: true },
  { name: "dosage",    type: "number", unit: "mg" },
  { name: "unit",      type: "text" },   // dose form: tablet / softgel / capsule / IU
  { name: "frequency", type: "text" },
  { name: "adherence", type: "select", options: ["taken", "skipped", "missed"] },
  { name: "timeTaken", type: "text" },
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
  // --- Medication & supplements (FIRST so dose items beat domain collisions
  //     like oil_change's "oil" matching "Fish Oil", or "b" lifts). These are
  //     adherence trackers, never physical-quantity metrics. ----------------
  { id: "supplement",   fields: MEDICATION_SHAPE, patterns: [
    "fish oil", "omega", "multivitamin", "vitamin", "creatine", "magnesium",
    "zinc", "melatonin", "probiotic", "biotin", "collagen", "glucosamine",
    "turmeric", "ashwagandha", "supplement", "softgel", "fiber gummy",
  ] },
  { id: "medication",   fields: MEDICATION_SHAPE, patterns: [
    "amoxicillin", "lisinopril", "metformin", "atorvastatin", "statin",
    "adderall", "ozempic", "insulin", "ibuprofen", "tylenol", "acetaminophen",
    "advil", "aspirin", "prednisone", "amlodipine", "omeprazole", "gabapentin",
    "antibiotic", "prescription", "medication",
  ] },
  // --- Specific lifts ------------------------------------------------------
  // NOTE on patterns: bare "press", "row" and "curl" are NOT usable as
  // patterns — "press" would swallow "Blood Pressure", "row" would swallow
  // "Rowing", "curl" would swallow "Curling". Plural forms ("presses",
  // "rows", "curls") are safe because the colliding words don't contain them,
  // so every family lists explicit compounds PLUS the plural catch-all.
  { id: "bench_press",  fields: LIFT_SHAPE, patterns: ["bench press", "bench-press", "bench"] },
  { id: "squat",        fields: LIFT_SHAPE, patterns: ["squat"] },
  { id: "deadlift",     fields: LIFT_SHAPE, patterns: ["deadlift", "rdl", "romanian dead", "stiff leg dead", "sumo dead"] },
  { id: "press",        fields: LIFT_SHAPE, patterns: [
    "overhead press", "shoulder press", "ohp", "military press", "arnold press",
    "incline press", "decline press", "chest press", "dumbbell press",
    "machine press", "floor press", "landmine press", "push press", "z press",
    "leg press", "presses",
  ] },
  { id: "row",          fields: LIFT_SHAPE, patterns: [
    "barbell row", "bent over row", "bent-over row", "pendlay row", "dumbbell row",
    "seated row", "cable row", "t-bar row", "t bar row", "chest supported row",
    "inverted row", "upright row", "machine row", "rows",
  ] },
  { id: "curl",         fields: LIFT_SHAPE, patterns: [
    "bicep curl", "barbell curl", "dumbbell curl", "hammer curl", "preacher curl",
    "concentration curl", "cable curl", "ez bar curl", "incline curl", "spider curl",
    "wrist curl", "leg curl", "hamstring curl", "drag curl", "curls",
  ] },
  { id: "pulldown",     fields: LIFT_SHAPE, patterns: ["lat pulldown", "pulldown", "pull down", "pullover", "pull-over"] },
  { id: "fly",          fields: LIFT_SHAPE, patterns: ["chest fly", "cable fly", "pec deck", "reverse fly", "rear delt fly", "flyes"] },
  { id: "raise",        fields: LIFT_SHAPE, patterns: [
    "lateral raise", "side raise", "front raise", "rear delt raise", "calf raise",
  ] },
  { id: "extension",    fields: LIFT_SHAPE, patterns: [
    "tricep extension", "triceps extension", "overhead extension", "skull crusher",
    "skullcrusher", "tricep pushdown", "pushdown", "kickback", "leg extension",
    "back extension", "hyperextension",
  ] },
  { id: "hinge",        fields: LIFT_SHAPE, patterns: [
    "hip thrust", "glute bridge", "good mornings", "shrug", "face pull",
    "kettlebell swing", "kb swing", "hack squat", "smith machine", "lunge",
    "split squat", "step-up", "step up", "sled push", "sled drag", "prowler",
  ] },
  { id: "olympic",      fields: LIFT_SHAPE, patterns: [
    "power clean", "hang clean", "clean and jerk", "clean & jerk", "snatch",
    "thruster", "push jerk", "split jerk", "turkish get", "muscle up", "muscle-up",
  ] },
  { id: "carry",        fields: CARRY_SHAPE, patterns: ["farmer carry", "farmers carry", "farmer's carry", "suitcase carry", "loaded carry", "yoke walk"] },
  // Generic "Lifting" / "Weights" — same lift shape. MUST stay after every
  // specific lift above so a named exercise never falls through to it.
  { id: "lifting",      fields: LIFT_BUCKET_SHAPE, patterns: ["lifting", "weight lifting", "weightlifting", "weights", "strength"] },
  // --- Bodyweight: rep-counted ---------------------------------------------
  { id: "pushup",       fields: PUSHUP_SHAPE, patterns: [
    "push-up", "pushup", "push up", "pull-up", "pullup", "pull up",
    "chin-up", "chinup", "chin up", "dip", "burpee", "jumping jack",
    "air squat", "box jump", "mountain climber", "crunch", "sit-up", "sit up",
    "situp", "russian twist", "leg raise", "knee raise", "toes to bar",
    "ab wheel", "flutter kick", "bicycle crunch", "v-up", "superman",
  ] },
  // --- Bodyweight: timed holds ---------------------------------------------
  { id: "plank",        fields: PLANK_SHAPE, patterns: ["plank", "wall sit", "dead hang", "l-sit", "l sit", "hollow hold", "isometric hold"] },
  // --- Cardio --------------------------------------------------------------
  { id: "running",      fields: RUN_SHAPE, patterns: ["running", "run", "jog", "jogging", "treadmill", "sprint"] },
  { id: "cycling",      fields: RIDE_SHAPE, patterns: ["cycling", "biking", "bike ride", "bicycle", "spin class", "spinning", "peloton"] },
  { id: "swimming",     fields: SWIM_SHAPE, patterns: ["swimming", "swim", "laps"] },
  { id: "hiking",       fields: RIDE_SHAPE, patterns: ["hiking", "hike", "trail walk", "rucking", "ruck"] },
  { id: "row_erg",      fields: ROW_ERG_SHAPE, patterns: ["rowing machine", "row machine", "rowing", "erg", "ergometer", "rower", "ski erg", "skierg"] },
  { id: "cardio_machine", fields: CARDIO_MACHINE_SHAPE, patterns: [
    "elliptical", "stair climber", "stairmaster", "stair stepper", "jump rope",
    "jumprope", "skipping rope", "hiit", "circuit training", "battle rope",
    "assault bike", "airdyne", "versaclimber",
  ] },
  // --- Sports & classes ----------------------------------------------------
  { id: "sport",        fields: SPORT_SHAPE, patterns: [
    "basketball", "tennis", "soccer", "football", "baseball", "softball", "golf",
    "pickleball", "volleyball", "badminton", "racquetball", "squash", "handball",
    "boxing", "martial art", "karate", "judo", "jiu jitsu", "jiu-jitsu", "bjj",
    "muay thai", "wrestling", "hockey", "lacrosse", "rugby", "cricket", "polo",
    "skiing", "snowboard", "surfing", "skateboard", "rock climbing", "bouldering",
    "pilates", "barre", "crossfit", "zumba", "dance class", "kickball", "frisbee",
    "curling", "bowling", "fencing", "archery", "gymnastics", "cheer",
  ] },
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
  // --- Vehicle / asset (PR S) ---------------------------------------------
  // Tire pressure: per-tire PSI. Primary is pressure (PSI), with optional
  // position label (FL/FR/RL/RR) and notes.
  { id: "tire_pressure", fields: [
    { name: "pressure", type: "number", unit: "PSI", isPrimary: true },
    { name: "position", type: "text", options: ["FL", "FR", "RL", "RR", "All"] },
  ], patterns: ["tire pressure", "tyre pressure"] },
  { id: "fuel",       fields: [
    { name: "gallons", type: "number", unit: "gal", isPrimary: true },
    { name: "cost",    type: "number", unit: "$" },
    { name: "odometer", type: "number", unit: "mi" },
  ], patterns: ["fuel", "gas fill", "gas mileage", "mpg"] },
  { id: "odometer",   fields: [
    { name: "odometer", type: "number", unit: "mi", isPrimary: true },
  ], patterns: ["odometer", "odo "] },
  { id: "oil_change", fields: [
    { name: "quarts",   type: "number", unit: "qt", isPrimary: true },
    { name: "odometer", type: "number", unit: "mi" },
    { name: "oil_type", type: "text" },
  // NOTE: a bare "oil" pattern used to match "Fish Oil" and assign motor-oil
  // quarts (qt). Require explicit vehicle/maintenance context instead.
  ], patterns: ["oil change", "motor oil", "engine oil"] },
  { id: "ev_charge",  fields: [
    { name: "battery",  type: "number", unit: "%", isPrimary: true },
    { name: "kwh",      type: "number", unit: "kWh" },
    { name: "range",    type: "number", unit: "mi" },
  ], patterns: ["charge", "battery level", "state of charge"] },
  { id: "vehicle_service", fields: [
    { name: "odometer", type: "number", unit: "mi", isPrimary: true },
    { name: "service",  type: "text" },
    { name: "cost",     type: "number", unit: "$" },
  ], patterns: ["vehicle maintenance", "vehicle service", "car maintenance", "car service", "service"] },
];

/**
 * Last-resort shape inference from an ENTRY's VALUES, for subjects the name
 * catalog has never heard of — "Jefferson Curl", "Zercher Carry", "Sandbag Over
 * Shoulder", whatever the user invents next. The shape of the numbers is enough
 * to tell a lift from a rep-out from a timed hold, so an unknown exercise still
 * gets real units instead of a bare unit-less column.
 *
 * Returns null when the values don't look like exercise at all.
 */
export function inferShapeFromValues(values: Record<string, any> | null | undefined): TrackerField[] | null {
  if (!values || typeof values !== "object") return null;
  const num = (k: string) => {
    const v = (values as any)[k];
    return typeof v === "number" ? isFinite(v)
      : typeof v === "string" ? /^\s*[-+]?\d/.test(v)
      : false;
  };
  // Canonicalize incoming keys first so weightLbs/repetitions/setCount count.
  const canon = new Set(Object.keys(values).map(k => canonicalFieldKey(k)));
  const hasNum = (canonName: string) =>
    canon.has(canonName) && Object.keys(values).some(k => canonicalFieldKey(k) === canonName && num(k));

  if (hasNum("weight") && hasNum("reps")) return LIFT_SHAPE.map(f => ({ ...f }));
  if (hasNum("reps")) return PUSHUP_SHAPE.map(f => ({ ...f }));
  if (hasNum("duration") && (canon.has("caloriesBurned") || canon.has("intensity") || canon.has("heart_rate"))) {
    return SPORT_SHAPE.map(f => ({ ...f }));
  }
  return null;
}

/**
 * The field list a BRAND-NEW tracker should be created with, given its name,
 * category and the first entry's values.
 *
 * Before this existed, the auto-create path in the AI engine built fields
 * verbatim from the value keys with NO units — so a lift logged as
 * { activityType, weightLbs, reps, sets } created a unit-less `weightLbs`
 * column and the card read "45 weightLbs" (user screenshot 2026-07-26). Now the
 * canonical shape wins, value keys that alias into it are dropped rather than
 * duplicated, and anything genuinely extra (activityType, notes) is appended.
 */
export function shapeForNewTracker(
  name: string,
  category: string | undefined,
  values: Record<string, any> | null | undefined,
): TrackerField[] {
  const keys = Object.keys(values || {}).filter(k => k !== "_notes" && !k.startsWith("_"));
  const valueFields: TrackerField[] = keys.map(k => ({
    name: k,
    type: (typeof (values as any)[k] === "number" ? "number" : "text") as TrackerField["type"],
  }));
  const base = inferTrackerShape(name, category) || inferShapeFromValues(values);
  if (!base || base.length === 0) return valueFields;
  const covered = new Set(base.map(f => String(f.name).toLowerCase()));
  const extras = valueFields.filter(f => {
    const lc = f.name.toLowerCase();
    // Drop both an exact hit and an alias hit — the normalizer folds
    // weightLbs → weight, so a separate weightLbs column would stay empty.
    return !covered.has(lc) && !covered.has(canonicalFieldKey(lc));
  });
  return [...base.map(f => ({ ...f })), ...extras];
}

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

  // Domain guard: vehicle/maintenance shapes (which carry units like qt/PSI/gal)
  // must NEVER be applied to a health-domain tracker just because a name
  // substring collides. "Fish Oil" is category supplement, not a car.
  const VEHICLE_SHAPES = new Set(["oil_change", "fuel", "odometer", "ev_charge", "vehicle_service", "tire_pressure", "mileage"]);
  const HEALTH_DOMAIN = new Set(["medication", "prescription", "supplement", "health", "nutrition", "fitness", "mental", "sleep"]);
  const isHealthDomain = HEALTH_DOMAIN.has(cat);

  for (const entry of CATALOG) {
    if (entry.category && entry.category !== cat) continue;
    if (isHealthDomain && VEHICLE_SHAPES.has(entry.id)) continue;
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
