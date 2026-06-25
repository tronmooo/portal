/**
 * Build-time guard: no inline reimplementations of unit resolution.
 *
 * The canonical "what unit does this tracker/field display in?" decision lives
 * in shared/tracker-units.ts (`resolveTrackerUnit`). Before it existed, units
 * were guessed independently in 4+ places — inferUnit + UNIT_BY_FIELD (client
 * trackers page), guessUnit (tracker-presentation), a DIFFERENT guessUnit
 * (ai-engine), an inline `f.type === "duration" ? "min"` (profile detail). Each
 * used slightly different rules, so the SAME tracker showed one unit in the
 * history tab, another on its card, another on the dashboard. That divergence —
 * not any single tracker — is the root cause of "the unit isn't the same every
 * time."
 *
 * This guard fails CI when a NEW unit-guessing ladder appears outside the
 * canonical resolver. The unmistakable signature of such a ladder is a function
 * that returns several hardcoded unit string literals (`return "lbs"` /
 * `return "qt"` / …). Declared field units (`{ unit: "qt" }` in a shape) and
 * single fallbacks (`tracker.unit || "mmHg"`) are NOT ladders and are allowed.
 *
 * Fix when this fails: delete the ladder and call resolveTrackerUnit; add any
 * new mapping to shared/tracker-units.ts (one table, one place).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SCAN_DIRS = ["client/src", "server", "shared"].map((d) => path.join(REPO_ROOT, d));

/**
 * Exempt files:
 *  - shared/tracker-units.ts  — IS the canonical resolver (the one allowed table)
 *  - server/tracker-normalize.ts — `canonUnit` maps a unit STRING to its
 *    canonical spelling (unit→unit for conversion math), not a NAME→unit guess.
 */
const EXEMPT_FILES = new Set<string>([
  "shared/tracker-units.ts",
  "server/tracker-normalize.ts",
]);

// The closed set of physical-unit string literals a guesser ladder emits.
const UNIT_LITERAL =
  /\breturn\s+"(qt|lbs?|oz|mi|km|mmHg|bpm|steps|kcal|cal|mg\/dL|PSI|mpg|hr|min|cups|ml|reps|sets|pages|min\/mi|mph|ft|yd|gal|kWh|%)"/g;

// ≥ this many unit-literal returns in one file = a guessing ladder.
const LADDER_THRESHOLD = 3;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (["node_modules", "dist", ".next", "build", "tests"].includes(entry)) continue;
      walk(p, out);
    } else if (s.isFile() && (p.endsWith(".ts") || p.endsWith(".tsx"))) {
      out.push(p);
    }
  }
  return out;
}

const REMEDY =
  "Inline unit-guessing ladder detected. There must be exactly ONE place that " +
  "decides a tracker/field unit: resolveTrackerUnit in shared/tracker-units.ts. " +
  "Delete the `return \"<unit>\"` ladder and call resolveTrackerUnit instead; " +
  "add any new field/name → unit mapping to shared/tracker-units.ts.";

describe("contract: no inline unit-guessing", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d));

  it("only shared/tracker-units.ts may contain a unit-literal ladder", () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (EXEMPT_FILES.has(rel)) continue;
      const matches = readFileSync(file, "utf8").match(UNIT_LITERAL) || [];
      if (matches.length >= LADDER_THRESHOLD) {
        violations.push(`  - ${rel}: ${matches.length} hardcoded unit-literal returns (${[...new Set(matches)].join(", ")})`);
      }
    }
    if (violations.length > 0) {
      throw new Error(`${REMEDY}\n${violations.join("\n")}`);
    }
    expect(violations).toHaveLength(0);
  });
});
