/**
 * Build-time guard: no inline reimplementations of the profile filter.
 *
 * The canonical "does this entity pass the active profile filter?" decision
 * lives in shared/profile-filter.ts (`passesProfileFilter`) which delegates to
 * shared/scope.ts (`isInScope`). The architectural audit found four+ divergent
 * inline copies (different orphan semantics) which made finance, calendar and
 * dashboard disagree on the same filter. Those canonical modules now exist —
 * this guard fails CI when someone writes a NEW inline
 * `linkedProfiles.some(id => selection.includes(id))`-style check instead of
 * calling passesProfileFilter / isInScope (server list endpoints should use
 * the filterByProfileScope helper in server/routes.ts).
 *
 * Detection (comment-stripped source):
 *   A) `.some(` within 80 chars after a `linkedProfiles`/`linked_profiles`
 *      token on the same statement, OR
 *   B) `.some((pid|id|p) => <something>Ids/linked/lp/arr.includes|has(...))`
 *      with a `linkedProfiles`/`linked_profiles` mention within ±8 lines.
 *
 * PRE-EXISTING VIOLATIONS (found 2026-06-10, reported — do NOT add to them):
 * each file below carries a pinned occurrence BUDGET. The budget may only
 * ever go DOWN (migrate the site to passesProfileFilter, then lower the
 * number). A new inline filter in these files pushes the count over budget
 * and fails this test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIRS = ["client/src", "server", "shared"].map(d => path.join(REPO_ROOT, d));

/**
 * Canonical implementations — fully exempt. These ARE the filter, so they may
 * legitimately contain set-intersection code in any quantity.
 */
const CANONICAL_FILES = new Set<string>([
  "shared/profile-filter.ts",
  "shared/scope.ts",
  "server/ownership-writer.ts",
]);

/**
 * Pre-existing violations, pinned per file. Counted on 2026-06-10.
 * BUDGETS MAY ONLY GO DOWN. Every occurrence is documented below so a future
 * migration can find them:
 *
 * client/src/pages/habits.tsx (1)
 *   :414  client-side habit filter (NB: divergent semantics! orphans show for
 *         EVERYONE here, not just self — `lp.length === 0 || ...`)
 * client/src/pages/trackers.tsx (3)
 *   :3999 document profile filter, :4097 tracker profile filter,
 *   :4588 "All" section document scoping
 * server/ai-engine.ts (5)
 *   :1138 doc dedup overlap check, :4541 task dedup overlap check,
 *   :7740 doc search scoping, :8583 AI doc picker scoping,
 *   :8795 doc relevance boost
 * server/routes.ts (14)
 *   :1704 tracker-by-profile resolution, :3291 pet-tracker check,
 *   :3488+:3491 tasks endpoint inline orphan rule, :3765 + :3831 loan
 *   schedule filters, :4495 obligation occurrences, :4769+:4773 journal
 *   inline orphan rule, :5218 notifications, :5271 search results,
 *   :5981 AI context scoping, :6115 AI snapshot scoping, :6217 goals
 *   inline orphan rule
 * server/storage.ts (2)
 *   :1636, :1767  MemStorage getStats/alerts matchesFilter closures
 * server/supabase-storage.ts (1)
 *   :2570  calendar matchesProfile closure
 */
const VIOLATION_BUDGETS: Record<string, number> = {
  "client/src/pages/habits.tsx": 1,
  "client/src/pages/trackers.tsx": 3,
  "server/ai-engine.ts": 5,
  "server/routes.ts": 14,
  "server/storage.ts": 2,
  "server/supabase-storage.ts": 1,
};

// A: `.some(` directly chained off a linkedProfiles expression.
const DIRECT = /\b(?:linkedProfiles|linked_profiles)\b[^;\n]{0,80}\.some\s*\(/;
// B: `.some((pid|id|p) => ...<ids-ish>.includes|has(...))` — the classic
// inline selection-intersection shape...
const INDIRECT = /\.some\s*\(\s*\(?\s*(?:pid|id|p)\b[^)]*?\)?\s*=>\s*[^;\n]*?\b(?:[\w$]*[iI]ds|linked|lp|linkedIds|arr)\s*!?\.\s*(?:includes|has)\s*\(/;
// ...but only when linkedProfiles is mentioned nearby (avoids flagging
// keyword/tag matching like `keywords.some(k => name.includes(k))`).
const NEARBY = /\b(?:linkedProfiles|linked_profiles)\b/;
const PROXIMITY_LINES = 8;

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
    // Inside a string/template literal:
    if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    out += c; i++;
  }
  return out;
}

function findInlineFilterLines(text: string): { line: number; snippet: string }[] {
  const lines = stripComments(text).split("\n");
  const hits: { line: number; snippet: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let hit = DIRECT.test(line);
    if (!hit && INDIRECT.test(line)) {
      const lo = Math.max(0, i - PROXIMITY_LINES);
      const hi = Math.min(lines.length, i + PROXIMITY_LINES + 1);
      hit = lines.slice(lo, hi).some(l => NEARBY.test(l));
    }
    if (hit) hits.push({ line: i + 1, snippet: line.trim().slice(0, 160) });
  }
  return hits;
}

const REMEDY =
  "Inline profile-filter reimplementation detected. Use passesProfileFilter " +
  "from shared/profile-filter.ts (server list endpoints: filterByProfileScope " +
  "in server/routes.ts; raw candidate sets: isInScope in shared/scope.ts) " +
  "instead of hand-rolled `.some(id => selection.includes(id))` checks.";

describe("contract: no inline profile-filter reimplementations", () => {
  const files = SCAN_DIRS.flatMap(d => walk(d));

  it("no file outside the allow-list inlines a linkedProfiles selection-intersection", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (CANONICAL_FILES.has(rel) || rel in VIOLATION_BUDGETS) continue;
      for (const h of findInlineFilterLines(readFileSync(file, "utf8"))) {
        violations.push(`  - ${rel}:${h.line}\n      ${h.snippet}`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`${REMEDY}\n${violations.join("\n")}`);
    }
    expect(violations).toHaveLength(0);
  });

  it("budgeted legacy files do not grow new inline filters (budgets only go DOWN)", () => {
    const overBudget: string[] = [];
    for (const [rel, budget] of Object.entries(VIOLATION_BUDGETS)) {
      const abs = path.join(REPO_ROOT, rel);
      let text: string;
      try { text = readFileSync(abs, "utf8"); } catch { continue; } // file deleted — budget moot
      const hits = findInlineFilterLines(text);
      if (hits.length > budget) {
        overBudget.push(
          `  - ${rel}: ${hits.length} inline filters found, budget is ${budget}.\n` +
          hits.map(h => `      :${h.line} ${h.snippet}`).join("\n"),
        );
      }
    }
    if (overBudget.length > 0) {
      throw new Error(
        `${REMEDY}\nThese files exceeded their pinned legacy budget — a NEW inline ` +
        `filter was added (or moved). Migrate it to passesProfileFilter; never raise the budget.\n` +
        overBudget.join("\n"),
      );
    }
    expect(overBudget).toHaveLength(0);
  });
});
