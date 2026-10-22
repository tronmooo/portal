// Itemized market research (user report 2026-10-21): a 2021 Honda CR-V at
// 69,063 miles was valued at $28,500 — one model's one-shot answer, built from
// dealer asking prices, with the trim stored as "unknown" though the VIN was
// on file. Research now records every price it read on a stated basis; code
// restates each as fair market value, pools them (median, outliers set aside)
// and treats the one-shot figure as a cross-check.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { MemStorage } from "../server/storage";
import { refreshValuation } from "../server/valuation/service";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import { marketResearchProvider, setResearchersForTest, extractJson, researchBrief, runResearchers, configuredResearchers } from "../server/valuation/providers/market-research";
import { decodeVin, findVin, isValidVin, setVinDecoderForTest } from "../server/valuation/vin-decode";
import type { EvidenceProvider } from "../server/valuation/providers/types";
import {
  buildValuationContext, computeValuation, excludeNewUnits, fairMarketEquivalent, isAssetNew, normalizeResearch, observationsToEvidence,
  planValuation, poolComparables, roundValue,
} from "@shared/valuation";
import type { ValuationEvidence } from "@shared/valuation/types";

const NOW = new Date("2026-10-21T12:00:00Z");
const DAY = 86_400_000;
const HONDA_VIN = "7FARW2H70ME032834";

/** What a good research pass over the CR-V reads (illustrative figures). */
const HONDA_RESEARCH = {
  identity: "2021 Honda CR-V EX AWD, 69k miles, Florida",
  observations: [
    { price: 22400, type: "guide", basis: "private_party", source: "Kelley Blue Book", url: "https://www.kbb.com/honda/cr-v/2021/", similarity: 0.95, details: "EX AWD, 69k mi, good" },
    { price: 19300, type: "guide", basis: "trade_in", source: "Kelley Blue Book", url: "https://www.kbb.com/honda/cr-v/2021/", similarity: 0.95, details: "EX AWD, 69k mi, good" },
    { price: 21800, type: "guide", basis: "private_party", source: "Edmunds", url: "https://www.edmunds.com/honda/cr-v/2021/appraisal-value/", similarity: 0.9, details: "EX, 69k mi" },
    { price: 24995, type: "listing", basis: "dealer_retail", source: "CarGurus", url: "https://www.cargurus.com/a", date: "2026-10-10", similarity: 0.8, details: "EX AWD 66k mi, Orlando dealer" },
    { price: 26500, type: "listing", basis: "dealer_retail", source: "Autotrader", url: "https://www.autotrader.com/b", date: "2026-10-12", similarity: 0.75, details: "EX-L 61k mi, Tampa dealer" },
    { price: 12500, type: "listing", basis: "private_party", source: "Facebook Marketplace", url: "https://facebook.com/c", similarity: 0.4, details: "rebuilt title, 98k mi" },
  ],
  newPrice: 30660,
  depreciates: true,
  specs: { trim: "EX", drivetrain: "AWD" },
  missing: ["condition"],
};

function liveSearch(value: number): EvidenceProvider {
  return {
    id: "live-search",
    supports: (_c, plan) => plan.providers.includes("live-search"),
    fetch: async (run) => [{
      id: "live-search:blend", kind: "live_market_search", source: "Live market search", provider: "live-search",
      observedAt: run.now.toISOString(), fetchedAt: run.now.toISOString(), value, low: value * 0.9, high: value * 1.1,
      currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * DAY,
    } as ValuationEvidence],
  };
}

async function seedHonda(storage: MemStorage) {
  return storage.createProfile({
    name: "Honda CR-V 2021", type: "vehicle",
    fields: { vin: HONDA_VIN, make: "Honda", year: 2021, model: "CR-V", trim: "unknown", mileage: 69063, state: "Florida" },
    tags: [], notes: "",
  } as any);
}

describe("market observations → fair-market comparables", () => {
  it("restates each price on the fair-market basis: asking prices and dealer retail come down, trade-in comes up", () => {
    const [o] = normalizeResearch({ observations: [{ price: 25000, type: "listing", basis: "dealer_retail", source: "CarGurus" }] }).observations;
    expect(fairMarketEquivalent(o)).toBeCloseTo(25000 * 0.9 * 0.95);
    const [t] = normalizeResearch({ observations: [{ price: 18000, type: "guide", basis: "trade_in", source: "KBB" }] }).observations;
    expect(fairMarketEquivalent(t)).toBeCloseTo(18000 * 1.15);
    const [n] = normalizeResearch({ observations: [{ price: 30000, type: "guide", basis: "new_retail", source: "Honda" }] }).observations;
    expect(fairMarketEquivalent(n)).toBeNull();
  });

  it("drops malformed observations instead of guessing, and placeholder specs", () => {
    const r = normalizeResearch({
      observations: [
        { price: 0, type: "sold", source: "eBay" },
        { price: 500, type: "rumor", source: "eBay" },
        { price: 500, type: "sold" },
        { price: "$1,250", type: "sold", source: "eBay", url: "javascript:alert(1)" },
      ],
      specs: { trim: "unknown", sqft: 1800, "bad key": "x" },
    });
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]).toMatchObject({ price: 1250, url: null });
    expect(r.specs).toEqual({ sqft: 1800 });
  });

  it("pools comparables by median and sets aside an outlier", () => {
    const pooled = poolComparables([20000, 21000, 22000, 22500, 12000].map(value => ({ value, weight: 1 })))!;
    expect(pooled.dropped).toEqual([4]);
    expect(pooled.value).toBe(21000);
    expect(pooled.low).toBeLessThanOrEqual(pooled.value);
    expect(pooled.high).toBeGreaterThanOrEqual(pooled.value);
  });

  it("the engine prices the CR-V from the comps, not from a dealer-asking one-shot figure", () => {
    const ctx = buildValuationContext({ profile: { id: "h", name: "Honda CR-V 2021", type: "vehicle", fields: { vin: HONDA_VIN, make: "Honda", year: 2021, model: "CR-V", mileage: 69063 } } }, NOW);
    const plan = planValuation(ctx, NOW);
    expect(plan.providers).toEqual(["market-research", "live-search"]);
    const research = normalizeResearch(HONDA_RESEARCH);
    const comps = observationsToEvidence(research.observations, { now: NOW, halfLifeMs: 180 * DAY, provider: "market-research" });
    const oneShot: ValuationEvidence = {
      id: "live-search:blend", kind: "live_market_search", source: "Live search", provider: "live-search",
      observedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), value: 28500, low: 21700, high: 35300,
      currency: "USD", reliability: 0.8, relevance: 0.65, halfLifeMs: 30 * DAY,
    };
    const rec = computeValuation(ctx, plan, [...comps, oneShot], { now: NOW, refreshReason: "user_requested" });
    expect(rec.status).toBe("valued");
    expect(rec.value!).toBeGreaterThan(20000);
    expect(rec.value!).toBeLessThan(24000);
    expect(rec.factors.some(f => /Set aside 1 comparable/.test(f))).toBe(true);
    expect(rec.factors.some(f => /Market comparables \(5\)/.test(f))).toBe(true);
    // Every itemized observation stays visible in the record.
    expect(rec.evidence.filter(e => e.kind === "comparable")).toHaveLength(6);
  });

  it("caps a depreciating item at its price new", () => {
    const ctx = buildValuationContext({ profile: { id: "p", name: "iPhone 17 Pro Max", type: "asset", fields: { make: "Apple", model: "iPhone 17 Pro Max", year: 2026 } } }, NOW);
    const plan = planValuation(ctx, NOW);
    const comps = observationsToEvidence(normalizeResearch({
      observations: [1500, 1550, 1600].map(price => ({ price, type: "sold", basis: "fair_market", source: "eBay", similarity: 0.5 })),
    }).observations, { now: NOW, halfLifeMs: 90 * DAY, provider: "market-research" });
    const summary: ValuationEvidence = {
      id: "market-research:summary", kind: "model_estimate", source: "research", provider: "market-research",
      observedAt: NOW.toISOString(), fetchedAt: NOW.toISOString(), value: null, currency: "USD", reliability: 0, relevance: 0,
      halfLifeMs: 90 * DAY, raw: { newPrice: 1199, depreciates: true },
    };
    const rec = computeValuation(ctx, plan, [...comps, summary], { now: NOW, refreshReason: "user_requested" });
    expect(rec.value).toBe(1200); // $1,199 at the display precision for a four-figure value
    expect(rec.factors.some(f => /price new/.test(f))).toBe(true);
  });
});

describe("VIN", () => {
  it("validates the check digit and finds a VIN in free text", () => {
    expect(isValidVin(HONDA_VIN)).toBe(true);
    expect(isValidVin("7FARW2H71ME032834")).toBe(false);
    expect(findVin(`registered, VIN ${HONDA_VIN}, plate on file`)).toBe(HONDA_VIN);
  });

  it("decodes to canonical spec keys, taking the trim from Series when Trim is empty", async () => {
    setVinDecoderForTest(async () => ({ ModelYear: "2021", Make: "HONDA", Model: "CR-V", Trim: "", Series: "EX", DriveType: "AWD/All-Wheel Drive", DisplacementL: "1.5" }));
    try {
      const specs = await decodeVin(HONDA_VIN, new AbortController().signal);
      expect(specs).toMatchObject({ year: 2021, make: "HONDA", model: "CR-V", trim: "EX", drivetrain: "AWD/All-Wheel Drive", engineLiters: 1.5 });
      expect(specs).not.toHaveProperty("series");
    } finally { setVinDecoderForTest(null); }
  });
});

describe("market research provider through the refresh", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { setEvidenceProvidersForTest(null); setResearchersForTest(null); setVinDecoderForTest(null); });

  it("values the CR-V from research, fills the decoded trim over the stored 'unknown', and keeps the brief free of the VIN", async () => {
    const p = await seedHonda(storage);
    const briefs: string[] = [];
    setVinDecoderForTest(async () => ({ ModelYear: "2021", Make: "HONDA", Model: "CR-V", Series: "EX", DriveType: "AWD/All-Wheel Drive" }));
    setResearchersForTest([["Stub research", async (brief) => { briefs.push(brief); return `Here you go:\n${JSON.stringify(HONDA_RESEARCH)}`; }]]);
    setEvidenceProvidersForTest([marketResearchProvider, liveSearch(28500)]);

    const out = await refreshValuation(storage, p.id, { reason: "user_requested", force: true, now: NOW });
    const rec = out.snapshot!.record!;
    expect(rec.status).toBe("valued");
    expect(rec.value!).toBeGreaterThan(20000);
    expect(rec.value!).toBeLessThan(24000);
    expect(briefs[0]).toContain("mileage 69,063");
    expect(briefs[0]).toContain("trim: EX");
    expect(briefs[0]).not.toContain(HONDA_VIN);
    expect(briefs[0]).not.toMatch(/trim: unknown/);

    const fields = (await storage.getProfile(p.id))!.fields as any;
    expect(fields.trim).toBe("EX");
    expect(fields.currentValue).toBe(rec.value);
    expect(fields.currentValueSource).toBe("estimate");
    expect(fields.valuationSources).toContain("https://www.kbb.com/");
  });

  it("one researcher failing does not lose the other's observations", async () => {
    const p = await seedHonda(storage);
    setVinDecoderForTest(async () => null);
    setResearchersForTest([
      ["Broken", async () => { throw new Error("web search disabled"); }],
      ["Working", async () => JSON.stringify(HONDA_RESEARCH)],
    ]);
    setEvidenceProvidersForTest([marketResearchProvider]);
    const out = await refreshValuation(storage, p.id, { reason: "user_requested", force: true, now: NOW });
    const rec = out.snapshot!.record!;
    expect(rec.status).toBe("valued");
    expect(rec.evidence.filter(e => e.kind === "comparable").length).toBe(6);
  });

  it("is skipped when no researcher is configured (live search still runs)", async () => {
    const p = await seedHonda(storage);
    setResearchersForTest([]);
    setEvidenceProvidersForTest([marketResearchProvider, liveSearch(21000)]);
    const out = await refreshValuation(storage, p.id, { reason: "user_requested", force: true, now: NOW });
    expect(out.snapshot!.record!.value).toBe(21000);
    expect(out.snapshot!.record!.error ?? null).toBeNull();
  });
});

describe("plumbing", () => {
  it("extracts the JSON object from a chatty model reply", () => {
    expect(extractJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBeNull();
  });

  it("redacts long numbers from owner notes in the research brief", () => {
    const ctx = buildValuationContext({ profile: { id: "x", name: "Boat", type: "asset", fields: { make: "Yamaha", model: "242X" }, notes: "Policy 907344659, kept in a covered slip" } }, NOW);
    const brief = researchBrief(ctx, {});
    expect(brief).toContain("covered slip");
    expect(brief).not.toContain("907344659");
  });

  it("the refresh routes run on the 300s AI function, ahead of the /api catch-all", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const rewrites: Array<{ source: string; destination: string }> = vercel.rewrites;
    const idx = (src: string) => rewrites.findIndex(r => r.source === src);
    for (const src of ["/api/profiles/:id/valuation/refresh", "/api/profiles/:id/lookup-value"]) {
      expect(idx(src)).toBeGreaterThanOrEqual(0);
      expect(rewrites[idx(src)].destination).toBe("/api/ai");
      expect(idx(src)).toBeLessThan(idx("/api/:path*"));
    }
    expect(vercel.functions["api/ai.js"].maxDuration).toBeGreaterThanOrEqual(150);
  });
});

// Live check on the smoke account (2026-10-22) found three wrong answers.
describe("live-check fixes", () => {
  const ev = (raw: any[]) => observationsToEvidence(normalizeResearch({ observations: raw }).observations, { now: NOW, halfLifeMs: 180 * DAY, provider: "market-research" });

  it("a five-year-old fridge is not priced by stores selling it new", () => {
    const research = normalizeResearch({ observations: [
      { price: 1799, type: "listing", basis: "dealer_retail", source: "Home Depot", itemCondition: "new" },
      { price: 1999, type: "listing", basis: "dealer_retail", source: "Best Buy", itemCondition: "new" },
      { price: 650, type: "sold", basis: "private_party", source: "eBay", itemCondition: "used" },
      { price: 700, type: "listing", basis: "private_party", source: "Facebook Marketplace", itemCondition: "used" },
      { price: 800, type: "listing", basis: "private_party", source: "Craigslist", itemCondition: "used" },
    ] });
    expect(isAssetNew("good", 5)).toBe(false);
    expect(isAssetNew("new in box", null)).toBe(true);
    expect(isAssetNew("like new", 2)).toBe(false);
    const obs = excludeNewUnits(research.observations, false);
    const ctx = buildValuationContext({ profile: { id: "f", name: "Samsung fridge", type: "asset", fields: { brand: "Samsung", model: "RF28T5001SR", year: 2021 } } }, NOW);
    const rec = computeValuation(ctx, planValuation(ctx, NOW), observationsToEvidence(obs, { now: NOW, halfLifeMs: 180 * DAY, provider: "market-research" }), { now: NOW, refreshReason: "user_requested" });
    expect(rec.value!).toBeGreaterThan(550);
    expect(rec.value!).toBeLessThan(800);
    // A new asset keeps new-unit prices as its comparables.
    expect(excludeNewUnits(research.observations, true)[0].basis).toBe("dealer_retail");
  });

  it("bullion is never valued below its melt value", () => {
    const ctx = buildValuationContext({ profile: { id: "g", name: "American Gold Eagle 1 oz", type: "asset", fields: { brand: "US Mint", model: "American Gold Eagle", year: 2023 } } }, NOW);
    const rec = computeValuation(ctx, planValuation(ctx, NOW), ev([
      { price: 4119, type: "melt", basis: "fair_market", source: "Kitco spot" },
      { price: 3700, type: "sold", basis: "fair_market", source: "eBay", date: "2026-05-01" },
      { price: 3750, type: "sold", basis: "fair_market", source: "eBay", date: "2026-05-03" },
      { price: 3800, type: "sold", basis: "fair_market", source: "eBay", date: "2026-05-04" },
      // Dealers always ask above the metal: what makes the melt figure credible.
      { price: 4450, type: "listing", basis: "dealer_retail", source: "APMEX", similarity: 0.3 },
    ]), { now: NOW, refreshReason: "user_requested" });
    expect(rec.value).toBe(4120); // $4,119 at four-figure precision
    expect(rec.factors.some(f => /melt/.test(f))).toBe(true);
  });

  it("a melt figure above every market price is ignored, not used as a floor", () => {
    const ctx = buildValuationContext({ profile: { id: "g2", name: "American Gold Eagle 1 oz", type: "asset", fields: { brand: "US Mint", model: "American Gold Eagle", year: 2023 } } }, NOW);
    const rec = computeValuation(ctx, planValuation(ctx, NOW), ev([
      { price: 4636, type: "melt", basis: "fair_market", source: "misread spot" },
      { price: 4070, type: "offer", basis: "fair_market", source: "Money Metals buyback" },
      { price: 4150, type: "sold", basis: "fair_market", source: "eBay" },
      { price: 4475, type: "listing", basis: "fair_market", source: "JM Bullion" },
    ]), { now: NOW, refreshReason: "user_requested" });
    expect(rec.value!).toBeLessThan(4400);
    expect(rec.factors.some(f => /melt/.test(f))).toBe(false);
  });

  it("rounds small values in whole cents", () => {
    expect(roundValue(78.07)).toBe(78.07);
    expect(String(roundValue(78.0712))).toBe("78.07");
  });

  it("market evidence alone never claims more than 90% confidence", () => {
    const ctx = buildValuationContext({ profile: { id: "r", name: "Fender Player Stratocaster", type: "asset", fields: { brand: "Fender", model: "Player Stratocaster", year: 2021 } } }, NOW);
    const rec = computeValuation(ctx, planValuation(ctx, NOW), ev(
      [550, 555, 558, 560, 562, 565].map(price => ({ price, type: "sold", basis: "fair_market", source: "Reverb", similarity: 1 })),
    ), { now: NOW, refreshReason: "user_requested" });
    expect(rec.confidence).toBeLessThanOrEqual(0.9);
  });

  it("a slow researcher is abandoned shortly after another answers, and the record says so", async () => {
    const t0 = Date.now();
    const runs = await runResearchers([
      ["Fast", async () => "{}"],
      ["Slow", (_b, { signal }) => new Promise<string>((res, rej) => { const t = setTimeout(() => res("{}"), 10_000); signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); })],
    ], "brief", { signal: new AbortController().signal, region: null, graceMs: 50 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(runs[0]).toMatchObject({ name: "Fast", error: null, text: "{}" });
    expect(runs[1].name).toBe("Slow");
    expect(runs[1].error).toMatch(/timed out/);
  });
});

describe("OpenAI researcher", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; setResearchersForTest(null); });

  it("asks the same conversation for the JSON when the research came back as prose", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const text = body.previous_response_id ? JSON.stringify({ observations: [{ price: 4100, type: "sold", basis: "fair_market", source: "eBay" }] }) : "Gold Eagles sell around spot.";
      return new Response(JSON.stringify({ id: "resp_1", output_text: text }), { status: 200 });
    }));
    const researchers = configuredResearchers();
    expect(researchers.map(r => r[0])).toEqual(["OpenAI web research"]);
    const out = await researchers[0][1]("brief", { signal: new AbortController().signal, region: null });
    expect(normalizeResearch(extractJson(out)).observations).toHaveLength(1);
    expect(bodies[0].tools[0].type).toBe("web_search");
    expect(bodies[1]).toMatchObject({ previous_response_id: "resp_1" });
    expect(bodies[1].tools).toBeUndefined();
  });
});
