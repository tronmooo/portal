// ── BubbleModal ──────────────────────────────────────────────────────────────
// The popup shell for the hub tabs, in the same language as the Executive tab:
// an icon medallion, a bold title with a count pill, a scrollable body of
// rounded rows, and an optional footer link out to the full surface.
//
// Shared rather than per-tab so a popup opened from Wellness and one opened
// from Finance are visibly the same object. Everything below is presentation —
// callers pass rows they've already derived, so a popup never fetches.

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { Medallion } from "@/components/dashboard/visuals";

export function BubbleModal({
  open, onClose, title, subtitle, icon, accent, count, children,
  headerRight, footer, footerLabel, footerHref, onFooter, width = "md", testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  /** HSL triple, e.g. "155 65% 45%". Tints the medallion, pill and rings. */
  accent: string;
  count?: number;
  children: React.ReactNode;
  /** Right of the title — a total, a filter, a count that isn't a plain number. */
  headerRight?: React.ReactNode;
  /** Arbitrary pinned footer — form actions. Wins over the footer link below. */
  footer?: React.ReactNode;
  footerLabel?: string;
  footerHref?: string;
  onFooter?: () => void;
  /** Wider panel for popups carrying a chart plus a table. */
  width?: "sm" | "md" | "lg";
  testId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className={`${width === "sm" ? "max-w-sm" : width === "lg" ? "max-w-lg" : "max-w-md"} max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden`}
        data-testid={testId}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 text-left space-y-0">
          <div className="flex items-center gap-3">
            <Medallion icon={icon} accent={accent} />
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex items-center gap-2 text-base font-bold tracking-tight">
                <span className="truncate">{title}</span>
                {typeof count === "number" && count > 0 && (
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums"
                    style={{ background: `hsl(${accent} / 0.16)`, color: `hsl(${accent})` }}
                  >
                    {count}
                  </span>
                )}
              </DialogTitle>
              {subtitle
                ? <DialogDescription className="text-[12px] mt-0.5">{subtitle}</DialogDescription>
                : <DialogDescription className="sr-only">{title}</DialogDescription>}
            </div>
            {headerRight && <div className="shrink-0 text-right pr-6">{headerRight}</div>}
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
          {children}
        </div>

        {footer ? (
          <div className="shrink-0 border-t border-border/60 px-4 py-3">{footer}</div>
        ) : (footerHref || onFooter) && (
          <div className="shrink-0 border-t border-border/60 px-4 py-3">
            {footerHref ? (
              <Link href={footerHref}>
                <span
                  onClick={onClose}
                  className="pressable inline-flex items-center gap-1.5 text-[13px] font-semibold"
                  style={{ color: `hsl(${accent})` }}
                  data-testid={`${testId}-footer`}
                >
                  {footerLabel || "View all"} <ArrowRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ) : (
              <button
                onClick={onFooter}
                className="pressable inline-flex items-center gap-1.5 text-[13px] font-semibold"
                style={{ color: `hsl(${accent})` }}
                data-testid={`${testId}-footer`}
              >
                {footerLabel || "View all"} <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A row inside a BubbleModal. Pressable only when it actually goes somewhere. */
export function BubbleRow({
  title, meta, accent, right, onClick, href, leading, testId,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  accent?: string;
  right?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  leading?: React.ReactNode;
  testId?: string;
}) {
  const interactive = !!onClick || !!href;
  const body = (
    <div
      className={`bubble-row flex items-center gap-3 px-3 py-2.5 ${interactive ? "pressable" : ""}`}
      style={accent ? { ["--accent-hsl" as any]: accent } : undefined}
      {...(interactive
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); }
            },
          }
        : {})}
      data-testid={testId}
    >
      {leading}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold leading-tight truncate">{title}</p>
        {meta && <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">{meta}</div>}
      </div>
      {right}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

/** Honest empty state inside a popup — never a blank panel. */
export function BubbleEmpty({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 px-4 py-8 text-center">
      <p className="text-[13px] font-semibold text-muted-foreground">{text}</p>
      {hint && <p className="text-[11px] text-muted-foreground/80 mt-1">{hint}</p>}
    </div>
  );
}

/**
 * The headline block at the top of a drill-down popup: the one number the popup
 * is about, a caption, and up to a few supporting stats.
 *
 * The finance popups each painted their own full-bleed gradient hero with its
 * own eyebrow, its own tracking and its own stat-chip markup — six headers, by
 * design ("no two of them share a header design"). The *charts* below them
 * genuinely differ, and should; the chrome around them should not. This is the
 * one hero, so a popup opened from Spend and one opened from Income are
 * recognisably the same object.
 */
export function PopupHero({ value, valueTone, caption, stats, accent }: {
  value: React.ReactNode;
  /** Full colour string for the number; defaults to the popup's accent. */
  valueTone?: string;
  caption?: React.ReactNode;
  stats?: Array<{ label: string; value: React.ReactNode }>;
  accent: string;
}) {
  return (
    <div className="pb-1">
      <div className="flex items-end justify-between gap-3">
        <p className="metric-value text-[30px] leading-none" style={{ color: valueTone ?? `hsl(${accent})` }}>
          {value}
        </p>
        {caption && (
          <div className="text-[11px] text-muted-foreground text-right leading-tight max-w-[45%]">
            {caption}
          </div>
        )}
      </div>
      {stats && stats.length > 0 && (
        <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 3)}, minmax(0, 1fr))` }}>
          {stats.map((s) => (
            <div key={s.label} className="bubble-row px-2.5 py-1.5">
              <p className="micro-label text-muted-foreground truncate">{s.label}</p>
              <p className="text-[13px] font-bold tabular-nums truncate">{s.value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default BubbleModal;
