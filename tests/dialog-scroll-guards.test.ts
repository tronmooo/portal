// A popup must always be scrollable end to end. 2026-10-17 owner report
// (iPhone): the tracker detail popup's History list would not scroll back up.
// Causes fixed: a `sticky` tab bar inside a scroller whose only child was
// `h-full`, `vh` heights that exceed the visible iOS viewport, and a base
// DialogContent with no scroll fallback of its own.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "client", "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(p) ? [p] : [];
  });
}

describe("popups stay scrollable", () => {
  it("the base DialogContent scrolls and is bounded by the dynamic viewport", () => {
    const src = readFileSync(join(ROOT, "components/ui/dialog.tsx"), "utf8");
    expect(src).toMatch(/max-h-\[calc\(100dvh-[\d.]+rem\)\]/);
    expect(src).toContain("overflow-y-auto");
    expect(src).toContain("overscroll-contain");
  });

  it("no Dialog/Sheet/Drawer content is sized in vh (use dvh; iOS vh overshoots the visible area)", () => {
    const offenders: string[] = [];
    for (const f of walk(ROOT)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/(DialogContent|SheetContent|DrawerContent)/.test(line) && /h-\[\d+vh\]/.test(line)) {
          offenders.push(`${f.replace(ROOT, "client/src")}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the tracker detail popup has exactly one flex-bounded scroller and no sticky tab bar", () => {
    const src = readFileSync(join(ROOT, "pages/trackers.tsx"), "utf8");
    const start = src.indexOf('data-testid="tracker-detail-dialog"');
    const end = src.indexOf("Add Entry sub-dialog", start);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/sticky top-0/);
    expect(block.match(/overflow-y-auto/g)?.length).toBe(1);
    expect(block).toMatch(/min-h-0 overflow-y-auto overscroll-contain/);
  });

  // 2026-10-20 owner report (iPhone), after the redesign: "it won't let me
  // scroll up and down in each of the trackers". Radix's scroll lock
  // (react-remove-scroll) cancels a touchmove whose first sample is more
  // sideways than down when nothing scrolls sideways — and iOS then drops the
  // whole swipe. Fixed in lib/touch-scroll.ts; these pin the pieces.
  describe("tracker popup on iOS", () => {
    const src = readFileSync(join(ROOT, "pages/trackers.tsx"), "utf8");
    const start = src.indexOf('data-testid="tracker-detail-dialog"');
    const block = src.slice(src.lastIndexOf("<DialogContent", start), src.indexOf("Add Entry sub-dialog", start));

    it("its scroller keeps touch swipes away from the dialog's scroll lock", () => {
      expect(block).toMatch(/<div ref=\{scrollRef\}[^>]*data-testid="tracker-detail-scroll"/);
      expect(src).toContain("const scrollRef = useNativeTouchScroll<HTMLDivElement>()");
      const helper = readFileSync(join(ROOT, "lib/touch-scroll.ts"), "utf8");
      expect(helper).toMatch(/addEventListener\("touchmove", stop, \{ passive: true \}\)/);
    });

    it("does not restrict the scroller's touch-action", () => {
      expect(block).not.toMatch(/touch-pan-y/);
    });

    it("is sized by .td-dialog with a vh fallback and safe-area insets", () => {
      expect(block).toMatch(/className="[^"]*\btd-dialog\b/);
      expect(block).not.toMatch(/\bh-\[\d+dvh\]/);
      const css = readFileSync(join(ROOT, "index.css"), "utf8");
      const rule = css.slice(css.indexOf(".td-dialog {"), css.indexOf("}", css.indexOf(".td-dialog {")));
      expect(rule).toMatch(/height: calc\(100vh/);
      expect(rule).toMatch(/100dvh - env\(safe-area-inset-top/);
    });

    it("every sideways strip inside the popup also hides vertical overflow", () => {
      // overflow-x:auto computes overflow-y:auto too; a strip a pixel taller
      // than its box then grabs vertical swipes on iOS.
      const files = [
        ...readdirSync(join(ROOT, "components/tracker-detail")).map((f) => join(ROOT, "components/tracker-detail", f)),
      ];
      const offenders: string[] = [];
      const check = (text: string, name: string) => text.split("\n").forEach((line, i) => {
        if (/overflow-x-auto/.test(line) && !/overflow-y-hidden/.test(line)) offenders.push(`${name}:${i + 1}`);
      });
      check(block, "trackers.tsx(popup)");
      const history = src.slice(src.indexOf("function HistoryTabContent"), src.indexOf("function GoalsTabContent"));
      check(history, "trackers.tsx(HistoryTabContent)");
      for (const f of files) check(readFileSync(f, "utf8"), f);
      expect(offenders).toEqual([]);
    });
  });

  // Every hub popup (Executive, Finance, Wellness …) renders through
  // BubbleModal; it carries the same iOS fix as the tracker popup.
  describe("BubbleModal on iOS", () => {
    const src = readFileSync(join(ROOT, "components/ui/bubble-modal.tsx"), "utf8");
    it("its body scroller keeps touch swipes away from the dialog's scroll lock", () => {
      expect(src).toContain("const scrollRef = useNativeTouchScroll<HTMLDivElement>()");
      expect(src).toMatch(/<div ref=\{scrollRef\} className="bm-scroll[^"]*overflow-y-auto overscroll-contain/);
    });
    it("is sized by .bm-dialog (vh fallback, dvh, safe areas), never a bare vh class", () => {
      expect(src).toMatch(/className=\{`td-scope bm-dialog /);
      expect(src).not.toMatch(/max-h-\[\d+vh\]/);
      const css = readFileSync(join(ROOT, "index.css"), "utf8");
      const rule = css.slice(css.indexOf(".bm-dialog {"), css.indexOf("}", css.indexOf(".bm-dialog {")));
      expect(rule).toMatch(/max-height: calc\(100vh/);
      expect(rule).toMatch(/100dvh - env\(safe-area-inset-top/);
    });
  });
});
