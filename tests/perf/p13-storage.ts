import { launch, goto } from "./pw";
const ctx = await launch(); const page = ctx.page;
await goto(ctx, "/dashboard", "dashboard"); await page.waitForTimeout(3000);
const m = await page.evaluate(() => { let total = 0; const items: [string, number][] = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; const v = localStorage.getItem(k) || ""; total += v.length; items.push([k, v.length]); } items.sort((a, b) => b[1] - a[1]); return { total, top: items.slice(0, 6) }; });
console.log("localStorage total chars:", m.total, "top:", m.top.map(([k, n]) => `${k.slice(0, 40)}=${n}`).join(" | "));
const t = await page.evaluate(() => { const k = "portol-query-cache-v1"; const v = localStorage.getItem(k) || ""; const t0 = performance.now(); const parsed = JSON.parse(v); const t1 = performance.now(); JSON.stringify(parsed); const t2 = performance.now(); return { parse: Math.round(t1 - t0), stringify: Math.round(t2 - t1), entries: Array.isArray(parsed?.entries) ? parsed.entries.length : Object.keys(parsed || {}).length }; });
console.log("persisted cache parse/stringify ms:", t);
await ctx.browser.close();
