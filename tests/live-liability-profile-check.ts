// Live check (deployed app, smoke account) for the liability profile page in
// the owner's design (2026-11-23): it loads with real data, the details edit
// in place and save themselves, a characteristic / an expense / a task / Auto
// Pay can be added, every tab loads, a change made in chat shows on the page,
// and delete returns to the list.
// Takes the gate lock, writes only the records it creates, deletes them after.
//   npx tsx tests/live-liability-profile-check.ts
//
// To check a client build that is not deployed yet against the deployed API
// (the page is client-only): serve it locally and set
//   SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me
// The browser's /api requests are then forwarded to LIVE_API_ORIGIN.
import { createRequire } from "node:module";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE, UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { readInterestRatePct, readBalance } from "../shared/liability-fields";

const req = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || ".";
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function get<T = any>(path: string): Promise<T> {
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${await getSmokeToken()}` } });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  return response.json();
}
/** Poll a stored value: a write made in the browser lands a moment after the tap. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) { await new Promise((r) => setTimeout(r, 700)); v = await read(); }
  return v;
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-liability-profile-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const name = `Verify Auto Loan ${tag}`;
  const INTERNAL_ID = "2b6ad3c2-64ed-4ea2-a111-222222222222";
  let loanId: string | null = null;
  let carId: string | null = null;
  let expenseId: string | null = null;
  let taskId: string | null = null;
  try {
    const version = await (await fetch(`${API_ORIGIN || UI_BASE}/api/version`)).json();
    console.log(`API is serving ${String(version.sha).slice(0, 7)}; UI at ${UI_BASE}`);

    const car = await api("POST", "/profiles", { type: "vehicle", name: `Verify CR-V ${tag}`, fields: {} });
    if (!car.ok) throw new Error(`create asset: ${car.status}`);
    carId = car.data.id;
    const made = await api("POST", "/profiles", {
      type: "liability", type_key: "auto_loan", name,
      fields: {
        balance: 18420, originalBalance: 28000, interestRate: 5.49, monthlyPayment: 530.26, dueDay: 12,
        firstPaymentDate: "2024-01-12", lender: "Honda Financial Services",
        // What a liability converted from a bill carries: bookkeeping, not details.
        source: "obligation", obligationId: INTERNAL_ID,
      },
    });
    if (!made.ok) throw new Error(`create: ${made.status} ${JSON.stringify(made.data).slice(0, 200)}`);
    loanId = made.data.id;
    const profile = () => get<any>(`/profiles/${loanId}`);

    const proxy = process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } } : {};
    const browser = await chromium.launch(proxy);
    try {
      const context = await browser.newContext({ ...devices["iPhone 14 Pro Max"] });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      const failedApi: string[] = [];
      page.on("pageerror", (e: Error) => pageErrors.push(String(e)));
      page.on("response", (r: any) => { if (/\/api\//.test(r.url()) && r.status() >= 500) failedApi.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, "")}`); });
      if (API_ORIGIN) {
        // A local client build against the deployed API.
        await page.route(/\/api\//, async (route: any) => {
          const request = route.request();
          const url = new URL(request.url());
          const headers = { ...request.headers() };
          delete headers.host; delete headers.origin; delete headers.referer; delete headers["content-length"];
          try {
            const res = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, {
              method: request.method(), headers, body: request.postDataBuffer() ?? undefined,
            });
            const body = Buffer.from(await res.arrayBuffer());
            const out: Record<string, string> = {};
            res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v; });
            await route.fulfill({ status: res.status, headers: out, body });
          } catch (e) {
            await route.abort();
          }
        });
      }

      await page.goto(UI_BASE);
      const email = page.locator('[data-testid="input-signin-email"]');
      if (!(await email.isVisible().catch(() => false))) {
        await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
        await page.locator('[data-testid="tab-signin"]').click({ timeout: 5000 }).catch(() => undefined);
      }
      await email.waitFor({ timeout: 30000 });
      await email.fill(LIVE_EMAIL);
      await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
      await page.click('[data-testid="button-signin"]');
      await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 45000 });

      const text = async (testId: string) => ((await page.locator(`[data-testid="${testId}"]`).first().innerText({ timeout: 15000 }).catch(() => "")) || "").replace(/\s+/g, " ");
      const open = async () => {
        // Away and back: the same hash URL is not a navigation, and the check
        // is that a REOPENED profile shows what was written elsewhere (L6).
        await page.goto(`${UI_BASE}/#/linked?tab=liabilities`);
        await page.goto(`${UI_BASE}/#/profiles/${loanId}`);
        await page.locator('[data-testid="kpi-balance"]').waitFor({ timeout: 45000 });
      };

      // ── 1. It loads, in the design, from the stored record ──────────────────
      await open();
      await page.locator('[data-testid="detail-row-linked-asset"]').filter({ hasText: /\+ Add|Loading|Couldn/ }).waitFor({ timeout: 20000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      check((await text("detail-hero-page-title")) === "Liability Profile", "the header card is tagged Liability Profile");
      check(/Balance.*Payment.*APR.*Payoff/.test(await text("detail-hero-figures")), "…and carries Balance / Payment / APR / Payoff");
      check((await text("kpi-balance")) === "$18,420", `Balance $18,420 (${await text("kpi-balance")})`);
      check((await text("kpi-apr")) === "5.49%" && (await text("kpi-monthly")) === "$530.26/mo", `APR 5.49% and $530.26/mo (${await text("kpi-apr")}, ${await text("kpi-monthly")})`);
      check(/^[A-Z][a-z]{2} 20\d\d$/.test(await text("kpi-payoff")), `a payoff month (${await text("kpi-payoff")})`);
      check(/Auto loan/.test(await text("chip-type")) && /Honda Financial Services/.test(await text("chip-lender")) && /You owe this/.test(await text("chip-owner")), "the chips name the type, the lender and the owner");
      for (const t of ["overview", "payments", "schedule", "cost", "documents", "history"]) {
        check((await page.locator(`[data-testid="tab-${t}"]`).count()) === 1, `the ${t} tab is there`);
      }
      check((await text("detail-lender")) === "Honda Financial Services" && (await text("detail-original")) === "$28,000" && (await text("detail-due-day")) === "12th" && (await text("detail-start")) === "Jan 12, 2024",
        "Liability Details reads the stored lender, original amount, due day and start date");
      check(/\b12, 20\d\d/.test(await text("quick-next-due")) && /\d+ months?/.test(await text("quick-remaining-term")), `Quick Info has the next due date and the remaining term (${await text("quick-next-due")})`);
      check((await page.locator('[data-testid="payoff-line"]').count()) === 1 && /\$9,580 · 34\.2%/.test(await text("paid-down")), "Balance & Payoff draws the line and shows $9,580 · 34.2% paid down");
      const body = (await page.locator('[data-testid="liability-profile-page"]').innerText()).replace(/\s+/g, " ");
      check(!body.includes(INTERNAL_ID.slice(0, 8)) && !/obligation id/i.test(body) && !/source\s*obligation/i.test(body), "no 'Source: obligation' / 'Obligation ID' lines");
      check(!/Couldn't load/.test(body), "nothing on the page failed to load");
      await page.screenshot({ path: `${SHOT}/live-liability-profile.png`, fullPage: false });

      // ── 2. A figure starts the edit in place; the change saves itself ───────
      await page.locator('[data-testid="kpi-apr"]').tap();
      const rate = page.locator('[data-testid="input-terms-rate"]');
      await rate.waitFor({ timeout: 15000 });
      check((await rate.inputValue()) === "5.49", `tapping the APR opens the form with 5.49 (${await rate.inputValue()})`);
      await rate.fill("4.9");
      const saved = await page.locator('[data-testid="terms-autosave-status"]').filter({ hasText: /^Saved$/ }).waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      check(saved, "the form reports Saved on its own");
      await page.locator('[data-testid="input-edit-notes"]').fill(`Verify note ${tag}`);
      await page.locator('[data-testid="button-save-terms"]').tap();
      await rate.waitFor({ state: "detached", timeout: 15000 });
      const afterRate = await until(profile, (p) => readInterestRatePct(p.fields) === 4.9 && p.notes === `Verify note ${tag}`);
      check(readInterestRatePct(afterRate.fields) === 4.9, `the stored rate is 4.9 (${readInterestRatePct(afterRate.fields)})`);
      check(afterRate.notes === `Verify note ${tag}`, `the note typed in the form is stored (${afterRate.notes})`);
      await page.locator('[data-testid="kpi-apr"]').filter({ hasText: "4.90%" }).waitFor({ timeout: 20000 }).catch(() => undefined);
      check((await text("kpi-apr")) === "4.90%" && (await text("detail-rate")) === "4.90%", `the header and the card show 4.90% after Save (${await text("kpi-apr")})`);
      await page.locator('[data-testid="detail-notes"]').filter({ hasText: `Verify note ${tag}` }).waitFor({ timeout: 10000 }).catch(() => undefined);
      check((await text("detail-notes")) === `Verify note ${tag}`, "…and the note");

      // ── 3. A characteristic can be added and shows as a line ───────────────
      await page.locator('[data-testid="add-field-button"]').tap();
      await page.locator('[data-testid="add-field-key"]').fill("Loan number");
      await page.locator('[data-testid="add-field-value"]').fill(`HF-${tag}`);
      await page.locator('[data-testid="add-field-save"]').tap();
      const withField = await until(profile, (p) => Object.values(p.fields || {}).includes(`HF-${tag}`));
      check(Object.values(withField.fields || {}).includes(`HF-${tag}`), "the added characteristic is stored");
      const fieldShown = await page.locator('[data-testid="characteristics-card"]').filter({ hasText: `HF-${tag}` }).waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
      check(fieldShown, "…and listed under Characteristics");

      // ── 4. Auto Pay switches on from the card ───────────────────────────────
      await page.locator('[data-testid="switch-autopay-hero"]').tap();
      const sched = await until(() => get<any>(`/liabilities/${loanId}/schedule?months=3`), (s) => s.autopay === true);
      check(sched.autopay === true, "the Autopay switch turns Auto Pay on (stored)");
      await page.locator('[data-testid="hero-autopay-state"]').filter({ hasText: /Automatically record/ }).waitFor({ timeout: 20000 }).catch(() => undefined);
      check(/Automatically record payment & expense/.test(await text("hero-autopay-state")), "…and the card says it records automatically");

      // ── 5. Adding from the action row: an expense, a task, a linked asset ───
      await page.locator('[data-testid="button-add-expense"]').tap();
      await page.locator('[data-testid="input-liability-expense-desc"]').fill(`Verify fee ${tag}`);
      await page.locator('[data-testid="input-liability-expense-amount"]').fill("25");
      await page.locator('[data-testid="button-save-liability-expense"]').tap();
      const expenses = await until(() => get<any[]>("/expenses"), (list) => Array.isArray(list) && list.some((e) => e.description === `Verify fee ${tag}`));
      const expense = (Array.isArray(expenses) ? expenses : []).find((e) => e.description === `Verify fee ${tag}`);
      check(!!expense && Number(expense.amount) === 25 && (expense.linkedProfiles || []).includes(loanId), "+ Expense stores a $25 expense linked to this liability");
      if (expense) expenseId = expense.id;
      await page.locator('[data-testid="button-add-task"]').tap();
      await page.locator('[data-testid="input-liability-task-title"]').fill(`Verify task ${tag}`);
      await page.locator('[data-testid="button-save-liability-task"]').tap();
      const tasks = await until(() => get<any[]>("/tasks"), (list) => Array.isArray(list) && list.some((t) => t.title === `Verify task ${tag}`));
      const task = (Array.isArray(tasks) ? tasks : []).find((t) => t.title === `Verify task ${tag}`);
      check(!!task, "+ Task stores the task");
      if (task) taskId = task.id;
      await page.locator('[data-testid="link-asset-add"]').tap();
      const picker = await page.locator('[data-testid="link-asset-picker"]').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      check(picker, "Linked asset: + Add opens the asset picker");
      await page.keyboard.press("Escape");

      // ── 6. The other tabs load ──────────────────────────────────────────────
      await page.locator('[data-testid="tab-payments"]').tap();
      check(await page.locator('[data-testid="autopay-section"]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false), "Payments shows Auto Pay and the payment history");
      await page.locator('[data-testid="tab-schedule"]').tap();
      check(await page.locator('[data-testid="amort-table"]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false), "Schedule shows the amortization table");
      await page.locator('[data-testid="tab-cost"]').tap();
      check(await page.locator('[data-testid="payoff-outlook"]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false), "Cost of Ownership shows the payoff outlook");
      await page.locator('[data-testid="tab-documents"]').tap();
      check(await page.locator('[data-testid="liability-doc-upload"]').waitFor({ timeout: 20000 }).then(() => true).catch(() => false), "Documents offers the upload");
      await page.locator('[data-testid="tab-history"]').tap();
      await page.waitForTimeout(1500);
      check(!/Couldn't load|Something went wrong/.test(await page.locator('[data-testid="liability-profile-page"]').innerText()), "History loads");

      // ── 7. Chat is connected: "Ask Portol about this" opens chat with the
      //       liability named, the message edits this record, and the page
      //       shows it when the user comes back (L6) ─────────────────────────
      await page.locator('[data-testid="button-more-actions"]').tap();
      await page.locator('[data-testid="menu-ask-portol"]').tap();
      const input = page.locator('[data-testid="input-chat"]');
      await input.waitFor({ timeout: 30000 });
      const prefill = await until(() => input.inputValue(), (v: string) => v.includes(name), 10000);
      check(prefill.includes(`About my ${name}`), `the chat box opens with "About my ${name}: " (${prefill.slice(0, 60)})`);
      await input.fill(`${prefill.trim()} the balance is now $17,900`);
      await page.locator('[data-testid="button-send"]').tap();
      const afterChat = await until(profile, (p) => readBalance(p.fields) === 17900, 90000);
      check(readBalance(afterChat.fields) === 17900, `the message sent from the app's chat changed the stored balance to 17,900 (${readBalance(afterChat.fields)})`);
      await page.waitForTimeout(3000);
      await page.goto(`${UI_BASE}/#/profiles/${loanId}`);
      await page.locator('[data-testid="kpi-balance"]').waitFor({ timeout: 45000 });
      await page.locator('[data-testid="kpi-balance"]').filter({ hasText: "$17,900" }).waitFor({ timeout: 20000 }).catch(() => undefined);
      check((await text("kpi-balance")) === "$17,900" && (await text("detail-balance")) === "$17,900", `back on the profile, the header and the card show what chat set (${await text("kpi-balance")})`);
      await page.screenshot({ path: `${SHOT}/live-liability-profile-after-chat.png`, fullPage: false });

      // ── 8. Delete (two taps) returns to the Liabilities list ────────────────
      await page.locator('[data-testid="button-more-actions"]').tap();
      await page.locator('[data-testid="button-delete-profile"]').tap();
      await page.locator('[data-testid="button-confirm-delete-profile"]').tap({ timeout: 15000 });
      await page.waitForFunction(() => /#\/linked/.test(location.href) && /tab=liabilities/.test(location.href), null, { timeout: 20000 }).catch(() => undefined);
      const onList = /#\/linked/.test(page.url()) && /tab=liabilities/.test(page.url());
      check(onList, "after deleting, the app is on the Liabilities list");
      if (onList) loanId = null;

      check(pageErrors.length === 0, `no script errors on the page${pageErrors.length ? `: ${pageErrors.slice(0, 2).join(" | ")}` : ""}`);
      check(failedApi.length === 0, `no request failed with a server error${failedApi.length ? `: ${failedApi.slice(0, 3).join(", ")}` : ""}`);
    } finally {
      await browser.close();
    }
  } finally {
    if (loanId) await api("DELETE", `/profiles/${loanId}`).catch(() => undefined);
    if (carId) await api("DELETE", `/profiles/${carId}`).catch(() => undefined);
    if (expenseId) await api("DELETE", `/expenses/${expenseId}`).catch(() => undefined);
    if (taskId) await api("DELETE", `/tasks/${taskId}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
