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
//   • the snapshot table is only as old as the daily job that fills it, and a
//     row written before an asset was ENTERED is not a row from before the
//     asset was OWNED. `reconstructNetWorthBaseline` therefore rebuilds the
//     30-day baseline from the items themselves: an item with no value
//     recorded before the cutoff counts at its first known value (not 0), and
//     only an item whose acquisition date falls inside the window is genuinely
//     new money. The server ships that figure as
//     financeSnapshot.netWorthBaseline and every surface passes it here.
//     (QA 2026-09-18 F-10: a $1.6M household of long-held assets read
//     "↑ $1,488,253 this month"; a $75 profile read "↑ $75 this month".)

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

/** A baseline the server rebuilt from the items themselves (financeSnapshot.netWorthBaseline). */
export interface NetWorthBaseline {
  date: string;
  netWorth: number;
  /** True when at least part of the figure came from the items rather than a stored snapshot row. */
  reconstructed: boolean;
}

/** One balance-sheet item as the baseline rebuild sees it. Values are share-applied. */
export interface BaselineItem {
  /** Today's value (share-applied). */
  value: number;
  /** +1 asset, −1 liability. Default +1. */
  sign?: 1 | -1;
  /** When the row was ENTERED in the app. */
  createdAt?: string | null;
  /** When the thing was actually acquired (purchase / closing date), if known. */
  acquiredOn?: string | null;
  /** Past values, any order; `value` null = an estimate that produced nothing. */
  history?: ReadonlyArray<{ date: string; value: number | null }> | null;
}

const ACQUISITION_KEYS = ["purchaseDate", "purchase_date", "acquiredDate", "acquired_date", "acquisitionDate", "acquisition_date", "dateAcquired", "date_acquired", "closingDate", "closing_date"];

/** The day an asset was actually acquired, from the usual field spellings (top level or nested). */
export function acquisitionDateOf(fields: any): string | null {
  if (!fields || typeof fields !== "object") return null;
  const groups = [fields, fields.vehicle, fields.vehicles, fields.housing, fields.other, fields.finance, fields.investment];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    for (const k of ACQUISITION_KEYS) {
      const d = String(g[k] ?? "").slice(0, 10);
      if (DAY_RE.test(d)) return d;
    }
  }
  return null;
}

const dayOf = (v: any): string | null => {
  const d = String(v ?? "").slice(0, 10);
  return DAY_RE.test(d) ? d : null;
};

/** What one item was worth on `cutoff`: the last value recorded on or before it, else its first known value; 0 only when it was acquired after the cutoff. */
export function itemValueAt(item: BaselineItem, cutoff: string): number {
  const acquired = dayOf(item.acquiredOn);
  if (acquired && acquired > cutoff) return 0;
  const hist = (item.history || [])
    .map((h) => ({ date: dayOf(h.date), value: h.value == null ? NaN : Number(h.value) }))
    .filter((h): h is { date: string; value: number } => !!h.date && Number.isFinite(h.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const before = hist.filter((h) => h.date <= cutoff);
  if (before.length > 0) return before[before.length - 1].value;
  if (hist.length > 0) return hist[0].value;
  return Number(item.value) || 0;
}

/**
 * The net worth on `cutoff`, rebuilt from the items. With a stored snapshot
 * row on or before the cutoff, items ENTERED after that row was written (and
 * not acquired since) are added to it at their value then — the row simply
 * did not know about them yet. Without one, every item contributes its value
 * at the cutoff.
 */
export function reconstructNetWorthBaseline(
  items: ReadonlyArray<BaselineItem>,
  cutoff: string,
  storedRow?: { snapshotDate: string; netWorth: number } | null,
): NetWorthBaseline | null {
  if (!DAY_RE.test(cutoff)) return null;
  const storedDay = storedRow ? dayOf(storedRow.snapshotDate) : null;
  const stored = storedRow && storedDay && Number.isFinite(Number(storedRow.netWorth))
    ? { snapshotDate: storedDay, netWorth: Number(storedRow.netWorth) }
    : null;
  let total = stored ? stored.netWorth : 0;
  let added = 0;
  for (const item of items) {
    const sign = item.sign === -1 ? -1 : 1;
    if (stored) {
      const entered = dayOf(item.createdAt);
      // Entered on or before the row's day (or entry day unknown) → the row
      // already counted it.
      if (!entered || entered <= stored.snapshotDate) continue;
    }
    const v = itemValueAt(item, stored ? stored.snapshotDate : cutoff);
    if (v === 0) continue;
    total += sign * v;
    added++;
  }
  return { date: stored ? stored.snapshotDate : cutoff, netWorth: total, reconstructed: !stored || added > 0 };
}

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
  serverBaseline?: Partial<NetWorthBaseline> | null,
): NetWorthChange | null {
  if (current == null || !Number.isFinite(Number(current))) return null;
  const rows = (history || [])
    .map((r) => ({ snapshotDate: String(r.snapshotDate || r.snapshot_date || "").slice(0, 10), netWorth: Number(r.netWorth ?? r.net_worth) }))
    .filter((r) => DAY_RE.test(r.snapshotDate) && Number.isFinite(r.netWorth))
    .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  const cutoff = DAY_RE.test(todayISO) ? addDays(todayISO, -30) : null;
  // The server's rebuilt baseline wins: the stored row corrected for items it
  // never saw, or — with no row that old — the items' own values at the
  // cutoff. Either way it is a real month-over-month.
  const rebuiltDay = serverBaseline ? dayOf(serverBaseline.date) : null;
  const rebuilt = serverBaseline && rebuiltDay && Number.isFinite(Number(serverBaseline.netWorth))
    ? { snapshotDate: rebuiltDay, netWorth: Number(serverBaseline.netWorth) }
    : null;
  if (rows.length === 0 && !rebuilt) return null;
  const onOrBefore = cutoff ? rows.filter((r) => r.snapshotDate <= cutoff) : [];
  const baseline = rebuilt ?? (onOrBefore.length > 0 ? onOrBefore[onOrBefore.length - 1] : null);
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
