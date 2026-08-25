import { describe, it, expect } from "vitest";
import { reconcileTotal } from "../client/src/lib/derived-aggregates";

describe("aggregates that move on the write", () => {
  it("shows the server's number exactly when nothing has changed", () => {
    // The invariant that makes this safe: at rest the delta is zero, so the
    // tile is the server's authoritative, ownership-aware number — never a
    // second opinion computed on the client.
    expect(reconcileTotal(175_000, 120_000, { server: 175_000, derived: 120_000 })).toBe(175_000);
  });

  it("moves by the change the client can see, from the server's level", () => {
    // A $200 payment patches the liability's balance in the profiles cache.
    // The client walk drops by 200; the tile drops by 200 from the server's
    // level, immediately, instead of holding still until ~15 aggregate
    // queries recompute.
    expect(reconcileTotal(9_000, 4_800, { server: 9_000, derived: 5_000 })).toBe(8_800);
  });

  it("keeps the server's level even when the client walk disagrees with it", () => {
    // The client walk is parent-only and misses co-ownership, so it routinely
    // differs from the server. That difference must survive untouched — only
    // the movement is borrowed.
    const shown = reconcileTotal(175_000, 121_500, { server: 175_000, derived: 120_000 });
    expect(shown).toBe(176_500);
  });

  it("re-anchors once a fresh server value lands", () => {
    const afterRefetch = reconcileTotal(176_500, 121_500, { server: 176_500, derived: 121_500 });
    expect(afterRefetch).toBe(176_500);
  });

  it("shows the server value untouched before any baseline exists", () => {
    expect(reconcileTotal(500, 999, null)).toBe(500);
  });

  it("falls back to the client walk when the server has said nothing yet", () => {
    expect(reconcileTotal(undefined, 4_200, null)).toBe(4_200);
    expect(reconcileTotal(undefined, 4_200, { server: 1, derived: 1 })).toBe(4_200);
  });

  it("never propagates a non-finite number into a tile", () => {
    expect(reconcileTotal(NaN, 10, { server: 1, derived: 1 })).toBe(10);
    expect(reconcileTotal(100, NaN, { server: 100, derived: 90 })).toBe(100);
    expect(reconcileTotal(100, 90, { server: 100, derived: NaN })).toBe(100);
  });
});
