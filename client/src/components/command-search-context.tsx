// ─── CommandSearch open-state context ────────────────────────────────────────
// PERF: the palette's open state lives in this tiny module (imported by the app
// shell) so the palette BODY — cmdk, the scroll-area primitive, the icon set and
// the search index glue, ~40 KB of the entry bundle — can live in a lazy chunk
// that is only fetched the first time the user actually opens search.
import { createContext, useContext, useEffect, useState } from "react";

interface CommandSearchContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}

export const CommandSearchContext = createContext<CommandSearchContextValue>({
  open: false,
  setOpen: () => {},
});

export function useCommandSearch() {
  return useContext(CommandSearchContext);
}

// ─── Provider (wraps the app, manages open state) ─────────────────────────────

export function CommandSearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <CommandSearchContext.Provider value={{ open, setOpen }}>
      {children}
    </CommandSearchContext.Provider>
  );
}
