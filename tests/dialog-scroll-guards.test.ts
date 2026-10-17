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
});
