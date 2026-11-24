/**
 * The current version of an opened timeline item: the row with the same id in
 * the timeline as it is now, else the snapshot (the item left the window).
 *
 * The Calendar's detail dialog used to render the snapshot taken at the tap,
 * so after "Mark as done" it went on offering "Mark as done" while the write
 * had landed (owner report 2026-11-24).
 */
export function liveTimelineItem<T extends { id: string }>(opened: T | null, timeline: readonly T[] | null | undefined): T | null {
  if (!opened) return null;
  return (Array.isArray(timeline) ? timeline.find((i) => i && i.id === opened.id) : undefined) ?? opened;
}
