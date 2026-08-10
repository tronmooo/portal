// ── The Executive tab's ten sections, as bubbles ─────────────────────────────
// Presentation only. Which section a record belongs to — and the guarantee that
// it belongs to exactly one — lives in shared/executive-sections.ts.
//
// The visual system, and why:
//
//  * Every section is a rounded "bubble" (see .bubble in index.css): layered
//    shadow plus a gradient wash tinted by the section's accent. Depth comes
//    from shadow and gradient rather than backdrop-filter, because the app
//    ships inside an iOS WKWebView and blurring a dozen scrolling surfaces
//    janks badly there. Frosted glass stays on pinned surfaces only.
//
//  * Density is TIERED, not uniform. "Immediate Attention" is the hero — large
//    type, big medallion, an amount headline. The day's working sections come
//    next. Reference sections (birthdays, activity, insights) render compact
//    and start collapsed. Making all ten equally large would push the tab back
//    into a long scroll and defeat the point of the page.
//
//  * Colour is semantic and consistent with the rest of the app: red overdue,
//    orange due-soon, yellow needs-attention, green healthy, blue info, purple
//    AI. Hierarchy is carried by SIZE and WEIGHT rather than by fading text,
//    because --muted-foreground is already tuned to sit exactly at the WCAG AA
//    threshold and dimming further would drop it under.

import { useState } from "react";
import { BubbleSkeleton } from "@/components/ui/skeleton";
import { useLocation } from "wouter";
import {
  ChevronDown, ChevronRight, Check, CreditCard, ArrowRight, X, Clock,
  TriangleAlert, CalendarDays, Flame, DollarSign, CalendarClock, Cake,
  FolderOpen, Heart, History, Sparkles, PartyPopper, Lightbulb, type LucideIcon, TrendingUp,
} from "lucide-react";
import type { AttentionItem } from "@shared/attention";
import { DISPLAY_CAP } from "@shared/executive-sections";
import type { ExecSection, ExecSectionId } from "@shared/executive-sections";
import { Medallion, ProgressRing, CountUp, Pill, toneForDays, tonePalette, type PillTone } from "./visuals";

const ACTION_ICON = {
  complete: Check,
  pay: CreditCard,
  received: Check,
  checkin: Check,
  dismiss: X,
  snooze: Clock,
  open: ArrowRight,
  taken: Check,
  markdone: Check,
} as const;

/** A section should be recognisable before its title is read. */
const SECTION_ICON: Record<ExecSectionId, LucideIcon> = {
  immediate: TriangleAlert,
  today: CalendarDays,
  habits: Flame,
  bills: DollarSign,
  income: TrendingUp,
  upcoming: CalendarClock,
  importantDates: Cake,
  documents: FolderOpen,
  health: Heart,
  activity: History,
  insights: Sparkles,
  recommendations: Lightbulb,
};

/** hero = dominates the page · working = normal · reference = compact, folded. */
type Emphasis = "hero" | "working" | "reference";
const EMPHASIS: Record<ExecSectionId, Emphasis> = {
  immediate: "hero",
  today: "working",
  habits: "working",
  bills: "working",
  income: "working",
  upcoming: "working",
  documents: "working",
  health: "working",
  importantDates: "reference",
  activity: "reference",
  insights: "reference",
  // Not reference material: this section exists only because the user just
  // asked for it, so folding it shut would make them tap twice to read it.
  recommendations: "working",
};

export interface ExecutiveSectionsProps {
  sections: ExecSection[];
  loading?: boolean;
  onAction: (item: AttentionItem) => void;
  busyKeys?: Set<string>;
  armedKey?: string | null;
  /** Rows mid-exit after being completed, so they leave rather than vanish. */
  leavingKeys?: Set<string>;
}

function ActionButton({ item, busy, armed, hero, onAction }: {
  item: AttentionItem; busy: boolean; armed: boolean; hero: boolean;
  onAction: (i: AttentionItem) => void;
}) {
  if (!item.action) return null;
  const Icon = ACTION_ICON[item.action.kind] || ArrowRight;
  const label = armed ? "Confirm" : item.action.label;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onAction(item); }}
      disabled={busy}
      data-testid={`exec-action-${item.key}`}
      aria-label={`${label} — ${item.title}`}
      className={`touch-hit shrink-0 inline-flex items-center gap-1.5 rounded-full border font-semibold transition-all disabled:opacity-50 active:scale-95 ${
        hero ? "px-3.5 py-2 text-xs" : "px-3 py-1.5 text-[11px]"
      } ${
        armed
          ? "border-red-500/50 bg-red-500/15 text-red-500"
          : "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className={hero ? "h-4 w-4" : "h-3.5 w-3.5"} />
      {busy ? "…" : label}
    </button>
  );
}

function Row({ item, hero, depth = 0, busyKeys, armedKey, leavingKeys, onAction }: {
  item: AttentionItem; hero: boolean; depth?: number;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
  onAction: (i: AttentionItem) => void;
}) {
  const [, navigate] = useLocation();
  const [expanded, setExpanded] = useState(false);
  const hasChildren = !!item.children?.length && (item.count ?? 0) > 1;
  // One tone drives the dot, the pill and the row's accent, so they can never
  // disagree. An alert has no date, so `toneForDays` alone would paint a
  // critical conflict informational-blue inside Immediate Attention.
  const tone: PillTone =
    item.kind === "alert"
      ? (item.tier === "immediate" ? "critical" : "ai")
      : toneForDays(item.daysUntil);
  const hsl = tonePalette(tone);
  const open = () => (hasChildren ? setExpanded((x) => !x) : navigate(item.href));
  const leaving = leavingKeys?.has(item.key);
  // Expired / overdue rows breathe so the eye lands on them first.
  const urgent = (item.daysUntil ?? 0) < 0;

  return (
    <div data-testid={`exec-item-${item.key}`} className={leaving ? "row-leaving" : ""}>
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        className={`bubble-row w-full flex items-center gap-3 text-left cursor-pointer ${
          hero ? "px-3.5 py-3" : "px-3 py-2.5"
        } ${depth ? "ml-4" : ""} ${urgent && hero ? "pulse-attention" : ""}`}
        style={{ ["--accent-hsl" as any]: hsl }}
      >
        {hasChildren && (
          <ChevronRight className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        )}
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: `hsl(${hsl})`, boxShadow: `0 0 6px hsl(${hsl} / 0.8)` }}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <p className={`font-semibold truncate ${hero ? "text-[15px] leading-tight" : "text-[13px] leading-tight"}`}>
            {item.title}
          </p>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <Pill tone={tone}>{item.reason}</Pill>
            {item.count && item.count > 1 && (
              <span className="text-[11px] text-muted-foreground">{item.count} items</span>
            )}
          </div>
        </div>
        <ActionButton
          item={item} hero={hero}
          busy={!!busyKeys?.has(item.key)}
          armed={armedKey === item.key}
          onAction={onAction}
        />
      </div>
      {hasChildren && expanded && (
        <div className="mt-1.5 space-y-1.5">
          {item.children!.map((c) => (
            <Row key={c.key} item={c} hero={false} depth={depth + 1}
              busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionBubble({ section, index, busyKeys, armedKey, leavingKeys, onAction }: {
  section: ExecSection; index: number;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
  onAction: (i: AttentionItem) => void;
}) {
  // The static table is the default; a section may raise its own voice when its
  // contents warrant it (Birthdays unfolds when one lands inside the week).
  const emphasis = section.emphasis ?? EMPHASIS[section.id];
  const hero = emphasis === "hero";
  const [open, setOpen] = useState(emphasis !== "reference");
  const [showAll, setShowAll] = useState(false);
  // The section carries EVERY row; this is where they collapse. Previously the
  // builder truncated the list and this only knew how many were missing, so
  // "+N more" had nothing to reveal — it removed itself and the rows never
  // appeared (QA report 2026-08-05).
  const visible = showAll ? section.items : section.items.slice(0, DISPLAY_CAP);
  const hidden = section.items.length - visible.length;
  const Icon = SECTION_ICON[section.id];

  return (
    <section
      // break-inside-avoid: below, the non-hero sections flow through a CSS
      // multi-column layout on wide screens, and a bubble split across the
      // column boundary would render as two half-cards.
      className={`bubble bubble-enter mb-3 break-inside-avoid ${hero ? "p-4 sm:p-5" : "p-3.5 sm:p-4"}`}
      style={{ ["--accent-hsl" as any]: section.accent, ["--i" as any]: index }}
      data-testid={`exec-section-${section.id}`}
      aria-label={section.title}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 text-left group touch-hit"
        aria-expanded={open}
      >
        <Medallion icon={Icon} accent={section.accent} size={hero ? "lg" : "sm"} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className={`font-bold tracking-tight truncate ${hero ? "text-base" : "text-sm"}`}>
              {section.title}
            </h3>
            <span
              className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums"
              style={{ background: `hsl(${section.accent} / 0.16)`, color: `hsl(${section.accent})` }}
            >
              {section.total}
            </span>
          </div>
          {section.subtitle && (
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{section.subtitle}</p>
          )}
          {section.amount ? (
            <p className={`metric-value mt-1 ${hero ? "text-2xl" : "text-xl"}`} style={{ color: `hsl(${section.accent})` }}>
              $<CountUp value={Math.round(section.amount)} />
            </p>
          ) : null}
        </div>
        {section.progress && (
          <ProgressRing
            value={section.progress.done}
            total={section.progress.total}
            accent={section.accent}
            size={hero ? 60 : 48}
            stroke={hero ? 6 : 5}
          />
        )}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className={`space-y-2 ${hero ? "mt-3.5" : "mt-3"}`}>
          {visible.map((i) => (
            <Row key={i.key} item={i} hero={hero}
              busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys} onAction={onAction} />
          ))}
          {hidden > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="w-full rounded-full py-2 text-[12px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              data-testid={`exec-more-${section.id}`}
            >
              +{hidden} more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function ExecutiveSections({
  sections, loading, onAction, busyKeys, armedKey, leavingKeys,
}: ExecutiveSectionsProps) {
  if (loading) {
    return (
      <div className="space-y-3" data-testid="exec-sections" aria-label="Loading what needs attention">
        {[0, 1, 2].map((i) => (
          <BubbleSkeleton key={i} rows={1} height={96} index={i} />
        ))}
      </div>
    );
  }

  if (sections.length === 0) {
    return (
      <div
        className="bubble bubble-enter px-6 py-10 text-center"
        style={{ ["--accent-hsl" as any]: "155 60% 45%" }}
        data-testid="exec-sections"
      >
        <span className="medallion mx-auto mb-3 !w-14 !h-14" style={{ ["--accent-hsl" as any]: "155 60% 45%" }} aria-hidden="true">
          <PartyPopper className="h-7 w-7" strokeWidth={2} />
        </span>
        <p className="text-base font-bold">You're all caught up</p>
        <p className="text-[13px] text-muted-foreground mt-1.5 max-w-xs mx-auto leading-relaxed">
          Nothing is overdue, nothing is due today, and nothing expires soon.
          Anything new will show up here first.
        </p>
      </div>
    );
  }

  // COLUMNS (2026-08-05). The feed was a single stack at every width, so on a
  // desktop the sections became ~700px-wide bands holding a 200px title on the
  // left and a button on the right with nothing between them — a phone layout
  // stretched sideways, and a scroll long enough that the bottom sections were
  // never seen. The hero keeps the full width it earns; everything below it
  // flows into two columns from lg up.
  //
  // CSS multi-column rather than two hand-split arrays on purpose: it preserves
  // DOM order (so reading order, tab order and the `+N more` focus targets stay
  // the order the sections were assembled in) and collapses back to one column
  // below lg with no second code path.
  const heroes = sections.filter(s => (s.emphasis ?? EMPHASIS[s.id]) === "hero");
  const rest = sections.filter(s => (s.emphasis ?? EMPHASIS[s.id]) !== "hero");

  return (
    <div data-testid="exec-sections">
      {heroes.map((s, i) => (
        <SectionBubble
          key={s.id} section={s} index={i}
          busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
          onAction={onAction}
        />
      ))}
      <div className="lg:columns-2 lg:gap-3">
        {rest.map((s, i) => (
          <SectionBubble
            key={s.id} section={s} index={heroes.length + i}
            busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  );
}

export default ExecutiveSections;
