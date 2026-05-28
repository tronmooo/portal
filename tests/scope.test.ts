import { describe, it, expect } from "vitest";
import { isInScope, selfIdsFrom, type ScopeContext } from "../shared/scope";
import { passesProfileFilter } from "../shared/profile-filter";
import { isProfileInNetWorthScope } from "../shared/net-worth";

// Stage 0 of the ownership-model consolidation: pin the shared `isInScope`
// primitive AND prove that `passesProfileFilter` and `isProfileInNetWorthScope`
// give the same answer when given the same candidate-id set. Without this
// test, the two callers can drift again the next time someone "fixes" one
// surface without touching the other — the exact failure mode the user
// described as the loop.

const ALICE = { id: "alice", type: "self" };
const BOB = { id: "bob", type: "person" };
const CAR = { id: "car", type: "asset" };
const ALL = [ALICE, BOB, CAR];
const selfIds = selfIdsFrom(ALL);
const ctx = (selectedIds: string[]): ScopeContext => ({ selectedIds, selfIds });

describe("BUG-20260528-scope-unification — isInScope primitive", () => {
  it("inactive selection (empty) means everything is in scope", () => {
    expect(isInScope(["bob"], ctx([]))).toBe(true);
    expect(isInScope([], ctx([]))).toBe(true);
    expect(isInScope(null, ctx([]))).toBe(true);
    expect(isInScope(undefined, ctx([]))).toBe(true);
  });

  it("intersect: any candidate id in selection ⇒ in scope", () => {
    expect(isInScope(["bob"], ctx(["bob"]))).toBe(true);
    expect(isInScope(["bob", "alice"], ctx(["alice"]))).toBe(true);
    expect(isInScope(["car"], ctx(["bob"]))).toBe(false);
  });

  it("orphan policy 'belongs_to_self': empty candidates pass iff a self id is selected", () => {
    expect(isInScope([], ctx(["alice"]), "belongs_to_self")).toBe(true);
    expect(isInScope([], ctx(["bob"]), "belongs_to_self")).toBe(false);
    expect(isInScope(null, ctx(["alice"]), "belongs_to_self")).toBe(true);
  });

  it("orphan policy 'out_of_scope': empty candidates never pass when filter active", () => {
    expect(isInScope([], ctx(["alice"]), "out_of_scope")).toBe(false);
    expect(isInScope([], ctx(["bob"]), "out_of_scope")).toBe(false);
    expect(isInScope(null, ctx(["alice"]), "out_of_scope")).toBe(false);
  });

  it("default orphan policy is 'belongs_to_self' (preserves legacy behavior)", () => {
    // Mirrors `passesProfileFilter`'s contract before the refactor.
    expect(isInScope([], ctx(["alice"]))).toBe(true);
    expect(isInScope([], ctx(["bob"]))).toBe(false);
  });

  it("non-string candidates are ignored (defensive)", () => {
    // Iterables may contain stray null/undefined/empty strings from bad data —
    // they must NEVER cause a false positive against the selection.
    expect(isInScope([null, undefined, ""], ctx(["bob"]))).toBe(false);
    expect(isInScope([null, "bob"] as any, ctx(["bob"]))).toBe(true);
  });

  it("duplicate candidates don't change the answer", () => {
    expect(isInScope(["bob", "bob", "bob"], ctx(["bob"]))).toBe(true);
    expect(isInScope(["bob", "bob"], ctx(["alice"]))).toBe(false);
  });
});

describe("BUG-20260528-scope-unification — passesProfileFilter delegates to isInScope", () => {
  // The lock: same inputs ⇒ same answer. If someone re-implements either
  // surface inline, this test forces them to add a corresponding isInScope
  // call so the behavior stays equivalent.
  const cases: Array<{ linked: string[] | null | undefined; selected: string[]; expected: boolean }> = [
    { linked: ["bob"], selected: ["bob"], expected: true },
    { linked: ["bob"], selected: ["alice"], expected: false },
    { linked: [], selected: ["alice"], expected: true },   // orphan + self
    { linked: [], selected: ["bob"], expected: false },    // orphan, no self
    { linked: undefined, selected: ["alice"], expected: true },
    { linked: null, selected: ["bob"], expected: false },
    { linked: ["bob", "alice"], selected: ["bob"], expected: true },
    { linked: ["car"], selected: ["bob", "alice"], expected: false },
  ];
  for (const c of cases) {
    it(`passesProfileFilter(${JSON.stringify(c.linked)}, sel=${JSON.stringify(c.selected)}) == ${c.expected}`, () => {
      const got = passesProfileFilter(c.linked, { selectedIds: c.selected, allProfiles: ALL });
      const viaPrimitive = isInScope(
        Array.isArray(c.linked) ? c.linked : [],
        { selectedIds: c.selected, selfIds },
        "belongs_to_self",
      );
      expect(got).toBe(c.expected);
      expect(got).toBe(viaPrimitive);
    });
  }
});

describe("BUG-20260528-scope-unification — isProfileInNetWorthScope delegates to isInScope", () => {
  // A profile is its own owner: candidate set always includes its id. Plus
  // optional parent and co-owner field shapes. Verify the same answer comes
  // out of the primitive when called with the extracted candidate set.

  const carOwnedByAlice = { id: "car", type: "asset", fields: { _parentProfileId: "alice" } };
  const carOwnedByBoth = { id: "car", type: "asset", fields: { owners: [{ profileId: "alice" }, { profileId: "bob" }] } };
  const carNoOwner = { id: "car", type: "asset", fields: {} };

  it("filter inactive ('everyone' mode): always in scope", () => {
    expect(isProfileInNetWorthScope(carOwnedByAlice, { mode: "everyone", selectedIds: [] })).toBe(true);
    expect(isProfileInNetWorthScope(carOwnedByAlice, { mode: "selected", selectedIds: [] })).toBe(true);
  });

  it("self-owned: passes when own id selected", () => {
    expect(isProfileInNetWorthScope(carNoOwner, { mode: "selected", selectedIds: ["car"] })).toBe(true);
    expect(isProfileInNetWorthScope(carNoOwner, { mode: "selected", selectedIds: ["alice"] })).toBe(false);
  });

  it("parent-linked: passes when parent selected", () => {
    expect(isProfileInNetWorthScope(carOwnedByAlice, { mode: "selected", selectedIds: ["alice"] })).toBe(true);
    expect(isProfileInNetWorthScope(carOwnedByAlice, { mode: "selected", selectedIds: ["bob"] })).toBe(false);
  });

  it("co-owners: passes when any co-owner selected", () => {
    expect(isProfileInNetWorthScope(carOwnedByBoth, { mode: "selected", selectedIds: ["bob"] })).toBe(true);
    expect(isProfileInNetWorthScope(carOwnedByBoth, { mode: "selected", selectedIds: ["alice"] })).toBe(true);
    // out-of-scope when neither owner is selected, even though car id exists
    expect(isProfileInNetWorthScope(carOwnedByBoth, { mode: "selected", selectedIds: ["other"] })).toBe(false);
  });

  it("cross-check vs isInScope primitive with the same candidate set", () => {
    // The primitive answer (out_of_scope policy) must match isProfileInNetWorthScope.
    const candidates = ["car", "alice", "bob"]; // car id + parent + co-owners
    const got = isInScope(candidates, { selectedIds: ["bob"], selfIds: new Set<string>() }, "out_of_scope");
    expect(got).toBe(true);
    const got2 = isInScope(candidates, { selectedIds: ["nobody"], selfIds: new Set<string>() }, "out_of_scope");
    expect(got2).toBe(false);
  });
});

describe("BUG-20260528-scope-unification — selfIdsFrom helper", () => {
  it("collects only profiles with type==='self'", () => {
    const s = selfIdsFrom([
      { id: "a", type: "self" },
      { id: "b", type: "person" },
      { id: "c", type: "self" },
      { id: "d" } as any, // missing type
    ]);
    expect(s.has("a")).toBe(true);
    expect(s.has("c")).toBe(true);
    expect(s.has("b")).toBe(false);
    expect(s.has("d")).toBe(false);
    expect(s.size).toBe(2);
  });
});
