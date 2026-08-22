// ── Executive dashboard visual primitives ────────────────────────────────────
// Small, dependency-free pieces that turn text into something readable at a
// glance: progress rings, counting numbers, mini bar charts, trend arrows,
// countdown pills, icon medallions.
//
// Deliberately hand-rolled SVG rather than recharts. recharts is already
// code-split away from the dashboard chunk (it lives in the lazy popup and
// finance chunks), and pulling it back in to draw a 44px ring would cost far
// more than these few hundred bytes.
//
// Motion is CSS transform/opacity only, so it stays on the compositor and the
// global `prefers-reduced-motion` rule in index.css already neutralises it.
// The one piece of JS motion — CountUp — checks the same preference itself.

import { useEffect, useRef, useState } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from "lucide-react";

/** True when the OS asks for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ── Icon medallion ───────────────────────────────────────────────────────────

export function Medallion({ icon: Icon, accent, size = "lg", className = "" }: {
  icon: LucideIcon; accent: string; size?: "lg" | "sm"; className?: string;
}) {
  return (
    <span
      className={`medallion ${size === "sm" ? "medallion-sm" : ""} ${className}`}
      style={{ ["--accent-hsl" as any]: accent }}
      aria-hidden="true"
    >
      <Icon className={size === "sm" ? "h-4 w-4" : "h-[22px] w-[22px]"} strokeWidth={2.1} />
    </span>
  );
}

// ── Counting number ──────────────────────────────────────────────────────────

/**
 * Animates from 0 to `value` on mount and between values thereafter.
 *
 * Uses requestAnimationFrame rather than a spring library, and bails straight
 * to the final value when the user has asked for reduced motion — an animated
 * count is exactly the kind of thing that rule exists for.
 */
export function CountUp({ value, className, style, duration = 650 }: {
  value: number; className?: string; style?: React.CSSProperties; duration?: number;
}) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") { setShown(value); return; }
    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) return;
    // Take the clock from the first frame rather than from performance.now():
    // the rAF timestamp is not guaranteed to share an origin with it, and when
    // they disagree the elapsed fraction goes negative and the number flies off
    // to nonsense before snapping back.
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.max(0, Math.min(1, (t - start) / duration));
      // easeOutCubic — fast then settling, which reads as "landing" on a number.
      const eased = 1 - Math.pow(1 - p, 3);
      const next = Math.round(from + delta * eased);
      setShown(next);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    // CONVERGENCE FLOOR. The rAF chain is the only thing that moves `shown`,
    // and it can die mid-flight — cancelled by a rapid value change during a
    // filter switch, or starved when the tab/webview throttles frames. The
    // Tasks summary cards then sat on the previous person's numbers beside a
    // correct list until a reload (QA run 002, B7). A timer snaps the counter
    // to its target if the animation hasn't landed by then.
    const settle = setTimeout(() => { setShown(value); fromRef.current = value; }, duration + 150);
    return () => {
      clearTimeout(settle);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration]);

  useEffect(() => { fromRef.current = shown; }, [shown]);

  return <span className={className} style={style}>{shown.toLocaleString()}</span>;
}

// ── Progress ring ────────────────────────────────────────────────────────────

export function ProgressRing({
  value, total, accent, size = 56, stroke = 5, label, sublabel, className = "",
}: {
  value: number; total: number; accent: string;
  size?: number; stroke?: number;
  /** Centre text. Defaults to `value/total`. */
  label?: string; sublabel?: string; className?: string;
}) {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" role="img"
        aria-label={`${value} of ${total} complete`}>
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke={`hsl(${accent} / 0.16)`}
        />
        <circle
          className="ring-progress"
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke}
          stroke={`hsl(${accent})`} strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ ["--ring-circumference" as any]: `${circumference}` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="metric-value text-[13px]" style={{ color: `hsl(${accent})` }}>
          {label ?? `${value}/${total}`}
        </span>
        {sublabel && <span className="text-[11px] text-muted-foreground mt-0.5">{sublabel}</span>}
      </div>
    </div>
  );
}

// ── Mini bar chart ───────────────────────────────────────────────────────────

export function MiniBars({ values, accent, height = 28, className = "" }: {
  values: number[]; accent: string; height?: number; className?: string;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className={`flex items-end gap-[3px] ${className}`} style={{ height }} aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className="bar-rise rounded-full"
          style={{
            ["--i" as any]: i,
            width: 5,
            height: `${Math.max(8, (v / max) * 100)}%`,
            background: `hsl(${accent} / ${v > 0 ? 0.85 : 0.2})`,
          }}
        />
      ))}
    </div>
  );
}

// ── Status / countdown pills ─────────────────────────────────────────────────

export type PillTone = "critical" | "warn" | "attention" | "good" | "info" | "ai" | "neutral";

const TONE_HSL: Record<PillTone, string> = {
  critical:  "0 72% 58%",
  warn:      "25 95% 58%",
  attention: "43 96% 53%",
  good:      "155 60% 45%",
  info:      "215 70% 58%",
  ai:        "280 75% 62%",
  neutral:   "240 5% 55%",
};

export function tonePalette(tone: PillTone): string {
  return TONE_HSL[tone];
}

/**
 * The colour system, in one place: red overdue · orange due soon · yellow needs
 * attention · green healthy · blue informational · purple AI.
 */
export function toneForDays(daysUntil: number | null | undefined): PillTone {
  if (daysUntil == null) return "info";
  if (daysUntil < 0) return "critical";
  if (daysUntil === 0) return "warn";
  if (daysUntil <= 7) return "attention";
  return "info";
}

export function Pill({ children, tone = "neutral", accent, className = "", pulse = false }: {
  children: React.ReactNode; tone?: PillTone;
  /** Raw HSL triple that overrides `tone` — for a pill that must match the
   *  colour of the card it sits in (a purple asset's "vehicle" chip). */
  accent?: string;
  className?: string; pulse?: boolean;
}) {
  const hsl = accent ?? TONE_HSL[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-semibold whitespace-nowrap ${pulse ? "pulse-attention" : ""} ${className}`}
      style={{
        ["--accent-hsl" as any]: hsl,
        background: `hsl(${hsl} / 0.14)`,
        color: `hsl(${hsl})`,
        border: `1px solid hsl(${hsl} / 0.28)`,
      }}
    >
      {children}
    </span>
  );
}

export function TrendArrow({ direction, tone = "neutral" }: {
  direction: "up" | "down" | "flat"; tone?: PillTone;
}) {
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  return <Icon className="h-3.5 w-3.5" style={{ color: `hsl(${TONE_HSL[tone]})` }} aria-hidden="true" />;
}
