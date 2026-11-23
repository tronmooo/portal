// The building blocks of the liability profile's Overview, to the owner's
// design (2026-11-23): a titled panel, the label | control rows of the
// "Liability Details" form, the Quick Info rows and the Balance & Payoff line.
//
// Presentation only. Every value arrives already computed by the page from
// the one source it has always read (Rule 1): nothing here reads a field,
// fetches, or writes. A control that does something is handed its handler.

import * as React from "react";
import { Pencil, Plus, type LucideIcon } from "lucide-react";
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

// ── Liability Details: one label | control row ───────────────────────────────

/** The rows sit in a two-column grid from `sm`; a `wide` row takes both. */
export function FieldGrid({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5" data-testid={testId}>{children}</div>;
}

export function FieldRow({
  icon: Icon, label, htmlFor, wide, children, alignTop,
}: {
  icon: LucideIcon;
  label: string;
  htmlFor?: string;
  wide?: boolean;
  alignTop?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-2.5 min-w-0", alignTop ? "items-start" : "items-center", wide && "sm:col-span-2")}>
      <Icon className={cn("h-[18px] w-[18px] shrink-0 text-muted-foreground", alignTop && "mt-2")} strokeWidth={1.8} />
      <label htmlFor={htmlFor} className={cn("w-[104px] shrink-0 text-[13px] text-muted-foreground leading-tight", alignTop && "mt-2")}>{label}</label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

/**
 * A value drawn as the field it becomes: tapping it starts editing. A fact the
 * record lacks reads "+ Add" (owner, 2026-11-22: nothing is a blank).
 */
export function ReadValue({
  value, onClick, actionLabel, testId, multiline,
}: {
  value?: React.ReactNode;
  onClick?: () => void;
  actionLabel?: string;
  testId?: string;
  multiline?: boolean;
}) {
  const empty = value === undefined || value === null || value === "";
  const cls = cn(
    "flex w-full items-center rounded-lg border border-foreground/15 bg-foreground/[0.03] px-3 text-left text-[14px] min-h-9",
    multiline ? "py-2 whitespace-pre-wrap break-words" : "truncate",
  );
  const body = empty
    ? <span className="flex items-center gap-1 font-semibold text-cyan-400"><Plus className="h-3.5 w-3.5" /> Add</span>
    : <span className={cn("font-medium", !multiline && "truncate")}>{value}</span>;
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={actionLabel} title={actionLabel} className={cn(cls, "pressable hover:border-foreground/30 transition-colors")} data-testid={testId}>{body}</button>
  ) : (
    <div className={cls} data-testid={testId}>{body}</div>
  );
}

// ── Quick Info / Characteristics: label | value | pencil ─────────────────────

export function InfoRow({
  icon: Icon, label, value, onEdit, editLabel, testId, tone,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  onEdit?: () => void;
  editLabel?: string;
  testId?: string;
  tone?: "danger" | "good";
}) {
  return (
    <div className="flex items-center gap-2.5 py-2 min-w-0" data-testid={testId}>
      <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} />
      <span className="w-[42%] shrink-0 text-[13px] text-muted-foreground leading-tight">{label}</span>
      <span className={cn("flex-1 min-w-0 text-[14px] font-medium break-words tabular-nums", tone === "danger" && "text-red-500", tone === "good" && "text-emerald-400")}>{value}</span>
      {onEdit && (
        <button type="button" onClick={onEdit} aria-label={editLabel} title={editLabel}
          className="pressable grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function InfoList({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div className="divide-y divide-foreground/10" data-testid={testId}>{children}</div>;
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
