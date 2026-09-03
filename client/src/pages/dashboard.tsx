import { changedFieldsOnly } from "@shared/field-patch";
import { sumMonthlyIncomeNow } from "@shared/obligation-windows";
import { localTodayISO } from "@/lib/dates";
import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from "react";
import { formatApiError } from "@/lib/formatError";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { invalidateDomain, invalidateDomains, patchQueries, dropUpcomingBillFromDashboard } from "@/lib/cache-bus";
import { withFullLimit } from "@/lib/list-limit";
import { parseMoney } from "@/lib/utils";
import { categoryTheme } from "@/lib/category-theme";
import { MetricCard } from "@/components/ui/metric-card";
import { formatMoneyRound } from "@/lib/format";
import { resolveAssetValue, resolveLiabilityBalance, isNetWorthLiabilityProfile } from "@shared/asset-value";
import { parseISODate } from "@shared/date-math";
import { goalsQueryKey } from "@shared/query-keys";
import {
  RECUR_PRESETS, parseRecurrence, recurrenceToTags, isRecurring as isRecurringRule,
  nextOccurrence as nextRecurOccurrence, seriesEnded, humanSummary, freqToUnit,
  type RecurrenceRule,
} from "@shared/recurrence";
import { DrillDownDialog } from "@/components/DrillDownDialog";
import { ChatGPTImportDialog } from "@/components/ChatGPTImportDialog";
import { getProfileFilter, setFilterSelected, initDefaultProfileFilter, reconcileProfileFilter, subscribeProfileFilter, type FilterMode } from "@/lib/profileFilter";
import { loadDocSnoozeMap, saveDocSnoozeMap } from "@/lib/docSnooze";
import { groupDocumentDates, ruleIdsOf } from "@shared/document-dates";
import { computeNetWorth, type OwnershipTables } from "@shared/net-worth";
import { useLiveTotal } from "@/lib/derived-aggregates";
import { netWorthView, isNetWorthLoaded } from "@/lib/net-worth-view";
import { computeNowItems, dayLabel, type NowItem } from "@shared/now-rank";
import {
  aggregateUpcomingDates,
  groupByTimeframe,
  daysUntilLabel,
  CATEGORY_LABELS as UPCOMING_CATEGORY_LABELS,
  CATEGORY_ICONS as UPCOMING_CATEGORY_ICONS,
  URGENCY_COLORS as UPCOMING_URGENCY_COLORS,
  TIMEFRAME_LABELS as UPCOMING_TIMEFRAME_LABELS,
  type UpcomingDate,
  type UpcomingEntityKind,
} from "@shared/upcoming-dates";
import {
  computeKeyFindings,
  SEVERITY_COLORS as FINDING_SEVERITY_COLORS,
  DIRECTION_LABEL as FINDING_DIRECTION_LABEL,
  type KeyFinding,
  type FindingDirection,
} from "@shared/tracker-insights";
import { seedDashboardCaches } from "@/lib/bootstrap-seed";
import { warmSiblingScopes } from "@/lib/scope-prefetch";
import { isInScope, ownerCandidatesForProfile } from "@shared/scope";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useHubChrome } from "@/components/hub/hub-context";
import { useResumeTick } from "@/hooks/useResumeTick";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription, DialogClose,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  Activity, ListTodo, DollarSign, Calendar, BarChart3, Flame,
  CreditCard, BookHeart, Sparkles, Smile, Meh, Frown,
  TrendingUp, AlertTriangle, Heart,
  Check, Clock, MapPin,
  ChevronDown, ChevronUp,
  ExternalLink, Eye,
  HeartPulse, ArrowUp, ArrowDown, ArrowRight, ArrowUpRight, ArrowDownRight, Minus, FileWarning, CalendarClock,
  Download, UploadCloud, MoreVertical,
  EyeOff, GripVertical, Settings, RotateCcw, Target,
  Trash2, Pencil, FileText, CheckCircle2, X,
  ChevronLeft, ChevronRight, Plus, ShieldCheck,
  Wallet, PieChart as PieChartIcon, Settings2, AlertCircle, Bell, BellOff,
  Scale, Activity as ActivityIcon, Moon,
  Users, TrendingDown,
  CalendarDays, Pin, PinOff, Filter as FilterIcon, Sparkle,
  Lightbulb, Repeat, Flag, User,
  Pause, Play, SkipForward, Tag as TagIcon, AlarmClock, ListChecks, Timer, ChevronsUpDown, FlaskConical,
  Zap, Receipt, StickyNote, ArrowDownToLine,
} from "lucide-react";
import { useShowTestData, toggleShowTestData } from "@/lib/showTestData";
import { devToolsEnabled } from "@/lib/dev-affordances";
import { isTestEntity } from "@shared/test-data";
import { formatMoney, formatListDate } from "@/lib/format";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import type { DashboardStats, MoodLevel } from "@shared/schema";
import { DEFAULT_SECTION_DEFS, LAYOUT_VERSION } from "@shared/dashboard-layout";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { NetWorthPopup, BudgetPopup } from "@/components/dashboard/HeroKPIPopups";
// One data type = one UI: every cash-flow press opens the canonical waterfall.
import { CashFlowView } from "@/components/finance/CashFlowView";
import { QuickAddDialog, type QuickAddKind } from "@/components/dashboard/quick-add/QuickAddDialog";
import { TasksPopup, HabitsPopup } from "@/components/dashboard/TaskHabitPopups";
import { ExecutiveBriefing } from "@/components/dashboard/ExecutiveBriefing";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: string): string {
  // Round-6 fix (BUG-009): previous logic computed elapsed hours and said
  // "Yesterday" whenever 24-48 hours had passed. A 25-hour-old expense created
  // last night could therefore display "Yesterday" even though today's calendar
  // date matches the expense's calendar date. Compare CALENDAR days in the
  // user's timezone instead so "Today" actually means today.
  const entry = new Date(ts);
  if (isNaN(entry.getTime())) return "";
  const diff = Date.now() - entry.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  // Compare YYYY-MM-DD strings rendered in the user's local timezone so a
  // 25-hour-old event whose calendar date equals today still says "Today".
  const entryDay = entry.toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
  const todayDay = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
  if (entryDay === todayDay) return "Today";
  // Yesterday in the user's timezone: subtract one day from today's local date.
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yesterdayDay = yest.toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE });
  if (entryDay === yesterdayDay) return "Yesterday";
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// `parseISODate` (shared/date-math) reads YYYY-MM-DD at LOCAL midnight.
// `new Date("2026-08-08")` is UTC midnight, which renders as Aug 7 anywhere
// west of UTC — every dated task on this page showed a day early (reported
// 2026-08-04, and why the Tasks popup disagreed with the Calendar tab).
function fmtDate(d: string): string {
  return (parseISODate(d) ?? new Date(d))
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDateWithYear(d: string): string {
  return (parseISODate(d) ?? new Date(d))
    .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function journalStreakLabel(streak: number): string {
  if (streak === 0) return "Start today";
  if (streak <= 2) return "Building";
  if (streak <= 6) return "Good";
  return "Great";
}

// Keyboard activation helper for non-<button> clickable elements (a11y):
// makes Enter/Space behave like a click on role="button" divs.
const onEnterOrSpace = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

function daysUntilStr(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days}d`;
}

// Bills carry NO "overdue" status (product decision 2026-06). A recurring bill
// whose nextDueDate sits in the past simply hasn't been rolled forward yet, so
// flagging it red as "overdue" was misleading and made nearly every bill scream
// red. Every bill surface now shows the bill with its due date in neutral
// styling: future bills show their date, today/tomorrow get a friendly label,
// and past-due bills just show the date they were due — never "overdue".
function billDueLabel(bill: { daysUntil?: number | null; dueDate?: string | null }): string {
  const d = bill?.daysUntil;
  if (typeof d === "number") {
    if (d === 0) return "Due today";
    if (d === 1) return "Due tomorrow";
  }
  if (bill?.dueDate) return `Due ${fmtDate(bill.dueDate)}`;
  if (typeof d === "number" && d > 1) return `Due in ${d}d`;
  return "Due";
}

// resolveAssetValue / resolveLiabilityBalance now live in shared/asset-value.ts
// (BUG-20260528-asset-resolver-duplication). Imported at top of file. Must stay
// byte-for-byte equivalent across client + server because the Dashboard renders
// three Net Worth surfaces (Hero KPI tile, Net Worth popup, Finance section
// tile) that must agree to the dollar.


const MOOD_CONFIG: Record<MoodLevel, { icon: any; label: string; color: string; bg: string }> = {
  amazing:   { icon: Sparkles, label: "Amazing",   color: "#6DAA45", bg: "bg-green-500/10" },
  great:     { icon: Smile,    label: "Great",     color: "#5BAA6A", bg: "bg-emerald-500/10" },
  good:      { icon: Smile,    label: "Good",      color: "#4F98A3", bg: "bg-teal-500/10" },
  okay:      { icon: Meh,      label: "Okay",      color: "#8A8A7A", bg: "bg-gray-400/10" },
  neutral:   { icon: Meh,      label: "Neutral",   color: "#797876", bg: "bg-gray-500/10" },
  bad:       { icon: Frown,    label: "Bad",       color: "#BB653B", bg: "bg-orange-500/10" },
  awful:     { icon: Frown,    label: "Awful",     color: "#A13544", bg: "bg-red-500/10" },
  terrible:  { icon: Frown,    label: "Terrible",  color: "#8B1A2B", bg: "bg-red-600/10" },
};

const ACTIVITY_ICONS: Record<string, any> = {
  tracker_entry: HeartPulse,
  task_completed: Check,
  expense: DollarSign,
};

// Per-type accent (HSL) for the activity feed chips. Falls back to slate.
const ACTIVITY_COLORS: Record<string, string> = {
  tracker_entry: "350 89% 60%",
  task_completed: "152 60% 44%",
  expense: "25 95% 53%",
};

// ─── Animated Count-Up Hook ───────────────────────────────────────────────────

function useCountUp(target: number, duration: number = 600): number {
  const [current, setCurrent] = useState(target);
  const prevTarget = useRef(target);
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (target === prevTarget.current) return;
    // Round-6 fix (BUG-001): on initial data arrival (mount → first real number)
    // skip the count-up animation and render the target immediately. Otherwise the
    // hook would animate from the prev value (often 0 before data loads) up to the
    // real number, producing the "$0 then jumps after scroll" flash the user saw.
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      prevTarget.current = target;
      setCurrent(target);
      return;
    }
    const start = prevTarget.current;
    prevTarget.current = target;
    const startTime = performance.now();
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCurrent(Math.round(start + (target - start) * eased));
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [target, duration]);
  return current;
}

// ─── Shared UI Components ────────────────────────────────────────────────────

function CollapsibleSection({
  icon: Icon, label, count, sub, children, defaultOpen = true,
  testId, headerRight, accent,
}: {
  icon: any; label: string; count?: number; sub?: string;
  children: React.ReactNode; defaultOpen?: boolean; testId?: string;
  headerRight?: React.ReactNode; accent?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const iconColor = accent ? `hsl(${accent})` : undefined;
  const iconBg = accent ? `hsl(${accent} / 0.14)` : undefined;
  return (
    <div
      data-testid={testId}
      className="rounded-xl border overflow-hidden transition-shadow hover:shadow-md"
      style={accent ? { ["--accent-hsl" as any]: accent } : undefined}
    >
      <button
        className="w-full flex items-center gap-2.5 px-3 py-3 text-left transition-colors hover:bg-muted/20"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-testid={`btn-toggle-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="icon-badge" style={iconBg ? { background: iconBg } : { background: 'hsl(var(--muted))' }}>
          <Icon className="h-3.5 w-3.5" style={iconColor ? { color: iconColor } : { color: 'hsl(var(--primary))' }} />
        </div>
        <h2 className="micro-label" style={iconColor ? { color: iconColor } : {}}>{label}</h2>
        {count !== undefined && (
          <span className="text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 tabular-nums">{count}</span>
        )}
        {sub && <span className="text-xs text-muted-foreground ml-1 truncate">{sub}</span>}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {headerRight}
          {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/70" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/70" />}
        </div>
      </button>
      {open && <div className="px-2.5 pb-3">{children}</div>}
    </div>
  );
}

function MiniStat({
  icon: Icon, label, value, sub, color, onClick, trend, accent, sparkData, change,
}: { icon: any; label: string; value: string | number; sub?: string; color?: string; onClick?: () => void; trend?: "up" | "down" | "flat"; accent?: string; sparkData?: number[]; change?: string | number }) {
  const accentColor = accent ? `hsl(${accent})` : color;
  return (
    <div
      className={`relative flex flex-col p-1.5 rounded-xl border border-border/40 min-h-[62px] overflow-hidden card-lift ${
        onClick ? "cursor-pointer active:scale-[0.97] transition-all hover:-translate-y-0.5 hover:shadow-md" : ""
      }`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? onEnterOrSpace(onClick) : undefined}
      data-testid={`stat-card-${label.toLowerCase().replace(/\s+/g, "-")}`}
      style={accent ? {
        background: `linear-gradient(135deg, hsl(${accent} / 0.10) 0%, transparent 60%)`,
      } : {}}
    >
      {/* Top accent strip */}
      {accent && <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: `linear-gradient(90deg, hsl(${accent}), transparent)` }} />}

      {/* Sparkline background (if data provided) */}
      {sparkData && sparkData.length > 2 && (
        <div className="absolute bottom-0 right-0 left-0 h-8 opacity-20">
          <svg width="100%" height="100%" viewBox={`0 0 ${sparkData.length * 10} 32`} preserveAspectRatio="none">
            <polyline
              points={sparkData.map((v, i) => {
                const min = Math.min(...sparkData);
                const max = Math.max(...sparkData);
                const range = max - min || 1;
                return `${i * 10},${32 - ((v - min) / range * 28 + 2)}`;
              }).join(' ')}
              fill="none"
              stroke={accentColor || 'hsl(var(--primary))'}
              strokeWidth="2"
            />
          </svg>
        </div>
      )}

      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={accent ? { background: `hsl(${accent} / 0.15)` } : {}}>
          <Icon className="h-3.5 w-3.5" style={{ color: accentColor || "hsl(var(--primary))" }} />
        </div>
        {change !== undefined && (
          <span className={`text-xs font-medium ${trend === 'up' ? 'text-green-500' : trend === 'down' ? 'text-red-400' : 'text-muted-foreground'}`}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : ''}{change}
          </span>
        )}
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-sm font-bold metric-value tracking-tight leading-none" style={{ color: accentColor || "hsl(var(--foreground))" }}>{value}</span>
      </div>
      <p className="micro-label text-muted-foreground/70 leading-tight mt-0.5 truncate w-full relative z-10">{label}</p>
      {sub && <p className="text-[11px] text-muted-foreground/60 leading-tight mt-0.5 truncate w-full relative z-10">{sub}</p>}
      {/* Bottom accent dashes (matches the mockup's tile footer) */}
      {accent && !sparkData && (
        <div className="mt-auto flex gap-1 pt-1.5 relative z-10">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-1 flex-1 rounded-full" style={{ background: `hsl(${accent} / ${i === 0 ? 1 : 0.25})` }} />
          ))}
        </div>
      )}
    </div>
  );
}

const MD_GRID_COLS: Record<number, string> = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4", 5: "md:grid-cols-5", 6: "md:grid-cols-6" };

function SkeletonGrid({ cols = 4, rows = 1, h = "h-14" }: { cols?: number; rows?: number; h?: string }) {
  return (
    <div className={`grid grid-cols-2 ${MD_GRID_COLS[cols] || "md:grid-cols-4"} gap-2`}>
      {Array.from({ length: cols * rows }).map((_, i) => (
        <Skeleton key={`skel-${i}`} className={` ${h} rounded-lg`} />
      ))}
    </div>
  );
}

// Rendered in place of a skeleton once loading has been stuck past the
// deadline — a skeleton must never be the permanent state (2026-07-16).
function DashLoadTimeoutCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 flex flex-col items-center gap-2 text-center" data-testid="dash-load-timeout">
      <p className="text-sm text-muted-foreground">The dashboard is taking too long to load.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onRetry} data-testid="dash-load-retry">Retry</Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Refresh</Button>
      </div>
    </div>
  );
}

function TrendIcon({ trend }: { trend: string }) {
  if (trend === "up") return <ArrowUp className="h-2.5 w-2.5 text-green-500" />;
  if (trend === "down") return <ArrowDown className="h-2.5 w-2.5 text-red-500" />;
  return <Minus className="h-2.5 w-2.5 text-muted-foreground" />;
}

function ViewPageLink({ href, label = "View Full Page" }: { href: string; label?: string }) {
  const [, navigate] = useLocation();
  return (
    <button
      onClick={() => navigate(href.replace("#", ""))}
      className="flex items-center gap-1 text-xs text-primary hover:underline mt-2"
    >
      <ExternalLink className="h-2.5 w-2.5" /> {label}
    </button>
  );
}

// ─── Enhanced KPI Cards ──────────────────────────────────────────────────────

function KPITaskCard({ count, onClick }: { count: number; onClick: () => void }) {
  const animatedCount = useCountUp(count);
  const fillPct = Math.min(100, Math.round((count / Math.max(count, 50)) * 100));
  return (
    <div onClick={onClick} className="relative flex flex-col p-1.5 rounded-xl border border-border/40 min-h-[62px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all pressable"
      style={{ background: 'linear-gradient(135deg, hsl(262 65% 62% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-open-tasks"
      role="button" tabIndex={0} aria-label="Open tasks" onKeyDown={onEnterOrSpace(onClick)}>
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(262 65% 62%), transparent)' }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: 'hsl(262 65% 62% / 0.15)' }}>
          <ListTodo className="h-3.5 w-3.5" style={{ color: 'hsl(262 65% 62%)' }} />
        </div>
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-sm font-bold metric-value tracking-tight leading-none" style={{ color: 'hsl(262 65% 62%)' }}>{animatedCount}</span>
      </div>
      <p className="micro-label text-muted-foreground/70 mt-0.5 relative z-10">Open Tasks</p>
      {/* Fill bar */}
      <div className="mt-1.5 relative z-10">
        <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${fillPct}%`, background: 'hsl(262 65% 62%)' }} />
        </div>
        <p className="text-[11px] text-muted-foreground/60 mt-0.5">{count} active</p>
      </div>
    </div>
  );
}

function KPISpendCard({ amount, trend, enhanced, onClick }: { amount: number; trend: "up"|"down"|"flat"; enhanced: any; onClick: () => void }) {
  const animatedAmount = useCountUp(Math.round(amount));
  const finSnap = enhanced?.financeSnapshot;
  const bars = finSnap?.dailySpend?.slice(-7) || Array.from({length:7}, (_,i) => i === 6 ? amount * 0.3 : Math.random() * amount * 0.15);
  const maxBar = Math.max(...bars, 1);
  return (
    <div onClick={onClick} className="relative flex flex-col p-1.5 rounded-xl border border-border/40 min-h-[62px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all pressable"
      style={{ background: 'linear-gradient(135deg, hsl(43 85% 52% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-monthly-spend"
      role="button" tabIndex={0} aria-label="Monthly spend" onKeyDown={onEnterOrSpace(onClick)}>
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(43 85% 52%), transparent)' }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: 'hsl(43 85% 52% / 0.15)' }}>
          <DollarSign className="h-3.5 w-3.5" style={{ color: 'hsl(43 85% 52%)' }} />
        </div>
        <span className={`text-[11px] font-semibold ${trend === 'up' ? 'text-red-400' : trend === 'down' ? 'text-green-500' : 'text-muted-foreground'}`}>
          {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '—'}
        </span>
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-sm font-bold metric-value tracking-tight leading-none" style={{ color: 'hsl(43 85% 52%)' }}>${animatedAmount}</span>
        {/* When nothing is logged yet this month, "$0" read as broken (user
            report on July 1). Show the recurring commitment so the number has
            context: expenses logged so far + bills/mo still coming. */}
        {(finSnap?.monthlyObligationTotal ?? 0) > 0 && (
          <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">+${Math.round(finSnap.monthlyObligationTotal).toLocaleString()}/mo bills</span>
        )}
      </div>
      <p className="micro-label text-muted-foreground/70 mt-0.5 relative z-10">Monthly Spend</p>
      {/* Mini bar chart */}
      <div className="mt-1.5 flex items-end gap-0.5 h-5 relative z-10">
        {bars.map((v: number, i: number) => (
          <div key={i} className="flex-1 rounded-sm" style={{ height: `${Math.max(10, (v/maxBar)*100)}%`, background: i === bars.length-1 ? 'hsl(43 85% 52%)' : 'hsl(43 85% 52% / 0.35)' }} />
        ))}
      </div>
    </div>
  );
}

function KPIHabitsCard({ completionPct, totalHabits, onClick }: { completionPct: number; totalHabits: number; onClick: () => void }) {
  const r = 14; const circ = 2 * Math.PI * r;
  const pct = Math.min(100, completionPct);
  const animatedPct = useCountUp(pct);
  const dash = (pct / 100) * circ;
  return (
    <div onClick={onClick} className="relative flex flex-col p-1.5 rounded-xl border border-border/40 min-h-[62px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all pressable"
      style={{ background: 'linear-gradient(135deg, hsl(155 60% 44% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-habits-today"
      role="button" tabIndex={0} aria-label="Habits today" onKeyDown={onEnterOrSpace(onClick)}>
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(155 60% 44%), transparent)' }} />
      <div className="flex items-start justify-between gap-2 relative z-10">
        <div>
          <div className="text-sm font-bold metric-value tracking-tight leading-none mt-1" style={{ color: 'hsl(155 60% 44%)' }}>{animatedPct}%</div>
          <p className="micro-label text-muted-foreground/70 mt-0.5">Habits Today</p>
          <p className="text-[11px] text-muted-foreground/60">{totalHabits} tracked</p>
        </div>
        {/* Donut ring */}
        <svg width="36" height="36" className="shrink-0 -rotate-90 mt-0.5">
          <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="3" />
          <circle cx="18" cy="18" r={r} fill="none" stroke="hsl(155 60% 44%)" strokeWidth="3"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.8s cubic-bezier(0.34,1.56,0.64,1)' }} />
        </svg>
      </div>
    </div>
  );
}

function KPIJournalCard({ streak, mood, onClick }: { streak: number; mood: string | null; onClick: () => void }) {
  const animatedStreak = useCountUp(streak);
  const dots = Array.from({length:7}, (_,i) => i >= (7 - Math.min(streak, 7)));
  const moodConf = mood ? MOOD_CONFIG[mood as MoodLevel] : null;
  return (
    <div onClick={onClick} className="relative flex flex-col p-1.5 rounded-xl border border-border/40 min-h-[62px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all pressable"
      style={{ background: 'linear-gradient(135deg, hsl(310 50% 58% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-journal-streak"
      role="button" tabIndex={0} aria-label="Journal streak" onKeyDown={onEnterOrSpace(onClick)}>
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(310 50% 58%), transparent)' }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: 'hsl(310 50% 58% / 0.15)' }}>
          <BookHeart className="h-3.5 w-3.5" style={{ color: moodConf?.color || 'hsl(310 50% 58%)' }} />
        </div>
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-sm font-bold metric-value tracking-tight leading-none" style={{ color: moodConf?.color || 'hsl(310 50% 58%)' }}>{animatedStreak}d</span>
      </div>
      <p className="micro-label text-muted-foreground/70 mt-0.5 relative z-10">Journal Streak</p>
      <p className="text-[11px] text-muted-foreground/60 mt-0.5 relative z-10 truncate">{streak > 0 ? `${streak}-day streak!` : "Keep it going!"}</p>
      {/* 7-day dots */}
      <div className="flex gap-0.5 mt-1.5 relative z-10">
        {dots.map((filled, i) => (
          <div key={i} className="flex-1 h-1.5 rounded-full" style={{ background: filled ? `hsl(310 50% 58%)` : 'hsl(var(--muted))' }} />
        ))}
      </div>
    </div>
  );
}

function KPIDocsCard({ docs, onClick }: { docs: any[]; onClick: () => void }) {
  const expiredCount = (docs || []).filter(d => normalizeFilter(d.status) === normalizeFilter('expired')).length;
  const mostOverdue = (docs || []).filter(d => d.daysUntil < 0).sort((a,b) => a.daysUntil - b.daysUntil)[0];
  const isUrgent = expiredCount > 0;
  const count = (docs || []).length;
  // Color discipline: red ONLY for genuinely overdue documents. The calm/empty
  // state is blue (all-clear) — the popup is where the user takes action.
  const accent = isUrgent ? '0 72% 52%' : '205 90% 58%';
  return (
    <div onClick={onClick} className="relative flex flex-col p-1.5 rounded-xl border overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all pressable"
      style={{ background: `linear-gradient(135deg, hsl(${accent} / 0.12) 0%, transparent 60%)`, borderColor: isUrgent ? 'hsl(0 72% 52% / 0.4)' : 'hsl(var(--border) / 0.4)' }}
      data-testid="stat-card-expiring-docs"
      role="button" tabIndex={0} aria-label="Expiring documents" onKeyDown={onEnterOrSpace(onClick)}>
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: `linear-gradient(90deg, hsl(${accent}), transparent)` }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: `hsl(${accent} / 0.15)` }}>
          <FileWarning className="h-3.5 w-3.5" style={{ color: `hsl(${accent})` }} />
        </div>
        {isUrgent && <span className="text-[11px] font-bold text-red-500 bg-red-500/10 px-1 py-0.5 rounded">{expiredCount} EXPIRED</span>}
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-sm font-bold metric-value tracking-tight leading-none tabular-nums" style={{ color: `hsl(${accent})` }}>{(docs || []).length}</span>
      </div>
      <p className="micro-label text-muted-foreground/70 mt-0.5 relative z-10">Expiring Docs</p>
      {count === 0 ? (
        <p className="text-[11px] mt-0.5 relative z-10 truncate flex items-center gap-1" style={{ color: `hsl(${accent})` }}>
          <CheckCircle2 className="h-2.5 w-2.5" /> You're all set!
        </p>
      ) : mostOverdue ? (
        <p className="text-[11px] text-red-500 mt-0.5 relative z-10 truncate tabular-nums">
          Tap to snooze · {Math.abs(mostOverdue.daysUntil)}d overdue
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground/60 mt-0.5 relative z-10 truncate">{count} expiring soon</p>
      )}
      {isUrgent && (
        <div className="mt-1.5 relative z-10">
          <div className="h-1 rounded-full overflow-hidden" style={{ background: 'hsl(0 72% 52% / 0.2)' }}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, (expiredCount / Math.max(docs.length, 1)) * 100)}%`, background: 'hsl(0 72% 52%)' }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Section: Hero KPIs (Net Worth / Budget / Cash Flow) ────────────────────
// These are the three financial signals that matter most. Promoted to their
// own row at the very top of the dashboard (under AI Summary). The smaller
// KPISection below becomes a secondary chip row of habits/tasks/journal/docs.

function HeroKPISection({ enhanced, stats, filterMode, filterIds, allProfiles, refetching = false, hideBudget = false }: {
  enhanced: any;
  stats: DashboardStats | undefined;
  filterMode: string;
  filterIds: string[];
  allProfiles?: any[];
  refetching?: boolean;
  hideBudget?: boolean;
}) {
  const [, navigate] = useLocation();
  const [heroPopup, setHeroPopup] = useState<"networth" | "cashflow" | "budget" | null>(null);
  // BUG (2026-06-26): the "Updating filter…" badge + 60% dim was wired straight
  // to react-query's isFetching, so a slow/cold fetch (a minute+) left the whole
  // hero greyed out and the badge spinning the entire time — it read as the UI
  // breaking. Cap the indicator: show it only while actually fetching, but never
  // for more than ~3.5s, so a long cold start quietly resolves instead of
  // looking stuck. (The numbers under it stay visible; only the chrome dims.)
  const [showRefetch, setShowRefetch] = useState(false);
  useEffect(() => {
    if (!refetching) { setShowRefetch(false); return; }
    setShowRefetch(true);
    const t = setTimeout(() => setShowRefetch(false), 3500);
    return () => clearTimeout(t);
  }, [refetching]);
  const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const trailing = filterMode === "selected" && filterIds.length > 0 ? `&profileIds=${filterIds.join(",")}` : "";
  const leading = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // Round-6 fix (BUG-003/004/015): Hero KPI tile previously used
  // enhanced.financeSnapshot.totalAssetValue (server-computed) while the Finance
  // section tile and the Net Worth popup compute from allProfiles client-side.
  // That divergence produced the $10 / $11K drift the user reported. Pull from
  // the same /api/profiles data the Net Worth popup uses so all three Net Worth
  // surfaces (Hero KPI, Finance section, Net Worth popup) agree to the dollar.
  // P1 dedupe (QA scorecard): /api/profiles is now fetched ONCE by the page
  // component and passed down — no per-section useQuery copies.
  // BUG-20260528-budget-keep-previous-leak: budgetSummary must NOT inherit the
  // previous filter's totals during a filter swap. Default queryClient has
  // placeholderData: keepPreviousData which made a fresh profile (Lexi, no
  // budgets, no expenses except $50) show "2% of $2,650" — the $2,650 came
  // from the prior Everyone/Self filter that was still cached. Setting
  // placeholderData: undefined here forces budgetSummary to show the loading
  // state during swap and snap to the correct $0 when the new query lands.
  const { data: budgetSummary, isSuccess: budgetLoaded } = useQuery<{ totalBudget: number; totalSpent: number; remaining: number }>({
    queryKey: ["/api/budgets/summary", currentMonth, filterMode, ...filterIds, "hero"],
    queryFn: async () => {
      const [budgetRes, expensesRes] = await Promise.all([
        apiRequest("GET", `/api/budgets?month=${currentMonth}${trailing}`).then(r => r.json()),
        apiRequest("GET", `/api/expenses${leading}`).then(r => r.json()),
      ]);
      const budgets = budgetRes.budgets || [];
      const allExpenses = Array.isArray(expensesRes) ? expensesRes : (expensesRes.items || []);
      const monthExpenses = allExpenses.filter((e: any) => e.date?.startsWith(currentMonth));
      const totalBudget = budgets.reduce((s: number, b: any) => s + b.amount, 0);
      const totalSpent = monthExpenses.reduce((s: number, e: any) => s + e.amount, 0);
      return { totalBudget, totalSpent, remaining: totalBudget - totalSpent };
    },
    staleTime: 30_000,
    placeholderData: undefined,
  });

  // Income query for cash flow
  // BUG-20260528-budget-keep-previous-leak: same fix as budgetSummary so the
  // Cash Flow "In $X" doesn't carry the previous filter's incomes when swapping
  // to a fresh profile.
  const { data: incomesRaw, isSuccess: incomesLoaded } = useQuery<any[]>({
    queryKey: ["/api/incomes", filterMode, ...filterIds, "hero"],
    queryFn: () => apiRequest("GET", `/api/incomes${leading}`).then(r => r.json()),
    staleTime: 60_000,
    placeholderData: undefined,
  });
  const incomes = Array.isArray(incomesRaw) ? incomesRaw : (incomesRaw as any)?.items || [];

  // Co-ownership link tables: a profile passes the filter when the selected
  // profile is a co-owner via asset_party_links / liability_profile_links,
  // not only when it's the profile itself or its direct parent.
  const { data: assetPartyLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/asset-party-links"],
    queryFn: () => apiRequest("GET", "/api/asset-party-links").then(r => r.json()),
  });
  const { data: liabilityProfileLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/liability-profile-links"],
    queryFn: () => apiRequest("GET", "/api/liability-profile-links").then(r => r.json()),
  });

  // Filter helper shared by asset + liability roll-ups. P4.1 remediation: the
  // previous hand-rolled predicate only checked profile.id + parentProfileId,
  // missing co-owners from the link tables. Route through the canonical
  // ownerCandidatesForProfile + isInScope primitives (shared/scope.ts) — the
  // same candidate set the server's finance snapshot and the Net Worth popup
  // consume — so the surfaces stay in lock-step.
  const emptySelfIds = useMemo(() => new Set<string>(), []);
  const matchesProfileFilter = (p: any): boolean => {
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    return isInScope(
      ownerCandidatesForProfile(p, assetPartyLinks, liabilityProfileLinks, allProfiles),
      { selectedIds: filterIds, selfIds: emptySelfIds },
      "out_of_scope",
    );
  };
  const heroAssetProfiles = useMemo(
    () => (allProfiles || []).filter((p: any) => resolveAssetValue(p) > 0 && matchesProfileFilter(p)),
    [allProfiles, filterMode, filterIds.join(","), assetPartyLinks, liabilityProfileLinks]
  );
  const heroLiabilityProfiles = useMemo(
    // Recurring service bills are excluded from balance-sheet debt (matches the
    // server finance snapshot); only real debt counts toward Net Worth.
    () => (allProfiles || []).filter((p: any) => isNetWorthLiabilityProfile(p) && resolveLiabilityBalance(p) > 0 && matchesProfileFilter(p)),
    [allProfiles, filterMode, filterIds.join(","), assetPartyLinks, liabilityProfileLinks]
  );
  // BUG-20260528-networth-filter-leakage: when a profile filter is active,
  // trust the server's authoritative finance snapshot. The client-side
  // matchesProfileFilter above only checks DIRECT parent_profile_id; it
  // misses grandparents (e.g. Bob → Home → MacBook) and ignores asset_party_links
  // co-ownership, so the roll-up showed Bob's Net Worth as $367k while the
  // server's getDashboardEnhanced (which walks the same tables the popup uses)
  // correctly returned $175k. The Everyone case keeps the client roll-up so
  // we can show an animated number before /api/dashboard-enhanced resolves.
  const filterActive = filterMode === "selected" && filterIds.length > 0;
  // BUG-20260530-hero-flash: during a filter swap there's a sub-second window
  // where `enhanced` (the new profile's server-computed snapshot) is still
  // in flight. The previous logic fell back to a client-side roll-up off
  // `heroAssetProfiles`, which could briefly compute a non-zero value for a
  // profile that should be $0 (e.g. shared-ownership rounding, lingering
  // co-owner pointers). When a filter is active, prefer 0 over the client
  // roll-up so the hero card never flashes a stale-looking number while the
  // authoritative server response is pending — it'll snap to the correct
  // value in <300ms.
  // NW-5: the Net Worth tile must consume the server's filtered finance
  // snapshot as the source of truth (same numbers the drilldown popup and AI
  // Summary use), not a divergent client roll-up. When a filter is active we
  // already trust the server. For Everyone, prefer the server snapshot once
  // `enhanced` has resolved; the client roll-up is used only as a pre-resolve
  // animation source to avoid a $0 flash before the first response lands.
  //
  // NW-6 (QA 2026-07-25, "$150 difference on the same screen"): the tile used
  // to read `financeSnapshot.totalAssetValue` straight off the wire while the
  // Net Worth popup filtered synthetic test rows out and re-summed. Both now
  // go through `netWorthView`, the one client derivation, whose totals are by
  // construction the sum of the rows the popup lists.
  const financeSnap = enhanced?.financeSnapshot;
  const showTestDataKpi = useShowTestData();
  const sheet = useMemo(() => netWorthView(financeSnap, showTestDataKpi), [financeSnap, showTestDataKpi]);
  const netWorthLoaded = isNetWorthLoaded(financeSnap);
  const heroDerivedAssets = useMemo(
    () => (allProfiles ? heroAssetProfiles.reduce((s, p) => s + resolveAssetValue(p), 0) : 0),
    [allProfiles, heroAssetProfiles],
  );
  const heroDerivedLiabilities = useMemo(
    () => (allProfiles ? heroLiabilityProfiles.reduce((s, p) => s + resolveLiabilityBalance(p), 0) : 0),
    [allProfiles, heroLiabilityProfiles],
  );
  const heroEnhancedKey = useMemo(
    () => ["/api/dashboard-enhanced", filterMode, ...filterIds],
    [filterMode, filterIds],
  );
  // Once the server snapshot has landed it owns the level, and the client walk
  // supplies only the movement since — so a payment or a revaluation shows on
  // this tile as soon as the write returns, instead of after the aggregate
  // recompute. Before it lands, nothing has changed: an active filter still
  // shows 0 rather than risk a client roll-up that flashes the wrong number.
  const liveAssets = useLiveTotal(netWorthLoaded ? sheet.totalAssets : undefined, heroDerivedAssets, heroEnhancedKey);
  const liveLiabilities = useLiveTotal(netWorthLoaded ? sheet.totalLiabilities : undefined, heroDerivedLiabilities, heroEnhancedKey);
  const totalAssetValue = netWorthLoaded ? liveAssets : filterActive ? 0 : heroDerivedAssets;
  const totalLiabilities = netWorthLoaded ? liveLiabilities : filterActive ? 0 : heroDerivedLiabilities;
  const netWorth = totalAssetValue - totalLiabilities;
  // P6.1: the stats fallback is safe — /api/stats monthlySpend and
  // /api/dashboard-enhanced totalMonthlySpend are computed from the same
  // passesProfileFilter-scoped expense set with the same user-TZ month
  // window (supabase-storage.ts getStats/getDashboardEnhanced), so the
  // value cannot flip as the two endpoints race.
  const monthlySpend = enhanced?.financeSnapshot?.totalMonthlySpend ?? stats?.monthlySpend ?? 0;
  const monthlyIncome = sumMonthlyIncomeNow(incomes, BROWSER_TIMEZONE);
  // BUG (user report: tile "Out $0" while the Cash Flow popup said "Out $1,020"):
  // the tile only counted logged expenses; the popup counts recurring bills too.
  // Use the SAME definition as the popup: Out = month expenses + monthlyized
  // active obligations (financeSnapshot.monthlyObligationTotal).
  const monthlyRecurringOut = enhanced?.financeSnapshot?.monthlyObligationTotal ?? 0;
  const monthlyOut = monthlySpend + monthlyRecurringOut;
  const cashFlow = monthlyIncome - monthlyOut;
  // BUG (QA 2026-07-25): the tile flashed -$7,253 → +$28,247 → -$7,651 →
  // +$27,849 before settling. Cash flow is In minus Out, and its three inputs
  // land on three different ticks: `incomes` (In), `totalMonthlySpend` and
  // `monthlyObligationTotal` (Out). Each missing input defaulted to 0, so every
  // intermediate render published a WRONG total that looked final — a
  // half-loaded sum with a dollar sign is indistinguishable from an answer.
  // Gate the tile on all three: until then it shows a skeleton, not a number.
  const cashFlowReady = incomesLoaded && enhanced?.financeSnapshot != null;
  const totalBudget = budgetSummary?.totalBudget ?? 0;
  const totalSpent = budgetSummary?.totalSpent ?? 0;
  const budgetPct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  const budgetBreached = budgetPct > 100;
  // PR R: if the (scoped) user has no budget defined, hide the BUDGET tile entirely.
  // The previous behavior rendered "0% of $0" which read as a real metric and made
  // people think every profile had a budget. The tile can still be re-enabled the
  // moment a budget exists by setting one in BudgetPopup.
  // BUG (2026-06-26, user report "my budget disappeared"): the Budget hero card
  // was gated purely on `totalBudget <= 0`. While the budget query is still in
  // flight (cold serverless start can take a minute+), `budgetSummary` is
  // undefined → totalBudget 0 → the whole card VANISHES, then pops back when the
  // fetch lands. That reads as the UI breaking. Fix: only treat 0 as "no budget"
  // once we have a SUCCESSFUL response (budgetLoaded). Until then we reserve the
  // slot with a skeleton (budgetPending) so nothing disappears mid-scroll.
  const effectiveHideBudget = hideBudget || (budgetLoaded && totalBudget <= 0);
  const budgetPending = !hideBudget && !budgetLoaded;

  // BUG (2026-06-10, user report): Math.max(0, ...) clamped NEGATIVE net worth
  // to a permanent "$0" while the sub-label showed the real assets/liabilities.
  // Animate the magnitude and render the sign + color separately.
  const netWorthNegative = netWorth < 0;
  const animatedNetWorth = useCountUp(Math.abs(Math.round(netWorth)));
  const animatedBudget = useCountUp(budgetPct);
  const animatedCashFlow = useCountUp(Math.round(Math.abs(cashFlow)));

  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

  // ── Hero redesign data ──────────────────────────────────────────────────
  // Privacy toggle (eye icon) masks every money figure in the hero.
  const [hideAmounts, setHideAmounts] = useState(false);
  // Not a formatter — a privacy wrapper. The eye toggle masks every hero
  // figure, so this stays a function; only the formatting delegates out.
  const money = (n: number) => (hideAmounts ? "••••" : formatMoneyRound(n));
  // Net-worth snapshot history powers the hero trend line + the month-over-month %.
  const histUrl = leading
    ? `/api/net-worth/history${leading}&lookbackDays=120`
    : `/api/net-worth/history?lookbackDays=120`;
  const { data: nwHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/net-worth/history", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", histUrl).then(r => r.json()).catch(() => []),
    staleTime: 60_000,
  });
  const nwSeries = useMemo(() => {
    const rows = Array.isArray(nwHistory) ? [...nwHistory] : [];
    rows.sort((a, b) => String(a.snapshotDate).localeCompare(String(b.snapshotDate)));
    const pts = rows.map((r: any) => Number(r.netWorth) || 0);
    // Pin the last point to the live net worth so the line agrees with the headline.
    if (pts.length === 0) return [netWorth];
    pts[pts.length - 1] = netWorth;
    return pts;
  }, [nwHistory, netWorth]);
  const nwTrend = useMemo(() => {
    if (nwSeries.length < 2) return null;
    const first = nwSeries[0], last = nwSeries[nwSeries.length - 1];
    if (!isFinite(first) || !isFinite(last)) return null;
    const delta = last - first;
    if (delta === 0) return null;
    // BUG-4: a month-over-month % is only meaningful when the baseline is a
    // non-trivial amount AND the series doesn't cross zero. A near-zero baseline
    // divides into an absurd percentage, and a sign flip (e.g. +$1 → -$32k) makes
    // "% change" nonsensical (it reads as "-109.9%"). In those cases show the
    // dollar delta instead of a misleading percentage.
    const baselineTooSmall = Math.abs(first) < 1;
    const signFlipped = (first < 0) !== (last < 0);
    const pct = baselineTooSmall || signFlipped ? null : (delta / Math.abs(first)) * 100;
    return { pct, up: delta >= 0, delta };
  }, [nwSeries]);
  const nwPath = useMemo(() => {
    const s = nwSeries.length >= 2 ? nwSeries : [netWorth, netWorth];
    const min = Math.min(...s), max = Math.max(...s), span = (max - min) || 1;
    const W = 160, H = 52;
    return s.map((v, i) => {
      const x = (i / (s.length - 1)) * W;
      const y = H - ((v - min) / span) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${(y + 2).toFixed(1)}`;
    }).join(" ");
  }, [nwSeries, netWorth]);
  // Last 7 days of real net cash flow (per-day income baseline − that day's spend).
  const weekBars = useMemo(() => {
    const recs: any[] = enhanced?.financeSnapshot?.monthlyExpenseRecords || [];
    const perDayIncome = monthlyIncome / 30;
    const dow = ["S", "M", "T", "W", "T", "F", "S"];
    const today = new Date();
    const out: { label: string; net: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(today.getDate() - i);
      const key = d.toLocaleDateString("en-CA");
      const spent = recs.filter((e) => String(e.date || "").slice(0, 10) === key)
        .reduce((s, e) => s + (Number(e.amount) || 0), 0);
      out.push({ label: dow[d.getDay()], net: perDayIncome - spent });
    }
    return out;
  }, [enhanced, monthlyIncome]);
  const weekMax = Math.max(1, ...weekBars.map((b) => Math.abs(b.net)));
  const budgetRemaining = Math.max(0, totalBudget - totalSpent);

  return (
    <div className="relative">
      {/* NW-16: subtle refetch indicator so the user sees the tiles are
          updating during a filter switch instead of staring at stale numbers. */}
      {showRefetch && (
        <div
          className="absolute top-1 right-1 z-10 flex items-center gap-1.5 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm border border-border/50 animate-pulse"
          data-testid="hero-kpi-refetching"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary/70" />
          Updating…
        </div>
      )}
      <div className={`mb-2 space-y-2.5 transition-opacity duration-200 ${showRefetch ? "opacity-60" : "opacity-100"}`}>
      {/* ───── NET WORTH HERO ───── */}
      <button
        type="button"
        onClick={() => setHeroPopup("networth")}
        className="relative w-full overflow-hidden rounded-2xl border border-border/50 p-4 text-left card-lift active:scale-[0.99] transition-all"
        style={{ background: 'radial-gradient(130% 150% at 88% -10%, hsl(265 70% 32% / 0.55) 0%, hsl(232 55% 16% / 0.6) 42%, hsl(222 47% 9%) 100%)' }}
        data-testid="hero-kpi-net-worth"
      >
        {/* aurora glow */}
        <div className="pointer-events-none absolute -right-12 -top-20 h-52 w-52 rounded-full opacity-50 blur-3xl" style={{ background: 'radial-gradient(circle, hsl(285 85% 60% / 0.7), transparent 70%)' }} />
        {/* live net-worth trend line */}
        <svg className="pointer-events-none absolute right-4 top-9 h-14 w-40 overflow-visible" viewBox="0 0 160 56" fill="none" preserveAspectRatio="none">
          <defs>
            <linearGradient id="nwLine" x1="0" y1="0" x2="160" y2="0" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="hsl(190 90% 62%)" />
              <stop offset="100%" stopColor="hsl(312 90% 66%)" />
            </linearGradient>
          </defs>
          <path d={nwPath} stroke="url(#nwLine)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 6px hsl(305 90% 60% / 0.65))' }} />
        </svg>

        <div className="relative z-10 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/55">Net Worth</span>
            <span
              role="button" tabIndex={0} aria-label={hideAmounts ? "Show amounts" : "Hide amounts"}
              onClick={(e) => { e.stopPropagation(); setHideAmounts(v => !v); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setHideAmounts(v => !v); } }}
              className="cursor-pointer text-white/45 transition-colors hover:text-white/80"
            >
              {hideAmounts ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </span>
          </div>
          <span className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/75 backdrop-blur-sm">
            This Month <ChevronDown className="h-3 w-3" />
          </span>
        </div>

        <div className="relative z-10 mt-2">
          <span className="text-4xl font-bold tracking-tight tabular-nums" style={{ color: netWorthNegative ? 'hsl(0 85% 68%)' : 'hsl(155 70% 55%)' }}>
            {hideAmounts ? "••••••" : `${netWorthNegative ? "-" : ""}$${fmt(animatedNetWorth)}`}
          </span>
          {nwTrend && (
            <div className="mt-1 flex items-center gap-1 text-[12px] font-medium" style={{ color: nwTrend.up ? 'hsl(155 70% 55%)' : 'hsl(0 85% 68%)' }}>
              {nwTrend.up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              {nwTrend.pct != null
                ? <>{Math.abs(nwTrend.pct).toFixed(1)}% <span className="font-normal text-white/45">vs last month</span></>
                : <>{nwTrend.delta >= 0 ? "+" : "−"}${fmt(Math.abs(nwTrend.delta))} <span className="font-normal text-white/45">vs last month</span></>}
            </div>
          )}
        </div>

        <div className="relative z-10 mt-3 flex gap-2">
          <div className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 backdrop-blur-sm">
            <p className="micro-label text-white/45">Assets</p>
            <p className="text-base font-bold tabular-nums" style={{ color: 'hsl(155 70% 58%)' }}>{money(totalAssetValue)}</p>
          </div>
          <div className="flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 backdrop-blur-sm">
            <p className="micro-label text-white/45">Liabilities</p>
            <p className="text-base font-bold tabular-nums" style={{ color: 'hsl(270 80% 74%)' }}>{money(totalLiabilities)}</p>
          </div>
        </div>
      </button>

      {/* ───── CASH FLOW + BUDGET ───── */}
      <div className={`grid gap-2.5 ${effectiveHideBudget ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
        {/* CASH FLOW */}
        <button
          type="button"
          onClick={() => setHeroPopup("cashflow")}
          className="relative flex flex-col overflow-hidden rounded-2xl border border-border/50 p-4 text-left card-lift active:scale-[0.98] transition-all"
          style={{ background: 'linear-gradient(150deg, hsl(200 70% 50% / 0.10) 0%, transparent 55%)' }}
          data-testid="hero-kpi-cash-flow"
        >
          <div className="flex items-center gap-2">
            <div className="icon-badge" style={{ background: 'hsl(200 80% 52% / 0.16)' }}>
              {cashFlow >= 0
                ? <TrendingUp className="h-4 w-4" style={{ color: 'hsl(200 80% 60%)' }} />
                : <TrendingDown className="h-4 w-4" style={{ color: 'hsl(0 80% 62%)' }} />}
            </div>
            <span className="micro-label text-muted-foreground/70">Cash Flow</span>
          </div>
          {/* A partially-loaded sum is not a smaller number — it is the WRONG
              number. Hold the skeleton until In and Out have both landed
              (see `cashFlowReady`) rather than publishing an intermediate. */}
          {!cashFlowReady ? (
            <>
              <div className="mt-2 h-8 w-32 rounded-md bg-muted/60 animate-pulse" data-testid="hero-cash-flow-loading" />
              <div className="mt-1 h-3 w-40 rounded bg-muted/40 animate-pulse" />
            </>
          ) : (
            <>
              <div className="mt-2 text-2xl font-bold tabular-nums" style={{ color: cashFlow >= 0 ? 'hsl(155 65% 50%)' : 'hsl(0 80% 62%)' }}>
                {hideAmounts ? "••••" : `${cashFlow >= 0 ? '+' : '−'}$${fmt(animatedCashFlow)}`}
              </div>
              <div className="mt-0.5 flex items-center gap-2.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'hsl(155 65% 50%)' }} />In {money(monthlyIncome)}</span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'hsl(0 80% 62%)' }} />Out {money(monthlyOut)}</span>
              </div>
            </>
          )}
          <div className="mt-2.5 flex items-end gap-1.5">
            {weekBars.map((b, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1">
                <div className="flex w-full items-end justify-center" style={{ height: 32 }}>
                  <div className="w-full rounded-md transition-all duration-500" style={{ height: `${Math.max(8, (Math.abs(b.net) / weekMax) * 100)}%`, background: b.net >= 0 ? 'hsl(155 60% 48%)' : 'hsl(0 78% 60%)' }} />
                </div>
                <span className="text-[11px] text-muted-foreground/50">{b.label}</span>
              </div>
            ))}
          </div>
          <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-primary">View Cash Flow <ArrowRight className="h-3 w-3" /></span>
        </button>

        {/* BUDGET — skeleton placeholder while the query is still loading so the
            card never vanishes mid-scroll on a slow/cold start. */}
        {budgetPending && (
          <div
            className="relative flex flex-col overflow-hidden rounded-2xl border border-border/50 p-4"
            style={{ background: 'linear-gradient(150deg, hsl(155 60% 44% / 0.06) 0%, transparent 55%)' }}
            data-testid="hero-kpi-budget-skeleton"
            aria-hidden
          >
            <div className="flex items-center gap-2">
              <div className="icon-badge" style={{ background: 'hsl(155 60% 44% / 0.12)' }}>
                <Target className="h-4 w-4" style={{ color: 'hsl(155 65% 50% / 0.5)' }} />
              </div>
              <span className="micro-label text-muted-foreground/50">Budget</span>
            </div>
            <div className="mt-3 h-7 w-24 rounded bg-muted/40 animate-pulse" />
            <div className="mt-2 h-3 w-20 rounded bg-muted/30 animate-pulse" />
            <div className="mt-3 h-3 w-28 rounded bg-muted/20 animate-pulse" />
          </div>
        )}
        {!effectiveHideBudget && !budgetPending && (
        <button
          type="button"
          onClick={() => setHeroPopup("budget")}
          className="relative flex flex-col overflow-hidden rounded-2xl border border-border/50 p-4 text-left card-lift active:scale-[0.98] transition-all"
          style={{ background: 'linear-gradient(150deg, hsl(155 60% 44% / 0.10) 0%, transparent 55%)' }}
          data-testid="hero-kpi-budget"
        >
          <div className="flex items-center gap-2">
            <div className="icon-badge" style={{ background: budgetBreached ? 'hsl(0 72% 52% / 0.16)' : 'hsl(155 60% 44% / 0.16)' }}>
              <Target className="h-4 w-4" style={{ color: budgetBreached ? 'hsl(0 72% 55%)' : 'hsl(155 65% 50%)' }} />
            </div>
            <span className="micro-label text-muted-foreground/70">Budget</span>
            {budgetBreached && <span className="ml-auto rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-bold text-red-500">OVER</span>}
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="min-w-0">
              <div className="text-2xl font-bold tabular-nums" style={{ color: budgetBreached ? 'hsl(0 72% 58%)' : 'hsl(155 65% 50%)' }}>{animatedBudget}%</div>
              <p className="text-[11px] text-muted-foreground">of {money(totalBudget)}</p>
            </div>
            <svg width="72" height="72" className="ml-auto shrink-0 -rotate-90">
              <circle cx="36" cy="36" r="29" fill="none" stroke="hsl(var(--muted))" strokeWidth="7" />
              <circle cx="36" cy="36" r="29" fill="none" stroke={budgetBreached ? 'hsl(0 72% 55%)' : 'hsl(155 65% 50%)'} strokeWidth="7" strokeLinecap="round"
                strokeDasharray={`${(Math.min(100, budgetPct) / 100) * (2 * Math.PI * 29)} ${2 * Math.PI * 29}`}
                style={{ transition: 'stroke-dasharray 0.8s cubic-bezier(0.34,1.56,0.64,1)' }} />
            </svg>
          </div>
          <div className="mt-2 flex items-center gap-5 text-[11px]">
            <div><p className="text-muted-foreground">Remaining</p><p className="font-bold tabular-nums" style={{ color: 'hsl(155 65% 50%)' }}>{money(budgetRemaining)}</p></div>
            <div><p className="text-muted-foreground">Spent</p><p className="font-bold tabular-nums">{money(totalSpent)}</p></div>
          </div>
          <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-primary">View Budget <ArrowRight className="h-3 w-3" /></span>
        </button>
        )}
      </div>
      </div>

      {/* Hero KPI Popups */}
      <NetWorthPopup
        open={heroPopup === "networth"}
        onOpenChange={(o) => setHeroPopup(o ? "networth" : null)}
        filterMode={(filterMode as "all" | "selected" | "everyone")}
        filterIds={filterIds}
      />
      <CashFlowView
        open={heroPopup === "cashflow"}
        onOpenChange={(o: boolean) => setHeroPopup(o ? "cashflow" : null)}
        filterMode={filterMode}
        filterIds={filterIds}
      />
      <BudgetPopup
        open={heroPopup === "budget"}
        onOpenChange={(o) => setHeroPopup(o ? "budget" : null)}
        filterMode={(filterMode as "all" | "selected" | "everyone")}
        filterIds={filterIds}
        monthlyIncome={monthlyIncome}
      />
    </div>
  );
}

// ─── Section: KPI Stats ──────────────────────────────────────────────────────

// Per-document 30-day snooze moved to lib/docSnooze.ts so the briefing's
// Document Expirations popup shares the same dismiss state as this KPI section.

function KPISection({ stats, enhanced, filterIds = [], filterMode = "everyone", allProfiles }: { stats: DashboardStats; enhanced: any; filterIds?: string[]; filterMode?: string; allProfiles?: any[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [popup, setPopup] = useState<"spending" | "bills" | "tasks" | "docs" | "habits" | null>(null);
  // In-place quick-add from the Spending / Bills dialogs (no redirect).
  const [quickAdd, setQuickAdd] = useState<QuickAddKind | null>(null);
  // P1 dedupe (QA scorecard): profiles come from the page-level query.
  const kpiProfiles = allProfiles ?? [];
  const kpiOwnerId = useMemo(() => {
    if (filterMode === "selected" && filterIds.length === 1) return filterIds[0];
    return (kpiProfiles.find((p: any) => p.type === "self")?.id) || "";
  }, [filterMode, filterIds, kpiProfiles]);
  const [docSnoozeMap, setDocSnoozeMap] = useState<Record<string, number>>(() => loadDocSnoozeMap());
  const snoozeDoc = (docIdOrRow: string | { ruleIds?: string[]; ruleId?: string }) => {
    // A card can stand for several rules (one record, one day, two kinds of
    // date). Snoozing only the first left its twin on screen.
    const ids = typeof docIdOrRow === "string" ? [docIdOrRow] : ruleIdsOf(docIdOrRow as any);
    if (ids.length === 0) return;
    const until = Date.now() + 30 * 86400000;
    const next = { ...docSnoozeMap };
    for (const id of ids) next[id] = until;
    setDocSnoozeMap(next);
    saveDocSnoozeMap(next);
    toast({ title: "Document snoozed", description: "Hidden from alerts for 30 days" });
  };
  const visibleDocs: any[] = useMemo(() => {
    // Per RULE, now that one record can carry several expirations — and still
    // honouring a record-id snooze taken before that was true. Keying on the
    // record alone left a dismissed row visible here while the popup and the
    // Executive section both hid it.
    // Grouped to ONE CARD PER RECORD PER DAY, the same way the popup renders
    // them, so the KPI badge counts what the list shows. Ungrouped, a policy
    // that expires and takes its premium on one day read as two documents.
    return groupDocumentDates(
      (enhanced?.expiringDocuments || [])
        .filter((d: any) => !docSnoozeMap[d.ruleId] && !docSnoozeMap[d.documentId]),
    );
  }, [enhanced, docSnoozeMap]);

  // BUG-20260530-stats-slow-blank-tiles: when /api/stats is slow (8-12s cold
  // for sparse profiles like Craig because the server iterates all storage
  // tables anyway), `stats` is undefined for that whole window. Returning
  // null left the entire KPI grid as 4 empty skeleton boxes — looked broken.
  // Instead render with zero defaults so the user sees "0 tasks, $0 spend,
  // 0 bills" immediately; values update in place when stats lands.
  const safeStats: any = stats || {
    activeTasks: 0,
    monthlySpend: 0,
    habitCompletionRate: 0,
    totalHabits: 0,
    journalStreak: 0,
    currentMood: null,
    upcomingObligations: 0,
    monthlyObligationTotal: 0,
  };

  const finSnap = enhanced?.financeSnapshot;
  const spendTrend: "up" | "down" | "flat" = finSnap?.spendTrend > 0 ? "up" : finSnap?.spendTrend < 0 ? "down" : "flat";

  const moodConf = safeStats.currentMood ? MOOD_CONFIG[safeStats.currentMood as keyof typeof MOOD_CONFIG] : null;

  return (
    <>
      <div className="bubble backdrop-blur-sm px-2 py-2" data-testid="section-kpis">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
          <KPITaskCard count={safeStats.activeTasks} onClick={() => setPopup("tasks")} />
          {/* Bug fix: prefer financeSnapshot.totalMonthlySpend (same source as the drilldown popup)
               over stats.monthlySpend (/api/stats) so the KPI card and popup show identical totals. */}
          <KPISpendCard amount={enhanced?.financeSnapshot?.totalMonthlySpend ?? safeStats?.monthlySpend ?? 0} trend={spendTrend} enhanced={enhanced} onClick={() => setPopup("spending")} />
          <KPIHabitsCard completionPct={safeStats.habitCompletionRate} totalHabits={safeStats.totalHabits} onClick={() => setPopup("habits")} />
          <KPIJournalCard streak={safeStats.journalStreak} mood={safeStats.currentMood || null} onClick={() => navigate("/dashboard/journal")} />
          {/* Bug fix: derive bill count from the same enhanced.financeSnapshot.upcomingBills
               array the popup renders, so the count on the KPI card always matches the
               number of rows shown in the drilldown. Falls back to the legacy stats field
               for the brief window before /api/dashboard-enhanced resolves. */}
          {(() => {
            const billCount = enhanced?.financeSnapshot?.upcomingBills?.length ?? safeStats.upcomingObligations;
            return (
              <MiniStat accent="43 75% 50%" icon={CreditCard} label="Bills Due"
                value={billCount}
                sub={billCount > 0 ? "Due soon" : "All clear"}
                onClick={() => setPopup("bills")} />
            );
          })()}
          <KPIDocsCard docs={visibleDocs} onClick={() => setPopup("docs")} />
        </div>
      </div>

      {/* Spending Breakdown Popup */}
      <Dialog open={popup === "spending"} onOpenChange={(o) => { if (!o) setPopup(null); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-amber-500" />
              Spending Breakdown
            </DialogTitle>
            <DialogDescription className="text-xs">
              {(() => {
                const now = new Date();
                const monthName = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
                const dayOfMonth = now.getDate();
                const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
                return `${monthName} · day ${dayOfMonth} of ${daysInMonth}`;
              })()}
            </DialogDescription>
          </DialogHeader>
          {(() => {
            const categories = finSnap?.spendByCategory
              ? Object.entries(finSnap.spendByCategory as Record<string, number>)
                  .sort(([, a], [, b]) => (b as number) - (a as number))
              : [];
            const total = finSnap?.totalMonthlySpend || 0;
            const lastMonth = finSnap?.lastMonthTotal || 0;
            const trendPct = typeof finSnap?.spendTrend === 'number' ? finSnap.spendTrend : 0;
            const now = new Date();
            const dayOfMonth = now.getDate();
            const avgPerDay = dayOfMonth > 0 ? total / dayOfMonth : 0;
            const SPEND_COLORS = ["#06b6d4","#8b5cf6","#f59e0b","#10b981","#ef4444","#3b82f6","#f97316","#ec4899","#84cc16","#6366f1"];
            const topCategory = categories[0];
            return (
              <div className="space-y-2 py-1">
                {/* Header KPIs — only render when data exists */}
                {total > 0 && (
                  <div className="grid grid-cols-3 gap-2 p-2 rounded-lg bg-muted/40">
                    <div>
                      <p className="micro-label text-muted-foreground">Total</p>
                      <p className="text-sm font-bold tabular-nums">{formatMoney(total)}</p>
                    </div>
                    <div>
                      <p className="micro-label text-muted-foreground">Avg/day</p>
                      <p className="text-sm font-bold tabular-nums">{formatMoney(avgPerDay)}</p>
                    </div>
                    <div>
                      <p className="micro-label text-muted-foreground">Categories</p>
                      <p className="text-sm font-bold tabular-nums">{categories.length}</p>
                    </div>
                  </div>
                )}
                {/* Donut — spending by category */}
                {categories.length > 0 && total > 0 && (
                  <div className="relative h-36">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={categories.map(([cat, amt]) => ({ name: cat, value: amt as number }))}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={42}
                          outerRadius={62}
                          paddingAngle={2}
                          stroke="none"
                        >
                          {categories.map(([cat], i) => (
                            <Cell key={cat} fill={SPEND_COLORS[i % SPEND_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(v: any, n: any) => [formatMoney(v as number), n]}
                          contentStyle={{ fontSize: 11, borderRadius: 8, padding: "4px 8px" }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <p className="micro-label text-muted-foreground">Spent</p>
                      <p className="text-sm font-bold tabular-nums">{formatMoney(total)}</p>
                    </div>
                  </div>
                )}
                {/* Top category callout */}
                {topCategory && total > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-amber-500/5 border border-amber-500/20">
                    <TrendingUp className="h-3 w-3 text-amber-500 shrink-0" />
                    <span className="text-xs flex-1 truncate">
                      <span className="font-semibold capitalize">{topCategory[0]}</span> is your largest category
                    </span>
                    <span className="text-xs font-semibold text-amber-500 tabular-nums">
                      {Math.round(((topCategory[1] as number) / total) * 100)}%
                    </span>
                  </div>
                )}
                <div className="space-y-1.5 pt-1">
                  {categories.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No expenses this month</p>}
                  {categories.map(([cat, amt], i) => {
                    const pct = total > 0 ? Math.round(((amt as number) / total) * 100) : 0;
                    const color = SPEND_COLORS[i % SPEND_COLORS.length];
                    return (
                      <div key={cat} className="space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                            <span className="text-xs capitalize truncate">{cat}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">{pct}%</span>
                            <span className="text-xs font-semibold tabular-nums w-16 text-right">{formatMoney(amt as number)}</span>
                          </div>
                        </div>
                        <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Footer compare strip — only when last month data exists */}
                {lastMonth > 0 && (
                  <div className="pt-2 mt-1 border-t space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Last month total</span>
                      <span className="tabular-nums">{formatMoney(lastMonth)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Change</span>
                      <span className={`font-semibold tabular-nums ${trendPct > 0 ? 'text-red-500' : trendPct < 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
                        {trendPct > 0 ? '+' : ''}{trendPct}% ({formatMoney(total - lastMonth)})
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          <Button size="sm" className="w-full mt-1" onClick={() => setQuickAdd("expense")} data-testid="btn-spending-add-expense">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add expense
          </Button>
          <ViewPageLink href="/dashboard/finance" label="View Finance Page" />
        </DialogContent>
      </Dialog>

      {/* Bills Popup */}
      <Dialog open={popup === "bills"} onOpenChange={(o) => { if (!o) setPopup(null); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          {(() => {
            const bills = (finSnap?.upcomingBills || []) as any[];
            const total = bills.reduce((s, b) => s + (b.amount || 0), 0);
            const autopayBills = bills.filter(b => b.autopay);
            const manualBills = bills.filter(b => !b.autopay);
            const autopayTotal = autopayBills.reduce((s, b) => s + (b.amount || 0), 0);
            const manualTotal = manualBills.reduce((s, b) => s + (b.amount || 0), 0);
            const within7 = bills.filter(b => b.daysUntil >= 0 && b.daysUntil <= 7);
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-sm flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-amber-500" />
                    Upcoming Bills
                    {bills.length > 0 && <Badge variant="secondary" className="ml-1 tabular-nums">{bills.length}</Badge>}
                  </DialogTitle>
                  <DialogDescription className="text-xs">Bills due in the next 30 days</DialogDescription>
                </DialogHeader>
                {bills.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 p-2 rounded-lg bg-muted/40 mt-1">
                    <div>
                      <p className="micro-label text-muted-foreground">Total due</p>
                      <p className="text-sm font-bold tabular-nums">{formatMoney(total)}</p>
                    </div>
                    <div>
                      <p className="micro-label text-muted-foreground">Manual</p>
                      <p className="text-sm font-bold tabular-nums">{formatMoney(manualTotal)}</p>
                      <p className="text-[11px] text-muted-foreground">{manualBills.length} bill{manualBills.length !== 1 ? 's' : ''}</p>
                    </div>
                    <div>
                      <p className="micro-label text-muted-foreground">Autopay</p>
                      <p className="text-sm font-bold tabular-nums text-green-500">{formatMoney(autopayTotal)}</p>
                      <p className="text-[11px] text-muted-foreground">{autopayBills.length} bill{autopayBills.length !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                )}
                {within7.length > 0 && bills.length > 0 && (
                  <div className="flex gap-2 mt-1">
                    <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">
                      {within7.length} due this week
                    </span>
                  </div>
                )}
                <div className="overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '50vh' }}>
                  <div className="space-y-1.5 py-2">
                    {bills.slice().sort((a: any, b: any) => (a.daysUntil ?? 999) - (b.daysUntil ?? 999)).map((bill: any) => {
                      // Bills-as-liabilities: every bill is backed by a liability
                      // record. The row shows the lifecycle status and clicking
                      // opens the liability's own page (payments, history, notes).
                      const overdue = bill.status === "overdue" && !bill.autopay;
                      const dueToday = bill.status === "due_today" && !bill.autopay;
                      const soon = !overdue && !dueToday && typeof bill.daysUntil === "number" && bill.daysUntil >= 0 && bill.daysUntil <= 7 && !bill.autopay;
                      const accent = overdue ? "border-red-500/40 bg-red-500/5" : (dueToday || soon) ? "border-amber-500/30 bg-amber-500/5" : "border-border/50";
                      const textAccent = overdue ? "text-red-500" : (dueToday || soon) ? "text-amber-500" : "text-muted-foreground";
                      const statusChip = overdue
                        ? <span className="micro-label text-red-500 shrink-0">Overdue</span>
                        : dueToday
                          ? <span className="micro-label text-amber-500 shrink-0">Due today</span>
                          : <span className="micro-label text-muted-foreground/60 shrink-0">Upcoming</span>;
                      const openLiability = () => {
                        if (bill.linkedLiabilityId) { setPopup(null); navigate(`/profiles/${bill.linkedLiabilityId}`); }
                      };
                      return (
                        <div key={bill.id}
                          role={bill.linkedLiabilityId ? "button" : undefined}
                          tabIndex={bill.linkedLiabilityId ? 0 : undefined}
                          onClick={openLiability}
                          onKeyDown={(e) => { if (e.key === "Enter") openLiability(); }}
                          className={`flex items-center justify-between p-2 rounded-lg border ${accent} ${bill.linkedLiabilityId ? "cursor-pointer hover:bg-muted/40 transition-colors" : ""}`}
                          data-testid={`bill-row-${bill.id}`}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-xs font-medium truncate">{bill.name}</p>
                              {statusChip}
                              {bill.category && (
                                <span className="micro-label text-muted-foreground/60 shrink-0">
                                  {bill.category}
                                </span>
                              )}
                            </div>
                            <p className={`text-xs ${textAccent}`}>
                              {billDueLabel(bill)}
                              {bill.autopay && <span className="ml-1 text-green-500">• autopay</span>}
                            </p>
                          </div>
                          <span className="text-xs font-semibold tabular-nums shrink-0">{formatMoney(bill.amount)}</span>
                          {bill.linkedLiabilityId && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0 ml-1" />}
                        </div>
                      );
                    })}
                    {bills.length === 0 && (
                      <div className="text-center py-6">
                        <CheckCircle2 className="h-7 w-7 text-green-500/40 mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground">No bills due in the next 30 days</p>
                      </div>
                    )}
                  </div>
                </div>
                <Button size="sm" className="w-full mt-1" onClick={() => setQuickAdd("bill")} data-testid="btn-bills-add-bill">
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Add bill
                </Button>
                <ViewPageLink href="/bills" label="View all bills" />
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Tasks Popup */}
      <TasksPopup open={popup === "tasks"} onClose={() => setPopup(null)} filterIds={filterIds} filterMode={filterMode} />
      <HabitsPopup open={popup === "habits"} onClose={() => setPopup(null)} filterIds={filterIds} filterMode={filterMode} />

      {/* Expiring Documents Popup */}
      <Dialog open={popup === "docs"} onOpenChange={(o) => { if (!o) setPopup(null); }}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <FileWarning className="h-4 w-4 text-amber-500" />
              Documents Due & Expiring
              <Badge variant="secondary" className="ml-1 tabular-nums">{visibleDocs.length}</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs">
              {(() => {
                const expiredCt = visibleDocs.filter((d: any) => normalizeFilter(d.status) === normalizeFilter("expired")).length;
                const soonCt = visibleDocs.filter((d: any) => normalizeFilter(d.status) === normalizeFilter("expiring_soon")).length;
                const upcomingCt = visibleDocs.length - expiredCt - soonCt;
                const parts: string[] = [];
                if (expiredCt > 0) parts.push(`${expiredCt} expired`);
                if (soonCt > 0) parts.push(`${soonCt} expiring soon`);
                if (upcomingCt > 0) parts.push(`${upcomingCt} upcoming`);
                return parts.length > 0
                  ? `${parts.join(" · ")}. Tap to view, snooze to hide for 30 days.`
                  : "Documents with an upcoming or past due / expiration date. Snooze to hide for 30 days.";
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '60vh' }}>
            <div className="space-y-1.5 py-2 pr-2">
              {visibleDocs.slice().sort((a: any, b: any) => (a.documentName || '').localeCompare(b.documentName || '')).map((doc: any, i: number) => {
                const expired = normalizeFilter(doc.status) === normalizeFilter("expired");
                const expiringSoon = normalizeFilter(doc.status) === normalizeFilter("expiring_soon");
                return (
                  <div key={`${doc.documentId}-${i}`}
                    className={`flex items-center gap-2.5 p-2.5 rounded-lg transition-colors border ${
                      expired ? "border-red-500/30 bg-red-500/5" : expiringSoon ? "border-amber-500/30 bg-amber-500/5" : "border-border/50"
                    }`}>
                    <button
                      type="button"
                      onClick={() => { setPopup(null); navigate(String(doc.href || "").replace(/^#/, "") || `/documents/${doc.documentId}`); }}
                      className="flex items-center gap-2.5 flex-1 min-w-0 text-left hover:opacity-80"
                    >
                      <FileText className={`h-3.5 w-3.5 shrink-0 ${expired ? "text-red-500" : expiringSoon ? "text-amber-500" : "text-muted-foreground"}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{doc.documentName}</p>
                        <p className={`text-xs tabular-nums ${expired ? "text-red-500" : expiringSoon ? "text-amber-500" : "text-muted-foreground"}`}>
                          {doc.fieldName}: {fmtDate(doc.expirationDate)} ({daysUntilStr(doc.daysUntil)})
                        </p>
                      </div>
                      <Badge variant="outline" className={`shrink-0 text-xs-tight px-1.5 py-0 h-4 ${
                        expired ? "border-red-500/40 text-red-500" : expiringSoon ? "border-amber-500/40 text-amber-500" : ""
                      }`}>
                        {/* A due date is not an expiration — say which. */}
                        {expired
                          ? (String(doc.ruleType || "expiration") === "expiration" ? "Expired" : "Overdue")
                          : expiringSoon ? "Soon" : "Upcoming"}
                      </Badge>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); snoozeDoc(doc.ruleId || doc.documentId); }}
                      title="Hide for 30 days"
                      className="h-6 px-1.5 rounded text-[11px] font-semibold flex items-center gap-0.5 bg-muted/60 hover:bg-muted text-muted-foreground shrink-0"
                      data-testid={`btn-snooze-doc-${doc.documentId}`}
                    >
                      <BellOff className="h-3 w-3" />
                      Snooze
                    </button>
                  </div>
                );
              })}
              {visibleDocs.length === 0 && (
                <div className="text-center py-6">
                  <FileText className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">Nothing due or expiring</p>
                </div>
              )}
            </div>
          </div>
          <ViewPageLink href="/dashboard/documents" label="View All Documents" />
        </DialogContent>
      </Dialog>

      {quickAdd && (
        <QuickAddDialog open kind={quickAdd} ownerProfileId={kpiOwnerId} onClose={() => setQuickAdd(null)} />
      )}
    </>
  );
}


// Dismissed action-required items live in localStorage so they survive a
// page reload. The key includes a date-bucket so a user who dismisses
// "Pay rent" today doesn't permanently hide it — the next day the bucket
// flips and the dismissal expires. This matches the user-mental-model of
// "dismiss for today" without requiring a server round-trip.
// ST6: bucket dismissals by {tz, date}. If the user travels across
// timezones or DST shifts, the bucket invalidates and the dismissal
// expires. v2 = added tz field; v1 buckets are ignored (treated as
// empty) since they could be from a stale timezone.
const DISMISSED_LS_KEY = "portol_dismissed_action_v2";
const DISMISSED_LS_KEY_LEGACY = "portol_dismissed_action_v1";
function loadDismissed(): Set<string> {
  try {
    // Clean up legacy v1 slot so it doesn't accumulate.
    localStorage.removeItem(DISMISSED_LS_KEY_LEGACY);
    const raw = localStorage.getItem(DISMISSED_LS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as { tz?: string; date: string; ids: string[] };
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
    // Bucket expires when EITHER the date OR the timezone changes. The tz
    // check catches travelers and DST hops mid-day; without it, a user who
    // dismissed something at 11pm before "spring forward" would still see it
    // hidden after the clock jump.
    if (parsed.date !== todayStr || parsed.tz !== BROWSER_TIMEZONE) {
      localStorage.removeItem(DISMISSED_LS_KEY);
      return new Set();
    }
    return new Set(parsed.ids);
  } catch { return new Set(); }
}
function saveDismissed(ids: Set<string>) {
  try {
    const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE });
    localStorage.setItem(DISMISSED_LS_KEY, JSON.stringify({
      tz: BROWSER_TIMEZONE,
      date: todayStr,
      ids: Array.from(ids),
    }));
  } catch { /* ignore quota errors */ }
}

// ─── Section: HERO BRIEFING (Dashboard v2, Phase 2) ──────────────────────────
// Replaces the long AI Summary narrative with a greeting + ONE state
// (attention needed / on track / opportunity) + ONE action. Computed from the
// SAME ranked Now list (shared/now-rank) plus finance momentum, so it can never
// contradict the Now Queue or the data on screen. Deterministic & instant — no
// extra AI round-trip, no restating of metrics.
function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
function HeroBriefing({ enhanced, allProfiles, filterIds = [], filterMode = "everyone", events = [], goals = [] }: { enhanced: any; allProfiles: any[]; filterIds?: string[]; filterMode?: string; events?: any[]; goals?: any[] }) {
  const [, navigate] = useLocation();
  // P1 dedupe (QA scorecard): events + goals are fetched ONCE by the page
  // component (same query keys as before) and passed down as props.
  const items = useMemo(() => computeNowItems({
    overdueTasks: enhanced?.overdueTasks || [],
    dueSoonTasks: [...(enhanced?.tasksDueSoon || []), ...(enhanced?.upcomingTasks || [])],
    bills: enhanced?.financeSnapshot?.upcomingBills || [],
    documents: enhanced?.expiringDocuments || [],
    events: Array.isArray(events) ? events : [],
    goals: Array.isArray(goals) ? goals : [],
  }), [enhanced, events, goals]);

  const name = useMemo(() => {
    const pick = (n?: string) => (n || "").trim().split(/\s+/)[0];
    if (filterMode === "selected" && filterIds.length === 1) {
      const p = (allProfiles || []).find((x: any) => x.id === filterIds[0]);
      if (p?.name) return pick(p.name);
    }
    const self = (allProfiles || []).find((x: any) => x.type === "self");
    return pick(self?.name) || "there";
  }, [allProfiles, filterIds, filterMode]);

  const spendTrend = Number(enhanced?.financeSnapshot?.spendTrend ?? 0);
  const briefing = useMemo(() => {
    const top = items[0];
    const overdue = items.filter(i => (i.daysUntil ?? 1) < 0);
    if (top && (top.daysUntil ?? 1) < 0) {
      return {
        state: "attention" as const,
        sentence: overdue.length > 1 ? `${overdue.length} items are overdue — start with “${top.title}”.` : `“${top.title}” is overdue (${top.detail}).`,
        cta: { label: top.action === "pay" ? "Pay now" : top.action === "complete" ? "Complete it" : "Open", href: top.href },
      };
    }
    if (top && (top.daysUntil ?? 99) <= 2) {
      return { state: "attention" as const, sentence: `“${top.title}” is due ${top.detail}.`, cta: { label: "Open", href: top.href } };
    }
    if (top) {
      return { state: "on_track" as const, sentence: `You're on pace. Next up: “${top.title}” (${top.detail}).`, cta: { label: "Open", href: top.href } };
    }
    if (spendTrend < -5) {
      return { state: "opportunity" as const, sentence: `Spending is down ${Math.abs(spendTrend)}% vs last month — a good moment to move it to savings.`, cta: { label: "Open Finance", href: "/dashboard/finance" } };
    }
    return { state: "on_track" as const, sentence: "You're all caught up — nothing needs attention right now.", cta: { label: "Open Finance", href: "/dashboard/finance" } };
  }, [items, spendTrend]);

  const META = {
    attention: { label: "Attention needed", color: "0 72% 55%", Icon: AlertTriangle },
    on_track: { label: "On track", color: "155 60% 48%", Icon: CheckCircle2 },
    opportunity: { label: "Opportunity", color: "262 70% 62%", Icon: Sparkles },
  } as const;
  const meta = META[briefing.state];
  const Icon = meta.Icon;

  return (
    <div className="rounded-2xl border border-border/50 p-4" style={{ background: `linear-gradient(135deg, hsl(${meta.color} / 0.10) 0%, transparent 60%)` }} data-testid="section-hero-briefing">
      <p className="text-sm text-muted-foreground">{timeGreeting()}, <span className="font-semibold text-foreground">{name}</span>.</p>
      <span className="micro-label mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5" style={{ background: `hsl(${meta.color} / 0.15)`, color: `hsl(${meta.color})` }}>
        <Icon className="h-3 w-3" /> {meta.label}
      </span>
      <p className="mt-2 text-[15px] font-semibold leading-snug">{briefing.sentence}</p>
      <Button size="sm" className="mt-3 h-8" onClick={() => navigate(briefing.cta.href)} data-testid="briefing-cta">
        {briefing.cta.label} <ArrowRight className="ml-1 h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ─── Section: TRENDS (Dashboard v2, Phase 3) ─────────────────────────────────
// 2–3 high-signal trend modules, each ending in a next-step caption (a verb),
// replacing the static Key Findings snippets. Reads existing endpoints only.
function TrendsSection({ enhanced, stats, filterIds = [], filterMode = "everyone" }: { enhanced: any; stats: DashboardStats | undefined; filterIds?: string[]; filterMode?: string }) {
  const [, navigate] = useLocation();
  const leading = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // ── Trends = MOVEMENT ONLY ────────────────────────────────────────────────
  // Every other dashboard section (Hero, Explore, Health, Goals, Now) shows
  // today's numbers. To avoid repeating any of them, Trends shows the one thing
  // they don't: change over time. Each card is a week-over-week delta or a
  // last-7-day trajectory — a direction, never a restated count. We derive the
  // deltas from the raw habit check-ins and tracker entries (this week vs last)
  // plus the server's per-metric 7-day trend.
  const { data: habitsRaw } = useQuery<any>({
    queryKey: ["/api/habits", filterMode, ...filterIds, "trends"],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/habits${leading}`)).then(r => r.json()).catch(() => []),
    staleTime: 60_000,
  });
  const { data: trackersRaw } = useQuery<any>({
    queryKey: ["/api/trackers", filterMode, ...filterIds, "trends"],
    queryFn: () => apiRequest("GET", `/api/trackers${leading}`).then(r => r.json()).catch(() => []),
    staleTime: 60_000,
  });
  const habits: any[] = Array.isArray(habitsRaw) ? habitsRaw : (habitsRaw?.items || habitsRaw?.habits || []);
  const trackers: any[] = Array.isArray(trackersRaw) ? trackersRaw : (trackersRaw?.items || trackersRaw?.trackers || []);

  const GOOD = "155 60% 48%", BAD = "0 72% 55%", WARN = "43 85% 52%", TEAL = "173 60% 44%";
  type TrendCard = { key: string; title: string; accent: string; headline: string; body?: ReactNode; caption: string; href: string; score: number };
  const fmtVal = (n: number) => Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 10) / 10).toLocaleString();
  const healthSnap: any[] = Array.isArray(enhanced?.healthSnapshot) ? enhanced.healthSnapshot : [];

  // Two 7-day windows anchored to local midnight: [today-6 … today] (this week)
  // and the 7 days before it (last week).
  const DAY = 86400000;
  const t0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const inThis = (ms: number) => !isNaN(ms) && ms >= t0 - 6 * DAY && ms < t0 + DAY;
  const inLast = (ms: number) => !isNaN(ms) && ms >= t0 - 13 * DAY && ms < t0 - 6 * DAY;
  const dayMs = (dateStr: string) => new Date(`${String(dateStr).slice(0, 10)}T12:00:00`).getTime();
  const tsMs = (ts: string) => new Date(ts).getTime();

  const pool: TrendCard[] = [];

  // 1) Habit consistency — this week's adherence vs last week's, in points.
  //    Hero/Explore show TODAY's %; this is the only place showing whether
  //    consistency is climbing or slipping week over week.
  const habitRate = (inWin: (ms: number) => boolean) => {
    let expected = 0, done = 0;
    for (const h of habits) {
      const freq = String(h.frequency || "daily");
      const per = freq === "weekly" ? 1 : freq === "custom" ? Math.max(1, (h.targetDays?.length || 1)) : 7;
      expected += per;
      const days = new Set<string>();
      for (const c of (h.checkins || [])) { const ms = dayMs(c.date); if (inWin(ms)) days.add(String(c.date).slice(0, 10)); }
      done += freq === "weekly" ? (days.size > 0 ? 1 : 0) : Math.min(per, days.size);
    }
    return { rate: expected > 0 ? Math.round((done / expected) * 100) : null as number | null, expected };
  };
  const thisH = habitRate(inThis), lastH = habitRate(inLast);
  if (habits.length > 0 && thisH.rate != null && lastH.rate != null && (thisH.expected > 0 && lastH.expected > 0)) {
    const delta = thisH.rate - lastH.rate;
    const up = delta > 0, flat = delta === 0;
    pool.push({
      key: "habit-momentum", title: "Habit consistency", accent: flat ? TEAL : up ? GOOD : BAD,
      headline: `${flat ? "→" : up ? "↑" : "↓"} ${Math.abs(delta)}%`,
      body: <div className="mt-1 flex gap-2 text-[11px] text-muted-foreground"><span>This wk {thisH.rate}%</span><span>·</span><span>Last {lastH.rate}%</span></div>,
      caption: up ? "More consistent than last week — keep it climbing." : flat ? "Holding steady with last week's consistency." : "Consistency slipped vs last week — recommit to one habit today.",
      href: "/dashboard/health",
      score: 70 + Math.min(24, Math.abs(delta)),
    });
  }

  // 2) Health metric trajectories — the server's last-7-day change per tracker.
  //    Only metrics that actually MOVED appear (flat ones add nothing new), and
  //    we show the delta, not the current value the Health section already has.
  const movedHealth = [...healthSnap]
    .filter((h: any) => typeof h.latestValue === "number" && Number(h.trendValue) > 0 && h.trend !== "flat")
    .sort((a: any, b: any) => (Number(b.entryCount) || 0) - (Number(a.entryCount) || 0));
  movedHealth.slice(0, 2).forEach((h: any, idx: number) => {
    const up = h.trend === "up";
    pool.push({
      key: `health-move-${h.trackerId}`, title: h.name, accent: TEAL,
      headline: `${up ? "↑" : "↓"} ${fmtVal(Number(h.trendValue))}${h.unit ? ` ${h.unit}` : ""}`,
      body: <div className="mt-1 text-[11px] text-muted-foreground">over the last week</div>,
      caption: `${h.name} ${up ? "rose" : "fell"} ${fmtVal(Number(h.trendValue))}${h.unit ? ` ${h.unit}` : ""} across ${h.entryCount} recent log${h.entryCount === 1 ? "" : "s"} — mind the direction.`,
      href: "/dashboard/health",
      score: (idx === 0 ? 60 : 42) + Math.min(12, Number(h.entryCount) || 0),
    });
  });

  // 3) Logging momentum — how many entries were logged this week vs last, across
  //    trackers and habits. A pure engagement trend nothing else surfaces.
  let thisLogs = 0, lastLogs = 0;
  for (const t of trackers) for (const e of (t.entries || [])) { const ms = tsMs(e.timestamp); if (inThis(ms)) thisLogs++; else if (inLast(ms)) lastLogs++; }
  for (const h of habits) for (const c of (h.checkins || [])) { const ms = dayMs(c.date); if (inThis(ms)) thisLogs++; else if (inLast(ms)) lastLogs++; }
  if (thisLogs > 0 || lastLogs > 0) {
    const delta = thisLogs - lastLogs;
    const up = delta > 0, flat = delta === 0;
    pool.push({
      key: "logging-momentum", title: "Logging momentum", accent: flat ? TEAL : up ? GOOD : WARN,
      headline: `${flat ? "→" : up ? "↑" : "↓"} ${Math.abs(delta)}`,
      body: <div className="mt-1 flex gap-2 text-[11px] text-muted-foreground"><span>This wk {thisLogs}</span><span>·</span><span>Last {lastLogs}</span></div>,
      caption: up ? `${delta} more log${delta === 1 ? "" : "s"} than last week — momentum is building.` : flat ? "Same logging pace as last week — steady tracking." : `${Math.abs(delta)} fewer log${Math.abs(delta) === 1 ? "" : "s"} than last week — a quick entry keeps the trend alive.`,
      href: "/dashboard/health",
      score: 40 + Math.min(20, Math.abs(delta)),
    });
  }

  const cards = pool.sort((a, b) => b.score - a.score).slice(0, 3);

  // Grid columns follow the number of live cards so 1–2 trends don't leave
  // awkward empty tracks (a single card shouldn't sit in a 3-wide grid).
  const gridCols = cards.length >= 3 ? "sm:grid-cols-3" : cards.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-1";

  return (
    <CollapsibleSection accent="200 80% 55%" icon={Activity} label="Trends" testId="section-trends">
      {cards.length === 0 ? (
        <div className="bubble -dashed p-4 text-center" data-testid="trend-empty">
          <p className="micro-label text-muted-foreground/70">No movement yet</p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">Trends compare this week to last. Keep logging habits and trackers for a couple of weeks and your direction shows up here.</p>
        </div>
      ) : (
        <div className={`grid grid-cols-1 ${gridCols} gap-2.5`}>
          {cards.map((c) => (
            <button key={c.key} type="button" onClick={() => navigate(c.href)}
              className="bubble flex flex-col p-3 text-left card-lift active:scale-[0.98] transition-all"
              data-testid={`trend-${c.key}`}>
              <p className="micro-label text-muted-foreground/70">{c.title}</p>
              <p className="mt-0.5 text-lg font-bold tabular-nums" style={{ color: `hsl(${c.accent})` }}>{c.headline}</p>
              {c.body}
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{c.caption}</p>
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ─── Section: DOMAIN HUBS (Dashboard v2, Phase 4) ────────────────────────────
// Compact navigation cards — one per life domain — each = a count + one CTA.
// Replaces the large mixed-content sections (full lists) with drill-down links.
function DomainHubsSection({ enhanced, stats, allProfiles, filterIds = [], filterMode = "everyone", events = [], goals = [] }: { enhanced: any; stats: DashboardStats | undefined; allProfiles: any[]; filterIds?: string[]; filterMode?: string; events?: any[]; goals?: any[] }) {
  const [, navigate] = useLocation();
  // P1 dedupe (QA scorecard): events + goals come from the page-level queries.

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const next7Events = (Array.isArray(events) ? events : []).filter((e: any) => {
    const d = new Date(`${(e.date || "").slice(0, 10)}T12:00:00`); if (isNaN(d.getTime())) return false;
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000); return diff >= 0 && diff <= 7;
  }).length;
  const activeGoals = (Array.isArray(goals) ? goals : []).filter((g: any) => { const s = String(g.status || "").toLowerCase(); return s !== "completed" && s !== "abandoned"; }).length;
  const expiringDocs = (enhanced?.expiringDocuments || []).length;
  const billCount = (enhanced?.financeSnapshot?.upcomingBills || []).length;
  const people = (allProfiles || []).filter((p: any) => p.type === "person" || p.type === "self").length;
  const adherence = Math.round(Number(stats?.habitCompletionRate ?? 0));

  const hubs = [
    { key: "finance", label: "Finance", Icon: DollarSign, accent: "43 85% 52%", value: `${billCount} bill${billCount === 1 ? "" : "s"} due`, href: "/dashboard/finance" },
    { key: "health", label: "Health", Icon: HeartPulse, accent: "155 60% 48%", value: `${adherence}% adherence`, href: "/dashboard/health" },
    { key: "calendar", label: "Calendar", Icon: CalendarDays, accent: "200 80% 55%", value: `${next7Events} this week`, href: "/calendar" },
    { key: "documents", label: "Documents", Icon: FileText, accent: "205 90% 58%", value: expiringDocs > 0 ? `${expiringDocs} expiring` : "All current", href: "/dashboard/documents" },
    { key: "goals", label: "Goals", Icon: Target, accent: "262 70% 62%", value: `${activeGoals} active`, href: "/goals" },
    { key: "relationships", label: "People", Icon: Users, accent: "310 50% 58%", value: `${people} ${people === 1 ? "profile" : "profiles"}`, href: "/profiles" },
  ];

  return (
    <CollapsibleSection accent="262 60% 58%" icon={BarChart3} label="Explore" testId="section-domain-hubs">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {hubs.map(({ key, label, Icon, accent, value, href }) => (
          <button key={key} type="button" onClick={() => navigate(href)}
            className="bubble flex items-center gap-2.5 p-2.5 text-left card-lift active:scale-[0.98] transition-all"
            data-testid={`hub-${key}`}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ background: `hsl(${accent} / 0.15)` }}>
              <Icon className="h-4 w-4" style={{ color: `hsl(${accent})` }} />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate">{label}</p>
              <p className="text-[11px] text-muted-foreground truncate">{value}</p>
            </div>
          </button>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: NOW QUEUE (Dashboard v2, Phase 1) ──────────────────────────────
// The single urgency surface. Merges Action Required (tasks+bills), Bills due,
// Today's Schedule (events), Upcoming (events/renewals via docs), and
// overdue/at-risk Goals into ONE ranked list via shared/now-rank. Every action
// hits the SAME mutation endpoints the AI chat uses (complete task / pay bill),
// so chat and dashboard stay interchangeable (Dashboard v2 invariant).
function NowQueueSection({ enhanced, stats, filterIds = [], filterMode = "everyone", events = [], goals = [] }: { enhanced: any; stats: DashboardStats | undefined; filterIds?: string[]; filterMode?: string; events?: any[]; goals?: any[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [acted, setActed] = useState<Set<string>>(new Set());
  // P1 dedupe (QA scorecard): events + goals come from the page-level queries.

  const items = useMemo(() => computeNowItems({
    overdueTasks: enhanced?.overdueTasks || [],
    dueSoonTasks: [...(enhanced?.tasksDueSoon || []), ...(enhanced?.upcomingTasks || [])],
    bills: enhanced?.financeSnapshot?.upcomingBills || [],
    documents: enhanced?.expiringDocuments || [],
    events: Array.isArray(events) ? events : [],
    goals: Array.isArray(goals) ? goals : [],
  }).filter(i => !acted.has(i.key)), [enhanced, events, goals, acted]);

  // Optimistic-context pattern (see CalendarView.tsx): onMutate cancels
  // in-flight fetches, snapshots the caches the visible lists actually read
  // (enhanced task lists, stats badge count, /api/tasks lists), and patches
  // them so the checkmark + badge decrement paint immediately; onError rolls
  // back from the context; onSettled lets the cache bus reconcile from server.
  const enhancedKey = ["/api/dashboard-enhanced", filterMode, ...filterIds];
  const statsKey = ["/api/stats", filterMode, ...filterIds];
  // `acted` hides a row the moment its button is pressed. It is a UI-only
  // veil over the optimistic cache patch, so a FAILED request has to lift it
  // again — otherwise the row stays hidden behind a success toast while the
  // bill is still unpaid (audit 2026-09-02 item 6). The success toast waits
  // for the server: the request can fail.
  const unact = (key: string) => setActed(s => { if (!s.has(key)) return s; const n = new Set(s); n.delete(key); return n; });
  const completeTask = useMutation({
    mutationFn: ({ id }: { id: string; key: string; title: string }) => apiRequest("PATCH", `/api/tasks/${id}`, { status: "done" }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      await queryClient.cancelQueries({ queryKey: enhancedKey });
      await queryClient.cancelQueries({ queryKey: statsKey });
      const prevTasks = queryClient.getQueriesData<any[]>({ queryKey: ["/api/tasks"] });
      const prevEnhanced = queryClient.getQueryData<any>(enhancedKey);
      const prevStats = queryClient.getQueryData<any>(statsKey);
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/tasks"] }, (old) =>
        Array.isArray(old) ? old.map((t: any) => t.id === id ? { ...t, status: "done" } : t) : old);
      queryClient.setQueryData<any>(enhancedKey, (old: any) => {
        if (!old) return old;
        const drop = (l: any) => Array.isArray(l) ? l.filter((t: any) => t.id !== id) : l;
        return {
          ...old,
          overdueTasks: drop(old.overdueTasks),
          tasksDueSoon: drop(old.tasksDueSoon),
          upcomingTasks: drop(old.upcomingTasks),
          taskSnapshot: old.taskSnapshot
            ? { ...old.taskSnapshot, open: Math.max(0, Number(old.taskSnapshot.open || 0) - 1) }
            : old.taskSnapshot,
        };
      });
      queryClient.setQueryData<any>(statsKey, (old: any) =>
        old ? { ...old, activeTasks: Math.max(0, Number(old.activeTasks || 0) - 1) } : old);
      return { prevTasks, prevEnhanced, prevStats };
    },
    onSuccess: (_d, { title }) => toast({ title: `"${title}" completed` }),
    onError: (_e, { key }, ctx: any) => {
      ctx?.prevTasks?.forEach(([k, data]: [any, any]) => queryClient.setQueryData(k, data));
      if (ctx?.prevEnhanced !== undefined) queryClient.setQueryData(enhancedKey, ctx.prevEnhanced);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(statsKey, ctx.prevStats);
      unact(key);
      toast({ title: "Couldn't complete task", variant: "destructive" });
    },
    // Single consolidated invalidation: the bus fans out to /api/tasks,
    // /api/stats, /api/dashboard-enhanced, activity, timeline, insights.
    onSettled: () => { invalidateDomain("tasks"); },
  });
  const payBill = useMutation({
    mutationFn: ({ id }: { id: string; key: string; title: string }) => apiRequest("POST", `/api/obligations/${id}/pay`, {}),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/dashboard-enhanced"] });
      // The Now queue + Bills sections read enhanced.financeSnapshot.upcomingBills;
      // drop the paid bill there (every scoped variant) so the row clears
      // instantly. The /api/obligations entity lists are left alone — the
      // obligation is still live, it just advanced to its next due date.
      const restore = dropUpcomingBillFromDashboard(id);
      return { restore };
    },
    onSuccess: (_d, { title }) => toast({ title: `"${title}" marked paid` }),
    onError: (_e, { key }, ctx: any) => {
      ctx?.restore?.();
      unact(key);
      toast({ title: "Couldn't mark bill paid", variant: "destructive" });
    },
    // Single consolidated invalidation (obligations + stats + enhanced +
    // cashflow + loans/schedule via the cache bus).
    onSettled: () => { invalidateDomain("obligations"); },
  });

  const doAction = (it: NowItem) => {
    if (it.action === "complete") {
      setActed(s => new Set(s).add(it.key));
      completeTask.mutate({ id: it.sourceId, key: it.key, title: it.title });
    } else if (it.action === "pay") {
      setActed(s => new Set(s).add(it.key));
      payBill.mutate({ id: it.sourceId, key: it.key, title: it.title });
    } else {
      navigate(it.href);
    }
  };

  const KIND_ICON: Record<NowItem["kind"], any> = {
    task: ListTodo, bill: CreditCard, event: CalendarDays, document: FileWarning, goal: Target,
  };
  const overdueCount = items.filter(i => (i.daysUntil ?? 0) < 0).length;
  const shown = expanded ? items : items.slice(0, 5);

  return (
    <CollapsibleSection
      accent="262 70% 60%"
      icon={Flame}
      label="Now"
      sub={items.length > 0 ? `${items.length} need${items.length === 1 ? "s" : ""} attention${overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}` : undefined}
      count={items.length || undefined}
      testId="section-now-queue"
    >
      {items.length === 0 ? (
        <div className="py-6 text-center">
          <CheckCircle2 className="h-8 w-8 text-green-500/40 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">You're all caught up — nothing urgent right now.</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {shown.map((it) => {
            const Icon = KIND_ICON[it.kind];
            const overdue = (it.daysUntil ?? 0) < 0;
            const actionLabel = it.action === "complete" ? "Done" : it.action === "pay" ? "Pay" : "Open";
            return (
              <div key={it.key}
                className="flex items-center gap-2.5 rounded-xl border px-2.5 py-2 transition-colors hover:bg-muted/30"
                style={{ borderColor: overdue ? "hsl(0 72% 52% / 0.35)" : "hsl(var(--border) / 0.5)" }}>
                <button type="button" onClick={() => navigate(it.href)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" data-testid={`now-item-${it.key}`}>
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `hsl(${it.accent} / 0.15)` }}>
                    <Icon className="h-4 w-4" style={{ color: `hsl(${it.accent})` }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{it.title}</p>
                    <p className="truncate text-[11px]" style={{ color: overdue ? "hsl(0 72% 56%)" : "hsl(var(--muted-foreground))" }}>
                      <span className="micro-label text-muted-foreground/60">{it.kind}</span>
                      {it.detail ? ` · ${it.detail}` : ""}
                    </p>
                  </div>
                </button>
                <Button size="sm" variant={it.action === "open" ? "ghost" : "outline"} className="h-7 shrink-0 px-2.5 text-[11px]"
                  disabled={completeTask.isPending || payBill.isPending}
                  onClick={() => doAction(it)} data-testid={`now-action-${it.key}`}>
                  {actionLabel}
                </Button>
              </div>
            );
          })}
          {items.length > 5 && (
            <button type="button" onClick={() => setExpanded(v => !v)} className="w-full pt-1 text-center text-[11px] font-medium text-primary hover:underline">
              {expanded ? "Show less" : `Show ${items.length - 5} more`}
            </button>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}

function ActionRequiredSection({ stats, enhanced, profileId }: { stats: DashboardStats; enhanced: any; profileId?: string }) {
  const { toast } = useToast();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => loadDismissed());
  const [sheetOpen, setSheetOpen] = useState(false);

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const overdueTasks: any[] = useMemo(() => {
    const raw: any[] = enhanced?.overdueTasks || [];
    return raw.filter((t: any) => !dismissedIds.has(`task-${t.id}`));
  }, [enhanced, dismissedIds]);

  // Bills have NO overdue status (product decision 2026-06). A recurring bill
  // whose due date has passed simply hasn't been rolled forward yet, so it must
  // never be surfaced here as a red "X days overdue" action item — that was the
  // source of the dashboard flagging nearly every bill as overdue. Past-due
  // bills still appear (with their real due date) in the Bills section and the
  // Upcoming Bills popup; only the "needs attention / overdue" framing is gone.
  const overdueBills: any[] = [];

  const soonTasks: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.tasksDueSoon || []).filter((t: any) => {
      if (!t.dueDate) return false;
      const d = parseISODate(t.dueDate) ?? new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff >= 0 && diff <= 7;
    });
    const allTasks: any[] = enhanced?.upcomingTasks || [];
    const combined = [...raw, ...allTasks.filter((t: any) => {
      if (!t.dueDate) return false;
      const d = parseISODate(t.dueDate) ?? new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff >= 0 && diff <= 7;
    })];
    const seen = new Set<string>();
    return combined.filter((t: any) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return !dismissedIds.has(`task-${t.id}`);
    });
  }, [enhanced, dismissedIds, now]);

  const soonBills: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil >= 0 && b.daysUntil <= 7);
    return raw.filter((b: any) => !dismissedIds.has(`bill-${b.id}`));
  }, [enhanced, dismissedIds]);

  const handleMarkComplete = async (taskId: string) => {
    const task = allItems.find(i => i.id === taskId);
    try {
      await apiRequest("PATCH", `/api/tasks/${taskId}`, { status: "done" });
      invalidateDomain("tasks");
      toast({ title: `"${task?.title || "Task"}" completed` });
    } catch {
      toast({ title: `Failed to complete "${task?.title || "task"}"`, variant: "destructive" });
    }
  };

  const handleSnooze = async (taskId: string) => {
    const task = allItems.find(i => i.id === taskId);
    try {
      const newDate = new Date();
      newDate.setDate(newDate.getDate() + 7);
      await apiRequest("PATCH", `/api/tasks/${taskId}`, { dueDate: newDate.toLocaleDateString("en-CA") });
      invalidateDomain("tasks");
      toast({ title: `"${task?.title || "Task"}" snoozed`, description: `Moved to ${newDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` });
    } catch {
      toast({ title: `Failed to snooze "${task?.title || "task"}"`, variant: "destructive" });
    }
  };

  // Bill pay — hits the obligations engine so the bill is recorded as paid
  // and the next cycle is rolled forward. Fires for both upcoming and overdue
  // bills surfaced in the Action Required list.
  const handleBillPay = async (billId: string) => {
    const bill = allItems.find(i => i.id === billId);
    try {
      await apiRequest("POST", `/api/obligations/${billId}/pay`, {});
      // Invalidate every cache that surfaces bills/obligations. The bus covers
      // obligations + stats + dashboard-enhanced + cashflow + loans/schedule;
      // occurrences + timeline have no obligations-domain entry, keep explicit.
      invalidateDomain("obligations");
      queryClient.invalidateQueries({ queryKey: ["/api/obligation-occurrences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      toast({ title: `"${bill?.title || "Bill"}" marked paid` });
    } catch {
      toast({ title: `Failed to pay "${bill?.title || "bill"}"`, variant: "destructive" });
    }
  };

  // Bill snooze — push the next due date out by 7d. Uses the obligation's
  // nextDueDate field. Server PATCH at /api/obligations/:id.
  const handleBillSnooze = async (billId: string) => {
    const bill = allItems.find(i => i.id === billId);
    try {
      const newDate = new Date();
      newDate.setDate(newDate.getDate() + 7);
      await apiRequest("PATCH", `/api/obligations/${billId}`, {
        nextDueDate: newDate.toLocaleDateString("en-CA"),
      });
      // Same fan-out as handleBillPay above (bus + the two keys it lacks).
      invalidateDomain("obligations");
      queryClient.invalidateQueries({ queryKey: ["/api/obligation-occurrences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      toast({ title: `"${bill?.title || "Bill"}" snoozed`, description: `Moved to ${newDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` });
    } catch {
      toast({ title: `Failed to snooze "${bill?.title || "bill"}"`, variant: "destructive" });
    }
  };

  const dismiss = (key: string) => setDismissedIds(prev => {
    const next = new Set([...prev, key]);
    saveDismissed(next);
    return next;
  });

  // Build all items sorted by urgency
  const allItems: Array<{
    id: string; title: string; detail: string; sourceType: "task" | "bill"; accentColor: string;
  }> = useMemo(() => {
    const items: Array<{ id: string; title: string; detail: string; sourceType: "task" | "bill"; accentColor: string; sortKey: number }> = [];

    // Overdue tasks (most urgent first = oldest overdue first)
    for (const t of overdueTasks) {
      const d = (t.dueDate ? parseISODate(t.dueDate) : null) ?? (t.dueDate ? new Date(t.dueDate) : new Date(0));
      d.setHours(0, 0, 0, 0);
      const days = Math.ceil((now.getTime() - d.getTime()) / 86400000);
      items.push({
        id: t.id, title: t.title,
        detail: `${days} day${days !== 1 ? "s" : ""} overdue`,
        sourceType: "task", accentColor: "#ef4444",
        sortKey: -days,
      });
    }
    // Overdue bills intentionally omitted — bills have no overdue status.
    // Due soon tasks
    for (const t of soonTasks) {
      const d = parseISODate(t.dueDate) ?? new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      const label = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : `in ${diff}d`;
      items.push({
        id: t.id, title: t.title,
        detail: label,
        sourceType: "task", accentColor: "#f59e0b",
        sortKey: diff + 1000,
      });
    }
    // Due soon bills
    for (const b of soonBills) {
      // A past bill has a NEGATIVE daysUntil; interpolating it read "in -29d".
      const label = dayLabel(b.daysUntil);
      items.push({
        id: b.id, title: b.name,
        detail: `${label}${b.amount ? ` · ${formatMoney(b.amount)}` : ""}`,
        sourceType: "bill", accentColor: "#f59e0b",
        sortKey: b.daysUntil + 1000,
      });
    }

    items.sort((a, b) => a.sortKey - b.sortKey);
    return items;
  }, [overdueTasks, overdueBills, soonTasks, soonBills, now]);

  const totalCount = allItems.length;
  const visibleItems = allItems.slice(0, 5);
  const hiddenCount = Math.max(0, totalCount - 5);

  if (totalCount === 0) return (
    <CollapsibleSection accent="0 72% 52%" icon={AlertTriangle} label="Action Required" testId="section-needs-attention">
      <div className="text-center py-6">
        <Check className="h-7 w-7 text-green-500/60 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">All clear — nothing needs attention right now</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <>
      <CollapsibleSection accent="0 72% 52%" icon={AlertTriangle} label="Action Required" count={totalCount} testId="section-needs-attention">
        <div className="divide-y divide-border/30">
          {visibleItems.map((item) => (
            <AttentionItem key={`${item.sourceType}-${item.id}`} {...item} onComplete={handleMarkComplete} onSnooze={handleSnooze} onPay={handleBillPay} onBillSnooze={handleBillSnooze} onDismiss={dismiss} />
          ))}
        </div>
        {hiddenCount > 0 && (
          <button
            onClick={() => setSheetOpen(true)}
            className="mt-1.5 w-full text-center text-xs text-white hover:opacity-90 py-1.5 rounded-lg font-semibold animate-pulse"
            style={{ background: 'linear-gradient(90deg, hsl(0 72% 52% / 0.8), hsl(43 85% 52% / 0.8))' }}
          >
            +{hiddenCount} more items need attention
          </button>
        )}
      </CollapsibleSection>

      {/* Full list sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              All Action Items
              <Badge variant="secondary">{totalCount}</Badge>
            </SheetTitle>
            <SheetDescription className="text-xs">
              {(() => {
                const overdueCt = allItems.filter(i => i.accentColor === '#ef4444').length;
                const soonCt = totalCount - overdueCt;
                const taskCt = allItems.filter(i => i.sourceType === 'task').length;
                const billCt = allItems.filter(i => i.sourceType === 'bill').length;
                const parts: string[] = [];
                if (overdueCt > 0) parts.push(`${overdueCt} overdue`);
                if (soonCt > 0) parts.push(`${soonCt} due soon`);
                const summary = parts.join(' · ');
                const bySource: string[] = [];
                if (taskCt > 0) bySource.push(`${taskCt} task${taskCt !== 1 ? 's' : ''}`);
                if (billCt > 0) bySource.push(`${billCt} bill${billCt !== 1 ? 's' : ''}`);
                return summary ? `${summary} · ${bySource.join(', ')}` : 'All items that need your attention';
              })()}
            </SheetDescription>
          </SheetHeader>
          {/* Quick filter chips */}
          {totalCount > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3 pb-2 border-b">
              {(() => {
                const overdueCt = allItems.filter(i => i.accentColor === '#ef4444').length;
                const soonCt = totalCount - overdueCt;
                return (
                  <>
                    {overdueCt > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-500">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {overdueCt} overdue
                      </span>
                    )}
                    {soonCt > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-500">
                        <Clock className="h-2.5 w-2.5" />
                        {soonCt} due soon
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
          )}
          {/* 100dvh (dynamic viewport) not 100vh — iOS Safari's collapsing URL bar
              makes 100vh overshoot the visible area and cut off the list bottom.
              Matches the h-dvh shell in App.tsx. */}
          <div className="overflow-y-auto overscroll-contain mt-3" style={{ WebkitOverflowScrolling: 'touch', height: 'calc(100dvh - 160px)' }}>
            <div className="space-y-0.5 pr-2">
              {allItems.map((item) => (
                <AttentionItem key={`sheet-${item.sourceType}-${item.id}`} {...item} onComplete={handleMarkComplete} onSnooze={handleSnooze} onPay={handleBillPay} onBillSnooze={handleBillSnooze} onDismiss={dismiss} />
              ))}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

// ─── Section: Today's Schedule ────────────────────────────────────────────────

function TodaySection({ enhanced, stats }: { enhanced: any; stats: DashboardStats | undefined }) {
  const [, navigate] = useLocation();
  const events: any[] = enhanced?.todaysEvents || [];

  const VISIBLE = 5;
  const visibleEvents = events.slice(0, VISIBLE);
  const hiddenCount = Math.max(0, events.length - VISIBLE);

  return (
    <CollapsibleSection accent="215 70% 58%" icon={Calendar} label="Today's Schedule" testId="section-today"
      sub={new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}>
      {events.length === 0 ? (
        <div className="text-center py-4">
          <Calendar className="h-6 w-6 text-muted-foreground/30 mx-auto mb-1.5" />
          <p className="text-xs text-muted-foreground">No events today</p>
        </div>
      ) : (
        <div className="divide-y divide-border/30">
          {/* Timeline strip */}
          {events.length > 0 && (() => {
            const START = 8; const END = 22;
            const toPos = (timeStr: string) => {
              const parts = timeStr.split(":").map(Number);
              const h = parts[0] || 0; const m = parts[1] || 0;
              return Math.max(0, Math.min(100, ((h + m/60 - START) / (END - START)) * 100));
            };
            return (
              <div className="relative mb-2 px-1">
                <div className="relative h-5 bg-muted/30 rounded-full overflow-hidden">
                  {events.filter(ev => ev.time).map((ev: any, i: number) => (
                    <div key={ev.id}
                      className="absolute top-1 h-3 rounded-full text-[11px] font-bold flex items-center justify-center overflow-hidden"
                      style={{ left: `${toPos(ev.time)}%`, minWidth: '8px', maxWidth: '60px', transform: 'translateX(-50%)',
                        background: ev.category === 'health' ? 'hsl(173 60% 44%)' : ev.category === 'finance' ? 'hsl(43 85% 52%)' : 'hsl(215 70% 58%)',
                        color: 'white', padding: '0 3px' }}>
                      {ev.title.slice(0,8)}
                    </div>
                  ))}
                  {/* Now indicator */}
                  {(() => { const now = new Date(); const nowPos = ((now.getHours() + now.getMinutes()/60 - START) / (END-START)) * 100; return nowPos >= 0 && nowPos <= 100 ? <div className="absolute top-0 bottom-0 w-px bg-red-400/70" style={{ left: `${nowPos}%` }} /> : null; })()}
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground/50 mt-0.5 px-0.5">
                  <span>8am</span><span>12pm</span><span>4pm</span><span>10pm</span>
                </div>
              </div>
            );
          })()}
          {visibleEvents.map((ev: any) => (
            <div key={ev.id}
              onClick={() => navigate("/calendar")}
              role="button" tabIndex={0} aria-label={`Open calendar: ${ev.title}`}
              onKeyDown={onEnterOrSpace(() => navigate("/calendar"))}
              className="flex items-center gap-1.5 py-1.5 cursor-pointer hover:bg-muted/40 transition-colors rounded px-1 -mx-1">
              <Clock className="h-3 w-3 text-primary shrink-0" />
              <span className="text-xs font-medium text-primary tabular-nums shrink-0 w-10">
                {ev.time ? (() => { const [h,m]=ev.time.split(':').map(Number); const ap=h>=12?'PM':'AM'; const h12=h%12||12; return m?`${h12}:${String(m).padStart(2,'0')} ${ap}`:`${h12} ${ap}`; })() : "All day"}
              </span>
              <span className="text-xs-loose truncate flex-1">{ev.title}</span>
              {ev.location && (
                <span className="text-xs-tight text-muted-foreground flex items-center gap-0.5 shrink-0">
                  <MapPin className="h-2 w-2" />{ev.location}
                </span>
              )}
            </div>
          ))}
          {hiddenCount > 0 && (
            <button
              onClick={() => navigate("/calendar")}
              className="w-full text-center text-xs text-primary hover:underline py-1.5"
            >
              +{hiddenCount} more event{hiddenCount !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ─── Section: Health Snapshot ─────────────────────────────────────────────────

// ─── Section: Key Findings & Tracker Insights ────────────────────────────────
// PR K — Universal executive-summary section. Replaces the health-only Health
// swimlane. Surfaces the most meaningful trends, anomalies, milestones, and
// actionable items across every tracker + finance + habits + net worth + obligations.
// Hides itself entirely when no findings exist (per design spec).

function DirectionGlyph({ direction }: { direction: FindingDirection }) {
  if (direction === "improving") return <TrendingUp className="h-3.5 w-3.5" aria-label="Improving" />;
  if (direction === "declining") return <TrendingDown className="h-3.5 w-3.5" aria-label="Declining" />;
  return <Minus className="h-3.5 w-3.5" aria-label="Stable" />;
}

function KeyFindingRow({ finding }: { finding: KeyFinding }) {
  const [, navigate] = useLocation();
  const colors = FINDING_SEVERITY_COLORS[finding.severity];
  const onOpen = () => {
    const target = finding.href.startsWith("#") ? finding.href.slice(1) : finding.href;
    navigate(target);
  };
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={onEnterOrSpace(onOpen)}
      data-testid={`finding-${finding.id}`}
      className="group flex items-start gap-2.5 py-2 px-2 -mx-2 rounded-lg cursor-pointer hover:bg-muted/40 transition-colors border-l-2 pressable"
      style={{ borderLeftColor: `hsl(${colors.border})` }}
    >
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-sm"
        style={{ background: `hsl(${colors.bg})`, color: `hsl(${colors.fg})` }}
        aria-hidden
      >
        <span>{finding.icon || "💡"}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground/90 leading-tight">{finding.title}</span>
        </div>
        {finding.detail && (
          <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-snug">{finding.detail}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0 self-center">
        <span
          className="inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded"
          style={{ background: `hsl(${colors.bg})`, color: `hsl(${colors.fg})`, border: `1px solid hsl(${colors.border} / 0.4)` }}
          title={FINDING_DIRECTION_LABEL[finding.direction]}
        >
          <DirectionGlyph direction={finding.direction} />
          <span className="micro-label">{FINDING_DIRECTION_LABEL[finding.direction]}</span>
        </span>
      </div>
    </div>
  );
}

function KeyFindingsSection({
  filterIds,
  filterMode = "everyone",
}: {
  filterIds: string[];
  filterMode?: string;
}) {
  // Data: pull from the SAME scoped keys the rest of the dashboard uses so this
  // section respects the active profile filter (BUG G3 — these were bare keys
  // that silently rendered Everyone data while a single profile was selected).
  // They resolve from the bootstrap seed / sibling queries on the happy path;
  // the queryFns are the fallback when this section mounts first.
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: trackers = [] } = useQuery<any[]>({
    queryKey: ["/api/trackers", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/trackers${profileParam}`).then(r => r.json()).catch(() => []),
  });
  const { data: obligations = [] } = useQuery<any[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/obligations${profileParam}`)).then(r => r.json()).catch(() => []),
  });
  const { data: habits = [] } = useQuery<any[]>({
    queryKey: ["/api/habits", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/habits${profileParam}`)).then(r => r.json()).catch(() => []),
  });
  const { data: enhancedData } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/dashboard-enhanced${profileParam}`).then(r => r.json()).catch(() => null),
  });
  const { data: networthHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/net-worth/history", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/net-worth/history?lookbackDays=120${profileParam ? `&profileIds=${filterIds.join(",")}` : ""}`).then(r => r.json()).catch(() => []),
  });

  // PR M — When scoped to specific profile(s), the cross-profile aggregates
  // (financeSnapshot totals, net-worth history, obligations list, habits list)
  // are not filtered server-side and would leak another profile's signals
  // (e.g. "Spending decreased 100% — $705,251 → $250" where $705,251 is the
  // everyone-aggregate). Until each of those endpoints exposes per-profile
  // filtering, hide them from the findings computation when scoped. Trackers
  // already have linkedProfiles-based filtering inside computeKeyFindings.
  const scoped = filterIds.length > 0;
  const findings = useMemo(() => computeKeyFindings({
    trackers,
    obligations: scoped ? [] : obligations,
    habits: scoped ? [] : habits,
    financeSnapshot: scoped ? undefined : enhancedData?.financeSnapshot,
    netWorthHistory: scoped ? [] : networthHistory,
    scopedProfileIds: scoped ? filterIds : undefined,
  }), [trackers, obligations, habits, enhancedData, networthHistory, filterIds, scoped]);

  const TOP_N = 8;
  const top = findings.slice(0, TOP_N);
  const moreCount = Math.max(0, findings.length - TOP_N);

  // CRITICAL design contract: no findings → hide the whole section (never render
  // an empty card per the user's display rules).
  if (top.length === 0) return null;

  return (
    <CollapsibleSection
      accent="262 70% 60%"
      icon={Lightbulb}
      label="Key Findings & Tracker Insights"
      count={findings.length}
      testId="section-key-findings"
    >
      <div className="space-y-0.5">
        {top.map(f => <KeyFindingRow key={f.id} finding={f} />)}
        {moreCount > 0 && (
          <p className="text-[11px] text-muted-foreground/60 text-center pt-1.5">
            {moreCount} more finding{moreCount === 1 ? "" : "s"} — drill into a tracker to explore
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

function HealthSection({ data }: { data: any[] }) {
  const [, navigate] = useLocation();
  const [selectedTracker, setSelectedTracker] = useState<any>(null);

  const filteredData = useMemo(() => (data || []).filter((item: any) => !/test/i.test(item.name)).sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).slice(0, 4), [data]);

  if (!data || data.length === 0) return (
    <CollapsibleSection accent="173 60% 44%" icon={HeartPulse} label="Health" testId="section-health">
      <div className="rounded-lg border border-dashed border-border/50 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Heart className="h-5 w-5 text-muted-foreground/40" />
          <p className="text-xs text-muted-foreground">No health data yet.</p>
        </div>
        {/* Quick-log tracker buttons removed 2026-05-21 — trackers can only
            be created through the chat. The AI prompt below explains how. */}
        <p className="text-[11px] text-muted-foreground/80 text-center">
          Ask Portol in chat: <span className="font-medium text-foreground">“I weigh 180 lbs”</span> or <span className="font-medium text-foreground">“track my sleep”</span>.
        </p>
      </div>
    </CollapsibleSection>
  );

  return (
    <>
      <CollapsibleSection accent="173 60% 44%" icon={HeartPulse} label="Health" count={filteredData.length} testId="section-health">
        <div className="grid grid-cols-2 gap-2">
          {filteredData.map((item: any) => {
            // Theme-driven accent so dashboard tracker cards match the central
            // category palette used everywhere else in the app.
            const theme = categoryTheme(item.category, item.name);
            const themeColor = `hsl(${theme.hsl})`;
            // Status overrides for medical out-of-range readings.
            let statusColor = themeColor;
            const name = item.name?.toLowerCase() || '';
            const val = item.latestValue;
            if (name.includes('blood') || name.includes('bp')) {
              if (val > 140 || val < 90) statusColor = '#ef4444';
              else if (val > 130) statusColor = '#f59e0b';
            }
            const ItemIcon = theme.icon;
            // Mini sparkline from recent entries (7 points)
            const spark: number[] = item.recentValues || [];
            const sparkMax = Math.max(...spark, 1);
            const sparkMin = Math.min(...spark, 0);
            const sparkRange = sparkMax - sparkMin || 1;

            const displayVal = item.dailyTotal != null ? item.dailyTotal : item.latestValue;
            const isNumeric = typeof displayVal === "number" && !isNaN(displayVal);
            const lastEntryMs = item.lastEntry ? new Date(item.lastEntry).getTime() : null;
            const daysAgo = lastEntryMs != null ? Math.floor((Date.now() - lastEntryMs) / 86400000) : null;
            const lastLogLabel = daysAgo == null ? null : daysAgo === 0 ? "today" : daysAgo === 1 ? "1d ago" : daysAgo < 30 ? `${daysAgo}d ago` : `${Math.floor(daysAgo/30)}mo ago`;
            return (
              <MetricCard
                key={item.trackerId}
                accent={theme.hsl}
                icon={ItemIcon}
                label={item.name}
                onClick={() => setSelectedTracker(item)}
                aria-label={`View tracker: ${item.name}`}
                headerRight={<TrendIcon trend={item.trend} />}
                value={
                  <span
                    className={isNumeric ? "" : "text-sm italic text-muted-foreground/90 truncate"}
                    style={isNumeric ? { color: statusColor } : undefined}
                    title={!isNumeric ? String(displayVal) : undefined}
                  >
                    {isNumeric ? Number(displayVal).toLocaleString(undefined, { maximumFractionDigits: 1 }) : displayVal}
                  </span>
                }
                unit={isNumeric && item.unit ? item.unit : undefined}
                chart={spark.length > 1 && isNumeric ? (
                  <svg width="100%" height="18" viewBox={`0 0 ${spark.length * 8} 18`} preserveAspectRatio="none" className="opacity-80">
                    <polyline
                      points={spark.map((v,i) => `${i*8},${18 - ((v-sparkMin)/sparkRange)*16}`).join(' ')}
                      fill="none" stroke={statusColor} strokeWidth="1.75" />
                  </svg>
                ) : undefined}
                footer={<>
                  <span className="font-medium">{item.average != null && isNumeric ? `7d avg ${item.average}` : ""}</span>
                  {lastLogLabel && <span>{lastLogLabel}</span>}
                </>}
              />
            );
          })}
        </div>
        <ViewPageLink href="/trackers" label="View All Trackers" />
      </CollapsibleSection>

      {/* Health Tracker Detail Popup */}
      <Dialog open={!!selectedTracker} onOpenChange={o => { if (!o) setSelectedTracker(null); }}>
        <DialogContent className="max-w-xs max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <HeartPulse className="h-4 w-4 text-primary" />
              {selectedTracker?.name}
            </DialogTitle>
            <DialogDescription className="text-xs">{selectedTracker?.entries || 0} entries · {selectedTracker?.unit || ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Latest</span><span className="font-semibold">{selectedTracker?.latestValue} {selectedTracker?.unit}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">7-day avg</span><span>{selectedTracker?.average} {selectedTracker?.unit}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Trend</span><span className="flex items-center gap-1"><TrendIcon trend={selectedTracker?.trend || "flat"} /> {selectedTracker?.trendValue > 0 ? `Δ ${selectedTracker.trendValue}` : "Stable"}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Entries</span><span>{selectedTracker?.entryCount} in last 7 days</span></div>
            {selectedTracker?.lastEntry && <div className="flex justify-between text-xs"><span className="text-muted-foreground">Last logged</span><span>{timeAgo(selectedTracker.lastEntry)}</span></div>}
          </div>
          <Button size="sm" variant="outline" className="w-full h-7 text-xs mt-1" onClick={() => { setSelectedTracker(null); navigate("/trackers"); }}>
            <ExternalLink className="h-3 w-3 mr-1" /> Open in Trackers
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Section: Bills & Obligations ────────────────────────────────────────────

// One collapsible bill bucket ("Due This Week" / "Due This Month").
//
// MUST STAY AT MODULE SCOPE. This was declared inside the section component's
// body, which gives it a brand-new function identity on every parent render —
// React then treats it as a different component type, unmounts the old tree and
// mounts a fresh one, so its `expanded` state reset to false and the group
// snapped shut again on the next render the page happened to do (a refetch, a
// scope change, any sibling state update). QA report 2026-08-05: an expander
// that "never expands". Defining a component inside another component is the
// bug, not the styling.
// One row of "Action Required".
//
// MUST STAY AT MODULE SCOPE — see BillGroup above. Declared inside its parent
// it was a new component type on every render, so React threw the row's DOM
// away and rebuilt it each time the dashboard re-rendered: focus left the
// button you were about to press and every hover/transition restarted.
function AttentionItem({ id, title, detail, sourceType, accentColor, onComplete, onSnooze, onPay, onBillSnooze, onDismiss }: {
id: string; title: string; detail: string; sourceType: "task" | "bill"; accentColor: string;
onComplete: (id: string) => void;
onSnooze: (id: string) => void;
onPay: (id: string) => void;
onBillSnooze: (id: string) => void;
onDismiss: (key: string) => void;
}) {
  return (
    <div className={`flex items-center gap-1 py-[5px] border-l-2 pl-1.5 pr-0.5 rounded-r-lg transition-colors ${
      accentColor === '#ef4444' ? 'bg-red-500/5 hover:bg-red-500/8' : 'bg-amber-500/5 hover:bg-amber-500/8'
    }`} style={{ borderLeftColor: accentColor }}>
      <span className="text-xs font-medium truncate flex-1 leading-tight">{title}</span>
      <span className="text-xs-tight text-muted-foreground shrink-0 tabular-nums">{detail}</span>
      <div className="flex items-center shrink-0 ml-0.5">
        {sourceType === "task" && (
          <>
            <button onClick={() => onComplete(id)} title="Complete"
              className="h-5 w-5 rounded flex items-center justify-center hover:bg-green-500/20 text-green-600">
              <Check className="h-2.5 w-2.5" />
            </button>
            <button onClick={() => onSnooze(id)} title="Snooze 7d"
              className="h-5 w-5 rounded flex items-center justify-center hover:bg-amber-500/20 text-amber-600">
              <Clock className="h-2.5 w-2.5" />
            </button>
          </>
        )}
        {sourceType === "bill" && (
          <>
            <button
              onClick={() => onPay(id)}
              title="Mark paid"
              className="h-5 px-1.5 rounded flex items-center gap-0.5 hover:bg-green-500/20 text-green-600 text-[11px] font-semibold"
              data-testid={`btn-pay-bill-${id}`}
            >
              <DollarSign className="h-2.5 w-2.5" />
              Pay
            </button>
            <button
              onClick={() => onBillSnooze(id)}
              title="Snooze 7d"
              className="h-5 w-5 rounded flex items-center justify-center hover:bg-amber-500/20 text-amber-600"
              data-testid={`btn-snooze-bill-${id}`}
            >
              <Clock className="h-2.5 w-2.5" />
            </button>
          </>
        )}
        <button onClick={() => onDismiss(`${sourceType}-${id}`)} title="Dismiss"
          className="h-5 w-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground">
          <X className="h-2 w-2" />
        </button>
      </div>
    </div>
  );
}

function BillGroup({ title, bills, color, onSelectBill }: {
  title: string;
  bills: any[];
  color: string;
  onSelectBill: (bill: any) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (bills.length === 0) return null;
  const groupTotal = bills.reduce((s: number, b: any) => s + (b.amount || 0), 0);
  return (
    <div className="space-y-0.5">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-1.5 py-1 text-left hover:bg-muted/30 rounded px-1 -mx-1 transition-colors"
        aria-expanded={expanded}
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-xs font-semibold flex-1" style={{ color }}>{title}</span>
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">{bills.length} · {formatMoney(groupTotal)}</span>
        {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="divide-y divide-border/30 pl-3">
          {bills.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((bill: any) => (
            <div key={bill.id}
              onClick={() => onSelectBill(bill)}
              role="button" tabIndex={0} aria-label={`View bill: ${bill.name}`}
              onKeyDown={onEnterOrSpace(() => onSelectBill(bill))}
              className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-muted/40 rounded transition-colors">
              <span className="text-xs truncate flex-1">{bill.name}</span>
              {bill.autopay && <span className="text-xs-tight text-green-500 shrink-0">autopay</span>}
              <span className="text-xs font-semibold tabular-nums shrink-0">{formatMoney(bill.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ObligationsSection({ data }: { data: any[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [selectedBill, setSelectedBill] = useState<any>(null);

  const payMutation = useMutation({
    mutationFn: ({ id, name, amount }: { id: string; name?: string; amount?: number }) => apiRequest("POST", `/api/obligations/${id}/pay`),
    // Optimistic: this section renders enhanced.financeSnapshot.upcomingBills,
    // so that is what gets patched (same helper as the Now queue's payBill).
    // The old patch filtered the /api/obligations entity lists instead —
    // which never updated this section AND removed a still-live obligation
    // from every other consumer of those lists. Reconcile from server in
    // onSettled.
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/dashboard-enhanced"] });
      const restore = dropUpcomingBillFromDashboard(id);
      return { restore };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.name || "Bill"}" marked paid`, description: variables.amount ? `$${variables.amount.toFixed(2)} payment recorded` : undefined });
      setSelectedBill(null);
    },
    onError: (_err, variables, context: any) => {
      // Roll back optimistic removal
      context?.restore?.();
      toast({ title: `Failed to mark "${variables.name || "bill"}" as paid`, variant: "destructive" });
    },
    onSettled: () => {
      // Cache bus: obligations domain covers stats, dashboard-enhanced,
      // cashflow, obligations, loans/schedule in one consolidated shot.
      invalidateDomain("obligations");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) => apiRequest("DELETE", `/api/obligations/${id}`),
    onMutate: async (variables) => {
      // Optimistic removal so the row disappears instantly — from the bills
      // aggregate this section renders AND from every ["/api/obligations", ...]
      // entity list (a delete really does remove the obligation). Both are
      // snapshotted so a rejected delete (e.g. 404 from a stale duplicate)
      // rolls back cleanly.
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      await queryClient.cancelQueries({ queryKey: ["/api/dashboard-enhanced"] });
      const restoreLists = patchQueries(["/api/obligations"], (old: any) =>
        Array.isArray(old) ? old.filter((item: any) => item.id !== variables.id) : undefined
      );
      const restoreBills = dropUpcomingBillFromDashboard(variables.id);
      return { restore: () => { restoreBills(); restoreLists(); } };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.name || "Obligation"}" deleted` });
      setSelectedBill(null);
    },
    onError: (_err, variables, ctx: any) => {
      // Restore every cache slot the optimistic removal touched.
      ctx?.restore?.();
      toast({ title: `Failed to delete "${variables.name || "obligation"}"`, variant: "destructive" });
    },
    onSettled: () => {
      // Use the cache bus so /api/stats, /api/dashboard-enhanced,
      // /api/cashflow, /api/loans/schedule all refresh together.
      invalidateDomain("obligations");
    },
  });

  // Group bills by timeframe. No "overdue" bucket (product decision 2026-06): a
  // recurring bill whose due date has passed simply hasn't rolled forward yet, so
  // it belongs in the soonest window showing its real due date — never flagged red.
  // "This Week" = anything due within 7 days, INCLUDING past-due (daysUntil <= 7).
  const thisWeekBills = useMemo(() => (data || []).filter((b: any) => b.daysUntil <= 7), [data]);
  const thisMonthBills = useMemo(() => (data || []).filter((b: any) => b.daysUntil > 7 && b.daysUntil <= 30), [data]);

  const monthlyTotal = useMemo(() => (data || []).reduce((sum: number, b: any) => sum + (b.amount || 0), 0), [data]);

  if (!data || data.length === 0) return (
    <CollapsibleSection accent="43 75% 50%" icon={CreditCard} label="Bills & Subscriptions" testId="section-obligations">
      <div className="text-center py-4">
        <CreditCard className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No upcoming bills</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <>
      <CollapsibleSection accent="43 75% 50%" icon={CreditCard} label="Bills & Subscriptions"
        sub={`Monthly Total: ${formatMoney(monthlyTotal)}`}
        count={data.length} testId="section-obligations">
        <div className="space-y-1">
          {/* Proportion overview bar */}
          {(() => {
            const wk = thisWeekBills.reduce((s:number,b:any)=>s+(b.amount||0),0);
            const mn = thisMonthBills.reduce((s:number,b:any)=>s+(b.amount||0),0);
            const total = wk+mn;
            if (total === 0) return null;
            return (
              <div className="mb-2">
                <div className="flex h-2 rounded-full overflow-hidden gap-px bg-muted/30">
                  {wk > 0 && <div style={{width:`${(wk/total)*100}%`,background:'#f59e0b'}} className="rounded-l-full transition-all" />}
                  {mn > 0 && <div style={{width:`${(mn/total)*100}%`,background:'hsl(var(--muted-foreground) / 0.35)'}} className="rounded-r-full transition-all" />}
                </div>
                <div className="flex gap-3 mt-1">
                  {wk > 0 && <span className="text-[11px] text-amber-500 font-medium">● Week ${wk.toFixed(0)}</span>}
                  {mn > 0 && <span className="text-[11px] text-muted-foreground">● Month ${mn.toFixed(0)}</span>}
                </div>
              </div>
            );
          })()}
          <BillGroup title="Due This Week" bills={thisWeekBills} color="#f59e0b" onSelectBill={setSelectedBill} />
          <BillGroup title="Due This Month" bills={thisMonthBills} color="#6b7280" onSelectBill={setSelectedBill} />
        </div>
        <ViewPageLink href="/bills" label="View all bills" />
      </CollapsibleSection>

      {/* Obligation Detail Popup */}
      <Dialog open={!!selectedBill} onOpenChange={o => { if (!o) setSelectedBill(null); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          {(() => {
            const bill = selectedBill;
            if (!bill) return null;
            const days = bill.daysUntil;
            // No overdue state — due-this-week gets a calm amber chip, everything
            // else (including past-due) is neutral and shows its real due date.
            const soon = typeof days === 'number' && days >= 0 && days <= 7;
            const chipColor = soon ? 'text-amber-500 bg-amber-500/10 border-amber-500/30'
              : 'text-muted-foreground bg-muted/40 border-border';
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="text-sm flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-amber-500" />
                    <span className="truncate flex-1">{bill.name}</span>
                  </DialogTitle>
                  <DialogDescription className="text-xs flex items-center gap-1.5 flex-wrap">
                    <span>Bill details</span>
                    {bill.frequency && <span className="text-muted-foreground/70">· {bill.frequency}</span>}
                  </DialogDescription>
                </DialogHeader>
                {/* Amount hero */}
                <div className="rounded-lg border bg-muted/30 p-3 mt-1">
                  <p className="micro-label text-muted-foreground">Amount due</p>
                  <p className="text-xl font-bold tabular-nums">{formatMoney(bill.amount || 0)}</p>
                  {typeof days === 'number' && (
                    <span className={`inline-flex items-center gap-1 mt-1 text-[11px] font-semibold px-1.5 py-0.5 rounded border ${chipColor}`}>
                      <Clock className="h-2.5 w-2.5" />
                      {billDueLabel(bill)}
                    </span>
                  )}
                </div>
                <div className="space-y-1.5 py-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Due date</span>
                    <span className="font-medium tabular-nums">{bill.dueDate ? fmtDate(bill.dueDate) : "—"}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Category</span>
                    <span className="capitalize">{bill.category || "general"}</span>
                  </div>
                  {bill.frequency && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Frequency</span>
                      <span className="capitalize">{bill.frequency}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Autopay</span>
                    <span className={bill.autopay ? "text-green-500 font-medium" : ""}>{bill.autopay ? "Yes — will charge automatically" : "No — pay manually"}</span>
                  </div>
                  {bill.provider && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Provider</span>
                      <span className="truncate ml-2">{bill.provider}</span>
                    </div>
                  )}
                  {bill.profileName && (
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Linked to</span>
                      <span className="truncate ml-2">{bill.profileName}</span>
                    </div>
                  )}
                  {bill.notes && (
                    <div className="pt-1 text-xs">
                      <p className="text-muted-foreground mb-0.5">Notes</p>
                      <p className="text-foreground/80 italic">{bill.notes}</p>
                    </div>
                  )}
                </div>
                {bill.autopay && (
                  <p className="text-[11px] text-muted-foreground/70 italic px-1">
                    This bill is on autopay. Marking as paid manually only updates Portol's record.
                  </p>
                )}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => payMutation.mutate({ id: bill.id, name: bill.name, amount: bill.amount })}
                    disabled={payMutation.isPending}>
                    <Check className="h-3 w-3 mr-1" /> Mark Paid
                  </Button>
                  <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deleteMutation.mutate({ id: bill.id, name: bill.name })}
                    disabled={deleteMutation.isPending}>
                    <Trash2 className="h-3 w-3 mr-1" /> Delete
                  </Button>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Section: Goals ─────────────────────────────────────────────────────────

interface GoalItem {
  id: string; title: string; type: string; target: number; current: number;
  unit: string; status: string; deadline?: string; trackerId?: string;
  startValue?: number; milestones: any[]; createdAt: string;
}

function GoalProgressBar({ goal }: { goal: GoalItem }) {
  const hasValidTarget = goal.target > 0;
  const pct = hasValidTarget ? Math.min(100, Math.round((goal.current / goal.target) * 100)) : 0;
  const isComplete = normalizeFilter(goal.status) === normalizeFilter("completed") || pct >= 100;
  const daysLeft = goal.deadline ? Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86400000) : null;

  if (!hasValidTarget) {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium truncate">{goal.title}</span>
          <span className="text-xs text-muted-foreground shrink-0 ml-2">No target set</span>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{goal.current} {goal.unit}</span>
          {daysLeft != null && daysLeft > 0 && <span>{daysLeft}d left</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium truncate">{goal.title}</span>
        <span className="text-xs text-muted-foreground shrink-0 ml-2">
          {isComplete ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 inline" /> : `${pct}%`}
        </span>
      </div>
      {(() => {
        const isAtRisk = daysLeft !== null && daysLeft <= 30 && pct < 50 && normalizeFilter(goal.status) === normalizeFilter('active');
        const isCompleted = isComplete;
        return (
          <div className="relative h-2 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted))' }}>
            <div className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${pct}%`,
                background: isCompleted
                  ? 'linear-gradient(90deg, #10b981, #34d399)'
                  : isAtRisk
                  ? 'linear-gradient(90deg, #f59e0b, #ef4444)'
                  : `linear-gradient(90deg, hsl(188 70% 48%), hsl(155 60% 44%))`,
              }} />
            {isAtRisk && pct > 0 && (
              <div className="absolute inset-0 rounded-full animate-pulse opacity-30"
                style={{ background: 'linear-gradient(90deg, #f59e0b, #ef4444)', width: `${pct}%` }} />
            )}
          </div>
        );
      })()}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{goal.current} / {goal.target} {goal.unit}{(!goal.current && !isComplete) ? " · 0%" : ""}</span>
        {daysLeft != null && daysLeft > 0 && <span>{daysLeft}d left</span>}
        {daysLeft != null && daysLeft <= 0 && normalizeFilter(goal.status) === normalizeFilter("active") && <span className="text-destructive">overdue</span>}
      </div>
    </div>
  );
}

export function GoalsSection({ profileId, profileIds = [] }: { profileId?: string; profileIds?: string[] }) {
  // Multi-profile aware: prefer profileIds (array) when present, fall back to single profileId.
  const ids = profileIds.length > 0 ? profileIds : (profileId ? [profileId] : []);
  const profileParam = ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  // Canonical key: ["/api/goals", mode, ...ids] via scopedKey — see
  // shared/query-keys.ts and ARCHITECTURE.md §3. Both dashboard and
  // trackers must use this so their caches share one slot.
  // BUG-20260528-goals-key-shape
  const goalsKey = goalsQueryKey(ids);
  const { data: goals = [], isPending: isLoading, error: goalsError } = useQuery<GoalItem[]>({
    queryKey: goalsKey,
    queryFn: () => apiRequest("GET", withFullLimit(`/api/goals${profileParam}`)).then(r => r.json()),
    // BUG-20260530-filter-stale-stats-leak: during a filter swap, react-query
    // was returning the previous filter's goals (e.g. Test's Hawaii Savings,
    // QAMULTI389053) while looking at Craig (who has none). Forcing undefined
    // makes the section show its empty state until the new fetch lands.
    placeholderData: undefined,
  });
  const [editGoal, setEditGoal] = useState<GoalItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [formTitle, setFormTitle] = useState("");
  const [formTarget, setFormTarget] = useState("");
  const [formUnit, setFormUnit] = useState("");
  const [formDeadline, setFormDeadline] = useState("");
  const [formType, setFormType] = useState("custom");
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/goals", data).then(r => r.json()),
    onSuccess: () => {
      // Cache bus: goals domain = /api/goals + /api/stats + /api/dashboard-enhanced.
      invalidateDomain("goals");
      const name = formTitle;
      setCreating(false); resetForm();
      toast({ title: `"${name}" goal created`, description: formTarget ? `Target: ${formTarget} ${formUnit}` : undefined });
    },
    onError: (e: Error) => toast({ title: "Failed to create goal", description: e.message, variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, title, ...data }: any) => apiRequest("PATCH", `/api/goals/${id}`, { title, ...data }).then(r => r.json()),
    // Optimistic (CalendarView pattern): patch the goal in the cached list so
    // progress bars / status flips paint immediately; server confirms via the
    // cache-bus invalidation in onSettled, rollback in onError.
    onMutate: async ({ id, title, ...data }: any) => {
      await queryClient.cancelQueries({ queryKey: goalsKey });
      const prev = queryClient.getQueryData<GoalItem[]>(goalsKey);
      queryClient.setQueryData<GoalItem[]>(goalsKey, (old) =>
        (old || []).map((g: any) => g.id === id ? { ...g, ...(title !== undefined ? { title } : {}), ...data } : g));
      return { prev };
    },
    onSuccess: (_data, variables) => {
      setEditGoal(null); resetForm();
      toast({ title: `"${variables.title || editGoal?.title || "Goal"}" updated` });
    },
    onError: (err: Error, variables, ctx: any) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(goalsKey, ctx.prev);
      toast({ title: `Failed to update "${variables.title || "goal"}"`, description: err.message, variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("goals"); },
  });
  const deleteMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title?: string }) => apiRequest("DELETE", `/api/goals/${id}`),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/goals"] });
      const prev = queryClient.getQueryData(goalsKey);
      queryClient.setQueryData(goalsKey, (old: any[] | undefined) => (old || []).filter((g: any) => g.id !== id));
      return { prev };
    },
    onSuccess: (_data, variables) => {
      invalidateDomain("goals");
      setEditGoal(null);
      toast({ title: `"${variables.title || "Goal"}" deleted` });
    },
    onError: (_err: Error, variables, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(goalsKey, ctx.prev);
      toast({ title: `Failed to delete "${variables.title || "goal"}"`, variant: "destructive" });
    },
  });

  const resetForm = () => { setFormTitle(""); setFormTarget(""); setFormUnit(""); setFormDeadline(""); setFormType("custom"); };
  const openEdit = (g: GoalItem) => { setEditGoal(g); setFormTitle(g.title); setFormTarget(String(g.target)); setFormUnit(g.unit); setFormDeadline(g.deadline || ""); setFormType(g.type); };
  const openCreate = () => { resetForm(); setCreating(true); };

  const handleSave = () => {
    if (!formTitle.trim() || !formTarget || Number(formTarget) <= 0) return;
    const payload = { title: formTitle.trim(), type: formType, target: Number(formTarget), unit: formUnit || "units", deadline: formDeadline || undefined };
    if (editGoal) {
      // Only what changed (D213); a cleared deadline goes as "" (D214).
      const seeded = { title: editGoal.title, type: editGoal.type, target: Number(editGoal.target), unit: editGoal.unit, deadline: editGoal.deadline || "" };
      const patch = changedFieldsOnly(seeded, { ...payload, deadline: formDeadline || "" });
      updateMutation.mutate({ id: editGoal.id, ...patch });
      return;
    }
    else createMutation.mutate(payload);
  };

  const [actionGoal, setActionGoal] = useState<GoalItem | null>(null);
  const [progressInput, setProgressInput] = useState("");
  const activeGoals = useMemo(() => goals.filter(g => normalizeFilter(g.status) === normalizeFilter("active")), [goals]);
  const completedGoals = useMemo(() => goals.filter(g => normalizeFilter(g.status) === normalizeFilter("completed")), [goals]);

  if (isLoading) return <CollapsibleSection accent="188 70% 48%" icon={Target} label="Goals" testId="section-goals"><div className="h-16 bg-muted animate-pulse rounded-lg" /></CollapsibleSection>;
  if (goalsError) return <CollapsibleSection accent="188 70% 48%" icon={Target} label="Goals" testId="section-goals"><p className="text-destructive text-sm p-4">Failed to load goals. Please refresh.</p></CollapsibleSection>;

  return (
    <>
      <CollapsibleSection accent="188 70% 48%" icon={Target} label="Goals" count={activeGoals.length} testId="section-goals">
        {activeGoals.length === 0 && completedGoals.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/50 p-4 text-center">
            <Target className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground mb-1">No goals yet</p>
            <p className="text-xs text-muted-foreground/70 mb-2">Tell the AI: "Set a goal to run 3x per week" or "Save $5000 by December"</p>
            <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={openCreate} data-testid="btn-create-first-goal">
              <Target className="h-3 w-3 mr-1" /> Set a Goal
            </Button>
          </div>
        ) : (() => {
            // Decorate active goals with computed state, then split into Overdue (action needed)
            // vs Active (on-track / at-risk / hit-100%). Status==='completed' wins celebration;
            // pct>=100 without explicit completion is treated as 'ready to mark complete', not
            // celebration — to avoid contradictory signals (e.g. "6d late 🎉 100%").
            const decorated = activeGoals.map(g => {
              const goalCurrent = g.current || g.startValue || 0;
              const pct = g.target > 0 ? Math.min(100, Math.round((goalCurrent / g.target) * 100)) : 0;
              const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 86400000) : null;
              const isOverdue = daysLeft !== null && daysLeft < 0;
              const isAtRisk = !isOverdue && daysLeft !== null && daysLeft <= 30 && pct < 50 && daysLeft > 0;
              const explicitlyCompleted = normalizeFilter(g.status) === normalizeFilter("completed");
              const isReadyToComplete = pct >= 100 && !isOverdue && !explicitlyCompleted;
              return { g, goalCurrent, pct, daysLeft, isOverdue, isAtRisk, explicitlyCompleted, isReadyToComplete };
            });
            const overdueRows = decorated.filter(d => d.isOverdue).sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
            const activeRows = decorated.filter(d => !d.isOverdue).sort((a, b) => a.g.title.localeCompare(b.g.title));
            const renderRow = (d: typeof decorated[number]) => {
              const { g, pct, daysLeft, isOverdue, isAtRisk, isReadyToComplete } = d;
              return (
                <div key={g.id}
                  className={`flex items-center gap-2 py-1.5 px-1.5 rounded-lg group transition-colors ${
                    isOverdue ? 'bg-red-500/5 border border-red-500/20' :
                    isAtRisk ? 'bg-amber-500/5 border border-amber-500/20' :
                    isReadyToComplete ? 'bg-emerald-500/5 border border-emerald-500/30' :
                    'border border-transparent'
                  }`}
                  data-testid={`goal-card-${g.id}`}>
                  <button
                    className="h-5 w-5 rounded-full border-2 border-primary/40 flex items-center justify-center shrink-0 hover:bg-green-500/20 hover:border-green-500 active:scale-90 transition-all disabled:opacity-50 disabled:pointer-events-none"
                    onClick={() => updateMutation.mutate({ id: g.id, status: "completed" })}
                    disabled={updateMutation.isPending}
                    title="Mark complete"
                  >
                    {updateMutation.isPending ? (
                      <span className="h-2.5 w-2.5 border border-primary/40 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <Check className="h-2.5 w-2.5 text-transparent group-hover:text-green-500" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0 cursor-pointer" role="button" tabIndex={0} aria-label={`Open goal: ${g.title}`} onClick={() => setActionGoal(g)} onKeyDown={onEnterOrSpace(() => setActionGoal(g))}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs-loose font-medium truncate">{g.title}</span>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        {isOverdue && <span className="text-[11px] font-bold text-red-500">OVERDUE</span>}
                        {!isOverdue && isAtRisk && <span className="text-[11px] font-bold text-amber-500">AT RISK</span>}
                        {isReadyToComplete && <span className="text-[11px] font-bold text-emerald-500">DONE — MARK COMPLETE</span>}
                        <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${pct}%`,
                            background: isOverdue ? 'linear-gradient(90deg,#ef4444,#dc2626)' :
                              isAtRisk ? 'linear-gradient(90deg,#f59e0b,#fbbf24)' :
                              isReadyToComplete ? 'linear-gradient(90deg,#10b981,#34d399)' :
                              'linear-gradient(90deg,hsl(188 70% 48%),hsl(155 60% 44%))'
                          }} />
                      </div>
                      {daysLeft !== null && daysLeft >= 0 && <span className={`text-xs-tight shrink-0 tabular-nums ${isAtRisk ? 'text-amber-500 font-medium' : 'text-muted-foreground'}`}>{daysLeft}d left</span>}
                      {isOverdue && <span className="text-xs-tight text-red-500 font-medium shrink-0 tabular-nums">{Math.abs(daysLeft!)}d late</span>}
                    </div>
                  </div>
                </div>
              );
            };
            return (
              <div className="space-y-1">
                {overdueRows.length > 0 && (
                  <>
                    <p className="micro-label text-red-500/80 mt-0.5 mb-0.5 px-1">
                      Overdue — action needed ({overdueRows.length})
                    </p>
                    {overdueRows.map(renderRow)}
                    {activeRows.length > 0 && <div className="h-px bg-border/30 my-1.5" />}
                  </>
                )}
                {activeRows.length > 0 && (
                  <>
                    {overdueRows.length > 0 && (
                      <p className="micro-label text-muted-foreground/70 mb-0.5 px-1">
                        In progress ({activeRows.length})
                      </p>
                    )}
                    {activeRows.map(renderRow)}
                  </>
                )}
                {completedGoals.length > 0 && (
                  <div className="pt-1.5 mt-1 border-t border-border/30">
                    <p className="micro-label text-emerald-500/80 mb-0.5 px-1">
                      Completed 🎉 ({completedGoals.length})
                    </p>
                    {completedGoals.slice().sort((a, b) => a.title.localeCompare(b.title)).slice(0, 3).map(g => (
                      <div key={g.id} className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70">
                        <CheckCircle2 className="h-3 w-3 text-emerald-500/70 shrink-0" />
                        <span className="line-through truncate">{g.title}</span>
                      </div>
                    ))}
                  </div>
                )}
                <Button size="sm" variant="outline" className="w-full h-7 text-xs mt-1" onClick={openCreate} data-testid="btn-add-goal">
                  <Target className="h-3 w-3 mr-1" /> Add Goal
                </Button>
              </div>
            );
          })()}
      </CollapsibleSection>

      {/* Goal Quick Actions Sheet */}
      <Sheet open={!!actionGoal} onOpenChange={v => { if (!v) { setActionGoal(null); setProgressInput(""); } }}>
        <SheetContent side="bottom" className="max-h-[60vh] rounded-t-2xl px-4 pb-8">
          {actionGoal && (() => {
            const currentVal = actionGoal.current || actionGoal.startValue || 0;
            const pct = actionGoal.target > 0 ? Math.min(100, Math.round((currentVal / actionGoal.target) * 100)) : 0;
            const remaining = Math.max(0, actionGoal.target - currentVal);
            // Pace analysis — only when both deadline and createdAt exist (no fabrication).
            const daysLeft = actionGoal.deadline
              ? Math.ceil((new Date(actionGoal.deadline).getTime() - Date.now()) / 86400000)
              : null;
            let pace: { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; detail: string } | null = null;
            if (actionGoal.deadline && actionGoal.createdAt && actionGoal.target > 0) {
              const startMs = new Date(actionGoal.createdAt).getTime();
              const endMs = new Date(actionGoal.deadline).getTime();
              const totalDays = Math.max(1, Math.round((endMs - startMs) / 86400000));
              const elapsed = Math.max(0, Math.min(totalDays, Math.round((Date.now() - startMs) / 86400000)));
              const expectedPct = Math.round((elapsed / totalDays) * 100);
              const delta = pct - expectedPct;
              if (pct >= 100) {
                pace = { label: 'Complete', tone: 'good', detail: 'Target reached' };
              } else if (daysLeft !== null && daysLeft < 0) {
                pace = { label: 'Overdue', tone: 'bad', detail: `${Math.abs(daysLeft)}d past deadline` };
              } else if (delta >= 5) {
                pace = { label: 'Ahead', tone: 'good', detail: `+${delta}% vs expected pace` };
              } else if (delta <= -10) {
                pace = { label: 'Behind', tone: 'bad', detail: `${delta}% vs expected pace` };
              } else if (delta <= -5) {
                pace = { label: 'Slightly behind', tone: 'warn', detail: `${delta}% vs expected pace` };
              } else {
                pace = { label: 'On track', tone: 'good', detail: `Within ${Math.abs(delta)}% of expected pace` };
              }
            }
            const paceTone = pace ? ({
              good: 'text-green-500 bg-green-500/10 border-green-500/30',
              warn: 'text-amber-500 bg-amber-500/10 border-amber-500/30',
              bad: 'text-red-500 bg-red-500/10 border-red-500/30',
              neutral: 'text-muted-foreground bg-muted/40 border-border',
            }[pace.tone]) : '';
            return (
              <div className="space-y-4 pt-2">
                {/* Header with progress */}
                <div>
                  <h3 className="text-sm font-semibold">{actionGoal.title}</h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-bold tabular-nums">{pct}%</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {currentVal.toLocaleString()} / {actionGoal.target.toLocaleString()} {actionGoal.unit}
                    {remaining > 0 && ` · ${remaining.toLocaleString()} ${actionGoal.unit} to go`}
                  </p>
                  {/* Deadline + pace chips */}
                  {(actionGoal.deadline || pace) && (
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      {actionGoal.deadline && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-muted/60 border">
                          <Clock className="h-2.5 w-2.5" />
                          {daysLeft !== null && daysLeft > 0
                            ? `${daysLeft}d left · due ${new Date(actionGoal.deadline).toLocaleDateString()}`
                            : daysLeft !== null && daysLeft === 0
                            ? `Due today`
                            : daysLeft !== null && daysLeft < 0
                            ? `${Math.abs(daysLeft)}d overdue`
                            : `Due ${new Date(actionGoal.deadline).toLocaleDateString()}`}
                        </span>
                      )}
                      {pace && (
                        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded border ${paceTone}`}>
                          {pace.tone === 'good' ? <TrendingUp className="h-2.5 w-2.5" /> : pace.tone === 'bad' ? <TrendingDown className="h-2.5 w-2.5" /> : <Minus className="h-2.5 w-2.5" />}
                          {pace.label}
                        </span>
                      )}
                    </div>
                  )}
                  {pace && pace.detail && (
                    <p className="text-[11px] text-muted-foreground/80 mt-1 italic">{pace.detail}</p>
                  )}
                </div>

                {/* Progress input — log increment */}
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p className="text-xs font-medium mb-2">Update Progress</p>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder={`Current ${actionGoal.unit} (now: ${currentVal})`}
                      value={progressInput}
                      onChange={e => setProgressInput(e.target.value)}
                      className="h-9 text-sm flex-1"
                      data-testid="input-goal-progress"
                    />
                    <Button
                      size="sm"
                      className="h-9 px-3"
                      disabled={!progressInput || updateMutation.isPending}
                      onClick={() => {
                        const val = Number(progressInput);
                        if (!isNaN(val)) {
                          updateMutation.mutate({ id: actionGoal.id, current: val });
                          setProgressInput("");
                          setActionGoal(null);
                        }
                      }}
                    >
                      Save
                    </Button>
                  </div>
                  {/* Quick increment buttons */}
                  <div className="flex gap-1.5 mt-2">
                    {[10, 25, 50, 100, 500, 1000].filter(n => n <= actionGoal.target).slice(0, 4).map(inc => (
                      <Button
                        key={inc}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={() => {
                          updateMutation.mutate({ id: actionGoal.id, current: Math.min(currentVal + inc, actionGoal.target) });
                          setActionGoal(null);
                        }}
                      >
                        +{inc >= 1000 ? `${inc/1000}k` : inc}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    className="h-9 text-xs gap-1.5"
                    onClick={() => { updateMutation.mutate({ id: actionGoal.id, status: "completed" }); setActionGoal(null); }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Complete
                  </Button>
                  <Button
                    variant="outline"
                    className="h-9 text-xs gap-1.5"
                    onClick={() => { setActionGoal(null); openEdit(actionGoal); }}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-9 text-xs gap-1.5"
                    disabled={deleteMutation.isPending}
                    onClick={() => { deleteMutation.mutate({ id: actionGoal.id, title: actionGoal.title }); setActionGoal(null); }}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {deleteMutation.isPending ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </div>
            );
          })()}
        </SheetContent>
      </Sheet>

      {/* Create / Edit Goal Dialog */}
      <Dialog open={creating || !!editGoal} onOpenChange={v => { if (!v) { setCreating(false); setEditGoal(null); resetForm(); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              {editGoal ? "Edit Goal" : "Create Goal"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editGoal
                ? "Update the target, deadline, or category. Progress is preserved."
                : "Set a measurable target with a unit and an optional deadline so Portol can track your pace."}
            </DialogDescription>
          </DialogHeader>
          {/* Live preview — only shows when meaningful values entered */}
          {(formTitle.trim() || formTarget) && (
            <div className="rounded-lg border bg-muted/30 p-2.5 mt-1 space-y-1">
              <p className="micro-label text-muted-foreground">Preview</p>
              <p className="text-xs font-semibold truncate">{formTitle.trim() || "Untitled goal"}</p>
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                {formTarget && Number(formTarget) > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium tabular-nums">
                    Target: {Number(formTarget).toLocaleString()} {formUnit || "units"}
                  </span>
                )}
                {formDeadline && (
                  <span className="px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">
                    Due {new Date(formDeadline).toLocaleDateString()}
                  </span>
                )}
                {formType && formType !== 'custom' && (
                  <span className="px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground capitalize">
                    {formType.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
              {formDeadline && formTarget && Number(formTarget) > 0 && (() => {
                const daysToDeadline = Math.ceil((new Date(formDeadline).getTime() - Date.now()) / 86400000);
                if (daysToDeadline <= 0) return null;
                const perDay = Number(formTarget) / daysToDeadline;
                return (
                  <p className="text-[11px] text-muted-foreground/80 italic">
                    Roughly {perDay >= 1 ? perDay.toFixed(1) : perDay.toFixed(2)} {formUnit || "units"} per day for {daysToDeadline} days
                  </p>
                );
              })()}
            </div>
          )}
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Title</Label>
              <Input value={formTitle} onChange={e => setFormTitle(e.target.value)} placeholder="e.g., Lose 10 lbs" className="h-8 text-sm" data-testid="input-goal-title" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Target</Label>
                <Input type="number" value={formTarget} onChange={e => setFormTarget(e.target.value)} placeholder="10" className="h-8 text-sm" data-testid="input-goal-target" />
              </div>
              <div>
                <Label className="text-xs">Unit</Label>
                <Input value={formUnit} onChange={e => setFormUnit(e.target.value)} placeholder="lbs, miles, $" className="h-8 text-sm" data-testid="input-goal-unit" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Type</Label>
                <Select value={formType} onValueChange={setFormType}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom">Custom</SelectItem>
                    <SelectItem value="fitness_distance">Fitness Distance</SelectItem>
                    <SelectItem value="fitness_frequency">Fitness Frequency</SelectItem>
                    <SelectItem value="habit_streak">Habit Streak</SelectItem>
                    <SelectItem value="savings">Savings</SelectItem>
                    <SelectItem value="spending_limit">Spending Limit</SelectItem>
                    <SelectItem value="tracker_target">Tracker Target</SelectItem>
                    <SelectItem value="weight_gain">Weight Gain</SelectItem>
                    <SelectItem value="weight_loss">Weight Loss</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Deadline</Label>
                <Input type="date" value={formDeadline} onChange={e => setFormDeadline(e.target.value)} className="h-8 text-xs" data-testid="input-goal-deadline" />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            {editGoal && (
              <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => deleteMutation.mutate({ id: editGoal.id, title: editGoal.title })} disabled={deleteMutation.isPending} data-testid="btn-delete-goal">
                <Trash2 className="h-3 w-3 mr-1" /> Delete
              </Button>
            )}
            {editGoal && normalizeFilter(editGoal.status) === normalizeFilter("active") && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => updateMutation.mutate({ id: editGoal.id, status: "completed" })} disabled={updateMutation.isPending} data-testid="btn-complete-goal">
                <Check className="h-3 w-3 mr-1" /> {updateMutation.isPending ? "Completing…" : "Complete"}
              </Button>
            )}
            <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={!formTitle.trim() || !formTarget || parseFloat(formTarget) <= 0 || createMutation.isPending || updateMutation.isPending} data-testid="btn-save-goal">
              {editGoal ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Budget Manager Component ────────────────────────────────────────────────

const BUDGET_CATEGORIES = [
  "education", "entertainment", "food", "general", "health", "housing",
  "insurance", "personal", "pet", "shopping", "subscription",
  "transport", "utilities", "vehicle",
];

function BudgetManager({ filterIds = [], filterMode = "everyone" }: { filterIds?: string[]; filterMode?: string }) {
  const { toast } = useToast();
  const [month, setMonth] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7));
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [newCat, setNewCat] = useState("");
  const [newAmt, setNewAmt] = useState("");
  const [newNotes, setNewNotes] = useState("");

  // Bug fix: previously /api/expenses and /api/budgets were called without
  // profileIds, so the budget popup always showed all-profile spending
  // regardless of the active profile filter. Thread the filter through both
  // query URLs so the popup's totals match the dashboard's filter selection.
  const profileQs = filterMode === "selected" && filterIds.length > 0
    ? `&profileIds=${filterIds.join(",")}`
    : "";
  const profileQsLeading = filterMode === "selected" && filterIds.length > 0
    ? `?profileIds=${filterIds.join(",")}`
    : "";

  const { data: budgetRes, refetch } = useQuery<{month: string; budgets: any[]}>({
    queryKey: ["/api/budgets", month, filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/budgets?month=${month}${profileQs}`).then(r => r.json()),
  });

  const { data: expensesData } = useQuery<any>({
    queryKey: ["/api/expenses", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/expenses${profileQsLeading}`).then(r => r.json()),
  });

  const budgets = budgetRes?.budgets || [];
  const allExpenses = useMemo(() => Array.isArray(expensesData) ? expensesData : (expensesData?.items || []), [expensesData]);
  const monthExpenses = useMemo(() => allExpenses.filter((e: any) => e.date?.startsWith(month)), [allExpenses, month]);
  const byCategory = useMemo(() => {
    const cats: Record<string, number> = {};
    monthExpenses.forEach((e: any) => { cats[e.category || "general"] = (cats[e.category || "general"] || 0) + e.amount; });
    return cats;
  }, [monthExpenses]);

  const totalBudget = useMemo(() => budgets.reduce((s: number, b: any) => s + b.amount, 0), [budgets]);
  const totalSpent = useMemo(() => monthExpenses.reduce((s: number, e: any) => s + e.amount, 0), [monthExpenses]);

  const addMutation = useMutation({
    mutationFn: (data: {category: string; amount: number; notes?: string}) =>
      apiRequest("POST", "/api/budgets", { month, ...data }).then(r => r.json()),
    // Cache bus: budgets domain (budgets + summary + enhanced) + dashboard (stats).
    onSuccess: () => { refetch(); invalidateDomains("budgets", "dashboard"); setAddOpen(false); setNewCat(""); setNewAmt(""); setNewNotes(""); toast({ title: "Budget added" }); },
    onError: () => toast({ title: "Failed to add budget", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/budgets/${id}?month=${month}`),
    onMutate: async (id) => {
      // The live key is ["/api/budgets", month, filterMode, ...filterIds]; an
      // exact-key read of ["/api/budgets", month] was an empty slot, so the
      // row never left optimistically and a failed delete had nothing to
      // restore. Prefix patch reaches every scoped variant.
      await queryClient.cancelQueries({ queryKey: ["/api/budgets", month] });
      const restore = patchQueries(["/api/budgets", month], (old: any) =>
        old?.budgets ? { ...old, budgets: old.budgets.filter((b: any) => b.id !== id) } : undefined
      );
      return { restore };
    },
    onSuccess: () => {
      refetch(); invalidateDomains("budgets", "dashboard");
      toast({ title: "Budget deleted" });
    },
    onError: (_e, _v, ctx: any) => {
      ctx?.restore?.();
      toast({ title: "Failed to delete budget", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: {id: string; amount: number}) =>
      apiRequest("PATCH", `/api/budgets/${data.id}?month=${month}`, { amount: data.amount }),
    onSuccess: () => { refetch(); invalidateDomains("budgets", "dashboard"); setEditId(null); toast({ title: "Budget updated" }); },
    onError: () => toast({ title: "Failed to update budget", variant: "destructive" }),
  });

  const copyMutation = useMutation({
    mutationFn: () => {
      const [y, m] = month.split("-").map(Number);
      const prevDate = new Date(y, m - 2, 1);
      const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
      return apiRequest("POST", "/api/budgets/copy", { fromMonth: prevMonth, toMonth: month }).then(r => r.json());
    },
    onSuccess: () => { refetch(); invalidateDomains("budgets", "dashboard"); toast({ title: "Budget copied from last month" }); },
    onError: () => toast({ title: "Failed to copy budget", variant: "destructive" }),
  });

  const prevMonth = () => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 2, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const nextMonth = () => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const monthLabel = new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const usedCategories = new Set(budgets.map((b: any) => (b.category as string).toLowerCase()));
  const availableCategories = BUDGET_CATEGORIES.filter(c => !usedCategories.has(c));

  return (
    <div className="space-y-3">
      {/* Month navigation */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={prevMonth} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm font-medium">{monthLabel}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={nextMonth} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
      </div>

      {/* Summary bar */}
      <div className="rounded-lg bg-muted/30 p-3 space-y-1.5">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Total Budget</span>
          <span className="font-medium">${totalBudget.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Total Spent</span>
          <span className="font-medium text-red-400">${totalSpent.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Remaining</span>
          <span className={`font-bold ${(totalBudget - totalSpent) >= 0 ? "text-green-500" : "text-red-500"}`}>
            ${(totalBudget - totalSpent).toLocaleString()}
          </span>
        </div>
        {totalBudget > 0 && (
          <div className="w-full bg-muted rounded-full h-2 mt-1">
            <div
              className={`h-2 rounded-full transition-all ${(totalSpent / totalBudget) > 1 ? "bg-red-500" : (totalSpent / totalBudget) > 0.8 ? "bg-amber-500" : "bg-green-500"}`}
              style={{ width: `${Math.min(100, (totalSpent / totalBudget) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {/* Category breakdown */}
      {budgets.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-3">No budgets set for this month</p>
      )}
      {budgets.length > 0 && (
        <div className="space-y-1.5">
          {budgets.slice().sort((a: any, b: any) => (a.category || '').localeCompare(b.category || '')).map((b: any) => {
            const actual = byCategory[b.category] || 0;
            const pct = b.amount > 0 ? (actual / b.amount) * 100 : 0;
            const over = actual > b.amount;
            return (
              <div key={b.id} className="rounded-lg border border-border/40 p-2 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium capitalize">{b.category}</span>
                  <div className="flex items-center gap-1">
                    {editId === b.id ? (
                      <form onSubmit={(e) => { e.preventDefault(); const val = parseFloat((e.target as any).amt.value); if (val > 0) updateMutation.mutate({ id: b.id, amount: val }); }} className="flex items-center gap-1">
                        <Input name="amt" type="number" inputMode="decimal" defaultValue={b.amount} className="h-6 w-20 text-xs" step="0.01" autoFocus />
                        <Button type="submit" variant="ghost" size="icon" className="h-8 w-8" aria-label="Save budget"><Check className="h-3 w-3" /></Button>
                      </form>
                    ) : (
                      <>
                        <span className="text-xs tabular-nums">${actual.toLocaleString()} / ${b.amount.toLocaleString()}</span>
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditId(b.id)} data-testid={`edit-budget-${b.category}`} aria-label={`Edit ${b.category} budget`}>
                          <Pencil className="h-2.5 w-2.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate(b.id)} data-testid={`delete-budget-${b.category}`} aria-label={`Delete ${b.category} budget`}>
                          <X className="h-2.5 w-2.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="w-full bg-muted rounded-full h-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${over ? "bg-red-500" : pct > 80 ? "bg-amber-500" : "bg-green-500"}`}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{Math.round(pct)}% used</span>
                  <span className={over ? "text-red-400 font-medium" : ""}>{over ? `$${(actual - b.amount).toLocaleString()} over` : `$${(b.amount - actual).toLocaleString()} left`}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Unbudgeted spending */}
      {(() => {
        const unbudgeted = Object.entries(byCategory).filter(([cat]) => !usedCategories.has(cat));
        if (unbudgeted.length === 0) return null;
        const totalUnbudgeted = unbudgeted.reduce((s, [, v]) => s + v, 0);
        return (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2 space-y-1">
            <p className="text-xs font-medium text-amber-500">Unbudgeted Spending: ${totalUnbudgeted.toLocaleString()}</p>
            {unbudgeted.slice().sort(([a], [b]) => a.localeCompare(b)).map(([cat, amt]) => (
              <div key={cat} className="flex justify-between text-xs text-muted-foreground">
                <span className="capitalize">{cat}</span>
                <span>${amt.toLocaleString()}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Add budget */}
      {addOpen ? (
        <div className="rounded-lg border border-border p-2 space-y-2">
          <select value={newCat} onChange={(e) => setNewCat(e.target.value)} className="w-full h-8 text-xs bg-background border border-border rounded px-2">
            <option value="">Select category...</option>
            {availableCategories.slice().sort((a, b) => a.localeCompare(b)).map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
          </select>
          <Input placeholder="Amount" type="number" inputMode="decimal" value={newAmt} onChange={(e) => setNewAmt(e.target.value)} className="h-8 text-xs" step="0.01" />
          <Input placeholder="Notes (optional)" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} className="h-8 text-xs" />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs flex-1" disabled={!newCat || !newAmt || parseFloat(newAmt) <= 0} onClick={() => addMutation.mutate({ category: newCat, amount: parseFloat(newAmt), notes: newNotes || undefined })}>
              <Plus className="h-3 w-3 mr-1" /> Add Budget
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAddOpen(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={() => setAddOpen(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add Category Budget
          </Button>
          {budgets.length === 0 && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => copyMutation.mutate()} disabled={copyMutation.isPending}>
              Copy Previous Month
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section: Finance Widget ─────────────────────────────────────────────────

function FinanceWidget({ data, stats, filterIds = [], filterMode = "everyone", allProfiles }: { data: any; stats: DashboardStats | undefined; filterIds?: string[]; filterMode?: string; allProfiles?: any[] }) {
  const [, navigate] = useLocation();
  const [drill, setDrill] = useState<"spending" | "income" | "cashflow" | "networth" | "budget" | null>(null);
  // In-place add from the legacy drill-downs (no longer read-only).
  const [drillQuickAdd, setDrillQuickAdd] = useState<QuickAddKind | null>(null);
  // P1 dedupe (QA scorecard): profiles come from the page-level query (this
  // component previously declared TWO copies of the same ["/api/profiles"] key).
  const fwProfiles = allProfiles ?? [];
  const fwOwnerId = useMemo(() => {
    if (filterMode === "selected" && filterIds.length === 1) return filterIds[0];
    return (fwProfiles.find((p: any) => p.type === "self")?.id) || "";
  }, [filterMode, filterIds, fwProfiles]);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const incomeUrl = filterMode === "selected" && filterIds.length > 0
    ? `/api/incomes?profileIds=${filterIds.join(",")}`
    : "/api/incomes";
  const { data: incomes } = useQuery<any[]>({
    queryKey: ["/api/incomes", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", incomeUrl).then(r => r.json()),
  });
  const { data: allObligations } = useQuery<any[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/obligations${profileParam}`)).then(r => r.json()),
  });

  const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  // Bug fix: budget summary was previously fetched without profileIds, so the
  // "Monthly Budget" card showed all-profile spending no matter which profile
  // filter the user had active. Thread the filter into both /api/budgets and
  // /api/expenses so the card respects the same filter as everything else.
  const budgetSummaryProfileLeading = filterMode === "selected" && filterIds.length > 0
    ? `?profileIds=${filterIds.join(",")}`
    : "";
  const budgetSummaryProfileTrailing = filterMode === "selected" && filterIds.length > 0
    ? `&profileIds=${filterIds.join(",")}`
    : "";
  // BUG-20260528-budget-keep-previous-leak: same fix as the hero budgetSummary
  // — the Finance Money section budget panel must not carry the previous
  // filter's $2,650 forward when swapping to a fresh profile like Lexi.
  const { data: budgetData } = useQuery<{month: string; totalBudget: number; totalSpent: number; remaining: number; categories: any[]}>({
    queryKey: ["/api/budgets/summary", currentMonth, filterMode, ...filterIds],
    queryFn: async () => {
      const [budgetRes, expensesRes] = await Promise.all([
        apiRequest("GET", `/api/budgets?month=${currentMonth}${budgetSummaryProfileTrailing}`).then(r => r.json()),
        apiRequest("GET", `/api/expenses${budgetSummaryProfileLeading}`).then(r => r.json()),
      ]);
      const budgets = budgetRes.budgets || [];
      const allExpenses = Array.isArray(expensesRes) ? expensesRes : (expensesRes.items || []);
      const monthExpenses = allExpenses.filter((e: any) => e.date?.startsWith(currentMonth));
      const byCategory: Record<string, number> = {};
      monthExpenses.forEach((e: any) => { byCategory[e.category || "general"] = (byCategory[e.category || "general"] || 0) + e.amount; });
      const totalBudget = budgets.reduce((s: number, b: any) => s + b.amount, 0);
      const totalSpent = monthExpenses.reduce((s: number, e: any) => s + e.amount, 0);
      return {
        month: currentMonth,
        totalBudget,
        totalSpent,
        remaining: totalBudget - totalSpent,
        categories: budgets.map((b: any) => ({
          ...b,
          actual: byCategory[b.category] || 0,
          remaining: b.amount - (byCategory[b.category] || 0),
          percentUsed: b.amount > 0 ? Math.round(((byCategory[b.category] || 0) / b.amount) * 100) : 0,
        })),
      };
    },
    placeholderData: undefined,
  });

  // Bug fix: prefer financeSnapshot.totalMonthlySpend (from /api/dashboard-enhanced, same
  // source the drilldown popup uses) so the card headline and the popup total always match.
  // Falls back to stats?.monthlySpend for the brief window before enhanced data arrives.
  const monthlySpend = data?.totalMonthlySpend ?? stats?.monthlySpend ?? 0;
  const monthlyIncome = useMemo(() => sumMonthlyIncomeNow(incomes || [], BROWSER_TIMEZONE), [incomes]);
  // Same definition as the hero tile + Cash Flow popup: Out includes the
  // monthlyized recurring obligations, not just logged expenses.
  const cashFlow = monthlyIncome - monthlySpend - (data?.monthlyObligationTotal ?? 0);
  // Hide synthetic test rows unless the dashboard toggle is on (point 11).
  const showTestData = useShowTestData();
  const hideTest = (e: any) => showTestData || !isTestEntity(e);
  const recentExpenses: any[] = (data?.recentExpenses || []).filter(hideTest);

  // Build drill-down data — use profile-filtered monthlyExpenseRecords from enhanced API
  const now = new Date();
  const monthExpenses: any[] = (data?.monthlyExpenseRecords || []).filter(hideTest);
  const byCategory = useMemo(() => {
    const cats: Record<string, number> = {};
    monthExpenses.forEach((e: any) => { cats[e.category || "general"] = (cats[e.category || "general"] || 0) + e.amount; });
    return cats;
  }, [monthExpenses]);
  const assetProfiles = useMemo(() => (allProfiles || []).filter((p: any) => {
    if (resolveAssetValue(p) <= 0) return false;
    // Apply the same profile filter as everything else
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const pParent = p.parentProfileId;
    if (pParent && filterIds.includes(pParent)) return true;
    // Also include the filtered profile itself (an asset can be linked directly,
    // not just as a child of a parent profile). Without this, switching to e.g. Bob
    // hides assets attached straight to Bob's profile.
    if (filterIds.includes(p.id)) return true;
    return false;
  }), [allProfiles, filterMode, filterIds]);

  // Derive Net Worth from the same resolved profiles the popup uses, so the
  // tile total and the popup total are always identical. Falls back to the
  // /api/dashboard-enhanced numbers only while profiles are still loading.
  const tileLiabilityProfiles = useMemo(() => (allProfiles || []).filter((p: any) => {
    // Exclude recurring service bills from balance-sheet debt (server-parity).
    if (!isNetWorthLiabilityProfile(p)) return false;
    if (resolveLiabilityBalance(p) <= 0) return false;
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const pParent = p.parentProfileId;
    if (pParent && filterIds.includes(pParent)) return true;
    if (filterIds.includes(p.id)) return true;
    return false;
  }), [allProfiles, filterMode, filterIds]);
  // SCOPE CONTRACT: the server's financeSnapshot (data.totalAssetValue /
  // data.totalLiabilities) is the single source of truth for roll-up numbers.
  // It is party_links + parent-residual aware; the client-side walk over
  // allProfiles is parent-only and diverges on co-ownership/wrong-link data.
  // The server owns the LEVEL — and still does below. What changed is that the
  // walk now supplies the DELTA while the server payload is being recomputed,
  // so a payment or a revaluation moves this tile on the write instead of
  // several seconds later when ~15 aggregate queries come back. At rest the
  // delta is zero and this is exactly the server's number. See
  // lib/derived-aggregates.ts.
  const derivedAssetValue = useMemo(
    () => assetProfiles.reduce((s, p) => s + resolveAssetValue(p), 0),
    [assetProfiles],
  );
  const derivedLiabilities = useMemo(
    () => tileLiabilityProfiles.reduce((s, p) => s + resolveLiabilityBalance(p), 0),
    [tileLiabilityProfiles],
  );
  const enhancedTotalsKey = useMemo(
    () => ["/api/dashboard-enhanced", filterMode, ...filterIds],
    [filterMode, filterIds],
  );
  const totalAssetValue = useLiveTotal(data?.totalAssetValue, derivedAssetValue, enhancedTotalsKey);
  const totalLiabilities = useLiveTotal(data?.totalLiabilities, derivedLiabilities, enhancedTotalsKey);
  const netWorth = totalAssetValue - totalLiabilities;

  if (!data && !stats) {
    return (
      <CollapsibleSection accent="43 85% 52%" icon={DollarSign} label="Finance" testId="section-finance">
        <div className="rounded-lg border border-dashed border-border/50 p-4 text-center">
          <p className="text-xs text-muted-foreground mb-1">No finance data yet</p>
          <p className="text-xs text-muted-foreground/70">Tell the AI: "Spent $50 on groceries" or "Set budget $500 for food"</p>
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection accent="43 85% 52%" icon={DollarSign} label="Finance" count={recentExpenses.length || undefined} testId="section-finance">
      {/* Budget breach alert banner — promoted from the previously-buried thin pink
          bar at the bottom of the right column. Renders above all Finance content
          whenever spending exceeds budget, so it can't be missed. */}
      {budgetData && budgetData.totalBudget > 0 && (() => {
        const usedPct = Math.round((budgetData.totalSpent / budgetData.totalBudget) * 100);
        if (usedPct <= 100) return null;
        const overAmt = budgetData.totalSpent - budgetData.totalBudget;
        return (
          <button
            type="button"
            onClick={() => setDrill("budget")}
            className="w-full flex items-center gap-2.5 mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-left hover:bg-red-500/15 transition-colors"
            data-testid="budget-breach-banner"
          >
            <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-red-500 leading-tight">
                Budget exceeded by ${overAmt.toLocaleString()} · <span className="tabular-nums">{usedPct}% of ${budgetData.totalBudget.toLocaleString()}</span>
              </p>
              <p className="text-[11px] text-red-500/80 leading-tight mt-0.5">Tap to review categories and adjust</p>
            </div>
            <ChevronRight className="h-4 w-4 text-red-500/70 shrink-0" />
          </button>
        );
      })()}
      {/* Two-column internal layout on desktop — no dead zones */}
      <div className="md:grid md:grid-cols-2 md:gap-4">
      {/* LEFT: KPIs + budget */}
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <button data-testid="fw-drill-spending" onClick={() => setDrill("spending")} className="bubble p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer pressable">
            <p className="text-xs text-muted-foreground">Spending</p>
            {/* Color discipline: spending = amber, never red. Red is reserved for
                overdue/breach states only. */}
            <p className="text-sm font-bold tabular-nums text-amber-500">{formatMoneyRound(monthlySpend)}</p>
            <p className="text-xs-tight text-muted-foreground">{monthExpenses.length} this month</p>
          </button>
          <button data-testid="fw-drill-income" onClick={() => setDrill("income")} className="bubble p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer pressable">
            <p className="text-xs text-muted-foreground">Income</p>
            <p className="text-sm font-bold tabular-nums text-green-500">{formatMoneyRound(monthlyIncome)}</p>
            <p className="text-xs-tight text-muted-foreground">{(incomes || []).length} sources</p>
          </button>
          <button data-testid="fw-drill-cashflow" onClick={() => setDrill("cashflow")} className="bubble p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer pressable">
            <p className="text-xs text-muted-foreground">Cash Flow</p>
            {/* Negative cash flow uses amber (warning), not red (overdue). */}
            <p className={`text-sm font-bold tabular-nums ${cashFlow >= 0 ? "text-green-500" : "text-amber-500"}`}>
              {cashFlow >= 0 ? "+" : ""}{formatMoneyRound(cashFlow)}
            </p>
            <p className="text-xs-tight text-muted-foreground">income - spending</p>
          </button>
          <button data-testid="fw-drill-networth" onClick={() => setDrill("networth")} className="bubble p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer pressable">
            <p className="text-xs text-muted-foreground">Net Worth</p>
            <p className={`text-sm font-bold tabular-nums ${netWorth >= 0 ? "text-green-500" : "text-red-500"}`}>${netWorth.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">assets - liabilities</p>
            {/* 6-Month Trend sparkline removed 2026-05-28 — it was synthesizing
                historical net worth from `current NW - mSpend * monthsAgo * 0.8`,
                which always trended upward regardless of reality. We have no
                stored historical snapshots yet, so showing nothing is correct.
                See audit finding 7.7 and BUG-20260528-fabricated-sparkline. */}
          </button>
          <button onClick={() => setDrill("budget")} className="bubble col-span-2 p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer pressable">
            <div className="flex items-center justify-center gap-2">
              <Target className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Monthly Budget</p>
            </div>
            <p className={`text-sm font-bold tabular-nums ${budgetData && budgetData.remaining >= 0 ? "text-green-500" : budgetData ? "text-red-500" : ""}`}>
              {budgetData && budgetData.totalBudget > 0 ? `$${budgetData.totalBudget.toLocaleString()} budgeted` : "Not set"}
            </p>
            <p className="text-xs-tight text-muted-foreground">
              {budgetData && budgetData.totalBudget > 0
                ? `$${budgetData.totalSpent.toLocaleString()} spent \u00B7 ${Math.round((budgetData.totalSpent / budgetData.totalBudget) * 100)}% used`
                : "Tap to set up budget"}
            </p>
          </button>
        </div>
      </div>{/* end LEFT */}
      {/* RIGHT: Pie chart + recent expenses */}
      <div className="space-y-2 mt-2 md:mt-0">
        {/* Spending donut chart */}
        {Object.keys(byCategory).length > 0 && (() => {
          const catData = Object.entries(byCategory)
            .sort(([,a],[,b]) => b-a).slice(0,8)
            .map(([name,value]) => ({name, value}));
          // Color discipline: amber occupies the primary spending slot (since
          // spending = amber). Red is intentionally omitted from the palette so
          // the chart never accidentally signals "overdue".
          const COLORS = ["#f59e0b","#06b6d4","#8b5cf6","#10b981","#3b82f6","#f97316","#ec4899","#84cc16"];
          const total = catData.reduce((s, c) => s + c.value, 0);
          return (
            <div className="mb-3">
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} paddingAngle={2}>
                    {catData.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{background:'hsl(var(--card))',border:'1px solid hsl(var(--border))',borderRadius:'8px',fontSize:'11px'}}
                    formatter={(v:any, name:any) => [`$${Number(v).toFixed(2)}`, name]}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* Custom legend with color swatches + tabular numerals so amounts align */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1 px-1">
                {catData.map((c, i) => {
                  const pct = total > 0 ? Math.round((c.value / total) * 100) : 0;
                  return (
                    <div key={c.name} className="flex items-center gap-1.5 min-w-0">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="text-[11px] capitalize truncate flex-1">{c.name}</span>
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {recentExpenses.length > 0 && (
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-muted-foreground uppercase">Recent Expenses</p>
            {recentExpenses.slice().sort((a: any, b: any) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime() || (b.description || '').localeCompare(a.description || '')).slice(0, 5).map((exp: any) => (
              <div key={exp.id} className="flex items-center justify-between py-1 text-xs">
                <span className="truncate flex-1">{exp.description || "Expense"}</span>
                <span className="text-muted-foreground tabular-nums ml-2 shrink-0">{formatListDate(exp.date)}</span>
                <span className="font-medium tabular-nums ml-2 shrink-0">{formatMoney(exp.amount)}</span>
              </div>
            ))}
          </div>
        )}
        <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 w-full" onClick={() => navigate("/dashboard/finance")}>
          View All Finance →
        </Button>
      </div>{/* end RIGHT */}
      </div>{/* end two-col grid */}

      {/* Spending Drill-Down */}
      {/* Total is computed from the rendered records so the headline always
          equals the sum of the rows shown under any profile filter. */}
      <DrillDownDialog
        open={drill === "spending"}
        onClose={() => setDrill(null)}
        title="Monthly Spending"
        subtitle={`${now.toLocaleDateString("en-US", { month: "long", year: "numeric" })} • ${monthExpenses.length} expenses`}
        total={`$${monthExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0).toLocaleString()}`}
        items={[
          ...Object.entries(byCategory).sort(([,a],[,b]) => b - a).map(([cat, amt]) => ({
            label: cat.charAt(0).toUpperCase() + cat.slice(1),
            value: `$${amt.toLocaleString()}`,
            sub: `${monthExpenses.filter(e => normalizeFilter(e.category || "general") === normalizeFilter(cat)).length} expenses`,
            category: cat,
          })),
        ]}
        expenses={monthExpenses.map((e: any) => ({
          id: e.id,
          description: e.description || "Expense",
          amount: e.amount,
          date: e.date,
          category: e.category,
          vendor: e.vendor,
        }))}
        onAdd={() => setDrillQuickAdd("expense")}
        addLabel="Add expense"
      />

      {/* Income Drill-Down */}
      <DrillDownDialog
        open={drill === "income"}
        onClose={() => setDrill(null)}
        title="Income Sources"
        total={`${formatMoneyRound(monthlyIncome)}/mo`}
        items={(incomes || []).slice().sort((a: any, b: any) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime() || (b.description || '').localeCompare(a.description || '')).map((i: any) => ({
          label: i.description,
          value: `$${i.amount.toLocaleString()}`,
          sub: i.frequency,
          category: i.category,
        }))}
        emptyMessage="No income sources yet."
        onAdd={() => setDrillQuickAdd("income")}
        addLabel="Add income"
      />

      {/* Cash Flow Drill-Down */}
      {(() => {
        // Recompute totals from the same data shown below so the headline
        // always reconciles with the breakdown rows under any filter.
        const filteredSpend = monthExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
        const filteredCashFlow = monthlyIncome - filteredSpend;
        return (
      <DrillDownDialog
        open={drill === "cashflow"}
        onClose={() => setDrill(null)}
        title="Cash Flow Breakdown"
        total={`${filteredCashFlow >= 0 ? "+" : "-"}$${Math.abs(filteredCashFlow).toLocaleString()}`}
        items={[
          { label: "Total Income", value: `+${formatMoneyRound(monthlyIncome)}`, sub: `${(incomes || []).length} sources`, category: "income" },
          { label: "Total Spending", value: `-$${filteredSpend.toLocaleString()}`, sub: `${monthExpenses.length} expenses`, category: "expense" },
          // Round-6 fix (BUG-019): previously summed raw o.amount, but obligations have
          // varying frequencies (weekly, biweekly, quarterly, yearly). A weekly $50 obligation
          // is ~$216/mo, not $50. Summing raw amounts produced the $2,406 → $7,406 → $7,422
          // fluctuation the user reported because cache invalidations occasionally added or
          // removed materialized rows of the same recurring series. Match the same
          // frequency-conversion used by the Finance page (finance.tsx:637-647) so the two
          // surfaces agree.
          { label: "Monthly Bills", value: `-$${Math.round((allObligations || []).reduce((s: number, o: any) => {
            const amt = Number(o.amount) || 0;
            switch (o.frequency) {
              case "weekly": return s + (amt * 52) / 12;
              case "biweekly": return s + (amt * 26) / 12;
              case "monthly": return s + amt;
              case "quarterly": return s + (amt * 4) / 12;
              case "yearly": return s + amt / 12;
              default: return s + amt;
            }
          }, 0)).toLocaleString()}`, sub: `${(allObligations || []).length} obligations`, category: "obligation" },
          ...Object.entries(byCategory).sort(([,a],[,b]) => b - a).slice(0, 5).map(([cat, amt]) => ({
            label: `Spending: ${cat}`, value: `-$${amt.toLocaleString()}`, category: cat,
          })),
        ]}
        obligations={(allObligations || []).map((o: any) => ({
          id: o.id, name: o.name, amount: o.amount, frequency: o.frequency, nextDueDate: o.nextDueDate || o.dueDate,
        }))}
        onAdd={() => setDrillQuickAdd("bill")}
        addLabel="Add bill"
      />
        );
      })()}

      {/* Net Worth Drill-Down */}
      {/* Liabilities are profiles carrying a loan/remaining balance (financed cars, mortgages,
          explicit loans). Obligations (recurring bills like utilities) are excluded — they are
          cash-flow, not balance-sheet liabilities. */}
      {(() => {
        const liabilityProfiles = (allProfiles || []).filter((p: any) => {
          // Recurring service bills are excluded from balance-sheet debt.
          if (!isNetWorthLiabilityProfile(p)) return false;
          const bal = resolveLiabilityBalance(p);
          if (bal <= 0) return false;
          if (filterMode === "everyone" || filterIds.length === 0) return true;
          const pParent = p.parentProfileId;
          if (pParent && filterIds.includes(pParent)) return true;
          if (filterIds.includes(p.id)) return true;
          return false;
        });
        // Compute the popup total from the SAME items rendered below — guarantees
        // the headline figure always matches the sum of the breakdown rows under
        // every filter (Everyone, single profile, multi-select).
        // SCOPE CONTRACT: headline total comes from the server financeSnapshot
        // (party_links + parent-residual aware), matching the Hero KPI and the
        // Finance card. The per-line breakdown rows below still come from the
        // client profile walk for display; the headline does not sum them.
        const filteredAssetTotal = assetProfiles.reduce(
          (s: number, p: any) => s + resolveAssetValue(p),
          0
        );
        const filteredLiabilityTotal = liabilityProfiles.reduce(
          (s: number, p: any) => s + resolveLiabilityBalance(p),
          0
        );
        const netAssetTotal = data?.totalAssetValue ?? filteredAssetTotal;
        const netLiabilityTotal = data?.totalLiabilities ?? filteredLiabilityTotal;
        const filteredNetWorth = netAssetTotal - netLiabilityTotal;
        return (
          <DrillDownDialog
            open={drill === "networth"}
            onClose={() => setDrill(null)}
            title="Net Worth Breakdown"
            subtitle="Assets minus liabilities"
            total={`${filteredNetWorth < 0 ? "-" : ""}$${Math.abs(filteredNetWorth).toLocaleString()}`}
            items={[
              ...assetProfiles.map((p: any) => {
                const val = resolveAssetValue(p);
                return { label: p.name, value: `$${val.toLocaleString()}`, sub: p.type, category: "asset" };
              }),
              ...liabilityProfiles.map((p: any) => {
                const val = resolveLiabilityBalance(p);
                return { label: p.name, value: `-$${val.toLocaleString()}`, sub: `${p.type} loan`, category: "liability" };
              }),
            ]}
            emptyMessage="No assets or liabilities tracked yet. Add a value or loan balance to a profile to see it here."
          />
        );
      })()}

      {/* Budget Dialog */}
      <Dialog open={drill === "budget"} onOpenChange={(open) => { if (!open) setDrill(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="h-4 w-4" />
              Monthly Budget
            </DialogTitle>
          </DialogHeader>
          <BudgetManager filterIds={filterIds} filterMode={filterMode} />
        </DialogContent>
      </Dialog>

      {drillQuickAdd && (
        <QuickAddDialog open kind={drillQuickAdd} ownerProfileId={fwOwnerId} onClose={() => setDrillQuickAdd(null)} />
      )}
    </CollapsibleSection>
  );
}

// ─── Expiring Warranties Card ───────────────────────────────────────────────

const ASSET_TYPES_WITH_WARRANTY = new Set(["asset", "vehicle", "property", "investment", "account"]);

function ExpiringWarrantiesCard({
  allProfiles,
  filterIds = [],
  filterMode = "everyone",
}: {
  allProfiles: any[];
  filterIds?: string[];
  filterMode?: string;
}) {
  const [, navigate] = useLocation();

  const items = useMemo(() => {
    const now = new Date();
    const nowMs = now.getTime();
    const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const filtered = (allProfiles || []).filter((p: any) => {
      // Only asset-type profiles
      if (!ASSET_TYPES_WITH_WARRANTY.has(p.type)) return false;
      // Apply profile filter — mirrors assetProfiles pattern from FinanceWidget
      if (filterMode !== "everyone" && filterIds.length > 0) {
        const pParent = p.parentProfileId;
        if (!filterIds.includes(p.id) && !(pParent && filterIds.includes(pParent))) return false;
      }
      // Check warranty field variants
      const raw = p.fields?.warrantyExpiry || p.fields?.warrantyEndDate || p.fields?.warranty;
      if (!raw) return false;
      const expiry = new Date(raw);
      if (isNaN(expiry.getTime())) return false;
      const diffMs = expiry.getTime() - nowMs;
      // In next 60 days (future) OR expired in last 30 days (past)
      return diffMs <= SIXTY_DAYS_MS && diffMs >= -THIRTY_DAYS_MS;
    });

    return filtered
      .map((p: any) => {
        const raw = p.fields?.warrantyExpiry || p.fields?.warrantyEndDate || p.fields?.warranty;
        const expiry = new Date(raw);
        const diffDays = Math.round((expiry.getTime() - nowMs) / (24 * 60 * 60 * 1000));
        return { id: p.id, name: p.name, type: p.type as string, diffDays, expiry };
      })
      .sort((a, b) => a.diffDays - b.diffDays)
      .slice(0, 5);
  }, [allProfiles, filterIds, filterMode]);

  if (items.length === 0) return null;

  const TYPE_COLORS: Record<string, string> = {
    vehicle: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    property: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    asset: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
    investment: "bg-green-500/15 text-green-700 dark:text-green-400",
    account: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
  };

  return (
    <div
      data-testid="expiring-warranties-card"
      className="bubble relative overflow-hidden transition-shadow hover:"
    >
      {/* Header accent strip */}
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: "linear-gradient(90deg, hsl(25 90% 55%), transparent)" }} />
      <div
        className="flex items-center gap-2.5 px-3 py-3"
        style={{ background: "linear-gradient(135deg, hsl(25 90% 55% / 0.06) 0%, transparent 50%)" }}
      >
        <div className="icon-badge" style={{ background: "hsl(25 90% 55% / 0.15)" }}>
          <ShieldCheck className="h-3.5 w-3.5" style={{ color: "hsl(25 90% 55%)" }} />
        </div>
        <h2 className="micro-label" style={{ color: "hsl(25 90% 55%)" }}>
          🛡️ Expiring Warranties
        </h2>
        <span className="text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 tabular-nums ml-1">
          {items.length}
        </span>
      </div>
      <div className="px-2.5 pb-2.5 space-y-1">
        {items.map((item) => {
          const isExpired = item.diffDays < 0;
          const isUrgent = !isExpired && item.diffDays <= 14;
          const label = isExpired
            ? `Expired ${Math.abs(item.diffDays)}d ago`
            : item.diffDays === 0
            ? "Expires today"
            : item.diffDays === 1
            ? "Expires tomorrow"
            : `Expires in ${item.diffDays}d`;
          const pillClass = TYPE_COLORS[item.type] || "bg-muted text-muted-foreground";
          return (
            <button
              key={item.id}
              onClick={() => navigate(`/profiles/${item.id}`)}
              className="w-full flex items-center gap-2 rounded-lg px-2 hover:bg-muted/50 active:scale-[0.98] transition-all text-left"
              style={{ minHeight: "44px" }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate leading-tight">{item.name}</p>
              </div>
              <span className={`shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${pillClass}`}>
                {item.type}
              </span>
              <span
                className={`shrink-0 text-[11px] font-semibold tabular-nums ${
                  isExpired ? "text-red-500" : isUrgent ? "text-amber-600" : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Section: AI Summary ─────────────────────────────────────────────────────

// ─ Simple inline markdown renderer: **bold**, *italic*, \n→<br> ───────────────────────────
function RenderMarkdown({ text }: { text: string }) {
  const lines = text.split(/\n+/);
  return (
    <div className="text-xs leading-relaxed space-y-1">
      {lines.map((line, li) => {
        // Remove leading ## headings, render as bold
        const stripped = line.replace(/^#{1,3}\s+/, '');
        const parts: React.ReactNode[] = [];
        let remaining = stripped;
        let key = 0;
        // Bold **text**
        while (remaining.length > 0) {
          const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
          const italicMatch = remaining.match(/\*(.+?)\*/);
          const firstBold = boldMatch ? remaining.indexOf(boldMatch[0]) : Infinity;
          const firstItalic = italicMatch ? remaining.indexOf(italicMatch[0]) : Infinity;
          if (boldMatch && firstBold <= firstItalic) {
            if (firstBold > 0) parts.push(<span key={key++}>{remaining.slice(0, firstBold)}</span>);
            parts.push(<strong key={key++} className="font-semibold text-foreground">{boldMatch[1]}</strong>);
            remaining = remaining.slice(firstBold + boldMatch[0].length);
          } else if (italicMatch && firstItalic < Infinity) {
            if (firstItalic > 0) parts.push(<span key={key++}>{remaining.slice(0, firstItalic)}</span>);
            parts.push(<em key={key++}>{italicMatch[1]}</em>);
            remaining = remaining.slice(firstItalic + italicMatch[0].length);
          } else {
            parts.push(<span key={key++}>{remaining}</span>);
            break;
          }
        }
        if (!stripped.trim()) return null;
        return <p key={li}>{parts}</p>;
      })}
    </div>
  );
}

function AISummaryWidget({
  stats, enhanced, filterMode = "everyone", filterIds = [], scopeLabel,
}: {
  stats: DashboardStats | undefined;
  enhanced: any;
  filterMode?: string;
  filterIds?: string[];
  scopeLabel?: string;
}) {
  const [summary, setSummary] = useState<string | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<string | null>(null);
  // Guard so we don't kick off the same fetch twice (StrictMode double-mount
  // in dev, or the component re-mounting from layout changes). Re-key on filter
  // change so swapping filter regenerates the briefing.
  const lastKey = useRef<string>("");
  const filterKey = `${filterMode}:${filterIds.join(",")}`;

  // force=true (the Refresh button) bypasses the server's per-scope daily
  // briefing cache; scope-change regenerations hit the cache and render
  // instantly when this scope was already briefed today (2026-07-17 perf).
  const generateSummary = async (force?: boolean) => {
    setLoading(true);
    try {
      const resp = await apiRequest("POST", "/api/ai/summary", {
        filterMode,
        filterIds,
        scopeLabel,
        force: force === true,
      });
      const data = await resp.json().catch(() => ({} as any));
      const text = (data?.summary || "").toString().trim();
      setSummary(text || "I couldn't generate a summary right now — try again in a moment.");
      setScope(data?.scope || null);
      setLastGenerated(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    } catch (err: any) {
      const msg = (err?.message || "").toString();
      if (msg.toLowerCase().includes("timed out")) {
        setSummary("Summary request timed out. The AI may be busy — please try again.");
      } else {
        setSummary("Unable to generate summary right now.");
      }
    } finally {
      setLoading(false);
    }
  };

  // Auto-regenerate when filter changes (or on first mount once stats arrive).
  // PERF (2026-05-24): defer to idle / 1.5s after first paint so the AI
  // summary fetch (which can take 5–6s) doesn't block the dashboard
  // network-idle and doesn't show "app is still loading" to the user.
  useEffect(() => {
    if (!stats) return;
    if (lastKey.current === filterKey) return;
    lastKey.current = filterKey;
    // BUG-20260530-filter-stale-stats-leak: clear the stale summary + scope
    // immediately on filter change so the user never sees "SCOPE: TEST" while
    // looking at Craig. The skeleton will replace it until the new fetch lands.
    setSummary(null);
    setScope(null);
    setLastGenerated(null);
    setLoading(true);
    const schedule: (cb: () => void) => number = (cb) => {
      const w = window as any;
      if (typeof w.requestIdleCallback === "function") {
        return w.requestIdleCallback(cb, { timeout: 2500 });
      }
      return window.setTimeout(cb, 1500);
    };
    const cancel: (id: number) => void = (id) => {
      const w = window as any;
      if (typeof w.cancelIdleCallback === "function") return w.cancelIdleCallback(id);
      return clearTimeout(id);
    };
    const handle = schedule(() => { generateSummary(); });
    return () => cancel(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, filterKey]);

  return (
    <CollapsibleSection accent="262 65% 62%" icon={Sparkles} label="AI Summary" testId="section-ai-summary">
      <div className="space-y-2">
        {scope && (
          <div className="micro-label flex items-center gap-1.5 text-muted-foreground/80" data-testid="ai-summary-scope">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary/70" />
            Scope: {scope}
          </div>
        )}
        {summary ? (
          <RenderMarkdown text={summary} />
        ) : loading ? (
          // Skeleton lines while the briefing is being written so the
          // bottom of the dashboard doesn't snap-jump when content lands.
          <div className="space-y-1.5 py-1" data-testid="ai-summary-skeleton">
            <div className="h-3 rounded bg-muted/40 animate-pulse w-[92%]" />
            <div className="h-3 rounded bg-muted/40 animate-pulse w-[78%]" />
            <div className="h-3 rounded bg-muted/40 animate-pulse w-[85%]" />
            <div className="h-3 rounded bg-muted/40 animate-pulse w-[60%]" />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground py-1">Preparing your daily briefing…</p>
        )}
        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted-foreground">
            {loading ? "Generating…" : lastGenerated ? `Generated at ${lastGenerated}` : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs gap-1"
            onClick={() => generateSummary(true)}
            disabled={loading}
            data-testid="button-refresh-ai-summary"
          >
            <RotateCcw className={`h-2.5 w-2.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: Recent Activity ────────────────────────────────────────────────

function ActivitySection({ activities }: { activities: DashboardStats["recentActivity"] }) {
  const [, navigate] = useLocation();
  const ACTIVITY_ROUTES: Record<string, string> = {
    tracker_entry: "/trackers",
    task_completed: "/dashboard/tasks",
    expense: "/dashboard/finance",
  };

  const validActivities = useMemo(() => (activities || []).filter(item => {
    const desc = item.description?.trim();
    return desc && desc.length > 0;
  }).slice(0, 8), [activities]);

  if (validActivities.length === 0) return (
    <CollapsibleSection icon={Activity} label="Recent Activity" testId="section-activity">
      <div className="text-center py-6">
        <Activity className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No recent activity yet</p>
        <p className="text-[11px] text-muted-foreground/60 mt-0.5">Log a tracker, complete a task, or add an expense</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <CollapsibleSection icon={Activity} label="Recent Activity" count={validActivities.length} defaultOpen={false} testId="section-activity">
      <div className="space-y-0.5">
        {validActivities.map((item, i) => {
          const Icon = ACTIVITY_ICONS[item.type] || Activity;
          const route = ACTIVITY_ROUTES[item.type];
          const hsl = ACTIVITY_COLORS[item.type] || "215 16% 47%";
          return (
            <div key={i}
              onClick={() => route && navigate(route)}
              role={route ? "button" : undefined}
              tabIndex={route ? 0 : undefined}
              onKeyDown={route ? onEnterOrSpace(() => navigate(route)) : undefined}
              className={`flex items-center gap-2.5 py-1.5 ${route ? "cursor-pointer hover:bg-muted/40 rounded-lg px-1.5 -mx-1.5 transition-colors" : ""}`}
              data-testid={`activity-item-${i}`}>
              <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `hsl(${hsl} / 0.15)`, color: `hsl(${hsl})` }}>
                <Icon className="h-3.5 w-3.5" />
              </div>
              <span className="text-xs truncate flex-1 text-foreground/90">{item.description}</span>
              <span className="text-[11px] text-muted-foreground/70 shrink-0 tabular-nums">{timeAgo(item.timestamp)}</span>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: Upcoming Dates (cross-app reminder center) ─────────────────────
// PR I — Aggregates every time-sensitive date in the app (birthdays, anniversaries,
// holidays, appointments, bills, renewals, expirations, travel, goals, etc.)
// into one filterable, pinnable, color-coded "what's next" view.

const UPCOMING_PINS_KEY = "portol.upcoming.pins.v1";

function loadUpcomingPins(): Set<string> {
  try {
    const raw = localStorage.getItem(UPCOMING_PINS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveUpcomingPins(pins: Set<string>) {
  try { localStorage.setItem(UPCOMING_PINS_KEY, JSON.stringify([...pins])); } catch {}
}

const ENTITY_FILTERS: Array<{ key: "all" | UpcomingEntityKind; label: string }> = [
  { key: "all",      label: "All" },
  { key: "person",   label: "Person" },
  { key: "self",     label: "Self" },
  { key: "asset",    label: "Asset" },
  { key: "property", label: "Property" },
  { key: "vehicle",  label: "Vehicle" },
  { key: "pet",      label: "Pet" },
  { key: "business", label: "Business" },
];

function UpcomingDateRow({
  item, pinned, onTogglePin,
}: {
  item: UpcomingDate;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) {
  const [, navigate] = useLocation();
  const urgency = UPCOMING_URGENCY_COLORS[item.urgency];
  const onOpen = () => {
    // The href is hash-routed (e.g. #/profiles/<id>). Strip the leading '#'
    // and feed into wouter.navigate so wouter's hash strategy resolves it.
    const target = item.href.startsWith("#") ? item.href.slice(1) : item.href;
    navigate(target);
  };
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={onEnterOrSpace(onOpen)}
      data-testid={`upcoming-item-${item.id}`}
      className="group flex items-center gap-2.5 py-1.5 px-1.5 -mx-1.5 rounded-lg cursor-pointer hover:bg-muted/40 transition-colors pressable"
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-base"
        style={{ background: `hsl(${urgency.bg})`, color: `hsl(${urgency.fg})` }}
        aria-hidden
      >
        <span>{item.icon || "📌"}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-medium truncate text-foreground/90">{item.title}</span>
          {pinned && <Pin className="h-3 w-3 shrink-0" style={{ color: "hsl(38 92% 50%)" }} aria-label="Pinned" />}
          {item.recurring && (
            <span className="micro-label text-muted-foreground/70 shrink-0">recurs</span>
          )}
          {item.needsActionSoon && (
            <span
              className="micro-label shrink-0 px-1 py-px rounded"
              style={{ background: `hsl(25 92% 55% / 0.15)`, color: `hsl(25 92% 38%)` }}
              title="AI: this item may need action soon"
            >
              <Sparkle className="inline h-2.5 w-2.5 mr-0.5" />ACT SOON
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 mt-0.5">
          <span className="truncate">{UPCOMING_CATEGORY_LABELS[item.category]}</span>
          {item.subtitle && (<><span className="opacity-50">·</span><span className="truncate">{item.subtitle}</span></>)}
        </div>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        <span
          className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded"
          style={{ background: `hsl(${urgency.bg})`, color: `hsl(${urgency.fg})`, border: `1px solid hsl(${urgency.border} / 0.4)` }}
        >
          {daysUntilLabel(item.daysUntil)}
        </span>
        <span className="text-[11px] text-muted-foreground/60 tabular-nums">{item.nextDate}</span>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); onTogglePin(item.id); }}
        className="opacity-60 sm:opacity-0 sm:group-hover:opacity-100 shrink-0 p-1 rounded hover:bg-muted/60 transition-opacity"
        aria-label={pinned ? "Unpin" : "Pin"}
        data-testid={`upcoming-pin-${item.id}`}
      >
        {pinned
          ? <PinOff className="h-3 w-3 text-muted-foreground" />
          : <Pin className="h-3 w-3 text-muted-foreground" />}
      </button>
    </div>
  );
}

function UpcomingSection({ filterIds = [], filterMode = "everyone", ready = true, allProfiles = [], events = [], goals = [] }: { filterIds?: string[]; filterMode?: string; ready?: boolean; allProfiles?: any[]; events?: any[]; goals?: any[] }) {
  // PR M — Scope upcoming dates to the selected profile(s). When filterMode is
  // "selected" we pass ?profileIds=... to every list endpoint and split the
  // react-query cache by filterMode + filterIds so switching profiles doesn't
  // show another profile's reminders.
  const scoped = filterMode === "selected" && filterIds.length > 0;
  const profileParam = scoped ? `?profileIds=${filterIds.join(",")}` : "";
  // P1 dedupe (QA scorecard): profiles / events / goals are fetched ONCE by the
  // page component (same query keys) and passed down as props.
  const profiles = allProfiles;
  const { data: documents = [] } = useQuery<any[]>({
    queryKey: ["/api/documents", filterMode, ...filterIds],
    enabled: ready,
    queryFn: () => apiRequest("GET", `/api/documents${profileParam}`).then(r => r.json()),
  });
  const { data: tasks = [] } = useQuery<any[]>({
    queryKey: ["/api/tasks", filterMode, ...filterIds],
    enabled: ready,
    queryFn: () => apiRequest("GET", withFullLimit(`/api/tasks${profileParam}`)).then(r => r.json()),
  });
  const { data: obligations = [] } = useQuery<any[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    enabled: ready,
    queryFn: () => apiRequest("GET", withFullLimit(`/api/obligations${profileParam}`)).then(r => r.json()),
  });
  // (Removed 2026-08-09: a /api/reminders query feeding this list. "Remind me
  // to take evening medication" is a TASK with a due time now, and `tasks`
  // above already carries it — a second source would list it twice.)

  const [entityFilter, setEntityFilter] = useState<"all" | UpcomingEntityKind>("all");
  const [pins, setPins] = useState<Set<string>>(() => loadUpcomingPins());

  const togglePin = (id: string) => {
    setPins(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      saveUpcomingPins(next);
      return next;
    });
  };

  const all = useMemo(() => aggregateUpcomingDates({
    profiles, documents, tasks, events, obligations, goals,
  }), [profiles, documents, tasks, events, obligations, goals]);

  const filtered = useMemo(() => {
    let items = all;
    // PR M — Safety net: if the user has selected specific profiles, drop any
    // upcoming-date whose relatedProfileId isn't in scope. The server query
    // param already does this for the originating module, but cross-cutting
    // entries (e.g. a holiday with no profile owner) should still be excluded.
    if (scoped) {
      const allow = new Set(filterIds);
      items = items.filter(u => u.relatedProfileId && allow.has(u.relatedProfileId));
    }
    if (entityFilter !== "all") {
      items = items.filter(u => {
        if (u.entityKind === entityFilter) return true;
        // Allow filtering by linked profile kind too — e.g. a document tied to a pet
        // should surface under the Pet filter.
        if (u.relatedProfileId) {
          const p = profiles.find((pp: any) => pp.id === u.relatedProfileId);
          if (p) {
            const t = String(p.type || "").toLowerCase();
            if (t === entityFilter) return true;
            if (entityFilter === "asset" && (t === "asset" || t === "vehicle" || t === "property")) return true;
          }
        }
        return false;
      });
    }
    // Pinned items float to the top within their bucket.
    return items
      .map(u => ({ ...u, _pinned: pins.has(u.id) }))
      .sort((a, b) => {
        if (a._pinned !== b._pinned) return a._pinned ? -1 : 1;
        return a.daysUntil - b.daysUntil || a.title.localeCompare(b.title);
      });
  }, [all, entityFilter, pins, profiles, scoped, filterIds]);

  const grouped = useMemo(() => groupByTimeframe(filtered), [filtered]);
  const actionSoonCount = useMemo(() => filtered.filter(u => u.needsActionSoon).length, [filtered]);

  const headerRight = (
    <div className="flex items-center gap-1.5">
      {actionSoonCount > 0 && (
        <span
          className="micro-label px-1.5 py-0.5 rounded"
          style={{ background: "hsl(25 92% 55% / 0.15)", color: "hsl(25 92% 38%)" }}
          title="Items the AI flagged as needing action soon"
        >
          <Sparkle className="inline h-2.5 w-2.5 mr-0.5" />{actionSoonCount} ACT SOON
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <button
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded border border-border/40"
            data-testid="upcoming-filter-trigger"
            aria-label="Filter by entity"
          >
            <FilterIcon className="h-3 w-3" />
            <span>{ENTITY_FILTERS.find(f => f.key === entityFilter)?.label || "All"}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[140px]">
          {ENTITY_FILTERS.map(f => (
            <DropdownMenuItem key={f.key} onClick={() => setEntityFilter(f.key)} data-testid={`upcoming-filter-${f.key}`}>
              {f.key === entityFilter && <Check className="h-3 w-3 mr-1.5" />}
              {f.key !== entityFilter && <span className="w-3 mr-1.5" />}
              {f.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  if (filtered.length === 0) {
    return (
      <CollapsibleSection
        accent="280 75% 60%"
        icon={CalendarDays}
        label="Upcoming"
        testId="section-upcoming-dates"
        headerRight={headerRight}
      >
        <div className="text-center py-6">
          <CalendarDays className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">No upcoming dates</p>
          <p className="text-[11px] text-muted-foreground/60 mt-0.5">
            Birthdays, renewals, appointments, and deadlines surface here automatically
          </p>
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      accent="280 75% 60%"
      icon={CalendarDays}
      label="Upcoming"
      count={filtered.length}
      testId="section-upcoming-dates"
      headerRight={headerRight}
    >
      <div className="space-y-3">
        {grouped.map(group => (
          <div key={group.timeframe}>
            <div className="flex items-center gap-1.5 mb-1 px-1.5">
              <span className="micro-label text-muted-foreground/70">
                {UPCOMING_TIMEFRAME_LABELS[group.timeframe]}
              </span>
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">{group.items.length}</span>
              <div className="flex-1 h-px bg-border/40" />
            </div>
            <div className="space-y-0.5">
              {group.items.map(it => (
                <UpcomingDateRow
                  key={it.id}
                  item={it}
                  pinned={pins.has(it.id)}
                  onTogglePin={togglePin}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// ─── Customize Dialog ────────────────────────────────────────────────────────

interface DashboardSection {
  id: string;
  label: string;
  icon: any;
  visible: boolean;
  column: "left" | "right" | "full";
}

// Dashboard v2 — Executive layout. Three layers: NOW (what needs attention) →
// TRAJECTORY (am I improving) → EXPLORE (where do I go next). Each section
// appears once; the legacy duplicates are kept in code but hidden by default
// (still toggleable via Customize and reachable on their own pages).
// ── Executive command-center sections (2026-07) ──────────────────────────────

// One-tap create row. Wraps the existing QuickAddDialog so a new record lands
// on the active profile (kpiOwnerId-style resolution via the scope).
export function QuickActionsSection({ filterMode, filterIds, allProfiles = [] }: { filterMode: string; filterIds: string[]; allProfiles?: any[] }) {
  const [kind, setKind] = useState<QuickAddKind | null>(null);
  // P1 dedupe (QA scorecard): profiles come from the page-level query.
  const profiles = allProfiles;
  const ownerId = useMemo(() => {
    if (filterMode === "selected" && filterIds.length === 1) return filterIds[0];
    return (profiles.find((p: any) => p.type === "self")?.id) || "";
  }, [filterMode, filterIds, profiles]);
  const actions: Array<{ k: QuickAddKind; label: string; icon: any }> = [
    { k: "expense", label: "Expense", icon: Receipt },
    { k: "income", label: "Income", icon: ArrowDownToLine },
    { k: "bill", label: "Bill", icon: CreditCard },
    { k: "note", label: "Note", icon: StickyNote },
    { k: "task", label: "Task", icon: Bell },
  ];
  return (
    <div className="flex flex-wrap gap-2" data-testid="section-quick-actions">
      {actions.map(a => (
        <Button key={a.k} variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setKind(a.k)} data-testid={`quick-action-${a.k}`}>
          <a.icon className="h-3.5 w-3.5" /> {a.label}
        </Button>
      ))}
      {kind && <QuickAddDialog open kind={kind} ownerProfileId={ownerId} onClose={() => setKind(null)} />}
    </div>
  );
}

// Recent notifications feed (expiring docs, overdue/ due tasks, bills, streaks).
// Reuses the /api/notifications endpoint the bell already consumes.
export function NotificationsSection({ filterMode, filterIds }: { filterMode: string; filterIds: string[] }) {
  const [, navigate] = useLocation();
  const param = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: notifications = [] } = useQuery<any[]>({
    queryKey: ["/api/notifications", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/notifications${param}`).then(r => r.json()).catch(() => []),
    staleTime: 60_000,
  });
  const items = (Array.isArray(notifications) ? notifications : []).filter((n: any) => !n.dismissed).slice(0, 6);
  if (items.length === 0) return null;
  const dot = (sev: string) => sev === "critical" ? "bg-red-500" : sev === "warning" ? "bg-amber-500" : "bg-sky-500";
  return (
    <CollapsibleSection label="Notifications" icon={Bell} testId="section-notifications">
      <div className="space-y-1.5">
        {items.map((n: any) => (
          <button
            key={n.id}
            onClick={() => { if (n.entityType === "document") navigate(`/documents/${n.entityId}`); else if (n.entityType === "profile") navigate(`/profiles/${n.entityId}`); }}
            className="w-full flex items-start gap-2.5 py-1.5 text-left hover:bg-muted/40 rounded px-1"
            data-testid={`notification-${n.id}`}
          >
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dot(n.severity)}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate">{n.title}</div>
              <div className="text-xs text-muted-foreground truncate">{n.message}</div>
            </div>
          </button>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// This-week progress snapshot (from stats, no extra fetch) + a button to
// generate the full weekly review artifact.
export function WeeklySummarySection({ stats, filterIds }: { stats: DashboardStats | undefined; filterIds: string[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { getAuthHeader } = useAuth();
  const [generating, setGenerating] = useState(false);
  if (!stats) return null;
  const topStreak = Math.max(0, ...(stats.streaks || []).map(s => s.days || 0), stats.journalStreak || 0);
  const cells: Array<{ label: string; value: string }> = [
    { label: "Entries this week", value: String(stats.weeklyEntries ?? 0) },
    { label: "Active tasks", value: String(stats.activeTasks ?? 0) },
    { label: "Best streak", value: `${topStreak}d` },
    { label: "Habit completion", value: `${Math.round(stats.habitCompletionRate ?? 0)}%` },
  ];
  const generate = async () => {
    setGenerating(true);
    try {
      const qs = filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
      const res = await fetch(`/api/weekly-review/generate${qs}`, { method: "POST", headers: getAuthHeader() });
      const data = await res.json();
      if (data?.artifactId) { toast({ title: "Weekly review ready" }); navigate(`/editor/${data.artifactId}`); }
      else toast({ title: "Weekly review generated" });
    } catch { toast({ title: "Couldn't generate review", variant: "destructive" }); }
    finally { setGenerating(false); }
  };
  return (
    <CollapsibleSection label="Weekly Summary" icon={TrendingUp} testId="section-weekly-summary">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
        {cells.map(c => (
          <div key={c.label} className="rounded-lg border p-2.5">
            <div className="micro-label text-muted-foreground">{c.label}</div>
            <div className="text-lg font-bold tabular-nums mt-0.5">{c.value}</div>
          </div>
        ))}
      </div>
      <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={generate} disabled={generating} data-testid="weekly-generate">
        <Sparkles className="h-3.5 w-3.5" /> {generating ? "Generating…" : "Generate full weekly review"}
      </Button>
    </CollapsibleSection>
  );
}

// Section ids/labels/visibility live in shared/dashboard-layout.ts (single
// source of truth with the AI's configure_dashboard_sections tool — see the
// drift guard in tests/dashboard-layout-guard.test.ts). Icons are React
// components, so they stay client-side and are joined here by id.
const SECTION_ICONS: Record<string, any> = {
  "exec-briefing": ListChecks,
  "hero-briefing": Sparkles,
  "quick-actions": Zap,
  "needs-attention": AlertTriangle,
  "today": Calendar,
  "now-queue": Flame,
  "notifications": Bell,
  "upcoming-dates": CalendarDays,
  "obligations": CreditCard,
  "hero-kpis": Sparkles,
  "kpis": BarChart3,
  "weekly-summary": TrendingUp,
  "trends": Activity,
  "health": HeartPulse,
  "goals": Target,
  "key-findings": Lightbulb,
  "domain-hubs": BarChart3,
  "activity": Activity,
  "ai-summary": Sparkles,
  "finance": DollarSign,
};
const DEFAULT_SECTIONS: DashboardSection[] = DEFAULT_SECTION_DEFS.map((s) => ({
  ...s,
  icon: SECTION_ICONS[s.id] || Activity,
}));
// Swimlane groups (id sets) — render small group header chips during layout
const SWIMLANE_GROUPS: Array<{ key: string; label: string; emoji: string; ids: string[] }> = [
  { key: "now",        label: "Now",        emoji: "⚡", ids: ["hero-briefing", "quick-actions", "exec-briefing", "needs-attention", "today", "now-queue", "notifications", "upcoming-dates", "obligations"] },
  { key: "trajectory", label: "Trajectory", emoji: "📈", ids: ["hero-kpis", "kpis", "weekly-summary", "trends", "health", "goals", "key-findings"] },
  { key: "explore",    label: "Explore",    emoji: "🧭", ids: ["domain-hubs", "activity", "ai-summary"] },
  { key: "more",       label: "More", emoji: "🗂️", ids: ["finance"] },
];

// LAYOUT_VERSION is imported from shared/dashboard-layout.ts — bump it THERE.

// ── Dashboard v2 Phase 5: Focus modes ───────────────────────────────────────
// A mode reweights WHICH sections show and in WHAT order — Portol is too broad
// for one static homepage. "Executive" honors the user's saved/custom layout;
// the focused modes derive a fresh preset from the known sections. Persisted in
// localStorage. Non-destructive: switching back to Executive restores the
// saved layout untouched.
export type DashMode = "executive" | "finance" | "health" | "daily";
const DASH_MODE_LS_KEY = "portol_dashboard_mode_v1";
const MODE_LABELS: Record<DashMode, string> = {
  executive: "Executive", finance: "Finance", health: "Health", daily: "Daily ops",
};
// Each mode shows a DISTINCT set so switching is unmistakable (not just a
// reorder of the same cards): Finance surfaces the full Finance widget; Health
// drops the finance hero entirely and leads with Trends; Daily ops is a lean
// "what do I do today" view with no trends/finance hero.
const MODE_ORDER: Record<Exclude<DashMode, "executive">, string[]> = {
  finance: ["hero-briefing", "now-queue", "hero-kpis", "finance", "trends", "kpis", "domain-hubs"],
  health:  ["hero-briefing", "now-queue", "health", "trends", "kpis", "goals", "domain-hubs"],
  daily:   ["hero-briefing", "now-queue", "kpis", "domain-hubs", "goals"],
};
function loadDashMode(): DashMode {
  try {
    const m = localStorage.getItem(DASH_MODE_LS_KEY) as DashMode | null;
    if (m && (m === "executive" || m === "finance" || m === "health" || m === "daily")) return m;
  } catch { /* ignore */ }
  return "executive";
}
function buildModeSections(mode: Exclude<DashMode, "executive">): DashboardSection[] {
  const known = new Map(DEFAULT_SECTIONS.map(s => [s.id, s]));
  return MODE_ORDER[mode]
    .map(id => known.get(id))
    .filter((s): s is DashboardSection => !!s)
    .map(s => ({ ...s, visible: true, column: "full" as const }));
}

function parseSavedLayout(saved: string | null): DashboardSection[] | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved);
    // Support versioned layout: { version, sections }
    let sections: DashboardSection[];
    let version = 0;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.sections) {
      version = parsed.version || 0;
      sections = parsed.sections;
    } else if (Array.isArray(parsed)) {
      sections = parsed;
      version = 0;
    } else {
      return null;
    }
    // If layout version is outdated, reset to defaults
    if (version < LAYOUT_VERSION) return null;
    if (!Array.isArray(sections) || sections.length === 0) return null;
    const iconMap = new Map(DEFAULT_SECTIONS.map(s => [s.id, s.icon]));
    const validIds = new Set(DEFAULT_SECTIONS.map(s => s.id));
    const filtered = sections.filter(s => validIds.has(s.id));
    const savedIds = new Set(filtered.map(s => s.id));
    for (const def of DEFAULT_SECTIONS) {
      if (!savedIds.has(def.id)) filtered.push({ ...def });
    }
    return filtered.map(s => ({ ...s, icon: iconMap.get(s.id) || Activity }));
  } catch {
    return null;
  }
}

function serializeLayout(sections: DashboardSection[]): string {
  return JSON.stringify({ version: LAYOUT_VERSION, sections: sections.map(({ id, label, visible, column }) => ({ id, label, visible, column })) });
}

function CustomizeDialog({
  open, onOpenChange, sections, onSave,
}: {
  open: boolean; onOpenChange: (open: boolean) => void;
  sections: DashboardSection[]; onSave: (sections: DashboardSection[]) => void;
}) {
  const [draft, setDraft] = useState<DashboardSection[]>(sections);
  const prevOpenRef = useRef(false);

  useEffect(() => {
    if (open && !prevOpenRef.current) setDraft([...sections]);
    prevOpenRef.current = open;
  }, [open, sections]);

  const toggleVisibility = (id: string) =>
    setDraft(d => d.map(s => s.id === id ? { ...s, visible: !s.visible } : s));

  const moveUp = (id: string) => setDraft(d => {
    const idx = d.findIndex(s => s.id === id);
    if (idx <= 0) return d;
    const next = [...d]; [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]; return next;
  });

  const moveDown = (id: string) => setDraft(d => {
    const idx = d.findIndex(s => s.id === id);
    if (idx < 0 || idx >= d.length - 1) return d;
    const next = [...d]; [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]; return next;
  });

  const cycleColumn = (id: string) => setDraft(d => d.map(s => {
    if (s.id !== id) return s;
    const order: Array<"full" | "left" | "right"> = ["full", "left", "right"];
    return { ...s, column: order[(order.indexOf(s.column) + 1) % order.length] };
  }));

  const columnLabel = (col: string) => col === "full" ? "Full" : col === "left" ? "Left" : "Right";
  const columnBadgeColor = (col: string) =>
    col === "full" ? "bg-primary/10 text-primary" :
    col === "left" ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" :
    "bg-purple-500/10 text-purple-600 dark:text-purple-400";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col" data-testid="dialog-customize-dashboard">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Settings className="h-4 w-4 text-primary" />
            Customize Dashboard
          </DialogTitle>
          <DialogDescription className="text-xs">
            {(() => {
              const visible = draft.filter(s => s.visible).length;
              const hidden = draft.length - visible;
              return (
                <>Reorder, toggle, and place sections in columns.
                <span className="ml-1 font-medium text-foreground">{visible} visible</span>
                {hidden > 0 && <span className="text-muted-foreground/70"> · {hidden} hidden</span>}
                </>
              );
            })()}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 -mx-6 px-6 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '55vh' }}>
          <div className="space-y-1 py-1">
            {draft.map((section, idx) => {
              const Icon = section.icon;
              return (
                <div key={section.id}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${section.visible ? "bg-muted/50" : "bg-muted/20 opacity-50"}`}
                  data-testid={`section-item-${section.id}`}>
                  <GripVertical className="h-3 w-3 text-muted-foreground shrink-0" />
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className={`flex-1 truncate ${!section.visible ? "line-through text-muted-foreground" : ""}`}>
                    {section.label}
                  </span>
                  <button onClick={() => cycleColumn(section.id)}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${columnBadgeColor(section.column)}`}
                    data-testid={`btn-column-${section.id}`}>
                    {columnLabel(section.column)}
                  </button>
                  <button onClick={() => toggleVisibility(section.id)}
                    className="shrink-0 p-1 rounded hover:bg-muted"
                    data-testid={`btn-toggle-${section.id}`}>
                    {section.visible ? <Eye className="h-3.5 w-3.5 text-foreground/70" /> : <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                  <button onClick={() => moveUp(section.id)}
                    className="shrink-0 p-1 rounded hover:bg-muted disabled:opacity-30" disabled={idx === 0}
                    data-testid={`btn-moveup-${section.id}`}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => moveDown(section.id)}
                    className="shrink-0 p-1 rounded hover:bg-muted disabled:opacity-30" disabled={idx === draft.length - 1}
                    data-testid={`btn-movedown-${section.id}`}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter className="flex-row items-center justify-between sm:justify-between gap-2 pt-3 border-t">
          <button onClick={() => setDraft(DEFAULT_SECTIONS.map(s => ({ ...s })))}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            data-testid="btn-reset-layout">
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs"
              onClick={() => onOpenChange(false)} data-testid="btn-cancel-customize">Cancel</Button>
            <Button size="sm" className="h-7 text-xs"
              onClick={() => { onSave(draft); onOpenChange(false); }} data-testid="btn-save-layout">Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// HOUSEHOLD DASHBOARD ("Everyone" scope)
//
// The "Everyone" scope renders a DISTINCT aggregate dashboard — NOT a person's
// personal dashboard summed up. It deliberately OMITS per-person widgets
// (habits, journal, personal goals, personal budgets, health trackers) because
// those are only meaningful for a single individual. Instead it surfaces
// household-wide analytics: combined net worth, a per-profile summary +
// ownership breakdown, shared/upcoming bills, the household schedule,
// cross-profile insights, and a recent-activity feed across everyone.
//
// Selecting any profile (one or many) flips back to the personal dashboard
// (the section grid), scoped to that selection. See the render branch in
// DashboardPage.
// ─────────────────────────────────────────────────────────────────────────────
const fmtUSD0 = (n: number) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString()}`;

// Deterministic accent color per profile so a person reads with the same hue
// wherever they appear (household cards, avatars). Small fixed HSL palette,
// hashed by id+name so it's stable across renders.
const PROFILE_ACCENTS = [
  "199 89% 48%", "152 60% 44%", "262 83% 62%", "25 95% 53%",
  "330 81% 60%", "199 89% 60%", "174 72% 41%", "350 89% 60%",
];
function profileAccent(seed: string): string {
  let h = 0;
  for (let i = 0; i < (seed || "").length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PROFILE_ACCENTS[h % PROFILE_ACCENTS.length];
}
function profileInitials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function HouseholdGroupHeader({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <div className="flex items-center gap-2 mt-3 mb-1 px-0.5">
      <Icon className="h-4 w-4 text-muted-foreground/80" aria-hidden="true" />
      <span className="micro-label text-muted-foreground/80">{label}</span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  );
}

// One place to read the relational ownership tables. Both queries are already
// in the react-query cache (the hero KPI section fetches the same keys), so
// this is a cache read, not extra network. Everything that turns a raw asset
// or liability value into a per-person number must go through here — that is
// what keeps the Finance tab, the Net Worth popup and the household cards
// from each applying their own ownership rule.
function useOwnershipTables(allProfiles: any[]): OwnershipTables {
  const { data: assetLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/asset-party-links"],
    queryFn: () => apiRequest("GET", "/api/asset-party-links").then(r => r.json()),
  });
  const { data: liabilityLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/liability-profile-links"],
    queryFn: () => apiRequest("GET", "/api/liability-profile-links").then(r => r.json()),
  });
  const selfProfileId = (allProfiles || []).find((p: any) => p?.type === "self")?.id ?? null;
  return useMemo(
    () => ({ assetLinks, liabilityLinks, selfProfileId }),
    [assetLinks, liabilityLinks, selfProfileId],
  );
}

// #1 Household hero — one combined Net Worth headline with an assets-vs-
// liabilities split bar. Distinct from the personal dashboard's KPI tiles so
// "Everyone" reads as an aggregate view at a glance. Uses computeNetWorth (the
// single source of truth) so it agrees with the per-profile cards + personal
// dashboards to the dollar.
function HouseholdHero({ allProfiles }: { allProfiles: any[] }) {
  // Household total is unfiltered, so every share sums to 100% and the
  // ownership tables can't change the answer — but pass them anyway so this
  // hero and the per-person cards below run the exact same code path.
  const ownership = useOwnershipTables(allProfiles);
  const { assets, liabilities, netWorth } = useMemo(
    () => computeNetWorth(allProfiles || [], { mode: "everyone", selectedIds: [], ownership }),
    [allProfiles, ownership],
  );
  const total = assets + liabilities;
  const assetPct = total > 0 ? Math.round((assets / total) * 100) : (assets > 0 ? 100 : 0);
  const peopleCount = (allProfiles || []).filter((p: any) => p.type === "self" || p.type === "person").length;
  return (
    <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/[0.08] to-transparent p-4" data-testid="household-hero">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 micro-label text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> Household net worth
        </div>
        {peopleCount > 0 && <span className="text-[11px] text-muted-foreground">{peopleCount} {peopleCount === 1 ? "person" : "people"}</span>}
      </div>
      <p className={`mt-1 text-3xl font-black tabular-nums ${netWorth >= 0 ? "text-foreground" : "text-rose-500"}`}>{fmtUSD0(netWorth)}</p>
      <div className="mt-3 h-2.5 w-full rounded-full overflow-hidden bg-rose-500/70 flex" title={`${assetPct}% assets`}>
        <div className="h-full bg-emerald-500" style={{ width: `${assetPct}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
          <TrendingUp className="h-3.5 w-3.5" />{fmtUSD0(assets)} <span className="text-muted-foreground/70 font-normal">assets</span>
        </span>
        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-medium">
          <span className="text-muted-foreground/70 font-normal">debt</span> {fmtUSD0(liabilities)} <TrendingDown className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  );
}

// #2 Per-profile summary cards = profile summaries + asset/liability ownership
// breakdown + each person's share of household net worth. Net worth per person
// comes from the SINGLE source of truth (computeNetWorth). Clicking a card
// switches scope to that profile's personal dashboard.
function ProfileSummaryGrid({ allProfiles }: { allProfiles: any[] }) {
  // BUG (QA 2026-07-25, "House: $250,000 in Finance but $500,000 in Assets"):
  // these per-person cards used to sum WHOLE asset/liability values, so a
  // 50/50 house counted $500k on both owners' cards while the Finance tab —
  // which reads the server's share-adjusted snapshot — showed $250k. Feeding
  // computeNetWorth the ownership tables makes both surfaces one calculation.
  const ownership = useOwnershipTables(allProfiles);
  const cards = useMemo(() => {
    const people = (allProfiles || []).filter((p: any) => p.type === "self" || p.type === "person" || p.type === "pet");
    return people
      .map((p: any) => {
        const nw = computeNetWorth(allProfiles, { mode: "selected", selectedIds: [p.id], ownership });
        return {
          id: p.id,
          name: p.name || "Unnamed",
          type: p.type as string,
          netWorth: nw.netWorth,
          assets: nw.assets,
          liabilities: nw.liabilities,
          assetCount: nw.assetProfiles.length,
          liabilityCount: nw.liabilityProfiles.length,
        };
      })
      .sort((a: any, b: any) => b.netWorth - a.netWorth);
  }, [allProfiles, ownership]);

  const totalPositiveNW = useMemo(() => cards.reduce((s: number, c: any) => s + Math.max(0, c.netWorth), 0), [cards]);

  if (cards.length === 0) {
    return (
      <div className="bubble -dashed p-6 text-center">
        <Users className="h-7 w-7 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No people or pets yet</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">Add a profile to see household totals here</p>
      </div>
    );
  }

  return (
    // Third column only at xl: these cards carry a name, a net-worth figure and
    // a two-part assets/debts line, which needs ~320px. At lg the sidebar leaves
    // ~720px of content, and thirds of that would wrap the bottom line.
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
      {cards.map((c: any) => {
        const accent = profileAccent(c.id + c.name);
        const share = totalPositiveNW > 0 ? (Math.max(0, c.netWorth) / totalPositiveNW) * 100 : 0;
        return (
          <button
            key={c.id}
            onClick={() => setFilterSelected([c.id], [c.name])}
            className="text-left bubble hover:bg-muted/20 transition-colors p-3"
            style={{ borderLeft: `3px solid hsl(${accent})` }}
            data-testid={`household-profile-${c.id}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold"
                  style={{ background: `hsl(${accent} / 0.18)`, color: `hsl(${accent})` }}
                >
                  {c.type === "pet" ? <Heart className="h-4 w-4" /> : profileInitials(c.name)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{c.type === "self" ? `${c.name} (You)` : c.name}</p>
                  <p className="micro-label text-muted-foreground">{c.type}</p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-sm font-bold tabular-nums ${c.netWorth >= 0 ? "text-foreground" : "text-rose-500"}`}>{fmtUSD0(c.netWorth)}</p>
                <p className="text-[11px] text-muted-foreground">{share >= 1 ? `${share.toFixed(0)}% of household` : "net worth"}</p>
              </div>
            </div>
            {/* share-of-household bar */}
            <div className="mt-2 h-1.5 w-full rounded-full overflow-hidden bg-muted">
              <div className="h-full rounded-full" style={{ width: `${Math.max(share, c.netWorth > 0 ? 2 : 0)}%`, background: `hsl(${accent})` }} />
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1"><TrendingUp className="h-3 w-3 text-emerald-500" />{fmtUSD0(c.assets)} <span className="text-muted-foreground/60">· {c.assetCount} {c.assetCount === 1 ? "asset" : "assets"}</span></span>
              <span className="inline-flex items-center gap-1"><TrendingDown className="h-3 w-3 text-rose-500" />{fmtUSD0(c.liabilities)} <span className="text-muted-foreground/60">· {c.liabilityCount} {c.liabilityCount === 1 ? "debt" : "debts"}</span></span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function HouseholdDashboard({ enhanced, stats, allProfiles, showSkeleton, ready = true }: {
  enhanced: any;
  stats: any;
  allProfiles: any[];
  showSkeleton?: boolean;
  ready?: boolean;
}) {
  if (showSkeleton) return <SkeletonGrid cols={3} rows={2} h="h-14" />;
  return (
    <div className="space-y-3" data-testid="household-dashboard">
      {/* Everyone scope = the SAME dense Executive briefing the personal
          dashboards use (2026-07-15 user request: "make Everyone look like the
          rest of the app"), aggregated across all profiles — every tile and
          row opens its module's popup, exactly like the personal view.
          Household-only extras (combined net-worth hero + per-person cards)
          follow below the briefing. */}
      <ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} ready={ready} />
      <HouseholdGroupHeader icon={Users} label="Household" />
      <HouseholdHero allProfiles={allProfiles} />
      <ProfileSummaryGrid allProfiles={allProfiles} />
      <AISummaryWidget stats={stats} enhanced={enhanced} filterMode="everyone" filterIds={[]} scopeLabel="Everyone" />
    </div>
  );
}

export default function DashboardPage() {
  useEffect(() => { document.title = "Dashboard — Portol"; }, []);
  const { toast } = useToast();
  // Hub consolidation (2026-07): under the hub shell the date + profile
  // filter are owned by the shell; this page keeps only its kebab menu.
  const hubEmbedded = useHubChrome();
  // STALE-CLOCK FIX (2026-07-21): one re-render per resume-after-long-absence
  // so the header date (and every other now()-derived section below) rolls
  // over after an overnight freeze instead of showing yesterday. The hook
  // only fires after >=15s hidden — quick tab flips don't re-render.
  useResumeTick();
  const [, navigate] = useLocation();
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [chatgptImportOpen, setChatgptImportOpen] = useState(false);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  // Whether synthetic test/QA rows are shown (point 11). Default off.
  const showTestData = useShowTestData();
  // Whether this build may render developer/QA-only menu items at all.
  const devTools = useMemo(() => devToolsEnabled(), []);
  // Keep dashboard filter state in lockstep with the global filter store — prevents
  // multi-profile selections from silently collapsing if a child component's onChange
  // is stale or batched.
  //
  // PERF FIX (2026-05-24): only update state when values actually change. The
  // previous version always spread `state.selectedIds` into a new array, which
  // gave every queryKey a fresh array reference on every auth-state ping and
  // double-fetched the entire dashboard. We compare values up-front and skip
  // the setState entirely when nothing changed.
  useEffect(() => {
    const idsEqual = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
    const apply = (state: { mode: FilterMode; selectedIds: string[] }) => {
      setFilterMode(prev => prev === state.mode ? prev : state.mode);
      setFilterIds(prev => idsEqual(prev, state.selectedIds) ? prev : [...state.selectedIds]);
    };
    const unsub = subscribeProfileFilter(apply);
    apply(getProfileFilter());
    return unsub;
  }, []);

  // PERF (Part C): gate behind ?perfLog=1 — measure how long a filter switch
  // takes to surface dashboard-enhanced data. A cached filter should resolve in
  // <500ms (the keepPreviousData + staleTime + persisted-cache path). The
  // mark is set the instant the filter changes; the elapsed time is logged when
  // the next render carries enhanced data for that filter.
  const perfLogEnabled = typeof window !== "undefined" && /(?:\?|&)perfLog=1\b/.test(window.location.search + window.location.hash);
  const filterSwitchMarkRef = useRef<number | null>(null);
  useEffect(() => {
    if (!perfLogEnabled) return;
    filterSwitchMarkRef.current = performance.now();
    // eslint-disable-next-line no-console
    console.log(`[perfLog] filter switch → ${filterMode} [${filterIds.join(",") || "everyone"}] @ ${Math.round(filterSwitchMarkRef.current)}ms`);
  }, [perfLogEnabled, filterMode, filterIds.join(",")]);

  // Fetch profiles for filter
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Default scope = the primary user. On a user's FIRST load (no stored filter
  // yet) we seed the Self profile so the dashboard opens as that person's
  // PERSONAL dashboard, not the aggregate. "Everyone" is now a first-class,
  // user-selectable scope that renders the distinct HOUSEHOLD dashboard
  // (see the render branch below). If the account has no Self profile we leave
  // the filter on Everyone (Household), which is the right fallback when there
  // is no single primary user. Idempotent — never overrides a user's choice.
  useEffect(() => {
    if (!allProfiles || allProfiles.length === 0) return;
    initDefaultProfileFilter(allProfiles);
    // Heal a persisted scope whose profile ids were hard-deleted/recreated —
    // otherwise every widget queries a dead id and renders 0 while the
    // switcher still shows the remembered name.
    reconcileProfileFilter(allProfiles);
  }, [allProfiles]);

  // Compute stats profile param for API calls.
  // Bug fix: gate on filterMode === "selected" so that when the user is in
  // "everyone" mode but filterIds still has stale ids during a transition,
  // we don't accidentally send a profileIds filter and over-restrict the data.
  const statsProfileParam = filterMode === "selected" && filterIds.length > 0
    ? '?profileIds=' + filterIds.join(',')
    : '';

  // Compute resolvedFilterId for backward compat with child components that only support a single id.
  // Bug fix: when 2+ profiles are selected this used to collapse to undefined (= 'Everyone'),
  // making the dashboard ignore the multi-select. Children that need full multi-id support get
  // filterIds passed through directly.
  const resolvedFilterId = filterMode === "everyone" ? undefined : (filterIds.length === 1 ? filterIds[0] : undefined);

  // Sync profile filter to module-level state for backward compat with sub-pages.
  // Only mirror a SINGLE selected profile. We must NOT write "everyone" here:
  //   (a) on first load it would persist "everyone" before initDefaultProfileFilter
  //       can seed the Self profile (defeating the personal-by-default rule), and
  //   (b) it would reset a 2+ profile multi-selection back to everyone.
  // "Everyone" is only ever set by an explicit toolbar choice (which persists it).
  useEffect(() => {
    if (!resolvedFilterId) return;
    // P2.5: inlined from the deleted legacy setDashboardProfileFilter() —
    // with a truthy id it was exactly setFilterSelected([id], [name]).
    setFilterSelected([resolvedFilterId], [allProfiles.find((p: any) => p.id === resolvedFilterId)?.name || ""]);
  }, [resolvedFilterId, allProfiles]);

  // PERF (2026-05-28): single-shot bootstrap. /api/dashboard-bootstrap returns
  // stats + enhanced + profiles + incomes + budget-summary in ONE round-trip.
  // We pre-fill the react-query cache so the individual useQuery hooks below
  // (which mutations still depend on) see a fresh cache hit and skip the
  // network. Without this, the dashboard fired 10 parallel network calls and
  // the skeleton stayed up for ~20-30s on cold loads with realistic data
  // volume.
  //
  // PERF (2026-05-30 Phase 2): converted from a fire-and-forget useEffect to a
  // proper useQuery so the dependent stats/enhanced hooks can gate on
  // `bootstrapFetched`. Previously the dependent hooks would fire their own
  // /api/stats and /api/dashboard-enhanced requests in parallel with bootstrap,
  // causing 3 round-trips per filter swap. Now bootstrap fires once and the
  // dependent hooks read from the pre-filled cache.
  // Browser-zone month — the same key the budget hooks read (see line ~620),
  // so the seed lands in the slot they consume.
  const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const bootstrapQs = (filterMode === "selected" && filterIds.length > 0)
    ? `?profileIds=${filterIds.join(",")}&month=${currentMonth}`
    : `?month=${currentMonth}`;
  const bootstrapQuery = useQuery<any>({
    queryKey: ["/api/dashboard-bootstrap", filterMode, ...filterIds, currentMonth],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/dashboard-bootstrap${bootstrapQs}`);
      const b = await r.json();
      // Pre-fill EVERY dashboard mount-time query key from the single
      // bootstrap response (see lib/bootstrap-seed.ts) — dependent hooks
      // resolve from cache instantly instead of firing ~12 GETs.
      seedDashboardCaches(b, filterMode, filterIds, currentMonth);
      return b ?? null;
    },
    placeholderData: undefined,
    // One retry: a single transient failure of THE gating request used to
    // blank the whole dashboard with no recovery path.
    retry: 1,
  });
  // Gate dependent hooks on bootstrap settling (success or error). Using
  // isFetched (not isSuccess) means a bootstrap failure still releases the
  // dependent hooks to fetch their own data — graceful degradation.
  // Also keep them disabled while the self-redirect is pending so they don't
  // fetch with stale everyone-mode params and immediately refetch with the
  // redirected self filter (Phase 3 loop fix).
  //
  // GATE DEADLINE (stuck-skeleton fix, 2026-07-16): the bootstrap is a single
  // point of failure — if its request wedges (mobile Safari orphans in-flight
  // fetches on suspend; a cold serverless instance can stall), every section
  // stayed skeleton FOREVER because stats/enhanced never got enabled. After
  // 8s un-settled, release the gate anyway: stats/enhanced fetch their own
  // (server-cached) data independently.
  const [bootstrapDeadline, setBootstrapDeadline] = useState(false);
  useEffect(() => {
    if (bootstrapQuery.isFetched) { setBootstrapDeadline(false); return; }
    const t = setTimeout(() => setBootstrapDeadline(true), 8_000);
    return () => clearTimeout(t);
  }, [bootstrapQuery.isFetched, filterMode, filterIds.join(","), currentMonth]);
  const bootstrapSettled = bootstrapQuery.isFetched || bootstrapDeadline;

  // PERF (profile-switch, 2026-08-05): once THIS scope has painted, warm the
  // other people's scopes in the background so opening the switcher and picking
  // someone renders from cache instead of waiting out a cold bootstrap. The
  // sweep is sequential, idle-scheduled and capped (see warmSiblingScopes) and
  // is keyed off bootstrapQuery.isFetched — not bootstrapSettled — so the 8s
  // deadline escape hatch (a bootstrap that never landed) never triggers extra
  // background load on a link that is already struggling.
  //
  // The dep is the id STRING, not the profiles array: every warmed bootstrap
  // re-seeds ["/api/profiles"] with a fresh array reference (seedDashboardCaches),
  // so depending on the array itself would cancel and restart the sweep on each
  // one of its own responses.
  const switchablePeopleKey = useMemo(
    () => (allProfiles || [])
      .filter((p: any) => ["self", "person", "pet"].includes(p?.type))
      .map((p: any) => p.id)
      .join(","),
    [allProfiles],
  );
  useEffect(() => {
    if (!bootstrapQuery.isFetched) return;
    const people = switchablePeopleKey ? switchablePeopleKey.split(",") : [];
    if (people.length < 2) return;
    return warmSiblingScopes(people, filterMode === "selected" ? filterIds : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrapQuery.isFetched, switchablePeopleKey, filterMode, filterIds.join(",")]);

  const { data: stats, isPending: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/stats", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/stats${statsProfileParam}`).then(r => r.json()),
    // PERF (2026-05-30 Phase 2): only fetch if bootstrap didn't pre-fill the
    // cache. Bootstrap returns stats inline so this hook becomes a no-op on
    // the happy path. Falls back to a direct fetch if bootstrap fails.
    enabled: bootstrapSettled,
    // BUG-20260530-filter-stale-stats-leak: without placeholderData: undefined,
    // react-query returned the PREVIOUS filter's stats during a filter swap
    // (Everyone -> Craig). That left the dashboard rendering Test's
    // monthlySpend $698k, 6 open tasks, 8 bills due, etc. when Craig (who has
    // no data) was selected, because the new server response (all zeros) was
    // still in flight. Forcing undefined makes the cards show skeleton/zero
    // during swap and snap to the correct values when the fetch lands.
    placeholderData: undefined,
    // PERF (2026-05-24): was `refetchOnMount: "always"`, which made every
    // dashboard mount feel like a cold load. With persisted cache + the
    // global onMutate invalidation hook (see queryClient.ts) we get fresh
    // numbers after any write. For pure navigation, default behaviour
    // ("return cached, refetch in background if stale") feels instant.
  });
  // Delay dashboard skeleton — instant if data is cached
  const [showDashSkeleton, setShowDashSkeleton] = useState(false);
  useEffect(() => {
    if (!statsLoading) { setShowDashSkeleton(false); return; }
    const dsk = setTimeout(() => setShowDashSkeleton(true), 200);
    return () => clearTimeout(dsk);
  }, [statsLoading]);
  // SKELETON DEADLINE (stuck-skeleton fix, 2026-07-16): a skeleton must never
  // be permanent. If stats still hasn't landed after 12s, swap the skeleton
  // for a visible "couldn't load — Retry" card. Retry cancels any wedged
  // in-flight request first (react-query refuses to restart a query that
  // still *thinks* it's fetching — the orphaned-fetch-on-resume trap).
  const [dashLoadStuck, setDashLoadStuck] = useState(false);
  useEffect(() => {
    if (!statsLoading) { setDashLoadStuck(false); return; }
    const t = setTimeout(() => setDashLoadStuck(true), 12_000);
    return () => clearTimeout(t);
  }, [statsLoading]);
  const retryDashboardLoad = useCallback(async () => {
    setDashLoadStuck(false);
    try {
      await queryClient.cancelQueries({
        predicate: (q) => {
          const k = String(q.queryKey?.[0] || "");
          return (k.startsWith("/api/dashboard") || k === "/api/stats") && q.state.fetchStatus === "fetching";
        },
      });
    } catch { /* cancel is best-effort */ }
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-bootstrap"], refetchType: "active" });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"], refetchType: "active" });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"], refetchType: "active" });
  }, []);

  const { data: enhanced, isFetching: enhancedFetching } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds],
    queryFn: async () => {
      // BUG-20260715-everyone-zeros: this used to swallow failures and return
      // null, which react-query cached as a SUCCESS — Bills/Docs/Net-worth then
      // rendered 0/— for the whole staleTime window with no retry. Let the
      // error propagate so the query stays in error state and refetches on the
      // next mount/focus instead of pinning zeros.
      const res = await apiRequest("GET", `/api/dashboard-enhanced${statsProfileParam}`);
      return res.json();
    },
    // One retry (stuck-skeleton fix, 2026-07-16): with retry:false a single
    // transient failure left enhanced undefined — and every tile fed by it
    // said "loading" — until the next focus/mount.
    retry: 1,
    // PERF (2026-05-30 Phase 2): see /api/stats hook above. Bootstrap
    // pre-fills this cache entry; this hook becomes a no-op on the happy path.
    enabled: bootstrapSettled,
    // BUG-20260530-filter-stale-stats-leak: same fix as /api/stats above.
    // enhanced.financeSnapshot is what drives Net Worth / Cash Flow / Asset /
    // Liability roll-ups; without this the dashboard kept rendering the
    // previous filter's $223k net worth and -$698k cash flow when swapping
    // to a profile with no data.
    placeholderData: undefined,
    // PERF (2026-05-24): see /api/stats note above. Removed `"always"` so
    // returning to the dashboard renders from cache instantly.
  });

  // PERF (Part C): log elapsed time once enhanced data is present after a
  // filter switch. Cached filters should land well under 500ms.
  useEffect(() => {
    if (!perfLogEnabled || !enhanced || filterSwitchMarkRef.current == null) return;
    const elapsed = performance.now() - filterSwitchMarkRef.current;
    filterSwitchMarkRef.current = null;
    // eslint-disable-next-line no-console
    console.log(`[perfLog] dashboard-enhanced ready for ${filterMode} [${filterIds.join(",") || "everyone"}] in ${Math.round(elapsed)}ms`);
  }, [perfLogEnabled, enhanced, filterMode, filterIds.join(",")]);

  // P1 dedupe (QA scorecard): ONE query per key for the datasets that several
  // sections used to declare their own useQuery copies of (events ×3, goals ×3,
  // profiles ×5 — see HeroBriefing / DomainHubs / NowQueue / Upcoming / KPI /
  // FinanceWidget). Query keys are unchanged, so every existing invalidation
  // (cache bus, chat, other pages) still hits the same cache slots; the data
  // now flows down as props. Gated on bootstrapSettled so the happy path
  // resolves from the bootstrap-seeded cache without extra round-trips, and
  // skipped in Everyone mode where none of the consuming sections render.
  const sharedProfileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: sharedEvents = [] } = useQuery<any[]>({
    queryKey: ["/api/events", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/events${sharedProfileParam}`)).then(r => r.json()).catch(() => []),
    enabled: bootstrapSettled && filterMode !== "everyone",
  });
  const { data: sharedGoalsRaw } = useQuery<any>({
    queryKey: goalsQueryKey(filterIds), // BUG-20260528: share GoalsSection's cache slot
    queryFn: () => apiRequest("GET", withFullLimit(`/api/goals${sharedProfileParam}`)).then(r => r.json()).catch(() => []),
    enabled: bootstrapSettled && filterMode !== "everyone",
  });
  const sharedGoals = useMemo(
    () => Array.isArray(sharedGoalsRaw) ? sharedGoalsRaw : (sharedGoalsRaw?.items || sharedGoalsRaw?.goals || []),
    [sharedGoalsRaw],
  );

  // Load saved dashboard layout from preferences API
  const { data: savedLayoutData } = useQuery<{ value: string } | null>({
    queryKey: ["/api/preferences", "dashboard_layout"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/preferences/dashboard_layout");
        return res.json();
      } catch { return null; }
    },
  });

  // Phase 5: focus mode. Executive honors the saved/custom layout; the focused
  // modes derive a preset. Persisted to localStorage; non-destructive.
  const [dashMode, setDashMode] = useState<DashMode>(() => loadDashMode());
  const changeDashMode = (m: DashMode) => {
    setDashMode(m);
    try { localStorage.setItem(DASH_MODE_LS_KEY, m); } catch { /* ignore */ }
  };
  const sections: DashboardSection[] = dashMode === "executive"
    ? (parseSavedLayout(savedLayoutData?.value ?? null) || DEFAULT_SECTIONS)
    : buildModeSections(dashMode);

  const saveMutation = useMutation({
    mutationFn: (layout: DashboardSection[]) =>
      apiRequest("PUT", "/api/preferences/dashboard_layout", { value: serializeLayout(layout) }),
    onSuccess: () => {
      // Cache bus: preferences + dashboard (stats / dashboard-enhanced).
      invalidateDomains("preferences", "dashboard");
      toast({ title: "Layout saved" });
    },
    onError: () => toast({ title: "Failed to save layout", variant: "destructive" }),
  });

  const handleExport = async () => {
    try {
      const res = await apiRequest("GET", "/api/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `portol-backup-${localTodayISO()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `Backed up ${data.profiles?.length || 0} profiles, ${data.trackers?.length || 0} trackers, ${data.tasks?.length || 0} tasks.` });
    } catch (err: any) {
      toast({ title: "Export failed", description: err?.name === "AbortError" ? "Export timed out. Try again." : "Something went wrong.", variant: "destructive" });
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const res = await apiRequest("POST", "/api/import", data);
      const result = await res.json();
      if (result.success) {
        const total = Object.values(result.imported as Record<string, number>).reduce((s, v) => s + v, 0);
        toast({ title: "Import complete", description: `Imported ${total} items.` });
        // Cache bus nuclear option — an import can touch every domain.
        invalidateDomain("everything");
      } else {
        toast({ title: "Import failed", description: result.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Import failed", description: "Invalid backup file.", variant: "destructive" });
    } finally {
      setImporting(false);
      setImportOpen(false);
    }
  };

  function renderSection(id: string) {
    let content: React.ReactNode = null;
    switch (id) {
      case "hero-kpis":
        content = <HeroKPISection enhanced={enhanced} stats={stats} filterMode={filterMode} filterIds={filterIds} allProfiles={allProfiles} refetching={enhancedFetching} />;
        break;
      case "kpis":
        content = (showDashSkeleton && !stats)
          ? (dashLoadStuck ? <DashLoadTimeoutCard onRetry={retryDashboardLoad} /> : <SkeletonGrid cols={3} rows={2} h="h-14" />)
          : stats ? <KPISection stats={stats} enhanced={enhanced} filterIds={filterIds} filterMode={filterMode} allProfiles={allProfiles} /> : null;
        break;
      case "hero-briefing":
        content = <HeroBriefing enhanced={enhanced} allProfiles={allProfiles} filterIds={filterIds} filterMode={filterMode} events={sharedEvents} goals={sharedGoals} />;
        break;
      case "now-queue":
        content = <NowQueueSection enhanced={enhanced} stats={stats} filterIds={filterIds} filterMode={filterMode} events={sharedEvents} goals={sharedGoals} />;
        break;
      case "trends":
        content = <TrendsSection enhanced={enhanced} stats={stats} filterIds={filterIds} filterMode={filterMode} />;
        break;
      case "domain-hubs":
        content = <DomainHubsSection enhanced={enhanced} stats={stats} allProfiles={allProfiles} filterIds={filterIds} filterMode={filterMode} events={sharedEvents} goals={sharedGoals} />;
        break;
      case "health":
        content = <HealthSection data={enhanced?.healthSnapshot || []} />;
        break;
      case "today":
        content = <TodaySection enhanced={enhanced} stats={stats} />;
        break;
      case "needs-attention":
        content = stats ? <ActionRequiredSection stats={stats} enhanced={enhanced} profileId={resolvedFilterId} /> : null;
        break;
      case "key-findings":
        content = <KeyFindingsSection filterIds={filterIds} filterMode={filterMode} />;
        break;
      case "goals":
        content = <GoalsSection profileId={resolvedFilterId} profileIds={filterIds} />;
        break;
      case "obligations":
        content = <ObligationsSection data={enhanced?.financeSnapshot?.upcomingBills || []} />;
        break;
      case "finance":
        content = (
          <div className="space-y-3">
            <ExpiringWarrantiesCard allProfiles={allProfiles} filterIds={filterIds} filterMode={filterMode} />
            <FinanceWidget data={enhanced?.financeSnapshot} stats={stats} filterIds={filterIds} filterMode={filterMode} allProfiles={allProfiles} />
          </div>
        );
        break;
      case "ai-summary":
        content = (() => {
          const scopeLabel = filterMode === "selected" && filterIds.length > 0
            ? allProfiles.filter((p: any) => filterIds.includes(p.id)).map((p: any) => p.name).join(", ") || `Selected (${filterIds.length})`
            : "Everyone";
          return <AISummaryWidget stats={stats} enhanced={enhanced} filterMode={filterMode} filterIds={filterIds} scopeLabel={scopeLabel} />;
        })();
        break;
      case "activity":
        content = stats ? <ActivitySection activities={stats.recentActivity} /> : null;
        break;
      case "upcoming-dates":
        content = <UpcomingSection filterIds={filterIds} filterMode={filterMode} ready={bootstrapSettled} allProfiles={allProfiles} events={sharedEvents} goals={sharedGoals} />;
        break;
      case "quick-actions":
        content = <QuickActionsSection filterMode={filterMode} filterIds={filterIds} allProfiles={allProfiles} />;
        break;
      case "exec-briefing":
        content = <ExecutiveBriefing filterMode={filterMode} filterIds={filterIds} stats={stats} enhanced={enhanced} ready={bootstrapSettled} />;
        break;
      case "notifications":
        content = <NotificationsSection filterMode={filterMode} filterIds={filterIds} />;
        break;
      case "weekly-summary":
        content = <WeeklySummarySection stats={stats} filterIds={filterIds} />;
        break;
      default:
        content = null;
    }
    return content ? <SectionErrorBoundary name={id}>{content}</SectionErrorBoundary> : null;
  }

  const fullWidthSections = useMemo(() => sections.filter(s => s.visible && s.column === "full"), [sections]);
  const leftSections = useMemo(() => sections.filter(s => s.visible && s.column === "left"), [sections]);
  const rightSections = useMemo(() => sections.filter(s => s.visible && s.column === "right"), [sections]);

  return (
    // GUTTERS (2026-08-05): md:px-6, not md:p-4. The hub chrome above this page
    // (HubShell: px-3 md:px-6) and the app's standard PageContainer (px-4
    // md:px-6) both indent by 6 at desktop, so a 4 here left every card on the
    // dashboard sitting half a step inside the tab row that opened it.
    <div className="h-full overflow-y-auto overflow-x-hidden px-3 py-3 md:px-6 md:py-4 space-y-3 max-w-full pb-24" style={{WebkitOverflowScrolling: 'touch'}} data-testid="page-dashboard">
      {/* Header — hub-embedded: date + profile filter live in the hub shell
          (HubShell/HubProfileSwitcher write the same profileFilter store this
          page subscribes to), so only the kebab menu remains. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          {!hubEmbedded && (
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-foreground/90 tracking-tight">
              {/* Part D: render the header date in the user's timezone, not the
                  JS engine's local zone. BROWSER_TIMEZONE falls back to
                  America/Los_Angeles, matching the server's _timezone default. */}
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: BROWSER_TIMEZONE })}
            </p>
            <span className="text-xs text-muted-foreground/60">·</span>
            <MultiProfileFilter
              onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
              compact
            />
          </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 hover:bg-accent" data-testid="btn-dashboard-menu" aria-label="Dashboard menu">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setCustomizeOpen(true)} data-testid="btn-customize">
                <Settings className="h-4 w-4 mr-2" /> Customize
              </DropdownMenuItem>
              {/* Export / Import stay: data portability is a user feature. */}
              <DropdownMenuItem onClick={handleExport} data-testid="btn-export">
                <Download className="h-4 w-4 mr-2" /> Export Data
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setImportOpen(true)} data-testid="btn-import">
                <UploadCloud className="h-4 w-4 mr-2" /> Import Backup
              </DropdownMenuItem>
              {/* Dev/QA only (QA 2026-07-29 UX-002). "Show test data" mixes
                  synthetic suite rows into real money and health numbers with
                  no visual distinction, and the ChatGPT re-import is a one-off
                  migration tool — neither belongs in a normal user's menu.
                  See lib/dev-affordances.ts for how to enable them. */}
              {devTools && (
                <>
                  <DropdownMenuItem onClick={() => setChatgptImportOpen(true)} data-testid="btn-refresh-from-chatgpt">
                    <Sparkles className="h-4 w-4 mr-2" /> Refresh from ChatGPT
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => toggleShowTestData()} data-testid="btn-toggle-test-data">
                    <FlaskConical className="h-4 w-4 mr-2" /> {showTestData ? "Hide test data" : "Show test data"}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Focus mode switcher (Phase 5) — reweights which sections show + order.
          Hidden in Everyone/Household scope, where the layout is fixed and the
          modes would be inert ("these buttons don't work").
          Hub-embedded (2026-07-08, user request): hidden — it read as a
          duplicate of the hub tab row right above it, and the hub's
          Finance/Health tabs cover the focused views. Still available when
          the dashboard renders standalone. */}
      {!hubEmbedded && filterMode !== "everyone" && (
      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar -mx-0.5 px-0.5" data-testid="dashboard-mode-switcher">
        {(["executive", "finance", "health", "daily"] as DashMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => changeDashMode(m)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${dashMode === m ? "bg-primary text-primary-foreground" : "bg-muted/50 text-muted-foreground hover:bg-muted"}`}
            data-testid={`mode-${m}`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      )}

      {/* Import Dialog */}
      <Dialog open={importOpen} onOpenChange={(o) => { if (!o) setImporting(false); setImportOpen(o); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <UploadCloud className="h-4 w-4 text-primary" />
              Import Backup
            </DialogTitle>
            <DialogDescription className="text-xs">
              Restore profiles, finances, documents, tasks, habits, and trackers from a Portol export.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3">
            <Label htmlFor="import-file" className="cursor-pointer">
              <div className="border-2 border-dashed rounded-lg p-5 text-center hover:border-primary/50 hover:bg-muted/30 transition-colors">
                <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm font-medium">Click to select backup file</p>
                <p className="text-xs text-muted-foreground mt-1">JSON file from Portol's Export Data action</p>
              </div>
            </Label>
            <input id="import-file" type="file" accept=".json" className="hidden" onChange={handleImport} disabled={importing} />
          </div>
          {/* Format details */}
          <div className="space-y-1.5 text-[11px] text-muted-foreground border-t pt-2">
            <p className="font-medium text-foreground/80">What gets imported</p>
            <ul className="space-y-0.5 pl-3 list-disc">
              <li>Profiles (people, assets, pets, vehicles, properties, businesses)</li>
              <li>Finances — expenses, income, budgets, obligations</li>
              <li>Tasks, habits, goals, calendar events</li>
              <li>Documents, trackers, journal entries</li>
            </ul>
            <p className="pt-1 text-amber-500/90 flex items-start gap-1">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
              <span>Existing items with matching IDs may be overwritten. Export current data first as a safety backup.</span>
            </p>
          </div>
          {importing && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <span className="h-3 w-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-xs text-muted-foreground">Importing — please don't close this window…</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Import from ChatGPT */}
      <ChatGPTImportDialog open={chatgptImportOpen} onOpenChange={setChatgptImportOpen} />

      {/* Customize Dialog */}
      <CustomizeDialog open={customizeOpen} onOpenChange={setCustomizeOpen}
        sections={sections} onSave={(layout) => saveMutation.mutate(layout)} />

      {/* Render sections in order: full-width before grid, then 2-col grid, then full-width after grid.
          Swimlane group headers (💰 Money / 📅 Today / ❤️ Health) are emitted before the first
          section of each group, so the page visually segments into related clusters. */}
      {filterMode === "everyone" ? (
        (showDashSkeleton && !stats && dashLoadStuck) ? (
          <DashLoadTimeoutCard onRetry={retryDashboardLoad} />
        ) : (
        <HouseholdDashboard
          enhanced={enhanced}
          stats={stats}
          allProfiles={allProfiles}
          showSkeleton={showDashSkeleton && !stats}
          ready={bootstrapSettled}
        />
        )
      ) : (() => {
        const afterGridIds = new Set(["activity"]);
        const beforeGrid = fullWidthSections.filter(s => !afterGridIds.has(s.id));
        const afterGrid = fullWidthSections.filter(s => afterGridIds.has(s.id));
        // Track which swimlane group headers have been emitted across the whole page —
        // a group's header should render exactly once, before the first section in that
        // group, regardless of whether that section ends up in beforeGrid / grid / afterGrid.
        const emitted = new Set<string>();
        const groupOf = (id: string): typeof SWIMLANE_GROUPS[number] | null => {
          for (const g of SWIMLANE_GROUPS) if (g.ids.includes(id)) return g;
          return null;
        };
        const renderHeaderIfNeeded = (sectionId: string) => {
          const g = groupOf(sectionId);
          if (!g || emitted.has(g.key)) return null;
          emitted.add(g.key);
          // 2026-07-08 (user request): the "⚡ NOW / 📈 Trajectory" swimlane
          // labels are gone — the dense briefing's own colored section headers
          // carry the structure now. Group headers only appear for sections
          // the user re-enables via Customize BEYOND the default briefing.
          if (g.key === "now") return null;
          return (
            <div className="flex items-center gap-2 mt-3 mb-1 px-0.5" data-testid={`swimlane-${g.key}`}>
              <span className="text-base leading-none" aria-hidden="true">{g.emoji}</span>
              <span className="micro-label text-muted-foreground/80">{g.label}</span>
              <div className="flex-1 h-px bg-border/40" />
            </div>
          );
        };
        return (
          <>
            {beforeGrid.map(s => (
              <div key={s.id}>
                {renderHeaderIfNeeded(s.id)}
                {renderSection(s.id)}
              </div>
            ))}

            {(leftSections.length > 0 || rightSections.length > 0) && (() => {
              const interleaved: typeof leftSections = [];
              const maxLen = Math.max(leftSections.length, rightSections.length);
              for (let i = 0; i < maxLen; i++) {
                if (i < leftSections.length) interleaved.push(leftSections[i]);
                if (i < rightSections.length) interleaved.push(rightSections[i]);
              }
              // Emit any swimlane headers (e.g. "Today") that apply to the first
              // interleaved sections before opening the columns wrapper, so they
              // don't sit inside a masonry column where the divider line would break.
              const headerNodes: React.ReactNode[] = [];
              for (const s of interleaved) {
                const g = groupOf(s.id);
                if (g && !emitted.has(g.key)) {
                  emitted.add(g.key);
                  headerNodes.push(
                    <div key={`header-${g.key}`} className="flex items-center gap-2 mt-3 mb-1 px-0.5" data-testid={`swimlane-${g.key}`}>
                      <span className="text-base leading-none" aria-hidden="true">{g.emoji}</span>
                      <span className="micro-label text-muted-foreground/80">{g.label}</span>
                      <div className="flex-1 h-px bg-border/40" />
                    </div>
                  );
                }
              }
              return (
                <>
                  {headerNodes}
                  <div className="md:columns-2 md:gap-3 gap-3 mt-1">
                    {interleaved.map(s => (
                      <div key={s.id} className="mb-3" style={{ breakInside: 'avoid' }}>
                        {renderSection(s.id)}
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}

            {afterGrid.map(s => (
              <div key={s.id}>
                {renderHeaderIfNeeded(s.id)}
                {renderSection(s.id)}
              </div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
