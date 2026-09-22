// shared/temporal-status.ts — THE date engine (Rule 13).
//
// One function answers "when is this record next due, and where does it stand
// relative to today?" for every kind of dated record. Chat, Finance, the
// Dashboard, the Calendar and Notifications call it; none of them compute a
// next-due on their own.
//
// Regression that made this necessary (2026-09): a loan due on the 25th, last
// paid Sep 20, on Sep 26 — the loan detail page (shared/loan-facts
// `nextLoanDueDate`) said Oct 25 while the chat context read the raw stored
// `dueDate` (Sep 25) and told the user their payment was overdue. Six
// resolvers existed; this routes every caller to the right one:
//
//   record kind               resolver (unchanged, reused)              source
//   ─────────────────────────  ────────────────────────────────────────  ─────────────
//   liability, recurring bill  liability-recurrence currentBillDueDate    bill_schedule
//                              (+ effectiveDueDate for a moved occurrence)
//   liability, loan / card     loan-facts nextLoanDueDate                 loan_schedule
//   liability, one-time debt   liability-fields readStoredDueDate         stored_date
//   obligation (server row)    row.nextDueDate (+ isActiveObligation)     stored_date
//   task (one-time)            row.dueDate                                stored_date
//   task (repeating)           task-occurrences taskOccurrenceDates       recurrence
//   event (one-time)           row.date                                   stored_date
//   event (repeating)          recurring-dates nextOccurrence             recurrence
//   income                     nextPayDate / date, advanced by frequency  stored_date | recurrence
//   document                   date-rules documentExpirationDate          stored_date
//   habit                      habit-schedule isHabitDueOn (next day on)  recurrence
//   goal                       row.deadline / targetDate                  stored_date
//
// `todayISO` is ALWAYS the user's calendar day: `getUserToday(tz)` from
// shared/timezone on the server (the request's X-Timezone / stored zone) and
// `getUserToday(BROWSER_TIMEZONE)` on the client. Never `new Date()` here.
//
// Rule 14: payment history is not a schedule. Nothing in this file infers a
// due date from a payment date; a bill with no schedule is `none` ("Not
// scheduled"), not "last paid + 1 month".
//
// Pure, dependency-free of the server. Pinned by tests/temporal-status.test.ts.

import { daysBetweenISO, bareDateOf, documentExpirationDate } from "./date-rules";
import { advanceISO } from "./date-math";
import { normalizeDateString } from "./extraction-normalize";
import { isRecurringBillRecord, liabilityFamily, liabilityTypeKeyOf } from "./liability-types";
import { currentBillDueDate, effectiveDueDate, isEndedBillFields, isPausedBillFields, isOneTimeFrequency, isSettledOccurrence } from "./liability-recurrence";
import { nextLoanDueDate } from "./loan-facts";
import { readStoredDueDate } from "./liability-fields";
import { isActiveObligation } from "./obligation-windows";
import { taskOccurrenceDates, taskRepeats } from "./task-occurrences";
import { nextOccurrence as nextEventOccurrence } from "./recurring-dates";
import { isHabitDueOn } from "./habit-schedule";

export type TemporalStatus = "overdue" | "due_today" | "upcoming" | "scheduled" | "none" | "ended";

export type TemporalSource = "loan_schedule" | "bill_schedule" | "stored_date" | "recurrence" | "none";

export interface RecordTemporalStatus {
  status: TemporalStatus;
  /** The next occurrence as YYYY-MM-DD, or null when nothing schedules one. */
  nextOccurrence: string | null;
  /** Whole calendar days past due (positive), or null unless overdue. */
  overdueBy: number | null;
  /** Whole calendar days until due (0 = today), or null unless due today or later. */
  dueIn: number | null;
  /** "Overdue 3d" · "Due today" · "Due in 5d" · "Sep 25" · "Not scheduled" · "Ended". */
  displayLabel: string;
  /** Which resolver produced `nextOccurrence`. */
  source: TemporalSource;
}

export type TemporalRecordKind = "liability" | "obligation" | "task" | "event" | "income" | "document" | "habit" | "goal";

export interface TemporalRecord {
  kind: TemporalRecordKind;
  /** The profile's `fields` (liabilities) — or the record itself when it has no fields object. */
  fields?: any;
  /** The row (profile / task / event / …) — carries `type_key`, `status`, `date`, … */
  row?: any;
  /** Subtype override when neither `row` nor `fields` names one. */
  typeKey?: string | null;
}

export interface TemporalOptions {
  /**
   * Days past due after which an unpaid occurrence is history ("Missed"),
   * reported as `ended` rather than `overdue`. Default: no limit (every past
   * due date is overdue until settled).
   */
  graceDays?: number;
  /** Days ahead that still count as "upcoming" rather than merely "scheduled". Default 30. */
  upcomingDays?: number;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const clipISO = (v: unknown): string | null => {
  const s = String(v ?? "").slice(0, 10);
  return ISO_DAY.test(s) ? s : null;
};

const NONE: RecordTemporalStatus = { status: "none", nextOccurrence: null, overdueBy: null, dueIn: null, displayLabel: "Not scheduled", source: "none" };
const ENDED: RecordTemporalStatus = { status: "ended", nextOccurrence: null, overdueBy: null, dueIn: null, displayLabel: "Ended", source: "none" };

/** Short "Sep 25" / "Sep 25, 2027" for a scheduled-but-not-soon date. */
function shortDate(iso: string, todayISO: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const sameYear = iso.slice(0, 4) === todayISO.slice(0, 4);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC", ...(sameYear ? {} : { year: "numeric" }) });
}

/**
 * Classify a resolved date against today. ONE calendar-day diff
 * (shared/date-rules `daysBetweenISO`) — never a millisecond division.
 */
export function classifyDate(
  nextISO: string | null,
  todayISO: string,
  source: TemporalSource,
  opts: TemporalOptions = {},
): RecordTemporalStatus {
  const next = clipISO(nextISO);
  const today = clipISO(todayISO);
  if (!next || !today) return { ...NONE, source: next ? source : "none" };
  const delta = daysBetweenISO(today, next);
  if (delta < 0) {
    const overdueBy = -delta;
    if (opts.graceDays != null && overdueBy > opts.graceDays) {
      return { status: "ended", nextOccurrence: next, overdueBy, dueIn: null, displayLabel: `Missed · ${shortDate(next, today)}`, source };
    }
    return { status: "overdue", nextOccurrence: next, overdueBy, dueIn: null, displayLabel: `Overdue ${overdueBy}d`, source };
  }
  if (delta === 0) return { status: "due_today", nextOccurrence: next, overdueBy: null, dueIn: 0, displayLabel: "Due today", source };
  const horizon = opts.upcomingDays ?? 30;
  if (delta <= horizon) {
    return { status: "upcoming", nextOccurrence: next, overdueBy: null, dueIn: delta, displayLabel: delta === 1 ? "Due tomorrow" : `Due in ${delta}d`, source };
  }
  return { status: "scheduled", nextOccurrence: next, overdueBy: null, dueIn: delta, displayLabel: shortDate(next, today), source };
}

// ── Liabilities ──────────────────────────────────────────────────────────────

function liabilityStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || {};
  const fields = record.fields ?? row.fields ?? {};
  const probe = { ...row, fields, ...(record.typeKey ? { type_key: record.typeKey } : {}) };
  const typeKey = liabilityTypeKeyOf(probe);

  if (isRecurringBillRecord(probe)) {
    // The stored date is a cache the shared rule corrects: a cycle rolled
    // forward over an unpaid occurrence answers with the cycle still owed
    // (F-16), and a rescheduled occurrence is due on the day it moved to.
    const anchor = clipISO(currentBillDueDate(fields, todayISO));
    if (!anchor) return NONE;
    if (isOneTimeFrequency(fields.frequency ?? fields.billingFrequency) && isSettledOccurrence(fields, anchor)) return { ...ENDED, source: "bill_schedule" };
    if (isEndedBillFields(fields, anchor)) return { ...ENDED, source: "bill_schedule" };
    if (isPausedBillFields(fields)) return { ...NONE, displayLabel: "Paused", source: "bill_schedule" };
    return classifyDate(effectiveDueDate(fields, anchor), todayISO, "bill_schedule", opts);
  }

  const family = liabilityFamily(typeKey);
  if (family === "one_time") {
    return classifyDate(readStoredDueDate(fields), todayISO, "stored_date", opts);
  }
  // Loans and cards: the payment day counted from today (never the origin).
  return classifyDate(nextLoanDueDate(fields, todayISO), todayISO, "loan_schedule", opts);
}

// ── Other record kinds ───────────────────────────────────────────────────────

function obligationStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const next = clipISO(row.nextDueDate ?? row.next_due_date ?? row.dueDate ?? row.due_date);
  if (!isActiveObligation({ status: row.status, nextDueDate: next, recurrenceEnd: row.recurrenceEnd })) {
    return row.status === "paused" ? { ...NONE, displayLabel: "Paused" } : ENDED;
  }
  return classifyDate(next, todayISO, "stored_date", opts);
}

function taskStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const status = String(row.status || "").trim().toLowerCase();
  const base = clipISO(row.dueDate ?? row.due_date ?? row.dueAt ?? row.due_at);
  if (!base) return NONE;
  if (taskRepeats(row)) {
    // First projected occurrence on or after today; the walk stops at the
    // series' own end/count, so a finished series is `ended`.
    const horizon = advanceISO(todayISO, "yearly");
    const dates = taskOccurrenceDates(row, todayISO < base ? base : todayISO, horizon, { todayISO });
    if (dates.length === 0) return status === "done" ? ENDED : { ...ENDED, source: "recurrence" };
    return classifyDate(dates[0], todayISO, "recurrence", opts);
  }
  if (status === "done" || status === "completed" || status === "cancelled") return { ...ENDED, displayLabel: "Done" };
  return classifyDate(base, todayISO, "stored_date", opts);
}

function eventStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const base = clipISO(row.date ?? row.startDate ?? row.start_date ?? row.startAt ?? row.start_at);
  if (!base) return NONE;
  const recurring = !!row.recurrence && row.recurrence !== "none";
  if (recurring) {
    const next = nextEventOccurrence({ ...row, date: base }, todayISO);
    if (!next) return { ...ENDED, source: "recurrence" };
    return classifyDate(next, todayISO, "recurrence", opts);
  }
  // A past one-time event is over, not overdue.
  if (base < todayISO) return { status: "ended", nextOccurrence: base, overdueBy: null, dueIn: null, displayLabel: `Past · ${shortDate(base, todayISO)}`, source: "stored_date" };
  return classifyDate(base, todayISO, "stored_date", opts);
}

function incomeStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const stored = clipISO(row.nextPayDate ?? row.next_pay_date ?? row.nextDate ?? row.next_date ?? row.date ?? row.startDate);
  if (!stored) return NONE;
  const frequency = String(row.frequency || "").toLowerCase();
  if (!frequency || frequency === "once" || frequency === "one-time" || frequency === "one_time") {
    if (stored < todayISO) return { status: "ended", nextOccurrence: stored, overdueBy: null, dueIn: null, displayLabel: `Received · ${shortDate(stored, todayISO)}`, source: "stored_date" };
    return classifyDate(stored, todayISO, "stored_date", opts);
  }
  // Recurring income rolls forward from its stored date by its own cadence
  // (shared/date-math), anchored on the stored day-of-month.
  let next = stored;
  const anchorDay = Number(stored.slice(8, 10)) || undefined;
  for (let guard = 0; guard < 400 && next < todayISO; guard++) {
    const adv = advanceISO(next, frequency, anchorDay);
    if (!ISO_DAY.test(adv) || adv <= next) break;
    next = adv;
  }
  const source: TemporalSource = next === stored ? "stored_date" : "recurrence";
  const end = clipISO(row.endDate ?? row.end_date);
  if (end && next > end) return { ...ENDED, source };
  return classifyDate(next, todayISO, source, opts);
}

function documentStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const exp = clipISO(row.expirationDate ?? row.expiration_date ?? (row.id ? documentExpirationDate(row) : null));
  if (!exp) return NONE;
  const r = classifyDate(exp, todayISO, "stored_date", opts);
  if (r.status === "overdue") return { ...r, displayLabel: `Expired ${r.overdueBy}d ago` };
  if (r.status === "due_today") return { ...r, displayLabel: "Expires today" };
  if (r.status === "upcoming") return { ...r, displayLabel: `Expires in ${r.dueIn}d` };
  return r;
}

function habitStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const end = clipISO(row.endDate ?? row.end_date);
  if (end && end < todayISO) return { ...ENDED, source: "recurrence" };
  // The next day the habit is scheduled on, today included.
  let day = todayISO;
  for (let i = 0; i < 366; i++) {
    if (isHabitDueOn(row, day)) return classifyDate(day, todayISO, "recurrence", opts);
    day = advanceISO(day, "daily");
    if (end && day > end) break;
  }
  return { ...NONE, source: "recurrence" };
}

function goalStatus(record: TemporalRecord, todayISO: string, opts: TemporalOptions): RecordTemporalStatus {
  const row = record.row || record.fields || {};
  const status = String(row.status || "").toLowerCase();
  if (status === "completed" || status === "done" || status === "achieved") return { ...ENDED, displayLabel: "Completed" };
  const deadline = clipISO(row.deadline ?? row.targetDate ?? row.target_date ?? row.dueDate);
  return classifyDate(deadline, todayISO, "stored_date", opts);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * The temporal status of any dated record relative to the user's `todayISO`.
 * See the routing table at the top of this file.
 */
export function getRecordTemporalStatus(
  record: TemporalRecord,
  todayISO: string,
  opts: TemporalOptions = {},
): RecordTemporalStatus {
  const today = clipISO(todayISO) ?? clipISO(normalizeDateString(todayISO));
  if (!record || !today) return NONE;
  switch (record.kind) {
    case "liability": return liabilityStatus(record, today, opts);
    case "obligation": return obligationStatus(record, today, opts);
    case "task": return taskStatus(record, today, opts);
    case "event": return eventStatus(record, today, opts);
    case "income": return incomeStatus(record, today, opts);
    case "document": return documentStatus(record, today, opts);
    case "habit": return habitStatus(record, today, opts);
    case "goal": return goalStatus(record, today, opts);
    default: return NONE;
  }
}

/** Convenience: the next occurrence only (null when nothing schedules one). */
export function nextOccurrenceOf(record: TemporalRecord, todayISO: string): string | null {
  return getRecordTemporalStatus(record, todayISO).nextOccurrence;
}

/** `bareDateOf` re-exported so callers that only have a raw value can classify it the same way. */
export function classifyStoredDate(value: unknown, todayISO: string, opts: TemporalOptions = {}): RecordTemporalStatus {
  return classifyDate(bareDateOf(value), todayISO, "stored_date", opts);
}
