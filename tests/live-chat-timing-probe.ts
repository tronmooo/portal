// Live probe (production, smoke account): where a chat turn's time goes.
// Prints, per line said: the wall time the caller waited, the server's own
// turn time, and each tool's execute / verify time (meta.timings). It writes
// as the smoke account, so it takes the gate lock, and removes what it made.
//   npx tsx tests/live-chat-timing-probe.ts
import { api } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";

const LINES = [
  "hello",
  "spent $6.10 on a probe bagel",
  "add a task to probe the gutters tomorrow",
  "weighed in at 181.2 this morning",
  "how much did I spend today?",
  "lunch with Probe Sam on Friday at noon",
  "spent $3 on probe gum and add a task to probe the mail",
];

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-chat-timing-probe" });
  const ids = async (p: string) => new Set(list((await api("GET", p)).data).map((r) => r.id));
  const paths = ["/tasks", "/expenses", "/events"];
  const before = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await ids(p)] as const)));
  const trackersBefore = list((await api("GET", "/trackers")).data);
  try {
    for (const line of LINES) {
      await new Promise((r) => setTimeout(r, 3400));
      const r = await api("POST", "/chat", { message: line, history: [] });
      const m = r.data?.meta || {};
      const tools = (m.timings?.tools || []).map((t: any) => `${t.tool} exec ${t.execMs} verify ${t.verifyMs}`).join("; ");
      console.log(`${String(r.ms).padStart(6)}ms wall | server ${String(m.timings?.aiMs ?? "?").padStart(5)}ms | route ${m.route || "?"} model ${m.model || "?"} rounds ${m.rounds ?? m.iterations ?? "?"} | ${tools || "no tools"} | "${line}"`);
      if (process.env.META) console.log(`         meta: ${JSON.stringify(m).slice(0, 600)}`);
    }
  } finally {
    for (const p of paths) for (const id of await ids(p)) if (!before[p].has(id)) await api("DELETE", `${p}/${id}`);
    const had = new Map(trackersBefore.map((t: any) => [t.id, new Set((t.entries || []).map((e: any) => e.id))]));
    for (const t of list((await api("GET", "/trackers")).data) as any[]) {
      if (!had.has(t.id)) { await api("DELETE", `/trackers/${t.id}`); continue; }
      for (const e of t.entries || []) if (!had.get(t.id)!.has(e.id)) await api("DELETE", `/trackers/${t.id}/entries/${e.id}`);
    }
    await release();
  }
})().catch((e) => { console.error(e); process.exit(1); });
