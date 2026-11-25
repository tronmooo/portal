// Live check (production, smoke account, real browser): adding BY HAND on the
// two screens the by-hand checks had not reached — the Calendar's New event
// form and a tracker's Log entry form — with a desktop mouse and a phone's
// touch. Owner, 2026-11-24: "things manually to add … really responsive".
//   Calendar: Add → title, date, time → Save → the server has ONE event on that
//     day at that time → it is on the page without a reload → tapping Save
//     twice quickly does not make two
//   Trackers: Log on a tracker's card → a reading → Save → the server has ONE
//     entry with that value → the card shows it without a reload
//   npx tsx tests/live-calendar-trackers-ui-check.ts   (MODE=desktop|phone for one)
import { api } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";
import { chromium, openSignedIn, t, type Surface } from "./helpers/live-browser";

const MODE = process.env.MODE || "both";
const FEEDBACK_BUDGET_MS = 1000;

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const slow: string[] = [];

async function run(browser: any, surface: Surface, undo: Array<() => Promise<unknown>>) {
  const tag = `UI${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const L = (s: string) => `[${surface}] ${s}`;
  const s = await openSignedIn(browser, surface);
  const { page } = s;
  const hit = (loc: any) => (surface === "phone" ? loc.tap() : loc.click());
  const until = async (label: string, wait: () => Promise<unknown>) => {
    const t0 = Date.now();
    await wait();
    const ms = Date.now() - t0;
    if (ms > FEEDBACK_BUDGET_MS) slow.push(`[${surface}] ${label} ${ms}ms`);
    return ms;
  };
  const events = async () => list((await api("GET", "/events")).data);
  const saved = async <T>(find: () => Promise<T | undefined>): Promise<T | undefined> => {
    for (let i = 0; i < 40; i++) { const h = await find(); if (h) return h; await page.waitForTimeout(250); }
    return undefined;
  };
  const shot = async (name: string) => { if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-${name}.png` }).catch(() => undefined); };
  const today: string = (await api("POST", "/autopay/run")).data?.today;

  // ── Calendar: a new event ───────────────────────────────────────────────
  try {
    await s.open("/calendar");
    // A desktop has the "+ Event" button; a phone reaches the same form from
    // the Calendar options menu.
    if (surface === "phone") {
      const options = page.locator(t("btn-calendar-options")).locator("visible=true").first();
      await options.waitFor({ timeout: 30000 });
      await hit(options);
      await hit(page.locator(t("menu-add-event")).first());
    } else {
      const add = page.locator(t("btn-add-event-cal")).locator("visible=true").first();
      await add.waitFor({ timeout: 30000 });
      await hit(add);
    }
    const title = `${tag} piano lesson`;
    const titleBox = page.locator(t("input-event-title")).locator("visible=true").first();
    await titleBox.waitFor({ timeout: 10000 });
    await titleBox.fill(title);
    await page.locator(t("input-event-date")).locator("visible=true").first().fill(today);
    await page.locator(t("input-event-time")).locator("visible=true").first().fill("16:30");
    check((await s.overflow()) === "", L(`the New event form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await shot("event-form");
    // Two quick presses on Save, as an impatient thumb does.
    const save = page.locator(t("btn-save-event")).locator("visible=true").first();
    const t0 = Date.now();
    await hit(save);
    await (surface === "phone" ? save.tap({ timeout: 800 }) : save.click({ timeout: 800 })).catch(() => undefined);
    const ev = await saved(async () => (await events()).find((e) => e.title === title));
    check(!!ev && String(ev.date).slice(0, 10) === today && String(ev.time).slice(0, 5) === "16:30", L(`add an event → the server has it today at 16:30 (${ev ? `${String(ev.date).slice(0, 10)} ${ev.time}` : "nothing"})`));
    if (!ev) throw new Error("the event was never saved");
    const shownMs = await until("event on the calendar", () => page.getByText(title).locator("visible=true").first().waitFor({ timeout: 15000 }));
    check(true, L(`it is on the Calendar without a reload (${Date.now() - t0}ms after Save; shown ${shownMs}ms after the server had it)`));
    await page.waitForTimeout(1500);
    const twins = (await events()).filter((e) => e.title === title);
    for (const e of twins) undo.push(() => api("DELETE", `/events/${e.id}`));
    check(twins.length === 1, L(`two quick presses on Save made ONE event (${twins.length})`));
    await shot("event-added");

    // Open it: the detail names it and its time.
    const row = page.locator(`[data-testid^="agenda-item-"][data-record-id="${ev.id}"]`).first();
    await row.waitFor({ timeout: 15000 });
    await row.scrollIntoViewIfNeeded();
    await hit(row);
    const detail = page.locator(`${t("cal-detail-title")}, ${t("dialog-event-detail")}`).locator("visible=true").first();
    await detail.waitFor({ timeout: 10000 });
    const body = await page.locator("body").innerText();
    check(body.includes(title) && /4:30/.test(body), L("tapping it opens its detail, with the title and 4:30"));
    check((await s.overflow()) === "", L(`the event detail fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await shot("event-detail");
    const p = s.problems();
    check(p.length === 0, L(`Calendar: no script or server error${p.length ? ` — ${p.join("; ")}` : ""}`));
  } catch (err: any) {
    check(false, L(`Calendar stopped: ${String(err?.message || err).split("\n")[0].slice(0, 240)}`));
    await shot("calendar-stopped");
  }

  // ── Trackers: a reading logged from the card ────────────────────────────
  try {
    const made = await api("POST", "/trackers", { name: `${tag} Pushups`, category: "fitness", fields: [{ name: "reps", type: "number", isPrimary: true }] });
    const id = made.data?.id;
    if (!id) throw new Error(`could not make the tracker: ${made.status}`);
    undo.push(() => api("DELETE", `/trackers/${id}`));
    const entries = async () => (list((await api("GET", "/trackers")).data).find((x) => x.id === id)?.entries || []) as any[];
    await s.open("/trackers");
    await page.waitForSelector(t("page-trackers"), { timeout: 30000 });
    await page.reload();
    await page.waitForSelector(t("page-trackers"), { timeout: 30000 });
    // A tracker with no entries yet sits in the folded "No data" group; its
    // chip opens the tracker, where Add logs the first reading.
    const pile = page.locator(t("no-data-pile-toggle")).locator("visible=true").first();
    await pile.waitFor({ timeout: 20000 });
    const chip = page.getByRole("button", { name: new RegExp(`${tag} Pushups`) }).locator("visible=true").first();
    if (!(await chip.isVisible().catch(() => false))) await hit(pile);
    await chip.waitFor({ timeout: 10000 });
    await hit(chip);
    const addEntry = page.locator(t("button-add-entry-detail")).locator("visible=true").first();
    await addEntry.waitFor({ timeout: 10000 });
    check((await s.overflow()) === "", L(`the tracker's own screen fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await hit(addEntry);
    const box = page.locator(t("input-entry-reps")).locator("visible=true").first();
    await box.waitFor({ timeout: 10000 });
    await box.fill("37");
    check((await s.overflow()) === "", L(`the Log entry form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await shot("entry-form");
    const submit = page.locator(t("button-entry-submit")).locator("visible=true").first();
    const t0 = Date.now();
    await hit(submit);
    await (surface === "phone" ? submit.tap({ timeout: 800 }) : submit.click({ timeout: 800 })).catch(() => undefined);
    const got = await saved(async () => { const e = await entries(); return e.length ? e : undefined; });
    check(!!got && Number(got[0]?.values?.reps) === 37, L(`log 37 reps → the server has it (${JSON.stringify(got?.[0]?.values)})`));
    const cardMs = await until("reading on the tracker", () => page.getByText(/\b37\b/).locator("visible=true").first().waitFor({ timeout: 15000 }));
    check(true, L(`the tracker shows 37 without a reload (${Date.now() - t0}ms after Save; ${cardMs}ms after the server had it)`));
    await page.waitForTimeout(1500);
    const n = (await entries()).length;
    check(n === 1, L(`two quick presses on Save made ONE entry (${n})`));
    await shot("entry-logged");
    const p = s.problems();
    check(p.length === 0, L(`Trackers: no script or server error${p.length ? ` — ${p.join("; ")}` : ""}`));
  } catch (err: any) {
    check(false, L(`Trackers stopped: ${String(err?.message || err).split("\n")[0].slice(0, 240)}`));
    await shot("trackers-stopped");
  } finally {
    await s.close();
    for (const u of undo.splice(0).reverse()) await u().catch(() => undefined);
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-calendar-trackers-ui-check" });
  const undo: Array<() => Promise<unknown>> = [];
  for (const x of list((await api("GET", "/events")).data)) if (/^UI[A-Z0-9]{4} piano lesson$/.test(String(x.title))) await api("DELETE", `/events/${x.id}`);
  for (const x of list((await api("GET", "/trackers")).data)) if (/^UI[A-Z0-9]{4} Pushups$/.test(String(x.name))) await api("DELETE", `/trackers/${x.id}`);
  const browser = await chromium.launch();
  try {
    if (MODE !== "phone") await run(browser, "desktop", undo);
    if (MODE !== "desktop") await run(browser, "phone", undo);
  } finally {
    await browser.close();
    for (const u of undo.reverse()) await u().catch(() => undefined);
    await release();
  }
  console.log(slow.length ? `\nSLOW  ${slow.join("; ")}` : `\nevery change showed within ${FEEDBACK_BUDGET_MS}ms`);
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
