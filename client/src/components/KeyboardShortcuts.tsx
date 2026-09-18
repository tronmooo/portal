import { useEffect } from "react";
import { useLocation } from "wouter";
import { useCommandSearch } from "@/components/CommandSearch";

/**
 * Global keyboard shortcuts:
 * - Cmd+K: Toggle command palette (handled in CommandSearchProvider)
 * - Cmd+N: Quick task — navigate to dashboard with quick-task action
 * - Cmd+J: Journal entry — navigate to dashboard with journal action
 * - Cmd+/: Focus chat input
 */
export function KeyboardShortcuts() {
  const [, navigate] = useLocation();
  const { setOpen } = useCommandSearch();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs/textareas (unless it's the specific combo)
      const target = e.target as HTMLElement | null;
      const isInput = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      // Typing is typing: a key pressed inside a field, or while any dialog
      // (the ⌘K palette included) is open, belongs to that field or dialog —
      // never to a page-level jump (F-49). `isInput` was computed and ignored.
      const dialogOpen = typeof document !== "undefined" && !!document.querySelector('[role="dialog"]');
      if (isInput || dialogOpen) return;

      if (!(e.metaKey || e.ctrlKey)) return;

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
