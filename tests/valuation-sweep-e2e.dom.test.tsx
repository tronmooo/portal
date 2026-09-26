// @vitest-environment jsdom
//
// END TO END: the real Assets-tab sweep hook, talking over HTTP to the real
// server routes. Opening the tab must re-value every auto-tracked asset —
// including one whose stored estimate is still inside its freshness window —
// while leaving manual assets and just-checked ones alone.
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";

const { stubState, stubStorage } = vi.hoisted(() => {
  // The benchmark below measures COLD profile opens; the per-instance response
  // cache would otherwise answer every repeat in ~1ms and hide the real path.
  process.env.DISABLE_RESPONSE_CACHE = "1";
  const state = {
    profiles: new Map<string, any>(),
    preferences: new Map<string, string>(),
    updates: [] as Array<{ id: string; patch: any }>,
    /** Simulated database latency per storage call (ms). */
    latencyMs: 0,
    calls: 0,
  };
  const delay = async () => { state.calls++; if (state.latencyMs > 0) await new Promise(r => setTimeout(r, state.latencyMs)); };
  const impl: any = {
    async getProfile(id: string) { await delay(); return state.profiles.get(id); },
    async getProfileDetail(id: string) { await delay(); return state.profiles.get(id); },
    async getProfiles() { await delay(); return [...state.profiles.values()]; },
    async getAssetPartyLinks() { await delay(); return []; },
    async getLiabilityProfileLinks() { await delay(); return []; },
    async updateProfile(id: string, patch: any) {
      state.updates.push({ id, patch });
      const cur = state.profiles.get(id);
      if (cur) state.profiles.set(id, { ...cur, ...patch, fields: { ...cur.fields, ...patch.fields } });
      return state.profiles.get(id);
    },
    async getPreference(key: string) { await delay(); return state.preferences.get(key) ?? null; },
    async setPreference(key: string, value: string) { state.preferences.set(key, value); },
    async getAssetValuation(id: string) { await delay(); const raw = state.preferences.get(`valuation:${id}`); return raw ? JSON.parse(raw) : null; },
    async saveAssetValuation(id: string, record: any) {
      state.preferences.set(`valuation:${id}`, JSON.stringify(record));
      const prev = JSON.parse(state.preferences.get(`valuation-history:${id}`) || "[]");
      state.preferences.set(`valuation-history:${id}`, JSON.stringify([...prev, { valuedAt: record.valuedAt, value: record.value, status: record.status }]));
    },
    async touchAssetValuation(id: string, record: any) { state.preferences.set(`valuation:${id}`, JSON.stringify(record)); },
    async getAssetValuationHistory(id: string) { return JSON.parse(state.preferences.get(`valuation-history:${id}`) || "[]"); },
    async listAssetValuations() {
      const out: Record<string, any> = {};
      for (const [k, v] of state.preferences) if (k.startsWith("valuation:")) out[k.slice("valuation:".length)] = JSON.parse(v);
      return out;
    },
    async getValuationUnderstanding() { return null; },
    async cacheValuationUnderstanding() {},
    async bumpDataVersions(domains: string[]) { state.bumps.push(domains); return { epoch: 1 }; },
    async getDataVersions() { return { epoch: 1 }; },
  };
  (state as any).bumps = [] as string[][];
  const storage = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  });
  return { stubState: state as typeof state & { bumps: string[][] }, stubStorage: storage };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // The real `storage` proxy fills the per-request write journal on every
  // call; the barrier reads that journal to decide whether this request
  // wrote. Wrap the stub the same way so the conditional-write behaviour
  // under test is the production one.
  const { journalStorageCall } = await import("../server/write-journal");
  const journaled = new Proxy(stubStorage as any, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: any[]) => {
        const out = value(...args);
        return out && typeof out.then === "function"
          ? out.then((r: any) => { journalStorageCall(prop, args, r); return r; })
          : out;
      };
    },
  });
  return { ...actual, storage: journaled };
});


const { client } = vi.hoisted(() => {
  const { QueryClient } = require("@tanstack/react-query");
  return { client: { base: "", queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) } };
});
vi.mock("@/lib/queryClient", () => ({
  queryClient: client.queryClient,
  BROWSER_TIMEZONE: "UTC",
  apiRequest: async (method: string, url: string, body?: unknown) => {
    const res = await fetch(client.base + url, {
      method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 202) throw new Error(`${res.status}`);
    return res;
  },
}));

import { registerRoutes } from "../server/routes";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import { __resetSweepState, __resetValuationRefreshState, useAssetsValuationSweep, valuationQueryKey } from "@/hooks/useAssetValuation";

const vehicle = (id: string, name: string, fields: Record<string, any> = {}) => ({
  id, name, type: "vehicle",
  fields: { year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", purchasePrice: 28000, purchaseDate: "2021-11-02", ...fields },
  notes: "", tags: [], relatedExpenses: [], relatedDocuments: [], relatedTrackers: [], relatedTasks: [], relatedEvents: [],
  relatedObligations: [], relatedHabits: [], childProfiles: [], timeline: [],
});

function Probe() {
  const p = useAssetsValuationSweep(true);
  return <div data-testid="sweep">{p.running ? "running" : "idle"} {p.done}/{p.total} failed={p.failed}</div>;
}

describe("Assets tab → every auto-tracked asset is re-valued (end to end)", () => {
  let server: Server;
  const fetchedFor: string[] = [];
  let market = 20000;

  beforeEach(async () => {
    stubState.profiles.clear(); stubState.preferences.clear(); stubState.updates.length = 0;
    fetchedFor.length = 0; market = 20000;
    __resetSweepState(); __resetValuationRefreshState(); client.queryClient.clear();
    setEvidenceProvidersForTest([{
      id: "live-search",
      supports: (_c, plan) => plan.providers.includes("live-search"),
      fetch: async (run) => {
        fetchedFor.push(run.ctx.profileId);
        return [{
          id: "live-search:blend", kind: "live_market_search", source: "KBB", provider: "live-search",
          observedAt: run.now.toISOString(), fetchedAt: run.now.toISOString(), value: market, low: market * 0.95, high: market * 1.05,
          currency: "USD", reliability: 0.8, relevance: 0.9, halfLifeMs: 30 * 86_400_000,
        }];
      },
    }]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.userId = "user-1"; next(); });
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    client.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setEvidenceProvidersForTest(null);
  });

  const post = (id: string) => fetch(`${client.base}/api/profiles/${id}/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  /** Pretend the stored estimate was made two days ago — still inside its window. */
  const ageRecord = (id: string) => {
    const r = JSON.parse(stubState.preferences.get(`valuation:${id}`)!);
    const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
    stubState.preferences.set(`valuation:${id}`, JSON.stringify({ ...r, checkedAt: past, valuedAt: past }));
  };

  it("fresh auto asset is force-refreshed with a new value; manual and just-checked assets are not touched", async () => {
    stubState.profiles.set("ram", vehicle("ram", "Dodge Ram 2025", { make: "Dodge", model: "Ram", year: 2025 }));
    stubState.profiles.set("f150", vehicle("f150", "Ford F150 2025", { make: "Ford", model: "F150", year: 2025 }));
    stubState.profiles.set("mouse", vehicle("mouse", "Manual car", { valuationMode: "manual", currentValue: 40 }));
    stubState.profiles.set("never", vehicle("never", "Never valued", { make: "Toyota", model: "Camry" }));
    // Seed estimates for ram, f150 and the manual one (valued before it went manual).
    for (const id of ["ram", "f150"]) expect((await post(id)).status).toBe(200);
    ageRecord("ram");
    // f150 was checked seconds ago → inside the 10-minute floor.
    fetchedFor.length = 0;

    // Sanity: before the sweep, the status route says ram is FRESH — the old
    // sweep would have skipped it.
    const status = await (await fetch(`${client.base}/api/valuations/status`)).json();
    const byId = Object.fromEntries(status.rows.map((r: any) => [r.profileId, r]));
    expect(byId.ram).toMatchObject({ fresh: true, auto: true });
    expect(byId.mouse).toMatchObject({ fresh: true, auto: false });
    expect(byId.never).toMatchObject({ fresh: false, auto: true });

    market = 23456; // the market moved
    render(<QueryClientProvider client={client.queryClient}><Probe /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("sweep").textContent).toBe("idle 2/2 failed=0"), { timeout: 5000 });

    expect(fetchedFor.sort()).toEqual(["never", "ram"]);
    const ram = JSON.parse(stubState.preferences.get("valuation:ram")!);
    expect(ram.value).toBeGreaterThan(20000);
    expect(new Date(ram.checkedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // The new value reached the profile row every screen reads, and the cache.
    expect(stubState.profiles.get("ram").fields.currentValue).toBe(ram.value);
    expect((client.queryClient.getQueryData(valuationQueryKey("ram")) as any).record.value).toBe(ram.value);
    // Manual asset: no lookup, value untouched.
    expect(stubState.profiles.get("mouse").fields.currentValue).toBe(40);
    expect(stubState.preferences.get("valuation:mouse")).toBeUndefined();
  });
});
