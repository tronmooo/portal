// ─── Recurring-bill reminder offsets ─────────────────────────────────────────
// A recurring bill (liability profile) can carry `fields.reminderLeadDays`:
// either a legacy single integer ("remind me 3 days before" → 3) or an array
// of lead-day offsets ("remind me 7 days, 3 days, and the morning of the due
// date" → [7, 3, 0], where 0 = the morning of the due date itself).
//
// These helpers are the single source of truth for reading that field — used
// by the AI create_obligation handler, Supabase storage, the liability-due-scan
// cron, and the client schedule UI — so every consumer agrees on bounds
// (0–60 days), the max offset count (5), and ordering (descending).

/** Normalize a stored/incoming reminderLeadDays value into a clean, deduped,
 *  descending array of lead-day offsets. Returns [] when unset/garbage. */
export function normalizeReminderLeads(v: unknown): number[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return Array.from(new Set(
    arr
      .map((x) => parseInt(String(x), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 60)
  )).sort((a, b) => b - a).slice(0, 5);
}

/** The local calendar date a reminder should fire for a due date + lead.
 *  Noon-UTC anchor sidesteps DST shifting the calendar date. */
export function reminderFireDate(dueISO: string, leadDays: number): string {
  const d = new Date(`${dueISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - leadDays);
  return d.toISOString().slice(0, 10);
}

/** Human label for the configured offsets, e.g. "7d, 3d, morning of before due".
 *  Null when no reminders are configured. */
export function reminderLeadsLabel(v: unknown): string | null {
  const leads = normalizeReminderLeads(v);
  if (leads.length === 0) return null;
  const parts = leads.map((n) => (n === 0 ? "morning of" : `${n}d`));
  return `${parts.join(", ")} before due`;
}
