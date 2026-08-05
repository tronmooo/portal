/**
 * Read layer for connected financial data.
 *
 * Every read of `financial_*` goes through here — the HTTP routes, the Claude
 * tools, and the dashboard rollups alike — so:
 *
 *   1. USER ISOLATION IS STRUCTURAL. Each function takes a verified `userId`
 *      and every query carries `.eq("user_id", userId)`. There is no code path
 *      that reads these tables without it. Combined with the RLS policies from
 *      the migration, a query would have to bypass BOTH to leak.
 *   2. Row → record mapping happens once. Snake-case DB columns become the
 *      camelCase contract in shared/finance-connections.ts in exactly one place.
 *   3. Overrides are applied on read. Callers always see the user's corrected
 *      view without any of them re-implementing the merge.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getFinanceDb } from "./stripe-config";
import { toMinor } from "@shared/money";
import {
  applyOverride,
  type FinancialAccountRecord,
  type FinancialConnectionRecord,
  type FinancialTransactionRecord,
  type SyncRunRecord,
  type TransactionOverride,
  type AccountType,
} from "@shared/finance-connections";

// ── Row mappers ─────────────────────────────────────────────────────────────

export function mapAccount(row: any): FinancialAccountRecord {
  return {
    id: row.id,
    financialConnectionId: row.financial_connection_id ?? null,
    institutionName: row.institution_name ?? null,
    accountName: row.account_name ?? null,
    accountDisplayName: row.account_display_name ?? row.account_name ?? null,
    accountCategory: row.account_category ?? null,
    accountSubcategory: row.account_subcategory ?? null,
    accountType: (row.account_type ?? "other") as AccountType,
    lastFour: row.last_four ?? null,
    currency: (row.currency ?? "usd").toLowerCase(),
    currentBalance: row.current_balance == null ? null : toMinor(row.current_balance),
    availableBalance: row.available_balance == null ? null : toMinor(row.available_balance),
    balanceAsOf: row.balance_as_of ?? null,
    status: row.status ?? "active",
    isHidden: !!row.is_hidden,
    includeInNetWorth: row.include_in_net_worth !== false,
    matchedProfileId: row.matched_profile_id ?? null,
    permissions: row.permissions ?? [],
    subscriptions: row.subscriptions ?? [],
    inactiveCause: row.inactive_cause ?? null,
    updatedAt: row.updated_at,
  };
}

export function mapOverride(row: any): TransactionOverride | null {
  if (!row) return null;
  return {
    category: row.category ?? null,
    subcategory: row.subcategory ?? null,
    merchantName: row.merchant_name ?? null,
    isIncome: row.is_income ?? null,
    isExpense: row.is_expense ?? null,
    isTransfer: row.is_transfer ?? null,
    isRefund: row.is_refund ?? null,
    excludedFromTotals: row.excluded_from_totals ?? null,
    note: row.note ?? null,
    linkedProfileId: row.linked_profile_id ?? null,
    linkedSubscriptionProfileId: row.linked_subscription_profile_id ?? null,
    linkedLiabilityProfileId: row.linked_liability_profile_id ?? null,
    linkedAssetProfileId: row.linked_asset_profile_id ?? null,
    budgetCategory: row.budget_category ?? null,
  };
}

export function mapTransaction(
  row: any,
  accountsById: Map<string, FinancialAccountRecord>,
): FinancialTransactionRecord {
  const account = accountsById.get(row.financial_account_id);
  const base: FinancialTransactionRecord = {
    id: row.id,
    financialAccountId: row.financial_account_id,
    stripeTransactionId: row.stripe_transaction_id ?? null,
    accountName: account?.accountDisplayName ?? null,
    institutionName: account?.institutionName ?? null,
    transactionDate: row.transaction_date,
    postedAt: row.posted_at ?? null,
    description: row.description ?? null,
    merchantName: row.merchant_name ?? null,
    amount: toMinor(row.amount),
    currency: (row.currency ?? "usd").toLowerCase(),
    transactionType: row.transaction_type ?? null,
    status: row.status ?? "posted",
    category: row.category ?? null,
    subcategory: row.subcategory ?? null,
    isIncome: !!row.is_income,
    isExpense: !!row.is_expense,
    isTransfer: !!row.is_transfer,
    isRefund: !!row.is_refund,
    isDuplicate: !!row.is_duplicate,
    excludedFromTotals: !!row.excluded_from_totals,
    source: row.source ?? "stripe_financial_connections",
  };
  const override = mapOverride(
    Array.isArray(row.financial_transaction_overrides)
      ? row.financial_transaction_overrides[0]
      : row.financial_transaction_overrides,
  );
  return applyOverride(base, override);
}

export function mapConnection(row: any, accountCount: number): FinancialConnectionRecord {
  return {
    id: row.id,
    institutionName: row.institution_name ?? null,
    connectionStatus: row.connection_status,
    lastSuccessfulSyncAt: row.last_successful_sync_at ?? null,
    lastAttemptedSyncAt: row.last_attempted_sync_at ?? null,
    lastSyncStatus: row.last_sync_status ?? null,
    lastSyncError: row.last_sync_error ?? null,
    createdAt: row.created_at,
    disconnectedAt: row.disconnected_at ?? null,
    accountCount,
  };
}

export function mapSyncRun(row: any): SyncRunRecord {
  return {
    id: row.id,
    financialConnectionId: row.financial_connection_id ?? null,
    syncType: row.sync_type,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    status: row.status,
    accountsProcessed: row.accounts_processed ?? 0,
    transactionsInserted: row.transactions_inserted ?? 0,
    transactionsUpdated: row.transactions_updated ?? 0,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getAccounts(
  userId: string,
  opts: { includeHidden?: boolean; db?: SupabaseClient } = {},
): Promise<FinancialAccountRecord[]> {
  const db = opts.db ?? getFinanceDb();
  let q = db.from("financial_accounts").select("*").eq("user_id", userId);
  if (!opts.includeHidden) q = q.eq("is_hidden", false);
  const { data, error } = await q.order("institution_name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapAccount);
}

export async function getConnections(
  userId: string,
  opts: { db?: SupabaseClient } = {},
): Promise<FinancialConnectionRecord[]> {
  const db = opts.db ?? getFinanceDb();
  const { data, error } = await db
    .from("financial_connections")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const { data: counts } = await db
    .from("financial_accounts")
    .select("financial_connection_id")
    .eq("user_id", userId)
    .neq("status", "disconnected");

  const byConn = new Map<string, number>();
  for (const row of counts ?? []) {
    const key = row.financial_connection_id;
    if (!key) continue;
    byConn.set(key, (byConn.get(key) ?? 0) + 1);
  }

  return (data ?? []).map((r) => mapConnection(r, byConn.get(r.id) ?? 0));
}

export interface TransactionQuery {
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
  search?: string;
  merchant?: string;
  category?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  /** income | expense | transfer | refund — a view over the flags, not a DB column. */
  transactionType?: "income" | "expense" | "transfer" | "refund" | "all";
  status?: Array<"pending" | "posted" | "void">;
  includeDuplicates?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Fetch a user's transactions with their overrides joined.
 *
 * The type/amount filters that depend on OVERRIDDEN values are applied in
 * memory after the merge — filtering in SQL would use the imported values and
 * disagree with what the user sees.
 */
export async function getTransactions(
  userId: string,
  query: TransactionQuery = {},
  opts: { db?: SupabaseClient; accounts?: FinancialAccountRecord[] } = {},
): Promise<{ transactions: FinancialTransactionRecord[]; total: number }> {
  const db = opts.db ?? getFinanceDb();
  const accounts = opts.accounts ?? (await getAccounts(userId, { includeHidden: true, db }));
  const accountsById = new Map(accounts.map((a) => [a.id, a]));

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);

  let q = db
    .from("financial_transactions")
    .select("*, financial_transaction_overrides(*)", { count: "exact" })
    .eq("user_id", userId);

  if (query.startDate) q = q.gte("transaction_date", query.startDate);
  if (query.endDate) q = q.lte("transaction_date", query.endDate);
  if (query.accountIds?.length) q = q.in("financial_account_id", query.accountIds);
  if (!query.includeDuplicates) q = q.eq("is_duplicate", false);
  if (query.status?.length) q = q.in("status", query.status);
  if (query.merchant) q = q.ilike("merchant_name", `%${escapeLike(query.merchant)}%`);
  if (query.search) {
    const s = escapeLike(query.search);
    q = q.or(`description.ilike.%${s}%,merchant_name.ilike.%${s}%`);
  }

  // Amount bounds are on MAGNITUDE, which is what a user means by
  // "over $100" regardless of direction.
  if (query.minAmountMinor != null || query.maxAmountMinor != null) {
    // Applied in memory below — PostgREST has no abs() filter.
  }

  const { data, error, count } = await q
    .order("transaction_date", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  let rows = (data ?? []).map((r) => mapTransaction(r, accountsById));

  if (query.minAmountMinor != null) {
    rows = rows.filter((t) => Math.abs(t.amount) >= query.minAmountMinor!);
  }
  if (query.maxAmountMinor != null) {
    rows = rows.filter((t) => Math.abs(t.amount) <= query.maxAmountMinor!);
  }
  if (query.category) {
    const c = query.category.toLowerCase();
    rows = rows.filter((t) => (t.category ?? "uncategorized").toLowerCase() === c);
  }
  if (query.transactionType && query.transactionType !== "all") {
    rows = rows.filter((t) => {
      switch (query.transactionType) {
        case "income": return t.amount > 0 && !t.isTransfer && !t.isRefund;
        case "expense": return t.amount < 0 && !t.isTransfer && !t.isRefund;
        case "transfer": return t.isTransfer;
        case "refund": return t.isRefund;
        default: return true;
      }
    });
  }

  return { transactions: rows, total: count ?? rows.length };
}

/**
 * Every transaction in a window, paged through so calculations see the whole
 * period rather than the first screen of it.
 */
export async function getAllTransactionsInRange(
  userId: string,
  startDate: string | undefined,
  endDate: string | undefined,
  opts: { db?: SupabaseClient; accountIds?: string[]; accounts?: FinancialAccountRecord[]; maxRows?: number } = {},
): Promise<FinancialTransactionRecord[]> {
  const maxRows = opts.maxRows ?? 10_000;
  const out: FinancialTransactionRecord[] = [];
  let offset = 0;
  const pageSize = 500;

  while (out.length < maxRows) {
    const { transactions } = await getTransactions(
      userId,
      { startDate, endDate, accountIds: opts.accountIds, limit: pageSize, offset },
      { db: opts.db, accounts: opts.accounts },
    );
    out.push(...transactions);
    if (transactions.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

/**
 * Ids on both legs of transfer links that should be removed from spending and
 * income totals: user-confirmed links, plus auto-confirmed high-confidence ones.
 */
export async function getConfirmedTransferIds(
  userId: string,
  opts: { db?: SupabaseClient } = {},
): Promise<{ ids: Set<string>; groupByTxnId: Map<string, string>; detected: number }> {
  const db = opts.db ?? getFinanceDb();
  const { data, error } = await db
    .from("financial_transfer_links")
    .select("transfer_group_id, outflow_transaction_id, inflow_transaction_id, state")
    .eq("user_id", userId);
  if (error) throw error;

  const ids = new Set<string>();
  const groupByTxnId = new Map<string, string>();
  let detected = 0;
  for (const row of data ?? []) {
    if (row.state === "rejected") continue;
    groupByTxnId.set(row.outflow_transaction_id, row.transfer_group_id);
    groupByTxnId.set(row.inflow_transaction_id, row.transfer_group_id);
    if (row.state === "confirmed") {
      ids.add(row.outflow_transaction_id);
      ids.add(row.inflow_transaction_id);
    } else {
      detected++;
    }
  }
  return { ids, groupByTxnId, detected };
}

export async function getSyncRuns(
  userId: string,
  limit = 10,
  opts: { db?: SupabaseClient } = {},
): Promise<SyncRunRecord[]> {
  const db = opts.db ?? getFinanceDb();
  const { data, error } = await db
    .from("finance_sync_runs")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(mapSyncRun);
}

/** PostgREST `ilike` treats % and _ as wildcards — neutralize user input. */
function escapeLike(input: string): string {
  return input.replace(/[%_\\]/g, (m) => `\\${m}`).slice(0, 100);
}
