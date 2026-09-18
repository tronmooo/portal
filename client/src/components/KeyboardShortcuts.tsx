import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useCommandSearch, QUICK_ACTIONS } from "@/components/CommandSearch";
import { hashNavigate } from "@/lib/hashNavigate";

/**
 * Global keyboard shortcuts:
 * - Cmd+K: Toggle command palette (handled in CommandSearchProvider)
 * - Cmd+N: Quick task — navigate to dashboard with quick-task action
 * - Cmd+J: Journal entry — navigate to dashboard with journal action
 * - Cmd+/: Focus chat input
 * - Single letters (D / C / T / P / F / K / H / J / L / A / O / S / I — the
 *   QUICK_ACTIONS list the palette prints): jump to that section, but ONLY
 *   when the page itself has focus. See `singleKeyShortcutsArmed`.
 */

/** Any Radix layer that is open owns the keyboard: dialogs, menus, popovers. */
const OPEN_LAYER_SELECTOR =
  '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], [data-radix-popper-content-wrapper]';

/**
 * QA 2026-09-18 BUG-24: the tester clicked the "Search ⌘K" control and typed
 * "dana"; the letters were eaten as navigation shortcuts and the app jumped
 * to Artifacts. A single unmodified letter is a shortcut only when nothing
 * else could want it: focus sits on the page itself (body / the main
 * region), no dialog, menu or popover is open, and no button was clicked or
 * focused within the last second (a click that opened something the letter
 * was meant for must never be raced by the shortcut).
 */
export function singleKeyShortcutsArmed(
  doc: Document,
  lastInteractionAt: number,
  now: number = Date.now(),
  interactionWindowMs = 1000,
): boolean {
  const active = doc.activeElement as HTMLElement | null;
  const onPage = !active || active === doc.body || active.id === "main-content" || active.tagName === "MAIN";
  if (!onPage) return false;
  if (doc.querySelector(OPEN_LAYER_SELECTOR)) return false;
  if (now - lastInteractionAt < interactionWindowMs) return false;
  return true;
}

export function KeyboardShortcuts() {
  const [, navigate] = useLocation();
  const { setOpen, open: paletteOpen } = useCommandSearch();
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;
  // When a pointer last went down or a control last took focus — a letter
  // typed right after either is input, not a command.
  const lastInteractionRef = useRef(0);

  useEffect(() => {
    const mark = () => { lastInteractionRef.current = Date.now(); };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && t.id !== "main-content") mark();
    };
    window.addEventListener("pointerdown", mark, true);
    window.addEventListener("focusin", onFocusIn, true);
    return () => {
      window.removeEventListener("pointerdown", mark, true);
      window.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs/textareas (unless it's the specific combo)
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      if (!(e.metaKey || e.ctrlKey)) {
        // Single-letter section shortcuts, heavily guarded (see above).
        if (e.altKey || e.repeat || e.isComposing || e.key.length !== 1 || isInput) return;
        if (paletteOpenRef.current) return;
        if (!singleKeyShortcutsArmed(document, lastInteractionRef.current)) return;
        const hit = QUICK_ACTIONS.find((a) => a.shortcut === e.key.toUpperCase());
        if (!hit) return;
        e.preventDefault();
        // Same rule as the palette's handleSelect: query-carrying targets go
        // through hashNavigate so wouter does not hoist the query out.
        if (hit.path.includes("?")) hashNavigate(hit.path);
        else navigate(hit.path);
        return;
      }

      switch (e.key) {
        case "n": {
          e.preventDefault();
          // Navigate to dashboard — the quick actions are there
          navigate("/dashboard");
          // Dispatch custom event so QuickActionsRow can auto-open the task dialog
          setTimeout(() => window.dispatchEvent(new CustomEvent("lifeos:quick-task")), 100);
          break;
        }
        case "j": {
          e.preventDefault();
          navigate("/dashboard");
          setTimeout(() => window.dispatchEvent(new CustomEvent("lifeos:quick-journal")), 100);
          break;
        }
        case "/": {
          e.preventDefault();
          // Navigate to chat and focus the input
          navigate("/chat");
          setTimeout(() => {
            const chatInput = document.querySelector<HTMLTextAreaElement>('[data-testid="input-chat"]');
            if (chatInput) chatInput.focus();
          }, 100);
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigate, setOpen]);

  return null;
}
