// Recurrence for recurring-bill liabilities (utility, phone plan, streaming, …).
//
// A recurring liability is not a balance you pay down — it is a monthly (or
// yearly/weekly) service charge with a rolling due date. Instead of an
// amortization schedule it stores a single "next due date" in `fields.dueDate`
// and a cadence in `fields.frequency`; logging a payment advances that date by
// one cycle. This mirrors how tasks recur (shared/recurrence.ts) but reads the
// cadence off the liability profile's own fields rather than tag strings.
//
// Pure + dependency-free (only imports the shared recurrence primitives), so
// client, server, and tests share one definition.

import { freqToUnit, advance, type RecurrenceRule } from "./recurrence";

/** Normalize a user/registry frequency label to a recurrence freq token. */
export function normalizeBillFrequency(input?: string | null): string {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "monthly"; // bills default to monthly
  if (["monthly", "month", "every month", "mo", "/mo"].includes(s)) return "monthly";
  if (["yearly", "annual", "annually", "year", "/yr", "per year"].includes(s)) return "yearly";
  if (["weekly", "week", "/wk"].includes(s)) return "weekly";
  if (["biweekly", "every 2 weeks", "fortnightly"].includes(s)) return "every-2-weeks";
  if (["daily", "day"].includes(s)) return "daily";
  if (["quarterly", "quarter", "every 3 months"].includes(s)) return "every-3-months";
  if (["semiannual", "semi-annual", "semiannually", "semi-annually", "biannual", "biannually", "every 6 months", "twice a year"].includes(s)) return "every-6-months";
  if (["bimonthly", "bi-monthly", "every 2 months", "every other month"].includes(s)) return "every-2-months";
  // Already a recur token (e.g. "every-2-weeks")? pass through.
  return s;
}

/** Build a one-shot recurrence rule from a bill frequency (no end condition). */
export function billRecurrenceRule(frequency?: string | null): RecurrenceRule {
  const freq = normalizeBillFrequency(frequency);
  // freqToUnit doesn't know "every-3-months"; map it here.
  const q = freq.match(/^every-(\d+)-months?$/);
  if (q) {
    return { freq, interval: Math.max(1, +q[1]), unit: "month", until: undefined, count: undefined, done: 0, paused: false };
  }
  const { unit, interval } = freqToUnit(freq);
  return { freq, interval, unit, until: undefined, count: undefined, done: 0, paused: false };
}

/**
 * The day-of-month a monthly/yearly bill is pinned to.
 *
 * A bill due on the 31st advances to Feb 28 (the month is short), and that
 * clamped date is what gets STORED as the next due date. Advancing again from
 * the stored date without an anchor gave Mar 28, then Apr 28: one payment on a
 * short month silently turned a "due on the 31st" bill into a "due on the
 * 28th" bill, while the calendar — generated from `firstPaymentDate` with the
 * anchor intact — kept saying the 31st. See shared/date-math.ts.
 *
 * The anchor is the current due date's own day, except when that day is the
 * LAST day of its month and the series origin (`firstPaymentDate`, which the
 * storage writes on create and on every explicit due-date edit) names a later
 * day: a month-end date is the only thing clamping ever produces, so that is
 * the one case where the stored day is not the user's intent.
 */
export function liabilityAnchorDay(fields: any, currentISO: string): number | undefined {
  const cur = String(currentISO || "").slice(0, 10);
  const m = cur.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (!(day >= 1 && day <= 31)) return undefined;
  const lastOfMonth = new Date(year, month, 0).getDate();
  if (day < lastOfMonth) return day;
  const f = fields || {};
  const origin = String(f.firstPaymentDate ?? f.first_payment_date ?? "").slice(0, 10);
  const om = origin.match(/^\d{4}-\d{2}-(\d{2})$/);
  const originDay = om ? Number(om[1]) : NaN;
  return originDay > day && originDay <= 31 ? originDay : day;
}

/**
 * The field patch that moves a bill to its next occurrence after `occDate`
 * was paid or skipped. Every entry point that advances a stored due date
 * applies THIS, so they all pin the series origin the same way: a bill that
 * never had a `firstPaymentDate` gets the occurrence just settled as its
 * origin — the last date known to carry the user's intended day-of-month —
 * before the clamped next date is written over `dueDate`.
 */
/** True for a bill that happens exactly once (no next occurrence to advance to). */
export function isOneTimeFrequency(frequency?: string | null): boolean {
  const s = String(frequency ?? "").trim().toLowerCase();
  return s === "once" || s === "one-time" || s === "one_time" || s === "onetime" || s === "one time" || s === "single";
}

export function advanceLiabilityDueDatePatch(
  fields: any,
  occDate: string,
): { dueDate: string; nextDueDate: string; firstPaymentDate?: string } {
  const f = fields || {};
  const next = advanceLiabilityDueDate(f, occDate);
  const patch: { dueDate: string; nextDueDate: string; firstPaymentDate?: string } = { dueDate: next, nextDueDate: next };
  const origin = String(f.firstPaymentDate ?? f.first_payment_date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(origin) && /^\d{4}-\d{2}-\d{2}$/.test(String(occDate || "").slice(0, 10))) {
    patch.firstPaymentDate = String(occDate).slice(0, 10);
  }
  return patch;
}

/** Read the current next-due date from a liability's fields (YYYY-MM-DD or ""). */
export function readDueDate(fields: any): string {
  const f = fields || {};
  return String(f.dueDate ?? f.due_date ?? f.nextDueDate ?? f.next_due_date ?? f.renewalDate ?? f.renewal_date ?? "").slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day an occurrence actually falls on: its `movedTo` override when the
 * user rescheduled it, else the occurrence's own (anchor) day.
 *
 * Occurrences are KEYED by their anchor day (`fields.occurrences[anchor]`);
 * a reschedule stores `movedTo` under that key and the schedule generator
 * shows the moved day as `effectiveDate`. Every other reader (the bills list,
 * the bell, the due-scan cron, the reminder task) kept using the anchor, so a
 * bill moved from the 5th to the 12th stayed "due on the 5th" everywhere but
 * the schedule.
 */
export function effectiveDueDate(fields: any, anchorISO: string): string {
  const anchor = String(anchorISO || "").slice(0, 10);
  const ov = (fields || {}).occurrences?.[anchor];
  const moved = ov && typeof ov === "object" ? String(ov.movedTo || "").slice(0, 10) : "";
  return DAY_RE.test(moved) ? moved : anchor;
}

/** `readDueDate`, with the current occurrence's reschedule applied. */
export function readEffectiveDueDate(fields: any): string {
  const anchor = readDueDate(fields);
  return anchor ? effectiveDueDate(fields, anchor) : anchor;
}

/**
 * The anchor key for a day the caller addresses: a payment or skip aimed at
 * the MOVED day (the one the calendar and the bills list show) must settle
 * the occurrence under its anchor key, or the anchor stays unsettled and the
 * bill is offered again.
 */
export function resolveOccurrenceKey(fields: any, dateISO: string): string {
  const day = String(dateISO || "").slice(0, 10);
  const occ = (fields || {}).occurrences;
  if (!occ || typeof occ !== "object") return day;
  if (occ[day]) return day;
  for (const [key, ov] of Object.entries(occ as Record<string, any>)) {
    if (ov && typeof ov === "object" && String(ov.movedTo || "").slice(0, 10) === day) return key;
  }
  return day;
}

/**
 * Advance a recurring liability's due date by one cycle.
 * `todayISO` is the caller's local YYYY-MM-DD; when the stored due date is
 * missing or already in the past we roll forward from today so the next due
 * date is always in the future.
 */
export function advanceLiabilityDueDate(fields: any, todayISO: string): string {
  const current = readDueDate(fields);
  // A one-time bill has nothing to advance to. The generic rule read "once"
  // as a daily cadence, so paying a deposit moved its due date to tomorrow —
  // one day past the paid stamp — and it stayed "upcoming" forever.
  if (isOneTimeFrequency((fields || {}).frequency ?? (fields || {}).billingFrequency)) return current;
  const rule = billRecurrenceRule((fields || {}).frequency ?? (fields || {}).billingFrequency);
  const base = current && current >= todayISO ? current : (current || todayISO);
  rule.anchorDay = liabilityAnchorDay(fields, base);
  let next = advance(base, rule);
  // If advancing one cycle from a stale past date still lands in the past,
  // keep rolling until the next due date is today or later. An occurrence the
  // user already settled (paid early from the calendar, or skipped) is not
  // "next due" either: landing on it left the bill stuck — every later
  // "Mark paid" hit the paid stamp and answered as a duplicate, and the
  // reminder named a date that was already paid.
  let guard = 0;
  while ((next < todayISO || isSettledOccurrence(fields, next)) && guard < 240) {
    next = advance(next, rule);
    guard++;
  }
  return next;
}

/** Has this series date already been paid or skipped via a per-occurrence override? */
export function isSettledOccurrence(fields: any, dateISO: string): boolean {
  const occ = (fields || {}).occurrences;
  if (!occ || typeof occ !== "object") return false;
  const status = occ[String(dateISO || "").slice(0, 10)]?.status;
  return status === "paid" || status === "skipped";
}

/**
 * A paused or cancelled bill has no occurrence to remind about, pay or warn
 * for. The bills list already hid one (`isActiveObligation`), but the bell
 * and the due-scan cron read the profile rows directly and kept warning,
 * reminding — and, for an autopay bill, paying — while it was paused.
 */
/**
 * A finite series with no occurrence left: its `recurrenceEnd` is before the
 * occurrence that would come next. The calendar already draws nothing for it;
 * the bills list still called it "active" with a next due date and the daily
 * due-scan still wrote a "Bill due" reminder for it (D252).
 */
export function isEndedBillFields(fields: any, nextDueISO?: string | null): boolean {
  const f = fields || {};
  const next = String(nextDueISO || readDueDate(f) || "").slice(0, 10);
  const end = typeof f.recurrenceEnd === "string" ? f.recurrenceEnd.slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && /^\d{4}-\d{2}-\d{2}$/.test(next) && next > end) return true;
  // A fixed number of occurrences ("2 payments"): once that many are settled
  // (paid or skipped) there is nothing left to come due (D253).
  const count = parseInt(String(f.count ?? f.totalTerm ?? ""), 10);
  if (Number.isFinite(count) && count > 0) {
    const occ = f.occurrences && typeof f.occurrences === "object" ? f.occurrences : {};
    const settled = Object.values(occ as Record<string, any>).filter((o) => {
      const st = String(o?.status || "").toLowerCase();
      return st === "paid" || st === "skipped";
    }).length;
    if (settled >= count) return true;
  }
  return false;
}

export function isPausedBillFields(fields: any): boolean {
  const f = fields || {};
  if (f.paused === true) return true;
  const status = String(f.status || "").toLowerCase();
  return status === "paused" || status === "cancelled";
}
