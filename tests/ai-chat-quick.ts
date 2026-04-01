/**
 * AI Chat Quick Test — runs tests sequentially with timeout handling
 * Tests against live portol.me
 */

const API_BASE = "https://portol.me/api";
const TEST_EMAIL = "tron@aol.com";
const TEST_PASSWORD = "password";

let authToken = "";
const results: { cat: string; test: string; pass: boolean; detail: string }[] = [];

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const data = await res.json();
  if (!data.session?.access_token) throw new Error("Login failed");
  return data.session.access_token;
}

async function chat(message: string, timeoutMs = 30000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ message, history: [] }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { reply: "__TIMEOUT__", actions: [] };
    throw err;
  }
}

function rc(r: any, ...kw: string[]) {
  const reply = (r.reply || "").toLowerCase();
  return kw.some(k => reply.includes(k.toLowerCase()));
}
function ha(r: any, t: string) {
  return (r.actions || []).some((a: any) => a.type === t);
}

function record(cat: string, test: string, pass: boolean, detail: string) {
  results.push({ cat, test, pass, detail });
  console.log(`  ${pass ? "✅" : "❌"} ${test}: ${detail.substring(0, 120)}`);
}

async function runTest(cat: string, test: string, msg: string, check: (r: any) => boolean) {
  try {
    const r = await chat(msg);
    if (r.reply === "__TIMEOUT__") {
      record(cat, test, false, "TIMEOUT after 30s");
      return r;
    }
    const pass = check(r);
    record(cat, test, pass, r.reply?.substring(0, 150) || "No reply");
    return r;
  } catch (err: any) {
    record(cat, test, false, `ERROR: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log("════════════════════════════════════════════════════════");
  console.log("  PORTOL AI CHAT — FEATURE TEST SUITE");
  console.log("════════════════════════════════════════════════════════");
  
  authToken = await login();
  console.log("  🔑 Logged in\n");

  // ── 1. SEARCH ──────────────────────────────────────────────
  console.log("🔍 SEARCH");
  await runTest("Search", "General search", "Search for all my tasks",
    r => rc(r, "task") || ha(r, "search") || ha(r, "retrieve"));
  await runTest("Search", "Profile-scoped", "What does Mom have?",
    r => rc(r, "mom") && r.reply.length > 50);
  await runTest("Search", "Summary stats", "How many profiles do I have?",
    r => rc(r, "profile") && /\d+/.test(r.reply));

  // ── 2. PROFILE CRUD ────────────────────────────────────────
  console.log("\n👤 PROFILE CRUD");
  await runTest("Profile", "Create", "Create a profile for my dog named TestBuddy, golden retriever, 65 lbs, born 2020-03-15",
    r => ha(r, "create") || rc(r, "created", "testbuddy", "buddy"));
  await runTest("Profile", "Update", "Update TestBuddy's weight to 70 lbs",
    r => ha(r, "update") || rc(r, "updated", "70"));
  await runTest("Profile", "Get data", "Show me everything about TestBuddy",
    r => rc(r, "testbuddy", "buddy", "golden", "retriever", "70"));
  await runTest("Profile", "Delete", "Delete the TestBuddy profile",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 3. TASK CRUD ───────────────────────────────────────────
  console.log("\n📋 TASK CRUD");
  await runTest("Task", "Create", "Add a task: Buy test groceries, high priority, due tomorrow",
    r => ha(r, "create") || rc(r, "created", "added", "groceries"));
  await runTest("Task", "Update", "Change the test groceries task to medium priority",
    r => ha(r, "update") || rc(r, "updated", "medium"));
  await runTest("Task", "Complete", "Mark the test groceries task as done",
    r => ha(r, "update") || ha(r, "complete") || rc(r, "completed", "done", "marked"));
  await runTest("Task", "Delete", "Delete the test groceries task",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 4. TRACKER ─────────────────────────────────────────────
  console.log("\n📊 TRACKER");
  await runTest("Tracker", "Create", "Create a water intake tracker with a glasses field",
    r => ha(r, "create") || rc(r, "created", "water", "tracker"));
  await runTest("Tracker", "Log entry", "Log 8 glasses of water for my water tracker",
    r => ha(r, "create") || ha(r, "log") || rc(r, "logged", "recorded", "8", "water"));
  await runTest("Tracker", "Delete", "Delete the water intake tracker",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 5. EXPENSE CRUD ────────────────────────────────────────
  console.log("\n💰 EXPENSE");
  await runTest("Expense", "Create", "I spent $45.50 at TestMart on groceries today",
    r => ha(r, "create") || rc(r, "logged", "recorded", "45", "testmart"));
  await runTest("Expense", "Update", "Change the TestMart expense to $47.50",
    r => ha(r, "update") || rc(r, "updated", "47"));
  await runTest("Expense", "Delete", "Delete the TestMart expense",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 6. EVENT CRUD ──────────────────────────────────────────
  console.log("\n📅 EVENT");
  await runTest("Event", "Create", "Schedule a test dentist appointment on April 15th at 2pm",
    r => ha(r, "create") || rc(r, "created", "scheduled", "dentist"));
  await runTest("Event", "Update", "Move the test dentist appointment to 3pm",
    r => ha(r, "update") || rc(r, "updated", "moved", "3"));
  await runTest("Event", "Delete", "Cancel the test dentist appointment",
    r => ha(r, "delete") || rc(r, "deleted", "cancelled", "canceled", "removed"));

  // ── 7. HABIT CRUD ──────────────────────────────────────────
  console.log("\n🔥 HABIT");
  await runTest("Habit", "Create", "Create a habit to do test pushups every day",
    r => ha(r, "create") || rc(r, "created", "pushup", "habit"));
  await runTest("Habit", "Check in", "I did my test pushups today, check it off",
    r => ha(r, "checkin") || ha(r, "update") || rc(r, "checked", "done", "pushup"));
  await runTest("Habit", "Delete", "Delete the test pushups habit",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 8. OBLIGATION CRUD ─────────────────────────────────────
  console.log("\n📑 OBLIGATION");
  await runTest("Obligation", "Create", "Add a monthly bill: TestFlix for $15.99 autopay on, due April 1st",
    r => ha(r, "create") || rc(r, "created", "added", "testflix"));
  await runTest("Obligation", "Pay", "I paid the TestFlix bill",
    r => ha(r, "pay") || ha(r, "update") || rc(r, "paid", "payment", "recorded"));
  await runTest("Obligation", "Delete", "Delete the TestFlix obligation",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 9. JOURNAL ─────────────────────────────────────────────
  console.log("\n📓 JOURNAL");
  await runTest("Journal", "Create entry", "Journal: feeling amazing today, energy 5, grateful for health",
    r => ha(r, "create") || rc(r, "journal", "saved", "recorded", "entry", "amazing"));
  await runTest("Journal", "Delete entry", "Delete today's journal entry",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 10. GOAL CRUD ──────────────────────────────────────────
  console.log("\n🎯 GOAL");
  await runTest("Goal", "Create", "I want to lose 15 pounds by June 30th, I currently weigh 185",
    r => ha(r, "create") || rc(r, "goal", "created", "15", "weight"));
  await runTest("Goal", "Check progress", "How am I doing on my goals?",
    r => rc(r, "goal", "progress", "weight", "pound") || ha(r, "retrieve"));
  await runTest("Goal", "Delete", "Delete my weight loss goal",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 11. MEMORY ─────────────────────────────────────────────
  console.log("\n🧠 MEMORY");
  await runTest("Memory", "Save", "Remember that my test favorite color is midnight blue",
    r => ha(r, "create") || rc(r, "remember", "saved", "noted", "got it", "midnight"));
  await runTest("Memory", "Recall", "What's my test favorite color?",
    r => rc(r, "midnight blue", "blue"));
  await runTest("Memory", "Delete", "Forget my test favorite color",
    r => ha(r, "delete") || rc(r, "forgot", "removed", "deleted", "cleared"));

  // ── 12. ARTIFACT ───────────────────────────────────────────
  console.log("\n📝 ARTIFACT");
  await runTest("Artifact", "Create checklist", "Create a test packing checklist: passport, sunscreen, charger",
    r => ha(r, "create") || rc(r, "checklist", "created", "packing"));
  await runTest("Artifact", "Create note", "Create a note titled 'Test Meeting Notes' with content: discussed targets",
    r => ha(r, "create") || rc(r, "note", "created", "meeting"));
  await runTest("Artifact", "Delete checklist", "Delete the test packing checklist",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));
  await runTest("Artifact", "Delete note", "Delete the Test Meeting Notes note",
    r => ha(r, "delete") || rc(r, "deleted", "removed"));

  // ── 13. DOCUMENT ───────────────────────────────────────────
  console.log("\n📄 DOCUMENT");
  await runTest("Document", "Open (fast-path)", "Open my drivers license",
    r => r.documentPreview || r.documentPreviews || rc(r, "license", "driver", "here"));
  await runTest("Document", "Create", "Create a document called 'AI Test Doc' with content: This is from chat",
    r => ha(r, "create") || rc(r, "created", "document"));

  // ── 14. NAVIGATION ─────────────────────────────────────────
  console.log("\n🧭 NAVIGATION");
  await runTest("Navigation", "Go to dashboard", "Go to the dashboard",
    r => ha(r, "navigate") || rc(r, "dashboard", "navigat"));
  await runTest("Navigation", "Show profiles", "Show me my profiles page",
    r => ha(r, "navigate") || rc(r, "profile", "navigat"));

  // ── 15. ENTITY LINKS ───────────────────────────────────────
  console.log("\n🔗 ENTITY LINKS");
  await runTest("EntityLinks", "Get related", "What's related to Mom?",
    r => rc(r, "mom") && r.reply.length > 50);

  // ── 16. MULTI-INTENT ───────────────────────────────────────
  console.log("\n🔀 MULTI-INTENT");
  const r16 = await runTest("MultiIntent", "Two actions", "I ran 3 miles today and also spent $12 on a smoothie at TestJuice",
    r => (r.actions || []).length >= 2 || (rc(r, "mile", "run", "3") && rc(r, "12", "smoothie")));
  // cleanup
  if (r16) await chat("Delete the TestJuice expense").catch(() => {});

  // ── 17. FAST-PATH ──────────────────────────────────────────
  console.log("\n⚡ FAST-PATH");
  await runTest("FastPath", "Food log", "ate a test chicken sandwich, 450 calories, 35g protein",
    r => rc(r, "logged", "chicken", "450", "calorie") || ha(r, "create") || ha(r, "log"));
  await runTest("FastPath", "Weight log", "weight 182 lbs",
    r => rc(r, "logged", "182", "weight") || ha(r, "create") || ha(r, "log"));
  await runTest("FastPath", "Blood pressure", "BP 120/80",
    r => rc(r, "logged", "blood pressure", "120", "80") || ha(r, "create") || ha(r, "log"));

  // ── 18. CALENDAR SYNC ──────────────────────────────────────
  console.log("\n🔄 CALENDAR SYNC");
  await runTest("CalendarSync", "Sync", "Sync my Google Calendar",
    r => rc(r, "sync", "calendar", "google", "import", "events"));

  // ── 19. RECALL ACTIONS ─────────────────────────────────────
  console.log("\n🕐 RECALL ACTIONS");
  await runTest("RecallActions", "Recent actions", "What did I just do? Show recent actions",
    r => rc(r, "action", "recent", "created", "logged", "deleted", "here"));

  // ════════════════════════════════════════════════════════════
  // SUMMARY
  // ════════════════════════════════════════════════════════════
  console.log("\n════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("════════════════════════════════════════════════════════\n");

  const cats = [...new Set(results.map(r => r.cat))];
  let tp = 0, tf = 0;
  for (const c of cats) {
    const cr = results.filter(r => r.cat === c);
    const p = cr.filter(r => r.pass).length;
    const f = cr.filter(r => !r.pass).length;
    tp += p; tf += f;
    console.log(`  ${f === 0 ? "✅" : "⚠️"} ${c}: ${p}/${cr.length}`);
    for (const r of cr.filter(r => !r.pass)) {
      console.log(`     ❌ ${r.test}: ${r.detail.substring(0, 100)}`);
    }
  }
  console.log(`\n  TOTAL: ${tp}/${tp+tf} passed, ${tf} failed`);
  console.log("════════════════════════════════════════════════════════\n");

  // Write results file
  require("fs").writeFileSync("/home/user/workspace/lifeos/tests/ai-chat-results.json",
    JSON.stringify(results, null, 2));
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
