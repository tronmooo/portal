/**
 * Live per-TOOL CRUD verification for the AI chat — the "test every addition"
 * loop of the 2026-07 CRUD-parity effort. For each newly added tool: seed a
 * fixture via REST, send a natural-language command to the REAL /api/chat,
 * then GET + marker-match to prove the write landed. Cleans up by TAG.
 *
 * Complements (does not replace) scripts/verify-dashboard-commands.ts and
 * tests/audit/verify-ai.ts. Uses the smoke account; costs Anthropic credits.
 * NOT part of default CI — run on demand:
 *   npx tsx scripts/verify-tool-crud.ts                 # all batches
 *   npx tsx scripts/verify-tool-crud.ts --batch=A       # one batch
 *   npx tsx scripts/verify-tool-crud.ts --only=delete_income
 *   npx tsx scripts/verify-tool-crud.ts --sha=<commit>  # wait for deploy first
 * Throttled ~3.6s per chat call to stay under the 20/min chat rate limit.
 */
import { api } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `CRUD_${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const prevMonth = (() => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
})();

type Step = {
  batch: string;
  tool: string;
  message: string;
  /** Seed fixture rows this step acts on. Runs once, before the chat call. */
  seed?: () => Promise<void>;
  /** Return true when the intended effect is observable via the API. */
  verify: () => Promise<boolean>;
  /** More explicit phrasing to retry with when the first phrasing fails routing. */
  retryMessage?: string;
};

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  return Array.isArray(r.data) ? r.data : (r.data?.items || []);
}

// ── Deploy wait: poll /api/version until `sha` matches the pushed commit ──
async function waitForDeploy(sha: string): Promise<void> {
  const deadline = Date.now() + 6 * 60_000;
  process.stdout.write(`Waiting for deploy ${sha.slice(0, 8)} at ${API_BASE} `);
  while (Date.now() < deadline) {
    try {
      const r = await api("GET", "/version");
      const live = String(r.data?.sha || "");
      if (live.startsWith(sha) || sha.startsWith(live) && live.length >= 8) {
        console.log(`— live (${live.slice(0, 8)})`);
        return;
      }
    } catch { /* transient */ }
    process.stdout.write(".");
    await sleep(10_000);
  }
  console.log("");
  throw new Error(`Deploy ${sha.slice(0, 8)} not live after 6 min — is the branch merged to main?`);
}

const STEPS: Step[] = [
  // ── Batch A — Finance ──────────────────────────────────────────────────────
  {
    batch: "A", tool: "update_income",
    seed: async () => { await api("POST", "/incomes", { description: `${TAG}_inc`, amount: 100, frequency: "monthly", category: "freelance" }); },
    message: `Change the ${TAG}_inc income to $250`,
    retryMessage: `Update the income entry called ${TAG}_inc — set its amount to $250`,
    verify: async () => (await list("/incomes")).some((r) => (r.description || "").includes(`${TAG}_inc`) && Number(r.amount) === 250),
  },
  {
    batch: "A", tool: "delete_income",
    seed: async () => { await api("POST", "/incomes", { description: `${TAG}_inc2`, amount: 77, frequency: "once", category: "other" }); },
    message: `Delete the ${TAG}_inc2 income`,
    retryMessage: `Yes — delete the income entry called ${TAG}_inc2`,
    verify: async () => !(await list("/incomes")).some((r) => (r.description || "").includes(`${TAG}_inc2`)),
  },
  {
    batch: "A", tool: "delete_paycheck",
    seed: async () => { await api("POST", "/paychecks", { source: `${TAG}_pay`, amount: 500, expected_date: today }); },
    message: `Delete the ${TAG}_pay expected paycheck`,
    retryMessage: `Yes — remove the expected paycheck from ${TAG}_pay`,
    verify: async () => !(await list("/paychecks")).some((r) => (r.source || "").includes(`${TAG}_pay`)),
  },
  {
    batch: "A", tool: "update_memory",
    seed: async () => { await api("POST", "/memories", { key: `${TAG}_mem`, value: "old value 1", category: "general" }); },
    message: `Update my saved memory ${TAG}_mem — the correct value is "new value 42"`,
    retryMessage: `Change the memory with key ${TAG}_mem to say: new value 42`,
    verify: async () => (await list("/memories")).some((r) => (r.key || "").includes(`${TAG}_mem`) && String(r.value || "").includes("new value 42")),
  },
  {
    batch: "A", tool: "copy_budgets_previous_month",
    seed: async () => { await api("POST", "/budgets", { category: "education", amount: 22133, month: prevMonth }); },
    message: `Copy last month's budgets to this month`,
    verify: async () => {
      const r = await api("GET", `/budgets?month=${month}`);
      const rows = Array.isArray(r.data) ? r.data : (r.data?.budgets || []);
      return rows.some((b: any) => b.category === "education" && Number(b.amount) === 22133);
    },
  },
];

async function cleanup(): Promise<void> {
  for (const ep of ["/incomes", "/paychecks", "/memories", "/tasks", "/habits", "/events", "/expenses", "/obligations", "/artifacts", "/reminders", "/profiles"]) {
    try {
      for (const row of await list(ep)) {
        if (JSON.stringify(row).includes(TAG)) {
          try { await api("DELETE", `${ep}/${row.id}`); } catch { /* best effort */ }
        }
      }
    } catch { /* endpoint may not support GET-all — best effort */ }
  }
  // Budgets need month-scoped deletes and don't carry the TAG — match the
  // sentinel amount instead.
  for (const m of [prevMonth, month]) {
    try {
      const r = await api("GET", `/budgets?month=${m}`);
      const rows = Array.isArray(r.data) ? r.data : (r.data?.budgets || []);
      for (const b of rows) {
        if (Number(b.amount) === 22133) { try { await api("DELETE", `/budgets/${b.id}?month=${m}`); } catch { /* */ } }
      }
    } catch { /* */ }
  }
}

(async () => {
  const args = process.argv.slice(2);
  const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const batch = arg("batch");
  const only = arg("only");
  const sha = arg("sha");

  if (sha) await waitForDeploy(sha);

  let steps = STEPS;
  if (batch) steps = steps.filter((s) => s.batch.toUpperCase() === batch.toUpperCase());
  if (only) steps = steps.filter((s) => s.tool === only);
  if (steps.length === 0) { console.error(`No steps match --batch=${batch} --only=${only}`); process.exit(2); }

  console.log(`\n── AI tool CRUD verification (${TAG}) — ${steps.length} step(s) at ${API_BASE} ──\n`);
  const results: string[] = [];
  let pass = 0;
  for (const s of steps) {
    const label = `[${s.batch}] ${s.tool.padEnd(28)}`;
    try {
      if (s.seed) { await s.seed(); await sleep(800); }
      let res = await api("POST", "/chat", { message: s.message });
      if (res.status === 429) { await sleep(6000); res = await api("POST", "/chat", { message: s.message }); }
      await sleep(1500);
      let ok = await s.verify();
      if (!ok && s.retryMessage) {
        // Routing may need more explicit phrasing — one retry before failing.
        await sleep(3600);
        res = await api("POST", "/chat", { message: s.retryMessage });
        await sleep(1500);
        ok = await s.verify();
      }
      if (ok) { pass++; results.push(`✅ ${label} "${s.message.slice(0, 52)}"`); }
      else results.push(`❌ ${label} write NOT observed [chat ${res.status}] reply: ${String((res.data as any)?.reply || "").slice(0, 120)}`);
    } catch (e: any) {
      results.push(`💥 ${label} ${e?.message || e}`);
    }
    await sleep(3600); // stay under 20 chat calls/min
  }

  await cleanup();

  console.log(results.join("\n"));
  console.log(`\n${pass}/${steps.length} tool CRUD checks verified.\n`);
  process.exit(pass === steps.length ? 0 : 1);
})();
