// Strategy planner: methodology follows the EVIDENCE an asset can offer, never
// its type. The same `type: "asset"` gets different plans for different data.
import { describe, it, expect } from "vitest";
import { buildValuationContext } from "@shared/valuation/context";
import { planValuation, isSearchable } from "@shared/valuation/planner";
import type { AssetDataBundle } from "@shared/valuation/types";

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;

function ctxFor(fields: Record<string, any>, profile: Partial<AssetDataBundle["profile"]> = {}, extra: Partial<AssetDataBundle> = {}) {
  return buildValuationContext({ profile: { id: "p", name: "Thing", type: "asset", fields, ...profile }, ...extra }, NOW);
}
const ids = (fields: Record<string, any>, profile: Partial<AssetDataBundle["profile"]> = {}, extra: Partial<AssetDataBundle> = {}) =>
  planValuation(ctxFor(fields, profile, extra), NOW).methods.map(m => m.id);

describe("methodology is selected from evidence", () => {
  it("a tradable symbol → underlying security pricing with hours-level freshness, no live search", () => {
    const plan = planValuation(ctxFor({ ticker: "VTI", shares: 40 }, { name: "Vanguard Total Market" }), NOW);
    expect(plan.methods.map(m => m.id)).toEqual(["underlying_security_pricing"]);
    expect(plan.providers).toEqual(["market-quote"]);
    expect(plan.marketFreshnessMs).toBe(6 * 3_600_000);
    expect(plan.needsAi).toBe(false);
  });

  it("a described vehicle → comparable market analysis via live search, plus its purchase trajectory", () => {
    const m = ids({ year: 2021, make: "Honda", model: "CR-V", mileage: 80000, purchasePrice: 28000, purchaseDate: "2021-11-02" }, { name: "Honda CR-V", type: "vehicle" });
    expect(m).toContain("comparable_market_analysis");
    expect(m).toContain("value_trajectory");
    expect(m).not.toContain("recent_transaction");
  });

  it("the same profile TYPE with different evidence gets a different plan (no type → formula mapping)", () => {
    const withSymbol = ids({ symbol: "BTC", quantity: 0.5 });
    const withPurchase = ids({ purchasePrice: 1200, purchaseDate: "2026-08-20" });
    const withUserValue = ids({ currentValue: 900, currentValueSource: "user" });
    const withIncome = ids({ monthlyRent: 1500, address: "1 Main St", city: "Boise", state: "ID" });
    expect(withSymbol).toEqual(["underlying_security_pricing"]);
    expect(withPurchase).toContain("recent_transaction");
    expect(withUserValue).toContain("user_verified_value");
    expect(withIncome).toContain("income_based");
    expect(withIncome).toContain("comparable_market_analysis");
  });

  it("a purchase within 90 days is a transaction; older is a trajectory", () => {
    const recent = new Date(NOW.getTime() - 20 * DAY).toISOString().slice(0, 10);
    const old = new Date(NOW.getTime() - 400 * DAY).toISOString().slice(0, 10);
    expect(ids({ purchasePrice: 500, purchaseDate: recent })).toContain("recent_transaction");
    expect(ids({ purchasePrice: 500, purchaseDate: old })).toContain("value_trajectory");
  });

  it("user-entered value weight decays with age", () => {
    const fresh = planValuation(ctxFor({ currentValue: 100, currentValueSource: "user", currentValueAsOf: "2026-09-10" }), NOW);
    const stale = planValuation(ctxFor({ currentValue: 100, currentValueSource: "user", currentValueAsOf: "2024-01-10" }), NOW);
    const w = (p: any) => p.methods.find((m: any) => m.id === "user_verified_value").weight;
    expect(w(fresh)).toBeGreaterThan(w(stale));
  });

  it("two prior valuations enable the historical trend", () => {
    const history = [
      { valuedAt: "2026-01-01T00:00:00Z", status: "valued" as const, value: 100, low: 90, high: 110, confidence: 0.6, methodology: [], inputFingerprint: "a", refreshReason: "scheduled" as const },
      { valuedAt: "2026-06-01T00:00:00Z", status: "valued" as const, value: 110, low: 100, high: 120, confidence: 0.6, methodology: [], inputFingerprint: "a", refreshReason: "scheduled" as const },
    ];
    expect(ids({ currentValue: 100, currentValueSource: "user" }, {}, { history })).toContain("historical_trend");
  });

  it("a liability is unsupported", () => {
    const plan = planValuation(ctxFor({ balance: 5000 }, { type: "liability", name: "Card" }), NOW);
    expect(plan.methods).toEqual([]);
    expect(plan.unsupportedReason).toMatch(/not an owned asset/i);
  });

  it("an unfamiliar, sparse asset with no evidence has no methods and asks for the model", () => {
    const plan = planValuation(ctxFor({}, { name: "Grandma's quilt" }), NOW);
    expect(plan.methods).toEqual([]);
    expect(plan.needsAi).toBe(true);
    expect(plan.unsupportedReason).toMatch(/not enough information/i);
  });

  it("an unfamiliar asset WITH evidence is still valued, deterministically", () => {
    const plan = planValuation(ctxFor({ purchasePrice: 3400, purchaseDate: "2019-05-01", maker: "Hornsby", model: "Model 12 loom" }, { name: "Antique floor loom" }), NOW);
    expect(plan.methods.map(m => m.id)).toContain("value_trajectory");
    expect(plan.searchable).toBe(true);
  });
});

describe("searchability", () => {
  it("a generic name alone is not searchable; brand + model is", () => {
    expect(isSearchable(ctxFor({}, { name: "My car" }))).toBe(false);
    expect(isSearchable(ctxFor({ brand: "Fender", model: "Stratocaster" }, { name: "Guitar" }))).toBe(true);
  });
  it("an address or VIN is always searchable", () => {
    expect(isSearchable(ctxFor({ address: "1 Main St", city: "Boise", state: "ID" }, { name: "Home", type: "property" }))).toBe(true);
    expect(isSearchable(ctxFor({ vin: "1HGCM82633A004352" }, { name: "Car", type: "vehicle" }))).toBe(true);
  });
  it("a cash balance is not searchable", () => {
    expect(isSearchable(ctxFor({ balance: 1000 }, { name: "Savings", type: "account" }))).toBe(false);
  });
  it("the model's understanding can override in both directions", () => {
    const base = { source: "ai" as const, kind: "x", valueDrivers: [], volatility: "medium" as const, expectedAnnualChangePct: null, usefulLifeYears: null, tradableSymbol: null, methodologyHints: [], missingInfo: [], signature: "s", generatedAt: NOW.toISOString() };
    expect(isSearchable(ctxFor({}, { name: "My car" }, { understanding: { ...base, searchable: true, searchQuery: "2018 sedan value" } }))).toBe(true);
    expect(isSearchable(ctxFor({ brand: "Fender", model: "Stratocaster" }, { name: "Guitar" }, { understanding: { ...base, searchable: false, searchQuery: null } }))).toBe(false);
  });
  it("volatility from the understanding sets market freshness", () => {
    const base = { source: "ai" as const, kind: "x", valueDrivers: [], expectedAnnualChangePct: null, usefulLifeYears: null, tradableSymbol: null, methodologyHints: [], missingInfo: [], signature: "s", generatedAt: NOW.toISOString(), searchable: true, searchQuery: "q" };
    const hi = planValuation(ctxFor({ brand: "A", model: "B" }, {}, { understanding: { ...base, volatility: "high" } }), NOW);
    const lo = planValuation(ctxFor({ brand: "A", model: "B" }, {}, { understanding: { ...base, volatility: "low" } }), NOW);
    expect(hi.marketFreshnessMs).toBe(7 * DAY);
    expect(lo.marketFreshnessMs).toBe(90 * DAY);
  });
});
