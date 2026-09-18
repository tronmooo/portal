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

// ── Tasks the 2026-08-09 reminder → timed-task migration created ────────────
//
// That migration (migrations/20260809_reminders_to_timed_tasks.sql) turned
// every reminder into a task tagged `migrated:reminder`, with the reminder's
// cadence as `recur:<freq>` and its last materialized firing as `runtil:`.
// The tag is bookkeeping, not a label the person typed, and once the series'
// `runtil:` is behind today the row is a closed chapter — "Take medication ·
// Repeats daily until Aug 11" four times over, in the completed list, with a
// `migrated:reminder` chip on each (QA 2026-09-18 F-29).

export const MIGRATED_REMINDER_TAG = "migrated:reminder";

/** A tag the migration wrote, never one the person chose — hidden from chips. */
export function isMigrationTag(tag: unknown): boolean {
  return /^migrated:/i.test(String(tag ?? ""));
}

export function isMigratedReminderTask(t: { tags?: unknown[] | null } | null | undefined): boolean {
  const tags = Array.isArray(t?.tags) ? t.tags.map(String) : [];
  return tags.includes(MIGRATED_REMINDER_TAG);
}

/**
 * A migrated reminder whose series has already run out (`runtil:` before
 * `todayISO`). Nothing can happen on it any more, so list surfaces fold it
 * away; the row itself is untouched.
 */
export function isRetiredMigratedReminderTask(t: { tags?: unknown[] | null } | null | undefined, todayISO: string): boolean {
  if (!isMigratedReminderTask(t)) return false;
  const today = String(todayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  const tags = Array.isArray(t?.tags) ? t.tags.map(String) : [];
  const until = tags.find((x) => x.startsWith("runtil:"))?.slice(7) || "";
  return /^\d{4}-\d{2}-\d{2}$/.test(until) && until < today;
}
