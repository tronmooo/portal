import { launch, settle } from "./pw";
const ctx = await launch(); const page = ctx.page;
const cdp = await page.context().newCDPSession(page);
const events: any[] = [];
cdp.on("Tracing.dataCollected", (d: any) => events.push(...d.value));
await cdp.send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.stack", transferMode: "ReportEvents" } as any);
await page.goto("http://localhost:5000/#/dashboard", { waitUntil: "domcontentloaded" }); await settle(page);
await cdp.send("Tracing.end"); await new Promise(r => cdp.once("Tracing.tracingComplete", r));
const dur = (e: any) => (e.dur || 0) / 1000;
const top = events.filter(e => e.ph === "X" && dur(e) >= 15 && ["Layout", "UpdateLayoutTree", "FunctionCall", "EvaluateScript", "RunTask", "Paint", "ParseHTML", "TimerFire", "EventDispatch", "v8.compile", "RecalculateStyles", "PrePaint", "Commit"].includes(e.name)).sort((a, b) => a.ts - b.ts);
const t0 = Math.min(...events.filter(e => e.ts).map(e => e.ts));
console.log("events ≥15ms (ms since trace start):");
for (const e of top) { const a = e.args?.data || {}; const extra = e.name === "FunctionCall" ? `${a.functionName || ""} ${(a.url || "").replace(/^.*\/assets\//, "")}:${a.lineNumber}` : e.name === "Layout" ? `nodes=${a.dirtyObjects ?? a.totalObjects ?? ""}` : e.name === "EvaluateScript" ? (a.url || "").replace(/^.*\/assets\//, "") : ""; console.log(`  +${String(Math.round((e.ts - t0) / 1000)).padStart(5)}ms ${String(Math.round(dur(e))).padStart(4)}ms ${e.name} ${extra}`); }
await ctx.browser.close();
