// shared/domain/financial-period.ts — a transaction counts in the period its
// effective date falls in, and future money is never "spent".
//
// "This month" was recomputed nine times as a YYYY-MM prefix compare and none
// of them excluded future-dated rows, so an Internet bill dated October 12
// counted toward September, and a QA phone bill dated the 15th moved today's
// totals. This module is the one period engine: it buckets ledger items into
//   actual · pending · scheduled · forecast
// and totals each separately. Nothing merges them silently.
//
// Pure. Pinned by tests/consistency-layer-periods.test.ts.

export type LedgerBucket = "actual" | "pending" | "scheduled" | "forecast";

export const LEDGER_BUCKET_LABEL: Record<LedgerBucket, string> = {
  actual: "Actual",
  pending: "Pending",
  scheduled: "Scheduled",
  forecast: "Forecast",
};

export interface LedgerItem {
  /** YYYY-MM-DD effective date (posting date for a transaction, due date for a bill). */
  date: string | null | undefined;
  amount: number;
  /**
   * posted    → money moved (default for a dated expense/income)
   * pending   → initiated, not yet cleared (bank pending)
   * scheduled → a known future obligation with a due date (bill occurrence)
   * projected → an estimate (recurring average, forecast)
   */
  status?: "posted" | "pending" | "scheduled" | "projected" | null;
  isTestData?: boolean | null;
}

export interface Period {
  /** YYYY-MM-DD inclusive. */
  start: string;
  /** YYYY-MM-DD inclusive. */
  end: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

export function dayOf(v: unknown): string | null {
  const m = DAY_RE.exec(String(v ?? ""));
  return m ? m[0] : null;
}

/** The calendar month containing `dayISO`. */
export function monthPeriodOf(dayISO: string): Period {
  const y = Number(dayISO.slice(0, 4)), m = Number(dayISO.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

/** Period for a "YYYY-MM" key. */
export function monthPeriod(month: string): Period {
  return monthPeriodOf(`${month.slice(0, 7)}-01`);
}

/** transactionDate ≥ start AND transactionDate ≤ end. */
export function inPeriod(dateISO: unknown, period: Period): boolean {
  const d = dayOf(dateISO);
  if (!d) return false;
  return d >= period.start && d <= period.end;
}

/**
 * Which bucket an item belongs to, relative to today. A dated item after
 * today is never actual, whatever its status says.
 */
export function ledgerBucketOf(item: LedgerItem, todayISO: string): LedgerBucket {
  const d = dayOf(item.date);
  const status = item.status ?? "posted";
  if (status === "projected") return "forecast";
  if (d && d > todayISO) return "scheduled";
  if (status === "pending") return "pending";
  if (status === "scheduled") return d ? "pending" : "scheduled"; // due and not yet paid
  return "actual";
}

export interface PeriodTotals {
  period: Period;
  actual: number;
  pending: number;
  scheduled: number;
  forecast: number;
  /** actual + pending — money that has moved or is moving. */
  committed: number;
  /** actual + pending + scheduled + forecast — the projection. */
  projected: number;
  counts: Record<LedgerBucket, number>;
}

export interface PeriodTotalsOptions {
  todayISO: string;
  period: Period;
  /** Include rows flagged as test data. Default false. */
  includeTestData?: boolean;
}

/**
 * Total the items whose effective date falls inside `period`, split by bucket.
 * Test rows are excluded unless asked for.
 */
export function periodTotals(items: readonly LedgerItem[], opts: PeriodTotalsOptions): PeriodTotals {
  const out: PeriodTotals = {
    period: opts.period, actual: 0, pending: 0, scheduled: 0, forecast: 0, committed: 0, projected: 0,
    counts: { actual: 0, pending: 0, scheduled: 0, forecast: 0 },
  };
  for (const it of items) {
    if (!it || !Number.isFinite(Number(it.amount))) continue;
    if (it.isTestData && !opts.includeTestData) continue;
    if (!inPeriod(it.date, opts.period)) continue;
    const b = ledgerBucketOf(it, opts.todayISO);
    out[b] = round2(out[b] + Number(it.amount));
    out.counts[b] += 1;
  }
  out.committed = round2(out.actual + out.pending);
  out.projected = round2(out.committed + out.scheduled + out.forecast);
  return out;
}

/** Actual spending in the month containing `todayISO`. The one "this month" number. */
export function currentMonthActual(items: readonly LedgerItem[], todayISO: string, includeTestData = false): number {
  return periodTotals(items, { todayISO, period: monthPeriodOf(todayISO), includeTestData }).actual;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Adapter: an expense row is posted on its date. */
export function ledgerItemFromExpense(e: any, isTestData = false): LedgerItem {
  return { date: e?.date ?? null, amount: Number(e?.amount) || 0, status: e?.status === "pending" ? "pending" : "posted", isTestData };
}
/** Adapter: a bill occurrence is scheduled until paid. */
export function ledgerItemFromBillOccurrence(o: any, isTestData = false): LedgerItem {
  const paid = String(o?.status || "").toLowerCase() === "paid" || String(o?.status || "").toLowerCase() === "done";
  return {
    date: o?.dueAt ?? o?.dueDate ?? o?.date ?? null,
    amount: Number(o?.actualAmount ?? o?.amount) || 0,
    status: paid ? "posted" : o?.amountIsEstimate ? "projected" : "scheduled",
    isTestData,
  };
}
