/**
 * Finance synchronization service.
 *
 * One reusable engine behind every path that pulls data from Stripe:
 *   * initial import right after a connection is authorized
 *   * manual "Refresh now"
 *   * scheduled refresh (cron)
 *   * webhook-triggered refresh
 *   * relink after a connection expired
 *
 * INVARIANTS
 * ----------
 *   * Idempotent. Every write is an upsert keyed on Stripe's own id, so
 *     replaying a sync (or a duplicated webhook) changes nothing.
 *   * Non-destructive. A transaction absent from a refresh is NOT deleted —
 *     institutions routinely return partial windows, and deleting on absence
 *     silently eats history.
 *   * Corrections are sacred. User overrides live in a separate table and are
 *     never touched by a sync.
 *   * Partial failure is a real outcome. One account failing does not abort the
 *     rest; the run is recorded as `partial` with the failing code.
 *   * Nothing sensitive is persisted: no credentials (Portol never sees them),
 *     no tokens, no raw institution payloads.
 */

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getStripe, getFinanceDb, classifyStripeError, logFinanceError, FinanceConfigError,
} from "./stripe-config";
import { deriveAccountType, isDebtAccount } from "@shared/finance-connections";
import { toMinor } from "@shared/money";
import {
  detectLikelyTransfers, detectPossibleDuplicates, AUTO_CONFIRM_CONFIDENCE,
} from "@shared/finance-calc";
import type { FinancialTransactionRecord, FinancialAccountRecord } from "@shared/finance-connections";

// How far back the FIRST import reaches. Stripe returns whatever the
// institution supports (commonly 90 days, sometimes up to 24 months); asking
// for two years costs nothing when less exists.
const INITIAL_HISTORY_DAYS = 730;

// Stripe's list endpoints cap at 100 per page.
const PAGE_SIZE = 100;
// Hard ceiling per account per run so one pathological account cannot burn the
// whole serverless budget. Remaining pages come on the next sync.
const MAX_PAGES_PER_ACCOUNT = 60;

export interface SyncOptions {
  /** VERIFIED user id. Callers must have authenticated; this is never client input. */
  userId: string;
  syncType: "initial" | "manual" | "scheduled" | "webhook" | "relink";
  /** Limit the run to one connection. Omit to sync every active connection. */
  connectionId?: string;
  /** Limit the run to specific Stripe account ids (webhook-driven refreshes). */
  stripeAccountIds?: string[];
  /** Pull the full history window rather than only what changed. */
  fullHistory?: boolean;
  /** Ask Stripe to refresh from the institution before reading. Costs money + latency. */
  requestRefresh?: boolean;
}

export interface SyncResult {
  runId: string | null;
  status: "success" | "partial" | "failed";
  accountsProcessed: number;
  transactionsInserted: number;
  transactionsUpdated: number;
  errorCode: string | null;
  /** Per-account failures, so the UI can name what did not import. */
  accountErrors: Array<{ stripeAccountId: string; code: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Account holder mapping (the trusted user ↔ Stripe customer link)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Find or create the Stripe customer that acts as this user's account holder.
 *
 * This mapping is the ONLY thing that links Stripe objects back to a Portol
 * user. Webhooks resolve ownership through it rather than trusting metadata on
 * the event, so a forged (but correctly signed) object cannot be attributed to
 * someone else's account.
 */
export async function ensureAccountHolder(
  userId: string,
  email?: string,
): Promise<{ customerId: string }> {
  const db = getFinanceDb();
  const stripe = getStripe();

  const { data: existing, error } = await db
    .from("stripe_account_holders")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (existing?.stripe_customer_id) return { customerId: existing.stripe_customer_id };

  // `metadata.portol_user_id` is a convenience for dashboard triage only —
  // nothing in this codebase trusts it for authorization.
  const customer = await stripe.customers.create(
    {
      email: email || undefined,
      metadata: { portol_user_id: userId },
      description: `Portol user ${userId}`,
    },
    // Idempotency key: a retried create returns the SAME customer instead of
    // silently minting a second one for the same user.
    { idempotencyKey: `portol-holder-${userId}` },
  );

  const { error: insErr } = await db.from("stripe_account_holders").insert({
    user_id: userId,
    stripe_customer_id: customer.id,
    livemode: customer.livemode,
  });
  if (insErr) {
    // Lost a race with a concurrent request — re-read and use the winner.
    const { data: raced } = await db
      .from("stripe_account_holders")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (raced?.stripe_customer_id) return { customerId: raced.stripe_customer_id };
    throw insErr;
  }
  return { customerId: customer.id };
}

/** Resolve a Stripe customer id back to the owning Portol user. */
export async function userIdForCustomer(customerId: string): Promise<string | null> {
  const db = getFinanceDb();
  const { data } = await db
    .from("stripe_account_holders")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.user_id ?? null;
}

/** Resolve a Stripe Financial Connections account id to its owning user. */
export async function userIdForStripeAccount(stripeAccountId: string): Promise<string | null> {
  const db = getFinanceDb();
  const { data } = await db
    .from("financial_accounts")
    .select("user_id")
    .eq("stripe_financial_connections_account_id", stripeAccountId)
    .maybeSingle();
  return data?.user_id ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Normalization — Stripe's shapes → Portol's canonical shapes
// ────────────────────────────────────────────────────────────────────────────

/**
 * Balance in minor units, signed from the HOLDER's perspective.
 *
 * Stripe reports `balance.current` as a per-currency map, positive for money
 * owed TO the holder. For credit accounts it also fills `balance.credit.used`
 * with a positive "you owe this" figure. We normalize so that a single SUM over
 * accounts is net worth: cash positive, debt negative.
 */
export function normalizeBalance(account: Stripe.FinancialConnections.Account): {
  currency: string;
  current: number | null;
  available: number | null;
  asOf: string | null;
} {
  const balance = account.balance;
  if (!balance) return { currency: "usd", current: null, available: null, asOf: null };

  const currentMap = balance.current || {};
  const currency = Object.keys(currentMap)[0] || "usd";
  const rawCurrent = currentMap[currency];

  const debt = isDebtAccount(deriveAccountType(account.category, account.subcategory));

  let current: number | null = null;
  if (typeof rawCurrent === "number") {
    // Stripe already signs `current` correctly for credit (negative = owed by
    // the holder), but institutions are inconsistent. Force the sign to match
    // the account kind so a positive credit balance can never inflate assets.
    current = debt ? -Math.abs(rawCurrent) : rawCurrent;
  } else if (debt && typeof balance.credit?.used?.[currency] === "number") {
    current = -Math.abs(balance.credit.used[currency]!);
  }

  const availableRaw = balance.cash?.available?.[currency];
  const available = typeof availableRaw === "number" ? availableRaw : null;

  return {
    currency,
    current,
    available,
    asOf: balance.as_of ? new Date(balance.as_of * 1000).toISOString() : null,
  };
}

/**
 * Transaction amount in minor units under Portol's sign convention.
 *
 * For a CASH account Stripe's sign already means what we mean: negative is
 * money leaving. For a CREDIT (card) account the institution's frame is
 * inverted — a purchase increases what you owe — so a raw copy would show every
 * card purchase as income. We flip credit accounts so "negative = you spent"
 * holds on every account type, everywhere in the app.
 */
export function normalizeAmount(
  stripeAmount: number,
  accountType: string | null | undefined,
): number {
  const amount = toMinor(stripeAmount);
  return isDebtAccount(accountType) ? -amount : amount;
}

/**
 * Best-effort merchant name from a bank description.
 *
 * Bank descriptors are noisy ("SQ *BLUE BOTTLE 0123 SAN FRAN CA"). We take the
 * recognisable head and drop trailing reference/location noise. This is a
 * display convenience only — the untouched description is always stored.
 */
export function extractMerchant(description: string | null | undefined): string | null {
  if (!description) return null;
  let s = description.trim();
  if (!s) return null;
  // Common processor prefixes.
  s = s.replace(/^(sq|tst|sp|pp|paypal|pos|ach|dbt crd|debit card|visa|mastercard)\s*\*?\s*/i, "");
  // Drop trailing city/state and long digit runs.
  s = s.replace(/\s+\d{4,}.*$/, "");
  s = s.replace(/\s+[A-Z]{2}\s*$/, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  // Title-case ALL-CAPS descriptors; leave mixed case alone.
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  return s.slice(0, 120) || null;
}

/**
 * Coarse spending category from the description.
 *
 * Stripe Financial Connections does NOT return a merchant category, so this is
 * an explicitly heuristic first guess that the user can override (and their
 * override is stored separately and never overwritten). Uncategorized is a
 * perfectly acceptable answer — guessing wrong is worse than saying nothing.
 */
const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\b(grocery|groceries|safeway|kroger|trader joe|whole foods|aldi|costco|wegmans|publix)\b/i, "food"],
  [/\b(restaurant|cafe|coffee|starbucks|chipotle|mcdonald|pizza|doordash|uber eats|grubhub|bar & grill)\b/i, "food"],
  [/\b(uber|lyft|shell|chevron|exxon|bp|gas|fuel|parking|toll|transit|metro|amtrak|airlines|delta|united air)\b/i, "transport"],
  [/\b(rent|mortgage|hoa|property manage|landlord)\b/i, "housing"],
  [/\b(electric|water|sewer|gas company|pg&e|comcast|xfinity|verizon|at&t|t-mobile|internet|utility)\b/i, "utilities"],
  [/\b(pharmacy|cvs|walgreens|clinic|hospital|dental|dentist|doctor|medical|health)\b/i, "health"],
  [/\b(netflix|spotify|hulu|disney|hbo|cinema|theatre|theater|steam|playstation|xbox|concert)\b/i, "entertainment"],
  [/\b(vet|veterinar|petco|petsmart|chewy)\b/i, "pet"],
  [/\b(insurance|geico|allstate|state farm|progressive)\b/i, "insurance"],
  [/\b(amazon|target|walmart|best buy|ebay|etsy|shop)\b/i, "shopping"],
];

export function guessCategory(description: string | null | undefined): string | null {
  if (!description) return null;
  for (const [re, category] of CATEGORY_RULES) {
    if (re.test(description)) return category;
  }
  return null;
}

const REFUND_RE = /\b(refund|reversal|returned|chargeback|credit adjustment|rebate)\b/i;
const TRANSFER_RE = /\b(transfer|xfer|zelle|venmo|wire|to savings|from savings|online transfer|internal)\b/i;

// ────────────────────────────────────────────────────────────────────────────
// Sync runs
// ────────────────────────────────────────────────────────────────────────────

async function startRun(
  db: SupabaseClient,
  userId: string,
  connectionId: string | null,
  syncType: SyncOptions["syncType"],
): Promise<string | null> {
  const { data, error } = await db
    .from("finance_sync_runs")
    .insert({
      user_id: userId,
      financial_connection_id: connectionId,
      sync_type: syncType,
      status: "running",
    })
    .select("id")
    .single();
  if (error) {
    // A sync-history write failing must not stop the actual sync.
    logFinanceError("startRun", error, { userId: userId.slice(0, 8) });
    return null;
  }
  return data.id;
}

async function finishRun(
  db: SupabaseClient,
  runId: string | null,
  result: Omit<SyncResult, "runId">,
): Promise<void> {
  if (!runId) return;
  const { error } = await db
    .from("finance_sync_runs")
    .update({
      completed_at: new Date().toISOString(),
      status: result.status,
      accounts_processed: result.accountsProcessed,
      transactions_inserted: result.transactionsInserted,
      transactions_updated: result.transactionsUpdated,
      error_code: result.errorCode,
      // A short, non-sensitive summary. Never a Stripe message or a stack.
      error_message: result.accountErrors.length
        ? `${result.accountErrors.length} account(s) failed`
        : null,
    })
    .eq("id", runId);
  if (error) logFinanceError("finishRun", error);
}

// ────────────────────────────────────────────────────────────────────────────
// Account import
// ────────────────────────────────────────────────────────────────────────────

/**
 * Upsert one Stripe account into `financial_accounts`.
 *
 * `account_display_name` is only ever WRITTEN on insert — if the user renamed
 * the account, a later sync must not stomp their label. Same for
 * `include_in_net_worth`, `is_hidden` and `matched_profile_id`.
 */
export async function upsertAccount(
  db: SupabaseClient,
  userId: string,
  connectionId: string | null,
  account: Stripe.FinancialConnections.Account,
): Promise<{ id: string; accountType: string; created: boolean }> {
  const accountType = deriveAccountType(account.category, account.subcategory);
  const balance = normalizeBalance(account);

  // Portol's own `action_required` state layers on top of Stripe's status.
  const relink = account.status_details?.active?.action === "relink_required";
  const status: FinancialAccountRecord["status"] =
    account.status === "disconnected" ? "disconnected"
      : account.status === "inactive" ? "inactive"
        : relink ? "action_required"
          : "active";

  const { data: existing } = await db
    .from("financial_accounts")
    .select("id")
    .eq("user_id", userId)
    .eq("stripe_financial_connections_account_id", account.id)
    .maybeSingle();

  const shared = {
    institution_name: account.institution_name || null,
    account_name: account.display_name || null,
    account_category: account.category || null,
    account_subcategory: account.subcategory || null,
    account_type: accountType,
    last_four: account.last4 || null,
    currency: balance.currency,
    status,
    permissions: account.permissions ?? [],
    subscriptions: account.subscriptions ?? [],
    inactive_cause: account.status_details?.active?.cause ?? null,
    // Only overwrite balances when Stripe actually gave us one — a failed
    // refresh must leave the last known balance in place, not blank it.
    ...(balance.current !== null ? { current_balance: balance.current } : {}),
    ...(balance.available !== null ? { available_balance: balance.available } : {}),
    ...(balance.asOf ? { balance_as_of: balance.asOf } : {}),
    ...(account.transaction_refresh?.id ? { last_transaction_refresh_id: account.transaction_refresh.id } : {}),
  };

  if (existing?.id) {
    // Re-authorizing an account re-points it at the new connection.
    const patch: Record<string, unknown> = { ...shared };
    if (connectionId) patch.financial_connection_id = connectionId;
    const { error } = await db.from("financial_accounts").update(patch).eq("id", existing.id).eq("user_id", userId);
    if (error) throw error;
    return { id: existing.id, accountType, created: false };
  }

  const { data, error } = await db
    .from("financial_accounts")
    .insert({
      user_id: userId,
      financial_connection_id: connectionId,
      stripe_financial_connections_account_id: account.id,
      account_display_name: account.display_name || `${account.institution_name} ${account.last4 ?? ""}`.trim(),
      is_hidden: false,
      include_in_net_worth: true,
      ...shared,
    })
    .select("id")
    .single();

  if (error) {
    // Unique violation = a concurrent sync inserted it first. Re-read and
    // continue rather than failing the whole run.
    const { data: raced } = await db
      .from("financial_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("stripe_financial_connections_account_id", account.id)
      .maybeSingle();
    if (raced?.id) return { id: raced.id, accountType, created: false };
    throw error;
  }
  return { id: data.id, accountType, created: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Transaction import
// ────────────────────────────────────────────────────────────────────────────

interface TransactionImportStats { inserted: number; updated: number; }

/**
 * Import transactions for one account, paginating through Stripe.
 *
 * Incremental by default: when we know the last transaction_refresh we ask
 * Stripe only for rows created or changed since it. The first import (and any
 * explicit `fullHistory`) walks the date window instead.
 */
export async function importTransactions(
  db: SupabaseClient,
  stripe: Stripe,
  userId: string,
  localAccountId: string,
  stripeAccountId: string,
  accountType: string,
  opts: { fullHistory: boolean; sinceRefreshId?: string | null },
): Promise<TransactionImportStats> {
  const stats: TransactionImportStats = { inserted: 0, updated: 0 };

  const baseParams: Stripe.FinancialConnections.TransactionListParams = {
    account: stripeAccountId,
    limit: PAGE_SIZE,
  };
  if (opts.fullHistory || !opts.sinceRefreshId) {
    baseParams.transacted_at = {
      gte: Math.floor((Date.now() - INITIAL_HISTORY_DAYS * 86_400_000) / 1000),
    };
  } else {
    baseParams.transaction_refresh = { after: opts.sinceRefreshId };
  }

  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    const params: Stripe.FinancialConnections.TransactionListParams = { ...baseParams };
    if (startingAfter) params.starting_after = startingAfter;

    const list = await stripe.financialConnections.transactions.list(params);
    if (list.data.length === 0) break;

    const rows = list.data.map((t) => toTransactionRow(userId, localAccountId, accountType, t));
    const written = await upsertTransactions(db, userId, rows);
    stats.inserted += written.inserted;
    stats.updated += written.updated;

    if (!list.has_more) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  return stats;
}

function toTransactionRow(
  userId: string,
  localAccountId: string,
  accountType: string,
  t: Stripe.FinancialConnections.Transaction,
): Record<string, unknown> {
  const amount = normalizeAmount(t.amount, accountType);
  const description = t.description || null;
  const merchant = extractMerchant(description);
  const isRefund = amount > 0 && !!description && REFUND_RE.test(description);
  const isTransfer = !!description && TRANSFER_RE.test(description);

  return {
    user_id: userId,
    financial_account_id: localAccountId,
    stripe_transaction_id: t.id,
    transaction_date: new Date(t.transacted_at * 1000).toISOString().slice(0, 10),
    posted_at: t.status_transitions?.posted_at
      ? new Date(t.status_transitions.posted_at * 1000).toISOString()
      : null,
    description,
    merchant_name: merchant,
    amount,
    currency: (t.currency || "usd").toLowerCase(),
    transaction_type: amount < 0 ? "debit" : "credit",
    status: t.status,
    category: guessCategory(description),
    subcategory: null,
    // Deliberately conservative: `is_income` stays false at import time. The
    // income calculation decides what counts, and unclear deposits surface for
    // review rather than being counted as salary.
    is_income: false,
    is_expense: amount < 0 && !isRefund && !isTransfer,
    is_transfer: isTransfer,
    is_refund: isRefund,
    is_duplicate: false,
    excluded_from_totals: false,
    source: "stripe_financial_connections",
    // Non-sensitive echo only — ids and timings, nothing replayable.
    raw_metadata: {
      stripe_account: t.account,
      transaction_refresh: t.transaction_refresh ?? null,
      void_at: t.status_transitions?.void_at ?? null,
      updated: t.updated ?? null,
      livemode: t.livemode,
    },
  };
}

/**
 * Upsert a batch on (user_id, stripe_transaction_id).
 *
 * `ignoreDuplicates: false` makes this a real upsert: a pending row that later
 * posts gets its status, posted_at and amount refreshed in place, keeping the
 * same primary key so overrides and transfer links stay attached.
 *
 * Columns that carry USER intent (`excluded_from_totals`, category corrections)
 * live in financial_transaction_overrides, so re-writing this row is safe.
 */
export async function upsertTransactions(
  db: SupabaseClient,
  userId: string,
  rows: Array<Record<string, unknown>>,
): Promise<TransactionImportStats> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };

  // Which of these already exist? Needed only to report inserted vs updated
  // honestly in the sync history.
  const ids = rows.map((r) => r.stripe_transaction_id as string);
  const existing = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db
      .from("financial_transactions")
      .select("stripe_transaction_id")
      .eq("user_id", userId)
      .in("stripe_transaction_id", ids.slice(i, i + 200));
    for (const row of data ?? []) existing.add(row.stripe_transaction_id);
  }

  const { error } = await db
    .from("financial_transactions")
    .upsert(rows, { onConflict: "user_id,stripe_transaction_id", ignoreDuplicates: false });
  if (error) throw error;

  let inserted = 0;
  let updated = 0;
  for (const id of ids) (existing.has(id) ? updated++ : inserted++);
  return { inserted, updated };
}

// ────────────────────────────────────────────────────────────────────────────
// Post-import analysis (transfers + duplicates)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run transfer and duplicate detection over the user's recent window and
 * persist the RESULTS as links/flags. Both are non-destructive: nothing is
 * merged, nothing is deleted, and a detected transfer only affects totals once
 * its confidence clears AUTO_CONFIRM_CONFIDENCE or the user confirms it.
 */
export async function analyzeRecent(
  db: SupabaseClient,
  userId: string,
  windowDays = 120,
): Promise<{ transfersDetected: number; duplicatesFlagged: number }> {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const { data: txnRows, error } = await db
    .from("financial_transactions")
    .select("id, financial_account_id, stripe_transaction_id, transaction_date, description, merchant_name, amount, currency, status, is_duplicate, is_transfer, excluded_from_totals")
    .eq("user_id", userId)
    .gte("transaction_date", since)
    .order("transaction_date", { ascending: true })
    .limit(5000);
  if (error) throw error;

  const { data: accountRows } = await db
    .from("financial_accounts")
    .select("id, account_type")
    .eq("user_id", userId);

  const txns: FinancialTransactionRecord[] = (txnRows ?? []).map((r: any) => ({
    id: r.id,
    financialAccountId: r.financial_account_id,
    stripeTransactionId: r.stripe_transaction_id,
    accountName: null,
    institutionName: null,
    transactionDate: r.transaction_date,
    postedAt: null,
    description: r.description,
    merchantName: r.merchant_name,
    amount: toMinor(r.amount),
    currency: r.currency,
    transactionType: null,
    status: r.status,
    category: null,
    subcategory: null,
    isIncome: false,
    isExpense: false,
    isTransfer: !!r.is_transfer,
    isRefund: false,
    isDuplicate: !!r.is_duplicate,
    excludedFromTotals: !!r.excluded_from_totals,
    source: "stripe_financial_connections",
  }));

  const accounts = (accountRows ?? []).map((a: any) => ({
    id: a.id, accountType: a.account_type,
  })) as FinancialAccountRecord[];

  // ── Transfers ──
  const candidates = detectLikelyTransfers(txns, accounts, { toleranceMinor: 0 });
  let transfersDetected = 0;
  for (const c of candidates) {
    const { error: linkErr } = await db.from("financial_transfer_links").upsert(
      {
        user_id: userId,
        outflow_transaction_id: c.outflowId,
        inflow_transaction_id: c.inflowId,
        confidence: c.confidence,
        // Only a very confident match is auto-applied. Everything else waits
        // for the user — the spec is explicit that uncertain transfers must
        // not be silently classified.
        state: c.confidence >= AUTO_CONFIRM_CONFIDENCE ? "confirmed" : "detected",
        signals: c.signals,
      },
      { onConflict: "outflow_transaction_id,inflow_transaction_id", ignoreDuplicates: true },
    );
    if (!linkErr) transfersDetected++;
  }

  // ── Duplicates ──
  const dupes = detectPossibleDuplicates(txns);
  let duplicatesFlagged = 0;
  const dupIds = dupes.filter((d) => d.confidence >= 0.8).map((d) => d.duplicateId);
  if (dupIds.length > 0) {
    const { error: dupErr } = await db
      .from("financial_transactions")
      .update({ is_duplicate: true })
      .eq("user_id", userId)
      .in("id", dupIds);
    if (!dupErr) duplicatesFlagged = dupIds.length;
  }

  return { transfersDetected, duplicatesFlagged };
}

// ────────────────────────────────────────────────────────────────────────────
// The sync entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * Synchronize a user's connected financial data.
 *
 * Never throws for per-account problems — those become `accountErrors` and a
 * `partial` status. It only throws when the run cannot start at all (missing
 * configuration), which callers turn into a clean 503.
 */
export async function syncFinancialData(opts: SyncOptions): Promise<SyncResult> {
  const { userId, syncType } = opts;
  const db = getFinanceDb();
  const stripe = getStripe();

  // Which connections are in scope?
  let query = db
    .from("financial_connections")
    .select("id, stripe_account_holder_id, connection_status")
    .eq("user_id", userId)
    .neq("connection_status", "disconnected");
  if (opts.connectionId) query = query.eq("id", opts.connectionId);
  const { data: connections, error: connErr } = await query;
  if (connErr) throw connErr;

  const runId = await startRun(db, userId, opts.connectionId ?? null, syncType);
  const result: SyncResult = {
    runId,
    status: "success",
    accountsProcessed: 0,
    transactionsInserted: 0,
    transactionsUpdated: 0,
    errorCode: null,
    accountErrors: [],
  };

  if (!connections || connections.length === 0) {
    await finishRun(db, runId, { ...result, status: "success" });
    return result;
  }

  const nowIso = new Date().toISOString();

  for (const conn of connections) {
    await db
      .from("financial_connections")
      .update({ last_attempted_sync_at: nowIso })
      .eq("id", conn.id)
      .eq("user_id", userId);

    let connectionFailed = false;
    let connectionNeedsRelink = false;

    try {
      // Which accounts belong to this connection? Ask Stripe (authoritative)
      // rather than trusting our own copy, so accounts removed at the bank are
      // seen as inactive on the very next sync.
      const stripeAccounts: Stripe.FinancialConnections.Account[] = [];
      for await (const acct of stripe.financialConnections.accounts.list({
        account_holder: { customer: conn.stripe_account_holder_id },
        limit: PAGE_SIZE,
      })) {
        if (opts.stripeAccountIds?.length && !opts.stripeAccountIds.includes(acct.id)) continue;
        stripeAccounts.push(acct);
      }

      for (const stripeAccount of stripeAccounts) {
        try {
          // Optionally ask the institution for fresh data first. Bounded by
          // Stripe's own next_refresh_available_at — asking too soon errors, so
          // we check before spending the call.
          if (opts.requestRefresh) {
            await requestAccountRefresh(stripe, stripeAccount);
          }

          const fresh = opts.requestRefresh
            ? await stripe.financialConnections.accounts.retrieve(stripeAccount.id)
            : stripeAccount;

          const { id: localId, accountType } = await upsertAccount(db, userId, conn.id, fresh);
          result.accountsProcessed++;

          if (fresh.status_details?.active?.action === "relink_required" || fresh.status === "inactive") {
            connectionNeedsRelink = true;
          }
          if (fresh.status === "disconnected") continue;

          // No transaction permission → nothing to import, and that is not an
          // error. Record it so the UI can offer "reconnect with transactions".
          if (!fresh.permissions?.includes("transactions")) {
            result.accountErrors.push({ stripeAccountId: fresh.id, code: "no_transaction_permission" });
            continue;
          }

          const { data: local } = await db
            .from("financial_accounts")
            .select("last_transaction_refresh_id")
            .eq("id", localId)
            .eq("user_id", userId)
            .maybeSingle();

          const stats = await importTransactions(
            db, stripe, userId, localId, fresh.id, accountType,
            {
              fullHistory: opts.fullHistory ?? syncType === "initial",
              sinceRefreshId: syncType === "initial" ? null : local?.last_transaction_refresh_id ?? null,
            },
          );
          result.transactionsInserted += stats.inserted;
          result.transactionsUpdated += stats.updated;

          // Keep Stripe pushing us transaction updates so scheduled refreshes
          // stay cheap. Best-effort: an unsupported account must not fail the run.
          await ensureTransactionSubscription(stripe, fresh);
        } catch (accountErr) {
          const code = logFinanceError("syncAccount", accountErr, {
            userId: userId.slice(0, 8),
            stripeAccountId: stripeAccount.id,
          });
          result.accountErrors.push({ stripeAccountId: stripeAccount.id, code });
          if (code === "relink_required" || code === "account_inactive") connectionNeedsRelink = true;
        }
      }
    } catch (connError) {
      connectionFailed = true;
      const code = logFinanceError("syncConnection", connError, {
        userId: userId.slice(0, 8), connectionId: conn.id,
      });
      result.errorCode = code;
      if (code === "relink_required" || code === "account_inactive") connectionNeedsRelink = true;
    }

    const hadAccountErrors = result.accountErrors.length > 0;
    const connStatus = connectionFailed ? "failed"
      : connectionNeedsRelink ? "action_required"
        : "active";
    const syncStatus = connectionFailed ? "failed" : hadAccountErrors ? "partial" : "success";

    await db
      .from("financial_connections")
      .update({
        connection_status: connStatus,
        last_sync_status: syncStatus,
        last_sync_error: connectionFailed || hadAccountErrors
          ? result.errorCode ?? result.accountErrors[0]?.code ?? null
          : null,
        ...(syncStatus === "success" ? { last_successful_sync_at: new Date().toISOString() } : {}),
      })
      .eq("id", conn.id)
      .eq("user_id", userId);
  }

  // Analysis runs once per sync over everything imported.
  try {
    await analyzeRecent(db, userId);
  } catch (e) {
    logFinanceError("analyzeRecent", e, { userId: userId.slice(0, 8) });
  }

  result.status = result.errorCode ? "failed"
    : result.accountErrors.length > 0 ? "partial"
      : "success";
  if (result.status === "partial" && !result.errorCode) result.errorCode = "partial_import";

  await finishRun(db, runId, result);
  return result;
}

/**
 * Ask Stripe to pull fresh balances (and transactions) from the institution.
 *
 * Stripe rate-limits refreshes per account via `next_refresh_available_at`;
 * calling early is an error, so we skip rather than burn a failed call. A
 * refresh that cannot run yet is not a sync failure — the stored data is simply
 * still current enough.
 */
async function requestAccountRefresh(
  stripe: Stripe,
  account: Stripe.FinancialConnections.Account,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const features: Array<"balance" | "transactions"> = [];

  const balanceReady =
    account.permissions?.includes("balances") &&
    (!account.balance_refresh?.next_refresh_available_at ||
      account.balance_refresh.next_refresh_available_at <= now) &&
    account.balance_refresh?.status !== "pending";
  if (balanceReady) features.push("balance");

  const txnReady =
    account.permissions?.includes("transactions") &&
    (!account.transaction_refresh?.next_refresh_available_at ||
      account.transaction_refresh.next_refresh_available_at <= now) &&
    account.transaction_refresh?.status !== "pending";
  if (txnReady) features.push("transactions");

  if (features.length === 0) return;
  try {
    await stripe.financialConnections.accounts.refresh(account.id, { features });
  } catch (e) {
    // Refresh unavailable / not supported by this institution — log and move on
    // with whatever data Stripe already has.
    logFinanceError("requestAccountRefresh", e, { stripeAccountId: account.id });
  }
}

/**
 * Subscribe the account to Stripe's periodic transaction refreshes so daily
 * data arrives by webhook instead of us polling. Best-effort by design.
 */
async function ensureTransactionSubscription(
  stripe: Stripe,
  account: Stripe.FinancialConnections.Account,
): Promise<void> {
  if (!account.permissions?.includes("transactions")) return;
  if (account.subscriptions?.includes("transactions")) return;
  if (account.status !== "active") return;
  try {
    await stripe.financialConnections.accounts.subscribe(account.id, { features: ["transactions"] });
  } catch (e) {
    logFinanceError("ensureTransactionSubscription", e, { stripeAccountId: account.id });
  }
}

/**
 * Import the accounts a just-completed Financial Connections Session produced,
 * then do the initial full history pull.
 *
 * The session is retrieved SERVER-side from Stripe — the browser only tells us
 * which session it finished, and we verify that session belongs to this user's
 * account holder before importing anything.
 */
export async function completeConnectionSession(
  userId: string,
  sessionId: string,
): Promise<{ connectionId: string; accountCount: number; sync: SyncResult }> {
  const db = getFinanceDb();
  const stripe = getStripe();

  const session = await stripe.financialConnections.sessions.retrieve(sessionId, {
    expand: ["accounts"],
  });

  // AUTHORIZATION CHECK: the session's account holder must be THIS user's
  // Stripe customer. Without this, knowing a session id would be enough to
  // attach someone else's accounts to your Portol account.
  const holder = session.account_holder;
  const customerId =
    typeof holder?.customer === "string" ? holder.customer : holder?.customer?.id ?? null;
  const ownerUserId = customerId ? await userIdForCustomer(customerId) : null;
  if (!customerId || ownerUserId !== userId) {
    throw new FinanceConfigError("unknown", "Session does not belong to the authenticated user.");
  }

  const accounts = session.accounts?.data ?? [];
  const institution = accounts[0]?.institution_name ?? null;

  // One connection row per session, re-usable if the callback is retried.
  const { data: existingConn } = await db
    .from("financial_connections")
    .select("id")
    .eq("user_id", userId)
    .eq("stripe_session_id", session.id)
    .maybeSingle();

  let connectionId: string;
  if (existingConn?.id) {
    connectionId = existingConn.id;
    await db
      .from("financial_connections")
      .update({
        institution_name: institution,
        connection_status: accounts.length > 0 ? "active" : "failed",
        disconnected_at: null,
      })
      .eq("id", connectionId)
      .eq("user_id", userId);
  } else {
    const { data, error } = await db
      .from("financial_connections")
      .insert({
        user_id: userId,
        stripe_account_holder_id: customerId,
        stripe_session_id: session.id,
        institution_name: institution,
        connection_status: accounts.length > 0 ? "active" : "failed",
      })
      .select("id")
      .single();
    if (error) throw error;
    connectionId = data.id;
  }

  // Save every account the user chose in this session — multi-select is normal.
  for (const account of accounts) {
    try {
      await upsertAccount(db, userId, connectionId, account);
    } catch (e) {
      logFinanceError("completeConnectionSession.upsertAccount", e, {
        userId: userId.slice(0, 8), stripeAccountId: account.id,
      });
    }
  }

  const sync = await syncFinancialData({
    userId,
    syncType: "initial",
    connectionId,
    fullHistory: true,
  });

  return { connectionId, accountCount: accounts.length, sync };
}

/**
 * Stop syncing an institution.
 *
 * `deleteData: false` (the default) revokes Stripe's access and marks the
 * connection disconnected while KEEPING everything already imported — the user
 * asked to stop syncing, not to lose their history.
 */
export async function disconnectConnection(
  userId: string,
  connectionId: string,
  opts: { deleteData?: boolean } = {},
): Promise<{ accountsDisconnected: number; transactionsDeleted: number }> {
  const db = getFinanceDb();

  const { data: accounts, error } = await db
    .from("financial_accounts")
    .select("id, stripe_financial_connections_account_id")
    .eq("user_id", userId)
    .eq("financial_connection_id", connectionId);
  if (error) throw error;

  // Revoke at Stripe first. If this fails we still mark the connection
  // disconnected locally — the user's intent is honoured either way, and the
  // failure is logged for follow-up.
  let stripe: Stripe | null = null;
  try { stripe = getStripe(); } catch { stripe = null; }
  if (stripe) {
    for (const a of accounts ?? []) {
      try {
        await stripe.financialConnections.accounts.disconnect(a.stripe_financial_connections_account_id);
      } catch (e) {
        logFinanceError("disconnectAccount", e, { stripeAccountId: a.stripe_financial_connections_account_id });
      }
    }
  }

  let transactionsDeleted = 0;
  if (opts.deleteData) {
    const accountIds = (accounts ?? []).map((a) => a.id);
    if (accountIds.length > 0) {
      const { count } = await db
        .from("financial_transactions")
        .delete({ count: "exact" })
        .eq("user_id", userId)
        .in("financial_account_id", accountIds);
      transactionsDeleted = count ?? 0;
      // Overrides and transfer links cascade from the transaction rows.
      await db.from("financial_accounts").delete().eq("user_id", userId).in("id", accountIds);
    }
    // Manual profiles previously matched to these accounts are untouched by
    // design — deleting connected data must never delete what the user typed.
  } else {
    await db
      .from("financial_accounts")
      .update({ status: "disconnected" })
      .eq("user_id", userId)
      .eq("financial_connection_id", connectionId);
  }

  await db
    .from("financial_connections")
    .update({
      connection_status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("id", connectionId)
    .eq("user_id", userId);

  return { accountsDisconnected: accounts?.length ?? 0, transactionsDeleted };
}
