/**
 * One-off proof that every dashboard "Add" button's endpoint actually saves:
 * POST the same body the form sends → confirm a 2xx + persisted id → clean up.
 * Run: npx tsx tests/smoke/verify-add-buttons.ts
 */
import { api } from "./fixture/api";

type Check = { name: string; endpoint: string; body: any; del?: (id: string) => string };

const today = new Date().toISOString().slice(0, 10);
const checks: Check[] = [
  { name: "Add expense", endpoint: "/expenses", body: { description: "VERIFY_exp", amount: 12.5, category: "food", date: today, tags: [] }, del: (id) => `/expenses/${id}` },
  { name: "Add income", endpoint: "/incomes", body: { description: "VERIFY_inc", amount: 100, category: "salary", frequency: "monthly", date: today, tags: [] }, del: (id) => `/incomes/${id}` },
  { name: "Add bill", endpoint: "/obligations", body: { name: "VERIFY_bill", amount: 20, frequency: "monthly", category: "bill", nextDueDate: today, autopay: false }, del: (id) => `/obligations/${id}` },
  { name: "Add note", endpoint: "/journal", body: { content: "VERIFY_note", tags: [] }, del: (id) => `/journal/${id}` },
  { name: "Add reminder", endpoint: "/reminders", body: { title: "VERIFY_reminder", fireAt: new Date(Date.now() + 86400000).toISOString() } },
  { name: "Add asset", endpoint: "/profiles", body: { name: "VERIFY_asset", type: "asset", fields: { currentValue: 500 }, tags: [] }, del: (id) => `/profiles/${id}` },
  { name: "Add liability", endpoint: "/profiles", body: { name: "VERIFY_liab", type: "liability", fields: { balance: 300 }, tags: [] }, del: (id) => `/profiles/${id}` },
  { name: "Add task", endpoint: "/tasks", body: { title: "VERIFY_task" }, del: (id) => `/tasks/${id}` },
  { name: "Add habit", endpoint: "/habits", body: { name: "VERIFY_habit", frequency: "daily" }, del: (id) => `/habits/${id}` },
  { name: "Add paycheck", endpoint: "/paychecks", body: { source: "VERIFY_pay", amount: 1000, expected_date: today }, del: (id) => `/paychecks/${id}` },
];

(async () => {
  const results: string[] = [];
  for (const c of checks) {
    try {
      const res = await api("POST", c.endpoint, c.body);
      const id = res.data?.id;
      const ok = res.ok && !!id;
      results.push(`${ok ? "✅" : "❌"} ${c.name.padEnd(14)} POST ${c.endpoint.padEnd(13)} → ${res.status}${id ? ` id=${String(id).slice(0, 8)}` : ` ${JSON.stringify(res.data).slice(0, 80)}`}`);
      if (ok && c.del) await api("DELETE", c.del(id)); // clean up
    } catch (e: any) {
      results.push(`❌ ${c.name.padEnd(14)} threw: ${e?.message}`);
    }
  }
  console.log("\n=== Add-button save verification (live API as smoke account) ===\n");
  console.log(results.join("\n"));
  const passed = results.filter(r => r.startsWith("✅")).length;
  console.log(`\n${passed}/${checks.length} add endpoints saved + returned a persisted id.\n`);
})();
