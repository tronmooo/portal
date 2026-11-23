// The Wellness tab's period cards (owner's design, 2026-11-23): Overview tiles,
// Health Trends, Activity Summary, Sleep & Recovery, Nutrition & Hydration,
// AI Wellness Insights, Mood & Energy, Symptoms & Notes, Vitals Graphs, Health
// Goals — and the body of a card the user built.
//
// Presentation only. Every figure arrives computed by shared/wellness-cards or
// shared/wellness-widgets from the same records the rest of the app reads
// (Rule 1); nothing here averages, counts or guesses.
//
// A card whose range holds nothing names the last reading, never "no data"
// (Rule 4); a list that failed to load is an error with a retry, never an
// empty card (Rule 7). Every chart carries `data-swipe-ignore` (T1).
import type { ReactNode } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronRight, Clock, Droplets, Dumbbell, Flame, HeartPulse, Info, LineChart,
  MapPin, Moon, NotebookPen, Scale, Smile, Sparkles, Target, TrendingDown, TrendingUp, Utensils, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AreaChart } from "@/components/tracker-viz";
import { routeForEntity } from "@shared/entity-routes";
import type {
  ActivitySummary, GoalRow, Insight, MoodSummary, OverviewTile, OverviewTileKey, StatLine, SymptomRow, TrendRow, VitalGraph,
} from "@shared/wellness-cards";
import { formatMinutes } from "@shared/wellness-cards";
import type { WellnessWidgetView } from "@shared/wellness-widgets";
import type { WellnessOptions } from "@shared/wellness-dashboards";
import { Section, T, WorkoutRow } from "./WellnessOverview";

const GOOD = T.green, WARN = T.amber;
const toneOf = (good: boolean | null | undefined) => (good == null ? undefined : `hsl(${good ? GOOD : WARN})`);
const hash = (href?: string) => (href ? `#${href}` : undefined);

/** A small trend line. Draws nothing for fewer than two values. */
export function Spark({ values, color, height = 28 }: { values: number[]; color: string; height?: number }) {
  if (!values || values.length < 2) return null;
  return <div style={{ height }} aria-hidden="true" data-swipe-ignore><AreaChart values={values} color={`hsl(${color})`} height={height} /></div>;
}

/** Bars for a total per day. */
export function MiniBars({ values, color, height = 44 }: { values: number[]; color: string; height?: number }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 0) || 1;
  const w = 100 / values.length;
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden="true" data-swipe-ignore>
      {values.map((v, i) => {
        const h = Math.max(1, (Math.max(0, v) / max) * (height - 2));
        return <rect key={i} x={i * w + w * 0.15} y={height - h} width={w * 0.7} height={h} rx={0.8} fill={`hsl(${color})`} opacity={0.85} />;
      })}
    </svg>
  );
}

export const CardNote = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <p className="text-xs text-muted-foreground" data-testid={testId}>{children}</p>
);

/** A list that did not load: say so, and offer the retry (Rule 7). */
export function CardError({ onRetry, testId }: { onRetry?: () => void; testId?: string }) {
  return (
    <p className="text-xs text-destructive flex items-center justify-between gap-2" data-testid={testId}>
      <span>Couldn't load this.</span>
      {onRetry && <button type="button" className="underline font-medium" onClick={onRetry}>Retry</button>}
    </p>
  );
}

// ── Overview tiles ───────────────────────────────────────────────────────────

const TILE: Record<OverviewTileKey, { icon: LucideIcon; tone: string }> = {
  sleep: { icon: Moon, tone: T.indigo }, activity: { icon: Activity, tone: T.green }, weight: { icon: Scale, tone: T.cyan },
  bp: { icon: HeartPulse, tone: T.red }, hydration: { icon: Droplets, tone: T.blue }, nutrition: { icon: Utensils, tone: T.amber },
};

function Tile({ tile, opts, words }: { tile: OverviewTile; opts: WellnessOptions; words: string }) {
  const meta = TILE[tile.key];
  const Icon = meta.icon;
  const DeltaIcon = tile.delta?.dir === "up" ? TrendingUp : tile.delta?.dir === "down" ? TrendingDown : null;
  const pad = opts.density === "compact" ? "p-2.5" : "p-3.5";
  const body = (
    <>
      <div className="flex items-start gap-2.5 min-w-0">
        <Icon className="h-6 w-6 shrink-0 mt-0.5" style={{ color: `hsl(${meta.tone})` }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-muted-foreground leading-tight">{tile.label}</p>
          {tile.value ? (
            <p className="text-[17px] font-bold leading-tight tabular-nums truncate" data-testid={`wellness-tile-${tile.key}-value`}>{tile.value}</p>
          ) : (
            <p className="text-[12px] text-muted-foreground leading-snug mt-0.5" data-testid={`wellness-tile-${tile.key}-empty`}>
              Nothing in {words}{tile.last ? ` · ${tile.last}` : ""}
            </p>
          )}
          {tile.value && opts.comparison && tile.delta && (
            <p className="text-[11px] leading-tight mt-0.5 flex items-start gap-1" style={{ color: toneOf(tile.delta.good) }} data-testid={`wellness-tile-${tile.key}-delta`}>
              {DeltaIcon && <DeltaIcon className="h-3 w-3 shrink-0" aria-hidden="true" />}<span>{tile.delta.text}</span>
            </p>
          )}
          {tile.value && tile.note && <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{tile.note}</p>}
          {tile.value && (opts.updated || tile.stale) && tile.last && (
            <p className="text-[11px] text-muted-foreground leading-tight mt-0.5" data-testid={`wellness-tile-${tile.key}-last`}>{tile.last}</p>
          )}
        </div>
      </div>
      {opts.trends && tile.value && tile.series.length >= 2 && <div className="mt-1.5"><Spark values={tile.series} color={meta.tone} height={22} /></div>}
    </>
  );
  const cls = `rounded-xl border border-border/60 bg-background/40 ${pad} min-w-0 block`;
  return tile.href
    ? <a href={hash(tile.href)} className={`${cls} hover:bg-muted/40`} data-testid={`wellness-tile-${tile.key}`}>{body}</a>
    : <div className={cls} data-testid={`wellness-tile-${tile.key}`}>{body}</div>;
}

export function OverviewTilesCard({ title, tiles, opts, words }: { title: string; tiles: OverviewTile[]; opts: WellnessOptions; words: string }) {
  const tracked = tiles.filter((t) => t.tracked);
  const missing = tiles.filter((t) => !t.tracked);
  return (
    <Section title={title} icon={Activity} tone={T.pink} testId="wellness-card-overview">
      {tracked.length === 0 ? (
        <CardNote testId="wellness-overview-empty">Nothing recorded yet. Log sleep, a workout, a weigh-in or a meal in chat and it shows here.</CardNote>
      ) : (
        <div className="grid grid-cols-2 gap-2">{tracked.map((t) => <Tile key={t.key} tile={t} opts={opts} words={words} />)}</div>
      )}
      {tracked.length > 0 && missing.length > 0 && (
        <p className="text-[11px] text-muted-foreground mt-2" data-testid="wellness-overview-untracked">
          Not tracked yet: {missing.map((t) => t.label).join(", ")}.
        </p>
      )}
    </Section>
  );
}

// ── Health trends ────────────────────────────────────────────────────────────

const TREND_ICON: Record<string, { icon: LucideIcon; tone: string }> = {
  weight: { icon: Scale, tone: T.green }, bp: { icon: HeartPulse, tone: T.red }, sleep_hours: { icon: Moon, tone: T.indigo },
  resting_hr: { icon: HeartPulse, tone: T.pink }, hrv: { icon: Activity, tone: T.teal }, steps: { icon: Activity, tone: T.green }, hydration: { icon: Droplets, tone: T.blue },
};

export function TrendsCard({ title, rows, opts, words }: { title: string; rows: TrendRow[]; opts: WellnessOptions; words: string }) {
  return (
    <Section title={title} icon={TrendingUp} tone={T.purple} testId="wellness-card-trends">
      {rows.length === 0 ? (
        <CardNote testId="wellness-trends-empty">A trend needs two readings of the same thing in {words}. Try a longer range.</CardNote>
      ) : (
        <div>
          {rows.map((r) => {
            const m = TREND_ICON[r.key] ?? { icon: LineChart, tone: T.cyan };
            const inner = (
              <>
                <m.icon className="h-5 w-5 shrink-0" style={{ color: `hsl(${m.tone})` }} aria-hidden="true" />
                <span className="text-[13px] font-semibold w-[84px] shrink-0 leading-tight">{r.label}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] tabular-nums truncate">{r.span}</span>
                  <span className="block text-[12px] truncate" style={{ color: toneOf(r.good) }}>{r.change}</span>
                </span>
                {opts.trends && <span className="w-[72px] shrink-0"><Spark values={r.series} color={m.tone} height={24} /></span>}
                {r.href && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
              </>
            );
            const cls = "flex items-center gap-2.5 py-2 border-b border-border/40 last:border-0 min-w-0";
            return r.href
              ? <a key={r.key} href={hash(r.href)} className={`${cls} hover:bg-muted/40 rounded px-1 -mx-1`} data-testid={`wellness-trend-${r.key}`}>{inner}</a>
              : <div key={r.key} className={cls} data-testid={`wellness-trend-${r.key}`}>{inner}</div>;
          })}
        </div>
      )}
    </Section>
  );
}

// ── Activity summary ─────────────────────────────────────────────────────────

export function ActivitySummaryCard({ title, summary, label, words }: { title: string; summary: ActivitySummary; label: string; words: string }) {
  const row = (icon: LucideIcon, tone: string, name: string, value: string, key: string) => {
    const Icon = icon;
    return (
      <div className="flex items-center gap-3 py-1.5 border-b border-border/40 last:border-0" data-testid={`wellness-activity-${key}`}>
        <Icon className="h-5 w-5 shrink-0" style={{ color: `hsl(${tone})` }} aria-hidden="true" />
        <span className="text-[13px] flex-1">{name}</span>
        <span className="text-[14px] font-bold tabular-nums">{value}</span>
      </div>
    );
  };
  return (
    <Section title={title} icon={Dumbbell} tone={T.amber} meta={label} testId="wellness-card-activity">
      {summary.sessions === 0 ? (
        <CardNote testId="wellness-activity-empty">
          {summary.lastAt
            ? `No workouts in ${words} · Last: ${new Date(summary.lastAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
            : "No workouts recorded. Log a run, a walk or a gym session in chat and it shows here."}
        </CardNote>
      ) : (
        <>
          {row(Activity, T.pink, "Total Workouts", String(summary.sessions), "sessions")}
          {summary.minutes != null && row(Clock, T.purple, "Total Time", `${summary.minutesEstimated ? "≈" : ""}${formatMinutes(summary.minutes)}`, "time")}
          {summary.distance != null && row(MapPin, T.indigo, "Distance", `${summary.distanceEstimated ? "≈" : ""}${summary.distance.toLocaleString("en-US")} mi`, "distance")}
          {summary.calories != null && row(Flame, T.orange, "Calories", `≈${summary.calories.toLocaleString("en-US")}`, "calories")}
          <div className="mt-2" data-testid="wellness-activity-types">{summary.groups.map((w) => <WorkoutRow key={w.trackerId} w={w} />)}</div>
        </>
      )}
    </Section>
  );
}

// ── Sleep & recovery, nutrition & hydration ──────────────────────────────────

export function StatLinesCard({ title, icon, tone, lines, empty, opts, words, testId }: {
  title: string; icon: LucideIcon; tone: string; lines: StatLine[]; empty: string; opts: WellnessOptions; words: string; testId: string;
}) {
  return (
    <Section title={title} icon={icon} tone={tone} testId={testId}>
      {lines.length === 0 ? <CardNote testId={`${testId}-empty`}>{empty}</CardNote> : (
        <div>
          {lines.map((l) => (
            <div key={l.key} className="flex items-center gap-3 py-1.5 border-b border-border/40 last:border-0 min-w-0" data-testid={`${testId}-${l.key}`}>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] truncate">{l.label}</span>
                {l.value && opts.comparison && l.delta && <span className="block text-[11px] truncate" style={{ color: toneOf(l.good) }}>{l.delta}</span>}
                {!l.value && <span className="block text-[11px] text-muted-foreground truncate">Nothing in {words}{l.last ? ` · ${l.last}` : ""}</span>}
                {l.value && opts.updated && l.last && <span className="block text-[11px] text-muted-foreground truncate">{l.last}</span>}
              </span>
              {opts.trends && l.value && l.series && l.series.length >= 2 && <span className="w-[64px] shrink-0"><Spark values={l.series} color={tone} height={22} /></span>}
              <span className="text-[14px] font-bold tabular-nums shrink-0">{l.value ?? "—"}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ── AI wellness insights ─────────────────────────────────────────────────────

const INSIGHT_ICON: Record<Insight["tone"], { icon: LucideIcon; tone: string }> = {
  good: { icon: CheckCircle2, tone: T.green }, info: { icon: Info, tone: T.blue }, warn: { icon: AlertTriangle, tone: T.amber },
};

export function InsightsCard({ title, insights, aiNarrative, onAiBrief, aiBriefLoading, words }: {
  title: string; insights: Insight[]; aiNarrative?: string | null; onAiBrief?: () => void; aiBriefLoading?: boolean; words: string;
}) {
  return (
    <Section title={title} icon={Sparkles} tone={T.purple} testId="wellness-card-insights">
      {insights.length === 0 ? (
        <CardNote testId="wellness-insights-empty">Nothing to compare in {words} yet. Insights appear once a measurement has readings in the range.</CardNote>
      ) : (
        <ul className="space-y-1.5">
          {insights.map((line, i) => {
            const m = INSIGHT_ICON[line.tone];
            return (
              <li key={i} className="flex items-start gap-2 text-[13px] leading-snug" data-testid={`wellness-insight-${i}`}>
                <m.icon className="h-4 w-4 shrink-0 mt-0.5" style={{ color: `hsl(${m.tone})` }} aria-hidden="true" />
                <span>{line.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      {aiNarrative && <p className="text-xs leading-relaxed mt-3 pt-3 border-t border-border/50" data-testid="wellness-brief-ai">{aiNarrative}</p>}
      {onAiBrief && insights.length > 0 && (
        <Button variant="outline" size="sm" className="mt-3 h-7 text-[11px]" onClick={onAiBrief} disabled={aiBriefLoading} data-testid="wellness-ai-brief">
          {aiBriefLoading ? "Reading your data…" : "Ask AI to read this back"}
        </Button>
      )}
      <p className="text-[11px] text-muted-foreground mt-2">Read back from your own records. Not medical advice.</p>
    </Section>
  );
}

// ── Mood, symptoms, graphs, goals ────────────────────────────────────────────

export interface ListState { loading: boolean; error: boolean; retry?: () => void }

export function MoodCard({ title, mood, state, opts, words }: { title: string; mood: MoodSummary | null; state: ListState; opts: WellnessOptions; words: string }) {
  return (
    <Section title={title} icon={Smile} tone={T.amber} testId="wellness-card-mood">
      {state.error ? <CardError onRetry={state.retry} testId="wellness-mood-error" />
        : state.loading || !mood ? <CardNote>Loading…</CardNote>
        : mood.entries === 0 ? (
          <CardNote testId="wellness-mood-empty">
            {mood.last ? `No journal mood in ${words} · ${mood.last}` : "No journal entries with a mood yet. Write one in Journal and it shows here."}
          </CardNote>
        ) : (
          <>
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[20px] font-bold leading-tight" data-testid="wellness-mood-average">{mood.average}</p>
                <p className="text-[11px] text-muted-foreground">Average of {mood.entries} entr{mood.entries === 1 ? "y" : "ies"} · {mood.averageScore} / 8</p>
                {opts.comparison && mood.delta && <p className="text-[11px] text-muted-foreground">{mood.delta}</p>}
              </div>
              {mood.energy != null && <p className="text-[12px] text-muted-foreground shrink-0">Energy <span className="font-bold text-foreground">{mood.energy}</span> / 5</p>}
            </div>
            {opts.trends && <div className="mt-2"><Spark values={mood.series} color={T.amber} /></div>}
            <div className="flex flex-wrap gap-1.5 mt-2">
              {mood.counts.map((c) => <span key={c.mood} className="text-[11px] px-2 py-0.5 rounded-full bg-muted">{c.mood} · {c.count}</span>)}
            </div>
          </>
        )}
    </Section>
  );
}

export function SymptomsCard({ title, rows, words }: { title: string; rows: SymptomRow[]; words: string }) {
  return (
    <Section title={title} icon={NotebookPen} tone={T.orange} testId="wellness-card-symptoms">
      {rows.length === 0 ? (
        <CardNote testId="wellness-symptoms-empty">No symptom trackers yet. Tell chat "I have a headache" and it starts one.</CardNote>
      ) : rows.map((r) => (
        <a key={r.trackerId} href={routeForEntity("tracker", r.trackerId, { hash: true })}
          className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0 hover:bg-muted/40 rounded px-1 -mx-1"
          data-testid={`wellness-symptom-${r.trackerId}`}>
          <span className="min-w-0">
            <span className="block text-[13px] font-medium truncate">{r.name}</span>
            {r.note && <span className="block text-[11px] text-muted-foreground truncate">{r.note}</span>}
          </span>
          <span className="text-[11px] text-muted-foreground shrink-0 text-right">
            {r.count > 0 ? `${r.count}× in ${words}` : `None in ${words}`}{r.last ? <><br />{r.last}</> : null}
          </span>
        </a>
      ))}
    </Section>
  );
}

export function GraphsCard({ title, graphs, words }: { title: string; graphs: VitalGraph[]; words: string }) {
  return (
    <Section title={title} icon={LineChart} tone={T.cyan} testId="wellness-card-graphs">
      {graphs.length === 0 ? (
        <CardNote testId="wellness-graphs-empty">A graph needs two readings of a vital in {words}. Try a longer range.</CardNote>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {graphs.map((g) => (
            <div key={g.id} data-testid={`wellness-graph-${g.id}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">{g.label}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{g.low} – {g.high}</span>
              </div>
              <Spark values={g.values} color={T.cyan} height={64} />
              <div className="flex justify-between text-[11px] text-muted-foreground"><span>{g.from}</span><span>{g.to}</span></div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

export function GoalsCard({ title, goals, state }: { title: string; goals: GoalRow[] | null; state: ListState }) {
  return (
    <Section title={title} icon={Target} tone={T.green} testId="wellness-card-goals">
      {state.error ? <CardError onRetry={state.retry} testId="wellness-goals-error" />
        : state.loading || !goals ? <CardNote>Loading…</CardNote>
        : goals.length === 0 ? <CardNote testId="wellness-goals-empty">No active health goals. Tell chat "I want to reach 195 lbs by March" to set one.</CardNote>
        : goals.map((g) => (
          <div key={g.id} className="py-1.5 border-b border-border/40 last:border-0" data-testid={`wellness-goal-${g.id}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-medium truncate">{g.title}</span>
              <span className="text-[11px] text-muted-foreground shrink-0">{g.progress}{g.deadline ? ` · ${g.deadline}` : ""}</span>
            </div>
            {g.pct != null && (
              <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden" role="progressbar" aria-valuenow={g.pct} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full" style={{ width: `${g.pct}%`, background: `hsl(${T.green})` }} />
              </div>
            )}
          </div>
        ))}
    </Section>
  );
}

// ── A card the user built ────────────────────────────────────────────────────

/** The inside of a custom Wellness card: the figure, its chart or rows, and how it was worked out. */
export function WidgetViewBody({ id, view, accent = T.purple, showWorking = true }: { id: string; view: WellnessWidgetView; accent?: string; showWorking?: boolean }) {
  return (
    <div data-testid={`wellness-widget-body-${id}`}>
      {view.empty ? (
        <p className="text-xs text-muted-foreground" data-testid={`wellness-widget-empty-${id}`}>{view.empty}</p>
      ) : view.headline && (
        <div>
          <p className="text-[22px] font-bold leading-tight tabular-nums" data-testid={`wellness-widget-value-${id}`}>{view.headline.value}</p>
          <p className="text-[11px] text-muted-foreground">{view.headline.label}</p>
          {view.delta && <p className="text-[12px] mt-0.5" style={{ color: toneOf(view.delta.good) }} data-testid={`wellness-widget-delta-${id}`}>{view.delta.text}</p>}
        </div>
      )}
      {view.series && view.chart === "bar" && <div className="mt-2"><MiniBars values={view.series} color={accent} /></div>}
      {view.series && view.chart === "line" && <div className="mt-2"><Spark values={view.series} color={accent} height={44} /></div>}
      {view.rows && view.rows.length > 0 && (
        <div className="mt-2">
          {view.rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3 py-1 border-b border-border/40 last:border-0" data-testid={`wellness-widget-row-${id}-${r.key}`}>
              <span className="min-w-0">
                <span className="block text-[12px] truncate">{r.label}</span>
                {r.sub && <span className="block text-[11px] text-muted-foreground truncate">{r.sub}</span>}
              </span>
              <span className="text-[13px] font-bold tabular-nums shrink-0">{r.value}</span>
            </div>
          ))}
        </div>
      )}
      {showWorking && (view.explain || view.caveat) && (
        <details className="mt-2 text-[11px] text-muted-foreground" data-testid={`wellness-widget-working-${id}`}>
          <summary className="cursor-pointer select-none">How this is worked out</summary>
          {view.sources.length > 0 && <p className="mt-1">Sources: {view.sources.join(", ")}.</p>}
          {view.explain && <p className="mt-0.5">{view.explain}</p>}
        </details>
      )}
      {view.caveat && <p className="text-[11px] text-muted-foreground mt-1" data-testid={`wellness-widget-caveat-${id}`}>{view.caveat}</p>}
    </div>
  );
}
