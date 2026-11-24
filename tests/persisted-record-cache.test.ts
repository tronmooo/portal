import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";

// 2026-11-24: an expense and a nested asset added from chat showed in Finance
// and the Assets list, while the asset's own Financials and Contained tabs
// said "No expenses logged" / "No child assets yet" — and still did after a
// manual refresh.
//
// The snapshot in localStorage keeps every key whose head is "/api/profiles",
// which includes ONE record's page (["/api/profiles", id, "detail"]). A
// reload restored that copy as fresh; the detail query refetches on mount only
// when its cache is marked invalidated, and nothing re-seeds a record's page
// after a restore. So the page showed the copy from before the reload for as
// long as the tab lived.
//
// The rule (client/src/lib/queryClient.ts, isRecordScopedPersistKey): a
// restored per-record entry is the first paint only. It keeps its real age,
// it is marked invalidated, and its page refetches on mount.

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORAGE_KEY = "portol-query-cache-v1";
const CAMERA = "11111111-1111-1111-1111-111111111111";
const DETAIL_KEY = ["/api/profiles", CAMERA, "detail"];

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

let mod: typeof import("../client/src/lib/queryClient");

beforeEach(async () => {
  vi.resetModules();
  (globalThis as any).localStorage = makeStorage();
  (globalThis as any).sessionStorage = makeStorage();
  localStorage.setItem("portol_session", JSON.stringify({
    access_token: fakeJwt(USER), refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  mod = await import("../client/src/lib/queryClient");
  mod.queryClient.clear();
});
afterEach(() => {
  mod.queryClient.clear();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

/** The profile page's own detail query options (client/src/pages/profile-detail.tsx). */
function mountDetail(queryFn: () => Promise<any>) {
  const observer = new QueryObserver(mod.queryClient, {
    queryKey: DETAIL_KEY,
    queryFn,
    staleTime: 30_000,
    refetchOnMount: (query: any) => query.state.isInvalidated,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

const STALE = { id: CAMERA, name: "Tutorial Camera", relatedExpenses: [], childProfiles: [] };
const CURRENT = {
  id: CAMERA, name: "Tutorial Camera",
  relatedExpenses: [{ id: "e1", description: "Lens cloth", amount: 12.34 }],
  childProfiles: [{ id: "c1", name: "50mm Lens", type: "asset" }],
};

describe("a record's page restored from the saved snapshot", () => {
  it("names a per-record key, and leaves the lists alone", () => {
    expect(mod.isRecordScopedPersistKey(DETAIL_KEY)).toBe(true);
    expect(mod.isRecordScopedPersistKey(["/api/profiles", CAMERA, "tree"])).toBe(true);
    expect(mod.isRecordScopedPersistKey(["/api/profiles"])).toBe(false);
    expect(mod.isRecordScopedPersistKey(["/api/stats", "everyone"])).toBe(false);
    expect(mod.isRecordScopedPersistKey(["/api/dashboard-bootstrap", "everyone", "2026-11"])).toBe(false);
  });

  it("is painted at once, marked invalidated, and keeps its real age", () => {
    const savedAt = Date.now() - 5 * 60_000;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: USER, entries: [{ k: DETAIL_KEY, d: STALE, t: savedAt }] }));
    mod.hydrateQueryCache();
    const state = mod.queryClient.getQueryState(DETAIL_KEY);
    expect(mod.queryClient.getQueryData(DETAIL_KEY)).toEqual(STALE);
    expect(state?.isInvalidated).toBe(true);
    expect(state?.dataUpdatedAt).toBe(savedAt);
  });

  it("refetches when its page mounts after a reload, so what was added elsewhere shows", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: USER, entries: [{ k: DETAIL_KEY, d: STALE, t: Date.now() - 2_000 }] }));
    mod.hydrateQueryCache();
    const queryFn = vi.fn(async () => CURRENT);
    const { observer, unsubscribe } = mountDetail(queryFn);
    // First paint is the snapshot; the fetch is already on its way.
    expect(observer.getCurrentResult().data).toEqual(STALE);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(CURRENT));
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a snapshot taken of a stale page round-trips to a refetch (snapshot → reload → mount)", async () => {
    mod.queryClient.setQueryData(DETAIL_KEY, STALE);
    mod.snapshotCache();
    const blob = localStorage.getItem(STORAGE_KEY)!;
    // The reload: a new module, a new query cache, the same localStorage.
    vi.resetModules();
    mod = await import("../client/src/lib/queryClient");
    localStorage.setItem(STORAGE_KEY, blob);
    mod.hydrateQueryCache();
    const queryFn = vi.fn(async () => CURRENT);
    const { observer, unsubscribe } = mountDetail(queryFn);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(CURRENT));
    unsubscribe();
  });

  it("the restored profile LIST is still seeded fresh (one refresh at launch, not twenty)", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: USER, entries: [{ k: ["/api/profiles"], d: [{ id: CAMERA }], t: Date.now() - 60 * 60_000 }] }));
    const before = Date.now();
    mod.hydrateQueryCache();
    const state = mod.queryClient.getQueryState(["/api/profiles"]);
    expect(state?.isInvalidated).toBe(false);
    expect(state!.dataUpdatedAt).toBeGreaterThanOrEqual(before);
  });
});
