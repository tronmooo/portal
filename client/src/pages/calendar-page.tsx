import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import CalendarView from "@/components/CalendarView";
// The Recurring Dates screen: category chips + Rules/Upcoming views, all fed
// by the one occurrence engine. Replaces the old manager, which ran recurring
// RULES and generated OCCURRENCES together as a single scroll.
import { RecurringDatesPage } from "@/components/recurring/RecurringDatesPage";
import { SeriesDialogHost } from "@/components/recurring/RecurringDatesManager";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileScope } from "@/hooks/useProfileScope";
import { ArrowLeft, CalendarDays, Repeat } from "lucide-react";
import { Link } from "wouter";

export default function CalendarPage() {
  useEffect(() => { document.title = "Calendar — Portol"; }, []);
  // Single source of truth: active scope read reactively.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  // Calendar | Recurring tab. ?tab=recurring deep-links to the manager.
  const [tab, setTab] = useState<"calendar" | "recurring">(() => {
    try { return new URL(window.location.href).searchParams.get("tab") === "recurring" ? "recurring" : "calendar"; } catch { return "calendar"; }
  });

  // ── Today / This Week / Total summary band ────────────────────────────────
  //
  // These tiles MUST count exactly what the grid below them shows. They used to
  // read `/api/events` while <CalendarView> reads `/api/calendar/timeline` —
  // two different datasets. Events is only the hand-entered calendar table;
  // the timeline is the merged stream (events + bills and loan payments +
  // tasks + reminders + document expirations). QA report 2026-07-29 (UX-001):
  // the TODAY tile read 0 while the Day view for the same date listed two auto
  // loan obligations. Both numbers came from working code; having two sources
  // for one question was the bug.
  //
  // One source now, with the same date window and the same scope parameter the
  // grid uses, so "TODAY: 0" can only mean the day is genuinely empty.
  // The third tile used to read "Total" — the row count of /api/events, a number
  // with no window and no relationship to what was on screen. It is now the
  // 30-day horizon, which is answerable and comes from the same fetch.
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `&profileIds=${filterIds.join(",")}` : "";
  const todayStr = new Date().toLocaleDateString("en-CA");
  const addDays = (n: number) => {
    const d = new Date(`${todayStr}T12:00:00`);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString("en-CA");
  };
  const weekEndStr = useMemo(() => addDays(7), [todayStr]);
  const horizonEndStr = useMemo(() => addDays(30), [todayStr]);
  const { data: timeline = [] } = useQuery<any[]>({
    queryKey: ["/api/calendar/timeline", todayStr, horizonEndStr, filterMode, ...filterIds],
    queryFn: () =>
      apiRequest("GET", `/api/calendar/timeline?start=${todayStr}&end=${horizonEndStr}${profileParam}`)
        .then(r => r.json())
        .catch(() => []),
    staleTime: 60_000,
  });
  const evSummary = useMemo(() => {
    const list = Array.isArray(timeline) ? timeline : [];
    let today = 0, week = 0;
    for (const item of list) {
      const d = String(item?.date || "").slice(0, 10);
      if (!d) continue;
      if (d === todayStr) today++;
      if (d >= todayStr && d <= weekEndStr) week++; // YYYY-MM-DD sorts lexically
    }
    return { today, week, horizon: list.length };
  }, [timeline, todayStr, weekEndStr]);

  // Legacy cleanup: strip old ?tab=obligations links (that tab is retired).
  // ?tab=recurring is the Recurring Dates manager and is kept.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("tab") && url.searchParams.get("tab") !== "recurring") {
        url.searchParams.delete("tab");
        window.history.replaceState(null, "", url.toString());
      }
    } catch {}
  }, []);

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="calendar-page">
      <div className="flex items-center gap-2 mb-2">
        <Link href="/dashboard" className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" aria-label="Back to Dashboard" data-testid="button-back">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Dashboard</span>
        </Link>
        <MultiProfileFilter
          onChange={() => {}}
          compact
        />
      </div>

      {/* Calendar | Recurring Dates tab toggle */}
      <div className="flex gap-1 rounded-xl bg-muted/50 p-1 mb-2" data-testid="calendar-tabs">
        {([["calendar", "Calendar", CalendarDays], ["recurring", "Recurring Dates", Repeat]] as const).map(([key, label, Icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors ${tab === key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            data-testid={`calendar-tab-${key}`}>
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === "calendar" ? (
        <>
          {/* v2 summary band */}
          <div className="grid grid-cols-3 gap-2 mb-2" data-testid="calendar-summary">
            {[
              { label: "Today", value: evSummary.today, color: "200 80% 55%" },
              { label: "This Week", value: evSummary.week, color: "262 70% 62%" },
              { label: "Next 30 Days", value: evSummary.horizon, color: "155 60% 48%" },
            ].map(s => (
              <div key={s.label} className="bubble p-2.5 text-center">
                <p className="text-lg font-bold tabular-nums leading-none" style={{ color: `hsl(${s.color})` }}>{s.value}</p>
                <p className="mt-1 micro-label text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>

          <CalendarView externalFilterIds={filterIds} externalFilterMode={filterMode} />
        </>
      ) : (
        <SeriesDialogHost>
          {(openAdd) => (
            <RecurringDatesPage
              filterIds={filterIds}
              filterMode={filterMode as any}
              onAddRecurring={openAdd}
            />
          )}
        </SeriesDialogHost>
      )}
    </div>
  );
}
