/**
 * Shared timezone utilities for consistent date handling across client and server.
 *
 * Core principle: All date operations must use the user's real timezone,
 * never hardcoded values or UTC-as-local.
 */

/** Fallback timezone when none is provided (preserves legacy behavior) */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Returns today's date as YYYY-MM-DD in the given timezone.
 */
export function getUserToday(timezone: string = DEFAULT_TIMEZONE): string {
  return toLocalDateStr(new Date(), timezone);
}

/**
 * Returns the current month as YYYY-MM in the given timezone.
 */
export function getUserCurrentMonth(timezone: string = DEFAULT_TIMEZONE): string {
  return getUserToday(timezone).slice(0, 7);
}

/**
 * Formats a Date object to YYYY-MM-DD in the specified timezone.
 * Uses Intl.DateTimeFormat for correct timezone conversion.
 */
export function toLocalDateStr(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Parses a YYYY-MM-DD string into a Date at noon local time.
 * Using noon avoids DST transitions that occur at midnight/early morning,
 * which could shift the date by +/- 1 day.
 */
export function parseLocalDate(dateStr: string): Date {
  return new Date(dateStr + 'T12:00:00');
}

/**
 * Adds (or subtracts) days from a YYYY-MM-DD date string.
 * Returns the result as YYYY-MM-DD. Uses noon parsing to avoid DST edge cases.
 */
export function addDays(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  // Use en-CA locale which outputs YYYY-MM-DD format
  return d.toLocaleDateString('en-CA');
}

/**
 * Formats a Date to a localized time string in the given timezone.
 * Returns format like "3:30 PM".
 */
export function toLocalTimeStr(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  });
}

/**
 * Formats a Date to a full localized date/time string for display.
 * Example: "Tuesday, April 8, 2025, 3:30 PM"
 */
export function toLocalDateTimeStr(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  });
}

/**
 * Formats a Date to MM/DD/YYYY in the given timezone.
 */
export function toLocalShortDateStr(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  });
}

/**
 * Gets the day of week (0=Sunday...6=Saturday) for a YYYY-MM-DD string.
 */
export function getDayOfWeek(dateStr: string): number {
  return parseLocalDate(dateStr).getDay();
}
