// shared/action-scope.ts — "only do what the user actually asked for".
//
// THE BUG THIS FIXES (user report 2026-08-09, screenshot):
//   Turn 1: "remind me to mow the lawn"        → AI creates a reminder. Correct.
//   Turn 2: "Create me a habit too walk the dog twice a day"
//           → AI creates the Walk the Dog habit AND re-creates the
//             "Mow the lawn" reminder.
//
// The second reminder is pure conversation-history replay: the model sees the
// earlier request in the carried-forward turns and treats it as still pending.
// Every existing defense against this is advisory (system-prompt rules) or
// per-tool (name+amount dedup keys), and neither stops a *fresh* entity from
// being created a second time under a slightly different date.
//
// This module is the mechanical backstop. It answers one question, purely:
//
//   Does this tool call's subject come ONLY from the conversation history,
//   with nothing in the CURRENT message pointing at it?
//
// If so the call is a replay and must not run. Everything else is allowed —
// the guard deliberately never second-guesses a subject the current message
// mentions, and never fires on anaphoric follow-ups ("do it again", "one
// more"), which are exactly the case where the subject legitimately lives in
// the history.
//
// Pure and dependency-free; pinned by tests/action-scope.test.ts.

export interface ScopeHistoryTurn {
  role: "user" | "assistant" | string;
  content?: string | null;
}

/**
 * Tools that mint a NEW record from a subject the user names out loud. These
 * are the ones where a replay produces a visible, unwanted row.
 *
 * Deliberately excludes tools whose subject the model legitimately *derives*
 * rather than quotes — log_tracker_entry ("I ran 2 miles" → tracker
 * "Running"), log_medication_dose, and every update/delete/read tool. A
 * derived subject has no reliable overlap with the message it came from, so
 * the guard would misfire on it.
 */
export const REPLAY_GUARDED_TOOLS = new Set([
  "create_reminder",
  "create_task",
  "create_event",
  "create_habit",
  "create_goal",
  "create_obligation",
  "create_liability",
  "create_profile",
  "create_tracker",
]);

/** Field each guarded tool carries its user-facing subject in. */
const SUBJECT_FIELDS = ["name", "title", "trackerName", "text"];

/**
 * Words that carry no identity — a subject made only of these can never be
 * matched confidently, so the guard stays out of the way.
 */
const GENERIC_WORDS = new Set([
  "a", "an", "the", "my", "me", "i", "we", "our", "your", "his", "her", "their", "its",
  "to", "of", "for", "on", "off", "in", "at", "by", "with", "from", "into", "and", "or",
  "is", "am", "are", "was", "were", "be", "been", "do", "does", "did", "done",
  "it", "this", "that", "these", "those", "there", "here",
  "new", "add", "create", "make", "set", "please", "just", "also", "too",
  "today", "tonight", "tomorrow", "yesterday", "now", "later", "morning",
  "afternoon", "evening", "night", "week", "month", "year", "day", "daily",
  "weekly", "monthly", "time", "times", "every", "each", "some", "any",
]);

/**
 * Anaphoric phrasing — the subject is *supposed* to come from the history
 * here, so the guard must not fire. "I did it again", "one more", "same
 * thing", "another one", "twice more".
 */
const ANAPHORA = [
  /\b(it|that|those|them|this|the same|same one|same thing)\b/i,
  /\bagain\b/i,
  /\b(one|two|three|another|a few|a couple)\s+more\b/i,
  /\banother\b/i,
  /\bas well\b/i,
  /\bditto\b/i,
  /\byes\b/i,
  /\bdo (it|that)\b/i,
];

/** Lowercase, split camelCase, collapse punctuation to single spaces. */
export function scopeNormalize(input: unknown): string {
  return String(input ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Crude English stemmer, same shape as the habit matcher's — enough to make
 * "walking" and "walked" agree with "walk" so a subject the user phrased
 * differently in the two turns still lines up.
 */
function stem(word: string): string {
  let s = word;
  if (s.length > 4 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 3 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length >= 3 && /([bcdfghjklmnpqrstvwxz])\1$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** Meaningful, stemmed tokens for a phrase. */
export function scopeTokens(text: unknown): string[] {
  const norm = scopeNormalize(text);
  if (!norm) return [];
  const out = new Set<string>();
  for (const w of norm.split(" ")) {
    if (w.length < 2) continue;
    if (GENERIC_WORDS.has(w)) continue;
    out.add(stem(w));
  }
  return [...out];
}

/** The user-facing subject a guarded tool call is about ("Mow the lawn"). */
export function toolSubject(input: Record<string, any> | null | undefined): string {
  if (!input) return "";
  for (const f of SUBJECT_FIELDS) {
    const v = (input as any)[f];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** Does the message lean on an earlier turn for its subject? */
export function isAnaphoricFollowUp(message: unknown): boolean {
  const m = String(message ?? "");
  if (!m.trim()) return false;
  return ANAPHORA.some((re) => re.test(m));
}

export interface ReplayCheck {
  /** True when the call should be refused as a conversation-history replay. */
  replay: boolean;
  /** The subject that triggered it, for the error message. */
  subject?: string;
}

/**
 * Is this tool call a replay of a request the user made in an EARLIER turn?
 *
 * Fires only on the unambiguous shape:
 *   1. the tool mints a new record from a user-named subject, AND
 *   2. none of the subject's meaningful words appear in the current message, AND
 *   3. the current message is not an anaphoric follow-up, AND
 *   4. EVERY meaningful word of the subject appears in an earlier USER turn.
 *
 * (4) is deliberately full coverage, not partial: a single shared word
 * ("walk" in both "walk the dog" and "walk to work") must never block a
 * legitimate new record.
 */
export function checkHistoryReplay(args: {
  toolName: string;
  input: Record<string, any> | null | undefined;
  userMessage: string;
  history?: ScopeHistoryTurn[] | null;
}): ReplayCheck {
  const { toolName, input, userMessage } = args;
  if (!REPLAY_GUARDED_TOOLS.has(toolName)) return { replay: false };

  const history = args.history || [];
  if (history.length === 0) return { replay: false };

  const subject = toolSubject(input);
  const subjectTokens = scopeTokens(subject);
  if (subjectTokens.length === 0) return { replay: false };

  if (isAnaphoricFollowUp(userMessage)) return { replay: false };

  // (2) Anything the current message names is in scope, full stop.
  const messageTokens = new Set(scopeTokens(userMessage));
  if (subjectTokens.some((t) => messageTokens.has(t))) return { replay: false };

  // (4) Fully covered by an earlier user turn → the model is re-running a
  // request that turn already resolved.
  const priorUserText = history
    .filter((h) => h?.role === "user")
    .map((h) => String(h?.content ?? ""))
    .join(" \n ");
  if (!priorUserText.trim()) return { replay: false };
  const priorTokens = new Set(scopeTokens(priorUserText));
  const covered = subjectTokens.every((t) => priorTokens.has(t));
  if (!covered) return { replay: false };

  return { replay: true, subject };
}

/** The refusal handed back to the model as the tool's result. */
export function replayRefusal(toolName: string, subject: string) {
  return {
    error:
      `"${subject}" was not part of the user's current message — it comes from an earlier turn ` +
      `that was already handled. Do NOT call ${toolName} for it. Act only on what the user asked ` +
      `for in THIS message, and do not mention this refusal in your reply.`,
    code: "NOT_REQUESTED_IN_THIS_MESSAGE",
  };
}
