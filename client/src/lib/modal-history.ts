// ── Back-button-aware modals ─────────────────────────────────────────────────
// 2026-07-29 tester report: "The Back button skips modals instead of closing
// them (closes the modal AND changes the page)." On mobile especially, Back
// while a dialog/sheet is open should dismiss the dialog and stay on the page.
//
// How it works: every CONTROLLED Radix root (Dialog / AlertDialog / Sheet —
// wrapped in components/ui) calls useModalHistory(open, close). Opening pushes
// one sentinel history entry (same URL, `{ __modal: true }` state — no hash
// change, so wouter never sees it). Pressing Back pops the sentinel and the
// popstate listener closes the TOP-MOST open modal instead of navigating.
// Closing by X / ESC / outside-click consumes the sentinel with a suppressed
// history.back() so the history stack stays balanced.
//
// Stacked modals (dialog + its confirm AlertDialog) each push their own
// sentinel; Back closes them one at a time, top-most first.
//
// Uncontrolled roots (no `open` prop) are left alone — there is nothing to
// close programmatically, and they are rare (trigger-based menus).

import { useEffect, useRef } from "react";

type StackEntry = { close: () => void };

const stack: StackEntry[] = [];
let suppressPops = 0;
let listening = false;
let lastModalCloseAt = 0;

function ensureListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("popstate", () => {
    if (suppressPops > 0) {
      suppressPops--;
      return;
    }
    const top = stack.pop();
    if (top) {
      lastModalCloseAt = Date.now();
      try { top.close(); } catch { /* modal already unmounting */ }
    }
    // Stack empty → a real navigation; let it proceed untouched.
  });
}

/**
 * Register a controlled modal with the Back-button stack while `open` is true.
 * `close` must flip the caller's open state to false (e.g. onOpenChange(false)).
 * Pass `open === undefined` for uncontrolled roots — the hook no-ops.
 */
export function useModalHistory(open: boolean | undefined, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    ensureListener();
    const entry: StackEntry = { close: () => closeRef.current() };
    stack.push(entry);
    try { window.history.pushState({ __modal: true }, ""); } catch { /* sandboxed */ }

    return () => {
      const i = stack.indexOf(entry);
      if (i === -1) return; // closed via Back — sentinel already popped
      stack.splice(i, 1);
      lastModalCloseAt = Date.now();
      // Consume our sentinel ONLY if it is still the top entry. If something
      // navigated while the modal was open (a footer "Open Finance" link),
      // the top entry is the new page and a back() here would undo that
      // navigation; the orphaned sentinel is harmless (same URL, no-op pop).
      try {
        if ((window.history.state as any)?.__modal) {
          suppressPops++;
          window.history.back();
        }
      } catch { /* sandboxed */ }
    };
  }, [open]);
}

/**
 * True within `windowMs` of any modal closing. Used to swallow the ghost
 * tap that lands on whatever sat underneath the just-dismissed dialog —
 * e.g. the profile switcher living at the same screen position as a
 * dialog's X (2026-07-29 tester report: accidental profile switches).
 */
export function modalJustClosed(windowMs = 350): boolean {
  return Date.now() - lastModalCloseAt < windowMs;
}
