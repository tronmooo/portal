/**
 * Live delete-flow audit for Portol.
 *
 * For every major entity type, this script:
 *   1. Creates a uniquely-marked test entity ("E2E_DELETE_<run-id>_<entity>")
 *   2. Confirms it appears in the list endpoint (backend write OK)
 *   3. DELETEs it and times the call
 *   4. Re-fetches the list and confirms the entity is gone (backend delete OK)
 *
 * Output is a punch-list of what's broken, by category:
 *   - delete returned non-2xx
 *   - delete returned 2xx but entity is still listable (lying success)
 *   - cascade orphans (e.g. habit deleted but checkins remain)
 *   - operations over 1000ms
 *
 * Only entities this script created are deleted — nothing real is touched.
 *
 * Run: npx tsx tests/delete-flows.live.ts
 */

const BASE = "https://portol.me/api";
const SB_URL = "https://uvaniovwrezzzlzmizyg.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDA5MjgsImV4cCI6MjA4OTYxNjkyOH0.0tn5gFfpWN-k5jRUiFehB1cD0BO-DAWP7LQO_IGI1AQ";
const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const MARK = (e: string) => `E2E_DELETE_${RUN_ID}_${e}`;

let TOKEN = "";

type Outcome = {
  entity: string;
  createMs: number;
  deleteMs: number;
  verifyMs: number;
  createStatus: number;
  deleteStatus: number;
  goneAfterDelete: boolean | null; // null = couldn't verify
  notes: string[];
  ok: boolean;
};

const results: Outcome[] = [];

async function api(method: string, path: string, body?: any) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, data, ms: Date.now() - t0 };
}

async function auth() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(SB_URL, SB_ANON);
  const { data, error } = await sb.auth.signInWithPassword({
    email: "tron@aol.com",
    password: "password",
  });
  if (error || !data.session) throw new Error(`Auth failed: ${error?.message}`);
  TOKEN = data.session.access_token;
  console.log(`  Authenticated. Run ID: ${RUN_ID}\n`);
}

/**
 * Run a standard create → list-check → delete → list-check flow.
 * `listPath` defaults to `${createPath}`. `idPath` defaults to `${listPath}/:id`.
 * `marker` is a function that returns true if a list item is the one we made.
 */
async function flow(opts: {
  entity: string;
  createPath: string;
  createBody: any;
  listPath?: string;
  deletePath?: (id: string) => string;
  marker: (item: any) => boolean;
}): Promise<Outcome> {
  const listPath = opts.listPath ?? opts.createPath;
  const notes: string[] = [];
  const out: Outcome = {
    entity: opts.entity,
    createMs: 0, deleteMs: 0, verifyMs: 0,
    createStatus: 0, deleteStatus: 0,
    goneAfterDelete: null,
    notes, ok: false,
  };

  // 1. Create
  const c = await api("POST", opts.createPath, opts.createBody);
  out.createStatus = c.status;
  out.createMs = c.ms;
  if (!c.ok || !c.data?.id) {
    notes.push(`create failed: ${c.status} ${JSON.stringify(c.data).slice(0, 200)}`);
    return out;
  }
  const id = c.data.id;

  // 2. Verify present
  const l1 = await api("GET", listPath);
  if (!l1.ok || !Array.isArray(l1.data) || !l1.data.some(opts.marker)) {
    notes.push(`created entity not visible in ${listPath} list (status ${l1.status})`);
  }

  // 3. Delete
  const delPath = opts.deletePath ? opts.deletePath(id) : `${listPath}/${id}`;
  const d = await api("DELETE", delPath);
  out.deleteStatus = d.status;
  out.deleteMs = d.ms;
  if (!d.ok) {
    notes.push(`delete returned ${d.status}: ${JSON.stringify(d.data).slice(0, 200)}`);
    return out;
  }

  // 4. Verify gone
  const t0 = Date.now();
  const l2 = await api("GET", listPath);
  out.verifyMs = Date.now() - t0;
  if (!Array.isArray(l2.data)) {
    notes.push(`post-delete list returned non-array: ${l2.status}`);
    return out;
  }
  const stillThere = l2.data.find((x: any) => x.id === id);
  out.goneAfterDelete = !stillThere;
  if (stillThere) {
    notes.push(`entity ${id} STILL APPEARS in ${listPath} after DELETE returned ${d.status} — backend lying`);
  }

  out.ok = out.goneAfterDelete === true && d.ok;
  return out;
}

async function run() {
  console.log("\n🧪 PORTOL LIVE DELETE-FLOW AUDIT");
  console.log("=".repeat(60));
  await auth();

  // Order matters: things that other things link to come first; deletes free
  // them. Each block runs independently — failures don't block others.

  // ──────── Tasks ────────
  results.push(await flow({
    entity: "task",
    createPath: "/tasks",
    createBody: { title: MARK("task") },
    marker: (x) => x.title === MARK("task"),
  }));

  // ──────── Expenses ────────
  results.push(await flow({
    entity: "expense",
    createPath: "/expenses",
    createBody: { amount: 0.01, description: MARK("expense"), category: "general" },
    marker: (x) => x.description === MARK("expense"),
  }));

  // ──────── Habits ────────
  results.push(await flow({
    entity: "habit",
    createPath: "/habits",
    createBody: { name: MARK("habit") },
    marker: (x) => x.name === MARK("habit"),
  }));

  // ──────── Events ────────
  results.push(await flow({
    entity: "event",
    createPath: "/events",
    createBody: { title: MARK("event"), date: new Date().toISOString().slice(0, 10) },
    marker: (x) => x.title === MARK("event"),
  }));

  // ──────── Obligations ────────
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  results.push(await flow({
    entity: "obligation",
    createPath: "/obligations",
    createBody: { name: MARK("obligation"), amount: 1, nextDueDate: tomorrow, frequency: "monthly" },
    marker: (x) => x.name === MARK("obligation"),
  }));

  // ──────── Goals ────────
  results.push(await flow({
    entity: "goal",
    createPath: "/goals",
    createBody: { title: MARK("goal"), type: "custom", target: 100, unit: "units" },
    marker: (x) => x.title === MARK("goal"),
  }));

  // ──────── Incomes ────────
  results.push(await flow({
    entity: "income",
    createPath: "/incomes",
    createBody: { description: MARK("income"), amount: 1, category: "salary", frequency: "monthly" },
    marker: (x) => x.description === MARK("income"),
  }));

  // ──────── Paychecks ────────
  results.push(await flow({
    entity: "paycheck",
    createPath: "/paychecks",
    createBody: { amount: 0.01, source: MARK("paycheck"), date: new Date().toISOString().slice(0, 10) },
    marker: (x) => x.source === MARK("paycheck") || x.description === MARK("paycheck"),
  }));

  // ──────── Trackers (+ entry) ────────
  results.push(await flow({
    entity: "tracker",
    createPath: "/trackers",
    createBody: {
      name: MARK("tracker"),
      category: "custom",
      fields: [{ name: "value", type: "number", isPrimary: true }],
    },
    marker: (x) => x.name === MARK("tracker"),
  }));

  // ──────── Documents ────────
  // 1-byte base64 JPEG header is enough — server just stores
  results.push(await flow({
    entity: "document",
    createPath: "/documents",
    createBody: {
      name: MARK("document"),
      type: "other",
      mimeType: "image/jpeg",
      fileData: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA==",
    },
    marker: (x) => x.name === MARK("document"),
  }));

  // ──────── Artifacts ────────
  results.push(await flow({
    entity: "artifact",
    createPath: "/artifacts",
    createBody: { type: "note", title: MARK("artifact"), content: "test" },
    marker: (x) => x.title === MARK("artifact"),
  }));

  // ──────── Journal ────────
  results.push(await flow({
    entity: "journal",
    createPath: "/journal",
    createBody: { mood: "okay", content: MARK("journal"), date: new Date().toISOString().slice(0, 10) },
    listPath: "/journal",
    marker: (x) => x.content === MARK("journal"),
  }));

  // ──────── Memories ────────
  results.push(await flow({
    entity: "memory",
    createPath: "/memories",
    createBody: { key: MARK("memory"), value: "test memory" },
    marker: (x) => x.key === MARK("memory"),
  }));

  // ──────── Profile (no cascade yet — separate test below) ────────
  results.push(await flow({
    entity: "profile",
    createPath: "/profiles",
    createBody: { type: "person", name: MARK("profile") },
    marker: (x) => x.name === MARK("profile"),
  }));

  // ════════════════════════════════════════════════════════════════════
  // CASCADE & ORPHAN TESTS
  // ════════════════════════════════════════════════════════════════════
  console.log("\n  Cascade & orphan tests:");

  // ── Habit checkin orphan test ──
  // Create habit, add checkin, delete habit, then ask backend for that
  // habit's checkins. They should be gone. Static audit suggests they
  // may be orphaned (DELETE /api/habits/:id leaves habit_checkins rows).
  await (async () => {
    const h = await api("POST", "/habits", { name: MARK("habit_orphan") });
    if (!h.ok) { console.log(`    SKIP habit_orphan: create failed ${h.status}`); return; }
    const habitId = h.data.id;
    const today = new Date().toISOString().slice(0, 10);
    const ck = await api("POST", `/habits/${habitId}/checkin`, { date: today });
    if (!ck.ok) { console.log(`    SKIP habit_orphan: checkin failed ${ck.status} ${JSON.stringify(ck.data).slice(0,100)}`); await api("DELETE", `/habits/${habitId}`); return; }
    const beforeDelete = await api("GET", `/habits/${habitId}/checkins`);
    const checkinCountBefore = Array.isArray(beforeDelete.data) ? beforeDelete.data.length : 0;
    const del = await api("DELETE", `/habits/${habitId}`);
    if (!del.ok) { console.log(`    SKIP habit_orphan: habit delete failed ${del.status}`); return; }
    const afterDelete = await api("GET", `/habits/${habitId}/checkins`);
    const checkinCountAfter = Array.isArray(afterDelete.data) ? afterDelete.data.length : "n/a";
    const orphaned = checkinCountBefore > 0 && Array.isArray(afterDelete.data) && afterDelete.data.length > 0;
    console.log(`    habit checkin orphans? ${orphaned ? "YES — BUG" : "no"} (before=${checkinCountBefore} after=${checkinCountAfter})`);
    results.push({
      entity: "habit cascade (checkins)",
      createMs: h.ms + ck.ms, deleteMs: del.ms, verifyMs: 0,
      createStatus: 201, deleteStatus: del.status,
      goneAfterDelete: !orphaned,
      notes: orphaned ? [`habit_checkins not deleted — ${afterDelete.data.length} orphans remain`] : [],
      ok: !orphaned,
    });
  })();

  // ── Profile cascade test ──
  // Create profile, create a task linked to it, delete profile, check that
  // the task is also gone (per routes.ts:2179 — full cascade).
  await (async () => {
    const p = await api("POST", "/profiles", { type: "person", name: MARK("profile_cascade") });
    if (!p.ok) { console.log(`    SKIP profile_cascade: create failed ${p.status}`); return; }
    const profileId = p.data.id;
    const t = await api("POST", "/tasks", {
      title: MARK("task_in_profile"),
      linkedProfiles: [profileId],
    });
    if (!t.ok) { console.log(`    SKIP profile_cascade: task create failed ${t.status}`); await api("DELETE", `/profiles/${profileId}`); return; }
    const taskId = t.data.id;
    const del = await api("DELETE", `/profiles/${profileId}`);
    if (!del.ok) {
      console.log(`    SKIP profile_cascade: profile delete failed ${del.status}`);
      await api("DELETE", `/tasks/${taskId}`);
      return;
    }
    const tasks = await api("GET", "/tasks");
    const orphanTask = Array.isArray(tasks.data) ? tasks.data.find((x: any) => x.id === taskId) : null;
    console.log(`    profile delete cascades to linked task? ${!orphanTask ? "YES — good" : "NO — task " + taskId + " orphaned"} (delete took ${del.ms}ms)`);
    if (orphanTask) {
      await api("DELETE", `/tasks/${taskId}`); // cleanup
    }
    results.push({
      entity: "profile cascade (linked task)",
      createMs: p.ms + t.ms, deleteMs: del.ms, verifyMs: 0,
      createStatus: 201, deleteStatus: del.status,
      goneAfterDelete: !orphanTask,
      notes: orphanTask ? [`task ${taskId} survived profile delete — cascade incomplete`] : [],
      ok: !orphanTask,
    });
  })();

  // ── Soft-delete leak test ──
  // Delete a task (soft delete), then GET /tasks. The soft-deleted row should
  // NOT appear. Static audit suggests task delete sets deleted_at — list must
  // filter on it.
  await (async () => {
    const t = await api("POST", "/tasks", { title: MARK("soft_delete_check") });
    if (!t.ok) { console.log(`    SKIP soft_delete_check: ${t.status}`); return; }
    await api("DELETE", `/tasks/${t.data.id}`);
    const list = await api("GET", "/tasks");
    const leaked = Array.isArray(list.data) && list.data.some((x: any) => x.id === t.data.id);
    console.log(`    soft-deleted task leaks back into /tasks list? ${leaked ? "YES — BUG" : "no"}`);
    if (leaked) {
      results.push({
        entity: "task soft-delete leak",
        createMs: 0, deleteMs: 0, verifyMs: 0,
        createStatus: 201, deleteStatus: 200,
        goneAfterDelete: false,
        notes: ["soft-deleted task still appears in /tasks list"],
        ok: false,
      });
    }
  })();

  // ════════════════════════════════════════════════════════════════════
  // REPORT
  // ════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));

  const SLOW_MS = 1000;
  const pad = (s: any, n: number) => String(s).padEnd(n);

  console.log(`\n${pad("ENTITY", 32)} ${pad("CREATE", 10)} ${pad("DELETE", 10)} ${pad("VERIFY", 10)} STATUS`);
  console.log("-".repeat(80));
  for (const r of results) {
    const status = r.ok ? "✓ OK" : "✗ FAIL";
    const flags: string[] = [];
    if (r.deleteMs > SLOW_MS) flags.push("SLOW");
    if (r.goneAfterDelete === false) flags.push("NOT-GONE");
    if (r.deleteStatus && r.deleteStatus >= 400) flags.push(`HTTP-${r.deleteStatus}`);
    if (r.createStatus && r.createStatus >= 400) flags.push(`CREATE-${r.createStatus}`);
    console.log(
      `${pad(r.entity, 32)} ${pad(r.createMs + "ms", 10)} ${pad(r.deleteMs + "ms", 10)} ${pad(r.verifyMs + "ms", 10)} ${status}${flags.length ? " [" + flags.join(",") + "]" : ""}`
    );
    for (const n of r.notes) console.log(`    └── ${n}`);
  }

  console.log("\n" + "=".repeat(60));
  const failures = results.filter(r => !r.ok);
  const slow = results.filter(r => r.deleteMs > SLOW_MS);
  console.log(`PASSED: ${results.length - failures.length}/${results.length}`);
  console.log(`FAILED: ${failures.length}`);
  console.log(`SLOW   (delete > ${SLOW_MS}ms): ${slow.length}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.entity}: ${f.notes.join("; ")}`);
  }
  if (slow.length) {
    console.log("\nSlow deletes:");
    for (const s of slow) console.log(`  - ${s.entity}: ${s.deleteMs}ms`);
  }
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
