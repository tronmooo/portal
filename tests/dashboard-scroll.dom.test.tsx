// @vitest-environment jsdom
// Dashboard scrolling (owner report 2026-11-21: "I scroll to the bottom of the
// Dashboard and it won't let me scroll back up").
//
// Two causes, both guarded here (client/src/lib/page-scroll.ts):
//   1. pull-to-refresh asked `#main-content` — which never scrolls — whether
//      the page was at the top, so every swipe back up refetched the dashboard;
//   2. a swipe or wheel that started on the hub header scrolled nothing.
// The real-browser version is tests/live-dashboard-check.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { findPageScroller, isScrolledToTop, forwardScrollToPage } from "../client/src/lib/page-scroll";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

/** jsdom has no layout: give an element the sizes a real scroller would have. */
function sized(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(scrollHeight - clientHeight, v)); },
  });
}

let main: HTMLElement, shell: HTMLElement, page: HTMLElement, card: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = `
    <main id="main-content">
      <div data-testid="hub-shell"><button id="tab">Finance</button></div>
      <div>
        <div data-testid="page-dashboard" class="h-full overflow-y-auto"><section id="card">card</section></div>
      </div>
    </main>`;
  main = document.getElementById("main-content")!;
  shell = main.querySelector<HTMLElement>("[data-testid='hub-shell']")!;
  page = main.querySelector<HTMLElement>("[data-testid='page-dashboard']")!;
  card = document.getElementById("card")!;
  sized(page, 3000, 400);
});
afterEach(() => { document.body.innerHTML = ""; });

const touch = (target: HTMLElement, type: string, x: number, y: number, t: number) => {
  const e: any = new Event(type, { bubbles: true });
  const pts = type === "touchend" ? [] : [{ clientX: x, clientY: y }];
  Object.defineProperty(e, "touches", { value: pts });
  Object.defineProperty(e, "changedTouches", { value: [{ clientX: x, clientY: y }] });
  Object.defineProperty(e, "timeStamp", { value: t });
  target.dispatchEvent(e);
};

describe("findPageScroller", () => {
  it("finds the page's own scroller, not #main-content", () => {
    expect(findPageScroller(main)).toBe(page);
  });
  it("is null when the page fits (nothing to scroll)", () => {
    sized(page, 400, 400);
    expect(findPageScroller(main)).toBeNull();
  });
});

describe("isScrolledToTop — when a downward drag is a pull-to-refresh", () => {
  it("true at the very top", () => {
    expect(isScrolledToTop(card, main)).toBe(true);
  });

  it("false once the page is scrolled down — touching a card", () => {
    page.scrollTop = 2600;
    expect(isScrolledToTop(card, main)).toBe(false);
  });

  it("false once the page is scrolled down — touching the hub header, which is outside the scroller", () => {
    page.scrollTop = 2600;
    expect(isScrolledToTop(shell, main)).toBe(false);
    // The old test — `main.scrollTop === 0` — said "at the top" here.
    expect(main.scrollTop).toBe(0);
  });
});

describe("forwardScrollToPage — no dead zone above the page", () => {
  it("a finger dragged DOWN on the header scrolls the page back up", () => {
    page.scrollTop = 2600;
    const off = forwardScrollToPage(shell, main);
    touch(shell, "touchstart", 100, 100, 0);
    touch(shell, "touchmove", 100, 120, 16);   // decides the axis
    touch(shell, "touchmove", 100, 220, 32);
    touch(shell, "touchmove", 100, 320, 48);
    expect(page.scrollTop).toBe(2400);
    off();
  });

  it("a finger dragged UP on the header scrolls the page down", () => {
    const off = forwardScrollToPage(shell, main);
    touch(shell, "touchstart", 100, 300, 0);
    touch(shell, "touchmove", 100, 280, 16);
    touch(shell, "touchmove", 100, 180, 32);
    expect(page.scrollTop).toBe(100);
    off();
  });

  it("leaves a sideways drag alone (the KPI strip and tab row scroll sideways)", () => {
    page.scrollTop = 500;
    const off = forwardScrollToPage(shell, main);
    touch(shell, "touchstart", 100, 100, 0);
    touch(shell, "touchmove", 140, 104, 16);
    touch(shell, "touchmove", 240, 130, 32);
    expect(page.scrollTop).toBe(500);
    off();
  });

  it("the wheel over the header scrolls the page", () => {
    const off = forwardScrollToPage(shell, main);
    const e: any = new Event("wheel", { bubbles: true });
    Object.assign(e, { deltaY: 240, deltaX: 0, deltaMode: 0, ctrlKey: false });
    shell.dispatchEvent(e);
    expect(page.scrollTop).toBe(240);
    off();
  });

  it("stops listening when cleaned up", () => {
    const off = forwardScrollToPage(shell, main);
    off();
    touch(shell, "touchstart", 100, 300, 0);
    touch(shell, "touchmove", 100, 280, 16);
    touch(shell, "touchmove", 100, 100, 32);
    expect(page.scrollTop).toBe(0);
  });
});

describe("the app shell uses them", () => {
  const app = read("client/src/App.tsx");
  const ptr = app.slice(app.indexOf("function PullToRefresh()"), app.indexOf("function SwipeNav()"));

  it("pull-to-refresh arms only when the page under the finger is at its top", () => {
    expect(ptr).toContain("isScrolledToTop(e.target, main)");
    // The bug, verbatim: `main` never scrolls, so this was always true.
    expect(ptr.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")).not.toContain("main.scrollTop === 0");
  });

  it("the hub header forwards drags and wheel to the page", () => {
    const shellSrc = read("client/src/components/hub/HubShell.tsx");
    expect(shellSrc).toContain("forwardScrollToPage(el)");
    expect(shellSrc).toContain("ref={shellRef}");
  });

  it("the document never rubber-bands, and a page keeps its own overscroll", () => {
    const css = read("client/src/index.css");
    expect(css).toMatch(/html, body \{\s*overscroll-behavior-y: none;/);
    expect(css).toMatch(/#main-content \[data-testid\^="page-"\] \{\s*overscroll-behavior-y: contain;/);
  });

  it("no dashboard card is its own scroll container (the wheel would stop at the card)", () => {
    const src = read("client/src/components/dashboard/ExecTodayCards.tsx") + read("client/src/components/finance/BillsOverviewList.tsx");
    expect(src).not.toMatch(/overflow-y-(auto|scroll)/);
    expect(src).not.toMatch(/max-h-\[/);
  });
});
