// shared/domain/date-status.ts — ONE date-status engine.
//
// Eight status vocabularies existed (bill status, occurrence status, urgency,
// attention tier, task day-buckets, …) and "Due today" / "Overdue" were typed
// by hand in twelve places. The Executive card picked "next event" from
// today's rows by clock time alone, so a 7 AM soccer game stayed "Next up" at
// 10:30; a task due at 9 AM that was still open at 10 said "Due today".
//
// Every date-driven record resolves here to one of:
//   upcoming · due_today · happening_now · overdue · completed · expired ·
//   future · inactive
// and every surface reads the same label table.
//
// Pure. Pinned by tests/consistency-layer-dates.test.ts.

import { toLocalDateStr, toLocalTimeStr, DEFAULT_TIMEZONE } from "../timezone";

export type DateStatus =
  | "upcoming"       // dated later than today (within any horizon the caller applies)
  | "due_today"      // falls today and has not happened / is not yet due by clock
  | "happening_now"  // start ≤ now ≤ end (events with a span)
  | "overdue"        // past its date/time and still incomplete
  | "completed"      // done / paid / skipped
  | "expired"        // an expiry-type date that has passed (documents, policies)
  | "future"         // beyond the caller's horizon
  | "inactive";      // paused / cancelled / archived

export const DATE_STATUS_LABEL: Record<DateStatus, string> = {
  upcoming: "Upcoming",
  due_today: "Due today",
  happening_now: "Happening now",
  overdue: "Overdue",
  completed: "Completed",
  expired: "Expired",
  future: "Upcoming",
  inactive: "Inactive",
};

export type DateKind = "event" | "task" | "bill" | "document" | "habit" | "reminder" | "generic";

export interface DateStatusInput {
  /** YYYY-MM-DD (or full ISO) start / due date. */
  start?: string | null;
  /** YYYY-MM-DD end date for multi-day spans. */
  end?: string | null;
  /** HH:MM local start / due time. Absent = all day. */
  time?: string | null;
  /** HH:MM local end time. */
  endTime?: string | null;
  /** What the date means: an event happens, a task is due, a document expires. */
  kind?: DateKind;
  /** Done / paid / skipped. */
  completed?: boolean | null;
  /** Free-form status string ("done", "paid", "cancelled", "paused"…). */
  status?: string | null;
  /** False for paused / cancelled records. */
  active?: boolean | null;
  /** Records beyond this many days out are "future" rather than "upcoming". */
  horizonDays?: number | null;
  /** How long after a timed slot an event is still considered happening (min). */
  defaultDurationMinutes?: number | null;
}

export interface DateStatusResult {
  status: DateStatus;
  label: string;
  /** Negative = past, 0 = today, positive = days out; null when undated. */
  daysUntil: number | null;
  isPast: boolean;
  /** True when the record still needs something from the user. */
  actionable: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const DONE_STATUS = /^(done|completed?|paid|skipped|received|settled|resolved|closed)$/i;
const INACTIVE_STATUS = /^(paused|cancell?ed|archived|inactive|ended|abandoned)$/i;

function dayOf(v: string | null | undefined): string | null {
  const m = DAY_RE.exec(String(v || ""));
  return m ? m[0] : null;
}

function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86400000);
}

function minutesOf(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface Clock {
  /** YYYY-MM-DD in the user's zone. */
  today: string;
  /** Minutes since local midnight. */
  minutes: number;
}

/** The user-local clock for `now`. */
export function clockFor(now: Date = new Date(), timezone: string = DEFAULT_TIMEZONE): Clock {
  const today = toLocalDateStr(now, timezone);
  const minutes = minutesOf(toLocalTimeStr(now, timezone)) ?? now.getHours() * 60 + now.getMinutes();
  return { today, minutes };
}

/**
 * Resolve the status of one dated record against the user's clock.
 *
 *   now < start                      → upcoming (or future beyond the horizon)
 *   start ≤ now ≤ end                → happening_now (events) / due_today (tasks)
 *   now > end && incomplete          → overdue (tasks, bills) / expired (documents)
 *                                       / past events are "completed"
 *   completed / paid / skipped       → completed
 *   paused / cancelled               → inactive
 */
export function resolveDateStatus(input: DateStatusInput, clock: Clock): DateStatusResult {
  const kind: DateKind = input.kind ?? "generic";
  const finish = (status: DateStatus, daysUntil: number | null): DateStatusResult => ({
    status, label: DATE_STATUS_LABEL[status], daysUntil,
    isPast: status === "overdue" || status === "expired" || status === "completed",
    actionable: status === "overdue" || status === "due_today" || status === "happening_now" || status === "upcoming",
  });

  if (input.active === false || INACTIVE_STATUS.test(String(input.status || ""))) return finish("inactive", null);
  if (input.completed === true || DONE_STATUS.test(String(input.status || ""))) return finish("completed", null);

  const start = dayOf(input.start);
  if (!start) return finish("upcoming", null);
  const end = dayOf(input.end) ?? start;
  const daysUntil = daysBetween(clock.today, start);
  const daysUntilEnd = daysBetween(clock.today, end);
  const horizon = input.horizonDays ?? null;

  if (daysUntil > 0) {
    return finish(horizon !== null && daysUntil > horizon ? "future" : "upcoming", daysUntil);
  }

  // Today, or a span that includes today.
  if (daysUntil <= 0 && daysUntilEnd >= 0) {
    const startMin = daysUntil === 0 ? minutesOf(input.time) : null;
    const endMinRaw = daysUntilEnd === 0 ? minutesOf(input.endTime) : null;
    if (kind === "event") {
      if (startMin === null) return finish("happening_now", daysUntil); // all-day event today
      const endMin = endMinRaw ?? (startMin + (input.defaultDurationMinutes ?? 60));
      if (clock.minutes < startMin) return finish("upcoming", 0);
      if (clock.minutes <= endMin) return finish("happening_now", 0);
      return finish("completed", 0); // an event that already happened today needs nothing
    }
    if (kind === "document") return finish(daysUntilEnd === 0 && daysUntil === 0 ? "due_today" : "upcoming", daysUntil);
    // Tasks, bills, reminders, habits: due today until the clock passes the slot.
    if (startMin !== null && clock.minutes > startMin) return finish("overdue", 0);
    return finish("due_today", daysUntil);
  }

  // Past.
  if (kind === "event") return finish("completed", daysUntil);
  if (kind === "document") return finish("expired", daysUntil);
  return finish("overdue", daysUntil);
}

export interface DatedItem<T = unknown> extends DateStatusInput {
  record: T;
}

/**
 * The next thing that still matters: happening now first, then due today,
 * then the soonest upcoming. Completed and past items never qualify, so a
 * 7 AM game is not "next" at 10:30.
 */
export function nextImportantItem<T>(items: readonly DatedItem<T>[], clock: Clock): { item: DatedItem<T>; status: DateStatusResult } | null {
  const RANK: Partial<Record<DateStatus, number>> = { happening_now: 0, overdue: 1, due_today: 2, upcoming: 3, future: 4 };
  let best: { item: DatedItem<T>; status: DateStatusResult; rank: number; key: string } | null = null;
  for (const item of items) {
    const status = resolveDateStatus(item, clock);
    const rank = RANK[status.status];
    if (rank === undefined) continue;
    const key = `${dayOf(item.start) ?? "9999-99-99"}T${String(item.time || "00:00").padStart(5, "0")}`;
    if (!best || rank < best.rank || (rank === best.rank && key < best.key)) best = { item, status, rank, key };
  }
  return best ? { item: best.item, status: best.status } : null;
}

/** Adapters from app rows. */
export function dateInputFromTask(t: any): DateStatusInput {
  return { kind: "task", start: t?.dueDate ?? null, time: t?.dueTime ?? null, status: t?.status ?? null, completed: String(t?.status || "").toLowerCase() === "done" };
}
export function dateInputFromEvent(e: any): DateStatusInput {
  return { kind: "event", start: e?.date ?? e?.startDate ?? null, end: e?.endDate ?? null, time: e?.allDay ? null : (e?.time ?? null), endTime: e?.allDay ? null : (e?.endTime ?? null), completed: e?.completed === true };
}
export function dateInputFromBill(b: any, paid = false): DateStatusInput {
  return { kind: "bill", start: b?.nextDueDate ?? b?.dueDate ?? b?.fields?.dueDate ?? null, completed: paid, status: b?.status ?? null, active: b?.status ? !INACTIVE_STATUS.test(String(b.status)) : null };
}
export function dateInputFromDocument(d: any): DateStatusInput {
  return { kind: "document", start: d?.expirationDate ?? d?.fields?.expirationDate ?? null };
}
