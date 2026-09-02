/**
 * shared/streak.ts
 * Single source of truth for habit/tracker streak math.
 *
 * Ported 1:1 from the canonical server implementation
 * (server/storage.ts calculateStreak) so client and server agree.
 * The server can be swapped to import this module without behavior change:
 * it computes `today` via getUserToday(timezone) and passes it here.
 *
 * Semantics (do not redesign):
 * - A day is "complete" when its check-in count >= targetPerDay.
 * - `current` counts back from the most recent complete day, but only if
 *   that day is today or yesterday (one-day grace for "current").
 * - `longest` is the longest run of consecutive complete days overall.
 */

import { addDays } from "./timezone";

export interface StreakResult {
  current: number;
  longest: number;
}

export interface StreakOptions {
  /** "Today" as YYYY-MM-DD in the user's timezone (e.g. getUserToday(tz)). */
  today: string;
  /** Check-ins required for a day to count as complete. Default 1. */
  targetPerDay?: number;
  /**
   * Pre-aggregated check-in counts keyed by YYYY-MM-DD. When provided it is
   * used instead of counting occurrences in `checkinDates`.
   */
  countsByDate?: Record<string, number>;
  /**
   * Which calendar days the habit is scheduled on (shared/habit-schedule's
   * isHabitDueOn). When given, only scheduled days count and unscheduled
   * days neither count nor break the run: a Mon/Wed/Fri habit checked every
   * Mon/Wed/Fri is a streak of scheduled days, not a streak of 1 that
   * Tuesday reset. Absent = every day is scheduled (daily).
   */
  isScheduled?: (dateISO: string) => boolean;
}

/** The nearest scheduled day at or before `from`, stepping back at most `limit` days. */
function scheduledAtOrBefore(from: string, isScheduled: (d: string) => boolean, limit = 400): string | null {
  let d = from;
  for (let i = 0; i <= limit; i++) {
    if (isScheduled(d)) return d;
    d = addDays(d, -1);
  }
  return null;
}

export function calculateStreak(checkinDates: string[], opts: StreakOptions): StreakResult {
  const targetPerDay = opts.targetPerDay ?? 1;

  // Count check-ins per date
  const countByDate = new Map<string, number>();
  if (opts.countsByDate) {
    for (const [date, count] of Object.entries(opts.countsByDate)) {
      countByDate.set(date, count);
    }
  } else {
    for (const date of checkinDates) {
      countByDate.set(date, (countByDate.get(date) || 0) + 1);
    }
  }
  if (countByDate.size === 0) return { current: 0, longest: 0 };

  // A day is "complete" if check-in count >= targetPerDay
  const completeDates = [...countByDate.entries()]
    .filter(([, count]) => count >= targetPerDay)
    .map(([date]) => date)
    .sort()
    .reverse();
  if (completeDates.length === 0) return { current: 0, longest: 0 };

  const todayStr = opts.today;

  if (opts.isScheduled) {
    const isScheduled = opts.isScheduled;
    const complete = new Set(completeDates.filter(isScheduled));
    if (complete.size === 0) return { current: 0, longest: 0 };
    // The step back from one scheduled day to the previous scheduled day.
    const prevScheduled = (d: string) => scheduledAtOrBefore(addDays(d, -1), isScheduled);
    // Current: today (if scheduled) may still be open, so the run may start
    // at today or at the most recent scheduled day before it.
    let current = 0;
    const anchorToday = scheduledAtOrBefore(todayStr, isScheduled);
    if (anchorToday) {
      let d: string | null = complete.has(anchorToday) ? anchorToday : (anchorToday === todayStr ? prevScheduled(anchorToday) : null);
      while (d && complete.has(d)) { current++; d = prevScheduled(d); }
    }
    // Longest: walk each run of consecutive scheduled complete days.
    let longest = 0;
    const sorted = [...complete].sort();
    const seen = new Set<string>();
    for (const start of sorted) {
      if (seen.has(start)) continue;
      let run = 0;
      let d: string | null = start;
      while (d && complete.has(d)) { seen.add(d); run++; d = scheduledAtOrAfter(addDays(d, 1), isScheduled); }
      longest = Math.max(longest, run);
    }
    return { current, longest: Math.max(longest, current) };
  }

  const yesterdayStr = addDays(todayStr, -1);

  let current = 0;

  // Check if the most recent complete day is today or yesterday (allow 1-day gap for "current")
  if (completeDates[0] === todayStr || completeDates[0] === yesterdayStr) {
    let expectedDate = completeDates[0];
    for (let i = 0; i < completeDates.length; i++) {
      if (completeDates[i] === expectedDate) {
        current++;
        expectedDate = addDays(expectedDate, -1);
      } else if (completeDates[i] < expectedDate) {
        break;
      }
    }
  }

  // Calculate longest streak from all complete dates
  const allDates = [...completeDates].sort();
  let tempStreak = 1;
  let longest = 1;
  for (let i = 1; i < allDates.length; i++) {
    if (allDates[i] === addDays(allDates[i - 1], 1)) {
      tempStreak++;
      longest = Math.max(longest, tempStreak);
    } else {
      tempStreak = 1;
    }
  }

  return { current: Math.max(current, 0), longest: Math.max(longest, current) };
}

/** The nearest scheduled day at or after `from`, stepping forward at most `limit` days. */
function scheduledAtOrAfter(from: string, isScheduled: (d: string) => boolean, limit = 400): string | null {
  let d = from;
  for (let i = 0; i <= limit; i++) {
    if (isScheduled(d)) return d;
    d = addDays(d, 1);
  }
  return null;
}
