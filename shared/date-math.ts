// shared/date-math.ts — Canonical calendar arithmetic.
//
// THE ONE RECURRENCE DATE GENERATOR. Every place that advances a date by
// months or years for a recurring series MUST use these helpers.
//
// Why this file exists (user QA report, 2026-07-25):
//   "Netflix says 'Monthly on day 31', but its next occurrence is August 1.
//    It should be August 31."
//
// Root cause: `Date.prototype.setMonth` OVERFLOWS. Constructing an invalid
// date such as "June 31" silently rolls into "July 1":
//
//   const d = new Date("2026-05-31T00:00:00");
//   d.setMonth(d.getMonth() + 1);   // → 2026-07-01, NOT 2026-06-30
//
// Worse, the damage is permanent: once a series has rolled from the 31st to
// the 1st, every subsequent step keeps the wrong day-of-month, so a "monthly
// on day 31" bill silently becomes a "monthly on day 1" bill. The same trap
// exists for `setFullYear` on Feb 29 (→ Mar 1 in a non-leap year).
//
// The fix is two rules, both implemented here:
//
//   1. CLAMP, never overflow. Day-of-month is clamped to the last day of the
//      target month: May 31 + 1 month = June 30.
//   2. ANCHOR, never drift. The n-th occurrence is computed from the SERIES
//      BASE DATE, not from the previous occurrence, so a clamped step does not
//      poison the ones after it:
//        May 31 → Jun 30 → Jul 31 → Aug 31 → Sep 30 → Oct 31
//      (Stepping from the previous result would give the wrong
//       May 31 → Jun 30 → Jul 30 → Aug 30.)
//
// Pure, dependency-free, no I/O — importable from both the server and the
// browser bundle. Pinned by tests/date-math.test.ts.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Day-of-week sets ────────────────────────────────────────────────────────
//
// `weekdays` (Mon–Fri) and `weekends` (Sat/Sun) were the only day-set
// recurrences, so "gym every Monday, Wednesday and Friday" had no
// representation and became three independent weekly events — three rows to
// edit, three to cancel. Both are special cases of one idea: repeat on a SET
// of weekdays. `weekly:1,3,5` (0 = Sunday) says it directly, and every
// consumer that hard-coded the two literals now asks this helper for the set,
// so the named patterns keep their exact behaviour and the general case comes
// along for free.

/** Matches the parametrized form, e.g. "weekly:1,3,5". */
export const WEEKDAY_SET_RE = /^weekly:([0-6](?:,[0-6])*)$/;

/**
 * The days-of-week a recurrence repeats on (0 = Sunday), or null when the
 * pattern is not a day-set pattern (daily, monthly, yearly, none, …).
 */
export function weekdaySetFor(recurrence: string | null | undefined): Set<number> | null {
  const r = String(recurrence || "").trim().toLowerCase();
  if (r === "weekdays") return new Set([1, 2, 3, 4, 5]);
  if (r === "weekends") return new Set([0, 6]);
  const m = r.match(WEEKDAY_SET_RE);
  if (!m) return null;
  const days = new Set(m[1].split(",").map(Number));
  return days.size > 0 ? days : null;
}

/** Build the canonical token from a set of weekday numbers. */
export function weekdaySetToRecurrence(days: readonly number[]): string {
  const uniqSorted = Array.from(new Set(days.filter(d => d >= 0 && d <= 6))).sort((a, b) => a - b);
  return uniqSorted.length > 0 ? `weekly:${uniqSorted.join(",")}` : "none";
}

/** Days in a given month. `month` is 0-indexed, matching Date#getMonth(). */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of month+1 is the last day of `month`. Date normalizes the year for
  // month === 12, so December works without a special case.
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Add `n` months to a Date, clamping the day-of-month to the target month's
 * last day instead of overflowing into the next month.
 *
 * `anchorDay` is the day-of-month the SERIES is anchored to — pass the base
 * date's day so a clamped step (Jun 30) doesn't drag later steps off the 31st.
 * Defaults to the input date's own day when omitted.
 *
 * Returns a NEW Date; the input is never mutated. Time-of-day is preserved.
 */
export function addMonthsClamped(date: Date, n: number, anchorDay?: number): Date {
  const out = new Date(date.getTime());
  const anchor = anchorDay ?? date.getDate();
  // Park on the 1st first: mutating the month while the day is 29–31 is what
  // triggers the overflow we're trying to prevent.
  out.setDate(1);
  out.setMonth(out.getMonth() + n);
  out.setDate(Math.min(anchor, daysInMonth(out.getFullYear(), out.getMonth())));
  return out;
}

/**
 * Add `n` years to a Date, clamping Feb 29 to Feb 28 in non-leap years rather
 * than overflowing to Mar 1. `anchorDay` behaves as in `addMonthsClamped` so a
 * Feb-29 series returns to the 29th on the next leap year.
 */
export function addYearsClamped(date: Date, n: number, anchorDay?: number): Date {
  return addMonthsClamped(date, n * 12, anchorDay);
}

// ─── ISO (YYYY-MM-DD) string helpers ─────────────────────────────────────────
// The app stores calendar dates as bare YYYY-MM-DD strings. These parse at
// local midnight and format back with `en-CA` (which is YYYY-MM-DD), matching
// the convention already used across shared/.

/** Parse YYYY-MM-DD at local midnight. Returns null for anything malformed. */
export function parseISODate(iso: string | null | undefined): Date | null {
  const s = String(iso ?? "").slice(0, 10);
  if (!ISO_DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date as YYYY-MM-DD in local time. */
export function toISODate(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

/** Add `n` days to a YYYY-MM-DD string. */
export function addDaysISO(iso: string, n: number): string {
  const d = parseISODate(iso);
  if (!d) return String(iso ?? "");
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/**
 * Add `n` months to a YYYY-MM-DD string with month-end clamping.
 *
 * `anchorDay` defaults to the input's own day-of-month. When walking a series,
 * pass the BASE date's day (or better, call this with `n = i` against the base
 * date) so the day-of-month never drifts:
 *
 *   addMonthsISO("2026-05-31", 1) === "2026-06-30"
 *   addMonthsISO("2026-05-31", 2) === "2026-07-31"
 *   addMonthsISO("2026-05-31", 3) === "2026-08-31"
 */
export function addMonthsISO(iso: string, n: number, anchorDay?: number): string {
  const d = parseISODate(iso);
  if (!d) return String(iso ?? "");
  return toISODate(addMonthsClamped(d, n, anchorDay));
}

/** Add `n` years to a YYYY-MM-DD string, clamping Feb 29 in non-leap years. */
export function addYearsISO(iso: string, n: number, anchorDay?: number): string {
  return addMonthsISO(iso, n * 12, anchorDay);
}

/**
 * Advance a YYYY-MM-DD date by one cycle of a named frequency.
 *
 * `anchorDay` MUST be supplied by callers that walk a series step-by-step
 * (pass the series base date's day-of-month) so monthly/quarterly/yearly steps
 * stay pinned to the intended day. Callers that can index from the base should
 * prefer `addMonthsISO(base, i)` instead — it is drift-free by construction.
 *
 * Returns the input unchanged for "none"/unknown frequencies so callers can
 * treat an unrecognized pattern as non-recurring.
 */
export function advanceISO(
  iso: string,
  frequency: string | null | undefined,
  anchorDay?: number,
): string {
  const freq = String(frequency ?? "").toLowerCase();
  const d = parseISODate(iso);
  if (!d) return String(iso ?? "");
  // Day-of-week sets (weekdays, weekends, weekly:<days>) advance to the next
  // date whose weekday is in the set.
  const daySet = weekdaySetFor(freq);
  if (daySet) {
    do { d.setDate(d.getDate() + 1); } while (!daySet.has(d.getDay()));
    return toISODate(d);
  }
  switch (freq) {
    case "daily": return addDaysISO(iso, 1);
    case "weekly": return addDaysISO(iso, 7);
    case "biweekly": case "bi-weekly": case "every-2-weeks": return addDaysISO(iso, 14);
    // weekdays / weekends / weekly:<days> — see the day-set branch above.
    case "semimonthly": case "semi-monthly": return addDaysISO(iso, 15);
    case "monthly": return addMonthsISO(iso, 1, anchorDay);
    case "bimonthly": case "bi-monthly": return addMonthsISO(iso, 2, anchorDay);
    case "quarterly": return addMonthsISO(iso, 3, anchorDay);
    case "semiannual": case "semi-annual": case "semiannually": case "biannual":
      return addMonthsISO(iso, 6, anchorDay);
    case "yearly": case "annual": case "annually": return addYearsISO(iso, 1, anchorDay);
    default: return String(iso ?? "").slice(0, 10);
  }
}

/** How many months one cycle of `frequency` spans, or 0 if it isn't month-based. */
export function monthsPerCycle(frequency: string | null | undefined): number {
  switch (String(frequency ?? "").toLowerCase()) {
    case "monthly": return 1;
    case "bimonthly": case "bi-monthly": return 2;
    case "quarterly": return 3;
    case "semiannual": case "semi-annual": case "semiannually": case "biannual": return 6;
    case "yearly": case "annual": case "annually": return 12;
    default: return 0;
  }
}
