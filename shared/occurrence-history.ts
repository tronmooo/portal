// shared/occurrence-history.ts — what already happened to a series.
//
// The History tab of the calendar detail screen. Nothing here is stored for
// the purpose: every entry is DERIVED from the marks the series already
// carries (Rule 5 — no stored "resolved" flag), so the history and the
// schedule can never disagree about a date.
//
//   completed    a check-off / a paid bill / a completed task occurrence
//   skipped      one occurrence skipped; the series kept its schedule
//   missed       a payment marked missed, or a must-complete date that passed
//   rescheduled  one occurrence moved to another day
//
// Pure, dependency-free. Pinned by tests/occurrence-history.test.ts.

import type { CalendarOccurrence, CalendarSeries } from "./calendar-occurrences";

export type HistoryStatus = "completed" | "skipped" | "missed" | "rescheduled";

export interface HistoryEntry {
  /** The scheduled date the entry is about. */
  date: string;
  status: HistoryStatus;
  /** For `rescheduled`: the day it was moved to. */
  movedTo?: string;
}

/** A birthday or anniversary is never done, skipped or missed — it arrives. */
export function hasHistory(series: CalendarSeries): boolean {
  return series.kind !== "birthday" && series.kind !== "anniversary";
}

/**
 * Every recorded outcome of a series, newest first.
 *
 * `occurrences` is the generated stream for the series (it carries the
 * `overdue` status of a must-complete date that passed unhandled, which no
 * stored mark records). One entry per date: a date that was moved AND then
 * completed reads as completed.
 */
export function seriesHistory(
  series: CalendarSeries,
  occurrences: readonly CalendarOccurrence[],
  todayISO: string,
): HistoryEntry[] {
  if (!hasHistory(series)) return [];
  const byDate = new Map<string, HistoryEntry>();
  const moved = series.movedDates || {};

  for (const [from, to] of Object.entries(moved)) {
    if (from !== to) byDate.set(from, { date: from, status: "rescheduled", movedTo: to });
  }
  for (const o of occurrences) {
    if (o.status === "overdue" && o.effectiveDate < todayISO) byDate.set(o.date, { date: o.date, status: "missed" });
  }
  for (const d of series.missedDates || []) byDate.set(d, { date: d, status: "missed" });
  for (const d of series.skippedDates || []) byDate.set(d, { date: d, status: "skipped" });
  for (const d of series.completedDates || []) byDate.set(d, { date: d, status: "completed" });

  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export interface CompletionStats {
  completed: number;
  /** Occurrences that had an outcome: completed + skipped + missed. */
  total: number;
  /** Whole percent, 0–100. */
  pct: number;
}

/**
 * How much of what came due was done. A reschedule is not an outcome — the
 * occurrence is still ahead — so it is left out of the total.
 */
export function completionStats(entries: readonly HistoryEntry[]): CompletionStats {
  let completed = 0;
  let total = 0;
  for (const e of entries) {
    if (e.status === "rescheduled") continue;
    total++;
    if (e.status === "completed") completed++;
  }
  return { completed, total, pct: total ? Math.round((completed / total) * 100) : 0 };
}

export const HISTORY_LABELS: Record<HistoryStatus, string> = {
  completed: "Completed",
  skipped: "Skipped",
  missed: "Missed",
  rescheduled: "Rescheduled",
};
