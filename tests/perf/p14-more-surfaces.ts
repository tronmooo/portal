import { launch, goto, settle, report, perf } from "./pw";
const ctx = await launch(); const page = ctx.page; const T = () => Date.now();
const api = async (p: string) => (await page.request.get("http://localhost:5000" + p, { headers: { "x-local-user": "u1" } })).json();
async function untilVisible(sel: string, max = 8000) { const t = T(); while (T() - t < max) { if (await page.locator(sel).first().isVisible().catch(() => false)) return T() - t; await page.waitForTimeout(10); } return -1; }
async function section(name: string, fn: () => Promise<void>) { console.log(`\n######## ${name}`); try { await fn(); } catch (e) { console.log("SECTION FAILED:", String(e).split("\n").slice(0, 3).join(" | ")); await page.screenshot({ path: `tests/perf/out/fail-${name.replace(/\W+/g, "_")}.png` }); } }
const profiles: any[] = await api("/api/profiles/lite"); const self = profiles.find(p => p.type === "self"); const bob = profiles.find(p => p.name === "Bob Partner");
await goto(ctx, "/dashboard", "dashboard");
await section("profile switch self→Bob→self (dashboard)", async () => {
  ctx.mark(); await page.click("[data-testid=hub-profile-switcher]"); console.log("menu after", await untilVisible(`[data-testid=hub-switch-${bob.id}]`), "ms");
  const t0 = T(); await page.click(`[data-testid=hub-switch-${bob.id}]`);
  const label = await (async () => { const s = T(); while (T() - s < 5000) { const tx = await page.locator("[data-testid=hub-profile-switcher]").innerText().catch(() => ""); if (/Bob/.test(tx)) return T() - s; await page.waitForTimeout(10); } return -1; })();
  await settle(page, 1200); console.log(`switch label shows Bob after ${label}ms`); report(ctx, "switch to Bob"); await perf(ctx, "switch");
  const body = await page.innerText("body"); console.log("dashboard shows Alex-only task 'Task 1: Call dentist'?", /Task 1: Call dentist/.test(body), "| net worth text:", (body.match(/NET WORTH[^A-Z]*/)?.[0] || "").replace(/\n/g, " ").slice(0, 40));
  ctx.mark(); await page.click("[data-testid=hub-profile-switcher]"); await untilVisible(`[data-testid=hub-switch-${self.id}]`); await page.click(`[data-testid=hub-switch-${self.id}]`); await settle(page, 1200); report(ctx, "switch back to self");
  ctx.mark(); await page.click("[data-testid=hub-profile-switcher]"); await untilVisible("[data-testid=hub-switch-everyone]"); await page.click("[data-testid=hub-switch-everyone]"); await settle(page, 1200); report(ctx, "switch to everyone"); await perf(ctx, "everyone");
  ctx.mark(); await page.click("[data-testid=hub-profile-switcher]"); await untilVisible(`[data-testid=hub-switch-${self.id}]`); await page.click(`[data-testid=hub-switch-${self.id}]`); await settle(page, 1200); report(ctx, "back to self again");
});
await section("calendar: create event via UI", async () => {
  await goto(ctx, "/calendar", "calendar");
  ctx.mark(); await page.click("[data-testid=btn-add-event-cal]"); console.log("event form after", await untilVisible("[data-testid=input-event-title]"), "ms");
  await page.fill("[data-testid=input-event-title]", "Probe dentist visit"); const d = new Date(); d.setDate(d.getDate() + 2); const iso = d.toISOString().slice(0, 10); await page.fill("[data-testid=input-event-date]", iso).catch(() => {}); await page.fill("[data-testid=input-event-time]", "14:30").catch(() => {});
  const t0 = T(); await page.click("[data-testid=btn-save-event]"); const seen = await untilVisible("text=Probe dentist visit"); await settle(page);
  const post = ctx.calls.find(c => c.method === "POST" && c.url === "/api/events"); console.log(`CREATE EVENT: visible after ${seen}ms; POST done ${post ? post.end! - t0 : "?"}ms → ${post && seen >= 0 && seen < post.end! - t0 ? "OPTIMISTIC" : "WAITED"}`); report(ctx, "create event"); await perf(ctx, "create event");
  await goto(ctx, "/dashboard", "dashboard after event"); console.log("dashboard mentions event:", /Probe dentist visit/.test(await page.innerText("body")));
  const ev: any[] = await api("/api/events"); console.log("server has event:", ev.some(e => e.title === "Probe dentist visit"));
});
await section("search ⌘K", async () => {
  ctx.mark(); await page.click("[data-testid=button-command-search-trigger]"); console.log("palette after", await untilVisible("[data-testid=input-command-search]"), "ms");
  const t0 = T(); await page.fill("[data-testid=input-command-search]", "Probe dentist");
  const hit = await untilVisible("[data-testid^=item-search-event-]", 6000); await settle(page); console.log(`search result after ${hit}ms`); report(ctx, "search"); await page.keyboard.press("Escape");
  ctx.mark(); await page.click("[data-testid=button-command-search-trigger]"); await untilVisible("[data-testid=input-command-search]"); await page.fill("[data-testid=input-command-search]", "Grocery run #5"); const hit2 = await untilVisible("[data-testid^=item-search-]", 6000); console.log(`expense search result after ${hit2}ms`); await settle(page); report(ctx, "search expense"); await page.keyboard.press("Escape");
});
await section("journal: create free-text entry", async () => {
  await goto(ctx, "/journal", "journal");
  ctx.mark(); await page.click("[data-testid=button-new-journal]").catch(() => {}); await page.click("[data-testid=btn-journal-mode-free]").catch(() => {}); console.log("editor after", await untilVisible("[data-testid=input-journal-free-text]"), "ms");
  await page.fill("[data-testid=input-journal-free-text]", "Probe journal entry: long walk, felt great."); const t0 = T(); await page.click("[data-testid=button-save-journal-free]");
  const seen = await untilVisible("text=Probe journal entry"); await settle(page); const post = ctx.calls.find(c => c.method === "POST" && c.url === "/api/journal"); console.log(`CREATE JOURNAL: visible after ${seen}ms; POST done ${post ? post.end! - t0 : "?"}ms`); report(ctx, "create journal");
});
await section("artifacts: delete a note", async () => {
  await goto(ctx, "/artifacts", "artifacts"); const arts: any[] = await api("/api/artifacts"); const a = arts.find(x => x.title === "Gate code") || arts[0];
  ctx.mark(); await page.click(`[data-testid=button-delete-${a.id}]`); await untilVisible("[data-testid=button-artifact-delete-confirm]"); const t0 = T(); await page.click("[data-testid=button-artifact-delete-confirm]");
  let gone = -1; { const s = T(); while (T() - s < 6000) { if (!(await page.locator(`[data-testid=artifact-card-${a.id}]`).first().isVisible().catch(() => false))) { gone = T() - s; break; } await page.waitForTimeout(10); } }
  await settle(page); const del = ctx.calls.find(c => c.method === "DELETE"); console.log(`DELETE ARTIFACT: gone after ${gone}ms; DELETE done ${del ? del.end! - t0 : "?"}ms`); report(ctx, "delete artifact");
});
await section("profiles list + open person", async () => {
  await goto(ctx, "/profiles/list", "profiles list"); ctx.mark(); const t0 = T(); await page.click(`[data-testid=profile-card-${bob.id}]`); const seen = await untilVisible("text=Bob Partner"); await settle(page); console.log(`open Bob after ${seen}ms`); report(ctx, "open Bob from list"); await perf(ctx, "open Bob");
});
await ctx.browser.close();
