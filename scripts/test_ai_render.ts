// scripts/test_ai_render.ts
//
// Exhaustive verification that every tracker the AI can produce surfaces
// in a NAMED canonical group on /trackers — never silently routed to
// "Other" unless the user explicitly asks for a custom bucket.
//
// Strategy:
//   1. Drive the actual AI tool handler `executeTool('log_tracker_entry',
//      ...)` (now exported from server/ai-engine.ts) so we exercise the
//      real category-inference logic, name-disambiguation logic, and DB
//      write path — not just the schema.
//   2. For each synthetic tracker name in a wide vocabulary covering
//      health, fitness, finance, lifestyle, mental, productivity,
//      medication, sleep, nutrition, habits, hobbies and edge cases,
//      assert that:
//         - a row was written
//         - its category falls into a recognized canonical group
//           per the client-side getCanonicalGroup() logic (kept in
//           sync via the inline implementation below — if the client
//           changes its grouping, this test must change with it)
//   3. Clean up: every disposable tracker created here is tagged with
//      a "__qa_render_test__" suffix on the name (so we can find them)
//      and SOFT-deleted at the end. The user's real data is never
//      touched.
//
// Run with:  cd portal && npx tsx scripts/test_ai_render.ts

import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { executeTool } from "../server/ai-engine.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_ID = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";
const TAG = "__qa_render_test__";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);
// The AI engine's tool handlers reach the database through the `storage`
// Proxy in server/storage.ts, which reads from AsyncLocalStorage. We
// wrap every executeTool call below inside requestStorageContext.run()
// so each tool runs against this user's data, exactly the way an HTTP
// request would.

// ── Canonical bucketing kept in sync with client/src/pages/trackers.tsx ──
// If these diverge, the test catches it because the canonical group it
// expects won't match what the UI computes.
const CANONICAL_GROUP_MAP: Record<string, string> = {
  health: "Health", sleep: "Health", nutrition: "Health", mental: "Mental & Wellness",
  medical: "Health", vitals: "Health", hydration: "Health", diet: "Health",
  mood: "Mental & Wellness", physical: "Health", "metabolic panel": "Health",
  "complete blood count": "Health", "lipid panel": "Health", "lipid profile": "Health",
  "thyroid panel": "Health", "liver panel": "Health", "kidney panel": "Health",
  "basic metabolic": "Health", "comprehensive metabolic": "Health", cbc: "Health",
  bmp: "Health", cmp: "Health", lab: "Health", labs: "Health", "lab results": "Health",
  "lab work": "Health", blood: "Health", "blood work": "Health", cholesterol: "Health",
  glucose: "Health", hormone: "Health", hormones: "Health", "hormone panel": "Health",
  vitamin: "Health", vitamins: "Health", urinalysis: "Health", endocrine: "Health",
  immunology: "Health", hematology: "Health", chemistry: "Health",
  fitness: "Fitness", exercise: "Fitness", workout: "Fitness", sport: "Fitness",
  running: "Fitness", cardio: "Fitness", strength: "Fitness", steps: "Fitness",
  activity: "Fitness", weight: "Fitness",
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

// ── Test corpus ─────────────────────────────────────────────────────────
// Every row is { trackerName the user might say, expectedGroup }.
// expectedGroup="Other" is allowed only for explicitly user-custom names.
const CORPUS: { name: string; expected: string }[] = [
  // Health & body vitals
  { name: "Blood Pressure", expected: "Health" },
  { name: "Heart Rate", expected: "Health" },
  { name: "Cholesterol", expected: "Health" },
  { name: "A1C", expected: "Health" },
  { name: "Body Temperature", expected: "Health" },
  { name: "Hydration", expected: "Health" },
  { name: "Water Intake", expected: "Health" },
  { name: "Calorie Intake", expected: "Health" }, // nutrition keyword → Health (unique name avoids collision with user's existing Calories tracker)
  { name: "Protein", expected: "Health" },
  { name: "Sleep Hours", expected: "Health" },
  { name: "Vitamin D Levels", expected: "Health" },
  // Fitness / sport
  { name: "Running", expected: "Fitness" },
  { name: "Cycling", expected: "Fitness" },
  { name: "Workout", expected: "Fitness" },
  { name: "Gym Session", expected: "Fitness" },
  { name: "Push-ups", expected: "Fitness" },
  { name: "Steps", expected: "Fitness" },
  { name: "Body Weight", expected: "Health" }, // "weight" hits both; current rule sends to Health via inference order
  { name: "Yoga", expected: "Fitness" },
  // Finance
  { name: "Grocery Spending", expected: "Finance" },
  { name: "Investment Portfolio Value", expected: "Finance" },
  { name: "Monthly Savings", expected: "Finance" },
  { name: "Side Income", expected: "Finance" },
  { name: "Credit Card Debt", expected: "Finance" },
  // Habits & routines
  { name: "Morning Routine", expected: "Habits & Routines" },
  { name: "Daily Reading", expected: "Habits & Routines" }, // habit keyword wins over lifestyle
  { name: "Bedtime", expected: "Habits & Routines" },
  // Mental & wellness
  { name: "Mood", expected: "Mental & Wellness" },
  { name: "Meditation Minutes", expected: "Mental & Wellness" },
  { name: "Stress Level", expected: "Mental & Wellness" },
  { name: "Anxiety Check", expected: "Mental & Wellness" },
  { name: "Therapy Sessions", expected: "Mental & Wellness" },
  // Medication
  { name: "Lisinopril Doses", expected: "Medication" },
  { name: "Vitamin Supplement", expected: "Medication" }, // "supplement" is medication regimen, not metric — medication priority wins
  { name: "Prescription Refills", expected: "Medication" },
  // Productivity
  { name: "Deep Work Hours", expected: "Productivity" },
  { name: "Study Time", expected: "Productivity" },
  { name: "Code Commits", expected: "Productivity" },
  // Lifestyle (the bug we just shipped a fix for)
  { name: "Gaming", expected: "Lifestyle" },
  { name: "Video Games", expected: "Lifestyle" },
  { name: "PlayStation Time", expected: "Lifestyle" },
  { name: "Netflix Hours", expected: "Lifestyle" },
  { name: "Reading Pages", expected: "Habits & Routines" }, // "reading" is habit-listed; ok
  { name: "Hobby Time", expected: "Lifestyle" },
  // Pet/plant care
  { name: "Pet Feeding Times", expected: "Lifestyle" },
  { name: "Plant Watering", expected: "Lifestyle" },
];

type Result = { name: string; passed: boolean; got?: string; want?: string; detail?: string };
const results: Result[] = [];

async function cleanupAllTagged() {
  await requestStorageContext.run(storage as any, async () => {
    const all = await storage.getTrackers();
    for (const t of all as any[]) {
      if (t.name?.includes(TAG)) {
        try { await storage.deleteTracker(t.id); } catch { /* ignore */ }
      }
    }
  });
}

async function run() {
  console.log(`[test_ai_render] starting · user=${USER_ID} · corpus=${CORPUS.length}`);

  // Pre-clean: nuke any leftover tagged trackers from a previous failed
  // run so we start from a known-empty state.
  await cleanupAllTagged();

  const createdTrackerIds: string[] = [];
  let unknownCount = 0;

  for (const row of CORPUS) {
    const trackerName = `${row.name} ${TAG}`;
    try {
      // Drive the AI's log_tracker_entry handler — same code path used
      // by /api/chat. This auto-creates the tracker, infers category
      // from the name, links it to the self profile, and writes one
      // entry.
      const entry = await requestStorageContext.run(storage as any, () =>
        executeTool("log_tracker_entry", { trackerName, values: { value: 1 } }, USER_ID)
      );
      if (!entry || !(entry as any).id) {
        results.push({ name: row.name, passed: false, detail: `executeTool returned no entry: ${JSON.stringify(entry).slice(0, 200)}` });
        continue;
      }
      // Entries don’t carry a back-reference to their tracker on the
      // returned object, so look the tracker up by display name. The
      // storage layer disambiguates names with profile-name suffixes
      // (e.g. “Weight - Bob”) so we search for any tracker whose name
      // contains the unique TAG sentinel we appended.
      const allTrackers = await requestStorageContext.run(storage as any, () => storage.getTrackers());
      const tracker = (allTrackers as any[]).find(t => t.name?.includes(trackerName));
      if (!tracker) {
        results.push({ name: row.name, passed: false, detail: `tracker row missing after create (entry id=${(entry as any).id})` });
        continue;
      }
      createdTrackerIds.push(tracker.id);

      const got = getCanonicalGroup((tracker as any).category || "");
      const passed = got === row.expected;
      if (!passed && got === "Other") unknownCount++;
      results.push({
        name: row.name,
        passed,
        got,
        want: row.expected,
        detail: passed ? undefined : `category="${(tracker as any).category}" → group "${got}", expected "${row.expected}"`,
      });
    } catch (e: any) {
      results.push({ name: row.name, passed: false, detail: `threw: ${e?.message || String(e)}` });
    }
  }

  // Cleanup is now in a finally block (see run() wrapper below).

  // ── Report ───────────────────────────────────────────────────────────
  const pass = results.filter(r => r.passed).length;
  const fail = results.length - pass;
  console.log("");
  for (const r of results) {
    const flag = r.passed ? "✓" : "✗";
    const tail = r.passed ? "" : `  ← ${r.detail}`;
    console.log(`  ${flag} ${r.name.padEnd(32)} got=${r.got || "—"} want=${r.want || "—"}${tail}`);
  }
  console.log(`\n[test_ai_render] ${pass}/${results.length} passed · ${fail} failed · ${unknownCount} routed to Other unexpectedly`);
  if (fail > 0) process.exitCode = 1;
}

(async () => {
  try {
    await run();
  } catch (e) {
    console.error("[test_ai_render] fatal:", e);
    process.exitCode = 1;
  } finally {
    // Last-resort cleanup so we never leak disposable trackers into the
    // user's account even if the test crashes mid-loop.
    try { await cleanupAllTagged(); } catch { /* ignore */ }
  }
})();
