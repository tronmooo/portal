// shared/lifting-scope.ts
// =============================================================================
// Per-exercise field scoping for lifting/strength logs — pure, no I/O, no LLM.
// =============================================================================
//
// User report 2026-07-25:
//   "Dumbbells I did 45 pounds 10 reps each three times I ran a mile bench
//    pressed 145 pounds 10 reps each and I walked for a mile"
// produced TWO lifting entries where BOTH claimed 3 sets. "three times" belongs
// only to the dumbbell clause — the model carried it forward onto the next
// exercise (and the prompt's own multi-exercise example demonstrated exactly
// that leak: `incline dumbbells 40lb` was shown with an inherited `sets:3`).
//
// The fix is deterministic and does not trust the model's field grouping: split
// the user's own sentence into per-exercise segments, re-derive weight / reps /
// sets from ONLY the segment that belongs to this exercise, and drop any field
// the segment does not support. Every exercise gets a FRESH object — nothing is
// copied from, or shared with, the previous exercise.
//
// Cardio is untouched: running/walking/cycling/swimming entries never reach
// here (isLiftingEntry returns false for them), so the estimation engine's
// walk/run behaviour is unchanged.
//
// Pinned by tests/lifting-scope.test.ts.
// =============================================================================

/** The four scoped lifting fields. `null` means "the user did not say". */
export interface LiftingFields {
  weight: number | null;
  weightUnit: "lb" | "kg" | null;
  reps: number | null;
  sets: number | null;
}

/** One exercise mention in the user's message plus the text scoped to it. */
export interface LiftingSegment extends LiftingFields {
  /** The exercise phrase as the user wrote it ("bench pressed", "Dumbbells"). */
  exercise: string;
  /** The clause this exercise owns — from its own mention up to the next
   *  exercise mention or the next non-lifting activity. */
  text: string;
  /** Offset of the exercise mention in the source message. */
  index: number;
}

/** A lifting record in display/assertion shape. Missing fields are null. */
export interface LiftingRecord extends LiftingFields {
  exerciseName: string;
}

// ── Number parsing ───────────────────────────────────────────────────────────

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};

/** Digits or a spelled-out number word (one … twenty). */
const NUM = `\\d{1,4}(?:\\.\\d+)?|${Object.keys(NUM_WORDS).join("|")}`;

function toNum(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s in NUM_WORDS) return NUM_WORDS[s];
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// ── Exercise + boundary lexicons ─────────────────────────────────────────────

/** Lifting/strength movements. Longest phrases first so "bench press" wins
 *  over a bare "press". Each entry is a regex source fragment. */
const EXERCISE_PATTERNS = [
  "bench\\s*press(?:ed|es|ing)?",
  "incline\\s*(?:dumbbell\\s*)?press(?:ed|es|ing)?",
  "decline\\s*press(?:ed|es|ing)?",
  "overhead\\s*press(?:ed|es|ing)?",
  "shoulder\\s*press(?:ed|es|ing)?",
  "military\\s*press(?:ed|es|ing)?",
  "chest\\s*press(?:ed|es|ing)?",
  "leg\\s*press(?:ed|es|ing)?",
  "leg\\s*(?:extension|curl)s?",
  "lat\\s*pull\\s*downs?",
  "pull\\s*downs?",
  "hip\\s*thrusts?",
  "calf\\s*raises?",
  "tricep(?:s)?\\s*(?:extension|pushdown)s?",
  "bicep(?:s)?\\s*curls?",
  "hammer\\s*curls?",
  "front\\s*raises?",
  "lateral\\s*raises?",
  "face\\s*pulls?",
  "power\\s*cleans?",
  "clean\\s*and\\s*jerks?",
  "dumbbell(?:s)?",
  "barbell(?:s)?",
  "kettlebell(?:s)?",
  "bench(?:ed|es|ing)?",
  "squat(?:s|ted|ting)?",
  "deadlift(?:s|ed|ing)?",
  "curl(?:s|ed|ing)?",
  "shrug(?:s|ged)?",
  "lunge(?:s|d)?",
  "row(?:s|ed|ing)?",
  "fly(?:e?s)?",
  "pull\\s*-?\\s*up(?:s)?",
  "chin\\s*-?\\s*up(?:s)?",
  "push\\s*-?\\s*up(?:s)?",
  "dip(?:s|ped)?",
  "plank(?:s|ed)?",
  "snatch(?:es|ed)?",
  "jerk(?:s|ed)?",
];

const EXERCISE_RE = new RegExp(`\\b(?:${EXERCISE_PATTERNS.join("|")})\\b`, "gi");

/** Non-lifting activities that END a lifting clause. Deliberately excludes
 *  "row"/"rowed" (a lift) — an ambiguous word must not truncate a clause. */
const BOUNDARY_RE = new RegExp(
  "\\b(?:and\\s+)?(?:then\\s+)?(?:i\\s+|we\\s+)?" +
    "(?:ran|run|running|jogged|jog(?:ging)?|walked|walk(?:ing)?|swam|swim(?:ming)?|" +
    "biked|bik(?:e|ing)|cycled|cycl(?:e|ing)|rode|hiked|hik(?:e|ing)|" +
    "elliptical|treadmill|stairmaster|yoga|stretched|stretch(?:ing)?|" +
    "ate|eat|drank|drink|slept|sleep|napped|showered|meditated|played)\\b",
  "gi",
);

/** True when this text mentions at least one lifting movement. */
export function hasLiftingMention(text: string): boolean {
  EXERCISE_RE.lastIndex = 0;
  return EXERCISE_RE.test(String(text || ""));
}

// ── Clause parsing ───────────────────────────────────────────────────────────

interface Span { start: number; end: number }

/**
 * Extract weight / weightUnit / reps / sets from ONE exercise clause.
 *
 * Patterns are applied in priority order and each match consumes its span, so
 * "45 pounds 10 reps each three times" cannot read "three" as reps or "10" as
 * a weight. A field the clause does not state stays null — it is never
 * defaulted and never inherited.
 */
export function parseLiftingClause(text: string): LiftingFields {
  const s = String(text || "");
  const consumed: Span[] = [];
  const isFree = (m: RegExpMatchArray) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    return !consumed.some((c) => start < c.end && end > c.start);
  };
  const claim = (m: RegExpMatchArray) => {
    const start = m.index ?? 0;
    consumed.push({ start, end: start + m[0].length });
  };
  /** First non-overlapping match of `re`, or null. */
  const firstFree = (re: RegExp): RegExpMatchArray | null => {
    for (const m of s.matchAll(re)) if (isFree(m)) return m;
    return null;
  };

  let weight: number | null = null;
  let weightUnit: LiftingFields["weightUnit"] = null;
  let reps: number | null = null;
  let sets: number | null = null;

  // 1. "3x10" / "3 × 10" — sets × reps, the near-universal gym shorthand.
  const cross = firstFree(new RegExp(`\\b(${NUM})\\s*(?:x|×)\\s*(${NUM})\\b`, "gi"));
  if (cross) {
    claim(cross);
    sets = toNum(cross[1]);
    reps = toNum(cross[2]);
  }

  // 2. "3 sets", "3 sets of 10", "3 sets of 10 reps".
  const setsOf = firstFree(new RegExp(`\\b(${NUM})\\s*sets?\\b(?:\\s*(?:of|x|×)\\s*(${NUM})\\s*(?:reps?)?)?`, "gi"));
  if (setsOf) {
    claim(setsOf);
    if (sets == null) sets = toNum(setsOf[1]);
    if (reps == null) reps = toNum(setsOf[2]);
  }

  // 3. "sets of 10" with no leading count — that number is REPS, not sets.
  const bareSetsOf = firstFree(new RegExp(`\\bsets?\\s*of\\s*(${NUM})\\b`, "gi"));
  if (bareSetsOf) {
    claim(bareSetsOf);
    if (reps == null) reps = toNum(bareSetsOf[1]);
  }

  // 4. "three times", "twice", "once" → sets. THIS is the phrase that used to
  //    leak onto the next exercise.
  const times = firstFree(new RegExp(`\\b(${NUM})\\s*times\\b`, "gi"));
  if (times) {
    claim(times);
    if (sets == null) sets = toNum(times[1]);
  } else {
    const wordTimes = firstFree(/\b(once|twice|thrice)\b/gi);
    if (wordTimes) {
      claim(wordTimes);
      if (sets == null) sets = { once: 1, twice: 2, thrice: 3 }[wordTimes[1].toLowerCase()] ?? null;
    }
  }

  // 5. "10 reps" / "reps of 10".
  const repsAfter = firstFree(new RegExp(`\\b(${NUM})\\s*(?:reps?|repetitions?)\\b`, "gi"));
  if (repsAfter) {
    claim(repsAfter);
    if (reps == null) reps = toNum(repsAfter[1]);
  } else {
    const repsBefore = firstFree(new RegExp(`\\breps?\\s*(?:of|:)?\\s*(${NUM})\\b`, "gi"));
    if (repsBefore) {
      claim(repsBefore);
      if (reps == null) reps = toNum(repsBefore[1]);
    }
  }

  // 6. Weight with an explicit unit — "45 pounds", "40lb", "60 kg".
  const weighted = firstFree(new RegExp(`\\b(${NUM})\\s*(lbs?|pounds?|kgs?|kilograms?|kilos?)\\b`, "gi"));
  if (weighted) {
    claim(weighted);
    weight = toNum(weighted[1]);
    weightUnit = /^k/i.test(weighted[2]) ? "kg" : "lb";
  } else {
    // 7. A bare leftover number is the load ("bench press 135 for 3x10").
    const bare = firstFree(/\b(\d{1,4}(?:\.\d+)?)\b/g);
    if (bare) {
      claim(bare);
      weight = toNum(bare[1]);
    }
  }

  return { weight, weightUnit, reps, sets };
}

/**
 * Split a message into per-exercise segments. A segment runs from its own
 * exercise mention to whichever comes first: the next exercise mention, the
 * next non-lifting activity ("I ran a mile"), or the end of the message.
 */
export function splitLiftingSegments(message: string): LiftingSegment[] {
  const s = String(message || "");
  if (!s.trim()) return [];

  EXERCISE_RE.lastIndex = 0;
  const mentions = [...s.matchAll(EXERCISE_RE)].map((m) => ({
    exercise: m[0],
    index: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  if (mentions.length === 0) return [];

  BOUNDARY_RE.lastIndex = 0;
  const boundaries = [...s.matchAll(BOUNDARY_RE)].map((m) => m.index ?? 0);

  const segments: LiftingSegment[] = [];
  for (let i = 0; i < mentions.length; i++) {
    const start = mentions[i].index;
    // Skip an adjacent duplicate mention ("incline dumbbell press" already
    // consumed by a longer pattern is impossible, but "bench" inside "bench
    // press" is — the regex alternation handles that, so mentions never nest).
    const nextMention = mentions[i + 1]?.index ?? s.length;
    const nextBoundary = boundaries.find((b) => b >= mentions[i].end) ?? s.length;
    const end = Math.min(nextMention, nextBoundary, s.length);
    const text = s.slice(start, end).trim();
    if (!text) continue;
    // A fresh, independent object per exercise — never a reused template.
    segments.push({
      exercise: mentions[i].exercise,
      text,
      index: start,
      ...parseLiftingClause(text),
    });
  }
  return segments;
}

// ── Entry-shape helpers ──────────────────────────────────────────────────────

const WEIGHT_KEYS = ["weight", "weightlbs", "weight_lbs", "lbs", "pounds", "load"];
const REPS_KEYS = ["reps", "rep", "repetitions"];
const SETS_KEYS = ["sets", "set", "setcount", "set_count"];
const UNIT_KEYS = ["weightunit", "weight_unit"];
const NAME_KEYS = ["exercise", "exercisename", "exercise_name", "movement", "lift", "activitytype", "activity_type"];

/** First matching key, in the ALIAS LIST's priority order — not the object's
 *  insertion order. `{activityType:"dumbbell", exercise:"Dumbbells"}` must
 *  headline as "Dumbbells": the specific movement beats the generic type. */
function pick(values: Record<string, any>, keys: string[]): { key: string; value: any } | null {
  const entries = Object.entries(values || {});
  for (const want of keys) {
    const hit = entries.find(([k, v]) => k.toLowerCase() === want && v != null && v !== "");
    if (hit) return { key: hit[0], value: hit[1] };
  }
  return null;
}

/** Every key in `values` that is an alias of this field. */
function pickAllKeys(values: Record<string, any>, keys: string[]): string[] {
  return Object.keys(values || {}).filter((k) => keys.includes(k.toLowerCase()));
}

function numOrNull(v: any): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : null;
}

/**
 * Is this tracker entry a lifting/strength log? Cardio (running, walking,
 * cycling, swimming) and body-weight readings deliberately return false so
 * their untouched pipelines stay untouched.
 */
export function isLiftingEntry(trackerName: string, values: Record<string, any> | null | undefined): boolean {
  const v = values || {};
  const name = String(trackerName || "");
  if (/\b(running|walking|cycling|swimming|steps|hydration|sleep)\b/i.test(name)) return false;
  // A body-weight reading ("Weight": 180) is a measurement, not a lift.
  if (/^\s*(body\s*|scale\s*)?weight\s*$/i.test(name)) return false;
  const nameField = pick(v, NAME_KEYS);
  const subject = `${name} ${nameField ? String(nameField.value) : ""}`;
  // "weights" (plural) is gym slang for lifting; bare "weight" is a body metric.
  const namedLift = hasLiftingMention(subject) || /\b(lift|lifting|lifted|weights|strength)\b/i.test(subject);
  const weight = numOrNull(pick(v, WEIGHT_KEYS)?.value);
  const reps = numOrNull(pick(v, REPS_KEYS)?.value);
  const sets = numOrNull(pick(v, SETS_KEYS)?.value);
  // Strength-shaped: a load plus a rep/set count, or an explicitly named lift
  // carrying any of the three numbers.
  if (weight != null && (reps != null || sets != null)) return true;
  if (namedLift && (weight != null || reps != null || sets != null)) return true;
  return false;
}

/** Read a stored entry's values as a lifting record (missing → null). */
export function liftingRecordFromValues(
  values: Record<string, any> | null | undefined,
  fallbackName = "",
): LiftingRecord {
  const v = values || {};
  const rawUnit = String(pick(v, UNIT_KEYS)?.value ?? "").toLowerCase();
  return {
    exerciseName: String(pick(v, NAME_KEYS)?.value ?? fallbackName ?? "").trim(),
    weight: numOrNull(pick(v, WEIGHT_KEYS)?.value),
    weightUnit: rawUnit ? (/^k/.test(rawUnit) ? "kg" : "lb") : null,
    reps: numOrNull(pick(v, REPS_KEYS)?.value),
    sets: numOrNull(pick(v, SETS_KEYS)?.value),
  };
}

/** "45 lb · 3 sets × 10 reps" / "145 lb · 10 reps". */
export function formatLiftingDetail(rec: LiftingRecord): string {
  const parts: string[] = [];
  if (rec.weight != null) parts.push(`${rec.weight} ${rec.weightUnit || "lb"}`);
  if (rec.sets != null && rec.reps != null) parts.push(`${rec.sets} sets × ${rec.reps} reps`);
  else if (rec.reps != null) parts.push(`${rec.reps} reps`);
  else if (rec.sets != null) parts.push(`${rec.sets} sets`);
  return parts.join(" · ");
}

/** The honest sub-line for a lift whose set count the user never gave. */
export function liftingSetsNote(rec: LiftingRecord): string | null {
  if (rec.sets != null) return null;
  if (rec.weight == null && rec.reps == null) return null;
  return "Sets not specified";
}

// ── The scoping guard ────────────────────────────────────────────────────────

/** Stems shared by many different lifts — matching on these alone would make
 *  "Leg Press" look like "bench press". Only distinguishing words count. */
const GENERIC_LIFT_STEMS = new Set([
  "pres", "exercis", "workout", "lift", "machin", "cabl", "weight", "bar",
  "seat", "stand", "incl", "decl", "the", "and", "with", "each",
]);

function stemTokens(name: string): string[] {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/(?:ed|ing|es|s)$/, ""))
    .filter((t) => t.length >= 3 && !GENERIC_LIFT_STEMS.has(t));
}

/** Do an entry's exercise name and a segment's phrase refer to the same lift? */
function namesMatch(entryName: string, segmentName: string): boolean {
  const a = stemTokens(entryName);
  const b = stemTokens(segmentName);
  if (a.length === 0 || b.length === 0) return false;
  return a.some((t) => b.includes(t)) || b.some((t) => a.includes(t));
}

export interface LiftingScopeResult {
  /** A NEW values object — the input is never mutated. */
  values: Record<string, any>;
  /** Fields removed because this exercise's own clause never stated them. */
  dropped: string[];
  /** Fields corrected/filled from this exercise's own clause. */
  applied: string[];
  /** False when no clause could be matched — values are passed through as-is. */
  matched: boolean;
  /** The clause this entry was scoped to (for logging). */
  clause?: string;
}

/**
 * Re-scope one lifting entry's fields to the user's own clause for THAT
 * exercise. Any weight/reps/sets the clause does not state is removed, so a
 * "three times" attached to the dumbbell phrase can never end up on the bench
 * press. Returns a fresh object; never mutates the input.
 */
export function scopeLiftingValues(opts: {
  message: string;
  exercise?: string;
  trackerName?: string;
  values: Record<string, any> | null | undefined;
  /** Segments already claimed by earlier entries in this message. */
  claimedIndexes?: Set<number>;
}): LiftingScopeResult {
  // Fresh, independent object for every detected exercise — requirement #3/#5.
  const values: Record<string, any> = { ...(opts.values || {}) };
  const passthrough: LiftingScopeResult = { values, dropped: [], applied: [], matched: false };

  const message = String(opts.message || "");
  if (!message.trim()) return passthrough;

  const segments = splitLiftingSegments(message);
  if (segments.length === 0) return passthrough;

  const entryName = String(
    opts.exercise ?? pick(values, NAME_KEYS)?.value ?? opts.trackerName ?? "",
  );

  const claimed = opts.claimedIndexes;
  const available = segments.filter((seg) => !claimed?.has(seg.index));
  const pool = available.length > 0 ? available : segments;

  let candidates = pool.filter((seg) => namesMatch(entryName, seg.exercise));
  // A generic tracker name ("Lifting", "Workout") matches nothing by name; if
  // there is exactly one unclaimed clause, it is unambiguously this entry's.
  if (candidates.length === 0 && pool.length === 1) candidates = pool;
  if (candidates.length === 0) return passthrough;

  // Same lift logged twice in one message ("dumbbells 45 three times, then
  // dumbbells 60 twice") — disambiguate by the load the model reported.
  const entryWeight = numOrNull(pick(values, WEIGHT_KEYS)?.value);
  const seg =
    (entryWeight != null && candidates.find((c) => c.weight === entryWeight)) || candidates[0];

  claimed?.add(seg.index);

  const dropped: string[] = [];
  const applied: string[] = [];

  const reconcile = (keys: string[], canonical: string, scoped: number | null) => {
    const existing = pick(values, keys);
    if (scoped == null) {
      // The user never stated this field for THIS exercise. Anything present
      // came from the model carrying it over — drop it (every alias of it).
      for (const key of pickAllKeys(values, keys)) {
        delete values[key];
        dropped.push(key);
      }
      return;
    }
    const key = existing?.key ?? canonical;
    if (numOrNull(existing?.value) !== scoped) applied.push(key);
    values[key] = scoped;
  };

  reconcile(WEIGHT_KEYS, "weight", seg.weight);
  reconcile(REPS_KEYS, "reps", seg.reps);
  reconcile(SETS_KEYS, "sets", seg.sets);

  // Unit is informational: record it when the user said it and a load survived.
  if (seg.weight != null && seg.weightUnit) {
    const existingUnit = pick(values, UNIT_KEYS);
    const key = existingUnit?.key ?? "weightUnit";
    if (values[key] !== seg.weightUnit) applied.push(key);
    values[key] = seg.weightUnit;
  }

  return { values, dropped, applied, matched: true, clause: seg.text };
}
