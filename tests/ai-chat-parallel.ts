/**
 * AI Chat Parallel Test — runs independent tests concurrently
 * Groups sequential tests (create→update→delete) but runs groups in parallel
 */

const API_BASE = "https://portol.me/api";

let authToken = "";
const results: { cat: string; test: string; pass: boolean; detail: string; reply: string }[] = [];

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tron@aol.com", password: "password" }),
  });
  const data = await res.json();
  return data.session.access_token;
}

async function chat(message: string, timeout = 45000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ message, history: [] }),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return { reply: `HTTP_${res.status}`, actions: [] };
    return await res.json();
  } catch (e: any) {
    clearTimeout(t);
    return { reply: e.name === "AbortError" ? "__TIMEOUT__" : `__ERROR__: ${e.message}`, actions: [] };
  }
}

function rc(r: any, ...kw: string[]) { return kw.some(k => (r.reply||"").toLowerCase().includes(k.toLowerCase())); }
function ha(r: any, t: string) { return (r.actions||[]).some((a: any) => a.type === t); }

function rec(cat: string, test: string, pass: boolean, r: any) {
  const detail = r.reply === "__TIMEOUT__" ? "TIMEOUT" : (r.reply?.substring(0, 200) || "No reply");
  results.push({ cat, test, pass: r.reply === "__TIMEOUT__" ? false : pass, detail, reply: r.reply || "" });
}

// ── TEST GROUPS (each runs sequentially, groups run in parallel) ──

async function groupSearch() {
  const r1 = await chat("Search for all my tasks");
  rec("Search", "General search", rc(r1, "task") || ha(r1, "search") || ha(r1, "retrieve"), r1);

  const r2 = await chat("What does Mom have?");
  rec("Search", "Profile-scoped search", rc(r2, "mom") && r2.reply?.length > 50, r2);

  const r3 = await chat("How many profiles do I have?");
  rec("Search", "Summary stats", rc(r3, "profile") && /\d+/.test(r3.reply), r3);
}

async function groupProfile() {
  const r1 = await chat("Create a profile for my dog named ZTestDog, golden retriever, 65 lbs");
  rec("Profile", "Create", ha(r1, "create") || rc(r1, "created", "ztestdog", "dog"), r1);

  const r2 = await chat("Update ZTestDog's weight to 70 lbs");
  rec("Profile", "Update", ha(r2, "update") || rc(r2, "updated", "70"), r2);

  const r3 = await chat("Show me everything about ZTestDog");
  rec("Profile", "Get data", rc(r3, "ztestdog", "dog", "golden", "70"), r3);

  const r4 = await chat("Delete the ZTestDog profile");
  rec("Profile", "Delete", ha(r4, "delete") || rc(r4, "deleted", "removed"), r4);
}

async function groupTask() {
  const r1 = await chat("Add a task: ZTest buy groceries, high priority, due tomorrow");
  rec("Task", "Create", ha(r1, "create") || rc(r1, "created", "added", "ztest", "groceries"), r1);

  const r2 = await chat("Change the ZTest buy groceries task to medium priority");
  rec("Task", "Update", ha(r2, "update") || rc(r2, "updated", "medium"), r2);

  const r3 = await chat("Mark the ZTest buy groceries task as done");
  rec("Task", "Complete", ha(r3, "update") || ha(r3, "complete") || rc(r3, "completed", "done", "marked"), r3);

  const r4 = await chat("Delete the ZTest buy groceries task");
  rec("Task", "Delete", ha(r4, "delete") || rc(r4, "deleted", "removed"), r4);
}

async function groupTracker() {
  const r1 = await chat("Create a ZTest water intake tracker with a glasses_count number field");
  rec("Tracker", "Create", ha(r1, "create") || rc(r1, "created", "water", "tracker"), r1);

  const r2 = await chat("Log 8 glasses of water to the ZTest water tracker");
  rec("Tracker", "Log entry", ha(r2, "create") || ha(r2, "log") || rc(r2, "logged", "recorded", "8"), r2);

  const r3 = await chat("Delete the ZTest water intake tracker");
  rec("Tracker", "Delete", ha(r3, "delete") || rc(r3, "deleted", "removed"), r3);
}

async function groupExpense() {
  const r1 = await chat("I spent $45.50 at ZTestMart on groceries today");
  rec("Expense", "Create", ha(r1, "create") || rc(r1, "logged", "recorded", "45", "ztestmart"), r1);

  const r2 = await chat("Change the ZTestMart expense to $47.50");
  rec("Expense", "Update", ha(r2, "update") || rc(r2, "updated", "47"), r2);

  const r3 = await chat("Delete the ZTestMart expense");
  rec("Expense", "Delete", ha(r3, "delete") || rc(r3, "deleted", "removed"), r3);
}

async function groupEvent() {
  const r1 = await chat("Schedule a ZTest dentist appointment on April 20th at 2pm");
  rec("Event", "Create", ha(r1, "create") || rc(r1, "created", "scheduled", "dentist"), r1);

  const r2 = await chat("Move the ZTest dentist appointment to 3pm");
  rec("Event", "Update", ha(r2, "update") || rc(r2, "updated", "moved", "3"), r2);

  const r3 = await chat("Cancel the ZTest dentist appointment");
  rec("Event", "Delete", ha(r3, "delete") || rc(r3, "deleted", "cancelled", "canceled", "removed"), r3);
}

async function groupHabit() {
  const r1 = await chat("Create a habit to do ZTest pushups every day");
  rec("Habit", "Create", ha(r1, "create") || rc(r1, "created", "pushup", "habit"), r1);

  const r2 = await chat("I did my ZTest pushups today, check it off");
  rec("Habit", "Check in", ha(r2, "checkin") || ha(r2, "update") || rc(r2, "checked", "done", "pushup"), r2);

  const r3 = await chat("Delete the ZTest pushups habit");
  rec("Habit", "Delete", ha(r3, "delete") || rc(r3, "deleted", "removed"), r3);
}

async function groupObligation() {
  const r1 = await chat("Add a monthly bill: ZTestFlix for $15.99 autopay on, due April 1st");
  rec("Obligation", "Create", ha(r1, "create") || rc(r1, "created", "added", "ztestflix"), r1);

  const r2 = await chat("I paid the ZTestFlix bill");
  rec("Obligation", "Pay", ha(r2, "pay") || ha(r2, "update") || rc(r2, "paid", "payment", "recorded"), r2);

  const r3 = await chat("Delete the ZTestFlix obligation");
  rec("Obligation", "Delete", ha(r3, "delete") || rc(r3, "deleted", "removed"), r3);
}

async function groupJournal() {
  const r1 = await chat("Journal: feeling amazing today, energy 5, grateful for health and family");
  rec("Journal", "Create", ha(r1, "create") || rc(r1, "journal", "saved", "recorded", "entry", "amazing"), r1);

  const r2 = await chat("Delete today's journal entry");
  rec("Journal", "Delete", ha(r2, "delete") || rc(r2, "deleted", "removed"), r2);
}

async function groupGoal() {
  const r1 = await chat("I want to save $5000 by December 31st. Create a savings goal.");
  rec("Goal", "Create", ha(r1, "create") || rc(r1, "goal", "created", "5000", "saving"), r1);

  const r2 = await chat("How am I doing on my goals?");
  rec("Goal", "Check progress", rc(r2, "goal", "progress", "sav") || ha(r2, "retrieve"), r2);

  const r3 = await chat("Delete my savings goal");
  rec("Goal", "Delete", ha(r3, "delete") || rc(r3, "deleted", "removed"), r3);
}

async function groupMemory() {
  const r1 = await chat("Remember that my test favorite food is sushi and I prefer window seats");
  rec("Memory", "Save", ha(r1, "create") || rc(r1, "remember", "saved", "noted", "got it"), r1);

  const r2 = await chat("What's my test favorite food?");
  rec("Memory", "Recall", rc(r2, "sushi"), r2);

  const r3 = await chat("Forget my test favorite food");
  rec("Memory", "Delete", ha(r3, "delete") || rc(r3, "forgot", "removed", "deleted", "cleared"), r3);
}

async function groupArtifact() {
  const r1 = await chat("Create a ZTest packing checklist: passport, sunscreen, charger, swimsuit");
  rec("Artifact", "Create checklist", ha(r1, "create") || rc(r1, "checklist", "created", "packing"), r1);

  const r2 = await chat("Delete the ZTest packing checklist");
  rec("Artifact", "Delete", ha(r2, "delete") || rc(r2, "deleted", "removed"), r2);
}

async function groupDocument() {
  const r1 = await chat("Open my drivers license");
  rec("Document", "Open (fast-path)", (r1.documentPreview || r1.documentPreviews) ? true : rc(r1, "license", "driver", "here"), r1);

  const r2 = await chat("Create a document called 'ZTest AI Note' with content: This is from chat");
  rec("Document", "Create", ha(r2, "create") || rc(r2, "created", "document"), r2);
}

async function groupNavigation() {
  const r1 = await chat("Go to the dashboard");
  rec("Navigation", "Navigate", ha(r1, "navigate") || rc(r1, "dashboard"), r1);
}

async function groupFastPath() {
  const r1 = await chat("ate a test burrito, 650 calories, 30g protein");
  rec("FastPath", "Food log", rc(r1, "logged", "burrito", "650") || ha(r1, "create"), r1);

  const r2 = await chat("weight 183 lbs");
  rec("FastPath", "Weight log", rc(r2, "logged", "183", "weight") || ha(r2, "create"), r2);

  const r3 = await chat("BP 118/78");
  rec("FastPath", "Blood pressure", rc(r3, "logged", "118", "78", "blood") || ha(r3, "create"), r3);
}

async function groupMultiIntent() {
  const r1 = await chat("I ran 3 miles today and also spent $11 on a smoothie at ZTestJuice");
  const multiAction = (r1.actions || []).length >= 2;
  rec("MultiIntent", "Two actions", multiAction || (rc(r1, "mile", "run", "3") && rc(r1, "11", "smoothie")), r1);
  // cleanup
  await chat("Delete the ZTestJuice expense").catch(() => {});
}

async function groupCalendar() {
  const r1 = await chat("Sync my Google Calendar");
  rec("Calendar", "Sync", rc(r1, "sync", "calendar", "google", "import", "events"), r1);
}

async function groupRecall() {
  const r1 = await chat("What did I just do? Show my recent actions");
  rec("RecallActions", "Recent activity", rc(r1, "action", "recent", "created", "logged", "deleted", "here"), r1);
}

// ── MAIN ─────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PORTOL AI CHAT — PARALLEL FEATURE TEST SUITE");
  console.log("═══════════════════════════════════════════════════════════");

  authToken = await login();
  console.log("  🔑 Authenticated\n");

  // WAVE 1: Independent CRUD groups (all can run in parallel)
  console.log("── WAVE 1: CRUD Operations (parallel) ──────────────────\n");
  await Promise.all([
    groupSearch(),
    groupProfile(),
    groupTask(),
    groupTracker(),
    groupExpense(),
    groupEvent(),
    groupHabit(),
    groupObligation(),
    groupJournal(),
    groupGoal(),
    groupMemory(),
    groupArtifact(),
  ]);

  // WAVE 2: Features that may depend on wave 1 data
  console.log("\n── WAVE 2: Features & Edge Cases (parallel) ────────────\n");
  await Promise.all([
    groupDocument(),
    groupNavigation(),
    groupFastPath(),
    groupMultiIntent(),
    groupCalendar(),
    groupRecall(),
  ]);

  // ── SUMMARY ────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Sort by category
  const cats = [...new Set(results.map(r => r.cat))];
  let tp = 0, tf = 0;
  for (const c of cats) {
    const cr = results.filter(r => r.cat === c);
    const p = cr.filter(r => r.pass).length;
    const f = cr.filter(r => !r.pass).length;
    tp += p; tf += f;
    console.log(`  ${f === 0 ? "✅" : "⚠️"} ${c}: ${p}/${cr.length}`);
    for (const r of cr.filter(r => !r.pass)) {
      console.log(`     ❌ ${r.test}: ${r.detail.substring(0, 120)}`);
    }
  }
  console.log(`\n  TOTAL: ${tp}/${tp+tf} passed, ${tf} failed`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Save detailed results
  const fs = require("fs");
  fs.writeFileSync("/home/user/workspace/lifeos/tests/ai-chat-results.json", JSON.stringify(results, null, 2));
  
  // Also write human-readable report
  let report = `PORTOL AI CHAT TEST RESULTS\n${new Date().toISOString()}\n${"═".repeat(60)}\n\nTotal: ${tp}/${tp+tf} passed, ${tf} failed\n\n`;
  for (const r of results) {
    report += `[${r.pass ? "PASS" : "FAIL"}] ${r.cat} > ${r.test}\n`;
    report += `  Reply: ${r.reply?.substring(0, 200)}\n\n`;
  }
  fs.writeFileSync("/home/user/workspace/lifeos/tests/ai-chat-report.txt", report);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
