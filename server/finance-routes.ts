/**
 * `/api/finance/*` — Stripe Financial Connections HTTP surface.
 *
 * SECURITY MODEL
 * --------------
 *   * The user is ALWAYS taken from `req.userId`, set by authMiddleware after
 *     verifying the Supabase JWT. No handler reads a user id from the body,
 *     the query string or a header. A request that says "sync user X" syncs the
 *     caller, because the caller is the only user this file can name.
 *   * The browser receives the session CLIENT SECRET and nothing else — never
 *     the Stripe secret key, never the webhook secret, never the service role
 *     key. `/config` hands out only a `pk_`-prefixed publishable key.
 *   * Errors leave as a stable code plus a friendly sentence. Raw Stripe
 *     messages, request bodies and stack traces stay in the server log.
 *   * The webhook is the ONE unauthenticated route here; it authenticates by
 *     Stripe signature over the RAW body instead.
 */

import type { Express, Request, Response, NextFunction } from "express";
import express from "express";
import { z } from "zod";
import {
  assertStripeConfigured, assertWebhookConfigured, classifyStripeError,
  FinanceConfigError, getFinanceDb, getStripe, logFinanceError,
  publishableKeyForClient, stripeConfigStatus,
} from "./stripe-config";
import {
  completeConnectionSession, disconnectConnection, ensureAccountHolder,
  syncFinancialData, userIdForCustomer, userIdForStripeAccount, upsertAccount,
} from "./finance-sync";
import {
  getAccounts, getAllTransactionsInRange, getConfirmedTransferIds, getConnections,
  getSyncRuns, getTransactions, mapAccount,
} from "./finance-data";
import {
  calculateIncomeBySource, calculateMonthlyComparison, calculateNetCashFlow,
  calculateNetWorth, calculateSpendingByAccount, calculateSpendingByCategory,
  calculateSpendingByMerchant, calculateSpendingByPeriod, dataFreshness,
  detectLikelyRecurringTransactions, detectUnusualSpending, monthBounds,
  type CalcScope, type ManualHolding,
} from "@shared/finance-calc";
import { majorToMinor } from "@shared/money";
import { getUserCurrentMonth } from "@shared/timezone";
import { financeErrorMessage, isDebtAccount } from "@shared/finance-connections";
import {
  ASSET_PROFILE_TYPES, LIABILITY_PROFILE_TYPES, isAssetProfile, isLiabilityProfile,
  resolveAssetValue, resolveLiabilityBalance,
} from "@shared/asset-value";
import { storage } from "./storage";
import { reconcileConnectedAccountProfiles } from "./financial-asset-sync";
import { findAccountMatch, observationFromConnectedAccount } from "@shared/financial-reconcile";
import { minorPerMajor } from "@shared/money";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** The authenticated user, or a 401. Never trusts anything client-supplied. */
function requireUser(req: Request, res: Response): string | null {
  const userId = (req as any).userId as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
    return null;
  }
  return userId;
}

/**
 * Turn any thrown error into the redacted `{ code, error }` shape.
 * The message the user reads comes from a fixed table in shared code, so a
 * Stripe internal can never become UI copy.
 */
function failure(res: Response, context: string, err: unknown, meta: Record<string, unknown> = {}) {
  const code = logFinanceError(context, err, meta);
  const status = err instanceof FinanceConfigError ? 503
    : code === "rate_limited" ? 429
      : code === "stripe_unavailable" ? 503
        : 400;
  return res.status(status).json({ code, error: financeErrorMessage(code) });
}

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try { await fn(req, res); }
    catch (err) {
      if (res.headersSent) return next(err);
      failure(res, `${req.method} ${req.path}`, err);
    }
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** The caller's current month (X-Timezone header), never the host's UTC month. */
function currentMonthFor(req: Request): string {
  const tz = req.headers["x-timezone"];
  return getUserCurrentMonth(typeof tz === "string" && tz.trim() ? tz.trim() : undefined);
}

function scopeFromQuery(req: Request): CalcScope {
  const q = req.query as Record<string, string | undefined>;
  const accountIds = (q.accountIds || q.account_ids || "").split(",").map((s) => s.trim()).filter(Boolean);
  const excludeIds = (q.excludeAccountIds || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    startDate: isoDate.safeParse(q.startDate ?? q.start_date).success ? (q.startDate ?? q.start_date) : undefined,
    endDate: isoDate.safeParse(q.endDate ?? q.end_date).success ? (q.endDate ?? q.end_date) : undefined,
    includeAccountIds: accountIds.length ? accountIds : undefined,
    excludeAccountIds: excludeIds.length ? excludeIds : undefined,
    currency: q.currency || undefined,
    statuses: q.status === "posted" ? ["posted"] : q.status === "pending" ? ["pending"] : undefined,
  };
}

/**
 * Manual assets and liabilities, converted to minor units so they can be added
 * to connected balances without float drift.
 *
 * Reads through the existing profile store (which is already user-scoped by the
 * request context), preserving all the ownership/valuation rules the manual
 * finance model already applies.
 */
async function loadManualHoldings(): Promise<ManualHolding[]> {
  const profiles: any[] = await (storage as any).getProfiles();
  const out: ManualHolding[] = [];
  for (const p of profiles ?? []) {
    if (isAssetProfile(p)) {
      const value = resolveAssetValue(p);
      if (value) out.push({ id: p.id, name: p.name, amount: majorToMinor(value), currency: "usd", kind: "asset" });
    } else if (isLiabilityProfile(p)) {
      const balance = resolveLiabilityBalance(p);
      if (balance) out.push({ id: p.id, name: p.name, amount: majorToMinor(balance), currency: "usd", kind: "liability" });
    }
  }
  return out;
}

// ── Refresh rate limiting ───────────────────────────────────────────────────
// Refreshing hits Stripe (and the institution) and costs money. Bound it per
// user. In-memory is enough: the worst case on a cold serverless instance is
// one extra refresh, and Stripe's own next_refresh_available_at is the real
// backstop.
const REFRESH_MIN_INTERVAL_MS = 60_000;
const lastRefreshAt = new Map<string, number>();
const REFRESH_MAP_MAX = 5000;

function refreshAllowed(userId: string): { allowed: boolean; retryAfterSec: number } {
  const last = lastRefreshAt.get(userId);
  const now = Date.now();
  if (last && now - last < REFRESH_MIN_INTERVAL_MS) {
    return { allowed: false, retryAfterSec: Math.ceil((REFRESH_MIN_INTERVAL_MS - (now - last)) / 1000) };
  }
  if (lastRefreshAt.size >= REFRESH_MAP_MAX) {
    for (const [k, v] of lastRefreshAt) {
      if (now - v > REFRESH_MIN_INTERVAL_MS) lastRefreshAt.delete(k);
      if (lastRefreshAt.size < REFRESH_MAP_MAX) break;
    }
  }
  lastRefreshAt.set(userId, now);
  return { allowed: true, retryAfterSec: 0 };
}

/** Test seam. */
export function __resetRefreshLimiter(): void { lastRefreshAt.clear(); }

// ────────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────────

export function registerFinanceRoutes(app: Express): void {
  // ── Config (public shape, publishable key only) ───────────────────────────
  app.get("/api/finance/config", wrap(async (req, res) => {
    if (!requireUser(req, res)) return;
    const status = stripeConfigStatus();
    res.json({
      configured: status.configured,
      webhooksConfigured: status.webhooksConfigured,
      livemode: status.livemode,
      publishableKey: publishableKeyForClient(),
      // Names of missing variables help the operator; they are not secrets.
      missing: status.missing,
    });
  }));

  // ── Connection state for Settings ────────────────────────────────────────
  app.get("/api/finance/connections", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const config = stripeConfigStatus();
    if (!config.configured) {
      return res.json({
        configured: false, connections: [], accounts: [], lastSync: null, status: "not_connected",
      });
    }

    const [connections, accounts, runs] = await Promise.all([
      getConnections(userId),
      getAccounts(userId, { includeHidden: true }),
      getSyncRuns(userId, 1),
    ]);

    const live = connections.filter((c) => c.connectionStatus !== "disconnected");
    const status = live.length === 0 ? "not_connected"
      : live.some((c) => c.connectionStatus === "action_required") ? "action_required"
        : live.some((c) => c.connectionStatus === "failed") ? "failed"
          : "connected";

    res.json({
      configured: true,
      livemode: config.livemode,
      connections, accounts,
      lastSync: runs[0] ?? null,
      status,
    });
  }));

  app.get("/api/finance/sync-runs", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json({ runs: await getSyncRuns(userId, 20) });
  }));

  // ── Create a Financial Connections Session ───────────────────────────────
  // Returns ONLY the client secret and session id. The account holder comes
  // from the server-maintained mapping, never from the request body.
  app.post("/api/finance/connections/session", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try {
      assertStripeConfigured();
    } catch (e) {
      return failure(res, "session.config", e);
    }

    const email = (req as any).userEmail as string | undefined;
    const { customerId } = await ensureAccountHolder(userId, email);
    const stripe = getStripe();

    const session = await stripe.financialConnections.sessions.create({
      account_holder: { type: "customer", customer: customerId },
      // Exactly what the Settings copy promises the user: account details,
      // balances and transactions. `ownership` is what backs "account details"
      // (name on the account); `payment_method` is NOT requested — Portol has
      // no reason to be able to move money.
      permissions: ["balances", "transactions", "ownership"],
      // Warm the data during the flow so the first Finance-tab render is not
      // an empty state waiting on a refresh.
      prefetch: ["balances", "transactions", "ownership"],
      filters: { countries: ["US"] },
    });

    res.json({
      clientSecret: session.client_secret,
      sessionId: session.id,
      livemode: session.livemode,
    });
  }));

  // ── Complete a session (client tells us which one it finished) ───────────
  const completeSchema = z.object({ sessionId: z.string().min(10).max(200) });
  app.post("/api/finance/connections/complete", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ code: "unknown", error: financeErrorMessage("unknown") });

    // completeConnectionSession re-reads the session from Stripe and verifies
    // its account holder maps to THIS user before importing anything.
    const result = await completeConnectionSession(userId, parsed.data.sessionId);
    res.json({
      connectionId: result.connectionId,
      accountCount: result.accountCount,
      sync: {
        status: result.sync.status,
        accountsProcessed: result.sync.accountsProcessed,
        transactionsInserted: result.sync.transactionsInserted,
        transactionsUpdated: result.sync.transactionsUpdated,
        errorCode: result.sync.errorCode,
      },
    });
  }));

  /** The user closed or cancelled Stripe's modal. Clean up the pending state. */
  app.post("/api/finance/connections/cancel", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const db = getFinanceDb();
    // Only ever touches rows that never produced an account.
    await db
      .from("financial_connections")
      .update({ connection_status: "disconnected", disconnected_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("connection_status", "connecting");
    res.json({ ok: true });
  }));

  // ── Manual refresh ───────────────────────────────────────────────────────
  app.post("/api/finance/refresh", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    try { assertStripeConfigured(); }
    catch (e) { return failure(res, "refresh.config", e); }

    const gate = refreshAllowed(userId);
    if (!gate.allowed) {
      res.setHeader("Retry-After", String(gate.retryAfterSec));
      return res.status(429).json({ code: "rate_limited", error: financeErrorMessage("rate_limited") });
    }

    const connectionId = typeof req.body?.connectionId === "string" ? req.body.connectionId : undefined;
    const result = await syncFinancialData({
      userId,
      syncType: "manual",
      connectionId,
      requestRefresh: true,
    });

    res.json({
      status: result.status,
      accountsProcessed: result.accountsProcessed,
      transactionsInserted: result.transactionsInserted,
      transactionsUpdated: result.transactionsUpdated,
      errorCode: result.errorCode,
      // Codes only — the client maps them to copy.
      accountErrors: result.accountErrors.map((e) => e.code),
    });
  }));

  // ── Disconnect ───────────────────────────────────────────────────────────
  const disconnectSchema = z.object({ deleteData: z.boolean().optional() });
  app.post("/api/finance/connections/:id/disconnect", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = disconnectSchema.safeParse(req.body ?? {});
    const deleteData = parsed.success ? !!parsed.data.deleteData : false;

    // Ownership check before anything destructive.
    const db = getFinanceDb();
    const { data: conn } = await db
      .from("financial_connections")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!conn) return res.status(404).json({ code: "unknown", error: "Connection not found." });

    const result = await disconnectConnection(userId, String(req.params.id), { deleteData });
    console.log("[finance]", JSON.stringify({
      context: "disconnect", userId: userId.slice(0, 8), connectionId: req.params.id,
      deleteData, ...result,
    }));
    res.json({ ok: true, deleteData, ...result });
  }));

  // ── Accounts ─────────────────────────────────────────────────────────────
  app.get("/api/finance/accounts", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json({ accounts: await getAccounts(userId, { includeHidden: true }) });
  }));

  const accountPatchSchema = z.object({
    accountDisplayName: z.string().trim().min(1).max(120).optional(),
    isHidden: z.boolean().optional(),
    includeInNetWorth: z.boolean().optional(),
    // null clears an existing match.
    matchedProfileId: z.string().uuid().nullable().optional(),
  });

  app.patch("/api/finance/accounts/:id", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = accountPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ code: "unknown", error: "Invalid account update." });

    const patch: Record<string, unknown> = {};
    if (parsed.data.accountDisplayName !== undefined) patch.account_display_name = parsed.data.accountDisplayName;
    if (parsed.data.isHidden !== undefined) patch.is_hidden = parsed.data.isHidden;
    if (parsed.data.includeInNetWorth !== undefined) patch.include_in_net_worth = parsed.data.includeInNetWorth;

    if (parsed.data.matchedProfileId !== undefined) {
      if (parsed.data.matchedProfileId === null) {
        patch.matched_profile_id = null;
        // A deliberate unlink: the sync must not re-attach or recreate a profile.
        patch.profile_unlinked_at = new Date().toISOString();
      } else {
        patch.profile_unlinked_at = null;
        // The profile must belong to the caller. Without this check a user
        // could link their account to a stranger's profile id.
        const profile = await (storage as any).getProfile(parsed.data.matchedProfileId);
        if (!profile) return res.status(404).json({ code: "unknown", error: "Profile not found." });
        patch.matched_profile_id = parsed.data.matchedProfileId;
      }
    }

    if (Object.keys(patch).length === 0) return res.json({ ok: true });

    const db = getFinanceDb();
    const { data, error } = await db
      .from("financial_accounts")
      .update(patch)
      .eq("id", req.params.id)
      .eq("user_id", userId)   // isolation: another user's row simply does not match
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ code: "unknown", error: "Account not found." });
    if (typeof parsed.data.matchedProfileId === "string") {
      // The newly linked profile takes on the connection and this balance as
      // an API observation right away, not on the next scheduled sync.
      await reconcileConnectedAccountProfiles(userId, { db, accountIds: [String(req.params.id)] }).catch(() => null);
    }
    res.json({ account: mapAccount(data) });
  }));

  /**
   * Manual↔connected match candidates.
   *
   * Suggests "is this connected Bank of America checking the same as your
   * manually entered checking asset?" by comparing institution/name/last-four.
   * Suggestion only — nothing is linked without the user saying so.
   */
  app.get("/api/finance/match-candidates", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const accounts = (await getAccounts(userId, { includeHidden: true })).filter((a) => !a.matchedProfileId);
    const profiles: any[] = await (storage as any).getProfiles();
    const alreadyMatched = new Set(
      (await getAccounts(userId, { includeHidden: true }))
        .map((a) => a.matchedProfileId).filter(Boolean) as string[],
    );

    const candidates = accounts.map((account) => {
      // One matcher for every source (shared/financial-reconcile): the same
      // institution / last-four / kind / owner / currency scoring the sync and
      // the import use, so a suggestion here is the link the sync would make.
      const obs = observationFromConnectedAccount(account, minorPerMajor(account.currency));
      const match = findAccountMatch(obs, (profiles ?? []).filter((p) => !alreadyMatched.has(p.id)));
      const suggestions = match.candidates
        .filter((c) => c.confidence !== "none")
        .slice(0, 3)
        .map((c) => ({ profileId: c.profileId, profileName: c.profileName, score: c.score, confidence: c.confidence, reasons: c.reasons }));
      return { accountId: account.id, accountLabel: accountLabel(account), decision: match.decision, suggestions };
    }).filter((c) => c.suggestions.length > 0);

    res.json({ candidates });
  }));

  // ── Transactions ─────────────────────────────────────────────────────────
  app.get("/api/finance/transactions", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const q = req.query as Record<string, string | undefined>;
    const accountIds = (q.accountIds || "").split(",").map((s) => s.trim()).filter(Boolean);
    const statuses = (q.status || "").split(",").map((s) => s.trim()).filter(Boolean)
      .filter((s): s is "pending" | "posted" | "void" => s === "pending" || s === "posted" || s === "void");

    const { transactions, total } = await getTransactions(userId, {
      startDate: isoDate.safeParse(q.startDate).success ? q.startDate : undefined,
      endDate: isoDate.safeParse(q.endDate).success ? q.endDate : undefined,
      accountIds: accountIds.length ? accountIds : undefined,
      search: q.search || undefined,
      category: q.category && q.category !== "all" ? q.category : undefined,
      transactionType: (q.type as any) || "all",
      status: statuses.length ? statuses : undefined,
      minAmountMinor: q.minAmount ? majorToMinor(q.minAmount) : undefined,
      maxAmountMinor: q.maxAmount ? majorToMinor(q.maxAmount) : undefined,
      limit: q.limit ? Number(q.limit) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    });

    const { groupByTxnId } = await getConfirmedTransferIds(userId);
    res.json({
      transactions: transactions.map((t) => ({ ...t, transferGroupId: groupByTxnId.get(t.id) ?? null })),
      total,
    });
  }));

  /**
   * User corrections. Written to `financial_transaction_overrides`, NEVER to
   * the imported row — that is what keeps a later sync from undoing the user's
   * work. `null` on a field clears the correction and restores the bank's value.
   */
  const overrideSchema = z.object({
    category: z.string().trim().max(60).nullable().optional(),
    subcategory: z.string().trim().max(60).nullable().optional(),
    merchantName: z.string().trim().max(120).nullable().optional(),
    isIncome: z.boolean().nullable().optional(),
    isExpense: z.boolean().nullable().optional(),
    isTransfer: z.boolean().nullable().optional(),
    isRefund: z.boolean().nullable().optional(),
    excludedFromTotals: z.boolean().nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    linkedProfileId: z.string().uuid().nullable().optional(),
    linkedSubscriptionProfileId: z.string().uuid().nullable().optional(),
    linkedLiabilityProfileId: z.string().uuid().nullable().optional(),
    linkedAssetProfileId: z.string().uuid().nullable().optional(),
    budgetCategory: z.string().trim().max(60).nullable().optional(),
  });

  app.patch("/api/finance/transactions/:id", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const parsed = overrideSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ code: "unknown", error: "Invalid transaction update." });

    const db = getFinanceDb();
    const { data: txn } = await db
      .from("financial_transactions")
      .select("id")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!txn) return res.status(404).json({ code: "unknown", error: "Transaction not found." });

    // Any linked profile must be the caller's own.
    for (const key of ["linkedProfileId", "linkedSubscriptionProfileId", "linkedLiabilityProfileId", "linkedAssetProfileId"] as const) {
      const value = parsed.data[key];
      if (value) {
        const profile = await (storage as any).getProfile(value);
        if (!profile) return res.status(404).json({ code: "unknown", error: "Linked record not found." });
      }
    }

    const patch: Record<string, unknown> = {
      user_id: userId,
      financial_transaction_id: req.params.id,
    };
    const map: Record<string, string> = {
      category: "category", subcategory: "subcategory", merchantName: "merchant_name",
      isIncome: "is_income", isExpense: "is_expense", isTransfer: "is_transfer",
      isRefund: "is_refund", excludedFromTotals: "excluded_from_totals", note: "note",
      linkedProfileId: "linked_profile_id",
      linkedSubscriptionProfileId: "linked_subscription_profile_id",
      linkedLiabilityProfileId: "linked_liability_profile_id",
      linkedAssetProfileId: "linked_asset_profile_id",
      budgetCategory: "budget_category",
    };
    for (const [k, column] of Object.entries(map)) {
      const value = (parsed.data as any)[k];
      if (value !== undefined) patch[column] = value;
    }

    const { data, error } = await db
      .from("financial_transaction_overrides")
      .upsert(patch, { onConflict: "financial_transaction_id" })
      .select("*")
      .single();
    if (error) throw error;
    res.json({ ok: true, override: data });
  }));

  // ── Transfers ────────────────────────────────────────────────────────────
  app.get("/api/finance/transfers", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const db = getFinanceDb();
    const { data, error } = await db
      .from("financial_transfer_links")
      .select("*")
      .eq("user_id", userId)
      .neq("state", "rejected")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const txnIds = Array.from(new Set((data ?? []).flatMap((l: any) => [l.outflow_transaction_id, l.inflow_transaction_id])));
    const accounts = await getAccounts(userId, { includeHidden: true });
    const accountsById = new Map(accounts.map((a) => [a.id, a]));

    const { data: txnRows } = txnIds.length
      ? await db.from("financial_transactions").select("*").eq("user_id", userId).in("id", txnIds)
      : { data: [] as any[] };
    const { mapTransaction } = await import("./finance-data");
    const byId = new Map((txnRows ?? []).map((r: any) => [r.id, mapTransaction(r, accountsById)]));

    res.json({
      transfers: (data ?? []).map((l: any) => ({
        id: l.id,
        transferGroupId: l.transfer_group_id,
        state: l.state,
        confidence: Number(l.confidence),
        signals: l.signals,
        outflow: byId.get(l.outflow_transaction_id) ?? null,
        inflow: byId.get(l.inflow_transaction_id) ?? null,
      })),
    });
  }));

  app.post("/api/finance/transfers/:id", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const state = req.body?.state;
    if (state !== "confirmed" && state !== "rejected") {
      return res.status(400).json({ code: "unknown", error: "State must be confirmed or rejected." });
    }
    const db = getFinanceDb();
    const { data, error } = await db
      .from("financial_transfer_links")
      .update({ state })
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ code: "unknown", error: "Transfer not found." });
    res.json({ ok: true, state });
  }));

  // ── Recurring ────────────────────────────────────────────────────────────
  app.get("/api/finance/recurring", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const since = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const transactions = await getAllTransactionsInRange(userId, since, undefined);
    res.json({ recurring: detectLikelyRecurringTransactions(transactions) });
  }));

  // ── Aggregate views ──────────────────────────────────────────────────────
  app.get("/api/finance/summary", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json(await buildSummary(userId, scopeFromQuery(req), { month: currentMonthFor(req) }));
  }));

  app.get("/api/finance/cashflow", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const scope = scopeFromQuery(req);
    const [accounts, transferInfo] = await Promise.all([
      getAccounts(userId), getConfirmedTransferIds(userId),
    ]);
    const transactions = await getAllTransactionsInRange(userId, scope.startDate, scope.endDate, { accounts });
    const cashflow = calculateNetCashFlow(transactions, scope, {
      confirmedTransferIds: transferInfo.ids, topN: 8,
    });
    res.json({
      ...cashflow,
      uncertainTransferCount: transferInfo.detected,
      freshness: dataFreshness(accounts),
    });
  }));

  app.get("/api/finance/spending", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const scope = scopeFromQuery(req);
    const groupBy = String((req.query as any).groupBy ?? "category");

    const [accounts, transferInfo] = await Promise.all([
      getAccounts(userId), getConfirmedTransferIds(userId),
    ]);
    // A month comparison needs the previous month too, so widen the fetch.
    const month = scope.startDate?.slice(0, 7) ?? currentMonthFor(req);
    const fetchStart = monthBounds(month).start;
    const wideStart = scope.startDate && scope.startDate < fetchStart ? scope.startDate : `${prevMonthOf(month)}-01`;
    const transactions = await getAllTransactionsInRange(userId, wideStart, scope.endDate, { accounts });

    const breakdown =
      groupBy === "merchant" ? calculateSpendingByMerchant(transactions, scope, transferInfo.ids)
        : groupBy === "account" ? calculateSpendingByAccount(transactions, scope, transferInfo.ids)
          : groupBy === "week" || groupBy === "month"
            ? calculateSpendingByPeriod(transactions, groupBy, scope, transferInfo.ids)
            : calculateSpendingByCategory(transactions, scope, transferInfo.ids);

    const comparison = calculateMonthlyComparison(transactions, month, scope, {
      confirmedTransferIds: transferInfo.ids,
    });

    res.json({
      groupBy,
      breakdown,
      comparison,
      unusual: detectUnusualSpending(transactions, scope).slice(0, 10),
      recurring: detectLikelyRecurringTransactions(transactions).filter((r) => r.direction === "expense").slice(0, 20),
      freshness: dataFreshness(accounts),
    });
  }));

  app.get("/api/finance/income", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const scope = scopeFromQuery(req);
    const [accounts, transferInfo] = await Promise.all([
      getAccounts(userId), getConfirmedTransferIds(userId),
    ]);
    const month = scope.startDate?.slice(0, 7) ?? currentMonthFor(req);
    const transactions = await getAllTransactionsInRange(userId, `${prevMonthOf(month)}-01`, scope.endDate, { accounts });

    const income = calculateIncomeBySource(transactions, scope, transferInfo.ids);
    res.json({
      total: income.total,
      bySource: income.bySource,
      // "Deposits requiring review" — positive amounts we deliberately refused
      // to call income.
      needsReview: income.needsReview.slice(0, 50),
      recurring: detectLikelyRecurringTransactions(transactions).filter((r) => r.direction === "income"),
      comparison: calculateMonthlyComparison(transactions, month, scope, { confirmedTransferIds: transferInfo.ids }),
      freshness: dataFreshness(accounts),
    });
  }));

  /**
   * Connected debt accounts.
   *
   * Stripe Financial Connections does NOT return minimum payment, due date or
   * APR, so those come back as null and the UI must render "Not provided by
   * institution". We do not invent them.
   */
  app.get("/api/finance/liabilities", wrap(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const accounts = await getAccounts(userId, { includeHidden: true });
    res.json({
      liabilities: accounts
        .filter((a) => isDebtAccount(a.accountType))
        .map((a) => ({
          account: a,
          currentBalance: a.currentBalance,
          currency: a.currency,
          institutionName: a.institutionName,
          accountType: a.accountType,
          includeInNetWorth: a.includeInNetWorth,
          // Explicitly null: Stripe has no field for these.
          minimumPayment: null,
          paymentDueDate: null,
          interestRate: null,
          unavailableFields: ["minimumPayment", "paymentDueDate", "interestRate"],
        })),
    });
  }));

  // ── Webhook ──────────────────────────────────────────────────────────────
  registerWebhook(app);
}

function prevMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function accountLabel(a: { accountDisplayName: string | null; institutionName: string | null; lastFour: string | null }): string {
  return [a.institutionName, a.accountDisplayName, a.lastFour ? `••${a.lastFour}` : null]
    .filter(Boolean).join(" ");
}

/**
 * The Finance-tab headline. Shared by `/api/finance/summary` and the Claude
 * `get_financial_summary` tool so the number Claude quotes is the number the
 * screen shows.
 */
export async function buildSummary(userId: string, scope: CalcScope, opts: { month?: string } = {}) {
  const [accounts, transferInfo, manual] = await Promise.all([
    getAccounts(userId),
    getConfirmedTransferIds(userId),
    loadManualHoldings().catch(() => [] as ManualHolding[]),
  ]);

  // A scope without dates means the caller's current month — the user's
  // month, which the route and the chat tool pass; the host's UTC month is
  // only the last resort.
  const month = scope.startDate?.slice(0, 7) ?? opts.month ?? new Date().toISOString().slice(0, 7);
  const bounds = monthBounds(month);
  const effective: CalcScope = {
    ...scope,
    startDate: scope.startDate ?? bounds.start,
    endDate: scope.endDate ?? bounds.end,
  };

  const transactions = await getAllTransactionsInRange(
    userId, `${prevMonthOf(month)}-01`, effective.endDate, { accounts },
  );

  const netWorth = calculateNetWorth(accounts, manual, scope);
  const cashflow = calculateNetCashFlow(transactions, effective, {
    confirmedTransferIds: transferInfo.ids, topN: 5,
  });
  const income = calculateIncomeBySource(transactions, effective, transferInfo.ids);
  const spending = calculateSpendingByCategory(transactions, effective, transferInfo.ids);
  const comparison = calculateMonthlyComparison(transactions, month, scope, {
    confirmedTransferIds: transferInfo.ids,
  });
  const freshness = dataFreshness(accounts);

  return {
    scope: {
      startDate: effective.startDate,
      endDate: effective.endDate,
      accountIds: effective.includeAccountIds ?? accounts.map((a) => a.id),
      accountCount: accounts.length,
    },
    netWorth: {
      connectedAssets: netWorth.connectedAssets,
      connectedLiabilities: netWorth.connectedLiabilities,
      manualAssets: netWorth.manualAssets,
      manualLiabilities: netWorth.manualLiabilities,
      totalAssets: netWorth.totalAssets,
      totalLiabilities: netWorth.totalLiabilities,
      netWorth: netWorth.netWorth,
      currencies: netWorth.currencies,
      // Always true — see calculateNetWorth. The UI must label this
      // "Connected net worth", not "your net worth".
      isPartial: netWorth.isPartial,
      deduplicatedManualCount: netWorth.deduplicatedManualIds.length,
      balanceAsOf: netWorth.balanceAsOf,
    },
    cashflow: {
      inflows: cashflow.inflows,
      outflows: cashflow.outflows,
      net: cashflow.net,
      averageDailySpend: cashflow.averageDailySpend,
      largestExpenses: cashflow.largestExpenses,
      largestIncome: cashflow.largestIncome,
      excludedTransferCount: cashflow.excludedTransferCount,
    },
    income: { total: income.total, bySource: income.bySource.slice(0, 10), needsReviewCount: income.needsReview.length },
    spending: { byCategory: spending.slice(0, 15) },
    comparison,
    freshness,
    uncertainTransferCount: transferInfo.detected,
    accounts: accounts.map((a) => ({
      id: a.id, label: accountLabel(a), accountType: a.accountType,
      currency: a.currency, currentBalance: a.currentBalance,
      availableBalance: a.availableBalance, balanceAsOf: a.balanceAsOf,
      status: a.status, institutionName: a.institutionName,
      includeInNetWorth: a.includeInNetWorth,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Stripe webhook
// ────────────────────────────────────────────────────────────────────────────

/**
 * Event names verified against the installed stripe-node types for API version
 * 2026-07-29.dahlia (node_modules/stripe/esm/resources/Events.d.ts), not from
 * memory. There is deliberately no "session completed" event — Financial
 * Connections has none; session completion is handled by the client callback
 * into /connections/complete, which re-reads the session server-side.
 */
const HANDLED_EVENTS = new Set([
  "financial_connections.account.created",
  "financial_connections.account.deactivated",
  "financial_connections.account.disconnected",
  "financial_connections.account.reactivated",
  "financial_connections.account.refreshed_balance",
  "financial_connections.account.refreshed_ownership",
  "financial_connections.account.refreshed_transactions",
  "financial_connections.account.upcoming_deactivation",
  "financial_connections.account.expected_deactivation_date_updated",
]);

/**
 * Is this the "we already recorded this event id" error, as opposed to any
 * other database failure?
 *
 * Postgres reports a primary-key clash as SQLSTATE 23505. Everything else —
 * permission denied, connection refused, timeout — means the LEDGER failed, not
 * that the event was seen before, and must be handled differently.
 */
export function isDuplicateEventError(error: unknown): boolean {
  const anyErr = error as any;
  if (String(anyErr?.code) === "23505") return true;
  return /duplicate key value violates unique constraint/i.test(
    String(anyErr?.message ?? anyErr?.details ?? ""),
  );
}

function registerWebhook(app: Express): void {
  // The raw body is REQUIRED for signature verification. This route mounts its
  // own raw parser BEFORE the global express.json() can consume the stream —
  // express.json's `verify` hook also stashes req.rawBody, and we accept either
  // so the route works whichever middleware ran first.
  app.post(
    "/api/finance/webhook",
    express.raw({ type: "application/json", limit: "1mb" }) as any,
    async (req: Request, res: Response) => {
      let secret: string;
      try { secret = assertWebhookConfigured(); }
      catch {
        // Nothing to verify against — refuse rather than trust the payload.
        return res.status(503).json({ received: false });
      }

      const signature = req.headers["stripe-signature"];
      if (!signature || typeof signature !== "string") {
        return res.status(400).json({ received: false, error: "Missing signature" });
      }

      const raw: Buffer | string | undefined =
        Buffer.isBuffer(req.body) ? req.body
          : (req as any).rawBody instanceof Buffer ? (req as any).rawBody
            : typeof (req as any).rawBody === "string" ? (req as any).rawBody
              : undefined;
      if (!raw) {
        console.error("[finance] webhook: raw body unavailable — cannot verify signature");
        return res.status(400).json({ received: false, error: "Invalid payload" });
      }

      let event: import("stripe").Stripe.Event;
      try {
        event = getStripe().webhooks.constructEvent(raw, signature, secret);
      } catch (err) {
        // Invalid signature: log the fact, never the payload.
        console.warn("[finance] webhook: signature verification failed");
        return res.status(400).json({ received: false, error: "Invalid signature" });
      }

      // ── Idempotency ──
      // The event id is the primary key, so a duplicate delivery loses the
      // insert race. That is the ONLY error that means "already handled".
      //
      // Any other failure (ledger unreachable, permissions) must NOT be read as
      // a duplicate: doing so silently drops every event for the duration of the
      // outage, and Stripe — having received a 200 — never retries. Because all
      // the handlers below are idempotent upserts keyed on Stripe's own ids,
      // processing an event twice is harmless while dropping one is not. So we
      // log the ledger failure loudly and process anyway.
      const db = getFinanceDb();
      const { error: claimError } = await db
        .from("finance_webhook_events")
        .insert({ stripe_event_id: event.id, event_type: event.type, status: "received" });
      let ledgerClaimed = true;
      if (claimError) {
        if (isDuplicateEventError(claimError)) {
          return res.status(200).json({ received: true, duplicate: true });
        }
        ledgerClaimed = false;
        logFinanceError("webhook.ledger", claimError, { eventType: event.type });
      }

      // Process BEFORE acknowledging. This runs as a Vercel function: once the
      // response is sent the instance can be frozen, and work still in flight
      // after res.json() is silently lost (the same failure the warm path on
      // /api/dashboard-bootstrap hit). Stripe had its 200 by then, so it never
      // retried and the ledger row stayed at "received" forever. The handlers
      // are idempotent upserts keyed on Stripe's ids, so a slow run that Stripe
      // retries is harmless; a dropped one is not. Failures still answer 200 —
      // the event id is already claimed and the ledger records the outcome.
      try {
        const outcome = await processWebhookEvent(event);
        // Only write back to a row we actually created.
        if (ledgerClaimed) {
          await db
            .from("finance_webhook_events")
            .update({ status: outcome, processed_at: new Date().toISOString() })
            .eq("stripe_event_id", event.id);
        }
      } catch (err) {
        const code = logFinanceError("webhook.process", err, { eventType: event.type });
        if (ledgerClaimed) {
          await db
            .from("finance_webhook_events")
            .update({ status: "failed", processed_at: new Date().toISOString(), error_code: code })
            .eq("stripe_event_id", event.id);
        }
      }
      res.status(200).json({ received: true });
    },
  );
}

/**
 * Act on a verified event.
 *
 * Ownership is ALWAYS resolved through our own tables (the account id or the
 * account holder's customer id → `stripe_account_holders` / `financial_accounts`).
 * The event's own metadata is never trusted to say who a row belongs to.
 */
export async function processWebhookEvent(
  event: import("stripe").Stripe.Event,
): Promise<"processed" | "ignored"> {
  if (!HANDLED_EVENTS.has(event.type)) return "ignored";

  const payloadAccount = event.data.object as import("stripe").Stripe.FinancialConnections.Account;
  if (!payloadAccount?.id) return "ignored";

  // API-VERSION RESILIENCE.
  //
  // A webhook endpoint has its OWN API version, set in the Stripe dashboard and
  // independent of the version this SDK is pinned to. When they differ, the
  // event payload is serialized in the ENDPOINT's version — so a field this
  // code depends on (notably `status_details.active.action`, which is how we
  // detect "the bank needs re-authorization") can be silently absent, and the
  // relink state would simply never fire.
  //
  // So the event is treated as a SIGNAL ONLY: it tells us which account changed.
  // We then re-read that account from Stripe, which always answers at our
  // pinned version, and act on that. One extra call per event buys immunity to
  // the dashboard setting drifting away from the code.
  //
  // If the re-read fails (Stripe down, account already revoked), fall back to
  // the payload — stale-but-present beats dropping the event.
  let account = payloadAccount;
  try {
    account = await getStripe().financialConnections.accounts.retrieve(payloadAccount.id);
  } catch (e) {
    logFinanceError("webhook.retrieveAccount", e, {
      eventType: event.type,
      // Which version sent this, so a mismatch is visible in logs.
      eventApiVersion: (event as any).api_version ?? null,
    });
  }

  // Resolve the owner: first by an account we already store, then by the
  // account holder mapping (covers account.created for a brand-new account).
  let userId = await userIdForStripeAccount(account.id);
  if (!userId) {
    const holder = account.account_holder;
    const customerId = typeof holder?.customer === "string" ? holder.customer : holder?.customer?.id ?? null;
    if (customerId) userId = await userIdForCustomer(customerId);
  }
  if (!userId) {
    // An event for an account we have never seen and cannot attribute. Ignoring
    // is correct — inventing an owner would be a data-leak bug.
    console.warn("[finance] webhook: unattributable account event", event.type);
    return "ignored";
  }

  const db = getFinanceDb();

  switch (event.type) {
    case "financial_connections.account.disconnected":
    case "financial_connections.account.deactivated": {
      await db
        .from("financial_accounts")
        .update({
          status: event.type.endsWith("disconnected") ? "disconnected" : "inactive",
          inactive_cause: account.status_details?.active?.cause ?? null,
        })
        .eq("user_id", userId)
        .eq("stripe_financial_connections_account_id", account.id);
      await markConnectionActionRequired(db, userId, account.id);
      return "processed";
    }

    case "financial_connections.account.upcoming_deactivation":
    case "financial_connections.account.expected_deactivation_date_updated": {
      // Not yet broken, but the user must relink before it is.
      await db
        .from("financial_accounts")
        .update({ status: "action_required", inactive_cause: account.status_details?.active?.cause ?? "access_expired" })
        .eq("user_id", userId)
        .eq("stripe_financial_connections_account_id", account.id);
      await markConnectionActionRequired(db, userId, account.id);
      return "processed";
    }

    case "financial_connections.account.reactivated":
    case "financial_connections.account.created": {
      const { data: conn } = await db
        .from("financial_connections")
        .select("id")
        .eq("user_id", userId)
        .neq("connection_status", "disconnected")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      await upsertAccount(db, userId, conn?.id ?? null, account);
      return "processed";
    }

    case "financial_connections.account.refreshed_balance":
    case "financial_connections.account.refreshed_ownership": {
      // The event payload carries the fresh balance — write it straight through
      // rather than paying for another Stripe read.
      await upsertAccountBalanceOnly(db, userId, account);
      return "processed";
    }

    case "financial_connections.account.refreshed_transactions": {
      // New transactions are available. Pull them incrementally.
      const { data: local } = await db
        .from("financial_accounts")
        .select("financial_connection_id")
        .eq("user_id", userId)
        .eq("stripe_financial_connections_account_id", account.id)
        .maybeSingle();
      await syncFinancialData({
        userId,
        syncType: "webhook",
        connectionId: local?.financial_connection_id ?? undefined,
        stripeAccountIds: [account.id],
      });
      return "processed";
    }

    default:
      return "ignored";
  }
}

async function markConnectionActionRequired(db: any, userId: string, stripeAccountId: string): Promise<void> {
  const { data } = await db
    .from("financial_accounts")
    .select("financial_connection_id")
    .eq("user_id", userId)
    .eq("stripe_financial_connections_account_id", stripeAccountId)
    .maybeSingle();
  if (!data?.financial_connection_id) return;
  await db
    .from("financial_connections")
    .update({ connection_status: "action_required", last_sync_error: "relink_required" })
    .eq("id", data.financial_connection_id)
    .eq("user_id", userId)
    .neq("connection_status", "disconnected");
}

/** Balance-only update — never touches user-editable columns. */
async function upsertAccountBalanceOnly(
  db: any,
  userId: string,
  account: import("stripe").Stripe.FinancialConnections.Account,
): Promise<void> {
  const { normalizeBalance } = await import("./finance-sync");
  const balance = normalizeBalance(account);
  const patch: Record<string, unknown> = {};
  if (balance.current !== null) patch.current_balance = balance.current;
  if (balance.available !== null) patch.available_balance = balance.available;
  if (balance.asOf) patch.balance_as_of = balance.asOf;
  if (balance.currency) patch.currency = balance.currency;
  if (Object.keys(patch).length === 0) return;
  await db
    .from("financial_accounts")
    .update(patch)
    .eq("user_id", userId)
    .eq("stripe_financial_connections_account_id", account.id);
}
