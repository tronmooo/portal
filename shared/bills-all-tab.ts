// What the Bills page lists under "All Bills".
//
// The upcoming rows come from the finance snapshot, which looks 30 days ahead.
// A monthly bill that has just been paid is next due 28 to 33 days out, so it
// can fall past that window: the tab then read "No bills in the next 30 days"
// while the bill sat under Paid (found by tests/live-bills-ui-check.ts,
// 2026-11-24; owner: keep it on the list). A bill paid this month therefore
// stays under All Bills, on its NEXT date.
//
// Pure. The figures at the top of the page ("Total Due this month", "Due
// Soon") are still summed from the upcoming rows alone: a bill kept here for
// its next date adds nothing to what is due now.
import { daysUntilISO } from "./date-rules";

export interface BillRow {
  id: string;
  name?: string;
  amount?: number;
  status?: string;
  daysUntil?: number | null;
  dueDate?: string | null;
  paidDate?: string;
  [key: string]: unknown;
}

/**
 * The upcoming rows, then every bill paid this month that is not among them,
 * shown as upcoming on its next date. A paid bill with no next date (a
 * one-time bill, or a plan that has ended) is not added: it has nothing coming.
 */
export function allBillsRows(upcoming: readonly BillRow[], paidThisMonth: readonly BillRow[], todayISO: string): BillRow[] {
  const listed = new Set(upcoming.map((b) => String(b.id)));
  const later: BillRow[] = [];
  for (const p of paidThisMonth) {
    if (listed.has(String(p.id))) continue;
    const next = String(p.dueDate ?? "").slice(0, 10);
    const daysUntil = daysUntilISO(next, todayISO);
    // Only a real date still to come. A stored date in the past means the
    // schedule did not move on (a one-time bill): nothing is coming.
    if (daysUntil === null || daysUntil < 0) continue;
    listed.add(String(p.id));
    later.push({ ...p, status: "upcoming", dueDate: next, daysUntil, paidDate: p.paidDate });
  }
  return [...upcoming, ...later].sort((a, b) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9));
}
