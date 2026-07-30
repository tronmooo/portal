// tests/design-system-drift.test.ts
//
// The hub tabs drifted into looking like separate products because each one
// grew its own version of the same few things. Unifying them once doesn't hold
// unless something stops the next edit from reintroducing a variant, so these
// are drift guards in the same spirit as tests/typography-hygiene.test.ts and
// the @shared/now-rank import guard in tests/due-label.test.ts.
//
// Each rule names its replacement, so a failure tells you what to do.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "client/src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const FILES = walk(ROOT);
const rel = (f: string) => path.relative(path.resolve(__dirname, ".."), f);

/** Lines matching `re`, ignoring comments, as "path:line — snippet". */
function offenders(re: RegExp, skip?: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of FILES) {
    if (skip?.(f)) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (re.test(line)) out.push(`${rel(f)}:${i + 1} — ${line.trim().slice(0, 110)}`);
    });
  }
  return out;
}

describe("one label treatment, not six", () => {
  // 10px vs 11px, semibold vs normal, tracking-wide vs tracking-wider — there
  // were 138 of these across 30 files in five combinations.
  const VARIANT = /text-\[1[01]px\][^"'`]*uppercase[^"'`]*tracking-(wide|wider)/;

  it("uses .micro-label instead of a hand-rolled uppercase label", () => {
    const bad = offenders(VARIANT);
    expect(bad, `Use the shared \`micro-label\` class (index.css) instead:\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("micro-label is defined once, in index.css", () => {
    const css = fs.readFileSync(path.resolve(ROOT, "index.css"), "utf8");
    expect(css).toMatch(/\.micro-label\s*\{/);
  });
});

describe("one card surface", () => {
  // A flat bordered box next to a bubble is the single most visible way two
  // tabs stop looking like the same app.
  const FLAT_CARD = /rounded-(lg|xl|2xl)[^"'`]*\bborder\b[^"'`]*\bbg-card\b|\bbg-card\b[^"'`]*\bborder\b[^"'`]*rounded-(lg|xl|2xl)/;

  it("uses .bubble or <Card> rather than a hand-rolled bordered box", () => {
    const bad = offenders(FLAT_CARD, (f) => f.endsWith(path.join("ui", "card.tsx")));
    expect(bad, `Use the \`bubble\` class or the shared <Card>:\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("the bubble surface is defined once, in index.css", () => {
    const css = fs.readFileSync(path.resolve(ROOT, "index.css"), "utf8");
    expect(css).toMatch(/\.bubble\s*\{/);
    expect(css).toMatch(/\.bubble-interactive:active/);
  });

  it("the shared Card renders the bubble, so its 23 consumers inherit it", () => {
    const card = fs.readFileSync(path.resolve(ROOT, "components/ui/card.tsx"), "utf8");
    expect(card).toContain("bubble");
    // Interactivity is opt-in: a decorative container must not lift.
    expect(card).toContain("interactive");
  });
});

describe("interaction states are shared", () => {
  it("defines .pressable once, with a focus-VISIBLE ring", () => {
    const css = fs.readFileSync(path.resolve(ROOT, "index.css"), "utf8");
    expect(css).toMatch(/\.pressable\s*\{/);
    // focus (not focus-visible) leaves a ring behind after a mouse press and
    // paints one on every autofocused dialog close button.
    expect(css).toMatch(/\.pressable:focus-visible/);
  });

  it("modals share one panel treatment", () => {
    const css = fs.readFileSync(path.resolve(ROOT, "index.css"), "utf8");
    expect(css).toMatch(/\.surface-panel\s*\{/);
    for (const f of ["components/ui/dialog.tsx", "components/ui/popover.tsx"]) {
      expect(fs.readFileSync(path.resolve(ROOT, f), "utf8"), f).toContain("surface-panel");
    }
  });

  it("does not reintroduce focus: rings on the dialog close button", () => {
    const dlg = fs.readFileSync(path.resolve(ROOT, "components/ui/dialog.tsx"), "utf8");
    expect(dlg).not.toMatch(/focus:ring-2/);
    expect(dlg).toMatch(/focus-visible:ring-2/);
  });
});

describe("motion stays accessible", () => {
  it("collapses every animation under prefers-reduced-motion", () => {
    const css = fs.readFileSync(path.resolve(ROOT, "index.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("animates only transform/opacity properties in the bubble keyframes", () => {
    const css = fs.readFileSync(path.resolve(ROOT, "index.css"), "utf8");
    const block = css.slice(css.indexOf("@keyframes bubble-in"), css.indexOf("@keyframes bubble-in") + 260);
    // Animating layout properties (width/height/top/left) drops the animation
    // off the compositor and janks on the iOS WebView the app ships in.
    expect(block).not.toMatch(/\b(width|height|top|left|margin):/);
  });
});
