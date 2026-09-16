// Valuation service against the in-memory storage: cache-first snapshot,
// background refresh, invalidation, history, provider failures, user values,
// unfamiliar assets and per-user isolation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemStorage } from "../server/storage";
import { getValuationSnapshot, refreshValuation, mirrorPatchFor } from "../server/valuation/service";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import type { EvidenceProvider } from "../server/valuation/providers/types";
import { parseStorageMethod, targetForStorageMethod } from "@shared/storage-domains";
import type { ValuationEvidence } from "@shared/valuation/types";

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;

function liveEvidence(value: number, now: Date, over: Partial<ValuationEvidence> = {}): ValuationEvidence {
  return {
    id: "live-search:blend", kind: "live_market_search", source: "KBB / Edmunds", provider: "live-search",
    observedAt: now.toISOString(), fetchedAt: now.toISOString(), value, low: value * 0.93, high: value * 1.07,
    currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * DAY,
    raw: { missing: ["trim level"], specs: {} }, ...over,
  };
}

/** A fake live-search provider whose behaviour each test scripts. */
function fakeLiveSearch(impl: (run: any) => Promise<ValuationEvidence[]>): EvidenceProvider & { calls: number } {
  const p = {
    id: "live-search", calls: 0,
    supports: (_c: any, plan: any) => plan.providers.includes("live-search"),
    fetch: async (run: any) => { p.calls++; return impl(run); },
  };
  return p;
}

async function seedVehicle(storage: MemStorage, over: Record<string, any> = {}, name = "Honda CR-V") {
  const p = await storage.createProfile({
    name, type: "vehicle",
    fields: { year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", purchasePrice: 28000, purchaseDate: "2021-11-02", insurer: "Progressive", ...over },
    tags: [], notes: "Garage kept.",
  } as any);
  return p;
}

describe("valuation service", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { setEvidenceProvidersForTest(null); });

  it("first open: no record, verdict says first_valuation, nothing expensive runs", async () => {
    const p = await seedVehicle(storage);
    const t0 = performance.now();
    const snap = await getValuationSnapshot(storage, p.id, { now: NOW });
    const ms = performance.now() - t0;
    expect(snap).toMatchObject({ supported: true, record: null, freshness: { fresh: false, reason: "first_valuation" } });
    expect(ms).toBeLessThan(50);
  });

  it("refresh runs the pipeline, persists the record + history, mirrors into empty currentValue, then repeated opens are fresh and run nothing", async () => {
    const p = await seedVehicle(storage);
    const live = fakeLiveSearch(async (run) => [liveEvidence(20000, run.now)]);
    setEvidenceProvidersForTest([live]);

    const first = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    expect(first.ran).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.wrote).toBe(true);
    expect(live.calls).toBe(1);
    const rec = first.snapshot!.record!;
    expect(rec.status).toBe("valued");
    expect(rec.value).toBeGreaterThan(15000);
    expect(rec.methodology).toContain("comparable_market_analysis");
    expect(rec.methodology).toContain("value_trajectory");

    // Persisted + history + mirrored (the profile had no currentValue).
    expect(await storage.getAssetValuation(p.id)).toMatchObject({ value: rec.value, inputFingerprint: rec.inputFingerprint });
    expect(await storage.getAssetValuationHistory(p.id)).toHaveLength(1);
    const saved = (await storage.getProfile(p.id))!.fields;
    expect(saved.currentValue).toBe(rec.value);
    expect(saved.currentValueSource).toBe("estimate");
    expect(saved.purchasePrice).toBe(28000); // the original fact is intact

    // Repeated opens: fresh, no provider call.
    for (let i = 0; i < 5; i++) {
      const snap = await getValuationSnapshot(storage, p.id, { now: new Date(NOW.getTime() + i * 60_000) });
      expect(snap!.freshness.fresh).toBe(true);
      const again = await refreshValuation(storage, p.id, { reason: "scheduled", now: new Date(NOW.getTime() + i * 60_000) });
      expect(again.ran).toBe(false);
    }
    expect(live.calls).toBe(1);
  });

  it("an irrelevant edit keeps the estimate; a material edit invalidates it and re-values", async () => {
    const p = await seedVehicle(storage);
    const live = fakeLiveSearch(async (run) => [liveEvidence(run.ctx.usage.mileage > 100000 ? 16000 : 20000, run.now)]);
    setEvidenceProvidersForTest([live]);
    await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    const v1 = (await storage.getAssetValuation(p.id))!.value;

    await storage.updateProfile(p.id, { fields: { insurer: "Geico", ownerPhone: "555-0100" }, notes: "Garage kept. Parked at the office." } as any);
    const afterIrrelevant = await getValuationSnapshot(storage, p.id, { now: NOW });
    expect(afterIrrelevant!.freshness.fresh).toBe(true);
    expect((await refreshValuation(storage, p.id, { reason: "scheduled", now: NOW })).ran).toBe(false);
    expect(live.calls).toBe(1);

    await storage.updateProfile(p.id, { fields: { mileage: 130000 } } as any);
    const afterMaterial = await getValuationSnapshot(storage, p.id, { now: NOW });
    expect(afterMaterial!.freshness).toMatchObject({ fresh: false, reason: "inputs_changed" });
    const second = await refreshValuation(storage, p.id, { reason: "scheduled", now: new Date(NOW.getTime() + 60_000) });
    expect(second.ran).toBe(true);
    expect(live.calls).toBe(2);
    expect(second.snapshot!.record!.value).toBeLessThan(v1!);
    expect(second.snapshot!.record!.refreshReason).toBe("inputs_changed");
    expect(await storage.getAssetValuationHistory(p.id)).toHaveLength(2);
  });

  it("stale market evidence triggers a re-check on its own window; unchanged results are not journaled as writes", async () => {
    const p = await seedVehicle(storage);
    const live = fakeLiveSearch(async (run) => [liveEvidence(20000, run.now)]);
    setEvidenceProvidersForTest([live]);
    await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    const later = new Date(NOW.getTime() + 31 * DAY);
    const snap = await getValuationSnapshot(storage, p.id, { now: later });
    expect(snap!.freshness.fresh).toBe(false);
    expect(["market_evidence_stale", "scheduled"]).toContain(snap!.freshness.reason);
    const again = await refreshValuation(storage, p.id, { reason: "scheduled", now: later });
    expect(again.ran).toBe(true);
    expect(again.changed).toBe(false);   // same number → touch only
    expect(again.wrote).toBe(false);
    expect((await storage.getAssetValuation(p.id))!.checkedAt).toBe(later.toISOString());
    expect(await storage.getAssetValuationHistory(p.id)).toHaveLength(1);
  });

  it("a user-entered value is never overwritten, and is weighed as evidence", async () => {
    const p = await seedVehicle(storage, { currentValue: 23000, currentValueSource: "user" });
    setEvidenceProvidersForTest([fakeLiveSearch(async (run) => [liveEvidence(20000, run.now)])]);
    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    const rec = out.snapshot!.record!;
    expect(rec.methodology).toContain("user_verified_value");
    expect(rec.value).not.toBe(23000);
    const saved = (await storage.getProfile(p.id))!.fields;
    expect(saved.currentValue).toBe(23000);
    expect(saved.currentValueSource).toBe("user");
    expect(saved.valuationMethod).toBeUndefined();
  });

  it("a legacy estimator-written currentValue may be replaced; a plain user value may not", () => {
    const rec: any = { status: "valued", value: 500, low: 450, high: 550, confidenceLabel: "medium", methodSummary: "m", valuedAt: "t", factors: [], missingInfo: [], evidence: [] };
    expect(mirrorPatchFor({ currentValue: 400, valuationMethod: "Live search" }, rec, {}).patch.currentValue).toBe(500);
    const kept = mirrorPatchFor({ currentValue: 400 }, rec, {});
    expect(kept.mirrored).toBe(false);
    expect(kept.patch).toEqual({ currentValueSource: "user" });
    expect(mirrorPatchFor({}, rec, {}).patch.currentValue).toBe(500);
    expect(mirrorPatchFor({}, { ...rec, status: "insufficient_data", value: null }, {}).mirrored).toBe(false);
  });

  it("an unavailable or slow source degrades gracefully: previous estimate kept, backoff scheduled, then recovers", async () => {
    const p = await seedVehicle(storage);
    let mode: "ok" | "fail" | "slow" = "ok";
    const live = fakeLiveSearch(async (run) => {
      if (mode === "fail") throw new Error("503 from upstream");
      if (mode === "slow") await new Promise((_, reject) => run.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      return [liveEvidence(20000, run.now)];
    });
    setEvidenceProvidersForTest([live]);
    const first = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    const v1 = first.snapshot!.record!.value;

    mode = "fail";
    await storage.updateProfile(p.id, { fields: { mileage: 90000 } } as any);
    const failed = await refreshValuation(storage, p.id, { reason: "scheduled", now: NOW });
    expect(failed.ran).toBe(true);
    const rec = failed.snapshot!.record!;
    // The trajectory evidence still supports a number, so this is a partial
    // run: valued, flagged, retried soon.
    expect(rec.status).toBe("valued");
    expect(rec.error).toMatch(/live-search: 503/);
    expect(rec.errorCount).toBe(1);
    expect(new Date(rec.nextRefreshAt).getTime() - NOW.getTime()).toBeLessThanOrEqual(3_600_000);
    expect(rec.factors.join(" ")).toMatch(/unavailable/i);

    mode = "slow";
    process.env.VALUATION_LIVE_SEARCH_TIMEOUT_MS = "50";
    const slow = await refreshValuation(storage, p.id, { reason: "retry_after_error", now: new Date(NOW.getTime() + 2 * 3_600_000), force: true });
    delete process.env.VALUATION_LIVE_SEARCH_TIMEOUT_MS;
    expect(slow.snapshot!.record!.error).toMatch(/timed out/);
    expect(slow.snapshot!.record!.errorCount).toBe(2);

    mode = "ok";
    const recovered = await refreshValuation(storage, p.id, { reason: "retry_after_error", now: new Date(NOW.getTime() + 3 * 3_600_000), force: true });
    expect(recovered.snapshot!.record!.error).toBeNull();
    expect(recovered.snapshot!.record!.errorCount).toBe(0);
    expect(recovered.snapshot!.record!.value).toBeGreaterThan(0);
    expect(v1).toBeGreaterThan(0);
  });

  it("when every source fails and nothing else supports a number, the previous estimate is kept as an error record", async () => {
    const p = await storage.createProfile({ name: "Fender Stratocaster", type: "asset", fields: { brand: "Fender", model: "Stratocaster" }, tags: [], notes: "" } as any);
    const live = fakeLiveSearch(async (run) => [liveEvidence(1400, run.now)]);
    setEvidenceProvidersForTest([live]);
    await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    setEvidenceProvidersForTest([fakeLiveSearch(async () => { throw new Error("offline"); })]);
    const out = await refreshValuation(storage, p.id, { reason: "scheduled", now: new Date(NOW.getTime() + 40 * DAY) });
    const rec = out.snapshot!.record!;
    expect(rec.status).toBe("error");
    expect(rec.value).toBe(1400);
    expect(rec.errorCount).toBe(1);
    expect(out.wrote).toBe(false);
  });

  it("sparse asset → explicit insufficient_data, no invented number, no external call", async () => {
    const p = await storage.createProfile({ name: "Grandma's quilt", type: "asset", fields: {}, tags: [], notes: "" } as any);
    const live = fakeLiveSearch(async () => [liveEvidence(999, NOW)]);
    setEvidenceProvidersForTest([live]);
    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    expect(out.snapshot!.record!.status).toBe("insufficient_data");
    expect(out.snapshot!.record!.value).toBeNull();
    expect(live.calls).toBe(0);
    expect((await storage.getProfile(p.id))!.fields.currentValue).toBeUndefined();
  });

  it("an unfamiliar kind of asset is valued from whatever evidence it has, with honest confidence", async () => {
    const p = await storage.createProfile({
      name: "Beekeeping apiary (12 hives)", type: "asset",
      fields: { hives: 12, purchasePrice: 6000, purchaseDate: "2023-04-01", condition: "good", annualIncome: 2400 },
      tags: [], notes: "",
    } as any);
    setEvidenceProvidersForTest([fakeLiveSearch(async () => { throw new Error("no comps"); })]);
    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    const rec = out.snapshot!.record!;
    expect(rec.status).toBe("valued");
    expect(rec.methodology).toEqual(expect.arrayContaining(["value_trajectory", "income_based"]));
    expect(rec.confidenceLabel).toBe("low");
    expect(rec.value).toBeGreaterThan(0);
  });

  it("conflicting sources widen the range and cap confidence", async () => {
    const p = await seedVehicle(storage);
    setEvidenceProvidersForTest([fakeLiveSearch(async (run) => [
      liveEvidence(20000, run.now), liveEvidence(38000, run.now, { id: "live:2", source: "A listing" }),
    ])]);
    const rec = (await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW })).snapshot!.record!;
    expect(rec.confidence).toBeLessThanOrEqual(0.4);
    expect((rec.high! - rec.low!) / rec.value!).toBeGreaterThan(0.4);
  });

  it("valuation data never crosses users: same-named assets in two accounts are independent", async () => {
    const a = new MemStorage(), b = new MemStorage();
    const pa = await seedVehicle(a);
    const pb = await seedVehicle(b, { mileage: 20000 });
    setEvidenceProvidersForTest([fakeLiveSearch(async (run) => [liveEvidence(run.ctx.usage.mileage < 50000 ? 26000 : 20000, run.now)])]);
    const ra = (await refreshValuation(a, pa.id, { reason: "first_valuation", now: NOW })).snapshot!.record!;
    expect(await b.getAssetValuation(pb.id)).toBeNull();
    expect(await b.getAssetValuation(pa.id)).toBeNull();
    const rb = (await refreshValuation(b, pb.id, { reason: "first_valuation", now: NOW })).snapshot!.record!;
    expect(rb.value).toBeGreaterThan(ra.value!);
    expect((await a.getAssetValuation(pa.id))!.value).toBe(ra.value);
    expect(await a.getAssetValuationHistory(pb.id)).toEqual([]);
  });

  it("a lock makes concurrent refreshes of one asset share a run", async () => {
    const p = await seedVehicle(storage);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const live = fakeLiveSearch(async (run) => { await gate; return [liveEvidence(20000, run.now)]; });
    setEvidenceProvidersForTest([live]);
    const first = refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    await new Promise(r => setTimeout(r, 10));
    const second = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    expect(second.locked).toBe(true);
    expect(second.ran).toBe(false);
    release();
    expect((await first).ran).toBe(true);
    expect(live.calls).toBe(1);
  });

  it("a non-asset profile is unsupported and never valued", async () => {
    const p = await storage.createProfile({ name: "Patrick", type: "person", fields: {}, tags: [], notes: "" } as any);
    const live = fakeLiveSearch(async () => [liveEvidence(90, NOW)]);
    setEvidenceProvidersForTest([live]);
    expect((await getValuationSnapshot(storage, p.id, { now: NOW }))!.supported).toBe(false);
    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    expect(out.ran).toBe(false);
    expect(live.calls).toBe(0);
  });

  it("specs the live search found fill EMPTY fields only and do not make the record immediately stale", async () => {
    const p = await storage.createProfile({ name: "12 Elm St", type: "property", fields: { address: "12 Elm St", city: "Austin", state: "TX", bedrooms: 3 }, tags: [], notes: "" } as any);
    setEvidenceProvidersForTest([fakeLiveSearch(async (run) => [liveEvidence(410000, run.now, { raw: { specs: { sqft: 1900, bedrooms: 4 }, missing: [] } })])]);
    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    expect(out.filledSpecs).toEqual({ sqft: 1900 });
    const saved = (await storage.getProfile(p.id))!.fields;
    expect(saved.sqft).toBe(1900);
    expect(saved.bedrooms).toBe(3);
    expect((await getValuationSnapshot(storage, p.id, { now: NOW }))!.freshness.fresh).toBe(true);
  });

  it("the semantic-understanding cache is a cache, not a journaled write; the record save is an asset write", () => {
    expect(parseStorageMethod("cacheValuationUnderstanding")).toBeNull();
    expect(parseStorageMethod("touchAssetValuation")).toBeNull();
    expect(targetForStorageMethod("saveAssetValuation")!.domains).toEqual(["assets"]);
  });

  it("the semantic understanding is consulted only when planning came up short, and is cached by shape", async () => {
    const { resolveUnderstanding } = await import("../server/valuation/understanding");
    const { buildValuationContext } = await import("@shared/valuation/context");
    const p = await storage.createProfile({ name: "Grandma's quilt", type: "asset", fields: { maker: "unknown", era: "1930s" }, tags: [], notes: "" } as any);
    const ctx = buildValuationContext({ profile: { id: p.id, name: p.name, type: p.type, fields: p.fields } }, NOW);
    expect(await resolveUnderstanding(storage, ctx, { allowModel: false, now: NOW })).toBeNull();
    await storage.cacheValuationUnderstanding(p.id, {
      source: "ai", kind: "handmade quilt", valueDrivers: ["era", "condition"], volatility: "low", expectedAnnualChangePct: 0.02,
      usefulLifeYears: null, searchable: true, searchQuery: "1930s handmade quilt value", tradableSymbol: null,
      methodologyHints: ["comparable_market_analysis"], missingInfo: ["dimensions"], signature: ctx.signature, generatedAt: NOW.toISOString(),
    });
    const cached = await resolveUnderstanding(storage, ctx, { allowModel: false, now: NOW });
    expect(cached?.kind).toBe("handmade quilt");
    const other = buildValuationContext({ profile: { id: p.id, name: p.name, type: p.type, fields: { maker: "unknown", era: "1930s", sqft: 12 } } }, NOW);
    expect(await resolveUnderstanding(storage, other, { allowModel: false, now: NOW })).toBeNull();
  });
});
