// Money, by hand, in a real browser — as a desktop mouse and as a phone with
// touch. Every operation a screen offers on an account, an expense, an income,
// a budget, a bill, a debt and its payments is driven on that screen and then
// held to four things: the stored row (read straight from the database), the
// figures that depend on it (against ../oracle), the OTHER screens that show
// it (reached inside the app, never by a reload), and "a closed form writes
// nothing". Nothing here is weakened to pass: where the app is wrong the check
// stays red and a finding says what was seen.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const RATE_UNIT = "_interestRateUnit"; // the stored marker (CLAUDE.md L3), spelled here on purpose

async function waitRows(ctx: Ctx, table: string, query: string, want: (n: number) => boolean, ms = 12000): Promise<any[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await ctx.db.rows(table, query);
    if (want(rows.length) || Date.now() > until) return rows;
    await sleep(500);
  }
}
/** Poll one row until `ok(row)` or the time is up; answers the last row read. */
async function waitRow(ctx: Ctx, table: string, id: string, ok: (row: any) => boolean, ms = 12000): Promise<any> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await ctx.db.row(table, id);
    if (ok(row) || Date.now() > until) return row;
    await sleep(400);
  }
}
const goto = async (s: any, route: string, pageId: string) => {
  await s.page.evaluate((r: string) => { window.location.hash = `#${r}`; }, route);
  if (pageId) await s.page.waitForSelector(t(pageId), { timeout: 30000 });
  else { await s.page.waitForFunction((r: string) => window.location.hash.startsWith(`#${r}`), route, { timeout: 15000 }); await s.page.waitForSelector("main", { timeout: 30000 }); }
};
const surfaces = (ctx: Ctx) => [ctx.ui!.desktop, ctx.ui!.phone];
const vis = (s: any, sel: string) => s.page.locator(sel).locator("visible=true").first();
const tapIt = (s: any, loc: any, opts: any = {}) => (s.surface === "phone" ? loc.tap(opts) : loc.click(opts));
const seen = (loc: any, ms = 12000) => loc.waitFor({ timeout: ms }).then(() => true).catch(() => false);
const gone = (loc: any, ms = 10000) => loc.waitFor({ state: "hidden", timeout: ms }).then(() => true).catch(() => false);
/** Two presses as fast as a hand can: a double click with the mouse, two taps by touch. */
async function pressTwice(s: any, sel: string) {
  const el = vis(s, sel);
  await el.waitFor({ timeout: 15000 });
  if (s.surface === "phone") { await el.tap().catch(() => undefined); await el.tap({ timeout: 300 }).catch(() => undefined); }
  else await el.dblclick().catch(() => undefined);
}
/** Type into a field the way a person does (select what is there, then type): React sees every change. */
async function typeInto(s: any, sel: string, value: string) {
  const el = vis(s, sel);
  await el.waitFor({ timeout: 15000 });
  await el.fill(value);
}
/** Close whatever dialog is open without saving (Escape; then the dialog's own Close if it is still there). */
async function closeDialog(s: any) {
  await s.page.keyboard.press("Escape");
  await sleep(400);
  const open = s.page.locator('[role="dialog"], [role="alertdialog"]').locator("visible=true").first();
  if (await open.isVisible().catch(() => false)) {
    const x = open.getByRole("button", { name: /^(close|cancel)$/i }).first();
    await tapIt(s, x, { timeout: 3000 }).catch(() => undefined);
    await sleep(400);
  }
}
/** Pick an option of a Radix select (its trigger is a button; the options are portalled). */
async function pickOption(s: any, triggerSel: string, option: RegExp | string) {
  await tapIt(s, vis(s, triggerSel));
  const opt = s.page.getByRole("option", { name: option }).first();
  await opt.waitFor({ timeout: 8000 });
  await tapIt(s, opt);
  await sleep(250);
}
const textOf = async (s: any, sel: string) => ((await vis(s, sel).innerText().catch(() => "")) as string).replace(/\s+/g, " ").trim();
const pageText = async (s: any) => ((await s.page.locator("body").innerText()) as string).replace(/\s+/g, " ");
/** Every dollar figure in a text, as numbers ("$1,204.50" → 1204.5; "-$3" → -3). */
const dollars = (text: string): number[] => [...text.matchAll(/(-|−)?\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)([kKmM])?/g)]
  .map((m) => (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")) * (m[3] ? (/[kK]/.test(m[3]) ? 1e3 : 1e6) : 1));
/** Wait until a screen region shows a dollar figure within `tol` of `want`. */
async function showsAmount(s: any, sel: string, want: number, tol = 0.5, ms = 12000, stale?: number): Promise<{ ok: boolean; text: string }> {
  const until = Date.now() + ms;
  let text = "";
  for (;;) {
    text = await textOf(s, sel);
    const found = dollars(text);
    // `stale`: a figure that must no longer be on show (the value before the change)
    const old = stale !== undefined && Math.abs(stale - want) > tol && found.some((n) => Math.abs(n - stale) <= tol);
    if (found.some((n) => Math.abs(n - want) <= tol) && !old) return { ok: true, text };
    if (Date.now() > until) return { ok: false, text };
    await sleep(400);
  }
}
async function showsText(s: any, text: string, ms = 12000): Promise<boolean> {
  return seen(s.page.getByText(text, { exact: false }).locator("visible=true").first(), ms);
}
async function snapshot(ctx: Ctx) {
  const f = must(await ctx.api("GET", "/dashboard-enhanced"), "dashboard-enhanced").financeSnapshot;
  if (!f || typeof f.totalAssetValue !== "number" || typeof f.totalLiabilities !== "number" || typeof f.totalMonthlySpend !== "number") throw new Error("financeSnapshot has no totals");
  return f;
}
/** Count page loads while a scenario works on a surface: a reload would hide a stale screen. */
function watchReloads(s: any) {
  let n = 0;
  const on = () => { n++; };
  s.page.on("load", on);
  return { count: () => n, stop: () => s.page.off("load", on) };
}
function endSurface(ctx: Ctx, s: any, L: (x: string) => string, reloads: { count: () => number; stop: () => void }, over: string) {
  ctx.check("screen", reloads.count() === 0, L("none of this reloaded the page"), `${reloads.count()} reload(s)`);
  reloads.stop();
  ctx.check("screen", over === "", L("nothing is wider than the screen"), over);
  const problems = s.problems();
  ctx.check("screen", problems.length === 0, L("no script error and no 5xx along the way"), problems.join("; "));
}

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-money.account",
  title: "A financial account by hand (mouse and touch): added once, edited, removed — balance, net worth and every list follow without a reload",
  area: "Browser · money",
  browser: true,
  covers: ["account.create.ui", "account.edit.ui", "account.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const name = `${ctx.tag} ${s.surface} Checking`;
      const balance = ctx.int(1200, 8800) + 0.25;
      const raised = balance + ctx.int(3, 9) * 100;
      const q = `name=eq.${enc(name)}&deleted_at=is.null`;
      const snap0 = await snapshot(ctx);
      await goto(s, "/finance", "page-finance");
      const reloads = watchReloads(s);
      s.problems();

      // a form that is closed writes nothing
      ctx.step(L(`open #/finance, press "Add account", type the name "${name}" and the balance ${balance}, close the dialog without saving`));
      await s.press(t("btn-add-account"));
      await typeInto(s, t("input-account-name"), name);
      await typeInto(s, t("input-account-balance"), String(balance));
      await closeDialog(s);
      await sleep(1200);
      ctx.check("db", (await ctx.db.count("profiles", q)) === 0, L("closing the Add account form stores nothing"));

      // add, with a double press
      ctx.step(L(`press "Add account" again, type the same name and balance, press "Add account" twice quickly`));
      await s.press(t("btn-add-account"));
      await typeInto(s, t("input-account-name"), name);
      await typeInto(s, t("input-account-balance"), String(balance));
      await pressTwice(s, t("btn-save-account"));
      await waitRows(ctx, "profiles", q, (n) => n >= 1);
      await sleep(1500);
      const rows = await ctx.db.rows("profiles", q);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/accounts/${r.id}`));
      ctx.check("action", rows.length >= 1, L("the form added an account"));
      const one = ctx.check("db", rows.length === 1 && rows[0].type === "account" && Math.abs(Number(rows[0].fields?.balance) - balance) < 0.005 && rows[0].fields?.accountKind === "checking",
        L(`one account row (a double press), kind checking, balance ${balance}`), `${rows.length} rows ${JSON.stringify(rows.map((r: any) => [r.type, r.fields?.balance, r.fields?.accountKind]))}`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "A double press of \"Add account\" makes two accounts", detail: `${s.surface}: on #/finance, "Add account", a name and a balance, then "Add account" pressed twice quickly (a double click) stored ${rows.length} identical account rows; assets and net worth counted the balance ${rows.length} times. The button is disabled only once the first request is pending (AddAccountDialog, components/finance/AccountsSection.tsx).` });
      const id = rows[0]?.id;
      if (!id) continue;
      // What follows measures ONE account: a twin from the double press is removed first (it is already reported).
      for (const twin of rows.slice(1)) must(await ctx.api("DELETE", `/accounts/${twin.id}`), "remove the twin");
      if (rows.length > 1) { await goto(s, "/dashboard", "page-dashboard"); await goto(s, "/finance", "page-finance"); }

      // derived: net worth rose by the balance (an account's value IS its balance, Rule 10)
      const snap1 = await snapshot(ctx);
      const want = O.netWorth([{ value: balance }], []);
      ctx.near("derived", O.cents(snap1.totalAssetValue - snap0.totalAssetValue), want.assets, L("assets rose by exactly the balance"));
      ctx.near("derived", O.cents(snap1.totalLiabilities - snap0.totalLiabilities), 0, L("debt did not move"));
      ctx.check("derived", (snap1.assetBreakdown || []).filter((r: any) => r.id === id).length === 1, L("the account is in the asset breakdown once"));

      // this screen, then the others, without a reload
      ctx.check("screen", await seen(vis(s, t(`account-${id}`))), L("Finance lists the new account without a reload"));
      const rowShows = await showsAmount(s, t(`account-${id}`), balance, 0.005);
      ctx.check("screen", rowShows.ok, L(`its row shows the balance ${balance}`), rowShows.text.slice(0, 160));
      await goto(s, "/dashboard", "page-dashboard");
      const dashAssets = await showsAmount(s, t("exec-money-assets"), snap1.totalAssetValue, 1);
      ctx.check("screen", dashAssets.ok && Math.abs(snap1.totalAssetValue - (snap0.totalAssetValue + balance)) < 0.005, L(`the dashboard's Assets figure is the old total plus ${balance} (${O.cents(snap0.totalAssetValue + balance)})`), dashAssets.text);
      await goto(s, "/linked?tab=assets", "page-trackers");
      ctx.check("screen", await showsText(s, name), L("the Assets tab lists the account"));

      // edit: Cancel (close) writes nothing; Save changes the balance and nothing else
      await goto(s, "/finance", "page-finance");
      ctx.step(L(`on #/finance open the account's row, press Edit, type the balance ${raised}, close without saving; then Edit again, type ${raised}, press "Save changes" twice`));
      await tapIt(s, vis(s, `${t(`account-${id}`)} > button`));
      await s.press(t(`acct-edit-${id}`));
      await typeInto(s, t("input-account-balance"), String(raised));
      await closeDialog(s);
      await sleep(1200);
      ctx.near("db", (await ctx.db.row("profiles", id))?.fields?.balance, balance, L("closing the Edit form left the stored balance"));
      await s.press(t(`acct-edit-${id}`));
      await typeInto(s, t("input-account-balance"), String(raised));
      await pressTwice(s, t("btn-update-account"));
      const edited = await waitRow(ctx, "profiles", id, (r) => Math.abs(Number(r?.fields?.balance) - raised) < 0.005);
      ctx.check("db", Math.abs(Number(edited?.fields?.balance) - raised) < 0.005 && edited?.name === name && edited?.fields?.accountKind === "checking" && edited?.type === "account",
        L(`the row now holds ${raised}; name and kind are untouched`), JSON.stringify({ b: edited?.fields?.balance, n: edited?.name, k: edited?.fields?.accountKind }));
      const hist = (edited?.fields?.balanceHistory || []) as any[];
      ctx.check("db", hist.length <= 1, L("a double press of Save wrote the change once (at most one history entry)"), `${hist.length} entries`);
      const snap2 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap2.totalAssetValue - snap1.totalAssetValue), O.cents(raised - balance), L("assets rose by exactly the change in the balance"));
      const rowShows2 = await showsAmount(s, t(`account-${id}`), raised, 0.005);
      ctx.check("screen", rowShows2.ok, L(`the row shows ${raised} without a reload`), rowShows2.text.slice(0, 160));
      await goto(s, "/dashboard", "page-dashboard");
      const dashAssets2 = await showsAmount(s, t("exec-money-assets"), O.cents(snap0.totalAssetValue + raised), 1);
      const ok2 = ctx.check("screen", dashAssets2.ok, L(`the dashboard's Assets figure follows the edit (${O.cents(snap0.totalAssetValue + raised)})`), dashAssets2.text);
      if (!ok2) ctx.finding({ severity: "sync", title: "An account's edited balance does not reach the dashboard's Assets figure", detail: `${s.surface}: stored ${raised}; the Money card read "${dashAssets2.text}" 12 s after in-app navigation` });

      // delete: the first press only asks; Cancel keeps; Remove deletes
      await goto(s, "/finance", "page-finance");
      ctx.step(L(`on #/finance open the row, press Delete, then Cancel; press Delete again, then Remove`));
      if (!(await vis(s, t(`acct-delete-${id}`)).isVisible().catch(() => false))) await tapIt(s, vis(s, `${t(`account-${id}`)} > button`));
      await s.press(t(`acct-delete-${id}`));
      const dialog = s.page.getByRole("alertdialog");
      await dialog.waitFor({ timeout: 8000 });
      const asked = await ctx.db.row("profiles", id);
      const asksFirst = ctx.check("db", !!asked && asked.deleted_at == null, L("pressing Delete only asks: the row is still there (Rule 8)"));
      if (!asksFirst) ctx.finding({ severity: "bug", title: "An account is removed by the first press of Delete", detail: `${s.surface}` });
      await tapIt(s, dialog.getByRole("button", { name: /cancel/i }));
      await sleep(1000);
      const kept = await ctx.db.row("profiles", id);
      ctx.check("db", !!kept && kept.deleted_at == null, L("Cancel leaves the account as it was"));
      await s.press(t(`acct-delete-${id}`));
      await dialog.waitFor({ timeout: 8000 });
      await tapIt(s, dialog.getByRole("button", { name: /^remove$/i }));
      const left = await waitRows(ctx, "profiles", `id=eq.${id}&deleted_at=is.null`, (n) => n === 0);
      ctx.check("db", left.length === 0, L("Remove deletes the row"));
      ctx.check("screen", await gone(vis(s, t(`account-${id}`))), L("it leaves Finance without a reload"));
      const snap3 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap3.totalAssetValue - snap0.totalAssetValue), 0, L("assets are back where they started"));
      await goto(s, "/dashboard", "page-dashboard");
      const dashAssets3 = await showsAmount(s, t("exec-money-assets"), snap0.totalAssetValue, 1, 12000, O.cents(snap0.totalAssetValue + raised));
      ctx.check("screen", dashAssets3.ok, L(`the dashboard's Assets figure is back to ${snap0.totalAssetValue}`), dashAssets3.text);
      await goto(s, "/finance", "page-finance");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});


// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-money.expense",
  title: "An expense edited and deleted by hand (mouse and touch): the row, the month's spending and its budget follow, without a reload",
  area: "Browser · money",
  browser: true,
  covers: ["expense.edit.ui", "expense.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const month = ctx.today.slice(0, 7);
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const category = s.surface === "phone" ? "pet" : "education";
      const amount = ctx.int(20, 90) + 0.4;
      const newAmount = O.cents(amount + ctx.int(5, 30) + 0.15);
      const limit = 500;
      const desc = `${ctx.tag} ${s.surface} textbook`;
      const newDesc = `${desc} (2nd ed.)`;
      // set-up through the API: one expense and a budget in its category (the screen work is the edit and the delete)
      const b = must(await ctx.api("POST", "/budgets", { month, category, amount: limit }), "budget");
      const budId = b.id ?? b.budget?.id;
      ctx.cleanup(() => ctx.api("DELETE", `/budgets/${budId}?month=${month}`));
      const snap0 = await snapshot(ctx);
      const e = must(await ctx.api("POST", "/expenses", { description: desc, amount, category, date: ctx.today }), "expense");
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      const row0 = await ctx.db.row("expenses", e.id);
      const spentBefore = O.cents(snap0.spendByCategory?.[category] ?? 0);

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/finance", "page-finance");
      const reloads = watchReloads(s);
      s.problems();
      const rowSel = t(`expense-${e.id}`);
      ctx.check("screen", await seen(vis(s, rowSel), 15000), L("Finance lists the expense made elsewhere (in-app navigation)"));

      // Edit, then Cancel: nothing is written
      ctx.step(L(`on #/finance open the expense "${desc}", press Edit, type the amount ${newAmount}, press Cancel`));
      await tapIt(s, vis(s, `${rowSel} [role="button"]`));
      await s.press(t(`btn-edit-expense-${e.id}`));
      await typeInto(s, t("input-edit-expense-amount"), String(newAmount));
      await tapIt(s, s.page.getByRole("dialog").getByRole("button", { name: /^cancel$/i }));
      await sleep(1200);
      const afterCancel = await ctx.db.row("expenses", e.id);
      ctx.check("db", Number(afterCancel?.amount) === amount && afterCancel?.updated_at === row0?.updated_at, L("Cancel on the Edit form writes nothing (same amount, same updated_at)"), JSON.stringify({ a: afterCancel?.amount, u: afterCancel?.updated_at, was: row0?.updated_at }));

      // Edit, Save twice quickly
      ctx.step(L(`press Edit again, change the description to "${newDesc}" and the amount to ${newAmount}, press Save twice quickly`));
      if (!(await vis(s, t(`btn-edit-expense-${e.id}`)).isVisible().catch(() => false))) await tapIt(s, vis(s, `${rowSel} [role="button"]`));
      await s.press(t(`btn-edit-expense-${e.id}`));
      const dlg = s.page.getByRole("dialog");
      await dlg.locator("input").first().fill(newDesc);
      await typeInto(s, t("input-edit-expense-amount"), String(newAmount));
      await pressTwice(s, t("btn-save-edit-expense"));
      const edited = await waitRow(ctx, "expenses", e.id, (r) => Math.abs(Number(r?.amount) - newAmount) < 0.005);
      ctx.check("action", Math.abs(Number(edited?.amount) - newAmount) < 0.005, L("the Edit form saved"));
      ctx.check("db", Math.abs(Number(edited?.amount) - newAmount) < 0.005 && edited?.description === newDesc && edited?.category === category && edited?.date === ctx.today && edited?.deleted_at == null,
        L(`the row holds ${newAmount} and the new description; category and day are untouched`), JSON.stringify({ a: edited?.amount, d: edited?.description, c: edited?.category, day: edited?.date }));
      ctx.check("db", (await ctx.db.count("expenses", `description=ilike.${enc(`${ctx.tag} ${s.surface}*`)}&deleted_at=is.null`)) === 1, L("still one expense row (a double press of Save)"));
      // derived
      const snap1 = await snapshot(ctx);
      const wantSpent = O.spentIn([{ amount: newAmount, category, date: ctx.today }], month, category);
      ctx.near("derived", O.cents((snap1.spendByCategory?.[category] ?? 0) - spentBefore), wantSpent, L(`this month's ${category} spending rose by the edited amount`));
      ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), newAmount, L("this month's total spending rose by the edited amount, not the old one"));
      const boot1 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      ctx.near("derived", O.cents(boot1.remaining), O.cents(boot1.totalBudget - snap1.totalMonthlySpend), L("budget remaining = budget − this month's spending"));
      // screens
      const rowShows = await showsAmount(s, rowSel, newAmount, 0.005);
      ctx.check("screen", rowShows.ok && rowShows.text.includes(newDesc), L("the row shows the new description and amount without a reload"), rowShows.text.slice(0, 160));
      const kpi = await showsAmount(s, t("money-spend"), snap1.totalMonthlySpend, 1);
      const okKpi = ctx.check("screen", kpi.ok && Math.abs(snap1.totalMonthlySpend - (snap0.totalMonthlySpend + newAmount)) < 0.005, L(`Finance's Spend tile shows this month's total (${O.cents(snap0.totalMonthlySpend + newAmount)})`), kpi.text.slice(0, 120));
      if (!okKpi) ctx.finding({ severity: "sync", title: "Finance's Spend tile does not follow an edited expense", detail: `${s.surface}: stored ${newAmount}; the tile read "${kpi.text.slice(0, 100)}" 12 s after the save` });
      const bud = await showsAmount(s, t(`money-budget-${category}`), O.cents(spentBefore + newAmount), 1);
      const okBud = ctx.check("screen", bud.ok, L(`the ${category} budget shows ${O.cents(spentBefore + newAmount)} spent`), bud.text.slice(0, 120));
      if (!okBud) ctx.finding({ severity: "sync", title: "A budget's spent figure does not follow an edited expense", detail: `${s.surface}: the ${category} budget read "${bud.text.slice(0, 100)}" 12 s after the expense was saved as ${newAmount}` });
      await goto(s, "/dashboard", "page-dashboard");
      const dash = await showsAmount(s, t("exec-money-month"), snap1.totalMonthlySpend + (snap1.unpaidBillsThisMonth ?? 0), 1);
      ctx.check("screen", dash.ok, L("the dashboard's Expenses figure for the month follows (in-app navigation)"), dash.text);

      // Delete: asks first; Cancel keeps; Delete removes
      await goto(s, "/finance", "page-finance");
      ctx.step(L("back on #/finance open the row, press Delete, then Cancel; press Delete again and confirm"));
      await seen(vis(s, rowSel), 15000);
      if (!(await vis(s, t(`btn-delete-expense-${e.id}`)).isVisible().catch(() => false))) await tapIt(s, vis(s, `${rowSel} [role="button"]`));
      await s.press(t(`btn-delete-expense-${e.id}`));
      const ask = s.page.getByRole("alertdialog");
      await ask.waitFor({ timeout: 8000 });
      const asked = await ctx.db.row("expenses", e.id);
      const asksFirst = ctx.check("db", !!asked && asked.deleted_at == null, L("pressing Delete only asks: the row is still there (Rule 8)"));
      if (!asksFirst) ctx.finding({ severity: "bug", title: "An expense is deleted by the first press of Delete", detail: s.surface });
      await tapIt(s, ask.getByRole("button", { name: /cancel/i }));
      await sleep(1000);
      const kept = await ctx.db.row("expenses", e.id);
      ctx.check("db", !!kept && kept.deleted_at == null && Math.abs(Number(kept.amount) - newAmount) < 0.005, L("Cancel leaves the expense as it was"));
      ctx.check("screen", await vis(s, rowSel).isVisible().catch(() => false), L("and it is still listed"));
      await s.press(t(`btn-delete-expense-${e.id}`));
      await ask.waitFor({ timeout: 8000 });
      await tapIt(s, ask.getByRole("button", { name: /^delete$/i }));
      const live = await waitRows(ctx, "expenses", `id=eq.${e.id}&deleted_at=is.null`, (n) => n === 0);
      ctx.check("db", live.length === 0, L("confirming deletes the row (to Trash)"));
      ctx.check("screen", await gone(vis(s, rowSel)), L("it leaves the list without a reload"));
      const snap2 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap2.totalMonthlySpend - snap0.totalMonthlySpend), 0, L("this month's spending is back where it started"));
      ctx.near("derived", O.cents((snap2.spendByCategory?.[category] ?? 0) - spentBefore), 0, L(`and so is ${category} spending`));
      const kpi2 = await showsAmount(s, t("money-spend"), snap0.totalMonthlySpend, 1, 12000, O.cents(snap0.totalMonthlySpend + newAmount));
      const okKpi2 = ctx.check("screen", kpi2.ok, L(`Finance's Spend tile is back to ${snap0.totalMonthlySpend}`), kpi2.text.slice(0, 120));
      if (!okKpi2) ctx.finding({ severity: "sync", title: "Finance's Spend tile keeps a deleted expense", detail: `${s.surface}: the tile read "${kpi2.text.slice(0, 100)}" 12 s after the delete` });
      const bud2 = await showsAmount(s, t(`money-budget-${category}`), spentBefore, 1, 12000, O.cents(spentBefore + newAmount));
      ctx.check("screen", bud2.ok, L(`the ${category} budget is back to ${spentBefore} spent`), bud2.text.slice(0, 120));
      must(await ctx.api("DELETE", `/budgets/${budId}?month=${month}`), "remove the budget");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-money.income",
  title: "Income by hand (mouse and touch): a source added once, edited and deleted; a paycheck marked received — this month's income follows without a reload",
  area: "Browser · money",
  browser: true,
  covers: ["income.create.ui", "income.edit.ui", "income.delete.ui", "income.complete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const desc = `${ctx.tag} ${s.surface} tutoring`;
      const amount = ctx.int(300, 900) + 0.5;
      const newAmount = O.cents(amount + ctx.int(20, 80));
      const payName = `${ctx.tag} ${s.surface} employer`;
      const payAmount = ctx.int(1100, 1900) + 0.75; // never the income's amount: a received paycheck COVERS an equal income of the same day
      const q = `description=eq.${enc(desc)}&deleted_at=is.null`;
      const snap0 = await snapshot(ctx);
      await goto(s, "/finance", "page-finance");
      const reloads = watchReloads(s);
      s.problems();
      const openMore = async () => {
        if (!(await vis(s, t("button-add-income")).isVisible().catch(() => false))) await s.press(t("finance-toggle-more"));
        await vis(s, t("button-add-income")).waitFor({ timeout: 10000 });
      };
      await openMore();

      // closed form writes nothing
      ctx.step(L(`on #/finance open "More", press "Add Income", type "${desc}" and ${amount}, close the dialog`));
      await s.press(t("button-add-income"));
      await typeInto(s, t("input-income-description"), desc);
      await typeInto(s, t("input-income-amount"), String(amount));
      await closeDialog(s);
      await sleep(1200);
      ctx.check("db", (await ctx.db.count("incomes", q)) === 0, L("closing the Add Income form stores nothing"));

      // add (monthly, dated today by default), double press
      ctx.step(L(`press "Add Income" again, type the same, press "Add Income" twice quickly`));
      await s.press(t("button-add-income"));
      await typeInto(s, t("input-income-description"), desc);
      await typeInto(s, t("input-income-amount"), String(amount));
      await pressTwice(s, t("button-save-income"));
      await waitRows(ctx, "incomes", q, (n) => n >= 1);
      await sleep(1500);
      let rows = await ctx.db.rows("incomes", q);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/incomes/${r.id}`));
      ctx.check("action", rows.length >= 1, L("the form added an income"));
      const one = ctx.check("db", rows.length === 1 && Math.abs(Number(rows[0].amount) - amount) < 0.005 && rows[0].frequency === "monthly" && rows[0].date === ctx.today,
        L(`one income row (a double press): ${amount}, monthly, from today`), `${rows.length} rows ${JSON.stringify(rows.map((r: any) => [r.amount, r.frequency, r.date]))}`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "A double press of \"Add Income\" makes two incomes", detail: `${rows.length} rows on ${s.surface}` });
      const id = rows[0]?.id;
      if (!id) continue;
      for (const twin of rows.slice(1)) must(await ctx.api("DELETE", `/incomes/${twin.id}`), "remove the twin");
      // derived: an income that starts today counts once in this month's income to date
      const snap1 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap1.monthlyIncome - snap0.monthlyIncome), amount, L("this month's income rose by the amount"));
      const rowSel = t(`income-${id}`);
      ctx.check("screen", await seen(vis(s, rowSel)), L("the Income list shows it without a reload"));
      const tile = await showsAmount(s, t("money-income"), O.cents(snap0.monthlyIncome + amount), 1);
      const okTile = ctx.check("screen", tile.ok, L(`Finance's Income tile shows ${O.cents(snap0.monthlyIncome + amount)}`), tile.text.slice(0, 120));
      if (!okTile) ctx.finding({ severity: "sync", title: "Finance's Income tile does not follow a new income", detail: `${s.surface}: read "${tile.text.slice(0, 100)}" 12 s after the save` });
      await goto(s, "/dashboard", "page-dashboard");
      const dash = await showsAmount(s, t("exec-money-month"), O.cents(snap0.monthlyIncome + amount), 1);
      const okDash = ctx.check("screen", dash.ok, L(`the dashboard's Income figure for the month is ${O.cents(snap0.monthlyIncome + amount)} (in-app navigation)`), dash.text);
      if (!okDash) ctx.finding({ severity: "sync", title: "The dashboard's month Income does not follow an income added on Finance", detail: `${s.surface}: read "${dash.text}"` });

      // edit: close writes nothing; save changes the amount only
      await goto(s, "/finance", "page-finance");
      await openMore();
      ctx.step(L(`open the income's row, press Edit, type ${newAmount}, close; Edit again, type ${newAmount}, press "Save Changes" twice`));
      await tapIt(s, vis(s, `${rowSel} [role="button"]`));
      await s.press(t(`btn-edit-income-${id}`));
      await typeInto(s, t("input-edit-income-amount"), String(newAmount));
      await closeDialog(s);
      await sleep(1200);
      ctx.near("db", (await ctx.db.row("incomes", id))?.amount, amount, L("closing the Edit form left the stored amount"));
      if (!(await vis(s, t(`btn-edit-income-${id}`)).isVisible().catch(() => false))) await tapIt(s, vis(s, `${rowSel} [role="button"]`));
      await s.press(t(`btn-edit-income-${id}`));
      await typeInto(s, t("input-edit-income-amount"), String(newAmount));
      await pressTwice(s, t("button-save-edit-income"));
      const edited = await waitRow(ctx, "incomes", id, (r) => Math.abs(Number(r?.amount) - newAmount) < 0.005);
      ctx.check("db", Math.abs(Number(edited?.amount) - newAmount) < 0.005 && edited?.description === desc && edited?.frequency === "monthly" && edited?.date === ctx.today && edited?.category === rows[0].category,
        L(`the row holds ${newAmount}; description, frequency, category and day are untouched`), JSON.stringify({ a: edited?.amount, d: edited?.description, f: edited?.frequency, day: edited?.date, c: edited?.category }));
      rows = await ctx.db.rows("incomes", q);
      ctx.check("db", rows.length === 1, L("still one income row"), `${rows.length}`);
      const snap2 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap2.monthlyIncome - snap0.monthlyIncome), newAmount, L("this month's income follows the edit"));
      const rowShows = await showsAmount(s, rowSel, newAmount, 0.005);
      ctx.check("screen", rowShows.ok, L("the row shows the new amount without a reload"), rowShows.text.slice(0, 140));

      // a paycheck expected today, marked received (income.complete)
      ctx.step(L(`press "Add Paycheck", type "${payName}", ${payAmount}, expected today; open its row and press "Mark received" twice quickly`));
      await s.press(t("button-add-paycheck"));
      await typeInto(s, t("input-paycheck-source"), payName);
      await typeInto(s, t("input-paycheck-amount"), String(payAmount));
      await vis(s, t("input-paycheck-date")).fill(ctx.today);
      await s.press(t("button-save-paycheck"));
      const pq = `source=eq.${enc(payName)}`;
      const pcs = await waitRows(ctx, "paychecks", pq, (n) => n >= 1);
      for (const p of pcs) ctx.cleanup(() => ctx.api("DELETE", `/paychecks/${p.id}`));
      ctx.check("db", pcs.length === 1 && pcs[0].confirmed === false && Number(pcs[0].amount) === payAmount && pcs[0].expected_date === ctx.today, L("one paycheck row, expected today, not yet received"), JSON.stringify(pcs.map((p: any) => [p.amount, p.expected_date, p.confirmed])));
      const pid = pcs[0]?.id;
      if (pid) {
        const beforeReceive = await snapshot(ctx);
        ctx.near("derived", O.cents(beforeReceive.monthlyIncome - snap2.monthlyIncome), 0, L("an expected paycheck is not income until it is received"));
        const pSel = t(`paycheck-${pid}`);
        await seen(vis(s, pSel), 15000);
        await tapIt(s, vis(s, `${pSel} [role="button"]`));
        const mark = s.page.locator(pSel).getByRole("button", { name: /mark received/i }).first();
        await mark.waitFor({ timeout: 10000 });
        if (s.surface === "phone") { await mark.tap().catch(() => undefined); await mark.tap({ timeout: 300 }).catch(() => undefined); } else await mark.dblclick().catch(() => undefined);
        const got = await waitRow(ctx, "paychecks", pid, (r) => r?.confirmed === true);
        ctx.check("db", got?.confirmed === true && got?.received_date === ctx.today && Number(got?.actual_amount ?? got?.amount) === payAmount, L("the paycheck is stored as received today, for its amount"), JSON.stringify({ c: got?.confirmed, r: got?.received_date, a: got?.actual_amount }));
        ctx.check("db", (await ctx.db.count("paychecks", pq)) === 1, L("still one paycheck row (a double press)"));
        const snap3 = await snapshot(ctx);
        ctx.near("derived", O.cents(snap3.monthlyIncome - snap2.monthlyIncome), payAmount, L("this month's income rose by the received paycheck"));
        ctx.near("derived", O.cents(snap3.receivedPaycheckIncome - snap2.receivedPaycheckIncome), payAmount, L("received paychecks rose by it"));
        ctx.check("screen", await seen(s.page.locator(pSel).getByText(/received/i).first(), 10000), L("its row reads Received without a reload"));
        const tile3 = await showsAmount(s, t("money-income"), O.cents(snap0.monthlyIncome + newAmount + payAmount), 1);
        const okTile3 = ctx.check("screen", tile3.ok, L(`Finance's Income tile shows ${O.cents(snap0.monthlyIncome + newAmount + payAmount)}`), tile3.text.slice(0, 120));
        if (!okTile3) ctx.finding({ severity: "sync", title: "Finance's Income tile does not follow a paycheck marked received", detail: `${s.surface}: read "${tile3.text.slice(0, 100)}"` });
        must(await ctx.api("DELETE", `/paychecks/${pid}`), "remove the paycheck");
      }

      // delete the income: asks first; Cancel keeps; Delete removes
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/finance", "page-finance");
      await openMore();
      ctx.step(L("open the income's row, press Delete, then Cancel; press Delete again and confirm"));
      await seen(vis(s, rowSel), 15000);
      if (!(await vis(s, t(`btn-delete-income-${id}`)).isVisible().catch(() => false))) await tapIt(s, vis(s, `${rowSel} [role="button"]`));
      await s.press(t(`btn-delete-income-${id}`));
      const ask = s.page.getByRole("alertdialog");
      await ask.waitFor({ timeout: 8000 });
      const asked = await ctx.db.row("incomes", id);
      ctx.check("db", !!asked && asked.deleted_at == null, L("pressing Delete only asks: the row is still there (Rule 8)"));
      await tapIt(s, ask.getByRole("button", { name: /cancel/i }));
      await sleep(1000);
      const kept = await ctx.db.row("incomes", id);
      ctx.check("db", !!kept && kept.deleted_at == null, L("Cancel leaves the income as it was"));
      await s.press(t(`btn-delete-income-${id}`));
      await ask.waitFor({ timeout: 8000 });
      await s.press(t("btn-confirm-delete-income"));
      const live = await waitRows(ctx, "incomes", `id=eq.${id}&deleted_at=is.null`, (n) => n === 0);
      ctx.check("db", live.length === 0, L("confirming deletes the row"));
      ctx.check("screen", await gone(vis(s, rowSel)), L("it leaves the list without a reload"));
      const snap4 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap4.monthlyIncome - snap0.monthlyIncome), 0, L("this month's income is back where it started"));
      const tile4 = await showsAmount(s, t("money-income"), snap0.monthlyIncome, 1, 12000, O.cents(snap0.monthlyIncome + newAmount));
      ctx.check("screen", tile4.ok, L(`Finance's Income tile is back to ${snap0.monthlyIncome}`), tile4.text.slice(0, 120));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});


// ─────────────────────────────────────────────────────────────────────────────
/** The stored budget list of a month (preferences row `budget:<month>`), read from the database. */
async function storedBudgets(ctx: Ctx, month: string): Promise<any[]> {
  const rows = await ctx.db.rows("preferences", `key=eq.${enc(`budget:${month}`)}`);
  if (rows.length > 1) throw new Error(`${rows.length} preference rows for budget:${month}`);
  if (!rows[0]) return [];
  const list = JSON.parse(rows[0].value || "[]");
  if (!Array.isArray(list)) throw new Error("the stored budget value is not a list");
  return list;
}
async function waitBudgets(ctx: Ctx, month: string, ok: (list: any[]) => boolean, ms = 12000): Promise<any[]> {
  const until = Date.now() + ms;
  for (;;) {
    const list = await storedBudgets(ctx, month);
    if (ok(list) || Date.now() > until) return list;
    await sleep(400);
  }
}

scenario({
  id: "ui-money.budget",
  title: "A budget by hand (mouse and touch): added once, its limit changed, removed — total, spent and remaining follow without a reload",
  area: "Browser · money",
  browser: true,
  covers: ["budget.create.ui", "budget.edit.ui", "budget.delete.ui", "budget.duplicate.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const month = ctx.today.slice(0, 7);
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const category = s.surface === "phone" ? "travel" : "shopping";
      const seedCategory = s.surface === "phone" ? "personal" : "housing";
      const limit = ctx.int(12, 40) * 10;
      const newLimit = limit + ctx.int(2, 9) * 5;
      const spend = ctx.int(15, 70) + 0.35;
      await goto(s, "/finance", "page-finance");
      const reloads = watchReloads(s);
      s.problems();

      const catInput = () => s.page.getByPlaceholder(/category/i).locator("visible=true").first();
      const amtInput = () => s.page.getByPlaceholder(/\$ amount/i).locator("visible=true").first();

      // ── the FIRST budget (the owner asked for this to be verified) ──────────
      // The month is emptied first; what was there is put back afterwards.
      for (const b of await storedBudgets(ctx, month)) {
        must(await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`), "clear the month");
        ctx.cleanup(() => ctx.api("POST", "/budgets", { month, category: b.category, amount: b.amount, ...(b.notes ? { notes: b.notes } : {}), ...(b.profileId ? { profileId: b.profileId } : {}) }));
      }
      ctx.check("db", (await storedBudgets(ctx, month)).length === 0, L("the month starts with no budget"));
      const firstLimit = 150;
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/finance", "page-finance");
      const emptyShown = await seen(vis(s, t("money-budgets-empty")), 15000);
      ctx.check("screen", emptyShown, L("with no budget, Finance's Budgets card says there is none for the month (not a missing card)"));
      const offered = await vis(s, t("money-manage-budgets")).isVisible().catch(() => false);
      const first = ctx.check("screen", offered, L("with no budget yet, Finance offers a way to add the first one"), "no \"+ Budget\" control on #/finance");
      if (!first) ctx.finding({ severity: "gap", title: "No screen offers a way to add the FIRST budget", detail: `${s.surface}: on #/finance the Budgets card (and its "+ Budget" button, components/finance/MoneyOverview.tsx) is drawn only when a budget already exists.` });
      let seedId: string | undefined;
      if (offered) {
        ctx.step(L(`on #/finance press "+ Budget", then "Add first category", type "${seedCategory}" and ${firstLimit}, press Add twice quickly`));
        await s.press(t("money-manage-budgets"));
        const addFirst = vis(s, t("budget-add-first"));
        ctx.check("screen", await seen(addFirst, 10000), L("the popup, with nothing set, offers \"Add first category\""));
        ctx.check("db", (await storedBudgets(ctx, month)).length === 0, L("opening the budget popup writes nothing (Rule 3)"));
        await tapIt(s, addFirst);
        await catInput().fill(seedCategory);
        await amtInput().fill(String(firstLimit));
        await pressTwice(s, t("budget-add-submit"));
        await waitBudgets(ctx, month, (l) => l.some((b: any) => b.category === seedCategory));
        await sleep(1500);
        const firstList = await storedBudgets(ctx, month);
        for (const b of firstList) ctx.cleanup(() => ctx.api("DELETE", `/budgets/${b.id}?month=${month}`));
        ctx.check("action", firstList.some((b: any) => b.category === seedCategory), L("the popup added the first budget"));
        ctx.check("db", firstList.length === 1 && firstList[0].category === seedCategory && Number(firstList[0].amount) === firstLimit,
          L(`the month's stored list is exactly one ${seedCategory} budget of ${firstLimit} (a double press made one)`), JSON.stringify(firstList.map((b: any) => [b.category, b.amount])));
        seedId = firstList.find((b: any) => b.category === seedCategory)?.id;
        const bootF = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
        const snapF = await snapshot(ctx);
        ctx.near("derived", bootF.totalBudget, firstLimit, L("the month's budget total is the first limit"));
        ctx.near("derived", bootF.remaining, O.cents(firstLimit - snapF.totalMonthlySpend), L("remaining = the first limit − this month's spending"));
        if (seedId) {
          const row = await showsAmount(s, t(`budget-row-${seedId}`), firstLimit, 0.5);
          ctx.check("screen", row.ok, L(`the popup lists ${seedCategory} at ${firstLimit} without a reload`), row.text.slice(0, 140));
        }
        await closeDialog(s);
        const cardF = await showsAmount(s, t(`money-budget-${seedCategory}`), firstLimit, 0.5);
        ctx.check("screen", cardF.ok, L(`Finance's Budgets card shows ${seedCategory} of ${firstLimit} without a reload`), cardF.text.slice(0, 140));
        ctx.check("screen", await gone(vis(s, t("money-budgets-empty"))), L("and no longer says there is no budget"));
      }
      if (!seedId) {
        // one budget made elsewhere, so the rest of the scenario has the card
        const seed = must(await ctx.api("POST", "/budgets", { month, category: seedCategory, amount: firstLimit }), "seed budget");
        seedId = seed.id ?? seed.budget?.id;
        ctx.cleanup(() => ctx.api("DELETE", `/budgets/${seedId}?month=${month}`));
      }
      const e = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} ${s.surface} ${category}`, amount: spend, category, date: ctx.today }), "expense");
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      const boot0 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      const snap0 = await snapshot(ctx);
      const spent = O.spentIn([{ amount: spend, category, date: ctx.today }], month, category);
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/finance", "page-finance");
      const cardThere = await seen(vis(s, t("money-manage-budgets")), 15000);
      ctx.check("screen", cardThere, L("Finance's Budgets card is there with the budget (in-app navigation)"));
      if (!cardThere) continue;
      const openPopup = async () => {
        if (await vis(s, t("popup-budget")).isVisible().catch(() => false)) return;
        await s.press(t("money-manage-budgets"));
        await vis(s, t("budget-show-add")).waitFor({ timeout: 10000 });
      };
      // the add row, cancelled: nothing stored
      ctx.step(L(`on #/finance press "+ Budget", "Add category", type "${category}" and ${limit}, press Cancel`));
      await openPopup();
      await s.press(t("budget-show-add"));
      await catInput().fill(category);
      await amtInput().fill(String(limit));
      await tapIt(s, s.page.getByRole("dialog").getByRole("button", { name: /^cancel$/i }).first());
      await sleep(1200);
      ctx.check("db", !(await storedBudgets(ctx, month)).some((b: any) => b.category === category), L("Cancel on the add row stores nothing"));

      // a failed request: nothing stored, and the popup does not keep the row as saved
      ctx.step(L(`with the next POST /api/budgets made to fail, press "Add category", type "${category}" and ${limit}, press Add once`));
      let failedOnce = false;
      await s.page.route("**/api/budgets", async (route: any) => {
        if (!failedOnce && route.request().method() === "POST") { failedOnce = true; return route.abort("failed"); }
        return route.continue();
      });
      await s.press(t("budget-show-add"));
      await catInput().fill(category);
      await amtInput().fill(String(limit));
      await s.press(t("budget-add-submit"));
      await sleep(2500);
      await s.page.unroute("**/api/budgets");
      ctx.check("action", failedOnce, L("the add request was the one that failed"));
      ctx.check("db", !(await storedBudgets(ctx, month)).some((b: any) => b.category === category), L("a failed add stores nothing"));
      const ghost = await s.page.locator('[data-testid^="budget-row-"]').filter({ hasText: new RegExp(`^\\s*${category}`, "i") }).locator("visible=true").count();
      ctx.check("screen", ghost === 0, L("and the popup does not list it as if it were saved"), `${ghost} row(s) for ${category}`);
      const failToast = await showsText(s, "Couldn't add", 4000);
      ctx.check("screen", failToast, L("the popup says the add failed"));
      await openPopup();

      // add, double press
      ctx.step(L(`press "Add category" again, type "${category}" and ${limit}, press Add twice quickly`));
      await s.press(t("budget-show-add"));
      await catInput().fill(category);
      await amtInput().fill(String(limit));
      await pressTwice(s, t("budget-add-submit"));
      let list = await waitBudgets(ctx, month, (l) => l.some((b: any) => b.category === category));
      await sleep(1500);
      list = await storedBudgets(ctx, month);
      const mine = list.filter((b: any) => b.category === category);
      for (const b of mine) ctx.cleanup(() => ctx.api("DELETE", `/budgets/${b.id}?month=${month}`));
      ctx.check("action", mine.length >= 1, L("the popup added a budget"));
      ctx.check("db", mine.length === 1 && Number(mine[0].amount) === limit && list.length === 2, L(`the month's stored list holds one ${category} budget of ${limit} beside the other (a double press)`), JSON.stringify(list.map((b: any) => [b.category, b.amount])));
      const id = mine[0]?.id;
      if (!id) continue;
      // derived
      const boot1 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      ctx.near("derived", O.cents(boot1.totalBudget - boot0.totalBudget), limit, L("the budget total rose by the new limit"));
      ctx.near("derived", O.cents(boot1.remaining), O.cents(boot0.totalBudget + limit - snap0.totalMonthlySpend), L("remaining = budgets − this month's spending"));
      // screens: the popup row, then the Finance card behind it
      const rowSel = t(`budget-row-${id}`);
      const inPopup = await showsAmount(s, rowSel, limit, 0.5);
      ctx.check("screen", inPopup.ok && dollars(inPopup.text).some((n) => Math.abs(n - spent) <= 0.5), L(`the popup lists it: ${spent} spent of ${limit}`), inPopup.text.slice(0, 140));
      await closeDialog(s);
      const card = await showsAmount(s, t(`money-budget-${category}`), limit, 0.5);
      const okCard = ctx.check("screen", card.ok && dollars(card.text).some((n) => Math.abs(n - spent) <= 1), L(`Finance's Budgets card shows ${category}: ${spent} of ${limit}, without a reload`), card.text.slice(0, 140));
      if (!okCard) ctx.finding({ severity: "sync", title: "A budget added in the popup does not reach Finance's Budgets card", detail: `${s.surface}: stored ${category} ${limit}; the card read "${card.text.slice(0, 100)}" 12 s after the popup was closed` });

      // edit: Cancel keeps; Save changes the limit
      ctx.step(L(`open the popup, press the pencil on ${category}, type ${newLimit}, press Cancel; pencil again, type ${newLimit}, press Save twice`));
      await openPopup();
      await s.press(t(`budget-edit-${id}`));
      await vis(s, `${rowSel} input[type="number"]`).fill(String(newLimit));
      await tapIt(s, s.page.locator(rowSel).getByRole("button", { name: /^cancel$/i }));
      await sleep(1200);
      ctx.near("db", (await storedBudgets(ctx, month)).find((b: any) => b.id === id)?.amount, limit, L("Cancel on the edit row left the stored limit"));
      await s.press(t(`budget-edit-${id}`));
      await vis(s, `${rowSel} input[type="number"]`).fill(String(newLimit));
      const save = s.page.locator(rowSel).getByRole("button", { name: /^save$/i });
      if (s.surface === "phone") { await save.tap().catch(() => undefined); await save.tap({ timeout: 300 }).catch(() => undefined); } else await save.dblclick().catch(() => undefined);
      list = await waitBudgets(ctx, month, (l) => Number(l.find((b: any) => b.id === id)?.amount) === newLimit);
      const after = list.find((b: any) => b.id === id);
      ctx.check("db", Number(after?.amount) === newLimit && after?.category === category && list.length === 2 && Number(list.find((b: any) => b.id === seedId)?.amount) === firstLimit,
        L(`the stored limit is ${newLimit}; the category and the other budget are untouched`), JSON.stringify(list.map((b: any) => [b.category, b.amount])));
      const boot2 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      ctx.near("derived", O.cents(boot2.totalBudget - boot0.totalBudget), newLimit, L("the budget total follows the edit"));
      ctx.near("derived", O.cents(boot2.remaining - boot1.remaining), O.cents(newLimit - limit), L("remaining rose by the change in the limit"));
      const inPopup2 = await showsAmount(s, rowSel, newLimit, 0.5, 12000, limit);
      ctx.check("screen", inPopup2.ok, L(`the popup row shows the new limit ${newLimit}`), inPopup2.text.slice(0, 140));
      await closeDialog(s);
      const card2 = await showsAmount(s, t(`money-budget-${category}`), newLimit, 0.5, 12000, limit);
      const okCard2 = ctx.check("screen", card2.ok, L(`Finance's Budgets card shows the new limit ${newLimit} without a reload`), card2.text.slice(0, 140));
      if (!okCard2) ctx.finding({ severity: "sync", title: "A budget's edited limit does not reach Finance's Budgets card", detail: `${s.surface}: stored ${newLimit}; the card read "${card2.text.slice(0, 100)}"` });

      // delete: a destructive button takes two taps (Rule 8)
      ctx.step(L(`open the popup and press the trash icon on ${category} once`));
      await openPopup();
      await s.press(t(`budget-delete-${id}`));
      await sleep(2500);
      const afterOne = (await storedBudgets(ctx, month)).find((b: any) => b.id === id);
      const twoTaps = ctx.check("db", !!afterOne, L("one press of the trash icon does not delete the budget: it asks or arms first (Rule 8)"), "the budget was removed by the first press, with no confirmation");
      if (!twoTaps) ctx.finding({ severity: "bug", title: "A budget is deleted by a single press of its trash icon", detail: `${s.surface}: #/finance → "+ Budget" → the trash icon beside a category deletes it at once — no second tap, no confirmation, no undo (BudgetPopup, components/dashboard/HeroKPIPopups.tsx: onClick={() => deleteMut.mutate(b.id)}). CLAUDE.md Rule 8: destructive buttons take two taps (useConfirmArm).` });
      if (afterOne) {
        // the second press (or the confirmation) removes it
        const confirm = s.page.getByRole("alertdialog").getByRole("button", { name: /delete|remove/i }).first();
        if (await confirm.isVisible().catch(() => false)) await tapIt(s, confirm);
        else await s.press(t(`budget-delete-${id}`));
      }
      list = await waitBudgets(ctx, month, (l) => !l.some((b: any) => b.id === id));
      ctx.check("db", !list.some((b: any) => b.id === id) && list.length === 1 && list[0].id === seedId, L("the budget is gone from the stored list; the other one stays"), JSON.stringify(list.map((b: any) => [b.category, b.amount])));
      const boot3 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      ctx.near("derived", O.cents(boot3.totalBudget - boot0.totalBudget), 0, L("the budget total is back where it started"));
      ctx.check("screen", await gone(vis(s, rowSel)), L("it leaves the popup"));
      await closeDialog(s);
      const cardGone = await gone(vis(s, t(`money-budget-${category}`)));
      const okGone = ctx.check("screen", cardGone, L("and Finance's Budgets card, without a reload"));
      if (!okGone) ctx.finding({ severity: "sync", title: "A deleted budget stays on Finance's Budgets card", detail: `${s.surface}: ${category} was still drawn 10 s after it was removed in the popup` });
      const spendRow = await ctx.db.row("expenses", e.id);
      ctx.check("db", !!spendRow && spendRow.deleted_at == null, L("deleting a budget keeps the spending it measured"));

      // duplicate: "Copy last month" adds what this month lacks, keeps what it has
      const prev = O.addMonthsAnchored(`${month}-01`, -1).slice(0, 7);
      const copyCat = s.surface === "phone" ? "gifts" : "entertainment";
      const copyLimit = ctx.int(4, 30) * 10;
      const prevBefore = await storedBudgets(ctx, prev);
      const pa = must(await ctx.api("POST", "/budgets", { month: prev, category: copyCat, amount: copyLimit }), "last month's budget");
      ctx.cleanup(() => ctx.api("DELETE", `/budgets/${pa.id ?? pa.budget?.id}?month=${prev}`));
      const pb = must(await ctx.api("POST", "/budgets", { month: prev, category: seedCategory, amount: 999 }), "last month's seed-category budget");
      ctx.cleanup(() => ctx.api("DELETE", `/budgets/${pb.id ?? pb.budget?.id}?month=${prev}`));
      const prevCats = new Set([...prevBefore.map((b: any) => String(b.category).toLowerCase()), copyCat, seedCategory]);
      const nowBefore = await storedBudgets(ctx, month);
      const nowCats = new Set(nowBefore.map((b: any) => String(b.category).toLowerCase()));
      const wantAdded = [...prevCats].filter((c) => !nowCats.has(c));
      const bootC0 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      ctx.step(L(`last month has ${copyCat} ${copyLimit} and ${seedCategory} 999; open the popup and press "Copy last month" twice quickly`));
      await openPopup();
      await pressTwice(s, t("budget-copy-last-month"));
      list = await waitBudgets(ctx, month, (l) => l.some((b: any) => b.category === copyCat));
      await sleep(1500);
      list = await storedBudgets(ctx, month);
      for (const b of list.filter((b: any) => b.id !== seedId)) ctx.cleanup(() => ctx.api("DELETE", `/budgets/${b.id}?month=${month}`));
      ctx.check("action", list.some((b: any) => b.category === copyCat), L("Copy last month copied"));
      const copied = list.filter((b: any) => b.category === copyCat);
      ctx.check("db", copied.length === 1 && Number(copied[0].amount) === copyLimit, L(`this month now holds one ${copyCat} budget of ${copyLimit} (a double press copied once)`), JSON.stringify(list.map((b: any) => [b.category, b.amount])));
      const exact = ctx.check("db", list.length === nowBefore.length + wantAdded.length, L(`exactly the ${wantAdded.length} categor${wantAdded.length === 1 ? "y" : "ies"} this month lacked were added`), JSON.stringify(list.map((b: any) => [b.category, b.amount, b.profileId ?? null])));
      if (!exact) ctx.finding({ severity: "bug", title: "\"Copy last month\" adds a second cap for a category this month already has", detail: `${s.surface}: this month's ${seedCategory} cap was made on Finance while the self profile was the active scope, so POST /api/budgets stored it with profileId = the self profile (applyActiveProfileScope, server/routes.ts); last month's ${seedCategory} cap has no profileId (made by chat / the API with no scope). copyBudgetsToMonth → mergeBudgetsForCopy (shared/budget-ledger.ts) compares owners with sameOwner(null, selfId) = false, so it appends ${seedCategory} 999 beside ${seedCategory} ${firstLimit}; GET /api/budgets returns both under every scope that shows either, and Finance lists ${seedCategory} twice. Stored: ${JSON.stringify(list.map((b: any) => [b.category, b.amount, b.profileId ?? null]))}. The same split lets the popup's Add create a second cap beside a chat-made one (upsertBudget → findBucket).` });
      ctx.near("db", list.find((b: any) => b.id === seedId)?.amount, firstLimit, L(`this month's own ${seedCategory} limit is kept (not last month's 999)`));
      const bootC1 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      const addedSum = O.cents(list.filter((b: any) => !nowBefore.some((n: any) => n.id === b.id)).reduce((sum: number, b: any) => sum + Number(b.amount), 0));
      ctx.near("derived", O.cents(bootC1.totalBudget - bootC0.totalBudget), addedSum, L("the budget total rose by exactly the copied limits"));
      const copiedRow = copied[0] ? await showsAmount(s, t(`budget-row-${copied[0].id}`), copyLimit, 0.5) : { ok: false, text: "" };
      ctx.check("screen", copiedRow.ok, L(`the popup lists ${copyCat} at ${copyLimit} without a reload`), copiedRow.text.slice(0, 140));
      await closeDialog(s);
      const copiedCard = await showsAmount(s, t(`money-budget-${copyCat}`), copyLimit, 0.5);
      ctx.check("screen", copiedCard.ok, L(`Finance's Budgets card shows ${copyCat} of ${copyLimit} without a reload`), copiedCard.text.slice(0, 140));
      for (const b of list.filter((b: any) => b.id !== seedId)) must(await ctx.api("DELETE", `/budgets/${b.id}?month=${month}`), "remove a copied budget");
      must(await ctx.api("DELETE", `/budgets/${pa.id ?? pa.budget?.id}?month=${prev}`), "remove last month's budget");
      must(await ctx.api("DELETE", `/budgets/${pb.id ?? pb.budget?.id}?month=${prev}`), "remove last month's seed-category budget");

      must(await ctx.api("DELETE", `/budgets/${seedId}?month=${month}`), "remove the seed budget");
      must(await ctx.api("DELETE", `/expenses/${e.id}`), "remove the expense");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});


// ─────────────────────────────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Aug 2029" for a calendar day. */
const monYear = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
/** The next date on a monthly payment day, counted from today (L4: never from a stored first-payment date). */
function nextOnDay(today: string, day: number): string {
  const here = `${today.slice(0, 7)}-01`;
  for (let k = 0; k < 3; k++) {
    const m = O.addMonthsAnchored(here, k);
    const d = `${m.slice(0, 8)}${String(Math.min(day, O.daysInMonth(Number(m.slice(0, 4)), Number(m.slice(5, 7))))).padStart(2, "0")}`;
    if (d >= today) return d;
  }
  throw new Error("no next date");
}
/** Poll a region's text until `ok` (or the time is up); answers the last text read. */
async function waitText(s: any, sel: string, ok: (text: string) => boolean, ms = 12000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    const text = await textOf(s, sel);
    if (ok(text) || Date.now() > until) return text;
    await sleep(400);
  }
}
async function debtTotalsWhen(ctx: Ctx, ok: (x: { debt: number; assets: number; net: number }) => boolean, ms = 8000) {
  const until = Date.now() + ms;
  for (;;) {
    const x = await debtTotals(ctx);
    if (ok(x) || Date.now() > until) return x;
    await sleep(700);
  }
}
async function debtTotals(ctx: Ctx) {
  const f = await snapshot(ctx);
  return { debt: Number(f.totalLiabilities), assets: Number(f.totalAssetValue), net: O.cents(Number(f.totalAssetValue) - Number(f.totalLiabilities)) };
}

scenario({
  id: "ui-money.debt",
  title: "A loan by hand (mouse and touch): added once, a payment recorded and reversed, its terms edited in place, deleted keeping its paid history — balance, payoff and every screen follow without a reload",
  area: "Browser · money",
  browser: true,
  covers: ["liability.create.ui", "liability.edit.ui", "liability.delete.ui", "liabilityPayment.create.ui", "liabilityPayment.complete.ui", "liabilityPayment.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const name = `${ctx.tag} ${s.surface} Car Loan`;
      const balance = ctx.int(80, 160) * 100;          // 8,000 – 16,000
      const original = balance + 4000;
      const apr = ctx.pick([4.5, 5.25, 6, 6.9, 7.4]);
      const payment = ctx.int(30, 45) * 10;            // 300 – 450
      const dueDay = ctx.int(3, 25);
      const start = `${O.addMonthsAnchored(`${ctx.today.slice(0, 7)}-01`, -8).slice(0, 8)}${String(dueDay).padStart(2, "0")}`;
      const q = `name=eq.${enc(name)}&deleted_at=is.null`;
      const t0 = await debtTotals(ctx);
      await goto(s, "/linked?tab=liabilities", "page-trackers");
      const reloads = watchReloads(s);
      s.problems();

      const openCreate = async () => {
        const btn = vis(s, t("button-create-liability"));
        if (await btn.isVisible().catch(() => false)) await tapIt(s, btn); else await s.press(t("btn-empty-add-liability"));
        const dlg = s.page.locator(t("dialog-create-profile"));
        await dlg.waitFor({ timeout: 10000 });
        await tapIt(s, dlg.getByText(/^Auto Loan$/).first());
        await s.press(t("btn-next-create-profile"));
        await vis(s, t("input-profile-name")).waitFor({ timeout: 10000 });
      };
      const fillForm = async () => {
        await typeInto(s, t("input-profile-name"), name);
        const f = async (id: string, v: string) => { await vis(s, `[role="dialog"] [id="${id}"]`).fill(v); };
        await f("lender", "Integrity Credit Union");
        await f("original_balance", String(original));
        await f("current_balance", String(balance));
        await f("interest_rate", String(apr));
        await f("loan_term_months", "60");
        await f("start_date", start);
        await f("monthly_payment", String(payment));
      };

      // ── create: Cancel writes nothing; a double press makes one ────────────
      ctx.step(L(`open #/linked?tab=liabilities, "Add Liability", pick Auto Loan, Next, fill "${name}": balance ${balance}, ${apr}%, ${payment}/mo, started ${start}; press Back… Cancel`));
      await openCreate();
      await fillForm();
      await closeDialog(s);
      await sleep(1200);
      ctx.check("db", (await ctx.db.count("profiles", q)) === 0, L("closing the Add Liability form stores nothing"));
      ctx.step(L("open it again, fill the same, press Create Profile twice quickly"));
      await openCreate();
      await fillForm();
      await pressTwice(s, t("btn-submit-create-profile"));
      await waitRows(ctx, "profiles", q, (n) => n >= 1, 15000);
      await sleep(2000);
      const rows = await ctx.db.rows("profiles", q);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${r.id}?deleteHistory=1`));
      ctx.check("action", rows.length >= 1, L("the form added the loan"));
      const one = ctx.check("db", rows.length === 1, L("one liability row (a double press of Create Profile)"), `${rows.length} rows`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "A double press of \"Create Profile\" makes two liabilities", detail: `${s.surface}: ${rows.length} identical rows; debt counted ${rows.length} times. CreateProfileDialog's duplicate-name check reads /api/profiles before the first create lands, and the submit button is disabled only once the mutation is pending.` });
      const row = rows[0];
      if (!row) continue;
      for (const twin of rows.slice(1)) must(await ctx.api("DELETE", `/profiles/${twin.id}?deleteHistory=1`), "remove the twin");
      const id = row.id;
      const fx = row.fields || {};
      ctx.check("db", row.type === "liability" && row.type_key === "auto_loan", L("stored as a liability of type auto_loan (L4 reads type_key)"), JSON.stringify([row.type, row.type_key]));
      ctx.check("db", Number(fx.balance) === balance && Number(fx.interestRate) === apr && fx[RATE_UNIT] === "percent" && Number(fx.monthlyPayment) === payment,
        L(`stored under the canonical keys (L2/L3): balance ${balance}, interestRate ${apr} marked percent, monthlyPayment ${payment}`), JSON.stringify(fx));
      // derived
      const t1 = await debtTotalsWhen(ctx, (x) => Math.abs(O.cents(x.debt - t0.debt) - balance) < 0.005);
      ctx.near("derived", O.cents(t1.debt - t0.debt), balance, L("Debt rose by exactly the balance"));
      ctx.near("derived", O.cents(t1.net - t0.net), -balance, L("net worth fell by it"));
      const nextDue = nextOnDay(ctx.today, dueDay);
      const po = O.payoff(balance, apr, payment)!;
      const payoffDay = O.addMonthsAnchored(nextDue, po.months - 1);
      // screens: the list, then the page header, then Finance and the dashboard
      const card = vis(s, t(`liab-card-${id}`));
      ctx.check("screen", await seen(card, 15000), L("the Liabilities list shows the new loan without a reload"));
      const cardAmt = await showsAmount(s, t(`liab-card-${id}`), balance, 0.5);
      ctx.check("screen", cardAmt.ok, L(`its card shows the balance ${balance}`), cardAmt.text.slice(0, 160));
      await goto(s, `/profiles/${id}`, "liability-profile-page");
      const hb = await showsAmount(s, t("kpi-balance"), balance, 0.5);
      ctx.check("screen", hb.ok, L(`the page header's Balance is ${balance}`), hb.text);
      const hApr = await waitText(s, t("kpi-apr"), (x) => x.includes(`${apr.toFixed(2)}%`));
      ctx.check("screen", hApr.includes(`${apr.toFixed(2)}%`), L(`the header's APR is ${apr.toFixed(2)}% (L3: a percent, never 100×)`), hApr);
      const hPay = await waitText(s, t("kpi-payoff"), (x) => x.includes(monYear(payoffDay)));
      ctx.check("screen", hPay.includes(monYear(payoffDay)), L(`the header's payoff is ${monYear(payoffDay)} (${po.months} payments from ${nextDue})`), hPay);
      const ndWant = `${MONTHS[Number(nextDue.slice(5, 7)) - 1]} ${Number(nextDue.slice(8, 10))}`;
      const nd = await waitText(s, t("quick-next-due"), (x) => x.includes(ndWant));
      ctx.check("screen", nd.includes(ndWant), L(`Quick info's next due date is ${ndWant} (from today and the payment day, L4)`), nd);

      // ── a payment: Cancel writes nothing; one press records it once ────────
      const pay = O.cents(payment + ctx.int(1, 9) * 10 + 0.5);
      const split = O.splitPayment(balance, apr, pay);
      const ledger = () => ctx.db.rows("liability_payments", `liability_profile_id=eq.${id}`);
      ctx.step(L(`on the loan's page open Payments, "Pay custom", type ${pay}, press Cancel; again, type ${pay}, press Record payment twice quickly`));
      await s.press(t("tab-payments"));
      await s.press(t("action-custom"));
      await s.page.locator(t("payment-dialog")).waitFor({ timeout: 10000 });
      await typeInto(s, t("payment-amount-input"), String(pay));
      await tapIt(s, s.page.locator(t("payment-dialog")).getByRole("button", { name: /^cancel$/i }));
      await sleep(1200);
      ctx.check("db", (await ledger()).length === 0 && Number((await ctx.db.row("profiles", id))?.fields?.balance) === balance, L("Cancel on the payment dialog records nothing and leaves the balance"));
      await s.press(t("action-custom"));
      await s.page.locator(t("payment-dialog")).waitFor({ timeout: 10000 });
      await typeInto(s, t("payment-amount-input"), String(pay));
      await pressTwice(s, t("payment-submit"));
      await waitRows(ctx, "liability_payments", `liability_profile_id=eq.${id}`, (n) => n >= 1);
      await sleep(2000);
      let pays = await ledger();
      ctx.check("action", pays.length >= 1, L("the dialog recorded a payment"));
      ctx.check("db", pays.length === 1 && Number(pays[0].amount) === pay && pays[0].payment_date === ctx.today, L(`one ledger row of ${pay} dated today (a double press)`), JSON.stringify(pays.map((p: any) => [p.amount, p.payment_date])));
      const p1 = pays[0];
      if (!p1) continue;
      ctx.near("derived", p1.interest_portion, split.interest, L(`its interest is one month at ${apr}% on ${balance} (L5)`));
      ctx.near("derived", p1.principal_portion, split.principal, L("its principal is the rest"));
      const afterPay = await waitRow(ctx, "profiles", id, (r) => Math.abs(Number(r?.fields?.balance) - split.newBalance) < 0.005);
      ctx.near("db", afterPay?.fields?.balance, split.newBalance, L("the stored balance fell by the principal only"));
      const costRows = await ctx.db.rows("expenses", `tags=cs.${enc(`["payment-cost:${p1.id}"]`)}&deleted_at=is.null`);
      ctx.check("db", costRows.length === 1 && Math.abs(Number(costRows[0].amount) - split.interest) < 0.005, L(`its interest (${split.interest}) is the one expense it logged — principal is not spending (A4)`), JSON.stringify(costRows.map((e: any) => [e.amount, e.tags])));
      const t2 = await debtTotalsWhen(ctx, (x) => Math.abs(O.cents(t1.debt - x.debt) - split.principal) < 0.005);
      ctx.near("derived", O.cents(t1.debt - t2.debt), split.principal, L("Debt fell by the principal"));
      const hb2 = await showsAmount(s, t("kpi-balance"), split.newBalance, 0.5, 12000, balance);
      ctx.check("screen", hb2.ok, L(`the header's Balance reads ${split.newBalance} without a reload (L6)`), hb2.text);
      ctx.check("screen", await seen(vis(s, t(`payment-row-${p1.id}`))), L("the Payments tab lists it"));
      const po2 = O.payoff(split.newBalance, apr, payment)!;
      // A regular payment made after the previous due day covers the cycle that
      // follows it (CLAUDE.md A1, lastPaymentCoversCycle): the next instalment is
      // the one AFTER nextDue, and the payoff counts from there.
      const payoff2 = O.addMonthsAnchored(nextDue, po2.months);
      const hPay2 = await waitText(s, t("kpi-payoff"), (x) => x.includes(monYear(payoff2)));
      ctx.check("screen", hPay2.includes(monYear(payoff2)), L(`the header's payoff follows: ${monYear(payoff2)} (${po2.months} payments of ${payment} on ${split.newBalance})`), hPay2);
      await goto(s, "/linked?tab=liabilities", "page-trackers");
      const card2 = await showsAmount(s, t(`liab-card-${id}`), split.newBalance, 0.5, 12000, balance);
      ctx.check("screen", card2.ok, L(`the Liabilities list shows ${split.newBalance} (in-app navigation)`), card2.text.slice(0, 160));
      await goto(s, "/dashboard", "page-dashboard");
      const dd = await showsAmount(s, t("exec-money-debt"), t2.debt, 1);
      ctx.check("screen", dd.ok && Math.abs(t2.debt - (t0.debt + split.newBalance)) < 0.01, L(`the dashboard's Debt is ${O.cents(t0.debt + split.newBalance)}`), dd.text);

      // ── reverse it: two taps (Rule 8); everything returns ─────────────────
      await goto(s, `/profiles/${id}`, "liability-profile-page");
      await s.press(t("tab-payments"));
      ctx.step(L("on the Payments tab press the reverse icon of the payment once, wait; press it again"));
      await s.press(t(`reverse-payment-${p1.id}`));
      await sleep(2500);
      const stillThere = (await ledger()).length === 1;
      const armed = ctx.check("db", stillThere, L("one press of Reverse only arms it: the payment is still recorded (Rule 8)"));
      if (!armed) ctx.finding({ severity: "bug", title: "A liability payment is reversed by one press", detail: s.surface });
      if (stillThere) await s.press(t(`reverse-payment-${p1.id}`));
      pays = await waitRows(ctx, "liability_payments", `liability_profile_id=eq.${id}`, (n) => n === 0);
      ctx.check("db", pays.length === 0, L("the second press removes the ledger row"));
      const back = await waitRow(ctx, "profiles", id, (r) => Math.abs(Number(r?.fields?.balance) - balance) < 0.005);
      ctx.near("db", back?.fields?.balance, balance, L("and puts the balance back"));
      ctx.check("db", (await ctx.db.count("expenses", `tags=cs.${enc(`["payment-cost:${p1.id}"]`)}&deleted_at=is.null`)) === 0, L("and removes the interest expense it logged"));
      const t3 = await debtTotalsWhen(ctx, (x) => Math.abs(x.debt - t1.debt) < 0.005);
      ctx.near("derived", O.cents(t3.debt - t1.debt), 0, L("Debt is back to what it was"));
      ctx.check("screen", await gone(vis(s, t(`payment-row-${p1.id}`))), L("the payment leaves the list without a reload"));
      const hb3 = await showsAmount(s, t("kpi-balance"), balance, 0.5, 12000, split.newBalance);
      ctx.check("screen", hb3.ok, L(`the header's Balance is ${balance} again`), hb3.text);

      // ── edit the terms in place (L0/L7): saves itself, only what changed ──
      const apr2 = O.cents(apr + 0.75);
      const payment2 = payment + 25;
      const balance2 = balance - 500;
      await s.press(t("tab-overview"));
      ctx.step(L(`on Overview press Edit, type the balance ${balance2}, the rate ${apr2}, the payment ${payment2}, press Done`));
      await s.press(t("button-edit-terms"));
      await sleep(1500);
      ctx.check("db", (await ctx.db.row("profiles", id))?.updated_at === back?.updated_at, L("opening the editor writes nothing (Rule 3)"));
      await typeInto(s, t("input-terms-balance"), String(balance2));
      await typeInto(s, t("input-terms-rate"), String(apr2));
      await typeInto(s, t("input-terms-monthly"), String(payment2));
      await s.press(t("button-save-terms"));
      const ed = await waitRow(ctx, "profiles", id, (r) => Number(r?.fields?.interestRate) === apr2 && Number(r?.fields?.monthlyPayment) === payment2 && Number(r?.fields?.balance) === balance2, 15000);
      ctx.check("db", Number(ed?.fields?.interestRate) === apr2 && ed?.fields?.[RATE_UNIT] === "percent", L(`the stored rate is ${apr2}, marked percent (L3)`), JSON.stringify({ r: ed?.fields?.interestRate, u: ed?.fields?.[RATE_UNIT] }));
      ctx.check("db", Number(ed?.fields?.monthlyPayment) === payment2, L(`the stored payment is ${payment2}`), JSON.stringify(ed?.fields?.monthlyPayment));
      const balOk = ctx.check("db", Number(ed?.fields?.balance) === balance2, L(`the stored balance is ${balance2}, under the canonical key (L2)`), JSON.stringify({ balance: ed?.fields?.balance, currentBalance: ed?.fields?.currentBalance }));
      if (!balOk) ctx.finding({ severity: "bug", title: "A balance edited in place on a liability page is not stored", detail: `${s.surface}: typed ${balance2}; stored balance ${ed?.fields?.balance}, currentBalance ${ed?.fields?.currentBalance}. The terms form writes the ALIAS currentBalance (buildTermsFields, client/src/pages/liability-detail.tsx), which the storage fold discards when the canonical balance disagrees (L2).` });
      ctx.check("db", ed?.name === name && ed?.type_key === "auto_loan", L("the name and type are untouched"));
      // a write made in the browser reaches this client's reads within ~2 s (I9: VERSION_MEMO_MS)
      const t4 = await debtTotalsWhen(ctx, (x) => Math.abs(O.cents(x.debt - t0.debt) - Number(ed?.fields?.balance)) < 0.005);
      ctx.near("derived", O.cents(t4.debt - t0.debt), Number(ed?.fields?.balance), L("Debt follows the stored balance"));
      const po4 = O.payoff(balance2, apr2, payment2)!;
      const payoff4 = O.addMonthsAnchored(nextDue, po4.months - 1);
      const hApr4 = await waitText(s, t("kpi-apr"), (x) => x.includes(`${apr2.toFixed(2)}%`));
      ctx.check("screen", hApr4.includes(`${apr2.toFixed(2)}%`), L(`the header's APR reads ${apr2.toFixed(2)}% without a reload`), hApr4);
      const hb4 = await showsAmount(s, t("kpi-balance"), balance2, 0.5, 12000, balance);
      ctx.check("screen", hb4.ok, L(`the header's Balance reads ${balance2}`), hb4.text);
      const hpo4 = await waitText(s, t("kpi-payoff"), (x) => x.includes(monYear(payoff4)));
      ctx.check("screen", hpo4.includes(monYear(payoff4)), L(`the header's payoff is recomputed: ${monYear(payoff4)} (${po4.months} payments)`), hpo4);
      await goto(s, "/linked?tab=liabilities", "page-trackers");
      const card4 = await showsAmount(s, t(`liab-card-${id}`), balance2, 0.5, 12000, balance);
      ctx.check("screen", card4.ok, L(`the Liabilities list shows ${balance2}`), card4.text.slice(0, 160));

      // ── delete, keeping the money already paid (I11) ──────────────────────
      const kept = must(await ctx.api("POST", `/liabilities/${id}/payments`, { amount: payment2, paymentDate: ctx.today, idempotencyKey: `${ctx.tag}-${s.surface}-keep` }), "a payment to keep");
      const keptId = kept?.payment?.id ?? kept?.id;
      const keptCost = await ctx.db.rows("expenses", `tags=cs.${enc(`["payment-cost:${keptId}"]`)}&deleted_at=is.null`);
      for (const e of keptCost) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      await goto(s, `/profiles/${id}`, "liability-profile-page");
      ctx.step(L("open ⋯ → Delete this liability, press Cancel; again, leave \"Also delete its recorded payments\" unticked, confirm"));
      const openDelete = async () => {
        await s.press(t("button-liability-menu"));
        await s.press(t("button-delete-profile"));
        await s.page.locator(t("dialog-confirm-delete-profile")).waitFor({ timeout: 8000 });
      };
      await openDelete();
      ctx.check("db", !!(await ctx.db.row("profiles", id)) && (await ctx.db.row("profiles", id)).deleted_at == null, L("the menu item only asks: the loan is still there (Rule 8)"));
      await s.press(t("button-cancel-delete-profile"));
      await sleep(1000);
      ctx.check("db", (await ctx.db.row("profiles", id))?.deleted_at == null, L("Cancel keeps it"));
      await openDelete();
      const box = s.page.locator(t("checkbox-delete-history"));
      ctx.check("screen", (await box.getAttribute("data-state").catch(() => null)) !== "checked", L("\"Also delete its recorded payments\" starts unticked (I11)"));
      await s.press(t("button-confirm-delete-profile"));
      const goneRows = await waitRows(ctx, "profiles", `id=eq.${id}&deleted_at=is.null`, (n) => n === 0);
      ctx.check("action", goneRows.length === 0, L("confirming deletes the loan"));
      const keptNow = keptCost[0] ? await waitRow(ctx, "expenses", keptCost[0].id, (r) => (r?.tags || []).some((x: string) => x.startsWith("from-deleted:"))) : null;
      ctx.check("db", keptCost.length === 1 && !!keptNow && keptNow.deleted_at == null && (keptNow.tags || []).some((x: string) => x.startsWith("from-deleted:")),
        L("the interest expense its payment recorded stays, tagged from-deleted (I11)"), JSON.stringify({ n: keptCost.length, tags: keptNow?.tags, del: keptNow?.deleted_at }));
      const t5 = await debtTotalsWhen(ctx, (x) => Math.abs(x.debt - t0.debt) < 0.005);
      ctx.near("derived", O.cents(t5.debt - t0.debt), 0, L("Debt is back where it started"));
      const onList = await s.page.waitForFunction(() => /\/linked/.test(location.href) && /tab=liabilities/.test(location.href), null, { timeout: 10000 }).then(() => true).catch(() => false);
      // (the hash router keeps "?tab=liabilities" as the page's search: "/?tab=liabilities#/linked", the form tests/live-liability-forms-check.ts accepts)
      const listShown = onList && await seen(s.page.locator(`${t("section-toggle-liabilities")}, ${t("liabilities-empty")}, ${t("category-filter-chips-liabilities")}`).locator("visible=true").first(), 8000);
      ctx.check("screen", listShown, L("the app returns to the Liabilities list (L7)"), await s.page.evaluate(() => location.href));
      ctx.check("screen", await gone(vis(s, t(`liab-card-${id}`))), L("which no longer lists it, without a reload"));
      await goto(s, "/dashboard", "page-dashboard");
      const dd5 = await showsAmount(s, t("exec-money-debt"), t0.debt, 1, 12000, O.cents(t0.debt + balance2));
      ctx.check("screen", dd5.ok, L(`the dashboard's Debt is back to ${t0.debt}`), dd5.text);
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});


// ─────────────────────────────────────────────────────────────────────────────
const shortDay = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;

scenario({
  id: "ui-money.bill",
  title: "A recurring bill by hand (mouse and touch): added once from Liabilities; on its page the amount edited, one date paid, the next skipped, the one after moved, then deleted keeping what was paid — next date, spending and every screen follow without a reload",
  area: "Browser · money",
  browser: true,
  covers: ["bill.create.ui", "bill.edit.ui", "bill.complete.ui", "bill.cancel.ui", "bill.reschedule.ui", "bill.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      await goto(s, "/linked?tab=liabilities", "page-trackers");
      const reloads = watchReloads(s);
      s.problems();

      // ── create: the Add Liability dialog, a Phone Plan ────────────────────
      const planName = `${ctx.tag} ${s.surface} Phone Plan`;
      const planAmt = ctx.int(35, 95) + 0.5;
      const planDay = ctx.int(2, 26);
      const planStart = `${O.addMonthsAnchored(`${ctx.today.slice(0, 7)}-01`, -5).slice(0, 8)}${String(planDay).padStart(2, "0")}`;
      const pq = `name=eq.${enc(planName)}&deleted_at=is.null`;
      ctx.step(L(`on #/linked?tab=liabilities press "Add Liability", pick Phone Plan, Next, type "${planName}", carrier, ${planAmt}, started ${planStart}; press Create Profile twice quickly`));
      const btn = vis(s, t("button-create-liability"));
      if (await btn.isVisible().catch(() => false)) await tapIt(s, btn); else await s.press(t("btn-empty-add-liability"));
      const dlg = s.page.locator(t("dialog-create-profile"));
      await dlg.waitFor({ timeout: 10000 });
      await tapIt(s, dlg.getByText(/^Phone Plan$/).first());
      await s.press(t("btn-next-create-profile"));
      await typeInto(s, t("input-profile-name"), planName);
      await vis(s, '[role="dialog"] [id="carrier"]').fill("Integrity Mobile");
      await vis(s, '[role="dialog"] [id="amount"]').fill(String(planAmt));
      await vis(s, '[role="dialog"] [id="start_date"]').fill(planStart);
      await pressTwice(s, t("btn-submit-create-profile"));
      await waitRows(ctx, "profiles", pq, (n) => n >= 1, 15000);
      await sleep(2000);
      const plans = await ctx.db.rows("profiles", pq);
      for (const r of plans) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${r.id}?deleteHistory=1`));
      ctx.check("action", plans.length >= 1, L("the dialog added the bill"));
      const onePlan = ctx.check("db", plans.length === 1, L("one bill row (a double press)"), `${plans.length} rows`);
      if (!onePlan && plans.length > 1) ctx.finding({ severity: "bug", title: "A double press of \"Create Profile\" makes two bills", detail: `${s.surface}: ${plans.length} rows` });
      const plan = plans[0];
      if (plan) {
        const planNext = O.nextBillDate(planStart, "monthly", ctx.today);
        ctx.check("db", Number(plan.fields?.amount) === planAmt && plan.type_key === "phone_plan", L(`stored as a phone_plan bill of ${planAmt}`), JSON.stringify([plan.type, plan.type_key, plan.fields]));
        ctx.same("derived", plan.fields?.nextDueDate ?? plan.fields?.dueDate, planNext, L("its next due date is the first one on or after today (A7)"));
        ctx.check("screen", await seen(vis(s, t(`liab-card-${plan.id}`)), 15000), L("the Liabilities list shows it without a reload"));
        const planCard = await showsAmount(s, t(`liab-card-${plan.id}`), planAmt, 0.005);
        ctx.check("screen", planCard.ok, L(`its card shows ${planAmt}`), planCard.text.slice(0, 160));
        await goto(s, "/finance", "page-finance");
        ctx.check("screen", await seen(s.page.locator(t("money-bills")).getByText(planName).first(), 15000), L("Finance's Bills & Payments lists it (in-app navigation)"));
        for (const r of plans) must(await ctx.api("DELETE", `/profiles/${r.id}?deleteHistory=1`), "remove the plan");
      }

      // ── a utility bill on its own page ────────────────────────────────────
      const name = `${ctx.tag} ${s.surface} Water Bill`;
      const amount = ctx.int(30, 80) + 0.25;
      const day = ctx.int(3, 25);
      const d1 = nextOnDay(ctx.today, day);
      const bill = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "utility", name, fields: { amount, frequency: "monthly", dueDate: d1 } }), "the bill");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${bill.id}?deleteHistory=1`));
      const id = bill.id;
      const snap0 = await snapshot(ctx);
      await goto(s, `/profiles/${id}`, "liability-profile-page");
      const due0 = await waitText(s, t("kpi-bill-due"), (x) => x.includes(shortDay(d1)));
      ctx.check("screen", due0.includes(shortDay(d1)), L(`the header's Next due is ${shortDay(d1)}`), due0);

      // edit the amount in place: opening writes nothing; Done stores it
      const amount2 = O.cents(amount + ctx.int(3, 12));
      const before = await ctx.db.row("profiles", id);
      ctx.step(L(`on Overview press Edit, wait, type the amount ${amount2}, press Done`));
      await s.press(t("button-edit-bill"));
      await sleep(1500);
      ctx.check("db", (await ctx.db.row("profiles", id))?.updated_at === before?.updated_at, L("opening the editor writes nothing (Rule 3)"));
      await typeInto(s, t("input-bill-amount"), String(amount2));
      await s.press(t("button-save-bill"));
      const ed = await waitRow(ctx, "profiles", id, (r) => Number(r?.fields?.amount) === amount2);
      ctx.check("action", Number(ed?.fields?.amount) === amount2, L("Done saved the edit"));
      ctx.check("db", Number(ed?.fields?.amount) === amount2 && ed?.name === name && (ed?.fields?.dueDate ?? ed?.fields?.nextDueDate) === d1 && ed?.fields?.frequency === "monthly",
        L(`the stored amount is ${amount2}; the name, due date and frequency are untouched (A7: a due date is written only when changed)`), JSON.stringify(ed?.fields));
      const hm = await showsAmount(s, t("kpi-bill-monthly"), amount2, 0.005, 12000, amount);
      ctx.check("screen", hm.ok, L(`the header's amount reads ${amount2} without a reload`), hm.text);

      // pay the first date (complete): one payment, its whole amount is spending (A4)
      ctx.step(L(`open Schedule and press Pay on ${d1} twice quickly`));
      await s.press(t("tab-schedule"));
      await pressTwice(s, t(`occ-pay-${d1}`));
      await waitRows(ctx, "liability_payments", `liability_profile_id=eq.${id}`, (n) => n >= 1);
      await sleep(2000);
      const pays = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${id}`);
      ctx.check("action", pays.length >= 1, L("Pay recorded a payment"));
      ctx.check("db", pays.length === 1 && Number(pays[0].amount) === amount2, L(`one payment of ${amount2} (a double press)`), JSON.stringify(pays.map((p: any) => [p.amount, p.payment_date])));
      const pid = pays[0]?.id;
      const payExp = pid ? await ctx.db.rows("expenses", `tags=cs.${enc(`["payment:${pid}"]`)}&deleted_at=is.null`) : [];
      for (const e of payExp) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      ctx.check("db", payExp.length === 1 && Number(payExp[0].amount) === amount2, L("its whole amount is one expense, tagged payment:<id> (A4)"), JSON.stringify(payExp.map((e: any) => [e.amount, e.date, e.tags])));
      const d2 = O.occurrence(d1, "monthly", 1);
      const afterPay = await waitRow(ctx, "profiles", id, (r) => (r?.fields?.dueDate ?? r?.fields?.nextDueDate) === d2);
      ctx.same("derived", afterPay?.fields?.dueDate ?? afterPay?.fields?.nextDueDate, O.nextBillDate(d1, "monthly", ctx.today, [d1]), L("the next due date moves to the following month"));
      const expDate = payExp[0]?.date as string | undefined;
      const snap1 = await snapshot(ctx);
      const inMonth = !!expDate && expDate.slice(0, 7) === ctx.today.slice(0, 7);
      ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), inMonth ? amount2 : 0, L(`this month's spending rose by ${inMonth ? amount2 : 0} (the expense is dated ${expDate})`));
      const due1 = await waitText(s, t("kpi-bill-due"), (x) => x.includes(shortDay(d2)));
      ctx.check("screen", due1.includes(shortDay(d2)), L(`the header's Next due reads ${shortDay(d2)} without a reload`), due1);

      // skip the next date (cancel one occurrence): no money moves; the series steps over it
      ctx.step(L(`press Skip on ${d2}`));
      await s.press(t(`occ-skip-${d2}`));
      const d3 = O.occurrence(d1, "monthly", 2);
      const afterSkip = await waitRow(ctx, "profiles", id, (r) => r?.fields?.occurrences?.[d2]?.status === "skipped");
      ctx.check("db", afterSkip?.fields?.occurrences?.[d2]?.status === "skipped", L(`${d2} is stored as skipped`), JSON.stringify(afterSkip?.fields?.occurrences));
      ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${id}`)) === 1, L("skipping records no payment"));
      ctx.same("derived", O.nextBillDate(d1, "monthly", ctx.today, [d1, d2]), d3, L("the next open date is the one after"));
      const due2 = await waitText(s, t("kpi-bill-due"), (x) => x.includes(shortDay(d3)));
      ctx.check("screen", due2.includes(shortDay(d3)), L(`the header's Next due reads ${shortDay(d3)}`), due2);
      const snap2 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap2.totalMonthlySpend - snap1.totalMonthlySpend), 0, L("and spending does not move"));

      // reschedule the one after: that date alone moves
      const moved = O.addDays(d3, 3);
      ctx.step(L(`press the pencil on ${d3}, type ${moved} under "Reschedule this occurrence", press Move`));
      await s.press(t(`occ-edit-${d3}`));
      const pop = s.page.locator('[role="dialog"]').filter({ hasText: "Reschedule this occurrence" }).locator("visible=true").first();
      await pop.waitFor({ timeout: 8000 });
      await pop.locator('input[type="date"]').first().fill(moved);
      const moveBtn = pop.getByRole("button", { name: /^move$/i });
      const pressed = await tapIt(s, moveBtn, { timeout: 6000 }).then(() => true).catch(async (e: any) => {
        const box = await moveBtn.boundingBox().catch(() => null);
        const vp = s.page.viewportSize();
        ctx.step(L(`Move could not be pressed: ${String(e?.message || e).split("\n").slice(-3).join(" ").slice(0, 300)} — box ${JSON.stringify(box)} viewport ${JSON.stringify(vp)}`));
        return false;
      });
      const pressable = ctx.check("screen", pressed, L("the Move button in the occurrence's popover can be pressed"));
      if (!pressable) {
        ctx.finding({ severity: "bug", title: "The bill occurrence popover's Move button cannot be pressed", detail: `${s.surface}: Schedule → pencil on ${d3} → "Reschedule this occurrence" → Move: Playwright never found it stable and in view (BillScheduleSection.tsx PopoverContent).` });
        await moveBtn.focus(); await s.page.keyboard.press("Enter");
      }
      const afterMove = await waitRow(ctx, "profiles", id, (r) => r?.fields?.occurrences?.[d3]?.movedTo === moved);
      ctx.check("db", afterMove?.fields?.occurrences?.[d3]?.movedTo === moved, L(`${d3} is stored as moved to ${moved}`), JSON.stringify(afterMove?.fields?.occurrences));
      ctx.check("db", Number(afterMove?.fields?.amount) === amount2 && afterMove?.fields?.frequency === "monthly", L("the series itself is untouched (A3)"));
      await s.page.keyboard.press("Escape");
      const due3 = await waitText(s, t("kpi-bill-due"), (x) => x.includes(shortDay(moved)));
      ctx.check("screen", due3.includes(shortDay(moved)), L(`the header's Next due reads ${shortDay(moved)}`), due3);
      const cal = must(await ctx.api("GET", `/calendar/timeline?start=${d3}&end=${O.addDays(moved, 1)}`), "calendar");
      const calItems = (Array.isArray(cal) ? cal : cal?.items || cal?.timeline || []).filter((x: any) => String(x.title || x.name || "").includes(name));
      ctx.check("derived", calItems.some((x: any) => String(x.date || x.start || "").slice(0, 10) === moved) && !calItems.some((x: any) => String(x.date || x.start || "").slice(0, 10) === d3),
        L(`the Calendar has the bill on ${moved}, not ${d3}`), JSON.stringify(calItems.map((x: any) => [x.date || x.start, x.title])));

      // delete, keeping what was paid (I11)
      ctx.step(L("open ⋯ → Delete this liability, confirm with \"Also delete its recorded payments\" unticked"));
      await s.press(t("button-liability-menu"));
      await s.press(t("button-delete-profile"));
      await s.page.locator(t("dialog-confirm-delete-profile")).waitFor({ timeout: 8000 });
      ctx.check("db", (await ctx.db.row("profiles", id))?.deleted_at == null, L("the menu item only asks (Rule 8)"));
      await s.press(t("button-confirm-delete-profile"));
      const left = await waitRows(ctx, "profiles", `id=eq.${id}&deleted_at=is.null`, (n) => n === 0);
      ctx.check("db", left.length === 0, L("confirming deletes the bill"));
      const keptExp = payExp[0] ? await waitRow(ctx, "expenses", payExp[0].id, (r) => (r?.tags || []).some((x: string) => x.startsWith("from-deleted:"))) : null;
      ctx.check("db", !!keptExp && keptExp.deleted_at == null && (keptExp.tags || []).some((x: string) => x.startsWith("from-deleted:")), L("the paid expense stays, tagged from-deleted (I11)"), JSON.stringify({ tags: keptExp?.tags, del: keptExp?.deleted_at }));
      const snap3 = await snapshot(ctx);
      ctx.near("derived", O.cents(snap3.totalMonthlySpend - snap1.totalMonthlySpend), 0, L("this month's spending keeps the paid amount"));
      await goto(s, "/finance", "page-finance");
      ctx.check("screen", await gone(s.page.locator(t("money-bills")).getByText(name).locator("visible=true").first()), L("Finance's Bills & Payments no longer lists the bill's coming dates"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});


// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-money.debt-links",
  title: "A loan's collateral by hand (mouse and touch): an asset linked from \"Owners & linked records\" and unlinked with two taps — stored once, shown on the page, and the debt still counted once",
  area: "Browser · money",
  browser: true,
  covers: ["liability.transfer.ui", "liability.cancel.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const carName = `${ctx.tag} ${s.surface} Sedan`;
      const carValue = ctx.int(90, 180) * 100;
      const loanBal = ctx.int(40, 80) * 100;
      const t0 = await debtTotals(ctx);
      const car = must(await ctx.api("POST", "/profiles", { type: "vehicle", name: carName, fields: { value: carValue, valuationMode: "manual" } }), "the car");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${car.id}`));
      const loan = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "auto_loan", name: `${ctx.tag} ${s.surface} Sedan Loan`, fields: { balance: loanBal, interestRate: 5, _interestRateUnit: "percent", monthlyPayment: 300, dueDay: 10 } }), "the loan");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${loan.id}?deleteHistory=1`));
      const links = () => ctx.db.rows("liability_asset_links", `liability_profile_id=eq.${loan.id}`);
      const t1 = await debtTotalsWhen(ctx, (x) => Math.abs(O.cents(x.debt - t0.debt) - loanBal) < 0.005 && Math.abs(O.cents(x.assets - t0.assets) - carValue) < 0.005);
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, `/profiles/${loan.id}`, "liability-profile-page");
      const reloads = watchReloads(s);
      s.problems();

      ctx.step(L(`on the loan's page press the owner chip ("Owners & linked records"), "Link asset", pick "${carName}", press Link twice quickly`));
      await s.press(t("chip-owner"));
      await s.page.locator(t("dialog-links")).waitFor({ timeout: 10000 });
      ctx.check("db", (await links()).length === 0, L("opening Owners & linked records writes nothing"));
      await s.press(t("link-asset-toggle"));
      await pickOption(s, t("link-asset-select"), carName);
      await pressTwice(s, t("link-asset-confirm"));
      await waitRows(ctx, "liability_asset_links", `liability_profile_id=eq.${loan.id}`, (n) => n >= 1);
      await sleep(1500);
      let ls = await links();
      ctx.check("action", ls.length >= 1, L("the asset was linked"));
      ctx.check("db", ls.length === 1 && ls[0].asset_profile_id === car.id && ls[0].role === "collateral", L("one link row: the car, as collateral (a double press)"), JSON.stringify(ls.map((l: any) => [l.asset_profile_id, l.role])));
      const t2 = await debtTotals(ctx);
      ctx.near("derived", O.cents(t2.debt - t1.debt), 0, L("linking collateral does not change Debt (the loan counts once)"));
      ctx.near("derived", O.cents(t2.assets - t1.assets), 0, L("nor Assets"));
      const row = ls[0] ? vis(s, t(`asset-link-row-${ls[0].id}`)) : null;
      ctx.check("screen", !!row && await seen(row), L("the dialog lists the linked car without a reload"));
      await closeDialog(s);
      const ov = await waitText(s, t("detail-row-linked-asset"), (x) => x.includes(carName));
      ctx.check("screen", ov.includes(carName), L("the Overview's linked asset line names the car"), ov.slice(0, 160));

      if (ls[0]) {
        ctx.step(L("open Owners & linked records again and press the unlink icon of the car once, wait; press it again"));
        await s.press(t("chip-owner"));
        await s.page.locator(t("dialog-links")).waitFor({ timeout: 10000 });
        await s.press(`${t(`asset-link-row-${ls[0].id}`)} ${t("asset-link-delete")}`);
        await sleep(2000);
        const armed = ctx.check("db", (await links()).length === 1, L("one press of unlink only arms it (Rule 8)"));
        if (!armed) ctx.finding({ severity: "bug", title: "A liability's collateral is unlinked by one press", detail: `${s.surface}: liability page → Owners & linked records → the trash icon on a linked asset removed the link at once (AssetLinkRow, client/src/pages/liability-detail.tsx).` });
        if (armed) await s.press(`${t(`asset-link-row-${ls[0].id}`)} ${t("asset-link-delete")}`);
        ls = await waitRows(ctx, "liability_asset_links", `liability_profile_id=eq.${loan.id}`, (n) => n === 0);
        ctx.check("db", ls.length === 0, L("the second press removes the link"));
        ctx.check("db", (await ctx.db.row("profiles", car.id))?.deleted_at == null && (await ctx.db.row("profiles", loan.id))?.deleted_at == null, L("both records stay"));
        const t3 = await debtTotals(ctx);
        ctx.near("derived", O.cents(t3.debt - t1.debt), 0, L("Debt is unchanged"));
        ctx.check("screen", await seen(vis(s, t("linked-assets-empty"))), L("the dialog says no asset is linked, without a reload"));
        await closeDialog(s);
      }
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

void listOf; void pageText;
