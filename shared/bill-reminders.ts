// shared/bill-reminders.ts — the "Bill due: <name>" tasks the due scan used to raise.
//
// Until 2026-11-22 the liability due scan (runLiabilityDueScan, server/routes.ts)
// created a task titled "Bill due: <name>" for every bill at or past its date.
// A bill is not a task (owner: "Bills belong to Finance and the Calendar, not
// Tasks"), a ticked reminder was created again on the next run, and with a
// stale due date the reminders were months old — they filled the Tasks card.
// The scan no longer raises them, and it retires the ones it made.
//
// Those tasks carry no marker of their own (source "manual", like a typed
// task), so this is their fingerprint: exactly what the scan wrote, and
// nothing a person would produce by accident.

export const BILL_REMINDER_TITLE_PREFIX = "Bill due: ";

export interface BillReminderTaskLike {
  title?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  dueTime?: string | null;
  description?: string | null;
  tags?: unknown[] | null;
  linkedProfiles?: unknown[] | null;
  source?: string | null;
}

/**
 * An OPEN task the due scan generated for a bill. `isBillOrGone(id)` answers
 * whether the one linked record is a recurring bill (active, paused or ended)
 * or no longer exists. A completed reminder is history and stays.
 *
 * Deliberately narrow — every field the scan set must still be as it set it:
 * the title prefix, one linked record, high priority, 09:00, and no tags or
 * description. A reminder the user edited (retimed, tagged, described) or a
 * task they typed themselves ("Bill due: call about the refund") is theirs.
 */
export function isGeneratedBillReminderTask(
  t: BillReminderTaskLike | null | undefined,
  isBillOrGone: (profileId: string) => boolean,
): boolean {
  if (!t || String(t.status || "") === "done") return false;
  const title = String(t.title || "");
  if (!title.startsWith(BILL_REMINDER_TITLE_PREFIX) || title.length <= BILL_REMINDER_TITLE_PREFIX.length) return false;
  const links = Array.isArray(t.linkedProfiles) ? t.linkedProfiles.map(String).filter(Boolean) : [];
  if (links.length !== 1 || !isBillOrGone(links[0])) return false;
  if (String(t.priority || "") !== "high") return false;
  if (String(t.dueTime || "").slice(0, 5) !== "09:00") return false;
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(t.dueDate || ""))) return false;
  if (String(t.description || "").trim()) return false;
  if (Array.isArray(t.tags) && t.tags.length > 0) return false;
  const source = String(t.source || "manual");
  return source === "manual";
}
