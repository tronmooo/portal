// A skeleton must never be the permanent state (stuck-skeleton fix,
// 2026-07-16). Wrap any loading placeholder in this guard: while `active`
// it renders the skeleton children; if `active` persists past `deadlineMs`
// it swaps in a visible "taking too long — Retry / Refresh" card. Retry
// first cancels wedged in-flight requests (React Query refuses to restart
// a query it believes is still fetching — the orphaned-fetch-on-resume
// trap), then refetches everything on screen.
//
// SELF-HEAL (2026-07-21, BUG resume-after-overnight): the common wedge (an
// orphaned fetch after a PWA freeze) is exactly what recoverWedgedQueries
// fixes — requiring a manual tap for it was pure friction. When the deadline
// first fires the guard now runs ONE automatic recoverWedgedQueries()+onRetry
// pass itself, showing the card with a spinner note while it waits; only if
// that attempt doesn't clear `active` within another window do the manual
// Retry / Refresh buttons take over as the visible state.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { recoverWedgedQueries } from "@/lib/queryClient";

// How long the automatic attempt gets before the card stops claiming to be
// "retrying automatically" and rests on the manual buttons.
const AUTO_RETRY_WINDOW_MS = 10_000;

export function StuckLoadingGuard({
  active,
  // 20s: the honest COLD load of the heaviest tabs is ~4-12s+ — a deadline
  // below that fired while the request was still legitimately working
  // (2026-08-17 report), and the old auto-recovery then cancelled it.
  deadlineMs = 20_000,
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
  // idle → skeleton within deadline; auto → deadline hit, automatic recovery
  // attempt in flight; stuck → auto attempt didn't clear `active`, manual card.
  const [phase, setPhase] = useState<"idle" | "auto" | "stuck">("idle");
  // Latest onRetry without re-arming timers when callers pass inline arrows.
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  useEffect(() => {
    if (!active) { setPhase("idle"); return; }
    if (phase === "idle") {
      const t = setTimeout(() => {
        // Deadline hit: attempt ONE automatic recovery before demanding a tap.
        // "deadline" mode never cancels an in-flight fetch — a slow request
        // that was about to land must be allowed to land, not restarted cold.
        setPhase("auto");
        void recoverWedgedQueries("deadline");
        onRetryRef.current?.();
      }, deadlineMs);
      return () => clearTimeout(t);
    }
    if (phase === "auto") {
      const t = setTimeout(() => setPhase("stuck"), AUTO_RETRY_WINDOW_MS);
      return () => clearTimeout(t);
    }
    // phase === "stuck": rest on the manual card until `active` clears.
  }, [active, phase, deadlineMs]);

  if (active && phase !== "idle") {
    return (
      <div className="p-4">
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 flex flex-col items-center gap-2 text-center" data-testid="stuck-loading-guard">
          <p className="text-sm text-muted-foreground">This is taking too long to load.</p>
          {phase === "auto" && (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="stuck-loading-auto-retry">
              <span className="h-3 w-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              Retrying automatically…
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" data-testid="stuck-loading-retry"
              onClick={() => { setPhase("idle"); void recoverWedgedQueries(); onRetryRef.current?.(); }}>Retry</Button>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Refresh</Button>
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
