import { launch, goto, settle, report } from "./pw";
import fs from "fs"; import path from "path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
const maps = new Map<string, TraceMap | null>();
function mapFrame(line: string): string {
  const m = line.match(/\/assets\/([^:]+\.js):(\d+):(\d+)/); if (!m) return "";
  let tm = maps.get(m[1]); if (tm === undefined) { const p = path.resolve("dist/public/assets", m[1] + ".map"); tm = fs.existsSync(p) ? new TraceMap(JSON.parse(fs.readFileSync(p, "utf8"))) : null; maps.set(m[1], tm); }
  if (!tm) return ""; const o = originalPositionFor(tm, { line: +m[2], column: +m[3] }); if (!o.source || !/client\/src/.test(o.source)) return ""; return `${o.source.replace(/^.*client\/src\//, "")}:${o.line}${o.name ? " " + o.name : ""}`;
}
const HOOK = `(() => { const w = window; w.__inv = [];
  const hook = () => { const qc = w.__portolQueryClient; if (!qc || qc.__hooked) return; qc.__hooked = true;
    for (const name of ["invalidateQueries", "refetchQueries", "resetQueries"]) { const orig = qc[name].bind(qc);
      qc[name] = function () { const a = arguments[0]; w.__inv.push({ t: Date.now(), name, arg: JSON.stringify(a && a.queryKey ? a.queryKey : (a && a.predicate ? "<predicate>" : a)), rt: a && a.refetchType, stack: new Error().stack }); return orig.apply(qc, arguments); }; } };
  setInterval(hook, 50); })()`;
const ctx = await launch(); const page = ctx.page;
await page.addInitScript(HOOK);
const flow = process.argv[2] || "task";
await goto(ctx, "/dashboard", "dashboard");
let t0 = 0;
if (flow === "task") {
  await goto(ctx, "/tasks", "tasks"); await page.evaluate(() => { (window as any).__inv = []; });
  ctx.mark(); await page.click("[data-testid=button-new-task]"); await page.fill("[data-testid=input-task-title]", "Trace task"); t0 = Date.now(); await page.click("[data-testid=button-submit-task]");
} else {
  await goto(ctx, "/trackers", "trackers"); const trackers: any[] = await (await page.request.get("http://localhost:5000/api/trackers", { headers: { "x-local-user": "u1" } })).json(); const w = trackers.find(t => t.name === "Weight");
  await page.click(`[data-testid=card-tracker-${w.id}]`); await page.click("[data-testid=button-add-entry-detail]"); await page.fill("[data-testid=input-entry-value]", "169.9"); await page.evaluate(() => { (window as any).__inv = []; });
  ctx.mark(); t0 = Date.now(); await page.click("[data-testid=button-entry-submit]");
}
await settle(page, 1500); report(ctx, `${flow} write`);
const inv: any[] = await page.evaluate(() => (window as any).__inv);
console.log(`\n${inv.length} invalidate/refetch calls after the write:`);
for (const i of inv) {
  const frames = String(i.stack).split("\n").slice(1).map(mapFrame).filter(Boolean).filter(f => !/^lib\/queryClient.ts/.test(f)).slice(0, 4).join(" ← ");
  console.log(`  +${String(i.t - t0).padStart(4)}ms ${i.name} ${i.arg} rt=${i.rt ?? "default"}  @ ${frames}`);
}
await ctx.browser.close();
