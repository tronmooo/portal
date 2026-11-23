// Live check (production, smoke account) for the liability-page fixes of
// 2026-11-19: the loan-terms form saves by itself, a due day is not printed as
// a date, and deleting a liability returns to the Liabilities list. Takes the
// gate lock, writes only the record it creates, and deletes it when done.
//   npx tsx tests/live-liability-forms-check.ts
import { createRequire } from "node:module";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { readInterestRatePct } from "../shared/liability-fields";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || ".";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function readProfile(id: string): Promise<any> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}/profiles/${id}`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET /profiles/${id}: ${response.status}`);
  return response.json();
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-liability-forms-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  let loanId: string | null = null;
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json();
    console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

    const name = `Verify Mortgage ${tag}`;
    const made = await api("POST", "/profiles", {
      type: "liability", type_key: "mortgage", name,
      fields: { balance: 312400, originalBalance: 350000, interestRate: 6.25, monthlyPayment: 2155, dueDay: 1, firstPaymentDate: "2022-07-01" },
    });
    if (!made.ok) throw new Error(`create: ${made.status} ${JSON.stringify(made.data).slice(0, 200)}`);
    loanId = made.data.id;

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(UI_BASE);
      const email = page.locator('[data-testid="input-signin-email"]');
      if (!(await email.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
        await page.locator('[data-testid="tab-signin"]').click({ timeout: 5000 }).catch(() => undefined);
      }
      await email.fill(LIVE_EMAIL);
      await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
      await page.click('[data-testid="button-signin"]');
      await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });

      // ── Overview: a due day is a number, a 2022 first payment is not a deadline.
      await page.goto(`${UI_BASE}/#/profiles/${loanId}`);
      await page.locator('[data-testid="button-edit-terms"]').waitFor({ timeout: 30000 });
      await page.waitForTimeout(2500);
      const overview = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      check(!/Jan 1, 2001|2001/.test(overview), 'the Overview does not print the due day as "Jan 1, 2001"');
      check(!/passed \d[\d,]* days? ago/i.test(overview), "a 2022 first-payment date is not reported as a passed deadline");
      check(!/\b0\.1%/.test(overview), 'no panel shows the rate as "0.1%"');
      await page.screenshot({ path: `${SHOT}/live-liability-overview.png` });

      // ── Liability Details → Edit: a change saves by itself (Save only finishes).
      await page.locator('[data-testid="button-edit-terms"]').click({ timeout: 15000 });
      const rate = page.locator('[data-testid="input-terms-rate"]');
      await rate.waitFor({ timeout: 15000 });
      check((await rate.inputValue()) === "6.25", `the rate field opens as the percent 6.25 (got ${await rate.inputValue()})`);
      check((await page.getByRole("button", { name: /^save terms$/i }).count()) === 0, "the loan-terms form has no Save button");
      await rate.fill("5.5");
      await page.locator('[data-testid="input-terms-balance"]').fill("305000");
      const status = page.locator('[data-testid="terms-autosave-status"]');
      const saved = await status.filter({ hasText: /^Saved$/ }).waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      check(saved, `the form reports "Saved" on its own (status: ${await status.innerText().catch(() => "missing")})`);
      await page.screenshot({ path: `${SHOT}/live-liability-terms-autosave.png` });
      // Nothing was pressed: the stored record already has the edit.
      const stored = await readProfile(loanId!);
      check(readInterestRatePct(stored.fields) === 5.5, `the stored rate is 5.5 without pressing Save (got ${readInterestRatePct(stored.fields)})`);
      check(Number(stored.fields?.balance ?? stored.fields?.currentBalance) === 305000, `the stored balance is 305000 (got ${stored.fields?.balance ?? stored.fields?.currentBalance})`);
      await page.locator('[data-testid="button-save-terms"]').click();
      // The page refetches after the save; poll until it shows the new values.
      let header = "";
      for (let i = 0; i < 30; i++) {
        header = (await page.locator("body").innerText()).replace(/\s+/g, " ");
        if (/5\.50?\s*%/.test(header) && /305,000/.test(header)) break;
        await page.waitForTimeout(500);
      }
      check(/5\.50?\s*%/.test(header) && /305,000/.test(header), "the page shows the new rate and balance after Done");
      if (!(/5\.50?\s*%/.test(header) && /305,000/.test(header))) console.log(`page text: ${header.slice(0, 900)}`);

      // ── Delete → back on the Liabilities list.
      // "Delete this liability" is in the More menu.
      await page.locator('[data-testid="button-more-actions"]').click();
      await page.locator('[data-testid="button-delete-profile"]').click({ timeout: 15000 });
      await page.locator('[data-testid="button-confirm-delete-profile"]').click({ timeout: 15000 });
      // Hash router: "/linked?tab=liabilities" is the URL "/?tab=liabilities#/linked".
      const onList = () => /#\/linked/.test(page.url()) && /tab=liabilities/.test(page.url());
      await page.waitForFunction(() => /#\/linked/.test(location.href) && /tab=liabilities/.test(location.href), null, { timeout: 20000 }).catch(() => undefined);
      check(onList(), `after deleting, the app is on the Liabilities list (at ${page.url().replace(UI_BASE, "")})`);
      await page.screenshot({ path: `${SHOT}/live-liability-after-delete.png` });
      if (onList()) loanId = null;
    } finally {
      await browser.close();
    }
  } finally {
    if (loanId) await api("DELETE", `/profiles/${loanId}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
