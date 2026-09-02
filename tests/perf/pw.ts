// Playwright driver: records /api calls with timing per step, console errors, page errors.
import { chromium, type Page, type Browser } from "playwright-core";
export type Call = { id: number; method: string; url: string; start: number; end?: number; status?: number; bytes?: number; failed?: string };
export type Ctx = { browser: Browser; page: Page; calls: Call[]; errors: string[]; t0: number; mark: () => void; since: number };
export async function launch(opts: { latency?: number; user?: string; base?: string; slowMo?: number } = {}): Promise<Ctx> {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PW_EXE || "/opt/pw-browsers/chromium" }).catch(() => chromium.launch({ headless: true }));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: opts.user ? { "x-local-user": opts.user } : {} });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as any; w.__lt = []; w.__paint = {};
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) w.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true }); } catch {}
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) w.__paint[e.name] = Math.round(e.startTime); }).observe({ type: "paint", buffered: true }); } catch {}
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) w.__paint["lcp"] = Math.round(e.startTime); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch {}
    try { localStorage.setItem("portol_debug_qc", "1"); } catch {}
  });
  const calls: Call[] = []; const errors: string[] = []; let n = 0;
  const ctx: Ctx = { browser, page, calls, errors, t0: Date.now(), mark() { ctx.since = Date.now(); }, since: Date.now() };
  page.on("request", r => { if (r.url().includes("/api/")) (r as any).__c = { id: ++n, method: r.method(), url: r.url().replace(/^https?:\/\/[^/]+/, ""), start: Date.now() }, calls.push((r as any).__c); });
  page.on("response", async r => { const c = (r.request() as any).__c; if (c) { c.end = Date.now(); c.status = r.status(); try { c.bytes = (await r.body()).length; } catch {} } });
  page.on("requestfailed", r => { const c = (r as any).__c; if (c) { c.end = Date.now(); c.failed = r.failure()?.errorText; } });
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") errors.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`); });
  page.on("pageerror", e => errors.push(`[pageerror] ${String(e).slice(0, 300)}`));
  return ctx;
}
export async function settle(page: Page, quietMs = 700, max = 15000) {
  // wait until no /api request has been in flight for quietMs
  const start = Date.now();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  let lastActivity = Date.now();
  const onReq = () => { lastActivity = Date.now(); };
  page.on("request", onReq); page.on("response", onReq);
  try { while (Date.now() - lastActivity < quietMs || Date.now() - start < 300) { if (Date.now() - start > max) break; await page.waitForTimeout(50); } } finally { page.off("request", onReq); page.off("response", onReq); }
}
export function report(ctx: Ctx, label: string) {
  const cs = ctx.calls.filter(c => c.start >= ctx.since);
  const byKey = new Map<string, Call[]>();
  for (const c of cs) { const k = `${c.method} ${c.url}`; byKey.set(k, [...(byKey.get(k) || []), c]); }
  const first = cs.length ? Math.min(...cs.map(c => c.start)) : ctx.since;
  const last = cs.length ? Math.max(...cs.map(c => c.end || c.start)) : ctx.since;
  console.log(`\n=== ${label}: ${cs.length} api calls, span ${last - first}ms, wall ${Date.now() - ctx.since}ms ===`);
  for (const c of cs) {
    const dup = (byKey.get(`${c.method} ${c.url}`)!.length > 1) ? " DUP" : "";
    console.log(`  +${String(c.start - first).padStart(5)}ms ${String((c.end || Date.now()) - c.start).padStart(5)}ms ${c.status ?? (c.failed || "…")} ${c.method} ${c.url}${c.bytes != null ? ` ${c.bytes}B` : ""}${dup}`);
  }
  const dups = [...byKey.entries()].filter(([, v]) => v.length > 1);
  if (dups.length) console.log(`  DUPLICATES: ${dups.map(([k, v]) => `${k} x${v.length}`).join(" | ")}`);
  if (ctx.errors.length) { console.log(`  ERRORS: ${ctx.errors.length}`); for (const e of ctx.errors.splice(0)) console.log("   ", e); }
  ctx.mark();
}
/** Long tasks since the last call (main-thread blocking >50ms) plus paint marks. */
export async function perf(ctx: Ctx, label = "") {
  const r = await ctx.page.evaluate(() => { const w = window as any; const lt = w.__lt || []; w.__lt = []; return { lt, paint: w.__paint || {}, now: Math.round(performance.now()) }; }).catch(() => null);
  if (!r) return;
  const total = r.lt.reduce((a: number, x: number[]) => a + x[1], 0);
  const worst = [...r.lt].sort((a: number[], b: number[]) => b[1] - a[1]).slice(0, 4).map((x: number[]) => `${x[1]}ms@${x[0]}`).join(" ");
  console.log(`  perf${label ? " " + label : ""}: longTasks=${r.lt.length} blocked=${total}ms worst=[${worst}] paint=${JSON.stringify(r.paint)} now=${r.now}`);
}
export async function goto(ctx: Ctx, hash: string, label = hash, base = "http://localhost:5000") {
  ctx.mark();
  const t = Date.now();
  await ctx.page.goto(`${base}/#${hash}`, { waitUntil: "domcontentloaded" });
  await settle(ctx.page);
  report(ctx, `${label} (goto, ${Date.now() - t}ms)`);
  await perf(ctx);
}
export async function click(ctx: Ctx, selector: string, label?: string) {
  ctx.mark(); const t = Date.now();
  await ctx.page.click(selector, { timeout: 5000 });
  await settle(ctx.page);
  report(ctx, `${label || "click " + selector} (${Date.now() - t}ms)`);
}
