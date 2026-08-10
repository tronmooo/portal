// Occurrence schedule for an income series — the positive mirror of
// shared/liability-schedule.ts.
//
// An income is ONE row (no per-occurrence table). Its individual pay dates are
// *derived* on the fly from the series' recurrence, then adjusted by a small map
// of per-occurrence exceptions kept on the row itself — so "skip December's rent
// income", "move this paycheck to the 18th", "mark today's paycheck received",
// or "pause until January" need no new table and no migration.
//
// fields.occurrences is keyed by the canonical (unshifted) YYYY-MM-DD date:
//   { "2026-08-14": { status?: "received"|"skipped", amount?, movedTo?, notes?,
//                     receiptId?, receivedAmount?, receivedDate? } }
// fields.paused / fields.pausedUntil suppress generation while paused.
//
// EXPECTED vs RECEIVED is the whole point of this module. A future paycheck is
// *projected* money; it only becomes *actual* money when a receipt lands. Both
// numbers are reported separately so an unpaid future paycheck can never make
// the user look richer than they are.
//
// Pure, dependency-free, no I/O. Pinned by tests/income-schedule.test.ts.

import { addDaysISO, addMonthsISO, daysInMonth, parseISODate, toISODate, weekdaySetFor } from "./date-math";

// ─── Frequencies ─────────────────────────────────────────────────────────────

/**
 * Cadences an income series can carry. `once` is a one-time income (bonus,
 * refund, sale) — it still flows through this engine so every surface reads
 * one shape.
 */
export const INCOME_FREQUENCIES = [
  "once", "daily", "weekly", "biweekly", "semimonthly",
  "monthly", "bimonthly", "quarterly", "semiannual", "yearly",
] as const;

export type NamedIncomeFrequency = (typeof INCOME_FREQUENCIES)[number];

/** A named cadence, an `every-N-days|weeks|months` token, or `weekly:<days>`. */
export type IncomeFrequency = NamedIncomeFrequency | string;

export const INCOME_FREQUENCY_LABELS: Record<NamedIncomeFrequency, string> = {
  once: "One-time",
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  bimonthly: "Every 2 months",
  quarterly: "Quarterly",
  semiannual: "Twice a year",
  yearly: "Yearly",
};

/** How many pay dates one year of this cadence produces. Used for annualizing. */
export function incomePeriodsPerYear(frequency: string | null | undefined): number {
  const f = normalizeIncomeFrequency(frequency);
  switch (f) {
    case "once": return 0;
    case "daily": return 365;
    case "weekly": return 52;
    case "biweekly": return 26;
    case "semimonthly": return 24;
    case "monthly": return 12;
    case "bimonthly": return 6;
    case "quarterly": return 4;
    case "semiannual": return 2;
    case "yearly": return 1;
    default: break;
  }
  const nd = f.match(/^every-(\d+)-days?$/);
  if (nd) return 365 / Math.max(1, +nd[1]);
  const nw = f.match(/^every-(\d+)-weeks?$/);
  if (nw) return 52 / Math.max(1, +nw[1]);
  const nm = f.match(/^every-(\d+)-months?$/);
  if (nm) return 12 / Math.max(1, +nm[1]);
  const set = weekdaySetFor(f);
  if (set) return set.size * 52;
  return 12;
}

/**
 * The average per-month value of a series, for "what does this add up to a
 * month" questions. NOT used for a real month's total — that comes from the
 * generated occurrences, which know about skips, edits, and short months.
 */
export function incomeMonthlyEquivalent(amount: number, frequency: string | null | undefined): number {
  const periods = incomePeriodsPerYear(frequency);
  if (!(periods > 0)) return 0;
  return (Number(amount) || 0) * periods / 12;
}

const FREQ_ALIASES: Record<string, NamedIncomeFrequency> = {
  "": "monthly",
  "one-time": "once", "onetime": "once", "one_time": "once", "single": "once", "none": "once",
  "bi-weekly": "biweekly", "fortnightly": "biweekly", "every-other-week": "biweekly",
  "every-2-weeks": "biweekly", "every-two-weeks": "biweekly",
  "semi-monthly": "semimonthly", "twice-monthly": "semimonthly", "twice-a-month": "semimonthly",
  "bi-monthly": "bimonthly", "every-2-months": "bimonthly",
  "semi-annual": "semiannual", "semiannually": "semiannual", "biannual": "semiannual",
  "twice-a-year": "semiannual", "every-6-months": "semiannual",
  "annual": "yearly", "annually": "yearly", "every-year": "yearly",
  "every-week": "weekly", "every-month": "monthly", "every-day": "daily",
  "every-quarter": "quarterly", "every-3-months": "quarterly",
};

/** Canonicalize any spelling users or the AI might send. */
export function normalizeIncomeFrequency(frequency: string | null | undefined): IncomeFrequency {
  const raw = String(frequency ?? "").toLowerCase().trim().replace(/\s+/g, "-");
  if (raw in FREQ_ALIASES) return FREQ_ALIASES[raw];
  if ((INCOME_FREQUENCIES as readonly string[]).includes(raw)) return raw as NamedIncomeFrequency;
  if (/^every-\d+-(days?|weeks?|months?)$/.test(raw)) return raw;
  if (weekdaySetFor(raw)) return raw;
  return "monthly";
}

/** Does this cadence generate more than one occurrence? */
export function isRecurringIncome(frequency: string | null | undefined): boolean {
  return normalizeIncomeFrequency(frequency) !== "once";
}

// ─── Occurrences ─────────────────────────────────────────────────────────────

/**
 * Lifecycle of ONE pay date.
 *   expected   — future money, counts toward projected cash flow only
 *   due_today  — expected today, still projected
 *   overdue    — the expected date passed with nothing received
 *   received   — real money; counts toward ACTUAL cash flow
 *   skipped    — user cancelled this one; counts toward neither
 */
export type IncomeOccurrenceStatus = "expected" | "due_today" | "overdue" | "received" | "skipped";

export const INCOME_STATUS_META: Record<IncomeOccurrenceStatus, { label: string; tone: "green" | "amber" | "red" | "muted" }> = {
  received: { label: "Received", tone: "green" },
  due_today: { label: "Expected today", tone: "amber" },
  overdue: { label: "Not received", tone: "red" },
  expected: { label: "Expected", tone: "muted" },
  skipped: { label: "Skipped", tone: "muted" },
};

/** Status of one pay date from its effective date and whether money landed. */
export function incomeOccurrenceStatus(
  effectiveDate: string | null | undefined,
  todayISO: string,
  received = false,
): IncomeOccurrenceStatus {
  if (received) return "received";
  if (!effectiveDate) return "expected";
  const d = String(effectiveDate).slice(0, 10);
  if (d < todayISO) return "overdue";
  if (d === todayISO) return "due_today";
  return "expected";
}

export interface IncomeOccurrence {
  /** Canonical series date (the unshifted expected date) — the override key. */
  date: string;
  /** Date after any per-occurrence reschedule (`movedTo`); equals `date` otherwise. */
  effectiveDate: string;
  /** What this occurrence is expected to be worth (base amount, or an override). */
  amount: number;
  /** What actually landed, when it has. Undefined while still projected. */
  receivedAmount?: number;
  /** The date money actually arrived (may differ from effectiveDate). */
  receivedDate?: string;
  status: IncomeOccurrenceStatus;
  notes?: string;
  /** Stable synthetic id: `<incomeId>:<date>` — no occurrence table needed. */
  occurrenceId: string;
  /** income_receipts row id once this occurrence has been received. */
  receiptId?: string;
  /** True when a per-occurrence exception applies (received/skipped/moved/amount/notes). */
  overridden: boolean;
}

export interface Incomeish {
  id: string;
  /** Base per-occurrence amount. */
  amount?: number | null;
  frequency?: string | null;
  /** One-time date, or the series anchor when startDate is absent. */
  date?: string | null;
  startDate?: string | null;
  start_date?: string | null;
  recurrenceEnd?: string | null;
  recurrence_end?: string | null;
  fields?: Record<string, any> | null;
}

export interface Receiptish {
  id?: string;
  /** Canonical occurrence date this receipt settles (preferred link). */
  occurrenceDate?: string | null;
  occurrence_date?: string | null;
  /** Date the money actually arrived. */
  receivedDate?: string | null;
  received_date?: string | null;
  amount?: number | null;
}

export interface IncomeScheduleOptions {
  /** Caller's tz-local today, YYYY-MM-DD. Drives expected/overdue/received. */
  todayISO: string;
  /** Inclusive window start (YYYY-MM-DD). Default: today. */
  windowStart?: string;
  /** Inclusive window end (YYYY-MM-DD). Default: today + `months`. */
  windowEnd?: string;
  /** Window length in months when windowEnd is omitted. Default 12. */
  months?: number;
  /** Hard safety cap on generated occurrences. Default 500. */
  cap?: number;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}/;
const clip = (d: any): string => String(d ?? "").slice(0, 10);
const isISO = (d: any): boolean => ISO_RE.test(clip(d));

/** The series anchor: the first pay date the whole schedule is generated from. */
export function incomeAnchorDate(income: Incomeish): string | null {
  const f = income.fields || {};
  const a = clip(
    income.startDate ?? income.start_date ?? f.startDate ?? f.firstPaymentDate ??
    income.date ?? f.nextDate ?? f.date,
  );
  return isISO(a) ? a : null;
}

/** Hard end of the series, if any. */
export function incomeSeriesEnd(income: Incomeish): string | null {
  const f = income.fields || {};
  const e = clip(income.recurrenceEnd ?? income.recurrence_end ?? f.recurrenceEnd ?? f.endDate);
  return isISO(e) ? e : null;
}

/** Base per-occurrence amount before any per-occurrence override. */
export function incomeBaseAmount(income: Incomeish): number {
  const f = income.fields || {};
  return Number(income.amount ?? f.amount ?? 0) || 0;
}

export function incomeFrequencyOf(income: Incomeish): IncomeFrequency {
  const f = income.fields || {};
  return normalizeIncomeFrequency(income.frequency ?? f.frequency);
}

/**
 * The two days-of-month a semimonthly series pays on. Defaults to the anchor
 * day and the day ~15 apart from it, so "twice a month starting the 1st" pays
 * the 1st and the 15th without the user configuring anything.
 */
export function semimonthlyDays(income: Incomeish, anchorISO: string): [number, number] {
  const f = income.fields || {};
  const anchorDay = parseISODate(anchorISO)?.getDate() ?? 1;
  const explicit = parseInt(String(f.secondDay ?? f.secondPayDay ?? ""), 10);
  const second = explicit >= 1 && explicit <= 31
    ? explicit
    : (anchorDay <= 15 ? Math.min(31, anchorDay + 15) : Math.max(1, anchorDay - 15));
  return anchorDay <= second ? [anchorDay, second] : [second, anchorDay];
}

/**
 * Every canonical pay date for a series between `from` and `to`, inclusive.
 *
 * Month-based cadences index off the anchor (`addMonthsISO(anchor, i * n)`) so
 * they are drift-free by construction: a series anchored on the 31st clamps to
 * Feb 28 and returns to the 31st in March rather than sliding to the 28th
 * forever. Day/week cadences step by a fixed number of days from the anchor.
 */
export function incomeOccurrenceDates(
  income: Incomeish,
  from: string,
  to: string,
  cap = 500,
): string[] {
  const anchor = incomeAnchorDate(income);
  if (!anchor) return [];
  const freq = incomeFrequencyOf(income);
  const seriesEnd = incomeSeriesEnd(income);
  const f = income.fields || {};
  const maxCount = f.count != null ? Math.max(1, parseInt(String(f.count), 10) || 0) : null;

  const hardEnd = seriesEnd && seriesEnd < to ? seriesEnd : to;
  const out: string[] = [];
  const push = (d: string): boolean => {
    if (d > hardEnd) return false;
    if (d >= from) out.push(d);
    return out.length < cap;
  };

  if (freq === "once") {
    if (anchor >= from && anchor <= hardEnd) out.push(anchor);
    return out;
  }

  // ── Day-of-week sets (weekdays / weekends / weekly:1,3,5) ──
  const daySet = weekdaySetFor(freq);
  if (daySet && daySet.size > 0) {
    let cur = anchor;
    const start = parseISODate(anchor);
    if (!start) return out;
    // Walk day by day from the anchor; bounded by the window and the cap.
    let guard = 0;
    const maxIter = Math.max(cap * 8, 4000);
    while (guard++ < maxIter && cur <= hardEnd) {
      const d = parseISODate(cur);
      if (d && daySet.has(d.getDay())) {
        if (maxCount != null && out.length >= maxCount) break;
        if (!push(cur)) break;
      }
      cur = addDaysISO(cur, 1);
    }
    return out;
  }

  // ── Semimonthly: two fixed days each month ──
  if (freq === "semimonthly") {
    const [d1, d2] = semimonthlyDays(income, anchor);
    const startD = parseISODate(anchor);
    if (!startD) return out;
    let year = startD.getFullYear();
    let month = startD.getMonth();
    let emitted = 0;
    let guard = 0;
    while (guard++ < 1200) {
      const dim = daysInMonth(year, month);
      for (const day of [d1, d2]) {
        const iso = toISODate(new Date(year, month, Math.min(day, dim)));
        if (iso < anchor) continue;
        if (iso > hardEnd) return out;
        if (maxCount != null && emitted >= maxCount) return out;
        emitted++;
        if (!push(iso)) return out;
      }
      month++;
      if (month > 11) { month = 0; year++; }
      if (toISODate(new Date(year, month, 1)) > hardEnd) break;
    }
    return out;
  }

  // ── Fixed-step cadences ──
  const stepDays = fixedDayStep(freq);
  if (stepDays > 0) {
    for (let i = 0; ; i++) {
      if (maxCount != null && i >= maxCount) break;
      const d = addDaysISO(anchor, i * stepDays);
      if (d > hardEnd) break;
      if (!push(d)) break;
      if (i > cap * 12) break;
    }
    return out;
  }

  // ── Month-based cadences, indexed off the anchor (drift-free) ──
  const stepMonths = fixedMonthStep(freq);
  const anchorDay = parseISODate(anchor)?.getDate();
  for (let i = 0; ; i++) {
    if (maxCount != null && i >= maxCount) break;
    const d = addMonthsISO(anchor, i * stepMonths, anchorDay);
    if (d > hardEnd) break;
    if (!push(d)) break;
    if (i > cap * 12) break;
  }
  return out;
}

function fixedDayStep(freq: IncomeFrequency): number {
  switch (freq) {
    case "daily": return 1;
    case "weekly": return 7;
    case "biweekly": return 14;
    default: break;
  }
  const nd = freq.match(/^every-(\d+)-days?$/);
  if (nd) return Math.max(1, +nd[1]);
  const nw = freq.match(/^every-(\d+)-weeks?$/);
  if (nw) return Math.max(1, +nw[1]) * 7;
  return 0;
}

function fixedMonthStep(freq: IncomeFrequency): number {
  switch (freq) {
    case "monthly": return 1;
    case "bimonthly": return 2;
    case "quarterly": return 3;
    case "semiannual": return 6;
    case "yearly": return 12;
    default: break;
  }
  const nm = freq.match(/^every-(\d+)-months?$/);
  if (nm) return Math.max(1, +nm[1]);
  return 1;
}

/**
 * Generate the pay occurrences for an income series within a window, applying
 * per-occurrence overrides, receipt history, and pause state. Pure.
 */
export function generateIncomeSchedule(
  income: Incomeish,
  receipts: Receiptish[] = [],
  opts: IncomeScheduleOptions,
): IncomeOccurrence[] {
  const f = income.fields || {};
  const anchor = incomeAnchorDate(income);
  if (!anchor) return [];

  const today = opts.todayISO;
  const windowStart = opts.windowStart ?? today;
  const windowEnd = opts.windowEnd ?? addMonthsISO(today, opts.months ?? 12);
  const cap = opts.cap ?? 500;

  const overrides: Record<string, any> =
    (f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {};
  const baseAmount = incomeBaseAmount(income);

  // Receipts are the source of truth for "received". Key by the canonical
  // occurrence date when the receipt records one, else by the date money landed.
  const receiptByDate = new Map<string, Receiptish>();
  for (const r of receipts) {
    const key = clip(r.occurrenceDate ?? r.occurrence_date ?? r.receivedDate ?? r.received_date);
    if (isISO(key)) receiptByDate.set(key, r);
    const landed = clip(r.receivedDate ?? r.received_date);
    if (isISO(landed) && !receiptByDate.has(landed)) receiptByDate.set(landed, r);
  }

  const paused = f.paused === true;
  const pausedUntil = isISO(f.pausedUntil) ? clip(f.pausedUntil) : null;
  const inPausedSpan = (dISO: string) =>
    paused && dISO >= today && (!pausedUntil || dISO < pausedUntil);

  // Extend the walk backward to the earliest overridden or receipted date so a
  // received or skipped past occurrence stays visible even when the window
  // starts later — mirrors the liability schedule's behaviour.
  let genFrom = windowStart;
  for (const d of Object.keys(overrides)) if (isISO(d) && d < genFrom) genFrom = d;
  for (const d of receiptByDate.keys()) if (d < genFrom) genFrom = d;

  const dates = incomeOccurrenceDates(income, genFrom, windowEnd, cap * 2);

  const out: IncomeOccurrence[] = [];
  for (const date of dates) {
    const ov = overrides[date] || null;
    const effectiveDate = ov && isISO(ov.movedTo) ? clip(ov.movedTo) : date;
    // Include when EITHER the canonical or the shifted date lands in-window.
    const inWindow = (date >= windowStart && date <= windowEnd) ||
      (effectiveDate >= windowStart && effectiveDate <= windowEnd);
    if (!inWindow) continue;
    if (inPausedSpan(effectiveDate)) continue;

    const receipt = receiptByDate.get(date) ?? receiptByDate.get(effectiveDate);
    const isSkipped = ov?.status === "skipped";
    const isReceived = !isSkipped && (ov?.status === "received" || receipt != null);
    const status: IncomeOccurrenceStatus = isSkipped
      ? "skipped"
      : incomeOccurrenceStatus(effectiveDate, today, isReceived);

    const receivedAmount = isReceived
      ? Number(receipt?.amount ?? ov?.receivedAmount ?? ov?.amount ?? baseAmount) || 0
      : undefined;

    out.push({
      date,
      effectiveDate,
      amount: ov && ov.amount != null ? Number(ov.amount) || 0 : baseAmount,
      receivedAmount,
      receivedDate: isReceived
        ? (clip(receipt?.receivedDate ?? receipt?.received_date ?? ov?.receivedDate) || effectiveDate)
        : undefined,
      status,
      notes: ov?.notes || undefined,
      occurrenceId: `${income.id}:${date}`,
      receiptId: receipt?.id ?? ov?.receiptId ?? undefined,
      overridden: !!ov,
    });
    if (out.length >= cap) break;
  }

  return out;
}

/** The next un-received, un-skipped occurrence on/after today. */
export function nextExpectedOccurrence(
  income: Incomeish,
  receipts: Receiptish[],
  todayISO: string,
): IncomeOccurrence | null {
  const sched = generateIncomeSchedule(income, receipts, {
    todayISO, windowStart: todayISO, months: 18,
  });
  for (const o of sched) {
    if (o.status !== "received" && o.status !== "skipped") return o;
  }
  return null;
}

/** The most recent occurrence that actually landed, on/before today. */
export function lastReceivedOccurrence(
  income: Incomeish,
  receipts: Receiptish[],
  todayISO: string,
): IncomeOccurrence | null {
  const sched = generateIncomeSchedule(income, receipts, {
    todayISO, windowStart: addMonthsISO(todayISO, -24), windowEnd: todayISO,
  });
  for (let i = sched.length - 1; i >= 0; i--) {
    if (sched[i].status === "received") return sched[i];
  }
  return null;
}

// ─── Totals ──────────────────────────────────────────────────────────────────

export interface IncomeWindowTotals {
  /** Every non-skipped occurrence at its expected amount — money on the plan. */
  projected: number;
  /** Only occurrences that actually landed, at the amount that landed. */
  received: number;
  /** Projected money that has not arrived yet (expected + due today). */
  outstanding: number;
  /** Expected money whose date has passed with nothing received. */
  overdue: number;
  occurrenceCount: number;
  receivedCount: number;
}

const EMPTY_TOTALS: IncomeWindowTotals = {
  projected: 0, received: 0, outstanding: 0, overdue: 0,
  occurrenceCount: 0, receivedCount: 0,
};

/**
 * Roll a set of occurrences into the projected/received split.
 *
 * PROJECTED is what the month is planned to bring in — it includes money that
 * has already arrived plus money still expected. RECEIVED is only what landed.
 * Keeping them apart is what stops an unpaid future paycheck from inflating the
 * user's actual position.
 */
export function totalIncomeOccurrences(occurrences: readonly IncomeOccurrence[]): IncomeWindowTotals {
  const t = { ...EMPTY_TOTALS };
  for (const o of occurrences) {
    if (o.status === "skipped") continue;
    t.occurrenceCount++;
    if (o.status === "received") {
      const got = o.receivedAmount ?? o.amount;
      t.projected += o.amount;
      t.received += got;
      t.receivedCount++;
    } else {
      t.projected += o.amount;
      t.outstanding += o.amount;
      if (o.status === "overdue") t.overdue += o.amount;
    }
  }
  return roundTotals(t);
}

/** Totals for one income series over a window. */
export function incomeWindowTotals(
  income: Incomeish,
  receipts: Receiptish[],
  windowStart: string,
  windowEnd: string,
  todayISO: string,
): IncomeWindowTotals {
  return totalIncomeOccurrences(
    generateIncomeSchedule(income, receipts, { todayISO, windowStart, windowEnd }),
  );
}

/** Totals across many series, e.g. every income row for one month. */
export function totalIncomeForWindow(
  incomes: readonly Incomeish[],
  receiptsByIncome: (incomeId: string) => Receiptish[],
  windowStart: string,
  windowEnd: string,
  todayISO: string,
): IncomeWindowTotals {
  const t = { ...EMPTY_TOTALS };
  for (const inc of incomes) {
    const one = incomeWindowTotals(inc, receiptsByIncome(inc.id) || [], windowStart, windowEnd, todayISO);
    t.projected += one.projected;
    t.received += one.received;
    t.outstanding += one.outstanding;
    t.overdue += one.overdue;
    t.occurrenceCount += one.occurrenceCount;
    t.receivedCount += one.receivedCount;
  }
  return roundTotals(t);
}

function roundTotals(t: IncomeWindowTotals): IncomeWindowTotals {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    ...t,
    projected: r(t.projected),
    received: r(t.received),
    outstanding: r(t.outstanding),
    overdue: r(t.overdue),
  };
}

// ─── Series edits ────────────────────────────────────────────────────────────

/**
 * Which slice of a series an edit or delete applies to.
 *   occurrence — just this one pay date
 *   future     — this one and everything after it
 *   series     — the whole thing, past included
 */
export type IncomeEditScope = "occurrence" | "future" | "series";

export function normalizeEditScope(scope: string | null | undefined): IncomeEditScope {
  const s = String(scope ?? "").toLowerCase().trim();
  if (s === "future" || s === "this_and_future" || s === "following" || s === "forward") return "future";
  if (s === "all" || s === "series" || s === "entire" || s === "everything") return "series";
  return "occurrence";
}

/** Human summary of a series' cadence, e.g. "Every 2 weeks on Friday". */
export function describeIncomeSchedule(income: Incomeish): string {
  const freq = incomeFrequencyOf(income);
  const anchor = incomeAnchorDate(income);
  const named = INCOME_FREQUENCY_LABELS[freq as NamedIncomeFrequency];
  let base = named ?? freq.replace(/-/g, " ");
  if (!named) {
    const set = weekdaySetFor(freq);
    if (set) {
      const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      base = `Weekly on ${[...set].sort().map((d) => DOW[d]).join(", ")}`;
    }
  }
  if (!anchor) return base;
  const d = parseISODate(anchor);
  if (!d) return base;
  const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (freq === "weekly" || freq === "biweekly") return `${base} on ${DOW_FULL[d.getDay()]}`;
  if (freq === "semimonthly") {
    const [a, b] = semimonthlyDays(income, anchor);
    return `${base} — day ${a} and day ${b}`;
  }
  if (freq === "monthly" || freq === "bimonthly" || freq === "quarterly" || freq === "semiannual") {
    return `${base} on day ${d.getDate()}`;
  }
  if (freq === "once") return `One-time on ${anchor}`;
  return base;
}
