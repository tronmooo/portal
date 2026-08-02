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

// ---------------------------------------------------------------------------
// Mega-plan router: one giant mixed-CRUD "set up my whole dashboard" message.
//
// The bulk path above is for homogeneous activity recaps and is suppressed by
// any CRUD verb. The mega path is the opposite: it exists FOR mixed
// create/update commands at a scale (dozens of operations) the agentic loop
// cannot survive inside its wall-clock budget. Routing is deterministic:
// sheer length plus clause count, never suppressed by CRUD verbs or a
// trailing question ("...confirm everything worked?").

/** Below this many characters a message is never a mega-command; the agentic
 * loop handles it fine. The clause-count gate below is the real signal —
 * this floor just keeps ordinary chat out cheaply. */
export const MEGA_CHAR_THRESHOLD = 1500;

/** Total clauses (action recaps + CRUD imperatives) required to route mega. */
export const MEGA_CLAUSE_THRESHOLD = 10;

/** Imperative CRUD verbs that open a command clause ("Create a task…",
 * "Add a doctor's appointment…", "Log that I ran…", "Schedule a habit…"). */
const COMMAND_VERBS =
  "create|add|make|set|schedule|log|record|track|save|register|start|open|build|generate|link|attach|assign|update|rename|move|pay|refresh|verify|review";

const COMMAND_CLAUSE_SIGNAL = new RegExp(`^(?:(?:please|also|then|and|now)\\s+)*(?:${COMMAND_VERBS})\\b`, "i");

/** Section-label prefix ("Tasks: Create…", "Attention: create…") — stripped
 * before testing for a leading command verb. Letters only before the colon,
 * so clock times ("9:00 AM") are untouched. */
const SECTION_LABEL_PREFIX = /^[A-Za-z][A-Za-z\s'-]{0,30}:\s+/;

/** Separators between commands inside one sentence: semicolons always; commas
 * only when a command verb follows ("…due tomorrow, create a phone bill…"). */
const COMMAND_SPLIT = new RegExp(`;\\s*|,\\s*(?=(?:and\\s+|then\\s+)?(?:${COMMAND_VERBS})\\b)`, "i");

/** Count imperative CRUD command clauses ("Create X", "Add Y", "Log Z").
 * Complements countActionClauses, which only sees first-person recaps. */
export function countCommandClauses(message: string): number {
  const raw = String(message || "");
  if (!raw.trim()) return 0;
  const sentences = raw
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  let count = 0;
  for (const sentence of sentences) {
    for (const part of sentence.split(COMMAND_SPLIT)) {
      const clause = (part || "").trim().replace(SECTION_LABEL_PREFIX, "");
      if (clause && COMMAND_CLAUSE_SIGNAL.test(clause)) count++;
    }
  }
  return count;
}

/** True when a message is a mega-command: long AND dense with operations.
 * Deliberately NOT suppressed by MIXED_COMMAND_SIGNAL — mixed CRUD is the
 * mega path's whole job — and a "?" anywhere must not veto it. */
export function shouldUseMegaPlanPath(message: string): boolean {
  const m = String(message || "");
  if (m.length < MEGA_CHAR_THRESHOLD) return false;
  return countActionClauses(m) + countCommandClauses(m) >= MEGA_CLAUSE_THRESHOLD;
}
