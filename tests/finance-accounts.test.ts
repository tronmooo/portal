// Financial accounts: classification, balances, and the one thing that must
// never happen — a single account counted on both sides of the balance sheet.

import { describe, it, expect } from "vitest";
import {
  isAccountProfile, accountKindOf, normalizeAccountKind, isDebtAccount,
  resolveAccountBalance, accountSignedBalance, accountAvailableBalance,
  accountCreditLimit, accountUtilization, accountBalanceAsOf,
  applyBalanceAdjustment, balanceHistory, summarizeAccounts, accountViews,
  findAccount, accountIsExcluded, isAccountTypeProfile, balanceFieldsFor,
  reconcileAccountBalanceFields,
} from "@shared/finance-accounts";
import {
  isAssetProfile, isLiabilityProfile, isNetWorthLiabilityProfile,
  isAssetTabProfile, isLiabilityTabProfile, assetTypeLabel, ASSET_TAB_TYPES,
  resolveAssetValue, resolveLiabilityBalance,
} from "@shared/asset-value";
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
    expect(normalizeAccountKind("brokerage")).toBe("brokerage");
    expect(normalizeAccountKind("roth_ira")).toBe("retirement");
    expect(normalizeAccountKind("crypto")).toBe("crypto");
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

describe("Assets / Liabilities tab membership", () => {
  // The Assets tab used to carry five hand-written copies of
  // `new Set(["vehicle","asset","investment","property"])`. None listed
  // "account", so financial accounts — which net worth had always counted —
  // were invisible there. These tests pin the shared rule so that can't recur.

  it("lists cash-side accounts in the Assets tab", () => {
    for (const a of [checking, savings, cash, brokerage]) {
      expect(isAssetTabProfile(a)).toBe(true);
      expect(isLiabilityTabProfile(a)).toBe(false);
    }
  });

  it("lists debt-side accounts in the Liabilities tab instead", () => {
    const heloc = account("HELOC", "line_of_credit", { balance: 5000 });
    const carLoan = account("Car loan", "loan", { balance: 18000 });
    for (const a of [amex, heloc, carLoan]) {
      expect(isAssetTabProfile(a)).toBe(false);
      expect(isLiabilityTabProfile(a)).toBe(true);
    }
  });

  it("puts every row in exactly one tab", () => {
    const everything = [
      checking, savings, cash, brokerage, amex,
      { id: "v", type: "vehicle", name: "Civic", fields: {} },
      { id: "h", type: "property", name: "House", fields: {} },
      { id: "i", type: "investment", name: "401k", fields: {} },
      { id: "a", type: "asset", name: "Guitar", fields: {} },
      { id: "l", type: "liability", type_key: "mortgage", name: "Mortgage", fields: {} },
      { id: "s", type: "subscription", name: "Netflix", fields: {} },
      { id: "ln", type: "loan", name: "Legacy loan", fields: {} },
    ];
    for (const p of everything) {
      const inAssets = isAssetTabProfile(p);
      const inLiabilities = isLiabilityTabProfile(p);
      expect(
        inAssets !== inLiabilities,
        `${p.name} (${p.type}) is in ${inAssets && inLiabilities ? "BOTH tabs" : "NEITHER tab"}`,
      ).toBe(true);
    }
  });

  it("keeps people, pets and trackers out of both tabs", () => {
    for (const p of [
      { id: "p", type: "person", name: "Joe", fields: {} },
      { id: "s", type: "self", name: "Me", fields: {} },
      { id: "pet", type: "pet", name: "Luna", fields: {} },
    ]) {
      expect(isAssetTabProfile(p)).toBe(false);
      expect(isLiabilityTabProfile(p)).toBe(false);
    }
  });

  it("labels the account chip group", () => {
    expect(assetTypeLabel("account")).toBe("Accounts");
    expect(assetTypeLabel("vehicle")).toBe("Vehicles");
    expect(assetTypeLabel("property")).toBe("Properties");
    expect(assetTypeLabel("investment")).toBe("Investments");
    expect(assetTypeLabel("asset")).toBe("Assets");
  });

  it("keeps the Assets tab set narrower than the net-worth asset set", () => {
    // A `loan` profile can carry an asset's market value, so net worth counts
    // it — but on screen it is a debt and belongs under Liabilities.
    expect(ASSET_TAB_TYPES.has("loan")).toBe(false);
    expect(isAssetProfile({ type: "loan", fields: { currentValue: 1000 } })).toBe(true);
    expect(isAssetTabProfile({ type: "loan", fields: { currentValue: 1000 } })).toBe(false);
  });
});

describe("investment / brokerage profiles are accounts", () => {
  // Reported from the live app: "I have a Roth IRA that has $50,000 in it" ->
  // the AI created a `type: "investment"` profile, the Assets tab showed it,
  // and Finance -> Accounts said "No accounts yet" with the account one tab
  // away. An accounts list that only accepts `type: "account"` is wrong about
  // what a Roth IRA is.
  const rothIra = {
    id: "p-roth", type: "investment", name: "Roth IRA",
    fields: { accountType: "Roth IRA", currentValue: 50000 },
  };
  const brokerage = {
    id: "p-brk", type: "investment", name: "Fidelity Brokerage",
    fields: { institution: "Fidelity", balance: 45000 },
  };

  it("counts an investment profile as an account", () => {
    expect(isAccountProfile(rothIra)).toBe(true);
    expect(isAccountProfile(brokerage)).toBe(true);
    expect(isAccountProfile({ type: "vehicle", name: "Civic", fields: {} })).toBe(false);
  });

  it("resolves its kind from the profile TYPE when the fields don't say", () => {
    // "Roth IRA" in accountType is a retirement account in its own right; a
    // brokerage with nothing in its fields falls back to the profile TYPE.
    expect(accountKindOf(rothIra)).toBe("retirement");
    expect(accountKindOf(brokerage)).toBe("investment");
  });

  it("shows up in the Accounts list and the investments total", () => {
    const views = accountViews([rothIra, brokerage, checking]);
    expect(views.map(v => v.name).sort()).toEqual(["Chase Checking", "Fidelity Brokerage", "Roth IRA"]);
    const s = summarizeAccounts([rothIra, brokerage, checking]);
    expect(s.investments).toBe(95000);
    expect(s.cash).toBe(2400);
    expect(s.count).toBe(3);
  });

  it("reads the balance from currentValue as well as balance", () => {
    expect(resolveAccountBalance(rothIra)).toBe(50000);
    expect(resolveAccountBalance(brokerage)).toBe(45000);
  });

  it("is an asset only — never counted as debt from the same field", () => {
    // `investment` sits in both type sets and BOTH resolvers read
    // `fields.balance`, so a brokerage storing its value there was added to
    // assets AND subtracted as debt: one row, two errors.
    expect(isAssetProfile(brokerage)).toBe(true);
    expect(isLiabilityProfile(brokerage)).toBe(false);
    expect(isNetWorthLiabilityProfile(brokerage)).toBe(false);
    const nw = computeNetWorth([brokerage], { mode: "everyone", selectedIds: [] });
    expect(nw.assets).toBe(45000);
    expect(nw.liabilities).toBe(0);
    expect(nw.netWorth).toBe(45000);
  });

  it("stays on the Assets tab, not the Liabilities tab", () => {
    expect(isAssetTabProfile(rothIra)).toBe(true);
    expect(isLiabilityTabProfile(rothIra)).toBe(false);
  });

  it("still lets a strict check exclude investments when one is needed", () => {
    expect(isAccountTypeProfile(rothIra)).toBe(false);
    expect(isAccountTypeProfile(checking)).toBe(true);
  });
});

describe("one balance, every surface — the write reaches every reader", () => {
  // Reported from the live app with screenshots: the Roth IRA was adjusted to
  // $53,000. Finance -> Accounts showed $53,000. The Assets card still showed
  // $50,000 and Net Worth never moved.
  //
  // Cause: applyBalanceAdjustment wrote `balance`, but resolveAssetValue reads
  // `fields.currentValue` FIRST — and an investment profile created by chat
  // keeps its money there. The two numbers could never converge.
  //
  // These tests run the REAL round trip: take the fields patch the adjustment
  // produces, merge it into the profile the way updateProfile does, then ask
  // the canonical resolvers what every surface would render.

  const merge = (profile: any, patch: Record<string, any>) => ({
    ...profile, fields: { ...profile.fields, ...patch },
  });

  const rothIra = {
    id: "p-roth", type: "investment", name: "Roth IRA",
    // Exactly what the chat wrote: value in currentValue, no `balance` at all.
    fields: { accountType: "Roth IRA", currentValue: 50000 },
  };

  it("moves the Assets card and Net Worth, not just the Accounts list", () => {
    const { fields } = applyBalanceAdjustment(rothIra, { delta: 3000 }, TODAY);
    const after = merge(rothIra, fields);

    // The Accounts list.
    expect(resolveAccountBalance(after)).toBe(53000);
    expect(summarizeAccounts([after]).investments).toBe(53000);
    // The Assets grid card — this is the one that was stuck at $50,000.
    expect(resolveAssetValue(after)).toBe(53000);
    // Net Worth.
    const nw = computeNetWorth([after], { mode: "everyone", selectedIds: [] });
    expect(nw.assets).toBe(53000);
    expect(nw.netWorth).toBe(53000);
  });

  it("leaves no stale alias behind that could shadow the new number", () => {
    // resolveAssetValue walks currentValue -> marketValue -> value -> balance.
    // Any one of them still holding the old figure wins over the new one.
    const messy = {
      ...rothIra,
      fields: { ...rothIra.fields, marketValue: 50000, value: 50000, balance: 50000 },
    };
    const { fields } = applyBalanceAdjustment(messy, { newBalance: 53000 }, TODAY);
    const after = merge(messy, fields);
    expect(resolveAssetValue(after)).toBe(53000);
    expect(resolveAccountBalance(after)).toBe(53000);
  });

  it("keeps a checking account's four surfaces in agreement", () => {
    const { fields } = applyBalanceAdjustment(checking, { newBalance: 1850 }, TODAY);
    const after = merge(checking, fields);
    expect(resolveAccountBalance(after)).toBe(1850);
    expect(resolveAssetValue(after)).toBe(1850);
    expect(summarizeAccounts([after]).cash).toBe(1850);
    expect(computeNetWorth([after], { mode: "everyone", selectedIds: [] }).assets).toBe(1850);
  });

  it("moves a credit card's DEBT total, and never calls it an asset", () => {
    const { fields } = applyBalanceAdjustment(amex, { delta: 500 }, TODAY);
    const after = merge(amex, fields);
    expect(resolveAccountBalance(after)).toBe(2500);
    expect(resolveLiabilityBalance(after)).toBe(2500);
    // `currentValue` means "what this is worth" — a card balance is not that.
    expect(fields.currentValue).toBeUndefined();
    const nw = computeNetWorth([after], { mode: "everyone", selectedIds: [] });
    expect(nw.liabilities).toBe(2500);
    expect(nw.assets).toBe(0);
  });

  it("gives a newly created account the same agreement from the first render", () => {
    // balanceFieldsFor is what createAccount writes.
    const fresh = {
      id: "new", type: "account", name: "Ally Savings",
      fields: { accountKind: "savings", ...balanceFieldsFor({ type: "account", fields: { accountKind: "savings" } }, 10000) },
    };
    expect(resolveAccountBalance(fresh)).toBe(10000);
    expect(resolveAssetValue(fresh)).toBe(10000);
    expect(computeNetWorth([fresh], { mode: "everyone", selectedIds: [] }).assets).toBe(10000);
  });
});

describe("healing accounts that already drifted", () => {
  // The fix above stops new drift; this repairs the row the user is staring at
  // right now — $53,000 in Finance, $50,000 in Assets, and no reason for them
  // to edit it again just to make two screens agree.
  const drifted = {
    id: "p-roth", type: "investment", name: "Roth IRA",
    fields: {
      accountType: "Roth IRA",
      balance: 53000, currentBalance: 53000,
      currentValue: 50000, // stale — and what resolveAssetValue reads FIRST
      balanceHistory: [
        { id: "a1", date: TODAY, previousBalance: 50000, newBalance: 53000, delta: 3000, createdAt: "" },
      ],
    },
  };

  it("copies the authoritative balance into the keys the resolvers read", () => {
    expect(resolveAssetValue(drifted)).toBe(50000); // the bug, before repair
    const patch = reconcileAccountBalanceFields(drifted)!;
    expect(patch).toBeTruthy();
    const healed = { ...drifted, fields: { ...drifted.fields, ...patch } };
    expect(resolveAssetValue(healed)).toBe(53000);
    expect(resolveAccountBalance(healed)).toBe(53000);
    expect(computeNetWorth([healed], { mode: "everyone", selectedIds: [] }).assets).toBe(53000);
  });

  it("is a no-op on a healthy account, so it never writes for nothing", () => {
    const healthy = {
      ...drifted, fields: { ...drifted.fields, currentValue: 53000 },
    };
    expect(reconcileAccountBalanceFields(healthy)).toBeNull();
  });

  it("leaves alone a profile that never recorded an adjustment", () => {
    // Without a balanceHistory, `balance` was never authoritative — whatever
    // the writer put in currentValue is the truth, and overwriting it would be
    // this repair inventing a number.
    const untouched = {
      id: "x", type: "investment", name: "Brokerage",
      fields: { currentValue: 50000, balance: 1 },
    };
    expect(reconcileAccountBalanceFields(untouched)).toBeNull();
  });

  it("ignores anything that is not an account", () => {
    expect(reconcileAccountBalanceFields({ type: "vehicle", fields: { balance: 5 } })).toBeNull();
    expect(reconcileAccountBalanceFields(null)).toBeNull();
  });

  it("never writes currentValue onto a debt account while healing", () => {
    const card = {
      id: "c", type: "account", name: "Amex",
      fields: {
        accountKind: "credit_card", balance: 2500, currentBalance: 1,
        balanceHistory: [{ id: "a", date: TODAY, previousBalance: 2000, newBalance: 2500, delta: 500, createdAt: "" }],
      },
    };
    const patch = reconcileAccountBalanceFields(card)!;
    expect(patch.currentValue).toBeUndefined();
    expect(patch.currentBalance).toBe(2500);
  });
});
