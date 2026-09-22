// shared/domain/counts.ts — every count carries its scope.
//
// "Tasks: 7" meant seven different things: the Settings tile counted every
// open task on the account, the hub chip counted the selected profile's tasks
// due within the window, the Executive card counted "remaining". None said
// which. This module makes scope a REQUIRED argument and returns the label
// alongside the number, so two screens given the same scope agree and a
// screen showing Everyone says so.
//
// Pure. Pinned by tests/consistency-layer-counts.test.ts.

import { countTasksByDay, isDoneTask, type CountableTask } from "../task-counts";
import { forEnvironment, type EnvironmentTagged } from "./data-environment";
import { filterVisible, type OwnershipContext, type ResolvedScope } from "./ownership";

export type TaskStatusScope = "open" | "done" | "all" | "overdue" | "due_today" | "upcoming";

export interface CountScope {
  /** Which profiles. `everyone` = no owner filter. */
  scope: ResolvedScope;
  status?: TaskStatusScope;
  /** Inclusive YYYY-MM-DD bounds on the due date. */
  dateRange?: { start?: string | null; end?: string | null } | null;
  includeTestData?: boolean;
  /** User-local today, for the day buckets. */
  todayISO: string;
  timezone?: string;
}

export interface ScopedCount {
  count: number;
  /** "Open tasks · Bob" — the words a tile shows under its number. */
  scopeLabel: string;
  ownerLabel: string;
  statusLabel: string;
}

const STATUS_LABEL: Record<TaskStatusScope, string> = {
  open: "Open", done: "Completed", all: "All", overdue: "Overdue", due_today: "Due today", upcoming: "Upcoming",
};

export function ownerScopeLabel(scope: ResolvedScope): string {
  return scope.mode === "everyone" || scope.profileIds.length === 0 ? "Everyone" : scope.label;
}

type TaskRow = CountableTask & EnvironmentTagged & { linkedProfiles?: string[] | null; id?: string };

/** The one task counter. */
export function getTaskCount(tasks: readonly TaskRow[] | null | undefined, opts: CountScope, ctx: OwnershipContext): ScopedCount {
  const status = opts.status ?? "open";
  let rows = forEnvironment(tasks || [], { includeTest: opts.includeTestData === true });
  rows = filterVisible("task", rows, opts.scope, ctx);
  if (opts.dateRange && (opts.dateRange.start || opts.dateRange.end)) {
    const s = opts.dateRange.start ?? "0000-00-00", e = opts.dateRange.end ?? "9999-99-99";
    rows = rows.filter((t) => { const d = String(t.dueDate || "").slice(0, 10); return d && d >= s && d <= e; });
  }
  let count: number;
  if (status === "all") count = rows.length;
  else if (status === "done") count = rows.filter(isDoneTask).length;
  else if (status === "open") count = rows.filter((t) => !isDoneTask(t)).length;
  else {
    const c = countTasksByDay(rows, opts.todayISO, opts.timezone);
    count = status === "overdue" ? c.overdue : status === "due_today" ? c.dueToday : c.upcoming;
  }
  const ownerLabel = ownerScopeLabel(opts.scope);
  const statusLabel = STATUS_LABEL[status];
  return { count, ownerLabel, statusLabel, scopeLabel: `${statusLabel} tasks · ${ownerLabel}` };
}

type TrackerRow = EnvironmentTagged & { id?: string; linkedProfiles?: string[] | null; entries?: unknown[] | null; entriesTotal?: number | null; archived?: boolean | null; category?: string | null };

export interface TrackerCountScope {
  scope: ResolvedScope;
  /** Only trackers with at least one entry. Default false. */
  activeOnly?: boolean;
  includeTestData?: boolean;
}

/** The one tracker counter. */
export function getTrackerCount(trackers: readonly TrackerRow[] | null | undefined, opts: TrackerCountScope, ctx: OwnershipContext): ScopedCount {
  let rows = forEnvironment(trackers || [], { includeTest: opts.includeTestData === true });
  rows = filterVisible("tracker", rows, opts.scope, ctx).filter((t) => !t.archived);
  if (opts.activeOnly) rows = rows.filter((t) => (t.entriesTotal ?? (t.entries?.length ?? 0)) > 0);
  const ownerLabel = ownerScopeLabel(opts.scope);
  const statusLabel = opts.activeOnly ? "Active" : "All";
  return { count: rows.length, ownerLabel, statusLabel, scopeLabel: `${statusLabel} trackers · ${ownerLabel}` };
}

/** Generic scoped count for any owned record set (documents, habits, events…). */
export function getRecordCount<T extends EnvironmentTagged>(
  source: string,
  rows: readonly T[] | null | undefined,
  opts: { scope: ResolvedScope; includeTestData?: boolean; where?: (row: T) => boolean; noun: string },
  ctx: OwnershipContext,
): ScopedCount {
  let list = forEnvironment(rows || [], { includeTest: opts.includeTestData === true });
  list = filterVisible(source, list, opts.scope, ctx);
  if (opts.where) list = list.filter(opts.where);
  const ownerLabel = ownerScopeLabel(opts.scope);
  return { count: list.length, ownerLabel, statusLabel: "All", scopeLabel: `${opts.noun} · ${ownerLabel}` };
}
