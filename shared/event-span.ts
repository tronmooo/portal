// shared/event-span.ts — an event's span must run forwards.
//
// The event schema validates each field's shape (a real calendar day, a real
// clock time) but nothing compared them, so an event could end before it
// started (15:00–14:00), span backwards (endDate before date) or repeat until
// a day before its first occurrence. Both storages run this on create and on
// the merged record of an edit, so every door (form, chat, import) agrees.

export interface EventSpanLike {
  date?: string | null;
  time?: string | null;
  endTime?: string | null;
  endDate?: string | null;
  allDay?: boolean | null;
  recurrence?: string | null;
  recurrenceEnd?: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^\d{2}:\d{2}$/;

/** A message describing why the span is impossible, or null when it is fine. */
export function eventSpanError(e: EventSpanLike): string | null {
  const date = DAY.test(String(e.date || "")) ? String(e.date) : null;
  if (!date) return null; // the schema reports a missing/invalid date itself
  const endDate = DAY.test(String(e.endDate || "")) ? String(e.endDate) : null;
  if (endDate && endDate < date) return `Event cannot end (${endDate}) before it starts (${date})`;
  const time = CLOCK.test(String(e.time || "")) ? String(e.time) : null;
  const endTime = CLOCK.test(String(e.endTime || "")) ? String(e.endTime) : null;
  // A same-day timed event: the clock has to move forwards. A multi-day span
  // may legitimately end at an earlier clock time on a later day.
  if (!e.allDay && time && endTime && (!endDate || endDate === date) && endTime < time) {
    return `Event cannot end (${endTime}) before it starts (${time})`;
  }
  const recurrence = String(e.recurrence || "none").toLowerCase();
  const recurrenceEnd = DAY.test(String(e.recurrenceEnd || "")) ? String(e.recurrenceEnd) : null;
  if (recurrence !== "none" && recurrenceEnd && recurrenceEnd < date) {
    return `A repeating event cannot stop (${recurrenceEnd}) before its first occurrence (${date})`;
  }
  return null;
}

/** Throw a 400-style error for an impossible span. */
export function assertEventSpan(e: EventSpanLike): void {
  const msg = eventSpanError(e);
  if (msg) {
    const err: any = new Error(msg);
    err.statusCode = 400;
    throw err;
  }
}
