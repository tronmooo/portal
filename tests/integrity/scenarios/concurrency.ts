// Concurrent writes to one record, against a real database (isolated stack).
import { scenario } from "../framework";

scenario({
  id: "concurrency.owner-set-replace",
  title: "Two different ownership saves for one asset at the same moment: the stored set is exactly one of them, never a mix or the old one",
  area: "hardening",
  covers: ["asset.transfer.api"],
  requires: ["action", "db", "derived"],
  isolatedOnly: true,
  run: async (ctx) => {
    const mk = async (body: any) => { const r = await ctx.api("POST", "/profiles", body); if (!r.ok) throw new Error(`create: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); ctx.cleanup(() => ctx.api("DELETE", `/profiles/${r.data.id}`)); return r.data; };
    const a = await mk({ type: "person", name: `${ctx.tag} Ari`, fields: {} });
    const b = await mk({ type: "person", name: `${ctx.tag} Bo`, fields: {} });
    const asset = await mk({ type: "asset", name: `${ctx.tag} Kayak`, fields: { currentValue: 1000, purchasePrice: 1200 } });
    const setA = [{ partyProfileId: a.id, ownershipPercentage: 70 }, { partyProfileId: b.id, ownershipPercentage: 30 }];
    const setB = [{ partyProfileId: a.id, ownershipPercentage: 25 }, { partyProfileId: b.id, ownershipPercentage: 75 }];
    const key = (rows: any[]) => rows.map((r) => `${r.party_profile_id ?? r.partyProfileId}:${Number(r.ownership_percentage ?? r.ownershipPercentage)}`).sort().join(",");
    const want = new Set([key(setA.map((o) => ({ partyProfileId: o.partyProfileId, ownershipPercentage: o.ownershipPercentage }))), key(setB)]);
    let mixed = 0, refusedBoth = 0, answeredButLost = 0;
    const ROUNDS = 8;
    for (let i = 0; i < ROUNDS; i++) {
      const [ra, rb] = await Promise.all([ctx.api("PUT", `/profiles/${asset.id}/owners`, { owners: setA }), ctx.api("PUT", `/profiles/${asset.id}/owners`, { owners: setB })]);
      const rows = (await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${asset.id}`)).filter((r: any) => ["owner", "co_owner", "co-owner"].includes(String(r.role || "owner")));
      const stored = key(rows);
      const sum = rows.reduce((s: number, r: any) => s + Number(r.ownership_percentage), 0);
      if (!want.has(stored) || Math.abs(sum - 100) > 0.01) mixed++;
      if (!ra.ok && !rb.ok) refusedBoth++;
      // the last ANSWERED 200 must be what is stored: a 200 whose set is not stored is a lost write
      const okSets = [ra.ok ? key(setA) : null, rb.ok ? key(setB) : null].filter(Boolean);
      if (okSets.length === 1 && stored !== okSets[0]) answeredButLost++;
      ctx.step(`round ${i + 1}: ${ra.status}/${rb.status} → stored ${stored} (sum ${sum})`);
    }
    ctx.check("db", mixed === 0, `${ROUNDS} rounds: the stored owner set is always exactly one of the two sets, summing to 100%`, `${mixed} round(s) stored a mix or something else`);
    ctx.check("action", refusedBoth === 0, "a round never refuses both saves");
    ctx.check("db", answeredButLost === 0, "when only one save was accepted, that is the set stored", `${answeredButLost} round(s) lost an accepted save`);
    const final = (await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${asset.id}`));
    const aShare = Number(final.find((r: any) => r.party_profile_id === a.id)?.ownership_percentage ?? 0) / 100;
    ctx.check("derived", aShare === 0.7 || aShare === 0.25, `Ari's share is one of the saved shares (${aShare * 100}%), so Ari's scoped value is ${aShare * 1000}`);
  },
});
