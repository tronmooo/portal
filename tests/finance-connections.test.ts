/**
 * Stripe Financial Connections — unit coverage.
 *
 * Key-free and deterministic: nothing here calls Stripe or Supabase. It proves
 * the parts that decide what a NUMBER means (money math, sign normalization,
 * the calculation module, transfer/recurring/duplicate detection) and the parts
 * that decide who can SEE it (config redaction, error classification).
 *
 * Live-integration coverage — a real connect flow against Stripe test mode and
 * the two-user isolation check against a real Postgres — lives in
 * tests/finance-connections.live.test.ts, which is skipped without keys.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  majorToMinor, minorToMajor, sumMinor, divideMinor, percentChange,
  currencyExponent, formatMinor, withinTolerance, toMinor, absMinor,
} from "../shared/money";
import {
  calculateConnectedAssetTotal, calculateConnectedLiabilityTotal, calculateNetWorth,
  calculateInflows, calculateOutflows, calculateNetCashFlow,
  calculateSpendingByCategory, calculateSpendingByMerchant, calculateSpendingByPeriod,
  calculateIncomeBySource, calculateMonthlyComparison,
  detectLikelyTransfers, detectLikelyRecurringTransactions, detectPossibleDuplicates,
  detectUnusualSpending, filterTransactions, singleCurrencyTotal, normalizeMerchant,
  monthBounds, previousMonth, dataFreshness, AUTO_CONFIRM_CONFIDENCE,
  type ManualHolding,
} from "../shared/finance-calc";
import {
  deriveAccountType, isDebtAccount, applyOverride, financeErrorMessage,
  FINANCE_ERROR_MESSAGES, RELINK_ERROR_CODES,
  type FinancialAccountRecord, type FinancialTransactionRecord,
} from "../shared/finance-connections";

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
function account(over: Partial<FinancialAccountRecord> = {}): FinancialAccountRecord {
  return {
    id: over.id ?? `acct-${++seq}`,
    financialConnectionId: "conn-1",
    institutionName: "Bank of America",
    accountName: "Adv Plus Banking",
    accountDisplayName: "Adv Plus Banking",
    accountCategory: "cash",
    accountSubcategory: "checking",
    accountType: "depository",
    lastFour: "6789",
    currency: "usd",
    currentBalance: 0,
    availableBalance: null,
    balanceAsOf: "2026-08-01T12:00:00.000Z",
    status: "active",
    isHidden: false,
    includeInNetWorth: true,
    matchedProfileId: null,
    permissions: ["balances", "transactions"],
    subscriptions: ["transactions"],
    inactiveCause: null,
    updatedAt: "2026-08-01T12:00:00.000Z",
    ...over,
  };
}

function txn(over: Partial<FinancialTransactionRecord> = {}): FinancialTransactionRecord {
  return {
    id: over.id ?? `txn-${++seq}`,
    financialAccountId: "acct-1",
    stripeTransactionId: over.stripeTransactionId ?? null,
    accountName: "Checking",
    institutionName: "Bank of America",
    transactionDate: "2026-08-01",
    postedAt: null,
    description: "Purchase",
    merchantName: "Merchant",
    amount: -1000,
    currency: "usd",
    transactionType: "debit",
    status: "posted",
    category: "general",
    subcategory: null,
    isIncome: false,
    isExpense: true,
    isTransfer: false,
    isRefund: false,
    isDuplicate: false,
    excludedFromTotals: false,
    source: "stripe_financial_connections",
    ...over,
  };
}

beforeEach(() => { seq = 0; });

// ────────────────────────────────────────────────────────────────────────────
// Money
// ────────────────────────────────────────────────────────────────────────────

describe("money (decimal-safe minor units)", () => {
  it("parses decimal text without floating-point drift", () => {
    // The whole reason this module exists: 1234.565 * 100 in float rounds DOWN
    // to 123456 because the literal is stored as ...64999. Parsing the digits
    // gives the value a bank statement would show.
    expect(majorToMinor("1234.565")).toBe(123457);
    expect(majorToMinor("0.1")).toBe(10);
    expect(majorToMinor("0.2")).toBe(20);
    expect(majorToMinor("19.99")).toBe(1999);
    expect(majorToMinor("-45.50")).toBe(-4550);
    expect(majorToMinor("$1,234.56")).toBe(123456);
  });

  it("never loses a cent across a long addition", () => {
    // 0.1 + 0.2 + ... repeated: the classic float failure.
    const cents = Array.from({ length: 1000 }, () => majorToMinor("0.1"));
    expect(sumMinor(cents)).toBe(100_00);
    // Same sum in floats drifts.
    const floatSum = Array.from({ length: 1000 }, () => 0.1).reduce((a, b) => a + b, 0);
    expect(floatSum).not.toBe(100);
  });

  it("respects zero- and three-decimal currencies", () => {
    expect(currencyExponent("jpy")).toBe(0);
    expect(currencyExponent("kwd")).toBe(3);
    expect(currencyExponent("usd")).toBe(2);
    expect(majorToMinor("1500", "jpy")).toBe(1500);
    expect(majorToMinor("1.234", "kwd")).toBe(1234);
    expect(minorToMajor(1500, "jpy")).toBe(1500);
  });

  it("coerces bigint-as-string from Postgres", () => {
    expect(toMinor("123456789012")).toBe(123456789012);
    expect(toMinor(null)).toBe(0);
    expect(toMinor("not a number")).toBe(0);   // never NaN — NaN poisons sums
    expect(absMinor(null)).toBe(0);
  });

  it("computes averages and percent change safely", () => {
    expect(divideMinor(10_000, 30)).toBe(333);
    expect(divideMinor(10_000, 0)).toBe(0);
    expect(percentChange(15_000, 10_000)).toBeCloseTo(50);
    expect(percentChange(10_000, 0)).toBeNull(); // "up ∞%" is not a fact
  });

  it("formats without inventing precision", () => {
    expect(formatMinor(123456, "usd")).toBe("$1,234.56");
    expect(formatMinor(-4550, "usd", { signDisplay: "always" })).toBe("-$45.50");
  });

  it("compares within a tolerance for wire fees", () => {
    expect(withinTolerance(10_000, 9_997, 5)).toBe(true);
    expect(withinTolerance(10_000, 9_900, 5)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Account classification
// ────────────────────────────────────────────────────────────────────────────

describe("account classification", () => {
  it("maps Stripe category/subcategory onto Portol types", () => {
    expect(deriveAccountType("cash", "checking")).toBe("depository");
    expect(deriveAccountType("cash", "savings")).toBe("depository");
    expect(deriveAccountType("credit", "credit_card")).toBe("credit");
    expect(deriveAccountType("credit", "mortgage")).toBe("loan");
    expect(deriveAccountType("credit", "line_of_credit")).toBe("loan");
    expect(deriveAccountType("investment", "other")).toBe("investment");
    expect(deriveAccountType(null, null)).toBe("other");
  });

  it("identifies debt accounts", () => {
    expect(isDebtAccount("credit")).toBe(true);
    expect(isDebtAccount("loan")).toBe(true);
    expect(isDebtAccount("depository")).toBe(false);
    expect(isDebtAccount("investment")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Net worth
// ────────────────────────────────────────────────────────────────────────────

describe("net worth", () => {
  const accounts = [
    account({ id: "checking", currentBalance: 500_000 }),                                   // $5,000
    account({ id: "savings", accountSubcategory: "savings", currentBalance: 1_200_000 }),    // $12,000
    account({ id: "card", accountType: "credit", accountCategory: "credit", accountSubcategory: "credit_card", currentBalance: -230_000 }), // -$2,300
  ];

  it("separates connected assets from connected debt and reports debt positive", () => {
    expect(calculateConnectedAssetTotal(accounts)).toEqual({ usd: 1_700_000 });
    // Debt comes back as a POSITIVE magnitude — the sign flip happens once.
    expect(calculateConnectedLiabilityTotal(accounts)).toEqual({ usd: 230_000 });
  });

  it("computes net worth as assets minus liabilities", () => {
    const nw = calculateNetWorth(accounts);
    expect(nw.netWorth).toEqual({ usd: 1_470_000 });
  });

  it("adds manual holdings alongside connected ones", () => {
    const manual: ManualHolding[] = [
      { id: "p1", name: "House", amount: 45_000_000, currency: "usd", kind: "asset" },
      { id: "p2", name: "Mortgage", amount: 30_000_000, currency: "usd", kind: "liability" },
    ];
    const nw = calculateNetWorth(accounts, manual);
    expect(nw.totalAssets).toEqual({ usd: 1_700_000 + 45_000_000 });
    expect(nw.totalLiabilities).toEqual({ usd: 230_000 + 30_000_000 });
    expect(nw.netWorth).toEqual({ usd: 1_700_000 + 45_000_000 - 230_000 - 30_000_000 });
  });

  it("does NOT double count when a connected account is matched to a manual record", () => {
    const matched = [
      account({ id: "checking", currentBalance: 500_000, matchedProfileId: "manual-checking" }),
    ];
    const manual: ManualHolding[] = [
      // The user's hand-entered version of the SAME account, with a stale figure.
      { id: "manual-checking", name: "BoA checking", amount: 480_000, currency: "usd", kind: "asset" },
    ];
    const nw = calculateNetWorth(matched, manual);
    // The connected (live) balance wins; the manual row is dropped, not added.
    expect(nw.totalAssets).toEqual({ usd: 500_000 });
    expect(nw.deduplicatedManualIds).toEqual(["manual-checking"]);
  });

  it("honours per-account exclusion from net worth", () => {
    const withExcluded = [
      account({ id: "a", currentBalance: 100_000 }),
      account({ id: "b", currentBalance: 900_000, includeInNetWorth: false }),
    ];
    expect(calculateNetWorth(withExcluded).netWorth).toEqual({ usd: 100_000 });
  });

  it("drops disconnected accounts so a stale balance can't prop up the total", () => {
    const withDisconnected = [
      account({ id: "a", currentBalance: 100_000 }),
      account({ id: "b", currentBalance: 900_000, status: "disconnected" }),
    ];
    expect(calculateNetWorth(withDisconnected).netWorth).toEqual({ usd: 100_000 });
  });

  it("always reports the total as partial — Portol never sees everything", () => {
    expect(calculateNetWorth(accounts).isPartial).toBe(true);
  });

  it("groups currencies instead of summing them", () => {
    const mixed = [
      account({ id: "usd", currentBalance: 100_000, currency: "usd" }),
      account({ id: "eur", currentBalance: 200_000, currency: "eur" }),
    ];
    const nw = calculateNetWorth(mixed);
    expect(nw.netWorth).toEqual({ usd: 100_000, eur: 200_000 });
    expect(nw.currencies).toEqual(["eur", "usd"]);
    // A single headline number is refused when currencies are mixed.
    expect(singleCurrencyTotal(nw.netWorth)).toBeNull();
    expect(singleCurrencyTotal(nw.netWorth, "usd")).toEqual({ amount: 100_000, currency: "usd" });
  });

  it("reports the OLDEST balance timestamp as the as-of", () => {
    const staggered = [
      account({ id: "a", currentBalance: 1, balanceAsOf: "2026-08-05T00:00:00.000Z" }),
      account({ id: "b", currentBalance: 1, balanceAsOf: "2026-07-30T00:00:00.000Z" }),
    ];
    expect(calculateNetWorth(staggered).balanceAsOf).toBe("2026-07-30T00:00:00.000Z");
    expect(dataFreshness(staggered).oldest).toBe("2026-07-30T00:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Filtering
// ────────────────────────────────────────────────────────────────────────────

describe("transaction filtering", () => {
  it("drops void, duplicate, excluded and transfer rows by default", () => {
    const rows = [
      txn({ id: "keep" }),
      txn({ id: "void", status: "void" }),
      txn({ id: "dupe", isDuplicate: true }),
      txn({ id: "excluded", excludedFromTotals: true }),
      txn({ id: "transfer", isTransfer: true }),
    ];
    expect(filterTransactions(rows).map((t) => t.id)).toEqual(["keep"]);
  });

  it("honours the date range inclusively", () => {
    const rows = [
      txn({ id: "before", transactionDate: "2026-07-31" }),
      txn({ id: "start", transactionDate: "2026-08-01" }),
      txn({ id: "end", transactionDate: "2026-08-31" }),
      txn({ id: "after", transactionDate: "2026-09-01" }),
    ];
    const kept = filterTransactions(rows, { startDate: "2026-08-01", endDate: "2026-08-31" });
    expect(kept.map((t) => t.id)).toEqual(["start", "end"]);
  });

  it("honours include and exclude account lists", () => {
    const rows = [
      txn({ id: "a", financialAccountId: "acct-a" }),
      txn({ id: "b", financialAccountId: "acct-b" }),
    ];
    expect(filterTransactions(rows, { includeAccountIds: ["acct-a"] }).map((t) => t.id)).toEqual(["a"]);
    expect(filterTransactions(rows, { excludeAccountIds: ["acct-a"] }).map((t) => t.id)).toEqual(["b"]);
  });

  it("drops confirmed transfer legs handed in by the caller", () => {
    const rows = [txn({ id: "leg-out" }), txn({ id: "other" })];
    const kept = filterTransactions(rows, {}, new Set(["leg-out"]));
    expect(kept.map((t) => t.id)).toEqual(["other"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Cash flow
// ────────────────────────────────────────────────────────────────────────────

describe("cash flow", () => {
  const rows = [
    txn({ id: "salary", amount: 500_000, isIncome: true, merchantName: "ACME Payroll" }),
    txn({ id: "rent", amount: -200_000, merchantName: "Landlord" }),
    txn({ id: "coffee", amount: -500, merchantName: "Blue Bottle" }),
  ];

  it("sums inflows and outflows as positive magnitudes", () => {
    expect(calculateInflows(rows)).toEqual({ usd: 500_000 });
    expect(calculateOutflows(rows)).toEqual({ usd: 200_500 });
  });

  it("nets them and reports what it excluded", () => {
    const transferOut = txn({ id: "xfer-out", amount: -100_000, financialAccountId: "acct-a" });
    const transferIn = txn({ id: "xfer-in", amount: 100_000, financialAccountId: "acct-b" });
    const result = calculateNetCashFlow(
      [...rows, transferOut, transferIn],
      { startDate: "2026-08-01", endDate: "2026-08-31" },
      { confirmedTransferIds: new Set(["xfer-out", "xfer-in"]) },
    );
    // The transfer legs cancel each other, so including them would be harmless
    // for NET but would inflate both inflow and outflow. They are excluded.
    expect(result.inflows).toEqual({ usd: 500_000 });
    expect(result.outflows).toEqual({ usd: 200_500 });
    expect(result.net).toEqual({ usd: 299_500 });
    expect(result.excludedTransferCount).toBe(2);
  });

  it("averages daily spend over the requested window, not the data window", () => {
    const result = calculateNetCashFlow(rows, { startDate: "2026-08-01", endDate: "2026-08-10" });
    expect(result.dayCount).toBe(10);
    expect(result.averageDailySpend).toEqual({ usd: divideMinor(200_500, 10) });
  });

  it("ranks largest expenses and income", () => {
    const result = calculateNetCashFlow(rows, {}, { topN: 2 });
    expect(result.largestExpenses.map((t) => t.id)).toEqual(["rent", "coffee"]);
    expect(result.largestIncome.map((t) => t.id)).toEqual(["salary"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Spending
// ────────────────────────────────────────────────────────────────────────────

describe("spending", () => {
  const rows = [
    txn({ id: "g1", amount: -12_000, category: "food", merchantName: "Safeway" }),
    txn({ id: "g2", amount: -8_000, category: "food", merchantName: "Safeway" }),
    txn({ id: "gas", amount: -6_000, category: "transport", merchantName: "Shell" }),
    txn({ id: "refund", amount: 3_000, category: "food", isRefund: true, merchantName: "Safeway" }),
    txn({ id: "cardpay", amount: -50_000, isTransfer: true, merchantName: "CHASE CARD PAYMENT" }),
    txn({ id: "hidden", amount: -99_000, category: "food", excludedFromTotals: true }),
  ];

  it("excludes refunds, transfers/credit-card payments and user exclusions", () => {
    const byCategory = calculateSpendingByCategory(rows);
    const food = byCategory.find((r) => r.key === "food");
    // 12,000 + 8,000 only: the refund, the card payment and the excluded row
    // are all absent.
    expect(food?.amount).toBe(20_000);
    expect(byCategory.find((r) => r.key === "transport")?.amount).toBe(6_000);
    expect(byCategory.some((r) => r.label.includes("CHASE"))).toBe(false);
  });

  it("computes each row's share of the currency total", () => {
    const byCategory = calculateSpendingByCategory(rows);
    const food = byCategory.find((r) => r.key === "food")!;
    expect(food.sharePct).toBeCloseTo((20_000 / 26_000) * 100);
  });

  it("groups by merchant and by period", () => {
    expect(calculateSpendingByMerchant(rows)[0]).toMatchObject({ label: "Safeway", amount: 20_000, count: 2 });
    const byMonth = calculateSpendingByPeriod(rows, "month");
    expect(byMonth[0].key).toBe("2026-08");
  });

  it("flags charges far above the category's median", () => {
    const many = [
      ...Array.from({ length: 6 }, (_, i) => txn({ id: `n${i}`, amount: -1_000, category: "food" })),
      txn({ id: "big", amount: -50_000, category: "food" }),
    ];
    const unusual = detectUnusualSpending(many);
    expect(unusual[0].transaction.id).toBe("big");
    expect(unusual[0].multiple).toBeGreaterThanOrEqual(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Income
// ────────────────────────────────────────────────────────────────────────────

describe("income", () => {
  it("does NOT treat every positive deposit as income", () => {
    const rows = [
      txn({ id: "payroll", amount: 400_000, description: "ACME CORP DIRECT DEP" }),
      txn({ id: "mystery", amount: 25_000, description: "DEPOSIT", merchantName: null }),
      txn({ id: "refund", amount: 9_900, description: "AMAZON REFUND", isRefund: true }),
      txn({ id: "transfer", amount: 100_000, description: "TRANSFER FROM SAVINGS", isTransfer: true }),
    ];
    const result = calculateIncomeBySource(rows);
    // Only the payroll deposit counts.
    expect(result.total).toEqual({ usd: 400_000 });
    // The unexplained deposit is surfaced for review, not silently counted.
    expect(result.needsReview.map((t) => t.id)).toContain("mystery");
    // Refunds and transfers are neither income nor review items here.
    expect(result.needsReview.map((t) => t.id)).not.toContain("refund");
    expect(result.needsReview.map((t) => t.id)).not.toContain("transfer");
  });

  it("routes reversal-worded deposits to review", () => {
    const rows = [txn({ id: "rev", amount: 5_000, description: "ACH RETURNED ITEM REVERSAL" })];
    const result = calculateIncomeBySource(rows);
    expect(result.total).toEqual({});
    expect(result.needsReview.map((t) => t.id)).toEqual(["rev"]);
  });

  it("lets a user override beat the heuristic in both directions", () => {
    const forced = txn({
      id: "side-gig", amount: 30_000, description: "ZELLE FROM CLIENT",
      override: {
        category: null, subcategory: null, merchantName: null,
        isIncome: true, isExpense: null, isTransfer: null, isRefund: null,
        excludedFromTotals: null, note: null, linkedProfileId: null,
        linkedSubscriptionProfileId: null, linkedLiabilityProfileId: null,
        linkedAssetProfileId: null, budgetCategory: null,
      },
    });
    expect(calculateIncomeBySource([forced]).total).toEqual({ usd: 30_000 });

    const refused = txn({
      id: "not-income", amount: 400_000, description: "ACME CORP DIRECT DEP",
      override: { ...forced.override!, isIncome: false },
    });
    expect(calculateIncomeBySource([refused]).total).toEqual({});
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Month comparison
// ────────────────────────────────────────────────────────────────────────────

describe("monthly comparison", () => {
  it("compares this month with last and flags an unfinished period", () => {
    const rows = [
      txn({ id: "jul", amount: -100_000, transactionDate: "2026-07-15" }),
      txn({ id: "aug", amount: -150_000, transactionDate: "2026-08-03" }),
    ];
    const c = calculateMonthlyComparison(rows, "2026-08", {}, { today: "2026-08-05" });
    expect(c.current.spending).toEqual({ usd: 150_000 });
    expect(c.previous.spending).toEqual({ usd: 100_000 });
    expect(c.spendingChangePct.usd).toBeCloseTo(50);
    // 5 Aug is inside August, so the comparison is not like-for-like.
    expect(c.currentPeriodIncomplete).toBe(true);
  });

  it("computes month boundaries including leap years", () => {
    expect(monthBounds("2026-02")).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(monthBounds("2028-02")).toMatchObject({ start: "2028-02-01", end: "2028-02-29" });
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Transfer detection
// ────────────────────────────────────────────────────────────────────────────

describe("transfer detection", () => {
  const checking = account({ id: "chk", accountType: "depository" });
  const card = account({ id: "card", accountType: "credit", accountCategory: "credit", accountSubcategory: "credit_card" });
  const savings = account({ id: "sav", accountType: "depository", accountSubcategory: "savings" });

  it("matches an equal, opposite pair across two of the user's accounts", () => {
    const rows = [
      txn({ id: "out", financialAccountId: "chk", amount: -50_000, transactionDate: "2026-08-01", description: "ONLINE TRANSFER TO SAVINGS" }),
      txn({ id: "in", financialAccountId: "sav", amount: 50_000, transactionDate: "2026-08-01", description: "ONLINE TRANSFER FROM CHECKING" }),
    ];
    const found = detectLikelyTransfers(rows, [checking, savings]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ outflowId: "out", inflowId: "in" });
    // Same day + transfer wording + exact amount clears the auto-confirm bar.
    expect(found[0].confidence).toBeGreaterThanOrEqual(AUTO_CONFIRM_CONFIDENCE);
  });

  it("recognizes a credit-card payment as a transfer, not spending", () => {
    const rows = [
      txn({ id: "pay", financialAccountId: "chk", amount: -120_000, transactionDate: "2026-08-02", description: "CHASE CREDIT CRD AUTOPAY" }),
      txn({ id: "credit", financialAccountId: "card", amount: 120_000, transactionDate: "2026-08-02", description: "PAYMENT THANK YOU" }),
    ];
    const found = detectLikelyTransfers(rows, [checking, card]);
    expect(found).toHaveLength(1);
    expect(found[0].signals.creditCardPayment).toBe(true);
    expect(found[0].confidence).toBeGreaterThanOrEqual(AUTO_CONFIRM_CONFIDENCE);
  });

  it("does not pair transactions on the same account", () => {
    const rows = [
      txn({ id: "out", financialAccountId: "chk", amount: -50_000 }),
      txn({ id: "in", financialAccountId: "chk", amount: 50_000 }),
    ];
    expect(detectLikelyTransfers(rows, [checking])).toHaveLength(0);
  });

  it("never pairs across currencies (no FX guessing)", () => {
    const rows = [
      txn({ id: "out", financialAccountId: "chk", amount: -50_000, currency: "usd" }),
      txn({ id: "in", financialAccountId: "sav", amount: 50_000, currency: "eur" }),
    ];
    expect(detectLikelyTransfers(rows, [checking, savings])).toHaveLength(0);
  });

  it("keeps a weak match below the auto-confirm bar so the user decides", () => {
    const rows = [
      // No transfer wording, three days apart — plausible, not certain.
      txn({ id: "out", financialAccountId: "chk", amount: -50_000, transactionDate: "2026-08-01", description: "WITHDRAWAL", merchantName: null }),
      txn({ id: "in", financialAccountId: "sav", amount: 50_000, transactionDate: "2026-08-04", description: "DEPOSIT", merchantName: null }),
    ];
    const found = detectLikelyTransfers(rows, [checking, savings]);
    expect(found).toHaveLength(1);
    expect(found[0].confidence).toBeLessThan(AUTO_CONFIRM_CONFIDENCE);
  });

  it("does not consume one inflow for two different outflows", () => {
    const rows = [
      txn({ id: "out1", financialAccountId: "chk", amount: -50_000, transactionDate: "2026-08-01" }),
      txn({ id: "out2", financialAccountId: "chk", amount: -50_000, transactionDate: "2026-08-01" }),
      txn({ id: "in", financialAccountId: "sav", amount: 50_000, transactionDate: "2026-08-01" }),
    ];
    const found = detectLikelyTransfers(rows, [checking, savings]);
    expect(found).toHaveLength(1);
  });

  it("preserves both original records — detection returns links, not merges", () => {
    const rows = [
      txn({ id: "out", financialAccountId: "chk", amount: -50_000, description: "TRANSFER" }),
      txn({ id: "in", financialAccountId: "sav", amount: 50_000, description: "TRANSFER" }),
    ];
    const found = detectLikelyTransfers(rows, [checking, savings]);
    expect(found[0].outflowId).toBe("out");
    expect(found[0].inflowId).toBe("in");
    // Input array untouched.
    expect(rows.map((r) => r.id)).toEqual(["out", "in"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Recurring detection
// ────────────────────────────────────────────────────────────────────────────

describe("recurring detection", () => {
  it("finds a monthly subscription from three or more consistent charges", () => {
    const rows = ["2026-05-03", "2026-06-03", "2026-07-03", "2026-08-03"].map((d, i) =>
      txn({ id: `n${i}`, transactionDate: d, amount: -1_599, merchantName: "Netflix" }),
    );
    const groups = detectLikelyRecurringTransactions(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ merchantName: "Netflix", cadence: "monthly", occurrences: 4, direction: "expense" });
    // Median gap across [31, 30, 31] days is 31, so the next charge is
    // projected 31 days after the last one.
    expect(groups[0].nextExpectedDate).toBe("2026-09-03");
  });

  it("requires at least three occurrences — two is a coincidence", () => {
    const rows = ["2026-07-03", "2026-08-03"].map((d, i) =>
      txn({ id: `n${i}`, transactionDate: d, amount: -1_599, merchantName: "Netflix" }),
    );
    expect(detectLikelyRecurringTransactions(rows)).toHaveLength(0);
  });

  it("ignores a merchant whose amounts vary wildly", () => {
    const rows = [
      txn({ id: "a", transactionDate: "2026-05-03", amount: -1_000, merchantName: "Corner Store" }),
      txn({ id: "b", transactionDate: "2026-06-03", amount: -25_000, merchantName: "Corner Store" }),
      txn({ id: "c", transactionDate: "2026-07-03", amount: -80_000, merchantName: "Corner Store" }),
    ];
    expect(detectLikelyRecurringTransactions(rows)).toHaveLength(0);
  });

  it("detects recurring INCOME separately from expenses", () => {
    const rows = ["2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15"].map((d, i) =>
      txn({ id: `p${i}`, transactionDate: d, amount: 250_000, merchantName: "ACME Payroll" }),
    );
    const groups = detectLikelyRecurringTransactions(rows);
    expect(groups[0]).toMatchObject({ direction: "income", cadence: "biweekly" });
  });

  it("normalizes noisy bank descriptors so the same merchant groups", () => {
    expect(normalizeMerchant("AMZN Mktp US*2K4L9")).toBe(normalizeMerchant("AMZN Mktp US*9Z1XQ"));
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ────────────────────────────────────────────────────────────────────────────

describe("duplicate detection", () => {
  it("flags a pending row superseded by its posted twin and keeps the posted one", () => {
    const rows = [
      txn({ id: "pending", status: "pending", amount: -4_500, transactionDate: "2026-08-01", merchantName: "Blue Bottle" }),
      txn({ id: "posted", status: "posted", amount: -4_500, transactionDate: "2026-08-01", merchantName: "Blue Bottle" }),
    ];
    const dupes = detectPossibleDuplicates(rows);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].keepId).toBe("posted");
    expect(dupes[0].duplicateId).toBe("pending");
  });

  it("treats a repeated Stripe id as a certain duplicate", () => {
    const rows = [
      txn({ id: "a", stripeTransactionId: "fctxn_1", merchantName: "X" }),
      txn({ id: "b", stripeTransactionId: "fctxn_1", merchantName: "Y" }),
    ];
    const dupes = detectPossibleDuplicates(rows);
    expect(dupes[0]).toMatchObject({ keepId: "a", duplicateId: "b", reason: "same_stripe_id", confidence: 1 });
  });

  it("does not flag two genuinely different charges", () => {
    const rows = [
      txn({ id: "a", amount: -4_500, transactionDate: "2026-08-01", merchantName: "Blue Bottle" }),
      txn({ id: "b", amount: -4_500, transactionDate: "2026-08-02", merchantName: "Blue Bottle" }),
    ];
    expect(detectPossibleDuplicates(rows)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Overrides
// ────────────────────────────────────────────────────────────────────────────

describe("user overrides", () => {
  const blank = {
    category: null, subcategory: null, merchantName: null,
    isIncome: null, isExpense: null, isTransfer: null, isRefund: null,
    excludedFromTotals: null, note: null, linkedProfileId: null,
    linkedSubscriptionProfileId: null, linkedLiabilityProfileId: null,
    linkedAssetProfileId: null, budgetCategory: null,
  };

  it("leaves imported values alone where the user has no opinion", () => {
    const base = txn({ category: "food", isTransfer: false });
    const merged = applyOverride(base, blank);
    expect(merged.category).toBe("food");
    expect(merged.isTransfer).toBe(false);
  });

  it("lets a stored `false` beat an imported `true`", () => {
    // This is why the merge is a field-by-field ?? and not a truthiness check:
    // `||` would silently discard a deliberate "no".
    const base = txn({ isTransfer: true });
    const merged = applyOverride(base, { ...blank, isTransfer: false });
    expect(merged.isTransfer).toBe(false);
  });

  it("replaces the category and marks the row as edited", () => {
    const merged = applyOverride(txn({ category: "general" }), { ...blank, category: "health" });
    expect(merged.category).toBe("health");
    expect(merged.override).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Error vocabulary
// ────────────────────────────────────────────────────────────────────────────

describe("user-facing errors", () => {
  it("maps every code to a plain-language message", () => {
    for (const code of Object.keys(FINANCE_ERROR_MESSAGES)) {
      const message = financeErrorMessage(code);
      expect(message.length).toBeGreaterThan(10);
      // No raw Stripe internals, ids, or stack markers may leak into copy.
      expect(message).not.toMatch(/sk_|pk_|whsec_|fca_|cus_|StripeError|at .+:\d+/);
    }
  });

  it("falls back to a safe message for an unknown code", () => {
    expect(financeErrorMessage("something_weird_from_stripe")).toBe(FINANCE_ERROR_MESSAGES.unknown);
    expect(financeErrorMessage(null)).toBe(FINANCE_ERROR_MESSAGES.unknown);
  });

  it("classifies which failures need a reconnect rather than a retry", () => {
    expect(RELINK_ERROR_CODES.has("relink_required")).toBe(true);
    expect(RELINK_ERROR_CODES.has("authorization_revoked")).toBe(true);
    expect(RELINK_ERROR_CODES.has("rate_limited")).toBe(false);
  });
});
