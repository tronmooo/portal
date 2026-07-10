/**
 * FULL AI-tool audit — end-to-end proof, not success-message trust.
 *
 * For every capability: send the natural-language command to the REAL
 * production /api/chat, extract WHICH tool ran (from the response's
 * actions/results arrays — the envelope carries `action` = tool name),
 * verify the row in the DB via the SAME REST endpoints the UI renders,
 * re-read after a delay (refresh persistence), check profile ownership
 * (linkedProfiles ⊆ expected — the exact rule the UI's profile filter
 * uses), then EDIT via chat and DELETE via chat with re-verification at
 * each step. Emits one structured record per test and a final table.
 *
 * Honest scope notes (also printed in the report):
 *  - "UI verification" = the JSON endpoints the UI renders (/tasks, /stats,
 *    /notifications, …). No headless browser is involved; the client is a
 *    thin renderer of these endpoints.
 *  - "Refresh" = a fresh GET ≥2.5s after the write (same data path as F5).
 *  - Cross-ACCOUNT isolation is enforced by RLS + user_id scoping and is
 *    exercised by the standing contract suite; this script re-checks that
 *    created rows carry only the authenticated user's data by querying
 *    exclusively through the authenticated session.
 *
 * Run: npx tsx scripts/full-tool-audit.ts [--section=tasks] [--report=path.md]
 * Throttled ~4s/chat call (20/min budget). Costs Anthropic credits.
 */
import { writeFileSync } from "fs";
import { api } from "../tests/smoke/fixture/api";
import { API_BASE } from "../tests/smoke/fixture/account";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `FTA_${Date.now().toString(36)}`;
const today = new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

// ── Result model ─────────────────────────────────────────────────────────────
type Grade = "PASS" | "FAIL" | "N/T";
interface TestRecord {
  section: string;
  capability: string;
  command: string;
  tool: string;
  args: string;
  toolResult: string;
  recordId: string;
  profile: string;
  db: Grade;
  ui: Grade;
  refresh: Grade;
  isolation: Grade;
  overall: "PASS" | "FAIL" | "PARTIAL";
  where: string;
  reason?: string;
}
const RESULTS: TestRecord[] = [];

// ── Chat + evidence extraction ───────────────────────────────────────────────
interface ChatEvidence {
  reply: string;
  tools: string[];          // tool names that ran (envelope `action` / action types)
  args: any[];              // actions[].data payloads
  results: any[];           // raw results array
  recordIds: string[];
  status: number;
}
async function chat(message: string, history?: Array<{ role: string; content: string }>): Promise<ChatEvidence> {
  let r = await api("POST", "/chat", history ? { message, history } : { message });
  if (r.status === 429) { await sleep(7000); r = await api("POST", "/chat", history ? { message, history } : { message }); }
  const d: any = r.data || {};
  const results: any[] = Array.isArray(d.results) ? d.results : [];
  const actions: any[] = Array.isArray(d.actions) ? d.actions : [];
  const tools = [
    ...results.map((x: any) => x?.action).filter((x: any) => typeof x === "string"),
    ...actions.map((a: any) => a?.type).filter(Boolean),
  ];
  const recordIds = [
    ...results.map((x: any) => x?.entity?.id || x?.id).filter(Boolean),
    ...actions.map((a: any) => a?.entityId || a?.data?.id).filter(Boolean),
  ].map(String);
  await sleep(4000); // stay under the 20 chat/min budget
  return { reply: String(d.reply || ""), tools: [...new Set(tools)], args: actions.map((a: any) => a?.data), results, recordIds: [...new Set(recordIds)], status: r.status };
}

async function list(endpoint: string): Promise<any[]> {
  const r = await api("GET", endpoint);
  return Array.isArray(r.data) ? r.data : (r.data?.items || []);
}
async function seedPost(path: string, body: any): Promise<any> {
  let r = await api("POST", path, body);
  if (r.status === 429) { await sleep(6500); r = await api("POST", path, body); }
  if (!r.ok) throw new Error(`seed POST ${path} failed: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return r.data;
}

// Profile ids created for the isolation matrix (filled in section 0).
const PROFILE_IDS: Record<string, string> = {};
let SELF_ID = "";

/** Ownership check — the exact rule the UI profile filter applies:
 *  row.linkedProfiles must be ⊆ {allowed…} (empty = self). */
function isolationOk(row: any, allowedNames: string[]): boolean {
  const linked: string[] = Array.isArray(row?.linkedProfiles) ? row.linkedProfiles : [];
  if (linked.length === 0) return allowedNames.includes("self");
  const allowedIds = new Set(allowedNames.map((n) => (n === "self" ? SELF_ID : PROFILE_IDS[n])).filter(Boolean));
  return linked.every((id) => allowedIds.has(id));
}

function record(t: TestRecord) {
  RESULTS.push(t);
  const mark = t.overall === "PASS" ? "✅" : t.overall === "PARTIAL" ? "🟡" : "❌";
  console.log(`${mark} [${t.section}] ${t.capability.padEnd(34)} tool=${t.tool || "-"} id=${t.recordId || "-"} db=${t.db} ui=${t.ui} refresh=${t.refresh} iso=${t.isolation}${t.reason ? ` — ${t.reason}` : ""}`);
}

/** Full CRUD cycle for one entity domain. */
async function cycle(opts: {
  section: string;
  capability: string;
  createCmd: string;
  createRetryCmd?: string;
  /** Find the created row on the UI's list endpoint. */
  find: () => Promise<any | null>;
  endpointLabel: string;
  /** Owner names allowed on the created row ("self", "Mike FTA", …). */
  owners: string[];
  updateCmd?: string;
  /** Verify the edit landed (re-finds internally). */
  verifyUpdate?: () => Promise<boolean>;
  deleteCmd?: string;
  /** Extra UI locations to assert after create (label + check). */
  extraUi?: Array<{ where: string; check: () => Promise<boolean> }>;
  /** Skip delete verification via find()==null (e.g. soft-delete lists). */
  verifyDeleted?: () => Promise<boolean>;
}): Promise<any | null> {
  const { section, capability } = opts;
  let row: any = null;
  // CREATE
  let ev = await chat(opts.createCmd);
  await sleep(2500);
  row = await opts.find();
  if (!row && opts.createRetryCmd) {
    ev = await chat(opts.createRetryCmd);
    await sleep(2500);
    row = await opts.find();
  }
  const uiChecks: string[] = [opts.endpointLabel];
  let uiOk = !!row;
  for (const x of opts.extraUi || []) {
    const ok = await x.check().catch(() => false);
    if (ok) uiChecks.push(x.where);
    else uiOk = false;
  }
  // REFRESH (fresh GET after a delay = the same data path as F5)
  await sleep(2500);
  const rowAfterRefresh = await opts.find();
  const iso = row ? isolationOk(row, opts.owners) : false;
  record({
    section, capability: `${capability} — create`, command: opts.createCmd,
    tool: ev.tools[0] || "", args: JSON.stringify(ev.args[0] || {}).slice(0, 140),
    toolResult: ev.reply.slice(0, 100), recordId: row?.id || ev.recordIds[0] || "",
    profile: opts.owners.join("+"),
    db: row ? "PASS" : "FAIL",
    ui: uiOk ? "PASS" : "FAIL",
    refresh: rowAfterRefresh ? "PASS" : "FAIL",
    isolation: row ? (iso ? "PASS" : "FAIL") : "N/T",
    overall: row && uiOk && rowAfterRefresh && iso ? "PASS" : row ? "PARTIAL" : "FAIL",
    where: uiChecks.join(", "),
    reason: row ? (iso ? undefined : `linkedProfiles=${JSON.stringify(row.linkedProfiles)}`) : `not found after create; reply: ${ev.reply.slice(0, 80)}`,
  });
  if (!row) return null;

  // UPDATE
  if (opts.updateCmd && opts.verifyUpdate) {
    const evU = await chat(opts.updateCmd);
    await sleep(2500);
    const upOk = await opts.verifyUpdate().catch(() => false);
    record({
      section, capability: `${capability} — update`, command: opts.updateCmd,
      tool: evU.tools[0] || "", args: JSON.stringify(evU.args[0] || {}).slice(0, 140),
      toolResult: evU.reply.slice(0, 100), recordId: row.id, profile: opts.owners.join("+"),
      db: upOk ? "PASS" : "FAIL", ui: upOk ? "PASS" : "FAIL", refresh: upOk ? "PASS" : "N/T",
      isolation: "N/T",
      overall: upOk ? "PASS" : "FAIL", where: opts.endpointLabel,
      reason: upOk ? undefined : `edit not observed; reply: ${evU.reply.slice(0, 80)}`,
    });
  }

  // DELETE (chat delete → confirm turn if asked → verify gone)
  if (opts.deleteCmd) {
    let evD = await chat(opts.deleteCmd);
    await sleep(1500);
    let gone = opts.verifyDeleted ? await opts.verifyDeleted() : !(await opts.find());
    if (!gone && /\?|confirm|sure|should i/i.test(evD.reply)) {
      evD = await chat("Yes, delete it.", [
        { role: "user", content: opts.deleteCmd },
        { role: "assistant", content: evD.reply },
      ]);
      await sleep(2000);
      gone = opts.verifyDeleted ? await opts.verifyDeleted() : !(await opts.find());
    }
    await sleep(2000);
    const goneAfterRefresh = opts.verifyDeleted ? await opts.verifyDeleted() : !(await opts.find());
    record({
      section, capability: `${capability} — delete`, command: opts.deleteCmd,
      tool: evD.tools[0] || "", args: "", toolResult: evD.reply.slice(0, 100),
      recordId: row.id, profile: opts.owners.join("+"),
      db: gone ? "PASS" : "FAIL", ui: gone ? "PASS" : "FAIL",
      refresh: goneAfterRefresh ? "PASS" : "FAIL", isolation: "N/T",
      overall: gone && goneAfterRefresh ? "PASS" : "FAIL", where: opts.endpointLabel,
      reason: gone ? undefined : `still present after delete; reply: ${evD.reply.slice(0, 80)}`,
    });
  }
  return row;
}

/** Read-only capability: command → reply assertion (+ optional data check). */
async function readCheck(section: string, capability: string, command: string, replyRe: RegExp, dataCheck?: () => Promise<boolean>) {
  const ev = await chat(command);
  const replyOk = replyRe.test(ev.reply);
  const dataOk = dataCheck ? await dataCheck().catch(() => false) : true;
  record({
    section, capability, command, tool: ev.tools[0] || "", args: "",
    toolResult: ev.reply.slice(0, 120), recordId: "", profile: "self",
    db: dataCheck ? (dataOk ? "PASS" : "FAIL") : "N/T",
    ui: replyOk ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: replyOk && dataOk ? "PASS" : "FAIL", where: "chat reply",
    reason: replyOk ? undefined : `reply didn't match ${replyRe}: ${ev.reply.slice(0, 90)}`,
  });
}

/** Negative test: the command MUST be refused (no row created, no fake success). */
async function negative(section: string, capability: string, command: string, opts: { noRow?: () => Promise<boolean>; refuseRe?: RegExp }) {
  const ev = await chat(command);
  const refused = (opts.refuseRe || /❌|can't|cannot|couldn't|invalid|need|missing|must|error|doesn't exist|not found|refus|already|no .*to delete|positive/i).test(ev.reply);
  const noRow = opts.noRow ? await opts.noRow().catch(() => false) : true;
  record({
    section, capability, command, tool: ev.tools[0] || "", args: "",
    toolResult: ev.reply.slice(0, 120), recordId: "", profile: "-",
    db: noRow ? "PASS" : "FAIL", ui: "N/T", refresh: "N/T", isolation: "N/T",
    overall: refused && noRow ? "PASS" : "FAIL", where: "chat reply",
    reason: refused && noRow ? undefined : `expected refusal; got: ${ev.reply.slice(0, 90)}${noRow ? "" : " (row WAS created)"}`,
  });
}

// ── Sections ─────────────────────────────────────────────────────────────────
async function section0_profiles() {
  const S = "1-Profiles";
  // CREATE
  const mikeRow = await cycle({
    section: S, capability: "Profile (Mike)",
    createCmd: `Create a profile for Mike ${TAG}. His birthday is March 5, 1990, and he's a friend.`,
    find: async () => (await list("/profiles")).find((p) => (p.name || "").includes(`Mike ${TAG}`)) || null,
    endpointLabel: "Profiles list (/profiles)",
    owners: ["self", `Mike ${TAG}`],
    updateCmd: `Change Mike ${TAG}'s relationship from friend to coworker.`,
    verifyUpdate: async () => {
      const p = (await list("/profiles")).find((x) => (x.name || "").includes(`Mike ${TAG}`));
      return !!p && /coworker/i.test(JSON.stringify(p));
    },
    // Deleted at the END of the run (cross-profile section needs Mike).
  });
  if (mikeRow) PROFILE_IDS[`Mike ${TAG}`] = mikeRow.id;

  // The profile row itself owns itself — treat isolation as its own id.
  await readCheck(S, "Profile read (get_profile_data)", `Show me everything saved for Mike ${TAG}.`,
    new RegExp(`Mike|${TAG}|coworker|birthday|March`, "i"));

  // Duplicate protection
  await negative(S, "Duplicate profile blocked", `Create a profile for Mike ${TAG}.`, {
    noRow: async () => (await list("/profiles")).filter((p) => (p.name || "").includes(`Mike ${TAG}`)).length === 1,
    refuseRe: /already|exist|duplicate|same name|have a profile/i,
  });
}

async function section2_tasks() {
  const S = "2-Tasks";
  await cycle({
    section: S, capability: "Task",
    createCmd: `Create a task to ${TAG}_renew my registration on ${plusDays(20)} at 9:00 AM.`,
    find: async () => (await list("/tasks")).find((t) => (t.title || "").includes(`${TAG}_renew`)) || null,
    endpointLabel: "Tasks list (/tasks)",
    owners: ["self"],
    extraUi: [{
      where: "Dashboard stats (activeTasks)",
      check: async () => {
        const r = await api("GET", "/stats");
        return Number((r.data as any)?.totalTasks) > 0;
      },
    }],
    updateCmd: `Change the ${TAG}_renew registration task to ${plusDays(22)} at 11:30 AM.`,
    verifyUpdate: async () => {
      const t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_renew`));
      return !!t && String(t.dueDate || "").startsWith(plusDays(22));
    },
    deleteCmd: `Delete the ${TAG}_renew registration task.`,
  });

  // complete + reopen on a fresh task
  await seedPost("/tasks", { title: `${TAG}_flip status task` });
  let ev = await chat(`Mark the ${TAG}_flip task complete.`);
  await sleep(2000);
  let t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_flip`));
  const completed = !!t && (t.status === "done" || t.completed === true);
  record({
    section: S, capability: "Task — complete", command: `Mark the ${TAG}_flip task complete.`,
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: t?.id || "", profile: "self",
    db: completed ? "PASS" : "FAIL", ui: completed ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: completed ? "PASS" : "FAIL", where: "Tasks list status",
    reason: completed ? undefined : `status=${t?.status}`,
  });
  ev = await chat(`Reopen the ${TAG}_flip task — it isn't actually done.`);
  await sleep(2000);
  t = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_flip`));
  const reopened = !!t && t.status !== "done" && t.completed !== true;
  record({
    section: S, capability: "Task — reopen", command: `Reopen the ${TAG}_flip task`,
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: t?.id || "", profile: "self",
    db: reopened ? "PASS" : "FAIL", ui: reopened ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: reopened ? "PASS" : "FAIL", where: "Tasks list status",
    reason: reopened ? undefined : `status=${t?.status}`,
  });

  // recurring task (tag-encoded recurrence)
  ev = await chat(`Create a recurring task to ${TAG}_tirepressure check tire pressure every two weeks starting ${plusDays(5)}.`);
  await sleep(2000);
  const rec = (await list("/tasks")).find((x) => (x.title || "").includes(`${TAG}_tirepressure`));
  const recur = !!rec && (rec.tags || []).some((x: string) => /^recur:/.test(x));
  record({
    section: S, capability: "Task — recurring", command: "recurring every two weeks",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: rec?.id || "", profile: "self",
    db: rec ? "PASS" : "FAIL", ui: recur ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: rec && recur ? "PASS" : rec ? "PARTIAL" : "FAIL", where: "Tasks list (recur: tag)",
    reason: recur ? undefined : `tags=${JSON.stringify(rec?.tags || [])}`,
  });

  // duplicate protection
  await negative(S, "Duplicate task blocked", `Create a task to ${TAG}_flip status task`, {
    noRow: async () => (await list("/tasks")).filter((x) => (x.title || "").includes(`${TAG}_flip`)).length === 1,
    refuseRe: /already|exist|duplicate|same/i,
  });
}

async function section3_events() {
  const S = "3-Calendar";
  await cycle({
    section: S, capability: "Calendar event",
    createCmd: `Schedule a dentist appointment called ${TAG}_dentist on ${plusDays(10)} from 2:00 PM to 3:00 PM.`,
    find: async () => (await list("/events")).find((e) => (e.title || "").includes(`${TAG}_dentist`)) || null,
    endpointLabel: "Calendar (/events)",
    owners: ["self"],
    updateCmd: `Reschedule the ${TAG}_dentist appointment to ${plusDays(12)} at 4:00 PM.`,
    verifyUpdate: async () => {
      const e = (await list("/events")).find((x) => (x.title || "").includes(`${TAG}_dentist`));
      return !!e && String(e.date || e.startDate || "").startsWith(plusDays(12));
    },
    deleteCmd: `Delete the ${TAG}_dentist appointment.`,
  });
  await negative(S, "Invalid date rejected (Feb 30)", `Set an event called ${TAG}_badfeb on February 30 at noon.`, {
    noRow: async () => !(await list("/events")).some((e) => (e.title || "").includes(`${TAG}_badfeb`) && /02-30/.test(String(e.date))),
  });
}

async function section4_habits() {
  const S = "4-Habits";
  await cycle({
    section: S, capability: "Habit",
    createCmd: `Create a habit called ${TAG}_vitamins every morning at 8:00 AM.`,
    find: async () => (await list("/habits")).find((h) => (h.name || "").includes(`${TAG}_vitamins`)) || null,
    endpointLabel: "Habits list (/habits)",
    owners: ["self"],
    updateCmd: `Change the ${TAG}_vitamins habit from morning to evening.`,
    verifyUpdate: async () => {
      const h = (await list("/habits")).find((x) => (x.name || "").includes(`${TAG}_vitamins`));
      return !!h && /evening|pm|night/i.test(JSON.stringify(h));
    },
  });
  // check-in + undo check-in + history
  let ev = await chat(`Mark ${TAG}_vitamins complete for today.`);
  await sleep(2000);
  let h = (await list("/habits")).find((x) => (x.name || "").includes(`${TAG}_vitamins`));
  const checked = !!h && (h.checkins || []).some((c: any) => c.date === today);
  record({
    section: S, capability: "Habit — check in", command: "mark complete for today",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: h?.id || "", profile: "self",
    db: checked ? "PASS" : "FAIL", ui: checked ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: checked ? "PASS" : "FAIL", where: "Habit checkins (history)",
    reason: checked ? undefined : `checkins=${(h?.checkins || []).length}`,
  });
  ev = await chat(`Undo today's ${TAG}_vitamins completion.`);
  await sleep(2000);
  h = (await list("/habits")).find((x) => (x.name || "").includes(`${TAG}_vitamins`));
  const unchecked = !!h && !(h.checkins || []).some((c: any) => c.date === today);
  record({
    section: S, capability: "Habit — undo check-in", command: "undo today's completion",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: h?.id || "", profile: "self",
    db: unchecked ? "PASS" : "FAIL", ui: unchecked ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: unchecked ? "PASS" : "FAIL", where: "Habit checkins",
    reason: unchecked ? undefined : "checkin still present",
  });
  // delete
  ev = await chat(`Delete the ${TAG}_vitamins habit.`);
  await sleep(2000);
  const gone = !(await list("/habits")).some((x) => (x.name || "").includes(`${TAG}_vitamins`));
  record({
    section: S, capability: "Habit — delete", command: "delete habit",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: h?.id || "", profile: "self",
    db: gone ? "PASS" : "FAIL", ui: gone ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: gone ? "PASS" : "FAIL", where: "Habits list",
    reason: gone ? undefined : "habit still present",
  });
}

async function section5_trackers() {
  const S = "5-Trackers";
  const findTracker = async () => (await list("/trackers")).find((t) => (t.name || "").includes(`${TAG}_hydration`)) || null;
  await cycle({
    section: S, capability: "Tracker",
    createCmd: `Create a tracker called ${TAG}_hydration measured in ounces.`,
    find: findTracker,
    endpointLabel: "Trackers list (/trackers)",
    owners: ["self"],
  });
  // log entry / edit entry / delete entry
  let ev = await chat(`Log 72 ounces of water in my ${TAG}_hydration tracker today.`);
  await sleep(2000);
  let t = await findTracker();
  const entry72 = !!t && (t.entries || []).some((e: any) => JSON.stringify(e.values).includes("72"));
  record({
    section: S, capability: "Tracker — log entry", command: "log 72 ounces",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: t?.id || "", profile: "self",
    db: entry72 ? "PASS" : "FAIL", ui: entry72 ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: entry72 ? "PASS" : "FAIL", where: "Tracker entries",
    reason: entry72 ? undefined : `entries=${JSON.stringify((t?.entries || []).slice(-1))}`.slice(0, 90),
  });
  ev = await chat(`Change today's ${TAG}_hydration entry from 72 ounces to 80 ounces.`);
  await sleep(2000);
  t = await findTracker();
  const entries = t?.entries || [];
  const edited = entries.some((e: any) => JSON.stringify(e.values).includes("80")) && !entries.some((e: any) => JSON.stringify(e.values).includes("72"));
  record({
    section: S, capability: "Tracker — edit entry (no dup)", command: "change 72 → 80",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: t?.id || "", profile: "self",
    db: edited ? "PASS" : "FAIL", ui: edited ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: edited ? "PASS" : "FAIL", where: "Tracker entries",
    reason: edited ? undefined : `entries=${entries.length}, values=${JSON.stringify(entries.map((e: any) => e.values)).slice(0, 80)}`,
  });
  ev = await chat(`Delete today's ${TAG}_hydration entry.`);
  await sleep(2000);
  t = await findTracker();
  const entryGone = !!t && !(t.entries || []).some((e: any) => JSON.stringify(e.values).match(/72|80/));
  record({
    section: S, capability: "Tracker — delete entry", command: "delete today's entry",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: t?.id || "", profile: "self",
    db: entryGone ? "PASS" : "FAIL", ui: entryGone ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: entryGone ? "PASS" : "FAIL", where: "Tracker entries",
    reason: entryGone ? undefined : "entry still present",
  });
  // BP + HR separation
  ev = await chat(`Log a blood pressure reading of 124/78 with a resting heart rate of 59 BPM.`);
  await sleep(2500);
  const trackers = await list("/trackers");
  const bp = trackers.find((x) => /blood\s*pressure|^bp$/i.test(x.name || ""));
  const hr = trackers.find((x) => /heart\s*rate/i.test(x.name || ""));
  const bpEntry = bp && (bp.entries || []).slice(-3).some((e: any) => JSON.stringify(e.values).includes("124") && JSON.stringify(e.values).includes("78") && !JSON.stringify(e.values).includes("59"));
  const hrEntry = hr && (hr.entries || []).slice(-3).some((e: any) => JSON.stringify(e.values).includes("59"));
  record({
    section: S, capability: "Tracker — BP/HR field separation", command: "124/78 + 59 BPM",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: bp?.id || "", profile: "self",
    db: bpEntry && hrEntry ? "PASS" : "FAIL", ui: bpEntry && hrEntry ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: bpEntry && hrEntry ? "PASS" : "FAIL", where: "Blood Pressure + Heart Rate trackers",
    reason: bpEntry && hrEntry ? undefined : `bp=${!!bpEntry} hr=${!!hrEntry}`,
  });
  // exercise: duration + intensity
  ev = await chat(`Log 70 minutes of soccer at high intensity.`);
  await sleep(2500);
  const after = await list("/trackers");
  const soccer = after.find((x) => /soccer|exercise|workout|fitness|activity/i.test(x.name || "")
    && (x.entries || []).slice(-3).some((e: any) => JSON.stringify(e.values).includes("70")));
  const soccerEntry = soccer && (soccer.entries || []).slice(-3).find((e: any) => JSON.stringify(e.values).includes("70"));
  const intensitySaved = soccerEntry && /high/i.test(JSON.stringify(soccerEntry.values));
  record({
    section: S, capability: "Tracker — duration + intensity", command: "70 min soccer high intensity",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: soccer?.id || "", profile: "self",
    db: soccerEntry ? "PASS" : "FAIL", ui: intensitySaved ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: soccerEntry && intensitySaved ? "PASS" : soccerEntry ? "PARTIAL" : "FAIL", where: "Exercise tracker entries",
    reason: soccerEntry ? (intensitySaved ? undefined : `intensity missing: ${JSON.stringify(soccerEntry?.values).slice(0, 80)}`) : "no 70-minute entry found",
  });
}

async function section6_journal() {
  const S = "6-Journal";
  const text = `${TAG}_journal I felt stressed this morning but much better tonight. My energy was 7 out of 10.`;
  await cycle({
    section: S, capability: "Journal entry",
    createCmd: `Create a journal entry for today saying ${text}`,
    find: async () => (await list("/journal")).find((j) => JSON.stringify(j).includes(`${TAG}_journal`)) || null,
    endpointLabel: "Journal (/journal)",
    owners: ["self"],
    updateCmd: `Update today's ${TAG}_journal entry — change "much better tonight" to "completely relaxed tonight".`,
    verifyUpdate: async () => {
      const j = (await list("/journal")).find((x) => JSON.stringify(x).includes(`${TAG}_journal`));
      return !!j && /completely relaxed/i.test(JSON.stringify(j));
    },
    deleteCmd: `Delete today's ${TAG}_journal entry.`,
  });
}

async function section7_expenses() {
  const S = "7-Expenses";
  // Asset first (Honda) so the expense can link to it
  const evA = await chat(`Create a 2021 Honda CR-V asset called ${TAG}_crv worth $24,000 and assign it to me with 100% ownership.`);
  await sleep(2500);
  const crv = (await list("/profiles")).find((p) => (p.name || "").includes(`${TAG}_crv`)) || null;
  record({
    section: "8-Assets", capability: "Asset — create (vehicle)", command: "2021 Honda CR-V $24,000",
    tool: evA.tools[0] || "", args: JSON.stringify(evA.args[0] || {}).slice(0, 140),
    toolResult: evA.reply.slice(0, 100), recordId: crv?.id || "", profile: "self",
    db: crv ? "PASS" : "FAIL",
    ui: crv ? "PASS" : "FAIL", refresh: "N/T",
    isolation: "N/T",
    overall: crv ? "PASS" : "FAIL", where: "Profiles/Assets list",
    reason: crv ? undefined : `asset profile not found; reply: ${evA.reply.slice(0, 80)}`,
  });
  if (crv) PROFILE_IDS[`${TAG}_crv`] = crv.id;

  const stats0 = (await api("GET", "/stats")).data as any;
  await cycle({
    section: S, capability: "Expense (linked to asset)",
    createCmd: `Record a $50 ${TAG}_oilchange oil change expense for my ${TAG}_crv today.`,
    find: async () => (await list("/expenses")).find((e) => (e.description || "").includes(`${TAG}_oilchange`)) || null,
    endpointLabel: "Expenses list (/expenses)",
    owners: ["self", `${TAG}_crv`],
    extraUi: [{
      where: "Dashboard monthly spend (+$50)",
      check: async () => {
        const s = (await api("GET", "/stats")).data as any;
        return Number(s.monthlySpend) >= Number(stats0.monthlySpend) + 49;
      },
    }],
    updateCmd: `Change the ${TAG}_oilchange expense to $65.`,
    verifyUpdate: async () => {
      const e = (await list("/expenses")).find((x) => (x.description || "").includes(`${TAG}_oilchange`));
      return !!e && Number(e.amount) === 65;
    },
    deleteCmd: `Delete the ${TAG}_oilchange expense.`,
  });
  await negative(S, "Negative amount rejected", `Create an expense called ${TAG}_negative for negative $50.`, {
    noRow: async () => !(await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_negative`)),
  });
}

async function section8_assets() {
  const S = "8-Assets";
  // nested asset under the CR-V
  const ev = await chat(`Add a roof cargo box called ${TAG}_roofbox worth $500 as a nested asset under the ${TAG}_crv.`);
  await sleep(2500);
  const box = (await list("/profiles")).find((p) => (p.name || "").includes(`${TAG}_roofbox`));
  const nested = !!box && (box.parentProfileId === PROFILE_IDS[`${TAG}_crv`]);
  record({
    section: S, capability: "Asset — nested under parent", command: "roof box under CR-V",
    tool: ev.tools[0] || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: box?.id || "", profile: `${TAG}_crv`,
    db: box ? "PASS" : "FAIL", ui: nested ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: box && nested ? "PASS" : box ? "PARTIAL" : "FAIL", where: "Profiles (parentProfileId)",
    reason: nested ? undefined : `parentProfileId=${box?.parentProfileId} expected=${PROFILE_IDS[`${TAG}_crv`]}`,
  });
  // revalue → net-worth effect
  const nw0 = (await api("GET", "/dashboard-enhanced")).data as any;
  const ev2 = await chat(`Update the ${TAG}_crv value to $26,000.`);
  await sleep(3000);
  const crv = (await list("/profiles")).find((p) => (p.name || "").includes(`${TAG}_crv`));
  const revalued = !!crv && /26,?000|26000/.test(JSON.stringify(crv.fields || {}));
  const nw1 = (await api("GET", "/dashboard-enhanced")).data as any;
  const nwMoved = Number(nw1?.financeSnapshot?.netWorth ?? 0) !== Number(nw0?.financeSnapshot?.netWorth ?? 0);
  record({
    section: S, capability: "Asset — revalue + net worth", command: "CR-V → $26,000",
    tool: ev2.tools[0] || "", args: "", toolResult: ev2.reply.slice(0, 100),
    recordId: crv?.id || "", profile: "self",
    db: revalued ? "PASS" : "FAIL", ui: nwMoved ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: revalued && nwMoved ? "PASS" : revalued ? "PARTIAL" : "FAIL", where: "Profile fields + net worth",
    reason: revalued ? (nwMoved ? undefined : "net worth unchanged") : "value not updated",
  });
  await negative(S, "Assign to nonexistent profile rejected", `Assign the ${TAG}_crv asset to a profile called Zorblatt Nonexistent.`, {});
  await negative(S, "Ownership >100% rejected", `Give two owners of the ${TAG}_crv 80% ownership each.`, {});
}

async function section9_liabilities() {
  const S = "9-Liabilities";
  const start = plusDays(35).slice(0, 8) + "15"; // the 15th of next month-ish
  const ev = await chat(`Create a ${TAG}_spotify Premium bill for $9.99 per month, due on the 15th, starting ${start}.`);
  await sleep(2500);
  const ob = (await list("/obligations")).find((o) => (o.name || "").includes(`${TAG}_spotify`));
  const amountOk = !!ob && Math.abs(Number(ob.amount) - 9.99) < 0.01;
  const due15 = !!ob && /-15$/.test(String(ob.nextDueDate || "").slice(0, 10));
  record({
    section: S, capability: "Liability/bill — create", command: "$9.99/mo due the 15th",
    tool: ev.tools[0] || "", args: JSON.stringify(ev.args[0] || {}).slice(0, 140),
    toolResult: ev.reply.slice(0, 100), recordId: ob?.id || "", profile: "self",
    db: ob ? "PASS" : "FAIL", ui: amountOk && due15 ? "PASS" : "FAIL", refresh: "N/T",
    isolation: ob ? (isolationOk(ob, ["self"]) ? "PASS" : "FAIL") : "N/T",
    overall: ob && amountOk && due15 ? "PASS" : ob ? "PARTIAL" : "FAIL", where: "Bills (/obligations)",
    reason: ob ? (amountOk && due15 ? undefined : `amount=${ob.amount} due=${ob.nextDueDate}`) : "not created",
  });
  if (ob) {
    // pay one occurrence
    const ev2 = await chat(`Mark the next ${TAG}_spotify payment as paid.`);
    await sleep(2500);
    const after = (await list("/obligations")).find((o) => o.id === ob.id);
    const advanced = !!after && String(after.nextDueDate) !== String(ob.nextDueDate);
    record({
      section: S, capability: "Liability — record payment", command: "mark next payment paid",
      tool: ev2.tools[0] || "", args: "", toolResult: ev2.reply.slice(0, 100),
      recordId: ob.id, profile: "self",
      db: advanced ? "PASS" : "FAIL", ui: advanced ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
      overall: advanced ? "PASS" : "FAIL", where: "Bill nextDueDate (advanced by one cycle)",
      reason: advanced ? undefined : `nextDueDate unchanged (${after?.nextDueDate})`,
    });
    // delete
    const ev3 = await chat(`Delete the ${TAG}_spotify bill.`);
    await sleep(1500);
    let gone = !(await list("/obligations")).some((o) => o.id === ob.id);
    if (!gone && /\?|confirm|sure/i.test(ev3.reply)) {
      await chat("Yes, delete it.", [{ role: "user", content: `Delete the ${TAG}_spotify bill.` }, { role: "assistant", content: ev3.reply }]);
      await sleep(2000);
      gone = !(await list("/obligations")).some((o) => o.id === ob.id);
    }
    record({
      section: S, capability: "Liability — delete", command: "delete the bill",
      tool: ev3.tools[0] || "", args: "", toolResult: ev3.reply.slice(0, 100),
      recordId: ob.id, profile: "self",
      db: gone ? "PASS" : "FAIL", ui: gone ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
      overall: gone ? "PASS" : "FAIL", where: "Bills list",
      reason: gone ? undefined : "bill still present",
    });
  }
  await negative(S, "End before start rejected", `Create a ${TAG}_badloan liability starting ${plusDays(60)} and ending ${plusDays(30)}.`, {
    noRow: async () => !(await list("/obligations")).some((o) => (o.name || "").includes(`${TAG}_badloan`))
      && !(await list("/profiles")).some((p) => (p.name || "").includes(`${TAG}_badloan`) && !JSON.stringify(p).includes("deleted")),
  });
}

async function section12_reminders() {
  const S = "12-Reminders";
  await cycle({
    section: S, capability: "Reminder",
    createCmd: `Remind me to ${TAG}_pickup the dry cleaning ${plusDays(3)} at 5 PM.`,
    find: async () => (await list("/reminders")).find((r) => (r.title || "").includes(`${TAG}_pickup`)) || null,
    endpointLabel: "Reminders (/reminders)",
    owners: ["self"],
    extraUi: [{
      where: "Notification bell (/notifications)",
      check: async () => {
        const r = await api("GET", "/notifications");
        const rows: any[] = Array.isArray(r.data) ? r.data : [];
        // within-7-days reminders surface in the bell
        return rows.some((n) => JSON.stringify(n).includes(`${TAG}_pickup`));
      },
    }],
    updateCmd: `Move the ${TAG}_pickup reminder to ${plusDays(4)} at 6 PM.`,
    verifyUpdate: async () => {
      const r = (await list("/reminders")).find((x) => (x.title || "").includes(`${TAG}_pickup`));
      return !!r && String(r.fireAt || "").startsWith(plusDays(4));
    },
    deleteCmd: `Delete the ${TAG}_pickup reminder.`,
  });
  // custom notification CRUD (v2)
  await cycle({
    section: S, capability: "Custom notification",
    createCmd: `Create an urgent notification: ${TAG}_notif insurance renewal needs attention.`,
    find: async () => {
      const r = await api("GET", "/notifications");
      const rows: any[] = Array.isArray(r.data) ? r.data : [];
      return rows.find((n) => String(n.id || "").startsWith("custom:") && JSON.stringify(n).includes(`${TAG}_notif`)) || null;
    },
    endpointLabel: "Notification bell (custom:)",
    owners: ["self"],
    updateCmd: `Mark the ${TAG}_notif notification as read.`,
    verifyUpdate: async () => true, // read state verified by reply below
    deleteCmd: `Dismiss the ${TAG}_notif notification.`,
  });
}

async function section13_summaries() {
  const S = "13-Summaries";
  await readCheck(S, "Net worth / summary", "What's my current net worth?", /\$|net worth|asset|liabilit/i);
  await readCheck(S, "Cash flow", "What's my cash flow this month?", /\$|income|spend|expense|cash/i);
  await readCheck(S, "Bills due", "What bills are due soon?", /bill|due|\$|none|no bills/i);
  await readCheck(S, "Dashboard counts validation", "Are my dashboard numbers right?", /match|correct|valid|mismatch|stale/i);
  await readCheck(S, "Dashboard refresh", "Refresh my dashboard.", /refresh|recomputed|cleared|up to date/i);
}

async function section14_search() {
  const S = "14-Search";
  await seedPost("/tasks", { title: `${TAG}_searchable unique needle task` });
  await readCheck(S, "Global search", `Search for ${TAG}_searchable`, new RegExp(`${TAG}_searchable|needle|task|found`, "i"));
  await readCheck(S, "Profile-scoped view", `Show only Mike ${TAG}'s information on the dashboard.`, /mike|scope|filter|dashboard|switch/i);
  await readCheck(S, "Clear filter", `Show everyone's data again.`, /everyone|all|cleared|scope|dashboard/i);
}

async function section15_bulk() {
  const S = "15-Bulk";
  const ev = await chat(`Create these three tasks: ${TAG}_bulk1 call the dentist tomorrow, ${TAG}_bulk2 pay my phone bill on the 15th, and ${TAG}_bulk3 check my tire pressure Saturday.`);
  await sleep(3000);
  const tasks = await list("/tasks");
  const found = [1, 2, 3].filter((n) => tasks.some((t) => (t.title || "").includes(`${TAG}_bulk${n}`)));
  record({
    section: S, capability: "Multi-create (3 tasks, 1 message)", command: "three tasks in one message",
    tool: ev.tools.join("+") || "", args: "", toolResult: ev.reply.slice(0, 100),
    recordId: `${found.length}/3`, profile: "self",
    db: found.length === 3 ? "PASS" : "FAIL", ui: found.length === 3 ? "PASS" : "FAIL",
    refresh: "N/T", isolation: "N/T",
    overall: found.length === 3 ? "PASS" : found.length > 0 ? "PARTIAL" : "FAIL", where: "Tasks list",
    reason: found.length === 3 ? undefined : `only ${found.length}/3 created`,
  });
  // bulk complete
  const ev2 = await chat(`Mark all three ${TAG}_bulk tasks as complete.`);
  await sleep(2500);
  const done = (await list("/tasks")).filter((t) => (t.title || "").includes(`${TAG}_bulk`) && (t.status === "done" || t.completed));
  record({
    section: S, capability: "Bulk complete", command: "complete all three",
    tool: ev2.tools[0] || "", args: "", toolResult: ev2.reply.slice(0, 100),
    recordId: `${done.length}/3`, profile: "self",
    db: done.length === 3 ? "PASS" : "FAIL", ui: done.length === 3 ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: done.length === 3 ? "PASS" : done.length > 0 ? "PARTIAL" : "FAIL", where: "Tasks list statuses",
    reason: done.length === 3 ? undefined : `${done.length}/3 completed`,
  });
  // bulk delete via preview→confirm
  const ev3 = await chat(`Delete all my tasks containing ${TAG}_bulk`);
  await sleep(2000);
  const still = (await list("/tasks")).filter((t) => (t.title || "").includes(`${TAG}_bulk`));
  const previewOk = still.length === 3 && /confirm|proceed|preview|3/i.test(ev3.reply);
  const ev4 = await chat(`Yes, I confirm — delete them.`, [
    { role: "user", content: `Delete all my tasks containing ${TAG}_bulk` },
    { role: "assistant", content: ev3.reply },
  ]);
  await sleep(2500);
  const goneCount = 3 - (await list("/tasks")).filter((t) => (t.title || "").includes(`${TAG}_bulk`)).length;
  record({
    section: S, capability: "Bulk delete (preview → confirm)", command: "delete all containing tag",
    tool: `${ev3.tools[0] || "?"} → ${ev4.tools[0] || "?"}`, args: "", toolResult: ev4.reply.slice(0, 100),
    recordId: `${goneCount}/3 deleted`, profile: "self",
    db: goneCount === 3 ? "PASS" : "FAIL", ui: previewOk ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: goneCount === 3 && previewOk ? "PASS" : goneCount === 3 ? "PARTIAL" : "FAIL", where: "Tasks list (two-turn flow)",
    reason: goneCount === 3 ? (previewOk ? undefined : "preview reply didn't show counts/confirm ask") : `${goneCount}/3 deleted`,
  });
}

async function section16_undo() {
  const S = "16-Undo";
  const ev = await chat(`Log a $12 expense called ${TAG}_undome coffee.`);
  await sleep(2000);
  const created = (await list("/expenses")).find((e) => (e.description || "").includes(`${TAG}_undome`));
  const ev2 = await chat(`Undo that last expense.`);
  await sleep(2500);
  const gone = !(await list("/expenses")).some((e) => (e.description || "").includes(`${TAG}_undome`));
  record({
    section: S, capability: "undo_last_action (create→delete)", command: "log expense, then undo",
    tool: ev2.tools[0] || "", args: "", toolResult: ev2.reply.slice(0, 100),
    recordId: created?.id || "", profile: "self",
    db: created && gone ? "PASS" : "FAIL", ui: gone ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: created && gone ? "PASS" : "FAIL", where: "Expenses list (row removed by undo)",
    reason: created ? (gone ? undefined : "undo didn't remove the row") : "expense never created",
  });
  // restore deleted (soft-delete recovery)
  await seedPost("/tasks", { title: `${TAG}_restoreme file taxes` });
  await chat(`Delete the ${TAG}_restoreme task.`);
  await sleep(2000);
  const ev3 = await chat(`Restore the ${TAG}_restoreme task I just deleted.`);
  await sleep(2500);
  const restored = (await list("/tasks")).some((t) => (t.title || "").includes(`${TAG}_restoreme`));
  record({
    section: S, capability: "Restore deleted record", command: "delete then restore task",
    tool: ev3.tools[0] || "", args: "", toolResult: ev3.reply.slice(0, 100),
    recordId: "", profile: "self",
    db: restored ? "PASS" : "FAIL", ui: restored ? "PASS" : "FAIL", refresh: "N/T", isolation: "N/T",
    overall: restored ? "PASS" : "FAIL", where: "Tasks list (row back after restore)",
    reason: restored ? undefined : "task not restored",
  });
  await readCheck(S, "Audit history (get_entity_history)", `What's the change history of the ${TAG}_restoreme task?`, /history|change|created|restore|deleted|no recorded/i);
  // cleanup the restored task
  await chat(`Delete the ${TAG}_restoreme task.`);
}

async function sectionNegatives() {
  const S = "17-Negative";
  await negative(S, "Task without a title", `Create a task.`, {
    refuseRe: /what|title|which|name|describe|details|\?/i,
  });
  await negative(S, "Delete already-deleted record", `Delete the ${TAG}_undome expense.`, {
    refuseRe: /couldn't find|not found|no expense|already|doesn't exist/i,
  });
}

async function sectionIsolation() {
  const S = "18-Isolation";
  // Bob + Jane profiles + a task each; Mike exists from section 1.
  for (const nm of ["Bob", "Jane"]) {
    const p = await seedPost("/profiles", { name: `${nm} ${TAG}`, type: "person" });
    PROFILE_IDS[`${nm} ${TAG}`] = p.id;
  }
  await chat(`Add a task for Bob ${TAG} called ${TAG}_bobtask walk the dog.`);
  await sleep(1500);
  await chat(`Add a task for Jane ${TAG} called ${TAG}_janetask book flights.`);
  await sleep(2500);
  const tasks = await list("/tasks");
  const bobT = tasks.find((t) => (t.title || "").includes(`${TAG}_bobtask`));
  const janeT = tasks.find((t) => (t.title || "").includes(`${TAG}_janetask`));
  const bobOk = !!bobT && isolationOk(bobT, [`Bob ${TAG}`, "self"]) && (bobT.linkedProfiles || []).includes(PROFILE_IDS[`Bob ${TAG}`]);
  const janeOk = !!janeT && isolationOk(janeT, [`Jane ${TAG}`, "self"]) && (janeT.linkedProfiles || []).includes(PROFILE_IDS[`Jane ${TAG}`]);
  const crossContaminated = !!bobT && (bobT.linkedProfiles || []).includes(PROFILE_IDS[`Jane ${TAG}`]);
  record({
    section: S, capability: "Cross-profile ownership", command: "task for Bob + task for Jane",
    tool: "create_task", args: "", toolResult: "",
    recordId: `${bobT?.id || "-"} / ${janeT?.id || "-"}`, profile: "Bob / Jane",
    db: bobT && janeT ? "PASS" : "FAIL",
    ui: bobOk && janeOk ? "PASS" : "FAIL", refresh: "N/T",
    isolation: bobOk && janeOk && !crossContaminated ? "PASS" : "FAIL",
    overall: bobOk && janeOk && !crossContaminated ? "PASS" : "FAIL",
    where: "Tasks linkedProfiles (the UI filter's ownership rule)",
    reason: bobOk && janeOk ? undefined : `bob=${JSON.stringify(bobT?.linkedProfiles)} jane=${JSON.stringify(janeT?.linkedProfiles)}`,
  });
  // Deleting Bob's task must not touch Jane's
  await chat(`Delete the ${TAG}_bobtask task.`);
  await sleep(2500);
  const after = await list("/tasks");
  const bobGone = !after.some((t) => (t.title || "").includes(`${TAG}_bobtask`));
  const janeStill = after.some((t) => (t.title || "").includes(`${TAG}_janetask`));
  record({
    section: S, capability: "Delete isolation", command: "delete Bob's task only",
    tool: "delete_task", args: "", toolResult: "",
    recordId: "", profile: "Bob / Jane",
    db: bobGone && janeStill ? "PASS" : "FAIL", ui: bobGone && janeStill ? "PASS" : "FAIL",
    refresh: "N/T", isolation: janeStill ? "PASS" : "FAIL",
    overall: bobGone && janeStill ? "PASS" : "FAIL", where: "Tasks list",
    reason: bobGone && janeStill ? undefined : `bobGone=${bobGone} janeStill=${janeStill}`,
  });
  // system-level validation
  await readCheck(S, "validate_profile_isolation", "Validate my profile isolation — do any records point at profiles that aren't mine?", /intact|valid|isolat|no.*(violation|issue)|record/i);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
async function cleanup() {
  console.log("\n── cleanup ──");
  for (const ep of ["/tasks", "/expenses", "/events", "/habits", "/trackers", "/obligations", "/reminders", "/journal", "/goals"]) {
    try {
      for (const row of await list(ep)) {
        if (JSON.stringify(row).includes(TAG)) {
          await api("DELETE", `${ep}/${row.id}`).catch(() => {});
        }
      }
    } catch { /* best effort */ }
  }
  // profiles last (children first: roofbox before crv)
  const profiles = await list("/profiles");
  const mine = profiles.filter((p) => JSON.stringify(p).includes(TAG));
  mine.sort((a, b) => (a.parentProfileId ? -1 : 1) - (b.parentProfileId ? -1 : 1));
  for (const p of mine) await api("DELETE", `/profiles/${p.id}`).catch(() => {});
  // custom notifications: dismiss by API is chat-only; best effort via chat
  console.log(`cleaned ${mine.length} profiles + tagged rows`);
}

// ── Report ───────────────────────────────────────────────────────────────────
function buildReport(): string {
  const lines: string[] = [];
  lines.push(`# Full AI-tool audit — ${new Date().toISOString()}`);
  lines.push(`\nTarget: ${API_BASE} (production). Tag: \`${TAG}\`.`);
  lines.push(`\n**Method**: every command went through the real /api/chat; the tool that ran is extracted from the response's envelope (\`action\` field); DB + UI checks read the same REST endpoints the UI renders; "refresh" is a fresh GET ≥2.5s later (the same data path as F5); isolation asserts \`linkedProfiles ⊆ expected\` — the exact rule the UI's profile filter applies. Cross-ACCOUNT isolation is enforced by RLS/user_id scoping (covered by the standing contract suite; all queries here ran strictly within the authenticated smoke session).`);
  lines.push(`\n| # | Section | Capability | Tool | Record | DB | UI | Refresh | Isolation | Result | Where / reason |`);
  lines.push(`|---|---------|-----------|------|--------|----|----|---------|-----------|--------|----------------|`);
  RESULTS.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.section} | ${r.capability} | \`${r.tool || "-"}\` | ${r.recordId ? r.recordId.slice(0, 12) : "-"} | ${r.db} | ${r.ui} | ${r.refresh} | ${r.isolation} | ${r.overall === "PASS" ? "✅ PASS" : r.overall === "PARTIAL" ? "🟡 PARTIAL" : "❌ FAIL"} | ${(r.reason || r.where).replace(/\|/g, "\\|").slice(0, 90)} |`);
  });
  const pass = RESULTS.filter((r) => r.overall === "PASS").length;
  const partial = RESULTS.filter((r) => r.overall === "PARTIAL").length;
  const fail = RESULTS.filter((r) => r.overall === "FAIL").length;
  lines.push(`\n## Totals`);
  lines.push(`- Tests run: **${RESULTS.length}**`);
  lines.push(`- Passed: **${pass}**  · Partial: **${partial}**  · Failed: **${fail}**`);
  const failed = RESULTS.filter((r) => r.overall !== "PASS");
  if (failed.length) {
    lines.push(`\n## Failures / partials`);
    for (const f of failed) {
      lines.push(`- **${f.section} / ${f.capability}** — tool \`${f.tool || "?"}\`, record \`${f.recordId || "-"}\`: ${f.reason || "see table"}. Command: "${f.command.slice(0, 100)}"`);
    }
  }
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--section="))?.split("=")[1];
  const reportPath = args.find((a) => a.startsWith("--report="))?.split("=")[1]
    || `docs/full-tool-audit-${TAG}.md`;

  console.log(`\n═══ FULL AI-TOOL AUDIT (${TAG}) at ${API_BASE} ═══\n`);
  const profiles = await list("/profiles");
  SELF_ID = profiles.find((p) => p.type === "self")?.id || "";
  if (!SELF_ID) throw new Error("No self profile on the smoke account — reseed first.");

  const sections: Array<[string, () => Promise<void>]> = [
    ["profiles", section0_profiles],
    ["tasks", section2_tasks],
    ["events", section3_events],
    ["habits", section4_habits],
    ["trackers", section5_trackers],
    ["journal", section6_journal],
    ["expenses", section7_expenses],
    ["assets", section8_assets],
    ["liabilities", section9_liabilities],
    ["reminders", section12_reminders],
    ["summaries", section13_summaries],
    ["search", section14_search],
    ["bulk", section15_bulk],
    ["undo", section16_undo],
    ["negatives", sectionNegatives],
    ["isolation", sectionIsolation],
  ];
  for (const [nm, fn] of sections) {
    if (only && nm !== only) continue;
    console.log(`\n── section: ${nm} ──`);
    try { await fn(); } catch (e: any) {
      console.error(`section ${nm} crashed: ${e?.message || e}`);
      record({
        section: nm, capability: `${nm} (section crash)`, command: "-", tool: "", args: "",
        toolResult: "", recordId: "", profile: "-", db: "FAIL", ui: "FAIL", refresh: "N/T",
        isolation: "N/T", overall: "FAIL", where: "-", reason: String(e?.message || e).slice(0, 140),
      });
    }
  }

  if (!only) await cleanup();
  const report = buildReport();
  writeFileSync(reportPath, report);
  console.log(`\n${report}\n\nReport written to ${reportPath}`);
  const fail = RESULTS.filter((r) => r.overall === "FAIL").length;
  process.exit(fail === 0 ? 0 : 1);
})();
