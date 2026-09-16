// Integration test for POST /api/profiles/:id/lookup-value.
//
// Verifies the full flow the "Look up value" button drives:
//  1. the COMPLETE asset record (fields + related expenses/documents/notes/
//     timeline + AI summary) is retrieved and fed to the valuation model,
//  2. prior valuation output is NOT fed back (no anchoring),
//  3. the fresh result is persisted onto the CORRECT profile (so it survives
//     an app refresh) with previousValue preserved,
//  4. the AI summary cache is busted so no stale summary/value is shown,
//  5. the response carries range, midpoint, confidence, factors, missing
//     info, and valuation date.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    preferences: new Map<string, string>(),
    updates: [] as Array<{ id: string; patch: any }>,
  };
  // Minimal storage stub: the handful of methods the lookup-value route uses
  // are real; everything else is a permissive async no-op so unrelated route
  // registration code doesn't crash.
  const impl: any = {
    async getProfile(id: string) { return state.profiles.get(id); },
    async getProfileDetail(id: string) { return state.profiles.get(id); },
    async getProfiles() { return [...state.profiles.values()]; },
    async updateProfile(id: string, patch: any) {
      state.updates.push({ id, patch });
      const cur = state.profiles.get(id);
      if (cur) state.profiles.set(id, { ...cur, ...patch, fields: { ...cur.fields, ...patch.fields } });
      return state.profiles.get(id);
    },
    async getPreference(key: string) { return state.preferences.get(key); },
    async setPreference(key: string, value: string) { state.preferences.set(key, value); },
    // Valuation store (mirrors the preferences-backed codec both backends use).
    async getAssetValuation(id: string) { const raw = state.preferences.get(`valuation:${id}`); return raw ? JSON.parse(raw) : null; },
    async saveAssetValuation(id: string, record: any) {
      state.preferences.set(`valuation:${id}`, JSON.stringify(record));
      const prev = JSON.parse(state.preferences.get(`valuation-history:${id}`) || "[]");
      state.preferences.set(`valuation-history:${id}`, JSON.stringify([...prev, { valuedAt: record.valuedAt, value: record.value }]));
    },
    async touchAssetValuation(id: string, record: any) { state.preferences.set(`valuation:${id}`, JSON.stringify(record)); },
    async getAssetValuationHistory(id: string) { return JSON.parse(state.preferences.get(`valuation-history:${id}`) || "[]"); },
    async getValuationUnderstanding() { return null; },
    async cacheValuationUnderstanding() {},
  };
  const storage = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  });
  return { stubState: state, stubStorage: storage };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: stubStorage };
});

import { registerRoutes } from "../server/routes";

const crvDetail = () => ({
  id: "profile-crv",
  name: "Robert's Honda CR-V",
  type: "vehicle",
  fields: {
    year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good",
    location: "Los Angeles, CA", purchasePrice: 28000,
    // Prior valuation — must be replaced, not echoed:
    currentValue: 21400, valuationRange: "$19,250 - $25,199",
  },
  notes: "Garage kept.",
  tags: [],
  relatedExpenses: [
    { description: "New tires installed", amount: 820, category: "auto", date: "2026-03-14" },
  ],
  relatedDocuments: [
    { name: "CA registration", type: "registration", extractedData: { expires: "2026-10-22" }, createdAt: "2026-01-01" },
  ],
  relatedTrackers: [], relatedTasks: [], relatedEvents: [], relatedObligations: [],
  relatedHabits: [], childProfiles: [], timeline: [
    { id: "t1", type: "expense", title: "New tires installed", timestamp: "2026-03-14T10:00:00Z" },
  ],
});

describe("POST /api/profiles/:id/lookup-value", () => {
  let server: Server;
  let base: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.preferences.clear();
    stubState.updates.length = 0;
    stubState.profiles.set("profile-crv", crvDetail());
    stubState.profiles.set("profile-other", { ...crvDetail(), id: "profile-other", name: "Other Car" });
    stubState.preferences.set("profile_ai_profile-crv", JSON.stringify({ summary: "Old cached summary", generatedAt: new Date().toISOString() }));

    vi.stubEnv("PERPLEXITY_API_KEY", "test-key");
    fetchMock = vi.fn(async (url: any, init?: any) => {
      if (String(url).includes("perplexity.ai")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({
              value: 20100, low: 18500, high: 22000, confidence: "medium",
              method: "KBB, Edmunds", factors: ["80,000 miles", "new tires"],
              missing: ["trim level", "service records"],
            }) } }],
          }),
        } as any;
      }
      return realFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = express();
    app.use(express.json());
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("values from the full record, persists to the right profile, and busts the summary cache", async () => {
    const res = await realFetch(`${base}/api/profiles/profile-crv/lookup-value`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Response: the universal engine's blended estimate (the live-search
    // figure carries ~90% of the weight; the dateless purchase price is a
    // weak anchor), a range, confidence, factors, missing info, date.
    expect(data.status).toBe("valued");
    expect(data.currentValue).toBeGreaterThanOrEqual(18500);
    expect(data.currentValue).toBeLessThanOrEqual(22000);
    expect(data.low).toBeLessThan(data.currentValue);
    expect(data.high).toBeGreaterThan(data.currentValue);
    expect(data.range).toMatch(/^\$[\d,]+ - \$[\d,]+$/);
    expect(["high", "medium", "low"]).toContain(data.confidence);
    expect(data.methodology).toContain("comparable_market_analysis");
    expect(data.factorsConsidered.join(" ")).toContain("80,000 miles");
    expect(data.missingInfo).toEqual(expect.arrayContaining(["trim level", "service records"]));
    expect(data.previousValue).toBe(21400);
    expect(new Date(data.valuationDate).getTime()).toBeGreaterThan(0);
    // The full normalized record rides along for the value card.
    expect(data.valuation.record.evidence.some((e: any) => e.kind === "live_market_search")).toBe(true);

    // The model saw the complete record but never the prior estimate.
    const ppxCall = fetchMock.mock.calls.find(c => String(c[0]).includes("perplexity.ai"));
    expect(ppxCall).toBeTruthy();
    const prompt = JSON.parse(ppxCall![1].body).messages.map((m: any) => m.content).join("\n");
    expect(prompt).toContain("mileage: 80000");
    expect(prompt).toContain("New tires installed");
    expect(prompt).toContain("CA registration");
    expect(prompt).toContain("Garage kept");
    expect(prompt).toContain("Old cached summary");
    expect(prompt).not.toContain("21400");
    expect(prompt).not.toContain("$19,250");

    // Persisted onto the CORRECT profile (survives refresh). The prior
    // currentValue was estimator-written (legacy valuationRange marker), so
    // the mirror is allowed to replace it — a user-typed value would be kept.
    expect(stubState.updates).toHaveLength(1);
    expect(stubState.updates[0].id).toBe("profile-crv");
    const saved = stubState.profiles.get("profile-crv").fields;
    expect(saved.currentValue).toBe(data.currentValue);
    expect(saved.currentValueSource).toBe("estimate");
    expect(saved.previousValue).toBe(21400);
    expect(saved.valuationFactors.join(" ")).toContain("80,000 miles");
    expect(saved.valuationMissingInfo).toEqual(expect.arrayContaining(["trim level", "service records"]));
    expect(saved.valuationRange).toBe(data.range);
    const other = stubState.profiles.get("profile-other").fields;
    expect(other.currentValue).toBe(21400); // untouched
    // The normalized record + history live in the user-scoped valuation store.
    const stored = JSON.parse(stubState.preferences.get("valuation:profile-crv")!);
    expect(stored.status).toBe("valued");
    expect(stored.value).toBe(data.currentValue);
    expect(JSON.parse(stubState.preferences.get("valuation-history:profile-crv")!)).toHaveLength(1);
    expect(stubState.preferences.get("valuation:profile-other")).toBeUndefined();

    // Summary cache busted so the stale summary can't be served again.
    expect(stubState.preferences.get("profile_ai_profile-crv")).toBe("");
  });

  it("rejects non-valuable profile types", async () => {
    stubState.profiles.set("profile-person", { ...crvDetail(), id: "profile-person", type: "person" });
    const res = await realFetch(`${base}/api/profiles/profile-person/lookup-value`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("404s for a missing profile", async () => {
    const res = await realFetch(`${base}/api/profiles/nope/lookup-value`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
