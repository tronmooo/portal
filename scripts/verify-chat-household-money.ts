/**
 * Live check (production, smoke account): one chat message can log several
 * expenses for several people AND several incomes, and every one is saved.
 *
 * 2026-11-12 report: "Yesterday I spent $65 at Walmart, $42 on gas, and $18
 * on lunch. I also earned $230 doing deliveries." → "I wasn't able to
 * complete that — nothing was saved." Sends that message and a household
 * version naming a second person, then checks the stored rows — not the
 * reply text. Everything it creates is deleted afterwards.
 *
 * Costs Anthropic credits; NOT part of CI. Run on demand:
 *   npx tsx scripts/verify-chat-household-money.ts
 * Takes the smoke account's gate lock while it writes.
 */
import { api, expectOk, fetchWithRateLimitRetry, getSmokeToken } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "../tests/smoke/fixture/gate-lock";

const T = `Zq${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 4)}`;
const PERSON = `${T} Jane`;

type Case = { message: string; expenses: number[]; incomes: number[]; personExpenses: number[]; personIncomes: number[] };
const CASES: Case[] = [
  {
    message: "Yesterday I spent $65 at Walmart, $42 on gas, and $18 on lunch. I also earned $230 doing deliveries.",
    expenses: [18, 42, 65], incomes: [230], personExpenses: [], personIncomes: [],
  },
  {
    message: `Yesterday I spent $37 on gas and $21 on lunch, and ${PERSON} spent $26 on lunch. I earned $510 from work and $140 doing deliveries, and ${PERSON} earned $310 babysitting.`,
    expenses: [21, 26, 37], incomes: [140, 310, 510], personExpenses: [26], personIncomes: [310],
  },
];

const list = (d: any): any[] => {
  const rows = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.items) ? d.items : null;
  if (!rows) throw new Error(`unexpected list shape: ${JSON.stringify(d).slice(0, 200)}`);
  return rows;
};
/** A list read exactly as the app makes it after a chat reply: carrying the
 *  reply's read-your-writes token (x-data-version), without which another
 *  warm server instance may legitimately answer from its pre-write cache. */
async function readAsApp(path: string, dataVersion: unknown): Promise<any[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getSmokeToken()}` };
  if (typeof dataVersion === "string" && dataVersion) headers["x-data-version"] = dataVersion;
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return list(await response.json());
}
const linked = (r: any): string[] => r.linkedProfiles ?? r.linked_profiles ?? [];
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const amounts = (rows: any[]) => sorted(rows.map((r) => Number(r.amount)));

async function main() {
  const release = await acquireGateLock(
    preferenceLockIo((method, path, body) => api(method, path, body)),
    { gate: "verify-chat-household-money" },
  );
  const created: { expenses: string[]; incomes: string[]; profile?: string } = { expenses: [], incomes: [] };
  let failures = 0;
  try {
    const person = expectOk(await api("POST", "/profiles", { name: PERSON, type: "person", fields: {} }), "create person") as any;
    created.profile = person.id;

    for (const c of CASES) {
      const beforeE = new Set(list(expectOk(await api("GET", "/expenses"))).map((r) => r.id));
      const beforeI = new Set(list(expectOk(await api("GET", "/incomes"))).map((r) => r.id));
      const res = await api("POST", "/chat", { message: c.message });
      const reply = String((res.data as any)?.reply ?? "");
      const token = (res.data as any)?.dataVersion;
      const newE = (await readAsApp("/expenses", token)).filter((r) => !beforeE.has(r.id));
      const newI = (await readAsApp("/incomes", token)).filter((r) => !beforeI.has(r.id));
      // The read right after the reply must already show the writes: the app
      // refetches the moment the reply lands. A second read later tells a
      // stale list apart from a missing write.
      await new Promise((r) => setTimeout(r, 4000));
      const laterE = list(expectOk(await api("GET", "/expenses"))).filter((r) => !beforeE.has(r.id));
      const laterI = list(expectOk(await api("GET", "/incomes"))).filter((r) => !beforeI.has(r.id));
      if (laterE.length !== newE.length || laterI.length !== newI.length) {
        console.log(`  STALE READ: right after the reply ${newE.length} expenses / ${newI.length} incomes; 4s later ${laterE.length} / ${laterI.length}`);
      }
      for (const r of laterE) if (!created.expenses.includes(r.id)) created.expenses.push(r.id);
      for (const r of laterI) if (!created.incomes.includes(r.id)) created.incomes.push(r.id);

      const checks: Array<[string, unknown, unknown]> = [
        ["HTTP status", res.status, 200],
        ["expenses saved", amounts(newE), sorted(c.expenses)],
        ["incomes saved", amounts(newI), sorted(c.incomes)],
        [`${PERSON}'s expenses`, amounts(newE.filter((r) => linked(r).includes(person.id))), sorted(c.personExpenses)],
        [`${PERSON}'s incomes`, amounts(newI.filter((r) => linked(r).includes(person.id))), sorted(c.personIncomes)],
        ["reply is not a failure", /nothing was saved|wasn't able|couldn't complete/i.test(reply), false],
      ];
      console.log(`\n> ${c.message}\n  reply: ${reply.replace(/\s+/g, " ").slice(0, 300)}`);
      for (const [name, got, want] of checks) {
        const ok = JSON.stringify(got) === JSON.stringify(want);
        if (!ok) failures++;
        console.log(`  ${ok ? "PASS" : "FAIL"} ${name}: got ${JSON.stringify(got)}${ok ? "" : `, want ${JSON.stringify(want)}`}`);
      }
    }
  } finally {
    for (const id of created.expenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const id of created.incomes) await api("DELETE", `/incomes/${id}`).catch(() => undefined);
    if (created.profile) await api("DELETE", `/profiles/${created.profile}`).catch(() => undefined);
    console.log(`\ncleaned up ${created.expenses.length} expenses, ${created.incomes.length} incomes, 1 profile`);
    await release();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
