// Live scenario sweep (production, smoke account) for Auto Pay: the cases a
// person actually produces by poking at it.
//
//   credit card · weekly bill · paused bill · due tomorrow · overdue before the
//   switch · paid from an account · Reverse from the history · amount edit ·
//   expense deleted in Finance · reminders kept · dashboard · calendar · chat
//
// Takes the gate lock, writes only records it creates, deletes them when done.
//   npx tsx tests/live-autopay-scenarios-check.ts
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { readBalance } from "../shared/liability-fields";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.005;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function get<T = any>(path: string): Promise<T> {
  const r = await api("GET", path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data as T;
}
async function send<T = any>(method: string, path: string, body?: any): Promise<T> {
  const r = await api(method, path, body ?? {});
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data as T;
}
const post = <T = any>(path: string, body?: any) => send<T>("POST", path, body);
const payments = (id: string) => get<any[]>(`/liabilities/${id}/payments`);
const profile = (id: string) => get<any>(`/profiles/${id}`);
const schedule = (id: string) => get<any>(`/liabilities/${id}/schedule?months=3`);
async function expensesOf(liabilityId: string): Promise<any[]> {
  const data: any = await get("/expenses");
  const rows: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return rows.filter((e) => Array.isArray(e.tags) && e.tags.includes(`liability:${liabilityId}`));
}
const runFor = async (ids: string[]) => (await post<{ recorded: any[] }>("/autopay/run")).recorded.filter((r) => ids.includes(r.liabilityId));
const notifications = async (tag: string) => ((await get<any[]>("/notifications")) || []).filter((n) => `${n.title} ${n.message}`.includes(tag));

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-autopay-scenarios-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const ids: string[] = [];
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);
    const { today } = await post<{ today: string }>("/autopay/run");
    const day = Number(today.slice(8, 10));
    const tomorrow = addDays(today, 1), yesterday = addDays(today, -1);
    console.log(`server today: ${today}`);

    const create = async (body: any) => {
      const made = await api("POST", "/profiles", body);
      if (!made.ok) throw new Error(`create ${body.name}: ${made.status} ${JSON.stringify(made.data).slice(0, 200)}`);
      ids.push(made.data.id);
      return made.data.id as string;
    };
    const bill = (name: string, fields: any, type_key = "utility") => create({ type: "liability", type_key, name: `${name} ${tag}`, fields: { frequency: "monthly", ...fields } });
    const on = (id: string, extra: any = {}) => post(`/liabilities/${id}/autopay`, { enabled: true, ...extra });

    // ── Credit card: the minimum splits into interest and principal ─────────
    const card = await create({ type: "liability", type_key: "credit_card", name: `Scenario Card ${tag}`, fields: { balance: 2000, interestRate: 24, monthlyPayment: 100, dueDay: day } });
    await on(card);
    check((await runFor([card])).length === 1, "credit card: the minimum payment is recorded");
    const cardPay = (await payments(card))[0] || {};
    check(near(cardPay.amount, 100) && near(cardPay.interestPortion, 40) && near(cardPay.principalPortion, 60), `credit card: $100 = $60 principal + $40 interest (got ${cardPay.principalPortion} + ${cardPay.interestPortion})`);
    check(near(readBalance((await profile(card)).fields), 1940), "credit card: balance $1,940");
    check(near((await expensesOf(card))[0]?.amount, 40), "credit card: the expense is the $40 interest");

    // ── Weekly bill: one cycle forward ──────────────────────────────────────
    const weekly = await bill("Scenario Weekly", { amount: 30, frequency: "weekly", dueDate: today });
    await on(weekly);
    check((await runFor([weekly])).length === 1, "weekly bill: recorded");
    check((await schedule(weekly)).nextDue?.date === addDays(today, 7), `weekly bill: next due is a week on (${(await schedule(weekly)).nextDue?.date})`);

    // ── Paused: nothing is recorded ─────────────────────────────────────────
    const paused = await bill("Scenario Paused", { amount: 20, dueDate: today });
    await on(paused);
    await post(`/liabilities/${paused}/pause`, {});
    check((await runFor([paused])).length === 0, "a paused bill is not recorded");
    await post(`/liabilities/${paused}/resume`, {});
    check((await runFor([paused])).length === 1, "resumed, it is recorded");

    // ── Due tomorrow / overdue before the switch ────────────────────────────
    const soon = await bill("Scenario Tomorrow", { amount: 61, dueDate: tomorrow });
    const manualSoon = await bill("Scenario Manual Tomorrow", { amount: 62, dueDate: tomorrow });
    const late = await bill("Scenario Late", { amount: 63, dueDate: yesterday });
    await on(soon); await on(late);
    check((await runFor([soon, late])).length === 0, "a bill due tomorrow, and one overdue before Auto Pay was switched on, are not recorded");
    let notes = await notifications(tag);
    check(!notes.some((n) => n.title.includes("Scenario Tomorrow")), "no due-soon alert for the Auto Pay bill due tomorrow");
    check(notes.some((n) => n.title.includes("Scenario Manual Tomorrow")), "the manual bill due tomorrow still raises its due-soon alert");
    // A7 (owner, 2026-11-22, a day after this check was written): a RECURRING
    // bill's elapsed due date is assumed paid everywhere — nothing reads
    // overdue, and the bell raises nothing for it. This line used to expect
    // the opposite and had been red on production since (triaged 2026-11-27:
    // outdated assertion). A payment marked MISSED is the exception that shows,
    // and is checked further down.
    check(!notes.some((n) => /Overdue bill/.test(n.title) && n.title.includes("Scenario Late")), "a monthly bill whose date passed yesterday raises no overdue alert (an elapsed date is assumed paid)");
    await post(`/liabilities/${soon}/autopay`, { reminders: true });
    notes = await notifications(tag);
    check(notes.some((n) => n.title.includes("Scenario Tomorrow")), "\"Remind me anyway\" brings its due-soon alert back");

    // ── Dashboard feed ──────────────────────────────────────────────────────
    const dash = await get<any>("/dashboard-enhanced");
    const upcoming: any[] = dash?.financeSnapshot?.upcomingBills || [];
    const soonRow = upcoming.find((b) => b.id === soon);
    const manualRow = upcoming.find((b) => b.id === manualSoon);
    check(!!soonRow && soonRow.autopay === true && soonRow.autopayReminders === true, `dashboard: the Auto Pay bill is listed as Auto Pay with reminders kept (${JSON.stringify(soonRow ? { autopay: soonRow.autopay, r: soonRow.autopayReminders } : null)})`);
    check(!!manualRow && manualRow.autopay === false, "dashboard: the manual bill is listed as manual");
    check(!upcoming.some((b) => b.id === weekly && b.dueDate === today), "dashboard: the bill Auto Pay just recorded is no longer due today");
    check(Number(dash?.financeSnapshot?.debtPrincipalPaidThisMonth) >= 60, `dashboard: loan principal paid this month is reported (${dash?.financeSnapshot?.debtPrincipalPaidThisMonth})`);

    // ── Paid from an account; Reverse from the history sticks ───────────────
    const acct = await api("POST", "/accounts", { name: `Scenario Checking ${tag}`, accountKind: "checking", balance: 5000 });
    if (!acct.ok) throw new Error(`create account: ${acct.status} ${JSON.stringify(acct.data).slice(0, 200)}`);
    const acctId: string = acct.data?.id ?? acct.data?.profile?.id ?? acct.data?.account?.id;
    ids.push(acctId);
    const phone = await bill("Scenario Phone", { amount: 85, dueDate: today }, "phone_plan");
    await on(phone, { accountId: acctId });
    check((await runFor([phone])).length === 1, "phone bill paid from an account: recorded");
    check(near((await profile(acctId)).fields.balance, 4915), `the account fell by $85 to $4,915 (got ${(await profile(acctId)).fields.balance})`);
    const phonePay = (await payments(phone))[0];
    await send("DELETE", `/liability-payments/${phonePay.id}`);
    check((await payments(phone)).length === 0 && (await expensesOf(phone)).length === 0, "Reverse removed the payment and its expense");
    check(near((await profile(acctId)).fields.balance, 5000), `the account is back to $5,000 (got ${(await profile(acctId)).fields.balance})`);
    check((await runFor([phone])).length === 0, "the next Auto Pay run does NOT put the reversed payment back");
    const phoneSched = await schedule(phone);
    check((phoneSched.occurrences || []).find((o: any) => o.date === today)?.paymentStatus === "missed", "the reversed payment reads missed");
    check(phoneSched.nextDue?.date > today, `the bill moved on to its next cycle (${phoneSched.nextDue?.date})`);
    check((await profile(phone)).fields.autopay === true, "Auto Pay is still on for the bill");

    // ── Amount edit on an auto-recorded LOAN payment ────────────────────────
    const loan = await create({ type: "liability", type_key: "auto_loan", name: `Scenario Loan ${tag}`, fields: { balance: 15000, originalBalance: 22000, interestRate: 6, monthlyPayment: 400, dueDay: day } });
    await on(loan);
    await runFor([loan]);
    const loanPay = (await payments(loan))[0];
    await send("PATCH", `/liability-payments/${loanPay.id}`, { amount: 450 });
    const afterEdit = await payments(loan);
    check(afterEdit.length === 1 && near(afterEdit[0].amount, 450), `editing the amount leaves one $450 payment (got ${afterEdit.length} / ${afterEdit[0]?.amount})`);
    check(near(afterEdit[0]?.interestPortion, 75) && near(readBalance((await profile(loan)).fields), 14625), `interest is still $75 and the balance is $14,625 (got ${afterEdit[0]?.interestPortion} / ${readBalance((await profile(loan)).fields)})`);
    const loanExp = await expensesOf(loan);
    check(loanExp.length === 1 && near(loanExp[0]?.amount, 75), `one $75 interest expense (got ${loanExp.map((e) => e.amount).join(", ") || "none"})`);
    check((await runFor([loan])).length === 0, "Auto Pay does not add a second payment after the edit");

    // ── Extra principal after the instalment does not hide next month ───────
    await post(`/liabilities/${loan}/payments`, { amount: 500, paymentDate: today, paymentType: "extra_principal" });
    const loanSched = await schedule(loan);
    const nextMonth = loanSched.nextDue?.date || "";
    check(nextMonth > today && nextMonth <= addDays(today, 32), `after an extra-principal payment the next due is still next month (${nextMonth})`);
    check((await payments(loan)).length === 2, "the extra payment is its own row");

    // ── Expense deleted in Finance: the payment goes, and stays gone ────────
    const stream = await bill("Scenario Stream", { amount: 15.99, dueDate: today }, "subscription");
    await on(stream);
    await runFor([stream]);
    const streamExp = (await expensesOf(stream))[0];
    await send("DELETE", `/expenses/${streamExp.id}`);
    check((await payments(stream)).length === 0, "deleting the expense in Finance removed the payment it recorded");
    check((await runFor([stream])).length === 0, "…and Auto Pay does not record it again");
    check((await expensesOf(stream)).length === 0, "no expense is left behind");

    // ── Editing the expense amount in Finance re-prices the one bill payment ─
    const gas = await bill("Scenario Gas", { amount: 40, dueDate: today });
    await on(gas);
    await runFor([gas]);
    const gasExp = (await expensesOf(gas))[0];
    await send("PATCH", `/expenses/${gasExp.id}`, { amount: 45 });
    const gasPays = await payments(gas);
    check(gasPays.length === 1 && near(gasPays[0].amount, 45), `the bill's payment followed the expense edit to $45 (got ${gasPays[0]?.amount})`);
    check(near((await profile(gas)).fields.amount, 40), "the recurring amount is still $40");

    // ── Calendar: the dates are still there ─────────────────────────────────
    const timeline = await get<any>(`/calendar/timeline?start=${today}&end=${addDays(today, 40)}`);
    const items: any[] = Array.isArray(timeline) ? timeline : (timeline?.items || timeline?.events || []);
    const named = (needle: string) => items.filter((i) => String(i.title || i.name || "").includes(needle));
    check(named(`Scenario Tomorrow ${tag}`).length >= 1, "calendar: the Auto Pay bill's due date is on the calendar");
    check(named(`Scenario Weekly ${tag}`).length >= 4, `calendar: the weekly bill's coming dates are on the calendar (${named(`Scenario Weekly ${tag}`).length})`);

    // ── Chat ────────────────────────────────────────────────────────────────
    const chat1 = await api("POST", "/chat", { message: `Put my Scenario Manual Tomorrow ${tag} bill on autopay.`, history: [] });
    check(chat1.ok && (await profile(manualSoon)).fields.autopay === true, "chat: \"put my … bill on autopay\" switched it on");
    const chat2 = await api("POST", "/chat", { message: `My Scenario Card ${tag} payment today didn't actually go through. Mark it as missed.`, history: [] });
    check(chat2.ok, `chat answered (${chat2.status})`);
    check((await payments(card)).length === 0, "chat: \"the card payment didn't go through\" reversed it");
    check(near(readBalance((await profile(card)).fields), 2000), `chat: the card balance is back to $2,000 (got ${readBalance((await profile(card)).fields)})`);
    check((await runFor([card])).length === 0, "chat: it is not recorded again");
    const cardFields = (await profile(card)).fields;
    check(cardFields.autopay === true && near(cardFields.monthlyPayment, 100), "chat: the card's Auto Pay and payment amount are unchanged");
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
