/**
 * Comprehensive AI Chat Feature Test Suite
 * Tests every tool/feature in the Portol AI chat engine
 * 
 * Runs against the LIVE Supabase API at portol.me
 */

const API_BASE = "https://portol.me/api";
const TEST_EMAIL = "tron@aol.com";
const TEST_PASSWORD = "password";

interface TestResult {
  category: string;
  test: string;
  input: string;
  passed: boolean;
  details: string;
  response?: any;
}

const results: TestResult[] = [];
let authToken: string = "";

// ── Auth helper ─────────────────────────────────────────────
async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const data = await res.json();
  if (!data.session?.access_token) throw new Error("Login failed: " + JSON.stringify(data));
  return data.session.access_token;
}

// ── Chat helper ─────────────────────────────────────────────
async function chat(message: string, history: any[] = []): Promise<any> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Upload helper (for doc extraction) ─────────────────────
async function upload(payload: any): Promise<any> {
  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Test runner ─────────────────────────────────────────────
function record(category: string, test: string, input: string, passed: boolean, details: string, response?: any) {
  results.push({ category, test, input, passed, details, response });
  const icon = passed ? "✅" : "❌";
  console.log(`  ${icon} ${test}: ${details}`);
}

function hasAction(response: any, type: string): boolean {
  return (response.actions || []).some((a: any) => a.type === type);
}

function hasActionCategory(response: any, category: string): boolean {
  return (response.actions || []).some((a: any) => a.category === category);
}

function replyContains(response: any, ...keywords: string[]): boolean {
  const reply = (response.reply || "").toLowerCase();
  return keywords.some(k => reply.includes(k.toLowerCase()));
}

// ── Cleanup helpers ─────────────────────────────────────────
async function deleteViaAPI(endpoint: string, id: string) {
  try {
    await fetch(`${API_BASE}/${endpoint}/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch {}
}

// ============================================================
// TEST SUITES
// ============================================================

async function testSearch() {
  console.log("\n🔍 SEARCH TESTS");
  
  // 1. General search
  const r1 = await chat("Search for all my tasks");
  record("Search", "General search", "Search for all my tasks", 
    replyContains(r1, "task") || hasAction(r1, "search") || hasAction(r1, "retrieve"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Profile-scoped search
  const r2 = await chat("What does Mom have?");
  record("Search", "Profile-scoped search", "What does Mom have?",
    replyContains(r2, "mom") && r2.reply.length > 50,
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Summary request
  const r3 = await chat("How many profiles do I have?");
  record("Search", "Summary stats", "How many profiles do I have?",
    replyContains(r3, "profile") && /\d+/.test(r3.reply),
    r3.reply?.substring(0, 150) || "No reply");
}

async function testProfileCRUD() {
  console.log("\n👤 PROFILE CRUD TESTS");
  
  // 1. Create profile
  const r1 = await chat("Create a profile for my dog named TestBuddy, he's a golden retriever, weighs 65 lbs, born on 2020-03-15");
  const created = hasAction(r1, "create") || replyContains(r1, "created", "added", "testbuddy", "buddy");
  record("Profile", "Create profile", "Create dog profile TestBuddy",
    created, r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Update profile
  const r2 = await chat("Update TestBuddy's weight to 70 lbs and add that he's neutered");
  record("Profile", "Update profile", "Update TestBuddy weight to 70 lbs",
    hasAction(r2, "update") || replyContains(r2, "updated", "changed", "70"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Get profile data
  const r3 = await chat("Show me everything about TestBuddy");
  record("Profile", "Get profile data", "Show me everything about TestBuddy",
    replyContains(r3, "testbuddy", "buddy", "golden", "retriever"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete profile
  const r4 = await chat("Delete the TestBuddy profile");
  record("Profile", "Delete profile", "Delete TestBuddy profile",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testTaskCRUD() {
  console.log("\n📋 TASK CRUD TESTS");
  
  // 1. Create task
  const r1 = await chat("Add a task: Buy groceries for dinner, high priority, due tomorrow");
  record("Task", "Create task", "Add task: Buy groceries",
    hasAction(r1, "create") || replyContains(r1, "created", "added", "groceries"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Update task
  const r2 = await chat("Change the groceries task to medium priority");
  record("Task", "Update task", "Change groceries to medium priority",
    hasAction(r2, "update") || replyContains(r2, "updated", "changed", "medium"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Complete task
  const r3 = await chat("Mark the groceries task as done");
  record("Task", "Complete task", "Mark groceries done",
    hasAction(r3, "update") || hasAction(r3, "complete") || replyContains(r3, "completed", "done", "marked"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete task
  const r4 = await chat("Delete the groceries task");
  record("Task", "Delete task", "Delete groceries task",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testTrackerCRUD() {
  console.log("\n📊 TRACKER CRUD TESTS");
  
  // 1. Create tracker
  const r1 = await chat("Create a water intake tracker with a field for glasses of water");
  record("Tracker", "Create tracker", "Create water intake tracker",
    hasAction(r1, "create") || replyContains(r1, "created", "tracker", "water"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Log entry
  const r2 = await chat("Log 8 glasses of water today");
  record("Tracker", "Log entry", "Log 8 glasses of water",
    hasAction(r2, "create") || hasAction(r2, "log") || replyContains(r2, "logged", "recorded", "8", "water"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Update tracker
  const r3 = await chat("Rename the water intake tracker to Daily Hydration");
  record("Tracker", "Update tracker", "Rename water tracker",
    hasAction(r3, "update") || replyContains(r3, "updated", "renamed", "hydration"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete tracker
  const r4 = await chat("Delete the Daily Hydration tracker");
  record("Tracker", "Delete tracker", "Delete hydration tracker",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testExpenseCRUD() {
  console.log("\n💰 EXPENSE CRUD TESTS");
  
  // 1. Create expense
  const r1 = await chat("I spent $45.50 at Trader Joe's on groceries today");
  record("Expense", "Create expense", "Spent $45.50 at Trader Joe's",
    hasAction(r1, "create") || replyContains(r1, "logged", "recorded", "45", "trader"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Update expense
  const r2 = await chat("Actually that Trader Joe's expense was $47.50, not $45.50");
  record("Expense", "Update expense", "Update TJ expense to $47.50",
    hasAction(r2, "update") || replyContains(r2, "updated", "changed", "47"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Delete expense
  const r3 = await chat("Delete the Trader Joe's expense");
  record("Expense", "Delete expense", "Delete TJ expense",
    hasAction(r3, "delete") || replyContains(r3, "deleted", "removed"),
    r3.reply?.substring(0, 150) || "No reply");
}

async function testEventCRUD() {
  console.log("\n📅 EVENT CRUD TESTS");
  
  // 1. Create event
  const r1 = await chat("Schedule a dentist appointment on April 15th at 2pm");
  record("Event", "Create event", "Dentist on April 15 at 2pm",
    hasAction(r1, "create") || replyContains(r1, "created", "scheduled", "dentist", "april"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Update event
  const r2 = await chat("Move the dentist appointment to 3pm");
  record("Event", "Update event", "Move dentist to 3pm",
    hasAction(r2, "update") || replyContains(r2, "updated", "moved", "3"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Delete event
  const r3 = await chat("Cancel the dentist appointment");
  record("Event", "Delete event", "Cancel dentist",
    hasAction(r3, "delete") || replyContains(r3, "deleted", "cancelled", "removed", "canceled"),
    r3.reply?.substring(0, 150) || "No reply");
}

async function testHabitCRUD() {
  console.log("\n🔥 HABIT CRUD TESTS");
  
  // 1. Create habit
  const r1 = await chat("Create a habit to meditate every day");
  record("Habit", "Create habit", "Create meditation habit",
    hasAction(r1, "create") || replyContains(r1, "created", "habit", "meditat"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Check in
  const r2 = await chat("I meditated today, check it off");
  record("Habit", "Check in habit", "Check in meditation",
    hasAction(r2, "checkin") || hasAction(r2, "update") || replyContains(r2, "checked", "logged", "done", "meditat"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Update habit
  const r3 = await chat("Change the meditation habit to weekly frequency");
  record("Habit", "Update habit", "Change meditation to weekly",
    hasAction(r3, "update") || replyContains(r3, "updated", "changed", "weekly"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete habit
  const r4 = await chat("Delete the meditation habit");
  record("Habit", "Delete habit", "Delete meditation habit",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testObligationCRUD() {
  console.log("\n📑 OBLIGATION CRUD TESTS");
  
  // 1. Create obligation
  const r1 = await chat("Add a monthly bill: Netflix for $15.99, autopay is on, next due April 1st");
  record("Obligation", "Create obligation", "Add Netflix bill",
    hasAction(r1, "create") || replyContains(r1, "created", "added", "netflix"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Pay obligation
  const r2 = await chat("I paid the Netflix bill");
  record("Obligation", "Pay obligation", "Pay Netflix bill",
    hasAction(r2, "pay") || hasAction(r2, "update") || replyContains(r2, "paid", "payment", "recorded", "netflix"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Update obligation
  const r3 = await chat("Netflix went up to $17.99 per month");
  record("Obligation", "Update obligation", "Update Netflix to $17.99",
    hasAction(r3, "update") || replyContains(r3, "updated", "changed", "17"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete obligation
  const r4 = await chat("Delete the Netflix obligation");
  record("Obligation", "Delete obligation", "Delete Netflix",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed", "cancelled"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testJournal() {
  console.log("\n📓 JOURNAL TESTS");
  
  // 1. Create journal entry
  const r1 = await chat("Journal entry: I'm feeling great today. Energy is high. Had a productive morning. Grateful for my health and family.");
  record("Journal", "Create journal entry", "Journal: feeling great, grateful for health",
    hasAction(r1, "create") || replyContains(r1, "journal", "saved", "recorded", "entry"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Update journal
  const r2 = await chat("Update today's journal entry to add that I also went for a walk");
  record("Journal", "Update journal", "Add walk to today's entry",
    hasAction(r2, "update") || replyContains(r2, "updated", "walk"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Delete journal
  const r3 = await chat("Delete today's journal entry");
  record("Journal", "Delete journal", "Delete today's entry",
    hasAction(r3, "delete") || replyContains(r3, "deleted", "removed"),
    r3.reply?.substring(0, 150) || "No reply");
}

async function testGoalCRUD() {
  console.log("\n🎯 GOAL CRUD TESTS");
  
  // 1. Create goal
  const r1 = await chat("I want to lose 15 pounds by June 30th. I currently weigh 185 lbs.");
  record("Goal", "Create goal", "Lose 15 lbs by June 30",
    hasAction(r1, "create") || replyContains(r1, "goal", "created", "15", "weight"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Check progress
  const r2 = await chat("How am I doing on my goals?");
  record("Goal", "Check goal progress", "Goal progress check",
    replyContains(r2, "goal", "progress", "weight") || hasAction(r2, "retrieve"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Update goal
  const r3 = await chat("Change my weight loss goal target to 20 pounds");
  record("Goal", "Update goal", "Change target to 20 lbs",
    hasAction(r3, "update") || replyContains(r3, "updated", "changed", "20"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete goal
  const r4 = await chat("Delete my weight loss goal");
  record("Goal", "Delete goal", "Delete weight goal",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testMemory() {
  console.log("\n🧠 MEMORY TESTS");
  
  // 1. Save memory
  const r1 = await chat("Remember that my favorite color is midnight blue and I'm allergic to shellfish");
  record("Memory", "Save memory", "Remember favorite color + allergy",
    hasAction(r1, "create") || replyContains(r1, "remember", "saved", "noted", "got it"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Recall memory
  const r2 = await chat("What's my favorite color?");
  record("Memory", "Recall memory", "What's my favorite color?",
    replyContains(r2, "midnight blue", "blue"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Delete memory
  const r3 = await chat("Forget my favorite color");
  record("Memory", "Delete memory", "Forget favorite color",
    hasAction(r3, "delete") || replyContains(r3, "forgot", "removed", "deleted", "cleared"),
    r3.reply?.substring(0, 150) || "No reply");
}

async function testArtifact() {
  console.log("\n📝 ARTIFACT TESTS");
  
  // 1. Create checklist
  const r1 = await chat("Create a packing checklist for vacation: passport, sunscreen, charger, swimsuit, book");
  record("Artifact", "Create checklist", "Create packing checklist",
    hasAction(r1, "create") || replyContains(r1, "checklist", "created", "packing"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Create note
  const r2 = await chat("Create a note titled 'Meeting Notes' with content: Discussed Q2 targets, action items pending");
  record("Artifact", "Create note", "Create meeting notes",
    hasAction(r2, "create") || replyContains(r2, "note", "created", "meeting"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Update artifact
  const r3 = await chat("Add 'medications' to my packing checklist");
  record("Artifact", "Update artifact", "Add item to checklist",
    hasAction(r3, "update") || replyContains(r3, "updated", "added", "medications"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Delete artifact
  const r4 = await chat("Delete the packing checklist");
  record("Artifact", "Delete artifact", "Delete packing checklist",
    hasAction(r4, "delete") || replyContains(r4, "deleted", "removed"),
    r4.reply?.substring(0, 150) || "No reply");
  
  // Cleanup meeting notes too
  const r5 = await chat("Delete the Meeting Notes note");
  record("Artifact", "Delete note", "Delete meeting notes",
    hasAction(r5, "delete") || replyContains(r5, "deleted", "removed"),
    r5.reply?.substring(0, 150) || "No reply");
}

async function testDocument() {
  console.log("\n📄 DOCUMENT TESTS");
  
  // 1. Open document (fast-path)
  const r1 = await chat("Open my drivers license");
  const hasDocPreview = r1.documentPreview || r1.documentPreviews;
  record("Document", "Open document (fast-path)", "Open my drivers license",
    hasDocPreview || replyContains(r1, "license", "driver", "here"),
    hasDocPreview ? "Document preview returned ✓" : (r1.reply?.substring(0, 150) || "No reply"));
  
  // 2. Create document
  const r2 = await chat("Create a document called 'Test Note' with content 'This is a test document from AI chat'");
  record("Document", "Create document", "Create Test Note document",
    hasAction(r2, "create") || replyContains(r2, "created", "document", "test note"),
    r2.reply?.substring(0, 150) || "No reply");
}

async function testNavigation() {
  console.log("\n🧭 NAVIGATION TESTS");
  
  const r1 = await chat("Go to the dashboard");
  record("Navigation", "Navigate to dashboard", "Go to dashboard",
    hasAction(r1, "navigate") || replyContains(r1, "dashboard", "navigat"),
    `Actions: ${JSON.stringify(r1.actions?.map((a: any) => a.type))} | ${r1.reply?.substring(0, 100)}`);
  
  const r2 = await chat("Show me my profiles");
  record("Navigation", "Navigate to profiles", "Show me profiles",
    hasAction(r2, "navigate") || replyContains(r2, "profile"),
    `Actions: ${JSON.stringify(r2.actions?.map((a: any) => a.type))} | ${r2.reply?.substring(0, 100)}`);
}

async function testEntityLinks() {
  console.log("\n🔗 ENTITY LINK TESTS");
  
  const r1 = await chat("What's related to Mom?");
  record("EntityLinks", "Get related entities", "What's related to Mom?",
    replyContains(r1, "mom") && r1.reply.length > 50,
    r1.reply?.substring(0, 150) || "No reply");
}

async function testMultiIntent() {
  console.log("\n🔀 MULTI-INTENT TESTS");
  
  // Multiple actions in one message
  const r1 = await chat("I ran 3 miles today and spent $12 on a smoothie at Jamba Juice");
  const hasMultiple = (r1.actions || []).length >= 2;
  record("MultiIntent", "Two actions in one message", "Ran 3 miles and spent $12 on smoothie",
    hasMultiple || (replyContains(r1, "run", "mile", "3") && replyContains(r1, "12", "smoothie", "jamba")),
    `Actions count: ${(r1.actions || []).length} | ${r1.reply?.substring(0, 150)}`);
  
  // Cleanup
  await chat("Delete the Jamba Juice expense");
}

async function testFastPath() {
  console.log("\n⚡ FAST-PATH TESTS");
  
  // 1. Quick food log
  const r1 = await chat("ate a chicken sandwich, 450 calories, 35g protein");
  record("FastPath", "Quick food log", "ate chicken sandwich 450cal 35g protein",
    replyContains(r1, "logged", "chicken", "450", "calorie") || hasAction(r1, "create") || hasAction(r1, "log"),
    r1.reply?.substring(0, 150) || "No reply");
  
  // 2. Quick weight log
  const r2 = await chat("weight 182 lbs");
  record("FastPath", "Quick weight log", "weight 182 lbs",
    replyContains(r2, "logged", "182", "weight") || hasAction(r2, "create") || hasAction(r2, "log"),
    r2.reply?.substring(0, 150) || "No reply");
  
  // 3. Quick mood
  const r3 = await chat("feeling great today");
  record("FastPath", "Quick mood log", "feeling great today",
    replyContains(r3, "journal", "mood", "great", "logged") || hasAction(r3, "create"),
    r3.reply?.substring(0, 150) || "No reply");
  
  // 4. Quick BP
  const r4 = await chat("BP 120/80");
  record("FastPath", "Quick blood pressure", "BP 120/80",
    replyContains(r4, "logged", "blood pressure", "120", "80") || hasAction(r4, "create") || hasAction(r4, "log"),
    r4.reply?.substring(0, 150) || "No reply");
}

async function testCalendarSync() {
  console.log("\n🔄 CALENDAR SYNC TEST");
  
  const r1 = await chat("Sync my Google Calendar");
  record("CalendarSync", "Sync Google Calendar", "Sync my Google Calendar",
    replyContains(r1, "sync", "calendar", "google", "import"),
    r1.reply?.substring(0, 150) || "No reply");
}

async function testRecallActions() {
  console.log("\n🕐 RECALL ACTIONS TEST");
  
  const r1 = await chat("What did I just do? Show my recent actions");
  record("RecallActions", "Recall recent actions", "Show recent actions",
    replyContains(r1, "action", "recent", "created", "logged", "deleted"),
    r1.reply?.substring(0, 150) || "No reply");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PORTOL AI CHAT — COMPREHENSIVE FEATURE TEST SUITE");
  console.log("═══════════════════════════════════════════════════════════");
  
  // Login
  console.log("\n🔑 Logging in...");
  authToken = await login();
  console.log(`  Token: ${authToken.substring(0, 20)}...`);
  
  // Run all test suites
  await testSearch();
  await testProfileCRUD();
  await testTaskCRUD();
  await testTrackerCRUD();
  await testExpenseCRUD();
  await testEventCRUD();
  await testHabitCRUD();
  await testObligationCRUD();
  await testJournal();
  await testGoalCRUD();
  await testMemory();
  await testArtifact();
  await testDocument();
  await testNavigation();
  await testEntityLinks();
  await testMultiIntent();
  await testFastPath();
  await testCalendarSync();
  await testRecallActions();
  
  // ── Summary ─────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  TEST RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════\n");
  
  const categories = [...new Set(results.map(r => r.category))];
  let totalPass = 0;
  let totalFail = 0;
  
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const passed = catResults.filter(r => r.passed).length;
    const failed = catResults.filter(r => !r.passed).length;
    totalPass += passed;
    totalFail += failed;
    const icon = failed === 0 ? "✅" : "⚠️";
    console.log(`  ${icon} ${cat}: ${passed}/${catResults.length} passed`);
    for (const r of catResults.filter(r => !r.passed)) {
      console.log(`     ❌ FAIL: ${r.test} — ${r.details.substring(0, 100)}`);
    }
  }
  
  console.log(`\n  TOTAL: ${totalPass}/${totalPass + totalFail} passed, ${totalFail} failed`);
  console.log("═══════════════════════════════════════════════════════════\n");
  
  // Write detailed results to file
  const report = results.map(r => 
    `[${r.passed ? "PASS" : "FAIL"}] ${r.category} > ${r.test}\n  Input: "${r.input}"\n  Details: ${r.details}\n`
  ).join("\n");
  
  const fs = require("fs");
  fs.writeFileSync("/home/user/workspace/lifeos/tests/ai-chat-results.txt", 
    `PORTOL AI CHAT TEST RESULTS — ${new Date().toISOString()}\n${"=".repeat(60)}\n\nTotal: ${totalPass}/${totalPass + totalFail} passed, ${totalFail} failed\n\n${report}`
  );
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
