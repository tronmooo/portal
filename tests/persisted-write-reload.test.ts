import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";

// QA 2026-11-24 (live demo account), two reports with one shape:
//   7. a run logged on Trackers showed in the tracker's History, was GONE after
//      the first page reload, and came back later;
//   8. a one-cent expense showed in the Finance ledger, was GONE after the first
//      reload (even searched by its exact description), and came back later.
//
// Neither list is persisted itself. On reload, hydrateQueryCache re-seeds
// ["/api/expenses", scope…] and ["/api/trackers", scope…] from the persisted
// BOOTSTRAP payload, as fresh. A write patches the live list and only marks the
// bootstrap invalidated (it refetches only where the dashboard observes it), so
// the snapshot saved the bootstrap's pre-write rows — without the invalidation.
// After the reload the list was the pre-write copy, seeded fresh (its page did
// not refetch), and the bootstrap, saved within its 3-minute staleTime, was
// taken as fresh by the launch prefetch. The row was missing until staleTime
// ran out.
//
// This drives the real modules: the bootstrap seed key list, the cache bus's
// manifest invalidation, snapshotCache, a fresh module (the reload) and
// hydrateQueryCache, then the page's own list query and the launch prefetch.

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORAGE_KEY = "portol-query-cache-v1";
const MONTH = "2026-11";
const BOOTSTRAP_KEY = ["/api/dashboard-bootstrap", "everyone", MONTH];
const EXPENSES_KEY = ["/api/expenses", "everyone"];
const TRACKERS_KEY = ["/api/trackers", "everyone"];

function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.`;
}
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

const COFFEE = { id: "e1", description: "Coffee", amount: 4.5, date: "2026-11-23" };
const PENNY = { id: "e2", description: "QA penny 7731", amount: 0.01, date: "2026-11-24" };
const RUN_1 = { id: "r1", timestamp: "2026-11-23T08:00:00Z", values: { distance: 2 } };
const RUN_2 = { id: "r2", timestamp: "2026-11-24T08:00:00Z", values: { distance: 1.5 } };
const runTracker = (entries: any[]) => ({ id: "t1", name: "Running", entries });

const BOOTSTRAP_BEFORE = {
  stats: { totalExpenses: 4.5 },
  profiles: [],
  expenses: [COFFEE],
  trackers: [runTracker([RUN_1])],
};
const BOOTSTRAP_AFTER = {
  ...BOOTSTRAP_BEFORE,
  stats: { totalExpenses: 4.51 },
  expenses: [PENNY, COFFEE],
  trackers: [runTracker([RUN_2, RUN_1])],
};

let mod: typeof import("../client/src/lib/queryClient");

async function loadModules() {
  mod = await import("../client/src/lib/queryClient");
  const keys = await import("../client/src/lib/bootstrap-seed-keys");
  return keys;
}

beforeEach(async () => {
  vi.resetModules();
  (globalThis as any).localStorage = makeStorage();
  (globalThis as any).sessionStorage = makeStorage();
  localStorage.setItem("portol_session", JSON.stringify({
    access_token: fakeJwt(USER), refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
});
afterEach(() => {
  mod?.queryClient.clear();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

/** The app as it is before the reload: launched a minute ago, then one write. */
async function sessionWithOneWrite() {
  const { bootstrapSeedEntries } = await loadModules();
  const launchedAt = Date.now() - 60_000; // inside the 3-minute staleTime
  mod.queryClient.setQueryData(BOOTSTRAP_KEY, BOOTSTRAP_BEFORE, { updatedAt: launchedAt });
  for (const { key, data } of bootstrapSeedEntries(BOOTSTRAP_BEFORE, "everyone", [], MONTH)) {
    mod.queryClient.setQueryData(key as any, data, { updatedAt: launchedAt });
  }
  // The write: the manifest patches the list from the server's row…
  mod.queryClient.setQueryData(EXPENSES_KEY, [PENNY, COFFEE]);
  mod.queryClient.setQueryData(TRACKERS_KEY, [runTracker([RUN_2, RUN_1])]);
  // …and invalidates the domains it named. Nothing observes the bootstrap on
  // Finance or Trackers, so it is only MARKED stale and keeps its old rows.
  const bus = await import("../client/src/lib/cache-bus");
  await bus.invalidateDomainsFromManifest(["expenses", "trackers"]);
  expect(mod.queryClient.getQueryState(BOOTSTRAP_KEY)?.isInvalidated).toBe(true);
  expect(mod.queryClient.getQueryData(BOOTSTRAP_KEY)).toEqual(BOOTSTRAP_BEFORE);
}

/** pagehide's snapshot, then a reload: a new module and cache, the same localStorage. */
async function reload() {
  mod.snapshotCache();
  const blob = localStorage.getItem(STORAGE_KEY);
  expect(blob).toBeTruthy();
  mod.queryClient.clear();
  vi.resetModules();
  mod = await import("../client/src/lib/queryClient");
  localStorage.setItem(STORAGE_KEY, blob!);
  mod.hydrateQueryCache();
}

/** A page's list query with the app's default options (staleTime, refetchOnMount). */
function mountList(queryKey: unknown[], queryFn: () => Promise<any>) {
  const observer = new QueryObserver(mod.queryClient, { queryKey, queryFn } as any);
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

describe("a reload after a write shows the written row", () => {
  it("Finance: the new expense is in the first paint after the reload, and the list refetches", async () => {
    await sessionWithOneWrite();
    await reload();
    const painted = mod.queryClient.getQueryData<any[]>(EXPENSES_KEY)!;
    expect(painted.map((e) => e.description)).toContain("QA penny 7731");

    const queryFn = vi.fn(async () => BOOTSTRAP_AFTER.expenses);
    const { observer, unsubscribe } = mountList(EXPENSES_KEY, queryFn);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([PENNY, COFFEE]));
    unsubscribe();
  });

  it("Trackers: the new run is in the tracker's history after the reload", async () => {
    await sessionWithOneWrite();
    await reload();
    const trackers = mod.queryClient.getQueryData<any[]>(TRACKERS_KEY)!;
    expect(trackers[0].entries.map((e: any) => e.id)).toEqual(["r2", "r1"]);
    expect(mod.queryClient.getQueryState(TRACKERS_KEY)?.isInvalidated).toBe(true);
  });

  it("the stale bootstrap is refetched by the launch prefetch, even inside its staleTime", async () => {
    await sessionWithOneWrite();
    await reload();
    expect(mod.queryClient.getQueryState(BOOTSTRAP_KEY)?.isInvalidated).toBe(true);
    const queryFn = vi.fn(async () => BOOTSTRAP_AFTER);
    // App.tsx DataPrefetch: prefetchQuery with the default staleTime.
    await mod.queryClient.prefetchQuery({ queryKey: BOOTSTRAP_KEY, queryFn });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("a list seeded from a stale bootstrap with no newer copy saved still refetches on mount", async () => {
    await sessionWithOneWrite();
    // The written list did not survive (e.g. it was dropped for size): only the
    // bootstrap's pre-write rows are left to paint from.
    mod.queryClient.removeQueries({ queryKey: EXPENSES_KEY, exact: true });
    await reload();
    expect(mod.queryClient.getQueryData(EXPENSES_KEY)).toEqual([COFFEE]);
    const queryFn = vi.fn(async () => BOOTSTRAP_AFTER.expenses);
    const { observer, unsubscribe } = mountList(EXPENSES_KEY, queryFn);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([PENNY, COFFEE]));
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("with no write, the launch stays one refresh: lists seeded fresh, nothing extra saved", async () => {
    const { bootstrapSeedEntries } = await loadModules();
    const launchedAt = Date.now() - 60_000;
    mod.queryClient.setQueryData(BOOTSTRAP_KEY, BOOTSTRAP_BEFORE, { updatedAt: launchedAt });
    for (const { key, data } of bootstrapSeedEntries(BOOTSTRAP_BEFORE, "everyone", [], MONTH)) {
      mod.queryClient.setQueryData(key as any, data, { updatedAt: launchedAt });
    }
    mod.snapshotCache();
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.entries.map((e: any) => e.k[0]).sort()).toEqual(["/api/dashboard-bootstrap", "/api/profiles", "/api/stats"].sort());
    expect(saved.entries.some((e: any) => e.inv)).toBe(false);
    await reload();
    const state = mod.queryClient.getQueryState(EXPENSES_KEY)!;
    expect(state.isInvalidated).toBe(false);
    expect(state.dataUpdatedAt).toBeGreaterThan(launchedAt);
  });
});
