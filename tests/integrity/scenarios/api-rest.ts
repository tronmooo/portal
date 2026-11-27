// The API doors no scenario had verified against the database: the stored loan
// schedule, finishing onboarding, clearing an assistant's conversation, the
// corrections a person makes to connected bank data, and what the chat routes
// do when they cannot do the work. Every expected figure is the oracle's or
// arithmetic written here; none is read from the app's own answer.
//
// Two kinds of state cannot be produced through the app on the isolated stack
// (no AI provider, no bank provider): an assistant's saved conversation, and
// connected bank rows. Those are SEEDED straight into the account's own rows
// (PostgREST, the account's own token, row-level security in force) in the
// shape the app itself stores; the operation under test still goes through
// the app, and its result is read back from the database. The bank scenarios
// are isolatedOnly: fabricated bank rows are never put in a deployed account.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";
import { fetchWithRateLimitRetry, getSmokeToken } from "../../smoke/fixture/api";
import { SB_URL, SB_ANON, SMOKE_USER_ID } from "../../smoke/fixture/account";

const NO_AI = process.env.INTEGRITY_NO_AI === "1";
const RANDOM_ID = "3f0e9c1a-7b52-4d8e-9a61-0c2d4e6f8a1b"; // no row has it
const is4xx = (s: number) => s >= 400 && s < 500;
const brief = (v: unknown, n = 240) => JSON.stringify(v).slice(0, n);
const enc = encodeURIComponent;

/** A write to the ACCOUNT'S OWN rows, as the account (row-level security applies). Fixtures and cleanup only. */
async function dbWrite(method: "POST" | "PATCH" | "DELETE", q: string, body?: unknown): Promise<any[]> {
  const { response } = await fetchWithRateLimitRetry(`${SB_URL}/rest/v1/${q}`, {
    method,
    headers: { apikey: SB_ANON, Authorization: `Bearer ${await getSmokeToken()}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`db ${method} ${q}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

const mine = `user_id=eq.${SMOKE_USER_ID}`;
const prefRow = async (ctx: Ctx, key: string) => (await ctx.db.rows("preferences", `key=eq.${enc(key)}`))[0] ?? null;
/** Put a preference row back exactly as it was found (or remove it if it was not there). */
async function restorePref(key: string, before: any | null) {
  if (before) {
    const upd = await dbWrite("PATCH", `preferences?key=eq.${enc(key)}&${mine}`, { value: before.value });
    if (upd.length === 0) await dbWrite("POST", "preferences", { user_id: SMOKE_USER_ID, key, value: before.value });
  } else await dbWrite("DELETE", `preferences?key=eq.${enc(key)}&${mine}`);
}

const mkProfile = async (ctx: Ctx, body: any) => {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}?deleteHistory=1`));
  return p;
};

// ── liability.reschedule.api — POST /api/loans/schedule ─────────────────────

interface SchedRow { loan_id: string; loan_name: string; payment_number: number; payment_date: string; principal_amount: number; interest_amount: number; total_payment: number; remaining_balance: number }

/** A level-payment schedule, a month's interest at a time (L5), closing with the last payment as a lender does. */
function amortize(loanId: string, name: string, balance: number, aprPct: number, payment: number, firstDate: string): SchedRow[] {
  const rows: SchedRow[] = [];
  let b = balance;
  for (let k = 0; b > 0.005 && k < 600; k++) {
    const interest = O.monthInterest(b, aprPct);
    let principal = O.cents(Math.min(payment - interest, b));
    const left = O.cents(b - principal);
    if (left > 0 && left < payment / 2) principal = b;
    b = O.cents(b - principal);
    rows.push({ loan_id: loanId, loan_name: name, payment_number: k + 1, payment_date: O.addMonthsAnchored(firstDate, k), principal_amount: principal, interest_amount: interest, total_payment: O.cents(principal + interest), remaining_balance: b });
  }
  return rows;
}

scenario({
  id: "api-rest.loan-schedule",
  title: "A stored loan schedule: every row as sent, on the Calendar and in the cash-flow projection with its amount, refused when it is wrong",
  area: "Liabilities",
  covers: ["liability.reschedule.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const balance = ctx.int(30, 60) * 100, apr = ctx.pick([4.5, 7.25, 12.5]), payment = ctx.int(4, 6) * 100;
    const name = `${ctx.tag} Sched Loan`;
    const loan = await mkProfile(ctx, { type: "liability", type_key: "personal_loan", name, fields: { balance, monthlyPayment: payment, dueDay: 15, interestRate: apr, _interestRateUnit: "percent" } });
    ctx.cleanup(() => dbWrite("DELETE", `loan_amortization?loan_name=like.${enc(ctx.tag)}*&${mine}`));
    const rowsOf = (id: string) => ctx.db.rows("loan_amortization", `loan_id=eq.${id}&order=payment_number.asc,created_at.asc`);

    const first = O.addMonthsAnchored(`${ctx.today.slice(0, 7)}-15`, 1);
    const sched = amortize(loan.id, name, balance, apr, payment, first);
    const want = O.payoff(balance, apr, payment);
    ctx.check("derived", !!want && sched.length === want.months, `the schedule has the ${want?.months} payments the oracle's payoff takes`, `${sched.length} rows`);
    ctx.near("derived", O.cents(sched.reduce((s, r) => s + r.interest_amount, 0)), want?.totalInterest ?? NaN, "its interest adds up to the oracle's total interest", 0.01 * sched.length);
    const one = O.splitPayment(balance, apr, payment);
    ctx.check("derived", sched[0].interest_amount === one.interest && sched[0].principal_amount === one.principal && sched[0].remaining_balance === one.newBalance, "its first row is the oracle's split of the first payment");

    const month = first.slice(0, 7);
    const projected = async () => O.cents(listOf(must(await ctx.api("GET", `/cashflow?month=${month}`), "cashflow")).reduce((s: number, r: any) => s + (Number(r.projected_expenses) || 0), 0));
    const calendar = async () => listOf(must(await ctx.api("GET", `/calendar/timeline?start=${first}&end=${sched[sched.length - 1].payment_date}`), "timeline")).filter((i: any) => i.sourceId === loan.id && i.meta?.source === "loan_amortization");
    const projected0 = await projected();

    // ── refusals first: nothing may be stored ──
    const refuse = async (what: string, body: any, status?: number) => {
      const r = await ctx.api("POST", "/loans/schedule", body);
      ctx.check("action", status ? r.status === status : is4xx(r.status), `${what} is refused${status ? ` (${status})` : ""}`, `${r.status} ${brief(r.data)}`);
    };
    await refuse("a body with no entries", {}, 400);
    await refuse("an empty list", { entries: [] }, 400);
    await refuse("an empty entry", { entries: [{}] }, 400);
    await refuse("a negative payment", { entries: [{ ...sched[0], total_payment: -5 }] }, 400);
    await refuse("a day that is not on the calendar (Feb 30)", { entries: [{ ...sched[0], payment_date: `${Number(month.slice(0, 4)) + 1}-02-30` }] }, 400);
    await refuse("payment number 0", { entries: [{ ...sched[0], payment_number: 0 }] }, 400);
    await refuse("a field the schedule does not have (paid: true)", { entries: [{ ...sched[0], paid: true }] }, 400);
    await refuse("a loan that does not exist", { entries: [{ ...sched[0], loan_id: RANDOM_ID }] }, 404);
    await refuse("one bad row among good ones", { entries: [sched[0], { ...sched[1], remaining_balance: "lots" }] }, 400);
    const other = await ctx.apiAsOther("POST", "/loans/schedule", { entries: [sched[0]] });
    ctx.check("isolation", other.status === 404, "another account cannot schedule payments on this loan", `${other.status} ${brief(other.data)}`);
    ctx.check("db", (await rowsOf(loan.id)).length === 0 && (await ctx.db.count("loan_amortization", `loan_id=eq.${RANDOM_ID}`)) === 0, "none of the refused requests stored a row");

    // a schedule belongs to a loan: a person's profile is not one
    const onPerson = await ctx.api("POST", "/loans/schedule", { entries: [{ ...sched[0], loan_id: ctx.self.id, loan_name: `${ctx.tag} Not A Loan` }] });
    const personRows = await rowsOf(ctx.self.id);
    const personOk = ctx.check("action", is4xx(onPerson.status) && personRows.length === 0, "a schedule for a profile that is not a debt (the account holder) is refused and nothing is stored", `${onPerson.status}; ${personRows.length} row(s) stored for the person`);
    if (personRows.length) await dbWrite("DELETE", `loan_amortization?loan_id=eq.${ctx.self.id}&loan_name=like.${enc(ctx.tag)}*&${mine}`); // keep it out of the figures below
    if (!personOk) ctx.finding({ severity: "discrepancy", title: "POST /api/loans/schedule stores loan payments for a profile that is not a debt", detail: `entries[0].loan_id = the account holder's own profile → ${onPerson.status}; loan_amortization now holds ${personRows.length} row(s) with that loan_id. The route only checks that the profile exists ("a loan id nobody owns"), not that it is a loan or liability.` });

    // ── store it ──
    const posted = await ctx.api("POST", "/loans/schedule", { entries: sched });
    ctx.check("action", posted.ok && Array.isArray(posted.data) && posted.data.length === sched.length, `the ${sched.length}-payment schedule is accepted`, `${posted.status} ${brief(posted.data)}`);
    const stored = await rowsOf(loan.id);
    ctx.check("db", stored.length === sched.length, `${sched.length} rows are stored for the loan`, `${stored.length}`);
    const diff = sched.flatMap((w, i) => {
      const r = stored[i];
      const same = r && r.payment_number === w.payment_number && String(r.payment_date).slice(0, 10) === w.payment_date && r.loan_name === name && r.user_id === SMOKE_USER_ID
        && (["principal_amount", "interest_amount", "total_payment", "remaining_balance"] as const).every((k) => Math.abs(Number(r[k]) - w[k]) < 0.005);
      return same ? [] : [`#${w.payment_number}: ${brief(r, 160)}`];
    });
    ctx.check("db", diff.length === 0, "each stored row holds its number, day, principal, interest, payment and remaining balance, under this account", diff.slice(0, 3).join(" | "));
    ctx.check("db", stored.every((r: any) => r.paid === false || r.paid === null), "no stored row starts out paid");
    ctx.near("db", Number(stored[stored.length - 1]?.remaining_balance), 0, "the last stored row leaves nothing owing");
    ctx.near("db", (await ctx.db.row("profiles", loan.id))?.fields?.balance, balance, "storing a schedule does not move the loan's balance");
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`)) === 0, "and records no payment");

    const read = listOf(must(await ctx.api("GET", `/loans/schedule?loanId=${loan.id}`), "read schedule"));
    ctx.check("action", read.length === sched.length && read.every((r: any, i: number) => r.payment_number === i + 1 && Math.abs(Number(r.total_payment) - sched[i].total_payment) < 0.005), "the schedule reads back in order with each payment's amount");
    const theirs = await ctx.apiAsOther("GET", `/loans/schedule?loanId=${loan.id}`);
    ctx.check("isolation", theirs.ok && Array.isArray(theirs.data) && theirs.data.length === 0, "another account reads none of it", `${theirs.status} ${brief(theirs.data, 120)}`);

    // ── what depends on it: the month's projection and the Calendar ──
    const inMonth = O.cents(sched.filter((r) => r.payment_date.startsWith(month)).reduce((s, r) => s + r.total_payment, 0));
    const cashOk = ctx.near("derived", O.cents((await projected()) - projected0), inMonth, `${month}'s projected expenses rose by the payment scheduled in it`);
    const cal = await calendar();
    ctx.check("derived", cal.length === sched.length && sched.every((w) => cal.filter((i: any) => i.date === w.payment_date).length === 1), `the Calendar shows each of the ${sched.length} scheduled payments once, on its day`, `${cal.length} items: ${cal.map((i: any) => i.date).join(",").slice(0, 200)}`);
    const wrongAmt = sched.filter((w) => Math.abs(Number(cal.find((i: any) => i.date === w.payment_date)?.meta?.amount) - w.total_payment) >= 0.005);
    const calOk = ctx.check("derived", wrongAmt.length === 0, "each Calendar payment carries the stored payment amount", `${wrongAmt.length} of ${sched.length} differ; first: "${cal[0]?.title}" (meta.amount ${cal[0]?.meta?.amount}) for a stored total_payment of ${sched[0].total_payment}`);
    if (!cashOk || !calOk) ctx.finding({ severity: "bug", title: "A stored loan schedule's payments count as $0.00 in the cash-flow projection and on the Calendar", detail: `POST /api/loans/schedule stored ${sched.length} rows (total_payment ${sched[0].total_payment} each month). GET /api/cashflow?month=${month} did not rise by ${inMonth}, and GET /api/calendar/timeline titles the payment "${cal[0]?.title}". The readers take the amount from row.payment || row.amount || row.payment_amount (server/supabase-storage.ts getCashflow / getCalendarTimeline); the table's column is total_payment, so every amount reads 0 and the cash-flow merge skips it.` });

    // ── the same schedule sent again is still one schedule ──
    const again = await ctx.api("POST", "/loans/schedule", { entries: sched });
    const afterAgain = await rowsOf(loan.id);
    const once = ctx.check("db", afterAgain.length === sched.length, `sending the same schedule again leaves ${sched.length} payments, not two of each`, `${again.status}; ${afterAgain.length} rows, ${afterAgain.filter((r: any) => r.payment_number === 1).length} of them payment #1`);
    if (!once) ctx.finding({ severity: "discrepancy", title: "Posting a loan's schedule twice stores every payment twice", detail: `The second identical POST /api/loans/schedule answered ${again.status}; loan_amortization holds ${afterAgain.length} rows for the loan (${sched.length} sent), two with each payment_number. Nothing is unique on (loan_id, payment_number), the Calendar lists both, and no route removes a schedule row.` });

    // ── the loan is deleted: its payments are no longer coming up ──
    must(await ctx.api("DELETE", `/profiles/${loan.id}?deleteHistory=1`), "delete the loan");
    const calAfter = await calendar();
    const left = await rowsOf(loan.id);
    const goneOk = ctx.check("derived", calAfter.length === 0, "after the loan is deleted the Calendar lists none of its scheduled payments", `${calAfter.length} still listed; ${left.length} schedule rows still stored`);
    if (!goneOk) ctx.finding({ severity: "sync", title: "A deleted loan's scheduled payments stay on the Calendar", detail: `DELETE /api/profiles/${"<loan>"}?deleteHistory=1 answered 200; loan_amortization still holds ${left.length} unpaid rows for it and GET /api/calendar/timeline lists ${calAfter.length} "…Sched Loan — $…" payments (owner-less, so they show under every profile filter that admits unowned items). No route deletes a schedule row.` });
  },
});

// ── dashboard.complete.api — POST /api/onboarding/complete ──────────────────

scenario({
  id: "api-rest.onboarding-complete",
  title: "Finishing onboarding stores one flag, once, and only that door can set it",
  area: "Dashboards & preferences",
  covers: ["dashboard.complete.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const KEY = "onboarding_completed";
    const before = await prefRow(ctx, KEY);
    ctx.cleanup(() => restorePref(KEY, before));
    await dbWrite("DELETE", `preferences?key=eq.${KEY}&${mine}`); // start from "not finished"
    const flags = () => ctx.db.rows("preferences", `key=eq.${KEY}`);
    const others0 = await ctx.db.count("preferences", `key=neq.${KEY}&key=not.like.lock:*`);

    // without the flag the answer is worked out from the account's records
    const s0 = must(await ctx.api("GET", "/onboarding-status"), "status");
    const [profiles, trackers, tasks] = await Promise.all([
      ctx.api("GET", "/profiles").then((r) => listOf(must(r, "profiles")).length),
      ctx.api("GET", "/trackers").then((r) => listOf(must(r, "trackers")).length),
      ctx.api("GET", "/tasks").then((r) => listOf(must(r, "tasks")).length),
    ]);
    ctx.check("action", s0.completed === (profiles > 1 || trackers > 0 || tasks > 0), `with no flag stored, onboarding reads ${profiles > 1 || trackers > 0 || tasks > 0 ? "finished (the account has records)" : "not finished (an empty account)"}`, brief(s0));
    ctx.check("db", (await flags()).length === 0, "asking stores nothing");

    // the generic preference door cannot set it
    const viaPrefs = await ctx.api("PUT", `/preferences/${KEY}`, { value: "true" });
    ctx.check("action", viaPrefs.status === 400, "the generic preferences route refuses the onboarding flag", `${viaPrefs.status}`);
    ctx.check("db", (await flags()).length === 0, "and stores nothing");

    const done = await ctx.api("POST", "/onboarding/complete");
    ctx.check("action", done.ok && done.data?.success === true, "finishing onboarding is accepted", `${done.status} ${brief(done.data)}`);
    let rows = await flags();
    ctx.check("db", rows.length === 1 && rows[0].value === "true" && rows[0].user_id === SMOKE_USER_ID, "one preference row onboarding_completed = \"true\" is stored for this account", brief(rows));
    const s1 = must(await ctx.api("GET", "/onboarding-status"), "status");
    ctx.check("action", s1.completed === true, "onboarding now reads finished", brief(s1));

    // again, and three at once: still one row
    const rowId = rows[0]?.id;
    must(await ctx.api("POST", "/onboarding/complete"), "second call");
    const burst = await Promise.all([1, 2, 3].map(() => ctx.api("POST", "/onboarding/complete", {})));
    ctx.check("action", burst.every((r) => r.ok), "a second call and three at once all answer success", burst.map((r) => r.status).join(","));
    rows = await flags();
    ctx.check("db", rows.length === 1 && rows[0].value === "true" && rows[0].id === rowId, "there is still the one row", brief(rows));

    // it cannot be taken back through the generic door, and nothing else moved
    const unset = await ctx.api("PUT", `/preferences/${KEY}`, { value: "false" });
    ctx.check("action", unset.status === 400, "the generic preferences route cannot unset it", `${unset.status}`);
    ctx.check("db", (await flags())[0]?.value === "true", "the flag is still \"true\"");
    ctx.check("db", (await ctx.db.count("preferences", `key=neq.${KEY}&key=not.like.lock:*`)) === others0, "no other preference row was added or removed");

    // first finish from an empty start, raced
    await dbWrite("DELETE", `preferences?key=eq.${KEY}&${mine}`);
    const race = await Promise.all([1, 2, 3, 4].map(() => ctx.api("POST", "/onboarding/complete")));
    rows = await flags();
    ctx.check("db", race.every((r) => r.ok) && rows.length === 1 && rows[0].value === "true", "four first calls at the same moment leave exactly one row", `${race.map((r) => r.status).join(",")}; ${rows.length} row(s)`);
  },
});

// ── memory.cancel.api — DELETE /api/workspace/memory/:app/conversation ──────

scenario({
  id: "api-rest.memory-clear-conversation",
  title: "Clearing an assistant's conversation empties that conversation only: its memories stay, the other assistant's row is untouched (WA13)",
  area: "AI memory",
  covers: ["memory.cancel.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const J = "ai_memory:journal", N = "ai_memory:notes";
    const [j0, n0] = [await prefRow(ctx, J), await prefRow(ctx, N)];
    ctx.cleanup(async () => { await restorePref(J, j0); await restorePref(N, n0); });
    const parsed = async (key: string) => { const r = await prefRow(ctx, key); return r ? JSON.parse(r.value) : null; };

    // each assistant is told one thing to remember (the person's own door; no AI needed)
    const factJ = `${ctx.tag} walks before breakfast`, factN = `${ctx.tag} keeps recipes in Notes`;
    const addJ = await ctx.api("POST", "/workspace/memory/journal/remember", { text: factJ });
    const addN = await ctx.api("POST", "/workspace/memory/notes/remember", { text: factN });
    ctx.check("action", addJ.status === 201 && addN.status === 201, "each assistant accepts something to remember", `${addJ.status}, ${addN.status}`);
    const jMem = (await parsed(J))?.memories?.find((m: any) => m.text === factJ);
    ctx.check("db", !!jMem && jMem.by === "you" && (await parsed(N))?.memories?.some((m: any) => m.text === factN), "each is stored in its own assistant's row, as the person's own");

    // A saved conversation is only ever written after an AI answer, so it is
    // seeded here in the stored shape (shared/ai-memory.ts SavedTurn).
    const seedTurns = async (key: string, who: string) => {
      const m = await parsed(key);
      const at = new Date(Date.now() - 60_000).toISOString();
      const turns = [{ role: "user", content: `${ctx.tag} ${who}: I slept badly`, at }, { role: "assistant", content: `${ctx.tag} ${who}: what kept you up?`, at }];
      await dbWrite("PATCH", `preferences?key=eq.${enc(key)}&${mine}`, { value: JSON.stringify({ ...m, turns, lastTalked: at }) });
    };
    await seedTurns(J, "coach");
    await seedTurns(N, "notes");
    const seenJ = must(await ctx.api("GET", "/workspace/memory/journal"), "read the coach's memory");
    ctx.check("action", seenJ.turns?.length === 2 && seenJ.memories?.some((m: any) => m.text === factJ), "the coach's saved conversation (two turns) and its memory are what the app shows", brief(seenJ));
    const nBefore = (await prefRow(ctx, N))?.value;

    // refusals
    const unknown = await ctx.api("DELETE", "/workspace/memory/word/conversation");
    ctx.check("action", unknown.status === 400, "an assistant that has no memory (word) is refused", `${unknown.status}`);
    const viaPrefs = await ctx.api("PUT", `/preferences/${enc(J)}`, { value: "{}" });
    ctx.check("action", viaPrefs.status === 400, "the generic preferences route refuses the memory row", `${viaPrefs.status}`);
    ctx.check("db", (await parsed(J))?.turns?.length === 2 && (await prefRow(ctx, N))?.value === nBefore, "neither refusal changed either row");

    // clear the coach's conversation
    const t0 = Date.now();
    const cleared = await ctx.api("DELETE", "/workspace/memory/journal/conversation");
    ctx.check("action", cleared.ok && Array.isArray(cleared.data?.turns) && cleared.data.turns.length === 0 && cleared.data.memories?.some((m: any) => m.id === jMem?.id), "clearing answers with an empty conversation and the memory still listed", `${cleared.status} ${brief(cleared.data)}`);
    ctx.check("action", cleared.data && !("clearedAt" in cleared.data), "the answer does not carry the internal cleared stamp");
    const j1 = await parsed(J);
    ctx.check("db", Array.isArray(j1?.turns) && j1.turns.length === 0, "the stored conversation is empty", brief(j1?.turns));
    ctx.check("db", j1?.memories?.length === seenJ.memories.length && j1.memories.some((m: any) => m.id === jMem?.id && m.text === factJ && m.by === "you"), "every memory is still stored, unchanged", brief(j1?.memories));
    const stamp = Date.parse(j1?.clearedAt);
    ctx.check("db", Number.isFinite(stamp) && stamp >= t0 - 5_000 && stamp <= Date.now() + 5_000, "the row records when it was cleared (so a reply already on its way is not saved back)", String(j1?.clearedAt));
    ctx.check("db", (await prefRow(ctx, N))?.value === nBefore, "the Notes assistant's row — conversation and memory — is byte-for-byte what it was");
    const seenN = must(await ctx.api("GET", "/workspace/memory/notes"), "read the Notes assistant");
    ctx.check("action", seenN.turns?.length === 2 && seenN.memories?.some((m: any) => m.text === factN), "the Notes assistant still shows its two turns and its memory");
    const back = must(await ctx.api("GET", "/workspace/memory/journal"), "read the coach again");
    ctx.check("action", back.turns.length === 0 && back.memories.some((m: any) => m.id === jMem?.id), "read again, the coach has no conversation and still has the memory");

    // again: nothing more to clear, nothing lost
    const twice = await ctx.api("DELETE", "/workspace/memory/journal/conversation");
    const j2 = await parsed(J);
    ctx.check("action", twice.ok, "clearing an already empty conversation succeeds", `${twice.status}`);
    ctx.check("db", j2.turns.length === 0 && brief(j2.memories, 4000) === brief(j1.memories, 4000) && (await ctx.db.count("preferences", `key=eq.${enc(J)}`)) === 1, "still one row, no conversation, the same memories");

    // a clear and a new memory at the same moment: neither is lost
    await seedTurns(J, "coach");
    const fact2 = `${ctx.tag} is training for a 10k`;
    const [c, a] = await Promise.all([ctx.api("DELETE", "/workspace/memory/journal/conversation"), ctx.api("POST", "/workspace/memory/journal/remember", { text: fact2 })]);
    const j3 = await parsed(J);
    ctx.check("db", c.ok && a.status === 201 && j3.turns.length === 0 && j3.memories.some((m: any) => m.text === fact2) && j3.memories.some((m: any) => m.id === jMem?.id), "cleared and told something new at once: the conversation is empty and both memories are stored", `${c.status}/${a.status} turns=${j3.turns.length} memories=${brief(j3.memories.map((m: any) => m.text))}`);
    ctx.check("db", (await ctx.db.count("preferences", `key=like.lock:ai_memory:*`)) === 0, "no lock row is left behind");
  },
});

// ── bankLedger — connected bank rows (seeded; isolated stack only) ──────────

interface Bank {
  conn: any; checking: any; savings: any;
  groceries: any; coffee: any; pay: any; out: any; inn: any; link: any;
  G: number; C: number; P: number; X: number; BAL_C: number; BAL_S: number;
  from: string; to: string; scope: string;
}

/** One connection, two accounts, five transactions this month and one detected transfer — as a bank sync stores them. */
async function seedBank(ctx: Ctx): Promise<Bank> {
  const u = SMOKE_USER_ID, t = ctx.tag;
  ctx.cleanup(async () => {
    await dbWrite("DELETE", `financial_accounts?stripe_financial_connections_account_id=like.${enc(t)}*&${mine}`); // transactions, overrides and links cascade
    await dbWrite("DELETE", `financial_connections?stripe_account_holder_id=like.${enc(t)}*&${mine}`);
  });
  const G = ctx.int(2000, 9000), C = ctx.int(300, 900), P = ctx.int(1800, 3200) * 100, X = ctx.int(1, 5) * 10000;
  const BAL_C = ctx.int(1000, 5000) * 100 + 45, BAL_S = ctx.int(8000, 20000) * 100;
  const [conn] = await dbWrite("POST", "financial_connections", { user_id: u, stripe_account_holder_id: `${t}-holder`, stripe_session_id: `${t}-session`, institution_name: `${t} Bank`, connection_status: "active" });
  const acct = (k: string, sub: string, bal: number) => ({ user_id: u, financial_connection_id: conn.id, stripe_financial_connections_account_id: `${t}-${k}`, institution_name: `${t} Bank`, account_name: `${t} ${k}`, account_display_name: `${t} ${k}`, account_category: "cash", account_subcategory: sub, account_type: "depository", last_four: "4242", current_balance: bal, available_balance: bal, balance_as_of: new Date().toISOString(), status: "active" });
  const [checking, savings] = await dbWrite("POST", "financial_accounts", [acct("Checking", "checking", BAL_C), acct("Savings", "savings", BAL_S)]);
  const txn = (k: string, a: any, amount: number, x: Record<string, unknown>) => ({ user_id: u, financial_account_id: a.id, stripe_transaction_id: `${t}-${k}`, transaction_date: ctx.today, amount, status: "posted", ...x });
  const base = { category: null, merchant_name: null, is_income: false, is_expense: false };
  const [groceries, coffee, pay, out, inn] = await dbWrite("POST", "financial_transactions", [
    txn("groceries", checking, -G, { ...base, description: `${t} MARKET #12`, merchant_name: `${t} Market`, category: "groceries", is_expense: true }),
    txn("coffee", checking, -C, { ...base, description: `${t} CAFE`, merchant_name: `${t} Cafe`, category: "food_and_drink", is_expense: true }),
    txn("pay", checking, P, { ...base, description: `${t} PAYROLL DIRECT DEP`, merchant_name: `${t} Employer`, is_income: true }),
    txn("out", checking, -X, { ...base, description: `${t} ONLINE TRANSFER TO SAV 4242` }),
    txn("in", savings, X, { ...base, description: `${t} ONLINE TRANSFER FROM CHK 4242` }),
  ]);
  const [link] = await dbWrite("POST", "financial_transfer_links", { user_id: u, outflow_transaction_id: out.id, inflow_transaction_id: inn.id, confidence: 0.6, state: "detected", signals: { sameAmount: true } });
  const month = ctx.today.slice(0, 7), y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const from = `${month}-01`, to = `${month}-${String(O.daysInMonth(y, m)).padStart(2, "0")}`;
  return { conn, checking, savings, groceries, coffee, pay, out, inn, link, G, C, P, X, BAL_C, BAL_S, from, to, scope: `startDate=${from}&endDate=${to}&accountIds=${checking.id},${savings.id}` };
}

const usd = (m: any) => Number(m?.usd ?? 0);
/** The month's connected figures, scoped to the seeded accounts. Amounts are in cents. */
async function ledger(ctx: Ctx, b: Bank) {
  const cash = must(await ctx.api("GET", `/finance/cashflow?${b.scope}`), "cashflow");
  const spend = must(await ctx.api("GET", `/finance/spending?${b.scope}`), "spending");
  const inc = must(await ctx.api("GET", `/finance/income?${b.scope}`), "income");
  if (!cash.inflows || !cash.outflows || !Array.isArray(spend.breakdown) || !inc.total || !Array.isArray(inc.needsReview)) throw new Error(`finance views have no totals: ${brief({ cash, spend, inc }, 300)}`);
  const cat = (key: string) => spend.breakdown.filter((r: any) => r.key === key && r.currency === "usd").reduce((s: number, r: any) => s + r.amount, 0);
  return { inflows: usd(cash.inflows), outflows: usd(cash.outflows), net: usd(cash.net), excludedTransfers: cash.excludedTransferCount, uncertain: cash.uncertainTransferCount, income: usd(inc.total), review: inc.needsReview.map((t: any) => t.id) as string[], cat, spending: spend.breakdown.filter((r: any) => r.currency === "usd").reduce((s: number, r: any) => s + r.amount, 0) };
}

scenario({
  id: "api-rest.bank-transfer",
  title: "A transfer between own accounts, once confirmed, is neither income nor spending; rejected, it counts again",
  area: "Connected bank data",
  covers: ["bankLedger.transfer.api"],
  requires: ["action", "db", "derived"],
  isolatedOnly: true,
  run: async (ctx) => {
    const b = await seedBank(ctx);
    const linkRow = () => ctx.db.row("financial_transfer_links", b.link.id);
    const legs = async () => (await ctx.db.rows("financial_transactions", `id=in.(${b.out.id},${b.inn.id})&order=amount.asc`)).map((r: any) => [r.amount, r.is_transfer, r.excluded_from_totals]);

    // as imported: a detected (unconfirmed) pair still counts on both sides
    const l0 = await ledger(ctx, b);
    ctx.same("derived", [l0.inflows, l0.outflows, l0.net], [b.P + b.X, b.G + b.C + b.X, b.P - b.G - b.C], "before confirming: money in, money out, net (cents)");
    ctx.same("derived", [l0.income, l0.spending, l0.cat("uncategorized")], [b.P, b.G + b.C + b.X, b.X], "before confirming: income is the pay only; spending includes the unconfirmed outflow as uncategorized");
    ctx.check("derived", l0.uncertain === 1 && l0.review.includes(b.inn.id), "the pair is flagged as one uncertain transfer and its deposit awaits review");
    const legs0 = await legs();

    // refusals
    for (const [what, body] of [["an unknown state", { state: "maybe" }], ["no state", {}], ["state: detected (not a person's answer)", { state: "detected" }]] as const) {
      const r = await ctx.api("POST", `/finance/transfers/${b.link.id}`, body);
      ctx.check("action", r.status === 400, `${what} is refused`, `${r.status} ${brief(r.data)}`);
    }
    const missing = await ctx.api("POST", `/finance/transfers/${RANDOM_ID}`, { state: "confirmed" });
    ctx.check("action", missing.status === 404, "a transfer that does not exist is not found", `${missing.status}`);
    const junk = await ctx.api("POST", "/finance/transfers/not-an-id", { state: "confirmed" });
    ctx.check("action", is4xx(junk.status), "an id that is not an id is refused, not a server error", `${junk.status} ${brief(junk.data)}`);
    const other = await ctx.apiAsOther("POST", `/finance/transfers/${b.link.id}`, { state: "confirmed" });
    ctx.check("isolation", other.status === 404, "another account cannot confirm this account's transfer", `${other.status}`);
    ctx.check("db", (await linkRow())?.state === "detected", "after the refusals the link is still detected");

    // confirm
    const ok = await ctx.api("POST", `/finance/transfers/${b.link.id}`, { state: "confirmed" });
    ctx.check("action", ok.ok && ok.data?.state === "confirmed", "confirming is accepted", `${ok.status} ${brief(ok.data)}`);
    const row = await linkRow();
    ctx.check("db", row?.state === "confirmed" && row.outflow_transaction_id === b.out.id && row.inflow_transaction_id === b.inn.id && row.transfer_group_id === b.link.transfer_group_id, "the link row reads confirmed, still joining the same two transactions", brief(row));
    ctx.same("db", await legs(), legs0, "the two imported transactions are not edited (amount, flags)");
    ctx.check("db", (await ctx.db.count("financial_transfer_links", `outflow_transaction_id=eq.${b.out.id}`)) === 1, "there is still one link for the pair");
    const l1 = await ledger(ctx, b);
    ctx.same("derived", [l1.inflows, l1.outflows, l1.net], [b.P, b.G + b.C, b.P - b.G - b.C], "confirmed: money in and out no longer include the transfer; net is unchanged (cents)");
    ctx.same("derived", [l1.income, l1.spending, l1.cat("uncategorized")], [b.P, b.G + b.C, 0], "confirmed: income is the pay, spending is groceries + coffee, nothing uncategorized");
    ctx.check("derived", l1.excludedTransfers === 2 && l1.uncertain === 0 && !l1.review.includes(b.inn.id), "both legs are reported as left out, none uncertain, and the deposit no longer awaits review", brief({ ex: l1.excludedTransfers, un: l1.uncertain }));
    const list = must(await ctx.api("GET", `/finance/transactions?${b.scope}`), "transactions").transactions as any[];
    const grp = (id: string) => list.find((x) => x.id === id)?.transferGroupId;
    ctx.check("action", !!grp(b.out.id) && grp(b.out.id) === grp(b.inn.id) && grp(b.pay.id) === null, "the transaction list marks the two legs as one transfer group, and the pay as none");
    const shown = must(await ctx.api("GET", "/finance/transfers"), "transfers").transfers as any[];
    ctx.check("action", shown.filter((x) => x.id === b.link.id && x.state === "confirmed" && x.outflow?.id === b.out.id && x.inflow?.id === b.inn.id).length === 1, "the transfers list shows it once, confirmed, with both sides");

    // twice, and twice at once
    const rep = await Promise.all([ctx.api("POST", `/finance/transfers/${b.link.id}`, { state: "confirmed" }), ctx.api("POST", `/finance/transfers/${b.link.id}`, { state: "confirmed" })]);
    const l1b = await ledger(ctx, b);
    ctx.check("derived", rep.every((r) => r.ok) && (await linkRow())?.state === "confirmed" && l1b.outflows === b.G + b.C && l1b.inflows === b.P, "confirming again (two at once) changes nothing");

    // reject: it is not a transfer after all
    const no = await ctx.api("POST", `/finance/transfers/${b.link.id}`, { state: "rejected" });
    ctx.check("action", no.ok && no.data?.state === "rejected", "rejecting is accepted", `${no.status}`);
    ctx.check("db", (await linkRow())?.state === "rejected", "the link row reads rejected");
    const l2 = await ledger(ctx, b);
    ctx.same("derived", [l2.inflows, l2.outflows, l2.spending, l2.excludedTransfers, l2.uncertain], [b.P + b.X, b.G + b.C + b.X, b.G + b.C + b.X, 0, 0], "rejected: both sides count again, and it is no longer offered as a possible transfer");
    ctx.check("action", !(must(await ctx.api("GET", "/finance/transfers"), "transfers").transfers as any[]).some((x) => x.id === b.link.id), "the transfers list no longer shows it");
    ctx.check("action", (must(await ctx.api("GET", `/finance/transactions?${b.scope}`), "transactions").transactions as any[]).find((x) => x.id === b.out.id)?.transferGroupId === null, "and its legs carry no transfer group");
  },
});

scenario({
  id: "api-rest.bank-corrections",
  title: "Corrections to a bank transaction or account are stored beside the imported row, never over it, and the month's totals follow",
  area: "Connected bank data",
  covers: ["bankLedger.edit.api"],
  requires: ["action", "db", "derived"],
  isolatedOnly: true,
  run: async (ctx) => {
    const b = await seedBank(ctx);
    const override = async (id: string) => (await ctx.db.rows("financial_transaction_overrides", `financial_transaction_id=eq.${id}`));
    const imported = async (id: string) => { const r = await ctx.db.row("financial_transactions", id); return [r.amount, r.category, r.merchant_name, r.is_income, r.is_expense, r.is_transfer, r.excluded_from_totals, r.updated_at]; };
    const patchT = (id: string, body: any) => ctx.api("PATCH", `/finance/transactions/${id}`, body);
    const coffee0 = await imported(b.coffee.id), groceries0 = await imported(b.groceries.id);
    const l0 = await ledger(ctx, b);
    ctx.same("derived", [l0.cat("groceries"), l0.cat("food_and_drink"), l0.outflows, l0.income], [b.G, b.C, b.G + b.C + b.X, b.P], "as imported: groceries, food & drink, money out, income (cents)");

    // ── a transaction: refusals write nothing ──
    for (const [what, body] of [["a 61-character category", { category: "x".repeat(61) }], ["isIncome: \"yes\"", { isIncome: "yes" }], ["a linked record id that is not an id", { linkedProfileId: "abc" }], ["a 2,001-character note", { note: "n".repeat(2001) }]] as const) {
      const r = await patchT(b.coffee.id, body);
      ctx.check("action", r.status === 400, `${what} is refused`, `${r.status} ${brief(r.data)}`);
    }
    const noRec = await patchT(b.coffee.id, { category: "dining", linkedProfileId: RANDOM_ID });
    ctx.check("action", noRec.status === 404, "linking a record that does not exist is refused", `${noRec.status}`);
    const noTxn = await patchT(RANDOM_ID, { category: "dining" });
    ctx.check("action", noTxn.status === 404, "a transaction that does not exist is not found", `${noTxn.status}`);
    const other = await ctx.apiAsOther("PATCH", `/finance/transactions/${b.coffee.id}`, { category: "theirs", excludedFromTotals: true });
    ctx.check("isolation", other.status === 404, "another account cannot correct this account's transaction", `${other.status}`);
    ctx.check("db", (await override(b.coffee.id)).length === 0 && (await ctx.db.count("financial_transaction_overrides", `financial_transaction_id=eq.${RANDOM_ID}`)) === 0, "none of the refused requests stored a correction");

    // ── category and note ──
    const note = `${ctx.tag} with Sam`;
    const cat = await patchT(b.coffee.id, { category: "coffee", note });
    ctx.check("action", cat.ok && cat.data?.override?.category === "coffee", "re-categorising the cafe charge is accepted", `${cat.status} ${brief(cat.data)}`);
    let ov = await override(b.coffee.id);
    ctx.check("db", ov.length === 1 && ov[0].category === "coffee" && ov[0].note === note && ov[0].user_id === SMOKE_USER_ID && ov[0].is_income === null && ov[0].excluded_from_totals === null, "one correction row holds the category and the note, and nothing that was not sent", brief(ov));
    ctx.same("db", await imported(b.coffee.id), coffee0, "the imported transaction row is untouched");
    const l1 = await ledger(ctx, b);
    ctx.same("derived", [l1.cat("coffee"), l1.cat("food_and_drink"), l1.cat("groceries"), l1.outflows], [b.C, 0, b.G, l0.outflows], "the charge moved from food & drink to coffee; groceries and money out did not move");
    const listed = (must(await ctx.api("GET", `/finance/transactions?${b.scope}&category=coffee`), "transactions").transactions as any[]);
    ctx.check("action", listed.length === 1 && listed[0].id === b.coffee.id && listed[0].amount === -b.C, "the transaction list, filtered to coffee, shows that one charge");

    // a second correction keeps the first (only what was sent is written)
    const merch = await patchT(b.coffee.id, { merchantName: `${ctx.tag} Roasters` });
    ov = await override(b.coffee.id);
    ctx.check("db", merch.ok && ov.length === 1 && ov[0].merchant_name === `${ctx.tag} Roasters` && ov[0].category === "coffee" && ov[0].note === note, "renaming the merchant keeps the category and the note, in the same single row", brief(ov));

    // ── left out of totals, then put back ──
    const excl = await patchT(b.groceries.id, { excludedFromTotals: true });
    ctx.check("action", excl.ok, "leaving the grocery charge out of totals is accepted", `${excl.status}`);
    ctx.check("db", (await override(b.groceries.id))[0]?.excluded_from_totals === true, "its correction row says excluded");
    ctx.same("db", await imported(b.groceries.id), groceries0, "its imported row is untouched");
    const l2 = await ledger(ctx, b);
    ctx.same("derived", [l2.outflows, l2.cat("groceries"), l2.net, l2.income], [l0.outflows - b.G, 0, l0.net + b.G, b.P], "money out fell by exactly that charge, groceries is empty, net rose by it, income did not move");
    const back = await patchT(b.groceries.id, { excludedFromTotals: null });
    ctx.check("db", back.ok && (await override(b.groceries.id))[0]?.excluded_from_totals === null, "null clears the correction (the bank's value applies again)");
    const l3 = await ledger(ctx, b);
    ctx.same("derived", [l3.outflows, l3.cat("groceries")], [l0.outflows, b.G], "and the charge counts again");

    // ── who it belongs to ──
    const car = await mkProfile(ctx, { type: "vehicle", name: `${ctx.tag} Van`, fields: { currentValue: 9000 } });
    const own = await patchT(b.groceries.id, { linkedAssetProfileId: car.id, linkedProfileId: ctx.self.id });
    ov = await override(b.groceries.id);
    ctx.check("db", own.ok && ov.length === 1 && ov[0].linked_asset_profile_id === car.id && ov[0].linked_profile_id === ctx.self.id, "linking the charge to a person and an asset stores both ids", brief(ov));
    const badOwner = await patchT(b.groceries.id, { linkedAssetProfileId: RANDOM_ID, category: "should-not-stick" });
    ov = await override(b.groceries.id);
    ctx.check("db", badOwner.status === 404 && ov[0].linked_asset_profile_id === car.id && ov[0].category === null, "a link to a record that does not exist is refused whole: the stored link and category are unchanged", `${badOwner.status} ${brief(ov)}`);

    // ── income: the person's answer decides ──
    const asIncome = await patchT(b.inn.id, { isIncome: true });
    const l4 = await ledger(ctx, b);
    ctx.check("derived", asIncome.ok && l4.income === b.P + b.X && !l4.review.includes(b.inn.id), "a deposit the person marks as income joins income and leaves the review list", `income ${l4.income}`);
    await patchT(b.inn.id, { isIncome: null });
    const l5 = await ledger(ctx, b);
    ctx.check("derived", l5.income === b.P && l5.review.includes(b.inn.id), "cleared, it is under review again and income is the pay only");

    // ── two corrections to an uncorrected transaction at the same moment ──
    const pair = await Promise.all([patchT(b.pay.id, { note: `${ctx.tag} bonus` }), patchT(b.pay.id, { category: "salary" })]);
    ov = await override(b.pay.id);
    ctx.check("db", pair.every((r) => r.ok) && ov.length === 1 && ov[0].note === `${ctx.tag} bonus` && ov[0].category === "salary", "two corrections at once land in one row and neither is lost", `${pair.map((r) => r.status).join(",")} ${brief(ov)}`);
    ctx.check("db", (await ctx.db.row("financial_transactions", b.pay.id)).amount === b.P, "a correction never changes the amount the bank reported");

    // ── an account ──
    const patchA = (id: string, body: any) => ctx.api("PATCH", `/finance/accounts/${id}`, body);
    const acct = (id: string) => ctx.db.row("financial_accounts", id);
    const frozen = (r: any) => [r.account_name, r.current_balance, r.status, r.financial_connection_id, r.stripe_financial_connections_account_id];
    const sav0 = await acct(b.savings.id);
    const worth = async () => { const s = must(await ctx.api("GET", `/finance/summary?accountIds=${b.checking.id},${b.savings.id}`), "summary").netWorth; if (!s?.connectedAssets || !s.manualAssets) throw new Error("summary has no net worth"); return { connected: usd(s.connectedAssets), manual: usd(s.manualAssets), dedup: s.deduplicatedManualCount as number }; };
    const w0 = await worth();
    ctx.same("derived", w0.connected, b.BAL_C + b.BAL_S, "connected assets are the two balances (cents)");

    for (const [what, body] of [["an empty name", { accountDisplayName: "  " }], ["isHidden: \"yes\"", { isHidden: "yes" }], ["a matched profile id that is not an id", { matchedProfileId: "abc" }]] as const) {
      const r = await patchA(b.savings.id, body);
      ctx.check("action", r.status === 400, `account: ${what} is refused`, `${r.status}`);
    }
    const aMissing = await patchA(RANDOM_ID, { isHidden: true });
    const aNoProf = await patchA(b.savings.id, { matchedProfileId: RANDOM_ID, isHidden: true });
    const aOther = await ctx.apiAsOther("PATCH", `/finance/accounts/${b.savings.id}`, { accountDisplayName: "theirs", isHidden: true });
    ctx.check("action", aMissing.status === 404 && aNoProf.status === 404, "an account, or a matched profile, that does not exist is not found", `${aMissing.status}, ${aNoProf.status}`);
    ctx.check("isolation", aOther.status === 404, "another account cannot change this account's bank account", `${aOther.status}`);
    const empty = await patchA(b.savings.id, {});
    ctx.check("db", empty.ok && brief(await acct(b.savings.id), 4000) === brief(sav0, 4000), "after the refusals and an empty update the account row is exactly as imported");

    const renamed = await patchA(b.savings.id, { accountDisplayName: `${ctx.tag} Rainy Day` });
    let s = await acct(b.savings.id);
    ctx.check("action", renamed.ok && renamed.data?.account?.accountDisplayName === `${ctx.tag} Rainy Day`, "renaming the account is accepted", `${renamed.status}`);
    ctx.check("db", s.account_display_name === `${ctx.tag} Rainy Day` && s.is_hidden === false && s.include_in_net_worth === true, "the row stores the display name and nothing else changed", brief([s.account_display_name, s.is_hidden, s.include_in_net_worth]));
    ctx.same("db", frozen(s), frozen(sav0), "the bank's own name, balance, status and connection are untouched");

    const outNW = await patchA(b.savings.id, { includeInNetWorth: false });
    ctx.check("db", outNW.ok && (await acct(b.savings.id)).include_in_net_worth === false, "taking it out of net worth is stored");
    ctx.same("derived", (await worth()).connected, b.BAL_C, "connected assets fell by exactly the savings balance");
    await patchA(b.savings.id, { includeInNetWorth: true });
    ctx.same("derived", (await worth()).connected, b.BAL_C + b.BAL_S, "put back, they are the two balances again");

    const hide = await patchA(b.checking.id, { isHidden: true });
    ctx.check("db", hide.ok && (await acct(b.checking.id)).is_hidden === true && (await acct(b.checking.id)).current_balance === b.BAL_C, "hiding the checking account is stored; its balance is kept");
    ctx.same("derived", (await worth()).connected, b.BAL_S, "a hidden account is not in connected assets");
    const all = must(await ctx.api("GET", "/finance/accounts"), "accounts").accounts as any[];
    ctx.check("action", all.some((a) => a.id === b.checking.id && a.isHidden === true), "it is still listed (as hidden) where accounts are managed — hidden is not deleted");
    await patchA(b.checking.id, { isHidden: false });

    // matched to a manual record: that money counts once
    const manual = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} Savings (typed)`, fields: { currentValue: 700 } });
    const w1 = await worth();
    ctx.same("derived", w1.manual - w0.manual, 70000, "a typed-in asset worth 700 adds 70,000 cents to manual assets");
    const match = await patchA(b.savings.id, { matchedProfileId: manual.id });
    ctx.check("db", match.ok && (await acct(b.savings.id)).matched_profile_id === manual.id, "matching the bank account to it stores the profile id");
    const w2 = await worth();
    ctx.same("derived", [w2.manual - w0.manual, w2.connected, w2.dedup - w1.dedup], [0, b.BAL_C + b.BAL_S, 1], "matched: the typed-in copy leaves the total (counted once, by the bank's balance) and is reported as deduplicated");
    const unmatch = await patchA(b.savings.id, { matchedProfileId: null });
    ctx.check("db", unmatch.ok && (await acct(b.savings.id)).matched_profile_id === null, "null clears the match");
    ctx.same("derived", (await worth()).manual - w0.manual, 70000, "and the typed-in asset counts again");
    ctx.check("db", (await ctx.db.row("profiles", manual.id))?.fields?.currentValue === 700, "matching never changed the typed-in record");

    const both = await Promise.all([patchA(b.savings.id, { isHidden: true }), patchA(b.savings.id, { accountDisplayName: `${ctx.tag} Both` })]);
    s = await acct(b.savings.id);
    ctx.check("db", both.every((r) => r.ok) && s.is_hidden === true && s.account_display_name === `${ctx.tag} Both`, "two different changes at once both land", brief([s.is_hidden, s.account_display_name]));
  },
});

scenario({
  id: "api-rest.bank-disconnect",
  title: "Disconnecting a bank keeps its history unless asked to delete it; a connection cannot be completed without the bank provider",
  area: "Connected bank data",
  covers: ["bankLedger.archive.api"],
  requires: ["action", "db", "derived"],
  isolatedOnly: true,
  run: async (ctx) => {
    const b = await seedBank(ctx);
    must(await ctx.api("PATCH", `/finance/transactions/${b.coffee.id}`, { category: "coffee" }), "a correction to carry along");
    const manual = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} Typed Savings`, fields: { currentValue: 450 } });
    must(await ctx.api("PATCH", `/finance/accounts/${b.savings.id}`, { matchedProfileId: manual.id }), "match");
    const acctIds = `(${b.checking.id},${b.savings.id})`;
    const txnIds = `(${[b.groceries, b.coffee, b.pay, b.out, b.inn].map((t) => t.id).join(",")})`;
    const counts = async () => ({
      conn: await ctx.db.row("financial_connections", b.conn.id),
      accounts: await ctx.db.rows("financial_accounts", `id=in.${acctIds}&order=account_name.asc`),
      txns: await ctx.db.count("financial_transactions", `id=in.${txnIds}`),
      overrides: await ctx.db.count("financial_transaction_overrides", `financial_transaction_id=in.${txnIds}`),
      links: await ctx.db.count("financial_transfer_links", `id=eq.${b.link.id}`),
    });
    const connected = async () => usd(must(await ctx.api("GET", `/finance/summary?accountIds=${b.checking.id},${b.savings.id}`), "summary").netWorth?.connectedAssets);
    const c0 = await counts();
    ctx.check("db", c0.txns === 5 && c0.overrides === 1 && c0.links === 1 && c0.accounts.length === 2 && c0.conn?.connection_status === "active", "the fixture: one connection, two accounts, five transactions, one correction, one transfer link");
    ctx.same("derived", await connected(), b.BAL_C + b.BAL_S, "connected assets are the two balances (cents)");

    // ── completing a connection needs the bank provider ──
    const conns0 = await ctx.db.count("financial_connections", "id=not.is.null");
    const noBody = await ctx.api("POST", "/finance/connections/complete", {});
    const shortId = await ctx.api("POST", "/finance/connections/complete", { sessionId: "short" });
    ctx.check("action", noBody.status === 400 && shortId.status === 400, "completing with no session id, or one too short, is refused", `${noBody.status}, ${shortId.status}`);
    const fake = await ctx.api("POST", "/finance/connections/complete", { sessionId: `fcsess_${ctx.tag}_0000000000` });
    ctx.check("action", is4xx(fake.status) || fake.status === 503, "a made-up session is refused or reported unavailable — never a server error, never a success", `${fake.status} ${brief(fake.data)}`);
    ctx.check("action", typeof fake.data?.code === "string" && typeof fake.data?.error === "string" && !/stripe|sk_|stack|at \w+ \(/i.test(String(fake.data?.error).replace(/Stripe keys/, "")), "the refusal is a code and a plain sentence, with no provider internals", brief(fake.data));
    ctx.check("db", (await ctx.db.count("financial_connections", "id=not.is.null")) === conns0 && (await ctx.db.count("financial_accounts", "id=not.is.null")) === 2, "none of them stored a connection or an account");

    // ── refusals ──
    const missing = await ctx.api("POST", `/finance/connections/${RANDOM_ID}/disconnect`, { deleteData: true });
    ctx.check("action", missing.status === 404, "a connection that does not exist is not found", `${missing.status}`);
    const other = await ctx.apiAsOther("POST", `/finance/connections/${b.conn.id}/disconnect`, { deleteData: true });
    ctx.check("isolation", other.status === 404, "another account cannot disconnect (or delete) this account's bank", `${other.status}`);
    ctx.same("db", brief(await counts(), 6000), brief(c0, 6000), "after the refusals every row is exactly as it was");

    // a malformed "delete my data" must never delete
    const vague = await ctx.api("POST", `/finance/connections/${b.conn.id}/disconnect`, { deleteData: "yes" });
    const cv = await counts();
    ctx.check("db", cv.txns === 5 && cv.accounts.length === 2 && cv.overrides === 1 && cv.links === 1, "deleteData: \"yes\" (not a true/false) deletes nothing", `${vague.status}; ${cv.txns} transactions, ${cv.accounts.length} accounts`);
    ctx.check("action", is4xx(vague.status) || (vague.ok && vague.data?.deleteData === false && vague.data?.transactionsDeleted === 0), "it is refused, or treated as a plain disconnect and says so", `${vague.status} ${brief(vague.data)}`);

    // ── disconnect, keeping the history ──
    const t0 = Date.now();
    const off = await ctx.api("POST", `/finance/connections/${b.conn.id}/disconnect`, {});
    ctx.check("action", off.ok && off.data?.deleteData === false && off.data?.accountsDisconnected === 2 && off.data?.transactionsDeleted === 0, "disconnecting answers: two accounts disconnected, nothing deleted", `${off.status} ${brief(off.data)}`);
    const c1 = await counts();
    const at = Date.parse(c1.conn?.disconnected_at);
    ctx.check("db", c1.conn?.connection_status === "disconnected" && Number.isFinite(at) && at >= t0 - 60_000 && at <= Date.now() + 5_000, "the connection row reads disconnected, with the time", brief([c1.conn?.connection_status, c1.conn?.disconnected_at]));
    ctx.check("db", c1.accounts.length === 2 && c1.accounts.every((a: any) => a.status === "disconnected") && c1.accounts.map((a: any) => a.current_balance).sort().join() === [b.BAL_C, b.BAL_S].sort().join(), "both account rows read disconnected and keep their last balance", brief(c1.accounts.map((a: any) => [a.status, a.current_balance])));
    ctx.check("db", c1.txns === 5 && c1.overrides === 1 && c1.links === 1, "all five transactions, the correction and the transfer link are kept");
    ctx.same("derived", await connected(), 0, "a disconnected account's last balance is no longer in connected assets");
    const l = await ledger(ctx, b);
    ctx.same("derived", [l.inflows, l.outflows, l.cat("coffee")], [b.P + b.X, b.G + b.C + b.X, b.C], "its history still reads: the month's money in, money out and the corrected category");

    const offAgain = await ctx.api("POST", `/finance/connections/${b.conn.id}/disconnect`, {});
    const c1b = await counts();
    ctx.check("db", offAgain.ok && c1b.conn?.connection_status === "disconnected" && c1b.txns === 5 && c1b.accounts.length === 2, "disconnecting again succeeds and changes nothing");

    // ── disconnect and delete the data ──
    const wipe = await ctx.api("POST", `/finance/connections/${b.conn.id}/disconnect`, { deleteData: true });
    ctx.check("action", wipe.ok && wipe.data?.deleteData === true && wipe.data?.transactionsDeleted === 5 && wipe.data?.accountsDisconnected === 2, "asked to delete: the answer counts five transactions deleted, two accounts", `${wipe.status} ${brief(wipe.data)}`);
    const c2 = await counts();
    ctx.check("db", c2.txns === 0 && c2.accounts.length === 0, "the transactions and both account rows are gone", `${c2.txns} transactions, ${c2.accounts.length} accounts`);
    ctx.check("db", c2.overrides === 0 && c2.links === 0, "their correction and transfer link went with them (no orphan rows)", `${c2.overrides} corrections, ${c2.links} links`);
    ctx.check("db", c2.conn?.connection_status === "disconnected", "the connection row stays, as disconnected (the record that a bank was once linked)");
    const typed = await ctx.db.row("profiles", manual.id);
    ctx.check("db", !!typed && typed.deleted_at == null && typed.fields?.currentValue === 450, "the typed-in record that was matched to the account is untouched");
    const after = must(await ctx.api("GET", `/finance/transactions?${b.scope}`), "transactions");
    ctx.check("action", after.transactions.length === 0 && (must(await ctx.api("GET", "/finance/accounts"), "accounts").accounts as any[]).every((a) => a.id !== b.checking.id && a.id !== b.savings.id), "the transaction and account lists no longer show them");
    const wipeAgain = await ctx.api("POST", `/finance/connections/${b.conn.id}/disconnect`, { deleteData: true });
    ctx.check("action", wipeAgain.ok && wipeAgain.data?.transactionsDeleted === 0, "asking again deletes nothing more", `${wipeAgain.status} ${brief(wipeAgain.data)}`);
  },
});

// ── chat routes when they cannot do the work ────────────────────────────────

const WRITTEN: Array<[string, string]> = [
  ["expenses", "id=not.is.null"], ["incomes", "id=not.is.null"], ["tasks", "id=not.is.null"], ["events", "id=not.is.null"], ["profiles", "id=not.is.null"],
  ["trackers", "id=not.is.null"], ["tracker_entries", "id=not.is.null"], ["artifacts", "id=not.is.null"], ["journal_entries", "id=not.is.null"],
  ["documents", "id=not.is.null"], ["habits", "id=not.is.null"], ["goals", "id=not.is.null"], ["ai_action_log", "id=not.is.null"],
];
const tally = async (ctx: Ctx) => Object.fromEntries(await Promise.all(WRITTEN.map(async ([t, q]) => [t, await ctx.db.count(t, q)] as const)));

scenario({
  id: "api-rest.chat-cannot-answer",
  title: "A chat request the app cannot carry out, and a confirmation of nothing, answer plainly and write nothing",
  area: "AI chat",
  // POST /api/chat's own create path and confirm-extraction's write need the AI
  // provider; what is verified here is the property that holds without it.
  covers: ["chat.readonly"],
  requires: ["action", "db"],
  chat: true,
  run: async (ctx) => {
    const t0 = await tally(ctx);

    // a question: with no AI it cannot be answered, with one it is only answered
    const q = await ctx.api("POST", "/chat", { message: `In two sentences, how do ${ctx.tag} index funds differ from bonds? Do not save anything.` });
    const five = ctx.check("action", q.status < 500, "a question is answered without a server error", `${q.status} ${brief(q.data)}`);
    if (!five) ctx.finding({ severity: "bug", title: "POST /api/chat answers 5xx to a plain question", detail: `${q.status} ${brief(q.data, 400)}` });
    ctx.check("action", q.ok && typeof q.data?.reply === "string" && q.data.reply.length > 0 && Array.isArray(q.data.actions) && q.data.actions.length === 0, "the answer is a reply with no actions", brief(q.data));
    if (NO_AI) ctx.check("action", /unavailable/i.test(q.data?.reply || "") && !/stack|TypeError|ECONN|api[_ ]key/i.test(q.data?.reply || ""), "with no AI provider the reply says the AI is unavailable, in plain words", brief(q.data?.reply));

    // malformed requests
    const empty = await ctx.api("POST", "/chat", {});
    const blank = await ctx.api("POST", "/chat", { message: "   " });
    const notText = await ctx.api("POST", "/chat", { message: { text: "hi" } });
    ctx.check("action", empty.status === 400 && is4xx(notText.status), "a chat request with no message, or one that is not text, is refused", `${empty.status}, ${notText.status}`);
    // A message of spaces is answered in conversation ("could you rephrase that?"), which is a reply, not a write.
    ctx.check("action", is4xx(blank.status) || (blank.ok && typeof blank.data?.reply === "string" && Array.isArray(blank.data.actions) && blank.data.actions.length === 0), "a blank message is refused or answered with a plain reply and no actions", `${blank.status} ${brief(blank.data)}`);

    // confirming an extraction that does not exist
    const noId = await ctx.api("POST", "/chat/confirm-extraction", { confirmedFields: [{ key: "name", value: `${ctx.tag} Nobody` }], items: [{ key: "name", value: `${ctx.tag} Nobody`, destination: "note", selected: true }] });
    ctx.check("action", noId.status === 400, "confirming with no extraction id is refused", `${noId.status} ${brief(noId.data)}`);
    const ghost = await ctx.api("POST", "/chat/confirm-extraction", { extractionId: RANDOM_ID, targetProfileId: ctx.self.id, confirmedFields: [{ key: "bloodType", value: `${ctx.tag}-AB` }], items: [{ key: "note", label: "Note", value: `${ctx.tag} ghost note`, destination: "note", selected: true }], createCalendarEvents: [{ field: "x", date: ctx.today, title: `${ctx.tag} ghost event`, category: "other" }] });
    const ghostOk = ctx.check("action", is4xx(ghost.status), "confirming an extraction that does not exist is refused, not a server error", `${ghost.status} ${brief(ghost.data)}`);
    if (!ghostOk && ghost.status >= 500) ctx.finding({ severity: "bug", title: "POST /api/chat/confirm-extraction answers 5xx for an unknown extraction", detail: `${ghost.status} ${brief(ghost.data, 400)}` });
    const theirs = await ctx.apiAsOther("POST", "/chat/confirm-extraction", { extractionId: RANDOM_ID, targetProfileId: ctx.self.id, confirmedFields: [{ key: "bloodType", value: `${ctx.tag}-O` }] });
    ctx.check("isolation", is4xx(theirs.status), "another account confirming onto this account's profile is refused", `${theirs.status}`);

    const t1 = await tally(ctx);
    const moved = Object.keys(t0).filter((k) => t0[k] !== t1[k]).map((k) => `${k} ${t0[k]}→${t1[k]}`);
    ctx.check("db", moved.length === 0, "no record of any kind, and no action-log row, was written by any of it", moved.join(", "));
    const self = await ctx.db.row("profiles", ctx.self.id);
    ctx.check("db", !brief(self, 20000).includes(ctx.tag), "the account holder's profile carries nothing from the refused confirmations");
    for (const [table, col] of [["artifacts", "title"], ["events", "title"], ["artifacts", "content"]] as const) {
      ctx.check("db", (await ctx.db.count(table, `${col}=ilike.*${enc(ctx.tag)}*`)) === 0, `no ${table} row carries the run's tag in its ${col}`);
    }
  },
});
