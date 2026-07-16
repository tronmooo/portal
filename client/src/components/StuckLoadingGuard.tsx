// A skeleton must never be the permanent state (stuck-skeleton fix,
// 2026-07-16). Wrap any loading placeholder in this guard: while `active`
// it renders the skeleton children; if `active` persists past `deadlineMs`
// it swaps in a visible "taking too long — Retry / Refresh" card. Retry
// first cancels wedged in-flight requests (React Query refuses to restart
// a query it believes is still fetching — the orphaned-fetch-on-resume
// trap), then refetches everything on screen.
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { recoverWedgedQueries } from "@/lib/queryClient";

export function StuckLoadingGuard({
  active,
  deadlineMs = 12_000,
  onRetry,
  children,
}: {
  /** True while the loading placeholder is showing. */
  active: boolean;
  deadlineMs?: number;
  /** Extra retry work (e.g. the page query's refetch()). recoverWedgedQueries always runs. */
  onRetry?: () => void;
  children: ReactNode;
}) {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!active) { setStuck(false); return; }
    const t = setTimeout(() => setStuck(true), deadlineMs);
    return () => clearTimeout(t);
  }, [active, deadlineMs]);

  if (active && stuck) {
    return (
      <div className="p-4">
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 flex flex-col items-center gap-2 text-center" data-testid="stuck-loading-guard">
          <p className="text-sm text-muted-foreground">This is taking too long to load.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" data-testid="stuck-loading-retry"
              onClick={() => { setStuck(false); void recoverWedgedQueries(); onRetry?.(); }}>Retry</Button>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Refresh</Button>
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
