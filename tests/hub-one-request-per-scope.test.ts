// @vitest-environment jsdom
/**
 * One request per scope (2026-09-04, "This is taking too long to load" on the
 * Assets tab; Finance skeletons while the KPI strip already had numbers).
 *
 * Every hub tab is gated on a list that /api/dashboard-bootstrap already
 * returns and seeds under the tab's exact query key. Opened cold, a tab used
 * to fire its own request for that list IN PARALLEL with the bootstrap — two
 * cold serverless round-trips for the same rows, and the tab's skeleton could
 * outlive the 20s guard while the bootstrap that would have painted it was
 * still working. seededQueryFn makes a cold tab query join the one bootstrap.
 *
 * Contract:
 *   1. cold + bootstrap in flight  → joins it, reads the seed, no own request
 *   2. cold + nobody started it    → starts the bootstrap itself, still one request
 *   3. data already cached         → a refetch goes direct (the list, not the bootstrap)
 *   4. bootstrap fails             → falls back to the direct fetch
 *   5. bootstrap lacks the slot    → falls back to the direct fetch
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface Stub { urls: string[]; failBootstrap?: boolean; omitTrackers?: boolean }

async function load(stub: Stub) {
  vi.resetModules();
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    stub.urls.push(u);
    await new Promise((r) => setTimeout(r, 5));
    if (u.includes("/api/dashboard-bootstrap")) {
      if (stub.failBootstrap) {
        return { ok: false, status: 500, statusText: "boom", json: async () => ({}), text: async () => "boom" } as any;
      }
      const body: any = { stats: { ok: true }, profiles: [{ id: "self-1", type: "self" }], documents: [{ id: "d1" }] };
      if (!stub.omitTrackers) body.trackers = [{ id: "t-boot" }];
      return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) } as any;
    }
    const body = [{ id: "t-direct" }];
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) } as any;
  });
  const prefetch = await import("../client/src/lib/scope-prefetch");
  const { queryClient, apiRequest } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  const key = ["/api/trackers", "everyone"] as const;
  const direct = () => apiRequest("GET", "/api/trackers").then((r) => r.json());
  const fn = prefetch.seededQueryFn<any[]>(key, "everyone", [], direct);
  return { ...prefetch, queryClient, key, fn };
}

const count = (urls: string[], frag: string) => urls.filter((u) => u.includes(frag)).length;

describe("seededQueryFn: a cold tab query joins the one scope bootstrap", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("joins an in-flight bootstrap and reads the seeded slot — no request of its own", async () => {
    const stub: Stub = { urls: [] };
    const m = await load(stub);
    const boot = m.ensureScopeBootstrap("everyone", []);
    const rows = await m.fn();
    await boot;
    expect(rows).toEqual([{ id: "t-boot" }]);
    expect(count(stub.urls, "/api/dashboard-bootstrap")).toBe(1);
    expect(count(stub.urls, "/api/trackers")).toBe(0);
  });

  it("starts the bootstrap itself when nobody has — still exactly one request", async () => {
    const stub: Stub = { urls: [] };
    const m = await load(stub);
    const rows = await m.fn();
    expect(rows).toEqual([{ id: "t-boot" }]);
    expect(count(stub.urls, "/api/dashboard-bootstrap")).toBe(1);
    expect(count(stub.urls, "/api/trackers")).toBe(0);
    // ...and it seeded the sibling slots the other tabs read.
    expect(m.queryClient.getQueryData(["/api/profiles"])).toEqual([{ id: "self-1", type: "self" }]);
  });

  it("refetches the list directly once data is on screen (Retry / invalidation)", async () => {
    const stub: Stub = { urls: [] };
    const m = await load(stub);
    m.queryClient.setQueryData(m.key, [{ id: "t-old" }]);
    const rows = await m.fn();
    expect(rows).toEqual([{ id: "t-direct" }]);
    expect(count(stub.urls, "/api/trackers")).toBe(1);
    expect(count(stub.urls, "/api/dashboard-bootstrap")).toBe(0);
  });

  it("falls back to the direct fetch when the bootstrap fails", async () => {
    const stub: Stub = { urls: [], failBootstrap: true };
    const m = await load(stub);
    const rows = await m.fn();
    expect(rows).toEqual([{ id: "t-direct" }]);
    expect(count(stub.urls, "/api/trackers")).toBe(1);
  });

  it("falls back to the direct fetch when the bootstrap did not carry the slot", async () => {
    const stub: Stub = { urls: [], omitTrackers: true };
    const m = await load(stub);
    const rows = await m.fn();
    expect(rows).toEqual([{ id: "t-direct" }]);
    expect(count(stub.urls, "/api/dashboard-bootstrap")).toBe(1);
    expect(count(stub.urls, "/api/trackers")).toBe(1);
  });

  it("prefetchScopeBootstrap and the page's own hook share the key dashboard.tsx reads", async () => {
    const stub: Stub = { urls: [] };
    const m = await load(stub);
    const { getUserCurrentMonth } = await import("../shared/timezone");
    const { BROWSER_TIMEZONE } = await import("../client/src/lib/queryClient");
    expect(m.scopeBootstrapKey("selected", ["a", "", "b"])).toEqual(
      ["/api/dashboard-bootstrap", "selected", "a", "b", getUserCurrentMonth(BROWSER_TIMEZONE)],
    );
    // A concurrent prefetch + ensure collapse onto one request.
    await Promise.all([m.prefetchScopeBootstrap("everyone", []), m.ensureScopeBootstrap("everyone", [])]);
    expect(count(stub.urls, "/api/dashboard-bootstrap")).toBe(1);
  });
});
