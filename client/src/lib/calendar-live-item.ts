/**
 * The current version of an opened timeline item: the row with the same id in
 * the timeline as it is now; else the same RECORD under a new id; else the
 * snapshot (the item left the window).
 *
 * The Calendar's detail dialog used to render the snapshot taken at the tap,
 * so after "Mark as done" it went on offering "Mark as done" while the write
 * had landed (owner report 2026-11-24).
 *
 * An item's id carries its date (`event-<id>-<YYYY-MM-DD>`), so an edit that
 * MOVES the record gives it a new id. Matching on the id alone lost it: the
 * open detail kept the snapshot and read "Tuesday, November 24" (with the old
 * title) after the event had been saved on the 26th (owner report 2026-11-24).
 * The record is found again by what it is (`type` + `sourceId`): its only row,
 * or for a series the row nearest the date that was open.
 */
type LiveItem = { id: string; type?: string; sourceId?: string | null; date?: string | null };

const dayNumber = (iso: unknown) => {
  const s = String(iso || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86_400_000 : NaN;
};

export function liveTimelineItem<T extends LiveItem>(opened: T | null, timeline: readonly T[] | null | undefined): T | null {
  if (!opened) return null;
  if (!Array.isArray(timeline)) return opened;
  const same = timeline.find((i) => i && i.id === opened.id);
  if (same) return same;
  if (!opened.sourceId) return opened;
  const rows = timeline.filter((i) => i && i.sourceId === opened.sourceId && i.type === opened.type);
  if (rows.length === 0) return opened;
  if (rows.length === 1) return rows[0];
  const at = dayNumber(opened.date);
  if (Number.isNaN(at)) return opened;
  let best = rows[0];
  for (const r of rows) if (Math.abs(dayNumber(r.date) - at) < Math.abs(dayNumber(best.date) - at)) best = r;
  return best;
}
