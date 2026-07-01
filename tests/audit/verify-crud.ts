/**
 * End-to-end CRUD audit: for every user-facing entity, run the full journey a
 * button drives — Create → read-back → Update → Delete — against the live API as
 * the real test account, recording HTTP status, DB persistence, and latency.
 * Plus a validation probe (invalid body must 400, not 500/201).
 *
 * Run: npx tsx tests/audit/verify-crud.ts
 * Throttled to ~1 write/sec to stay under the 60/min server rate limit.
 */
import { api } from "../smoke/fixture/api";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const soon = new Date(Date.now() + 86400000).toISOString();

type Entity = {
  name: string;
  endpoint: string;
  create: any;
  update?: Record<string, any>;        // PATCH body (omit if no update endpoint)
  canDelete?: boolean;                 // has DELETE /:id
  readCheck?: (row: any) => boolean;   // assert saved field persisted
  invalid?: any;                       // body that must be rejected (400)
};

const entities: Entity[] = [
  { name: "expense", endpoint: "/expenses", create: { description: "AUDIT_exp", amount: 12.5, category: "food", date: today, tags: [] }, update: { amount: 99.99 }, canDelete: true, readCheck: r => r.amount === 99.99, invalid: { description: "", amount: -5 } },
  { name: "income", endpoint: "/incomes", create: { description: "AUDIT_inc", amount: 100, category: "salary", frequency: "monthly", date: today, tags: [] }, update: { amount: 250 }, canDelete: true, readCheck: r => r.amount === 250, invalid: { description: "x", amount: -1 } },
  { name: "obligation", endpoint: "/obligations", create: { name: "AUDIT_bill", amount: 20, frequency: "monthly", category: "bill", nextDueDate: today, autopay: false }, update: { amount: 33 }, canDelete: true, readCheck: r => Number(r.amount) === 33, invalid: { name: "", amount: 10 } },
  { name: "task", endpoint: "/tasks", create: { title: "AUDIT_task" }, update: { title: "AUDIT_task_edited" }, canDelete: true, readCheck: r => r.title === "AUDIT_task_edited", invalid: { title: "" } },
  { name: "habit", endpoint: "/habits", create: { name: "AUDIT_habit", frequency: "daily" }, update: { name: "AUDIT_habit_v2" }, canDelete: true, readCheck: r => r.name === "AUDIT_habit_v2", invalid: { name: "" } },
  { name: "event", endpoint: "/events", create: { title: "AUDIT_event", date: today, category: "personal" }, update: { title: "AUDIT_event_v2" }, canDelete: true, readCheck: r => r.title === "AUDIT_event_v2", invalid: { title: "", date: today } },
  { name: "goal", endpoint: "/goals", create: { title: "AUDIT_goal", type: "savings", target: 1000, unit: "USD" }, update: { target: 2000 }, canDelete: true, readCheck: r => Number(r.target) === 2000, invalid: { title: "x", type: "not_a_type", target: 1, unit: "x" } },
  { name: "tracker", endpoint: "/trackers", create: { name: "AUDIT_tracker", category: "custom", fields: [{ name: "value", type: "number", isPrimary: true }] }, update: { name: "AUDIT_tracker_v2" }, canDelete: true, readCheck: r => r.name === "AUDIT_tracker_v2", invalid: { name: "" } },
  { name: "budget", endpoint: "/budgets", create: { category: "food", amount: 400, month: today.slice(0, 7) }, update: { amount: 500 }, canDelete: true, readCheck: r => Number(r.amount) === 500, invalid: { category: "", amount: -10 } },
  { name: "journal", endpoint: "/journal", create: { content: "AUDIT_note", mood: "neutral", tags: [] }, update: { content: "AUDIT_note_v2" }, canDelete: true, readCheck: r => r.content === "AUDIT_note_v2", invalid: { content: "" } },
  { name: "reminder", endpoint: "/reminders", create: { title: "AUDIT_reminder", fireAt: soon }, canDelete: false, invalid: { title: "" } },
  { name: "profile(person)", endpoint: "/profiles", create: { name: "AUDIT Person", type: "person", tags: [] }, update: { name: "AUDIT Person Edited" }, canDelete: true, readCheck: r => r.name === "AUDIT Person Edited", invalid: { name: "", type: "person" } },
  { name: "asset", endpoint: "/profiles", create: { name: "AUDIT_asset", type: "asset", fields: { currentValue: 500 }, tags: [] }, update: { fields: { currentValue: 750 } }, canDelete: true, readCheck: r => Number(r.fields?.currentValue) === 750, invalid: { name: "", type: "asset" } },
  { name: "liability", endpoint: "/profiles", create: { name: "AUDIT_liab", type: "liability", fields: { balance: 300 }, tags: [] }, update: { fields: { balance: 150 } }, canDelete: true, readCheck: r => Number(r.fields?.balance) === 150, invalid: { name: "", type: "liability" } },
  { name: "paycheck", endpoint: "/paychecks", create: { source: "AUDIT_pay", amount: 1000, expected_date: today }, canDelete: true, invalid: { source: "", amount: 100, expected_date: today } },
];

async function timed<T>(fn: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - t };
}

(async () => {
  const rows: string[] = [];
  let pass = 0, fail = 0;
  for (const e of entities) {
    const steps: string[] = [];
    let ok = true;
    let id: string | undefined;
    try {
      // CREATE
      const { r: cr, ms: cms } = await timed(() => api("POST", e.endpoint, e.create));
      id = cr.data?.id;
      const cOk = cr.ok && !!id;
      steps.push(`create ${cr.status}${cOk ? "" : `!(${JSON.stringify(cr.data).slice(0, 60)})`} ${cms}ms`);
      ok &&= cOk;
      await sleep(1100);

      // UPDATE + read-back
      if (id && e.update) {
        const { r: ur, ms: ums } = await timed(() => api("PATCH", `${e.endpoint}/${id}`, e.update));
        let persisted = ur.ok;
        if (ur.ok && e.readCheck) persisted = e.readCheck(ur.data) || e.readCheck((await api("GET", `${e.endpoint}/${id}`)).data);
        steps.push(`update ${ur.status}${persisted ? "" : "!persist"} ${ums}ms`);
        ok &&= persisted;
        await sleep(1100);
      }

      // VALIDATION probe (must reject)
      if (e.invalid) {
        const vr = await api("POST", e.endpoint, e.invalid);
        const rejected = vr.status === 400 || vr.status === 409 || vr.status === 422;
        steps.push(`validate ${vr.status}${rejected ? "✓" : "!SHOULD-REJECT"}`);
        ok &&= rejected;
        // clean up if the invalid body wrongly created a row
        if (vr.ok && vr.data?.id) await api("DELETE", `${e.endpoint}/${vr.data.id}`);
        await sleep(1100);
      }

      // DELETE
      if (id && e.canDelete) {
        const { r: dr, ms: dms } = await timed(() => api("DELETE", `${e.endpoint}/${id}`));
        steps.push(`delete ${dr.status} ${dms}ms`);
        ok &&= dr.ok || dr.status === 204;
        await sleep(1100);
      } else if (id) {
        steps.push("delete n/a");
      }
    } catch (err: any) {
      steps.push(`THREW ${err?.message}`);
      ok = false;
    }
    rows.push(`${ok ? "✅" : "❌"} ${e.name.padEnd(16)} | ${steps.join(" · ")}`);
    ok ? pass++ : fail++;
  }
  console.log("\n=== CRUD audit (create → update → validate → delete, live) ===\n");
  console.log(rows.join("\n"));
  console.log(`\n${pass} pass / ${fail} fail of ${entities.length} entities.\n`);
})();
