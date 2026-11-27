// Run the existing live checks (tests/live-*-check.ts) one after another and
// record which pass — the per-screen and per-domain checks the integrity report
// lists beside its own scenarios.
//   npx tsx scripts/run-live-checks.ts [--match <regex>] [--budget-minutes 60] [--each-minutes 10]
// Each check takes the smoke account's gate lock itself, so they queue behind
// one another (and behind any other gate). Writes test-results/integrity/live-checks.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const match = arg("--match") ? new RegExp(arg("--match")!) : null;
const budgetMs = Number(arg("--budget-minutes") ?? 90) * 60_000;
const eachMs = Number(arg("--each-minutes") ?? 10) * 60_000;
const outFile = path.resolve(arg("--out") ?? "test-results/integrity/live-checks.json");

const files = fs.readdirSync("tests").filter((f) => /^live-.*-check\.ts$/.test(f) && (!match || match.test(f))).sort();
const results: Array<{ name: string; ok: boolean; seconds: number; tail: string }> = [];
const started = Date.now();
const save = () => { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(results, null, 2)); };

async function freeGateLock(): Promise<void> {
  const { api } = await import("../tests/smoke/fixture/api");
  const { GATE_LOCK_KEY } = await import("../tests/smoke/fixture/gate-lock");
  await api("PUT", `/preferences/${GATE_LOCK_KEY}`, { value: "" });
}

function runOne(file: string): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    // its own process group, so a timeout stops the check itself and not only the launcher
    const child = spawn("npx", ["tsx", `tests/${file}`], { env: process.env, detached: true });
    let buf = "";
    const add = (d: Buffer) => { buf = (buf + d.toString()).slice(-6000); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, eachMs);
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      // A check stopped at the cap still HOLDS the smoke account's gate lock
      // (for up to its 10-minute expiry): the next check then waits on it and
      // is stopped too — one slow check failed its neighbours (2026-11-27).
      // The runner killed the holder, so the runner frees the lock.
      if (signal) await freeGateLock().catch(() => undefined);
      const fails = buf.split("\n").filter((l) => /^\s*(FAIL|✗|x )\b/.test(l)).slice(0, 3).join(" · ");
      resolve({ ok: code === 0, tail: signal ? `stopped after ${eachMs / 60_000} minutes` : fails || buf.trim().split("\n").slice(-2).join(" · ") });
    });
  });
}

async function main() {
  for (const file of files) {
    if (Date.now() - started > budgetMs) { console.log(`time budget reached; ${files.length - results.length} checks not run`); break; }
    const t0 = Date.now();
    process.stdout.write(`${file} … `);
    const r = await runOne(file);
    const seconds = Math.round((Date.now() - t0) / 1000);
    results.push({ name: file.replace(/\.ts$/, ""), ok: r.ok, seconds, tail: r.ok ? "" : r.tail });
    console.log(`${r.ok ? "pass" : "FAIL"} (${seconds}s)${r.ok ? "" : ` — ${r.tail.slice(0, 160)}`}`);
    save();
  }
  save();
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length} passed, ${bad.length} failed of ${results.length} run (${files.length} checks in all)`);
  process.exit(bad.length ? 1 : 0);
}
main();
