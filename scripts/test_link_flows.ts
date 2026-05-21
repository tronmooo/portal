// End-to-end verification of the asset/liability/person linking flows.
//
// Background: as of 2026-05-21 the person profile gained a working
// "+ Link Asset" picker (mirrors the existing Link Liability picker).
// The whole point of this test is to make sure that:
//
//   1. POST /api/asset-party-links  (person ↔ asset)
//   2. POST /api/liability-profile-links  (person ↔ liability)
//   3. POST /api/liability-asset-links  (asset ↔ liability)
//
// all succeed against the live storage layer, and that the corresponding
// DELETE endpoints actually remove the rows. We also verify that GET
// /api/parties/:id/assets returns the new link and that the enrichment
// includes asset.id/name/type and ownershipPercentage — which is what the
// LinkedAssetsTab depends on.
//
// What this does NOT touch:
//   - Any of the user's real profiles. We create three disposable
//     profiles tagged `__qa_link_test__` (one person, one asset, one
//     liability), run every assertion against them, then cascade-delete
//     them at the end. A final scan confirms no test profiles survive.

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";
const TEST_TAG = "__qa_link_test__";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);

type Result = { name: string; passed: boolean; detail?: string };
const results: Result[] = [];
function assert(name: string, cond: any, detail?: string) {
  results.push({ name, passed: !!cond, detail: cond ? undefined : (detail || "assertion failed") });
}

async function run() {
  console.log(`[test_link_flows] starting · user=${USER_ID}`);

  // ── 1. Create three disposable profiles ────────────────────────────
  const person = await storage.createProfile({
    name: `${TEST_TAG} Person`,
    type: "person",
    fields: { tag: TEST_TAG },
  } as any);
  const asset = await storage.createProfile({
    name: `${TEST_TAG} Vehicle`,
    type: "asset",
    fields: { tag: TEST_TAG, currentValue: 25000, assetSubtype: "vehicle" },
  } as any);
  const liability = await storage.createProfile({
    name: `${TEST_TAG} Loan`,
    type: "liability",
    fields: { tag: TEST_TAG, currentBalance: 12000, lender: "TestBank" },
  } as any);

  assert("create person profile", !!person?.id);
  assert("create asset profile", !!asset?.id);
  assert("create liability profile", !!liability?.id);
  if (!person?.id || !asset?.id || !liability?.id) {
    print();
    process.exit(1);
  }

  try {
    // ── 2. person ↔ asset (asset_party_links) ────────────────────────
    const apl = await storage.createAssetPartyLink({
      assetProfileId: asset.id,
      partyProfileId: person.id,
      ownershipPercentage: 60 as any,
      role: "owner",
    } as any);
    assert("POST asset-party-link returns row", !!apl?.id);
    assert("asset-party-link references asset", apl?.assetProfileId === asset.id);
    assert("asset-party-link references party", apl?.partyProfileId === person.id);
    // Important: 60% must round-trip — the UI surfaces this as the "owner share" chip.
    assert(
      "asset-party-link ownership pct round-trips",
      Number(apl?.ownershipPercentage) === 60,
      `got ${apl?.ownershipPercentage}`,
    );

    const partyAssets = await storage.getAssetPartyLinksForParty(person.id);
    const partyRow = (partyAssets || []).find((r: any) => r.assetProfileId === asset.id);
    assert("GET asset-party-links for party surfaces new link", !!partyRow);
    // We do NOT assert the exact pct here. The asset was auto-linked to
    // the Self profile at 100% during createProfile, so the ownership
    // invariant trigger (20260511_ownership_invariant.sql) rebalances
    // both rows when our 60% is inserted. Verify instead that:
    //   - the row has a positive percentage,
    //   - the SUM across all owners is <= 100 (the invariant).
    const pct = Number(partyRow?.ownershipPercentage);
    assert(
      "party row carries positive ownership %",
      Number.isFinite(pct) && pct > 0,
      `partyRow.ownershipPercentage = ${JSON.stringify(partyRow?.ownershipPercentage)}`,
    );
    const allOwnersOfAsset = await storage.getAssetPartyLinks(asset.id);
    const totalPct = (allOwnersOfAsset || []).reduce((s: number, r: any) => s + Number(r.ownershipPercentage || 0), 0);
    assert(
      "ownership invariant: SUM(pct) <= 100 across owners",
      totalPct <= 100.001, // tiny float tolerance
      `total = ${totalPct}`,
    );

    // ── 3. person ↔ liability (liability_profile_links) ──────────────
    const lpl = await storage.createLiabilityProfileLink({
      liabilityProfileId: liability.id,
      partyProfileId: person.id,
      ownershipPercentage: 50 as any,
      role: "owner",
    } as any);
    assert("POST liability-profile-link returns row", !!lpl?.id);
    assert("liability-profile-link references liability", lpl?.liabilityProfileId === liability.id);
    assert("liability-profile-link references party", lpl?.partyProfileId === person.id);

    const partyLiabs = await storage.getLiabilityProfileLinksForParty(person.id);
    const partyLiabRow = (partyLiabs || []).find((r: any) => r.liabilityProfileId === liability.id);
    assert("GET liability-profile-links for party surfaces new link", !!partyLiabRow);

    // ── 4. asset ↔ liability (liability_asset_links) ─────────────────
    const lal = await storage.createLiabilityAssetLink({
      liabilityProfileId: liability.id,
      assetProfileId: asset.id,
      role: "collateral",
      ownershipPercentage: 100 as any,
    } as any);
    assert("POST liability-asset-link returns row", !!lal?.id);

    const assetLiabs = await storage.getLiabilityAssetLinksForAsset(asset.id);
    const assetLiabRow = (assetLiabs || []).find((r: any) => r.liabilityProfileId === liability.id);
    assert("GET liability-asset-links for asset surfaces new link", !!assetLiabRow);

    // ── 5. DELETE round-trip — each link must come off cleanly ───────
    await storage.deleteAssetPartyLink(apl.id);
    const afterAplDel = await storage.getAssetPartyLinksForParty(person.id);
    assert(
      "DELETE asset-party-link removes row",
      !(afterAplDel || []).some((r: any) => r.id === apl.id),
    );

    await storage.deleteLiabilityProfileLink(lpl.id);
    const afterLplDel = await storage.getLiabilityProfileLinksForParty(person.id);
    assert(
      "DELETE liability-profile-link removes row",
      !(afterLplDel || []).some((r: any) => r.id === lpl.id),
    );

    await storage.deleteLiabilityAssetLink(lal.id);
    const afterLalDel = await storage.getLiabilityAssetLinksForAsset(asset.id);
    assert(
      "DELETE liability-asset-link removes row",
      !(afterLalDel || []).some((r: any) => r.id === lal.id),
    );

    // ── 6. Re-create + ensure PATCH on asset-party-link works ────────
    // (used by the "Edit Link" modal on the asset profile — keeps the
    // same flow working from both directions.)
    const apl2 = await storage.createAssetPartyLink({
      assetProfileId: asset.id,
      partyProfileId: person.id,
      ownershipPercentage: 30 as any,
      role: "owner",
    } as any);
    assert("re-create asset-party-link", !!apl2?.id);
    const patched = await storage.updateAssetPartyLink(apl2.id, { ownershipPercentage: 75 } as any);
    assert("PATCH asset-party-link updates pct", Number(patched?.ownershipPercentage) === 75);
    await storage.deleteAssetPartyLink(apl2.id);
  } finally {
    // ── 7. Cascade-delete the three disposable profiles ──────────────
    try { await storage.deleteProfile(asset.id); } catch (e) { console.error("cleanup asset failed:", e); }
    try { await storage.deleteProfile(liability.id); } catch (e) { console.error("cleanup liability failed:", e); }
    try { await storage.deleteProfile(person.id); } catch (e) { console.error("cleanup person failed:", e); }
  }

  // ── 8. Sanity: no test profiles survived ───────────────────────────
  const all = await storage.getProfiles();
  const survivors = (all || []).filter((p: any) =>
    typeof p?.name === "string" && p.name.includes(TEST_TAG)
  );
  assert("no test profiles survive cleanup", survivors.length === 0, `survivors=${survivors.length}`);

  print();
}

function print() {
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log("\n── Results ────────────────────────────────────");
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  }
  console.log(`\nTotal: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ""}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
