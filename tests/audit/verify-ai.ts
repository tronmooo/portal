/**
 * AI-parity audit: prove the chat assistant can perform every core data action a
 * button can. Sends a natural-language command to /api/chat, then verifies the
 * row actually landed in the DB (GET + marker match) — the same effect the
 * manual button produces. Cleans up after itself.
 *
 * Run: npx tsx tests/audit/verify-ai.ts
 * Throttled (~3.6s) to stay under the 20/min chat rate limit.
 */
import { api } from "../smoke/fixture/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const month = new Date().toISOString().slice(0, 7);

type Check = {
  name: string;
  message: string;
  // return the created row's id if found (marker match), else null
  find: () => Promise<{ id: string; endpoint: string } | null>;
};

async function findIn(endpoint: string, pred: (row: any) => boolean): Promise<{ id: string; endpoint: string } | null> {
  const r = await api("GET", endpoint);
  const list: any[] = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.budgets || []);
  const hit = list.find(pred);
  return hit ? { id: hit.id, endpoint: endpoint.split("?")[0] } : null;
}

const checks: Check[] = [
  { name: "expense", message: "Add an expense called AUDITAI_exp for $13.37", find: () => findIn("/expenses", r => (r.description || "").includes("AUDITAI_exp")) },
  { name: "income", message: "Add monthly income called AUDITAI_inc for $137", find: () => findIn("/incomes", r => (r.description || "").includes("AUDITAI_inc")) },
  { name: "bill", message: "Add a monthly bill called AUDITAI_bill for $21", find: () => findIn("/obligations", r => (r.name || "").includes("AUDITAI_bill")) },
  { name: "task", message: "Add a task called AUDITAI_task", find: () => findIn("/tasks", r => (r.title || "").includes("AUDITAI_task")) },
  { name: "habit", message: "Create a daily habit called AUDITAI_habit", find: () => findIn("/habits", r => (r.name || "").includes("AUDITAI_habit")) },
  { name: "event", message: "Add a calendar event called AUDITAI_event for today", find: () => findIn("/events", r => (r.title || "").includes("AUDITAI_event")) },
  { name: "goal", message: "Create a savings goal called AUDITAI_goal to save $1000", find: () => findIn("/goals", r => (r.title || "").includes("AUDITAI_goal")) },
  { name: "tracker", message: "Create a tracker called AUDITAI_tracker", find: () => findIn("/trackers", r => (r.name || "").includes("AUDITAI_tracker")) },
  { name: "reminder", message: "Remind me to AUDITAI_reminder tomorrow at noon", find: () => findIn("/reminders", r => (r.title || "").includes("AUDITAI_reminder")) },
  { name: "person", message: "Add a person to my family named AUDITAI Person", find: () => findIn("/profiles", r => (r.name || "").includes("AUDITAI Person")) },
  { name: "asset", message: "Add an asset called AUDITAI_asset worth $500", find: () => findIn("/profiles", r => (r.name || "").includes("AUDITAI_asset")) },
  { name: "note", message: "Add a journal note: AUDITAI_note had a good day", find: () => findIn("/journal", r => (r.content || "").includes("AUDITAI_note")) },
  { name: "budget", message: "Set a food budget of $321 for this month", find: () => findIn(`/budgets?month=${month}`, r => r.category === "food" && Number(r.amount) === 321) },
];

(async () => {
  const rows: string[] = [];
  const cleanup: { id: string; endpoint: string }[] = [];
  let pass = 0;
  for (const c of checks) {
    let line = `${c.name.padEnd(9)} "${c.message.slice(0, 42)}"`;
    try {
      const t = Date.now();
      const res = await api("POST", "/chat", { message: c.message });
      const chatMs = Date.now() - t;
      if (res.status === 429) { rows.push(`⏳ ${line} → rate-limited, backing off`); await sleep(6000); }
      await sleep(1200); // let the write settle
      const found = await c.find();
      if (found) { pass++; cleanup.push(found); rows.push(`✅ ${line} → created (${chatMs}ms)`); }
      else rows.push(`❌ ${line} → NOT created [chat ${res.status}]`);
    } catch (e: any) {
      rows.push(`❌ ${line} → threw ${e?.message}`);
    }
    await sleep(3600); // stay under 20 chat/min
  }
  console.log("\n=== AI-parity audit (natural language → DB effect) ===\n");
  console.log(rows.join("\n"));
  console.log(`\n${pass}/${checks.length} AI commands produced the expected row.\n`);
  // cleanup
  for (const c of cleanup) { try { await api("DELETE", `${c.endpoint}/${c.id}`); await sleep(400); } catch {} }
  console.log(`Cleaned up ${cleanup.length} rows.`);
})();
