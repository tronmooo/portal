// PERF (2026-09-04) — the Finance page's one inline recharts chart, extracted
// so it can be lazy-loaded.
//
// finance.tsx imported recharts at module scope for this single "Spending by
// Category" bar chart, which put ~416KB of chart code (generateCategoricalChart
// / YAxis / PieChart / ComposedChart) in front of the Finance tab's first
// paint. The chart sits well below the KPI tiles and the account list, and
// renders only when there is category data to draw.
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

export interface CategorySpendDatum {
  name: string;
  amount: number;
}

export default function CategorySpendBars({
  data,
  categoryColors,
}: {
  data: CategorySpendDatum[];
  categoryColors: Record<string, string>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <XAxis dataKey="name" tick={{ fontSize: 12 }} className="capitalize" />
        <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
        <Tooltip
          formatter={(v: number) => [`$${v.toFixed(2)}`, "Amount"]}
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
        />
        <Bar dataKey="amount" radius={[6, 6, 0, 0]}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={categoryColors[entry.name] || categoryColors.general} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
