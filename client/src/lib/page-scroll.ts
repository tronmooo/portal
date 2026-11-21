// ── The page scroller ────────────────────────────────────────────────────────
// The app shell never scrolls: `#main-content` is `overflow-hidden` and each
// page owns ONE vertical scroller under it (`h-full overflow-y-auto`, usually
// stamped `data-testid="page-…"`). Three things have to agree on which element
// that is, and each used to guess for itself:
//
//   · pull-to-refresh asked `#main-content` whether the page was at the top.
//     It never scrolls, so the answer was always "yes" — every swipe that
//     scrolled the page back UP was also read as a pull-to-refresh, and a full
//     refetch of the dashboard ran under the user's finger. (Owner report
//     2026-11-21: "I scroll to the bottom of the Dashboard and it won't let me
//     scroll back up.")
//   · a drag that started on the hub header (date, KPI strip, tab row — about
//     40% of a phone screen) scrolled nothing, because the header is outside
//     the scroller. Scrolling back up is exactly the gesture that starts high.
//   · the hub shell resets the scroller on a tab switch.
//
// This module is the one answer. *Guard:* tests/dashboard-scroll.dom.test.tsx.

const CANDIDATES = "[data-testid^='page-'], .overflow-y-auto";

function scrollsVertically(el: HTMLElement): boolean {
  if (el.scrollHeight - el.clientHeight <= 1) return false;
  const oy = typeof getComputedStyle === "function" ? getComputedStyle(el).overflowY : "";
  // jsdom reports "" for class-driven overflow; an element that is taller
  // inside than outside and is one of our candidates is the scroller.
  return oy === "" || oy === "auto" || oy === "scroll" || oy === "overlay";
}

/** The page's vertical scroller under `root` (default `#main-content`), or
 *  null when the page fits and nothing scrolls. */
export function findPageScroller(root?: HTMLElement | null): HTMLElement | null {
  const main = root ?? (typeof document !== "undefined" ? document.getElementById("main-content") : null);
  if (!main) return null;
  for (const el of Array.from(main.querySelectorAll<HTMLElement>(CANDIDATES))) {
    if (el.closest("[role='dialog']")) continue;
    if (scrollsVertically(el)) return el;
  }
  return null;
}

/**
 * Is the content under this touch scrolled to its very top? True only when
 * neither an ancestor of the touched element nor the page scroller has been
 * scrolled down — the one condition under which a downward drag is a
 * pull-to-refresh rather than "scroll back up".
 */
export function isScrolledToTop(target: EventTarget | null, root?: HTMLElement | null): boolean {
  const main = root ?? (typeof document !== "undefined" ? document.getElementById("main-content") : null);
  let el = target instanceof HTMLElement ? target : null;
  while (el) {
    if (el.scrollTop > 0) return false;
    if (el === main) break;
    el = el.parentElement;
  }
  const page = findPageScroller(main);
  return !page || page.scrollTop <= 0;
}

/**
 * Lets a drag or wheel that starts on fixed chrome ABOVE the page (the hub
 * header) scroll the page beneath it, so there is no dead zone: wherever the
 * finger lands, the page moves. Returns the cleanup function.
 *
 * Listeners are passive — this never cancels a native gesture. Horizontal
 * drags are left alone (the KPI strip and the tab row scroll sideways).
 */
export function forwardScrollToPage(chrome: HTMLElement, root?: HTMLElement | null): () => void {
  let startX = 0, startY = 0, lastY = 0, lastT = 0, velocity = 0;
  let axis: "x" | "y" | null = null;
  let target: HTMLElement | null = null;
  let raf = 0;

  const stopGlide = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

  const onTouchStart = (e: TouchEvent) => {
    stopGlide();
    if (e.touches.length !== 1) { target = null; return; }
    target = findPageScroller(root);
    axis = null;
    velocity = 0;
    startX = e.touches[0].clientX;
    startY = lastY = e.touches[0].clientY;
    lastT = e.timeStamp;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!target || e.touches.length !== 1) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    if (!axis) {
      const dx = Math.abs(x - startX), dy = Math.abs(y - startY);
      if (dx < 6 && dy < 6) return;
      axis = dy > dx ? "y" : "x";
      lastY = y; lastT = e.timeStamp;
      if (axis === "x") return;
    }
    if (axis !== "y") return;
    const dy = y - lastY;
    const dt = Math.max(1, e.timeStamp - lastT);
    target.scrollTop -= dy;
    // Smoothed px/ms, for the glide after the finger lifts.
    velocity = 0.7 * (-dy / dt) + 0.3 * velocity;
    lastY = y; lastT = e.timeStamp;
  };

  const onTouchEnd = (e: TouchEvent) => {
    const el = target;
    target = null;
    if (!el || axis !== "y") return;
    // A finger that paused before lifting carries no momentum.
    if (e.timeStamp - lastT > 80) return;
    let v = Math.max(-3, Math.min(3, velocity));
    if (Math.abs(v) < 0.15 || typeof requestAnimationFrame !== "function") return;
    let prev = 0;
    const step = (now: number) => {
      const dt = prev ? Math.min(32, now - prev) : 16;
      prev = now;
      const before = el.scrollTop;
      el.scrollTop += v * dt;
      v *= Math.pow(0.95, dt / 16);
      // Stop at either end, or once it has all but stopped.
      if (Math.abs(v) < 0.02 || el.scrollTop === before) { raf = 0; return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const el = findPageScroller(root);
    if (!el) return;
    // deltaMode 1 = lines, 2 = pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
    el.scrollTop += e.deltaY * unit;
  };

  chrome.addEventListener("touchstart", onTouchStart, { passive: true });
  chrome.addEventListener("touchmove", onTouchMove, { passive: true });
  chrome.addEventListener("touchend", onTouchEnd, { passive: true });
  chrome.addEventListener("touchcancel", onTouchEnd, { passive: true });
  chrome.addEventListener("wheel", onWheel, { passive: true });
  return () => {
    stopGlide();
    chrome.removeEventListener("touchstart", onTouchStart);
    chrome.removeEventListener("touchmove", onTouchMove);
    chrome.removeEventListener("touchend", onTouchEnd);
    chrome.removeEventListener("touchcancel", onTouchEnd);
    chrome.removeEventListener("wheel", onWheel);
  };
}
