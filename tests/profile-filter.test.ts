import { describe, it, expect } from "vitest";
import {
  passesProfileFilter,
  selfInSelection,
  type ProfileFilterContext,
} from "../shared/profile-filter";

// Privacy access control: any silent regression here means users see each
// other's data. The two surfaces are (a) "is at least one selected profile a
// self profile?" and (b) "does an entity with this linkedProfiles list pass
// the filter?". We pin both, including the orphan rule.

const ALICE = { id: "alice", type: "self" } as const;
const BOB = { id: "bob", type: "person" } as const;
const CAR = { id: "car", type: "asset" } as const;
const PET = { id: "fido", type: "pet" } as const;
const BIZ = { id: "acme", type: "business" } as const;

const ALL = [ALICE, BOB, CAR, PET, BIZ];

const ctx = (selectedIds: string[], allProfiles = ALL): ProfileFilterContext => ({
  selectedIds,
  allProfiles,
});

describe("selfInSelection", () => {
  it("returns false on empty selection", () => {
    expect(selfInSelection(ctx([]))).toBe(false);
  });

  it("returns true when a selected id matches a self-typed profile", () => {
    expect(selfInSelection(ctx(["alice"]))).toBe(true);
    expect(selfInSelection(ctx(["bob", "alice"]))).toBe(true);
  });

  it("returns false when none of the selected ids are self profiles", () => {
    expect(selfInSelection(ctx(["bob"]))).toBe(false);
    expect(selfInSelection(ctx(["bob", "car", "fido", "acme"]))).toBe(false);
  });

  it("returns false when a selected id is missing from allProfiles", () => {
    // Unknown id → can't be self
    expect(selfInSelection(ctx(["ghost"]))).toBe(false);
  });

  it("does not treat person/pet/asset/business as self", () => {
    // Even though all of these are 'profile-like', only type==='self' qualifies.
    for (const t of ["person", "pet", "asset", "business", "liability", "vehicle"]) {
      const ctx2 = ctx(["x"], [{ id: "x", type: t }]);
      expect(selfInSelection(ctx2)).toBe(false);
    }
  });
});

describe("passesProfileFilter — no filter active", () => {
  it("returns true for any entity when selectedIds is empty", () => {
    expect(passesProfileFilter(["alice"], ctx([]))).toBe(true);
    expect(passesProfileFilter([], ctx([]))).toBe(true);
    expect(passesProfileFilter(undefined, ctx([]))).toBe(true);
    expect(passesProfileFilter(null, ctx([]))).toBe(true);
  });

  it("treats null/undefined selectedIds defensively as 'no filter'", () => {
    // Cast through any — JS callers could pass an undefined accidentally.
    const ctxBad = { selectedIds: undefined as any, allProfiles: ALL };
    expect(passesProfileFilter(["alice"], ctxBad)).toBe(true);
  });
});

describe("passesProfileFilter — linked entities", () => {
  it("passes when any linkedProfile is in the selection", () => {
    expect(passesProfileFilter(["bob"], ctx(["bob"]))).toBe(true);
    expect(passesProfileFilter(["bob", "fido"], ctx(["alice", "fido"]))).toBe(true);
  });

  it("blocks when no linkedProfile matches the selection", () => {
    expect(passesProfileFilter(["bob"], ctx(["alice"]))).toBe(false);
    expect(passesProfileFilter(["car"], ctx(["bob", "fido"]))).toBe(false);
  });

  it("does not let an orphan rule sneak in when linkedProfiles is non-empty", () => {
    // Even if a self profile is selected, an entity linked ONLY to non-selected
    // profiles must not pass — this is the cross-leak guard.
    expect(passesProfileFilter(["bob"], ctx(["alice"]))).toBe(false);
  });
});

describe("passesProfileFilter — orphan rule", () => {
  // An orphan is an entity with no linkedProfiles (legacy data pre-dating
  // profile linking, or items the user never tagged). The contract: orphans
  // only show up when the active selection includes a self profile.

  it("orphan passes when a self profile is in the selection", () => {
    expect(passesProfileFilter([], ctx(["alice"]))).toBe(true);
    expect(passesProfileFilter(undefined, ctx(["alice"]))).toBe(true);
    expect(passesProfileFilter(null, ctx(["alice"]))).toBe(true);
  });

  it("orphan is blocked when only non-self profiles are selected", () => {
    expect(passesProfileFilter([], ctx(["bob"]))).toBe(false);
    expect(passesProfileFilter(undefined, ctx(["bob"]))).toBe(false);
    expect(passesProfileFilter([], ctx(["fido", "car"]))).toBe(false);
  });

  it("orphan passes when at least one of several selected profiles is self", () => {
    expect(passesProfileFilter(undefined, ctx(["bob", "alice"]))).toBe(true);
  });

  it("orphan is blocked when the self profile isn't in allProfiles (bad state)", () => {
    // If the caller's allProfiles omits the selected id, we can't classify it
    // as self → fall through to "no self selected" branch.
    const ctxNoAlice = ctx(["alice"], [BOB, CAR]);
    expect(passesProfileFilter([], ctxNoAlice)).toBe(false);
  });
});

describe("passesProfileFilter — defensive parsing", () => {
  it("non-array linkedProfiles is treated as orphan", () => {
    // Server data sometimes arrives as a string or {} — must not crash and
    // must fall into the orphan branch (so it's gated by self-in-selection).
    expect(passesProfileFilter("alice" as any, ctx(["bob"]))).toBe(false);
    expect(passesProfileFilter("alice" as any, ctx(["alice"]))).toBe(true);
    expect(passesProfileFilter({} as any, ctx(["alice"]))).toBe(true);
    expect(passesProfileFilter(42 as any, ctx(["alice"]))).toBe(true);
  });

  it("empty linkedProfiles array is an orphan (not a 'no filter' bypass)", () => {
    // Critical: the function must distinguish "entity not linked to anyone"
    // (orphan) from "no filter applied" (selectedIds empty).
    expect(passesProfileFilter([], ctx(["bob"]))).toBe(false);
  });

  it("duplicate ids in linkedProfiles do not affect the decision", () => {
    expect(passesProfileFilter(["bob", "bob", "bob"], ctx(["bob"]))).toBe(true);
    expect(passesProfileFilter(["bob", "bob"], ctx(["alice"]))).toBe(false);
  });
});

describe("passesProfileFilter — cross-leak regression scenarios", () => {
  // Concrete scenarios that previously broke (per the comment block at the
  // top of profile-filter.ts: finance/calendar/dashboard disagreeing). Each
  // case here is a real-world cross-leak that must stay closed.

  it("selecting only Bob: Alice-only expense must not appear", () => {
    expect(passesProfileFilter(["alice"], ctx(["bob"]))).toBe(false);
  });

  it("selecting only Bob: shared Alice+Bob expense passes", () => {
    expect(passesProfileFilter(["alice", "bob"], ctx(["bob"]))).toBe(true);
  });

  it("selecting only Bob: legacy unlinked expense does NOT leak (no self)", () => {
    expect(passesProfileFilter([], ctx(["bob"]))).toBe(false);
  });

  it("selecting Alice (self): legacy unlinked expense shows ('belongs to me')", () => {
    expect(passesProfileFilter([], ctx(["alice"]))).toBe(true);
  });

  it("selecting Alice + Bob: items linked to either pass, plus orphans (Alice is self)", () => {
    const c = ctx(["alice", "bob"]);
    expect(passesProfileFilter(["alice"], c)).toBe(true);
    expect(passesProfileFilter(["bob"], c)).toBe(true);
    expect(passesProfileFilter(["fido"], c)).toBe(false); // not selected
    expect(passesProfileFilter([], c)).toBe(true); // orphan + Alice is self
  });

  it("selecting only a pet profile: nothing orphan leaks", () => {
    expect(passesProfileFilter([], ctx(["fido"]))).toBe(false);
    expect(passesProfileFilter(["alice"], ctx(["fido"]))).toBe(false);
    expect(passesProfileFilter(["fido"], ctx(["fido"]))).toBe(true);
  });

  it("selecting only a business profile: nothing orphan leaks", () => {
    expect(passesProfileFilter([], ctx(["acme"]))).toBe(false);
    expect(passesProfileFilter(["acme"], ctx(["acme"]))).toBe(true);
  });

  // PRODUCTION BUG (profile-context-isolation): user filtered to their self
  // profile ("Test") and saw "Groceries - Bob" / "Drugs - Bob". Root cause was
  // the AI linking those to self instead of Bob; once correctly linked to Bob,
  // they MUST NOT appear under the self filter. Pin that exactly.
  it("selecting self only: an expense correctly linked to Bob stays hidden", () => {
    expect(passesProfileFilter(["bob"], ctx(["alice"]))).toBe(false);
  });

  it("selecting self only: the user's own (self-linked) expense shows", () => {
    expect(passesProfileFilter(["alice"], ctx(["alice"]))).toBe(true);
  });
});
