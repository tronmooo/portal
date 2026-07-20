// PERF-INCIDENT 2026-07-20 — structural guards that keep AI and forced global
// refetches OFF the ordinary CRUD path. These are the two root causes behind
// "a basic update takes 30 seconds":
//
//   1. Every tracker log fired invalidateQueries(..., refetchType: "all") for
//      /api/stats and /api/dashboard-enhanced — two endpoints that each fan out
//      to ~10 Supabase queries and are not even mounted on the trackers page.
//      "all" force-refetches inactive queries, so every log re-ran both cold
//      aggregations. The optimistic onMutate patch already updates the on-screen
//      list, so the forced refetch bought nothing but latency.
//
//   2. Editing a profile field (e.g. a vehicle's mileage) auto-invalidated the
//      mounted `ai-summary` query, and because the server clears its cache on
//      PATCH, that meant a COLD Anthropic generation on every field save — AI
//      sitting directly on the CRUD path.
//
// If either pattern comes back, this test fails. Fix the code, don't delete the
// guard.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const clientRoot = path.resolve(__dirname, "../client/src");
const read = (rel: string) => fs.readFileSync(path.join(clientRoot, rel), "utf8");

describe("CRUD hygiene — no forced global refetch after a tracker write", () => {
  it('trackers.tsx has no refetchType:"all" (it force-refetches inactive heavy endpoints)', () => {
    const src = read("pages/trackers.tsx");
    const hits = [...src.matchAll(/refetchType:\s*["']all["']/g)];
    expect(
      hits.length,
      'Found refetchType:"all" in trackers.tsx. A tracker log must not force a ' +
        "cold refetch of /api/stats or /api/dashboard-enhanced — the optimistic " +
        "onMutate patch already updates the list. Use default (active-only) " +
        "invalidation instead.",
    ).toBe(0);
  });
});

describe("CRUD hygiene — no AI regeneration on a profile field edit", () => {
  const src = read("pages/profile-detail.tsx");

  it("the field-edit save() does not invalidate the ai-summary query", () => {
    // Isolate the save() used by the inline field editor (PATCH /api/profiles/:id).
    const start = src.indexOf("const save = async () => {");
    expect(start, "field-edit save() not found — did the editor change shape?").toBeGreaterThan(-1);
    const end = src.indexOf("};", start);
    const saveBody = src.slice(start, end);
    expect(
      /ai-summary/.test(saveBody),
      "save() references ai-summary — a plain field edit must not trigger an AI " +
        "regeneration. Show a 'refresh' affordance instead of auto-regenerating.",
    ).toBe(false);
  });

  it("no effect auto-invalidates ai-summary in reaction to a profile change", () => {
    // The old bug: a useEffect keyed on profileUpdatedAt that called
    // invalidateQueries(['/api/profiles', id, 'ai-summary']). Marking the summary
    // stale (setSummaryStale) is fine; force-refetching it on every edit is not.
    const effectInvalidates =
      /profileUpdatedAt[\s\S]{0,400}invalidateQueries\([^)]*ai-summary/.test(src);
    expect(
      effectInvalidates,
      "An effect keyed on profileUpdatedAt invalidates ai-summary — that forces a " +
        "cold Anthropic call on every field edit. Set a stale flag and let the user " +
        "refresh on demand.",
    ).toBe(false);
  });
});
