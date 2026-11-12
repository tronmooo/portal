/**
 * "Add a task, refresh the page" shows the task (2026-11-12).
 *
 * Observed on production: create a task on /tasks, reload within a few
 * seconds — the page fetched NOTHING and painted the list as it was before the
 * write; the task (stored, confirmed through the API) stayed missing for as
 * long as the page was watched.
 *
 * Cause: the dashboard-bootstrap payload is persisted to localStorage and
 * restored on boot, and seeds ~24 list caches (tasks, expenses, habits, …) as
 * FRESH. The restored bootstrap itself was meant to be "the one query that
 * refetches", but it kept its saved timestamp, so it only counted as stale
 * once the blob was older than staleTime (3 min). A write made after the blob
 * was saved invalidates the in-memory cache — an invalidation that does not
 * survive a reload. So inside that window the boot prefetch saw fresh data and
 * skipped the network.
 *
 * A restored snapshot is a placeholder: it must refetch once, at any age.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORAGE_KEY = "portol-query-cache-v1";
const fakeJwt = (sub: string) => `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.`;
const session = (uid: string) => JSON.stringify({ access_token: fakeJwt(uid), refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600 });
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: (i: number) => Array.from(m.keys())[i] ?? null, get length() { return m.size; } } as Storage;
}

// The key App.tsx DataPrefetch builds for the default ("everyone") scope.
const MONTH = new Date().toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles" }).slice(0, 7);
const BOOT_KEY = ["/api/dashboard-bootstrap", "everyone", MONTH];
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_BOOT_KEY = ["/api/dashboard-bootstrap", "selected", OTHER, MONTH];
const OLD_TASK = { id: "t-old", title: "Old task", status: "todo", linkedProfiles: [], tags: [] };
const NEW_TASK = { id: "t-new", title: "Added just before the refresh", status: "todo", linkedProfiles: [], tags: [] };
const bootstrapWith = (tasks: any[]) => ({ stats: { totalTasks: tasks.length }, enhanced: {}, profiles: [], tasks });

let mod: any;
beforeEach(async () => {
  vi.resetModules();
  (globalThis as any).localStorage = makeStorage();
  (globalThis as any).sessionStorage = makeStorage();
  localStorage.setItem("portol_session", session(USER));
  // The snapshot as it sits on disk: saved 20 seconds ago, BEFORE the write.
  // Several scopes' worth, like a real session that switched people: the
  // current scope's bootstrap first, another scope's bootstrap and stats after.
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: USER, entries: [
    { k: BOOT_KEY, d: bootstrapWith([OLD_TASK]), t: Date.now() - 20_000 },
    { k: ["/api/stats", "everyone"], d: { totalTasks: 1 }, t: Date.now() - 20_000 },
    { k: ["/api/stats", "selected", OTHER], d: { totalTasks: 7 }, t: Date.now() - 25_000 },
    { k: OTHER_BOOT_KEY, d: bootstrapWith([{ ...OLD_TASK, id: "t-other" }]), t: Date.now() - 25_000 },
  ] }));
  mod = await import("../client/src/lib/queryClient");
  mod.queryClient.clear();
});
afterEach(() => { delete (globalThis as any).localStorage; delete (globalThis as any).sessionStorage; });

describe("a restored snapshot is a placeholder, not fresh data", () => {
  it("paints the saved rows instantly", () => {
    mod.hydrateQueryCache();
    expect(mod.queryClient.getQueryData(BOOT_KEY)).toEqual(bootstrapWith([OLD_TASK]));
  });

  it("the boot prefetch goes to the network even though the snapshot is seconds old", async () => {
    mod.hydrateQueryCache();
    const fetchBootstrap = vi.fn(async () => bootstrapWith([OLD_TASK, NEW_TASK]));
    // Exactly what App.tsx DataPrefetch does on boot, default options.
    await mod.queryClient.prefetchQuery({ queryKey: BOOT_KEY, queryFn: fetchBootstrap });
    expect(fetchBootstrap).toHaveBeenCalledTimes(1);
    expect(mod.queryClient.getQueryData(BOOT_KEY).tasks.map((t: any) => t.id)).toEqual(["t-old", "t-new"]);
  });

  it("and only once: after that refresh the data is fresh again", async () => {
    mod.hydrateQueryCache();
    const fetchBootstrap = vi.fn(async () => bootstrapWith([OLD_TASK, NEW_TASK]));
    await mod.queryClient.prefetchQuery({ queryKey: BOOT_KEY, queryFn: fetchBootstrap });
    await mod.queryClient.prefetchQuery({ queryKey: BOOT_KEY, queryFn: fetchBootstrap });
    expect(fetchBootstrap).toHaveBeenCalledTimes(1);
  });

  const state = (key: unknown[]) => mod.queryClient.getQueryCache().find({ queryKey: key, exact: true })?.state;
  const stale = (key: unknown[]) => mod.queryClient.getQueryCache().find({ queryKey: key, exact: true })?.isStale();

  it("the current scope's lists are seeded (instant paint) and count as fresh — the boot refetch replaces them", () => {
    mod.hydrateQueryCache();
    expect(mod.queryClient.getQueryData(["/api/tasks", "everyone"])).toEqual([OLD_TASK]);
    expect(stale(["/api/tasks", "everyone"])).toBe(false);
    expect(stale(["/api/stats", "everyone"])).toBe(false);
    // …and the refresher itself is NOT fresh.
    expect(state(BOOT_KEY)?.isInvalidated).toBe(true);
  });

  it("another scope's saved data still paints, but refetches when a page shows it", () => {
    mod.hydrateQueryCache();
    // Painted from the blob…
    expect(mod.queryClient.getQueryData(["/api/stats", "selected", OTHER])).toEqual({ totalTasks: 7 });
    // …but nothing on boot will replace it, so it must not claim to be fresh.
    expect(stale(["/api/stats", "selected", OTHER])).toBe(true);
    expect(state(OTHER_BOOT_KEY)?.isInvalidated).toBe(true);
    // And its lists are not seeded as fresh from a bootstrap nobody refetches.
    expect(mod.queryClient.getQueryData(["/api/tasks", "selected", OTHER])).toBeUndefined();
  });
});
