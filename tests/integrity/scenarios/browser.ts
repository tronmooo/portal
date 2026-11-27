// The app itself, in a real browser, as a desktop mouse and as a phone with
// touch: what is typed into a form is in the database, and every screen that
// shows it does so without a page reload.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitRows(ctx: Ctx, table: string, query: string, want: (n: number) => boolean, ms = 12000): Promise<any[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await ctx.db.rows(table, query);
    if (want(rows.length) || Date.now() > until) return rows;
    await sleep(500);
  }
}
const goto = async (s: any, route: string, pageId: string) => {
  await s.page.evaluate((r: string) => { window.location.hash = `#${r}`; }, route);
  // not every page carries a page-* id: those are awaited by the address and the app's <main>
  if (pageId) await s.page.waitForSelector(t(pageId), { timeout: 30000 });
  else { await s.page.waitForFunction((r: string) => window.location.hash.startsWith(`#${r}`), route, { timeout: 15000 }); await s.page.waitForSelector("main", { timeout: 30000 }); }
};
const surfaces = (ctx: Ctx) => [ctx.ui!.desktop, ctx.ui!.phone];

scenario({
  id: "browser.task-form",
  title: "The task form (mouse and touch): saved once, on every screen without a reload, ticked off and stored",
  area: "Browser",
  browser: true,
  covers: ["task.create.ui", "task.complete.ui", "task.delete.ui"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} water plants`;
      const due = O.addDays(ctx.today, 4);
      await goto(s, "/tasks", "page-tasks");
      let reloads = 0;
      s.page.on("load", () => { reloads++; });
      ctx.step(L(`open #/tasks, press "New task", type the title "${title}" and the due date ${due}, press Save twice quickly`));
      await s.press(t("button-new-task"));
      await s.page.fill(t("input-task-title"), title);
      await s.page.fill(t("input-task-due-date"), due);
      // a fast double press of Save must still make one task
      const save = s.page.locator(t("button-submit-task")).locator("visible=true").first();
      await (s.surface === "phone" ? save.tap() : save.dblclick()).catch(() => undefined);
      if (s.surface === "phone") await save.tap({ timeout: 300 }).catch(() => undefined);
      const rows = await waitRows(ctx, "tasks", `title=eq.${encodeURIComponent(title)}&deleted_at=is.null`, (n) => n >= 1);
      await sleep(1500);
      const settled = await ctx.db.rows("tasks", `title=eq.${encodeURIComponent(title)}&deleted_at=is.null`);
      for (const r of settled) ctx.cleanup(() => ctx.api("DELETE", `/tasks/${r.id}`));
      const one = ctx.check("db", settled.length === 1 && settled[0].due_date === due, L(`one task row with the typed title and date (a double press of Save)`), `${settled.length} rows ${JSON.stringify(settled.map((r: any) => r.due_date))}`);
      if (!one && settled.length > 1) ctx.finding({ severity: "bug", title: "A double press of Save on the task form makes two tasks", detail: `${settled.length} rows on ${s.surface}` });
      const id = (settled[0] ?? rows[0])?.id;
      if (!id) { ctx.check("action", false, L("the form saved a task")); continue; }
      ctx.check("action", true, L("the form saved a task"));
      const card = s.page.locator(t(`card-task-${id}`)).first();
      const shown = await card.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      ctx.check("screen", shown, L("the task list shows the new task without a reload"));

      // another screen, reached inside the app
      await goto(s, "/calendar", "");
      const onCal = await s.page.getByText(title, { exact: false }).first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      ctx.check("screen", onCal, L(`the calendar shows it (due ${due}) without a reload`));
      await goto(s, "/dashboard", "page-dashboard");
      const onDash = await s.page.getByText(title, { exact: false }).first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
      ctx.check("screen", onDash, L("the dashboard shows it without a reload"));

      // tick it off
      ctx.step(L("open #/calendar, then #/dashboard (in-app links, no reload); back on #/tasks tick the task's checkbox; open #/dashboard again"));
      await goto(s, "/tasks", "page-tasks");
      await s.press(t(`checkbox-task-${id}`));
      const done = await waitRows(ctx, "tasks", `id=eq.${id}&status=eq.done`, (n) => n === 1);
      ctx.check("db", done.length === 1, L("ticking the box stores the task as done"));
      await goto(s, "/dashboard", "page-dashboard");
      // "Done means gone" (Rule 8): give the refetch ten seconds, then it is a failure, not a delay
      let stillOpen = true;
      const t0 = Date.now();
      while (Date.now() - t0 < 10_000) {
        stillOpen = await s.page.locator(`${t("exec-overview")} >> text=${title}`).first().isVisible().catch(() => false);
        if (!stillOpen) break;
        await sleep(500);
      }
      ctx.step(L(`the dashboard ${stillOpen ? "still listed the finished task after 10 s" : `dropped the finished task ${Date.now() - t0} ms after opening`}`));
      const gone = ctx.check("screen", !stillOpen, L("the dashboard no longer lists the finished task (within 10 s of opening it)"));
      if (!gone) ctx.finding({ severity: "sync", title: "A task ticked done on Tasks stays open on the dashboard", detail: `${s.surface}: the row is stored as done, but the dashboard opened right after (in-app navigation) kept it under Tasks "Remaining", Timeline and Next Important until the page was left. Intermittent (about one run in three on production and on the preview, 2026-11-27); the cause is not established.` });
      ctx.check("screen", reloads === 0, L("none of this reloaded the page"), `${reloads} reload(s)`);
      const over = await s.overflow();
      ctx.check("screen", over === "", L("nothing is wider than the screen"), over);
      const problems = s.problems();
      ctx.check("screen", problems.length === 0, L("no script error and no 5xx along the way"), problems.join("; "));
    }
  },
});

scenario({
  id: "browser.expense-form",
  title: "The expense form (mouse and touch): stored once, in Finance and in the month's total, without a reload",
  area: "Browser",
  browser: true,
  covers: ["expense.create.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const desc = `${ctx.tag} ${s.surface} bagel`;
      const amount = s.surface === "phone" ? 6.4 : 7.35;
      const snap0 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
      await goto(s, "/finance", "page-finance");
      await s.press(t("button-add-expense"));
      await s.page.fill(t("input-expense-description"), desc);
      await s.page.fill(t("input-expense-amount"), String(amount));
      const save = s.page.locator(t("button-save-expense")).locator("visible=true").first();
      await (s.surface === "phone" ? save.tap() : save.dblclick()).catch(() => undefined);
      await waitRows(ctx, "expenses", `description=eq.${encodeURIComponent(desc)}&deleted_at=is.null`, (n) => n >= 1);
      await sleep(1500);
      const rows = await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(desc)}&deleted_at=is.null`);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${r.id}`));
      const one = ctx.check("db", rows.length === 1 && Math.abs(Number(rows[0].amount) - amount) < 0.005 && rows[0].date === ctx.today, L(`one expense row of ${amount} dated today (a double press of Save)`), `${rows.length} rows ${JSON.stringify(rows.map((r: any) => [r.amount, r.date]))}`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "A double press of Save on the expense form makes two expenses", detail: `${rows.length} rows on ${s.surface}` });
      if (!rows[0]) { ctx.check("action", false, L("the form saved an expense")); continue; }
      ctx.check("action", true, L("the form saved an expense"));
      const shown = await s.page.locator(t(`expense-${rows[0].id}`)).first().waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
      ctx.check("screen", shown, L("Finance lists it without a reload"));
      const snap1 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
      ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), amount, L("this month's spending rose by the amount"));
      const problems = s.problems();
      ctx.check("screen", problems.length === 0, L("no script error and no 5xx"), problems.join("; "));
    }
  },
});

scenario({
  id: "browser.written-elsewhere",
  title: "A record written on another device appears here without a reload, and a reload never hides it",
  area: "Browser",
  browser: true,
  covers: ["task.create.api", "task.delete.api", "liabilityPayment.create.api"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      await goto(s, "/tasks", "page-tasks");
      await goto(s, "/dashboard", "page-dashboard");
      await sleep(1500); // every list this session has is now fresh in its cache
      let reloads = 0;
      const onLoad = () => { reloads++; };
      s.page.on("load", onLoad);

      // another device adds a task…
      const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} ${s.surface} written elsewhere`, dueDate: O.addDays(ctx.today, 2) }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      ctx.check("action", true, L("a task was created outside the open page"));
      ctx.check("db", (await ctx.db.row("tasks", task.id)) !== null, L("its row exists"));
      // …and opening Tasks from inside the app shows it (the app asks the server
      // where the account is on every navigation: lib/server-versions.ts)
      const t0 = Date.now();
      await goto(s, "/tasks", "page-tasks");
      const shown = await s.page.locator(t(`card-task-${task.id}`)).first().waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
      ctx.step(L(`in-app navigation ${shown ? `showed the task after ${Date.now() - t0} ms` : "did not show the task within 12 s"}`));
      const ok = ctx.check("screen", shown, L("opening Tasks (in-app, no reload) shows the task made on another device"));
      if (!ok) ctx.finding({ severity: "sync", title: "A record made on another device is not shown by in-app navigation", detail: `${s.surface}: the Tasks list kept its cached rows for 12 s after navigating to it` });

      // without navigating at all: the open screen catches up on its own (twice a minute)
      must(await ctx.api("PATCH", `/tasks/${task.id}`, { title: `${ctx.tag} ${s.surface} renamed elsewhere` }), "rename elsewhere");
      const t1 = Date.now();
      const renamed = await s.page.getByText(`${ctx.tag} ${s.surface} renamed elsewhere`).first().waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
      ctx.step(L(`the open list ${renamed ? `showed the new title after ${Math.round((Date.now() - t1) / 1000)} s` : "never showed the new title in 45 s"}`));
      const ok2 = ctx.check("screen", renamed, L("a change made elsewhere reaches the screen that is already open, within 45 s"));
      if (!ok2) ctx.finding({ severity: "sync", title: "A change made on another device never reaches a screen that stays open", detail: `${s.surface}: 45 s on the Tasks list without the renamed title` });

      // deleted elsewhere
      must(await ctx.api("DELETE", `/tasks/${task.id}`), "delete elsewhere");
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/tasks", "page-tasks");
      let still = true;
      for (let i = 0; i < 24 && still; i++) { still = await s.page.locator(t(`card-task-${task.id}`)).first().isVisible().catch(() => false); if (still) await sleep(500); }
      ctx.check("screen", !still, L("after it is deleted elsewhere, opening Tasks again no longer lists it"));
      ctx.check("screen", reloads === 0, L("none of this reloaded the page"), `${reloads} reload(s)`);
      s.page.off("load", onLoad);

      // a reload restores the saved snapshot first — it must not be taken for the truth (Rule 7)
      const second = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} ${s.surface} before a reload` }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${second.id}`));
      await s.page.reload();
      await s.page.waitForSelector(t("page-tasks"), { timeout: 30000 });
      const afterReload = await s.page.locator(t(`card-task-${second.id}`)).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
      ctx.check("screen", afterReload, L("after a reload a task made elsewhere is listed"));
      s.problems();
    }

    // The reported case: a payment recorded elsewhere while a loan's page is closed.
    const s = ctx.ui!.desktop;
    const loan = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "personal_loan", name: `${ctx.tag} Elsewhere Loan`, fields: { balance: 9000, monthlyPayment: 200, dueDay: 6, interestRate: 0, _interestRateUnit: "percent" } }), "loan");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${loan.id}?deleteHistory=1`));
    await goto(s, `/profiles/${loan.id}`, "");
    const header = async () => (await s.page.locator("body").innerText()).replace(/\s+/g, " ");
    await s.page.getByText("$9,000").first().waitFor({ timeout: 20000 }).catch(() => undefined);
    ctx.check("screen", (await header()).includes("$9,000"), "the loan's page shows its balance, $9,000");
    await goto(s, "/dashboard", "page-dashboard");
    must(await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 1500, paymentDate: ctx.today, paymentType: "extra_principal", idempotencyKey: `${ctx.tag}-elsewhere` }), "pay elsewhere");
    ctx.near("db", (await ctx.db.row("profiles", loan.id)).fields.balance, 7500, "the stored balance after a payment made elsewhere");
    await goto(s, `/profiles/${loan.id}`, "");
    const current = await s.page.getByText("$7,500").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    const ok3 = ctx.check("screen", current, "reopening the loan (in-app, no reload) shows the new balance, $7,500");
    if (!ok3) ctx.finding({ severity: "sync", title: "A payment recorded on another device leaves a reopened loan on its old balance", detail: `header still read ${((await header()).match(/\$[0-9,]+(\.\d\d)?/) || ["?"])[0]} 15 s after reopening` });
  },
});

scenario({
  id: "browser.offline",
  title: "With the network cut, a save is not reported as saved and nothing is stored; back online it saves once",
  area: "Network interruption",
  browser: true,
  covers: ["task.create.ui"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    const s = ctx.ui!.desktop;
    const title = `${ctx.tag} offline task`;
    await goto(s, "/tasks", "page-tasks");
    await s.press(t("button-new-task"));
    await s.page.fill(t("input-task-title"), title);
    await s.page.context().setOffline(true);
    try {
      await s.press(t("button-submit-task"));
      await sleep(4000);
      const q = `title=eq.${encodeURIComponent(title)}&deleted_at=is.null`;
      ctx.check("db", (await ctx.db.count("tasks", q)) === 0, "while offline, no task row is stored");
      const body = (await s.page.locator("body").innerText()).toLowerCase();
      const toldUser = /offline|couldn.t|could not|failed|try again|no connection|network|not saved|error/.test(body);
      const formStillOpen = await s.page.locator(t("input-task-title")).first().isVisible().catch(() => false);
      const ok = ctx.check("screen", toldUser || formStillOpen, "the app says the save did not go through (or keeps the form open with what was typed)", body.slice(0, 200));
      if (!ok) ctx.finding({ severity: "sync", title: "An offline save looks like it succeeded", detail: "the task form closed with no error while the network was cut, and nothing was stored" });
    } finally {
      await s.page.context().setOffline(false);
    }
    await sleep(1500);
    // back online: save (again if the form is still open, else type it anew)
    if (!(await s.page.locator(t("input-task-title")).first().isVisible().catch(() => false))) {
      await s.press(t("button-new-task"));
      await s.page.fill(t("input-task-title"), title);
    }
    await s.press(t("button-submit-task"));
    const rows = await waitRows(ctx, "tasks", `title=eq.${encodeURIComponent(title)}&deleted_at=is.null`, (n) => n >= 1, 15000);
    await sleep(2500);
    const settled = await ctx.db.rows("tasks", `title=eq.${encodeURIComponent(title)}&deleted_at=is.null`);
    for (const r of settled) ctx.cleanup(() => ctx.api("DELETE", `/tasks/${r.id}`));
    ctx.check("action", rows.length >= 1, "back online, the save goes through");
    const one = ctx.check("db", settled.length === 1, "and exactly one task row exists (the offline attempt was not replayed on top)", `${settled.length} rows`);
    if (!one && settled.length > 1) ctx.finding({ severity: "bug", title: "A save retried after reconnecting is stored twice", detail: `${settled.length} rows` });
    s.problems();
  },
});

const SCREENS: Array<[string, string]> = [
  ["/dashboard", "page-dashboard"], ["/finance", "page-finance"], ["/tasks", "page-tasks"], ["/calendar", "page-calendar"],
  ["/habits", "page-habits"], ["/journal", "page-journal"], ["/goals", "page-goals"], ["/wellness", "page-wellness"],
  ["/artifacts", "page-artifacts"], ["/linked?tab=assets", "page-trackers"], ["/linked?tab=liabilities", "page-trackers"],
  ["/obligations", "page-obligations"], ["/chat", "page-chat"], ["/details", "page-details"], ["/settings", "page-settings"],
];

scenario({
  id: "browser.screens",
  title: "Every main screen opens on desktop and phone: in time, with no error, and nothing wider than the screen",
  area: "Responsiveness & performance",
  browser: true,
  covers: ["screens.open"],
  requires: ["screen"],
  run: async (ctx) => {
    const BUDGET_MS = 4000;
    for (const s of surfaces(ctx)) {
      const slow: string[] = [], wide: string[] = [], broken: string[] = [], missing: string[] = [];
      s.problems();
      for (const [route, pageId] of SCREENS) {
        const t0 = Date.now();
        await s.page.evaluate((r: string) => { window.location.hash = `#${r}`; }, route);
        const found = await s.page.waitForSelector(`${t(pageId)}, main`, { timeout: 20000 }).then(() => true).catch(() => false);
        const ms = Date.now() - t0;
        if (!found) { missing.push(route); continue; }
        await s.page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
        const settledMs = Date.now() - t0;
        ctx.step(`[${s.surface}] ${route}: shown in ${ms} ms, settled in ${settledMs} ms`);
        if (ms > BUDGET_MS) slow.push(`${route} ${ms}ms`);
        const over = await s.overflow();
        if (over) wide.push(`${route}: ${over}`);
        const problems = s.problems();
        if (problems.length) broken.push(`${route}: ${problems.join("; ")}`);
      }
      ctx.check("screen", missing.length === 0, `[${s.surface}] all ${SCREENS.length} screens open`, missing.join(", "));
      ctx.check("screen", broken.length === 0, `[${s.surface}] no script error and no 5xx on any screen`, broken.join(" | "));
      const fits = ctx.check("screen", wide.length === 0, `[${s.surface}] no screen is wider than the window`, wide.join(" | "));
      if (!fits) ctx.finding({ severity: "bug", title: `Content wider than the ${s.surface} screen`, detail: wide.join(" | ") });
      const fast = ctx.check("perf", slow.length === 0, `[${s.surface}] every screen is shown within ${BUDGET_MS} ms of navigating to it`, slow.join(", "));
      if (!fast) ctx.finding({ severity: "perf", title: `Slow screens on ${s.surface}`, detail: slow.join(", ") });
    }
    void listOf;
  },
});
