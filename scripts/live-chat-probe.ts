/**
 * LIVE chat-pipeline probe against production (portol.me). Sends 10 diverse
 * natural-language commands to the REAL /api/chat, then verifies each actually
 * persisted by GETting the owning endpoint and matching a unique marker.
 * Diagnoses the user's "nothing gets logged / chat not connected" report.
 *
 *   npx tsx scripts/live-chat-probe.ts
 */
import { api } from "../tests/smoke/fixture/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `PROBE${Date.now().toString(36).slice(-5)}`;
const month = new Date().toISOString().slice(0, 7);
const today = new Date().toISOString().slice(0, 10);

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  if (!r.ok) return [];
  const d = r.data;
  return Array.isArray(d) ? d : (d?.items || d?.budgets || d?.goals || d?.trackers || []);
}

type Probe = { n: number; kind: string; message: string; verify: () => Promise<string | null> };

const probes: Probe[] = [
  { n: 1, kind: "expense", message: `Add an expense called ${TAG}_coffee for $5.50`,
    verify: async () => { const h = (await list("/expenses")).find((e) => (e.description || "").includes(`${TAG}_coffee`)); return h ? h.id : null; } },
  { n: 2, kind: "task", message: `Add a task to call the dentist ${TAG}`,
    verify: async () => { const h = (await list("/tasks")).find((t) => (t.title || "").includes(TAG)); return h ? h.id : null; } },
  { n: 3, kind: "tracker+entry", message: `Log my weight as 181 lbs ${TAG}`,
    verify: async () => { const ts = await list("/trackers"); const w = ts.find((t) => /weight/i.test(t.name)); return w && (w.entries || []).length > 0 ? `tracker:${w.id}` : null; } },
  { n: 4, kind: "event", message: `Add a calendar event ${TAG}_meeting today at 3pm`,
    verify: async () => { const h = (await list("/events")).find((e) => (e.title || "").includes(`${TAG}_meeting`)); return h ? h.id : null; } },
  { n: 5, kind: "habit", message: `Create a daily habit ${TAG}_stretch`,
    verify: async () => { const h = (await list("/habits")).find((x) => (x.name || "").includes(`${TAG}_stretch`)); return h ? h.id : null; } },
  { n: 6, kind: "bill", message: `Add a monthly bill ${TAG}_netflix for $16`,
    verify: async () => { const h = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_netflix`)); return h ? h.id : null; } },
  { n: 7, kind: "goal", message: `Set a goal to save $5000 called ${TAG}_fund`,
    verify: async () => { const h = (await list("/goals")).find((g) => (g.title || "").includes(`${TAG}_fund`)); return h ? h.id : null; } },
  { n: 8, kind: "journal", message: `Journal: had a productive day ${TAG}`,
    verify: async () => { const h = (await list("/journal")).find((j) => (j.content || "").includes(TAG)); return h ? h.id : null; } },
  { n: 9, kind: "income", message: `Add monthly income ${TAG}_salary of $4200`,
    verify: async () => { const h = (await list("/incomes")).find((i) => (i.description || i.name || "").includes(`${TAG}_salary`)); return h ? h.id : null; } },
  { n: 10, kind: "nutrition", message: `I ate a ${TAG} chicken sandwich, 430 calories`,
    verify: async () => { const ts = await list("/trackers"); const c = ts.find((t) => /calorie|nutrition|food/i.test(t.name + " " + t.category)); return c && (c.entries || []).length > 0 ? `tracker:${c.id}` : null; } },
];

(async () => {
  console.log(`\n─── LIVE chat probe against ${process.env.SMOKE_API_BASE || "https://portol.me/api"} (tag ${TAG}) ───\n`);
  // Sanity: can we auth + read at all?
  const whoami = await api("GET", "/stats");
  console.log(`auth/read check: GET /stats → ${whoami.status} ${whoami.ok ? "OK" : JSON.stringify(whoami.data).slice(0, 120)}\n`);

  const results: string[] = [];
  let pass = 0;
  for (const p of probes) {
    let line = `#${String(p.n).padStart(2)} ${p.kind.padEnd(14)} "${p.message.slice(0, 44)}"`;
    try {
      const t0 = Date.now();
      const res = await api("POST", "/chat", { message: p.message });
      const ms = Date.now() - t0;
      // What did the server SAY it did?
      const actions = Array.isArray((res.data as any)?.actions) ? (res.data as any).actions : [];
      const actionTypes = actions.map((a: any) => a.type).join(",") || "none";
      if (!res.ok) { results.push(`❌ ${line} → CHAT ${res.status}: ${JSON.stringify(res.data).slice(0, 100)}`); continue; }
      await sleep(1500); // allow the write to settle
      const id = await p.verify();
      if (id) { pass++; results.push(`✅ ${line} → saved (${id}) [chat ${ms}ms, actions: ${actionTypes}]`); }
      else results.push(`❌ ${line} → NOT in DB [chat ${res.status} ${ms}ms, reply="${String((res.data as any)?.reply || "").slice(0, 50)}", actions: ${actionTypes}]`);
    } catch (e: any) {
      results.push(`💥 ${line} → ${e?.message || e}`);
    }
    await sleep(3600); // stay under the 20/min chat rate limit
  }

  console.log(results.join("\n"));
  console.log(`\n${pass}/${probes.length} commands verified as SAVED to the database.\n`);

  // Cleanup by tag.
  for (const ep of ["/expenses", "/tasks", "/events", "/habits", "/obligations", "/goals", "/journal", "/incomes"]) {
    for (const row of await list(ep)) {
      if (JSON.stringify(row).includes(TAG)) { try { await api("DELETE", `${ep}/${row.id}`); } catch { /* best effort */ } }
    }
  }
  process.exit(pass === probes.length ? 0 : 1);
})();
