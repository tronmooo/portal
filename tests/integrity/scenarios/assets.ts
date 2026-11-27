// Assets: depreciation, salvage, the optimal disposal point, nesting, cost of
// ownership, shared ownership and what a deleted person leaves behind.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";
import { snapshot } from "./money";

const lifecycleOf = async (ctx: Ctx, id: string) => {
  const d = must(await ctx.api("GET", "/assets/lifecycle"), "lifecycle");
  const row = listOf(d).find((r: any) => r.profileId === id);
  if (!row) throw new Error(`no lifecycle row for ${id}`);
  return row;
};
const mk = async (ctx: Ctx, body: any) => {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}`));
  return p;
};

scenario({
  id: "assets.lifecycle",
  title: "Depreciation, salvage and the optimal disposal point hold together, and follow an edit",
  area: "Asset lifecycle",
  covers: ["asset.create.api", "asset.edit.api", "asset.salvage.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const price = ctx.int(30, 55) * 1000;
    const value = price - ctx.int(8, 20) * 1000;
    const bought = O.addMonthsAnchored(ctx.today, -ctx.int(24, 60));
    const car = await mk(ctx, { type: "vehicle", name: `${ctx.tag} Sedan`, fields: { currentValue: value, purchasePrice: price, purchaseDate: bought, year: 2022, make: "Honda", model: "Accord" } });
    const row = await lifecycleOf(ctx, car.id);
    const lc = row.lifecycle;
    ctx.check("action", lc.applicable === true && lc.valueModel === "depreciating", "the lifecycle treats a car as depreciating", JSON.stringify({ a: lc.applicable, m: lc.valueModel }));
    ctx.near("derived", lc.currentValue, value, "current value is the stored value");
    ctx.near("derived", lc.accumulatedDepreciation, O.accumulatedDepreciation(price, value), "accumulated depreciation = purchase price − current value");
    const wantAge = (O.dayNumber(ctx.today) - O.dayNumber(bought)) / 365.25;
    ctx.check("derived", Math.abs(lc.ageYears - wantAge) <= 0.06, `age is ${wantAge.toFixed(1)} years`, `got ${lc.ageYears}`);
    ctx.near("derived", lc.valueIn12m, value - lc.depreciationNext12m, "value in a year = value − next year's depreciation", 1);
    ctx.check("derived", lc.depreciationNext12m > 0 && lc.depreciationNext12m < value, "next year's depreciation is positive and less than the whole value", String(lc.depreciationNext12m));

    const od = lc.optimalDisposal, salvage = lc.salvage?.value;
    ctx.check("derived", !!od && typeof salvage === "number", "a depreciating asset has both an optimal disposal point and a salvage value");
    if (od && typeof salvage === "number") {
      const okDiff = ctx.check("derived", od.valueAt > salvage * 1.05, `the optimal disposal value (${od.valueAt}) is not the salvage value (${salvage})`);
      if (!okDiff) ctx.finding({ severity: "discrepancy", title: "Optimal disposal value equals the salvage value", detail: `disposal ${od.valueAt}, salvage ${salvage}` });
      ctx.check("derived", od.valueAt <= value && od.valueAt > 0, "the disposal value is between zero and today's value", `${od.valueAt} vs ${value}`);
      ctx.check("derived", od.date > ctx.today.slice(0, 7), "the disposal date is in the future", String(od.date));
      ctx.check("derived", od.netProceeds <= od.valueAt, "net proceeds never exceed the sale value (selling costs)", `${od.netProceeds} vs ${od.valueAt}`);
      ctx.check("derived", od.range.valueLow <= od.valueAt && od.valueAt <= od.range.valueHigh && od.range.dateLow <= od.date && od.date <= od.range.dateHigh, "the point sits inside its own range", JSON.stringify(od.range));
      ctx.near("derived", od.projectedDepreciation, value - od.valueAt, "projected depreciation = today's value − disposal value", 1);
      const sched = (od.schedule || []).map((s: any) => s.value);
      ctx.check("derived", sched.length >= 3 && sched.every((v: number, i: number) => i === 0 || v < sched[i - 1]) && sched[0] < value, "the resale schedule falls every year from today's value", JSON.stringify(sched));
      ctx.near("derived", sched[0], lc.valueIn12m, "the schedule's first year is the lifecycle's 12-month value (one projection)", 1);
      const months = Math.round((O.dayNumber(od.date) - O.dayNumber(ctx.today)) / 30.4375);
      ctx.check("derived", Math.abs(months - od.monthsFromNow) <= 1, `"months from now" (${od.monthsFromNow}) matches the date`, `date implies ${months}`);
    }
    const proj = (lc.projection || []).map((p: any) => p.value);
    ctx.check("derived", proj.length > 12 && Math.abs(proj[0] - value) <= 1 && proj.every((v: number, i: number) => i === 0 || v <= proj[i - 1] + 0.5), "the projection starts at today's value and never rises", JSON.stringify(proj.slice(0, 4)));
    ctx.check("derived", typeof salvage !== "number" || proj[proj.length - 1] >= salvage - 1, "the projection never goes below the salvage value", `${proj[proj.length - 1]} vs ${salvage}`);

    // an edit moves every dependent figure
    must(await ctx.api("PATCH", `/profiles/${car.id}`, { fields: { currentValue: value - 3000 } }), "revalue");
    const lc2 = (await lifecycleOf(ctx, car.id)).lifecycle;
    ctx.near("derived", lc2.accumulatedDepreciation, O.accumulatedDepreciation(price, value - 3000), "after lowering the value by 3,000, accumulated depreciation rose by 3,000");
    ctx.check("derived", lc2.optimalDisposal?.currentValue === value - 3000, "the disposal model re-read today's value", String(lc2.optimalDisposal?.currentValue));
    ctx.same("db", (await ctx.db.row("profiles", car.id)).fields.currentValue, value - 3000, "stored value");

    // a salvage value the user types is theirs
    must(await ctx.api("PATCH", `/profiles/${car.id}`, { fields: { salvageValue: 4321 } }), "type salvage");
    const lc3 = (await lifecycleOf(ctx, car.id)).lifecycle;
    ctx.check("derived", lc3.salvage?.value === 4321 && lc3.salvage?.source === "user", "a typed salvage value is used and marked as the user's", JSON.stringify(lc3.salvage));
    ctx.check("derived", !lc3.optimalDisposal || lc3.optimalDisposal.valueAt > 4321, "the optimal disposal value stays above the typed salvage value", String(lc3.optimalDisposal?.valueAt));
    const sRow = (await ctx.db.row("profiles", car.id)).fields;
    ctx.check("db", sRow.salvageValue === 4321 && sRow.salvageValueSource === "user", "the row stores the figure with its provenance", JSON.stringify({ v: sRow.salvageValue, s: sRow.salvageValueSource }));
    must(await ctx.api("PATCH", `/profiles/${car.id}`, { fields: { salvageValue: null } }), "remove salvage");
    const lc4 = (await lifecycleOf(ctx, car.id)).lifecycle;
    ctx.check("derived", lc4.salvage?.source !== "user" && lc4.salvage?.value !== 4321, "removing it hands the salvage value back to the engine", JSON.stringify(lc4.salvage));

    // something that gains value has no disposal point
    const house = await mk(ctx, { type: "property", name: `${ctx.tag} Cabin`, fields: { currentValue: 310000, purchasePrice: 250000, purchaseDate: "2019-06-01" } });
    const hl = (await lifecycleOf(ctx, house.id)).lifecycle;
    ctx.check("derived", hl.valueModel === "appreciating" && hl.optimalDisposal === null, "a property gains value and has no optimal disposal point", JSON.stringify({ m: hl.valueModel, o: hl.optimalDisposal && "set" }));
    ctx.check("derived", hl.depreciationNext12m <= 0 && hl.valueIn12m >= 310000, "its value a year out is not lower", `${hl.valueIn12m}`);
  },
});

scenario({
  id: "assets.nested-and-costs",
  title: "A nested asset counts once; an expense belongs to the deepest asset it names; loan payments are not upkeep",
  area: "Nested assets & cost of ownership",
  covers: ["asset.nest.api", "asset.transfer.api", "expense.link.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const camera = await mk(ctx, { type: "asset", name: `${ctx.tag} Camera`, fields: { currentValue: 2400, purchasePrice: 3000, purchaseDate: "2024-03-01" } });
    const lens = await mk(ctx, { type: "asset", name: `${ctx.tag} Lens`, parentProfileId: camera.id, fields: { currentValue: 800, purchasePrice: 1100, purchaseDate: "2024-03-01" } });
    const cap = await mk(ctx, { type: "asset", name: `${ctx.tag} Lens Cap`, parentProfileId: lens.id, fields: { currentValue: 20 } });
    const before = await snapshot(ctx);

    const row = await lifecycleOf(ctx, camera.id);
    ctx.near("derived", row.lifecycle.currentValue, 2400, "the parent's lifecycle uses its own value, not its children's");
    ctx.check("derived", row.nested?.count === 2 && Math.abs(row.nested.value - 820) < 0.5, "its nested items are summed separately: 2 items worth 820", JSON.stringify(row.nested));
    const tree = must(await ctx.api("GET", `/profiles/${camera.id}/tree`), "tree");
    ctx.check("action", JSON.stringify(tree).includes(lens.id) && JSON.stringify(tree).includes(cap.id), "the parent's tree lists the child and the grandchild");

    // a cycle is refused
    const cyc = await ctx.api("PATCH", `/profiles/${camera.id}`, { parentProfileId: cap.id });
    ctx.check("action", cyc.status >= 400 && cyc.status < 500, "nesting a parent under its own grandchild is refused", `${cyc.status}`);
    ctx.check("db", (await ctx.db.row("profiles", camera.id)).parent_profile_id !== cap.id, "and the parent's row did not move");

    // expenses: one to the parent, one to parent + child (belongs to the child), one loan payment tagged as such
    const e = async (description: string, amount: number, linkedProfiles: string[], extra: any = {}) => {
      const x = must(await ctx.api("POST", "/expenses", { description, amount, category: "maintenance", date: ctx.today, linkedProfiles, ...extra }), description);
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${x.id}`));
      return x;
    };
    await e(`${ctx.tag} sensor clean`, 120, [camera.id]);
    await e(`${ctx.tag} lens repair`, 75, [camera.id, lens.id]);
    const detail = must(await ctx.api("GET", `/profiles/${camera.id}/detail`), "detail");
    const names = (detail.relatedExpenses || []).map((x: any) => x.description);
    ctx.check("derived", names.includes(`${ctx.tag} sensor clean`), "the parent's page lists the expense filed under it", JSON.stringify(names));
    const lensDetail = must(await ctx.api("GET", `/profiles/${lens.id}/detail`), "lens detail");
    ctx.check("derived", (lensDetail.relatedExpenses || []).some((x: any) => x.description === `${ctx.tag} lens repair`), "the child's page lists the expense that names it");
    const eRow = (await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(`${ctx.tag} lens repair`)}`))[0];
    ctx.check("db", JSON.stringify(eRow.linked_profiles) === JSON.stringify([camera.id, lens.id]) && Number(eRow.amount) === 75, "the expense row is one row naming both assets (not copied per asset)", JSON.stringify(eRow.linked_profiles));

    // move the child out to the top level: totals unchanged, parent's nested count falls
    must(await ctx.api("PATCH", `/profiles/${lens.id}`, { parentProfileId: ctx.self.id }), "move lens out");
    const row2 = await lifecycleOf(ctx, camera.id);
    ctx.check("derived", row2.nested === null || row2.nested.count === 0, "after moving the child (and its own child) out, the parent has no nested items", JSON.stringify(row2.nested));
    const after = await snapshot(ctx);
    ctx.near("derived", after.totalAssetValue, before.totalAssetValue, "moving an asset between parents does not change total assets");
    ctx.check("db", (await ctx.db.row("profiles", cap.id)).parent_profile_id === lens.id, "the grandchild stayed with its own parent");

    // deleting the parent does not silently take or orphan the others
    must(await ctx.api("DELETE", `/profiles/${camera.id}`), "delete camera");
    const lensRow = await ctx.db.row("profiles", lens.id);
    ctx.check("db", lensRow?.deleted_at == null, "the moved-out lens survives its old parent's deletion");
    const final = await snapshot(ctx);
    ctx.near("derived", O.cents(after.totalAssetValue - final.totalAssetValue), 2400, "total assets fell by the deleted asset's own value only");
  },
});

scenario({
  id: "assets.shared-ownership",
  title: "A share of an asset or a loan counts as that share for each person, and the whole for everyone",
  area: "Ownership",
  covers: ["asset.transfer.api", "liability.transfer.api", "profile.create.api", "profile.delete.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const partner = await mk(ctx, { type: "person", name: `${ctx.tag} Partner`, fields: { relationship: "partner" } });
    const boat = await mk(ctx, { type: "asset", name: `${ctx.tag} Boat`, fields: { currentValue: 40000 } });
    const loan = await mk(ctx, { type: "liability", type_key: "personal_loan", name: `${ctx.tag} Boat Loan`, fields: { balance: 10000, monthlyPayment: 250, dueDay: 8 } });
    const scoped = async (ids: string[]) => {
      const d = must(await ctx.api("GET", `/dashboard-enhanced?profileIds=${ids.join(",")}`), "scoped snapshot");
      return d.financeSnapshot;
    };
    const all0 = await snapshot(ctx);
    const partner0 = await scoped([partner.id]);
    ctx.near("derived", partner0.totalAssetValue, 0, "a new person owns nothing yet");

    const put = await ctx.api("PUT", `/profiles/${boat.id}/owners`, { owners: [{ partyProfileId: ctx.self.id, ownershipPercentage: 60 }, { partyProfileId: partner.id, ownershipPercentage: 40 }] });
    ctx.check("action", put.ok, "a 60/40 split is accepted", `${put.status} ${JSON.stringify(put.data).slice(0, 200)}`);
    const links = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${boat.id}`);
    ctx.check("db", links.length === 2 && links.reduce((s: number, l: any) => s + Number(l.ownership_percentage), 0) === 100, "two owner rows adding up to 100%", JSON.stringify(links.map((l: any) => l.ownership_percentage)));
    const want = O.netWorth([{ value: 40000, sharePct: 40 }], []);
    const partner1 = await scoped([partner.id]);
    ctx.near("derived", partner1.totalAssetValue, want.assets, "the partner's assets are 40% of the boat");
    const all1 = await snapshot(ctx);
    ctx.near("derived", all1.totalAssetValue, all0.totalAssetValue, "the household total did not change when the boat was shared");

    const bad = await ctx.api("PUT", `/profiles/${boat.id}/owners`, { owners: [{ partyProfileId: ctx.self.id, ownershipPercentage: 80 }, { partyProfileId: partner.id, ownershipPercentage: 40 }] });
    ctx.check("action", bad.status >= 400 && bad.status < 500, "shares adding up to 120% are refused", `${bad.status}`);
    const links2 = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${boat.id}`);
    ctx.same("db", links2.map((l: any) => Number(l.ownership_percentage)).sort(), [40, 60], "the refused split left 60/40 in place");

    // the loan, shared 50/50
    const putL = await ctx.api("PUT", `/profiles/${loan.id}/owners`, { owners: [{ partyProfileId: ctx.self.id, ownershipPercentage: 50 }, { partyProfileId: partner.id, ownershipPercentage: 50 }] });
    ctx.check("action", putL.ok, "a 50/50 split of the loan is accepted", `${putL.status}`);
    const partner2 = await scoped([partner.id]);
    ctx.near("derived", partner2.totalLiabilities, 5000, "the partner's debt is half the loan");

    // transfer the boat entirely
    must(await ctx.api("PUT", `/profiles/${boat.id}/owners`, { owners: [{ partyProfileId: partner.id, ownershipPercentage: 100 }] }), "transfer");
    const partner3 = await scoped([partner.id]);
    ctx.near("derived", partner3.totalAssetValue, 40000, "after a full transfer the partner holds the whole boat");
    const mine = await scoped([ctx.self.id]);
    ctx.check("derived", !(mine.assetBreakdown || []).some((r: any) => r.id === boat.id && r.value > 0), "and it no longer counts for the previous owner");
    ctx.check("db", (await ctx.db.count("asset_party_links", `asset_profile_id=eq.${boat.id}`)) === 1, "one owner row remains");

    // delete the person: nothing points at a missing owner
    const del = await ctx.api("DELETE", `/profiles/${partner.id}`);
    ctx.check("action", del.ok, "the person is deleted", `${del.status} ${JSON.stringify(del.data).slice(0, 160)}`);
    const orphanA = await ctx.db.count("asset_party_links", `party_profile_id=eq.${partner.id}`);
    const orphanL = await ctx.db.count("liability_profile_links", `party_profile_id=eq.${partner.id}`);
    const ok = ctx.check("db", orphanA === 0 && orphanL === 0, "no ownership row still names the deleted person", `${orphanA} asset / ${orphanL} loan rows`);
    if (!ok) ctx.finding({ severity: "bug", title: "Ownership rows point at a deleted person", detail: `${orphanA} asset_party_links and ${orphanL} liability_profile_links rows name the deleted profile` });
    const all2 = await snapshot(ctx);
    ctx.near("derived", all2.totalAssetValue, all0.totalAssetValue, "the household still counts the whole boat after its owner was deleted");
    ctx.near("derived", all2.totalLiabilities, all0.totalLiabilities, "and the whole loan");
    ctx.check("db", (await ctx.db.row("profiles", boat.id))?.deleted_at == null, "the boat itself was not deleted with the person");
  },
});

scenario({
  id: "assets.person-cascade",
  title: "Deleting a person leaves no record pointing at them",
  area: "Ownership",
  covers: ["profile.delete.api", "task.link.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const kid = await mk(ctx, { type: "person", name: `${ctx.tag} Kid`, fields: {} });
    const mkRec = async (path: string, body: any) => {
      const r = must(await ctx.api("POST", path, body), path);
      const id = r.id ?? r.entry?.id;
      ctx.cleanup(() => ctx.api("DELETE", `${path}/${id}`));
      return id as string;
    };
    const taskId = await mkRec("/tasks", { title: `${ctx.tag} kid dentist`, linkedProfiles: [kid.id] });
    const sharedTask = await mkRec("/tasks", { title: `${ctx.tag} family trip`, linkedProfiles: [kid.id, ctx.self.id] });
    const expId = await mkRec("/expenses", { description: `${ctx.tag} kid shoes`, amount: 30, category: "shopping", date: ctx.today, linkedProfiles: [kid.id] });
    const evId = await mkRec("/events", { title: `${ctx.tag} kid recital`, date: O.addDays(ctx.today, 9), linkedProfiles: [kid.id] });
    const tracker = must(await ctx.api("POST", "/trackers", { name: `${ctx.tag} Kid Height`, category: "health", fields: [{ name: "value", type: "number" }], linkedProfiles: [kid.id] }), "tracker");
    ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tracker.id}`));
    ctx.check("db", JSON.stringify((await ctx.db.row("tasks", taskId)).linked_profiles) === JSON.stringify([kid.id]), "the task row is filed under the person");

    const del = await ctx.api("DELETE", `/profiles/${kid.id}`);
    ctx.check("action", del.ok, "the person is deleted", `${del.status} ${JSON.stringify(del.data).slice(0, 200)}`);
    const dangling: string[] = [];
    for (const [table, id] of [["tasks", taskId], ["tasks", sharedTask], ["expenses", expId], ["events", evId], ["trackers", tracker.id]] as const) {
      const row = await ctx.db.row(table, id);
      if (row && row.deleted_at == null && JSON.stringify(row.linked_profiles ?? []).includes(kid.id)) dangling.push(`${table}:${id}`);
    }
    const ok = ctx.check("db", dangling.length === 0, "no live task, expense, event or tracker row still names the deleted person", dangling.join(", "));
    if (!ok) ctx.finding({ severity: "bug", title: "Records still point at a deleted person", detail: dangling.join(", ") });
    const shared = await ctx.db.row("tasks", sharedTask);
    ctx.check("db", shared?.deleted_at == null && JSON.stringify(shared.linked_profiles).includes(ctx.self.id), "a task shared with someone else survives, still filed under them", JSON.stringify(shared?.linked_profiles));
    for (const p of ["/tasks", "/expenses", "/events", "/trackers"]) {
      const rows = listOf(must(await ctx.api("GET", p), p));
      const bad = rows.filter((r: any) => (r.linkedProfiles || []).includes(kid.id));
      ctx.check("action", bad.length === 0, `${p}: no listed record names the deleted person`, `${bad.length}`);
    }
  },
});
