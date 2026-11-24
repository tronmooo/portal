// Live check (production, smoke account, real browser): the Finance and
// Journal pages worked BY HAND, with a desktop mouse and with a phone's touch.
//
// Neither page had a browser check before the workflow matrix (2026-11-24).
//   expense  Add expense → description and amount → Save → it is on the list
//            → open the row → Edit → change the amount → save → the row shows
//            it → Delete → the question → confirm → it is gone
//   journal  New entry → Free write → type → Save → its card is there →
//            delete → the question → confirm → it is gone
// After each step the server is asked whether it agrees with the screen.
//   npx tsx tests/live-money-journal-ui-check.ts      (MODE=desktop|phone for one)
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
  const until = async (label: string, wait: () => Promise<unknown>) => {
    const t0 = Date.now();
    await wait();
    const ms = Date.now() - t0;
    if (ms > FEEDBACK_BUDGET_MS) slow.push(`[${surface}] ${label} ${ms}ms`);
    return ms;
  };
  /** Ask the server until `find` answers, up to 10 s. */
  const saved = async <T>(find: () => Promise<T | undefined>): Promise<T | undefined> => {
    for (let i = 0; i < 40; i++) {
      const hit = await find();
      if (hit) return hit;
      await page.waitForTimeout(250);
    }
    return undefined;
  };
  const expenses = async () => list((await api("GET", "/expenses")).data);
  const journal = async () => list((await api("GET", "/journal")).data);
  /** The confirm button of the question on screen (Rule 8: a second, deliberate step). */
  const confirmDelete = async () => {
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 10000 });
    const yes = dialog.getByRole("button", { name: /^delete/i });
    await (surface === "phone" ? yes.tap() : yes.click());
  };
  try {
    // ── Finance: an expense ───────────────────────────────────────────────
    await s.open("/finance");
    await page.waitForSelector(t("page-finance"), { timeout: 30000 });
    const what = `${tag} garden hose`;
    await press(t("button-add-expense"));
    await page.locator(t("input-expense-description")).fill(what);
    await page.locator(t("input-expense-amount")).fill("23.45");
    check((await s.overflow()) === "", L(`the Add expense form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await press(t("button-save-expense"));
    const exp = await saved(async () => (await expenses()).find((e) => e.description === what));
    check(!!exp && Number(exp.amount) === 23.45, L(`add an expense → the server has it at 23.45 (${exp?.amount})`));
    if (!exp) throw new Error("the expense was never saved");
    undo.push(() => api("DELETE", `/expenses/${exp.id}`));
    const row = page.locator(t(`expense-${exp.id}`)).first();
    const rowMs = await until("expense on the list", () => row.waitFor({ timeout: 15000 }));
    check((await row.innerText()).includes("23.45"), L(`it is on the list at $23.45 without a reload (${rowMs}ms)`));
    check((await page.locator(`[data-testid^="expense-"]`, { hasText: what }).count()) === 1, L("it is listed once"));

    await (surface === "phone" ? row.tap() : row.click());
    await press(t(`btn-edit-expense-${exp.id}`));
    const amount = page.locator(t("input-edit-expense-amount"));
    await amount.waitFor({ timeout: 10000 });
    check((await amount.inputValue()) === "23.45", L(`Edit opens holding the stored amount (${await amount.inputValue()})`));
    check((await s.overflow()) === "", L(`the Edit expense form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await amount.fill("31.5");
    const save = page.getByRole("dialog").getByRole("button", { name: /^save/i }).first();
    await (surface === "phone" ? save.tap() : save.click());
    const editMs = await until("row shows the new amount", () => page.locator(t(`expense-${exp.id}`), { hasText: "31.50" }).first().waitFor({ timeout: 15000 }));
    check(true, L(`change the amount → the row shows $31.50 (${editMs}ms)`));
    const after = await saved(async () => (await expenses()).find((e) => e.id === exp.id && Number(e.amount) === 31.5));
    check(!!after && after.description === what && after.category === exp.category, L("the server has 31.50, description and category unchanged"));

    if (!(await page.locator(t(`btn-delete-expense-${exp.id}`)).first().isVisible().catch(() => false))) {
      const again = page.locator(t(`expense-${exp.id}`)).first();
      await (surface === "phone" ? again.tap() : again.click());
    }
    await press(t(`btn-delete-expense-${exp.id}`));
    await page.getByRole("alertdialog").waitFor({ timeout: 10000 });
    check((await expenses()).some((e) => e.id === exp.id), L("Delete asks first: the expense is still there while the question is open"));
    await confirmDelete();
    const goneMs = await until("expense leaves the list", () => page.locator(t(`expense-${exp.id}`)).first().waitFor({ state: "detached", timeout: 15000 }));
    check(true, L(`confirm → it leaves the list (${goneMs}ms)`));
    check(!!(await saved(async () => ((await expenses()).some((e) => e.id === exp.id) ? undefined : true))), L("the server agrees it is gone"));
    const p1 = s.problems();
    check(p1.length === 0, L(`Finance: no script or server error${p1.length ? ` — ${p1.join("; ")}` : ""}`));

    // ── Journal: an entry ─────────────────────────────────────────────────
    await s.open("/journal");
    await page.locator(t("button-new-journal")).first().waitFor({ timeout: 30000 });
    const text = `${tag} Walked the long way home and felt calm for the first time this week.`;
    await press(t("button-new-journal"));
    await press(t("btn-journal-mode-free"));
    await page.locator(t("input-journal-free-text")).fill(text);
    check((await s.overflow()) === "", L(`the journal form fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await press(t("button-save-journal-free"));
    const entry = await saved(async () => (await journal()).find((e) => e.content === text));
    check(!!entry, L("save an entry → the server has it, word for word"));
    if (!entry) throw new Error("the entry was never saved");
    undo.push(() => api("DELETE", `/journal/${entry.id}`));
    check((await journal()).filter((e) => String(e.content).includes(tag)).length === 1, L("it was saved once (the autosave and the Save button made one entry)"));
    check(typeof entry.title === "string" && entry.title.trim().length > 0, L(`it has a title (${JSON.stringify(entry.title)})`));
    const card = page.locator(t(`card-journal-${entry.id}`)).first();
    const cardMs = await until("entry on the page", () => card.waitFor({ timeout: 15000 }));
    check((await card.innerText()).includes("Walked the long way home"), L(`its card is on the page without a reload (${cardMs}ms)`));

    await press(t(`button-delete-journal-${entry.id}`));
    await page.getByRole("alertdialog").waitFor({ timeout: 10000 });
    check((await journal()).some((e) => e.id === entry.id), L("Delete asks first: the entry is still there while the question is open"));
    await confirmDelete();
    const jGoneMs = await until("entry leaves the page", () => page.locator(t(`card-journal-${entry.id}`)).first().waitFor({ state: "detached", timeout: 15000 }));
    check(true, L(`confirm → its card leaves the page (${jGoneMs}ms)`));
    check(!!(await saved(async () => ((await journal()).some((e) => e.id === entry.id) ? undefined : true))), L("the server agrees it is gone"));
    const p2 = s.problems();
    check(p2.length === 0, L(`Journal: no script or server error${p2.length ? ` — ${p2.join("; ")}` : ""}`));
  } catch (e: any) {
    check(false, L(`stopped: ${String(e?.message || e).split("\n")[0].slice(0, 240)}`));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-money-stopped.png` }).catch(() => undefined);
  } finally {
    await s.close();
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-money-journal-ui-check" });
  const undo: Array<() => Promise<unknown>> = [];
  // What an earlier run that stopped half-way left behind.
  for (const x of list((await api("GET", "/expenses")).data)) if (/^UI[A-Z0-9]{4} garden hose$/.test(x.description)) await api("DELETE", `/expenses/${x.id}`);
  for (const x of list((await api("GET", "/journal")).data)) if (/^UI[A-Z0-9]{4} Walked the long way home/.test(String(x.content))) await api("DELETE", `/journal/${x.id}`);
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
