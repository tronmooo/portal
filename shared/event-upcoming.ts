/**
 * The next occurrence of every calendar event, for the assistant's context.
 *
 * The chat prompt used to list "upcoming events" by each event's BASE date,
 * so a daily stand-up anchored ten days ago was invisible ("no upcoming
 * events listed for your account") and the assistant could not act on it.
 * A recurring series is upcoming when its NEXT occurrence is; a one-time
 * event when its date has not passed. Both compare local calendar days.
 */
import { nextOccurrence, humanRecurrenceLabel, type RecurringEventLike } from "./recurring-dates";

export interface UpcomingEventLine {
  id: string;
  title: string;
  /** The next occurrence (YYYY-MM-DD), today or later. */
  date: string;
  time?: string | null;
  /** Human recurrence label ("daily", "every Tuesday"), or null for one-time. */
  recurrence: string | null;
}

export function upcomingEventOccurrences(
  events: ReadonlyArray<RecurringEventLike & { id: string; title: string; time?: string | null }>,
  todayISO: string,
  limit = 10,
): UpcomingEventLine[] {
  const out: UpcomingEventLine[] = [];
  for (const ev of events) {
    const base = String(ev.date || "").slice(0, 10);
    const recurring = !!ev.recurrence && ev.recurrence !== "none";
    const next = recurring ? nextOccurrence(ev, todayISO) : (base >= todayISO ? base : null);
    if (!next) continue;
    out.push({
      id: ev.id,
      title: ev.title,
      date: next,
      time: ev.time ?? null,
      recurrence: recurring ? humanRecurrenceLabel(String(ev.recurrence), base) : null,
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.time || "").localeCompare(String(b.time || ""))));
  return out.slice(0, limit);
}
