// One command for the whole integrity system.
//
//   npm run integrity            local guards → maps → live run → report
//   npm run integrity:local      local guards and maps only (no network)
//   npm run integrity -- --only money --no-chat     passed through to the live run
//
// 1. Local: type-check, then the three integrity test files (the model guard,
//    the randomized oracle properties, the guards for past findings). The full
//    local suite is `npx vitest run`; CI runs it on every push.
// 2. Maps: docs/WORKFLOW_MATRIX.md and docs/INTEGRITY_MAP.md, regenerated from the code.
// 3. Live: tests/integrity/run.ts against the deployed app (smoke account, gate lock).
// 4. Report: docs/INTEGRITY_REPORT.md.
// Exits 1 if any step fails; the report is written either way.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const localOnly = args.includes("--local");
const pass = args.filter((a) => a !== "--local");
const run = (label: string, cmd: string, argv: string[]) => {
  console.log(`\n━━ ${label}\n$ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { stdio: "inherit", env: process.env });
  return r.status === 0;
};

let ok = true;
fs.mkdirSync("test-results/integrity", { recursive: true });
ok = run("type-check", "npx", ["tsc", "--noEmit"]) && ok;
ok = run("local integrity guards", "npx", ["vitest", "run", "tests/integrity-model.test.ts", "tests/integrity-oracle-properties.test.ts", "tests/integrity-run-fixes-2026-11-27.test.ts", "tests/workflow-matrix.test.ts", "--reporter=default", "--reporter=json", "--outputFile=test-results/integrity/local.json"]) && ok;
ok = run("workflow matrix", "npx", ["tsx", "scripts/gen-workflow-matrix.ts"]) && ok;
ok = run("integrity map", "npx", ["tsx", "scripts/gen-integrity-map.ts"]) && ok;
if (!localOnly) {
  ok = run("live integrity run (deployed app, smoke account)", "npx", ["tsx", "tests/integrity/run.ts", ...pass]) && ok;
  run("report", "npx", ["tsx", "scripts/gen-integrity-report.ts", "--local", "test-results/integrity/local.json"]);
}
console.log(ok ? "\nINTEGRITY: ALL GREEN" : "\nINTEGRITY: FAILURES — see above" + (localOnly ? "" : " and docs/INTEGRITY_REPORT.md"));
process.exit(ok ? 0 : 1);
