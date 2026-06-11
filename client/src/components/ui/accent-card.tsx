// ─────────────────────────────────────────────────────────────────────────────
// AccentCard — the tinted-gradient card style used everywhere in Portol.me.
//
// Visual recipe (matches the Health "At a Glance" tracker cards):
//   - Subtle 135° gradient from the accent hue (~12% alpha) to card surface.
//   - Border in the same hue at ~30% alpha.
//   - Rounded `rounded-xl` corners.
//   - Hover: 1px lift + soft shadow.
//   - Slot props for an icon chip in the header and an optional footer row.
//
// This component is intentionally low-API: hand it an `hsl` accent + content
// and it composes correctly. Pages should NOT redefine this style inline.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export interface AccentCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** HSL accent in `H S% L%` form (no `hsl()` wrapper). */
  hsl: string;
  /** Optional small icon shown in a tinted chip. */
  icon?: LucideIcon;
  /** Card label (above the value). */
  label?: React.ReactNode;
  /** Optional right-aligned slot in the header (trend arrow, menu, etc.). */
  headerRight?: React.ReactNode;
  /** Optional dim footer row beneath children (e.g. "7d avg · 6d ago"). */
  footer?: React.ReactNode;
  /** Make the entire card a button (cursor + focus ring). */
  interactive?: boolean;
  /** Size: 'sm' for grid tiles, 'md' for list rows. */
  size?: "sm" | "md";
}

export const AccentCard = React.forwardRef<HTMLDivElement, AccentCardProps>(function AccentCard(
  { hsl, icon: Icon, label, headerRight, footer, interactive, size = "sm", className, children, ...rest },
  ref,
) {
  const color = `hsl(${hsl})`;
  return (
    <div
      ref={ref}
      className={cn(
        "relative rounded-xl border overflow-hidden flex flex-col transition-all",
        size === "sm" ? "p-3 gap-1.5" : "p-3.5 gap-2",
        interactive && "cursor-pointer hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
      style={{
        borderColor: `hsl(${hsl} / 0.30)`,
        background: `linear-gradient(135deg, hsl(${hsl} / 0.12) 0%, hsl(var(--card)) 75%)`,
        // @ts-expect-error custom CSS var for ring color on interactive cards
        "--tw-ring-color": `hsl(${hsl} / 0.55)`,
      }}
      {...rest}
    >
      {(Icon || label || headerRight) && (
        <div className="flex items-center gap-1.5">
          {Icon && (
            <span
              className="inline-flex w-5 h-5 items-center justify-center rounded-md shrink-0"
              style={{ background: `hsl(${hsl} / 0.22)`, color }}
            >
              <Icon className="h-3 w-3" />
            </span>
          )}
          {label && (
            <p className="text-xs font-semibold truncate flex-1" title={typeof label === "string" ? label : undefined}>
              {label}
            </p>
          )}
          {headerRight && <div className="shrink-0">{headerRight}</div>}
        </div>
      )}
      {children}
      {footer && (
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  );
});

// ── SectionHeader ─────────────────────────────────────────────────────────
// Small uppercase muted label with a tinted icon chip — the row that appears
// above every grid in the Health tab. Use the same component everywhere.

export interface SectionHeaderProps {
  hsl: string;
  icon: LucideIcon;
  label: string;
  count?: number;
  right?: React.ReactNode;
  className?: string;
}

export function SectionHeader({ hsl, icon: Icon, label, count, right, className }: SectionHeaderProps) {
  const color = `hsl(${hsl})`;
  return (
    <div className={cn("flex items-center gap-1.5 mb-2 px-0.5", className)}>
      <span
        className="inline-flex w-4 h-4 items-center justify-center rounded-md shrink-0"
        style={{ background: `hsl(${hsl} / 0.18)`, color }}
      >
        <Icon className="h-2.5 w-2.5" />
      </span>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {label}
        {count != null && (
          <span className="ml-1 text-[10px] font-medium text-muted-foreground/70 normal-case tracking-normal">
            ({count})
          </span>
        )}
      </p>
      {right && <div className="ml-auto shrink-0">{right}</div>}
    </div>
  );
}
