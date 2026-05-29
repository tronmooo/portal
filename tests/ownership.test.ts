/**
 * Tests for the pure side of `shared/ownership.ts`.
 *
 * Stage 1 of the ownership consolidation plan. The runtime writer side
 * (`server/ownership-writer.ts`) is covered by a contract test that exercises
 * a real database round-trip.
 */
import { describe, it, expect } from "vitest";
import { normalizeOwners, diffOwners, OWNERSHIP_TABLES } from "../shared/ownership";

const SELF = "21916904-8e89-45aa-84d1-f0d703d0ac45";
const A = "4d394b74-9695-45c1-933a-ab5a8e79d6a1";
const B = "2c8ddcbb-e198-4273-9836-97f30812ba52";
const C = "eff1d2f4-0c8d-4773-880f-7d2f1f2f4eca";

describe("normalizeOwners", () => {
  it("returns [selfId] when candidate is null", () => {
    const r = normalizeOwners(null, SELF);
    expect(r.ownerIds).toEqual([SELF]);
    expect(r.defaultedToSelf).toBe(true);
  });

  it("returns [selfId] when candidate is undefined", () => {
    const r = normalizeOwners(undefined, SELF);
    expect(r.ownerIds).toEqual([SELF]);
    expect(r.defaultedToSelf).toBe(true);
  });

  it("returns [selfId] when candidate is empty array", () => {
    const r = normalizeOwners([], SELF);
    expect(r.ownerIds).toEqual([SELF]);
    expect(r.defaultedToSelf).toBe(true);
  });

  it("returns [selfId] when candidate has only invalid entries", () => {
    const r = normalizeOwners(["not-a-uuid", "", null, 42, undefined], SELF);
    expect(r.ownerIds).toEqual([SELF]);
    expect(r.defaultedToSelf).toBe(true);
  });

  it("preserves valid UUIDs in order", () => {
    const r = normalizeOwners([A, B, C], SELF);
    expect(r.ownerIds).toEqual([A, B, C]);
    expect(r.defaultedToSelf).toBe(false);
  });

  it("dedupes while preserving first occurrence", () => {
    const r = normalizeOwners([A, B, A, C, B], SELF);
    expect(r.ownerIds).toEqual([A, B, C]);
    expect(r.defaultedToSelf).toBe(false);
  });

  it("drops names and slugs (only UUIDs are owners — labels are not)", () => {
    const r = normalizeOwners(["Bob", "alice-smith", A, "self", B], SELF);
    expect(r.ownerIds).toEqual([A, B]);
    expect(r.defaultedToSelf).toBe(false);
  });

  it("trims whitespace around UUIDs", () => {
    const r = normalizeOwners([`  ${A}  `, B], SELF);
    expect(r.ownerIds).toEqual([A, B]);
  });

  it("accepts uppercase UUIDs", () => {
    const r = normalizeOwners([A.toUpperCase()], SELF);
    expect(r.ownerIds).toEqual([A.toUpperCase()]);
  });

  it("throws when selfId is not a UUID", () => {
    expect(() => normalizeOwners([A], "not-a-uuid")).toThrow(/selfId/);
    expect(() => normalizeOwners([A], "")).toThrow(/selfId/);
  });
});

describe("diffOwners", () => {
  it("returns empty diffs for equal sets", () => {
    expect(diffOwners([A, B], [A, B])).toEqual({ toInsert: [], toDelete: [] });
    expect(diffOwners([A, B], [B, A])).toEqual({ toInsert: [], toDelete: [] });
  });

  it("computes inserts and deletes", () => {
    expect(diffOwners([A], [A, B])).toEqual({ toInsert: [B], toDelete: [] });
    expect(diffOwners([A, B], [A])).toEqual({ toInsert: [], toDelete: [B] });
    expect(diffOwners([A], [B])).toEqual({ toInsert: [B], toDelete: [A] });
  });

  it("handles complete replacement", () => {
    expect(diffOwners([A, B], [C])).toEqual({ toInsert: [C], toDelete: [A, B] });
  });

  it("handles empty before", () => {
    expect(diffOwners([], [A, B])).toEqual({ toInsert: [A, B], toDelete: [] });
  });

  it("handles empty after", () => {
    expect(diffOwners([A, B], [])).toEqual({ toInsert: [], toDelete: [A, B] });
  });
});

describe("OWNERSHIP_TABLES — the canonical schema map", () => {
  it("lists exactly the 11 entity types that carry linked_profiles", () => {
    expect(Object.keys(OWNERSHIP_TABLES).sort()).toEqual([
      "artifact", "document", "event", "expense", "goal",
      "habit", "income", "journal_entry", "obligation", "task", "tracker",
    ]);
  });

  it("has no junction tables after FIX 4 Phase 2 — linked_profiles is the only source of truth", () => {
    // FIX 4 Phase 2 (2026-05-28): the seven profile_<type> junction tables
    // were dropped. Every entity now uses linked_profiles JSONB exclusively.
    // Fractional ownership for assets/liabilities still uses
    // asset_party_links / liability_profile_links, which are not in this map.
    const withJunction = (Object.entries(OWNERSHIP_TABLES) as [string, any][])
      .filter(([, v]) => v.junctionTable !== null)
      .map(([k]) => k).sort();
    expect(withJunction).toEqual([]);
  });

  it("uses snake_case junction table names matching `profile_<plural>`", () => {
    for (const [, spec] of Object.entries(OWNERSHIP_TABLES)) {
      if (spec.junctionTable) {
        expect(spec.junctionTable).toMatch(/^profile_/);
        expect(spec.junctionEntityColumn).toMatch(/_id$/);
      } else {
        expect(spec.junctionEntityColumn).toBeNull();
      }
    }
  });
});
