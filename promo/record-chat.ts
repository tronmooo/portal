// Promo v2 capture: screen-records the REAL Portol chat on production with the
// SMOKE account (holding the gate lock), including a fictional sample driver's
// license upload. Every frame is a real screen; results are logged to
// events.json so the edit only uses commands that actually worked.
// Usage: npx tsx promo/record-chat.ts <out_dir> <sample_license.jpg>
import { chromium, type Page } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { api } from "../tests/smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "../tests/smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "../tests/helpers/live-account";

const OUT = process.argv[2];
const LICENSE = process.argv[3];
const SKIP_UPLOAD = process.argv[4] === "skipupload";
const FR = path.join(OUT, "frames");
fs.mkdirSync(FR, { recursive: true });
const events: any[] = [];
const frames: [number, string][] = [];
const now = () => Date.now() / 1000;
const mark = (label: string, extra: any = {}) => { events.push({ t: now(), label, ...extra }); console.log(label, JSON.stringify(extra).slice(0, 300)); };
const save = () => fs.writeFileSync(path.join(OUT, "events.json"), JSON.stringify({ events, frames }, null, 1));

async function lastAssistant(page: Page) {
  const msgs = page.locator('[data-testid^="message-assistant-"]');
  const n = await msgs.count();
  if (!n) return { text: "", cards: [] as string[] };
  const m = msgs.nth(n - 1);
  const text = (await m.innerText()).slice(0, 600);
  const cards = await m.locator('[data-testid^="action-card-"]').evaluateAll(els => els.map(e => e.getAttribute("data-testid")!).filter(t => !t.startsWith("action-card-link")));
  return { text, cards };
}

async function waitReply(page: Page, before: number) {
  // a new assistant message, then the thinking bubble gone
  const msgs = page.locator('[data-testid^="message-assistant-"]');
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    const busy = await page.locator('[data-testid="chat-thinking"]').count();
    if ((await msgs.count()) > before && !busy) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(1800);
}

async function command(page: Page, text: string, id: string, hold = 1500) {
  const input = page.locator('[data-testid="input-chat"]');
  const before = await page.locator('[data-testid^="message-assistant-"]').count();
  await input.click();
  mark(`type:${id}`, { text });
  await input.pressSequentially(text, { delay: 32 });
  await page.waitForTimeout(350);
  mark(`send:${id}`);
  await page.click('[data-testid="button-send"]');
  await waitReply(page, before);
  mark(`reply:${id}`, await lastAssistant(page));
  await page.waitForTimeout(hold);
  mark(`end:${id}`);
  save();
}

async function visit(page: Page, route: string, id: string, scroll = 600) {
  mark(`nav:${id}`, { route });
  await page.goto(`https://portol.me/#/${route}`);
  await page.waitForTimeout(3500);
  await page.mouse.wheel(0, scroll);
  await page.waitForTimeout(2200);
  await page.mouse.wheel(0, -scroll);
  await page.waitForTimeout(800);
  mark(`navend:${id}`);
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "promo-video-v2-record" });
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, colorScheme: "dark", isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto("https://portol.me");
    await page.locator('[data-testid="input-signin-email"]').fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.click('[data-testid="button-signin"]');
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
    await page.goto("https://portol.me/#/chat");
    await page.locator('[data-testid="input-chat"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(2000);

    const cdp = await ctx.newCDPSession(page);
    let n = 0;
    cdp.on("Page.screencastFrame", async (f: any) => {
      const file = `s${String(n++).padStart(6, "0")}.jpg`;
      fs.writeFileSync(path.join(FR, file), Buffer.from(f.data, "base64"));
      frames.push([now(), file]);
      try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1290, maxHeight: 2796, everyNthFrame: 1 });
    mark("start");
    await page.waitForTimeout(1500);

    // --- documents: upload the sample license through the chat, confirm extraction
    if (!SKIP_UPLOAD) {
    mark("upload:start");
    await page.locator('[data-testid="input-file"]').setInputFiles(LICENSE);
    await page.locator('[data-testid="attachment-panel"]').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    const note = page.locator('[data-testid="input-attachment-note"]');
    if (await note.count()) await note.pressSequentially("Here's my driver's license", { delay: 32 });
    await page.waitForTimeout(500);
    mark("upload:send");
    await page.click('[data-testid="button-send-attachment"]');
    // "Extract text & save" opens the document review page with a Confirm button
    const confirm = page.getByRole("button", { name: "Confirm" });
    try { await confirm.last().waitFor({ timeout: 150000 }); } catch { mark("upload:no-review"); }
    await page.waitForTimeout(2500);
    mark("upload:review", { url: page.url() });
    if (await confirm.count()) {
      await confirm.last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      mark("upload:confirm");
      await confirm.last().click();
      await page.waitForTimeout(6000);
    } else mark("upload:no-confirm-button");
    mark("upload:done", { url: page.url(), text: (await page.locator("main").innerText().catch(() => "")).slice(0, 800) });
    await page.waitForTimeout(2500);
    save();
    }
    await page.goto("https://portol.me/#/chat");
    await page.locator('[data-testid="input-chat"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);

    await command(page, "Show me my driver's license", "show_license", 3500);
    await command(page, "What's my license number?", "license_number");
    await command(page, "When does my license expire?", "license_expiry");

    // --- hook commands
    await command(page, "I ran 3 miles today", "ran");
    await command(page, "I spent $65 at Walmart", "walmart");
    await command(page, "Remind me to pay rent on the first", "rent");
    await command(page, "I slept 7 hours last night", "slept");
    await command(page, "Show me my upcoming bills", "bills", 2500);

    // --- one message, many records
    await command(page, "I ran 3 miles, drank 40 ounces of water, spent $30 on lunch, and made $200 today", "multi", 2500);
    const link = page.locator('[data-testid^="action-card-link-log_tracker_entry"]').last();
    if (await link.count()) {
      mark("tap:tracker-card");
      await link.click();
      await page.waitForTimeout(4500);
      await page.mouse.wheel(0, 500); await page.waitForTimeout(2000);
      mark("tap:tracker-end");
    }
    await visit(page, "finance", "finance");

    await page.goto("https://portol.me/#/chat");
    await page.locator('[data-testid="input-chat"]').waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    await command(page, "What's coming up on my calendar?", "calendar_q", 2500);

    // --- tour
    for (const r of ["dashboard", "calendar", "artifacts", "trackers", "finance", "obligations"]) await visit(page, r, `tour-${r}`);

    await cdp.send("Page.stopScreencast");
    mark("stop");
    save();
  } finally {
    save();
    await browser.close();
    await release();
  }
})();
