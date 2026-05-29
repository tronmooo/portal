/**
 * Part B — auto-ownership resolution (Jane Doe root-cause fix).
 *
 * The /api/profiles create handler runs a "default ownership to self" hook for
 * new assets/liabilities. The old hook only treated partyLinks/owners/
 * partyProfileId/ownerProfileId as explicit ownership and ignored
 * parentProfileId — but the AI expresses ownership by setting parentProfileId
 * to the person (or one of the person's child profiles). The result: every
 * person's asset/liability was force-linked to Self 100% and their net worth
 * read $0.
 *
 * resolveAutoOwner now treats a non-Self parent chain as explicit ownership.
 * These cases pin the four behaviors the fix must satisfy.
 */
import { describe, it, expect } from "vitest";
import { resolveAutoOwner, type AutoOwnerProfile } from "../shared/ownership";

const SELF = "self-id";
const JANE = "jane-id";
const JANE_HOUSE = "jane-house-id";
const ORPHAN_TREE_ROOT = "orphan-root-id";

const profiles: AutoOwnerProfile[] = [
  { id: SELF, type: "self", parentProfileId: null },
  { id: JANE, type: "person", parentProfileId: null },
  { id: JANE_HOUSE, type: "property", parentProfileId: JANE },
  // An orphan asset subtree whose root has no person/self ancestor.
  { id: ORPHAN_TREE_ROOT, type: "asset", parentProfileId: null },
];

describe("Part B — resolveAutoOwner", () => {
  it("case 1: no parent → Self (current behavior preserved)", () => {
    // The route fills parentProfileId=Self for parentless child types before
    // the hook runs; resolveAutoOwner(null, …) also returns Self directly.
    expect(resolveAutoOwner(null, profiles, SELF)).toBe(SELF);
    expect(resolveAutoOwner(SELF, profiles, SELF)).toBe(SELF);
  });

  it("case 2: parentProfileId = Jane (person) → link Jane, not Self", () => {
    expect(resolveAutoOwner(JANE, profiles, SELF)).toBe(JANE);
  });

  it("case 3: parentProfileId = Jane's house (property) → walk up to Jane, not Self", () => {
    expect(resolveAutoOwner(JANE_HOUSE, profiles, SELF)).toBe(JANE);
  });

  it("case 4: orphan parent chain (no person/self ancestor) → null, do NOT claim Self", () => {
    expect(resolveAutoOwner(ORPHAN_TREE_ROOT, profiles, SELF)).toBeNull();
  });

  it("is cycle-safe: A → B → A does not infinite-loop", () => {
    const cyclic: AutoOwnerProfile[] = [
      { id: "a", type: "asset", parentProfileId: "b" },
      { id: "b", type: "asset", parentProfileId: "a" },
    ];
    expect(resolveAutoOwner("a", cyclic, SELF)).toBeNull();
  });

  it("links Self when the chain is rooted at Self (asset under a Self-owned house)", () => {
    const selfHouse = "self-house-id";
    const tree: AutoOwnerProfile[] = [
      { id: SELF, type: "self", parentProfileId: null },
      { id: selfHouse, type: "property", parentProfileId: SELF },
    ];
    expect(resolveAutoOwner(selfHouse, tree, SELF)).toBe(SELF);
  });
});
