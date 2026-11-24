// Live check (deployed app, smoke account, real browser) for the QA pass of
// 2026-11-24:
//   · Editing a run's distance in its history row re-derives pace, speed,
//     steps and calories, and the edit is still there after a reload (Rule 11b).
//   · One date of a weekly series: More leads with "Change only <date>", the
//     other row is "Edit series", and the series editor says it changes every
//     date and leads back to the one date (O4).
//
//   npx tsx tests/live-entry-edit-and-series-edit-check.ts
//
// Writes only to the smoke account, holds the gate lock and deletes what it
// created.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright");
const SHOTS = process.env.SHOTS_DIR || "";
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

async function call(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-entry-edit-and-series-edit-check" });
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const trackerIds: string[] = [];
  let entryId = "";
  let eventId = "";
  let browser: any;
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}\n`);

    // ── a run, logged the way the chat logs one (with derived figures) ─────
    const before = new Set((await call("GET", "/trackers") as any[]).map((t) => t.id));
    const name = `Jog ${tag}`;
    const chat = await call("POST", "/chat", { message: `Log to a new tracker called "${name}": I ran 1.25 miles in 14 minutes`, history: [] });
    const trackers = await call("GET", "/trackers") as any[];
    for (const t of trackers) if (!before.has(t.id)) trackerIds.push(t.id);
    const tracker = trackers.find((t) => !before.has(t.id) && (t.entries || []).some((e: any) => Number(e.values?.distance) === 1.25));
    if (!tracker) throw new Error(`the chat did not log the run (reply: ${String(chat?.reply).slice(0, 200)})`);
    const entry = tracker.entries.find((e: any) => Number(e.values?.distance) === 1.25);
    entryId = entry.id;
    check(entry.values.paceMinutesPerMile === 11.2 && entry.values.speedMph === 5.36,
      `the logged run carries its derived pace and speed (got ${entry.values.paceMinutesPerMile} min/mi, ${entry.values.speedMph} mph)`);

    // ── a weekly event, to open on its SECOND date ─────────────────────────
    const first = plusDays(7);
    const second = plusDays(14);
    const ev = await call("POST", "/events", { title: `Standup ${tag}`, date: first, allDay: true, category: "personal", recurrence: "weekly", linkedProfiles: [], tags: [], source: "manual" });
    eventId = ev.id;

    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const T = (id: string) => page.locator(`[data-testid="${id}"]`);
    const shot = async (n: string) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/${n}.png` }).catch(() => undefined); } };
    await page.goto(UI_BASE);
    await T("input-signin-email").waitFor({ timeout: 30000 });
    await T("input-signin-email").fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.keyboard.press("Enter");
    await T("page-dashboard").waitFor({ timeout: 45000 });

    // ── Running → History → edit the entry ─────────────────────────────────
    const openHistory = async () => {
      await page.goto(`${UI_BASE}/#/trackers?tracker=${tracker.id}`);
      await page.getByRole("tab", { name: /history/i }).first().click({ timeout: 30000 });
      await T(`entry-row-${entryId}`).waitFor({ timeout: 20000 });
    };
    await openHistory();
    await T(`entry-row-${entryId}`).click();
    await T("entry-field-distance").fill("1.5");
    await T(`entry-save-${entryId}`).click();
    await page.waitForFunction((id: string) => /6\.43/.test(document.querySelector(`[data-testid="entry-row-${id}"]`)?.textContent || ""), entryId, { timeout: 20000 }).catch(() => undefined);
    const row = (await T(`entry-row-${entryId}`).innerText()).replace(/\s+/g, " ");
    await shot("entry-edited");
    check(/1\.5/.test(row), `the history row shows the new distance (row: ${row.slice(0, 160)})`);
    check(/9\.3/.test(row) && /6\.43/.test(row) && !/11\.2/.test(row) && !/5\.36/.test(row), "…and its pace and speed follow it (9.3 min/mi, 6.43 mph), not the old 11.2 / 5.36");

    const stored = ((await call("GET", `/trackers/${tracker.id}`)).entries as any[]).find((e) => e.id === entryId);
    check(stored.values.distance === 1.5 && stored.values.duration === 14, `the server stored 1.5 mi in 14 min (got ${stored.values.distance} / ${stored.values.duration})`);
    check(stored.values.paceMinutesPerMile === 9.3 && stored.values.speedMph === 6.43, `the stored pace and speed were re-derived (got ${stored.values.paceMinutesPerMile}, ${stored.values.speedMph})`);
    check(stored.values.steps > entry.values.steps && stored.values.caloriesBurned > entry.values.caloriesBurned, "the step and calorie estimates were re-derived too");
    check(stored.computed?.caloriesBurned === stored.values.caloriesBurned, `one calorie figure for the entry (values ${stored.values.caloriesBurned}, computed ${stored.computed?.caloriesBurned})`);
    check(stored.computed?.enrichment?.calculated?.speedMph?.value === 6.43, "its provenance describes the edited entry");

    await page.reload();
    await openHistory();
    const after = (await T(`entry-row-${entryId}`).innerText()).replace(/\s+/g, " ");
    check(/1\.5/.test(after) && !/1\.25/.test(after) && /6\.43/.test(after), `after a reload the edit is still there (row: ${after.slice(0, 160)})`);

    // ── Calendar → the second date of the series ───────────────────────────
    await page.evaluate(() => { window.location.hash = "#/calendar"; });
    await T("calendar-view").waitFor({ timeout: 30000 });
    const chip = T(`event-chip-event-${eventId}-${second}`);
    for (let i = 0; i < 2 && (await chip.count()) === 0; i++) { await T("btn-next-month").click(); await page.waitForTimeout(1200); }
    await chip.first().click();
    await T("calendar-item-detail").waitFor({ timeout: 15000 });
    const selected = await T("cal-detail-selected").innerText();
    await T("cal-action-more").click();
    await shot("series-more");
    const one = (await T("cal-more-edit-one").innerText().catch(() => "")).replace(/\s+/g, " ");
    check(/^Change only /.test(one) && /just this date/.test(one), `More leads with changing only the tapped date (row: "${one}"; selected: ${selected.replace(/\s+/g, " ")})`);
    check(/Edit series/.test(await T("cal-more-edit").innerText()), "the other Edit is named 'Edit series'");
    await T("cal-more-edit").click();
    await T("cal-edit-title").waitFor({ timeout: 15000 });
    await shot("series-editor");
    check(/every date in this series/.test(await T("cal-edit-scope").innerText()), "the series editor says it changes every date");
    await T("cal-edit-only-date").click();
    await shot("series-one-date");
    check(await T("calendar-item-detail").isVisible() && await T("cal-menu-move").isVisible(), "'Change only …' leaves the sheet open on that date's own actions");
    check(/Only this date/.test(await T("cal-action-sheet-scope").innerText()), "…which say they reach only this date");
    await T("cal-menu-move").click();
    check((await T("cal-move-date").inputValue()) === second, `Change date opens that date's own editor (${second})`);
    await T("cal-action-sheet-close").click();
    await page.getByRole("button", { name: /Manage this date/ }).nth(1).click();
    check(await T("calendar-item-detail").isVisible() && await T("cal-menu-skip").isVisible(), "'Manage this date' opens the date's actions and the sheet stays open");
    const row2 = await call("GET", `/events/${eventId}`).catch(() => null);
    check(!row2 || (String(row2.date).slice(0, 10) === first && row2.recurrence === "weekly"), "looking wrote nothing: the series is unchanged");
  } finally {
    await browser?.close().catch(() => undefined);
    if (eventId) await api("DELETE", `/events/${eventId}`).catch(() => undefined);
    for (const id of trackerIds) await api("DELETE", `/trackers/${id}`).catch(() => undefined);
    await release();
  }
  if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall live checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
