// Salvage value is determined by the AI (owner, 2026-11-24). The value-tracking
// run asks for it beside the market research and stores it with its
// provenance; a figure the user typed is never replaced, and removing it hands
// the field back to the AI. See shared/asset-salvage.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../server/storage";
import { refreshValuation } from "../server/valuation/service";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import { buildValuationContext } from "@shared/valuation";
import {
  normalizeSalvageEstimate, salvageNeedsEstimate, salvageSource, stampSalvageProvenance, SALVAGE_MAX_AGE_MS,
} from "@shared/asset-salvage";
import type { ValuationEvidence } from "@shared/valuation/types";

const NOW = new Date("2026-11-24T12:00:00Z");
const DAY = 86_400_000;

function live(value: number, now: Date): ValuationEvidence {
  return {
    id: "live-search:blend", kind: "live_market_search", source: "KBB", provider: "live-search",
    observedAt: now.toISOString(), fetchedAt: now.toISOString(), value, low: value * 0.93, high: value * 1.07,
    currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * DAY, raw: { specs: {} },
  };
}

async function seed(storage: MemStorage, over: Record<string, any> = {}) {
  return storage.createProfile({
    name: "Honda CR-V", type: "vehicle",
    fields: { year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", purchasePrice: 28000, purchaseDate: "2021-11-02", ...over },
    tags: [], notes: "",
  } as any);
}

describe("the rules", () => {
  it("an unstamped figure is the user's; a stamped one is the AI's", () => {
    expect(salvageSource({})).toBeNull();
    expect(salvageSource({ salvageValue: 500 })).toBe("user");
    expect(salvageSource({ salvageValue: 500, salvageValueSource: "estimate" })).toBe("estimate");
  });

  it("asks the AI when missing, when its inputs changed, or when old — never over the user's figure", () => {
    expect(salvageNeedsEstimate({}, "k", NOW)).toBe(true);
    expect(salvageNeedsEstimate({ salvageValue: 500 }, "k", NOW)).toBe(false);
    const est = { salvageValue: 500, salvageValueSource: "estimate", salvageValueFor: "k", salvageValueAsOf: NOW.toISOString() };
    expect(salvageNeedsEstimate(est, "k", NOW)).toBe(false);
    expect(salvageNeedsEstimate(est, "k2", NOW)).toBe(true);
    expect(salvageNeedsEstimate(est, "k", new Date(NOW.getTime() + SALVAGE_MAX_AGE_MS))).toBe(true);
  });

  it("an answer above what it cost or is worth, negative or null is refused", () => {
    expect(normalizeSalvageEstimate({ salvageValue: 1800.4, basis: " scrap " }, { purchasePrice: 28000 })).toEqual({ value: 1800, basis: "scrap" });
    expect(normalizeSalvageEstimate({ salvageValue: 40000 }, { purchasePrice: 28000, currentValue: 20000 })).toBeNull();
    expect(normalizeSalvageEstimate({ salvageValue: -5 }, { purchasePrice: 28000 })).toBeNull();
    expect(normalizeSalvageEstimate({ salvageValue: null }, { purchasePrice: 28000 })).toBeNull();
    expect(normalizeSalvageEstimate("nope", {})).toBeNull();
  });

  it("a person's PATCH marks a typed figure as theirs; removing it removes the provenance too", () => {
    const typed = stampSalvageProvenance({ fields: { salvageValue: 900 } } as any);
    expect(typed.fields.salvageValueSource).toBe("user");
    const removed = stampSalvageProvenance({ fieldsToDelete: ["salvageValue"] } as any);
    expect(removed.fieldsToDelete).toEqual(expect.arrayContaining(["salvageValue", "salvageValueSource", "salvageValueBasis", "salvageValueAsOf", "salvageValueFor"]));
    // The estimator's own patch (already stamped) is left alone.
    const est = stampSalvageProvenance({ fields: { salvageValue: 900, salvageValueSource: "estimate" } } as any);
    expect(est.fields.salvageValueSource).toBe("estimate");
  });

  it("the salvage keys are outputs: writing them does not change the valuation's inputs", () => {
    const base = { id: "p", name: "Honda CR-V", type: "vehicle", fields: { make: "Honda", model: "CR-V", purchasePrice: 28000 } };
    const a = buildValuationContext({ profile: base } as any, NOW);
    const b = buildValuationContext({ profile: { ...base, fields: { ...base.fields, salvageValue: 1500, salvageValueSource: "estimate", salvageValueBasis: "x", salvageValueAsOf: NOW.toISOString(), salvageValueFor: "k" } } } as any, NOW);
    expect(b.inputFingerprint).toBe(a.inputFingerprint);
    expect(b.profileFingerprint).toBe(a.profileFingerprint);
  });
});

describe("the value-tracking run stores the AI's salvage value", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); setEvidenceProvidersForTest([{ id: "live-search", supports: (_c: any, plan: any) => plan.providers.includes("live-search"), fetch: async (run: any) => [live(20000, run.now)] } as any]); });
  afterEach(() => { setEvidenceProvidersForTest(null); });

  it("writes the estimate with its reason, and does not ask again on the next run", async () => {
    const p = await seed(storage);
    let calls = 0;
    const estimateSalvage = async () => { calls++; return { value: 1500, basis: "Scrap and parts value of a worn-out compact SUV." }; };
    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW, allowModel: true, estimateSalvage });
    expect(out.wrote).toBe(true);
    const f = (await storage.getProfile(p.id))!.fields as any;
    expect(f.salvageValue).toBe(1500);
    expect(f.salvageValueSource).toBe("estimate");
    expect(f.salvageValueBasis).toContain("Scrap");
    expect(calls).toBe(1);
    // The write did not make the asset look changed, and a forced re-run keeps the estimate.
    await refreshValuation(storage, p.id, { reason: "user_requested", force: true, now: new Date(NOW.getTime() + DAY), allowModel: true, estimateSalvage });
    expect(calls).toBe(1);
  });

  it("never replaces a figure the user typed", async () => {
    const p = await seed(storage, { salvageValue: 3000 });
    let calls = 0;
    const estimateSalvage = async () => { calls++; return { value: 1500, basis: "" }; };
    await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW, allowModel: true, estimateSalvage });
    expect(calls).toBe(0);
    expect((await storage.getProfile(p.id))!.fields.salvageValue).toBe(3000);
  });

  it("a figure typed while the AI was answering wins", async () => {
    const p = await seed(storage);
    const estimateSalvage = async () => {
      await storage.updateProfile(p.id, stampSalvageProvenance({ fields: { salvageValue: 2500 } }) as any);
      return { value: 1500, basis: "" };
    };
    await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW, allowModel: true, estimateSalvage });
    const f = (await storage.getProfile(p.id))!.fields as any;
    expect(f.salvageValue).toBe(2500);
    expect(f.salvageValueSource).toBe("user");
  });

  it("with no model, nothing is guessed", async () => {
    const p = await seed(storage);
    await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW, allowModel: false });
    expect((await storage.getProfile(p.id))!.fields.salvageValue).toBeUndefined();
  });
});
