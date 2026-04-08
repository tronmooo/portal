/**
 * 100 Complex Query Validation Tests
 * Tests all major features of the Portol AI chat engine with complex, real-world queries
 * Run with: npx tsx tests/100-query-validation.ts
 */

const API = 'https://portol.me/api';
let token = '';
const PREFIX = 'QV100_';

// ── Auth ─────────────────────────────────────────────────────────────────────
async function login() {
  const r = await fetch(`${API}/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tron@aol.com', password: 'password' }),
  });
  const d = await r.json();
  if (!d.session?.access_token) throw new Error('Login failed: ' + JSON.stringify(d));
  token = d.session.access_token;
  console.log('  Authenticated as tron@aol.com');
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function chat(msg: string, history: any[] = []): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 90000);
  try {
    const r = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: msg, history }),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { reply: `HTTP_${r.status}`, actions: [] };
    return await r.json();
  } catch (e: any) {
    clearTimeout(t);
    return { reply: e.name === 'AbortError' ? '__TIMEOUT__' : `__ERR__:${e.message}`, actions: [] };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function rc(r: any, ...kw: string[]): boolean {
  const reply = (r.reply || '').toLowerCase();
  return kw.some(k => reply.includes(k.toLowerCase()));
}
function ha(r: any, t: string): boolean {
  return (r.actions || []).some((a: any) => a.type === t);
}
function hac(r: any, c: string): boolean {
  return (r.actions || []).some((a: any) => a.category === c);
}
function isOk(r: any): boolean {
  const reply = r.reply || '';
  return !reply.startsWith('HTTP_') && reply !== '__TIMEOUT__' && !reply.startsWith('__ERR__');
}

// ── Result tracking ──────────────────────────────────────────────────────────
interface Result { id: number; cat: string; name: string; msg: string; pass: boolean; detail: string; }
const results: Result[] = [];
let testId = 0;

function record(cat: string, name: string, msg: string, pass: boolean, r: any) {
  testId++;
  const detail = pass ? (r.reply || '').substring(0, 120) : (r.reply || 'No reply').substring(0, 120);
  results.push({ id: testId, cat, name, msg, pass, detail });
  console.log(`  ${pass ? '' : ''} [${testId}/100] ${cat} — ${name}`);
  if (!pass) console.log(`    Reply: ${detail}`);
}

// ============================================================
// SECTION 1: SEARCH & RETRIEVAL (Q1-Q5)
// ============================================================
async function runSection1() {
  console.log("\n--- SECTION 1: Search & Retrieval ---");

  // Q1: Full dashboard summary
  let r = await chat("Give me a full summary of everything I have tracked: profiles, tasks, expenses, habits, and goals");
  record("Search", "Q1: Full dashboard summary", "Give me a full summary...", isOk(r) && rc(r, "profile", "task", "expense"), r);

  // Q2: Monthly expense search
  r = await chat("Show me all expenses I logged this month");
  record("Search", "Q2: Monthly expense search", "Show all expenses this month", isOk(r) && rc(r, "expense", "spend", "month", "this month", "no expenses", "none"), r);

  // Q3: Cross-entity upcoming events
  r = await chat("What tasks and events do I have coming up this week?");
  record("Search", "Q3: Upcoming tasks + events", "Tasks and events this week", isOk(r) && rc(r, "task", "event", "week", "upcoming", "schedule", "nothing", "none"), r);

  // Q4: Recall recent actions
  r = await chat("What did I log most recently?");
  record("Search", "Q4: Recall recent actions", "What did I log most recently?", isOk(r) && r.reply.length > 30, r);

  // Q5: Spending category breakdown
  r = await chat("How much have I spent on food vs transport vs health this month?");
  record("Search", "Q5: Category spending breakdown", "Food vs transport vs health spending", isOk(r) && rc(r, "food", "transport", "health", "spent", "$", "no expenses", "none"), r);
}

// ============================================================
// SECTION 2: PROFILES (Q6-Q15)
// ============================================================
async function runSection2() {
  console.log("\n--- SECTION 2: Profiles ---");
  const P = "QV100_";

  // Q6: Create person with rich details
  let r = await chat("Create a profile for my brother named " + P + "Marcus. Born 1990-07-04, lives in Austin TX, phone 512-555-0188, nut allergy");
  record("Profile", "Q6: Create person with full details", "...create Marcus...", ha(r, "create") || rc(r, "created", "marcus"), r);

  // Q7: Create pet profile
  r = await chat("Add a pet profile for my cat named " + P + "Luna. She is a 3-year-old orange tabby, indoor-only, spayed, microchipped");
  record("Profile", "Q7: Create pet with details", "...create Luna cat...", ha(r, "create") || rc(r, "created", "luna"), r);

  // Q8: Create vehicle profile
  r = await chat("Create a vehicle profile for my " + P + "HondaCivic: 2019 Honda Civic, silver, VIN 1HGBH41JXMN109186, plate ABC123");
  record("Profile", "Q8: Create vehicle with VIN/plate", "...create Honda Civic...", ha(r, "create") || rc(r, "created", "honda", "civic", "vehicle"), r);

  // Q9: Create subscription profile
  r = await chat("Add a subscription profile called " + P + "AdobePlan for Adobe Creative Cloud at 4.99 per month");
  record("Profile", "Q9: Create subscription profile", "...create AdobePlan...", ha(r, "create") || rc(r, "created", "adobe"), r);

  // Q10: Update person phone + employer
  r = await chat("Update " + P + "Marcus phone number to 512-555-9999 and note he works at Dell Technologies");
  record("Profile", "Q10: Update person details", "...update Marcus...", ha(r, "update") || rc(r, "updated", "marcus", "512", "dell"), r);

  // Q11: Update pet medical info
  r = await chat(P + "Luna is due for her rabies vaccine. Add that to her medical notes and update her weight to 9.5 lbs");
  record("Profile", "Q11: Update pet medical + weight", "...update Luna medical...", ha(r, "update") || rc(r, "updated", "luna", "vaccine", "rabies"), r);

  // Q12: Get full profile data
  r = await chat("Show me everything you have on " + P + "Marcus");
  record("Profile", "Q12: Get full profile data", "...show everything on Marcus...", isOk(r) && rc(r, "marcus"), r);

  // Q13: Get pet info
  r = await chat("What info do I have saved for " + P + "Luna?");
  record("Profile", "Q13: Get pet profile info", "...what info for Luna?...", isOk(r) && rc(r, "luna"), r);

  // Q14: Delete vehicle
  r = await chat("Delete the " + P + "HondaCivic vehicle profile");
  record("Profile", "Q14: Delete vehicle profile", "...delete HondaCivic...", ha(r, "delete") || rc(r, "deleted", "removed"), r);

  // Q15: Delete remaining profiles
  r = await chat("Delete both the " + P + "Marcus and " + P + "Luna profiles");
  record("Profile", "Q15: Delete multiple profiles", "...delete Marcus and Luna...", ha(r, "delete") || rc(r, "deleted", "removed"), r);
}

// ============================================================
// SECTION 3: TASKS (Q16-Q23)
// ============================================================
async function runSection3() {
  console.log("\n--- SECTION 3: Tasks ---");
  const P = "QV100_";

  // Q16: Create task with all metadata
  let r = await chat("Create task: " + P + "CallInsurance — call State Farm about my claim, high priority, due this Friday");
  record("Task", "Q16: Create task with priority+due", "...create CallInsurance task...", ha(r, "create") || rc(r, "created", "added", "task", "insurance"), r);

  // Q17: Create a low-priority task
  r = await chat("Add a low priority task: " + P + "OrganizeGarage — sort out boxes in the garage, no deadline");
  record("Task", "Q17: Create low-priority task no due", "...add OrganizeGarage task...", ha(r, "create") || rc(r, "created", "added", "garage"), r);

  // Q18: List all open tasks
  r = await chat("Show me all my open tasks");
  record("Task", "Q18: List all open tasks", "Show all open tasks", isOk(r) && rc(r, "task", "open", "pending", "no tasks", "nothing"), r);

  // Q19: Update task priority
  r = await chat("Change the " + P + "OrganizeGarage task to high priority and set it due next Monday");
  record("Task", "Q19: Update priority and due date", "...update OrganizeGarage priority+due...", ha(r, "update") || rc(r, "updated", "changed", "garage", "high"), r);

  // Q20: Complete a task
  r = await chat("Mark the " + P + "CallInsurance task as complete");
  record("Task", "Q20: Complete task", "...complete CallInsurance...", ha(r, "update") || ha(r, "complete") || rc(r, "completed", "done", "marked"), r);

  // Q21: Create task linked to a profile
  r = await chat("Add a task for Mom: " + P + "MomDoctorAppt — schedule her annual checkup, high priority, due by end of month");
  record("Task", "Q21: Create profile-linked task", "...create task for Mom...", ha(r, "create") || rc(r, "created", "added", "mom", "doctor"), r);

  // Q22: Update task title
  r = await chat("Rename the " + P + "MomDoctorAppt task to " + P + "MomCheckup");
  record("Task", "Q22: Rename task", "...rename MomDoctorAppt...", ha(r, "update") || rc(r, "updated", "renamed", "checkup"), r);

  // Q23: Delete tasks
  r = await chat("Delete the " + P + "OrganizeGarage, " + P + "CallInsurance, and " + P + "MomCheckup tasks");
  record("Task", "Q23: Delete multiple tasks", "...delete 3 tasks...", ha(r, "delete") || rc(r, "deleted", "removed"), r);
}

// ============================================================
// SECTION 4: EXPENSES & FINANCE (Q24-Q33)
// ============================================================
async function runSection4() {
  console.log("\n--- SECTION 4: Expenses & Finance ---");
  const P = "QV100_";

  // Q24: Create expense with note
  let r = await chat("I spent 27.43 at " + P + "WholeFoods on groceries — organic chicken, vegetables, and some snacks");
  record("Expense", "Q24: Create detailed grocery expense", "...27 at WholeFoods...", ha(r, "create") || rc(r, "logged", "recorded", "127", "groceries"), r);

  // Q25: Create transport expense
  r = await chat("Filled up gas at " + P + "Chevron, spent 8.20");
  record("Expense", "Q25: Create transport/gas expense", "...8 gas at Chevron...", ha(r, "create") || rc(r, "logged", "recorded", "68", "gas", "transport"), r);

  // Q26: Create medical expense
  r = await chat("Paid 50 copay at " + P + "CityClinic for my annual physical");
  record("Expense", "Q26: Create medical expense", "...50 medical copay...", ha(r, "create") || rc(r, "logged", "recorded", "250", "health", "medical", "clinic"), r);

  // Q27: Create entertainment expense
  r = await chat("Bought concert tickets for 89 — " + P + "ConcertTickets");
  record("Expense", "Q27: Create entertainment expense", "...89 concert tickets...", ha(r, "create") || rc(r, "logged", "recorded", "189", "entertainment", "concert"), r);

  // Q28: Correct an expense amount
  r = await chat("Actually the " + P + "WholeFoods expense was 32.15, not 27.43 — I forgot to include the cheese");
  record("Expense", "Q28: Correct expense amount", "...correct WholeFoods to 32...", ha(r, "update") || rc(r, "updated", "changed", "132"), r);

  // Q29: Add a budget
  r = await chat("Set a monthly budget of 00 for food");
  record("Expense", "Q29: Set food budget", "Set 00/month food budget", ha(r, "create") || ha(r, "update") || rc(r, "budget", "400", "food"), r);

  // Q30: Check budget status
  r = await chat("How am I doing against my food budget this month?");
  record("Expense", "Q30: Check budget vs actual", "Check food budget status", isOk(r) && rc(r, "budget", "food", "spent", "$", "remaining", "over"), r);

  // Q31: Create income entry
  r = await chat("I received my paycheck today — ,240 net from " + P + "Employer");
  record("Expense", "Q31: Log income", "...log paycheck 240...", ha(r, "create") || rc(r, "logged", "recorded", "income", "3240", "3,240"), r);

  // Q32: Delete food budget
  r = await chat("Remove the food monthly budget");
  record("Expense", "Q32: Delete budget", "Remove food budget", ha(r, "delete") || rc(r, "deleted", "removed", "budget"), r);

  // Q33: Delete expenses
  r = await chat("Delete the " + P + "WholeFoods, " + P + "Chevron, " + P + "CityClinic, and " + P + "ConcertTickets expenses");
  record("Expense", "Q33: Delete multiple expenses", "...delete 4 expenses...", ha(r, "delete") || rc(r, "deleted", "removed"), r);
}

// ============================================================
// SECTION 5: TRACKERS & HEALTH (Q34-Q43)
// ============================================================
async function runSection5() {
  console.log("\n--- SECTION 5: Trackers & Health ---");
  const P = "QV100_";

  // Q34: Log weight (fast-path)
  let r = await chat("weight 178 lbs");
  record("Tracker", "Q34: Log weight fast-path", "weight 178 lbs", isOk(r) && rc(r, "weight", "logged", "178", "recorded"), r);

  // Q35: Log blood pressure (fast-path)
  r = await chat("bp 118/76");
  record("Tracker", "Q35: Log blood pressure fast-path", "bp 118/76", isOk(r) && rc(r, "blood pressure", "logged", "118", "76", "recorded"), r);

  // Q36: Log a run
  r = await chat("I ran 4.5 miles this morning in 42 minutes");
  record("Tracker", "Q36: Log running entry", "Ran 4.5 miles in 42 min", isOk(r) && rc(r, "run", "logged", "4.5", "miles", "recorded"), r);

  // Q37: Log sleep
  r = await chat("I slept 7.5 hours last night");
  record("Tracker", "Q37: Log sleep hours", "Slept 7.5 hours", isOk(r) && rc(r, "sleep", "logged", "7.5", "recorded", "hour"), r);

  // Q38: Create custom tracker
  r = await chat("Create a tracker called " + P + "ColdShower with a field for duration in minutes and a mood field");
  record("Tracker", "Q38: Create custom tracker", "...create ColdShower tracker...", ha(r, "create") || rc(r, "created", "tracker", "shower"), r);

  // Q39: Log entry to custom tracker
  r = await chat("Log a " + P + "ColdShower: duration 3 minutes, mood refreshed");
  record("Tracker", "Q39: Log to custom tracker", "...log ColdShower entry...", isOk(r) && rc(r, "logged", "recorded", "shower", "3"), r);

  // Q40: Log calories eaten
  r = await chat("I ate a grilled salmon with rice and broccoli for dinner, about 650 calories");
  record("Tracker", "Q40: Log calorie intake", "...log 650 cal dinner...", isOk(r) && rc(r, "calorie", "logged", "650", "recorded", "nutrition", "food"), r);

  // Q41: Log mood
  r = await chat("mood: feeling anxious and stressed today, 4/10");
  record("Tracker", "Q41: Log mood entry", "mood: anxious, 4/10", isOk(r) && rc(r, "mood", "logged", "recorded", "anxious", "journal"), r);

  // Q42: Log strength workout
  r = await chat("Logged a gym session: 45 minutes of weightlifting, burned about 320 calories");
  record("Tracker", "Q42: Log gym/strength workout", "...gym 45min 320cal...", isOk(r) && rc(r, "gym", "logged", "workout", "weight", "recorded", "45"), r);

  // Q43: Delete custom tracker
  r = await chat("Delete the " + P + "ColdShower tracker");
  record("Tracker", "Q43: Delete custom tracker", "...delete ColdShower tracker...", ha(r, "delete") || rc(r, "deleted", "removed", "shower"), r);
}

// ============================================================
// SECTION 6: EVENTS & CALENDAR (Q44-Q51)
// ============================================================
async function runSection6() {
  console.log("\n--- SECTION 6: Events & Calendar ---");
  const P = "QV100_";

  // Q44: Create appointment
  let r = await chat("Schedule a dentist appointment called " + P + "DentistClean on May 10th at 10am");
  record("Event", "Q44: Create appointment event", "...dentist May 10 10am...", ha(r, "create") || rc(r, "created", "scheduled", "dentist", "may"), r);

  // Q45: Create recurring weekly event
  r = await chat("Add a recurring event: " + P + "TeamStandup — every Monday at 9am, starts next Monday");
  record("Event", "Q45: Create recurring weekly event", "...weekly standup Monday 9am...", ha(r, "create") || rc(r, "created", "scheduled", "standup", "monday", "recurring", "weekly"), r);

  // Q46: Create all-day event
  r = await chat("Add an all-day event on April 20th: " + P + "EarthDay");
  record("Event", "Q46: Create all-day event", "...all-day EarthDay April 20...", ha(r, "create") || rc(r, "created", "scheduled", "earth", "april", "all-day", "all day"), r);

  // Q47: Create event with location
  r = await chat("Schedule " + P + "LunchMeeting on Thursday at noon at The Capital Grille");
  record("Event", "Q47: Create event with location", "...lunch meeting with location...", ha(r, "create") || rc(r, "created", "scheduled", "lunch", "capital", "thursday"), r);

  // Q48: Update event time
  r = await chat("Move the " + P + "DentistClean appointment to 11am instead of 10am");
  record("Event", "Q48: Update event time", "...reschedule dentist to 11am...", ha(r, "update") || rc(r, "updated", "moved", "rescheduled", "11"), r);

  // Q49: Update event date
  r = await chat("Reschedule " + P + "LunchMeeting to next Friday instead");
  record("Event", "Q49: Update event date", "...reschedule lunch to Friday...", ha(r, "update") || rc(r, "updated", "moved", "rescheduled", "friday"), r);

  // Q50: Show upcoming events
  r = await chat("What events do I have in the next 2 weeks?");
  record("Event", "Q50: List upcoming events", "Events in next 2 weeks", isOk(r) && rc(r, "event", "schedule", "appointment", "upcoming", "week", "no events", "nothing"), r);

  // Q51: Delete events
  r = await chat("Cancel the " + P + "DentistClean, " + P + "EarthDay, and " + P + "LunchMeeting events");
  record("Event", "Q51: Delete multiple events", "...cancel 3 events...", ha(r, "delete") || rc(r, "deleted", "cancelled", "canceled", "removed"), r);
}

// ============================================================
// SECTION 7: HABITS (Q52-Q59)
// ============================================================
async function runSection7() {
  console.log("\n--- SECTION 7: Habits ---");
  const P = "QV100_";

  // Q52: Create daily habit
  let r = await chat("Create a daily habit called " + P + "MorningPages — write 3 pages in my journal every morning");
  record("Habit", "Q52: Create daily habit with desc", "...create MorningPages daily habit...", ha(r, "create") || rc(r, "created", "habit", "morning", "pages"), r);

  // Q53: Create weekly habit
  r = await chat("Add a habit called " + P + "WeeklyReview — review my goals and tasks every Sunday");
  record("Habit", "Q53: Create weekly habit", "...create WeeklyReview habit...", ha(r, "create") || rc(r, "created", "habit", "weekly", "review", "sunday"), r);

  // Q54: Create 3x/week habit
  r = await chat("Create a habit: " + P + "LiftWeights — go to the gym 3 times a week");
  record("Habit", "Q54: Create 3x/week habit", "...create LiftWeights 3x/week...", ha(r, "create") || rc(r, "created", "habit", "gym", "3", "weight"), r);

  // Q55: Check in daily habit
  r = await chat("I did my " + P + "MorningPages today");
  record("Habit", "Q55: Check in daily habit", "...check in MorningPages...", ha(r, "checkin") || ha(r, "update") || rc(r, "checked", "logged", "done", "morning", "pages"), r);

  // Q56: Check in gym habit
  r = await chat("Went to the gym today, checking off " + P + "LiftWeights");
  record("Habit", "Q56: Check in gym habit", "...check in LiftWeights...", ha(r, "checkin") || ha(r, "update") || rc(r, "checked", "logged", "done", "gym", "weight"), r);

  // Q57: Show habit streaks
  r = await chat("Show me my current habit streaks");
  record("Habit", "Q57: View habit streaks", "Show habit streaks", isOk(r) && rc(r, "habit", "streak", "day", "no habits", "nothing"), r);

  // Q58: Update habit frequency
  r = await chat("Change the " + P + "WeeklyReview habit to every Saturday instead of Sunday");
  record("Habit", "Q58: Update habit frequency/day", "...change WeeklyReview to Saturday...", ha(r, "update") || rc(r, "updated", "changed", "saturday", "review"), r);

  // Q59: Delete habits
  r = await chat("Delete the " + P + "MorningPages, " + P + "WeeklyReview, and " + P + "LiftWeights habits");
  record("Habit", "Q59: Delete multiple habits", "...delete 3 habits...", ha(r, "delete") || rc(r, "deleted", "removed"), r);
}

// ============================================================
// SECTION 8: OBLIGATIONS / BILLS (Q60-Q66)
// ============================================================
async function runSection8() {
  console.log("\n--- SECTION 8: Obligations & Bills ---");
  const P = "QV100_";

  // Q60: Create monthly subscription
  let r = await chat("Add a monthly bill: " + P + "SpotifyBill — Spotify Premium at 1.99/month, autopay on the 3rd");
  record("Obligation", "Q60: Create subscription obligation", "...Spotify 1.99/month...", ha(r, "create") || rc(r, "created", "added", "spotify", "11"), r);

  // Q61: Create rent obligation
  r = await chat("Set up a recurring obligation: " + P + "RentPayment — ,850 rent every month due on the 1st");
  record("Obligation", "Q61: Create rent obligation", "...rent 850/month...", ha(r, "create") || rc(r, "created", "added", "rent", "1850", "1,850"), r);

  // Q62: Create insurance obligation
  r = await chat("Add " + P + "CarInsurance — pay 42/month car insurance, due on the 15th, 6-month term");
  record("Obligation", "Q62: Create insurance obligation", "...car insurance 42/month...", ha(r, "create") || rc(r, "created", "added", "insurance", "142"), r);

  // Q63: Pay an obligation
  r = await chat("I paid the " + P + "SpotifyBill");
  record("Obligation", "Q63: Record obligation payment", "...paid Spotify...", ha(r, "pay") || ha(r, "update") || rc(r, "paid", "payment", "recorded", "spotify"), r);

  // Q64: Update obligation amount
  r = await chat(P + "SpotifyBill went up to 2.99 per month");
  record("Obligation", "Q64: Update obligation price", "...Spotify price increase to 2.99...", ha(r, "update") || rc(r, "updated", "changed", "12.99", "spotify"), r);

  // Q65: List all bills
  r = await chat("Show me all my recurring bills and what I owe");
  record("Obligation", "Q65: List all obligations", "Show all recurring bills", isOk(r) && rc(r, "bill", "obligation", "month", "pay", "$", "no bills", "nothing"), r);

  // Q66: Delete obligations
  r = await chat("Delete the " + P + "SpotifyBill, " + P + "RentPayment, and " + P + "CarInsurance obligations");
  record("Obligation", "Q66: Delete multiple obligations", "...delete 3 obligations...", ha(r, "delete") || rc(r, "deleted", "removed", "cancelled"), r);
}

// ============================================================
// SECTION 9: GOALS (Q67-Q72)
// ============================================================
async function runSection9() {
  console.log("\n--- SECTION 9: Goals ---");
  const P = "QV100_";

  // Q67: Create weight loss goal
  let r = await chat("I want to lose 20 lbs by December 31st. My current weight is 195 lbs. Create a goal called " + P + "WeightGoal");
  record("Goal", "Q67: Create weight loss goal", "...lose 20 lbs by Dec 31...", ha(r, "create") || rc(r, "goal", "created", "weight", "20"), r);

  // Q68: Create savings goal
  r = await chat("Create a savings goal: " + P + "EmergencyFund — save 0,000 in my emergency fund by next March");
  record("Goal", "Q68: Create savings goal", "...save 0k by March...", ha(r, "create") || rc(r, "goal", "created", "save", "10000", "10,000"), r);

  // Q69: Create fitness goal
  r = await chat("Set a goal called " + P + "RunGoal — run 100 miles total this year");
  record("Goal", "Q69: Create fitness distance goal", "...run 100 miles this year...", ha(r, "create") || rc(r, "goal", "created", "run", "100", "miles"), r);

  // Q70: Check goal progress
  r = await chat("How am I tracking against my " + P + "WeightGoal?");
  record("Goal", "Q70: Check specific goal progress", "...check WeightGoal progress...", isOk(r) && rc(r, "goal", "progress", "weight", "lbs", "pound"), r);

  // Q71: Update goal target
  r = await chat("Update my " + P + "EmergencyFund goal — I already have ,500 saved, update my progress");
  record("Goal", "Q71: Update goal progress", "...update EmergencyFund 500 progress...", ha(r, "update") || rc(r, "updated", "progress", "2500", "2,500"), r);

  // Q72: Delete goals
  r = await chat("Delete the " + P + "WeightGoal, " + P + "EmergencyFund, and " + P + "RunGoal goals");
  record("Goal", "Q72: Delete multiple goals", "...delete 3 goals...", ha(r, "delete") || rc(r, "deleted", "removed"), r);
}

// ============================================================
// SECTION 10: JOURNAL & MEMORY (Q73-Q78)
// ============================================================
async function runSection10() {
  console.log("\n--- SECTION 10: Journal & Memory ---");
  const P = "QV100_";

  // Q73: Rich journal entry
  let r = await chat("Journal entry: Today was a big day. I closed a major deal at work, finally got to the gym after skipping for a week, and had a long call with my mom. Energy level 8/10. Grateful for momentum.");
  record("Journal", "Q73: Create rich journal entry", "...rich journal entry...", ha(r, "create") || rc(r, "journal", "saved", "recorded", "entry"), r);

  // Q74: Mood-only journal
  r = await chat("Feeling overwhelmed today. Too much on my plate and not enough hours. Mood 3/10.");
  record("Journal", "Q74: Mood-focused journal entry", "...mood 3/10 overwhelmed...", isOk(r) && rc(r, "journal", "mood", "saved", "logged", "recorded", "noted"), r);

  // Q75: Save a complex memory
  r = await chat("Remember that my car registration expires in October, my gym membership renews in February, and I'm lactose intolerant");
  record("Memory", "Q75: Save multiple facts", "...remember car reg, gym, lactose...", ha(r, "create") || rc(r, "remember", "saved", "noted", "got it", "memory"), r);

  // Q76: Recall specific memory
  r = await chat("Do I have any food restrictions or allergies you know about?");
  record("Memory", "Q76: Recall dietary memory", "...recall food restrictions...", isOk(r) && rc(r, "lactose", "allerg", "intolerant", "food", "restriction"), r);

  // Q77: Recall financial memory
  r = await chat("When does my gym membership renew?");
  record("Memory", "Q77: Recall subscription memory", "...recall gym renewal...", isOk(r) && rc(r, "gym", "february", "renew", "membership"), r);

  // Q78: Delete a memory
  r = await chat("Forget that I mentioned anything about my car registration or gym membership");
  record("Memory", "Q78: Forget specific memories", "...forget car reg and gym...", ha(r, "delete") || rc(r, "forgot", "removed", "deleted", "cleared", "erased"), r);
}

// ============================================================
// SECTION 11: ARTIFACTS / CHECKLISTS (Q79-Q83)
// ============================================================
async function runSection11() {
  console.log("\n--- SECTION 11: Artifacts ---");
  const P = "QV100_";

  // Q79: Create packing checklist
  let r = await chat("Create a packing checklist called " + P + "TravelPack: passport, headphones, laptop charger, travel adapter, sunscreen, medication");
  record("Artifact", "Q79: Create detailed checklist", "...travel packing checklist...", ha(r, "create") || rc(r, "checklist", "created", "list", "passport"), r);

  // Q80: Create shopping list
  r = await chat("Make a grocery shopping list called " + P + "GroceryRun: milk, eggs, bread, olive oil, pasta, garlic, chicken thighs, spinach");
  record("Artifact", "Q80: Create grocery list", "...grocery shopping list...", ha(r, "create") || rc(r, "list", "created", "grocery", "milk", "eggs"), r);

  // Q81: Add item to existing checklist
  r = await chat("Add hand sanitizer and a portable power bank to my " + P + "TravelPack list");
  record("Artifact", "Q81: Add items to checklist", "...add items to TravelPack...", ha(r, "update") || ha(r, "create") || rc(r, "added", "updated", "sanitizer", "power"), r);

  // Q82: Create a note artifact
  r = await chat("Create a note called " + P + "WorkNote: Quarterly goals: grow revenue 15%, hire 2 engineers, ship v2 product before September");
  record("Artifact", "Q82: Create note artifact", "...create work goals note...", ha(r, "create") || rc(r, "note", "created", "saved"), r);

  // Q83: Delete artifacts
  r = await chat("Delete the " + P + "TravelPack, " + P + "GroceryRun, and " + P + "WorkNote lists");
  record("Artifact", "Q83: Delete multiple artifacts", "...delete 3 artifacts...", ha(r, "delete") || rc(r, "deleted", "removed"), r);
}

// ============================================================
// SECTION 12: MULTI-INTENT QUERIES (Q84-Q91)
// ============================================================
async function runSection12() {
  console.log("\n--- SECTION 12: Multi-Intent ---");
  const P = "QV100_";

  // Q84: Create expense + task in one message
  let r = await chat("I spent 6.80 at " + P + "HomeDepot on hardware supplies, and add a task to pick up the receipt before Friday");
  record("Multi", "Q84: Expense + task in one message", "...HomeDepot expense + task...", isOk(r) && (r.actions || []).length >= 1, r);

  // Q85: Log run + expense
  r = await chat("Ran 3 miles this morning and grabbed a smoothie for .50 at " + P + "JuiceBar after");
  record("Multi", "Q85: Tracker entry + expense", "...run 3mi + .50 smoothie...", isOk(r) && rc(r, "run", "smoothie", "logged", "recorded", "3", "8"), r);

  // Q86: Log weight + create goal
  r = await chat("I weighed 182 lbs today, and I want to hit 170 lbs by the end of August — create a goal called " + P + "SummerCut");
  record("Multi", "Q86: Weight log + goal creation", "...182 lbs + SummerCut goal...", isOk(r) && rc(r, "weight", "goal", "182", "170", "logged", "created"), r);

  // Q87: Event + obligation in one message
  r = await chat("Schedule a " + P + "HOAMeeting on the 25th at 7pm, and also set up a monthly obligation for " + P + "HOAFees at 85/month");
  record("Multi", "Q87: Event + obligation creation", "...HOA meeting + HOA fee obligation...", isOk(r) && (r.actions || []).length >= 1, r);

  // Q88: Profile create + link task
  r = await chat("Add a profile for my accountant named " + P + "AccountantBob, phone 800-555-7777, and create a task to send him my tax docs by April 15");
  record("Multi", "Q88: Profile + linked task", "...create AccountantBob + tax task...", isOk(r) && rc(r, "profile", "task", "created", "added", "bob", "accountant"), r);

  // Q89: Journal + habit checkin
  r = await chat("Log a journal entry: had a great workout session today, feeling strong. Also mark my " + P + "LiftWeights habit as done if it exists");
  record("Multi", "Q89: Journal + habit check-in", "...journal + habit checkin...", isOk(r) && rc(r, "journal", "logged", "saved", "recorded", "workout"), r);

  // Q90: Multiple tracker entries
  r = await chat("Log these: slept 8 hours last night, drank 10 glasses of water, and my resting heart rate was 58 bpm");
  record("Multi", "Q90: Three tracker entries at once", "...sleep + water + heart rate...", isOk(r) && rc(r, "logged", "recorded", "sleep", "water", "heart", "8"), r);

  // Q91: Expense + budget check
  r = await chat("I spent 8 at " + P + "Whole Foods on groceries. How does that affect my food budget for the month?");
  record("Multi", "Q91: Expense + budget impact query", "...log expense + check budget...", isOk(r) && rc(r, "logged", "recorded", "budget", "food", "78", "spend"), r);
}

// ============================================================
// SECTION 13: COMPLEX / EDGE CASES (Q92-Q100)
// ============================================================
async function runSection13() {
  console.log("\n--- SECTION 13: Complex & Edge Cases ---");
  const P = "QV100_";

  // Q92: Ambiguous amount correction
  let r = await chat("Actually the last expense I logged — make it /bin/bash.99 more than what I entered");
  record("Edge", "Q92: Relative amount correction", "Adjust last expense +/bin/bash.99", isOk(r) && rc(r, "updated", "changed", "expense", "log", "0.99"), r);

  // Q93: Contextual follow-up
  const h = [{ role: "user", content: "Create a task: " + P + "ReviewLease — review my apartment lease renewal" }, { role: "assistant", content: "Done! I created the task QV100_ReviewLease for you." }];
  r = await chat("Actually change the priority to urgent and add a note: expires June 30", h);
  record("Edge", "Q93: Contextual follow-up with history", "...change prior task priority via history...", isOk(r) && rc(r, "updated", "changed", "priority", "urgent", "lease", "review"), r);

  // Q94: Query with no matching data
  r = await chat("Show me all expenses for my vacation to Hawaii last year");
  record("Edge", "Q94: Query with no matching results", "...expenses for Hawaii vacation...", isOk(r) && rc(r, "no", "not", "found", "result", "couldn", "hawaii", "expense"), r);

  // Q95: Implicit profile inference
  r = await chat("Schedule vet appointment for my dog on May 5th at 3pm");
  record("Edge", "Q95: Implicit profile inference (dog)", "...vet for dog May 5 3pm...", isOk(r) && rc(r, "created", "scheduled", "vet", "appointment", "dog", "may"), r);

  // Q96: Long natural language description to task
  r = await chat("I need to remember to follow up with the property manager about the water damage in my bathroom ceiling. It happened last Tuesday and they said they'd send someone by end of the week but nobody showed. High priority.");
  record("Edge", "Q96: Verbose → concise task creation", "...water damage follow-up task...", isOk(r) && rc(r, "task", "created", "added", "property", "water", "follow"), r);

  // Q97: Currency with special formatting
  r = await chat("Log an expense of ,299.00 for a new monitor from " + P + "BestBuy — category is tech/electronics");
  record("Edge", "Q97: Large formatted dollar amount", "...,299 monitor expense...", isOk(r) && rc(r, "logged", "recorded", "1299", "1,299", "monitor", "expense"), r);

  // Q98: Query about aggregate stats
  r = await chat("How many total tasks have I completed vs. how many are still open?");
  record("Edge", "Q98: Aggregate task count query", "...completed vs open task count...", isOk(r) && rc(r, "task", "completed", "open", "pending", "total"), r);

  // Q99: Profile-scoped expense query
  r = await chat("How much have I spent on my car this year?");
  record("Edge", "Q99: Profile-scoped yearly spending", "...spending on car this year...", isOk(r) && rc(r, "car", "vehicle", "spend", "expense", "year", "$", "no expenses"), r);

  // Q100: Complex multi-step planning query
  r = await chat("I want to run a half marathon in 3 months. Set up a running goal to cover 200 miles total by then, create a habit called " + P + "HalfMarathonTraining to run 4x per week, and add a task to buy new running shoes this week.");
  record("Edge", "Q100: Complex multi-step plan", "...half marathon: goal + habit + task...", isOk(r) && rc(r, "goal", "habit", "task", "run", "created", "marathon", "added"), r);

  // Cleanup temp items from edge cases
  await chat("Delete the " + P + "ReviewLease task if it exists");
  await chat("Delete the " + P + "HalfMarathonTraining habit if it exists");
  await chat("Delete the HOAMeeting event and HOAFees obligation if they exist");
  await chat("Delete the " + P + "AccountantBob profile if it exists");
  await chat("Delete the " + P + "SummerCut goal if it exists");
  await chat("Delete the " + P + "AdobePlan subscription profile if it exists");
}

// ============================================================
// MAIN — runs all sections sequentially
// ============================================================
async function main() {
  console.log("\n=== Portol 100 Query Validation Test ===\n");
  const start = Date.now();

  try {
    await login();
  } catch (e: any) {
    console.error("FATAL: Auth failed:", e.message);
    process.exit(1);
  }

  await runSection1();   // Q1-5:   Search & Retrieval
  await runSection2();   // Q6-15:  Profiles
  await runSection3();   // Q16-23: Tasks
  await runSection4();   // Q24-33: Expenses & Finance
  await runSection5();   // Q34-43: Trackers & Health
  await runSection6();   // Q44-51: Events & Calendar
  await runSection7();   // Q52-59: Habits
  await runSection8();   // Q60-66: Obligations
  await runSection9();   // Q67-72: Goals
  await runSection10();  // Q73-78: Journal & Memory
  await runSection11();  // Q79-83: Artifacts
  await runSection12();  // Q84-91: Multi-Intent
  await runSection13();  // Q92-100: Complex & Edge Cases

  // ── Summary ──────────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;
  const pct = ((passed / total) * 100).toFixed(1);

  console.log("\n" + "=".repeat(60));
  console.log("RESULTS: " + passed + "/" + total + " passed (" + pct + "%) in " + elapsed + "s");
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nFAILED TESTS:");
    results.filter(r => !r.pass).forEach(r => {
      console.log("  [" + r.id + "] " + r.cat + " - " + r.name);
      console.log("    Query: " + r.msg);
      console.log("    Reply: " + r.detail);
    });
  }

  // Category breakdown
  const cats = [...new Set(results.map(r => r.cat))];
  console.log("\nBy Category:");
  cats.forEach(cat => {
    const catResults = results.filter(r => r.cat === cat);
    const catPassed = catResults.filter(r => r.pass).length;
    const bar = catPassed === catResults.length ? "" : "";
    console.log("  " + bar + " " + cat + ": " + catPassed + "/" + catResults.length);
  });

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
