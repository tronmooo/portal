// The Wellness tab (owner's redesign, 2026-11-23): "how am I doing over time?"
//
// A customizable dashboard of cards over a time range — the same system the
// Executive tab runs on (shared/dashboard-engine): several named dashboards,
// each its own layout over one set of built-in cards and the cards the user
// built. Which cards show, their order and size, the dashboards and the
// display options are one preference row on the account
// (shared/wellness-dashboards).
//
// What this component holds to:
//   - Rule 1: every figure comes from shared/wellness-cards or
//     shared/wellness-widgets over the subject's records; nothing is computed
//     here.
//   - Rule 3: opening the tab writes nothing. Picking a range changes the view
//     only (the stored default is set in Customize). The dashboard chips
//     switch the active dashboard, and say so.
//   - Rule 4: nothing hidden reads as missing — a card the layout hides is
//     named under the grid and opens in place; a card with nothing recorded
//     folds into a named quiet row; a range with no reading names the last.
//   - Rule 7: a list that failed to load is an error with a retry.
//   - One subject: health data never blends two people (pages/wellness.tsx).
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Moon, Plus, Settings, Sparkles, Utensils } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { isWidgetCardId, lonelyMediumCards, widgetCardId } from "@shared/dashboard-engine";
import {
  activeWellnessBoard, hiddenWellnessCards, setActiveWellnessBoard, visibleWellnessCards, wellnessCardSize, wellnessCardTitle,
  type WellnessCardId,
} from "@shared/wellness-dashboards";
import { RANGE_LABEL, RANGE_WORDS, WELLNESS_RANGES, type WellnessRange } from "@shared/wellness-period";
import {
  activitySummary, healthGoals, moodSummary, nutritionLines, overviewTiles, periodInsights, sleepLines, symptomRows, trendRows, vitalGraphs,
  type WellnessCardsInput,
} from "@shared/wellness-cards";
import { wellnessWidgetNeeds, type WellnessSourceData } from "@shared/wellness-widgets";
import { anySourceConnected, type LabPanel, type MetricSeries, type SourceState, type WellnessScore } from "@shared/wellness-readout";
import {
  ScoreCard, Section, T, WellnessBodySection, WellnessCareSection, WellnessLabsSection, WellnessSourcesSection,
  type WellnessAppt, type WellnessDoc, type WellnessListItem, type WellnessMed,
} from "./WellnessOverview";
import {
  ActivitySummaryCard, CardError, GoalsCard, GraphsCard, InsightsCard, MoodCard, OverviewTilesCard, StatLinesCard, SymptomsCard, TrendsCard,
  type ListState,
} from "./WellnessCards";
import { WellnessCustomizeDialog, WellnessWidgetCardBody, useWellnessPrefs, wellnessCardIcon, type WellnessLists } from "./WellnessCustomize";

export interface WellnessDashboardProps {
  /** Whose data this is, when it is not the account holder's. */
  subjectName?: string | null;
  metrics: Map<string, MetricSeries>;
  /** The subject's trackers. */
  trackers: any[];
  /** True once the tracker list has loaded (so an empty card is really empty). */
  loaded: boolean;
  /** The tracker list failed and there is nothing to show from it. */
  failed?: boolean;
  onRetry?: () => void;
  timezone: string;
  todayISO: string;
  /** The profile scope, exactly as the page passes it to its lists. */
  mode: string;
  ids: string[];
  /** Does a record belong to the subject? (shared/wellness-readout belongsToSubject) */
  owned: (linkedProfiles?: string[] | null) => boolean;
  score: WellnessScore;
  panels: LabPanel[];
  body: LabPanel[];
  medications: WellnessMed[];
  appointments: WellnessAppt[];
  documents: WellnessDoc[];
  allergies: WellnessListItem[];
  conditions: WellnessListItem[];
  sources: SourceState;
  duplicates?: Array<{ label: string; sources: string[] }>;
  aiNarrative?: string | null;
  onAiBrief?: () => void;
  aiBriefLoading?: boolean;
}

/** One of the lists a card reads beyond trackers; its own cache slot under the endpoint's key (Rule 2). */
function useList(endpoint: string, enabled: boolean, mode: string, ids: string[]) {
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const q = useQuery<any[]>({
    queryKey: [endpoint, mode, ...ids, "wellness"],
    enabled,
    queryFn: async () => {
      const data = await apiRequest("GET", `${endpoint}${param}`).then((r) => r.json());
      if (!Array.isArray(data)) throw new Error("Unexpected response");
      return data;
    },
    staleTime: 60_000,
  });
  const state: ListState = { loading: enabled && q.data === undefined && !q.isError, error: q.isError && q.data === undefined, retry: () => { q.refetch(); } };
  return { data: q.data, state };
}

export function WellnessDashboard(p: WellnessDashboardProps) {
  const { boards, loaded: prefsLoaded, setBoards } = useWellnessPrefs();
  const [picked, setPicked] = useState<WellnessRange | null>(null);
  const [customize, setCustomize] = useState(false);
  // Cards opened in place for this visit: a hidden card being peeked at, or a quiet one unfolded.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const range = picked ?? boards.options.range;
  const words = RANGE_WORDS[range];
  const opts = boards.options;
  const board = activeWellnessBoard(boards);

  const visible = visibleWellnessCards(boards);
  const hidden = hiddenWellnessCards(boards);
  const shown = [...visible, ...hidden.filter((id) => opened.has(id))];
  const widgetOf = (id: string) => boards.widgets.find((w) => widgetCardId(w.id) === id);
  const shownWidgets = shown.map(widgetOf).filter(Boolean) as NonNullable<ReturnType<typeof widgetOf>>[];
  const needs = (k: "journal" | "expenses") => customize || shownWidgets.some((w) => wellnessWidgetNeeds(w).includes(k));

  const journal = useList("/api/journal", needs("journal") || shown.includes("mood"), p.mode, p.ids);
  const expenses = useList("/api/expenses", needs("expenses"), p.mode, p.ids);
  const goals = useList("/api/goals", shown.includes("goals"), p.mode, p.ids);
  const mine = <X extends { linkedProfiles?: string[] | null }>(xs: X[] | undefined) => (xs ? xs.filter((x) => p.owned(x?.linkedProfiles)) : undefined);
  const myJournal = useMemo(() => mine(journal.data), [journal.data, p.owned]); // eslint-disable-line react-hooks/exhaustive-deps
  const myExpenses = useMemo(() => mine(expenses.data), [expenses.data, p.owned]); // eslint-disable-line react-hooks/exhaustive-deps
  const myGoals = useMemo(() => mine(goals.data), [goals.data, p.owned]); // eslint-disable-line react-hooks/exhaustive-deps

  const input: WellnessCardsInput = useMemo(
    () => ({ metrics: p.metrics, trackers: p.trackers, range, todayISO: p.todayISO, timezone: p.timezone }),
    [p.metrics, p.trackers, range, p.todayISO, p.timezone],
  );
  const data: WellnessSourceData = useMemo(
    () => ({ metrics: p.metrics, trackers: p.trackers, journal: myJournal, expenses: myExpenses, timezone: p.timezone }),
    [p.metrics, p.trackers, myJournal, myExpenses, p.timezone],
  );
  const lists: WellnessLists = { journal: journal.state, expenses: expenses.state };

  const tiles = useMemo(() => overviewTiles(input), [input]);
  const trends = useMemo(() => trendRows(input), [input]);
  const activity = useMemo(() => activitySummary(input), [input]);
  const sleep = useMemo(() => sleepLines(input), [input]);
  const nutrition = useMemo(() => nutritionLines(input), [input]);
  const insights = useMemo(() => periodInsights(input, p.panels), [input, p.panels]);
  const symptoms = useMemo(() => symptomRows(input), [input]);
  const graphs = useMemo(() => vitalGraphs(input), [input]);
  const mood = useMemo(() => (myJournal ? moodSummary(myJournal, range, p.todayISO, p.timezone) : null), [myJournal, range, p.todayISO, p.timezone]);
  const goalRows = useMemo(() => (myGoals ? healthGoals(myGoals, p.trackers) : null), [myGoals, p.trackers]);
  const care = p.medications.length + p.appointments.length + p.documents.length + p.allergies.length + p.conditions.length;

  /** Has NOTHING ever been recorded for this card? Only then does it fold into the quiet row. */
  const nothingRecorded = (id: WellnessCardId): boolean => {
    if (!p.loaded || isWidgetCardId(id)) return false;
    switch (id) {
      case "overview": return !tiles.some((t) => t.tracked);
      case "trends": return p.metrics.size === 0;
      case "activity": return activity.lastAt == null;
      case "sleep": return sleep.length === 0;
      case "nutrition": return nutrition.length === 0;
      case "body": return p.body.length === 0;
      case "labs": return p.panels.length === 0;
      case "medications": return care === 0;
      case "insights": return p.metrics.size === 0 && activity.lastAt == null;
      case "mood": return !!mood && mood.entries === 0 && !mood.last;
      case "symptoms": return symptoms.length === 0;
      case "graphs": return p.metrics.size === 0;
      case "goals": return !!goalRows && goalRows.length === 0;
      case "score": return !(p.score.connected ?? anySourceConnected(p.sources));
      default: return false;
    }
  };
  const quiet = shown.filter((id) => nothingRecorded(id) && !opened.has(id));
  const onGrid = shown.filter((id) => !quiet.includes(id));
  const sized = onGrid.map((id) => ({ id, size: wellnessCardSize(boards, id) }));
  const lonely = lonelyMediumCards(sized);
  const open = (id: string) => setOpened((prev) => new Set(prev).add(id));

  const card = (id: WellnessCardId): ReactNode => {
    const title = wellnessCardTitle(boards, id);
    const w = widgetOf(id);
    if (w) {
      const { icon } = wellnessCardIcon(boards, id);
      return (
        <Section title={title} icon={icon} tone={T.purple} meta={w.range ? RANGE_LABEL[w.range] : undefined} testId={`wellness-card-${id}`}>
          <WellnessWidgetCardBody widget={w} data={data} lists={lists} range={range} todayISO={p.todayISO} />
          {w.by === "ai" && <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><Sparkles className="h-3 w-3" aria-hidden="true" /> Built with AI from your description</p>}
        </Section>
      );
    }
    switch (id) {
      case "overview": return <OverviewTilesCard title={title} tiles={tiles} opts={opts} words={words} />;
      case "trends": return <TrendsCard title={title} rows={trends} opts={opts} words={words} />;
      case "activity": return <ActivitySummaryCard title={title} summary={activity} label={RANGE_LABEL[range]} words={words} />;
      case "sleep": return <StatLinesCard title={title} icon={Moon} tone={T.indigo} lines={sleep} opts={opts} words={words} testId="wellness-card-sleep"
        empty="No sleep or recovery data yet. Log last night's sleep in chat, or connect a health source." />;
      case "nutrition": return <StatLinesCard title={title} icon={Utensils} tone={T.orange} lines={nutrition} opts={opts} words={words} testId="wellness-card-nutrition"
        empty={'No food or water logged yet. Tell chat what you ate or "drank 20 oz".'} />;
      case "body": return <div data-testid="wellness-card-body"><WellnessBodySection body={p.body} title={title} /></div>;
      case "labs": return <div data-testid="wellness-card-labs"><WellnessLabsSection panels={p.panels} title={title} /></div>;
      case "medications": return (
        <div data-testid="wellness-card-medications">
          <WellnessCareSection medications={p.medications} appointments={p.appointments} documents={p.documents} allergies={p.allergies} conditions={p.conditions} title={title} />
        </div>
      );
      case "sources": return <div data-testid="wellness-card-sources"><WellnessSourcesSection sources={p.sources} duplicates={p.duplicates} title={title} /></div>;
      case "insights": return <InsightsCard title={title} insights={insights} aiNarrative={p.aiNarrative} onAiBrief={p.onAiBrief} aiBriefLoading={p.aiBriefLoading} words={words} />;
      case "mood": return <MoodCard title={title} mood={mood} state={journal.state} opts={opts} words={words} />;
      case "symptoms": return <SymptomsCard title={title} rows={symptoms} words={words} />;
      case "graphs": return <GraphsCard title={title} graphs={graphs} words={words} />;
      case "goals": return <GoalsCard title={title} goals={goalRows} state={goals.state} />;
      case "score": return <div data-testid="wellness-card-score"><ScoreCard score={p.score} connected={p.score.connected ?? anySourceConnected(p.sources)} /></div>;
      default: return null;
    }
  };

  const chipCls = (on: boolean) => `shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold ${on ? "text-white" : "border border-border text-muted-foreground hover:bg-muted"}`;
  const chipOn = { background: `hsl(${T.purple} / 0.35)`, boxShadow: `inset 0 0 0 1px hsl(${T.purple} / 0.7)` };

  return (
    <div className="space-y-3 td-scope" data-testid="wellness-dashboard" data-range={range} data-dashboard={board.id}>
      {/* Dashboards: each chip SWITCHES which Wellness dashboard is showing (saved to your account). */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar" data-swipe-ignore data-testid="wellness-boards">
        {boards.dashboards.map((d) => (
          <button key={d.id} type="button" aria-pressed={d.id === board.id} title={`Show the ${d.name} dashboard`}
            onClick={() => { if (d.id !== board.id) { setOpened(new Set()); setBoards(setActiveWellnessBoard(boards, d.id)).catch(() => {}); } }}
            className={chipCls(d.id === board.id)} style={d.id === board.id ? chipOn : undefined} data-testid={`wellness-board-${d.id}`}>{d.name}</button>
        ))}
        <button type="button" onClick={() => setCustomize(true)} aria-label="Add or edit Wellness dashboards" title="Add or edit dashboards"
          className="shrink-0 rounded-full border border-dashed border-border p-1.5 text-muted-foreground hover:bg-muted" data-testid="wellness-board-add">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <span className="flex-1" />
        <button type="button" onClick={() => setCustomize(true)}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted" data-testid="wellness-customize-open">
          <Settings className="h-3.5 w-3.5" aria-hidden="true" /> Customize
        </button>
      </div>

      {/* The range is a VIEW: it changes what period the cards describe, and is not saved. The default is set in Customize. */}
      <div role="tablist" aria-label="Time range" className="grid grid-cols-5 gap-1 rounded-full border border-border/70 p-1" data-swipe-ignore data-testid="wellness-range">
        {WELLNESS_RANGES.map((r) => (
          <button key={r} type="button" role="tab" aria-selected={r === range} onClick={() => setPicked(r)}
            className={`rounded-full py-1.5 text-[12px] font-semibold ${r === range ? "text-white" : "text-muted-foreground hover:bg-muted"}`}
            style={r === range ? chipOn : undefined} data-testid={`wellness-range-${r}`}>{RANGE_LABEL[r]}</button>
        ))}
      </div>

      {p.subjectName && <div className="text-[11px] text-muted-foreground" data-testid="wellness-subject">Showing {p.subjectName}'s health data</div>}

      {p.failed ? (
        <div className="rounded-xl border border-border/70 p-4" data-testid="wellness-load-error"><CardError onRetry={p.onRetry} /></div>
      ) : !prefsLoaded || !p.loaded ? (
        <p className="text-xs text-muted-foreground" data-testid="wellness-loading">Loading…</p>
      ) : (
        <>
          {onGrid.length === 0 && quiet.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-4 text-center" data-testid="wellness-empty-dashboard">
              <p className="text-sm font-semibold">{board.name} has no sections yet</p>
              <p className="text-xs text-muted-foreground mt-1">Nothing is deleted — every section is switched off on this dashboard.</p>
              <button type="button" onClick={() => setCustomize(true)} className="mt-2 rounded-full border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">Add sections</button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3" data-testid="wellness-grid">
            {sized.map(({ id, size }) => (
              <div key={id} data-card={id} data-size={size}
                className={`min-w-0 ${size === "large" ? "col-span-2" : lonely.has(id) ? "col-span-2 sm:col-span-1" : "col-span-1"}`}>
                {card(id)}
              </div>
            ))}
          </div>

          {quiet.length > 0 && (
            <div className="rounded-xl border border-border/60 px-3 py-2" data-testid="wellness-quiet-cards">
              <p className="text-[11px] text-muted-foreground mb-1.5">
                Nothing recorded yet{p.mode === "selected" && p.ids.length > 0 ? " for this person — a profile filter is on, so other people's records are hidden, not deleted" : ""}. Tap to open:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {quiet.map((id) => (
                  <button key={id} type="button" onClick={() => open(id)} className="rounded-full border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted"
                    data-testid={`wellness-quiet-${id}`}>{wellnessCardTitle(boards, id)}</button>
                ))}
              </div>
            </div>
          )}

          {hidden.some((id) => !opened.has(id)) && (
            <div className="rounded-xl border border-border/60 px-3 py-2" data-testid="wellness-hidden-cards">
              <p className="text-[11px] text-muted-foreground mb-1.5">Switched off on {board.name} — tap to look, or turn them on in Customize:</p>
              <div className="flex flex-wrap gap-1.5">
                {hidden.filter((id) => !opened.has(id)).map((id) => (
                  <button key={id} type="button" onClick={() => open(id)} className="rounded-full border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:bg-muted"
                    data-testid={`wellness-hidden-${id}`}>{wellnessCardTitle(boards, id)}</button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <WellnessCustomizeDialog open={customize} onClose={() => setCustomize(false)} data={data} lists={lists} range={range} todayISO={p.todayISO} />
    </div>
  );
}

export default WellnessDashboard;
