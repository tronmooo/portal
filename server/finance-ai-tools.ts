/**
 * Claude's window onto connected financial data.
 *
 * Claude is an INTERPRETATION layer, not an integration layer:
 *   * It never talks to Stripe. It has no Stripe key, no session, no webhook.
 *   * It cannot name a user. Every tool below takes `userId` from the verified
 *     request context, exactly like the HTTP routes — a prompt saying "show me
 *     Bob's spending" produces the caller's spending, because Bob is not
 *     addressable through this surface.
 *   * It cannot invent totals. Each tool returns numbers computed by
 *     shared/finance-calc.ts, the same module the Finance tab renders from, so
 *     an answer in chat and the number on screen cannot disagree.
 *
 * Every response carries the disclosure block the product requires: the date
 * range, the accounts in scope, when the data was last refreshed, what was
 * excluded, what is uncertain, and whether the period is still running.
 */

import { storage } from "./storage";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getAccounts, getAllTransactionsInRange, getConfirmedTransferIds, getTransactions,
} from "./finance-data";
import { buildSummary } from "./finance-routes";
import { syncFinancialData } from "./finance-sync";
import { stripeConfigStatus } from "./stripe-config";
import {
  calculateSpendingByAccount, calculateSpendingByCategory, calculateSpendingByMerchant,
  calculateSpendingByPeriod, dataFreshness, detectLikelyRecurringTransactions,
  type CalcScope,
} from "@shared/finance-calc";
import { formatMinor, majorToMinor, minorToMajor } from "@shared/money";
import type { FinancialAccountRecord, FinancialTransactionRecord } from "@shared/finance-connections";

export const FINANCE_TOOL_NAMES = [
  "get_financial_summary",
  "search_financial_transactions",
  "get_spending_breakdown",
  "get_account_balances",
  "refresh_financial_data",
] as const;

export type FinanceToolName = (typeof FINANCE_TOOL_NAMES)[number];

export function isFinanceTool(name: string): name is FinanceToolName {
  return (FINANCE_TOOL_NAMES as readonly string[]).includes(name);
}

// ────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ────────────────────────────────────────────────────────────────────────────

export const FINANCE_TOOL_DEFINITIONS: Anthropic.Messages.Tool[] = [
  {
    name: "get_financial_summary",
    description:
      "Get connected bank totals for a date range: connected assets, connected liabilities, connected net worth, inflows, outflows, net cash flow, spending totals, income totals, and how fresh the data is. Use this for any question about how much money the user has, what their net worth is, how much they spent or earned overall, or why a period looks different. ALWAYS use the numbers this returns — never estimate totals from the conversation. If no accounts are connected it says so.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start of the range, YYYY-MM-DD. Defaults to the start of the current month." },
        end_date: { type: "string", description: "End of the range, YYYY-MM-DD. Defaults to today." },
        account_ids: { type: "array", items: { type: "string" }, description: "Restrict to these connected account ids. Omit for all accounts." },
        profile_id: { type: "string", description: "Optional Portol profile id to scope manual assets/liabilities to." },
      },
      required: [],
    },
  },
  {
    name: "search_financial_transactions",
    description:
      "Search the user's imported bank transactions. Use for 'what did I spend at X', 'show my largest transactions', 'find transfers between my accounts', 'what did I buy on <date>'. Returns individual normalized transactions with amount, date, merchant, account, category and classification flags.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Earliest transaction date, YYYY-MM-DD." },
        end_date: { type: "string", description: "Latest transaction date, YYYY-MM-DD." },
        merchant: { type: "string", description: "Merchant or description text to match." },
        category: { type: "string", description: "Category to filter by, e.g. food, transport, housing." },
        account_ids: { type: "array", items: { type: "string" }, description: "Restrict to these connected account ids." },
        minimum_amount: { type: "number", description: "Minimum absolute amount in dollars." },
        maximum_amount: { type: "number", description: "Maximum absolute amount in dollars." },
        transaction_type: { type: "string", enum: ["income", "expense", "transfer", "refund", "all"], description: "Which kind of transaction to return. Defaults to all." },
        limit: { type: "number", description: "How many to return, 1-200. Defaults to 50." },
      },
      required: [],
    },
  },
  {
    name: "get_spending_breakdown",
    description:
      "Break spending down by category, merchant, account, week or month over a date range. Use for 'how much did I spend at restaurants', 'what's my biggest spending category', 'break down my spending by merchant'. Excludes internal transfers, matched credit-card payments, refunds and anything the user excluded.",
    input_schema: {
      type: "object" as const,
      properties: {
        start_date: { type: "string", description: "Start of the range, YYYY-MM-DD." },
        end_date: { type: "string", description: "End of the range, YYYY-MM-DD." },
        group_by: { type: "string", enum: ["category", "merchant", "account", "week", "month"], description: "How to group the spending. Defaults to category." },
        account_ids: { type: "array", items: { type: "string" }, description: "Restrict to these connected account ids." },
      },
      required: [],
    },
  },
  {
    name: "get_account_balances",
    description:
      "Get current and available balances for connected accounts, with account type, institution, when the balance was last refreshed and the connection's health. Use for 'how much do I have in checking and savings', 'what's on my credit card', 'are any of my accounts disconnected'.",
    input_schema: {
      type: "object" as const,
      properties: {
        account_ids: { type: "array", items: { type: "string" }, description: "Restrict to these connected account ids. Omit for all." },
      },
      required: [],
    },
  },
  {
    name: "refresh_financial_data",
    description:
      "Pull fresh balances and transactions from the user's bank. This is an ACTION that costs time and money, so only call it when the user EXPLICITLY asks to refresh, sync, or update their bank data — never speculatively, and never more than once in a conversation. If data looks stale, say when it was last refreshed and offer to refresh rather than doing it unprompted.",
    input_schema: {
      type: "object" as const,
      properties: {
        confirm: { type: "boolean", description: "Must be true. Set only when the user explicitly asked for a refresh." },
      },
      required: ["confirm"],
    },
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────────────

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const idList = z.array(z.string().uuid()).max(50).optional();

const summarySchema = z.object({
  start_date: dateStr, end_date: dateStr, account_ids: idList,
  profile_id: z.string().uuid().optional(),
});
const searchSchema = z.object({
  start_date: dateStr, end_date: dateStr,
  merchant: z.string().max(120).optional(),
  category: z.string().max(60).optional(),
  account_ids: idList,
  minimum_amount: z.number().nonnegative().optional(),
  maximum_amount: z.number().nonnegative().optional(),
  transaction_type: z.enum(["income", "expense", "transfer", "refund", "all"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const breakdownSchema = z.object({
  start_date: dateStr, end_date: dateStr,
  group_by: z.enum(["category", "merchant", "account", "week", "month"]).optional(),
  account_ids: idList,
});
const balancesSchema = z.object({ account_ids: idList });

// ────────────────────────────────────────────────────────────────────────────
// Refresh rate limiting for the AI path
// ────────────────────────────────────────────────────────────────────────────
// Separate from the HTTP limiter and deliberately stricter: a model in a loop
// must not be able to hammer the user's bank.
const AI_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const aiRefreshAt = new Map<string, number>();

/** Test seam. */
export function __resetAiRefreshLimiter(): void { aiRefreshAt.clear(); }

// ────────────────────────────────────────────────────────────────────────────
// Shared response furniture
// ────────────────────────────────────────────────────────────────────────────

/**
 * The disclosure every financial answer must carry. Attached to every tool
 * result so Claude has the facts it needs to qualify its answer and cannot
 * present a partial period as a complete one.
 */
function disclosure(
  accounts: FinancialAccountRecord[],
  scope: { startDate?: string; endDate?: string },
  extra: Record<string, unknown> = {},
) {
  const freshness = dataFreshness(accounts);
  // The user's own day: at 5 PM Pacific the UTC day had rolled, so a period
  // ending today was called complete an evening early (D218 class).
  const today = getUserToday((storage as any)._timezone || DEFAULT_TIMEZONE);
  return {
    date_range: { start: scope.startDate ?? null, end: scope.endDate ?? null },
    accounts_in_scope: accounts.map((a) => ({
      id: a.id,
      label: [a.institutionName, a.accountDisplayName, a.lastFour ? `••${a.lastFour}` : null].filter(Boolean).join(" "),
      status: a.status,
    })),
    last_refreshed_at: freshness.newest,
    oldest_balance_at: freshness.oldest,
    stale_account_count: freshness.staleAccountIds.length,
    // A period that includes today is not finished; the model must say so.
    current_period_incomplete: !scope.endDate || scope.endDate >= today,
    excluded_from_totals:
      "Internal transfers between the user's own accounts, matched credit-card payments, refunds, duplicates, and transactions the user excluded by hand.",
    caveat:
      "These figures cover CONNECTED accounts plus records the user entered manually. They are not necessarily the user's complete financial position.",
    ...extra,
  };
}

function noAccounts(reason: "not_configured" | "not_connected") {
  return {
    connected: false,
    reason,
    message: reason === "not_configured"
      ? "Bank connections are not set up on this server, so there is no connected financial data to report."
      : "No bank accounts are connected yet. The user can connect one in Settings → Connected Services → Finance.",
  };
}

/** Money for the model: minor units are exact, dollars are for its prose. */
function money(totals: Record<string, number>): Record<string, { minor_units: number; amount: number; formatted: string }> {
  const out: Record<string, { minor_units: number; amount: number; formatted: string }> = {};
  for (const [currency, minor] of Object.entries(totals ?? {})) {
    out[currency] = { minor_units: minor, amount: minorToMajor(minor, currency), formatted: formatMinor(minor, currency) };
  }
  return out;
}

function shapeTransaction(t: FinancialTransactionRecord) {
  return {
    id: t.id,
    date: t.transactionDate,
    merchant: t.merchantName,
    description: t.description,
    account: t.accountName,
    institution: t.institutionName,
    category: t.category,
    amount: minorToMajor(t.amount, t.currency),
    amount_formatted: formatMinor(t.amount, t.currency, { signDisplay: "always" }),
    currency: t.currency,
    status: t.status,
    // Sign convention, spelled out so the model never inverts it.
    direction: t.amount < 0 ? "money out" : "money in",
    is_transfer: t.isTransfer,
    is_refund: t.isRefund,
    excluded_from_totals: t.excludedFromTotals,
    user_edited: !!t.override,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Execution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run one finance tool for a VERIFIED user.
 *
 * `userId` must come from the authenticated request. This function is the only
 * bridge between the model and the finance tables, and it never accepts a user
 * id from the tool input — the schemas above have no such field by design.
 */
export async function executeFinanceTool(
  name: FinanceToolName,
  rawInput: unknown,
  userId: string | undefined,
): Promise<unknown> {
  if (!userId) {
    return { error: "Not signed in. Financial data is only available to an authenticated user." };
  }

  const config = stripeConfigStatus();
  if (!config.configured && name !== "refresh_financial_data") {
    return noAccounts("not_configured");
  }

  switch (name) {
    case "get_financial_summary": {
      const input = summarySchema.safeParse(rawInput ?? {});
      if (!input.success) return { error: "Invalid arguments for get_financial_summary." };

      const accounts = await getAccounts(userId);
      if (accounts.length === 0) return noAccounts("not_connected");

      const scope: CalcScope = {
        startDate: input.data.start_date,
        endDate: input.data.end_date,
        includeAccountIds: input.data.account_ids,
      };
      const summary = await buildSummary(userId, scope);

      return {
        connected: true,
        connected_assets: money(summary.netWorth.connectedAssets),
        connected_liabilities: money(summary.netWorth.connectedLiabilities),
        manual_assets: money(summary.netWorth.manualAssets),
        manual_liabilities: money(summary.netWorth.manualLiabilities),
        // Always call it CONNECTED net worth — never "net worth" flat.
        connected_net_worth: money(summary.netWorth.netWorth),
        inflows: money(summary.cashflow.inflows),
        outflows: money(summary.cashflow.outflows),
        net_cash_flow: money(summary.cashflow.net),
        spending_by_category: summary.spending.byCategory.map((r) => ({
          category: r.label, amount: minorToMajor(r.amount, r.currency),
          formatted: formatMinor(r.amount, r.currency), share_pct: r.sharePct, count: r.count,
        })),
        income_total: money(summary.income.total),
        income_by_source: summary.income.bySource.map((r) => ({
          source: r.label, amount: minorToMajor(r.amount, r.currency), formatted: formatMinor(r.amount, r.currency),
        })),
        largest_expenses: summary.cashflow.largestExpenses.map(shapeTransaction),
        largest_income: summary.cashflow.largestIncome.map(shapeTransaction),
        month_over_month: summary.comparison,
        uncertain_transfers_awaiting_review: summary.uncertainTransferCount,
        deposits_needing_review: summary.income.needsReviewCount,
        disclosure: disclosure(accounts, {
          startDate: summary.scope.startDate, endDate: summary.scope.endDate,
        }, {
          transfers_excluded_count: summary.cashflow.excludedTransferCount,
          note: summary.uncertainTransferCount > 0
            ? `${summary.uncertainTransferCount} possible internal transfer(s) have not been confirmed and are still counted in these totals. Mention this if the numbers look surprising.`
            : null,
        }),
      };
    }

    case "search_financial_transactions": {
      const input = searchSchema.safeParse(rawInput ?? {});
      if (!input.success) return { error: "Invalid arguments for search_financial_transactions." };

      const accounts = await getAccounts(userId);
      if (accounts.length === 0) return noAccounts("not_connected");

      const { transactions, total } = await getTransactions(userId, {
        startDate: input.data.start_date,
        endDate: input.data.end_date,
        accountIds: input.data.account_ids,
        merchant: input.data.merchant,
        category: input.data.category,
        minAmountMinor: input.data.minimum_amount != null ? majorToMinor(input.data.minimum_amount) : undefined,
        maxAmountMinor: input.data.maximum_amount != null ? majorToMinor(input.data.maximum_amount) : undefined,
        transactionType: input.data.transaction_type ?? "all",
        limit: input.data.limit ?? 50,
      }, { accounts });

      return {
        connected: true,
        transactions: transactions.map(shapeTransaction),
        returned: transactions.length,
        total_matching: total,
        truncated: total > transactions.length,
        disclosure: disclosure(accounts, {
          startDate: input.data.start_date, endDate: input.data.end_date,
        }),
      };
    }

    case "get_spending_breakdown": {
      const input = breakdownSchema.safeParse(rawInput ?? {});
      if (!input.success) return { error: "Invalid arguments for get_spending_breakdown." };

      const accounts = await getAccounts(userId);
      if (accounts.length === 0) return noAccounts("not_connected");

      const groupBy = input.data.group_by ?? "category";
      const scope: CalcScope = {
        startDate: input.data.start_date,
        endDate: input.data.end_date,
        includeAccountIds: input.data.account_ids,
      };

      const [transactions, transfers] = await Promise.all([
        getAllTransactionsInRange(userId, scope.startDate, scope.endDate, {
          accounts, accountIds: input.data.account_ids,
        }),
        getConfirmedTransferIds(userId),
      ]);

      const rows =
        groupBy === "merchant" ? calculateSpendingByMerchant(transactions, scope, transfers.ids)
          : groupBy === "account" ? calculateSpendingByAccount(transactions, scope, transfers.ids)
            : groupBy === "week" || groupBy === "month"
              ? calculateSpendingByPeriod(transactions, groupBy, scope, transfers.ids)
              : calculateSpendingByCategory(transactions, scope, transfers.ids);

      return {
        connected: true,
        group_by: groupBy,
        breakdown: rows.map((r) => ({
          key: r.label,
          amount: minorToMajor(r.amount, r.currency),
          formatted: formatMinor(r.amount, r.currency),
          currency: r.currency,
          transaction_count: r.count,
          share_pct: r.sharePct,
        })),
        recurring: detectLikelyRecurringTransactions(transactions)
          .filter((g) => g.direction === "expense")
          .slice(0, 15)
          .map((g) => ({
            merchant: g.merchantName,
            typical_amount: minorToMajor(g.typicalAmount, g.currency),
            cadence: g.cadence,
            occurrences: g.occurrences,
            next_expected: g.nextExpectedDate,
            confidence: g.confidence,
          })),
        disclosure: disclosure(accounts, scope, {
          uncertain_transfers_awaiting_review: transfers.detected,
        }),
      };
    }

    case "get_account_balances": {
      const input = balancesSchema.safeParse(rawInput ?? {});
      if (!input.success) return { error: "Invalid arguments for get_account_balances." };

      let accounts = await getAccounts(userId, { includeHidden: true });
      if (accounts.length === 0) return noAccounts("not_connected");
      if (input.data.account_ids?.length) {
        const wanted = new Set(input.data.account_ids);
        accounts = accounts.filter((a) => wanted.has(a.id));
      }

      return {
        connected: true,
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.accountDisplayName || a.accountName,
          institution: a.institutionName,
          last_four: a.lastFour,
          account_type: a.accountType,
          account_subcategory: a.accountSubcategory,
          currency: a.currency,
          current_balance: a.currentBalance == null ? null : minorToMajor(a.currentBalance, a.currency),
          current_balance_formatted: a.currentBalance == null ? "Not provided by institution" : formatMinor(a.currentBalance, a.currency),
          available_balance: a.availableBalance == null ? null : minorToMajor(a.availableBalance, a.currency),
          available_balance_formatted: a.availableBalance == null ? "Not provided by institution" : formatMinor(a.availableBalance, a.currency),
          balance_as_of: a.balanceAsOf,
          connection_status: a.status,
          needs_reconnect: a.status === "action_required" || a.status === "inactive",
          included_in_net_worth: a.includeInNetWorth,
          // Debt balances are stored negative; spell it out so the model reads
          // them correctly rather than reporting a card as an asset.
          sign_convention: "Positive = money the user holds. Negative = money the user owes.",
        })),
        disclosure: disclosure(accounts, {}),
      };
    }

    case "refresh_financial_data": {
      const confirmed = (rawInput as any)?.confirm === true;
      if (!confirmed) {
        return {
          refreshed: false,
          reason: "not_confirmed",
          message: "Refresh was not run. Ask the user to confirm they want to pull fresh data from their bank, then call this again with confirm=true.",
        };
      }
      if (!config.configured) return noAccounts("not_configured");

      const accounts = await getAccounts(userId);
      if (accounts.length === 0) return noAccounts("not_connected");

      const last = aiRefreshAt.get(userId);
      if (last && Date.now() - last < AI_REFRESH_MIN_INTERVAL_MS) {
        const waitSec = Math.ceil((AI_REFRESH_MIN_INTERVAL_MS - (Date.now() - last)) / 1000);
        return {
          refreshed: false,
          reason: "rate_limited",
          retry_after_seconds: waitSec,
          message: `The data was refreshed less than ${Math.round(AI_REFRESH_MIN_INTERVAL_MS / 60_000)} minutes ago. Report the existing figures and their timestamp instead of refreshing again.`,
          disclosure: disclosure(accounts, {}),
        };
      }
      aiRefreshAt.set(userId, Date.now());

      const result = await syncFinancialData({ userId, syncType: "manual", requestRefresh: true });
      const after = await getAccounts(userId);

      return {
        refreshed: true,
        status: result.status,
        accounts_processed: result.accountsProcessed,
        transactions_added: result.transactionsInserted,
        transactions_updated: result.transactionsUpdated,
        error_code: result.errorCode,
        message: result.status === "success"
          ? "Refresh complete."
          : result.status === "partial"
            ? "Some accounts refreshed and some did not. Tell the user which ones may be out of date."
            : "The refresh failed. Report the previously stored figures and their timestamp.",
        disclosure: disclosure(after, {}),
      };
    }

    default:
      return { error: `Unknown finance tool: ${name}` };
  }
}

/**
 * Guidance appended to the system prompt so Claude uses these tools correctly.
 * Short by design — it exists to stop the two failure modes that matter:
 * guessing totals, and reporting a partial period as a whole one.
 */
export const FINANCE_TOOL_SYSTEM_GUIDANCE = `
CONNECTED BANK DATA (Stripe Financial Connections)
- For any question about balances, spending, income, cash flow, transactions or net worth from the user's linked bank accounts, call the finance tools. NEVER estimate or add up numbers yourself from earlier messages — use the tool result.
- Every finance tool returns a "disclosure" block. Your answer MUST state: the date range, which accounts are included, when the data was last refreshed, and anything excluded or uncertain.
- If disclosure.current_period_incomplete is true, say the period is still in progress.
- If uncertain_transfers_awaiting_review or deposits_needing_review is above zero, mention that some items still need the user's classification and may move the totals.
- Call the total "connected net worth", not "net worth" — Portol only sees linked accounts plus what the user entered manually.
- Balances are signed: negative means money owed (credit cards, loans). Never report a negative credit balance as an asset.
- Never combine different currencies into one figure; report each currency separately.
- Only call refresh_financial_data when the user explicitly asks to refresh or sync, and at most once per conversation.
`.trim();
