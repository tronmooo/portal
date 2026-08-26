// Level 3 header: what will HAPPEN, in counts.
//
// The sentence itself is built by `summarizeActions` in the shared module, not
// assembled here, so its exact wording is pinned by a unit test rather than
// living in JSX where nothing can assert on it.

import { Zap } from "lucide-react";
import { summarizeActions, type ProposedAction } from "@shared/extraction-actions";

export function ProposedActions({ actions }: { actions: ProposedAction[] }) {
  const live = actions.filter((a) => a.selected && a.operation !== "NO_ACTION");
  const flagged = actions.filter((a) => a.savable !== false && a.warnings.some((w) => w.blocking));
  // Counted apart from everything else: these were understood and will not be
  // written, and folding them into "12 actions" would overstate what Save does.
  const unsavable = actions.filter((a) => a.savable === false);

  return (
    <div className="px-2.5 py-1.5 bg-muted/40 border-b border-border/60" data-testid="proposed-actions">
      <div className="flex items-center gap-1.5">
        <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="micro-label text-muted-foreground">Proposed actions</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{live.length}</span>
      </div>
      <div className="text-[11px] text-foreground leading-tight mt-0.5" data-testid="proposed-actions-summary">
        {summarizeActions(actions)}
      </div>
      {unsavable.length > 0 && (
        <div
          className="text-[11px] leading-tight text-muted-foreground mt-0.5"
          data-testid="proposed-actions-unsavable"
        >
          {unsavable.length} inferred {unsavable.length === 1 ? "action has" : "actions have"} no save destination in this app — shown below with the reason
        </div>
      )}
      {flagged.length > 0 && (
        <div
          className="text-[11px] leading-tight text-amber-700 dark:text-amber-400 mt-0.5"
          data-testid="proposed-actions-flagged"
        >
          {flagged.length} need{flagged.length === 1 ? "s" : ""} a decision before it can be saved
        </div>
      )}
    </div>
  );
}
