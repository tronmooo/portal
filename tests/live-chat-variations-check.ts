// Live check (production, smoke account): the SAME requests said many ways.
//
// The chat tool sweep (scripts/verify-all-chat-tools.ts) sends one phrasing
// per tool. A person does not: they are terse, chatty, misspell, give several
// things in one breath, say "tomorrow" and "next Friday", and refer back to
// what they just said. Owner, 2026-11-24: "keep testing … with different
// combinations of things you would say to the chat".
//
// Each line is typed into the deployed chat as a user would type it. What is
// judged is the ACCOUNT afterwards (the rows the screens read), not the
// wording of the reply: the right record, the right amount, the right day,
// once. Every turn is timed.
//
// Costs Anthropic credits; not part of CI.
//   npx tsx tests/live-chat-variations-check.ts               (everything)
//   GROUP=expenses npx tsx tests/live-chat-variations-check.ts
// Everything the run creates is removed afterwards (any row that was not in
// the account before it started). Takes the gate lock.
import { api, fetchWithRateLimitRetry, getSmokeToken } from "./smoke/fixture/api";
import { API_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";

const TZ = "America/Los_Angeles";
const GROUP = process.env.GROUP || "";
/** A reply slower than this is reported (chat budget: an answer the user is not left waiting on). */
const SLOW_MS = 8000;

const dayIn = (offset: number): string => {
  const now = new Date(Date.now() + offset * 86_400_000);
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
};
const TODAY = dayIn(0);
/** The next date (after today) that falls on this weekday (0 = Sunday). */
const nextWeekday = (dow: number): string => {
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    if (new Date(d.toLocaleString("en-US", { timeZone: TZ })).getDay() === dow) return dayIn(i);
  }
  return "";
};

const LISTS = {
  tasks: "/tasks", expenses: "/expenses", incomes: "/incomes", events: "/events", habits: "/habits",
  notes: "/notes", journal: "/journal", profiles: "/profiles", goals: "/goals", memories: "/memories",
} as const;
type ListName = keyof typeof LISTS;
type Rows = Record<ListName, any[]> & { entries: any[] };

// The app reads a list the way this does: it tells the server the newest data
// version it has seen (learned from the write's own answer), so another server
// instance cannot hand it the list from before the write. A read without it
// can be a few seconds stale — which is not what a person's screen shows, and
// read here as "Added task: Call Dad" with no task (2026-11-24).
let seenDataVersion = "";
async function read(path: string) {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${await getSmokeToken()}`,
      "X-Timezone": TZ,
      ...(seenDataVersion ? { "X-Data-Version": seenDataVersion } : {}),
    },
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

async function snapshot(): Promise<Rows> {
  const out: any = {};
  await Promise.all((Object.keys(LISTS) as ListName[]).map(async (k) => {
    const r = await read(LISTS[k]);
    if (!r.ok) throw new Error(`GET ${LISTS[k]}: ${r.status}`);
    out[k] = list(r.data);
  }));
  const t = await read("/trackers");
  if (!t.ok) throw new Error(`GET /trackers: ${t.status}`);
  out.entries = list(t.data).flatMap((tr: any) => (tr.entries || []).map((e: any) => ({ ...e, tracker: tr.name, trackerId: tr.id })));
  out.trackers = list(t.data);
  return out;
}
/** What is in `after` and was not in `before`. */
function fresh(before: Rows, after: Rows): Rows {
  const out: any = {};
  for (const k of Object.keys(after) as Array<keyof Rows>) {
    const had = new Set((before[k] || []).map((r: any) => r.id));
    out[k] = (after[k] || []).filter((r: any) => !had.has(r.id));
  }
  return out;
}

let lastStart = 0;
async function say(message: string, history: Array<{ role: string; content: string }> = []) {
  const wait = lastStart + 3400 - Date.now(); // 20 chat calls a minute per user
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastStart = Date.now();
  const { response, ms } = await fetchWithRateLimitRetry(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getSmokeToken()}`, "X-Timezone": TZ },
    body: JSON.stringify({ message, history }),
  });
  const data: any = await response.json().catch(() => null);
  const version = response.headers.get("x-data-version") || (typeof data?.dataVersion === "string" ? data.dataVersion : "");
  if (version) seenDataVersion = version;
  return { status: response.status, ms, reply: String(data?.reply || ""), data };
}

interface Ctx { reply: string; made: Rows; now: Rows; before: Rows }
interface Case {
  group: string;
  say: string;
  /** "" when the account is as it should be, else what is wrong. */
  expect: (c: Ctx) => string;
  /** A follow-up typed after the reply, judged by `expect` instead (the first turn only has to answer). */
  then?: string;
}

const money = (n: unknown, want: number) => Math.abs(Number(n) - want) < 0.005;
const has = (s: unknown, ...words: string[]) => words.every((w) => String(s ?? "").toLowerCase().includes(w.toLowerCase()));
const names = (rows: any[], key = "title") => rows.map((r) => r[key] ?? r.description ?? r.name).join(" | ") || "nothing";
const day = (v: unknown) => String(v ?? "").slice(0, 10);

/** Exactly one new task whose title has the words, due on `due` when given; nothing else created. */
const oneTask = (words: string[], due?: string, time?: string) => (c: Ctx): string => {
  const t = c.made.tasks;
  if (t.length !== 1) return `expected one new task, got ${t.length} (${names(t)})`;
  if (!has(t[0].title, ...words)) return `the task is "${t[0].title}", expected it to mention ${words.join(" + ")}`;
  if (due && day(t[0].dueDate) !== due) return `the task is due ${day(t[0].dueDate) || "no date"}, expected ${due}`;
  if (time && String(t[0].dueTime || "").slice(0, 5) !== time) return `the task's time is ${t[0].dueTime || "none"}, expected ${time}`;
  const extra = c.made.events.length + c.made.expenses.length + c.made.profiles.length;
  return extra ? `it also created ${c.made.events.length} event(s), ${c.made.expenses.length} expense(s), ${c.made.profiles.length} profile(s)` : "";
};
/** Exactly these new expenses (amount + a word of the description), on `date` when given. */
const expenses = (want: Array<[number, string]>, date?: string) => (c: Ctx): string => {
  const e = c.made.expenses;
  if (e.length !== want.length) return `expected ${want.length} new expense(s), got ${e.length} (${e.map((x) => `${x.description} $${x.amount}`).join(" | ") || "nothing"})`;
  for (const [amount, word] of want) {
    const hit = e.find((x) => money(x.amount, amount) && has(`${x.description} ${x.vendor || ""} ${x.category || ""}`, word));
    if (!hit) return `no expense of $${amount} mentioning "${word}" (got ${e.map((x) => `${x.description} $${x.amount}`).join(" | ")})`;
    if (date && day(hit.date) !== date) return `the $${amount} expense is dated ${day(hit.date)}, expected ${date}`;
  }
  return c.made.tasks.length ? `it also created ${c.made.tasks.length} task(s): ${names(c.made.tasks)}` : "";
};
/** One new event with the words, on `date`, at `time` when given. */
const oneEvent = (words: string[], date?: string, time?: string, recurrence?: string) => (c: Ctx): string => {
  const e = c.made.events;
  if (e.length !== 1) return `expected one new event, got ${e.length} (${names(e)}); tasks made: ${names(c.made.tasks)}`;
  if (!has(e[0].title, ...words)) return `the event is "${e[0].title}", expected it to mention ${words.join(" + ")}`;
  if (date && day(e[0].date) !== date) return `the event is on ${day(e[0].date)}, expected ${date}`;
  if (time && String(e[0].time || "").slice(0, 5) !== time) return `the event is at ${e[0].time || "no time"}, expected ${time}`;
  if (recurrence && e[0].recurrence !== recurrence) return `the event repeats "${e[0].recurrence}", expected ${recurrence}`;
  return c.made.profiles.length ? `it also created a profile: ${names(c.made.profiles, "name")}` : "";
};
/** New tracker entries: each [tracker word, field, value]. */
const logged = (want: Array<[string, string, number]>, exact = true) => (c: Ctx): string => {
  const e = c.made.entries;
  for (const [tracker, field, value] of want) {
    // The tracker is matched by any of the names it may go by ("water|hydration"),
    // the reading by its value: a tracker names its own field ("value", "ounces").
    const named = new RegExp(tracker, "i");
    const hit = e.find((x) => named.test(String(x.tracker)) && Object.entries(x.values || {}).some(([k, v]) => (!field || has(k, field)) && money(v, value)));
    if (!hit) return `no ${tracker} entry with ${field} = ${value} (new entries: ${e.map((x) => `${x.tracker} ${JSON.stringify(x.values)}`).join(" | ").slice(0, 260) || "none"})`;
  }
  if (exact && e.length !== want.length) return `expected ${want.length} new entr${want.length === 1 ? "y" : "ies"}, got ${e.length}: ${e.map((x) => `${x.tracker} ${JSON.stringify(x.values)}`).join(" | ").slice(0, 260)}`;
  return "";
};
const nothingMade = (c: Ctx): string => {
  const n = (Object.keys(c.made) as Array<keyof Rows>).filter((k) => k !== ("trackers" as any)).map((k) => [k, c.made[k].length] as const).filter(([, v]) => v > 0);
  return n.length ? `it created ${n.map(([k, v]) => `${v} ${k}`).join(", ")}` : "";
};
const replySays = (...patterns: RegExp[]) => (c: Ctx): string => {
  const miss = patterns.find((p) => !p.test(c.reply));
  return miss ? `the reply does not match ${miss}: "${c.reply.replace(/\s+/g, " ").slice(0, 200)}"` : nothingMade(c);
};

const TOMORROW = dayIn(1);
const YESTERDAY = dayIn(-1);
const FRIDAY = nextWeekday(5);
const TUESDAY = nextWeekday(2);

const CASES: Case[] = [
  // ── Tasks: the same kind of request, said differently ─────────────────────
  { group: "tasks", say: "remind me to call the plumber tomorrow at 3pm", expect: oneTask(["plumber"], TOMORROW, "15:00") },
  { group: "tasks", say: "add a task: buy stamps", expect: oneTask(["stamps"]) },
  { group: "tasks", say: "todo pick up dry cleaning friday", expect: oneTask(["dry cleaning"], FRIDAY) },
  { group: "tasks", say: "I need to renew my passport by December 15", expect: oneTask(["passport"], `${TODAY.slice(0, 4)}-12-15`) },
  { group: "tasks", say: "don't let me forget to water the ferns tomorrow", expect: oneTask(["fern"], TOMORROW) },
  { group: "tasks", say: "remind me 2 call dad tmrw", expect: oneTask(["dad"], TOMORROW) },
  { group: "tasks", say: "Put 'return the library books' on my list for the day after tomorrow", expect: oneTask(["library"], dayIn(2)) },
  { group: "tasks", say: "I should probably email the landlord about the leak", expect: oneTask(["landlord"]) },
  { group: "tasks", say: "Call Mike at 3", expect: oneTask(["mike"], undefined, "15:00") },

  // ── Expenses ──────────────────────────────────────────────────────────────
  { group: "expenses", say: "spent $12.50 on lunch", expect: expenses([[12.5, "lunch"]], TODAY) },
  { group: "expenses", say: "I paid 40 bucks for gas yesterday", expect: expenses([[40, "gas"]], YESTERDAY) },
  { group: "expenses", say: "coffee 4.75", expect: expenses([[4.75, "coffee"]], TODAY) },
  { group: "expenses", say: "bought groceries for $86.20 at Safeway", expect: expenses([[86.2, "safeway"]], TODAY) },
  { group: "expenses", say: "lunch at Panera $14 and parking $6", expect: expenses([[14, "panera"], [6, "parking"]], TODAY) },
  { group: "expenses", say: "spnt 20 on grocries", expect: expenses([[20, "groc"]], TODAY) },
  { group: "expenses", say: "$1,200.00 for a new laptop bag, paid today", expect: expenses([[1200, "bag"]], TODAY) },
  { group: "expenses", say: "Uber home was 23 dollars and 40 cents", expect: expenses([[23.4, "uber"]], TODAY) },
  { group: "expenses", say: "I got Sarah a birthday gift for $35", expect: (c) => expenses([[35, "gift"]], TODAY)(c) || (c.made.profiles.length ? `it created a profile for Sarah (${names(c.made.profiles, "name")})` : "") },

  // ── Health and trackers ───────────────────────────────────────────────────
  { group: "health", say: "weight 182.4", expect: logged([["weight", "", 182.4]]) },
  { group: "health", say: "my blood pressure was 118/76 this morning", expect: logged([["blood pressure", "systolic", 118]], false) },
  { group: "health", say: "drank 16 oz of water", expect: logged([["water|hydration", "", 16]], false) },
  { group: "health", say: "slept 7.5 hours last night", expect: logged([["sleep", "", 7.5]], false) },
  { group: "health", say: "I had a banana and a doughnut", expect: (c) => {
    const food = c.made.entries.filter((e) => /nutrition|food|meal|calor/i.test(e.tracker));
    if (food.length !== 2) return `expected two food entries (one per food), got ${food.length}: ${food.map((e) => JSON.stringify(e.values)).join(" | ").slice(0, 240) || "none"}`;
    const items = food.map((e) => String(e.values?.item || e.values?.food || e.notes || "").toLowerCase());
    return items.some((i) => i.includes("banana")) && items.some((i) => /dou?gh?nut/.test(i)) ? "" : `the two entries are ${items.join(" | ")}`;
  } },
  { group: "health", say: "ran 3 miles in 28 minutes", expect: logged([["run|cardio|exercise|workout", "", 3]], false) },

  // ── Events ────────────────────────────────────────────────────────────────
  { group: "events", say: "dentist appointment next Tuesday at 2pm", expect: oneEvent(["dentist"], TUESDAY, "14:00") },
  { group: "events", say: "Lunch with Sam on December 3 at noon", expect: oneEvent(["sam"], `${TODAY.slice(0, 4)}-12-03`, "12:00") },
  { group: "events", say: "Jordan's birthday is March 9", expect: oneEvent(["jordan", "birthday"], undefined, undefined, "yearly") },
  { group: "events", say: "team offsite Friday 9am to 5pm at the Marriott", expect: oneEvent(["offsite"], FRIDAY, "09:00") },
  // Something you DO at a time is a timed task; something that HAPPENS is an event. Either is on the calendar at 10:30.
  { group: "events", say: "schedule a haircut for the day after tomorrow at 10:30", expect: (c) => (c.made.events.length ? oneEvent(["haircut"], dayIn(2), "10:30")(c) : oneTask(["haircut"], dayIn(2), "10:30")(c)) },

  // ── Several things in one breath ──────────────────────────────────────────
  { group: "combined", say: "I spent $8 on a smoothie and need to call mom tomorrow", expect: (c) => {
    const e = expenses([[8, "smoothie"]], TODAY)({ ...c, made: { ...c.made, tasks: [] } });
    if (e) return e;
    return oneTask(["mom"], TOMORROW)({ ...c, made: { ...c.made, expenses: [] } });
  } },
  { group: "combined", say: "add tasks: buy milk, mail the rent check, and book the vet", expect: (c) => {
    const t = c.made.tasks;
    if (t.length !== 3) return `expected three tasks, got ${t.length} (${names(t)})`;
    return ["milk", "rent", "vet"].every((w) => t.some((x) => has(x.title, w))) ? "" : `the tasks are ${names(t)}`;
  } },
  { group: "combined", say: "weight 181 and I spent 9.99 on vitamins", expect: (c) => logged([["weight", "", 181]], false)(c) || expenses([[9.99, "vitamin"]], TODAY)(c) },

  // ── Notes and journal ─────────────────────────────────────────────────────
  { group: "writing", say: "note: the garage door code is 4471", expect: (c) => (c.made.notes.length === 1 && has(c.made.notes[0].content ?? c.made.notes[0].title, "4471") ? "" : `expected one note holding 4471, got ${c.made.notes.length} note(s); memories: ${c.made.memories.length}`) },
  { group: "writing", say: "journal: felt tired but proud of finishing the report", expect: (c) => {
    const j = c.made.journal;
    if (j.length !== 1) return `expected one journal entry, got ${j.length}`;
    if (!has(j[0].content, "proud")) return `the entry reads "${String(j[0].content).slice(0, 80)}"`;
    return String(j[0].title || "").trim() ? "" : "the entry has no title";
  } },
  { group: "writing", say: "remember that my library card number is 20418", expect: (c) => (c.made.memories.length === 1 && has(c.made.memories[0].value, "20418") ? "" : `expected one memory holding 20418, got ${c.made.memories.length}; notes: ${c.made.notes.length}`) },

  // ── Questions: an answer, and nothing written ─────────────────────────────
  { group: "questions", say: "what tasks do I have?", expect: replySays(/task/i) },
  { group: "questions", say: "how much have I spent this month?", expect: replySays(/\$\s?\d/) },
  { group: "questions", say: "what's on my calendar this week", expect: nothingMade },
  { group: "questions", say: "what is my net worth", expect: replySays(/\$\s?[\d,]+/) },
  { group: "questions", say: "show me a pie chart of my spending by category", expect: (c) => nothingMade(c) || ((c as any).reply && /Here's "/.test(c.reply) ? `answered with a document: ${c.reply.slice(0, 80)}` : "") },
  { group: "questions", say: "should I add a task for the dentist?", expect: nothingMade },

  // ── Names are data, not profiles (Rule 13); nothing destroyed on a whim ───
  { group: "safety", say: "Bob's birthday is September 30", expect: oneEvent(["bob", "birthday"], undefined, undefined, "yearly") },
  { group: "safety", say: "delete everything", expect: (c) => {
    const gone = (Object.keys(LISTS) as ListName[]).filter((k) => c.now[k].length < c.before[k].length);
    return gone.length ? `records disappeared without a confirmation: ${gone.join(", ")}` : nothingMade(c);
  } },
  { group: "safety", say: "never mind, don't add anything", expect: nothingMade },

  // ── Bills and debts ───────────────────────────────────────────────────────
  { group: "money", say: "I have a $25 a month Spotify subscription due on the 5th", expect: (c) => {
    const p = c.made.profiles.filter((x) => has(x.name, "spotify"));
    if (p.length !== 1) return `expected ONE Spotify bill, got ${p.length} (${names(c.made.profiles, "name")})`;
    return money(p[0].fields?.amount ?? p[0].fields?.monthlyPayment, 25) ? "" : `its amount is ${JSON.stringify(p[0].fields?.amount ?? p[0].fields?.monthlyPayment)}, expected 25`;
  } },
  { group: "money", say: "I owe $5,000 on my Visa at 22% APR, minimum payment $150 on the 12th", expect: (c) => {
    const p = c.made.profiles.filter((x) => ["liability", "loan"].includes(x.type));
    if (p.length !== 1) return `expected ONE debt record (a card is its own bill), got ${p.length} (${names(c.made.profiles, "name")})`;
    const f = p[0].fields || {};
    if (!money(f.balance, 5000)) return `its balance is ${f.balance}, expected 5000`;
    if (!money(f.interestRate, 22)) return `its rate is ${f.interestRate}, expected 22 (a percent)`;
    return money(f.monthlyPayment, 150) ? "" : `its payment is ${f.monthlyPayment}, expected 150`;
  } },
  { group: "money", say: "got paid $2,400 today", expect: (c) => (c.made.incomes.length === 1 && money(c.made.incomes[0].amount, 2400) ? (c.made.expenses.length ? "it also logged an expense" : "") : `expected one income of 2400, got ${c.made.incomes.map((i) => i.amount).join(", ") || "none"}; expenses: ${c.made.expenses.map((e) => e.amount).join(", ") || "none"}`) },
  { group: "money", say: "I want to save $3,000 for a vacation by June", expect: (c) => (c.made.goals.length === 1 && money(c.made.goals[0].target, 3000) ? "" : `expected one goal with target 3000, got ${c.made.goals.map((g) => `${g.title} ${g.target}`).join(" | ") || "none"}`) },

  // ── Habits ────────────────────────────────────────────────────────────────
  { group: "habits", say: "start a daily habit to meditate", expect: (c) => (c.made.habits.length === 1 && has(c.made.habits[0].name, "meditat") ? "" : `expected one meditation habit, got ${names(c.made.habits, "name")}`) },
  { group: "habits", say: "I meditated today", expect: (c) => {
    const h = c.now.habits.filter((x) => has(x.name, "meditat"));
    if (h.length !== 1) return `expected ONE meditation habit, got ${h.length}`;
    const done = (h[0].checkins || []).filter((k: any) => day(k.date) === TODAY).length;
    return done === 1 ? "" : `today has ${done} check-in(s), expected 1`;
  } },
  { group: "habits", say: "I meditated again... no wait, I only did it once", expect: (c) => {
    const h = c.now.habits.filter((x) => has(x.name, "meditat"));
    const done = ((h[0]?.checkins) || []).filter((k: any) => day(k.date) === TODAY).length;
    return done === 1 ? "" : `today has ${done} check-in(s), expected it to stay at 1`;
  } },

  // ── Editing by name ───────────────────────────────────────────────────────
  { group: "edits", say: "add a task to call the electrician", then: "rename the electrician task to Call the electrician about the breaker", expect: (c) => {
    const t = c.now.tasks.filter((x) => has(x.title, "electrician"));
    if (t.length !== 1) return `expected ONE electrician task, got ${t.length} (${names(t)})`;
    return has(t[0].title, "breaker") ? "" : `the task is still "${t[0].title}"`;
  } },
  { group: "edits", say: "spent $60 on a jacket", then: "change the jacket expense category to clothing", expect: (c) => {
    const e = c.now.expenses.filter((x) => has(x.description, "jacket"));
    if (e.length !== 1) return `expected ONE jacket expense, got ${e.length}`;
    if (!money(e[0].amount, 60)) return `its amount changed to ${e[0].amount}`;
    return has(e[0].category, "cloth") ? "" : `its category is "${e[0].category}"`;
  } },
  { group: "edits", say: "dinner with Priya on Saturday at 7pm", then: "move it to 8pm", expect: (c) => {
    const e = c.now.events.filter((x) => has(x.title, "priya"));
    if (e.length !== 1) return `expected ONE dinner event, got ${e.length}; tasks: ${names(c.now.tasks.filter((x) => has(x.title, "priya")))}`;
    return String(e[0].time || "").slice(0, 5) === "20:00" ? "" : `it is at ${e[0].time}, expected 20:00`;
  } },

  // ── Referring back to what was just said ──────────────────────────────────
  { group: "followups", say: "add a task to pick up the cake", then: "mark it as done", expect: (c) => {
    const t = c.now.tasks.filter((x) => has(x.title, "cake"));
    return t.length === 1 && t[0].status === "done" ? "" : `expected the one cake task done, got ${t.map((x) => x.status).join(", ") || "none"}`;
  } },
  { group: "followups", say: "add a task to order printer ink", then: "I finished it", expect: (c) => {
    const t = c.now.tasks.filter((x) => has(x.title, "ink"));
    return t.length === 1 && t[0].status === "done" ? "" : `expected the one ink task done, got ${t.map((x) => x.status).join(", ") || "none"}`;
  } },
  { group: "followups", say: "spent $18 on a movie ticket", then: "delete that", expect: (c) => {
    const e = c.now.expenses.filter((x) => has(x.description, "movie"));
    // It may ask first; what it may not do is leave the expense AND say it was removed.
    if (e.length === 0) return "";
    return /delet|remov/i.test(c.reply) && !/\?/.test(c.reply) ? `the expense is still there but the reply says: ${c.reply.slice(0, 120)}` : "";
  } },
  { group: "followups", say: "spent $30 on a phone case", then: "actually it was $32", expect: (c) => {
    const e = c.now.expenses.filter((x) => has(x.description, "phone case"));
    if (e.length !== 1) return `expected ONE phone case expense after the correction, got ${e.length} (${e.map((x) => x.amount).join(", ")})`;
    return money(e[0].amount, 32) ? "" : `the expense is $${e[0].amount}, expected 32`;
  } },
  { group: "followups", say: "add a task to wash the car", then: "make it due tomorrow", expect: (c) => {
    const t = c.now.tasks.filter((x) => has(x.title, "car") && x.status !== "done");
    if (t.length !== 1) return `expected ONE wash-the-car task, got ${t.length}`;
    return day(t[0].dueDate) === TOMORROW ? "" : `it is due ${day(t[0].dueDate) || "no date"}, expected ${TOMORROW}`;
  } },
  { group: "followups", say: "add a task to buy birthday candles", then: "mark that done", expect: (c) => {
    const t = c.now.tasks.filter((x) => has(x.title, "candles"));
    if (t.length !== 1) return `expected ONE candles task, got ${t.length}`;
    return t[0].status === "done" ? "" : `it is "${t[0].status}", expected done`;
  } },
];

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-chat-variations-check" });
  const start = await snapshot();
  const cases = CASES.filter((c) => !GROUP || GROUP.split(",").includes(c.group));
  const version = (await api("GET", "/version")).data?.sha;
  console.log(`production is serving ${String(version).slice(0, 7)}; ${cases.length} chat line(s); today is ${TODAY} (${TZ})`);
  let failed = 0;
  const timings: Array<{ say: string; ms: number }> = [];
  let group = "";
  try {
    for (const c of cases) {
      if (c.group !== group) { group = c.group; console.log(`\n— ${group}`); }
      const before = await snapshot();
      let turn = await say(c.say);
      timings.push({ say: c.say, ms: turn.ms });
      let spoken = c.say;
      if (c.then && turn.status === 200) {
        const second = await say(c.then, [{ role: "user", content: c.say }, { role: "assistant", content: turn.reply }]);
        timings.push({ say: c.then, ms: second.ms });
        spoken = `${c.say} → ${c.then}`;
        turn = second;
      }
      const now = await snapshot();
      let problem = turn.status !== 200 ? `the chat answered ${turn.status}` : "";
      if (!problem && !turn.reply.trim()) problem = "the chat gave no reply";
      if (!problem) { try { problem = c.expect({ reply: turn.reply, made: fresh(before, now), now, before }); } catch (e: any) { problem = `could not judge: ${e?.message || e}`; } }
      if (problem) failed++;
      console.log(`${problem ? "FAIL" : "PASS"}  ${String(turn.ms).padStart(6)}ms  "${spoken}"${problem ? `\n        ${problem}\n        reply: ${turn.reply.replace(/\s+/g, " ").slice(0, 220)}` : ""}`);
    }
  } finally {
    // Remove every row the run created.
    const end = await snapshot().catch(() => null);
    let removed = 0;
    if (end) {
      const made = fresh(start, end);
      for (const k of Object.keys(LISTS) as ListName[]) {
        for (const row of made[k]) { const r = await api("DELETE", `${LISTS[k]}/${row.id}`); if (r.ok) removed++; }
      }
      const hadTrackers = new Set(((start as any).trackers || []).map((t: any) => t.id));
      for (const t of ((end as any).trackers || []) as any[]) {
        if (!hadTrackers.has(t.id)) { if ((await api("DELETE", `/trackers/${t.id}`)).ok) removed++; }
      }
      for (const e of made.entries) {
        if (hadTrackers.has(e.trackerId)) { if ((await api("DELETE", `/trackers/${e.trackerId}/entries/${e.id}`)).ok) removed++; }
      }
    }
    console.log(`\ncleanup: removed ${removed} row(s) the run created`);
    await release();
  }
  const sorted = [...timings].sort((a, b) => a.ms - b.ms);
  const median = sorted[Math.floor(sorted.length / 2)]?.ms ?? 0;
  const slow = timings.filter((t) => t.ms > SLOW_MS);
  console.log(`\nreply time: median ${median}ms, slowest ${sorted[sorted.length - 1]?.ms ?? 0}ms over ${timings.length} turn(s)`);
  if (slow.length) console.log(`SLOW  over ${SLOW_MS}ms: ${slow.map((t) => `"${t.say.slice(0, 40)}" ${t.ms}ms`).join("; ")}`);
  console.log(`\n${cases.length - failed} of ${cases.length} passed${failed ? "\n\nFAILED" : "\n\nALL PASS"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
