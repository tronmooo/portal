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
  covers: ["budget.create.ui", "budget.edit.ui", "budget.delete.ui"],
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

      // With no budget at all, is there a way to make the first one?
      if ((await storedBudgets(ctx, month)).length === 0) {
        await sleep(1500);
        const offered = await vis(s, t("money-manage-budgets")).isVisible().catch(() => false);
        const first = ctx.check("screen", offered, L("with no budget yet, Finance offers a way to add the first one"), "no \"+ Budget\" control: the Budgets card is drawn only once a budget exists");
        if (!first) ctx.finding({ severity: "gap", title: "No screen offers a way to add the FIRST budget", detail: `${s.surface}: on #/finance the Budgets card (and its "+ Budget" button, components/finance/MoneyOverview.tsx "budgets.length > 0") is drawn only when a budget already exists; the Executive dashboard has no budget control, and BudgetPopup's own "Add first category" empty state is unreachable. A first budget can only be made from chat or the API.` });
      }
      // one budget made elsewhere, so the card is there; and one expense in the category the screen will budget
      const seed = must(await ctx.api("POST", "/budgets", { month, category: seedCategory, amount: 150 }), "seed budget");
      const seedId = seed.id ?? seed.budget?.id;
      ctx.cleanup(() => ctx.api("DELETE", `/budgets/${seedId}?month=${month}`));
      const e = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} ${s.surface} ${category}`, amount: spend, category, date: ctx.today }), "expense");
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      const boot0 = must(await ctx.api("GET", "/dashboard-bootstrap"), "bootstrap").budgetSummary;
      const snap0 = await snapshot(ctx);
      const spent = O.spentIn([{ amount: spend, category, date: ctx.today }], month, category);
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/finance", "page-finance");
      const cardThere = await seen(vis(s, t("money-manage-budgets")), 15000);
      ctx.check("screen", cardThere, L("a budget made elsewhere brings the Budgets card to Finance (in-app navigation)"));
      if (!cardThere) continue;
      const openPopup = async () => {
        if (await vis(s, t("popup-budget")).isVisible().catch(() => false)) return;
        await s.press(t("money-manage-budgets"));
        await vis(s, t("budget-show-add")).waitFor({ timeout: 10000 });
      };
      const catInput = () => s.page.getByPlaceholder(/category/i).locator("visible=true").first();
      const amtInput = () => s.page.getByPlaceholder(/\$ amount/i).locator("visible=true").first();

      // the add row, cancelled: nothing stored
      ctx.step(L(`on #/finance press "+ Budget", "Add category", type "${category}" and ${limit}, press Cancel`));
      await openPopup();
      await s.press(t("budget-show-add"));
      await catInput().fill(category);
      await amtInput().fill(String(limit));
      await tapIt(s, s.page.getByRole("dialog").getByRole("button", { name: /^cancel$/i }).first());
      await sleep(1200);
      ctx.check("db", !(await storedBudgets(ctx, month)).some((b: any) => b.category === category), L("Cancel on the add row stores nothing"));

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
      ctx.check("db", Number(after?.amount) === newLimit && after?.category === category && list.length === 2 && Number(list.find((b: any) => b.id === seedId)?.amount) === 150,
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
      must(await ctx.api("DELETE", `/budgets/${seedId}?month=${month}`), "remove the seed budget");
      must(await ctx.api("DELETE", `/expenses/${e.id}`), "remove the expense");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

void listOf; void RATE_UNIT; void pickOption; void pageText;
