/**
 * Read-your-own-write: the version floor that replaced a 1200ms guess.
 *
 * THE BUG (user report 2026-08-02): a tracker created in chat did not appear on
 * the Trackers tab until the whole app was reloaded.
 *
 * Mechanism — server cache keys embed the user's Postgres data version, but each
 * instance memoizes that version for 2s. The refetch fired right after the chat
 * turn therefore computed a PRE-write key, hit the 5-minute cached pre-write
 * list, and React Query stored that as fresh for its 3-minute staleTime. Nothing
 * refetched again (focus/reconnect refetch are off), so the write stayed
 * invisible until a reload re-seeded from the bootstrap.
 *
 * The fix: a write reports the version it produced; the client presents it as a
 * floor; an instance whose memo is below the floor re-reads from Postgres before
 * stamping any cache key. These tests pin the two halves of that contract.
 */
import { describe, it, expect } from "vitest";
import { MIN_DATA_VERSION_HEADER, MIN_DATA_VERSION_TTL_MS, parseMinDataVersion } from "@shared/data-version";

describe("parseMinDataVersion", () => {
  it("reads a numeric header", () => {
    expect(parseMinDataVersion("42")).toBe(42);
  });

  it("takes the first value when a header repeats", () => {
    expect(parseMinDataVersion(["7", "3"])).toBe(7);
  });

  it("treats anything missing or malformed as no floor", () => {
    // A bogus floor must degrade to "no opinion", never to a poisoned key: the
    // header can only ever make the server go ASK Postgres, so the worst case
    // is one extra indexed read.
    for (const bad of [undefined, null, "", "abc", "-1", "0", "NaN", {} as any]) {
      expect(parseMinDataVersion(bad as any)).toBe(0);
    }
  });

  it("uses a lowercase header name (Node lowercases incoming headers)", () => {
    expect(MIN_DATA_VERSION_HEADER).toBe(MIN_DATA_VERSION_HEADER.toLowerCase());
  });

  it("keeps the floor alive long enough to cover a slow turn's follow-up reads", () => {
    // The version bump propagates within ~VERSION_MEMO_MS (2s), so this only
    // needs to exceed that comfortably — while staying short enough that a
    // pathological value stops mattering almost immediately.
    expect(MIN_DATA_VERSION_TTL_MS).toBeGreaterThan(2_000);
    expect(MIN_DATA_VERSION_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});

/**
 * The server-side half: currentDataVersion(uid, minVersion) must ignore a
 * memoized value that is BELOW the caller's floor, even when that value is
 * still inside the memo window. Reproduced here against the same logic shape
 * used in server/routes.ts (the real function closes over module state that
 * needs a live storage layer).
 */
describe("version memo honours the caller's floor", () => {
  function makeResolver(dbVersion: () => number) {
    const memo = new Map<string, { v: number; at: number }>();
    const inflight = new Map<string, Promise<number>>();
    let reads = 0;
    const MEMO_MS = 2000;
    async function resolve(uid: string, minVersion = 0): Promise<number> {
      const hit = memo.get(uid);
      if (hit && Date.now() - hit.at < MEMO_MS && hit.v >= minVersion) return hit.v;
      const pending = inflight.get(uid);
      if (pending) return pending;
      // Mirrors server/routes.ts: register BEFORE awaiting, clean up after.
      // Putting the delete in a `finally` inside the async body would run it
      // before the set whenever the body doesn't suspend, stranding a resolved
      // promise in the map — which then serves the pre-write version forever.
      const read = (async () => {
        reads++;
        const v = await Promise.resolve(dbVersion());
        memo.set(uid, { v, at: Date.now() });
        return v;
      })();
      inflight.set(uid, read);
      try {
        return await read;
      } finally {
        inflight.delete(uid);
      }
    }
    return { resolve, memo, reads: () => reads };
  }

  it("serves the memo when no floor is presented", async () => {
    let version = 5;
    const r = makeResolver(() => version);
    expect(await r.resolve("u1")).toBe(5);
    version = 9; // a write landed on another instance
    // No floor → the stale memo is served. This is the pre-fix behaviour, and
    // it is exactly the window the bug lived in.
    expect(await r.resolve("u1")).toBe(5);
    expect(r.reads()).toBe(1);
  });

  it("re-reads when the caller knows about a newer version", async () => {
    let version = 5;
    const r = makeResolver(() => version);
    expect(await r.resolve("u1")).toBe(5);
    version = 9; // the chat turn's write
    // The client watched the write produce 9, so a memo of 5 is provably stale.
    expect(await r.resolve("u1", 9)).toBe(9);
    expect(r.reads()).toBe(2);
  });

  it("does not re-read when the memo already meets the floor", async () => {
    const r = makeResolver(() => 9);
    expect(await r.resolve("u1", 9)).toBe(9);
    expect(await r.resolve("u1", 9)).toBe(9);
    expect(r.reads(), "a satisfied floor must not cost a DB read per request").toBe(1);
  });

  it("collapses a concurrent refetch wave into one read", async () => {
    // A post-write invalidation fires several queries at once, all carrying the
    // same floor. Without in-flight sharing each would issue its own read.
    const r = makeResolver(() => 9);
    const results = await Promise.all([
      r.resolve("u1", 9), r.resolve("u1", 9), r.resolve("u1", 9),
      r.resolve("u1", 9), r.resolve("u1", 9),
    ]);
    expect(results).toEqual([9, 9, 9, 9, 9]);
    expect(r.reads()).toBe(1);
  });

  it("keeps users independent", async () => {
    const r = makeResolver(() => 9);
    await r.resolve("u1", 9);
    await r.resolve("u2", 9);
    expect(r.reads()).toBe(2);
  });
});
