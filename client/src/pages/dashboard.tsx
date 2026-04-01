import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getProfileFilter, setDashboardProfileFilter, getDashboardProfileFilter } from "@/lib/profileFilter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  DashboardStats, MoodLevel,
} from "@shared/schema";
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

// ─── Shared UI Components ────────────────────────────────────────────────────

function CollapsibleSection({
  icon: Icon, label, count, sub, children, defaultOpen = true,
  testId, headerRight,
}: {
  icon: any; label: string; count?: number; sub?: string;
  children: React.ReactNode; defaultOpen?: boolean; testId?: string;
  headerRight?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card data-testid={testId}>
      <CardHeader className="py-2.5 px-3">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
          <h2 className="text-xs font-semibold">{label}</h2>
          {count !== undefined && (
            <Badge variant="secondary" className="text-[10px] h-4 px-1.5">{count}</Badge>
          )}
          {sub && <span className="text-[10px] text-muted-foreground ml-1">{sub}</span>}
          <div className="ml-auto flex items-center gap-1">
            {headerRight}
            <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0 text-muted-foreground hover:bg-muted rounded-full"
              onClick={() => setOpen(v => !v)}
              aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
              aria-expanded={open}
              data-testid={`btn-toggle-${label.toLowerCase().replace(/\s+/g, "-")}`}>
              {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && <CardContent className="px-2 pb-2 pt-0">{children}</CardContent>}
    </Card>
  );
}

function MiniStat({
  icon: Icon, label, value, sub, color, onClick, trend,
}: { icon: any; label: string; value: string | number; sub?: string; color?: string; onClick?: () => void; trend?: "up" | "down" | "flat" }) {
  return (
    <div
      className={`flex items-center gap-2 p-2.5 rounded-lg border border-border/50 transition-all duration-200 ${onClick ? "cursor-pointer hover:bg-muted/50 hover:border-primary/30 hover:scale-[1.02] hover:shadow-sm active:scale-[0.98]" : "hover:scale-[1.01]"}`}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `${label}: ${value}${sub ? ` (${sub})` : ""}` : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      data-testid={`stat-card-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-primary/8" style={color ? { backgroundColor: `${color}15` } : {}}>
        <Icon className="h-3.5 w-3.5" style={color ? { color } : { color: "hsl(var(--primary))" }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-muted-foreground leading-none mb-0.5">{label}</p>
        <div className="flex items-center gap-1">
          <p className="text-sm font-bold tabular-nums leading-none">{value}</p>
          {trend === "up" && <ArrowUp className="h-2.5 w-2.5 text-green-500" />}
          {trend === "down" && <ArrowDown className="h-2.5 w-2.5 text-red-500" />}
          {trend === "flat" && <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
        </div>
      </div>
      {sub && <span className="text-[9px] text-muted-foreground shrink-0">{sub}</span>}
      {onClick && <Eye className="h-2.5 w-2.5 text-muted-foreground/40 shrink-0" aria-hidden="true" />}
    </div>
  );
}

// Tailwind can't compile dynamic class names — use a static map
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
      className="flex items-center gap-1 text-[10px] text-primary hover:underline mt-2"
    >
      <ExternalLink className="h-2.5 w-2.5" /> {label}
    </button>
  );
}

// ─── Section: Needs Attention ────────────────────────────────────────────────

function NeedsAttentionSection({ stats, enhanced, profileId }: { stats: DashboardStats; enhanced: any; profileId?: string }) {
  const { toast } = useToast();
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Build overdue items from structured data only
  const overdueTasks: any[] = useMemo(() => {
    const raw: any[] = enhanced?.overdueTasks || [];
    return raw.filter((t: any) => !dismissedIds.has(`task-${t.id}`));
  }, [enhanced, dismissedIds]);

  const overdueBills: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil < 0);
    return raw.filter((b: any) => !dismissedIds.has(`bill-${b.id}`));
  }, [enhanced, dismissedIds]);

  // Due soon: next 7 days
  const soonTasks: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.tasksDueSoon || []).filter((t: any) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff >= 0 && diff <= 7;
    });
    // Also grab tasks with dueDate in the next 7 days from enhanced.overdueTasks exclusion
    const allTasks: any[] = enhanced?.upcomingTasks || [];
    const combined = [...raw, ...allTasks.filter((t: any) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff >= 0 && diff <= 7;
    })];
    // Dedupe by id
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

  // Upcoming: 8–30 days
  const upcomingTasks: any[] = useMemo(() => {
    const allTasks: any[] = enhanced?.upcomingTasks || [];
    return allTasks.filter((t: any) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate);
      d.setHours(0, 0, 0, 0);
      const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      return diff >= 8 && diff <= 30;
    }).filter((t: any) => !dismissedIds.has(`task-${t.id}`));
  }, [enhanced, dismissedIds, now]);

  const upcomingBills: any[] = useMemo(() => {
    const raw: any[] = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil >= 8 && b.daysUntil <= 30);
    return raw.filter((b: any) => !dismissedIds.has(`bill-${b.id}`));
  }, [enhanced, dismissedIds]);

  const totalCount = overdueTasks.length + overdueBills.length + soonTasks.length + soonBills.length + upcomingTasks.length + upcomingBills.length;

  const handleMarkComplete = async (taskId: string) => {
    try {
      await apiRequest("PATCH", `/api/tasks/${taskId}`, { status: "done" });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Task completed" });
    } catch {
      toast({ title: "Failed to complete task", variant: "destructive" });
    }
  };

  const handleSnooze = async (taskId: string) => {
    try {
      const newDate = new Date();
      newDate.setDate(newDate.getDate() + 7);
      await apiRequest("PATCH", `/api/tasks/${taskId}`, { dueDate: newDate.toISOString().slice(0, 10) });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Task snoozed 7 days" });
    } catch {
      toast({ title: "Failed to snooze task", variant: "destructive" });
    }
  };

  const dismiss = (key: string) => setDismissedIds(prev => new Set([...prev, key]));

  function AttentionItem({
    id, title, detail, badge, sourceType, accentColor,
  }: {
    id: string; title: string; detail: string; badge: string; sourceType: "task" | "bill";
    accentColor: string;
  }) {
    return (
      <div className="flex items-center gap-1.5 py-1.5 border-l-2 pl-2 pr-1" style={{ borderLeftColor: accentColor }}>
        <span className="text-[11px] font-medium truncate flex-1">{title}</span>
        <span className="text-[10px] text-muted-foreground shrink-0">{detail}</span>
        <span className="text-[9px] text-muted-foreground/50 shrink-0 w-7 text-center">{badge}</span>
        <div className="flex items-center gap-0 shrink-0">
          {sourceType === "task" && (
            <>
              <button
                onClick={() => handleMarkComplete(id)}
                title="Complete"
                className="h-6 w-6 rounded flex items-center justify-center hover:bg-green-500/20 text-green-600">
                <Check className="h-3 w-3" />
              </button>
              <button
                onClick={() => handleSnooze(id)}
                title="Snooze"
                className="h-6 w-6 rounded flex items-center justify-center hover:bg-amber-500/20 text-amber-600">
                <Clock className="h-3 w-3" />
              </button>
            </>
          )}
          <button
            onClick={() => dismiss(`${sourceType}-${id}`)}
            title="Dismiss"
            className="h-6 w-6 rounded flex items-center justify-center hover:bg-muted text-muted-foreground">
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
    );
  }

  function overdueDetail(item: any, type: "task" | "bill"): string {
    if (type === "bill") {
      const days = Math.abs(item.daysUntil);
      return `${days} day${days !== 1 ? "s" : ""} overdue${item.amount ? ` · ${formatMoney(item.amount)}` : ""}`;
    }
    if (!item.dueDate) return "Overdue";
    const d = new Date(item.dueDate);
    d.setHours(0, 0, 0, 0);
    const days = Math.ceil((now.getTime() - d.getTime()) / 86400000);
    return `${days} day${days !== 1 ? "s" : ""} overdue`;
  }

  function dueSoonDetail(item: any, type: "task" | "bill"): string {
    if (type === "bill") {
      const label = item.daysUntil === 0 ? "Today" : item.daysUntil === 1 ? "Tomorrow" : `in ${item.daysUntil}d`;
      return `${label}${item.amount ? ` · ${formatMoney(item.amount)}` : ""}`;
    }
    if (!item.dueDate) return "Due soon";
    const d = new Date(item.dueDate);
    d.setHours(0, 0, 0, 0);
    const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
    return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : `in ${diff}d`;
  }

  function upcomingDetail(item: any, type: "task" | "bill"): string {
    if (type === "bill") {
      return `in ${item.daysUntil}d${item.amount ? ` · ${formatMoney(item.amount)}` : ""}`;
    }
    if (!item.dueDate) return "Upcoming";
    const d = new Date(item.dueDate);
    d.setHours(0, 0, 0, 0);
    const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
    return `in ${diff}d`;
  }

  if (totalCount === 0) return (
    <CollapsibleSection icon={AlertTriangle} label="Needs Attention" testId="section-needs-attention">
      <div className="text-center py-6">
        <Check className="h-7 w-7 text-green-500/60 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">All clear — nothing needs attention right now</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <CollapsibleSection icon={AlertTriangle} label="Needs Attention" count={totalCount} testId="section-needs-attention">
      <div className="space-y-2">
        {/* Overdue */}
        {(overdueTasks.length > 0 || overdueBills.length > 0) && (
          <div>
            <p className="text-[10px] font-semibold text-red-500 uppercase tracking-wider flex items-center gap-1 mb-0.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" /> Overdue ({overdueTasks.length + overdueBills.length})
            </p>
            <div className="divide-y divide-border/30">
              {overdueTasks.map((t: any) => (
                <AttentionItem key={`task-${t.id}`} id={t.id} title={t.title}
                  detail={overdueDetail(t, "task")} badge="Task" sourceType="task"
                  accentColor="#ef4444" />
              ))}
              {overdueBills.map((b: any) => (
                <AttentionItem key={`bill-${b.id}`} id={b.id} title={b.name}
                  detail={overdueDetail(b, "bill")} badge="Bill" sourceType="bill"
                  accentColor="#ef4444" />
              ))}
            </div>
          </div>
        )}

        {/* Due Soon */}
        {(soonTasks.length > 0 || soonBills.length > 0) && (
          <div>
            <p className="text-[10px] font-semibold text-amber-500 uppercase tracking-wider flex items-center gap-1 mb-0.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" /> Due Soon ({soonTasks.length + soonBills.length})
            </p>
            <div className="divide-y divide-border/30">
              {soonTasks.map((t: any) => (
                <AttentionItem key={`task-${t.id}`} id={t.id} title={t.title}
                  detail={dueSoonDetail(t, "task")} badge="Task" sourceType="task"
                  accentColor="#f59e0b" />
              ))}
              {soonBills.map((b: any) => (
                <AttentionItem key={`bill-${b.id}`} id={b.id} title={b.name}
                  detail={dueSoonDetail(b, "bill")} badge="Bill" sourceType="bill"
                  accentColor="#f59e0b" />
              ))}
            </div>
          </div>
        )}

        {/* Upcoming */}
        {(upcomingTasks.length > 0 || upcomingBills.length > 0) && (
          <div>
            <p className="text-[10px] font-semibold text-blue-500 uppercase tracking-wider flex items-center gap-1 mb-0.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" /> Upcoming ({upcomingTasks.length + upcomingBills.length})
            </p>
            <div className="divide-y divide-border/30">
              {upcomingTasks.map((t: any) => (
                <AttentionItem key={`task-${t.id}`} id={t.id} title={t.title}
                  detail={upcomingDetail(t, "task")} badge="Task" sourceType="task"
                  accentColor="#3b82f6" />
              ))}
              {upcomingBills.map((b: any) => (
                <AttentionItem key={`bill-${b.id}`} id={b.id} title={b.name}
                  detail={upcomingDetail(b, "bill")} badge="Bill" sourceType="bill"
                  accentColor="#3b82f6" />
              ))}
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: Today ──────────────────────────────────────────────────────────

function TodaySection({ enhanced, stats }: { enhanced: any; stats: DashboardStats | undefined }) {
  const [, navigate] = useLocation();
  const events: any[] = enhanced?.todaysEvents || [];
  const overdueTasks: any[] = enhanced?.overdueTasks || [];
  const tasksDueToday: any[] = enhanced?.tasksDueToday || [];
  const todayBills: any[] = (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil === 0);

  const hasSchedule = events.length > 0;
  const hasDue = overdueTasks.length > 0 || tasksDueToday.length > 0 || todayBills.length > 0;

  if (!hasSchedule && !hasDue) return (
    <CollapsibleSection icon={Calendar} label="Today" testId="section-today">
      <div className="text-center py-4">
        <Calendar className="h-6 w-6 text-muted-foreground/30 mx-auto mb-1.5" />
        <p className="text-[10px] text-muted-foreground">Nothing scheduled for today</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <CollapsibleSection icon={Calendar} label="Today" testId="section-today"
      sub={new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {/* Schedule */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Schedule</p>
          {events.length === 0 ? (
            <p className="text-[10px] text-muted-foreground py-1">No events today</p>
          ) : (
            <div className="divide-y divide-border/30">
              {events.map((ev: any) => (
                <div key={ev.id}
                  onClick={() => navigate("/calendar")}
                  className="flex items-center gap-1.5 py-1.5 cursor-pointer hover:bg-muted/40 transition-colors rounded px-1 -mx-1">
                  <Clock className="h-3 w-3 text-primary shrink-0" />
                  <span className="text-[10px] font-medium text-primary tabular-nums shrink-0 w-10">
                    {ev.time || "All day"}
                  </span>
                  <span className="text-[11px] truncate flex-1">{ev.title}</span>
                  {ev.location && (
                    <span className="text-[9px] text-muted-foreground flex items-center gap-0.5 shrink-0">
                      <MapPin className="h-2 w-2" />{ev.location}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Due Items */}
        <div>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Needs Attention</p>
          <div className="divide-y divide-border/30">
            {/* Tasks due today */}
            {tasksDueToday.length > 0 && tasksDueToday.slice(0, 4).map((t: any) => (
              <div key={`today-${t.id}`}
                onClick={() => navigate("/dashboard/tasks")}
                className="flex items-center gap-1.5 py-1.5 border-l-2 border-primary/60 pl-2 cursor-pointer hover:bg-muted/40 transition-colors">
                <Target className="h-3 w-3 text-primary shrink-0" />
                <span className="text-[11px] truncate flex-1">{t.title}</span>
                <span className="text-[9px] text-primary/70 shrink-0">Today</span>
              </div>
            ))}
            {/* Overdue tasks */}
            {overdueTasks.length > 0 && overdueTasks.slice(0, 4).map((t: any) => (
              <div key={t.id}
                onClick={() => navigate("/dashboard/tasks")}
                className="flex items-center gap-1.5 py-1.5 border-l-2 border-red-500/60 pl-2 cursor-pointer hover:bg-muted/40 transition-colors">
                <ListTodo className="h-3 w-3 text-red-500 shrink-0" />
                <span className="text-[11px] truncate flex-1">{t.title}</span>
                <span className="text-[9px] text-red-500/70 shrink-0">Overdue</span>
              </div>
            ))}
            {todayBills.map((b: any) => (
              <div key={b.id}
                onClick={() => navigate("/dashboard/obligations")}
                className="flex items-center gap-1.5 py-1.5 border-l-2 border-amber-500/60 pl-2 cursor-pointer hover:bg-muted/40 transition-colors">
                <CreditCard className="h-3 w-3 text-amber-500 shrink-0" />
                <span className="text-[11px] truncate flex-1">{b.name}</span>
                <span className="text-[10px] font-medium text-amber-600 shrink-0">{formatMoney(b.amount)}</span>
              </div>
            ))}
          </div>
          {overdueTasks.length === 0 && tasksDueToday.length === 0 && todayBills.length === 0 && (
            <p className="text-[10px] text-muted-foreground py-1">All clear — nothing due today</p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: KPI Stats ──────────────────────────────────────────────────────

function KPISection({ stats, enhanced }: { stats: DashboardStats; enhanced: any }) {
  const [, navigate] = useLocation();
  const [popup, setPopup] = useState<"spending" | "bills" | "tasks" | "docs" | null>(null);

  if (!stats) return null;

  const finSnap = enhanced?.financeSnapshot;
  const spendTrend: "up" | "down" | "flat" = finSnap?.spendTrend > 0 ? "up" : finSnap?.spendTrend < 0 ? "down" : "flat";

  const moodConf = stats.currentMood ? MOOD_CONFIG[stats.currentMood] : null;
  const MoodIcon = moodConf?.icon || Meh;

  return (
    <>
      <CollapsibleSection icon={BarChart3} label="Key Metrics" testId="section-kpis">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          <MiniStat icon={ListTodo} label="Open Tasks" value={stats.activeTasks}
            onClick={() => setPopup("tasks")} />
          <MiniStat icon={DollarSign} label="Monthly Spend" value={formatMoney(stats.monthlySpend)}
            trend={spendTrend} onClick={() => setPopup("spending")} />
          <MiniStat icon={Flame} label="Habits Today" value={`${stats.habitCompletionRate}%`}
            sub={`${stats.totalHabits} tracked`}
            onClick={() => navigate("/dashboard/habits")} />
          <MiniStat icon={BookHeart} label="Journal Streak"
            value={`${stats.journalStreak}d`}
            sub={moodConf ? moodConf.label : journalStreakLabel(stats.journalStreak)}
            color={moodConf?.color}
            onClick={() => navigate("/dashboard/journal")} />
          <MiniStat icon={CreditCard} label="Upcoming Bills"
            value={stats.upcomingObligations}
            sub={formatMoney(stats.monthlyObligationTotal) + "/mo"}
            onClick={() => setPopup("bills")} />
          <MiniStat icon={FileWarning} label="Expiring Docs"
            value={enhanced?.expiringDocuments?.length || 0}
            sub={enhanced?.expiringDocuments?.[0] ? `next: ${fmtDateWithYear(enhanced.expiringDocuments[0].expirationDate)}` : "all clear"}
            color={enhanced?.expiringDocuments?.some((d: any) => d.status === 'expired') ? '#A13544' : enhanced?.expiringDocuments?.length > 0 ? '#BB653B' : undefined}
            onClick={() => setPopup("docs")} />
        </div>
      </CollapsibleSection>

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
              <p className="text-[10px] text-muted-foreground">
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
                      <p className={`text-[10px] ${urgent ? "text-red-500" : soon ? "text-amber-500" : "text-muted-foreground"}`}>
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
      <TasksPopup open={popup === "tasks"} onClose={() => setPopup(null)} />

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
                      <p className={`text-[10px] ${expired ? "text-red-500" : expiringSoon ? "text-amber-500" : "text-muted-foreground"}`}>
                        {doc.fieldName}: {fmtDate(doc.expirationDate)} ({daysUntilStr(doc.daysUntil)})
                      </p>
                    </div>
                    <Badge variant="outline" className={`shrink-0 text-[9px] px-1.5 py-0 h-4 ${
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
          <ViewPageLink href="/dashboard/artifacts" label="View All Documents" />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Tasks Popup ──────────────────────────────────────────────────────────────

function TasksPopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { id: profileId } = getDashboardProfileFilter();
  const profileParam = profileId ? `?profileId=${profileId}` : "";
  const { data: tasks = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/tasks", profileId || "all"],
    queryFn: () => apiRequest("GET", `/api/tasks${profileParam}`).then(r => r.json()),
    enabled: open,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiRequest("PATCH", `/api/tasks/${id}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
    onError: () => toast({ title: "Failed to update task", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Task deleted" });
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
                  <button onClick={() => toggleMutation.mutate({ id: t.id, status: "done" })}
                    className="shrink-0 w-4 h-4 rounded border border-primary/40 hover:bg-primary/10 flex items-center justify-center">
                    {toggleMutation.isPending ? <span className="animate-spin h-2 w-2 border border-primary rounded-full border-t-transparent" /> : null}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate">{t.title}</p>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className={`text-[9px] px-1 py-0 h-3.5 ${PRIORITY_CLR[t.priority] || ""}`}>{t.priority}</Badge>
                      {t.dueDate && <span className="text-[9px] text-muted-foreground">{fmtDate(t.dueDate)}</span>}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteMutation.mutate(t.id)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              ))}
              {doneTasks.length > 0 && (
                <div className="pt-2 border-t border-border/30">
                  <p className="text-[10px] text-muted-foreground mb-1">{doneTasks.length} recently completed</p>
                  {doneTasks.map((t: any) => (
                    <div key={t.id} className="flex items-center gap-2 py-1 text-muted-foreground">
                      <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                      <span className="text-[10px] line-through truncate">{t.title}</span>
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

// ─── Section: Upcoming ───────────────────────────────────────────────────────

function UpcomingSection({ enhanced, stats }: { enhanced: any; stats: DashboardStats | undefined }) {
  const [, navigate] = useLocation();

  // Merge upcoming items into a timeline
  const items: { date: string; daysUntil: number; type: string; icon: any; title: string; detail: string; route: string }[] = [];

  // Upcoming bills (next 14 days)
  for (const b of (enhanced?.financeSnapshot?.upcomingBills || []).filter((b: any) => b.daysUntil > 0 && b.daysUntil <= 14)) {
    items.push({
      date: b.dueDate, daysUntil: b.daysUntil, type: "bill",
      icon: CreditCard, title: b.name, detail: formatMoney(b.amount),
      route: "/dashboard/obligations",
    });
  }

  // Overdue tasks
  for (const t of (enhanced?.overdueTasks || []).slice(0, 5)) {
    items.push({
      date: t.dueDate, daysUntil: Math.ceil((new Date(t.dueDate).getTime() - Date.now()) / 86400000),
      type: "task", icon: ListTodo, title: t.title,
      detail: t.priority ? `${t.priority} priority` : "Task",
      route: "/dashboard/tasks",
    });
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil);
  const capped = items.slice(0, 12);

  if (capped.length === 0) return (
    <CollapsibleSection icon={CalendarClock} label="Coming Up" testId="section-upcoming">
      <div className="text-center py-4">
        <CalendarClock className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">Nothing coming up in the next 2 weeks</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <CollapsibleSection icon={CalendarClock} label="Coming Up" count={capped.length} testId="section-upcoming">
      <div className="space-y-1">
        {capped.map((item, i) => {
          const urgent = item.daysUntil <= 0;
          const soon = item.daysUntil <= 3 && item.daysUntil > 0;
          return (
            <div key={`${item.type}-${i}`}
              onClick={() => navigate(item.route)}
              className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer hover:bg-muted/60 transition-colors ${
                urgent ? "bg-red-500/5 border-l-2 border-red-500 pl-2" : ""
              }`}>
              {!urgent && (
                <Badge variant="outline" className={`shrink-0 text-[9px] px-1.5 py-0.5 h-5 min-w-[48px] justify-center tabular-nums ${
                  soon ? "border-amber-500/40 text-amber-500" : ""
                }`}>
                  {item.daysUntil === 0 ? "Today" : `${item.daysUntil}d`}
                </Badge>
              )}
              <item.icon className={`h-3 w-3 shrink-0 ${urgent ? "text-red-500" : "text-muted-foreground"}`} />
              <span className="text-xs truncate flex-1">{item.title}</span>
              <span className={`text-[10px] shrink-0 ${urgent ? "text-red-500" : "text-muted-foreground"}`}>{item.detail}</span>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: Trends ─────────────────────────────────────────────────────────

function TrendsSection({ stats, enhanced }: { stats: DashboardStats; enhanced: any }) {
  const finSnap = enhanced?.financeSnapshot;
  const healthSnap: any[] = enhanced?.healthSnapshot || [];

  // Spending trend
  const spendChange = finSnap?.spendTrend || 0;
  const spendDir: "up" | "down" | "flat" = spendChange > 0 ? "up" : spendChange < 0 ? "down" : "flat";

  // Top health tracker
  const topHealth = healthSnap[0];

  return (
    <CollapsibleSection icon={TrendingUp} label="Trends" testId="section-trends">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
        {/* Spending */}
        <div className="p-2.5 rounded-lg border border-border/50 space-y-1">
          <p className="text-[10px] text-muted-foreground">Spending</p>
          <div className="flex items-center gap-1">
            <p className="text-sm font-bold tabular-nums">{formatMoney(finSnap?.totalMonthlySpend || 0)}</p>
            <span className={`text-[10px] font-medium ${
              spendDir === "up" ? "text-red-500" : spendDir === "down" ? "text-green-500" : "text-muted-foreground"
            }`}>
              {spendDir === "up" ? "↑" : spendDir === "down" ? "↓" : "→"}
            </span>
          </div>
          <span className={`text-[10px] ${spendDir === "up" ? "text-red-500" : spendDir === "down" ? "text-green-500" : "text-muted-foreground"}`}>
            {spendChange !== 0 ? `${spendChange > 0 ? "+" : ""}${spendChange}%` : "No change"} vs last month
          </span>
        </div>

        {/* Health */}
        {topHealth && (
          <div className="p-2.5 rounded-lg border border-border/50 space-y-1">
            <p className="text-[10px] text-muted-foreground">{topHealth.name}</p>
            <div className="flex items-center gap-1">
              <p className="text-sm font-bold tabular-nums">{topHealth.latestValue}</p>
              {topHealth.unit && <span className="text-[10px] text-muted-foreground">{topHealth.unit}</span>}
              <span className={`text-[10px] font-medium ${
                topHealth.trend === "up" ? "text-green-500" :
                topHealth.trend === "down" ? "text-red-500" : "text-muted-foreground"
              }`}>
                {topHealth.trend === "up" ? "↑" : topHealth.trend === "down" ? "↓" : "→"}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">7-day avg: {topHealth.average}</span>
            </div>
          </div>
        )}

        {/* Habits */}
        <div className="p-2.5 rounded-lg border border-border/50 space-y-1">
          <p className="text-[10px] text-muted-foreground">Habits Today</p>
          <p className="text-sm font-bold tabular-nums">{stats.habitCompletionRate}%</p>
          <Progress value={stats.habitCompletionRate} className="h-1" />
        </div>

        {/* Mood */}
        {stats.currentMood && (
          <div className="p-2.5 rounded-lg border border-border/50 space-y-1">
            <p className="text-[10px] text-muted-foreground">Current Mood</p>
            <div className="flex items-center gap-1.5">
              {(() => { const m = MOOD_CONFIG[stats.currentMood!]; const MI = m.icon; return <MI className="h-4 w-4" style={{ color: m.color }} />; })()}
              <p className="text-sm font-bold">{MOOD_CONFIG[stats.currentMood].label}</p>
            </div>
          </div>
        )}

        {/* Journal */}
        <div className="p-2.5 rounded-lg border border-border/50 space-y-1">
          <p className="text-[10px] text-muted-foreground">Journal Streak</p>
          <p className="text-sm font-bold tabular-nums">{stats.journalStreak} days</p>
          <p className="text-[10px] text-muted-foreground">{stats.totalHabits} habits tracked</p>
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ─── Section: Health Snapshot ─────────────────────────────────────────────────

function HealthSection({ data }: { data: any[] }) {
  const [, navigate] = useLocation();
  const [selectedTracker, setSelectedTracker] = useState<any>(null);

  if (!data || data.length === 0) return (
    <CollapsibleSection icon={HeartPulse} label="Health" testId="section-health">
      <div className="text-center py-4">
        <Heart className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No health trackers yet</p>
      </div>
    </CollapsibleSection>
  );

  const filteredData = data.filter((item: any) => !/test/i.test(item.name));

  return (
    <>
      <CollapsibleSection icon={HeartPulse} label="Health" count={filteredData.length} testId="section-health">
        <div className="grid grid-cols-2 gap-2">
          {filteredData.slice(0, 6).map((item: any) => (
            <div key={item.trackerId}
              onClick={() => setSelectedTracker(item)}
              className="flex items-center gap-2 p-2 rounded-lg bg-muted/40 cursor-pointer hover:bg-muted/60 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-muted-foreground truncate" title={item.name}>{item.name}</p>
                <div className="flex items-center gap-1">
                  <span className="text-sm font-bold tabular-nums">{item.latestValue}</span>
                  {item.unit && <span className="text-[10px] text-muted-foreground">{item.unit}</span>}
                  <TrendIcon trend={item.trend} />
                  {item.trendValue > 0 && (
                    <span className={`text-[10px] ${item.trend === "up" ? "text-green-500" : item.trend === "down" ? "text-red-500" : "text-muted-foreground"}`}>
                      {item.trendValue}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-[9px] text-muted-foreground">avg: {item.average}</span>
            </div>
          ))}
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
    mutationFn: (id: string) => apiRequest("POST", `/api/obligations/${id}/pay`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Payment recorded" });
      setSelectedBill(null);
    },
    onError: () => toast({ title: "Failed to record payment", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/obligations/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Obligation deleted" });
      setSelectedBill(null);
    },
    onError: () => toast({ title: "Failed to delete obligation", variant: "destructive" }),
  });

  if (!data || data.length === 0) return (
    <CollapsibleSection icon={CreditCard} label="Bills & Subscriptions" testId="section-obligations">
      <div className="text-center py-4">
        <CreditCard className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No upcoming bills</p>
      </div>
    </CollapsibleSection>
  );

  return (
    <>
      <CollapsibleSection icon={CreditCard} label="Bills & Subscriptions" count={data.length} testId="section-obligations">
        <div className="space-y-1">
          {data.slice(0, 8).map((bill: any) => {
            const urgent = bill.daysUntil <= 3;
            const soon = bill.daysUntil <= 7;
            return (
              <div key={bill.id}
                onClick={() => setSelectedBill(bill)}
                className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-muted/60 transition-colors ${urgent ? "bg-red-500/5 border border-red-500/20" : soon ? "bg-amber-500/5 border border-amber-500/20" : "bg-muted/40"}`}>
                <CreditCard className={`h-3 w-3 shrink-0 ${urgent ? "text-red-500" : soon ? "text-amber-500" : "text-muted-foreground"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{bill.name}</p>
                  <p className={`text-[10px] ${urgent ? "text-red-500" : soon ? "text-amber-500" : "text-muted-foreground"}`}>
                    {daysUntilStr(bill.daysUntil)}
                    {bill.autopay && <span className="ml-1 text-green-500">• autopay</span>}
                  </p>
                </div>
                <span className="text-xs font-semibold tabular-nums shrink-0">{formatMoney(bill.amount)}</span>
              </div>
            );
          })}
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
            <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => selectedBill && payMutation.mutate(selectedBill.id)}
              disabled={payMutation.isPending}>
              <Check className="h-3 w-3 mr-1" /> Mark Paid
            </Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => selectedBill && deleteMutation.mutate(selectedBill.id)}
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
          <span className="text-[10px] text-muted-foreground shrink-0 ml-2">No target set</span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
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
        <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
          {isComplete ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 inline" /> : `${pct}%`}
        </span>
      </div>
      <Progress value={pct} className="h-1.5" />
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{goal.current} / {goal.target} {goal.unit}{(!goal.current && !isComplete) ? " · 0%" : ""}</span>
        {daysLeft != null && daysLeft > 0 && <span>{daysLeft}d left</span>}
        {daysLeft != null && daysLeft <= 0 && goal.status === "active" && <span className="text-destructive">overdue</span>}
      </div>
    </div>
  );
}

function GoalsSection({ profileId }: { profileId?: string }) {
  const profileParam = profileId ? `?profileId=${profileId}` : "";
  const { data: goals = [], isLoading } = useQuery<GoalItem[]>({
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
      setCreating(false); resetForm();
      toast({ title: "Goal created" });
    },
    onError: (e: Error) => toast({ title: "Failed to create goal", description: e.message, variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => apiRequest("PATCH", `/api/goals/${id}`, data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      setEditGoal(null); resetForm();
      toast({ title: "Goal updated" });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/goals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      setEditGoal(null);
      toast({ title: "Goal deleted" });
    },
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

  const activeGoals = goals.filter(g => g.status === "active");
  const completedGoals = goals.filter(g => g.status === "completed");

  if (isLoading) return <CollapsibleSection icon={Target} label="Goals" testId="section-goals"><div className="h-16 bg-muted animate-pulse rounded-lg" /></CollapsibleSection>;

  return (
    <>
      <CollapsibleSection icon={Target} label="Goals" count={activeGoals.length} testId="section-goals">
        {activeGoals.length === 0 && completedGoals.length === 0 ? (
          <div className="text-center py-4">
            <Target className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">No goals yet</p>
            <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={openCreate} data-testid="btn-create-first-goal">
              <Target className="h-3 w-3 mr-1" /> Set a Goal
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {activeGoals.map(g => (
              <div key={g.id} className="cursor-pointer hover:bg-muted/30 rounded-lg p-2 -mx-2 transition-colors" onClick={() => openEdit(g)} data-testid={`goal-card-${g.id}`}>
                <GoalProgressBar goal={g} />
              </div>
            ))}
            {completedGoals.length > 0 && (
              <div className="pt-2 border-t">
                <p className="text-[10px] text-muted-foreground mb-1">{completedGoals.length} completed</p>
                {completedGoals.slice(0, 3).map(g => (
                  <div key={g.id} className="flex items-center gap-2 py-1 text-xs">
                    <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                    <span className="text-muted-foreground/80">{g.title}</span>
                  </div>
                ))}
              </div>
            )}
            <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={openCreate} data-testid="btn-add-goal">
              <Target className="h-3 w-3 mr-1" /> Add Goal
            </Button>
          </div>
        )}
      </CollapsibleSection>

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
              <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => deleteMutation.mutate(editGoal.id)} disabled={deleteMutation.isPending} data-testid="btn-delete-goal">
                <Trash2 className="h-3 w-3 mr-1" /> Delete
              </Button>
            )}
            {editGoal && editGoal.status === "active" && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => updateMutation.mutate({ id: editGoal.id, status: "completed" })} data-testid="btn-complete-goal">
                <Check className="h-3 w-3 mr-1" /> Complete
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


// ─── Section: Recent Activity ────────────────────────────────────────────────

function ActivitySection({ activities }: { activities: DashboardStats["recentActivity"] }) {
  const [, navigate] = useLocation();
  const ACTIVITY_ROUTES: Record<string, string> = {
    tracker_entry: "/trackers",
    task_completed: "/dashboard/tasks",
    expense: "/dashboard/finance",
  };

  // Filter out empty descriptions
  const validActivities = (activities || []).filter(item => {
    const desc = item.description?.trim();
    return desc && desc.length > 0;
  }).slice(0, 10);

  if (validActivities.length === 0) return (
    <CollapsibleSection icon={Activity} label="Recent Activity" testId="section-activity">
      <div className="text-center py-4">
        <Activity className="h-7 w-7 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No recent activity</p>
      </div>
    </CollapsibleSection>
  );

  // Group by hour bucket
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
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-0.5 mt-1 first:mt-0">{group.hourLabel}</p>
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
  { id: "needs-attention", label: "Needs Attention", icon: AlertTriangle, visible: true, column: "full" },
  { id: "today", label: "Today", icon: Calendar, visible: true, column: "full" },
  { id: "kpis", label: "Key Metrics", icon: BarChart3, visible: true, column: "full" },
  { id: "upcoming", label: "Coming Up", icon: CalendarClock, visible: true, column: "full" },
  { id: "trends", label: "Trends", icon: TrendingUp, visible: true, column: "full" },
  { id: "health", label: "Health", icon: HeartPulse, visible: true, column: "left" },
  { id: "obligations", label: "Bills & Subscriptions", icon: CreditCard, visible: true, column: "left" },
  { id: "goals", label: "Goals", icon: Target, visible: true, column: "right" },
  { id: "activity", label: "Recent Activity", icon: Activity, visible: true, column: "right" },
];

function parseSavedLayout(saved: string | null): DashboardSection[] | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as DashboardSection[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const iconMap = new Map(DEFAULT_SECTIONS.map(s => [s.id, s.icon]));
    return parsed.map(s => ({ ...s, icon: iconMap.get(s.id) || Activity })).filter(s => iconMap.has(s.id));
  } catch {
    return null;
  }
}

function serializeLayout(sections: DashboardSection[]): string {
  return JSON.stringify(sections.map(({ id, label, visible, column }) => ({ id, label, visible, column })));
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
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${columnBadgeColor(section.column)}`}
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
  // When mode is "everyone" or multiple selected, pass undefined (show all)
  const resolvedFilterId = filterMode === "everyone" ? undefined : (filterIds.length === 1 ? filterIds[0] : undefined);

  // Sync profile filter to module-level state for backward compat with sub-pages
  useEffect(() => {
    setDashboardProfileFilter(resolvedFilterId, resolvedFilterId ? (allProfiles.find((p: any) => p.id === resolvedFilterId)?.name || "") : "Everyone");
  }, [resolvedFilterId, allProfiles]);

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/stats", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/stats${statsProfileParam}`).then(r => r.json()),
  });

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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await apiRequest("GET", "/api/export");
      clearTimeout(timeout);
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
      case "needs-attention":
        content = stats ? <NeedsAttentionSection stats={stats} enhanced={enhanced} profileId={resolvedFilterId} /> : null;
        break;
      case "today":
        content = <TodaySection enhanced={enhanced} stats={stats} />;
        break;
      case "kpis":
        content = statsLoading ? <SkeletonGrid cols={3} rows={2} h="h-14" /> :
          stats ? <KPISection stats={stats} enhanced={enhanced} /> : null;
        break;
      case "upcoming":
        content = <UpcomingSection enhanced={enhanced} stats={stats} />;
        break;
      case "trends":
        content = stats ? <TrendsSection stats={stats} enhanced={enhanced} /> : null;
        break;
      case "health":
        content = <HealthSection data={enhanced?.healthSnapshot || []} />;
        break;
      case "obligations":
        content = <ObligationsSection data={enhanced?.financeSnapshot?.upcomingBills || []} />;
        break;
      case "goals":
        content = <GoalsSection profileId={resolvedFilterId} />;
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
    <div className="h-full overflow-y-auto overflow-x-hidden p-3 md:p-4 space-y-2.5 max-w-full pb-24" style={{WebkitOverflowScrolling: 'touch'}} data-testid="page-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold">Dashboard</h1>
            <MultiProfileFilter
              onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
              compact
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
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

      {/* Full-width sections */}
      {fullWidthSections.map(s => (
        <div key={s.id}>{renderSection(s.id)}</div>
      ))}

      {/* Two-column layout */}
      {(leftSections.length > 0 || rightSections.length > 0) && (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-3">
            {leftSections.map(s => <div key={s.id}>{renderSection(s.id)}</div>)}
          </div>
          <div className="space-y-3">
            {rightSections.map(s => <div key={s.id}>{renderSection(s.id)}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}
