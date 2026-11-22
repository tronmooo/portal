// @vitest-environment jsdom
//
// iPhone (2026-11-21): scrolling back up anywhere on a page showed "Pull to
// refresh" and a long swipe refetched the page instead of scrolling. The pull
// checked `#main-content.scrollTop`, but <main> is overflow-hidden and the page
// scrolls in an inner div, so it always read 0. A pull may only arm when the
// scroller under the finger is at its top.
import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, act, screen } from "@testing-library/react";

const invalidateDomains = vi.fn(async () => {});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: (...a: unknown[]) => invalidateDomains(...(a as [])) }));
vi.mock("@/lib/queryClient", () => ({ queryClient: { invalidateQueries: vi.fn(async () => {}) } }));

import { PullToRefresh, isScrolledToTop } from "../client/src/components/PullToRefresh";

afterEach(() => { cleanup(); document.body.innerHTML = ""; });
beforeEach(() => invalidateDomains.mockClear());

function touch(type: string, target: Element, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  const t = { clientX: 100, clientY: y, target };
  Object.assign(ev, { touches: type === "touchend" ? [] : [t], changedTouches: [t] });
  act(() => { target.dispatchEvent(ev); });
}

/** <main overflow-hidden> → inner page scroller → a card. */
function mountPage(scrollTop: number) {
  const main = document.createElement("main");
  main.id = "main-content";
  const scroller = document.createElement("div");
  const card = document.createElement("div");
  scroller.appendChild(card);
  main.appendChild(scroller);
  document.body.appendChild(main);
  scroller.scrollTop = scrollTop;
  render(<PullToRefresh />);
  return { main, scroller, card };
}

describe("pull to refresh", () => {
  it("does not arm or refresh when the page's inner scroller is scrolled down", async () => {
    const { main, scroller, card } = mountPage(600);
    expect(main.scrollTop).toBe(0); // the old check's input: always 0
    expect(scroller.scrollTop).toBe(600);
    touch("touchstart", card, 200);
    touch("touchmove", card, 260);
    expect(screen.queryByTestId("pull-to-refresh")).toBeNull();
    touch("touchend", card, 320);
    await act(async () => {});
    expect(invalidateDomains).not.toHaveBeenCalled();
  });

  it("still refreshes on a pull from the top", async () => {
    const { card } = mountPage(0);
    touch("touchstart", card, 200);
    touch("touchmove", card, 260);
    expect(screen.getByTestId("pull-to-refresh").textContent).toContain("Pull to refresh");
    touch("touchend", card, 300);
    await act(async () => {});
    expect(invalidateDomains).toHaveBeenCalledTimes(1);
  });

  it("cancels when the scroller leaves its top mid-gesture", async () => {
    const { scroller, card } = mountPage(0);
    touch("touchstart", card, 200);
    scroller.scrollTop = 50;
    touch("touchmove", card, 260);
    touch("touchend", card, 300);
    await act(async () => {});
    expect(invalidateDomains).not.toHaveBeenCalled();
  });

  it("works when it mounted before <main> existed (sign-in, auth loading)", async () => {
    render(<PullToRefresh />); // the auth gate hasn't rendered #main-content yet
    const main = document.createElement("main");
    main.id = "main-content";
    const scroller = document.createElement("div");
    const card = document.createElement("div");
    scroller.appendChild(card);
    main.appendChild(scroller);
    document.body.appendChild(main);
    touch("touchstart", card, 200);
    touch("touchmove", card, 260);
    touch("touchend", card, 300);
    await act(async () => {});
    expect(invalidateDomains).toHaveBeenCalledTimes(1);
  });

  it("ignores touches outside <main> (header, bottom nav)", async () => {
    mountPage(0);
    const nav = document.createElement("nav");
    document.body.appendChild(nav);
    touch("touchstart", nav, 200);
    touch("touchmove", nav, 260);
    touch("touchend", nav, 300);
    await act(async () => {});
    expect(invalidateDomains).not.toHaveBeenCalled();
  });

  it("isScrolledToTop reads every ancestor up to the boundary", () => {
    const { main, scroller, card } = mountPage(0);
    expect(isScrolledToTop(card, main)).toBe(true);
    scroller.scrollTop = 1;
    expect(isScrolledToTop(card, main)).toBe(false);
  });
});
