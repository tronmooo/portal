/**
 * shared/timezone.ts
 * Centralized timezone utility — single source of truth for all date/time ops.
 *
 * RULE: Every "today", "this month", or date-default in the codebase MUST
 * use these helpers with the user's timezone. NEVER use toISOString().slice(0,10)
 * for user-visible dates — that returns UTC, not the user's local date.
 */

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Returns YYYY-MM-DD for "today" in the given timezone.
 * This is the canonical "what day is it for the user?" function.
 */
export function getUserToday(timezone: string = DEFAULT_TIMEZONE): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Returns YYYY-MM for the current month in the given timezone.
 */
export function getUserCurrentMonth(timezone: string = DEFAULT_TIMEZONE): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone }).slice(0, 7);
}

/**
 * Formats a Date object to YYYY-MM-DD in the given timezone.
 */
export function toLocalDateStr(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Formats a Date object to HH:MM (24h) in the given timezone.
 */
export function toLocalTimeStr(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
}

/**
 * Parses a YYYY-MM-DD date string to a Date object using noon (T12:00:00).
 * Using noon avoids DST edge cases where midnight can shift to the wrong day.
 * Use this instead of new Date(dateStr) for calendar/event date parsing.
 */
export function parseLocalDate(dateStr: string): Date {
  return new Date(`${dateStr}T12:00:00`);
}

/**
 * Timezone-safe date arithmetic. Adds N days to a YYYY-MM-DD string.
 * Consolidates the two separate addDays implementations in supabase-storage.ts.
 */
export function addDays(dateStr: string, days: number): string {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + days);
  // Return using ISO slice — safe here because we're using noon UTC and only
  // computing the calendar date (not time), so there's no risk of day shift.
  return d.toISOString().slice(0, 10);
}

/**
 * Returns a formatted locale string for the system prompt / human-readable display.
 * e.g. "Tuesday, April 7, 2026 at 6:30 PM"
 */
export function formatDisplayDateTime(timezone: string = DEFAULT_TIMEZONE): string {
  return new Date().toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone,
  });
}

/**
 * Returns a short formatted date for display, e.g. "04/07/2026"
 */
export function formatDisplayDate(timezone: string = DEFAULT_TIMEZONE): string {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: timezone,
  });
}

/**
 * Returns the timezone label for display, e.g. "Pacific Time" or "Eastern Time"
 */
export function getTimezoneLabel(timezone: string = DEFAULT_TIMEZONE): string {
  const map: Record<string, string> = {
    'America/Los_Angeles': 'Pacific Time',
    'America/Denver': 'Mountain Time',
    'America/Chicago': 'Central Time',
    'America/New_York': 'Eastern Time',
    'America/Anchorage': 'Alaska Time',
    'Pacific/Honolulu': 'Hawaii Time',
    'Europe/London': 'GMT',
    'Europe/Paris': 'Central European Time',
    'Asia/Tokyo': 'Japan Time',
    'Australia/Sydney': 'Australia Eastern Time',
  };
  return map[timezone] || timezone.replace(/_/g, ' ');
}
