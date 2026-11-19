// Live check (production, smoke account) for the Assets & Liabilities fixes of
// 2026-11-19. Takes the gate lock, writes only records it creates, and deletes
// them when it is done.
//   npx tsx tests/live-assets-liabilities-check.ts
//
// Covers, against the DEPLOYED app:
//   • an expense added on an asset is owned by it and listed on its Money tab,
//     in the picked category and on the day entered
//   • an edit is recorded in the History tab's edit history
//   • the Overview read answers at once after an edit that adds a field
//   • a month's interest is charged once; extra principal is principal-only
//   • a rate saved as a percent reads back as that percent
//   • one chat mortgage command creates one record; a chat refinance lands
//   • the Edit dialog saves by itself (real page, real browser)
import { createRequire } from "node:module";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { expenseShownOnProfile } from "../shared/expense-on-profile";
import { readAnnualRate, readBalance, readInterestRatePct } from "../shared/liability-fields";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || ".";
const SKIP_CHAT = process.env.SKIP_CHAT === "1";
const SKIP_UI = process.env.SKIP_UI === "1";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

let dataVersion: string | undefined;
const noteVersion = (r: { headers: Headers; data: any }) => {
  const h = r.headers.get("x-data-version");
  if (h) dataVersion = h;
  if (typeof r.data?.dataVersion === "string") dataVersion = r.data.dataVersion;
};
async function write(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  noteVersion(r);
  return r.data;
}
/** A read the way the app does it: carrying the latest write's version token. */
async function read(path: string): Promise<{ body: any; ms: number }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getSmokeToken()}` };
  if (dataVersion) headers["x-data-version"] = dataVersion;
  const { response, ms } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return { body: await response.json(), ms };
}
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const stamp = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-assets-liabilities-check" });
  const created: { profiles: string[]; expenses: string[] } = { profiles: [], expenses: [] };
  const tag = stamp();
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

    // ── ASSET ────────────────────────────────────────────────────────────
    const assetName = `Verify Headphones ${tag}`;
    const asset = await write("POST", "/profiles", { type: "asset", name: assetName, fields: { purchaseDate: "2024", purchasePrice: 599, brand: "Sony" } });
    created.profiles.push(asset.id);

    const day = todayISO();
    const expense = await write("POST", "/expenses", {
      description: `Ear pads ${tag}`, amount: 39.99, category: "general", categoryChosen: true, date: day, linkedProfiles: [asset.id],
    });
    created.expenses.push(expense.id);
    check(expense.category === "general", `a picked "General" is stored as General (got ${expense.category})`);
    check(String(expense.date).slice(0, 10) === day, `the expense keeps the day entered (${day}, got ${expense.date})`);

    const detail1 = (await read(`/profiles/${asset.id}/detail`)).body;
    const mine = (detail1.relatedExpenses || []).filter((e: any) => e.id === expense.id);
    check(mine.length === 1, "the asset's detail lists the expense");
    check(mine.length === 1 && mine[0].linkedProfiles?.[0] === asset.id, "the expense is owned by the asset (first linked profile)");
    check(mine.length === 1 && expenseShownOnProfile(mine[0], asset.id, asset.type), "the Money tab's rule shows it");
    check(detail1.relatedExpensesOwnedCount === 1, `the Money tab's count is 1 (got ${detail1.relatedExpensesOwnedCount})`);
    const timelineRow = (detail1.timeline || []).find((t: any) => t.id === expense.id);
    check(timelineRow?.timestamp === day, `the Activity row carries the calendar day ${day} (got ${timelineRow?.timestamp})`);
    check(String(detail1.fields?.purchaseDate) === "2024", `a year-only purchase date is stored as entered (got ${detail1.fields?.purchaseDate})`);

    // An edit that ADDS a field: history records it, the Overview answers at once.
    await write("PATCH", `/profiles/${asset.id}`, { fields: { color: "Silver" } });
    const ov = await read(`/profiles/${asset.id}/overview`);
    check(JSON.stringify(ov.body).includes("Silver"), "the Overview read after the edit holds the new value");
    check(ov.ms < 4000, `the Overview read does not wait on the layout model (${ov.ms} ms)`);
    console.log(`      overview layoutPending=${ov.body.layoutPending === true}, schemaSource=${ov.body.meta?.schemaSource}`);
    const hist = (await read(`/profiles/${asset.id}/edit-history`)).body as any[];
    const colorEdit = hist.find((h) => (h.changes || []).some((c: any) => c.field === "color" && c.to === "Silver"));
    check(!!colorEdit, `the History tab's edit history records the edit (${hist.length} entr${hist.length === 1 ? "y" : "ies"})`);
    check(colorEdit?.changedBy === "user", "…as an edit made by the user");

    // ── LIABILITY ────────────────────────────────────────────────────────
    const cardName = `Verify Card ${tag}`;
    const card = await write("POST", "/profiles", { type: "liability", type_key: "credit_card", name: cardName, fields: { currentBalance: 3200, interestRate: 24.99, minimumPayment: 35 } });
    created.profiles.push(card.id);
    const p1 = await write("POST", `/liabilities/${card.id}/payments`, { amount: 500, paymentDate: day });
    // A different amount: an identical second payment on the same day is
    // answered with the first one (the route's duplicate guard).
    const p2 = await write("POST", `/liabilities/${card.id}/payments`, { amount: 400, paymentDate: day });
    check(p2.id !== p1.id, "the second payment is its own ledger row");
    check(Math.abs(Number(p1.interestPortion) - 66.64) < 0.01, `the first payment carries the month's interest (got ${p1.interestPortion})`);
    check(Number(p2.interestPortion) === 0 && Number(p2.principalPortion) === 400, `a second payment the same day is all principal (interest ${p2.interestPortion}, principal ${p2.principalPortion})`);
    const p3 = await write("POST", `/liabilities/${card.id}/payments`, { amount: 100, paymentDate: day, paymentType: "extra_principal" });
    check(Number(p3.interestPortion) === 0 && Number(p3.principalPortion) === 100, `extra principal is principal-only (interest ${p3.interestPortion}, principal ${p3.principalPortion})`);
    const cardNow = (await read(`/profiles/${card.id}/detail`)).body;
    check(Math.abs(readBalance(cardNow) - 2266.64) < 0.01, `the balance is 3,200 − 433.36 − 400 − 100 = 2,266.64 (got ${readBalance(cardNow)})`);

    await write("PATCH", `/profiles/${card.id}`, { fields: { interestRate: 6.25 } });
    const cardOv = (await read(`/profiles/${card.id}/overview`)).body;
    const rateValues: any[] = [];
    JSON.stringify(cardOv, (k, v) => { if (v && typeof v === "object" && v.semanticKey === "interestRate") rateValues.push(v.value); return v; });
    check(rateValues.length > 0 && rateValues.every((v) => Number(v) === 6.25), `the Overview's interest rate is 6.25 (got ${JSON.stringify(rateValues)})`);

    // ── CHAT ─────────────────────────────────────────────────────────────
    if (!SKIP_CHAT) {
      const lender = `Northgate ${tag}`;
      const before = ((await read("/profiles")).body as any[]).map((p) => p.id);
      const r1 = await write("POST", "/chat", { message: `Add my ${lender} mortgage: balance $312,400 at 6.25% APR, $2,155 a month, due on the 1st.`, history: [] });
      console.log(`      reply: ${String(r1.reply).replace(/\s+/g, " ").slice(0, 260)}`);
      const after = ((await read("/profiles")).body as any[]).filter((p) => !before.includes(p.id));
      for (const p of after) created.profiles.push(p.id);
      check(after.length === 1, `one mortgage command created exactly one record (created: ${after.map((p) => p.name).join(" | ") || "none"})`);
      const loan = after.find((p) => /mortgage/i.test(p.name)) || after[0];
      if (loan) {
        check((loan.type_key || loan.typeKey) === "mortgage", `it is typed as a mortgage (got ${loan.type_key || loan.typeKey})`);
        check(readInterestRatePct(loan) === 6.25, `its rate is stored as 6.25% (got ${readInterestRatePct(loan)})`);
        check(/6\.25\s?%/.test(String(r1.reply)), "the reply states 6.25%");
        const r2 = await write("POST", "/chat", { message: `I refinanced my ${lender} mortgage at 5.5%, the new balance is $300,000.`, history: [] });
        console.log(`      reply: ${String(r2.reply).replace(/\s+/g, " ").slice(0, 260)}`);
        const loan2 = (await read(`/profiles/${loan.id}/detail`)).body;
        check(Math.abs(readAnnualRate(loan2) - 0.055) < 1e-9, `the refinance changed the rate to 5.5% (got ${readInterestRatePct(loan2)}%)`);
        check(readBalance(loan2) === 300000, `the refinance changed the balance to $300,000 (got ${readBalance(loan2)})`);
        const chatHist = (await read(`/profiles/${loan.id}/edit-history`)).body as any[];
        check(chatHist.some((h) => h.changedBy === "ai"), `the chat edit appears in the loan's history (${chatHist.length} entr${chatHist.length === 1 ? "y" : "ies"})`);
      }
    }

    // ── THE REAL PAGE ────────────────────────────────────────────────────
    if (!SKIP_UI) {
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 430, height: 1100 }, timezoneId: "America/Los_Angeles" });
      try {
        await page.goto(UI_BASE);
        const email = page.locator('[data-testid="input-signin-email"]');
        if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
          await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
          await page.locator('[data-testid="tab-signin"]').click({ timeout: 5000 }).catch(() => undefined);
        }
        await email.waitFor({ timeout: 30000 });
        await email.fill(LIVE_EMAIL);
        await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
        await page.click('[data-testid="button-signin"]');
        await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });

        // Edit → type → no Save button → it saves by itself.
        await page.goto(`${UI_BASE}/#/profiles/${asset.id}`);
        await page.locator('[data-testid="button-header-edit-profile"]').click({ timeout: 30000 });
        await page.locator('[data-testid="dialog-edit-profile"]').waitFor({ timeout: 15000 });
        check((await page.locator('[data-testid="button-save-profile"]').count()) === 0, "the Edit dialog has no Save button");
        const model = `WH-${tag}`;
        await page.locator('[data-testid="input-field-model"]').fill(model);
        const status = page.locator('[data-testid="edit-save-status"]');
        const saved = await status.filter({ hasText: "All changes saved" }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
        check(saved, `typing in a field saves it without pressing anything (status: "${(await status.innerText().catch(() => "")).trim()}")`);
        const stored = (await read(`/profiles/${asset.id}/detail`)).body;
        check(String(stored.fields?.model) === model, `the typed value is in the database (model = ${stored.fields?.model})`);
        await page.screenshot({ path: `${SHOT}/live-edit-autosave.png` });
        await page.locator('[data-testid="button-done-edit-profile"]').click();

        // The Overview shows the edit without a reload.
        const shownOnPage = await page.getByText(model, { exact: false }).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
        check(shownOnPage, "the page shows the edited value without a reload");

        // Money tab lists the expense; Activity shows the day entered.
        await page.locator('[data-testid="tab-money"]').click({ timeout: 15000 });
        // The list is collapsed until opened; its header carries the count.
        const toggle = page.locator('[data-testid="button-toggle-expenses-list"]');
        await toggle.waitFor({ timeout: 15000 }).catch(() => undefined);
        check((await page.locator('[data-testid="finances-expenses-empty"]').count()) === 0, 'the Money tab does not say "No expenses logged"');
        if ((await toggle.getAttribute("aria-expanded").catch(() => null)) === "false") await toggle.click();
        const onMoney = await page.getByText(`Ear pads ${tag}`).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
        check(onMoney, "the asset's Money tab lists the expense");
        await page.screenshot({ path: `${SHOT}/live-asset-money-tab.png` });
        if (!onMoney) console.log(`page text: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(-1500)}`);

        await page.locator('[data-testid="tab-history"]').click({ timeout: 15000 });
        const histRow = await page.locator('[data-testid="history-edit-row"]').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
        check(histRow, "the History tab lists the edits");
        await page.screenshot({ path: `${SHOT}/live-asset-history-tab.png` });
      } finally {
        await browser.close();
      }
    }
  } finally {
    for (const id of created.expenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const id of created.profiles.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
