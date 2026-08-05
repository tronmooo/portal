// ── DetailHero — the header on every profile detail page ─────────────────────
//
// What this replaces: two hand-rolled headers (profile-detail.tsx and
// liability-detail.tsx) that each drew a full-bleed saturated gradient band —
// olive-green for an asset, red-orange for a liability. Nothing else in the app
// has one, so opening a profile felt like leaving the app. The stat tiles inside
// were white-on-gradient and washed out, and the liability header carried TWO
// tile shapes at once (label-under-value for Payments/Status, icon-label-over-
// value for the KPI row).
//
// What's here instead: the `.bubble` surface every other card uses, tinted with
// the profile type's accent — the same accent the Linked grid painted the card
// you tapped. Colour identity survives; the band doesn't.
//
// Presentation only. Avatar upload, edit, delete and pay all stay with the
// caller; this component just gives them somewhere consistent to sit.

import * as React from "react";
import { Camera, RefreshCw, ArrowLeft, type LucideIcon } from "lucide-react";
import { Link } from "wouter";
import { Medallion, Pill } from "@/components/dashboard/visuals";
import { MetricCard } from "@/components/ui/metric-card";
import { cn } from "@/lib/utils";

export interface HeroStat {
  label: string;
  /** The text to show. Pass `countTo` instead for a number that animates up. */
  value?: React.ReactNode;
  /** Animate 0 → n. Pass instead of `value` for counts. */
  countTo?: number;
  sub?: React.ReactNode;
  icon?: LucideIcon;
  /** Overrides the hero accent for this tile — a red "overdue" among neutrals. */
  accent?: string;
  onClick?: () => void;
  testId?: string;
}

export interface DetailHeroProps {
  title: React.ReactNode;
  /** HSL triple `H S% L%` — see lib/profile-visuals.ts. */
  accent: string;
  icon: LucideIcon;
  /** "Asset", "Liability" — the type chip under the title. */
  typeLabel?: string;
  /** Extra chips beside the type: a subtype, tags. */
  badges?: React.ReactNode;
  /** One line under the title — a lender, a make/model. */
  subtitle?: React.ReactNode;
  /** The ancestry trail, when this profile sits under a parent. */
  breadcrumb?: React.ReactNode;
  notes?: string | null;
  avatar?: {
    src?: string | null;
    onPick: () => void;
    busy?: boolean;
    inputRef?: React.RefObject<HTMLInputElement>;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  };
  backHref?: string;
  onBack?: () => void;
  backLabel?: string;
  actions?: React.ReactNode;
  /**
   * The stat tiles. A stat whose `countTo` is 0 is dropped before render — the
   * asset page was spending a quarter of a phone screen on "0 DOCS / 0 TASKS".
   * Pass `value` instead of `countTo` for a stat that is meaningful at zero.
   */
  stats?: HeroStat[];
  /** Below the stats — a payoff/term bar. */
  progress?: React.ReactNode;
  testId?: string;
}

export function DetailHero({
  title, accent, icon: Icon, typeLabel, badges, subtitle, breadcrumb, notes,
  avatar, backHref, onBack, backLabel = "Back", actions, stats = [], progress,
  testId = "detail-hero",
}: DetailHeroProps) {
  // A count of zero is not a fact worth a tile. Stats that pass `value` are
  // kept as-is: "Autopay: Off" and "Status: Upcoming" mean something.
  const shown = stats.filter((s) => s.countTo == null || s.countTo > 0);

  return (
    <div
      className="bubble bubble-enter p-4 md:p-5"
      style={{ ["--accent-hsl" as any]: accent }}
      data-testid={testId}
    >
      {/* Back + actions */}
      {(backHref || onBack || actions) && (
        <div className="flex items-center justify-between gap-2 mb-3">
          {backHref && backHref.includes("?") ? (
            // A query-carrying target ("/linked?tab=assets") must stay INSIDE
            // the hash: wouter's Link hoists the query out of it, and the
            // section param then rides on the document URL instead of the
            // route. A plain hash anchor keeps it where the router reads it —
            // and is still a real, shareable link.
            <a
              href={`#${backHref}`}
              className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
            </a>
          ) : backHref ? (
            <Link
              href={backHref}
              className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
            </Link>
          ) : onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
            </button>
          ) : <span />}
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>
      )}

      {/* Identity */}
      <div className="flex items-start gap-3">
        {avatar ? (
          <>
            {avatar.inputRef && (
              <input
                ref={avatar.inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={avatar.onChange}
                data-testid="input-avatar-upload"
              />
            )}
            <button
              type="button"
              className="medallion pressable relative w-12 h-12 overflow-hidden group shrink-0"
              style={{ ["--accent-hsl" as any]: accent }}
              onClick={avatar.onPick}
              disabled={avatar.busy}
              title="Change profile picture"
              data-testid="button-avatar-upload"
            >
              {avatar.src
                ? <img src={avatar.src} alt="" className="w-full h-full object-cover" />
                : <Icon className="h-[22px] w-[22px]" strokeWidth={2.1} />}
              <span className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <Camera className="h-4 w-4 text-white" />
              </span>
              {avatar.busy && (
                <span className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <RefreshCw className="h-4 w-4 text-white animate-spin" />
                </span>
              )}
            </button>
          </>
        ) : (
          <Medallion icon={Icon} accent={accent} />
        )}

        <div className="flex-1 min-w-0">
          <h1
            className="text-xl font-bold tracking-tight leading-tight"
            data-testid="detail-hero-title"
          >
            {title}
          </h1>
          {subtitle && (
            <p className="text-[13px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          )}
          {breadcrumb}
          {(typeLabel || badges) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {/* `capitalize` because callers pass the raw stored type — the
                  chip read "asset", lowercase, next to a bold title. */}
              {typeLabel && <Pill accent={accent} className="capitalize">{typeLabel}</Pill>}
              {badges}
            </div>
          )}
        </div>
      </div>

      {notes && (
        <p className="text-[13px] text-muted-foreground mt-3 leading-relaxed line-clamp-3">{notes}</p>
      )}

      {shown.length > 0 && (
        <div
          className={cn(
            "grid gap-2 mt-4",
            shown.length === 1 ? "grid-cols-1"
              : shown.length === 3 ? "grid-cols-3"
              : "grid-cols-2 md:grid-cols-4",
          )}
        >
          {shown.map((s, i) => (
            <MetricCard
              key={s.testId || `${s.label}-${i}`}
              label={s.label}
              value={s.value}
              countTo={s.countTo}
              sub={s.sub}
              icon={s.icon}
              accent={s.accent || accent}
              // Every tile here shares the page's accent, so colouring all four
              // values with it produced a wall of red — and drowned the one tile
              // that goes red because a payment is genuinely overdue. Only a
              // stat that asked for its OWN accent gets a coloured value.
              valueTone={s.accent ? "accent" : "foreground"}
              // Counts get the full 26px. Words and dates don't fit it in a
              // half-width tile on a phone: "Aug 30, 2026" truncated to
              // "Aug 30, …" at 26px, which is worse than showing it smaller.
              valueSize={s.countTo != null ? 26 : 21}
              onClick={s.onClick}
              testId={s.testId}
              style={{ ["--i" as any]: i }}
              className="bubble-enter"
            />
          ))}
        </div>
      )}

      {progress && <div className="mt-3">{progress}</div>}
    </div>
  );
}

export default DetailHero;
