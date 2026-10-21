// The tracker detail chart. One component, three honest shapes:
//   - fewer than MIN_TREND_DAYS logged days → dots only (no filled area
//     pretending to be a trend — the old "giant blue block" from one reading);
//   - additive metrics (daily totals) → gradient bars, one per logged day;
//   - readings → a smooth gradient area.
// Gaps are real: days with nothing logged are null, never 0. Tapping a point
// reports its day so the caller can show the entries behind it.

import { useId, useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, Cell,
} from "recharts";
import {
  MIN_TREND_DAYS, daysBetween, shiftDay, dayLabel, type DayPoint, type DayMode,
} from "@shared/tracker-analytics";
import { tone } from "./theme";
import { withUnit } from "./primitives";

export interface TrendChartProps {
  points: DayPoint[];
  mode: DayMode;
  unit: string;
  /** Range to lay out on the axis; defaults to first..last logged day. */
  fromDay?: string | null;
  toDay?: string;
  movingAvg?: Array<number | null>;
  goal?: number | null;
  /** "H S%" overrides the theme accent (e.g. a macro color). */
  hs?: string;
  height?: number;
  selectedDay?: string | null;
  onSelectDay?: (day: string) => void;
  /** Bars above the goal draw in this color ("H S%"). */
  overGoalHs?: string;
  /** Y-axis labels for scales that aren't plain numbers (mood 1–8 → "Good"). */
  yTickFormatter?: (v: number) => string;
  yDomain?: [number, number];
  /** Tooltip text for a value; defaults to value + unit. */
  valueLabel?: (v: number) => string;
}

interface Row {
  day: string;
  label: string;
  value: number | null;
  entries: number;
  ma: number | null;
}

function ChartTooltip({ active, payload, unit, mode, valueLabel }: any) {
  if (!active || !payload?.length) return null;
  const row: Row = payload[0].payload;
  if (row.value == null) return null;
  return (
    <div className="surface-panel bg-popover px-3 py-2 text-xs">
      <p className="font-semibold">{dayLabel(row.day, { weekday: "short", month: "short", day: "numeric" })}</p>
      <p className="mt-0.5 tabular-nums">
        <span className="font-bold text-sm">{valueLabel ? valueLabel(row.value) : withUnit(row.value, unit)}</span>
        {mode === "sum" && <span className="text-muted-foreground"> total</span>}
      </p>
      <p className="text-muted-foreground">{row.entries} {row.entries === 1 ? "entry" : "entries"}</p>
      {row.ma != null && <p className="text-muted-foreground">7-day avg {withUnit(row.ma, unit)}</p>}
    </div>
  );
}

export function TrendChart({
  points, mode, unit, fromDay, toDay, movingAvg, goal, hs, height = 220, selectedDay, onSelectDay, overGoalHs,
  yTickFormatter, yDomain, valueLabel,
}: TrendChartProps) {
  const gid = useId().replace(/:/g, "");
  const color = hs ? tone(hs) : tone("var(--td-hs)");
  const color2 = hs ? tone(hs, 0.55) : tone("var(--td-hs2)");
  const sparse = points.length < MIN_TREND_DAYS;

  const rows = useMemo<Row[]>(() => {
    if (points.length === 0) return [];
    const maByDay = new Map(points.map((p, i) => [p.day, movingAvg?.[i] ?? null]));
    const start = fromDay && fromDay < points[0].day ? fromDay : points[0].day;
    const end = toDay || points[points.length - 1].day;
    const span = daysBetween(start, end);
    // Lay out every calendar day for short ranges so spacing is honest; for
    // long ranges, one slot per logged day keeps bars readable.
    if (span <= 120 && !sparse) {
      const byDay = new Map(points.map((p) => [p.day, p]));
      const out: Row[] = [];
      for (let i = 0; i <= span; i++) {
        const day = shiftDay(start, i);
        const p = byDay.get(day);
        out.push({ day, label: dayLabel(day), value: p ? p.value : null, entries: p?.entries ?? 0, ma: maByDay.get(day) ?? null });
      }
      return out;
    }
    return points.map((p) => ({ day: p.day, label: p.label, value: p.value, entries: p.entries, ma: maByDay.get(p.day) ?? null }));
  }, [points, movingAvg, fromDay, toDay, sparse]);

  if (rows.length === 0) return null;
  const hasMa = rows.some((r) => r.ma != null);
  const axisTick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" };
  const fmtTick = (v: number) => (unit === "$" ? `$${Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : v}` : Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : `${v}`);
  const click = (data: any) => {
    const day = data?.activePayload?.[0]?.payload?.day;
    if (day && onSelectDay) onSelectDay(day);
  };

  return (
    <div style={{ height }} className="w-full" data-testid="td-trend-chart" data-shape={sparse ? "dots" : mode === "sum" ? "bars" : "area"}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 10, right: 8, bottom: 0, left: -6 }} onClick={click}>
          <defs>
            <linearGradient id={`fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.38} />
              <stop offset="100%" stopColor={color2} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`bar-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={1} />
              <stop offset="100%" stopColor={color2} stopOpacity={0.75} />
            </linearGradient>
            <linearGradient id={`stroke-${gid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={color2} />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 6" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={yTickFormatter ? 58 : 44} tickFormatter={yTickFormatter ?? fmtTick}
            domain={yDomain ?? (mode === "sum" ? [0, "auto"] : ["auto", "auto"])} allowDecimals={false} />
          <Tooltip content={<ChartTooltip unit={unit} mode={mode} valueLabel={valueLabel} />} cursor={{ fill: "hsl(var(--muted) / 0.5)", stroke: "hsl(var(--border))" }} />
          {typeof goal === "number" && goal > 0 && (
            <ReferenceLine y={goal} stroke={tone("40 92%")} strokeDasharray="5 5" ifOverflow="extendDomain"
              label={{ value: `Goal ${withUnit(goal, unit)}`, position: "insideTopRight", fontSize: 11, fill: tone("40 92%") }} />
          )}
          {sparse ? (
            <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} strokeDasharray="4 4" connectNulls
              dot={{ r: 5, fill: color, stroke: "hsl(var(--card))", strokeWidth: 2 }} activeDot={{ r: 7 }} isAnimationActive />
          ) : mode === "sum" ? (
            <Bar dataKey="value" radius={[6, 6, 2, 2]} maxBarSize={34} fill={`url(#bar-${gid})`}>
              {rows.map((r) => (
                <Cell key={r.day}
                  fill={overGoalHs && typeof goal === "number" && r.value != null && r.value > goal ? tone(overGoalHs) : `url(#bar-${gid})`}
                  opacity={selectedDay && selectedDay !== r.day ? 0.45 : 1} />
              ))}
            </Bar>
          ) : (
            <Area type="monotone" dataKey="value" stroke={`url(#stroke-${gid})`} strokeWidth={2.5} fill={`url(#fill-${gid})`} connectNulls
              dot={rows.filter((r) => r.value != null).length <= 31 ? { r: 3, fill: color, strokeWidth: 0 } : false}
              activeDot={{ r: 6, fill: color, stroke: "hsl(var(--card))", strokeWidth: 2 }} />
          )}
          {hasMa && (
            <Line type="monotone" dataKey="ma" stroke="hsl(var(--foreground))" strokeOpacity={0.55} strokeWidth={1.75}
              strokeDasharray="6 4" dot={false} connectNulls name="7-day avg" />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
