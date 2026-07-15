// ── Everyone-scope aggregation verifier (2026-07-15) ─────────────────────────
// Proves, against the production API + database, the five properties the
// Everyone filter must hold (user spec):
//   1. Everyone totals match all profiles combined (union of per-profile sets)
//   2. No records are missing from Everyone
//   3. No records are duplicated in Everyone
//   4. Individual profile data remains isolated (a record linked only to
//      profile A never appears under profile B)
//   5. Counts update correctly after creating, editing, deleting, and
//      refreshing records
//
// Method: for each list endpoint, fetch the unfiltered set (exactly what the
// dashboard requests in Everyone mode) and the per-profile set for EVERY
// profile; the union of per-profile sets (orphans surface via the self
// profile, per the app-wide belongs_to_self rule) must equal the unfiltered
// set by ID. Then a CRUD pass on tasks linked to a dedicated probe person.
//
// Run: npx tsx scripts/verify-everyone.ts   (uses the production smoke account)
import { api } from "../tests/smoke/fixture/api";

const ENDPOINTS = ["/tasks", "/habits", "/goals", "/journal", "/documents", "/obligations", "/expenses", "/reminders"];
const PROBE_NAME = "EV Aggregate Probe";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ids = (rows: any[]) => rows.map(r => r.id).filter(Boolean);
const asRows = (d: unknown): any[] => (Array.isArray(d) ? d : []);

(async () => {
  console.log("── Everyone aggregation verification ──");
  const profResp = await api("GET", "/profiles");
  const profiles = asRows(profResp.data);
  check("profiles loaded", profiles.length > 0, `${profiles.length} profiles`);
  const self = profiles.find((p: any) => p.type === "self");
  check("self profile exists", !!self, self?.name);
  let probe = profiles.find((p: any) => p.name === PROBE_NAME);
  if (!probe) {
    const c = await api("POST", "/profiles", { name: PROBE_NAME, type: "person" });
    probe = c.data;
  }
  check("probe person exists", !!probe?.id, probe?.id);

  // ── Criteria 1–3: union-vs-everyone per endpoint ──────────────────────────
  for (const ep of ENDPOINTS) {
    const everyone = asRows((await api("GET", ep)).data);
    const everyoneIds = ids(everyone);
    const unionIds = new Set<string>();
    for (const p of profiles) {
      const scoped = asRows((await api("GET", `${ep}?profileIds=${p.id}`)).data);
      for (const id of ids(scoped)) unionIds.add(id);
    }
    const missing = [...unionIds].filter(id => !everyoneIds.includes(id));
    const extra = everyoneIds.filter(id => !unionIds.has(id));
    const dupes = everyoneIds.filter((id, i) => everyoneIds.indexOf(id) !== i);
    check(`${ep}: everyone ⊇ every profile's records`, missing.length === 0,
      missing.length ? `missing ${missing.length} of ${unionIds.size}` : `${unionIds.size} union / ${everyoneIds.length} everyone`);
    check(`${ep}: no duplicates in everyone`, dupes.length === 0, dupes.length ? `${dupes.length} dupes` : `${everyoneIds.length} unique rows`);
    // Records in Everyone but in NO profile's view = linked only to dead
    // profile ids (union already includes orphans via self). Report, since
    // such rows would be invisible in every individual filter.
    check(`${ep}: every everyone-record reachable via some profile`, extra.length === 0,
      extra.length ? `${extra.length} rows linked only to dead/unmatchable profiles: ${extra.slice(0, 3).join(",")}` : "all reachable");
  }

  // ── Criterion 4: isolation ────────────────────────────────────────────────
  const isoTitle = `EV-iso task ${Date.now()}`;
  const created = await api("POST", "/tasks", { title: isoTitle, linkedProfiles: [probe.id] });
  const isoId = (created.data as any)?.id;
  check("isolation: probe-linked task created", created.status === 201 && !!isoId);
  const inProbe = asRows((await api("GET", `/tasks?profileIds=${probe.id}`)).data).some(t => t.id === isoId);
  const inSelf = asRows((await api("GET", `/tasks?profileIds=${self.id}`)).data).some(t => t.id === isoId);
  const others = profiles.filter((p: any) => p.type === "person" && p.id !== probe.id && p.id !== self.id).slice(0, 3);
  let leaked = false;
  for (const o of others) {
    if (asRows((await api("GET", `/tasks?profileIds=${o.id}`)).data).some(t => t.id === isoId)) leaked = true;
  }
  const inEveryone = asRows((await api("GET", "/tasks")).data).some(t => t.id === isoId);
  check("isolation: visible under its own profile", inProbe);
  check("isolation: NOT visible under self", !inSelf);
  check("isolation: NOT visible under other people", !leaked, `${others.length} other profiles checked`);
  check("isolation: visible in Everyone", inEveryone);

  // ── Criterion 5: counts update on create/edit/delete/refresh ─────────────
  const countPending = async (scope: string) =>
    asRows((await api("GET", `/tasks${scope}`)).data).filter((t: any) => t.status !== "done").length;
  const beforeAll = await countPending("");
  const beforeSelf = await countPending(`?profileIds=${self.id}`);
  const t2 = await api("POST", "/tasks", { title: `EV-count task ${Date.now()}`, linkedProfiles: [probe.id] });
  const t2id = (t2.data as any)?.id;
  const afterCreateAll = await countPending("");
  const afterCreateSelf = await countPending(`?profileIds=${self.id}`);
  check("counts: everyone +1 after create", afterCreateAll === beforeAll + 1, `${beforeAll} → ${afterCreateAll}`);
  check("counts: self unchanged after create", afterCreateSelf === beforeSelf, `${beforeSelf} → ${afterCreateSelf}`);
  const done = await api("PATCH", `/tasks/${t2id}`, { status: "done" });
  check("counts: edit (mark done) accepted", done.status === 200);
  const afterEditAll = await countPending("");
  check("counts: everyone -1 after edit to done", afterEditAll === beforeAll, `${afterCreateAll} → ${afterEditAll}`);
  const del = await api("DELETE", `/tasks/${t2id}`);
  check("counts: delete accepted", [200, 204].includes(del.status));
  // refresh = fresh re-reads after all writes
  await new Promise(r => setTimeout(r, 1200));
  const afterDeleteAll = asRows((await api("GET", "/tasks")).data).some((t: any) => t.id === t2id);
  check("counts: deleted task gone from everyone on refresh", !afterDeleteAll);
  const isoStill = asRows((await api("GET", "/tasks")).data).some((t: any) => t.id === isoId);
  check("refresh: unrelated record still present", isoStill);

  // ── Cleanup: remove every probe record + the probe profile ───────────────
  const allTasks = asRows((await api("GET", "/tasks")).data);
  for (const t of allTasks.filter((t: any) => /^EV-(iso|count|probe)/.test(t.title || ""))) await api("DELETE", `/tasks/${t.id}`);
  const allHabits = asRows((await api("GET", "/habits")).data);
  for (const h of allHabits.filter((h: any) => /^EV-probe/.test(h.name || ""))) await api("DELETE", `/habits/${h.id}`);
  const delProf = await api("DELETE", `/profiles/${probe.id}`);
  check("cleanup: probe data removed", [200, 204].includes(delProf.status));
  const residue = asRows((await api("GET", "/tasks")).data).filter((t: any) => /^EV-/.test(t.title || ""));
  check("cleanup: no residue", residue.length === 0, residue.length ? `${residue.length} left` : "clean");

  console.log(`\n── RESULT: ${pass} passed, ${fail} failed ──`);
  if (failures.length) { console.log("Failures:"); for (const f of failures) console.log("  ✗ " + f); process.exit(1); }
})();
