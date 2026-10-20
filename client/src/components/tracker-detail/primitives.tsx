// Building blocks for the tracker detail popup. Each takes plain numbers and
// reads its colors from the enclosing `.td-scope` (see theme.ts), so the same
// component looks native on a Nutrition, Sleep or Finance tracker.

import { useMemo, type ReactNode } from "react";
import {
  ArrowDownRight, ArrowUpRight, ArrowRight, Info, TrendingUp, TrendingDown,
  Trophy, Target, AlertTriangle, Sparkles, Database, type LucideIcon,
} from "lucide-react";
import { CountUp } from "@/components/dashboard/visuals";
import { formatMoney } from "@/lib/format";
import { AreaChart as Sparkline } from "@/components/tracker-viz";
import type { InsightTone, TrackerInsight, DayPoint } from "@shared/tracker-analytics";
import { shiftDay, dayLabel } from "@shared/tracker-analytics";
import { tone } from "./theme";

// ── Numbers ──────────────────────────────────────────────────────────────────

/** "1,240", "12.5", "0.25" — precision follows magnitude. */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  const v = a >= 1000 ? Math.round(n) : a >= 10 ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
  return v.toLocaleString("en-US");
}

/** Units nobody reads to a decimal: "691 kcal", not "691.2 kcal". */
const WHOLE_UNITS = /^(kcal|cal|calories|steps|mg)$/i;

/** A value with its unit; "$" leads, everything else trails. */
export function withUnit(n: number | null | undefined, unit: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (unit === "$") return formatMoney(Math.round(n * 100) / 100);
  if (WHOLE_UNITS.test(unit)) n = Math.round(n);
  return unit ? `${fmtNum(n)} ${unit}` : fmtNum(n);
}

// ── Section header ───────────────────────────────────────────────────────────

export function SectionTitle({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 mb-2.5">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}

// ── Delta chip ───────────────────────────────────────────────────────────────

export function DeltaChip({ pct, good, label }: { pct: number; good: boolean | null; label?: string }) {
  const flat = Math.abs(pct) < 1;
  if (flat) good = null;
  const Icon = flat ? ArrowRight : pct > 0 ? ArrowUpRight : ArrowDownRight;
  const cls = good == null
    ? "bg-muted text-muted-foreground"
    : good
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : "bg-rose-500/15 text-rose-700 dark:text-rose-300";
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {flat ? (label ? null : "flat") : `${Math.abs(pct)}%`}
      {label && <span className={`font-normal ${flat ? "" : "opacity-80 ml-0.5"}`}>{label}</span>}
    </span>
  );
}

// ── Hero metric ──────────────────────────────────────────────────────────────

export function HeroMetric({
  icon: Icon, eyebrow, value, display, unit, caption, delta, spark, side,
}: {
  icon: LucideIcon;
  eyebrow: string;
  /** Numeric value counts up; pass `display` for composite values ("122/80"). */
  value?: number | null;
  display?: string;
  unit?: string;
  caption?: ReactNode;
  delta?: ReactNode;
  spark?: number[];
  side?: ReactNode;
}) {
  const isMoney = unit === "$";
  if (isMoney && display == null && value != null && Number.isFinite(value)) display = formatMoney(Math.round(value * 100) / 100);
  // Only whole numbers count up — CountUp steps in integers, so 184.5 would land on 185.
  const showCount = display == null && value != null && Number.isInteger(value) && Math.abs(value) >= 10;
  return (
    <section className="td-hero td-rise p-4 sm:p-5" data-testid="td-hero">
      <div className="relative z-[1] flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="medallion medallion-sm" aria-hidden="true">
              <Icon className="h-4 w-4" strokeWidth={2.2} />
            </span>
            <span className="micro-label text-muted-foreground truncate">{eyebrow}</span>
          </div>
          <div className="mt-3 flex items-baseline gap-1.5 flex-wrap">
            <span className="metric-value text-[2.6rem] leading-none td-gradient-text" data-testid="td-hero-value">
              {display != null
                ? display
                : value == null
                  ? "—"
                  : showCount
                    ? <CountUp value={value} />
                    : fmtNum(value)}
            </span>
            {unit && !isMoney && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
          </div>
          {(delta || caption) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
              {delta}
              {caption && <span>{caption}</span>}
            </div>
          )}
        </div>
        {side && <div className="shrink-0">{side}</div>}
      </div>
      {spark && spark.length >= 2 && (
        <div className="relative z-[1] mt-3 -mx-1 opacity-90" aria-hidden="true">
          <Sparkline values={spark} color={tone("var(--td-hs)")} height={44} />
        </div>
      )}
    </section>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────────────

export function StatTile({
  label, value, basis, icon: Icon, hs, i = 0,
}: {
  label: string;
  value: ReactNode;
  /** What the number is over: "per logged day · 30d", "total · 7d". */
  basis?: string;
  icon?: LucideIcon;
  hs?: string;
  i?: number;
}) {
  return (
    <div
      className="bubble td-rise p-3 min-w-0"
      style={{ ["--i" as any]: i, ...(hs ? { ["--accent-hsl" as any]: `${hs} 52%` } : {}) }}
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: hs ? tone(hs) : undefined }} aria-hidden="true" />}
        <span className="micro-label truncate">{label}</span>
      </div>
      <div className="mt-1.5 text-xl metric-value leading-tight truncate" style={{ color: hs ? tone(hs) : undefined }}>{value}</div>
      {basis && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{basis}</p>}
    </div>
  );
}

// ── Insight card ─────────────────────────────────────────────────────────────

const INSIGHT_STYLE: Record<InsightTone, { icon: LucideIcon; hs: string; label: string }> = {
  improvement: { icon: TrendingUp, hs: "152 65%", label: "Improving" },
  decline:     { icon: TrendingDown, hs: "350 78%", label: "Watch" },
  milestone:   { icon: Trophy, hs: "40 92%", label: "Milestone" },
  goal:        { icon: Target, hs: "265 72%", label: "Goal" },
  unusual:     { icon: AlertTriangle, hs: "25 92%", label: "Unusual" },
  quality:     { icon: Database, hs: "210 15%", label: "Data note" },
  info:        { icon: Sparkles, hs: "199 80%", label: "Pattern" },
};

export function InsightCard({ insight, i = 0 }: { insight: TrackerInsight; i?: number }) {
  const s = INSIGHT_STYLE[insight.tone];
  const Icon = s.icon;
  return (
    <div
      className="bubble td-rise flex items-start gap-3 p-3.5"
      style={{ ["--i" as any]: i, ["--accent-hsl" as any]: `${s.hs} 50%` }}
      data-testid={`td-insight-${insight.id}`}
    >
      <span className="medallion medallion-sm" aria-hidden="true">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="micro-label" style={{ color: tone(s.hs) }}>{s.label}</p>
        <p className="text-sm font-semibold leading-snug mt-0.5">{insight.title}</p>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{insight.detail}</p>
      </div>
    </div>
  );
}

// ── Notes and empty states ───────────────────────────────────────────────────

export function CoverageNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground leading-relaxed">
      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function TrackerEmptyState({ icon: Icon, title, body, progress }: {
  icon: LucideIcon; title: string; body: string;
  /** e.g. { have: 2, need: 4 } — draws a small unlock meter. */
  progress?: { have: number; need: number };
}) {
  return (
    <div className="bubble td-rise flex items-start gap-3 p-4" data-testid="td-empty">
      <span className="medallion medallion-sm" aria-hidden="true"><Icon className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{body}</p>
        {progress && progress.need > 0 && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="td-meter flex-1">
              <span style={{ width: `${Math.min(100, (progress.have / progress.need) * 100)}%`, background: `linear-gradient(90deg, ${tone("var(--td-hs)")}, ${tone("var(--td-hs2)")})` }} />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">{progress.have}/{progress.need}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Segmented control ────────────────────────────────────────────────────────

export function Segmented<T extends string>({ value, options, onChange, label, testId }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
  testId?: string;
}) {
  return (
    <div className="max-w-full overflow-x-auto -mx-1 px-1" data-testid={testId}>
      <div className="td-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="td-seg-item"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Meter row ────────────────────────────────────────────────────────────────

export function MeterRow({ label, value, pct, hs, sub }: { label: string; value: string; pct: number; hs: string; sub?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium truncate">{label}</span>
        <span className="tabular-nums font-semibold shrink-0">{value}</span>
      </div>
      <div className="td-meter mt-1.5">
        <span style={{ width: `${Math.max(2, Math.min(100, pct))}%`, background: `linear-gradient(90deg, ${tone(hs)}, ${tone(hs, 0.65)})` }} />
      </div>
      {sub && <p className="text-[11px] text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

// ── Rings ────────────────────────────────────────────────────────────────────

/** Concentric animated rings, outermost first. `pct` is 0–100. */
export function RingStack({ rings, size = 132, stroke = 11, center }: {
  rings: Array<{ pct: number; hs: string; label: string }>;
  size?: number;
  stroke?: number;
  center?: ReactNode;
}) {
  const gap = 3;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img"
        aria-label={rings.map((r) => `${r.label} ${Math.round(r.pct)}%`).join(", ")}>
        {rings.map((r, idx) => {
          const radius = size / 2 - stroke / 2 - idx * (stroke + gap);
          if (radius <= stroke / 2) return null;
          const c = 2 * Math.PI * radius;
          const off = c * (1 - Math.max(0, Math.min(1, r.pct / 100)));
          return (
            <g key={r.label}>
              <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} stroke={tone(r.hs, 0.16)} />
              <circle className="ring-progress" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke}
                stroke={tone(r.hs)} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off}
                style={{ ["--ring-circumference" as any]: `${c}` }} />
            </g>
          );
        })}
      </svg>
      {center && <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight">{center}</div>}
    </div>
  );
}

// ── Calendar heatmap ─────────────────────────────────────────────────────────

/**
 * Weeks as columns (Mon→Sun rows), most recent on the right. Intensity is the
 * day's value relative to the period's best day; days with nothing logged are
 * plain, never "zero-coloured".
 */
export function CalendarHeatmap({ points, today, weeks = 16, unit, onSelect }: {
  points: DayPoint[];
  today: string;
  weeks?: number;
  unit: string;
  onSelect?: (day: string) => void;
}) {
  const grid = useMemo(() => {
    const byDay = new Map(points.map((p) => [p.day, p]));
    const [y, m, d] = today.split("-").map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    const start = shiftDay(today, -(dow + 7 * (weeks - 1)));
    const cols: Array<Array<{ day: string; p?: DayPoint; future: boolean }>> = [];
    let max = 0;
    for (let w = 0; w < weeks; w++) {
      const col = [];
      for (let r = 0; r < 7; r++) {
        const day = shiftDay(start, w * 7 + r);
        const p = byDay.get(day);
        if (p && Math.abs(p.value) > max) max = Math.abs(p.value);
        col.push({ day, p, future: day > today });
      }
      cols.push(col);
    }
    const months = cols.map((c, i) => {
      const first = c[0].day;
      const prev = i > 0 ? cols[i - 1][0].day : null;
      return !prev || prev.slice(5, 7) !== first.slice(5, 7) ? dayLabel(first, { month: "short" }) : "";
    });
    return { cols, max, months };
  }, [points, today, weeks]);

  return (
    <div className="w-full max-w-md" data-testid="td-heatmap">
      <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
        {grid.months.map((m, i) => (
          <span key={i} className="text-[11px] text-muted-foreground leading-none h-3.5 overflow-visible whitespace-nowrap">{m}</span>
        ))}
        {grid.cols.map((col, ci) => (
          <div key={ci} className="grid gap-[3px]" style={{ gridTemplateRows: "repeat(7, minmax(0, 1fr))", gridColumn: ci + 1, gridRow: 2 }}>
            {col.map(({ day, p, future }) => {
              const level = p && grid.max > 0 ? 0.28 + 0.72 * (Math.abs(p.value) / grid.max) : 0;
              const title = p ? `${dayLabel(day, { weekday: "short", month: "short", day: "numeric" })}: ${withUnit(p.value, unit)}${p.entries > 1 ? ` · ${p.entries} entries` : ""}` : `${dayLabel(day, { month: "short", day: "numeric" })}: nothing logged`;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={!p || !onSelect}
                  onClick={() => p && onSelect?.(day)}
                  title={title}
                  aria-label={title}
                  className="td-heat-cell aspect-square w-full disabled:cursor-default"
                  style={{
                    background: future ? "transparent" : p ? `linear-gradient(135deg, ${tone("var(--td-hs)", level)}, ${tone("var(--td-hs2)", level)})` : "hsl(var(--muted) / 0.7)",
                    outline: day === today ? `1.5px solid ${tone("var(--td-hs)")}` : undefined,
                    outlineOffset: 1,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        <span>Less</span>
        {[0.28, 0.5, 0.75, 1].map((l) => (
          <span key={l} className="h-2.5 w-2.5 rounded-[3px]" style={{ background: tone("var(--td-hs)", l) }} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
