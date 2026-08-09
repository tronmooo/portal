// shared/habit-progress.ts — how far through today's habit are you?
//
// Pure, no I/O. The ONE answer every surface renders.
//
// A habit has always been able to require several completions in a day
// (`targetPerDay`), and each completion has always been its own check-in row
// with its own timestamp. What was missing was a shared notion of PARTIAL
// progress: each surface asked only "is it done?" (`count >= target`), so a
// "2× daily" habit with one dose logged read as 0% on the dashboard, as a
// finished checkmark in the popup, and as "not checked in yet" in the briefing
// — three different answers to one question.
//
// Progress is a fraction of the day's REQUIRED occurrences:
//
//     percent = completed ÷ required × 100
//
//   2× daily → 0 / 50 / 100
//   3× daily → 0 / 33 / 67 / 100
//   4× daily → 0 / 25 / 50 / 75 / 100
//
// Rounded to whole percent, but `isComplete` is decided on the COUNTS, never
// on the rounded percent — 2 of 3 rounds to 67 and must not be mistaken for
// done, and a rounding artifact must never award a streak day.
//
// THREE SHAPES THAT ARE NOT THE SAME THING (see shared/habit-schedule.ts for
// the window rules):
//
//   "2× per day"            targetPerDay 2, no end          two completions each day, forever
//   "daily for 2 days"      targetPerDay 1, endDate +1 day  one completion on each of two days
//   "2× per day for 7 days" targetPerDay 2, endDate +6 days 14 occurrences, two available per day
//
// They differ in `targetPerDay` and in the scheduling window, and nothing in
// this module collapses them: `required` is per-DAY, `totalScheduledOccurrences`
// is per-SERIES.

import { isHabitDueOn, habitCheckinCount, type HabitScheduleShape } from "./habit-schedule";

/** One check-in row. `id` is what per-occurrence undo targets. */
export interface HabitOccurrenceCheckin {
  id?: string;
  date?: string | null;
  timestamp?: string | null;
  value?: number | null;
  notes?: string | null;
}

export interface HabitProgressShape extends HabitScheduleShape {
  checkins?: HabitOccurrenceCheckin[] | null;
}

/** One required occurrence of a habit on one day. */
export interface HabitOccurrence {
  /** 0-based position in the day: occurrence 1 of 2 is index 0. */
  index: number;
  /** Human position: 1-based, what "my first dose" refers to. */
  position: number;
  /** The check-in that filled it, or null when it is still outstanding. */
  checkin: HabitOccurrenceCheckin | null;
  done: boolean;
}

export interface HabitDayProgress {
  /** Is the habit scheduled at all on this date? */
  isScheduled: boolean;
  /** Completions the day asks for. 0 when the habit isn't scheduled. */
  required: number;
  /** Completions recorded, never counted above `required`. */
  completed: number;
  /** Completions recorded INCLUDING any beyond the target (data from before a
   *  target was lowered, or a double-write). Kept separate so the extra rows
   *  are visible to anyone auditing rather than silently dropped. */
  rawCompleted: number;
  remaining: number;
  /** 0–100, whole numbers. Derived; never the basis for `isComplete`. */
  percent: number;
  /** Every required occurrence in order, filled or not. */
  occurrences: HabitOccurrence[];
  /** The day's target is met. Decided on counts, not on `percent`. */
  isComplete: boolean;
  /** Started but not finished — the state that used to be invisible. */
  isPartial: boolean;
  /** "1 of 2 completed" / "Not started" / "Not scheduled today". */
  label: string;
}

const clipDate = (d: unknown) => String(d ?? "").slice(0, 10);

/** How many completions this habit asks for on a scheduled day. */
export function habitDailyTarget(habit: HabitProgressShape): number {
  const raw = Number(habit?.targetPerDay ?? 1);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/**
 * The day's check-ins, oldest first.
 *
 * Order matters: it is what maps occurrence #1 to the check-in the user logged
 * first, so "undo my second dose" removes the second one and not an arbitrary
 * row.
 *
 * Ties break on the row's ORIGINAL POSITION, not on its id. Two completions
 * logged in the same millisecond have identical timestamps, and sorting those
 * by a random uuid would reorder the day between reads — "undo my first dose"
 * would remove a different row each time it was asked.
 */
export function habitDayCheckins(habit: HabitProgressShape, dateISO: string): HabitOccurrenceCheckin[] {
  const day = clipDate(dateISO);
  return (habit?.checkins || [])
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => clipDate(c?.date) === day)
    .sort((a, b) => {
      const ta = String(a.c?.timestamp || "");
      const tb = String(b.c?.timestamp || "");
      if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
      if (ta && !tb) return -1;
      if (!ta && tb) return 1;
      return a.i - b.i;
    })
    .map(({ c }) => c);
}

/**
 * Everything a surface needs to render one habit on one day.
 *
 * An UNSCHEDULED day reports `required: 0` and `isComplete: false` — "nothing
 * was asked of you" is not the same as "you finished", and treating it as
 * complete is how an every-Monday habit used to award streak days all week.
 */
export function habitDayProgress(habit: HabitProgressShape, dateISO: string): HabitDayProgress {
  const day = clipDate(dateISO);
  const scheduled = isHabitDueOn(habit, day);
  const dayCheckins = habitDayCheckins(habit, day);
  const rawCompleted = dayCheckins.length;

  if (!scheduled) {
    return {
      isScheduled: false,
      required: 0,
      completed: rawCompleted,
      rawCompleted,
      remaining: 0,
      percent: 0,
      occurrences: [],
      isComplete: false,
      isPartial: false,
      label: "Not scheduled today",
    };
  }

  const required = habitDailyTarget(habit);
  const completed = Math.min(rawCompleted, required);
  const remaining = Math.max(0, required - completed);
  const isComplete = rawCompleted >= required;

  const occurrences: HabitOccurrence[] = Array.from({ length: required }, (_, index) => {
    const checkin = dayCheckins[index] ?? null;
    return { index, position: index + 1, checkin, done: !!checkin };
  });

  return {
    isScheduled: true,
    required,
    completed,
    rawCompleted,
    remaining,
    // Integer percent for display. `isComplete` above is the authority.
    percent: required > 0 ? Math.round((completed / required) * 100) : 0,
    occurrences,
    isComplete,
    isPartial: completed > 0 && !isComplete,
    label: required > 1
      ? `${completed} of ${required} completed`
      : isComplete ? "Completed" : "Not started",
  };
}

/**
 * The next occurrence still to be filled — what "mark my medication done"
 * means when two doses are scheduled and one is already logged.
 *
 * Returns null when the day is already satisfied, which the caller should
 * report rather than silently writing an extra row.
 */
export function nextOutstandingOccurrence(
  habit: HabitProgressShape,
  dateISO: string,
): HabitOccurrence | null {
  const progress = habitDayProgress(habit, dateISO);
  if (!progress.isScheduled) return null;
  return progress.occurrences.find((o) => !o.done) ?? null;
}

/**
 * The most recent completion of the day — what a bare "undo" removes.
 *
 * Undo takes the LAST one recorded, not the first: the user is correcting the
 * thing they just did. Removing occurrence #1 and leaving #2 would renumber
 * the day under them.
 */
export function latestCheckinOn(
  habit: HabitProgressShape,
  dateISO: string,
): HabitOccurrenceCheckin | null {
  const dayCheckins = habitDayCheckins(habit, dateISO);
  return dayCheckins.length > 0 ? dayCheckins[dayCheckins.length - 1] : null;
}

/**
 * The check-in filling a specific 1-based position ("undo my first dose").
 * Null when that position isn't filled.
 */
export function checkinAtPosition(
  habit: HabitProgressShape,
  dateISO: string,
  position: number,
): HabitOccurrenceCheckin | null {
  if (!Number.isFinite(position) || position < 1) return null;
  return habitDayCheckins(habit, dateISO)[position - 1] ?? null;
}

/**
 * Progress across a set of habits for one day, counted in OCCURRENCES.
 *
 * The dashboard's "1 of 2 done today" counted HABITS, so a day needing four
 * doses across two habits read as half done after a single dose. Counting the
 * work rather than the rows is the whole point of this module.
 *
 * Unscheduled habits contribute nothing to either side of the ratio.
 */
export function habitsDayRollup(habits: readonly HabitProgressShape[], dateISO: string): {
  required: number;
  completed: number;
  percent: number;
  habitsScheduled: number;
  habitsComplete: number;
  habitsPartial: number;
} {
  let required = 0, completed = 0, habitsScheduled = 0, habitsComplete = 0, habitsPartial = 0;
  for (const h of habits || []) {
    const p = habitDayProgress(h, dateISO);
    if (!p.isScheduled) continue;
    habitsScheduled++;
    required += p.required;
    completed += p.completed;
    if (p.isComplete) habitsComplete++;
    else if (p.isPartial) habitsPartial++;
  }
  return {
    required,
    completed,
    percent: required > 0 ? Math.round((completed / required) * 100) : 0,
    habitsScheduled,
    habitsComplete,
    habitsPartial,
  };
}

/**
 * How many completions the whole series asks for, when it has an end.
 *
 * This is what makes "2× per day for 7 days" a fourteen-occurrence commitment
 * rather than an endless one. Returns null for an open-ended habit — the honest
 * answer, and better than a number invented from an arbitrary horizon.
 */
export function totalScheduledOccurrences(habit: HabitProgressShape): number | null {
  const start = clipDate((habit as any)?.startDate);
  const end = clipDate((habit as any)?.endDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  if (end < start) return 0;

  const target = habitDailyTarget(habit);
  let days = 0;
  const cursor = new Date(`${start}T12:00:00`);
  const last = new Date(`${end}T12:00:00`);
  // Bounded: a decade of daily occurrences is already far past useful, and an
  // unbounded walk here would be a denial-of-service on a bad end date.
  for (let i = 0; i <= 3700 && cursor <= last; i++) {
    const iso = cursor.toLocaleDateString("en-CA");
    if (isHabitDueOn(habit, iso)) days++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days * target;
}

/** Completions recorded across the habit's whole life. */
export function totalCompletedOccurrences(habit: HabitProgressShape): number {
  return (habit?.checkins || []).length;
}

/** Re-exported so a caller needs one import to ask about a habit's day. */
export { isHabitDueOn, habitCheckinCount };
