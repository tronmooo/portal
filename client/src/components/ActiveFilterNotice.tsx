// ─── Rule 4: a filter cannot masquerade as deletion ─────────────────────────
//
// Two pieces every filtered list uses:
//   · ActiveFilterNotice — "Showing 1 of 5 assets · Has children · Clear",
//     rendered whenever a presentation filter is hiding rows, so the screen
//     always says WHY it holds fewer records than the account does;
//   · FilteredEmptyState — the empty state for "records exist, the filter
//     hides all of them", which must never read "No assets yet".
//
// See client/src/lib/view-filters.ts for the rules these render.
import { FilterX } from "lucide-react";
import { filterSummary } from "@/lib/view-filters";

export interface ActiveFilterNoticeProps {
  shown: number;
  total: number;
  noun: { one: string; many: string };
  /** Labels of the active filters ("Has children", "Vehicles"). */
  labels: string[];
  onClear: () => void;
  testId?: string;
}

export function ActiveFilterNotice({ shown, total, noun, labels, onClear, testId = "active-filter-notice" }: ActiveFilterNoticeProps) {
  if (labels.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs"
      data-testid={testId}
      role="status"
    >
      <span className="text-muted-foreground">
        {filterSummary(shown, total, noun)} · filtered by <span className="font-medium text-foreground">{labels.join(", ")}</span>
      </span>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium text-primary hover:bg-primary/10"
        data-testid={`${testId}-clear`}
      >
        <FilterX className="h-3 w-3" /> Clear filter
      </button>
    </div>
  );
}

export interface FilteredEmptyStateProps {
  total: number;
  noun: { one: string; many: string };
  labels: string[];
  onClear: () => void;
  testId?: string;
}

export function FilteredEmptyState({ total, noun, labels, onClear, testId = "filtered-empty-state" }: FilteredEmptyStateProps) {
  return (
    <div className="bubble p-6 text-center space-y-2" data-testid={testId}>
      <FilterX className="h-7 w-7 text-muted-foreground/50 mx-auto" />
      <p className="text-sm text-muted-foreground">
        No {noun.many} match {labels.length === 1 ? "this filter" : "these filters"}
        {labels.length > 0 ? <> (<span className="font-medium text-foreground">{labels.join(", ")}</span>)</> : null}.
      </p>
      <p className="text-xs text-muted-foreground">
        {total} {total === 1 ? noun.one : noun.many} {total === 1 ? "is" : "are"} hidden, not deleted.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-1 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        data-testid={`${testId}-clear`}
      >
        <FilterX className="h-3 w-3" /> Clear filter
      </button>
    </div>
  );
}
