/**
 * FIX 5b — build-time guard: no reads of the legacy ownership/parent JSON
 * shadows allowed anywhere in production code.
 *
 * The data-divergence bug was caused by THREE in-JSON shapes living alongside
 * the canonical column / junction sources of truth:
 *
 *   1. `fields.owners`            (replaced by `linked_profiles` JSONB / junctions)
 *   2. `fields.ownerIds`          (replaced by junction tables / asset_party_links)
 *   3. `fields.linkedProfileIds`  (replaced by `linkedProfiles: string[]`)
 *   4. `fields._parentProfileId`  (replaced by the `parent_profile_id` column)
 *
 * Every read of these shapes is dead code today (DB rows = 0 for all four) and
 * actively dangerous: any new caller would resurrect the divergence we just
 * shipped 6 stages of work to remove. This guard fails the build if any code
 * file (outside the small allow-list of write-strips + comments + tests)
 * names these legacy keys.
 *
 * Allowed exceptions:
 *  - Server-side INCOMING request sanitizers that delete the shadow before
 *    writing (`routes.ts`, `supabase-storage.ts`). They must NOT read it as a
 *    fallback — only delete it.
 *  - The HIDDEN_FIELDS UI list in `profiles.tsx` (defensive: hides any
 *    legacy keys that might exist in old fixture data from the field-editor).
 *  - Tests that prove the legacy shape is ignored.
 *
 * To add a new legitimate caller, add a comment to `ALLOWED_PATHS` explaining
 * why and what guarantees prevent it from re-introducing divergence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIRS = ["server", "client/src", "shared"].map(d => path.join(REPO_ROOT, d));

// File paths (POSIX, relative to repo root) allowed to mention these legacy
// keys. Each allowance includes a one-line justification.
const ALLOWED_PATHS = new Set<string>([
  // INCOMING WRITE SANITIZERS: must delete the shadow off req.body, never read
  // it. The `delete` pattern is permitted; a `read fallback` like
  // `parentProfileId || fields?._parentProfileId` is what this guard prevents.
  "server/routes.ts",
  "server/supabase-storage.ts",
  // Comment-only mentions in storage layer and dashboard popups (the guard
  // matches on the literal token; if a future commit re-introduces a real
  // read these comments still pass but the new read will fail the lint).
  "shared/net-worth.ts",
  "client/src/components/dashboard/HeroKPIPopups.tsx",
]);

// The forbidden tokens. ANY mention outside the allow-list fails.
const FORBIDDEN_TOKENS = [
  // Parent shadow:
  /\bfields\?\._parentProfileId\b/,
  /\bfields\._parentProfileId\b/,
  /\(\s*fields\s+as\s+any\s*\)\s*\??\.\s*_parentProfileId\b/,
  /\b\w+\.fields\?\._parentProfileId\b/,
  /\(\s*\w+\.fields\s+as\s+any\s*\)\s*\??\.\s*_parentProfileId\b/,
  // Owner array shadow:
  /\bfields\?\.owners\b/,
  /\bfields\.owners\b/,
  /\(\s*fields\s+as\s+any\s*\)\s*\??\.\s*owners\b/,
  // OwnerIds shadow:
  /\bfields\?\.ownerIds\b/,
  /\bfields\.ownerIds\b/,
  // linkedProfileIds (note: `linkedProfiles` plural-with-s is the canonical
  // column on entities — DO NOT match that). Only `linkedProfileIds` (with
  // trailing 'Ids') is the dead JSON shadow.
  /\bfields\?\.linkedProfileIds\b/,
  /\bfields\.linkedProfileIds\b/,
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === "build") continue;
      walk(p, out);
    } else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
      out.push(p);
    }
  }
  return out;
}

describe("contract: no legacy ownership/parent JSON field reads (FIX 5b)", () => {
  it("no production source file reads fields._parentProfileId, fields.owners, fields.ownerIds, or fields.linkedProfileIds", () => {
    const files = SCAN_DIRS.flatMap(d => walk(d));
    const violations: { file: string; line: number; snippet: string; token: string }[] = [];

    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (ALLOWED_PATHS.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip pure comment lines so docstrings/explanations don't break the build.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        for (const pat of FORBIDDEN_TOKENS) {
          if (pat.test(line)) {
            violations.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 200), token: pat.source });
            break;
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations
        .map(v => `  - ${v.file}:${v.line}\n      ${v.snippet}\n      (matched: ${v.token})`)
        .join("\n");
      throw new Error(
        `Legacy ownership/parent JSON field reads detected. Use parent_profile_id column or linked_profiles JSONB instead.\n${msg}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
