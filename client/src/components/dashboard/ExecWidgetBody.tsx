// The inside of a custom Executive card (shared/exec-widgets).
//
// A widget stores no data: it reads the same lists every other screen reads,
// under those endpoints' query keys, so the cache bus invalidates it with them
// (Rule 2) and it can never disagree with them (Rule 1).
// A failed read is an error with a retry, never "nothing here" (Rule 7).
import { useQueries } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { buildWidgetView, widgetNeeds, type ExecWidget, type WidgetData } from "@shared/exec-widgets";

const ENDPOINT: Record<keyof WidgetData, string> = {
  profiles: "/api/profiles", trackers: "/api/trackers", expenses: "/api/expenses", journal: "/api/journal",
  notes: "/api/notes", tasks: "/api/tasks", goals: "/api/goals", habits: "/api/habits",
};

export function ExecWidgetBody({ widget, mode = "everyone", ids = [], todayISO, accent, preview = false }: {
  widget: ExecWidget;
  /** The profile scope, exactly as the Executive tab passes it to its own lists. */
  mode?: string; ids?: string[];
  todayISO: string;
  accent: string;
  /** In the Customize dialog: rows are not links. */
  preview?: boolean;
}) {
  const [, navigate] = useLocation();
  const needs = widgetNeeds(widget);
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const results = useQueries({
    queries: needs.map((k) => ({
      // Its own cache slot (the trailing "widget"), still under the endpoint's
      // key so the cache bus invalidates it with the domain: another reader of
      // the same endpoint may keep a different shape in its slot.
      queryKey: [ENDPOINT[k], mode, ...ids, "widget"],
      queryFn: async () => {
        const data = await apiRequest("GET", `${ENDPOINT[k]}${param}`).then((r) => r.json());
        if (!Array.isArray(data)) throw new Error("Unexpected response");
        return data as any[];
      },
      staleTime: 60_000,
    })),
  });
  const failed = results.some((r) => r.isError && r.data === undefined);
  const loading = !failed && results.some((r) => r.data === undefined);
  if (failed) {
    return (
      <p className="text-[12px] text-destructive flex items-center justify-between gap-2" data-testid={`exec-widget-error-${widget.id}`}>
        <span>Couldn't load this card.</span>
        <button type="button" className="underline font-medium" onClick={() => results.forEach((r) => r.isError && r.refetch())}>Retry</button>
      </p>
    );
  }
  if (loading) return <p className="text-[12px] text-muted-foreground" data-testid={`exec-widget-loading-${widget.id}`}>Loading…</p>;

  const data: WidgetData = {};
  needs.forEach((k, i) => { data[k] = results[i].data as any[]; });
  const view = buildWidgetView(widget, data, todayISO);
  return (
    <div data-testid={`exec-widget-body-${widget.id}`}>
      {view.headline && (
        <div className="bubble-row px-2 py-1 mb-1.5 inline-flex items-baseline gap-2" style={{ ["--accent-hsl" as any]: accent }}>
          <span className="micro-label text-muted-foreground">{view.headline.label}</span>
          <span className="text-[13px] font-bold tabular-nums">{view.headline.value}</span>
        </div>
      )}
      {view.rows.length === 0 ? (
        <p className="text-[12px] text-muted-foreground" data-testid={`exec-widget-empty-${widget.id}`}>
          Nothing to show for this card yet{mode === "selected" && ids.length > 0 ? " — a profile filter is on, so other people's items are hidden, not deleted" : ""}.
        </p>
      ) : (
        <div className="space-y-1">
          {view.rows.map((r) => (
            <div key={r.key}
              role={preview ? undefined : "button"} tabIndex={preview ? undefined : 0}
              onClick={preview || !r.href ? undefined : () => navigate(r.href!)}
              onKeyDown={preview || !r.href ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(r.href!); } }}
              className={`bubble-row flex items-center gap-2 px-2 py-1.5 min-w-0 ${preview ? "" : "cursor-pointer"}`}
              style={{ ["--accent-hsl" as any]: accent }}
              data-testid={`exec-widget-row-${r.key}`}>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold leading-tight truncate">{r.title}</p>
                {r.sub && <p className="text-[11px] text-muted-foreground leading-tight truncate mt-0.5">{r.sub}</p>}
              </div>
              {r.right && <span className="shrink-0 text-[13px] font-bold tabular-nums">{r.right}</span>}
            </div>
          ))}
          {view.total > view.rows.length && (
            <p className="text-[11px] text-muted-foreground px-1">+{view.total - view.rows.length} more</p>
          )}
        </div>
      )}
    </div>
  );
}

export default ExecWidgetBody;
