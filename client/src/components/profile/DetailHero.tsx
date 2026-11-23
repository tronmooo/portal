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
import { Camera, RefreshCw, ArrowLeft, ChevronLeft, type LucideIcon } from "lucide-react";
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
  /**
   * The screen's name, centred between the back arrow and the actions
   * ("Asset Profile"). With it the back control is the arrow alone — its label
   * stays as the accessible name — and the avatar is drawn large.
   */
  pageTitle?: string;
  /** Below the stats — a payoff/term bar. */
  progress?: React.ReactNode;
  testId?: string;
  /**
   * "card": the liability profile's header (owner's design, 2026-11-23) — ONE
   * card with the picture, `pageTitle` as a tag over the name, the chips, and
   * `stats` as the headline figures at the right (under the identity on a
   * phone). `menu` sits at its top right; `progress` is not drawn. Without
   * it, `pageTitle` keeps the centred-title layout the asset profile uses.
   */
  layout?: "card";
  /** The ⋯ control at the top right of the card layout. */
  menu?: React.ReactNode;
  /** The glyph beside `typeLabel` in the card layout. */
  typeIcon?: LucideIcon;
}

export function DetailHero({
  title, accent, icon: Icon, typeLabel, badges, subtitle, breadcrumb, notes,
  avatar, backHref, onBack, backLabel = "Back", actions, stats = [], progress, pageTitle,
  testId = "detail-hero", layout, menu, typeIcon: TypeIcon,
}: DetailHeroProps) {
  if (layout === "card" && pageTitle) {
    // The owner's profile header (2026-11-23): ONE card — the picture, a tag
    // naming the page, the name, the chips, and the headline figures at the
    // right (under the identity on a phone). `menu` sits at the top right.
    const backClass = "pressable grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors -ml-1.5";
    const chevron = <ChevronLeft className="h-5 w-5" strokeWidth={2.2} />;
    const figures = stats.filter((s) => s.countTo == null || s.countTo > 0);
    return (
      <div className="bubble relative p-3.5 sm:p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-5" style={{ ["--accent-hsl" as any]: accent }} data-testid={testId}>
        {/* back | picture | name, with the chips under the name from `sm` and
            across the whole card on a phone (three chips beside a picture
            wrapped to one per line there). */}
        <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-3 flex-1 min-w-0">
          {backHref && backHref.includes("?") ? (
            // Same reason as below: a query-carrying target stays inside the hash.
            <a href={`#${backHref}`} className={backClass} aria-label={backLabel} title={backLabel} data-testid="button-back">{chevron}</a>
          ) : backHref ? (
            <Link href={backHref} className={backClass} aria-label={backLabel} title={backLabel} data-testid="button-back">{chevron}</Link>
          ) : onBack ? (
            <button type="button" onClick={onBack} className={backClass} aria-label={backLabel} title={backLabel} data-testid="button-back">{chevron}</button>
          ) : <span />}
          {avatar ? (
            <>
              {avatar.inputRef && (
                <input ref={avatar.inputRef} type="file" accept="image/*" className="hidden" onChange={avatar.onChange} data-testid="input-avatar-upload" />
              )}
              <button
                type="button"
                className="sm:row-span-2 pressable relative h-[68px] w-[68px] sm:h-[84px] sm:w-[84px] overflow-hidden group shrink-0 grid place-items-center rounded-2xl border border-foreground/15 bg-foreground/[0.04]"
                onClick={avatar.onPick}
                disabled={avatar.busy}
                title="Change profile picture"
                data-testid="button-avatar-upload"
              >
                {avatar.src
                  ? <img src={avatar.src} alt="" className="absolute inset-0 w-full h-full object-cover" />
                  : <Icon className="h-9 w-9 text-foreground/85" strokeWidth={1.6} />}
                <span className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Camera className="h-5 w-5 text-white" />
                </span>
                {avatar.busy && (
                  <span className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <RefreshCw className="h-5 w-5 text-white animate-spin" />
                  </span>
                )}
              </button>
            </>
          ) : (
            <Medallion icon={Icon} accent={accent} />
          )}
          <div className={cn("min-w-0 self-center sm:self-start", menu && "pr-9 lg:pr-0")}>
            <span className="inline-block rounded px-1.5 py-0.5 text-[12px] font-semibold text-violet-100 bg-violet-500/70" data-testid="detail-hero-page-title">{pageTitle}</span>
            <h1 className="mt-0.5 text-[22px] sm:text-[26px] font-bold tracking-tight leading-tight break-words" data-testid="detail-hero-title">{title}</h1>
            {typeLabel && (
              <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                {TypeIcon && <TypeIcon className="h-4 w-4 shrink-0" />}
                <span className="truncate">{typeLabel}</span>
              </p>
            )}
            {subtitle && <p className="text-[13px] text-muted-foreground mt-0.5 truncate">{subtitle}</p>}
            {breadcrumb}
          </div>
          {badges && <div className="col-span-3 sm:col-span-1 sm:col-start-3 flex flex-wrap items-center gap-1.5 mt-2.5 sm:mt-2">{badges}</div>}
        </div>

        {figures.length > 0 && (
          <div
            className={cn("grid shrink-0 rounded-2xl border border-foreground/10 bg-foreground/[0.03] divide-x divide-foreground/10 lg:mr-9",
              figures.length >= 4 ? "grid-cols-4" : figures.length === 3 ? "grid-cols-3" : "grid-cols-2")}
            data-testid="detail-hero-figures"
          >
            {figures.map((s, i) => {
              const inner = (
                <>
                  <span className="block text-[11px] sm:text-[13px] text-muted-foreground leading-tight truncate">{s.label}</span>
                  <span
                    className="block text-[15px] sm:text-[19px] font-bold leading-tight tabular-nums whitespace-nowrap"
                    style={s.accent ? { color: `hsl(${s.accent})` } : undefined}
                    data-testid={s.testId}
                  >{s.value}</span>
                  {s.sub && <span className="block text-[11px] text-muted-foreground leading-tight truncate">{s.sub}</span>}
                </>
              );
              const cls = "px-1.5 sm:px-3.5 py-2 text-center min-w-0";
              return s.onClick
                ? <button key={s.testId || `${s.label}-${i}`} type="button" onClick={s.onClick} className={cn(cls, "pressable")} title={`Edit ${s.label.toLowerCase()}`}>{inner}</button>
                : <div key={s.testId || `${s.label}-${i}`} className={cls}>{inner}</div>;
            })}
          </div>
        )}

        {menu && <div className="absolute top-2 right-2">{menu}</div>}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    );
  }

  // A count of zero is not a fact worth a tile. Stats that pass `value` are
  // kept as-is: "Autopay: Off" and "Status: Upcoming" mean something.
  const shown = stats.filter((s) => s.countTo == null || s.countTo > 0);
  const backClass = pageTitle
    ? "inline-flex items-center justify-center h-9 w-9 -ml-2 rounded-full text-foreground hover:bg-muted/40 transition-colors"
    : "inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground transition-colors";
  const backInner = pageTitle
    ? <><ChevronLeft className="h-5 w-5" /><span className="sr-only">{backLabel}</span></>
    : <><ArrowLeft className="h-3.5 w-3.5" /> {backLabel}</>;
  const avatarBox = pageTitle ? "w-[72px] h-[72px] !rounded-2xl" : "w-12 h-12";

  return (
    <div
      className="bubble bubble-enter p-4 md:p-5"
      style={{ ["--accent-hsl" as any]: accent }}
      data-testid={testId}
    >
      {/* Back + actions */}
      {(backHref || onBack || actions) && (
        <div className={pageTitle ? "grid grid-cols-[1fr_auto_1fr] items-center gap-2 mb-3" : "flex items-center justify-between gap-2 mb-3"}>
          {backHref && backHref.includes("?") ? (
            // A query-carrying target ("/linked?tab=assets") must stay INSIDE
            // the hash: wouter's Link hoists the query out of it, and the
            // section param then rides on the document URL instead of the
            // route. A plain hash anchor keeps it where the router reads it —
            // and is still a real, shareable link.
            <a
              href={`#${backHref}`}
              className={`${backClass} justify-self-start`}
              data-testid="button-back"
            >
              {backInner}
            </a>
          ) : backHref ? (
            <Link
              href={backHref}
              className={`${backClass} justify-self-start`}
              data-testid="button-back"
            >
              {backInner}
            </Link>
          ) : onBack ? (
            <button
              type="button"
              onClick={onBack}
              className={`${backClass} justify-self-start`}
              data-testid="button-back"
            >
              {backInner}
            </button>
          ) : <span />}
          {pageTitle && <p className="text-[15px] font-semibold text-center" data-testid="detail-hero-page-title">{pageTitle}</p>}
          {actions ? <div className="flex items-center gap-1.5 shrink-0 justify-self-end">{actions}</div> : pageTitle ? <span /> : null}
        </div>
      )}

      {/* Identity */}
      <div className={pageTitle ? "flex items-center gap-4" : "flex items-start gap-3"}>
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
              className={`medallion pressable relative ${avatarBox} overflow-hidden group shrink-0`}
              style={{ ["--accent-hsl" as any]: accent }}
              onClick={avatar.onPick}
              disabled={avatar.busy}
              title="Change profile picture"
              data-testid="button-avatar-upload"
            >
              {avatar.src
                ? <img src={avatar.src} alt="" className="w-full h-full object-cover" />
                : <Icon className={pageTitle ? "h-8 w-8" : "h-[22px] w-[22px]"} strokeWidth={2.1} />}
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
            className={`${pageTitle ? "text-2xl" : "text-xl"} font-bold tracking-tight leading-tight`}
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
