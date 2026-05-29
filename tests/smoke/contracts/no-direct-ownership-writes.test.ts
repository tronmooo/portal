/**
 * Stage 3 + 4 — build-time guard for the ownership single-writer/reader.
 *
 * Premise: `linked_profiles` (JSONB owner array on entity rows) and the
 * `profile_<type>` junction tables must only be written by the centralized
 * writer (`server/ownership-writer.ts` and its delegates), and must only
 * be read inside the storage layer that exposes them through the `isInScope`
 * filter. Any other code path that touches them risks bringing back the
 * three-systems disagreement the Stage 0-6 plan is removing.
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
  // The new single writer (Stage 1):
  "server/ownership-writer.ts",
  // The pre-existing storage layer. These functions ARE the dual-write
  // implementations \u2014 they will be migrated to delegate to the new writer
  // in a follow-up. Stage 4 prevents NEW code paths from being added, not
  // the existing ones.
  "server/supabase-storage.ts",
  // Legacy storage used in dev / tests:
  "server/storage.ts",
  // Memory storage for tests \u2014 doesn't touch the real DB:
  "server/mem-storage.ts",
]);

const FORBIDDEN_PATTERNS: { pattern: RegExp; name: string }[] = [
  // Any update / insert that names `linked_profiles` as a target column.
  { pattern: /\.update\s*\(\s*\{[^}]*linked_profiles\s*:/, name: "update({ linked_profiles: ... })" },
  { pattern: /\.upsert\s*\(\s*\{[^}]*linked_profiles\s*:/, name: "upsert({ linked_profiles: ... })" },
  { pattern: /\.insert\s*\(\s*\{[^}]*linked_profiles\s*:/, name: "insert({ linked_profiles: ... })" },
  // Any reference to a profile_<x> junction table — read or write. Stage 3
  //   says list endpoints filter through `isInScope`, never by reading the
  //   junction directly. Stage 4 says writes go through `setOwners`. Both
  //   collapse to: only the storage layer mentions these tables.
  { pattern: /\.from\s*\(\s*["'`]profile_(expenses|trackers|tasks|events|obligations|documents|artifacts)["'`]\s*\)/, name: "reference to profile_<type> junction" },
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

describe("contract: ownership single-writer / single-reader guard (Stages 3+4)", () => {
  it("no file outside the allow-list directly writes linked_profiles or reads/writes profile_<type> junctions", () => {
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
});
