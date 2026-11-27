// Planning screens driven by hand — a desktop mouse and a phone with touch:
// tasks, calendar events (one-off and repeating), habits, goals and the
// dashboard's own controls. Each operation is then read three ways: the stored
// row straight from the database, the figure that depends on it against the
// oracle, and the OTHER screens that show it, reached inside the app without a
// page reload.
import { scenario, must, type Ctx } from "../framework";
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
    const tell = finder(ctx);
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
      if (!laterStay) tell(s, { severity: "bug", title: "Skipping one date of a weekly event changes other dates", detail: `after skipping ${skipDay} the detail listed ${list.got.slice(0, 8).join(", ")}` });

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
      if (!kept && afterMove?.date !== b) tell(s, { severity: "bug", title: "Moving one occurrence of a weekly event re-anchors the series", detail: `series date became ${afterMove?.date} (was ${b}) — O2` });
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
        tell(s, { severity: "bug", title: "A paused series cannot be resumed from any screen", detail: `Calendar → a date → More → Edit series → Advanced → "Pause series" stores rd:paused and takes every date off the Calendar. Recurring & Important then lists it as "Paused — resume to schedule dates", but that card's menu has no Resume, and its "Open details" and "Edit" do nothing for a paused series (no sheet opens), so the editor cannot be reached either (the only component with a Resume item, RecurringDatesManager, is not mounted). The pause toast says "until you resume it". Looked in: ${where.join(" · ").slice(0, 500)}` });
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
          let toast = "";
          await until(async () => { toast = (await s.page.locator("li").filter({ hasText: /couldn.t complete that/i }).last().innerText().catch(() => "")).replace(/\s+/g, " "); return toast !== ""; }, 4000, 200);
          const r = await waitRow(ctx, "events", id, (x) => !x || x.deleted_at != null || !!x.recurrence_end, 5000);
          endedEarly = !r || r.deleted_at != null || !!r.recurrence_end;
          const works = ctx.check("action", endedEarly, L(`"End series", offered while the next date is the series' first, ends it`), `the row is unchanged (recurrence_end ${JSON.stringify(r?.recurrence_end)}); the screen said: ${toast.slice(0, 220)}`);
          if (!works) tell(s, { severity: "bug", title: "\"End series\" is offered on a series that has not started, and always fails", detail: `A weekly event whose first date (${b}) is still ahead. Detail → View All → Options → "End series — Stops before ${shortDate(b)}" → tap again: PATCH /api/events/:id {recurrenceEnd: ${O.addDays(b, -1)}} answers 400 "A repeating event cannot stop before its first occurrence" and a red toast "Couldn't complete that". Nothing is stored. The control is on the screen for an action that cannot apply (O4); the same is offered in the More menu. Screen said: ${toast.slice(0, 200)}` });
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
      ctx.check("screen", await until(async () => !(await wordsOf(s, t("executive-briefing"))).includes(title), 8000), L("and nowhere on the dashboard by the old one"));
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

// ════════════════════════════════════════════════════════════════════════════
// Habits: today's check-in taken back, renamed, deleted and restored
// ════════════════════════════════════════════════════════════════════════════
scenario({
  id: "ui-planning.habit",
  title: "A habit by hand (mouse and touch): checked in and un-checked, renamed, its frequency changed, deleted and restored — the streak follows the check-ins",
  area: "Browser · planning",
  browser: true,
  covers: ["habit.complete.ui", "habit.cancel.ui", "habit.edit.ui", "habit.delete.ui", "habit.restore.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const tell = finder(ctx);
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const name = `${ctx.tag} ${s.surface} stretch`;
      const renamed = `${ctx.tag} ${s.surface} long stretch`;
      const habit = must(await ctx.api("POST", "/habits", { name, frequency: "daily" }), "habit");
      const id = habit.id as string;
      ctx.cleanup(() => ctx.api("DELETE", `/habits/${id}`));
      for (const back of [1, 2]) must(await ctx.api("POST", `/habits/${id}/checkin`, { date: O.addDays(ctx.today, -back) }), "an earlier check-in");
      const row = () => ctx.db.row("habits", id);
      const checkins = () => ctx.db.rows("habit_checkins", `habit_id=eq.${id}`);
      const streakWanted = async () => O.dailyStreak((await checkins()).map((c: any) => String(c.date).slice(0, 10)), ctx.today);
      const card = t(`card-habit-${id}`);
      const streakShown = () => numberIn(s, t(`stat-streak-${id}`));
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/habits", "");
      const reloads = countReloads(s);
      ctx.check("screen", await visible(s, card, 15000), L("a habit with check-ins on the last two days is listed"));
      ctx.check("derived", await until(async () => (await streakShown()) === 2, 8000) && (await streakWanted()) === 2, L("its streak reads 2: yesterday and the day before, today still open"), `shown ${await streakShown()}`);

      // ── Check in ──
      ctx.step(L("on #/habits press the habit's check-in dot"));
      await s.press(t(`button-seg-${id}-0`));
      const after = await waitRows(ctx, "habit_checkins", `habit_id=eq.${id}&date=eq.${ctx.today}`, (n) => n >= 1);
      await sleep(1200);
      ctx.check("action", after.length >= 1, L("the tap checked the habit in"));
      ctx.check("db", (await ctx.db.count("habit_checkins", `habit_id=eq.${id}&date=eq.${ctx.today}`)) === 1 && (await ctx.db.count("habit_checkins", `habit_id=eq.${id}`)) === 3, L("one check-in row for today (three in all)"));
      const want3 = await streakWanted();
      ctx.same("derived", (await waitRow(ctx, "habits", id, (r) => r?.current_streak === want3))?.current_streak, want3, L("the stored streak (three days running)"));
      ctx.check("derived", want3 === 3 && await until(async () => (await streakShown()) === 3, 8000), L("the card's streak reads 3"), `shown ${await streakShown()}`);
      ctx.check("screen", await until(async () => /done today/i.test(await wordsOf(s, t(`text-habit-today-${id}`))), 6000), L("and it says \"Done today\""), await wordsOf(s, t(`text-habit-today-${id}`)));
      await goto(s, "/dashboard", "page-dashboard");
      // the Habits card is off in Quiet Mode: it is named under the grid and opens in place
      if (!(await s.page.locator(t("exec-card-habits")).locator("visible=true").count())) await s.press(t("exec-hidden-habits")).catch(() => undefined);
      const tile = t(`exec-habit-checkin-${id}`);
      const onDash = await visible(s, tile, 10000);
      ctx.check("screen", onDash, L("the dashboard's Habits card lists it without a reload"));
      const dashSaysDone = await until(async () => /1\s*of\s*1\s*done|1\s*\/\s*1/i.test(await wordsOf(s, t("exec-card-habits"))), 6000);
      ctx.check("screen", dashSaysDone, L("and counts today's check-in"), (await wordsOf(s, t("exec-card-habits"))).slice(0, 160));

      // ── Undo today's check-in ──
      ctx.step(L("back on #/habits press the filled dot (\"Tap to undo\")"));
      await goto(s, "/habits", "");
      await visible(s, card, 10000);
      await s.press(t(`button-seg-${id}-0`));
      const undone = await waitRows(ctx, "habit_checkins", `habit_id=eq.${id}&date=eq.${ctx.today}`, (n) => n === 0);
      ctx.check("db", undone.length === 0 && (await ctx.db.count("habit_checkins", `habit_id=eq.${id}`)) === 2, L("today's check-in row is gone; the two earlier ones are untouched"));
      const want2 = await streakWanted();
      ctx.same("derived", (await waitRow(ctx, "habits", id, (r) => r?.current_streak === want2))?.current_streak, want2, L("the stored streak (back to two)"));
      ctx.check("derived", want2 === 2 && await until(async () => (await streakShown()) === 2, 8000), L("the card's streak reads 2 again"), `shown ${await streakShown()}`);
      ctx.check("screen", await until(async () => !/done today/i.test(await wordsOf(s, t(`text-habit-today-${id}`))), 6000), L("and it no longer says \"Done today\""), await wordsOf(s, t(`text-habit-today-${id}`)));
      await goto(s, "/dashboard", "page-dashboard");
      if (!(await s.page.locator(t("exec-card-habits")).locator("visible=true").count())) await s.press(t("exec-hidden-habits")).catch(() => undefined);
      const dashOpen = await until(async () => /0\s*of\s*1\s*done|0\s*\/\s*1/i.test(await wordsOf(s, t("exec-card-habits"))), 8000);
      ctx.check("screen", dashOpen, L("the dashboard's Habits card shows today as open again without a reload"), (await wordsOf(s, t("exec-card-habits"))).slice(0, 160));

      // ── Rename: Cancel writes nothing, Save writes the name ──
      ctx.step(L("on #/habits press the pencil by the name, type a new name, press the X (cancel)"));
      await goto(s, "/habits", "");
      await visible(s, card, 10000);
      const before = await row();
      await hit(s, s.page.locator(card).locator(t("button-edit-title")));
      const box = s.page.locator(card).locator('input[type="text"]').first();
      await box.waitFor({ timeout: 8000 });
      await box.fill(renamed);
      await hit(s, s.page.locator(card).locator('button[title="Cancel"]'));
      await sleep(1200);
      const kept = await row();
      ctx.check("db", kept?.name === name && kept?.updated_at === before?.updated_at, L("cancelling the rename writes nothing"), JSON.stringify([kept?.name, kept?.updated_at, before?.updated_at]));
      ctx.step(L(`press the pencil again, type "${renamed}", press the check (save)`));
      await hit(s, s.page.locator(card).locator(t("button-edit-title")));
      await box.waitFor({ timeout: 8000 });
      await box.fill(renamed);
      await hit(s, s.page.locator(card).locator('button[title="Save"]'));
      const named = await waitRow(ctx, "habits", id, (r) => r?.name === renamed);
      ctx.check("db", named?.name === renamed && named?.frequency === "daily" && named?.current_streak === 2 && (await ctx.db.count("habit_checkins", `habit_id=eq.${id}`)) === 2,
        L("the row has the new name; frequency, streak and check-ins are untouched"), JSON.stringify([named?.name, named?.frequency, named?.current_streak]));
      ctx.check("screen", await seen(s, renamed, 8000, card), L("the card shows the new name without a reload"));
      await goto(s, "/dashboard", "page-dashboard");
      if (!(await s.page.locator(t("exec-card-habits")).locator("visible=true").count())) await s.press(t("exec-hidden-habits")).catch(() => undefined);
      ctx.check("screen", await seen(s, renamed, 10000, t("exec-card-habits")), L("the dashboard's Habits card names it by the new name"));

      // ── Frequency ──
      ctx.step(L("on #/habits open the frequency menu on the card, choose Weekly"));
      await goto(s, "/habits", "");
      await s.press(t(`select-freq-${id}`));
      await hit(s, s.page.getByRole("option", { name: /^weekly$/i }));
      const weekly = await waitRow(ctx, "habits", id, (r) => r?.frequency === "weekly");
      ctx.check("db", weekly?.frequency === "weekly" && weekly?.name === renamed && weekly?.deleted_at == null && (await ctx.db.count("habit_checkins", `habit_id=eq.${id}`)) === 2,
        L("the row is weekly; the name and the check-ins are untouched"), JSON.stringify([weekly?.frequency, weekly?.name]));
      ctx.check("screen", await until(async () => /weekly/i.test(await wordsOf(s, t(`select-freq-${id}`))), 6000), L("the card says weekly"));

      // ── Delete (asks first), then Undo ──
      ctx.step(L("press the trash on the card: Cancel; press it again: Delete; then \"Undo\" on the toast"));
      const trash = s.page.locator(card).getByRole("button", { name: /delete habit/i });
      const dialog = s.page.getByRole("alertdialog");
      await hit(s, trash);
      await dialog.waitFor({ timeout: 8000 });
      const dialogWords = (await dialog.innerText()).replace(/\s+/g, " ");
      await sleep(500);
      const asks = ctx.check("db", (await row())?.deleted_at == null, L("the trash only asks: the row is still there (Rule 8)"));
      if (!asks) tell(s, { severity: "bug", title: "A habit is deleted before the confirmation is answered", detail: "the row was marked deleted while the dialog was still open" });
      await hit(s, dialog.getByRole("button", { name: /^cancel$/i }));
      await sleep(800);
      ctx.check("db", (await row())?.deleted_at == null, L("Cancel keeps the habit"));
      ctx.check("screen", await visible(s, card, 4000), L("and it is still listed"));
      await hit(s, trash);
      await dialog.waitFor({ timeout: 8000 });
      await hit(s, dialog.getByRole("button", { name: /^delete$/i }));
      const deleted = await waitRow(ctx, "habits", id, (r) => !r || r.deleted_at != null);
      ctx.check("db", !deleted || deleted.deleted_at != null, L("confirming deletes it (the row is marked deleted)"));
      ctx.check("screen", await hidden(s, card, 8000), L("it leaves the list without a reload"));
      const undo = await visible(s, t("toast-undo"), 6000);
      ctx.check("screen", undo, L("the confirmation offers Undo"));
      if (undo) {
        await s.press(t("toast-undo"));
        const restored = await waitRow(ctx, "habits", id, (r) => !!r && r.deleted_at == null);
        const n = await ctx.db.count("habit_checkins", `habit_id=eq.${id}`);
        const keeps = ctx.check("db", !!restored && restored.deleted_at == null && restored.name === renamed && restored.frequency === "weekly" && n === 2,
          L("Undo restores the same row with its name, frequency and both check-ins"), JSON.stringify([restored?.deleted_at, restored?.name, restored?.frequency, n]));
        if (!keeps && n !== 2) tell(s, { severity: "bug", title: "Restoring a deleted habit loses its check-ins", detail: `${n} of 2 check-in rows after Undo` });
        ctx.check("screen", await visible(s, card, 10000), L("and it is back on the list without a reload"));
        // The dialog's words against what the app then does.
        if (n === 2 && /permanently/i.test(dialogWords)) tell(s, { severity: "discrepancy", title: "The habit delete dialog says the history is permanently removed, but it is kept and Undo restores it", detail: `the dialog reads "${dialogWords.slice(0, 160)}"; after Delete the habit row is only marked deleted, its check-in rows stay, and "Undo" on the toast brings both back. The wording (client/src/pages/habits.tsx) promises more loss than happens.` });
      }
      await closing(ctx, s, L, reloads());
    }
  },
});

// ════════════════════════════════════════════════════════════════════════════
// Goals
// ════════════════════════════════════════════════════════════════════════════
scenario({
  id: "ui-planning.goal",
  title: "A goal by hand (mouse and touch): made, progress logged, edited and deleted — its percent and the page's totals follow the stored row",
  area: "Browser · planning",
  browser: true,
  covers: ["goal.create.ui", "goal.edit.ui", "goal.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const tell = finder(ctx);
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} read`;
      const renamed = `${ctx.tag} ${s.surface} read more`;
      const deadline = O.addDays(ctx.today, 60);
      const q = `title=ilike.*${enc(`${ctx.tag} ${s.surface}`)}*&deleted_at=is.null`;
      // What the page's header should say, from the stored rows alone.
      const overallWanted = async () => {
        const rows = await ctx.db.rows("goals", "deleted_at=is.null");
        const pcts = rows.filter((g: any) => !/^(completed|abandoned)$/i.test(String(g.status || "")))
          .map((g: any) => (Number(g.target) > 0 ? Math.min(100, ((Number(g.current) || 0) / Number(g.target)) * 100) : 0)).filter((x: number) => x < 100);
        return { active: pcts.length, avg: pcts.length ? Math.round(pcts.reduce((a: number, b: number) => a + b, 0) / pcts.length) : 0 };
      };
      const header = async () => {
        const words = await wordsOf(s, t("page-goals"));
        return { avg: Number((/overall progress\s*(\d+)%/i.exec(words) || [])[1]), active: await numberIn(s, t("goals-chip-active")) };
      };
      const headerIs = async () => {
        let got = { avg: NaN, active: NaN }, want = { avg: 0, active: 0 };
        const ok = await until(async () => { want = await overallWanted(); got = await header(); return got.avg === want.avg && got.active === want.active; }, 10000, 500);
        return { ok, got, want };
      };
      const openForm = async () => {
        const add = (await s.page.locator(t("btn-add-goal")).locator("visible=true").count()) ? "btn-add-goal" : "btn-create-first-goal";
        await s.press(t(add));
        await s.page.waitForSelector(t("input-goal-title"), { timeout: 10000 });
      };
      const formDialog = () => s.page.getByRole("dialog").filter({ has: s.page.locator(t("input-goal-title")) });
      const closeForm = async () => {
        const x = formDialog().getByRole("button", { name: /close/i }).first();
        if (await x.count()) await hit(s, x); else await s.page.keyboard.press("Escape");
        await hidden(s, t("input-goal-title"), 6000);
      };
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/goals", "page-goals");
      await s.page.waitForSelector(`${t("btn-add-goal")}, ${t("btn-create-first-goal")}`, { timeout: 20000 });
      const reloads = countReloads(s);

      // ── Closing the form writes nothing ──
      ctx.step(L(`open #/goals, press "Add Goal", type a title and a target, close the form`));
      await openForm();
      await typeInto(s, t("input-goal-title"), title);
      await typeInto(s, t("input-goal-target"), "200");
      await closeForm();
      await sleep(1000);
      ctx.check("db", (await ctx.db.count("goals", q)) === 0, L("closing the new-goal form stores nothing"));

      // ── Create ──
      ctx.step(L(`"Add Goal": "${title}", target 200 pages, deadline ${deadline}; press Create twice quickly`));
      await openForm();
      await typeInto(s, t("input-goal-title"), title);
      await typeInto(s, t("input-goal-target"), "200");
      await typeInto(s, t("input-goal-unit"), "pages");
      await typeInto(s, t("input-goal-deadline"), deadline);
      const save = s.page.locator(t("btn-save-goal")).locator("visible=true").first();
      await (s.surface === "phone" ? save.tap() : save.dblclick()).catch(() => undefined);
      if (s.surface === "phone") await save.tap({ timeout: 300 }).catch(() => undefined);
      await waitRows(ctx, "goals", q, (n) => n >= 1);
      await sleep(1500);
      const made = await ctx.db.rows("goals", q);
      for (const g of made) ctx.cleanup(() => ctx.api("DELETE", `/goals/${g.id}`));
      const one = ctx.check("db", made.length === 1 && made[0].title === title && Number(made[0].target) === 200 && made[0].unit === "pages" && made[0].deadline === deadline && (Number(made[0].current) || 0) === 0 && made[0].status === "active",
        L("one goal row: the title, 200 pages, the deadline, nothing done yet, active (a double press of Create)"), `${made.length} rows ${JSON.stringify(made.map((g: any) => [g.title, g.target, g.unit, g.deadline, g.current, g.status]))}`);
      if (!one && made.length > 1) {
        tell(s, { severity: "bug", title: "A double click on Create in the goal form makes two goals", detail: `#/goals → "Add Goal" → title, target 200, unit, deadline → double-click "Create": ${made.length} identical goal rows are stored (POST /api/goals twice). The form stays open until the first answer comes back and the second click of a double click arrives before the button is disabled, so it is sent too. The task, event, expense and habit forms each store one. (A double tap on the phone stored one in this run.)` });
        // go on with one goal: the extra rows are removed through the API and the list is read again
        ctx.step(L(`removed ${made.length - 1} duplicate goal row(s) through the API to go on`));
        for (const g of made.slice(1)) await ctx.api("DELETE", `/goals/${g.id}`);
        await goto(s, "/dashboard", "page-dashboard");
        await goto(s, "/goals", "page-goals");
        await until(async () => (await s.page.getByRole("button", { name: `Open goal: ${title}` }).count()) === 1, 12000);
      }
      const id = made[0]?.id;
      if (!ctx.check("action", !!id, L("the form saved a goal")) || !id) { await closing(ctx, s, L, reloads()); continue; }
      const row = () => ctx.db.row("goals", id);
      const card = t(`goal-card-${id}`);
      const pctShown = async () => Number((/(\d+)%/.exec(await wordsOf(s, card)) || [])[1]);
      ctx.check("screen", await visible(s, card, 12000), L("the goal is listed without a reload"));
      let h = await headerIs();
      ctx.check("derived", h.ok, L(`the header counts it: ${h.want.active} active, ${h.want.avg}% overall (worked out from the stored goals)`), `shows ${JSON.stringify(h.got)}`);
      const openSheet = async (name: string) => {
        await hit(s, s.page.getByRole("button", { name: `Open goal: ${name}` }));
        await s.page.waitForSelector(t("input-goal-progress"), { timeout: 10000 });
      };
      const sheet = () => s.page.getByRole("dialog").filter({ has: s.page.locator(t("input-goal-progress")) });

      // ── Progress ──
      ctx.step(L("press the goal, type 50 under Update Progress, Save"));
      await openSheet(title);
      await typeInto(s, t("input-goal-progress"), "50");
      await hit(s, sheet().getByRole("button", { name: /^save$/i }));
      const prog = await waitRow(ctx, "goals", id, (r) => Number(r?.current) === 50);
      ctx.check("db", Number(prog?.current) === 50 && Number(prog?.target) === 200 && prog?.title === title, L("the row holds 50 of 200"), JSON.stringify([prog?.current, prog?.target]));
      ctx.check("derived", await until(async () => (await pctShown()) === Math.round((50 / 200) * 100), 8000), L("the goal reads 25%"), `shows ${await pctShown()}%`);
      h = await headerIs();
      ctx.check("derived", h.ok, L(`the overall progress follows (${h.want.avg}%)`), `shows ${JSON.stringify(h.got)}`);

      // ── Edit: closing writes nothing; Update writes what changed ──
      ctx.step(L("press the goal → Edit, change the title and the target, close the form"));
      const before = await row();
      await openSheet(title);
      await hit(s, sheet().getByRole("button", { name: /^edit$/i }));
      await s.page.waitForSelector(t("input-goal-title"), { timeout: 10000 });
      await typeInto(s, t("input-goal-title"), renamed);
      await typeInto(s, t("input-goal-target"), "100");
      await closeForm();
      await sleep(1000);
      const afterClose = await row();
      ctx.check("db", afterClose?.title === title && Number(afterClose?.target) === 200 && afterClose?.updated_at === before?.updated_at, L("closing the edit form writes nothing"), JSON.stringify([afterClose?.title, afterClose?.target]));
      ctx.step(L(`press the goal → Edit, title "${renamed}", target 100, press Update`));
      await openSheet(title);
      await hit(s, sheet().getByRole("button", { name: /^edit$/i }));
      await s.page.waitForSelector(t("input-goal-title"), { timeout: 10000 });
      await typeInto(s, t("input-goal-title"), renamed);
      await typeInto(s, t("input-goal-target"), "100");
      await s.press(t("btn-save-goal"));
      const edited = await waitRow(ctx, "goals", id, (r) => r?.title === renamed && Number(r?.target) === 100);
      ctx.check("db", edited?.title === renamed && Number(edited?.target) === 100 && Number(edited?.current) === 50 && edited?.unit === "pages" && edited?.deadline === deadline && edited?.status === "active",
        L("the row has the new title and target; progress, unit, deadline and status are as they were"), JSON.stringify([edited?.title, edited?.target, edited?.current, edited?.unit, edited?.deadline, edited?.status]));
      ctx.check("screen", await seen(s, renamed, 8000, card), L("the list shows the new title without a reload"));
      ctx.check("derived", await until(async () => (await pctShown()) === 50, 8000), L("50 of 100 reads 50%"), `shows ${await pctShown()}%`);
      h = await headerIs();
      ctx.check("derived", h.ok, L(`the overall progress follows (${h.want.avg}%)`), `shows ${JSON.stringify(h.got)}`);
      // leave and come back inside the app: still the stored values
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/goals", "page-goals");
      ctx.check("screen", await seen(s, renamed, 10000, card) && (await until(async () => (await pctShown()) === 50, 6000)), L("after leaving and reopening Goals (in-app) it still reads the new title and 50%"));

      // ── Delete: two taps ──
      ctx.step(L("press the goal → Edit → Delete (first tap arms), tap again"));
      await openSheet(renamed);
      await hit(s, sheet().getByRole("button", { name: /^edit$/i }));
      await s.press(t("btn-delete-goal"));
      await sleep(900);
      const armed = await row();
      const asks = ctx.check("db", !!armed && armed.deleted_at == null, L("the first tap on Delete only arms it (Rule 8)"));
      if (!asks) tell(s, { severity: "bug", title: "A goal is deleted by the first tap on Delete", detail: "Rule 8: destructive buttons take two taps" });
      else await s.press(t("btn-delete-goal"));
      const gone = await waitRow(ctx, "goals", id, (r) => !r || r.deleted_at != null);
      ctx.check("db", !gone || gone.deleted_at != null, L("the second tap deletes the row"));
      ctx.check("screen", await hidden(s, card, 8000), L("it leaves the list without a reload"));
      h = await headerIs();
      ctx.check("derived", h.ok, L(`the header no longer counts it (${h.want.active} active, ${h.want.avg}%)`), `shows ${JSON.stringify(h.got)}`);
      await closing(ctx, s, L, reloads());
    }
  },
});

// ════════════════════════════════════════════════════════════════════════════
// The dashboard's own controls: Customize (a draft) and dismissing an alert
// ════════════════════════════════════════════════════════════════════════════
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const DEFAULT_EXEC_PREFS = JSON.stringify({ v: 2, active: "main", dashboards: [{ id: "main", name: "Main", quiet: true, hidden: [], order: [], sizes: {} }], widgets: [] });
/** A drag as the surface does it: the mouse held down, or a finger on the glass. */
async function drag(s: any, from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = 12;
  const at = (i: number) => ({ x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: Math.round(from.y + ((to.y - from.y) * i) / steps) });
  if (s.surface === "phone") {
    const cdp = await s.page.context().newCDPSession(s.page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
      for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] }); await sleep(40); }
      await sleep(120);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await cdp.detach().catch(() => undefined); }
  } else {
    await s.page.mouse.move(from.x, from.y);
    await s.page.mouse.down();
    for (let i = 1; i <= steps; i++) { await s.page.mouse.move(at(i).x, at(i).y); await sleep(40); }
    await sleep(120);
    await s.page.mouse.up();
  }
}
/** Where an element is once it has stopped moving (a sheet slides in; a list scrolls). */
const centre = async (s: any, sel: string, scroll = true) => {
  const el = s.page.locator(sel).locator("visible=true").first();
  if (scroll) await el.scrollIntoViewIfNeeded().catch(() => undefined);
  let b = await el.boundingBox();
  for (let i = 0; i < 15; i++) {
    await sleep(150);
    const again = await el.boundingBox();
    if (b && again && Math.abs(again.y - b.y) < 0.5 && Math.abs(again.x - b.x) < 0.5) { b = again; break; }
    b = again;
  }
  if (!b) throw new Error(`not on screen: ${sel}`);
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), top: Math.round(b.y), bottom: Math.round(b.y + b.height) };
};
/** The active dashboard's layout out of the stored preference row. */
const storedLayout = (rowValue: unknown): { hidden: string[]; order: string[]; quiet: boolean | null } => {
  try {
    const v = JSON.parse(String(rowValue ?? ""));
    const d = Array.isArray(v?.dashboards) ? (v.dashboards.find((x: any) => x?.id === v.active) ?? v.dashboards[0]) : v;
    return { hidden: Array.isArray(d?.hidden) ? d.hidden.map(String) : [], order: Array.isArray(d?.order) ? d.order.map(String) : [], quiet: typeof d?.quiet === "boolean" ? d.quiet : null };
  } catch { return { hidden: [], order: [], quiet: null }; }
};
const dismissedIds = (rowValue: unknown): string[] => { try { const v = JSON.parse(String(rowValue ?? "[]")); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };

scenario({
  id: "ui-planning.dashboard",
  title: "The dashboard's controls (mouse and touch): Customize is a draft until Save, a hidden card is named not lost, and a dismissed alert stays dismissed in every shape",
  area: "Browser · planning",
  browser: true,
  covers: ["dashboard.edit.ui", "dashboard.cancel.ui", "dashboard.restore.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    const tell = finder(ctx);
    const original = await prefRow(ctx, "exec_card_prefs");
    const baseline = original?.value != null && String(original.value) !== "" ? String(original.value) : DEFAULT_EXEC_PREFS;
    ctx.cleanup(() => ctx.api("PUT", "/preferences/exec_card_prefs", { value: baseline }));
    const openBell = async (s: any) => { if (!(await s.page.locator(t("panel-notifications")).locator("visible=true").count())) await s.press(t("button-notification-bell")); await s.page.waitForSelector(t("panel-notifications"), { timeout: 10000 }); };
    const closeBell = async (s: any) => { if (await s.page.locator(t("panel-notifications")).locator("visible=true").count()) { await s.page.keyboard.press("Escape"); await hidden(s, t("panel-notifications"), 4000); } };

    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      // Setup (not under test): the layout back at its starting point, one open
      // task so the Tasks card has something to show, two documents about to expire.
      must(await ctx.api("PUT", "/preferences/exec_card_prefs", { value: baseline }), "reset layout");
      const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} ${s.surface} renew passport`, dueDate: O.addDays(ctx.today, 2) }), "task");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
      const mkDoc = async (name: string, days: number) => {
        const d = must(await ctx.api("POST", "/documents", { name, type: "lease", mimeType: "image/png", fileData: PNG_1PX, extractedData: { expirationDate: O.addDays(ctx.today, days) } }), "document");
        ctx.cleanup(() => ctx.api("POST", `/documents/${d.id}/purge`).then(() => ctx.api("DELETE", `/documents/${d.id}`)));
        return d;
      };
      const docA = await mkDoc(`${ctx.tag} ${s.surface} Lease`, 9);
      const docB = await mkDoc(`${ctx.tag} ${s.surface} Permit`, 7);
      ctx.cleanup(async () => {
        const ids = dismissedIds((await prefRow(ctx, "dismissed_notifications"))?.value).filter((x) => x.includes(docA.id) || x.includes(docB.id));
        if (ids.length) await ctx.api("POST", "/notifications/restore", { ids });
      });
      // Reached inside the app (the page asks the server where the account is on
      // every navigation); a layout another surface saved may take a poll to arrive.
      await goto(s, "/tasks", "page-tasks");
      await goto(s, "/dashboard", "page-dashboard");
      await s.page.waitForSelector(t("exec-card-attention"), { timeout: 30000 });
      if (!(await visible(s, t("exec-card-tasks"), 20000))) {
        await goto(s, "/tasks", "page-tasks");
        await sleep(1500);
        await goto(s, "/dashboard", "page-dashboard");
        await visible(s, t("exec-card-tasks"), 45000);
      }
      const reloads = countReloads(s);
      const pref = async () => String((await prefRow(ctx, "exec_card_prefs"))?.value ?? "");
      const start = await pref();
      const openCustomize = async () => {
        await s.press(t("btn-dashboard-menu"));
        await s.press(t("btn-customize"));
        await s.page.waitForSelector(t("exec-customize-list"), { timeout: 10000 });
      };
      const rowOrder = (): Promise<string[]> => s.page.evaluate(() => [...document.querySelectorAll('[data-testid="exec-customize-list"] > li')].map((n) => (n.getAttribute("data-testid") || "").replace("exec-customize-row-", "")));
      // the order the cards are DRAWN in (the grid places them with CSS order): top to bottom, then left to right
      const cardOrder = (): Promise<string[]> => s.page.evaluate(() => [...document.querySelectorAll('[data-testid^="exec-card-"]')]
        .filter((n) => /^exec-card-[a-z]+$/.test(n.getAttribute("data-testid") || "") && !/^exec-card-(count|subtitle)$/.test(n.getAttribute("data-testid") || "") && (n as HTMLElement).getBoundingClientRect().width > 0)
        .map((n) => ({ id: (n.getAttribute("data-testid") || "").slice(10), r: (n as HTMLElement).getBoundingClientRect() }))
        .sort((a, b) => (Math.abs(a.r.top - b.r.top) > 8 ? a.r.top - b.r.top : a.r.left - b.r.left)).map((x) => x.id));
      ctx.check("screen", await visible(s, t("exec-card-tasks"), 15000), L("before: the Tasks card is on the dashboard (it has an open task)"));

      // ── Customize: opening writes nothing; Cancel drops the draft ──
      ctx.step(L(`on the dashboard ⋮ → Customize; switch "Show Tasks" off; press Cancel`));
      await openCustomize();
      await sleep(800);
      ctx.check("db", (await pref()) === start, L("opening Customize writes nothing (Rule 3)"));
      await s.press(t("exec-customize-show-tasks"));
      ctx.check("screen", await until(async () => (await s.page.locator(t("exec-customize-show-tasks")).first().getAttribute("aria-checked")) === "false", 4000), L("the switch turns off in the draft"));
      await s.press(t("exec-customize-cancel"));
      await hidden(s, t("exec-customize-list"), 6000);
      await sleep(1200);
      ctx.check("db", (await pref()) === start, L("Cancel writes nothing: the stored layout is as it was"));
      ctx.check("screen", await visible(s, t("exec-card-tasks"), 4000), L("and the Tasks card is still on the dashboard"));

      // ── Customize: hide a card, reorder by dragging, Save ──
      ctx.step(L(`⋮ → Customize again; switch "Show Tasks" off; drag Money's handle above Needs Attention; press Save Changes`));
      await openCustomize();
      ctx.check("screen", (await s.page.locator(t("exec-customize-show-tasks")).first().getAttribute("aria-checked")) === "true", L("reopened, the cancelled draft is gone (Tasks is on again)"));
      await s.press(t("exec-customize-show-tasks"));
      const handle = await centre(s, t("exec-customize-drag-money"));
      const target = await centre(s, t("exec-customize-row-attention"), false);
      await drag(s, { x: handle.x, y: handle.y }, { x: handle.x, y: target.top + 4 });
      const dragged = await until(async () => { const o = await rowOrder(); return o.indexOf("money") >= 0 && o.indexOf("money") < o.indexOf("attention"); }, 4000);
      const canDrag = ctx.check("screen", dragged, L(`dragging the handle (${s.surface === "phone" ? "a finger" : "the mouse"}) moves Money above Needs Attention in the list`), `the list reads ${(await rowOrder()).join(", ")}`);
      if (!canDrag) {
        tell(s, { severity: "bug", title: "A card cannot be reordered by dragging its handle in Customize", detail: `${s.surface}: pressed the Money row's handle and dragged it to the top of the Needs Attention row; the list still read ${(await rowOrder()).join(", ")}` });
        // the handle also answers the arrow keys: go on with those so Save has an order to store
        ctx.step(L("the drag did not move the row; used the handle's arrow keys instead"));
        const h = s.page.locator(t("exec-customize-drag-money")).first();
        for (let i = 0; i < 4; i++) { await h.focus(); await s.page.keyboard.press("ArrowUp"); await sleep(120); }
      }
      await s.press(t("exec-customize-save"));
      const saved = await until(async () => { const l = storedLayout(await pref()); return l.hidden.includes("tasks"); }, 10000);
      const layout = storedLayout(await pref());
      ctx.check("action", saved, L("Save Changes stored the layout"));
      ctx.check("db", layout.hidden.includes("tasks") && layout.order.indexOf("money") >= 0 && layout.order.indexOf("attention") >= 0 && layout.order.indexOf("money") < layout.order.indexOf("attention"),
        L("the one preference row holds it: Tasks hidden, Money ordered before Needs Attention"), JSON.stringify(layout));
      ctx.check("db", (await ctx.db.count("preferences", "key=eq.exec_card_prefs")) === 1, L("and it is ONE row"));
      await hidden(s, t("exec-customize-list"), 8000);
      ctx.check("screen", await hidden(s, t("exec-card-tasks"), 8000), L("the Tasks card leaves the dashboard without a reload"));
      ctx.check("screen", await visible(s, t("exec-hidden-tasks"), 8000), L("and is named under the grid (hidden never reads as missing)"));
      const orderOk = await until(async () => { const o = await cardOrder(); return o.indexOf("money") >= 0 && o.indexOf("money") < o.indexOf("attention"); }, 8000);
      ctx.check("derived", orderOk, L("the cards are drawn in the stored order: Money before Needs Attention"), (await cardOrder()).join(", "));
      const task0 = await ctx.db.row("tasks", task.id);
      ctx.check("db", !!task0 && task0.deleted_at == null && task0.status === "todo", L("hiding the card touched no task"));
      await s.press(t("exec-hidden-tasks"));
      ctx.check("screen", await seen(s, `${ctx.tag} ${s.surface} renew passport`, 8000, t("executive-briefing")), L("a tap on its name opens the hidden card in place, with the task in it"));
      await goto(s, "/tasks", "page-tasks");
      await goto(s, "/dashboard", "page-dashboard");
      await s.page.waitForSelector(t("exec-card-attention"), { timeout: 20000 });
      ctx.check("screen", (await visible(s, t("exec-hidden-tasks"), 8000)) && !(await s.page.locator(t("exec-card-tasks")).locator("visible=true").count()), L("after leaving and coming back (in-app) the layout is the saved one"));

      // ── Dismiss an alert from Needs Attention ──
      const rowA = `[data-testid^="exec-item-doc:document:${docA.id}:"]`, rowB = `[data-testid^="exec-item-doc:document:${docB.id}:"]`;
      const bellA = `[data-testid^="notification-item-"][data-testid*="${docA.id}"]`, bellB = `[data-testid^="notification-item-"][data-testid*="${docB.id}"]`;
      const dismissedRow = async () => dismissedIds((await prefRow(ctx, "dismissed_notifications"))?.value);
      const both = (await visible(s, rowA, 15000)) && (await visible(s, rowB, 5000));
      ctx.check("screen", both, L("Needs Attention lists both expiring documents (made elsewhere, shown without a reload)"));
      const count0 = await numberIn(s, t("exec-card-count-attention"));
      await openBell(s);
      ctx.check("screen", (await visible(s, bellA, 8000)) && (await visible(s, bellB, 4000)), L("and the bell has a notice for each"));
      await closeBell(s);
      ctx.step(L(`on Needs Attention press the X on "${ctx.tag} ${s.surface} Lease"`));
      await s.press(`[data-testid^="exec-dismiss-doc:document:${docA.id}:"]`);
      const afterA = await (async () => { await until(async () => (await dismissedRow()).some((x) => x.includes(docA.id)), 10000); return dismissedRow(); })();
      ctx.check("action", afterA.some((x) => x.includes(docA.id)), L("the X dismissed the alert"));
      ctx.check("db", afterA.filter((x) => x.includes(docA.id)).length === 1 && !afterA.some((x) => x.includes(docB.id)), L("the server's dismissed list holds that alert's id once, and not the other document's"), JSON.stringify(afterA));
      ctx.check("screen", await hidden(s, rowA, 8000), L("the row leaves Needs Attention"));
      ctx.check("derived", await until(async () => (await numberIn(s, t("exec-card-count-attention"))) === count0 - 1, 8000), L(`the card's count falls by one (${count0} → ${count0 - 1})`), `reads ${await numberIn(s, t("exec-card-count-attention"))}`);
      await openBell(s);
      const twinGone = await hidden(s, bellA, 8000);
      const oneId = ctx.check("screen", twinGone, L("its twin in the bell is gone too, without a reload (one alert, one id)"));
      if (!oneId) tell(s, { severity: "sync", title: "An expiring document dismissed on Needs Attention is still in the bell", detail: "Rule 8: a dated alert has one id whatever shape it takes; the bell kept its notice after the dashboard row was dismissed" });
      ctx.check("screen", await visible(s, bellB, 4000), L("the other document's notice is still there"));

      // ── Dismiss the other from the bell ──
      ctx.step(L(`in the bell press Dismiss on "${ctx.tag} ${s.surface} Permit"`));
      await s.press(`[data-testid^="button-dismiss-"][data-testid*="${docB.id}"]`);
      await until(async () => (await dismissedRow()).some((x) => x.includes(docB.id)), 10000);
      const afterB = await dismissedRow();
      ctx.check("db", afterB.some((x) => x.includes(docB.id)) && afterB.some((x) => x.includes(docA.id)), L("the dismissed list now holds both"), JSON.stringify(afterB));
      ctx.check("screen", await hidden(s, bellB, 8000), L("the notice leaves the bell"));
      await closeBell(s);
      const rowGone = await hidden(s, rowB, 8000);
      const sameStore = ctx.check("screen", rowGone, L("and its row leaves Needs Attention without a reload"));
      if (!sameStore) tell(s, { severity: "sync", title: "An alert dismissed in the bell is still listed on Needs Attention", detail: "the dashboard row stayed after the bell's Dismiss stored the id (Rule 8)" });
      ctx.check("derived", await until(async () => (await numberIn(s, t("exec-card-count-attention"))) === count0 - 2 || (count0 - 2 === 0 && !(await s.page.locator(t("exec-card-count-attention")).locator("visible=true").count())), 8000), L(`the card's count is ${count0 - 2}`), `reads ${await numberIn(s, t("exec-card-count-attention"))}`);
      await goto(s, "/tasks", "page-tasks");
      await goto(s, "/dashboard", "page-dashboard");
      await s.page.waitForSelector(t("exec-card-attention"), { timeout: 20000 });
      await sleep(1500);
      ctx.check("screen", !(await s.page.locator(`${rowA}, ${rowB}`).locator("visible=true").count()), L("after leaving and coming back (in-app) both stay dismissed"));

      // ── Every dismissed alert can be restored ──
      ctx.step(L(`on Needs Attention open the filters; under Dismissed press Restore on the Lease`));
      await s.press(t("attention-filters-toggle"));
      const restore = `[data-testid^="dismissed-alert-restore-"][data-testid*="${docA.id}"]`;
      const listed = await visible(s, restore, 10000);
      ctx.check("screen", listed, L("the dismissed alert is listed with a Restore"), (await wordsOf(s, t("dismissed-alerts"))).slice(0, 200));
      if (listed) {
        await s.press(restore);
        await until(async () => !(await dismissedRow()).some((x) => x.includes(docA.id)), 10000);
        const afterR = await dismissedRow();
        ctx.check("db", !afterR.some((x) => x.includes(docA.id)) && afterR.some((x) => x.includes(docB.id)), L("its id is out of the dismissed list; the other stays dismissed"), JSON.stringify(afterR));
        ctx.check("screen", await visible(s, rowA, 10000), L("its row is back on Needs Attention without a reload"));
        await openBell(s);
        ctx.check("screen", (await visible(s, bellA, 8000)) && !(await s.page.locator(bellB).locator("visible=true").count()), L("and back in the bell (the other is not)"));
        await closeBell(s);
      }
      const n = reloads();
      // Persistence (a reload on purpose): the layout and the dismissal are the server's, not the page's.
      await s.page.reload();
      await s.page.waitForSelector(t("exec-card-attention"), { timeout: 30000 });
      await sleep(2000);
      ctx.check("screen", (await visible(s, t("exec-hidden-tasks"), 10000)) && !(await s.page.locator(t("exec-card-tasks")).locator("visible=true").count()), L("after a reload the saved layout is still the layout"));
      ctx.check("screen", !(await s.page.locator(rowB).locator("visible=true").count()), L("after a reload the dismissed alert is still dismissed"));

      // A reload restores the page's saved snapshot first. A record made on
      // another device since then must still appear (Rule 7: "a saved snapshot
      // is a first paint, not the truth").
      const late = `${ctx.tag} ${s.surface} made before a reload`;
      const lateTask = must(await ctx.api("POST", "/tasks", { title: late, dueDate: O.addDays(ctx.today, 1) }), "task made elsewhere");
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${lateTask.id}`));
      ctx.step(L(`a task is made on another device ("${late}"); the dashboard, loaded a few seconds ago, is reloaded`));
      await s.page.reload();
      await s.page.waitForSelector(t("exec-card-attention"), { timeout: 30000 });
      const openTasksCard = async () => { if (await s.page.locator(t("exec-hidden-tasks")).locator("visible=true").count()) await s.press(t("exec-hidden-tasks")).catch(() => undefined); };
      const t0 = Date.now();
      const shown = await until(async () => { await openTasksCard(); return (await wordsOf(s, t("executive-briefing"))).includes(late) || (await wordsOf(s, t("exec-kpi-next"))).includes(late); }, 20000, 700);
      ctx.step(L(shown ? `the dashboard named it ${Date.now() - t0} ms after the reload` : "20 s after the reload the dashboard had not named it"));
      let afterNav = shown;
      if (!shown) {
        await goto(s, "/tasks", "page-tasks");
        const onTasks = await visible(s, t(`card-task-${lateTask.id}`), 10000);
        await goto(s, "/dashboard", "page-dashboard");
        afterNav = await until(async () => { await openTasksCard(); return (await wordsOf(s, t("executive-briefing"))).includes(late); }, 8000, 700);
        ctx.step(L(`the Tasks page ${onTasks ? "listed" : "did not list"} it; back on the dashboard (in-app) it was ${afterNav ? "there" : "still missing"}`));
      }
      const fresh = ctx.check("screen", shown, L("after a reload the dashboard shows a task made on another device a moment before"), `not named within 20 s${afterNav ? "; it appeared after opening Tasks and coming back" : "; still missing after opening Tasks (which listed it) and coming back"}`);
      if (!fresh) tell(s, { severity: "sync", title: "After a reload the dashboard misses a record made on another device, and in-app navigation does not bring it", detail: `Load the dashboard; within about three minutes create a task from another device (POST /api/tasks); reload the page. The reload restores the saved query cache and sends no /api/dashboard-bootstrap and no /api/tasks (seen in the network log; most likely the restored bootstrap still counts as fresh, so the launch prefetch skips it): the Tasks card, Next Important, Timeline and the "Tasks due" tile keep the pre-write lists. Opening #/tasks fetches and lists the task; going back to the dashboard still does not show it${afterNav ? " (in this run it did appear after that)" : ""} — most likely because the version watch takes its baseline from the first answer after the reload, which already carries the write, so nothing is seen to "rise". Rule 7 says the restored lists are re-seeded by the bootstrap refetch; here there is none. Measured on the isolated stack, 3 of 3 reloads.` });
      await closing(ctx, s, L, n);
    }
  },
});

