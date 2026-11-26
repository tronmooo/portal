// Live check: the asset Overview (owner's layout, 2026-11-23) on the DEPLOYED
// app, in a real browser, as the smoke account.
//
//   npx tsx tests/live-asset-overview-check.ts
//
// What it proves end to end (CLAUDE.md, "Asset profile layout"):
//   · the header is the name and the current value; the Value card has the rest
//   · the Overview is the Value card, the AI summary and one Asset details list;
//     a line's pencil edits it in place
//   · a characteristic is added, and removed with two taps
//   · Money is merged into Financials, which lists the asset's expense
//
// Writes only to the smoke account, holds the gate lock while it does
// (acquireGateLock) and deletes what it created.
import { createRequire } from "node:module";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright");

let failed = 0;
function check(ok: boolean, label: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed++;
}
async function write(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}
async function read(path: string): Promise<any> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
/** Poll the stored record until it satisfies `ok` (a write lands a moment after the click). */
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, 1000)); v = await get(); }
  return v;
}
const stamp = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const t = (id: string) => `[data-testid="${id}"]`;

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-asset-overview-check" });
  const created: { profiles: string[]; expenses: string[]; tasks: string[] } = { profiles: [], expenses: [], tasks: [] };
  const tag = stamp();
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

    const asset = await write("POST", "/profiles", { type: "asset", name: `Overview Laptop ${tag}`, fields: { purchasePrice: 899, currentValue: 600, brand: "ASUS" } });
    created.profiles.push(asset.id);
    const expense = await write("POST", "/expenses", { description: `Charger ${tag}`, amount: 39.99, category: "general", linkedProfiles: [asset.id] });
    created.expenses.push(expense.id);
    const stored = () => read(`/profiles/${asset.id}`);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, timezoneId: "America/Los_Angeles" });
    try {
      await page.goto(UI_BASE);
      const email = page.locator(t("input-signin-email"));
      if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
        await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
        await page.locator(t("tab-signin")).click({ timeout: 5000 }).catch(() => undefined);
      }
      await email.waitFor({ timeout: 30000 });
      await email.fill(LIVE_EMAIL);
      await page.fill(t("input-signin-password"), LIVE_PASSWORD);
      await page.click(t("button-signin"));
      await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });

      await page.goto(`${UI_BASE}/#/profiles/${asset.id}`);
      await page.locator(t("asset-details")).waitFor({ timeout: 30000 });

      // ── Header ──
      check(/\$\d/.test(await page.locator(t("hero-stat-current-value")).innerText()), "the header shows the current value");
      check((await page.locator(t("hero-stat-purchase-price")).count()) === 0, "the header shows nothing but the name and the value");
      check((await page.locator(t("overview-missing-purchasePrice")).innerText()).includes("$899"), "the Value card shows the purchase price ($899)");
      check((await page.locator(t("tab-money")).count()) === 0 && (await page.locator(t("tab-financials")).count()) === 1, "Money is merged into Financials (no Money tab)");

      // ── Asset details: each line's pencil edits it in place ──
      const edit = async (line: string, input: string, value: string) => {
        await page.locator(t(line)).click();
        await page.locator(t(input)).fill(value);
        await page.locator(t(`${input}-save`)).click();
      };
      await page.locator(t("asset-detail-name")).click();
      await page.locator(t("asset-name-input")).fill(`Overview Laptop ${tag} Pro`);
      const before = await stored();
      check(before.name === `Overview Laptop ${tag}`, "typing alone stores nothing");
      await page.locator(t("asset-name-input-save")).click();
      await edit("overview-missing-purchasePrice", "overview-field-input-purchasePrice", "950");
      await edit("asset-detail-location", "overview-field-input-location", "Office");
      await edit("asset-detail-notes", "asset-notes-input", `Checked ${tag}`);
      const after = await until(stored, (p) => p.name?.endsWith(" Pro") && p.fields?.location === "Office" && p.notes === `Checked ${tag}`);
      check(after.name === `Overview Laptop ${tag} Pro`, `the name line stored the name (${after.name})`);
      check(Number(after.fields?.purchasePrice) === 950, `the purchase price is stored as a number (${JSON.stringify(after.fields?.purchasePrice)})`);
      check(after.fields?.location === "Office", "the location line stored the location");
      check(after.notes === `Checked ${tag}`, "the notes line stored the notes");
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("$950"), t("overview-missing-purchasePrice"), { timeout: 20000 }).catch(() => undefined);
      check((await page.locator(t("overview-missing-purchasePrice")).innerText()).includes("$950"), "the Value card follows the saved purchase price without a reload");
      check((await page.locator(t("text-profile-detail-name")).innerText()).endsWith(" Pro"), "the header follows the saved name without a reload");

      // ── The graph, with its ranges, is on the card ──
      check((await page.locator(t("asset-value-graph")).count()) === 1, "the Value card has the value graph");
      check((await page.locator(t("asset-value-range-1y")).count()) === 1, "the graph has time ranges");

      // ── Depreciation is stated; a typed salvage value overrides the AI's ──
      const dep = await page.locator(t("asset-depreciation")).innerText();
      check(/Depreciated since purchase|Gained since purchase/.test(dep), `the Value card states the change since purchase (${dep.split("\n")[0]})`);
      check(!/Confidence/.test(await page.locator(t("asset-value-card")).innerText()), "the Value card shows no confidence figure");
      // ── Optimal disposal: a money line between Current value and Salvage value ──
      await page.locator(t("asset-optimal-disposal-value")).first().waitFor({ timeout: 20_000 }).catch(() => {});
      const lineOrder = await page.locator(t("asset-value-card")).evaluate((card) =>
        Array.from(card.querySelectorAll("[data-testid]")).map((e) => e.getAttribute("data-testid")));
      const iCur = lineOrder.indexOf("asset-value-row-current-value"), iOd = lineOrder.indexOf("asset-optimal-disposal"), iSal = lineOrder.indexOf("asset-value-salvage");
      check(iCur >= 0 && iOd > iCur && iSal > iOd, "Optimal disposal sits between Current value and Salvage value");
      const odText = (await page.locator(t("asset-optimal-disposal-value")).first().innerText().catch(() => "")).trim();
      check(/^\$[\d,]+$|^None|^Needs|^Not applicable/.test(odText), `the Optimal disposal line shows a figure or says why not (${odText})`);
      await edit("asset-value-salvage", "overview-field-input-salvageValue", "150");
      const withSalvage = await until(stored, (p) => Number(p.fields?.salvageValue) === 150);
      check(Number(withSalvage.fields?.salvageValue) === 150, "the salvage value is stored as a number");

      // ── The Overview holds three things and nothing else ──
      for (const gone of ["asset-quick-info", "asset-characteristics", "asset-section-activity"]) {
        check((await page.locator(t(gone)).count()) === 0, `the Overview has no ${gone}`);
      }

      // ── Characteristics are lines of the same list: add, then remove in two taps ──
      await page.locator(t("asset-add-characteristic")).click();
      await page.locator(t("add-field-key")).fill("Color");
      await page.locator(t("add-field-value")).fill("Silver");
      await page.locator(t("add-field-save")).click();
      const withColor = await until(stored, (p) => Object.entries(p.fields || {}).some(([k, v]) => /^colou?r$/i.test(k) && v === "Silver"));
      check(Object.keys(withColor.fields || {}).some((k) => /^colou?r$/i.test(k)), "Add characteristic stored Color = Silver");
      await page.locator(t("overview-field-brand")).click({ timeout: 20000 });
      const brandRemove = page.locator(t("overview-field-remove-brand"));
      await brandRemove.click();
      check((await stored()).fields?.brand === "ASUS", "the first tap on remove only arms it");
      await brandRemove.click();
      const noBrand = await until(stored, (p) => p.fields?.brand == null);
      check(noBrand.fields?.brand == null, "the second tap removes the characteristic");

      // ── No quick-add row under the tabs ──
      check((await page.locator(t("asset-quick-add")).count()) === 0, "there is no + Task / + Expense / + Note row");

      // ── Financials holds what Money did ──
      await page.locator(t("tab-financials")).click();
      await page.locator(t("asset-expenses")).waitFor({ timeout: 20000 });
      const toggle = page.locator(t("button-toggle-expenses-list"));
      if (await toggle.count()) await toggle.first().click().catch(() => undefined);
      await page.getByText(`Charger ${tag}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      check((await page.getByText(`Charger ${tag}`).count()) > 0, "the Financials tab lists the asset's expense");
    } finally {
      await browser.close();
    }
  } finally {
    for (const id of created.tasks) await api("DELETE", `/tasks/${id}`).catch(() => undefined);
    for (const id of created.expenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const id of created.profiles.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
