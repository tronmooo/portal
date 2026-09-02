import { launch, goto, settle, report, perf } from "./pw";
const ctx = await launch(); const page = ctx.page; const T = () => Date.now();
const api = async (p: string) => (await page.request.get("http://localhost:5000" + p, { headers: { "x-local-user": "u1" } })).json();
async function untilVisible(sel: string, max = 8000) { const t = T(); while (T() - t < max) { if (await page.locator(sel).first().isVisible().catch(() => false)) return T() - t; await page.waitForTimeout(10); } return -1; }
async function untilText(sel: string, re: RegExp, max = 8000) { const t = T(); while (T() - t < max) { const tx = await page.locator(sel).first().innerText().catch(() => ""); if (re.test(tx)) return T() - t; await page.waitForTimeout(10); } return -1; }
async function section(name: string, fn: () => Promise<void>) { console.log(`\n######## ${name}`); try { await fn(); } catch (e) { console.log("SECTION FAILED:", String(e).split("\n").slice(0, 3).join(" | ")); await page.screenshot({ path: `tests/perf/out/fail-${name.replace(/\W+/g, "_")}.png` }); } }
await goto(ctx, "/dashboard", "dashboard");
const trackers: any[] = await api("/api/trackers"); const weight = trackers.find(t => t.name === "Weight" && t.linkedProfiles?.length !== 1 || t.name === "Weight"); const run = trackers.find(t => t.name === "Running");
console.log("weight tracker", weight?.id, "entries", weight?.entries?.length);
await section("tracker: add entry via detail dialog", async () => {
  await goto(ctx, "/trackers", "trackers");
  const dashTile = (await page.locator(`[data-testid=card-tracker-${weight.id}]`).innerText().catch(() => "")).replace(/\n/g, " ").slice(0, 120); console.log("card before:", dashTile);
  ctx.mark(); await page.click(`[data-testid=card-tracker-${weight.id}]`); console.log("detail dialog visible after", await untilVisible("[data-testid=tracker-detail-dialog]"), "ms"); await settle(page); report(ctx, "open tracker detail");
  await page.click("[data-testid=button-add-entry-detail]"); console.log("add-entry dialog after", await untilVisible(`[data-testid=dialog-add-entry-${weight.id}]`), "ms");
  const inputs = await page.locator(`[data-testid=dialog-add-entry-${weight.id}] input`).evaluateAll(els => els.map(e => (e as HTMLInputElement).getAttribute("data-testid") + ":" + (e as HTMLInputElement).type)); console.log("entry inputs:", inputs.join(", "));
  await page.fill("[data-testid=input-entry-value]", "177.7");
  ctx.mark(); const t0 = T(); await page.click("[data-testid=button-entry-submit]");
  const seen = await untilText("[data-testid=tracker-detail-dialog]", /177\.7/); await settle(page);
  const post = ctx.calls.find(c => c.method === "POST" && c.url.includes("/entries"));
  console.log(`ADD ENTRY: value visible after ${seen}ms; POST done at ${post ? post.end! - t0 : "?"}ms → ${post && seen >= 0 && seen < post.end! - t0 ? "OPTIMISTIC" : "WAITED/NOT SEEN"}`);
  report(ctx, "add entry"); await perf(ctx, "add entry");
  const after: any = (await api("/api/trackers")).find((t: any) => t.id === weight.id); console.log("server entries now", after.entries.length, "latest", JSON.stringify(after.entries[after.entries.length - 1]?.values));
});
await section("tracker: rapid 5 entries", async () => {
  const before: any = (await api("/api/trackers")).find((t: any) => t.id === weight.id);
  ctx.mark(); const t0 = T();
  for (let i = 0; i < 5; i++) {
    await page.click("[data-testid=button-add-entry-detail]"); await untilVisible(`[data-testid=dialog-add-entry-${weight.id}]`);
    await page.fill("[data-testid=input-entry-value]", String(176 + i / 10)); await page.click("[data-testid=button-entry-submit]");
  }
  await settle(page); console.log(`5 rapid entries wall ${T() - t0}ms`); report(ctx, "rapid entries"); await perf(ctx, "rapid");
  const after: any = (await api("/api/trackers")).find((t: any) => t.id === weight.id); console.log("server entries delta", after.entries.length - before.entries.length, "(expected 5)");
  const dlg = (await page.locator("[data-testid=tracker-detail-dialog]").innerText()).replace(/\n/g, " "); console.log("dialog shows 176.4:", /176\.4/.test(dlg), "| shows 176:", /\b176\b/.test(dlg));
});
await section("tracker: edit + delete entry", async () => {
  const cur: any = (await api("/api/trackers")).find((t: any) => t.id === weight.id); const last = cur.entries[cur.entries.length - 1]; console.log("editing entry", last.id, last.values);
  await page.click("[data-testid=tab-history]").catch(() => {}); await page.waitForTimeout(300);
  const rowSel = `[data-testid=entry-row-${last.id}]`; console.log("row visible:", await untilVisible(rowSel, 3000));
  if (!(await page.locator(rowSel).count())) { const ids = await page.locator("[data-testid=tracker-detail-dialog] [data-testid]").evaluateAll(els => [...new Set(els.map(e => e.getAttribute("data-testid")!.replace(/[0-9a-f-]{36}/g, "<id>")))]); console.log("history tab testids:", ids.join(", ")); }
  await page.click(`[data-testid=edit-entry-${last.id}]`).catch(async e => { console.log("no edit trigger:", String(e).slice(0, 60)); });
  const editInputs = await page.locator(`[data-testid^=entry-field-]`).evaluateAll(els => els.map(e => e.getAttribute("data-testid"))); console.log("edit fields:", editInputs.join(","));
  if (editInputs.length) { await page.fill(`[data-testid=${editInputs[0]}]`, "150"); ctx.mark(); const t1 = T(); await page.click(`[data-testid=entry-save-${last.id}]`); const seen = await untilText("[data-testid=tracker-detail-dialog]", /\b150\b/); await settle(page); const patch = ctx.calls.find(c => c.method === "PATCH" && c.url.includes(last.id)); console.log(`EDIT ENTRY: visible after ${seen}ms; PATCH done ${patch ? patch.end! - t1 : "?"}ms`); report(ctx, "edit entry"); }
  ctx.mark(); await page.click(`[data-testid=button-delete-entry-${last.id}]`); await untilVisible(`[data-testid=alert-delete-entry-${last.id}]`); const t2 = T(); await page.click("[data-testid=button-delete-entry-confirm]");
  let gone = -1; { const s = T(); while (T() - s < 6000) { if (!(await page.locator(rowSel).first().isVisible().catch(() => false))) { gone = T() - s; break; } await page.waitForTimeout(10); } }
  await settle(page); const del = ctx.calls.find(c => c.method === "DELETE"); console.log(`DELETE ENTRY: gone after ${gone}ms; DELETE done ${del ? del.end! - t2 : "?"}ms`); report(ctx, "delete entry");
  const after: any = (await api("/api/trackers")).find((t: any) => t.id === weight.id); console.log("server still has entry:", after.entries.some((e: any) => e.id === last.id));
});
await section("dashboard reflects tracker", async () => {
  await goto(ctx, "/dashboard", "dashboard after tracker writes");
  const body = await page.innerText("body"); console.log("dashboard mentions 176.4:", /176\.4/.test(body), "| mentions 150:", /\b150\b/.test(body));
});
await section("habit: check-in", async () => {
  await goto(ctx, "/habits", "habits");
  const habits: any[] = await api("/api/habits"); const h = habits.find(x => x.name === "Read 20 min") || habits[0]; console.log("habit", h.id, h.name, "todayCount", h.todayCount, "streak", h.streak);
  const card = page.locator(`[data-testid=card-habit-${h.id}]`); console.log("card text:", (await card.innerText()).replace(/\n/g, " ").slice(0, 200));
  const btns = await card.locator("button").evaluateAll(els => els.map(e => (e.getAttribute("data-testid") || e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 30))); console.log("card buttons:", btns.join(" | "));
  const seg = card.locator("[data-testid^=button-seg-]").first(); const has = await seg.count();
  ctx.mark(); const t0 = T(); if (has) await seg.click(); else await card.locator("button").first().click();
  const changed = await untilText(`[data-testid=card-habit-${h.id}]`, /1\s*\/\s*1|done|✓|100%/i, 5000); await settle(page);
  const post = ctx.calls.find(c => c.method === "POST" && c.url.includes("checkin")); console.log(`CHECKIN: ui changed after ${changed}ms; POST done ${post ? post.end! - t0 : "?"}ms`); report(ctx, "checkin"); await perf(ctx, "checkin");
  const after = (await api("/api/habits")).find((x: any) => x.id === h.id); console.log("server todayCount", after.todayCount, "streak", after.streak);
  await goto(ctx, "/dashboard", "dashboard after checkin"); const w = (await page.locator("text=HABITS").first().locator("xpath=../..").innerText().catch(() => "")).replace(/\n/g, " ").slice(0, 200); console.log("habits widget:", w);
});
await section("expense: create via finance page", async () => {
  await goto(ctx, "/finance", "finance");
  const cf = async () => (await page.locator("text=CASH FLOW").first().locator("xpath=..").innerText().catch(() => "?")).replace(/\n/g, " "); console.log("cash flow before:", await cf());
  ctx.mark(); await page.click("[data-testid=button-add-expense]"); console.log("expense form after", await untilVisible("[data-testid=input-expense-amount]"), "ms");
  await page.fill("[data-testid=input-expense-amount]", "43.21"); await page.fill("[data-testid=input-expense-description]", "Probe latte");
  const t0 = T(); await page.click("[data-testid=button-save-expense]"); const seen = await untilVisible("text=Probe latte"); await settle(page);
  const post = ctx.calls.find(c => c.method === "POST" && c.url === "/api/expenses"); console.log(`ADD EXPENSE: visible after ${seen}ms; POST done ${post ? post.end! - t0 : "?"}ms → ${post && seen >= 0 && seen < post.end! - t0 ? "OPTIMISTIC" : "WAITED"}`);
  report(ctx, "add expense"); await perf(ctx, "add expense"); console.log("cash flow after:", await cf());
  await goto(ctx, "/dashboard", "dashboard after expense"); console.log("dashboard cash flow:", await cf(), "| mentions Probe latte:", /Probe latte/.test(await page.innerText("body")));
});
await ctx.browser.close();
