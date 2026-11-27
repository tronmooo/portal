// The integrity run: every scenario in tests/integrity/scenarios against the
// deployed app, as the smoke account, under its gate lock.
//
//   npx tsx tests/integrity/run.ts                 everything
//   npx tsx tests/integrity/run.ts --only money    scenarios whose id matches
//   npx tsx tests/integrity/run.ts --no-browser --no-chat
//   npx tsx tests/integrity/run.ts --seed 42       the same random data again
//
// Results: test-results/integrity/results.json (+ screenshots of failures);
// `npx tsx scripts/gen-integrity-report.ts` turns them into docs/INTEGRITY_REPORT.md.
// Exit code 1 when any scenario is not PASS (skipped ones aside).
import path from "node:path";
import fs from "node:fs";
import { api } from "../smoke/fixture/api";
import { UI_BASE } from "../smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "../smoke/fixture/gate-lock";
import { allScenarios, runScenarios, type UiHandle } from "./framework";
import "./scenarios/index";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (name: string) => process.argv.includes(name);

async function main() {
  const seed = Number(arg("--seed") ?? process.env.INTEGRITY_SEED ?? Math.floor(Date.now() / 86_400_000));
  const only = arg("--only") ? new RegExp(arg("--only")!) : undefined;
  const outDir = path.resolve(arg("--out") ?? "test-results/integrity");
  const wantBrowser = !flag("--no-browser");
  if (flag("--list")) { for (const s of allScenarios()) console.log(`${s.id}\t${s.requires.join("+")}\t${s.title}`); return; }

  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "integrity" });
  let exit = 1;
  let browser: any;
  try {
    const version = await api("GET", "/version");
    console.log(`production serves ${String(version.data?.sha).slice(0, 7)}; seed ${seed}`);
    const profiles = await api("GET", "/profiles");
    const self = (profiles.data as any[]).find((p) => p.type === "self");
    if (!self) throw new Error("the smoke account has no self profile");

    let ui: UiHandle | undefined;
    const needsBrowser = allScenarios().some((s) => s.browser && (!only || only.test(s.id)));
    if (wantBrowser && needsBrowser) {
      try {
        const { chromium, openSignedIn } = await import("../helpers/live-browser");
        browser = await chromium.launch();
        const desktop = await openSignedIn(browser, "desktop", true);
        const phone = await openSignedIn(browser, "phone", true);
        fs.mkdirSync(path.join(outDir, "screenshots"), { recursive: true });
        ui = {
          desktop, phone,
          shot: async (page, name) => {
            const file = path.join(outDir, "screenshots", `${name}.png`);
            await page.screenshot({ path: file });
            return path.relative(process.cwd(), file);
          },
        };
      } catch (e: any) {
        console.log(`browser unavailable: ${String(e?.message || e).slice(0, 200)}`);
      }
    }

    const { results, findings, timings } = await runScenarios({ seed, only, chat: !flag("--no-chat"), browser: wantBrowser, outDir, ui, self: { id: self.id, name: self.name } });
    const by = (s: string) => results.filter((r) => r.status === s);
    console.log(`\n${by("pass").length} pass · ${by("fail").length} fail · ${by("incomplete").length} incomplete · ${by("error").length} error · ${by("skipped").length} skipped`);
    for (const r of [...by("fail"), ...by("error"), ...by("incomplete")]) {
      console.log(`\n${r.status.toUpperCase()} ${r.id} — ${r.title}`);
      for (const c of r.checks.filter((c) => !c.ok)) console.log(`   ✗ [${c.kind}] ${c.what}${c.detail ? ` — ${c.detail}` : ""}`);
      if (r.error) console.log(`   ${r.error.split("\n")[0]}`);
      if (r.missing.length) console.log(`   owes evidence: ${r.missing.join(", ")}`);
    }
    for (const f of findings) console.log(`\nFINDING [${f.severity}] ${f.title} (${f.scenario})\n   ${f.detail}`);
    const slow = new Map<string, number>();
    for (const t of timings) slow.set(t.call, Math.max(slow.get(t.call) ?? 0, t.ms));
    const over = [...slow.entries()].filter(([, ms]) => ms > 1500).sort((a, b) => b[1] - a[1]);
    if (over.length) console.log(`\nslow calls (>1.5 s): ${over.map(([c, ms]) => `${c} ${ms}ms`).join("; ")}`);
    exit = results.some((r) => r.status === "fail" || r.status === "error" || r.status === "incomplete") ? 1 : 0;
    void UI_BASE;
  } catch (e) {
    console.error(e);
  } finally {
    await browser?.close().catch(() => undefined);
    await release();
  }
  process.exit(exit);
}

main();
