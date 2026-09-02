import { launch, goto, settle, report, perf } from "./pw";
const ctx = await launch(); const page = ctx.page; const T = () => Date.now();
const api = async (m: string, p: string) => (await page.request.fetch("http://localhost:5000" + p, { method: m, headers: { "x-local-user": "u1" } })).json().catch(() => null);
async function untilVisible(sel: string, max = 8000) { const t = T(); while (T() - t < max) { if (await page.locator(sel).first().isVisible().catch(() => false)) return T() - t; await page.waitForTimeout(10); } return -1; }
await goto(ctx, "/dashboard", "dashboard");
ctx.mark(); await page.click("[data-testid=quick-create-fab]"); await page.waitForTimeout(200);
const opts = await page.locator("[data-testid^=quick-create-]").evaluateAll(els => els.map(e => e.getAttribute("data-testid"))); console.log("quick-create options:", opts.join(", "));
const person = opts.find(o => /person|people/.test(o || "")) || opts.find(o => /profile/.test(o || ""));
if (person) { await page.click(`[data-testid=${person}]`); console.log("dialog after", await untilVisible("[data-testid=dialog-create-profile]"), "ms");
  await page.fill("[data-testid=input-profile-name]", "Probe Person"); for (let i = 0; i < 3; i++) { const next = page.locator("[data-testid=btn-next-create-profile]"); if (await next.isVisible().catch(() => false)) { await next.click(); await page.waitForTimeout(150); } }
  const t0 = T(); await page.click("[data-testid=btn-submit-create-profile]"); const seen = await untilVisible("text=Probe Person"); await settle(page);
  const post = ctx.calls.find(c => c.method === "POST" && c.url === "/api/profiles"); console.log(`CREATE PROFILE: visible after ${seen}ms; POST done ${post ? post.end! - t0 : "?"}ms`); report(ctx, "create profile"); await perf(ctx, "create profile");
  await page.click("[data-testid=hub-profile-switcher]"); await page.waitForTimeout(300); const inSwitcher = /Probe Person/.test(await page.locator("body").innerText()); await page.keyboard.press("Escape"); console.log("switcher lists new person:", inSwitcher);
  await goto(ctx, "/profiles/list", "profiles list"); console.log("profiles list shows:", /Probe Person/.test(await page.innerText("body")));
  const ps: any[] = await api("GET", "/api/profiles/lite"); const created = ps.find(p => p.name === "Probe Person"); console.log("server has it:", !!created);
  if (created) { await goto(ctx, `/profiles/${created.id}`, "open new person"); ctx.mark(); await page.click("[data-testid=button-tracker-detail-menu], [data-testid=btn-delete-profile], button:has-text('Delete')").catch(() => {}); await page.waitForTimeout(200);
    const r = await page.request.fetch(`http://localhost:5000/api/profiles/${created.id}`, { method: "DELETE", headers: { "x-local-user": "u1" } }); console.log("API delete:", r.status());
    await goto(ctx, "/profiles/list", "profiles list after delete"); console.log("list still shows after out-of-band delete:", /Probe Person/.test(await page.innerText("body"))); }
}
// rapid filter changes on finance
await goto(ctx, "/finance", "finance"); ctx.mark(); await page.evaluate(() => { (window as any).__lt = []; }); const t1 = T();
for (const v of ["month", "30d", "year", "all", "month", "all"]) { await page.click("[data-testid=select-expense-range]"); await page.waitForTimeout(80); await page.locator("[role=option]", { hasText: new RegExp(v === "30d" ? "30" : v, "i") }).first().click().catch(() => page.keyboard.press("Escape")); await page.waitForTimeout(120); }
console.log(`rapid range changes wall ${T() - t1}ms`); report(ctx, "rapid range filter"); await perf(ctx, "rapid filters");
await ctx.browser.close();
