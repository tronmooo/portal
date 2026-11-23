// Does a touch belong to something that uses a sideways drag itself?
//
// The app shell turns a quick horizontal swipe into "go to the next tab"
// (SwipeNav, App.tsx). A drag on a slider, or along a row that scrolls
// sideways, is the same gesture — and the shell took it: dragging the
// ownership slider left the asset profile for the Dashboard with the change
// unsaved (owner, 2026-11-23: "put myself to 100% … it brought me back to the
// dashboard page"). A touch that starts on any of these is never a page swipe.

/** Controls and containers that own their touches. `data-swipe-ignore` opts a subtree out. */
export const SWIPE_OWNING_SELECTOR = [
  "button", "a", "input", "textarea", "select", "label",
  '[role="button"]', '[role="slider"]', '[role="tab"]', '[role="tablist"]', '[role="switch"]',
  '[role="dialog"]', "[data-radix-dialog-content]", "[data-swipe-ignore]",
  '[contenteditable="true"]', '[draggable="true"]',
].join(", ");

/** Can this element be scrolled sideways right now? */
function scrollsSideways(el: Element): boolean {
  const node = el as HTMLElement;
  if (!(node.scrollWidth > node.clientWidth + 1)) return false;
  const overflowX = typeof getComputedStyle === "function" ? getComputedStyle(node).overflowX : "";
  return overflowX === "auto" || overflowX === "scroll";
}

/**
 * True when a touch starting on `target` must not be read as a page swipe:
 * it is on (or inside) a control, or inside something that scrolls sideways.
 * `boundary` is where the walk stops (the element the shell listens on).
 */
export function touchOwnsHorizontalDrag(target: EventTarget | null, boundary?: Element | null): boolean {
  const start = target instanceof Element ? target : null;
  if (!start) return false;
  if (start.closest(SWIPE_OWNING_SELECTOR)) return true;
  for (let el: Element | null = start; el && el !== boundary; el = el.parentElement) {
    if (scrollsSideways(el)) return true;
  }
  return false;
}
