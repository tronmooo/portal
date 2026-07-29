// net-worth-view is the ONE client derivation of the displayed balance sheet.
// Its contract: the headline total is the sum of the rows the user can see.
//
// It had no tests, and the Finance card had quietly stopped calling it —
// reading the server's raw `totalAssetValue` / `totalLiabilities` while
// rendering rows from `assetBreakdown`. Audit 2026-07-29 caught both halves of
// what that costs:
//
//   Tier 5 — synthetic QA rows ("Test Laptop QA", "__qa_cascade_test__ shared
//   obligation") were hidden from the LIST but still counted in the TOTAL, so
//   test data corrupted a real net worth.
//
//   D2 — the header could not be reconciled against the rows beneath it.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { netWorthView, isNetWorthLoaded } from "../client/src/lib/net-worth-view";

// A snapshot mixing real holdings with the QA rows the audit found on a live
// account, including the server totals that still count them.
const SNAPSHOT = {
  assetBreakdown: [
    { id: "a1", name: "House", type: "property", grossValue: 500000, share: 50, value: 250000 },
    { id: "a2", name: "Ford F150 2025", type: "vehicle", grossValue: 18500, share: 100, value: 18500 },
    { id: "a3", name: "Test Laptop QA", type: "asset", grossValue: 370, share: 50, value: 185 },
  ],
  liabilityBreakdown: [
    { id: "l1", name: "Mike's House Mortgage", type: "mortgage", grossValue: 348889, share: 50, value: 174444 },
    { id: "l2", name: "__qa_cascade_test__ shared obligation", type: "liability", grossValue: 100, share: 100, value: 100 },
  ],
  totalAssetValue: 268685,   // 250000 + 18500 + 185  ← includes the QA row
  totalLiabilities: 174544,  // 174444 + 100          ← includes the QA row
};

const REAL_ASSETS = 268500;      // without Test Laptop QA
const REAL_LIABILITIES = 174444; // without __qa_cascade_test__

describe("netWorthView", () => {
  it("keeps synthetic rows out of the TOTAL, not just out of the list", () => {
    const sheet = netWorthView(SNAPSHOT, /* showTestData */ false);
    expect(sheet.assets.map(a => a.name)).not.toContain("Test Laptop QA");
    // The point of the finding: hiding the row is not enough if the headline
    // still counts it.
    expect(sheet.totalAssets).toBe(REAL_ASSETS);
    expect(sheet.totalLiabilities).toBe(REAL_LIABILITIES);
    expect(sheet.netWorth).toBe(REAL_ASSETS - REAL_LIABILITIES);
  });

  it("never returns the server totals verbatim when they disagree with the rows", () => {
    const sheet = netWorthView(SNAPSHOT, false);
    expect(sheet.totalAssets).not.toBe(SNAPSHOT.totalAssetValue);
    expect(sheet.totalLiabilities).not.toBe(SNAPSHOT.totalLiabilities);
  });

  it("holds the header-equals-rows invariant in both toggle states", () => {
    for (const showTestData of [true, false]) {
      const sheet = netWorthView(SNAPSHOT, showTestData);
      const sumA = sheet.assets.reduce((s, r: any) => s + Number(r.value), 0);
      const sumL = sheet.liabilities.reduce((s, r: any) => s + Number(r.value), 0);
      expect(sheet.totalAssets, `assets @ showTestData=${showTestData}`).toBe(sumA);
      expect(sheet.totalLiabilities, `liabilities @ showTestData=${showTestData}`).toBe(sumL);
      expect(sheet.netWorth).toBe(sumA - sumL);
    }
  });

  it("shows the synthetic rows and counts them when the toggle is on", () => {
    const sheet = netWorthView(SNAPSHOT, true);
    expect(sheet.assets.map(a => a.name)).toContain("Test Laptop QA");
    expect(sheet.totalAssets).toBe(SNAPSHOT.totalAssetValue);
  });

  it("preserves grossValue and share so a row can explain its own number", () => {
    // D1: the balance sheet applies an ownership share, so a row must be able
    // to say "your 50% of $500,000" rather than an unexplained $250,000.
    const house: any = netWorthView(SNAPSHOT, false).assets.find((a: any) => a.id === "a1");
    expect(house.value).toBe(250000);
    expect(house.grossValue).toBe(500000);
    expect(house.share).toBe(50);
  });

  it("reports zeros for a missing snapshot rather than a fake $0 net worth", () => {
    const sheet = netWorthView(undefined, false);
    expect(sheet.totalAssets).toBe(0);
    expect(sheet.netWorth).toBe(0);
    // Callers must be able to tell "not loaded" from a real zero.
    expect(isNetWorthLoaded(undefined)).toBe(false);
    expect(isNetWorthLoaded(SNAPSHOT)).toBe(true);
  });
});

describe("every net-worth surface uses the one derivation", () => {
  // Reading the server's totals straight off the finance snapshot is exactly
  // how the Finance card drifted away from the Hero KPI tile and the Net Worth
  // popup: the rows got filtered, the headline did not.
  const SURFACES = [
    "client/src/pages/finance.tsx",
    "client/src/pages/dashboard.tsx",
    "client/src/components/dashboard/HeroKPIPopups.tsx",
    // The hub KPI strip renders directly above the Finance card. It was
    // missing from this list and subtracting the snapshot's raw totals, so a
    // browser check caught the two showing -80,586 and -80,771 on one screen
    // — the $185 difference being a single "Test Laptop QA" row.
    "client/src/components/hub/HubKpiStrip.tsx",
  ];

  /** Strip comments so prose ABOUT the old bug doesn't read as the bug. */
  function code(rel: string): string {
    return fs.readFileSync(path.join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  for (const rel of SURFACES) {
    it(`${rel} derives the balance sheet from netWorthView`, () => {
      expect(code(rel), `${rel} must import netWorthView`).toContain("netWorthView");
    });
  }

  it("no surface subtracts the snapshot totals to get a net worth", () => {
    // Local names derived FROM the view are fine; what must not reappear is a
    // read of `snap.totalAssetValue` / `snap.totalLiabilities` off the wire.
    for (const rel of ["client/src/pages/finance.tsx", "client/src/components/hub/HubKpiStrip.tsx"]) {
      expect(code(rel), rel).not.toMatch(/\bsnap(shot)?\s*[.?]\s*\.?\s*total(AssetValue|Liabilities)\b/);
    }
  });

  it("every net-worth surface agrees on the same snapshot", () => {
    // The concrete failure: two chips on one screen, $185 apart. Whatever the
    // surfaces do with it, they must start from this number.
    const expected = REAL_ASSETS - REAL_LIABILITIES;
    expect(netWorthView(SNAPSHOT, false).netWorth).toBe(expected);
    // …and NOT the figure a raw subtraction of the server totals produces.
    expect(SNAPSHOT.totalAssetValue - SNAPSHOT.totalLiabilities).not.toBe(expected);
  });
});
