// ── Balance history: the value line of a financial asset ─────────────────────
//
// Every financial account keeps timestamped balance observations
// (shared/financial-assets.ts). This draws them with the period selector a
// brokerage app has — 1W · 1M · 3M · YTD · 1Y · ALL — and states the change
// over the window in dollars and percent. Everything is computed from the
// profile the page already holds: no request, no cache to go stale.
//
// A single observation is not a history: the chart then says so instead of
// drawing a flat line that looks like data.

import { useMemo, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { formatMoney, formatListDate } from "@/lib/format";
import {
  balanceSeries, seriesForPeriod, HISTORY_PERIODS, type HistoryPeriod, type BalancePoint,
} from "@shared/financial-assets";

export function ChangeChip({ change, changePct, className = "" }: { change: number | null; changePct: number | null; className?: string }) {
  if (change == null) return <span className={`text-[12px] text-muted-foreground ${className}`}>no change yet</span>;
  const up = change > 0, flat = change === 0;
  const tone = flat ? "text-muted-foreground" : up ? "text-emerald-600" : "text-red-500";
  return (
    <span className={`text-[12px] font-semibold tabular-nums ${tone} ${className}`} data-testid="balance-change-chip">
      {flat ? "" : up ? "▲ " : "▼ "}{up ? "+" : flat ? "" : "−"}{formatMoney(Math.abs(change))}
      {changePct != null && <span className="font-normal"> ({changePct > 0 ? "+" : ""}{changePct.toFixed(1)}%)</span>}
    </span>
  );
}

export function PeriodSelector({ value, onChange, disabled }: {
  value: HistoryPeriod; onChange: (p: HistoryPeriod) => void; disabled?: ReadonlySet<HistoryPeriod>;
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted/60 p-0.5" role="tablist" data-testid="history-period-selector">
      {HISTORY_PERIODS.map((p) => (
        <button
          key={p} type="button" role="tab" aria-selected={p === value}
          disabled={disabled?.has(p)}
          onClick={() => onChange(p)}
          className={`px-2 py-0.5 text-[11px] font-semibold rounded-md transition-colors disabled:opacity-40 ${
            p === value ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          data-testid={`history-period-${p}`}
        >{p}</button>
      ))}
    </div>
  );
}

function tickLabel(date: string, period: HistoryPeriod): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  if (period === "1W" || period === "1M") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (period === "ALL" || period === "1Y") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function BalanceHistoryChart({ profile, todayISO, accent = "#20808D", height = 160, title = "Balance history", isDebt = false }: {
  profile: any;
  todayISO: string;
  accent?: string;
  height?: number;
  title?: string;
  isDebt?: boolean;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>("3M");
  const series = useMemo(() => balanceSeries(profile, todayISO), [profile, todayISO]);
  const windowed = useMemo(() => seriesForPeriod(series, period, todayISO), [series, period, todayISO]);

  // A period with a single point inside it has nothing to draw.
  const empty = useMemo(() => {
    const out = new Set<HistoryPeriod>();
    for (const p of HISTORY_PERIODS) if (seriesForPeriod(series, p, todayISO).points.length < 2) out.add(p);
    return out;
  }, [series, todayISO]);

  if (series.length < 2) {
    return (
      <div className="rounded-xl border border-border/40 p-3" data-testid="balance-history-empty">
        <p className="micro-label text-muted-foreground">{title}</p>
        <p className="text-[12px] text-muted-foreground mt-1">
          One balance recorded{series[0] ? ` (${formatListDate(series[0].date)})` : ""}. Each update adds a point here — nothing is overwritten.
        </p>
      </div>
    );
  }

  const points = windowed.points.length >= 2 ? windowed.points : series;
  const data = points.map((p: BalancePoint) => ({ date: p.date, value: p.balance, label: tickLabel(p.date, period) }));
  const min = Math.min(...data.map((d) => d.value));
  const max = Math.max(...data.map((d) => d.value));
  const pad = Math.max((max - min) * 0.15, max * 0.02, 1);
  const gradientId = `bal-grad-${String(profile?.id ?? "x").slice(0, 8)}`;

  return (
    <div className="space-y-2" data-testid="balance-history-chart">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="micro-label text-muted-foreground">{title}</p>
          <ChangeChip change={isDebt && windowed.change != null ? -windowed.change : windowed.change} changePct={windowed.changePct} className="mt-0.5" />
        </div>
        <PeriodSelector value={period} onChange={setPeriod} disabled={empty} />
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
                <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={24} />
            <YAxis
              domain={[Math.max(0, min - pad), max + pad]}
              tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={48}
              tickFormatter={(v: number) => v >= 1000 ? `$${(v / 1000).toFixed(v >= 100000 ? 0 : 1)}k` : `$${Math.round(v)}`}
            />
            <RTooltip
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
              labelFormatter={(_: any, payload: any) => payload?.[0]?.payload?.date ? formatListDate(payload[0].payload.date) : ""}
              formatter={(v: number) => [formatMoney(v), isDebt ? "Owed" : "Balance"]}
            />
            <Area type="monotone" dataKey="value" stroke={accent} strokeWidth={2} fill={`url(#${gradientId})`} dot={data.length <= 12} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {windowed.from != null && windowed.start ? `${formatMoney(windowed.from)} on ${formatListDate(windowed.start)} → ` : ""}
        {windowed.to != null ? `${formatMoney(windowed.to)} now` : ""} · {series.length} observations
      </p>
    </div>
  );
}

/** A tiny dependency-free line for cards. */
export function BalanceSparkline({ points, color = "currentColor", width = 96, height = 28, className = "" }: {
  points: ReadonlyArray<{ balance: number }>; color?: string; width?: number; height?: number; className?: string;
}) {
  if (!points || points.length < 2) return null;
  const values = points.map((p) => p.balance);
  const lo = Math.min(...values), hi = Math.max(...values);
  const rng = hi - lo || 1;
  const step = width / (values.length - 1);
  const d = values.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(height - 2 - ((v - lo) / rng) * (height - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden="true" data-testid="balance-sparkline">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
