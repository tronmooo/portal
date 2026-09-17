// ── Wellness overview (readout rebuild, 2026-09) ─────────────────────────────
// Five sections, not ninety cards.
//
// What this replaced
// ------------------
// The previous tab rendered ONE card per tracker — about ninety of them — so
// lab values sat beside "Shower", "Bathroom visits" and "Video games", the same
// metric appeared three times under three spellings, and every ring, streak and
// "hasn't been logged in 24 days" insight was a reminder that the numbers only
// existed if the user typed them in.
//
// The rebuild reads data back instead of asking for it:
//
//   1. Today      — Sleep, Activity, Recovery, each against its own 30-day
//                   average. A trend line, not a goal ring: there is no target
//                   to fail because nothing here is a chore.
//   2. This week  — three or four sentences about what the data did. Only ever
//                   about data that exists.
//   3. Labs       — grouped by panel with reference ranges, out-of-range values
//                   flagged, and the trend across reports (LDL 128 → 138).
//   4. Care       — medications with refill dates (no daily check-offs),
//                   allergies, conditions, appointments, documents.
//   5. Activity   — workouts grouped by type.
//
// Pure presentation: every value arrives as a prop, derived in pages/wellness.tsx
// through lib/wellness-data.ts, which resolves everything through the canonical
// metric registry. A section with no data says so in one line rather than
// rendering an empty shell.
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Activity, Moon, HeartPulse, Sparkles, FlaskConical, Pill, CalendarClock,
  FileText, AlertTriangle, Stethoscope, Dumbbell, Link2, TrendingUp, TrendingDown,
} from "lucide-react";
import { Medallion } from "@/components/dashboard/visuals";
import { SectionHeading } from "@/components/ui/section-heading";
import type { TodaySignal, LabPanel, LabRow, WorkoutGroup, WellnessScore, SourceState } from "@shared/wellness-readout";

// Shapes the Care section renders. Kept here because pages/wellness.tsx maps
// obligations/documents/profile fields into them.
export interface WellnessMed { id: string; name: string; dose?: string; /** "Refills Oct 4" */ refill?: string; schedule?: string; }
export interface WellnessAppt { id: string; date: string; time?: string; title: string; }
export interface WellnessDoc { id: string; name: string; date?: string; type?: string; }
export interface WellnessListItem { id: string; name: string; note?: string; }

const T = {
  green: "155 65% 45%", teal: "173 60% 44%", blue: "213 90% 62%", cyan: "199 89% 60%",
  purple: "262 70% 62%", pink: "330 75% 62%", amber: "38 96% 54%", orange: "25 90% 58%",
  red: "0 72% 58%", indigo: "240 60% 65%",
};

const fmt = (n: number | null | undefined, dp = 0) =>
  n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: dp });

/** Values below 10 read better with a decimal (7.4 h), large ones without. */
const auto = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Math.abs(n) < 10 ? fmt(n, 1) : fmt(n, 0);

function Spark({ series, color }: { series: number[]; color: string }) {
  if (!series || series.length < 2) return <div className="h-7" />;
  const w = 120, h = 28, pad = 2;
  const min = Math.min(...series), max = Math.max(...series), span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-7" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={`hsl(${color})`} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const Empty = ({ text }: { text: string }) => <p className="text-xs text-muted-foreground">{text}</p>;

function Section({ title, icon, tone, meta, children, testId }: {
  title: string; icon: any; tone: string; meta?: string; children: React.ReactNode; testId: string;
}) {
  return (
    <Card className="p-4" data-testid={testId} style={{ ["--accent-hsl" as any]: tone }}>
      <SectionHeading title={title} icon={icon} accent={tone} meta={meta} />
      {children}
    </Card>
  );
}

// ── 1. Today ─────────────────────────────────────────────────────────────────

const SIGNAL_META: Record<TodaySignal["key"], { icon: any; tone: string; connect: string }> = {
  sleep: { icon: Moon, tone: T.indigo, connect: "Connect Apple Health or Health Connect for sleep" },
  activity: { icon: Activity, tone: T.green, connect: "Connect Apple Health or Health Connect for steps and workouts" },
  recovery: { icon: HeartPulse, tone: T.pink, connect: "Connect a wearable for resting HR and HRV" },
};

function SignalTile({ signal }: { signal: TodaySignal }) {
  const meta = SIGNAL_META[signal.key];
  const delta = signal.value != null && signal.avg30 != null ? signal.value - signal.avg30 : null;
  // Tone follows the metric's own direction: a resting heart rate BELOW your
  // average is the good move, a sleep hour below it is not.
  const good = delta == null ? null : signal.higherBetter ? delta > 0 : delta < 0;
  const DeltaIcon = delta == null ? null : delta > 0 ? TrendingUp : TrendingDown;
  return (
    <Card className="p-3 flex-1 min-w-[9rem]" data-testid={`wellness-signal-${signal.key}`} style={{ ["--accent-hsl" as any]: meta.tone }}>
      <div className="flex items-center gap-2">
        <Medallion icon={meta.icon} accent={meta.tone} size="sm" />
        <span className="micro-label text-muted-foreground leading-tight">{signal.label}</span>
      </div>
      {signal.value == null ? (
        <p className="text-xs text-muted-foreground mt-3" data-testid={`wellness-signal-${signal.key}-empty`}>
          {signal.lastAt
            ? `${signal.key === "sleep" ? "No sleep recorded last night" : "No reading today"} · last ${new Date(signal.lastAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
            : meta.connect}
        </p>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5 mt-2">
            <span className="metric-value text-[28px] leading-none" style={{ color: `hsl(${meta.tone})` }}>{auto(signal.value)}</span>
            {signal.unit && <span className="text-[11px] text-muted-foreground">{signal.unit}</span>}
          </div>
          {signal.caption && <div className="text-[11px] text-muted-foreground mt-1">{signal.caption}</div>}
          <div className="mt-2"><Spark series={signal.series} color={meta.tone} /></div>
          <div className="text-[11px] mt-1" style={{ color: good == null ? undefined : `hsl(${good ? T.green : T.amber})` }}>
            {delta == null
              ? "Building a 30-day baseline"
              : `${auto(Math.abs(delta))} ${signal.unit} ${delta > 0 ? "above" : "below"} your 30-day average`}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Score breakdown ──────────────────────────────────────────────────────────
// The old score was a bare "60" with nothing behind it. This one names its
// parts, their weights, and counts only the sources that are actually
// connected — so it can never be a number about data the app does not have.

function ScoreCard({ score }: { score: WellnessScore }) {
  const live = score.components.filter((c) => c.score != null);
  return (
    <Card className="p-4" data-testid="wellness-score" style={{ ["--accent-hsl" as any]: T.teal }}>
      <div className="flex items-center gap-3">
        <Medallion icon={Sparkles} accent={T.teal} size="sm" />
        <div>
          <div className="micro-label text-muted-foreground">Wellness score</div>
          <div className="metric-value text-[32px] leading-none" style={{ color: `hsl(${T.teal})` }} data-testid="wellness-score-value">
            {score.value ?? "—"}
          </div>
        </div>
      </div>
      {live.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-3">No connected source yet, so there is nothing to score.</p>
      ) : (
        <div className="mt-3 space-y-1.5" data-testid="wellness-score-breakdown">
          {live.map((c) => (
            <div key={c.key} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {c.label} <span className="opacity-70">{Math.round(c.weight * 100)}%</span>
              </span>
              <span className="tabular-nums">{c.score}<span className="text-muted-foreground"> · {c.detail}</span></span>
            </div>
          ))}
          {live.length < score.components.length && (
            <p className="text-[11px] text-muted-foreground pt-1">
              {score.components.filter((c) => c.score == null).map((c) => `${c.label} not counted — ${c.detail.charAt(0).toLowerCase()}${c.detail.slice(1)}`).join(". ")}.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ── 3. Labs ──────────────────────────────────────────────────────────────────

function FlagPill({ flag }: { flag: LabRow["flag"] }) {
  if (flag === "normal" || flag === "unknown") return null;
  const tone = flag === "high" ? T.orange : T.blue;
  return (
    <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
      style={{ background: `hsl(${tone} / 0.15)`, color: `hsl(${tone})` }}>
      {flag === "high" ? "High" : "Low"}
    </span>
  );
}

/** Lab and vitals values keep the precision they were measured with: a
 *  hemoglobin of 15.1 must not render as "15". */
const labValue = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

const shortDay = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function LabRowView({ row }: { row: LabRow }) {
  const moved = row.previous != null && row.previous !== row.value;
  return (
    <a
      href={`#/trackers?tracker=${row.trackerId}`}
      className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0 hover:bg-muted/40 rounded px-1 -mx-1"
      data-testid={`wellness-lab-${row.metricId}`}
    >
      <div className="min-w-0">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <span className="truncate">{row.label}</span>
          <FlagPill flag={row.flag} />
        </div>
        <div className="text-[11px] text-muted-foreground">
          {row.reference ? `Ref ${row.reference}` : ""}{row.reference && row.at ? " · " : ""}{row.at ? shortDay(row.at) : ""}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs tabular-nums font-medium">
          {labValue(row.value)}{row.unit ? <span className="text-muted-foreground font-normal"> {row.unit}</span> : null}
        </div>
        {moved && (
          <div className="text-[11px] text-muted-foreground tabular-nums" data-testid={`wellness-lab-${row.metricId}-trend`}>
            {labValue(row.previous)} → {labValue(row.value)}
          </div>
        )}
      </div>
    </a>
  );
}

// ── 5. Activity history ──────────────────────────────────────────────────────

function WorkoutRow({ w }: { w: WorkoutGroup }) {
  const bits = [
    `${w.sessions} session${w.sessions === 1 ? "" : "s"}`,
    w.minutes != null ? `${fmt(w.minutes)} min` : null,
    w.distance != null ? `${fmt(w.distance, 1)} mi` : null,
    w.reps != null ? `${fmt(w.reps)} reps` : null,
    w.sets != null ? `${fmt(w.sets)} sets` : null,
  ].filter(Boolean).join(" · ");
  return (
    <a href={`#/trackers?tracker=${w.trackerId}`}
      className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0 hover:bg-muted/40 rounded px-1 -mx-1"
      data-testid={`wellness-workout-${w.trackerId}`}>
      <span className="text-xs font-medium truncate">{w.type}</span>
      <span className="text-[11px] text-muted-foreground shrink-0">{bits}</span>
    </a>
  );
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface WellnessOverviewProps {
  /** Whose data this is. The tab reads ONE person — health data never blends. */
  subjectName?: string | null;
  score: WellnessScore;
  signals: TodaySignal[];
  /** Deterministic sentences about data that exists. */
  brief: string[];
  /** The AI rewrite of the brief, when the user asked for one. */
  aiNarrative?: string | null;
  onAiBrief?: () => void;
  aiBriefLoading?: boolean;
  panels: LabPanel[];
  /** Weight, BMI, body fat, blood pressure, temperature — same row shape. */
  body: LabPanel[];
  medications: WellnessMed[];
  appointments: WellnessAppt[];
  documents: WellnessDoc[];
  allergies: WellnessListItem[];
  conditions: WellnessListItem[];
  workouts: WorkoutGroup[];
  sources: SourceState;
  /** Metrics that were logged into more than one tracker and got merged. */
  duplicates?: Array<{ label: string; sources: string[] }>;
}

export function WellnessOverview(p: WellnessOverviewProps) {
  const labCount = p.panels.reduce((a, s) => a + s.rows.length, 0);
  const flagged = p.panels.reduce((a, s) => a + s.outOfRange, 0);
  const bodyCount = p.body.reduce((a, s) => a + s.rows.length, 0);
  const care = p.medications.length + p.appointments.length + p.documents.length + p.allergies.length + p.conditions.length;

  return (
    <div className="space-y-4" data-testid="wellness-overview">
      {p.subjectName && (
        <div className="text-[11px] text-muted-foreground" data-testid="wellness-subject">
          Showing {p.subjectName}'s health data
        </div>
      )}

      {/* ── 1. Today ─────────────────────────────────────────────────────── */}
      <div>
        <h2 className="micro-label text-muted-foreground mb-2">Today</h2>
        <div className="flex flex-wrap gap-3">
          {p.signals.map((s) => <SignalTile key={s.key} signal={s} />)}
          <div className="min-w-[10rem] flex-1"><ScoreCard score={p.score} /></div>
        </div>
      </div>

      {/* ── 2. This week ─────────────────────────────────────────────────── */}
      <Section title="This week" icon={Sparkles} tone={T.purple} testId="wellness-brief">
        {p.aiNarrative ? (
          <p className="text-xs leading-relaxed" data-testid="wellness-brief-ai">{p.aiNarrative}</p>
        ) : p.brief.length > 0 ? (
          <ul className="space-y-1.5">
            {p.brief.map((line, i) => (
              <li key={i} className="text-xs leading-relaxed" data-testid={`wellness-brief-line-${i}`}>{line}</li>
            ))}
          </ul>
        ) : (
          <Empty text="Nothing to report yet — connect a health source and a week of data will fill this in." />
        )}
        {p.onAiBrief && (p.brief.length > 0 || p.aiNarrative) && (
          <Button variant="outline" size="sm" className="mt-3 h-7 text-[11px]"
            onClick={p.onAiBrief} disabled={p.aiBriefLoading} data-testid="wellness-ai-brief">
            {p.aiBriefLoading ? "Reading your data…" : "Ask AI to read this back"}
          </Button>
        )}
      </Section>

      {/* ── Body & vitals ────────────────────────────────────────────────
          Not labs, but the same question: what is it, is it in range, which
          way is it moving. */}
      <Section title="Body & vitals" icon={HeartPulse} tone={T.teal} testId="wellness-body"
        meta={bodyCount > 0 ? `${bodyCount} measurement${bodyCount === 1 ? "" : "s"}` : undefined}>
        {p.body.length === 0 ? (
          <Empty text="No body measurements yet. A connected scale or health app fills these in." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {p.body.map((panel) => (
              <div key={panel.panel} data-testid={`wellness-body-${panel.panel}`}>
                <h3 className="micro-label text-muted-foreground mb-1">{panel.label}</h3>
                {panel.rows.map((r) => <LabRowView key={r.metricId} row={r} />)}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 3. Labs ──────────────────────────────────────────────────────── */}
      <Section
        title="Labs" icon={FlaskConical} tone={T.cyan} testId="wellness-labs"
        meta={labCount > 0 ? `${labCount} value${labCount === 1 ? "" : "s"}${flagged > 0 ? ` · ${flagged} out of range` : ""}` : undefined}
      >
        {p.panels.length === 0 ? (
          <Empty text="No lab values yet. Photograph a lab report in chat and every value on it lands here." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {p.panels.map((panel) => (
              <div key={panel.panel} data-testid={`wellness-panel-${panel.panel}`}>
                <div className="flex items-center justify-between mb-1">
                  <h3 className="micro-label text-muted-foreground">{panel.label}</h3>
                  {panel.outOfRange > 0 && (
                    <span className="text-[11px]" style={{ color: `hsl(${T.orange})` }}>{panel.outOfRange} flagged</span>
                  )}
                </div>
                {panel.rows.map((r) => <LabRowView key={r.metricId} row={r} />)}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── 4. Care ──────────────────────────────────────────────────────── */}
      <Section title="Care" icon={Stethoscope} tone={T.red} testId="wellness-care"
        meta={care > 0 ? undefined : undefined}>
        {care === 0 ? (
          <Empty text="No medications, appointments or health documents on file." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {p.medications.length > 0 && (
              <div data-testid="wellness-care-meds">
                <h3 className="micro-label text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Pill className="w-3 h-3" /> Medications
                </h3>
                {p.medications.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0"
                    data-testid={`wellness-med-${m.id}`}>
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{m.name}</div>
                      {m.dose && <div className="text-[11px] text-muted-foreground">{m.dose}</div>}
                    </div>
                    <span className="text-[11px] text-muted-foreground shrink-0">{m.refill || m.schedule || ""}</span>
                  </div>
                ))}
              </div>
            )}
            {p.appointments.length > 0 && (
              <div data-testid="wellness-care-appts">
                <h3 className="micro-label text-muted-foreground mb-1 flex items-center gap-1.5">
                  <CalendarClock className="w-3 h-3" /> Appointments
                </h3>
                {p.appointments.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0"
                    data-testid={`wellness-appt-${a.id}`}>
                    <span className="text-xs truncate">{a.title}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{a.date}{a.time ? ` · ${a.time}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
            {(p.allergies.length > 0 || p.conditions.length > 0) && (
              <div data-testid="wellness-care-conditions">
                <h3 className="micro-label text-muted-foreground mb-1 flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" /> Allergies & conditions
                </h3>
                {[...p.allergies.map((x) => ({ ...x, kind: "Allergy" })), ...p.conditions.map((x) => ({ ...x, kind: "Condition" }))].map((x) => (
                  <div key={x.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0">
                    <span className="text-xs truncate">{x.name}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{x.kind}</span>
                  </div>
                ))}
              </div>
            )}
            {p.documents.length > 0 && (
              <div data-testid="wellness-care-docs">
                <h3 className="micro-label text-muted-foreground mb-1 flex items-center gap-1.5">
                  <FileText className="w-3 h-3" /> Health documents
                </h3>
                {p.documents.map((d) => (
                  <a key={d.id} href={`#/documents?doc=${d.id}`}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-0 hover:bg-muted/40 rounded px-1 -mx-1"
                    data-testid={`wellness-doc-${d.id}`}>
                    <span className="text-xs truncate">{d.name}</span>
                    <span className="text-[11px] text-muted-foreground shrink-0">{d.date || d.type || ""}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── 5. Activity history ──────────────────────────────────────────── */}
      <Section title="Activity" icon={Dumbbell} tone={T.amber} testId="wellness-activity"
        meta={p.workouts.length > 0 ? `${p.workouts.length} type${p.workouts.length === 1 ? "" : "s"} · 90 days` : undefined}>
        {p.workouts.length === 0 ? (
          <Empty text="No workouts recorded. Connected Health workouts show up here grouped by type." />
        ) : (
          <div>{p.workouts.map((w) => <WorkoutRow key={w.trackerId} w={w} />)}</div>
        )}
      </Section>

      {/* ── Sources ──────────────────────────────────────────────────────── */}
      <Section title="Sources" icon={Link2} tone={T.blue} testId="wellness-sources">
        <div className="flex flex-wrap gap-2">
          {([
            ["Sleep", p.sources.sleep], ["Activity", p.sources.activity],
            ["Recovery", p.sources.recovery], ["Labs", p.sources.labs], ["Body", p.sources.body],
          ] as Array<[string, boolean]>).map(([label, on]) => (
            <span key={label} className="text-[11px] px-2 py-1 rounded-full"
              data-testid={`wellness-source-${label.toLowerCase()}`}
              style={{ background: on ? `hsl(${T.green} / 0.15)` : "hsl(var(--muted))", color: on ? `hsl(${T.green})` : undefined }}>
              {label} {on ? "· receiving data" : "· not connected"}
            </span>
          ))}
        </div>
        {p.duplicates && p.duplicates.length > 0 && (
          <p className="text-[11px] text-muted-foreground mt-3" data-testid="wellness-duplicates">
            Merged duplicates: {p.duplicates.map((d) => `${d.label} (${d.sources.length} trackers)`).join(", ")}.
          </p>
        )}
      </Section>
    </div>
  );
}

export default WellnessOverview;
