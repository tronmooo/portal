// What the phone actually SHOWS, published to CSS.
//
// When the on-screen keyboard opens, iOS (Safari and the app's web view)
// shrinks the VISUAL viewport and leaves the layout viewport alone. Everything
// `position: fixed` — every dialog, sheet and full-screen workspace — is laid
// out against the layout viewport, so it keeps its full height: its bottom
// (the Save button, a footer, the Ask AI bar) sits under the keyboard, and the
// browser pans to the caret, pushing its top (the title, the X) off screen.
// `dvh` does not help: it tracks the browser's toolbars, not the keyboard.
// (Owner, 2026-11-23: "there's no save button … I need to be able to see it.
// There's just stuff like that throughout my entire app.")
//
// This module is the ONE place that watches the visual viewport. It writes on
// <html>:
//   --vvh      the visible height, in px
//   --vv-top   how far the visible area has panned down the layout viewport
//   --kb       the height covered at the bottom (the keyboard), in px
//   data-keyboard="open"  while the keyboard is up
// and index.css ("Keyboard-aware surfaces") uses them to keep every dialog,
// sheet and workspace inside the visible area. A new fixed surface gets the
// same treatment by using those variables — never by its own listener.
//
// Guard: tests/keyboard-aware-surfaces.test.ts.

/** How much shorter than the tallest window seen counts as "the keyboard is up". */
export const KEYBOARD_MIN_PX = 140;

export interface ViewportBox { height: number; width: number; offsetTop: number }

/** The pure rule: what to publish for this viewport, given the tallest seen at this width. */
export function viewportVars(vv: ViewportBox, layoutHeight: number, tallest: number): {
  vvh: number; top: number; kb: number; keyboard: boolean;
} {
  const top = Math.max(0, Math.round(vv.offsetTop));
  const vvh = Math.round(vv.height);
  return {
    vvh,
    top,
    kb: Math.max(0, Math.round(layoutHeight - top - vvh)),
    keyboard: tallest - vv.height > KEYBOARD_MIN_PX,
  };
}

/** Start publishing. Returns a function that stops (tests). */
export function installVisualViewportVars(win: Window = window): () => void {
  const vv = win.visualViewport;
  const root = win.document.documentElement;
  if (!vv) return () => undefined;
  let tallest = vv.height;
  let width = vv.width;
  const publish = () => {
    // A rotation is a new window, not a keyboard.
    if (Math.abs(vv.width - width) > 1) { width = vv.width; tallest = vv.height; }
    tallest = Math.max(tallest, vv.height);
    const v = viewportVars(vv, root.clientHeight || win.innerHeight, tallest);
    root.style.setProperty("--vvh", `${v.vvh}px`);
    root.style.setProperty("--vv-top", `${v.top}px`);
    root.style.setProperty("--kb", `${v.kb}px`);
    if (v.keyboard) root.setAttribute("data-keyboard", "open");
    else root.removeAttribute("data-keyboard");
  };
  publish();
  vv.addEventListener("resize", publish);
  vv.addEventListener("scroll", publish);
  return () => {
    vv.removeEventListener("resize", publish);
    vv.removeEventListener("scroll", publish);
  };
}
