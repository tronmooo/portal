// Typography-hygiene guard — locks in "one font family for text" (the design
// unification decision, 2026-07). Section labels/captions must use the sans
// SectionHeader convention, never JetBrains-mono. `font-mono` on an uppercase
// LABEL is the exact "different fonts than the rest" the user reported.
//
// Numbers may still use tabular-nums (a figure style, not a font family), so
// this only flags `font-mono` co-located with `uppercase` (labels/badges) in
// the app's presentational surfaces. If a genuine reason to use a mono label
// ever appears, add the file to ALLOW with a comment.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOTS = ["client/src/pages", "client/src/components"];
const ALLOW = new Set<string>([
  // (empty) — no presentational surface is allowed a mono uppercase label.
]);

function walk(dir: string): string[] {
  const abs = path.resolve(__dirname, "..", dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// A mono label = `font-mono` and `uppercase` within the same className string
// (order-independent). className strings don't contain unescaped double quotes,
// so a quote-bounded scan is a good approximation.
const MONO_LABEL = /(font-mono[^"'`]*uppercase|uppercase[^"'`]*font-mono)/;

describe("typography hygiene (one font family for text)", () => {
  const files = ROOTS.flatMap(walk);

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no presentational file uses font-mono on an uppercase label", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOW.has(f)) continue;
      const src = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
      // Check per className-ish token to avoid cross-attribute false positives.
      for (const m of src.match(/class(Name)?=("[^"]*"|'[^']*'|`[^`]*`)/g) || []) {
        if (MONO_LABEL.test(m)) { offenders.push(`${f}: ${m.slice(0, 80)}`); break; }
      }
    }
    expect(offenders, `mono uppercase labels found:\n${offenders.join("\n")}`).toEqual([]);
  });
});
