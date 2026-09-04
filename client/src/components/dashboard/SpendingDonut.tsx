// PERF (2026-09-04) — the dashboard's only recharts usage, extracted so it can
// be lazy-loaded.
//
// `dashboard.tsx` imported `PieChart, Pie, Cell, ResponsiveContainer, Tooltip`
// from "recharts" at module scope. Because the page chunk is what a /dashboard
// navigation waits on, that static import put recharts' whole cartesian chart
// factory on the critical path: ~430KB raw across
// generateCategoricalChart / YAxis / PieChart / ComposedChart chunks, downloaded
// and parsed before the first tile could paint — for two small category donuts,
// one of which only renders when a drill-down panel is open.
//
// Keeping the recharts import inside this module means Rollup places it in this
// component's own lazy chunk hierarchy, so it is fetched when a donut actually
// renders rather than on every dashboard open.
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

export interface SpendingDonutSlice {
  name: string;
  value: number;
}

export interface SpendingDonutProps {
  data: SpendingDonutSlice[];
  colors: string[];
  /** Fixed pixel height, or "100%" to fill the parent (which must be sized). */
  height: number | string;
  innerRadius?: number;
  outerRadius: number;
  /** Recharts stroke on each slice; "none" for the seamless hero donut. */
  stroke?: string;
  tooltipStyle: React.CSSProperties;
  /** Mirrors recharts' Tooltip `formatter` — [displayValue, displayName]. */
  formatter: (value: number, name: string) => [string, string];
}

export default function SpendingDonut({
  data,
  colors,
  height,
  innerRadius,
  outerRadius,
  stroke,
  tooltipStyle,
  formatter,
}: SpendingDonutProps) {
  return (
    <ResponsiveContainer width="100%" height={height as any}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          paddingAngle={2}
          stroke={stroke}
        >
          {data.map((slice, i) => (
            <Cell key={slice.name ?? i} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v: any, n: any) => formatter(Number(v), String(n))}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
