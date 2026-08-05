/**
 * Cross-request read reuse for the dashboard bootstrap (2026-08-05).
 *
 * Why this exists: /api/dashboard-bootstrap reads every table UNFILTERED and
 * filters in JS (the `sharedFetches` path in getStats/getDashboardEnhanced), so
 * the Supabase work behind it is IDENTICAL for every profile scope — only the
 * filtering differs. The response cache is keyed by scope though, so picking a
 * second person re-ran the whole ~18-query fan-out from scratch. That is the
 * "switching people is slow" report (PERF_PLAN_LAUNCH_2026-07-16 §B1).
 *
 * The fix caches one request's resolved reads under a per-user, version-stamped
 * key and primes the next scope's request memo with them. These tests pin the
 * two properties that fix depends on:
 *
 *   1. a primed entry is served BY THE REAL MEMO KEY the storage method uses —
 *      if a key ever drifts, the prime silently stops working and every switch
 *      goes back to hitting Supabase (no error, just slow), and
 *   2. priming can never resurrect a failed read or clobber a live one.
 *
 * A primed read must resolve with no Supabase client involvement at all — the
 * instance here is built against a dummy URL, so anything that reached the
 * network would fail rather than pass.
 */
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

function makeStorage() {
  return new SupabaseStorage("https://unit-test.invalid", "service-key-unused", "user-1");
}

describe("request memo priming", () => {
  it("serves getProfiles() from a primed snapshot without touching Supabase", async () => {
    const s = makeStorage();
    s.enableRequestMemo();
    s.primeRequestMemo({ getProfiles: [{ id: "p1", type: "self" }] });

    await expect(s.getProfiles()).resolves.toEqual([{ id: "p1", type: "self" }]);
  });

  it("round-trips: what one request snapshots, the next request can prime", async () => {
    const first = makeStorage();
    first.enableRequestMemo();
    first.primeRequestMemo({ getProfiles: [{ id: "p1", type: "self" }] });
    await first.getProfiles();

    const snapshot = await first.snapshotRequestMemo();
    expect(Object.keys(snapshot)).toContain("getProfiles");

    const second = makeStorage();
    second.enableRequestMemo();
    second.primeRequestMemo(snapshot);
    await expect(second.getProfiles()).resolves.toEqual([{ id: "p1", type: "self" }]);
  });

  it("ignores priming when the memo is off, so a plain request never reuses reads", async () => {
    const s = makeStorage();
    s.primeRequestMemo({ getProfiles: [{ id: "leaked" }] });
    await expect(s.snapshotRequestMemo()).resolves.toEqual({});
  });

  it("never overwrites a live memo entry", async () => {
    const s = makeStorage();
    s.enableRequestMemo();
    s.primeRequestMemo({ getProfiles: [{ id: "first" }] });
    s.primeRequestMemo({ getProfiles: [{ id: "second" }] });

    await expect(s.getProfiles()).resolves.toEqual([{ id: "first" }]);
  });

  it("drops failed reads from the snapshot instead of replaying them as success", async () => {
    const s = makeStorage();
    s.enableRequestMemo();
    // Reach into the memo the way a rejected in-flight read would leave it.
    (s as any).memoCache.set("getProfiles", Promise.reject(new Error("supabase down")));
    (s as any).memoCache.set("getTasks", Promise.resolve([{ id: "t1" }]));

    const snapshot = await s.snapshotRequestMemo();
    expect(snapshot).not.toHaveProperty("getProfiles");
    expect(snapshot.getTasks).toEqual([{ id: "t1" }]);
  });

  it("clears primed entries on disableRequestMemo (no bleed into the next scope)", async () => {
    const s = makeStorage();
    s.enableRequestMemo();
    s.primeRequestMemo({ getProfiles: [{ id: "p1" }] });
    s.disableRequestMemo();

    await expect(s.snapshotRequestMemo()).resolves.toEqual({});
  });
});
