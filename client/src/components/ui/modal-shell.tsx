// ── ModalShell — the ONE popup shell for the whole app ───────────────────────
// Generalizes the well-behaved MetricPopupShell (HeroKPIPopups) so every dialog
// shares: one radius, one close-button placement/size (from ui/dialog), one
// bordered icon-chip header, a scrolling body that never clips on short/mobile
// viewports (max-h-[90dvh]), and one max-width scale. Popups pass content; they
// do NOT re-style the shell. Empty/loading/error states live in ModalState.
import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AlertTriangle, type LucideIcon } from "lucide-react";

export type ModalWidth = "xs" | "sm" | "md" | "lg";
const WIDTH: Record<ModalWidth, string> = {
  xs: "max-w-xs",
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
};

export interface ModalShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** Optional accent icon shown in a tinted chip beside the title. */
  icon?: LucideIcon;
  /** HSL accent `H S% L%` (no hsl() wrapper) or a full color string. */
  accent?: string;
  description?: React.ReactNode;
  /** Right-aligned header slot (e.g. a total, a filter). */
  headerRight?: React.ReactNode;
  /** Footer pinned below the scroll body (e.g. action buttons). */
  footer?: React.ReactNode;
  width?: ModalWidth;
  children: React.ReactNode;
  testId?: string;
  className?: string;
}

const toColor = (accent?: string) =>
  !accent ? "hsl(var(--primary))" : accent.startsWith("hsl") || accent.startsWith("#") || accent.startsWith("rgb")
    ? accent : `hsl(${accent})`;

export function ModalShell({
  open, onOpenChange, title, icon: Icon, accent, description, headerRight,
  footer, width = "md", children, testId, className,
}: ModalShellProps) {
  const color = toColor(accent);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(WIDTH[width], "p-0 gap-0 overflow-hidden flex flex-col max-h-[90dvh]", className)}
        data-testid={testId}
      >
        <DialogHeader className="px-4 pt-4 pb-3 border-b border-border shrink-0 space-y-0">
          <div className="flex items-start gap-3">
            {Icon && (
              <span className="rounded-lg p-2 shrink-0 inline-flex" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                <Icon className="h-4 w-4" style={{ color }} />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-sm">{title}</DialogTitle>
              {description && <DialogDescription className="text-[11px] mt-0.5">{description}</DialogDescription>}
            </div>
            {headerRight && <div className="shrink-0 text-right">{headerRight}</div>}
          </div>
        </DialogHeader>
        <div className="overflow-y-auto min-h-0 flex-1">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-border shrink-0">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}

// A titled block inside a popup body — consistent padding + a SectionHeader-style
// label + optional divider above. Use for the sections within a ModalShell.
export function PopupSection({
  title, right, divider = true, className, children,
}: {
  title?: React.ReactNode; right?: React.ReactNode; divider?: boolean;
  className?: string; children: React.ReactNode;
}) {
  return (
    <div className={cn("px-4 py-3", divider && "border-b border-border/60", className)}>
      {(title || right) && (
        <div className="flex items-center justify-between mb-2">
          {title && <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>}
          {right && <div className="shrink-0">{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// Shared empty / loading / error states for popup + card bodies, so all three
// look identical everywhere.
export function ModalState({
  state, icon, label, hint, ctaLabel, onCta, rows = 3,
}: {
  state: "loading" | "empty" | "error";
  icon?: LucideIcon; label?: string; hint?: string;
  ctaLabel?: string; onCta?: () => void; rows?: number;
}) {
  if (state === "loading") {
    return (
      <div className="p-4 space-y-2" data-testid="modal-loading">
        {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}
      </div>
    );
  }
  if (state === "error") {
    return (
      <EmptyState icon={AlertTriangle} label={label || "Something went wrong"}
        hint={hint || "Please try again."} ctaLabel={ctaLabel} onCta={onCta} />
    );
  }
  return <EmptyState icon={icon} label={label || "Nothing here yet"} hint={hint} ctaLabel={ctaLabel} onCta={onCta} />;
}
