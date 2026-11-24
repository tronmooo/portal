// Live check (production, smoke account, real browser): the Bills page worked
// BY HAND, with a desktop mouse and with a phone's touch. It had no browser
// check before the workflow matrix (2026-11-24).
//   a monthly bill due in three days is on the page under All Bills and Due
//   Soon → open its row → Edit → change the amount → Save → the row and the
//   server show it, the due date untouched → Mark as paid → a payment and an
//   expense exist, the Paid figure moved → Delete → the question → confirm →
//   it is gone
//   npx tsx tests/live-bills-ui-check.ts              (MODE=desktop|phone for one)
import { api } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";
import { chromium, openSignedIn, t, type Surface } from "./helpers/live-browser";

const MODE = process.env.MODE || "both";
const FEEDBACK_BUDGET_MS = 1000;

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const slow: string[] = [];
const near = (a: unknown, b: number) => Math.abs(Number(a) - b) < 0.005;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function run(browser: any, surface: Surface, undo: Array<() => Promise<unknown>>, today: string) {
  const tag = `UI${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const L = (s: string) => `[${surface}] ${s}`;
  const due = addDays(today, 3);
  const name = `${tag} Water Bill`;
  const made = await api("POST", "/profiles", { type: "liability", type_key: "utility", name, fields: { amount: 42, frequency: "monthly", dueDate: due } });
  if (!made.ok || !made.data?.id) { check(false, L(`could not create the bill (${made.status})`)); return; }
  const id: string = made.data.id;
  undo.push(() => api("DELETE", `/profiles/${id}`));

  const s = await openSignedIn(browser, surface);
  const { page, press } = s;
  const until = async (label: string, wait: () => Promise<unknown>) => {
    const t0 = Date.now();
    await wait();
    const ms = Date.now() - t0;
    if (ms > FEEDBACK_BUDGET_MS) slow.push(`[${surface}] ${label} ${ms}ms`);
    return ms;
  };
  const saved = async <T>(find: () => Promise<T | undefined>): Promise<T | undefined> => {
    for (let i = 0; i < 40; i++) { const h = await find(); if (h) return h; await page.waitForTimeout(250); }
    return undefined;
  };
  const fields = async () => (await api("GET", `/profiles/${id}`)).data?.fields;
  const payments = async () => list((await api("GET", `/liabilities/${id}/payments`)).data);
  const expenses = async () => list((await api("GET", "/expenses")).data).filter((e) => Array.isArray(e.tags) && e.tags.includes(`liability:${id}`));
  const row = () => page.locator(t(`bill-row-${id}`)).locator("visible=true").first();
  const openRow = async () => {
    if (!(await page.locator(t(`popup-edit-${id}`)).first().isVisible().catch(() => false))) {
      await (surface === "phone" ? row().tap() : row().click());
    }
  };
  try {
    await s.open("/bills");
    await page.waitForSelector(t("bills-view"), { timeout: 30000 });
    await row().waitFor({ timeout: 20000 });
    check((await row().innerText()).includes("42"), L(`the bill is on the page at $42: ${(await row().innerText()).replace(/\s+/g, " ").slice(0, 70)}`));
    check((await s.overflow()) === "", L(`the Bills page fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));
    await press(t("bills-filter-soon"));
    check(await row().isVisible().catch(() => false), L("it is under Due Soon (due in three days)"));
    await press(t("bills-filter-overdue"));
    await page.waitForTimeout(300);
    check(!(await page.locator(t(`bill-row-${id}`)).first().isVisible().catch(() => false)), L("it is not under Overdue"));
    await press(t("bills-filter-all"));
    await row().waitFor({ timeout: 10000 });

    // Edit the amount only.
    await openRow();
    await press(t(`popup-edit-${id}`));
    const amount = page.locator(t(`bill-edit-amount-${id}`));
    await amount.waitFor({ timeout: 10000 });
    check((await amount.inputValue()) === "42", L(`Edit opens holding the stored amount (${await amount.inputValue()})`));
    check((await page.locator(t(`bill-edit-due-${id}`)).inputValue()) === due, L(`… and the due date the list shows (${await page.locator(t(`bill-edit-due-${id}`)).inputValue()})`));
    await amount.fill("45.5");
    await press(t(`bill-edit-save-${id}`));
    const editMs = await until("row shows the new amount", () => page.locator(t(`bill-row-${id}`), { hasText: "45.50" }).first().waitFor({ timeout: 15000 }));
    check(true, L(`change the amount → the row shows $45.50 (${editMs}ms)`));
    const after = await saved(async () => { const f = await fields(); return near(f?.amount, 45.5) ? f : undefined; });
    check(!!after, L("the server has 45.50"));
    check(String(after?.dueDate ?? after?.nextDueDate ?? "").slice(0, 10) === due && after?.frequency === "monthly", L(`an amount-only edit left the due date and the schedule alone (${after?.dueDate ?? after?.nextDueDate}, ${after?.frequency})`));

    // Pay it.
    await openRow();
    await press(t(`popup-pay-${id}`));
    const paid = await saved(async () => { const p = await payments(); return p.length ? p : undefined; });
    check(!!paid && paid.length === 1 && near(paid[0].amount, 45.5), L(`Mark as paid → one payment of 45.50 on the bill (${(paid || []).map((p) => p.amount).join(", ") || "none"})`));
    const exp = await saved(async () => { const e = await expenses(); return e.length ? e : undefined; });
    check(!!exp && exp.length === 1 && near(exp[0].amount, 45.5), L(`… and one expense of 45.50 in Finance (${(exp || []).map((e) => e.amount).join(", ") || "none"})`));
    await press(t("bills-filter-paid"));
    const paidMs = await until("bill listed under Paid", () => row().waitFor({ timeout: 15000 }));
    check(true, L(`it is listed under Paid without a reload (${paidMs}ms)`));
    await press(t("bills-filter-soon"));
    await page.waitForTimeout(400);
    check(!(await page.locator(t(`bill-row-${id}`)).first().isVisible().catch(() => false)), L("it is no longer under Due Soon"));
    console.log(L(`NOTE  the Paid figure reads ${(await page.locator(t("bills-stat-paid")).first().innerText()).replace(/\s+/g, " ")}`));

    // Delete, in two steps.
    await press(t("bills-filter-all"));
    await row().waitFor({ timeout: 10000 });
    await openRow();
    await press(t(`popup-delete-${id}`));
    await page.locator(t(`bill-delete-confirm-${id}`)).first().waitFor({ timeout: 10000 });
    check((await api("GET", `/profiles/${id}`)).ok, L("Delete asks first: the bill is still there while the question is open"));
    await press(t(`bill-delete-confirm-${id}`));
    const goneMs = await until("bill leaves the page", () => page.locator(t(`bill-card-${id}`)).first().waitFor({ state: "detached", timeout: 15000 }));
    check(true, L(`confirm → it leaves the page (${goneMs}ms)`));
    check(!!(await saved(async () => ((await api("GET", `/profiles/${id}`)).status === 404 ? true : undefined))), L("the server agrees it is gone"));
    const p = s.problems();
    check(p.length === 0, L(`Bills: no script or server error${p.length ? ` — ${p.join("; ")}` : ""}`));
  } catch (e: any) {
    check(false, L(`stopped: ${String(e?.message || e).split("\n")[0].slice(0, 240)}`));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-bills-stopped.png` }).catch(() => undefined);
  } finally {
    await s.close();
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-bills-ui-check" });
  const undo: Array<() => Promise<unknown>> = [];
  for (const x of list((await api("GET", "/profiles")).data)) if (/^UI[A-Z0-9]{4} Water Bill$/.test(x.name)) await api("DELETE", `/profiles/${x.id}`);
  const today: string = (await api("POST", "/autopay/run")).data?.today;
  const browser = await chromium.launch();
  try {
    if (MODE !== "phone") await run(browser, "desktop", undo, today);
    if (MODE !== "desktop") await run(browser, "phone", undo, today);
  } finally {
    await browser.close();
    for (const u of undo.reverse()) await u().catch(() => undefined);
    await release();
  }
  console.log(slow.length ? `\nSLOW  over ${FEEDBACK_BUDGET_MS}ms from the tap to the screen changing: ${slow.join("; ")}` : `\nevery tap changed the screen within ${FEEDBACK_BUDGET_MS}ms`);
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
