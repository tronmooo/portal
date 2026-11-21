// Live walk-through (deployed app, smoke account, real browser) of the
// 2026-11-21 dashboard work:
//   · the Dashboard scrolls both ways by touch and by wheel, a swipe that
//     starts on the hub header scrolls the page, and scrolling back up is not
//     read as pull-to-refresh (client/src/lib/page-scroll.ts);
//   · the Habits card: today's habits, a one-tap check-in, progress, what's left;
//   · the Tasks card: overdue / due today / upcoming / completed today, with
//     add, complete, reopen and edit;
//   · bills overviews (dashboard Money card, Finance → Bills): due today, the
//     next 30 days, overdue within seven days — nothing older, no Pay button
//     (shared/obligation-windows `billsOverview`);
//   · deleting an asset returns to the Assets list (client/src/lib/profile-listing.ts).
//
//   npx tsx tests/live-dashboard-check.ts
// Takes the gate lock; deletes what it creates. SHOT_DIR=<dir> keeps screenshots.
// SMOKE_UI_BASE=http://127.0.0.1:5199 points the browser at a local build.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";
const TZ = "America/Los_Angeles";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const must = async (method: string, path: string, body?: any): Promise<any> => {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
};
const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function signIn(ctx: any) {
  const page = await ctx.newPage();
  await page.goto(UI_BASE);
  const email = page.locator('[data-testid="input-signin-email"]');
  await email.waitFor({ timeout: 30000 });
  await email.fill(LIVE_EMAIL);
  await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
  // Show everyone, so nothing this run creates sits behind the profile scope.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("portol_profile_filter")) localStorage.setItem(k, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
    }
  });
  await page.reload();
  await page.waitForSelector('[data-testid="exec-card-tasks"]', { timeout: 30000 });
  return page;
}

const dashTop = (page: any): Promise<number> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="page-dashboard"]')!.scrollTop);
const dashMax = (page: any): Promise<number> =>
  page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-testid="page-dashboard"]')!; return el.scrollHeight - el.clientHeight; });

/** One real finger drag (Chrome turns these into native scrolling). */
async function drag(cdp: any, x: number, fromY: number, toY: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + ((toY - fromY) * i) / steps }] });
    await new Promise((r) => setTimeout(r, 16));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((r) => setTimeout(r, 350));
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-dashboard-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const made: Array<[string, string]> = []; // [path, id]
  let browser: any;
  try {
    console.log(`serving ${String((await (await fetch(`${UI_BASE}/api/version`)).json()).sha).slice(0, 7)} at ${UI_BASE}; today ${today}`);

    // ── seed ─────────────────────────────────────────────────────────────
    const mk = async (path: string, body: any) => { const r = await must("POST", path, body); made.push([path, r.id]); return r; };
    const tOver = await mk("/tasks", { title: `Dash late ${tag}`, status: "todo", priority: "high", dueDate: addDays(today, -2) });
    const tToday = await mk("/tasks", { title: `Dash today ${tag}`, status: "todo", priority: "medium", dueDate: today });
    const tSoon = await mk("/tasks", { title: `Dash soon ${tag}`, status: "todo", priority: "medium", dueDate: addDays(today, 3) });
    const h1 = await mk("/habits", { name: `Dash stretch ${tag}`, frequency: "daily" });
    const h2 = await mk("/habits", { name: `Dash read ${tag}`, frequency: "daily" });
    const bill = (name: string, offset: number, amount: number) =>
      mk("/profiles", { type: "liability", type_key: "phone_plan", name: `${name} ${tag}`, fields: { amount, frequency: "monthly", dueDate: addDays(today, offset) } });
    await bill("Dash bill today", 0, 41);
    await bill("Dash bill late3", -3, 42);
    await bill("Dash bill late20", -20, 43);
    await bill("Dash bill in10", 10, 44);
    await bill("Dash bill in45", 45, 45);
    const asset = await mk("/profiles", { type: "asset", name: `Dash asset ${tag}`, fields: { value: 100 } });

    browser = await chromium.launch();

    // ══ PHONE ═══════════════════════════════════════════════════════════
    {
      const { defaultBrowserType: _d, ...iphone } = devices["iPhone 13"];
      const ctx = await browser.newContext({ ...iphone, timezoneId: TZ });
      const page = await signIn(ctx);
      const cdp = await ctx.newCDPSession(page);
      const shot = async (name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }).catch(() => undefined); };
      const vp = page.viewportSize()!;
      const x = Math.round(vp.width / 2);
      await page.getByText(`Dash stretch ${tag}`).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      await shot("phone-1-top");

      // ── scrolling ──────────────────────────────────────────────────────
      const max = await dashMax(page);
      check(max > 300, `the dashboard is taller than the phone screen (${max}px to scroll)`);
      const contentY = Math.round(vp.height * 0.72);
      for (let i = 0; i < 30 && (await dashTop(page)) < max - 2; i++) await drag(cdp, x, contentY, contentY - 260);
      const bottom = await dashTop(page);
      check(bottom >= max - 2, `swiping up reaches the bottom (${bottom} of ${max})`);
      await shot("phone-2-bottom");

      // Scroll back up, counting what the app fetches while we do.
      let fetched = 0;
      const onReq = (r: any) => { if (r.url().includes("/api/") && r.method() === "GET") fetched++; };
      page.on("request", onReq);
      const shellBox = await page.locator('[data-testid="hub-shell"]').boundingBox();
      const shellY = Math.round(shellBox!.y + shellBox!.height / 2);
      await drag(cdp, x, shellY, shellY + 200);
      const afterShell = await dashTop(page);
      check(afterShell < bottom - 100, `a swipe down that starts on the hub header scrolls the page back up (${bottom} → ${afterShell})`);
      for (let i = 0; i < 30 && (await dashTop(page)) > 0; i++) await drag(cdp, x, contentY - 200, contentY + 60);
      check((await dashTop(page)) === 0, `swiping down returns to the very top (${await dashTop(page)})`);
      await page.waitForTimeout(1500);
      page.off("request", onReq);
      check(fetched === 0, `scrolling back up did not trigger a refresh (${fetched} data requests while scrolling)`);
      check(await page.getByText("Refreshing...").count() === 0, "…and no pull-to-refresh indicator appeared");
      await shot("phone-3-back-at-top");

      // At the top, a pull IS a refresh — the feature still works.
      let pulled = 0;
      const onPull = (r: any) => { if (r.url().includes("/api/") && r.method() === "GET") pulled++; };
      page.on("request", onPull);
      await drag(cdp, x, contentY - 200, contentY + 40);
      await page.waitForTimeout(2500);
      page.off("request", onPull);
      check(pulled > 0, `at the top, pulling down still refreshes (${pulled} requests)`);

      // ── Habits card ────────────────────────────────────────────────────
      const habits = page.locator('[data-testid="exec-card-habits"]');
      await habits.scrollIntoViewIfNeeded();
      check(await habits.locator(`[data-testid="exec-habit-row-${h1.id}"]`).isVisible() && await habits.locator(`[data-testid="exec-habit-row-${h2.id}"]`).isVisible(),
        "the Habits card is on the dashboard and lists today's habits");
      const summary = habits.locator('[data-testid="exec-habits-summary"]');
      const before = await summary.innerText();
      const m0 = before.match(/(\d+) of (\d+) done today/);
      check(!!m0, `the card says how today stands (“${before}”)`);
      await shot("phone-4-habits");
      await habits.locator(`[data-testid="exec-habit-checkin-${h1.id}"]`).tap();
      await page.waitForFunction(([id]) => document.querySelector(`[data-testid="exec-habit-checkin-${id}"]`)?.getAttribute("aria-pressed") === "true", [h1.id], { timeout: 15000 }).catch(() => undefined);
      const after = await summary.innerText();
      const m1 = after.match(/(\d+) of (\d+) done today/);
      check(!!m0 && !!m1 && Number(m1[1]) === Number(m0[1]) + 1, `one tap checks a habit in and the progress moves (“${before}” → “${after}”)`);
      await page.waitForTimeout(2500);
      const stored = ((await must("GET", "/habits")) as any[]).find((h) => h.id === h1.id);
      check((stored?.checkins || []).some((c: any) => String(c.date).slice(0, 10) === today), "…and the check-in is stored");
      await shot("phone-5-habit-done");

      // ── Tasks card ─────────────────────────────────────────────────────
      const tasks = page.locator('[data-testid="exec-card-tasks"]');
      await tasks.scrollIntoViewIfNeeded();
      check(await tasks.locator('[data-testid="exec-tasks-group-overdue"]').getByText(`Dash late ${tag}`).count() === 1, "an overdue task is under Overdue");
      check(await tasks.locator('[data-testid="exec-tasks-group-today"]').getByText(`Dash today ${tag}`).count() === 1, "a task due today is under Due today");
      const upcomingShown = await tasks.locator('[data-testid="exec-tasks-group-upcoming"]').getByText(`Dash soon ${tag}`).count() === 1;
      const moreShown = await tasks.locator('[data-testid="exec-tasks-more"]').count() === 1;
      check(upcomingShown || moreShown, "a later task is under Upcoming (or behind the “N more” link when the card is full)");
      await shot("phone-6-tasks");
      // add
      await tasks.locator('[data-testid="exec-task-add-input"]').fill(`Dash added ${tag}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
      const addedRow = ((await must("GET", "/tasks")) as any[]).find((t) => t.title === `Dash added ${tag}`);
      check(!!addedRow, "typing a task and pressing Enter creates it");
      if (addedRow) made.push(["/tasks", addedRow.id]);
      // complete
      await tasks.locator(`[data-testid="exec-task-complete-${tToday.id}"]`).tap();
      await tasks.locator('[data-testid="exec-tasks-done-toggle"]').waitFor({ timeout: 15000 });
      await page.waitForTimeout(2000);
      check(((await must("GET", "/tasks")) as any[]).find((t) => t.id === tToday.id)?.status === "done", "tapping a task's circle completes it");
      await tasks.locator('[data-testid="exec-tasks-done-toggle"]').tap();
      check(await tasks.locator(`[data-testid="exec-task-done-${tToday.id}"]`).isVisible(), "…and it moves to Completed today");
      await shot("phone-7-task-completed");
      // reopen
      await tasks.locator(`[data-testid="exec-task-reopen-${tToday.id}"]`).tap();
      await page.waitForTimeout(3000);
      check(((await must("GET", "/tasks")) as any[]).find((t) => t.id === tToday.id)?.status !== "done", "Undo reopens it");
      // edit
      await tasks.locator(`[data-testid="exec-task-edit-${tOver.id}"]`).tap();
      check(await page.locator('[data-testid="popup-tasks"]').waitFor({ timeout: 10000 }).then(() => true).catch(() => false), "the edit button opens the task in the Tasks panel");
      await shot("phone-8-task-edit");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);

      // ── Money card: bills ──────────────────────────────────────────────
      const money = page.locator('[data-testid="exec-card-money"]');
      await money.scrollIntoViewIfNeeded();
      const moneyText = await money.innerText();
      check(await money.locator('[data-testid="bills-group-today"]').getByText(`Dash bill today ${tag}`).count() === 1, "Money card: a bill due today is under Due today");
      check(await money.locator('[data-testid="bills-group-overdue"]').getByText(`Dash bill late3 ${tag}`).count() === 1, "Money card: a bill 3 days late is under Recently overdue");
      check(!moneyText.includes(`Dash bill late20 ${tag}`), "Money card: a bill 20 days late is not listed");
      check(!moneyText.includes(`Dash bill in45 ${tag}`), "Money card: a bill due in 45 days is not listed");
      check(await money.locator('[data-testid="bills-overview-older"]').count() === 1, "Money card: it says older overdue bills exist and links to all bills");
      check(await money.getByRole("button", { name: /^Pay\b/ }).count() === 0, "Money card: no Pay button");
      await shot("phone-9-money");
      await ctx.close();
    }

    // ══ DESKTOP ═════════════════════════════════════════════════════════
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: TZ });
      const page = await signIn(ctx);
      const shot = async (name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }).catch(() => undefined); };
      await page.getByText(`Dash stretch ${tag}`).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(1500);
      await shot("desktop-1-dashboard");
      const max = await dashMax(page);
      const shell = await page.locator('[data-testid="hub-shell"]').boundingBox();
      await page.mouse.move(640, shell!.y + shell!.height / 2);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(300);
      const viaHeader = await dashTop(page);
      check(viaHeader > 100, `desktop: the wheel over the hub header scrolls the page (${viaHeader}px)`);
      await page.mouse.move(640, 600);
      for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 500);
      await page.waitForTimeout(300);
      check((await dashTop(page)) >= max - 2, "desktop: the wheel reaches the bottom");
      await shot("desktop-2-bottom");
      for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -500);
      await page.waitForTimeout(300);
      check((await dashTop(page)) === 0, "desktop: …and comes back to the top");

      // ── Finance → Bills ────────────────────────────────────────────────
      await page.evaluate(() => { window.location.hash = "#/dashboard/finance"; });
      const card = page.locator('[data-testid="money-bills"]');
      await card.waitFor({ timeout: 30000 });
      await page.getByText(`Dash bill today ${tag}`).first().waitFor({ timeout: 30000 });
      await card.scrollIntoViewIfNeeded();
      const text = await card.innerText();
      check(await card.locator('[data-testid="bills-group-today"]').getByText(`Dash bill today ${tag}`).count() === 1, "Finance → Bills: due today is its own highlighted group");
      check(await card.locator('[data-testid="bills-group-overdue"]').getByText(`Dash bill late3 ${tag}`).count() === 1, "Finance → Bills: 3 days late is under Recently overdue");
      check(await card.locator('[data-testid="bills-group-next"]').getByText(`Dash bill in10 ${tag}`).count() === 1, "Finance → Bills: due in 10 days is under Next 30 days");
      check(!text.includes(`Dash bill late20 ${tag}`), "Finance → Bills: 20 days late is gone from the overview");
      check(!text.includes(`Dash bill in45 ${tag}`), "Finance → Bills: due in 45 days is not listed yet");
      check(await card.locator('[data-testid="bills-overview-older"]').count() === 1, "Finance → Bills: a line says older overdue bills are not listed, with a link to all bills");
      check(await card.getByRole("button", { name: /^Pay\b/ }).count() === 0 && await page.locator('[data-testid^="money-pay-"]').count() === 0, "Finance → Bills: no Pay button");
      const nextGroup = await card.locator('[data-testid="bills-group-next"]').innerText();
      check(/Due \w{3}, \w{3} \d+/.test(nextGroup) && /\$44/.test(nextGroup), "Finance → Bills: each row shows the name, amount and due date");
      await shot("desktop-3-finance-bills");
      // The older bill is still in the app: record, status and all.
      const still = ((await must("GET", "/obligations")) as any[]).some((o) => String(o.name || "").includes(`Dash bill late20 ${tag}`));
      const stillProfile = ((await must("GET", "/profiles")) as any[]).some((p) => p.name === `Dash bill late20 ${tag}`);
      check(still || stillProfile, "…and the 20-days-late bill's record is untouched");

      // ── delete returns to the list it was in ───────────────────────────
      await page.evaluate((id: string) => { window.location.hash = `#/profiles/${id}`; }, asset.id);
      await page.getByText(`Dash asset ${tag}`).first().waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: /^Delete$/ }).first().click();
      await page.locator('[data-testid="button-confirm-delete-profile"]').click();
      await page.waitForFunction(() => !/\/profiles\/[0-9a-f-]{20,}/.test(window.location.hash), null, { timeout: 20000 }).catch(() => undefined);
      const hash = await page.evaluate(() => window.location.hash);
      check(hash === "#/linked?tab=assets", `deleting an asset returns to the Assets list (${hash})`);
      await shot("desktop-4-after-delete");
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const [path, id] of made.reverse()) await api("DELETE", `${path}/${id}`).catch(() => undefined);
    await release();
  }
  if (failed) { console.error("\nlive-dashboard-check: FAILED"); process.exit(1); }
  console.log("\nlive-dashboard-check: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
