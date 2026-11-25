// A greeting or a thank-you, answered at once.
//
// Chat timing, 2026-11-25 (production): "hello" took 2.3 s and "thanks!" 2.5 s,
// all of it waiting on the model to say a sentence that needs no data. A line
// that is ONLY a greeting or ONLY thanks is answered here, with no model call.
// Anything with one more word of substance ("hi, add a task…", "thanks, now
// delete it") is not a pleasantry and goes on as before. "ok", "yes" and "no"
// are never matched: they answer a question the assistant asked. Pure.
const GREETING = /^(?:hi|hello|hey|hiya|howdy|yo|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|portol))?$/;
const THANKS = /^(?:thanks|thank\s+you|thank\s+u|thx|ty|cheers|much\s+appreciated)(?:\s+(?:so\s+much|a\s+lot|very\s+much|again|portol))?$/;

export function pleasantryReply(message: unknown): string | null {
  const m = String(message ?? "")
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}️‍]/gu, " ")
    .replace(/[!.,…~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!m || m.length > 40) return null;
  if (GREETING.test(m)) return "Hi! Tell me what to log, add or look up — an expense, a task, a reading, an event.";
  if (THANKS.test(m)) return "You're welcome!";
  return null;
}
