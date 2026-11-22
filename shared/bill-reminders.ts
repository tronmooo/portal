// shared/bill-reminders.ts — is there already a reminder for this bill occurrence?
//
// The due scan (runLiabilityDueScan, server/routes.ts) raises one reminder task
// per bill occurrence. "Already raised" includes a reminder the user completed:
// ticking it done is their answer for that occurrence, and a scan that looked
// only at OPEN tasks created the same reminder again on its next run.

/** True when a task with this title exists for this due day, open or done. */
export function hasBillReminderFor(tasks: readonly any[] | null | undefined, title: string, due: string | null | undefined): boolean {
  if (!due) return false;
  return (tasks || []).some((t: any) =>
    t?.title === title && String(t?.dueDate || "").slice(0, 10) === due);
}
