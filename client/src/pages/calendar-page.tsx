import { useEffect, useState, useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import CalendarView from "@/components/CalendarView";
// The Recurring & Important Dates screen: category chips + Rules/Upcoming
// views, all fed
// by the one occurrence engine. Replaces the old manager, which ran recurring
// RULES and generated OCCURRENCES together as a single scroll.
import { RecurringDatesPage } from "@/components/recurring/RecurringDatesPage";
import { SeriesDialogHost } from "@/components/recurring/RecurringDatesManager";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useRecordHighlight } from "@/hooks/useRecordHighlight";
import type { ProfileSelection } from "@shared/profile-selection";
import { canonicalTimelineWindow, timelineQueryKey, timelineUrl } from "@shared/calendar-window";
import { rollupOccurrences } from "@shared/dated-items";
import type { CalendarOccurrence, OccurrenceKind } from "@shared/calendar-occurrences";
import { ArrowLeft, Calendar as CalendarBlank, CalendarDays, CalendarRange, Repeat } from "lucide-react";
import { Link } from "wouter";

import { ScopeFilterNotice } from "@/components/ActiveFilterNotice";
import { scopeLabel } from "@/lib/profileFilter";

export default function CalendarPage() {
  useEffect(() => { document.title = "Calendar — Portol"; }, []);
  // The calendar's person filter is LOCAL (QA 2026-09-18 F-03). It starts from
  // the active scope and follows it until the user touches the picker here;
  // from then on it is this page's own selection and never writes the global
  // store — adding Dana on the calendar used to re-scope the whole dashboard.
  const globalScope = useProfileScope();
  const [localScope, setLocalScope] = useState<ProfileSelection | null>(null);
  const filterMode = (localScope ?? globalScope).mode;
  const filterIds = (localScope ?? globalScope).selectedIds;
  // Calendar | Recurring tab. ?tab=recurring deep-links to the manager.
  const [tab, setTab] = useState<"calendar" | "recurring">(() => {
    try { return new URL(window.location.href).searchParams.get("tab") === "recurring" ? "recurring" : "calendar"; } catch { return "calendar"; }
  });
  // Rules 23/24: `?highlight=event:<id>` — CalendarView selects the day and
  // opens the event itself (manual: the row only exists once it has).
  const highlight = useRecordHighlight("event", { manual: true, onHighlight: () => setTab("calendar") });

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
  // The window edges are `rollupOccurrences`' business now, not this page's.
  const todayStr = new Date().toLocaleDateString("en-CA");
  // [PERF 2026-07-31] Fetch the CANONICAL window (shared/calendar-window.ts) —
  // the same key the dashboard bootstrap seeds and the month grid reads, so
  // this query is a cache hit on app open instead of a guaranteed cold fetch.
  // The tiles then count within their narrower ranges client-side.
  // NOTE: no `.catch(() => [])` — a swallowed failure used to cache an empty
  // success and render "0 / 0 / 0" as if the calendar were truly empty.
  const timelineWindow = useMemo(() => canonicalTimelineWindow(todayStr), [todayStr]);
  const { data: timeline = [] } = useQuery<any[]>({
    queryKey: timelineQueryKey(timelineWindow, filterMode, filterIds),
    queryFn: () =>
      apiRequest("GET", timelineUrl(timelineWindow, filterMode, filterIds)).then(r => r.json()),
    staleTime: 60_000,
  });
  // The bucketing itself is `rollupOccurrences` (shared/dated-items) — the same
  // function the Executive Dashboard reads, so the tiles here and the cards
  // there can no longer disagree about one window. This loop used to live
  // inline, which is how three surfaces ended up with three answers.
  const evSummary = useMemo(() => {
    const list = (Array.isArray(timeline) ? timeline : []).map((item: any) => ({
      kind: (item?.type || "event") as OccurrenceKind,
      date: String(item?.date || "").slice(0, 10),
      effectiveDate: String(item?.date || "").slice(0, 10),
      status: item?.completed ? "done" : "upcoming",
    })) as unknown as CalendarOccurrence[];
    const r = rollupOccurrences(list, todayStr);
    return { today: r.today, week: r.next7, horizon: r.next30 };
  }, [timeline, todayStr]);

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
          value={localScope ?? { mode: globalScope.mode, selectedIds: globalScope.selectedIds, selectedNames: globalScope.selectedNames }}
          onChange={(next) => setLocalScope({ mode: next.mode, selectedIds: [...next.selectedIds], selectedNames: [...next.selectedNames] })}
          compact
        />
      </div>
      {/* Rule 4: a scoped calendar says so. Clearing here is the calendar's
          own choice (F-03) — it never re-scopes the rest of the app. */}
      {filterMode === "selected" && filterIds.length > 0 && (
        <div className="mb-2">
          <ScopeFilterNotice
            label={scopeLabel((localScope ?? globalScope).selectedNames, filterMode, filterIds.length)}
            what="tasks and events"
            onClear={() => setLocalScope({ mode: "everyone", selectedIds: [], selectedNames: [] })}
            testId="calendar-scope-notice"
          />
        </div>
      )}

      {/* Calendar | Recurring & Important Dates tab toggle. The active tab is
          the solid cyan control from the owner's reference (2026-11-21). */}
      <div className="cal-seg p-1 mb-3" data-testid="calendar-tabs">
        {([["calendar", "Calendar", CalendarDays], ["recurring", "Recurring & Important", Repeat]] as const).map(([key, label, Icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`flex-1 rounded-full h-10 px-2 text-[13px] sm:text-sm inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors ${tab === key ? "cal-cta font-bold" : "font-medium text-foreground/85 hover:text-foreground"}`}
            data-testid={`calendar-tab-${key}`}>
            <Icon className="h-4 w-4 shrink-0" /> {label}
          </button>
        ))}
      </div>

      {tab === "calendar" ? (
        <>
          {/* Summary band: each tile is washed in its own colour, with the
              count and the icon in that colour. Number first, then the label:
              the order the tiles are read (and tested) in. */}
          <div className="grid grid-cols-3 gap-2 mb-3" data-testid="calendar-summary">
            {[
              { label: "Today", value: evSummary.today, color: "205 95% 60%", Icon: CalendarBlank },
              { label: "This Week", value: evSummary.week, color: "262 90% 70%", Icon: CalendarRange },
              { label: "Next 30 Days", value: evSummary.horizon, color: "152 72% 52%", Icon: CalendarDays },
            ].map(s => (
              <div key={s.label} className="cal-stat flex items-center gap-2 px-2.5 py-3 sm:px-4 min-w-0"
                style={{ "--accent-hsl": s.color } as CSSProperties}>
                <s.Icon className="h-6 w-6 shrink-0" style={{ color: `hsl(${s.color})` }} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-2xl font-bold tabular-nums leading-none" style={{ color: `hsl(${s.color})` }}>{s.value}</p>
                  <p className="mt-1 text-xs text-foreground/85 leading-tight">{s.label}</p>
                </div>
              </div>
            ))}
          </div>

          <CalendarView externalFilterIds={filterIds} externalFilterMode={filterMode} highlightSourceId={highlight?.id ?? null} />
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
