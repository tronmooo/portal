// The building blocks of the liability profile's Overview, to the owner's
// design (2026-11-23): a titled panel, the label | value | pencil lines of the
// "Liability details" list and the Balance & Payoff line.
//
// Presentation only. Every value arrives already computed by the page from
// the one source it has always read (Rule 1): nothing here reads a field,
// fetches, or writes. A control that does something is handed its handler.

import * as React from "react";
import { ChevronRight, Pencil, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// ── A titled card ────────────────────────────────────────────────────────────

export function Panel({
  title, icon: Icon, actions, children, className, testId, accent,
}: {
  title: React.ReactNode;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  /** HSL triple that tints the card (the AI summary is violet). */
  accent?: string;
}) {
  return (
    <section className={cn("bubble p-4", className)} style={accent ? { ["--accent-hsl" as any]: accent } : undefined} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3 min-h-8">
        <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-tight">
          {Icon && <Icon className="h-[18px] w-[18px] text-violet-400" />} {title}
        </h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

// ── Liability details: one plain list, the Asset details list ────────────────
// Owner, 2026-11-23, with a picture of the asset's list: "make the liabilities
// look exactly like this". A line is the label on the left, the value on the
// right and a pencil; no icons, no boxed values.

/** One column on a phone; two on a wide screen, as the asset's list. */
export function FieldGrid({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div className="lg:grid lg:grid-cols-2 lg:gap-x-10" data-testid={testId}>{children}</div>;
}

export const LINE = "flex items-center gap-3 min-h-[40px] py-1.5 border-b border-border/30 min-w-0";

export function FieldRow({
  label, htmlFor, wide, children, alignTop,
}: {
  label: string;
  htmlFor?: string;
  /** Takes both columns on a wide screen. */
  wide?: boolean;
  alignTop?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(LINE, alignTop && "items-start", wide && "lg:col-span-2")}>
      <label htmlFor={htmlFor} className={cn("shrink-0 text-[13px] text-muted-foreground leading-tight", alignTop && "mt-1.5")}>{label}</label>
      <div className="flex-1 min-w-0 flex justify-end">{children}</div>
    </div>
  );
}

/**
 * A line's value: right-aligned, with the pencil that starts the edit. A fact
 * the record lacks reads "Not set" and is still a tap away from being added.
 * `opens` marks a line that goes somewhere else instead (a chevron).
 */
export function ReadValue({
  value, onClick, actionLabel, testId, opens,
}: {
  value?: React.ReactNode;
  onClick?: () => void;
  actionLabel?: string;
  testId?: string;
  opens?: boolean;
  /** Kept for callers; a long value is cut to its line, as the asset's. */
  multiline?: boolean;
}) {
  const empty = value === undefined || value === null || value === "";
  const text = (
    <span className={cn("min-w-0 truncate text-right text-[14px]", empty ? "text-muted-foreground/70" : "font-semibold tabular-nums")} data-testid={testId}>
      {empty ? "Not set" : value}
    </span>
  );
  if (!onClick) return <div className="flex min-w-0 items-center gap-3">{text}<span className="w-4 shrink-0" /></div>;
  return (
    <button type="button" onClick={onClick} aria-label={actionLabel} title={actionLabel} className="flex min-w-0 max-w-full items-center gap-3 text-left">
      {text}
      {opens ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" /> : <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />}
    </button>
  );
}

// ── Balance & Payoff: the balance falling to zero ────────────────────────────

/**
 * `balances` is the balance today followed by the balance after each
 * scheduled payment (the page's one amortization). Drawn as a line with a
 * handful of evenly spaced dots; no axis, the figures beside it carry the
 * numbers.
 */
export function PayoffLine({ balances, label }: { balances: number[]; label: string }) {
  const W = 320, H = 110, pad = 8;
  const id = React.useId();
  if (balances.length < 2) return null;
  const max = Math.max(1, ...balances);
  const pt = (i: number) => {
    const x = pad + (i / (balances.length - 1)) * (W - pad * 2);
    const y = pad + (1 - balances[i] / max) * (H - pad * 2);
    return [x, y] as const;
  };
  const line = balances.map((_, i) => { const [x, y] = pt(i); return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(" ");
  const dots = Array.from(new Set(Array.from({ length: 6 }, (_, k) => Math.round((k / 5) * (balances.length - 1)))));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={label} data-testid="payoff-line">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(270 85% 65%)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="hsl(270 85% 65%)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${(W - pad).toFixed(1)} ${H - pad} L${pad} ${H - pad} Z`} fill={`url(#${id})`} />
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} className="stroke-foreground/15" strokeWidth="1" />
      <path d={line} fill="none" stroke="hsl(270 85% 68%)" strokeWidth="2" strokeLinejoin="round" />
      {dots.map((i) => { const [x, y] = pt(i); return <circle key={i} cx={x} cy={y} r="3" fill="hsl(270 85% 78%)" />; })}
    </svg>
  );
}

export function FigureRow({ label, value, tone, testId }: { label: string; value: React.ReactNode; tone?: "danger" | "good"; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className={cn("text-[14px] font-semibold tabular-nums", tone === "danger" && "text-red-500", tone === "good" && "text-emerald-400")} data-testid={testId}>{value}</span>
    </div>
  );
}
