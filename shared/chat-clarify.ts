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
}): boolean {
  const q = String(input.question || "").trim();
  if (!q) return false;
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
