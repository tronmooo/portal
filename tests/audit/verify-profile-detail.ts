/**
 * Deep audit of the profile-detail workflows — the densest page (ownership
 * links, asset↔liability collateral, co-owners, obligation payments, entity
 * links, and the relational read endpoints its tabs depend on). These are the
 * "broken button on a tab" candidates the CRUD harness didn't reach.
 *
 * Builds a real ownership graph, exercises every link/read/patch/pay endpoint,
 * verifies the effect, and tears it all down.
 *
 * Run: npx tsx tests/audit/verify-profile-detail.ts
 */
import { api } from "../smoke/fixture/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: string[] = [];
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { cond ? pass++ : fail++; out.push(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`); };

(async () => {
  const cleanup: (() => Promise<any>)[] = [];
  try {
    // --- build the graph: a person (owner), an asset, a liability ---
    const person = (await api("POST", "/profiles", { name: "PD Owner", type: "person", tags: [] })).data; await sleep(900);
    const asset = (await api("POST", "/profiles", { name: "PD Asset", type: "asset", fields: { currentValue: 100000 }, tags: [] })).data; await sleep(900);
    const liab = (await api("POST", "/profiles", { name: "PD Liab", type: "liability", fields: { balance: 40000 }, tags: [] })).data; await sleep(900);
    ok("create person/asset/liability", !!person?.id && !!asset?.id && !!liab?.id);
    if (person?.id) cleanup.push(() => api("DELETE", `/profiles/${person.id}`));
    if (asset?.id) cleanup.push(() => api("DELETE", `/profiles/${asset.id}`));
    if (liab?.id) cleanup.push(() => api("DELETE", `/profiles/${liab.id}`));

    // --- asset ↔ co-owner (real workflow: asset is auto 100% self-owned) ---
    // 1) Adding a co-owner on top of 100% must return a graceful 400 (was 500).
    const overflow = await api("POST", "/asset-party-links", { assetProfileId: asset.id, partyProfileId: person.id, ownershipPercentage: 50, role: "co_owner" }); await sleep(900);
    ok("add co-owner over 100% → graceful 400 (not 500)", overflow.status === 400, `status ${overflow.status}`);
    // 2) Rebalance the auto self-owner to 50%, then add the co-owner at 50% → succeeds.
    const autoLink = arr((await api("GET", `/assets/${asset.id}/parties`)).data).find((x: any) => Number(x.ownershipPercentage ?? x.ownership_percentage) === 100);
    let aplId: string | undefined;
    if (autoLink?.id) {
      await api("PATCH", `/asset-party-links/${autoLink.id}`, { ownershipPercentage: 50 }); await sleep(800);
      const apl = await api("POST", "/asset-party-links", { assetProfileId: asset.id, partyProfileId: person.id, ownershipPercentage: 50, role: "co_owner" }); await sleep(900);
      ok("add co-owner after rebalance → 200", apl.ok && !!apl.data?.id, `status ${apl.status}`);
      aplId = apl.data?.id;
    } else ok("find auto-owner link to rebalance", false);

    // --- liability ↔ owner (liability is auto 100% self-owned too) ---
    const lAuto = arr((await api("GET", `/liabilities/${liab.id}/parties`)).data).find((x: any) => Number(x.ownershipPercentage ?? x.ownership_percentage) === 100);
    let lplId: string | undefined;
    if (lAuto?.id) {
      await api("PATCH", `/liability-profile-links/${lAuto.id}`, { ownershipPercentage: 60 }); await sleep(800);
      const lpl = await api("POST", "/liability-profile-links", { liabilityProfileId: liab.id, partyProfileId: person.id, ownershipPercentage: 40, role: "co_signer" }); await sleep(900);
      ok("add liability co-owner after rebalance → 200", lpl.ok && !!lpl.data?.id, `status ${lpl.status}`);
      lplId = lpl.data?.id;
    } else ok("find auto liability-owner link", false);

    // --- liability ↔ asset (collateral) ---
    const lal = await api("POST", "/liability-asset-links", { liabilityProfileId: liab.id, assetProfileId: asset.id, ownershipPercentage: 100 }); await sleep(900);
    ok("link liability → asset (collateral)", lal.ok && !!lal.data?.id, `status ${lal.status}`);
    const lalId = lal.data?.id;

    // --- relational reads the tabs use ---
    const reads: [string, string, (d: any) => boolean][] = [
      ["assets/:id/parties", `/assets/${asset.id}/parties`, d => Array.isArray(arr(d)) && arr(d).some((x: any) => x.partyProfileId === person.id || x.party_profile_id === person.id || x.id === person.id)],
      ["parties/:id/assets", `/parties/${person.id}/assets`, d => arr(d).length >= 1],
      ["assets/:id/liabilities", `/assets/${asset.id}/liabilities`, d => arr(d).length >= 1],
      ["liabilities/:id/assets", `/liabilities/${liab.id}/assets`, d => arr(d).length >= 1],
      ["liabilities/:id/parties", `/liabilities/${liab.id}/parties`, d => arr(d).length >= 1],
      ["parties/:id/liabilities", `/parties/${person.id}/liabilities`, d => arr(d).length >= 1],
      ["profiles/:id/detail", `/profiles/${asset.id}/detail`, d => !!d && (d.id === asset.id || !!d.profile)],
      ["profiles/:id/tree", `/profiles/${person.id}/tree`, d => !!d],
      ["profile-bootstrap/:id", `/profile-bootstrap/${person.id}`, d => !!d],
    ];
    for (const [name, path, check] of reads) {
      const r = await api("GET", path);
      ok(`read ${name}`, r.ok && check(r.data), `status ${r.status}`);
      await sleep(250);
    }

    // --- edit ownership % (PATCH) — lower the co-owner to 30 (total 80, valid) ---
    if (aplId) {
      const pr = await api("PATCH", `/asset-party-links/${aplId}`, { ownershipPercentage: 30 }); await sleep(700);
      const back = arr((await api("GET", `/assets/${asset.id}/parties`)).data).find((x: any) => x.id === aplId);
      const val = back?.ownershipPercentage ?? back?.ownership_percentage;
      ok("edit ownership % → 30", pr.ok && Number(val) === 30, `got ${val}`);
    }

    // --- obligation pay workflow ---
    const obl = (await api("POST", "/obligations", { name: "PD Bill", amount: 60, frequency: "monthly", category: "bill", nextDueDate: "2026-07-01" })).data; await sleep(900);
    if (obl?.id) {
      cleanup.push(() => api("DELETE", `/obligations/${obl.id}`));
      const payr = await api("POST", `/obligations/${obl.id}/pay`, { amount: 60, date: "2026-07-01" }); await sleep(700);
      ok("pay obligation", payr.ok, `status ${payr.status}`);
    } else ok("create obligation to pay", false);

    // --- entity link/unlink an expense to the person ---
    const exp = (await api("POST", "/expenses", { description: "PD linked exp", amount: 5, category: "general", date: "2026-07-01", tags: [] })).data; await sleep(900);
    if (exp?.id) {
      cleanup.push(() => api("DELETE", `/expenses/${exp.id}`));
      const lk = await api("POST", `/profiles/${person.id}/link`, { entityType: "expense", entityId: exp.id }); await sleep(700);
      ok("link expense → profile", lk.ok, `status ${lk.status}`);
      const ulk = await api("POST", `/profiles/${person.id}/unlink`, { entityType: "expense", entityId: exp.id }); await sleep(500);
      ok("unlink expense → profile", ulk.ok, `status ${ulk.status}`);
    }

    // --- unlink the relational links (DELETE) ---
    if (lalId) { const d = await api("DELETE", `/liability-asset-links/${lalId}`); ok("unlink liability↔asset", d.ok || d.status === 204); await sleep(500); }
    if (lplId) { const d = await api("DELETE", `/liability-profile-links/${lplId}`); ok("unlink liability↔owner", d.ok || d.status === 204); await sleep(500); }
    if (aplId) { const d = await api("DELETE", `/asset-party-links/${aplId}`); ok("unlink asset↔owner", d.ok || d.status === 204); await sleep(500); }
  } catch (e: any) {
    ok("workflow threw", false, e?.message);
  } finally {
    for (const c of cleanup) { try { await c(); await sleep(400); } catch {} }
  }
  console.log("\n=== Profile-detail deep workflow audit ===\n" + out.join("\n"));
  console.log(`\n${pass} pass / ${fail} fail\n`);
})();

function arr(d: any): any[] { return Array.isArray(d) ? d : (d?.items || d?.data || []); }
