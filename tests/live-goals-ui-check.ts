// Live check (production, smoke account, real browser): the Goals page worked
// BY HAND, with a desktop mouse and with a phone's touch. It had no browser
// check before the workflow matrix (2026-11-24).
//   Add goal → title, target, unit → Save → its card is there → open it →
//   log progress → the card and the server show it → open it → Delete →
//   "Tap again to delete" (Rule 8) → second tap → it is gone
//   npx tsx tests/live-goals-ui-check.ts              (MODE=desktop|phone for one)
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
  const { page, press } = s;
  const hit = (loc: any) => (surface === "phone" ? loc.tap() : loc.click());
  const until = async (label: string, wait: () => Promise<unknown>) => {
    const t0 = Date.now();
    await wait();
    const ms = Date.now() - t0;
    if (ms > FEEDBACK_BUDGET_MS) slow.push(`[${surface}] ${label} ${ms}ms`);
    return ms;
  };
  const goals = async () => list((await api("GET", "/goals")).data);
  const saved = async <T>(find: () => Promise<T | undefined>): Promise<T | undefined> => {
    for (let i = 0; i < 40; i++) { const h = await find(); if (h) return h; await page.waitForTimeout(250); }
    return undefined;
  };
  try {
    await s.open("/goals");
    await page.waitForSelector(t("page-goals"), { timeout: 30000 });
    const title = `${tag} read twelve books`;
    const add = page.locator(`${t("btn-add-goal")}, ${t("btn-create-first-goal")}`).locator("visible=true").first();
    await add.waitFor({ timeout: 20000 });
    await hit(add);
    await page.locator(t("input-goal-title")).fill(title);
    await page.locator(t("input-goal-target")).fill("12");
    await page.locator(t("input-goal-unit")).fill("books");
    check((await s.overflow()) === "", L(`the New goal form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await press(t("btn-save-goal"));
    const goal = await saved(async () => (await goals()).find((g) => g.title === title));
    check(!!goal && Number(goal.target) === 12 && goal.unit === "books", L(`add a goal → the server has it: 12 books (${goal?.target} ${goal?.unit})`));
    if (!goal) throw new Error("the goal was never saved");
    undo.push(() => api("DELETE", `/goals/${goal.id}`));
    const card = page.locator(t(`goal-card-${goal.id}`)).first();
    const cardMs = await until("goal on the page", () => card.waitFor({ timeout: 15000 }));
    check(true, L(`its card is on the page without a reload (${cardMs}ms)`));
    check((await page.locator(`[data-testid^="goal-card-"]`, { hasText: title }).count()) === 1, L("it is listed once"));

    // Log progress from the goal's own sheet.
    await hit(page.getByRole("button", { name: `Open goal: ${title}` }).first());
    const progress = page.locator(t("input-goal-progress"));
    await progress.waitFor({ timeout: 10000 });
    check((await s.overflow()) === "", L(`the goal sheet fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await progress.fill("3");
    await hit(progress.locator("xpath=following-sibling::button[1]"));
    const after = await saved(async () => (await goals()).find((g) => g.id === goal.id && Number(g.current) === 3));
    check(!!after && Number(after.target) === 12 && after.title === title, L(`log 3 → the server has 3 of 12, title and target unchanged (${after?.current})`));
    const shownMs = await until("card shows the progress", () => page.locator(t(`goal-card-${goal.id}`), { hasText: "25%" }).first().waitFor({ timeout: 15000 }));
    check(true, L(`the card shows 25% — 3 of 12 — without a reload (${shownMs}ms)`));

    // Delete takes two taps.
    await hit(page.getByRole("button", { name: `Open goal: ${title}` }).first());
    const del = page.getByRole("dialog").getByRole("button", { name: /^delete$/i }).first();
    await del.waitFor({ timeout: 10000 });
    await hit(del);
    const armed = page.getByRole("dialog").getByRole("button", { name: /tap again to delete/i }).first();
    await armed.waitFor({ timeout: 5000 });
    check((await goals()).some((g) => g.id === goal.id), L("the first tap only arms Delete: the goal is still there"));
    await hit(armed);
    const goneMs = await until("goal leaves the page", () => page.locator(t(`goal-card-${goal.id}`)).first().waitFor({ state: "detached", timeout: 15000 }));
    check(true, L(`the second tap removes it from the page (${goneMs}ms)`));
    check(!!(await saved(async () => ((await goals()).some((g) => g.id === goal.id) ? undefined : true))), L("the server agrees it is gone"));
    const p = s.problems();
    check(p.length === 0, L(`Goals: no script or server error${p.length ? ` — ${p.join("; ")}` : ""}`));
  } catch (e: any) {
    check(false, L(`stopped: ${String(e?.message || e).split("\n")[0].slice(0, 240)}`));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-goals-stopped.png` }).catch(() => undefined);
  } finally {
    await s.close();
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-goals-ui-check" });
  const undo: Array<() => Promise<unknown>> = [];
  for (const x of list((await api("GET", "/goals")).data)) if (/^UI[A-Z0-9]{4} read twelve books$/.test(x.title)) await api("DELETE", `/goals/${x.id}`);
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
