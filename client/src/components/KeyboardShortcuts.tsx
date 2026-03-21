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
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

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
          navigate("/");
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
