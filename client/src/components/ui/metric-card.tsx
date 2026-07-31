// ── MetricCard — the ONE stat tile ───────────────────────────────────────────
// A number you can look at and act on: net worth, sleep hours, spend MTD, a
// tracker's latest reading.
//
// This file existed before and was used by nothing. It was built on the old
// accent-card component, which hand-rolled its own smaller-radius,
// flatter-shadow version of the card surface — so adopting it would have spread
// a *second* look rather than the Executive tab's. That component is now
// deleted. This is built on the real primitives: `.bubble` for the
// surface, `Medallion` for the icon, `.micro-label` for the label,
// `.metric-value` for the number.
//
// Three tiles across the app collapse into this one: the hub's StatChip, the
// wellness KpiTile, and the finance KpiCard.
//
// Presentation only — no fetching, no state. Interactive strictly on request:
// a tile that lifts under the cursor and opens nothing is worse than a flat one.

import * as React from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { CountUp, Medallion } from "@/components/dashboard/visuals";

export interface MetricCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onClick"> {
  label: React.ReactNode;
  /** The number/text. Pass `countTo` instead to animate up to a number. */
  value?: React.ReactNode;
  /** Animates 0 → n on mount. Respects prefers-reduced-motion (see CountUp). */
  countTo?: number;
  /** Prefix glued to an animated value, e.g. "$" or "+". */
  valuePrefix?: string;
  /** Small muted unit beside the number ("oz", "bpm", "/ 2300 kcal"). */
  unit?: React.ReactNode;
  /** HSL triple `H S% L%`, no hsl() wrapper. Tints medallion, border and wash. */
  accent: string;
  icon?: LucideIcon;
  /** Right of the label — a trend arrow, a menu. */
  headerRight?: React.ReactNode;
  /** Under the number — "last night", "income − spend". */
  sub?: React.ReactNode;
  /** Tinted trend line — "▲ 2.4% mo". */
  trend?: React.ReactNode;
  trendTone?: "pos" | "neg" | "warn" | "neutral";
  /** Beside the number — a ring or gauge. */
  aside?: React.ReactNode;
  /** Full width under the number — a sparkline or bar chart. */
  chart?: React.ReactNode;
  /** 0–1 bar with a caption, for tiles with no series to plot. */
  progress?: { value: number; caption?: React.ReactNode };
  /** Dim row pinned at the bottom — "7d avg 182 · 2d ago". */
  footer?: React.ReactNode;
  /**
   * "dense" lays the medallion beside a stacked label+value in ~44px, for the
   * hub strip that sits above every screen. The default two-row layout is a
   * 26px number and belongs in a grid — used in the strip it pushed the actual
   * page content off the top of the phone.
   */
  density?: "default" | "dense";
  onClick?: () => void;
  testId?: string;
}

const TREND_TONE: Record<NonNullable<MetricCardProps["trendTone"]>, string> = {
  pos: "text-emerald-500",
  neg: "text-red-500",
  warn: "text-amber-500",
  neutral: "text-muted-foreground",
};

export function MetricCard({
  label, value, countTo, valuePrefix, unit, accent, icon, headerRight,
  sub, trend, trendTone = "neutral", aside, chart, progress, footer,
  density = "default", onClick, testId, className, style, ...rest
}: MetricCardProps) {
  const color = `hsl(${accent})`;

  if (density === "dense") {
    return (
      <div
        className={cn(
          "bubble px-2.5 py-1.5 flex items-center gap-2",
          onClick && "bubble-interactive pressable cursor-pointer",
          className,
        )}
        style={{ ["--accent-hsl" as any]: accent, ...style }}
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={onClick ? (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
        } : undefined}
        data-testid={testId}
        {...rest}
      >
        {icon && <Medallion icon={icon} accent={accent} size="sm" />}
        <span className="min-w-0">
          <span className="micro-label text-muted-foreground block leading-none whitespace-nowrap">
            {label}
          </span>
          <span className="metric-value text-[17px] leading-none block mt-1 whitespace-nowrap" style={{ color }}>
            {countTo != null ? <>{valuePrefix}<CountUp value={countTo} /></> : value}
            {unit && <span className="text-[11px] text-muted-foreground ml-1 font-normal">{unit}</span>}
          </span>
        </span>
        {headerRight && <span className="shrink-0 self-start">{headerRight}</span>}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "bubble p-3 flex flex-col min-w-[8.5rem]",
        onClick && "bubble-interactive pressable cursor-pointer",
        className,
      )}
      style={{ ["--accent-hsl" as any]: accent, ...style }}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
      } : undefined}
      data-testid={testId}
      {...rest}
    >
      <div className="flex items-center gap-2">
        {icon && <Medallion icon={icon} accent={accent} size="sm" />}
        <span className="micro-label text-muted-foreground leading-tight flex-1 min-w-0 truncate">
          {label}
        </span>
        {headerRight && <span className="shrink-0">{headerRight}</span>}
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="metric-value text-[26px] leading-none truncate" style={{ color }}>
            {countTo != null
              ? <>{valuePrefix}<CountUp value={countTo} /></>
              : value}
            {unit && <span className="text-[11px] text-muted-foreground ml-1 font-normal">{unit}</span>}
          </div>
          {trend && <div className={cn("text-[11px] font-semibold mt-1", TREND_TONE[trendTone])}>{trend}</div>}
          {sub && <div className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</div>}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>

      {chart && <div className="mt-2">{chart}</div>}

      {progress && (
        <div className="mt-2.5">
          <div
            className="h-1.5 w-full rounded-full overflow-hidden"
            style={{ background: `hsl(${accent} / 0.16)` }}
            role="progressbar"
            aria-valuenow={Math.round(progress.value * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.round(Math.max(0, Math.min(1, progress.value)) * 100)}%`, background: color }}
            />
          </div>
          {progress.caption && (
            <div className="text-[11px] text-muted-foreground mt-1">{progress.caption}</div>
          )}
        </div>
      )}

      {footer && (
        <div className="mt-auto pt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

export default MetricCard;
