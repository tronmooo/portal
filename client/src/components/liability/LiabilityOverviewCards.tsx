// The cards of the liability profile's Overview, to the owner's design
// (2026-11-22): the balance card, the "Liability details" rows, the payoff
// ring, the Upcoming / Documents / Alerts / Calendar cards and the Profile
// actions list.
//
// Presentation only. Every number arrives already computed by the page from
// the one source it has always read (Rule 1): nothing here reads a field,
// fetches, or writes. A control that does something is handed its handler.

import * as React from "react";
import { ChevronRight, Info, Layers, Plus, RefreshCw, type LucideIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const GRADIENT = "linear-gradient(90deg, hsl(262 83% 66%) 0%, hsl(187 85% 53%) 100%)";

// ── Balance card ─────────────────────────────────────────────────────────────

export interface BalanceStat {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  /** A due date that needs attention: red (overdue) or amber (today). */
  tone?: "danger" | "warn";
  testId?: string;
  /** Opens the editor of this fact. */
  onClick?: () => void;
  actionLabel?: string;
}

export interface BalanceProgress {
  /** "Payoff progress", "Utilization", "Term progress". */
  title: string;
  /** 0..100. */
  pct: number;
  /** "34.2%" */
  pctLabel: string;
  /** "paid down", "used". */
  pctCaption: string;
  left: string;
  right: string;
  hint?: string;
  testId?: string;
}

export function BalanceCard({
  label, value, valueTestId, caption, progress, stats, autopay, testId = "liability-hero", onValueClick, valueActionLabel,
}: {
  /** Opens the editor of the headline figure. */
  onValueClick?: () => void;
  valueActionLabel?: string;
  label: string;
  value: React.ReactNode;
  valueTestId?: string;
  caption?: React.ReactNode;
  progress?: BalanceProgress | null;
  stats: BalanceStat[];
  autopay?: { on: boolean; busy?: boolean; onChange: (on: boolean) => void; note: string } | null;
  testId?: string;
}) {
  return (
    <section className="bubble p-4 sm:p-5" data-testid={testId}>
      <div className="grid gap-4 sm:grid-cols-2 sm:gap-6">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            <Layers className="h-4 w-4 text-cyan-400" /> {label}
          </p>
          {onValueClick ? (
            <button type="button" onClick={onValueClick} aria-label={valueActionLabel} title={valueActionLabel}
              className="pressable mt-1 block text-left text-[38px] font-bold leading-none tracking-tight tabular-nums" data-testid={valueTestId}>{value}</button>
          ) : (
            <p className="mt-1 text-[38px] font-bold leading-none tracking-tight tabular-nums" data-testid={valueTestId}>{value}</p>
          )}
          {caption && <p className="mt-1.5 text-[14px] text-muted-foreground">{caption}</p>}
        </div>

        {progress && (
          <div className="min-w-0" data-testid={progress.testId}>
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground" title={progress.hint}>
              {progress.title} {progress.hint && <Info className="h-3.5 w-3.5" aria-hidden />}
            </p>
            <p className="mt-0.5">
              <span className="text-[20px] font-bold tabular-nums">{progress.pctLabel}</span>{" "}
              <span className="text-[14px] text-muted-foreground">{progress.pctCaption}</span>
            </p>
            <div
              className="mt-2 h-2.5 rounded-full bg-foreground/10 overflow-hidden"
              role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.pct)}
              aria-label={`${progress.title}: ${progress.pctLabel} ${progress.pctCaption}`}
            >
              <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, progress.pct))}%`, background: GRADIENT }} />
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground tabular-nums">
              {progress.left} <span aria-hidden>•</span> {progress.right}
            </p>
          </div>
        )}
      </div>

      {stats.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-4 sm:divide-x sm:divide-foreground/10">
          {stats.map((s, i) => {
            const inner = (
              <>
                <s.icon className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
                <span className="min-w-0 block text-left">
                  <span className="block text-[12px] text-muted-foreground leading-tight">{s.label}</span>
                  <span
                    className={cn(
                      "block text-[15px] font-semibold leading-snug break-words tabular-nums",
                      s.tone === "danger" && "text-red-500", s.tone === "warn" && "text-amber-500",
                    )}
                    data-testid={s.testId}
                  >{s.value}</span>
                  {s.sub && <span className="block text-[11px] text-muted-foreground leading-tight">{s.sub}</span>}
                </span>
              </>
            );
            const cls = cn("flex items-start gap-2.5 min-w-0", i > 0 && "sm:pl-3");
            return s.onClick ? (
              <button key={s.label} type="button" onClick={s.onClick} aria-label={s.actionLabel} title={s.actionLabel} className={cn(cls, "pressable")}>{inner}</button>
            ) : (
              <div key={s.label} className={cls}>{inner}</div>
            );
          })}
        </div>
      )}

      {autopay && (
        <div className="mt-4 flex items-center gap-3 border-t border-foreground/10 pt-3.5">
          <RefreshCw className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold" data-testid="hero-autopay-state">Autopay: {autopay.on ? "On" : "Off"}</p>
            <p className="text-[12px] text-muted-foreground leading-snug">{autopay.note}</p>
          </div>
          <Switch
            checked={autopay.on}
            disabled={autopay.busy}
            onCheckedChange={autopay.onChange}
            aria-label="Autopay"
            className="data-[state=checked]:bg-cyan-400"
            data-testid="switch-autopay-hero"
          />
        </div>
      )}
    </section>
  );
}

// ── Section heading ──────────────────────────────────────────────────────────

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1 mb-2 min-h-8">
      <h2 className="text-[16px] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

// ── "Liability details" rows ─────────────────────────────────────────────────

export interface DetailRow {
  key: string;
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  /** The record has no value here. With `onClick` the row reads "Add". */
  empty?: boolean;
  /** Takes the whole row (Notes). */
  wide?: boolean;
  onClick?: () => void;
  /** What a tap does, for a screen reader ("Edit lender"). */
  actionLabel?: string;
  testId?: string;
}

export function DetailRowGrid({ rows, testId = "liability-detail-rows" }: { rows: DetailRow[]; testId?: string }) {
  // Two columns with no hole: when the half-width rows come to an odd number,
  // the last of them takes the full line instead of sitting beside a blank.
  const halves = rows.filter((r) => !r.wide);
  const stretch = halves.length % 2 === 1 ? halves[halves.length - 1].key : null;
  return (
    <div className="grid grid-cols-2 gap-2" data-testid={testId}>
      {rows.map((r) => {
        const addable = !!r.empty && !!r.onClick;
        const body = (
          <>
            <r.icon className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <span className="flex-1 min-w-0 text-left">
              <span className="block text-[12px] text-muted-foreground leading-tight">{r.label}</span>
              {addable ? (
                <span className="flex items-center gap-1 text-[14px] font-semibold leading-snug text-cyan-400">
                  <Plus className="h-3.5 w-3.5" /> Add
                </span>
              ) : (
                <span className={cn("block text-[14px] font-semibold leading-snug line-clamp-2 break-words", r.empty && "font-normal text-muted-foreground")}>{r.value}</span>
              )}
            </span>
            {r.onClick && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </>
        );
        const cls = cn("bubble !rounded-2xl flex items-center gap-3 px-3.5 py-2.5 min-h-[56px] min-w-0", (r.wide || r.key === stretch) && "col-span-2");
        return r.onClick ? (
          <button key={r.key} type="button" onClick={r.onClick} className={cn(cls, "bubble-interactive pressable")}
            aria-label={r.actionLabel} data-testid={r.testId || `detail-row-${r.key}`}>
            {body}
          </button>
        ) : (
          <div key={r.key} className={cls} data-testid={r.testId || `detail-row-${r.key}`}>{body}</div>
        );
      })}
    </div>
  );
}

// ── Payoff overview (ring) ───────────────────────────────────────────────────

export function ProgressRing({ pct, label, caption }: { pct: number; label: string; caption: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const shown = Math.max(0, Math.min(100, pct));
  const id = React.useId();
  return (
    <div className="relative h-[112px] w-[112px] shrink-0" role="img" aria-label={`${label} ${caption}`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(187 85% 53%)" />
            <stop offset="100%" stopColor="hsl(262 83% 66%)" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="11" className="stroke-foreground/10" />
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="11" strokeLinecap="round"
          stroke={`url(#${id})`} strokeDasharray={`${(shown / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="text-[17px] font-bold leading-none tabular-nums">{label}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-none">{caption}</p>
        </div>
      </div>
    </div>
  );
}

export function PayoffOverviewCard({
  title, subtitle, figures, pct, pctLabel, pctCaption, testId = "payoff-overview",
}: {
  title: string;
  subtitle: string;
  figures: Array<{ label: string; value: string; dot: string }>;
  pct: number;
  pctLabel: string;
  pctCaption: string;
  testId?: string;
}) {
  return (
    <section className="bubble p-4 sm:p-5 flex items-center gap-4" data-testid={testId}>
      <div className="flex-1 min-w-0">
        <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{subtitle}</p>
        {/* A phone has no room for three figures beside the ring: they stack
            as label · value rows there and sit side by side from 560px. */}
        <dl className="mt-3 grid grid-cols-1 gap-1.5 min-[560px]:grid-cols-3 min-[560px]:gap-3">
          {figures.map((f) => (
            <div key={f.label} className="min-w-0 flex items-baseline justify-between gap-2 min-[560px]:block">
              <dt className="flex items-center gap-1.5 text-[12px] text-muted-foreground whitespace-nowrap">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: f.dot }} aria-hidden /> {f.label}
              </dt>
              <dd className="text-[16px] font-bold tabular-nums min-[560px]:pl-3.5 min-[560px]:text-[18px]">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <ProgressRing pct={pct} label={pctLabel} caption={pctCaption} />
    </section>
  );
}

// ── Autopay chip ─────────────────────────────────────────────────────────────

export function AutopayChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2.5 py-1 text-[12px] font-semibold text-emerald-400 whitespace-nowrap">
      <RefreshCw className="h-3.5 w-3.5" /> Autopay on
    </span>
  );
}

// ── A card that is one tappable row (Upcoming payments) ──────────────────────

export function RowCard({
  icon: Icon, title, children, trailing, onClick, actionLabel, testId,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  onClick: () => void;
  actionLabel: string;
  testId?: string;
}) {
  return (
    <button type="button" onClick={onClick} aria-label={actionLabel}
      className="bubble bubble-interactive pressable w-full p-4 flex items-center gap-3 text-left" data-testid={testId}>
      <Icon className="h-5 w-5 shrink-0 self-start mt-0.5 text-muted-foreground" strokeWidth={1.8} />
      <span className="flex-1 min-w-0">
        <span className="block text-[16px] font-semibold tracking-tight">{title}</span>
        {children}
        {/* On a phone the chip sits under the text instead of squeezing it. */}
        {trailing && <span className="mt-1.5 block sm:hidden">{trailing}</span>}
      </span>
      {trailing && <span className="hidden sm:block shrink-0">{trailing}</span>}
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

// ── A small card with one button (Documents, Alerts) ─────────────────────────

export function MiniCard({
  icon: Icon, title, headline, detail, action, testId,
}: {
  icon: LucideIcon;
  title: string;
  headline: React.ReactNode;
  detail?: React.ReactNode;
  action: React.ReactNode;
  testId?: string;
}) {
  return (
    <section className="bubble p-4 flex flex-col gap-2 min-w-0" data-testid={testId}>
      <div className="flex items-start gap-2.5">
        <Icon className="h-5 w-5 shrink-0 mt-0.5 text-muted-foreground" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-semibold tracking-tight leading-tight">{title}</h2>
          <p className="text-[13px] font-medium mt-0.5">{headline}</p>
          {detail && <p className="text-[12px] text-muted-foreground leading-snug mt-0.5 line-clamp-2">{detail}</p>}
        </div>
      </div>
      <div className="mt-auto pl-[30px]">{action}</div>
    </section>
  );
}

// ── Calendar & reminders row ─────────────────────────────────────────────────

export function DateTile({ month, day }: { month: string; day: string }) {
  return (
    <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-xl border border-foreground/20 text-center" aria-hidden>
      <span>
        <span className="micro-label block text-muted-foreground leading-none">{month}</span>
        <span className="block text-[20px] font-bold leading-tight tabular-nums">{day}</span>
      </span>
    </span>
  );
}

// ── Profile actions ──────────────────────────────────────────────────────────

export interface ProfileAction {
  key: string;
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
  destructive?: boolean;
  testId?: string;
}

export function ProfileActionsList({ actions, testId = "profile-actions" }: { actions: ProfileAction[]; testId?: string }) {
  return (
    <div className="bubble divide-y divide-foreground/10 overflow-hidden" data-testid={testId}>
      {actions.map((a) => (
        <button key={a.key} type="button" onClick={a.onClick}
          className="pressable flex w-full items-center gap-3.5 px-4 py-3 text-left hover:bg-foreground/5 transition-colors"
          data-testid={a.testId || `profile-action-${a.key}`}>
          <a.icon className={cn("h-5 w-5 shrink-0", a.destructive ? "text-red-500" : "text-muted-foreground")} strokeWidth={1.8} />
          <span className="flex-1 min-w-0">
            <span className={cn("block text-[14px] font-semibold leading-tight", a.destructive && "text-red-500")}>{a.label}</span>
            <span className="block text-[12px] text-muted-foreground leading-snug">{a.hint}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
