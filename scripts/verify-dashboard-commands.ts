/**
 * Live per-tab AI command sweep — the end-to-end half of "test the AI chat like
 * an MCP server." Drives the REAL /api/chat with natural-language commands
 * grouped by dashboard tab, then verifies each write actually landed (GET +
 * marker match) and cleans up. Complements tests/audit/verify-ai.ts (core
 * creates) by covering the dashboard-BUTTON actions: pay, complete, check-in,
 * log tracker entry, set budget, update profile.
 *
 * Needs a live server + Supabase + Anthropic key (uses the smoke account).
 * NOT part of default CI — run on demand:
 *   npx tsx scripts/verify-dashboard-commands.ts
 * Throttled ~3.6s to stay under the 20/min chat rate limit.
 */
import { api } from "../tests/smoke/fixture/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const month = new Date().toISOString().slice(0, 7);
const TAG = `SWEEP_${Date.now().toString(36)}`;

type Step = {
  tab: string;
  name: string;
  message: string;
  // Return true when the intended effect is observable via the API.
  verify: () => Promise<boolean>;
};

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  return Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.budgets || r.data?.goals || []);
}

(async () => {
  // ── Seed a few rows the "state-change" commands can act on ──
  const seededTaskId = (await api("POST", "/tasks", { title: `${TAG}_task` })).data?.id;
  const seededHabit = (await api("POST", "/habits", { name: `${TAG}_habit`, frequency: "daily" })).data;
  const seededTracker = (await api("POST", "/trackers", {
    name: `${TAG}_weight`, category: "health", unit: "lbs",
    fields: [{ name: "weight", type: "number", unit: "lbs", isPrimary: true }],
  })).data;
  const seededBill = (await api("POST", "/obligations", {
    name: `${TAG}_bill`, amount: 42, frequency: "monthly", kind: "bill",
    nextDueDate: new Date().toISOString().slice(0, 10),
  })).data;
  const seededProfile = (await api("POST", "/profiles", { type: "person", name: `${TAG} Person` })).data;

  const steps: Step[] = [
    // ── Finance tab ──
    { tab: "Finance", name: "add expense", message: `Add an expense called ${TAG}_exp for $13.37`,
      verify: async () => (await list("/expenses")).some((r) => (r.description || "").includes(`${TAG}_exp`)) },
    { tab: "Finance", name: "add income", message: `Add monthly income called ${TAG}_inc for $137`,
      verify: async () => (await list("/incomes")).some((r) => (r.description || r.name || "").includes(`${TAG}_inc`)) },
    { tab: "Finance", name: "set budget", message: "Set a groceries budget of $321 for this month",
      verify: async () => (await list(`/budgets?month=${month}`)).some((r) => r.category === "groceries" && Number(r.amount) === 321) },
    { tab: "Finance", name: "pay bill", message: `Pay the ${TAG}_bill bill`,
      verify: async () => { const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_bill`)); return !!(b?.payments?.length); } },

    // ── Executive tab ──
    { tab: "Executive", name: "add task", message: `Add a task called ${TAG}_task2`,
      verify: async () => (await list("/tasks")).some((r) => (r.title || "").includes(`${TAG}_task2`)) },
    { tab: "Executive", name: "complete task", message: `Mark the ${TAG}_task task done`,
      verify: async () => (await list("/tasks")).some((r) => (r.title || "").includes(`${TAG}_task`) && (r.completed || r.status === "completed")) },
    { tab: "Executive", name: "add goal", message: `Create a savings goal called ${TAG}_goal to save $1000`,
      verify: async () => (await list("/goals")).some((r) => (r.title || "").includes(`${TAG}_goal`)) },
    { tab: "Executive", name: "add event", message: `Add a calendar event called ${TAG}_event for today`,
      verify: async () => (await list("/events")).some((r) => (r.title || "").includes(`${TAG}_event`)) },

    // ── Wellness tab ──
    { tab: "Wellness", name: "check in habit", message: `Mark the ${TAG}_habit habit done for today`,
      verify: async () => { const h = (await list("/habits")).find((x) => (x.name || "").includes(`${TAG}_habit`)); const today = new Date().toISOString().slice(0, 10); return !!(h?.checkins || []).some((c: any) => (c.date || "").startsWith(today)); } },
    { tab: "Wellness", name: "log tracker entry", message: `Log my ${TAG}_weight as 176 lbs`,
      verify: async () => { const t = (await list("/trackers")).find((x) => (x.name || "").includes(`${TAG}_weight`)); return !!(t?.entries || []).length; } },

    // ── Info tab ──
    { tab: "Info", name: "update profile", message: `Set ${TAG} Person's phone number to 555-0100`,
      verify: async () => { const p = (await list("/profiles")).find((x) => (x.name || "").includes(`${TAG} Person`)); const f = JSON.stringify(p?.fields || {}); return f.includes("555-0100"); } },
  ];

  console.log(`\n── AI dashboard command sweep (${TAG}) ──\n`);
  const results: string[] = [];
  let pass = 0;
  for (const s of steps) {
    const label = `[${s.tab}] ${s.name.padEnd(18)}`;
    try {
      const res = await api("POST", "/chat", { message: s.message });
      if (res.status === 429) { await sleep(6000); }
      await sleep(1500);
      const ok = await s.verify();
      if (ok) { pass++; results.push(`✅ ${label} "${s.message.slice(0, 46)}"`); }
      else results.push(`❌ ${label} NOT observed [chat ${res.status}]`);
    } catch (e: any) {
      results.push(`💥 ${label} ${e?.message || e}`);
    }
    await sleep(3600); // stay under 20/min
  }

  // ── Cleanup seeded + created rows by tag ──
  for (const ep of ["/tasks", "/goals", "/events", "/expenses", "/incomes", "/trackers", "/obligations", "/habits", "/profiles"]) {
    for (const row of await list(ep)) {
      const s = JSON.stringify(row);
      if (s.includes(TAG)) { try { await api("DELETE", `${ep}/${row.id}`); } catch { /* best effort */ } }
    }
  }
  void seededTaskId; void seededHabit; void seededTracker; void seededBill; void seededProfile;

  console.log(results.join("\n"));
  console.log(`\n${pass}/${steps.length} dashboard commands verified.\n`);
  process.exit(pass === steps.length ? 0 : 1);
})();
