// Lifecycle status for a recurring-bill liability, derived from its next due
// date. Shared by the server finance snapshot and the client detail/dashboard so
// "Overdue / Due today / Upcoming / Paid" is computed one way everywhere.

export type BillStatus = "paid" | "overdue" | "due_today" | "upcoming";

export const BILL_STATUS_META: Record<BillStatus, { label: string; tone: "red" | "amber" | "green" | "muted" }> = {
  overdue: { label: "Overdue", tone: "red" },
  due_today: { label: "Due today", tone: "amber" },
  upcoming: { label: "Upcoming", tone: "muted" },
  paid: { label: "Paid", tone: "green" },
};

/**
 * How long an unpaid past occurrence stays "overdue — still to pay" before it
 * is history ("missed"). QA 2026-09-18 (F-16): a bill whose Sep 15 cycle was
 * never paid rolled forward to Oct 15 on every list while the calendar kept
 * Sep 15, and nothing said a cycle had been missed. Inside this window the
 * unpaid occurrence IS the next due date — the bills list, the Bills Due
 * counter, the dashboard, the detail page and the calendar all show it as
 * overdue until it is paid or skipped.
 */
export const BILL_OVERDUE_GRACE_DAYS = 30;

/** True when `dueISO` is in the past but within the overdue grace window. */
export function isWithinOverdueGrace(dueISO: string | null | undefined, todayISO: string, graceDays = BILL_OVERDUE_GRACE_DAYS): boolean {
  const due = String(dueISO || "").slice(0, 10);
  const today = String(todayISO || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  if (due >= today) return false;
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86_400_000);
  return days <= graceDays;
}

/** `todayISO` is the user-local YYYY-MM-DD (pass from the caller's tz). */
export function liabilityBillStatus(
  dueDate: string | null | undefined,
  todayISO: string,
  paid = false,
): BillStatus {
  if (paid) return "paid";
  if (!dueDate) return "upcoming";
  const due = String(dueDate).slice(0, 10);
  if (due < todayISO) return "overdue";
  if (due === todayISO) return "due_today";
  return "upcoming";
}
