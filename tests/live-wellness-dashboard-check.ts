// Live check (deployed app, smoke account, a PHONE with real touch) of the
// redesigned Wellness tab: the customizable dashboard, the time range,
// Customize Wellness, the manual builder and the AI Builder against the real
// model.
//   npx tsx tests/live-wellness-dashboard-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
//
// Takes the gate lock. Creates one workout tracker with a random name and
// three sessions, deletes it, and puts the account's saved Wellness layout
// back exactly as it found it. SHOT_DIR=<dir> keeps screenshots.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { parseWellnessBoards, visibleWellnessCards, hiddenWellnessCards, WELLNESS_PREFS_KEY } from "../shared/wellness-dashboards";
import { sanitizeWellnessWidget } from "../shared/wellness-widgets";

const req = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const PREF = `/preferences/${WELLNESS_PREFS_KEY}`;

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function forwardApi(page: any) {
  if (!API_ORIGIN) return;
  await page.route(/\/api\//, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { ...request.headers() };
    delete headers.host; delete headers.origin; delete headers.referer; delete headers["content-length"];
    try {
      const res = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v; });
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch { await route.abort(); }
  });
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-wellness-dashboard-check" });
  const word = `zq${Math.random().toString(36).slice(2, 7)}`;
  const name = `Rowing ${word}`;
  let trackerId: string | null = null;
  let original: string | null | undefined;
  let browser: any;
  try {
    const version = await (await fetch(`${API_ORIGIN || UI_BASE}/api/version`)).json();
    console.log(`the API is serving ${String(version.sha).slice(0, 7)}`);
    const pref0 = await api("GET", PREF);
    if (!pref0.ok) throw new Error(`could not read the saved Wellness layout: ${pref0.status}`);
    original = pref0.data?.value ?? null;
    await api("PUT", PREF, { value: "" }); // a known start: the default layout

    // ── a workout nothing else is called ─────────────────────────────────
    const t = await api("POST", "/trackers", { name, category: "fitness", fields: [{ name: "distance", type: "number", unit: "mi" }, { name: "duration", type: "number", unit: "min" }] });
    if (!t.ok) throw new Error(`could not create the tracker: ${t.status} ${JSON.stringify(t.data)}`);
    trackerId = t.data.id;
    for (const back of [0, 2, 4]) {
      const when = new Date(Date.now() - back * 86400000 - 3600000).toISOString();
      const e = await api("POST", `/trackers/${trackerId}/entries`, { values: { distance: 2, duration: 20 }, timestamp: when });
      if (!e.ok) throw new Error(`could not log a session: ${e.status} ${JSON.stringify(e.data)}`);
    }

    // ── the AI Builder, with the real model ──────────────────────────────
    const asks: Array<[string, (w: any) => boolean, string]> = [
      ["do I exercise more after sleeping 8 hours", // "Exercise" may be every workout, one of the account's workout trackers, or
      // the exercise-minutes measurement: each is a fair reading the tab can draw.
      (w) => w.kind === "compare" && w.source?.key === "sleep_hours" && (["workouts", "tracker"].includes(w.other?.kind) || ["exercise_minutes", "steps"].includes(w.other?.key)), "a comparison: exercise, grouped by sleep"],
      ["my average sleep this month", (w) => w.kind === "metric" && w.source?.key === "sleep_hours" && w.calc === "average", "the sleep average"],
      [`how often do I do ${name}`, (w) => w.kind === "metric" && (w.source?.kind === "tracker" || w.source?.kind === "workouts") && w.calc === "count", "a count of that workout"],
      ["what I spend on healthcare", (w) => w.source?.kind === "spending", "health spending"],
    ];
    // One description, several cards — built on the account's real tracker and its real field.
    {
      const r = await api("GET", `/wellness-widgets/suggest?prompt=${encodeURIComponent(`a dashboard with my ${name} distance, my weekly sleep average and my weight trend`)}`);
      const ws: any[] = Array.isArray(r.data?.widgets) ? r.data.widgets : [];
      const rowing = ws.find((w) => w.source?.kind === "tracker" && w.source?.key === name);
      check(r.ok && ws.length === 3 && ws.every((w) => !!sanitizeWellnessWidget(w)), `AI Builder (${r.data?.by}): one description → three cards (${ws.map((w) => w.title).join(" · ")})`);
      check(!!rowing && rowing.source.field === "distance" && rowing.calc === "total", `…the first reads the real tracker's real field: ${JSON.stringify(rowing?.source)} · ${rowing?.calc}`);
      const none = await api("GET", `/wellness-widgets/suggest?prompt=${encodeURIComponent("my kitesurfing zqnothing distance")}`);
      const bad = (Array.isArray(none.data?.widgets) ? none.data.widgets : []).filter((w: any) => w.source?.kind === "tracker" && /kitesurf/i.test(String(w.source?.key)));
      check(none.ok && bad.length === 0, "…and it never invents a tracker the account does not have");
    }
    for (const [prompt, ok, what] of asks) {
      const r = await api("GET", `/wellness-widgets/suggest?prompt=${encodeURIComponent(prompt)}`);
      const w = r.data?.widget;
      check(r.ok && !!sanitizeWellnessWidget(w) && ok(w), `AI Builder (${r.data?.by}): "${prompt}" → ${what}${r.ok && w ? ` · ${JSON.stringify(w).slice(0, 150)}` : ` · ${r.status}`}`);
    }
    check((await api("GET", "/wellness-widgets/suggest?prompt=")).status === 400, "AI Builder: an empty description is refused");
    check(parseWellnessBoards((await api("GET", PREF)).data?.value).widgets.length === 0, "AI Builder: asking saved nothing");

    // ── the tab, on a phone, by touch ────────────────────────────────────
    browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices["iPhone 13"] });
    const page = await ctx.newPage();
    await forwardApi(page);
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e)));
    const pageWrites: string[] = [];
    page.on("request", (r: any) => { if (r.method() !== "GET" && r.url().includes("/api/")) pageWrites.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`); });
    const T = (id: string) => page.locator(`[data-testid="${id}"]`);
    const tap = async (id: string) => { const l = T(id).first(); await l.scrollIntoViewIfNeeded(); await l.tap(); };
    const shot = async (n: string) => { if (SHOT) { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOT}/wellness-${n}.png` }).catch(() => undefined); } };
    const storedNow = async () => parseWellnessBoards((await api("GET", PREF)).data?.value);
    const text = async (id: string) => (await T(id).first().textContent()) || "";

    await page.goto(UI_BASE);
    await T("input-signin-email").waitFor({ timeout: 40000 });
    await T("input-signin-email").fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.keyboard.press("Enter");
    await T("page-dashboard").waitFor({ timeout: 40000 });
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("portol_profile_filter")) localStorage.setItem(k, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
      }
    });
    await page.goto(`${UI_BASE}/#/wellness`);
    await page.reload();
    await T("wellness-grid").waitFor({ timeout: 45000 });
    await T(`wellness-workout-${trackerId}`).waitFor({ timeout: 30000 });
    pageWrites.length = 0;
    check((await T("wellness-dashboard").getAttribute("data-range")) === "30d", "the tab opens on the default dashboard, on 30 days");
    check((await text("wellness-activity-sessions")).replace(/\D/g, "") !== "" && Number((await text("wellness-activity-sessions")).replace(/\D/g, "")) >= 3, `Activity Summary counts the sessions (${(await text("wellness-activity-sessions")).trim()})`);
    check((await text(`wellness-workout-${trackerId}`)).includes("3 sessions"), "…and lists the new workout with its three sessions");
    check((await text("wellness-tile-activity-value")).includes("session"), `the Overview's Activity tile shows sessions (${(await text("wellness-tile-activity-value")).trim()})`);
    check((await T("wellness-hidden-cards").count()) === 1 && (await text("wellness-hidden-cards")).includes("Mood & Energy"), "sections that are switched off are named under the grid");
    await shot("1-tab");

    // The range is a view: tapping it changes the cards and saves nothing.
    await tap("wellness-range-7d");
    check((await T("wellness-dashboard").getAttribute("data-range")) === "7d", "tapping 7D shows the last seven days");
    await tap("wellness-range-all");
    check((await T("wellness-dashboard").getAttribute("data-range")) === "all", "…and All shows everything");
    await tap("wellness-range-30d");
    check(pageWrites.length === 0, `opening the tab and changing the range wrote nothing${pageWrites.length ? ` (${pageWrites.join(" | ")})` : ""}`);

    // T1: a fast sideways drag across the range row is the row's own; the tab stays.
    const box = await T("wellness-range").boundingBox();
    if (box) {
      const cdp = await ctx.newCDPSession(page);
      const y = box.y + box.height / 2, x0 = box.x + box.width - 20, x1 = box.x + 20;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
      for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y }] }); await page.waitForTimeout(25); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(600);
      check(page.url().includes("/wellness"), "a sideways drag across the range row does not leave the tab");
    }

    // ── Customize ────────────────────────────────────────────────────────
    await tap("wellness-customize-open");
    await T("wellness-customize-visible").waitFor({ timeout: 15000 });
    check((await text("wellness-customize")).includes("Customize Wellness"), "Customize opens the dialog");
    check((await page.locator('[data-testid="wellness-customize-visible"] > li').count()) === 10 && (await page.locator('[data-testid="wellness-customize-available"] > li').count()) === 5,
      "ten visible sections and five available ones");
    await shot("2-dialog");
    await tap("wellness-customize-show-labs");
    await tap("wellness-customize-add-mood");

    // Offered from the account's own trackers: the new workout is in the list.
    check((await T(`wellness-customize-suggest-tracker:${trackerId}`).count()) === 1 && (await text(`wellness-customize-suggest-tracker:${trackerId}`)).includes("3 entries"),
      "the dialog offers a card for the new workout, read from its entries");

    // Built by hand: a count of the new workout's sessions.
    await tap("wellness-customize-builder-manual");
    await T("wellness-widget-form-title").fill("Rowing count");
    await T("wellness-widget-form-source-kind").selectOption("tracker");
    await T("wellness-widget-form-source-tracker").selectOption(name);
    await T("wellness-widget-form-calc").selectOption("count");
    await tap("wellness-widget-form-display-bar");
    await T("wellness-widget-value-new-widget").waitFor({ timeout: 10000 });
    check((await text("wellness-widget-value-new-widget")).trim() === "3 entries", `the manual builder previews the account's own records (${(await text("wellness-widget-value-new-widget")).trim()})`);
    await tap("wellness-builder-add");

    // In the user's own words: the box at the top of the dialog.
    check((await page.locator('[data-testid="wellness-customize-scroll"] > :first-child').getAttribute("data-testid")) === "wellness-builder-ai", "the \"in your own words\" box is the first thing in Customize");
    await T("wellness-ai-prompt").fill("Do I exercise more after sleeping 8 hours?");
    await tap("wellness-ai-build");
    await T("wellness-ai-proposal-0").waitFor({ timeout: 30000 });
    check((await text("wellness-ai-proposal-0")).includes("not a medical conclusion"), "the AI Builder shows a proposal with its caveat");
    check((await storedNow()).widgets.length === 0, "…and has saved nothing yet");
    await shot("3-ai");
    await tap("wellness-ai-use-0");

    // Reorder by finger: drag the last visible row up past the one above it.
    const order = () => page.$$eval('[data-testid="wellness-customize-visible"] > li', (ns: Element[]) => ns.map((n) => n.getAttribute("data-testid")!.replace("wellness-customize-row-", "")));
    const before = await order();
    const lastId = before[before.length - 1];
    await T(`wellness-customize-row-${lastId}`).evaluate((el: Element) => el.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(300);
    const hb = await T(`wellness-customize-drag-${lastId}`).boundingBox();
    const above = await T(`wellness-customize-row-${before[before.length - 3]}`).boundingBox();
    if (hb && above) {
      const cdp = await ctx.newCDPSession(page);
      const x = hb.x + hb.width / 2, y0 = hb.y + hb.height / 2, y1 = above.y + 4;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0, id: 1 }] });
      for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 12, id: 1 }] }); await page.waitForTimeout(30); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
    }
    const after = await order();
    check(after.indexOf(lastId) < before.indexOf(lastId), `dragging a handle with a finger moves the section up (row ${before.indexOf(lastId) + 1} → row ${after.indexOf(lastId) + 1})`);
    check(page.url().includes("/wellness"), "…and the drag did not leave the tab");

    await T("wellness-option-range").selectOption("90d");
    await tap("wellness-customize-save");
    await T("wellness-customize-visible").waitFor({ state: "detached", timeout: 15000 }).catch(async (e: unknown) => {
      console.log(`Save did not close the dialog. The page's own writes: ${pageWrites.join(" | ") || "(none)"}`);
      throw e;
    });
    await T("wellness-card-w:rowing-count").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    const saved = await storedNow();
    check(pageWrites.filter((w) => w.includes(WELLNESS_PREFS_KEY)).length === 1, "Save wrote the layout once");
    check(saved.widgets.length === 2 && saved.widgets.some((w) => w.by === "manual") && saved.widgets.some((w) => w.kind === "compare"), "the account holds both cards: one built by hand, one proposed by AI");
    check(hiddenWellnessCards(saved).includes("labs") && visibleWellnessCards(saved).includes("mood"), "Labs is switched off and Mood & Energy on");
    check(saved.options.range === "90d", "the default range is saved as 90 days");
    check(JSON.stringify(visibleWellnessCards(saved)) === JSON.stringify(after), "the saved order is the order in the dialog");
    check((await text("wellness-widget-value-rowing-count")).trim() === "3 entries", "the hand-built card shows the three sessions on the tab");
    check((await text("wellness-hidden-cards")).includes("Labs"), "Labs is named as switched off, not gone");
    await shot("4-saved");

    // A second dashboard from a template; the chip switches to it.
    await tap("wellness-customize-open");
    await T("wellness-customize-visible").waitFor({ timeout: 15000 });
    await tap("wellness-customize-board-new");
    await tap("wellness-customize-template-fitness");
    await tap("wellness-customize-save");
    await T("wellness-board-fitness").waitFor({ timeout: 20000 });
    check((await T("wellness-dashboard").getAttribute("data-dashboard")) === "fitness", "a new Fitness dashboard is showing");
    await tap("wellness-board-overview");
    await page.waitForTimeout(1500);
    check((await storedNow()).active === "overview" && (await T("wellness-card-w:rowing-count").count()) === 1, "tapping the Overview chip switches back, and the account remembers it");
    check((await page.locator('[data-testid="wellness-grid"] [data-card="w:rowing-count"]').count()) === 1, "the hand-built card is on Overview, where it was built");
    await page.reload();
    await T("wellness-grid").waitFor({ timeout: 45000 });
    // H4 (owner, QA 2026-11-24, later than this check): the range picked on
    // the tabs rides in the address, so a reload KEEPS it — it was 30 days
    // here. The saved default is what the tab opens on when the address names
    // none. The old line asked for 90 days after the reload, which is the
    // behaviour that rule replaced ("7D, reload, back on 30D").
    const picked = new URL(page.url()).hash.match(/range=(\w+)/)?.[1] ?? null;
    check(picked === "30d", `the address carries the range picked on the tabs (${picked})`);
    check((await T("wellness-dashboard").getAttribute("data-range")) === "30d", "a reload keeps the range that was picked");
    await page.goto(`${UI_BASE}/#/`);
    await page.goto(`${UI_BASE}/#/wellness`);
    await T("wellness-grid").waitFor({ timeout: 45000 });
    check((await T("wellness-dashboard").getAttribute("data-range")) === "90d", "opened with no range in the address, the tab shows the saved 90-day default");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 1, `the page does not scroll sideways on a phone (${overflow}px)`);
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (trackerId) await api("DELETE", `/trackers/${trackerId}`).catch(() => undefined);
    if (original !== undefined) await api("PUT", PREF, { value: original ?? "" }).catch(() => undefined);
    await release();
  }
  if (failed) { console.error("\nFAILED"); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
