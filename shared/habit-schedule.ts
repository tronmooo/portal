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

export interface HabitCompletionShape {
  id?: string;
  date?: string | null;
  timestamp?: string | null;
  value?: number | null;
  notes?: string | null;
  source?: string | null;
}

export interface HabitScheduleShape {
  frequency?: "daily" | "weekly" | "custom" | string;
  /** 0 = Sunday … 6 = Saturday. */
  targetDays?: number[] | null;
  targetPerDay?: number | null;
  checkins?: HabitCompletionShape[] | null;
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

/** The habit's daily target — how many completions make a day successful. */
export function habitDailyTarget(habit: HabitScheduleShape): number {
  const t = Number(habit?.targetPerDay);
  return Number.isFinite(t) && t >= 1 ? Math.floor(t) : 1;
}

/**
 * Every completion recorded on `dateStr`, oldest first.
 *
 * Each completion is its own occurrence — a habit done three times today
 * returns three entries with three distinct timestamps, which is what the
 * "previous completion times" list and "undo one" both read.
 */
export function habitCompletionsOn<T extends HabitCompletionShape>(
  habit: { checkins?: T[] | null },
  dateStr: string,
): T[] {
  const day = String(dateStr).slice(0, 10);
  return (habit?.checkins || [])
    .filter((c) => String(c?.date || "").slice(0, 10) === day)
    .slice()
    .sort((a, b) => String(a?.timestamp || "").localeCompare(String(b?.timestamp || "")));
}

/** Check-ins recorded for `dateStr`. */
export function habitCheckinCount(habit: HabitScheduleShape, dateStr: string): number {
  const day = String(dateStr).slice(0, 10);
  return (habit.checkins || []).filter((c) => String(c?.date || "").slice(0, 10) === day).length;
}

/** Has the habit met its per-day target on `dateStr`? Honors `targetPerDay`. */
export function isHabitDoneOn(habit: HabitScheduleShape, dateStr: string): boolean {
  return habitCheckinCount(habit, dateStr) >= habitDailyTarget(habit);
}

export interface HabitDayProgress {
  /** Completions recorded — may exceed `target`; that is recorded, not clamped. */
  count: number;
  target: number;
  /** count >= target. */
  done: boolean;
  /** count > target — the user went past their goal. */
  exceeded: boolean;
  /** How many more to reach the target (0 once done). */
  remaining: number;
  /** 0..1, clamped for progress bars. Use count/target for the raw number. */
  ratio: number;
  /** "not_started" | "in_progress" | "complete" | "exceeded". */
  state: "not_started" | "in_progress" | "complete" | "exceeded";
}

/**
 * Today's picture for one habit: "2 / 3 completed today".
 *
 * The one place that decides what "done" means for a multi-completion habit,
 * so the habits page, the dashboard, the executive briefing and the
 * notification builder cannot drift apart — the drift they had was showing a
 * "medication 2x daily" habit as finished after the first dose.
 */
export function habitDayProgress(habit: HabitScheduleShape, dateStr: string): HabitDayProgress {
  const target = habitDailyTarget(habit);
  const count = habitCheckinCount(habit, dateStr);
  const done = count >= target;
  const exceeded = count > target;
  return {
    count,
    target,
    done,
    exceeded,
    remaining: Math.max(0, target - count),
    ratio: target > 0 ? Math.min(1, count / target) : 0,
    state: count === 0 ? "not_started" : exceeded ? "exceeded" : done ? "complete" : "in_progress",
  };
}

/** Scheduled today and not yet satisfied — the "still due" rule. */
export function isHabitOutstandingOn(habit: HabitScheduleShape, dateStr: string): boolean {
  return isHabitDueOn(habit, dateStr) && !isHabitDoneOn(habit, dateStr);
}
