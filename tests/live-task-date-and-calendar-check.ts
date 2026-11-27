// Live check (deployed app, smoke account) of the four bugs of 2026-11-24:
//   1. a due date TYPED into the task editor is saved whole, in one write
//      (it used to send "0002-11-25" on the first year digit and reset);
//   2. a task completed from the Calendar reads completed there at once —
//      the day panel's count and the open dialog — and a task with no due
//      date is not on the Calendar at all (QA 2026-11-24, second pass: it was
//      drawn as an all-day item on the day it was added);
//   3. a warranty's START date raises no expired-document alert (its
//      expiration still does);
//   4. the AI summary is given the dashboard's own counts and does not deny
//      them.
//
//   npx tsx tests/live-task-date-and-calendar-check.ts
// (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
// Takes the gate lock; deletes what it creates.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { countTasksByDay } from "../shared/task-counts";
import { briefingContradictions } from "../shared/dashboard-briefing";
import { isTestDataRow } from "../shared/test-data";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const TZ = "America/Los_Angeles";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const t = (id: string) => `[data-testid="${id}"]`;
const list = (r: any, what: string): any[] => { if (!Array.isArray(r?.data)) throw new Error(`${what}: expected a list, got ${r?.status}`); return r.data; };
const dayIn = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const today = dayIn(new Date());
const plusDays = (n: number) => dayIn(new Date(Date.now() + n * 86400000));
const firstOf = (iso: string) => `${iso.slice(0, 8)}01`;
const lastOf = (iso: string) => { const [y, m] = iso.split("-").map(Number); return `${iso.slice(0, 8)}${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };

async function forwardApi(page: any) {
  if (!API_ORIGIN) return;
  await page.route(/\/api\//, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { ...request.headers() };
    delete headers.host; delete headers.origin; delete headers.referer; delete headers["content-length"];
    try {
      const res = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v; });
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch { await route.abort(); }
  });
}
async function timelineItems(sourceId: string): Promise<any[]> {
  const r = await api("GET", `/calendar/timeline?start=${firstOf(today)}&end=${lastOf(plusDays(2))}`);
  return list(r, "timeline").filter((i) => i.sourceId === sourceId);
}
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, 1000)); v = await get(); }
  return v;
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-task-date-and-calendar-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const taskIds: string[] = [];
  const docIds: string[] = [];
  let browser: any;
  try {
    const version = await (await fetch(`${API_ORIGIN || UI_BASE}/api/version`)).json();
    console.log(`the API is serving ${String(version.sha).slice(0, 7)}`);

    // ── 3 · a warranty's start date is not an expiration ─────────────────
    const started = await api("POST", "/documents", { name: `Tyre Warranty Start ${tag}`, type: "warranty", mimeType: "text/plain", fileData: "", extractedData: { warrantyStartDate: plusDays(-400) } });
    const expired = await api("POST", "/documents", { name: `Tyre Warranty End ${tag}`, type: "warranty", mimeType: "text/plain", fileData: "", extractedData: { warrantyExpirationDate: plusDays(-20) } });
    if (!started.ok || !expired.ok) throw new Error(`could not create the documents: ${started.status} ${expired.status}`);
    docIds.push(started.data.id, expired.data.id);
    const enh = await api("GET", "/dashboard-enhanced");
    const expiring = Array.isArray(enh.data?.expiringDocuments) ? enh.data.expiringDocuments as any[] : null;
    check(expiring !== null, "the dashboard snapshot carries expiringDocuments");
    check(!!expiring && expiring.some((d) => d.documentId === expired.data.id), "Docs Exp lists the warranty that really expired (control)");
    check(!!expiring && !expiring.some((d) => d.documentId === started.data.id), "Docs Exp does not list the warranty that only has a start date");
    const notes = list(await api("GET", "/notifications"), "notifications");
    check(!notes.some((n) => n.entityId === started.data.id || String(n.title || "").includes(`Start ${tag}`)), "the bell raises nothing for the start date");

    // ── 2 · an undated task is not on the Calendar; a dated one completes ─
    const undated = await api("POST", "/tasks", { title: `Check tripod screws ${tag}`, priority: "medium", status: "todo" });
    if (!undated.ok) throw new Error(`could not create the task: ${undated.status}`);
    taskIds.push(undated.data.id);
    check((await timelineItems(undated.data.id)).length === 0, "the timeline leaves a task with no due date off the calendar");
    const dated = await api("POST", "/tasks", { title: `Pack tripod ${tag}`, priority: "medium", status: "todo", dueDate: today });
    if (!dated.ok) throw new Error(`could not create the task: ${dated.status}`);
    taskIds.push(dated.data.id);
    const before = await timelineItems(dated.data.id);
    check(before.length === 1 && before[0].date === today && before[0].completed === false, "the timeline has the dated task on its day (and not done)");

    // ── 4 · the AI summary is given the dashboard's counts ───────────────
    const tasksNow = list(await api("GET", "/tasks"), "tasks").filter((x) => !isTestDataRow(x.title) && !isTestDataRow(x.description));
    const counts = countTasksByDay(tasksNow, today, TZ);
    const open = counts.overdue + counts.dueToday + counts.upcoming + counts.undated;
    const sum = await api("POST", "/ai/summary", { filterMode: "everyone", filterIds: [], force: true });
    check(sum.ok && typeof sum.data?.summary === "string" && sum.data.summary.length > 0, "the summary is generated");
    const facts = sum.data?.facts;
    check(!!facts && facts.openTasks === open && facts.overdueTasks === counts.overdue, `the summary was given the tile's counts (${facts?.openTasks} open / ${facts?.overdueTasks} late; the task list says ${open} / ${counts.overdue})`);
    check(open >= 1, "there is at least one open task for the summary to deny");
    check(!!facts && briefingContradictions(String(sum.data?.summary || ""), facts).length === 0, `the summary does not deny them: "${String(sum.data?.summary || "").slice(0, 160)}"`);

    // ── the browser ──────────────────────────────────────────────────────
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, timezoneId: TZ, locale: "en-US" });
    await forwardApi(page);
    const taskWrites: Array<{ method: string; url: string; body: string }> = [];
    page.on("request", (r: any) => { if (/\/api\/tasks\//.test(r.url()) && r.method() === "PATCH") taskWrites.push({ method: r.method(), url: r.url(), body: r.postData() || "" }); });
    await page.goto(UI_BASE);
    const email = page.locator(t("input-signin-email"));
    if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
      await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
      await page.locator(t("tab-signin")).click({ timeout: 5000 }).catch(() => undefined);
    }
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill(t("input-signin-password"), LIVE_PASSWORD);
    await page.click(t("button-signin"));
    await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });

    // Calendar: the undated task is not there; the dated one is completed from its dialog.
    await page.goto(`${UI_BASE}/#/calendar`);
    const row = page.locator(t(`agenda-item-task-${dated.data.id}`));
    await row.waitFor({ timeout: 30000 });
    check((await page.locator(t(`agenda-item-task-${undated.data.id}`)).count()) === 0, "Calendar: the task with no due date is not on today");
    const agenda = page.locator(t("section-day-agenda"));
    const doneCount = async () => Number((/(\d+) completed/.exec(await agenda.innerText()) || [])[1] ?? NaN);
    const doneBefore = await doneCount();
    await row.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 15000 });
    // The grid opens the redesigned detail sheet (GridDetailHost → CalendarItemDetail):
    // its one primary action for an open task is "Mark complete". This check
    // looked for the old dialog's "Mark as done" checkbox and had been red on
    // production since the redesign (triaged 2026-11-27: outdated assertion).
    const complete = dialog.locator(t("cal-action-complete"));
    check((await complete.count()) === 1 && /Mark complete/.test(await complete.innerText().catch(() => "")), "Calendar: the open task offers Mark complete");
    await complete.click();
    await page.getByText(new RegExp(`Pack tripod ${tag}.*completed`)).first().waitFor({ timeout: 20000 });
    // Past the refetch that follows the write: the state must HOLD, not flash.
    await page.waitForTimeout(4000);
    // The sheet closes when its action lands; open the item again and read the
    // LIVE row: completed, and no longer offering completion.
    if (!(await dialog.isVisible().catch(() => false))) await page.locator(t(`agenda-item-task-${dated.data.id}`)).first().click();
    await dialog.waitFor({ timeout: 15000 });
    const dialogText = await dialog.innerText();
    check(/Completed/i.test(dialogText) && (await dialog.locator(t("cal-action-complete")).count()) === 0, "Calendar: reopened, the item reads Completed and no longer offers Mark complete");
    check((await doneCount()) === doneBefore + 1, `Calendar: the day panel counts it (${doneBefore} → ${await doneCount()} completed)`);
    const after = await timelineItems(dated.data.id);
    check(after.length === 1 && after[0].completed === true, "the timeline says the task is completed");
    await page.keyboard.press("Escape");

    // Dashboard: type a due date into the task editor, digit by digit.
    const typed = await api("POST", "/tasks", { title: `Charge batteries ${tag}`, priority: "medium", status: "todo" });
    if (!typed.ok) throw new Error(`could not create the task: ${typed.status}`);
    taskIds.push(typed.data.id);
    const due = plusDays(1);
    const [yy, mm, dd] = due.split("-");
    await page.goto(`${UI_BASE}/#/dashboard`);
    await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });
    await page.locator(t("hub-kpi-tasks")).click();
    await page.locator(t(`task-row-${typed.data.id}`)).click({ timeout: 30000 });
    const dueInput = page.locator(t("task-due-date"));
    await dueInput.click();
    taskWrites.length = 0;
    await page.keyboard.type(`${mm}${dd}${yy}`, { delay: 120 });
    const stored = await until(async () => list(await api("GET", "/tasks"), "tasks").find((x) => x.id === typed.data.id), (x) => String(x?.dueDate || "").slice(0, 10) === due);
    check(String(stored?.dueDate || "").slice(0, 10) === due, `Dashboard: the typed date is stored (${stored?.dueDate || "blank"}, expected ${due})`);
    const dateWrites = taskWrites.filter((w) => /"dueDate"/.test(w.body));
    check(dateWrites.length === 1 && dateWrites[0].body.includes(`"dueDate":"${due}"`), `Dashboard: one write, the whole date (${dateWrites.map((w) => w.body).join(" | ") || "none"})`);
    const cal = await timelineItems(typed.data.id);
    check(cal.length === 1 && cal[0].date === due && cal[0].meta?.undated !== true, `Calendar: the task is on ${due} (${cal.map((c) => c.date).join(",") || "nowhere"})`);
  } finally {
    await browser?.close().catch(() => undefined);
    for (const id of taskIds) await api("DELETE", `/tasks/${id}`).catch(() => undefined);
    for (const id of docIds) await api("DELETE", `/documents/${id}`).catch(() => undefined);
    await release();
  }
  if (failed) { console.error("\nFAILED"); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
