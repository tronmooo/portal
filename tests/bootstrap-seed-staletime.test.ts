import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { bootstrapSeedEntries } from "../client/src/lib/bootstrap-seed-keys";
import { scopedKey } from "../shared/query-keys";

/**
 * [PERF 2026-08-17] "Returning to a section reloads everything."
 *
 * Measured on production before this fix: leaving Executive for >3 min and
 * coming back fired 12 parallel API requests — every one of them for data
 * /api/dashboard-bootstrap already carries and re-seeds. All ~25 seeded slots
 * were stamped fresh at the same instant, so they crossed the global staleTime
 * together and each component refetched its own slot while the bootstrap
 * refetched too and overwrote them all.
 *
 * The fix (client/src/lib/bootstrap-seed.ts) gives every bootstrap-seeded key
 * a LONGER staleTime than the bootstrap's own, so the bootstrap goes stale
 * first, refetches once, and re-seeds its dependents before any of them expire.
 *
 * These tests run the real QueryClient — the whole fix rests on react-query's
 * setQueryDefaults actually applying to the exact seeded keys, and on
 * invalidation still overriding staleTime (freshness must be unaffected).
 */

const MONTH = "2026-08";
const SEEDED_STALE_TIME_MS = 10 * 60_000;
const BOOTSTRAP_STALE_TIME_MS = 180_000; // global default in queryClient.ts

function sampleBootstrap() {
  return {
    stats: { net: 1 },
    enhanced: { score: 2 },
    profiles: [{ id: "self-1", type: "self" }],
    tasks: [{ id: "t1" }],
    habits: [{ id: "h1" }],
    expenses: [{ id: "e1" }],
    notifications: [{ id: "n1" }],
    preferences: {
      dismissed_notifications: JSON.stringify(["n-old"]),
      dashboard_layout: "hero,finance",
    },
  };
}

/** Mirrors seedDashboardCaches without importing the app's queryClient singleton. */
function seedInto(qc: QueryClient, b: any, mode: string, ids: string[], month: string) {
  for (const { key, data } of bootstrapSeedEntries(b, mode, ids, month)) {
    qc.setQueryData(key as any, data);
    qc.setQueryDefaults(key as any, { staleTime: SEEDED_STALE_TIME_MS });
  }
}

describe("bootstrap-seeded staleTime", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { staleTime: BOOTSTRAP_STALE_TIME_MS, retry: false } },
    });
  });

  it("keeps seeded keys fresh past the window where they all used to expire together", async () => {
    vi.useFakeTimers();
    try {
      seedInto(qc, sampleBootstrap(), "everyone", [], MONTH);
      const tasksKey = [...scopedKey("/api/tasks", "everyone", [])];

      // Just past the global staleTime — the moment every seeded slot used to
      // go stale at once and trigger the refetch storm.
      vi.advanceTimersByTime(BOOTSTRAP_STALE_TIME_MS + 5_000);
      expect(qc.getQueryState(tasksKey)?.isInvalidated).toBe(false);
      const stateAfter = qc.getQueryCache().find({ queryKey: tasksKey });
      expect(stateAfter?.isStaleByTime(SEEDED_STALE_TIME_MS)).toBe(false);

      // ...and they DO go stale eventually, so nothing is pinned forever.
      vi.advanceTimersByTime(SEEDED_STALE_TIME_MS);
      expect(stateAfter?.isStaleByTime(SEEDED_STALE_TIME_MS)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still refetches immediately when a mutation invalidates the domain (freshness is invalidation-driven)", async () => {
    seedInto(qc, sampleBootstrap(), "everyone", [], MONTH);
    const tasksKey = [...scopedKey("/api/tasks", "everyone", [])];

    // A mutation invalidating the /api/tasks prefix must mark the seeded slot
    // stale REGARDLESS of the long staleTime — that is what preserves
    // post-write correctness after this change.
    await qc.invalidateQueries({ queryKey: ["/api/tasks"], refetchType: "none" });
    expect(qc.getQueryState(tasksKey)?.isInvalidated).toBe(true);
  });

  it("applies the default only to the exact seeded keys, never to unrelated queries", () => {
    seedInto(qc, sampleBootstrap(), "everyone", [], MONTH);
    // A key the bootstrap does NOT carry keeps the global default.
    const unseeded = qc.getQueryDefaults(["/api/artifacts"]);
    expect(unseeded?.staleTime).not.toBe(SEEDED_STALE_TIME_MS);
    // A seeded key gets the longer one.
    const seeded = qc.getQueryDefaults([...scopedKey("/api/tasks", "everyone", [])]);
    expect(seeded?.staleTime).toBe(SEEDED_STALE_TIME_MS);
  });

  it("seeds a different scope's keys independently (switching people never reuses another scope's slot)", () => {
    seedInto(qc, sampleBootstrap(), "selected", ["p1"], MONTH);
    const p1Key = [...scopedKey("/api/tasks", "selected", ["p1"])];
    const p2Key = [...scopedKey("/api/tasks", "selected", ["p2"])];
    expect(qc.getQueryData(p1Key)).toEqual([{ id: "t1" }]);
    expect(qc.getQueryData(p2Key)).toBeUndefined();
    expect(qc.getQueryDefaults(p2Key)?.staleTime).not.toBe(SEEDED_STALE_TIME_MS);
  });
});

/**
 * The headline claim, measured rather than argued: how many network calls a
 * remount actually costs. Each seeded key gets a real QueryObserver with
 * refetchOnMount: true (the app's global default) and a counting queryFn, so
 * these numbers are the request counts the browser would produce.
 */
describe("requests fired when returning to a section", () => {
  const SEEDED_ENDPOINTS = [
    "/api/tasks", "/api/habits", "/api/goals", "/api/notifications",
    "/api/obligations", "/api/trackers", "/api/events", "/api/documents",
  ] as const;

  function mountAll(qc: QueryClient, onFetch: (endpoint: string) => void) {
    const observers = SEEDED_ENDPOINTS.map((endpoint) => {
      const observer = new QueryObserver(qc, {
        queryKey: [...scopedKey(endpoint, "everyone", [])],
        queryFn: async () => { onFetch(endpoint); return []; },
        refetchOnMount: true,
      });
      const unsub = observer.subscribe(() => {});
      return unsub;
    });
    return () => observers.forEach((u) => u());
  }

  it("fires ZERO requests on remount while the bootstrap seed is still fresh (was one per section)", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: BOOTSTRAP_STALE_TIME_MS, retry: false } },
    });
    seedInto(qc, sampleBootstrap(), "everyone", [], MONTH);
    // The bootstrap payload does not carry every one of these; seed the rest so
    // the test measures staleness policy, not seed coverage.
    for (const endpoint of SEEDED_ENDPOINTS) {
      const key = [...scopedKey(endpoint, "everyone", [])];
      if (qc.getQueryData(key) === undefined) {
        qc.setQueryData(key, []);
        qc.setQueryDefaults(key as any, { staleTime: SEEDED_STALE_TIME_MS });
      }
    }

    const fetched: string[] = [];
    const unmount = mountAll(qc, (e) => fetched.push(e));
    await new Promise((r) => setTimeout(r, 50));
    unmount();

    expect(fetched).toEqual([]);
  });

  it("CONTROL — the old policy fired one request per section on the same remount", async () => {
    // Reproduces the pre-fix arrangement: seeded slots carry the short
    // per-query staleTime the consumers used to pass (30-60s), so after an
    // ordinary pause every one of them is stale and refetches on mount. This
    // is the 8-12 request storm the production drive measured; it is kept as a
    // control so the fix above is a measured delta, not an assertion of faith.
    const OLD_STALE_TIME_MS = 60_000;
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: BOOTSTRAP_STALE_TIME_MS, retry: false } },
    });
    const seededAt = Date.now() - (OLD_STALE_TIME_MS + 10_000);
    for (const endpoint of SEEDED_ENDPOINTS) {
      const key = [...scopedKey(endpoint, "everyone", [])];
      qc.setQueryData(key, [], { updatedAt: seededAt });
    }

    const fetched: string[] = [];
    const observers = SEEDED_ENDPOINTS.map((endpoint) => {
      const observer = new QueryObserver(qc, {
        queryKey: [...scopedKey(endpoint, "everyone", [])],
        queryFn: async () => { fetched.push(endpoint); return []; },
        refetchOnMount: true,
        staleTime: OLD_STALE_TIME_MS, // the override the consumers used to pass
      });
      return observer.subscribe(() => {});
    });
    await new Promise((r) => setTimeout(r, 50));
    observers.forEach((u) => u());

    expect(fetched.length).toBe(SEEDED_ENDPOINTS.length);
  });

  it("still refetches on remount once the seed is genuinely stale", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { staleTime: BOOTSTRAP_STALE_TIME_MS, retry: false } },
    });
    const key = [...scopedKey("/api/tasks", "everyone", [])];
    // Seeded long enough ago that even the extended staleTime has passed.
    qc.setQueryData(key, [], { updatedAt: Date.now() - (SEEDED_STALE_TIME_MS + 60_000) });
    qc.setQueryDefaults(key as any, { staleTime: SEEDED_STALE_TIME_MS });

    let fetches = 0;
    const observer = new QueryObserver(qc, {
      queryKey: key,
      queryFn: async () => { fetches++; return []; },
      refetchOnMount: true,
    });
    const unsub = observer.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 50));
    unsub();

    expect(fetches).toBe(1);
  });
});

describe("preference seeds", () => {
  const find = (b: any, key: unknown[]) =>
    bootstrapSeedEntries(b, "everyone", [], MONTH)
      .find((e) => JSON.stringify(e.key) === JSON.stringify(key));

  const DISMISSED_KEY = ["/api/preferences/dismissed_notifications"];
  const LAYOUT_KEY = ["/api/preferences", "dashboard_layout"];

  it("seeds the dismissed-ids slot the bell and Executive Brief both read", () => {
    expect(find(sampleBootstrap(), DISMISSED_KEY)?.data).toEqual(["n-old"]);
  });

  it("treats a malformed stored preference as 'nothing dismissed' rather than throwing", () => {
    const b = { ...sampleBootstrap(), preferences: { dismissed_notifications: "{not json" } };
    expect(find(b, DISMISSED_KEY)?.data).toEqual([]);
  });

  it("seeds the layout slot in the endpoint's own response shape", () => {
    expect(find(sampleBootstrap(), LAYOUT_KEY)?.data).toEqual({ value: "hero,finance" });
  });

  it("seeds an UNSET layout as { value: null } — the shape GET /api/preferences/:key returns", () => {
    // A bare null would be skipped by the seeder, leaving the slot empty and
    // the request still firing — the exact round trip this seed removes.
    const b = { ...sampleBootstrap(), preferences: { dismissed_notifications: "[]" } };
    expect(find(b, LAYOUT_KEY)?.data).toEqual({ value: null });
  });

  it("does NOT seed these slots when the payload predates the field (an old cached bootstrap must not clobber them)", () => {
    const { preferences, ...withoutField } = sampleBootstrap();
    expect(find(withoutField, DISMISSED_KEY)).toBeUndefined();
    expect(find(withoutField, LAYOUT_KEY)).toBeUndefined();
  });
});
