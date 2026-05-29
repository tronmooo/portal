import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { parseMoney } from "@/lib/utils";
import { resolveAssetValue, resolveLiabilityBalance } from "@shared/asset-value";
import { goalsQueryKey } from "@shared/query-keys";
import { DrillDownDialog } from "@/components/DrillDownDialog";
import { getProfileFilter, setDashboardProfileFilter, subscribeProfileFilter, type FilterMode } from "@/lib/profileFilter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
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
  HeartPulse, ArrowUp, ArrowDown, Minus, FileWarning, CalendarClock,
  Download, UploadCloud, MoreVertical,
  EyeOff, GripVertical, Settings, RotateCcw, Target,
  Trash2, Pencil, FileText, CheckCircle2, X,
  ChevronLeft, ChevronRight, Plus, ShieldCheck,
  Wallet, PieChart as PieChartIcon, Settings2, AlertCircle, Bell, BellOff,
  Scale, Activity as ActivityIcon, Moon,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import type { DashboardStats, MoodLevel } from "@shared/schema";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { NetWorthPopup, CashFlowPopup, BudgetPopup } from "@/components/dashboard/HeroKPIPopups";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(n: number): string {
  return n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

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

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtDateWithYear(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function journalStreakLabel(streak: number): string {
  if (streak === 0) return "Start today";
  if (streak <= 2) return "Building";
  if (streak <= 6) return "Good";
  return "Great";
}

function daysUntilStr(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days}d`;
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
    <div data-testid={testId} className="rounded-xl border border-border/40 bg-card overflow-hidden transition-shadow hover:shadow-sm">
      <button
        className="w-full flex items-center gap-2.5 px-3 py-3 text-left transition-colors hover:bg-muted/30"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        data-testid={`btn-toggle-${label.toLowerCase().replace(/\s+/g, "-")}`}
        style={accent ? { background: `linear-gradient(135deg, hsl(${accent} / 0.06) 0%, transparent 50%)` } : {}}
      >
        <div className="icon-badge" style={iconBg ? { background: iconBg } : { background: 'hsl(var(--muted))' }}>
          <Icon className="h-3.5 w-3.5" style={iconColor ? { color: iconColor } : { color: 'hsl(var(--primary))' }} />
        </div>
        <h2 className="text-xs font-semibold tracking-wide uppercase" style={iconColor ? { color: iconColor } : {}}>{label}</h2>
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
      className={`relative flex flex-col p-2.5 rounded-xl border border-border/40 min-h-[72px] overflow-hidden card-lift ${
        onClick ? "cursor-pointer active:scale-[0.97] transition-all" : ""
      }`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      data-testid={`stat-card-${label.toLowerCase().replace(/\s+/g, "-")}`}
      style={accent ? { background: `linear-gradient(135deg, hsl(${accent} / 0.10) 0%, transparent 60%)` } : {}}
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
        <span className="text-lg font-bold metric-value tracking-tight leading-none" style={{ color: accentColor || "hsl(var(--foreground))" }}>{value}</span>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 leading-tight mt-0.5 truncate w-full relative z-10">{label}</p>
    </div>
  );
}

const MD_GRID_COLS: Record<number, string> = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4", 5: "md:grid-cols-5", 6: "md:grid-cols-6" };

function SkeletonGrid({ cols = 4, rows = 1, h = "h-14" }: { cols?: number; rows?: number; h?: string }) {
  return (
    <div className={`grid grid-cols-2 ${MD_GRID_COLS[cols] || "md:grid-cols-4"} gap-2`}>
      {Array.from({ length: cols * rows }).map((_, i) => (
        <Skeleton key={`skel-${i}`} className={`${h} rounded-lg`} />
      ))}
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
    <div onClick={onClick} className="relative flex flex-col p-2.5 rounded-xl border border-border/40 min-h-[80px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all"
      style={{ background: 'linear-gradient(135deg, hsl(262 65% 62% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-open-tasks">
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(262 65% 62%), transparent)' }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: 'hsl(262 65% 62% / 0.15)' }}>
          <ListTodo className="h-3.5 w-3.5" style={{ color: 'hsl(262 65% 62%)' }} />
        </div>
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-lg font-bold metric-value tracking-tight leading-none" style={{ color: 'hsl(262 65% 62%)' }}>{animatedCount}</span>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-0.5 relative z-10">Open Tasks</p>
      {/* Fill bar */}
      <div className="mt-1.5 relative z-10">
        <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${fillPct}%`, background: 'hsl(262 65% 62%)' }} />
        </div>
        <p className="text-[9px] text-muted-foreground/60 mt-0.5">{count} active</p>
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
    <div onClick={onClick} className="relative flex flex-col p-2.5 rounded-xl border border-border/40 min-h-[80px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all"
      style={{ background: 'linear-gradient(135deg, hsl(43 85% 52% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-monthly-spend">
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(43 85% 52%), transparent)' }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: 'hsl(43 85% 52% / 0.15)' }}>
          <DollarSign className="h-3.5 w-3.5" style={{ color: 'hsl(43 85% 52%)' }} />
        </div>
        <span className={`text-[10px] font-semibold ${trend === 'up' ? 'text-red-400' : trend === 'down' ? 'text-green-500' : 'text-muted-foreground'}`}>
          {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '—'}
        </span>
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-lg font-bold metric-value tracking-tight leading-none" style={{ color: 'hsl(43 85% 52%)' }}>${animatedAmount}</span>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-0.5 relative z-10">Monthly Spend</p>
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
    <div onClick={onClick} className="relative flex flex-col p-2.5 rounded-xl border border-border/40 min-h-[80px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all"
      style={{ background: 'linear-gradient(135deg, hsl(155 60% 44% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-habits-today">
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(155 60% 44%), transparent)' }} />
      <div className="flex items-start justify-between gap-2 relative z-10">
        <div>
          <div className="text-lg font-bold metric-value tracking-tight leading-none mt-1" style={{ color: 'hsl(155 60% 44%)' }}>{animatedPct}%</div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-0.5">Habits Today</p>
          <p className="text-[9px] text-muted-foreground/60">{totalHabits} tracked</p>
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
    <div onClick={onClick} className="relative flex flex-col p-2.5 rounded-xl border border-border/40 min-h-[80px] overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all"
      style={{ background: 'linear-gradient(135deg, hsl(310 50% 58% / 0.10) 0%, transparent 60%)' }}
      data-testid="stat-card-journal-streak">
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: 'linear-gradient(90deg, hsl(310 50% 58%), transparent)' }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: 'hsl(310 50% 58% / 0.15)' }}>
          <BookHeart className="h-3.5 w-3.5" style={{ color: moodConf?.color || 'hsl(310 50% 58%)' }} />
        </div>
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-lg font-bold metric-value tracking-tight leading-none" style={{ color: moodConf?.color || 'hsl(310 50% 58%)' }}>{animatedStreak}d</span>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-0.5 relative z-10">Journal Streak</p>
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
  // Color discipline: red ONLY for genuinely overdue documents. The ambient
  // tile color stays amber to keep visual weight balanced — the popup is where
  // the user takes action (snooze / open), so this tile no longer screams.
  const accent = isUrgent ? '0 72% 52%' : '25 80% 54%';
  return (
    <div onClick={onClick} className="relative flex flex-col p-2.5 rounded-xl border overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all"
      style={{ background: `linear-gradient(135deg, hsl(${accent} / 0.12) 0%, transparent 60%)`, borderColor: isUrgent ? 'hsl(0 72% 52% / 0.4)' : 'hsl(var(--border) / 0.4)' }}
      data-testid="stat-card-expiring-docs">
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: `linear-gradient(90deg, hsl(${accent}), transparent)` }} />
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: `hsl(${accent} / 0.15)` }}>
          <FileWarning className="h-3.5 w-3.5" style={{ color: `hsl(${accent})` }} />
        </div>
        {isUrgent && <span className="text-[9px] font-bold text-red-500 bg-red-500/10 px-1 py-0.5 rounded">{expiredCount} EXPIRED</span>}
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-lg font-bold metric-value tracking-tight leading-none tabular-nums" style={{ color: `hsl(${accent})` }}>{(docs || []).length}</span>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-0.5 relative z-10">Expiring Docs</p>
      {mostOverdue && (
        <p className="text-[9px] text-red-500 mt-0.5 relative z-10 truncate tabular-nums">
          Tap to snooze · {Math.abs(mostOverdue.daysUntil)}d overdue
        </p>
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

function HeroKPISection({ enhanced, stats, filterMode, filterIds }: {
  enhanced: any;
  stats: DashboardStats | undefined;
  filterMode: string;
  filterIds: string[];
}) {
  const [, navigate] = useLocation();
  const [heroPopup, setHeroPopup] = useState<"networth" | "cashflow" | "budget" | null>(null);
  const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const trailing = filterMode === "selected" && filterIds.length > 0 ? `&profileIds=${filterIds.join(",")}` : "";
  const leading = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // Round-6 fix (BUG-003/004/015): Hero KPI tile previously used
  // enhanced.financeSnapshot.totalAssetValue (server-computed) while the Finance
  // section tile and the Net Worth popup compute from allProfiles client-side.
  // That divergence produced the $10 / $11K drift the user reported. Pull from
  // the same /api/profiles cache the Net Worth popup uses so all three Net Worth
  // surfaces (Hero KPI, Finance section, Net Worth popup) agree to the dollar.
  const { data: allProfiles } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  // BUG-20260528-budget-keep-previous-leak: budgetSummary must NOT inherit the
  // previous filter's totals during a filter swap. Default queryClient has
  // placeholderData: keepPreviousData which made a fresh profile (Lexi, no
  // budgets, no expenses except $50) show "2% of $2,650" — the $2,650 came
  // from the prior Everyone/Self filter that was still cached. Setting
  // placeholderData: undefined here forces budgetSummary to show the loading
  // state during swap and snap to the correct $0 when the new query lands.
  const { data: budgetSummary } = useQuery<{ totalBudget: number; totalSpent: number; remaining: number }>({
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
  const { data: incomesRaw } = useQuery<any[]>({
    queryKey: ["/api/incomes", filterMode, ...filterIds, "hero"],
    queryFn: () => apiRequest("GET", `/api/incomes${leading}`).then(r => r.json()),
    staleTime: 60_000,
    placeholderData: undefined,
  });
  const incomes = Array.isArray(incomesRaw) ? incomesRaw : (incomesRaw as any)?.items || [];

  // Filter helper shared by asset + liability roll-ups. Mirrors the predicate
  // used by the Finance section tile (lines 2939-2950) so the three Net Worth
  // surfaces stay in lock-step. While allProfiles is still loading we fall
  // back to financeSnapshot to avoid a $0 flash.
  const matchesProfileFilter = (p: any): boolean => {
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const pParent = p?.parentProfileId;
    if (pParent && filterIds.includes(pParent)) return true;
    if (filterIds.includes(p?.id)) return true;
    return false;
  };
  const heroAssetProfiles = useMemo(
    () => (allProfiles || []).filter((p: any) => resolveAssetValue(p) > 0 && matchesProfileFilter(p)),
    [allProfiles, filterMode, filterIds.join(",")]
  );
  const heroLiabilityProfiles = useMemo(
    () => (allProfiles || []).filter((p: any) => resolveLiabilityBalance(p) > 0 && matchesProfileFilter(p)),
    [allProfiles, filterMode, filterIds.join(",")]
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
  const totalAssetValue = filterActive
    ? (enhanced?.financeSnapshot?.totalAssetValue ?? heroAssetProfiles.reduce((s, p) => s + resolveAssetValue(p), 0))
    : allProfiles
      ? heroAssetProfiles.reduce((s, p) => s + resolveAssetValue(p), 0)
      : (enhanced?.financeSnapshot?.totalAssetValue ?? 0);
  const totalLiabilities = filterActive
    ? (enhanced?.financeSnapshot?.totalLiabilities ?? heroLiabilityProfiles.reduce((s, p) => s + resolveLiabilityBalance(p), 0))
    : allProfiles
      ? heroLiabilityProfiles.reduce((s, p) => s + resolveLiabilityBalance(p), 0)
      : (enhanced?.financeSnapshot?.totalLiabilities ?? 0);
  const netWorth = totalAssetValue - totalLiabilities;
  const monthlySpend = enhanced?.financeSnapshot?.totalMonthlySpend ?? stats?.monthlySpend ?? 0;
  const monthlyIncome = incomes.reduce((s: number, i: any) => s + (i.amount || 0), 0);
  const cashFlow = monthlyIncome - monthlySpend;
  const totalBudget = budgetSummary?.totalBudget ?? 0;
  const totalSpent = budgetSummary?.totalSpent ?? 0;
  const budgetPct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  const budgetBreached = budgetPct > 100;

  const animatedNetWorth = useCountUp(Math.max(0, Math.round(netWorth)));
  const animatedBudget = useCountUp(budgetPct);
  const animatedCashFlow = useCountUp(Math.round(Math.abs(cashFlow)));

  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mb-2">
      {/* NET WORTH */}
      <button
        type="button"
        onClick={() => setHeroPopup("networth")}
        className="relative flex flex-col p-4 rounded-2xl border border-border/50 overflow-hidden text-left card-lift active:scale-[0.98] transition-all min-h-[112px]"
        style={{ background: 'linear-gradient(135deg, hsl(155 60% 44% / 0.16) 0%, hsl(155 60% 44% / 0.04) 60%, transparent 100%)' }}
        data-testid="hero-kpi-net-worth"
      >
        <div className="absolute top-0 left-0 right-0" style={{ height: 3, background: 'linear-gradient(90deg, hsl(155 60% 44%), transparent)' }} />
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="icon-badge" style={{ background: 'hsl(155 60% 44% / 0.18)' }}>
              <Wallet className="h-4 w-4" style={{ color: 'hsl(155 60% 44%)' }} />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">Net Worth</span>
          </div>
        </div>
        <div className="flex items-baseline gap-1 tabular-nums">
          <span className="text-3xl font-bold tracking-tight" style={{ color: 'hsl(155 60% 44%)' }}>${fmt(animatedNetWorth)}</span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground/80 tabular-nums">
          <span>Assets ${fmt(Math.round(totalAssetValue))}</span>
          <span>·</span>
          <span>Liab ${fmt(Math.round(totalLiabilities))}</span>
        </div>
      </button>

      {/* BUDGET */}
      <button
        type="button"
        onClick={() => setHeroPopup("budget")}
        className="relative flex flex-col p-4 rounded-2xl border overflow-hidden text-left card-lift active:scale-[0.98] transition-all min-h-[112px]"
        style={{
          background: budgetBreached
            ? 'linear-gradient(135deg, hsl(0 72% 52% / 0.18) 0%, hsl(0 72% 52% / 0.04) 60%, transparent 100%)'
            : 'linear-gradient(135deg, hsl(43 85% 52% / 0.16) 0%, hsl(43 85% 52% / 0.04) 60%, transparent 100%)',
          borderColor: budgetBreached ? 'hsl(0 72% 52% / 0.4)' : 'hsl(var(--border) / 0.5)',
        }}
        data-testid="hero-kpi-budget"
      >
        <div className="absolute top-0 left-0 right-0" style={{ height: 3, background: budgetBreached ? 'linear-gradient(90deg, hsl(0 72% 52%), transparent)' : 'linear-gradient(90deg, hsl(43 85% 52%), transparent)' }} />
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="icon-badge" style={{ background: budgetBreached ? 'hsl(0 72% 52% / 0.18)' : 'hsl(43 85% 52% / 0.18)' }}>
              <PieChartIcon className="h-4 w-4" style={{ color: budgetBreached ? 'hsl(0 72% 52%)' : 'hsl(43 85% 52%)' }} />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">Budget</span>
          </div>
          {budgetBreached && (
            <span className="text-[9px] font-bold text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded">OVER</span>
          )}
        </div>
        <div className="flex items-baseline gap-1 tabular-nums">
          <span className="text-3xl font-bold tracking-tight" style={{ color: budgetBreached ? 'hsl(0 72% 52%)' : 'hsl(43 85% 52%)' }}>{animatedBudget}%</span>
          <span className="text-xs text-muted-foreground/70">of ${fmt(totalBudget)}</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'hsl(var(--muted) / 0.6)' }}>
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(100, budgetPct)}%`,
              background: budgetBreached ? 'hsl(0 72% 52%)' : budgetPct >= 80 ? 'hsl(43 85% 52%)' : 'hsl(155 60% 44%)',
            }}
          />
        </div>
      </button>

      {/* CASH FLOW */}
      <button
        type="button"
        onClick={() => setHeroPopup("cashflow")}
        className="relative flex flex-col p-4 rounded-2xl border border-border/50 overflow-hidden text-left card-lift active:scale-[0.98] transition-all min-h-[112px]"
        style={{
          background: cashFlow >= 0
            ? 'linear-gradient(135deg, hsl(200 70% 55% / 0.16) 0%, hsl(200 70% 55% / 0.04) 60%, transparent 100%)'
            : 'linear-gradient(135deg, hsl(43 85% 52% / 0.16) 0%, hsl(43 85% 52% / 0.04) 60%, transparent 100%)',
        }}
        data-testid="hero-kpi-cash-flow"
      >
        <div className="absolute top-0 left-0 right-0" style={{ height: 3, background: cashFlow >= 0 ? 'linear-gradient(90deg, hsl(200 70% 55%), transparent)' : 'linear-gradient(90deg, hsl(43 85% 52%), transparent)' }} />
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <div className="icon-badge" style={{ background: cashFlow >= 0 ? 'hsl(200 70% 55% / 0.18)' : 'hsl(43 85% 52% / 0.18)' }}>
              <TrendingUp className="h-4 w-4" style={{ color: cashFlow >= 0 ? 'hsl(200 70% 55%)' : 'hsl(43 85% 52%)' }} />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">Cash Flow</span>
          </div>
        </div>
        <div className="flex items-baseline gap-1 tabular-nums">
          <span className="text-3xl font-bold tracking-tight" style={{ color: cashFlow >= 0 ? 'hsl(200 70% 55%)' : 'hsl(43 85% 52%)' }}>
            {cashFlow >= 0 ? '+' : '−'}${fmt(animatedCashFlow)}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground/80 tabular-nums">
          <span>In ${fmt(Math.round(monthlyIncome))}</span>
          <span>·</span>
          <span>Out ${fmt(Math.round(monthlySpend))}</span>
        </div>
      </button>

      {/* Hero KPI Popups */}
      <NetWorthPopup
        open={heroPopup === "networth"}
        onOpenChange={(o) => setHeroPopup(o ? "networth" : null)}
        filterMode={(filterMode as "all" | "selected" | "everyone")}
        filterIds={filterIds}
      />
      <CashFlowPopup
        open={heroPopup === "cashflow"}
        onOpenChange={(o) => setHeroPopup(o ? "cashflow" : null)}
        filterMode={(filterMode as "all" | "selected" | "everyone")}
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

// localStorage helpers for per-document 30-day snooze. Keeps the implementation
// client-side so we don't need a new schema field. Values are { docId: expiry-ms }
// and entries that have passed their expiry are dropped on read.
const DOC_SNOOZE_LS_KEY = "portol_doc_snooze_v1";
function loadDocSnoozeMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DOC_SNOOZE_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    let dirty = false;
    for (const k of Object.keys(parsed)) {
      if (parsed[k] <= now) { delete parsed[k]; dirty = true; }
    }
    if (dirty) localStorage.setItem(DOC_SNOOZE_LS_KEY, JSON.stringify(parsed));
    return parsed;
  } catch { return {}; }
}
function saveDocSnoozeMap(m: Record<string, number>) {
  try { localStorage.setItem(DOC_SNOOZE_LS_KEY, JSON.stringify(m)); } catch {}
}

function KPISection({ stats, enhanced, filterIds = [], filterMode = "everyone" }: { stats: DashboardStats; enhanced: any; filterIds?: string[]; filterMode?: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [popup, setPopup] = useState<"spending" | "bills" | "tasks" | "docs" | "habits" | null>(null);
  const [docSnoozeMap, setDocSnoozeMap] = useState<Record<string, number>>(() => loadDocSnoozeMap());
  const snoozeDoc = (docId: string) => {
    const next = { ...docSnoozeMap, [docId]: Date.now() + 30 * 86400000 };
    setDocSnoozeMap(next);
    saveDocSnoozeMap(next);
    toast({ title: "Document snoozed", description: "Hidden from alerts for 30 days" });
  };
  const visibleDocs: any[] = useMemo(() => {
    return (enhanced?.expiringDocuments || []).filter((d: any) => !docSnoozeMap[d.documentId]);
  }, [enhanced, docSnoozeMap]);

  if (!stats) return null;

  const finSnap = enhanced?.financeSnapshot;
  const spendTrend: "up" | "down" | "flat" = finSnap?.spendTrend > 0 ? "up" : finSnap?.spendTrend < 0 ? "down" : "flat";

  const moodConf = stats.currentMood ? MOOD_CONFIG[stats.currentMood] : null;

  return (
    <>
      <div className="rounded-xl border border-border/40 bg-card/50 backdrop-blur-sm px-2 py-2" data-testid="section-kpis">
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
          <KPITaskCard count={stats.activeTasks} onClick={() => setPopup("tasks")} />
          {/* Bug fix: prefer financeSnapshot.totalMonthlySpend (same source as the drilldown popup)
               over stats.monthlySpend (/api/stats) so the KPI card and popup show identical totals. */}
          <KPISpendCard amount={enhanced?.financeSnapshot?.totalMonthlySpend ?? stats?.monthlySpend ?? 0} trend={spendTrend} enhanced={enhanced} onClick={() => setPopup("spending")} />
          <KPIHabitsCard completionPct={stats.habitCompletionRate} totalHabits={stats.totalHabits} onClick={() => setPopup("habits")} />
          <KPIJournalCard streak={stats.journalStreak} mood={stats.currentMood || null} onClick={() => navigate("/dashboard/journal")} />
          {/* Bug fix: derive bill count from the same enhanced.financeSnapshot.upcomingBills
               array the popup renders, so the count on the KPI card always matches the
               number of rows shown in the drilldown. Falls back to the legacy stats field
               for the brief window before /api/dashboard-enhanced resolves. */}
          <MiniStat accent="43 75% 50%" icon={CreditCard} label="Bills Due"
            value={enhanced?.financeSnapshot?.upcomingBills?.length ?? stats.upcomingObligations}
            sub={formatMoney(stats.monthlyObligationTotal) + "/mo"}
            onClick={() => setPopup("bills")} />
          <KPIDocsCard docs={visibleDocs} onClick={() => setPopup("docs")} />
        </div>
      </div>

      {/* Spending Breakdown Popup */}
      <Dialog open={popup === "spending"} onOpenChange={(o) => { if (!o) setPopup(null); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Spending Breakdown</DialogTitle>
            <DialogDescription className="text-xs">This month's expenses by category</DialogDescription>
          </DialogHeader>
          {(() => {
            const categories = finSnap?.spendByCategory
              ? Object.entries(finSnap.spendByCategory as Record<string, number>).sort(([a], [b]) => a.localeCompare(b))
              : [];
            const total = finSnap?.totalMonthlySpend || 0;
            const SPEND_COLORS = ["#06b6d4","#8b5cf6","#f59e0b","#10b981","#ef4444","#3b82f6","#f97316","#ec4899","#84cc16","#6366f1"];
            return (
              <div className="space-y-1.5 py-2">
                {categories.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No expenses this month</p>}
                {categories.map(([cat, amt], i) => {
                  const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
                  const color = SPEND_COLORS[i % SPEND_COLORS.length];
                  return (
                    <div key={cat} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                          <span className="text-xs capitalize">{cat}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{pct}%</span>
                          <span className="text-xs font-semibold tabular-nums w-16 text-right">{formatMoney(amt)}</span>
                        </div>
                      </div>
                      <div className="h-1 rounded-full bg-muted/50 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                      </div>
                    </div>
                  );
                })}
                {categories.length > 0 && (
                  <div className="flex items-center justify-between pt-2 border-t">
                    <span className="text-xs font-semibold">Total</span>
                    <span className="text-sm font-bold tabular-nums">{formatMoney(total)}</span>
                  </div>
                )}
                {finSnap?.lastMonthTotal > 0 && (
                  <p className="text-xs text-muted-foreground">
                    vs last month: {formatMoney(finSnap.lastMonthTotal)}
                    <span className={`ml-1 font-medium ${finSnap.spendTrend > 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {finSnap.spendTrend > 0 ? '+' : ''}{finSnap.spendTrend}%
                    </span>
                  </p>
                )}
              </div>
            );
          })()}
          <ViewPageLink href="/dashboard/finance" label="View Finance Page" />
        </DialogContent>
      </Dialog>

      {/* Bills Popup */}
      <Dialog open={popup === "bills"} onOpenChange={(o) => { if (!o) setPopup(null); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Upcoming Bills</DialogTitle>
            <DialogDescription className="text-xs">Bills due in the next 30 days</DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '50vh' }}>
            <div className="space-y-1.5 py-2">
              {(finSnap?.upcomingBills || []).slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((bill: any) => {
                const urgent = bill.daysUntil <= 3;
                const soon = bill.daysUntil <= 7;
                return (
                  <div key={bill.id}
                    className={`flex items-center justify-between p-2 rounded-lg border ${urgent ? "border-red-500/30 bg-red-500/5" : soon ? "border-amber-500/30 bg-amber-500/5" : "border-border/50"}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{bill.name}</p>
                      <p className={`text-xs ${urgent ? "text-red-500" : soon ? "text-amber-500" : "text-muted-foreground"}`}>
                        {daysUntilStr(bill.daysUntil)}
                        {bill.autopay && <span className="ml-1 text-green-500">• autopay</span>}
                      </p>
                    </div>
                    <span className="text-xs font-semibold tabular-nums shrink-0">{formatMoney(bill.amount)}</span>
                  </div>
                );
              })}
              {(!finSnap?.upcomingBills || finSnap.upcomingBills.length === 0) && (
                <p className="text-xs text-muted-foreground text-center py-4">No upcoming bills</p>
              )}
            </div>
          </div>
          <ViewPageLink href="/dashboard/obligations" label="View All Obligations" />
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
              Expiring Documents
              <Badge variant="secondary" className="ml-1 tabular-nums">{visibleDocs.length}</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs">Documents with upcoming or past expiration dates. Snooze to hide for 30 days.</DialogDescription>
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
                      onClick={() => { setPopup(null); navigate(`/documents/${doc.documentId}`); }}
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
                        {expired ? "Expired" : expiringSoon ? "Soon" : "Upcoming"}
                      </Badge>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); snoozeDoc(doc.documentId); }}
                      title="Hide for 30 days"
                      className="h-6 px-1.5 rounded text-[10px] font-semibold flex items-center gap-0.5 bg-muted/60 hover:bg-muted text-muted-foreground shrink-0"
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
                  <p className="text-xs text-muted-foreground">No expiring documents</p>
                </div>
              )}
            </div>
          </div>
          <ViewPageLink href="/dashboard/documents" label="View All Documents" />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Tasks Popup ──────────────────────────────────────────────────────────────

// U1 fix forward declaration: TasksPopup uses a confirmation AlertDialog before
// permanently deleting a completed task. State held inside the component.
function TasksPopup({ open, onClose, filterIds = [], filterMode = "everyone" }: { open: boolean; onClose: () => void; filterIds?: string[]; filterMode?: string }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [addingTo, setAddingTo] = useState<string | null>(null);
  // U1 fix: track which task is pending confirmation before delete.
  const [taskToDelete, setTaskToDelete] = useState<{ id: string; title: string } | null>(null);
  // Force refetch when popup opens — prevents stale cache after AI chat mutations
  useEffect(() => { if (open) { queryClient.invalidateQueries({ queryKey: ["/api/tasks"] }); } }, [open]);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: tasks = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/tasks", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/tasks${profileParam}`).then(r => r.json()),
    enabled: open,
  });

  const createMutation = useMutation({
    mutationFn: (title: string) => apiRequest("POST", "/api/tasks", { title, priority: "medium", status: "todo" }),
    onMutate: async (title) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      const prev = queryClient.getQueryData(["/api/tasks", filterMode, ...filterIds]);
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) =>
        [{ id: 'tmp-' + Date.now(), title, status: 'todo', priority: 'medium' }, ...(old || [])]
      );
      return { prev };
    },
    onError: (_e, _v, ctx: any) => {
      if (ctx?.prev) {
        queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      } else {
        queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) => old?.filter((t: any) => !String(t.id).startsWith('tmp-')));
      }
      toast({ title: "Failed to create task", variant: "destructive" });
    },
    onSettled: () => { invalidateDomain("tasks"); toast({ title: "Task added" }); },
  });

  // ─ Helper: optimistically adjust stats.activeTasks & dashboard-enhanced ─
  // The KPI tile (Open Tasks) and the popup pull from different queries.
  // To make the chip flip instantly when you check a task off, we patch
  // both /api/stats and /api/dashboard-enhanced in the cache BEFORE the
  // server roundtrip resolves. Server data wins on next refetch.
  const patchStatsTaskDelta = (delta: number) => {
    const statsKey = ["/api/stats", filterMode, ...filterIds];
    queryClient.setQueryData<any>(statsKey, (old: any) => {
      if (!old) return old;
      const next = Number(old.activeTasks || 0) + delta;
      return { ...old, activeTasks: Math.max(0, next) };
    });
    const dashKey = ["/api/dashboard-enhanced", filterMode, ...filterIds];
    queryClient.setQueryData<any>(dashKey, (old: any) => {
      if (!old || !old.taskSnapshot) return old;
      const open = Math.max(0, Number(old.taskSnapshot.open || 0) + delta);
      return { ...old, taskSnapshot: { ...old.taskSnapshot, open } };
    });
  };

  const toggleMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string; title?: string }) => apiRequest("PATCH", `/api/tasks/${id}`, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks", filterMode, ...filterIds] });
      const prev = queryClient.getQueryData<any[]>(["/api/tasks", filterMode, ...filterIds]);
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      const prevDash = queryClient.getQueryData<any>(["/api/dashboard-enhanced", filterMode, ...filterIds]);
      // Update the task list itself
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) =>
        (old || []).map((t: any) => t.id === id ? { ...t, status } : t)
      );
      // Compute the active-task delta from the PREVIOUS state so toggling
      // back and forth always adjusts correctly.
      const prevTask = (prev || []).find(t => t.id === id);
      const wasDone = String(prevTask?.status || "").toLowerCase() === "done";
      const isDone = String(status).toLowerCase() === "done";
      if (wasDone !== isDone) {
        patchStatsTaskDelta(isDone ? -1 : +1);
      }
      return { prev, prevStats, prevDash };
    },
    onError: (_e, _v, ctx: any) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      if (ctx?.prevDash !== undefined) queryClient.setQueryData(["/api/dashboard-enhanced", filterMode, ...filterIds], ctx.prevDash);
      toast({ title: "Failed to update task", variant: "destructive" });
    },
    onSettled: (_d, _e, variables) => {
      invalidateDomain("tasks");
      toast({ title: variables.status === 'done' ? "Task completed" : "Task updated" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest("DELETE", `/api/tasks/${id}`),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks", filterMode, ...filterIds] });
      const prev = queryClient.getQueryData<any[]>(["/api/tasks", filterMode, ...filterIds]);
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      const prevDash = queryClient.getQueryData<any>(["/api/dashboard-enhanced", filterMode, ...filterIds]);
      const removed = (prev || []).find(t => t.id === id);
      queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], (old: any[]) => (old || []).filter((t: any) => t.id !== id));
      // If the deleted task was open, drop the active-task count too
      if (removed && String(removed.status || "").toLowerCase() !== "done") {
        patchStatsTaskDelta(-1);
      }
      return { prev, prevStats, prevDash };
    },
    onError: (_e, _v, ctx: any) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(["/api/tasks", filterMode, ...filterIds], ctx.prev);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      if (ctx?.prevDash !== undefined) queryClient.setQueryData(["/api/dashboard-enhanced", filterMode, ...filterIds], ctx.prevDash);
      toast({ title: "Failed to delete task", variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("tasks");
      toast({ title: "Task deleted" });
    },
  });

  const todayStr = new Date().toLocaleDateString('en-CA');
  const tomorrowStr = (() => { const d = new Date(); d.setDate(d.getDate()+1); return d.toLocaleDateString('en-CA'); })();
  const pending = useMemo(() => tasks.filter((t: any) => normalizeFilter(t.status) !== normalizeFilter('done')), [tasks]);
  const done = useMemo(() => tasks.filter((t: any) => normalizeFilter(t.status) === normalizeFilter('done')).slice(0, 5), [tasks]);
  const todayTasks = useMemo(() => pending.filter((t: any) => !t.dueDate || t.dueDate <= todayStr), [pending, todayStr]);
  const tomorrowTasks = useMemo(() => pending.filter((t: any) => t.dueDate === tomorrowStr), [pending, tomorrowStr]);
  const upcomingTasks = useMemo(() => pending.filter((t: any) => t.dueDate && t.dueDate > tomorrowStr), [pending, tomorrowStr]);

  // Priority color lines — exact Any.do style
  const PLINE: Record<string, string> = { high: '#E53935', medium: '#FFA726', low: '#42A5F5' };

  const handleAdd = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const title = newTaskTitle.trim();
    if (!title) return;
    createMutation.mutate(title);
    setNewTaskTitle("");
    setAddingTo(null);
  };

  const TaskRow = ({ t, dimmed = false }: { t: any; dimmed?: boolean }) => (
    <div className={`flex items-start gap-3 px-4 py-2.5 ${dimmed ? 'opacity-50' : 'hover:bg-muted/30'} transition-colors`}>
      <button
        onClick={() => toggleMutation.mutate({ id: t.id, status: dimmed ? 'todo' : 'done' })}
        className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center touch-manipulation"
        aria-label={dimmed ? "Mark as not done" : "Mark as done"}
        title={dimmed ? "Mark as not done" : "Mark as done"}
      >
        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${dimmed ? 'bg-muted-foreground/20 border-muted-foreground/30' : 'border-muted-foreground/40 hover:border-primary'}`}>
          {dimmed && <Check className="h-3 w-3 text-muted-foreground/50" strokeWidth={3} />}
        </div>
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${dimmed ? 'line-through text-muted-foreground' : 'text-foreground'} truncate`}>{t.title}</p>
        {/* Priority color line — Any.do style */}
        {!dimmed && t.priority && (
          <div className="h-[2.5px] w-7 rounded-full mt-1" style={{ backgroundColor: PLINE[t.priority] || '#42A5F5' }} />
        )}
        {t.dueDate && t.dueDate !== todayStr && !dimmed && (
          <span className="text-[10px] text-muted-foreground mt-0.5 block">{fmtDate(t.dueDate)}</span>
        )}
      </div>
      {dimmed && (
        <button
          onClick={() => setTaskToDelete({ id: t.id, title: t.title })}
          disabled={deleteMutation.isPending}
          className="shrink-0 mt-0.5 text-muted-foreground/40 hover:text-destructive touch-manipulation min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-40"
          aria-label="Delete task permanently"
          title="Delete task permanently"
          data-testid={`btn-delete-task-${t.id}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  const SectionHeader = ({ label, section }: { label: string; section: string }) => (
    <div className="flex items-center justify-between px-4 pt-3 pb-1">
      <span className="font-bold text-base text-foreground">{label}</span>
      <button onClick={() => setAddingTo(section)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-muted transition-colors" data-testid={`button-add-to-${section}`}>
        <Plus className="h-4 w-4 text-muted-foreground" />
      </button>
    </div>
  );

  const AddRow = ({ section }: { section: string }) => addingTo === section ? (
    <div className="px-4 py-2">
      <input
        autoFocus
        data-testid={`input-new-task-${section}`}
        className="w-full text-sm bg-muted/40 border border-border rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
        placeholder="I want to..."
        value={newTaskTitle}
        onChange={e => setNewTaskTitle(e.target.value)}
        onKeyDown={handleAdd}
        onBlur={() => { if (!newTaskTitle.trim()) setAddingTo(null); }}
      />
    </div>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { onClose(); setAddingTo(null); setNewTaskTitle(""); } }}>
      <DialogContent hideCloseButton className="w-[calc(100vw-16px)] sm:max-w-sm flex flex-col p-0 gap-0 rounded-2xl max-h-[85vh] overflow-y-auto">
        {/* Any.do header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-sm bg-red-500 flex items-center justify-center">
              <Check className="h-4 w-4 text-white" strokeWidth={3} />
            </div>
            <span className="font-bold text-sm uppercase tracking-wide text-foreground">All Tasks</span>
            <Badge variant="secondary">{pending.length}</Badge>
          </div>
          <DialogClose className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted active:bg-muted/80 transition-colors text-muted-foreground">
            <X className="h-5 w-5" />
          </DialogClose>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '65vh' }}>
          {isLoading ? (
            <div className="p-4 space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
          ) : (
            <div className="pb-4">
              {/* TODAY */}
              <SectionHeader label="Today" section="today" />
              <AddRow section="today" />
              {todayTasks.length === 0 && !addingTo && (
                <p className="text-sm text-muted-foreground px-4 py-2">Nothing due today</p>
              )}
              {todayTasks.map((t: any) => <TaskRow key={t.id} t={t} />)}

              {/* Completed (grayed, strikethrough) */}
              {done.length > 0 && (
                <>
                  <div className="my-1 mx-4 border-t border-border/30" />
                  {done.map((t: any) => <TaskRow key={t.id} t={t} dimmed />)}
                </>
              )}

              {/* TOMORROW */}
              {(tomorrowTasks.length > 0 || addingTo === 'tomorrow') && (
                <>
                  <SectionHeader label="Tomorrow" section="tomorrow" />
                  <AddRow section="tomorrow" />
                  {tomorrowTasks.map((t: any) => <TaskRow key={t.id} t={t} />)}
                </>
              )}

              {/* UPCOMING */}
              <SectionHeader label="Upcoming" section="upcoming" />
              <AddRow section="upcoming" />
              {upcomingTasks.length === 0 && !addingTo && (
                <p className="text-sm text-muted-foreground px-4 py-2">No upcoming tasks</p>
              )}
              {upcomingTasks.map((t: any) => <TaskRow key={t.id} t={t} />)}
            </div>
          )}
        </div>

        {/* Bottom input — Any.do "I want to..." bar */}
        <div className="border-t border-border/30 px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <ListTodo className="h-4 w-4 text-primary" />
          </div>
          <input
            className="flex-1 text-sm bg-transparent focus:outline-none text-muted-foreground placeholder:text-muted-foreground/60"
            placeholder="I want to..."
            data-testid="input-quick-task"
            value={addingTo === 'quick' ? newTaskTitle : ''}
            onChange={e => { setNewTaskTitle(e.target.value); setAddingTo('quick'); }}
            onKeyDown={handleAdd}
            onFocus={() => setAddingTo('quick')}
          />
        </div>
      </DialogContent>
      {/* U1 fix: confirmation dialog for the task delete — prevents accidental loss
          when the dimmed completed-task X is hover-clicked. */}
      <AlertDialog open={taskToDelete !== null} onOpenChange={(open) => { if (!open) setTaskToDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              {taskToDelete ? `“${taskToDelete.title}” will be permanently removed.` : "This task will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (taskToDelete) deleteMutation.mutate({ id: taskToDelete.id });
                setTaskToDelete(null);
              }}
              data-testid="btn-confirm-delete-task"
            >Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function HabitsPopup({ open, onClose, filterIds = [], filterMode = "everyone" }: { open: boolean; onClose: () => void; filterIds?: string[]; filterMode?: string }) {
  const { toast } = useToast();
  const today = new Date().toLocaleDateString('en-CA');
  const [, navigate] = useLocation();
  const [addingHabit, setAddingHabit] = useState(false);
  const [newHabitName, setNewHabitName] = useState('');
  // Force refetch when popup opens — prevents stale cache after AI chat mutations
  useEffect(() => { if (open) { queryClient.invalidateQueries({ queryKey: ["/api/habits"] }); } }, [open]);

  const createHabitMutation = useMutation({
    mutationFn: (name: string) => apiRequest('POST', '/api/habits', { name, frequency: 'daily' }),
    onSuccess: () => {
      setNewHabitName(''); setAddingHabit(false);
      queryClient.invalidateQueries({ queryKey: ['/api/habits'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard-enhanced'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stats'] });
      toast({ title: 'Habit created' });
    },
    onError: () => toast({ title: 'Failed to create habit', variant: 'destructive' }),
  });

  const habitsProfileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: habits = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/habits", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/habits${habitsProfileParam}`).then(r => r.json()),
    enabled: open,
  });

  // Optimistically bump stats.habitCompletionRate so the dashboard
  // donut ring jumps to 100% the instant the user marks every habit
  // done, instead of waiting on the server roundtrip.
  const recomputeStatsHabitRate = (habitsList: any[]) => {
    if (!habitsList || habitsList.length === 0) return;
    const total = habitsList.filter((h: any) => !h.archivedAt).length;
    if (total === 0) return;
    const completed = habitsList.filter((h: any) =>
      !h.archivedAt && (h.checkins || []).some((c: any) => c.date === today)
    ).length;
    const pct = Math.round((completed / total) * 100);
    const statsKey = ["/api/stats", filterMode, ...filterIds];
    queryClient.setQueryData<any>(statsKey, (old: any) => {
      if (!old) return old;
      return { ...old, habitCompletionRate: pct, totalHabits: total };
    });
  };

  const checkinMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest("POST", `/api/habits/${id}/checkin`, { date: today }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/habits"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/habits"] });
      const prevStats = queryClient.getQueryData<any>(["/api/stats", filterMode, ...filterIds]);
      // Optimistically add today's check-in to the habit.
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/habits"] }, (old) =>
        (old || []).map((h: any) => h.id === id
          ? { ...h, checkins: [...(h.checkins || []), { date: today, id: 'tmp-' + Date.now() }] }
          : h)
      );
      // Recompute completion% from the (now-updated) cache.
      const updated = queryClient.getQueryData<any[]>(["/api/habits", filterMode, ...filterIds]);
      if (updated) recomputeStatsHabitRate(updated);
      return { prev, prevStats };
    },
    onError: (_e: any, _v: any, ctx: any) => {
      if (ctx?.prev) for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      if (ctx?.prevStats !== undefined) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], ctx.prevStats);
      toast({ title: "Failed to check in habit", variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("habits");
      toast({ title: "Habit checked in" });
    },
  });

  const active = useMemo(() => habits.filter((h: any) => !h.archivedAt), [habits]);
  const VIVID = ['#6C5CE7','#E84393','#E55353','#F6A623','#2ECC71','#3498DB','#E67E22','#9B59B6','#1ABC9C','#E74C3C'];

  // Group by category if available, else default group
  const grouped = useMemo(() => {
    const g: Record<string, any[]> = {};
    active.forEach((h: any) => {
      const cat = (h as any).category || h.group || 'Daily';
      if (!g[cat]) g[cat] = [];
      g[cat].push(h);
    });
    return g;
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { onClose(); setAddingHabit(false); setNewHabitName(''); } }}>
      <DialogContent hideCloseButton className="w-[calc(100vw-16px)] sm:max-w-sm flex flex-col p-0 gap-0 rounded-2xl max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border/40">
          <span className="font-bold text-base text-foreground">Today's Habits</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setAddingHabit(v => !v)}
              className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors ${
                addingHabit ? 'bg-primary text-primary-foreground' : 'hover:bg-muted active:bg-muted/80 text-muted-foreground'
              }`}
            >
              <Plus className="h-5 w-5" />
            </button>
            <DialogClose className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted active:bg-muted/80 transition-colors text-muted-foreground">
              <X className="h-5 w-5" />
            </DialogClose>
          </div>
        </div>

        {/* Inline add habit form */}
        {addingHabit && (
          <div className="px-3 pt-3 pb-1">
            <div className="flex gap-2">
              <input
                autoFocus
                className="flex-1 text-sm bg-muted/40 border border-border rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground/50"
                placeholder="New habit name (e.g. Drink water)..."
                value={newHabitName}
                onChange={e => setNewHabitName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newHabitName.trim()) createHabitMutation.mutate(newHabitName.trim());
                  if (e.key === 'Escape') { setAddingHabit(false); setNewHabitName(''); }
                }}
              />
              <button
                onClick={() => newHabitName.trim() && createHabitMutation.mutate(newHabitName.trim())}
                disabled={!newHabitName.trim() || createHabitMutation.isPending}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-semibold disabled:opacity-40 shrink-0"
              >
                {createHabitMutation.isPending ? '...' : 'Add'}
              </button>
            </div>
          </div>
        )}

        {/* Native scroll — NOT ScrollArea (broken on iOS Safari in dialogs) */}
        <div className="flex-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch', maxHeight: '70vh' }}>
          {isLoading ? (
            <div className="px-3 space-y-2 py-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-14 rounded-2xl" />)}</div>
          ) : active.length === 0 ? (
            <div className="py-10 text-center px-4">
              <Flame className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">No habits tracked yet</p>
              <Button onClick={() => setAddingHabit(true)}>Add your first habit</Button>
            </div>
          ) : (
            <div className="px-3 pb-4">
              {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([category, items]) => (
                <div key={category}>
                  {/* Category header — orange text like Habituator */}
                  <div className="flex items-center gap-2 py-2 px-1">
                    <span className="text-sm font-bold" style={{ color: '#F6A623' }}>{category}</span>
                    <ChevronDown className="h-4 w-4" style={{ color: '#F6A623' }} />
                  </div>

                  <div className="space-y-2">
                    {items.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((h: any, idx: number) => {
                      const color = (h.color && h.color !== '#4F98A3') ? h.color : VIVID[h.id.charCodeAt(0) % VIVID.length];
                      const target = (h as any).targetPerDay || 1;
                      const todayCount = (h.checkins || []).filter((c: any) => c.date === today).length;
                      const allDone = todayCount >= target;
                      const streak = h.currentStreak || 0;
                      // emoji based on name keywords
                      const getEmoji = (name: string) => {
                        const n = name.toLowerCase();
                        if (n.includes('meditat') || n.includes('mindful')) return '🧘';
                        if (n.includes('journal') || n.includes('write') || n.includes('diary')) return '📝';
                        if (n.includes('water') || n.includes('drink') || n.includes('hydrat')) return '💧';
                        if (n.includes('run') || n.includes('jog')) return '🏃';
                        if (n.includes('exercise') || n.includes('workout') || n.includes('gym') || n.includes('lift')) return '💪';
                        if (n.includes('walk') || n.includes('step')) return '👣';
                        if (n.includes('read') || n.includes('book')) return '📚';
                        if (n.includes('sleep') || n.includes('bed')) return '😴';
                        if (n.includes('eat') || n.includes('food') || n.includes('meal')) return '🥗';
                        if (n.includes('vitamin') || n.includes('pill') || n.includes('medication') || n.includes('medicine')) return '💊';
                        if (n.includes('bathroom') || n.includes('toilet')) return '🚿';
                        if (n.includes('teeth') || n.includes('brush') || n.includes('dental')) return '🦷';
                        if (n.includes('guitar') || n.includes('music') || n.includes('piano') || n.includes('practic')) return '🎸';
                        if (n.includes('alcohol') || n.includes('drink') || n.includes('wine') || n.includes('beer')) return '🍷';
                        if (n.includes('smok') || n.includes('cigarett')) return '🚬';
                        if (n.includes('phone') || n.includes('screen')) return '📱';
                        if (n.includes('rex') || n.includes('dog') || n.includes('pet')) return '🐕';
                        if (n.includes('stretch') || n.includes('yoga')) return '🤸';
                        return '⭐';
                      };
                      const emoji = getEmoji(h.name);

                      return (
                        // FULL SOLID COLOR ROW — exact Habituator style
                        <div
                          key={h.id}
                          className="rounded-2xl overflow-hidden relative"
                          style={{ background: `linear-gradient(135deg, ${color}, ${color}cc)`, boxShadow: `0 3px 12px ${color}40` }}
                        >
                          <div className="flex items-center gap-3 px-4 py-3">
                            {/* Emoji icon */}
                            <span className="text-xl shrink-0">{emoji}</span>

                            {/* Name + dots */}
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm text-white truncate">
                                {h.name}
                                {streak > 0 && <span className="ml-2 text-white/70 text-xs">🔥{streak}</span>}
                              </p>
                              {/* CHECK-IN DOTS — filled white = done, empty ring = tap to log */}
                              <div className="flex items-center gap-1.5 mt-1.5">
                                {Array.from({ length: Math.min(target, 10) }).map((_, i) => {
                                  const filled = i < todayCount;
                                  return (
                                    <button
                                      key={i}
                                      onClick={() => !filled && checkinMutation.mutate({ id: h.id })}
                                      disabled={filled || checkinMutation.isPending}
                                      className="touch-manipulation active:scale-90 transition-transform disabled:cursor-default flex items-center justify-center"
                                      style={{ minWidth: 44, minHeight: 44 }}
                                    >
                                      <div
                                        className="rounded-full border-2 transition-all duration-150"
                                        style={{
                                          width: 24, height: 24,
                                          backgroundColor: filled ? 'rgba(255,255,255,0.9)' : 'transparent',
                                          borderColor: filled ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                                        }}
                                      />
                                    </button>
                                  );
                                })}
                                <span className="text-[11px] text-white/60 ml-1">
                                  {allDone ? '✓' : `${todayCount}/${target}`}
                                </span>
                              </div>
                            </div>

                            {/* Done checkmark or empty ring — tap to check in */}
                            <button
                              onClick={() => !allDone && checkinMutation.mutate({ id: h.id })}
                              disabled={allDone || checkinMutation.isPending}
                              className="min-w-[44px] min-h-[44px] flex items-center justify-center shrink-0 touch-manipulation"
                            >
                              <div
                                className="w-9 h-9 rounded-full border-2 flex items-center justify-center transition-all"
                                style={{
                                  backgroundColor: allDone ? 'rgba(255,255,255,0.9)' : 'transparent',
                                  borderColor: allDone ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)',
                                }}
                              >
                                {allDone && <Check className="h-4 w-4" style={{ color }} strokeWidth={3} />}
                              </div>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
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

  const overdueBills: any[] = useMemo(() => {
    // Bug fix: autopay bills don't go "overdue" — they auto-charge on the due date.
    // A daysUntil<0 on autopay just means the server hasn't rolled forward to the
    // next cycle yet; surfacing it as an overdue bill is misleading and causes
    // every recurring autopay subscription to scream red on the dashboard.
    const raw: any[] = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil < 0 && !b.autopay);
    return raw.filter((b: any) => !dismissedIds.has(`bill-${b.id}`));
  }, [enhanced, dismissedIds]);

  const soonTasks: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.tasksDueSoon || []).filter((t: any) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff >= 0 && diff <= 7;
    });
    const allTasks: any[] = enhanced?.upcomingTasks || [];
    const combined = [...raw, ...allTasks.filter((t: any) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
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
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
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
      await apiRequest("PATCH", `/api/tasks/${taskId}`, { dueDate: newDate.toISOString().slice(0, 10) });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
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
      // Invalidate every cache that surfaces bills/obligations
      ["/api/obligations", "/api/obligation-occurrences", "/api/dashboard-enhanced", "/api/stats", "/api/cashflow", "/api/calendar/timeline"].forEach(k =>
        queryClient.invalidateQueries({ queryKey: [k] })
      );
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
        nextDueDate: newDate.toISOString().slice(0, 10),
      });
      ["/api/obligations", "/api/obligation-occurrences", "/api/dashboard-enhanced", "/api/stats", "/api/cashflow", "/api/calendar/timeline"].forEach(k =>
        queryClient.invalidateQueries({ queryKey: [k] })
      );
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
      const d = t.dueDate ? new Date(t.dueDate) : new Date(0);
      d.setHours(0, 0, 0, 0);
      const days = Math.ceil((now.getTime() - d.getTime()) / 86400000);
      items.push({
        id: t.id, title: t.title,
        detail: `${days} day${days !== 1 ? "s" : ""} overdue`,
        sourceType: "task", accentColor: "#ef4444",
        sortKey: -days,
      });
    }
    // Overdue bills
    for (const b of overdueBills) {
      const days = Math.abs(b.daysUntil);
      items.push({
        id: b.id, title: b.name,
        detail: `${days} day${days !== 1 ? "s" : ""} overdue${b.amount ? ` · ${formatMoney(b.amount)}` : ""}`,
        sourceType: "bill", accentColor: "#ef4444",
        sortKey: -days,
      });
    }
    // Due soon tasks
    for (const t of soonTasks) {
      const d = new Date(t.dueDate);
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
      const label = b.daysUntil === 0 ? "Today" : b.daysUntil === 1 ? "Tomorrow" : `in ${b.daysUntil}d`;
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

  function AttentionItem({ id, title, detail, sourceType, accentColor }: {
    id: string; title: string; detail: string; sourceType: "task" | "bill"; accentColor: string;
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
              <button onClick={() => handleMarkComplete(id)} title="Complete"
                className="h-5 w-5 rounded flex items-center justify-center hover:bg-green-500/20 text-green-600">
                <Check className="h-2.5 w-2.5" />
              </button>
              <button onClick={() => handleSnooze(id)} title="Snooze 7d"
                className="h-5 w-5 rounded flex items-center justify-center hover:bg-amber-500/20 text-amber-600">
                <Clock className="h-2.5 w-2.5" />
              </button>
            </>
          )}
          {sourceType === "bill" && (
            <>
              <button
                onClick={() => handleBillPay(id)}
                title="Mark paid"
                className="h-5 px-1.5 rounded flex items-center gap-0.5 hover:bg-green-500/20 text-green-600 text-[10px] font-semibold"
                data-testid={`btn-pay-bill-${id}`}
              >
                <DollarSign className="h-2.5 w-2.5" />
                Pay
              </button>
              <button
                onClick={() => handleBillSnooze(id)}
                title="Snooze 7d"
                className="h-5 w-5 rounded flex items-center justify-center hover:bg-amber-500/20 text-amber-600"
                data-testid={`btn-snooze-bill-${id}`}
              >
                <Clock className="h-2.5 w-2.5" />
              </button>
            </>
          )}
          <button onClick={() => dismiss(`${sourceType}-${id}`)} title="Dismiss"
            className="h-5 w-5 rounded flex items-center justify-center hover:bg-muted text-muted-foreground">
            <X className="h-2 w-2" />
          </button>
        </div>
      </div>
    );
  }

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
            <AttentionItem key={`${item.sourceType}-${item.id}`} {...item} />
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
            <SheetDescription className="text-xs">All items that need your attention</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto overscroll-contain mt-4" style={{ WebkitOverflowScrolling: 'touch', height: 'calc(100vh - 120px)' }}>
            <div className="space-y-0.5 pr-2">
              {allItems.map((item) => (
                <AttentionItem key={`sheet-${item.sourceType}-${item.id}`} {...item} />
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
                      className="absolute top-1 h-3 rounded-full text-[8px] font-bold flex items-center justify-center overflow-hidden"
                      style={{ left: `${toPos(ev.time)}%`, minWidth: '8px', maxWidth: '60px', transform: 'translateX(-50%)',
                        background: ev.category === 'health' ? 'hsl(173 60% 44%)' : ev.category === 'finance' ? 'hsl(43 85% 52%)' : 'hsl(215 70% 58%)',
                        color: 'white', padding: '0 3px' }}>
                      {ev.title.slice(0,8)}
                    </div>
                  ))}
                  {/* Now indicator */}
                  {(() => { const now = new Date(); const nowPos = ((now.getHours() + now.getMinutes()/60 - START) / (END-START)) * 100; return nowPos >= 0 && nowPos <= 100 ? <div className="absolute top-0 bottom-0 w-px bg-red-400/70" style={{ left: `${nowPos}%` }} /> : null; })()}
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground/50 mt-0.5 px-0.5">
                  <span>8am</span><span>12pm</span><span>4pm</span><span>10pm</span>
                </div>
              </div>
            );
          })()}
          {visibleEvents.map((ev: any) => (
            <div key={ev.id}
              onClick={() => navigate("/calendar")}
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
            // Determine status color band
            let statusColor = 'hsl(173 60% 44%)'; // default teal = normal
            const name = item.name?.toLowerCase() || '';
            const val = item.latestValue;
            if (name.includes('blood') || name.includes('bp')) {
              if (val > 140 || val < 90) statusColor = '#ef4444';
              else if (val > 130) statusColor = '#f59e0b';
              else statusColor = '#10b981';
            } else if (name.includes('weight')) {
              statusColor = 'hsl(173 60% 44%)';
            }
            // Mini sparkline from recent entries (7 points)
            const spark: number[] = item.recentValues || [];
            const sparkMax = Math.max(...spark, 1);
            const sparkMin = Math.min(...spark, 0);
            const sparkRange = sparkMax - sparkMin || 1;

            return (
              <div key={item.trackerId}
                onClick={() => setSelectedTracker(item)}
                className="flex items-start gap-0 p-2 rounded-lg bg-muted/40 cursor-pointer hover:bg-muted/60 transition-colors overflow-hidden relative">
                {/* Status color band on left */}
                <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg" style={{ background: statusColor }} />
                <div className="flex-1 min-w-0 pl-2">
                  <p className="text-[10px] text-muted-foreground truncate font-medium" title={item.name}>{item.name}</p>
                  <div className="flex items-baseline gap-1">
                    <span className="text-sm font-bold tabular-nums">{item.dailyTotal != null ? item.dailyTotal : item.latestValue}</span>
                    {item.unit && <span className="text-[10px] text-muted-foreground">{item.unit}</span>}
                    <TrendIcon trend={item.trend} />
                  </div>
                  {/* Mini sparkline */}
                  {spark.length > 1 && (
                    <svg width="100%" height="12" viewBox={`0 0 ${spark.length * 8} 12`} preserveAspectRatio="none" className="mt-0.5 opacity-60">
                      <polyline
                        points={spark.map((v,i) => `${i*8},${12 - ((v-sparkMin)/sparkRange)*10}`).join(' ')}
                        fill="none" stroke={statusColor} strokeWidth="1.5" />
                    </svg>
                  )}
                </div>
              </div>
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

function ObligationsSection({ data }: { data: any[] }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [selectedBill, setSelectedBill] = useState<any>(null);

  const payMutation = useMutation({
    mutationFn: ({ id, name, amount }: { id: string; name?: string; amount?: number }) => apiRequest("POST", `/api/obligations/${id}/pay`),
    // Optimistic: remove the bill from the visible bills list immediately so the
    // "Mark Paid" tap feels instant. Reconcile from server in onSettled.
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.filter((b: any) => b.id !== id) : old
      );
      return { prev };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.name || "Bill"}" marked paid`, description: variables.amount ? `$${variables.amount.toFixed(2)} payment recorded` : undefined });
      setSelectedBill(null);
    },
    onError: (_err, variables, context: any) => {
      // Roll back optimistic removal
      if (context?.prev) {
        for (const [key, value] of context.prev) queryClient.setQueryData(key, value);
      }
      toast({ title: `Failed to mark "${variables.name || "bill"}" as paid`, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) => apiRequest("DELETE", `/api/obligations/${id}`),
    onMutate: async (variables) => {
      // Optimistic removal so the row disappears instantly. Snapshot every
      // observed query under ["/api/obligations", ...] so we can roll back
      // if the server rejects the delete (e.g. 404 from a stale duplicate).
      await queryClient.cancelQueries({ queryKey: ["/api/obligations"] });
      const snapshots = queryClient.getQueriesData({ queryKey: ["/api/obligations"] });
      queryClient.setQueriesData({ queryKey: ["/api/obligations"] }, (old: any) =>
        Array.isArray(old) ? old.filter((item: any) => item.id !== variables.id) : old
      );
      return { snapshots };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.name || "Obligation"}" deleted` });
      setSelectedBill(null);
    },
    onError: (_err, variables, ctx: any) => {
      // Restore each observed cache snapshot we captured in onMutate.
      ctx?.snapshots?.forEach(([key, data]: [any, any]) => queryClient.setQueryData(key, data));
      toast({ title: `Failed to delete "${variables.name || "obligation"}"`, variant: "destructive" });
    },
    onSettled: () => {
      // Use the cache bus so /api/stats, /api/dashboard-enhanced,
      // /api/cashflow, /api/loans/schedule all refresh together.
      invalidateDomain("obligations");
    },
  });

  // Group bills by timeframe — autopay bills are never "overdue" (they auto-charge on due date).
  // They show up under their next-cycle window instead of the overdue group.
  const overdueBills = useMemo(() => (data || []).filter((b: any) => b.daysUntil < 0 && !b.autopay), [data]);
  const thisWeekBills = useMemo(() => (data || []).filter((b: any) => (b.daysUntil >= 0 && b.daysUntil <= 7) || (b.autopay && b.daysUntil < 0)), [data]);
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

  function BillGroup({ title, bills, color }: { title: string; bills: any[]; color: string }) {
    const [expanded, setExpanded] = useState(false);
    if (bills.length === 0) return null;
    const groupTotal = bills.reduce((s: number, b: any) => s + (b.amount || 0), 0);
    return (
      <div className="space-y-0.5">
        <button
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center gap-1.5 py-1 text-left hover:bg-muted/30 rounded px-1 -mx-1 transition-colors"
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
                onClick={() => setSelectedBill(bill)}
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

  return (
    <>
      <CollapsibleSection accent="43 75% 50%" icon={CreditCard} label="Bills & Subscriptions"
        sub={`Monthly Total: ${formatMoney(monthlyTotal)}`}
        count={data.length} testId="section-obligations">
        <div className="space-y-1">
          {/* Proportion overview bar */}
          {(() => {
            const ov = overdueBills.reduce((s:number,b:any)=>s+(b.amount||0),0);
            const wk = thisWeekBills.reduce((s:number,b:any)=>s+(b.amount||0),0);
            const mn = thisMonthBills.reduce((s:number,b:any)=>s+(b.amount||0),0);
            const total = ov+wk+mn;
            if (total === 0) return null;
            return (
              <div className="mb-2">
                <div className="flex h-2 rounded-full overflow-hidden gap-px bg-muted/30">
                  {ov > 0 && <div style={{width:`${(ov/total)*100}%`,background:'#ef4444'}} className="rounded-l-full transition-all" />}
                  {wk > 0 && <div style={{width:`${(wk/total)*100}%`,background:'#f59e0b'}} className="transition-all" />}
                  {mn > 0 && <div style={{width:`${(mn/total)*100}%`,background:'hsl(var(--muted-foreground) / 0.35)'}} className="rounded-r-full transition-all" />}
                </div>
                <div className="flex gap-3 mt-1">
                  {ov > 0 && <span className="text-[9px] text-red-500 font-semibold">● Overdue ${ov.toFixed(0)}</span>}
                  {wk > 0 && <span className="text-[9px] text-amber-500 font-medium">● Week ${wk.toFixed(0)}</span>}
                  {mn > 0 && <span className="text-[9px] text-muted-foreground">● Month ${mn.toFixed(0)}</span>}
                </div>
              </div>
            );
          })()}
          <BillGroup title="Overdue" bills={overdueBills} color="#ef4444" />
          <BillGroup title="Due This Week" bills={thisWeekBills} color="#f59e0b" />
          <BillGroup title="Due This Month" bills={thisMonthBills} color="#6b7280" />
        </div>
        <ViewPageLink href="/dashboard/obligations" label="View All Obligations" />
      </CollapsibleSection>

      {/* Obligation Detail Popup */}
      <Dialog open={!!selectedBill} onOpenChange={o => { if (!o) setSelectedBill(null); }}>
        <DialogContent className="max-w-xs max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">{selectedBill?.name}</DialogTitle>
            <DialogDescription className="text-xs">Bill details</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Amount</span><span className="font-semibold">{formatMoney(selectedBill?.amount || 0)}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Due</span><span>{selectedBill?.dueDate ? fmtDate(selectedBill.dueDate) : "N/A"}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Category</span><span className="capitalize">{selectedBill?.category || "general"}</span></div>
            <div className="flex justify-between text-xs"><span className="text-muted-foreground">Autopay</span><span>{selectedBill?.autopay ? "Yes" : "No"}</span></div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => selectedBill && payMutation.mutate({ id: selectedBill.id, name: selectedBill.name, amount: selectedBill.amount })}
              disabled={payMutation.isPending}>
              <Check className="h-3 w-3 mr-1" /> Mark Paid
            </Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => selectedBill && deleteMutation.mutate({ id: selectedBill.id, name: selectedBill.name })}
              disabled={deleteMutation.isPending}>
              <Trash2 className="h-3 w-3 mr-1" /> Delete
            </Button>
          </div>
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

function GoalsSection({ profileId, profileIds = [] }: { profileId?: string; profileIds?: string[] }) {
  // Multi-profile aware: prefer profileIds (array) when present, fall back to single profileId.
  const ids = profileIds.length > 0 ? profileIds : (profileId ? [profileId] : []);
  const profileParam = ids.length > 0 ? `?profileIds=${ids.join(",")}` : "";
  // Canonical key: ["/api/goals", filterMode, ...sortedIds] — see
  // shared/query-keys.ts and ARCHITECTURE.md §3. Both dashboard and
  // trackers must use this so their caches share one slot.
  // BUG-20260528-goals-key-shape
  const goalsKey = goalsQueryKey(ids);
  const { data: goals = [], isLoading, error: goalsError } = useQuery<GoalItem[]>({
    queryKey: goalsKey,
    queryFn: () => apiRequest("GET", `/api/goals${profileParam}`).then(r => r.json()),
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
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      const name = formTitle;
      setCreating(false); resetForm();
      toast({ title: `"${name}" goal created`, description: formTarget ? `Target: ${formTarget} ${formUnit}` : undefined });
    },
    onError: (e: Error) => toast({ title: "Failed to create goal", description: e.message, variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, title, ...data }: any) => apiRequest("PATCH", `/api/goals/${id}`, { title, ...data }).then(r => r.json()),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      setEditGoal(null); resetForm();
      toast({ title: `"${variables.title || "Goal"}" updated` });
    },
    onError: (err: Error, variables) => toast({ title: `Failed to update "${variables.title || "goal"}"`, description: err.message, variant: "destructive" }),
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
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
    if (editGoal) updateMutation.mutate({ id: editGoal.id, ...payload });
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
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setActionGoal(g)}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs-loose font-medium truncate">{g.title}</span>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        {isOverdue && <span className="text-[9px] font-bold text-red-500">OVERDUE</span>}
                        {!isOverdue && isAtRisk && <span className="text-[9px] font-bold text-amber-500">AT RISK</span>}
                        {isReadyToComplete && <span className="text-[9px] font-bold text-emerald-500">DONE — MARK COMPLETE</span>}
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
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-red-500/80 mt-0.5 mb-0.5 px-1">
                      Overdue — action needed ({overdueRows.length})
                    </p>
                    {overdueRows.map(renderRow)}
                    {activeRows.length > 0 && <div className="h-px bg-border/30 my-1.5" />}
                  </>
                )}
                {activeRows.length > 0 && (
                  <>
                    {overdueRows.length > 0 && (
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-0.5 px-1">
                        In progress ({activeRows.length})
                      </p>
                    )}
                    {activeRows.map(renderRow)}
                  </>
                )}
                {completedGoals.length > 0 && (
                  <div className="pt-1.5 mt-1 border-t border-border/30">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/80 mb-0.5 px-1">
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
                    {actionGoal.deadline && ` · Due ${new Date(actionGoal.deadline).toLocaleDateString()}`}
                  </p>
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
            <DialogTitle className="text-sm">{editGoal ? "Edit Goal" : "Create Goal"}</DialogTitle>
            <DialogDescription className="text-xs">Set a measurable target to track your progress</DialogDescription>
          </DialogHeader>
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
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); setAddOpen(false); setNewCat(""); setNewAmt(""); setNewNotes(""); toast({ title: "Budget added" }); },
    onError: () => toast({ title: "Failed to add budget", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/budgets/${id}?month=${month}`),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["/api/budgets", month] });
      const prev = queryClient.getQueryData(["/api/budgets", month]);
      queryClient.setQueryData(["/api/budgets", month], (old: any) =>
        old ? { ...old, budgets: (old.budgets || []).filter((b: any) => b.id !== id) } : old
      );
      return { prev };
    },
    onSuccess: () => {
      refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Budget deleted" });
    },
    onError: (_e, _v, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/budgets", month], ctx.prev);
      toast({ title: "Failed to delete budget", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: {id: string; amount: number}) =>
      apiRequest("PATCH", `/api/budgets/${data.id}?month=${month}`, { amount: data.amount }),
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); setEditId(null); toast({ title: "Budget updated" }); },
    onError: () => toast({ title: "Failed to update budget", variant: "destructive" }),
  });

  const copyMutation = useMutation({
    mutationFn: () => {
      const [y, m] = month.split("-").map(Number);
      const prevDate = new Date(y, m - 2, 1);
      const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
      return apiRequest("POST", "/api/budgets/copy", { fromMonth: prevMonth, toMonth: month }).then(r => r.json());
    },
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); toast({ title: "Budget copied from last month" }); },
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
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => copyMutation.mutate()}>
              Copy Previous Month
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section: Finance Widget ─────────────────────────────────────────────────

function FinanceWidget({ data, stats, filterIds = [], filterMode = "everyone" }: { data: any; stats: DashboardStats | undefined; filterIds?: string[]; filterMode?: string }) {
  const [, navigate] = useLocation();
  const [drill, setDrill] = useState<"spending" | "income" | "cashflow" | "networth" | "budget" | null>(null);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const incomeUrl = filterMode === "selected" && filterIds.length > 0
    ? `/api/incomes?profileIds=${filterIds.join(",")}`
    : "/api/incomes";
  const { data: incomes } = useQuery<any[]>({
    queryKey: ["/api/incomes", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", incomeUrl).then(r => r.json()),
  });
  const { data: allProfiles } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const { data: allObligations } = useQuery<any[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligations${profileParam}`).then(r => r.json()),
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
  const monthlyIncome = useMemo(() => (incomes || []).reduce((s, i) => s + (i.amount || 0), 0), [incomes]);
  const cashFlow = monthlyIncome - monthlySpend;
  const recentExpenses: any[] = data?.recentExpenses || [];

  // Build drill-down data — use profile-filtered monthlyExpenseRecords from enhanced API
  const now = new Date();
  const monthExpenses: any[] = data?.monthlyExpenseRecords || [];
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
  // Prefer the server numbers; fall back to the client walk only for the brief
  // window before /api/dashboard-enhanced resolves.
  const totalAssetValue = data?.totalAssetValue ?? (assetProfiles.reduce((s, p) => s + resolveAssetValue(p), 0));
  const totalLiabilities = data?.totalLiabilities ?? (tileLiabilityProfiles.reduce((s, p) => s + resolveLiabilityBalance(p), 0));
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
              <p className="text-[10px] text-red-500/80 leading-tight mt-0.5">Tap to review categories and adjust</p>
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
          <button onClick={() => setDrill("spending")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Spending</p>
            {/* Color discipline: spending = amber, never red. Red is reserved for
                overdue/breach states only. */}
            <p className="text-sm font-bold tabular-nums text-amber-500">${monthlySpend.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">{monthExpenses.length} this month</p>
          </button>
          <button onClick={() => setDrill("income")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Income</p>
            <p className="text-sm font-bold tabular-nums text-green-500">${monthlyIncome.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">{(incomes || []).length} sources</p>
          </button>
          <button onClick={() => setDrill("cashflow")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Cash Flow</p>
            {/* Negative cash flow uses amber (warning), not red (overdue). */}
            <p className={`text-sm font-bold tabular-nums ${cashFlow >= 0 ? "text-green-500" : "text-amber-500"}`}>
              {cashFlow >= 0 ? "+" : ""}${cashFlow.toLocaleString()}
            </p>
            <p className="text-xs-tight text-muted-foreground">income - spending</p>
          </button>
          <button onClick={() => setDrill("networth")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Net Worth</p>
            <p className={`text-sm font-bold tabular-nums ${netWorth >= 0 ? "text-green-500" : "text-red-500"}`}>${netWorth.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">assets - liabilities</p>
            {/* 6-Month Trend sparkline removed 2026-05-28 — it was synthesizing
                historical net worth from `current NW - mSpend * monthsAgo * 0.8`,
                which always trended upward regardless of reality. We have no
                stored historical snapshots yet, so showing nothing is correct.
                See audit finding 7.7 and BUG-20260528-fabricated-sparkline. */}
          </button>
          <button onClick={() => setDrill("budget")} className="col-span-2 rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
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
                      <span className="text-[10px] capitalize truncate flex-1">{c.name}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{pct}%</span>
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
            {recentExpenses.slice().sort((a: any, b: any) => (a.description || '').localeCompare(b.description || '')).slice(0, 5).map((exp: any) => (
              <div key={exp.id} className="flex items-center justify-between py-1 text-xs">
                <span className="truncate flex-1">{exp.description || "Expense"}</span>
                <span className="font-medium tabular-nums ml-2">${exp.amount?.toLocaleString()}</span>
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
      />

      {/* Income Drill-Down */}
      <DrillDownDialog
        open={drill === "income"}
        onClose={() => setDrill(null)}
        title="Income Sources"
        total={`$${monthlyIncome.toLocaleString()}/mo`}
        items={(incomes || []).slice().sort((a: any, b: any) => (a.description || '').localeCompare(b.description || '')).map((i: any) => ({
          label: i.description,
          value: `$${i.amount.toLocaleString()}`,
          sub: i.frequency,
          category: i.category,
        }))}
        emptyMessage="No income sources yet. Add them on the Finance page."
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
          { label: "Total Income", value: `+$${monthlyIncome.toLocaleString()}`, sub: `${(incomes || []).length} sources`, category: "income" },
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
      />
        );
      })()}

      {/* Net Worth Drill-Down */}
      {/* Liabilities are profiles carrying a loan/remaining balance (financed cars, mortgages,
          explicit loans). Obligations (recurring bills like utilities) are excluded — they are
          cash-flow, not balance-sheet liabilities. */}
      {(() => {
        const liabilityProfiles = (allProfiles || []).filter((p: any) => {
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
    vehicle: "bg-blue-500/15 text-blue-600",
    property: "bg-amber-500/15 text-amber-700",
    asset: "bg-purple-500/15 text-purple-700",
    investment: "bg-green-500/15 text-green-700",
    account: "bg-slate-500/15 text-slate-600",
  };

  return (
    <div
      data-testid="expiring-warranties-card"
      className="relative rounded-xl border border-border/40 bg-card overflow-hidden transition-shadow hover:shadow-sm"
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
        <h2 className="text-xs font-semibold tracking-wide uppercase" style={{ color: "hsl(25 90% 55%)" }}>
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
              <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${pillClass}`}>
                {item.type}
              </span>
              <span
                className={`shrink-0 text-[10px] font-semibold tabular-nums ${
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

  const generateSummary = async () => {
    setLoading(true);
    try {
      const resp = await apiRequest("POST", "/api/ai/summary", {
        filterMode,
        filterIds,
        scopeLabel,
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
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80" data-testid="ai-summary-scope">
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
          <span className="text-[10px] text-muted-foreground">
            {loading ? "Generating…" : lastGenerated ? `Generated at ${lastGenerated}` : ""}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs gap-1"
            onClick={generateSummary}
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
  }).slice(0, 5), [activities]);

  if (validActivities.length === 0) return (
    <CollapsibleSection icon={Activity} label="Recent Activity" testId="section-activity">
      <div className="text-center py-4">
        <Activity className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No recent activity</p>
      </div>
    </CollapsibleSection>
  );

  type ActivityItem = (typeof validActivities)[0];
  const groups: { hourLabel: string; items: ActivityItem[] }[] = [];
  for (const item of validActivities) {
    const d = new Date(item.timestamp);
    const hourKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    const hourLabel = timeAgo(item.timestamp);
    const last = groups[groups.length - 1];
    const lastKey = last ? (() => { const ld = new Date(last.items[0].timestamp); return `${ld.getFullYear()}-${ld.getMonth()}-${ld.getDate()}-${ld.getHours()}`; })() : null;
    if (lastKey === hourKey) {
      last.items.push(item);
    } else {
      groups.push({ hourLabel, items: [item] });
    }
  }

  return (
    <CollapsibleSection icon={Activity} label="Recent Activity" count={validActivities.length} testId="section-activity">
      <div className="space-y-1.5">
        {groups.map((group, gi) => (
          <div key={gi}>
            <p className="text-xs-tight text-muted-foreground/60 uppercase tracking-wider mb-0.5 mt-1 first:mt-0">{group.hourLabel}</p>
            {group.items.map((item, i) => {
              const Icon = ACTIVITY_ICONS[item.type] || Activity;
              const route = ACTIVITY_ROUTES[item.type];
              return (
                <div key={i}
                  onClick={() => route && navigate(route)}
                  className={`flex items-center gap-2 py-1.5 border-b border-border/30 last:border-0 ${route ? "cursor-pointer hover:bg-muted/40 rounded px-1 -mx-1 transition-colors" : ""}`}>
                  <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-xs truncate flex-1">{item.description}</span>
                </div>
              );
            })}
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

const DEFAULT_SECTIONS: DashboardSection[] = [
  // 1) AI Summary at the very top — hero context-setter
  { id: "ai-summary",       label: "AI Summary",           icon: Sparkles,     visible: true, column: "full" },
  // 2) Hero KPIs — Net Worth / Budget / Cash Flow (big tiles)
  { id: "hero-kpis",        label: "Hero Metrics",         icon: Sparkles,     visible: true, column: "full" },
  // 3) Secondary KPI chip row (tasks, spend, habits, journal, docs)
  { id: "kpis",             label: "Key Metrics",          icon: BarChart3,    visible: true, column: "full" },
  // === 💰 Money swimlane ===
  { id: "finance",          label: "Finance",              icon: DollarSign,   visible: true, column: "full" },
  { id: "obligations",      label: "Bills & Subscriptions",icon: CreditCard,   visible: true, column: "full" },
  // === 📅 Today swimlane ===
  { id: "today",            label: "Today's Schedule",     icon: Calendar,     visible: true, column: "left" },
  { id: "needs-attention",  label: "Action Required",      icon: AlertTriangle,visible: true, column: "right" },
  { id: "goals",            label: "Goals",                icon: Target,       visible: true, column: "full" },
  // === ❤️ Health swimlane ===
  { id: "health",           label: "Health",               icon: HeartPulse,   visible: true, column: "full" },
  { id: "activity",         label: "Recent Activity",      icon: Activity,     visible: true, column: "full" },
];
// Swimlane groups (id sets) — render small group header chips during layout
const SWIMLANE_GROUPS: Array<{ key: string; label: string; emoji: string; ids: string[] }> = [
  { key: "money",  label: "Money",  emoji: "💰", ids: ["finance", "obligations"] },
  { key: "today",  label: "Today",  emoji: "📅", ids: ["today", "needs-attention", "goals"] },
  { key: "health", label: "Health", emoji: "❤️", ids: ["health", "activity"] },
];

const LAYOUT_VERSION = 6; // Bump: AI Summary → top hero; hero-kpis introduced; swimlane reorder

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
          <DialogTitle className="text-sm">Customize Dashboard</DialogTitle>
          <DialogDescription className="text-xs">Reorder sections, toggle visibility, and change column placement.</DialogDescription>
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

export default function DashboardPage() {
  useEffect(() => { document.title = "Dashboard — Portol"; }, []);
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
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
  // <500ms (the keepPreviousData + 30s staleTime + persisted-cache path). The
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

  // Sync profile filter to module-level state for backward compat with sub-pages
  useEffect(() => {
    setDashboardProfileFilter(resolvedFilterId, resolvedFilterId ? (allProfiles.find((p: any) => p.id === resolvedFilterId)?.name || "") : "Everyone");
  }, [resolvedFilterId, allProfiles]);

  // PERF (2026-05-28): single-shot bootstrap. /api/dashboard-bootstrap returns
  // stats + enhanced + profiles + incomes + budget-summary in ONE round-trip.
  // We pre-fill the react-query cache so the individual useQuery hooks below
  // (which mutations still depend on) see a fresh cache hit and skip the
  // network. Without this, the dashboard fired 10 parallel network calls and
  // the skeleton stayed up for ~20-30s on cold loads with realistic data
  // volume.
  useEffect(() => {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const qs = (filterMode === "selected" && filterIds.length > 0)
      ? `?profileIds=${filterIds.join(",")}&month=${currentMonth}`
      : `?month=${currentMonth}`;
    let cancelled = false;
    apiRequest("GET", `/api/dashboard-bootstrap${qs}`)
      .then(r => r.json())
      .then((b: any) => {
        if (cancelled || !b || typeof b !== "object") return;
        // Pre-fill the cache for each individual query so the existing
        // useQuery hooks resolve from cache without an extra network round-trip.
        if (b.stats) queryClient.setQueryData(["/api/stats", filterMode, ...filterIds], b.stats);
        if (b.enhanced) queryClient.setQueryData(["/api/dashboard-enhanced", filterMode, ...filterIds], b.enhanced);
        if (b.profiles) queryClient.setQueryData(["/api/profiles"], b.profiles);
        if (b.incomes) queryClient.setQueryData(["/api/incomes", filterMode, ...filterIds, "hero"], b.incomes);
        if (b.budgetSummary) queryClient.setQueryData(
          ["/api/budgets/summary", currentMonth, filterMode, ...filterIds, "hero"],
          b.budgetSummary,
        );
      })
      .catch(() => { /* non-fatal — individual queries will fetch on their own */ });
    return () => { cancelled = true; };
    // Re-run when the profile filter changes — each filter combination has
    // its own cache buckets.
  }, [filterMode, filterIds.join(",")]);

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/stats", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/stats${statsProfileParam}`).then(r => r.json()),
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

  const { data: enhanced } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", `/api/dashboard-enhanced${statsProfileParam}`);
        return res.json();
      } catch (err) { console.error("[dashboard-enhanced] fetch failed:", err); return null; }
    },
    retry: false,
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

  const sections: DashboardSection[] =
    parseSavedLayout(savedLayoutData?.value ?? null) || DEFAULT_SECTIONS;

  const saveMutation = useMutation({
    mutationFn: (layout: DashboardSection[]) =>
      apiRequest("PUT", "/api/preferences/dashboard_layout", { value: serializeLayout(layout) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/preferences"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      a.download = `portol-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
        queryClient.invalidateQueries();
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
        content = <HeroKPISection enhanced={enhanced} stats={stats} filterMode={filterMode} filterIds={filterIds} />;
        break;
      case "kpis":
        content = (showDashSkeleton && !stats) ? <SkeletonGrid cols={3} rows={2} h="h-14" /> :
          stats ? <KPISection stats={stats} enhanced={enhanced} filterIds={filterIds} filterMode={filterMode} /> : null;
        break;
      case "today":
        content = <TodaySection enhanced={enhanced} stats={stats} />;
        break;
      case "needs-attention":
        content = stats ? <ActionRequiredSection stats={stats} enhanced={enhanced} profileId={resolvedFilterId} /> : null;
        break;
      case "health":
        content = <HealthSection data={enhanced?.healthSnapshot || []} />;
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
            <FinanceWidget data={enhanced?.financeSnapshot} stats={stats} filterIds={filterIds} filterMode={filterMode} />
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
      default:
        content = null;
    }
    return content ? <SectionErrorBoundary name={id}>{content}</SectionErrorBoundary> : null;
  }

  const fullWidthSections = useMemo(() => sections.filter(s => s.visible && s.column === "full"), [sections]);
  const leftSections = useMemo(() => sections.filter(s => s.visible && s.column === "left"), [sections]);
  const rightSections = useMemo(() => sections.filter(s => s.visible && s.column === "right"), [sections]);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden px-3 py-3 md:p-4 space-y-3 max-w-full pb-24" style={{WebkitOverflowScrolling: 'touch'}} data-testid="page-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-foreground/90 tracking-tight">
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <span className="text-xs text-muted-foreground/60">·</span>
            <MultiProfileFilter
              onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
              compact
            />
          </div>
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
              <DropdownMenuItem onClick={handleExport} data-testid="btn-export">
                <Download className="h-4 w-4 mr-2" /> Export Data
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setImportOpen(true)} data-testid="btn-import">
                <UploadCloud className="h-4 w-4 mr-2" /> Import Backup
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Import Dialog */}
      <Dialog open={importOpen} onOpenChange={(o) => { if (!o) setImporting(false); setImportOpen(o); }}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Backup</DialogTitle>
            <DialogDescription className="text-xs">Upload a Portol backup JSON file to restore your data.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="import-file" className="cursor-pointer">
              <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 transition-colors">
                <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm font-medium">Click to select backup file</p>
                <p className="text-xs text-muted-foreground mt-1">.json files only</p>
              </div>
            </Label>
            <input id="import-file" type="file" accept=".json" className="hidden" onChange={handleImport} disabled={importing} />
          </div>
          {importing && <p className="text-xs text-center text-muted-foreground">Importing...</p>}
        </DialogContent>
      </Dialog>

      {/* Customize Dialog */}
      <CustomizeDialog open={customizeOpen} onOpenChange={setCustomizeOpen}
        sections={sections} onSave={(layout) => saveMutation.mutate(layout)} />

      {/* Render sections in order: full-width before grid, then 2-col grid, then full-width after grid.
          Swimlane group headers (💰 Money / 📅 Today / ❤️ Health) are emitted before the first
          section of each group, so the page visually segments into related clusters. */}
      {(() => {
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
          return (
            <div className="flex items-center gap-2 mt-3 mb-1 px-0.5" data-testid={`swimlane-${g.key}`}>
              <span className="text-base leading-none" aria-hidden="true">{g.emoji}</span>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{g.label}</span>
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
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">{g.label}</span>
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
