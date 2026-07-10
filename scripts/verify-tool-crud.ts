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
    message: `Delete the expected paycheck from ${TAG}_pay`,
    retryMessage: `I have an expected paycheck whose source/employer is "${TAG}_pay" — delete that paycheck entry`,
    verify: async () => !(await list("/paychecks")).some((r) => (r.source || "").includes(`${TAG}_pay`)),
  },
  {
    batch: "A", tool: "update_memory",
    seed: async () => { await api("POST", "/memories", { key: `${TAG}_mem`, value: "old value 1", category: "general" }); },
    message: `Update my saved memory ${TAG}_mem — the correct value is "new value 42"`,
    retryMessage: `Change the memory with key ${TAG}_mem to say: new value 42`,
    verify: async () => (await list("/memories")).some((r) => (r.key || "").includes(`${TAG}_mem`) && String(r.value || "").includes("new value 42")),
  },
  // ── Batch B — Liabilities / bills / loans ──────────────────────────────────
  {
    batch: "B", tool: "undo_last_payment",
    seed: async () => {
      const bill = (await api("POST", "/obligations", { name: `${TAG}_ubill`, amount: 42, frequency: "monthly", kind: "bill", nextDueDate: today })).data;
      await api("POST", `/obligations/${bill.id}/pay`, { amount: 42 });
    },
    message: `Undo the last payment on the ${TAG}_ubill bill`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_ubill`));
      return !!b && !(b.payments || []).length;
    },
  },
  {
    batch: "B", tool: "update_liability_payment",
    seed: async () => {
      const bill = (await api("POST", "/obligations", { name: `${TAG}_pbill`, amount: 60, frequency: "monthly", kind: "bill", nextDueDate: today })).data;
      await api("POST", `/obligations/${bill.id}/pay`, { amount: 60 });
    },
    message: `The ${TAG}_pbill payment I just logged was actually $55 — fix it`,
    retryMessage: `Update the most recent recorded payment on ${TAG}_pbill: set its amount to $55`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_pbill`));
      return !!(b?.payments || []).some((p: any) => Number(p.amount) === 55);
    },
  },
  {
    batch: "B", tool: "delete_liability_payment",
    seed: async () => {
      const bill = (await api("POST", "/obligations", { name: `${TAG}_dbill`, amount: 30, frequency: "monthly", kind: "bill", nextDueDate: today })).data;
      await api("POST", `/obligations/${bill.id}/pay`, { amount: 30 });
      await api("POST", `/obligations/${bill.id}/pay`, { amount: 30 });
    },
    message: `Delete the duplicate payment on ${TAG}_dbill — remove the most recent one`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_dbill`));
      return !!b && (b.payments || []).length === 1;
    },
  },
  {
    batch: "B", tool: "update_obligation (reschedule occurrence)",
    seed: async () => {
      await api("POST", "/obligations", { name: `${TAG}_rbill`, amount: 25, frequency: "monthly", kind: "bill", nextDueDate: today });
    },
    message: `Move the next ${TAG}_rbill payment to the 28th of next month — just that one occurrence, don't change the schedule`,
    verify: async () => {
      const b = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_rbill`));
      if (!b) return false;
      const r = await api("GET", `/liabilities/${b.id}/schedule`);
      const occs: any[] = (r.data as any)?.occurrences || [];
      return occs.some((o) => o.movedTo || o.effectiveDate !== o.date);
    },
  },
  {
    batch: "B", tool: "mark_loan_payment",
    seed: async () => {
      const loanId = `${TAG}_loan`;
      const base = new Date();
      const entries = [1, 2, 3].map((n) => {
        const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
        return {
          loan_id: loanId, loan_name: `${TAG}_loan`, payment_number: n,
          payment_date: d.toISOString().slice(0, 10),
          principal_amount: 80, interest_amount: 20, total_payment: 100,
          remaining_balance: 1000 - n * 80,
        };
      });
      await api("POST", "/loans/schedule", { entries });
    },
    message: `Mark the next ${TAG}_loan payment as paid on the loan schedule`,
    verify: async () => {
      const r = await api("GET", `/loans/schedule`);
      const rows: any[] = Array.isArray(r.data) ? r.data : [];
      return rows.some((row) => (row.loan_name || "").includes(`${TAG}_loan`) && row.paid && Number(row.payment_number) === 1);
    },
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
      const reply = String((res.data as any)?.reply || "");
      if (!ok && /\?|confirm|are you sure|is that correct|should i/i.test(reply)) {
        // Destructive commands ask for confirmation (by design) — answer like
        // the real UI would: a follow-up turn with conversation history.
        await sleep(3600);
        res = await api("POST", "/chat", {
          message: "Yes, that's correct — go ahead.",
          history: [
            { role: "user", content: s.message },
            { role: "assistant", content: reply },
          ],
        });
        await sleep(1500);
        ok = await s.verify();
      }
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
