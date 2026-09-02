/**
 * Centralised date-hygiene helpers.
 *
 * The product has multiple places (profile detail "Schedule & Activity",
 * dashboard upcoming widgets, calendar, tasks, obligations) that need to
 * answer the same question: "is this date in the past?". Until now each
 * surface rolled its own comparison and several missed the cut, which is
 * how a doctor's appointment dated May 24 kept showing as upcoming on
 * June 10. This module is the single source of truth.
 *
 * All comparisons are anchored to the user's local midnight ("startOfToday").
 * Anything strictly before that boundary is past; anything on/after it is
 * upcoming. For string inputs we accept ISO timestamps ("2026-05-24" or
 * "2026-05-24T16:00:00Z") and normalise to local midnight when only a date
 * portion is given, so timezone shifts don't accidentally flip a same-day
 * item.
 */

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Parse a date input. Returns null if unparseable. Date-only strings
 * ("YYYY-MM-DD") are pinned to local noon to avoid UTC→local rollback.
 */
export function parseDate(input: unknown): Date | null {
  if (!input) return null;
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  // Date-only — pin to local noon so toLocaleDateString() shows the right day
  // regardless of timezone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, day] = s.split("-").map(Number);
    return new Date(y, m - 1, day, 12, 0, 0, 0);
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** True if the input parses to a moment strictly before today's local midnight. */
export function isPast(input: unknown): boolean {
  const d = parseDate(input);
  if (!d) return false;
  return d.getTime() < startOfToday().getTime();
}

/** True if the input is today or any future day. */
export function isUpcoming(input: unknown): boolean {
  const d = parseDate(input);
  if (!d) return false;
  return d.getTime() >= startOfToday().getTime();
}

/** True if the input falls on today's local date. */
export function isToday(input: unknown): boolean {
  const d = parseDate(input);
  if (!d) return false;
  const today = startOfToday();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
}

/**
 * Whole days between the input and today, positive = future, negative = past.
 * Returns null if unparseable.
 */
export function daysFromToday(input: unknown): number | null {
  const d = parseDate(input);
  if (!d) return null;
  const today = startOfToday();
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/**
 * The one renderer for a stored due/target date.
 *
 * Two defects it closes, both from the QA report of 2026-07-29:
 *
 *   CRUD-T1-001 — a task due TODAY showed yesterday's date in the list while
 *   the calendar showed the right day. Formatting a stored date has to start
 *   from the calendar date the row actually carries, not from a `Date` built by
 *   an engine that may read the string as UTC. So: take the YYYY-MM-DD prefix
 *   and format THOSE numbers. There is no instant in the middle to shift.
 *
 *   EDGE-004 — a task due 12/31/2126 rendered as "Dec 31", indistinguishable
 *   from this year. The year is always shown when it isn't the current one.
 *
 * Accepts a bare date, an ISO timestamp, or a Date. Returns "" for junk.
 */
export function formatStoredDate(input: unknown): string {
  const raw = input instanceof Date
    ? `${input.getFullYear()}-${String(input.getMonth() + 1).padStart(2, "0")}-${String(input.getDate()).padStart(2, "0")}`
    : String(input ?? "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return "";
  const [, y, mo, d] = m;
  const year = Number(y);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = MONTHS[Number(mo) - 1];
  if (!month) return "";
  const day = Number(d);
  return year === new Date().getFullYear() ? `${month} ${day}` : `${month} ${day}, ${year}`;
}

/**
 * Render a stored date with `toLocaleDateString` options, WITHOUT the UTC
 * rollback. `new Date("2026-09-02").toLocaleDateString()` shows "9/1/2026" for
 * every negative-offset user because a bare date parses as UTC midnight; this
 * routes through parseDate (local noon for date-only strings, normal parsing
 * for timestamps) so the day the row carries is the day that renders.
 * Returns "" when the input is unparseable.
 */
export function formatLocalDate(
  input: unknown,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const d = parseDate(input);
  if (!d) return "";
  return d.toLocaleDateString(locale, options);
}

/**
 * How far out a date may plausibly be before a form should say something.
 * A due date a century away is a typo far more often than a plan (EDGE-004
 * entered 12/31/2126 and it saved without a murmur).
 */
export const PLAUSIBLE_YEARS_AHEAD = 10;

/** A human warning when a date is implausibly far out, else "". */
export function farFutureWarning(input: unknown): string {
  const raw = String(input ?? "").slice(0, 10);
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(raw);
  if (!m) return "";
  const yearsOut = Number(m[1]) - new Date().getFullYear();
  if (yearsOut <= PLAUSIBLE_YEARS_AHEAD) return "";
  return `That's ${yearsOut} years from now — check the year.`;
}

/** Compact label: "Today", "Tomorrow", "in 4d", "3d ago", "May 24". */
export function relativeDayLabel(input: unknown): string {
  const diff = daysFromToday(input);
  if (diff === null) return "";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff <= 7) return `in ${diff}d`;
  if (diff < -1 && diff >= -7) return `${Math.abs(diff)}d ago`;
  const d = parseDate(input)!;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Today's calendar date in the BROWSER's zone, as YYYY-MM-DD.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, which for every
 * negative-offset user is TOMORROW from late afternoon onward — an expense
 * dialog opened at 8 pm in Los Angeles defaulted to tomorrow's date, a payment
 * recorded that evening posted a day late. Use this for form defaults.
 */
export function localTodayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** Today plus `n` calendar days, in the browser's zone, as YYYY-MM-DD. */
export function localDaysFromNowISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}
