// ─── Per-asset automatic value tracking (user request, 2026-09-22) ──────────
//
// "There should be an option to edit the asset value to allow AI to not gather
//  the value ... so I can manually add it in if I have to."
//
// The switch is `fields.valuationMode`, read ONLY through
// isAutoValuationEnabled. The hard rule these tests pin: tracking is ALWAYS ON
// by default — absent, empty, or an unrecognised value all mean "auto", so
// every asset that predates the switch and every newly created one behaves
// bit-for-bit as before. Only a deliberate "manual" turns it off, and then
// nothing is gathered at all: no provider, no model, no scheduled refresh, no
// write — including by a run that was already in flight when the user flipped
// it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

const { stubState, stubStorage } = vi.hoisted(() => {
  process.env.DISABLE_RESPONSE_CACHE = "1";
  const state = {
    profiles: new Map<string, any>(),
    preferences: new Map<string, string>(),
    updates: [] as Array<{ id: string; patch: any }>,
  };
  const impl: any = {
    async getProfile(id: string) { return state.profiles.get(id); },
    async getProfileDetail(id: string) { return state.profiles.get(id); },
    async getProfiles() { return [...state.profiles.values()]; },
    async getAssetPartyLinks() { return []; },
    async getLiabilityProfileLinks() { return []; },
    async updateProfile(id: string, patch: any) {
      state.updates.push({ id, patch });
      const cur = state.profiles.get(id);
      if (cur) state.profiles.set(id, { ...cur, ...patch, fields: { ...cur.fields, ...patch.fields } });
      return state.profiles.get(id);
    },
    async getPreference(key: string) { return state.preferences.get(key) ?? null; },
    async setPreference(key: string, value: string) { state.preferences.set(key, value); },
    async getAssetValuation(id: string) { const raw = state.preferences.get(`valuation:${id}`); return raw ? JSON.parse(raw) : null; },
    async saveAssetValuation(id: string, record: any) { state.preferences.set(`valuation:${id}`, JSON.stringify(record)); },
    async touchAssetValuation(id: string, record: any) { state.preferences.set(`valuation:${id}`, JSON.stringify(record)); },
    async getAssetValuationHistory() { return []; },
    async getValuationUnderstanding() { return null; },
    async cacheValuationUnderstanding() {},
    async bumpDataVersions() { return { epoch: 1 }; },
    async getDataVersions() { return { epoch: 1 }; },
  };
  const storage = new Proxy(impl, {
    get(target, prop) { return prop in target ? target[prop] : async () => undefined; },
  });
  return { stubState: state, stubStorage: storage };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: stubStorage };
});

import { MemStorage } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { getValuationSnapshot, getValuationStatus, refreshValuation } from "../server/valuation/service";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import { isAutoValuationEnabled, VALUATION_MODE_FIELD } from "@shared/valuation/context";
import { isAdministrativeKey } from "@shared/overview-semantics";
import { fieldKeyLabel, enumOptionsForField, humanizeEnumValue } from "@shared/field-label";
import type { EvidenceProvider } from "../server/valuation/providers/types";
import type { ValuationEvidence } from "@shared/valuation/types";

const NOW = new Date("2026-09-22T12:00:00Z");
const DAY = 86_400_000;

function liveEvidence(value: number, now: Date): ValuationEvidence {
  return {
    id: "live-search:blend", kind: "live_market_search", source: "KBB / Edmunds", provider: "live-search",
    observedAt: now.toISOString(), fetchedAt: now.toISOString(), value, low: value * 0.93, high: value * 1.07,
    currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * DAY, raw: { missing: [], specs: {} },
  };
}
function fakeLiveSearch(impl: (run: any) => Promise<ValuationEvidence[]>): EvidenceProvider & { calls: number } {
  const p = {
    id: "live-search", calls: 0,
    supports: (_c: any, plan: any) => plan.providers.includes("live-search"),
    fetch: async (run: any) => { p.calls++; return impl(run); },
  };
  return p;
}
async function seedLaptop(storage: MemStorage, over: Record<string, any> = {}) {
  return storage.createProfile({
    name: "MacBook Pro M4", type: "asset",
    fields: { brand: "Apple", model: "MacBook Pro 16 M4", condition: "good", purchasePrice: 2499, purchaseDate: "2025-01-10", ...over },
    tags: [], notes: "Daily driver.",
  } as any);
}

// ── 1. The predicate: absent means AUTO, always ────────────────────────────

describe("isAutoValuationEnabled — the one reader of valuationMode", () => {
  it("treats absent / empty / unrecognised as automatic (never as manual)", () => {
    for (const fields of [
      undefined, null, {},
      { valuationMode: undefined }, { valuationMode: null }, { valuationMode: "" }, { valuationMode: "   " },
      { valuationMode: "auto" }, { valuationMode: "AUTO" }, { valuationMode: "Automatic" },
      { valuationMode: "off" }, { valuationMode: "yes" }, { valuationMode: 0 }, { valuationMode: false },
      { valuation_mode: "auto" },
      { currentValue: 1200, currentValueSource: "user" }, // a user value alone never means manual
    ] as any[]) {
      expect(isAutoValuationEnabled(fields)).toBe(true);
    }
  });

  it("turns off only on a deliberate \"manual\", in either key spelling", () => {
    expect(isAutoValuationEnabled({ valuationMode: "manual" })).toBe(false);
    expect(isAutoValuationEnabled({ valuationMode: "Manual" })).toBe(false);
    expect(isAutoValuationEnabled({ valuationMode: "  MANUAL  " })).toBe(false);
    expect(isAutoValuationEnabled({ valuation_mode: "manual" })).toBe(false);
    expect(VALUATION_MODE_FIELD).toBe("valuationMode");
  });

  it("the raw key never reaches the generic field UI as a chip (F-55 class)", () => {
    // Administrative → the Overview/field lists drop it…
    expect(isAdministrativeKey("valuationMode")).toBe(true);
    expect(isAdministrativeKey("valuation_mode")).toBe(true);
    // …and if it is ever labelled, it reads as English, with English options.
    expect(fieldKeyLabel("valuationMode")).toBe("Automatic value tracking");
    expect(humanizeEnumValue("manual")).toBe("Off — you set the value yourself");
    expect(enumOptionsForField("valuationMode")!.map(o => o.value)).toEqual(["auto", "manual"]);
    for (const o of enumOptionsForField("valuationMode")!) expect(o.label).not.toBe(o.value);
    // The profile page's "Other (N)" catch-all hides it too.
    const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "client/src/pages/profile-detail.tsx"), "utf8");
    const hidden = page.match(/ALWAYS_HIDDEN_FROM_OTHER = new Set\(\[([\s\S]*?)\]\)/)![1];
    expect(hidden).toContain('"valuationMode"');
    expect(hidden).toContain('"valuation_mode"');
  });
});

// ── 2/3/4. The service ──────────────────────────────────────────────────────

describe("valuation service honours the switch", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { setEvidenceProvidersForTest(null); });

  it("a brand-new asset carries no valuationMode and is estimated exactly as before", async () => {
    const p = await seedLaptop(storage);
    expect((p.fields as any).valuationMode).toBeUndefined();
    expect((p.fields as any).valuation_mode).toBeUndefined();
    const live = fakeLiveSearch(async (run) => [liveEvidence(1400, run.now)]);
    setEvidenceProvidersForTest([live]);

    const snap = await getValuationSnapshot(storage, p.id, { now: NOW });
    expect(snap).toMatchObject({ supported: true, mode: "auto", freshness: { fresh: false, reason: "first_valuation" } });

    const out = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    expect(out.ran).toBe(true);
    expect(out.wrote).toBe(true);
    expect(live.calls).toBe(1);
    expect((await storage.getProfile(p.id))!.fields.currentValue).toBe(out.snapshot!.record!.value);
  });

  for (const key of ["valuationMode", "valuation_mode"]) {
    it(`manual (${key}) blocks the refresh entirely — no provider, no model, no write`, async () => {
      const p = await seedLaptop(storage, { [key]: "manual", currentValue: 900, currentValueSource: "user" });
      const live = fakeLiveSearch(async (run) => [liveEvidence(1400, run.now)]);
      setEvidenceProvidersForTest([live]);

      const out = await refreshValuation(storage, p.id, { reason: "user_requested", force: true, now: NOW });
      expect(out.ran).toBe(false);
      expect(out.wrote).toBe(false);
      expect(out.locked).toBe(false);
      expect(out.snapshot!.mode).toBe("manual");
      expect(live.calls).toBe(0);
      expect(await storage.getAssetValuation(p.id)).toBeNull();
      expect(await storage.getAssetValuationHistory(p.id)).toHaveLength(0);
      // Their number and its provenance are untouched.
      const saved = (await storage.getProfile(p.id))!.fields;
      expect(saved.currentValue).toBe(900);
      expect(saved.currentValueSource).toBe("user");
    });
  }

  it("a manual asset is never stale: the stored estimate stays as history and nothing schedules a refresh", async () => {
    const p = await seedLaptop(storage);
    setEvidenceProvidersForTest([fakeLiveSearch(async (run) => [liveEvidence(1400, run.now)])]);
    const first = await refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW });
    const valued = first.snapshot!.record!.value;

    await storage.updateProfile(p.id, { fields: { [VALUATION_MODE_FIELD]: "manual" } } as any);
    // Far past every refresh window, and with a material input changed.
    const later = new Date(NOW.getTime() + 400 * DAY);
    await storage.updateProfile(p.id, { fields: { condition: "fair" } } as any);

    const snap = await getValuationSnapshot(storage, p.id, { now: later });
    expect(snap!.supported).toBe(true);          // the card still renders
    expect(snap!.mode).toBe("manual");
    expect(snap!.record!.value).toBe(valued);    // history, not a lie
    expect(snap!.freshness).toMatchObject({ fresh: true, reason: null });

    // …and the Assets-tab sweep leaves it alone.
    const row = (await getValuationStatus(storage, { now: later })).find(r => r.profileId === p.id)!;
    expect(row.fresh).toBe(true);
    expect(row.reason).toBeNull();
  });

  it("switching back on resumes automatic tracking with nothing extra to press", async () => {
    const p = await seedLaptop(storage, { [VALUATION_MODE_FIELD]: "manual" });
    const live = fakeLiveSearch(async (run) => [liveEvidence(1400, run.now)]);
    setEvidenceProvidersForTest([live]);
    expect((await refreshValuation(storage, p.id, { reason: "scheduled", now: NOW })).ran).toBe(false);

    await storage.updateProfile(p.id, { fields: { [VALUATION_MODE_FIELD]: "auto" } } as any);
    const snap = await getValuationSnapshot(storage, p.id, { now: NOW });
    expect(snap!.mode).toBe("auto");
    expect(snap!.freshness.fresh).toBe(false);   // eligible again
    const out = await refreshValuation(storage, p.id, { reason: "scheduled", now: NOW });
    expect(out.ran).toBe(true);
    expect(live.calls).toBe(1);
  });

  it("a refresh already in flight when the user switches off is DISCARDED, not written over their value", async () => {
    const p = await seedLaptop(storage, { currentValue: 950, currentValueSource: "user" });
    // The provider is the slow part: the user flips the switch while it runs.
    const live = fakeLiveSearch(async (run) => {
      await storage.updateProfile(p.id, { fields: { [VALUATION_MODE_FIELD]: "manual" } } as any);
      return [liveEvidence(1400, run.now)];
    });
    setEvidenceProvidersForTest([live]);

    const out = await refreshValuation(storage, p.id, { reason: "user_requested", force: true, now: NOW });
    expect(live.calls).toBe(1);        // it did run — it just must not land
    expect(out.ran).toBe(false);
    expect(out.wrote).toBe(false);
    expect(out.snapshot!.mode).toBe("manual");
    expect(await storage.getAssetValuation(p.id)).toBeNull();
    expect(await storage.getAssetValuationHistory(p.id)).toHaveLength(0);
    const saved = (await storage.getProfile(p.id))!.fields;
    expect(saved.currentValue).toBe(950);
    expect(saved.currentValueSource).toBe("user");
  });
});

// ── The routes are the real gate ────────────────────────────────────────────

describe("valuation routes refuse a manual asset", () => {
  let server: Server;
  let base: string;
  let liveCalls = 0;

  const laptop = (fields: Record<string, any> = {}) => ({
    id: "p1", name: "MacBook Pro M4", type: "asset",
    fields: { brand: "Apple", model: "MacBook Pro 16 M4", condition: "good", purchasePrice: 2499, ...fields },
    notes: "", tags: [], relatedExpenses: [], relatedDocuments: [], relatedTrackers: [], relatedTasks: [],
    relatedEvents: [], relatedObligations: [], relatedHabits: [], childProfiles: [], timeline: [],
  });

  beforeEach(async () => {
    stubState.profiles.clear(); stubState.preferences.clear(); stubState.updates.length = 0;
    liveCalls = 0;
    setEvidenceProvidersForTest([{
      id: "live-search",
      supports: (_c, plan) => plan.providers.includes("live-search"),
      fetch: async (run) => { liveCalls++; return [liveEvidence(1400, run.now)]; },
    }]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.userId = "user-1"; next(); });
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setEvidenceProvidersForTest(null);
  });

  it("with no valuationMode (every existing asset) the routes behave exactly as today", async () => {
    stubState.profiles.set("p1", laptop());
    const boot = await (await fetch(`${base}/api/profile-bootstrap/p1`)).json();
    expect(boot.valuation).toMatchObject({ supported: true, mode: "auto", freshness: { fresh: false, reason: "first_valuation" } });
    const r = await fetch(`${base}/api/profiles/p1/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(200);
    expect((await r.json()).ran).toBe(true);
    expect(liveCalls).toBe(1);
  });

  it("refuses refresh / lookup-value / find-value for a manual asset and runs nothing", async () => {
    stubState.profiles.set("p1", laptop({ valuationMode: "manual", currentValue: 1200 }));
    for (const [method, path] of [
      ["POST", "/api/profiles/p1/valuation/refresh"],
      ["POST", "/api/profiles/p1/lookup-value"],
      ["GET", "/api/profiles/p1/find-value"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      expect(res.status, path).toBe(400);
      expect((await res.json()).error, path).toMatch(/Automatic value tracking is off/i);
    }
    expect(liveCalls).toBe(0);
    expect(stubState.preferences.get("valuation:p1")).toBeUndefined();
    expect(stubState.updates).toHaveLength(0);
  });

  it("the bootstrap still carries the last estimate for a manual asset, flagged fresh so nothing refreshes it", async () => {
    stubState.profiles.set("p1", laptop());
    await fetch(`${base}/api/profiles/p1/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const valued = JSON.parse(stubState.preferences.get("valuation:p1")!).value;
    stubState.profiles.set("p1", { ...stubState.profiles.get("p1"), fields: { ...stubState.profiles.get("p1").fields, valuationMode: "manual" } });

    const boot = await (await fetch(`${base}/api/profile-bootstrap/p1`)).json();
    expect(boot.valuation.mode).toBe("manual");
    expect(boot.valuation.supported).toBe(true);
    expect(boot.valuation.record.value).toBe(valued);
    expect(boot.valuation.freshness.fresh).toBe(true);
  });
});
