// ── One scoped task selector for every dashboard surface ─────────────────────
// QA 2026-08-20 (bug 10): with "Everyone" selected the hub header read
// "Tasks Due 48" while the Tasks card directly below it read "0 Remaining".
// Neither number was wrong for its own definition — and that was the problem:
//
//   · the header chip showed the SERVER's stats.activeTasks, computed over
//     every row in the account;
//   · the Tasks card counted a CLIENT list that had already been through the
//     "hide test data" filter (shared/test-data.ts), which removes the
//     suite-generated rows a QA account is mostly made of.
//
// Two definitions of one number on one screen. This module is the single
// ownership-aware selector both read: same query key (so it resolves from the
// bootstrap seed with no extra request), same test-row filter, same
// pending/overdue/done-today arithmetic.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";

/** Today in the browser's timezone as YYYY-MM-DD — the dashboard's day anchor. */
export function todayInBrowserTz(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
}

/** Whole days from today to `dateStr`, or null when it carries no date. */
export function daysFromToday(dateStr: any, today: string = todayInBrowserTz()): number | null {
  const t = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return Math.round(
    (new Date(`${t}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000,
  );
}

/** `isTestDataRow` over every field a dashboard row can carry its name in. */
export function isHiddenTestRow(row: any): boolean {
  const testText = (s: any): boolean => {
    if (isTestDataRow(s)) return true;
    const str = String(s || "");
    // "Bob: QA Test Coffee" — the prefix is the owner, the payload is the row.
    return str.includes(":") && str.split(":").slice(1).some((part: string) => isTestDataRow(part.trim()));
  };
  return (
    testText(row?.name) || testText(row?.title) || isTestDataRow(row?.description) ||
    testText(row?.message) || isTestDataRow(row?.documentName)
  );
}

export interface TaskCounts {
  /** Every task the scope owns, after the test-row filter. */
  tasks: any[];
  /** Not done — the ONE number both "Tasks Due" and "Remaining" show. */
  pending: any[];
  /** Pending with a due date before today. */
  overdue: any[];
  /** Completed today, for the card's third tile. */
  doneToday: number;
  /** Pending, soonest due date first. */
  sortedPending: any[];
}

/** Pure counting half of the selector — unit-testable without React. */
export function computeTaskCounts(tasks: any[], today: string = todayInBrowserTz()): TaskCounts {
  const rows = tasks || [];
  const pending = rows.filter((t: any) => t?.status !== "done");
  const overdue = pending.filter((t: any) => (daysFromToday(t?.dueDate, today) ?? 1) < 0);
  const doneToday = rows.filter((t: any) =>
    t?.status === "done" && String(t?.completedAt || t?.updatedAt || "").slice(0, 10) === today).length;
  const sortedPending = pending.slice().sort((a: any, b: any) =>
    (daysFromToday(a?.dueDate, today) ?? 9e9) - (daysFromToday(b?.dueDate, today) ?? 9e9));
  return { tasks: rows, pending, overdue, doneToday, sortedPending };
}

/**
 * The scope's tasks, filtered and counted exactly once for the whole page.
 *
 * KEY LOCKSTEP: `["/api/tasks", mode, ...ids]` is the shape the bootstrap
 * seeds (lib/bootstrap-seed-keys.ts) and the Executive briefing already used,
 * so every extra caller resolves from cache and issues no request.
 *
 * NOTE (BUG-20260715-everyone-zeros): the query function must not swallow
 * errors into a cached empty array — a transient failure would then render as
 * "0 tasks" for the whole staleTime window.
 */
export function useScopedTasks(
  mode: string,
  ids: string[],
  opts: { enabled?: boolean } = {},
): TaskCounts & { isPending: boolean } {
  const enabled = opts.enabled !== false;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const showTestData = useShowTestData();
  const { data: raw = [], isPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    enabled,
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const today = todayInBrowserTz();
  const counts = useMemo(() => {
    const visible = showTestData ? (raw || []) : (raw || []).filter(t => !isHiddenTestRow(t));
    return computeTaskCounts(visible, today);
  }, [raw, showTestData, today]);
  return { ...counts, isPending };
}
