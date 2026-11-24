// Live check (production, smoke account) for the Finance workflows no test
// drove before the workflow matrix (docs/WORKFLOW_MATRIX.md, 2026-11-24):
//
//   expense   create → read one → edit → delete → restore → delete
//   income    create → duplicate is a question → edit → delete → gone
//   paycheck  expect → same one again is the same row → confirm → delete → 404s
//   budget    set → edit → copy to next month → delete
//   cashflow  upsert a week → read it back
//   import    preview → commit → history → undo → rows gone
//   reads     every Finance tab endpoint answers, with its shape, in time
//
// Every write is read back from the list a screen reads; every bad input must
// be a 4xx with a reason, never a 500. Takes the gate lock, writes only what
// it creates and removes it when done.
//   npx tsx tests/live-finance-workflows-check.ts
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

/** A read slower than this is reported (the route budget is 1.5 s to usable). */
const SLOW_MS = 1500;
const timings: Array<{ call: string; ms: number }> = [];

async function call(method: string, path: string, body?: any) {
  // `ms` is the request itself: waiting out the smoke account's write limit is not the server being slow.
  const r = await api(method, path, body);
  timings.push({ call: `${method} ${path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`, ms: r.ms });
  return r;
}
const list = (data: any): any[] => {
  if (Array.isArray(data)) return data;
  for (const k of ["items", "budgets", "transactions", "accounts", "connections", "runs", "candidates", "transfers", "recurring"]) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  throw new Error(`not a list: ${JSON.stringify(data).slice(0, 160)}`);
};
const detail = (r: { status: number; data: any }) => `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`;
/** A refused input: a 4xx carrying a reason. */
const refused = (r: { status: number; data: any }) => r.status >= 400 && r.status < 500 && typeof r.data?.error === "string";

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-finance-workflows-check" });
  const tag = `WF${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}; run ${tag}`);
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    // ── Expense ───────────────────────────────────────────────────────────
    console.log("\n— expense");
    const ex = await call("POST", "/expenses", { description: `${tag} coffee`, amount: 4.5, category: "food", date: today });
    check(ex.ok && !!ex.data?.id, `create an expense (${detail(ex)})`);
    const exId = ex.data?.id;
    if (exId) {
      cleanup.push(() => api("DELETE", `/expenses/${exId}`));
      const one = await call("GET", `/expenses/${exId}`);
      check(one.ok && Number(one.data?.amount) === 4.5, `read it back by id: amount ${one.data?.amount}`);
      const inList = () => call("GET", "/expenses").then((r) => list(r.data).find((e) => e.id === exId));
      check(!!(await inList()), "it is in the expenses list");
      const patched = await call("PATCH", `/expenses/${exId}`, { amount: 5.25 });
      check(patched.ok && Number((await inList())?.amount) === 5.25, `edit the amount → the list shows 5.25 (${patched.status})`);
      check((await inList())?.category === "food", "an edit of the amount left the category alone");
      const del = await call("DELETE", `/expenses/${exId}`);
      check(del.ok && !(await inList()), `delete → gone from the list (${del.status})`);
      const restored = await call("POST", `/expenses/${exId}/restore`);
      check(restored.ok && Number((await inList())?.amount) === 5.25, `restore → back in the list with its amount (${detail(restored)})`);
      const again = await call("DELETE", `/expenses/${exId}`);
      check(again.ok && !(await inList()), "delete again → gone");
    }
    check(refused(await call("POST", "/expenses", { description: `${tag} bad`, amount: "abc", date: today })), "an expense with amount \"abc\" is refused with a reason");
    check(refused(await call("POST", `/expenses/00000000-0000-4000-8000-000000000000/restore`)), "restoring an expense that does not exist is refused");

    // ── Income ────────────────────────────────────────────────────────────
    console.log("\n— income");
    const incBody = { description: `${tag} freelance`, amount: 321.12, date: today, frequency: "one_time" };
    const inc = await call("POST", "/incomes", incBody);
    check(inc.status === 201 && !!inc.data?.id, `create an income (${detail(inc)})`);
    const incId = inc.data?.id;
    if (incId) {
      cleanup.push(() => api("DELETE", `/incomes/${incId}`));
      const inList = () => call("GET", "/incomes").then((r) => list(r.data).find((e) => e.id === incId));
      check(Number((await inList())?.amount) === 321.12, "it is in the incomes list with its amount");
      const dup = await call("POST", "/incomes", incBody);
      check(dup.status === 409 && dup.data?.code === "POSSIBLE_DUPLICATE", `the same income again is a question, not a second row (${dup.status})`);
      if (dup.ok && dup.data?.id) cleanup.push(() => api("DELETE", `/incomes/${dup.data.id}`));
      const patched = await call("PATCH", `/incomes/${incId}`, { amount: 400 });
      const after = await inList();
      check(patched.ok && Number(after?.amount) === 400 && after?.description === incBody.description, `edit the amount → 400, description kept (${patched.status})`);
      const del = await call("DELETE", `/incomes/${incId}`);
      check(del.ok && !(await inList()), "delete → gone from the list");
      check((await call("DELETE", `/incomes/${incId}`)).status === 404, "deleting it a second time is a 404, not a success");
    }
    check(refused(await call("POST", "/incomes", { description: `${tag} bad`, amount: -5 })), "a negative income is refused with a reason");

    // ── Paycheck ──────────────────────────────────────────────────────────
    console.log("\n— paycheck");
    const pcBody = { source: `${tag} Employer`, amount: 1234.56, expected_date: today };
    const pc = await call("POST", "/paychecks", pcBody);
    check(pc.ok && !!pc.data?.id, `log an expected paycheck (${detail(pc)})`);
    const pcId = pc.data?.id;
    if (pcId) {
      cleanup.push(() => api("DELETE", `/paychecks/${pcId}`));
      const inList = () => call("GET", "/paychecks").then((r) => list(r.data).find((e) => e.id === pcId));
      check(Number((await inList())?.amount) === 1234.56, "it is in the paychecks list");
      const same = await call("POST", "/paychecks", pcBody);
      check(same.ok && same.data?.id === pcId, "the identical paycheck again answers the same row");
      if (same.data?.id && same.data.id !== pcId) cleanup.push(() => api("DELETE", `/paychecks/${same.data.id}`));
      const badConfirm = await call("PATCH", `/paychecks/${pcId}/confirm`, { actual_amount: "abc" });
      check(refused(badConfirm), `confirming with amount "abc" is refused with a reason (${detail(badConfirm)})`);
      check((await inList())?.confirmed !== true, "… and the paycheck is still unconfirmed");
      const conf = await call("PATCH", `/paychecks/${pcId}/confirm`, { actual_amount: 1200 });
      const after = await inList();
      check(conf.ok && after?.confirmed === true && Number(after?.actual_amount) === 1200, `confirm received at 1200 → the list says so (${detail(conf)})`);
      const del = await call("DELETE", `/paychecks/${pcId}`);
      check(del.ok && !(await inList()), "delete → gone from the list");
      const ghost = await call("PATCH", `/paychecks/${pcId}/confirm`, {});
      check(ghost.status === 404, `confirming a paycheck that is gone is a 404 (${detail(ghost)})`);
      check((await call("DELETE", `/paychecks/${pcId}`)).status === 404, "deleting it a second time is a 404");
    }
    check(refused(await call("POST", "/paychecks", { source: `${tag} X`, amount: 0, expected_date: today })), "a zero paycheck is refused");
    check(refused(await call("POST", "/paychecks", { source: `${tag} X`, amount: 10, expected_date: "not a date" })), "a paycheck with a junk date is refused");

    // ── Budget ────────────────────────────────────────────────────────────
    console.log("\n— budget");
    const category = `${tag.toLowerCase()}-cat`;
    const bud = await call("POST", "/budgets", { month, category, amount: 150 });
    check(bud.ok && !!bud.data?.id, `set a budget (${detail(bud)})`);
    const budId = bud.data?.id;
    const next = (() => { const [y, m] = month.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; })();
    if (budId) {
      cleanup.push(() => api("DELETE", `/budgets/${budId}?month=${month}`));
      const find = (m: string) => call("GET", `/budgets?month=${m}`).then((r) => list(r.data).find((b) => b.category === category));
      check(Number((await find(month))?.amount) === 150, "it is in this month's budgets at 150");
      const patched = await call("PATCH", `/budgets/${budId}?month=${month}`, { amount: 175 });
      check(patched.ok && Number((await find(month))?.amount) === 175, "edit → 175");
      check(refused(await call("PATCH", `/budgets/${budId}?month=${month}`, { amount: "abc" })), "a budget edit with amount \"abc\" is refused");
      const copy = await call("POST", "/budgets/copy", { fromMonth: month, toMonth: next });
      const copied = await find(next);
      check(copy.ok && Number(copied?.amount) === 175, `copy to ${next} → the budget is there at 175 (${detail(copy)})`);
      if (copied?.id) {
        const d2 = await call("DELETE", `/budgets/${copied.id}?month=${next}`);
        check(d2.ok && !(await find(next)), `delete the copy in ${next}`);
      }
      const del = await call("DELETE", `/budgets/${budId}?month=${month}`);
      check(del.ok && !(await find(month)), "delete → gone from this month");
      check((await call("DELETE", `/budgets/${budId}?month=${month}`)).status === 404, "deleting it a second time is a 404");
    }
    check(refused(await call("POST", "/budgets", { month: "2026-13", category, amount: 5 })), "a budget for month 2026-13 is refused");

    // ── Cashflow ──────────────────────────────────────────────────────────
    console.log("\n— cashflow");
    // A far-future month nobody looks at, so the smoke account's real months stay clean.
    const cfMonth = "2099-01";
    const cf = await call("POST", "/cashflow", { month: cfMonth, week: 2, projected_income: 1000, projected_expenses: 640.5 });
    check(cf.ok, `upsert a cashflow week (${detail(cf)})`);
    const cfRow = list((await call("GET", `/cashflow?month=${cfMonth}`)).data).find((w) => Number(w.week) === 2);
    check(Number(cfRow?.projected_expenses) === 640.5 && Number(cfRow?.projected_income) === 1000, "read it back: 1000 in, 640.50 out");
    const cf2 = await call("POST", "/cashflow", { month: cfMonth, week: 2, projected_income: 0, projected_expenses: 0 });
    const weeks = list((await call("GET", `/cashflow?month=${cfMonth}`)).data).filter((w) => Number(w.week) === 2);
    check(cf2.ok && weeks.length === 1 && Number(weeks[0].projected_income) === 0, "writing the same week again updates it (one row)");
    check(refused(await call("POST", "/cashflow", { month: cfMonth, week: 6 })), "week 6 is refused");
    check(refused(await call("POST", "/cashflow", { month: cfMonth, week: 1, projected_income: "abc" })), "a non-numeric projection is refused");

    // ── Import → undo ─────────────────────────────────────────────────────
    console.log("\n— import");
    const payload = {
      transactions: [
        { unique_id: `${tag}-t1`, date: today, amount: 12.34, merchant: `${tag} Bakery`, category: "food", type: "expense" },
        { unique_id: `${tag}-t2`, date: today, amount: 56.78, merchant: `${tag} Hardware`, category: "home", type: "expense" },
      ],
    };
    const mine = () => call("GET", "/expenses").then((r) => list(r.data).filter((e) => String(e.description || e.vendor || "").includes(tag) && /Bakery|Hardware/.test(String(e.description || e.vendor || ""))));
    const preview = await call("POST", "/finance-import/preview", { json: payload });
    check(preview.ok && preview.data?.ok === true && preview.data?.recordCount === 2, `preview reads 2 records (${detail(preview)})`);
    check((await mine()).length === 0, "a preview wrote nothing");
    const bad = await call("POST", "/finance-import/preview", { json: { transactions: [{ merchant: "no id" }] } });
    check(bad.status === 422 && Array.isArray(bad.data?.errors) && bad.data.errors.length > 0, "an invalid file is a 422 naming what is wrong");
    const commit = await call("POST", "/finance-import/commit", { json: payload });
    const batchId = commit.data?.batchId;
    check(commit.ok && commit.data?.ok === true && !!batchId, `commit (${detail(commit)})`);
    if (batchId) {
      let undone = false;
      cleanup.push(async () => { if (!undone) await api("POST", `/finance-import/${batchId}/undo`); });
      check((await mine()).length === 2, "both transactions are in the expenses list");
      const hist = await call("GET", "/finance-import/history");
      check(list(hist.data).some((h) => h.id === batchId), "the import is in the history");
      const twice = await call("POST", "/finance-import/commit", { json: payload });
      check((await mine()).length === 2, `importing the same file again adds nothing (${twice.status})`);
      if (twice.data?.batchId && twice.data.batchId !== batchId) cleanup.push(() => api("POST", `/finance-import/${twice.data.batchId}/undo`));
      const undo = await call("POST", `/finance-import/${batchId}/undo`);
      undone = undo.ok;
      check(undo.ok && (await mine()).length === 0, `undo → both rows gone (${detail(undo)})`);
    }
    const noSuch = await call("POST", "/finance-import/00000000-0000-4000-8000-000000000000/undo");
    check(noSuch.status === 404, "undoing an import that does not exist is a 404");

    // ── Reads behind the Finance tab ──────────────────────────────────────
    console.log("\n— reads");
    const reads: Array<[string, (d: any) => boolean]> = [
      ["/finance/config", (d) => d && typeof d === "object"],
      ["/finance/connections", (d) => Array.isArray(list(d))],
      ["/finance/sync-runs", (d) => Array.isArray(list(d))],
      ["/finance/accounts", (d) => Array.isArray(list(d))],
      ["/finance/transactions", (d) => Array.isArray(list(d))],
      ["/finance/match-candidates", (d) => d && typeof d === "object"],
      ["/finance/transfers", (d) => d && typeof d === "object"],
      ["/finance/recurring", (d) => d && typeof d === "object"],
      ["/finance/summary", (d) => d && typeof d === "object" && !Array.isArray(d)],
      ["/finance/cashflow", (d) => d && typeof d === "object"],
      ["/finance/spending", (d) => d && typeof d === "object"],
      ["/finance/income", (d) => d && typeof d === "object"],
      ["/finance/liabilities", (d) => d && typeof d === "object"],
      ["/anomalies", (d) => d && typeof d === "object"],
      ["/paychecks", (d) => Array.isArray(d)],
      [`/budgets?month=${month}`, (d) => Array.isArray(d?.budgets)],
      [`/cashflow?month=${month}`, (d) => Array.isArray(d)],
      ["/incomes", (d) => Array.isArray(list(d))],
      ["/expenses", (d) => Array.isArray(list(d))],
      ["/net-worth/history", (d) => d && typeof d === "object"],
    ];
    for (const [path, shape] of reads) {
      const r = await call("GET", path);
      let ok = false;
      try { ok = r.ok && shape(r.data); } catch { ok = false; }
      check(ok, `GET ${path} answers with its shape (${r.status}, ${r.ms}ms)`);
    }
  } finally {
    for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
    await api("POST", "/cashflow", { month: "2099-01", week: 2, projected_income: 0, projected_expenses: 0 }).catch(() => undefined);
    await release();
  }

  // ── Speed ───────────────────────────────────────────────────────────────
  const byCall = new Map<string, number[]>();
  for (const t of timings) byCall.set(t.call, [...(byCall.get(t.call) ?? []), t.ms]);
  const worst = [...byCall.entries()].map(([c, ms]) => ({ call: c, max: Math.max(...ms), n: ms.length })).sort((a, b) => b.max - a.max);
  console.log("\n— slowest calls (worst of n)");
  for (const w of worst.slice(0, 10)) console.log(`  ${String(w.max).padStart(5)}ms  ${w.call}  (n=${w.n})`);
  const slow = worst.filter((w) => w.max > SLOW_MS);
  console.log(slow.length ? `\nSLOW  ${slow.length} call(s) over ${SLOW_MS}ms: ${slow.map((s) => `${s.call} ${s.max}ms`).join("; ")}` : `\nno call over ${SLOW_MS}ms`);

  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
