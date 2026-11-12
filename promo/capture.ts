// Promo capture: seeds the SMOKE account with demo data through the real AI
// chat (holding the gate lock), then screenshots the app on a phone viewport.
// Writes only to the smoke account. Usage: npx tsx promo/capture.ts <out_dir> [noseed]
import { chromium } from "playwright";
import { api } from "../tests/smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "../tests/smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "../tests/helpers/live-account";
const OUT = process.argv[2];
const SEED = process.argv[3] !== "noseed";
const msgs = [
  "My weight was 187 lbs on November 1", "My weight was 185 lbs on November 6", "I weigh 182 lbs today",
  "Blood pressure 118/76 this morning", "Slept 7.5 hours last night", "Drank 64 oz of water today",
  "Ran 5k in 26 minutes today",
  "Spent $86.40 on groceries at Trader Joe's today", "Spent $42 on gas yesterday", "Netflix is $15.99 every month on the 8th",
  "My paycheck is $3,200 every two weeks, next one Nov 14",
  "Rent is $1,850 due on the 1st every month", "Car insurance $142 due on the 20th every month",
  "Dentist appointment Friday November 14 at 3pm", "Remind me to renew my passport by December 1",
  "Add a high priority task: book flights for Thanksgiving", "Add task: call the plumber about the kitchen sink tomorrow",
  "Start a habit: meditate 10 minutes every morning", "Start a habit: read 20 pages every night",
  "Set a goal to save $10,000 for an emergency fund by June 2027",
  "Journal: Great day — shipped the big project and went for a sunset run. Feeling energized and grateful.",
];
(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "promo-video-capture" });
  try {
    if (SEED) for (const m of msgs) {
      const r = await api("POST", "/chat", { message: m, history: [] });
      console.log(r.ok ? "ok " : `FAIL ${r.status} `, m, "→", JSON.stringify((r.data as any)?.response ?? (r.data as any)?.message ?? "").slice(0, 120));
    }
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("https://portol.me");
    const email = page.locator('[data-testid="input-signin-email"]');
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.click('[data-testid="button-signin"]');
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
    const pages = ["dashboard","finance","calendar","tasks","goals","habits","journal","wellness","trackers","insights","obligations"];
    for (const p of pages) {
      await page.goto(`https://portol.me/#/${p}`); await page.waitForTimeout(5000);
      await page.screenshot({ path: `${OUT}/${p}.png` });
      await page.mouse.wheel(0, 700); await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/${p}-2.png` });
      console.log("shot", p);
    }
    // Desktop dashboard: its sidebar frames the laptop screen texture.
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: "dark" });
    const dpage = await dctx.newPage();
    await dpage.goto("https://portol.me");
    await dpage.locator('[data-testid="input-signin-email"]').fill(LIVE_EMAIL);
    await dpage.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await dpage.click('[data-testid="button-signin"]');
    await dpage.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
    await dpage.waitForTimeout(4000);
    await dpage.screenshot({ path: `${OUT}/desktop-dashboard.png` });
    await dctx.close();
    // Live chat in the real UI
    await page.goto("https://portol.me/#/chat");
    const input = page.locator('[data-testid="input-chat"]');
    await input.waitFor({ timeout: 30000 });
    await input.fill("Had a coffee meeting, spent $12.50 at Blue Bottle");
    await page.screenshot({ path: `${OUT}/chat-typing.png` });
    await page.click('[data-testid="button-send"]');
    await page.waitForTimeout(25000);
    await page.screenshot({ path: `${OUT}/chat-reply.png` });
    await input.fill("What do I have coming up this week?");
    await page.click('[data-testid="button-send"]');
    await page.waitForTimeout(30000);
    await page.screenshot({ path: `${OUT}/chat-reply2.png` });
    await browser.close();
  } finally { await release(); }
})();
