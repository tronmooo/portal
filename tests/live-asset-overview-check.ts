// Live check: the asset Overview (owner's layout, 2026-11-23) on the DEPLOYED
// app, in a real browser, as the smoke account.
//
//   npx tsx tests/live-asset-overview-check.ts
//
// What it proves end to end (CLAUDE.md, "Asset profile layout"):
//   · the header is the name and the current value; the Value card has the rest
//   · Asset Details is typed into in place and ONE Save stores what changed
//   · a characteristic is added, and removed with two taps
//   · + Task creates an ordinary task linked to the asset
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
      check((await page.locator(t("asset-value-row-purchase-price")).innerText()).includes("$899"), "the Value card shows the purchase price ($899)");
      check((await page.locator(t("tab-money")).count()) === 0 && (await page.locator(t("tab-financials")).count()) === 1, "Money is merged into Financials (no Money tab)");

      // ── Asset Details: type in place, one Save ──
      check(await page.locator(t("asset-details-save")).isDisabled(), "Save is disabled until something is typed");
      await page.locator(t("asset-name-input")).fill(`Overview Laptop ${tag} Pro`);
      await page.locator(t("overview-field-input-purchasePrice")).fill("950");
      await page.locator(t("overview-field-input-location")).fill("Office");
      await page.locator(t("asset-notes-input")).fill(`Checked ${tag}`);
      const before = await stored();
      check(before.fields?.location == null && before.name === `Overview Laptop ${tag}`, "typing alone stores nothing");
      await page.locator(t("asset-details-save")).click();
      const after = await until(stored, (p) => p.name?.endsWith(" Pro") && p.fields?.location === "Office");
      check(after.name === `Overview Laptop ${tag} Pro`, `Save stored the name (${after.name})`);
      check(Number(after.fields?.purchasePrice) === 950, `Save stored the purchase price as a number (${JSON.stringify(after.fields?.purchasePrice)})`);
      check(after.fields?.location === "Office", "Save stored the location");
      check(after.notes === `Checked ${tag}`, "Save stored the notes");
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("$950"), t("asset-value-row-purchase-price"), { timeout: 20000 }).catch(() => undefined);
      check((await page.locator(t("asset-value-row-purchase-price")).innerText()).includes("$950"), "the Value card follows the saved purchase price without a reload");
      check((await page.locator(t("text-profile-detail-name")).innerText()).endsWith(" Pro"), "the header follows the saved name without a reload");

      // ── Characteristics: add, then remove in two taps ──
      await page.locator(t("asset-add-characteristic")).click();
      await page.locator(t("add-field-key")).fill("Color");
      await page.locator(t("add-field-value")).fill("Silver");
      await page.locator(t("add-field-save")).click();
      const withColor = await until(stored, (p) => Object.entries(p.fields || {}).some(([k, v]) => /^colou?r$/i.test(k) && v === "Silver"));
      const colorKey = Object.keys(withColor.fields || {}).find((k) => /^colou?r$/i.test(k));
      check(!!colorKey, "Add Characteristic stored Color = Silver");
      const brandRemove = page.locator(t("overview-field-remove-brand"));
      await brandRemove.waitFor({ timeout: 20000 });
      await brandRemove.click();
      check((await stored()).fields?.brand === "ASUS", "the first tap on X only arms it");
      await brandRemove.click();
      const noBrand = await until(stored, (p) => p.fields?.brand == null);
      check(noBrand.fields?.brand == null, "the second tap removes the characteristic");

      // ── + Task: an ordinary task linked to this asset ──
      await page.locator(t("quick-add-task")).click();
      await page.locator(t("quick-task-title")).fill(`Renew warranty ${tag}`);
      await page.locator(t("quick-task-save")).click();
      const tasks = await until(() => read("/tasks") as Promise<any[]>, (list) => list.some((x) => x.title === `Renew warranty ${tag}`));
      const task = tasks.find((x) => x.title === `Renew warranty ${tag}`);
      if (task) created.tasks.push(task.id);
      check(!!task && (task.linkedProfiles || []).includes(asset.id), "+ Task created a task linked to the asset");

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
