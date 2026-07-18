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
              sources: [
                { source: "KBB", value: 20500 },
                { source: "Edmunds", value: 19800 },
                { source: "CarGurus", value: 20100 },
              ],
              confidence: "medium",
              factors: ["80,000 miles", "new tires"],
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

    // Response: ONE canonical value + labeled source inputs — no competing range.
    expect(data.currentValue).toBe(20100); // weighted median of the 3 comps
    expect(data.low).toBeUndefined();
    expect(data.high).toBeUndefined();
    expect(data.range).toBeUndefined();
    expect(Array.isArray(data.sources)).toBe(true);
    expect(data.sources.map((s: any) => s.source).sort()).toEqual(["CarGurus", "Edmunds", "Kelley Blue Book"]);
    expect(data.inputSpread).toEqual({ low: 19800, high: 20500 });
    expect(data.confidence).toBe("high"); // tight agreement → code-derived confidence
    expect(data.factorsConsidered).toEqual(["80,000 miles", "new tires"]);
    expect(data.missingInfo).toEqual(["trim level", "service records"]);
    expect(data.previousValue).toBe(21400);
    expect(new Date(data.valuationDate).getTime()).toBeGreaterThan(0);

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

    // Persisted onto the CORRECT profile (survives refresh).
    expect(stubState.updates).toHaveLength(1);
    expect(stubState.updates[0].id).toBe("profile-crv");
    const saved = stubState.profiles.get("profile-crv").fields;
    expect(saved.currentValue).toBe(20100);
    expect(saved.previousValue).toBe(21400);
    expect(saved.valuationFactors).toEqual(["80,000 miles", "new tires"]);
    expect(saved.valuationMissingInfo).toEqual(["trim level", "service records"]);
    // Persisted as labeled source inputs, not a min-max range answer.
    expect(saved.valuationSources.map((s: any) => s.source).sort()).toEqual(["CarGurus", "Edmunds", "Kelley Blue Book"]);
    expect(saved.valuationInputSpread).toEqual({ low: 19800, high: 20500 });
    const other = stubState.profiles.get("profile-other").fields;
    expect(other.currentValue).toBe(21400); // untouched

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
