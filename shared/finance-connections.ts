/**
 * Shared vocabulary for Stripe Financial Connections data.
 *
 * These types describe the NORMALIZED shape that lives in Supabase and travels
 * over `/api/finance/*` — not Stripe's wire format. Client and server both
 * import from here so a field can never mean two different things on the two
 * sides of the API.
 */

import type { Minor } from "./money";

// ── Data provenance ─────────────────────────────────────────────────────────
// Every financial record in Portol declares where it came from, so connected
// data and hand-entered data can coexist without either pretending to be the
// other.
export const FINANCE_SOURCES = [
  "manual",
  "stripe_financial_connections",
  "document_extraction",
  "ai_created",
  "imported",
] as const;
export type FinanceSource = (typeof FINANCE_SOURCES)[number];

// ── Connection lifecycle ────────────────────────────────────────────────────
export type ConnectionStatus =
  | "connecting"       // session created, user is inside Stripe's flow
  | "active"           // authorized and syncing
  | "action_required"  // relink / re-auth needed before data can refresh
  | "disconnected"     // user (or Stripe) ended the authorization
  | "failed";          // last attempt errored and we could not recover

export type SyncStatus = "success" | "partial" | "failed";
export type SyncType = "initial" | "manual" | "scheduled" | "webhook" | "relink";

export type AccountStatus = "active" | "inactive" | "disconnected" | "action_required";

/** Stripe's `category`. */
export type AccountCategory = "cash" | "credit" | "investment" | "other";
/** Stripe's `subcategory`. */
export type AccountSubcategory =
  | "checking" | "savings" | "mortgage" | "line_of_credit" | "credit_card" | "other";

/** Portol's coarse bucket, derived from category + subcategory. */
export type AccountType = "depository" | "credit" | "loan" | "investment" | "other";

export type TransactionStatus = "pending" | "posted" | "void";

/**
 * Map Stripe's (category, subcategory) pair onto Portol's account type.
 * Kept here — not inline in the sync — because the Finance tab, the net-worth
 * math and the AI tools all need the same answer.
 */
export function deriveAccountType(
  category: string | null | undefined,
  subcategory: string | null | undefined,
): AccountType {
  const cat = (category || "").toLowerCase();
  const sub = (subcategory || "").toLowerCase();
  if (cat === "cash") return "depository";
  if (cat === "investment") return "investment";
  if (cat === "credit") {
    if (sub === "mortgage" || sub === "line_of_credit") return "loan";
    return "credit"; // credit_card, other
  }
  return "other";
}

/** Does this account represent money the user OWES rather than owns? */
export function isDebtAccount(accountType: string | null | undefined): boolean {
  return accountType === "credit" || accountType === "loan";
}

/** Human label for an account type — one spelling across the whole app. */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  depository: "Bank account",
  credit: "Credit card",
  loan: "Loan",
  investment: "Investment",
  other: "Other",
};

export const ACCOUNT_SUBCATEGORY_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  line_of_credit: "Line of credit",
  mortgage: "Mortgage",
  other: "Other",
};

// ── Normalized records (the API contract) ───────────────────────────────────

export interface FinancialConnectionRecord {
  id: string;
  institutionName: string | null;
  connectionStatus: ConnectionStatus;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  lastSyncStatus: SyncStatus | null;
  /** A stable Portol error CODE, never a raw Stripe message. */
  lastSyncError: string | null;
  createdAt: string;
  disconnectedAt: string | null;
  accountCount: number;
}

export interface FinancialAccountRecord {
  id: string;
  financialConnectionId: string | null;
  institutionName: string | null;
  accountName: string | null;
  accountDisplayName: string | null;
  accountCategory: AccountCategory | null;
  accountSubcategory: AccountSubcategory | null;
  accountType: AccountType;
  lastFour: string | null;
  currency: string;
  /** Minor units, signed from the holder's perspective (debt is negative). */
  currentBalance: Minor | null;
  /** Minor units. Null when the institution does not report it. */
  availableBalance: Minor | null;
  balanceAsOf: string | null;
  status: AccountStatus;
  isHidden: boolean;
  includeInNetWorth: boolean;
  matchedProfileId: string | null;
  permissions: string[];
  subscriptions: string[];
  inactiveCause: string | null;
  updatedAt: string;
}

export interface FinancialTransactionRecord {
  id: string;
  financialAccountId: string;
  /**
   * Stripe's id for the row. Present on connected data, absent on anything
   * hand-entered. Used only for duplicate detection — never rendered.
   */
  stripeTransactionId?: string | null;
  accountName: string | null;
  institutionName: string | null;
  transactionDate: string;   // YYYY-MM-DD
  postedAt: string | null;
  description: string | null;
  merchantName: string | null;
  /** Minor units, signed: positive = into the account. */
  amount: Minor;
  currency: string;
  transactionType: "debit" | "credit" | null;
  status: TransactionStatus;
  category: string | null;
  subcategory: string | null;
  isIncome: boolean;
  isExpense: boolean;
  isTransfer: boolean;
  isRefund: boolean;
  isDuplicate: boolean;
  excludedFromTotals: boolean;
  source: FinanceSource;
  /** Present only when the user has corrected something on this row. */
  override?: TransactionOverride | null;
  /** Set when a transfer link involving this row has been confirmed/detected. */
  transferGroupId?: string | null;
}

export interface TransactionOverride {
  category: string | null;
  subcategory: string | null;
  merchantName: string | null;
  isIncome: boolean | null;
  isExpense: boolean | null;
  isTransfer: boolean | null;
  isRefund: boolean | null;
  excludedFromTotals: boolean | null;
  note: string | null;
  linkedProfileId: string | null;
  linkedSubscriptionProfileId: string | null;
  linkedLiabilityProfileId: string | null;
  linkedAssetProfileId: string | null;
  budgetCategory: string | null;
}

export interface SyncRunRecord {
  id: string;
  financialConnectionId: string | null;
  syncType: SyncType;
  startedAt: string;
  completedAt: string | null;
  status: "running" | SyncStatus;
  accountsProcessed: number;
  transactionsInserted: number;
  transactionsUpdated: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/** What Settings → Connections → Finance renders. */
export interface FinanceConnectionState {
  /** False when the server has no Stripe keys — the UI explains instead of erroring. */
  configured: boolean;
  connections: FinancialConnectionRecord[];
  accounts: FinancialAccountRecord[];
  lastSync: SyncRunRecord | null;
  /** Rolled-up state for the headline badge. */
  status: "not_connected" | "connected" | "action_required" | "failed";
}

/**
 * Apply a user's correction on top of an imported transaction.
 *
 * The override table stores NULL for "no opinion", so this is a field-by-field
 * coalesce rather than an object spread — a stored `false` must win over an
 * imported `true`, which `??` gives us and `||` would not.
 */
export function applyOverride(
  txn: FinancialTransactionRecord,
  override: TransactionOverride | null | undefined,
): FinancialTransactionRecord {
  if (!override) return txn;
  return {
    ...txn,
    category: override.category ?? txn.category,
    subcategory: override.subcategory ?? txn.subcategory,
    merchantName: override.merchantName ?? txn.merchantName,
    isIncome: override.isIncome ?? txn.isIncome,
    isExpense: override.isExpense ?? txn.isExpense,
    isTransfer: override.isTransfer ?? txn.isTransfer,
    isRefund: override.isRefund ?? txn.isRefund,
    excludedFromTotals: override.excludedFromTotals ?? txn.excludedFromTotals,
    override,
  };
}

// ── User-facing error vocabulary ────────────────────────────────────────────
// The server maps every failure onto one of these codes. Raw Stripe errors,
// stack traces and internal ids never reach the browser.
export const FINANCE_ERROR_MESSAGES: Record<string, string> = {
  not_configured:
    "Bank connections aren't set up on this server yet. Add your Stripe keys to enable them.",
  session_cancelled:
    "You closed the bank connection window before finishing. Nothing was linked.",
  institution_unavailable:
    "Your bank isn't responding right now. This is usually temporary — try again in a few minutes.",
  login_failed:
    "Your bank couldn't verify those details. Reconnect and sign in again through your bank's page.",
  mfa_required:
    "Your bank needs another verification step. Reconnect to complete it.",
  relink_required:
    "Your bank needs you to authorize Portol again. Choose Reconnect to restore syncing.",
  account_inactive:
    "This account is no longer active at your bank. Reconnect to restore it.",
  authorization_revoked:
    "Access to this account was revoked. Reconnect to restore syncing.",
  balance_refresh_failed:
    "We couldn't refresh balances just now. The last known balance is still shown.",
  transaction_refresh_failed:
    "We couldn't refresh transactions just now. Previously imported transactions are unaffected.",
  no_transaction_permission:
    "This account was linked without transaction access. Reconnect and allow transactions to import them.",
  no_balance_permission:
    "This account was linked without balance access. Reconnect and allow balances to see them.",
  rate_limited:
    "You've refreshed a lot in a short time. Please wait a minute and try again.",
  stripe_unavailable:
    "The bank data service is temporarily unavailable. Please try again shortly.",
  storage_unavailable:
    "We couldn't save the imported data. Nothing was lost — please try again.",
  partial_import:
    "Some accounts imported and some didn't. Refresh to retry the ones that failed.",
  unknown:
    "Something went wrong connecting to your bank. Please try again.",
};

export function financeErrorMessage(code: string | null | undefined): string {
  if (!code) return FINANCE_ERROR_MESSAGES.unknown;
  return FINANCE_ERROR_MESSAGES[code] ?? FINANCE_ERROR_MESSAGES.unknown;
}

/** Codes where the only useful action is re-authorizing the institution. */
export const RELINK_ERROR_CODES = new Set([
  "relink_required",
  "authorization_revoked",
  "account_inactive",
  "mfa_required",
  "login_failed",
]);
