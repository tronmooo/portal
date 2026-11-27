// A goal asked for under the title of one that already exists.
//
// The chat's create_goal used to answer with the existing goal as if it had
// just been created: "I want to save $5,000 for a vacation by June", said
// while a $3,000 "Save for Vacation" goal existed, stored nothing and the
// person was told "Goal set — $5,000 by June" (chat-variations check on the
// preview, 2026-11-27). A confirmed change is a stored change (L2): the same
// goal asked for again is a duplicate and says so; a DIFFERENT target or
// deadline under the same title is a question for the person, never a silent
// success.
export interface GoalLike { title?: string | null; target?: number | string | null; deadline?: string | null }

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** What the request differs in from the goal already on file ([] = the same goal). */
export function goalRequestDiffers(existing: GoalLike, requested: GoalLike): Array<"target" | "deadline"> {
  const out: Array<"target" | "deadline"> = [];
  const want = num(requested.target);
  const have = num(existing.target);
  if (want !== null && (have === null || Math.abs(want - have) > 0.005)) out.push("target");
  const wantDay = day(requested.deadline);
  if (wantDay !== null && wantDay !== day(existing.deadline)) out.push("deadline");
  return out;
}

/** The question the chat must put to the person instead of claiming a save. */
export function goalConflictQuestion(existing: GoalLike & { unit?: string | null }, requested: GoalLike): string {
  const unit = existing.unit === "$" ? "$" : "";
  const fmt = (v: unknown) => { const n = num(v); return n === null ? "no target" : `${unit}${n.toLocaleString("en-US")}`; };
  const was = `${fmt(existing.target)}${day(existing.deadline) ? ` by ${day(existing.deadline)}` : ""}`;
  const now = `${fmt(requested.target ?? existing.target)}${day(requested.deadline) ? ` by ${day(requested.deadline)}` : ""}`;
  return `NOTHING WAS SAVED. A goal named "${existing.title}" already exists (${was}) and this request asks for ${now}. ` +
    `Do not say the goal was set or created. Ask the user which they want: change the existing goal to ${now} (then call update_goal), ` +
    `or keep it and add a second goal (then call create_goal with a different title).`;
}
