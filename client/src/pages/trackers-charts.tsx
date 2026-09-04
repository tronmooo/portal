// ── Trackers chart layer (PERF 2026-09-04) ──────────────────────────────────
//
// Every recharts-rendering component of the Trackers page lives here, in its
// own lazily-loaded chunk.
//
// Why: recharts is ~416KB raw (generateCategoricalChart / YAxis / PieChart /
// ComposedChart). trackers.tsx imported it at module scope, so the Trackers
// LIST — the tab's first screen, which draws only cards and hand-rolled SVG
// sparklines — could not paint until all of it had downloaded and parsed. Not
// one of these components renders until the user expands a tracker card
// (ExpandedDetailView) or opens a tracker's detail tabs, so none of that cost
// belongs on the list's critical path.
//
// trackers.tsx imports these through React.lazy and renders them inside
// Suspense boundaries sized to the chart they replace, so the layout does not
// jump while the chunk arrives.

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea,
  PieChart, Pie, Cell, ScatterChart, Scatter, ComposedChart,
} from "recharts";
import { BarChart2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CHART_COLORS } from "@/lib/chart-colors";
import { goalsQueryKey } from "@shared/query-keys";
import { classifyTrackerPresentation, type TrackerPresentation } from "@shared/tracker-presentation";
import { trackerFieldLabel } from "@shared/field-label";
import type { Tracker, TrackerEntry, Goal } from "@shared/schema";
// Helpers and non-charting components shared with the page. They stay in
// trackers.tsx (the page owns them); this module is only ever reached through
// the page's own React.lazy call, so the page module is already evaluated by
// the time this import resolves.
import {
  tooltipStyle, filterEntriesByRange, measurementZone, computeFieldStats,
  movingAverage, computeStreak, computeDynamicKpis, KIND_ACCENT,
  dynamicOverviewInsight, detectSpecialization, StatsRow, MedicationOverview,
  type TimeRange,
} from "./trackers";

export function StandardDetailChart({
  entries,
  primaryField,
  unit,
  goalValue,
}: {
  entries: TrackerEntry[];
  primaryField: string;
  unit?: string;
  goalValue?: number;
}) {
  const chartData = entries.map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value: typeof e.values[primaryField] === "number" ? (e.values[primaryField] as number) : null,
  }));

  // A single data point can't form a trend — drawing a line/area for it renders
  // as a misleading vertical streak across the whole panel. Show the reading +
  // a nudge instead, so a brand-new tracker looks intentional, not broken.
  const realPoints = chartData.filter((d) => typeof d.value === "number");
  if (realPoints.length < 2) {
    const v = realPoints[realPoints.length - 1]?.value;
    return (
      <div className="h-[200px] flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        {typeof v === "number" ? (
          <>
            <p className="text-3xl font-bold tabular-nums">{v}{unit ? <span className="text-base font-normal text-muted-foreground ml-1">{unit}</span> : null}</p>
            <p className="text-xs text-muted-foreground mt-1">Your first reading{realPoints.length === 1 ? "" : "s"} — log a few more and a trend line appears here.</p>
          </>
        ) : (
          <>
            <BarChart2 className="h-7 w-7 text-muted-foreground/30 mb-2" />
            <p className="text-sm text-muted-foreground">No numeric data yet — tap “+ Add” to log one.</p>
          </>
        )}
      </div>
    );
  }
  // Append a "today" sentinel point with a null value so the X-axis extends
  // to the current date even when the most recent entry is days/weeks old.
  // Without this the axis terminates at the last entry date and the user is
  // shown a stale-looking range (e.g. "Apr 29 → May 5" when today is May 20).
  (() => {
    const todayLabel = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (chartData.length === 0 || chartData[chartData.length - 1].date !== todayLabel) {
      chartData.push({ date: todayLabel, value: null });
    }
  })();

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
        {(() => {
          const z = measurementZone(primaryField);
          return z ? (
            <ReferenceArea
              y1={z.low} y2={z.high} fill="#10b981" fillOpacity={0.08} strokeOpacity={0}
              label={{ value: z.label, position: "insideTopRight", fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
            />
          ) : null;
        })()}
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          allowDuplicatedCategory={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          domain={["auto", "auto"]}
          width={36}
          tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`}
        />
        <Tooltip contentStyle={tooltipStyle} />
        {goalValue !== undefined && (
          <ReferenceLine
            y={goalValue}
            stroke={CHART_COLORS.gold}
            strokeDasharray="4 4"
            label={{ value: "Goal", position: "right", fontSize: 10, fill: CHART_COLORS.gold }}
          />
        )}
        <Line
          type="monotone"
          dataKey="value"
          stroke={CHART_COLORS.primary}
          strokeWidth={2}
          dot={{ r: 3, fill: CHART_COLORS.primary }}
          activeDot={{ r: 5 }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Weight / BMI Chart ─────────────────────────────────────────────────────────

export function WeightDetailChart({
  entries,
  primaryField,
  unit,
}: {
  entries: TrackerEntry[];
  primaryField: string;
  unit?: string;
}) {
  const chartData = entries.map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    weight: typeof e.values[primaryField] === "number" ? (e.values[primaryField] as number) : null,
    bmi: e.computed?.bmi ?? null,
  }));
  // Append a "today" sentinel point so the X-axis extends to the current date
  // even when the most recent entry is days/weeks old. Without this the axis
  // terminates at the last entry date and the trend looks stale.
  (() => {
    const todayLabel = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (chartData.length === 0 || chartData[chartData.length - 1].date !== todayLabel) {
      chartData.push({ date: todayLabel, weight: null, bmi: null });
    }
  })();

  return (
    <div className="space-y-3">
      {/* Weight line chart */}
      <div>
        <p className="micro-label text-muted-foreground mb-1">Weight Trend</p>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
            <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} width={40} tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="weight" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name={`Weight${unit ? ` (${unit})` : ""}`} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* BMI trend with normal range shading */}
      {chartData.some((d) => d.bmi !== null) && (
        <div>
          <p className="micro-label text-muted-foreground mb-1">BMI Trend</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[14, 35]} width={28} />
              <Tooltip contentStyle={tooltipStyle} />
              {/* Normal BMI range shading: 18.5 – 25 */}
              <ReferenceArea y1={18.5} y2={25} fill="#20808D" fillOpacity={0.08} />
              <ReferenceLine y={18.5} stroke={CHART_COLORS.primary} strokeDasharray="4 3" label={{ value: "18.5", fontSize: 9, fill: CHART_COLORS.primary }} />
              <ReferenceLine y={25} stroke={CHART_COLORS.gold} strokeDasharray="4 3" label={{ value: "25", fontSize: 9, fill: CHART_COLORS.gold }} />
              <ReferenceLine y={30} stroke={CHART_COLORS.secondary} strokeDasharray="4 3" label={{ value: "30", fontSize: 9, fill: CHART_COLORS.secondary }} />
              <Line type="monotone" dataKey="bmi" stroke={CHART_COLORS.tertiary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.tertiary }} activeDot={{ r: 5 }} connectNulls name="BMI" />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.primary }} className="inline-block w-2 h-2 rounded-sm opacity-40" />Normal (18.5–25)</span>
            <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.gold }} className="inline-block w-2 h-2 rounded-sm opacity-70" />Overweight (25–30)</span>
            <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.secondary }} className="inline-block w-2 h-2 rounded-sm opacity-70" />Obese (30+)</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Blood Pressure Chart ───────────────────────────────────────────────────────

export function BloodPressureDetailChart({ entries }: { entries: TrackerEntry[] }) {
  const chartData = entries.map((e) => {
    const systolic = e.values["systolic"] ?? e.values["systolic_pressure"] ?? e.values["sbp"] ?? null;
    const diastolic = e.values["diastolic"] ?? e.values["diastolic_pressure"] ?? e.values["dbp"] ?? null;
    // Try to find numeric fields automatically if named fields not found
    const numericVals = Object.values(e.values).filter((v) => typeof v === "number") as number[];
    return {
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      systolic: systolic !== null ? Number(systolic) : numericVals[0] ?? null,
      diastolic: diastolic !== null ? Number(diastolic) : numericVals[1] ?? null,
      category: e.computed?.bloodPressureCategory ?? null,
    };
  });

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
          <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[50, 180]} width={32} />
          <Tooltip contentStyle={tooltipStyle} />
          {/* Color zones */}
          <ReferenceArea y1={50} y2={120} fill="#20808D" fillOpacity={0.05} label={{ value: "Normal", position: "insideTopLeft", fontSize: 9, fill: CHART_COLORS.primary, dy: 4 }} />
          <ReferenceArea y1={120} y2={130} fill="#FFC553" fillOpacity={0.12} />
          <ReferenceArea y1={130} y2={180} fill="#A84B2F" fillOpacity={0.07} />
          <ReferenceLine y={120} stroke={CHART_COLORS.gold} strokeDasharray="4 3" label={{ value: "Elevated", fontSize: 9, fill: CHART_COLORS.gold, position: "right" }} />
          <ReferenceLine y={130} stroke={CHART_COLORS.secondary} strokeDasharray="4 3" label={{ value: "High", fontSize: 9, fill: CHART_COLORS.secondary, position: "right" }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="systolic" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.secondary }} activeDot={{ r: 5 }} connectNulls name="Systolic" />
          <Line type="monotone" dataKey="diastolic" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name="Diastolic" />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span style={{ background: "#20808D" }} className="inline-block w-2 h-2 rounded-sm opacity-30" />Normal (&lt;120/80)</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.gold }} className="inline-block w-2 h-2 rounded-sm opacity-60" />Elevated (120–129)</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.secondary }} className="inline-block w-2 h-2 rounded-sm opacity-60" />High (≥130)</span>
      </div>
    </div>
  );
}

// ── Sleep Chart ────────────────────────────────────────────────────────────────

export function SleepDetailChart({ entries, primaryField }: { entries: TrackerEntry[]; primaryField: string }) {
  const chartData = entries.map((e) => {
    const rawVal = e.values[primaryField];
    const hours = typeof rawVal === "number" ? rawVal : null;
    const quality = e.computed?.sleepQuality ?? null;
    return {
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      hours,
      qualityScore: quality === "excellent" ? 4 : quality === "good" ? 3 : quality === "fair" ? 2 : quality === "poor" ? 1 : null,
      quality,
    };
  });

  const qualityColor = (q: string | null) => {
    if (q === "excellent") return CHART_COLORS.primary;
    if (q === "good") return CHART_COLORS.tertiary;
    if (q === "fair") return CHART_COLORS.gold;
    return CHART_COLORS.secondary;
  };

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
          <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, 12]} width={24} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number, name: string, props: any) => {
              const q = props.payload?.quality;
              return [`${value}h${q ? ` (${q})` : ""}`, "Sleep"];
            }}
          />
          {/* Target sleep zone: 7–8 hours */}
          <ReferenceArea y1={7} y2={8} fill={CHART_COLORS.primary} fillOpacity={0.12} />
          <ReferenceLine y={7} stroke={CHART_COLORS.primary} strokeDasharray="4 3" label={{ value: "7h", fontSize: 9, fill: CHART_COLORS.primary }} />
          <ReferenceLine y={8} stroke={CHART_COLORS.tertiary} strokeDasharray="4 3" label={{ value: "8h", fontSize: 9, fill: CHART_COLORS.tertiary }} />
          <Bar dataKey="hours" radius={[3, 3, 0, 0]} name="Hours slept">
            {chartData.map((entry, index) => (
              <rect key={`bar-${index}`} fill={qualityColor(entry.quality)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.primary }} className="inline-block w-2 h-2 rounded-sm" />Excellent</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.tertiary }} className="inline-block w-2 h-2 rounded-sm" />Good</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.gold }} className="inline-block w-2 h-2 rounded-sm" />Fair</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.secondary }} className="inline-block w-2 h-2 rounded-sm" />Poor</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.primary, opacity: 0.3 }} className="inline-block w-2 h-2 rounded-sm" />Target zone (7–8h)</span>
      </div>
    </div>
  );
}

// ── Running Chart ──────────────────────────────────────────────────────────────

export function RunningDetailChart({ entries, primaryField }: { entries: TrackerEntry[]; primaryField: string }) {
  let cumulativeDistance = 0;
  const chartData = entries.map((e) => {
    const dist = e.computed?.distanceMiles ?? null;
    if (dist !== null) cumulativeDistance += dist;
    return {
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      pace: e.computed?.paceSeconds ?? null,
      distance: dist,
      cumulativeDistance: dist !== null ? parseFloat(cumulativeDistance.toFixed(2)) : null,
      calories: e.computed?.caloriesBurned ?? null,
    };
  });

  const paceFormatter = (secs: number) => {
    if (!secs) return "";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}/mi`;
  };

  return (
    <div className="space-y-3">
      {/* Pace trend */}
      {chartData.some((d) => d.pace !== null) && (
        <div>
          <p className="micro-label text-muted-foreground mb-1">Pace Trend (lower = faster)</p>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} width={52} tickFormatter={paceFormatter} reversed />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [paceFormatter(v), "Pace"]} />
              <Line type="monotone" dataKey="pace" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name="Pace" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cumulative distance */}
      {chartData.some((d) => d.cumulativeDistance !== null) && (
        <div>
          <p className="micro-label text-muted-foreground mb-1">Cumulative Distance (mi)</p>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, "auto"]} width={32} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} mi`, "Total Distance"]} />
              <defs>
                <linearGradient id="distGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="cumulativeDistance" stroke={CHART_COLORS.primary} strokeWidth={2} fill="url(#distGradient)" connectNulls name="Cumulative Distance" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Calories burned */}
      {chartData.some((d) => d.calories !== null) && (
        <div>
          <p className="micro-label text-muted-foreground mb-1">Calories Burned</p>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, "auto"]} width={32} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} cal`, "Calories"]} />
              <Bar dataKey="calories" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} name="Calories" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
// Daily-total bar chart for additive metrics (water/calories/miles/minutes).
function AdditiveDailyBars({ entries, primaryField, unit, goalValue }: { entries: TrackerEntry[]; primaryField: string; unit?: string; goalValue?: number }) {
  const byDay = new Map<string, number>();
  for (const e of entries) {
    const v = Number(e.values?.[primaryField]);
    if (!isFinite(v)) continue;
    byDay.set(new Date(e.timestamp).toLocaleDateString("en-CA"), (byDay.get(new Date(e.timestamp).toLocaleDateString("en-CA")) || 0) + v);
  }
  const data = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ date: new Date(k + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: Math.round(v * 100) / 100 }));
  if (data.length === 0) {
    return (
      <div className="h-[200px] flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        <BarChart2 className="h-7 w-7 text-muted-foreground/30 mb-2" />
        <p className="text-sm text-muted-foreground">No numeric data yet — tap “+ Add” to log one.</p>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v}${unit ? ` ${unit}` : ""}`, "Daily total"]} />
        {typeof goalValue === "number" && goalValue > 0 && (
          <ReferenceLine y={goalValue} stroke={CHART_COLORS.gold} strokeDasharray="4 4" label={{ value: "Goal", position: "right", fontSize: 10, fill: CHART_COLORS.gold }} />
        )}
        <Bar dataKey="value" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0] as any} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function OverviewTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const specialization = detectSpecialization(tracker);
  // Dynamic presentation spec — drives KPI cards, chart style, units by metric
  // kind (additive/measurement/dual/…) instead of one-size-fits-all.
  const pres = classifyTrackerPresentation(tracker as any);
  const filtered = filterEntriesByRange(tracker.entries, timeRange);
  // Force Recharts to remount when data changes (ResponsiveContainer caching issue)
  const chartKey = `${tracker.id}-${tracker.entries.length}-${timeRange}`;
  const stats = computeFieldStats(filtered, primaryField);
  const streak = computeStreak(tracker.entries);
  const dynamicKpis = computeDynamicKpis(filtered, primaryField, pres, timeRange);
  // Additive standard trackers (hydration, calories, steps…) render daily-total
  // bars; everything else keeps its line/specialized chart.
  const useAdditiveBars = specialization === "standard" && pres.metricKind === "additive";

  // Goal ring — only when the user actually created a goal for this tracker.
  const { data: overviewGoals = [] } = useQuery<Goal[]>({ queryKey: goalsQueryKey([]) });
  const trackerGoal = overviewGoals.find((g) => g && g.trackerId === tracker.id && g.status === "active" && typeof g.target === "number");
  const goalProgress = (() => {
    if (!trackerGoal || !pres.primaryField || trackerGoal.target <= 0) return null;
    const fld = pres.primaryField;
    let current = 0;
    let scope = "latest";
    if (pres.metricKind === "additive") {
      const todayKey = new Date().toLocaleDateString("en-CA");
      current = tracker.entries
        .filter((e) => new Date(e.timestamp).toLocaleDateString("en-CA") === todayKey)
        .reduce((s, e) => { const v = Number(e.values?.[fld]); return s + (isFinite(v) ? v : 0); }, 0);
      scope = "today";
    } else {
      const sorted = [...filtered].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const nums = sorted.map((e) => Number(e.values?.[fld])).filter((v) => isFinite(v));
      current = nums.length ? nums[nums.length - 1] : 0;
    }
    const pct = Math.max(0, Math.min(100, Math.round((current / trackerGoal.target) * 100)));
    return { current, target: trackerGoal.target, pct, scope, unit: trackerGoal.unit || pres.unit, met: current >= trackerGoal.target };
  })();

  const timeRangeBtns: { label: string; value: TimeRange }[] = [
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
    { label: "All", value: "all" },
  ];

  // Medication trackers get their own specialized view
  if (specialization === 'medication') return <MedicationOverview tracker={tracker} />;

  return (
    <div className="space-y-4">
      {/* KPI Row — dynamic by metric kind (Phase 1), accent-coloured (Phase 3) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {dynamicKpis.length > 0 ? (
          dynamicKpis.map((k, i) => (
            <div key={i} className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="micro-label text-muted-foreground truncate">{k.label}</p>
              <p className={`text-lg font-bold tabular-nums truncate ${i === 0 ? (KIND_ACCENT[pres.metricKind] || "text-foreground") : ""}`} title={k.value}>{k.value}</p>
              <p className="text-xs text-muted-foreground truncate">{k.sub}</p>
            </div>
          ))
        ) : (
          <div className="col-span-2 sm:col-span-4 bg-muted/30 rounded-lg p-3 text-center text-xs text-muted-foreground">
            No numeric data yet — log an entry to see summaries.
          </div>
        )}
      </div>

      {/* Phase 4: dynamic, kind-aware insight line */}
      {dynamicKpis.length > 0 && (() => {
        const insight = dynamicOverviewInsight(filtered, primaryField, pres);
        return insight ? (
          <div className={`text-xs rounded-md px-3 py-2 bg-muted/40 flex items-center gap-1.5`}>
            <span className={KIND_ACCENT[pres.metricKind] || "text-primary"}>●</span>
            <span className="text-muted-foreground">{insight}</span>
          </div>
        ) : null;
      })()}

      {/* Goal ring/progress — only when a real goal exists for this tracker */}
      {goalProgress && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="micro-label text-muted-foreground">Goal · {goalProgress.scope}</span>
            <span className={`text-xs font-bold ${goalProgress.met ? "text-emerald-500" : "text-primary"}`}>
              {goalProgress.met ? "✓ Goal met" : `${goalProgress.pct}%`}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${goalProgress.met ? "bg-emerald-500" : "bg-primary"}`}
              style={{ width: `${goalProgress.pct}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            {Math.round(goalProgress.current * 10) / 10}{goalProgress.unit ? ` ${goalProgress.unit}` : ""} of {goalProgress.target}{goalProgress.unit ? ` ${goalProgress.unit}` : ""} goal
            {!goalProgress.met && goalProgress.target > goalProgress.current ? ` · ${Math.round((goalProgress.target - goalProgress.current) * 10) / 10} to go` : ""}
          </p>
        </div>
      )}

      {/* Time range selector */}
      <div className="flex items-center gap-1">
        {timeRangeBtns.map(btn => (
          <button key={btn.value}
            className={`px-2.5 py-0.5 rounded text-xs-loose font-medium transition-colors ${timeRange === btn.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            onClick={() => setTimeRange(btn.value)}>
            {btn.label}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">{filtered.length} entries</span>
      </div>

      {/* Chart */}
      {filtered.length > 0 ? (
        <div className="h-[200px]" key={chartKey}>
          {specialization === "weight" && <WeightDetailChart entries={filtered} primaryField={primaryField} unit={tracker.unit} />}
          {specialization === "bloodpressure" && <BloodPressureDetailChart entries={filtered} />}
          {specialization === "sleep" && <SleepDetailChart entries={filtered} primaryField={primaryField} />}
          {specialization === "running" && <RunningDetailChart entries={filtered} primaryField={primaryField} />}
          {specialization === "standard" && (useAdditiveBars
            ? <AdditiveDailyBars entries={filtered} primaryField={primaryField} unit={pres.unit} goalValue={trackerGoal?.target} />
            : <StandardDetailChart entries={filtered} primaryField={primaryField} unit={pres.unit || tracker.unit} goalValue={trackerGoal?.target} />)}
        </div>
      ) : (
        <div className="text-center py-8">
          <BarChart2 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No entries in this time range</p>
        </div>
      )}

      {/* Stats summary */}
      {filtered.length > 0 && (
        <StatsRow entries={filtered} primaryField={primaryField} unit={tracker.unit} isBP={specialization === "bloodpressure"} />
      )}
    </div>
  );
}

// -- Trends Tab
export function TrendsTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const maData = useMemo(() => movingAverage(tracker.entries, primaryField, 7), [tracker.entries, primaryField]);

  // Period comparison
  const now = Date.now();
  const thisWeek = tracker.entries.filter(e => now - new Date(e.timestamp).getTime() < 7 * 86400000);
  const lastWeek = tracker.entries.filter(e => {
    const diff = now - new Date(e.timestamp).getTime();
    return diff >= 7 * 86400000 && diff < 14 * 86400000;
  });
  const thisWeekAvg = (() => {
    const nums = thisWeek.map(e => typeof e.values[primaryField] === "number" ? e.values[primaryField] as number : NaN).filter(n => !isNaN(n));
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  })();
  const lastWeekAvg = (() => {
    const nums = lastWeek.map(e => typeof e.values[primaryField] === "number" ? e.values[primaryField] as number : NaN).filter(n => !isNaN(n));
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  })();
  const weekDiff = thisWeekAvg != null && lastWeekAvg != null && lastWeekAvg !== 0
    ? ((thisWeekAvg - lastWeekAvg) / lastWeekAvg * 100) : null;

  return (
    <div className="space-y-4">
      {/* Period comparison */}
      {thisWeekAvg != null && lastWeekAvg != null && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-muted/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground uppercase">This Week Avg</p>
            <p className="text-lg font-bold tabular-nums">{thisWeekAvg.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{tracker.unit || ""}</span></p>
            <p className="text-xs text-muted-foreground">{thisWeek.length} entries</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground uppercase">Last Week Avg</p>
            <p className="text-lg font-bold tabular-nums">{lastWeekAvg.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{tracker.unit || ""}</span></p>
            <p className="text-xs text-muted-foreground">{lastWeek.length} entries</p>
          </div>
        </div>
      )}
      {weekDiff != null && (
        <div className={`text-xs rounded-md px-3 py-2 ${weekDiff > 0 ? "bg-orange-500/10 text-orange-600" : weekDiff < 0 ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
          {Math.abs(weekDiff) < 1 ? "Holding steady week-over-week" :
           `${weekDiff > 0 ? "Up" : "Down"} ${Math.abs(weekDiff).toFixed(1)}% from last week`}
        </div>
      )}

      {/* Moving average chart */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">7-Day Moving Average</p>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={maData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
              <Bar dataKey="value" fill={CHART_COLORS.light} radius={[2, 2, 0, 0]} name="Value" />
              <Line dataKey="ma" stroke={CHART_COLORS.primary} strokeWidth={2.5} dot={false} name="7d Avg" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Trend analysis text */}
      {(() => {
        const allStats = computeFieldStats(tracker.entries, primaryField);
        if (!allStats) return null;
        return (
          <div className="text-xs text-muted-foreground space-y-1 bg-muted/30 rounded-md p-3">
            <p>Range: {allStats.min.toFixed(1)} – {allStats.max.toFixed(1)} {tracker.unit || ""} across {allStats.count} readings</p>
            <p>Overall trend: {allStats.trendPct > 1 ? `increasing (+${allStats.trendPct.toFixed(1)}%)` : allStats.trendPct < -1 ? `decreasing (${allStats.trendPct.toFixed(1)}%)` : "stable"}</p>
          </div>
        );
      })()}
    </div>
  );
}

// -- Breakdown Tab (nutrition macros, BP distribution, etc.)
export function BreakdownTabContent({ tracker }: { tracker: Tracker }) {
  const spec = detectSpecialization(tracker);
  const cat = tracker.category.toLowerCase();
  const name = tracker.name.toLowerCase();
  const isNutrition = cat === "nutrition" || name.includes("nutrition") || name.includes("food") || name.includes("diet");
  const entries = tracker.entries;

  if (isNutrition) {
    // Macros breakdown
    const macroTotals = entries.reduce((acc, e) => {
      acc.protein += (typeof e.values.protein === "number" ? e.values.protein : 0);
      acc.carbs += (typeof e.values.carbs === "number" ? e.values.carbs : 0);
      acc.fat += (typeof e.values.fat === "number" ? e.values.fat : 0);
      acc.sugar += (typeof e.values.sugar === "number" ? e.values.sugar : 0);
      acc.fiber += (typeof e.values.fiber === "number" ? e.values.fiber : 0);
      acc.calories += (typeof e.values.calories === "number" ? e.values.calories : 0);
      return acc;
    }, { protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0, calories: 0 });
    const macroTotal = macroTotals.protein + macroTotals.carbs + macroTotals.fat;
    const pieData = [
      { name: "Protein", value: macroTotals.protein, color: CHART_COLORS.primary },
      { name: "Carbs", value: macroTotals.carbs, color: CHART_COLORS.gold },
      { name: "Fat", value: macroTotals.fat, color: CHART_COLORS.secondary },
    ].filter(d => d.value > 0);

    // Daily calorie chart
    const dailyCals = entries.reduce((acc: Record<string, number>, e) => {
      const d = new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      acc[d] = (acc[d] || 0) + (typeof e.values.calories === "number" ? e.values.calories : 0);
      return acc;
    }, {});
    const calData = Object.entries(dailyCals).map(([date, cal]) => ({ date, calories: Math.round(cal) }));

    return (
      <div className="space-y-5">
        {/* Macro averages */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground uppercase">Avg Protein</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.protein / entries.length).toFixed(0) : 0}g</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground uppercase">Avg Carbs</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.carbs / entries.length).toFixed(0) : 0}g</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground uppercase">Avg Fat</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.fat / entries.length).toFixed(0) : 0}g</p>
          </div>
        </div>
        {macroTotals.sugar > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase">Total Sugar</p>
              <p className="text-base font-bold tabular-nums">{macroTotals.sugar.toFixed(0)}g</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase">Total Fiber</p>
              <p className="text-base font-bold tabular-nums">{macroTotals.fiber.toFixed(0)}g</p>
            </div>
          </div>
        )}

        {/* Macro distribution pie */}
        {pieData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Macro Distribution</p>
            <div className="h-[180px] flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}
                    label={({ name, value }) => `${name}: ${macroTotal > 0 ? Math.round(value / macroTotal * 100) : 0}%`}>
                    {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(value: number) => `${value.toFixed(0)}g`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Daily calories bar */}
        {calData.length > 1 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Daily Calories</p>
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={calData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40} />
                  <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Bar dataKey="calories" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (spec === "bloodpressure") {
    // BP category distribution
    const categories = entries.map(e => e.computed?.bloodPressureCategory || "unknown").filter(c => c !== "unknown");
    const catCounts = categories.reduce((acc: Record<string, number>, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});
    const catColors: Record<string, string> = { normal: CHART_COLORS.primary, elevated: CHART_COLORS.gold, high_stage1: CHART_COLORS.secondary, high_stage2: CHART_COLORS.warning, crisis: "#dc2626" };
    const bpPieData = Object.entries(catCounts).map(([name, value]) => ({
      name: name.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
      value,
      color: catColors[name] || CHART_COLORS.tertiary,
    }));

    // Sys vs Dia comparison
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const bpLineData = sorted.slice(-20).map(e => ({
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      systolic: typeof e.values.systolic === "number" ? e.values.systolic : null,
      diastolic: typeof e.values.diastolic === "number" ? e.values.diastolic : null,
    }));

    return (
      <div className="space-y-5">
        {bpPieData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">BP Category Distribution</p>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={bpPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}
                    label={({ name, value }) => `${name}: ${value}`}>
                    {bpPieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        {bpLineData.length > 1 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Systolic vs Diastolic</p>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={bpLineData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40} />
                  <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Line type="monotone" dataKey="systolic" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={{ r: 3 }} name="Systolic" />
                  <Line type="monotone" dataKey="diastolic" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3 }} name="Diastolic" />
                  <Legend />
                  <ReferenceLine y={120} stroke={CHART_COLORS.gold} strokeDasharray="5 5" label={{ value: "Normal", fontSize: 10 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (spec === "sleep") {
    // Sleep quality distribution
    const qualities = entries.map(e => e.computed?.sleepQuality || "unknown").filter(q => q !== "unknown");
    const qCounts = qualities.reduce((acc: Record<string, number>, q) => { acc[q] = (acc[q] || 0) + 1; return acc; }, {});
    const qColors: Record<string, string> = { excellent: CHART_COLORS.primary, good: CHART_COLORS.tertiary, fair: CHART_COLORS.gold, poor: CHART_COLORS.secondary };
    const qPieData = Object.entries(qCounts).map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value, color: qColors[name] || CHART_COLORS.tertiary }));

    return (
      <div className="space-y-5">
        {qPieData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Sleep Quality Distribution</p>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={qPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}
                    label={({ name, value }) => `${name}: ${value}`}>
                    {qPieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (spec === "running" || cat === "fitness") {
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const runData = sorted.slice(-20).map(e => ({
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      distance: typeof e.values.distance === "number" ? e.values.distance : null,
      caloriesBurned: typeof e.values.caloriesBurned === "number" ? e.values.caloriesBurned : (e.computed?.caloriesBurned || null),
    }));

    return (
      <div className="space-y-5">
        {runData.length > 1 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Distance vs Calories Burned</p>
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={runData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={35} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={35} />
                  <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Bar yAxisId="right" dataKey="caloriesBurned" fill={CHART_COLORS.light} radius={[2, 2, 0, 0]} name="Calories" />
                  <Line yAxisId="left" type="monotone" dataKey="distance" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3 }} name="Distance" />
                  <Legend />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Generic multi-field breakdown
  const numericFields = tracker.fields.filter(f => f.type === "number");
  if (numericFields.length >= 2) {
    const fieldStats = numericFields.map(f => {
      const s = computeFieldStats(entries, f.name);
      return { field: f.name, ...s };
    }).filter(s => s.count != null && s.count > 0);

    return (
      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Field Averages</p>
        <div className="grid grid-cols-2 gap-2">
          {fieldStats.map(s => (
            <div key={s.field} className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground uppercase">{s.field}</p>
              <p className="text-base font-bold tabular-nums">{s.avg?.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">min: {s.min?.toFixed(1)} / max: {s.max?.toFixed(1)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <p className="text-sm text-muted-foreground">No breakdown data available for this tracker type.</p>;
}

// -- Correlations Tab
export function CorrelationsTabContent({ tracker }: { tracker: Tracker }) {
  const numericFields = tracker.fields.filter(f => f.type === "number");
  const [fieldA, setFieldA] = useState(numericFields[0]?.name || "");
  const [fieldB, setFieldB] = useState(numericFields[1]?.name || "");

  const scatterData = tracker.entries.map(e => {
    const a = typeof e.values[fieldA] === "number" ? e.values[fieldA] as number : null;
    const b = typeof e.values[fieldB] === "number" ? e.values[fieldB] as number : null;
    return a != null && b != null ? { x: a, y: b } : null;
  }).filter(Boolean) as { x: number; y: number }[];

  // Simple correlation coefficient
  const corr = (() => {
    if (scatterData.length < 3) return null;
    const n = scatterData.length;
    const sumX = scatterData.reduce((s, d) => s + d.x, 0);
    const sumY = scatterData.reduce((s, d) => s + d.y, 0);
    const sumXY = scatterData.reduce((s, d) => s + d.x * d.y, 0);
    const sumX2 = scatterData.reduce((s, d) => s + d.x * d.x, 0);
    const sumY2 = scatterData.reduce((s, d) => s + d.y * d.y, 0);
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={fieldA} onValueChange={setFieldA}>
          <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {numericFields.map(f => <SelectItem key={f.name} value={f.name}>{trackerFieldLabel(f)}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">vs</span>
        <Select value={fieldB} onValueChange={setFieldB}>
          <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {numericFields.map(f => <SelectItem key={f.name} value={f.name}>{trackerFieldLabel(f)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {corr != null && (
        <div className="text-xs bg-muted/30 rounded-md p-3">
          Correlation: <span className="font-bold tabular-nums">{corr.toFixed(3)}</span>
          {" — "}
          {Math.abs(corr) > 0.7 ? "Strong" : Math.abs(corr) > 0.4 ? "Moderate" : Math.abs(corr) > 0.2 ? "Weak" : "No"}
          {corr > 0.2 ? " positive" : corr < -0.2 ? " negative" : ""} relationship
        </div>
      )}

      {scatterData.length > 0 ? (
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="x" name={fieldA} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                label={{ value: fieldA, position: "bottom", fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis dataKey="y" name={fieldB} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40}
                label={{ value: fieldB, angle: -90, position: "insideLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
              <Scatter data={scatterData} fill={CHART_COLORS.primary} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-8">Not enough matching data points</p>
      )}
    </div>
  );
}
