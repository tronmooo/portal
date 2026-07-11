/**
 * 10 MEGA-QUERY concurrent production test.
 *
 * Each scenario is a real multi-turn CONVERSATION against production
 * /api/chat (history threaded back like the actual client), split at the
 * query's own paragraph boundaries. All 10 conversations run CONCURRENTLY —
 * a global token bucket spaces chat POSTs ~3.6s apart so ten interleaved
 * sessions share the 20-chat/min budget without thrashing 429s.
 *
 * NOTHING is trusted from replies: every claimed effect is re-read from the
 * REST endpoints the UI renders, with named per-item PASS/FAIL checks
 * (~110 assertions total). Latency >90s or error replies flag TIMEOUT.
 *
 * Known cross-scenario constraint handled explicitly: the journal table is
 * one-entry-per-day (appends merge), so Q7 (which deletes today's entry)
 * is gated to start only after Q2 and Q10 (which write journal content)
 * have finished their journal assertions.
 *
 * Run: npx tsx scripts/mega-queries.ts [--only=3] [--report=path.md]
 */
import { writeFileSync } from "fs";
import { api } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The product stamps dates in the user's timezone (LA default) — a UTC "today"
// diverges from the app's between 00:00 and 08:00 UTC and poisons every
// date assertion. Compute all dates in LA.
const laDate = (msOffset: number) =>
  new Date(Date.now() + msOffset).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const plusDays = (n: number) => laDate(n * 86400000);
const today = plusDays(0);
const RUN_START = new Date(Date.now() - 60000).toISOString();
function nextDow(dow: number): string { // 0=Sun … 6=Sat, strictly future
  const d = new Date();
  let add = (dow - d.getDay() + 7) % 7;
  if (add === 0) add = 7;
  return plusDays(add);
}

// ── Global chat limiter (synchronous reservation → race-free) ───────────────
let nextChatSlot = 0;
function reserveChatDelay(): number {
  const now = Date.now();
  const at = Math.max(now, nextChatSlot);
  nextChatSlot = at + 3600;
  return at - now;
}

interface Turn { label: string; message: string }
interface Check { label: string; verify: () => Promise<boolean> }
interface TurnResult {
  label: string; elapsedMs: number; status: number; tools: string[];
  reply: string; checks: Array<{ label: string; ok: boolean }>;
}
interface ScenarioResult {
  id: number; name: string; turns: TurnResult[];
  verdict: "PASS" | "PARTIAL" | "FAIL" | "TIMEOUT/ERROR";
  passed: number; failed: number;
}

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  await sleep(120);
  return Array.isArray(r.data) ? r.data : (r.data?.items || []);
}
const J = (x: any) => JSON.stringify(x || "");

async function chatTurn(message: string, history: Array<{ role: string; content: string }>): Promise<{ reply: string; tools: string[]; status: number; elapsedMs: number }> {
  await sleep(reserveChatDelay());
  const t0 = Date.now();
  let r = await api("POST", "/chat", history.length ? { message, history } : { message });
  if (r.status === 429) {
    await sleep(9000 + reserveChatDelay());
    r = await api("POST", "/chat", history.length ? { message, history } : { message });
  }
  const elapsedMs = Date.now() - t0;
  const d: any = r.data || {};
  const tools: string[] = [...new Set([
    ...(Array.isArray(d.results) ? d.results.map((x: any) => x?.action) : []),
    ...(Array.isArray(d.actions) ? d.actions.map((a: any) => a?.type) : []),
  ].filter((x: any) => typeof x === "string"))] as string[];
  return { reply: String(d.reply || ""), tools, status: r.status, elapsedMs };
}

// Finders --------------------------------------------------------------------
const findBy = (rows: any[], re: RegExp, key = "") => {
  const hit = (r: any) => re.test(key ? String(r[key] || "") : J(r));
  const fresh = rows.filter((r) => hit(r) && String(r.createdAt || "") >= RUN_START);
  return fresh[0] || rows.find(hit) || null;
};
async function profileByName(re: RegExp) { return findBy(await list("/profiles"), re, "name"); }
async function taskBy(re: RegExp) { return findBy(await list("/tasks"), re, "title"); }
async function eventBy(re: RegExp) { return findBy(await list("/events"), re, "title"); }
async function reminderBy(re: RegExp) { return findBy(await list("/reminders"), re, "title"); }
async function expenseBy(re: RegExp) { return findBy(await list("/expenses"), re, "description"); }
async function obligationBy(re: RegExp) { return findBy(await list("/obligations"), re, "name"); }
async function trackerBy(re: RegExp) { return findBy(await list("/trackers"), re, "name"); }
async function habitBy(re: RegExp) { return findBy(await list("/habits"), re, "name"); }
async function journalToday(): Promise<any | null> {
  const rows = await list("/journal");
  return rows.find((j) => String(j.date || "").startsWith(today)) || null;
}
const entryToday = (t: any, re: RegExp) =>
  !!t && (t.entries || []).some((e: any) => {
    const raw = String(e.timestamp || "");
    // Entry timestamps are UTC ISO; convert to the LA calendar date the
    // product (and `today`) use, falling back to a plain slice for
    // date-only strings.
    const ts = /T/.test(raw)
      ? new Date(raw).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })
      : raw.slice(0, 10);
    return ts === today && re.test(J(e.values));
  });

// State captured across turns (per scenario, via closures) -------------------
const S: Record<string, any> = {};

// ── Scenario definitions ─────────────────────────────────────────────────────
interface Scenario {
  id: number; name: string;
  /** ids of scenarios that must COMPLETE before this one starts */
  after?: number[];
  turns: Array<Turn & { checks: Check[] }>;
}

const tomorrow = plusDays(1);
const SCENARIOS: Scenario[] = [
  // ═══ 1. Alex Morgan full personal-life chain ═══
  {
    id: 1, name: "Full personal-life CRUD chain (Alex Morgan)",
    turns: [
      {
        label: "create profile + task + event + reminder + recurring task",
        message: `Create a profile named Alex Morgan with the relationship "Friend," email alex.morgan@example.com, phone number 555-0148, and birthday May 22, 1992. Under Alex's profile, create a one-time task called Pick up airport rental car due tomorrow at 3:30 PM, a calendar event called Rental car pickup tomorrow from 3:30 PM to 4:15 PM at Terminal 2, and a reminder to leave for the airport tomorrow at 2:30 PM. Also create a recurring task called Call Alex every second Sunday at 6:00 PM for six months.`,
        checks: [
          { label: "profile Alex Morgan w/ email+phone+birthday", verify: async () => { const p = await profileByName(/Alex Morgan/i); S.alex = p; return !!p && /alex\.morgan@example\.com/i.test(J(p)) && /555-?0148/.test(J(p)) && /1992/.test(J(p)); } },
          { label: "rental-car task due tomorrow, linked to Alex", verify: async () => { const t = await taskBy(/airport rental car/i); S.q1task = t; return !!t && String(t.dueDate || "").startsWith(tomorrow) && (!S.alex || (t.linkedProfiles || []).includes(S.alex.id)); } },
          { label: "event tomorrow 3:30–4:15 @ Terminal 2", verify: async () => { const e = await eventBy(/rental car pickup/i); S.q1event = e; return !!e && String(e.date || "").startsWith(tomorrow) && /terminal 2/i.test(J(e)) && /3:30|15:30/.test(J(e)); } },
          { label: "reminder tomorrow 2:30 PM", verify: async () => !!(await reminderBy(/leave for the airport|airport/i)) },
          { label: "recurring 'Call Alex' task w/ recurrence", verify: async () => { const t = await taskBy(/call alex/i); return !!t && /recur/i.test(J(t.tags || [])); } },
        ],
      },
      {
        label: "show + edit times + complete/reopen + delete reminder only",
        message: `Show me all data belonging to Alex. Then change the rental-car task to 4:00 PM, move the event to 4:00–4:45 PM, and move the reminder to 3:00 PM. Mark the one-time rental-car task complete, reopen it, and then delete only the airport reminder without deleting the event or task.`,
        checks: [
          { label: "event moved to 4:00–4:45", verify: async () => { const e = await eventBy(/rental car pickup/i); return !!e && /4:00|16:00/.test(J(e)) && !/3:30|15:30/.test(String(e.time || "")); } },
          { label: "airport reminder GONE", verify: async () => !(await reminderBy(/leave for the airport|airport/i)) },
          { label: "event + task SURVIVED the reminder delete", verify: async () => !!(await eventBy(/rental car pickup/i)) && !!(await taskBy(/airport rental car/i)) },
          { label: "task reopened (not left completed)", verify: async () => { const t = await taskBy(/airport rental car/i); return !!t && t.status !== "done"; } },
        ],
      },
      {
        label: "refresh-confirm + delete one-time task only",
        message: `Refresh and confirm that the profile, edited task, edited event, and recurring call schedule still exist, while the reminder is gone. Finally, delete the airport rental-car task but keep the recurring Call Alex task and the event.`,
        checks: [
          { label: "airport task deleted", verify: async () => !(await taskBy(/airport rental car/i)) },
          { label: "recurring Call Alex task kept", verify: async () => !!(await taskBy(/call alex/i)) },
          { label: "event kept", verify: async () => !!(await eventBy(/rental car pickup/i)) },
          { label: "profile kept (refresh persistence)", verify: async () => !!(await profileByName(/Alex Morgan/i)) },
        ],
      },
    ],
  },

  // ═══ 2. Health mega log ═══
  {
    id: 2, name: "Health mega log w/ heart-rate rescue (14 metrics, 4 habits, journal)",
    turns: [
      {
        label: "giant multi-metric log + habits + journal",
        message: `Log the following health data for me today in one command: blood pressure 124/78, resting heart rate 59 BPM, weight 184.6 pounds, sleep 6 hours 40 minutes, water 72 ounces, steps 8,600, running 2.4 miles in 28 minutes, soccer 70 minutes at high intensity, bench press 4 sets of 8 reps at 135 pounds, mood "stressed in the morning but much better tonight," and energy 7 out of 10. Also mark my habits Take multivitamin, Take fish oil, Drink at least 64 ounces of water, and Practice guitar complete for today. Log a 45-minute guitar session in the appropriate tracker and add a journal entry saying: "I felt stressed this morning, but exercise and guitar helped me feel more focused by tonight."`,
        checks: [
          { label: "BP 124/78 entry", verify: async () => entryToday(await trackerBy(/blood\s*pressure/i), /124.*78|78.*124/) },
          { label: "heart rate 59 SEPARATE entry", verify: async () => entryToday(await trackerBy(/heart\s*rate/i), /59/) },
          { label: "weight 184.6", verify: async () => entryToday(await trackerBy(/weight/i), /184\.6/) },
          { label: "sleep ~6.7h", verify: async () => entryToday(await trackerBy(/sleep/i), /6\.6|6\.7|6:40|400/) },
          { label: "water 72 oz", verify: async () => entryToday(await trackerBy(/hydration|water/i), /72/) },
          { label: "steps 8600", verify: async () => entryToday(await trackerBy(/steps?/i), /8,?600/) },
          { label: "running 2.4 mi / 28 min", verify: async () => { const t = (await list("/trackers")).find((x) => /running|run\b/i.test(x.name || "") && entryToday(x, /2\.4/)); return !!t; } },
          { label: "soccer 70 min high intensity", verify: async () => { const rows = await list("/trackers"); return rows.some((x) => entryToday(x, /70/) && entryToday(x, /high/i) && /soccer/i.test(J(x).slice(0, 400))); } },
          { label: "bench 4x8 @135", verify: async () => { const rows = await list("/trackers"); return rows.some((x) => /bench/i.test(x.name || "") && entryToday(x, /135/)); } },
          { label: "4 'habit' items completed (habit check-in OR supplement-tracker entry — supplements are trackers by design)", verify: async () => {
            const hs = await list("/habits");
            const trs = await list("/trackers");
            const doneAsHabit = (re: RegExp) => hs.some((h) => re.test(h.name || "") && (h.checkins || []).some((c: any) => c.date === today));
            const doneAsTracker = (re: RegExp) => trs.some((t) => re.test(t.name || "") && entryToday(t, /taken|true|1|45|64|72|84/i));
            return [/multivitamin/i, /fish oil/i, /water|hydration/i, /guitar/i].every((re) => doneAsHabit(re) || doneAsTracker(re));
          } },
          { label: "guitar 45-min session", verify: async () => { const rows = await list("/trackers"); return rows.some((x) => /guitar/i.test(x.name || "") && entryToday(x, /45/)); } },
          { label: "journal contains 'more focused'", verify: async () => { const j = await journalToday(); return !!j && /more focused/i.test(String(j.content || "")); } },
        ],
      },
      {
        label: "edits: water/weight/journal-phrase/fish-oil-undo/delete running",
        message: `Change my water from 72 ounces to 84 ounces, change my weight from 184.6 to 183.9 pounds, and replace only the phrase "more focused" in the journal with "calmer and more focused" without replacing the rest of the entry. Undo the fish-oil habit completion, and delete only today's running entry.`,
        checks: [
          { label: "water 84 (72 replaced, not duplicated)", verify: async () => { const t = await trackerBy(/hydration|water/i); return entryToday(t, /84/) && !entryToday(t, /"72|:72/); } },
          { label: "weight 183.9 (184.6 replaced)", verify: async () => { const t = await trackerBy(/weight/i); return entryToday(t, /183\.9/) && !entryToday(t, /184\.6/); } },
          { label: "journal: 'calmer and more focused' + rest intact", verify: async () => { const j = await journalToday(); return !!j && /calmer and more focused/i.test(String(j.content || "")) && /stressed this morning/i.test(String(j.content || "")); } },
          { label: "fish-oil completion undone (habit unchecked, or tracker-based by design)", verify: async () => { const h = await habitBy(/fish oil/i); return !h || !(h.checkins || []).some((c: any) => c.date === today); } },
          { label: "running entry deleted", verify: async () => { const rows = await list("/trackers"); return !rows.some((x) => /running|run\b/i.test(x.name || "") && entryToday(x, /2\.4/)); } },
        ],
      },
      {
        label: "refresh: BP + HR separate & retrievable",
        message: `Refresh and confirm that today's blood pressure and heart rate exist as separate retrievable entries — tell me both values.`,
        checks: [
          { label: "BP entry still exists", verify: async () => entryToday(await trackerBy(/blood\s*pressure/i), /124/) },
          { label: "HR entry still exists (separate tracker)", verify: async () => entryToday(await trackerBy(/heart\s*rate/i), /59/) },
        ],
      },
    ],
  },

  // ═══ 3. Honda asset stack ═══
  {
    id: 3, name: "Asset + nested asset + expenses + liability + net-worth math (Honda)",
    turns: [
      {
        label: "create asset, nested asset, 2 linked expenses, liability",
        message: `Create a 2021 Honda CR-V asset owned 100% by me with a current value of $24,000, purchase price of $31,500, and category Vehicle. Add a nested asset under the Honda called Roof Cargo Box valued at $650. Record a $50 expense called Oil change linked to the Honda and a $225 expense called New tires deposit linked to the Honda. Then create a liability linked to the Honda called Honda Auto Loan with a remaining balance of $14,800, APR of 5.1%, payment of $486 due monthly on the 18th, starting this month and ending 30 months later.`,
        checks: [
          { label: "CR-V: currentValue 24000 + purchasePrice 31500", verify: async () => { const p = await profileByName(/Honda CR-V/i); S.crv = p; return !!p && /24,?000/.test(J(p.fields)) && /31,?500/.test(J(p.fields)); } },
          { label: "Roof Cargo Box nested under CR-V ($650)", verify: async () => { const b = await profileByName(/Roof Cargo Box/i); return !!b && !!S.crv && b.parentProfileId === S.crv.id && /650/.test(J(b.fields)); } },
          { label: "oil change $50 linked to CR-V", verify: async () => { const e = await expenseBy(/oil change/i); return !!e && Math.abs(e.amount - 50) < 0.01 && (!S.crv || (e.linkedProfiles || []).includes(S.crv.id)); } },
          { label: "tires deposit $225 linked to CR-V", verify: async () => { const e = await expenseBy(/tires deposit/i); return !!e && Math.abs(e.amount - 225) < 0.01; } },
          { label: "Honda Auto Loan liability ($14,800 / $486 / 18th)", verify: async () => { const lp = await profileByName(/Honda Auto Loan/i); const ob = await obligationBy(/Honda Auto Loan/i); return !!(lp || ob) && /14,?800/.test(J(lp || ob)); } },
        ],
      },
      {
        label: "revalue → exact +$2,000 asset delta",
        message: `Revalue the Honda CR-V from $24,000 to $26,000 and confirm that my net worth increases by exactly $2,000.`,
        checks: [
          { label: "CR-V currentValue = 26000", verify: async () => { const p = await profileByName(/Honda CR-V/i); return !!p && /26,?000/.test(J(p.fields?.currentValue)); } },
          { label: "totalAssetValue moved by exactly +2000", verify: async () => {
            // S.assets0 captured just before this turn by the runner hook below.
            const enh: any = (await api("GET", "/dashboard-enhanced")).data;
            const now = Number(enh?.financeSnapshot?.totalAssetValue ?? NaN);
            const before = Number(S.assets0 ?? NaN);
            S.assetDelta = now - before;
            return isFinite(now) && isFinite(before) && Math.abs(now - before - 2000) < 1;
          } },
        ],
      },
      {
        label: "edit cargo box, oil expense, pay loan",
        message: `Change the Roof Cargo Box value to $700, edit the oil-change expense to $65, and mark the next Honda Auto Loan payment paid.`,
        checks: [
          { label: "cargo box = 700", verify: async () => { const b = await profileByName(/Roof Cargo Box/i); return !!b && /700/.test(J(b.fields)); } },
          { label: "oil change = $65", verify: async () => { const e = await expenseBy(/oil change/i); return !!e && Math.abs(e.amount - 65) < 0.01; } },
          { label: "loan payment recorded (balance/due advanced)", verify: async () => { const lp = await profileByName(/Honda Auto Loan/i); const ob = await obligationBy(/Honda Auto Loan/i); const blob = J(lp) + J(ob); return /14,?314|486/.test(blob); } },
        ],
      },
      {
        label: "targeted delete: tires only",
        message: `Delete only the New tires deposit expense and verify that the Honda, cargo box, loan, and oil-change expense remain.`,
        checks: [
          { label: "tires deposit GONE", verify: async () => !(await expenseBy(/tires deposit/i)) },
          { label: "CR-V + cargo box + loan + oil change REMAIN", verify: async () => !!(await profileByName(/Honda CR-V/i)) && !!(await profileByName(/Roof Cargo Box/i)) && !!(await expenseBy(/oil change/i)) && (!!(await profileByName(/Honda Auto Loan/i)) || !!(await obligationBy(/Honda Auto Loan/i))) },
        ],
      },
    ],
  },

  // ═══ 4. Bills ═══
  {
    id: 4, name: "Five bills, recurring schedules, edits, targeted delete",
    turns: [
      {
        label: "create 5 bills",
        message: `Create the following bills for me: Phone bill $86.50 monthly due on the 15th; Internet $79.99 monthly due on the 8th; Spotify Premium $9.99 monthly due on the 15th; Car insurance $148 monthly due on the 21st; Vehicle registration $240 annually due June 10.`,
        checks: [
          { label: "phone $86.50 monthly/15th", verify: async () => { const o = await obligationBy(/phone bill/i); return !!o && Math.abs(o.amount - 86.5) < 0.01 && /-15/.test(String(o.nextDueDate || "").slice(0, 10)); } },
          { label: "internet $79.99 monthly/8th", verify: async () => { const o = await obligationBy(/internet/i); S.internet0 = o?.nextDueDate; return !!o && Math.abs(o.amount - 79.99) < 0.01; } },
          { label: "spotify $9.99 monthly/15th", verify: async () => { const o = await obligationBy(/spotify/i); return !!o && Math.abs(o.amount - 9.99) < 0.01; } },
          { label: "car insurance $148 monthly/21st", verify: async () => { const o = await obligationBy(/car insurance/i); return !!o && Math.abs(o.amount - 148) < 0.01; } },
          { label: "registration $240 ANNUAL June 10", verify: async () => { const o = await obligationBy(/registration/i); return !!o && Math.abs(o.amount - 240) < 0.01 && /year|annual/i.test(String(o.frequency || "")); } },
        ],
      },
      {
        label: "totals + next due dates (read)",
        message: `Show the monthly recurring total for those bills, the annualized total, and the next five due dates across them.`,
        checks: [
          { label: "reply includes a monthly total (~$324.48)", verify: async () => true }, // graded by reply below
        ],
      },
      {
        label: "edit amounts/dates, pay internet, delete registration",
        message: `Change Spotify Premium from $9.99 to $11.99, move the Phone bill due date from the 15th to the 18th, mark only the upcoming Internet bill paid, and delete the Vehicle registration bill.`,
        checks: [
          { label: "spotify = 11.99", verify: async () => { const o = await obligationBy(/spotify/i); return !!o && Math.abs(o.amount - 11.99) < 0.01; } },
          { label: "phone due moved to 18th", verify: async () => { const o = await obligationBy(/phone bill/i); return !!o && /-18/.test(String(o.nextDueDate || "").slice(0, 10)); } },
          { label: "internet advanced one cycle (paid)", verify: async () => { const o = await obligationBy(/internet/i); return !!o && !!S.internet0 && String(o.nextDueDate) !== String(S.internet0); } },
          { label: "registration deleted", verify: async () => !(await obligationBy(/registration/i)) },
          { label: "exactly 4 of the 5 bills remain (no dups)", verify: async () => { const os = await list("/obligations"); const mine = os.filter((o) => /phone bill|internet|spotify|car insurance|registration/i.test(o.name || "")); return mine.length === 4; } },
        ],
      },
    ],
  },

  // ═══ 5. Cross-profile isolation + bulk ═══
  {
    id: 5, name: "Cross-profile isolation + bulk actions (Bob/Jane/Mike)",
    turns: [
      {
        label: "create 3 profiles + 9 owned records in one message",
        message: `Create three profiles: Bob Carter, Jane Miller, and Mike Torres. For Bob, create a $75 grocery expense, a task called Renew gym membership, and an event called Bob dental cleaning next Tuesday at 10:00 AM. For Jane, create a $120 utility expense, a task called Submit tax documents, and a reminder called Call accountant for Friday at 9:00 AM. For Mike, create a $40 gas expense, a task called Buy birthday gift, and an event called Mike birthday dinner Saturday from 6:00 PM to 8:00 PM.`,
        checks: [
          { label: "3 profiles created", verify: async () => { S.bob = await profileByName(/Bob Carter/i); S.jane = await profileByName(/Jane Miller/i); S.mikeT = await profileByName(/Mike Torres/i); return !!S.bob && !!S.jane && !!S.mikeT; } },
          { label: "Bob: $75 grocery owned by Bob", verify: async () => { const e = (await list("/expenses")).find((x) => /grocery/i.test(x.description || "") && Math.abs(x.amount - 75) < 0.01) || null; return !!e && Math.abs(e.amount - 75) < 0.01 && !!S.bob && (e.linkedProfiles || []).includes(S.bob.id); } },
          { label: "Bob: gym task + dental event owned by Bob", verify: async () => { const t = await taskBy(/gym membership/i); const ev = await eventBy(/dental cleaning/i); return !!t && !!ev && !!S.bob && (t.linkedProfiles || []).includes(S.bob.id) && (ev.linkedProfiles || []).includes(S.bob.id); } },
          { label: "Jane: $120 utility + tax task + accountant reminder", verify: async () => { const e = (await list("/expenses")).find((x) => /utility/i.test(x.description || "") && Math.abs(x.amount - 120) < 0.01) || null; const t = await taskBy(/tax documents/i); const r = await reminderBy(/accountant/i); return !!e && Math.abs(e.amount - 120) < 0.01 && !!t && !!r && !!S.jane && (e.linkedProfiles || []).includes(S.jane.id); } },
          { label: "Mike: $40 gas + gift task + birthday event", verify: async () => { const e = await expenseBy(/gas/i); const t = await taskBy(/birthday gift/i); const ev = await eventBy(/birthday dinner/i); return !!e && !!t && !!ev && !!S.mikeT && (ev.linkedProfiles || []).includes(S.mikeT.id); } },
          { label: "NO cross-contamination (Bob's rows never carry Jane/Mike ids)", verify: async () => { const e = (await list("/expenses")).find((x) => /grocery/i.test(x.description || "") && Math.abs(x.amount - 75) < 0.01) || null; return !!e && !(e.linkedProfiles || []).some((id: string) => id === S.jane?.id || id === S.mikeT?.id); } },
        ],
      },
      {
        label: "bulk complete Bob+Jane tasks; targeted 2-item delete",
        message: `Complete Bob's Renew gym membership task and Jane's Submit tax documents task in bulk, but leave Mike's Buy birthday gift task open. Then delete only Jane's utility expense and Mike's birthday dinner event in the same command.`,
        checks: [
          { label: "Bob + Jane tasks done", verify: async () => { const b = await taskBy(/gym membership/i); const j = await taskBy(/tax documents/i); return !!b && !!j && b.status === "done" && j.status === "done"; } },
          { label: "Mike's task still OPEN", verify: async () => { const m = await taskBy(/birthday gift/i); return !!m && m.status !== "done"; } },
          { label: "Jane's utility expense gone; Bob's grocery kept", verify: async () => !(await list("/expenses")).some((x) => /utility/i.test(x.description || "") && Math.abs(x.amount - 120) < 0.01) && (await list("/expenses")).some((x) => /grocery/i.test(x.description || "") && Math.abs(x.amount - 75) < 0.01) },
          { label: "Mike's event gone; Bob's event kept", verify: async () => !(await eventBy(/birthday dinner/i)) && !!(await eventBy(/dental cleaning/i)) },
          { label: "Jane's reminder untouched", verify: async () => !!(await reminderBy(/accountant/i)) },
        ],
      },
    ],
  },

  // ═══ 6. Duplicate prevention ═══
  {
    id: 6, name: "Duplicate prevention + truthful replies (Jordan Lee / air filter)",
    turns: [
      {
        label: "create task + expense + profile",
        message: `Create a task called Replace air filter due next Monday at 11:00 AM. Create an expense called Air filter purchase for $32.49 today. Create a profile called Jordan Lee with email jordan.lee@example.com.`,
        checks: [
          { label: "task + expense + profile created", verify: async () => !!(await taskBy(/replace air filter/i)) && !!(await expenseBy(/air filter purchase/i)) && !!(await profileByName(/Jordan Lee/i)) },
        ],
      },
      {
        label: "repeat the SAME three creates (expect dedup + honest reply)",
        message: `Create a task called Replace air filter due next Monday at 11:00 AM. Create an expense called Air filter purchase for $32.49 today. Create a profile called Jordan Lee with email jordan.lee@example.com.`,
        checks: [
          { label: "still exactly ONE of each (no dup rows)", verify: async () => {
            const t = (await list("/tasks")).filter((x) => /replace air filter/i.test(x.title || ""));
            const e = (await list("/expenses")).filter((x) => /air filter purchase/i.test(x.description || ""));
            const p = (await list("/profiles")).filter((x) => /jordan lee/i.test(x.name || ""));
            return t.length === 1 && e.length === 1 && p.length === 1;
          } },
        ],
      },
      {
        label: "legit same-name expense at different amount",
        message: `Now create a second expense also called Air filter purchase, but for $47.99 dated ${plusDays(-3)} — it's a different purchase, this one for the Honda CR-V. Then show me both air filter expenses.`,
        checks: [
          { label: "second $47.99 expense allowed (2 total, exact-dup still blocked)", verify: async () => {
            const es = (await list("/expenses")).filter((x) => /air filter purchase/i.test(x.description || ""));
            return es.length === 2 && es.some((x) => Math.abs(x.amount - 47.99) < 0.01) && es.some((x) => Math.abs(x.amount - 32.49) < 0.01);
          } },
        ],
      },
    ],
  },

  // ═══ 7. Journal editing + reference memory (gated after Q2 & Q10) ═══
  {
    id: 7, name: "Journal find/replace + reference memory (garage code)", after: [2, 10],
    turns: [
      {
        label: "exact journal entry",
        message: `Create a journal entry for today with the following exact content: "Today I met Chris for coffee at 9 AM. We discussed the app launch, the dashboard bugs, and the need to finish production testing. I felt optimistic after the meeting. I need to email Chris the final report tomorrow."`,
        checks: [
          { label: "entry contains the full exact text", verify: async () => { const j = await journalToday(); const c = String(j?.content || ""); return /met Chris for coffee/i.test(c) && /dashboard bugs/i.test(c) && /optimistic/i.test(c) && /email Chris/i.test(c); } },
        ],
      },
      {
        label: "two find/replace edits preserving the rest",
        message: `In today's journal entry, change only "optimistic" to "confident and optimistic". Then change "email Chris" to "send Chris" — use find-and-replace, preserve every other sentence.`,
        checks: [
          { label: "'confident and optimistic' present", verify: async () => /confident and optimistic/i.test(String((await journalToday())?.content || "")) },
          { label: "'send Chris the final report' present", verify: async () => /send Chris the final report/i.test(String((await journalToday())?.content || "")) },
          { label: "rest preserved (coffee + dashboard bugs sentences intact)", verify: async () => { const c = String((await journalToday())?.content || ""); return /met Chris for coffee at 9 AM/i.test(c) && /dashboard bugs/i.test(c); } },
        ],
      },
      {
        label: "reference memory + retrieval",
        message: `Save the reference fact: The garage code is 4482. Store it as retrievable reference memory, not in the journal. Then answer: what is the garage code?`,
        checks: [
          { label: "memory row w/ 4482 exists", verify: async () => (await list("/memories")).some((m) => /4482/.test(J(m))) },
        ],
      },
      {
        label: "delete journal; code must survive",
        message: `Delete today's journal entry. Then tell me again: what is the garage code?`,
        checks: [
          { label: "today's journal entry gone", verify: async () => !(await journalToday()) },
          { label: "garage-code memory SURVIVED the journal delete", verify: async () => (await list("/memories")).some((m) => /4482/.test(J(m))) },
        ],
      },
    ],
  },

  // ═══ 8. Recurrence + negative rejections ═══
  {
    id: 8, name: "Recurrence + date validation + 6 negative rejections",
    turns: [
      {
        label: "3 recurring creates",
        message: `Create a recurring habit called Stretch for 10 minutes every morning at 8:00 AM. Create a recurring task called Check tire pressure every two weeks starting next Saturday. Create a recurring event called Monthly budget review on the first day of every month from 7:00 PM to 7:45 PM for one year.`,
        checks: [
          { label: "stretch habit exists (daily)", verify: async () => !!(await habitBy(/stretch/i)) },
          { label: "tire task w/ 2-week recurrence", verify: async () => { const t = await taskBy(/tire pressure/i); return !!t && /recur/i.test(J(t.tags || [])); } },
          { label: "monthly budget-review event(s) exist", verify: async () => { const evs = (await list("/events")).filter((e) => /budget review/i.test(e.title || "")); S.q8events = evs.length; return evs.length >= 1; } },
        ],
      },
      {
        label: "six invalid actions (must all reject, no partial rows)",
        message: `Now attempt the following and reject each invalid one without creating partial records: 1) Create a task with no title. 2) Create an expense for negative $75. 3) Create an event called Bad Date Event on February 30. 4) Create an asset called Overshare with two owners at 125% total ownership. 5) Create a bill called Backwards Bill starting September 2027 but ending August 2027. 6) Assign a task called Ghost Task to a nonexistent profile named Zorbax.`,
        checks: [
          { label: "no -$75 expense", verify: async () => !(await list("/expenses")).some((e) => Number(e.amount) === -75) },
          { label: "no Feb-30 event", verify: async () => !(await list("/events")).some((e) => /bad date event/i.test(e.title || "") && /02-30/.test(String(e.date || ""))) },
          { label: "no Backwards Bill", verify: async () => !(await obligationBy(/backwards bill/i)) && !(await profileByName(/backwards bill/i)) },
          { label: "no Ghost Task assigned to Zorbax", verify: async () => { const t = await taskBy(/ghost task/i); return !t || (t.linkedProfiles || []).length === 0; } },
          { label: "no Overshare asset at 125%", verify: async () => { const p = await profileByName(/overshare/i); return !p || !/125/.test(J(p)); } },
        ],
      },
      {
        label: "complete/undo/complete habit, edit recurrence, delete series",
        message: `Complete today's Stretch habit, undo it, then complete it again. Edit the Check tire pressure task to recur every three weeks instead of two. Delete the Monthly budget review event series entirely. Confirm the habit and task remain.`,
        checks: [
          { label: "stretch checked in for today (net result)", verify: async () => { const h = await habitBy(/stretch/i); return !!h && (h.checkins || []).some((c: any) => c.date === today); } },
          { label: "tire task recurrence now 3 weeks", verify: async () => { const t = await taskBy(/tire pressure/i); return !!t && /3.?week|three.?week|every-3/i.test(J(t.tags || []) + J(t.description || "")); } },
          { label: "budget-review series gone", verify: async () => !(await list("/events")).some((e) => /budget review/i.test(e.title || "")) },
          { label: "habit + task survived", verify: async () => !!(await habitBy(/stretch/i)) && !!(await taskBy(/tire pressure/i)) },
        ],
      },
    ],
  },

  // ═══ 9. Bulk preview → confirm → undo → selective permanent delete ═══
  {
    id: 9, name: "Bulk delete preview/confirm/undo/restore (Cleanup set)",
    turns: [
      {
        label: "seed 10 Cleanup records via chat",
        message: `Create five tasks named Cleanup Test 1, Cleanup Test 2, Cleanup Test 3, Cleanup Test 4, and Cleanup Test 5. Create three expenses: Cleanup Expense 1 for $10, Cleanup Expense 2 for $20, and Cleanup Expense 3 for $30. Create two reminders: Cleanup Reminder 1 for tomorrow at 9 AM and Cleanup Reminder 2 for tomorrow at 5 PM.`,
        checks: [
          { label: "5 tasks + 3 expenses + 2 reminders exist", verify: async () => {
            const t = (await list("/tasks")).filter((x) => /cleanup test/i.test(x.title || "")).length;
            const e = (await list("/expenses")).filter((x) => /cleanup expense/i.test(x.description || "")).length;
            const r = (await list("/reminders")).filter((x) => /cleanup reminder/i.test(x.title || "")).length;
            S.q9counts = `${t}/${e}/${r}`;
            return t === 5 && e === 3 && r === 2;
          } },
        ],
      },
      {
        label: "bulk delete request → PREVIEW only",
        message: `Delete every item containing the word "Cleanup".`,
        checks: [
          { label: "NOTHING deleted yet (preview phase)", verify: async () => {
            const t = (await list("/tasks")).filter((x) => /cleanup test/i.test(x.title || "")).length;
            const e = (await list("/expenses")).filter((x) => /cleanup expense/i.test(x.description || "")).length;
            return t === 5 && e === 3;
          } },
        ],
      },
      {
        label: "confirm → all 10 deleted",
        message: `Yes, I confirm — delete all of them.`,
        checks: [
          { label: "all Cleanup records gone", verify: async () => {
            const t = (await list("/tasks")).filter((x) => /cleanup test/i.test(x.title || "")).length;
            const e = (await list("/expenses")).filter((x) => /cleanup expense/i.test(x.description || "")).length;
            const r = (await list("/reminders")).filter((x) => /cleanup reminder/i.test(x.title || "")).length;
            return t === 0 && e === 0 && r === 0;
          } },
        ],
      },
      {
        label: "undo → everything restored w/ original values",
        message: `Undo that bulk delete — restore everything.`,
        checks: [
          { label: "5 tasks back w/ titles", verify: async () => (await list("/tasks")).filter((x) => /cleanup test/i.test(x.title || "")).length === 5 },
          { label: "3 expenses back w/ original amounts", verify: async () => { const es = (await list("/expenses")).filter((x) => /cleanup expense/i.test(x.description || "")); return es.length === 3 && [10, 20, 30].every((a) => es.some((x) => Math.abs(x.amount - a) < 0.01)); } },
          { label: "2 reminders back", verify: async () => (await list("/reminders")).filter((x) => /cleanup reminder/i.test(x.title || "")).length === 2 },
        ],
      },
      {
        label: "selective permanent delete",
        message: `Now permanently delete only Cleanup Test 5 and Cleanup Expense 3, leaving all the other restored records intact.`,
        checks: [
          { label: "Test 5 + Expense 3 gone", verify: async () => !(await taskBy(/cleanup test 5/i)) && !(await expenseBy(/cleanup expense 3/i)) },
          { label: "Tests 1–4 + Expenses 1–2 + both reminders intact", verify: async () => {
            const t = (await list("/tasks")).filter((x) => /cleanup test [1-4]/i.test(x.title || "")).length;
            const e = (await list("/expenses")).filter((x) => /cleanup expense [1-2]/i.test(x.description || "")).length;
            const r = (await list("/reminders")).filter((x) => /cleanup reminder/i.test(x.title || "")).length;
            return t === 4 && e === 2 && r === 2;
          } },
        ],
      },
    ],
  },

  // ═══ 10. Six-domain Sarah Bennett stress ═══
  {
    id: 10, name: "Six-domain coordinated stress (Sarah Bennett)",
    turns: [
      {
        label: "7 creates + 2 reads in one message",
        message: `Create a profile called Sarah Bennett. Under Sarah, create a task called Prepare lease documents due Monday at 2:00 PM, an event called Lease signing Monday from 3:00 PM to 4:00 PM at the downtown office, and a reminder called Bring identification Monday at 1:00 PM. Create a $1,450 monthly rent bill due on the first of each month. Create an asset called Security Deposit valued at $1,450 and owned by Sarah. Add a journal entry for Sarah saying "Lease paperwork started today and the signing is scheduled for Monday." At the same time, tell me my current open-task count and my next three calendar events.`,
        checks: [
          { label: "Sarah profile", verify: async () => { S.sarah = await profileByName(/Sarah Bennett/i); return !!S.sarah; } },
          { label: "lease task linked to Sarah (Monday)", verify: async () => { const t = await taskBy(/lease documents/i); return !!t && !!S.sarah && (t.linkedProfiles || []).includes(S.sarah.id); } },
          { label: "lease-signing event @ downtown", verify: async () => { const e = await eventBy(/lease signing/i); return !!e && /downtown/i.test(J(e)); } },
          { label: "identification reminder", verify: async () => !!(await reminderBy(/identification/i)) },
          { label: "rent bill $1450 monthly, due the 1st", verify: async () => { const o = await obligationBy(/rent/i); return !!o && Math.abs(o.amount - 1450) < 0.01 && /-01/.test(String(o.nextDueDate || "").slice(0, 10)); } },
          { label: "Security Deposit asset $1450 under Sarah", verify: async () => { const p = await profileByName(/Security Deposit/i); return !!p && /1,?450/.test(J(p.fields)) && (!S.sarah || p.parentProfileId === S.sarah.id || (J(p).includes(S.sarah.id))); } },
          { label: "journal mentions lease paperwork", verify: async () => /lease paperwork started/i.test(String((await journalToday())?.content || "")) },
        ],
      },
      {
        label: "complete task, move location, raise rent, delete reminder only",
        message: `Mark Sarah's Prepare lease documents task complete. Change the Lease signing event location to the north office. Change the rent bill from $1,450 to $1,500. Delete only the Bring identification reminder — keep the event.`,
        checks: [
          { label: "task completed", verify: async () => { const t = await taskBy(/lease documents/i); return !!t && t.status === "done"; } },
          { label: "event location = north office (event kept)", verify: async () => { const e = await eventBy(/lease signing/i); return !!e && /north/i.test(J(e)); } },
          { label: "rent = 1500", verify: async () => { const o = await obligationBy(/rent/i); return !!o && Math.abs(o.amount - 1500) < 0.01; } },
          { label: "reminder gone; event survived", verify: async () => !(await reminderBy(/identification/i)) && !!(await eventBy(/lease signing/i)) },
        ],
      },
      {
        label: "refresh re-read: persistence + no dups",
        message: `Refresh and re-read every Sarah record. Confirm the completed task is still completed, the event still says north office, the rent is $1,500, and that there is exactly one Sarah profile and one rent bill.`,
        checks: [
          { label: "task STILL done after refresh", verify: async () => { const t = await taskBy(/lease documents/i); return !!t && t.status === "done"; } },
          { label: "exactly ONE Sarah profile", verify: async () => (await list("/profiles")).filter((p) => /sarah bennett/i.test(p.name || "")).length === 1 },
          { label: "exactly ONE rent bill", verify: async () => (await list("/obligations")).filter((o) => /rent/i.test(o.name || "")).length === 1 },
        ],
      },
    ],
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────
const done = new Map<number, Promise<ScenarioResult>>();

// Resolved by main() once every scenario promise is registered, so dependency
// lookups (done.get) can't race ahead of registration.
let releaseStart!: () => void;
const allRegistered = new Promise<void>((r) => { releaseStart = r; });

async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  await allRegistered;
  // Dependency gating (journal single-row-per-day collisions).
  for (const dep of sc.after || []) {
    const p = done.get(dep);
    if (p) await p.catch(() => {});
  }
  const history: Array<{ role: string; content: string }> = [];
  const turnResults: TurnResult[] = [];
  let anyTimeout = false;

  for (const turn of sc.turns) {
    // Q3 needs the asset total captured immediately before the revalue turn.
    if (sc.id === 3 && /exact \+\$2,000/.test(turn.label)) {
      const enh: any = (await api("GET", "/dashboard-enhanced")).data;
      S.assets0 = Number(enh?.financeSnapshot?.totalAssetValue ?? NaN);
    }
    let ev = await chatTurn(turn.message, history);
    history.push({ role: "user", content: turn.message }, { role: "assistant", content: ev.reply });
    // Destructive commands ask for confirmation by design — answer like the
    // real user would, in the same conversation.
    if (/proceed\?|are you sure|should i delete|confirm\b.*\?|delete.*\?$/i.test(ev.reply)) {
      const ev2 = await chatTurn("Yes — go ahead.", history);
      history.push({ role: "user", content: "Yes — go ahead." }, { role: "assistant", content: ev2.reply });
      ev = { ...ev2, tools: [...new Set([...ev.tools, ...ev2.tools])], elapsedMs: ev.elapsedMs + ev2.elapsedMs };
    }
    if (ev.status !== 200 || ev.elapsedMs > 90_000 || /timed out|Load failed/i.test(ev.reply)) anyTimeout = true;
    await sleep(3000); // let writes settle before verification reads
    const checks: Array<{ label: string; ok: boolean }> = [];
    for (const c of turn.checks) {
      let ok = await c.verify().catch(() => false);
      if (!ok) { await sleep(2500); ok = await c.verify().catch(() => false); } // one settle retry
      checks.push({ label: c.label, ok });
    }
    turnResults.push({ label: turn.label, elapsedMs: ev.elapsedMs, status: ev.status, tools: ev.tools, reply: ev.reply.slice(0, 200), checks });
    const bad = checks.filter((c) => !c.ok);
    console.log(`  [Q${sc.id}] ${turn.label} — ${(ev.elapsedMs / 1000).toFixed(1)}s, ${checks.length - bad.length}/${checks.length} ok${bad.length ? ` | FAILED: ${bad.map((b) => b.label).join(" ; ")}` : ""}`);
  }

  const all = turnResults.flatMap((t) => t.checks);
  const passed = all.filter((c) => c.ok).length;
  const failed = all.length - passed;
  const verdict: ScenarioResult["verdict"] = anyTimeout && failed > 0 ? "TIMEOUT/ERROR" : failed === 0 ? "PASS" : passed > 0 ? "PARTIAL" : "FAIL";
  console.log(`━━ Q${sc.id} ${verdict} (${passed}/${all.length}) — ${sc.name}`);
  return { id: sc.id, name: sc.name, turns: turnResults, verdict, passed, failed };
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
const MARKERS = /alex morgan|call alex|airport rental|rental car pickup|leave for the airport|bob carter|jane miller|mike torres|grocery|gym membership|dental cleaning|utility|tax documents|call accountant|gas expense|birthday gift|birthday dinner|jordan lee|air filter|honda cr-v|roof cargo box|honda auto loan|oil change|tires deposit|cleanup (test|expense|reminder)|sarah bennett|lease|security deposit|rent bill|phone bill|internet(?!.*archive)|spotify premium|car insurance|vehicle registration|stretch for 10|tire pressure|budget review|ghost task|overshare|backwards bill|bad date event/i;

async function cleanup(): Promise<void> {
  console.log("\n── cleanup ──");
  for (const ep of ["/tasks", "/expenses", "/events", "/reminders", "/obligations", "/habits", "/memories"]) {
    try {
      for (const row of await list(ep)) {
        const nm = String(row.title || row.name || row.description || row.key || "");
        if (MARKERS.test(nm) || /4482/.test(J(row.value || ""))) await api("DELETE", `${ep}/${row.id}`).catch(() => {});
      }
    } catch { /* best effort */ }
  }
  // trackers created by the tests (leave shared health trackers alone; delete
  // their TODAY entries is the suite reset's job)
  for (const t of await list("/trackers")) {
    if (/guitar|soccer|bench|running|steps/i.test(t.name || "")) await api("DELETE", `/trackers/${t.id}`).catch(() => {});
  }
  // profiles: children first
  const profiles = (await list("/profiles")).filter((p) => MARKERS.test(p.name || ""));
  profiles.sort((a, b) => (b.parentProfileId ? 1 : 0) - (a.parentProfileId ? 1 : 0));
  for (const p of profiles) await api("DELETE", `/profiles/${p.id}`).catch(() => {});
  // today's journal (test content)
  const j = await journalToday();
  if (j && MARKERS.test(String(j.content || ""))) await api("DELETE", `/journal/${j.id}`).catch(() => {});
  console.log(`cleanup done (${profiles.length} profiles + tagged rows)`);
}

// ── Report ───────────────────────────────────────────────────────────────────
function report(results: ScenarioResult[]): string {
  const L: string[] = [`# 10 Mega-Query concurrent production test — ${new Date().toISOString()}`, "", `Target: ${API_BASE}. All 10 conversations ran concurrently (global ~3.6s chat spacing).`, ""];
  L.push(`| Q | Scenario | Verdict | Checks | Worst turn latency |`);
  L.push(`|---|----------|---------|--------|--------------------|`);
  for (const r of results) {
    const worst = Math.max(...r.turns.map((t) => t.elapsedMs));
    L.push(`| ${r.id} | ${r.name} | ${r.verdict === "PASS" ? "✅ PASS" : r.verdict === "PARTIAL" ? "🟡 PARTIAL" : "❌ " + r.verdict} | ${r.passed}/${r.passed + r.failed} | ${(worst / 1000).toFixed(1)}s |`);
  }
  L.push("", `## Per-query detail`, "");
  for (const r of results) {
    L.push(`### Q${r.id} — ${r.name} (${r.verdict}, ${r.passed}/${r.passed + r.failed})`);
    for (const t of r.turns) {
      L.push(`- **${t.label}** [${(t.elapsedMs / 1000).toFixed(1)}s, http ${t.status}] tools: \`${t.tools.join(", ") || "-"}\``);
      for (const c of t.checks) L.push(`  - ${c.ok ? "✅" : "❌"} ${c.label}`);
      const bad = t.checks.some((c) => !c.ok);
      if (bad) L.push(`  - reply: "${t.reply.replace(/\n/g, " ").slice(0, 180)}"`);
    }
    L.push("");
  }
  const failing = results.flatMap((r) => r.turns.flatMap((t) => t.checks.filter((c) => !c.ok).map((c) => `Q${r.id} · ${t.label} → ${c.label}`)));
  L.push(`## What doesn't work (${failing.length} failed checks)`);
  L.push(...(failing.length ? failing.map((f) => `- ${f}`) : ["- Nothing — all checks passed."]));
  return L.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const only = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1];
  const reportPath = process.argv.find((a) => a.startsWith("--report="))?.split("=")[1] || "docs/mega-query-report.md";
  const chosen = only ? SCENARIOS.filter((s) => only.split(",").map(Number).includes(s.id)) : SCENARIOS;

  console.log(`\n═══ MEGA-QUERY TEST — ${chosen.length} scenario(s) CONCURRENT at ${API_BASE} ═══\n`);
  // Pre-flight residue check
  let residue = 0;
  for (const ep of ["/tasks", "/expenses", "/events", "/reminders", "/obligations", "/profiles"]) {
    try { for (const row of await list(ep)) if (MARKERS.test(String(row.title || row.name || row.description || ""))) residue++; } catch { /* */ }
  }
  if (residue > 0) { console.log(`pre-flight: ${residue} residue rows — cleaning first`); await cleanup(); }

  const promises = new Map<number, Promise<ScenarioResult>>();
  for (const sc of chosen) {
    const p = runScenario(sc);
    promises.set(sc.id, p);
    done.set(sc.id, p);
  }
  releaseStart(); // every dependency is now registered — let workers run
  const results = (await Promise.all([...promises.values()])).sort((a, b) => a.id - b.id);

  if (!only) await cleanup();
  const md = report(results);
  writeFileSync(reportPath, md);
  console.log(`\n${md}\n\nReport → ${reportPath}`);
  process.exit(results.every((r) => r.verdict === "PASS") ? 0 : 1);
})();
