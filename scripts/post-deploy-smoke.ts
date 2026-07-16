/**
 * Post-deploy production smoke probe.
 *
 * Runs against the live Vercel URL (default: https://portol.me) after a
 * deploy so production regressions surface in seconds rather than via an
 * angry message from the user.
 *
 * Usage:
 *   npx tsx scripts/post-deploy-smoke.ts                 # default → portol.me
 *   SMOKE_API_BASE=https://preview-xyz.vercel.app/api \
 *   SMOKE_UI_BASE=https://preview-xyz.vercel.app \
 *     npx tsx scripts/post-deploy-smoke.ts               # any deploy URL
 *
 * Exit code is non-zero if any probe fails, so this can be wired into a
 * Vercel post-deploy GitHub Action.
 *
 * NOTE: this is the *fast* probe — five HTTP calls, no fixture reset. Its
 * job is to detect a deploy that doesn't even boot. The full contract suite
 * runs pre-push.
 */
import { api, expectOk, getSmokeToken } from "../tests/smoke/fixture/api";
import { HIDDEN_TRACKER_CATEGORIES } from "../shared/hidden-tracker-categories";

type Probe = { name: string; run: () => Promise<void> };

const probes: Probe[] = [
  {
    name: "auth: smoke token mints",
    run: async () => {
      const t = await getSmokeToken(true);
      if (!t || t.length < 20) throw new Error(`bad token (len=${t?.length})`);
    },
  },
  {
    name: "api: /profiles 200",
    run: async () => {
      expectOk(await api("GET", "/profiles"));
    },
  },
  {
    name: "api: /stats 200 + has expected keys",
    run: async () => {
      const r = expectOk(await api<any>("GET", "/stats"));
      for (const k of ["monthlySpend", "totalProfiles"]) {
        if (!(k in r)) throw new Error(`missing /stats.${k}`);
      }
    },
  },
  {
    name: "api: /dashboard-enhanced 200 + financeSnapshot present",
    run: async () => {
      const r = expectOk(await api<any>("GET", "/dashboard-enhanced"));
      if (!r.financeSnapshot) throw new Error("missing financeSnapshot");
      if (typeof r.financeSnapshot.totalAssetValue !== "number") throw new Error("financeSnapshot.totalAssetValue not numeric");
    },
  },
  {
    name: "regression: BUG-20260528-finance-tracker (server rejects finance category)",
    run: async () => {
      const r = await api("POST", "/trackers", {
        name: `PostDeploy Probe ${Date.now()}`,
        category: "finance",
        unit: "$",
        fields: [{ name: "value", type: "number" }],
      });
      if (r.status < 400 || r.status >= 500) {
        throw new Error(`finance category should be rejected, got ${r.status}`);
      }
    },
  },
  {
    name: "regression: GET /trackers returns no hidden-category rows",
    run: async () => {
      const r = expectOk(await api<any[]>("GET", "/trackers"));
      const leaks = (r as any[]).filter((t: any) => HIDDEN_TRACKER_CATEGORIES.has(String(t.category || "").toLowerCase()));
      if (leaks.length) throw new Error(`leaked: ${leaks.map(l => l.name + "/" + l.category).join(",")}`);
    },
  },
  // ── PERF Phase 5.1 (PERF_PLAN_LAUNCH_2026-07-16.md): latency budgets ───────
  // Warm-path budgets for the endpoints that gate what users feel: app open
  // (dashboard-bootstrap) and People switching (profiles/lite). Each probe
  // hits the endpoint once to warm the instance + response cache, then
  // asserts the SECOND hit lands under budget — a deploy that regresses the
  // warm path 2x fails the gate. Budgets are deliberately loose enough to
  // absorb network jitter from CI; override via SMOKE_PERF_BUDGET_MS_* envs.
  {
    name: "perf: warm /dashboard-bootstrap under budget",
    run: async () => {
      const budget = Number(process.env.SMOKE_PERF_BUDGET_MS_BOOTSTRAP || 2000);
      const month = new Date().toISOString().slice(0, 7);
      await api("GET", `/dashboard-bootstrap?month=${month}`); // warm instance + cache
      const t0 = Date.now();
      expectOk(await api("GET", `/dashboard-bootstrap?month=${month}`));
      const ms = Date.now() - t0;
      if (ms > budget) throw new Error(`warm bootstrap took ${ms}ms (budget ${budget}ms)`);
    },
  },
  {
    name: "perf: warm /profiles/lite under budget",
    run: async () => {
      const budget = Number(process.env.SMOKE_PERF_BUDGET_MS_PROFILES_LITE || 1200);
      await api("GET", "/profiles/lite"); // warm
      const t0 = Date.now();
      expectOk(await api("GET", "/profiles/lite"));
      const ms = Date.now() - t0;
      if (ms > budget) throw new Error(`warm profiles/lite took ${ms}ms (budget ${budget}ms)`);
    },
  },
  {
    name: "perf: warm /stats under budget",
    run: async () => {
      const budget = Number(process.env.SMOKE_PERF_BUDGET_MS_STATS || 1500);
      await api("GET", "/stats"); // warm
      const t0 = Date.now();
      expectOk(await api("GET", "/stats"));
      const ms = Date.now() - t0;
      if (ms > budget) throw new Error(`warm stats took ${ms}ms (budget ${budget}ms)`);
    },
  },
];

(async () => {
  const base = process.env.SMOKE_API_BASE || "https://portol.me/api";
  console.log(`[post-deploy-smoke] target: ${base}`);
  let failed = 0;
  for (const p of probes) {
    const t0 = Date.now();
    try {
      await p.run();
      console.log(`  PASS  ${p.name}  (${Date.now() - t0}ms)`);
    } catch (err: any) {
      failed++;
      console.log(`  FAIL  ${p.name}  (${Date.now() - t0}ms)`);
      console.log(`         → ${err.message}`);
    }
  }
  if (failed > 0) {
    console.log(`\n[post-deploy-smoke] ${failed} probe(s) failed.`);
    process.exit(1);
  }
  console.log(`\n[post-deploy-smoke] all ${probes.length} probes passed.`);
})().catch(err => {
  console.error("[post-deploy-smoke] crashed:", err);
  process.exit(1);
});
