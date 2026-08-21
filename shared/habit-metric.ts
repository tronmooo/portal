// shared/habit-metric.ts — is this habit MEASURABLE, and by which tracker?
//
// The habit ↔ tracker separation (user directive 2026-08-20):
//
//   · A habit records consistency: was today's target met, what's the streak.
//   · A tracker records the measurement: ounces, miles, minutes, intensity —
//     richer data than the habit ever needs.
//   · "Drink 64 oz water daily"  → Water habit  + Hydration tracker, linked.
//   · "Run 3 miles 3x per week"  → Running habit + Running tracker, linked.
//   · "Make my bed every morning" → habit ONLY. Nothing to measure beyond
//     completion, so no tracker is manufactured for it.
//   · Tracking something never makes it a habit; weight, mood, and expenses
//     are tracked with no habit pointing at them.
//
// This module answers ONE question, purely and without I/O: given a habit's
// name (and the user's message), does the habit measure something — and if so,
// what tracker NAMES could carry that measurement, in preference order? The
// caller (server/ai-engine.ts create_habit) matches those candidates against
// EXISTING trackers via shared/tracker-identity before ever creating one, so a
// second water habit reconnects to the existing Hydration tracker instead of
// spawning "Water (2)".
//
// Deliberately conservative: when nothing here recognizes a measurement, the
// answer is null and the habit stays a plain habit. A false "not measurable"
// costs one manual link; a false "measurable" litters the tracker list with
// pointless completion mirrors — the failure mode this design exists to avoid.
//
// Pinned by tests/habit-tracker-link.test.ts.

import { classifyEntity, type TrackerCategory } from "./entity-classify";
import { habitTokens } from "./habit-match";

export interface HabitMetricField {
  name: string;
  type: "number" | "text" | "boolean" | "select" | "duration";
  unit?: string;
  isPrimary?: boolean;
}

export interface HabitMetricSuggestion {
  /** Tracker names that could carry this measurement, best first. The caller
   * identity-matches EVERY candidate against existing trackers before
   * creating candidates[0]. */
  candidates: string[];
  category: TrackerCategory;
  /** Field definitions used ONLY if a new tracker must be created. */
  fields: HabitMetricField[];
  /** What recognized the measurement (for logs/tests). */
  source: "canonical" | "quantity" | "classifier";
}

/** Canonical metric map: activity keyword → the tracker that measures it.
 * Candidate lists double as alias sets — "Water" matches an existing tracker
 * named Water OR Hydration, and vice versa. */
const CANONICAL_METRICS: Array<{
  match: RegExp;
  candidates: string[];
  category: TrackerCategory;
  fields: HabitMetricField[];
}> = [
  {
    match: /\b(water|hydrate|hydration|oz\b|ounces?)\b/i,
    candidates: ["Hydration", "Water"],
    category: "health",
    fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
  },
  {
    match: /\b(run|runs|running|jog|jogging)\b/i,
    candidates: ["Running"],
    category: "fitness",
    fields: [
      { name: "distance", type: "number", unit: "mi", isPrimary: true },
      { name: "duration", type: "number", unit: "min" },
      { name: "intensity", type: "text" },
    ],
  },
  {
    match: /\b(walk|walks|walking|steps?)\b/i,
    candidates: ["Walking", "Steps"],
    category: "fitness",
    fields: [
      { name: "steps", type: "number", unit: "steps", isPrimary: true },
      { name: "distance", type: "number", unit: "mi" },
      { name: "duration", type: "number", unit: "min" },
    ],
  },
  {
    match: /\b(meditate|meditation|meditating|mindfulness)\b/i,
    candidates: ["Meditation"],
    category: "mental",
    fields: [{ name: "duration", type: "number", unit: "min", isPrimary: true }],
  },
  {
    match: /\b(read|reads|reading)\b/i,
    candidates: ["Reading"],
    category: "lifestyle",
    fields: [
      { name: "minutes", type: "number", unit: "min", isPrimary: true },
      { name: "pages", type: "number", unit: "pages" },
    ],
  },
  {
    match: /\b(sleep|sleeping)\b/i,
    candidates: ["Sleep"],
    category: "sleep",
    fields: [
      { name: "hours", type: "number", unit: "hrs", isPrimary: true },
      { name: "quality", type: "text" },
    ],
  },
  {
    match: /\b(work\s?out|workouts?|exercise|exercising|gym|lift|lifting|strength|train|training)\b/i,
    candidates: ["Exercise", "Workout"],
    category: "fitness",
    fields: [
      { name: "activityType", type: "text", isPrimary: true },
      { name: "duration", type: "number", unit: "min" },
      { name: "intensity", type: "text" },
    ],
  },
];

/** Umbrella trackers per category: an existing general-purpose tracker the
 * habit should EXPAND rather than shadow with a near-duplicate. An "Exercise"
 * tracker already absorbs running, soccer, lifting — a new Running tracker
 * beside it would split the data. Only consulted when no direct identity
 * match exists; never created by this flow. */
export const UMBRELLA_TRACKER_NAMES: Partial<Record<TrackerCategory, string[]>> = {
  fitness: ["Exercise", "Workout", "Workouts", "Fitness", "Activity"],
  nutrition: ["Nutrition", "Calories", "Food"],
};

/** A stated quantity+unit means the habit measures something even when the
 * activity itself isn't recognized ("juggle for 10 minutes daily"). */
const QUANTITY_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:oz|ounces?|ml|liters?|litres?|l\b|cups?|glasses?|bottles?|miles?|mi\b|km|kilometers?|kilometres?|steps?|minutes?|mins?|min\b|hours?|hrs?|pages?|reps?|sets?|laps?|mg|mcg|grams?|g\b|calories?|cals?|kcal|lbs?|pounds?|kg)\b/i;

/** Frequency/verb noise that must not survive into a tracker name:
 * "Drink 64 oz of water daily" → "Water". */
const NAME_NOISE_RE =
  /\b(drink|drinks|drinking|eat|eating|take|takes|taking|do|does|doing|go|goes|going|practice|practicing|practise|every|each|per|daily|weekly|nightly|morning|evening|night|day|days|week|weeks|time|times|a|an|the|my|of|for|at|to|x\d+|\d+x)\b/gi;

/** Reduce a habit name to the THING being measured, for use as a tracker name.
 * Strips quantities, units, verbs and frequency words, then title-cases. */
export function habitMetricNoun(habitName: string): string {
  const stripped = String(habitName || "")
    .replace(QUANTITY_RE, " ")
    .replace(/\b\d+(?:[.,]\d+)?\b/g, " ")
    .replace(NAME_NOISE_RE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  return stripped
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Categories where a recognized activity is genuinely measurable. "lifestyle"
 * is NOT here on purpose: its keyword bucket catches chores and routines
 * ("cleaning", "bed", "chores") that measure nothing beyond completion. */
const MEASURABLE_CATEGORIES = new Set<TrackerCategory>([
  "fitness", "health", "nutrition", "sleep", "mental", "medication",
]);

/**
 * Decide whether a habit measures something, and which tracker names could
 * carry the measurement. Returns null for completion-only habits.
 *
 * Recognition ladder, first hit wins:
 *   1. canonical metric map (water → Hydration, run → Running, …)
 *   2. an explicit quantity+unit in the habit name or the user's message
 *      ("64 oz", "3 miles", "10 minutes") — measurable by declaration
 *   3. the entity classifier recognizing the activity as a measurable
 *      category with real (dictionary/keyword) confidence
 */
export function detectHabitMetric(
  habitName: string,
  userMessage?: string,
): HabitMetricSuggestion | null {
  const name = String(habitName || "");
  const message = String(userMessage || "");
  if (!name.trim()) return null;

  const noun = habitMetricNoun(name);

  // 1. Canonical map — try the habit name first, then the message. The habit
  // name is the model's own summary of the commitment, so it wins conflicts.
  for (const text of [name, message]) {
    if (!text) continue;
    for (const m of CANONICAL_METRICS) {
      if (!m.match.test(text)) continue;
      // SPECIFICITY GUARD. The canonical metric for "walk" is Walking — right
      // for "Walk 10,000 steps", wrong for "Walk the Dog", which is a
      // particular walk. Linking the dog-walk habit to a generic Walking
      // tracker means any recorded walk completes it, and "I walked for twenty
      // minutes" then falsely finishes the dog's walk (user's own
      // counter-example). When the habit's name carries a word the canonical
      // one doesn't, the habit keeps its own tracker.
      const specific = noun && habitTokens(noun).some(
        (t) => !m.candidates.some((c) => habitTokens(c).includes(t)),
      );
      const candidates = specific ? [name.trim(), noun, ...m.candidates] : [...m.candidates];
      return {
        candidates,
        category: m.category,
        fields: m.fields.map((f) => ({ ...f })),
        source: "canonical",
      };
    }
  }

  // 2. Explicit quantity in either text: the user themselves stated a
  // measurement, so track the cleaned-up subject even if we don't know it.
  if (noun && (QUANTITY_RE.test(name) || QUANTITY_RE.test(message))) {
    const cls = classifyEntity(noun);
    return {
      candidates: [noun],
      category: cls.confidence !== "none" ? cls.category : "custom",
      fields: [{ name: "amount", type: "number", isPrimary: true }],
      source: "quantity",
    };
  }

  // 3. Classifier: a known measurable entity (a medication, an exercise, a
  // sport) is measurable even with no quantity stated.
  if (noun) {
    const cls = classifyEntity(noun);
    if (cls.confidence !== "none" && MEASURABLE_CATEGORIES.has(cls.category)) {
      const fields: HabitMetricField[] =
        cls.category === "medication"
          ? [
              { name: "dosage", type: "number", isPrimary: true },
              { name: "unit", type: "text" },
              { name: "taken", type: "boolean" },
            ]
          : [
              { name: "duration", type: "number", unit: "min", isPrimary: true },
              { name: "intensity", type: "text" },
            ];
      return { candidates: [noun], category: cls.category, fields, source: "classifier" };
    }
  }

  // Completion-only: measure nothing, manufacture nothing.
  return null;
}
