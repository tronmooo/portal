// ── Relative time — ONE helper for "14h ago" / "in 3 weeks" / "today" ────────
//
// QA 2026-09-18 BUG-15: relative timestamps were wrong in three directions,
// each from a local helper rolling its own arithmetic over `new Date(x)`:
//
//   (a) a DATE-ONLY value ("2026-09-18") parsed as UTC midnight, so a row
//       created seconds ago read "14h ago" in New York;
//   (b) a FUTURE date fell through the "mins < 1 → just now" branch, so Mom's
//       Birthday next May read "0m" / "just now";
//   (c) the same UTC-midnight shift made Sep 1 → Sep 18 read "16d ago"
//       (it is 17), and two labels on one card ("Last: 2mo ago" beside
//       "Stale 47d") disagreed because each rounded its own way.
//
// The rules, so every surface agrees:
//   · A bare YYYY-MM-DD is a CALENDAR DAY in the viewer's zone, never an
//     instant. Its distance is whole calendar days from the local today.
//   · An instant (ISO with a time) is measured to the minute for the first
//     day, then in the same whole calendar days as a bare date.
//   · Past → "just now" / "Nm ago" / "Nh ago" / "yesterday" / "Nd ago" /
//     "Nmo ago" / "Ny ago". Future → "in Nm" / "in Nh" / "tomorrow" /
//     "in Nd" / "in N weeks" / "in Nmo". Today's bare date → "today".
//   · `elapsedDays` is the single number both "Last: X ago" and "Stale Nd"
//     read, so they cannot disagree.
//
// Pure, no I/O. Pinned by tests/qa-2026-09-18-dashboard-cluster.test.ts.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_DAY = 86_400_000;

export interface RelativeTimeOptions {
  /** The reference instant (defaults to now). */
  now?: Date | number;
  /** "short" → "3d ago" / "in 3w"; "long" (default) → "3 days ago" / "in 3 weeks". */
  style?: "short" | "long";
  /** Label for a bare date equal to today (default "today"). */
  todayLabel?: string;
}

/** Local calendar-day key of an instant. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole calendar days from `fromKey` to `toKey` (both YYYY-MM-DD, local). */
function calendarDaysBetween(fromKey: string, toKey: string): number {
  const a = new Date(`${fromKey}T12:00:00`).getTime();
  const b = new Date(`${toKey}T12:00:00`).getTime();
  return Math.round((b - a) / MS_DAY);
}

/**
 * Parse the value the way the app stores it: a bare date pins to LOCAL noon
 * (so it can never roll into the previous day), anything else is an instant.
 */
export function parseRelativeInput(input: unknown): { date: Date; dateOnly: boolean } | null {
  if (input == null || input === "") return null;
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? { date: input, dateOnly: false } : null;
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isFinite(d.getTime()) ? { date: d, dateOnly: false } : null;
  }
  const s = String(input).trim();
  if (DAY_RE.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return { date: new Date(y, m - 1, d, 12, 0, 0, 0), dateOnly: true };
  }
  // "2026-09-18T00:00:00.000Z" carrying midnight UTC is almost always a bare
  // date that went through JSON — treat it as the calendar day it names.
  const utcMidnight = /^(\d{4}-\d{2}-\d{2})T00:00(:00(\.0+)?)?(Z|\+00:00)$/.exec(s);
  if (utcMidnight) {
    const [y, m, d] = utcMidnight[1].split("-").map(Number);
    return { date: new Date(y, m - 1, d, 12, 0, 0, 0), dateOnly: true };
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? { date: d, dateOnly: false } : null;
}

/**
 * Whole calendar days between the value and today, in the viewer's zone.
 * Positive = past ("elapsed"), negative = future. Null when unparseable.
 * "Last: 2mo ago" and "Stale 47d" must both come from THIS number.
 */
export function elapsedDays(input: unknown, now: Date | number = Date.now()): number | null {
  const parsed = parseRelativeInput(input);
  if (!parsed) return null;
  const ref = now instanceof Date ? now : new Date(now);
  return calendarDaysBetween(dayKey(parsed.date), dayKey(ref));
}

/** True when the value falls on the viewer's local today. */
export function isSameLocalDay(input: unknown, now: Date | number = Date.now()): boolean {
  return elapsedDays(input, now) === 0;
}

function plural(n: number, unit: string, style: "short" | "long"): string {
  if (style === "short") {
    const abbr: Record<string, string> = { minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y" };
    return `${n}${abbr[unit] ?? unit}`;
  }
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * The one relative-time renderer.
 *
 *   relativeTime("2026-09-18", { now: Sep 18 })            → "today"
 *   relativeTime("2026-09-01", { now: Sep 18 })            → "17 days ago"
 *   relativeTime("2026-10-15", { now: Sep 18 })            → "in 4 weeks"
 *   relativeTime("2027-05-12", { now: Sep 18 2026 })       → "in 8 months"
 *   relativeTime("2026-09-18T14:03:00Z", { now: +40s })    → "just now"
 *   relativeTime(instant 3h old)                           → "3 hours ago"
 */
export function relativeTime(input: unknown, opts: RelativeTimeOptions = {}): string {
  const parsed = parseRelativeInput(input);
  if (!parsed) return "";
  const style = opts.style ?? "long";
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const days = calendarDaysBetween(dayKey(parsed.date), dayKey(now));
  const past = days > 0;
  const suffix = (s: string) => (past ? `${s} ago` : `in ${s}`);

  // Same calendar day.
  if (days === 0) {
    if (parsed.dateOnly) return opts.todayLabel ?? "today";
    const diffSec = (now.getTime() - parsed.date.getTime()) / 1000;
    if (Math.abs(diffSec) < 60) return "just now";
    const future = diffSec < 0;
    const abs = Math.floor(Math.abs(diffSec) / 60);
    if (abs < 60) return future ? `in ${plural(abs, "minute", style)}` : `${plural(abs, "minute", style)} ago`;
    const hrs = Math.round(abs / 60);
    return future ? `in ${plural(hrs, "hour", style)}` : `${plural(hrs, "hour", style)} ago`;
  }

  const abs = Math.abs(days);
  if (abs === 1) {
    if (past) return "yesterday";
    return "tomorrow";
  }
  if (abs < 7) return suffix(plural(abs, "day", style));
  if (abs < 30) {
    // Days for the near past (people count "17 days" for a document), weeks
    // for the near future ("in 4 weeks" reads better than "in 27 days").
    if (past) return suffix(plural(abs, "day", style));
    const weeks = Math.max(1, Math.round(abs / 7));
    return suffix(plural(weeks, "week", style));
  }
  // Months and years by CALENDAR arithmetic (no day-count multipliers —
  // see tests/smoke/contracts/no-literal-frequency-multipliers): Sep 18 →
  // May 12 next year is 8 months, whatever the day counts in between.
  const months = Math.max(1, calendarMonthsBetween(past ? parsed.date : now, past ? now : parsed.date));
  if (months < 12) return suffix(plural(months, "month", style));
  const years = Math.max(1, Math.round(months / 12));
  return suffix(plural(years, "year", style));
}

/** Whole calendar months from `from` to `to` (`to` after `from`), rounded to
 *  the nearest month by the day-of-month remainder. */
function calendarMonthsBetween(from: Date, to: Date): number {
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  const dayDelta = to.getDate() - from.getDate();
  if (dayDelta < -15) months -= 1;
  else if (dayDelta > 15) months += 1;
  return months;
}

/**
 * Compact spelling used by dense rows: "3d ago", "in 2w", "just now", "today".
 */
export function relativeTimeShort(input: unknown, now: Date | number = Date.now()): string {
  return relativeTime(input, { now, style: "short" });
}

/**
 * "Completed 3 hours ago" / "Completed today" — a verb in front of the
 * relative time, so a card mixing "Completed 21m ago" with "Completed: X ·
 * 1d ago" has one format to fall back on.
 */
export function withVerb(verb: string, input: unknown, opts: RelativeTimeOptions = {}): string {
  const rel = relativeTime(input, opts);
  return rel ? `${verb} ${rel}` : verb;
}
