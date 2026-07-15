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
    /[✓✅]/.test(m)
  );
}
