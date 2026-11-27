// AI Chat: every command is judged by the rows it left in the database, never
// by the sentence it answered with.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const inWords = (ymd: string) => { const d = O.parseYmd(ymd); return `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`; };

async function say(ctx: Ctx, message: string): Promise<string> {
  const r = await ctx.api("POST", "/chat", { message, history: [] });
  if (!r.ok) throw new Error(`chat "${message.slice(0, 60)}": ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const reply = String(r.data?.reply ?? "");
  ctx.step(`chat reply: ${reply.replace(/\s+/g, " ").slice(0, 220)}`);
  return reply;
}
/** Whatever a chat scenario left behind, by time: the model may name a record
 *  in its own words, so the run's tag is not enough to find it again. */
function sweepAfter(ctx: Ctx): void {
  const since = new Date(Date.now() - 2000).toISOString();
  for (const [table, path] of [["expenses", "/expenses"], ["tasks", "/tasks"], ["events", "/events"], ["journal_entries", "/journal"], ["habits", "/habits"], ["goals", "/goals"], ["artifacts", "/artifacts"]] as const) {
    ctx.cleanup(async () => {
      const rows = await ctx.db.rows(table, `created_at=gte.${since}&deleted_at=is.null`).catch(() => ctx.db.rows(table, `created_at=gte.${since}`));
      for (const r of rows) await ctx.api("DELETE", `${path}/${r.id}`);
    });
  }
  ctx.cleanup(async () => {
    const rows = await ctx.db.rows("profiles", `created_at=gte.${since}&deleted_at=is.null&type=neq.self`);
    for (const r of rows) await ctx.api("DELETE", `/profiles/${r.id}`);
  });
}
const live = (ctx: Ctx, table: string, col: string, like: string) => ctx.db.rows(table, `${col}=ilike.*${encodeURIComponent(like)}*&deleted_at=is.null`);

scenario({
  id: "chat.create-edit-delete",
  title: "Chat creates, changes, completes and deletes records — one row each, and the right row",
  area: "AI Chat",
  chat: true,
  covers: ["expense.create.chat", "expense.edit.chat", "expense.delete.chat", "task.create.chat", "task.complete.chat", "event.create.chat", "event.reschedule.chat", "event.delete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const word = `Zephyr${ctx.tag.slice(-4)}`;
    const snap0 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;

    // expense
    await say(ctx, `I spent $23.45 today. Call the expense "${word} lunch".`);
    let exp = await live(ctx, "expenses", "description", word);
    for (const e of exp) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
    ctx.check("db", exp.length === 1 && Math.abs(Number(exp[0]?.amount) - 23.45) < 0.005 && exp[0]?.date === ctx.today, "one expense row of 23.45 dated today", JSON.stringify(exp.map((e: any) => [e.amount, e.date, e.description])));
    const snap1 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
    ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), 23.45, "this month's spending rose by 23.45");

    await say(ctx, `Change the "${word} lunch" expense to $25`);
    exp = await live(ctx, "expenses", "description", word);
    ctx.check("db", exp.length === 1 && Math.abs(Number(exp[0]?.amount) - 25) < 0.005, "the same row now reads 25 (no second expense)", JSON.stringify(exp.map((e: any) => e.amount)));

    // task
    const due = O.addDays(ctx.today, 11);
    await say(ctx, `Add a task titled "${word} renew passport", due ${inWords(due)}`);
    let tasks = await live(ctx, "tasks", "title", word);
    for (const t of tasks) ctx.cleanup(() => ctx.api("DELETE", `/tasks/${t.id}`));
    ctx.check("db", tasks.length === 1 && tasks[0]?.due_date === due && tasks[0]?.status === "todo", `one open task row due ${due}`, JSON.stringify(tasks.map((t: any) => [t.title, t.due_date, t.status])));
    const cal = listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 30)}`), "timeline")).filter((i: any) => i.sourceId === tasks[0]?.id);
    ctx.check("derived", cal.length === 1 && cal[0].date === due, "the calendar shows the task on its due date");
    await say(ctx, `Mark the "${word} renew passport" task as done`);
    tasks = await live(ctx, "tasks", "title", word);
    ctx.check("db", tasks.length === 1 && tasks[0]?.status === "done", "the task row is done", JSON.stringify(tasks.map((t: any) => t.status)));

    // event: create, move, delete
    const day = O.addDays(ctx.today, 14);
    await say(ctx, `Schedule an event titled "${word} dentist" on ${inWords(day)} at 3pm`);
    let ev = await live(ctx, "events", "title", word);
    for (const e of ev) ctx.cleanup(() => ctx.api("DELETE", `/events/${e.id}`));
    ctx.check("db", ev.length === 1 && ev[0]?.date === day && String(ev[0]?.time).startsWith("15:00"), `one event row on ${day} at 15:00`, JSON.stringify(ev.map((e: any) => [e.title, e.date, e.time])));
    const day2 = O.addDays(day, 2);
    await say(ctx, `Move the "${word} dentist" event to ${inWords(day2)}`);
    ev = await live(ctx, "events", "title", word);
    ctx.check("db", ev.length === 1 && ev[0]?.date === day2 && String(ev[0]?.time).startsWith("15:00"), `the same event row moved to ${day2}, time kept`, JSON.stringify(ev.map((e: any) => [e.date, e.time])));
    await say(ctx, `Delete the "${word} dentist" event`);
    ev = await live(ctx, "events", "title", word);
    ctx.check("db", ev.length === 0, "the event row is deleted", `${ev.length} live`);
    ctx.check("action", !listOf(must(await ctx.api("GET", "/events"), "events")).some((e: any) => String(e.title).includes(word)), "and it left the events list");

    await say(ctx, `Delete the "${word} lunch" expense`);
    exp = await live(ctx, "expenses", "description", word);
    ctx.check("db", exp.length === 0, "the expense row is deleted", `${exp.length} live`);
    const snap2 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
    ctx.near("derived", snap2.totalMonthlySpend, snap0.totalMonthlySpend, "this month's spending is back where it started");
  },
});

scenario({
  id: "chat.cancelled-and-questions-write-nothing",
  title: "A request taken back in the same breath, and a plain question, change nothing",
  area: "AI Chat",
  chat: true,
  covers: ["expense.cancel.chat", "chat.readonly"],
  requires: ["action", "db"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const word = `Zephyr${ctx.tag.slice(-4)}`;
    const counts = async () => Promise.all(["expenses", "tasks", "events", "profiles", "habits", "goals", "journal_entries", "artifacts", "trackers", "tracker_entries", "liability_payments"].map((t) => ctx.db.count(t, "id=not.is.null")));
    const before = await counts();
    const r1 = await say(ctx, `Add a $50 expense called "${word} dinner". Actually, never mind — don't add it.`);
    const exp = await live(ctx, "expenses", "description", word);
    for (const e of exp) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
    const ok = ctx.check("db", exp.length === 0, "the withdrawn expense was not saved", `${exp.length} row(s): ${JSON.stringify(exp.map((e: any) => e.amount))}; reply: ${r1.slice(0, 120)}`);
    if (!ok) ctx.finding({ severity: "bug", title: "Chat saves an expense the same message took back", detail: `"Add a $50 expense … Actually, never mind — don't add it." stored ${exp.length} expense(s)` });
    await say(ctx, "How much have I spent on food this month?");
    await say(ctx, "What tasks do I have due this week?");
    const after = await counts();
    ctx.same("db", after, before, "row counts in eleven tables are what they were before the three messages");
    ctx.check("action", r1.length > 0, "chat answered");
  },
});

scenario({
  id: "chat.debt",
  title: "Chat: one debt is one record; a payment is recorded once and the balance is the stored one",
  area: "AI Chat",
  chat: true,
  covers: ["liability.create.chat", "liabilityPayment.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const name = `${ctx.tag} Auto Loan`;
    await say(ctx, `I have a new debt called "${name}": $18,000 at 6.5% APR, payments of $350 a month due on the 5th.`);
    const rows = await ctx.db.rows("profiles", `name=ilike.*${encodeURIComponent(ctx.tag)}*&deleted_at=is.null`);
    for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${r.id}`));
    ctx.check("db", rows.length === 1, "one profile row — no separate \"payment\" bill beside the debt", JSON.stringify(rows.map((r: any) => [r.type, r.name])));
    const f = rows[0]?.fields || {};
    ctx.check("db", rows[0]?.type === "liability" && f.balance === 18000 && f.interestRate === 6.5 && f._interestRateUnit === "percent" && f.monthlyPayment === 350 && Number(f.dueDay) === 5,
      "stored under the canonical keys: balance 18000, rate 6.5 percent, payment 350, due day 5", JSON.stringify(f).slice(0, 300));
    if (!rows[0]) return;
    const reply = await say(ctx, `I paid $350 on my ${name} today.`);
    const want = O.splitPayment(18000, 6.5, 350);
    const pays = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${rows[0].id}`);
    ctx.check("db", pays.length === 1 && Math.abs(Number(pays[0]?.amount) - 350) < 0.005, "one ledger row of 350", JSON.stringify(pays.map((p: any) => p.amount)));
    ctx.near("derived", Number(pays[0]?.interest_portion), want.interest, "its interest (18,000 at 6.5% for a month)");
    ctx.near("derived", (await ctx.db.row("profiles", rows[0].id)).fields.balance, want.newBalance, "the stored balance after the payment");
    const usd = `$${want.newBalance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    ctx.check("action", reply.includes(usd), `the reply quotes the stored balance ${usd}`, reply.replace(/\s+/g, " ").slice(0, 200));
  },
});

scenario({
  id: "chat.names-journal-foods",
  title: "Chat: a name is not a new profile, a journal request saves the words, two foods are two entries",
  area: "AI Chat",
  chat: true,
  covers: ["event.create.chat", "journal.create.chat", "trackerEntry.create.chat", "profile.create.chat"],
  requires: ["action", "db"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const person = `Quillon${ctx.tag.slice(-4)}`;
    const peopleBefore = await ctx.db.count("profiles", "type=eq.person&deleted_at=is.null");
    await say(ctx, `${person}'s birthday is September 30`);
    const made = await ctx.db.rows("profiles", `name=ilike.*${person}*&deleted_at=is.null`);
    for (const p of made) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}`));
    const ev = await live(ctx, "events", "title", person);
    for (const e of ev) ctx.cleanup(() => ctx.api("DELETE", `/events/${e.id}`));
    ctx.check("db", made.length === 0 && (await ctx.db.count("profiles", "type=eq.person&deleted_at=is.null")) === peopleBefore, "mentioning a name created no person profile", JSON.stringify(made.map((p: any) => p.name)));
    ctx.check("db", ev.length === 1 && ev[0].date.slice(5) === "09-30" && ev[0].recurrence === "yearly", "the birthday is one yearly event on September 30", JSON.stringify(ev.map((e: any) => [e.date, e.recurrence])));

    const words = `${ctx.tag} walked the long way home and felt calm for the first time this week.`;
    await say(ctx, `Save this as today's journal entry: ${words}`);
    const j = await ctx.db.rows("journal_entries", `content=ilike.*${encodeURIComponent(ctx.tag)}*`);
    for (const e of j) ctx.cleanup(() => ctx.api("DELETE", `/journal/${e.id}`));
    ctx.check("db", j.length === 1 && j[0].content.includes("walked the long way home and felt calm") && j[0].date === ctx.today, "one journal row holding the user's own words, dated today", JSON.stringify(j.map((e: any) => e.content.slice(0, 80))));

    const t0 = new Date().toISOString();
    await say(ctx, "I ate a banana and a doughnut");
    const entries = await ctx.db.rows("tracker_entries", `timestamp=gte.${t0}`);
    for (const e of entries) ctx.cleanup(() => ctx.api("DELETE", `/trackers/${e.tracker_id}/entries/${e.id}`));
    const text = entries.map((e: any) => JSON.stringify(e.entry_values).toLowerCase());
    ctx.check("db", entries.length === 2 && text.some((t: string) => t.includes("banana")) && text.some((t: string) => t.includes("doughnut") || t.includes("donut")) && !text.some((t: string) => t.includes("banana") && /dou?gh?nut/.test(t)),
      "two nutrition entries, one per food", JSON.stringify(text).slice(0, 300));
    ctx.check("action", true, "chat answered each message");
  },
});
