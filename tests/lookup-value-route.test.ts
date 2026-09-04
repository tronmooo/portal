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

    // Response: midpoint, range, confidence, factors, missing info, date.
    expect(data.currentValue).toBe(20100);
    expect(data.low).toBe(18500);
    expect(data.high).toBe(22000);
    expect(data.range).toBe("$18,500 - $22,000");
    expect(data.confidence).toBe("medium");
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
    expect(saved.valuationRange).toBe("$18,500 - $22,000");
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

  // ── Regression: a failed lookup must NEVER zero out the stored value ──────
  // User report 2026-09-04: "I pressed look up value and the asset went to
  // zero and now net worth says only 36,000". When every model path failed,
  // estimateAssetValue returned a $0 "no data" placeholder and this route
  // persisted that 0 straight over currentValue — the asset lost its worth and
  // dropped out of net worth. A failed lookup must be reported, not written.
  describe("when the valuation finds nothing", () => {
    beforeEach(() => {
      // Both model paths fail: Perplexity 500s, and with no Anthropic key the
      // fallback throws — exactly the state that produced the $0 placeholder.
      vi.stubEnv("ANTHROPIC_API_KEY", "");
      fetchMock.mockImplementation(async (url: any) => {
        if (String(url).includes("perplexity.ai")) {
          return { ok: false, status: 500, text: async () => "upstream down" } as any;
        }
        throw new Error("network unavailable in test");
      });
    });

    it("leaves the stored value untouched and reports noData", async () => {
      const res = await realFetch(`${base}/api/profiles/profile-crv/lookup-value`, { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.noData).toBe(true);
      expect(typeof data.error).toBe("string");
      // The response reports the value the profile STILL has — never a $0.
      expect(data.currentValue).toBe(21400);
      expect(data.previousValue).toBe(21400);

      // The stored value is exactly what it was.
      const saved = stubState.profiles.get("profile-crv").fields;
      expect(saved.currentValue).toBe(21400);
      // ...and no previousValue was stamped from the failure, so a later
      // successful lookup still compares against the real prior figure.
      expect(saved.previousValue).toBeUndefined();

      // The failure write is MINIMAL: one timestamp, and nothing that touches
      // the value or that a valuation card would read as an estimate. Writing
      // `currentValue` at all is what collapsed the whole identity group
      // (marketValue / estimatedValue / housing.currentValue …) in the
      // original bug, and a "No data available" method stamped next to a real
      // value makes the card misdescribe the user's own figure.
      expect(stubState.updates).toHaveLength(1);
      expect(Object.keys(stubState.updates[0].patch.fields)).toEqual(["valuationAttemptedAt"]);
      expect(saved.valuationMethod).toBeUndefined();
    });

    it("restores a value an earlier failed lookup already zeroed", async () => {
      // A row damaged before the guard existed: currentValue 0, the real
      // figure stashed in previousValue, and the placeholder method string.
      stubState.profiles.set("profile-zeroed", {
        ...crvDetail(),
        id: "profile-zeroed",
        name: "Zeroed Car",
        fields: {
          year: 2021, make: "Honda", model: "CR-V",
          currentValue: 0,
          previousValue: 21400,
          valuationMethod: "No data available — please enter manually",
        },
      });

      const res = await realFetch(`${base}/api/profiles/profile-zeroed/lookup-value`, { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.noData).toBe(true);
      const healed = stubState.profiles.get("profile-zeroed").fields;
      expect(healed.currentValue).toBe(21400);
      expect(data.currentValue).toBe(21400);
      // The failed-run marker is dropped, so the valuation card stops
      // describing the restored figure as "no data available".
      expect(healed.valuationMethod).toBeFalsy();
    });
  });
});
