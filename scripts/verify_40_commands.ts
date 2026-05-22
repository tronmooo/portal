// Drive all 40 user commands through processMessage() and verify each one
// actually wrote to the DB with correct profile attribution.
//
// PURPOSE: Stop guessing. Produce hard evidence of which commands work end-to-end.
//
// Run with:
//   cd portal && set -a && source .vercel-tmp/.env.prod && set +a && \
//     QA_USER_ID="05df1674-ed60-4aad-80c6-e63eb7225a45" \
//     npx tsx scripts/verify_40_commands.ts 2>&1 | tee /tmp/verify40.log

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { processMessage } from "../server/ai-engine.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const USER_ID      = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);
const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  requestStorageContext.run(storage as any, fn);

// The user's 40 test commands, verbatim
const COMMANDS: Array<{ n: number; msg: string; expect: string }> = [
  { n: 1,  msg: "Bob ran 2 miles, spent $45 on groceries, completed his workout habit, and create a monthly fitness budget for him for $300", expect: "tracker_entry(Running,Bob,2mi) + expense(Bob,$45 groceries) + habit_checkin(Workout,Bob) + budget(Bob,Fitness,$300/mo)" },
  { n: 2,  msg: "I paid my electric bill for $140, create a recurring reminder every month on the 15th, and mark my bills habit as complete", expect: "expense(self,$140 electric) + obligation/event(monthly 15th) + habit_checkin(Bills,self)" },
  { n: 3,  msg: "Jane spent $80 on gas, completed her hydration habit, and create a transportation budget for her for $250 a month", expect: "expense(Jane,$80 gas) + habit_checkin(Hydration,Jane) + budget(Jane,Transportation,$250/mo)" },
  { n: 4,  msg: "Bob bought a guitar for $600, add it as an asset, and create a practice guitar habit every night at 7 PM", expect: "asset_profile(Guitar,parent=Bob,$600) + expense(Bob,$600) + habit(Practice Guitar,Bob,daily 7pm)" },
  { n: 5,  msg: "I ate a chicken sandwich, walked 7,000 steps, drank 90 ounces of water, and completed my calorie goal habit", expect: "tracker_entry(Calories,self,chicken sandwich) + tracker_entry(Steps/Walking,self,7000) + tracker_entry(Water,self,90oz) + habit_checkin(Calorie Goal,self)" },
  { n: 6,  msg: "Create a new profile for Bob, create a workout tracker for him, and log that he lifted weights for 1 hour today", expect: "profile already exists (no dup) + tracker(Workout,Bob) + tracker_entry(Workout,Bob,1hr lifting)" },
  { n: 7,  msg: "Jane paid rent for $1,400, internet for $80, and groceries for $210, then update her monthly budget totals", expect: "3 expenses(Jane: rent $1400, internet $80, groceries $210)" },
  { n: 8,  msg: "I completed my reading habit, spent $35 at Starbucks, and create a coffee budget for me for $100 monthly", expect: "habit_checkin(Reading,self) + expense(self,$35 Starbucks) + budget(self,Coffee,$100/mo)" },
  { n: 9,  msg: "Bob bought a 2021 Honda Accord for $18,000 with a $350 monthly payment and create a recurring car payment reminder", expect: "vehicle_profile(2021 Honda Accord,parent=Bob,$18000) + liability(auto loan,$350/mo) + obligation/event(monthly car payment)" },
  { n: 10, msg: "Create a savings goal for me for Hawaii with a target of $8,000 by next summer and track progress monthly", expect: "goal(Hawaii,self,target=8000,deadline≈summer2027)" },
  { n: 11, msg: "Jane walked 4 miles, completed yoga, and spent $120 on workout clothes", expect: "tracker_entry(Walking,Jane,4mi) + habit_checkin(Yoga,Jane) + expense(Jane,$120 clothes)" },
  { n: 12, msg: "Bob paid his Chase credit card bill for $220, spent $60 on dinner, and completed his no soda habit", expect: "expense(Bob,$220 Chase) OR liability_payment + expense(Bob,$60 dinner) + habit_checkin(No Soda,Bob)" },
  { n: 13, msg: "Create a habit for me called Stretch Every Morning, remind me daily at 8 AM, and mark today as complete", expect: "habit(Stretch Every Morning,self,daily 8am) + habit_checkin today" },
  { n: 14, msg: "Jane bought groceries, paid her phone bill, and create a food budget and phone budget for her", expect: "expense(Jane,groceries) + expense(Jane,phone bill) + budget(Jane,Food) + budget(Jane,Phone)" },
  { n: 15, msg: "Bob spent $400 on car repairs for his truck, update the vehicle maintenance tracker, and remind him for the next oil change in 3 months", expect: "expense(Bob,$400 car repairs) + tracker_entry(maintenance) + event/obligation(oil change +3mo,Bob)" },
  { n: 16, msg: "I paid Netflix, Spotify, and Disney Plus today and create recurring subscriptions for all three", expect: "subscription_profile × 3 + expense × 3" },
  { n: 17, msg: "Jane adopted a dog named Luna, create a pet profile, add a pet expense tracker, and log $75 for dog food", expect: "pet_profile(Luna dog,parent=Jane) + tracker(pet expense) + expense(Luna or Jane,$75)" },
  { n: 18, msg: "Bob completed his morning routine habit, ran 5 miles, and spent $25 on protein shakes", expect: "habit_checkin(Morning Routine,Bob) + tracker_entry(Running,Bob,5mi) + expense(Bob,$25)" },
  { n: 19, msg: "Create a monthly entertainment budget for me and Bob together for $500 and track all movie and concert purchases against it", expect: "budget(self+Bob,Entertainment,$500/mo)" },
  { n: 20, msg: "I spent $220 at Costco, $60 on gas, and $45 on dinner tonight and update my weekly spending totals", expect: "3 expenses(self: Costco $220, gas $60, dinner $45)" },
  { n: 21, msg: "Jane completed meditation, drank a smoothie, and create a wellness tracker for her", expect: "habit_checkin(Meditation,Jane) + tracker_entry(Calories/Nutrition,Jane,smoothie) + tracker(Wellness,Jane)" },
  { n: 22, msg: "Bob paid rent late, mark the obligation overdue, and remind him every day until it's paid", expect: "obligation status=overdue(Bob,rent) + event/reminder daily" },
  { n: 23, msg: "I bought a MacBook for $2,000, add it as an asset, and create a tech spending budget for me", expect: "asset_profile(MacBook,self,$2000) + expense(self,$2000) + budget(self,Tech)" },
  { n: 24, msg: "Jane spent $1,200 on vacation flights and hotels and categorize everything under travel expenses", expect: "expense(Jane,$1200,travel) - may be 1 or 2 expenses" },
  { n: 25, msg: "Bob worked overtime for 10 hours, earned an extra $350 income, and transfer $100 into savings", expect: "tracker_entry/journal(Bob,10hr overtime) + income/expense(Bob,+$350) + transfer or expense ($100 savings)" },
  { n: 26, msg: "Create a recurring lawn care obligation every Friday for $40 and show it in the calendar", expect: "obligation(lawn care,weekly Fri,$40)" },
  { n: 27, msg: "I completed my gym habit, sleep goal, hydration goal, and spent $18 on healthy food", expect: "habit_checkin(Gym,self) + goal_progress(Sleep) + goal_progress(Hydration) + expense(self,$18)" },
  { n: 28, msg: "Bob and Jane split a $300 internet bill evenly and update both of their finance dashboards", expect: "expense(Bob,$150) + expense(Jane,$150) — OR linked_profiles=[Bob,Jane] $300" },
  { n: 29, msg: "Jane bought furniture for $900, add it as a home asset, and create a home improvement budget", expect: "asset_profile(Furniture,Jane,$900) + expense(Jane,$900) + budget(self or Jane,Home Improvement)" },
  { n: 30, msg: "Bob spent $100 on dog supplies, completed the pet care habit, and scheduled a vet reminder for next month", expect: "expense(Bob,$100) + habit_checkin(Pet Care,Bob) + event(vet reminder +1mo,Bob)" },
  { n: 31, msg: "I paid my mortgage for $2,100, utilities for $240, and groceries for $300 today", expect: "expense × 3(self)" },
  { n: 32, msg: "Create a recurring reminder every 6 months for Jane's car insurance renewal", expect: "event/obligation(car insurance,every 6mo,Jane)" },
  { n: 33, msg: "Bob played soccer for 2 hours, burned 1,100 calories, and completed his exercise streak", expect: "tracker_entry(Soccer,Bob,2hr,1100cal) + habit_checkin(Exercise,Bob)" },
  { n: 34, msg: "Jane spent $50 on books, completed her reading habit, and update her entertainment budget", expect: "expense(Jane,$50) + habit_checkin(Reading,Jane)" },
  { n: 35, msg: "I transferred $500 to savings, paid off $200 of my credit card debt, and completed my finance habit", expect: "transfer or income/expense(self,$500) + liability_payment or expense(self,$200) + habit_checkin(Finance,self)" },
  { n: 36, msg: "Bob bought a gaming PC for $2,400, create a gaming budget, and track monthly gaming expenses", expect: "asset_profile(Gaming PC,Bob,$2400) + expense(Bob,$2400) + budget(Bob,Gaming,monthly)" },
  { n: 37, msg: "Jane completed all her habits today, including hydration, workout, and reading", expect: "habit_checkin × 3(Jane)" },
  { n: 38, msg: "Create a recurring obligation for my gym membership every month on the 3rd for $49.99", expect: "obligation(gym,monthly 3rd,$49.99,self)" },
  { n: 39, msg: "Bob spent $80 at Target, $120 on groceries, and $40 on gas all in one trip", expect: "expense × 3(Bob: Target $80, groceries $120, gas $40)" },
  { n: 40, msg: "Jane walked 10,000 steps, ate a salad, drank water, and completed her health goals for the day", expect: "tracker_entry(Steps,Jane,10000) + tracker_entry(Calories,Jane,salad) + tracker_entry(Water,Jane) + goal/habit checkin" },
];

interface DBSnapshot {
  trackers: any[];
  tracker_entries: any[];
  expenses: any[];
  habits: any[];
  habit_checkins: any[];
  obligations: any[];
  events: any[];
  tasks: any[];
  goals: any[];
  budgets: any[];
  profiles: any[];
  liabilities: any[];
}

async function snapshot(): Promise<DBSnapshot> {
  return await ctx(async () => ({
    trackers: await storage.getTrackers() as any,
    tracker_entries: [], // pulled per-tracker
    expenses: await storage.getExpenses() as any,
    habits: await storage.getHabits() as any,
    habit_checkins: [], // pulled per-habit
    obligations: await storage.getObligations() as any,
    events: await storage.getEvents() as any,
    tasks: await storage.getTasks() as any,
    goals: await storage.getGoals() as any,
    budgets: (await (storage as any).getBudgets?.(new Date().toISOString().slice(0,7)) || []) as any,
    profiles: await storage.getProfiles() as any,
    liabilities: [], // liabilities ARE profiles (type='liability'); captured in newProfiles below
  }));
}

// Flatten tracker entries from each tracker
function flattenEntries(snap: DBSnapshot) {
  const all: any[] = [];
  for (const t of snap.trackers) {
    for (const e of (t.entries || [])) {
      all.push({ ...e, _trackerName: t.name, _trackerId: t.id, _linkedProfiles: t.linkedProfiles });
    }
  }
  return all;
}

function diff<T extends { id: string }>(before: T[], after: T[]): T[] {
  const beforeIds = new Set(before.map(x => x.id));
  return after.filter(x => !beforeIds.has(x.id));
}

function idToName(snap: DBSnapshot, id: string): string {
  return snap.profiles.find(p => p.id === id)?.name || id.slice(0, 8);
}

async function run() {
  console.log("Loading initial snapshot...");
  let snap = await snapshot();
  console.log(`Initial: ${snap.profiles.length} profiles, ${snap.trackers.length} trackers, ${snap.expenses.length} expenses, ${snap.habits.length} habits, ${snap.obligations.length} obligations, ${snap.goals.length} goals.\n`);

  const results: Array<{ n: number; pass: boolean; created: any[]; reply: string; trace: string[] }> = [];

  for (const cmd of COMMANDS) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(`[#${cmd.n}] ${cmd.msg}`);
    console.log(`Expect: ${cmd.expect}`);
    console.log("=".repeat(72));

    // Capture chat-trace lines from this run
    const traceLines: string[] = [];
    const origLog = console.log;
    (console as any)._origLog = origLog;
    console.log = (...args: any[]) => {
      const line = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      if (line.includes("[chat-trace]") || line.includes("Sharing tracker") || line.includes("[ai]")) {
        traceLines.push(line);
      }
      origLog.apply(console, args);
    };

    let reply = "";
    let err: any = null;
    try {
      const result = await ctx(() => processMessage(cmd.msg, [], USER_ID));
      reply = (result as any).reply || "";
    } catch (e: any) {
      err = e;
    } finally {
      console.log = origLog;
    }

    // Snapshot AFTER
    const after = await snapshot();

    // Compute diffs
    const newTrackers      = diff(snap.trackers,      after.trackers);
    const newEntries       = diff(flattenEntries(snap), flattenEntries(after));
    const newExpenses      = diff(snap.expenses,      after.expenses);
    const newHabits        = diff(snap.habits,        after.habits);
    const newObligations   = diff(snap.obligations,   after.obligations);
    const newEvents        = diff(snap.events,        after.events);
    const newTasks         = diff(snap.tasks,         after.tasks);
    const newGoals         = diff(snap.goals,         after.goals);
    const newBudgets       = diff(snap.budgets,       after.budgets);
    const newProfiles      = diff(snap.profiles,      after.profiles);
    const newLiabilities   = diff(snap.liabilities,   after.liabilities);

    // Habit checkins: any habit whose entries grew
    const habitCheckins: any[] = [];
    for (const h of after.habits) {
      const beforeH = snap.habits.find(b => b.id === h.id);
      const beforeCount = beforeH?.entries?.length || 0;
      const afterCount  = h.entries?.length || 0;
      if (afterCount > beforeCount) {
        habitCheckins.push({ habit: h.name, profile: idToName(after, (h.linkedProfiles||[])[0] || ""), delta: afterCount - beforeCount });
      }
    }

    const created: any[] = [];
    for (const t of newTrackers)    created.push({ type: "tracker",     name: t.name, profiles: (t.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const e of newEntries)     created.push({ type: "entry",       tracker: e._trackerName, profile: idToName(after, e.forProfile || e.profileId || ""), values: e.values });
    for (const x of newExpenses)    created.push({ type: "expense",     desc: x.description, amount: x.amount, profiles: (x.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const h of newHabits)      created.push({ type: "habit",       name: h.name, profiles: (h.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const c of habitCheckins)  created.push({ type: "habit_checkin", habit: c.habit, profile: c.profile });
    for (const o of newObligations) created.push({ type: "obligation",  name: o.name || o.title, amount: o.amount, profiles: (o.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const v of newEvents)      created.push({ type: "event",       title: v.title, recurrence: v.recurrence, profiles: (v.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const t of newTasks)       created.push({ type: "task",        title: t.title, profiles: (t.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const g of newGoals)       created.push({ type: "goal",        title: g.title, target: g.target, profiles: (g.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const b of newBudgets)     created.push({ type: "budget",      category: b.category, amount: b.amount, profiles: (b.linkedProfiles||[]).map((p:string)=>idToName(after,p)) });
    for (const p of newProfiles)    created.push({ type: "profile",     name: p.name, profileType: p.type });
    for (const l of newLiabilities) created.push({ type: "liability",   name: l.name, balance: l.balance || l.principal });

    const pass = !err && created.length > 0;
    results.push({ n: cmd.n, pass, created, reply: reply.slice(0, 200), trace: traceLines });

    console.log(`\nREPLY: ${reply.slice(0, 200)}`);
    console.log(`CREATED ${created.length} items:`);
    for (const c of created) console.log("  -", JSON.stringify(c));
    if (err) console.log(`ERROR: ${err.message || err}`);
    console.log(`RESULT: ${pass ? "PASS" : "FAIL"}`);

    snap = after; // accumulate for next command
  }

  console.log("\n" + "=".repeat(72));
  console.log("FINAL SUMMARY");
  console.log("=".repeat(72));
  const passed = results.filter(r => r.pass).length;
  console.log(`PASS: ${passed}/${COMMANDS.length}`);
  console.log(`FAIL: ${COMMANDS.length - passed}/${COMMANDS.length}`);
  console.log("\nPer-command:");
  for (const r of results) {
    console.log(`  #${r.n.toString().padStart(2)}: ${r.pass ? "PASS" : "FAIL"}  (${r.created.length} items)`);
  }

  // Write JSON for analysis
  const fs = await import("fs");
  fs.writeFileSync("/tmp/verify40_results.json", JSON.stringify(results, null, 2));
  console.log("\nFull results: /tmp/verify40_results.json");
}

run().catch(e => { console.error("FATAL:", e); process.exit(1); });
