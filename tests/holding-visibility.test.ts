// Regression: the Assets tab and Net Worth must agree about a co-owned asset.
//
// Reported 2026-09-04 with one person (Bob) selected: the Net Worth popup
// listed "Radio · $75 · 50% owned" while the Assets tab said "No assets or
// vehicles yet". Radio is parented to ANOTHER person (John) and reaches Bob
// only through an asset_party_links row, so the tab's whole answer hung on
// that one extra request — while it is in flight, or if it fails, every
// co-owned holding vanishes from the tab and the empty state lies.

import { describe, it, expect } from "vitest";
import { isHoldingVisible, isOwnershipKnown } from "../client/src/lib/holding-visibility";

const JOHN = "john-hancock";
const BOB = "bob-robertson";
const RADIO = "radio";

const profiles = [
  { id: JOHN, parentProfileId: null },
  { id: BOB, parentProfileId: null },
  { id: RADIO, parentProfileId: JOHN },
];

// 50/50 between the two people; the parent link points at John only.
const assetLinks = [
  { assetProfileId: RADIO, partyProfileId: JOHN },
  { assetProfileId: RADIO, partyProfileId: BOB },
];

describe("co-owned asset visibility", () => {
  it("shows the asset under BOTH owners, not just the parent", () => {
    for (const owner of [JOHN, BOB]) {
      expect(isHoldingVisible({
        id: RADIO, parentId: JOHN, selectedIds: [owner], assetLinks, allProfiles: profiles,
      })).toBe(true);
    }
  });

  it("does not show it to someone who owns none of it", () => {
    expect(isHoldingVisible({
      id: RADIO, parentId: JOHN, selectedIds: ["someone-else"], assetLinks, allProfiles: profiles,
    })).toBe(false);
  });

  it("stays visible when the link table hasn't loaded but the server already scoped it", () => {
    // The exact reported state: the net-worth breakdown for Bob contains Radio,
    // the page's own asset_party_links fetch has not landed (or failed).
    expect(isHoldingVisible({
      id: RADIO, parentId: JOHN, selectedIds: [BOB], assetLinks: [], allProfiles: profiles,
      serverScopedIds: new Set([RADIO]),
    })).toBe(true);
  });

  it("an empty server breakdown never hides a holding the links prove", () => {
    expect(isHoldingVisible({
      id: RADIO, parentId: JOHN, selectedIds: [BOB], assetLinks, allProfiles: profiles,
      serverScopedIds: new Set<string>(),
    })).toBe(true);
  });

  it("no active selection shows everything", () => {
    expect(isHoldingVisible({ id: RADIO, parentId: JOHN, selectedIds: [] })).toBe(true);
  });

  it("co-ownership through a whole parent chain still counts", () => {
    // Radio nested under a container that Bob co-owns.
    const nested = [...profiles, { id: "shelf", parentProfileId: JOHN }];
    expect(isHoldingVisible({
      id: RADIO, parentId: "shelf", selectedIds: [JOHN], assetLinks: [], allProfiles: nested,
    })).toBe(true);
  });

  it("liabilities use the same rule via their own link table", () => {
    const liabilityLinks = [{ liabilityProfileId: "loan", partyProfileId: BOB }];
    expect(isHoldingVisible({
      id: "loan", parentId: JOHN, selectedIds: [BOB], liabilityLinks, allProfiles: profiles,
    })).toBe(true);
  });
});

describe("ownership readiness", () => {
  it("is unknown before either source has answered", () => {
    expect(isOwnershipKnown(false, new Set())).toBe(false);
  });

  it("is known once the links load, even when they are empty", () => {
    expect(isOwnershipKnown(true, new Set())).toBe(true);
  });

  it("is known when the server breakdown arrived first", () => {
    expect(isOwnershipKnown(false, new Set([RADIO]))).toBe(true);
  });
});
