// shared/ai-message-kinds.ts — what may reach the user, and what may not.
//
// Production leak (2026-08-09 screenshot 3): the chat rendered
//
//   ❌ Walk the Dog — The user didn't ask for a habit — do NOT create one.
//      Log the activity with log_tracker_entry(trackerName:"Walk the Dog")
//      instead, keeping every quantity, method, and timestamp they stated.
//
// That string is a tool-error DIRECTIVE addressed to the model. It is written
// in the second person about the user, names internal tools, and gives orders.
// It was never meant for a human, but the failed-operation list rendered
// `op.error` verbatim.
//
// The fix is to make the distinction explicit and enforceable rather than
// relying on every error string author to remember who their audience is:
// each message carries a KIND, and only three kinds are renderable.

export type AiMessageKind =
  | "user_message"
  | "assistant_message"
  | "action_card"
  | "tool_result"
  | "internal_reasoning"
  | "evaluation"
  | "debug";

/** The only kinds production UI may render. */
export const RENDERABLE_KINDS: ReadonlySet<AiMessageKind> = new Set<AiMessageKind>([
  "user_message",
  "assistant_message",
  "action_card",
]);

export function isRenderable(kind: AiMessageKind): boolean {
  return RENDERABLE_KINDS.has(kind);
}

/**
 * Signatures of text written FOR THE MODEL. Any one of these means the string
 * is a directive, not a user-facing sentence.
 */
const INTERNAL_MARKERS: RegExp[] = [
  // Orders aimed at the model.
  /\bdo\s+NOT\b/,
  /\bnever\b\s+(?:call|use|claim|report|say)\b/i,
  /\btell\s+the\s+user\b/i,
  /\bdo\s+not\s+(?:report|claim|render|say)\b/i,
  /\bthe\s+user\s+(?:didn'?t|did\s+not|does\s+not|asked|wants)\b/i,
  /\binstead[,.]?\s+(?:call|use)\b/i,
  /\bblocked:/i,
  // Internal tool call syntax, e.g. log_tracker_entry(trackerName:"…").
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*\(/,
  // Bare internal tool names.
  /\b(?:log_tracker_entry|create_habit|checkin_habit|update_profile|create_profile|create_event|create_reminder|create_task|log_medication_dose)\b/,
  // Internal error codes / debug markers.
  /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/,
  /\[(?:ai|debug|internal|eval)[-\]]/i,
];

/** True when this string is model-facing and must not be shown to a person. */
export function isInternalDirective(text: unknown): boolean {
  const s = String(text ?? "").trim();
  if (!s) return false;
  return INTERNAL_MARKERS.some((re) => re.test(s));
}

/** Generic, honest replacements per failure shape. */
const GENERIC_BY_TOOL: Array<[RegExp, string]> = [
  [/habit/i, "I didn't create a habit for that."],
  [/tracker/i, "I couldn't log that entry."],
  [/profile|asset/i, "I couldn't save that record."],
  [/event|reminder|task/i, "I couldn't save that to your schedule."],
  [/expense|income|obligation|liability|paycheck/i, "I couldn't save that financial record."],
];

export const GENERIC_FAILURE_MESSAGE = "That step didn't go through — nothing was saved for it.";

/**
 * The user-facing form of a tool error. Passes through anything already
 * written for a human; replaces model-facing directives with a plain,
 * non-leaking sentence chosen from the tool name.
 */
export function toUserFacingError(text: unknown, toolName?: string): string {
  const s = String(text ?? "").trim();
  if (!s) return GENERIC_FAILURE_MESSAGE;
  if (!isInternalDirective(s)) return s.length > 200 ? `${s.slice(0, 197)}…` : s;
  if (toolName) {
    for (const [re, message] of GENERIC_BY_TOOL) {
      if (re.test(toolName)) return message;
    }
  }
  return GENERIC_FAILURE_MESSAGE;
}

/**
 * Last-resort scrub for assistant REPLY text. The model occasionally echoes a
 * tool-error directive it was handed; strip those sentences rather than let
 * internal instructions surface as chat prose.
 */
export function stripInternalText(reply: unknown): string {
  const s = String(reply ?? "");
  if (!s) return "";
  const kept = s
    .split(/\n/)
    .filter((line) => !isInternalDirective(line))
    .join("\n");
  return kept.replace(/\n{3,}/g, "\n\n").trim();
}
