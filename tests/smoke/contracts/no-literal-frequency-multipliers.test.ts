/**
 * Build-time guard: no literal frequency-to-monthly multipliers.
 *
 * Audit finding 1.2: monthly conversion was done with truncated literals
 * (4.33 / 4.333 / 4.345 weekly, 2.17 biweekly, 30.44 daily) in some places
 * and exact fractions (52/12, 26/12, 365/12) in others, giving cents-level
 * drift between tiles that show "the same" number.
 *
 * The canonical conversion is `toMonthlyAmount()` in
 * shared/obligation-windows.ts. Any NEW numeric literal of these tokens —
 * truncated decimals OR inline exact fractions — outside that module fails
 * this test. (Comments are stripped before matching; the tests/ directory is
 * not scanned.)
 *
 * PRE-EXISTING VIOLATIONS (counted 2026-06-10) carry pinned per-file budgets
 * below. Budgets may only ever go DOWN — migrate the call site to
 * toMonthlyAmount() and lower the number; never raise it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIRS = ["client/src", "server", "shared"].map(d => path.join(REPO_ROOT, d));

/** The canonical module — the only place these constants may live. */
const CANONICAL_FILE = "shared/obligation-windows.ts";

/**
 * Pre-existing violations, pinned per file (2026-06-10). Documented so a
 * future cleanup can find them. BUDGETS ONLY GO DOWN.
 *
 * client/src/pages/profile-detail.tsx (13)
 *   :415 (4.345), :416 (30.44), :2970 (30.44 month-length), :3981 (4.33),
 *   :3982 (2.17), :4514-:4516 (52/12, 26/12, 365/12), :9811-:9813 (52/12,
 *   26/12, 365/12), :10507 (4.33), :10523 (30.44 month-length)
 * client/src/components/dashboard/HeroKPIPopups.tsx (1)  :460 (4.333)
 * client/src/pages/trackers.tsx (2)  :5035, :5075 (inline 52/12 + 26/12 chains)
 * server/ai-engine.ts (1)  :9120 (4.33)
 * server/storage.ts (2)  :1869 (4.33), :1870 (2.17)
 * shared/spending-baseline.ts (1)
 *   :108 bucketsInDays — DELIBERATE canonical definition of "a month is
 *   365/12 days" for spending math (documented in that module's header).
 *   Allowed at exactly 1; new fractions there must reuse the constant.
 */
const VIOLATION_BUDGETS: Record<string, number> = {
  "client/src/pages/profile-detail.tsx": 13,
  "client/src/components/dashboard/HeroKPIPopups.tsx": 1,
  "client/src/pages/trackers.tsx": 2,
  "server/ai-engine.ts": 1,
  "server/storage.ts": 2,
  "shared/spending-baseline.ts": 1,
};

// Numeric-literal tokens. Lookarounds enforce standalone numbers so version
// strings like "2.171" or "14.33" do NOT match, while "4.333" (a longer
// truncation of 52/12) DOES via the trailing \d* on 4.33.
const FORBIDDEN: { pattern: RegExp; name: string }[] = [
  { pattern: /(?<![\d.\w])4\.33\d*(?![\d\w])/, name: "literal 4.33x weekly multiplier" },
  { pattern: /(?<![\d.\w])4\.345(?![\d\w])/, name: "literal 4.345 weekly multiplier" },
  { pattern: /(?<![\d.\w])2\.17(?![\d\w])/, name: "literal 2.17 biweekly multiplier" },
  { pattern: /(?<![\d.\w])30\.44(?![\d\w])/, name: "literal 30.44 days-per-month" },
  { pattern: /(?<![\d.\w])52\s*\/\s*12(?![\d\w])/, name: "inline 52 / 12 weekly fraction" },
  { pattern: /(?<![\d.\w])26\s*\/\s*12(?![\d\w])/, name: "inline 26 / 12 biweekly fraction" },
  { pattern: /(?<![\d.\w])365\s*\/\s*12(?![\d\w])/, name: "inline 365 / 12 daily fraction" },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "build" || entry === "tests") continue;
      walk(p, out);
    } else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
      out.push(p);
    }
  }
  return out;
}

/** Strip // and slash-star comments while respecting string/template literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; i += 2; continue; }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out += c; i++; continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += c; } i++; continue; }
    if (state === "block") { if (c === "*" && n === "/") { state = "code"; i += 2; continue; } if (c === "\n") out += c; i++; continue; }
    if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    out += c; i++;
  }
  return out;
}

function findMultiplierLines(text: string): { line: number; name: string; snippet: string }[] {
  const lines = stripComments(text).split("\n");
  const hits: { line: number; name: string; snippet: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, name } of FORBIDDEN) {
      if (pattern.test(lines[i])) {
        hits.push({ line: i + 1, name, snippet: lines[i].trim().slice(0, 160) });
        break; // one hit per line is enough for counting
      }
    }
  }
  return hits;
}

const REMEDY =
  "Literal frequency multiplier detected. Use toMonthlyAmount() from " +
  "shared/obligation-windows.ts instead of inline 4.33/4.345/2.17/30.44 or " +
  "52/12, 26/12, 365/12 fractions.";

describe("contract: no literal frequency-to-monthly multipliers", () => {
  const files = SCAN_DIRS.flatMap(d => walk(d));

  it("no file outside obligation-windows.ts (and pinned legacy files) contains a multiplier literal", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (rel === CANONICAL_FILE || rel in VIOLATION_BUDGETS) continue;
      for (const h of findMultiplierLines(readFileSync(file, "utf8"))) {
        violations.push(`  - ${rel}:${h.line} (${h.name})\n      ${h.snippet}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`${REMEDY}\n${violations.join("\n")}`);
    }
    expect(violations).toHaveLength(0);
  });

  it("budgeted legacy files do not grow new multiplier literals (budgets only go DOWN)", () => {
    const overBudget: string[] = [];
    for (const [rel, budget] of Object.entries(VIOLATION_BUDGETS)) {
      const abs = path.join(REPO_ROOT, rel);
      let text: string;
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      const hits = findMultiplierLines(text);
      if (hits.length > budget) {
        overBudget.push(
          `  - ${rel}: ${hits.length} multiplier literals found, budget is ${budget}.\n` +
          hits.map(h => `      :${h.line} (${h.name}) ${h.snippet}`).join("\n"),
        );
      }
    }
    if (overBudget.length > 0) {
      throw new Error(
        `${REMEDY}\nThese files exceeded their pinned legacy budget — a NEW literal ` +
        `was added. Use toMonthlyAmount(); never raise the budget.\n` + overBudget.join("\n"),
      );
    }
    expect(overBudget).toHaveLength(0);
  });
});
