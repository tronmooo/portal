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
