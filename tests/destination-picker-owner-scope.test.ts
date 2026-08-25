// The attachment panel's "Belongs to" chips must only offer things the
// SELECTED owner actually owns.
//
// Reported bug: picking "Sarah Miller" still listed Assets (8), Liabilities
// (9), Vehicles (3), Investments (1) — the whole household's profiles — so a
// receipt filed under one of those chips landed on someone else's asset. The
// picker built its category map from every non-person profile and never looked
// at ownership at all.
//
// These tests pin the ownership rule the picker now uses
// (shared/scope.ts ownerChainForProfile + isInScope) and statically guard the
// picker against regressing to an unfiltered map.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ownerChainForProfile, isInScope, selfIdsFrom } from "../shared/scope";

const me = { id: "p-me", type: "self", parentProfileId: null };
const sarah = { id: "p-sarah", type: "person", parentProfileId: null };

const myTruck = { id: "a-truck", type: "vehicle", parentProfileId: "p-me" };
const sarahCar = { id: "a-car", type: "vehicle", parentProfileId: "p-sarah" };
const sarahHouse = { id: "a-house", type: "property", parentProfileId: "p-sarah" };
// Grandchild: the roof loan hangs off Sarah's house, not off Sarah directly.
const roofLoan = { id: "l-roof", type: "loan", parentProfileId: "a-house" };
// Orphan: nobody ever attributed it.
const orphanAccount = { id: "a-orphan", type: "account", parentProfileId: null };
// Co-owned via the link table only (no nesting pointer at all).
const jointBrokerage = { id: "a-joint", type: "investment", parentProfileId: null };

const profiles = [me, sarah, myTruck, sarahCar, sarahHouse, roofLoan, orphanAccount, jointBrokerage];
const assetLinks = [{ assetProfileId: "a-joint", partyProfileId: "p-sarah" }];
const selfIds = selfIdsFrom(profiles as any);

const belongsTo = (p: any, personId: string) =>
  isInScope(
    ownerChainForProfile(p, profiles as any, assetLinks, []),
    { selectedIds: [personId], selfIds },
    "belongs_to_self",
  );

describe("destination picker owner scoping", () => {
  it("shows only the selected person's things", () => {
    const sarahs = profiles
      .filter((p) => p.type !== "self" && p.type !== "person")
      .filter((p) => belongsTo(p, sarah.id))
      .map((p) => p.id)
      .sort();
    expect(sarahs).toEqual(["a-car", "a-house", "a-joint", "l-roof"]);
  });

  it("never leaks another person's asset into the list", () => {
    expect(belongsTo(myTruck, sarah.id)).toBe(false);
    expect(belongsTo(sarahCar, me.id)).toBe(false);
  });

  it("follows the whole nesting chain, not just the direct parent", () => {
    // Sarah → house → roof loan. The direct-parent-only predicate missed this.
    expect(belongsTo(roofLoan, sarah.id)).toBe(true);
    expect(belongsTo(roofLoan, me.id)).toBe(false);
  });

  it("counts co-ownership from the link table", () => {
    expect(belongsTo(jointBrokerage, sarah.id)).toBe(true);
  });

  it("keeps unattributed profiles under Self, not under everyone", () => {
    expect(belongsTo(orphanAccount, me.id)).toBe(true);
    expect(belongsTo(orphanAccount, sarah.id)).toBe(false);
  });

  it("is cycle-safe", () => {
    const a = { id: "x", type: "asset", parentProfileId: "y" };
    const b = { id: "y", type: "asset", parentProfileId: "x" };
    expect(() => ownerChainForProfile(a, [a, b] as any, [], [])).not.toThrow();
    expect(ownerChainForProfile(a, [a, b] as any, [], []).sort()).toEqual(["y"]);
  });
});

describe("chat.tsx picker wiring", () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "../client/src/pages/chat.tsx"),
    "utf8",
  );
  it("builds the category map through the ownership filter", () => {
    const block = SRC.slice(SRC.indexOf("const categories = useMemo"));
    const body = block.slice(0, block.indexOf("}, ["));
    expect(body).toContain("belongsToOwner(p, ownerId)");
  });
  it("drops a destination the newly-picked owner does not own", () => {
    expect(SRC).toContain("belongsToOwner(dest, o.id)");
  });
});
