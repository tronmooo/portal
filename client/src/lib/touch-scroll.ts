// Native touch scrolling inside a Radix dialog on iOS.
//
// Radix Dialog locks the page with react-remove-scroll, which listens to every
// `touchmove` on the document and calls preventDefault() when it decides the
// gesture can't scroll anything. It classes a move as horizontal when its
// first sample drifts even 1px more sideways than down, finds no horizontal
// scroller, and cancels it — and on iOS cancelling the first touchmove kills
// the whole swipe. The tracker popup "wouldn't scroll up or down" on iPhone
// (2026-10-20) because most thumb flicks start slightly diagonal.
//
// Stopping the event at the scroll container keeps it from reaching that
// document-level listener, so the browser scrolls natively. The container must
// carry `overscroll-contain` so a swipe past either end doesn't chain to the
// page behind.

import { useCallback, useRef } from "react";

const stop = (e: Event) => e.stopPropagation();

/** Ref callback for a dialog's scroll container. */
export function useNativeTouchScroll<T extends HTMLElement>(): (el: T | null) => void {
  const current = useRef<T | null>(null);
  return useCallback((el: T | null) => {
    if (current.current === el) return;
    current.current?.removeEventListener("touchmove", stop);
    current.current = el;
    el?.addEventListener("touchmove", stop, { passive: true });
  }, []);
}
