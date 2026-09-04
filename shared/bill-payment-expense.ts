// ── Bill-payment expenses — the double-count guard for cash flow ─────────────
//
// D-CASHFLOW-DOUBLE (user report: "I created a phone bill, it said -$10. I
// marked it paid and now it says -$20 — one-time $10 plus recurring $10, for
// the same bill"):
//
// Paying a recurring bill logs an expense row (server/liability-payments.ts,
// step 4) so budgets and monthly spend see the money leave. That row is
// correct — but it is the SAME money the bill's monthly obligation total
// already represents. Cash flow adds the two buckets together:
//
//     cash out = totalMonthlySpend + monthlyObligationTotal
//
// so the moment a recurring bill is paid its amount lands in both terms and
// the month reads twice as expensive as it is. Marking a bill paid must never
// make the month look worse.
//
// The fix is a split, not a deletion: bill-payment expenses stay in
// `totalMonthlySpend` and `spendByCategory` (budget caps and the Spend card
// are about money actually spent, and a paid bill IS spent), but the cash-flow
// waterfall's "one-time" bucket uses the non-bill remainder so the recurring
// column is the only place a bill is counted.
//
// The tags below are written by payBillOccurrence and are the join key its
// inverse already uses, so they are a reliable marker — not display metadata.

/** Marker tag every bill-payment expense carries. */
export const BILL_PAYMENT_TAG = "bill-payment";
/** `payment:<liabilityPaymentId>` — the ledger row this expense records. */
export const PAYMENT_TAG_PREFIX = "payment:";

/**
 * True when this expense is the record of a bill payment (logged by
 * payBillOccurrence), rather than discretionary one-time spending.
 */
export function isBillPaymentExpense(expense: { tags?: unknown } | null | undefined): boolean {
  const tags = Array.isArray(expense?.tags) ? (expense!.tags as unknown[]) : [];
  return tags.some(
    (t) => typeof t === "string" && (t === BILL_PAYMENT_TAG || t.startsWith(PAYMENT_TAG_PREFIX)),
  );
}

/** The expenses that are NOT bill payments — the cash-flow "one-time" bucket. */
export function oneTimeExpenses<T extends { tags?: unknown }>(expenses: readonly T[] | null | undefined): T[] {
  return (expenses || []).filter((e) => !isBillPaymentExpense(e));
}

/** Total of the bill-payment expenses in a set (the part already counted as recurring). */
export function billPaymentTotal(expenses: readonly { tags?: unknown; amount?: unknown }[] | null | undefined): number {
  return (expenses || []).reduce(
    (s, e) => (isBillPaymentExpense(e) ? s + (Number(e.amount) || 0) : s),
    0,
  );
}

// ── Reading the split off a finance snapshot ─────────────────────────────────
//
// getDashboardEnhanced().financeSnapshot ships both figures. Every cash-flow
// surface must read `oneTimeSpendOf` + `monthlyObligationTotal`; reading
// `totalMonthlySpend` there is what double-counted paid bills. The fallbacks
// keep a snapshot cached before this field existed rendering sanely.

export interface CashFlowSnapshotLike {
  totalMonthlySpend?: number | null;
  oneTimeSpend?: number | null;
  billPaymentSpend?: number | null;
  spendByCategory?: Record<string, number> | null;
  oneTimeSpendByCategory?: Record<string, number> | null;
  monthlyObligationTotal?: number | null;
}

/** Spend that is NOT already counted by the recurring bucket. */
export function oneTimeSpendOf(snap: CashFlowSnapshotLike | null | undefined): number {
  if (!snap) return 0;
  if (snap.oneTimeSpend != null) return Number(snap.oneTimeSpend) || 0;
  const total = Number(snap.totalMonthlySpend) || 0;
  const bills = Number(snap.billPaymentSpend) || 0;
  return Math.max(0, total - bills);
}

/** Per-category one-time spend, for the cash-flow "money out" list. */
export function oneTimeSpendByCategoryOf(
  snap: CashFlowSnapshotLike | null | undefined,
): Record<string, number> {
  return snap?.oneTimeSpendByCategory || snap?.spendByCategory || {};
}

/** Total money out for the month: recurring obligations + one-time spend. */
export function cashOutOf(snap: CashFlowSnapshotLike | null | undefined): number {
  return (Number(snap?.monthlyObligationTotal) || 0) + oneTimeSpendOf(snap);
}
