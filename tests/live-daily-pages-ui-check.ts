// Live check (production, smoke account, real browser): the Tasks and Habits
// pages worked BY HAND, with a desktop mouse and with a phone's touch.
//
// Neither page had a browser check before the workflow matrix (2026-11-24).
//   task   New task → type a title → Add → it is on the list without a reload
//          → tick it → it reads done → ⋯ → Delete → confirm → it is gone
//   habit  New habit → name it → Save → its card is there → tap today's dot →
//          today reads done → tap again → open
// After each step the server is asked whether it agrees with the screen, and
// the time from the tap to the screen changing is reported.
//   npx tsx tests/live-daily-pages-ui-check.ts        (MODE=desktop|phone for one)
import { api } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";
import { chromium, openSignedIn, t, type Surface } from "./helpers/live-browser";

const MODE = process.env.MODE || "both";
/** Visible feedback after a tap that writes (PERFORMANCE_QA_CHECKLIST: optimistic update). */
const FEEDBACK_BUDGET_MS = 1000;

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const slow: string[] = [];

async function run(browser: any, surface: Surface, undo: Array<() => Promise<unknown>>) {
  const tag = `UI${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const L = (s: string) => `[${surface}] ${s}`;
  const s = await openSignedIn(browser, surface);
  const { page, press } = s;
  /** Time from now until `sel` is in the wanted state. */
  const until = async (label: string, wait: () => Promise<unknown>) => {
    const t0 = Date.now();
    await wait();
    const ms = Date.now() - t0;
    if (ms > FEEDBACK_BUDGET_MS) slow.push(`[${surface}] ${label} ${ms}ms`);
    return ms;
  };
  const tasks = async () => list((await api("GET", "/tasks")).data);
  const habits = async () => list((await api("GET", "/habits")).data);
  try {
    // ── Tasks ─────────────────────────────────────────────────────────────
    await s.open("/tasks");
    await page.waitForSelector(t("page-tasks"), { timeout: 30000 });
    const title = `${tag} water the ferns`;
    await press(t("button-new-task"));
    await page.locator(t("input-task-title")).fill(title);
    check((await s.overflow()) === "", L(`the New task form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await press(t("button-submit-task"));
    const row = page.locator(`[data-testid^="text-task-title-"]`, { hasText: title }).first();
    const addMs = await until("task appears after Add", () => row.waitFor({ timeout: 15000 }));
    check(true, L(`add a task → it is on the list without a reload (${addMs}ms)`));
    // The row is drawn at once, before the server has answered (its id is a
    // placeholder until then): follow the task the server saved.
    let id = "";
    const savedMs = await until("task saved", async () => {
      for (let i = 0; i < 40 && !id; i++) {
        id = (await tasks()).find((x) => x.title === title)?.id || "";
        if (!id) await page.waitForTimeout(250);
      }
    });
    check(!!id, L(`the server has the task (${savedMs}ms)`));
    if (!id) throw new Error("the task was never saved");
    undo.push(() => api("DELETE", `/tasks/${id}`));
    await page.locator(t(`text-task-title-${id}`)).first().waitFor({ timeout: 15000 });
    check((await page.locator(`[data-testid^="text-task-title-"]`, { hasText: title }).count()) === 1, L("it is on the list ONCE under its saved id"));
    check((await tasks()).find((x) => x.id === id)?.status !== "done", L("the server has it open"));

    await press(t(`checkbox-task-${id}`));
    // A finished task leaves the open rows and is kept under "Show N completed".
    const doneMs = await until("task leaves the open rows after the tick", () => page.locator(`[data-testid^="tasks-group-rows-"] ${t(`card-task-${id}`)}`).first().waitFor({ state: "detached", timeout: 15000 }));
    check(true, L(`tick it → it leaves the open rows (${doneMs}ms)`));
    let savedDone = false;
    const tickSavedMs = await until("tick saved", async () => {
      for (let i = 0; i < 32 && !savedDone; i++) {
        savedDone = (await tasks()).find((x) => x.id === id)?.status === "done";
        if (!savedDone) await page.waitForTimeout(250);
      }
    });
    check(savedDone, L(`the server agrees it is done (${tickSavedMs}ms after the screen changed)`));
    // Done is not gone for good: the completed rows open on a tap and it is there, ticked.
    if (!(await page.locator(t(`card-task-${id}`)).first().isVisible().catch(() => false))) {
      await press(`[data-testid^="tasks-group-done-toggle-"]`);
    }
    await page.locator(`${t(`checkbox-task-${id}`)}[data-state="checked"]`).first().waitFor({ timeout: 15000 });
    check(true, L("\"Show completed\" lists it, ticked"));

    await press(t(`button-task-menu-${id}`));
    await press(t(`button-delete-task-${id}`));
    // Deleting takes a second, deliberate step (Rule 8).
    await page.locator(t(`alert-delete-task-${id}`)).waitFor({ timeout: 10000 });
    check((await tasks()).some((x) => x.id === id), L("Delete asks first: the task is still there while the question is open"));
    await press(t("button-confirm-delete-task"));
    const goneMs = await until("task leaves after Delete", () => page.locator(t(`card-task-${id}`)).first().waitFor({ state: "detached", timeout: 15000 }));
    check(true, L(`confirm → it leaves the list (${goneMs}ms)`));
    await page.waitForTimeout(1200);
    check(!(await tasks()).some((x) => x.id === id), L("the server agrees it is gone"));
    const p1 = s.problems();
    check(p1.length === 0, L(`Tasks: no script or server error${p1.length ? ` — ${p1.join("; ")}` : ""}`));

    // ── Habits ────────────────────────────────────────────────────────────
    await s.open("/habits");
    await page.locator(t("button-create-habit")).first().waitFor({ timeout: 30000 });
    const name = `${tag} floss`;
    await press(t("button-create-habit"));
    await page.locator(t("input-habit-name")).fill(name);
    await press(t("button-save-habit"));
    const card = page.locator(`[data-testid^="card-habit-"]`, { hasText: name }).first();
    const habitMs = await until("habit appears after Save", () => card.waitFor({ timeout: 15000 }));
    check(true, L(`add a habit → its card is there without a reload (${habitMs}ms)`));
    let hid = "";
    for (let i = 0; i < 40 && !hid; i++) {
      hid = (await habits()).find((x) => x.name === name)?.id || "";
      if (!hid) await page.waitForTimeout(250);
    }
    check(!!hid, L("the server has the habit"));
    if (!hid) throw new Error("the habit was never saved");
    await page.locator(t(`card-habit-${hid}`)).first().waitFor({ timeout: 15000 });
    undo.push(async () => {
      const h = await api("GET", `/habits/${hid}`);
      await api("DELETE", `/habits/${hid}`);
      if (h.data?.linkedTrackerId) await api("DELETE", `/trackers/${h.data.linkedTrackerId}`);
    });
    check((await s.overflow()) === "", L(`the Habits page fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    const doneToday = async () => ((await habits()).find((x) => x.id === hid)?.checkins || []).length;
    check((await doneToday()) === 0, L("the server has the habit, not yet done today"));

    const dot = t(`button-seg-${hid}-0`);
    await press(dot);
    const inMs = await until("habit reads done after the tap", () => page.locator(`${dot}[title="Tap to undo"]`).first().waitFor({ timeout: 15000 }));
    check(true, L(`tap today's dot → it fills (${inMs}ms)`));
    await page.waitForTimeout(2500);
    check((await doneToday()) === 1, L(`the server has ONE check-in (${await doneToday()})`));
    await press(dot);
    const outMs = await until("habit reads open after the second tap", () => page.locator(`${dot}[title="Tap to check in"]`).first().waitFor({ timeout: 15000 }));
    check(true, L(`tap it again → it empties (${outMs}ms)`));
    await page.waitForTimeout(2500);
    check((await doneToday()) === 0, L(`the server has no check-in (${await doneToday()})`));
    const p2 = s.problems();
    check(p2.length === 0, L(`Habits: no script or server error${p2.length ? ` — ${p2.join("; ")}` : ""}`));
  } catch (e: any) {
    check(false, L(`stopped: ${String(e?.message || e).split("\n")[0].slice(0, 220)}`));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-stopped.png` }).catch(() => undefined);
  } finally {
    await s.close();
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-daily-pages-ui-check" });
  const undo: Array<() => Promise<unknown>> = [];
  // What an earlier run that stopped half-way left behind.
  for (const x of list((await api("GET", "/tasks")).data)) if (/^UI[A-Z0-9]{4} water the ferns$/.test(x.title)) await api("DELETE", `/tasks/${x.id}`);
  for (const x of list((await api("GET", "/habits")).data)) if (/^UI[A-Z0-9]{4} floss$/.test(x.name)) await api("DELETE", `/habits/${x.id}`);
  const browser = await chromium.launch();
  try {
    if (MODE !== "phone") await run(browser, "desktop", undo);
    if (MODE !== "desktop") await run(browser, "phone", undo);
  } finally {
    await browser.close();
    for (const u of undo.reverse()) await u().catch(() => undefined);
    await release();
  }
  console.log(slow.length ? `\nSLOW  over ${FEEDBACK_BUDGET_MS}ms from the tap to the screen changing: ${slow.join("; ")}` : `\nevery tap changed the screen within ${FEEDBACK_BUDGET_MS}ms`);
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
