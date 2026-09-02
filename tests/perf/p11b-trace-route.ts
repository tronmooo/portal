import { launch, goto, settle } from "./pw";
const route = process.argv[2] || "/artifacts";
const ctx = await launch(); const page = ctx.page; await goto(ctx, "/dashboard", "warm");
const cdp = await page.context().newCDPSession(page); const events: any[] = []; cdp.on("Tracing.dataCollected", (d: any) => events.push(...d.value));
await cdp.send("Tracing.start", { categories: "devtools.timeline,v8,disabled-by-default-devtools.timeline.stack", transferMode: "ReportEvents" } as any);
await page.goto(`http://localhost:5000/#${route}`, { waitUntil: "domcontentloaded" }); await settle(page);
await cdp.send("Tracing.end"); await new Promise(r => cdp.once("Tracing.tracingComplete", r));
const dur = (e: any) => (e.dur || 0) / 1000; const t0 = Math.min(...events.filter(e => e.ts).map(e => e.ts));
const top = events.filter(e => e.ph === "X" && dur(e) >= 10 && ["Layout", "UpdateLayoutTree", "FunctionCall", "EvaluateScript", "v8.compile", "V8.CompileScript", "v8.compileModule", "V8.CompileModule", "EvaluateModule", "v8.evaluateModule", "ParseHTML", "Paint", "RecalculateStyles"].includes(e.name)).sort((a, b) => a.ts - b.ts);
for (const e of top) { const a = e.args?.data || {}; console.log(`  +${String(Math.round((e.ts - t0) / 1000)).padStart(5)}ms ${String(Math.round(dur(e))).padStart(4)}ms ${e.name} ${(a.url || a.fileName || "").replace(/^.*\/assets\//, "")} ${a.functionName || ""}${a.lineNumber != null ? ":" + a.lineNumber : ""}`); }
await ctx.browser.close();
