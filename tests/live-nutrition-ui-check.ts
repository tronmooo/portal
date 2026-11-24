// Live check (deployed app, smoke account, a PHONE with real touch): food
// logged in the real AI Chat screen, followed from the typed message through
// the reply, the stored entry, and the screens that show it.
//
//   1. a branded product by weight, typed into the chat box;
//   2. a generic food by weight (a food-database lookup);
//   3. a nutrition label, through the chat box's "Scan label" dialog
//      (what was read is shown, an amount is typed, then "Log it");
//   4. a correction to the first entry, said in chat.
// After each step the stored entry is read back through the API and compared
// with the reply; at the end the Nutrition tracker screen and the Wellness
// tab are opened and must show the same foods and the corrected figure.
//
//   npx tsx tests/live-nutrition-ui-check.ts
//   SMOKE_UI_BASE=https://<preview> SMOKE_API_BASE=https://<preview>/api …   # a preview
// Takes the gate lock; deletes every entry it created. SHOT_DIR=<dir> keeps screenshots.
import { createRequire } from "node:module";
import { join } from "node:path";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { isNutritionTrackerLike } from "../shared/nutrition-enrichment";

const req = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";
const LABEL = join(process.cwd(), "tests", "fixtures", "nutrition-labels", "granola.png");

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

interface Row { trackerId: string; trackerName: string; entry: any }
async function foodEntries(): Promise<Row[]> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}/trackers`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET /trackers: ${response.status}`);
  const trackers: any[] = await response.json();
  return trackers.filter((t) => isNutritionTrackerLike(t)).flatMap((t) => (t.entries || []).map((entry: any) => ({ trackerId: t.id, trackerName: t.name, entry })));
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-nutrition-ui-check" });
  const before = new Set((await foodEntries()).map((r) => r.entry.id));
  const mine = async () => (await foodEntries()).filter((r) => !before.has(r.entry.id));
  let browser: any;
  try {
    const version = await (await fetchWithRateLimitRetry(`${UI_BASE}/api/version`, {})).response.json();
    console.log(`serving ${String(version.sha).slice(0, 7)} at ${UI_BASE}`);

    browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    const T = (id: string) => page.locator(`[data-testid="${id}"]`);
    const shot = async (n: string) => { if (SHOT) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOT}/nutrition-${n}.png`, fullPage: false }).catch(() => undefined); } };

    await page.goto(UI_BASE);
    await T("input-signin-email").waitFor({ timeout: 45000 });
    await T("input-signin-email").fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.keyboard.press("Enter");
    await T("page-dashboard").waitFor({ timeout: 45000 });
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("portol_profile_filter")) localStorage.setItem(k, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
      }
    });
    await page.goto(`${UI_BASE}/#/chat`);
    await T("input-chat").waitFor({ timeout: 30000 });

    /** Type a message in the chat box, send it, and return the assistant's reply as shown on screen. */
    const say = async (message: string): Promise<string> => {
      const replies = page.locator('[data-testid^="message-assistant-"]');
      const had = await replies.count();
      await T("input-chat").fill(message);
      await T("button-send").tap();
      await page.waitForFunction((n: number) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > n, had, { timeout: 150000 });
      // The reply streams in: wait until its text stops changing.
      let last = "";
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(700);
        const now = (await replies.last().innerText()).trim();
        if (now && now === last) break;
        last = now;
      }
      // Give the after-reply lookup (the client posts it once the reply is up) time to land.
      await page.waitForTimeout(2500);
      return last;
    };
    const has = (text: string, ...parts: Array<string | number>) => parts.every((p) => text.replace(/,/g, "").includes(String(p)));

    // 1 — a branded product by weight
    const r1 = await say("I ate 225 grams of Chobani Zero Sugar Vanilla Greek Yogurt.");
    await shot("1-yogurt");
    let rows = await mine();
    const yogurt = rows.find((r) => /chobani/i.test(String(r.entry.values?.item)));
    check(rows.length === 1 && !!yogurt, `1. one entry was stored for the yogurt (${rows.map((r) => r.entry.values?.item).join(" | ")})`);
    check(!!yogurt && yogurt.entry.values.calories === 90 && yogurt.entry.values.protein === 18 && yogurt.entry.values.carbs === 7.5, `   stored: ${yogurt?.entry.values.calories} kcal, ${yogurt?.entry.values.protein} g protein, ${yogurt?.entry.values.carbs} g carbs (label: 90 / 18 / 7.5)`);
    check(has(r1, "90", "18"), `   the reply on screen quotes the stored figures (${r1.replace(/\s+/g, " ").slice(0, 150)})`);

    // 2 — a generic food by weight, from the food database
    const r2 = await say("I ate 150 grams of cooked quinoa.");
    await shot("2-quinoa");
    rows = await mine();
    const quinoa = rows.find((r) => /quinoa/i.test(String(r.entry.values?.item)));
    const src = String(quinoa?.entry.computed?.nutrition?.components?.[0]?.source || "none");
    check(!!quinoa && Math.abs(Number(quinoa.entry.values.calories) - 180) <= 9, `2. quinoa stored as ${quinoa?.entry.values.calories} kcal (USDA #168917: 180) — source: ${src.slice(0, 90)}`);
    check(!!quinoa && has(r2, Math.round(Number(quinoa.entry.values.calories))), `   the reply on screen quotes the stored calories (${r2.replace(/\s+/g, " ").slice(0, 150)})`);

    // 3 — a nutrition label through the Scan label dialog
    await T("button-scan-label").tap();
    await T("nutrition-scan-dialog").waitFor({ timeout: 15000 });
    const countBefore = (await mine()).length;
    await T("scan-input-library").setInputFiles(LABEL);
    await T("scan-review").waitFor({ timeout: 90000 });
    await shot("3a-label-read");
    check((await mine()).length === countBefore, "3. reading the label stored nothing");
    const calRow = (await T("scan-row-calories").innerText()).replace(/\s+/g, " ");
    check(calRow.includes("230"), `   the dialog shows what the label says per serving (${calRow})`);
    await T("scan-quantity").fill("2 servings");
    check((await T("scan-row-calories").innerText()).includes("460"), `   typing "2 servings" shows 460 kcal before logging (${(await T("scan-row-calories").innerText()).replace(/\s+/g, " ")})`);
    await T("scan-log").tap();
    await T("nutrition-scan-dialog").waitFor({ state: "detached", timeout: 60000 });
    await page.waitForTimeout(1500);
    await shot("3b-label-logged");
    rows = await mine();
    const granola = rows.find((r) => /granola/i.test(String(r.entry.values?.item)));
    check(!!granola && granola.entry.values.calories === 460 && granola.entry.values.protein === 10 && granola.entry.values.fiber === 8, `   stored: ${granola?.entry.values.item} — ${granola?.entry.values.calories} kcal, ${granola?.entry.values.protein} g protein, ${granola?.entry.values.fiber} g fiber (label × 2: 460 / 10 / 8)`);
    check(String(granola?.entry.computed?.nutrition?.verification) === "verified", `   recorded as ${granola?.entry.computed?.nutrition?.verification}, source: ${String(granola?.entry.computed?.nutrition?.components?.[0]?.source).slice(0, 70)}`);
    const lastReply = (await page.locator('[data-testid^="message-assistant-"]').last().innerText()).replace(/\s+/g, " ");
    check(lastReply.includes("460"), `   the chat shows what was logged (${lastReply.slice(0, 120)})`);

    // 4 — a correction, said in chat
    const r4 = await say("Actually, I only ate half of that Chobani yogurt.");
    await shot("4-correction");
    rows = await mine();
    const corrected = rows.find((r) => /chobani/i.test(String(r.entry.values?.item)));
    check(rows.length === 3, `4. still three entries after the correction (${rows.length})`);
    check(!!corrected && corrected.entry.id === yogurt?.entry.id && corrected.entry.values.calories === 45 && corrected.entry.values.protein === 9, `   the same entry now holds ${corrected?.entry.values.calories} kcal, ${corrected?.entry.values.protein} g protein (half: 45 / 9)`);
    check(has(r4, "45"), `   the reply on screen quotes the corrected figure (${r4.replace(/\s+/g, " ").slice(0, 140)})`);

    // 5 — the screens that show it
    const total = Math.round(rows.reduce((n, r) => n + Number(r.entry.values.calories || 0), 0) * 10) / 10;
    const trackerId = rows[0]?.trackerId;
    await page.goto(`${UI_BASE}/#/trackers`);
    await page.waitForTimeout(4000);
    const card = page.locator(`[data-testid*="${trackerId}"]`).first();
    if (await card.count()) { await card.scrollIntoViewIfNeeded().catch(() => undefined); await card.tap().catch(() => undefined); await page.waitForTimeout(3000); }
    await shot("5-tracker");
    const trackerText = (await page.locator("body").innerText()).replace(/,/g, "");
    check(/quinoa/i.test(trackerText) && /granola/i.test(trackerText) && /chobani/i.test(trackerText), "5. the Nutrition tracker screen lists the three foods");
    check(trackerText.includes("460") && /\b45\b/.test(trackerText), `   …with the label's 460 kcal and the corrected 45 kcal (entries total ${total} kcal)`);
    await page.goto(`${UI_BASE}/#/wellness`);
    await T("wellness-grid").waitFor({ timeout: 45000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    await shot("6-wellness");
    const wellnessText = (await page.locator("body").innerText()).replace(/,/g, "");
    check(/nutrition|calorie/i.test(wellnessText), "6. the Wellness tab shows a nutrition figure for the period");
    check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ") || "none"})`);
  } finally {
    await browser?.close().catch(() => undefined);
    for (const r of await mine().catch(() => [] as Row[])) await api("DELETE", `/trackers/${r.trackerId}/entries/${r.entry.id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
