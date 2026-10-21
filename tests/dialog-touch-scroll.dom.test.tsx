// @vitest-environment jsdom
//
// iPhone: the tracker popup wouldn't scroll (2026-10-20). Radix Dialog's
// scroll lock cancels a touchmove that starts slightly sideways when nothing
// scrolls sideways, and iOS then drops the whole swipe. A scroller wired with
// useNativeTouchScroll must let that swipe through; without it, the lock
// cancels it (the control case, so this test can't pass vacuously).
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Dialog, DialogContent } from "../client/src/components/ui/dialog";
import { useNativeTouchScroll } from "../client/src/lib/touch-scroll";

afterEach(cleanup);

function Scroller({ wired }: { wired: boolean }) {
  const ref = useNativeTouchScroll<HTMLDivElement>();
  return (
    <div ref={wired ? ref : undefined} data-testid="scroller" style={{ overflowY: "auto", height: 100 }}>
      <div data-testid="inner" style={{ height: 1000 }}>content</div>
    </div>
  );
}

function touch(type: string, target: Element, x: number, y: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = { clientX: x, clientY: y, target };
  Object.assign(ev, { touches: [t], changedTouches: [t], targetTouches: [t] });
  target.dispatchEvent(ev);
  return ev;
}

function diagonalSwipe(): Event {
  const inner = screen.getByTestId("inner");
  touch("touchstart", inner, 100, 300);
  // First sample drifts 6px sideways, 4px up — "horizontal" to the lock.
  return touch("touchmove", inner, 94, 296);
}

describe("touch scrolling inside a dialog", () => {
  it("the scroll lock cancels a diagonal swipe on an unwired scroller (control)", () => {
    render(<Dialog open><DialogContent><Scroller wired={false} /></DialogContent></Dialog>);
    expect(diagonalSwipe().defaultPrevented).toBe(true);
  });

  it("a scroller wired with useNativeTouchScroll keeps the swipe", () => {
    render(<Dialog open><DialogContent><Scroller wired /></DialogContent></Dialog>);
    expect(diagonalSwipe().defaultPrevented).toBe(false);
  });
});
