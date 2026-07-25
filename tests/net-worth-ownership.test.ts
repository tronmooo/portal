// Pins the ownership-adjusted net-worth contract.
//
// QA report 2026-07-25:
//   "House: $250,000 in Finance but $500,000 in Assets.
//    Mike's mortgage: $174,444 in Finance but $348,888.89 in Liabilities.
//    This looks like ownership percentages are applied in one component but
//    ignored in another."
//
//   "KPI header: $1,398,804 / Net Worth pop-up: $1,398,954 — a $150
//    difference on the same screen."
import { describe, it, expect } from "vitest";
import { computeNetWorth, balanceSheetFromSnapshot } from "../shared/net-worth";

const SELF = "11111111-1111-4111-8111-111111111111";
const MIKE = "22222222-2222-4222-8222-222222222222";
const HOUSE = "33333333-3333-4333-8333-333333333333";
const MORTGAGE = "44444444-4444-4444-8444-444444444444";

const profiles = [
  { id: SELF, name: "Me", type: "self" },
  { id: MIKE, name: "Mike", type: "person" },
  { id: HOUSE, name: "House", type: "property", fields: { currentValue: 500000 } },
  { id: MORTGAGE, name: "Mike's mortgage", type: "liability", fields: { currentBalance: 348888.89 } },
];

// A 50/50 house and a 50/50 mortgage.
const ownership = {
  assetLinks: [
    { assetProfileId: HOUSE, partyProfileId: SELF, ownershipPercentage: 50, role: "owner" },
    { assetProfileId: HOUSE, partyProfileId: MIKE, ownershipPercentage: 50, role: "owner" },
  ],
  liabilityLinks: [
    { liabilityProfileId: MORTGAGE, partyProfileId: SELF, ownershipPercentage: 50, role: "owner" },
    { liabilityProfileId: MORTGAGE, partyProfileId: MIKE, ownershipPercentage: 50, role: "owner" },
  ],
  selfProfileId: SELF,
};

describe("computeNetWorth applies ownership shares", () => {
  it("attributes only Mike's half of a jointly-owned house and mortgage", () => {
    const nw = computeNetWorth(profiles, { mode: "selected", selectedIds: [MIKE], ownership });
    expect(nw.assets).toBe(250_000); // not 500,000
    expect(nw.liabilities).toBeCloseTo(174_444.445, 2); // not 348,888.89
    expect(nw.netWorth).toBeCloseTo(75_555.555, 2);
  });

  it("does not double-count a shared item across co-owners", () => {
    const mine = computeNetWorth(profiles, { mode: "selected", selectedIds: [SELF], ownership });
    const mike = computeNetWorth(profiles, { mode: "selected", selectedIds: [MIKE], ownership });
    const everyone = computeNetWorth(profiles, { mode: "everyone", selectedIds: [], ownership });
    expect(mine.assets + mike.assets).toBe(everyone.assets);
    expect(mine.liabilities + mike.liabilities).toBeCloseTo(everyone.liabilities, 6);
  });

  it("counts the whole household once under 'everyone'", () => {
    const nw = computeNetWorth(profiles, { mode: "everyone", selectedIds: [], ownership });
    expect(nw.assets).toBe(500_000);
    expect(nw.liabilities).toBeCloseTo(348_888.89, 2);
  });

  it("selecting the item itself shows its full value, not a share", () => {
    const nw = computeNetWorth(profiles, { mode: "selected", selectedIds: [HOUSE], ownership });
    expect(nw.assets).toBe(500_000);
  });

  it("falls back to Self owning 100% of an item with no explicit links", () => {
    const withOrphan = [
      ...profiles,
      { id: "55555555-5555-4555-8555-555555555555", name: "Laptop", type: "asset", parentProfileId: SELF, fields: { currentValue: 1000 } },
    ];
    const mine = computeNetWorth(withOrphan, { mode: "selected", selectedIds: [SELF], ownership });
    expect(mine.assets).toBe(250_000 + 1000);
    const mike = computeNetWorth(withOrphan, { mode: "selected", selectedIds: [MIKE], ownership });
    expect(mike.assets).toBe(250_000); // the unlinked laptop is not Mike's
  });

  it("emits per-row breakdowns that sum exactly to the headline totals", () => {
    const nw = computeNetWorth(profiles, { mode: "selected", selectedIds: [MIKE], ownership });
    expect(nw.assetRows.reduce((s, r) => s + r.value, 0)).toBe(nw.assets);
    expect(nw.liabilityRows.reduce((s, r) => s + r.value, 0)).toBeCloseTo(nw.liabilities, 6);
    const house = nw.assetRows.find(r => r.id === HOUSE)!;
    expect(house.grossValue).toBe(500_000);
    expect(house.share).toBe(50);
    expect(house.value).toBe(250_000);
  });

  it("keeps whole values when no ownership tables are supplied (household use)", () => {
    // Back-compat: callers computing an unfiltered household total need no
    // tables, and must not silently drop to a Self-only number.
    const nw = computeNetWorth(profiles, { mode: "selected", selectedIds: [MIKE] });
    expect(nw.assets).toBe(0); // Mike owns nothing via parent/id scope alone
    const everyone = computeNetWorth(profiles, { mode: "everyone", selectedIds: [] });
    expect(everyone.assets).toBe(500_000);
  });
});

describe("balanceSheetFromSnapshot — the header always equals the visible rows", () => {
  const snapshot = {
    totalAssetValue: 1_000_000,
    totalLiabilities: 500_000,
    assetBreakdown: [
      { id: "a1", name: "House", type: "property", grossValue: 999_815, share: 100, value: 999_815 },
      { id: "a2", name: "Test Laptop QA", type: "asset", grossValue: 185, share: 100, value: 185 },
    ],
    liabilityBreakdown: [
      { id: "l1", name: "Mortgage", type: "liability", grossValue: 499_850, share: 100, value: 499_850 },
      { id: "l2", name: "QA Test Loan", type: "liability", grossValue: 150, share: 100, value: 150 },
    ],
  };

  it("matches the server totals when nothing is hidden", () => {
    const sheet = balanceSheetFromSnapshot(snapshot);
    expect(sheet.totalAssets).toBe(1_000_000);
    expect(sheet.totalLiabilities).toBe(500_000);
    expect(sheet.netWorth).toBe(500_000);
  });

  it("re-sums after hiding rows — no $150 gap between header and list", () => {
    const isTest = (r: any) => /test|qa/i.test(r.name);
    const sheet = balanceSheetFromSnapshot(snapshot, isTest);
    expect(sheet.assets).toHaveLength(1);
    expect(sheet.liabilities).toHaveLength(1);
    expect(sheet.totalAssets).toBe(999_815);
    expect(sheet.totalLiabilities).toBe(499_850);
    // The reported symptom: dropping a $150 liability moved net worth by $150
    // in the popup while the KPI tile kept the server total.
    expect(sheet.netWorth).toBe(499_965);
    expect(sheet.assets.reduce((s, r) => s + r.value, 0)).toBe(sheet.totalAssets);
    expect(sheet.liabilities.reduce((s, r) => s + r.value, 0)).toBe(sheet.totalLiabilities);
  });

  it("reports zeros for a missing snapshot so callers can show a loading state", () => {
    const sheet = balanceSheetFromSnapshot(undefined);
    expect(sheet).toEqual({ assets: [], liabilities: [], totalAssets: 0, totalLiabilities: 0, netWorth: 0 });
  });
});
