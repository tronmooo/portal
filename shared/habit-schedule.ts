// shared/habit-schedule.ts — is this habit due on this day, and is it done?
//
// These two rules were scattered and disagreed with each other:
//
//  - The frequency→day rule lived in EXACTLY ONE place, the in-memory dev
//    backend (server/storage.ts, getCalendarTimeline). SupabaseStorage's
//    timeline deliberately excludes habits ("they don't belong on the
//    calendar"), so in PRODUCTION nothing applied the rule at all and every
//    surface treated every habit as due every single day — a weekly habit
//    nagged daily, and any "N habits still due today" count was inflated by
//    habits that were never scheduled.
//
//  - "Already checked in today" had three inline copies
//    (server/notification-service.ts, ExecutiveBriefing.tsx, server/storage.ts)
//    and only the storage one honored `targetPerDay`. So a "brush teeth 3×
//    daily" habit read as done after a single check-in on two of the three
//    surfaces.
//
// Pure and dependency-free so the client attention feed, the notification
// builder and the calendar timeline can all share one answer.

export interface HabitScheduleShape {
  frequency?: "daily" | "weekly" | "custom" | string;
  /** 0 = Sunday … 6 = Saturday. */
  targetDays?: number[] | null;
  targetPerDay?: number | null;
  checkins?: Array<{ date?: string | null }> | null;
}

/**
 * Day-of-week for a YYYY-MM-DD string, read as a LOCAL calendar date.
 *
 * `new Date("2026-07-29")` is parsed as UTC midnight, which lands on the
 * previous day for every negative-offset timezone — the exact class of bug that
 * makes a Monday habit show up on Sunday. Anchoring at noon avoids it.
 */
function dayOfWeekFor(dateStr: string): number {
  return new Date(`${String(dateStr).slice(0, 10)}T12:00:00`).getDay();
}

/**
 * Is this habit scheduled on `dateStr` (YYYY-MM-DD, user-local)?
 *
 * Ported from server/storage.ts so the semantics don't drift:
 *  - daily  → every day
 *  - weekly → the listed targetDays, defaulting to Monday when none are set
 *  - custom → the listed targetDays only (no default — an empty list means
 *             the habit is never scheduled, which is what the user configured)
 * An unknown/absent frequency is treated as daily, matching how the UI has
 * always rendered habits created before the field existed.
 */
export function isHabitDueOn(habit: HabitScheduleShape, dateStr: string): boolean {
  const dow = dayOfWeekFor(dateStr);
  const freq = habit.frequency || "daily";
  if (freq === "weekly") return habit.targetDays?.includes(dow) ?? dow === 1;
  if (freq === "custom") return habit.targetDays?.includes(dow) ?? false;
  return true;
}

/** Check-ins recorded for `dateStr`. */
export function habitCheckinCount(habit: HabitScheduleShape, dateStr: string): number {
  const day = String(dateStr).slice(0, 10);
  return (habit.checkins || []).filter((c) => String(c?.date || "").slice(0, 10) === day).length;
}

/** Has the habit met its per-day target on `dateStr`? Honors `targetPerDay`. */
export function isHabitDoneOn(habit: HabitScheduleShape, dateStr: string): boolean {
  return habitCheckinCount(habit, dateStr) >= (habit.targetPerDay || 1);
}

/** Scheduled today and not yet satisfied — the "still due" rule. */
export function isHabitOutstandingOn(habit: HabitScheduleShape, dateStr: string): boolean {
  return isHabitDueOn(habit, dateStr) && !isHabitDoneOn(habit, dateStr);
}
