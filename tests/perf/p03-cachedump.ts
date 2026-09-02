import { launch, goto, settle, report } from "./pw";
const ctx = await launch();
await ctx.page.addInitScript(() => { try { localStorage.setItem("portol_debug_qc", "1"); } catch {} });
async function dump(label: string) {
  const rows: any[] = await ctx.page.evaluate(() => {
    const qc = (window as any).__portolQueryClient; if (!qc) return [{ err: "no qc" }];
    return qc.getQueryCache().getAll().map((q: any) => ({ key: JSON.stringify(q.queryKey), obs: q.observers.length, updates: q.state.dataUpdateCount, fetch: q.state.fetchStatus, status: q.state.status, stale: q.isStale(), age: q.state.dataUpdatedAt ? Date.now() - q.state.dataUpdatedAt : null }));
  });
  const byEp = new Map<string, any[]>();
  for (const r of rows) { const ep = (() => { try { return JSON.parse(r.key)[0]; } catch { return r.key; } })(); byEp.set(ep, [...(byEp.get(ep) || []), r]); }
  console.log(`\n### cache after ${label}: ${rows.length} queries, ${rows.filter(r => r.obs > 0).length} observed`);
  for (const [ep, rs] of [...byEp.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (rs.length < 2 && rs[0].obs === 0) continue;
    console.log(`  ${ep}: ${rs.length} keys`);
    for (const r of rs) console.log(`      obs=${r.obs} upd=${r.updates} ${r.status}/${r.fetch}${r.stale ? " stale" : ""} ${r.key}`);
  }
}
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ["/dashboard", "/trackers", "/calendar", "/finance", "/habits", "/tasks", "/wellness"];
for (const r of routes) { await goto(ctx, r, r); await dump(r); }
await ctx.browser.close();
