// Handing an asset back (co-owner removed) took 20 s and logged "could not
// redistribute shares": removing the co-owner inside the locked owner-set
// replacement redistributes the survivors' shares through setAssetOwners,
// which waited for the lock its own call chain held (integrity run on the
// isolated stack, 2026-11-28; server.log "PUT …/owners 200 in 20169ms").
// The lock here is EXCLUSIVE, as the database row is: a nested take of the
// same name would wait for the deadline and fail.
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

function storageWithRealLock() {
  const s: any = Object.create(SupabaseStorage.prototype);
  s.userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const held = new Set<string>();
  s.acquireUserLock = async (name: string) => { if (held.has(name)) return false; held.add(name); return true; };
  s.releaseUserLock = async (name: string) => { held.delete(name); };
  return { s, held };
}

describe("the owner-set lock is re-entrant within one call chain", () => {
  it("a nested take of the same lock runs at once, and the lock is released once", async () => {
    const { s, held } = storageWithRealLock();
    const t0 = Date.now();
    const out = await s.withOwnerSetLock("owners:asset:x", async () =>
      s.withOwnerSetLock("owners:asset:x", async () => "inner"));
    expect(out).toBe("inner");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(held.size).toBe(0);
  });
  it("another call chain still waits for it (two saves never interleave)", async () => {
    const { s } = storageWithRealLock();
    const order: string[] = [];
    let releaseA!: () => void;
    const a = s.withOwnerSetLock("owners:asset:y", async () => { order.push("a-start"); await new Promise<void>((r) => { releaseA = r; }); order.push("a-end"); });
    await new Promise((r) => setTimeout(r, 20));
    const b = s.withOwnerSetLock("owners:asset:y", async () => { order.push("b"); });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(["a-start"]);
    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
