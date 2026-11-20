// Live check (production, smoke account) for Auto Pay, end to end: a car
// loan, a mortgage, a phone bill and a subscription, each due TODAY.
//
//   setting → recorded once on the due day → assumed → reconciled / confirmed
//   → partial → missed (reversed) → back to scheduled → delayed → off
//
// and that none of it duplicates a payment or an expense. Then the liability
// page and the Liabilities list in a real browser. Takes the gate lock, writes
// only the records it creates, and deletes them when done.
//   npx tsx tests/live-autopay-check.ts
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { readBalance, readMonthlyPayment } from "../shared/liability-fields";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || ".";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.005;

async function get<T = any>(path: string): Promise<T> {
  const r = await api("GET", path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data as T;
}
async function post<T = any>(path: string, body?: any): Promise<T> {
  const r = await api("POST", path, body ?? {});
  if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data as T;
}
const payments = (id: string) => get<any[]>(`/liabilities/${id}/payments`);
const profile = (id: string) => get<any>(`/profiles/${id}`);
async function expensesOf(liabilityId: string): Promise<any[]> {
  const data: any = await get("/expenses");
  const rows: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return rows.filter((e) => Array.isArray(e.tags) && e.tags.includes(`liability:${liabilityId}`));
}
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-autopay-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const ids: string[] = [];
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

    // The server's "today" for this account (nothing of ours exists yet).
    const { today } = await post<{ today: string }>("/autopay/run");
    const day = Number(today.slice(8, 10));
    console.log(`server today: ${today}`);

    const create = async (body: any) => {
      const made = await api("POST", "/profiles", body);
      if (!made.ok) throw new Error(`create ${body.name}: ${made.status} ${JSON.stringify(made.data).slice(0, 200)}`);
      ids.push(made.data.id);
      return made.data.id as string;
    };
    const car = await create({ type: "liability", type_key: "auto_loan", name: `Autopay Check Car Loan ${tag}`, fields: { balance: 15000, originalBalance: 22000, interestRate: 6, monthlyPayment: 400, dueDay: day } });
    const home = await create({ type: "liability", type_key: "mortgage", name: `Autopay Check Mortgage ${tag}`, fields: { balance: 300000, originalBalance: 340000, interestRate: 6.25, monthlyPayment: 2100, dueDay: day } });
    const phone = await create({ type: "liability", type_key: "phone_plan", name: `Autopay Check Phone ${tag}`, fields: { amount: 85, frequency: "monthly", dueDate: today } });
    const sub = await create({ type: "liability", type_key: "subscription", name: `Autopay Check Stream ${tag}`, fields: { amount: 15.99, frequency: "monthly", dueDate: today } });
    const all = [car, home, phone, sub];

    // ── Off: nothing is recorded ────────────────────────────────────────────
    let run = await post<{ recorded: any[] }>("/autopay/run");
    check(!run.recorded.some((r) => all.includes(r.liabilityId)), "with Auto Pay off, nothing is recorded for a payment due today");

    // ── The setting ─────────────────────────────────────────────────────────
    for (const id of all) await post(`/liabilities/${id}/autopay`, { enabled: true });
    const carOn = await profile(car);
    check(carOn.fields.autopay === true && carOn.fields.autoRecordSince === today, `Auto Pay is on for the loan, stamped ${today} (got ${carOn.fields.autopay} / ${carOn.fields.autoRecordSince})`);
    const sched = await get<any>(`/liabilities/${car}/schedule?months=3`);
    check(sched.autopay === true, "the loan's schedule reports Auto Pay on");
    check(readMonthlyPayment(carOn.fields) === 400 && Number(carOn.fields.dueDay) === day, "switching it on did not change the loan's amount or due day");

    // ── Recorded once on the due day ────────────────────────────────────────
    run = await post("/autopay/run");
    const mine = run.recorded.filter((r) => all.includes(r.liabilityId));
    check(mine.length === 4, `all four payments due today were recorded (got ${mine.length}: ${mine.map((r) => r.name).join(" | ")})`);
    run = await post("/autopay/run");
    check(run.recorded.filter((r) => all.includes(r.liabilityId)).length === 0, "running it again records nothing");

    // Car loan: $400 = $75 interest + $325 principal.
    let carPays = await payments(car);
    check(carPays.length === 1, `the car loan has one payment (got ${carPays.length})`);
    const cp = carPays[0] || {};
    check(near(cp.amount, 400) && near(cp.interestPortion, 75) && near(cp.principalPortion, 325), `it is $400 = $325 principal + $75 interest (got ${cp.amount} = ${cp.principalPortion} + ${cp.interestPortion})`);
    check(cp.status === "assumed_paid" && cp.autopay === true, `it is ASSUMED paid, recorded by Auto Pay (got ${cp.status})`);
    check(near(readBalance((await profile(car)).fields), 14675), `the balance fell by the principal to $14,675 (got ${readBalance((await profile(car)).fields)})`);
    let carExp = await expensesOf(car);
    check(carExp.length === 1 && near(carExp[0]?.amount, 75), `only the $75 interest is an expense (got ${carExp.map((e) => e.amount).join(", ") || "none"})`);
    check(!!carExp[0]?.tags?.includes("autopay:assumed"), "that expense is marked assumed");

    // Mortgage: the month's interest, not the whole payment.
    const hp = (await payments(home))[0] || {};
    check(near(hp.amount, 2100) && near(hp.interestPortion, 1562.5), `mortgage: $2,100 with $1,562.50 interest (got ${hp.amount} / ${hp.interestPortion})`);
    const homeExp = await expensesOf(home);
    check(homeExp.length === 1 && near(homeExp[0]?.amount, 1562.5), `mortgage expense is the interest only (got ${homeExp.map((e) => e.amount).join(", ") || "none"})`);
    check(near(readBalance((await profile(home)).fields), 299462.5), `mortgage balance is $299,462.50 (got ${readBalance((await profile(home)).fields)})`);

    // Phone bill and subscription: the whole payment is the expense.
    const pp = (await payments(phone))[0] || {};
    check(near(pp.amount, 85) && pp.status === "assumed_paid", `phone bill: $85, assumed paid (got ${pp.amount} / ${pp.status})`);
    let phoneExp = await expensesOf(phone);
    check(phoneExp.length === 1 && near(phoneExp[0]?.amount, 85), `phone bill: one $85 expense (got ${phoneExp.map((e) => e.amount).join(", ") || "none"})`);
    const phoneSched = await get<any>(`/liabilities/${phone}/schedule?months=3`);
    check(!!phoneSched.nextDue && phoneSched.nextDue.date > today, `the phone bill's next due moved to next cycle (${phoneSched.nextDue?.date})`);
    const todayRow = (phoneSched.occurrences || []).find((o: any) => o.date === today);
    check(todayRow?.paymentStatus === "assumed_paid", `today's occurrence on the schedule reads assumed_paid (got ${todayRow?.paymentStatus})`);
    const laterRow = (phoneSched.occurrences || []).find((o: any) => o.date > today);
    check(laterRow?.paymentStatus === "scheduled", `next month's reads scheduled (got ${laterRow?.paymentStatus})`);

    // Quiet: no reminder task for an Auto Pay bill.
    const tasks: any[] = await get("/tasks");
    check(!(Array.isArray(tasks) ? tasks : []).some((t) => String(t.title || "").includes(tag)), "no \"Bill due\" reminder task was raised for the Auto Pay bills");

    // ── Bank reconciliation: confirm, never duplicate ───────────────────────
    const rec = await post<any>("/autopay/reconcile", { id: `txn-${tag}`, amount: -85, date: today, description: `AUTOPAY CHECK PHONE ${tag}` });
    check(rec.matched === true && rec.paymentId === pp.id, `the bank transaction matched the assumed phone payment (matched=${rec.matched})`);
    const pp2 = await payments(phone);
    check(pp2.length === 1 && pp2[0].status === "confirmed_paid", `still one phone payment, now confirmed (got ${pp2.length} / ${pp2[0]?.status})`);
    phoneExp = await expensesOf(phone);
    check(phoneExp.length === 1 && !phoneExp[0].tags.includes("autopay:assumed"), `still one phone expense, no longer marked assumed (got ${phoneExp.length})`);
    const rec2 = await post<any>("/autopay/reconcile", { id: `txn-${tag}`, amount: -85, date: today });
    check(rec2.matched === true && rec2.alreadyMatched === true, "the same transaction replayed changes nothing");
    const rec3 = await post<any>("/autopay/reconcile", { id: `txn-other-${tag}`, amount: 43.21, date: today, description: "COFFEE" });
    check(rec3.matched === false, "an unrelated transaction matches nothing");

    // ── Partial: one payment at what was actually paid ──────────────────────
    const sp = (await payments(sub))[0] || {};
    await post(`/liability-payments/${sp.id}/status`, { status: "partial", amount: 10 });
    const sp2 = await payments(sub);
    check(sp2.length === 1 && near(sp2[0].amount, 10) && sp2[0].status === "partial", `subscription: one $10 partial payment (got ${sp2.length} / ${sp2[0]?.amount} / ${sp2[0]?.status})`);
    check(near(sp2[0]?.expectedAmount, 15.99), `it remembers $15.99 was scheduled (got ${sp2[0]?.expectedAmount})`);
    const subExp = await expensesOf(sub);
    check(subExp.length === 1 && near(subExp[0]?.amount, 10), `subscription: one $10 expense (got ${subExp.map((e) => e.amount).join(", ") || "none"})`);
    check(near((await profile(sub)).fields.amount, 15.99), "the recurring amount is still $15.99");

    // ── Missed: the assumed loan payment is reversed ────────────────────────
    await post(`/liability-payments/${cp.id}/status`, { status: "missed" });
    carPays = await payments(car);
    check(carPays.length === 0, `marking it missed removed the car payment (got ${carPays.length})`);
    check(near(readBalance((await profile(car)).fields), 15000), `the balance is back to $15,000 (got ${readBalance((await profile(car)).fields)})`);
    carExp = await expensesOf(car);
    check(carExp.length === 0, `the interest expense was removed (got ${carExp.length})`);
    const carSched = await get<any>(`/liabilities/${car}/schedule?months=3`);
    check((carSched.occurrences || []).find((o: any) => o.date === today)?.paymentStatus === "missed", "today's occurrence reads missed");
    const carAfter = await profile(car);
    check(carAfter.fields.autopay === true && readMonthlyPayment(carAfter.fields) === 400 && Number(carAfter.fields.dueDay) === day, "the loan's schedule and Auto Pay setting are unchanged");
    run = await post("/autopay/run");
    check(!run.recorded.some((r) => r.liabilityId === car), "Auto Pay does not record the missed payment again");
    const notes: any[] = await get("/notifications");
    check((Array.isArray(notes) ? notes : []).some((n) => String(n.title || "").startsWith("Missed payment") && String(n.title).includes(tag)), "the missed payment is raised as an alert");

    // ── Back to scheduled: it is recorded again, once ───────────────────────
    await post(`/liabilities/${car}/occurrences/${today}/status`, { status: "scheduled" });
    run = await post("/autopay/run");
    check(run.recorded.filter((r) => r.liabilityId === car).length === 1, "reopened, it is recorded again");
    check((await payments(car)).length === 1 && (await expensesOf(car)).length === 1, "one payment and one expense, not two");
    const notes2: any[] = await get("/notifications");
    check(!(Array.isArray(notes2) ? notes2 : []).some((n) => String(n.title || "").startsWith("Missed payment") && String(n.title).includes(tag)), "the missed alert is gone once the payment exists (derived, not stored)");

    // ── Delayed: that one occurrence moves; the assumed payment is reversed ─
    const movedTo = addDays(today, 5);
    await post(`/liability-payments/${hp.id}/status`, { status: "delayed", movedTo });
    check((await payments(home)).length === 0 && near(readBalance((await profile(home)).fields), 300000), "delaying the mortgage payment reversed it (balance back to $300,000)");
    run = await post("/autopay/run");
    check(!run.recorded.some((r) => r.liabilityId === home), "it is not recorded before its new day");
    const homeSched = await get<any>(`/liabilities/${home}/schedule?months=3`);
    const movedRow = (homeSched.occurrences || []).find((o: any) => o.date === today);
    check(movedRow?.effectiveDate === movedTo && movedRow?.paymentStatus === "delayed", `the occurrence now falls on ${movedTo} and reads delayed (got ${movedRow?.effectiveDate} / ${movedRow?.paymentStatus})`);
    check(Number((await profile(home)).fields.dueDay) === day, "the mortgage's due day is unchanged");

    // ── The UI ──────────────────────────────────────────────────────────────
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      await page.goto(UI_BASE);
      const email = page.locator('[data-testid="input-signin-email"]');
      if (!(await email.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
        await page.locator('[data-testid="tab-signin"]').click({ timeout: 5000 }).catch(() => undefined);
      }
      await email.fill(LIVE_EMAIL);
      await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
      await page.click('[data-testid="button-signin"]');
      await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });

      await page.goto(`${UI_BASE}/#/profiles/${car}`);
      await page.locator('[data-testid="tab-payments"]').click({ timeout: 30000 });
      const section = page.locator('[data-testid="autopay-section"]');
      await section.waitFor({ timeout: 30000 });
      const sw = page.locator('[data-testid="switch-autopay"]');
      check((await sw.getAttribute("aria-checked")) === "true", "the loan's Payments tab shows the Auto Pay switch ON");
      const summary = (await page.locator('[data-testid="autopay-summary"]').innerText()).replace(/\s+/g, " ");
      check(/\$400\.00/.test(summary) && /Assumed paid until you or your bank confirm/.test(summary), `the card explains what Auto Pay does (${summary.slice(0, 90)}…)`);
      await page.locator('[data-testid="payments-list"]').waitFor({ timeout: 30000 });
      const history = (await page.locator('[data-testid="payments-list"]').innerText()).replace(/\s+/g, " ");
      check(/Assumed paid/.test(history), "the payment history labels the Auto Pay payment \"Assumed paid\"");
      await page.screenshot({ path: `${SHOT}/live-autopay-loan-payments.png`, fullPage: true });

      // Confirm it from the page: the per-payment menu → "Confirm it was paid".
      const carPay = (await payments(car))[0];
      await page.locator(`[data-testid="payment-row-${carPay.id}"] [data-testid="payment-controls-${carPay.id}"]`).click({ timeout: 15000 });
      await page.locator(`[data-testid="payment-confirm-${carPay.id}"]`).click({ timeout: 15000 });
      const confirmed = await page.locator(`[data-testid="payment-row-${carPay.id}"] [data-testid="payment-status-confirmed_paid"]`).waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      check(confirmed, "confirming it from the page turns the badge to Paid");
      check((await payments(car))[0]?.status === "confirmed_paid", "…and the server agrees");
      await page.screenshot({ path: `${SHOT}/live-autopay-loan-confirmed.png`, fullPage: true });

      // Turn Auto Pay off from the switch; history stays.
      await sw.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="switch-autopay"]')?.getAttribute("aria-checked") === "false", null, { timeout: 20000 }).catch(() => undefined);
      check((await profile(car)).fields.autopay === false, "switching it off on the page turned Auto Pay off");
      check((await payments(car)).length === 1, "turning it off kept the payment history");

      // The Liabilities list: Auto Pay pill, and the Auto Pay / Manual filter.
      await page.goto(`${UI_BASE}/#/linked?tab=liabilities`);
      await page.locator(`[data-testid="liab-card-${phone}"]`).waitFor({ timeout: 30000 });
      check((await page.locator(`[data-testid="liab-autopay-${phone}"]`).count()) === 1, "the phone bill's card carries an Auto Pay pill");
      await page.locator('[data-testid="filter-liability-pay-manual"]').click({ timeout: 15000 });
      await page.waitForTimeout(800);
      check((await page.locator(`[data-testid="liab-card-${phone}"]`).count()) === 0, "the Manual pay filter hides the Auto Pay phone bill");
      check((await page.locator(`[data-testid="liab-card-${car}"]`).count()) === 1, "…and shows the loan that was just switched to manual");
      await page.locator('[data-testid="filter-liability-pay-autopay"]').click();
      await page.waitForTimeout(800);
      check((await page.locator(`[data-testid="liab-card-${phone}"]`).count()) === 1 && (await page.locator(`[data-testid="liab-card-${car}"]`).count()) === 0, "the Auto Pay filter shows the phone bill and hides the manual loan");
      await page.screenshot({ path: `${SHOT}/live-autopay-liabilities-filter.png`, fullPage: true });
    } finally {
      await browser.close();
    }

    // ── Chat: one sentence, the same door ───────────────────────────────────
    const chat = await api("POST", "/chat", { message: `Turn off autopay for my Autopay Check Stream ${tag} subscription.`, history: [] });
    check(chat.ok, `chat answered (${chat.status})`);
    check((await profile(sub)).fields.autopay === false, "\"turn off autopay for …\" in chat turned it off");
    check((await payments(sub)).length === 1, "…and kept its payment");
  } finally {
    for (const id of ids) {
      for (const e of await expensesOf(id).catch(() => [])) await api("DELETE", `/expenses/${e.id}`).catch(() => undefined);
      await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    }
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
