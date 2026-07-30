// ── EntityCard ───────────────────────────────────────────────────────────────
// The one grid-card shape for a record you can open: an asset, a liability, a
// document, a tracker.
//
// Why this exists: Assets, Liabilities and Documents each grew their own
// version of the same card — a 20px rounded-square icon chip, a 10px bold
// title, a stack of 9px label/value rows, and a fixed height that left a third
// of the box empty. Three near-identical recipes, none of them matching the
// Executive tab, which is exactly why the tabs read as separate products.
//
// This is the Executive tab's language, packaged:
//   • Medallion — the icon on a tinted circle, not a tiny square chip.
//   • One title treatment (13px bold, sentence case — no ALL-CAPS variants).
//   • One headline number (.metric-value) with a muted unit beside it.
//   • Meta rows on .micro-label, so labels match the rest of the app.
//   • A footer that is *pinned to the bottom and always carries something* —
//     status pill, countdown, progress. The dead space at the bottom of every
//     card was the single most visible difference from the Executive tab.
//
// Presentation only: it fetches nothing, owns no state, and every action is a
// prop. The card is pressable only when the caller gives it somewhere to go.

import * as React from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Medallion } from "@/components/dashboard/visuals";

export interface EntityMeta {
  label: string;
  value: React.ReactNode;
}

export interface EntityCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** HSL triple, e.g. "262 60% 62%" — tints the medallion, border and wash. */
  accent: string;
  icon: LucideIcon;
  title: string;
  /** Headline number/text. Omit to show `emptyValue` instead. */
  value?: React.ReactNode;
  /** Small muted unit next to the headline ("bal", "/mo", "purchase"). */
  valueUnit?: string;
  /** Shown in place of the headline when there is no value yet. */
  emptyValue?: string;
  /** Label/value rows under the headline. */
  meta?: EntityMeta[];
  /** Bottom-left slot — status pills, countdowns. */
  pills?: React.ReactNode;
  /** Bottom-right slot — row actions (share, delete, edit). */
  actions?: React.ReactNode;
  /** 0–1. Renders a progress bar above the footer with its caption. */
  progress?: { value: number; left?: React.ReactNode; right?: React.ReactNode };
  /** Adds the press affordances. Leave off for a purely decorative container. */
  interactive?: boolean;
  /** Same spelling as every other kit primitive. Without it, `testId` fell
   *  through to the DOM as an invalid lowercase `testid` attribute and every
   *  selector written against it missed. */
  testId?: string;
}

export const EntityCard = React.forwardRef<HTMLDivElement, EntityCardProps>(function EntityCard(
  {
    accent, icon, title, value, valueUnit, emptyValue, meta = [],
    pills, actions, progress, interactive, testId, className, children, ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        // The surface comes from .bubble via --accent-hsl. Never paint the
        // gradient/border/shadow inline here: inline style beats the stylesheet,
        // which is how these cards stayed flat through a whole redesign.
        "bubble h-full flex flex-col overflow-hidden p-3",
        interactive && "bubble-interactive pressable cursor-pointer",
        className,
      )}
      style={{ ["--accent-hsl" as any]: accent, ...(rest.style || {}) }}
      data-testid={testId ?? (rest as any)["data-testid"]}
      {...rest}
    >
      <div className="flex items-start gap-2">
        <Medallion icon={icon} accent={accent} size="sm" />
        <p
          className="flex-1 min-w-0 text-[13px] font-bold leading-tight tracking-tight line-clamp-2 text-foreground"
          title={title}
        >
          {title}
        </p>
      </div>

      {/* The headline stays on ONE line. A wrapping headline ("Drivers
          License" at 21px) pushed the meta rows through the bottom of the
          card, which is why this is clamped rather than left to flow.
          Omit both `value` and `emptyValue` and the row disappears — a record
          with no number worth shouting (a document) shouldn't shout its type
          back at you when the title above already said it. */}
      {(value != null || emptyValue != null) && (
      <div className="mt-2 flex items-baseline gap-1.5 min-w-0">
        {value != null ? (
          <>
            <span className="metric-value text-[21px] leading-none text-foreground truncate min-w-0">{value}</span>
            {valueUnit && <span className="text-[11px] text-muted-foreground shrink-0">{valueUnit}</span>}
          </>
        ) : (
          <span className="text-[12px] text-muted-foreground/70 italic leading-none truncate">
            {emptyValue}
          </span>
        )}
      </div>
      )}

      {/* Body grows so the footer stays pinned to the bottom edge. */}
      <div className="mt-2 flex-1 min-h-0 overflow-hidden space-y-1">
        {meta.map((m) => (
          <div key={m.label} className="flex items-baseline justify-between gap-2">
            <span className="micro-label text-[10px] text-muted-foreground shrink-0">{m.label}</span>
            <span className="text-[11px] font-medium text-foreground text-right truncate min-w-0">
              {m.value}
            </span>
          </div>
        ))}
        {children}
      </div>

      {progress && (
        <div className="mt-2">
          <div
            className="h-1.5 w-full rounded-full overflow-hidden"
            style={{ background: `hsl(${accent} / 0.14)` }}
            role="progressbar"
            aria-valuenow={Math.round(progress.value * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.round(Math.max(0, Math.min(1, progress.value)) * 100)}%`, background: `hsl(${accent})` }}
            />
          </div>
          {(progress.left || progress.right) && (
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
              <span>{progress.left}</span>
              <span>{progress.right}</span>
            </div>
          )}
        </div>
      )}

      {(pills || actions) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 min-w-0 flex-wrap">{pills}</div>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>
      )}
    </div>
  );
});

export default EntityCard;
