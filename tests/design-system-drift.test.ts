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

  it("no card re-implements the bubble's gradient inline", () => {
    // This is the failure that made a whole redesign invisible: these cards
    // already had an accent gradient painted inline, so swapping their class to
    // `bubble` changed nothing the eye could see — inline style wins over the
    // stylesheet. Set --accent-hsl and let .bubble draw the surface.
    const INLINE_SURFACE = /background:\s*`linear-gradient\([^`]*hsl\(var\(--card\)\)/;
    const bad = offenders(INLINE_SURFACE);
    expect(bad, `Set \`--accent-hsl\` and let .bubble paint it:\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("the retired primitives stay retired", () => {
    // Nine components existed that no page imported, each a competing version
    // of something the app already had — AccentCard's flatter card recipe,
    // kit.tsx's bordered box, ModalShell's second popup header. Deleting them
    // is only durable if re-adding one fails: an unused component today is an
    // imported component next week, and that is how five card recipes happened.
    for (const gone of ["components/ui/accent-card.tsx", "components/ui/kit.tsx", "components/ui/modal-shell.tsx"]) {
      expect(fs.existsSync(path.resolve(ROOT, gone)), `${gone} was deleted — do not bring it back`)
        .toBe(false);
    }
    const bad = offenders(/from ["']@\/components\/ui\/(accent-card|kit|modal-shell)["']/);
    expect(bad, `Import from @/components/ui/kit-index instead:\n${bad.join("\n")}`).toEqual([]);
  });

  it("MetricCard is the one stat tile, built on the bubble + Medallion", () => {
    const src = fs.readFileSync(path.resolve(ROOT, "components/ui/metric-card.tsx"), "utf8");
    expect(src).toContain("bubble");
    expect(src).toContain("Medallion");
    expect(src).toContain("micro-label");
    expect(src).not.toContain("AccentCard");
  });

  it("never writes `bubble/60` — slash-opacity silently matches nothing", () => {
    // Tailwind's `/opacity` suffix only works on Tailwind utilities. On a
    // custom class it produces a class name no stylesheet defines, so the box
    // renders with no surface at all — eight of these were shipped, which is
    // part of why a finished redesign was invisible on several screens.
    const bad = offenders(/\bbubble\/\d+\b/);
    expect(bad, `Use plain \`bubble\` (tune the tint with --accent-hsl):\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("no .bubble overrides its own border inline", () => {
    // Same class of failure as the inline gradient above: .bubble draws its
    // border from --accent-hsl, and an inline borderColor wins over it.
    const bad: string[] = [];
    for (const f of FILES) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/className=(["'`])[^"'`]*\bbubble\b/.test(line) && /borderColor:/.test(line)) {
          bad.push(`${rel(f)}:${i + 1} — ${line.trim().slice(0, 110)}`);
        }
      });
    }
    expect(bad, `Set \`--accent-hsl\` instead of an inline borderColor:\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("EntityCard is the one grid-card shape, built on the bubble + Medallion", () => {
    // Assets, Liabilities and Documents each had their own near-identical card
    // recipe. If this component stops composing the shared pieces, they drift
    // apart again.
    const src = fs.readFileSync(path.resolve(ROOT, "components/ui/entity-card.tsx"), "utf8");
    expect(src).toContain("bubble");
    expect(src).toContain("Medallion");
    expect(src).toContain("micro-label");
    expect(src).toContain("metric-value");
  });

  it("the shared Card renders the bubble, so its 23 consumers inherit it", () => {
    const card = fs.readFileSync(path.resolve(ROOT, "components/ui/card.tsx"), "utf8");
    expect(card).toContain("bubble");
    // Interactivity is opt-in: a decorative container must not lift.
    expect(card).toContain("interactive");
  });
});

describe("one type scale", () => {
  it("has no text below 11px anywhere", () => {
    // 74 sites at 9px and 289 at 10px — below comfortable reading on a phone,
    // and the single loudest signal that a screen was built separately. The
    // Executive tab's floor is 11px (.micro-label); everything meets it.
    const bad = offenders(/text-\[(?:[1-9]|10)px\]/);
    expect(bad, `Nothing below 11px — use text-[11px] or .micro-label:\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("does not pair micro-label with a redundant size", () => {
    // .micro-label is already 11px; the sweep that created it left the old
    // size class alongside on every line it touched.
    const bad = offenders(/micro-label[^"'`]*text-\[\d+px\]|text-\[\d+px\][^"'`]*micro-label/);
    expect(bad, `Drop the size — .micro-label sets it:\n${bad.join("\n")}`).toEqual([]);
  });
});

describe("one money formatter", () => {
  it("formats money only through lib/format.ts", () => {
    // Eight local helpers existed: some rounded, some forced two decimals, one
    // abbreviated at a million, one was actually a privacy mask. The same
    // amount rendered differently depending on which screen you were on.
    const LOCAL = /\b(?:const|function)\s+(?:money2?|fmtMoney|formatCurrency|fmtCurrency)\s*[=(]/;
    const bad: string[] = [];
    for (const f of FILES) {
      if (f.endsWith(path.join("lib", "format.ts"))) continue;
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!LOCAL.test(line)) return;
        // Aliasing or wrapping a shared formatter is the point, not a violation.
        if (/format(Money|MoneyRound|MoneyCents|MoneyCompact)\b/.test(line)) return;
        bad.push(`${rel(f)}:${i + 1} — ${line.trim().slice(0, 110)}`);
      });
    }
    expect(bad, `Use formatMoney / formatMoneyRound / formatMoneyCents / formatMoneyCompact:\n${bad.join("\n")}`)
      .toEqual([]);
  });
});

describe("one loading treatment", () => {
  it("keeps the shimmer class inside ui/skeleton.tsx", () => {
    // Three treatments were live at once — <Skeleton>, bare animate-pulse, and
    // hand-written skeleton-shimmer divs — so the same wait looked different on
    // three screens. <Skeleton> and <BubbleSkeleton> are the only two shapes.
    //
    // Scoped to `skeleton-shimmer`, which unambiguously means "placeholder for
    // content". `animate-pulse` is deliberately NOT covered: it has honest
    // non-skeleton uses (a pulsing notification badge, "Loading chart data…"
    // text), and a guard that flags those would just get suppressed.
    const bad = offenders(/\bskeleton-shimmer\b/, (f) => f.endsWith(path.join("ui", "skeleton.tsx")));
    expect(bad, `Use <Skeleton> or <BubbleSkeleton>/<BubbleSkeletonGrid>:\n${bad.join("\n")}`)
      .toEqual([]);
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

describe("one icon per concept", () => {
  it("names every concept's icon in shared/icon-vocabulary.ts", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "shared/icon-vocabulary.ts"), "utf8");
    // The seven from the brief: heart = health, dollar = finance,
    // calendar = dates, folder = documents, bell = alerts, check = tasks,
    // flame = habits.
    for (const [concept, icon] of [
      ["health", "HeartPulse"], ["finance", "Wallet"], ["dates", "CalendarDays"],
      ["documents", "FileText"], ["alerts", "Bell"], ["tasks", "CheckCircle2"],
      ["habits", "Flame"],
    ]) {
      expect(src, `${concept} must be ${icon}`).toMatch(
        new RegExp(`${concept}:\\s*"${icon}"`));
    }
  });

  it("resolves every named icon to a real component", async () => {
    // A name in the vocabulary with no entry in the client map would silently
    // fall back to a generic glyph — the drift this file exists to prevent,
    // just one indirection further away.
    const { ICON_VOCABULARY, CONCEPT_ACCENT } = await import("@shared/icon-vocabulary");
    const map = fs.readFileSync(path.resolve(ROOT, "lib/icon-map.ts"), "utf8");
    for (const name of new Set(Object.values(ICON_VOCABULARY))) {
      expect(map, `${name} is missing from BY_NAME in icon-map.ts`)
        .toMatch(new RegExp(`\\b${name}\\b[,\\s]`));
    }
    // Every concept carries an accent, so colour and icon can't disagree.
    for (const concept of Object.keys(ICON_VOCABULARY)) {
      expect(CONCEPT_ACCENT[concept as keyof typeof CONCEPT_ACCENT],
        `${concept} has no accent`).toBeTruthy();
    }
  });
});
