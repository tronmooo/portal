// Pure habit-intent detection — no I/O. Pinned by tests/habit-intent.test.ts.
//
// Regression source (user report 2026-07-15, screenshot): "I went to the
// bathroom at 8:15 AM" was routed to ANOTHER PROFILE'S habit ("Go to the
// bathroom 3x daily" belonging to Rex) and turned into a clarifying question
// instead of a tracker log. The rule these helpers enforce:
//
//   Past-tense activity reports ("I did / I took / I smoked / I went ...")
//   are TRACKER LOGS. Habits are only touched on EXPLICIT habit language.

/** True when the message explicitly asks to CREATE a habit/routine —
 * "make this a habit", "every day", "remind me to ...", "add a habit". */
export function hasExplicitHabitCreateIntent(message: string): boolean {
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  return (
    /\bhabits?\b/.test(m) ||
    /\broutines?\b/.test(m) ||
    /\bstreaks?\b/.test(m) ||
    /\bremind me\b/.test(m) ||
    /\bevery\s+(day|morning|night|evening|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(m) ||
    /\b(daily|weekly|nightly)\b/.test(m) ||
    /\beach\s+(day|morning|night|evening|week)\b/.test(m)
  );
}

/** True when the message explicitly asks to CHECK IN / mark off a habit —
 * "mark off my run", "check in meditation", "completed my water habit".
 * A bare activity report ("I went for a run") is NOT explicit. */
export function hasExplicitHabitCheckinIntent(message: string): boolean {
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  return (
    /\bhabits?\b/.test(m) ||
    /\bstreaks?\b/.test(m) ||
    /\bmark(ed)?\s+(off|it|that|my|the)\b/.test(m) ||
    /\bcheck(ed)?\s*(-\s*)?(in|off)\b/.test(m) ||
    /^\s*(done|did|completed?)\s+/.test(m) || // imperative shorthand: "done meditation"
    // Reporting a dose/occurrence of a multi-completion habit: "I took my first
    // dose", "I already did one of them", "I took both doses". These name a
    // completion explicitly, so they are check-ins, not activity reports.
    /\b(?:took|taken|had|did|finished)\b.*\b(?:dose|doses|of\s+them|both|again|one\s+more|first|second|third)\b/.test(m) ||
    /\bmark\s+(?:one|two|both|all|another)\b/.test(m) ||
    /[✓✅]/.test(m)
  );
}

// ── How many completions did they just report? ──────────────────────────────
//
// A habit can require several completions a day, each its own check-in row
// (shared/habit-progress.ts). So "mark my medication done" and "I took both
// doses" are different writes against the same habit, and the difference is
// only in the wording.
//
// The rule is deliberately asymmetric:
//   • an explicit count ("both", "twice", "two of them", "all of them") is
//     honoured;
//   • anything else records ONE occurrence.
// Silence means one. Reading "mark my medication done" as "fill the whole day"
// is the failure this exists to prevent — it would silently complete a dose the
// user hadn't taken, and a wrongly-recorded medication dose is not a cosmetic
// bug.

const COMPLETION_WORDS: Record<string, number> = {
  once: 1, one: 1, first: 1, single: 1, "1st": 1,
  twice: 2, two: 2, both: 2, second: 2, "2nd": 2,
  thrice: 3, three: 3, third: 3, "3rd": 3,
  four: 4, fourth: 4, five: 5, fifth: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "all of them", "all three", "the whole thing" — fill the day. */
const ALL_RE = /\b(?:all|every)\s+(?:of\s+)?(?:them|the\s+\w+|\d+|two|three|four|five|my\s+\w+)?\b|\bthe\s+whole\s+(?:thing|day|lot)\b|\bfinished\s+(?:it\s+)?(?:all|completely)\b/;

/**
 * How many completions the message reports, or "all".
 *
 * Returns `{ count }` for an explicit number, `{ all: true }` when they said
 * they finished everything, and null when they didn't say — which the caller
 * must treat as ONE, not as the whole day.
 *
 * Understands the shapes people actually use:
 *   "I took it once."            → 1
 *   "I took my first dose."      → 1
 *   "I already did one of them." → 1
 *   "Mark one completed."        → 1
 *   "I took both doses."         → 2
 *   "I finished this habit twice today." → 2
 *   "mark all of them done"      → all
 */
export function parseCompletionCount(message: string): { count?: number; all?: boolean } | null {
  const m = String(message || "").toLowerCase().trim();
  if (!m) return null;

  // "all of them" / "all three" — but NOT "all day", which is a time phrase.
  if (ALL_RE.test(m) && !/\ball\s+day\b/.test(m)) return { all: true };

  // A count attached to doing/taking/marking: "took it twice", "did two",
  // "mark one", "both doses", "my second dose", "three times".
  const wordAlt = Object.keys(COMPLETION_WORDS).join("|");
  const patterns = [
    // "twice today", "three times", "two more times"
    new RegExp(String.raw`\b(${wordAlt}|\d{1,2})\s*(?:more\s+)?times?\b`),
    // "both doses", "second dose", "one of them", "two of them"
    new RegExp(String.raw`\b(${wordAlt}|\d{1,2})\s+(?:of\s+(?:them|those)|doses?|pills?|servings?|rounds?|sessions?)\b`),
    // "took/did/mark/log/complete <n>"
    new RegExp(String.raw`\b(?:took|take|did|do|mark(?:ed)?|log(?:ged)?|complet(?:e|ed)|finish(?:ed)?)\s+(?:it\s+|my\s+|the\s+|them\s+)?(${wordAlt}|\d{1,2})\b`),
  ];
  for (const re of patterns) {
    const hit = m.match(re);
    if (!hit) continue;
    const token = hit[1];
    const n = COMPLETION_WORDS[token] ?? Number(token);
    if (Number.isFinite(n) && n >= 1) return { count: Math.min(10, Math.floor(n)) };
  }

  // A bare adverb carries the count on its own: "I finished this habit twice
  // today" has no "times" for the patterns above to anchor on.
  const adverb = m.match(/\b(once|twice|thrice)\b/);
  if (adverb) return { count: COMPLETION_WORDS[adverb[1]] };

  // "again" / "one more" after an earlier completion = one more occurrence.
  if (/\b(?:again|one\s+more|another)\b/.test(m)) return { count: 1 };

  return null;
}

/**
 * Which occurrence does "undo my first dose" mean? 1-based, or null for "the
 * last one I logged" — the default a bare "undo that" should get.
 */
export function parseOccurrencePosition(message: string): number | null {
  const m = String(message || "").toLowerCase();
  if (!m) return null;
  const ord = m.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\b/);
  if (!ord) return null;
  const MAP: Record<string, number> = {
    first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3,
    fourth: 4, "4th": 4, fifth: 5, "5th": 5,
  };
  return MAP[ord[1]] ?? null;
}
