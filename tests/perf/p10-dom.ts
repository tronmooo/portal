import { launch, goto } from "./pw";
const ctx = await launch(); const page = ctx.page;
const self = ((await (await page.request.get("http://localhost:5000/api/profiles/lite", { headers: { "x-local-user": "u1" } })).json()) as any[]).find(p => p.type === "self").id;
for (const r of ["/dashboard", "/trackers", "/finance", "/calendar", "/tasks", `/profiles/${self}`, "/habits", "/wellness"]) {
  await goto(ctx, r, r);
  const m = await page.evaluate(() => ({ nodes: document.querySelectorAll("*").length, svg: document.querySelectorAll("svg").length, paths: document.querySelectorAll("path").length, imgs: document.images.length, height: document.body.scrollHeight }));
  const layout = await page.evaluate(() => { const t = performance.now(); document.body.style.paddingLeft = "1px"; void document.body.offsetWidth; document.body.style.paddingLeft = ""; void document.body.offsetWidth; return Math.round((performance.now() - t) * 10) / 10; });
  console.log(`  DOM ${r}: nodes=${m.nodes} svg=${m.svg} paths=${m.paths} imgs=${m.imgs} height=${m.height} forcedLayoutx2=${layout}ms`);
}
await ctx.browser.close();
