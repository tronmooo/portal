// Two devices, one account: what one device writes, the other shows — after a
// reload AND while it simply stays open — and a double press on a create button
// is one record, whatever the form.
//
// Two systemic client defects this file was written against (isolated stack,
// 2026-11-28), both fixed at the request/cache layer and guarded by
// tests/sync-devices-reload-and-double-submit.test.ts:
//  1. After a reload, a write made on another device was missing and stayed
//     missing: the restored snapshot counted as fresh and the version watch (I9)
//     took its starting point from the first answer after the reload, which
//     already held the other device's write (lib/server-versions.ts,
//     restoreServerVersions; lib/queryClient.ts snapshotCache/hydrateQueryCache).
//  2. A double press on a create made two records (goal form, the Net worth
//     sheet's "Add asset"): an identical write still in flight is now the same
//     submission (apiRequest, lib/queryClient.ts).
//
// Device A is one browser context, device B the other (desktop mouse and phone
// touch, both orders). A writes through its own signed-in session — from B's
// side that is "another device" exactly as a second phone would be. Every
// figure B shows is held to the change A made, measured as a delta from what B
// showed before, and every row is read straight from the database.
import { scenario, must, type Ctx } from "../framework";
import * as O from "../oracle";

const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const vis = (s: any, sel: string) => s.page.locator(sel).locator("visible=true").first();
const tapIt = (s: any, loc: any, opts: any = {}) => (s.surface === "phone" ? loc.tap(opts) : loc.click(opts));
const press = async (s: any, sel: string) => { const el = vis(s, sel); await el.waitFor({ timeout: 15000 }); await tapIt(s, el); };
const enc = encodeURIComponent;

const goto = async (s: any, route: string, pageId: string) => {
  await s.page.evaluate((r: string) => { window.location.hash = `#${r}`; }, route);
  if (pageId) await s.page.waitForSelector(t(pageId), { timeout: 30000 });
  else { await s.page.waitForFunction((r: string) => window.location.hash.startsWith(`#${r}`), route, { timeout: 15000 }); await s.page.waitForSelector("main", { timeout: 30000 }); }
};
async function until(fn: () => Promise<boolean>, ms: number, every = 500): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}
async function waitRows(ctx: Ctx, table: string, query: string, want: (rows: any[]) => boolean, ms = 12000): Promise<any[]> {
  const end = Date.now() + ms;
  for (;;) {
    const rows = await ctx.db.rows(table, query);
    if (want(rows) || Date.now() > end) return rows;
    await sleep(400);
  }
}
const words = async (s: any, sel: string) => ((await vis(s, sel).innerText({ timeout: 8000 }).catch(() => "")) as string).replace(/\s+/g, " ");
const money = (text: string, label: RegExp): number => {
  const m = new RegExp(`${label.source}\\s*\\$([0-9,]+(?:\\.[0-9]{1,2})?)`, "i").exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
};
const textShown = (s: any, text: string) => s.page.getByText(text, { exact: false }).locator("visible=true").first().isVisible().catch(() => false);

/** What device B's screens say, read off the screens themselves. */
async function readB(s: any) {
  await goto(s, "/dashboard", "page-dashboard");
  await s.page.waitForSelector(t("hub-kpi-tasks"), { timeout: 20000 });
  await sleep(800);
  const tasksDue = Number((/Tasks Due\s*(\d+)/i.exec(await words(s, t("hub-kpi-tasks"))) || [])[1]);
  const dashExpenses = money(await words(s, t("exec-money-month")), /Expenses/);
  return { tasksDue, dashExpenses };
}
async function financeSpend(s: any) {
  await s.page.waitForSelector(t("money-spend"), { timeout: 20000 });
  return money(await words(s, t("money-spend")), /MTD/);
}

/** A request from device A's own signed-in session (its token, its origin). */
async function fromA(ctx: Ctx, a: any, method: string, path: string, body?: unknown): Promise<any> {
  // A's own session token, sent from A's browser context (its request client
  // shares that context): to device B this is another device of the account.
  const token: string = await a.page.evaluate(() => {
    const raw = localStorage.getItem("portol_session") || sessionStorage.getItem("portol_session");
    return raw ? String(JSON.parse(raw).access_token || "") : "";
  });
  const origin = new URL(a.page.url()).origin;
  const res = await a.page.request.fetch(`${origin}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Timezone": "America/Los_Angeles", Authorization: `Bearer ${token}` },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  ctx.step(`[device A: ${a.surface}] ${method} /api${path}${body !== undefined ? ` ${JSON.stringify(body).slice(0, 200)}` : ""} → ${res.status()}`);
  if (!res.ok()) throw new Error(`device A ${method} ${path} → ${res.status()} ${text.slice(0, 200)}`);
  return data;
}

scenario({
  id: "sync.other-device-reload-and-open",
  title: "A task, an expense and an event written on one device show on the other after a reload AND while it stays open: dashboard tiles, Timeline, Tasks, Finance month total, Calendar",
  area: "Sync across devices",
  browser: true,
  covers: ["task.create.api", "task.edit.api", "task.delete.api", "expense.create.api", "expense.edit.api", "expense.delete.api", "event.create.api", "event.edit.api", "event.delete.api"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const ui = ctx.ui!;
    for (const [A, B] of [[ui.desktop, ui.phone], [ui.phone, ui.desktop]] as const) {
      const L = (x: string) => `[A ${A.surface} → B ${B.surface}] ${x}`;
      const tag = `${ctx.tag} ${A.surface}2${B.surface}`;
      // Whole dollars: the dashboard's Money card and Finance's "Spend · MTD"
      // print rounded dollars ("$43" for 42.69), so a cents amount could not be
      // told apart from rounding on screen. The stored row is still read exactly.
      const amount = ctx.int(11, 49);
      const amount2 = amount + ctx.int(2, 9);

      // B has used the app: every screen's list is in its cache (and saved on reload)
      for (const [r, id] of [["/dashboard", "page-dashboard"], ["/tasks", "page-tasks"], ["/finance", "page-finance"], ["/calendar", ""]] as const) await goto(B, r, id);
      await goto(B, "/finance", "page-finance");
      const spend0 = await financeSpend(B);
      const before = await readB(B);
      ctx.step(L(`B before: Tasks Due ${before.tasksDue}, dashboard Expenses $${before.dashExpenses}, Finance Spend MTD $${spend0}`));
      if (!ctx.check("screen", Number.isFinite(before.tasksDue) && Number.isFinite(before.dashExpenses) && Number.isFinite(spend0), L("B's dashboard and Finance show their figures"), JSON.stringify({ before, spend0 }))) continue;
      await sleep(1500);

      // ── A writes while B sits on the dashboard; then B RELOADS ──
      const task = await fromA(ctx, A, "POST", "/tasks", { title: `${tag} call the plumber`, dueDate: ctx.today });
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      const exp = await fromA(ctx, A, "POST", "/expenses", { description: `${tag} hardware`, amount, date: ctx.today, category: "Shopping" });
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${exp.id}`));
      const ev = await fromA(ctx, A, "POST", "/events", { title: `${tag} dentist`, date: ctx.today, time: "23:30" });
      ctx.cleanup(() => ctx.api("DELETE", `/events/${ev.id}`));
      ctx.check("action", !!task?.id && !!exp?.id && !!ev?.id, L("device A created a task, an expense and an event"));
      const [tRow, eRow, vRow] = await Promise.all([ctx.db.row("tasks", task.id), ctx.db.row("expenses", exp.id), ctx.db.row("events", ev.id)]);
      ctx.check("db", tRow?.title === `${tag} call the plumber` && tRow?.due_date === ctx.today, L("the task row is stored, due today"), JSON.stringify(tRow && { t: tRow.title, d: tRow.due_date }));
      ctx.check("db", Math.abs(Number(eRow?.amount) - amount) < 0.005 && eRow?.date === ctx.today, L(`the expense row is stored: ${amount}, today`), JSON.stringify(eRow && { a: eRow.amount, d: eRow.date }));
      ctx.check("db", vRow?.title === `${tag} dentist` && String(vRow?.date).slice(0, 10) === ctx.today, L("the event row is stored, today"), JSON.stringify(vRow && { t: vRow.title, d: vRow.date }));

      ctx.step(L("B reloads the page (its saved snapshot predates A's writes)"));
      await B.page.reload();
      await B.page.waitForSelector(t("page-dashboard"), { timeout: 30000 });
      let after = before;
      const tilesOk = await until(async () => { after = await readB(B); return after.tasksDue === before.tasksDue + 1 && Math.abs(after.dashExpenses - (before.dashExpenses + amount)) < 0.005; }, 15000);
      ctx.check("derived", tilesOk, L(`after the reload, B's dashboard tiles moved by A's writes: Tasks Due ${before.tasksDue}→${before.tasksDue + 1}, Expenses +$${amount}`), JSON.stringify(after));
      if (!tilesOk) ctx.finding({ severity: "sync", title: "After a reload, a write made on another device is missing from the dashboard", detail: `${B.surface}: 15 s after reloading, Tasks Due ${after.tasksDue} (want ${before.tasksDue + 1}), Expenses $${after.dashExpenses} (want $${O.cents(before.dashExpenses + amount)})` });
      ctx.check("screen", await until(() => textShown(B, `${tag} call the plumber`), 8000), L("the dashboard lists A's task"));
      ctx.check("screen", await until(() => textShown(B, `${tag} dentist`), 8000), L("the dashboard Timeline lists A's event"));
      await goto(B, "/tasks", "page-tasks");
      ctx.check("screen", await until(() => vis(B, t(`card-task-${task.id}`)).isVisible(), 12000), L("Tasks lists A's task (in-app navigation after the reload)"));
      await goto(B, "/finance", "page-finance");
      let spend1 = NaN;
      ctx.check("derived", await until(async () => { spend1 = await financeSpend(B); return Math.abs(spend1 - (spend0 + amount)) < 0.005; }, 12000), L(`Finance's month spend rose by $${amount}: $${spend0} → $${O.cents(spend0 + amount)}`), `shows $${spend1}`);
      ctx.check("screen", await until(() => vis(B, t(`expense-${exp.id}`)).isVisible(), 12000), L("Finance lists A's expense"));
      await goto(B, "/calendar", "");
      ctx.check("screen", await until(() => textShown(B, `${tag} dentist`), 12000), L("the Calendar shows A's event"));

      // ── B STAYS OPEN on the dashboard; A edits ──
      await goto(B, "/dashboard", "page-dashboard");
      await sleep(1000);
      const mid = await readB(B);
      let reloads = 0;
      const onLoad = () => { reloads++; };
      B.page.on("load", onLoad);
      await fromA(ctx, A, "PATCH", `/tasks/${task.id}`, { title: `${tag} call the electrician` });
      await fromA(ctx, A, "PATCH", `/expenses/${exp.id}`, { amount: amount2 });
      await fromA(ctx, A, "PATCH", `/events/${ev.id}`, { title: `${tag} orthodontist` });
      ctx.check("db", (await ctx.db.row("tasks", task.id))?.title === `${tag} call the electrician`, L("the renamed task is stored"));
      ctx.near("db", (await ctx.db.row("expenses", exp.id))?.amount, amount2, L("the changed expense amount is stored"));
      ctx.check("db", (await ctx.db.row("events", ev.id))?.title === `${tag} orthodontist`, L("the renamed event is stored"));
      const t0 = Date.now();
      // I9: the open screen asks the server twice a minute; no tap, no navigation
      const renamedOpen = await until(async () => (await textShown(B, `${tag} call the electrician`)) && (await textShown(B, `${tag} orthodontist`)), 45000, 1000);
      ctx.step(L(`the open dashboard ${renamedOpen ? `caught up after ${Math.round((Date.now() - t0) / 1000)} s` : "did not catch up in 45 s"}`));
      ctx.check("screen", renamedOpen, L("the dashboard that stays open shows A's renamed task and event within 45 s (I9)"));
      let mid2 = mid;
      ctx.check("derived", await until(async () => { mid2 = await readB(B); return Math.abs(mid2.dashExpenses - (mid.dashExpenses - amount + amount2)) < 0.005 && mid2.tasksDue === mid.tasksDue; }, 15000),
        L(`the open dashboard's Expenses moved by the edit: +$${O.cents(amount2 - amount)}; Tasks Due unchanged`), JSON.stringify({ mid, mid2 }));
      await goto(B, "/tasks", "page-tasks");
      ctx.check("screen", await until(() => textShown(B, `${tag} call the electrician`), 12000), L("Tasks shows the new title"));
      await goto(B, "/finance", "page-finance");
      let spend2 = NaN;
      ctx.check("derived", await until(async () => { spend2 = await financeSpend(B); return Math.abs(spend2 - (spend0 + amount2)) < 0.005; }, 12000), L(`Finance's month spend is $${O.cents(spend0 + amount2)} after the edit`), `shows $${spend2}`);
      await goto(B, "/calendar", "");
      ctx.check("screen", await until(() => textShown(B, `${tag} orthodontist`), 12000), L("the Calendar shows the renamed event"));

      // ── A deletes; B (still open, no reload) navigates ──
      await fromA(ctx, A, "DELETE", `/tasks/${task.id}`);
      await fromA(ctx, A, "DELETE", `/expenses/${exp.id}`);
      await fromA(ctx, A, "DELETE", `/events/${ev.id}`);
      const tGone = await ctx.db.rows("tasks", `id=eq.${task.id}&deleted_at=is.null`);
      const eGone = await ctx.db.rows("expenses", `id=eq.${exp.id}&deleted_at=is.null`);
      const vGone = await ctx.db.rows("events", `id=eq.${ev.id}&deleted_at=is.null`);
      ctx.check("db", tGone.length === 0 && eGone.length === 0 && vGone.length === 0, L("the three rows are deleted (to Trash: deleted_at set)"), JSON.stringify([tGone.length, eGone.length, vGone.length]));
      let end = mid;
      ctx.check("derived", await until(async () => { end = await readB(B); return end.tasksDue === before.tasksDue && Math.abs(end.dashExpenses - before.dashExpenses) < 0.005; }, 15000),
        L(`after the deletes the dashboard is back to Tasks Due ${before.tasksDue}, Expenses $${before.dashExpenses}`), JSON.stringify(end));
      ctx.check("screen", await until(async () => !(await textShown(B, `${tag} call the electrician`)) && !(await textShown(B, `${tag} orthodontist`)), 10000), L("the dashboard no longer lists the task or the event"));
      await goto(B, "/tasks", "page-tasks");
      ctx.check("screen", await until(async () => !(await vis(B, t(`card-task-${task.id}`)).isVisible()), 12000), L("Tasks no longer lists the task"));
      await goto(B, "/finance", "page-finance");
      let spend3 = NaN;
      ctx.check("derived", await until(async () => { spend3 = await financeSpend(B); return Math.abs(spend3 - spend0) < 0.005; }, 12000), L(`Finance's month spend is back to $${spend0}`), `shows $${spend3}`);
      await goto(B, "/calendar", "");
      ctx.check("screen", await until(async () => !(await textShown(B, `${tag} orthodontist`)), 12000), L("the Calendar no longer shows the event"));
      B.page.off("load", onLoad);
      ctx.check("screen", reloads === 0, L("B never reloaded while it stayed open"), `${reloads} reload(s)`);

      // and a last reload keeps it so
      await B.page.reload();
      await B.page.waitForSelector("main", { timeout: 30000 });
      await sleep(2000);
      ctx.check("screen", !(await textShown(B, `${tag} orthodontist`)), L("after a final reload the deleted event stays gone"));
      const fin = await readB(B);
      ctx.check("derived", fin.tasksDue === before.tasksDue && Math.abs(fin.dashExpenses - before.dashExpenses) < 0.005, L("and the dashboard tiles stay where they started"), JSON.stringify(fin));
      const problems = [...A.problems(), ...B.problems()];
      ctx.check("screen", problems.length === 0, L("no script error and no 5xx on either device"), problems.join("; "));
    }
  },
});

scenario({
  id: "sync.double-submit-one-record",
  title: "A double press (desktop double click, phone double tap) on the goal form's Create and the Net worth sheet's Add asset stores one record each",
  area: "Sync across devices",
  browser: true,
  covers: ["goal.create.ui", "asset.create.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of [ctx.ui!.desktop, ctx.ui!.phone]) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const pressTwice = async (sel: string) => {
        const el = vis(s, sel);
        await el.waitFor({ timeout: 15000 });
        if (s.surface === "phone") { await el.tap().catch(() => undefined); await el.tap({ timeout: 300 }).catch(() => undefined); }
        else await el.dblclick().catch(() => undefined);
      };

      // ── Goal form ──
      const title = `${ctx.tag} ${s.surface} run 100 miles`;
      const gq = `title=eq.${enc(title)}&deleted_at=is.null`;
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/goals", "page-goals");
      await s.page.waitForSelector(`${t("btn-add-goal")}, ${t("btn-create-first-goal")}`, { timeout: 20000 });
      const add = (await s.page.locator(t("btn-add-goal")).locator("visible=true").count()) ? "btn-add-goal" : "btn-create-first-goal";
      await press(s, t(add));
      await vis(s, t("input-goal-title")).waitFor({ timeout: 10000 });
      await vis(s, t("input-goal-title")).fill(title);
      await vis(s, t("input-goal-target")).fill("100");
      await vis(s, t("input-goal-unit")).fill("miles");
      ctx.step(L(`#/goals → Add Goal: "${title}", 100 miles → ${s.surface === "phone" ? "double tap" : "double click"} Create`));
      await pressTwice(t("btn-save-goal"));
      await waitRows(ctx, "goals", gq, (r) => r.length >= 1);
      await sleep(2000);
      const goals = await ctx.db.rows("goals", gq);
      for (const g of goals) ctx.cleanup(() => ctx.api("DELETE", `/goals/${g.id}`));
      ctx.check("action", goals.length >= 1, L("the goal form saved"));
      const oneGoal = ctx.check("db", goals.length === 1 && Number(goals[0].target) === 100 && goals[0].unit === "miles", L("exactly one goal row, 100 miles (a double press of Create)"), `${goals.length} rows`);
      if (!oneGoal && goals.length > 1) ctx.finding({ severity: "bug", title: "A double press on the goal form's Create stores two goals", detail: `${goals.length} rows on ${s.surface}` });
      if (goals[0]) ctx.check("screen", await until(async () => (await s.page.locator(t(`goal-card-${goals[0].id}`)).locator("visible=true").count()) === 1, 12000), L("the goal list shows it once"));

      // ── Net worth sheet → Add asset ──
      const name = `${ctx.tag} ${s.surface} Kayak`;
      const value = ctx.int(200, 900) * 10 + ctx.int(0, 9);
      const snap = async () => {
        const f = must(await ctx.api("GET", "/dashboard-enhanced"), "dashboard-enhanced").financeSnapshot;
        if (!f || typeof f.totalAssetValue !== "number") throw new Error("financeSnapshot has no totals");
        return { assets: f.totalAssetValue as number, net: O.cents(f.totalAssetValue - f.totalLiabilities) };
      };
      await goto(s, "/dashboard", "page-dashboard");
      const before = await snap();
      await press(s, t("hub-kpi-networth"));
      // with assets listed the sheet's own row; with none, its empty state's button
      await sleep(800);
      if (await vis(s, t("button-entity-add")).isVisible().catch(() => false)) await press(s, t("button-entity-add"));
      else await tapIt(s, s.page.getByRole("dialog").getByRole("button", { name: /^add asset$/i }).locator("visible=true").first());
      await vis(s, t("dialog-add-asset")).waitFor({ timeout: 10000 });
      await vis(s, t("input-add-asset-name")).fill(name);
      await vis(s, t("input-add-asset-value")).fill(String(value));
      ctx.step(L(`Net worth → Add asset: "${name}", $${value} → ${s.surface === "phone" ? "double tap" : "double click"} Add`));
      await pressTwice(t("btn-add-asset-save"));
      await waitRows(ctx, "profiles", `name=eq.${enc(name)}`, (r) => r.length >= 1);
      await sleep(2000);
      const assets = await ctx.db.rows("profiles", `name=eq.${enc(name)}`);
      for (const a of assets) ctx.cleanup(() => ctx.api("DELETE", `/profiles/${a.id}`));
      ctx.check("action", assets.length >= 1, L("Add asset saved"));
      const oneAsset = ctx.check("db", assets.length === 1 && assets[0].type === "asset" && Number(assets[0].fields?.currentValue) === value, L(`exactly one asset row worth ${value} (a double press of Add)`), `${assets.length} rows`);
      if (!oneAsset && assets.length > 1) ctx.finding({ severity: "bug", title: "A double press on the Net worth sheet's Add asset stores two assets", detail: `${assets.length} rows on ${s.surface}` });
      const after = await snap();
      ctx.near("derived", O.cents(after.assets - before.assets), value, L("total assets rose by the asset's value once"));
      ctx.near("derived", O.cents(after.net - before.net), value, L("net worth rose by the same, once"));
      await s.page.keyboard.press("Escape"); await sleep(300); await s.page.keyboard.press("Escape"); await sleep(300);
      await goto(s, "/linked?tab=assets", "page-trackers");
      ctx.check("screen", await until(async () => (await s.page.getByText(name, { exact: false }).locator("visible=true").count()) === 1, 15000), L("the Assets list shows it once (in-app navigation)"));
      const problems = s.problems();
      ctx.check("screen", problems.length === 0, L("no script error and no 5xx"), problems.join("; "));
    }
  },
});
