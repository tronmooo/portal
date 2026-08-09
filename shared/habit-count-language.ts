// shared/habit-count-language.ts — "twice", "again", "two more", "so far".
//
// Habits can now be completed several times a day, so the chat has to answer
// two questions about every report, not one:
//
//   HOW MANY?  once / twice / three times / a couple / 4x
//   ADD OR SET? "I did it twice MORE"  → add 2 to today's count
//               "I've done it twice SO FAR" → today's total IS 2
//
// Getting the second one wrong is the difference between 2/3 and 4/3, so the
// distinction lives here as an explicit, testable rule instead of being left
// to the model's judgement alone. The model may always override by passing
// `count`/`setTotal` itself; this is the fallback that reads the raw sentence.
//
// Pure and dependency-free. Pinned by tests/habit-count-language.test.ts.

export type CompletionCountMode = "add" | "set";

export interface CompletionCountIntent {
  /** How many completions the sentence is about. */
  count: number;
  /** "add" appends `count` occurrences; "set" makes today's total `count`. */
  mode: CompletionCountMode;
  /** "HH:MM" when the sentence names a time ("at 8am", "this morning"). */
  at?: string;
}

const WORD_NUMBERS: Record<string, number> = {
  once: 1, one: 1, a: 1, an: 1, single: 1,
  twice: 2, two: 2, double: 2, couple: 2,
  thrice: 3, three: 3, triple: 3, few: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

/** "twice" → 2, "three" → 3, "8" → 8. Null when it isn't a number word. */
export function wordToNumber(word: unknown): number | null {
  const w = String(word ?? "").trim().toLowerCase();
  if (!w) return null;
  if (/^\d+$/.test(w)) {
    const n = parseInt(w, 10);
    return Number.isFinite(n) ? n : null;
  }
  return WORD_NUMBERS[w] ?? null;
}

/**
 * Markers that make the number a RUNNING TOTAL rather than an increment.
 * "so far", "in total", "only ... today", "just ... today", "altogether".
 */
const SET_MARKERS = [
  /\bso far\b/i,
  /\bin total\b/i,
  /\baltogether\b/i,
  /\ball together\b/i,
  /\btotal of\b/i,
  /\bonly\b/i,
  /\bjust\b/i,
  /\bfor the day\b/i,
  /\bmake (?:it|that|today)\b/i,
  /\bset (?:it|today)\b/i,
];

/** Markers that make the number an INCREMENT on top of what's recorded. */
const ADD_MARKERS = [
  /\bmore\b/i,
  /\banother\b/i,
  /\bagain\b/i,
  /\badditional\b/i,
  /\bas well\b/i,
  /\bon top of\b/i,
];

/** "at 8am" / "at 20:15" / "this morning" → "HH:MM". */
export function parseCompletionTime(text: unknown): string | undefined {
  const s = String(text ?? "");
  if (!s) return undefined;

  // Explicit clock time wins: "at 8 AM", "at 8:15am", "at 20:15".
  const clock = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(s);
  if (clock) {
    let h = parseInt(clock[1], 10);
    const m = clock[2] ? parseInt(clock[2], 10) : 0;
    const mer = clock[3]?.toLowerCase();
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    // Without a meridiem a bare "at 8" is ambiguous; only accept a 24h-valid
    // hour and leave the disambiguation to the user's own wording.
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }

  // Named parts of the day — "I brushed my teeth this morning" should not be
  // stamped with the time the user happened to type the message.
  if (/\b(this morning|in the morning|earlier this morning)\b/i.test(s)) return "08:00";
  if (/\b(this afternoon|in the afternoon|after lunch)\b/i.test(s)) return "13:00";
  if (/\b(this evening|in the evening)\b/i.test(s)) return "18:00";
  if (/\b(tonight|before bed|at bedtime|last night)\b/i.test(s)) return "20:00";
  return undefined;
}

/**
 * Read a completion report: how many, and whether it's an increment or a total.
 *
 * Returns null when the sentence carries no completion count at all — the
 * caller then defaults to a single completion.
 */
export function parseCompletionCount(text: unknown): CompletionCountIntent | null {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return null;

  const at = parseCompletionTime(s);
  let count: number | null = null;

  const NUMWORD = "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";

  // Phrasings that are inherently a TOTAL, not an increment, even without a
  // "so far"/"only" marker:
  //   "I completed all three"      → today's total is 3
  //   "I did four instead of three" → today's total is 4 (the 3 was the plan)
  const allOf = new RegExp(`\\ball\\s+(?:of\\s+)?(?:the\\s+)?(${NUMWORD})\\b`, "i").exec(s);
  if (allOf) {
    const n = wordToNumber(allOf[1]);
    if (n !== null && n > 0) return { count: n, mode: "set", at };
  }
  const insteadOf = new RegExp(`\\b(${NUMWORD})\\s+instead\\s+of\\s+(?:${NUMWORD})\\b`, "i").exec(s);
  if (insteadOf) {
    const n = wordToNumber(insteadOf[1]);
    if (n !== null && n > 0) return { count: n, mode: "set", at };
  }

  // "3x", "4 times", "twice", "three times", "a couple more", "two more"
  const patterns: RegExp[] = [
    /\b(\d+)\s*x\b/,
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple|a few|couple|few)\s+(?:more\s+)?times?\b/,
    /\b(once|twice|thrice)\b/,
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+more\b/,
    /\b(a couple|a few|couple of|couple|few)\s+more\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const raw = m[1].replace(/^a\s+/, "").replace(/\s+of$/, "");
    const n = wordToNumber(raw);
    if (n !== null && n > 0) { count = n; break; }
  }

  const hasAgain = /\bagain\b/.test(s);
  const hasAnother = /\banother\b/.test(s) || /\bone more\b/.test(s);
  if (count === null) {
    // "I did it again" / "one more" with no explicit number is a single
    // additional completion.
    if (hasAgain || hasAnother) return { count: 1, mode: "add", at };
    return null;
  }

  // ADD markers beat SET markers: "I only did it twice MORE" is still +2.
  const isAdd = ADD_MARKERS.some((re) => re.test(s));
  const isSet = !isAdd && SET_MARKERS.some((re) => re.test(s));
  // Present-perfect reporting is a running total: "I've brushed my teeth twice".
  const isPerfect = !isAdd && /\b(?:i'?ve|i have|we'?ve|we have)\b[^.]*\b(?:done|had|taken|been)\b/.test(s);

  return { count, mode: isSet || isPerfect ? "set" : "add", at };
}

/**
 * Does the message contain MORE THAN ONE count phrase?
 *
 * "I walked the dog twice, took my medication once, drank water four times" is
 * three different counts. Reading any single one off the whole sentence and
 * applying it to every habit would log 2 doses of medication. Callers use this
 * to refuse the whole-message fallback and rely on the per-call count instead.
 */
export function hasMultipleCountPhrases(text: unknown): boolean {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return false;
  const re = /\b(?:\d+\s*x|\d+\s+times?|once|twice|thrice|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:more|times?)|another|again)\b/g;
  return (s.match(re) || []).length > 1;
}

/**
 * Does the message state MORE THAN ONE daily target ("water 8 times a day and
 * stretch 3 times a day")? Same reason as above — the fallback must not pick
 * one target and apply it to the wrong habit.
 *
 * "from twice a day to three times a day" is ONE target change, not two, and
 * is excluded: parseDailyTargetChange already resolves it to the "to" value.
 */
export function hasMultipleDailyTargets(text: unknown): boolean {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return false;
  if (/\bfrom\b[\s\S]*\bto\b/.test(s)) return false;
  const re = /\b(?:\d+|once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:times?\s+)?(?:(?:a|per|each)\s+day|daily|x\s*(?:a|per)?\s*day)/g;
  return (s.match(re) || []).length > 1;
}

/**
 * "set my water habit to 8 times per day" / "change walking the dog from twice
 * a day to three times a day" → the NEW daily target.
 *
 * When the sentence names two targets ("from twice a day to three times a
 * day"), the one after "to" is the new one — reading the first would quietly
 * set the target back to what the user is changing away from.
 */
export function parseDailyTargetChange(text: unknown): number | null {
  const s = String(text ?? "").toLowerCase();
  if (!s.trim()) return null;

  const NUM = "\\d+|once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
  const perDay = `(?:times?\\s+)?(?:a|per|each)\\s+day|times?\\s+daily|x\\s*(?:a|per)?\\s*day|x\\s*daily`;

  // Prefer the target that follows "to ..." so "from twice a day to three
  // times a day" resolves to 3.
  const toForm = new RegExp(`\\bto\\s+(${NUM})\\s*(?:${perDay})`, "i").exec(s);
  if (toForm) {
    const n = wordToNumber(toForm[1]);
    if (n !== null && n > 0) return n;
  }
  const anyForm = new RegExp(`\\b(${NUM})\\s*(?:${perDay})`, "i").exec(s);
  if (anyForm) {
    const n = wordToNumber(anyForm[1]);
    if (n !== null && n > 0) return n;
  }
  return null;
}
