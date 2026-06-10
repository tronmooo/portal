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
