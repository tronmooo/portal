// The undated `Reminder: …` tasks the retired reminder cron left behind.
//
// Until 2026-08-09 a scheduled job walked every pending reminder row and, each
// time one fell due, created a `Reminder: <title>` TASK as the in-app marker —
// with no due date, tagged `reminder`, source `reminder`. A daily reminder
// therefore minted a new open task every morning, and none was ever closed:
// "Reminder: Take medication (morning)" existed thirty times over and made up
// most of one account's "43 tasks due". Reminders were then folded into timed
// tasks and the job was retired, but its rows stayed. This is their
// fingerprint, so the sweep that retires them touches nothing a person typed.

export interface LegacyReminderTaskLike {
  title?: string | null;
  status?: string | null;
  dueDate?: string | null;
  tags?: unknown[] | null;
  source?: string | null;
}

export const LEGACY_REMINDER_TASK_SOURCE = "reminder";

/** An OPEN task the retired reminder cron minted. A completed one is history and stays. */
export function isLegacyReminderTask(t: LegacyReminderTaskLike): boolean {
  if (!t || String(t.source || "") !== LEGACY_REMINDER_TASK_SOURCE) return false;
  if (String(t.status || "") === "done") return false;
  if (String(t.dueDate || "").trim()) return false;
  const tags = Array.isArray(t.tags) ? t.tags.map(String) : [];
  if (!tags.includes("reminder")) return false;
  return /^reminder:\s/i.test(String(t.title || ""));
}
