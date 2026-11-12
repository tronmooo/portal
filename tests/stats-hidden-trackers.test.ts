/**
 * A tracker no list shows is not counted (2026-11-12).
 *
 * Legacy money-category trackers ("finance", "budget", …) are filtered out of
 * GET /api/trackers and every tracker list (shared/hidden-tracker-categories),
 * but getStats counted them: Settings read "9 Trackers" over a list of one,
 * and the assistant's account summary quoted the same nine.
 */
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";
import { MemStorage } from "../server/storage";

const SELF = { id: "self", type: "self", name: "Me", fields: {} };
const tracker = (id: string, category: string) => ({ id, name: id, category, linkedProfiles: ["self"], fields: [], entries: [{ id: `${id}-e`, timestamp: new Date().toISOString(), values: { value: 1 } }] });
const TRACKERS = [tracker("Weight", "health"), tracker("Old budget", "budget"), tracker("Old finance", " Finance ")];

function supabaseStorageOver(fixtures: Record<string, any[]>) {
  const real: any = Object.create(SupabaseStorage.prototype);
  real.userId = "user-1";
  real._timezone = "UTC";
  const proto: any = SupabaseStorage.prototype;
  return new Proxy(real, {
    get(target, key: string) {
      if (key in fixtures) return async () => fixtures[key];
      if (typeof key === "string" && key !== "getStats" && typeof proto[key] === "function" && /^(get|list)[A-Z]/.test(key)) return async () => [];
      return target[key];
    },
  }) as any;
}

describe("stats count only the trackers a list can show", () => {
  it("SupabaseStorage.getStats leaves hidden-category trackers out of the count and the weekly entries", async () => {
    const s = supabaseStorageOver({ getProfiles: [SELF], getTrackers: TRACKERS });
    const stats = await s.getStats();
    expect(stats.totalTrackers).toBe(1);
    expect(stats.weeklyEntries).toBe(1);
  });

  it("MemStorage.getStats agrees", async () => {
    const s: any = new MemStorage();
    for (const t of TRACKERS) s.trackers.set(t.id, t);
    const stats = await s.getStats();
    expect(stats.totalTrackers).toBe(1);
  });
});
