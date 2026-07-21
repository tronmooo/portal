// ─── Shared delete-undo pattern ─────────────────────────────────────
// QA P2 "Undo: Toast Undo restores row": after a destructive delete the
// confirmation toast must carry an Undo action for ~5-8s, and tapping it
// must restore the row near-instantly (<~300ms perceived).
//
// Two building blocks, used by finance / tasks / habits / trackers:
//
//   showUndoToast()   — the toast itself. Uniform title + "Undo" action.
//   recreateDeleted() — generic "restore by re-creating via the existing
//                       POST endpoint" undo for entities the server hard
//                       deletes (expenses, incomes, paychecks, tracker
//                       entries). Optimistically re-inserts the captured
//                       record into the cached lists first (instant), then
//                       re-POSTs and lets the cache-bus refetch swap in the
//                       server truth (fresh id etc).
//
// Entities with a server-side soft-delete + restore endpoint (tasks,
// habits) pass their restore mutation as `onUndo` directly — re-creating
// those client-side would lose server-kept children (checkins, history).

import { toast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { apiRequest, queryClient } from "./queryClient";
import { invalidateDomains, type Domain } from "./cache-bus";
import { formatApiError } from "./formatError";

export interface UndoToastOptions {
  title: string;
  description?: string;
  /** Invoked (once) when the user taps Undo. Return value/promise ignored. */
  onUndo: () => unknown;
}

/**
 * Delete-confirmation toast with an Undo action.
 *
 * Timing note: hooks/use-toast.ts auto-dismisses default-variant toasts
 * after 4s and destructive ones after 8s — there is no per-toast duration
 * knob. The undo window must be ~5-8s, so we ride the destructive (8s)
 * timer but restore the default visual style via `className`: the Toast
 * root merges `cn(toastVariants({variant}), className)`, and
 * tailwind-merge lets our later border/bg/text classes win over the
 * destructive ones. Net effect: a normal-looking toast that stays up 8s.
 */
export function showUndoToast({ title, description, onUndo }: UndoToastOptions) {
  let undone = false;
  return toast({
    title,
    description,
    variant: "destructive", // 8s auto-dismiss window (see note above)
    className: "border-border bg-background text-foreground",
    action: (
      <ToastAction
        altText="Undo"
        data-testid="toast-undo"
        onClick={() => {
          if (undone) return; // double-tap guard
          undone = true;
          void Promise.resolve()
            .then(() => onUndo())
            .catch(() => {
              /* onUndo surfaces its own error toast */
            });
        }}
      >
        Undo
      </ToastAction>
    ),
  });
}

export interface RecreateDeletedOptions {
  /** POST endpoint that re-creates the record (the existing create route). */
  url: string;
  /** Create payload — server-generated fields (id/createdAt/computed) stripped. */
  body: Record<string, unknown>;
  /** Cache-bus domains to invalidate once the re-create settles. */
  domains: Domain[];
  /**
   * queryKey[0] of the cached lists to patch optimistically (e.g.
   * "/api/expenses" — matches every scoped variant of that list).
   */
  queryKeyHead?: string;
  /**
   * Re-inserts the captured record into one cached list value. Receives the
   * current cached data (any shape); return it unchanged if not applicable.
   * The re-inserted row keeps its OLD id — the invalidation refetch right
   * after the POST replaces it with the server row (fresh id).
   */
  applyOptimistic?: (old: any) => any;
  successTitle?: string;
  errorTitle?: string;
}

/**
 * Restore a hard-deleted record by re-creating it through the existing
 * create endpoint. Returns the created record (parsed JSON) or null.
 */
export async function recreateDeleted<T = any>({
  url,
  body,
  domains,
  queryKeyHead,
  applyOptimistic,
  successTitle,
  errorTitle,
}: RecreateDeletedOptions): Promise<T | null> {
  // 1. Instant optimistic restore — the row is back before the network call.
  if (queryKeyHead && applyOptimistic) {
    try {
      await queryClient.cancelQueries({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === queryKeyHead,
      });
      queryClient.setQueriesData(
        { predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === queryKeyHead },
        (old: any) => {
          const next = applyOptimistic(old);
          return next === undefined ? old : next;
        }
      );
    } catch {
      /* optimistic step is best-effort — the POST + refetch below is truth */
    }
  }

  // 2. Re-create on the server, then let the cache bus refetch the truth
  //    (success: swaps the optimistic row for the real one; failure: removes
  //    the optimistic row again).
  try {
    const res = await apiRequest("POST", url, body);
    const created = await res.json().catch(() => null);
    toast({ title: successTitle ?? "Restored" });
    return (created ?? null) as T | null;
  } catch (err: any) {
    toast({
      title: errorTitle ?? "Couldn't restore",
      description: formatApiError(err),
      variant: "destructive",
    });
    return null;
  } finally {
    void invalidateDomains(...domains);
  }
}
