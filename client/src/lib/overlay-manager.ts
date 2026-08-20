// ── Central overlay manager ──────────────────────────────────────────────────
// QA 2026-08-20 (bug 13): "Attention Filters remained expanded after Escape.
// Dashboard Menu opened while Attention Filters was still expanded. Search
// opened over the remaining filter panel. Notifications also opened while
// Attention Filters stayed visible behind it."
//
// Every non-modal overlay on the dashboard owned its own `open` boolean and
// knew nothing about the others, so opening one could never close another and
// a hand-rolled panel (the attention filter drawer is a plain `{open && …}`,
// not a Radix root) had no Escape handling at all. This module is the one
// place that knows which overlay is showing:
//
//   · openOverlay(id, close)  — closes whatever else was open, then records id
//   · closeOverlay(id)        — deregisters and stamps the close time
//   · Escape                  — closes the active overlay, whatever kind it is
//   · overlayJustClosed()     — ghost-tap shield for whatever sat underneath
//
// Radix roots keep their own Escape/outside-click behavior; registering them
// here only adds the cross-overlay exclusivity they cannot know about on their
// own. Registration is idempotent and close() must be safe to call twice.
import { useEffect, useRef } from "react";
import { modalJustClosed } from "./modal-history";

interface OverlayEntry {
  id: string;
  close: () => void;
}

let active: OverlayEntry | null = null;
let lastClosedAt = 0;
let listening = false;

function stampClosed(): void {
  lastClosedAt = Date.now();
}

function ensureKeyListener(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Esc") return;
      // Only claim the key when we actually have something to close, so a
      // Radix dialog's own Escape handling is never pre-empted for overlays
      // that never registered.
      if (closeActiveOverlay()) e.stopPropagation();
    },
    // Capture phase: the attention drawer is a plain div with no focus trap,
    // so the key event may never reach a bubbling listener on it.
    true,
  );
}

/** Which overlay is showing, or null. Exposed for tests and diagnostics. */
export function activeOverlayId(): string | null {
  return active?.id ?? null;
}

/**
 * Register `id` as the one open overlay, closing any other that was open.
 * `close` must flip the caller's own open state to false.
 */
export function openOverlay(id: string, close: () => void): void {
  ensureKeyListener();
  if (active && active.id !== id) {
    const previous = active;
    // Clear first: a close() that synchronously calls back into
    // closeOverlay(previous.id) must not re-enter this branch.
    active = null;
    try { previous.close(); } catch { /* already unmounting */ }
    stampClosed();
  }
  active = { id, close };
}

/** Deregister `id` if it is the active overlay. No-op otherwise. */
export function closeOverlay(id: string): void {
  if (active?.id !== id) return;
  active = null;
  stampClosed();
}

/** Close whatever is open. Returns true if there was something to close. */
export function closeActiveOverlay(): boolean {
  const entry = active;
  if (!entry) return false;
  active = null;
  stampClosed();
  try { entry.close(); } catch { /* already unmounting */ }
  return true;
}

/**
 * True within `windowMs` of any overlay OR modal closing. The tap that
 * dismisses an overlay lands on whatever sat underneath it once the overlay
 * unmounts — on the hub that is the tab chip row directly below the profile
 * switcher's menu, which is how choosing a person could navigate the user to
 * the Info tab (QA 2026-08-20 bug 11).
 */
export function overlayJustClosed(windowMs = 350): boolean {
  return Date.now() - lastClosedAt < windowMs || modalJustClosed(windowMs);
}

/** Test seam: forget all overlay state between cases. */
export function resetOverlayManager(): void {
  active = null;
  lastClosedAt = 0;
}

/**
 * Bind a controlled overlay's `open` state to the manager for as long as it is
 * open. Opening automatically closes any other registered overlay, and Escape
 * closes this one even when it has no Radix root of its own.
 */
export function useExclusiveOverlay(id: string, open: boolean, setOpen: (v: boolean) => void): void {
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (!open) {
      closeOverlay(id);
      return;
    }
    openOverlay(id, () => setOpenRef.current(false));
    return () => closeOverlay(id);
  }, [id, open]);
}
