// Pure multi-action clause detection — no LLM, no I/O.
//
// Decides when a chat message is a long "here's my day" recap (many
// independent loggable actions) so the AI engine can route it to the bulk
// extraction path instead of the general agentic loop. The general loop
// handles mixed reads/questions/updates well but cannot survive 20-50
// sequential actions inside the serverless time budget; the bulk path can,
// but is wrong for conversational messages. This heuristic is the router.
//
// Pinned by tests/action-split.test.ts — keep it deterministic.

const ACTION_VERBS =
  "woke|showered|shower|bathed|used|brushed|flossed|took|drank|ate|had|walked|ran|jogged|played|smoked|vaped|read|meditated|prayed|practiced|vacuumed|washed|cleaned|paid|journaled|went|did|worked|studied|cooked|slept|napped|lifted|swam|biked|cycled|stretched|watered|fed|called|texted|emailed|finished|completed|logged|weighed|checked|mowed|folded|organized|tidied|shaved|exercised|trained|hiked|danced|fasted|snacked|watched|listened";

/** A clause looks like a first-person action statement ("I played soccer",
 * "Took lisinopril", "Paid my electric bill"). */
const ACTION_SIGNAL = new RegExp(`\\b(?:[Ii]|[Ww]e)\\s+(?:(?:also|then|just)\\s+)?(?:${ACTION_VERBS})\\b`);

/** Bare imperative-style clause: starts directly with a past-tense verb
 * ("Showered.", "Vacuumed.", "Used the bathroom."). */
const LEADING_VERB = new RegExp(`^(?:${ACTION_VERBS})\\b`, "i");

/** Questions and requests-for-information are never loggable actions. */
const QUESTION_SIGNAL =
  /^(?:who|what|when|where|why|how|which|can|could|should|would|do|does|is|are|was|were|show|tell|give|list|find|search|summarize|explain)\b|\?\s*$/i;

/** Connectives that separate two actions inside one sentence. Conservative:
 * plain " and " is only a separator when what follows starts a new action
 * ("and I went...", "and took...") so "mac and cheese" stays intact. */
const INTRA_SENTENCE_SPLIT = new RegExp(
  `,\\s*(?:and\\s+)?(?:then\\s+)?|\\s+and\\s+then\\s+|\\s+then\\s+|\\s+and\\s+(?=(?:I|we)\\s+)|\\s+and\\s+(?=(?:${ACTION_VERBS})\\b)|;\\s*`,
  "i",
);

/** Split a message into candidate action clauses. */
export function splitActionClauses(message: string): string[] {
  const raw = String(message || "");
  if (!raw.trim()) return [];

  // Sentence split on ./!/? followed by whitespace, plus hard newlines.
  const sentences = raw
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

  const clauses: string[] = [];
  for (const sentence of sentences) {
    if (QUESTION_SIGNAL.test(sentence)) continue;
    for (const part of sentence.split(INTRA_SENTENCE_SPLIT)) {
      const clause = (part || "").trim().replace(/[.!?]+$/, "").trim();
      if (!clause) continue;
      if (ACTION_SIGNAL.test(clause) || LEADING_VERB.test(clause)) {
        clauses.push(clause);
      }
    }
  }
  return clauses;
}

/** Count independent action clauses in a message. */
export function countActionClauses(message: string): number {
  return splitActionClauses(message).length;
}

/** Messages with at least this many action clauses route to the bulk
 * extraction path (plan → execute → verify). Below it, the general agentic
 * loop (which now handles multi-action prompts too) is the better tool. */
export const BULK_ACTION_THRESHOLD = 4;

/** Signals that the message asks for something BEYOND logging activity
 * reports — CRUD commands, habit check-ins, reminders, questions. Those
 * need the full agentic loop (all ~120 tools); the bulk path only executes
 * a whitelist of write tools and would silently drop the rest. */
const MIXED_COMMAND_SIGNAL =
  /\b(delete|remove|undo|revert|rename|update|change|edit|cancel|reschedule|schedule|remind me|mark(ed)? off|check(ed)? (in|off)|make (this|it) a habit|add a (task|habit|reminder|goal)|create a|set (a|my|the)|show me|list|search|find|open|pull up)\b|\?/i;

export function shouldUseBulkPath(message: string): boolean {
  const m = String(message || "");
  if (MIXED_COMMAND_SIGNAL.test(m)) return false;
  return countActionClauses(m) >= BULK_ACTION_THRESHOLD;
}

/** Fast router: a SIMPLE logging command — one to a few pure activity
 * reports ("I took one fish oil supplement", "logged a 3-mile run", "drank
 * 2 coffees") that sit BELOW the bulk threshold and carry no question or
 * CRUD/read/reminder signal. These are the common case, and today they pay
 * the full price of the general agentic loop (giant context + multiple
 * sequential model rounds) for what is really one database write. Route them
 * to the same extract→execute engine the bulk path uses, but with a fast
 * model and no full-database context, so a simple log resolves in ~1-3s
 * instead of 15-40s. Mutually exclusive with shouldUseBulkPath by clause
 * count; questions and mixed commands are excluded by MIXED_COMMAND_SIGNAL.
 * On any miss the engine returns no actions and the caller falls through to
 * the full agentic loop, so this can only speed things up, never break them. */
export function shouldUseFastLogPath(message: string): boolean {
  const m = String(message || "");
  if (MIXED_COMMAND_SIGNAL.test(m)) return false;
  const n = countActionClauses(m);
  return n >= 1 && n < BULK_ACTION_THRESHOLD;
}
