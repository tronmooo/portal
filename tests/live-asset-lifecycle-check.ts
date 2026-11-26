// Live check (deployed app, smoke account): Asset Lifecycle Intelligence.
//   npx tsx tests/live-asset-lifecycle-check.ts
// The value-tracking run stores the AI's lifecycle assumptions (salvage value
// included); GET /api/assets/lifecycle derives the figures and the
// recommendation; a typed salvage value overrides the AI's and removing it
// hands it back; a nested child's shared expense is counted once; a
// recommendation dismissed from Needs Attention is listed and restorable.
// See shared/asset-lifecycle.ts and CLAUDE.md "Asset lifecycle rules".
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";

let failed = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
async function call(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
async function read(path: string): Promise<any> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return response.json();
}
const lifecycleOf = async (id: string) => ((await read("/assets/lifecycle")).rows as any[]).find((r) => r.profileId === id);

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-asset-lifecycle-check" });
  const made: string[] = [];
  let expenseId: string | null = null;
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);
    const tag = Math.random().toString(36).slice(2, 6);
    const car = await call("POST", "/profiles", {
      type: "vehicle", name: `Lifecycle Civic ${tag}`,
      fields: { year: 2016, make: "Honda", model: "Civic", mileage: 98000, purchasePrice: 19000, purchaseDate: "2016-05-01" },
    });
    made.push(car.id);

    // ── The run stores the AI's assumptions; the engine derives the rest ──
    const t0 = Date.now();
    await call("POST", `/profiles/${car.id}/valuation/refresh`, { force: false });
    const f = (await read(`/profiles/${car.id}`)).fields || {};
    console.log(`  first run ${Math.round((Date.now() - t0) / 1000)}s → ${JSON.stringify(f.lifecycleAssumptions)?.slice(0, 220)}`);
    check(f.lifecycleAssumptions?.valueModel === "depreciating", "the AI chose a depreciating model for a 2016 car");
    check(Number(f.lifecycleAssumptions?.usefulLifeYears) > 5, "with a useful life");
    check(Number(f.salvageValue) < 19000 && f.salvageValueSource === "estimate", "the salvage value rides along, marked as the AI's");
    const row = await lifecycleOf(car.id);
    const l = row?.lifecycle;
    console.log(`  lifecycle → ${l?.recommendation?.label}: ${l?.recommendation?.headline}`);
    check(!!l?.applicable && l.assumptions.source === "ai", "GET /api/assets/lifecycle derives it from the AI's assumptions");
    check(["keep", "monitor", "consider_selling", "replace", "dispose"].includes(l?.recommendation?.action), "it carries a recommendation");
    check((l?.recommendation?.reasons || []).length > 0, "with reasons");
    check(Array.isArray(l?.projection) && l.projection.length > 12, "and a projection");
    check(l?.currentValue > 0 && typeof l?.lastUpdated?.value === "string", "the current value and when it was valued");
    check(l?.salvage?.source === "ai", "the salvage value it uses is the AI's");
    check(f.lifecycleAssumptions && "upkeepGrowthPct" in f.lifecycleAssumptions, "the AI chose the upkeep assumptions the optimal disposal point needs");
    const factorKeys = ["annualUpkeep", "upkeepGrowthPct", "majorRepairCost", "majorFailureChancePct", "majorFailureChanceGrowthPct", "carryingCostPct", "sellingCostPct", "newEfficiencySavings", "resaleRetention", "anticipatedRepairs", "marketDemand", "disposalReasoning"];
    const odm = l?.optimalDisposal;
    check(Array.isArray(f.lifecycleAssumptions?.resaleRetention) && f.lifecycleAssumptions.resaleRetention.length >= 2, "the AI gave its own resale curve for this asset");
    check(odm?.curveSource === "ai", "the disposal point follows the AI's resale curve");
    const salvageNow = Number(l?.salvage?.value ?? 0);
    check(!!odm && odm.valueAt > Math.max(0, salvageNow), `the disposal value (${odm?.valueAt}) is above the salvage value (${salvageNow}), never equal to it`);
    check(!!odm && ["keep", "sell_now"].includes(odm.decision) && typeof odm.remainingEconomicLifeYears === "number" && typeof odm.projectedDepreciation === "number", "it says sell now or keep, the economic life left and the projected depreciation");
    check(!!odm && ["high", "medium", "low"].includes(odm.confidence) && odm.range.valueLow <= odm.valueAt && odm.range.valueHigh >= odm.valueAt, `a confidence (${odm?.confidence}) and a range around the value`);
    check(typeof odm?.explanation?.ai === "string" && odm.explanation.ai.length > 20 && !/\$\d/.test(odm.explanation.ai), "an AI explanation in words, with no figure of its own");
    console.log(`  decision → ${odm?.decision} ${odm?.date}: $${odm?.valueAt} (salvage $${salvageNow}); ${odm?.explanation?.ai}`);
    const missingKeys = factorKeys.filter((k) => !(k in (f.lifecycleAssumptions || {})));
    check(missingKeys.length === 0, `the AI's answer carries every disposal factor${missingKeys.length ? ` (missing ${missingKeys.join(", ")})` : ""}`);
    const gotFactors = (l?.optimalDisposal?.factors || []).map((x: any) => x.key);
    check(["depreciation", "upkeep", "major_failure", "carrying", "capital", "selling"].every((k) => gotFactors.includes(k)), `the point lists every factor it weighed (${gotFactors.join(", ")})`);
    console.log(`  optimal disposal → ${l?.optimalDisposal?.date} (${l?.optimalDisposal?.reason}), fetch ${l?.optimalDisposal?.valueAt}; ${(l?.optimalDisposal?.factors || []).map((x: any) => `${x.key} ${x.now}/${x.source}`).join(" · ")}`);
    const od = l?.optimalDisposal;
    check(!!od && /^\d{4}-\d{2}-\d{2}$/.test(od.date) && od.valueAt >= 0 && ["now", "cost_rises", "cheaper_to_replace", "end_of_life"].includes(od.reason), "the optimal disposal point is calculated, with a date, a reason and what it should fetch");
    const snap = await read(`/profiles/${car.id}/valuation`);
    check(snap.salvageDue === false, "the snapshot no longer asks for assumptions");

    // ── A typed salvage value overrides; removing it hands it back ──
    await call("PATCH", `/profiles/${car.id}`, { fields: { salvageValue: 2222 } });
    const typed = await lifecycleOf(car.id);
    check(typed?.lifecycle?.salvage?.value === 2222 && typed.lifecycle.salvage.source === "user", "a typed salvage value is the one the engine uses");
    await call("PATCH", `/profiles/${car.id}`, { fieldsToDelete: ["salvageValue"] });
    const back = await lifecycleOf(car.id);
    check(back?.lifecycle?.salvage?.source === "ai", "removing it hands the figure back to the AI's assumption");

    // ── A nested child: the shared expense is the child's alone ──
    const tires = await call("POST", "/profiles", {
      type: "asset", name: `Lifecycle tires ${tag}`, parentProfileId: car.id,
      fields: { purchasePrice: 800, purchaseDate: "2024-03-01", currentValue: 450 },
    });
    made.push(tires.id);
    const today = new Date().toISOString().slice(0, 10);
    const exp = await call("POST", "/expenses", { description: `Tire repair ${tag}`, amount: 120, category: "auto", date: today, linkedProfiles: [car.id, tires.id] });
    expenseId = exp.id;
    const rows = (await read("/assets/lifecycle")).rows as any[];
    const carRow = rows.find((r) => r.profileId === car.id), tireRow = rows.find((r) => r.profileId === tires.id);
    check(tireRow?.repairs?.last12m === 120 && carRow?.repairs?.last12m === 0, "an expense on the car AND its tires is counted once, on the tires");
    check(carRow?.nested?.count === 1 && carRow.nested.value === 450, "the car's nested line sums the tires separately");
    const carOwn = Number((await read(`/profiles/${car.id}`)).fields?.currentValue);
    check(carOwn > 0 && carRow?.lifecycle?.currentValue === carOwn, "the car's lifecycle uses its own value, not its own plus the tires'");

    // ── Dismissing a recommendation is stored, listed and restorable ──
    const action = back.lifecycle.recommendation.action;
    const alertId = `lifecycle:${car.id}:${action}`;
    await call("POST", "/notifications/dismiss", { ids: [alertId] });
    const listed = ((await read("/notifications/dismissed")).alerts as any[]).find((a) => a.id === alertId);
    check(!!listed && String(listed.title).includes(car.name), "a dismissed recommendation is listed by name");
    await call("POST", "/notifications/restore", { ids: [alertId] });
    const gone = ((await read("/notifications/dismissed")).alerts as any[]).find((a) => a.id === alertId);
    check(!gone, "and restorable");
  } finally {
    if (expenseId) await api("DELETE", `/expenses/${expenseId}`).catch(() => undefined);
    for (const id of made.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
