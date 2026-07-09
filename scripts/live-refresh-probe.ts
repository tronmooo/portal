// Does the DASHBOARD's aggregate data refresh after a chat write? The dashboard
// reads /api/stats + /api/dashboard-enhanced (cached 60s server-side). This
// checks that a chat-created task/expense actually shows up in those aggregates
// right after — i.e. the cache-bust connects the write to the dashboard.
import { api } from "../tests/smoke/fixture/api";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `RFR${Date.now().toString(36).slice(-5)}`;

(async () => {
  const before = await api("GET", "/stats");
  const beforeTasks = (before.data as any)?.activeTasks ?? (before.data as any)?.totalTasks;
  const beforeEnh = await api("GET", "/dashboard-enhanced");
  const beforeSpend = (beforeEnh.data as any)?.financeSnapshot?.totalMonthlySpend;
  console.log(`BEFORE  stats.activeTasks=${beforeTasks}  enhanced.totalMonthlySpend=${beforeSpend}`);

  console.log(`\n→ chat: "Add a task ${TAG}" and "Add an expense ${TAG}_x for $99"`);
  await api("POST", "/chat", { message: `Add a task ${TAG}` });
  await sleep(3600);
  await api("POST", "/chat", { message: `Add an expense ${TAG}_x for $99` });
  await sleep(2500); // settle

  const after = await api("GET", "/stats");
  const afterTasks = (after.data as any)?.activeTasks ?? (after.data as any)?.totalTasks;
  const afterEnh = await api("GET", "/dashboard-enhanced");
  const afterSpend = (afterEnh.data as any)?.financeSnapshot?.totalMonthlySpend;
  console.log(`AFTER   stats.activeTasks=${afterTasks}  enhanced.totalMonthlySpend=${afterSpend}`);

  const taskOk = typeof afterTasks === "number" && typeof beforeTasks === "number" && afterTasks > beforeTasks;
  const spendOk = typeof afterSpend === "number" && typeof beforeSpend === "number" && afterSpend >= (beforeSpend + 98);
  console.log(`\nTask reflected in /stats:              ${taskOk ? "✅ YES" : "❌ NO"}`);
  console.log(`Expense reflected in /dashboard-enhanced: ${spendOk ? "✅ YES" : "❌ NO"}`);
  console.log(taskOk && spendOk
    ? "\n→ Dashboard aggregates DO refresh after chat writes (cache-bust connected).\n"
    : "\n→ Dashboard aggregates did NOT reflect the writes — cache-bust / connection broken.\n");

  // cleanup
  for (const ep of ["/tasks", "/expenses"]) {
    const r = await api("GET", ep);
    const list = Array.isArray(r.data) ? r.data : [];
    for (const row of list) if (JSON.stringify(row).includes(TAG)) { try { await api("DELETE", `${ep}/${row.id}`); } catch {} }
  }
  process.exit(taskOk && spendOk ? 0 : 1);
})();
