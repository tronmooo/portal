/**
 * Pure unit tests pinning the CANONICAL profile-filter semantics — no server,
 * no network. If these fail, somebody changed the orphan rule in
 * shared/profile-filter.ts / shared/scope.ts, and every list endpoint and
 * client page that filters by profile changes behavior with it.
 *
 * The documented contract (shared/profile-filter.ts):
 *   - Empty selection ("everyone") — everything passes.
 *   - Active selection — an entity passes iff any of its linkedProfiles is in
 *     the selection.
 *   - Orphans (no linkedProfiles) belong to "me": they pass ONLY when the
 *     selection includes a self-type profile (`belongs_to_self` policy).
 *
 * Fixture: one self profile + two person profiles, entities with
 * linkedProfiles [], [A], [A,B]. Matrix asserted for selections:
 * everyone, [self], [A], [A,B], [B].
 */
import { describe, it, expect } from "vitest";
import { passesProfileFilter, selfInSelection, type ProfileFilterContext } from "@shared/profile-filter";
import { isInScope, selfIdsFrom, ownerCandidatesForProfile } from "@shared/scope";

const SELF = "profile-self";
const A = "profile-a";
const B = "profile-b";

const allProfiles = [
  { id: SELF, type: "self" },
  { id: A, type: "person" },
  { id: B, type: "person" },
];

const ctx = (selectedIds: string[]): ProfileFilterContext => ({ selectedIds, allProfiles });

// Entities under test, by their linkedProfiles value:
const ORPHAN: string[] = [];
const LINKED_A = [A];
const LINKED_AB = [A, B];

describe("contract: canonical profile-filter semantics (shared/profile-filter + shared/scope)", () => {
  it("everyone-mode (empty selection): everything passes, including orphans", () => {
    expect(passesProfileFilter(ORPHAN, ctx([]))).toBe(true);
    expect(passesProfileFilter(LINKED_A, ctx([]))).toBe(true);
    expect(passesProfileFilter(LINKED_AB, ctx([]))).toBe(true);
  });

  it("selection [self]: orphans pass (belong to me); linked entities do not", () => {
    expect(passesProfileFilter(ORPHAN, ctx([SELF]))).toBe(true);
    expect(passesProfileFilter(LINKED_A, ctx([SELF]))).toBe(false);
    expect(passesProfileFilter(LINKED_AB, ctx([SELF]))).toBe(false);
  });

  it("selection [A]: orphans hidden (no self selected); A-linked entities pass", () => {
    expect(passesProfileFilter(ORPHAN, ctx([A]))).toBe(false);
    expect(passesProfileFilter(LINKED_A, ctx([A]))).toBe(true);
    expect(passesProfileFilter(LINKED_AB, ctx([A]))).toBe(true);
  });

  it("selection [A,B]: orphans still hidden; any-intersection passes", () => {
    expect(passesProfileFilter(ORPHAN, ctx([A, B]))).toBe(false);
    expect(passesProfileFilter(LINKED_A, ctx([A, B]))).toBe(true);
    expect(passesProfileFilter(LINKED_AB, ctx([A, B]))).toBe(true);
  });

  it("selection [B]: only entities linked to B pass", () => {
    expect(passesProfileFilter(ORPHAN, ctx([B]))).toBe(false);
    expect(passesProfileFilter(LINKED_A, ctx([B]))).toBe(false);
    expect(passesProfileFilter(LINKED_AB, ctx([B]))).toBe(true);
  });

  it("selection [self, A]: orphans pass via self AND A-linked entities pass", () => {
    expect(passesProfileFilter(ORPHAN, ctx([SELF, A]))).toBe(true);
    expect(passesProfileFilter(LINKED_A, ctx([SELF, A]))).toBe(true);
    expect(passesProfileFilter(LINKED_AB, ctx([SELF, A]))).toBe(true);
  });

  it("legacy rows: undefined/null linkedProfiles behave exactly like []", () => {
    for (const legacy of [undefined, null] as const) {
      expect(passesProfileFilter(legacy, ctx([]))).toBe(true);
      expect(passesProfileFilter(legacy, ctx([SELF]))).toBe(true);
      expect(passesProfileFilter(legacy, ctx([A]))).toBe(false);
    }
  });

  it("selfInSelection: true only when an active selection includes a self profile", () => {
    expect(selfInSelection(ctx([]))).toBe(false); // empty selection is NOT self
    expect(selfInSelection(ctx([SELF]))).toBe(true);
    expect(selfInSelection(ctx([A]))).toBe(false);
    expect(selfInSelection(ctx([A, SELF]))).toBe(true);
  });

  it("selfIdsFrom extracts exactly the self-type profile ids", () => {
    expect([...selfIdsFrom(allProfiles)]).toEqual([SELF]);
    expect(selfIdsFrom([]).size).toBe(0);
  });

  describe("isInScope primitive (shared/scope.ts)", () => {
    const scopeCtx = (selectedIds: string[]) => ({ selectedIds, selfIds: new Set([SELF]) });

    it("default orphan policy is belongs_to_self — matches passesProfileFilter", () => {
      expect(isInScope([], scopeCtx([SELF]))).toBe(true);
      expect(isInScope([], scopeCtx([A]))).toBe(false);
      expect(isInScope([A], scopeCtx([A]))).toBe(true);
    });

    it("out_of_scope policy: orphans NEVER pass an active filter, even for self", () => {
      expect(isInScope([], scopeCtx([SELF]), "out_of_scope")).toBe(false);
      expect(isInScope([], scopeCtx([A]), "out_of_scope")).toBe(false);
      // ...but the empty-selection = everyone rule still wins:
      expect(isInScope([], { selectedIds: [], selfIds: new Set([SELF]) }, "out_of_scope")).toBe(true);
    });

    it("non-string / empty candidate ids are ignored (treated as orphan)", () => {
      expect(isInScope([null, undefined, ""], scopeCtx([A]))).toBe(false);
      expect(isInScope([null, A], scopeCtx([A]))).toBe(true);
    });
  });

  it("ownerCandidatesForProfile: id + parent + co-owner links, in scope via out_of_scope policy", () => {
    const profile = { id: A, parentProfileId: SELF };
    const assetLinks = [
      { assetProfileId: A, partyProfileId: B },
      { assetProfileId: "other", partyProfileId: "stranger" },
    ];
    expect(ownerCandidatesForProfile(profile, assetLinks, [])).toEqual([A, SELF, B]);
    // Co-owner B selecting "their" filter sees A's asset:
    expect(
      isInScope(ownerCandidatesForProfile(profile, assetLinks, []), { selectedIds: [B], selfIds: new Set([SELF]) }, "out_of_scope"),
    ).toBe(true);
  });
});
