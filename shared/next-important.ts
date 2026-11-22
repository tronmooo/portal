// shared/next-important.ts — what the dashboard's "Next Important" tile names.
//
// OWNER REPORT (2026-11-22): the tile read "Prilosec: 7 doses unlogged this
// week · Sun, Nov 22 (today)". That row is not an event: it is a count of
// doses nobody logged, stamped "today" so it has somewhere to sort — and the
// tile sorted by date alone, so it beat everything not dated today.
//
// The tile names the next thing that is actually ON THE CALENDAR: an event or
// appointment, a document date, a task with a due date, a goal deadline, a
// birthday, a payment. Among things on the same day, what it IS decides the
// order. A reading or a logging gap derived from a tracker has no date of its
// own and is never "next" by default; a medication the user asked to be
// alerted about (AttentionConfig.medicationGapTrackerIds) is eligible, and
// still yields to anything really scheduled that day.
//
// If nothing qualifies the answer is null and the tile says so. It never
// invents an item to fill the space.

import type { AttentionItem } from "./attention";

/** Lower = named first among items on the same day. */
function kindRank(i: AttentionItem): number {
  if (i.sourceKey.startsWith("tracker:")) return 9; // an opted-in dose gap
  switch (i.kind) {
    case "event": return 0;      // appointments, flights, occasions
    case "document": return 1;   // an expiration or a document's due date
    case "task": return 2;
    case "goal": return 3;
    case "reminder": return 4;   // a dose due now
    case "bill": return 5;       // a routine payment: upcoming, not an alarm
    default: return 6;
  }
}

/** Does this row stand for something with a real date on or after today? */
export function isNextImportantCandidate(i: AttentionItem | null | undefined): boolean {
  if (!i || i.daysUntil == null || i.daysUntil < 0) return false;
  // An event earlier today whose time has passed is not "next".
  if (i.kind === "event" && i.daysUntil === 0 && i.tier !== "immediate" && /passed/.test(i.reason || "")) return false;
  // Tracker-derived rows carry a made-up "today": an out-of-range reading and
  // a statistical anomaly belong to Wellness. Only the dose-gap row — which
  // exists only for a medication the user switched alerts on for — may pass.
  if (i.sourceKey.startsWith("tracker:") && !i.key.startsWith("adherence:")) return false;
  return true;
}

/** The single item the tile names, or null when nothing qualifies. */
export function pickNextImportant(items: readonly AttentionItem[] | null | undefined): AttentionItem | null {
  const rows = (items || []).filter(isNextImportantCandidate);
  if (rows.length === 0) return null;
  return rows
    .map((item, at) => ({ item, at }))
    .sort((a, b) =>
      (a.item.daysUntil! - b.item.daysUntil!)
      || (kindRank(a.item) - kindRank(b.item))
      || (a.at - b.at))[0].item;
}
