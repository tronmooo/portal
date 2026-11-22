// The Dismissed list: what the user told the dashboard to stop showing, and
// the way to bring any of it back.
//
// A dismissal hides an alert; it does not resolve anything or change a record
// (Rule 8). Hiding with no way back reads as deletion (Rule 4), so every
// dismissed alert that would otherwise be showing is listed here with Restore.
// The list is derived by the server from the records and the stored ids
// (GET /api/notifications/dismissed); opening it writes nothing (Rule 3).
import { RotateCcw } from "lucide-react";
import { useDismissedAlertList, useDismissedAlerts } from "@/hooks/useDismissedAlerts";

export function DismissedAlertsList() {
  const { data, isPending, isError, refetch } = useDismissedAlertList(true);
  const { restore } = useDismissedAlerts(true);
  return (
    <div className="bubble px-3 py-2.5 space-y-1.5" data-testid="dismissed-alerts">
      <p className="micro-label text-muted-foreground">
        Dismissed{data && data.length > 0 ? ` · ${data.length}` : ""}
      </p>
      {isPending ? (
        <p className="text-[11px] text-muted-foreground" data-testid="dismissed-alerts-loading">Loading…</p>
      ) : isError ? (
        <p className="text-[11px] text-destructive flex items-center justify-between gap-2" data-testid="dismissed-alerts-error">
          <span>Couldn't load what you dismissed.</span>
          <button type="button" onClick={() => refetch()} className="underline font-medium">Retry</button>
        </p>
      ) : data.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="dismissed-alerts-empty">
          Nothing dismissed. An alert you dismiss is listed here so you can bring it back.
        </p>
      ) : (
        <ul className="space-y-1">
          {data.map((a) => (
            <li key={a.id} className="flex items-center gap-2 min-w-0" data-testid={`dismissed-alert-${a.id}`}>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-semibold leading-tight truncate">{a.title}</p>
                {a.message && <p className="text-[11px] text-muted-foreground leading-tight truncate">{a.message}</p>}
              </div>
              <button
                type="button"
                onClick={() => restore.mutate([a.id])}
                disabled={restore.isPending}
                data-testid={`dismissed-alert-restore-${a.id}`}
                aria-label={`Restore — ${a.title}`}
                className="touch-hit shrink-0 inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DismissedAlertsList;
