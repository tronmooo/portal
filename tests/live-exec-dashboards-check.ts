// Live check (production, smoke account, real browser) of the Executive tab's
// Customize: several dashboards, cards the user builds, and the AI Builder
// against the real model.
//   npx tsx tests/live-exec-dashboards-check.ts
// Takes the gate lock. Creates two expenses and two journal entries tagged
// with a random word, deletes them, and puts the account's saved Executive
// layout back exactly as it found it. SHOT_DIR=<dir> keeps screenshots.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { sanitizeWidget, buildWidgetView } from "../shared/exec-widgets";
import { activeExecPrefs, parseExecDashboards } from "../shared/exec-dashboards";

const req = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const today = () => new Date().toLocaleDateString("en-CA");
const PREF = "/preferences/exec_card_prefs";

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-exec-dashboards-check" });
  const word = `zq${Math.random().toString(36).slice(2, 7)}`;
  const created: Array<[string, string]> = [];
  let original: string | null | undefined;
  let browser: any;
  try {
    console.log(`production is serving ${String((await (await fetch(`${UI_BASE}/api/version`)).json()).sha).slice(0, 7)}`);
    const pref0 = await api("GET", PREF);
    if (!pref0.ok) throw new Error(`could not read the saved layout: ${pref0.status}`);
    original = pref0.data?.value ?? null;
    // Start from a known state: no saved choice (the default).
    await api("PUT", PREF, { value: "" });

    // ── records with a word nothing else contains ────────────────────────
    for (const [amount, description] of [[12.5, `Coffee ${word}`], [30, `Lunch ${word}`]] as const) {
      const e = await api("POST", "/expenses", { amount, category: "dining", description, date: today() });
      if (!e.ok) throw new Error(`could not create an expense: ${e.status} ${JSON.stringify(e.data)}`);
      created.push(["/expenses", e.data.id]);
    }
    for (const content of [`A long walk, thinking about ${word} and the week ahead.`, `Second thoughts on ${word}: it went better than expected today.`]) {
      const j = await api("POST", "/journal", { content, date: today(), mood: "good", moodPicked: true });
      if (!j.ok) throw new Error(`could not create a journal entry: ${j.status} ${JSON.stringify(j.data)}`);
      created.push(["/journal", j.data.id]);
    }

    // ── the AI Builder, with the real model ──────────────────────────────
    const asks: Array<[string, (w: any) => boolean, string]> = [
      ["journal entries about work", (w) => w.source === "journal" && /work/i.test(String(w.match || "")), "journal, filtered to work"],
      ["how much I spend on groceries", (w) => w.source === "expenses" && /grocer/i.test(String(w.match || "")), "spending, filtered to groceries"],
      ["my cars and what they are worth", (w) => w.source === "profiles" && (w.types || []).includes("vehicle"), "vehicle records"],
      ["bills coming up this month", (w) => w.source === "bills", "upcoming bills"],
    ];
    let byAi = 0;
    for (const [prompt, right, means] of asks) {
      const r = await api("GET", `/exec-widgets/suggest?prompt=${encodeURIComponent(prompt)}`);
      const w = sanitizeWidget(r.data?.widget);
      check(r.ok && !!w && JSON.stringify(w) === JSON.stringify(r.data?.widget), `AI Builder: "${prompt}" answers with a card the app can draw`);
      check(!!w && right(w), `…and it is ${means} (${w ? `${w.source}${w.types ? ` ${w.types.join("+")}` : ""}${w.match ? ` “${w.match}”` : ""}, "${w.title}"` : "nothing"}; read by ${r.data?.by})`);
      if (r.data?.by === "ai") byAi++;
    }
    check(byAi === asks.length, `the model itself answered every request (${byAi} of ${asks.length}; the rest fell back to fixed rules)`);
    const none = await api("GET", "/exec-widgets/suggest?prompt=");
    check(none.status === 400, "an empty description is refused");
    const after = await api("GET", PREF);
    check((after.data?.value ?? "") === "", "asking the builder saved nothing");

    // ── what the cards will show, computed from the API's own lists ──────
    const expenses = (await api("GET", "/expenses")).data as any[];
    const journal = (await api("GET", "/journal")).data as any[];
    const spend = buildWidgetView({ id: "s", title: "S", icon: "wallet", source: "expenses", match: word, limit: 8 }, { expenses }, today());
    check(spend.headline?.value === "$43" && spend.rows.length === 2 && new Set(spend.rows.map((r) => r.key)).size === 2,
      `a spending card for the tagged purchases totals $43 over 2 rows, each once (${spend.headline?.value}, ${spend.rows.length} rows)`);
    const jv = buildWidgetView({ id: "j", title: "J", icon: "book", source: "journal", match: word, limit: 8 }, { journal }, today());
    check(jv.rows.length === 2 && new Set(jv.rows.map((r) => r.key)).size === 2, `a journal card for the tagged entries lists 2 entries, each once (${jv.rows.length})`);

    // ── the real screens: desktop, then a phone ──────────────────────────
    browser = await chromium.launch();
    for (const [label, opts, touch] of [
      ["desktop", { viewport: { width: 1440, height: 950 }, timezoneId: "America/Los_Angeles" }, false],
      ["phone", { ...devices["iPhone 14"], timezoneId: "America/Los_Angeles" }, true],
    ] as const) {
      await api("PUT", PREF, { value: "" });
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e)));
      const T = (id: string) => page.locator(`[data-testid="${id}"]`);
      const tap = async (id: string) => { const l = T(id).first(); await l.scrollIntoViewIfNeeded(); if (touch) await l.tap(); else await l.click(); };
      const shot = async (name: string) => { if (SHOT) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOT}/live-${label}-${name}.png`, fullPage: name !== "dialog" }).catch(() => undefined); } };
      const storedNow = async () => parseExecDashboards((await api("GET", PREF)).data?.value);

      await page.goto(UI_BASE);
      await T("input-signin-email").waitFor({ timeout: 30000 });
      await T("input-signin-email").fill(LIVE_EMAIL);
      await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
      await page.keyboard.press("Enter");
      await T("page-dashboard").waitFor({ timeout: 30000 });
      await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("portol_profile_filter")) localStorage.setItem(k, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
        }
      });
      await page.reload();
      await T("exec-card-money").waitFor({ timeout: 45000 });
      check(true, `${label}: signed in; the Executive tab loads`);
      check((await T("exec-customize-toggle").count()) === 0, `${label}: no Customize control at the bottom of the tab`);
      check((await T("exec-dashboards").count()) === 0, `${label}: one dashboard, so no switcher`);

      // Customize opens from the ⋮ menu at the top right.
      await tap("btn-dashboard-menu");
      await tap("btn-customize");
      await T("exec-customize-list").waitFor({ timeout: 15000 });
      check((await T("exec-customize").textContent() || "").includes("Customize Executive"), `${label}: the ⋮ menu's Customize opens the dialog`);
      await shot("dialog");

      // A new dashboard from the Money template.
      await tap("exec-customize-board-new");
      await tap("exec-customize-board-template-money");
      await T("exec-customize-board-form-name").fill("Finances");
      await tap("exec-customize-board-form-create");

      // The AI Builder, in the dialog, against the real model.
      await tap("exec-customize-tab-ai");
      await T("exec-customize-ai-input").fill(`journal entries about ${word}`);
      await tap("exec-customize-ai-build");
      await T("exec-customize-ai-proposal").waitFor({ timeout: 30000 });
      await page.waitForTimeout(1200);
      const proposal = await T("exec-customize-ai-proposal").textContent() || "";
      check((await T("widget-editor-source-preview").inputValue()) === "journal", `${label}: the AI Builder proposes a journal card`);
      check(proposal.includes(word), `${label}: its preview shows the tagged entries from the account`);
      await T("exec-customize-ai-title").fill("Tagged Journal");
      await T("widget-editor-match-preview").fill(word);
      await tap("exec-customize-ai-add");
      await T("exec-customize-list").waitFor({ timeout: 15000 });

      // One built by hand: spending on the tagged purchases.
      await tap("exec-customize-tab-ai");
      await tap("exec-customize-ai-manual");
      await T("exec-customize-ai-title").fill("Tagged Spend");
      await T("widget-editor-source-preview").selectOption("expenses");
      await T("widget-editor-match-preview").fill(word);
      await T("widget-editor-limit-preview").selectOption("6");
      await tap("exec-customize-ai-add");
      await T("exec-customize-list").waitFor({ timeout: 15000 });

      // Reorder: put the spending card first.
      const handle = T("exec-customize-drag-w:tagged-spend");
      await handle.scrollIntoViewIfNeeded();
      const hb = await handle.boundingBox();
      const top = await T("exec-customize-row-money").boundingBox();
      if (hb && top) {
        if (touch) {
          const cdp = await ctx.newCDPSession(page);
          const x = hb.x + hb.width / 2, y0 = hb.y + hb.height / 2, y1 = top.y + 6;
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0, id: 1 }] });
          for (let i = 1; i <= 12; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (y1 - y0) * i / 12, id: 1 }] }); await page.waitForTimeout(30); }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await page.mouse.down();
          await page.mouse.move(hb.x + hb.width / 2, top.y + 6, { steps: 12 }); await page.mouse.up();
        }
      }
      await page.waitForTimeout(300);
      const first = await page.locator('[data-testid="exec-customize-list"] > li').first().getAttribute("data-testid");
      check(first === "exec-customize-row-w:tagged-spend", `${label}: dragging a handle ${touch ? "with a finger" : "with the mouse"} reorders the cards`);

      await tap("exec-customize-save");
      await T("exec-customize-list").waitFor({ state: "detached", timeout: 15000 });
      await T("exec-card-w-tagged-spend").waitFor({ timeout: 20000 });
      await page.waitForTimeout(1500);

      // Saved to the account, exactly.
      let b = await storedNow();
      const fin = b.dashboards.find((d) => d.id === "finances");
      check(b.active === "finances" && b.dashboards.length === 2 && !!fin, `${label}: the account now holds Main and Finances, Finances showing`);
      check(JSON.stringify(b.widgets.find((w) => w.id === "tagged-spend")) === JSON.stringify({ id: "tagged-spend", title: "Tagged Spend", icon: "star", source: "expenses", match: word, limit: 6 }),
        `${label}: the hand-built card saved every setting`);
      const tj = b.widgets.find((w) => w.id === "tagged-journal");
      check(!!tj && tj.source === "journal" && tj.match === word, `${label}: the AI-built card saved its source and filter`);
      check(fin?.order[0] === "w:tagged-spend", `${label}: Finances saved the new order`);
      const mainBoard = b.dashboards.find((d) => d.id === "main")!;
      check(mainBoard.quiet === true && mainBoard.order.length === 0 && b.widgets.every((w) => mainBoard.hidden.includes(`w:${w.id}` as any)),
        `${label}: Main is as it was (quiet mode, built-in order, none of the new cards on it)`);

      // The cards on the tab: accurate, each record once.
      const cardText = async (id: string) => (await T(`exec-card-w-${id}`).textContent() || "").replace(/\s+/g, " ");
      const spendText = await cardText("tagged-spend");
      check(spendText.includes("$43") && spendText.includes(`Coffee ${word}`) && spendText.includes(`Lunch ${word}`), `${label}: Tagged Spend shows both purchases and their total, $43`);
      check((await page.locator('[data-testid="exec-card-w-tagged-spend"] [data-testid^="exec-widget-row-"]').count()) === 2, `${label}: …two rows, each purchase once`);
      check((await page.locator('[data-testid="exec-card-w-tagged-journal"] [data-testid^="exec-widget-row-"]').count()) === 2, `${label}: Tagged Journal lists the two entries, each once`);
      const dup = await page.$$eval('[data-testid^="exec-card-w-"]', (ns: Element[]) => ns.map((n) => { const k = Array.from(n.querySelectorAll('[data-testid^="exec-widget-row-"]')).map((r) => r.getAttribute("data-testid")); return k.length - new Set(k).size; }).reduce((a, c) => a + c, 0));
      check(dup === 0, `${label}: no record appears twice in any custom card`);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      check(m.sw <= m.iw, `${label}: no sideways scroll (${m.sw} ≤ ${m.iw})`);
      await shot("finances");

      // Switch dashboards on the tab; it holds across a reload.
      await tap("exec-dashboard-main");
      await T("exec-card-tasks").waitFor({ timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout(1000);
      check((await T("exec-card-w-tagged-spend").count()) === 0 && (await T("exec-card-money").count()) === 1, `${label}: switching to Main shows Main's cards and none of the custom ones`);
      await page.reload();
      await T("exec-card-money").waitFor({ timeout: 45000 });
      await page.waitForTimeout(1200);
      check((await T("exec-dashboard-main").getAttribute("aria-selected")) === "true" && (await T("exec-card-w-tagged-spend").count()) === 0, `${label}: after a reload Main is still the one showing`);
      await tap("exec-dashboard-finances");
      await T("exec-card-w-tagged-spend").waitFor({ timeout: 15000 });
      check(true, `${label}: switching back shows Finances`);

      // Rename, then delete (two taps). The cards that were built are kept.
      await tap("btn-dashboard-menu");
      await tap("btn-customize");
      await T("exec-customize-list").waitFor({ timeout: 15000 });
      await T("exec-customize-board-name").fill("Money HQ");
      await tap("exec-customize-save");
      await T("exec-customize-list").waitFor({ state: "detached", timeout: 15000 });
      await page.waitForTimeout(800);
      check((await T("exec-dashboard-finances").textContent()) === "Money HQ", `${label}: a renamed dashboard shows its new name on the tab`);
      await tap("btn-dashboard-menu");
      await tap("btn-customize");
      await T("exec-customize-list").waitFor({ timeout: 15000 });
      await tap("exec-customize-board-delete");
      check((await T("exec-customize-board-delete").textContent() || "").includes("Tap again"), `${label}: deleting a dashboard asks for a second tap`);
      await tap("exec-customize-board-delete");
      await tap("exec-customize-save");
      await T("exec-customize-list").waitFor({ state: "detached", timeout: 15000 });
      await page.waitForTimeout(1200);
      b = await storedNow();
      check(b.dashboards.length === 1 && b.dashboards[0].id === "main" && b.widgets.length >= 2, `${label}: Main remains; the cards that were built are kept (${b.widgets.length})`);
      check((await T("exec-dashboards").count()) === 0, `${label}: back to one dashboard, the switcher is gone`);
      const p = activeExecPrefs(b);
      check(p.quiet === true && p.order.length === 0, `${label}: Main still has its original layout`);
      check(errors.length === 0, `${label}: no page errors${errors.length ? ` (${errors[0].slice(0, 120)})` : ""}`);
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const [path, id] of created) await api("DELETE", `${path}/${id}`).catch(() => undefined);
    if (original !== undefined) await api("PUT", PREF, { value: original ?? "" }).catch(() => undefined);
    await release();
  }
  if (failed) { console.error("\nFAILED"); process.exit(1); }
  console.log("\nall checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
