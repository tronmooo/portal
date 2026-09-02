import { launch, goto, settle, report, perf } from "./pw";
const ctx = await launch(); const page = ctx.page;
const T = () => Date.now();
async function untilVisible(sel: string, max = 8000) { const t = T(); while (T() - t < max) { if (await page.locator(sel).first().isVisible().catch(() => false)) return T() - t; await page.waitForTimeout(10); } return -1; }
async function untilGone(sel: string, max = 8000) { const t = T(); while (T() - t < max) { if (!(await page.locator(sel).first().isVisible().catch(() => false))) return T() - t; await page.waitForTimeout(10); } return -1; }
const kpi = async () => (await page.locator("text=TASKS DUE").first().locator("xpath=..").innerText().catch(() => "?")).replace(/\n/g, " ");
await goto(ctx, "/dashboard", "dashboard before");
const kpiBefore = await kpi(); console.log("KPI before:", kpiBefore);
await goto(ctx, "/tasks", "tasks page");
const summaryBefore = (await page.locator("[data-testid=tasks-summary]").innerText()).replace(/\n/g, " "); console.log("summary before:", summaryBefore);
// CREATE
ctx.mark(); await page.click("[data-testid=button-new-task]");
console.log("dialog visible after", await untilVisible("[data-testid=dialog-create-task]"), "ms");
await page.fill("[data-testid=input-task-title]", "Probe task Alpha");
await page.fill("[data-testid=input-task-due-date]", new Date().toISOString().slice(0, 10)).catch(e => console.log("due date fill failed", String(e).slice(0, 80)));
const t0 = T(); await page.click("[data-testid=button-submit-task]");
const vis = await untilVisible("text=Probe task Alpha"); const dlgGone = await untilGone("[data-testid=dialog-create-task]");
await settle(page);
const post = ctx.calls.find(c => c.method === "POST" && c.url === "/api/tasks");
console.log(`CREATE: visible after ${vis}ms, dialog closed +${dlgGone}ms, POST done at ${post ? (post.end! - t0) : "?"}ms → ${post && vis < post.end! - t0 ? "OPTIMISTIC" : "WAITED FOR SERVER"}`);
report(ctx, "create task"); await perf(ctx, "create");
const summaryAfter = (await page.locator("[data-testid=tasks-summary]").innerText()).replace(/\n/g, " "); console.log("summary after create:", summaryAfter);
const card = page.locator("[data-testid^=card-task-]", { hasText: "Probe task Alpha" }).first();
const id = (await card.getAttribute("data-testid"))!.replace("card-task-", ""); console.log("task id:", id);
// DASHBOARD SYNC
await goto(ctx, "/dashboard", "dashboard after create");
console.log("KPI after create:", await kpi(), "| widget shows new task:", await page.locator("text=Probe task Alpha").first().isVisible().catch(() => false));
// EDIT
await goto(ctx, "/tasks", "tasks again");
ctx.mark(); await page.click(`[data-testid=task-edit-trigger-${id}]`); await untilVisible("[data-testid=dialog-edit-task]");
await page.fill("[data-testid=input-task-title]", "Probe task Alpha v2"); const t1 = T(); await page.click("[data-testid=button-submit-task]");
const vis2 = await untilVisible("text=Probe task Alpha v2"); await settle(page);
const patch = ctx.calls.find(c => c.method === "PATCH" && c.url.includes(id));
console.log(`EDIT: visible after ${vis2}ms, PATCH done at ${patch ? patch.end! - t1 : "?"}ms → ${patch && vis2 < patch.end! - t1 ? "OPTIMISTIC" : "WAITED"}`);
report(ctx, "edit task");
// COMPLETE (checkbox)
ctx.mark(); const t2 = T(); await page.click(`[data-testid=checkbox-task-${id}]`); await page.waitForTimeout(50);
const checked = async () => (await page.locator(`[data-testid=checkbox-task-${id}]`).getAttribute("data-state").catch(() => null)) || (await page.locator(`[data-testid=checkbox-task-${id}]`).getAttribute("aria-checked").catch(() => null));
let tc = -1; { const s = T(); while (T() - s < 5000) { const st = await checked(); if (st === "checked" || st === "true") { tc = T() - t2; break; } await page.waitForTimeout(10); } }
await settle(page); const patch2 = ctx.calls.find(c => c.method === "PATCH" && c.url.includes(id));
console.log(`COMPLETE: checked after ${tc}ms, PATCH done at ${patch2 ? patch2.end! - t2 : "?"}ms`);
report(ctx, "complete task");
console.log("summary after complete:", (await page.locator("[data-testid=tasks-summary]").innerText()).replace(/\n/g, " "));
await goto(ctx, "/dashboard", "dashboard after complete"); console.log("KPI after complete:", await kpi());
// DELETE
await goto(ctx, "/tasks", "tasks for delete");
await page.click("[data-testid=task-tab-filters] >> text=/Completed/").catch(() => {});
await page.waitForTimeout(200);
ctx.mark(); await page.click(`[data-testid=button-delete-task-${id}]`); await untilVisible(`[data-testid=alert-delete-task-${id}]`);
const t3 = T(); await page.click("[data-testid=button-confirm-delete-task]");
const gone = await untilGone(`[data-testid=card-task-${id}]`); await settle(page);
const del = ctx.calls.find(c => c.method === "DELETE" && c.url.includes(id));
console.log(`DELETE: gone after ${gone}ms, DELETE done at ${del ? del.end! - t3 : "?"}ms → ${del && gone < del.end! - t3 ? "OPTIMISTIC" : "WAITED"}`);
report(ctx, "delete task");
await goto(ctx, "/dashboard", "dashboard after delete"); console.log("KPI after delete:", await kpi(), "| still shows deleted:", await page.locator("text=Probe task Alpha").first().isVisible().catch(() => false));
// RAPID DOUBLE SUBMIT
await goto(ctx, "/tasks", "tasks rapid");
ctx.mark(); await page.click("[data-testid=button-new-task]"); await untilVisible("[data-testid=dialog-create-task]");
await page.fill("[data-testid=input-task-title]", "Probe rapid double");
await page.click("[data-testid=button-submit-task]", { noWaitAfter: true }); await page.click("[data-testid=button-submit-task]", { noWaitAfter: true, timeout: 500 }).catch(() => console.log("second click blocked (button disabled/closed) — good"));
await settle(page); report(ctx, "double submit");
const n = await page.locator("[data-testid^=card-task-]", { hasText: "Probe rapid double" }).count(); console.log("cards named 'Probe rapid double':", n);
const serverN = ((await (await page.request.get("http://localhost:5000/api/tasks")).json()) as any[]).filter(t => t.title === "Probe rapid double").length; console.log("server rows:", serverN);
await ctx.browser.close();
