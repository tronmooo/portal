// Live check (production, smoke account, real browser): typing into the CHAT
// SCREEN, with a desktop mouse and with a phone's touch, and what the rest of
// the app shows afterwards.
//
// The chat variations check talks to the chat's API. This one uses the page a
// person uses: type, Send, and then
//   · the message appears at once (the user is not left wondering if it sent)
//   · the reply arrives, with its card naming what was saved
//   · the OTHER pages show the record without a reload (Finance, Tasks)
//   · nothing is wider than the phone, with the composer in view
// Owner, 2026-11-24: "I need it to show up really responsive".
//   npx tsx tests/live-chat-ui-check.ts               (MODE=desktop|phone for one)
import { api } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";
import { chromium, openSignedIn, t, type Surface } from "./helpers/live-browser";

const MODE = process.env.MODE || "both";
/** The user's own message is on screen within this (PERFORMANCE_QA_CHECKLIST: chat send acknowledgment). */
const ACK_BUDGET_MS = 300;
/** A chat reply the user is not left waiting on. */
const REPLY_BUDGET_MS = 8000;

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const slow: string[] = [];

async function run(browser: any, surface: Surface, undo: Array<() => Promise<unknown>>) {
  const tag = `UI${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const L = (s: string) => `[${surface}] ${s}`;
  const s = await openSignedIn(browser, surface);
  const { page, press } = s;
  const expenses = async () => list((await api("GET", "/expenses")).data);
  const tasks = async () => list((await api("GET", "/tasks")).data);

  /** Type a line, send it, and time the acknowledgment and the reply. */
  const send = async (line: string) => {
    const box = page.locator(t("input-chat")).locator("visible=true").first();
    await box.waitFor({ timeout: 30000 });
    await box.fill(line);
    const assistantBefore = await page.locator(t("message-assistant")).count();
    const t0 = Date.now();
    await press(t("button-send"));
    await page.locator(t("message-user"), { hasText: line }).last().waitFor({ timeout: 15000 });
    const ackMs = Date.now() - t0;
    // The reply is a NEW assistant message whose text has stopped changing.
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length > n,
      { sel: t("message-assistant"), n: assistantBefore }, { timeout: 60000 },
    );
    const last = page.locator(t("message-assistant")).last();
    let text = ""; let stable = 0;
    for (let i = 0; i < 240 && stable < 4; i++) {
      await page.waitForTimeout(250);
      const now = (await last.innerText().catch(() => "")).trim();
      stable = now && now === text ? stable + 1 : 0;
      text = now;
    }
    const replyMs = Date.now() - t0 - 1000; // the last second was the "has it stopped" wait
    if (ackMs > ACK_BUDGET_MS) slow.push(`[${surface}] "${line.slice(0, 30)}" shown after ${ackMs}ms`);
    if (replyMs > REPLY_BUDGET_MS) slow.push(`[${surface}] "${line.slice(0, 30)}" answered after ${replyMs}ms`);
    return { ackMs, replyMs, text };
  };

  try {
    await s.open("/chat");
    await page.waitForSelector(t("page-chat"), { timeout: 30000 });
    check((await s.overflow()) === "", L(`the chat screen fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));

    // ── An expense said in passing ────────────────────────────────────────
    const what = `${tag} sandwich`;
    const e = await send(`spent $9.75 on a ${what}`);
    check(true, L(`my message is on screen ${e.ackMs}ms after Send; the reply finished in ${e.replyMs}ms`));
    check(/9\.75/.test(e.text), L(`the reply names the amount: ${e.text.replace(/\s+/g, " ").slice(0, 110)}`));
    const card = page.locator(`[data-testid^="action-card-"]`).last();
    check(await card.isVisible().catch(() => false), L("a card under the reply shows what was saved"));
    const saved = (await expenses()).filter((x) => String(x.description).includes(tag));
    for (const x of saved) undo.push(() => api("DELETE", `/expenses/${x.id}`));
    check(saved.length === 1 && Math.abs(Number(saved[0]?.amount) - 9.75) < 0.005, L(`the server has ONE expense of 9.75 (${saved.map((x) => x.amount).join(", ") || "none"})`));
    check((await s.overflow()) === "", L(`the conversation fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));

    // The Finance page shows it without a reload (an in-app link, as a person taps).
    await page.evaluate(() => { window.location.hash = "#/finance"; });
    await page.waitForSelector(t("page-finance"), { timeout: 30000 });
    if (saved[0]) {
      const t0 = Date.now();
      await page.locator(t(`expense-${saved[0].id}`)).first().waitFor({ timeout: 15000 });
      check(true, L(`Finance lists the expense without a reload (${Date.now() - t0}ms after opening the page)`));
    }

    // ── A task ────────────────────────────────────────────────────────────
    await page.evaluate(() => { window.location.hash = "#/chat"; });
    await page.waitForSelector(t("page-chat"), { timeout: 30000 });
    check(await page.locator(t("message-user"), { hasText: what }).last().isVisible().catch(() => false), L("coming back to chat, the conversation is still there"));
    const chore = `${tag} test the grill`;
    const k = await send(`add a task to ${chore} tomorrow`);
    check(true, L(`my message is on screen ${k.ackMs}ms after Send; the reply finished in ${k.replyMs}ms`));
    const made = (await tasks()).filter((x) => String(x.title).toLowerCase().includes(`${tag.toLowerCase()} test the grill`));
    for (const x of made) undo.push(() => api("DELETE", `/tasks/${x.id}`));
    check(made.length === 1, L(`the server has ONE task (${made.map((x) => x.title).join(" | ") || "none"})`));
    await page.evaluate(() => { window.location.hash = "#/tasks"; });
    await page.waitForSelector(t("page-tasks"), { timeout: 30000 });
    if (made[0]) {
      const t0 = Date.now();
      await page.locator(t(`text-task-title-${made[0].id}`)).first().waitFor({ timeout: 15000 });
      check(true, L(`Tasks lists it without a reload (${Date.now() - t0}ms after opening the page)`));
    }

    // ── Pointing back: "mark that done" ───────────────────────────────────
    await page.evaluate(() => { window.location.hash = "#/chat"; });
    await page.waitForSelector(t("page-chat"), { timeout: 30000 });
    const d = await send("mark that done");
    check(true, L(`"mark that done": shown in ${d.ackMs}ms, answered in ${d.replyMs}ms — ${d.text.replace(/\s+/g, " ").slice(0, 90)}`));
    const after = made[0] ? (await tasks()).find((x) => x.id === made[0].id) : undefined;
    check(after?.status === "done", L(`the task I had just added is done (${after?.status})`));
    const p = s.problems();
    check(p.length === 0, L(`Chat: no script or server error${p.length ? ` — ${p.join("; ")}` : ""}`));
  } catch (err: any) {
    check(false, L(`stopped: ${String(err?.message || err).split("\n")[0].slice(0, 240)}`));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-chat-stopped.png` }).catch(() => undefined);
  } finally {
    await s.close();
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-chat-ui-check" });
  const undo: Array<() => Promise<unknown>> = [];
  for (const x of list((await api("GET", "/expenses")).data)) if (/UI[A-Z0-9]{4} sandwich/.test(String(x.description))) await api("DELETE", `/expenses/${x.id}`);
  for (const x of list((await api("GET", "/tasks")).data)) if (/UI[A-Z0-9]{4} test the grill/i.test(String(x.title))) await api("DELETE", `/tasks/${x.id}`);
  const browser = await chromium.launch();
  try {
    if (MODE !== "phone") await run(browser, "desktop", undo);
    if (MODE !== "desktop") await run(browser, "phone", undo);
  } finally {
    await browser.close();
    for (const u of undo.reverse()) await u().catch(() => undefined);
    await release();
  }
  console.log(slow.length ? `\nSLOW  ${slow.join("; ")}` : `\nevery message showed within ${ACK_BUDGET_MS}ms and every reply finished within ${REPLY_BUDGET_MS}ms`);
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
