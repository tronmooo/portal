// People, pets, assets, ownership and Settings, by hand, in a real browser —
// as a desktop mouse and as a phone with touch (T1/T2). Every operation a
// screen offers is driven on that screen and then held to four things: the
// stored row (read straight from the database), the figures that depend on it
// (against ../oracle or plain arithmetic here — never the app's own answer),
// the OTHER screens that show it (reached inside the app, never by a reload),
// and "opening or closing a form writes nothing". Where the app is wrong the
// check stays red and a finding says what was seen.
//
// Doors NOT offered by any screen (so not in `covers`):
//  - profile.create.ui: no mounted screen creates a person or pet. The two
//    components that could (QuickCreateFab, OnboardingWizard) are not rendered
//    anywhere (grep of client/src for their JSX); CreateProfileDialog is only
//    opened from the Assets / Liabilities tabs with an asset or liability
//    category filter. People are made in chat (Rule 13), so the scenarios
//    below create the person through the API and drive every screen after it.
//  - asset.restore.ui: a deleted profile has no Trash or restore screen (the
//    server has restore routes for tasks, expenses, documents, habits and
//    goals only).
//  - dashboard.complete.ui (onboarding): OnboardingWizard is not mounted, so a
//    brand-new account never sees it (checked in ui-profiles.settings-wipe:
//    a new account lands on the dashboard with no wizard).
import { scenario, listOf, must, type Ctx } from "../framework";
import * as O from "../oracle";
import { SMOKE_USER_ID } from "../../smoke/fixture/account";

const t = (id: string) => `[data-testid="${id}"]`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitRow(ctx: Ctx, table: string, id: string, ok: (row: any) => boolean, ms = 12000): Promise<any> {
  const until = Date.now() + ms;
  for (;;) {
    const row = await ctx.db.row(table, id);
    if (ok(row) || Date.now() > until) return row;
    await sleep(400);
  }
}
async function waitRows(ctx: Ctx, table: string, query: string, want: (rows: any[]) => boolean, ms = 12000): Promise<any[]> {
  const until = Date.now() + ms;
  for (;;) {
    const rows = await ctx.db.rows(table, query);
    if (want(rows) || Date.now() > until) return rows;
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
const press = async (s: any, sel: string, opts: any = {}) => { const el = vis(s, sel); await el.waitFor({ timeout: 15000 }); await tapIt(s, el, opts); };
const seen = (loc: any, ms = 12000) => loc.waitFor({ timeout: ms }).then(() => true).catch(() => false);
const gone = (loc: any, ms = 10000) => loc.waitFor({ state: "hidden", timeout: ms }).then(() => true).catch(() => false);
async function pressTwice(s: any, sel: string) {
  const el = vis(s, sel);
  await el.waitFor({ timeout: 15000 });
  if (s.surface === "phone") { await el.tap().catch(() => undefined); await el.tap({ timeout: 300 }).catch(() => undefined); }
  else await el.dblclick().catch(() => undefined);
}
async function typeInto(s: any, sel: string, value: string) {
  const el = vis(s, sel);
  await el.waitFor({ timeout: 15000 });
  await el.fill(value);
}
const textOf = async (s: any, sel: string) => ((await vis(s, sel).innerText().catch(() => "")) as string).replace(/\s+/g, " ").trim();
/** Every dollar figure in a text, as numbers ("$1,204.50" → 1204.5; "$6.2K" → 6200). */
const dollars = (text: string): number[] => [...text.matchAll(/(-|−)?\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)([kKmM])?/g)]
  .map((m) => (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")) * (m[3] ? (/[kK]/.test(m[3]) ? 1e3 : 1e6) : 1));
/** Wait until a region shows a dollar figure within `tol` of `want` (and, with `stale`, no longer the old one). */
async function showsAmount(s: any, sel: string, want: number, tol = 0.5, ms = 12000, stale?: number): Promise<{ ok: boolean; text: string }> {
  const until = Date.now() + ms;
  let text = "";
  for (;;) {
    text = await textOf(s, sel);
    const found = dollars(text);
    const old = stale !== undefined && Math.abs(stale - want) > tol && found.some((n) => Math.abs(n - stale) <= tol);
    if (found.some((n) => Math.abs(n - want) <= tol) && !old) return { ok: true, text };
    if (Date.now() > until) return { ok: false, text };
    await sleep(400);
  }
}
async function showsText(s: any, sel: string, want: string | RegExp, ms = 12000): Promise<{ ok: boolean; text: string }> {
  const until = Date.now() + ms;
  let text = "";
  for (;;) {
    text = await textOf(s, sel);
    if (typeof want === "string" ? text.includes(want) : want.test(text)) return { ok: true, text };
    if (Date.now() > until) return { ok: false, text };
    await sleep(400);
  }
}
async function snapshot(ctx: Ctx, ids?: string[]) {
  const q = ids && ids.length ? `?profileIds=${ids.join(",")}` : "";
  const f = must(await ctx.api("GET", `/dashboard-enhanced${q}`), "dashboard-enhanced").financeSnapshot;
  if (!f || typeof f.totalAssetValue !== "number" || typeof f.totalLiabilities !== "number") throw new Error("financeSnapshot has no totals");
  return { ...f, netWorth: O.cents(f.totalAssetValue - f.totalLiabilities) };
}
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
  const all: string[] = s.problems();
  // The dashboard briefing route answers a missing AI provider with a 500
  // ("Couldn't generate summary right now.", server/routes.ts POST
  // /api/ai/summary) where the profile summary route answers 503 +
  // X-AI-Unavailable. That is one defect outside these screens: it is held to
  // its own check, named, instead of being folded into every other one.
  const briefing = all.filter((p) => p === "500 POST /api/ai/summary");
  const problems = all.filter((p) => p !== "500 POST /api/ai/summary");
  if (briefing.length) {
    ctx.check("screen", false, L("the dashboard's AI briefing answers 'no AI here' as a state (503 X-AI-Unavailable), not a 500"), `${briefing.length}× 500 POST /api/ai/summary`);
    ctx.finding({ severity: "bug", title: "POST /api/ai/summary answers 500 when no AI provider is configured", detail: "server/routes.ts ~3268: the catch sends 500 'Couldn't generate summary right now.'; the profile summary route (~6497) answers 503 with X-AI-Unavailable for the same state. Each dashboard visit on the isolated stack logs a server fault." });
  }
  ctx.check("screen", problems.length === 0, L("no script error and no 5xx along the way"), problems.join("; "));
}
/** Fail the next request matching `method` + `re` once (a 500), then let the rest through. */
async function failOnce(s: any, method: string, re: RegExp): Promise<() => Promise<void>> {
  let done = false;
  const handler = async (route: any) => {
    const req = route.request();
    if (!done && req.method() === method && re.test(new URL(req.url()).pathname)) {
      done = true;
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "integrity: injected failure" }) });
      return;
    }
    await route.fallback();
  };
  await s.page.route("**/api/**", handler);
  return async () => { await s.page.unroute("**/api/**", handler).catch(() => undefined); };
}
/** The app-wide profile scope (a view: stored in this browser only, Rule 4). */
async function scopeEveryone(s: any) {
  await press(s, t("hub-profile-switcher"));
  await press(s, t("hub-switch-everyone"));
  await sleep(600);
}
async function scopeTo(s: any, id: string) {
  await press(s, t("hub-profile-switcher"));
  await press(s, t(`hub-switch-${id}`));
  await sleep(600);
}
const mkProfile = async (ctx: Ctx, body: any) => {
  const p = must(await ctx.api("POST", "/profiles", body), `create ${body.name}`);
  ctx.cleanup(() => ctx.api("DELETE", `/profiles/${p.id}`));
  return p;
};
/** Age in whole years on `today` for a YYYY-MM-DD birthday (plain arithmetic). */
const ageOn = (birthday: string, today: string) => {
  const b = O.parseYmd(birthday), d = O.parseYmd(today);
  return d.y - b.y - (d.m < b.m || (d.m === b.m && d.d < b.d) ? 1 : 0);
};
/** Writes (POST/PATCH/PUT/DELETE to /api) the page makes while `fn` runs. */
async function writesDuring(s: any, fn: () => Promise<void>): Promise<string[]> {
  const seenW: string[] = [];
  const on = (r: any) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(r.method())) seenW.push(`${r.method()} ${u.pathname}`);
  };
  s.page.on("request", on);
  try { await fn(); } finally { s.page.off("request", on); }
  // writes the app makes on its own that are not about this record
  return seenW.filter((w) => !/\/api\/(client-errors|preferences\/(ui_|last_)|data-version|activity)/.test(w));
}

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.person-info",
  title: "A person's Info page (mouse and touch): rename, add / change / remove a field, Age from the birthday, delete in two steps — stored, and on every screen without a reload",
  area: "People",
  browser: true,
  covers: ["profile.edit.ui", "profile.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const reloads = watchReloads(s);
      // (a person's name never carries the surface word: "desktop" is a thing
      // word, and the create route files "… desktop Robin" as an asset —
      // looksLikeAssetName, shared/entity-classify.ts)
      const who = s.surface === "phone" ? "Pike" : "Ames";
      const person = await mkProfile(ctx, { type: "person", name: `${ctx.tag} Robin ${who}`, fields: { relationship: "friend" } });
      // a thing only this person owns, and one shared with the account holder:
      // deleting the person must leave no ownership row naming them (Rule 9)
      ctx.same("db", (await ctx.db.row("profiles", person.id))?.type, "person", L("the person is stored as a person"));
      const solo = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} ${s.surface} Robin bike`, fields: { currentValue: 900 } });
      const shared = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} ${s.surface} shared canoe`, fields: { currentValue: 1200 } });
      must(await ctx.api("PUT", `/profiles/${solo.id}/owners`, { owners: [{ partyProfileId: person.id, ownershipPercentage: 100 }] }), "solo owner");
      must(await ctx.api("PUT", `/profiles/${shared.id}/owners`, { owners: [{ partyProfileId: person.id, ownershipPercentage: 50 }, { partyProfileId: ctx.self.id, ownershipPercentage: 50 }] }), "shared owners");

      // the Everyone list shows them (the app learned of a write made elsewhere: I9).
      // A new sign-in's scope is the account holder (T3), which hides other
      // people by design (Rule 4) — the scenario looks at Everyone.
      await goto(s, "/profiles", "page-profile-info");
      await scopeEveryone(s);
      ctx.check("screen", await seen(vis(s, t(`info-person-${person.id}`)), 15000), L("the Everyone list shows the new person without a reload"));

      // opening the page writes nothing (Rule 3)
      const before = await ctx.db.row("profiles", person.id);
      const openWrites = await writesDuring(s, async () => {
        await press(s, t(`info-person-${person.id}`));
        await s.page.waitForFunction((id: string) => window.location.hash.includes(`/profiles/${id}/info`), person.id, { timeout: 15000 });
        await vis(s, t("info-add-field")).waitFor({ timeout: 20000 });
        await sleep(1500);
      });
      ctx.check("action", openWrites.length === 0, L("opening the person's Info page sends no write"), openWrites.join(", "));
      const afterOpen = await ctx.db.row("profiles", person.id);
      ctx.check("db", afterOpen.updated_at === before.updated_at, L("and the row is untouched"), `${before.updated_at} → ${afterOpen.updated_at}`);

      // ── rename ──
      const newName = `${ctx.tag} Robin ${who} Lee`;
      await press(s, t("button-edit-info-name"));
      await typeInto(s, `input${t("info-name")}`, newName);
      await vis(s, `input${t("info-name")}`).press("Enter");
      const renamed = await waitRow(ctx, "profiles", person.id, (r) => r?.name === newName);
      ctx.same("db", renamed?.name, newName, L("the stored name"));
      ctx.check("screen", (await showsText(s, t("info-name"), newName)).ok, L("the header shows the new name"));
      // the profile switcher (the app-wide filter) names them by the new name, without a reload
      await press(s, t("hub-profile-switcher"));
      const sw = await showsText(s, t(`hub-switch-${person.id}`), newName, 10000);
      ctx.check("screen", sw.ok, L("the profile switcher lists the new name"), sw.text);
      await s.page.keyboard.press("Escape");
      await sleep(300);

      // ── add a field (Add field) ──
      await press(s, t("info-add-field"));
      await typeInto(s, t("info-new-key"), "Nickname");
      await typeInto(s, t("info-new-val"), `Robs-${s.surface}`);
      await press(s, t("info-new-save"));
      const withNick = await waitRow(ctx, "profiles", person.id, (r) => !!r && Object.values(r.fields || {}).includes(`Robs-${s.surface}`));
      const nickKey = Object.keys(withNick?.fields || {}).find((k) => withNick.fields[k] === `Robs-${s.surface}`);
      ctx.check("db", !!nickKey && /nickname/i.test(nickKey), L("the added field is stored on the row"), JSON.stringify(withNick?.fields));
      ctx.check("db", withNick?.fields?.relationship === "friend", L("and the fields already there were kept (a PATCH carries only what was sent)"), JSON.stringify(withNick?.fields));
      ctx.check("screen", (await showsText(s, t("info-fields"), `Robs-${s.surface}`)).ok, L("the field shows on the page"));

      // ── a birthday: Age is worked out from it (D8) ──
      const birthday = `${1980 + ctx.int(0, 20)}-${String(ctx.int(1, 12)).padStart(2, "0")}-${String(ctx.int(1, 28)).padStart(2, "0")}`;
      await press(s, t("info-add-field"));
      await typeInto(s, t("info-new-key"), "birthday");
      await typeInto(s, t("info-new-val"), birthday);
      await press(s, t("info-new-save"));
      const withBday = await waitRow(ctx, "profiles", person.id, (r) => r?.fields?.birthday === birthday);
      ctx.same("db", withBday?.fields?.birthday, birthday, L("the birthday is stored as typed"));
      const age = ageOn(birthday, ctx.today);
      const ageCell = await showsText(s, t("info-cell-Age"), new RegExp(`\\b${age}\\b`));
      ctx.check("derived", ageCell.ok, L(`Age reads ${age} (worked out from ${birthday} on ${ctx.today})`), ageCell.text);

      // changing Age moves the birth year and keeps the day (D8)
      const newAge = age + 2;
      await press(s, t("info-cell-Age"));
      await typeInto(s, t("info-edit-Age"), String(newAge));
      await vis(s, t("info-edit-Age")).press("Enter");
      const moved = await waitRow(ctx, "profiles", person.id, (r) => r?.fields?.birthday && r.fields.birthday !== birthday);
      const b2 = String(moved?.fields?.birthday || "");
      ctx.check("db", b2.slice(5) === birthday.slice(5) && ageOn(b2, ctx.today) === newAge, L(`setting Age to ${newAge} moves the birth year and keeps the day`), `${birthday} → ${b2}`);
      ctx.check("derived", (await showsText(s, t("info-cell-Age"), new RegExp(`\\b${newAge}\\b`))).ok, L(`Age now reads ${newAge}`));

      // ── change a field in place ──
      const label = await vis(s, `${t("info-fields")} [data-testid^="info-cell-"]:has-text("Robs-${s.surface}")`).getAttribute("data-testid");
      const nickLabel = String(label || "").replace(/^info-cell-/, "");
      await press(s, t(`info-cell-${nickLabel}`));
      await typeInto(s, t(`info-edit-${nickLabel}`), `Bobbin-${s.surface}`);
      await vis(s, t(`info-edit-${nickLabel}`)).press("Enter");
      const changed = await waitRow(ctx, "profiles", person.id, (r) => r?.fields?.[nickKey!] === `Bobbin-${s.surface}`);
      ctx.same("db", changed?.fields?.[nickKey!], `Bobbin-${s.surface}`, L("the changed value is stored under the same key"));

      // ── remove a field: two taps (Rule 8) ──
      await press(s, t(`info-remove-${nickLabel}`));
      await sleep(1500);
      const afterOneTap = await ctx.db.row("profiles", person.id);
      ctx.check("db", afterOneTap?.fields?.[nickKey!] === `Bobbin-${s.surface}`, L("one tap on a field's X removes nothing (Rule 8: a destructive button takes two taps)"), JSON.stringify(afterOneTap?.fields));
      if (afterOneTap?.fields?.[nickKey!] === `Bobbin-${s.surface}`) await press(s, t(`info-remove-${nickLabel}`));
      const removed = await waitRow(ctx, "profiles", person.id, (r) => r && !(nickKey! in (r.fields || {})));
      ctx.check("db", !!removed && !(nickKey! in (removed.fields || {})), L("the field is gone from the row"), JSON.stringify(removed?.fields));
      ctx.check("screen", await gone(vis(s, t(`info-cell-${nickLabel}`))), L("and from the page"));

      // ── delete: Keep writes nothing; confirming deletes ──
      await press(s, t("info-delete-profile"));
      await vis(s, t("info-delete-confirm")).waitFor({ timeout: 10000 });
      await press(s, t("info-delete-cancel"));
      await sleep(800);
      ctx.check("db", (await ctx.db.row("profiles", person.id))?.deleted_at == null, L("Keep leaves the person in place"));
      await press(s, t("info-delete-profile"));
      await press(s, t("info-delete-confirm-button"));
      const del = await waitRow(ctx, "profiles", person.id, (r) => !r || r.deleted_at != null, 15000);
      ctx.check("db", !del || del.deleted_at != null, L("confirming deletes the person"));
      const links = await ctx.db.rows("asset_party_links", `party_profile_id=eq.${person.id}`);
      ctx.check("db", links.length === 0, L("no ownership row still names the deleted person (Rule 9)"), JSON.stringify(links.map((l: any) => [l.asset_profile_id, l.ownership_percentage])));
      const sharedRow = await ctx.db.row("profiles", shared.id);
      ctx.check("db", sharedRow?.deleted_at == null, L("the co-owned canoe stays"));
      const sharedLinks = await ctx.db.rows("asset_party_links", `asset_profile_id=eq.${shared.id}`);
      ctx.check("db", sharedLinks.length === 1 && sharedLinks[0].party_profile_id === ctx.self.id, L("and is now owned by the remaining owner alone"), JSON.stringify(sharedLinks.map((l: any) => [l.party_profile_id, l.ownership_percentage])));
      const soloRow = await ctx.db.row("profiles", solo.id);
      ctx.step(`${s.surface}: the person's own bike after the delete: ${soloRow ? (soloRow.deleted_at ? "deleted" : "kept") : "gone"}`);
      // screens: back on the Everyone list, and gone from the switcher, without a reload
      await s.page.waitForFunction(() => /#\/profiles(\?|$)/.test(window.location.hash), undefined, { timeout: 15000 }).catch(() => undefined);
      await vis(s, t("info-people")).waitFor({ timeout: 15000 }).catch(() => undefined);
      ctx.check("screen", await gone(vis(s, t(`info-person-${person.id}`))), L("the Everyone list no longer shows them"));
      await press(s, t("hub-profile-switcher"));
      ctx.check("screen", await gone(vis(s, t(`hub-switch-${person.id}`)), 6000), L("nor does the profile switcher"));
      await s.page.keyboard.press("Escape");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.asset-create",
  title: "Adding an asset (Net worth sheet) and a thing inside it (Contained tab), mouse and touch: one record per Save, nothing on Cancel or a failed request, counted once in net worth on every screen",
  area: "Assets",
  browser: true,
  covers: ["asset.create.ui", "asset.nest.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const reloads = watchReloads(s);
      const name = `${ctx.tag} ${s.surface} Piano`;
      const value = ctx.int(20, 90) * 100 + ctx.int(0, 99);
      const byName = (n: string) => ctx.db.rows("profiles", `name=eq.${encodeURIComponent(n)}`);
      await goto(s, "/dashboard", "page-dashboard");
      await scopeEveryone(s);
      const before = await snapshot(ctx);

      const openAdd = async () => {
        await press(s, t("hub-kpi-networth"));
        // The sheet's Add asset is its list's last row once anything is owned,
        // and its empty state's button on an account that owns nothing (a fresh
        // worker account): the same control, onAdd, either way.
        await sleep(800);
        if (await vis(s, t("button-entity-add")).isVisible().catch(() => false)) await press(s, t("button-entity-add"));
        else await tapIt(s, s.page.getByRole("dialog").getByRole("button", { name: /^add asset$/i }).locator("visible=true").first());
        await vis(s, t("dialog-add-asset")).waitFor({ timeout: 10000 });
      };
      const closeSheet = async () => { await s.page.keyboard.press("Escape"); await sleep(300); await s.page.keyboard.press("Escape"); await sleep(400); };

      // Cancel writes nothing
      await openAdd();
      await typeInto(s, t("input-add-asset-name"), name);
      await typeInto(s, t("input-add-asset-value"), String(value));
      const cancelWrites = await writesDuring(s, async () => {
        await tapIt(s, vis(s, t("dialog-add-asset")).getByRole("button", { name: /^cancel$/i }));
        await sleep(800);
      });
      ctx.check("action", cancelWrites.length === 0, L("Cancel on the Add asset form sends no write"), cancelWrites.join(", "));
      ctx.check("db", (await byName(name)).length === 0, L("and stores nothing"));
      await closeSheet();

      // a failed save stores nothing and does not pretend it worked
      await openAdd();
      await typeInto(s, t("input-add-asset-name"), name);
      await typeInto(s, t("input-add-asset-value"), String(value));
      const unroute = await failOnce(s, "POST", /^\/api\/profiles$/);
      await press(s, t("btn-add-asset-save"));
      await sleep(1500);
      await unroute();
      s.problems(); // the injected 500 is ours, not the app's
      ctx.check("db", (await byName(name)).length === 0, L("a save the server refused stores nothing"));
      ctx.check("screen", await vis(s, t("dialog-add-asset")).isVisible().catch(() => false), L("and the form stays open with what was typed (no success shown)"));
      ctx.same("screen", await vis(s, t("input-add-asset-name")).inputValue().catch(() => ""), name, L("the typed name is still there to retry"));

      // a double press saves ONE asset
      await pressTwice(s, t("btn-add-asset-save"));
      const rows = await waitRows(ctx, "profiles", `name=eq.${encodeURIComponent(name)}`, (r) => r.length >= 1);
      await sleep(1500);
      const all = await byName(name);
      ctx.check("db", all.length === 1, L("a double press on Add stored exactly one asset"), `${all.length} rows`);
      const row = rows[0];
      if (!row) throw new Error("no asset row");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${row.id}`));
      ctx.check("db", ["asset"].includes(row.type) && Number(row.fields?.currentValue) === value, L(`the row is an asset worth ${value}`), JSON.stringify({ type: row.type, f: row.fields }));
      ctx.check("db", row.parent_profile_id === ctx.self.id, L("filed under the account holder (the active scope's owner)"), String(row.parent_profile_id));

      const after = await snapshot(ctx);
      ctx.near("derived", O.cents(after.totalAssetValue - before.totalAssetValue), value, L("total assets rose by the asset's value"));
      ctx.near("derived", O.cents(after.netWorth - before.netWorth), value, L("net worth rose by the same"));
      // screens, without a reload: the sheet's list, the KPI tile, the Assets tab, the asset's own page
      ctx.check("screen", (await showsAmount(s, t(`entity-row-${row.id}`), value, 1)).ok, L("the Net worth sheet lists it at its value"));
      await closeSheet();
      const kpi = await showsAmount(s, t("hub-kpi-networth"), after.netWorth, 1, 12000, before.netWorth);
      ctx.check("screen", kpi.ok, L(`the Net worth tile reads ${after.netWorth}`), kpi.text);
      await goto(s, "/linked?tab=assets", "page-trackers");
      ctx.check("screen", (await showsText(s, t("page-trackers"), name, 15000)).ok, L("the Assets tab lists it"));
      await goto(s, `/profiles/${row.id}`, "page-profile-detail");
      ctx.check("screen", (await showsAmount(s, t("hero-stat-current-value"), value, 1)).ok, L("its page header shows the value"));

      // ── a thing inside it, from the Contained tab ──
      const child = `${ctx.tag} ${s.surface} Piano bench`;
      const cValue = ctx.int(1, 9) * 100 + 50;
      await press(s, t("tab-contained"));
      await press(s, t("button-add-child-asset"));
      await vis(s, t("dialog-add-child-asset")).waitFor({ timeout: 10000 });
      await typeInto(s, t("input-child-asset-name"), child);
      await typeInto(s, t("input-child-asset-value"), String(cValue));
      await pressTwice(s, t("button-confirm-add-child-asset"));
      const cRows = await waitRows(ctx, "profiles", `name=eq.${encodeURIComponent(child)}`, (r) => r.length >= 1);
      await sleep(1500);
      const cAll = await byName(child);
      ctx.check("db", cAll.length === 1, L("a double press on Create stored exactly one child"), `${cAll.length} rows`);
      const c = cRows[0];
      if (!c) throw new Error("no child row");
      ctx.cleanup(() => ctx.api("DELETE", `/profiles/${c.id}`));
      ctx.check("db", c.parent_profile_id === row.id && Number(c.fields?.currentValue) === cValue, L("the child is stored under the asset with its own value"), JSON.stringify({ p: c.parent_profile_id, f: c.fields }));
      const after2 = await snapshot(ctx);
      // LC3: a nested asset counts once — its own value, never folded into the parent's too
      ctx.near("derived", O.cents(after2.totalAssetValue - after.totalAssetValue), cValue, L("adding the child raised total assets by the child's own value only (each counted once, LC3)"));
      ctx.check("screen", await seen(vis(s, t(`child-asset-row-${c.id}`)), 12000), L("the Contained tab lists the child without a reload"));
      ctx.check("screen", (await showsAmount(s, t("hero-stat-current-value"), value, 1)).ok, L("the parent's header still shows its OWN value (nested items are not added into it)"));
      await goto(s, "/dashboard", "page-dashboard");
      const kpi2 = await showsAmount(s, t("hub-kpi-networth"), after2.netWorth, 1, 12000, after.netWorth);
      ctx.check("screen", kpi2.ok, L(`the Net worth tile reads ${after2.netWorth}`), kpi2.text);
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

/** A finger drag across a slider (CDP touch events, as a phone sends them). */
async function touchDrag(s: any, sel: string, toFraction: number) {
  const el = vis(s, sel);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${sel}`);
  const cdp = await s.page.context().newCDPSession(s.page);
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width - 2, x1 = box.x + box.width * toFraction;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 10, y }] });
    await sleep(30);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach().catch(() => undefined);
  await sleep(500);
}

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.asset-edit",
  title: "An asset's Overview, edited in place (mouse and touch): purchase price, value, a characteristic and the name are stored; depreciation, net worth and the other screens follow without a reload; a refused save and one tap on Remove change nothing",
  area: "Assets",
  browser: true,
  covers: ["asset.edit.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const reloads = watchReloads(s);
      const value = ctx.int(30, 60) * 100;
      const asset = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} ${s.surface} Cello`, fields: { currentValue: value, valuationMode: "manual" } });
      await goto(s, "/dashboard", "page-dashboard");
      await scopeEveryone(s);
      const before = await snapshot(ctx);

      // opening the page sends no profile write (Rule 3)
      const row0 = await ctx.db.row("profiles", asset.id);
      const openWrites = await writesDuring(s, async () => {
        await goto(s, `/profiles/${asset.id}`, "page-profile-detail");
        await vis(s, t("asset-details")).waitFor({ timeout: 20000 });
        await sleep(2000);
      });
      ctx.check("action", !openWrites.some((w) => /^(PATCH|PUT|DELETE) \/api\/profiles/.test(w)), L("opening the asset sends no change to it"), openWrites.join(", "));
      ctx.check("db", Number((await ctx.db.row("profiles", asset.id))?.fields?.currentValue) === value && (await ctx.db.row("profiles", asset.id))?.name === row0.name, L("and its value and name are as they were"));

      // ── purchase price; a refused save first ──
      const price = value + ctx.int(5, 25) * 100;
      await press(s, t("overview-missing-purchasePrice"));
      await typeInto(s, t("overview-field-input-purchasePrice"), String(price));
      const unroute = await failOnce(s, "PATCH", new RegExp(`^/api/profiles/${asset.id}$`));
      await press(s, t("overview-field-input-purchasePrice-save"));
      await sleep(1500);
      await unroute();
      s.problems();
      ctx.check("db", (await ctx.db.row("profiles", asset.id))?.fields?.purchasePrice == null, L("a refused save stores no purchase price"));
      ctx.check("screen", await vis(s, t("overview-field-input-purchasePrice")).isVisible().catch(() => false), L("and the line stays open with the figure typed, not shown as saved"));
      await press(s, t("overview-field-input-purchasePrice-save"));
      const priced = await waitRow(ctx, "profiles", asset.id, (r) => Number(r?.fields?.purchasePrice) === price);
      ctx.check("db", Number(priced?.fields?.purchasePrice) === price && Number(priced?.fields?.currentValue) === value, L(`the purchase price ${price} is stored and the value left alone`), JSON.stringify(priced?.fields));
      const lost = O.accumulatedDepreciation(price, value), pct = O.depreciationPct(price, value);
      const dep = await showsAmount(s, t("asset-depreciation-amount"), -lost, 1); // printed as a loss: "−$800 (−14.3%)"
      ctx.check("derived", dep.ok && dep.text.includes(pct.toFixed(1)), L(`the Value card says it has lost ${lost} (${pct}%)`), dep.text);

      // ── the value (Your value, tracking off) ──
      const value2 = value - ctx.int(1, 9) * 100;
      if (!(await vis(s, t("current-value-manual-amount")).isVisible().catch(() => false))) await press(s, t("asset-value-details-toggle"));
      await press(s, t("current-value-manual-amount"));
      await typeInto(s, t("current-value-manual-input"), String(value2));
      await press(s, t("current-value-manual-save"));
      const revalued = await waitRow(ctx, "profiles", asset.id, (r) => Number(r?.fields?.currentValue) === value2);
      ctx.same("db", Number(revalued?.fields?.currentValue), value2, L("the new value is stored"));
      ctx.check("screen", (await showsAmount(s, t("hero-stat-current-value"), value2, 1, 12000, value)).ok, L("the header shows the new value"));
      const lost2 = O.accumulatedDepreciation(price, value2), pct2 = O.depreciationPct(price, value2);
      const dep2 = await showsAmount(s, t("asset-depreciation-amount"), -lost2, 1, 12000, -lost);
      ctx.check("derived", dep2.ok && dep2.text.includes(pct2.toFixed(1)), L(`depreciation follows: ${lost2} (${pct2}%)`), dep2.text);
      const after = await snapshot(ctx);
      ctx.near("derived", O.cents(after.totalAssetValue - before.totalAssetValue), O.cents(value2 - value), L("total assets moved by the change in value"));

      // ── a characteristic ──
      const serial = `SN-${ctx.tag}-${s.surface}`;
      await press(s, t("asset-add-characteristic"));
      await typeInto(s, t("add-field-key"), "Serial number");
      await typeInto(s, t("add-field-value"), serial);
      await press(s, t("add-field-save"));
      const withSerial = await waitRow(ctx, "profiles", asset.id, (r) => Object.values(r?.fields || {}).includes(serial));
      ctx.check("db", Object.values(withSerial?.fields || {}).includes(serial) && Number(withSerial?.fields?.currentValue) === value2, L("the characteristic is stored beside the other fields"), JSON.stringify(withSerial?.fields));
      ctx.check("screen", (await showsText(s, t("asset-details"), serial)).ok, L("and is listed in Asset details"));

      // ── the name ──
      const newName = `${ctx.tag} ${s.surface} Cello (Bergonzi)`;
      await press(s, t("asset-detail-name"));
      await typeInto(s, t("asset-name-input"), newName);
      await press(s, t("asset-name-input-save"));
      ctx.same("db", (await waitRow(ctx, "profiles", asset.id, (r) => r?.name === newName))?.name, newName, L("the new name is stored"));

      // ── remove the purchase price: one tap arms, the second removes (Rule 8) ──
      await press(s, t("overview-missing-purchasePrice"));
      await press(s, t("overview-field-remove-purchasePrice"));
      await sleep(1200);
      ctx.check("db", Number((await ctx.db.row("profiles", asset.id))?.fields?.purchasePrice) === price, L("one tap on Remove removes nothing"));
      await press(s, t("overview-field-remove-purchasePrice"));
      const unpriced = await waitRow(ctx, "profiles", asset.id, (r) => r?.fields?.purchasePrice == null);
      ctx.check("db", unpriced?.fields?.purchasePrice == null && Number(unpriced?.fields?.currentValue) === value2, L("the second removes the purchase price, and only it"), JSON.stringify(unpriced?.fields));
      ctx.check("screen", await gone(vis(s, t("asset-depreciation-amount"))), L("with no purchase price the card no longer claims a depreciation"));

      // other screens, without a reload
      await goto(s, "/linked?tab=assets", "page-trackers");
      ctx.check("screen", (await showsText(s, t("page-trackers"), newName, 15000)).ok, L("the Assets tab lists the new name"));
      await goto(s, "/dashboard", "page-dashboard");
      const kpi = await showsAmount(s, t("hub-kpi-networth"), after.netWorth, 1, 12000, before.netWorth);
      ctx.check("screen", kpi.ok, L(`the Net worth tile reads ${after.netWorth}`), kpi.text);
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.asset-ownership",
  title: "Sharing, handing back, nesting and un-nesting an asset (mouse; the share slider dragged by touch on the phone): each owner's totals count their share, the household counts it once",
  area: "Ownership",
  browser: true,
  covers: ["asset.transfer.ui", "asset.cancel.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const reloads = watchReloads(s);
      const who = s.surface === "phone" ? "Nadia Okafor" : "Sam Ortiz";
      const partner = await mkProfile(ctx, { type: "person", name: `${ctx.tag} ${who}` });
      ctx.same("db", (await ctx.db.row("profiles", partner.id))?.type, "person", L("the co-owner is stored as a person"));
      const VALUE = 10000;
      const boat = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} ${s.surface} Sailboat`, fields: { currentValue: VALUE, valuationMode: "manual" } });
      const all0 = await snapshot(ctx), me0 = await snapshot(ctx, [ctx.self.id]), p0 = await snapshot(ctx, [partner.id]);
      const linksOf = () => ctx.db.rows("asset_party_links", `asset_profile_id=eq.${boat.id}`);

      await goto(s, `/profiles/${boat.id}`, "page-profile-detail");
      await scopeEveryone(s);
      await press(s, t("asset-detail-ownership"));
      await vis(s, t("card-ownership-editor")).waitFor({ timeout: 20000 });
      // A new asset is owned 100% by whoever it is filed under (the account
      // holder) — the row the editor starts from.
      const byParty = (rows: any[]) => Object.fromEntries(rows.map((l: any) => [l.party_profile_id, Number(l.ownership_percentage)]));
      const start = byParty(await linksOf());
      ctx.same("db", start, { [ctx.self.id]: 100 }, L("a new asset starts owned 100% by the account holder"));
      await vis(s, t(`owner-row-${ctx.self.id}`)).waitFor({ timeout: 10000 });
      const setUp = async () => {
        await vis(s, t("owner-add-select")).selectOption(partner.id);
        await vis(s, t(`owner-row-${partner.id}`)).waitFor({ timeout: 8000 });
      };
      // a draft that is Reset writes nothing
      await setUp();
      await press(s, t("owner-reset"));
      await sleep(800);
      ctx.same("db", byParty(await linksOf()), start, L("adding an owner and pressing Reset stores nothing"));

      await setUp();
      let mine = 60;
      if (s.surface === "phone") {
        // T1: dragging the share slider is the slider's own drag, never a page swipe
        const hash = await s.page.evaluate(() => window.location.hash);
        await touchDrag(s, t(`owner-slider-${ctx.self.id}`), 0.6);
        ctx.same("screen", await s.page.evaluate(() => window.location.hash), hash, L("dragging the share slider by touch stays on the asset (T1)"));
        mine = Number(await vis(s, t(`owner-input-${ctx.self.id}`)).inputValue());
        ctx.check("action", mine > 30 && mine < 90, L(`the drag moved the account holder's share (${mine}%)`), String(mine));
      } else {
        await typeInto(s, t(`owner-input-${ctx.self.id}`), "60");
      }
      await typeInto(s, t(`owner-input-${partner.id}`), String(100 - mine));
      ctx.same("db", byParty(await linksOf()), start, L("moving the shares alone stores nothing"));
      await pressTwice(s, t("owner-save"));
      const links = await waitRows(ctx, "asset_party_links", `asset_profile_id=eq.${boat.id}`, (r) => r.length === 2 && r.reduce((n: number, l: any) => n + Number(l.ownership_percentage), 0) === 100);
      await sleep(1200);
      const got = byParty(await linksOf());
      ctx.same("db", got, { [ctx.self.id]: mine, [partner.id]: 100 - mine }, L(`two owner rows, ${mine}% / ${100 - mine}% (a double press saved one split)`));
      ctx.check("db", links.length === 2, L("exactly two rows"), String(links.length));

      // each person's totals count their share; the household counts the whole once
      const shareP = O.netWorth([{ value: VALUE, sharePct: 100 - mine }], []).assets;
      const shareMe = O.netWorth([{ value: VALUE, sharePct: mine }], []).assets;
      const all1 = await snapshot(ctx), me1 = await snapshot(ctx, [ctx.self.id]), p1 = await snapshot(ctx, [partner.id]);
      ctx.near("derived", O.cents(p1.totalAssetValue - p0.totalAssetValue), shareP, L(`${who}'s assets rose by ${100 - mine}% of ${VALUE}`));
      ctx.near("derived", O.cents(me1.totalAssetValue - me0.totalAssetValue), O.cents(shareMe - VALUE), L(`the account holder now counts ${mine}% of it`));
      ctx.near("derived", all1.totalAssetValue, all0.totalAssetValue, L("the household total did not move"));
      // the screens: the partner's own view of net worth, without a reload
      await scopeTo(s, partner.id);
      const kp = await showsAmount(s, t("hub-kpi-networth"), p1.netWorth, 1, 15000, p0.netWorth);
      ctx.check("screen", kp.ok, L(`scoped to ${who}, the Net worth tile reads ${p1.netWorth}`), kp.text);
      await scopeTo(s, ctx.self.id);
      const km = await showsAmount(s, t("hub-kpi-networth"), me1.netWorth, 1, 15000, me0.netWorth);
      ctx.check("screen", km.ok, L(`scoped to the account holder, it reads ${me1.netWorth}`), km.text);
      await scopeEveryone(s);
      const ka = await showsAmount(s, t("hub-kpi-networth"), all1.netWorth, 1, 15000);
      ctx.check("screen", ka.ok, L(`for everyone, ${all1.netWorth}`), ka.text);

      // ── take the co-owner off: the account holder holds it all again ──
      const puts: string[] = [];
      const onReq = (r: any) => { if (r.method() === "PUT" && /\/owners$/.test(r.url())) puts.push(String(r.postData())); };
      s.page.on("request", onReq);
      await press(s, t(`owner-remove-${partner.id}`));
      await typeInto(s, t(`owner-input-${ctx.self.id}`), "100");
      ctx.step(`${s.surface}: before Save the editor shows ${await textOf(s, t("card-ownership-editor"))} / input ${await vis(s, t(`owner-input-${ctx.self.id}`)).inputValue().catch(() => "?")}`);
      await press(s, t("owner-save"));
      await sleep(1500);
      s.page.off("request", onReq);
      ctx.step(`${s.surface}: ownership writes sent: ${puts.join(" | ")}`);
      // (the server replaces the owner set in steps — remove, then re-weight — so
      // the wait is for the finished set, not the first moment one row is left)
      const back = await waitRows(ctx, "asset_party_links", `asset_profile_id=eq.${boat.id}`, (r) => r.length === 1 && Number(r[0].ownership_percentage) === 100);
      ctx.same("db", byParty(back), { [ctx.self.id]: 100 }, L("one owner row: the account holder at 100%"));
      const p2 = await snapshot(ctx, [partner.id]);
      ctx.near("derived", O.cents(p2.totalAssetValue - p0.totalAssetValue), 0, L(`${who} no longer counts any of it`));

      // ── nest it inside another asset, then take it out again ──
      const shed = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} ${s.surface} Boathouse`, fields: { currentValue: 2500, valuationMode: "manual" } });
      const allN0 = await snapshot(ctx);
      await goto(s, `/profiles/${shed.id}`, "page-profile-detail");
      await press(s, t("tab-contained"));
      await press(s, t("button-adopt-as-child"));
      await vis(s, t("dialog-adopt-as-child")).waitFor({ timeout: 10000 });
      await typeInto(s, t("input-adopt-search"), "Sailboat");
      await press(s, t(`option-adopt-${boat.id}`));
      await press(s, t("button-adopt-confirm"));
      const nested = await waitRow(ctx, "profiles", boat.id, (r) => r?.parent_profile_id === shed.id);
      ctx.same("db", nested?.parent_profile_id, shed.id, L("the sailboat is stored inside the boathouse"));
      ctx.check("screen", await seen(vis(s, t(`child-asset-row-${boat.id}`)), 12000), L("the boathouse's Contained tab lists it without a reload"));
      const allN1 = await snapshot(ctx);
      ctx.near("derived", allN1.totalAssetValue, allN0.totalAssetValue, L("nesting changes no total: each asset still counts once (LC3)"));
      ctx.check("screen", (await showsAmount(s, t("hero-stat-current-value"), 2500, 1)).ok, L("the boathouse's header still shows its own value"));

      await press(s, t(`child-actions-${boat.id}`));
      await press(s, t(`child-action-remove-${boat.id}`));
      await vis(s, t("dialog-confirm-remove")).waitFor({ timeout: 8000 });
      await press(s, t("confirm-remove-button"));
      const out = await waitRow(ctx, "profiles", boat.id, (r) => r?.parent_profile_id !== shed.id);
      ctx.check("db", out && out.parent_profile_id !== shed.id && out.deleted_at == null, L("taken out of the boathouse, not deleted"), String(out?.parent_profile_id));
      ctx.check("screen", await gone(vis(s, t(`child-asset-row-${boat.id}`))), L("and no longer listed inside it"));
      const allN2 = await snapshot(ctx);
      ctx.near("derived", allN2.totalAssetValue, allN0.totalAssetValue, L("un-nesting changes no total either"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.asset-delete",
  title: "Deleting an asset from its page (mouse and touch): Cancel keeps it, Delete removes it, and net worth, the Assets tab and the Net worth sheet follow without a reload",
  area: "Assets",
  browser: true,
  covers: ["asset.delete.ui"],
  requires: ["action", "db", "derived", "screen"],
  run: async (ctx) => {
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const reloads = watchReloads(s);
      const value = ctx.int(10, 40) * 100 + 25;
      const asset = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} ${s.surface} Telescope`, fields: { currentValue: value, valuationMode: "manual" } });
      await goto(s, "/dashboard", "page-dashboard");
      await scopeEveryone(s);
      const before = await snapshot(ctx);
      await goto(s, `/profiles/${asset.id}`, "page-profile-detail");
      await press(s, t("button-profile-menu"));
      await press(s, t("button-delete-profile"));
      await vis(s, t("dialog-confirm-delete-profile")).waitFor({ timeout: 8000 });
      await press(s, t("button-cancel-delete-profile"));
      await sleep(800);
      ctx.check("db", (await ctx.db.row("profiles", asset.id))?.deleted_at == null, L("Cancel keeps the asset"));
      await press(s, t("button-profile-menu"));
      await press(s, t("button-delete-profile"));
      await press(s, t("button-confirm-delete-profile"));
      const del = await waitRow(ctx, "profiles", asset.id, (r) => !r || r.deleted_at != null, 15000);
      ctx.check("db", !del || del.deleted_at != null, L("Delete removes it"));
      await s.page.waitForFunction((id: string) => !window.location.hash.includes(id), asset.id, { timeout: 10000 }).catch(() => undefined);
      ctx.check("action", !(await s.page.evaluate(() => window.location.hash)).includes(asset.id), L("the page leaves the deleted asset"), await s.page.evaluate(() => window.location.hash));
      const after = await snapshot(ctx);
      ctx.near("derived", O.cents(before.totalAssetValue - after.totalAssetValue), value, L(`total assets fell by its value (${value})`));
      ctx.near("derived", O.cents(before.netWorth - after.netWorth), value, L("and net worth by the same"));
      await goto(s, "/linked?tab=assets", "page-trackers");
      await sleep(1500);
      ctx.check("screen", !(await showsText(s, t("page-trackers"), `${ctx.tag} ${s.surface} Telescope`, 3000)).ok, L("the Assets tab no longer lists it"));
      await goto(s, "/dashboard", "page-dashboard");
      const kpi = await showsAmount(s, t("hub-kpi-networth"), after.netWorth, 1, 12000, before.netWorth);
      ctx.check("screen", kpi.ok, L(`the Net worth tile reads ${after.netWorth}`), kpi.text);
      await press(s, t("hub-kpi-networth"));
      await sleep(1500);
      ctx.check("screen", (await vis(s, t(`entity-row-${asset.id}`)).count()) === 0 || !(await vis(s, t(`entity-row-${asset.id}`)).isVisible().catch(() => false)), L("the Net worth sheet no longer lists it"));
      await s.page.keyboard.press("Escape");
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.settings-export",
  title: "Settings → Export (mouse and touch) downloads a file holding the account's own records, and exporting writes nothing",
  area: "Account",
  browser: true,
  covers: ["access.create.ui"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    const fs = await import("node:fs");
    const person = await mkProfile(ctx, { type: "person", name: `${ctx.tag} Export Quinn` });
    const asset = await mkProfile(ctx, { type: "asset", name: `${ctx.tag} Export Lamp`, fields: { currentValue: 140 } });
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} export task` }), "task");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    for (const s of surfaces(ctx)) {
      const L = (x: string) => `[${s.surface}] ${x}`;
      const reloads = watchReloads(s);
      await goto(s, "/settings", "card-data");
      const profilesInDb = await ctx.db.rows("profiles", "deleted_at=is.null&select=id");
      let file: any = null;
      const writes = await writesDuring(s, async () => {
        const [dl] = await Promise.all([s.page.waitForEvent("download", { timeout: 30000 }), press(s, t("button-export"))]);
        const p = await dl.path();
        ctx.check("action", /^portol-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), L(`a backup file is downloaded (${dl.suggestedFilename()})`));
        ctx.check("action", dl.suggestedFilename().includes(ctx.today), L("named for today in the user's zone"), dl.suggestedFilename());
        file = JSON.parse(fs.readFileSync(p, "utf8"));
      });
      ctx.check("action", writes.length === 0, L("exporting sends no write"), writes.join(", "));
      const text = JSON.stringify(file);
      ctx.check("db", Array.isArray(file?.profiles) && file.profiles.some((p: any) => p.id === person.id) && file.profiles.some((p: any) => p.id === asset.id), L("the file holds the person and the asset"));
      ctx.check("db", Array.isArray(file?.tasks) && file.tasks.some((x: any) => x.id === task.id), L("and the task"));
      const ids = new Set((file?.profiles || []).map((p: any) => p.id));
      ctx.check("db", profilesInDb.every((r: any) => ids.has(r.id)) && ids.size === profilesInDb.length, L(`every profile in the database (${profilesInDb.length}) is in the file, and nothing else`), `${ids.size} in file`);
      const exported = (file?.profiles || []).find((p: any) => p.id === asset.id);
      ctx.check("db", Number(exported?.fields?.currentValue) === 140, L("with its stored value"), JSON.stringify(exported?.fields));
      const owners = new Set((file?.profiles || []).map((p: any) => p.userId ?? p.user_id).filter(Boolean));
      ctx.check("db", [...owners].every((u) => u === SMOKE_USER_ID), L("and nothing of another account (every exported profile is this account's)"), JSON.stringify([...owners]));
      ctx.check("screen", await seen(s.page.getByText(/Export complete/i).locator("visible=true").first(), 8000), L("the screen says the export completed"));
      endSurface(ctx, s, L, reloads, await s.overflow());
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
scenario({
  id: "ui-profiles.settings-wipe",
  title: "Settings → Delete all data, on a brand-new throwaway account (touch): without the typed DELETE nothing happens; with it the account's records are gone and its sign-in and own profile stay",
  area: "Account",
  browser: true,
  isolatedOnly: true,
  covers: ["access.archive.ui"],
  requires: ["action", "db", "screen"],
  run: async (ctx) => {
    const { SB_URL, SB_ANON, API_BASE, UI_BASE } = await import("../../smoke/fixture/account");
    const browser = ctx.ui!.phone.page.context().browser();
    const bctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: "America/Los_Angeles" });
    try {
      const page = await bctx.newPage();
      const email = `wipe.${ctx.tag.toLowerCase()}@isolated.test`, password = "Isolated-Wipe-1!";
      const signup = await page.request.post(`${API_BASE}/auth/signup`, { data: { email, password }, headers: { "X-Forwarded-For": `10.4.${ctx.int(1, 250)}.${ctx.int(1, 250)}` } });
      const sj: any = await signup.json().catch(() => ({}));
      ctx.check("action", signup.ok() && !!sj?.session?.access_token, `a throwaway account is signed up (${signup.status()})`);
      const token = sj.session.access_token;
      const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const rest = async (table: string) => {
        const r = await page.request.get(`${SB_URL}/rest/v1/${table}?select=*`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${token}` } });
        if (!r.ok()) throw new Error(`db read ${table}: ${r.status()}`);
        return (await r.json()) as any[];
      };
      // some records of its own
      await page.request.get(`${API_BASE}/profiles`, { headers: H });
      const mk = async (path: string, body: any) => { const r = await page.request.post(`${API_BASE}${path}`, { headers: H, data: body }); if (!r.ok()) throw new Error(`${path}: ${r.status()}`); return r.json(); };
      await mk("/tasks", { title: `${ctx.tag} wipe task` });
      await mk("/profiles", { type: "asset", name: `${ctx.tag} wipe Kettle`, fields: { currentValue: 60 } });
      await mk("/expenses", { description: `${ctx.tag} wipe lunch`, amount: 12.5, category: "food", date: ctx.today });
      ctx.check("db", (await rest("tasks")).length === 1 && (await rest("expenses")).length === 1 && (await rest("profiles")).length === 2, "the new account holds its task, expense, asset and its own profile");

      // sign in through the screen
      await page.goto(UI_BASE);
      const emailBox = page.locator(t("input-signin-email"));
      if (!(await emailBox.isVisible({ timeout: 8000 }).catch(() => false))) {
        await page.getByRole("button", { name: /sign in|log in|get started/i }).first().tap({ timeout: 15000 }).catch(() => undefined);
        await page.locator(t("tab-signin")).tap({ timeout: 5000 }).catch(() => undefined);
      }
      await emailBox.waitFor({ timeout: 30000 });
      await emailBox.fill(email);
      await page.fill(t("input-signin-password"), password);
      await page.locator(t("button-signin")).tap();
      await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });
      await sleep(1500);
      ctx.check("screen", (await page.locator('[data-testid^="onboarding-"]').count()) === 0, "a brand-new account lands on the dashboard; no onboarding wizard is shown (OnboardingWizard is not mounted)");

      await page.evaluate(() => { window.location.hash = "#/settings"; });
      await page.waitForSelector(t("button-delete-data"), { timeout: 30000 });
      const confirmBtn = () => page.getByRole("button", { name: /I understand, delete everything/i });
      await page.locator(t("button-delete-data")).tap();
      await page.locator(t("input-delete-confirm")).waitFor({ timeout: 8000 });
      ctx.check("action", await confirmBtn().isDisabled(), "with nothing typed the delete button is disabled");
      await page.locator(t("input-delete-confirm")).fill("delete");
      ctx.check("action", await confirmBtn().isDisabled(), "'delete' in lower case does not arm it");
      await confirmBtn().tap({ force: true, timeout: 3000 }).catch(() => undefined);
      await sleep(1000);
      ctx.check("db", (await rest("tasks")).length === 1 && (await rest("expenses")).length === 1, "nothing was deleted without the exact word");
      await page.getByRole("button", { name: /^cancel$/i }).tap();
      await sleep(600);
      ctx.check("db", (await rest("tasks")).length === 1, "Cancel deletes nothing");

      await page.locator(t("button-delete-data")).tap();
      await page.locator(t("input-delete-confirm")).fill("DELETE");
      await confirmBtn().tap();
      await page.waitForFunction(() => window.location.hash.startsWith("#/dashboard"), undefined, { timeout: 30000 }).catch(() => undefined);
      ctx.check("screen", await seen(page.getByText(/All data deleted/i).first(), 10000), "the screen says the data was deleted");
      const until = Date.now() + 12000;
      let tasks = await rest("tasks"), expenses = await rest("expenses"), profiles = await rest("profiles");
      while ((tasks.length || expenses.length) && Date.now() < until) { await sleep(500); tasks = await rest("tasks"); expenses = await rest("expenses"); profiles = await rest("profiles"); }
      ctx.check("db", tasks.filter((x) => !x.deleted_at).length === 0 && expenses.filter((x) => !x.deleted_at).length === 0, "with DELETE typed, the task and expense are gone", `${tasks.length} tasks, ${expenses.length} expenses`);
      const live = profiles.filter((p) => !p.deleted_at);
      ctx.check("db", live.length === 1 && live[0].type === "self", "only the account's own profile is left (the dialog says it is preserved)", JSON.stringify(live.map((p) => [p.type, p.name])));
      const relog = await page.request.post(`${API_BASE}/auth/signin`, { data: { email, password }, headers: { "X-Forwarded-For": `10.5.${ctx.int(1, 250)}.${ctx.int(1, 250)}` } });
      ctx.check("action", relog.ok(), `the sign-in itself still works (${relog.status()})`);
      // the screens after the wipe, without a reload
      await page.waitForSelector(t("hub-kpi-networth"), { timeout: 20000 }).catch(() => undefined);
      const nw = (await page.locator(t("hub-kpi-networth")).innerText().catch(() => "")).replace(/\s+/g, " ");
      ctx.check("screen", /\$0\b/.test(nw), "the Net worth tile reads $0 after the wipe", nw);
      // the other account (this worker's) was not touched
      ctx.check("db", (await ctx.db.row("profiles", ctx.self.id)) != null, "the worker account's own rows are untouched");
    } finally {
      await bctx.close().catch(() => undefined);
    }
  },
});
