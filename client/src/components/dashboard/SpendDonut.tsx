// ─── Spending donut (lazy recharts chunk) ────────────────────────────────────
// PERF: pages/dashboard.tsx used to `import { PieChart, Pie, ... } from
// "recharts"` at module scope for two small donuts. That put the whole recharts
// runtime (~430 KB raw / ~130 KB gzipped across generateCategoricalChart,
// YAxis and PieChart) on the dashboard's critical path, blocking first paint
// for every user — including the ones whose donuts render empty. The chart now
// lives behind React.lazy in LazySpendDonut.tsx, so it streams in beside the
// dashboard data instead of ahead of it.
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

export interface SpendDonutSlice {
  name: string;
  value: number;
}

export interface SpendDonutProps {
  data: SpendDonutSlice[];
  colors: readonly string[];
  /** Height passed to ResponsiveContainer — "100%" fills the parent box. */
  height: number | string;
  innerRadius?: number;
  outerRadius?: number;
  paddingAngle?: number;
  stroke?: string;
  tooltipContentStyle?: React.CSSProperties;
  /** Formats a slice into the tooltip's [value, label] pair. */
  formatTooltip: (value: number, name: string) => [string, string];
}

export function SpendDonut({
  data, colors, height, innerRadius, outerRadius = 60,
  paddingAngle = 2, stroke, tooltipContentStyle, formatTooltip,
}: SpendDonutProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          paddingAngle={paddingAngle}
          stroke={stroke}
        >
          {data.map((slice, i) => (
            <Cell key={`${slice.name}-${i}`} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(v: any, n: any) => formatTooltip(Number(v), String(n))}
          contentStyle={tooltipContentStyle}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

export default SpendDonut;
