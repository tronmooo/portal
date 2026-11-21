// iPhone (2026-11-21): after scrolling a page to the bottom it would not scroll
// back up. body and #root had `overflow-x: hidden`, which makes them vertical
// scroll containers too, and the page scroller's swipes chained on to them.
// See the comment beside these rules in client/src/index.css.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const css = readFileSync(path.join(__dirname, "../client/src/index.css"), "utf8");
const block = (selector: RegExp) => {
  const m = css.match(new RegExp(selector.source + String.raw`\s*\{([^}]*)\}`));
  if (!m) throw new Error(`no CSS block for ${selector}`);
  return m[1];
};

describe("iOS scroll chaining", () => {
  it("body and #root clip sideways overflow without becoming scroll containers", () => {
    expect(css).toMatch(/@supports \(overflow-x: clip\)\s*\{\s*body, #root\s*\{\s*overflow-x: clip;/);
  });
  it("the root never rubber-bands vertically", () => {
    expect(block(/\nhtml, body/)).toMatch(/overscroll-behavior-y:\s*none/);
  });
  it("only a page's outermost scroller contains its swipes", () => {
    expect(block(/#main-content > \.overflow-y-auto,\s*#main-content > \* > \.overflow-y-auto/)).toMatch(/overscroll-behavior-y:\s*contain/);
    // Not every scroller: nested card scrollers must keep chaining to the page.
    expect(css).not.toMatch(/(^|\n)\s*\.overflow-y-auto\s*\{[^}]*overscroll-behavior/);
  });
});
