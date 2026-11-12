// "The request failed" is not "you have nothing" (CLAUDE.md rule 7).
//
// Rule 7 already forbids a queryFn from turning a failure into `[]`. This is
// the other half: a page whose list query FAILED with nothing cached must not
// fall through to its "No trackers yet — create your first one" empty state.
// On 2026-11-12, with the API unreachable on a fresh load, nine pages did
// exactly that: Trackers, the Linked hub, Liabilities, Profiles ("0 profiles ·
// No profiles yet"), Bills, Artifacts, Wellness, Settings and part of the
// dashboard. To a user that reads as "my data is gone".
//
// `useLoadFailed(...endpoints)` answers one question for an empty state: did
// any query that feeds this list fail without ever producing data? It reads
// the query cache by endpoint, so a page does not have to thread `isError`
// from each of its hooks down to the place the empty text is rendered.
import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const feeds = (q: Query, endpoints: readonly string[]) => {
  const head = q.queryKey?.[0];
  return typeof head === "string" && endpoints.includes(head);
};
/** Failed, and there is no earlier good answer to keep showing. */
const failedCold = (q: Query) => q.state.status === "error" && q.state.data === undefined;

export function useLoadFailed(...endpoints: string[]): { failed: boolean; retry: () => void } {
  const queryClient = useQueryClient();
  const key = endpoints.join("|");
  const subscribe = useCallback((onChange: () => void) => queryClient.getQueryCache().subscribe(onChange), [queryClient]);
  const snapshot = useCallback(
    () => queryClient.getQueryCache().getAll().some((q) => q.getObserversCount() > 0 && feeds(q, endpoints) && failedCold(q)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, key],
  );
  const failed = useSyncExternalStore(subscribe, snapshot, () => false);
  const retry = useCallback(() => {
    void queryClient.refetchQueries({ predicate: (q) => feeds(q, endpoints) && q.state.status === "error" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, key]);
  return { failed, retry };
}

/** What a list shows instead of its empty state when its data could not be loaded. */
export function LoadFailed({ onRetry, what = "this", className, compact = false }: {
  onRetry: () => void;
  /** What could not be loaded, in the sentence "Couldn't load <what>": "your trackers". */
  what?: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={className ?? (compact ? "py-3 text-center" : "p-6 text-center")} role="alert" data-testid="load-failed">
      {!compact && <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" aria-hidden="true" />}
      <p className={compact ? "text-xs text-destructive" : "text-sm text-destructive"}>Couldn't load {what}</p>
      <p className="text-xs text-muted-foreground mt-1">Nothing was deleted — the app could not reach your data.</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} data-testid="load-failed-retry">Retry</Button>
    </div>
  );
}
