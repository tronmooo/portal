import { launch, goto, settle } from "./pw";
import fs from "fs"; import path from "path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
const maps = new Map<string, TraceMap | null>();
function mapPos(url: string, line: number, col: number): string {
  const file = url.replace(/^.*\/assets\//, ""); if (!file || !/\.js$/.test(file)) return "";
  let tm = maps.get(file);
  if (tm === undefined) { const p = path.resolve("dist/public/assets", file + ".map"); tm = fs.existsSync(p) ? new TraceMap(JSON.parse(fs.readFileSync(p, "utf8"))) : null; maps.set(file, tm); }
  if (!tm) return "";
  const o = originalPositionFor(tm, { line: line + 1, column: col }); if (!o.source) return "";
  return ` ← ${o.source.replace(/^.*?(client\/src|node_modules)/, "$1")}:${o.line} ${o.name || ""}`;
}
const route = process.argv[2] || "/finance"; const warm = process.argv[3] !== "cold";
const ctx = await launch();
if (warm) await goto(ctx, "/dashboard", "warm-up dashboard");
const cdp = await ctx.page.context().newCDPSession(ctx.page);
await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await cdp.send("Profiler.start");
await goto(ctx, route, `profiled ${route}`);
const { profile } = await cdp.send("Profiler.stop") as any;
// aggregate self time by function
const nodes = new Map<number, any>(); for (const n of profile.nodes) nodes.set(n.id, n);
const self = new Map<string, number>(); const dt = profile.timeDeltas; let total = 0;
for (let i = 0; i < profile.samples.length; i++) { const n = nodes.get(profile.samples[i]); const cf = n.callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.replace(/^.*\/assets\//, "")}:${cf.lineNumber}:${cf.columnNumber}${mapPos(cf.url, cf.lineNumber, cf.columnNumber)}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); total += dt[i] || 0; }
console.log(`total sampled ${Math.round(total / 1000)}ms`);
for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(Math.round(v / 1000)).padStart(6)}ms ${k}`);
// inclusive time for named app functions (walk parents)
const parent = new Map<number, number>(); for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
const incl = new Map<string, number>();
for (let i = 0; i < profile.samples.length; i++) { let id: number | undefined = profile.samples[i]; const seen = new Set<string>(); while (id != null) { const n = nodes.get(id); const cf = n.callFrame; const k = `${cf.functionName || "(anon)"} ${cf.url.replace(/^.*\/assets\//, "")}:${cf.lineNumber}${mapPos(cf.url, cf.lineNumber, cf.columnNumber)}`; if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) || 0) + (dt[i] || 0)); } id = parent.get(id); } }
console.log("--- inclusive (app chunks only) ---");
for (const [k, v] of [...incl.entries()].filter(([k]) => /client\/src/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${String(Math.round(v / 1000)).padStart(6)}ms ${k}`);
await ctx.browser.close();
