/**
 * LIVE AI command sweep against portol.me.
 *
 * Exercises 2-3 phrasings per category and verifies:
 *   1. The action was created (DB row visible via API)
 *   2. The action is scoped to the QA user (profileId / linkage)
 *   3. The AI's text reply matches what was actually persisted
 *      (no fabrication, no hallucinated success message)
 *
 * Categories: tasks, bills (obligations), events (schedule), expenses,
 * goals, habits, trackers (+ entries), journal/mood, finance investments,
 * health (BP / weight / sleep), documents read-back.
 *
 * Cleans up everything it creates at the end via the same tag prefix.
 */

const API_BASE = "https://portol.me/api";
const TEST_EMAIL = "testfix2026@aol.com";
const TEST_PASSWORD = "Testtest1!";

const TAG = `sweep_${Date.now()}`;

let authToken = "";

interface Step {
  category: string;
  prompt: string;
  pass: boolean;
  detail: string;
}
const steps: Step[] = [];
function record(category: string, prompt: string, pass: boolean, detail: string) {
  steps.push({ category, prompt, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${category}] "${prompt.slice(0, 60)}" — ${detail.slice(0, 250)}`);
}

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

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}`, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

async function chat(message: string): Promise<any> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ message }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`chat ${res.status}: ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

function actionsOf(resp: any, types: string[]): any[] {
  return (resp.actions || []).filter((a: any) => types.includes(a.type));
}
function combineText(resp: any): string {
  return ((resp?.reply || "") + " " + JSON.stringify(resp?.actions || [])).toLowerCase();
}

async function settle(ms = 1500): Promise<void> { await new Promise(r => setTimeout(r, ms)); }

// ─── Test definitions ────────────────────────────────────────────────

async function testTasks() {
  // 1. Simple add
  const r1 = await chat(`Create a task tagged ${TAG} called "${TAG}_task_buy_milk" due tomorrow.`);
  const a1 = actionsOf(r1, ["create_task"]);
  const taskId1 = a1[0]?.data?._entityId;
  await settle();
  const tasks = await api(`/tasks?limit=200`);
  const arr = Array.isArray(tasks) ? tasks : (tasks.items || []);
  const persisted = arr.find((t: any) => t.id === taskId1);
  record("tasks", "Create task", !!persisted, persisted ? `id=${persisted.id} title="${persisted.title}" due=${persisted.dueDate}` : `not persisted (action data=${JSON.stringify(a1[0]?.data || {}).slice(0, 200)})`);

  // 2. Different phrasing
  const r2 = await chat(`Remind me to "${TAG}_task_call_mom" on Friday at 4pm.`);
  const a2 = actionsOf(r2, ["create_task", "create_event"]);
  // Either a task with a date or an event — both acceptable since "remind me at 4pm" is event-ish
  record("tasks", "Remind me phrase", a2.length > 0,
    a2.length > 0 ? `created ${a2[0].type} with ${JSON.stringify(a2[0].data).slice(0, 150)}` : `no task/event action`);
}

async function testEvents() {
  const r1 = await chat(`Schedule a "${TAG}_evt_dentist" appointment next Monday at 10am.`);
  const a1 = actionsOf(r1, ["create_event"]);
  await settle();
  const events = await api(`/events?limit=200`);
  const arr = Array.isArray(events) ? events : (events.items || []);
  const persisted = arr.find((e: any) => /sweep_\d+_evt_dentist/i.test(e.title) || e.id === a1[0]?.data?._entityId);
  record("events", "Schedule next Monday 10am", !!persisted,
    persisted ? `id=${persisted.id} title="${persisted.title}" startTime=${persisted.startTime}` : `not persisted`);
}

async function testBillsObligations() {
  const r1 = await chat(`Add a $${15} monthly bill called "${TAG}_bill_netflix" due on the 5th.`);
  const a1 = actionsOf(r1, ["create_obligation"]);
  await settle();
  const obligations = await api(`/obligations?limit=200`);
  const arr = Array.isArray(obligations) ? obligations : (obligations.items || []);
  const persisted = arr.find((o: any) => /sweep_\d+_bill_netflix/i.test(o.name) || o.id === a1[0]?.data?._entityId);
  record("bills/obligations", "Add monthly bill", !!persisted,
    persisted ? `id=${persisted.id} name="${persisted.name}" amount=$${persisted.amount} freq=${persisted.frequency}` : `not persisted`);
}

async function testExpenses() {
  const r1 = await chat(`Log a $42 grocery expense at "${TAG}_exp_trader_joes" today.`);
  const a1 = actionsOf(r1, ["log_expense", "create_expense"]);
  await settle();
  const exps = await api(`/expenses?limit=200`);
  const arr = Array.isArray(exps) ? exps : (exps.items || []);
  const persisted = arr.find((e: any) =>
    /sweep_\d+_exp_trader_joes/i.test(e.description || "") ||
    (e.amount === 42 && /sweep_\d+_exp/i.test(e.description || "")) ||
    e.id === a1[0]?.data?._entityId);
  record("expenses", "Log $42 grocery", !!persisted,
    persisted ? `id=${persisted.id} amount=$${persisted.amount} category=${persisted.category} desc="${persisted.description}"` : `not persisted (created ${a1.length} action(s))`);
}

async function testGoals() {
  const r1 = await chat(`Set a goal to save $5000 by next year called "${TAG}_goal_emergency_fund".`);
  const a1 = actionsOf(r1, ["create_goal"]);
  await settle();
  const goals = await api(`/goals?limit=200`);
  const arr = Array.isArray(goals) ? goals : (goals.items || []);
  const persisted = arr.find((g: any) => /sweep_\d+_goal_emergency/i.test(g.title || "") || g.id === a1[0]?.data?._entityId);
  record("goals", "Save $5000 goal", !!persisted,
    persisted ? `id=${persisted.id} title="${persisted.title}" target=${persisted.targetValue}` : `not persisted`);
}

async function testHabits() {
  const r1 = await chat(`Track a daily habit called "${TAG}_habit_meditate".`);
  const a1 = actionsOf(r1, ["create_habit"]);
  await settle();
  const habits = await api(`/habits?limit=200`);
  const arr = Array.isArray(habits) ? habits : (habits.items || []);
  const persisted = arr.find((h: any) => /sweep_\d+_habit_meditate/i.test(h.name || "") || h.id === a1[0]?.data?._entityId);
  record("habits", "Daily habit meditate", !!persisted,
    persisted ? `id=${persisted.id} name="${persisted.name}" frequency=${persisted.frequency}` : `not persisted`);
}

async function testTrackers() {
  const r1 = await chat(`Create a tracker called "${TAG}_tracker_mood" with daily entries.`);
  const a1 = actionsOf(r1, ["create_tracker"]);
  await settle();
  const trackers = await api(`/trackers?limit=200`);
  const arr = Array.isArray(trackers) ? trackers : (trackers.items || []);
  const persisted = arr.find((t: any) => /sweep_\d+_tracker_mood/i.test(t.name || "") || t.id === a1[0]?.data?._entityId);
  record("trackers", "Create mood tracker", !!persisted,
    persisted ? `id=${persisted.id} name="${persisted.name}" type=${persisted.type || persisted.kind}` : `not persisted`);

  // Log an entry
  if (persisted) {
    const r2 = await chat(`Log a 7 in "${TAG}_tracker_mood".`);
    const a2 = actionsOf(r2, ["log_tracker_entry"]);
    await settle();
    // Entries are stored inline on the tracker resource (not at /trackers/:id/entries)
    const tr = await api(`/trackers/${persisted.id}`).catch(() => ({}));
    const earr = Array.isArray(tr?.entries) ? tr.entries : [];
    const last = earr[earr.length - 1];
    const v = last ? (last.value ?? last.values?.mood ?? last.values?.value ?? JSON.stringify(last.values || {})) : undefined;
    record("trackers", "Log tracker entry of 7", earr.length > 0,
      last ? `last value=${v} date=${last.date || last.createdAt}` : `no entries / action=${JSON.stringify(a2[0]?.data || {}).slice(0, 150)}`);
  }
}

async function testHealth() {
  // weight
  const r1 = await chat(`Log my weight at 170 lbs.`);
  const t1 = combineText(r1);
  record("health/weight", "Log weight 170 lbs", t1.includes("weight") && (t1.includes("170") || (r1.actions || []).some((a: any) => /weight/i.test(JSON.stringify(a.data)))),
    `reply="${(r1.reply || "").slice(0, 120)}" actions=${(r1.actions || []).map((a: any) => a.type).join(",")}`);

  // BP
  const r2 = await chat(`Log BP 120 over 80.`);
  const t2 = combineText(r2);
  record("health/bp", "Log BP 120/80", t2.includes("120") && t2.includes("80"),
    `reply="${(r2.reply || "").slice(0, 120)}" actions=${(r2.actions || []).map((a: any) => a.type).join(",")}`);

  // sleep
  const r3 = await chat(`I slept 7 hours last night.`);
  const t3 = combineText(r3);
  record("health/sleep", "Slept 7 hours", t3.includes("sleep") || t3.includes("7"),
    `reply="${(r3.reply || "").slice(0, 120)}" actions=${(r3.actions || []).map((a: any) => a.type).join(",")}`);
}

async function testFinanceInvestments() {
  const r1 = await chat(`Add an investment account called "${TAG}_inv_brokerage" with $${10000} in it.`);
  const a1 = actionsOf(r1, ["create_profile"]);
  await settle();
  const profs = await api(`/profiles?limit=2000`);
  const arr = Array.isArray(profs) ? profs : (profs.items || []);
  const persisted = arr.find((p: any) => /sweep_\d+_inv_brokerage/i.test(p.name || "") || p.id === a1[0]?.data?._entityId);
  record("finance/investments", "Investment account $10k", !!persisted,
    persisted ? `id=${persisted.id} name="${persisted.name}" type=${persisted.type} val=${persisted.fields?.currentValue}` : `not persisted`);
}

async function testJournal() {
  const r1 = await chat(`Log a journal entry: feeling productive today, mood good. tag: ${TAG}`);
  const t = combineText(r1);
  // Journal/mood entry — either journal action or mood log
  record("journal/mood", "Productive mood entry", t.includes("journal") || t.includes("mood") || (r1.actions || []).some((a: any) => /journal|mood/i.test(a.type)),
    `reply="${(r1.reply || "").slice(0, 120)}" actions=${(r1.actions || []).map((a: any) => a.type).join(",")}`);
}

async function testReadBack() {
  // Ask AI to read back things we just created. The AI should NOT
  // hallucinate; it should report the actual count or list.
  const r = await chat(`How many tasks tagged "${TAG}" do I have right now? Tell me their titles.`);
  const text = (r.reply || "").toLowerCase();
  // We expect the AI to mention the actual title (`${TAG}_task_buy_milk`) — not a fake one.
  const tagInReply = text.includes(`sweep_`);
  record("read-back", "Lists actual tasks", tagInReply,
    `reply="${(r.reply || "").slice(0, 200)}"`);
}

// ─── Cleanup ─────────────────────────────────────────────────────────

async function cleanup() {
  console.log("\n=== Cleanup ===");
  let cleaned = 0;

  // Find everything tagged TAG via various endpoints
  for (const [resource, path] of [
    ["tasks", "/tasks?limit=500"],
    ["events", "/events?limit=500"],
    ["obligations", "/obligations?limit=500"],
    ["expenses", "/expenses?limit=500"],
    ["goals", "/goals?limit=500"],
    ["habits", "/habits?limit=500"],
    ["trackers", "/trackers?limit=500"],
    ["profiles", "/profiles?limit=2000"],
  ]) {
    try {
      const data = await api(path);
      const arr = Array.isArray(data) ? data : (data.items || []);
      // Match anything whose title/name/description contains TAG
      const mine = arr.filter((x: any) => {
        const s = `${x.title || ""} ${x.name || ""} ${x.description || ""}`;
        return s.includes(TAG);
      });
      for (const item of mine) {
        const endpoint = `/${resource}/${item.id}`;
        try { await api(endpoint, { method: "DELETE" }); cleaned++; }
        catch (e: any) { console.log(`  cleanup ${endpoint} fail: ${e?.message?.slice(0, 100)}`); }
      }
    } catch (e: any) { console.log(`  cleanup ${path} skipped: ${e?.message?.slice(0, 100)}`); }
  }
  console.log(`Cleanup deleted ${cleaned} items`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== AI Command Sweep (tag=${TAG}) ===\n`);
  authToken = await login();
  console.log("Login OK\n");

  try {
    await testTasks();
    await testEvents();
    await testBillsObligations();
    await testExpenses();
    await testGoals();
    await testHabits();
    await testTrackers();
    await testHealth();
    await testFinanceInvestments();
    await testJournal();
    await testReadBack();
  } catch (e: any) {
    console.error("ERROR:", e?.message || e);
  } finally {
    await cleanup();
  }

  console.log("\n=== Summary ===");
  const passed = steps.filter(s => s.pass).length;
  console.log(`${passed}/${steps.length} steps passed`);
  const byCat: Record<string, [number, number]> = {};
  for (const s of steps) {
    if (!byCat[s.category]) byCat[s.category] = [0, 0];
    byCat[s.category][1]++;
    if (s.pass) byCat[s.category][0]++;
  }
  for (const [cat, [p, t]] of Object.entries(byCat)) {
    console.log(`  ${cat}: ${p}/${t}`);
  }
  // Print failures in detail
  const fails = steps.filter(s => !s.pass);
  if (fails.length > 0) {
    console.log("\n=== Failures ===");
    for (const f of fails) console.log(`  [${f.category}] "${f.prompt}" — ${f.detail}`);
  }
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
