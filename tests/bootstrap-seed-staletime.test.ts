import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
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
    dismissedNotifications: JSON.stringify(["n-old"]),
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

describe("dismissed-notification seed", () => {
  it("seeds the shared preference slot the bell and Executive Brief both read", () => {
    const entries = bootstrapSeedEntries(sampleBootstrap(), "everyone", [], MONTH);
    const hit = entries.find(
      (e) => JSON.stringify(e.key) === JSON.stringify(["/api/preferences/dismissed_notifications"]),
    );
    expect(hit?.data).toEqual(["n-old"]);
  });

  it("treats a malformed stored preference as 'nothing dismissed' rather than throwing", () => {
    const entries = bootstrapSeedEntries(
      { ...sampleBootstrap(), dismissedNotifications: "{not json" },
      "everyone", [], MONTH,
    );
    const hit = entries.find(
      (e) => JSON.stringify(e.key) === JSON.stringify(["/api/preferences/dismissed_notifications"]),
    );
    expect(hit?.data).toEqual([]);
  });

  it("does NOT seed the slot when the payload predates the field (an old cached bootstrap must not clobber it)", () => {
    const { dismissedNotifications, ...withoutField } = sampleBootstrap();
    const entries = bootstrapSeedEntries(withoutField, "everyone", [], MONTH);
    const hit = entries.find(
      (e) => JSON.stringify(e.key) === JSON.stringify(["/api/preferences/dismissed_notifications"]),
    );
    expect(hit).toBeUndefined();
  });
});
