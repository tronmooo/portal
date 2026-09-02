import { launch, goto, report, settle } from "./pw";
const ctx = await launch();
const routes = ["/dashboard", "/trackers", "/profiles/list", "/calendar", "/finance", "/habits", "/tasks", "/goals", "/journal", "/obligations", "/wellness", "/artifacts", "/insights", "/settings", "/chat", "/dashboard"];
await goto(ctx, "/dashboard", "cold dashboard");
// find profile ids
const profiles: any[] = await (await ctx.page.request.get("http://localhost:5000/api/profiles/lite")).json();
const pick = (t: string) => profiles.find(p => p.type === t)?.id;
const detail = [["self", pick("self")], ["person", pick("person")], ["vehicle", pick("vehicle")], ["loan", pick("loan")], ["pet", pick("pet")], ["property", pick("property")], ["account", pick("account")]];
for (const r of routes.slice(1)) {
  await goto(ctx, r, r);
  const marks = await ctx.page.evaluate(() => performance.getEntriesByType("mark").map(m => `${m.name}@${Math.round(m.startTime)}`).slice(-12).join(" "));
  if (marks) console.log("  marks:", marks);
  await ctx.page.screenshot({ path: `tests/perf/out/shot-${r.replace(/\W+/g, "_")}.png` });
}
for (const [t, id] of detail) { if (!id) continue; await goto(ctx, `/profiles/${id}`, `profile detail ${t}`); await ctx.page.screenshot({ path: `tests/perf/out/shot-profile-${t}.png` }); }
// Back navigation
ctx.mark(); await ctx.page.goBack(); await settle(ctx.page); report(ctx, "goBack");
ctx.mark(); await ctx.page.goBack(); await settle(ctx.page); report(ctx, "goBack 2");
// Reload warm
await goto(ctx, "/dashboard", "warm reload dashboard (persisted cache)");
await ctx.browser.close();
