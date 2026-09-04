// ─── Command palette (⌘K) — lazy shell ───────────────────────────────────────
// PERF: this module is imported by the app shell (App.tsx) and must stay tiny.
// The palette body — cmdk, the scroll-area primitive, the full icon set and the
// search-index glue — lives in CommandSearchDialog.tsx and is fetched the first
// time the user actually opens search. Before this split it rode in the entry
// bundle, ~40 KB of parse work every cold load for a surface most sessions
// never open.
import { lazy, Suspense, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useCommandSearch } from "@/components/command-search-context";

// Re-exported so existing imports (`from "@/components/CommandSearch"`) keep
// working; the context itself lives in its own module so the lazy dialog can
// read it without pulling this file back in.
export {
  CommandSearchContext,
  CommandSearchProvider,
  useCommandSearch,
} from "@/components/command-search-context";

const CommandSearchDialog = lazy(() => import("@/components/CommandSearchDialog"));

// ─── Main component ──────────────────────────────────────────────────────────
// Renders nothing (and downloads nothing) until the palette is first opened.
// Once opened it stays mounted so Radix's close animation still runs and the
// chunk isn't re-requested on every subsequent ⌘K.
export function CommandSearch() {
  const { open } = useCommandSearch();
  const [everOpened, setEverOpened] = useState(false);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <CommandSearchDialog />
    </Suspense>
  );
}

// ─── Header Search Button ────────────────────────────────────────────────────

export function CommandSearchTrigger() {
  const { setOpen } = useCommandSearch();

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex items-center gap-1.5 h-8 rounded-md border border-border bg-background/60 hover:bg-accent hover:text-accent-foreground px-2 text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="button-command-search-trigger"
      aria-label="Open search (⌘K)"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden sm:inline text-xs">Search</span>
      <kbd className="hidden sm:inline-flex pointer-events-none h-4 select-none items-center gap-1 rounded border bg-muted px-1 font-mono text-xs font-medium text-muted-foreground">
        ⌘K
      </kbd>
    </button>
  );
}
