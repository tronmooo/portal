// Financial accounts: classification, balances, and the one thing that must
// never happen — a single account counted on both sides of the balance sheet.

import { describe, it, expect } from "vitest";
import {
  isAccountProfile, accountKindOf, normalizeAccountKind, isDebtAccount,
  resolveAccountBalance, accountSignedBalance, accountAvailableBalance,
  accountCreditLimit, accountUtilization, accountBalanceAsOf,
  applyBalanceAdjustment, balanceHistory, summarizeAccounts, accountViews,
  findAccount, accountIsExcluded,
} from "@shared/finance-accounts";
import { isAssetProfile, isLiabilityProfile, isNetWorthLiabilityProfile } from "@shared/asset-value";
import { computeNetWorth } from "@shared/net-worth";

const TODAY = "2026-08-11";

const account = (name: string, kind: string, fields: Record<string, any> = {}) => ({
  id: `acct-${name.toLowerCase().replace(/\W+/g, "-")}`,
  type: "account",
  type_key: kind,
  name,
  fields: { accountKind: kind, ...fields },
});

const checking = account("Chase Checking", "checking", { balance: 2400, currentBalance: 2400, institution: "Chase" });
const savings = account("Ally Savings", "savings", { balance: 10000, currentBalance: 10000 });
const cash = account("Cash", "cash", { balance: 300, currentBalance: 300 });
const brokerage = account("Fidelity", "investment", { balance: 45000, currentBalance: 45000 });
const amex = account("Amex Gold", "credit_card", {
  balance: 2000, currentBalance: 2000, creditLimit: 10000, institution: "American Express",
});

describe("account classification", () => {
  it("recognizes an account profile and its kind", () => {
    expect(isAccountProfile(checking)).toBe(true);
    expect(isAccountProfile({ type: "person", name: "Joe" })).toBe(false);
    expect(accountKindOf(checking)).toBe("checking");
    expect(accountKindOf(amex)).toBe("credit_card");
  });

  it("maps the words people actually use onto kinds", () => {
    expect(normalizeAccountKind("chequing")).toBe("checking");
    expect(normalizeAccountKind("HYSA")).toBe("savings");
    expect(normalizeAccountKind("brokerage")).toBe("investment");
    expect(normalizeAccountKind("Visa")).toBe("credit_card");
    expect(normalizeAccountKind("HELOC")).toBe("line_of_credit");
    expect(normalizeAccountKind("mortgage")).toBe("loan");
    expect(normalizeAccountKind("")).toBe("other");
  });

  it("knows which kinds are debt", () => {
    expect(isDebtAccount(amex)).toBe(true);
    expect(isDebtAccount(account("HELOC", "line_of_credit"))).toBe(true);
    expect(isDebtAccount(account("Car loan", "loan"))).toBe(true);
    expect(isDebtAccount(checking)).toBe(false);
    expect(isDebtAccount(brokerage)).toBe(false);
  });
});

describe("an account lands on exactly one side of the balance sheet", () => {
  // Both resolveAssetValue and resolveLiabilityBalance read `fields.balance`.
  // Before the kind-aware split, ONE credit card row added its balance to
  // assets AND subtracted it as debt — a double error from a single record.
  it("classifies cash-side accounts as assets only", () => {
    for (const a of [checking, savings, cash, brokerage]) {
      expect(isAssetProfile(a)).toBe(true);
      expect(isLiabilityProfile(a)).toBe(false);
      expect(isNetWorthLiabilityProfile(a)).toBe(false);
    }
  });

  it("classifies credit and loan accounts as debt only", () => {
    for (const a of [amex, account("HELOC", "line_of_credit", { balance: 5000 })]) {
      expect(isAssetProfile(a)).toBe(false);
      expect(isLiabilityProfile(a)).toBe(true);
      expect(isNetWorthLiabilityProfile(a)).toBe(true);
    }
  });

  it("nets out correctly in net worth with no double counting", () => {
    const nw = computeNetWorth([checking, savings, cash, brokerage, amex], {
      mode: "everyone", selectedIds: [],
    });
    expect(nw.assets).toBe(57700);   // 2400 + 10000 + 300 + 45000
    expect(nw.liabilities).toBe(2000);
    expect(nw.netWorth).toBe(55700);
    // The card appears once, on the debt side.
    expect(nw.assetRows.map(r => r.name)).not.toContain("Amex Gold");
    expect(nw.liabilityRows.map(r => r.name)).toEqual(["Amex Gold"]);
  });

  it("leaves non-account profiles classified exactly as before", () => {
    const house = { id: "p1", type: "property", name: "House", fields: { currentValue: 500000 } };
    const mortgage = { id: "p2", type: "liability", type_key: "mortgage", name: "Mortgage", fields: { currentBalance: 410000 } };
    expect(isAssetProfile(house)).toBe(true);
    expect(isNetWorthLiabilityProfile(mortgage)).toBe(true);
    // A recurring service bill is still excluded from balance-sheet debt.
    const netflix = { id: "p3", type: "liability", type_key: "streaming", name: "Netflix", fields: { monthlyAmount: 15 } };
    expect(isNetWorthLiabilityProfile(netflix)).toBe(false);
  });
});

describe("balances", () => {
  it("reads the balance whichever key it was written under", () => {
    expect(resolveAccountBalance(checking)).toBe(2400);
    expect(resolveAccountBalance(account("A", "checking", { currentBalance: 55 }))).toBe(55);
    expect(resolveAccountBalance(account("B", "checking", { accountBalance: "$1,200" }))).toBe(1200);
    expect(resolveAccountBalance(account("C", "checking", { balance: 0 }))).toBe(0);
    expect(resolveAccountBalance(account("D", "checking"))).toBe(0);
  });

  it("stores balances positive and applies the debt sign in one place", () => {
    expect(resolveAccountBalance(amex)).toBe(2000);
    expect(accountSignedBalance(amex)).toBe(-2000);
    expect(accountSignedBalance(checking)).toBe(2400);
  });

  it("derives available credit and utilization from the limit", () => {
    expect(accountCreditLimit(amex)).toBe(10000);
    expect(accountAvailableBalance(amex)).toBe(8000);
    expect(accountUtilization(amex)).toBe(20);
    // A checking account has no credit limit, so no utilization to report.
    expect(accountCreditLimit(checking)).toBeNull();
    expect(accountUtilization(checking)).toBeNull();
  });

  it("prefers an explicitly stated available balance over the derived one", () => {
    const card = account("Card", "credit_card", { balance: 2000, creditLimit: 10000, availableBalance: 7500 });
    expect(accountAvailableBalance(card)).toBe(7500);
  });
});

describe("manual balance adjustments", () => {
  it("sets a balance outright and records the before/after pair", () => {
    const { fields, adjustment } = applyBalanceAdjustment(checking, {
      newBalance: 1850, reason: "Rent paid", source: "user",
    }, TODAY);
    expect(fields.balance).toBe(1850);
    // Both keys are written: the two resolvers read different ones, and an
    // account can be on either side of the sheet.
    expect(fields.currentBalance).toBe(1850);
    expect(fields.balanceAsOf).toBe(TODAY);
    expect(adjustment.previousBalance).toBe(2400);
    expect(adjustment.newBalance).toBe(1850);
    expect(adjustment.delta).toBe(-550);
    expect(adjustment.reason).toBe("Rent paid");
  });

  it("moves a balance by a delta", () => {
    const { fields, adjustment } = applyBalanceAdjustment(cash, { delta: -40 }, TODAY);
    expect(fields.balance).toBe(260);
    expect(adjustment.delta).toBe(-40);
  });

  it("rounds to cents rather than drifting on float error", () => {
    const a = account("A", "checking", { balance: 60 });
    const { fields } = applyBalanceAdjustment(a, { delta: -0.17 }, TODAY);
    expect(fields.balance).toBe(59.83);
  });

  it("accumulates history across adjustments", () => {
    let profile: any = { ...checking, fields: { ...checking.fields } };
    for (const delta of [-100, -50, 200]) {
      const { fields } = applyBalanceAdjustment(profile, { delta }, TODAY);
      profile = { ...profile, fields: { ...profile.fields, ...fields } };
    }
    const history = balanceHistory(profile);
    expect(history).toHaveLength(3);
    expect(history.map(h => h.newBalance)).toEqual([2300, 2250, 2450]);
    expect(resolveAccountBalance(profile)).toBe(2450);
  });

  it("stamps the effective date the caller gave", () => {
    const { fields } = applyBalanceAdjustment(checking, { newBalance: 100, date: "2026-07-01" }, TODAY);
    expect(fields.balanceAsOf).toBe("2026-07-01");
    expect(accountBalanceAsOf({ ...checking, fields: { ...checking.fields, ...fields } })).toBe("2026-07-01");
  });
});

describe("rollups", () => {
  const all = [checking, savings, cash, brokerage, amex, { id: "x", type: "person", name: "Joe", fields: {} }];

  it("buckets balances and nets them out", () => {
    const s = summarizeAccounts(all);
    expect(s.count).toBe(5);              // the person is not an account
    expect(s.cash).toBe(12700);           // 2400 + 10000 + 300
    expect(s.investments).toBe(45000);
    expect(s.creditDebt).toBe(2000);
    expect(s.loanDebt).toBe(0);
    expect(s.totalAssets).toBe(57700);
    expect(s.totalDebt).toBe(2000);
    expect(s.net).toBe(55700);
    expect(s.availableCredit).toBe(8000);
  });

  it("leaves closed and excluded accounts out of the totals", () => {
    const closed = account("Old Checking", "checking", { balance: 999, status: "closed" });
    const hidden = account("Dup Savings", "savings", { balance: 500, includeInNetWorth: false });
    expect(accountIsExcluded(closed)).toBe(true);
    expect(accountIsExcluded(hidden)).toBe(true);
    expect(summarizeAccounts([checking, closed, hidden]).cash).toBe(2400);
  });

  it("returns zeroes rather than NaN when there are no accounts", () => {
    const s = summarizeAccounts([{ id: "x", type: "person", name: "Joe", fields: {} }]);
    expect(s).toMatchObject({ cash: 0, totalAssets: 0, totalDebt: 0, net: 0, count: 0 });
    expect(s.availableCredit).toBeNull();
  });

  it("orders views assets-first, largest first", () => {
    const views = accountViews(all);
    expect(views.map(v => v.name)).toEqual([
      "Fidelity", "Ally Savings", "Chase Checking", "Cash", "Amex Gold",
    ]);
    expect(views.at(-1)!.isDebt).toBe(true);
  });
});

describe("findAccount — resolving what the user said to one account", () => {
  const all = [checking, savings, cash, brokerage, amex];

  it("matches by exact name, partial name, institution and kind", () => {
    expect(findAccount(all, "Chase Checking")?.id).toBe(checking.id);
    expect(findAccount(all, "amex")?.id).toBe(amex.id);
    expect(findAccount(all, "american express")?.id).toBe(amex.id);
    expect(findAccount(all, "checking")?.id).toBe(checking.id);
    expect(findAccount(all, "brokerage")?.id).toBe(brokerage.id);
  });

  it("returns null rather than picking one at random", () => {
    expect(findAccount(all, "")).toBeNull();
    expect(findAccount(all, "wells fargo")).toBeNull();
    expect(findAccount([], "checking")).toBeNull();
  });
});
