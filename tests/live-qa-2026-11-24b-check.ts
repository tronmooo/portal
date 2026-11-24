// Live check for the QA findings of 2026-11-24 (second pass), on the DEPLOYED
// app, as the smoke account.
//
//   npx tsx tests/live-qa-2026-11-24b-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
//
// What it proves:
//   1. The profile Edit dialog saves Next Billing WHOLE: a date typed digit
//      by digit (with pauses) is written once, as 2026-12-12, and is there
//      after the profile is reopened.
//   2. Done waits for the save: a plan changed, Done, an immediate reload —
//      the new plan is stored.
//   3. A task with no due date is not on the Calendar (API and screen).
//   4. A loan's next payment is in Bills & Payments and on the Executive
//      Money card, on the day the Calendar draws it.
//   5. Save on a new document, then Calendar before the save returns: the
//      Calendar stays; the document does not reopen over it.
//   6. Artifacts → a saved note → Edit opens that note in the Notes workspace.
//
// Writes only to the smoke account, holds the gate lock and deletes what it
// created.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const TZ = "America/Los_Angeles";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };
const dayIn = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: TZ });
const today = dayIn(new Date());
const plusDays = (n: number) => dayIn(new Date(Date.now() + n * 86_400_000));

async function call(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

/** Requests the page made (non-GET), and (for an undeployed client) the road to the deployed API. */
async function wire(page: any, writes: Array<{ method: string; path: string; body: string }>) {
  await page.route(/\/api\//, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") writes.push({ method: request.method(), path: url.pathname, body: request.postData() || "" });
    if (!API_ORIGIN) return route.continue().catch(() => undefined);
    const headers = { ...request.headers() };
    delete headers.host; delete headers.origin; delete headers.referer; delete headers["content-length"];
    try {
      const res = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v; });
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch { await route.abort().catch(() => undefined); }
  });
}

async function signIn(page: any) {
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
  await page.waitForSelector(t("page-dashboard"), { timeout: 45000 });
}

const timeline = async (start: string, end: string): Promise<any[]> => {
  const r = await call("GET", `/calendar/timeline?start=${start}&end=${end}`);
  if (!Array.isArray(r)) throw new Error("timeline is not a list");
  return r;
};

(async () => {
  const release = await acquireGateLock(preferenceLockIo(api as any) as any, { gate: "live-qa-2026-11-24b" });
  const made = { profiles: [] as string[], tasks: [] as string[], artifacts: [] as string[] };
  const browser = await chromium.launch();
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  try {
    // ── API-side records ────────────────────────────────────────────────
    const sub = await call("POST", "/profiles", { type: "subscription", name: `Stream Plus ${tag}`, fields: { cost: 15.99, frequency: "monthly", plan: "Basic" } });
    made.profiles.push(sub.id);
    const undated = await call("POST", "/tasks", { title: `Check tripod screws ${tag}`, priority: "medium", status: "todo" });
    made.tasks.push(undated.id);
    const dueIn = 12;
    const loanDue = plusDays(dueIn);
    const loan = await call("POST", "/profiles", {
      type: "liability", type_key: "auto_loan", name: `Demo Auto Loan ${tag}`,
      fields: { balance: 18400, originalBalance: 24000, interestRate: 6.9, _interestRateUnit: "percent", monthlyPayment: 412.5, dueDay: Number(loanDue.slice(8, 10)) },
    });
    made.profiles.push(loan.id);
    const note = await call("POST", "/notes", { title: `Tripod checklist ${tag}`, content: `- [ ] Check tripod screws ${tag}\n- [ ] Pack the plate` });
    made.artifacts.push(note.id);

    // ── 3 · no undated task on the Calendar (API) ───────────────────────
    const tl = await timeline(plusDays(-3), plusDays(40));
    check(!tl.some((i) => i.sourceId === undated.id), "3 · the timeline leaves the task with no due date off the calendar");

    // ── 4 · the loan's payment: Calendar and Bills & Payments agree (API) ─
    const calLoan = tl.filter((i) => i.sourceId === loan.id).map((i) => String(i.date).slice(0, 10)).sort();
    check(calLoan[0] === loanDue, `4 · the Calendar draws the loan's payment on ${loanDue} (${calLoan.join(",") || "nowhere"})`);
    const enh = await call("GET", "/dashboard-enhanced");
    const up: any[] = enh?.financeSnapshot?.billsTimeline?.upcoming;
    if (!Array.isArray(up)) throw new Error("dashboard-enhanced has no billsTimeline.upcoming");
    const row = up.find((r) => r.billId === loan.id);
    check(!!row && row.date === loanDue && Number(row.amount) === 412.5, `4 · Bills & Payments lists it on the same day (${row ? `${row.date} $${row.amount}` : "missing"})`);

    // ── the browser ─────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, timezoneId: TZ, locale: "en-US" });
    const page = await ctx.newPage();
    await page.addInitScript("window.__name = (f) => f;");
    const writes: Array<{ method: string; path: string; body: string }> = [];
    await wire(page, writes);
    await signIn(page);

    // 1 · Next Billing typed digit by digit, with pauses longer than the autosave delay.
    await page.goto(`${UI_BASE}/#/profiles/${sub.id}`);
    await page.locator(t("button-header-edit-profile")).first().click({ timeout: 30000 });
    const date = page.locator(t("input-field-renewalDate"));
    await date.click();
    writes.length = 0;
    await page.keyboard.type("12122026", { delay: 1000 });
    await page.waitForTimeout(1500);
    const datePatches = writes.filter((w) => w.method === "PATCH" && /renewalDate/.test(w.body)).map((w) => JSON.parse(w.body).fields.renewalDate);
    check(datePatches.length === 1 && datePatches[0] === "2026-12-12", `1 · Next Billing was written once, whole (${JSON.stringify(datePatches)})`);
    check((await date.inputValue()) === "2026-12-12", "1 · the field still shows the date");

    // 2 · plan changed, Done, reload at once.
    await page.locator(t("input-field-plan")).fill(`Premium Family ${tag}`);
    await page.locator(t("button-done-edit-profile")).click();
    await page.locator(t("dialog-edit-profile")).waitFor({ state: "detached", timeout: 15000 });
    await page.reload();
    await page.waitForTimeout(1500);
    const stored = (await call("GET", `/profiles/${sub.id}`)).fields;
    check(stored.renewalDate === "2026-12-12", `1 · reopened, Next Billing is 2026-12-12 (${stored.renewalDate})`);
    check(stored.plan === `Premium Family ${tag}`, `2 · the plan changed before Done + reload is stored (${stored.plan})`);
    await page.locator(t("button-header-edit-profile")).first().click({ timeout: 30000 });
    check((await page.locator(t("input-field-renewalDate")).inputValue()) === "2026-12-12", "1 · the reopened dialog shows Next Billing");
    await page.keyboard.press("Escape");

    // 3 · the Calendar screen: no undated task on today.
    await page.goto(`${UI_BASE}/#/calendar`);
    await page.locator(t("section-day-agenda")).waitFor({ timeout: 30000 });
    await page.waitForTimeout(2000);
    check((await page.locator(t(`agenda-item-task-${undated.id}`)).count()) === 0, "3 · the Calendar's day list has no task with no due date");
    check(!(await page.locator(t("section-day-agenda")).innerText()).includes(`Check tripod screws ${tag}`), "3 · …by title either");

    // 4 · the Executive Money card and Bills & Payments list the loan.
    await page.goto(`${UI_BASE}/#/dashboard/executive`);
    const money = page.locator(t("exec-card-money"));
    if (await money.waitFor({ timeout: 45000 }).then(() => true).catch(() => false)) {
      const loanRow = page.locator(t(`exec-money-bill-${loan.id}`));
      const shown = await loanRow.count() > 0 || (await page.locator(t("exec-view-bills")).innerText()).includes("View all");
      check(shown, "4 · the Money card lists the loan payment (or says there are more)");
      await page.locator(t("exec-view-bills")).click();
      await page.locator(t(`bill-timeline-upcoming-${loan.id}`)).waitFor({ timeout: 15000 }).catch(() => undefined);
      check((await page.locator(t(`bill-timeline-upcoming-${loan.id}`)).count()) === 1, "4 · Bills & Payments lists the loan under Upcoming");
      await page.keyboard.press("Escape");
    } else {
      check(false, "4 · the Executive tab shows its Money card");
    }

    // 5 · Save a new document, then Calendar before the answer.
    await page.goto(`${UI_BASE}/#/editor/new/doc`);
    const editor = page.locator(".ProseMirror").first();
    await editor.waitFor({ timeout: 30000 });
    await editor.click();
    await page.keyboard.type(`Race doc ${tag}`);
    await page.locator(t("button-workspace-save")).locator("visible=true").first().click();
    await page.evaluate(() => { location.hash = "#/calendar"; });
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => ({ hash: location.hash, editor: !!document.querySelector(".ProseMirror"), workspace: document.body.getAttribute("data-workspace") }));
    check(after.hash === "#/calendar" && !after.editor && after.workspace == null, `5 · the Calendar stays after the save returns (${JSON.stringify(after)})`);
    const docs = (await call("GET", "/artifacts")) as any[];
    for (const d of docs.filter((d) => String(d.content || "").includes(`Race doc ${tag}`))) made.artifacts.push(d.id);

    // 6 · Artifacts → the note → Edit → the Notes workspace on that note.
    await page.goto(`${UI_BASE}/#/artifacts`);
    const card = page.locator(t(`artifact-card-${note.id}`));
    await card.waitFor({ timeout: 30000 });
    await card.click();
    const edit = page.locator(t("button-edit-note"));
    check(await edit.isVisible({ timeout: 10000 }).catch(() => false), "6 · the note viewer offers Edit");
    writes.length = 0;
    await edit.click();
    await page.waitForFunction(() => location.hash.startsWith("#/workspace/notes"), undefined, { timeout: 15000 });
    const title = page.locator(t("input-note-title")).locator("visible=true").first();
    await page.waitForFunction((want: string) => Array.from(document.querySelectorAll('[data-testid="input-note-title"]')).some((e) => (e as HTMLInputElement).value === want), `Tripod checklist ${tag}`, { timeout: 20000 }).catch(() => undefined);
    check((await title.inputValue()) === `Tripod checklist ${tag}`, "6 · the Notes workspace opened that note");
    check((await page.locator(t("note-rich-editor")).first().innerText()).includes(`Check tripod screws ${tag}`), "6 · its text is in the editor");
    await page.waitForTimeout(1500);
    check(writes.length === 0, `6 · opening it wrote nothing (${writes.map((w) => `${w.method} ${w.path}`).join(", ")})`);
  } finally {
    await browser.close().catch(() => undefined);
    for (const id of made.tasks) await api("DELETE", `/tasks/${id}`).catch(() => undefined);
    for (const id of made.artifacts) await api("DELETE", `/artifacts/${id}`).catch(() => undefined);
    for (const id of made.profiles) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
