// Records, by hand, in a real browser — as a desktop mouse and as a phone with
// touch: trackers and their entries, uploaded documents, notes, journal
// entries, Word documents and other artifacts, characteristics and the AI's
// memory. Every operation a screen offers is driven on that screen and then
// held to: the stored row (read straight from the database), the figures that
// depend on it (worked out here, never copied from the app), the OTHER screens
// that show it (reached inside the app, never by a reload), "opening or
// closing a form writes nothing", one record for a double press, two taps for
// a destructive button (Rule 8) and an honest screen when a request fails.
//
// Not offered by any screen (so not in `covers`):
// - tracker.create.ui — trackers are created from chat only (owner decision
//   2026-05-21: the "+ New Tracker" buttons were removed from
//   client/src/pages/trackers.tsx TrackersPage and profile-detail.tsx
//   TrackersTab; CreateTrackerDialog and QuickCreateFab are mounted nowhere).
//   The scenarios make their tracker through the API and drive the rest.
// - a characteristic VALUE is never added on a record page (D7: the Details
//   panel is gone; RecordDetailsPanel is mounted nowhere). A screen creates a
//   characteristic DEFINITION (/details → New) and edits / removes a value
//   already on a record (DetailValueCells).
// - memory.cancel.ui (clear the assistant conversation): the "new
//   conversation" control (`<testId>-new`, components/workspace/WorkspaceApp.tsx
//   AiConversation) is drawn only once the conversation has turns, and a turn
//   exists only after an AI reply; the isolated stack has no AI provider.
import zlib from "node:zlib";
import { scenario, must, type Ctx } from "../framework";
import * as O from "../oracle";
import { SB_URL, API_BASE } from "../../smoke/fixture/account";
import { fetchWithRateLimitRetry } from "../../smoke/fixture/api";

const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

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
async function pressTwice(s: any, sel: string | any) {
  const el = typeof sel === "string" ? vis(s, sel) : sel;
  await el.waitFor({ timeout: 15000 });
  if (s.surface === "phone") { await el.tap().catch(() => undefined); await el.tap({ timeout: 300 }).catch(() => undefined); }
  else await el.dblclick().catch(() => undefined);
}
async function typeInto(s: any, sel: string, value: string) {
  const el = vis(s, sel);
  await el.waitFor({ timeout: 15000 });
  await el.fill(value);
}
const pageText = async (s: any) => ((await s.page.locator("body").innerText()) as string).replace(/\s+/g, " ");
async function showsText(s: any, text: string, ms = 12000): Promise<boolean> {
  return seen(s.page.getByText(text, { exact: false }).locator("visible=true").first(), ms);
}
async function textGone(s: any, text: string, ms = 10000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const n = await s.page.getByText(text, { exact: false }).locator("visible=true").count().catch(() => 0);
    if (n === 0) return true;
    if (Date.now() > until) return false;
    await sleep(400);
  }
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
  const problems = s.problems().filter((p: string) => !/^5\d\d (GET|POST) \/api\/(workspace|ai|wellness\/insights)/.test(p) || process.env.INTEGRITY_NO_AI !== "1");
  ctx.check("screen", problems.length === 0, L("no script error and no 5xx along the way"), problems.join("; "));
}
/** Fail the NEXT request matching (method, path) once — the network drops it. */
async function failOnce(s: any, method: string, pathRe: RegExp): Promise<{ hit: () => boolean; off: () => Promise<void> }> {
  let hit = false;
  const handler = async (route: any) => {
    const req = route.request();
    if (!hit && req.method() === method && pathRe.test(new URL(req.url()).pathname)) { hit = true; await route.abort("failed"); return; }
    await route.continue();
  };
  await s.page.route("**/api/**", handler);
  return { hit: () => hit, off: () => s.page.unroute("**/api/**", handler) };
}
/** A tracker entry's numbers, whichever envelope the API uses. */
const valuesOf = (row: any) => row?.entry_values ?? row?.values ?? {};
/** The independent pace arithmetic (min/mile to 0.1, mph to 0.01 from the exact pace). */
const paceOf = (miles: number, minutes: number) => ({ pace: Math.round((minutes / miles) * 10) / 10, mph: Math.round((60 / (minutes / miles)) * 100) / 100 });

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-records.tracker",
  title: "A tracker renamed and deleted by hand (mouse and touch): one row changes, the card and Wellness follow without a reload; delete asks first",
  area: "Browser · records",
  browser: true,
  covers: ["tracker.edit.ui", "tracker.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const name = `${ctx.tag} ${s.surface} Rowing`;
      const renamed = `${ctx.tag} ${s.surface} Erg Rowing`;
      // set-up: trackers are created from chat only (see the header); one reading so it is "tracked"
      const tr = must(await ctx.api("POST", "/trackers", { name, category: "fitness", unit: "min", fields: [{ name: "duration", type: "number", unit: "min", isPrimary: true }] }), "tracker");
      ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tr.id}`));
      const minutes = ctx.int(12, 48);
      must(await ctx.api("POST", `/trackers/${tr.id}/entries`, { values: { duration: minutes }, allowDuplicate: true }), "entry");
      const row0 = await ctx.db.row("trackers", tr.id);
      ctx.check("db", !!row0 && row0.deleted_at == null, L("set-up: the tracker row exists"));
      const count0 = await ctx.db.count("trackers", "deleted_at=is.null");

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/trackers", "page-trackers");
      const reloads = watchReloads(s);
      s.problems();
      const card = vis(s, t(`card-tracker-${tr.id}`));
      ctx.check("screen", await seen(card, 15000), L("Trackers lists the tracker made elsewhere (in-app navigation)"));
      const cardText = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", cardText.includes(String(minutes)), L(`its card shows the latest reading, ${minutes}`), cardText.slice(0, 160));

      // opening the detail writes nothing
      ctx.step(L(`open #/trackers, open "${name}", look at Overview and History, close it`));
      await tapIt(s, card);
      const dlg = s.page.locator(t("tracker-detail-dialog"));
      await dlg.waitFor({ timeout: 10000 });
      await tapIt(s, vis(s, t("tab-history")));
      await sleep(800);
      await s.page.keyboard.press("Escape");
      await sleep(1200);
      const row1 = await ctx.db.row("trackers", tr.id);
      ctx.check("db", row1?.updated_at === row0?.updated_at && row1?.name === row0?.name, L("opening the tracker and its tabs writes nothing (Rule 3)"), JSON.stringify({ was: row0?.updated_at, now: row1?.updated_at }));

      // rename: Cancel writes nothing; then the check-mark saves (pressed twice)
      ctx.step(L(`open it again, press the pencil, type "${renamed}", press the X (cancel); pencil again, type it, press the check twice`));
      await tapIt(s, card);
      await dlg.waitFor({ timeout: 10000 });
      await tapIt(s, vis(s, `${t("tracker-detail-dialog")} ${t("button-edit-title")}`));
      const input = vis(s, `${t("tracker-detail-dialog")} .td-header input[type="text"]`);
      await input.fill(renamed);
      await tapIt(s, vis(s, `${t("tracker-detail-dialog")} button[title="Cancel"]`));
      await sleep(1200);
      ctx.check("db", (await ctx.db.row("trackers", tr.id))?.name === row0?.name, L("cancelling the rename writes nothing"));
      await tapIt(s, vis(s, `${t("tracker-detail-dialog")} ${t("button-edit-title")}`));
      await input.fill(renamed);
      await pressTwice(s, `${t("tracker-detail-dialog")} button[title="Save"]`);
      const edited = await waitRow(ctx, "trackers", tr.id, (r) => String(r?.name).toLowerCase() === renamed.toLowerCase());
      ctx.check("action", String(edited?.name).toLowerCase() === renamed.toLowerCase(), L("the rename was saved"), String(edited?.name));
      ctx.check("db", String(edited?.name).toLowerCase() === renamed.toLowerCase() && edited?.category === "fitness" && JSON.stringify(edited?.fields) === JSON.stringify(row0?.fields) && edited?.deleted_at == null,
        L("the row holds the new name; category and fields are untouched"), JSON.stringify({ n: edited?.name, c: edited?.category }));
      const entries1 = await ctx.db.rows("tracker_entries", `tracker_id=eq.${tr.id}&deleted_at=is.null`);
      ctx.check("db", entries1.length === 1 && Number(valuesOf(entries1[0]).duration) === minutes, L("its one entry is untouched by the rename"), JSON.stringify(entries1.map(valuesOf)));
      ctx.same("derived", await ctx.db.count("trackers", "deleted_at=is.null"), count0, L("still the same number of trackers (a rename is not a new tracker, Rule 11)"));
      // the second press of the check lands on the pencil that replaced it and reopens the box: read its value too
      const openBox = s.page.locator(`${t("tracker-detail-dialog")} .td-header input[type="text"]`);
      const boxValue = (await openBox.count()) ? await openBox.first().inputValue().catch(() => "") : "";
      if (boxValue) await openBox.first().press("Escape").catch(() => undefined);
      const titleNow = `${boxValue} ${(await vis(s, `${t("tracker-detail-dialog")} .td-header`).innerText().catch(() => ""))}`.replace(/\s+/g, " ");
      ctx.check("screen", titleNow.toLowerCase().includes(renamed.toLowerCase()), L("the open detail shows the new name"), titleNow.slice(0, 120));
      await s.page.keyboard.press("Escape");
      await sleep(500);
      const cardNow = await card.innerText().catch(() => "");
      ctx.check("screen", cardNow.toLowerCase().includes("erg rowing"), L("the card on #/trackers shows the new name without a reload"), cardNow.replace(/\s+/g, " ").slice(0, 120));
      await goto(s, "/wellness", "");
      const onWell = await showsText(s, "Erg Rowing", 12000) || (await pageText(s)).toLowerCase().includes(renamed.toLowerCase());
      ctx.check("screen", onWell, L("the Wellness tab names the renamed tracker (in-app navigation)"));

      // delete: two taps from the card's detail menu; Cancel keeps it
      await goto(s, "/trackers", "page-trackers");
      ctx.step(L(`open the tracker, ⋯ → Delete, Cancel; ⋯ → Delete, "Delete Tracker"`));
      await tapIt(s, card);
      await dlg.waitFor({ timeout: 10000 });
      await tapIt(s, vis(s, t("button-tracker-detail-menu")));
      await tapIt(s, vis(s, t("button-delete-tracker-detail")));
      const alert = s.page.getByRole("alertdialog");
      await alert.waitFor({ timeout: 8000 });
      ctx.check("db", (await ctx.db.row("trackers", tr.id))?.deleted_at == null, L("the first press only asks (Rule 8)"));
      await tapIt(s, alert.getByRole("button", { name: /^cancel$/i }));
      await sleep(1000);
      ctx.check("db", (await ctx.db.row("trackers", tr.id))?.deleted_at == null, L("Cancel keeps the tracker"));
      if (!(await dlg.isVisible().catch(() => false))) { await tapIt(s, card); await dlg.waitFor({ timeout: 10000 }); }
      await tapIt(s, vis(s, t("button-tracker-detail-menu")));
      await tapIt(s, vis(s, t("button-delete-tracker-detail")));
      await alert.waitFor({ timeout: 8000 });
      await tapIt(s, vis(s, t("button-delete-tracker-confirm")));
      const del = await waitRow(ctx, "trackers", tr.id, (r) => r == null || r.deleted_at != null);
      ctx.check("db", del == null || del.deleted_at != null, L("Delete Tracker removes the tracker row"));
      const left = await ctx.db.count("tracker_entries", `tracker_id=eq.${tr.id}&deleted_at=is.null`);
      ctx.same("derived", left, 0, L("its entries go with it (dependents: deleting a tracker deletes its entries)"));
      ctx.same("derived", await ctx.db.count("trackers", "deleted_at=is.null"), count0 - 1, L("one tracker fewer"));
      ctx.check("screen", await gone(vis(s, t(`card-tracker-${tr.id}`))), L("the card leaves #/trackers without a reload"));
      await goto(s, "/wellness", "");
      await sleep(1500);
      ctx.check("screen", await textGone(s, "Erg Rowing"), L("Wellness no longer names it (in-app navigation)"));
      await goto(s, "/trackers", "page-trackers");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-records.tracker-entry",
  title: "A run logged, edited and deleted by hand (mouse and touch): one entry, pace and speed derived (and re-derived on edit, 11b), count and latest value on every screen",
  area: "Browser · records",
  browser: true,
  covers: ["trackerEntry.create.ui", "trackerEntry.edit.ui", "trackerEntry.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const name = `${ctx.tag} ${s.surface} Running`;
      const tr = must(await ctx.api("POST", "/trackers", { name, category: "fitness", fields: [{ name: "distance", type: "number", unit: "miles", isPrimary: true }, { name: "duration", type: "number", unit: "min" }] }), "tracker");
      ctx.cleanup(() => ctx.api("DELETE", `/trackers/${tr.id}`));
      const miles = ctx.int(15, 45) / 10;            // 1.5 – 4.5 mi
      const minutes = Math.round(miles * ctx.int(8, 12)); // 8 – 12 min/mi
      const miles2 = O.cents(miles + ctx.int(3, 9) / 10);
      const q = `tracker_id=eq.${tr.id}&deleted_at=is.null`;

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/trackers", "page-trackers");
      const reloads = watchReloads(s);
      s.problems();
      const card = vis(s, t(`card-tracker-${tr.id}`));
      // a tracker with no reading yet is listed in the "no data" pile, not as a card
      await seen(vis(s, t("no-data-pile-toggle")), 15000);
      if (!(await s.page.locator(t("no-data-pile-toggle")).locator("..").getByRole("button", { name: new RegExp(`${ctx.tag} ${s.surface} Running`, "i") }).first().isVisible().catch(() => false))) await tapIt(s, vis(s, t("no-data-pile-toggle")));
      const pileItem = s.page.getByRole("button", { name: new RegExp(`${ctx.tag} ${s.surface} Running`, "i") }).locator("visible=true").first();
      ctx.check("screen", await seen(pileItem, 10000), L("the new tracker is listed (no-data pile) on #/trackers"));
      await tapIt(s, pileItem);
      const dlg = s.page.locator(t("tracker-detail-dialog"));
      await dlg.waitFor({ timeout: 10000 });

      // a closed form writes nothing
      ctx.step(L(`open "${name}", press Add, type ${miles} miles and ${minutes} min, press Cancel`));
      await tapIt(s, vis(s, t("button-add-entry-detail")));
      const add = s.page.locator(t(`dialog-add-entry-${tr.id}`));
      await add.waitFor({ timeout: 8000 });
      await typeInto(s, `${t(`dialog-add-entry-${tr.id}`)} ${t("input-entry-distance")}`, String(miles));
      await typeInto(s, `${t(`dialog-add-entry-${tr.id}`)} ${t("input-entry-duration")}`, String(minutes));
      await tapIt(s, vis(s, t("button-entry-cancel")));
      await sleep(1200);
      ctx.same("db", await ctx.db.count("tracker_entries", q), 0, L("Cancel on the Add form stores nothing"));

      // a failed request: nothing stored, nothing shown as saved
      ctx.step(L("press Add again, type the same, press Log Entry while the network drops the request"));
      const fail = await failOnce(s, "POST", new RegExp(`/api/trackers/${tr.id}/entries$`));
      await tapIt(s, vis(s, t("button-add-entry-detail")));
      await add.waitFor({ timeout: 8000 });
      await typeInto(s, `${t(`dialog-add-entry-${tr.id}`)} ${t("input-entry-distance")}`, String(miles));
      await typeInto(s, `${t(`dialog-add-entry-${tr.id}`)} ${t("input-entry-duration")}`, String(minutes));
      await tapIt(s, vis(s, t("button-entry-submit")));
      await sleep(2500);
      await fail.off();
      ctx.check("action", fail.hit(), L("the request was dropped"));
      ctx.same("db", await ctx.db.count("tracker_entries", q), 0, L("a dropped request stores nothing"));
      const header0 = (await vis(s, `${t("tracker-detail-dialog")} .td-header`).innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", /\b0 entries\b/.test(header0), L(`the screen does not claim the entry after the failure ("0 entries")`), header0.slice(0, 120));

      // log it, with a double press
      ctx.step(L(`press Add, type ${miles} miles and ${minutes} min, press Log Entry twice quickly`));
      if (!(await add.isVisible().catch(() => false))) { await tapIt(s, vis(s, t("button-add-entry-detail"))); await add.waitFor({ timeout: 8000 }); }
      await typeInto(s, `${t(`dialog-add-entry-${tr.id}`)} ${t("input-entry-distance")}`, String(miles));
      await typeInto(s, `${t(`dialog-add-entry-${tr.id}`)} ${t("input-entry-duration")}`, String(minutes));
      await pressTwice(s, t("button-entry-submit"));
      await waitRows(ctx, "tracker_entries", q, (n) => n >= 1);
      await sleep(1800);
      const rows = await ctx.db.rows("tracker_entries", q);
      ctx.check("action", rows.length >= 1, L("the form logged an entry"));
      const one = ctx.check("db", rows.length === 1, L("one entry row (a double press of Log Entry)"), `${rows.length} rows`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "A double press of Log Entry stores two tracker entries", detail: `${s.surface}: ${rows.length} rows` });
      const e = rows[0];
      if (!e) { endSurface(ctx, s, L, reloads, ""); continue; }
      for (const twin of rows.slice(1)) must(await ctx.api("DELETE", `/trackers/${tr.id}/entries/${twin.id}`), "remove the twin");
      const v = valuesOf(e);
      const want = paceOf(miles, minutes);
      ctx.check("db", Number(v.distance) === miles && Number(v.duration) === minutes, L(`the row stores ${miles} mi in ${minutes} min`), JSON.stringify(v));
      ctx.near("derived", v.paceMinutesPerMile, want.pace, L(`pace = ${minutes} ÷ ${miles} min/mile`), 0.051);
      ctx.near("derived", v.speedMph, want.mph, L(`speed = ${miles} ÷ ${minutes}/60 mph`), 0.011);
      const header1 = (await vis(s, `${t("tracker-detail-dialog")} .td-header`).innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", /\b1 entry\b/.test(header1), L(`the detail counts "1 entry" without a reload`), header1.slice(0, 120));

      // the history row shows the derived pace
      await tapIt(s, vis(s, t("tab-history")));
      const hrow = vis(s, t(`entry-row-${e.id}`));
      ctx.check("screen", await seen(hrow, 10000), L("History lists the entry"));
      const htext = (await hrow.innerText().catch(() => "")).replace(/\s+/g, " ");
      const paceRe = (n: number) => new RegExp(`Pace Minutes Per Mile: ${String(n).replace(".", "\\.")}(?![0-9.])`);
      ctx.check("screen", htext.includes(String(miles)) && paceRe(want.pace).test(htext), L(`the history row shows ${miles} miles and pace ${want.pace}`), htext.slice(0, 200));

      // edit: change the distance; Cancel first writes nothing
      ctx.step(L(`tap the history row, type ${miles2} miles, press Cancel; tap it again, type ${miles2}, press Save twice`));
      const before = await ctx.db.row("tracker_entries", e.id);
      await tapIt(s, hrow);
      await typeInto(s, t("entry-field-distance"), String(miles2));
      await tapIt(s, vis(s, t(`entry-row-edit-${e.id}`)).getByRole("button", { name: /^cancel$/i }));
      await sleep(1200);
      const afterCancel = await ctx.db.row("tracker_entries", e.id);
      ctx.check("db", afterCancel?.updated_at === before?.updated_at && Number(valuesOf(afterCancel).distance) === miles, L("Cancel on the entry editor writes nothing"));
      await tapIt(s, vis(s, t(`entry-row-${e.id}`)));
      await typeInto(s, t("entry-field-distance"), String(miles2));
      await pressTwice(s, t(`entry-save-${e.id}`));
      const ed = await waitRow(ctx, "tracker_entries", e.id, (r) => Number(valuesOf(r).distance) === miles2);
      const ev = valuesOf(ed);
      const want2 = paceOf(miles2, minutes);
      ctx.check("action", Number(ev.distance) === miles2, L("the edit was saved"));
      ctx.check("db", Number(ev.distance) === miles2 && Number(ev.duration) === minutes && ed?.deleted_at == null, L(`the row now stores ${miles2} mi, duration untouched`), JSON.stringify(ev));
      const ok11b = ctx.near("derived", ev.paceMinutesPerMile, want2.pace, L(`pace re-derived from the edit: ${minutes} ÷ ${miles2} (11b)`), 0.051);
      ctx.near("derived", ev.speedMph, want2.mph, L(`speed re-derived from the edit`), 0.011);
      if (!ok11b) ctx.finding({ severity: "bug", title: "An edited run keeps its old pace (rule 11b)", detail: `${s.surface}: ${miles}→${miles2} mi in ${minutes} min stored pace ${ev.paceMinutesPerMile}, want ${want2.pace}` });
      ctx.same("db", await ctx.db.count("tracker_entries", q), 1, L("still one entry (an edit is not a new entry)"));
      const hrow2 = vis(s, t(`entry-row-${e.id}`));
      let htext2 = "";
      for (let i = 0; i < 20; i++) { htext2 = (await hrow2.innerText().catch(() => "")).replace(/\s+/g, " "); if (paceRe(want2.pace).test(htext2)) break; await sleep(500); }
      ctx.check("screen", htext2.includes(String(miles2)) && paceRe(want2.pace).test(htext2) && (want.pace === want2.pace || !paceRe(want.pace).test(htext2)), L(`the history row shows ${miles2} miles and the new pace ${want2.pace} without a reload`), htext2.slice(0, 200));
      await s.page.keyboard.press("Escape");
      await sleep(500);
      const cardText = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", cardText.includes(String(miles2)), L(`the card's latest value is ${miles2} without a reload`), cardText.slice(0, 160));
      await goto(s, "/wellness", "");
      const wellText = await pageText(s);
      ctx.step(L(`#/wellness: ${wellText.includes(String(miles2)) ? "shows" : "does not show"} ${miles2}`));
      ctx.check("screen", await showsText(s, String(miles2), 12000), L(`the Wellness tab shows the edited distance ${miles2} (in-app navigation)`));

      // delete the entry: two taps; Cancel keeps
      await goto(s, "/trackers", "page-trackers");
      ctx.step(L("open the tracker's History, press the entry's delete, Cancel; delete again, confirm"));
      await seen(card, 10000);
      await tapIt(s, card);
      await dlg.waitFor({ timeout: 10000 });
      await tapIt(s, vis(s, t("tab-history")));
      await tapIt(s, vis(s, t(`button-delete-entry-${e.id}`)));
      await vis(s, t(`alert-delete-entry-${e.id}`)).waitFor({ timeout: 8000 });
      ctx.check("db", (await ctx.db.row("tracker_entries", e.id))?.deleted_at == null, L("the first press only asks (Rule 8)"));
      await tapIt(s, vis(s, t("button-delete-entry-cancel")));
      await sleep(1000);
      ctx.check("db", (await ctx.db.row("tracker_entries", e.id))?.deleted_at == null, L("Cancel keeps the entry"));
      await tapIt(s, vis(s, t(`button-delete-entry-${e.id}`)));
      await tapIt(s, vis(s, t("button-delete-entry-confirm")));
      const d = await waitRows(ctx, "tracker_entries", q, (n) => n === 0);
      ctx.same("db", d.length, 0, L("the confirmed delete removes the entry"));
      ctx.check("db", (await ctx.db.row("trackers", tr.id))?.deleted_at == null, L("the tracker itself stays"));
      ctx.check("screen", await gone(vis(s, t(`entry-row-${e.id}`))), L("the entry leaves History without a reload"));
      const header2 = (await vis(s, `${t("tracker-detail-dialog")} .td-header`).innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", /\b0 entries\b/.test(header2), L(`the detail counts "0 entries"`), header2.slice(0, 120));
      await s.page.keyboard.press("Escape");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ── files made here, byte for byte ────────────────────────────────────────────
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function makePdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 20 70 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
/**
 * The stored file, read straight from the storage bucket; null when the bucket
 * says there is no such object. The bucket is the server's (the account's own
 * token is refused by its policy), so this reads with the isolated stack's
 * service key — and refuses to guess without one.
 */
async function storedFile(path: string): Promise<Buffer | null> {
  const key = process.env.ISOLATED_SERVICE_KEY;
  if (!key) throw new Error("reading the documents bucket needs ISOLATED_SERVICE_KEY (the isolated stack)");
  const { response: r } = await fetchWithRateLimitRetry(`${SB_URL}/storage/v1/object/authenticated/documents/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  const body = Buffer.from(await r.arrayBuffer());
  if (r.ok) return body;
  if (/NoSuchKey|not_found/i.test(body.toString("utf8"))) return null;
  throw new Error(`storage read ${path}: ${r.status} ${body.toString("utf8").slice(0, 160)}`);
}
const statNum = async (s: any, id: string) => Number(((await vis(s, t(id)).innerText().catch(() => "")) as string).replace(/[^0-9]/g, "") || NaN);
async function artifactStats(s: any) {
  await vis(s, t("artifacts-summary")).waitFor({ timeout: 20000 });
  // the tiles read "…" until both lists have loaded
  for (let i = 0; i < 30; i++) { if (/\d/.test(await vis(s, t("artifacts-stat-showing")).innerText().catch(() => ""))) break; await sleep(400); }
  return { total: await statNum(s, "artifacts-stat-showing"), files: await statNum(s, "artifacts-stat-files"), made: await statNum(s, "artifacts-stat-artifacts"), starred: await statNum(s, "artifacts-stat-starred") };
}
async function waitStats(s: any, ok: (x: Awaited<ReturnType<typeof artifactStats>>) => boolean, ms = 12000) {
  const until = Date.now() + ms;
  for (;;) {
    const x = await artifactStats(s);
    if (ok(x) || Date.now() > until) return x;
    await sleep(500);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-records.document",
  title: "A document uploaded, renamed, dated and deleted by hand (mouse and touch): the bytes in storage, the row, the Artifacts counts and the expiration alert follow without a reload",
  area: "Browser · records",
  browser: true,
  covers: ["document.create.ui", "document.edit.ui", "document.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const isPhone = s.surface === "phone";
      const fileName = `${ctx.tag} ${s.surface} ${isPhone ? "lease.pdf" : "warranty.png"}`;
      const mimeType = isPhone ? "application/pdf" : "image/png";
      const bytes = isPhone ? makePdf(`${ctx.tag} lease`) : makePng(6, 5, [ctx.int(0, 255), ctx.int(0, 255), 90]);
      const renamed = `${ctx.tag} ${s.surface} renamed ${isPhone ? "lease" : "warranty"}`;
      const soon = O.addDays(ctx.today, ctx.int(5, 12));
      const later = O.addDays(ctx.today, ctx.int(300, 340));
      const q = `name=eq.${enc(fileName)}&deleted_at=is.null`;
      const dbFiles0 = await ctx.db.count("documents", "deleted_at=is.null");

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/artifacts", "");
      const reloads = watchReloads(s);
      s.problems();
      const st0 = await artifactStats(s);
      ctx.check("derived", st0.total === st0.files + st0.made, L(`Artifacts: Total = Files + Notes & reports (${st0.total} = ${st0.files} + ${st0.made}) (AR4)`), JSON.stringify(st0));

      // a dropped upload stores nothing and shows nothing
      await goto(s, "/linked?tab=documents", "page-trackers");
      ctx.step(L(`open #/linked?tab=documents, pick "${fileName}" while the network drops the upload`));
      const input = s.page.locator(t("input-upload-document-global")).first();
      await input.waitFor({ state: "attached", timeout: 15000 });
      const fail = await failOnce(s, "POST", /\/api\/upload$/);
      await input.setInputFiles({ name: fileName, mimeType, buffer: bytes });
      await sleep(3000);
      await fail.off();
      ctx.check("action", fail.hit(), L("the upload request was dropped"));
      ctx.same("db", await ctx.db.count("documents", q), 0, L("a dropped upload stores no document row"));
      ctx.check("screen", !(await s.page.getByText(fileName).locator("visible=true").count()), L("the dropped upload is not listed"));
      ctx.check("screen", await showsText(s, "Upload failed", 6000), L(`the screen says "Upload failed"`));

      // the real upload
      ctx.step(L(`pick "${fileName}" (${bytes.length} bytes, ${mimeType}) in the Upload control`));
      await input.setInputFiles({ name: fileName, mimeType, buffer: bytes });
      await waitRows(ctx, "documents", q, (n) => n >= 1, 20000);
      await sleep(1500);
      const rows = await ctx.db.rows("documents", q);
      for (const r of rows) ctx.cleanup(() => ctx.api("POST", `/documents/${r.id}/purge`));
      ctx.check("action", rows.length >= 1, L("the upload made a document"));
      ctx.check("db", rows.length === 1 && rows[0].mime_type === mimeType && !!rows[0].storage_path, L(`one document row, ${mimeType}, with a storage path`), JSON.stringify(rows.map((r: any) => [r.mime_type, r.storage_path])));
      const doc = rows[0];
      if (!doc) { endSurface(ctx, s, L, reloads, ""); continue; }
      const blob = await storedFile(doc.storage_path);
      ctx.check("db", !!blob && blob.equals(bytes), L(`the bucket holds the uploaded file byte for byte (${bytes.length} bytes)`), blob ? `${blob.length} bytes, equal=${blob.equals(bytes)}` : "no object");
      ctx.same("derived", await ctx.db.count("documents", "deleted_at=is.null"), dbFiles0 + 1, L("one more document on the account"));
      ctx.check("screen", await seen(vis(s, t(`global-doc-${doc.id}`)), 12000), L("the Documents tab lists it without a reload"));
      await goto(s, "/artifacts", "");
      const st1 = await waitStats(s, (x) => x.files === st0.files + 1);
      ctx.check("screen", st1.total === st0.total + 1 && st1.files === st0.files + 1 && st1.made === st0.made, L(`Artifacts: Total ${st0.total}→${st0.total + 1}, Files ${st0.files}→${st0.files + 1}, Notes & reports unchanged`), JSON.stringify(st1));
      ctx.check("screen", await seen(vis(s, t(`artifact-card-${doc.id}`)), 10000), L("the Artifacts tab lists the file"));

      // edit: rename (Escape cancels), then a date
      await goto(s, `/documents/${doc.id}`, "page-document-detail");
      const docRow0 = await ctx.db.row("documents", doc.id);
      ctx.step(L(`open the document, open the Overview, press the pencil by the name, type "${renamed}", press Escape; pencil again, type it, press Enter`));
      await tapIt(s, vis(s, t("tab-doc-overview")));
      await tapIt(s, vis(s, t("button-edit-heading-doc-name")));
      await typeInto(s, `input${t("heading-doc-name")}`, renamed);
      await vis(s, `input${t("heading-doc-name")}`).press("Escape");
      await sleep(1200);
      const r1 = await ctx.db.row("documents", doc.id);
      ctx.check("db", r1?.name === fileName && r1?.updated_at === docRow0?.updated_at, L("Escape writes nothing; opening the document wrote nothing (Rule 3)"), JSON.stringify({ n: r1?.name, u: r1?.updated_at, was: docRow0?.updated_at }));
      await tapIt(s, vis(s, t("button-edit-heading-doc-name")));
      await typeInto(s, `input${t("heading-doc-name")}`, renamed);
      await vis(s, `input${t("heading-doc-name")}`).press("Enter");
      const r2 = await waitRow(ctx, "documents", doc.id, (r) => r?.name === renamed);
      ctx.check("action", r2?.name === renamed, L("the rename was saved"));
      ctx.check("db", r2?.name === renamed && r2?.storage_path === doc.storage_path && r2?.mime_type === mimeType && r2?.deleted_at == null, L("the row holds the new name; the file is untouched"));

      ctx.step(L(`Extracted Data → Add field "expirationDate" = ${soon}`));
      await tapIt(s, vis(s, t("tab-doc-data")));
      await tapIt(s, vis(s, t("btn-add-field")));
      await typeInto(s, t("input-new-field-key"), "expirationDate");
      await typeInto(s, t("input-new-field-value"), soon);
      await vis(s, t("input-new-field-value")).press("Enter");
      const r3 = await waitRow(ctx, "documents", doc.id, (r) => r?.extracted_data?.expirationDate === soon);
      ctx.check("db", r3?.extracted_data?.expirationDate === soon && r3?.name === renamed, L(`the row stores expirationDate ${soon}; the name is kept`), JSON.stringify({ x: r3?.extracted_data, n: r3?.name }));
      // derived: an expiration within two weeks is something to attend to (Rule 5).
      // Anywhere on the dashboard (on a phone Needs Attention can sit below the Next Important bar).
      await goto(s, "/dashboard", "page-dashboard");
      const inAttention = await seen(s.page.locator("main").getByText(new RegExp(`${ctx.tag} ${s.surface} renamed`, "i")).locator("visible=true").first(), 15000);
      if (!inAttention) ctx.step(L(`dashboard text: ${(await vis(s, t("exec-overview")).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600)}`));
      ctx.check("derived", inAttention, L(`expiring ${soon} (under two weeks), the dashboard lists it (in-app navigation)`));

      ctx.step(L(`back on the document's Extracted Data, tap the date, type ${later}, press Enter`));
      await goto(s, `/documents/${doc.id}`, "page-document-detail");
      await tapIt(s, vis(s, t("tab-doc-data")));
      await tapIt(s, vis(s, t("value-field-expirationDate")));
      await typeInto(s, t("input-field-expirationDate"), later);
      await vis(s, t("input-field-expirationDate")).press("Enter");
      const r4 = await waitRow(ctx, "documents", doc.id, (r) => r?.extracted_data?.expirationDate === later);
      ctx.check("db", r4?.extracted_data?.expirationDate === later && r4?.name === renamed, L(`the row stores the moved date ${later}`), JSON.stringify(r4?.extracted_data));
      await goto(s, "/dashboard", "page-dashboard");
      await sleep(2000);
      const stillAttention = await s.page.locator("main").getByText(new RegExp(`${ctx.tag} ${s.surface} renamed`, "i")).locator("visible=true").count();
      ctx.check("derived", stillAttention === 0, L(`moved to ${later}, it leaves the dashboard (an expiration ~a year out is not due)`), `${stillAttention} rows still`);
      await goto(s, "/artifacts", "");
      ctx.check("screen", await showsText(s, renamed, 12000), L("the Artifacts tab shows the new name without a reload"));

      // delete from the Artifacts tab: two taps; the dialog promises the file goes
      ctx.step(L("on #/artifacts open the file's ⋯, Delete…, Cancel; ⋯ → Delete… → Delete"));
      await tapIt(s, vis(s, t(`button-more-${doc.id}`)));
      await tapIt(s, vis(s, t(`button-delete-${doc.id}`)));
      const alert = s.page.getByRole("alertdialog");
      await alert.waitFor({ timeout: 8000 });
      const promise = (await alert.innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("db", (await ctx.db.row("documents", doc.id))?.deleted_at == null, L("the first press only asks (Rule 8)"));
      await tapIt(s, alert.getByRole("button", { name: /^cancel$/i }));
      await sleep(1000);
      ctx.check("db", (await ctx.db.row("documents", doc.id))?.deleted_at == null, L("Cancel keeps the document"));
      await tapIt(s, vis(s, t(`button-more-${doc.id}`)));
      await tapIt(s, vis(s, t(`button-delete-${doc.id}`)));
      await alert.waitFor({ timeout: 8000 });
      await tapIt(s, vis(s, t("button-artifact-delete-confirm")));
      const d = await waitRow(ctx, "documents", doc.id, (r) => r == null || r.deleted_at != null);
      ctx.check("db", d == null || d.deleted_at != null, L("Delete removes the document row from the account"));
      let after: Buffer | null = blob;
      for (let i = 0; i < 16 && after; i++) { after = await storedFile(doc.storage_path); if (after) await sleep(500); }
      const fileGone = ctx.check("db", after == null, L(`the stored file is gone, as the dialog said ("${promise.slice(0, 90)}")`), `${after?.length} bytes still in the bucket`);
      if (!fileGone) ctx.finding({ severity: "bug", title: "Deleting a file from the Artifacts tab keeps its bytes in storage", detail: `${s.surface}: the confirmation reads "${promise.slice(0, 140)}", but DELETE /api/documents/:id only soft-deletes (server/supabase-storage.ts deleteDocument keeps the blob until purgeDocument) and no screen offers a restore or a purge: the file stays in the bucket for good.` });
      ctx.same("derived", await ctx.db.count("documents", "deleted_at=is.null"), dbFiles0, L("the account's document count is back where it started"));
      ctx.check("screen", await gone(vis(s, t(`artifact-card-${doc.id}`))), L("it leaves the Artifacts tab without a reload"));
      const st2 = await waitStats(s, (x) => x.files === st0.files);
      ctx.check("screen", st2.total === st0.total && st2.files === st0.files, L(`Artifacts counts are back to Total ${st0.total}, Files ${st0.files}`), JSON.stringify(st2));
      await goto(s, "/linked?tab=documents", "page-trackers");
      await sleep(1500);
      ctx.check("screen", !(await s.page.locator(t(`global-doc-${doc.id}`)).locator("visible=true").count()), L("the Documents tab no longer lists it (in-app navigation)"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ── the full-screen workspaces ────────────────────────────────────────────────
async function startNewNote(s: any) {
  if (!(await s.page.locator(t("button-note-new")).locator("visible=true").count())) {
    if (await s.page.locator(t("button-notes-list")).locator("visible=true").count()) await tapIt(s, vis(s, t("button-notes-list")));
  }
  await tapIt(s, vis(s, t("button-note-new")));
  await vis(s, t("note-rich-editor")).waitFor({ timeout: 10000 });
}
async function typeInEditor(s: any, sel: string, text: string) {
  const ed = vis(s, sel);
  await tapIt(s, ed);
  await s.page.keyboard.press("End").catch(() => undefined);
  await s.page.keyboard.type(text, { delay: 5 });
}
const noteRows = (ctx: Ctx, title: string) => ctx.db.rows("artifacts", `title=eq.${enc(title)}&deleted_at=is.null`);

scenario({
  id: "ui-records.note",
  title: "A note written, edited and deleted in the Notes workspace (mouse and touch): autosave and Save make ONE note, the X saves then leaves, a failed save warns, delete takes two taps",
  area: "Browser · records",
  browser: true,
  covers: ["note.create.ui", "note.edit.ui", "note.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} packing list`;
      const first = `Passport and ${ctx.int(2, 9)} chargers`;
      const second = ` plus sunscreen ${ctx.int(10, 99)}`;
      const third = ` and the ${ctx.pick(["blue", "green", "red"])} hat`;
      const notes0 = await ctx.db.count("artifacts", "type=eq.note&deleted_at=is.null");

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/artifacts", "");
      const reloads = watchReloads(s);
      s.problems();
      const st0 = await artifactStats(s);

      // opening writes nothing (W3)
      await goto(s, "/workspace/notes?tab=editor", "workspace-notes");
      await sleep(2500);
      ctx.same("db", await ctx.db.count("artifacts", "type=eq.note&deleted_at=is.null"), notes0, L("opening the Notes workspace writes nothing (Rule 3)"));

      // write: title, text, then Save pressed twice while the autosave also runs → ONE note
      ctx.step(L(`New note, type the title "${title}" and the text "${first}", press Save twice quickly`));
      await startNewNote(s);
      await typeInto(s, t("input-note-title"), title);
      await typeInEditor(s, t("note-rich-editor"), first);
      await pressTwice(s, t("button-workspace-save"));
      await waitRows(ctx, "artifacts", `title=eq.${enc(title)}&deleted_at=is.null`, (n) => n >= 1);
      await sleep(2500); // past the autosave pause too
      let rows = await noteRows(ctx, title);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/notes/${r.id}`));
      ctx.check("action", rows.length >= 1, L("the note was saved"));
      const one = ctx.check("db", rows.length === 1 && rows[0].type === "note" && String(rows[0].content).includes(first), L("ONE note row holding the text (autosave + a double Save share one chain, W11)"), `${rows.length} rows ${JSON.stringify(rows.map((r: any) => [r.type, String(r.content).slice(0, 60)]))}`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "Save and autosave in the Notes workspace make two notes", detail: `${s.surface}: ${rows.length} rows for one new note` });
      const note = rows[0];
      if (!note) { endSurface(ctx, s, L, reloads, ""); continue; }
      ctx.same("derived", await ctx.db.count("artifacts", "type=eq.note&deleted_at=is.null"), notes0 + 1, L("one more note on the account"));
      ctx.check("screen", await seen(vis(s, t("workspace-save-status")).filter({ hasText: /saved/i }), 8000), L(`the header says "Saved"`));

      // edit: more text, autosave → the SAME row
      ctx.step(L(`type "${second}" and wait for the autosave`));
      await typeInEditor(s, t("note-rich-editor"), second);
      const e1 = await waitRow(ctx, "artifacts", note.id, (r) => String(r?.content).includes(second.trim()));
      ctx.check("db", String(e1?.content).includes(first) && String(e1?.content).includes(second.trim()) && e1?.title === title, L("the autosave updated the same note (text appended, title kept)"), String(e1?.content).slice(0, 120));
      ctx.same("db", (await noteRows(ctx, title)).length, 1, L("still one note after the autosave (W3: it updates THAT note)"));

      // a failed save: the X does not discard, it warns (W2)
      ctx.step(L(`type "${third}", press the X while the network drops the save`));
      const fail = await failOnce(s, "PATCH", new RegExp(`/api/notes/${note.id}$`));
      await typeInEditor(s, t("note-rich-editor"), third);
      await tapIt(s, vis(s, t("button-workspace-close")));
      await sleep(2500);
      await fail.off();
      ctx.check("action", fail.hit(), L("the save request was dropped"));
      const warned = await seen(vis(s, t("workspace-unsaved-warning")), 6000);
      const stillOpen = (await s.page.evaluate(() => location.hash)).startsWith("#/workspace/notes");
      ctx.check("screen", warned && stillOpen, L(`the workspace stays open and says the change was not saved (W2)`), `warned=${warned} hash=${await s.page.evaluate(() => location.hash)}`);
      ctx.check("db", !String((await ctx.db.row("artifacts", note.id))?.content).includes(third.trim()), L("the dropped save stored nothing"));
      if (warned) await tapIt(s, vis(s, t("button-unsaved-stay")));

      // the X saves, then leaves
      ctx.step(L("press the X again (the network is back)"));
      await tapIt(s, vis(s, t("button-workspace-close")));
      await s.page.waitForFunction(() => location.hash.startsWith("#/chat"), undefined, { timeout: 15000 }).catch(() => undefined);
      ctx.check("screen", (await s.page.evaluate(() => location.hash)).startsWith("#/chat"), L("the X leaves for Chat"));
      const e2 = await waitRow(ctx, "artifacts", note.id, (r) => String(r?.content).includes(third.trim()));
      ctx.check("db", String(e2?.content).includes(third.trim()) && String(e2?.content).includes(first), L("the X saved what was pending before leaving (W2)"), String(e2?.content).slice(0, 160));
      ctx.same("db", (await noteRows(ctx, title)).length, 1, L("still one note"));

      // other screens, without a reload
      await goto(s, "/artifacts", "");
      const st1 = await waitStats(s, (x) => x.made === st0.made + 1);
      ctx.check("screen", st1.made === st0.made + 1 && st1.total === st0.total + 1 && st1.files === st0.files, L(`Artifacts: Notes & reports ${st0.made}→${st0.made + 1}, Total ${st0.total}→${st0.total + 1}, Files unchanged`), JSON.stringify(st1));
      ctx.check("screen", await seen(vis(s, t(`artifact-card-${note.id}`)), 10000), L("the Artifacts tab lists the note"));

      // delete: two taps in the workspace
      ctx.step(L("open the note in Notes, press Delete once, wait; press Delete twice"));
      await goto(s, `/workspace/notes?note=${note.id}`, "workspace-notes");
      await vis(s, t("button-note-delete")).waitFor({ timeout: 15000 });
      await tapIt(s, vis(s, t("button-note-delete")));
      await sleep(1200);
      ctx.check("db", (await ctx.db.row("artifacts", note.id))?.deleted_at == null, L("one tap only arms the delete (Rule 8)"));
      // let the arm lapse, then two taps
      await sleep(4500);
      await tapIt(s, vis(s, t("button-note-delete")));
      await tapIt(s, vis(s, t("button-note-delete")));
      const d = await waitRow(ctx, "artifacts", note.id, (r) => r == null || r.deleted_at != null);
      ctx.check("db", d == null || d.deleted_at != null, L("two taps delete the note"));
      ctx.same("derived", await ctx.db.count("artifacts", "type=eq.note&deleted_at=is.null"), notes0, L("the account's note count is back"));
      await goto(s, "/artifacts", "");
      const st2 = await waitStats(s, (x) => x.made === st0.made);
      ctx.check("screen", st2.made === st0.made && st2.total === st0.total, L("Artifacts counts are back"), JSON.stringify(st2));
      ctx.check("screen", !(await s.page.locator(t(`artifact-card-${note.id}`)).locator("visible=true").count()), L("the note left the Artifacts tab"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

const journalRows = (ctx: Ctx, s: any) => ctx.db.rows("journal_entries", `content=ilike.*${enc(`${ctx.tag} ${s.surface}`)}*&deleted_at=is.null&order=created_at.asc`);
async function writeFreeEntry(s: any, title: string, text: string) {
  if (!(await s.page.locator(t("input-journal-free-text")).locator("visible=true").count())) {
    await tapIt(s, vis(s, t("button-new-journal")));
    if (await s.page.locator(t("btn-journal-mode-free")).locator("visible=true").count()) await tapIt(s, vis(s, t("btn-journal-mode-free")));
  }
  await typeInto(s, t("input-journal-title"), title);
  await typeInto(s, t("input-journal-free-text"), text);
}

scenario({
  id: "ui-records.journal",
  title: "Journal entries by hand (mouse and touch): two on one day stay two (J1), an edit changes only its entry, delete asks first; Past Entries follows without a reload",
  area: "Browser · records",
  browser: true,
  covers: ["journal.create.ui", "journal.edit.ui", "journal.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const textA = `${ctx.tag} ${s.surface} morning: walked ${ctx.int(2, 6)} km by the river`;
      const textB = `${ctx.tag} ${s.surface} evening: read ${ctx.int(10, 60)} pages`;
      const textA2 = `${textA}, then coffee with Sam`;
      const titleA = `${ctx.tag} river walk`, titleB = `${ctx.tag} reading`;
      const today0 = await ctx.db.count("journal_entries", `date=eq.${ctx.today}&deleted_at=is.null`);

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/journal", "");
      const reloads = watchReloads(s);
      s.problems();
      await sleep(1500);
      ctx.same("db", (await journalRows(ctx, s)).length, 0, L("opening the Journal writes nothing"));

      // a failed Save: no success shown; the words stay in the form
      ctx.step(L(`New Entry (free write), title "${titleA}", text "${textA}", press Save while the network drops it`));
      await writeFreeEntry(s, titleA, textA);
      const fail = await failOnce(s, "POST", /\/api\/journal$/);
      await tapIt(s, vis(s, t("button-save-journal-free")));
      await sleep(1200);
      await fail.off();
      ctx.check("action", fail.hit(), L("the save was dropped"));
      ctx.check("screen", await showsText(s, "Couldn't save entry", 5000), L(`the screen says "Couldn't save entry"`));
      ctx.check("screen", (await vis(s, t("input-journal-free-text")).inputValue().catch(() => "")) === textA, L("the text is still in the form"));

      // now the save goes through (the autosave may land first: still ONE entry)
      await pressTwice(s, t("button-save-journal-free"));
      await waitRows(ctx, "journal_entries", `content=eq.${enc(textA)}&deleted_at=is.null`, (n) => n >= 1);
      await sleep(3000);
      let rows = await journalRows(ctx, s);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/journal/${r.id}`));
      ctx.check("action", rows.length >= 1, L("the entry was saved"));
      ctx.check("db", rows.length === 1 && rows[0].content === textA && rows[0].date === ctx.today, L("ONE entry row, today, with the words as typed (a failed save, an autosave and a double press)"), JSON.stringify(rows.map((r: any) => [r.date, r.title, r.content])));
      const a = rows[0];

      // a second entry the same day is its own row (J1)
      ctx.step(L(`New Entry again, title "${titleB}", text "${textB}", press Save`));
      await writeFreeEntry(s, titleB, textB);
      await tapIt(s, vis(s, t("button-save-journal-free")));
      await waitRows(ctx, "journal_entries", `content=eq.${enc(textB)}&deleted_at=is.null`, (n) => n >= 1);
      await sleep(2500);
      rows = await journalRows(ctx, s);
      for (const r of rows) if (r.id !== a?.id) ctx.cleanup(() => ctx.api("DELETE", `/journal/${r.id}`));
      const b = rows.find((r: any) => r.content === textB);
      const aNow = rows.find((r: any) => r.id === a?.id);
      ctx.check("db", rows.length === 2 && !!b && aNow?.content === textA && b.date === ctx.today, L("two rows on the same day; the first is untouched (J1)"), JSON.stringify(rows.map((r: any) => r.content)));
      ctx.same("derived", await ctx.db.count("journal_entries", `date=eq.${ctx.today}&deleted_at=is.null`), today0 + 2, L("today holds two more entries"));
      ctx.check("db", aNow?.title === titleA && b?.title === titleB, L("each keeps the title typed for it (J8)"), JSON.stringify([aNow?.title, b?.title]));
      if (!a || !b) { endSurface(ctx, s, L, reloads, ""); continue; }
      ctx.check("screen", await seen(vis(s, t(`card-journal-${a.id}`))) && await seen(vis(s, t(`card-journal-${b.id}`))), L("both cards are listed without a reload"));

      // edit A only
      ctx.step(L(`press the pencil on "${titleA}", change the text to "${textA2}", press Update Entry`));
      const bBefore = await ctx.db.row("journal_entries", b.id);
      await tapIt(s, vis(s, t(`button-edit-journal-${a.id}`)));
      await typeInto(s, t("input-journal-free-text"), textA2);
      await tapIt(s, vis(s, t("button-save-journal-free")));
      const ea = await waitRow(ctx, "journal_entries", a.id, (r) => r?.content === textA2);
      ctx.check("action", ea?.content === textA2, L("the edit was saved"));
      const bAfter = await ctx.db.row("journal_entries", b.id);
      ctx.check("db", ea?.content === textA2 && ea?.date === ctx.today && bAfter?.content === textB && bAfter?.updated_at === bBefore?.updated_at, L("the edit changed only its own entry (J1)"), JSON.stringify({ a: ea?.content, b: bAfter?.content }));
      ctx.same("db", (await journalRows(ctx, s)).length, 2, L("still two entries"));
      let cardA = "";
      const tEdit = Date.now();
      for (let i = 0; i < 30; i++) { cardA = (await vis(s, t(`card-journal-${a.id}`)).innerText().catch(() => "")).replace(/\s+/g, " "); if (cardA.includes("coffee with Sam")) break; await sleep(500); }
      ctx.step(L(`the card ${cardA.includes("coffee with Sam") ? `showed the edit after ${Date.now() - tEdit} ms` : "never showed the edit in 15 s"}`));
      const okCard = ctx.check("screen", cardA.includes("coffee with Sam"), L("the card shows the edited text without a reload (within 15 s)"), cardA.slice(0, 160));
      if (!okCard) ctx.finding({ severity: "sync", title: "An edited journal entry keeps its old text on #/journal", detail: `${s.surface}: the row stores the edit, the card still read "${cardA.slice(0, 120)}" 15 s later` });

      // the Journal workspace's Past Entries reads the same rows
      await goto(s, "/workspace/journal?tab=past", "");
      if (!(await s.page.locator(t("workspace-tab-past")).count())) ctx.step(L("no Past Entries tab id"));
      if (await s.page.locator(t("workspace-tab-past")).locator("visible=true").count()) await tapIt(s, vis(s, t("workspace-tab-past")));
      ctx.check("screen", await seen(vis(s, t(`past-entry-${a.id}`)), 12000) && await seen(vis(s, t(`past-entry-${b.id}`)), 5000), L("Past Entries in the Journal workspace lists both (in-app navigation)"));
      const pastA = (await vis(s, t(`past-entry-${a.id}`)).innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", pastA.includes(titleA), L("…with the edited entry's title"), pastA.slice(0, 120));
      await s.press(t("button-workspace-close")).catch(() => undefined);
      await sleep(1000);

      // delete B: two taps
      await goto(s, "/journal", "");
      ctx.step(L(`on #/journal press delete on "${titleB}", Cancel; delete again, confirm`));
      await tapIt(s, vis(s, t(`button-delete-journal-${b.id}`)));
      const alert = s.page.getByRole("alertdialog");
      await alert.waitFor({ timeout: 8000 });
      ctx.check("db", (await ctx.db.row("journal_entries", b.id))?.deleted_at == null, L("the first press only asks (Rule 8)"));
      await tapIt(s, alert.getByRole("button", { name: /^cancel$/i }));
      await sleep(800);
      ctx.check("db", (await ctx.db.row("journal_entries", b.id))?.deleted_at == null, L("Cancel keeps it"));
      await tapIt(s, vis(s, t(`button-delete-journal-${b.id}`)));
      await alert.waitFor({ timeout: 8000 });
      await tapIt(s, alert.getByRole("button", { name: /^delete/i }));
      const db2 = await waitRow(ctx, "journal_entries", b.id, (r) => r == null || r.deleted_at != null);
      ctx.check("db", db2 == null || db2.deleted_at != null, L("the confirmed delete removes the entry"));
      ctx.check("db", (await ctx.db.row("journal_entries", a.id))?.deleted_at == null, L("the other entry of the day stays"));
      ctx.same("derived", await ctx.db.count("journal_entries", `date=eq.${ctx.today}&deleted_at=is.null`), today0 + 1, L("today holds one more entry than before"));
      ctx.check("screen", await gone(vis(s, t(`card-journal-${b.id}`))), L("its card leaves without a reload"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

async function editorMenu(s: any, desktopTestId: string, mobileName: RegExp) {
  if (await s.page.locator(t(desktopTestId)).locator("visible=true").count()) { await tapIt(s, vis(s, t(desktopTestId))); return; }
  await tapIt(s, vis(s, t("button-mobile-more")));
  await tapIt(s, s.page.getByRole("menuitem", { name: mobileName }).locator("visible=true").first());
}
const docText = (html: unknown) => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function publicView(token: string): Promise<{ status: number; body: string }> {
  // signed out: no Authorization header
  const { response: r } = await fetchWithRateLimitRetry(`${API_BASE}/public/artifacts/${token}`, {});
  return { status: r.status, body: await r.text() };
}
const versionsRow = async (ctx: Ctx, kind: string, id: string) => {
  const rows = await ctx.db.rows("preferences", `key=eq.${enc(`versions:${kind}:${id}`)}`);
  const v = rows[0]?.value;
  const parsed = typeof v === "string" ? JSON.parse(v) : v;
  return Array.isArray(parsed?.versions) ? parsed.versions : Array.isArray(parsed) ? parsed : [];
};

scenario({
  id: "ui-records.artifact",
  title: "A Word document by hand (mouse and touch): written once, edited, a version restored (two taps), shared and unshared, duplicated, deleted; a checklist ticked — every count on the Artifacts tab follows",
  area: "Browser · records",
  browser: true,
  covers: ["artifact.create.ui", "artifact.edit.ui", "artifact.restore.ui", "artifact.transfer.ui", "artifact.cancel.ui", "artifact.duplicate.ui", "artifact.delete.ui", "artifact.complete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const title = `${ctx.tag} ${s.surface} cover letter`;
      const text1 = `Dear hiring team, I have ${ctx.int(3, 12)} years of experience.`;
      const text2 = ` I led ${ctx.int(2, 9)} launches last year.`;
      const q = `title=eq.${enc(title)}&deleted_at=is.null`;

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/artifacts", "");
      const reloads = watchReloads(s);
      s.problems();
      const st0 = await artifactStats(s);

      // create in Word
      await goto(s, "/workspace/word?tab=documents", "workspace-document");
      await sleep(1200);
      ctx.same("db", await ctx.db.count("artifacts", q), 0, L("opening Word writes nothing"));
      ctx.step(L(`Word → New, title "${title}", text "${text1}", press Save twice quickly`));
      await tapIt(s, vis(s, t("button-word-new")));
      await vis(s, t("doc-editor-canvas")).waitFor({ timeout: 15000 });
      await typeInto(s, t("input-editor-title"), title);
      await typeInEditor(s, `${t("doc-editor-canvas")} .ProseMirror`, text1);
      await pressTwice(s, t("button-workspace-save"));
      await waitRows(ctx, "artifacts", q, (n) => n >= 1, 15000);
      await sleep(3000);
      let rows = await ctx.db.rows("artifacts", q);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${r.id}`));
      ctx.check("action", rows.length >= 1, L("the document was saved"));
      const one = ctx.check("db", rows.length === 1 && rows[0].type === "doc" && docText(rows[0].content).includes(text1), L("ONE doc row with the text (the autosave and a double Save)"), `${rows.length} rows ${JSON.stringify(rows.map((r: any) => [r.type, docText(r.content).slice(0, 60)]))}`);
      if (!one && rows.length > 1) ctx.finding({ severity: "bug", title: "A new Word document saved with a double press makes two documents", detail: `${s.surface}: ${rows.length} rows` });
      const doc = rows[0];
      if (!doc) { endSurface(ctx, s, L, reloads, ""); continue; }

      // edit
      ctx.step(L(`type "${text2}" and press Save`));
      await typeInEditor(s, `${t("doc-editor-canvas")} .ProseMirror`, text2);
      await tapIt(s, vis(s, t("button-workspace-save")));
      const e1 = await waitRow(ctx, "artifacts", doc.id, (r) => docText(r?.content).includes(text2.trim()));
      ctx.check("db", docText(e1?.content).includes(text1) && docText(e1?.content).includes(text2.trim()) && e1?.title === title, L("the same row now holds both sentences"), docText(e1?.content).slice(0, 160));
      ctx.same("db", (await ctx.db.rows("artifacts", q)).length, 1, L("still one document (an edit is not a copy)"));
      // the version row is written just after the record (server/content-versions.ts keepVersionBeforeWrite runs after updateArtifact)
      let versions1: any[] = [];
      for (let i = 0; i < 16 && !versions1.length; i++) { versions1 = await versionsRow(ctx, "document", doc.id); if (!versions1.length) await sleep(400); }
      if (!versions1.length) ctx.step(L(`versions row: ${JSON.stringify(await ctx.db.rows("preferences", `key=eq.${enc(`versions:document:${doc.id}`)}`)).slice(0, 300)}; row updated ${e1?.updated_at}, created ${doc.created_at}`));
      ctx.check("derived", versions1.length >= 1 && versions1.some((v: any) => docText(v.content).includes(text1) && !docText(v.content).includes(text2.trim())), L("the text the edit replaced is kept as a version (WA7)"), JSON.stringify(versions1.map((v: any) => docText(v.content).slice(0, 60))));

      // Artifacts tab and Word's list, without a reload
      await goto(s, "/artifacts", "");
      const st1 = await waitStats(s, (x) => x.made === st0.made + 1);
      ctx.check("screen", st1.made === st0.made + 1 && st1.total === st0.total + 1, L(`Artifacts: Notes & reports ${st0.made}→${st0.made + 1}`), JSON.stringify(st1));
      ctx.check("screen", await seen(vis(s, t(`artifact-card-${doc.id}`))), L("the Artifacts tab lists the document"));

      // restore the first version: two taps
      ctx.step(L("Word → History for this document, open the kept version, press Restore once, then twice"));
      await goto(s, "/workspace/word?tab=documents", "workspace-document");
      await tapIt(s, vis(s, t(`button-word-history-${doc.id}`)));
      const vId = versions1.find((v: any) => docText(v.content).includes(text1) && !docText(v.content).includes(text2.trim()))?.id;
      const vRow = vId ? vis(s, t(`version-${vId}`)) : vis(s, '[data-testid^="version-"]');
      await seen(vRow, 12000);
      await tapIt(s, vRow.locator("button").first());
      const restoreBtn = vId ? vis(s, t(`button-version-restore-${vId}`)) : vis(s, '[data-testid^="button-version-restore-"]');
      await tapIt(s, restoreBtn);
      await sleep(1200);
      ctx.check("db", docText((await ctx.db.row("artifacts", doc.id))?.content).includes(text2.trim()), L("one tap only arms the restore (Rule 8)"));
      await tapIt(s, restoreBtn);
      const r2 = await waitRow(ctx, "artifacts", doc.id, (r) => !docText(r?.content).includes(text2.trim()));
      ctx.check("action", !docText(r2?.content).includes(text2.trim()), L("the second tap restored"));
      ctx.check("db", docText(r2?.content).includes(text1) && !docText(r2?.content).includes(text2.trim()) && r2?.title === title, L("the row holds the restored text; the title is kept (a restore replaces the TEXT only)"), docText(r2?.content).slice(0, 120));
      let versions2: any[] = [];
      for (let i = 0; i < 16; i++) { versions2 = await versionsRow(ctx, "document", doc.id); if (versions2.some((v: any) => docText(v.content).includes(text2.trim()))) break; await sleep(400); }
      ctx.check("derived", versions2.some((v: any) => docText(v.content).includes(text2.trim())), L("what the restore replaced is kept as a version, so it can be undone"), JSON.stringify(versions2.map((v: any) => docText(v.content).slice(0, 60))));

      // share on (transfer) and off (cancel), from the editor
      await goto(s, `/editor/${doc.id}?source=word`, "workspace-document");
      await vis(s, `${t("doc-editor-canvas")} .ProseMirror`).waitFor({ timeout: 15000 });
      const editorShows = await seen(vis(s, `${t("doc-editor-canvas")} .ProseMirror`).filter({ hasText: text1 }), 10000);
      const shown = ((await vis(s, `${t("doc-editor-canvas")} .ProseMirror`).innerText().catch(() => "")) as string).replace(/\s+/g, " ");
      const okEd = ctx.check("screen", editorShows && !shown.includes(text2.trim()), L("the editor shows the restored text (in-app navigation)"), shown.slice(0, 160));
      await sleep(4000);
      const afterOpen = await ctx.db.row("artifacts", doc.id);
      const kept = ctx.check("db", !docText(afterOpen?.content).includes(text2.trim()), L("opening the editor after the restore does not write the replaced text back"), docText(afterOpen?.content).slice(0, 160));
      if (!okEd) ctx.finding({ severity: kept ? "sync" : "bug", title: "After a version restore in Word, the editor opens the text the restore replaced", detail: `${s.surface}: stored "${docText(r2?.content).slice(0, 80)}", the editor showed "${shown.slice(0, 100)}"${kept ? "" : "; its autosave then wrote it back over the restore"}` });
      ctx.step(L("Share → Generate link"));
      await editorMenu(s, "button-editor-share", /^share$/i);
      await tapIt(s, vis(s, t("button-share-enable")));
      const sh = await waitRow(ctx, "artifacts", doc.id, (r) => !!r?.metadata?.shareToken);
      const token = sh?.metadata?.shareToken;
      ctx.check("db", typeof token === "string" && token.length >= 32, L("the row now carries a share token"));
      const url = await vis(s, t("input-share-url")).inputValue().catch(() => "");
      ctx.check("screen", !!token && url.includes(token), L("the dialog shows the link with that token"), url);
      const pub = token ? await publicView(token) : { status: 0, body: "" };
      ctx.check("derived", pub.status === 200 && pub.body.includes(text1.slice(0, 20)), L("signed out, the link shows the document"), `${pub.status} ${pub.body.slice(0, 120)}`);
      ctx.step(L("Revoke link"));
      await tapIt(s, vis(s, t("button-share-revoke")));
      const un = await waitRow(ctx, "artifacts", doc.id, (r) => !r?.metadata?.shareToken);
      ctx.check("db", !un?.metadata?.shareToken, L("revoking clears the token"));
      const pub2 = token ? await publicView(token) : { status: 0, body: "" };
      ctx.check("derived", pub2.status === 404, L("the old link no longer opens it"), `${pub2.status}`);
      for (let i = 0; i < 3 && await s.page.locator('[role="dialog"]').locator("visible=true").count(); i++) {
        await s.page.keyboard.press("Escape");
        await sleep(500);
        const x = s.page.locator('[role="dialog"]').locator("visible=true").getByRole("button", { name: /^close$/i }).first();
        if (await x.isVisible().catch(() => false)) await tapIt(s, x).catch(() => undefined);
      }

      // duplicate
      ctx.step(L("Copy / Duplicate"));
      await editorMenu(s, "button-editor-duplicate", /^duplicate$/i);
      const copyTitle = `${title} (copy)`;
      const copies = await waitRows(ctx, "artifacts", `title=eq.${enc(copyTitle)}&deleted_at=is.null`, (n) => n >= 1);
      await sleep(1500);
      const copies2 = await ctx.db.rows("artifacts", `title=eq.${enc(copyTitle)}&deleted_at=is.null`);
      for (const c of copies2) ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${c.id}`));
      ctx.check("db", copies2.length === 1 && copies2[0].type === "doc" && docText(copies2[0].content) === docText(r2?.content) && copies2[0].id !== doc.id, L(`one copy "${copyTitle}" with the same text`), JSON.stringify(copies2.map((c: any) => docText(c.content).slice(0, 40))));
      ctx.check("db", (await ctx.db.row("artifacts", doc.id))?.deleted_at == null && docText((await ctx.db.row("artifacts", doc.id))?.content) === docText(r2?.content), L("the original is untouched"));
      const copy = copies2[0] ?? copies[0];
      if (copy) {
        await s.page.waitForFunction((id: string) => location.hash.includes(id), copy.id, { timeout: 10000 }).catch(() => undefined);
        ctx.check("screen", (await s.page.evaluate(() => location.hash)).includes(copy.id), L("the editor opens the copy"));
        // delete the copy from the editor: two steps
        ctx.step(L("in the copy: Delete, Cancel; Delete, confirm"));
        await editorMenu(s, "button-editor-delete", /^delete$/i);
        await vis(s, t("button-editor-delete-confirm")).waitFor({ timeout: 8000 });
        ctx.check("db", (await ctx.db.row("artifacts", copy.id))?.deleted_at == null, L("Delete only asks first (Rule 8)"));
        await s.page.keyboard.press("Escape");
        await sleep(800);
        ctx.check("db", (await ctx.db.row("artifacts", copy.id))?.deleted_at == null, L("closing the question keeps the copy"));
        await editorMenu(s, "button-editor-delete", /^delete$/i);
        await tapIt(s, vis(s, t("button-editor-delete-confirm")));
        const dc = await waitRow(ctx, "artifacts", copy.id, (r) => r == null || r.deleted_at != null);
        ctx.check("db", dc == null || dc.deleted_at != null, L("the confirmed delete removes the copy"));
      }

      // delete the original from Word's list: two taps
      await goto(s, "/workspace/word?tab=documents", "workspace-document");
      ctx.step(L("Word → My Documents: Delete once, then twice"));
      await tapIt(s, vis(s, t(`button-word-delete-${doc.id}`)));
      await sleep(1200);
      ctx.check("db", (await ctx.db.row("artifacts", doc.id))?.deleted_at == null, L("one tap only arms the delete (Rule 8)"));
      await tapIt(s, vis(s, t(`button-word-delete-${doc.id}`)));
      const dd = await waitRow(ctx, "artifacts", doc.id, (r) => r == null || r.deleted_at != null);
      ctx.check("db", dd == null || dd.deleted_at != null, L("the second tap deletes it"));
      // the route clears the versions after the row (server/routes.ts DELETE /api/artifacts/:id → forgetVersions)
      let vLeft = await versionsRow(ctx, "document", doc.id);
      for (let i = 0; i < 20 && vLeft.length; i++) { await sleep(400); vLeft = await versionsRow(ctx, "document", doc.id); }
      ctx.same("derived", vLeft.length, 0, L("its versions go with it (WA7)"));
      ctx.check("screen", await gone(vis(s, t(`word-doc-${doc.id}`))), L("it leaves Word's list without a reload"));
      await goto(s, "/artifacts", "");
      const st2 = await waitStats(s, (x) => x.made === st0.made);
      ctx.check("screen", st2.made === st0.made && st2.total === st0.total, L("Artifacts counts are back where they started"), JSON.stringify(st2));

      // a checklist ticked in the viewer (AR2); checklists are made by chat, so it is set up through the API
      const cl = must(await ctx.api("POST", "/artifacts", { type: "checklist", title: `${ctx.tag} ${s.surface} trip checklist`, content: "", items: [{ text: "Book hotel", checked: false }, { text: "Pack charger", checked: false }, { text: "Print tickets", checked: false }] }), "checklist");
      ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${cl.id}`));
      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/artifacts", "");
      ctx.step(L("open the checklist from #/artifacts, tap its second item"));
      await tapIt(s, vis(s, t(`artifact-card-${cl.id}`)));
      await vis(s, t("artifact-viewer")).waitFor({ timeout: 10000 });
      const item = vis(s, t("artifact-checklist-item-1"));
      await item.waitFor({ timeout: 10000 });
      const c0 = await ctx.db.row("artifacts", cl.id);
      await tapIt(s, item);
      const c1 = await waitRow(ctx, "artifacts", cl.id, (r) => (r?.items || []).some((i: any) => i.checked));
      const its = (c1?.items || []) as any[];
      ctx.check("action", its.some((i) => i.checked), L("the tap was stored"));
      ctx.check("db", its.length === 3 && its[1]?.checked === true && !its[0]?.checked && !its[2]?.checked && its[1]?.text === "Pack charger", L("exactly the second item is stored as done"), JSON.stringify(its.map((i) => [i.text, i.checked])));
      const done = its.filter((i) => i.checked).length;
      ctx.check("screen", await showsText(s, `${done} of ${its.length} done`, 6000), L(`the viewer says "${done} of ${its.length} done"`));
      ctx.check("db", JSON.stringify((c0?.items || []).map((i: any) => i.text)) === JSON.stringify(its.map((i) => i.text)), L("no item was added, dropped or reordered"));
      await tapIt(s, item);
      const c2 = await waitRow(ctx, "artifacts", cl.id, (r) => !(r?.items || []).some((i: any) => i.checked));
      ctx.check("db", !(c2?.items || []).some((i: any) => i.checked), L("a second tap un-ticks it"));
      await tapIt(s, vis(s, t("button-artifact-viewer-close")));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

async function pref(ctx: Ctx, key: string): Promise<any> {
  const rows = await ctx.db.rows("preferences", `key=eq.${enc(key)}`);
  const v = rows[0]?.value;
  if (v == null) return null;
  try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; }
}
const defsOf = (raw: any): any[] => (Array.isArray(raw) ? raw : Array.isArray(raw?.definitions) ? raw.definitions : []);
const valuesIn = (raw: any): Record<string, any> => (raw && typeof raw === "object" ? (raw.values && typeof raw.values === "object" ? raw.values : raw) : {});

scenario({
  id: "ui-records.detail",
  title: "A characteristic by hand (mouse and touch): defined once on /details, its value on a record edited (typed, validated) and removed, renamed and deleted — usage counts follow",
  area: "Browser · records",
  browser: true,
  covers: ["detail.create.ui", "detail.edit.ui", "detail.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const label = `${ctx.tag} ${s.surface} Shutter count`;
      const renamed = `${ctx.tag} ${s.surface} Shutter actuations`;
      const v1 = ctx.int(1000, 9000), v2 = v1 + ctx.int(10, 500);
      const asset = must(await ctx.api("POST", "/profiles", { type: "asset", name: `${ctx.tag} ${s.surface} Camera`, fields: { purchasePrice: 900 } }), "asset");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${asset.id}`));
      const findDef = async (l: string) => defsOf(await pref(ctx, "detail_definitions")).filter((d: any) => String(d.label).toLowerCase() === l.toLowerCase());

      await goto(s, "/dashboard", "page-dashboard");
      await goto(s, "/details", "page-details");
      const reloads = watchReloads(s);
      s.problems();
      await sleep(1000);
      ctx.same("db", (await findDef(label)).length, 0, L("opening /details writes nothing"));

      // create: New → label, Number, Save (pressed twice)
      ctx.step(L(`/details → New, label "${label}", type Number, press Save twice`));
      if (await s.page.locator(t("details-tab-catalog")).locator("visible=true").count()) await tapIt(s, vis(s, t("details-tab-catalog")));
      await tapIt(s, vis(s, t("details-new")));
      await vis(s, t("definition-editor")).waitFor({ timeout: 8000 });
      await typeInto(s, t("def-label"), label);
      await tapIt(s, vis(s, t("def-kind")));
      await tapIt(s, s.page.getByRole("option", { name: /^number$/i }).first());
      await sleep(300);
      await pressTwice(s, t("def-save"));
      await sleep(2500);
      const defs = await findDef(label);
      ctx.check("action", defs.length >= 1, L("the characteristic was defined"));
      const oneDef = ctx.check("db", defs.length === 1 && defs[0].kind === "number", L("ONE definition of kind number (D1; a double press)"), JSON.stringify(defs.map((d: any) => [d.label, d.kind])));
      if (!oneDef && defs.length > 1) ctx.finding({ severity: "bug", title: "A double press of Save on /details defines a characteristic twice", detail: `${s.surface}: ${defs.length} definitions named "${label}" (D1: one definition per name)` });
      const def = defs[0];
      if (!def) { endSurface(ctx, s, L, reloads, ""); continue; }
      ctx.cleanup(() => ctx.api("DELETE", `/details/definitions/${def.id}`));
      const card = vis(s, t(`catalog-${def.id}`));
      ctx.check("screen", await seen(card, 10000), L("the catalog lists it without a reload"));
      ctx.check("screen", /used on 0 records/.test((await card.innerText().catch(() => "")).replace(/\s+/g, " ")), L(`it reads "used on 0 records"`));

      // a value on the asset (no screen adds one, D7), then edited on the asset's page
      must(await ctx.api("PUT", `/details/profile/${asset.id}/${def.id}`, { value: v1 }), "value");
      const key = `details:profile:${asset.id}`;
      ctx.near("db", valuesIn(await pref(ctx, key))[def.id]?.value ?? valuesIn(await pref(ctx, key))[def.id], v1, L("set-up: the asset holds the value"));
      await goto(s, `/profiles/${asset.id}`, "");
      const cell = vis(s, t(`detail-cell-${def.id}`));
      ctx.check("screen", await seen(cell, 15000), L("the asset's page shows the characteristic (in-app navigation)"));
      ctx.check("screen", ((await cell.innerText().catch(() => "")) as string).replace(/[,\s]/g, "").includes(String(v1)), L(`…with the value ${v1}`));

      // a value the type cannot hold is refused; the screen says so; nothing is stored (D2)
      ctx.step(L(`tap the cell, type "lots", press Enter`));
      const before = await pref(ctx, key);
      await tapIt(s, cell);
      await typeInto(s, t(`detail-cell-edit-${def.id}`), "lots");
      await vis(s, t(`detail-cell-edit-${def.id}`)).press("Enter");
      ctx.check("screen", await showsText(s, "Couldn't change", 6000), L(`the screen says it couldn't change it`));
      ctx.check("db", JSON.stringify(await pref(ctx, key)) === JSON.stringify(before), L("a value the type can't hold stores nothing (D2)"));
      await sleep(800);
      ctx.check("screen", ((await vis(s, t(`detail-cell-${def.id}`)).innerText().catch(() => "")) as string).replace(/[,\s]/g, "").includes(String(v1)), L(`the cell still shows ${v1}, not the refused text`));

      ctx.step(L(`tap the cell, type ${v2}, press Escape; tap again, type ${v2}, press Enter`));
      await tapIt(s, vis(s, t(`detail-cell-${def.id}`)));
      await typeInto(s, t(`detail-cell-edit-${def.id}`), String(v2));
      await vis(s, t(`detail-cell-edit-${def.id}`)).press("Escape");
      await sleep(800);
      ctx.check("db", JSON.stringify(await pref(ctx, key)) === JSON.stringify(before), L("Escape writes nothing"));
      await tapIt(s, vis(s, t(`detail-cell-${def.id}`)));
      await typeInto(s, t(`detail-cell-edit-${def.id}`), String(v2));
      await vis(s, t(`detail-cell-edit-${def.id}`)).press("Enter");
      let stored: any;
      for (let i = 0; i < 24; i++) { const raw = valuesIn(await pref(ctx, key))[def.id]; stored = raw?.value ?? raw; if (Number(stored) === v2) break; await sleep(500); }
      ctx.check("action", Number(stored) === v2, L("the edit was saved"));
      ctx.check("db", typeof stored === "number" && stored === v2, L(`the value is stored as the NUMBER ${v2} (D2: typed, never text)`), JSON.stringify(stored));
      ctx.check("screen", await seen(vis(s, t(`detail-cell-${def.id}`)).filter({ hasText: new RegExp(String(v2).replace(/(\d)(?=(\d{3})+$)/g, "$1,?")) }), 8000), L(`the cell shows ${v2} without a reload`));

      // usage on /details follows
      await goto(s, "/details", "page-details");
      if (await s.page.locator(t("details-tab-catalog")).locator("visible=true").count()) await tapIt(s, vis(s, t("details-tab-catalog")));
      const used1 = await seen(vis(s, t(`catalog-${def.id}`)).filter({ hasText: /used on 1 record\b/ }), 10000);
      ctx.check("derived", used1, L(`the catalog counts "used on 1 record"`));

      // rename the definition: the value stays with it
      ctx.step(L(`catalog: Edit, label "${renamed}", Save`));
      await tapIt(s, vis(s, t(`catalog-edit-${def.id}`)));
      await typeInto(s, t("def-label"), renamed);
      await tapIt(s, vis(s, t("def-save")));
      let rd: any[] = [];
      for (let i = 0; i < 20 && !rd.length; i++) { rd = await findDef(renamed); if (!rd.length) await sleep(500); }
      ctx.check("db", rd.length === 1 && rd[0].id === def.id && (await findDef(label)).length === 0, L("the same definition now has the new label (no second one)"));
      const rawAfter = valuesIn(await pref(ctx, key))[def.id];
      ctx.near("db", rawAfter?.value ?? rawAfter, v2, L("the record's value stays with the renamed definition"));
      ctx.check("screen", await showsText(s, renamed, 8000), L("the catalog shows the new label"));

      // remove the value on the asset page: two taps
      await goto(s, `/profiles/${asset.id}`, "");
      ctx.step(L("asset page: the cell's X once, then twice"));
      await tapIt(s, vis(s, t(`detail-cell-remove-${def.id}`)));
      await sleep(1000);
      ctx.check("db", valuesIn(await pref(ctx, key))[def.id] !== undefined, L("one tap only arms the removal (Rule 8)"));
      await tapIt(s, vis(s, t(`detail-cell-remove-${def.id}`)));
      let gone1 = false;
      for (let i = 0; i < 20 && !gone1; i++) { gone1 = valuesIn(await pref(ctx, key))[def.id] === undefined; if (!gone1) await sleep(500); }
      ctx.check("db", gone1, L("the second tap removes the value"));
      ctx.check("screen", await gone(vis(s, t(`detail-cell-${def.id}`))), L("the cell leaves the page without a reload"));
      ctx.check("db", (await findDef(renamed)).length === 1, L("removing a value keeps the definition"));

      // delete the definition: two taps
      await goto(s, "/details", "page-details");
      if (await s.page.locator(t("details-tab-catalog")).locator("visible=true").count()) await tapIt(s, vis(s, t("details-tab-catalog")));
      ctx.check("derived", await seen(vis(s, t(`catalog-${def.id}`)).filter({ hasText: /used on 0 records/ }), 10000), L(`the catalog is back to "used on 0 records"`));
      ctx.step(L("catalog: Delete once, then again"));
      await tapIt(s, vis(s, t(`catalog-delete-${def.id}`)));
      await sleep(1000);
      ctx.check("db", (await findDef(renamed)).length === 1, L("one tap only arms the delete (Rule 8)"));
      await tapIt(s, vis(s, t(`catalog-delete-${def.id}`)));
      let gone2 = false;
      for (let i = 0; i < 20 && !gone2; i++) { gone2 = (await findDef(renamed)).length === 0; if (!gone2) await sleep(500); }
      ctx.check("db", gone2, L("the second tap deletes the definition"));
      ctx.check("screen", await gone(vis(s, t(`catalog-${def.id}`))), L("it leaves the catalog without a reload"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

const memoriesOf = (raw: any): any[] => (Array.isArray(raw?.memories) ? raw.memories : []);

scenario({
  id: "ui-records.memory",
  title: "What an assistant remembers, by hand (mouse and touch): a memory added once, forgotten in two taps, everything forgotten in two taps; one assistant's memory never shows in another's",
  area: "Browser · records",
  browser: true,
  covers: ["memory.edit.ui", "memory.delete.ui"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      // desktop: the Journal's Reflection Coach; phone: the Notes AI Assistant (WA13: per assistant)
      const app = s.surface === "desktop" ? "journal" : "notes";
      const other = app === "journal" ? "notes" : "journal";
      const route = app === "journal" ? "/workspace/journal?tab=coach" : "/workspace/notes?tab=assistant";
      const otherRoute = other === "journal" ? "/workspace/journal?tab=coach" : "/workspace/notes?tab=assistant";
      const m1 = `${ctx.tag} ${s.surface} my sister Ana lives in Porto`;
      const m2 = `${ctx.tag} ${s.surface} I am training for a ${ctx.int(5, 21)} km race`;
      const key = `ai_memory:${app}`;
      const mine = async () => memoriesOf(await pref(ctx, key)).filter((m: any) => String(m.text).includes(`${ctx.tag} ${s.surface}`));
      const openPanel = async (a: string) => {
        await vis(s, t(`button-memory-${a}`)).waitFor({ timeout: 15000 });
        if (!(await s.page.locator(t(`memory-panel-${a}`)).locator("visible=true").count())) await tapIt(s, vis(s, t(`button-memory-${a}`)));
        await vis(s, t(`memory-panel-${a}`)).waitFor({ timeout: 8000 });
      };

      await goto(s, "/dashboard", "page-dashboard");
      const before = JSON.stringify(await pref(ctx, key));
      await goto(s, route, "");
      const reloads = watchReloads(s);
      s.problems();
      await openPanel(app);
      await sleep(800);
      ctx.check("db", JSON.stringify(await pref(ctx, key)) === before, L("opening the assistant and its memory writes nothing (Rule 3)"));

      // a dropped request: nothing kept, the screen says so, the words stay in the box
      ctx.step(L(`type "${m1}" in "Something you want me to remember", press Remember while the network drops it`));
      await typeInto(s, t(`input-memory-${app}`), m1);
      const fail = await failOnce(s, "POST", new RegExp(`/api/workspace/memory/${app}/remember$`));
      await tapIt(s, vis(s, t(`button-memory-add-${app}`)));
      await sleep(1500);
      await fail.off();
      ctx.check("action", fail.hit(), L("the request was dropped"));
      ctx.same("db", (await mine()).length, 0, L("a dropped request keeps nothing"));
      ctx.check("screen", await showsText(s, "Couldn't change what is remembered", 5000), L("the screen says it was not kept"));
      ctx.check("screen", (await vis(s, t(`input-memory-${app}`)).inputValue().catch(() => "")) === m1, L("the words are still in the box"));

      // add, with a double press
      ctx.step(L("press Remember twice quickly"));
      const sent: string[] = [];
      const onReq = (r: any) => { if (r.url().includes("/remember")) sent.push(`${r.method()} ${r.url().split("/api")[1]}`); };
      const onRes = (r: any) => { if (r.url().includes("/remember")) sent.push(`→ ${r.status()}`); };
      s.page.on("request", onReq); s.page.on("response", onRes);
      await pressTwice(s, t(`button-memory-add-${app}`));
      await sleep(1500);
      s.page.off("request", onReq); s.page.off("response", onRes);
      ctx.step(L(`requests: ${sent.join(" ") || "none"}`));
      let ms: any[] = [];
      for (let i = 0; i < 20; i++) { ms = await mine(); if (ms.length) break; await sleep(400); }
      await sleep(1200);
      ms = await mine();
      ctx.check("action", ms.length >= 1, L("the memory was kept"));
      ctx.check("db", ms.length === 1 && ms[0].text === m1 && ms[0].by === "you", L("ONE memory with the person's own words, marked as theirs (a double press)"), JSON.stringify(ms));
      for (const m of ms) ctx.cleanup(() => ctx.api("DELETE", `/workspace/memory/${app}/items/${m.id}`));
      const mem = ms[0];
      if (!mem) { endSurface(ctx, s, L, reloads, ""); continue; }
      ctx.check("screen", await seen(vis(s, t(`memory-${mem.id}`)), 8000), L("the panel lists it without a reload"));
      const total = memoriesOf(await pref(ctx, key)).length;
      ctx.check("screen", await seen(vis(s, t(`button-memory-${app}`)).filter({ hasText: new RegExp(`· ${total}\\b`) }), 8000), L(`the count reads "What I remember · ${total}"`));

      // the other assistant never shows it (WA13)
      await goto(s, otherRoute, "");
      await openPanel(other);
      await sleep(800);
      ctx.check("screen", !(await s.page.getByText(m1).locator("visible=true").count()), L(`the ${other} assistant does not list it`));
      ctx.check("db", !JSON.stringify(await pref(ctx, `ai_memory:${other}`) ?? "").includes(m1), L(`and its row does not hold it`));

      // forget one: two taps
      await goto(s, route, "");
      await openPanel(app);
      ctx.step(L("Forget once, then again"));
      await tapIt(s, vis(s, t(`button-forget-${mem.id}`)));
      await sleep(900);
      ctx.same("db", (await mine()).length, 1, L("one tap only arms it (Rule 8)"));
      await tapIt(s, vis(s, t(`button-forget-${mem.id}`)));
      let left: any[] = ms;
      for (let i = 0; i < 20 && left.length; i++) { left = await mine(); if (left.length) await sleep(400); }
      ctx.same("db", left.length, 0, L("the second tap forgets it"));
      ctx.check("screen", await gone(vis(s, t(`memory-${mem.id}`))), L("it leaves the panel without a reload"));

      // forget everything: two taps
      await typeInto(s, t(`input-memory-${app}`), m2);
      await tapIt(s, vis(s, t(`button-memory-add-${app}`)));
      for (let i = 0; i < 20 && !(await mine()).length; i++) await sleep(400);
      ctx.same("db", (await mine()).length, 1, L("a second memory was kept"));
      ctx.step(L("Forget everything once, then again"));
      await tapIt(s, vis(s, t(`button-forget-all-${app}`)));
      await sleep(900);
      ctx.same("db", (await mine()).length, 1, L("one tap only arms Forget everything (Rule 8)"));
      await tapIt(s, vis(s, t(`button-forget-all-${app}`)));
      let all: any[] = [1];
      for (let i = 0; i < 20 && all.length; i++) { all = memoriesOf(await pref(ctx, key)); if (all.length) await sleep(400); }
      const raw = await pref(ctx, key);
      ctx.check("db", memoriesOf(raw).length === 0 && (!Array.isArray(raw?.turns) || raw.turns.length === 0), L("every memory and the conversation are gone"), JSON.stringify(raw).slice(0, 200));
      ctx.check("screen", await seen(vis(s, t("memory-empty")), 8000), L(`the panel says nothing is remembered`));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});
