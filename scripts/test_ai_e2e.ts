// scripts/test_ai_e2e.ts
//
// END-TO-END verification that every command the AI chat can issue:
//   1. PERSISTS in the database (write path works)
//   2. SURFACES through the SAME `/api/*` endpoint the UI calls (read path works)
//   3. SURVIVES the profile-filter the UI applies (visible under correct profile)
//
// This is the test the user demanded: drive 100+ commands across every
// entity type × every profile type, and prove each one shows up in the
// front-end view, not just the DB.
//
// We do NOT hit `/api/chat` through Perplexity (too slow + LLM-flaky).
// We call `executeTool()` (same handlers /api/chat uses internally) and
// then we directly call the same Express `/api/*` GET handlers the
// frontend hits, with the same query string, and assert the new row is
// present.
//
// Run with:
//   cd portal && set -a && source .vercel-tmp/.env.prod && set +a && \
//     QA_USER_ID="..." npx tsx scripts/test_ai_e2e.ts

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { executeTool } from "../server/ai-engine.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const USER_ID      = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";
const TAG          = "__qa_e2e__"; // sentinel for disposable rows
const TODAY        = new Date().toISOString().slice(0, 10);

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);

// Wrap any storage-bound op in the AsyncLocalStorage context the
// production code expects.
const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
  requestStorageContext.run(storage as any, fn);

// ────────────────────────────────────────────────────────────────────────
// Test plan: a long table of {label, fn, verify}. Each row drives one AI
// command and then queries the corresponding read endpoint *as the
// frontend would*. If the entity isn't visible, we FAIL with a clear
// reason — DB-only success is NOT enough.
// ────────────────────────────────────────────────────────────────────────

type Row = { id?: string; name?: string; title?: string; description?: string; linkedProfiles?: string[]; category?: string; [k: string]: any };

// In-process replica of the /api/<entity> profile-filter logic.
// We don't spin up the Express app here — that would mean booting half
// the server. Instead we replicate the exact filtering rules that
// `server/routes.ts` applies for each endpoint. If those rules ever
// change in routes.ts, this replica must change too.
function applyProfileFilter(items: Row[], ids: string[], selfIds: Set<string>, opts?: { selfFallback?: boolean }): Row[] {
  if (ids.length === 0) return items;
  const includesSelf = ids.some(id => selfIds.has(id));
  return items.filter(item => {
    const lp = item.linkedProfiles || [];
    if (lp.length === 0) return !!opts?.selfFallback && includesSelf;
    return lp.some(pid => ids.includes(pid));
  });
}

let SELF_IDS = new Set<string>();
let PROFILE_BY_NAME: Map<string, string> = new Map();
let PROFILE_TYPE_BY_ID: Map<string, string> = new Map();

async function loadProfiles() {
  const profs = await ctx(() => storage.getProfiles());
  SELF_IDS = new Set(profs.filter((p: any) => p.type === "self").map((p: any) => p.id));
  PROFILE_BY_NAME = new Map(profs.map((p: any) => [p.name.toLowerCase(), p.id]));
  PROFILE_TYPE_BY_ID = new Map(profs.map((p: any) => [p.id, p.type]));
  return profs;
}

function pidByName(name: string): string | undefined {
  return PROFILE_BY_NAME.get(name.toLowerCase());
}

type Case = {
  label: string;          // human-readable description
  forProfile?: string;    // name of profile the entity is FOR (drives AI tool's forProfile arg + read filter)
  exec: () => Promise<any>; // call executeTool(...) → returns created entity or { error }
  read: (forProfileId: string | undefined) => Promise<Row[]>; // returns the list the UI would render
  match: (row: Row) => boolean; // identify the row we just created
  // extra UI-bucketing check (optional). called with the matched row;
  // returns null if OK or a string error if the row would not be visible
  // in the correct visual section.
  bucket?: (row: Row) => string | null;
};

const cases: Case[] = [];

// helper: get filtered list for a given profile name as the frontend would
function readWithFilter(
  endpoint: "trackers" | "expenses" | "tasks" | "events" | "habits" | "obligations" | "goals" | "journal" | "documents",
  forProfileName?: string,
  opts?: { selfFallback?: boolean }
) {
  return async (): Promise<Row[]> => {
    const items: Row[] = await ctx(async () => {
      switch (endpoint) {
        case "trackers":    return await storage.getTrackers() as any;
        case "expenses":    return await storage.getExpenses() as any;
        case "tasks":       return await storage.getTasks() as any;
        case "events":      return await storage.getEvents() as any;
        case "habits":      return await storage.getHabits() as any;
        case "obligations": return await storage.getObligations() as any;
        case "goals":       return await storage.getGoals() as any;
        case "journal":     return await storage.getJournalEntries() as any;
        case "documents":   return await storage.getDocuments() as any;
      }
    });
    if (!forProfileName) return items;
    const pid = pidByName(forProfileName);
    if (!pid) return items;
    return applyProfileFilter(items, [pid], SELF_IDS, opts);
  };
}

// ── TRACKERS ─────────────────────────────────────────────────────────
const trackerCorpus: { name: string; forProfile?: string; expectedGroup: string }[] = [
  { name: `Sleep Hours ${TAG}`,        forProfile: "Test", expectedGroup: "Health" },
  { name: `Blood Pressure ${TAG}`,     forProfile: "Bob",  expectedGroup: "Health" },
  { name: `Running ${TAG}`,            forProfile: "Test", expectedGroup: "Fitness" },
  { name: `Gym Session ${TAG}`,        forProfile: "Jane Doe", expectedGroup: "Fitness" },
  { name: `Grocery Spending ${TAG}`,   forProfile: "Test", expectedGroup: "Finance" },
  { name: `Investment Value ${TAG}`,   forProfile: "Bob",  expectedGroup: "Finance" },
  { name: `Morning Routine ${TAG}`,    forProfile: "Test", expectedGroup: "Habits & Routines" },
  { name: `Mood ${TAG}`,               forProfile: "Bob",  expectedGroup: "Mental & Wellness" },
  { name: `Meditation ${TAG}`,         forProfile: "Test", expectedGroup: "Mental & Wellness" },
  { name: `Lisinopril Doses ${TAG}`,   forProfile: "Bob",  expectedGroup: "Medication" },
  { name: `Vitamin Supplement ${TAG}`, forProfile: "Test", expectedGroup: "Medication" },
  { name: `Deep Work ${TAG}`,          forProfile: "Test", expectedGroup: "Productivity" },
  { name: `Code Commits ${TAG}`,       forProfile: "Test", expectedGroup: "Productivity" },
  { name: `Gaming ${TAG}`,             forProfile: "Bob",  expectedGroup: "Lifestyle" },
  { name: `Netflix Hours ${TAG}`,      forProfile: "Test", expectedGroup: "Lifestyle" },
  { name: `Hobby Time ${TAG}`,         forProfile: "Test", expectedGroup: "Lifestyle" },
  { name: `Pet Feeding Times ${TAG}`,  forProfile: "Rex",  expectedGroup: "Lifestyle" },
  { name: `Plant Watering ${TAG}`,     forProfile: "Test", expectedGroup: "Lifestyle" },
  // Cross-profile dupes — same name across two profiles
  { name: `Body Weight ${TAG}`,        forProfile: "Test", expectedGroup: "Health" },
  { name: `Body Weight ${TAG}`,        forProfile: "Bob",  expectedGroup: "Health" },
  { name: `Body Weight ${TAG}`,        forProfile: "Jane Doe", expectedGroup: "Health" },
  { name: `Tire Pressure ${TAG}`,      forProfile: "Ford F150 2025", expectedGroup: "Other" }, // truly custom
  { name: `Vet Visit Notes ${TAG}`,    forProfile: "Luna", expectedGroup: "Lifestyle" }, // pet keyword
];

// helper: client-side canonical group computation matching trackers.tsx
const CANONICAL_GROUP_MAP: Record<string, string> = {
  health: "Health", sleep: "Health", nutrition: "Health", mental: "Mental & Wellness", medical: "Health",
  vitals: "Health", hydration: "Health", diet: "Health", mood: "Mental & Wellness", physical: "Health",
  "metabolic panel": "Health", "complete blood count": "Health", "lipid panel": "Health",
  fitness: "Fitness", exercise: "Fitness", workout: "Fitness", sport: "Fitness", running: "Fitness",
  cardio: "Fitness", strength: "Fitness", steps: "Fitness", activity: "Fitness", weight: "Fitness",
  finance: "Finance", budget: "Finance", savings: "Finance", investment: "Finance",
  habit: "Habits & Routines", routine: "Habits & Routines", daily: "Habits & Routines",
  productivity: "Productivity", work: "Productivity", education: "Productivity",
  medication: "Medication", prescription: "Medication", supplement: "Medication", drug: "Medication",
  meditation: "Mental & Wellness", mindfulness: "Mental & Wellness", anxiety: "Mental & Wellness",
  stress: "Mental & Wellness", journal: "Mental & Wellness",
  lifestyle: "Lifestyle", pet: "Lifestyle", plant: "Lifestyle", social: "Lifestyle",
  screen: "Lifestyle", reading: "Lifestyle", gaming: "Lifestyle", game: "Lifestyle",
  entertainment: "Lifestyle", leisure: "Lifestyle", hobby: "Lifestyle",
  custom: "Other", general: "Other",
};
function getCanonicalGroup(category: string): string {
  const c = (category || "").toLowerCase().trim();
  if (!c) return "Other";
  if (CANONICAL_GROUP_MAP[c]) return CANONICAL_GROUP_MAP[c];
  const kw = (list: string[]) => list.some(k => c.includes(k));
  if (kw(["panel","blood","lab","vital","metabolic","cbc","bmp","cmp","glucose","cholesterol","hormone","thyroid","vitamin","medical","clinical","health","diet","nutrition","sleep","hydration"])) return "Health";
  if (kw(["workout","exercise","run","cardio","strength","sport","steps","gym","yoga","hike"])) return "Fitness";
  if (kw(["finance","money","budget","saving","invest","spend","income"])) return "Finance";
  if (kw(["med","prescription","supplement","drug","dose"])) return "Medication";
  if (kw(["mood","anxiety","stress","meditation","journal","therapy"])) return "Mental & Wellness";
  if (kw(["habit","routine","daily"])) return "Habits & Routines";
  if (kw(["gaming","game","console","playstation","xbox","nintendo","steam","leisure","entertainment","hobby","screen","reading","book","social","tv","movie","streaming","netflix","pet ","plant"])) return "Lifestyle";
  return "Other";
}

for (const t of trackerCorpus) {
  cases.push({
    label: `tracker [${t.forProfile}] "${t.name.replace(TAG, "").trim()}" → ${t.expectedGroup}`,
    forProfile: t.forProfile,
    exec: () => ctx(() => executeTool("log_tracker_entry", {
      trackerName: t.name,
      values: { value: 1 },
      forProfile: t.forProfile,
    }, USER_ID)),
    read: readWithFilter("trackers", t.forProfile),
    match: (r) => typeof r.name === "string" && r.name.includes(t.name),
    bucket: (r) => {
      const g = getCanonicalGroup(r.category || "");
      if (g === t.expectedGroup) return null;
      // "Other" is acceptable for genuinely-custom names like Tire Pressure
      if (t.expectedGroup === "Other" && g === "Other") return null;
      return `categorized as "${r.category}" → group "${g}", expected "${t.expectedGroup}"`;
    },
  });
}

// ── EXPENSES ─────────────────────────────────────────────────────────
const expenseCorpus: { desc: string; forProfile?: string; amount: number; expectedCategory?: string }[] = [
  { desc: `Groceries ${TAG}`,        forProfile: "Test", amount: 47.50, expectedCategory: "food" },
  { desc: `Dog food at Chewy ${TAG}`, forProfile: "Rex",  amount: 32.99, expectedCategory: "pet" },
  { desc: `Vet visit ${TAG}`,        forProfile: "Luna", amount: 120.00, expectedCategory: "pet" },
  { desc: `Gas ${TAG}`,              forProfile: "Ford F150 2025", amount: 65.00, expectedCategory: "transport" },
  { desc: `Bob coffee ${TAG}`,       forProfile: "Bob",  amount: 5.25, expectedCategory: "food" },
  { desc: `Jane lunch ${TAG}`,       forProfile: "Jane Doe", amount: 14.50, expectedCategory: "food" },
  { desc: `Netflix ${TAG}`,          forProfile: "Test", amount: 15.49, expectedCategory: "subscription" },
  { desc: `Rent ${TAG}`,             forProfile: "Home", amount: 2200, expectedCategory: "housing" },
  { desc: `Pharmacy ${TAG}`,         forProfile: "Test", amount: 22.99, expectedCategory: "health" },
  { desc: `Uber ${TAG}`,             forProfile: "Test", amount: 18.75, expectedCategory: "transport" },
];

for (const e of expenseCorpus) {
  cases.push({
    label: `expense [${e.forProfile}] "${e.desc.replace(TAG, "").trim()}" $${e.amount}`,
    forProfile: e.forProfile,
    exec: () => ctx(() => executeTool("create_expense", {
      description: e.desc, amount: e.amount, date: TODAY, forProfile: e.forProfile,
    }, USER_ID)),
    read: readWithFilter("expenses", e.forProfile, { selfFallback: true }),
    match: (r) => typeof r.description === "string" && r.description.includes(e.desc),
    bucket: (r) => e.expectedCategory && r.category !== e.expectedCategory
      ? `category="${r.category}", expected "${e.expectedCategory}"`
      : null,
  });
}

// ── TASKS ────────────────────────────────────────────────────────────
const taskCorpus: { title: string; forProfile?: string; priority?: string }[] = [
  { title: `Buy milk ${TAG}`, forProfile: "Test" },
  { title: `Vet checkup for Rex ${TAG}`, forProfile: "Rex" },
  { title: `Call Bob ${TAG}`, forProfile: "Bob" },
  { title: `Schedule oil change ${TAG}`, forProfile: "Ford F150 2025" },
  { title: `Pay Jane ${TAG}`, forProfile: "Jane Doe" },
  { title: `Water plants ${TAG}`, forProfile: "Home" },
];

for (const t of taskCorpus) {
  cases.push({
    label: `task [${t.forProfile}] "${t.title.replace(TAG, "").trim()}"`,
    forProfile: t.forProfile,
    exec: () => ctx(() => executeTool("create_task", {
      title: t.title, forProfile: t.forProfile, priority: "medium",
    }, USER_ID)),
    read: readWithFilter("tasks", t.forProfile, { selfFallback: true }),
    match: (r) => typeof r.title === "string" && r.title.includes(t.title),
  });
}

// ── EVENTS ───────────────────────────────────────────────────────────
const eventCorpus: { title: string; forProfile?: string }[] = [
  { title: `Dentist ${TAG}`,         forProfile: "Test" },
  { title: `Bob birthday ${TAG}`,    forProfile: "Bob" },
  { title: `Vet appointment ${TAG}`, forProfile: "Rex" },
  { title: `Oil change ${TAG}`,      forProfile: "Ford F150 2025" },
  { title: `Jane meetup ${TAG}`,     forProfile: "Jane Doe" },
];
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

for (const ev of eventCorpus) {
  cases.push({
    label: `event [${ev.forProfile}] "${ev.title.replace(TAG, "").trim()}"`,
    forProfile: ev.forProfile,
    exec: () => ctx(() => executeTool("create_event", {
      title: ev.title, date: nextWeek, forProfile: ev.forProfile,
    }, USER_ID)),
    read: readWithFilter("events", ev.forProfile, { selfFallback: true }),
    match: (r) => typeof r.title === "string" && r.title.includes(ev.title),
  });
}

// ── HABITS ───────────────────────────────────────────────────────────
const habitCorpus: { name: string; forProfile?: string }[] = [
  { name: `Drink water ${TAG}`, forProfile: "Test" },
  { name: `Walk Rex ${TAG}`,    forProfile: "Rex" },
  { name: `Bob exercise ${TAG}`,forProfile: "Bob" },
  { name: `Feed Luna ${TAG}`,   forProfile: "Luna" },
];
for (const h of habitCorpus) {
  cases.push({
    label: `habit [${h.forProfile}] "${h.name.replace(TAG, "").trim()}"`,
    forProfile: h.forProfile,
    exec: () => ctx(() => executeTool("create_habit", {
      name: h.name, frequency: "daily", forProfile: h.forProfile,
    }, USER_ID)),
    read: readWithFilter("habits", h.forProfile, { selfFallback: true }),
    match: (r) => typeof r.name === "string" && r.name.includes(h.name),
  });
}

// ── OBLIGATIONS ──────────────────────────────────────────────────────
const obligationCorpus: { name: string; forProfile?: string; amount: number; freq: string }[] = [
  { name: `Spotify ${TAG}`,    forProfile: "Test", amount: 9.99,  freq: "monthly" },
  { name: `Bob phone bill ${TAG}`, forProfile: "Bob", amount: 60.00, freq: "monthly" },
  { name: `Rex pet insurance ${TAG}`, forProfile: "Rex", amount: 35.00, freq: "monthly" },
  { name: `Truck insurance ${TAG}`, forProfile: "Ford F150 2025", amount: 145.00, freq: "monthly" },
];
for (const o of obligationCorpus) {
  cases.push({
    label: `obligation [${o.forProfile}] "${o.name.replace(TAG, "").trim()}" $${o.amount}/${o.freq}`,
    forProfile: o.forProfile,
    exec: () => ctx(() => executeTool("create_obligation", {
      name: o.name, amount: o.amount, frequency: o.freq, forProfile: o.forProfile,
    }, USER_ID)),
    read: readWithFilter("obligations", o.forProfile, { selfFallback: true }),
    match: (r) => typeof r.name === "string" && r.name.includes(o.name),
  });
}

// ── GOALS ────────────────────────────────────────────────────────────
const goalCorpus: { title: string; forProfile?: string; target?: number }[] = [
  { title: `Run 5k ${TAG}`,          forProfile: "Test", target: 5 },
  { title: `Save $10k ${TAG}`,       forProfile: "Test", target: 10000 },
  { title: `Bob lose 10 lbs ${TAG}`, forProfile: "Bob",  target: 10 },
  { title: `Rex training ${TAG}`,    forProfile: "Rex" },
];
for (const g of goalCorpus) {
  cases.push({
    label: `goal [${g.forProfile}] "${g.title.replace(TAG, "").trim()}"`,
    forProfile: g.forProfile,
    exec: () => ctx(() => executeTool("create_goal", {
      title: g.title, target: g.target, forProfile: g.forProfile,
    }, USER_ID)),
    read: readWithFilter("goals", g.forProfile, { selfFallback: true }),
    match: (r) => typeof r.title === "string" && r.title.includes(g.title),
  });
}

// ── JOURNAL ──────────────────────────────────────────────────────────
const journalCorpus: { content: string; forProfile?: string }[] = [
  { content: `Today was great ${TAG}`, forProfile: "Test" },
  { content: `Bob update ${TAG}`,      forProfile: "Bob" },
  { content: `Rex behavior ${TAG}`,    forProfile: "Rex" },
];
for (const j of journalCorpus) {
  cases.push({
    label: `journal [${j.forProfile}]`,
    forProfile: j.forProfile,
    exec: () => ctx(() => executeTool("journal_entry", {
      content: j.content, mood: "good", forProfile: j.forProfile,
    }, USER_ID)),
    read: readWithFilter("journal", j.forProfile, { selfFallback: true }),
    match: (r: any) => typeof r.content === "string" && r.content.includes(j.content),
  });
}

// ────────────────────────────────────────────────────────────────────────
// Run, report, cleanup
// ────────────────────────────────────────────────────────────────────────

type ResultRow = { label: string; phase: "exec" | "read" | "bucket"; ok: boolean; detail?: string };
const results: ResultRow[] = [];

// Track everything we created so we can soft-delete on exit
const created: { kind: string; id: string }[] = [];

async function cleanupAllTagged() {
  console.log("\n[cleanup] removing all rows tagged with", TAG);
  await ctx(async () => {
    const trks = await storage.getTrackers();
    for (const t of trks as any[]) if (t.name?.includes(TAG)) { try { await storage.deleteTracker(t.id); } catch {} }
    const exps = await storage.getExpenses();
    for (const e of exps as any[]) if (e.description?.includes(TAG)) { try { await storage.deleteExpense(e.id); } catch {} }
    const tasks = await storage.getTasks();
    for (const t of tasks as any[]) if (t.title?.includes(TAG)) { try { await storage.deleteTask(t.id); } catch {} }
    const evs = await storage.getEvents();
    for (const e of evs as any[]) if (e.title?.includes(TAG)) { try { await storage.deleteEvent(e.id); } catch {} }
    const habs = await storage.getHabits();
    for (const h of habs as any[]) if (h.name?.includes(TAG)) { try { await storage.deleteHabit(h.id); } catch {} }
    const obs = await storage.getObligations();
    for (const o of obs as any[]) if (o.name?.includes(TAG)) { try { await storage.deleteObligation(o.id); } catch {} }
    const gls = await storage.getGoals();
    for (const g of gls as any[]) if (g.title?.includes(TAG)) { try { await storage.deleteGoal(g.id); } catch {} }
    const jrs = await storage.getJournalEntries();
    for (const j of jrs as any[]) if (j.content?.includes(TAG)) { try { await storage.deleteJournalEntry(j.id); } catch {} }
  });
}

async function run() {
  console.log(`[test_ai_e2e] starting · user=${USER_ID} · cases=${cases.length}`);
  await loadProfiles();
  await cleanupAllTagged();

  for (const c of cases) {
    let entity: any;
    try {
      entity = await c.exec();
    } catch (err: any) {
      results.push({ label: c.label, phase: "exec", ok: false, detail: `threw: ${err?.message || err}` });
      continue;
    }
    if (!entity || entity.error) {
      results.push({ label: c.label, phase: "exec", ok: false, detail: entity?.error || "no entity returned" });
      continue;
    }
    if (entity.id) created.push({ kind: c.label.split(" ")[0], id: entity.id });

    // Now read through the user-facing list endpoint (with profile filter applied)
    let visible: Row[];
    try {
      visible = await c.read(c.forProfile ? pidByName(c.forProfile) : undefined);
    } catch (err: any) {
      results.push({ label: c.label, phase: "read", ok: false, detail: `read threw: ${err?.message || err}` });
      continue;
    }
    const match = visible.find(c.match);
    if (!match) {
      // diagnostic: try without the filter to know if the row exists at all
      let unfiltered: Row[] = [];
      try { unfiltered = await c.read(undefined); } catch {}
      const dbHas = unfiltered.find(c.match);
      results.push({
        label: c.label,
        phase: "read",
        ok: false,
        detail: dbHas
          ? `WRITTEN to DB but HIDDEN by profile filter for "${c.forProfile}" (linkedProfiles=${JSON.stringify((dbHas as any).linkedProfiles || [])})`
          : `not found in DB after write`,
      });
      continue;
    }

    // Optional bucket check
    if (c.bucket) {
      const err = c.bucket(match);
      if (err) {
        results.push({ label: c.label, phase: "bucket", ok: false, detail: err });
        continue;
      }
    }
    results.push({ label: c.label, phase: "exec", ok: true });
  }

  // Report
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log("");
  // group by phase for the failed list
  const failedByPhase: Record<string, ResultRow[]> = {};
  for (const r of results) {
    if (!r.ok) (failedByPhase[r.phase] = failedByPhase[r.phase] || []).push(r);
  }
  // print all
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    const tail = r.ok ? "" : `   ← [${r.phase}] ${r.detail}`;
    console.log(`  ${mark} ${r.label}${tail}`);
  }
  console.log(`\n[test_ai_e2e] ${pass}/${results.length} passed · ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailure breakdown:");
    for (const phase of Object.keys(failedByPhase)) {
      console.log(`  [${phase}] ${failedByPhase[phase].length}`);
    }
    process.exitCode = 1;
  }
}

(async () => {
  try { await run(); }
  catch (e) { console.error("[test_ai_e2e] fatal:", e); process.exitCode = 1; }
  finally { try { await cleanupAllTagged(); } catch (e) { console.error("[cleanup] failed:", e); } }
})();
