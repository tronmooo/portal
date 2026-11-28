// A desktop popover is drawn where Radix places it.
//
// `scrollbar-gutter: stable both-edges` on html/body reserved a LEFT gutter
// too, which moved the fixed-position origin: a fixed element at left:0 was
// measured at x=15 in Chromium with classic scrollbars, so every popover,
// menu and toast sat 15 px right of its anchor and a right-edge popover ran
// off the screen (integrity run 2026-11-27, bill occurrence "Move"; measured
// again 2026-11-28). Only the right-edge gutter is reserved.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("the desktop scrollbar gutter does not move fixed overlays", () => {
  const css = readFileSync("client/src/index.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("no rule reserves a gutter on both edges", () => {
    expect(css).not.toMatch(/scrollbar-gutter\s*:\s*stable\s+both-edges/);
  });
  it("html/body still reserve the right-edge gutter on desktop (the dialog-shift fix)", () => {
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*html, body \{\s*scrollbar-gutter: stable;/);
  });
});
