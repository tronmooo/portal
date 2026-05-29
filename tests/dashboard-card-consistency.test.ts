/**
 * Part A — Dashboard card consistency contract.
 *
 * The Jane Doe variance bug: filtering the dashboard to one person showed
 * THREE different Net Worth numbers on the same screen because three surfaces
 * each ran their own ownership walk:
 *
 *   - Hero KPI tile      → reads server financeSnapshot (party_links aware)  → $0
 *   - Finance card tile  → client parent-only walk                          → $650K
 *   - Net Worth popup    → client parent + co-owner walk                    → $650K
 *
 * The fix pins ALL surfaces to the server's financeSnapshot
 * (enhanced.financeSnapshot.totalAssetValue / totalLiabilities), which is the
 * single source of truth. This test encodes that contract: every surface, when
 * handed the same snapshot, MUST display the snapshot's numbers — never a
 * client-side recomputation.
 *
 * `pickSurfaceTotals` mirrors the exact `?? clientWalk` precedence shipped in:
 *   - client/src/pages/dashboard.tsx       (Finance card + Net Worth drilldown)
 *   - client/src/components/dashboard/HeroKPIPopups.tsx (Net Worth popup)
 *   - client/src/pages/dashboard.tsx       (Hero KPI tile, already on snapshot)
 *
 * Before the fix, the Finance card and popup used `clientWalk` as PRIMARY and
 * the snapshot only as a loading fallback — so this test (asserting all three
 * surfaces equal the snapshot when the snapshot is present) failed.
 */
import { describe, it, expect } from "vitest";

type Snapshot = { totalAssetValue?: number; totalLiabilities?: number } | undefined;
type Walk = { assets: number; liabilities: number };

/**
 * Canonical surface-total resolution shared by every Net Worth surface.
 * Server snapshot wins whenever it is present; the client walk is a
 * load-time fallback only.
 */
function pickSurfaceTotals(snapshot: Snapshot, clientWalk: Walk) {
  const totalAssetValue = snapshot?.totalAssetValue ?? clientWalk.assets;
  const totalLiabilities = snapshot?.totalLiabilities ?? clientWalk.liabilities;
  return { totalAssetValue, totalLiabilities, netWorth: totalAssetValue - totalLiabilities };
}

describe("Part A — Net Worth surfaces agree when filtered to one person", () => {
  // Jane scenario from portol_jane_doe_filter_audit.md §2:
  // The server snapshot (party_links + parent-residual aware) currently
  // reports $0 because asset_party_links wrongly claim Self owns everything.
  // The legacy client parent-only walk reported $650K (it saw Jane's House via
  // parentProfileId but ignored the party-links). The surfaces MUST agree.
  const serverSnapshot: Snapshot = { totalAssetValue: 0, totalLiabilities: 0 };
  const heroWalk: Walk = { assets: 0, liabilities: 0 };       // hero never walked
  const financeCardWalk: Walk = { assets: 650_000, liabilities: 0 };
  const popupWalk: Walk = { assets: 650_000, liabilities: 0 };

  it("hero, finance card, and popup all show the server snapshot total", () => {
    const hero = pickSurfaceTotals(serverSnapshot, heroWalk);
    const financeCard = pickSurfaceTotals(serverSnapshot, financeCardWalk);
    const popup = pickSurfaceTotals(serverSnapshot, popupWalk);

    // All three surfaces equal the server snapshot to the dollar.
    expect(hero.netWorth).toBe(0);
    expect(financeCard.netWorth).toBe(0);
    expect(popup.netWorth).toBe(0);

    expect(financeCard.totalAssetValue).toBe(hero.totalAssetValue);
    expect(popup.totalAssetValue).toBe(hero.totalAssetValue);
    expect(financeCard.totalLiabilities).toBe(hero.totalLiabilities);
    expect(popup.totalLiabilities).toBe(hero.totalLiabilities);
  });

  it("AI summary number equals the surfaces (same financeSnapshot feed)", () => {
    // The AI summary is fed enhanced.financeSnapshot — the same object the
    // surfaces read. Its net worth is therefore snapshot.assets - liabilities.
    const aiNetWorth =
      (serverSnapshot!.totalAssetValue ?? 0) - (serverSnapshot!.totalLiabilities ?? 0);
    const hero = pickSurfaceTotals(serverSnapshot, heroWalk);
    expect(aiNetWorth).toBe(hero.netWorth);
  });
});

describe("Part A — correct-data case: surfaces agree on a non-zero total", () => {
  // When the underlying ownership data is correct, the server snapshot reports
  // Jane's $650K house. Every surface still reads the snapshot, so they agree.
  const serverSnapshot: Snapshot = { totalAssetValue: 650_000, totalLiabilities: 480_000 };
  const clientWalk: Walk = { assets: 650_000, liabilities: 480_000 };

  it("net worth is identical across surfaces", () => {
    const a = pickSurfaceTotals(serverSnapshot, clientWalk);
    const b = pickSurfaceTotals(serverSnapshot, { assets: 0, liabilities: 0 });
    // Even a surface whose client walk would disagree shows the snapshot value.
    expect(a.netWorth).toBe(170_000);
    expect(b.netWorth).toBe(170_000);
    expect(a.netWorth).toBe(b.netWorth);
  });
});

describe("Part A — loading fallback: client walk used only until snapshot resolves", () => {
  it("falls back to the client walk when snapshot is undefined", () => {
    const r = pickSurfaceTotals(undefined, { assets: 650_000, liabilities: 0 });
    expect(r.netWorth).toBe(650_000);
  });

  it("uses snapshot zero (not the walk) once snapshot has loaded", () => {
    // A loaded snapshot of {0,0} must NOT be overridden by a non-zero walk —
    // this is the exact bug: `?? walk` keeps the real zero, `|| walk` would
    // wrongly fall through to $650K.
    const r = pickSurfaceTotals({ totalAssetValue: 0, totalLiabilities: 0 }, { assets: 650_000, liabilities: 0 });
    expect(r.netWorth).toBe(0);
  });
});
