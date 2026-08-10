// Net cash flow — BOTH sides of the ledger, in one place.
//
//   Net cash flow = money in − money out
//
// The app used to answer "how is this month going?" with outgoing money only:
// spend, bills, liabilities. Income lived in a disconnected corner and got
// normalized into a fuzzy "monthly equivalent", so a month never actually
// balanced. This module is the single place where the two sides meet.
//
// PROJECTED vs ACTUAL is the load-bearing distinction:
//
//   PROJECTED — everything the month is planned to do. Every expected paycheck
//               and every bill due, whether or not either has happened yet.
//               "Projected August net: +$1,650."
//   ACTUAL    — only money that really moved. Income actually received, spend
//               actually logged, bills actually paid.
//               "Actual so far: +$820."
//
// Reporting only projected would let an unpaid future paycheck make the user
// look richer than they are; reporting only actual would hide a month that is
// on track. Every surface shows both.
//
// Pure, dependency-free, no I/O. Pinned by tests/cash-flow.test.ts.

import {
  generateIncomeSchedule,
  totalIncomeOccurrences,
  type IncomeOccurrence,
  type Incomeish,
  type Receiptish,
} from "./income-schedule";

/** One money-out line in a window — an expense, a bill occurrence, a payment. */
export interface OutflowLine {
  /** Date the money is due, or the date it left. YYYY-MM-DD. */
  date: string;
  amount: number;
  /** True once the money has actually left (expense logged, bill paid). */
  settled: boolean;
  /** Skipped/cancelled lines count toward neither projected nor actual. */
  skipped?: boolean;
  label?: string;
  category?: string;
  sourceId?: string;
  kind?: "expense" | "bill" | "liability" | "other";
}

export interface CashFlowSide {
  /** Everything planned for the window, settled or not. */
  projected: number;
  /** Only what actually moved. */
  actual: number;
  /** Planned money still waiting to move (projected − actual, floored at 0). */
  outstanding: number;
  count: number;
}

export interface CashFlowSummary {
  /** Inclusive window, YYYY-MM-DD. */
  start: string;
  end: string;
  /** The tz-local today the projected/actual split was computed against. */
  asOf: string;
  income: CashFlowSide;
  outgoing: CashFlowSide;
  /** Projected income − projected outgoing. Negative when outgoing wins. */
  projectedNet: number;
  /** Received income − settled outgoing. The "so far" number. */
  actualNet: number;
  /** Money already received but not yet spent against the month's plan. */
  remainingToReceive: number;
  remainingToPay: number;
  currency: string;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clip = (d: any) => String(d ?? "").slice(0, 10);

/** Roll outflow lines into the projected/actual split. */
export function totalOutflow(lines: readonly OutflowLine[]): CashFlowSide {
  let projected = 0, actual = 0, count = 0;
  for (const l of lines) {
    if (l.skipped) continue;
    const amt = Number(l.amount) || 0;
    projected += amt;
    if (l.settled) actual += amt;
    count++;
  }
  return {
    projected: round2(projected),
    actual: round2(actual),
    outstanding: round2(Math.max(0, projected - actual)),
    count,
  };
}

/** Roll income occurrences into the same shape as the outflow side. */
export function totalInflow(occurrences: readonly IncomeOccurrence[]): CashFlowSide {
  const t = totalIncomeOccurrences(occurrences);
  return {
    projected: t.projected,
    actual: t.received,
    outstanding: t.outstanding,
    count: t.occurrenceCount,
  };
}

export interface CashFlowInput {
  start: string;
  end: string;
  /** Caller's tz-local today. Drives which occurrences count as actual. */
  todayISO: string;
  incomes: readonly Incomeish[];
  /** Receipts for an income series (already scoped to the user). */
  receiptsFor?: (incomeId: string) => Receiptish[];
  outflows: readonly OutflowLine[];
  currency?: string;
}

/**
 * The month's (or any window's) full picture.
 *
 *   projectedNet = total expected income − total expected outgoing
 *   actualNet    = total received income − total settled outgoing
 *
 * A $6,000-in / $4,350-out August comes back as projectedNet +1650. When
 * outgoing exceeds income the number is simply negative — no clamping, no
 * absolute values; callers render the sign.
 */
export function computeCashFlow(input: CashFlowInput): CashFlowSummary {
  const start = clip(input.start);
  const end = clip(input.end);
  const todayISO = clip(input.todayISO);
  const receiptsFor = input.receiptsFor ?? (() => []);

  const occurrences: IncomeOccurrence[] = [];
  for (const inc of input.incomes) {
    occurrences.push(
      ...generateIncomeSchedule(inc, receiptsFor(inc.id) || [], {
        todayISO, windowStart: start, windowEnd: end,
      }),
    );
  }

  const income = totalInflow(occurrences);
  const outgoing = totalOutflow(input.outflows);

  return {
    start,
    end,
    asOf: todayISO,
    income,
    outgoing,
    projectedNet: round2(income.projected - outgoing.projected),
    actualNet: round2(income.actual - outgoing.actual),
    remainingToReceive: income.outstanding,
    remainingToPay: outgoing.outstanding,
    currency: (input.currency || "usd").toLowerCase(),
  };
}

/** First and last day of the month containing `iso`, inclusive. */
export function monthBounds(iso: string): { start: string; end: string } {
  const s = clip(iso);
  const [y, m] = s.split("-").map(Number);
  const year = Number.isFinite(y) ? y : new Date().getFullYear();
  const month = Number.isFinite(m) ? m : 1;
  const last = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(last)}` };
}

/**
 * One-line phrasing every surface can reuse, e.g.
 *   "Projected August net: +$1,650 · Actual so far: +$820"
 */
export function describeCashFlow(
  summary: CashFlowSummary,
  monthLabel?: string,
  fmt: (n: number) => string = defaultMoney,
): string {
  const label = monthLabel ? `${monthLabel} ` : "";
  return `Projected ${label}net: ${signed(summary.projectedNet, fmt)} · Actual so far: ${signed(summary.actualNet, fmt)}`;
}

export function signed(n: number, fmt: (n: number) => string = defaultMoney): string {
  const v = round2(n);
  return `${v >= 0 ? "+" : "-"}${fmt(Math.abs(v))}`;
}

function defaultMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
