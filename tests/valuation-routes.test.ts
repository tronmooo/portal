// Valuation routes: the estimate rides in the profile bootstrap (cache first),
// the refresh endpoint is a conditional write, and profile opening stays fast.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

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

import { registerRoutes } from "../server/routes";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";

const crv = (id = "profile-crv") => ({
  id, name: "Honda CR-V", type: "vehicle",
  fields: { year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", purchasePrice: 28000, purchaseDate: "2021-11-02" },
  notes: "", tags: [], relatedExpenses: [], relatedDocuments: [], relatedTrackers: [], relatedTasks: [], relatedEvents: [],
  relatedObligations: [], relatedHabits: [], childProfiles: [], timeline: [],
});

describe("valuation routes", () => {
  let server: Server;
  let base: string;
  let liveCalls = 0;

  beforeEach(async () => {
    stubState.profiles.clear(); stubState.preferences.clear(); stubState.updates.length = 0; stubState.bumps.length = 0;
    stubState.latencyMs = 0; stubState.calls = 0; liveCalls = 0;
    stubState.profiles.set("profile-crv", crv());
    setEvidenceProvidersForTest([{
      id: "live-search",
      supports: (_c, plan) => plan.providers.includes("live-search"),
      fetch: async (run) => {
        liveCalls++;
        await new Promise(r => setTimeout(r, 30)); // an external call, cheap here
        return [{
          id: "live-search:blend", kind: "live_market_search", source: "KBB / Edmunds", provider: "live-search",
          observedAt: run.now.toISOString(), fetchedAt: run.now.toISOString(), value: 20000, low: 18600, high: 21400,
          currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * 86_400_000, raw: { missing: ["trim level"] },
        }];
      },
    }]);
    const app = express();
    app.use(express.json());
    // The auth middleware is not mounted here; the routes' write barrier and
    // cache bust key on req.userId, so supply one the way auth would.
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

  it("bootstrap carries the stored estimate + freshness verdict, never runs a provider", async () => {
    const res = await fetch(`${base}/api/profile-bootstrap/profile-crv`);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.valuation).toMatchObject({ supported: true, record: null, freshness: { fresh: false, reason: "first_valuation" } });
    expect(b.valuation.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(liveCalls).toBe(0);
  });

  it("refresh runs in the background request, writes, and the next bootstrap serves the cached record", async () => {
    const r1 = await fetch(`${base}/api/profiles/profile-crv/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r1.status).toBe(200);
    const body = await r1.json();
    expect(body.ran).toBe(true);
    expect(body.changed).toBe(true);
    expect(body.snapshot.record.status).toBe("valued");
    expect(liveCalls).toBe(1);
    // A write happened → the barrier ran (version header present).
    expect(r1.headers.get("x-data-version")).toBeTruthy();

    const b = await (await fetch(`${base}/api/profile-bootstrap/profile-crv`)).json();
    expect(b.valuation.record.value).toBe(body.snapshot.record.value);
    expect(b.valuation.freshness.fresh).toBe(true);
    expect(b.detail.fields.currentValue).toBe(body.snapshot.record.value);

    // Refresh again: fresh → no run, no write, NO version bump (conditional write).
    const before = stubState.bumps.length;
    const r2 = await fetch(`${base}/api/profiles/profile-crv/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b2 = await r2.json();
    expect(b2.ran).toBe(false);
    expect(r2.headers.get("x-data-version")).toBeNull();
    expect(stubState.bumps.length).toBe(before);
    expect(liveCalls).toBe(1);
  });

  it("GET /valuation returns the snapshot and, on request, the history", async () => {
    await fetch(`${base}/api/profiles/profile-crv/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const snap = await (await fetch(`${base}/api/profiles/profile-crv/valuation`)).json();
    expect(snap.record.status).toBe("valued");
    expect(snap.history).toBeUndefined();
    const withHistory = await (await fetch(`${base}/api/profiles/profile-crv/valuation?history=1`)).json();
    expect(withHistory.history).toHaveLength(1);
    expect((await fetch(`${base}/api/profiles/nope/valuation`)).status).toBe(404);
  });

  it("force refresh re-runs even when fresh (the Refresh button)", async () => {
    await fetch(`${base}/api/profiles/profile-crv/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const r = await (await fetch(`${base}/api/profiles/profile-crv/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: true }) })).json();
    expect(r.ran).toBe(true);
    expect(liveCalls).toBe(2);
  });

  it("BENCHMARK: the cached estimate costs a cold profile open essentially nothing", async () => {
    // Warm record first.
    await fetch(`${base}/api/profiles/profile-crv/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    // A baseline profile with the same fields that the valuation system does
    // not value (not an owned thing), so the only difference between the two
    // cold opens is the valuation read + fingerprint.
    stubState.profiles.set("profile-base", { ...crv("profile-base"), type: "insurance" });
    // Simulate a real database: each storage call costs 15ms. The bootstrap's
    // reads run in one Promise.all, so the extra valuation read must ride in
    // parallel and add ~0 wall-clock; the fingerprint is sub-millisecond.
    stubState.latencyMs = 15;
    const N = 12;
    const measure = async (id: string) => {
      const samples: number[] = [];
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        const res = await fetch(`${base}/api/profile-bootstrap/${id}`);
        expect(res.status).toBe(200);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return { p50: samples[Math.floor(N / 2)], min: samples[0], max: samples[N - 1] };
    };
    const withValuation = await measure("profile-crv");
    const baseline = await measure("profile-base");
    // Direct cost of the valuation snapshot on the same detail, isolated:
    const { getValuationSnapshot } = await import("../server/valuation/service");
    stubState.latencyMs = 0;
    const detail = stubState.profiles.get("profile-crv");
    const record = JSON.parse(stubState.preferences.get("valuation:profile-crv")!);
    const t1 = performance.now();
    for (let i = 0; i < 200; i++) await getValuationSnapshot(stubStorage as any, "profile-crv", { detail, record });
    const perSnapshotMs = (performance.now() - t1) / 200;
    // eslint-disable-next-line no-console
    console.log(`[bench] cold bootstrap WITH valuation p50=${withValuation.p50.toFixed(1)}ms (min ${withValuation.min.toFixed(1)}, max ${withValuation.max.toFixed(1)}) · baseline WITHOUT p50=${baseline.p50.toFixed(1)}ms (min ${baseline.min.toFixed(1)}, max ${baseline.max.toFixed(1)}) · 15ms simulated DB latency per call · snapshot=${perSnapshotMs.toFixed(3)}ms each`);
    expect(perSnapshotMs).toBeLessThan(2);
    // The valuation read rides in the same parallel wave: no extra DB round trip.
    expect(withValuation.p50).toBeLessThan(baseline.p50 + 10);
    expect(liveCalls).toBe(1);
  });

  it("the legacy lookup-value button routes through the same pipeline and reports the record", async () => {
    const res = await fetch(`${base}/api/profiles/profile-crv/lookup-value`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("valued");
    expect(data.valuation.record.methodology).toContain("comparable_market_analysis");
    expect(liveCalls).toBe(1);
  });

  it("refuses to value a person even when asked", async () => {
    stubState.profiles.set("profile-person", { ...crv("profile-person"), type: "person", name: "Patrick" });
    const res = await fetch(`${base}/api/profiles/profile-person/valuation/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await res.json();
    expect(body.ran).toBe(false);
    expect(body.snapshot.supported).toBe(false);
    expect(liveCalls).toBe(0);
    expect((await fetch(`${base}/api/profiles/profile-person/lookup-value`, { method: "POST" })).status).toBe(400);
  });
});
