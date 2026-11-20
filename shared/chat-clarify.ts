import { classifyTurnScope } from "./turn-scope";
/**
 * Whether the capture classifier's clarifying question may be appended to a
 * chat reply.
 *
 * The classifier runs beside the assistant, not inside it. Its question is
 * useful exactly when the turn went nowhere: nothing was routed, nothing was
 * executed, and the assistant did not itself ask the user anything. Appending
 * it in any other case produced replies that argued with themselves —
 * "Updated Lunch at Panera to $45, dated today." followed by "What item or
 * task should be moved to today?", or "Are you sure you'd like to delete the
 * Lunch at Panera expense?" followed by "What would you like me to delete?".
 */
export function shouldAppendClarifyingQuestion(input: {
  question: string | null | undefined;
  reply: string | null | undefined;
  confidence: number;
  projectionsCount: number;
  actionsCount: number;
  /** The user's message, when known. */
  message?: string | null;
}): boolean {
  const q = String(input.question || "").trim();
  if (!q) return false;
  // The user ASKED something and was answered. "Nothing was saved" is the
  // normal outcome of a question, not a sign the message was misunderstood:
  // "Summarize what I wrote in my journal today" got a correct summary and
  // then "I don't have access to your journal entries. Did you want to
  // paste…?" from the capture classifier (live check, 2026-11-20).
  if (input.message && String(input.reply || "").trim() && classifyTurnScope(input.message).allowedMutations === "none") return false;
  if (input.confidence >= 0.7) return false;
  if (input.projectionsCount > 0) return false;
  // The assistant did something this turn: its own summary is the answer.
  if (input.actionsCount > 0) return false;
  const reply = String(input.reply || "").trim();
  // The assistant already asked the user something (a confirmation, a
  // disambiguation): a second, unrelated question on top is noise.
  if (/\?/.test(reply)) return false;
  // The assistant already asked this very question.
  if (reply.toLowerCase().includes(q.toLowerCase().slice(0, 40))) return false;
  return true;
}

/** The reply with the question appended, or the question alone on an empty reply. */
export function appendClarifyingQuestion(reply: string, question: string): string {
  const existing = String(reply || "").trim();
  const q = String(question || "").trim();
  return existing ? `${existing}\n\n${q}` : q;
}
