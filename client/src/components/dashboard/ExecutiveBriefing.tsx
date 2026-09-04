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
import { sumMonthlyIncomeNow } from "@shared/obligation-windows";
import { localDayOf } from "@shared/timezone";
import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, recoverWedgedQueries } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { loadDocSnoozeMap } from "@/lib/docSnooze";
import {
  TriangleAlert, CalendarDays, DollarSign, FolderOpen, Flame, Sparkles,
  SlidersHorizontal, ChevronRight, Check, CreditCard, ArrowRight, X, Clock,
  CheckSquare, Heart, History, TrendingUp, TrendingDown, CircleDollarSign,
  Receipt, FileText, Target, ListTodo, PartyPopper, CheckCircle2,
  Footprints, Moon, Activity as ActivityIcon, Droplets, Dumbbell, BookOpen,
  Brain, Apple, Pill as PillIcon, type LucideIcon,
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
import { BillsPopup, EventsPopup, DocsPopup, dedupeBills } from "@/components/dashboard/BriefingPopups";
import { NetWorthPopup } from "@/components/dashboard/HeroKPIPopups";
import { CashFlowView } from "@/components/finance/CashFlowView";
import { WellnessPopup, type WellnessPopupKind, type WellnessPopupData } from "@/components/wellness/WellnessPopups";
import { computeHealthScore } from "@/lib/tracker-health";
// hashNavigate for query-carrying targets ("/trackers?open=x",
// "/linked?tab=documents") — wouter's hash navigate hoists the query out of
// the hash, landing on the bare page instead (the CommandSearch bug).
import { hashNavigate } from "@/lib/hashNavigate";
import { BubbleModal } from "@/components/ui/bubble-modal";
import { ProgressRing, toneForDays, tonePalette, type PillTone } from "@/components/dashboard/visuals";
import { AttentionFilters, useAttentionPrefs } from "@/components/dashboard/AttentionFilters";
import type { DashboardStats } from "@shared/schema";
import type { AttentionItem } from "@shared/attention";
// One relative-due formatter for the whole app. Interpolating a raw `daysUntil`
// is what once produced "Lawn care ($40) due in -29d".
import { dayLabel } from "@shared/now-rank";
import { groupDocumentDates } from "@shared/document-dates";
import { buildExecutiveSections, type ExecSectionId } from "@shared/executive-sections";
import { isHabitDueOn, isHabitDoneOn } from "@shared/habit-schedule";
import { habitDayProgress } from "@shared/habit-progress";
import { markOccurrence, pruneOccurrenceTags } from "@shared/recurring-dates";
import { isTestDataRow } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import { extractVitals } from "@/lib/wellness-metrics";
import { canonicalTimelineWindow, timelineQueryKey, timelineUrl } from "@shared/calendar-window";
import { getActiveTimezone } from "@/lib/timezone";
import { APP_LOCALE } from "@/lib/format";
import { currencySymbol } from "@/lib/currency";

/** Every drill-down this tab can open, each mapping to ONE canonical component.
 *  `wellness:<kind>` defers to the Wellness tab's own popup set. */
type PopupKind =
  | "tasks" | "habits" | "bills" | "events" | "docs"
  | "networth" | "cashflow" | "upcoming"
  | `wellness:${WellnessPopupKind}`
  | null;

// Card identity colours, matched to the reference mock and to the accents the
// rest of the app already uses (red overdue, blue tasks, purple calendar,
// green money/habits, yellow documents, rose wellness, teal activity).
const CARD_ACCENTS = {
  attention: "0 72% 58%",
  tasks:     "217 91% 65%",
  schedule:  "262 70% 62%",
  habits:    "155 65% 45%",
  money:     "155 65% 45%",
  documents: "43 96% 53%",
  wellness:  "350 85% 62%",
  upcoming:  "217 91% 65%",
  activity:  "173 60% 44%",
  recommendations: "280 75% 62%",
} as const;

// ── Small formatting helpers ─────────────────────────────────────────────────

const fmtUSD = (n: number) => `${currencySymbol()}${Math.round(n).toLocaleString()}`;

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

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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
      className="shrink-0 inline-flex items-center gap-0.5 text-[11px] font-semibold transition-colors hover:underline"
      style={{ color: accent ? `hsl(${accent})` : undefined }}
    >
      {label}
      <ChevronRight className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}

function ExecCard({ id, icon: Icon, title, accent, headerRight, children, className = "", index = 0 }: {
  id: string; icon: LucideIcon; title: string; accent: string;
  headerRight?: ReactNode; children: ReactNode; className?: string; index?: number;
}) {
  // h-full + flex column is what makes a card FILL its grid row instead of
  // hugging its content and leaving the rest of the cell black (user report
  // 2026-08-20: "there's a lot of empty space in the executive tab").
  //
  // The body is a plain flex region — NOT a scroll container. Bounding it with
  // max-height + overflow-y broke page scrolling on this tab (the wheel went
  // to the card under the pointer instead of the page), so content bounding
  // lives in the ExpandableRows caps below instead. See index.css.
  return (
    <section
      className={`bubble bubble-enter p-3.5 sm:p-4 h-full flex flex-col ${className}`}
      style={{ ["--accent-hsl" as any]: accent, ["--i" as any]: index }}
      data-testid={`exec-card-${id}`}
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-2 mb-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="h-4 w-4 shrink-0" style={{ color: `hsl(${accent})` }} strokeWidth={2.2} aria-hidden="true" />
          <h3 className="text-[11px] font-extrabold tracking-[0.14em] uppercase truncate" style={{ color: `hsl(${accent})` }}>
            {title}
          </h3>
        </div>
        {headerRight}
      </div>
      <div className="exec-card-body flex-1 min-h-0 flex flex-col">{children}</div>
    </section>
  );
}

/** An empty card still fills its cell — the message centres in the space
 *  rather than sitting at the top with a black void under it. */
function CardEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="flex-1 flex items-center justify-center text-center text-[12px] text-muted-foreground py-2">
      {children}
    </p>
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
        <button
          onClick={() => setShowAll(true)}
          className="w-full flex items-center gap-1 pt-2 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
          data-testid={`exec-more-${id}`}
        >
          {moreLabel ?? `View all (${count})`}
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

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
      className={`touch-hit shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold transition-all disabled:opacity-50 active:scale-95 ${
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
function ItemRow({ item, busyKeys, armedKey, leavingKeys, onAction, onOpen }: {
  item: AttentionItem;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
  onAction: (i: AttentionItem) => void;
  onOpen: (i: AttentionItem) => void;
}) {
  const tone: PillTone = item.kind === "alert" ? "critical" : toneForDays(item.daysUntil);
  const hsl = tonePalette(tone);
  const Icon = KIND_ICON[item.kind] ?? TriangleAlert;
  const right = item.amount
    ? fmtUSD(item.amount)
    : item.daysUntil != null && item.daysUntil > 0
      ? fmtShortDate(dateFromDays(item.daysUntil))
      : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(item); } }}
      className={`bubble-row w-full flex items-center gap-2.5 px-2.5 py-2 text-left cursor-pointer ${leavingKeys?.has(item.key) ? "row-leaving" : ""}`}
      style={{ ["--accent-hsl" as any]: hsl }}
      data-testid={`exec-item-${item.key}`}
    >
      <span
        className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: `hsl(${hsl} / 0.15)`, color: `hsl(${hsl})` }}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" strokeWidth={2.1} />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-semibold leading-tight truncate">{item.title}</p>
        {item.reason && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{item.reason}</p>}
      </div>
      {right && (
        <span className="shrink-0 text-[12px] font-bold tabular-nums" style={{ color: `hsl(${hsl})` }}>
          {right}
        </span>
      )}
      <ActionButton
        item={item}
        busy={!!busyKeys?.has(item.key)}
        armed={armedKey === item.key}
        onAction={onAction}
      />
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
function UpcomingPopup({ open, onClose, items, onAction, onOpenItem, busyKeys, armedKey, leavingKeys }: {
  open: boolean; onClose: () => void; items: AttentionItem[];
  onAction: (i: AttentionItem) => void;
  onOpenItem: (i: AttentionItem) => void;
  busyKeys?: Set<string>; armedKey?: string | null; leavingKeys?: Set<string>;
}) {
  // Grouped by the day they fall on, so a week reads as a week.
  const groups: Array<{ label: string; rows: AttentionItem[] }> = [];
  for (const i of items) {
    const du = i.daysUntil ?? 0;
    const label = du === 1 ? "Tomorrow"
      : du <= 7 ? "This week"
      : du <= 14 ? "Next week"
      : du <= 31 ? "This month"
      : "Later";
    const g = groups.find(x => x.label === label);
    if (g) g.rows.push(i); else groups.push({ label, rows: [i] });
  }
  return (
    <BubbleModal
      open={open} onClose={onClose} title="Upcoming" icon={Clock}
      accent={CARD_ACCENTS.upcoming} count={items.length}
      subtitle="Everything coming up — dates, bills, renewals and deadlines"
      testId="upcoming-popup" width="lg"
    >
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground py-6 text-center">Nothing coming up.</p>
      ) : groups.map(g => (
        <div key={g.label}>
          <p className="micro-label text-muted-foreground px-1 pt-2 pb-1">{g.label} · {g.rows.length}</p>
          <div className="space-y-1.5">
            {g.rows.map(i => (
              <ItemRow key={i.key} item={i}
                busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                onAction={onAction} onOpen={onOpenItem} />
            ))}
          </div>
        </div>
      ))}
    </BubbleModal>
  );
}

// ── Overview bar cell ────────────────────────────────────────────────────────

function OverviewCell({ icon: Icon, accent, label, value, sub, subClass, onClick, testId }: {
  icon: LucideIcon; accent: string; label: string; value: string;
  sub?: string; subClass?: string; onClick: () => void; testId: string;
}) {
  return (
    <button onClick={onClick} data-testid={testId} className="flex items-center gap-3 min-w-0 text-left touch-hit">
      <span
        className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}
        aria-hidden="true"
      >
        <Icon className="h-5 w-5" strokeWidth={2.2} />
      </span>
      <span className="min-w-0">
        <span className="block micro-label text-muted-foreground truncate">{label}</span>
        <span className="block text-lg font-extrabold leading-tight truncate">{value}</span>
        {sub && <span className={`block text-[11px] truncate ${subClass || "text-muted-foreground"}`}>{sub}</span>}
      </span>
    </button>
  );
}

// ── Wellness tile ────────────────────────────────────────────────────────────

/** A wellness metric tile. Pressing one opens the Wellness tab's own popup for
 *  that metric — the 7-day chart with latest/average/best — rather than a
 *  second version of it built here. */
function WellTile({ icon: Icon, label, value, accent, onClick, testId }: {
  icon: LucideIcon; label: string; value: string; accent: string;
  onClick?: () => void; testId?: string;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { onClick, type: "button" as const, "aria-label": `${label} — view detail` } : {})}
      data-testid={testId}
      className={`bubble-row flex flex-col items-center justify-center text-center gap-1 px-2 py-2.5 w-full ${onClick ? "touch-hit" : ""}`}
      style={{ ["--accent-hsl" as any]: accent }}
    >
      <Icon className="h-4 w-4 shrink-0" style={{ color: `hsl(${accent})` }} aria-hidden="true" />
      <p className="text-[13px] font-bold leading-tight truncate max-w-full">{value}</p>
      <p className="text-[11px] text-muted-foreground truncate max-w-full">{label}</p>
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
const habitIcon = (name: string): LucideIcon =>
  HABIT_ICONS.find(([re]) => re.test(name))?.[1] ?? Flame;

// Schedule dots rotate through the app's calendar palette so consecutive
// events read as distinct at a glance (matches the mock's colored dots).
const DOT_ROTATION = ["217 91% 65%", "262 70% 62%", "25 95% 58%", "155 65% 45%", "330 80% 62%"];

// ─────────────────────────────────────────────────────────────────────────────

export function ExecutiveBriefing({ filterMode, filterIds, stats, enhanced, ready = true }: {
  filterMode: string; filterIds: string[];
  stats: DashboardStats | undefined; enhanced: any;
  /** Gate for this component's own queries (PERF 2026-07-16): the dashboard
   * passes bootstrapSettled so these resolve from the bootstrap-seeded cache
   * instead of firing network requests that race the bootstrap download on
   * weak mobile links. Defaults true so other callers are unaffected; the
   * dashboard's gate self-releases after 8s even if bootstrap hangs. */
  ready?: boolean;
}) {
  const [, navigate] = useLocation();
  // Query-safe navigation: wouter's hash navigate loses "?tab=…"/"?open=…"
  // query strings, which is exactly "the link went to the wrong place".
  const go = (path: string) => { if (path.includes("?")) hashNavigate(path); else navigate(path); };
  const { toast } = useToast();
  const [popup, setPopup] = useState<PopupKind>(null);
  // Which item's money-moving button is armed for the confirming second tap.
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // Rows the user just completed, held for the exit animation so they slide
  // out instead of blinking away when the refetch lands.
  const [leavingKeys, setLeavingKeys] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const mode = filterMode;
  const ids = filterIds;
  const param = mode === "selected" && ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: getActiveTimezone() });

  // NOTE (BUG-20260715-everyone-zeros): none of these query functions may
  // swallow errors into a cached-as-success empty value (`.catch(() => [])`).
  // A transient failure — e.g. the pre-auth boot window racing token restore —
  // then renders as "0 in every category" for the whole staleTime window.
  const { data: tasksRaw = [], isPending: tasksPending } = useQuery<any[]>({
    queryKey: ["/api/tasks", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/tasks${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  const { data: habitsRaw = [], isPending: habitsPending } = useQuery<any[]>({
    queryKey: ["/api/habits", mode, ...ids],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/habits${param}`).then(r => r.json()),
    staleTime: 30_000,
  });
  // [PERF 2026-07-31] Canonical shared window (shared/calendar-window.ts): the
  // same key the bootstrap seeds, the calendar page counts from and the month
  // grid renders — one cache slot instead of three cold fetches.
  const timelineWindow = useMemo(() => canonicalTimelineWindow(todayStr), [todayStr]);
  const { data: timelineRaw = [], isPending: timelinePending } = useQuery<any[]>({
    queryKey: timelineQueryKey(timelineWindow, mode, ids),
    enabled: ready,
    queryFn: () => apiRequest("GET", timelineUrl(timelineWindow, mode, ids)).then(r => r.json()),
    staleTime: 60_000,
  });
  const { data: goalsRaw = [], isPending: goalsPending } = useQuery<any[]>({
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
  const { data: dismissedIds = [] } = useQuery<string[]>({
    queryKey: ["/api/preferences/dismissed_notifications"],
    enabled: ready,
    queryFn: () => apiRequest("GET", "/api/preferences/dismissed_notifications")
      .then(r => r.json())
      .then(d => { try { return JSON.parse(d?.value || "[]"); } catch { return []; } }),
    staleTime: 60_000,
  });
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
    ).then(r => r.json()).catch(() => []),
    staleTime: 5 * 60_000,
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
  const anyBriefPending = tasksPending || habitsPending || timelinePending || goalsPending || enhanced === undefined;
  const [briefStuck, setBriefStuck] = useState(false);
  useEffect(() => {
    if (!anyBriefPending) { setBriefStuck(false); return; }
    const t = setTimeout(() => setBriefStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [anyBriefPending]);

  // ── AI recommendations — tap to generate, never on load ────────────────────
  const [recommendations, setRecommendations] = useState<any[] | null>(null);
  const generateRecommendations = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("GET", `/api/dashboard/ai-suggestions?force=true${param ? `&${param.slice(1)}` : ""}`);
      return r.json();
    },
    onSuccess: (d: any) => {
      const rows = Array.isArray(d?.suggestions) ? d.suggestions : [];
      setRecommendations(rows);
      if (rows.length === 0) {
        toast({ title: "Nothing to suggest yet", description: "Add a little more data and try again." });
      }
    },
    onError: () => toast({ title: "Couldn't generate recommendations", variant: "destructive" }),
  });
  // A scope switch invalidates the advice — it was computed for other data.
  useEffect(() => { setRecommendations(null); }, [mode, ids.join(",")]);

  // ── Route every record to exactly one feed slot ────────────────────────────
  const snoozedDocumentIds = useMemo(() => Object.keys(loadDocSnoozeMap()), [allExpiringDocs.length]);
  const sectionInput = useMemo(() => ({
    today: todayStr,
    tasks, bills: allBills, documents: allExpiringDocs, habits,
    events: timeline, goals, notifications,
    dismissedNotificationIds: dismissedIds,
    snoozedDocumentIds,
    recentActivity: stats?.recentActivity || [],
    obligations, trackers,
    recommendations: recommendations || [],
  }), [todayStr, tasks, allBills, allExpiringDocs, habits, timeline, goals, notifications, dismissedIds, snoozedDocumentIds, stats, obligations, trackers, recommendations]);

  const sections = useMemo(
    () => buildExecutiveSections(sectionInput, prefs),
    [sectionInput, prefs]);
  const secItems = (id: ExecSectionId): AttentionItem[] => sections.find(s => s.id === id)?.items ?? [];

  // NEEDS ATTENTION = what is on fire now: everything overdue or alerting
  // (immediate), health items due today (a dose is not tomorrow's problem),
  // and documents expiring soon — the mock shows expirations here AND in the
  // Documents card, and that is deliberate: one is urgency, one is inventory.
  const attentionItems = useMemo(() => {
    const urgentHealth = secItems("health").filter(i => (i.daysUntil ?? 0) <= 0);
    const rows = [...secItems("immediate"), ...urgentHealth, ...secItems("documents")];
    return rows.slice().sort((a, b) => (a.daysUntil ?? -999) - (b.daysUntil ?? -999));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  // UPCOMING = everything dated from tomorrow on, across every domain, soonest
  // first. Records were already claimed once by the router, so nothing here
  // can be a duplicate of another row.
  const upcomingItems = useMemo(() => {
    const from: ExecSectionId[] = ["bills", "upcoming", "importantDates", "documents", "health", "today"];
    const rows = from.flatMap(id => secItems(id)).filter(i => (i.daysUntil ?? 0) >= 1);
    return rows.slice().sort((a, b) => (a.daysUntil ?? 99) - (b.daysUntil ?? 99));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);
  // The "Next Important" tile: today counts — a 2 pm appointment is the next
  // important thing at noon, not tomorrow's errand. The upcoming PANEL above
  // keeps tomorrow-onward, because today's rows already sit under Needs
  // attention and would otherwise render twice.
  const nextImportantItem = useMemo(() => {
    const from: ExecSectionId[] = ["today", "bills", "upcoming", "importantDates", "documents", "health"];
    const rows = from.flatMap(id => secItems(id)).filter(i => (i.daysUntil ?? 0) >= 0);
    return rows.slice().sort((a, b) => (a.daysUntil ?? 99) - (b.daysUntil ?? 99))[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  const activityItems = useMemo(() => secItems("activity"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections]);
  const recommendationItems = useMemo(() => secItems("recommendations"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sections]);

  // ── Overview derivations ───────────────────────────────────────────────────
  // Net worth: the server's filtered finance snapshot is the single source of
  // truth (same numbers the hub strip and Net Worth popup trust).
  const snap = enhanced?.financeSnapshot;
  const netWorth = snap != null ? (snap.totalAssetValue ?? 0) - (snap.totalLiabilities ?? 0) : null;
  const nwTrend = useMemo(() => {
    if (netWorth == null) return null;
    const rows = (Array.isArray(nwHistory) ? [...nwHistory] : [])
      .sort((a, b) => String(a.snapshotDate).localeCompare(String(b.snapshotDate)));
    if (rows.length === 0) return null;
    const first = Number(rows[0]?.netWorth) || 0;
    const delta = netWorth - first;
    // Only claim a % on a non-trivial, sign-stable baseline — otherwise fall
    // back to the $ delta (same guard as the Net Worth popup, BUG-4).
    const pct = Math.abs(first) < 1 || (first < 0) !== (netWorth < 0)
      ? null : (delta / Math.abs(first)) * 100;
    return { pct, delta, up: delta >= 0 };
  }, [nwHistory, netWorth]);

  // Cash flow — mirrors HubKpiStrip/HeroKPISection exactly: monthly income
  // minus (month expenses + monthlyized active obligations).
  const incomes: any[] = Array.isArray(incomesRaw) ? incomesRaw : incomesRaw?.items || [];
  const monthlyIncome = sumMonthlyIncomeNow(incomes, getActiveTimezone());
  const monthlySpendBase = snap?.totalMonthlySpend ?? stats?.monthlySpend;
  const monthlyExpenses = monthlySpendBase != null ? monthlySpendBase + (snap?.monthlyObligationTotal ?? 0) : null;
  const cashFlow = monthlyExpenses != null ? monthlyIncome - monthlyExpenses : null;

  // Tasks
  const pending = (tasks || []).filter((t: any) => t.status !== "done");
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
  const doneToday = (tasks || []).filter((t: any) => t.status === "done" && localDayOf(t.completedAt || t.updatedAt || null, getActiveTimezone()) === todayStr).length;
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
  const habitsDueToday = (habits || []).filter((h: any) => isHabitDueOn(h, todayStr));
  const habitsDoneCount = habitsDueToday.filter((h: any) => isHabitDoneOn(h, todayStr)).length;
  const habitPct = habitsDueToday.length > 0 ? Math.round((habitsDoneCount / habitsDueToday.length) * 100) : 0;

  // Money — bills within 3 weeks, soonest first.
  const billsDueSoon = allBills
    .filter((b: any) => typeof b.daysUntil === "number" && b.daysUntil >= 0 && b.daysUntil <= 21)
    .sort((a: any, b: any) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9));

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
      .filter((d: any) => typeof d.daysUntil === "number"),
  ).sort((a: any, b: any) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0));
  const docsSoonCount = visibleDocs.filter((d: any) => d.daysUntil <= 30).length;

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
  /** Play the row out, then let the refetch remove it for real. */
  const markLeaving = (key: string) => {
    setLeavingKeys(prev => new Set(prev).add(key));
    setTimeout(() => setLeavingKeys(prev => { const n = new Set(prev); n.delete(key); return n; }), 400);
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
      const date = String(row?.date || "").slice(0, 10);
      const tags = pruneOccurrenceTags(markOccurrence(row?.meta?.tags ?? [], date, "done"), todayStr);
      await apiRequest("PATCH", `/api/events/${row.sourceId}`, { tags });
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
  const dismissAlert = useMutation({
    // Same store the bell and the AI's dismiss_notifications tool write to.
    // The server merges the id into the stored list (D263): writing back
    // the list this component last read dropped dismissals made elsewhere.
    mutationFn: async (id: string) => { await apiRequest("POST", "/api/notifications/dismiss", { ids: [id] }); },
    onSuccess: () => {
      toast({ title: "Alert dismissed" });
      queryClient.invalidateQueries({ queryKey: ["/api/preferences/dismissed_notifications"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: () => toast({ title: "Couldn't dismiss alert", variant: "destructive" }),
  });

  const idOf = (item: AttentionItem) => item.sourceKey.split(":").slice(1).join(":");

  const onAction = (item: AttentionItem) => {
    const kind = item.action?.kind;
    if (!kind || kind === "open") { navigate(item.href); return; }
    const key = item.key;
    const run = (p: Promise<any>) => {
      markBusy(key, true);
      p.then(() => markLeaving(key)).catch(() => {}).finally(() => markBusy(key, false));
    };
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
        run(payBill.mutateAsync(idOf(item)));
        return;
      case "complete": run(completeTask.mutateAsync(idOf(item))); return;
      // No two-tap arming: logging a dose is trivially undone from Wellness,
      // unlike `pay`, which moves money.
      case "taken": run(markMedTaken.mutateAsync(idOf(item))); return;
      case "markdone": {
        // The row carries no tags of its own — look the occurrence back up in
        // the timeline by the id the item key was built from.
        const rowId = item.key.replace(/^event:/, "");
        const row = (Array.isArray(timelineRaw) ? timelineRaw : []).find((r: any) => r?.id === rowId);
        if (!row) { navigate(item.href); return; }
        run(markOccurrenceDone.mutateAsync(row));
        return;
      }
      case "checkin": run(checkinHabit.mutateAsync(idOf(item))); return;
      case "dismiss":
        run(dismissAlert.mutateAsync(item.key.replace(/^alert:/, "")));
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
      case "task": setPopup("tasks"); return;
      case "habit": setPopup("habits"); return;
      case "bill": setPopup("bills"); return;
      case "event": setPopup("events"); return;
      case "document": setPopup("docs"); return;
      default: go(item.href);
    }
  };

  const feedLoading = anyBriefPending && sections.length === 0;
  const loadingDots = "…";

  // Overview bar strings
  const nwValue = netWorth == null ? loadingDots : `${netWorth < 0 ? "-" : ""}${fmtUSD(Math.abs(netWorth))}`;
  const nwSub = nwTrend
    ? `${nwTrend.up ? "↑" : "↓"} ${nwTrend.pct != null ? `${Math.abs(nwTrend.pct).toFixed(1)}%` : fmtUSD(Math.abs(nwTrend.delta))} this month`
    : "this month";
  const cfValue = cashFlow == null ? loadingDots : `${cashFlow >= 0 ? "+" : "-"}${fmtUSD(Math.abs(cashFlow))}`;
  const nextDate = nextImportant?.daysUntil != null ? dateFromDays(nextImportant.daysUntil) : null;

  return (
    <div data-testid="executive-briefing">
      {/* STUCK-LOADING BANNER (2026-07-16): a card must never say "loading"
          forever. If any feeding query is still unresolved after 12s, surface
          a Retry that cancels wedged requests and refetches what's on screen. */}
      {briefStuck && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2" data-testid="brief-stuck-banner">
          <span className="text-xs text-muted-foreground">Some sections are taking too long to load.</span>
          <button
            className="text-xs font-medium text-primary hover:underline shrink-0"
            onClick={() => { setBriefStuck(false); void recoverWedgedQueries(); }}
            data-testid="brief-stuck-retry"
          >Retry</button>
        </div>
      )}

      {/* ── Overview bar ─────────────────────────────────────────────────── */}
      <div
        className="bubble bubble-enter mb-3 p-3.5 sm:p-4 grid grid-cols-2 lg:grid-cols-4 gap-3"
        style={{ ["--accent-hsl" as any]: "240 5% 55%", ["--i" as any]: 0 }}
        data-testid="exec-overview"
      >
        <OverviewCell
          icon={netWorth != null && netWorth < 0 ? TrendingDown : TrendingUp}
          accent="155 65% 45%"
          label="Net Worth"
          value={nwValue}
          sub={netWorth == null ? undefined : nwSub}
          subClass={nwTrend ? (nwTrend.up ? "text-emerald-500" : "text-red-500") : undefined}
          onClick={() => setPopup("networth")}
          testId="exec-kpi-networth"
        />
        <OverviewCell
          icon={CircleDollarSign}
          accent={cashFlow != null && cashFlow < 0 ? "0 72% 58%" : "155 65% 45%"}
          label="Cash Flow"
          value={cfValue}
          sub={cashFlow == null ? undefined : "this month"}
          onClick={() => setPopup("cashflow")}
          testId="exec-kpi-cashflow"
        />
        <OverviewCell
          icon={CheckSquare}
          accent={CARD_ACCENTS.tasks}
          label="Tasks Remaining"
          value={tasksPending ? loadingDots : String(pending.length)}
          sub={tasksPending ? undefined : overdueTasks.length > 0 ? `${overdueTasks.length} overdue` : "none overdue"}
          subClass={overdueTasks.length > 0 ? "text-red-500" : undefined}
          onClick={() => setPopup("tasks")}
          testId="exec-kpi-tasks"
        />
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
          onClick={() => setPopup("upcoming")}
          testId="exec-kpi-next"
        />
      </div>

      {feedLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="exec-cards-loading" aria-label="Loading dashboard">
          {[0, 1, 2, 3].map((i) => <BubbleSkeleton key={i} rows={2} height={140} index={i} />)}
        </div>
      ) : (
        <>
          {/* exec-grid: rows stretch so both cards in a row are the same
              height, and a trailing odd card spans the full width — no blank
              cell, no black gap under a short card (index.css). */}
          <div className="exec-grid grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* ── Needs Attention ──────────────────────────────────────────── */}
            <ExecCard
              id="attention" icon={TriangleAlert} title="Needs Attention"
              accent={CARD_ACCENTS.attention} index={1}
              headerRight={
                <div className="flex items-center gap-1">
                  {/* Advice costs a model call, so it stays a deliberate tap. */}
                  <button
                    onClick={() => generateRecommendations.mutate()}
                    disabled={generateRecommendations.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-border h-[26px] px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
                    data-testid="exec-recommendations-generate"
                    aria-label="Generate AI advice"
                    title={recommendations ? "Refresh AI advice" : "AI advice"}
                  >
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    {generateRecommendations.isPending ? "…" : <span className="sr-only">AI advice</span>}
                  </button>
                  <button
                    onClick={() => setFiltersOpen(o => !o)}
                    className="inline-flex items-center justify-center rounded-md border border-border h-[26px] w-[26px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    data-testid="attention-filters-toggle"
                    aria-expanded={filtersOpen}
                    aria-label="Attention filters"
                  >
                    <SlidersHorizontal className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              }
            >
              {filtersOpen && <div className="mb-2"><AttentionFilters prefs={prefs} onChange={setPrefs} /></div>}
              {attentionItems.length === 0 ? (
                <div className="py-4 text-center" data-testid="exec-attention-clear">
                  <PartyPopper className="h-6 w-6 mx-auto mb-1.5" style={{ color: "hsl(155 60% 45%)" }} aria-hidden="true" />
                  <p className="text-sm font-bold">You're all caught up</p>
                  <p className="text-[12px] text-muted-foreground mt-0.5">
                    Nothing overdue, nothing expiring soon.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <ExpandableRows id="attention" count={attentionItems.length} cap={4}>
                    {attentionItems.map((i) => (
                      <ItemRow key={i.key} item={i}
                        busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                        onAction={onAction} onOpen={openItem} />
                    ))}
                  </ExpandableRows>
                </div>
              )}
            </ExecCard>

            {/* ── Tasks ────────────────────────────────────────────────────── */}
            <ExecCard
              id="tasks" icon={CheckSquare} title="Tasks"
              accent={CARD_ACCENTS.tasks} index={2}
              headerRight={<ViewLink label="View all tasks" accent={CARD_ACCENTS.tasks} onClick={() => setPopup("tasks")} testId="exec-view-tasks" />}
            >
              <div className="grid grid-cols-3 gap-2 mb-3 text-center">
                <div>
                  <p className="metric-value text-2xl" style={{ color: `hsl(${CARD_ACCENTS.tasks})` }}>{pending.length}</p>
                  <p className="text-[11px] text-muted-foreground">Remaining</p>
                </div>
                <div>
                  <p className="metric-value text-2xl" style={{ color: "hsl(0 72% 58%)" }}>{overdueTasks.length}</p>
                  <p className="text-[11px] text-muted-foreground">Overdue</p>
                </div>
                <div>
                  <p className="metric-value text-2xl" style={{ color: "hsl(155 65% 45%)" }}>{doneToday}</p>
                  <p className="text-[11px] text-muted-foreground">Completed today</p>
                </div>
              </div>
              {sortedPending.length === 0 ? (
                <CardEmpty>{doneToday > 0 ? "Everything done — nice work." : "No open tasks."}</CardEmpty>
              ) : (
                <div className="space-y-1.5">
                  {sortedPending.slice(0, 4).map((t: any) => {
                    const du = daysFromToday(t.dueDate);
                    const busy = busyKeys.has(`task:${t.id}`);
                    const sub = du == null ? "No due date"
                      : du < 0 ? `Overdue · Due ${fmtShortDate(dateFromDays(du))}`
                      : du === 0 ? "Due today"
                      : `Due ${fmtShortDate(dateFromDays(du))}`;
                    return (
                      <div key={t.id}
                        className={`bubble-row flex items-center gap-2.5 px-2.5 py-2 ${leavingKeys.has(`task:${t.id}`) ? "row-leaving" : ""}`}
                        style={{ ["--accent-hsl" as any]: CARD_ACCENTS.tasks }}
                      >
                        <button
                          onClick={() => {
                            markBusy(`task:${t.id}`, true);
                            completeTask.mutateAsync(t.id)
                              .then(() => markLeaving(`task:${t.id}`))
                              .catch(() => {})
                              .finally(() => markBusy(`task:${t.id}`, false));
                          }}
                          disabled={busy}
                          className={`h-[18px] w-[18px] rounded-full border-2 shrink-0 transition-colors hover:border-emerald-500 ${busy ? "animate-pulse border-emerald-500" : "border-muted-foreground/50"}`}
                          aria-label={`Complete ${t.title}`}
                          data-testid={`exec-task-complete-${t.id}`}
                        />
                        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setPopup("tasks")}>
                          <p className="text-[13px] font-semibold leading-tight truncate">{t.title}</p>
                          <p className={`text-[11px] truncate mt-0.5 ${du != null && du < 0 ? "text-red-500" : "text-muted-foreground"}`}>{sub}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ExecCard>

            {/* ── Schedule ─────────────────────────────────────────────────── */}
            <ExecCard
              id="schedule" icon={CalendarDays} title="Schedule"
              accent={CARD_ACCENTS.schedule} index={3}
              headerRight={<ViewLink label="View schedule" accent={CARD_ACCENTS.schedule} onClick={() => setPopup("events")} testId="exec-view-calendar" />}
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="shrink-0">
                  <p className="metric-value text-3xl" style={{ color: `hsl(${CARD_ACCENTS.schedule})` }}>{eventsToday.length}</p>
                  <p className="text-[11px] text-muted-foreground">{eventsToday.length === 1 ? "event today" : "events today"}</p>
                </div>
                {nextUp && (
                  <div className="flex-1 min-w-0 rounded-lg px-2.5 py-2" style={{ background: `hsl(${CARD_ACCENTS.schedule} / 0.10)` }}>
                    <p className="micro-label text-muted-foreground">Next up</p>
                    <p className="text-[13px] font-semibold truncate" style={{ color: `hsl(${CARD_ACCENTS.schedule})` }}>{nextUp.title}</p>
                    {nextUp.time && <p className="text-[11px] text-muted-foreground mt-0.5">{timeLabel12h(nextUp.time)}</p>}
                  </div>
                )}
              </div>
              {eventsToday.length === 0 ? (
                <CardEmpty>Nothing scheduled today.</CardEmpty>
              ) : (
                <div className="space-y-1.5">
                  {eventsToday.slice(0, 5).map((e: any, idx: number) => {
                    const past = !!e.time && String(e.time).slice(0, 5) < nowClock;
                    return (
                      <div key={e.id}
                        role="button" tabIndex={0}
                        onClick={() => setPopup("events")}
                        onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setPopup("events"); } }}
                        className={`bubble-row flex items-center gap-2.5 px-2.5 py-2 cursor-pointer ${past ? "opacity-60" : ""}`}
                        style={{ ["--accent-hsl" as any]: CARD_ACCENTS.schedule }}
                      >
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: `hsl(${DOT_ROTATION[idx % DOT_ROTATION.length]})` }} aria-hidden="true" />
                        <span className="text-[12px] font-semibold tabular-nums text-muted-foreground w-[64px] shrink-0">
                          {e.allDay || !e.time ? "All day" : timeLabel12h(e.time)}
                        </span>
                        <span className="text-[13px] font-semibold truncate flex-1">{e.title}</span>
                      </div>
                    );
                  })}
                  <button
                    onClick={() => setPopup("events")}
                    className="w-full flex items-center gap-1 pt-2 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="exec-view-fullday"
                  >
                    View full day
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </ExecCard>

            {/* ── Habits ───────────────────────────────────────────────────── */}
            <ExecCard
              id="habits" icon={Flame} title="Habits"
              accent={CARD_ACCENTS.habits} index={4}
              headerRight={<ViewLink label="View habits" accent={CARD_ACCENTS.habits} onClick={() => setPopup("habits")} testId="exec-view-habits" />}
            >
              {habitsDueToday.length === 0 ? (
                <CardEmpty>No habits scheduled today.</CardEmpty>
              ) : (
                <div className="flex items-start gap-4">
                  <div className="shrink-0 flex flex-col items-center gap-1.5">
                    <ProgressRing
                      value={habitsDoneCount} total={habitsDueToday.length}
                      accent={CARD_ACCENTS.habits} size={72} stroke={6}
                      label={`${habitPct}%`}
                    />
                    <p className="text-[11px] text-muted-foreground text-center leading-tight">
                      {habitsDoneCount} / {habitsDueToday.length} complete<br />today
                    </p>
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {habitsDueToday.slice(0, 6).map((h: any) => {
                      const hp = habitDayProgress(h, todayStr);
                      const done = isHabitDoneOn(h, todayStr);
                      const HIcon = habitIcon(String(h.name || ""));
                      const busy = busyKeys.has(`habit:${h.id}`);
                      const pct = hp.required > 0 ? Math.min(100, (hp.completed / hp.required) * 100) : done ? 100 : 0;
                      return (
                        <button key={h.id}
                          onClick={() => {
                            if (done) { setPopup("habits"); return; }
                            markBusy(`habit:${h.id}`, true);
                            checkinHabit.mutateAsync(h.id).catch(() => {}).finally(() => markBusy(`habit:${h.id}`, false));
                          }}
                          disabled={busy}
                          className="bubble-row w-full flex items-center gap-2 px-2 py-1.5 text-left disabled:opacity-60"
                          style={{ ["--accent-hsl" as any]: CARD_ACCENTS.habits }}
                          data-testid={`exec-habit-checkin-${h.id}`}
                          aria-label={done ? `${h.name} — done today` : `Check in ${h.name}`}
                        >
                          <HIcon className="h-3.5 w-3.5 shrink-0" style={{ color: `hsl(${CARD_ACCENTS.habits})` }} aria-hidden="true" />
                          <span className="text-[12px] font-medium truncate flex-1">{h.name}</span>
                          {hp.required > 1 ? (
                            <>
                              <span className="h-1.5 w-8 rounded-full bg-muted overflow-hidden shrink-0" aria-hidden="true">
                                <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: `hsl(${CARD_ACCENTS.habits})` }} />
                              </span>
                              <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">{hp.completed}/{hp.required}</span>
                            </>
                          ) : done ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: `hsl(${CARD_ACCENTS.habits})` }} aria-label="Done" />
                          ) : (
                            <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">0/1</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </ExecCard>

            {/* ── Money ────────────────────────────────────────────────────── */}
            <ExecCard
              id="money" icon={DollarSign} title="Money"
              accent={CARD_ACCENTS.money} index={5}
              // Explicit navigation, and labelled as such: Finance is a tab,
              // not an expansion of this card.
              headerRight={<ViewLink label="Open finances" accent={CARD_ACCENTS.money} onClick={() => go("/dashboard/finance")} testId="exec-view-finances" />}
            >
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="micro-label text-muted-foreground mb-1.5">This Month</p>
                  <div className="space-y-1.5 text-[13px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Income</span>
                      <span className="font-bold tabular-nums text-emerald-500">{enhanced === undefined ? loadingDots : fmtUSD(monthlyIncome)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Expenses</span>
                      <span className="font-bold tabular-nums text-red-500">{monthlyExpenses == null ? loadingDots : fmtUSD(monthlyExpenses)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/40">
                      <span className="text-muted-foreground">Cash Flow</span>
                      <span className={`font-bold tabular-nums ${cashFlow != null && cashFlow < 0 ? "text-red-500" : "text-emerald-500"}`}>{cfValue}</span>
                    </div>
                  </div>
                </div>
                <div>
                  <p className="micro-label text-muted-foreground mb-1.5">Bills Due Soon</p>
                  {billsDueSoon.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">Nothing due in 3 weeks.</p>
                  ) : (
                    <div className="space-y-1.5 text-[13px]">
                      {billsDueSoon.slice(0, 3).map((b: any) => (
                        <button
                          key={b.id}
                          onClick={() => setPopup("bills")}
                          className="w-full flex items-center justify-between gap-2 min-w-0 text-left rounded-md hover:bg-muted/30 transition-colors"
                          data-testid={`exec-money-bill-${b.id}`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate">{b.name}</span>
                            <span className="block text-[11px] text-muted-foreground">{fmtShortDate(dateFromDays(b.daysUntil))}</span>
                          </span>
                          <span className="shrink-0 font-bold tabular-nums">${Number(b.amount || 0).toLocaleString(APP_LOCALE, { minimumFractionDigits: Number(b.amount) % 1 ? 2 : 0 })}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => setPopup("bills")}
                    className="flex items-center gap-1 pt-2 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="exec-view-bills"
                  >
                    View all bills
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </ExecCard>

            {/* ── Documents ────────────────────────────────────────────────── */}
            <ExecCard
              id="documents" icon={FolderOpen} title="Documents"
              accent={CARD_ACCENTS.documents} index={6}
              headerRight={<ViewLink label="View documents" accent={CARD_ACCENTS.documents} onClick={() => setPopup("docs")} testId="exec-view-documents" />}
            >
              {visibleDocs.length === 0 ? (
                <CardEmpty>Nothing expiring soon.</CardEmpty>
              ) : (
                <div className="flex items-start gap-4">
                  <div className="shrink-0 flex flex-col items-center">
                    <ProgressRing
                      value={docsSoonCount} total={Math.max(visibleDocs.length, 1)}
                      accent={CARD_ACCENTS.documents} size={72} stroke={6}
                      label={String(docsSoonCount)} sublabel="expiring"
                    />
                    <p className="text-[11px] text-muted-foreground mt-1.5">soon</p>
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {visibleDocs.slice(0, 4).map((d: any) => {
                      const name = d.documentName || d.name || d.fieldName || "Document";
                      const tone = tonePalette(toneForDays(d.daysUntil));
                      // One row per RULE, not per record — a person with both a
                      // passport and a licence expiring renders two, and keying
                      // on the shared source-entity id gave them the same key.
                      return (
                        <div key={d.ruleId || d.documentId || d.id}
                          role="button" tabIndex={0}
                          onClick={() => setPopup("docs")}
                          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setPopup("docs"); } }}
                          className="bubble-row flex items-center gap-2.5 px-2.5 py-2 cursor-pointer"
                          style={{ ["--accent-hsl" as any]: CARD_ACCENTS.documents }}
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold leading-tight truncate">{name}</p>
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {d.daysUntil < 0 ? `Expired ${Math.abs(d.daysUntil)}d ago` : d.daysUntil === 0 ? "Expires today" : `Expires in ${d.daysUntil} days`}
                            </p>
                          </div>
                          <span className="shrink-0 text-[12px] font-bold tabular-nums" style={{ color: `hsl(${tone})` }}>
                            {fmtShortDate(dateFromDays(d.daysUntil))}
                          </span>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => setPopup("docs")}
                      className="w-full flex items-center gap-1 pt-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                      data-testid="exec-view-all-documents"
                    >
                      View all documents
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}
            </ExecCard>

            {/* ── Wellness ─────────────────────────────────────────────────── */}
            <ExecCard
              id="wellness" icon={Heart} title="Wellness"
              accent={CARD_ACCENTS.wellness} index={7}
              headerRight={<ViewLink label="View wellness" accent={CARD_ACCENTS.wellness} onClick={() => setPopup("wellness:score")} testId="exec-view-wellness" />}
            >
              {!hasWellness ? (
                <CardEmpty>No wellness data logged yet — log steps, sleep or water on the Wellness tab.</CardEmpty>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <WellTile icon={Footprints} accent={CARD_ACCENTS.wellness} label="Steps"
                      value={vitals.steps.value != null ? Math.round(vitals.steps.value).toLocaleString() : "—"}
                      onClick={() => setPopup("wellness:activity")} testId="exec-well-steps" />
                    <WellTile icon={Moon} accent="262 70% 62%" label="Sleep"
                      value={vitals.sleep.value != null ? fmtSleep(vitals.sleep.value) : "—"}
                      onClick={() => setPopup("wellness:sleep")} testId="exec-well-sleep" />
                    <WellTile icon={ActivityIcon} accent="217 91% 65%" label="Exercise"
                      value={exerciseLabel}
                      onClick={() => setPopup("wellness:activity")} testId="exec-well-exercise" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <WellTile icon={Flame} accent="25 95% 58%" label="Calories"
                      value={vitals.calories.value != null ? `${Math.round(vitals.calories.value).toLocaleString()} kcal` : "—"}
                      onClick={() => setPopup("wellness:calories")} testId="exec-well-calories" />
                    <WellTile icon={Droplets} accent="199 89% 60%" label="Water"
                      value={vitals.hydration.value != null ? `${Math.round(vitals.hydration.value)} ${vitals.hydration.unit || "oz"}` : "—"}
                      onClick={() => setPopup("wellness:hydration")} testId="exec-well-water" />
                  </div>
                </>
              )}
            </ExecCard>

            {/* ── Upcoming ─────────────────────────────────────────────────── */}
            <ExecCard
              id="upcoming" icon={Clock} title="Upcoming"
              accent={CARD_ACCENTS.upcoming} index={8}
              headerRight={<ViewLink label="View all upcoming" accent={CARD_ACCENTS.upcoming} onClick={() => setPopup("upcoming")} testId="exec-view-upcoming" />}
            >
              {upcomingItems.length === 0 ? (
                <CardEmpty>Nothing coming up in the next few weeks.</CardEmpty>
              ) : (
                <div className="space-y-1.5">
                  <ExpandableRows id="upcoming" count={upcomingItems.length} cap={5}>
                    {upcomingItems.map((i) => (
                      <ItemRow key={i.key} item={i}
                        busyKeys={busyKeys} armedKey={armedKey} leavingKeys={leavingKeys}
                        onAction={onAction} onOpen={openItem} />
                    ))}
                  </ExpandableRows>
                </div>
              )}
            </ExecCard>

            {/* ── AI Recommendations — only once the user asked ────────────── */}
            {recommendationItems.length > 0 && (
              <ExecCard
                id="recommendations" icon={Sparkles} title="AI Recommendations"
                accent={CARD_ACCENTS.recommendations} index={9}
              >
                <div className="space-y-1.5">
                  {recommendationItems.map((i) => (
                    <div key={i.key} className="bubble-row px-2.5 py-2" style={{ ["--accent-hsl" as any]: CARD_ACCENTS.recommendations }}>
                      <p className="text-[13px] font-semibold leading-tight">{i.title}</p>
                      {i.reason && <p className="text-[11px] text-muted-foreground mt-0.5">{i.reason}</p>}
                    </div>
                  ))}
                </div>
              </ExecCard>
            )}
          </div>

          {/* ── Recent Activity — full width, at the very bottom ───────────── */}
          <ExecCard
            id="activity" icon={History} title="Recent Activity"
            accent={CARD_ACCENTS.activity} index={10} className="mt-3"
          >
            {activityItems.length === 0 ? (
              <CardEmpty>No recent activity yet — anything you (or the assistant) log shows up here.</CardEmpty>
            ) : (
              <div className="space-y-1.5">
                <ExpandableRows id="activity" count={activityItems.length} cap={6} moreLabel={`Show all (${activityItems.length})`}>
                  {activityItems.map((i) => (
                    <div key={i.key}
                      role="button" tabIndex={0}
                      onClick={() => go(i.href)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(i.href); } }}
                      className="bubble-row flex items-center gap-2.5 px-2.5 py-2 cursor-pointer"
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
          </ExecCard>
        </>
      )}

      {/* The canonical drill-downs. Each is the app's ONE component for that
          data type — TasksPopup/HabitsPopup are the app's existing task and
          habit panels, BillsView also renders the /dashboard/obligations page,
          CashFlowView is the Finance tab's waterfall, and the wellness popups
          are the Wellness tab's own. Nothing here is built twice, and closing
          any of them leaves the tab exactly where it was. */}
      {popup === "tasks" && <TasksPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "habits" && <HabitsPopup open onClose={() => setPopup(null)} filterMode={mode} filterIds={ids} />}
      {popup === "bills" && <BillsPopup open onClose={() => setPopup(null)} bills={allBills} />}
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
