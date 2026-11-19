// Live walk-through (production, smoke account, real browser) of the Assets &
// Liabilities fixes of 2026-11-19 that tests/live-assets-liabilities-check.ts
// does not click through. Item numbers are the owner's bug list.
//   npx tsx tests/live-assets-liabilities-ui-check.ts
// Takes the gate lock; deletes what it creates. The browser runs in
// America/Los_Angeles, where the one-day date shift used to show.
import { createRequire } from "node:module";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || ".";
const SKIP_CHAT = process.env.SKIP_CHAT === "1";
const TZ = "America/Los_Angeles";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

let dataVersion: string | undefined;
async function write(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  const h = r.headers.get("x-data-version");
  if (h) dataVersion = h;
  if (typeof (r.data as any)?.dataVersion === "string") dataVersion = (r.data as any).dataVersion;
  return r.data;
}
async function read(path: string): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getSmokeToken()}` };
  if (dataVersion) headers["x-data-version"] = dataVersion;
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}
const dayISO = (offset = 0) => new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-assets-liabilities-ui-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const created = { profiles: [] as string[], expenses: [] as string[] };
  const today = dayISO(), yesterday = dayISO(-1);
  let browser: any;
  try {
    console.log(`production is serving ${String((await (await fetch(`${UI_BASE}/api/version`)).json()).sha).slice(0, 7)}; today in ${TZ} is ${today}`);

    // ── records to look at ───────────────────────────────────────────────
    const asset = await write("POST", "/profiles", { type: "asset", name: `UI Check Headphones ${tag}`, fields: { purchaseDate: "2024", purchasePrice: 599, brand: "Sony" } });
    created.profiles.push(asset.id);
    const expense = await write("POST", "/expenses", { description: `UI ear pads ${tag}`, amount: 39.99, category: "general", categoryChosen: true, date: today, linkedProfiles: [asset.id] });
    created.expenses.push(expense.id);
    const loan = await write("POST", "/profiles", {
      type: "liability", type_key: "mortgage", name: `UI Check Mortgage ${tag}`,
      fields: { currentBalance: 312400, originalBalance: 312400, interestRate: 6.25, monthlyPayment: 2155, firstPaymentDate: "2022-07-01", remainingTermMonths: 360, lender: "Northgate" },
    });
    created.profiles.push(loan.id);
    const untyped = await write("POST", "/profiles", { type: "liability", name: `UI Check Debt ${tag}`, fields: { currentBalance: 5000, firstPaymentDate: "2022-07-01" } });
    created.profiles.push(untyped.id);
    const child = await write("POST", "/profiles", { type: "liability", type_key: "credit_card", name: `UI Check Store Card ${tag}`, parentProfileId: loan.id, fields: { currentBalance: 400 } });
    created.profiles.push(child.id);
    const pay1 = await write("POST", `/liabilities/${loan.id}/payments`, { amount: 2155, paymentDate: today });

    // ── browser ──────────────────────────────────────────────────────────
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, timezoneId: TZ });
    const text = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const shot = (name: string) => page.screenshot({ path: `${SHOT}/ui-${name}.png`, fullPage: true }).catch(() => undefined);
    const appears = (t: string | RegExp, ms = 15000) => page.getByText(t).first().waitFor({ timeout: ms }).then(() => true).catch(() => false);

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

    // ASSET PAGE ──────────────────────────────────────────────────────────
    await page.goto(`${UI_BASE}/#/profiles/${asset.id}`);
    await page.locator('[data-testid="tab-info"]').waitFor({ timeout: 30000 });
    await page.locator('[data-testid="dynamic-overview"]').waitFor({ timeout: 30000 }).catch(() => undefined);
    // The purchase date sits in the collapsible "Dates" row.
    await page.getByText("Dates", { exact: true }).first().click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    let t = await text();
    check(/Purchase Date\s*2024\b/i.test(t) && !/Dec 31, 2023/.test(t), `#3 a year-only purchase date shows as 2024, not Dec 31, 2023`);
    if (!/Purchase Date\s*2024\b/i.test(t)) console.log(`      overview text: …${t.slice(Math.max(0, t.search(/Purchase Date/i) - 40), t.search(/Purchase Date/i) + 80)}`);
    await shot("asset-overview");

    console.log(`      tabs: ${(await page.locator('[role="tab"]').evaluateAll((els: any[]) => els.map((e) => e.getAttribute("data-testid")))).join(", ")}`);
    const hasActivityTab = await page.locator('[data-testid="tab-timeline"]').click({ timeout: 15000 }).then(() => true).catch(() => false);
    check(hasActivityTab, "#7 an asset whose only activity is an expense has an Activity tab");
    const actRow = hasActivityTab && await appears(`UI ear pads ${tag}`);
    t = await text();
    const around = t.slice(Math.max(0, t.indexOf(`UI ear pads ${tag}`) - 20), t.indexOf(`UI ear pads ${tag}`) + 160);
    check(actRow && around.includes(dayLabel(today)) && !around.includes(dayLabel(yesterday)), `#7 the asset's Activity tab shows the expense on ${dayLabel(today)}, not ${dayLabel(yesterday)} ("${around.trim().slice(0, 110)}")`);
    await shot("asset-activity");

    await page.locator('[data-testid="tab-money"]').click();
    await page.locator('[data-testid="button-add-expense"]').first().click({ timeout: 15000 });
    await page.locator('[data-testid="dialog-add-expense"]').waitFor({ timeout: 10000 });
    const dlg = page.locator('[data-testid="dialog-add-expense"]');
    check((await dlg.getByText("Description is required").count()) === 0 && (await dlg.getByText("Amount must be greater than 0").count()) === 0, "#10 Add Expense opens with no validation errors");
    await page.locator('[data-testid="input-expense-desc"]').focus();
    await page.locator('[data-testid="input-expense-amount"]').focus();
    check(await dlg.getByText("Description is required").first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false), "#10 …and still flags a required field once it was visited and left empty");
    await shot("asset-add-expense");
    await page.keyboard.press("Escape");

    // ASSETS LIST ─────────────────────────────────────────────────────────
    await page.goto(`${UI_BASE}/#/linked?tab=assets`);
    const acct = page.locator('[data-testid="button-create-account"]');
    await acct.waitFor({ timeout: 30000 }).catch(() => undefined);
    check(/account/i.test(await acct.innerText().catch(() => "")), `#12 the add-account button says what it does ("${(await acct.innerText().catch(() => "")).trim()}")`);
    await shot("assets-list");

    // LIABILITIES LIST ────────────────────────────────────────────────────
    await page.goto(`${UI_BASE}/#/liabilities`);
    const loanCard = page.locator(`[data-testid="liab-card-${loan.id}"]`);
    await loanCard.waitFor({ timeout: 30000 }).catch(() => undefined);
    const loanCardText = (await loanCard.innerText().catch(() => "")).replace(/\s+/g, " ");
    check(/mortgage/i.test(loanCardText.replace(new RegExp(loan.name, "g"), "")) && !/\bother\b/i.test(loanCardText), `#15 the list labels it a mortgage, not Other ("${loanCardText.slice(0, 120)}")`);
    check(loanCardText.length > 0 && !/overdue/i.test(loanCardText), "#16 a mortgage with a 2022 first-payment date is not overdue in the list");
    const untypedText = (await page.locator(`[data-testid="liab-card-${untyped.id}"]`).innerText().catch(() => "")).replace(/\s+/g, " ");
    check(untypedText.length > 0 && !/overdue/i.test(untypedText), `#16 an untyped debt with a 2022 first-payment date is not "1601d overdue" ("${untypedText.slice(0, 120)}")`);
    await shot("liabilities-list");

    // LIABILITY PAGE ──────────────────────────────────────────────────────
    await page.goto(`${UI_BASE}/#/profiles/${loan.id}`);
    const kpi = page.locator('[data-testid="kpi-balance"]');
    await kpi.waitFor({ timeout: 30000 });
    const balanceBefore = (await kpi.innerText()).replace(/\s+/g, " ");
    t = await text();
    check(/6\.25\s?%/.test(t) && !/\b0\.1\s?%/.test(t), "#17 the loan page shows 6.25%, never 0.1%");
    check(!/overdue/i.test(t), "#16 the loan's own page does not call it overdue");
    await shot("loan-overview");

    await page.locator('[data-testid="nested-liabilities-card"]').first().scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => undefined);
    let nested = await page.locator(`[data-testid="nested-liability-${child.id}"]`).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!nested) {
      for (const tab of ["tab-details", "tab-overview"]) {
        await page.locator(`[data-testid="${tab}"]`).click().catch(() => undefined);
        nested = await page.locator(`[data-testid="nested-liability-${child.id}"]`).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
        if (nested) break;
      }
    }
    check(nested, "#22 the nested Liabilities panel lists the child debt");
    await shot("loan-nested");

    await page.locator('[data-testid="tab-details"]').click();
    const hasTermRows = (await appears("Loan term (as entered)", 10000)) && (await appears(/Payoff at \$[\d,.]+\/mo \(calculated\)/, 5000));
    check(hasTermRows, "#27 term and payoff are labelled as two different numbers");
    await page.locator('[data-testid="button-edit-terms"]').click({ timeout: 10000 });
    const rateBox = page.locator('[data-testid="input-terms-rate"]');
    await rateBox.waitFor({ timeout: 10000 });
    check((await rateBox.inputValue()) === "6.25", `#24 the loan-terms form shows the rate as a percent (${await rateBox.inputValue()})`);
    await shot("loan-terms-form");
    await page.keyboard.press("Escape");

    await page.locator('[data-testid="tab-overview"]').click();
    await page.locator('[data-testid="action-extra"]').first().click({ timeout: 15000 });
    await page.locator('[data-testid="payment-dialog"]').waitFor({ timeout: 10000 });
    const amt = await page.locator('[data-testid="payment-amount-input"]').inputValue();
    const split = (await page.locator('[data-testid="payment-dialog"]').innerText()).replace(/\s+/g, " ");
    check(amt === "100.00", `#19 Extra principal prefills only the extra $100 (${amt})`);
    check(/\$100\.00 principal · \$0\.00 interest/.test(split), `#19 …and shows it as all principal ("${(split.match(/Estimated split:[^.]*\.\d\d[^.]*\.\d\d interest/) || [""])[0]}")`);
    await shot("loan-extra-principal");
    await page.keyboard.press("Escape");

    await page.locator('[data-testid="tab-payments"]').click();
    const rev = page.locator(`[data-testid="reverse-payment-${pay1.id}"]`);
    await rev.waitFor({ timeout: 15000 });
    await rev.click();
    const armed = await rev.getByText(/tap again/i).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(1500);
    const stillThere = (await read(`/liabilities/${loan.id}/payments`) as any[]).some((p) => p.id === pay1.id);
    check(armed && stillThere, `#26 one tap on Reverse only arms it; the payment is still there (armed=${armed}, payment kept=${stillThere})`);
    await shot("loan-reverse-armed");

    await page.locator('[data-testid="tab-activity"]').click();
    const payRow = await appears(/Payment \$2,155/);
    t = await text();
    const payAround = t.slice(Math.max(0, t.search(/Payment \$2,155/)), t.search(/Payment \$2,155/) + 200);
    check(payRow && payAround.includes(dayLabel(today)) && !payAround.includes(dayLabel(yesterday)), `#21 the loan's Activity tab shows the payment on ${dayLabel(today)}, not ${dayLabel(yesterday)} ("${payAround.trim().slice(0, 110)}")`);
    await shot("loan-activity");

    // #20: a payment made while the page is closed shows when it is reopened.
    await page.goto(`${UI_BASE}/#/dashboard`);
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
    await write("POST", `/liabilities/${loan.id}/payments`, { amount: 60000, paymentDate: today, paymentType: "extra_principal" });
    await page.goto(`${UI_BASE}/#/profiles/${loan.id}`);
    await kpi.waitFor({ timeout: 30000 });
    await page.waitForTimeout(6000);
    const balanceReopened = (await kpi.innerText()).replace(/\s+/g, " ");
    await page.reload();
    await kpi.waitFor({ timeout: 30000 });
    await page.waitForTimeout(4000);
    const balanceReloaded = (await kpi.innerText()).replace(/\s+/g, " ");
    check(balanceReopened !== balanceBefore && balanceReopened === balanceReloaded, `#20 the header balance is current on reopening, without a reload (before "${balanceBefore}", reopened "${balanceReopened}", after reload "${balanceReloaded}")`);

    // CHAT ────────────────────────────────────────────────────────────────
    if (!SKIP_CHAT) {
      const before = (await read("/profiles") as any[]).map((p) => p.id);
      const thing = `Zentro ZX-${tag} headphones`;
      // Said as an asset: a bare "I bought X for $599" may be logged as an
      // expense instead, which is a fair reading and not what is checked here.
      const expensesBefore = new Set(((await read("/expenses")) as any[]).map((e) => e.id));
      const r1 = await write("POST", "/chat", { message: `Add my ${thing} as an asset. I paid $599 for them.`, history: [] });
      for (const e of (await read("/expenses")) as any[]) if (!expensesBefore.has(e.id) && /zentro/i.test(String(e.description))) created.expenses.push(e.id);
      console.log(`      reply: ${String(r1.reply).replace(/\s+/g, " ").slice(0, 300)}`);
      const made = (await read("/profiles") as any[]).filter((p) => !before.includes(p.id));
      for (const p of made) created.profiles.push(p.id);
      const hp = made.find((p) => /zentro/i.test(p.name));
      check(made.length === 1 && !!hp, `#11 the chat created one asset (${made.map((p) => p.name).join(" | ") || "none"})`);
      if (hp) {
        check(/headphones/i.test(hp.name), `#11 its name keeps the word the user used ("${hp.name}")`);
        check(Array.isArray(hp.tags) && hp.tags.length === 0, `#11 no tags were added unasked (${JSON.stringify(hp.tags)})`);
        const card = (r1.actions || []).find((a: any) => a?.data?._tool === "create_profile" || a?.data?._entityId === hp.id);
        check(!!card, `#11 the reply carries a confirmation card for it (${(r1.actions || []).length} action(s))`);
        check(!/high_value_item/.test(String(r1.reply)), "#11 the reply does not print the raw subtype");
        const r2 = await write("POST", "/chat", { message: `I spent $40 on ear pads for my ${hp.name}`, history: [] });
        console.log(`      reply: ${String(r2.reply).replace(/\s+/g, " ").slice(0, 200)}`);
        const mine = ((await read(`/profiles/${hp.id}/detail`)).relatedExpenses || []).filter((e: any) => Number(e.amount) === 40);
        for (const e of mine) created.expenses.push(e.id);
        check(mine.length === 1, `#2 a chat expense naming the asset is on its Money tab (${mine.length} linked)`);
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    for (const id of created.expenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const id of created.profiles.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
