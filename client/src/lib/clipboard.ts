// client/src/lib/clipboard.ts
//
// Copy text to the clipboard in every place the app runs: a normal browser
// tab, an installed PWA, iOS Safari, and embedded browsers/webviews.
//
// Regression (2026-11-09): the chat copy buttons did nothing. They called
// `navigator.clipboard.writeText` only and swallowed the rejection. That API
// exists but REJECTS in embedded browsers and webviews (no clipboard-write
// permission, or the document isn't focused), so the click was a silent
// no-op. The legacy `execCommand("copy")` path works there, and it must run
// synchronously inside the click — after an awaited rejection the user
// gesture can be gone — so it goes FIRST, and the async API is the fallback.

/** Synchronous copy through a temporary selection. True when the browser says it copied. */
function copyViaSelection(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  // Off-screen but focusable and selectable. readonly keeps the iOS keyboard
  // from opening; font-size 16px keeps iOS from zooming the page.
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "-9999px";
  ta.style.opacity = "0";
  ta.style.fontSize = "16px";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS ignores select()
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
    try { active?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
  }
  return ok;
}

/** Copy `text`. Resolves true on success, false if every method was refused. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (copyViaSelection(text)) return true;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* refused — fall through */
  }
  return false;
}
