// ── Executive tab — the command center ───────────────────────────────────────
// One glance answers: how am I doing, and what needs me today?
//
// Layout (2026-08-13 redesign, from the user's reference mock):
//
//   · Overview bar — Net Worth · Cash Flow · Tasks Remaining · Next Important
//   · Card grid    — Needs Attention | Tasks
//                    Schedule        | Habits
//                    Money           | Documents
//                    Wellness        | Upcoming
//   · Recent Activity, full-width, at the very bottom.
//
// Every number here reads the SAME react-query cache slots the rest of the app
// (and the AI chat's cache-bus invalidations) write through — logging a dose,
// paying a bill or letting the chat create a task updates these cards without
// any dedicated store. Routing of records into Needs Attention / Upcoming is
// still shared/executive-sections.ts, so a record appears once per feed and
// the tab can never disagree with the attention model.
//
// Actions survive the redesign: task circles complete tasks, habit rows check
// in, Pay arms then commits (money moves on the SECOND tap), medications get
// "Taken", managed recurring dates get "Done". Popups are the same components
// the dashboard KPI tiles use.
import { sumMonthIncomeNow, selectUpcomingBills, UPCOMING_BILLS_EMPTY_COPY } from "@shared/obligation-windows";
import { setEventOccurrence } from "@/lib/event-occurrence";
import { isDoneToday } from "@shared/task-counts";
import { relativeTimeShort, elapsedDays } from "@shared/relative-time";
import { netWorthChange } from "@shared/net-worth-change";
import { useState, useEffect, useMemo, useRef, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { useLocation } from "wouter";
import { routeForEntity } from "@shared/entity-routes";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, recoverWedgedQueries, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { useDocSnoozeMap } from "@/lib/docSnooze";
import { useDismissedAlerts } from "@/hooks/useDismissedAlerts";
import { DismissedAlertsList } from "@/components/dashboard/DismissedAlertsList";
import { isDateRowDismissed } from "@shared/alert-ids";
import { pickNextImportant } from "@shared/next-important";
import { setActiveDashboard } from "@shared/exec-dashboards";
import { useExecCardPrefs, WIDGET_ICON } from "@/components/dashboard/ExecCustomize";
import { ExecWidgetBody } from "@/components/dashboard/ExecWidgetBody";
import { execCardPosition, execCardSize, execCardTitle, hiddenExecCards, isExecCardVisible, lonelyMediumCards, orderedExecCards, widgetCardId, type ExecCardId, type ExecCardSize } from "@shared/exec-card-prefs";
import { isMedicationTracker } from "@shared/medication-doses";
import {
  TriangleAlert, CalendarDays, DollarSign, FolderOpen, Flame, Sparkles,
  SlidersHorizontal, ChevronRight, Check, CreditCard, ArrowRight, X, Clock,
  CheckSquare, Heart, History, TrendingUp, TrendingDown, CircleDollarSign,
  Receipt, FileText, Target, ListTodo, PartyPopper, CheckCircle2,
  Footprints, Moon, Activity as ActivityIcon, Droplets, Dumbbell, BookOpen,
  Brain, Apple, Pill as PillIcon, HeartPulse, Scale, Thermometer, Smile, Wallet,
  ArrowDownLeft, ArrowUpRight, type LucideIcon,
} from "lucide-react";
import { BubbleSkeleton } from "@/components/ui/skeleton";
// DRILL IN PLACE, WITH THE CANONICAL POPUP (user rule 2026-08-13).
//
// Two rules govern every pressable thing on this tab:
//
//  1. Pressing a summary EXPANDS it here, over the Executive tab — it does not
//     throw the user somewhere else in the app. Only an explicit "Open X"
//     action navigates. Closing a popup leaves the tab exactly where it was.
//  2. The popup that opens is the app's ONE canonical component for that data
//     type — the same Tasks popup the hub strip opens, the same Habits popup,
//     the same Wellness popups the Wellness tab opens, the same Bills view the
//     /dashboard/obligations page renders, the same Cash Flow waterfall the
//     Finance tab opens. Nothing here is a second version of an existing
//     screen, and a label never opens a different category's panel.
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import { EventsPopup, DocsPopup, dedupeBills } from "@/components/dashboard/BriefingPopups";
import { BillsDuePopup } from "@/components/finance/MoneyPopups";
import { readBillsTimeline } from "@/components/finance/BillsTimelineView";
import { NetWorthPopup } from "@/components/dashboard/HeroKPIPopups";
import { CashFlowView } from "@/components/finance/CashFlowView";
import { WellnessPopup, type WellnessPopupKind, type WellnessPopupData } from "@/components/wellness/WellnessPopups";
import { computeHealthScore } from "@/lib/tracker-health";
// hashNavigate for query-carrying targets ("/trackers?open=x",
// "/linked?tab=documents") — wouter's hash navigate hoists the query out of
// the hash, landing on the bare page instead (the CommandSearch bug).
import { hashNavigate } from "@/lib/hashNavigate";
import { useHubChrome } from "@/components/hub/hub-context";
import { BubbleModal } from "@/components/ui/bubble-modal";
import { EmptyState } from "@/components/ui/empty-state";
import { toneForDays, tonePalette, type PillTone } from "@/components/dashboard/visuals";
import { DeltaChip } from "@/components/tracker-detail/primitives";
import { formatMoney, formatMoneyRound } from "@/lib/format";
import { AttentionFilters, useAttentionPrefs } from "@/components/dashboard/AttentionFilters";
import type { DashboardStats } from "@shared/schema";
import type { AttentionItem } from "@shared/attention";
// One relative-due formatter for the whole app. Interpolating a raw `daysUntil`
// is what once produced "Lawn care ($40) due in -29d".
import { dayLabel } from "@shared/now-rank";
import { groupDocumentDates, summarizeDocumentUrgency } from "@shared/document-dates";
import { selectAttentionRows } from "@shared/executive-attention";
import { lifecycleAttentionItems } from "@shared/asset-lifecycle";
import { useAssetLifecycles } from "@/components/asset/AssetLifecycle";
import { buildExecutiveSections, normalizeAiSuggestions, type AiSuggestion, type ExecSectionId } from "@shared/executive-sections";
import { isHabitDueOn, isHabitDoneOn } from "@shared/habit-schedule";
import { habitDayProgress, habitsDayRollup } from "@shared/habit-progress";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import { extractVitals, countWellnessTrackers } from "@/lib/wellness-metrics";
import { canonicalTimelineWindow, timelineQueryKey, timelineUrl } from "@shared/calendar-window";

/** Every drill-down this tab can open, each mapping to ONE canonical component.
 *  `wellness:<kind>` defers to the Wellness tab's own popup set. */
type PopupKind =
  | "tasks" | "habits" | "bills" | "events" | "docs"
  | "networth" | "cashflow" | "upcoming"
  | `wellness:${WellnessPopupKind}`
  | null;

// Card identity colours — one per card, no two cards sharing a hue, and each
// matched to the accent its own popup or page already uses: purple tasks (the
// Tasks popup), flame-orange habits (the streak flame), blue schedule (the
// icon vocabulary's "dates"), green money, yellow documents, rose wellness,
// indigo upcoming, teal activity, red overdue.
const CARD_ACCENTS = {
  attention: "0 72% 58%",
  tasks:     "262 70% 62%",
  schedule:  "213 90% 62%",
  habits:    "25 90% 56%",
  money:     "155 65% 45%",
  documents: "43 96% 53%",
  wellness:  "350 85% 62%",
  upcoming:  "239 70% 64%",
  activity:  "173 60% 44%",
  recommendations: "280 75% 62%",
  custom:    "265 85% 66%",
} as const;

// ── Small formatting helpers ─────────────────────────────────────────────────

// Whole-dollar amounts for the card summaries — the shared formatter, so this
// tab rounds exactly the way the hub strip and Finance tab do.
const fmtUSD = formatMoneyRound;

function dateFromDays(du: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + du);
  return d;
}
const fmtWeekdayDate = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtShortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
// Guarded by the shared formatter: a negative count reads "Nd overdue", never
// "in -Nd" (user report 2026-07-26 #16).
const inDaysLabel = (du: number) =>
  du < 0 ? dayLabel(du) : du === 0 ? "today" : du === 1 ? "tomorrow" : `in ${du} days`;

function timeLabel12h(t: string | null | undefined): string {
  const s = String(t || "").slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(s)) return "";
  const [h, m] = s.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const capitalize = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** An event's end time, stored as "15:00" or (from Google) "3:00 PM". */
function clockLabel(t: string | null | undefined): string {
  const raw = String(t || "").trim();
  if (!raw) return "";
  return timeLabel12h(raw) || (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(raw) ? raw.toUpperCase() : "");
}

/** A day `n` days before `ymd`, as YYYY-MM-DD (calendar arithmetic, no zone). */
function ymdMinus(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// QA 2026-09-18 BUG-15: one relative-time rule (shared/relative-time).
function relTime(iso: string | null | undefined): string {
  return relativeTimeShort(iso);
}

/** "6.87" hours → "6h 52m". */
function fmtSleep(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// (Bill dedupe lives with the canonical Bills UI — imported from
// BriefingPopups — so this tab and the Bills view collapse the same rows.)

// ── Shared card chrome ───────────────────────────────────────────────────────

function ViewLink({ label, onClick, accent, testId }: {
  label: string; onClick: () => void; accent?: string; testId?: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      aria-label={label}
      className="shrink-0 inline-flex items-center gap-0.5 text-[11px] font-semibold transition-colors hover:underline"
      style={{ color: accent ? `hsl(${accent})` : undefined }}
    >
      <span className="exec-long">{label}</span>
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function ExecCard({ id, icon: Icon, title, accent, headerRight, children, className = "", index = 0, wide = false, order, shortTitle, subtitle, count, pos, size, fill = false }: {
  /** A medium card with no partner beside it on a phone takes the whole row
   *  there (lonelyMediumCards), instead of leaving half of it empty. */
  fill?: boolean;
  /** The size the user picked in Customize. "large" takes the full row at
   *  every width; "medium" is one column. Null = the built-in layout below. */
  size?: ExecCardSize | null;
  id: string; icon: LucideIcon; title: string; accent: string;
  /** The user's own place for this card (Customize). Null = the built-in
   *  layout: source order from 768px, `order` on a phone. */
  pos?: number | null;
  headerRight?: ReactNode; children: ReactNode; className?: string; index?: number;
  /** One grey line under the title ("Today · Sat, Nov 21"). */
  subtitle?: ReactNode;
  /** A count badge beside the title (Needs Attention's red "5"). */
  count?: number;
  /** PHONE LAYOUT (2026-11-21, owner: "I want the mobile view to be
   *  affected"). Under 768px the grid is TWO columns, not one. A card is half
   *  the screen (`exec-half`: index.css drops its row icons and grey detail
   *  under 640px so a title and its date still fit) unless it is `wide`
   *  (Habits, Money, Recent Activity need the full row). `order` is the
   *  card's place on a phone, so the half cards pair up; from 768px the
   *  source order applies. */
  wide?: boolean; order: number;
  /** The title a phone's half card shows when the full one will not fit. */
  shortTitle?: string;
}) {
  const span = size === "large" ? "col-span-2"
    : fill ? "col-span-2 md:col-span-1"
    : size === "medium" ? "exec-half" : wide ? "col-span-2 md:col-span-1" : "exec-half";
  const phone = `${PHONE_ORDER[order] ?? ""} md:order-none ${span}`;
  // h-full + flex column is what makes a card FILL its grid row instead of
  // hugging its content and leaving the rest of the cell black (user report
  // 2026-08-20: "there's a lot of empty space in the executive tab").
  //
  // The body is a plain flex region — NOT a scroll container. Bounding it with
  // max-height + overflow-y broke page scrolling on this tab (the wheel went
  // to the card under the pointer instead of the page), so content bounding
  // lives in the ExpandableRows caps below instead. See index.css.
  return (
    // 2026-11-21 (owner, reference screenshot): each card is tinted in its
    // own colour (`.exec-card`, index.css) with a title-case heading, its icon
    // in a tinted square, and an optional grey subtitle under it.
    <section
      className={`bubble exec-card bubble-enter p-2.5 sm:p-3.5 h-full flex flex-col min-w-0 ${phone} ${className}`}
      style={{ ["--accent-hsl" as any]: accent, ["--i" as any]: index, ...(pos != null ? { order: pos } : {}) }}
      data-testid={`exec-card-${id}`}
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {/* Needs Attention carries two header buttons: on a phone's half
              card its icon gives way so the title is whole. */}
          <RowIcon icon={Icon} hsl={accent} opt={!!shortTitle} size="lg" />
          <h3 className="exec-card-title truncate">
            {shortTitle ? <><span className="exec-long">{title}</span><span className="exec-short" aria-hidden="true">{shortTitle}</span></> : title}
          </h3>
          {count != null && count > 0 && (
            <span className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold tabular-nums text-white inline-flex items-center justify-center"
              style={{ background: `hsl(${accent})` }} data-testid={`exec-card-count-${id}`}>
              {count}
            </span>
          )}
        </div>
        {headerRight}
      </div>
      {subtitle != null && subtitle !== "" && (
        <p className="text-[11px] sm:text-[12px] text-muted-foreground mt-0.5 line-clamp-2 shrink-0" data-testid={`exec-card-subtitle-${id}`}>{subtitle}</p>
      )}
      <div className="mb-2 shrink-0" aria-hidden="true" />
      <div className="exec-card-body flex-1 min-h-0 flex flex-col">{children}</div>
    </section>
  );
}

/** Literal class names, so Tailwind emits them. */
const PHONE_ORDER: Record<number, string> = {
  1: "order-1", 2: "order-2", 3: "order-3", 4: "order-4", 5: "order-5",
  6: "order-6", 7: "order-7", 8: "order-8", 9: "order-9",
};

/** An empty card still fills its cell — the message centres in the space
 *  rather than sitting at the top with a black void under it. */
function CardEmpty({ children, accent, icon, tone }: {
  children: string; accent?: string; icon?: LucideIcon; tone?: PillTone;
}) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <EmptyState compact scope="global" label={children} icon={icon} tone={tone} accent={tone ? undefined : accent} />
    </div>
  );
}

/**
 * A capped list with a "View all (N)" expander. The full list is ALWAYS in
 * props and the collapsing happens here — the 2026-08-05 QA regression was a
 * builder that truncated the list first, leaving the button nothing to reveal.
 * Exported for the DOM regression test that guards exactly that.
 */
export function ExpandableRows({ id, count, cap = 4, moreLabel, children }: {
  id: string;
  /** Total rows in `children`. */
  count: number;
  cap?: number;
  /** Defaults to "View all (N)". */
  moreLabel?: string;
  children: ReactNode[];
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? children : children.slice(0, cap);
  const hidden = count - visible.length;
  return (
    <>
      {visible}
      {hidden > 0 && (
        <FooterLink onClick={() => setShowAll(true)} testId={`exec-more-${id}`}>
          {moreLabel ?? `View all (${count})`}
        </FooterLink>
      )}
    </>
  );
}

/** The one footer-link treatment on this tab: an expander ("View all (N)",
 *  "2 more habits") or a link to a DIFFERENT place than the card's header
 *  ViewLink. A footer that repeats the header's destination is noise — the
 *  header link is the card's "view all". */
function FooterLink({ onClick, testId, children }: {
  onClick: () => void; testId?: string; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-1 pt-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
      data-testid={testId}
    >
      {children}
      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** The tinted icon square every row on this tab leads with (ItemRow's). */
function RowIcon({ icon: Icon, hsl, opt = false, size = "sm" }: {
  icon: LucideIcon; hsl: string;
  /** Dropped on a phone's half-width card (index.css `.exec-opt`). */
  opt?: boolean;
  /** "lg": a card heading's or a two-line row's icon. */
  size?: "sm" | "lg";
}) {
  const lg = size === "lg";
  return (
    <span
      className={`${lg ? "h-7 w-7 sm:h-8 sm:w-8 rounded-lg" : "h-6 w-6 rounded-md"} flex items-center justify-center shrink-0 ${opt ? "exec-opt" : ""}`}
      style={{ background: `hsl(${hsl} / 0.15)`, color: `hsl(${hsl})`, boxShadow: lg ? `inset 0 0 0 1px hsl(${hsl} / 0.25)` : undefined }}
      aria-hidden="true"
    >
      <Icon className={lg ? "h-4 w-4" : "h-3.5 w-3.5"} strokeWidth={2.1} />
    </span>
  );
}

const KIND_ICON: Record<string, LucideIcon> = {
  bill: Receipt,
  document: FileText,
  task: ListTodo,
  habit: Flame,
  event: CalendarDays,
  reminder: PillIcon,
  goal: Target,
  alert: TriangleAlert,
};

function ActionButton({ item, busy, armed, onAction }: {
  item: AttentionItem; busy: boolean; armed: boolean;
  onAction: (i: AttentionItem) => void;
}) {
  const kind = item.action?.kind;
  // Rows navigate on tap; a dedicated button only exists where it DOES
  // something beyond navigating (pay, complete, taken, done, check-in).
  if (!kind || kind === "open") return null;
  const Icon = ({ complete: Check, pay: CreditCard, checkin: Check, dismiss: X, snooze: Clock, taken: Check, markdone: Check } as Record<string, LucideIcon>)[kind] || ArrowRight;
  const label = armed ? "Confirm" : item.action!.label;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onAction(item); }}
      disabled={busy}
      data-testid={`exec-action-${item.key}`}
      aria-label={`${label} — ${item.title}`}
      title={label}
      className={`touch-hit shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-semibold transition-all disabled:opacity-50 active:scale-95 ${
        armed
          ? "border-red-500/50 bg-red-500/15 text-red-500"
          : "border-border/70 bg-background/60 text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {/* Icon-only at rest so long titles keep their room in a half-width
          card; the label appears when it carries state (arming, busy) — and
          stays in the accessible name always. */}
      {busy ? "…" : armed ? label : <span className="sr-only">{label}</span>}
    </button>
  );
}

/** A record row: tinted icon square, title + reason, right-aligned amount/date,
 *  and the item's action when it has a real one. */
/** "Policy — Expiration" → { main: "Policy", suffix: "Expiration" }. Exported
 *  for the regression test; the suffix is the last " — " segment. */
export function splitKindSuffix(title: string): { main: string; suffix: string | null } {
  const parts = String(title || "").split(" — ");
  if (parts.length < 2) return { main: String(title || ""), suffix: null };
  const suffix = parts[parts.length - 1].trim();
  // Only a short kind word is a suffix; a long tail is part of the name.
  if (!suffix || suffix.length > 24) return { main: String(title || ""), suffix: null };
  return { main: parts.slice(0, -1).join(" — "), suffix };
}

function ItemRow({ item, busyKeys, armedKey, leavingKeys, onAction, onOpen, onDismiss, stacked = false, sub, pill = true }: {
  item: AttentionItem;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
  onAction: (i: AttentionItem) => void;
  onOpen: (i: AttentionItem) => void;
  /** Stacked rows only: offers Dismiss on a dated record (see StackedItemRow). */
  onDismiss?: (i: AttentionItem) => void;
  /** Two lines — title over its detail — with the date in a tinted pill and
   *  a chevron (the reference screenshot's Needs Attention / Upcoming rows). */
  stacked?: boolean;
  /** The second line, when it is not the item's own reason. */
  sub?: string;
  /** Stacked rows only: show the date pill (Upcoming says the date in `sub`). */
  pill?: boolean;
}) {
  if (stacked) return <StackedItemRow item={item} busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys} onAction={onAction} onOpen={onOpen} onDismiss={onDismiss} sub={sub} pill={pill} />;
  const tone: PillTone = item.kind === "alert" ? "critical" : toneForDays(item.daysUntil);
  const hsl = tonePalette(tone);
  const Icon = KIND_ICON[item.kind] ?? TriangleAlert;
  const right = item.amount
    ? fmtUSD(item.amount)
    : item.daysUntil != null && item.daysUntil > 0
      ? fmtShortDate(dateFromDays(item.daysUntil))
      : null;
  // QA 2026-09-18 BUG-20: "Homeowners Insurance Policy Declaration — Expiration"
  // and "… — Payment" both truncated to "Homeowners Insurance Policy De…". The
  // kind suffix is what tells them apart, so it renders as its own badge that
  // never truncates; only the record name ellipsises.
  const { main: titleMain, suffix: titleSuffix } = splitKindSuffix(item.title);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(item); } }}
      className={`bubble-row w-full flex items-center ${ROW} text-left cursor-pointer ${leavingKeys?.has(item.key) ? "row-leaving" : ""}`}
      style={{ ["--accent-hsl" as any]: hsl }}
      data-testid={`exec-item-${item.key}`}
      title={item.reason ? `${item.title} — ${item.reason}` : item.title}
    >
      <RowIcon icon={Icon} hsl={hsl} opt />
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <p className="text-[13px] font-semibold leading-tight flex items-center gap-1.5 min-w-0 flex-1">
          <span className="truncate min-w-0">{titleMain}</span>
          {titleSuffix && (
            <span className="shrink-0 rounded px-1 py-px micro-label"
              style={{ background: `hsl(${hsl} / 0.14)`, color: `hsl(${hsl})` }}
              data-testid={`exec-item-kind-${item.key}`}>
              {titleSuffix}
            </span>
          )}
        </p>
        {item.reason && <p className={`text-[11px] text-muted-foreground truncate shrink-0 max-w-[45%] ${right ? "exec-opt" : ""}`}>{item.reason}</p>}
      </div>
      {right && (
        <span className="shrink-0 text-[12px] font-bold tabular-nums" style={{ color: `hsl(${hsl})` }}>
          {right}
        </span>
      )}
      {/* On a phone's half card a row with a date keeps the date and drops
          the button (the row itself opens the item); a row with no date —
          a dose due now — keeps its button. */}
      <span className={`shrink-0 inline-flex empty:hidden ${right ? "exec-opt" : ""}`}>
        <ActionButton
          item={item}
          busy={!!busyKeys?.has(item.key)}
          armed={armedKey === item.key}
          onAction={onAction}
        />
      </span>
    </div>
  );
}

function StackedItemRow({ item, busyKeys, armedKey, leavingKeys, onAction, onOpen, onDismiss, sub, pill }: {
  item: AttentionItem;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
  onAction: (i: AttentionItem) => void;
  onOpen: (i: AttentionItem) => void;
  onDismiss?: (i: AttentionItem) => void;
  sub?: string; pill: boolean;
}) {
  const tone: PillTone = item.kind === "alert" ? "critical" : toneForDays(item.daysUntil);
  const hsl = tonePalette(tone);
  const Icon = KIND_ICON[item.kind] ?? TriangleAlert;
  // BUG-20 still holds: the kind suffix ("Expiration", "Payment") is what
  // tells two rows for one record apart, so it keeps its own coloured word —
  // on the detail line now, where it can no longer collide with the title.
  const { main: titleMain, suffix: titleSuffix } = splitKindSuffix(item.title);
  const detail = sub ?? item.reason;
  const pillText = item.amount
    ? fmtUSD(item.amount)
    : item.daysUntil != null ? fmtShortDate(dateFromDays(item.daysUntil)) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(item); } }}
      className={`bubble-row w-full flex items-center gap-2 px-2 py-1.5 text-left cursor-pointer ${leavingKeys?.has(item.key) ? "row-leaving" : ""}`}
      style={{ ["--accent-hsl" as any]: hsl }}
      data-testid={`exec-item-${item.key}`}
      title={item.reason ? `${item.title} — ${item.reason}` : item.title}
    >
      <RowIcon icon={Icon} hsl={hsl} size="lg" opt />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold leading-tight truncate">{titleMain}</p>
        {(titleSuffix || detail) && (
          <p className="text-[11px] text-muted-foreground leading-tight truncate mt-0.5">
            {titleSuffix && (
              <span className="font-semibold" style={{ color: `hsl(${hsl})` }} data-testid={`exec-item-kind-${item.key}`}>
                {titleSuffix}{detail ? " · " : ""}
              </span>
            )}
            {detail}
          </p>
        )}
      </div>
      {pill && pillText && (
        <span className="shrink-0 rounded-full px-1.5 sm:px-2 py-0.5 text-[11px] font-bold tabular-nums"
          style={{ background: `hsl(${hsl} / 0.16)`, color: `hsl(${hsl})`, boxShadow: `inset 0 0 0 1px hsl(${hsl} / 0.35)` }}
          data-testid={`exec-item-pill-${item.key}`}>
          {pillText}
        </span>
      )}
      <span className={`shrink-0 inline-flex empty:hidden ${pillText ? "exec-opt" : ""}`}>
        <ActionButton item={item} busy={!!busyKeys?.has(item.key)} armed={armedKey === item.key} onAction={onAction} />
      </span>
      {/* A dated record (an expired document) has no "done" of its own, so
          it gets the same Dismiss an alert has — without it the only way to
          clear the row was two levels down in the Documents panel. Always
          shown: it is the one thing this row can be told. */}
      {onDismiss && item.kind === "document" && (item.dismissIds?.length ?? 0) > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(item); }}
          data-testid={`exec-dismiss-${item.key}`}
          aria-label={`Dismiss — ${item.title}`}
          title="Dismiss"
          className="touch-hit shrink-0 inline-flex items-center rounded-full border border-border/70 bg-background/60 px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-all active:scale-95"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      <ChevronRight className="exec-opt h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}

// ── Upcoming popup ───────────────────────────────────────────────────────────
// The canonical expansion of the Upcoming card: the SAME dated list the card
// previews, in full, grouped by day. It is not the Bills panel, not the
// Calendar and not the Tasks list — it is the card's own dataset, which is why
// the two rows visible on the card are simply the first two rows here.
//
// The "Next Important" KPI opens this too, and for the same reason: that KPI
// IS the first row of this list (soonest-first), so this is where its record
// lives. Giving it a separate-but-identical panel would be exactly the
// duplicate-interface problem this pass exists to remove.
type UpcomingFilter = "all" | "tasks" | "events" | "bills" | "other";
const upcomingCategory = (i: AttentionItem): Exclude<UpcomingFilter, "all"> =>
  i.kind === "task" ? "tasks" : i.kind === "event" ? "events" : i.kind === "bill" ? "bills" : "other";

function UpcomingPopup({ open, onClose, items, onAction, onOpenItem, busyKeys, armedKey, leavingKeys }: {
  open: boolean; onClose: () => void; items: AttentionItem[];
  onAction: (i: AttentionItem) => void;
  onOpenItem: (i: AttentionItem) => void;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
}) {
  // 2026-10-21 redo: a filter by kind (the panel mixes tasks, events, bills,
  // renewals and goal deadlines over 30 days — "show me just my tasks" was
  // a scroll), the week at a glance on top, and real day headers.
  const [filter, setFilter] = useState<UpcomingFilter>("all");
  useEffect(() => { if (open) setFilter("all"); }, [open]);
  const counts = useMemo(() => {
    const c: Record<UpcomingFilter, number> = { all: items.length, tasks: 0, events: 0, bills: 0, other: 0 };
    for (const i of items) c[upcomingCategory(i)]++;
    return c;
  }, [items]);
  const shown = filter === "all" ? items : items.filter((i) => upcomingCategory(i) === filter);
  const thisWeek = items.filter((i) => (i.daysUntil ?? 99) <= 7).length;

  // Tomorrow and the rest of this week get a header per DAY (a week reads as
  // a week); further out folds into Next week / Later this month / Later.
  const groups: Array<{ key: string; label: string; sub?: string; rows: AttentionItem[] }> = [];
  for (const i of shown) {
    const du = i.daysUntil ?? 0;
    const date = dateFromDays(du);
    const key = du <= 7 ? `d${du}` : du <= 14 ? "next" : du <= 31 ? "month" : "later";
    const label = du === 1 ? "Tomorrow"
      : du <= 7 ? date.toLocaleDateString(undefined, { weekday: "long" })
      : du <= 14 ? "Next week"
      : du <= 31 ? "Later this month"
      : "Later";
    const sub = du <= 7 ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : undefined;
    const g = groups.find((x) => x.key === key);
    if (g) g.rows.push(i); else groups.push({ key, label, sub, rows: [i] });
  }
  const FILTERS: Array<{ id: UpcomingFilter; label: string }> = [
    { id: "all", label: "All" }, { id: "tasks", label: "Tasks" }, { id: "events", label: "Events" },
    { id: "bills", label: "Bills" }, { id: "other", label: "Other" },
  ];
  return (
    <BubbleModal
      open={open} onClose={onClose} title="Upcoming" icon={Clock}
      accent={CARD_ACCENTS.upcoming} count={items.length}
      subtitle={items.length === 0 ? "The next 30 days"
        : `${thisWeek} this week · ${items.length} in the next 30 days`}
      testId="upcoming-popup" width="lg" tall
    >
      {items.length > 0 && (
        <div className="td-seg flex flex-wrap w-full" role="tablist" aria-label="Show" style={{ borderRadius: "1.1rem" }}
          data-testid="upcoming-filters">
          {FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)} data-testid={`upcoming-filter-${f.id}`}
              className="td-seg-item flex-1 justify-center px-1.5 min-w-0">
              {f.label}<span className="tabular-nums text-[11px] opacity-60">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState scope="global" label="Nothing coming up in the next 30 days." icon={Clock} accent={CARD_ACCENTS.upcoming} className="py-8" />
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-muted-foreground py-6 text-center">Nothing of this kind coming up.</p>
      ) : groups.map((g) => (
        <section key={g.key} data-testid={`upcoming-group-${g.key}`}>
          <p className="px-1 pt-2 pb-1 flex items-baseline gap-1.5">
            <span className="micro-label" style={{ color: `hsl(${CARD_ACCENTS.upcoming})` }}>{g.label}</span>
            {g.sub && <span className="text-[11px] text-muted-foreground">{g.sub}</span>}
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{g.rows.length}</span>
          </p>
          <div className="space-y-1.5">
            {g.rows.map((i) => (
              <ItemRow key={i.key} item={i}
                busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                onAction={onAction} onOpen={onOpenItem} />
            ))}
          </div>
        </section>
      ))}
    </BubbleModal>
  );
}

// ── Overview bar cell ────────────────────────────────────────────────────────

// Rules 18 / 29 / 30: a KPI cell has four states. `error` renders "—" with a
// "Couldn't load" sublabel (never a 0 or $0 over a failed query);
// `revalidating` dims the cell and shows a pulse while the backing query
// refetches, so a cached number is visibly not-yet-confirmed.
function OverviewCell({ icon: Icon, accent, label, value, sub, subClass, onClick, testId, revalidating = false, error = false, inline = false }: {
  /** Label, value and sub on ONE line — for the full-width bar under the hub
   *  shell, where there is room across and none to spare down. */
  inline?: boolean;
  icon: LucideIcon; accent: string; label: string; value: string;
  /** A string, or a node such as a DeltaChip for the month-over-month move. */
  sub?: ReactNode; subClass?: string; onClick: () => void; testId: string;
  revalidating?: boolean; error?: boolean;
}) {
  const shownValue = error ? "—" : value;
  const shownSub = error ? "Couldn't load" : sub;
  const shownSubClass = error ? "text-red-500" : subClass;
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      data-revalidating={revalidating || undefined}
      data-error={error || undefined}
      title={revalidating ? "Updating…" : undefined}
      className={`bubble-row flex items-center gap-2 min-w-0 px-2 py-1.5 text-left touch-hit transition-opacity duration-200 ${revalidating ? "opacity-70" : ""}`}
      style={{ ["--accent-hsl" as any]: accent }}
    >
      <RowIcon icon={Icon} hsl={accent} />
      <span className={inline ? "min-w-0 flex-1 flex items-baseline gap-x-2 flex-wrap sm:flex-nowrap" : "min-w-0 flex-1"}>
        <span className={`${inline ? "shrink-0" : "block truncate"} micro-label text-muted-foreground`}>
          {label}
          {revalidating && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary/70 animate-pulse align-middle" aria-label="Updating" />}
        </span>
        <span className={`${inline ? "min-w-0" : "block"} metric-value text-[15px] leading-tight truncate`}>{shownValue}</span>
        {shownSub != null && shownSub !== "" && (
          <span className={`flex items-center min-w-0 text-[11px] truncate ${inline ? "shrink-0" : ""} ${shownSubClass || "text-muted-foreground"}`}>{shownSub}</span>
        )}
      </span>
    </button>
  );
}

// ── Wellness tile ────────────────────────────────────────────────────────────

/** A wellness metric tile. Pressing one opens the Wellness tab's own popup for
 *  that metric — the 7-day chart with latest/average/best — rather than a
 *  second version of it built here. */
function WellTile({ icon: Icon, label, value, accent, onClick, testId, className = "" }: {
  className?: string;
  icon: LucideIcon; label: string; value: string; accent: string;
  onClick?: () => void; testId?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { onClick, type: "button" as const, "aria-label": `${label} — view detail` } : {})}
      data-testid={testId}
      className={`bubble-row flex flex-col items-center justify-center text-center px-1.5 py-1 w-full min-w-0 ${className} ${onClick ? "touch-hit" : ""}`}
      style={{ ["--accent-hsl" as any]: accent }}
    >
      <p className="text-[12px] font-bold leading-tight truncate max-w-full">
        <Icon className="inline h-3 w-3 mr-1 -mt-0.5" style={{ color: `hsl(${accent})` }} aria-hidden="true" />
        {value}
      </p>
      <p className="text-[11px] text-muted-foreground truncate max-w-full leading-tight">{label}</p>
    </Tag>
  );
}

const HABIT_ICONS: Array<[RegExp, LucideIcon]> = [
  [/workout|gym|exercise|run|lift|cardio/i, Dumbbell],
  [/water|hydrat|drink/i, Droplets],
  [/read|book/i, BookOpen],
  [/medit|mindful|breath|journal/i, Brain],
  [/food|junk|diet|eat|sugar|snack/i, Apple],
  [/vitamin|supplement|pill|med/i, PillIcon],
  [/sleep|bed/i, Moon],
  [/walk|steps|hike/i, Footprints],
];
const VITAL_ICONS: Record<string, LucideIcon> = {
  bp: HeartPulse, sys: HeartPulse, hr: HeartPulse, rhr: HeartPulse,
  weight: Scale, bmi: Scale, glucose: Droplets, chol: Droplets,
  temp: Thermometer, mood: Smile,
};
const habitIcon = (name: string): LucideIcon =>
  HABIT_ICONS.find(([re]) => re.test(name))?.[1] ?? Flame;

// Schedule dots rotate through the app's calendar palette so consecutive
// events read as distinct at a glance (matches the mock's colored dots).
const DOT_ROTATION = ["217 91% 65%", "262 70% 62%", "25 95% 58%", "155 65% 45%", "330 80% 62%"];

/** Habits listed on the Executive card before the rest fold into a "N more"
 *  link. Anything past this was previously dropped without a trace. */
const HABIT_CARD_LIMIT = 5;

/** The Executive tab is an at-a-glance view: every row is ONE line (title,
 *  then its detail in grey on the same line, then the amount), every list
 *  shows its first few rows, and "View all" carries the rest. User request
 *  2026-11-21: "make everything smaller so I don't have to scroll all the way
 *  down". Change the density here, not row by row. */
const ROW = "gap-2 px-2 py-1";
const LIST = "space-y-1";
/** Rows a card lists before its "View all (N)". */
const CARD_ROWS = 3;
/** Schedule holds two lists (today's events, dates to remember), so each
 *  shows two rows to stay level with the cards beside it. */
const EVENT_ROWS = 2;

// ─────────────────────────────────────────────────────────────────────────────

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced, ready = true, enhancedError = false, enhancedFetching = false, overviewEnd }: {
  /** Rendered at the end of the top bar (the dashboard's "⋮" menu, so it
   *  does not need a row of its own above the cards). */
  overviewEnd?: ReactNode;
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
  /** Rules 18/30: the /api/dashboard-enhanced query's isError / isFetching,
   * so the Net Worth and Cash Flow cells can show an error or revalidating
   * state instead of dots forever or a stale number presented as final. */
  enhancedError?: boolean; enhancedFetching?: boolean;
  /** Gate for this component's own queries (PERF 2026-07-16): the dashboard
   * passes bootstrapSettled so these resolve from the bootstrap-seeded cache
   * instead of firing network requests that race the bootstrap download on
   * weak mobile links. Defaults true so other callers are unaffected; the
   * dashboard's gate self-releases after 8s even if bootstrap hangs. */
  ready?: boolean;
}) {
  const hubEmbedded = useHubChrome();
  const [, navigate] = useLocation();
  // Query-safe navigation: wouter's hash navigate loses "?tab=…"/"?open=…"
  // query strings, which is exactly "the link went to the wrong place".
  const go = (path: string) => { if (path.includes("?")) hashNavigate(path); else navigate(path); };
  const { toast } = useToast();
  const [popup, setPopup] = useState<PopupKind>(null);
  // The task a tapped row asked the Tasks popup to open at (see openItem).
  const [taskFocus, setTaskFocus] = useState<{ id: string; tab: "today" | "upcoming" } | null>(null);
  // Which item's money-moving button is armed for the confirming second tap.
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // Rows the user just completed, held for the exit animation so they slide
  // out instead of blinking away when the refetch lands.
  const [leavingKeys, setLeavingKeys] = useState<Set<string>>(new Set());
  // Rows that have finished leaving. They stay out of every list on this tab
  // until the write and the refetch behind it have settled, so a completed
  // row cannot blink back in between (2026-11-22: "when I mark things done
  // they should disappear"). A failed write brings the row back.
  const [goneKeys, setGoneKeys] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const mode = filterMode;
  const ids = filterIds;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });

  // NOTE (BUG-20260715-everyone-zeros): none of these query functions may
  // swallow errors into a cached-as-success empty value (`.catch(() => [])`).
  // A transient failure — e.g. the pre-auth boot window racing token restore —
  // then renders as "0 in every category" for the whole staleTime window.
  const { data: tasksRaw = [], isPending: tasksPending, isFetching: tasksFetching, isError: tasksError } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habitsRaw = [], isPending: habitsPending, isError: habitsError } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  // [PERF 2026-07-31] Canonical shared window (shared/calendar-window.ts): the
  // same key the bootstrap seeds, the calendar page counts from and the month
  // grid renders — one cache slot instead of three cold fetches.
  const timelineWindow = useMemo(() => canonicalTimelineWindow(todayStr), [todayStr]);
  const { data: timelineRaw = [], isPending: timelinePending, isFetching: timelineFetching, isError: timelineError } = useQuery<any[]>({
    queryKey: timelineQueryKey(timelineWindow, mode, ids),
    enabled: ready,
    queryFn: () => apiRequest("GET", timelineUrl(timelineWindow, mode, ids)).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: goalsRaw = [], isPending: goalsPending, isError: goalsError } = useQuery<any[]>({
    queryKey: ["/api/goals", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/goals${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: notificationsRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/notifications", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/notifications${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Health inputs. Obligations carry `kind` and the taken-today payment ledger
  // (a medication is not an electricity bill); trackers carry the
  // server-stamped `computed` bands, the dose history AND the wellness card's
  // vitals. Both are bootstrap-seeded — no extra round-trip on the happy path.
  const { data: obligationsRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/obligations", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/obligations${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: trackersRaw = [] } = useQuery<any[]>({
    queryKey: ["/api/trackers", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/trackers${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Dismissed alerts — same store the bell and the AI's dismiss tool write.
  // One list for every shape an alert takes (hooks/useDismissedAlerts): an
  // "Expired: X" alert and X's document row are dismissed by the same id.
  const { ids: dismissedIds, dismiss: dismissAlerts } = useDismissedAlerts(ready);
  // Cash flow needs income; the key matches HubKpiStrip/HeroKPISection so the
  // three surfaces share one cache slot and agree to the dollar.
  const { data: incomesRaw } = useQuery<any>({
    queryKey: ["/api/incomes", mode, ...ids, "hero"],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/incomes${param}`).then(r => r.json()),
    staleTime: 60_000,
  });
  // Net-worth history for the overview bar's month-over-month movement.
  const { data: nwHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/net-worth/history", mode, ...ids, "exec"],
    enabled: ready,
    queryFn: () => apiRequest("GET", param
      ? `/api/net-worth/history${param}&lookbackDays=35`
      : "/api/net-worth/history?lookbackDays=35",
    ).then(r => r.json()), // Rule 29: a failure stays an error, never a cached-as-success []
    staleTime: 5 * 60_000,
  });

  // The Documents card's library view: the three most recently added
  // documents plus the total (X-Total-Count). Metadata only — the list route
  // never ships file bodies. A failure stays an error (Rule 7).
  const { data: recentDocsRes, isError: recentDocsError } = useQuery<{ rows: any[]; total: number | null }>({
    queryKey: ["/api/documents", mode, ...ids, "exec-recent"],
    enabled: ready,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/documents?limit=3${param ? `&${param.slice(1)}` : ""}`);
      const rows = await r.json();
      const total = Number(r.headers.get("X-Total-Count"));
      return { rows: Array.isArray(rows) ? rows : [], total: Number.isFinite(total) && total > 0 ? total : null };
    },
    staleTime: 60_000,
  });

  const { prefs, setPrefs } = useAttentionPrefs(ready);

  // "Hide test data" (default) — same shared detector the finance surfaces use.
  const showTestData = useShowTestData();
  const testText = (s: any): boolean => {
    if (isTestDataRow(s)) return true;
    const str = String(s || "");
    return str.includes(":") && str.split(":").slice(1).some((part: string) => isTestDataRow(part.trim()));
  };
  const isTestRow = (r: any) =>
    testText(r?.name) || testText(r?.title) || isTestDataRow(r?.description) ||
    testText(r?.message) || isTestDataRow(r?.documentName);
  const hideTest = <T,>(rows: T[]): T[] => (showTestData ? rows : (rows || []).filter(r => !isTestRow(r)));
  const tasks = hideTest(tasksRaw || []);
  const habits = hideTest(habitsRaw || []);
  // Canonical window includes pre-today rows for the calendar grid; this tab
  // is today-onward only.
  const timeline = hideTest((timelineRaw || []).filter((it: any) => String(it?.date || "").slice(0, 10) >= todayStr));
  const notifications = hideTest(Array.isArray(notificationsRaw) ? notificationsRaw : []);
  const goals = hideTest(goalsRaw || []);
  const obligations = hideTest(Array.isArray(obligationsRaw) ? obligationsRaw : []);
  const trackers = hideTest(Array.isArray(trackersRaw) ? trackersRaw : []);
  const allBills = dedupeBills(hideTest(enhanced?.financeSnapshot?.upcomingBills || []));
  const allExpiringDocs = hideTest<any>(enhanced?.expiringDocuments || []);

  // STUCK-LOADING DEADLINE (2026-07-16): if any feeding query is still
  // unresolved after 12s, show the Retry banner instead of loading forever.
  // A snapshot whose query FAILED is not "still loading" (Rule 30): the KPI
  // cells show their error state instead of dots forever.
  const anyBriefPending = tasksPending || habitsPending || timelinePending || goalsPending || (enhanced === undefined && !enhancedError);
  const [briefStuck, setBriefStuck] = useState(false);
  useEffect(() => {
    if (!anyBriefPending) { setBriefStuck(false); return; }
    const t = setTimeout(() => setBriefStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [anyBriefPending]);

  // ── AI recommendations — tap to generate, never on load ────────────────────
  // The advice lives in the query cache under a scope-keyed slot rather than
  // in component state: a mutation's onSuccess is dropped when the card
  // re-mounts mid-request (a scope flip, a skeleton swap), which left four
  // well-formed suggestions on the wire and nothing on screen (QA 2026-09-18
  // F-44). `enabled: false` keeps it off the mount path — a dashboard open must
  // never be a model call — and the button refetches on demand. A scope switch
  // changes the key, so advice computed for other data never carries over.
  const advice = useQuery<AiSuggestion[]>({
    queryKey: ["/api/dashboard/ai-suggestions", mode, ...ids, "exec"],
    enabled: false,
    retry: false,
    staleTime: Infinity,
    // The first ask may use the server's 30-minute cache (keyed on a data
    // fingerprint, so a change to the data still recomputes); "Refresh" on
    // advice already shown forces a new answer.
    queryFn: async ({ client, queryKey }) => {
      const force = client.getQueryData(queryKey) != null;
      const qs = [force ? "force=true" : "", param ? param.slice(1) : ""].filter(Boolean).join("&");
      const r = await apiRequest("GET", `/api/dashboard/ai-suggestions${qs ? `?${qs}` : ""}`);
      return normalizeAiSuggestions(await r.json());
    },
  });
  const recommendations: AiSuggestion[] | null = advice.data ?? null;
  const adviceLoading = advice.isFetching;
  const adviceError = !adviceLoading && advice.isError;
  // Advice the user swiped away this session (index into `recommendations`),
  // and the header Dismiss that clears the whole panel. Both reset on a fresh
  // ask and on a scope switch (the query key changes too, so advice computed
  // for other data never carries over).
  const [dismissedAdvice, setDismissedAdvice] = useState<Set<number>>(new Set());
  const [adviceHidden, setAdviceHidden] = useState(false);
  useEffect(() => { setDismissedAdvice(new Set()); setAdviceHidden(false); }, [mode, ids.join(",")]);
  const generateRecommendations = () => { setDismissedAdvice(new Set()); setAdviceHidden(false); void advice.refetch(); };
  // QA 2026-09-18 F-44 / BUG-06: the advice used to be routed through the
  // section router into a tenth card at the very bottom of the grid, below
  // the fold — pressing ✨ on Needs Attention visibly did nothing. The rows now
  // render directly under the Needs Attention list, where the button lives.
  const adviceRows = useMemo(() => (recommendations || [])
    .map((r, i) => ({ i, title: r.title, detail: r.body || "", action: r.action || "", priority: r.priority || "" }))
    .filter(r => r.title && !dismissedAdvice.has(r.i)), [recommendations, dismissedAdvice]);

  // ── Route every record to exactly one feed slot ────────────────────────────
  // Snoozes taken on this device before dismissals moved to the server are
  // still honoured until they lapse; nothing writes new ones from this tab.
  // Read live: the list used to be read once per document COUNT, so it went
  // stale the moment a snooze changed.
  const [docSnoozeMap] = useDocSnoozeMap();
  const snoozedDocumentIds = useMemo(() => Object.keys(docSnoozeMap), [docSnoozeMap]);
  const sectionInput = useMemo(() => ({
    today: todayStr,
    tasks, bills: allBills, documents: allExpiringDocs, habits,
    events: timeline, goals, notifications,
    dismissedNotificationIds: dismissedIds,
    snoozedDocumentIds,
    recentActivity: stats?.recentActivity || [],
    obligations, trackers,
    // BUG-06: advice renders inside the Needs Attention card (adviceRows), not
    // as a routed section — nothing to claim here.
    recommendations: [],
  }), [todayStr, tasks, allBills, allExpiringDocs, habits, timeline, goals, notifications, dismissedIds, snoozedDocumentIds, stats, obligations, trackers]);

  const sections = useMemo(
    () => {
      // A bill is information here, not a button (owner, 2026-11-22: "No
      // payment checkboxes"). Its row opens Bills & Payments, and a payment is
      // recorded on the bill's own page — the Finance tab's rule since
      // 2026-11-21. So a routed bill row never carries Pay on this tab.
      const built = buildExecutiveSections(sectionInput, prefs).map((sec) => ({
        ...sec,
        items: sec.items.map((i) => (i.kind === "bill" && i.action?.kind === "pay"
          ? { ...i, action: { kind: "open" as const, label: "Open" } } : i)),
      }));
      if (goneKeys.size === 0) return built;
      return built
        .map((sec) => ({ ...sec, items: sec.items.filter((i) => !goneKeys.has(i.key)) }))
        .filter((sec) => sec.items.length > 0);
    },
    [sectionInput, prefs, goneKeys]);
  const secItems = (id: ExecSectionId): AttentionItem[] => sections.find(s => s.id === id)?.items ?? [];

  // NEEDS ATTENTION = documents, renewals and deadlines (2026-10-21: "except
  // for bills due, I want it to be more like documents that are about to
  // expire and more important stuff"). Bills live in the Money card and
  // overdue tasks in the Tasks card, both overdue-first; what is left here is
  // what is easy to forget and costly to miss: expiring/expired documents,
  // renewals, deadlines, a goal past due, a dose not taken, a reading out of
  // range, an alert about one of those. The rule is shared/executive-attention.
  // Significant asset recommendations (Consider Selling / Replace / Dispose)
  // join the card, derived from the same lifecycle answer the asset page shows
  // and dismissed into the same server list (shared/asset-lifecycle.ts).
  const lifecycleQuery = useAssetLifecycles(ready, { mode, ids });
  const lifecycleItems = useMemo(
    () => lifecycleAttentionItems(lifecycleQuery.data?.rows || [], dismissedIds).filter((i) => !goneKeys.has(i.key)),
    [lifecycleQuery.data, dismissedIds, goneKeys]);
  const attentionItems = useMemo(
    () => selectAttentionRows(
      { immediate: secItems("immediate"), health: secItems("health"), documents: secItems("documents"), lifecycle: lifecycleItems },
      prefs.minTier,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections, prefs.minTier, lifecycleItems]);

  // UPCOMING = everything dated from tomorrow on, across every domain, soonest
  // first. Records were already claimed once by the router, so nothing here
  // can be a duplicate of another row.
  //
  // Important dates stay in this DATASET even though Schedule now previews
  // them itself (below). The list is not just a card: it is what the Upcoming
  // panel renders, and the "Next Important" KPI IS its first row — so a
  // birthday dropped from here would be a KPI that opens a panel not
  // containing the thing it names. What changes is only the card PREVIEW,
  // `upcomingPreview` below.
  const upcomingItems = useMemo(() => {
    const from: ExecSectionId[] = ["bills", "upcoming", "importantDates", "documents", "health", "today"];
    const rows = from.flatMap(id => secItems(id)).filter(i => (i.daysUntil ?? 0) >= 1);
    return rows.slice().sort((a, b) => (a.daysUntil ?? 99) - (b.daysUntil ?? 99));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  // IMPORTANT DATES = when is it actually happening?
  //
  // Requested 2026-09-22: "there should be a place in the executive tab that
  // displays all these important dates … in the schedule place … birthdays
  // etc., important days and when it's gonna happen … and when things are
  // about to expire."
  //
  // The two feeds either side of it answer different questions — Needs
  // Attention is what is ON FIRE, Documents is the INVENTORY — and neither
  // tells you a birthday is eleven days out. This is the calendar lens: every
  // dated occasion and expiration in the window, soonest first, each showing
  // its real date and how long until it.
  //
  // Today counts. A birthday you are told about tomorrow is a birthday you
  // missed.
  const importantDates = useMemo(() => {
    const rows: AttentionItem[] = [];
    const seen = new Set<string>();
    // Occasions only — birthdays, anniversaries, holidays. Expirations and
    // renewals are Needs Attention's now, so a passport isn't listed twice.
    for (const i of secItems("importantDates")) {
      if ((i.daysUntil ?? -1) < 0 || seen.has(i.key)) continue;
      seen.add(i.key);
      rows.push(i);
    }
    return rows.sort((a, b) => (a.daysUntil ?? 99) - (b.daysUntil ?? 99));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  // What the Upcoming CARD previews: everything coming up that Schedule is not
  // already showing. Rendering a birthday in both cards put two rows with one
  // `data-testid` on the screen and asked the user to read the same date
  // twice. "View all upcoming" still opens the complete list — a "view all"
  // showing more than its preview is the point of it.
  //
  // 2026-10-21: and nothing another card on this tab already shows — Needs
  // Attention's documents, the Money card's bills (Money + the Bills popup are
  // where bills live). What is left is "what else is coming": appointments,
  // events, tasks, goal deadlines.
  const upcomingPreview = useMemo(() => {
    const shown = new Set([...importantDates, ...attentionItems].map((i) => i.key));
    return upcomingItems.filter((i) => !shown.has(i.key) && i.kind !== "bill" && i.kind !== "document");
  }, [upcomingItems, importantDates, attentionItems]);

  // How the list splits, so the week you have to act on is legible without
  // reading every row's date. Mirrors the Important Dates subtitle the
  // sections engine writes (shared/executive-sections `subtitleFor`).
  // ONE TIMELINE (2026-11-22, owner: "Schedule and Upcoming occupy two large
  // cards — combine overlapping upcoming information into one useful
  // timeline"). Today's events lead the card; under them, everything coming
  // up — occasions, appointments, tasks, deadlines — in date order, each
  // shown once. Bills stay under Money and expirations under Needs Attention.
  const comingUp = useMemo(() => {
    const seen = new Set<string>();
    return [...importantDates, ...upcomingPreview]
      .filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)))
      .sort((a, b) => (a.daysUntil ?? 99) - (b.daysUntil ?? 99));
  }, [importantDates, upcomingPreview]);
  // The "Next Important" tile: today counts — a 2 pm appointment is the next
  // important thing at noon, not tomorrow's errand. The upcoming PANEL above
  // keeps tomorrow-onward, because today's rows already sit under Needs
  // attention and would otherwise render twice.
  // WHAT counts and how same-day items are ordered is one shared rule
  // (shared/next-important): something really on the calendar, never a
  // tracker's logging gap or reading by default.
  const nextImportantItem = useMemo(() => {
    const from: ExecSectionId[] = ["today", "bills", "upcoming", "importantDates", "documents", "health"];
    return pickNextImportant(from.flatMap(id => secItems(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  // Doses due now. They left Needs Attention with everything that isn't an
  // expiration (2026-11-21); the Wellness card keeps them, with "Taken".
  const dosesDue = useMemo(() => secItems("health")
    .filter((i) => (i.daysUntil ?? 0) <= 0 && i.action?.kind === "taken"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections]);

  const activityItems = useMemo(() => secItems("activity"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections]);

  // ── Overview derivations ───────────────────────────────────────────────────
  // Net worth: the server's filtered finance snapshot is the single source of
  // truth (same numbers the hub strip and Net Worth popup trust).
  const snap = enhanced?.financeSnapshot;
  const netWorth = snap != null ? (snap.totalAssetValue ?? 0) - (snap.totalLiabilities ?? 0) : null;
  // ONE month-over-month rule (shared/net-worth-change): the Finance page,
  // this card and the Net Worth popup read the same baseline, so they can no
  // longer disagree (1201.1% vs 1241.7% on the same account).
  const nwTrend = useMemo(() => {
    const c = netWorthChange(Array.isArray(nwHistory) ? nwHistory : [], netWorth, todayStr, snap?.netWorthBaseline ?? null);
    return c ? { pct: c.pct, delta: c.delta, up: c.up, monthly: c.monthly, baselineDate: c.baselineDate, label: c.label } : null;
  }, [nwHistory, netWorth, todayStr, snap?.netWorthBaseline]);

  // Cash flow — mirrors HubKpiStrip/HeroKPISection exactly: monthly income
  // minus (month expenses + monthlyized active obligations).
  const incomes: any[] = Array.isArray(incomesRaw) ? incomesRaw : incomesRaw?.items || [];
  const monthlyIncome = snap?.monthlyIncome != null
    ? Number(snap.monthlyIncome) || 0
    : sumMonthIncomeNow(incomes, null, BROWSER_TIMEZONE);
  const monthlySpendBase = snap?.totalMonthlySpend ?? stats?.monthlySpend;
  // Bills still owed, not the monthly-equivalent of bills already paid — that
  // counted every paid bill in both terms (see HubKpiStrip).
  const monthlyExpenses = monthlySpendBase != null ? monthlySpendBase + Number(snap?.unpaidBillsThisMonth ?? snap?.monthlyObligationTotal ?? 0) : null;
  const cashFlow = monthlyExpenses != null ? monthlyIncome - monthlyExpenses : null;

  // Tasks
  const goneTaskCount = (tasks || []).filter((t: any) => t.status !== "done" && goneKeys.has(`task:${t.id}`)).length;
  const pending = (tasks || []).filter((t: any) => t.status !== "done" && !goneKeys.has(`task:${t.id}`));
  const daysFromToday = (dateStr: any): number | null => {
    const t = String(dateStr || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    return Math.round((new Date(`${t}T12:00:00`).getTime() - new Date(`${todayStr}T12:00:00`).getTime()) / 86400000);
  };
  const overdueTasks = pending.filter((t: any) => (daysFromToday(t.dueDate) ?? 1) < 0);
  // The completion stamp is a UTC instant; "today" is the browser's calendar
  // day. Slicing the instant compared UTC's date with the user's, so a chore
  // finished this morning east of Greenwich (or last night in the US) read
  // as "0 completed today".
  // A task just ticked counts as done at once, with the row that left.
  const doneToday = (tasks || []).filter((t: any) => isDoneToday(t, todayStr, BROWSER_TIMEZONE)).length + goneTaskCount;
  const sortedPending = pending.slice().sort((a: any, b: any) =>
    (daysFromToday(a.dueDate) ?? 9e9) - (daysFromToday(b.dueDate) ?? 9e9));

  // Next Important — the soonest dated thing across every domain. Falls back
  // to the most urgent attention row when nothing is coming up.
  const nextImportant = nextImportantItem;

  // Schedule
  const nowClock = new Date().toTimeString().slice(0, 5);
  const eventsToday = (timeline || [])
    .filter((i: any) => i.type === "event" && String(i.date || "").slice(0, 10) === todayStr)
    .sort((a: any, b: any) => String(a.time || "99:99").localeCompare(String(b.time || "99:99")));
  const nextUp = eventsToday.filter((e: any) => e.time && String(e.time).slice(0, 5) >= nowClock)[0]
    || eventsToday.find((e: any) => !e.time);

  // Habits — scheduled-today only (shared/habit-schedule).
  //
  // Sorted on fields that a check-in NEVER touches. The card shows the first
  // few habits, so any ordering that moves with completion state (done last,
  // or the server's row order before it was pinned) makes the habit you just
  // tapped drop off the bottom — the "I marked it off and it disappeared"
  // report. Position is a property of the habit, not of today's progress.
  const habitsDueToday = (habits || [])
    .filter((h: any) => isHabitDueOn(h, todayStr))
    .sort((a: any, b: any) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || "")));
  const habitsNotScheduled = (habits || []).length - habitsDueToday.length;
  // "N / M complete today" = habits complete over habits scheduled, from the
  // ONE rollup the Habits modal reads (shared/habit-progress habitsDayRollup).
  const habitsRollup = habitsDayRollup(habitsDueToday, todayStr);
  const habitsDoneCount = habitsRollup.habitsComplete;
  // The last seven days (today included) a habit was scheduled, and how many
  // of them were kept. A day before the habit existed is not a missed day.
  const habitWeek = (h: any): { done: number; due: number } => {
    const born = String(h?.createdAt || "").slice(0, 10);
    let due = 0, done = 0;
    for (let k = 0; k < 7; k++) {
      const day = ymdMinus(todayStr, k);
      if (born && day < born) break;
      if (!isHabitDueOn(h, day)) continue;
      due++;
      if (isHabitDoneOn(h, day)) done++;
    }
    return { done, due };
  };

  // Money — THE upcoming-bills list (shared/obligation-windows): the same
  // window the Finance BILLS DUE tile and the Upcoming card show, overdue
  // first. A private 21-day filter here said "Nothing due in 3 weeks" while
  // the Finance tab counted one bill due in 27 days (F-54).
  // 2026-10-21: bills left Needs Attention, so the Money card lists the WHOLE
  // window — overdue first, in red, with the two-tap Pay — not just the
  // not-yet-due part.
  const billsDueSoon = selectUpcomingBills(allBills as any[])
    // What is coming. The server sends each bill at its next date (an elapsed
    // date is assumed paid); a payload from before that rule is held to it too.
    .filter((b: any) => (b.daysUntil ?? 0) >= 0)
    .sort((a: any, b: any) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0));
  // Upcoming and past payments, from the server (shared/bills-timeline) — the
  // panel a bill row opens, the same one the Finance tab shows.
  const billsTimeline = readBillsTimeline(enhanced?.financeSnapshot);

  // Documents
  // Grouped to ONE CARD PER RECORD PER DAY so this card, its count and the
  // popup all report the same number — a policy that expires and takes its
  // premium on one day is one thing to act on, not two.
  const visibleDocs = groupDocumentDates(
    allExpiringDocs
      // Dismissal is per RULE now that one record can carry several expirations.
      // Filtering on the record id alone left a dismissed row in this card and in
      // the count below while the popup and the executive section hid it.
      .filter((d: any) => !snoozedDocumentIds.includes(d.ruleId) && !snoozedDocumentIds.includes(d.documentId))
      // …and a dismissed date is hidden here exactly as it is in Needs
      // Attention, so "N expired" counts what that card lists.
      .filter((d: any) => !isDateRowDismissed(d, dismissedIds))
      .filter((d: any) => typeof d.daysUntil === "number"),
  ).sort((a: any, b: any) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0));
  // Expired and expiring are different states (F-57): a policy that lapsed
  // 109 days ago is not "expiring soon". The ring counts the still-valid ones
  // running out, and the caption says both numbers.
  const docsUrgency = summarizeDocumentUrgency(visibleDocs);
  const docsSoonCount = docsUrgency.expiringSoon;

  // Wellness — same extraction the Wellness tab uses, from the same trackers,
  // so a walk logged anywhere shows up on both.
  const vitals = useMemo(() => extractVitals(trackers as any), [trackers]);
  const activity = vitals.activity;
  // What the Exercise tile says, degrading honestly: minutes if a duration was
  // logged, else the distance, else the fact that a session happened. A walk
  // recorded with only a calorie field used to render "—", which read as "you
  // did nothing today" (user report 2026-08-13).
  const exerciseLabel =
    activity.minutes != null ? `${Math.round(activity.minutes)} min`
    : activity.distance != null ? `${Number(activity.distance.toFixed(activity.distance < 10 ? 1 : 0))} ${activity.distanceUnit}`
    : activity.sessions > 0 ? `${activity.sessions} session${activity.sessions === 1 ? "" : "s"}`
    : "—";
  const hasWellness = [vitals.steps.value, vitals.sleep.value, vitals.calories.value, vitals.hydration.value]
    .some(v => v != null) || activity.sessions > 0;
  // QA 2026-09-18 BUG-08: the card said "No wellness data logged yet" while
  // the Wellness tab showed four measurements — it only looked at today's
  // steps/sleep/water. Whatever readings exist (weight, blood pressure, heart
  // rate, glucose, BMI, …) are summarised here, and the copy only says
  // "nothing logged today" when that is what is true.
  const latestVitals = useMemo(() => {
    const rows: Array<{ key: string; label: string; value: string; at: string | null }> = [];
    const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
    const push = (key: string, label: string, m: { value: number | null; lastValue: number | null; unit: string; loggedAt: string | null }, unitOverride?: string) => {
      const v = m.value ?? m.lastValue;
      if (v == null) return;
      const unit = (unitOverride ?? m.unit ?? "").trim();
      rows.push({ key, label, value: unit ? `${fmt(v)} ${unit}` : fmt(v), at: m.loggedAt });
    };
    const sys = vitals.bloodPressureSys.value ?? vitals.bloodPressureSys.lastValue;
    const dia = vitals.bloodPressureDia.value ?? vitals.bloodPressureDia.lastValue;
    if (sys != null && dia != null) {
      rows.push({ key: "bp", label: "Blood pressure", value: `${fmt(sys)}/${fmt(dia)} mmHg`, at: vitals.bloodPressureSys.loggedAt });
    } else if (sys != null) push("sys", "Systolic", vitals.bloodPressureSys, "mmHg");
    push("weight", "Weight", vitals.weight, vitals.weight.unit || vitals.weightUnit);
    push("hr", "Heart rate", vitals.heartRate);
    push("rhr", "Resting HR", vitals.restingHeartRate);
    push("glucose", "Glucose", vitals.glucose);
    push("bmi", "BMI", vitals.bmi, "");
    push("chol", "Cholesterol", vitals.cholesterol);
    push("temp", "Temperature", vitals.bodyTemp);
    push("mood", "Mood", vitals.mood);
    // Newest first, so the row the user just logged leads.
    return rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  }, [vitals]);
  const wellnessTrackerCount = countWellnessTrackers(trackers as any);
  // "No wellness data logged yet" is only true before the first log ever;
  // with history and no entry TODAY the honest line is "Nothing logged today"
  // (QA 2026-09-18 F-32). Logging happens in chat or on Trackers — the
  // Wellness tab is a readout with nothing to log on it.
  const hasWellnessHistory = [vitals.steps, vitals.sleep, vitals.calories, vitals.hydration]
    .some((m) => m.lastValue != null) || activity.trackerCount > 0;
  const wellnessEmptyCopy = hasWellnessHistory
    ? "Nothing logged today — log steps, sleep or water in chat or on Trackers."
    : wellnessTrackerCount > 0
      ? `No readings logged yet — ${wellnessTrackerCount} wellness tracker${wellnessTrackerCount === 1 ? "" : "s"} set up, nothing recorded. Log steps, sleep or water in chat or on Trackers.`
      : "No wellness data yet — log steps, sleep or water in chat to start.";
  // Feeds the Wellness tab's OWN popups (no second wellness UI is built here).
  // Series come from the same trackers the tiles read, so the popup's chart and
  // the tile's number can never disagree.
  const wellnessData: WellnessPopupData = useMemo(() => ({
    wellnessScore: computeHealthScore(trackers as any),
    wellnessScoreLabel: "Today, across your trackers",
    sleepHours: vitals.sleep.value, sleepSeries: vitals.sleep.series,
    steps: vitals.steps.value, stepsSeries: vitals.steps.series,
    restingHr: vitals.restingHeartRate.value, restingHrSeries: vitals.restingHeartRate.series,
    hydrationOz: vitals.hydration.value, hydrationGoal: 100,
    calories: vitals.calories.value, caloriesGoal: 2200,
    streak: Math.max(0, ...(stats?.streaks || []).map((s: any) => s.days || 0), stats?.journalStreak || 0),
    insights: [],
    habits: habitsDueToday.map((h: any) => ({ id: h.id, name: h.name || "Habit", done: isHabitDoneOn(h, todayStr) })),
    missedHabits: habitsDueToday.filter((h: any) => !isHabitDoneOn(h, todayStr))
      .map((h: any) => ({ id: h.id, name: h.name || "Habit", done: false })),
    schedule: [], medications: [], appointments: [], reminders: [],
    labs: [], supplements: [], documents: [], conditions: [], allergies: [],
    recentActivity: [],
    // Checking in from the popup writes through the same mutation the card does.
    onToggleHabit: (id: string) => { checkinHabit.mutate(id); },
    togglingHabitId: null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [trackers, vitals, habitsDueToday, todayStr, stats]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const markBusy = (key: string, on: boolean) =>
    setBusyKeys(prev => { const next = new Set(prev); on ? next.add(key) : next.delete(key); return next; });
  const setKey = (set: Dispatch<SetStateAction<Set<string>>>, key: string, on: boolean) =>
    set(prev => { const n = new Set(prev); on ? n.add(key) : n.delete(key); return n; });
  /** Resolves once the refetches a write started have landed (bounded). */
  const refetchesSettled = () => new Promise<void>((resolve) => {
    let tries = 0;
    const tick = () => {
      if (queryClient.isFetching() === 0 || ++tries > 40) resolve();
      else setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  });
  /**
   * The row leaves ON THE TAP and stays gone: it slides out while the write is
   * in flight, is kept out of every list until the refetch has landed, and is
   * only then handed back to the data — which by now no longer contains it.
   * If the write fails the row returns (the mutation says why).
   *
   * It used to wait for the server before moving, then drop its "leaving"
   * mark after 400 ms whether or not the refetch had arrived, so a completed
   * row sat still, slid out, and blinked back.
   */
  const leavingNow = useRef(new Set<string>());
  const leaveWhile = (key: string, start: () => Promise<any>) => {
    // A second tap on a row already on its way out must not write twice.
    if (leavingNow.current.has(key)) return;
    leavingNow.current.add(key);
    setKey(setLeavingKeys, key, true);
    const out = setTimeout(() => setKey(setGoneKeys, key, true), 320);
    const back = () => {
      clearTimeout(out);
      leavingNow.current.delete(key);
      setKey(setLeavingKeys, key, false);
      setKey(setGoneKeys, key, false);
    };
    start().then(() => refetchesSettled()).then(back, back);
  };

  const payBill = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/obligations/${id}/pay`, {}); },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      // Cache bus: obligations domain also refreshes stats/cashflow/loans so
      // every linked surface updates in one shot.
      invalidateDomain("obligations");
    },
    onError: () => toast({ title: "Payment failed", variant: "destructive" }),
  });
  // A dose is recorded as an obligation payment dated today — the same write
  // the Wellness page makes, so marking it here and there cannot disagree.
  const markMedTaken = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("POST", `/api/obligations/${id}/pay`, { date: todayStr });
    },
    onSuccess: () => { toast({ title: "Dose logged" }); invalidateDomain("obligations"); },
    onError: () => toast({ title: "Couldn't log dose", variant: "destructive" }),
  });
  // Checking off ONE occurrence of a recurring date — the same tag write the
  // calendar and the Recurring Dates manager make (shared/recurring-dates).
  const markOccurrenceDone = useMutation({
    mutationFn: async (row: any) => {
      // Server-side read-modify-write: a cached tag list can be stale (Rule 7).
      await setEventOccurrence(row.sourceId, String(row?.date || "").slice(0, 10), "done");
    },
    onSuccess: () => { toast({ title: "Marked done" }); invalidateDomain("events"); },
    onError: () => toast({ title: "Couldn't mark it done", variant: "destructive" }),
  });
  const completeTask = useMutation({
    mutationFn: async (id: string) => { await apiRequest("PATCH", `/api/tasks/${id}`, { status: "done" }); },
    onSuccess: () => { toast({ title: "Task completed" }); invalidateDomain("tasks"); },
    onError: () => toast({ title: "Couldn't complete task", variant: "destructive" }),
  });
  // Checking a habit off from the dashboard goes through the same completion
  // pipeline as chat and the Habits page (server/habit-completion.ts), so it
  // also writes the linked tracker record. The ring moves optimistically —
  // waiting for a cold serverless roundtrip is what made the counter look
  // stuck — and reconciles against what the server actually recorded.
  const checkinHabit = useMutation<any, Error, string, { prev: any }>({
    mutationFn: async (id: string) => await apiRequest("POST", `/api/habits/${id}/checkin`, { date: todayStr }),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === id
          ? { ...h, checkins: [...(h.checkins || []), { id: `optimistic-${Date.now()}`, date: todayStr, timestamp: new Date().toISOString() }] }
          : h));
      return { prev };
    },
    onSuccess: (res: any) => {
      const c = res?.completion;
      if (res?.id) {
        queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
          (old || []).map((h: any) => (h.id === res.id ? { ...h, ...res } : h)));
      }
      // Say what actually happened: a day that was already finished records
      // nothing, and claiming otherwise is the "it says done but the count
      // didn't move" report in reverse.
      if (c?.alreadyComplete) {
        toast({ title: "Already done today", description: `${res?.name || "Habit"} — ${c.progress?.label ?? "complete"}` });
      } else if (c?.progress?.required > 1) {
        toast({
          title: c.progress.isComplete ? `✨ ${res?.name || "Habit"} complete!` : `${res?.name || "Habit"} — ${c.progress.completed} of ${c.progress.required}`,
          description: c.tracker ? `Logged to ${c.tracker.name} too.` : undefined,
        });
      } else {
        toast({ title: "Checked in", description: c?.tracker ? `Logged to ${c.tracker.name} too.` : undefined });
      }
      invalidateDomain("habits");
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      toast({ title: "Check-in failed", variant: "destructive" });
    },
  });
  /**
   * Dismiss = "I know; stop showing me this". Stored on the server under the
   * alert's id (shared/alert-ids), so the row is gone on every device and in
   * both of its shapes, and stays gone until it is restored from the
   * Dismissed list or its date changes. The record is not touched.
   */
  const dismissIds = (ids: string[]) => {
    if (ids.length === 0) return;
    dismissAlerts.mutate(ids, {
      onSuccess: () => toast({ title: "Dismissed", description: "Restore it any time from the Dismissed list in this card's filters." }),
    });
  };

  const idOf = (item: AttentionItem) => item.sourceKey.split(":").slice(1).join(":");

  const onAction = (item: AttentionItem) => {
    const kind = item.action?.kind;
    if (!kind || kind === "open") { navigate(item.href); return; }
    const key = item.key;
    const run = (start: () => Promise<any>) => leaveWhile(key, start);
    switch (kind) {
      case "pay":
        // Money moves once. First tap arms, second commits; the arm lapses so
        // a stray tap can't sit primed on screen.
        if (armedKey !== key) {
          setArmedKey(key);
          setTimeout(() => setArmedKey(k => (k === key ? null : k)), 4000);
          return;
        }
        setArmedKey(null);
        run(() => payBill.mutateAsync(idOf(item)));
        return;
      case "complete": run(() => completeTask.mutateAsync(idOf(item))); return;
      // No two-tap arming: logging a dose is trivially undone from Wellness,
      // unlike `pay`, which moves money.
      case "taken": run(() => markMedTaken.mutateAsync(idOf(item))); return;
      case "markdone": {
        // The row carries no tags of its own — look the occurrence back up in
        // the timeline by the id the item key was built from.
        const rowId = item.key.replace(/^event:/, "");
        const row = (Array.isArray(timelineRaw) ? timelineRaw : []).find((r: any) => r?.id === rowId);
        if (!row) { navigate(item.href); return; }
        run(() => markOccurrenceDone.mutateAsync(row));
        return;
      }
      case "checkin": run(() => checkinHabit.mutateAsync(idOf(item))); return;
      case "dismiss":
        // The dismissed list is written on the tap (useDismissedAlerts), so
        // the row is already gone from the data — nothing to hold out.
        dismissIds([item.key.replace(/^alert:/, "")]);
        return;
      default:
        navigate(item.href);
    }
  };
  // A tapped row EXPANDS here, in that category's canonical popup — a task row
  // opens Tasks, a bill row opens Bills, an event row opens the Calendar
  // popup. The label pressed always matches the panel that opens.
  //
  // The fallthrough navigates because those kinds have no popup of their own
  // and their record genuinely lives elsewhere: a medication reminder belongs
  // to its tracker, a goal to the Goals page. Those go query-safely to the
  // record itself, never to a generic page.
  const openItem = (item: AttentionItem) => {
    switch (item.kind) {
      case "task":
        // Land on THIS task: the tab it is listed under, expanded. Opening on
        // Today showed a list a task due Friday isn't in.
        setTaskFocus({ id: idOf(item), tab: (item.daysUntil ?? 0) > 0 ? "upcoming" : "today" });
        setPopup("tasks");
        return;
      case "habit": setPopup("habits"); return;
      case "bill": setPopup("bills"); return;
      case "event": setPopup("events"); return;
      case "document": setPopup("docs"); return;
      default: go(item.href);
    }
  };

  // ── Cards with nothing to show fold away ────────────────────────────────────
  // 2026-11-22 (owner): "Empty cards consume considerable space — collapse
  // empty sections automatically." A card whose list is empty no longer holds
  // half a row to say so: it is named in one compact row under the grid
  // (`exec-quiet-cards`), and a tap opens it in place — so nothing becomes
  // unreachable and the row still says a profile filter may be why (Rule 4).
  // Needs Attention, Money and Documents always render: they carry controls
  // (filters, the Dismissed list) or figures that are never "empty".
  const [openedCards, setOpenedCards] = useState<Set<string>>(new Set());
  const QUIET_CARDS: Array<{ id: string; title: string; icon: LucideIcon; accent: string; empty: boolean; note: string }> = [
    { id: "tasks", title: "Tasks", icon: CheckSquare, accent: CARD_ACCENTS.tasks, note: "no open tasks",
      empty: !tasksPending && !tasksError && sortedPending.length === 0 && doneToday === 0 },
    { id: "schedule", title: "Timeline", icon: CalendarDays, accent: CARD_ACCENTS.schedule, note: "nothing today or coming up",
      empty: !timelinePending && eventsToday.length === 0 && comingUp.length === 0 },
    { id: "habits", title: "Habits", icon: Flame, accent: CARD_ACCENTS.habits, note: "none scheduled today",
      empty: habitsDueToday.length === 0 },
    { id: "wellness", title: "Wellness", icon: Heart, accent: CARD_ACCENTS.wellness, note: "no readings",
      empty: !hasWellness && latestVitals.length === 0 && dosesDue.length === 0 },
    { id: "activity", title: "Recent Activity", icon: History, accent: CARD_ACCENTS.activity, note: "nothing recent",
      empty: activityItems.length === 0 },
  ];
  // The user's own choice of cards and order (Customize; shared/exec-card-prefs).
  const { prefs: cardPrefs, boards: execBoards, setBoards: setExecBoards, loaded: cardPrefsLoaded } = useExecCardPrefs(ready);
  const cardSize = (id: string): ExecCardSize | null => cardPrefs.sizes[id] ?? null;
  const cardOn = (id: string) => isExecCardVisible(cardPrefs, id as ExecCardId) || openedCards.has(id);
  const cardPos = (id: string) => execCardPosition(cardPrefs, id as ExecCardId);
  // Cards the preferences keep off screen. Named under the grid, each one tap
  // from showing, so a hidden card never reads as a missing one (Rule 4).
  const hiddenCards = hiddenExecCards(cardPrefs).filter((id) => !openedCards.has(id));
  const quietCards = QUIET_CARDS.filter((c) => cardOn(c.id) && c.empty && !openedCards.has(c.id));
  const showCard = (id: string) => cardOn(id) && !quietCards.some((c) => c.id === id);
  // Which medium cards have nobody beside them on a phone, given what is
  // actually on screen and in what order.
  const lonelyCards = lonelyMediumCards(
    orderedExecCards(cardPrefs).filter((id) => showCard(id)).map((id) => ({ id, size: execCardSize(cardPrefs, id) })));
  const cardFill = (id: string) => lonelyCards.has(id);

  // Hold the skeleton grid until the enhanced snapshot has landed too: with
  // tasks in and the snapshot still in flight the grid rendered a run of
  // cards with nothing in them, which read as blank space for the 4–7s the
  // snapshot takes (QA 2026-09-18, F-63). The stuck banner above still takes
  // over at 12s, so this can never be the permanent state.
  const feedLoading = (anyBriefPending && (sections.length === 0 || (enhanced === undefined && !briefStuck)))
    // …and until the user's own card choice is known, so a saved layout is
    // never preceded by a flash of the default one.
    || (!cardPrefsLoaded && !briefStuck);
  const loadingDots = "…";

  // Overview bar strings
  const nwValue = netWorth == null ? loadingDots : `${netWorth < 0 ? "-" : ""}${fmtUSD(Math.abs(netWorth))}`;
  // A delta measured from a snapshot younger than 30 days is not "this
  // month" — it is labelled by the day it is measured from (F-10).
  // The move renders as the app's shared DeltaChip (the same chip the Finance
  // and tracker screens use) rather than a hand-typed arrow; a dollar-only
  // delta (no percentage baseline) keeps a plain signed amount.
  const nwSub: ReactNode = nwTrend
    // QA 2026-09-18: a history that began this month is not a month of growth
    // — the shared rule labels it "since Sep 3" / "since first entry".
    ? (nwTrend.pct == null && nwTrend.delta == null
      ? "no change yet"
      : nwTrend.pct != null
        ? <DeltaChip
            pct={Number((nwTrend.up ? Math.abs(nwTrend.pct) : -Math.abs(nwTrend.pct)).toFixed(1))}
            good={nwTrend.up}
            label={nwTrend.label} />
        : `${nwTrend.up ? "+" : "-"}${fmtUSD(Math.abs(nwTrend.delta ?? 0))} ${nwTrend.label}`)
    : "this month";
  const cfValue = cashFlow == null ? loadingDots : `${cashFlow >= 0 ? "+" : "-"}${fmtUSD(Math.abs(cashFlow))}`;
  const nextDate = nextImportant?.daysUntil != null ? dateFromDays(nextImportant.daysUntil) : null;

  return (
    <div data-testid="executive-briefing">
      {/* STUCK-LOADING BANNER (2026-07-16): a card must never say "loading"
          forever. If any feeding query is still unresolved after 12s, surface
          a Retry that cancels wedged requests and refetches what's on screen. */}
      {briefStuck && (
        <div className="bubble-row mb-2 flex items-center justify-between gap-2 px-3 py-2" data-testid="brief-stuck-banner">
          <span className="text-xs text-muted-foreground">Some sections are taking too long to load.</span>
          <button
            className="text-xs font-medium text-primary hover:underline shrink-0"
            onClick={() => { setBriefStuck(false); void recoverWedgedQueries(); }}
            data-testid="brief-stuck-retry"
          >Retry</button>
        </div>
      )}

      {/* ── Overview bar ─────────────────────────────────────────────────── */}
      {/* Under the hub shell the KPI strip already shows Net Worth, Cash Flow
          and Tasks; repeating them here spent a third of the viewport on the
          same three numbers. Embedded, this bar keeps only what the strip
          does not carry — the next important item. */}
      <div
        className="bubble bubble-enter mb-2 p-1.5 flex items-center gap-1.5"
        style={{ ["--accent-hsl" as any]: "240 5% 55%", ["--i" as any]: 0 }}
      >
      <div
        className={`flex-1 min-w-0 grid gap-1.5 ${hubEmbedded ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-4"}`}
        data-testid="exec-overview"
      >
        {!hubEmbedded && <OverviewCell
          icon={netWorth != null && netWorth < 0 ? TrendingDown : TrendingUp}
          accent="155 65% 45%"
          label="Net Worth"
          value={nwValue}
          sub={netWorth == null ? undefined : nwSub}
          subClass={nwTrend && nwTrend.pct == null && nwTrend.delta != null ? (nwTrend.up ? "text-emerald-500" : "text-red-500") : undefined}
          onClick={() => setPopup("networth")}
          testId="exec-kpi-networth"
          error={enhancedError && snap == null}
          revalidating={enhancedFetching && snap != null}
        />}
        {!hubEmbedded && <OverviewCell
          icon={CircleDollarSign}
          accent={cashFlow != null && cashFlow < 0 ? "0 72% 58%" : "155 65% 45%"}
          label="Cash Flow"
          value={cfValue}
          sub={cashFlow == null ? undefined : "this month"}
          onClick={() => setPopup("cashflow")}
          testId="exec-kpi-cashflow"
          error={enhancedError && snap == null}
          revalidating={enhancedFetching && snap != null}
        />}
        {!hubEmbedded && <OverviewCell
          icon={CheckSquare}
          accent={CARD_ACCENTS.tasks}
          label="Tasks Remaining"
          value={tasksError ? "—" : tasksPending ? loadingDots : String(pending.length)}
          sub={tasksPending ? undefined : overdueTasks.length > 0 ? `${overdueTasks.length} overdue` : "none overdue"}
          subClass={overdueTasks.length > 0 ? "text-red-500" : undefined}
          onClick={() => setPopup("tasks")}
          testId="exec-kpi-tasks"
          error={tasksError}
          revalidating={tasksFetching && !tasksPending}
        />}
        <OverviewCell
          icon={CalendarDays}
          accent={CARD_ACCENTS.schedule}
          label="Next Important"
          value={nextImportant ? nextImportant.title : anyBriefPending ? loadingDots : "Nothing coming up"}
          sub={nextImportant && nextDate
            ? `${fmtWeekdayDate(nextDate)} (${inDaysLabel(nextImportant.daysUntil!)})`
            : undefined}
          // The important-dates list, NOT the Bills panel — this KPI is the
          // first row of Upcoming, so that list is where its record lives.
          // …except an item dated TODAY: Upcoming lists tomorrow onward, so
          // the tile used to open a panel its own item was not in. That item
          // opens where it lives.
          onClick={() => (nextImportant && nextImportant.daysUntil === 0 ? openItem(nextImportant) : setPopup("upcoming"))}
          testId="exec-kpi-next"
          inline={hubEmbedded}
          error={timelineError && !nextImportant}
          revalidating={timelineFetching && !timelinePending}
        />
      </div>
      {overviewEnd}
      </div>

      {/* Which dashboard is showing (shared/exec-dashboards). Only a switch:
          building and arranging dashboards is the ⋮ menu's Customize. The
          choice is the user's own action and is saved to the account. */}
      {!feedLoading && execBoards.dashboards.length > 1 && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-0.5 -mt-0.5" role="tablist" aria-label="Dashboards" data-testid="exec-dashboards">
          {execBoards.dashboards.map((d) => {
            const on = d.id === execBoards.active;
            return (
              <button key={d.id} type="button" role="tab" aria-selected={on}
                onClick={() => {
                  if (on) return;
                  setOpenedCards(new Set());
                  setExecBoards(setActiveDashboard(execBoards, d.id)).catch(() => toast({ title: "Couldn't switch dashboards", variant: "destructive" }));
                }}
                data-testid={`exec-dashboard-${d.id}`}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${on ? "text-white" : "border border-border text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                style={on ? { background: `hsl(${CARD_ACCENTS.custom} / 0.35)`, boxShadow: `inset 0 0 0 1px hsl(${CARD_ACCENTS.custom} / 0.7)` } : undefined}>
                {d.name}
              </button>
            );
          })}
        </div>
      )}

      {feedLoading ? (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2" data-testid="exec-cards-loading" aria-label="Loading dashboard">
          {[0, 1, 2, 3, 4, 5].map((i) => <BubbleSkeleton key={i} rows={2} height={120} index={i} />)}
        </div>
      ) : (
        <>
          {/* exec-grid: rows stretch so both cards in a row are the same
              height, and a trailing odd card spans the full width — no blank
              cell, no black gap under a short card (index.css). */}
          <div className="exec-grid grid grid-cols-2 xl:grid-cols-3 min-[1800px]:grid-cols-4 gap-2">

            {/* ── Needs Attention ──────────────────────────────────────────── */}
            {showCard("attention") && <ExecCard
              id="attention" pos={cardPos("attention")} size={cardSize("attention")} fill={cardFill("attention")} icon={TriangleAlert} title="Needs Attention"
              accent={CARD_ACCENTS.attention} index={1} order={1} shortTitle="Attention"
              // A medium card: it shares a phone row with whatever medium card
              // follows it, and takes the whole row when none does (`fill`).
              count={attentionItems.length}
              subtitle="Upcoming expirations and important dates."
              headerRight={
                <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
                  {/* Advice costs a model call, so it stays a deliberate tap. */}
                  <button
                    onClick={generateRecommendations}
                    disabled={adviceLoading}
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-border h-6 min-w-6 px-1 sm:h-[26px] sm:px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
                    data-testid="exec-recommendations-generate"
                    aria-label="Generate AI advice"
                    title={recommendations ? "Refresh AI advice" : "AI advice"}
                  >
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    {adviceLoading ? "…" : <span className="sr-only">AI advice</span>}
                  </button>
                  <button
                    onClick={() => setFiltersOpen(o => !o)}
                    className="inline-flex items-center justify-center rounded-md border border-border h-6 w-6 sm:h-[26px] sm:w-[26px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    data-testid="attention-filters-toggle"
                    aria-expanded={filtersOpen}
                    aria-label="Attention filters"
                  >
                    <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              }
            >
              {/* What this card covers (bills are under Money, tasks under
                  Tasks). Read out and kept in the DOM; not a visible line —
                  the at-a-glance cards have no room for captions. */}
              <p className="sr-only" data-testid="exec-attention-scope">Expirations &amp; renewals</p>
              {filtersOpen && <div className="mb-2"><AttentionFilters prefs={prefs} onChange={setPrefs}
                medications={trackers.filter((t: any) => t?.id && isMedicationTracker(t)).map((t: any) => ({ id: String(t.id), name: String(t.name || "Medication") }))} /></div>}
              {filtersOpen && <div className="mb-2"><DismissedAlertsList /></div>}
              {/* AI advice renders HERE, next to the button that asked for it —
                  not in a separate card at the foot of the grid, where a user
                  watching this card never saw it arrive (F-44 / BUG-06). */}
              {(adviceLoading || adviceError || (recommendations && !adviceHidden)) && (
                <div className="mb-3 rounded-2xl px-2.5 py-2.5"
                  style={{ ["--accent-hsl" as any]: CARD_ACCENTS.recommendations, background: `hsl(${CARD_ACCENTS.recommendations} / 0.08)` }}
                  data-testid="exec-card-recommendations" aria-live="polite">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5" style={{ color: `hsl(${CARD_ACCENTS.recommendations})` }} aria-hidden="true" />
                      <span className="micro-label" style={{ color: `hsl(${CARD_ACCENTS.recommendations})` }}>
                        AI advice
                      </span>
                    </div>
                    {!adviceLoading && !adviceError && recommendations && (
                      <button type="button"
                        onClick={() => setAdviceHidden(true)}
                        className="text-[11px] text-muted-foreground hover:text-foreground"
                        data-testid="exec-recommendations-dismiss-all"
                        aria-label="Dismiss AI advice">
                        Dismiss
                      </button>
                    )}
                  </div>
                  {adviceLoading ? (
                    <p className="text-[12px] text-muted-foreground flex items-center gap-2" data-testid="exec-recommendations-loading">
                      <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden="true" />
                      Generating advice…
                    </p>
                  ) : adviceError ? (
                    <p className="text-[12px] text-destructive flex items-center justify-between gap-2" data-testid="exec-recommendations-error">
                      <span>Couldn't generate advice.</span>
                      <button type="button" onClick={generateRecommendations} className="underline font-medium">Retry</button>
                    </p>
                  ) : adviceRows.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground" data-testid="exec-recommendations-empty">
                      {recommendations && recommendations.length > 0
                        ? "Every suggestion dismissed."
                        : "Nothing to suggest yet — add a little more data and try again."}
                    </p>
                  ) : (
                    <div className="space-y-1.5" data-testid="exec-recommendations">
                      {adviceRows.map((r) => (
                        <div key={r.i} className="bubble-row px-2.5 py-2 flex items-start gap-2"
                          data-testid={`exec-recommendation-${r.i}`}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <p className="text-[13px] font-semibold leading-tight truncate">{r.title}</p>
                              {r.priority && (
                                <span className={`shrink-0 rounded-full px-1.5 py-px micro-label ${
                                  r.priority === "high" ? "bg-red-500/15 text-red-600 dark:text-red-400"
                                  : r.priority === "medium" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                  : "bg-muted text-muted-foreground"}`}>
                                  {r.priority}
                                </span>
                              )}
                            </div>
                            {r.detail && <p className="text-[11px] text-muted-foreground mt-0.5">{r.detail}</p>}
                            {r.action && <p className="text-[11px] mt-0.5" style={{ color: `hsl(${CARD_ACCENTS.recommendations})` }}>{r.action}</p>}
                          </div>
                          <button type="button"
                            onClick={() => setDismissedAdvice(prev => new Set(prev).add(r.i))}
                            className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted"
                            aria-label={`Dismiss suggestion: ${r.title}`}
                            data-testid={`exec-recommendation-dismiss-${r.i}`}>
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {attentionItems.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-1 text-center" data-testid="exec-attention-clear">
                  <p className="text-[13px] font-bold">
                    <PartyPopper className="inline h-4 w-4 mr-1.5 -mt-0.5" style={{ color: "hsl(155 60% 45%)" }} aria-hidden="true" />
                    You're all caught up
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Nothing expiring — documents and renewals look good.
                  </p>
                </div>
              ) : (
                <div className={LIST}>
                  {/* Expirations only, soonest first; each row's date pill is
                      coloured by how close it is (red: expired or this week). */}
                  <ExpandableRows id="attention" count={attentionItems.length} cap={CARD_ROWS}
                    moreLabel={`View all ${attentionItems.length} items`}>
                    {attentionItems.map((i) => (
                      <ItemRow key={i.key} item={i} stacked
                        busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                        onAction={onAction} onOpen={openItem}
                        onDismiss={(it) => dismissIds(it.dismissIds || [])} />
                    ))}
                  </ExpandableRows>
                </div>
              )}
            </ExecCard>}

            {/* ── Tasks ────────────────────────────────────────────────────── */}
            {showCard("tasks") && <ExecCard
              id="tasks" pos={cardPos("tasks")} size={cardSize("tasks")} fill={cardFill("tasks")} icon={CheckSquare} title="Tasks"
              accent={CARD_ACCENTS.tasks} index={2} order={2}
              headerRight={<ViewLink label="View all tasks" accent={CARD_ACCENTS.tasks} onClick={() => go("/dashboard/tasks")} testId="exec-view-tasks" />}
            >
              <div className="grid grid-cols-3 divide-x divide-border/60 mb-2 text-center" data-testid="exec-tasks-stats">
                {([
                  { key: "remaining", n: pending.length, label: "Remaining", short: "Left", hsl: CARD_ACCENTS.tasks },
                  { key: "overdue", n: overdueTasks.length, label: "Overdue", short: "Overdue", hsl: "0 72% 58%" },
                  { key: "done", n: doneToday, label: "Completed today", short: "Done", hsl: "155 65% 45%" },
                ] as const).map((c) => (
                  <div key={c.key} className="min-w-0 px-1">
                    <span className="block metric-value text-lg sm:text-xl leading-tight tabular-nums" style={{ color: `hsl(${c.hsl})` }}>{c.n}</span>
                    <span className="block text-[11px] text-muted-foreground truncate">
                      <span className="exec-long">{c.label}</span><span className="exec-short" aria-hidden="true">{c.short}</span>
                    </span>
                  </div>
                ))}
              </div>
              {sortedPending.length === 0 ? (
                <CardEmpty icon={CheckCircle2} accent={CARD_ACCENTS.tasks} tone={doneToday > 0 ? "good" : undefined}>{doneToday > 0 ? "Everything done — nice work." : "No open tasks."}</CardEmpty>
              ) : (
                <div className={LIST}>
                  {sortedPending.slice(0, CARD_ROWS).map((t: any) => {
                    const du = daysFromToday(t.dueDate);
                    const busy = busyKeys.has(`task:${t.id}`);
                    const sub = du == null ? "No due date"
                      : du < 0 ? `Overdue · Due ${fmtShortDate(dateFromDays(du))}`
                      : du === 0 ? "Due today"
                      : `Due ${fmtShortDate(dateFromDays(du))}`;
                    return (
                      <div key={t.id}
                        className={`bubble-row flex items-center ${ROW} ${leavingKeys.has(`task:${t.id}`) ? "row-leaving" : ""}`}
                        style={{ ["--accent-hsl" as any]: CARD_ACCENTS.tasks }}
                      >
                        <button
                          onClick={() => leaveWhile(`task:${t.id}`, () => completeTask.mutateAsync(t.id))}
                          disabled={busy}
                          className={`h-[18px] w-[18px] rounded-full border-2 shrink-0 transition-colors hover:border-emerald-500 ${busy ? "animate-pulse border-emerald-500" : "border-muted-foreground/50"}`}
                          aria-label={`Complete ${t.title}`}
                          data-testid={`exec-task-complete-${t.id}`}
                        />
                        <div className="flex-1 min-w-0 flex items-center gap-2 cursor-pointer" title={`${t.title} — ${sub}`} onClick={() => { setTaskFocus({ id: t.id, tab: du != null && du > 0 ? "upcoming" : "today" }); setPopup("tasks"); }}>
                          <p className="text-[13px] font-semibold leading-tight truncate flex-1 min-w-0">{t.title}</p>
                          <p className={`text-[11px] font-semibold truncate shrink-0 max-w-[50%] ${du != null && du < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                            <span className="exec-long">{sub}</span>
                            {/* A phone's half card: just the day (red when overdue). */}
                            <span className="exec-short" aria-hidden="true">{du == null ? "" : du === 0 ? "Today" : fmtShortDate(dateFromDays(du))}</span>
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  {sortedPending.length > CARD_ROWS && (
                    <FooterLink onClick={() => setPopup("tasks")} testId="exec-tasks-more">
                      View {sortedPending.length - CARD_ROWS} more task{sortedPending.length - CARD_ROWS === 1 ? "" : "s"}
                    </FooterLink>
                  )}
                </div>
              )}
            </ExecCard>}

            {/* ── Schedule ─────────────────────────────────────────────────── */}
            {showCard("schedule") && <ExecCard
              id="schedule" pos={cardPos("schedule")} size={cardSize("schedule")} fill={cardFill("schedule")} icon={CalendarDays} title="Timeline"
              accent={CARD_ACCENTS.schedule} index={3} order={3} wide
              subtitle={<>Today · {fmtWeekdayDate(new Date())}{nextUp ? <span className="exec-opt"> · Next up <span className="font-semibold" style={{ color: `hsl(${CARD_ACCENTS.schedule})` }}>{nextUp.title}</span></span> : null}</>}
              headerRight={<ViewLink label="View schedule" accent={CARD_ACCENTS.schedule} onClick={() => setPopup("events")} testId="exec-view-calendar" />}
            >
              {eventsToday.length === 0 ? (
                // One empty state per card: when "Coming up" below is empty
                // too, its message covers both.
                comingUp.length > 0 && (
                  <p className="text-[12px] text-muted-foreground mb-1.5" data-testid="exec-schedule-empty">Nothing scheduled today.</p>
                )
              ) : (
                <div className={LIST}>
                  {eventsToday.slice(0, EVENT_ROWS).map((e: any, idx: number) => {
                    const past = !!e.time && String(e.time).slice(0, 5) < nowClock;
                    const dot = DOT_ROTATION[idx % DOT_ROTATION.length];
                    const start = e.allDay || !e.time ? "All day" : timeLabel12h(e.time);
                    const end = e.allDay ? "" : clockLabel(e.endTime);
                    return (
                      <div key={e.id}
                        role="button" tabIndex={0}
                        onClick={() => setPopup("events")}
                        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setPopup("events"); } }}
                        className={`flex items-stretch gap-2 cursor-pointer ${past ? "opacity-60" : ""}`}
                        data-testid={`exec-event-${e.id}`}
                      >
                        {/* Start over end, beside the event — the reference's time column. */}
                        <span className="exec-time w-[52px] shrink-0 flex flex-col justify-center text-[11px] tabular-nums leading-tight">
                          <span className="font-semibold text-foreground/90">{start}</span>
                          {end && <span className="text-muted-foreground">{end}</span>}
                        </span>
                        <span className="bubble-row flex-1 min-w-0 flex items-center gap-2 pl-0 pr-2 py-1.5 overflow-hidden"
                          style={{ ["--accent-hsl" as any]: dot }}>
                          <span className="self-stretch w-1 rounded-full shrink-0" style={{ background: `hsl(${dot})` }} aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold leading-tight truncate">{e.title}</span>
                            {e.location && <span className="block text-[11px] text-muted-foreground leading-tight truncate mt-0.5">{e.location}</span>}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                  {eventsToday.length > EVENT_ROWS && (
                    <FooterLink onClick={() => setPopup("events")} testId="exec-events-more">
                      {eventsToday.length - EVENT_ROWS} more today
                    </FooterLink>
                  )}
                </div>
              )}

              {/* ── Coming up ───────────────────────────────────────────────
                  What used to be two blocks in two cards ("Dates to remember"
                  here, the Upcoming card beside it), merged and in date order. */}
              <div className={eventsToday.length > 0 ? "mt-1.5 pt-1.5 border-t border-border/60" : ""} data-testid="exec-timeline-coming">
                <div className="flex items-center justify-between gap-2">
                  <p className="micro-label text-muted-foreground">Coming up</p>
                  <ViewLink
                    label="View all upcoming"
                    accent={CARD_ACCENTS.schedule}
                    onClick={() => setPopup("upcoming")}
                    testId="exec-view-upcoming"
                  />
                </div>
                {comingUp.length === 0 ? (
                  <CardEmpty icon={CalendarDays} accent={CARD_ACCENTS.schedule}>
                    {eventsToday.length === 0
                      ? "Your day is clear, and nothing is coming up in the next 30 days."
                      : "Nothing else coming up in the next 30 days."}
                  </CardEmpty>
                ) : (
                  <div className={`${LIST} mt-1`}>
                    <ExpandableRows id="timeline" count={comingUp.length} cap={CARD_ROWS + 1}>
                      {comingUp.map((i) => (
                        <ItemRow key={i.key} item={i} stacked pill={false}
                          sub={i.daysUntil != null ? `${capitalize(inDaysLabel(i.daysUntil))} · ${fmtShortDate(dateFromDays(i.daysUntil))}` : i.reason}
                          busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                          onAction={onAction} onOpen={openItem} />
                      ))}
                    </ExpandableRows>
                  </div>
                )}
              </div>
            </ExecCard>}

            {/* ── Habits ───────────────────────────────────────────────────── */}
            {showCard("habits") && <ExecCard
              id="habits" pos={cardPos("habits")} size={cardSize("habits")} fill={cardFill("habits")} icon={Flame} title="Habits"
              accent={CARD_ACCENTS.habits} index={5} order={5} wide
              subtitle={habitsDueToday.length > 0
                ? `Today · ${habitsDoneCount} of ${habitsDueToday.length} done${habitsNotScheduled > 0 ? ` · ${habitsNotScheduled} not scheduled` : ""}`
                : undefined}
              headerRight={<ViewLink label="View habits" accent={CARD_ACCENTS.habits} onClick={() => setPopup("habits")} testId="exec-view-habits" />}
            >
              {habitsDueToday.length === 0 ? (
                <CardEmpty icon={Flame} accent={CARD_ACCENTS.habits}>No habits scheduled today.</CardEmpty>
              ) : (
                <>
                  {/* One tile per habit (the reference's row of check circles):
                      ticked when today is done, and how many of the last seven
                      scheduled days were kept. Tapping checks today in. */}
                  <div className="grid grid-cols-5 gap-1.5" data-testid="exec-habit-tiles">
                    {habitsDueToday.slice(0, HABIT_CARD_LIMIT).map((h: any) => {
                      const hp = habitDayProgress(h, todayStr);
                      const done = isHabitDoneOn(h, todayStr);
                      const busy = busyKeys.has(`habit:${h.id}`);
                      const wk = habitWeek(h);
                      return (
                        <button key={h.id}
                          onClick={() => {
                            if (done) { setPopup("habits"); return; }
                            markBusy(`habit:${h.id}`, true);
                            checkinHabit.mutateAsync(h.id).catch(() => {}).finally(() => markBusy(`habit:${h.id}`, false));
                          }}
                          disabled={busy}
                          className="bubble-row w-full min-w-0 flex flex-col items-center text-center gap-1 px-1 py-2 disabled:opacity-60"
                          style={{ ["--accent-hsl" as any]: CARD_ACCENTS.habits }}
                          data-testid={`exec-habit-checkin-${h.id}`}
                          aria-label={done ? `${h.name} — done today` : `Check in ${h.name}`}
                          title={`${h.name} — ${wk.done} of ${wk.due} scheduled days this week`}
                        >
                          {done ? (
                            <CheckCircle2 className="h-6 w-6" style={{ color: "hsl(155 65% 45%)" }} aria-label="Done" />
                          ) : (
                            <span className={`h-6 w-6 rounded-full border-2 ${busy ? "animate-pulse border-emerald-500" : "border-muted-foreground/50"}`} aria-hidden="true" />
                          )}
                          <span className="w-full text-[12px] font-semibold leading-tight truncate">{h.name}</span>
                          <span className="text-[11px] text-muted-foreground tabular-nums leading-tight">
                            {hp.required > 1 && !done ? `${hp.completed}/${hp.required} today` : `${wk.done} / ${wk.due} days`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {habitsDueToday.length > HABIT_CARD_LIMIT && (
                    <FooterLink onClick={() => setPopup("habits")} testId="exec-habits-more">
                      {habitsDueToday.length - HABIT_CARD_LIMIT} more habit{habitsDueToday.length - HABIT_CARD_LIMIT === 1 ? "" : "s"} today
                    </FooterLink>
                  )}
                </>
              )}
            </ExecCard>}

            {/* ── Money ────────────────────────────────────────────────────── */}
            {showCard("money") && <ExecCard
              id="money" pos={cardPos("money")} size={cardSize("money")} fill={cardFill("money")} icon={DollarSign} title="Money"
              accent={CARD_ACCENTS.money} index={4} order={4} wide
              // Explicit navigation, and labelled as such: Finance is a tab,
              // not an expansion of this card.
              headerRight={<ViewLink label="Open finances" accent={CARD_ACCENTS.money} onClick={() => go("/dashboard/finance")} testId="exec-view-finances" />}
            >
              {/* Two stacked lists of the tab's one row style. Side-by-side
                  columns left ~165px per column at phone width — too narrow
                  for an icon, a label and an amount. */}
              {/* What you own, what you owe, what is left (2026-11-22, owner:
                  "Money only shows income, expenses and negative cash flow —
                  show financial position"). The server's snapshot totals, the
                  same ones the Net Worth panel opens with (Rule 1). */}
              <div className="grid grid-cols-3 gap-1.5 mb-1.5" data-testid="exec-money-position">
                {([
                  { key: "assets", label: "Assets", sub: "What you own",
                    value: snap == null ? loadingDots : fmtUSD(snap.totalAssetValue ?? 0), hsl: "155 65% 45%", cls: "" },
                  { key: "debt", label: "Debt", sub: "What you owe",
                    value: snap == null ? loadingDots : fmtUSD(snap.totalLiabilities ?? 0), hsl: "0 72% 58%", cls: "" },
                  { key: "networth", label: "Net worth", sub: "Assets minus debt",
                    value: netWorth == null ? loadingDots : fmtUSD(netWorth), hsl: CARD_ACCENTS.money,
                    cls: netWorth != null && netWorth < 0 ? "text-red-500" : "" },
                ] as const).map((r) => (
                  <button key={r.key} type="button" onClick={() => setPopup("networth")}
                    className="exec-tile bubble-row px-2 py-1 min-w-0 text-left" title={r.sub}
                    style={{ ["--accent-hsl" as any]: r.hsl }} data-testid={`exec-money-${r.key}`}>
                    <p className="micro-label text-muted-foreground truncate">{r.label}</p>
                    <p className={`text-[13px] font-bold tabular-nums truncate ${r.cls}`}>{r.value}</p>
                  </button>
                ))}
              </div>
              <p className="micro-label text-muted-foreground mb-1">This month</p>
              <div className="grid grid-cols-3 gap-1.5" data-testid="exec-money-month">
                {([
                  { key: "income", label: "Income", sub: "Coming in this month",
                    value: enhanced === undefined ? loadingDots : fmtUSD(monthlyIncome), hsl: "155 65% 45%", cls: "text-emerald-500" },
                  { key: "expenses", label: "Expenses", sub: "Spending + bills still owed, this month",
                    value: monthlyExpenses == null ? loadingDots : fmtUSD(monthlyExpenses), hsl: "0 72% 58%", cls: "text-red-500" },
                  { key: "cashflow", label: "Cash Flow", sub: "Income minus expenses, this month",
                    value: cfValue, hsl: cashFlow != null && cashFlow < 0 ? "0 72% 58%" : "155 65% 45%",
                    cls: cashFlow != null && cashFlow < 0 ? "text-red-500" : "text-emerald-500" },
                ] as const).map((r) => (
                  <div key={r.key} className="bubble-row px-2 py-1 min-w-0" title={r.sub}
                    style={{ ["--accent-hsl" as any]: r.hsl }}>
                    <p className="micro-label text-muted-foreground truncate">{r.label}</p>
                    <p className={`text-[13px] font-bold tabular-nums truncate ${r.cls}`}>{r.value}</p>
                  </div>
                ))}
              </div>
              <p className="micro-label text-muted-foreground mt-1.5 mb-1">
                Upcoming payments
              </p>
              {billsDueSoon.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">{UPCOMING_BILLS_EMPTY_COPY}.</p>
              ) : (
                <div className={LIST}>
                  {billsDueSoon.slice(0, CARD_ROWS).map((b: any) => {
                    const hsl = tonePalette(toneForDays(b.daysUntil));
                    return (
                      <div
                        key={b.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => setPopup("bills")}
                        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setPopup("bills"); } }}
                        className={`bubble-row w-full flex items-center ${ROW} min-w-0 text-left cursor-pointer`}
                        style={{ ["--accent-hsl" as any]: hsl }}
                        data-testid={`exec-money-bill-${b.id}`}
                      >
                        <RowIcon icon={Receipt} hsl={hsl} />
                        <span className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="text-[13px] font-semibold leading-tight truncate flex-1 min-w-0">{b.name}</span>
                          <span className="text-[11px] truncate shrink-0 max-w-[55%] text-muted-foreground">
                            {b.daysUntil === 0 ? "Due today" : `Due ${fmtShortDate(dateFromDays(b.daysUntil))}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-[13px] font-bold tabular-nums">
                          {formatMoney(Number(b.amount || 0))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* A different place than the header's "Open finances": the
                  Bills panel, over this tab. */}
              <FooterLink onClick={() => setPopup("bills")} testId="exec-view-bills">{billsDueSoon.length > CARD_ROWS ? `View all bills (${billsDueSoon.length})` : "View all bills"}</FooterLink>
            </ExecCard>}

            {/* ── Documents ────────────────────────────────────────────────── */}
            {showCard("documents") && <ExecCard
              id="documents" pos={cardPos("documents")} size={cardSize("documents")} fill={cardFill("documents")} icon={FolderOpen} title="Documents"
              accent={CARD_ACCENTS.documents} index={6} order={6}
              headerRight={<ViewLink label="View documents" accent={CARD_ACCENTS.documents} onClick={() => setPopup("docs")} testId="exec-view-documents" />}
            >
              {/* 2026-10-21: the expiring LIST lives in Needs Attention now, so
                  this card is the library: how the documents stand (counts)
                  and what was added lately — no row repeated from above. */}
              <div className="grid grid-cols-2 gap-1.5" data-testid="exec-docs-counts">
                {([
                  // 2026-11-22 (owner): "Documents repeats expired information
                  // from Attention." What has expired is listed (and can be
                  // dismissed) under Needs Attention; this card is the library
                  // and what is still ahead.
                  { key: "total", label: "Library", n: recentDocsRes?.total ?? (recentDocsRes ? recentDocsRes.rows.length : null), hs: CARD_ACCENTS.documents },
                  { key: "soon", label: "Expiring", n: docsSoonCount, hs: "25 90% 56%" },
                ] as const).map((c) => (
                  <button key={c.key} type="button" onClick={() => setPopup("docs")}
                    className="exec-tile bubble-row px-2 py-1 text-left min-w-0" style={{ ["--accent-hsl" as any]: c.hs }}
                    data-testid={`exec-docs-count-${c.key}`}>
                    <p className="micro-label text-muted-foreground truncate">{c.label}</p>
                    <p className="text-[13px] font-bold tabular-nums"
                      style={{ color: c.n ? `hsl(${c.hs})` : undefined }}>
                      {c.n == null ? (recentDocsError ? "—" : loadingDots) : c.n}
                    </p>
                  </button>
                ))}
              </div>
              <p className="micro-label text-muted-foreground mt-1.5 mb-1">Recently added</p>
              {recentDocsError ? (
                <p className="text-[12px] text-muted-foreground" data-testid="exec-docs-recent-error">Couldn't load recent documents.</p>
              ) : !recentDocsRes ? (
                <p className="text-[12px] text-muted-foreground">{loadingDots}</p>
              ) : recentDocsRes.rows.length === 0 ? (
                <CardEmpty icon={FileText} tone="good">No documents yet.</CardEmpty>
              ) : (
                <div className={LIST} data-testid="exec-docs-recent">
                  {/* A row IS a document: it opens that document's own page,
                      the same /documents/:id view Artifacts opens (Overview,
                      Extracted Data and the file). It used to open the
                      expirations popup, which lists only dates, so a licence
                      opened from here never reached its details (QA
                      2026-11-24, #15). */}
                  {recentDocsRes.rows.slice(0, 2).map((d: any) => (
                    <div key={d.id}
                      role="button" tabIndex={0}
                      onClick={() => navigate(routeForEntity("document", d.id))}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); navigate(routeForEntity("document", d.id)); } }}
                      className={`bubble-row flex items-center ${ROW} cursor-pointer`}
                      style={{ ["--accent-hsl" as any]: CARD_ACCENTS.documents }}
                      data-testid={`exec-docs-recent-${d.id}`}
                    >
                      <RowIcon icon={FileText} hsl={CARD_ACCENTS.documents} opt />
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <p className="text-[13px] font-semibold leading-tight truncate flex-1 min-w-0">{d.name || d.title || "Document"}</p>
                        <p className="exec-opt text-[11px] text-muted-foreground truncate shrink-0 max-w-[50%]">
                          {[d.type ? String(d.type).replace(/_/g, " ") : null, d.createdAt ? `added ${relativeTimeShort(d.createdAt)}` : null].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ExecCard>}

            {/* ── Wellness ─────────────────────────────────────────────────── */}
            {showCard("wellness") && <ExecCard
              id="wellness" pos={cardPos("wellness")} size={cardSize("wellness")} fill={cardFill("wellness")} icon={Heart} title="Wellness"
              accent={CARD_ACCENTS.wellness} index={7} order={7}
              headerRight={<ViewLink label="View wellness" accent={CARD_ACCENTS.wellness} onClick={() => setPopup("wellness:score")} testId="exec-view-wellness" />}
            >
              {dosesDue.length > 0 && (
                <div className={`${LIST} mb-1.5`} data-testid="exec-wellness-doses">
                  {dosesDue.slice(0, 2).map((i) => (
                    <ItemRow key={i.key} item={i}
                      busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                      onAction={onAction} onOpen={openItem} />
                  ))}
                </div>
              )}
              {!hasWellness && latestVitals.length === 0 ? (
                dosesDue.length > 0 ? null :
                <CardEmpty icon={Heart} accent={CARD_ACCENTS.wellness}>{wellnessEmptyCopy}</CardEmpty>
              ) : (
                <>
                  {!hasWellness && (
                    <p className="text-[11px] text-muted-foreground mb-1" data-testid="exec-wellness-nothing-today">
                      Nothing logged today — latest readings:
                    </p>
                  )}
                  {latestVitals.length > 0 && (
                    <div className={`${LIST} ${hasWellness ? "mb-1" : ""}`} data-testid="exec-wellness-vitals">
                      {latestVitals.slice(0, hasWellness ? 2 : CARD_ROWS).map((r) => (
                        <button key={r.key} type="button"
                          onClick={() => setPopup("wellness:score")}
                          className={`bubble-row w-full flex items-center ${ROW} text-left`}
                          style={{ ["--accent-hsl" as any]: CARD_ACCENTS.wellness }}
                          data-testid={`exec-wellness-vital-${r.key}`}>
                          <RowIcon icon={VITAL_ICONS[r.key] ?? ActivityIcon} hsl={CARD_ACCENTS.wellness} opt />
                          <span className="flex-1 min-w-0 flex items-center gap-2">
                            <span className="text-[13px] font-semibold leading-tight truncate flex-1 min-w-0">{r.label}</span>
                            {r.at && <span className="exec-opt text-[11px] text-muted-foreground truncate shrink-0">{relTime(r.at)}</span>}
                          </span>
                          <span className="shrink-0 text-[13px] font-bold tabular-nums">{r.value}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {/* One grid: 3 + 2 tiles from 640px, pairs on a phone. */}
                  {hasWellness && (
                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-1.5">
                    <WellTile className="sm:col-span-2" icon={Footprints} accent={CARD_ACCENTS.wellness} label="Steps"
                      value={vitals.steps.value != null ? Math.round(vitals.steps.value).toLocaleString() : "—"}
                      onClick={() => setPopup("wellness:activity")} testId="exec-well-steps" />
                    <WellTile className="sm:col-span-2" icon={Moon} accent="262 70% 62%" label="Sleep"
                      value={vitals.sleep.value != null ? fmtSleep(vitals.sleep.value) : "—"}
                      onClick={() => setPopup("wellness:sleep")} testId="exec-well-sleep" />
                    <WellTile className="sm:col-span-2" icon={ActivityIcon} accent="217 91% 65%" label="Exercise"
                      value={exerciseLabel}
                      onClick={() => setPopup("wellness:activity")} testId="exec-well-exercise" />
                    <WellTile className="sm:col-span-3" icon={Flame} accent="25 95% 58%" label="Calories"
                      value={vitals.calories.value != null ? `${Math.round(vitals.calories.value).toLocaleString()} kcal` : "—"}
                      onClick={() => setPopup("wellness:calories")} testId="exec-well-calories" />
                    <WellTile className="col-span-2 sm:col-span-3" icon={Droplets} accent="199 89% 60%" label="Water"
                      value={vitals.hydration.value != null ? `${Math.round(vitals.hydration.value)} ${vitals.hydration.unit || "oz"}` : "—"}
                      onClick={() => setPopup("wellness:hydration")} testId="exec-well-water" />
                  </div>
                  )}
                </>
              )}
            </ExecCard>}

          {/* ── Recent Activity — the last card of the grid (index.css gives a
              trailing card whatever is left of its row) ─────────────────── */}
          {showCard("activity") && <ExecCard
            id="activity" pos={cardPos("activity")} size={cardSize("activity")} fill={cardFill("activity")} icon={History} title="Recent Activity"
            accent={CARD_ACCENTS.activity} index={8} order={8} wide
          >
            {activityItems.length === 0 ? (
              <CardEmpty icon={History} accent={CARD_ACCENTS.activity}>
                {/* A profile filter can hide every row — never say "yet" then. */}
                {mode === "selected" && ids.length > 0
                  ? "No recent activity for the selected profiles."
                  : "No recent activity yet — anything you (or the assistant) log shows up here."}
              </CardEmpty>
            ) : (
              <div className={LIST}>
                <ExpandableRows id="activity" count={activityItems.length} cap={CARD_ROWS + 1} moreLabel={`Show all (${activityItems.length})`}>
                  {activityItems.map((i) => (
                    <div key={i.key}
                      role="button" tabIndex={0}
                      onClick={() => go(i.href)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(i.href); } }}
                      className={`bubble-row flex items-center ${ROW} cursor-pointer`}
                      style={{ ["--accent-hsl" as any]: CARD_ACCENTS.activity }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: `hsl(${CARD_ACCENTS.activity})` }} aria-hidden="true" />
                      <p className="text-[13px] font-medium truncate flex-1">{i.title}</p>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{i.reason}</span>
                    </div>
                  ))}
                </ExpandableRows>
              </div>
            )}
          </ExecCard>}

          {/* ── Cards the user built (shared/exec-widgets) ─────────────────── */}
          {cardPrefs.widgets.map((w, i) => {
            const cid = widgetCardId(w.id);
            if (!showCard(cid)) return null;
            return (
              <ExecCard key={cid}
                id={`w-${w.id}`} pos={cardPos(cid)} size={cardSize(cid) ?? "medium"} fill={cardFill(cid)}
                icon={WIDGET_ICON[w.icon]} title={w.title}
                accent={CARD_ACCENTS.custom} index={9 + i} order={9}>
                <ExecWidgetBody widget={w} mode={mode} ids={ids} todayISO={todayStr} accent={CARD_ACCENTS.custom} />
              </ExecCard>
            );
          })}

          </div>
        </>
      )}

      {/* Cards the preferences keep off the tab are named here, each one tap
          from showing (Rule 4). Changing what shows is the ⋮ menu's Customize,
          at the top right — not a control down here (owner, 2026-11-22). */}
      {!feedLoading && hiddenCards.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1" data-testid="exec-hidden-cards">
              <span className="text-[11px] text-muted-foreground mr-1">
                {cardPrefs.quiet ? "Quiet mode is on. Also available:" : "Hidden by you:"}
              </span>
              {hiddenCards.map((id) => (
                <button key={id} type="button"
                  onClick={() => setOpenedCards((prev) => new Set(prev).add(id))}
                  className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={`Show ${execCardTitle(cardPrefs, id)} for now`}
                  data-testid={`exec-hidden-${id}`}>
                  {execCardTitle(cardPrefs, id)}
                </button>
              ))}
        </div>
      )}

      {!feedLoading && quietCards.length > 0 && (
        <div className="mt-2 bubble px-3 py-2 flex flex-wrap items-center gap-1.5" data-testid="exec-quiet-cards">
          <span className="text-[11px] text-muted-foreground mr-1">Nothing to show right now:</span>
          {quietCards.map((c) => (
            <button key={c.id} type="button"
              onClick={() => setOpenedCards((prev) => new Set(prev).add(c.id))}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              style={{ ["--accent-hsl" as any]: c.accent }}
              title={`${c.title}: ${c.note}. Tap to open.`}
              aria-label={`Open ${c.title} (${c.note})`}
              data-testid={`exec-quiet-${c.id}`}>
              <c.icon className="h-3 w-3" style={{ color: `hsl(${c.accent})` }} aria-hidden="true" />
              {c.title}
            </button>
          ))}
          {/* A profile filter can be why a list is empty: say so here, where
              the cards that would have said it are folded away (Rule 4). */}
          {mode === "selected" && ids.length > 0 && (
            <span className="text-[11px] text-muted-foreground basis-full" data-testid="exec-quiet-scope">
              A profile filter is on — other people's items are hidden, not deleted.
            </span>
          )}
        </div>
      )}

      {/* The canonical drill-downs. Each is the app's ONE component for that
          data type — TasksPopup/HabitsPopup are the app's existing task and
          habit panels, BillsView also renders the /dashboard/obligations page,
          CashFlowView is the Finance tab's waterfall, and the wellness popups
          are the Wellness tab's own. Nothing here is built twice, and closing
          any of them leaves the tab exactly where it was. */}
      {popup === "tasks" && (
        <TasksPopup open onClose={() => { setPopup(null); setTaskFocus(null); }} filterMode={mode} filterIds={ids}
          initialTab={taskFocus?.tab ?? "today"} focusTaskId={taskFocus?.id ?? null} />
      )}
      {popup === "habits" && <HabitsPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "bills" && <BillsDuePopup open onOpenChange={(o: boolean) => !o && setPopup(null)} timeline={billsTimeline} />}
      {popup === "events" && <EventsPopup open onClose={() => setPopup(null)} items={timeline} todayStr={todayStr} />}
      {popup === "docs" && <DocsPopup open onClose={() => setPopup(null)} docs={visibleDocs} />}
      {popup === "networth" && <NetWorthPopup open onOpenChange={(o: boolean) => !o && setPopup(null)} filterMode={mode as "all" | "selected" | "everyone"} filterIds={ids} />}
      {popup === "cashflow" && <CashFlowView open onOpenChange={(o: boolean) => !o && setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "upcoming" && (
        <UpcomingPopup
          open onClose={() => setPopup(null)} items={upcomingItems}
          onAction={onAction} onOpenItem={openItem}
          busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
        />
      )}
      {popup?.startsWith("wellness:") && (
        <WellnessPopup
          kind={popup.slice("wellness:".length) as WellnessPopupKind}
          onClose={() => setPopup(null)}
          d={wellnessData}
        />
      )}
    </div>
  );
}

export default ExecutiveBriefing;
