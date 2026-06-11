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
