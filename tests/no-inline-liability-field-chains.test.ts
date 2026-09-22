// Rule 11 — one field has one canonical source.
//
// A loan's APR, balance and monthly payment are read through
// shared/liability-fields (which delegates balance to shared/asset-value).
// Before this, fourteen spellings of "interest rate" were probed by five
// different inline chains, and the same loan showed 6% on one page and 0.1%
// on another. This static scan fails the build the moment a new inline alias
// chain appears outside the canonical readers.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["client/src", "shared", "server"];
/** The canonical readers themselves, and the value resolver they delegate to. */
const ALLOWED = new Set([
  "shared/liability-fields.ts",
  "shared/asset-value.ts",
]);

const CHAIN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "APR chain starting from annualInterestRate", re: /\bannualInterestRate\s*\?\?/ },
  { label: "APR chain starting from f.apr", re: /\bf\.apr\s*\?\?/ },
  { label: "APR ||-chain (interestRate || rate || apr)", re: /interestRate\s*\|\|\s*\w*\.?rate\s*\|\|\s*\w*\.?apr/ },
  { label: "APR chain mixing apr and interestRate", re: /\.apr\s*\?\?\s*[\w.]*interestRate/ },
  { label: "payment chain monthlyPayment ?? … monthlyAmount", re: /monthlyPayment\s*\?\?\s*[\w.?\s]*monthlyAmount/ },
  { label: "payment chain monthlyAmount ?? … monthlyPayment", re: /monthlyAmount\s*\?\?\s*[\w.?\s]*monthlyPayment/ },
  { label: "balance chain currentBalance ?? … remainingBalance", re: /currentBalance\s*\?\?\s*[\w.?\s]*remainingBalance/ },
  { label: "balance chain remainingBalance ?? … balance", re: /remainingBalance\s*\?\?\s*[\w.?\s]*\.balance\b/ },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("Rule 11 — no inline liability field alias chains", () => {
  it("every APR / balance / payment read goes through shared/liability-fields", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (ALLOWED.has(rel)) continue;
        const text = readFileSync(file, "utf8");
        const lines = text.split("\n");
        lines.forEach((line, i) => {
          if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
          for (const { label, re } of CHAIN_PATTERNS) {
            if (re.test(line)) offenders.push(`${rel}:${i + 1} — ${label}`);
          }
        });
      }
    }
    expect(offenders, `Inline alias chains found. Use readInterestRatePct / readBalance / readMonthlyPayment from shared/liability-fields:\n${offenders.join("\n")}`).toEqual([]);
  });
});
