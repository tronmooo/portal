// Finance visuals: the donut + ranked meters, the period bars and the small
// pure helpers behind them, shared by the Money overview (manual ledger, in
// dollars), the Expenses card (finance.tsx) and the connected-bank screens
// (ConnectedFinance, in integer minor units).
//
// Every component takes a `format` function, so this file never decides how
// money is printed: callers pass a lib/format.ts formatter for dollars or
// shared/money's formatMinor for minor units. Nothing here computes a balance
// or a total the server already computed: slices are the caller's rows,
// ranked, with the tail folded into "Other".
//
// Colors are "H S%" strings rendered through tracker-detail's tone(), so they
// take their lightness from the enclosing `.td-scope` (light vs dark mode).

import { useState, type ReactNode } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { MeterRow, tone } from "@/components/tracker-detail";
import { Button } from "@/components/ui/button";
import { formatMoney, formatMoneyRound } from "@/lib/format";
import type { BreakdownRow, MoneyByCurrency } from "@shared/finance-calc";

// ── Palette ──────────────────────────────────────────────────────────────────

/** The Finance accent pair and its two fixed meanings. */
export const FINANCE_HS = {
  accent: "155 62%",
  accent2: "178 70%",
  income: "152 62%",
  expense: "350 75%",
  net: "205 80%",
} as const;

/** Category colors by rank: distinct hues, none of them the income green or expense red. */
export const CATEGORY_PALETTE = [
  "205 80%", "38 90%", "275 65%", "178 70%", "330 72%", "24 92%", "248 75%", "84 60%",
] as const;
/** "Other" is grey, so it never reads as a category of its own. */
export const OTHER_HS = "215 14%";
export const OTHER_KEY = "__other";

// ── Pure helpers ─────────────────────────────────────────────────────────────

export interface SliceInput { key: string; label: string; amount: number; count?: number }
export interface Slice extends SliceInput {
  /** Share of the total, 0–100. */
  share: number;
  hs: string;
  isOther?: boolean;
}

/**
 * Rank rows highest-first and fold everything past `max - 1` into one "Other"
 * slice, so a donut never has twenty hairline wedges. Rows with no positive,
 * finite amount are dropped (a refund-only category is not a slice of spend).
 * Ties order by label so the ranking is stable between renders.
 */
export function rankSlices(
  items: ReadonlyArray<SliceInput>,
  opts: { max?: number; otherLabel?: string } = {},
): { slices: Slice[]; total: number } {
  const max = Math.max(2, opts.max ?? 6);
  const rows = items
    .filter((r) => Number.isFinite(r.amount) && r.amount > 0)
    .slice()
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  if (total <= 0) return { slices: [], total: 0 };
  const head = rows.length > max ? rows.slice(0, max - 1) : rows;
  const tail = rows.length > max ? rows.slice(max - 1) : [];
  const slices: Slice[] = head.map((r, i) => ({
    ...r, share: (r.amount / total) * 100, hs: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
  }));
  if (tail.length > 0) {
    const amount = tail.reduce((s, r) => s + r.amount, 0);
    slices.push({
      key: OTHER_KEY,
      label: opts.otherLabel ?? `Other (${tail.length})`,
      amount,
      count: tail.reduce((s, r) => s + (r.count ?? 0), 0) || undefined,
      share: (amount / total) * 100,
      hs: OTHER_HS,
      isOther: true,
    });
  }
  return { slices, total };
}

/**
 * The connected ledger's breakdown rows are per currency, and Portol does not
 * convert between currencies. A donut can only show one, so this picks the
 * currency carrying the most rows (ties: the first one the server listed) and
 * reports the others so the screen can say they are listed separately.
 */
export function breakdownSlices(
  rows: ReadonlyArray<BreakdownRow>,
  opts: { max?: number } = {},
): { currency: string | null; slices: Slice[]; total: number; otherCurrencies: string[] } {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let currency: string | null = null;
  for (const [c, n] of counts) if (currency == null || n > (counts.get(currency) ?? 0)) currency = c;
  if (currency == null) return { currency: null, slices: [], total: 0, otherCurrencies: [] };
  const { slices, total } = rankSlices(
    rows.filter((r) => r.currency === currency).map((r) => ({ key: r.key, label: r.label, amount: r.amount, count: r.count })),
    opts,
  );
  return { currency, slices, total, otherCurrencies: [...counts.keys()].filter((c) => c !== currency) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A period key as an axis label: "2026-10" → "Oct", "2026-W42" → "W42"; anything else unchanged. */
export function periodLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return MONTHS[Number(m[2]) - 1] ?? key;
  const w = /^\d{4}-W(\d{2})$/.exec(key);
  if (w) return `W${Number(w[1])}`;
  return key;
}

/** "Oct 2026" for an ISO date or month; null when unparseable. */
export function monthTitle(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso ?? ""));
  return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

/**
 * Per-period spending rows (groupBy week/month) as chart points in ONE
 * currency, oldest first. The server already summed each bucket; this only
 * picks the currency, orders and labels them.
 */
export function periodPoints(rows: ReadonlyArray<BreakdownRow>): { currency: string | null; points: PeriodPoint[] } {
  const { currency } = breakdownSlices(rows);
  if (currency == null) return { currency: null, points: [] };
  const points = rows
    .filter((r) => r.currency === currency)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({ label: periodLabel(r.key), value: r.amount }));
  return { currency, points };
}

/**
 * The months a "spending by month" chart lays out for the Expenses card's
 * range, oldest first, as "YYYY-MM". "This year" is January → now; "All time"
 * is the last six months; the month / 30-day views are too short for a trend
 * (one or two bars) and get none.
 */
export function trendMonths(range: "all" | "month" | "30d" | "year", todayISO: string): string[] {
  const m = /^(\d{4})-(\d{2})/.exec(todayISO);
  if (!m || range === "month" || range === "30d") return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const count = range === "year" ? mo : 6;
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = y * 12 + (mo - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** The one amount in a per-currency total, or null when there are zero or several. */
export function singleCurrency(totals: MoneyByCurrency | null | undefined): { currency: string; amount: number } | null {
  const entries = Object.entries(totals ?? {});
  return entries.length === 1 ? { currency: entries[0][0], amount: entries[0][1] } : null;
}

/** Whole-percent change from `prev` to `cur`; null when there is no base to compare with. */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev) || prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** A dollar axis tick: "$800", "$12k", "-$1.5k" — the shared formatter, abbreviated by thousands. */
export function axisDollars(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return formatMoneyRound(n);
  const k = a >= 10_000 ? Math.round(a / 1000) : Math.round(a / 100) / 10;
  // formatMoney prints 1.5 as "$1.50"; an axis wants "$1.5k".
  return `${formatMoney(Math.sign(n) * k).replace(/(\.\d)0$/, "$1")}k`;
}

/** First currency's change from a server `…ChangePct` map, rounded; null when absent. */
export function firstChangePct(map: Record<string, number | null> | null | undefined): number | null {
  const first = Object.values(map ?? {})[0];
  return typeof first === "number" && Number.isFinite(first) ? Math.round(first) : null;
}

// ── Donut ────────────────────────────────────────────────────────────────────

export function CategoryDonut({
  slices, total, format, centerLabel, active, onActive, size = 168, testId,
}: {
  slices: Slice[];
  total: number;
  format: (n: number) => string;
  centerLabel: string;
  active?: string | null;
  onActive?: (key: string | null) => void;
  size?: number;
  testId?: string;
}) {
  const current = slices.find((s) => s.key === active) ?? null;
  const thickness = Math.max(14, Math.round(size * 0.13));
  return (
    // Labels live in the centre and in the meter list, never around the ring,
    // so nothing is clipped at 390px.
    <div className="relative shrink-0" style={{ width: size, height: size }} data-testid={testId}
      role="img" aria-label={`${centerLabel} ${format(total)}: ${slices.map((s) => `${s.label} ${Math.round(s.share)}%`).join(", ")}`}>
      <PieChart width={size} height={size}>
        <Pie
          data={slices} dataKey="amount" nameKey="label"
          cx="50%" cy="50%" outerRadius={size / 2 - 2} innerRadius={size / 2 - 2 - thickness}
          startAngle={90} endAngle={-270}
          paddingAngle={slices.length > 1 ? 2 : 0} cornerRadius={slices.length > 1 ? 4 : 0}
          stroke="none" isAnimationActive={false}
          onMouseEnter={(_: unknown, i: number) => onActive?.(slices[i]?.key ?? null)}
          onMouseLeave={() => onActive?.(null)}
          onClick={(_: unknown, i: number) => onActive?.(slices[i]?.key === active ? null : slices[i]?.key ?? null)}
        >
          {slices.map((s) => (
            <Cell key={s.key} fill={tone(s.hs)} style={{ fill: tone(s.hs), cursor: "pointer", outline: "none" }}
              fillOpacity={current && current.key !== s.key ? 0.3 : 1} />
          ))}
        </Pie>
      </PieChart>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
        <span className="micro-label text-muted-foreground truncate max-w-full">{current ? current.label : centerLabel}</span>
        <span className="metric-value text-lg leading-tight tabular-nums mt-0.5 truncate max-w-full"
          style={current ? { color: tone(current.hs) } : undefined}>
          {format(current ? current.amount : total)}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {current ? `${Math.round(current.share)}% of total` : `${slices.length} ${slices.length === 1 ? "group" : "groups"}`}
        </span>
      </div>
    </div>
  );
}

// ── Donut + ranked meters ────────────────────────────────────────────────────

/**
 * The spending-by-category block: a donut beside the same slices as ranked
 * meter bars with their share. Hovering or focusing either highlights the
 * other; tapping a row calls `onSelect` (e.g. filter the expense list) when
 * the caller offers one. "Other" is not selectable — it is not one thing.
 */
export function CategoryBreakdown({
  slices, total, format, centerLabel = "Total", onSelect, rowTestId, testId, selectHint,
}: {
  slices: Slice[];
  total: number;
  format: (n: number) => string;
  centerLabel?: string;
  onSelect?: (key: string) => void;
  rowTestId?: (key: string) => string;
  testId?: string;
  /** Says what a tap does, e.g. "Tap a category to filter the list". */
  selectHint?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-4 min-w-0" data-testid={testId}>
      <div className="flex justify-center">
        <CategoryDonut slices={slices} total={total} format={format} centerLabel={centerLabel}
          active={active} onActive={setActive} testId={testId ? `${testId}-donut` : undefined} />
      </div>
      <div className="flex-1 min-w-0 space-y-2.5">
        {slices.map((s) => {
          const selectable = !!onSelect && !s.isOther;
          return (
            <button
              key={s.key}
              type="button"
              className={`w-full text-left rounded-lg px-1.5 py-1 -mx-1.5 transition-colors ${active === s.key ? "bg-muted/60" : ""} ${selectable ? "hover:bg-muted/50" : "cursor-default"}`}
              onMouseEnter={() => setActive(s.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(s.key)}
              onBlur={() => setActive(null)}
              onClick={() => (selectable ? onSelect!(s.key) : setActive(active === s.key ? null : s.key))}
              aria-label={`${s.label}: ${format(s.amount)}, ${Math.round(s.share)}%${selectable && selectHint ? ` — ${selectHint}` : ""}`}
              data-testid={rowTestId?.(s.key)}
            >
              <MeterRow
                label={s.label}
                value={`${format(s.amount)} · ${s.share < 1 ? "<1" : Math.round(s.share)}%`}
                pct={s.share}
                hs={s.hs}
              />
            </button>
          );
        })}
        {selectHint && onSelect && <p className="text-[11px] text-muted-foreground px-0.5">{selectHint}</p>}
      </div>
    </div>
  );
}

// ── Period bars ──────────────────────────────────────────────────────────────

export interface PeriodPoint { label: string; value: number }

/** One bar per period (week or month) — a single series in one color. */
export function PeriodBars({
  data, hs, format, compact, height = 168, testId,
}: {
  data: PeriodPoint[];
  hs: string;
  format: (n: number) => string;
  /** Short axis ticks ("$1.2k"); defaults to `format`. */
  compact?: (n: number) => string;
  height?: number;
  testId?: string;
}) {
  const gid = `pb-${hs.replace(/[^0-9]/g, "")}`;
  return (
    <div style={{ height }} className="w-full min-w-0" data-testid={testId}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tone(hs)} stopOpacity={0.95} />
              <stop offset="100%" stopColor={tone(hs)} stopOpacity={0.45} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} axisLine={false} tickLine={false}
            stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" minTickGap={8} />
          <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={48}
            stroke="hsl(var(--muted-foreground))" tickFormatter={(v: number) => (compact ?? format)(v)} />
          <Tooltip
            cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
            contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12 }}
            formatter={(v: number) => [format(Number(v)), "Spent"]}
          />
          <Bar dataKey="value" fill={`url(#${gid})`} radius={[6, 6, 2, 2]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── In vs out ────────────────────────────────────────────────────────────────

/** Inflow and outflow as two meters on one scale, with the net underneath. */
export function FlowCompare({
  inflow, outflow, net, format, testId,
}: {
  inflow: number; outflow: number; net: ReactNode;
  format: (n: number) => string;
  testId?: string;
}) {
  const scale = Math.max(inflow, outflow, 1);
  return (
    <div className="space-y-3" data-testid={testId}>
      <MeterRow label="Money in" value={format(inflow)} pct={(inflow / scale) * 100} hs={FINANCE_HS.income} />
      <MeterRow label="Money out" value={format(outflow)} pct={(outflow / scale) * 100} hs={FINANCE_HS.expense} />
      <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-2 text-sm">
        <span className="text-muted-foreground">Net</span>
        <span className="metric-value tabular-nums">{net}</span>
      </div>
    </div>
  );
}

// ── Failed request ───────────────────────────────────────────────────────────

/** A failed load says so — it is never shown as "nothing in this period" (sync rule 7). */
export function FinanceLoadError({ what, onRetry, testId }: { what: string; onRetry: () => void; testId?: string }) {
  return (
    <div className="bubble flex items-start gap-3 p-4" style={{ ["--accent-hsl" as any]: "38 90% 52%" }} data-testid={testId}>
      <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Couldn't load {what}</p>
        <p className="text-xs text-muted-foreground mt-0.5">This is a connection problem, not an empty account. Your data is unchanged.</p>
      </div>
      <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 shrink-0" onClick={onRetry}>
        <RefreshCw className="h-3 w-3" /> Retry
      </Button>
    </div>
  );
}
