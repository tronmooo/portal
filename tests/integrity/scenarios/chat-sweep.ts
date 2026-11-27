// AI Chat, tool by tool: the commands a test names but nothing had verified in
// the database. Every message is judged by the rows it left.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const inWords = (ymd: string) => { const d = O.parseYmd(ymd); return `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`; };

async function say(ctx: Ctx, message: string, history: Array<{ role: "user" | "assistant"; content: string }> = []): Promise<string> {
  const r = await ctx.api("POST", "/chat", { message, history });
  if (!r.ok) throw new Error(`chat "${message.slice(0, 60)}": ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const reply = String(r.data?.reply ?? "");
  ctx.step(`chat reply: ${reply.replace(/\s+/g, " ").slice(0, 220)}`);
  return reply;
}
/** Everything made since the scenario began, whatever the model called it. */
function sweepAfter(ctx: Ctx): void {
  const since = new Date(Date.now() - 2000).toISOString();
  for (const [table, path] of [["expenses", "/expenses"], ["incomes", "/incomes"], ["tasks", "/tasks"], ["events", "/events"], ["journal_entries", "/journal"], ["habits", "/habits"], ["goals", "/goals"], ["artifacts", "/artifacts"], ["trackers", "/trackers"]] as const) {
    ctx.cleanup(async () => {
      const rows = await ctx.db.rows(table, `created_at=gte.${since}&deleted_at=is.null`).catch(() => ctx.db.rows(table, `created_at=gte.${since}`).catch(() => []));
      for (const r of rows) await ctx.api("DELETE", `${path}/${r.id}`);
    });
  }
  ctx.cleanup(async () => {
    const rows = await ctx.db.rows("profiles", `created_at=gte.${since}&deleted_at=is.null&type=neq.self`);
    for (const r of rows) await ctx.api("DELETE", `/profiles/${r.id}?deleteHistory=1`);
  });
}
const live = (ctx: Ctx, table: string, col: string, like: string) => ctx.db.rows(table, `${col}=ilike.*${encodeURIComponent(like)}*&deleted_at=is.null`);
const word = (ctx: Ctx, base: string) => `${base}${ctx.tag.slice(-4)}`;

scenario({
  id: "chat.habits-goals-trackers",
  title: "Chat: habits, goals and trackers — created, used, changed and removed as rows",
  area: "AI Chat",
  chat: true,
  covers: ["habit.create.chat", "habit.complete.chat", "habit.cancel.chat", "habit.edit.chat", "habit.delete.chat", "habit.restore.chat", "goal.create.chat", "goal.edit.chat", "goal.delete.chat", "tracker.create.chat", "trackerEntry.create.chat", "trackerEntry.edit.chat", "trackerEntry.delete.chat", "tracker.delete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const h = word(ctx, "Stretchy");
    await say(ctx, `Create a daily habit called "${h}"`);
    let habits = await live(ctx, "habits", "name", h);
    ctx.check("db", habits.length === 1 && habits[0].frequency === "daily", "one daily habit row", JSON.stringify(habits.map((x: any) => [x.name, x.frequency])));
    const hid = habits[0]?.id;
    if (hid) {
      await say(ctx, `I did my "${h}" habit today`);
      const n = () => ctx.db.count("habit_checkins", `habit_id=eq.${hid}`);
      ctx.check("db", (await n()) === 1, "one check-in row for today", `${await n()}`);
      ctx.same("derived", listOf(must(await ctx.api("GET", "/habits"), "habits")).find((x: any) => x.id === hid)?.currentStreak, 1, "the streak reads 1");
      await say(ctx, `Actually I did not do "${h}" today — undo that check-in`);
      ctx.check("db", (await n()) === 0, "the check-in row is gone", `${await n()}`);
      await say(ctx, `Rename the habit "${h}" to "${h} Morning"`);
      habits = await ctx.db.rows("habits", `id=eq.${hid}`);
      ctx.check("db", habits[0]?.name === `${h} Morning` && habits[0]?.frequency === "daily", "the same row has the new name", JSON.stringify(habits[0]?.name));
      await say(ctx, `Delete the habit "${h} Morning"`);
      const delRow = await ctx.db.row("habits", hid);
      ctx.check("db", delRow === null || delRow.deleted_at != null, "the habit row is deleted");
      await say(ctx, `Restore the habit "${h} Morning" that I just deleted`);
      const back = await ctx.db.row("habits", hid);
      ctx.check("db", !!back && back.deleted_at == null, "the same habit row is live again", JSON.stringify(back?.deleted_at));
    }

    const g = word(ctx, "Bikefund");
    await say(ctx, `Create a savings goal called "${g}" with a target of $800`);
    let goals = await live(ctx, "goals", "title", g);
    ctx.check("db", goals.length === 1 && Number(goals[0].target) === 800, "one goal row with target 800", JSON.stringify(goals.map((x: any) => [x.title, x.target])));
    if (goals[0]) {
      await say(ctx, `Change the target of my "${g}" goal to $950`);
      const row = await ctx.db.row("goals", goals[0].id);
      ctx.check("db", Number(row.target) === 950 && row.title === goals[0].title, "the same goal row has target 950", JSON.stringify(row.target));
      await say(ctx, `Delete the goal "${g}"`);
      const gone = await ctx.db.row("goals", goals[0].id);
      ctx.check("db", gone === null || gone.deleted_at != null, "the goal row is deleted");
    }

    const t = word(ctx, "Pullups");
    await say(ctx, `Create a tracker called "${t}" that records a number of reps`);
    const trackers = await ctx.db.rows("trackers", `name=ilike.*${t}*`);
    ctx.check("db", trackers.length === 1, "one tracker row", JSON.stringify(trackers.map((x: any) => x.name)));
    const tid = trackers[0]?.id;
    if (tid) {
      await say(ctx, `Log 12 reps to my "${t}" tracker`);
      let entries = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tid}`);
      ctx.check("db", entries.length === 1 && Object.values(entries[0].entry_values || {}).includes(12), "one entry holding 12", JSON.stringify(entries.map((e: any) => e.entry_values)));
      await say(ctx, `That "${t}" entry should be 15 reps, not 12 — fix it`);
      entries = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tid}`);
      ctx.check("db", entries.length === 1 && Object.values(entries[0].entry_values || {}).includes(15) && !Object.values(entries[0].entry_values || {}).includes(12), "the same entry now holds 15 (no second entry)", JSON.stringify(entries.map((e: any) => e.entry_values)));
      await say(ctx, `Delete the last entry in my "${t}" tracker`);
      ctx.check("db", (await ctx.db.count("tracker_entries", `tracker_id=eq.${tid}`)) === 0, "the entry row is gone");
      await say(ctx, `Delete the "${t}" tracker`);
      const tr = await ctx.db.row("trackers", tid);
      ctx.check("db", tr === null || tr.deleted_at != null, "the tracker row is deleted");
      ctx.check("action", !listOf(must(await ctx.api("GET", "/trackers"), "trackers")).some((x: any) => x.id === tid), "and it left the tracker list");
    }
  },
});

scenario({
  id: "chat.money-records",
  title: "Chat: income, budgets, accounts, bills and debts — the rows, and the totals that follow",
  area: "AI Chat",
  chat: true,
  covers: ["income.create.chat", "income.edit.chat", "income.delete.chat", "budget.create.chat", "budget.edit.chat", "budget.delete.chat", "account.create.chat", "account.edit.chat", "bill.create.chat", "bill.edit.chat", "bill.complete.chat", "bill.delete.chat", "liability.edit.chat", "liabilityPayment.cancel.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const snap = async () => must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
    const s0 = await snap();

    const inc = word(ctx, "Sidegig");
    await say(ctx, `Log income: I received $640 today from "${inc}"`);
    let incomes = await live(ctx, "incomes", "description", inc);
    ctx.check("db", incomes.length === 1 && Number(incomes[0].amount) === 640, "one income row of 640", JSON.stringify(incomes.map((x: any) => [x.description, x.amount])));
    if (incomes[0]) {
      await say(ctx, `The "${inc}" income was actually $660 — update it`);
      const row = await ctx.db.row("incomes", incomes[0].id);
      ctx.check("db", Number(row.amount) === 660, "the same income row reads 660", JSON.stringify(row.amount));
      await say(ctx, `Delete the "${inc}" income`);
      const gone = await ctx.db.row("incomes", incomes[0].id);
      ctx.check("db", gone === null || gone.deleted_at != null, "the income row is deleted");
    }

    const month = ctx.today.slice(0, 7);
    const budgetOf = async (category: string) => listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets")).find((b: any) => String(b.category).toLowerCase() === category);
    if (await budgetOf("education")) throw new Error("an education budget already exists this month (left by another run)");
    await say(ctx, "Set a budget of $90 for education this month");
    let bud = await budgetOf("education");
    ctx.cleanup(async () => { const b = await budgetOf("education"); if (b) await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`); });
    ctx.check("db", !!bud && Number(bud.amount) === 90 && String((await ctx.db.rows("preferences", `key=eq.budget:${month}`))[0]?.value).includes("education"), "an education budget of 90 is stored for this month", JSON.stringify(bud));
    await say(ctx, "Raise my education budget this month to $120");
    bud = await budgetOf("education");
    ctx.check("db", !!bud && Number(bud.amount) === 120, "the education budget reads 120", JSON.stringify(bud?.amount));
    const others = listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets")).filter((b: any) => String(b.category).toLowerCase() !== "education").map((b: any) => b.id).sort();
    await say(ctx, "Delete my education budget for this month");
    ctx.check("db", !(await budgetOf("education")), "the education budget is gone");
    ctx.same("db", listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets")).map((b: any) => b.id).sort(), others, "and no other budget was touched");

    const acct = word(ctx, "Rainyday");
    await say(ctx, `Create a savings account called "${acct}" with a balance of $2,500`);
    const accts = await ctx.db.rows("profiles", `name=ilike.*${acct}*&deleted_at=is.null`);
    ctx.check("db", accts.length === 1 && accts[0].type === "account", "one account row", JSON.stringify(accts.map((x: any) => [x.type, x.name])));
    const s1 = await snap();
    ctx.near("derived", O.cents(s1.totalAssetValue - s0.totalAssetValue), 2500, "total assets rose by the account's balance");
    await say(ctx, `Update the balance of my "${acct}" account to $2,750`);
    const s2 = await snap();
    ctx.near("derived", O.cents(s2.totalAssetValue - s0.totalAssetValue), 2750, "total assets follow the new balance");
    ctx.check("db", (await ctx.db.count("profiles", `name=ilike.*${acct}*&deleted_at=is.null`)) === 1, "still one account row");

    const bill = word(ctx, "Gymclub");
    const due = O.addDays(ctx.today, 5);
    await say(ctx, `Add a monthly bill called "${bill}" for $45, next due ${inWords(due)}`);
    let bills = await ctx.db.rows("profiles", `name=ilike.*${bill}*&deleted_at=is.null`);
    ctx.check("db", bills.length === 1 && bills[0].type === "liability" && Number(bills[0].fields.amount) === 45, "one bill row of 45", JSON.stringify(bills.map((x: any) => [x.type, x.name, x.fields?.amount, x.fields?.dueDate])));
    const bid = bills[0]?.id;
    if (bid) {
      ctx.check("derived", listOf(must(await ctx.api("GET", `/calendar/timeline?start=${ctx.today}&end=${O.addDays(ctx.today, 20)}`), "timeline")).some((i: any) => i.sourceId === bid && i.date === due), `the calendar shows it on ${due}`);
      ctx.near("derived", O.cents((await snap()).totalLiabilities - s0.totalLiabilities), 0, "a recurring bill is not counted as debt");
      await say(ctx, `The "${bill}" bill went up to $49 a month`);
      ctx.near("db", Number((await ctx.db.row("profiles", bid)).fields.amount), 49, "the bill row's amount");
      const spend0 = (await snap()).totalMonthlySpend;
      await say(ctx, `I paid my "${bill}" bill`);
      const pays = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${bid}`);
      ctx.check("db", pays.length === 1 && Number(pays[0].amount) === 49, "one payment row of 49", JSON.stringify(pays.map((p: any) => p.amount)));
      await say(ctx, `Undo the "${bill}" payment I just recorded`);
      ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${bid}`)) === 0, "the payment row is gone");
      ctx.near("derived", (await snap()).totalMonthlySpend, spend0, "this month's spending is back where it was before the payment");
      // Deleting a bill is destructive: the chat asks first, and deletes on the answer.
      const ask = `Delete the "${bill}" bill`;
      const asked = await say(ctx, ask);
      const still = await ctx.db.row("profiles", bid);
      if (still && still.deleted_at == null) {
        ctx.check("action", /\?/.test(asked), "asked to delete a bill, the chat asks for confirmation before deleting", asked.slice(0, 160));
        await say(ctx, "Yes, delete it.", [{ role: "user", content: ask }, { role: "assistant", content: asked }]);
      }
      const gone = await ctx.db.row("profiles", bid);
      ctx.check("db", gone === null || gone.deleted_at != null, "after the confirmation the bill row is deleted");
    }

    const loan = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "auto_loan", name: `${word(ctx, "Truckloan")}`, fields: { balance: 14000, monthlyPayment: 320, dueDay: 9, interestRate: 7.5, _interestRateUnit: "percent" } }), "loan");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${loan.id}?deleteHistory=1`));
    // (a write from another client is visible to the next request within ~2 s: known.ts)
    await new Promise((r) => setTimeout(r, 2500));
    await say(ctx, `I refinanced my "${loan.name}": the rate is now 5.9% and the payment is $295 a month`);
    const f = (await ctx.db.row("profiles", loan.id)).fields;
    ctx.check("db", f.interestRate === 5.9 && f._interestRateUnit === "percent" && f.monthlyPayment === 295 && f.balance === 14000, "the debt row holds 5.9 percent and 295 under the canonical keys; the balance is untouched", JSON.stringify(f).slice(0, 240));
    ctx.check("db", (await ctx.db.count("profiles", `name=ilike.*${word(ctx, "Truckloan")}*&deleted_at=is.null`)) === 1, "still one record for the debt");
    ctx.check("action", true, "chat answered each message");
  },
});

scenario({
  id: "chat.notes-artifacts-tasks",
  title: "Chat: notes, journal edits, checklists and task changes — the right row each time",
  area: "AI Chat",
  chat: true,
  covers: ["note.create.chat", "note.edit.chat", "note.delete.chat", "journal.edit.chat", "journal.delete.chat", "artifact.create.chat", "artifact.complete.chat", "artifact.delete.chat", "task.edit.chat", "task.delete.chat", "task.restore.chat", "event.edit.chat", "memory.create.chat", "memory.delete.chat"],
  requires: ["action", "db"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const n = word(ctx, "Paintnote");
    await say(ctx, `Create a note titled "${n}" that says: hallway is Swiss Coffee, door is Hale Navy`);
    let notes = await ctx.db.rows("artifacts", `title=ilike.*${n}*&deleted_at=is.null`).catch(() => ctx.db.rows("artifacts", `title=ilike.*${n}*`));
    ctx.check("db", notes.length === 1 && notes[0].type === "note" && /Hale Navy/i.test(notes[0].content), "one note row holding the text", JSON.stringify(notes.map((x: any) => [x.type, x.title])));
    if (notes[0]) {
      await say(ctx, `Add to my "${n}" note: trim is Chantilly Lace`);
      const row = await ctx.db.row("artifacts", notes[0].id);
      ctx.check("db", /Chantilly Lace/i.test(row.content) && /Hale Navy/i.test(row.content), "the same note row gained the line and kept what it had", JSON.stringify(row.content).slice(0, 160));
      ctx.check("db", (await ctx.db.count("artifacts", `title=ilike.*${n}*`)) === 1, "no second note");
      await say(ctx, `Delete the note "${n}"`);
      const gone = await ctx.db.row("artifacts", notes[0].id);
      ctx.check("db", gone === null || gone.deleted_at != null, "the note row is deleted");
    }

    const j = word(ctx, "Riverwalk");
    await say(ctx, `Save this as today's journal entry: ${j} — walked by the river and felt calm.`);
    let entries = await ctx.db.rows("journal_entries", `content=ilike.*${j}*`);
    ctx.check("db", entries.length === 1, "one journal row", `${entries.length}`);
    if (entries[0]) {
      await say(ctx, `Delete today's journal entry about ${j}`);
      const gone = await ctx.db.row("journal_entries", entries[0].id);
      ctx.check("db", gone === null || gone.deleted_at != null, "the journal row is deleted");
    }

    const c = word(ctx, "Packlist");
    await say(ctx, `Make a checklist called "${c}" with the items: passport, charger, sunscreen`);
    const lists = await ctx.db.rows("artifacts", `title=ilike.*${c}*`);
    const items = lists[0]?.items ?? [];
    ctx.check("db", lists.length === 1 && items.length === 3 && items.every((i: any) => !i.checked), "one checklist row with three unticked items", JSON.stringify(items.map((i: any) => [i.text, i.checked])));
    if (lists[0]) {
      await say(ctx, `Check off "charger" on my "${c}" checklist`);
      const row = await ctx.db.row("artifacts", lists[0].id);
      const ticked = (row.items || []).filter((i: any) => i.checked).map((i: any) => String(i.text).toLowerCase());
      ctx.check("db", ticked.length === 1 && ticked[0].includes("charger"), "exactly the charger is ticked in the stored row", JSON.stringify(ticked));
      await say(ctx, `Delete the "${c}" checklist`);
      const gone = await ctx.db.row("artifacts", lists[0].id);
      ctx.check("db", gone === null || gone.deleted_at != null, "the checklist row is deleted");
    }

    const t = word(ctx, "Gutters");
    const due = O.addDays(ctx.today, 8), due2 = O.addDays(ctx.today, 10);
    const task = must(await ctx.api("POST", "/tasks", { title: `${t} clean`, dueDate: due, priority: "low" }), "task");
    await say(ctx, `Move my "${t} clean" task to ${inWords(due2)} and make it high priority`);
    let row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row.due_date === due2 && row.priority === "high" && row.title === `${t} clean`, "the task row moved and is high priority; its title is untouched", JSON.stringify({ d: row.due_date, p: row.priority }));
    await say(ctx, `Delete the task "${t} clean"`);
    row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row === null || row.deleted_at != null, "the task row is deleted");
    await say(ctx, `Restore the task "${t} clean" that I just deleted`);
    row = await ctx.db.row("tasks", task.id);
    ctx.check("db", !!row && row.deleted_at == null && row.due_date === due2, "the same task row is live again, date intact", JSON.stringify({ del: row?.deleted_at, d: row?.due_date }));

    const e = word(ctx, "Recital");
    const ev = must(await ctx.api("POST", "/events", { title: `${e} night`, date: due, time: "18:00" }), "event");
    await say(ctx, `Change the "${e} night" event to start at 7:30pm and set the location to City Hall`);
    const er = await ctx.db.row("events", ev.id);
    ctx.check("db", String(er.time).startsWith("19:30") && /city hall/i.test(String(er.location)) && er.date === due, "the event row has the new time and place, on the same day", JSON.stringify({ t: er.time, l: er.location, d: er.date }));

    const m = word(ctx, "Gatecode");
    await say(ctx, `Remember that my ${m} is 4471`);
    const mems = await ctx.db.rows("memories", `or=(key.ilike.*${m}*,value.ilike.*4471*)`).catch(() => []);
    ctx.check("db", mems.some((x: any) => JSON.stringify(x).includes("4471")), "a memory row holds it", JSON.stringify(mems).slice(0, 200));
    await say(ctx, `Forget my ${m}`);
    const left = await ctx.db.rows("memories", `or=(key.ilike.*${m}*,value.ilike.*4471*)`).catch(() => []);
    ctx.check("db", !left.some((x: any) => JSON.stringify(x).includes("4471") && x.deleted_at == null), "the memory row is gone", JSON.stringify(left).slice(0, 200));
    ctx.cleanup(async () => { for (const x of await ctx.db.rows("memories", `value=ilike.*4471*`).catch(() => [])) await ctx.api("DELETE", `/memories/${x.id}`); });
    ctx.check("action", true, "chat answered each message");
  },
});
