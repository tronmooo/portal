// tests/investments.test.ts
//
// Investment accounts (Roth IRA / 401k / brokerage / crypto wallet) with
// stock / ETF / crypto holdings — "Make sure u can [add] investment account
// Roth IRA etc with stock and crypto etc" (user, 2026-08-10).
//
// Two layers:
//   • shared/investments — the pure holdings math both the server tools and
//     the Finance-tab UI use (one model, no drift);
//   • the chat executors — add/update/remove_investment_holding +
//     get_investment_summary, including account auto-creation and the
//     net-worth integration through get_financial_overview.
import { describe, it, expect } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";
import {
  detectAccountType, detectAssetClass, normalizeHolding, mergeHolding,
  holdingsValue, holdingsInvested, allocationByClass, accountFieldsPatch,
} from "../shared/investments";

const USER = "investments-user";
const run = <T,>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

describe("shared/investments — the holdings model", () => {
  it("detects account types from names", () => {
    expect(detectAccountType("My Roth IRA")).toBe("roth_ira");
    expect(detectAccountType("Fidelity 401k")).toBe("401k");
    expect(detectAccountType("Coinbase")).toBe("crypto_wallet");
    expect(detectAccountType("Schwab brokerage")).toBe("brokerage");
    expect(detectAccountType("HSA")).toBe("hsa");
  });

  it("detects asset classes: crypto coins, common ETFs, default stock", () => {
    expect(detectAssetClass("BTC")).toBe("crypto");
    expect(detectAssetClass("ETH")).toBe("crypto");
    expect(detectAssetClass("VOO")).toBe("etf");
    expect(detectAssetClass("AAPL")).toBe("stock");
    expect(detectAssetClass("AAPL", "bond")).toBe("bond");
  });

  it("normalizes: per-unit price OR total cost basis, fractional quantities", () => {
    const byPrice = normalizeHolding({ symbol: "aapl", quantity: 10, price: 180 });
    expect(byPrice).toMatchObject({ symbol: "AAPL", quantity: 10, currentPrice: 180, costBasis: 1800 });
    const byTotal = normalizeHolding({ symbol: "BTC", quantity: 0.05, costBasis: 3000 });
    expect(byTotal.currentPrice).toBe(60000); // derived per-unit
    expect(byTotal.assetClass).toBe("crypto");
    expect(() => normalizeHolding({ symbol: "", quantity: 1 })).toThrow(/symbol/i);
    expect(() => normalizeHolding({ symbol: "X", quantity: -1 })).toThrow(/quantity/i);
  });

  it("merges a repeat buy into the position; value/invested/allocation add up", () => {
    const a = normalizeHolding({ symbol: "VOO", quantity: 10, price: 500 });
    const b = normalizeHolding({ symbol: "VOO", quantity: 5, price: 520 });
    const merged = mergeHolding([a], b);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ quantity: 15, costBasis: 7600, currentPrice: 520 });
    const withBtc = mergeHolding(merged, normalizeHolding({ symbol: "BTC", quantity: 0.1, price: 60000 }));
    expect(holdingsValue(withBtc)).toBe(15 * 520 + 6000);
    expect(holdingsInvested(withBtc)).toBe(7600 + 6000);
    expect(allocationByClass(withBtc)).toEqual({ etf: 7800, crypto: 6000 });
    expect(accountFieldsPatch(withBtc)).toMatchObject({ currentValue: 13800, totalInvested: 13600, holdingsCount: 2 });
  });
});

describe("chat executors — full holding lifecycle", () => {
  it("auto-creates the Roth IRA, adds stock + crypto, values the account", async () => {
    const storage = new MemStorage();
    const res = await run(storage, () => executeTool("add_investment_holding", {
      account: "Roth IRA", symbol: "VOO", quantity: 10, price: 520,
    }, USER));
    expect(res.error).toBeUndefined();
    expect(res.accountCreated).toBe(true);
    expect(res.accountValue).toBe(5200);

    // Second buy of the same symbol merges; different symbol appends.
    await run(storage, () => executeTool("add_investment_holding", { account: "Roth IRA", symbol: "VOO", quantity: 5, price: 530 }, USER));
    const btc = await run(storage, () => executeTool("add_investment_holding", { account: "Coinbase wallet", symbol: "BTC", quantity: 0.05, costBasis: 3000 }, USER));
    expect(btc.accountCreated).toBe(true);

    const accounts = await run(storage, () => storage.getProfiles());
    const roth = accounts.find((p: any) => p.name === "Roth IRA")!;
    expect((roth as any).fields.accountType).toBe("roth_ira");
    expect((roth as any).fields.holdings).toHaveLength(1);
    expect((roth as any).fields.holdings[0]).toMatchObject({ symbol: "VOO", quantity: 15 });
    expect((roth as any).fields.currentValue).toBe(15 * 530);
  });

  it("updates price / partial sale, removes on full sale, errors honestly", async () => {
    const storage = new MemStorage();
    await run(storage, () => executeTool("add_investment_holding", { account: "Brokerage", symbol: "TSLA", quantity: 10, price: 200 }, USER));

    const priced = await run(storage, () => executeTool("update_investment_holding", { symbol: "TSLA", changes: { price: 250 } }, USER));
    expect(priced.holding).toMatchObject({ quantity: 10, currentPrice: 250 });
    expect(priced.accountValue).toBe(2500);

    const partial = await run(storage, () => executeTool("update_investment_holding", { symbol: "TSLA", changes: { quantity: 4 } }, USER));
    expect(partial.holding.quantity).toBe(4);

    const missing = await run(storage, () => executeTool("update_investment_holding", { symbol: "NVDA", changes: { price: 100 } }, USER));
    expect(missing.error).toMatch(/no nvda position/i);

    const removed = await run(storage, () => executeTool("remove_investment_holding", { symbol: "TSLA" }, USER));
    expect(removed.removed).toBe(true);
    expect(removed.accountValue).toBe(0);
  });

  it("disambiguates a symbol held in two accounts", async () => {
    const storage = new MemStorage();
    await run(storage, () => executeTool("add_investment_holding", { account: "Roth IRA", symbol: "VOO", quantity: 1, price: 500 }, USER));
    await run(storage, () => executeTool("add_investment_holding", { account: "Brokerage", symbol: "VOO", quantity: 2, price: 500 }, USER));
    const ambiguous = await run(storage, () => executeTool("update_investment_holding", { symbol: "VOO", changes: { price: 510 } }, USER));
    expect(ambiguous.error).toMatch(/2 accounts/);
    expect(ambiguous.candidates).toEqual(expect.arrayContaining(["Roth IRA", "Brokerage"]));
    const narrowed = await run(storage, () => executeTool("update_investment_holding", { symbol: "VOO", account: "Roth", changes: { price: 510 } }, USER));
    expect(narrowed.updated).toBe(true);
    expect(narrowed.account).toBe("Roth IRA");
  });

  it("get_investment_summary reports accounts, gain/loss, and allocation", async () => {
    const storage = new MemStorage();
    const summary = await run(storage, async () => {
      await executeTool("add_investment_holding", { account: "Roth IRA", symbol: "VOO", quantity: 10, price: 500 }, USER);
      await executeTool("update_investment_holding", { symbol: "VOO", changes: { price: 550 } }, USER);
      await executeTool("add_investment_holding", { account: "Coinbase", symbol: "ETH", quantity: 2, price: 3000 }, USER);
      return executeTool("get_investment_summary", {}, USER);
    });
    expect(summary.accounts).toHaveLength(2);
    expect(summary.total_value).toBe(5500 + 6000);
    expect(summary.total_invested).toBe(5000 + 6000);
    expect(summary.total_gain).toBe(500);
    expect(summary.allocation_by_class).toEqual({ etf: 5500, crypto: 6000 });
    const roth = summary.accounts.find((a: any) => a.account === "Roth IRA");
    expect(roth.holdings[0]).toMatchObject({ symbol: "VOO", gain: 500 });

    const one = await run(storage, () => executeTool("get_investment_summary", { account: "coinbase" }, USER));
    expect(one.accounts).toHaveLength(1);
  });

  it("holdings feed net worth and the financial overview", async () => {
    const storage = new MemStorage();
    const overview = await run(storage, async () => {
      await executeTool("add_investment_holding", { account: "Roth IRA", symbol: "VOO", quantity: 10, price: 500 }, USER);
      await executeTool("update_investment_holding", { symbol: "VOO", changes: { price: 550 } }, USER);
      return executeTool("get_financial_overview", {}, USER);
    });
    expect(overview.investments).toMatchObject({ total_invested: 5000, current_value: 5500, count: 1 });
    expect(overview.net_worth.assets).toBeGreaterThanOrEqual(5500);
  });
});
