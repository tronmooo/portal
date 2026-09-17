// ── Task counts ──────────────────────────────────────────────────────────────
// Pure, no I/O. ONE definition of the day buckets every task surface shows —
// the Tasks page summary band, the Tasks popup's progress bar and the
// Executive tab's task card. Each used to bucket on its own: one counted
// "done" as every completed task ever, another as completed today; one read
// an undated repeating chore as due today, another did not. Same list, three
// numbers.
//
// A repeating task's stored due date is rolled forward by the server (see
// shared/recurrence rollForwardRecurringTask), so `dueDate` here is always
// the NEXT occurrence and a plain string compare is the whole rule.

import { localDayOf } from "./timezone";

export interface CountableTask {
  status?: string | null;
  dueDate?: string | null;
  /** Completion stamp when the row carries one; falls back to updatedAt. */
  completedAt?: string | null;
  updatedAt?: string | null;
}

export interface TaskDayCounts {
  /** Open, dated, due before today. */
  overdue: number;
  /** Open, due today. */
  dueToday: number;
  /** Open, due after today. */
  upcoming: number;
  /** Open with no due date. */
  undated: number;
  /** Completed on today's calendar day (in `timezone`). */
  doneToday: number;
  /** Completed, ever. */
  doneAll: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDoneTask = (t: CountableTask): boolean => String(t?.status || "").toLowerCase() === "done";

/** Completed on `todayISO` (the completion stamp read in `timezone`). */
export function isDoneToday(t: CountableTask, todayISO: string, timezone?: string): boolean {
  if (!isDoneTask(t)) return false;
  const stamp = t.completedAt || t.updatedAt || null;
  if (!stamp) return false;
  return localDayOf(stamp, timezone) === todayISO;
}

export function countTasksByDay(tasks: readonly CountableTask[] | null | undefined, todayISO: string, timezone?: string): TaskDayCounts {
  const counts: TaskDayCounts = { overdue: 0, dueToday: 0, upcoming: 0, undated: 0, doneToday: 0, doneAll: 0 };
  for (const t of tasks || []) {
    if (isDoneTask(t)) {
      counts.doneAll++;
      if (isDoneToday(t, todayISO, timezone)) counts.doneToday++;
      continue;
    }
    const d = String(t.dueDate || "").slice(0, 10);
    if (!DAY_RE.test(d)) counts.undated++;
    else if (d < todayISO) counts.overdue++;
    else if (d === todayISO) counts.dueToday++;
    else counts.upcoming++;
  }
  return counts;
}
