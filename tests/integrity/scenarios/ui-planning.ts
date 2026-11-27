// Planning screens driven by hand — a desktop mouse and a phone with touch:
// tasks, calendar events (one-off and repeating), habits, goals and the
// dashboard's own controls. Each operation is then read three ways: the stored
// row straight from the database, the figure that depends on it against the
// oracle, and the OTHER screens that show it, reached inside the app without a
// page reload.
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";

const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const surfaces = (ctx: Ctx) => [ctx.ui!.desktop, ctx.ui!.phone];

// ── small helpers (copied from browser.ts, plus what these screens need) ─────
async function waitRows(ctx: Ctx, table: string, query: string, want: (n: number) => boolean, ms = 12000): Promise<any[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await ctx.db.rows(table, query);
    if (want(rows.length) || Date.now() > until) return rows;
    await sleep(400);
  }
}
/** The row once `want` holds — or as it stood when the time ran out. */
async function waitRow(ctx: Ctx, table: string, id: string, want: (row: any | null) => boolean, ms = 12000): Promise<any | null> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await ctx.db.row(table, id);
    if (want(row) || Date.now() > until) return row;
    await sleep(400);
  }
}
/** One preferences row by key (null when the account has none). */
async function prefRow(ctx: Ctx, key: string): Promise<any | null> {
  return (await ctx.db.rows("preferences", `key=eq.${enc(key)}`))[0] ?? null;
}
async function until(fn: () => Promise<boolean>, ms = 10000, every = 300): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() > end) return false;
    await sleep(every);
  }
}
const goto = async (s: any, route: string, pageId: string) => {
  await s.page.evaluate((r: string) => { window.location.hash = `#${r}`; }, route);
  if (pageId) await s.page.waitForSelector(t(pageId), { timeout: 30000 });
  else { await s.page.waitForFunction((r: string) => window.location.hash.startsWith(`#${r}`), route, { timeout: 15000 }); await s.page.waitForSelector("main", { timeout: 30000 }); }
};
/** A click on desktop, a tap on the phone. */
const hit = async (s: any, loc: any, timeout = 15000) => {
  const el = loc.locator("visible=true").first();
  await el.waitFor({ timeout });
  await (s.surface === "phone" ? el.tap() : el.click());
};
const visible = (s: any, sel: string, ms = 10000) =>
  s.page.locator(sel).locator("visible=true").first().waitFor({ timeout: ms }).then(() => true).catch(() => false);
const hidden = (s: any, sel: string, ms = 10000) =>
  until(async () => (await s.page.locator(sel).locator("visible=true").count()) === 0, ms);
/** The text is somewhere on the page (inside `scope` when given). */
const seen = (s: any, text: string, ms = 10000, scope = "body") =>
  s.page.locator(scope).getByText(text, { exact: false }).first().waitFor({ timeout: ms }).then(() => true).catch(() => false);
const unseen = (s: any, text: string, ms = 10000, scope = "body") =>
  until(async () => (await s.page.locator(scope).getByText(text, { exact: false }).locator("visible=true").count()) === 0, ms);
/** A native date/number/text input, typed the way a person leaves it: set, then left. */
const typeInto = async (s: any, sel: string, value: string) => {
  const el = s.page.locator(sel).locator("visible=true").first();
  await el.waitFor({ timeout: 15000 });
  await el.fill(value);
};
/** Count page loads from now on; `off()` stops counting and answers how many. */
function countReloads(s: any) {
  let n = 0;
  const on = () => { n++; };
  s.page.on("load", on);
  return () => { s.page.off("load", on); return n; };
}
/** The closing checks every surface owes. */
async function closing(ctx: Ctx, s: any, L: (x: string) => string, reloads: number) {
  ctx.check("screen", reloads === 0, L("none of this reloaded the page"), `${reloads} reload(s)`);
  // a sheet or dialog left open by a failed step must not hide the next surface's work
  await s.page.keyboard.press("Escape").catch(() => undefined);
  const over = await s.overflow();
  ctx.check("screen", over === "", L("nothing is wider than the screen"), over);
  const problems = s.problems();
  ctx.check("screen", problems.length === 0, L("no script error and no 5xx along the way"), problems.join("; "));
}

/** One finding per title in a scenario: the second surface adds its name, not a second entry. */
function finder(ctx: Ctx) {
  const told = new Set<string>();
  return (s: any, f: { severity: "bug" | "discrepancy" | "sync"; title: string; detail: string }) => {
    if (told.has(f.title)) return;
    told.add(f.title);
    ctx.finding({ ...f, detail: `Seen on ${s.surface} first. ${f.detail}` });
  };
}
/** The first whole number in an element's text (a tile's count), or NaN. */
const numberIn = async (s: any, sel: string): Promise<number> => {
  const txt = await s.page.locator(sel).first().innerText().catch(() => "");
  const m = /-?\d+/.exec(txt.replace(/,/g, ""));
  return m ? Number(m[0]) : NaN;
};
const wordsOf = async (s: any, sel: string): Promise<string> => (await s.page.locator(sel).first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();

// ── dates, written a second time (nothing here comes from the app) ──────────
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "Dec 2, 2026" */
const shortDate = (d: string) => { const p = O.parseYmd(d); return `${MON[p.m - 1]} ${p.d}, ${p.y}`; };
/** "Wed, Dec 2, 2026" */
const longDate = (d: string) => `${DOW[O.weekday(d)]}, ${shortDate(d)}`;

// ── the calendar ────────────────────────────────────────────────────────────
const lastCellPress = new WeakMap<object, number>();
/** On #/calendar: bring `date` into the month grid and make it the selected day. */
async function calDay(s: any, date: string) {
  await s.page.waitForSelector('[data-testid^="day-cell-"]', { timeout: 30000 });
  for (let i = 0; i < 14; i++) {
    const days: string[] = await s.page.evaluate(() => [...document.querySelectorAll('[data-testid^="day-cell-"]')].map((n) => (n.getAttribute("data-testid") || "").slice(9)).sort());
    if (days.includes(date)) break;
    // the month's own days, not the grey ones of its neighbours, decide the direction
    await s.press(t(date > days[days.length - 1] ? "btn-next-month" : date < days[0] ? "btn-prev-month" : "btn-next-month"));
    await sleep(350);
  }
  const cell = s.page.locator(t(`day-cell-${date}`)).first();
  await cell.waitFor({ timeout: 10000 });
  // a second press on the selected day opens the day view: press only when it is not selected
  if ((await cell.getAttribute("data-selected")) !== "true") {
    // Two presses on one day within half a second are a double click to the
    // browser (which opens "New Event" for that day) even with a trip to
    // another screen in between: a person does not do that, so neither do we.
    const gap = Date.now() - (lastCellPress.get(s) ?? 0);
    if (gap < 800) await sleep(800 - gap);
    await hit(s, cell);
    lastCellPress.set(s, Date.now());
  }
  await s.page.waitForFunction((d: string) => document.querySelector(`[data-testid="day-cell-${d}"]`)?.getAttribute("data-selected") === "true", date, { timeout: 8000 }).catch(() => undefined);
  await settleScroll(s);
}
/** Selecting a day on a phone glides the page down to that day's panel: a tap
 *  aimed while it is still moving lands on whatever slides under the finger. */
async function settleScroll(s: any) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const y: number = await s.page.evaluate(() => Math.round(window.scrollY + [...document.querySelectorAll("main, [data-testid='calendar-page']")].reduce((n, e) => n + (e as HTMLElement).scrollTop, 0)));
    if (y === last) return;
    last = y;
    await sleep(200);
  }
}
const agendaItem = (id: string) => `[data-testid="section-day-agenda"] [data-testid^="agenda-item-"][data-record-id="${id}"]`;
/** Whether the selected day's panel lists the record (waits up to `ms` for the wanted answer). */
async function onDay(s: any, date: string, id: string, want: boolean, ms = 10000): Promise<boolean> {
  await calDay(s, date);
  const ok = await until(async () => ((await s.page.locator(agendaItem(id)).count()) > 0) === want, ms);
  return ok ? want : !want;
}
/** Open the one detail screen for the record's occurrence on `date`. */
async function openDetail(s: any, date: string, id: string) {
  await calDay(s, date);
  await hit(s, s.page.locator(agendaItem(id)));
  await s.page.waitForSelector(t("calendar-item-detail"), { timeout: 15000 });
  await s.page.waitForSelector(`${t("cal-detail-title")}, ${t("cal-edit-screen")}`, { timeout: 15000 });
}
const closeDetail = async (s: any) => {
  if (await s.page.locator(t("cal-action-sheet-close")).locator("visible=true").count()) await s.press(t("cal-action-sheet-close")).catch(() => undefined);
  if (await s.page.locator(t("cal-edit-back")).locator("visible=true").count()) await s.press(t("cal-edit-back")).catch(() => undefined);
  if (await s.page.locator(t("cal-close")).locator("visible=true").count()) await s.press(t("cal-close")).catch(() => undefined);
  await hidden(s, t("calendar-item-detail"), 5000);
};
/** The dates the open detail lists as coming up (its own rows, in order). */
const listedDates = (s: any, list: string): Promise<string[]> =>
  s.page.evaluate((sel: string) => [...document.querySelectorAll(`${sel} [data-testid^="cal-occ-"]`)].map((n) => (n.getAttribute("data-testid") || "").slice(8)), t(list));
/** Open the "+ event" form on either layout. */
async function openEventForm(s: any) {
  if (await s.page.locator(t("btn-add-event-cal")).locator("visible=true").count()) await s.press(t("btn-add-event-cal"));
  else { await s.press(t("btn-calendar-options")); await s.press(t("menu-add-event")); }
  await s.page.waitForSelector(t("dialog-add-event"), { timeout: 10000 });
}

// ════════════════════════════════════════════════════════════════════════════
// A one-off calendar event
// ════════════════════════════════════════════════════════════════════════════
scenario({
  id: "ui-planning.event",
  title: "A calendar event by hand (mouse and touch): made, renamed, moved and deleted — stored each time, and on the Calendar and the dashboard without a reload",
  area: "Browser · planning",
  browser: true,
  covers: ["event.create.ui", "event.edit.ui", "event.reschedule.ui", "event.delete.ui"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} dentist`;
      const renamed = `${ctx.tag} ${s.surface} orthodontist`;
      const d1 = O.addDays(ctx.today, 5), d2 = O.addDays(ctx.today, 8), d3 = O.addDays(ctx.today, 11);
      const q = `title=ilike.*${enc(`${ctx.tag} ${s.surface}`)}*`;
      await goto(s, "/calendar", "calendar-view");
      const reloads = countReloads(s);

      // ── Cancel writes nothing ──
      ctx.step(L(`open #/calendar, press "+ event", type "${title}", press Cancel`));
      await openEventForm(s);
      await typeInto(s, t("input-event-title"), title);
      await hit(s, s.page.locator(t("dialog-add-event")).getByRole("button", { name: /^cancel$/i }));
      await hidden(s, t("dialog-add-event"));
      await sleep(1200);
      ctx.check("db", (await ctx.db.count("events", q)) === 0, L("Cancel on the new-event form stores nothing"));

      // ── Create ──
      ctx.step(L(`press "+ event" again, type the title and the date ${d1}, press Create twice quickly`));
      await openEventForm(s);
      await typeInto(s, t("input-event-title"), title);
      await typeInto(s, t("input-event-date"), d1);
      const save = s.page.locator(t("btn-save-event")).locator("visible=true").first();
      await (s.surface === "phone" ? save.tap() : save.dblclick()).catch(() => undefined);
      if (s.surface === "phone") await save.tap({ timeout: 300 }).catch(() => undefined);
      await waitRows(ctx, "events", q, (n) => n >= 1);
      await sleep(1500);
      // The form closes on the first press, so the second press of a double
      // click lands on whatever is underneath it — on desktop a day of the
      // month grid, whose double-click handler opens a NEW empty event form.
      if (await s.page.locator(t("dialog-add-event")).locator("visible=true").count()) {
        ctx.finding({ severity: "discrepancy", title: "A double click on Create Event reopens an empty New Event form", detail: `${s.surface}: the form closes on the first click; the second click of the same double click falls through to the month grid underneath, whose double-click opens "New Event" for that day (${await s.page.locator(t("input-event-date")).first().inputValue().catch(() => "?")}). Nothing is stored twice, but the user is left in a form they did not ask for.` });
        ctx.step(L("the double click left a second, empty New Event form open (for the day under the button); pressed Cancel"));
        await hit(s, s.page.locator(t("dialog-add-event")).getByRole("button", { name: /^cancel$/i }));
        await hidden(s, t("dialog-add-event"));
      }
      const made = await ctx.db.rows("events", q);
      for (const r of made) ctx.cleanup(() => ctx.api("DELETE", `/events/${r.id}`));
      const one = ctx.check("db", made.length === 1 && made[0].title === title && made[0].date === d1 && (made[0].recurrence || "none") === "none",
        L(`one event row: the typed title, dated ${d1}, not repeating (a double press of Create)`), `${made.length} rows ${JSON.stringify(made.map((r: any) => [r.title, r.date, r.recurrence]))}`);
      if (!one && made.length > 1) ctx.finding({ severity: "bug", title: "A double press of Create on the event form makes two events", detail: `${made.length} rows on ${s.surface}` });
      const id = made[0]?.id;
      if (!ctx.check("action", !!id, L("the form saved an event")) || !id) { await closing(ctx, s, L, reloads()); continue; }
      ctx.check("screen", await onDay(s, d1, id, true), L(`the Calendar lists it on ${d1} without a reload`));
      await goto(s, "/dashboard", "page-dashboard");
      ctx.check("screen", await seen(s, title, 12000, t("executive-briefing")), L("the dashboard (Timeline / Next Important) names it without a reload"));

      // ── Edit: Back without Save writes nothing; Save writes the name ──
      ctx.step(L(`on #/calendar open the event on ${d1}, More → Edit, change the title, press Back (no Save)`));
      await goto(s, "/calendar", "calendar-view");
      await openDetail(s, d1, id);
      const before = await ctx.db.row("events", id);
      await s.press(t("cal-action-more"));
      await s.press(t("cal-more-edit"));
      await typeInto(s, t("cal-edit-title"), renamed);
      await s.press(t("cal-edit-back"));
      await sleep(1200);
      const afterBack = await ctx.db.row("events", id);
      ctx.check("db", afterBack?.title === title && afterBack?.updated_at === before?.updated_at, L("leaving the edit screen with Back writes nothing"), JSON.stringify([afterBack?.title, afterBack?.updated_at, before?.updated_at]));

      ctx.step(L(`More → Edit again, change the title to "${renamed}" and the date to ${d2}, press Save`));
      await s.press(t("cal-action-more"));
      await s.press(t("cal-more-edit"));
      await typeInto(s, t("cal-edit-title"), renamed);
      await typeInto(s, t("cal-edit-date"), d2);
      await s.page.locator(t("cal-edit-date")).first().blur().catch(() => undefined);
      await s.press(t("cal-edit-save"));
      const edited = await waitRow(ctx, "events", id, (r) => r?.title === renamed && r?.date === d2);
      ctx.check("db", edited?.title === renamed && edited?.date === d2, L(`the row holds the new title and ${d2}`), JSON.stringify([edited?.title, edited?.date]));
      ctx.check("db", (edited?.recurrence || "none") === "none" && JSON.stringify(edited?.linked_profiles) === JSON.stringify(before?.linked_profiles), L("and nothing that was not edited changed (repeat, owner)"), JSON.stringify([edited?.recurrence, edited?.linked_profiles]));
      // Rule 6: the open detail renders the live row, not the snapshot from the tap
      const liveDetail = await until(async () => {
        const txt = await s.page.locator(t("calendar-item-detail")).innerText();
        return txt.includes(renamed) && txt.includes(shortDate(d2)) && !txt.includes(shortDate(d1));
      }, 10000);
      const okLive = ctx.check("screen", liveDetail, L(`the open detail now reads "${renamed}" on ${shortDate(d2)} (not the date it was tapped on)`), (await s.page.locator(t("calendar-item-detail")).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
      if (!okLive) ctx.finding({ severity: "sync", title: "An event's open detail keeps the old title or date after an edit", detail: `${s.surface}: saved "${renamed}" on ${d2}; the sheet did not show both within 10 s (Rule 6: the open detail renders the live row)` });
      await closeDetail(s);
      ctx.check("screen", await onDay(s, d2, id, true), L(`the Calendar lists it on ${d2}`));
      ctx.check("screen", !(await onDay(s, d1, id, false)), L(`and no longer on ${d1}`));
      await goto(s, "/dashboard", "page-dashboard");
      ctx.check("screen", await seen(s, renamed, 12000, t("executive-briefing")), L("the dashboard names it by its new title without a reload"));
      ctx.check("screen", await unseen(s, title, 8000, t("executive-briefing")), L("and no longer by the old one"));

      // ── Reschedule: "Change date" on the one date ──
      ctx.step(L(`on #/calendar open it on ${d2}, press its date under Upcoming, "Change date", choose ${d3}, press "Change date"`));
      await goto(s, "/calendar", "calendar-view");
      await openDetail(s, d2, id);
      await s.press(t(`cal-occ-${d2}`));
      await s.press(t("cal-menu-move"));
      await typeInto(s, t("cal-move-date"), d3);
      await s.press(t("cal-move-confirm"));
      const moved = await waitRow(ctx, "events", id, (r) => r?.date === d3);
      ctx.check("db", moved?.date === d3 && moved?.title === renamed, L(`the row is dated ${d3}`), JSON.stringify([moved?.title, moved?.date]));
      await closeDetail(s);
      ctx.check("screen", await onDay(s, d3, id, true), L(`the Calendar lists it on ${d3}`));
      ctx.check("screen", !(await onDay(s, d2, id, false)), L(`and no longer on ${d2}`));

      // ── Delete: two taps ──
      ctx.step(L(`open it on ${d3}, More → Delete (first tap arms), tap again`));
      await openDetail(s, d3, id);
      await s.press(t("cal-action-more"));
      await s.press(t("cal-action-deleteSeries"));
      await sleep(1200);
      const armed = await ctx.db.row("events", id);
      const asks = ctx.check("db", !!armed && armed.deleted_at == null, L("the first tap on Delete only arms it: the row is still there"));
      if (!asks) ctx.finding({ severity: "bug", title: "An event is deleted by the first tap on Delete", detail: `${s.surface}: Rule 8 — destructive buttons take two taps` });
      else await s.press(t("cal-action-deleteSeries"));
      const goneRow = await waitRow(ctx, "events", id, (r) => !r || r.deleted_at != null);
      ctx.check("db", !goneRow || goneRow.deleted_at != null, L("the second tap deletes the row"));
      await hidden(s, t("calendar-item-detail"), 8000);
      ctx.check("screen", !(await onDay(s, d3, id, false)), L("the Calendar no longer lists it"));
      await goto(s, "/dashboard", "page-dashboard");
      ctx.check("screen", await unseen(s, renamed, 10000, t("executive-briefing")), L("the dashboard no longer names it (done means gone)"));
      await closing(ctx, s, L, reloads());
    }
  },
});

// ════════════════════════════════════════════════════════════════════════════
// A repeating event: one date at a time, and the series keeps its schedule
// ════════════════════════════════════════════════════════════════════════════
/** The open detail's full list of coming dates: [date, the row's words]. */
const listedRows = (s: any): Promise<Array<[string, string]>> =>
  s.page.evaluate((sel: string) => [...document.querySelectorAll(`${sel} [data-testid^="cal-occ-"]`)].map((n) => [(n.getAttribute("data-testid") || "").slice(8), ((n as HTMLElement).innerText || "").replace(/\s+/g, " ")]), t("cal-detail-occurrences"));
/** From the detail's first screen (or its list) to the full list of dates. */
async function showAllDates(s: any) {
  if (await s.page.locator(t("cal-tab-occurrences")).locator("visible=true").count()) await s.press(t("cal-tab-occurrences"));
  else await s.press(t("cal-view-all"));
  await s.page.waitForSelector(t("cal-detail-occurrences"), { timeout: 10000 });
}
/** Wait until the list's scheduled (not skipped) dates are exactly `want`; answer what it showed. */
async function scheduledDates(s: any, want: string[]): Promise<{ ok: boolean; got: string[]; all: Array<[string, string]> }> {
  let all: Array<[string, string]> = [], got: string[] = [];
  const ok = await until(async () => {
    all = await listedRows(s);
    got = all.filter(([, words]) => !/skipped|done|completed/i.test(words)).map(([d]) => d);
    const last = all.length ? all[all.length - 1][0] : "";
    const expected = want.filter((d) => d <= last);
    return all.length > 3 && JSON.stringify(got) === JSON.stringify(expected);
  }, 10000);
  return { ok, got, all };
}

scenario({
  id: "ui-planning.recurring-event",
  title: "A weekly event by hand (mouse and touch): the series is moved, one date skipped, one date moved, paused and ended — every later date stays where the schedule puts it",
  area: "Browser · planning",
  browser: true,
  covers: ["event.create.ui", "event.reschedule.ui", "event.cancel.ui", "event.complete.ui", "event.archive.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} choir`;
      const a = O.addDays(ctx.today, 3);            // where the series is first put
      const b = O.addDays(a, 1);                    // where the whole series is moved to
      const horizon = O.addDays(ctx.today, 420);
      const weekly = (anchor: string, skip: string[] = []) => O.occurrencesBetween(anchor, "weekly", ctx.today, horizon, skip);
      const q = `title=eq.${enc(title)}`;
      await goto(s, "/calendar", "calendar-view");
      const reloads = countReloads(s);

      // ── Create the series ──
      ctx.step(L(`open #/calendar, "+ event": title "${title}", date ${a}, Repeat → Weekly, Create`));
      await openEventForm(s);
      await typeInto(s, t("input-event-title"), title);
      await typeInto(s, t("input-event-date"), a);
      await s.press(t("select-event-recurrence"));
      await s.press(t("recurrence-option-weekly"));
      await s.press(t("btn-save-event"));
      await waitRows(ctx, "events", q, (n) => n >= 1);
      await sleep(1200);
      const made = await ctx.db.rows("events", q);
      for (const r of made) ctx.cleanup(() => ctx.api("DELETE", `/events/${r.id}`));
      ctx.check("db", made.length === 1 && made[0].date === a && made[0].recurrence === "weekly" && made[0].recurrence_end == null,
        L(`one event row dated ${a}, repeating weekly, with no end`), JSON.stringify(made.map((r: any) => [r.date, r.recurrence, r.recurrence_end])));
      const id = made[0]?.id;
      if (!ctx.check("action", !!id, L("the form saved a weekly event")) || !id) { await closing(ctx, s, L, reloads()); continue; }
      const row = () => ctx.db.row("events", id);
      const tagsOf = (r: any): string[] => (Array.isArray(r?.tags) ? r.tags : []);

      await openDetail(s, a, id);
      await showAllDates(s);
      let list = await scheduledDates(s, weekly(a));
      ctx.check("derived", list.ok, L(`the detail lists every week from ${a} — the dates a weekly rule gives`), `listed ${list.got.slice(0, 6).join(", ")}… wanted ${weekly(a).slice(0, 6).join(", ")}…`);
      await closeDetail(s);
      ctx.check("screen", await onDay(s, O.addDays(a, 7), id, true), L(`the Calendar shows the second week (${O.addDays(a, 7)}) without a reload`));

      // ── Move the SERIES: Edit series → a new first date ──
      ctx.step(L(`open the date ${a}, More → "Edit series", change "Series starts" to ${b}, Save`));
      await openDetail(s, a, id);
      await s.press(t("cal-action-more"));
      await s.press(t("cal-more-edit"));
      const saysEvery = await visible(s, t("cal-edit-scope"), 5000);
      ctx.check("screen", saysEvery, L("the editor says its changes apply to every date in the series (O4)"));
      await typeInto(s, t("cal-edit-date"), b);
      await s.page.locator(t("cal-edit-date")).first().blur().catch(() => undefined);
      await s.press(t("cal-edit-save"));
      const movedSeries = await waitRow(ctx, "events", id, (r) => r?.date === b);
      ctx.check("db", movedSeries?.date === b && movedSeries?.recurrence === "weekly" && movedSeries?.title === title, L(`the row is dated ${b} and still weekly`), JSON.stringify([movedSeries?.date, movedSeries?.recurrence]));
      await closeDetail(s);
      ctx.check("screen", await onDay(s, O.addDays(b, 7), id, true), L(`the Calendar now shows it on ${O.addDays(b, 7)}`));
      ctx.check("screen", !(await onDay(s, O.addDays(a, 7), id, false)), L(`and no longer on ${O.addDays(a, 7)}`));
      await openDetail(s, b, id);
      const nextSays = await until(async () => (await s.page.locator(t("cal-detail-next")).innerText()).includes(longDate(b)), 8000);
      ctx.check("screen", nextSays, L(`the detail's Next Occurrence reads ${longDate(b)}`), (await s.page.locator(t("cal-detail-next")).innerText().catch(() => "")).replace(/\s+/g, " "));
      await showAllDates(s);
      list = await scheduledDates(s, weekly(b));
      ctx.check("derived", list.ok, L(`and it lists every week from ${b}`), `listed ${list.got.slice(0, 6).join(", ")}…`);

      // ── Skip ONE date ──
      const skipDay = O.addDays(b, 7), moveFrom = O.addDays(b, 14), moveTo = O.addDays(b, 16), after = O.addDays(b, 21);
      ctx.step(L(`in the list press ${skipDay}, "Skip this occurrence"`));
      await s.press(t(`cal-occ-${skipDay}`));
      const onlyThis = await visible(s, t("cal-action-sheet-scope"), 5000);
      ctx.check("screen", onlyThis, L(`the action list for that date says "Only this date"`));
      await s.press(t("cal-menu-skip"));
      const skipped = await waitRow(ctx, "events", id, (r) => tagsOf(r).includes(`rd:skip:${skipDay}`));
      ctx.check("db", tagsOf(skipped).includes(`rd:skip:${skipDay}`) && skipped?.date === b && skipped?.recurrence === "weekly" && skipped?.recurrence_end == null && skipped?.deleted_at == null,
        L(`the skip is a mark on the row (rd:skip:${skipDay}); its date, rule and end are untouched (O1)`), JSON.stringify([skipped?.date, skipped?.recurrence, skipped?.recurrence_end, tagsOf(skipped)]));
      list = await scheduledDates(s, weekly(b, [skipDay]));
      const laterStay = ctx.check("derived", list.ok, L(`the list steps over ${skipDay} and keeps every later week`), `listed ${list.got.slice(0, 6).join(", ")}… wanted ${weekly(b, [skipDay]).slice(0, 6).join(", ")}…`);
      if (!laterStay) ctx.finding({ severity: "bug", title: "Skipping one date of a weekly event changes other dates", detail: `${s.surface}: after skipping ${skipDay} the detail listed ${list.got.slice(0, 8).join(", ")}` });

      // ── Move ONE date ──
      ctx.step(L(`press ${moveFrom}, "Change date", choose ${moveTo}, "Change date"`));
      await s.press(t(`cal-occ-${moveFrom}`));
      await s.press(t("cal-menu-move"));
      await typeInto(s, t("cal-move-date"), moveTo);
      await s.press(t("cal-move-confirm"));
      const others = await waitRows(ctx, "events", `${q}&id=neq.${id}`, (n) => n >= 1);
      for (const r of others) ctx.cleanup(() => ctx.api("DELETE", `/events/${r.id}`));
      const afterMove = await waitRow(ctx, "events", id, (r) => tagsOf(r).includes(`rd:skip:${moveFrom}`));
      const kept = ctx.check("db", afterMove?.date === b && afterMove?.recurrence === "weekly" && afterMove?.recurrence_end == null && tagsOf(afterMove).includes(`rd:skip:${skipDay}`) && tagsOf(afterMove).includes(`rd:skip:${moveFrom}`),
        L(`moving one date leaves the series anchored on ${b} (its slot ${moveFrom} is marked, the earlier skip is kept)`), JSON.stringify([afterMove?.date, afterMove?.recurrence, tagsOf(afterMove)]));
      if (!kept && afterMove?.date !== b) ctx.finding({ severity: "bug", title: "Moving one occurrence of a weekly event re-anchors the series", detail: `${s.surface}: series date became ${afterMove?.date} (was ${b}) — O2` });
      ctx.check("db", others.length === 1 && others[0].date === moveTo && (others[0].recurrence || "none") === "none",
        L(`and that one occurrence is stored once, on ${moveTo}, not repeating`), JSON.stringify(others.map((r: any) => [r.date, r.recurrence])));
      list = await scheduledDates(s, weekly(b, [skipDay, moveFrom]));
      ctx.check("derived", list.ok, L(`the series' own list keeps ${after} and every week after it`), `listed ${list.got.slice(0, 6).join(", ")}… wanted ${weekly(b, [skipDay, moveFrom]).slice(0, 6).join(", ")}…`);
      await closeDetail(s);
      ctx.check("screen", !(await onDay(s, skipDay, id, false)), L(`the Calendar shows nothing of it on the skipped ${skipDay}`));
      ctx.check("screen", !(await onDay(s, moveFrom, id, false)), L(`nor on ${moveFrom}, the date that was moved away`));
      if (others[0]) ctx.check("screen", await onDay(s, moveTo, others[0].id, true), L(`it shows the moved occurrence on ${moveTo}`));
      ctx.check("screen", await onDay(s, after, id, true), L(`and the next week, ${after}, is where it always was`));
      await goto(s, "/dashboard", "page-dashboard");
      ctx.check("screen", await seen(s, title, 12000, t("executive-briefing")), L("the dashboard names the series' next date without a reload"));

      // ── Archive, first way: Pause (two taps) ──
      ctx.step(L(`on #/calendar open ${b}, More → Edit series → Advanced → "Pause series" (first tap arms), tap again`));
      await goto(s, "/calendar", "calendar-view");
      await openDetail(s, b, id);
      await s.press(t("cal-action-more"));
      await s.press(t("cal-more-edit"));
      await s.press(t("cal-edit-tab-advanced"));
      await s.press(t("cal-edit-pause"));
      await sleep(1000);
      ctx.check("db", !tagsOf(await row()).includes("rd:paused"), L("the first tap on Pause only arms it (Rule 8)"));
      await s.press(t("cal-edit-pause"));
      const paused = await waitRow(ctx, "events", id, (r) => tagsOf(r).includes("rd:paused"));
      ctx.check("db", tagsOf(paused).includes("rd:paused") && paused?.deleted_at == null && paused?.date === b && paused?.recurrence === "weekly" && tagsOf(paused).includes(`rd:skip:${skipDay}`),
        L("pausing is a mark on the row: nothing is deleted, the rule and the skips stay"), JSON.stringify([paused?.deleted_at, paused?.date, paused?.recurrence, tagsOf(paused)]));
      await hidden(s, t("calendar-item-detail"), 8000);
      ctx.check("screen", !(await onDay(s, b, id, false)), L(`a paused series is off the Calendar (${b})`));
      ctx.check("screen", !(await onDay(s, after, id, false)), L(`and off ${after} too`));
      // The Recurring tab still names it, and says how to get it back.
      await s.press(t("calendar-tab-recurring"));
      const card = t(`rule-card-event:${id}`);
      const listedPaused = await visible(s, card, 12000);
      ctx.check("screen", listedPaused, L("Recurring & Important still lists the paused series (hidden is not deleted)"));
      const cardWords = listedPaused ? (await s.page.locator(card).first().innerText()).replace(/\s+/g, " ") : "";
      ctx.check("screen", /paused/i.test(cardWords), L("and says it is paused"), cardWords.slice(0, 160));
      // …so there must be a way to resume it from a screen.
      let resumeOffered = false;
      const where: string[] = [];
      if (listedPaused) {
        await s.press(t(`rule-menu-event:${id}`));
        const menu = s.page.locator('[role="menu"]').first();
        await menu.waitFor({ timeout: 5000 }).catch(() => undefined);
        const menuWords = (await menu.innerText().catch(() => "")).replace(/\s+/g, " ");
        where.push(`the card's menu: ${menuWords}`);
        const resume = s.page.getByRole("menuitem", { name: /resume/i }).first();
        if (await resume.count()) {
          resumeOffered = true;
          await hit(s, resume);
        } else await s.page.keyboard.press("Escape");
        if (!resumeOffered) {
          await sleep(300);
          await s.press(t(`rule-open-event:${id}`)).catch(() => undefined);
          const opened = await visible(s, t("calendar-item-detail"), 6000);
          if (opened) {
            const sheet = s.page.locator(t("calendar-item-detail"));
            let words = (await sheet.innerText()).replace(/\s+/g, " ");
            if (await s.page.locator(t("cal-action-more")).locator("visible=true").count()) {
              await s.press(t("cal-action-more"));
              await sleep(300);
              words += " | More: " + (await sheet.innerText()).replace(/\s+/g, " ");
              if (await s.page.locator(t("cal-more-edit")).locator("visible=true").count()) {
                await s.press(t("cal-more-edit"));
                await s.press(t("cal-edit-tab-advanced")).catch(() => undefined);
                await sleep(300);
                const adv = (await sheet.innerText()).replace(/\s+/g, " ");
                words += " | Advanced: " + adv;
                const btn = sheet.getByRole("button", { name: /resume/i }).first();
                if (await btn.count()) { resumeOffered = true; await hit(s, btn); await sleep(400); if (await btn.count()) await hit(s, btn).catch(() => undefined); }
              }
            }
            where.push(`its detail: ${/resume/i.test(words) ? "mentions resume" : "no Resume control"} (${words.slice(-260)})`);
            await closeDetail(s);
          } else where.push("its detail did not open");
        }
      }
      const canResume = ctx.check("screen", resumeOffered, L("a paused series can be resumed from a screen (the card says \"resume to schedule dates\")"), where.join(" · ").slice(0, 700));
      if (!canResume) {
        ctx.finding({ severity: "bug", title: "A paused series cannot be resumed from any screen", detail: `${s.surface}: Calendar → a date → More → Edit series → Advanced → "Pause series" stores rd:paused and takes every date off the Calendar. Recurring & Important then lists it as "Paused — resume to schedule dates", but that card's menu has no Resume, and its "Open details" and "Edit" do nothing for a paused series (no sheet opens), so the editor cannot be reached either (the only component with a Resume item, RecurringDatesManager, is not mounted). The pause toast says "until you resume it". Looked in: ${where.join(" · ").slice(0, 500)}` });
        ctx.step(L("no Resume control found; resumed it through the API to go on (POST /events/:id/series-flag {flag:\"paused\",on:false})"));
        must(await ctx.api("POST", `/events/${id}/series-flag`, { flag: "paused", on: false }), "resume");
      }
      const resumed = await waitRow(ctx, "events", id, (r) => !tagsOf(r).includes("rd:paused"));
      ctx.check("db", !tagsOf(resumed).includes("rd:paused") && tagsOf(resumed).includes(`rd:skip:${skipDay}`), L("resumed: the pause mark is gone and the skips are still there"), JSON.stringify(tagsOf(resumed)));

      // ── Archive, second way: End series (two taps) ──
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/calendar", "calendar-view");
      const back = await onDay(s, b, id, true, 15000);
      ctx.check("screen", back, L(`resumed, the series is on the Calendar again (${b}) without a reload`));
      if (back) {
        const endSeries = async () => {
          await showAllDates(s);
          await s.press(t("cal-tab-options"));
          await s.press(t("cal-action-deleteFuture"));
          await sleep(900);
          const armedOnly = (await row())?.recurrence_end == null;
          await s.press(t("cal-action-deleteFuture")).catch(() => undefined);
          return armedOnly;
        };
        // While the series' FIRST date is still the next one, "End series" is on
        // the screen ("Stops before <first date>"). An action that is offered
        // must do something (O4).
        ctx.step(L(`open ${b} (still the first and next date), View All → Options → "End series", tap again`));
        await openDetail(s, b, id);
        const offeredEarly = await (async () => { await showAllDates(s); await s.press(t("cal-tab-options")); return visible(s, t("cal-action-deleteFuture"), 3000); })();
        let endedEarly = false;
        if (offeredEarly) {
          await s.press(t("cal-action-deleteFuture"));
          await sleep(900);
          await s.press(t("cal-action-deleteFuture")).catch(() => undefined);
          const r = await waitRow(ctx, "events", id, (x) => !x || x.deleted_at != null || !!x.recurrence_end, 6000);
          endedEarly = !r || r.deleted_at != null || !!r.recurrence_end;
          const toast = (await s.page.locator("li[data-state='open'], [role='status']").allInnerTexts().catch(() => [] as string[])).join(" ").replace(/\s+/g, " ");
          const works = ctx.check("action", endedEarly, L(`"End series", offered while the next date is the series' first, ends it`), `the row is unchanged (recurrence_end ${JSON.stringify(r?.recurrence_end)}); the screen said: ${toast.slice(0, 220)}`);
          if (!works) ctx.finding({ severity: "bug", title: "\"End series\" is offered on a series that has not started, and always fails", detail: `${s.surface}: a weekly event whose first date (${b}) is still ahead. Detail → View All → Options → "End series — Stops before ${shortDate(b)}" → tap again: PATCH /api/events/:id {recurrenceEnd: ${O.addDays(b, -1)}} answers 400 "A repeating event cannot stop before its first occurrence" and a red toast "Couldn't complete that". Nothing is stored. The control is on the screen for an action that cannot apply (O4); the same is offered in the More menu. Screen said: ${toast.slice(0, 200)}` });
        }
        await closeDetail(s);

        if (!endedEarly) {
          // Check the first date off, so the next date is a later one, then end the series there.
          ctx.step(L(`open ${b}, press "Check off"; then View All → Options → "End series" (first tap arms), tap again`));
          await openDetail(s, b, id);
          await s.press(t("cal-action-complete"));
          const done = await waitRow(ctx, "events", id, (r) => tagsOf(r).includes(`rd:done:${b}`));
          ctx.check("db", tagsOf(done).includes(`rd:done:${b}`) && done?.date === b && tagsOf(done).includes(`rd:skip:${skipDay}`), L(`checking ${b} off is a mark on that one date (rd:done:${b})`), JSON.stringify(tagsOf(done)));
          if (!(await s.page.locator(t("calendar-item-detail")).locator("visible=true").count())) await openDetail(s, b, id);
          const armedOnly = await endSeries();
          ctx.check("db", armedOnly, L("the first tap on End series only arms it (Rule 8)"));
          const ended = await waitRow(ctx, "events", id, (r) => !!r?.recurrence_end);
          // the next open date is the first one not checked off, skipped or moved away
          const endWanted = O.addDays(after, -1);
          ctx.check("db", ended?.recurrence_end === endWanted && ended?.deleted_at == null && ended?.date === b && ended?.recurrence === "weekly" && tagsOf(ended).includes(`rd:done:${b}`),
            L(`ending the series stores its last day (${endWanted}: the day before ${after}, the next open date); the row, its rule and its history are kept`), JSON.stringify([ended?.recurrence_end, ended?.deleted_at, ended?.date, ended?.recurrence, tagsOf(ended)]));
          await closeDetail(s);
          ctx.check("screen", !(await onDay(s, after, id, false)), L(`the Calendar has no date of the ended series from ${after} on`));
          ctx.check("screen", !(await onDay(s, O.addDays(after, 7), id, false)), L(`nor a week later (${O.addDays(after, 7)})`));
          ctx.check("screen", await onDay(s, b, id, true), L(`the date that was checked off (${b}) keeps its place: earlier dates keep their history`));
        }
        if (others[0]) {
          const stillThere = await ctx.db.row("events", others[0].id);
          ctx.check("db", !!stillThere && stillThere.deleted_at == null && stillThere.date === moveTo, L(`the occurrence moved to ${moveTo} is its own record and is still there`));
          ctx.check("screen", await onDay(s, moveTo, others[0].id, true), L("and still on the Calendar"));
        }
      }
      await closing(ctx, s, L, reloads());
    }
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Tasks: edited, moved, deleted and brought back; one date of a repeating task
// ════════════════════════════════════════════════════════════════════════════
scenario({
  id: "ui-planning.task",
  title: "A task by hand (mouse and touch): renamed, moved, undated, deleted and restored; one date of a repeating task moved and skipped without re-anchoring the series",
  area: "Browser · planning",
  browser: true,
  covers: ["task.edit.ui", "task.reschedule.ui", "task.delete.ui", "task.restore.ui", "task.cancel.ui", "task.complete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const tell = finder(ctx);
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} file taxes`;
      const renamed = `${ctx.tag} ${s.surface} file the taxes early`;
      const d2 = O.addDays(ctx.today, 6);
      const task = must(await ctx.api("POST", "/tasks", { title, dueDate: ctx.today, priority: "high", tags: ["paperwork"] }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      const id = task.id as string;
      const row = () => ctx.db.row("tasks", id);
      const card = t(`card-task-${id}`);
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/tasks", "page-tasks");
      const reloads = countReloads(s);
      ctx.check("screen", await visible(s, card, 15000), L("a task made elsewhere and due today is on the Tasks list (in-app navigation)"));
      const today0 = await numberIn(s, t("tasks-summary-today"));

      // ── Edit: Cancel writes nothing ──
      ctx.step(L(`on #/tasks press the task, change the title in the editor, press Cancel`));
      const before = await row();
      await s.press(t(`task-edit-trigger-${id}`));
      await s.page.waitForSelector(t("dialog-edit-task"), { timeout: 10000 });
      await typeInto(s, t("input-task-title"), renamed);
      await hit(s, s.page.locator(t("dialog-edit-task")).getByRole("button", { name: /^cancel$/i }));
      await hidden(s, t("dialog-edit-task"));
      await sleep(1200);
      const afterCancel = await row();
      ctx.check("db", afterCancel?.title === title && afterCancel?.updated_at === before?.updated_at, L("Cancel in the task editor writes nothing"), JSON.stringify([afterCancel?.title, afterCancel?.updated_at, before?.updated_at]));

      // ── Edit: Save writes the title, and only the title ──
      ctx.step(L(`⋯ → Edit, change the title to "${renamed}", press Save`));
      await s.press(t(`button-task-menu-${id}`));
      await s.press(t(`menu-edit-task-${id}`));
      await s.page.waitForSelector(t("dialog-edit-task"), { timeout: 10000 });
      await typeInto(s, t("input-task-title"), renamed);
      await s.press(t("button-submit-task"));
      const edited = await waitRow(ctx, "tasks", id, (r) => r?.title === renamed);
      ctx.check("action", edited?.title === renamed, L("the editor saved the new title"));
      ctx.check("db", edited?.title === renamed && edited?.due_date === ctx.today && edited?.priority === "high" && edited?.status === "todo"
        && JSON.stringify(edited?.tags) === JSON.stringify(before?.tags) && JSON.stringify(edited?.linked_profiles) === JSON.stringify(before?.linked_profiles),
        L("the row holds the new title; its date, priority, tags and owner are as they were (a PATCH carries only what was sent)"), JSON.stringify([edited?.title, edited?.due_date, edited?.priority, edited?.tags, edited?.linked_profiles]));
      ctx.check("screen", await seen(s, renamed, 8000, card), L("the Tasks row shows the new title without a reload"));
      await goto(s, "/dashboard", "page-dashboard");
      ctx.check("screen", await seen(s, renamed, 12000, t("exec-card-tasks")), L("the dashboard's Tasks card names it by its new title"));
      ctx.check("screen", await unseen(s, title + " ", 3000, t("executive-briefing")) && !(await wordsOf(s, t("executive-briefing"))).includes(`${title} `) , L("and nowhere on the dashboard by the old one"));
      const nextImportant = await until(async () => (await wordsOf(s, t("exec-kpi-next"))).includes(renamed), 8000);
      ctx.check("screen", nextImportant, L("Next Important — the nearest dated item, due today — names it"), await wordsOf(s, t("exec-kpi-next")));
      await s.press(t("button-notification-bell"));
      const bellNames = await seen(s, renamed, 10000, t("panel-notifications"));
      ctx.check("screen", bellNames, L("the bell's \"due today\" notice carries the new title"), (await wordsOf(s, t("panel-notifications"))).slice(0, 200));
      await s.page.keyboard.press("Escape");
      await hidden(s, t("panel-notifications"), 4000);

      // ── Reschedule on the row ──
      ctx.step(L(`on #/tasks press the row's date, choose ${d2}`));
      await goto(s, "/tasks", "page-tasks");
      await s.press(t(`btn-task-due-${id}`));
      await typeInto(s, t(`input-task-due-inline-${id}`), d2);
      await s.page.locator(t(`input-task-due-inline-${id}`)).first().blur().catch(() => undefined);
      const moved = await waitRow(ctx, "tasks", id, (r) => r?.due_date === d2);
      ctx.check("db", moved?.due_date === d2 && moved?.title === renamed && moved?.status === "todo", L(`the row is due ${d2}`), JSON.stringify([moved?.due_date, moved?.title]));
      const todayFell = await until(async () => (await numberIn(s, t("tasks-summary-today"))) === today0 - 1, 8000);
      ctx.check("derived", todayFell, L(`the "Today" tile fell by one (${today0} → ${today0 - 1}): the task is no longer due today`), `tile reads ${await numberIn(s, t("tasks-summary-today"))}`);
      await goto(s, "/calendar", "calendar-view");
      ctx.check("screen", await onDay(s, d2, id, true), L(`the Calendar lists it on ${d2} without a reload`));
      ctx.check("screen", !(await onDay(s, ctx.today, id, false)), L("and no longer on today"));
      await goto(s, "/dashboard", "page-dashboard");
      const notToday = await until(async () => !(await wordsOf(s, t("exec-kpi-next"))).includes("(today)") || !(await wordsOf(s, t("exec-kpi-next"))).includes(renamed), 8000);
      ctx.check("screen", notToday, L("Next Important no longer says it is today"), await wordsOf(s, t("exec-kpi-next")));

      // ── No date: off the Calendar (Rule 6) ──
      ctx.step(L(`on #/tasks open the editor, clear the due date, Save`));
      await goto(s, "/tasks", "page-tasks");
      await s.press(t(`task-edit-trigger-${id}`));
      await s.page.waitForSelector(t("dialog-edit-task"), { timeout: 10000 });
      await typeInto(s, t("input-task-due-date"), "");
      await s.press(t("button-submit-task"));
      const undated = await waitRow(ctx, "tasks", id, (r) => !r?.due_date);
      ctx.check("db", !undated?.due_date && undated?.title === renamed, L("the row has no due date"), JSON.stringify(undated?.due_date));
      await goto(s, "/calendar", "calendar-view");
      const offCalendar = !(await onDay(s, d2, id, false));
      ctx.check("screen", offCalendar, L(`a task with no due date is not on the Calendar (it was on ${d2})`));
      const notDrawnToday = !(await onDay(s, ctx.today, id, false, 3000));
      ctx.check("screen", notDrawnToday, L("nor drawn on today"));

      // ── Delete (asks first), then Undo ──
      ctx.step(L(`on #/tasks ⋯ → Delete: Cancel; ⋯ → Delete → Delete; then "Undo" on the toast`));
      await goto(s, "/tasks", "page-tasks");
      await s.press(t(`button-task-menu-${id}`));
      await s.press(t(`button-delete-task-${id}`));
      await s.page.waitForSelector(t(`alert-delete-task-${id}`), { timeout: 8000 });
      await sleep(600);
      const asked = await row();
      const asks = ctx.check("db", !!asked && asked.deleted_at == null, L("Delete in the menu only asks: the row is still there (Rule 8)"));
      if (!asks) tell(s, { severity: "bug", title: "A task is deleted before the confirmation is answered", detail: "the row was gone while the dialog was still open" });
      await hit(s, s.page.locator(t(`alert-delete-task-${id}`)).getByRole("button", { name: /^cancel$/i }));
      await hidden(s, t(`alert-delete-task-${id}`));
      await sleep(800);
      ctx.check("db", (await row())?.deleted_at == null, L("Cancel keeps the task"));
      ctx.check("screen", await visible(s, card, 4000), L("and it is still listed"));
      await s.press(t(`button-task-menu-${id}`));
      await s.press(t(`button-delete-task-${id}`));
      await s.press(t("button-confirm-delete-task"));
      const deleted = await waitRow(ctx, "tasks", id, (r) => !r || r.deleted_at != null);
      ctx.check("db", !deleted || deleted.deleted_at != null, L("confirming deletes it (the row is marked deleted)"));
      ctx.check("screen", await hidden(s, card, 8000), L("it leaves the list without a reload"));
      const undo = await visible(s, t("toast-undo"), 6000);
      ctx.check("screen", undo, L("the confirmation offers Undo"));
      if (undo) {
        await s.press(t("toast-undo"));
        const restored = await waitRow(ctx, "tasks", id, (r) => !!r && r.deleted_at == null);
        ctx.check("db", !!restored && restored.deleted_at == null && restored.title === renamed && restored.status === "todo" && restored.priority === "high" && JSON.stringify(restored.tags) === JSON.stringify(before?.tags),
          L("Undo restores the same row, with its title, priority and tags"), JSON.stringify([restored?.deleted_at, restored?.title, restored?.status, restored?.tags]));
        ctx.check("screen", await visible(s, card, 10000), L("and it is back on the list without a reload"));
        await goto(s, "/dashboard", "page-dashboard");
        ctx.check("screen", await seen(s, renamed, 12000, t("exec-card-tasks")), L("and back on the dashboard's Tasks card"));
      }

      // ── A repeating task: one date moved, one skipped, then completed ──
      const a = O.addDays(ctx.today, 3), movedTo = O.addDays(a, 2), second = O.addDays(a, 7), third = O.addDays(a, 14);
      const rTitle = `${ctx.tag} ${s.surface} water the ferns`;
      const rep = must(await ctx.api("POST", "/tasks", { title: rTitle, dueDate: a }), "repeating task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${rep.id}`));
      must(await ctx.api("POST", `/tasks/${rep.id}/schedule`, { freq: "weekly" }), "weekly");
      const rid = rep.id as string;
      const rrow = () => ctx.db.row("tasks", rid);
      const tagsOf = (r: any): string[] => (Array.isArray(r?.tags) ? r.tags : []);
      ctx.step(L(`a weekly task due ${a} exists; on #/calendar open it on ${a}, press that date, "Change date" → ${movedTo}`));
      await goto(s, "/calendar", "calendar-view");
      ctx.check("screen", await onDay(s, second, rid, true, 15000), L(`the Calendar shows the weekly task's second date (${second})`));
      await openDetail(s, a, rid);
      await s.press(t(`cal-occ-${a}`));
      await s.press(t("cal-menu-move"));
      await typeInto(s, t("cal-move-date"), movedTo);
      await s.press(t("cal-move-confirm"));
      const m = await waitRow(ctx, "tasks", rid, (r) => r?.due_date === movedTo);
      const anchored = ctx.check("db", m?.due_date === movedTo && tagsOf(m).includes("recur:weekly") && tagsOf(m).includes(`rfrom:${a}`),
        L(`the open row is due ${movedTo} and remembers its scheduled date (rfrom:${a}); the rule is untouched`), JSON.stringify([m?.due_date, tagsOf(m)]));
      if (!anchored) tell(s, { severity: "bug", title: "Moving one occurrence of a repeating task loses its scheduled date", detail: `row: due ${m?.due_date}, tags ${JSON.stringify(tagsOf(m))} (O2 wants rfrom:${a})` });
      await closeDetail(s);
      ctx.check("screen", await onDay(s, movedTo, rid, true), L(`the Calendar shows this occurrence on ${movedTo}`));
      ctx.check("screen", !(await onDay(s, a, rid, false)), L(`not on ${a} any more`));
      ctx.check("screen", await onDay(s, second, rid, true), L(`and the following week is still ${second} — the series was not re-anchored`));

      ctx.step(L(`open it on ${second}, press that date, "Skip this occurrence"`));
      await openDetail(s, second, rid);
      await showAllDates(s);
      await s.press(t(`cal-occ-${second}`));
      await s.press(t("cal-menu-skip"));
      const sk = await waitRow(ctx, "tasks", rid, (r) => tagsOf(r).includes(`rskip:${second}`));
      ctx.check("db", tagsOf(sk).includes(`rskip:${second}`) && sk?.due_date === movedTo && sk?.status === "todo" && sk?.deleted_at == null && tagsOf(sk).includes("recur:weekly"),
        L(`the skip is a mark (rskip:${second}); the open row, its date and the rule are untouched (O1)`), JSON.stringify([sk?.due_date, sk?.status, tagsOf(sk)]));
      await closeDetail(s);
      ctx.check("screen", !(await onDay(s, second, rid, false)), L(`the Calendar shows nothing on the skipped ${second}`));
      ctx.check("screen", await onDay(s, third, rid, true), L(`and still shows ${third}`));

      // Tasks: what the row says about the series, then tick it off
      await goto(s, "/tasks", "page-tasks");
      const badge = t(`badge-task-recurrence-${rid}`);
      await visible(s, badge, 10000);
      const says = await wordsOf(s, badge);
      const wantDay = DAY[O.weekday(a)];
      const rightDay = ctx.check("screen", new RegExp(wantDay, "i").test(says) && !new RegExp(DAY[O.weekday(movedTo)], "i").test(says),
        L(`the Tasks row says the series repeats weekly on ${wantDay} — the day it is scheduled on, not the day one date was moved to`), `the row says "${says}"`);
      if (!rightDay) tell(s, { severity: "discrepancy", title: "A repeating task with one date moved is labelled with the moved day's weekday", detail: `A weekly task scheduled on ${wantDay}s (${a}). Calendar → that date → "Change date" → ${movedTo} (a ${DAY[O.weekday(movedTo)]}). The stored rule is unchanged (recur:weekly, rfrom:${a}) and the Calendar keeps the following weeks on ${wantDay}, but the Tasks list badge reads "${says}" — it derives the weekday from the moved row's due date (humanSummary(parseRecurrence(tags), task.dueDate) in client/src/pages/tasks.tsx) instead of the scheduled date (O2).` });

      ctx.step(L(`on #/tasks tick the repeating task's box`));
      await s.press(t(`checkbox-task-${rid}`));
      const doneRow = await waitRow(ctx, "tasks", rid, (r) => r?.status === "done");
      ctx.check("db", doneRow?.status === "done" && doneRow?.due_date === movedTo, L("the ticked occurrence is done and keeps its own date"), JSON.stringify([doneRow?.status, doneRow?.due_date]));
      const spawned = await waitRows(ctx, "tasks", `title=eq.${enc(rTitle)}&id=neq.${rid}&deleted_at=is.null`, (n) => n >= 1);
      for (const r of spawned) ctx.cleanup(() => ctx.api("DELETE", `/tasks/${r.id}`));
      await sleep(1200);
      const settled = await ctx.db.rows("tasks", `title=eq.${enc(rTitle)}&id=neq.${rid}&deleted_at=is.null`);
      // the next occurrence: the first week after the scheduled date that was not skipped
      const want = O.occurrencesBetween(a, "weekly", O.addDays(a, 1), O.addDays(a, 60), [second])[0];
      const next = ctx.check("derived", settled.length === 1 && settled[0].due_date === want && settled[0].status === "todo" && tagsOf(settled[0]).includes("recur:weekly"),
        L(`exactly one next occurrence, open, due ${want}: counted from the scheduled ${a} (not from ${movedTo}) and stepping over the skipped ${second}`), JSON.stringify(settled.map((r: any) => [r.due_date, r.status, r.tags])));
      if (!next && settled[0] && settled[0].due_date !== want) tell(s, { severity: "bug", title: "A repeating task's next occurrence is counted from a moved date", detail: `scheduled ${a}, moved to ${movedTo}, ${second} skipped, completed: next row is due ${settled[0].due_date}, wanted ${want}` });
      if (settled[0]) {
        ctx.check("screen", await visible(s, t(`card-task-${settled[0].id}`), 10000), L("the next occurrence is on the Tasks list without a reload"));
        await goto(s, "/calendar", "calendar-view");
        ctx.check("screen", await onDay(s, want, settled[0].id, true), L(`and on the Calendar on ${want}`));
      }
      await closing(ctx, s, L, reloads());
    }
  },
});

void listOf; void must; void listedDates; void prefRow;
