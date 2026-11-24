// Live check (deployed app, smoke account): the AI sets an asset's salvage
// value, a typed figure overrides it, and removing that hands it back.
//   npx tsx tests/live-salvage-check.ts
// See shared/asset-salvage.ts and CLAUDE.md P0.
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

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-salvage-check" });
  let id: string | null = null;
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);
    const asset = await call("POST", "/profiles", {
      type: "vehicle", name: `Salvage Civic ${Math.random().toString(36).slice(2, 6)}`,
      fields: { year: 2016, make: "Honda", model: "Civic", mileage: 98000, purchasePrice: 19000, purchaseDate: "2016-05-01" },
    });
    id = asset.id;

    // The first valuation runs the research and the salvage question together.
    const t0 = Date.now();
    await call("POST", `/profiles/${id}/valuation/refresh`, { force: false });
    let f = (await read(`/profiles/${id}`)).fields || {};
    console.log(`  first run ${Math.round((Date.now() - t0) / 1000)}s → salvage ${f.salvageValue} (${f.salvageValueSource}): ${f.salvageValueBasis}`);
    check(Number(f.salvageValue) > 0 && Number(f.salvageValue) < 19000, "the AI set a salvage value below the purchase price");
    check(f.salvageValueSource === "estimate", "it is marked as the AI's estimate");
    check(typeof f.salvageValueBasis === "string" && f.salvageValueBasis.length > 0, "it carries a reason");
    const snap = await read(`/profiles/${id}/valuation`);
    check(snap.salvageDue === false, "the snapshot no longer asks for one");

    // A typed figure is the user's; a forced refresh keeps it.
    await call("PATCH", `/profiles/${id}`, { fields: { salvageValue: 2222 } });
    await call("POST", `/profiles/${id}/valuation/refresh`, { force: true });
    f = (await read(`/profiles/${id}`)).fields || {};
    check(Number(f.salvageValue) === 2222 && f.salvageValueSource === "user", "a typed salvage value survives a refresh");

    // Removing it hands it back: the next (quick, unforced) refresh re-estimates.
    await call("PATCH", `/profiles/${id}`, { fieldsToDelete: ["salvageValue"] });
    const due = await read(`/profiles/${id}/valuation`);
    check(due.salvageDue === true, "after removing it, the snapshot asks the AI again");
    const t1 = Date.now();
    await call("POST", `/profiles/${id}/valuation/refresh`, { force: false });
    f = (await read(`/profiles/${id}`)).fields || {};
    console.log(`  quick run ${Math.round((Date.now() - t1) / 1000)}s → salvage ${f.salvageValue} (${f.salvageValueSource})`);
    check(Number(f.salvageValue) > 0 && f.salvageValueSource === "estimate", "the AI estimated it again");
  } finally {
    if (id) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
