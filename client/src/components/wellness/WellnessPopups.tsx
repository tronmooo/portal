// ── Wellness popups ──────────────────────────────────────────────────────────
// Every KPI tile and section card on the Wellness tab now opens a detail popup,
// in the same visual language as the Executive tab (BubbleModal: medallion
// header, count pill, rounded rows, semantic colour).
//
// Hard rule: these render ENTIRELY from props the page has already fetched.
// Opening one issues no request and shows no loading state — the data behind a
// KPI is the same data that produced the number on the tile.
//
// A few are more than a list, because a list would waste the space:
//   * Wellness Score → what actually moved it, as contribution bars.
//   * A metric (sleep / steps / resting HR / hydration / calories) → a 7-day
//     bar chart with latest, average, best and trend read off the same series
//     that draws the tile's sparkline.
//   * Streak → an 8-week check-in heatmap, so a broken run is visible rather
//     than described.
//   * Medications → an adherence ring over the day's doses.

import { useMemo } from "react";
import {
  Sparkles, Moon, Footprints, Heart, Droplet, Flame, CheckCircle2, Circle,
  AlertTriangle, CalendarClock, Pill, Bell, FlaskConical, Leaf, FileText,
  Stethoscope, Activity, type LucideIcon,
} from "lucide-react";
import { BubbleModal, BubbleRow, BubbleEmpty } from "@/components/ui/bubble-modal";
import { MiniBars, ProgressRing, Pill as TonePill, CountUp } from "@/components/dashboard/visuals";
import type {
  WellnessHabit, WellnessEvent, WellnessMed, WellnessAppt, WellnessLab,
  WellnessSupp, WellnessDoc, WellnessListItem, WellnessActivityItem,
} from "./WellnessOverview";

export type WellnessPopupKind =
  | "score" | "sleep" | "activity" | "hr" | "hydration" | "calories" | "streak"
  | "habits" | "missed" | "schedule" | "meds" | "appts" | "reminders"
  | "labs" | "supps" | "docs" | "conditions" | "allergies" | "recent" | "insights";

const T = {
  green: "155 65% 45%", teal: "173 60% 44%", blue: "213 90% 62%", cyan: "199 89% 60%",
  purple: "262 70% 62%", pink: "330 75% 62%", amber: "38 96% 54%", orange: "25 90% 58%",
  red: "0 72% 58%",
};

export interface WellnessPopupData {
  wellnessScore: number | null;
  wellnessScoreLabel?: string;
  sleepHours: number | null; sleepSeries?: number[];
  steps: number | null; stepsSeries?: number[];
  restingHr: number | null; restingHrSeries?: number[];
  hydrationOz: number | null; hydrationGoal: number;
  calories: number | null; caloriesGoal: number;
  streak: number | null;
  /** YYYY-MM-DD strings the user checked in on — powers the streak heatmap. */
  checkinDates?: string[];
  insights: string[];
  aiNarrative?: string | null;
  habits: WellnessHabit[];
  missedHabits?: WellnessHabit[];
  schedule: WellnessEvent[];
  medications: WellnessMed[];
  appointments: WellnessAppt[];
  reminders: string[];
  labs: WellnessLab[];
  supplements: WellnessSupp[];
  documents: WellnessDoc[];
  conditions: WellnessListItem[];
  allergies: WellnessListItem[];
  recentActivity: WellnessActivityItem[];
  onToggleHabit?: (id: string, next: boolean) => void;
  togglingHabitId?: string | null;
  onToggleMed?: (id: string, next: boolean) => void;
  togglingMedId?: string | null;
}

// ── shared bits ──────────────────────────────────────────────────────────────

const fmt = (n: number | null | undefined, dp = 0) =>
  n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: dp });

/** Latest · average · best, read off the same series the tile sparkline uses. */
function StatStrip({ series, unit, accent, lowerIsBetter }: {
  series: number[]; unit?: string; accent: string; lowerIsBetter?: boolean;
}) {
  const clean = series.filter((n) => Number.isFinite(n));
  if (clean.length === 0) return null;
  const latest = clean[clean.length - 1];
  const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
  const best = lowerIsBetter ? Math.min(...clean) : Math.max(...clean);
  const cells: Array<[string, number]> = [["Latest", latest], ["Average", avg], [lowerIsBetter ? "Lowest" : "Best", best]];
  return (
    <div className="grid grid-cols-3 gap-2">
      {cells.map(([label, v]) => (
        <div key={label} className="bubble-row px-3 py-2.5 text-center" style={{ ["--accent-hsl" as any]: accent }}>
          <p className="micro-label text-muted-foreground">{label}</p>
          <p className="metric-value text-lg mt-0.5" style={{ color: `hsl(${accent})` }}>
            {fmt(v, 1)}<span className="text-[11px] font-semibold ml-0.5">{unit}</span>
          </p>
        </div>
      ))}
    </div>
  );
}

/** A metric popup: hero number, 7-day bars, latest/avg/best. */
function MetricBody({ value, unit, series, accent, goal, lowerIsBetter, emptyText }: {
  value: number | null; unit?: string; series?: number[]; accent: string;
  goal?: number; lowerIsBetter?: boolean; emptyText: string;
}) {
  const s = (series || []).filter((n) => Number.isFinite(n));
  if (value == null && s.length === 0) {
    return <BubbleEmpty text={emptyText} hint="Log it once and the history builds from there." />;
  }
  return (
    <>
      <div className="bubble-row flex items-center gap-4 px-4 py-4" style={{ ["--accent-hsl" as any]: accent }}>
        {goal ? (
          <ProgressRing value={value ?? 0} total={goal} accent={accent} size={64} stroke={6}
            label={`${Math.round(((value ?? 0) / goal) * 100)}%`} />
        ) : null}
        <div className="min-w-0">
          <p className="metric-value text-3xl" style={{ color: `hsl(${accent})` }}>
            <CountUp value={Math.round(value ?? 0)} />
            {unit && <span className="text-sm font-semibold ml-1">{unit}</span>}
          </p>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {goal ? `of ${fmt(goal)}${unit ? ` ${unit}` : ""} today` : "today"}
          </p>
        </div>
      </div>
      {s.length >= 2 && (
        <div className="bubble-row px-4 py-3" style={{ ["--accent-hsl" as any]: accent }}>
          <p className="micro-label text-muted-foreground mb-2">
            Last {s.length} readings
          </p>
          <MiniBars values={s} accent={accent} height={44} />
        </div>
      )}
      {s.length >= 2 && <StatStrip series={s} unit={unit} accent={accent} lowerIsBetter={lowerIsBetter} />}
    </>
  );
}

/** 8-week check-in heatmap — a broken run should be visible, not described. */
function StreakHeatmap({ dates, accent }: { dates: string[]; accent: string }) {
  const set = useMemo(() => new Set(dates.map((d) => String(d).slice(0, 10))), [dates]);
  const days = useMemo(() => {
    const out: Array<{ iso: string; on: boolean }> = [];
    const d = new Date();
    for (let i = 55; i >= 0; i--) {
      const x = new Date(d);
      x.setDate(x.getDate() - i);
      const iso = x.toLocaleDateString("en-CA");
      out.push({ iso, on: set.has(iso) });
    }
    return out;
  }, [set]);
  return (
    <div className="bubble-row px-4 py-3" style={{ ["--accent-hsl" as any]: accent }}>
      <p className="micro-label text-muted-foreground mb-2">Last 8 weeks</p>
      <div className="grid grid-flow-col grid-rows-7 gap-[3px]" role="img" aria-label={`${dates.length} check-ins in the last 8 weeks`}>
        {days.map((d) => (
          <span
            key={d.iso}
            title={d.iso}
            className="rounded-[3px]"
            style={{
              width: 12, height: 12,
              background: d.on ? `hsl(${accent} / 0.85)` : "hsl(var(--muted-foreground) / 0.13)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

const CheckMark = ({ done, accent }: { done: boolean; accent: string }) =>
  done
    ? <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: `hsl(${accent})` }} />
    : <Circle className="h-5 w-5 shrink-0 text-muted-foreground/50" />;

// ── registry ─────────────────────────────────────────────────────────────────

interface Meta { title: string; icon: LucideIcon; accent: string; href?: string; footer?: string }

const META: Record<WellnessPopupKind, Meta> = {
  score:      { title: "Wellness Score",       icon: Sparkles,      accent: T.purple },
  sleep:      { title: "Sleep",                icon: Moon,          accent: T.purple, href: "/trackers", footer: "Open trackers" },
  activity:   { title: "Activity",             icon: Footprints,    accent: T.blue,   href: "/trackers", footer: "Open trackers" },
  hr:         { title: "Resting Heart Rate",   icon: Heart,         accent: T.green,  href: "/trackers", footer: "Open trackers" },
  hydration:  { title: "Hydration",            icon: Droplet,       accent: T.cyan,   href: "/trackers", footer: "Open trackers" },
  calories:   { title: "Calories",             icon: Flame,         accent: T.orange, href: "/trackers", footer: "Open trackers" },
  streak:     { title: "Check-in Streak",      icon: Flame,         accent: T.orange, href: "/dashboard/habits", footer: "Open habits" },
  habits:     { title: "Today's Habits",       icon: CheckCircle2,  accent: T.green,  href: "/dashboard/habits", footer: "Open habits" },
  missed:     { title: "Missed Habits",        icon: AlertTriangle, accent: T.amber,  href: "/dashboard/habits", footer: "Open habits" },
  schedule:   { title: "Today's Schedule",     icon: CalendarClock, accent: T.blue,   href: "/calendar", footer: "Open calendar" },
  meds:       { title: "Medications",          icon: Pill,          accent: T.pink,   href: "/trackers", footer: "Open trackers" },
  appts:      { title: "Appointments",         icon: CalendarClock, accent: T.blue,   href: "/calendar", footer: "Open calendar" },
  reminders:  { title: "Health Reminders",     icon: Bell,          accent: T.amber,  href: "/calendar", footer: "Open calendar" },
  labs:       { title: "Lab Results",          icon: FlaskConical,  accent: T.teal,   href: "/trackers", footer: "Open trackers" },
  supps:      { title: "Supplements",          icon: Leaf,          accent: T.green,  href: "/trackers", footer: "Open trackers" },
  docs:       { title: "Health Documents",     icon: FileText,      accent: T.blue },
  conditions: { title: "Medical Conditions",   icon: Stethoscope,   accent: T.orange, href: "/profiles", footer: "Open profile" },
  allergies:  { title: "Allergies",            icon: AlertTriangle, accent: T.red,    href: "/profiles", footer: "Open profile" },
  recent:     { title: "Recent Activity",      icon: Activity,      accent: T.teal },
  insights:   { title: "AI Wellness Insights", icon: Sparkles,      accent: T.purple },
};

export function WellnessPopup({ kind, onClose, d }: {
  kind: WellnessPopupKind; onClose: () => void; d: WellnessPopupData;
}) {
  const meta = META[kind];
  const a = meta.accent;

  const { body, count, subtitle } = renderBody(kind, d, a);

  return (
    <BubbleModal
      open
      onClose={onClose}
      title={meta.title}
      subtitle={subtitle}
      icon={meta.icon}
      accent={a}
      count={count}
      footerHref={meta.href}
      footerLabel={meta.footer}
      testId={`wellness-popup-${kind}`}
    >
      {body}
    </BubbleModal>
  );
}

function renderBody(kind: WellnessPopupKind, d: WellnessPopupData, a: string):
  { body: React.ReactNode; count?: number; subtitle?: string } {
  switch (kind) {
    // ── Score: what actually moved it ────────────────────────────────────────
    case "score": {
      const parts: Array<{ label: string; got: number | null; goal: number; unit?: string; tone: string }> = [
        { label: "Sleep", got: d.sleepHours, goal: 8, unit: "h", tone: T.purple },
        { label: "Activity", got: d.steps, goal: 10000, unit: "steps", tone: T.blue },
        { label: "Hydration", got: d.hydrationOz, goal: d.hydrationGoal, unit: "oz", tone: T.cyan },
        { label: "Habits", got: d.habits.filter(h => h.done).length, goal: Math.max(1, d.habits.length), unit: "done", tone: T.green },
      ].filter(p => p.got != null);
      return {
        subtitle: d.wellnessScoreLabel,
        body: (
          <>
            <div className="bubble-row flex items-center gap-4 px-4 py-4" style={{ ["--accent-hsl" as any]: a }}>
              <ProgressRing value={d.wellnessScore ?? 0} total={100} accent={a} size={72} stroke={7}
                label={String(d.wellnessScore ?? "—")} />
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">{d.wellnessScoreLabel || "Today's score"}</p>
                <p className="text-[12px] text-muted-foreground mt-0.5">
                  Built from the signals you actually log — nothing you don't track counts against you.
                </p>
              </div>
            </div>
            {parts.length === 0
              ? <BubbleEmpty text="Nothing feeding the score yet" hint="Log sleep, steps, water or a habit to start it." />
              : parts.map((p) => {
                  const pct = Math.max(0, Math.min(1, (p.got ?? 0) / (p.goal || 1)));
                  return (
                    <div key={p.label} className="bubble-row px-3 py-2.5" style={{ ["--accent-hsl" as any]: p.tone }}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13px] font-semibold">{p.label}</span>
                        <span className="text-[12px] tabular-nums" style={{ color: `hsl(${p.tone})` }}>
                          {fmt(p.got, 1)} / {fmt(p.goal)} {p.unit}
                        </span>
                      </div>
                      <div className="mt-2 h-2 rounded-full overflow-hidden" style={{ background: `hsl(${p.tone} / 0.15)` }}>
                        <div className="h-full rounded-full transition-all duration-700"
                          style={{ width: `${pct * 100}%`, background: `hsl(${p.tone})` }} />
                      </div>
                    </div>
                  );
                })}
          </>
        ),
      };
    }

    // ── Metrics ──────────────────────────────────────────────────────────────
    case "sleep":
      return { body: <MetricBody value={d.sleepHours} unit="h" series={d.sleepSeries} accent={a} emptyText="No sleep logged yet" /> };
    case "activity":
      return { body: <MetricBody value={d.steps} unit="steps" series={d.stepsSeries} accent={a} emptyText="No activity logged yet" /> };
    case "hr":
      return { body: <MetricBody value={d.restingHr} unit="bpm" series={d.restingHrSeries} accent={a} lowerIsBetter emptyText="No heart-rate readings yet" /> };
    case "hydration":
      return { body: <MetricBody value={d.hydrationOz} unit="oz" accent={a} goal={d.hydrationGoal} emptyText="No water logged today" /> };
    case "calories":
      return { body: <MetricBody value={d.calories} unit="kcal" accent={a} goal={d.caloriesGoal} emptyText="Nothing logged today" /> };

    case "streak": {
      const dates = d.checkinDates || [];
      return {
        subtitle: d.streak ? `${d.streak}-day run` : undefined,
        body: (
          <>
            <div className="bubble-row flex items-center gap-4 px-4 py-4" style={{ ["--accent-hsl" as any]: a }}>
              <p className="metric-value text-4xl" style={{ color: `hsl(${a})` }}>
                <CountUp value={d.streak ?? 0} />
              </p>
              <div>
                <p className="text-[13px] font-semibold">{(d.streak ?? 0) === 1 ? "day" : "days"} in a row</p>
                <p className="text-[12px] text-muted-foreground mt-0.5">
                  {dates.length} check-in{dates.length === 1 ? "" : "s"} in the last 8 weeks
                </p>
              </div>
            </div>
            {dates.length > 0
              ? <StreakHeatmap dates={dates} accent={a} />
              : <BubbleEmpty text="No check-ins yet" hint="Check in on a habit to start the run." />}
          </>
        ),
      };
    }

    // ── Habits ───────────────────────────────────────────────────────────────
    case "habits":
    case "missed": {
      const rows = kind === "missed" ? (d.missedHabits || []) : d.habits;
      const done = d.habits.filter(h => h.done).length;
      return {
        count: rows.length,
        subtitle: kind === "habits" ? `${done} of ${d.habits.length} done today` : "Not checked in yet",
        body: rows.length === 0
          ? <BubbleEmpty text={kind === "missed" ? "Nothing missed — nice" : "No habits scheduled today"} />
          : <>{rows.map((h) => (
              <BubbleRow key={h.id} testId={`wellness-popup-habit-${h.id}`}
                title={h.name} accent={a}
                leading={<CheckMark done={h.done} accent={a} />}
                meta={<TonePill tone={h.done ? "good" : "attention"}>{h.done ? "Done" : "Not yet"}</TonePill>}
                onClick={d.onToggleHabit ? () => d.onToggleHabit!(h.id, !h.done) : undefined}
                right={d.togglingHabitId === h.id ? <span className="text-[11px] text-muted-foreground">…</span> : undefined}
              />
            ))}</>,
      };
    }

    // ── Medications: adherence over the day's doses ──────────────────────────
    case "meds": {
      const taken = d.medications.filter(m => m.taken).length;
      return {
        count: d.medications.length,
        subtitle: d.medications.length ? `${taken} of ${d.medications.length} taken today` : undefined,
        body: d.medications.length === 0
          ? <BubbleEmpty text="No medications tracked" hint="Add one as a medication tracker." />
          : <>
              <div className="bubble-row flex items-center gap-4 px-4 py-3" style={{ ["--accent-hsl" as any]: a }}>
                <ProgressRing value={taken} total={d.medications.length} accent={a} size={56} stroke={5} />
                <div>
                  <p className="text-[13px] font-semibold">Today's adherence</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    {taken === d.medications.length ? "All doses taken" : `${d.medications.length - taken} still due`}
                  </p>
                </div>
              </div>
              {d.medications.map((m) => (
                <BubbleRow key={m.id} testId={`wellness-popup-med-${m.id}`}
                  title={m.name} accent={a}
                  leading={<CheckMark done={m.taken} accent={a} />}
                  meta={<>
                    {m.dose && <TonePill tone="neutral">{m.dose}</TonePill>}
                    {m.time && <TonePill tone={m.taken ? "good" : "attention"}>{m.time}</TonePill>}
                  </>}
                  onClick={d.onToggleMed ? () => d.onToggleMed!(m.id, !m.taken) : undefined}
                  right={d.togglingMedId === m.id ? <span className="text-[11px] text-muted-foreground">…</span> : undefined}
                />
              ))}
            </>,
      };
    }

    // ── Simple lists ─────────────────────────────────────────────────────────
    case "schedule":
      return {
        count: d.schedule.length,
        body: d.schedule.length === 0
          ? <BubbleEmpty text="Nothing scheduled today" />
          : <>{d.schedule.map(e => (
              <BubbleRow key={e.id} title={e.title} accent={a} href="/calendar"
                meta={<TonePill tone="info">{e.time}</TonePill>} testId={`wellness-popup-sched-${e.id}`} />
            ))}</>,
      };

    case "appts":
      return {
        count: d.appointments.length,
        body: d.appointments.length === 0
          ? <BubbleEmpty text="No upcoming appointments" />
          : <>{d.appointments.map(x => (
              <BubbleRow key={x.id} title={x.title} accent={a} href="/calendar"
                meta={<><TonePill tone="info">{x.date}</TonePill>{x.time && <TonePill tone="neutral">{x.time}</TonePill>}</>}
                testId={`wellness-popup-appt-${x.id}`} />
            ))}</>,
      };

    case "reminders":
      return {
        count: d.reminders.length,
        body: d.reminders.length === 0
          ? <BubbleEmpty text="No health reminders" />
          : <>{d.reminders.map((r, i) => (
              <BubbleRow key={i} title={r} accent={a} testId={`wellness-popup-reminder-${i}`} />
            ))}</>,
      };

    case "labs":
      return {
        count: d.labs.length,
        body: d.labs.length === 0
          ? <BubbleEmpty text="No lab results yet" />
          : <>{d.labs.map(l => (
              <BubbleRow key={l.id} title={l.name} accent={a} href="/trackers"
                meta={<>{l.date && <TonePill tone="neutral">{l.date}</TonePill>}{l.status && <TonePill tone="info">{l.status}</TonePill>}</>}
                testId={`wellness-popup-lab-${l.id}`} />
            ))}</>,
      };

    case "supps":
      return {
        count: d.supplements.length,
        body: d.supplements.length === 0
          ? <BubbleEmpty text="No supplements tracked" />
          : <>{d.supplements.map(s => (
              <BubbleRow key={s.id} title={s.name} accent={a} href="/trackers"
                meta={<>{s.dose && <TonePill tone="neutral">{s.dose}</TonePill>}{s.schedule && <TonePill tone="info">{s.schedule}</TonePill>}</>}
                testId={`wellness-popup-supp-${s.id}`} />
            ))}</>,
      };

    case "docs":
      return {
        count: d.documents.length,
        body: d.documents.length === 0
          ? <BubbleEmpty text="No health documents" />
          : <>{d.documents.map(x => (
              // Straight to the record, which is the whole point of a pressable row.
              <BubbleRow key={x.id} title={x.name} accent={a} href={`/documents/${x.id}`}
                meta={x.date ? <TonePill tone="neutral">{x.date}</TonePill> : undefined}
                testId={`wellness-popup-doc-${x.id}`} />
            ))}</>,
      };

    case "conditions":
    case "allergies": {
      const rows = kind === "conditions" ? d.conditions : d.allergies;
      return {
        count: rows.length,
        body: rows.length === 0
          ? <BubbleEmpty text={kind === "conditions" ? "No conditions recorded" : "No allergies recorded"} />
          : <>{rows.map(x => (
              <BubbleRow key={x.id} title={x.name} accent={a}
                meta={x.note ? <TonePill tone={kind === "allergies" ? "critical" : "warn"}>{x.note}</TonePill> : undefined}
                testId={`wellness-popup-${kind}-${x.id}`} />
            ))}</>,
      };
    }

    case "recent":
      return {
        count: d.recentActivity.length,
        body: d.recentActivity.length === 0
          ? <BubbleEmpty text="Nothing logged recently" />
          : <>{d.recentActivity.map(x => (
              <BubbleRow key={x.id} title={x.text} accent={a}
                meta={x.when ? <TonePill tone="neutral">{x.when}</TonePill> : undefined}
                testId={`wellness-popup-recent-${x.id}`} />
            ))}</>,
      };

    case "insights":
      return {
        count: d.insights.length,
        body: (d.insights.length === 0 && !d.aiNarrative)
          ? <BubbleEmpty text="No insights yet" hint="They appear once there's a week or two of data." />
          : <>
              {d.aiNarrative && (
                <div className="bubble-row px-4 py-3" style={{ ["--accent-hsl" as any]: a }}>
                  <p className="text-[13px] leading-relaxed">{d.aiNarrative}</p>
                </div>
              )}
              {d.insights.map((s, i) => (
                <BubbleRow key={i} title={s} accent={a} testId={`wellness-popup-insight-${i}`}
                  leading={<Sparkles className="h-4 w-4 shrink-0" style={{ color: `hsl(${a})` }} />} />
              ))}
            </>,
      };
  }
}

export default WellnessPopup;
