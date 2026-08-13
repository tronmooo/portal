// scripts/verify-account-isolation.mjs — the two-account proof, against a
// running deployment.
//
// Reported 2026-08-13: a brand-new account showed Recent Activity and "3
// overdue tasks", and the reporter asked for a test that actually proves one
// account cannot see another's data through the normal application.
//
// This is that test. It creates two real accounts through the public signup
// endpoint, fills Account A with a task/expense/event/habit/tracker/document/
// person/birthday, and then checks — through the SAME HTTP API the browser
// uses, not through a mock:
//
//   • Account B starts with zero records, zero overdue tasks, zero recent
//     activity, both before and after A is populated;
//   • no list endpoint in B returns any of A's rows;
//   • B cannot GET, PATCH or DELETE any of A's records by guessing its id
//     (the "manually changing IDs in requests" case);
//   • unauthenticated and forged-token requests are refused;
//   • writes in B are invisible to A and vice versa, and a delete in one
//     account leaves the other intact;
//   • repeated re-authentication, alternating accounts, never bleeds rows
//     across sessions.
//
// It also asserts the undated-task contract that produced the phantom "3
// overdue tasks", so a regression there fails here too.
//
// Both accounts and all their data are deleted at the end.
//
// Usage:  node scripts/verify-account-isolation.mjs
//         API_BASE=http://localhost:5000/api node scripts/verify-account-isolation.mjs
const BASE = process.env.API_BASE || "https://portol.me/api";
const stamp = Date.now();
const A = { email: `iso-a-${stamp}@example.com`, password: "Iso-Test-2026!aA1" };
const B = { email: `iso-b-${stamp}@example.com`, password: "Iso-Test-2026!bB2" };

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function signup(acct) {
  const r = await api(null, "POST", "/auth/signup", acct);
  if (r.status !== 200) throw new Error(`signup ${acct.email} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { token: r.json.session.access_token, userId: r.json.user.id };
}

const today = new Date().toISOString().slice(0, 10);
const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);

async function main() {
  console.log("── creating two brand-new accounts ──");
  const a = await signup(A);
  const b = await signup(B);
  console.log(`A = ${a.userId}\nB = ${b.userId}\n`);

  // ── 1. Account B starts empty ────────────────────────────────────────────
  // Read B BEFORE A is populated and again after, so "empty" is not an
  // artifact of ordering.
  const bStats0 = await api(b.token, "GET", "/stats");
  check("B starts with zero recent activity",
    Array.isArray(bStats0.json?.recentActivity) && bStats0.json.recentActivity.length === 0,
    `recentActivity=${JSON.stringify(bStats0.json?.recentActivity ?? null)}`);
  check("B starts with zero tasks", bStats0.json?.totalTasks === 0, `totalTasks=${bStats0.json?.totalTasks}`);

  const bEnh0 = await api(b.token, "GET", "/dashboard-enhanced");
  check("B starts with zero overdue tasks",
    Array.isArray(bEnh0.json?.overdueTasks) && bEnh0.json.overdueTasks.length === 0,
    `overdueTasks=${JSON.stringify(bEnh0.json?.overdueTasks ?? null)}`);

  // ── 2. Fill Account A ────────────────────────────────────────────────────
  console.log("\n── filling Account A ──");
  const aProfiles = await api(a.token, "GET", "/profiles");
  const aSelf = (aProfiles.json || []).find((p) => p.type === "self");
  const created = {};
  created.taskOverdue = (await api(a.token, "POST", "/tasks", { title: "A overdue task", dueDate: past, priority: "high" })).json;
  created.taskUndatedDone = (await api(a.token, "POST", "/tasks", { title: "A undated task", priority: "low" })).json;
  created.expense = (await api(a.token, "POST", "/expenses", { description: "A expense", amount: 42, category: "food", date: today })).json;
  created.event = (await api(a.token, "POST", "/events", { title: "A event", date: today })).json;
  created.habit = (await api(a.token, "POST", "/habits", { name: "A habit", frequency: "daily" })).json;
  created.tracker = (await api(a.token, "POST", "/trackers", { name: "A tracker", category: "health", unit: "kg" })).json;
  created.doc = (await api(a.token, "POST", "/documents", { name: "A document", type: "other", mimeType: "text/plain", fileData: "", extractedData: { dateOfBirth: "1990-01-01" } })).json;
  created.person = (await api(a.token, "POST", "/profiles", { name: "A person", type: "person", fields: { birthday: "1990-01-01" } })).json;
  if (aSelf) await api(a.token, "PATCH", `/profiles/${aSelf.id}`, { fields: { birthday: "1985-06-15" } });
  // Mark the undated task done so it lands in Recent Activity.
  if (created.taskUndatedDone?.id) {
    await api(a.token, "PATCH", `/tasks/${created.taskUndatedDone.id}`, { status: "done" });
  }
  const madeIds = Object.entries(created).filter(([, v]) => v?.id).map(([k, v]) => `${k}=${v.id.slice(0, 8)}`);
  console.log(`created: ${madeIds.join(", ")}`);

  const aStats = await api(a.token, "GET", "/stats");
  check("A sees its own data", (aStats.json?.totalTasks ?? 0) >= 2, `totalTasks=${aStats.json?.totalTasks}`);

  // ── 3. The phantom-overdue fix, on real data ─────────────────────────────
  const aEnh = await api(a.token, "GET", "/dashboard-enhanced");
  check("A: the genuinely overdue task IS counted",
    (aEnh.json?.overdueTasks || []).some((t) => t.title === "A overdue task"),
    `overdue=${JSON.stringify((aEnh.json?.overdueTasks || []).map((t) => t.title))}`);

  const win = { start: past, end: new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10) };
  const aTimeline = await api(a.token, "GET", `/calendar/timeline?start=${win.start}&end=${win.end}`);
  const rows = Array.isArray(aTimeline.json) ? aTimeline.json : [];
  const undatedRow = rows.find((r) => r.title === "A undated task");
  check("A: the undated task is flagged `undated` on the timeline",
    !!undatedRow && undatedRow.undated === true,
    undatedRow ? `undated=${undatedRow.undated} completed=${undatedRow.completed} date=${undatedRow.date}` : "row not emitted");
  check("A: a DONE undated task reports completed:true",
    !undatedRow || undatedRow.completed === true,
    undatedRow ? `completed=${undatedRow.completed}` : "n/a");

  // ── 4. B is still empty after A is full ──────────────────────────────────
  console.log("\n── re-reading Account B ──");
  const bStats1 = await api(b.token, "GET", "/stats");
  check("B still has zero recent activity after A is populated",
    (bStats1.json?.recentActivity || []).length === 0,
    JSON.stringify(bStats1.json?.recentActivity ?? null));
  check("B still has zero tasks", bStats1.json?.totalTasks === 0, `totalTasks=${bStats1.json?.totalTasks}`);
  const bEnh1 = await api(b.token, "GET", "/dashboard-enhanced");
  check("B still has zero overdue tasks", (bEnh1.json?.overdueTasks || []).length === 0,
    JSON.stringify((bEnh1.json?.overdueTasks || []).map((t) => t.title)));

  for (const [path, label] of [
    ["/tasks", "tasks"], ["/expenses", "expenses"], ["/events", "events"],
    ["/habits", "habits"], ["/trackers", "trackers"], ["/documents", "documents"],
    ["/goals", "goals"], ["/journal", "journal"], ["/notifications", "notifications"],
    ["/artifacts", "artifacts"], ["/incomes", "incomes"],
  ]) {
    const r = await api(b.token, "GET", path);
    const list = Array.isArray(r.json) ? r.json : (Array.isArray(r.json?.items) ? r.json.items : []);
    const leaked = list.filter((x) => JSON.stringify(x).includes('"A '));
    check(`B's ${label} contain nothing from A`, leaked.length === 0,
      leaked.length ? JSON.stringify(leaked.map((x) => x.title || x.name || x.description)) : `${list.length} row(s), none from A`);
  }

  // B's only profile is its own auto-created self profile.
  const bProfiles = await api(b.token, "GET", "/profiles");
  const bList = bProfiles.json || [];
  check("B's profile list holds only its own self profile",
    bList.length === 1 && bList[0].type === "self",
    JSON.stringify(bList.map((p) => `${p.name}/${p.type}`)));
  check("B's self profile carries no birthday from A",
    !bList[0]?.fields?.birthday && !bList[0]?.fields?.dateOfBirth,
    JSON.stringify(bList[0]?.fields ?? {}));

  // ── 5. B cannot reach A's records by id ──────────────────────────────────
  console.log("\n── B probing A's record ids directly ──");
  const probes = [
    ["task", `/tasks/${created.taskOverdue?.id}`],
    ["expense", `/expenses/${created.expense?.id}`],
    ["event", `/events/${created.event?.id}`],
    ["document", `/documents/${created.doc?.id}`],
    ["profile", `/profiles/${created.person?.id}`],
    ["profile detail", `/profiles/${created.person?.id}/detail`],
    ["tracker", `/trackers/${created.tracker?.id}`],
    ["habit", `/habits/${created.habit?.id}`],
  ];
  for (const [label, path] of probes) {
    if (path.includes("undefined")) { check(`B GET A's ${label} by id`, false, "id missing — A create failed"); continue; }
    const r = await api(b.token, "GET", path);
    const denied = r.status === 404 || r.status === 403;
    check(`B cannot GET A's ${label} by id`, denied, `status=${r.status}`);
  }
  // Writes must be refused too, not just reads.
  for (const [label, path, body] of [
    ["task", `/tasks/${created.taskOverdue?.id}`, { title: "hijacked by B" }],
    ["profile", `/profiles/${created.person?.id}`, { name: "hijacked by B" }],
  ]) {
    const r = await api(b.token, "PATCH", path, body);
    check(`B cannot PATCH A's ${label} by id`, r.status === 404 || r.status === 403, `status=${r.status}`);
  }
  const del = await api(b.token, "DELETE", `/tasks/${created.taskOverdue?.id}`);
  const stillThere = await api(a.token, "GET", `/tasks/${created.taskOverdue?.id}`);
  check("B's DELETE of A's task does not remove it from A",
    stillThere.status === 200 && stillThere.json?.title === "A overdue task",
    `deleteStatus=${del.status} aStillSees=${stillThere.json?.title}`);

  // ── 6. Unauthenticated access ────────────────────────────────────────────
  const anon = await api(null, "GET", "/tasks");
  check("an unauthenticated request is rejected", anon.status === 401, `status=${anon.status}`);
  const badToken = await api("not-a-real-token-but-long-enough-to-pass-length-check", "GET", "/tasks");
  check("a forged token is rejected", badToken.status === 401, `status=${badToken.status}`);

  // ── 7. Writes to B do not appear in A ────────────────────────────────────
  console.log("\n── filling Account B ──");
  const bTask = (await api(b.token, "POST", "/tasks", { title: "B private task", dueDate: past })).json;
  const aTasksAfter = await api(a.token, "GET", "/tasks");
  check("A cannot see B's new task",
    !(aTasksAfter.json || []).some((t) => t.title === "B private task"),
    `${(aTasksAfter.json || []).length} task(s) in A`);
  const bTasksAfter = await api(b.token, "GET", "/tasks");
  check("B sees only its own task",
    (bTasksAfter.json || []).length === 1 && bTasksAfter.json[0].title === "B private task",
    JSON.stringify((bTasksAfter.json || []).map((t) => t.title)));

  // ── 8. Deleting in B leaves A intact ─────────────────────────────────────
  await api(b.token, "DELETE", `/tasks/${bTask.id}`);
  const aTasksFinal = await api(a.token, "GET", "/tasks");
  check("deleting B's task leaves A's tasks intact",
    (aTasksFinal.json || []).some((t) => t.title === "A overdue task"),
    `${(aTasksFinal.json || []).length} task(s) still in A`);

  // ── 9. Repeated re-auth cannot bleed across accounts ─────────────────────
  console.log("\n── re-authenticating both accounts, alternating ──");
  for (let i = 0; i < 2; i++) {
    const ra = await api(null, "POST", "/auth/signin", A);
    const rb = await api(null, "POST", "/auth/signin", B);
    const at = ra.json?.session?.access_token, bt = rb.json?.session?.access_token;
    const at2 = await api(at, "GET", "/tasks");
    const bt2 = await api(bt, "GET", "/tasks");
    check(`round ${i + 1}: A's fresh session sees only A`,
      (at2.json || []).every((t) => t.title.startsWith("A ")), JSON.stringify((at2.json || []).map((t) => t.title)));
    check(`round ${i + 1}: B's fresh session sees zero tasks`,
      (bt2.json || []).length === 0, JSON.stringify((bt2.json || []).map((t) => t.title)));
  }

  // ── cleanup ──────────────────────────────────────────────────────────────
  console.log("\n── cleanup ──");
  for (const [tok, label] of [[a.token, "A"], [b.token, "B"]]) {
    const r = await api(tok, "DELETE", "/data/all", { confirmation: "DELETE" });
    console.log(`  wiped ${label}: status=${r.status}`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  console.log(JSON.stringify({ accountA: a.userId, accountB: b.userId }));
  if (failed.length) { console.log("FAILURES:"); failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`)); process.exit(1); }
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(2); });
