// The universal financial-asset layer: classification from context, the
// asset/income/transfer ontology, first-class balance snapshots, holdings and
// activity, provenance, and cross-source reconciliation.
//
// The one rule every test here defends: money-HOLDING accounts are assets with
// one profile each; money FLOWING (salary, dividends) is income; money MOVING
// between two owned accounts changes composition, never net worth.

import { describe, it, expect } from "vitest";
import {
  ACCOUNT_KINDS, accountKindMeta, accountLayoutOf, normalizeAccountKind, accountKindOf,
} from "@shared/account-kinds";
import {
  classifyAccountKind, isFinancialAssetProfile, capabilitiesForKind, hasCapability, FINANCIAL_ASSET_KINDS,
  appendBalanceSnapshot, balanceSnapshots, balanceSeries, seriesForPeriod, changeSince, periodStart, thinSnapshots,
  MAX_BALANCE_SNAPSHOTS, upsertHolding, removeHolding, holdings, allocationOf, gainLossOf, biggestPositions,
  appendActivity, investmentActivity, summarizeActivity, activityBalanceEffect, activityIsIncome, cashFlowOf,
  recordFieldSources, fieldSources, sourceMayOverwrite, accountConnection, classifyMoneyMention,
  FINANCIAL_DATA_KEYS, FINANCIAL_ONTOLOGY_GUIDANCE, FINANCIAL_ASSET_PRINCIPLE,
} from "@shared/financial-assets";
import {
  findAccountMatch, scoreAccountMatch, resolveObservationKind, observationFromConnectedAccount,
  observationFromImportAccount, observationFromInput, suggestedAccountName, canonicalInstitution,
} from "@shared/financial-reconcile";
import { isAssetProfile, isLiabilityProfile, isAssetTabProfile } from "@shared/asset-value";
import { applyBalanceAdjustment, summarizeAccounts, isAccountProfile } from "@shared/finance-accounts";
import { computeNetWorth } from "@shared/net-worth";
import { isReservedFieldKey } from "@shared/profile-field-identity";

const TODAY = "2026-09-05";
const NOW = "2026-09-05T12:00:00.000Z";

const account = (name: string, kind: string, fields: Record<string, any> = {}, extra: Record<string, any> = {}) => ({
  id: `acct-${name.toLowerCase().replace(/\W+/g, "-")}`,
  type: "account",
  type_key: kind,
  name,
  fields: { accountKind: kind, balance: 1000, currentBalance: 1000, currentValue: 1000, ...fields },
  ...extra,
});

// ─── 1. Classification ───────────────────────────────────────────────────────

describe("every money-holding kind is an asset; every debt kind is a liability", () => {
  it("the new subtypes exist with a layout each", () => {
    const keys = ACCOUNT_KINDS.map((k) => k.key);
    for (const k of ["checking", "savings", "money_market", "cd", "cash", "investment", "brokerage", "retirement", "crypto", "hsa", "education", "credit_card", "line_of_credit", "loan", "other"]) {
      expect(keys).toContain(k);
    }
    for (const k of ACCOUNT_KINDS) expect(["bank", "investment", "crypto", "cash", "debt"]).toContain(k.layout);
    expect(accountKindMeta("brokerage").layout).toBe("investment");
    expect(accountKindMeta("crypto").layout).toBe("crypto");
    expect(accountKindMeta("checking").layout).toBe("bank");
    expect(accountKindMeta("credit_card").layout).toBe("debt");
  });

  it("a checking, brokerage, IRA, crypto wallet, CD, HSA, money market and 529 are all assets", () => {
    for (const kind of ["checking", "savings", "money_market", "cd", "cash", "investment", "brokerage", "retirement", "crypto", "hsa", "education"]) {
      const a = account(`My ${kind}`, kind);
      expect(isFinancialAssetProfile(a), kind).toBe(true);
      expect(isAssetProfile(a), kind).toBe(true);
      expect(isAssetTabProfile(a), kind).toBe(true);
      expect(isLiabilityProfile(a), kind).toBe(false);
    }
    expect(FINANCIAL_ASSET_KINDS).not.toContain("credit_card");
    expect(FINANCIAL_ASSET_KINDS).toContain("crypto");
  });

  it("credit cards, loans and lines of credit stay liabilities", () => {
    for (const kind of ["credit_card", "line_of_credit", "loan"]) {
      const a = account(`My ${kind}`, kind);
      expect(isFinancialAssetProfile(a)).toBe(false);
      expect(isLiabilityProfile(a)).toBe(true);
      expect(isAssetProfile(a)).toBe(false);
    }
  });

  it("the finer labels normalize to their own kinds instead of collapsing into 'investment'", () => {
    expect(normalizeAccountKind("brokerage")).toBe("brokerage");
    expect(normalizeAccountKind("Roth IRA")).toBe("retirement");
    expect(normalizeAccountKind("401k")).toBe("retirement");
    expect(normalizeAccountKind("hsa")).toBe("hsa");
    expect(normalizeAccountKind("crypto")).toBe("crypto");
    expect(normalizeAccountKind("crypto_wallet")).toBe("crypto");
    expect(normalizeAccountKind("money market")).toBe("money_market");
    expect(normalizeAccountKind("certificate of deposit")).toBe("cd");
    expect(normalizeAccountKind("529")).toBe("education");
    expect(normalizeAccountKind("five29_plan")).toBe("education");
    expect(normalizeAccountKind("savings_account")).toBe("savings");
    // The old words still work.
    expect(normalizeAccountKind("chequing")).toBe("checking");
    expect(normalizeAccountKind("HYSA")).toBe("savings");
    expect(normalizeAccountKind("HELOC")).toBe("line_of_credit");
    expect(normalizeAccountKind("mortgage")).toBe("loan");
  });

  it("every kind's summary bucket still lands the balance on one side", () => {
    const s = summarizeAccounts([
      account("Chase", "checking", { balance: 100, currentBalance: 100, currentValue: 100 }),
      account("Fidelity", "brokerage", { balance: 200, currentBalance: 200, currentValue: 200 }),
      account("Roth", "retirement", { balance: 300, currentBalance: 300, currentValue: 300 }),
      account("Coinbase", "crypto", { balance: 50, currentBalance: 50, currentValue: 50 }),
      account("CD", "cd", { balance: 25, currentBalance: 25, currentValue: 25 }),
      account("Amex", "credit_card", { balance: 40, currentBalance: 40, currentValue: undefined }),
    ]);
    expect(s.cash).toBe(125);
    expect(s.investments).toBe(550);
    expect(s.creditDebt).toBe(40);
    expect(s.net).toBe(635);
  });
});

describe("classifyAccountKind infers the subtype from context", () => {
  it("an explicit kind wins with high confidence", () => {
    expect(classifyAccountKind({ hint: "savings", name: "Fidelity thing" })).toMatchObject({ kind: "savings", confidence: "high" });
  });
  it("kind words in the name decide", () => {
    expect(classifyAccountKind({ name: "Roth IRA" }).kind).toBe("retirement");
    expect(classifyAccountKind({ name: "Vanguard 401(k)" }).kind).toBe("retirement");
    expect(classifyAccountKind({ name: "Bitcoin wallet" }).kind).toBe("crypto");
    expect(classifyAccountKind({ name: "Kid's 529" }).kind).toBe("education");
    expect(classifyAccountKind({ name: "Optum HSA" }).kind).toBe("hsa");
    expect(classifyAccountKind({ name: "Ally 12-month CD" }).kind).toBe("cd");
    expect(classifyAccountKind({ name: "Marcus money market" }).kind).toBe("money_market");
    expect(classifyAccountKind({ name: "Chase Checking" }).kind).toBe("checking");
    expect(classifyAccountKind({ name: "Emergency fund" }).kind).toBe("savings");
    expect(classifyAccountKind({ name: "Amex Gold" }).kind).toBe("credit_card");
    expect(classifyAccountKind({ name: "Home HELOC" }).kind).toBe("line_of_credit");
  });
  it("an institution whose business is one kind decides when the name does not", () => {
    expect(classifyAccountKind({ name: "Fidelity", institution: "Fidelity" })).toMatchObject({ kind: "brokerage", confidence: "medium" });
    expect(classifyAccountKind({ name: "Schwab" })).toMatchObject({ kind: "brokerage" });
    expect(classifyAccountKind({ name: "Coinbase" })).toMatchObject({ kind: "crypto" });
    expect(classifyAccountKind({ name: "Robinhood" }).kind).toBe("brokerage");
  });
  it("a plain bank is a low-confidence checking account, never a debt", () => {
    const c = classifyAccountKind({ name: "Chase", institution: "Chase" });
    expect(c.kind).toBe("checking");
    expect(c.confidence).toBe("low");
  });
  it("provider categories fill in when nothing else does", () => {
    expect(classifyAccountKind({ name: "Plaid Gold", providerCategory: "investment" }).kind).toBe("investment");
    expect(classifyAccountKind({ name: "Card ending 4", providerCategory: "credit", providerSubcategory: "credit_card" }).kind).toBe("credit_card");
  });
  it("nothing recognizable is 'other' with no confidence", () => {
    expect(classifyAccountKind({ name: "Blorp" })).toMatchObject({ kind: "other", confidence: "none" });
  });
});

describe("capabilities are per kind, so no kind renders meaningless empty sections", () => {
  it("a checking account has cash flow and transactions, no holdings", () => {
    const caps = capabilitiesForKind("checking");
    expect(caps.has("cashFlow")).toBe(true);
    expect(caps.has("holdings")).toBe(false);
    expect(caps.has("creditLimit")).toBe(false);
  });
  it("a brokerage has holdings, allocation, performance, contributions, dividends", () => {
    for (const cap of ["holdings", "allocation", "performance", "contributions", "dividends", "balanceHistory"] as const) {
      expect(hasCapability("brokerage", cap), cap).toBe(true);
    }
    expect(hasCapability("brokerage", "creditLimit")).toBe(false);
  });
  it("crypto has token pricing and transfers", () => {
    expect(hasCapability("crypto", "tokenPricing")).toBe(true);
    expect(hasCapability("crypto", "transfers")).toBe(true);
  });
  it("retirement adds employer match; a CD adds maturity; a card adds a credit limit", () => {
    expect(hasCapability("retirement", "employerMatch")).toBe(true);
    expect(hasCapability("cd", "maturity")).toBe(true);
    expect(hasCapability("credit_card", "creditLimit")).toBe(true);
    expect(hasCapability(account("x", "checking"), "employerMatch")).toBe(false);
  });
  it("accountLayoutOf reads the profile", () => {
    expect(accountLayoutOf(account("F", "brokerage"))).toBe("investment");
    expect(accountLayoutOf({ type: "investment", fields: {} })).toBe("investment");
  });
});

// ─── 2. Snapshots ────────────────────────────────────────────────────────────

describe("balance snapshots are first-class: nothing is overwritten", () => {
  it("appending keeps the old observation", () => {
    let snaps = appendBalanceSnapshot([], { balance: 10000, date: "2026-01-15", source: "user" }, "2026-01-15T10:00:00.000Z");
    snaps = appendBalanceSnapshot(snaps, { balance: 10500, date: "2026-02-15", source: "user" }, "2026-02-15T10:00:00.000Z");
    expect(snaps.map((s) => s.balance)).toEqual([10000, 10500]);
    expect(snaps[0].date).toBe("2026-01-15");
  });
  it("same source, same day collapses to the latest; different sources both stay", () => {
    let snaps = appendBalanceSnapshot([], { balance: 100, date: TODAY, source: "api" }, "2026-09-05T08:00:00.000Z");
    snaps = appendBalanceSnapshot(snaps, { balance: 110, date: TODAY, source: "api" }, "2026-09-05T09:00:00.000Z");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].balance).toBe(110);
    snaps = appendBalanceSnapshot(snaps, { balance: 105, date: TODAY, source: "document", sourceRef: "doc-1" }, NOW);
    expect(snaps).toHaveLength(2);
    expect(snaps.find((s) => s.source === "document")?.sourceRef).toBe("doc-1");
  });
  it("a manual no-change observation is not a data point; an API one is", () => {
    let snaps = appendBalanceSnapshot([], { balance: 100, date: TODAY, source: "user" }, NOW);
    snaps = appendBalanceSnapshot(snaps, { balance: 100, date: TODAY, source: "user" }, NOW);
    expect(snaps).toHaveLength(1);
    snaps = appendBalanceSnapshot(snaps, { balance: 100, date: "2026-09-06", source: "api" }, "2026-09-06T00:00:00.000Z");
    expect(snaps).toHaveLength(2);
  });
  it("applyBalanceAdjustment records a snapshot alongside the adjustment ledger", () => {
    const a = account("Fidelity", "brokerage", { balance: 10000, currentBalance: 10000, currentValue: 10000 });
    const { fields } = applyBalanceAdjustment(a, { newBalance: 10500, date: "2026-03-01", source: "ai" }, TODAY);
    expect(fields.balance).toBe(10500);
    const snaps = balanceSnapshots({ fields });
    expect(snaps.map((s) => [s.date, s.balance, s.source])).toEqual([["2026-03-01", 10500, "ai"]]);
    expect(fields.balanceHistory).toHaveLength(1);
  });
  it("thinning drops old points, never the newest", () => {
    const many = Array.from({ length: MAX_BALANCE_SNAPSHOTS + 200 }, (_, i) => ({
      id: `s${i}`, at: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(), date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      balance: i, source: "api" as const,
    }));
    const out = thinSnapshots(many);
    expect(out.length).toBeLessThanOrEqual(MAX_BALANCE_SNAPSHOTS);
    expect(out[out.length - 1].balance).toBe(MAX_BALANCE_SNAPSHOTS + 199);
    expect(out[0].balance).toBe(0);
  });
});

describe("the balance series answers 'how much has it changed since'", () => {
  const fidelity = account("Fidelity", "brokerage", {
    balance: 24830, currentBalance: 24830, currentValue: 24830, balanceAsOf: "2026-09-01",
    balanceSnapshots: [
      { id: "a", at: "2026-01-05T00:00:00.000Z", date: "2026-01-05", balance: 20000, source: "user" },
      { id: "b", at: "2026-04-01T00:00:00.000Z", date: "2026-04-01", balance: 22000, source: "document" },
      { id: "c", at: "2026-07-01T00:00:00.000Z", date: "2026-07-01", balance: 23500, source: "api" },
    ],
  });

  it("merges snapshots with the current balance as the final point", () => {
    const s = balanceSeries(fidelity, TODAY);
    expect(s.map((p) => [p.date, p.balance])).toEqual([
      ["2026-01-05", 20000], ["2026-04-01", 22000], ["2026-07-01", 23500], ["2026-09-01", 24830],
    ]);
  });
  it("legacy performanceHistory and the adjustment ledger graph too", () => {
    const legacy = account("Old", "investment", {
      balance: 1200, currentBalance: 1200, currentValue: 1200, balanceAsOf: TODAY,
      performanceHistory: [{ date: "2026-01-01", value: 1000 }],
      balanceHistory: [{ id: "x", date: "2026-06-01", previousBalance: 1000, newBalance: 1100, delta: 100, createdAt: "2026-06-01T00:00:00.000Z" }],
    });
    const s = balanceSeries(legacy, TODAY);
    expect(s.map((p) => [p.date, p.balance])).toEqual([["2026-01-01", 1000], ["2026-06-01", 1100], [TODAY, 1200]]);
  });
  it("since January: +$4,830", () => {
    const c = changeSince(fidelity, "2026-01-01", TODAY);
    expect(c.from).toBe(20000);
    expect(c.to).toBe(24830);
    expect(c.change).toBe(4830);
    expect(c.changePct).toBe(24.15);
  });
  it("period windows start where they should", () => {
    expect(periodStart("1W", TODAY)).toBe("2026-08-29");
    expect(periodStart("1M", TODAY)).toBe("2026-08-05");
    expect(periodStart("3M", TODAY)).toBe("2026-06-05");
    expect(periodStart("YTD", TODAY)).toBe("2026-01-01");
    expect(periodStart("1Y", TODAY)).toBe("2025-09-05");
    expect(periodStart("ALL", TODAY)).toBeNull();
  });
  it("a windowed series enters at the balance in force at the window start", () => {
    const s = balanceSeries(fidelity, TODAY);
    const three = seriesForPeriod(s, "3M", TODAY);
    expect(three.from).toBe(22000);   // in force on 2026-06-05 (set 2026-04-01)
    expect(three.to).toBe(24830);
    expect(three.change).toBe(2830);
    expect(three.points[0]).toMatchObject({ date: "2026-06-05", balance: 22000 });
    const all = seriesForPeriod(s, "ALL", TODAY);
    expect(all.change).toBe(4830);
    const ytd = seriesForPeriod(s, "YTD", TODAY);
    expect(ytd.from).toBe(20000);
  });
  it("an account with only a balance still produces one point", () => {
    const s = balanceSeries(account("New", "checking", { balance: 500, currentBalance: 500, currentValue: 500 }), TODAY);
    expect(s).toEqual([{ date: TODAY, balance: 500, source: "system" }]);
  });
});

// ─── 3. Holdings and activity ────────────────────────────────────────────────

describe("holdings live inside the asset", () => {
  it("upsert by symbol replaces, never duplicates", () => {
    let h = upsertHolding([], { symbol: "aapl", name: "Apple", quantity: 10, price: 200, costBasis: 1500 }, TODAY);
    h = upsertHolding(h, { symbol: "VTI", quantity: 50, value: 12000, assetClass: "etf" }, TODAY);
    h = upsertHolding(h, { symbol: "AAPL", price: 210 }, TODAY);
    expect(h).toHaveLength(2);
    const aapl = h.find((x) => x.symbol === "AAPL")!;
    expect(aapl.quantity).toBe(10);
    expect(aapl.value).toBe(2100);
    expect(aapl.assetClass).toBe("other");
    expect(h.find((x) => x.symbol === "VTI")?.assetClass).toBe("etf");
    expect(removeHolding(h, "aapl")).toHaveLength(1);
  });
  it("crypto symbols default to the crypto class", () => {
    const h = upsertHolding([], { symbol: "BTC", quantity: 0.1, price: 84000 }, TODAY);
    expect(h[0].assetClass).toBe("crypto");
    expect(h[0].value).toBe(8400);
  });
  it("allocation, gain/loss and biggest positions", () => {
    const list = holdings({ fields: { holdings: [
      { symbol: "AAPL", name: "Apple", value: 3000, costBasis: 2000, assetClass: "equity" },
      { symbol: "VTI", name: "Vanguard Total", value: 6000, costBasis: 5000, assetClass: "etf" },
      { symbol: "CASH", name: "Sweep", value: 1000, assetClass: "cash" },
    ] } });
    const alloc = allocationOf(list);
    expect(alloc[0]).toMatchObject({ assetClass: "etf", value: 6000, pct: 60 });
    const gl = gainLossOf(list);
    expect(gl).toEqual({ value: 10000, costBasis: 7000, gain: 2000, gainPct: 28.57 });
    expect(biggestPositions(list, 2).map((p) => p.symbol)).toEqual(["VTI", "AAPL"]);
  });
});

describe("activity inside an asset is not a new asset", () => {
  it("contributions add, withdrawals subtract, buys/sells change composition only", () => {
    expect(activityBalanceEffect("contribution")).toBe(1);
    expect(activityBalanceEffect("dividend")).toBe(1);
    expect(activityBalanceEffect("withdrawal")).toBe(-1);
    expect(activityBalanceEffect("buy")).toBe(0);
    expect(activityBalanceEffect("sell")).toBe(0);
    expect(activityIsIncome("dividend")).toBe(true);
    expect(activityIsIncome("contribution")).toBe(false);
  });
  it("append + summarize", () => {
    let list: any[] = [];
    list = appendActivity(list, { kind: "contribution", amount: 500, date: "2026-08-01" }, TODAY, NOW).list;
    list = appendActivity(list, { kind: "buy", amount: 400, symbol: "aapl", quantity: 2, date: "2026-08-02" }, TODAY, NOW).list;
    list = appendActivity(list, { kind: "dividend", amount: 12.5, date: "2026-08-15" }, TODAY, NOW).list;
    list = appendActivity(list, { kind: "withdrawal", amount: 100, date: "2026-08-20" }, TODAY, NOW).list;
    expect(appendActivity(list, { kind: "nonsense", amount: 5 }, TODAY, NOW).entry).toBeNull();
    const s = summarizeActivity(investmentActivity({ fields: { investmentActivity: list } }));
    expect(s).toMatchObject({ contributions: 500, buys: 400, dividends: 12.5, withdrawals: 100, netFlow: 400, count: 4 });
    expect(list[1].symbol).toBe("AAPL");
  });
  it("a bank account's cash flow comes from its ledger", () => {
    const a = account("Chase", "checking", {
      balanceHistory: [
        { id: "1", date: "2026-08-01", previousBalance: 1000, newBalance: 3000, delta: 2000, reason: "Paycheck", source: "user", createdAt: "2026-08-01T00:00:00.000Z" },
        { id: "2", date: "2026-08-10", previousBalance: 3000, newBalance: 2500, delta: -500, reason: "Rent", source: "payment", createdAt: "2026-08-10T00:00:00.000Z" },
      ],
    });
    const cf = cashFlowOf(a, "2026-08-01", "2026-08-31");
    expect(cf).toMatchObject({ deposits: 2000, withdrawals: 500, net: 1500, count: 2 });
  });
});

// ─── 4. Provenance ───────────────────────────────────────────────────────────

describe("every field remembers where it came from", () => {
  it("records and reads sources", () => {
    const src = recordFieldSources({}, ["balance", "currentValue"], "api", NOW, "sync-1");
    expect(fieldSources({ fields: { fieldSources: src } }).balance).toEqual({ source: "api", at: NOW, ref: "sync-1" });
  });
  it("a live connection owns the balance; a statement may not roll it back", () => {
    const connected = account("Chase", "checking", { connection: { provider: "stripe_financial_connections", status: "active" } });
    expect(sourceMayOverwrite(connected, "balance", "document")).toBe(false);
    expect(sourceMayOverwrite(connected, "balance", "api")).toBe(true);
    expect(sourceMayOverwrite(connected, "balance", "user")).toBe(true);
    expect(sourceMayOverwrite(connected, "openedDate", "document")).toBe(true);
    const disconnected = account("Chase", "checking", { connection: { provider: "stripe_financial_connections", status: "disconnected" } });
    expect(sourceMayOverwrite(disconnected, "balance", "document")).toBe(true);
    expect(accountConnection(disconnected)?.status).toBe("disconnected");
    expect(accountConnection(account("x", "cash"))).toBeNull();
  });
  it("the data keys are hidden from generic field lists like balanceHistory is", () => {
    for (const k of ["balanceSnapshots", "holdings", "investmentActivity", "fieldSources", "connection"]) {
      expect(FINANCIAL_DATA_KEYS.has(k)).toBe(true);
      expect(isReservedFieldKey(k)).toBe(false); // plain keys, hidden by list membership not by prefix
    }
  });
});

// ─── 5. Ontology ─────────────────────────────────────────────────────────────

describe("the money-mention ontology the chat follows", () => {
  const c = (t: string) => classifyMoneyMention(t).kind;
  it("earning is income, never an asset", () => {
    expect(c("I earned $2,000 from work")).toBe("income");
    expect(c("got paid $5,000 today")).toBe("income");
    expect(c("my paycheck of $3,100 came in")).toBe("income");
  });
  it("an account's value is an asset balance", () => {
    expect(c("My Schwab account has $34,000")).toBe("asset_balance");
    expect(c("My Bitcoin wallet is worth $8,400")).toBe("asset_balance");
    expect(c("My Fidelity balance dropped to $18,000")).toBe("asset_balance");
    expect(c("checking is down to $1,850")).toBe("asset_balance");
  });
  it("moving money between owned accounts is a transfer", () => {
    expect(c("Put $500 into Schwab")).toBe("transfer");
    expect(c("moved $1,000 from checking to my brokerage")).toBe("transfer");
    expect(c("transferred $200 to savings")).toBe("transfer");
  });
  it("buying, selling and dividends are activity inside the asset", () => {
    expect(c("bought 10 shares of Apple in Fidelity")).toBe("asset_activity");
    expect(c("got a $120 dividend in my brokerage")).toBe("asset_activity");
    expect(c("sold 2 ETH from my wallet")).toBe("asset_activity");
  });
  it("money owed and money spent are neither", () => {
    expect(c("I owe $4,000 on my Amex")).toBe("liability");
    expect(c("spent $38 at Costco")).toBe("expense");
    expect(c("hello there")).toBe("unknown");
  });
  it("the prompt block states the principle and the examples", () => {
    expect(FINANCIAL_ONTOLOGY_GUIDANCE).toContain(FINANCIAL_ASSET_PRINCIPLE);
    for (const s of ["transfer_between_accounts", "record_account_activity", "set_holding", "log_income", "update_account_balance", "NEVER an asset"]) {
      expect(FINANCIAL_ONTOLOGY_GUIDANCE).toContain(s);
    }
  });
});

describe("net worth: a transfer changes composition, not the total", () => {
  it("moving $1,000 from checking to brokerage leaves net worth unchanged", () => {
    const checking = account("Chase Checking", "checking", { balance: 5000, currentBalance: 5000, currentValue: 5000 });
    const brokerage = account("Fidelity", "brokerage", { balance: 20000, currentBalance: 20000, currentValue: 20000 });
    const before = computeNetWorth([checking, brokerage], { mode: "everyone", selectedIds: [] });
    const out = applyBalanceAdjustment(checking, { delta: -1000, source: "user", reason: "Transfer to Fidelity" }, TODAY).fields;
    const inn = applyBalanceAdjustment(brokerage, { delta: 1000, source: "user", reason: "Transfer from Chase Checking" }, TODAY).fields;
    const after = computeNetWorth([
      { ...checking, fields: { ...checking.fields, ...out } },
      { ...brokerage, fields: { ...brokerage.fields, ...inn } },
    ], { mode: "everyone", selectedIds: [] });
    expect(before.netWorth).toBe(25000);
    expect(after.netWorth).toBe(25000);
    expect(after.assets).toBe(before.assets);
  });
  it("a brokerage gain raises assets without anything being income", () => {
    const brokerage = account("Fidelity", "brokerage", { balance: 20000, currentBalance: 20000, currentValue: 20000 });
    const gain = applyBalanceAdjustment(brokerage, { newBalance: 21000, source: "api", reason: "Market" }, TODAY).fields;
    const nw = computeNetWorth([{ ...brokerage, fields: { ...brokerage.fields, ...gain } }], { mode: "everyone", selectedIds: [] });
    expect(nw.assets).toBe(21000);
    expect(balanceSnapshots({ fields: gain })[0].source).toBe("api");
  });
});

// ─── 6. Reconciliation ───────────────────────────────────────────────────────

describe("reconciliation: one real account, one profile", () => {
  const fidelity = account("Fidelity Brokerage", "brokerage", { institution: "Fidelity", accountNumberLast4: "4821", balance: 24830, currentBalance: 24830, currentValue: 24830 });
  const chase = account("Chase Checking", "checking", { institution: "Chase", accountNumberLast4: "1007", balance: 2400, currentBalance: 2400, currentValue: 2400 });
  const amex = account("Amex Gold", "credit_card", { institution: "American Express", accountNumberLast4: "4821", balance: 900, currentBalance: 900 });
  const all = [fidelity, chase, amex];

  it("a statement for Fidelity ••••4821 links to the existing brokerage, not a new 'Fidelity Account 2'", () => {
    const obs = observationFromInput({ name: "Fidelity", institution: "Fidelity Investments", accountNumberLast4: "4821", balance: 24900 }, "document");
    const r = findAccountMatch(obs, all);
    expect(r.decision).toBe("link");
    expect(r.best?.profileId).toBe(fidelity.id);
    expect(r.best?.reasons.join(" ")).toMatch(/ends in 4821/);
  });
  it("a connected Chase checking with the same last four links", () => {
    const obs = observationFromConnectedAccount({
      id: "fa-1", institutionName: "Chase", accountName: "TOTAL CHECKING", accountCategory: "cash", accountSubcategory: "checking",
      accountType: "depository", lastFour: "1007", currency: "usd", currentBalance: 241000, availableBalance: null, balanceAsOf: NOW,
    });
    expect(obs.balance).toBe(2410);
    expect(resolveObservationKind(obs).kind).toBe("checking");
    const r = findAccountMatch(obs, all);
    expect(r.decision).toBe("link");
    expect(r.best?.profileId).toBe(chase.id);
  });
  it("the same last four on a credit card never matches a brokerage", () => {
    const obs = observationFromInput({ name: "Amex", accountKind: "credit_card", accountNumberLast4: "4821" });
    const r = findAccountMatch(obs, all);
    expect(r.best?.profileId).toBe(amex.id);
    expect(r.candidates.map((c) => c.profileId)).not.toContain(fidelity.id);
  });
  it("institution + kind without a number asks for confirmation", () => {
    const obs = observationFromInput({ name: "Fidelity", accountKind: "brokerage" });
    const r = findAccountMatch(obs, all);
    expect(r.best?.profileId).toBe(fidelity.id);
    expect(["link", "confirm"]).toContain(r.decision);
  });
  it("a different account number at the same bank is a new account", () => {
    const obs = observationFromInput({ name: "Chase Savings", accountKind: "savings", institution: "Chase", accountNumberLast4: "9999" });
    const r = findAccountMatch(obs, all);
    expect(r.decision).toBe("create");
  });
  it("a profile already claimed by another feed row is skipped", () => {
    const obs = observationFromInput({ name: "Chase Checking", accountKind: "checking", institution: "Chase", accountNumberLast4: "1007" });
    expect(findAccountMatch(obs, all, new Set([chase.id])).decision).toBe("create");
  });
  it("import rows and names normalize", () => {
    const obs = observationFromImportAccount({ unique_id: "u1", name: "Vanguard Roth IRA", type: "brokerage", balance: 50000, currency: "USD" });
    expect(resolveObservationKind(obs).kind).toBe("brokerage"); // explicit type wins over the name
    expect(suggestedAccountName(observationFromInput({ institution: "Coinbase" }))).toBe("Coinbase Crypto");
    expect(suggestedAccountName(observationFromInput({ name: "Fidelity Brokerage", institution: "Fidelity" }))).toBe("Fidelity Brokerage");
    expect(canonicalInstitution("Bank of America, N.A.")).toBe("bank of america");
    expect(canonicalInstitution("Charles Schwab")).toBe("schwab");
    expect(scoreAccountMatch(resolveObservationKind(obs), fidelity).confidence).not.toBe("high");
  });
  it("accountKindOf still reads a profile's stored kind", () => {
    expect(accountKindOf(fidelity)).toBe("brokerage");
    expect(isAccountProfile(fidelity)).toBe(true);
  });
});
