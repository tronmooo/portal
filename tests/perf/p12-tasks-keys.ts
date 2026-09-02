import { launch, goto, settle, report } from "./pw";
const ctx = await launch(); const page = ctx.page;
await goto(ctx, "/dashboard", "dashboard"); await goto(ctx, "/tasks", "tasks");
const rows: any[] = await page.evaluate(() => (window as any).__portolQueryClient.getQueryCache().getAll().filter((q: any) => q.observers.length > 0).map((q: any) => ({ key: JSON.stringify(q.queryKey), obs: q.observers.length })));
console.log("observed keys on /tasks:"); for (const r of rows) console.log("  ", r.obs, r.key);
ctx.mark(); await page.click("[data-testid=button-new-task]"); await page.fill("[data-testid=input-task-title]", "Key trace task"); const t0 = Date.now(); await page.click("[data-testid=button-submit-task]"); await settle(page, 1500);
for (const c of ctx.calls.filter(c => c.start >= ctx.since)) console.log(`  +${String(c.start - t0).padStart(4)}ms ${String((c.end || 0) - c.start).padStart(4)}ms ${c.status ?? c.failed} ${c.method} ${c.url}`);
await ctx.browser.close();
