// Financial accounts — the manual side of the money model.
//
// An account is a `type: "account"` PROFILE. It is not a new table and not a
// parallel universe: making it a profile is what gets it net worth, the profile
// filter, ownership links, nesting under a person, linked expenses / incomes /
// transactions, documents and the AI's entity resolution for free, all through
// machinery that already exists and is already the app's source of truth.
//
// This module owns the account SHAPE on top of that: which kinds exist, where
// the balance lives, how available balance and credit limits behave, and how a
// manual balance adjustment is recorded so the history survives.
//
// CANONICAL FIELD LAYOUT (`profile.fields`):
//   accountKind      "checking" | "savings" | … (see shared/account-kinds.ts)
//   institution      "Chase"
//   balance          number — ALWAYS the magnitude, never signed.
//   currentBalance   mirror of `balance` (what resolveLiabilityBalance reads)
//   availableBalance number, when the kind supports it
//   creditLimit      number, credit_card / line_of_credit only
//   accountNumberLast4
//   balanceAsOf      YYYY-MM-DD — when the balance was last true
//   balanceHistory   BalanceAdjustment[] — every manual correction, newest last
//   currency         "usd"
//
// SIGN CONVENTION: `balance` is stored as a positive magnitude for every kind,
// exactly like the rest of the manual finance model (a mortgage profile stores
// 410000, not -410000). `accountSignedBalance()` is the ONLY place that applies
// the debt sign, so nothing downstream has to remember the rule.

import { parseMoney } from "./asset-value";
import {
  ACCOUNT_KINDS, accountKindMeta, accountKindOf, isDebtAccount, isDebtAccountKind,
  normalizeAccountKind, type AccountKind, type AccountKindMeta,
} from "./account-kinds";

// Re-exported so callers have ONE import for the whole accounts model.
export {
  ACCOUNT_KINDS, accountKindMeta, accountKindOf, isDebtAccount, isDebtAccountKind,
  normalizeAccountKind, type AccountKind, type AccountKindMeta,
};

/**
 * True when this profile is a financial account.
 *
 * `type: "investment"` counts. A Roth IRA, a 401(k) and a brokerage ARE
 * accounts — the user says "I have a Roth IRA with $50,000 in it" and expects
 * it under Accounts. The app has always had a separate `investment` type and
 * the AI reaches for it, so an accounts list that only accepted
 * `type: "account"` reported "No accounts yet" while the account sat one tab
 * away. Both types are cash-side assets, so nothing about the balance sheet
 * changes — this only decides which list shows the row.
 */
export function isAccountProfile(p: any): boolean {
  const t = String(p?.type ?? "");
  return !!p && (t === "account" || t === "investment");
}

/** Strictly `type: "account"` — for code that must not sweep in investments. */
export function isAccountTypeProfile(p: any): boolean {
  return !!p && String(p.type) === "account";
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = parseMoney(v);
  return Number.isFinite(n) ? n : null;
};

function fieldsOf(input: any): Record<string, any> {
  if (!input || typeof input !== "object") return {};
  if ("fields" in input && input.fields && typeof input.fields === "object") return input.fields;
  return input;
}

/** The account's balance as a POSITIVE magnitude, whichever key it was saved under. */
export function resolveAccountBalance(input: any): number {
  const f = fieldsOf(input);
  const candidates = [
    // Account-canonical first: `balance` is what createAccount writes.
    f.balance, f.currentBalance, f.current_balance,
    f.accountBalance, f.account_balance,
    // Then the asset-value keys. An investment/brokerage profile created
    // outside the accounts form (the AI's create_profile path, an import)
    // keeps its money in `currentValue` — reading only the account keys
    // showed a $50,000 Roth IRA as $0.
    f.currentValue, f.current_value, f.marketValue, f.market_value,
    f.estimatedValue, f.estimated_value,
    f.amount, f.value,
  ];
  for (const c of candidates) {
    const n = numOrNull(c);
    if (n != null && n !== 0) return Math.abs(n);
  }
  // An account genuinely at zero is a real state — don't fall through to 0 by
  // accident, return it once we've confirmed a zero was actually written.
  for (const c of candidates) {
    if (numOrNull(c) === 0) return 0;
  }
  return 0;
}

/**
 * Balance signed for the balance sheet: positive for money held, NEGATIVE for
 * money owed. The one place the debt sign is applied.
 */
export function accountSignedBalance(input: any): number {
  const bal = resolveAccountBalance(input);
  return isDebtAccountKind(accountKindOf(input)) ? -bal : bal;
}

/** Available balance (spendable cash, or remaining credit), when meaningful. */
export function accountAvailableBalance(input: any): number | null {
  const f = fieldsOf(input);
  const kind = accountKindOf(input);
  const explicit = numOrNull(f.availableBalance ?? f.available_balance ?? f.available);
  if (explicit != null) return Math.abs(explicit);
  // A credit line's available credit is derivable and always right, so derive
  // it rather than showing nothing.
  const limit = accountCreditLimit(input);
  if (limit != null && accountKindMeta(kind).supportsCreditLimit) {
    return round2(Math.max(0, limit - resolveAccountBalance(input)));
  }
  return null;
}

export function accountCreditLimit(input: any): number | null {
  const f = fieldsOf(input);
  if (!accountKindMeta(accountKindOf(input)).supportsCreditLimit) return null;
  const n = numOrNull(f.creditLimit ?? f.credit_limit ?? f.limit);
  return n != null ? Math.abs(n) : null;
}

/** Percentage of the credit line in use (0–100+), or null when not applicable. */
export function accountUtilization(input: any): number | null {
  const limit = accountCreditLimit(input);
  if (limit == null || limit <= 0) return null;
  return round2((resolveAccountBalance(input) / limit) * 100);
}

export function accountInstitution(input: any): string | null {
  const f = fieldsOf(input);
  const v = f.institution ?? f.institutionName ?? f.institution_name ?? f.bank ?? f.provider ?? f.lender;
  return v ? String(v) : null;
}

export function accountLastFour(input: any): string | null {
  const f = fieldsOf(input);
  const v = f.accountNumberLast4 ?? f.account_number_last4 ?? f.lastFour ?? f.last_four ?? f.last4;
  return v ? String(v).slice(-4) : null;
}

/** When the balance was last known to be true (YYYY-MM-DD), or null. */
export function accountBalanceAsOf(input: any): string | null {
  const f = fieldsOf(input);
  const v = f.balanceAsOf ?? f.balance_as_of ?? f.lastUpdated ?? f.last_updated ?? f.asOf;
  const s = String(v ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function accountCurrency(input: any): string {
  const f = fieldsOf(input);
  return String(f.currency ?? "usd").toLowerCase();
}

/** True when the account should be left out of rollups (closed, hidden, duplicate). */
export function accountIsExcluded(input: any): boolean {
  const f = fieldsOf(input);
  if (f.includeInNetWorth === false || f.include_in_net_worth === false) return true;
  if (f.hidden === true || f.isHidden === true) return true;
  const status = String(f.status ?? "").toLowerCase();
  return status === "closed" || status === "archived";
}

// ─── Manual balance adjustments ──────────────────────────────────────────────

export interface BalanceAdjustment {
  id: string;
  /** YYYY-MM-DD the adjustment was effective. */
  date: string;
  /** Balance BEFORE the adjustment. */
  previousBalance: number;
  /** Balance AFTER the adjustment. */
  newBalance: number;
  /** newBalance − previousBalance. Negative when the balance fell. */
  delta: number;
  reason?: string;
  source?: "user" | "ai" | "payment" | "import" | "system";
  /** Set when the adjustment came from a specific record (a liability payment). */
  linkedRecordId?: string;
  createdAt: string;
}

export function balanceHistory(input: any): BalanceAdjustment[] {
  const f = fieldsOf(input);
  const raw = f.balanceHistory ?? f.balance_history;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a: any) => a && typeof a === "object")
    .map((a: any, i: number) => ({
      id: String(a.id ?? `adj-${i}`),
      date: String(a.date ?? "").slice(0, 10),
      previousBalance: Number(a.previousBalance ?? a.previous_balance ?? 0) || 0,
      newBalance: Number(a.newBalance ?? a.new_balance ?? 0) || 0,
      delta: Number(a.delta ?? 0) || 0,
      reason: a.reason ? String(a.reason) : undefined,
      source: a.source,
      linkedRecordId: a.linkedRecordId ?? a.linked_record_id ?? undefined,
      createdAt: String(a.createdAt ?? a.created_at ?? ""),
    }));
}

export interface AdjustBalanceInput {
  /** Set the balance to this exact figure. */
  newBalance?: number | null;
  /** Or move it by this much (positive = up). Ignored when newBalance is given. */
  delta?: number | null;
  date?: string | null;
  reason?: string | null;
  source?: BalanceAdjustment["source"];
  linkedRecordId?: string | null;
}

/**
 * Compute the `fields` patch for a manual balance adjustment.
 *
 * Pure: returns what to write, writes nothing. Records the before/after pair in
 * `balanceHistory` so "why is this $40 lower than last week" is answerable
 * without a separate ledger table, and stamps `balanceAsOf` so the UI can say
 * how stale a balance is.
 */
export function applyBalanceAdjustment(
  profile: any,
  input: AdjustBalanceInput,
  todayISO: string,
): { fields: Record<string, any>; adjustment: BalanceAdjustment } {
  const previous = resolveAccountBalance(profile);
  const explicit = input.newBalance == null ? null : Number(input.newBalance);
  const delta = input.delta == null ? null : Number(input.delta);
  const next = explicit != null && Number.isFinite(explicit)
    ? round2(explicit)
    : round2(previous + (Number.isFinite(delta as number) ? (delta as number) : 0));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date ?? "")) ? String(input.date).slice(0, 10) : todayISO;

  const adjustment: BalanceAdjustment = {
    id: `adj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    date,
    previousBalance: round2(previous),
    newBalance: next,
    delta: round2(next - previous),
    ...(input.reason ? { reason: String(input.reason) } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.linkedRecordId ? { linkedRecordId: String(input.linkedRecordId) } : {}),
    createdAt: new Date().toISOString(),
  };

  const history = [...balanceHistory(profile), adjustment].slice(-200);
  return {
    fields: {
      ...balanceFieldsFor(profile, next),
      balanceAsOf: date,
      balanceHistory: history,
    },
    adjustment,
  };
}

/**
 * The `fields` patch that sets an account's balance EVERYWHERE it is read.
 *
 * This exists because writing one key is not enough, and getting that wrong is
 * invisible until the numbers disagree on screen:
 *
 *   resolveAssetValue     reads `fields.currentValue` FIRST, then marketValue,
 *                         then value, and only then `fields.balance`.
 *   resolveLiabilityBalance reads `fields.currentBalance` FIRST, then balance.
 *
 * An investment profile created outside the accounts form keeps its money in
 * `currentValue`. Writing only `balance` therefore updated the Accounts list
 * while the Assets card and Net Worth went on reading the stale `currentValue`
 * — the same account showing $53,000 in one tab and $50,000 in another, for
 * good. Setting the FIRST candidate of each resolver is what makes the write
 * reach every reader.
 *
 * A debt account deliberately gets no `currentValue`: that key means "what this
 * is worth", and a credit card balance is not an asset.
 */
export function balanceFieldsFor(profile: any, amount: number): Record<string, any> {
  const value = round2(Math.abs(Number(amount) || 0));
  const isDebt = isDebtAccountKind(accountKindOf(profile));
  return {
    balance: value,
    currentBalance: value,
    ...(isDebt ? {} : { currentValue: value }),
  };
}

// ─── Rollups ─────────────────────────────────────────────────────────────────

export interface AccountSummary {
  /** Liquid cash: checking + savings + cash. */
  cash: number;
  /** Investment / brokerage balances. */
  investments: number;
  /** Credit card + line-of-credit balances owed (positive number). */
  creditDebt: number;
  /** Loan account balances owed (positive number). */
  loanDebt: number;
  /** Everything not in another bucket, signed. */
  other: number;
  /** cash + investments + other-assets. */
  totalAssets: number;
  /** creditDebt + loanDebt + other-debts. */
  totalDebt: number;
  /** totalAssets − totalDebt. */
  net: number;
  /** Remaining credit across all credit lines, when limits are known. */
  availableCredit: number | null;
  count: number;
}

const EMPTY_SUMMARY: AccountSummary = {
  cash: 0, investments: 0, creditDebt: 0, loanDebt: 0, other: 0,
  totalAssets: 0, totalDebt: 0, net: 0, availableCredit: null, count: 0,
};

/** Roll a set of account profiles into the Accounts header figures. */
export function summarizeAccounts(profiles: readonly any[]): AccountSummary {
  const accounts = (profiles || []).filter((p) => isAccountProfile(p) && !accountIsExcluded(p));
  if (accounts.length === 0) return { ...EMPTY_SUMMARY };

  const out: AccountSummary = { ...EMPTY_SUMMARY, count: accounts.length };
  let limitSeen = false;
  let availableCredit = 0;

  for (const a of accounts) {
    const kind = accountKindOf(a);
    const meta = accountKindMeta(kind);
    const bal = resolveAccountBalance(a);
    switch (meta.group) {
      case "cash": out.cash += bal; break;
      case "investment": out.investments += bal; break;
      case "credit": out.creditDebt += bal; break;
      case "loan": out.loanDebt += bal; break;
      default: out.other += meta.side === "debt" ? -bal : bal; break;
    }
    const limit = accountCreditLimit(a);
    if (limit != null) {
      limitSeen = true;
      availableCredit += Math.max(0, limit - bal);
    }
  }

  out.cash = round2(out.cash);
  out.investments = round2(out.investments);
  out.creditDebt = round2(out.creditDebt);
  out.loanDebt = round2(out.loanDebt);
  out.other = round2(out.other);
  out.totalAssets = round2(out.cash + out.investments + Math.max(0, out.other));
  out.totalDebt = round2(out.creditDebt + out.loanDebt + Math.max(0, -out.other));
  out.net = round2(out.totalAssets - out.totalDebt);
  out.availableCredit = limitSeen ? round2(availableCredit) : null;
  return out;
}

/** A display-ready view of one account, so every surface renders it identically. */
export interface AccountView {
  id: string;
  name: string;
  kind: AccountKind;
  kindLabel: string;
  group: AccountKindMeta["group"];
  isDebt: boolean;
  institution: string | null;
  lastFour: string | null;
  balance: number;
  signedBalance: number;
  availableBalance: number | null;
  creditLimit: number | null;
  utilization: number | null;
  balanceAsOf: string | null;
  currency: string;
  excluded: boolean;
  /** Owner/parent profile this account is nested under, when set. */
  ownerProfileId: string | null;
  adjustments: BalanceAdjustment[];
  profile: any;
}

export function toAccountView(p: any): AccountView {
  const kind = accountKindOf(p);
  const meta = accountKindMeta(kind);
  return {
    id: String(p?.id ?? ""),
    name: String(p?.name ?? "Account"),
    kind,
    kindLabel: meta.label,
    group: meta.group,
    isDebt: meta.side === "debt",
    institution: accountInstitution(p),
    lastFour: accountLastFour(p),
    balance: resolveAccountBalance(p),
    signedBalance: accountSignedBalance(p),
    availableBalance: accountAvailableBalance(p),
    creditLimit: accountCreditLimit(p),
    utilization: accountUtilization(p),
    balanceAsOf: accountBalanceAsOf(p),
    currency: accountCurrency(p),
    excluded: accountIsExcluded(p),
    ownerProfileId: p?.parentProfileId ?? null,
    adjustments: balanceHistory(p),
    profile: p,
  };
}

/** Every account profile in a set, as views, ordered assets-first then by size. */
export function accountViews(profiles: readonly any[]): AccountView[] {
  return (profiles || [])
    .filter(isAccountProfile)
    .map(toAccountView)
    .sort((a, b) => {
      if (a.isDebt !== b.isDebt) return a.isDebt ? 1 : -1;
      return b.balance - a.balance || a.name.localeCompare(b.name);
    });
}

/**
 * Match a user-typed account reference ("checking", "my Chase card", "Amex") to
 * one account. Returns null rather than guessing when nothing is close — the
 * AI must ask instead of paying a bill from the wrong account.
 */
export function findAccount(profiles: readonly any[], query: string | null | undefined): any | null {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  const accounts = (profiles || []).filter(isAccountProfile);
  if (accounts.length === 0) return null;

  const byName = accounts.find((a) => String(a.name ?? "").toLowerCase() === q);
  if (byName) return byName;
  const contains = accounts.filter((a) => String(a.name ?? "").toLowerCase().includes(q));
  if (contains.length === 1) return contains[0];
  const institution = accounts.filter((a) => (accountInstitution(a) ?? "").toLowerCase().includes(q));
  if (institution.length === 1) return institution[0];
  // "checking" / "savings" / "credit card" as a kind word, when unambiguous.
  const kind = normalizeAccountKind(q);
  if (kind !== "other") {
    const byKind = accounts.filter((a) => accountKindOf(a) === kind);
    if (byKind.length === 1) return byKind[0];
  }
  return contains[0] ?? null;
}

/**
 * Repair an account whose balance keys have already drifted apart.
 *
 * The fix above stops NEW drift, but a row written before it still carries a
 * fresh `balance` beside a stale `currentValue` — and the user is looking at
 * that row right now, seeing $53,000 in Finance and $50,000 in Assets. Telling
 * them to edit it again to heal it is not an answer.
 *
 * `balance` is authoritative here, and only when `balanceHistory` proves it was
 * deliberately set (an adjustment ran). Returns the patch to write, or null
 * when nothing is wrong — so the caller writes only for genuinely broken rows
 * and this is a no-op on every healthy one.
 */
export function reconcileAccountBalanceFields(profile: any): Record<string, any> | null {
  if (!isAccountProfile(profile)) return null;
  const f = fieldsOf(profile);
  // No recorded adjustment means `balance` was never authoritative — leave the
  // profile exactly as its writer intended.
  if (balanceHistory(profile).length === 0) return null;
  const authoritative = numOrNull(f.balance);
  if (authoritative == null) return null;

  const patch = balanceFieldsFor(profile, authoritative);
  // Only report a repair when a key the RESOLVERS read actually disagrees.
  const drifted = Object.entries(patch).some(([k, v]) => {
    const cur = numOrNull((f as any)[k]);
    return cur == null ? v != null : Math.abs(cur - Number(v)) > 0.005;
  });
  return drifted ? patch : null;
}
