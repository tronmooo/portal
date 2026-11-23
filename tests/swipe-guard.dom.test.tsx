// @vitest-environment jsdom
// A drag on a slider or along a sideways-scrolling row is that thing's own
// gesture, never the shell's "swipe to the next tab". (Owner, 2026-11-23:
// dragging the ownership slider left the asset profile for the Dashboard with
// the change unsaved.)
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { Slider } from "@/components/ui/slider";
import { touchOwnsHorizontalDrag } from "@/lib/swipe-guard";

(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
afterEach(cleanup);

describe("which touches the page swipe must leave alone", () => {
  it("every part of a slider: the root, the track and the thumb", () => {
    const { container } = render(<div id="main"><Slider value={[50]} min={0} max={100} data-testid="s" /></div>);
    const main = container.querySelector("#main")!;
    const root = container.querySelector('[data-testid="s"]')!;
    expect(root.hasAttribute("data-swipe-ignore")).toBe(true);
    const parts = [root, ...Array.from(root.querySelectorAll("*"))];
    expect(parts.length).toBeGreaterThan(2);
    for (const el of parts) expect(touchOwnsHorizontalDrag(el, main)).toBe(true);
    expect(container.querySelector('[role="slider"]')).not.toBeNull();
  });

  it("anything inside a row that scrolls sideways (a tab strip, a wide table)", () => {
    const { container } = render(
      <div id="main"><div id="strip" style={{ overflowX: "auto" }}><span id="chip">Financials</span></div><p id="text">plain</p></div>,
    );
    const strip = container.querySelector("#strip") as HTMLElement;
    Object.defineProperty(strip, "scrollWidth", { value: 900 });
    Object.defineProperty(strip, "clientWidth", { value: 300 });
    expect(touchOwnsHorizontalDrag(container.querySelector("#chip"), container.querySelector("#main"))).toBe(true);
  });

  it("a row that fits (nothing to scroll) and plain page content are still swipeable", () => {
    const { container } = render(
      <div id="main"><div id="strip" style={{ overflowX: "auto" }}><span id="chip">One</span></div><p id="text">plain</p></div>,
    );
    const strip = container.querySelector("#strip") as HTMLElement;
    Object.defineProperty(strip, "scrollWidth", { value: 300 });
    Object.defineProperty(strip, "clientWidth", { value: 300 });
    const main = container.querySelector("#main");
    expect(touchOwnsHorizontalDrag(container.querySelector("#chip"), main)).toBe(false);
    expect(touchOwnsHorizontalDrag(container.querySelector("#text"), main)).toBe(false);
    expect(touchOwnsHorizontalDrag(null, main)).toBe(false);
  });

  it("controls and opted-out subtrees", () => {
    const { container } = render(
      <div id="main"><button><b id="in-button">x</b></button><div data-swipe-ignore=""><i id="opted">y</i></div><div role="tablist"><span id="tab">t</span></div></div>,
    );
    for (const id of ["in-button", "opted", "tab"]) expect(touchOwnsHorizontalDrag(container.querySelector(`#${id}`), container.querySelector("#main"))).toBe(true);
  });

  it("the shell asks the guard before it starts tracking a swipe", () => {
    const src = readFileSync("client/src/App.tsx", "utf8");
    const start = src.slice(src.indexOf("const handleTouchStart"), src.indexOf("const handleTouchMove"));
    expect(start).toContain("touchOwnsHorizontalDrag(e.target");
    expect(start.indexOf("touchOwnsHorizontalDrag")).toBeLessThan(start.indexOf("startX.current = e.touches[0].clientX"));
  });
});
