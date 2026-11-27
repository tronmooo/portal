// A message that takes back, in the same breath, the only thing it reported.
//
// Owner, 2026-11-27: "Undo must reverse only the intended action." The chat
// check's "I meditated again... no wait, I only did it once" asks for NOTHING:
// the "again" is withdrawn and what was already recorded stands. The model read
// "no wait" as an undo and removed the day's ONE check-in (the habit went to
// 0 of 1). A message of this shape is decided here, before any model call:
// nothing is written and nothing is removed.
//
// Deliberately narrow — it must hold all three:
//   1. a report of something done ("I meditated again", "took my vitamins");
//   2. then a withdrawal marker ("no wait", "scratch that", "never mind"…);
//   3. then a statement that it happened only once / was not done again —
//      with NO new instruction after it (no amount, no "make it", no "move").
// "spent $40… no wait, it was $45" is a correction with a new value and is
// NOT matched; neither is "undo that" (a real undo of the previous action).
const WITHDRAWAL = /\b(?:no[,.]?\s+wait|oh\s+wait|wait[,.]?\s+no|scratch\s+that|never\s*mind|nevermind|actually[,.]?\s+no|forget\s+(?:it|that)|my\s+bad|strike\s+that)\b/i;
const ONLY_ONCE = /\b(?:(?:i\s+)?only\s+(?:did|do|had|took|went|ran|logged)?\s*(?:it|that|one|them)?\s*(?:just\s+)?(?:once|one\s+time|the\s+one\s+time)|(?:it\s+was\s+)?just\s+(?:the\s+)?once|i\s+(?:didn'?t|did\s+not|haven'?t)(?:\s+(?:do|did)\s+(?:it|that))?(?:\s+(?:again|twice|a\s+second\s+time))|not\s+(?:again|twice))\b/i;
const NEW_INSTRUCTION = /\$\s?\d|\b\d+(?:\.\d+)?\s*(?:am|pm|lbs?|kg|miles?|mi|km|minutes?|mins?|hours?|hrs?|reps?|oz|ml|cups?|dollars?|bucks)\b|\b(?:make\s+(?:it|that)|change\s+(?:it|that)|move\s+(?:it|that)|should\s+(?:be|have\s+been)|it\s+was\s+\d|i\s+meant|instead|delete|remove|undo|cancel)\b/i;

/** True when the message reports something and then withdraws that report itself. */
export function retractsOwnClaim(message: unknown): boolean {
  const text = String(message ?? "").trim();
  if (!text || text.length > 240) return false;
  const w = WITHDRAWAL.exec(text);
  if (!w || w.index < 6) return false; // the withdrawal must FOLLOW a report
  const before = text.slice(0, w.index);
  const after = text.slice(w.index + w[0].length);
  if (!/[a-z]{3,}/i.test(before)) return false;
  if (!ONLY_ONCE.test(after)) return false;
  if (NEW_INSTRUCTION.test(after)) return false;
  return true;
}

export const RETRACTION_REPLY = "Okay — nothing changed. What was already recorded stays as it is.";
