import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { DrillDownDialog } from "@/components/DrillDownDialog";
import { getProfileFilter, setDashboardProfileFilter } from "@/lib/profileFilter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
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
  ChevronLeft, ChevronRight, Plus,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line } from "recharts";
import type { DashboardStats, MoodLevel } from "@shared/schema";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(n: number): string {
  return n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
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
  const [current, setCurrent] = useState(0);
  const prevTarget = useRef(0);
  useEffect(() => {
    if (target === prevTarget.current) return;
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
    <div data-testid={testId} className="rounded-xl border border-border/40 bg-card overflow-hidden">
      <button
        className="w-full flex items-center gap-2.5 px-3 py-3 text-left"
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
          {open ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>
      </button>
      {open && <div className="px-2.5 pb-2.5">{children}</div>}
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
  const expiredCount = (docs || []).filter(d => d.status === 'expired').length;
  const mostOverdue = (docs || []).filter(d => d.daysUntil < 0).sort((a,b) => a.daysUntil - b.daysUntil)[0];
  const isUrgent = expiredCount > 0;
  const accent = isUrgent ? '0 72% 52%' : '25 80% 54%';
  return (
    <div onClick={onClick} className="relative flex flex-col p-2.5 rounded-xl border overflow-hidden cursor-pointer card-lift active:scale-[0.97] transition-all"
      style={{ background: `linear-gradient(135deg, hsl(${accent} / 0.12) 0%, transparent 60%)`, borderColor: isUrgent ? 'hsl(0 72% 52% / 0.4)' : 'hsl(var(--border) / 0.4)' }}
      data-testid="stat-card-expiring-docs">
      <div className="absolute top-0 left-0 right-0 h-[2px] rounded-t-xl" style={{ background: `linear-gradient(90deg, hsl(${accent}), transparent)` }} />
      {isUrgent && <div className="absolute top-0 left-0 right-0 bottom-0 border border-red-500/20 rounded-xl pointer-events-none" />}
      <div className="flex items-start justify-between relative z-10">
        <div className="icon-badge" style={{ background: `hsl(${accent} / 0.15)` }}>
          <FileWarning className="h-3.5 w-3.5" style={{ color: `hsl(${accent})` }} />
        </div>
        {isUrgent && <span className="text-[9px] font-bold text-red-500 bg-red-500/10 px-1 py-0.5 rounded">EXPIRED</span>}
      </div>
      <div className="mt-1 relative z-10">
        <span className="text-lg font-bold metric-value tracking-tight leading-none" style={{ color: `hsl(${accent})` }}>{(docs || []).length}</span>
      </div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 mt-0.5 relative z-10">Expiring Docs</p>
      {mostOverdue && (
        <p className="text-[9px] text-red-500 mt-0.5 relative z-10 truncate">
          {Math.abs(mostOverdue.daysUntil)}d overdue
        </p>
      )}
      {/* Urgency bar */}
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

// ─── Section: KPI Stats ──────────────────────────────────────────────────────

function KPISection({ stats, enhanced, filterIds = [], filterMode = "everyone" }: { stats: DashboardStats; enhanced: any; filterIds?: string[]; filterMode?: string }) {
  const [, navigate] = useLocation();
  const [popup, setPopup] = useState<"spending" | "bills" | "tasks" | "docs" | null>(null);

  if (!stats) return null;

  const finSnap = enhanced?.financeSnapshot;
  const spendTrend: "up" | "down" | "flat" = finSnap?.spendTrend > 0 ? "up" : finSnap?.spendTrend < 0 ? "down" : "flat";

  const moodConf = stats.currentMood ? MOOD_CONFIG[stats.currentMood] : null;

  return (
    <>
      <div className="rounded-lg border border-border/40 bg-card px-2 py-2" data-testid="section-kpis">
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-1.5">
          <KPITaskCard count={stats.activeTasks} onClick={() => setPopup("tasks")} />
          <KPISpendCard amount={stats.monthlySpend} trend={spendTrend} enhanced={enhanced} onClick={() => setPopup("spending")} />
          <KPIHabitsCard completionPct={stats.habitCompletionRate} totalHabits={stats.totalHabits} onClick={() => navigate("/dashboard/habits")} />
          <KPIJournalCard streak={stats.journalStreak} mood={stats.currentMood || null} onClick={() => navigate("/dashboard/journal")} />
          <MiniStat accent="43 75% 50%" icon={CreditCard} label="Upcoming Bills"
            value={stats.upcomingObligations}
            sub={formatMoney(stats.monthlyObligationTotal) + "/mo"}
            onClick={() => setPopup("bills")} />
          <KPIDocsCard docs={enhanced?.expiringDocuments || []} onClick={() => setPopup("docs")} />
        </div>
      </div>

      {/* Spending Breakdown Popup */}
      <Dialog open={popup === "spending"} onOpenChange={() => setPopup(null)}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Spending Breakdown</DialogTitle>
            <DialogDescription className="text-xs">This month's expenses by category</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {finSnap?.spendByCategory && Object.entries(finSnap.spendByCategory as Record<string, number>)
              .sort(([, a], [, b]) => b - a)
              .map(([cat, amt]) => (
                <div key={cat} className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
                  <span className="text-xs capitalize">{cat}</span>
                  <span className="text-xs font-semibold tabular-nums">{formatMoney(amt)}</span>
                </div>
              ))}
            {(!finSnap?.spendByCategory || Object.keys(finSnap.spendByCategory).length === 0) && (
              <p className="text-xs text-muted-foreground text-center py-4">No expenses this month</p>
            )}
            <div className="flex items-center justify-between pt-2 border-t font-semibold">
              <span className="text-xs">Total</span>
              <span className="text-sm tabular-nums">{formatMoney(finSnap?.totalMonthlySpend || 0)}</span>
            </div>
            {finSnap?.lastMonthTotal > 0 && (
              <p className="text-xs text-muted-foreground">
                vs last month: {formatMoney(finSnap.lastMonthTotal)} ({finSnap.spendTrend > 0 ? "+" : ""}{finSnap.spendTrend}%)
              </p>
            )}
          </div>
          <ViewPageLink href="/dashboard/finance" label="View Finance Page" />
        </DialogContent>
      </Dialog>

      {/* Bills Popup */}
      <Dialog open={popup === "bills"} onOpenChange={() => setPopup(null)}>
        <DialogContent className="max-w-sm max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">Upcoming Bills</DialogTitle>
            <DialogDescription className="text-xs">Bills due in the next 30 days</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50vh]">
            <div className="space-y-1.5 py-2">
              {(finSnap?.upcomingBills || []).map((bill: any) => {
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
          </ScrollArea>
          <ViewPageLink href="/dashboard/obligations" label="View All Obligations" />
        </DialogContent>
      </Dialog>

      {/* Tasks Popup */}
      <TasksPopup open={popup === "tasks"} onClose={() => setPopup(null)} filterIds={filterIds} filterMode={filterMode} />

      {/* Expiring Documents Popup */}
      <Dialog open={popup === "docs"} onOpenChange={() => setPopup(null)}>
        <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <FileWarning className="h-4 w-4 text-amber-500" />
              Expiring Documents
              <Badge variant="secondary" className="ml-1">{enhanced?.expiringDocuments?.length || 0}</Badge>
            </DialogTitle>
            <DialogDescription className="text-xs">Documents with upcoming or past expiration dates</DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 max-h-[60vh]">
            <div className="space-y-1.5 py-2 pr-2">
              {(enhanced?.expiringDocuments || []).map((doc: any, i: number) => {
                const expired = doc.status === "expired";
                const expiringSoon = doc.status === "expiring_soon";
                return (
                  <div key={`${doc.documentId}-${i}`}
                    onClick={() => { setPopup(null); navigate(`/documents/${doc.documentId}`); }}
                    className={`flex items-center gap-2.5 p-2.5 rounded-lg cursor-pointer hover:bg-muted/60 transition-colors border ${
                      expired ? "border-red-500/30 bg-red-500/5" : expiringSoon ? "border-amber-500/30 bg-amber-500/5" : "border-border/50"
                    }`}>
                    <FileText className={`h-3.5 w-3.5 shrink-0 ${expired ? "text-red-500" : expiringSoon ? "text-amber-500" : "text-muted-foreground"}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{doc.documentName}</p>
                      <p className={`text-xs ${expired ? "text-red-500" : expiringSoon ? "text-amber-500" : "text-muted-foreground"}`}>
                        {doc.fieldName}: {fmtDate(doc.expirationDate)} ({daysUntilStr(doc.daysUntil)})
                      </p>
                    </div>
                    <Badge variant="outline" className={`shrink-0 text-xs-tight px-1.5 py-0 h-4 ${
                      expired ? "border-red-500/40 text-red-500" : expiringSoon ? "border-amber-500/40 text-amber-500" : ""
                    }`}>
                      {expired ? "Expired" : expiringSoon ? "Soon" : "Upcoming"}
                    </Badge>
                  </div>
                );
              })}
              {(!enhanced?.expiringDocuments || enhanced.expiringDocuments.length === 0) && (
                <div className="text-center py-6">
                  <FileText className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-xs text-muted-foreground">No expiring documents</p>
                </div>
              )}
            </div>
          </ScrollArea>
          <ViewPageLink href="/dashboard/documents" label="View All Documents" />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Tasks Popup ──────────────────────────────────────────────────────────────

function TasksPopup({ open, onClose, filterIds = [], filterMode = "everyone" }: { open: boolean; onClose: () => void; filterIds?: string[]; filterMode?: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: tasks = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/tasks", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/tasks${profileParam}`).then(r => r.json()),
    enabled: open,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, status, title }: { id: string; status: string; title?: string }) =>
      apiRequest("PATCH", `/api/tasks/${id}`, { status }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: variables.status === "done" ? `"${variables.title || "Task"}" completed` : `"${variables.title || "Task"}" reopened` });
    },
    onError: () => toast({ title: "Failed to update task", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title?: string }) => apiRequest("DELETE", `/api/tasks/${id}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: `"${variables.title || "Task"}" deleted` });
    },
    onError: () => toast({ title: "Failed to delete task", variant: "destructive" }),
  });

  const activeTasks = tasks.filter((t: any) => t.status !== "done").sort((a: any, b: any) => {
    const p: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (p[a.priority] ?? 2) - (p[b.priority] ?? 2);
  });
  const doneTasks = tasks.filter((t: any) => t.status === "done").slice(0, 5);
  const PRIORITY_CLR: Record<string, string> = { high: "text-red-500 border-red-500/40", medium: "text-amber-500 border-amber-500/40", low: "" };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <ListTodo className="h-4 w-4 text-primary" />
            Tasks
            <Badge variant="secondary" className="ml-1">{activeTasks.length} active</Badge>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="flex-1 max-h-[60vh]">
          {isLoading ? (
            <div className="space-y-2 py-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
          ) : (
            <div className="space-y-1 py-1 pr-2">
              {activeTasks.map((t: any) => (
                <div key={t.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors group">
                  <button onClick={() => toggleMutation.mutate({ id: t.id, status: "done", title: t.title })}
                    className="shrink-0 w-4 h-4 rounded border border-primary/40 hover:bg-primary/10 flex items-center justify-center">
                    {toggleMutation.isPending ? <span className="animate-spin h-2 w-2 border border-primary rounded-full border-t-transparent" /> : null}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate">{t.title}</p>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className={`text-xs-tight px-1 py-0 h-3.5 ${PRIORITY_CLR[t.priority] || ""}`}>{t.priority}</Badge>
                      {t.dueDate && <span className="text-xs-tight text-muted-foreground">{fmtDate(t.dueDate)}</span>}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteMutation.mutate({ id: t.id, title: t.title })} disabled={deleteMutation.isPending}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ))}
              {doneTasks.length > 0 && (
                <div className="pt-2 border-t border-border/30">
                  <p className="text-xs text-muted-foreground mb-1">{doneTasks.length} recently completed</p>
                  {doneTasks.map((t: any) => (
                    <div key={t.id} className="flex items-center gap-2 py-1 text-muted-foreground">
                      <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                      <span className="text-xs line-through truncate">{t.title}</span>
                    </div>
                  ))}
                </div>
              )}
              {activeTasks.length === 0 && doneTasks.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-6">No tasks yet</p>
              )}
            </div>
          )}
        </ScrollArea>
        <ViewPageLink href="/dashboard/tasks" label="View All Tasks" />
      </DialogContent>
    </Dialog>
  );
}

// ─── Section: Action Required (replaces NeedsAttention) ──────────────────────

function ActionRequiredSection({ stats, enhanced, profileId }: { stats: DashboardStats; enhanced: any; profileId?: string }) {
  const { toast } = useToast();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const overdueTasks: any[] = useMemo(() => {
    const raw: any[] = enhanced?.overdueTasks || [];
    return raw.filter((t: any) => !dismissedIds.has(`task-${t.id}`));
  }, [enhanced, dismissedIds]);

  const overdueBills: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil < 0);
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

  const dismiss = (key: string) => setDismissedIds(prev => new Set([...prev, key]));

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
              <button onClick={() => handleSnooze(id)} title="Snooze"
                className="h-5 w-5 rounded flex items-center justify-center hover:bg-amber-500/20 text-amber-600">
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
          <ScrollArea className="h-[calc(100vh-120px)] mt-4">
            <div className="space-y-0.5 pr-2">
              {allItems.map((item) => (
                <AttentionItem key={`sheet-${item.sourceType}-${item.id}`} {...item} />
              ))}
            </div>
          </ScrollArea>
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
                {ev.time || "All day"}
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

  const filteredData = (data || []).filter((item: any) => !/test/i.test(item.name)).slice(0, 4);

  if (!data || data.length === 0) return (
    <CollapsibleSection accent="173 60% 44%" icon={HeartPulse} label="Health" testId="section-health">
      <div className="rounded-lg border border-dashed border-border/50 p-4 text-center">
        <Heart className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground mb-1">No health data yet</p>
        <p className="text-xs text-muted-foreground/70">Tell the AI: "Log my blood pressure" or "I weigh 180 lbs"</p>
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
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      toast({ title: `"${variables.name || "Bill"}" marked paid`, description: variables.amount ? `$${variables.amount.toFixed(2)} payment recorded` : undefined });
      setSelectedBill(null);
    },
    onError: (_err, variables) => toast({ title: `Failed to mark "${variables.name || "bill"}" as paid`, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name?: string }) => apiRequest("DELETE", `/api/obligations/${id}`),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      toast({ title: `"${variables.name || "Obligation"}" deleted` });
      setSelectedBill(null);
    },
    onError: (_err, variables) => toast({ title: `Failed to delete "${variables.name || "obligation"}"`, variant: "destructive" }),
  });

  // Group bills by timeframe
  const overdueBills = (data || []).filter((b: any) => b.daysUntil < 0);
  const thisWeekBills = (data || []).filter((b: any) => b.daysUntil >= 0 && b.daysUntil <= 7);
  const thisMonthBills = (data || []).filter((b: any) => b.daysUntil > 7 && b.daysUntil <= 30);

  const monthlyTotal = (data || []).reduce((sum: number, b: any) => sum + (b.amount || 0), 0);

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
            {bills.map((bill: any) => (
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
  const isComplete = goal.status === "completed" || pct >= 100;
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
        const isAtRisk = daysLeft !== null && daysLeft <= 30 && pct < 50 && goal.status === 'active';
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
        {daysLeft != null && daysLeft <= 0 && goal.status === "active" && <span className="text-destructive">overdue</span>}
      </div>
    </div>
  );
}

function GoalsSection({ profileId }: { profileId?: string }) {
  const profileParam = profileId ? `?profileId=${profileId}` : "";
  const { data: goals = [], isLoading, error: goalsError } = useQuery<GoalItem[]>({
    queryKey: ["/api/goals", profileId || "all"],
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
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      setEditGoal(null);
      toast({ title: `"${variables.title || "Goal"}" deleted` });
    },
    onError: (_err: Error, variables) => toast({ title: `Failed to delete "${variables.title || "goal"}"`, variant: "destructive" }),
  });

  const resetForm = () => { setFormTitle(""); setFormTarget(""); setFormUnit(""); setFormDeadline(""); setFormType("custom"); };
  const openEdit = (g: GoalItem) => { setEditGoal(g); setFormTitle(g.title); setFormTarget(String(g.target)); setFormUnit(g.unit); setFormDeadline(g.deadline || ""); setFormType(g.type); };
  const openCreate = () => { resetForm(); setCreating(true); };

  const handleSave = () => {
    if (!formTitle.trim() || !formTarget) return;
    const payload = { title: formTitle.trim(), type: formType, target: Number(formTarget), unit: formUnit || "units", deadline: formDeadline || undefined };
    if (editGoal) updateMutation.mutate({ id: editGoal.id, ...payload });
    else createMutation.mutate(payload);
  };

  const [actionGoal, setActionGoal] = useState<GoalItem | null>(null);
  const [progressInput, setProgressInput] = useState("");
  const activeGoals = goals.filter(g => g.status === "active");
  const completedGoals = goals.filter(g => g.status === "completed");

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
        ) : (
          <div className="space-y-1">
            {activeGoals.map(g => {
              const goalCurrent = g.current || g.startValue || 0;
              const pct = g.target > 0 ? Math.min(100, Math.round((goalCurrent / g.target) * 100)) : 0;
              const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 86400000) : null;
              const isAtRisk = daysLeft !== null && daysLeft <= 30 && pct < 50 && daysLeft > 0;
              const isOverdue = daysLeft !== null && daysLeft < 0;
              const isCompleted = pct >= 100;
              return (
                <div key={g.id}
                  className={`flex items-center gap-2 py-1.5 px-1.5 rounded-lg group transition-colors ${
                    isOverdue ? 'bg-red-500/5 border border-red-500/20' :
                    isAtRisk ? 'bg-amber-500/5 border border-amber-500/20' :
                    isCompleted ? 'bg-green-500/5 border border-green-500/20 goal-celebrate' :
                    'border border-transparent'
                  }`}
                  data-testid={`goal-card-${g.id}`}>
                  {/* Tap to mark complete */}
                  <button
                    className="h-5 w-5 rounded-full border-2 border-primary/40 flex items-center justify-center shrink-0 hover:bg-green-500/20 hover:border-green-500 active:scale-90 transition-all"
                    onClick={() => updateMutation.mutate({ id: g.id, status: "completed" })}
                    title="Mark complete"
                  >
                    <Check className="h-2.5 w-2.5 text-transparent group-hover:text-green-500" />
                  </button>
                  {/* Goal info — tap to open actions */}
                  <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setActionGoal(g)}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs-loose font-medium truncate">{g.title}{isCompleted && <span className="text-base ml-1" title="Goal complete!">🎉</span>}</span>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        {isOverdue && <span className="text-[9px] font-bold text-red-500">OVERDUE</span>}
                        {isAtRisk && <span className="text-[9px] font-bold text-amber-500">AT RISK</span>}
                        <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-700"
                          style={{
                            width: `${pct}%`,
                            background: isCompleted ? 'linear-gradient(90deg,#10b981,#34d399)' :
                              isAtRisk || isOverdue ? 'linear-gradient(90deg,#f59e0b,#ef4444)' :
                              'linear-gradient(90deg,hsl(188 70% 48%),hsl(155 60% 44%))'
                          }} />
                      </div>
                      {daysLeft !== null && daysLeft >= 0 && <span className={`text-xs-tight shrink-0 ${isAtRisk ? 'text-amber-500 font-medium' : 'text-muted-foreground'}`}>{daysLeft}d left</span>}
                      {isOverdue && <span className="text-xs-tight text-red-500 font-medium shrink-0">{Math.abs(daysLeft!)}d late</span>}
                    </div>
                  </div>
                </div>
              );
            })}
            {completedGoals.length > 0 && (
              <div className="pt-1.5 mt-1 border-t border-border/30">
                <p className="text-xs-tight text-muted-foreground mb-0.5">{completedGoals.length} completed</p>
                {completedGoals.slice(0, 2).map(g => (
                  <div key={g.id} className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground/60">
                    <CheckCircle2 className="h-3 w-3 text-green-500/60 shrink-0" />
                    <span className="line-through truncate">{g.title}</span>
                  </div>
                ))}
              </div>
            )}
            <Button size="sm" variant="outline" className="w-full h-7 text-xs mt-1" onClick={openCreate} data-testid="btn-add-goal">
              <Target className="h-3 w-3 mr-1" /> Add Goal
            </Button>
          </div>
        )}
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
                    <SelectItem value="weight_loss">Weight Loss</SelectItem>
                    <SelectItem value="weight_gain">Weight Gain</SelectItem>
                    <SelectItem value="savings">Savings</SelectItem>
                    <SelectItem value="spending_limit">Spending Limit</SelectItem>
                    <SelectItem value="fitness_distance">Fitness Distance</SelectItem>
                    <SelectItem value="fitness_frequency">Fitness Frequency</SelectItem>
                    <SelectItem value="tracker_target">Tracker Target</SelectItem>
                    <SelectItem value="habit_streak">Habit Streak</SelectItem>
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
            {editGoal && editGoal.status === "active" && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => updateMutation.mutate({ id: editGoal.id, status: "completed" })} disabled={updateMutation.isPending} data-testid="btn-complete-goal">
                <Check className="h-3 w-3 mr-1" /> {updateMutation.isPending ? "Completing…" : "Complete"}
              </Button>
            )}
            <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} data-testid="btn-save-goal">
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
  "food", "transport", "health", "pet", "vehicle", "entertainment",
  "shopping", "utilities", "housing", "insurance", "subscription",
  "education", "personal", "general",
];

function BudgetManager() {
  const [month, setMonth] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7));
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [newCat, setNewCat] = useState("");
  const [newAmt, setNewAmt] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const { data: budgetRes, refetch } = useQuery<{month: string; budgets: any[]}>({
    queryKey: ["/api/budgets", month],
    queryFn: () => apiRequest("GET", `/api/budgets?month=${month}`).then(r => r.json()),
  });

  const { data: expensesData } = useQuery<any>({
    queryKey: ["/api/expenses"],
    queryFn: () => apiRequest("GET", "/api/expenses").then(r => r.json()),
  });

  const budgets = budgetRes?.budgets || [];
  const allExpenses = Array.isArray(expensesData) ? expensesData : (expensesData?.items || []);
  const monthExpenses = allExpenses.filter((e: any) => e.date?.startsWith(month));
  const byCategory: Record<string, number> = {};
  monthExpenses.forEach((e: any) => { byCategory[e.category || "general"] = (byCategory[e.category || "general"] || 0) + e.amount; });

  const totalBudget = budgets.reduce((s: number, b: any) => s + b.amount, 0);
  const totalSpent = monthExpenses.reduce((s: number, e: any) => s + e.amount, 0);

  const addMutation = useMutation({
    mutationFn: (data: {category: string; amount: number; notes?: string}) =>
      apiRequest("POST", "/api/budgets", { month, ...data }).then(r => r.json()),
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); setAddOpen(false); setNewCat(""); setNewAmt(""); setNewNotes(""); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/budgets/${id}?month=${month}`),
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); },
  });

  const updateMutation = useMutation({
    mutationFn: (data: {id: string; amount: number}) =>
      apiRequest("PATCH", `/api/budgets/${data.id}?month=${month}`, { amount: data.amount }),
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); setEditId(null); },
  });

  const copyMutation = useMutation({
    mutationFn: () => {
      const [y, m] = month.split("-").map(Number);
      const prevDate = new Date(y, m - 2, 1);
      const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}`;
      return apiRequest("POST", "/api/budgets/copy", { fromMonth: prevMonth, toMonth: month }).then(r => r.json());
    },
    onSuccess: () => { refetch(); queryClient.invalidateQueries({ queryKey: ["/api/budgets/summary"] }); },
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
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={prevMonth}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm font-medium">{monthLabel}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={nextMonth}><ChevronRight className="h-4 w-4" /></Button>
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
      {budgets.length > 0 && (
        <div className="space-y-1.5">
          {budgets.map((b: any) => {
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
                        <Input name="amt" type="number" defaultValue={b.amount} className="h-6 w-20 text-xs" step="0.01" autoFocus />
                        <Button type="submit" variant="ghost" size="icon" className="h-5 w-5"><Check className="h-3 w-3" /></Button>
                      </form>
                    ) : (
                      <>
                        <span className="text-xs tabular-nums">${actual.toLocaleString()} / ${b.amount.toLocaleString()}</span>
                        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => setEditId(b.id)} data-testid={`edit-budget-${b.category}`}>
                          <Pencil className="h-2.5 w-2.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-5 w-5 text-destructive" onClick={() => deleteMutation.mutate(b.id)} data-testid={`delete-budget-${b.category}`}>
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
            {unbudgeted.map(([cat, amt]) => (
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
            {availableCategories.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
          </select>
          <Input placeholder="Amount" type="number" value={newAmt} onChange={(e) => setNewAmt(e.target.value)} className="h-8 text-xs" step="0.01" />
          <Input placeholder="Notes (optional)" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} className="h-8 text-xs" />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs flex-1" disabled={!newCat || !newAmt} onClick={() => addMutation.mutate({ category: newCat, amount: parseFloat(newAmt), notes: newNotes || undefined })}>
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

  const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }).slice(0, 7);
  const { data: budgetData } = useQuery<{month: string; totalBudget: number; totalSpent: number; remaining: number; categories: any[]}>({
    queryKey: ["/api/budgets/summary", currentMonth],
    queryFn: async () => {
      const [budgetRes, expensesRes] = await Promise.all([
        apiRequest("GET", `/api/budgets?month=${currentMonth}`).then(r => r.json()),
        apiRequest("GET", "/api/expenses").then(r => r.json()),
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
    staleTime: 30000,
  });

  const monthlySpend = stats?.monthlySpend || 0;
  const monthlyIncome = (incomes || []).reduce((s, i) => s + (i.amount || 0), 0);
  const cashFlow = monthlyIncome - monthlySpend;
  const totalAssetValue = data?.totalAssetValue || 0;
  const totalLiabilities = data?.totalLiabilities || 0;
  const netWorth = totalAssetValue - totalLiabilities;
  const recentExpenses: any[] = data?.recentExpenses || [];

  // Build drill-down data — use profile-filtered monthlyExpenseRecords from enhanced API
  const now = new Date();
  const monthExpenses: any[] = data?.monthlyExpenseRecords || [];
  const byCategory: Record<string, number> = {};
  monthExpenses.forEach((e: any) => { byCategory[e.category || "general"] = (byCategory[e.category || "general"] || 0) + e.amount; });
  const assetProfiles = (allProfiles || []).filter((p: any) => {
    if (!(p.fields?.purchasePrice || p.fields?.value || p.fields?.currentValue)) return false;
    // Apply the same profile filter as everything else
    if (filterMode === "everyone" || filterIds.length === 0) return true;
    const pParent = p.fields?._parentProfileId || p.parentProfileId;
    if (pParent && filterIds.includes(pParent)) return true;
    return false;
  });

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
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => setDrill("spending")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Spending</p>
            <p className="text-sm font-bold tabular-nums text-red-400">${monthlySpend.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">{monthExpenses.length} this month</p>
          </button>
          <button onClick={() => setDrill("income")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Income</p>
            <p className="text-sm font-bold tabular-nums text-green-500">${monthlyIncome.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">{(incomes || []).length} sources</p>
          </button>
          <button onClick={() => setDrill("cashflow")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Cash Flow</p>
            <p className={`text-sm font-bold tabular-nums ${cashFlow >= 0 ? "text-green-500" : "text-red-500"}`}>
              {cashFlow >= 0 ? "+" : ""}${cashFlow.toLocaleString()}
            </p>
            <p className="text-xs-tight text-muted-foreground">income - spending</p>
          </button>
          <button onClick={() => setDrill("networth")} className="rounded-lg border border-border/40 bg-card p-2 text-center hover:bg-muted/50 active:scale-[0.97] transition-all cursor-pointer">
            <p className="text-xs text-muted-foreground">Net Worth</p>
            <p className={`text-sm font-bold tabular-nums ${netWorth >= 0 ? "text-green-500" : "text-red-500"}`}>${netWorth.toLocaleString()}</p>
            <p className="text-xs-tight text-muted-foreground">assets - liabilities</p>
            {/* Net Worth trend sparkline — uses estimated monthly snapshots */}
            {netWorth > 0 && (() => {
              const baseNW = netWorth;
              const mSpend = data?.totalMonthlySpend || monthlySpend || 0;
              const nwData = Array.from({length: 6}, (_, i) => ({
                month: new Date(Date.now() - (5-i) * 30 * 86400000).toLocaleDateString('en-US', {month:'short'}),
                value: Math.max(0, baseNW - mSpend * (5 - i) * 0.8)
              }));
              const isUp = nwData[5].value >= nwData[0].value;
              return (
                <div className="mt-2 px-1" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">6-Month Trend</span>
                    <span className={`text-[10px] font-bold ${isUp ? 'text-green-500' : 'text-red-400'}`}>{isUp ? '↑' : '↓'} Trending</span>
                  </div>
                  <ResponsiveContainer width="100%" height={40}>
                    <LineChart data={nwData} margin={{top:2,right:2,left:2,bottom:2}}>
                      <Line type="monotone" dataKey="value" stroke={isUp ? '#10b981' : '#ef4444'} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              );
            })()}
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
        {/* Spending donut chart */}
        {Object.keys(byCategory).length > 0 && (() => {
          const catData = Object.entries(byCategory)
            .sort(([,a],[,b]) => b-a).slice(0,8)
            .map(([name,value]) => ({name, value}));
          const COLORS = ["#06b6d4","#8b5cf6","#f59e0b","#10b981","#ef4444","#3b82f6","#f97316","#ec4899"];
          return (
            <div className="mb-3">
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} paddingAngle={2}>
                    {catData.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{background:'hsl(var(--card))',border:'1px solid hsl(var(--border))',borderRadius:'8px',fontSize:'11px'}}
                    formatter={(v:any) => [`$${Number(v).toFixed(2)}`]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          );
        })()}
        {/* Budget overflow bar */}
        {budgetData && budgetData.totalBudget > 0 && (() => {
          const usedPct = Math.round((budgetData.totalSpent / budgetData.totalBudget) * 100);
          return (
            <div className="my-2">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                <span>Budget Used</span>
                <span className={usedPct > 100 ? 'text-red-500 font-bold' : 'text-amber-500'}>{usedPct}%</span>
              </div>
              <div className="relative h-2 rounded-full overflow-visible" style={{background:'hsl(var(--muted))'}}>
                <div className="h-full rounded-full" style={{
                  width: `${Math.min(100, usedPct)}%`,
                  background: usedPct > 100 ? '#ef4444' : usedPct > 75 ? '#f59e0b' : '#10b981'
                }} />
                {usedPct > 100 && (
                  <div className="absolute right-0 top-0 h-full rounded-r-full animate-pulse"
                    style={{width:'8px', background:'#ef4444', transform:'translateX(100%)'}} />
                )}
              </div>
            </div>
          );
        })()}
        {recentExpenses.length > 0 && (
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-muted-foreground uppercase">Recent Expenses</p>
            {recentExpenses.slice(0, 5).map((exp: any) => (
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
      </div>

      {/* Spending Drill-Down */}
      <DrillDownDialog
        open={drill === "spending"}
        onClose={() => setDrill(null)}
        title="Monthly Spending"
        subtitle={`${now.toLocaleDateString("en-US", { month: "long", year: "numeric" })} • ${monthExpenses.length} expenses`}
        total={`$${monthlySpend.toLocaleString()}`}
        items={[
          ...Object.entries(byCategory).sort(([,a],[,b]) => b - a).map(([cat, amt]) => ({
            label: cat.charAt(0).toUpperCase() + cat.slice(1),
            value: `$${amt.toLocaleString()}`,
            sub: `${monthExpenses.filter(e => (e.category || "general") === cat).length} expenses`,
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
        items={(incomes || []).map((i: any) => ({
          label: i.description,
          value: `$${i.amount.toLocaleString()}`,
          sub: i.frequency,
          category: i.category,
        }))}
        emptyMessage="No income sources yet. Add them on the Finance page."
      />

      {/* Cash Flow Drill-Down */}
      <DrillDownDialog
        open={drill === "cashflow"}
        onClose={() => setDrill(null)}
        title="Cash Flow Breakdown"
        total={`${cashFlow >= 0 ? "+" : ""}$${cashFlow.toLocaleString()}`}
        items={[
          { label: "Total Income", value: `+$${monthlyIncome.toLocaleString()}`, sub: `${(incomes || []).length} sources`, category: "income" },
          { label: "Total Spending", value: `-$${monthlySpend.toLocaleString()}`, sub: `${monthExpenses.length} expenses`, category: "expense" },
          { label: "Monthly Bills", value: `-$${((allObligations || []).reduce((s: number, o: any) => s + (o.amount || 0), 0)).toLocaleString()}`, sub: `${(allObligations || []).length} obligations`, category: "obligation" },
          ...Object.entries(byCategory).sort(([,a],[,b]) => b - a).slice(0, 5).map(([cat, amt]) => ({
            label: `Spending: ${cat}`, value: `-$${amt.toLocaleString()}`, category: cat,
          })),
        ]}
        obligations={(allObligations || []).map((o: any) => ({
          id: o.id, name: o.name, amount: o.amount, frequency: o.frequency, nextDueDate: o.nextDueDate || o.dueDate,
        }))}
      />

      {/* Net Worth Drill-Down */}
      <DrillDownDialog
        open={drill === "networth"}
        onClose={() => setDrill(null)}
        title="Net Worth Breakdown"
        subtitle="Assets minus liabilities"
        total={`$${netWorth.toLocaleString()}`}
        items={[
          ...assetProfiles.map((p: any) => {
            const val = Number(p.fields?.purchasePrice || p.fields?.value || p.fields?.currentValue || 0);
            return { label: p.name, value: `$${val.toLocaleString()}`, sub: p.type, category: "asset" };
          }),
          ...((allObligations || []).filter((o: any) => o.fields?.remainingBalance || o.fields?.totalAmount).map((o: any) => {
            const val = Number(o.fields?.remainingBalance || o.fields?.totalAmount || 0);
            return { label: o.name, value: `-$${val.toLocaleString()}`, sub: "liability", category: "liability" };
          })),
        ]}
        obligations={(allObligations || []).map((o: any) => ({
          id: o.id, name: o.name, amount: o.amount, frequency: o.frequency, nextDueDate: o.nextDueDate || o.dueDate,
        }))}
        emptyMessage="No assets or liabilities tracked yet."
      />

      {/* Budget Dialog */}
      <Dialog open={drill === "budget"} onOpenChange={(open) => { if (!open) setDrill(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Target className="h-4 w-4" />
              Monthly Budget
            </DialogTitle>
          </DialogHeader>
          <BudgetManager />
        </DialogContent>
      </Dialog>
    </CollapsibleSection>
  );
}

// ─── Section: AI Summary ─────────────────────────────────────────────────────

function AISummaryWidget({ stats, enhanced }: { stats: DashboardStats | undefined; enhanced: any }) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastGenerated, setLastGenerated] = useState<string | null>(null);

  const generateSummary = async () => {
    setLoading(true);
    try {
      const resp = await apiRequest("POST", "/api/chat", {
        message: "Give me a brief daily summary of my current status. Include: tasks due today, habits completion, upcoming events, and any health or finance highlights. Keep it under 4 sentences. Be direct and specific with numbers.",
      });
      const data = await resp.json();
      setSummary(data.reply || "No summary available.");
      setLastGenerated(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    } catch {
      setSummary("Unable to generate summary right now.");
    } finally {
      setLoading(false);
    }
  };

  return summary ? (
    <CollapsibleSection accent="262 65% 62%" icon={Sparkles} label="AI Summary" testId="section-ai-summary">
      <div className="space-y-2">
        <p className="text-xs leading-relaxed">{summary}</p>
        <div className="flex items-center justify-between">
          {lastGenerated && <span className="text-xs text-muted-foreground">Generated at {lastGenerated}</span>}
          <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={generateSummary} disabled={loading}>
            <RotateCcw className={`h-2.5 w-2.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>
    </CollapsibleSection>
  ) : (
    <CollapsibleSection accent="262 65% 62%" icon={Sparkles} label="AI Summary" testId="section-ai-summary">
      <div className="flex flex-col items-center gap-2 py-3">
        <p className="text-xs text-muted-foreground">Get a personalized AI-powered daily briefing</p>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={generateSummary} disabled={loading}>
          {loading ? <><RotateCcw className="h-3 w-3 animate-spin" /> Generating...</> : <><Sparkles className="h-3 w-3" /> Generate Summary</>}
        </Button>
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

  const validActivities = (activities || []).filter(item => {
    const desc = item.description?.trim();
    return desc && desc.length > 0;
  }).slice(0, 5);

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
  { id: "kpis",             label: "Key Metrics",          icon: BarChart3,    visible: true, column: "full" },
  { id: "ai-summary",       label: "AI Summary",           icon: Sparkles,     visible: true, column: "full" },
  { id: "today",            label: "Today's Schedule",     icon: Calendar,     visible: true, column: "left" },
  { id: "needs-attention",  label: "Action Required",      icon: AlertTriangle,visible: true, column: "right" },
  { id: "health",           label: "Health",               icon: HeartPulse,   visible: true, column: "left" },
  { id: "finance",          label: "Finance",              icon: DollarSign,   visible: true, column: "right" },
  { id: "goals",            label: "Goals",                icon: Target,       visible: true, column: "left" },
  { id: "obligations",      label: "Bills & Subscriptions",icon: CreditCard,   visible: true, column: "right" },
  { id: "activity",         label: "Recent Activity",      icon: Activity,     visible: true, column: "full" },
];

const LAYOUT_VERSION = 2; // Bump when section structure changes

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
        <ScrollArea className="flex-1 -mx-6 px-6" style={{ maxHeight: "55vh" }}>
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
        </ScrollArea>
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

  // Fetch profiles for filter
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Compute stats profile param for API calls
  const statsProfileParam = filterIds.length > 0 ? '?profileIds=' + filterIds.join(',') : '';

  // Compute resolvedFilterId for backward compat with child components that take a single profileId
  const resolvedFilterId = filterMode === "everyone" ? undefined : (filterIds.length === 1 ? filterIds[0] : undefined);

  // Sync profile filter to module-level state for backward compat with sub-pages
  useEffect(() => {
    setDashboardProfileFilter(resolvedFilterId, resolvedFilterId ? (allProfiles.find((p: any) => p.id === resolvedFilterId)?.name || "") : "Everyone");
  }, [resolvedFilterId, allProfiles]);

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/stats", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/stats${statsProfileParam}`).then(r => r.json()),
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
      } catch { return null; }
    },
    retry: false,
  });

  // Load saved dashboard layout from preferences API
  const { data: savedLayoutData } = useQuery<{ value: string } | null>({
    queryKey: ["/api/preferences", "dashboard_layout"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/preferences/dashboard_layout");
        return res.json();
      } catch { return null; }
    },
    staleTime: 0,
  });

  const sections: DashboardSection[] =
    parseSavedLayout(savedLayoutData?.value ?? null) || DEFAULT_SECTIONS;

  const saveMutation = useMutation({
    mutationFn: (layout: DashboardSection[]) =>
      apiRequest("PUT", "/api/preferences/dashboard_layout", { value: serializeLayout(layout) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/preferences"] });
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
        content = <GoalsSection profileId={resolvedFilterId} />;
        break;
      case "obligations":
        content = <ObligationsSection data={enhanced?.financeSnapshot?.upcomingBills || []} />;
        break;
      case "finance":
        content = <FinanceWidget data={enhanced?.financeSnapshot} stats={stats} filterIds={filterIds} filterMode={filterMode} />;
        break;
      case "ai-summary":
        content = <AISummaryWidget stats={stats} enhanced={enhanced} />;
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
    <div className="h-full overflow-y-auto overflow-x-hidden px-2 py-3 md:p-4 space-y-3 max-w-full pb-24" style={{WebkitOverflowScrolling: 'touch'}} data-testid="page-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-muted-foreground">
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            </p>
            <MultiProfileFilter
              onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
              compact
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Desktop: individual buttons */}
          <div className="hidden sm:flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2 gap-1 text-xs"
              onClick={() => setCustomizeOpen(true)} data-testid="btn-customize">
              <Settings className="h-3 w-3" /> Customize
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2 gap-1 text-xs"
              onClick={handleExport} data-testid="btn-export">
              <Download className="h-3 w-3" /> Export
            </Button>
            <Button variant="outline" size="sm" className="h-7 px-2 gap-1 text-xs"
              onClick={() => setImportOpen(true)} data-testid="btn-import">
              <UploadCloud className="h-3 w-3" /> Import
            </Button>
          </div>
          {/* Mobile: overflow menu */}
          <div className="sm:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8" data-testid="btn-dashboard-menu">
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
      </div>

      {/* Import Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
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

      {/* Render sections in order: full-width before grid, then 2-col grid, then full-width after grid */}
      {(() => {
        // Split full-width into before-grid (kpis, ai-summary) and after-grid (activity, obligations)
        const afterGridIds = new Set(["activity"]);
        const beforeGrid = fullWidthSections.filter(s => !afterGridIds.has(s.id));
        const afterGrid = fullWidthSections.filter(s => afterGridIds.has(s.id));
        return (
          <>
            {beforeGrid.map(s => (
              <div key={s.id}>{renderSection(s.id)}</div>
            ))}

            {(leftSections.length > 0 || rightSections.length > 0) && (
              <div className="grid md:grid-cols-2 gap-3 mt-1">
                <div className="space-y-3">
                  {leftSections.map(s => <div key={s.id}>{renderSection(s.id)}</div>)}
                </div>
                <div className="space-y-3">
                  {rightSections.map(s => <div key={s.id}>{renderSection(s.id)}</div>)}
                </div>
              </div>
            )}

            {afterGrid.map(s => (
              <div key={s.id}>{renderSection(s.id)}</div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
