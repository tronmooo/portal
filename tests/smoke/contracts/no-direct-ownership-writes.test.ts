/**
 * Stage 3 + 4 — build-time guard for the ownership single-writer.
 *
 * FIX 4 Phase 2 (2026-05-28): the deprecated `profile_<type>` junction tables
 * have been DROPPED. The only ownership representation is `linked_profiles`
 * (JSONB owner array on entity rows), written exclusively by
 * `server/ownership-writer.ts` and its delegates inside the storage layer.
 * Fractional ownership for assets/liabilities still uses
 * `asset_party_links` / `liability_profile_links` — untouched by this guard.
 *
 * This test runs as part of the pre-push contracts gate, so a violating
 * commit fails before it can ship. To add a new legitimate caller, add the
 * file path to ALLOWED_WRITERS below and explain why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const SHARED_DIR = path.join(REPO_ROOT, "shared");

/**
 * Allow-list. These files are the legitimate writers of `linked_profiles`
 * or `profile_*` junction rows. Everything else is a regression.
 */
const ALLOWED_WRITERS = new Set<string>([
  // The single ownership writer:
  "server/ownership-writer.ts",
  // Storage layer — delegates writes to setOwners but still owns the row insert.
  "server/supabase-storage.ts",
  // Legacy storage used in dev / tests:
  "server/storage.ts",
  // Memory storage for tests — doesn't touch the real DB:
  "server/mem-storage.ts",
]);

const FORBIDDEN_PATTERNS: { pattern: RegExp; name: string }[] = [
  // Any update / insert that names `linked_profiles` as a target column outside
  // the single writer must be routed through setOwners() instead.
  { pattern: /\.update\s*\(\s*\{[^}]*linked_profiles\s*:/, name: "update({ linked_profiles: ... })" },
  { pattern: /\.upsert\s*\(\s*\{[^}]*linked_profiles\s*:/, name: "upsert({ linked_profiles: ... })" },
  { pattern: /\.insert\s*\(\s*\{[^}]*linked_profiles\s*:/, name: "insert({ linked_profiles: ... })" },
  // FIX 4 Phase 2: the profile_<type> junction tables have been dropped.
  // Any new reference to them is a regression (the table no longer exists),
  // so this pattern stays as a tripwire even though it should now never match.
  { pattern: /\.from\s*\(\s*["'`]profile_(expenses|trackers|tasks|events|obligations|documents|artifacts)["'`]\s*\)/, name: "reference to dropped profile_<type> junction (FIX 4 Phase 2)" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      // Skip node_modules and build outputs if any.
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "tests") continue;
      walk(p, out);
    } else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".js"))) {
      out.push(p);
    }
  }
  return out;
}

describe("contract: ownership single-writer guard (Stages 3+4 / FIX 4 Phase 2)", () => {
  it("no file outside the allow-list directly writes linked_profiles or references the dropped profile_<type> junctions", () => {
    const files = [...walk(SERVER_DIR), ...walk(SHARED_DIR)];
    const violations: { file: string; pattern: string; snippet: string }[] = [];

    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (ALLOWED_WRITERS.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const { pattern, name } of FORBIDDEN_PATTERNS) {
        const m = pattern.exec(text);
        if (m) {
          // Trim the matched snippet for the error message.
          const idx = m.index;
          const snippet = text.slice(Math.max(0, idx - 40), idx + Math.min(160, m[0].length + 40));
          violations.push({ file: rel, pattern: name, snippet: snippet.replace(/\s+/g, " ") });
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(v => `  - ${v.file}: ${v.pattern}\n      ${v.snippet}`)
        .join("\n");
      throw new Error(
        `Ownership single-writer violations detected. ` +
        `Route writes through server/ownership-writer.ts instead, or add the file to ALLOWED_WRITERS with a comment explaining why.\n${msg}`,
      );
    }
    expect(violations).toHaveLength(0);
  });

  // 2026-06-10 ratchet: ALLOWED_WRITERS blanket-exempts server/supabase-storage.ts,
  // which means a NEW raw `linked_profiles:` write added there would silently
  // pass the pattern check above. Pin the file to its CURRENT count of
  // `linked_profiles:` write-shaped occurrences instead. This budget must only
  // ever go DOWN — new ownership writes must go through setOwners() /
  // applyOwnershipPatch() in server/ownership-writer.ts, and migrating an
  // existing raw write there should be followed by lowering the number.
  //
  // Current inventory (24): ten unlink-on-profile-delete .update() calls
  // (expenses/tasks/habits/obligations/events/documents/artifacts/goals/
  // incomes/journal_entries around lines 1305-1425), and fourteen row
  // insert/soft-delete payloads that seed or clear the column (lines ~1985,
  // 2210, 2292, 2343, 2386, 2424, 2500, 3066, 3170, 3280, 3433, 3658, 3790,
  // 3969).
  //
  // server/storage.ts (MemStorage reference impl) needs no budget: it stores
  // camelCase `linkedProfiles` on in-memory objects and contains zero
  // `linked_profiles:` column writes today — so it is already fully covered
  // by the zero-tolerance pattern scan if it ever grows one (it stays in
  // ALLOWED_WRITERS only for the dropped-junction tripwire).
  const SUPABASE_STORAGE_LINKED_PROFILES_BUDGET = 24;

  it(`server/supabase-storage.ts has at most ${SUPABASE_STORAGE_LINKED_PROFILES_BUDGET} raw linked_profiles writes (budget only goes DOWN)`, () => {
    const text = readFileSync(path.join(SERVER_DIR, "supabase-storage.ts"), "utf8");
    const offending: string[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      // Skip pure comment lines, mirroring the style of the scan above.
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (/\blinked_profiles\s*:/.test(lines[i])) {
        offending.push(`      :${i + 1} ${trimmed.slice(0, 140)}`);
      }
    }
    if (offending.length > SUPABASE_STORAGE_LINKED_PROFILES_BUDGET) {
      throw new Error(
        `server/supabase-storage.ts now has ${offending.length} \`linked_profiles:\` occurrences ` +
        `(budget ${SUPABASE_STORAGE_LINKED_PROFILES_BUDGET}). A new raw ownership write was added — ` +
        `route it through setOwners()/applyOwnershipPatch() in server/ownership-writer.ts instead. ` +
        `Never raise this budget; lower it when migrating writes.\n${offending.join("\n")}`,
      );
    }
    expect(offending.length).toBeLessThanOrEqual(SUPABASE_STORAGE_LINKED_PROFILES_BUDGET);
  });
});
