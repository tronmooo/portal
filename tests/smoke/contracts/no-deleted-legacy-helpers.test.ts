/**
 * Build-time guard: deleted legacy helpers must stay deleted, and the
 * hardcoded Pacific-timezone literal must not spread.
 *
 * Part 1 — deleted helpers (P2.5). These were removed because they diverged
 * from the canonical orphan rule / multi-select filter state:
 *   - filterByProfile            (client/src/lib/filter-utils.ts)
 *   - passesFilter               (client/src/lib/profileFilter.ts)
 *   - getDashboardProfileFilter  (client/src/lib/profileFilter.ts)
 *   - setDashboardProfileFilter  (client/src/lib/profileFilter.ts)
 * Any reappearance (definition, import, or call) is a regression. Use
 * passesProfileFilter from shared/profile-filter.ts and
 * getProfileFilter().selectedIds / setFilterSelected() / setFilterEveryone()
 * instead. Note: \b boundaries mean `filterByProfileScope` (the canonical
 * routes.ts helper) does NOT match `filterByProfile`. Comments are stripped
 * before matching, so the tombstone comments left at the deletion sites pass.
 *
 * Part 2 — `"America/Los_Angeles"` string literals. The canonical default is
 * DEFAULT_TIMEZONE in shared/timezone.ts (which also exposes getUserToday()
 * etc.). Allowed:
 *   - shared/timezone.ts                 (defines DEFAULT_TIMEZONE + label map)
 *   - client/src/lib/queryClient.ts      (browser Intl fallback, exactly 1)
 * PRE-EXISTING VIOLATIONS (counted 2026-06-10) carry pinned budgets below —
 * budgets may only go DOWN (replace the literal with DEFAULT_TIMEZONE or the
 * user's stored timezone):
 *   - server/ai-engine.ts (34): lines 1219, 1232, 1464, 2993, 2994, 3721,
 *     4337, 4488, 4900, 4914, 4923, 5351, 5401, 5448, 5888, 5990, 6356, 6376,
 *     6514, 7096, 7169, 7175, 7177, 7342, 7426, 7439, 7442, 7443, 7490, 7533,
 *     7547, 7579, 7779, 9124
 *   - server/supabase-storage.ts (6): lines 257, 307, 389 (_timezone field
 *     default), 3508, 4331, 4590
 *   - server/routes.ts (1): line 1771
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIRS = ["client/src", "server", "shared"].map(d => path.join(REPO_ROOT, d));

const DELETED_HELPERS: { pattern: RegExp; name: string; useInstead: string }[] = [
  { pattern: /\bfilterByProfile\b/, name: "filterByProfile", useInstead: "passesProfileFilter from @shared/profile-filter" },
  { pattern: /\bpassesFilter\b/, name: "passesFilter", useInstead: "passesProfileFilter from @shared/profile-filter" },
  { pattern: /\bgetDashboardProfileFilter\b/, name: "getDashboardProfileFilter", useInstead: "getProfileFilter().selectedIds" },
  { pattern: /\bsetDashboardProfileFilter\b/, name: "setDashboardProfileFilter", useInstead: "setFilterSelected() / setFilterEveryone()" },
];

const TZ_LITERAL = /["'`]America\/Los_Angeles["'`]/;

/** Files allowed to contain the timezone literal in any (small) quantity. */
const TZ_CANONICAL = new Set<string>([
  "shared/timezone.ts", // DEFAULT_TIMEZONE definition + display-label map
]);

/** Pinned budgets — only go DOWN. See header for the per-line inventory. */
const TZ_BUDGETS: Record<string, number> = {
  "client/src/lib/queryClient.ts": 1, // BROWSER_TIMEZONE Intl fallback
  "server/ai-engine.ts": 34,
  "server/supabase-storage.ts": 6,
  "server/routes.ts": 1,
};

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

describe("contract: deleted legacy helpers stay deleted; timezone literal contained", () => {
  const files = SCAN_DIRS.flatMap(d => walk(d));

  it("no production code imports, calls, or re-defines the deleted P2.5 filter helpers", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const { pattern, name, useInstead } of DELETED_HELPERS) {
          if (pattern.test(lines[i])) {
            violations.push(
              `  - ${rel}:${i + 1} references deleted helper ${name}() — use ${useInstead}.\n` +
              `      ${lines[i].trim().slice(0, 160)}`,
            );
          }
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Deleted legacy filter helpers re-appeared. These were removed in P2.5 because ` +
        `they diverged from the canonical orphan rule.\n${violations.join("\n")}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  it("the 'America/Los_Angeles' literal only appears in canonical/budgeted files (budgets only go DOWN)", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (TZ_CANONICAL.has(rel)) continue;
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      const hits: { line: number; snippet: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (TZ_LITERAL.test(lines[i])) hits.push({ line: i + 1, snippet: lines[i].trim().slice(0, 160) });
      }
      const budget = TZ_BUDGETS[rel] ?? 0;
      if (hits.length > budget) {
        violations.push(
          `  - ${rel}: ${hits.length} hardcoded 'America/Los_Angeles' literal(s), budget is ${budget}.\n` +
          hits.map(h => `      :${h.line} ${h.snippet}`).join("\n"),
        );
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Hardcoded timezone literal detected. Import DEFAULT_TIMEZONE (or better, ` +
        `use getUserToday()/toLocalDateStr() with the user's timezone) from ` +
        `shared/timezone.ts instead. Never raise a budget — replace the literal.\n${violations.join("\n")}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
