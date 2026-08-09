// shared/habit-stats.ts — statistics over a habit's individual completions.
//
// Once a habit can be completed several times a day, "how am I doing?" stops
// being a yes/no question. A day can be 0/3, 2/3, 3/3 or 4/3, and each of
// those means something different:
//
//   - streaks only count days that REACHED the target (2/3 is not a streak day)
//   - but the partial day is still real data and must survive in the averages,
//     which is why nothing here throws away sub-target days.
//
// Pure and dependency-free (only date math from ./timezone) so the habits page,
// the profile detail view and the server's stats endpoint share one answer.

import { addDays } from "./timezone";
import { calculateStreak } from "./streak";
import { habitDailyTarget, isHabitDueOn, type HabitCompletionShape, type HabitScheduleShape } from "./habit-schedule";

export interface HabitStatsInput extends HabitScheduleShape {
  checkins?: HabitCompletionShape[] | null;
}

export interface HabitStats {
  target: number;
  /** Days examined (the window, restricted to days the habit is scheduled). */
  daysConsidered: number;
  /** Total completions in the window. */
  totalCompletions: number;
  /** totalCompletions / daysConsidered, rounded to 2dp. */
  averagePerDay: number;
  /** Days that reached the target. */
  daysGoalReached: number;
  /** Days that went past the target. */
  daysGoalExceeded: number;
  /** daysGoalReached / daysConsidered as a 0-100 percentage. */
  goalCompletionRate: number;
  /** Days with at least one completion but short of the target. */
  daysPartial: number;
  currentStreak: number;
  longestStreak: number;
  /** Completions in the trailing 7 days of the window. */
  completionsThisWeek: number;
  /** Completions in the trailing 30 days of the window. */
  completionsThisMonth: number;
  /** "HH:MM" clock times of every completion in the window, ascending. */
  completionTimes: string[];
  /** Per-day counts, oldest first — feeds sparklines and heatmaps. */
  byDate: Array<{ date: string; count: number; target: number; reached: boolean }>;
}

/** "2026-08-09T14:05:00Z" → "14:05" in the viewer's local clock. */
function clockTime(timestamp: unknown): string | null {
  const raw = String(timestamp ?? "");
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface HabitStatsOptions {
  /** "Today" as YYYY-MM-DD in the user's timezone. */
  today: string;
  /** How many days back to look, inclusive of today. Default 30. */
  days?: number;
  /**
   * Count only days the habit is actually scheduled on (a weekly habit isn't
   * failing on the six days it was never due). Default true.
   */
  scheduledDaysOnly?: boolean;
}

export function computeHabitStats(habit: HabitStatsInput, opts: HabitStatsOptions): HabitStats {
  const target = habitDailyTarget(habit);
  const days = Math.max(1, Math.floor(opts.days ?? 30));
  const scheduledOnly = opts.scheduledDaysOnly !== false;

  // Bucket every completion by its day. Days with no completion have no
  // bucket — the window walk below supplies the zeros.
  const countByDate = new Map<string, number>();
  const timesByDate = new Map<string, string[]>();
  for (const c of habit.checkins || []) {
    const d = String(c?.date || "").slice(0, 10);
    if (!d) continue;
    countByDate.set(d, (countByDate.get(d) || 0) + 1);
    const t = clockTime(c?.timestamp);
    if (t) {
      const arr = timesByDate.get(d) || [];
      arr.push(t);
      timesByDate.set(d, arr);
    }
  }

  const byDate: HabitStats["byDate"] = [];
  const completionTimes: string[] = [];
  let totalCompletions = 0;
  let daysGoalReached = 0;
  let daysGoalExceeded = 0;
  let daysPartial = 0;
  let daysConsidered = 0;
  let completionsThisWeek = 0;
  let completionsThisMonth = 0;

  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(opts.today, -i);
    const count = countByDate.get(date) || 0;
    const scheduled = !scheduledOnly || isHabitDueOn(habit, date);
    // An unscheduled day with completions on it still counts its completions —
    // the user did the thing; it just doesn't get judged against the target.
    totalCompletions += count;
    if (i < 7) completionsThisWeek += count;
    if (i < 30) completionsThisMonth += count;
    for (const t of (timesByDate.get(date) || []).sort()) completionTimes.push(t);
    if (!scheduled) continue;
    daysConsidered++;
    if (count >= target) daysGoalReached++;
    if (count > target) daysGoalExceeded++;
    if (count > 0 && count < target) daysPartial++;
    byDate.push({ date, count, target, reached: count >= target });
  }

  // Streaks come from the canonical implementation, which already defines a
  // streak day as one that hit the target.
  const { current, longest } = calculateStreak(
    (habit.checkins || []).map((c) => String(c?.date || "").slice(0, 10)).filter(Boolean),
    { today: opts.today, targetPerDay: target },
  );

  return {
    target,
    daysConsidered,
    totalCompletions,
    averagePerDay: daysConsidered > 0 ? Math.round((totalCompletions / daysConsidered) * 100) / 100 : 0,
    daysGoalReached,
    daysGoalExceeded,
    goalCompletionRate: daysConsidered > 0 ? Math.round((daysGoalReached / daysConsidered) * 100) : 0,
    daysPartial,
    currentStreak: current,
    longestStreak: longest,
    completionsThisWeek,
    completionsThisMonth,
    completionTimes,
    byDate,
  };
}
