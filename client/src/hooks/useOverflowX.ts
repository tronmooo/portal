// ── useOverflowX ─────────────────────────────────────────────────────────────
// Does this horizontal scroller actually have anything scrolled out of view?
//
// The hub's KPI strip and tab row both fade their right edge so a cut-off chip
// reads as "there is more this way" rather than as a broken layout. That fade
// was unconditional, so on a desktop — where every chip fits with room to spare
// — it dimmed the right edge of a row that had nothing hidden behind it, which
// is the opposite of what it is for.
//
// Width alone is not enough to answer this: the strip's chips change size when
// their numbers land ("—" becoming "1,398,804"), and that resizes the children
// without resizing the observed container. Callers pass those values as `deps`
// so the measurement re-runs when the content changes, and the ResizeObserver
// covers window resizes, sidebar toggles and orientation changes.
import { useEffect, useRef, useState, type RefObject } from "react";

export function useOverflowX<T extends HTMLElement>(deps: unknown[] = []): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel layout rounding otherwise reports a permanent
    // overflow on rows that fit exactly.
    const measure = () => setOverflowing(el.scrollWidth - el.clientWidth > 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Children too: a chip growing when its number arrives is the common case,
    // and it never changes the container's own box.
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return [ref, overflowing];
}
