// ─── Alert snoozes: one store, every device ─────────────────────────────────
//
// "Hide this alert for a while" is presentation, not a change to the record it
// is about. Two things were wrong with how the dashboard's Action Required list
// did it (audit 2026-10-09):
//
//   · Dismissals lived in this browser's localStorage, so an alert hidden on
//     the phone was still on the laptop — two devices, two answers (Rule 1).
//   · The bill "Snooze 7d" button PATCHed the obligation's `nextDueDate` seven
//     days out. That is not snoozing a reminder, it is rewriting when the bill
//     is due: the calendar, the bills list, cash flow and the bell all moved to
//     a date the biller never set, and the real due date passed silently
//     (Rule 9 — a convenience control must never alter the record).
//
// Now a snooze is `{ key: "YYYY-MM-DD" }` — hidden through that local date — in
// ONE server preference that every device reads. Expired entries drop out on
// read; nothing about the task or bill itself changes.

export const ALERT_SNOOZES_PREF = "alert_snoozes";

export type SnoozeMap = Record<string, string>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the stored preference; anything malformed is simply "no snoozes". */
export function parseSnoozes(raw: unknown): SnoozeMap {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: SnoozeMap = {};
    for (const [k, until] of Object.entries(v)) if (typeof until === "string" && ISO.test(until)) out[k] = until;
    return out;
  } catch {
    return {};
  }
}

/** Snoozes still in force on `todayISO` (hidden THROUGH the until date). */
export function activeSnoozes(map: SnoozeMap, todayISO: string): SnoozeMap {
  const out: SnoozeMap = {};
  for (const [k, until] of Object.entries(map || {})) if (until >= todayISO) out[k] = until;
  return out;
}

export function isSnoozed(map: SnoozeMap, key: string, todayISO: string): boolean {
  const until = map?.[key];
  return typeof until === "string" && until >= todayISO;
}

/** `todayISO` + n calendar days. */
export function addDaysISO(todayISO: string, n: number): string {
  const d = new Date(`${todayISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Merge a new snooze into the LATEST stored map (read just before writing),
 * dropping expired entries — so two devices snoozing different alerts at once
 * both keep theirs instead of the second write erasing the first.
 */
export function mergeSnooze(latest: SnoozeMap, key: string, untilISO: string, todayISO: string): SnoozeMap {
  const next = activeSnoozes(latest, todayISO);
  if (!next[key] || next[key] < untilISO) next[key] = untilISO;
  return next;
}
