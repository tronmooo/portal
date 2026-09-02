import { launch, goto, report, settle } from "./pw";
const ctx = await launch();
await goto(ctx, "/dashboard", "cold dashboard (empty account)");
const title = await ctx.page.title(); console.log("title:", title);
const text = (await ctx.page.innerText("body")).slice(0, 600).replace(/\n+/g, " | "); console.log("body:", text);
await ctx.page.screenshot({ path: "tests/perf/out/shot-cold.png" });
await ctx.browser.close();
