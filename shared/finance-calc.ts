/**
 * THE finance calculation module.
 *
 * Every Finance screen, dashboard card, AI tool, report and export computes its
 * numbers here. Nothing recomputes a total inline. This is the same rule
 * ARCHITECTURE.md §1 already applies to the manual finance model, extended to
 * connected bank data.
 *
 * Ground rules baked into every function below:
 *   1. Money is integer minor units (shared/money.ts). No float arithmetic.
 *   2. Positive = money in, negative = money out. Always.
 *   3. Currencies are NEVER added together. Totals are returned grouped by
 *      currency; a caller that wants one number must say which currency.
 *   4. Excluded, duplicate, void and confirmed-transfer rows never reach a
 *      spending or income total.
 *   5. Uncertainty is surfaced, not swallowed: anything the matcher is unsure
 *      about comes back in a `needsReview` bucket instead of being silently
 *      classified.
 */

import {
  type Minor, absMinor, divideMinor, percentChange, sumMinor, toMinor, withinTolerance,
} from "./money";
import type {
  FinancialAccountRecord, FinancialTransactionRecord, TransactionStatus,
} from "./finance-connections";
import { isDebtAccount } from "./finance-connections";

// ────────────────────────────────────────────────────────────────────────────
// Scope — the parameter set EVERY calculation accepts
// ────────────────────────────────────────────────────────────────────────────

export interface CalcScope {
  /** Owner of the data. Callers must have verified it; this module never trusts it for access control. */
  userId?: string;
  /** Inclusive ISO date (YYYY-MM-DD). */
  startDate?: string;
  /** Inclusive ISO date (YYYY-MM-DD). */
  endDate?: string;
  /** When set, only these financial_accounts.id values participate. */
  includeAccountIds?: string[];
  /** Always removed, even if listed in includeAccountIds. */
  excludeAccountIds?: string[];
  /** Which transaction statuses count. Default: posted + pending. */
  statuses?: TransactionStatus[];
  /** Restrict to a single currency. Omit to get per-currency groupings. */
  currency?: string;
  /**
   * Honour user overrides (category changes, "not income", exclusions).
   * Default true — turn off only when auditing raw imported data.
   */
  applyManualOverrides?: boolean;
  /** Include rows flagged as duplicates. Default false. */
  includeDuplicates?: boolean;
  /** Include transfers in inflow/outflow. Default false (they are not spending). */
  includeTransfers?: boolean;
}

const DEFAULT_STATUSES: TransactionStatus[] = ["posted", "pending"];

/** Money grouped by ISO currency code — the shape all totals return. */
export type MoneyByCurrency = Record<string, Minor>;

function addTo(bucket: MoneyByCurrency, currency: string, amount: Minor): void {
  const key = (currency || "usd").toLowerCase();
  bucket[key] = (bucket[key] ?? 0) + toMinor(amount);
}

/**
 * Collapse a per-currency map to a single number, but ONLY when it is honest:
 * one currency present (or the caller pinned one). Multi-currency returns null
 * so the UI shows the split rather than a meaningless sum.
 */
export function singleCurrencyTotal(
  totals: MoneyByCurrency,
  currency?: string,
): { amount: Minor; currency: string } | null {
  const keys = Object.keys(totals);
  if (currency) {
    const c = currency.toLowerCase();
    return { amount: totals[c] ?? 0, currency: c };
  }
  if (keys.length === 0) return { amount: 0, currency: "usd" };
  if (keys.length === 1) return { amount: totals[keys[0]], currency: keys[0] };
  return null; // mixed currencies, no conversion implemented — say so upstream
}

// ────────────────────────────────────────────────────────────────────────────
// Filtering
// ────────────────────────────────────────────────────────────────────────────

/**
 * Reduce a transaction list to the rows a calculation should see.
 *
 * `confirmedTransferIds` carries the ids on both legs of transfer links the
 * user (or high-confidence matching) has confirmed. They are dropped from
 * spending/income by default because moving your own money is neither.
 */
export function filterTransactions(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds: ReadonlySet<string> = new Set(),
): FinancialTransactionRecord[] {
  const statuses = new Set<string>(scope.statuses ?? DEFAULT_STATUSES);
  const include = scope.includeAccountIds?.length ? new Set(scope.includeAccountIds) : null;
  const exclude = new Set(scope.excludeAccountIds ?? []);
  const currency = scope.currency?.toLowerCase();
  const includeTransfers = scope.includeTransfers ?? false;

  return transactions.filter((t) => {
    if (!t) return false;
    // `void` transactions never count — the money did not move.
    if (!statuses.has(t.status)) return false;
    if (include && !include.has(t.financialAccountId)) return false;
    if (exclude.has(t.financialAccountId)) return false;
    if (currency && (t.currency || "usd").toLowerCase() !== currency) return false;
    if (!scope.includeDuplicates && t.isDuplicate) return false;
    if (t.excludedFromTotals) return false;
    if (!includeTransfers && (t.isTransfer || confirmedTransferIds.has(t.id))) return false;
    if (scope.startDate && t.transactionDate < scope.startDate) return false;
    if (scope.endDate && t.transactionDate > scope.endDate) return false;
    return true;
  });
}

/** Accounts a calculation should see, honouring hide/include flags. */
export function filterAccounts(
  accounts: FinancialAccountRecord[],
  scope: CalcScope = {},
  opts: { netWorthOnly?: boolean } = {},
): FinancialAccountRecord[] {
  const include = scope.includeAccountIds?.length ? new Set(scope.includeAccountIds) : null;
  const exclude = new Set(scope.excludeAccountIds ?? []);
  const currency = scope.currency?.toLowerCase();
  return accounts.filter((a) => {
    if (!a) return false;
    if (include && !include.has(a.id)) return false;
    if (exclude.has(a.id)) return false;
    if (currency && (a.currency || "usd").toLowerCase() !== currency) return false;
    if (opts.netWorthOnly && !a.includeInNetWorth) return false;
    // A disconnected account's last known balance is stale; it must not prop up
    // a net-worth figure the user believes is current.
    if (opts.netWorthOnly && a.status === "disconnected") return false;
    return true;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Balances & net worth
// ────────────────────────────────────────────────────────────────────────────

/** Sum of connected accounts the user OWNS (cash, investments). */
export function calculateConnectedAssetTotal(
  accounts: FinancialAccountRecord[],
  scope: CalcScope = {},
): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const a of filterAccounts(accounts, scope, { netWorthOnly: true })) {
    if (isDebtAccount(a.accountType)) continue;
    const bal = toMinor(a.currentBalance);
    if (bal === 0) continue;
    addTo(out, a.currency, bal);
  }
  return out;
}

/**
 * Sum of connected DEBT, returned as a POSITIVE magnitude (what you owe).
 * Balances are stored negative for debt, so this flips the sign once, here,
 * rather than at a dozen call sites that could each get it wrong.
 */
export function calculateConnectedLiabilityTotal(
  accounts: FinancialAccountRecord[],
  scope: CalcScope = {},
): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const a of filterAccounts(accounts, scope, { netWorthOnly: true })) {
    if (!isDebtAccount(a.accountType)) continue;
    const owed = absMinor(a.currentBalance);
    if (owed === 0) continue;
    addTo(out, a.currency, owed);
  }
  return out;
}

/** A manually-entered asset or liability, already converted to minor units. */
export interface ManualHolding {
  id: string;
  name: string;
  /** Positive magnitude in minor units. */
  amount: Minor;
  currency: string;
  kind: "asset" | "liability";
}

export interface NetWorthResult {
  connectedAssets: MoneyByCurrency;
  connectedLiabilities: MoneyByCurrency;
  manualAssets: MoneyByCurrency;
  manualLiabilities: MoneyByCurrency;
  totalAssets: MoneyByCurrency;
  totalLiabilities: MoneyByCurrency;
  netWorth: MoneyByCurrency;
  /** Currencies present, so the UI knows whether one headline number is honest. */
  currencies: string[];
  /**
   * True when at least one connected account is excluded, hidden, or the app
   * cannot see every asset/liability the user owns. Drives the "Connected net
   * worth" label — we must not claim this is their whole financial picture.
   */
  isPartial: boolean;
  /** Manual holdings suppressed because a connected account represents them. */
  deduplicatedManualIds: string[];
  /** Oldest balance timestamp feeding the total — the honest "as of". */
  balanceAsOf: string | null;
}

/**
 * Net worth across connected AND manual records, with double counting removed.
 *
 * De-duplication rule: a connected account carrying `matchedProfileId` IS the
 * manual holding with that profile id. The connected balance wins (it is live);
 * the manual row is dropped from the total and reported in
 * `deduplicatedManualIds` so the UI can explain the omission.
 */
export function calculateNetWorth(
  accounts: FinancialAccountRecord[],
  manual: ManualHolding[] = [],
  scope: CalcScope = {},
): NetWorthResult {
  const visible = filterAccounts(accounts, scope, { netWorthOnly: true });

  const connectedAssets = calculateConnectedAssetTotal(accounts, scope);
  const connectedLiabilities = calculateConnectedLiabilityTotal(accounts, scope);

  // Any manual holding represented by a connected account is skipped.
  const matched = new Set(
    visible.map((a) => a.matchedProfileId).filter((id): id is string => !!id),
  );
  const deduplicatedManualIds: string[] = [];

  const manualAssets: MoneyByCurrency = {};
  const manualLiabilities: MoneyByCurrency = {};
  for (const m of manual) {
    if (matched.has(m.id)) { deduplicatedManualIds.push(m.id); continue; }
    if (scope.currency && (m.currency || "usd").toLowerCase() !== scope.currency.toLowerCase()) continue;
    const bucket = m.kind === "liability" ? manualLiabilities : manualAssets;
    addTo(bucket, m.currency, absMinor(m.amount));
  }

  const totalAssets: MoneyByCurrency = {};
  const totalLiabilities: MoneyByCurrency = {};
  for (const [c, v] of Object.entries(connectedAssets)) addTo(totalAssets, c, v);
  for (const [c, v] of Object.entries(manualAssets)) addTo(totalAssets, c, v);
  for (const [c, v] of Object.entries(connectedLiabilities)) addTo(totalLiabilities, c, v);
  for (const [c, v] of Object.entries(manualLiabilities)) addTo(totalLiabilities, c, v);

  const netWorth: MoneyByCurrency = {};
  const currencies = Array.from(
    new Set([...Object.keys(totalAssets), ...Object.keys(totalLiabilities)]),
  ).sort();
  for (const c of currencies) {
    netWorth[c] = (totalAssets[c] ?? 0) - (totalLiabilities[c] ?? 0);
  }

  // Oldest balance wins: a total is only as fresh as its stalest input.
  let balanceAsOf: string | null = null;
  for (const a of visible) {
    if (!a.balanceAsOf) continue;
    if (!balanceAsOf || a.balanceAsOf < balanceAsOf) balanceAsOf = a.balanceAsOf;
  }

  return {
    connectedAssets, connectedLiabilities,
    manualAssets, manualLiabilities,
    totalAssets, totalLiabilities, netWorth,
    currencies,
    // Always true. Portol only ever sees the accounts a user chose to link plus
    // what they typed in — never their complete financial position. The label
    // stays "Connected net worth" and the UI must not claim otherwise.
    isPartial: true,
    deduplicatedManualIds,
    balanceAsOf,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Cash flow
// ────────────────────────────────────────────────────────────────────────────

/** Money into the accounts over the scope. Positive magnitude. */
export function calculateInflows(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const t of filterTransactions(transactions, scope, confirmedTransferIds)) {
    if (t.amount > 0) addTo(out, t.currency, t.amount);
  }
  return out;
}

/** Money out of the accounts over the scope. Positive magnitude. */
export function calculateOutflows(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const t of filterTransactions(transactions, scope, confirmedTransferIds)) {
    if (t.amount < 0) addTo(out, t.currency, absMinor(t.amount));
  }
  return out;
}

export interface CashFlowResult {
  inflows: MoneyByCurrency;
  outflows: MoneyByCurrency;
  net: MoneyByCurrency;
  averageDailySpend: MoneyByCurrency;
  largestExpenses: FinancialTransactionRecord[];
  largestIncome: FinancialTransactionRecord[];
  dayCount: number;
  /** Transfers/uncertain rows deliberately left out, so the UI can say so. */
  excludedTransferCount: number;
  needsReviewCount: number;
}

export function calculateNetCashFlow(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  opts: {
    confirmedTransferIds?: ReadonlySet<string>;
    needsReviewIds?: ReadonlySet<string>;
    topN?: number;
  } = {},
): CashFlowResult {
  const confirmed = opts.confirmedTransferIds ?? new Set<string>();
  const rows = filterTransactions(transactions, scope, confirmed);
  const inflows = calculateInflows(transactions, scope, confirmed);
  const outflows = calculateOutflows(transactions, scope, confirmed);

  const net: MoneyByCurrency = {};
  for (const c of new Set([...Object.keys(inflows), ...Object.keys(outflows)])) {
    net[c] = (inflows[c] ?? 0) - (outflows[c] ?? 0);
  }

  const dayCount = countDays(scope, rows);
  const averageDailySpend: MoneyByCurrency = {};
  for (const [c, v] of Object.entries(outflows)) {
    averageDailySpend[c] = divideMinor(v, Math.max(dayCount, 1));
  }

  const topN = opts.topN ?? 5;
  const spends = rows.filter((t) => t.amount < 0 && !t.isRefund)
    .sort((a, b) => absMinor(b.amount) - absMinor(a.amount)).slice(0, topN);
  const incomes = rows.filter((t) => t.amount > 0 && !t.isRefund)
    .sort((a, b) => b.amount - a.amount).slice(0, topN);

  // How many rows we deliberately dropped, for the disclosure line.
  const allInWindow = filterTransactions(
    transactions, { ...scope, includeTransfers: true }, new Set(),
  );
  const excludedTransferCount = allInWindow.filter(
    (t) => t.isTransfer || confirmed.has(t.id),
  ).length;

  const needsReview = opts.needsReviewIds ?? new Set<string>();
  const needsReviewCount = allInWindow.filter((t) => needsReview.has(t.id)).length;

  return {
    inflows, outflows, net, averageDailySpend,
    largestExpenses: spends, largestIncome: incomes,
    dayCount, excludedTransferCount, needsReviewCount,
  };
}

function countDays(scope: CalcScope, rows: FinancialTransactionRecord[]): number {
  let start = scope.startDate;
  let end = scope.endDate;
  if (!start || !end) {
    for (const t of rows) {
      if (!start || t.transactionDate < start) start = t.transactionDate;
      if (!end || t.transactionDate > end) end = t.transactionDate;
    }
  }
  if (!start || !end) return 1;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return 1;
  return Math.floor(ms / 86_400_000) + 1;
}

// ────────────────────────────────────────────────────────────────────────────
// Spending & income breakdowns
// ────────────────────────────────────────────────────────────────────────────

export interface BreakdownRow {
  key: string;
  label: string;
  /** Positive magnitude, minor units. */
  amount: Minor;
  currency: string;
  count: number;
  /** Share of the currency's total, 0-100. Null when the total is zero. */
  sharePct: number | null;
}

/**
 * Rows that count as SPENDING.
 *
 * Excluded: refunds (money coming back is not spending), transfers between the
 * user's own accounts, credit-card payments matched to a card account, and
 * anything the user excluded by hand.
 */
function spendingRows(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope,
  confirmedTransferIds?: ReadonlySet<string>,
): FinancialTransactionRecord[] {
  return filterTransactions(transactions, scope, confirmedTransferIds)
    .filter((t) => t.amount < 0 && !t.isRefund && !t.isTransfer);
}

function toBreakdown(
  groups: Map<string, { label: string; byCurrency: Map<string, { amount: Minor; count: number }> }>,
): BreakdownRow[] {
  const totals = new Map<string, Minor>();
  for (const g of groups.values()) {
    for (const [c, v] of g.byCurrency) totals.set(c, (totals.get(c) ?? 0) + v.amount);
  }
  const rows: BreakdownRow[] = [];
  for (const [key, g] of groups) {
    for (const [currency, v] of g.byCurrency) {
      const total = totals.get(currency) ?? 0;
      rows.push({
        key, label: g.label, amount: v.amount, currency, count: v.count,
        sharePct: total === 0 ? null : (v.amount / total) * 100,
      });
    }
  }
  return rows.sort((a, b) => b.amount - a.amount);
}

function groupBy(
  rows: FinancialTransactionRecord[],
  keyOf: (t: FinancialTransactionRecord) => { key: string; label: string },
): BreakdownRow[] {
  const groups = new Map<string, { label: string; byCurrency: Map<string, { amount: Minor; count: number }> }>();
  for (const t of rows) {
    const { key, label } = keyOf(t);
    let g = groups.get(key);
    if (!g) { g = { label, byCurrency: new Map() }; groups.set(key, g); }
    const currency = (t.currency || "usd").toLowerCase();
    const cell = g.byCurrency.get(currency) ?? { amount: 0, count: 0 };
    cell.amount += absMinor(t.amount);
    cell.count += 1;
    g.byCurrency.set(currency, cell);
  }
  return toBreakdown(groups);
}

export function calculateSpendingByCategory(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): BreakdownRow[] {
  return groupBy(spendingRows(transactions, scope, confirmedTransferIds), (t) => ({
    key: t.category || "uncategorized",
    label: t.category || "Uncategorized",
  }));
}

export function calculateSpendingByMerchant(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): BreakdownRow[] {
  return groupBy(spendingRows(transactions, scope, confirmedTransferIds), (t) => {
    const name = t.merchantName || t.description || "Unknown";
    return { key: name.toLowerCase(), label: name };
  });
}

export function calculateSpendingByAccount(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): BreakdownRow[] {
  return groupBy(spendingRows(transactions, scope, confirmedTransferIds), (t) => ({
    key: t.financialAccountId,
    label: t.accountName || "Account",
  }));
}

/** Spending bucketed by ISO week (Monday-anchored) or calendar month. */
export function calculateSpendingByPeriod(
  transactions: FinancialTransactionRecord[],
  period: "week" | "month",
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): BreakdownRow[] {
  return groupBy(spendingRows(transactions, scope, confirmedTransferIds), (t) => {
    const key = period === "month" ? t.transactionDate.slice(0, 7) : isoWeekKey(t.transactionDate);
    return { key, label: key };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

function isoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  // Shift to the Thursday of this week; its year is the ISO week-year.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Income by source.
 *
 * Deliberately NOT "every positive amount". A deposit is only income when it
 * is not a transfer, not a refund and not a reversal. Positive rows we are not
 * confident about land in `needsReview` for the user to classify.
 */
export interface IncomeResult {
  bySource: BreakdownRow[];
  total: MoneyByCurrency;
  needsReview: FinancialTransactionRecord[];
}

const REFUND_HINT = /\b(refund|reversal|returned|return|chargeback|credit adj|adjustment|rebate|reimburse\w*)\b/i;
const INCOME_HINT = /\b(payroll|salary|direct dep|direct deposit|dep\b|paycheck|payout|dividend|interest|pension|annuity|benefit|invoice|deposit from)\b/i;

export function calculateIncomeBySource(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  confirmedTransferIds?: ReadonlySet<string>,
): IncomeResult {
  const rows = filterTransactions(transactions, scope, confirmedTransferIds)
    .filter((t) => t.amount > 0);

  const income: FinancialTransactionRecord[] = [];
  const needsReview: FinancialTransactionRecord[] = [];

  for (const t of rows) {
    if (t.isTransfer || t.isRefund) continue;               // never income
    if (t.override?.isIncome === true) { income.push(t); continue; }
    if (t.override?.isIncome === false) continue;           // user said no
    const text = `${t.merchantName || ""} ${t.description || ""}`;
    if (REFUND_HINT.test(text)) { needsReview.push(t); continue; }
    if (t.isIncome || INCOME_HINT.test(text)) { income.push(t); continue; }
    // A positive amount with no supporting signal is exactly the case the spec
    // says not to guess at.
    needsReview.push(t);
  }

  const total: MoneyByCurrency = {};
  for (const t of income) addTo(total, t.currency, t.amount);

  const bySource = groupBy(income, (t) => {
    const name = t.merchantName || t.description || "Unknown source";
    return { key: name.toLowerCase(), label: name };
  });

  return { bySource, total, needsReview };
}

// ────────────────────────────────────────────────────────────────────────────
// Period comparison
// ────────────────────────────────────────────────────────────────────────────

export interface MonthlyComparison {
  current: { start: string; end: string; spending: MoneyByCurrency; income: MoneyByCurrency };
  previous: { start: string; end: string; spending: MoneyByCurrency; income: MoneyByCurrency };
  /** Percent change per currency. Null where the previous period was zero. */
  spendingChangePct: Record<string, number | null>;
  incomeChangePct: Record<string, number | null>;
  /** True when `current` has not finished yet — the comparison is not like-for-like. */
  currentPeriodIncomplete: boolean;
}

export function calculateMonthlyComparison(
  transactions: FinancialTransactionRecord[],
  month: string, // YYYY-MM
  scope: CalcScope = {},
  opts: { confirmedTransferIds?: ReadonlySet<string>; today?: string } = {},
): MonthlyComparison {
  const cur = monthBounds(month);
  const prev = monthBounds(previousMonth(month));
  const confirmed = opts.confirmedTransferIds;

  const curSpend = sumSpending(transactions, { ...scope, ...cur }, confirmed);
  const prevSpend = sumSpending(transactions, { ...scope, ...prev }, confirmed);
  const curIncome = calculateIncomeBySource(transactions, { ...scope, ...cur }, confirmed).total;
  const prevIncome = calculateIncomeBySource(transactions, { ...scope, ...prev }, confirmed).total;

  const spendingChangePct: Record<string, number | null> = {};
  for (const c of new Set([...Object.keys(curSpend), ...Object.keys(prevSpend)])) {
    spendingChangePct[c] = percentChange(curSpend[c] ?? 0, prevSpend[c] ?? 0);
  }
  const incomeChangePct: Record<string, number | null> = {};
  for (const c of new Set([...Object.keys(curIncome), ...Object.keys(prevIncome)])) {
    incomeChangePct[c] = percentChange(curIncome[c] ?? 0, prevIncome[c] ?? 0);
  }

  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  return {
    current: { ...cur, spending: curSpend, income: curIncome },
    previous: { ...prev, spending: prevSpend, income: prevIncome },
    spendingChangePct, incomeChangePct,
    currentPeriodIncomplete: today <= cur.end,
  };
}

function sumSpending(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope,
  confirmedTransferIds?: ReadonlySet<string>,
): MoneyByCurrency {
  const out: MoneyByCurrency = {};
  for (const t of spendingRows(transactions, scope, confirmedTransferIds)) {
    addTo(out, t.currency, absMinor(t.amount));
  }
  return out;
}

export function monthBounds(month: string): { startDate: string; endDate: string; start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { startDate: start, endDate: end, start, end };
}

export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Transfer detection — conservative by design
// ────────────────────────────────────────────────────────────────────────────

export interface TransferCandidate {
  outflowId: string;
  inflowId: string;
  /** 0..1. Only >= AUTO_CONFIRM_CONFIDENCE is applied to totals automatically. */
  confidence: number;
  signals: {
    amountMatch: boolean;
    withinDays: number;
    descriptionHint: boolean;
    creditCardPayment: boolean;
    sameCurrency: boolean;
  };
}

/** Above this, a detected transfer is trustworthy enough to exclude on its own. */
export const AUTO_CONFIRM_CONFIDENCE = 0.9;

const TRANSFER_HINT = /\b(transfer|xfer|zelle|venmo|wire|ach|online (banking )?(transfer|payment)|to savings|from savings|internal|move money)\b/i;
const CARD_PAYMENT_HINT = /\b(payment|pmt|autopay|auto pay|epay|e-pay|bill pay|card payment|thank you)\b/i;

/**
 * Find likely movements between the user's OWN accounts.
 *
 * Deliberately conservative: it never merges rows, never deletes a side, and
 * anything below AUTO_CONFIRM_CONFIDENCE is a suggestion the user must accept.
 * Every pair keeps both original records; the link is a separate row.
 *
 * @param windowDays  how far apart the two legs may be dated (default 4)
 * @param toleranceMinor  allowed difference between the legs, for wire fees
 */
export function detectLikelyTransfers(
  transactions: FinancialTransactionRecord[],
  accounts: FinancialAccountRecord[] = [],
  opts: { windowDays?: number; toleranceMinor?: number } = {},
): TransferCandidate[] {
  const windowDays = opts.windowDays ?? 4;
  const tolerance = opts.toleranceMinor ?? 0;

  const accountType = new Map(accounts.map((a) => [a.id, a.accountType]));

  const outflows = transactions.filter((t) => t.amount < 0 && t.status !== "void" && !t.isDuplicate);
  const inflows = transactions.filter((t) => t.amount > 0 && t.status !== "void" && !t.isDuplicate);

  const used = new Set<string>();
  const candidates: TransferCandidate[] = [];

  // Deterministic order so the same data always yields the same pairing.
  const sortedOut = [...outflows].sort(
    (a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.id.localeCompare(b.id),
  );

  for (const out of sortedOut) {
    let best: { inflow: FinancialTransactionRecord; candidate: TransferCandidate } | null = null;

    for (const inf of inflows) {
      if (used.has(inf.id)) continue;
      // Same account cannot transfer to itself.
      if (inf.financialAccountId === out.financialAccountId) continue;

      const sameCurrency = (inf.currency || "usd").toLowerCase() === (out.currency || "usd").toLowerCase();
      if (!sameCurrency) continue; // no FX conversion — never guess across currencies

      const amountMatch = withinTolerance(absMinor(out.amount), absMinor(inf.amount), tolerance);
      if (!amountMatch) continue;

      const dayGap = daysBetween(out.transactionDate, inf.transactionDate);
      if (dayGap > windowDays) continue;

      const text = `${out.description || ""} ${out.merchantName || ""} ${inf.description || ""} ${inf.merchantName || ""}`;
      const descriptionHint = TRANSFER_HINT.test(text);

      // A payment leaving a bank account and landing on a credit card is the
      // classic case that must never count as spending.
      const creditCardPayment =
        accountType.get(inf.financialAccountId) === "credit" &&
        accountType.get(out.financialAccountId) === "depository" &&
        CARD_PAYMENT_HINT.test(text);

      // Confidence: an exact same-day amount match between two of the user's
      // own accounts is already strong; wording and card-payment shape add to it.
      let confidence = 0.6;
      if (dayGap === 0) confidence += 0.15;
      else if (dayGap <= 2) confidence += 0.08;
      if (descriptionHint) confidence += 0.15;
      if (creditCardPayment) confidence += 0.2;
      if (absMinor(out.amount) === absMinor(inf.amount)) confidence += 0.05;
      confidence = Math.min(confidence, 0.99);

      const candidate: TransferCandidate = {
        outflowId: out.id,
        inflowId: inf.id,
        confidence: Number(confidence.toFixed(3)),
        signals: { amountMatch, withinDays: dayGap, descriptionHint, creditCardPayment, sameCurrency },
      };
      if (!best || candidate.confidence > best.candidate.confidence) best = { inflow: inf, candidate };
    }

    if (best) {
      used.add(best.inflow.id);
      candidates.push(best.candidate);
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : Number.MAX_SAFE_INTEGER;
}

// ────────────────────────────────────────────────────────────────────────────
// Recurring detection
// ────────────────────────────────────────────────────────────────────────────

export interface RecurringGroup {
  key: string;
  merchantName: string;
  /** Typical (median) magnitude, minor units. */
  typicalAmount: Minor;
  currency: string;
  /** Median days between occurrences. */
  intervalDays: number;
  cadence: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "irregular";
  occurrences: number;
  lastDate: string;
  nextExpectedDate: string | null;
  direction: "expense" | "income";
  transactionIds: string[];
  /** 0..1 — how regular the interval and amount are. */
  confidence: number;
}

/**
 * Group transactions that look like a subscription / salary / recurring bill.
 *
 * Requires at least three occurrences: two points can be a coincidence, three
 * is a pattern. Never creates a Portol subscription or liability by itself —
 * the UI offers "Save as subscription" and the user decides.
 */
export function detectLikelyRecurringTransactions(
  transactions: FinancialTransactionRecord[],
  opts: { minOccurrences?: number; amountTolerancePct?: number } = {},
): RecurringGroup[] {
  const minOccurrences = opts.minOccurrences ?? 3;
  const tolerancePct = opts.amountTolerancePct ?? 15;

  const byMerchant = new Map<string, FinancialTransactionRecord[]>();
  for (const t of transactions) {
    if (t.status === "void" || t.isDuplicate || t.excludedFromTotals) continue;
    const name = (t.merchantName || t.description || "").trim();
    if (!name) continue;
    const key = `${normalizeMerchant(name)}|${(t.currency || "usd").toLowerCase()}|${t.amount < 0 ? "out" : "in"}`;
    const list = byMerchant.get(key) ?? [];
    list.push(t);
    byMerchant.set(key, list);
  }

  const groups: RecurringGroup[] = [];
  for (const [key, all] of byMerchant) {
    if (all.length < minOccurrences) continue;
    const sorted = [...all].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

    // Amounts must cluster — a merchant you visit at random prices is not a
    // recurring charge.
    const amounts = sorted.map((t) => absMinor(t.amount)).sort((a, b) => a - b);
    const typical = amounts[Math.floor(amounts.length / 2)];
    if (typical === 0) continue;
    const consistent = sorted.filter(
      (t) => Math.abs(absMinor(t.amount) - typical) <= (typical * tolerancePct) / 100,
    );
    if (consistent.length < minOccurrences) continue;

    const gaps: number[] = [];
    for (let i = 1; i < consistent.length; i++) {
      gaps.push(daysBetween(consistent[i - 1].transactionDate, consistent[i].transactionDate));
    }
    if (gaps.length === 0) continue;
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const intervalDays = sortedGaps[Math.floor(sortedGaps.length / 2)];
    if (intervalDays < 5 || intervalDays > 400) continue;

    // Regularity: how tightly the gaps cluster around the median.
    const spread = gaps.reduce((s, g) => s + Math.abs(g - intervalDays), 0) / gaps.length;
    const regularity = Math.max(0, 1 - spread / Math.max(intervalDays, 1));
    const confidence = Number(Math.min(0.99, 0.5 + regularity * 0.4 + Math.min(consistent.length, 6) * 0.02).toFixed(3));
    if (confidence < 0.55) continue;

    const last = consistent[consistent.length - 1];
    groups.push({
      key,
      merchantName: last.merchantName || last.description || "Unknown",
      typicalAmount: typical,
      currency: (last.currency || "usd").toLowerCase(),
      intervalDays,
      cadence: cadenceFor(intervalDays),
      occurrences: consistent.length,
      lastDate: last.transactionDate,
      nextExpectedDate: addDays(last.transactionDate, intervalDays),
      direction: last.amount < 0 ? "expense" : "income",
      transactionIds: consistent.map((t) => t.id),
      confidence,
    });
  }

  return groups.sort((a, b) => b.confidence - a.confidence || b.typicalAmount - a.typicalAmount);
}

function cadenceFor(days: number): RecurringGroup["cadence"] {
  if (days >= 6 && days <= 8) return "weekly";
  if (days >= 12 && days <= 16) return "biweekly";
  if (days >= 27 && days <= 34) return "monthly";
  if (days >= 85 && days <= 95) return "quarterly";
  if (days >= 355 && days <= 375) return "yearly";
  return "irregular";
}

function addDays(date: string, days: number): string | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** Strip the noise institutions append so "AMZN Mktp US*2K4" groups with itself. */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#*]\s*\w+/g, " ")          // reference codes
    .replace(/\b\d{4,}\b/g, " ")          // long digit runs
    .replace(/\b(purchase|pos|debit|card|payment|recurring|autopay)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

// ────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ────────────────────────────────────────────────────────────────────────────

export interface DuplicateCandidate {
  keepId: string;
  duplicateId: string;
  reason: "same_stripe_id" | "same_amount_date_merchant";
  confidence: number;
}

/**
 * Flag rows that look like the same real-world transaction imported twice.
 *
 * Nothing is deleted — the caller marks `is_duplicate` so totals skip it while
 * the record stays auditable. Stripe ids are unique by construction, so the
 * interesting case is the same amount, date and merchant on one account, which
 * genuinely happens when an institution re-issues a pending row as posted.
 */
export function detectPossibleDuplicates(
  transactions: FinancialTransactionRecord[],
): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  const seenStripe = new Map<string, string>();
  const seenShape = new Map<string, FinancialTransactionRecord>();

  const sorted = [...transactions].sort(
    (a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.id.localeCompare(b.id),
  );

  for (const t of sorted) {
    if (t.stripeTransactionId) {
      const stripeKey = `${t.financialAccountId}|${t.stripeTransactionId}`;
      const prior = seenStripe.get(stripeKey);
      if (prior) { out.push({ keepId: prior, duplicateId: t.id, reason: "same_stripe_id", confidence: 1 }); continue; }
      seenStripe.set(stripeKey, t.id);
    }

    const shape = [
      t.financialAccountId,
      t.transactionDate,
      String(t.amount),
      normalizeMerchant(t.merchantName || t.description || ""),
    ].join("|");
    const prior = seenShape.get(shape);
    if (prior) {
      // A pending row superseded by its posted twin is the common case; keep
      // the posted one.
      const keep = prior.status === "posted" ? prior : t;
      const dup = keep === prior ? t : prior;
      out.push({ keepId: keep.id, duplicateId: dup.id, reason: "same_amount_date_merchant", confidence: 0.8 });
    } else {
      seenShape.set(shape, t);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Unusual spending
// ────────────────────────────────────────────────────────────────────────────

export interface UnusualSpend {
  transaction: FinancialTransactionRecord;
  /** How many times the category's typical charge this one is. */
  multiple: number;
  categoryMedian: Minor;
}

/**
 * Charges far above the usual for their category. Median-based, so one huge
 * outlier cannot raise the bar and hide the next one.
 */
export function detectUnusualSpending(
  transactions: FinancialTransactionRecord[],
  scope: CalcScope = {},
  opts: { multiple?: number; minSamples?: number } = {},
): UnusualSpend[] {
  const threshold = opts.multiple ?? 3;
  const minSamples = opts.minSamples ?? 4;
  const rows = spendingRows(transactions, scope);

  const byCategory = new Map<string, Minor[]>();
  for (const t of rows) {
    const key = t.category || "uncategorized";
    const list = byCategory.get(key) ?? [];
    list.push(absMinor(t.amount));
    byCategory.set(key, list);
  }

  const out: UnusualSpend[] = [];
  for (const t of rows) {
    const key = t.category || "uncategorized";
    const list = byCategory.get(key)!;
    if (list.length < minSamples) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median === 0) continue;
    const multiple = absMinor(t.amount) / median;
    if (multiple >= threshold) {
      out.push({ transaction: t, multiple: Number(multiple.toFixed(2)), categoryMedian: median });
    }
  }
  return out.sort((a, b) => b.multiple - a.multiple);
}

// ────────────────────────────────────────────────────────────────────────────
// Freshness
// ────────────────────────────────────────────────────────────────────────────

/**
 * The honest "as of" for a set of accounts: the OLDEST balance timestamp, since
 * a summary is only as current as its least fresh input.
 */
export function dataFreshness(accounts: FinancialAccountRecord[]): {
  oldest: string | null; newest: string | null; staleAccountIds: string[];
} {
  let oldest: string | null = null;
  let newest: string | null = null;
  const staleAccountIds: string[] = [];
  const dayAgo = new Date(Date.now() - 36 * 3_600_000).toISOString();
  for (const a of accounts) {
    if (!a.balanceAsOf) { staleAccountIds.push(a.id); continue; }
    if (!oldest || a.balanceAsOf < oldest) oldest = a.balanceAsOf;
    if (!newest || a.balanceAsOf > newest) newest = a.balanceAsOf;
    if (a.balanceAsOf < dayAgo) staleAccountIds.push(a.id);
  }
  return { oldest, newest, staleAccountIds };
}

export { sumMinor, toMinor, absMinor };
