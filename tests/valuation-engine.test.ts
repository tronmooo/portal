// Valuation engine + confidence/range engine: deterministic blending, honest
// confidence, no invented numbers.
import { describe, it, expect } from "vitest";
import { buildValuationContext } from "@shared/valuation/context";
import { planValuation } from "@shared/valuation/planner";
import { deriveInternalEvidence } from "@shared/valuation/internal-evidence";
import { computeValuation, errorRecord, decayFactor, roundValue, CONFLICT_CV } from "@shared/valuation/engine";
import type { ValuationEvidence } from "@shared/valuation/types";

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;

function ctxFor(fields: Record<string, any>, name = "Honda CR-V", type = "vehicle") {
  return buildValuationContext({ profile: { id: "p", name, type, fields } }, NOW);
}
function live(value: number, over: Partial<ValuationEvidence> = {}): ValuationEvidence {
  return {
    id: `live:${value}`, kind: "live_market_search", source: "KBB / Edmunds", provider: "live-search",
    observedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), value, low: value * 0.93, high: value * 1.07,
    currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * DAY, ...over,
  };
}
const opts = { now: NOW, refreshReason: "scheduled" as const };

describe("blending", () => {
  it("one strong live observation plus a user value produce a value between them with medium+ confidence", () => {
    const ctx = ctxFor({ year: 2021, make: "Honda", model: "CR-V", currentValue: 22000, currentValueSource: "user", currentValueAsOf: "2026-09-01" });
    const plan = planValuation(ctx, NOW);
    const rec = computeValuation(ctx, plan, [...deriveInternalEvidence(ctx, plan, NOW), live(20000)], opts);
    expect(rec.status).toBe("valued");
    expect(rec.value!).toBeGreaterThan(20000);
    expect(rec.value!).toBeLessThan(22000);
    expect(rec.low!).toBeLessThan(rec.value!);
    expect(rec.high!).toBeGreaterThan(rec.value!);
    expect(rec.confidence).toBeGreaterThanOrEqual(0.45);
    expect(rec.methodology).toEqual(expect.arrayContaining(["comparable_market_analysis", "user_verified_value"]));
    expect(rec.factors.join(" ")).toMatch(/KBB/);
    expect(rec.marketDataAsOf).toBe(NOW.toISOString());
  });

  it("agreeing sources raise confidence; conflicting sources cap it and widen the range", () => {
    const ctx = ctxFor({ year: 2021, make: "Honda", model: "CR-V" });
    const plan = planValuation(ctx, NOW);
    const agree = computeValuation(ctx, plan, [live(20000), live(20500, { id: "live:b", source: "Edmunds" })], opts);
    const conflict = computeValuation(ctx, plan, [live(20000), live(40000, { id: "live:b", source: "Some listing" })], opts);
    expect(agree.confidence).toBeGreaterThan(conflict.confidence);
    expect(conflict.confidence).toBeLessThanOrEqual(0.4);
    expect((conflict.high! - conflict.low!) / conflict.value!).toBeGreaterThan((agree.high! - agree.low!) / agree.value!);
    expect(conflict.factors.join(" ")).toMatch(/disagree/i);
  });

  it("stale evidence is discounted by its half-life", () => {
    expect(decayFactor(0, 30 * DAY)).toBe(1);
    expect(decayFactor(30 * DAY, 30 * DAY)).toBeCloseTo(0.5, 5);
    const ctx = ctxFor({ year: 2021, make: "Honda", model: "CR-V" });
    const plan = planValuation(ctx, NOW);
    const fresh = computeValuation(ctx, plan, [live(20000)], opts);
    const old = computeValuation(ctx, plan, [live(20000, { observedAt: new Date(NOW.getTime() - 120 * DAY).toISOString() })], opts);
    expect(old.confidence).toBeLessThan(fresh.confidence);
  });

  it("indirect evidence alone (a purchase trajectory) is low confidence with a wide range", () => {
    const ctx = ctxFor({ purchasePrice: 3400, purchaseDate: "2019-05-01" }, "Antique floor loom", "asset");
    const plan = planValuation(ctx, NOW);
    const rec = computeValuation(ctx, plan, deriveInternalEvidence(ctx, plan, NOW), opts);
    expect(rec.status).toBe("valued");
    expect(rec.confidence).toBeLessThanOrEqual(0.4);
    expect(rec.confidenceLabel).toBe("low");
    expect((rec.high! - rec.low!) / rec.value!).toBeGreaterThan(0.3);
    expect(rec.factors.join(" ")).toMatch(/indirect evidence/i);
  });

  it("a recent purchase is a strong anchor", () => {
    const ctx = ctxFor({ purchasePrice: 1200, purchaseDate: "2026-09-01" }, "Espresso machine", "asset");
    const plan = planValuation(ctx, NOW);
    const rec = computeValuation(ctx, plan, deriveInternalEvidence(ctx, plan, NOW), opts);
    expect(rec.value).toBe(1200);
    expect(rec.methodology).toEqual(["recent_transaction"]);
  });

  it("units × quote for a listed instrument", () => {
    const ctx = ctxFor({ ticker: "VTI", shares: 40 }, "Vanguard", "investment");
    const plan = planValuation(ctx, NOW);
    const quote: ValuationEvidence = { ...live(40 * 250), id: "quote", kind: "market_quote", source: "Market quote (VTI)", provider: "market-quote", reliability: 0.95, relevance: 1, halfLifeMs: 12 * 3_600_000, low: 40 * 249, high: 40 * 251 };
    const rec = computeValuation(ctx, plan, [quote], opts);
    expect(rec.value).toBe(10000);
    expect(rec.confidenceLabel).toBe("high");
    expect(rec.methodology).toEqual(["underlying_security_pricing"]);
  });
});

describe("no false precision, no invented numbers", () => {
  it("no evidence → insufficient_data with a null value and what is missing", () => {
    const ctx = ctxFor({ year: 2021, make: "Honda", model: "CR-V" });
    const plan = planValuation(ctx, NOW);
    const rec = computeValuation(ctx, plan, [], opts);
    expect(rec.status).toBe("insufficient_data");
    expect(rec.value).toBeNull();
    expect(rec.confidenceLabel).toBe("none");
    expect(rec.missingInfo).toContain("purchase price");
  });

  it("a provider that honestly found nothing does not become a number", () => {
    const ctx = ctxFor({ year: 2021, make: "Honda", model: "CR-V" });
    const plan = planValuation(ctx, NOW);
    const rec = computeValuation(ctx, plan, [live(0, { value: null, reliability: 0, relevance: 0, raw: { missing: ["trim level"] } })], opts);
    expect(rec.status).toBe("insufficient_data");
    expect(rec.missingInfo).toContain("trim level");
  });

  it("an unsupported profile stays unsupported", () => {
    const ctx = ctxFor({ balance: 100 }, "Card", "liability");
    const plan = planValuation(ctx, NOW);
    expect(computeValuation(ctx, plan, [], opts).status).toBe("unsupported");
  });

  it("values are rounded to a precision the confidence can carry", () => {
    expect(roundValue(20123.4)).toBe(20100);
    expect(roundValue(1234567)).toBe(1235000);
    expect(roundValue(123.456)).toBe(123);
    expect(roundValue(12.345)).toBe(12.35);
  });

  it("the conflict threshold is the documented one", () => {
    expect(CONFLICT_CV).toBe(0.25);
  });
});

describe("no anchoring on prior valuations", () => {
  const history = [
    { valuedAt: "2026-01-01T00:00:00Z", status: "valued" as const, value: 30000, low: 27000, high: 33000, confidence: 0.7, methodology: [], inputFingerprint: "a", refreshReason: "scheduled" as const },
    { valuedAt: "2026-06-01T00:00:00Z", status: "valued" as const, value: 30000, low: 27000, high: 33000, confidence: 0.7, methodology: [], inputFingerprint: "a", refreshReason: "scheduled" as const },
  ];
  it("prior valuations do not pull a fresh market estimate toward the old answer", () => {
    const ctx = buildValuationContext({ profile: { id: "p", name: "Honda CR-V", type: "vehicle", fields: { year: 2021, make: "Honda", model: "CR-V" } }, history }, NOW);
    const plan = planValuation(ctx, NOW);
    expect(plan.methods.map(m => m.id)).toContain("historical_trend");
    const withHistory = computeValuation(ctx, plan, [...deriveInternalEvidence(ctx, plan, NOW), live(20000)], opts);
    const noHistory = computeValuation(ctx, plan, [live(20000)], opts);
    expect(withHistory.value).toBe(noHistory.value);
    expect(withHistory.methodology).not.toContain("historical_trend");
  });
  it("…but they still carry the estimate when no market evidence came back", () => {
    const ctx = buildValuationContext({ profile: { id: "p", name: "Honda CR-V", type: "vehicle", fields: { year: 2021, make: "Honda", model: "CR-V" } }, history }, NOW);
    const plan = planValuation(ctx, NOW);
    const rec = computeValuation(ctx, plan, deriveInternalEvidence(ctx, plan, NOW), opts);
    expect(rec.status).toBe("valued");
    expect(rec.methodology).toContain("historical_trend");
  });
});

describe("error records", () => {
  it("keep the previous estimate visible and count the failure", () => {
    const ctx = ctxFor({ year: 2021, make: "Honda", model: "CR-V" });
    const plan = planValuation(ctx, NOW);
    const good = computeValuation(ctx, plan, [live(20000)], opts);
    const err = errorRecord(ctx, plan, "live-search: timed out", good, opts);
    expect(err.status).toBe("error");
    expect(err.value).toBe(good.value);
    expect(err.errorCount).toBe(1);
    const err2 = errorRecord(ctx, plan, "again", err, opts);
    expect(err2.errorCount).toBe(2);
  });
});
