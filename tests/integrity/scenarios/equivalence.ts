// Manual vs AI Chat: the same intent, done once the way the screens do it and
// once in one plain sentence to the chat, must leave the same rows.
//
// WHY: every chat scenario checks chat against the database, and every API
// scenario checks the routes, but nothing held the two DOORS to each other.
// A person who adds an expense on the Finance tab and one who says it to the
// chat expect the same record: the same owner, amount, category, date, time,
// recurrence, type, balance movement and derived figures (CLAUDE.md Rule 1,
// Rule 9, Rule 13, L1–L8, A7, I14–I16, J1–J8).
//
// Each scenario does the intent TWICE under two tags — `<tag>M` through
// `ctx.api` with exactly the body the screen's mutation sends (the client file
// is named beside each body), and `<tag>C` through `POST /api/chat` — then
// compares the stored rows field by field and checks both against the oracle
// (or plain arithmetic written here). A difference a rule forbids is a
// FINDING that quotes both rows. Nothing depends on the wording of a reply.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";
import { snapshot, tagQ } from "./money";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const inWords = (ymd: string) => { const d = O.parseYmd(ymd); return `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`; };
const monthDay = (ymd: string) => { const d = O.parseYmd(ymd); return `${MONTHS[d.m - 1]} ${d.d}`; };
const json = (x: unknown, n = 420) => JSON.stringify(x)?.slice(0, n);
const settle = () => new Promise((r) => setTimeout(r, 2500));
const num = (x: unknown) => (x === null || x === undefined || x === "" ? null : Number(x));
const hhmm = (x: unknown) => (x ? String(x).slice(0, 5) : null);
const isoNow = (backMs = 500) => new Date(Date.now() - backMs).toISOString();

// ── chat ────────────────────────────────────────────────────────────────────
type Msg = { role: "user" | "assistant"; content: string };
interface Turn { said: string; reply: string; tools: string[] }

async function chat(ctx: Ctx, message: string, history: Msg[] = []): Promise<Turn> {
  const since = new Date(Date.now() - 1500).toISOString();
  const r = await ctx.api("POST", "/chat", { message, history });
  if (!r.ok) throw new Error(`chat "${message.slice(0, 60)}": ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const reply = String(r.data?.reply ?? "");
  const logged = await ctx.db.rows("ai_action_log", `created_at=gte.${since}&order=created_at.asc`).catch(() => [] as any[]);
  const acted = (Array.isArray(r.data?.actions) ? r.data.actions : []).map((a: any) => String(a?.data?._tool || (String(a?.type || "").includes("_") ? a.type : ""))).filter(Boolean);
  const tools = [...new Set([...acted, ...logged.map((x: any) => String(x.tool))])];
  ctx.step(`chat: "${message}"`);
  ctx.step(`chat reply: ${reply.replace(/\s+/g, " ").slice(0, 260)}`);
  ctx.step(`tools in the action ledger: ${tools.join(", ") || "(none)"}`);
  console.log(`    · "${message.slice(0, 90)}" → [${tools.join(", ")}] ${reply.replace(/\s+/g, " ").slice(0, 140)}`);
  return { said: message, reply, tools };
}
// The same test as chat-tools.ts: a reply that closes by asking to proceed.
const ASKS_TO_PROCEED = /(shall i|should i|do you want me to|want me to|would you like me to|can you confirm|please confirm|are you sure|confirm)[^?]{0,200}\?\s*$|\bare you sure\b[^?]{0,200}\?|\b(please|can you) confirm\b|\bconfirm and i.ll\b|\breply\s+["“']?yes\b/i;
/** One clear sentence; when the chat asks before acting, ONE plain yes (as a
 *  person would), and the outcome is held to the same check. */
async function say(ctx: Ctx, message: string): Promise<Turn> {
  const first = await chat(ctx, message);
  if (!ASKS_TO_PROCEED.test(first.reply)) return first;
  ctx.step("chat asked before acting; answered yes");
  const second = await chat(ctx, "Yes, go ahead.", [{ role: "user", content: message }, { role: "assistant", content: first.reply }]);
  return { said: message, reply: second.reply, tools: [...first.tools, ...second.tools] };
}

/** A new record the chat questions as a near-duplicate of an existing one
 *  ("did you mean Car loan ...M?"): the person answers once that it is a
 *  separate one, and the outcome is judged as before. */
async function sayNew(ctx: Ctx, message: string, made: () => Promise<boolean>, what: string): Promise<Turn> {
  const first = await say(ctx, message);
  if (await made() || !/\?/.test(first.reply)) return first;
  ctx.step(`the chat asked instead of creating; answered that it is a separate ${what}`);
  const second = await chat(ctx, `No, it is a separate ${what}, not the existing one. Please create it as a new ${what} exactly as I described.`, [{ role: "user", content: message }, { role: "assistant", content: first.reply }]);
  return { said: message, reply: `${first.reply.slice(0, 160)} ... [answered: separate] ... ${second.reply}`, tools: [...first.tools, ...second.tools] };
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

const mk = async (ctx: Ctx, body: any) => {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}?deleteHistory=1`));
  return p;
};

/** Live rows of `table` whose `col` holds `needle`; else rows made since
 *  `since` that pass `pick` (the model may have renamed the record). */
async function findMade(ctx: Ctx, table: string, col: string, needle: string, since: string, pick: (r: any) => boolean = () => true, notIds: string[] = []): Promise<{ rows: any[]; byName: boolean }> {
  const q = (s: string) => ctx.db.rows(table, `${s}&deleted_at=is.null`).catch(() => ctx.db.rows(table, s).catch(() => [] as any[]));
  const named = (await q(`${col}=ilike.*${encodeURIComponent(needle)}*`)).filter((r: any) => !notIds.includes(r.id));
  if (named.length) return { rows: named, byName: true };
  const recent = (await q(`created_at=gte.${since}`)).filter((r: any) => !notIds.includes(r.id) && pick(r));
  if (recent.length) ctx.step(`no ${table} row carries "${needle}"; found ${recent.length} made since ${since} instead`);
  return { rows: recent, byName: false };
}

// ── comparison ──────────────────────────────────────────────────────────────
interface Field { label: string; get: (r: any) => unknown; rule: string; severity?: "bug" | "discrepancy" }

/** Field by field; every difference is a failed `db` check, and the set of
 *  them one finding quoting both rows. */
function compare(ctx: Ctx, intent: string, manual: any, viaChat: any, fields: Field[], said?: Turn): boolean {
  const diffs: string[] = [];
  let severity: "bug" | "discrepancy" = "discrepancy";
  const rules = new Set<string>();
  for (const f of fields) {
    const a = f.get(manual), b = f.get(viaChat);
    const ok = JSON.stringify(a) === JSON.stringify(b);
    ctx.check("db", ok, `${intent} — ${f.label}: the screen and the chat stored the same (${json(a, 120)})`, `manual ${json(a, 160)} · chat ${json(b, 160)}`);
    if (!ok) {
      diffs.push(`${f.label}: manual ${json(a, 160)} · chat ${json(b, 160)}`);
      if (f.severity === "bug") severity = "bug";
      rules.add(f.rule);
    }
  }
  if (diffs.length) {
    ctx.finding({
      severity,
      title: `${intent}: the screen and the chat stored different ${diffs.map((d) => d.split(":")[0]).join(", ")}`,
      detail: `${diffs.join(" | ")} · Manual row: ${json(manual, 600)} · Chat row: ${json(viaChat, 600)}${said ? ` · Said: "${said.said}" · Tools: ${said.tools.join(", ") || "(none logged)"} · Reply: "${said.reply.replace(/\s+/g, " ").slice(0, 240)}"` : ""} · Rule: ${[...rules].join(", ")}`,
    });
  }
  return diffs.length === 0;
}

/** The chat left no row for the intent: a failed check and a finding. */
function noRow(ctx: Ctx, intent: string, t: Turn, rule: string): void {
  ctx.check("db", false, `${intent}: the chat stored a row`, `no row after "${t.said}"`);
  ctx.finding({ severity: "bug", title: `${intent}: the chat stored nothing for a request the screen stores`, detail: `Said: "${t.said}" · Tools: ${t.tools.join(", ") || "(none logged)"} · Reply: "${t.reply.replace(/\s+/g, " ").slice(0, 300)}" · Rule: ${rule}` });
}

/** Whose a row is, in words that do not depend on which door made it. */
function ownerOf(ctx: Ctx, names: Record<string, string>) {
  return (row: any) => {
    const ids: string[] = Array.isArray(row?.linked_profiles) ? row.linked_profiles : [];
    const mapped = ids.map((id) => (id === ctx.self.id ? "SELF" : names[id] ?? `other:${id.slice(0, 8)}`));
    // An unlinked record is the account holder's (Rule 9: records with no owner default to them).
    return mapped.length ? [...new Set(mapped)].sort() : ["SELF"];
  };
}
const doorFree = (T: string) => (s: unknown) => String(s ?? "").replace(new RegExp(`${T}[MC]`, "g"), "<tag>").trim();

/** Income frequencies spelled the ways the code accepts, one name each (written here, not imported). */
function canonFreq(raw: unknown): string | null {
  const k = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["once", "one-time", "onetime", "single", "one-off"].includes(k)) return "once";
  if (["monthly", "month"].includes(k)) return "monthly";
  if (["weekly", "week"].includes(k)) return "weekly";
  if (["yearly", "annual", "annually", "year"].includes(k)) return "yearly";
  return k || null;
}

const timeline = async (ctx: Ctx, from: string, to: string) => listOf(must(await ctx.api("GET", `/calendar/timeline?start=${from}&end=${to}`), "timeline"));
const scoped = async (ctx: Ctx, ids: string[]) => must(await ctx.api("GET", `/dashboard-enhanced?profileIds=${ids.join(",")}`), "scoped snapshot").financeSnapshot;

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.expense",
  title: "An expense for a person, yesterday: the Finance form and the chat store the same row and move the same totals",
  area: "Manual vs chat",
  chat: true,
  covers: ["expense.create.api", "expense.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const person = await mk(ctx, { type: "person", name: `Dana ${T}`, fields: { relationship: "friend" } });
    const owner = ownerOf(ctx, { [person.id]: "PERSON" });
    const free = doorFree(T);
    const yesterday = O.addDays(ctx.today, -1);
    const amount = ctx.int(20, 90) + 0.37;
    const thisMonth = yesterday.slice(0, 7) === ctx.today.slice(0, 7);
    const want = thisMonth ? amount : 0;

    // Manual: client/src/pages/finance.tsx addExpenseMutation, a category picked and the person chosen.
    const p0 = await scoped(ctx, [person.id]);
    const s0 = await snapshot(ctx);
    const m = must(await ctx.api("POST", "/expenses", { description: `Groceries ${T}M`, amount, category: "food", categoryChosen: true, date: yesterday, tags: [], linkedProfiles: [person.id] }), "manual expense");
    const mRow = await ctx.db.row("expenses", m.id);
    ctx.check("db", !!mRow && Number(mRow.amount) === amount, "manual: the expense row holds the amount", json(mRow));
    const p1 = await scoped(ctx, [person.id]);
    const s1 = await snapshot(ctx);
    ctx.near("derived", O.cents(p1.totalMonthlySpend - p0.totalMonthlySpend), want, "manual: the person's spending this month rose by it");
    ctx.near("derived", O.cents(s1.totalMonthlySpend - s0.totalMonthlySpend), want, "manual: the household's spending this month rose by it");

    await settle();
    const since = isoNow();
    const t = await say(ctx, `Log an expense called "Groceries ${T}C": $${amount.toFixed(2)} on food, yesterday, for ${person.name}.`);
    const { rows } = await findMade(ctx, "expenses", "description", `${T}C`, since, (r) => Math.abs(Number(r.amount) - amount) < 0.005, [m.id]);
    ctx.check("action", true, "the chat answered");
    if (!rows.length) return noRow(ctx, "Expense", t, "I16");
    ctx.check("db", rows.length === 1, "the chat stored ONE expense row", `${rows.length} rows: ${json(rows.map((r: any) => [r.description, r.amount]))}`);
    const c = rows[0];
    compare(ctx, "Expense", mRow, c, [
      { label: "amount", get: (r) => num(r.amount), rule: "I16 (what chat confirms is what was stored)", severity: "bug" },
      { label: "category", get: (r) => r.category, rule: "I16" },
      { label: "date", get: (r) => String(r.date).slice(0, 10), rule: "I16 (\"yesterday\" is a calendar day in the user's zone)", severity: "bug" },
      { label: "owner (linked_profiles)", get: owner, rule: "Rule 9 / Rule 13 (forProfile → owner; never the account holder for a named person)", severity: "bug" },
      { label: "description", get: (r) => free(r.description), rule: "I16 (the name the person gave)" },
      { label: "status", get: (r) => r.status ?? null, rule: "Rule 1" },
    ], t);
    const p2 = await scoped(ctx, [person.id]);
    const s2 = await snapshot(ctx);
    ctx.near("derived", O.cents(p2.totalMonthlySpend - p1.totalMonthlySpend), want, "chat: the person's spending this month rose by it");
    ctx.near("derived", O.cents(s2.totalMonthlySpend - s1.totalMonthlySpend), want, "chat: the household's spending this month rose by it");
    ctx.check("db", (await ctx.db.count("profiles", `created_at=gte.${since}&type=neq.self`)) === 0, "the chat created no profile for the named person (Rule 13: it exists already)");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.income",
  title: "Income, one-off and monthly: the Finance form and the chat store the same rows and the same month's income",
  area: "Manual vs chat",
  chat: true,
  covers: ["income.create.api", "income.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const owner = ownerOf(ctx, {});
    const free = doorFree(T);
    const cases = [
      { kind: "one-off", desc: "Logo job", amount: ctx.int(200, 900), category: "freelance", frequency: "one_time", sentence: (n: string, a: number) => `Log a one-time freelance income of $${a} I received today, called "${n}".` },
      { kind: "monthly", desc: "Tenant rent", amount: ctx.int(600, 1800), category: "rental", frequency: "monthly", sentence: (n: string, a: number) => `Add a monthly rental income of $${a} called "${n}", starting today.` },
    ];
    for (const k of cases) {
      // Manual: client/src/pages/finance.tsx addIncomeMut (the Profile picker defaults to me).
      const s0 = await snapshot(ctx);
      const m = must(await ctx.api("POST", "/incomes", { description: `${k.desc} ${T}M`, amount: k.amount, category: k.category, frequency: k.frequency, date: ctx.today, tags: [], linkedProfiles: [ctx.self.id] }), `manual ${k.kind} income`);
      const mRow = await ctx.db.row("incomes", m.id ?? m.income?.id);
      ctx.check("db", !!mRow && Number(mRow.amount) === k.amount, `manual ${k.kind}: the income row holds the amount`, json(mRow));
      const s1 = await snapshot(ctx);
      const dM = O.cents(s1.monthlyIncome - s0.monthlyIncome);
      ctx.near("derived", dM, k.amount, `manual ${k.kind}: this month's income (received to date) rose by it`);

      await settle();
      const since = isoNow();
      const t = await say(ctx, k.sentence(`${k.desc} ${T}C`, k.amount));
      ctx.check("action", true, `the chat answered (${k.kind})`);
      const { rows } = await findMade(ctx, "incomes", "description", `${k.desc} ${T}C`, since, (r) => Number(r.amount) === k.amount, [mRow?.id]);
      if (!rows.length) { noRow(ctx, `Income (${k.kind})`, t, "I16"); continue; }
      ctx.check("db", rows.length === 1, `the chat stored ONE ${k.kind} income row`, json(rows.map((r: any) => [r.description, r.amount, r.frequency])));
      const c = rows[0];
      ctx.step(`stored frequency spelling: manual "${mRow.frequency}", chat "${c.frequency}"`);
      compare(ctx, `Income (${k.kind})`, mRow, c, [
        { label: "amount", get: (r) => num(r.amount), rule: "I16", severity: "bug" },
        { label: "frequency (canonical)", get: (r) => canonFreq(r.frequency), rule: "I16 / A7 (one-off vs recurring changes every income figure)", severity: "bug" },
        { label: "category", get: (r) => r.category, rule: "I16" },
        { label: "date", get: (r) => String(r.date ?? "").slice(0, 10), rule: "I16", severity: "bug" },
        { label: "owner (linked_profiles)", get: owner, rule: "Rule 9" },
        { label: "description", get: (r) => free(r.description), rule: "I16" },
      ], t);
      const s2 = await snapshot(ctx);
      ctx.near("derived", O.cents(s2.monthlyIncome - s1.monthlyIncome), k.amount, `chat ${k.kind}: this month's income rose by it, as it did for the screen's`);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.task",
  title: "A task with a due date and time, and a weekly task: the screens and the chat store the same rows and the same calendar dates",
  area: "Manual vs chat",
  chat: true,
  covers: ["task.create.api", "task.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const owner = ownerOf(ctx, {});
    const free = doorFree(T);
    const due = O.addDays(ctx.today, ctx.int(3, 9));
    const recurTags = (r: any) => (Array.isArray(r?.tags) ? r.tags : []).filter((x: string) => /^recur:/.test(x)).sort();

    // Manual: client/src/pages/tasks.tsx (the task dialog), a date and 3:30 PM, filed under me.
    const m = must(await ctx.api("POST", "/tasks", { title: `Call plumber ${T}M`, priority: "medium", dueDate: due, dueTime: "15:30", tags: [], linkedProfiles: [ctx.self.id] }), "manual task");
    const mRow = await ctx.db.row("tasks", m.id);
    ctx.check("db", mRow?.due_date === due && hhmm(mRow?.due_time) === "15:30", "manual: the task row holds the date and the time", json(mRow));
    await settle();
    let since = isoNow();
    let t = await say(ctx, `Add a task "Call plumber ${T}C" due ${inWords(due)} at 3:30 PM.`);
    ctx.check("action", true, "the chat answered");
    let found = await findMade(ctx, "tasks", "title", `Call plumber ${T}C`, since, () => true, [m.id]);
    if (!found.rows.length) noRow(ctx, "Timed task", t, "I16");
    else {
      ctx.check("db", found.rows.length === 1, "the chat stored ONE task row", json(found.rows.map((r: any) => [r.title, r.due_date])));
      const c = found.rows[0];
      compare(ctx, "Timed task", mRow, c, [
        { label: "due date", get: (r) => r.due_date, rule: "I16", severity: "bug" },
        { label: "due time", get: (r) => hhmm(r.due_time), rule: "I16 (a task's clock time is its due_time column)", severity: "bug" },
        { label: "status", get: (r) => r.status, rule: "I16" },
        { label: "recurrence", get: recurTags, rule: "O1–O3", severity: "bug" },
        { label: "owner (linked_profiles)", get: owner, rule: "Rule 9" },
        { label: "title", get: (r) => free(r.title), rule: "I16" },
      ], t);
      const items = await timeline(ctx, ctx.today, O.addDays(ctx.today, 14));
      const on = (id: string) => items.filter((i: any) => i.sourceId === id).map((i: any) => i.date);
      ctx.same("derived", on(m.id), [due], "manual: the calendar shows the task once, on its date");
      ctx.same("derived", on(c.id), [due], "chat: the calendar shows the task once, on its date");
    }

    // Weekly: client/src/components/dashboard/TaskHabitPopups.tsx submitComposer (kind "recurring", weekly).
    const start = O.addDays(ctx.today, ctx.int(1, 5));
    const until = O.addDays(ctx.today, 27);
    const wantDates = O.occurrencesBetween(start, "weekly", ctx.today, until);
    const w = must(await ctx.api("POST", "/tasks", { status: "todo", priority: "medium", title: `Water plants ${T}M`, tags: ["recur:weekly"], dueDate: start }), "manual weekly task");
    const wRow = await ctx.db.row("tasks", w.id);
    await settle();
    since = isoNow();
    t = await say(ctx, `Add a task "Water plants ${T}C" that repeats every week, starting ${inWords(start)}.`);
    found = await findMade(ctx, "tasks", "title", `Water plants ${T}C`, since, () => true, [m.id, w.id]);
    const weekly = found.rows.filter((r: any) => /water plants/i.test(r.title));
    if (!weekly.length) return noRow(ctx, "Weekly task", t, "O1–O3");
    ctx.check("db", weekly.length === 1, "the chat stored ONE task row for the series (not one per week)", json(weekly.map((r: any) => [r.title, r.due_date, r.tags])));
    const c = weekly[0];
    compare(ctx, "Weekly task", wRow, c, [
      { label: "first date", get: (r) => r.due_date, rule: "O2 (the series' anchor)", severity: "bug" },
      { label: "recurrence", get: recurTags, rule: "O1–O3", severity: "bug" },
      { label: "status", get: (r) => r.status, rule: "I16" },
      { label: "owner (linked_profiles)", get: owner, rule: "Rule 9" },
      { label: "title", get: (r) => free(r.title), rule: "I16" },
    ], t);
    const items = await timeline(ctx, ctx.today, until);
    const on = (id: string) => items.filter((i: any) => i.sourceId === id).map((i: any) => i.date).sort();
    ctx.same("derived", on(w.id), wantDates, "manual: the calendar shows a date every week from the start");
    ctx.same("derived", on(c.id), wantDates, "chat: the calendar shows the same weekly dates");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.event",
  title: "An event with a start and an end, and a person's yearly birthday: the Calendar forms and the chat store the same rows",
  area: "Manual vs chat",
  chat: true,
  covers: ["event.create.api", "event.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const free = doorFree(T);
    const day = O.addDays(ctx.today, ctx.int(4, 12));

    // Manual: client/src/components/CalendarView.tsx (the event form: not all-day, 6:30–8:00 PM).
    const m = must(await ctx.api("POST", "/events", { title: `Dinner ${T}M`, date: day, allDay: false, category: "personal", recurrence: "none", linkedProfiles: [], source: "manual", time: "18:30", endTime: "20:00" }), "manual event");
    const mRow = await ctx.db.row("events", m.id);
    ctx.check("db", mRow?.date === day && hhmm(mRow?.time) === "18:30" && hhmm(mRow?.end_time) === "20:00", "manual: the event row holds the day, start and end", json(mRow));
    await settle();
    let since = isoNow();
    let t = await say(ctx, `Add an event "Dinner ${T}C" on ${inWords(day)} from 6:30 PM to 8:00 PM.`);
    let found = await findMade(ctx, "events", "title", `Dinner ${T}C`, since, () => true, [m.id]);
    const owner = ownerOf(ctx, {});
    if (!found.rows.length) noRow(ctx, "Timed event", t, "I16");
    else {
      ctx.check("db", found.rows.length === 1, "the chat stored ONE event row", json(found.rows.map((r: any) => [r.title, r.date])));
      const c = found.rows[0];
      ctx.step(`categories: manual "${mRow.category}", chat "${c.category}" (not compared: the person named none)`);
      compare(ctx, "Timed event", mRow, c, [
        { label: "date", get: (r) => r.date, rule: "I16", severity: "bug" },
        { label: "start time", get: (r) => hhmm(r.time), rule: "I16", severity: "bug" },
        { label: "end time", get: (r) => hhmm(r.end_time), rule: "I16", severity: "bug" },
        { label: "end date", get: (r) => (r.end_date && r.end_date !== r.date ? r.end_date : null), rule: "I16" },
        { label: "all day", get: (r) => !!r.all_day, rule: "I16" },
        { label: "recurrence", get: (r) => (!r.recurrence || r.recurrence === "none" ? "none" : r.recurrence), rule: "I16", severity: "bug" },
        { label: "owner (linked_profiles)", get: owner, rule: "Rule 9" },
        { label: "title", get: (r) => free(r.title), rule: "I16" },
      ], t);
      const items = await timeline(ctx, ctx.today, O.addDays(ctx.today, 20));
      const at = (id: string) => items.filter((i: any) => i.sourceId === id).map((i: any) => `${i.date} ${hhmm(i.time ?? i.startTime) ?? ""}`.trim());
      ctx.same("derived", at(m.id), [`${day} 18:30`], "manual: the calendar shows it once, at 6:30 PM on its day");
      ctx.same("derived", at(c.id), [`${day} 18:30`], "chat: the calendar shows it once, at 6:30 PM on its day");
    }

    // Birthday: client/src/components/CalendarManagerPanel.tsx (Birthday, recurs yearly, linked to the person).
    const bday = O.addDays(ctx.today, ctx.int(15, 40));
    const pM = await mk(ctx, { type: "person", name: `Robin ${T}M`, fields: { relationship: "friend" } });
    const pC = await mk(ctx, { type: "person", name: `Robin ${T}C`, fields: { relationship: "friend" } });
    const powner = ownerOf(ctx, { [pM.id]: "PERSON", [pC.id]: "PERSON" });
    const b = must(await ctx.api("POST", "/events", { title: `🎂 ${pM.name}'s birthday`, date: bday, allDay: true, category: "family", recurrence: "yearly", linkedProfiles: [pM.id], source: "manual" }), "manual birthday");
    const bRow = await ctx.db.row("events", b.id);
    await settle();
    since = isoNow();
    t = await say(ctx, `${pC.name}'s birthday is on ${monthDay(bday)}.`);
    found = await findMade(ctx, "events", "title", `Robin ${T}C`, since, (r) => /birthday/i.test(r.title), [m.id, b.id]);
    const profC = await ctx.db.row("profiles", pC.id);
    const items = await timeline(ctx, ctx.today, O.addDays(ctx.today, 60));
    const onDay = items.filter((i: any) => i.date === bday && String(i.title ?? "").includes(`${T}C`));
    if (!found.rows.length) {
      const asField = JSON.stringify(profC?.fields ?? {}).includes(bday.slice(5));
      ctx.check("db", false, "the chat stored the birthday as a yearly event, as the Birthday form does", `no event; profile fields ${json(profC?.fields, 200)}`);
      ctx.finding({
        severity: asField ? "discrepancy" : "bug",
        title: asField ? "Birthday: the chat wrote the person's birthday field, the Calendar's Birthday form writes a yearly event" : "Birthday: the chat stored nothing for \"<Name>'s birthday is …\"",
        detail: `Manual row: ${json(bRow)} · Chat: no event; profile ${pC.name} fields ${json(profC?.fields, 300)} · calendar on ${bday}: ${json(onDay.map((i: any) => [i.type, i.title]))} · Said: "${t.said}" · Tools: ${t.tools.join(", ")} · Reply: "${t.reply.slice(0, 240)}" · Rule: Rule 12 / Rule 13`,
      });
    } else {
      ctx.check("db", found.rows.length === 1, "the chat stored ONE birthday event", json(found.rows.map((r: any) => [r.title, r.date, r.recurrence])));
      const c = found.rows[0];
      ctx.step(`stored dates: manual ${bRow.date}, chat ${c.date}`);
      compare(ctx, "Birthday", bRow, c, [
        { label: "month and day", get: (r) => String(r.date).slice(5, 10), rule: "I16", severity: "bug" },
        { label: "recurrence", get: (r) => r.recurrence, rule: "Rule 13 (a birthday is a yearly event)", severity: "bug" },
        { label: "all day", get: (r) => !!r.all_day, rule: "I16" },
        { label: "owner (linked_profiles)", get: powner, rule: "Rule 12 (never filed under the account holder)", severity: "bug" },
        { label: "category", get: (r) => r.category, rule: "I16" },
      ], t);
      const next = (id: string) => items.filter((i: any) => i.sourceId === id).map((i: any) => i.date);
      ctx.same("derived", next(b.id), [bday], `manual: the calendar shows the next birthday on ${bday}`);
      ctx.same("derived", next(c.id), [bday], `chat: the calendar shows the next birthday on ${bday}`);
    }
    ctx.check("db", (await ctx.db.count("profiles", `created_at=gte.${since}&type=neq.self`)) === 0, "the chat created no second profile for the person (Rule 13)");
    ctx.check("action", true, "the chat answered");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.bill",
  title: "A monthly bill and paying it: Quick add + the Money card and the chat store the same bill, payment, expense and next date",
  area: "Manual vs chat",
  chat: true,
  covers: ["bill.create.api", "bill.create.chat", "bill.complete.api", "bill.complete.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const free = doorFree(T);
    const amount = ctx.int(40, 140) + 0.5;
    const due = O.addDays(ctx.today, 5);
    const wantNext = O.nextBillDate(due, "monthly", ctx.today);
    const wantAfterPay = O.nextBillDate(due, "monthly", ctx.today, [wantNext]);
    const upcoming = async (id: string) => ((await snapshot(ctx)).billsTimeline?.upcoming || []).filter((r: any) => r.billId === id).map((r: any) => r.date).sort();
    const bills: Record<"M" | "C", any> = { M: null, C: null };
    const turns: Record<string, Turn> = {};

    // Manual: client/src/components/QuickCreateFab.tsx QuickBillDialog.
    const m = must(await ctx.api("POST", "/obligations", { name: `Internet ${T}M`, amount, frequency: "monthly", category: "utilities", nextDueDate: due, autopay: false }), "manual bill");
    const mid = m.id ?? m.obligation?.id ?? m.profile?.id;
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${mid}?deleteHistory=1`));
    bills.M = await ctx.db.row("profiles", mid);
    await settle();
    const since = isoNow();
    turns.create = await sayNew(ctx, `Add a monthly bill called "Internet ${T}C" for $${amount.toFixed(2)}, next due ${inWords(due)}.`,
      async () => (await ctx.db.count("profiles", `name=ilike.*${encodeURIComponent(`${T}C`)}*&deleted_at=is.null`)) > 0, "bill");
    const found = await findMade(ctx, "profiles", "name", `${T}C`, since, (r) => r.type === "liability", [mid]);
    ctx.check("action", true, "the chat answered");
    if (!found.rows.length) return noRow(ctx, "Bill", turns.create, "I16");
    ctx.check("db", found.rows.length === 1, "the chat stored ONE bill record", json(found.rows.map((r: any) => [r.type, r.type_key, r.name])));
    bills.C = found.rows[0];
    const cid = bills.C.id;
    compare(ctx, "Bill", bills.M, bills.C, [
      { label: "type", get: (r) => r.type, rule: "L1 / A7", severity: "bug" },
      { label: "amount", get: (r) => num(r.fields?.amount), rule: "I16", severity: "bug" },
      { label: "frequency", get: (r) => canonFreq(r.fields?.frequency), rule: "A7", severity: "bug" },
      { label: "autopay", get: (r) => !!r.fields?.autopay, rule: "A1 (nothing on its own)", severity: "bug" },
      { label: "name", get: (r) => free(r.name), rule: "I16" },
    ], turns.create);
    ctx.step(`type_key: manual ${bills.M?.type_key}, chat ${bills.C?.type_key}; category: manual ${bills.M?.fields?.category}, chat ${bills.C?.fields?.category}`);
    ctx.same("derived", (await upcoming(mid))[0], wantNext, "manual: the bills timeline names the next date");
    ctx.same("derived", (await upcoming(cid))[0], wantNext, "chat: the bills timeline names the same next date");

    // Pay — manual: client/src/components/dashboard/ExecutiveBriefing.tsx (Money card → POST /obligations/:id/pay {}).
    const s0 = await snapshot(ctx);
    must(await ctx.api("POST", `/obligations/${mid}/pay`, {}), "manual pay");
    const s1 = await snapshot(ctx);
    await settle();
    turns.pay = await say(ctx, `I paid my "Internet ${T}C" bill.`);
    const s2 = await snapshot(ctx);
    const payOf = async (id: string) => {
      const pays = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${id}`);
      const exps = pays.length ? await ctx.db.rows("expenses", tagQ(`payment:${pays[0].id}`)) : [];
      return { pays, exps, row: { payments: pays.length, amount: num(pays[0]?.amount), paymentDate: String(pays[0]?.payment_date ?? "").slice(0, 10), expenses: exps.length, expenseAmount: num(exps[0]?.amount), expenseDate: String(exps[0]?.date ?? "").slice(0, 10), expenseCategory: exps[0]?.category ?? null } };
    };
    const pm = await payOf(mid), pc = await payOf(cid);
    ctx.check("db", pm.row.payments === 1 && pm.row.amount === amount && pm.row.expenses === 1, "manual: one payment row and one expense of the bill's amount", json(pm.row));
    if (pc.row.payments === 0) noRow(ctx, "Bill payment", turns.pay, "A7 / I16");
    else compare(ctx, "Bill payment", pm.row, pc.row, [
      { label: "payment rows", get: (r) => r.payments, rule: "A1 (once)", severity: "bug" },
      { label: "payment amount", get: (r) => r.amount, rule: "I16", severity: "bug" },
      { label: "payment date", get: (r) => r.paymentDate, rule: "A7", severity: "bug" },
      { label: "expense rows", get: (r) => r.expenses, rule: "A4 (a bill's whole payment is one expense)", severity: "bug" },
      { label: "expense amount", get: (r) => r.expenseAmount, rule: "A4", severity: "bug" },
      { label: "expense date", get: (r) => r.expenseDate, rule: "A4" },
      { label: "expense category", get: (r) => r.expenseCategory, rule: "Rule 1" },
    ], turns.pay);
    const spendWant = pm.row.paymentDate.startsWith(ctx.today.slice(0, 7)) ? amount : 0;
    ctx.near("derived", O.cents(s1.totalMonthlySpend - s0.totalMonthlySpend), spendWant, "manual: this month's spending rose by the bill");
    ctx.near("derived", O.cents(s2.totalMonthlySpend - s1.totalMonthlySpend), spendWant, "chat: this month's spending rose by the same");
    const items = await timeline(ctx, ctx.today, O.addDays(ctx.today, 70));
    const firstOpen = (id: string) => items.filter((i: any) => i.sourceId === id && !i.completed && !["paid", "skipped"].includes(String(i.meta?.status))).map((i: any) => i.date).sort()[0];
    const nm = firstOpen(mid), nc = firstOpen(cid);
    ctx.same("derived", nm, wantAfterPay, "manual: after paying, the calendar's first open date is a month on (A7)");
    ctx.same("derived", nc, wantAfterPay, "chat: after paying, the calendar's first open date is a month on (A7)");
    if (nm !== nc) ctx.finding({ severity: "bug", title: "Bill paid: the screen and the chat leave different next due dates", detail: `manual next ${nm}, chat next ${nc}, oracle ${wantAfterPay} · Rule A7` });
    ctx.check("db", (await ctx.db.count("tasks", `created_at=gte.${since}&deleted_at=is.null`)) === 0, "no task was made for the bill (A7)");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.loan",
  title: "A loan, a payment and a corrected payment: the screens and the chat store the same debt, split and balance",
  area: "Manual vs chat",
  chat: true,
  covers: ["liability.create.api", "liability.create.chat", "liabilityPayment.create.api", "liabilityPayment.create.chat", "liabilityPayment.edit.api", "liabilityPayment.edit.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const free = doorFree(T);
    const B = ctx.int(80, 160) * 100;
    const R = ctx.pick([4.9, 6.25, 7.5, 9.9]);
    const P = ctx.int(3, 5) * 100;
    const turns: Record<string, Turn> = {};
    const bal = async (id: string) => num((await ctx.db.row("profiles", id))?.fields?.balance);
    const ledger = (id: string) => ctx.db.rows("liability_payments", `liability_profile_id=eq.${id}&order=created_at.asc`);

    // Manual: client/src/components/CreateProfileDialog.tsx with the Auto Loan type (its registry field keys).
    const s0 = await snapshot(ctx);
    const m = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "auto_loan", name: `Car loan ${T}M`, fields: { current_balance: B, interest_rate: R, monthly_payment: P, _interestRateUnit: "percent" }, tags: [], notes: "" }), "manual loan");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${m.id}?deleteHistory=1`));
    const mRow = await ctx.db.row("profiles", m.id);
    const s1 = await snapshot(ctx);
    ctx.near("derived", O.cents(s1.totalLiabilities - s0.totalLiabilities), B, "manual: total debt rose by the balance");
    await settle();
    const since = isoNow();
    turns.create = await sayNew(ctx, `Add my auto loan "Car loan ${T}C": the balance is $${B.toLocaleString("en-US")}, the interest rate is ${R}%, and the payment is $${P} a month.`,
      async () => (await ctx.db.count("profiles", `name=ilike.*${encodeURIComponent(`${T}C`)}*&deleted_at=is.null`)) > 0, "loan");
    const found = await findMade(ctx, "profiles", "name", `${T}C`, since, (r) => r.type === "liability" || r.type === "loan", [m.id]);
    ctx.check("action", true, "the chat answered");
    if (!found.rows.length) return noRow(ctx, "Loan", turns.create, "L1 / L2");
    ctx.check("db", found.rows.length === 1, "the chat stored ONE record for the loan (no separate payment bill, L1)", json(found.rows.map((r: any) => [r.type, r.type_key, r.name])));
    const c = found.rows.find((r: any) => !/payment/i.test(r.name)) ?? found.rows[0];
    const s2 = await snapshot(ctx);
    ctx.near("derived", O.cents(s2.totalLiabilities - s1.totalLiabilities), B, "chat: total debt rose by the same balance");
    compare(ctx, "Loan", mRow, c, [
      { label: "type", get: (r) => r.type, rule: "L4", severity: "bug" },
      { label: "type_key", get: (r) => r.type_key, rule: "L4 (the type comes from type_key)", severity: "bug" },
      { label: "balance (canonical key)", get: (r) => num(r.fields?.balance), rule: "L2 (written under the canonical key)", severity: "bug" },
      { label: "interest rate (canonical key)", get: (r) => num(r.fields?.interestRate), rule: "L2 / L3", severity: "bug" },
      { label: "rate unit marker", get: (r) => r.fields?._interestRateUnit ?? null, rule: "L3 (a rate is a percent, and the record says so)", severity: "bug" },
      { label: "monthly payment (canonical key)", get: (r) => num(r.fields?.monthlyPayment), rule: "L2", severity: "bug" },
      { label: "name", get: (r) => free(r.name), rule: "I16" },
    ], turns.create);

    // Pay — manual: client/src/pages/liability-detail.tsx recordPaymentMutation (one key per payment).
    const want = O.splitPayment(B, R, P);
    must(await ctx.api("POST", `/liabilities/${m.id}/payments`, { paymentDate: ctx.today, amount: P, notes: null, idempotencyKey: `${T}M-pay-1` }), "manual payment");
    await settle();
    turns.pay = await say(ctx, `I made a $${P} payment on my "Car loan ${T}C" today.`);
    const row = async (id: string) => {
      const l = await ledger(id);
      return { rows: l.length, amount: num(l[0]?.amount), interest: num(l[0]?.interest_portion), principal: num(l[0]?.principal_portion), date: String(l[0]?.payment_date ?? "").slice(0, 10), balance: await bal(id) };
    };
    const pm = await row(m.id), pc = await row(c.id);
    ctx.near("derived", pm.interest, want.interest, `manual: the payment carries the month's interest (${B} at ${R}%)`);
    ctx.near("derived", pm.balance, want.newBalance, "manual: the balance fell by the principal");
    if (pc.rows === 0) noRow(ctx, "Loan payment", turns.pay, "L5");
    else {
      compare(ctx, "Loan payment", pm, pc, [
        { label: "ledger rows", get: (r) => r.rows, rule: "L5", severity: "bug" },
        { label: "amount", get: (r) => r.amount, rule: "L5 / I16", severity: "bug" },
        { label: "interest", get: (r) => r.interest, rule: "L5 (the server owns the split)", severity: "bug" },
        { label: "principal", get: (r) => r.principal, rule: "L5", severity: "bug" },
        { label: "date", get: (r) => r.date, rule: "L5", severity: "bug" },
        { label: "balance after", get: (r) => r.balance, rule: "L5 / Rule 1", severity: "bug" },
      ], turns.pay);
      ctx.near("derived", pc.interest, want.interest, "chat: the payment carries the same interest");
      ctx.near("derived", pc.balance, want.newBalance, "chat: the balance fell by the same principal");
    }

    // Correct the amount, up then down — manual: PATCH /liability-payments/:id {amount} (the ledger re-records it).
    for (const [delta, words] of [[50, "raise"], [-20, "lower"]] as const) {
      const before = { m: await bal(m.id), c: await bal(c.id) };
      const pmRow = (await ledger(m.id))[0];
      const newAmt = Number(pmRow?.amount) + delta;
      const r = await ctx.api("PATCH", `/liability-payments/${pmRow?.id}`, { amount: newAmt });
      ctx.check("action", r.ok, `manual: the payment's amount is changed to ${newAmt}`, `${r.status} ${json(r.data, 200)}`);
      const pcRow = (await ledger(c.id))[0];
      const wantAfter = O.splitPayment(B, R, newAmt);
      if (!pcRow) { ctx.check("db", false, `chat: a payment to ${words}`, "the chat's loan has no payment"); continue; }
      await settle();
      turns[words] = await say(ctx, `Correct today's payment on my "Car loan ${T}C": it was $${newAmt}, not $${Number(pcRow.amount)}.`);
      const am = await row(m.id), ac = await row(c.id);
      ctx.near("derived", O.cents((am.balance ?? NaN) - (before.m ?? NaN)), -delta, `manual (${words}): the balance moved by exactly the difference`);
      ctx.near("derived", am.balance, wantAfter.newBalance, `manual (${words}): the balance is the opening balance less the corrected principal`);
      const okC = ctx.near("derived", O.cents((ac.balance ?? NaN) - (before.c ?? NaN)), -delta, `chat (${words}): the balance moved by exactly the difference`);
      ctx.near("derived", ac.balance, wantAfter.newBalance, `chat (${words}): the balance is the opening balance less the corrected principal`);
      compare(ctx, `Corrected loan payment (${words})`, am, ac, [
        { label: "ledger rows", get: (x) => x.rows, rule: "L5 (a correction is not a second payment)", severity: "bug" },
        { label: "amount", get: (x) => x.amount, rule: "I16", severity: "bug" },
        { label: "interest", get: (x) => x.interest, rule: "L5", severity: "bug" },
        { label: "principal", get: (x) => x.principal, rule: "L5", severity: "bug" },
        { label: "balance after", get: (x) => x.balance, rule: "L5 / Rule 1", severity: "bug" },
      ], turns[words]);
      if (!okC) ctx.finding({ severity: "bug", title: `Loan payment corrected by chat (${words}): the balance did not move by the difference`, detail: `before ${before.c}, after ${ac.balance}, difference ${delta}; the screen's moved ${O.cents((am.balance ?? 0) - (before.m ?? 0))} · Rule L5` });
    }
    const s3 = await snapshot(ctx);
    const final = O.splitPayment(B, R, P + 30);
    ctx.near("derived", O.cents(s3.totalLiabilities - s0.totalLiabilities), O.cents(2 * final.newBalance), "total debt is both loans' balances after the corrected payments");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.budget",
  title: "A budget for a category this month, then raised: the Budget popup and the chat store the same line",
  area: "Manual vs chat",
  chat: true,
  covers: ["budget.create.api", "budget.create.chat", "budget.edit.api", "budget.edit.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const month = ctx.today.slice(0, 7);
    const list = async () => listOf(must(await ctx.api("GET", `/budgets?month=${month}`), "budgets"));
    const existing = new Set((await list()).map((b: any) => String(b.category).toLowerCase()));
    const category = ["travel", "entertainment", "personal", "pet", "education"].find((c) => !existing.has(c));
    if (!category) throw new Error(`every candidate category already has a budget in ${month}`);
    const first = ctx.int(10, 30) * 10, raised = first + ctx.int(3, 9) * 10;
    const lineOf = async () => (await list()).filter((b: any) => String(b.category).toLowerCase() === category);
    const total = async () => O.cents((await list()).reduce((s: number, b: any) => s + Number(b.amount), 0));
    ctx.cleanup(async () => { for (const b of await lineOf()) await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`); });
    const storedRow = async () => { const rows = await ctx.db.rows("preferences", `key=eq.${encodeURIComponent(`budget:${month}`)}`); return String(rows[0]?.value ?? ""); };

    // Manual: client/src/components/dashboard/HeroKPIPopups.tsx addMut / updateMut.
    const t0 = await total();
    must(await ctx.api("POST", "/budgets", { category, amount: first }), "manual budget");
    let lines = await lineOf();
    ctx.check("db", lines.length === 1 && Number(lines[0].amount) === first && (await storedRow()).includes(category), `manual: one ${category} line of ${first} stored for ${month}`, json(lines));
    must(await ctx.api("PATCH", `/budgets/${lines[0].id}`, { amount: raised }), "manual raise");
    const manual = (await lineOf()).map((b: any) => ({ category: String(b.category).toLowerCase(), amount: Number(b.amount), profileId: b.profileId ?? null, lines: 1 }));
    ctx.near("derived", O.cents((await total()) - t0), raised, "manual: the month's total budget rose by the raised amount");
    for (const b of await lineOf()) must(await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`), "remove the manual line");
    ctx.near("derived", await total(), t0, "with the manual line removed the total is back");

    await settle();
    const beforeIds = new Set((await list()).map((b: any) => b.id));
    const added = async () => (await list()).filter((b: any) => !beforeIds.has(b.id));
    ctx.cleanup(async () => { for (const b of await added()) await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`); });
    const t1 = await say(ctx, `Set a ${category} budget of $${first} for this month.`);
    const new1 = await added();
    ctx.check("action", true, "the chat answered");
    if (!new1.length) return noRow(ctx, "Budget", t1, "I16");
    ctx.check("db", new1.length === 1 && Number(new1[0].amount) === first, `chat: one new line of ${first}`, json(new1));
    const t2 = await say(ctx, `Raise my ${category} budget this month to $${raised}.`);
    lines = await lineOf();
    const mine = await added();
    const chatLines = lines.length ? lines : mine;
    if (!lines.length) ctx.step(`no ${category} line after the chat; the line(s) it wrote: ${json(mine)}`);
    const viaChat = chatLines.map((b: any) => ({ category: String(b.category).toLowerCase(), amount: Number(b.amount), profileId: b.profileId ?? null, lines: chatLines.length }));
    compare(ctx, "Budget", manual[0], viaChat[0], [
      { label: "lines for the category", get: (r) => r?.lines ?? 0, rule: "Rule 6 (one line, changed in place)", severity: "bug" },
      { label: "amount after raising", get: (r) => r?.amount ?? null, rule: "I16", severity: "bug" },
      { label: "category", get: (r) => r?.category ?? null, rule: "I16" },
      { label: "owner (profileId)", get: (r) => r?.profileId ?? null, rule: "Rule 9" },
    ], t2);
    ctx.near("derived", O.cents((await total()) - t0), raised, "chat: the month's total budget rose by the same raised amount");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.tracker-run",
  title: "A run with distance and time: the tracker form and the chat store the same entry and derive the same pace",
  area: "Manual vs chat",
  chat: true,
  covers: ["trackerEntry.create.api", "trackerEntry.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const miles = ctx.pick([2.5, 3.1, 4, 5.2]);
    const minutes = ctx.int(22, 48);
    const pace = O.pace(miles, minutes);
    // Both trackers made the way the Trackers page makes one (client/src/pages/trackers.tsx, a fitness tracker).
    const mkTracker = async (name: string) => {
      const tr = must(await ctx.api("POST", "/trackers", { name, category: "fitness", unit: "mi", fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }, { name: "duration", type: "number", unit: "min" }] }), `tracker ${name}`);
      ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tr.id}`));
      return tr;
    };
    const tM = await mkTracker(`Run log ${T}M`), tC = await mkTracker(`Run log ${T}C`);
    // Manual: client/src/pages/trackers.tsx log-entry form.
    must(await ctx.api("POST", `/trackers/${tM.id}/entries`, { values: { distance: miles, duration: minutes }, notes: "", allowDuplicate: true }), "manual entry");
    await settle();
    const since = isoNow();
    const t = await say(ctx, `Log a run to my "Run log ${T}C" tracker: ${miles} miles in ${minutes} minutes.`);
    const eM = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tM.id}`);
    const eC = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tC.id}`);
    ctx.check("action", true, "the chat answered");
    ctx.check("db", eM.length === 1, "manual: one entry", `${eM.length}`);
    if (!eC.length) {
      const strays = await ctx.db.rows("trackers", `created_at=gte.${since}`).catch(() => []);
      noRow(ctx, "Run entry", t, `I15 (the tracker the person named is the tracker)${strays.length ? `; new trackers: ${json(strays.map((x: any) => x.name))}` : ""}`);
      return;
    }
    const shape = (r: any) => ({ distance: num(r.entry_values?.distance), duration: num(r.entry_values?.duration), computed: r.computed ?? r.entry_values?.computed ?? null });
    const mm = { rows: eM.length, ...shape(eM[0]) }, cc = { rows: eC.length, ...shape(eC[0]) };
    const derivedText = (r: any) => { const s = JSON.stringify(r); return { paceText: s.includes(pace.text), mph: s.includes(String(pace.mph)) }; };
    compare(ctx, "Run entry", mm, cc, [
      { label: "entries", get: (r) => r.rows, rule: "I15 / 11a", severity: "bug" },
      { label: "distance (mi)", get: (r) => r.distance, rule: "I16", severity: "bug" },
      { label: "duration (min)", get: (r) => r.duration, rule: "I16", severity: "bug" },
      { label: "derived figures (pace, speed, calories)", get: (r) => r.computed, rule: "11b (the engine derives the same figures from the same entry)" },
    ], t);
    ctx.check("derived", derivedText(eM[0]).paceText || derivedText(eM[0]).mph, `manual: the entry's pace is ${pace.text}/mi (${pace.mph} mph)`, json(eM[0], 400));
    ctx.check("derived", derivedText(eC[0]).paceText || derivedText(eC[0]).mph, `chat: the entry's pace is ${pace.text}/mi (${pace.mph} mph)`, json(eC[0], 400));
    const strays = (await ctx.db.rows("trackers", `created_at=gte.${since}`).catch(() => [])).filter((x: any) => x.deleted_at == null);
    ctx.check("db", strays.length === 0, "the chat made no other tracker (I15)", json(strays.map((x: any) => x.name)));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.habit-goal",
  title: "A habit and its check-in, and a goal with a target: the screens and the chat store the same rows and streak",
  area: "Manual vs chat",
  chat: true,
  covers: ["habit.create.api", "habit.create.chat", "habit.complete.api", "habit.complete.chat", "goal.create.api", "goal.create.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const free = doorFree(T);
    const owner = ownerOf(ctx, {});
    // Manual: client/src/pages/habits.tsx createMutation, then the check-in button (POST …/checkin {date: today}).
    const hM = must(await ctx.api("POST", "/habits", { name: `Stretch ${T}M`, frequency: "daily" }), "manual habit");
    const hMid = hM.id ?? hM.habit?.id;
    must(await ctx.api("POST", `/habits/${hMid}/checkin`, { date: ctx.today }), "manual check-in");
    await settle();
    let since = isoNow();
    const t1 = await say(ctx, `Create a daily habit called "Stretch ${T}C".`);
    const found = await findMade(ctx, "habits", "name", `${T}C`, since, () => true, [hMid]);
    ctx.check("action", true, "the chat answered");
    if (!found.rows.length) noRow(ctx, "Habit", t1, "I16");
    else {
      const hC = found.rows[0];
      ctx.check("db", found.rows.length === 1, "the chat stored ONE habit", json(found.rows.map((r: any) => r.name)));
      const t2 = await say(ctx, `I did my "Stretch ${T}C" habit today.`);
      const hMrow = await ctx.db.row("habits", hMid);
      const hCrow = await ctx.db.row("habits", hC.id);
      compare(ctx, "Habit", hMrow, hCrow, [
        { label: "frequency", get: (r) => r.frequency, rule: "I16", severity: "bug" },
        { label: "target per day", get: (r) => r.target_per_day ?? null, rule: "I16" },
        { label: "status", get: (r) => r.status ?? null, rule: "I16" },
        { label: "owner (linked_profiles)", get: owner, rule: "Rule 9" },
        { label: "name", get: (r) => free(r.name), rule: "I16" },
      ], t1);
      const checks = async (id: string) => (await ctx.db.rows("habit_checkins", `habit_id=eq.${id}`)).map((x: any) => ({ date: String(x.date).slice(0, 10), value: num(x.value) }));
      const cm = await checks(hMid), cc = await checks(hC.id);
      if (!cc.length) noRow(ctx, "Habit check-in", t2, "I16");
      else compare(ctx, "Habit check-in", { rows: cm }, { rows: cc }, [
        { label: "check-in rows (date, value)", get: (r) => r.rows, rule: "I16", severity: "bug" },
      ], t2);
      const habits = listOf(must(await ctx.api("GET", "/habits"), "habits"));
      const want = O.dailyStreak([ctx.today], ctx.today);
      ctx.same("derived", habits.find((x: any) => x.id === hMid)?.currentStreak, want, "manual: the streak reads 1");
      ctx.same("derived", habits.find((x: any) => x.id === hC.id)?.currentStreak, want, "chat: the streak reads 1");
    }

    // Goal — manual: client/src/pages/dashboard.tsx goal form (type, target, unit, deadline).
    const target = ctx.int(5, 30) * 100;
    const deadline = O.addDays(ctx.today, 90);
    const gM = must(await ctx.api("POST", "/goals", { title: `Bike fund ${T}M`, type: "savings", target, unit: "USD", deadline }), "manual goal");
    const gMid = gM.id ?? gM.goal?.id;
    await settle();
    since = isoNow();
    const t3 = await say(ctx, `Create a savings goal "Bike fund ${T}C" with a target of $${target.toLocaleString("en-US")} by ${inWords(deadline)}.`);
    const g = await findMade(ctx, "goals", "title", `${T}C`, since, () => true, [gMid]);
    if (!g.rows.length) return noRow(ctx, "Goal", t3, "I16");
    ctx.check("db", g.rows.length === 1, "the chat stored ONE goal", json(g.rows.map((r: any) => [r.title, r.target])));
    const gMrow = await ctx.db.row("goals", gMid);
    const unit = (u: unknown) => (/^(usd|\$|dollars?)$/i.test(String(u ?? "").trim()) ? "USD" : String(u ?? ""));
    compare(ctx, "Goal", gMrow, g.rows[0], [
      { label: "target", get: (r) => num(r.target), rule: "I16 (I16: what chat confirms is what was stored)", severity: "bug" },
      { label: "type", get: (r) => r.type, rule: "I16" },
      { label: "unit (dollars)", get: (r) => unit(r.unit), rule: "I16" },
      { label: "deadline", get: (r) => (r.deadline ? String(r.deadline).slice(0, 10) : null), rule: "I16", severity: "bug" },
      { label: "progress so far", get: (r) => num(r.current) ?? 0, rule: "I16" },
      { label: "status", get: (r) => r.status ?? null, rule: "I16" },
      { label: "title", get: (r) => free(r.title), rule: "I16" },
    ], t3);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.asset-ownership",
  title: "An asset with a purchase price and value, shared 60/40 with a person: the screens and the chat store the same record, shares and totals",
  area: "Manual vs chat",
  chat: true,
  covers: ["asset.create.api", "asset.create.chat", "asset.transfer.api", "asset.transfer.chat"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const free = doorFree(T);
    const partner = await mk(ctx, { type: "person", name: `Alex ${T}`, fields: { relationship: "partner" } });
    const price = ctx.int(18, 30) * 1000, value = price - ctx.int(3, 8) * 1000;
    const bought = O.addDays(ctx.today, -ctx.int(400, 900));
    const valueOf = (snap: any, id: string) => Number((snap.assetBreakdown || []).find((r: any) => r.id === id)?.value ?? NaN);

    // Manual: client/src/components/CreateProfileDialog.tsx with the Vehicle type (its registry field keys).
    const a0 = await snapshot(ctx), p0 = await scoped(ctx, [partner.id]);
    const m = must(await ctx.api("POST", "/profiles", { type: "vehicle", type_key: "vehicle", name: `Civic ${T}M`, fields: { purchase_price: price, current_value: value, purchase_date: bought }, tags: [], notes: "" }), "manual asset");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${m.id}`));
    const a1 = await snapshot(ctx);
    ctx.near("derived", O.cents(a1.totalAssetValue - a0.totalAssetValue), value, "manual: total assets rose by the current value");
    await settle();
    const since = isoNow();
    const t1 = await sayNew(ctx, `Add my car "Civic ${T}C": I bought it for $${price.toLocaleString("en-US")} on ${inWords(bought)} and it's worth $${value.toLocaleString("en-US")} now.`,
      async () => (await ctx.db.count("profiles", `name=ilike.*${encodeURIComponent(`${T}C`)}*&deleted_at=is.null`)) > 0, "car");
    const found = await findMade(ctx, "profiles", "name", `${T}C`, since, (r) => !["person", "self"].includes(r.type), [m.id, partner.id]);
    ctx.check("action", true, "the chat answered");
    if (!found.rows.length) return noRow(ctx, "Asset", t1, "I16");
    ctx.check("db", found.rows.length === 1, "the chat stored ONE asset record", json(found.rows.map((r: any) => [r.type, r.type_key, r.name])));
    const c = found.rows[0];
    const a2 = await snapshot(ctx);
    ctx.near("derived", O.cents(a2.totalAssetValue - a1.totalAssetValue), value, "chat: total assets rose by the same current value");
    const mRow = await ctx.db.row("profiles", m.id);
    const f = (r: any, ...keys: string[]) => { for (const k of keys) if (r?.fields?.[k] != null && r.fields[k] !== "") return r.fields[k]; return null; };
    compare(ctx, "Asset", mRow, await ctx.db.row("profiles", c.id), [
      { label: "type", get: (r) => r.type, rule: "I16" },
      { label: "type_key", get: (r) => r.type_key ?? null, rule: "I16" },
      { label: "purchase price", get: (r) => num(f(r, "purchasePrice", "purchase_price")), rule: "Rule 1", severity: "bug" },
      { label: "current value", get: (r) => num(f(r, "currentValue", "current_value", "value")), rule: "Rule 1", severity: "bug" },
      { label: "purchase date", get: (r) => (f(r, "purchaseDate", "purchase_date") ? String(f(r, "purchaseDate", "purchase_date")).slice(0, 10) : null), rule: "I16" },
      { label: "stored under the canonical keys (purchasePrice / currentValue)", get: (r) => [r.fields?.purchasePrice != null, r.fields?.currentValue != null], rule: "Rule 1 (one source per value)" },
      { label: "name", get: (r) => free(r.name), rule: "I16" },
    ], t1);
    ctx.near("derived", valueOf(a2, m.id), value, "manual: the asset breakdown lists it at its value");
    ctx.near("derived", valueOf(a2, c.id), value, "chat: the asset breakdown lists it at the same value");

    // Share 60/40 — manual: client/src/components/OwnershipEditor.tsx saveMut.
    must(await ctx.api("PUT", `/profiles/${m.id}/owners`, { owners: [{ partyProfileId: ctx.self.id, ownershipPercentage: 60 }, { partyProfileId: partner.id, ownershipPercentage: 40 }] }), "manual split");
    const p1 = await scoped(ctx, [partner.id]);
    const share = O.netWorth([{ value, sharePct: 40 }], []).assets;
    ctx.near("derived", O.cents(p1.totalAssetValue - p0.totalAssetValue), share, "manual: the partner's assets rose by 40% of the value");
    await settle();
    const t2 = await say(ctx, `Split ownership of my "Civic ${T}C": 60% me and 40% ${partner.name}.`);
    const links = async (id: string) => (await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${id}`))
      .filter((l: any) => !l.effective_to)
      .map((l: any) => [l.party_profile_id === ctx.self.id ? "SELF" : l.party_profile_id === partner.id ? "PARTNER" : `other:${String(l.party_profile_id).slice(0, 8)}`, Number(l.ownership_percentage)] as [string, number]).sort();
    const lm = await links(m.id), lc = await links(c.id);
    ctx.same("db", lm, [["PARTNER", 40], ["SELF", 60]], "manual: two owner rows, 60 me and 40 the partner");
    compare(ctx, "Asset ownership", { links: lm }, { links: lc }, [
      { label: "owner rows (who, %)", get: (r) => r.links, rule: "Rule 9 (ownership has one writer)", severity: "bug" },
    ], t2);
    const p2 = await scoped(ctx, [partner.id]), me = await scoped(ctx, [ctx.self.id]), a3 = await snapshot(ctx);
    ctx.near("derived", O.cents(p2.totalAssetValue - p1.totalAssetValue), share, "chat: the partner's assets rose by the same 40%");
    ctx.near("derived", valueOf(me, m.id), O.netWorth([{ value, sharePct: 60 }], []).assets, "manual: my share of it is 60%");
    ctx.near("derived", valueOf(me, c.id), O.netWorth([{ value, sharePct: 60 }], []).assets, "chat: my share of it is 60%");
    ctx.near("derived", O.cents(a3.totalAssetValue - a0.totalAssetValue), 2 * value, "the household still counts both cars whole");
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "equivalence.journal-note",
  title: "A journal entry and a note: the workspaces and the chat keep the person's words, a title and the same mood",
  area: "Manual vs chat",
  chat: true,
  covers: ["journal.create.api", "journal.create.chat", "note.create.api", "note.create.chat"],
  requires: ["action", "db"],
  run: async (ctx) => {
    sweepAfter(ctx);
    const T = ctx.tag;
    const free = doorFree(T);
    const owner = ownerOf(ctx, {});
    const words = (tag: string) => `Walked along the river after work (${tag}) and felt calm and grateful for the quiet.`;
    // Manual: client/src/pages/workspace-journal.tsx — a draft, then titled when the workspace closes.
    const jM = must(await ctx.api("POST", "/journal", { content: words(`${T}M`), tags: [], entryDate: ctx.today, draft: true }), "manual journal");
    must(await ctx.api("PATCH", `/journal/${jM.id}`, { autoTitle: true }), "title on close");
    await settle();
    let since = isoNow();
    const t1 = await say(ctx, `Save this as today's journal entry: ${words(`${T}C`)}`);
    const jm = await ctx.db.row("journal_entries", jM.id);
    const j = await findMade(ctx, "journal_entries", "content", `${T}C`, since, () => true, [jM.id]);
    ctx.check("action", true, "the chat answered");
    if (!j.rows.length) noRow(ctx, "Journal entry", t1, "J3");
    else {
      ctx.check("db", j.rows.length === 1, "the chat stored ONE journal entry (J1)", `${j.rows.length}`);
      const jc = j.rows[0];
      ctx.check("db", String(jm?.title ?? "").trim().length > 0, "manual: the entry has a title (J8)", json(jm?.title));
      ctx.check("db", String(jc?.title ?? "").trim().length > 0, "chat: the entry has a title (J8)", json(jc?.title));
      compare(ctx, "Journal entry", jm, jc, [
        { label: "text (the person's words)", get: (r) => free(r.content), rule: "J3 (the entry's text is the user's own words)", severity: "bug" },
        { label: "date", get: (r) => String(r.date ?? r.entry_date ?? "").slice(0, 10), rule: "J1", severity: "bug" },
        { label: "mood (detected from the same words)", get: (r) => r.mood ?? null, rule: "J2 (picked or detected, never a silent default)" },
        { label: "has a title", get: (r) => String(r.title ?? "").trim().length > 0, rule: "J8", severity: "bug" },
        { label: "owner (linked_profiles)", get: owner, rule: "J7" },
      ], t1);
      ctx.step(`titles: manual "${jm?.title}", chat "${jc?.title}"`);
    }

    // Note — manual: client/src/pages/workspace-notes.tsx, a typed title.
    const body = (tag: string) => `Hallway is Swiss Coffee, front door is Hale Navy, trim is Chantilly Lace (${tag}).`;
    const nM = must(await ctx.api("POST", "/notes", { title: `Paint colours ${T}M`, content: body(`${T}M`), tags: [] }), "manual note");
    await settle();
    since = isoNow();
    const t2 = await say(ctx, `Create a note titled "Paint colours ${T}C" that says: ${body(`${T}C`)}`);
    const nm = await ctx.db.row("artifacts", nM.id);
    const n = await findMade(ctx, "artifacts", "title", `${T}C`, since, (r) => r.type === "note", [nM.id]);
    if (!n.rows.length) return noRow(ctx, "Note", t2, "J5 / J8");
    ctx.check("db", n.rows.length === 1, "the chat stored ONE note", json(n.rows.map((r: any) => [r.type, r.title])));
    compare(ctx, "Note", nm, n.rows[0], [
      { label: "kind", get: (r) => r.type, rule: "J5 (a note is a Note)", severity: "bug" },
      { label: "title", get: (r) => free(r.title), rule: "J8 (what the writer typed)", severity: "bug" },
      { label: "text (the person's words)", get: (r) => free(r.content), rule: "W8 / J3", severity: "bug" },
      { label: "category tag", get: (r) => (Array.isArray(r.tags) ? r.tags : []).filter((x: string) => /^category:/.test(x)), rule: "W8" },
    ], t2);
  },
});
