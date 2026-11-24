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

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
const isoOfDayNumber = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/**
 * Moving an event moves all of it. An edit that changes `date` and says
 * nothing about `endDate` carries the stored end date by the same number of
 * days, so the span keeps its length (a one-day event stays one day).
 *
 * Without this, every event stored with an end date — a one-day event saved
 * with end = start, as chat and the import write it — could not be moved at
 * all: the calendar's Edit sent the new date alone, the merged record ended
 * before it started, and the whole edit was refused (owner report 2026-11-24:
 * "the event stayed on November 24 after I changed it to November 26").
 * Both storages apply it before `assertEventSpan`, so every door agrees.
 */
export function carryEventSpan<P extends EventSpanLike>(existing: EventSpanLike, patch: P): P {
  if (!patch || patch.date === undefined || patch.endDate !== undefined) return patch;
  const from = DAY.test(String(existing?.date || "")) ? String(existing.date) : null;
  const to = DAY.test(String(patch.date || "")) ? String(patch.date) : null;
  const end = DAY.test(String(existing?.endDate || "")) ? String(existing.endDate) : null;
  if (!from || !to || !end || from === to || end < from) return patch;
  return { ...patch, endDate: isoOfDayNumber(dayNumber(end) + dayNumber(to) - dayNumber(from)) };
}
