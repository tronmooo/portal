// ── Wellness overview (Health→Wellness tab redesign, 2026-07) ────────────────
// A health command center: KPI strip (Wellness / Sleep / Activity / Resting HR /
// Hydration / Calories / Streak) over a colorful card grid — habits, schedule,
// medications, vitals, sleep, nutrition, hydration, exercise, mood, appointments,
// reminders, labs, supplements, documents, conditions, allergies, activity.
//
// Pure presentation. Every value is a prop derived in pages/wellness.tsx from the
// SAME shared query keys the Trackers grid and Executive dashboard read, so a
// value logged anywhere shows up here and vice-versa. Cards render an honest
// empty state rather than fake data when their source is empty.
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity, Heart, Moon, Droplet, Flame, HeartPulse, Brain, Pill, CalendarClock,
  Bell, FlaskConical, Leaf, FileText, Stethoscope, AlertTriangle, Sparkles,
  CheckCircle2, Circle, Footprints, Dumbbell, Plus, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import { groupWellnessCards, type WellnessCard } from "@/lib/wellness-dynamic";
import { Medallion } from "@/components/dashboard/visuals";
import { conceptIcon } from "@/lib/icon-map";
import { SectionHeading } from "@/components/ui/section-heading";
import { formatListDate } from "@/lib/format";

// ── shared bits ──────────────────────────────────────────────────────────────
const T = {
  green: "155 65% 45%", teal: "173 60% 44%", blue: "213 90% 62%", cyan: "199 89% 60%",
  purple: "262 70% 62%", pink: "330 75% 62%", amber: "38 96% 54%", orange: "25 90% 58%",
  red: "0 72% 58%", indigo: "240 60% 65%",
};
const fmt = (n: number | null | undefined, dp = 0) =>
  n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: dp });

/**
 * The caption under a KPI number: silent when the reading is from today,
 * explicit about the day when it isn't.
 *
 * `todayText` is what the tile wants to say when the reading IS current (Sleep
 * says "last night"); omit it and a current reading gets no caption at all,
 * since "today" is the assumption a dashboard already makes. The point is
 * that a NON-current reading can never again pass for a current one.
 */
function staleSub(day: string | null | undefined, todayText?: string): string | undefined {
  if (!day) return todayText;
  const rel = formatListDate(day);
  if (!rel || rel === "Today") return todayText;
  return rel.toLowerCase();
}

function Spark({ series, color }: { series: number[]; color: string }) {
  if (!series || series.length < 2) return <div className="h-6" />;
  const w = 120, h = 24, pad = 2;
  const min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-6" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={`hsl(${color})`} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Ring({ value, max, color, label, unit }: { value: number; max: number; color: string; label: string; unit?: string }) {
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const r = 26, c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 72 72" className="w-16 h-16">
      <circle cx="36" cy="36" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="7" />
      <circle cx="36" cy="36" r={r} fill="none" stroke={`hsl(${color})`} strokeWidth="7"
        strokeDasharray={`${(c * pct).toFixed(1)} ${c.toFixed(1)}`} strokeLinecap="round" transform="rotate(-90 36 36)" />
      <text x="36" y="34" textAnchor="middle" className="fill-foreground" style={{ fontSize: 13, fontWeight: 700 }}>{fmt(value)}</text>
      {unit && <text x="36" y="46" textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 7 }}>{label}</text>}
    </svg>
  );
}

// KPI tile in the top strip.
function KpiTile({ label, value, unit, sub, tone, series, icon: Icon, ring, progress, testId, onClick }: {
  label: string; value: string; unit?: string; sub?: string; tone: string;
  series?: number[]; icon: any; ring?: { value: number; max: number };
  /** A 0–1 bar with a caption, for tiles that have no series to plot. */
  progress?: { value: number; caption: string };
  testId: string;
  /** Opens the metric's detail popup. Omit and the tile stays inert — a tile
   *  that lifts under the cursor but opens nothing is worse than a flat one. */
  onClick?: () => void;
}) {
  return (
    <Card interactive={!!onClick} className="p-3 min-w-[8.5rem] flex-1" data-testid={testId}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `${label} details` : undefined}
      onKeyDown={onClick ? (e: any) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      style={{ ["--accent-hsl" as any]: tone }}>
      {/* The icon rides a tinted circle here exactly as it does on the
          Executive tab — a bare 12px glyph next to a label was the tell that
          this tab was built separately. */}
      <div className="flex items-center gap-2">
        <Medallion icon={Icon} accent={tone} size="sm" />
        <span className="micro-label text-muted-foreground leading-tight">{label}</span>
      </div>
      <div className="flex items-end justify-between mt-2 gap-2">
        <div className="min-w-0">
          <div className="metric-value text-[28px] leading-none" style={{ color: `hsl(${tone})` }}>{value}</div>
          {unit && <div className="text-[11px] text-muted-foreground mt-1">{unit}</div>}
        </div>
        {ring && <Ring value={ring.value} max={ring.max} color={tone} label="" />}
      </div>
      {series && series.length >= 2 && <div className="mt-2"><Spark series={series} color={tone} /></div>}
      {progress && (
        <div className="mt-2.5">
          <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: `hsl(${tone} / 0.16)` }}>
            <div className="h-full rounded-full" style={{ width: `${Math.round(Math.max(0, Math.min(1, progress.value)) * 100)}%`, background: `hsl(${tone})` }} />
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">{progress.caption}</div>
        </div>
      )}
      {sub && <div className="text-[11px] text-muted-foreground mt-1.5">{sub}</div>}
    </Card>
  );
}

// A titled card with an accent header + optional "View all →".
function SectionCard({ title, icon: Icon, tone, badge, viewAllHref, onViewAll, onOpen, children, testId }: {
  title: string; icon: any; tone: string; badge?: string;
  viewAllHref?: string; onViewAll?: () => void;
  /** Opens this section's detail popup. */
  onOpen?: () => void;
  children: React.ReactNode; testId: string;
}) {
  return (
    <Card className="p-4 flex flex-col" data-testid={testId} style={{ ["--accent-hsl" as any]: tone }}>
      <SectionHeading
        title={title} icon={Icon} accent={tone} meta={badge}
        onClick={onOpen} testId={onOpen ? `${testId}-open` : undefined}
      />
      <div className="flex-1">{children}</div>
      {(viewAllHref || onViewAll) && (
        viewAllHref
          ? <Link href={viewAllHref}><span className="mt-3 inline-block text-[11px] hover:underline cursor-pointer" style={{ color: `hsl(${tone})` }} data-testid={`${testId}-viewall`}>View all →</span></Link>
          : <button className="mt-3 text-left text-[11px] hover:underline" style={{ color: `hsl(${tone})` }} onClick={onViewAll} data-testid={`${testId}-viewall`}>View all →</button>
      )}
    </Card>
  );
}

const Empty = ({ text }: { text: string }) => <p className="text-xs text-muted-foreground">{text}</p>;

// ── Dynamic per-tracker card ───────────────────────────────────────────────
// Renders ONE metric the user actually tracks. Reused for every tracker with
// data — measurement (Weight/Sleep), dual (Blood Pressure), or a non-numeric
// activity ("Guitar" → recent-log count). Nothing predetermined.
const GROUP_TONE: Record<string, string> = {
  Health: T.red, Fitness: T.green, Nutrition: T.orange, Mental: T.purple,
  Sleep: T.purple, Medication: T.pink, Lifestyle: T.teal, Other: T.blue,
};
// Heart = health, flame = nutrition, moon = sleep … the same icon vocabulary
// the Executive tab uses, so a group reads the same wherever it appears.
const GROUP_ICON: Record<string, any> = {
  Health: HeartPulse, Fitness: Dumbbell, Nutrition: Flame, Mental: Brain,
  Sleep: Moon, Medication: Pill, Lifestyle: Leaf, Other: Activity,
};
function DynamicCard({ card }: { card: WellnessCard }) {
  const tone = GROUP_TONE[card.group] || T.blue;
  const favColor = card.favorable === "good" ? T.green : card.favorable === "bad" ? T.red : "var(--muted-foreground)";
  const TrendIco = card.direction === "up" ? TrendingUp : card.direction === "down" ? TrendingDown : Minus;
  const valueText = card.pair
    ? `${card.pair.systolic ?? "—"}/${card.pair.diastolic ?? "—"}`
    : fmt(card.value, card.isCount ? 0 : 1);
  return (
    <Link href="/trackers" className="block h-full">
      {/* --accent-hsl, not an inline borderColor: the bubble paints its own
          border from the accent, and an inline one silently wins over it. */}
      <Card interactive className="p-3 h-full flex flex-col" data-testid={`wellness-metric-${card.id}`}
        style={{ ["--accent-hsl" as any]: tone }}>
        <div className="flex items-center gap-2">
          <Medallion icon={GROUP_ICON[card.group] || Activity} accent={tone} size="sm" />
          <span className="micro-label text-muted-foreground truncate flex-1 min-w-0">{card.name}</span>
          {card.changePct != null && card.favorable !== "neutral" && (
            <span className="flex items-center gap-0.5 text-[11px] font-semibold shrink-0" style={{ color: favColor.startsWith("var") ? undefined : `hsl(${favColor})` }}>
              <TrendIco className="w-3 h-3" /> {Math.abs(card.changePct).toFixed(0)}%
            </span>
          )}
        </div>
        <div className="mt-2 metric-value text-[26px] leading-none" style={{ color: `hsl(${tone})` }}>
          {valueText}<span className="text-[11px] text-muted-foreground ml-1">{card.unit}</span>
        </div>
        {card.series.length >= 2 && <div className="mt-2 flex-1 flex items-end"><Spark series={card.series} color={tone} /></div>}
        <div className="text-[11px] text-muted-foreground mt-1.5">{card.entryCount} logged</div>
      </Card>
    </Link>
  );
}
function DynamicMetricGrid({ cards }: { cards: WellnessCard[] }) {
  if (!cards || cards.length === 0) return null;
  const groups = groupWellnessCards(cards);
  return (
    <div className="space-y-3" data-testid="wellness-dynamic">
      {groups.map((g) => (
        <div key={g.group}>
          <SectionHeading title={g.group} icon={GROUP_ICON[g.group] || Activity} accent={GROUP_TONE[g.group] || T.blue} count={g.cards.length} />
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 items-stretch">
            {g.cards.map((c) => <DynamicCard key={c.id} card={c} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// A "+ Log X" quick-log button (renders only when a handler is wired).
function LogButton({ label, onClick, testId }: { label: string; onClick?: () => void; testId: string }) {
  if (!onClick) return null;
  return (
    <Button size="sm" variant="outline" className="h-7 text-xs mt-3" onClick={onClick} data-testid={testId}>
      <Plus className="w-3 h-3 mr-1" /> {label}
    </Button>
  );
}

function trendIcon(change: number | null | undefined) {
  if (change == null) return null;
  return change >= 0 ? <TrendingUp className="w-3 h-3 text-emerald-500" /> : <TrendingDown className="w-3 h-3 text-red-500" />;
}

// ── types ────────────────────────────────────────────────────────────────────
export interface WellnessHabit { id: string; name: string; done: boolean; }
export interface WellnessEvent { id: string; time: string; title: string; }
export interface WellnessMed { id: string; name: string; dose?: string; time?: string; taken: boolean; }
export interface WellnessAppt { id: string; date: string; time?: string; title: string; }
export interface WellnessLab { id: string; name: string; date?: string; status?: string; }
export interface WellnessSupp { id: string; name: string; dose?: string; schedule?: string; }
export interface WellnessDoc { id: string; name: string; date?: string; }
export interface WellnessListItem { id: string; name: string; note?: string; }
export interface WellnessActivityItem { id: string; text: string; when?: string; }
export interface WellnessVital { label: string; value: string; change?: number | null; icon?: any; }

export interface WellnessOverviewProps {
  wellnessScore: number | null;
  wellnessScoreLabel?: string;
  sleepHours: number | null;
  sleepSeries?: number[];
  steps: number | null;
  stepsSeries?: number[];
  restingHr: number | null;
  restingHrSeries?: number[];
  hydrationOz: number | null;
  hydrationGoal: number;
  calories: number | null;
  caloriesGoal: number;
  streak: number | null;
  /**
   * The local day (YYYY-MM-DD) each KPI number is actually from.
   *
   * The tiles show the most recent reading when nothing has been logged today
   * yet, which is the right call — a blank tile is worse than a stale one. But
   * they used to caption it as if it were current ("last night", a progress
   * ring against today's goal), so at 00:44 yesterday's 94 oz read as today's.
   * Given the day, each tile can say so.
   */
  asOf?: Partial<Record<"sleep" | "activity" | "hr" | "hydration" | "calories", string | null>>;

  insights: string[];
  habits: WellnessHabit[];
  habitsCompleted: number;
  onToggleHabit?: (id: string, next: boolean) => void;
  togglingHabitId?: string | null;
  /** Active habits not yet checked in today. */
  missedHabits?: WellnessHabit[];
  /** Mental-wellness signal (meditation minutes today) — null → empty state. */
  meditationMin?: number | null;
  /** Recovery signal (0–100) — null → empty state (no source yet). */
  recoveryScore?: number | null;

  schedule: WellnessEvent[];
  medications: WellnessMed[];
  onToggleMed?: (id: string, next: boolean) => void;
  togglingMedId?: string | null;

  vitals: WellnessVital[];
  sleep?: { hours: number | null; deep?: number; light?: number; rem?: number; efficiency?: number };
  nutrition?: { calories: number | null; caloriesGoal: number; protein?: number; carbs?: number; fats?: number };
  mood?: { value: number | null; series: number[] };
  activity?: { workouts?: number; activeMin?: number; caloriesBurned?: number };

  appointments: WellnessAppt[];
  reminders: string[];
  labs: WellnessLab[];
  supplements: WellnessSupp[];
  documents: WellnessDoc[];
  conditions: WellnessListItem[];
  allergies: WellnessListItem[];
  recentActivity: WellnessActivityItem[];

  weightUnit?: string;
  onQuickLog?: (kind: "hydration" | "weight" | "mood" | "sleep" | "steps") => void;

  /** Dynamic per-tracker cards — one per metric the user actually logs. */
  dynamicCards?: WellnessCard[];
  /** Opens a detail popup for a KPI tile or section card. */
  onOpenPopup?: (kind: string) => void;
  /** Called when the user taps "AI Deep Dive". */
  onAiDeepDive?: () => void;
  aiDeepDiveLoading?: boolean;
  /** Narrative returned by the AI deep dive (rendered under the insights card). */
  aiNarrative?: string | null;
}


export function WellnessOverview(props: WellnessOverviewProps) {
  const {
    wellnessScore, wellnessScoreLabel, sleepHours, sleepSeries, steps, stepsSeries,
    restingHr, restingHrSeries, hydrationOz, hydrationGoal, calories, caloriesGoal, streak, asOf,
    insights, habits, habitsCompleted, onToggleHabit, togglingHabitId,
    missedHabits = [], meditationMin, recoveryScore,
    schedule, medications, onToggleMed, togglingMedId, vitals, sleep, nutrition, mood, activity,
    appointments, reminders, labs, supplements, documents, conditions, allergies,
    recentActivity, weightUnit = "lbs", onQuickLog,
    dynamicCards = [], onOpenPopup, onAiDeepDive, aiDeepDiveLoading, aiNarrative,
  } = props;
  const open = (kind: string) => (onOpenPopup ? () => onOpenPopup(kind) : undefined);

  const dueMeds = medications.filter((m) => !m.taken).length;
  // Dynamic visibility: only render a section when it actually has data — an
  // empty account shows nothing for it ("if they don't have any, they don't
  // need them"). The dynamic per-tracker grid already covers single metrics, so
  // the fixed cards below are reserved for the aggregate/list surfaces.
  const has = {
    habits: habits.length > 0,
    missed: missedHabits.length > 0,
    schedule: schedule.length > 0,
    meds: medications.length > 0,
    appts: appointments.length > 0,
    reminders: reminders.length > 0,
    labs: labs.length > 0,
    supps: supplements.length > 0,
    docs: documents.length > 0,
    conditions: conditions.length > 0,
    allergies: allergies.length > 0,
    activity: recentActivity.length > 0,
    insights: insights.length > 0 || !!aiNarrative || !!onAiDeepDive,
  };

  return (
    <div className="space-y-3" data-testid="wellness-overview">
      {/* ── KPI strip — only tiles that actually have a value ── */}
      <div className="flex flex-wrap gap-3 content-start items-stretch" data-testid="wellness-kpis">
        {wellnessScore != null && (
          <KpiTile onClick={open("score")} testId="wellness-kpi-score" label="Wellness Score" tone={wellnessScore >= 80 ? T.green : wellnessScore >= 60 ? T.amber : T.red}
            icon={Sparkles} value={String(wellnessScore)} unit={wellnessScoreLabel}
            ring={{ value: wellnessScore, max: 100 }} />
        )}
        {/* The caption on each of these says WHEN the number is from. It used
            to assert "last night" / imply today unconditionally, so a stale
            reading — which is every reading just after midnight, before
            anything has been logged — was presented as the current one. */}
        {sleepHours != null && (
          <KpiTile onClick={open("sleep")} testId="wellness-kpi-sleep" label="Sleep" tone={T.purple} icon={Moon}
            value={`${fmt(sleepHours, 1)}h`} sub={staleSub(asOf?.sleep, "last night")} series={sleepSeries} />
        )}
        {steps != null && (
          <KpiTile onClick={open("activity")} testId="wellness-kpi-activity" label="Activity" tone={T.blue} icon={Footprints}
            value={fmt(steps)} unit="steps" sub={staleSub(asOf?.activity)} series={stepsSeries} />
        )}
        {restingHr != null && (
          <KpiTile onClick={open("hr")} testId="wellness-kpi-hr" label="Resting HR" tone={T.green} icon={conceptIcon("health")}
            value={String(restingHr)} unit="bpm" sub={staleSub(asOf?.hr)} series={restingHrSeries} />
        )}
        {hydrationOz != null && (
          <KpiTile onClick={open("hydration")} testId="wellness-kpi-hydration" label="Hydration" tone={T.cyan} icon={Droplet}
            value={fmt(hydrationOz)} unit={`/ ${hydrationGoal} oz`} sub={staleSub(asOf?.hydration)}
            ring={{ value: hydrationOz || 0, max: hydrationGoal }} />
        )}
        {calories != null && (
          <KpiTile onClick={open("calories")} testId="wellness-kpi-calories" label="Calories" tone={T.orange} icon={Flame}
            value={fmt(calories)} unit={`/ ${caloriesGoal} kcal`} sub={staleSub(asOf?.calories)}
            ring={{ value: calories || 0, max: caloriesGoal }} />
        )}
        {streak != null && (
          <KpiTile onClick={open("streak")} testId="wellness-kpi-streak" label="Streak" tone={T.orange} icon={Flame}
            value={String(streak)} unit="days"
            // Milestone progress, derived from the streak itself — the tile
            // used to end here with a third of it blank.
            progress={(() => {
              const next = [7, 30, 60, 100, 365].find((m) => m > streak) ?? null;
              return next == null ? undefined : { value: streak / next, caption: `${next - streak} to a ${next}-day streak` };
            })()} />
        )}
      </div>

      {/* ── Quick-log row — one tap to log the point-in-time metrics ── */}
      {onQuickLog && (
        <div className="flex flex-wrap gap-2" data-testid="wellness-quicklog">
          {([["hydration", Droplet, "Water"], ["weight", HeartPulse, "Weight"], ["sleep", Moon, "Sleep"], ["mood", Brain, "Mood"], ["steps", Footprints, "Steps"]] as const).map(([kind, Icon, label]) => (
            <Button key={kind} size="sm" variant="outline" className="h-8 text-xs" onClick={() => onQuickLog(kind)} data-testid={`wellness-quicklog-${kind}`}>
              <Icon className="w-3.5 h-3.5 mr-1" /> {label}
            </Button>
          ))}
        </div>
      )}

      {/* ── AI Wellness Insights (deterministic every load + optional deep dive) ── */}
      {has.insights && (
        <SectionCard onOpen={open("insights")} testId="wellness-insights" title="AI Wellness Insights" icon={Sparkles} tone={T.purple}>
          {insights.length === 0 && !aiNarrative ? <Empty text="Log a few days of trackers to unlock insights." /> : (
            <ul className="space-y-2">
              {insights.slice(0, 6).map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Sparkles className="w-3 h-3 mt-0.5 shrink-0" style={{ color: `hsl(${T.purple})` }} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
          {aiNarrative && (
            <p className="mt-3 text-xs leading-relaxed rounded-md p-2.5 bg-purple-500/5" style={{ borderLeft: `2px solid hsl(${T.purple})` }}>{aiNarrative}</p>
          )}
          {onAiDeepDive && (
            <Button size="sm" variant="outline" className="h-7 text-xs mt-3" onClick={onAiDeepDive} disabled={aiDeepDiveLoading} data-testid="wellness-ai-deepdive">
              <Sparkles className="w-3 h-3 mr-1" /> {aiDeepDiveLoading ? "Thinking…" : "AI Deep Dive"}
            </Button>
          )}
        </SectionCard>
      )}

      {/* ── DYNAMIC metric grid — one card per metric the user actually tracks ── */}
      <DynamicMetricGrid cards={dynamicCards} />

      {/* ── Truly-empty account: a single friendly nudge, no wall of empties ── */}
      {dynamicCards.length === 0 && !has.habits && !has.meds && !has.schedule && !has.appts && !has.docs && (
        <Card className="p-6 text-center" data-testid="wellness-empty">
          <HeartPulse className="w-8 h-8 mx-auto mb-2 text-red-500/70" />
          <p className="text-sm font-medium">Nothing tracked yet</p>
          <p className="text-xs text-muted-foreground mt-1">Log something in chat — “weight 180”, “slept 7 hours”, “bp 120/80” — and it shows up here automatically.</p>
        </Card>
      )}

      {/* ── Aggregate / list cards — each rendered ONLY when it has data ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {has.habits && (
        <SectionCard onOpen={open("habits")} testId="wellness-habits" title="Today's Habits" icon={conceptIcon("habits")} tone={T.green}
          badge={`${habitsCompleted} / ${habits.length} done`} viewAllHref="/habits">
          {habits.length === 0 ? <Empty text="No habits yet — add one from chat." /> : (
            <ul className="space-y-1.5">
              {habits.slice(0, 7).map((h) => (
                <li key={h.id}>
                  <button className="w-full flex items-center gap-2 text-left text-sm disabled:opacity-60"
                    disabled={togglingHabitId === h.id}
                    onClick={() => onToggleHabit?.(h.id, !h.done)} data-testid={`wellness-habit-${h.id}`}>
                    {h.done
                      ? <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: `hsl(${T.green})` }} />
                      : <Circle className="w-4 h-4 shrink-0 text-muted-foreground" />}
                    <span className={h.done ? "line-through text-muted-foreground" : ""}>{h.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        )}

        {has.missed && (
        <SectionCard onOpen={open("missed")} testId="wellness-missed-habits" title="Missed Habits" icon={AlertTriangle} tone={T.amber}
          badge={missedHabits.length ? `${missedHabits.length} to do` : undefined} viewAllHref="/habits">
          {missedHabits.length === 0 ? <Empty text="All habits on track today. ✓" /> : (
            <ul className="space-y-1.5">
              {missedHabits.slice(0, 7).map((h) => (
                <li key={h.id}>
                  <button className="w-full flex items-center gap-2 text-left text-sm disabled:opacity-60"
                    disabled={togglingHabitId === h.id}
                    onClick={() => onToggleHabit?.(h.id, true)} data-testid={`wellness-missed-${h.id}`}>
                    <Circle className="w-4 h-4 shrink-0 text-amber-500" />
                    <span>{h.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        )}

        {has.schedule && (
        <SectionCard onOpen={open("schedule")} testId="wellness-schedule" title="Today's Schedule" icon={CalendarClock} tone={T.blue} viewAllHref="/calendar">
          {schedule.length === 0 ? <Empty text="Your day is clear." /> : (
            <ul className="space-y-2">
              {schedule.slice(0, 6).map((e) => (
                <li key={e.id} className="flex items-center gap-3 text-sm" data-testid={`wellness-event-${e.id}`}>
                  <span className="text-[11px] text-muted-foreground w-16 shrink-0">{e.time}</span>
                  <span className="truncate">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        )}

        {has.meds && (
        <SectionCard onOpen={open("meds")} testId="wellness-medications" title="Medications" icon={Pill} tone={T.pink}
          badge={dueMeds > 0 ? `${dueMeds} due` : "all taken"} viewAllHref="/obligations">
          {medications.length === 0 ? <Empty text="No medications to track." /> : (
            <ul className="space-y-1.5">
              {medications.slice(0, 6).map((m) => (
                <li key={m.id} className="flex items-center gap-2 text-sm" data-testid={`wellness-med-${m.id}`}>
                  <button onClick={() => onToggleMed?.(m.id, !m.taken)} disabled={!onToggleMed || togglingMedId === m.id}
                    className="disabled:opacity-50" aria-label={m.taken ? "mark not taken" : "mark taken"}
                    data-testid={`wellness-med-toggle-${m.id}`}>
                    {m.taken
                      ? <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: `hsl(${T.green})` }} />
                      : <Circle className="w-4 h-4 shrink-0 text-red-500" />}
                  </button>
                  <span className="flex-1 truncate">{m.name}{m.dose ? ` ${m.dose}` : ""}</span>
                  {m.time && <span className="text-[11px] text-muted-foreground">{m.time}</span>}
                  <span className={`text-[11px] ${m.taken ? "text-emerald-500" : "text-red-500"}`}>{m.taken ? "Taken" : "Due"}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
        )}
      </div>

      {/* ── Aggregate / list cards — appointments · reminders · labs ·
           supplements · documents · conditions · allergies · activity —
           each rendered ONLY when it has data (dynamic, no empty cards). ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {has.appts && (
        <SectionCard onOpen={open("appts")} testId="wellness-appointments" title="Upcoming Appointments" icon={CalendarClock} tone={T.blue}
          badge={`${appointments.length} upcoming`} viewAllHref="/calendar">
          <ul className="space-y-2 text-sm">
            {appointments.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-center gap-2" data-testid={`wellness-appt-${a.id}`}>
                <span className="text-[11px] text-muted-foreground w-24 shrink-0">{a.date}{a.time ? ` ${a.time}` : ""}</span>
                <span className="truncate">{a.title}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.reminders && (
        <SectionCard onOpen={open("reminders")} testId="wellness-reminders" title="Health Reminders" icon={Bell} tone={T.amber}
          badge={`${reminders.length} active`}>
          <ul className="space-y-1.5 text-xs">
            {reminders.slice(0, 5).map((r, i) => (
              <li key={i} className="flex items-start gap-2"><Bell className="w-3 h-3 mt-0.5 shrink-0" style={{ color: `hsl(${T.amber})` }} /><span>{r}</span></li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.labs && (
        <SectionCard onOpen={open("labs")} testId="wellness-labs" title="Lab Results" icon={FlaskConical} tone={T.teal} viewAllHref="/trackers">
          <ul className="space-y-2 text-sm">
            {labs.slice(0, 5).map((l) => (
              <li key={l.id} className="flex items-center gap-2" data-testid={`wellness-lab-${l.id}`}>
                <span className="truncate flex-1">{l.name}</span>
                {l.date && <span className="text-[11px] text-muted-foreground">{l.date}</span>}
                {l.status && <span className="text-[11px]" style={{ color: `hsl(${T.green})` }}>{l.status}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.supps && (
        <SectionCard onOpen={open("supps")} testId="wellness-supplements" title="Supplements" icon={Leaf} tone={T.green}
          badge={`${supplements.length} active`} viewAllHref="/obligations">
          <ul className="space-y-1.5 text-sm">
            {supplements.slice(0, 5).map((s) => (
              <li key={s.id} className="flex items-center gap-2" data-testid={`wellness-supp-${s.id}`}>
                <Leaf className="w-3 h-3 shrink-0" style={{ color: `hsl(${T.green})` }} />
                <span className="flex-1 truncate">{s.name}{s.dose ? ` ${s.dose}` : ""}</span>
                {s.schedule && <span className="text-[11px] text-muted-foreground">{s.schedule}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.docs && (
        <SectionCard onOpen={open("docs")} testId="wellness-documents" title="Health Documents" icon={FileText} tone={T.blue}
          badge={`${documents.length} docs`} viewAllHref="/linked?tab=documents">
          <ul className="space-y-2 text-sm">
            {documents.slice(0, 5).map((d) => (
              <li key={d.id} className="flex items-center gap-2" data-testid={`wellness-doc-${d.id}`}>
                <FileText className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{d.name}</span>
                {d.date && <span className="text-[11px] text-muted-foreground">{d.date}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.conditions && (
        <SectionCard onOpen={open("conditions")} testId="wellness-conditions" title="Medical Conditions" icon={Stethoscope} tone={T.orange}
          badge={`${conditions.length} known`}>
          <ul className="space-y-2 text-sm">
            {conditions.slice(0, 5).map((c) => (
              <li key={c.id} data-testid={`wellness-condition-${c.id}`}>
                <div className="font-medium">{c.name}</div>
                {c.note && <div className="text-[11px] text-muted-foreground">{c.note}</div>}
              </li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.allergies && (
        <SectionCard onOpen={open("allergies")} testId="wellness-allergies" title="Allergies" icon={AlertTriangle} tone={T.red}
          badge={`${allergies.length} known`}>
          <ul className="space-y-2 text-sm">
            {allergies.slice(0, 5).map((a) => (
              <li key={a.id} data-testid={`wellness-allergy-${a.id}`}>
                <div className="font-medium">{a.name}</div>
                {a.note && <div className="text-[11px] text-muted-foreground">{a.note}</div>}
              </li>
            ))}
          </ul>
        </SectionCard>
        )}

        {has.activity && (
        <SectionCard onOpen={open("recent")} testId="wellness-activity" title="Recent Activity" icon={Activity} tone={T.teal}>
          <ul className="space-y-2 text-sm">
            {recentActivity.slice(0, 6).map((r) => (
              <li key={r.id} className="flex items-center gap-2" data-testid={`wellness-activity-${r.id}`}>
                <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: `hsl(${T.teal})` }} />
                <span className="flex-1 truncate">{r.text}</span>
                {r.when && <span className="text-[11px] text-muted-foreground shrink-0">{r.when}</span>}
              </li>
            ))}
          </ul>
        </SectionCard>
        )}
      </div>
    </div>
  );
}
