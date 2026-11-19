// Live check (production, smoke account): what is added ON an asset also shows
// in the main places (owner request 2026-11-19).
//   • a task created from the asset's page is in the main Tasks list and the
//     dashboard, with no filter and with "me" selected
//   • an expense added on the asset is in the main expense list and is counted
//     in the dashboard / Finance totals, with no filter and with "me" selected
// Takes the gate lock; deletes what it creates.
//   npx tsx tests/live-asset-rollup-check.ts
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

let dataVersion: string | undefined;
async function write(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  const h = r.headers.get("x-data-version");
  if (h) dataVersion = h;
  return r.data;
}
async function read(path: string): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getSmokeToken()}` };
  if (dataVersion) headers["x-data-version"] = dataVersion;
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
const rowsOf = (body: any): any[] => {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.data) ? body.data : null;
  if (!rows) throw new Error(`unexpected list shape: ${JSON.stringify(body).slice(0, 200)}`);
  return rows;
};
/** Every numeric leaf of a payload, by path. */
function numbers(v: any, path = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof v === "number" && Number.isFinite(v)) out[path] = v;
  else if (Array.isArray(v)) { if (v.length <= 60) v.forEach((x, i) => numbers(x, `${path}[${i}]`, out)); }
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) numbers(x, path ? `${path}.${k}` : k, out);
  return out;
}
/** Paths whose value rose by `delta` between two payloads. */
function roseBy(before: any, after: any, delta: number): string[] {
  const a = numbers(before), b = numbers(after);
  return Object.keys(b).filter((k) => k in a && Math.abs(b[k] - a[k] - delta) < 0.005);
}
const AMOUNT = 41.37; // unlikely to collide with a count or another figure
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-asset-rollup-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const created = { profiles: [] as string[], expenses: [] as string[], tasks: [] as string[] };
  try {
    const self = rowsOf(await read("/profiles")).find((p) => p.type === "self");
    if (!self) throw new Error("the smoke account has no self profile");
    const scoped = (path: string) => `${path}${path.includes("?") ? "&" : "?"}profileIds=${self.id}`;

    const asset = await write("POST", "/profiles", { type: "asset", name: `Rollup Asset ${tag}`, fields: { brand: "Test" } });
    created.profiles.push(asset.id);

    // What the dashboard tiles and the Finance page total from: /stats
    // (monthlySpend, task counts) and /dashboard-enhanced (totalMonthlySpend,
    // which the Cash Flow tile subtracts). The dashboard's "Tasks due" tile is
    // counted from the /tasks list itself, checked above.
    const SUMMARIES = ["/stats", "/dashboard-enhanced"];
    const before: Record<string, any> = {};
    for (const p of SUMMARIES) for (const path of [p, scoped(p)]) before[path] = await read(path);

    // Exactly what the asset page's Add Task and Add Expense send.
    const task = await write("POST", "/tasks", { title: `Rollup task ${tag}`, priority: "medium", dueDate: today() });
    created.tasks.push(task.id);
    await write("POST", `/profiles/${asset.id}/link`, { entityType: "task", entityId: task.id });
    const expense = await write("POST", "/expenses", { description: `Rollup expense ${tag}`, amount: AMOUNT, category: "general", categoryChosen: true, date: today(), linkedProfiles: [asset.id] });
    created.expenses.push(expense.id);

    // ── the task ─────────────────────────────────────────────────────────
    const detail = await read(`/profiles/${asset.id}/detail`);
    check((detail.relatedTasks || []).some((t: any) => t.id === task.id), "the task is on the asset");
    check(rowsOf(await read("/tasks")).some((t) => t.id === task.id), "the task is in the main Tasks list (Everyone)");
    check(rowsOf(await read(scoped("/tasks"))).some((t) => t.id === task.id), 'the task is in the main Tasks list with "me" selected');

    // ── the expense ──────────────────────────────────────────────────────
    check((detail.relatedExpenses || []).some((e: any) => e.id === expense.id), "the expense is on the asset");
    check(rowsOf(await read("/expenses")).some((e) => e.id === expense.id), "the expense is in the main expense list (Everyone)");
    check(rowsOf(await read(scoped("/expenses"))).some((e) => e.id === expense.id), 'the expense is in the main expense list with "me" selected');

    // ── the totals ───────────────────────────────────────────────────────
    for (const p of SUMMARIES) {
      for (const path of [p, scoped(p)]) {
        const after = await read(path);
        const money = roseBy(before[path], after, AMOUNT);
        const label = path.includes("profileIds") ? `${p} with "me" selected` : `${p} (Everyone)`;
        check(money.length > 0, `${label} counts the $${AMOUNT} expense${money.length ? ` (${money.slice(0, 3).join(", ")})` : ""}`);
        if (p === "/stats") {
          const counts = roseBy(before[path], after, 1).filter((k) => /task/i.test(k));
          check(counts.length > 0, `${label} counts the task${counts.length ? ` (${counts.slice(0, 3).join(", ")})` : ""}`);
        }
      }
    }
  } finally {
    for (const id of created.tasks) await api("DELETE", `/tasks/${id}`).catch(() => undefined);
    for (const id of created.expenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const id of created.profiles) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
