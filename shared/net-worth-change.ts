// ── Net-worth change ─────────────────────────────────────────────────────────
// Pure, no I/O. ONE definition of "how much did my net worth change this
// month" for the Finance page, the Executive tab and the Net Worth popup.
//
// Each used to derive it differently — a 120-day window against the last
// snapshot row, a 35-day window against the live total, a 120-day window with
// the last point overwritten — so the same account read "+1201.1%" on one tab
// and "+1241.7%" on the next. Both were also measuring against the OLDEST row
// in the window, which on a young snapshot table is the first, half-populated
// total the daily job ever wrote.
//
// Rules:
//   • baseline = the snapshot on or immediately before `todayISO − 30 days`.
//     With no row that old, no monthly figure is stated (a three-day-old
//     history cannot claim a monthly change) — the $ delta from the oldest
//     row is offered instead, labelled by its own date.
//   • current  = the live total, always (the headline number and its delta
//     come from the same figure).
//   • a % is only stated on a non-trivial, sign-stable baseline.

import { addDays } from "./timezone";

export interface NetWorthHistoryRow {
  snapshotDate: string;
  netWorth: number;
}

export interface NetWorthChange {
  /** Percent change against the monthly baseline, or null when it cannot honestly be stated. */
  pct: number | null;
  /** Dollar change against the baseline row (monthly when `monthly`, else since the oldest row). */
  delta: number | null;
  /** The baseline row's date, so the caption can say what the change is measured from. */
  baselineDate: string | null;
  /** True when the baseline is ≥ 30 days old — the figure is a real month-over-month. */
  monthly: boolean;
  up: boolean;
  /**
   * What the change is measured over, for the caption: "this month" on a real
   * monthly baseline, else "since <first snapshot date>". A history that
   * started the day the assets were entered is not a month of growth
   * (QA 2026-09-18: "↑ $1,488,433 this month" on a $1.6M net worth).
   */
  label: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "Sep 3" for a YYYY-MM-DD — a calendar day, never an instant. */
function sinceLabel(day: string): string {
  const m = Number(day.slice(5, 7)), d = Number(day.slice(8, 10));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return MONTHS[m - 1] ? `${MONTHS[m - 1]} ${d}` : day;
}

export function netWorthChange(
  history: ReadonlyArray<Partial<NetWorthHistoryRow> & Record<string, any>> | null | undefined,
  current: number | null | undefined,
  todayISO: string = new Date().toLocaleDateString("en-CA"),
): NetWorthChange | null {
  if (current == null || !Number.isFinite(Number(current))) return null;
  const rows = (history || [])
    .map((r) => ({ snapshotDate: String(r.snapshotDate || r.snapshot_date || "").slice(0, 10), netWorth: Number(r.netWorth ?? r.net_worth) }))
    .filter((r) => DAY_RE.test(r.snapshotDate) && Number.isFinite(r.netWorth))
    .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  if (rows.length === 0) return null;
  const cutoff = DAY_RE.test(todayISO) ? addDays(todayISO, -30) : null;
  const onOrBefore = cutoff ? rows.filter((r) => r.snapshotDate <= cutoff) : [];
  const baseline = onOrBefore.length > 0 ? onOrBefore[onOrBefore.length - 1] : null;
  const monthly = baseline != null;
  const ref = baseline ?? rows[0];
  const now = Number(current);
  // A history whose only rows are from today has no earlier point to measure
  // from: the "change" would be today's entries against themselves.
  if (!monthly && DAY_RE.test(todayISO) && ref.snapshotDate >= todayISO) {
    return { pct: null, delta: null, baselineDate: ref.snapshotDate, monthly: false, up: true, label: "since first entry" };
  }
  const delta = now - ref.netWorth;
  const baselineTooSmall = Math.abs(ref.netWorth) < 1;
  const signFlipped = (ref.netWorth < 0) !== (now < 0);
  const pct = monthly && !baselineTooSmall && !signFlipped ? (delta / Math.abs(ref.netWorth)) * 100 : null;
  const label = monthly ? "this month" : `since ${sinceLabel(ref.snapshotDate)}`;
  return { pct, delta, baselineDate: ref.snapshotDate, monthly, up: delta >= 0, label };
}
