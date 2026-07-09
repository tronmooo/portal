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
  CheckCircle2, Circle, Footprints, Dumbbell, Plus, TrendingUp, TrendingDown,
} from "lucide-react";

// ── shared bits ──────────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined, dp = 0) =>
  n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: dp });

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
function KpiTile({ label, value, unit, sub, tone, series, icon: Icon, ring, testId }: {
  label: string; value: string; unit?: string; sub?: string; tone: string;
  series?: number[]; icon: any; ring?: { value: number; max: number }; testId: string;
}) {
  return (
    <Card className="p-3 min-w-[8.5rem] flex-1 card-lift transition-all" data-testid={testId}
      style={{ borderColor: `hsl(${tone} / 0.30)`, background: `linear-gradient(135deg, hsl(${tone} / 0.12) 0%, hsl(var(--card)) 75%)` }}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3 h-3" style={{ color: `hsl(${tone})` }} /> {label}
      </div>
      <div className="flex items-end justify-between mt-1">
        <div>
          <div className="metric-value text-2xl leading-none" style={{ color: `hsl(${tone})` }}>{value}</div>
          {unit && <div className="text-[10px] text-muted-foreground mt-0.5">{unit}</div>}
        </div>
        {ring && <Ring value={ring.value} max={ring.max} color={tone} label="" />}
      </div>
      {series && series.length >= 2 && <div className="mt-1.5"><Spark series={series} color={tone} /></div>}
      {sub && <div className="text-[10px] text-muted-foreground mt-1">{sub}</div>}
    </Card>
  );
}

// A titled card with an accent header + optional "View all →".
function SectionCard({ title, icon: Icon, tone, badge, viewAllHref, onViewAll, children, testId }: {
  title: string; icon: any; tone: string; badge?: string;
  viewAllHref?: string; onViewAll?: () => void; children: React.ReactNode; testId: string;
}) {
  return (
    <Card className="p-4 flex flex-col" data-testid={testId} style={{ borderColor: `hsl(${tone} / 0.22)` }}>
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: `hsl(${tone})` }}>
          <Icon className="w-3.5 h-3.5" /> {title}
        </span>
        {badge && <span className="text-[10px] text-muted-foreground">{badge}</span>}
      </div>
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
}

const T = {
  green: "155 65% 45%", teal: "173 60% 44%", blue: "213 90% 62%", cyan: "199 89% 60%",
  purple: "262 70% 62%", pink: "330 75% 62%", amber: "38 96% 54%", orange: "25 90% 58%",
  red: "0 72% 58%", indigo: "240 60% 65%",
};

export function WellnessOverview(props: WellnessOverviewProps) {
  const {
    wellnessScore, wellnessScoreLabel, sleepHours, sleepSeries, steps, stepsSeries,
    restingHr, restingHrSeries, hydrationOz, hydrationGoal, calories, caloriesGoal, streak,
    insights, habits, habitsCompleted, onToggleHabit, togglingHabitId,
    missedHabits = [], meditationMin, recoveryScore,
    schedule, medications, onToggleMed, togglingMedId, vitals, sleep, nutrition, mood, activity,
    appointments, reminders, labs, supplements, documents, conditions, allergies,
    recentActivity, weightUnit = "lbs", onQuickLog,
  } = props;

  const dueMeds = medications.filter((m) => !m.taken).length;

  return (
    <div className="space-y-3" data-testid="wellness-overview">
      {/* ── KPI strip ── */}
      <div className="flex flex-wrap gap-2" data-testid="wellness-kpis">
        <KpiTile testId="wellness-kpi-score" label="Wellness Score" tone={wellnessScore != null && wellnessScore >= 80 ? T.green : wellnessScore != null && wellnessScore >= 60 ? T.amber : T.red}
          icon={Sparkles} value={wellnessScore != null ? String(wellnessScore) : "—"} unit={wellnessScoreLabel} />
        <KpiTile testId="wellness-kpi-sleep" label="Sleep" tone={T.purple} icon={Moon}
          value={sleepHours != null ? `${fmt(sleepHours, 1)}h` : "—"} sub="last night" series={sleepSeries} />
        <KpiTile testId="wellness-kpi-activity" label="Activity" tone={T.blue} icon={Footprints}
          value={fmt(steps)} unit="steps" series={stepsSeries} />
        <KpiTile testId="wellness-kpi-hr" label="Resting HR" tone={T.green} icon={Heart}
          value={restingHr != null ? String(restingHr) : "—"} unit="bpm" series={restingHrSeries} />
        <KpiTile testId="wellness-kpi-hydration" label="Hydration" tone={T.cyan} icon={Droplet}
          value={fmt(hydrationOz)} unit={`/ ${hydrationGoal} oz`} ring={{ value: hydrationOz || 0, max: hydrationGoal }} />
        <KpiTile testId="wellness-kpi-calories" label="Calories" tone={T.orange} icon={Flame}
          value={fmt(calories)} unit={`/ ${caloriesGoal} kcal`} ring={{ value: calories || 0, max: caloriesGoal }} />
        <KpiTile testId="wellness-kpi-streak" label="Streak" tone={T.orange} icon={Flame}
          value={streak != null ? String(streak) : "—"} unit="days" />
      </div>

      {/* ── Row: AI insights · habits · schedule · medications ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <SectionCard testId="wellness-insights" title="AI Wellness Insights" icon={Sparkles} tone={T.purple}>
          {insights.length === 0 ? <Empty text="Log a few days of trackers to unlock insights." /> : (
            <ul className="space-y-2">
              {insights.slice(0, 5).map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Sparkles className="w-3 h-3 mt-0.5 shrink-0" style={{ color: `hsl(${T.purple})` }} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-habits" title="Today's Habits" icon={CheckCircle2} tone={T.green}
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

        <SectionCard testId="wellness-missed-habits" title="Missed Habits" icon={AlertTriangle} tone={T.amber}
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

        <SectionCard testId="wellness-schedule" title="Today's Schedule" icon={CalendarClock} tone={T.blue} viewAllHref="/calendar">
          {schedule.length === 0 ? <Empty text="Nothing scheduled today." /> : (
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

        <SectionCard testId="wellness-medications" title="Medications" icon={Pill} tone={T.pink}
          badge={dueMeds > 0 ? `${dueMeds} due` : "all taken"} viewAllHref="/obligations">
          {medications.length === 0 ? <Empty text="No medications tracked." /> : (
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
                  <span className={`text-[10px] ${m.taken ? "text-emerald-500" : "text-red-500"}`}>{m.taken ? "Taken" : "Due"}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* ── Row: vitals · sleep · nutrition · hydration · exercise ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <SectionCard testId="wellness-vitals" title="Vitals Overview" icon={HeartPulse} tone={T.red} viewAllHref="/trackers">
          {vitals.length === 0 ? <Empty text="No vitals logged yet." /> : (
            <ul className="space-y-2">
              {vitals.map((v, i) => (
                <li key={i} className="flex items-center gap-2 text-sm" data-testid={`wellness-vital-${i}`}>
                  {v.icon ? <v.icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />}
                  <span className="text-muted-foreground">{v.label}</span>
                  <span className="ml-auto tabular-nums font-semibold flex items-center gap-1">{v.value}{trendIcon(v.change)}</span>
                </li>
              ))}
            </ul>
          )}
          <LogButton label="Log weight" onClick={onQuickLog && (() => onQuickLog("weight"))} testId="wellness-log-weight" />
        </SectionCard>

        <SectionCard testId="wellness-sleep" title="Sleep Summary" icon={Moon} tone={T.purple} viewAllHref="/trackers">
          {sleep?.hours == null ? <Empty text="No sleep logged." /> : (
            <div className="flex items-center gap-4">
              <div>
                <div className="text-2xl font-bold tabular-nums" style={{ color: `hsl(${T.purple})` }}>{fmt(sleep.hours, 1)}h</div>
                <div className="text-[10px] text-muted-foreground">total sleep</div>
              </div>
              <ul className="text-xs text-muted-foreground space-y-1 flex-1">
                {sleep.deep != null && <li className="flex justify-between"><span>Deep</span><span className="tabular-nums">{fmt(sleep.deep, 1)}h</span></li>}
                {sleep.rem != null && <li className="flex justify-between"><span>REM</span><span className="tabular-nums">{fmt(sleep.rem, 1)}h</span></li>}
                {sleep.efficiency != null && <li className="flex justify-between"><span>Efficiency</span><span className="tabular-nums">{fmt(sleep.efficiency)}%</span></li>}
              </ul>
            </div>
          )}
          <LogButton label="Log sleep" onClick={onQuickLog && (() => onQuickLog("sleep"))} testId="wellness-log-sleep" />
        </SectionCard>

        <SectionCard testId="wellness-nutrition" title="Nutrition Summary" icon={Flame} tone={T.orange}>
          {nutrition?.calories == null ? <Empty text="No nutrition logged." /> : (
            <div className="flex items-center gap-4">
              <Ring value={nutrition.calories || 0} max={nutrition.caloriesGoal || 2300} color={T.orange} label="kcal" unit="kcal" />
              <ul className="text-xs space-y-1 flex-1">
                {nutrition.protein != null && <li className="flex justify-between"><span className="text-muted-foreground">Protein</span><span className="tabular-nums font-semibold">{fmt(nutrition.protein)}g</span></li>}
                {nutrition.carbs != null && <li className="flex justify-between"><span className="text-muted-foreground">Carbs</span><span className="tabular-nums font-semibold">{fmt(nutrition.carbs)}g</span></li>}
                {nutrition.fats != null && <li className="flex justify-between"><span className="text-muted-foreground">Fats</span><span className="tabular-nums font-semibold">{fmt(nutrition.fats)}g</span></li>}
                <li className="flex justify-between border-t border-border/50 pt-1"><span className="text-muted-foreground">Calories</span><span className="tabular-nums font-semibold">{fmt(nutrition.calories)} / {fmt(nutrition.caloriesGoal)}</span></li>
              </ul>
            </div>
          )}
        </SectionCard>

        <SectionCard testId="wellness-hydration" title="Hydration" icon={Droplet} tone={T.cyan} viewAllHref="/trackers">
          <div className="flex items-center gap-4">
            <Ring value={hydrationOz || 0} max={hydrationGoal} color={T.cyan} label="oz" unit="oz" />
            <div className="flex-1">
              <div className="text-sm"><span className="font-semibold tabular-nums">{fmt(hydrationOz)}</span> <span className="text-muted-foreground">/ {hydrationGoal} oz today</span></div>
              <Button size="sm" variant="outline" className="h-7 text-xs mt-2" onClick={() => onQuickLog?.("hydration")} data-testid="wellness-log-hydration">
                <Plus className="w-3 h-3 mr-1" /> Log water
              </Button>
            </div>
          </div>
        </SectionCard>

        <SectionCard testId="wellness-exercise" title="Exercise & Activity" icon={Dumbbell} tone={T.green} viewAllHref="/trackers">
          {!activity || (activity.workouts == null && activity.activeMin == null && activity.caloriesBurned == null)
            ? <Empty text="No workouts logged this week." /> : (
            <ul className="space-y-2 text-sm">
              {activity.workouts != null && <li className="flex items-center gap-2"><Dumbbell className="w-3.5 h-3.5" style={{ color: `hsl(${T.green})` }} /><span className="text-muted-foreground">Workouts</span><span className="ml-auto tabular-nums font-semibold">{activity.workouts}</span></li>}
              {activity.activeMin != null && <li className="flex items-center gap-2"><Activity className="w-3.5 h-3.5" style={{ color: `hsl(${T.green})` }} /><span className="text-muted-foreground">Active time</span><span className="ml-auto tabular-nums font-semibold">{fmt(activity.activeMin)} min</span></li>}
              {activity.caloriesBurned != null && <li className="flex items-center gap-2"><Flame className="w-3.5 h-3.5" style={{ color: `hsl(${T.green})` }} /><span className="text-muted-foreground">Calories burned</span><span className="ml-auto tabular-nums font-semibold">{fmt(activity.caloriesBurned)}</span></li>}
            </ul>
          )}
          <LogButton label="Log steps" onClick={onQuickLog && (() => onQuickLog("steps"))} testId="wellness-log-steps" />
        </SectionCard>

        <SectionCard testId="wellness-mood" title="Mood & Wellness" icon={Brain} tone={T.pink} viewAllHref="/trackers">
          {mood?.value == null ? <Empty text="No mood logged." /> : (
            <div>
              <div className="text-2xl font-bold tabular-nums" style={{ color: `hsl(${T.pink})` }}>{fmt(mood.value, 1)}<span className="text-sm text-muted-foreground"> / 10</span></div>
              {mood.series.length >= 2 && <div className="mt-2"><Spark series={mood.series} color={T.pink} /></div>}
            </div>
          )}
          <LogButton label="Log mood" onClick={onQuickLog && (() => onQuickLog("mood"))} testId="wellness-log-mood" />
        </SectionCard>

        <SectionCard testId="wellness-mental" title="Mental Wellness" icon={Brain} tone={T.purple} viewAllHref="/trackers">
          {meditationMin == null ? (
            <Empty text="No mindfulness logged. Ask the AI to start a meditation tracker." />
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <Brain className="w-3.5 h-3.5" style={{ color: `hsl(${T.purple})` }} />
              <span className="text-muted-foreground">Mindfulness today</span>
              <span className="ml-auto metric-value text-lg" style={{ color: `hsl(${T.purple})` }}>{fmt(meditationMin)} min</span>
            </div>
          )}
        </SectionCard>

        <SectionCard testId="wellness-recovery" title="Recovery" icon={Activity} tone={T.teal}>
          {recoveryScore == null ? (
            <Empty text="No recovery data. Log sleep + resting HR, or connect a wearable." />
          ) : (
            <div className="flex items-center gap-4">
              <Ring value={recoveryScore} max={100} color={T.teal} label="score" unit="score" />
              <div className="text-sm text-muted-foreground">Readiness based on sleep + resting HR.</div>
            </div>
          )}
        </SectionCard>
      </div>

      {/* ── Row: appointments · reminders · labs · supplements ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <SectionCard testId="wellness-appointments" title="Upcoming Appointments" icon={CalendarClock} tone={T.blue}
          badge={appointments.length ? `${appointments.length} upcoming` : undefined} viewAllHref="/calendar">
          {appointments.length === 0 ? <Empty text="No upcoming appointments." /> : (
            <ul className="space-y-2 text-sm">
              {appointments.slice(0, 5).map((a) => (
                <li key={a.id} className="flex items-center gap-2" data-testid={`wellness-appt-${a.id}`}>
                  <span className="text-[11px] text-muted-foreground w-24 shrink-0">{a.date}{a.time ? ` ${a.time}` : ""}</span>
                  <span className="truncate">{a.title}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-reminders" title="Health Reminders" icon={Bell} tone={T.amber}
          badge={reminders.length ? `${reminders.length} active` : undefined}>
          {reminders.length === 0 ? <Empty text="No active reminders." /> : (
            <ul className="space-y-1.5 text-xs">
              {reminders.slice(0, 5).map((r, i) => (
                <li key={i} className="flex items-start gap-2"><Bell className="w-3 h-3 mt-0.5 shrink-0" style={{ color: `hsl(${T.amber})` }} /><span>{r}</span></li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-labs" title="Lab Results" icon={FlaskConical} tone={T.teal} viewAllHref="/trackers">
          {labs.length === 0 ? <Empty text="No lab results tracked." /> : (
            <ul className="space-y-2 text-sm">
              {labs.slice(0, 5).map((l) => (
                <li key={l.id} className="flex items-center gap-2" data-testid={`wellness-lab-${l.id}`}>
                  <span className="truncate flex-1">{l.name}</span>
                  {l.date && <span className="text-[10px] text-muted-foreground">{l.date}</span>}
                  {l.status && <span className="text-[10px]" style={{ color: `hsl(${T.green})` }}>{l.status}</span>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-supplements" title="Supplements" icon={Leaf} tone={T.green}
          badge={supplements.length ? `${supplements.length} active` : undefined} viewAllHref="/obligations">
          {supplements.length === 0 ? <Empty text="No supplements tracked." /> : (
            <ul className="space-y-1.5 text-sm">
              {supplements.slice(0, 5).map((s) => (
                <li key={s.id} className="flex items-center gap-2" data-testid={`wellness-supp-${s.id}`}>
                  <Leaf className="w-3 h-3 shrink-0" style={{ color: `hsl(${T.green})` }} />
                  <span className="flex-1 truncate">{s.name}{s.dose ? ` ${s.dose}` : ""}</span>
                  {s.schedule && <span className="text-[10px] text-muted-foreground">{s.schedule}</span>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      {/* ── Row: documents · conditions · allergies · recent activity ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <SectionCard testId="wellness-documents" title="Health Documents" icon={FileText} tone={T.blue}
          badge={documents.length ? `${documents.length} docs` : undefined} viewAllHref="/linked?tab=documents">
          {documents.length === 0 ? <Empty text="No health documents." /> : (
            <ul className="space-y-2 text-sm">
              {documents.slice(0, 5).map((d) => (
                <li key={d.id} className="flex items-center gap-2" data-testid={`wellness-doc-${d.id}`}>
                  <FileText className="w-3 h-3 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{d.name}</span>
                  {d.date && <span className="text-[10px] text-muted-foreground">{d.date}</span>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-conditions" title="Medical Conditions" icon={Stethoscope} tone={T.orange}
          badge={conditions.length ? `${conditions.length} known` : undefined}>
          {conditions.length === 0 ? <Empty text="No conditions recorded." /> : (
            <ul className="space-y-2 text-sm">
              {conditions.slice(0, 5).map((c) => (
                <li key={c.id} data-testid={`wellness-condition-${c.id}`}>
                  <div className="font-medium">{c.name}</div>
                  {c.note && <div className="text-[11px] text-muted-foreground">{c.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-allergies" title="Allergies" icon={AlertTriangle} tone={T.red}
          badge={allergies.length ? `${allergies.length} known` : undefined}>
          {allergies.length === 0 ? <Empty text="No allergies recorded." /> : (
            <ul className="space-y-2 text-sm">
              {allergies.slice(0, 5).map((a) => (
                <li key={a.id} data-testid={`wellness-allergy-${a.id}`}>
                  <div className="font-medium">{a.name}</div>
                  {a.note && <div className="text-[11px] text-muted-foreground">{a.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard testId="wellness-activity" title="Recent Activity" icon={Activity} tone={T.teal}>
          {recentActivity.length === 0 ? <Empty text="No recent activity." /> : (
            <ul className="space-y-2 text-sm">
              {recentActivity.slice(0, 6).map((r) => (
                <li key={r.id} className="flex items-center gap-2" data-testid={`wellness-activity-${r.id}`}>
                  <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: `hsl(${T.teal})` }} />
                  <span className="flex-1 truncate">{r.text}</span>
                  {r.when && <span className="text-[10px] text-muted-foreground shrink-0">{r.when}</span>}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
