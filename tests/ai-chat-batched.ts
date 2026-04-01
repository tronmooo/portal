/**
 * AI Chat Batched Test — runs tests in small sequential batches
 * Each test gets 60s timeout, max 2 concurrent per batch
 */

import * as fs from "fs";

const API = "https://portol.me/api";
let token = "";

async function login() {
  const r = await fetch(`${API}/auth/signin`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "tron@aol.com", password: "password" }),
  });
  const d = await r.json();
  token = d.session.access_token;
}

async function chat(msg: string): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 60000);
  try {
    const r = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: msg, history: [] }),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { reply: `HTTP_ERR_${r.status}`, actions: [] };
    return await r.json();
  } catch (e: any) {
    clearTimeout(t);
    return { reply: e.name === "AbortError" ? "__TIMEOUT__" : `__ERR__:${e.message}`, actions: [] };
  }
}

function rc(r: any, ...kw: string[]) { return kw.some(k => (r.reply||"").toLowerCase().includes(k.toLowerCase())); }
function ha(r: any, t: string) { return (r.actions||[]).some((a: any) => a.type === t); }
function hd(r: any) { return !!(r.documentPreview || r.documentPreviews); }

interface Test { cat: string; name: string; msg: string; check: (r: any) => boolean; }
interface Result { cat: string; name: string; pass: boolean; detail: string; }

const testQueue: Test[][] = [
  // Batch 1: Search + Document fast-path (fast-path is instant)
  [
    { cat: "Search", name: "General search", msg: "Search for all my tasks", check: r => rc(r, "task") || ha(r, "search") || ha(r, "retrieve") },
    { cat: "Document", name: "Open (fast-path)", msg: "Open my drivers license", check: r => hd(r) || rc(r, "license", "driver", "here") },
  ],
  // Batch 2: Search continued
  [
    { cat: "Search", name: "Profile-scoped", msg: "What does Mom have?", check: r => rc(r, "mom") && r.reply?.length > 50 },
    { cat: "Search", name: "Summary stats", msg: "How many profiles do I have?", check: r => rc(r, "profile") && /\d+/.test(r.reply) },
  ],
  // Batch 3: Profile create + Task create
  [
    { cat: "Profile", name: "Create", msg: "Create a profile for my dog named ZZTestDog, golden retriever, 65 lbs", check: r => ha(r, "create") || rc(r, "created", "zztest", "dog") },
    { cat: "Task", name: "Create", msg: "Add a task: ZZTest buy groceries, high priority, due tomorrow", check: r => ha(r, "create") || rc(r, "created", "added", "zztest") },
  ],
  // Batch 4: Profile update + Task complete
  [
    { cat: "Profile", name: "Update", msg: "Update ZZTestDog's weight to 70 lbs", check: r => ha(r, "update") || rc(r, "updated", "70") },
    { cat: "Task", name: "Complete", msg: "Mark the ZZTest buy groceries task as done", check: r => ha(r, "update") || ha(r, "complete") || rc(r, "completed", "done") },
  ],
  // Batch 5: Profile delete + Task delete
  [
    { cat: "Profile", name: "Delete", msg: "Delete the ZZTestDog profile", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
    { cat: "Task", name: "Delete", msg: "Delete the ZZTest buy groceries task", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
  ],
  // Batch 6: Expense create + Event create
  [
    { cat: "Expense", name: "Create", msg: "I spent $45.50 at ZZTestStore on groceries today", check: r => ha(r, "create") || rc(r, "logged", "recorded", "45") },
    { cat: "Event", name: "Create", msg: "Schedule a ZZTest dentist on April 20th at 2pm", check: r => ha(r, "create") || rc(r, "created", "scheduled", "dentist") },
  ],
  // Batch 7: Expense delete + Event delete
  [
    { cat: "Expense", name: "Delete", msg: "Delete the ZZTestStore expense", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
    { cat: "Event", name: "Delete", msg: "Cancel the ZZTest dentist appointment", check: r => ha(r, "delete") || rc(r, "deleted", "cancelled", "canceled", "removed") },
  ],
  // Batch 8: Habit create + Obligation create
  [
    { cat: "Habit", name: "Create", msg: "Create a habit to do ZZTest pushups every day", check: r => ha(r, "create") || rc(r, "created", "pushup", "habit") },
    { cat: "Obligation", name: "Create", msg: "Add a monthly bill: ZZTestFlix for $15.99 autopay on, due April 1st", check: r => ha(r, "create") || rc(r, "created", "added", "zztestflix") },
  ],
  // Batch 9: Habit checkin + Obligation pay
  [
    { cat: "Habit", name: "Check in", msg: "I did my ZZTest pushups today", check: r => ha(r, "checkin") || ha(r, "update") || rc(r, "checked", "done", "pushup") },
    { cat: "Obligation", name: "Pay", msg: "I paid the ZZTestFlix bill", check: r => ha(r, "pay") || ha(r, "update") || rc(r, "paid", "payment") },
  ],
  // Batch 10: Habit delete + Obligation delete
  [
    { cat: "Habit", name: "Delete", msg: "Delete the ZZTest pushups habit", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
    { cat: "Obligation", name: "Delete", msg: "Delete the ZZTestFlix obligation", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
  ],
  // Batch 11: Journal + Goal create
  [
    { cat: "Journal", name: "Create", msg: "Journal: feeling amazing today, energy 5, grateful for health", check: r => ha(r, "create") || rc(r, "journal", "saved", "recorded", "entry") },
    { cat: "Goal", name: "Create", msg: "Create a savings goal: save $5000 by December 31st", check: r => ha(r, "create") || rc(r, "goal", "created", "5000", "saving") },
  ],
  // Batch 12: Journal delete + Goal check
  [
    { cat: "Journal", name: "Delete", msg: "Delete today's journal entry", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
    { cat: "Goal", name: "Check progress", msg: "How am I doing on my goals?", check: r => rc(r, "goal", "progress") || ha(r, "retrieve") },
  ],
  // Batch 13: Goal delete + Memory save
  [
    { cat: "Goal", name: "Delete", msg: "Delete my savings goal", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
    { cat: "Memory", name: "Save", msg: "Remember that my test favorite food is sushi", check: r => ha(r, "create") || rc(r, "remember", "saved", "noted", "got it") },
  ],
  // Batch 14: Memory recall + Artifact create
  [
    { cat: "Memory", name: "Recall", msg: "What's my test favorite food?", check: r => rc(r, "sushi") },
    { cat: "Artifact", name: "Create checklist", msg: "Create a ZZTest packing list: passport, sunscreen, charger", check: r => ha(r, "create") || rc(r, "checklist", "created", "packing") },
  ],
  // Batch 15: Memory delete + Artifact delete
  [
    { cat: "Memory", name: "Delete", msg: "Forget my test favorite food", check: r => ha(r, "delete") || rc(r, "forgot", "removed", "deleted", "cleared") },
    { cat: "Artifact", name: "Delete", msg: "Delete the ZZTest packing list", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
  ],
  // Batch 16: Tracker create + log
  [
    { cat: "Tracker", name: "Create", msg: "Create a ZZTest steps tracker with a steps number field", check: r => ha(r, "create") || rc(r, "created", "tracker", "step") },
  ],
  // Batch 17: Tracker log + delete
  [
    { cat: "Tracker", name: "Log entry", msg: "Log 10000 steps to the ZZTest steps tracker", check: r => ha(r, "create") || ha(r, "log") || rc(r, "logged", "recorded", "10000") },
  ],
  [
    { cat: "Tracker", name: "Delete", msg: "Delete the ZZTest steps tracker", check: r => ha(r, "delete") || rc(r, "deleted", "removed") },
  ],
  // Batch 18: Navigation + Fast-path
  [
    { cat: "Navigation", name: "Go to dashboard", msg: "Go to the dashboard", check: r => ha(r, "navigate") || rc(r, "dashboard") },
    { cat: "FastPath", name: "Weight log", msg: "weight 183 lbs", check: r => rc(r, "logged", "183", "weight") || ha(r, "create") },
  ],
  // Batch 19: More fast-path
  [
    { cat: "FastPath", name: "Blood pressure", msg: "BP 118/78", check: r => rc(r, "logged", "118", "78", "blood") || ha(r, "create") },
    { cat: "FastPath", name: "Food log", msg: "ate a test burrito 650 cal 30g protein", check: r => rc(r, "logged", "burrito", "650") || ha(r, "create") },
  ],
  // Batch 20: Multi-intent + Calendar sync
  [
    { cat: "MultiIntent", name: "Two actions", msg: "I walked 2 miles and also spent $8 on coffee at ZZTestCafe", check: r => (r.actions||[]).length >= 2 || (rc(r, "mile", "walk") && rc(r, "coffee", "8")) },
  ],
  // Batch 21: Calendar + Recall
  [
    { cat: "Calendar", name: "Sync", msg: "Sync my Google Calendar", check: r => rc(r, "sync", "calendar", "google", "import", "event") },
    { cat: "RecallActions", name: "Recent actions", msg: "Show my recent actions", check: r => rc(r, "action", "recent", "created", "logged", "deleted", "here") },
  ],
];

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  PORTOL AI CHAT — BATCHED FEATURE TEST SUITE");
  console.log(`  ${testQueue.reduce((a, b) => a + b.length, 0)} tests in ${testQueue.length} batches`);
  console.log("═══════════════════════════════════════════════════════════\n");

  await login();
  console.log("  🔑 Authenticated\n");

  const allResults: Result[] = [];
  let batchNum = 0;

  for (const batch of testQueue) {
    batchNum++;
    const promises = batch.map(async (t) => {
      const r = await chat(t.msg);
      const timeout = r.reply === "__TIMEOUT__";
      const pass = timeout ? false : t.check(r);
      const detail = timeout ? "TIMEOUT (60s)" : (r.reply?.substring(0, 200) || "No reply");
      allResults.push({ cat: t.cat, name: t.name, pass, detail });
      console.log(`  ${pass ? "✅" : "❌"} [${t.cat}] ${t.name}: ${detail.substring(0, 100)}`);
    });
    await Promise.all(promises);
  }

  // ── SUMMARY ────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");

  const cats = [...new Set(allResults.map(r => r.cat))];
  let tp = 0, tf = 0;
  for (const c of cats) {
    const cr = allResults.filter(r => r.cat === c);
    const p = cr.filter(r => r.pass).length;
    const f = cr.filter(r => !r.pass).length;
    tp += p; tf += f;
    console.log(`  ${f === 0 ? "✅" : "⚠️"} ${c}: ${p}/${cr.length}`);
    for (const r of cr.filter(r => !r.pass)) {
      console.log(`     ❌ ${r.name}: ${r.detail.substring(0, 120)}`);
    }
  }
  console.log(`\n  TOTAL: ${tp}/${tp + tf} passed, ${tf} failed`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Save results
  fs.writeFileSync("/home/user/workspace/lifeos/tests/ai-chat-results.json", JSON.stringify(allResults, null, 2));
  
  let report = `PORTOL AI CHAT — TEST RESULTS\n${new Date().toISOString()}\nTotal: ${tp}/${tp+tf} passed, ${tf} failed\n${"═".repeat(60)}\n\n`;
  for (const r of allResults) {
    report += `[${r.pass ? "PASS" : "FAIL"}] ${r.cat} > ${r.name}\n  ${r.detail.substring(0, 250)}\n\n`;
  }
  fs.writeFileSync("/home/user/workspace/lifeos/tests/ai-chat-report.txt", report);
  console.log("  Results saved to tests/ai-chat-results.json + ai-chat-report.txt");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
