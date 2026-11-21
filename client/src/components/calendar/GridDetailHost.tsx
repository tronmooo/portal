// ── The calendar grid opens the same detail screen as everything else ───────
//
// Tapping a date on the month/week/agenda grid used to open its own dialog
// (EventDetailDialog), so the same birthday looked one way from the grid and
// another from the Recurring list. This host resolves the tapped timeline item
// to its occurrence in the one occurrence stream (useCalendarOccurrences) and
// shows `CalendarItemDetail` for it.
//
// When the item cannot be resolved — a kind the stream does not carry, a date
// outside its window, or a source that failed to load — it renders the
// fallback (the grid's own dialog), so a tap always opens something.

import type { ReactNode } from "react";
import type { CalendarTimelineItem } from "@shared/schema";
import { useCalendarOccurrences } from "@/hooks/useCalendarOccurrences";
import { CalendarItemDetail } from "./CalendarItemDetail";

export function GridDetailHost({ item, onClose, fallback }: {
  item: CalendarTimelineItem;
  onClose: () => void;
  fallback: ReactNode;
}) {
  const cal = useCalendarOccurrences({ lookbackDays: 120 });
  const day = String(item.date || "").slice(0, 10);
  const sourceId = String(item.sourceId || "");

  // The series this record is (or was merged into).
  const ownId = (o: { series: { id: string; source: { id: string } } }) => o.series.source.id === sourceId;
  const mergedInto = (seriesId: string) =>
    (cal.duplicatesBySeries.get(seriesId) || []).some((d) => d.endsWith(`:${sourceId}`));
  const mine = sourceId
    ? cal.occurrences.filter((o) => ownId(o) || mergedInto(o.seriesId))
    : [];
  const hit = mine.find((o) => o.effectiveDate === day) ?? mine.find((o) => o.date === day) ?? null;

  if (!hit) {
    // Still loading: wait rather than flash the old dialog and swap it out.
    if (cal.isLoading && !cal.isDegraded) return null;
    return <>{fallback}</>;
  }
  return (
    <CalendarItemDetail
      occurrence={hit}
      seriesOccurrences={cal.occurrencesForSeries(hit.seriesId)}
      getEventRow={cal.getEventRow}
      profileName={cal.profileName}
      todayISO={cal.todayISO}
      onClose={onClose}
    />
  );
}

export default GridDetailHost;
