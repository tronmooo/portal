// Live walk-through (production, smoke account) of the recurring-occurrence
// rules O1–O4: skip and move ONE date of a recurring task through the real
// routes, then open the calendar detail screen in a real browser at phone
// size and check it is the four-screen design (no dead buttons on a birthday).
//   npx tsx tests/live-recurring-occurrence-check.ts
// Takes the gate lock; deletes what it creates. SHOT_DIR=<dir> keeps screenshots.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const iso = (d: Date) => d.toLocaleDateString("en-CA");
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-recurring-occurrence-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  let taskId: string | undefined;
  let eventId: string | undefined;
  let browser: any;
  try {
    console.log(`production is serving ${String((await (await fetch(`${UI_BASE}/api/version`)).json()).sha).slice(0, 7)}`);

    // ── the routes ───────────────────────────────────────────────────────
    const due = plusDays(10);
    const task = await api("POST", "/tasks", { title: `Mow lawn ${tag}`, dueDate: due, tags: ["recur:weekly", "home"] });
    if (!task.ok) throw new Error(`could not create the task: ${task.status}`);
    taskId = task.data.id;

    const skipped = await api("POST", `/tasks/${taskId}/occurrence`, { action: "skip", date: due });
    check(skipped.ok, "skipping one date of a recurring task is accepted");
    check(String(skipped.data?.dueDate).slice(0, 10) === plusDays(17), `the task steps to the next week (${plusDays(17)}), it is not deleted`);
    check((skipped.data?.tags || []).includes(`rskip:${due}`) && (skipped.data?.tags || []).includes("recur:weekly") && (skipped.data?.tags || []).includes("home"),
      "the skip is recorded; the repeat rule and the user's own tag are kept");

    const moved = await api("POST", `/tasks/${taskId}/occurrence`, { action: "move", date: plusDays(17), newDate: plusDays(19) });
    check(moved.ok && String(moved.data?.dueDate).slice(0, 10) === plusDays(19), "changing the date moves that one occurrence");
    check((moved.data?.tags || []).includes(`rfrom:${plusDays(17)}`), "…and remembers the scheduled date, so the next one is not re-anchored");

    const ev = await api("POST", "/events", {
      title: `Kelly ${tag}'s Birthday`, date: plusDays(300), allDay: true, category: "family",
      recurrence: "yearly", linkedProfiles: [], tags: ["rdate", "rd:kind:birthday"], source: "manual",
    });
    if (!ev.ok) throw new Error(`could not create the event: ${ev.status}`);
    eventId = ev.data.id;
    const settings = await api("POST", `/events/${eventId}/series-settings`, { reminders: [7, 1] });
    check(settings.ok && ["rd:remind:7", "rd:remind:1"].every((t) => (settings.data?.tags || []).includes(t)), "an event keeps two reminders");

    // ── the screens ──────────────────────────────────────────────────────
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOT ? 2 : 1, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    const shot = async (name: string) => { if (SHOT) { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOT}/${name}.png` }).catch(() => undefined); } };
    const T = (id: string) => page.locator(`[data-testid="${id}"]`);
    await page.goto(UI_BASE);
    const email = T("input-signin-email");
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.keyboard.press("Enter");
    await T("page-dashboard").waitFor({ timeout: 30000 });
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("portol_profile_filter")) localStorage.setItem(k, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
      }
      window.location.hash = "#/calendar";
    });
    await page.reload();
    await T("calendar-tab-recurring").waitFor({ timeout: 30000 });
    await T("calendar-tab-recurring").click();

    // Birthday: only what applies.
    const bday = T(`rule-open-event:${eventId}`);
    await bday.waitFor({ timeout: 30000 });
    await bday.click();
    await T("calendar-item-detail").waitFor({ timeout: 15000 });
    await shot("live-birthday-overview");
    check(await T("cal-action-more").isVisible() && await T("cal-view-all").isVisible(), "the birthday opens the new overview (Next card, View All, More)");
    check(await T("cal-action-edit").isVisible() && (await T("cal-action-complete").count()) === 0, "a birthday offers Edit, and no check-off");
    check((await T("cal-detail-reminders").textContent() || "").includes("2 active"), "its reminders row reads '2 active'");
    check((await page.locator('[data-testid^="cal-action-"][disabled]').count()) === 0, "no greyed-out action buttons");
    await T("cal-action-edit").click();
    await T("cal-edit-title").waitFor({ timeout: 15000 });
    await T("cal-edit-tab-reminders").click();
    await shot("live-birthday-reminders");
    check((await page.locator('[data-testid^="cal-edit-preview-"]').count()) === 5, "the edit screen previews the next five dates");
    await T("cal-edit-back").click();
    await T("cal-close").click();

    // Task: per-date actions.
    const rule = T(`rule-open-task:${taskId}`);
    await rule.waitFor({ timeout: 30000 });
    await rule.click();
    await T("calendar-item-detail").waitFor({ timeout: 15000 });
    await shot("live-task-overview");
    check((await T("cal-action-complete").textContent() || "").includes("Mark complete"), "the task's primary button is Mark complete");
    check((await T("cal-detail-next").textContent() || "").includes("moved from"), "its next date shows it was moved for this occurrence");
    await T("cal-view-all").click();
    await page.locator('[data-testid^="cal-occ-"]').first().click();
    await shot("live-task-date-actions");
    check((await T("cal-menu-skip").textContent() || "").includes("Keep future schedule"), "a date's Skip says 'Keep future schedule'");
    check((await T("cal-menu-move").textContent() || "").includes("Move just this occurrence"), "…and Change date says 'Move just this occurrence'");
    await T("cal-action-sheet-close").click();
    await T("cal-tab-history").click();
    await shot("live-task-history");
    check((await T("cal-detail-history-list").textContent() || "").includes("Skipped"), "History lists the skipped date as Skipped");
  } finally {
    await browser?.close().catch(() => undefined);
    if (taskId) await api("DELETE", `/tasks/${taskId}`).catch(() => undefined);
    if (eventId) await api("DELETE", `/events/${eventId}`).catch(() => undefined);
    await release();
  }
  if (failed) process.exit(1);
  console.log("all live checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
