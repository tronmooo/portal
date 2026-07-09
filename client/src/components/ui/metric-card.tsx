// ── MetricCard — the ONE stat tile ───────────────────────────────────────────
// Replaces the 9 hand-rolled stat tiles (MiniStat, KpiTile×2, StatTile, KpiCard,
// wellness KpiTile, StatChip, StatCard, Stat). Built on AccentCard so it shares
// the tinted-gradient look, hover lift, and icon chip. Label is the sans
// SectionHeader convention (no mono); the value uses .metric-value (tabular).
import * as React from "react";
import { AccentCard } from "@/components/ui/accent-card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export interface MetricCardProps {
  label: string;
  value: React.ReactNode;
  /** HSL accent `H S% L%` (no hsl() wrapper). */
  hsl: string;
  icon?: LucideIcon;
  /** Small caption under the value (e.g. "7d avg", "2 late"). */
  sub?: React.ReactNode;
  /** Trend text tinted by tone. */
  trend?: React.ReactNode;
  trendTone?: "pos" | "neg" | "warn" | "neutral";
  /** Right-of-value slot (sparkline, ring). */
  chart?: React.ReactNode;
  onClick?: () => void;
  testId?: string;
  className?: string;
}

const TONE: Record<NonNullable<MetricCardProps["trendTone"]>, string> = {
  pos: "text-emerald-500",
  neg: "text-red-500",
  warn: "text-amber-500",
  neutral: "text-muted-foreground",
};

export function MetricCard({
  label, value, hsl, icon, sub, trend, trendTone = "neutral", chart, onClick, testId, className,
}: MetricCardProps) {
  return (
    <AccentCard
      hsl={hsl}
      icon={icon}
      label={label}
      interactive={!!onClick}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      data-testid={testId}
      className={cn("min-w-[7.5rem]", className)}
    >
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="metric-value text-xl leading-none truncate" style={{ color: `hsl(${hsl})` }}>{value}</div>
          {trend && <div className={cn("text-[10px] mt-1", TONE[trendTone])}>{trend}</div>}
          {sub && <div className="text-[10px] text-muted-foreground mt-1 truncate">{sub}</div>}
        </div>
        {chart && <div className="shrink-0">{chart}</div>}
      </div>
    </AccentCard>
  );
}
