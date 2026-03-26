import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Activity, Users, ListTodo, DollarSign, Calendar, BarChart3, Flame, Brain,
  CreditCard, BookHeart, Sparkles, Smile, Meh, Frown, Zap, CheckSquare,
  FileText, TrendingDown, TrendingUp, AlertTriangle, Lightbulb, Heart,
  Check, Trophy, Clock, MapPin, Repeat, Star, AlertCircle, Building2,
  ChevronDown, ChevronUp, Droplets, BookOpen, Smartphone,
  Plus, Trash2, Pencil, X, ExternalLink, Eye, ShieldAlert, Wallet,
  HeartPulse, ArrowUp, ArrowDown, Minus, FileWarning, CalendarClock,
  Dog, Car, Home as HomeIcon, FileCheck, Upload, IdCard, Stethoscope, Shield,
  GraduationCap, PawPrint, Landmark, Package, Download, UploadCloud,
  EyeOff, GripVertical, Settings, RotateCcw, Target, Link2, RefreshCw,
} from "lucide-react";
import type {
  DashboardStats, Insight, Task, Habit, Obligation, CalendarEvent, JournalEntry, MoodLevel,
  Profile, Tracker, Expense, Artifact, Document, Goal,
} from "@shared/schema";

import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";

function formatMoney(n: number): string {
  return n % 1 === 0 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

// ─── Mood config ────────────────────────────────────────────────────────────

const MOOD_CONFIG: Record<MoodLevel, { icon: any; label: string; color: string; bg: string }> = {
  amazing: { icon: Sparkles, label: "Amazing", color: "#6DAA45", bg: "bg-green-500/10" },
  great:   { icon: Smile,    label: "Great",   color: "#5BAA6A", bg: "bg-emerald-500/10" },
  good:    { icon: Smile,    label: "Good",    color: "#4F98A3", bg: "bg-teal-500/10" },
  neutral: { icon: Meh,     label: "Neutral",  color: "#797876", bg: "bg-gray-500/10" },
  bad:     { icon: Frown,   label: "Bad",      color: "#BB653B", bg: "bg-orange-500/10" },
  awful:   { icon: Frown,   label: "Awful",    color: "#A13544", bg: "bg-red-500/10" },
};

// ─── Priority config ─────────────────────────────────────────────────────────

const PRIORITY_DOT: Record<string, string> = {
  low:    "bg-slate-400",
  medium: "bg-amber-400",
  high:   "bg-red-500",
};

const PRIORITY_BADGE: Record<string, string> = {
  low:    "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high:   "bg-red-500/10 text-red-600 dark:text-red-400",
};

// ─── Obligation category icons ────────────────────────────────────────────────

const OB_ICONS: Record<string, any> = {
  housing: Building2, loan: CreditCard, insurance: AlertTriangle,
  health: CheckSquare, investment: DollarSign,
};

// ─── Habit icon map ───────────────────────────────────────────────────────────

const HABIT_ICONS: Record<string, any> = {
  Droplets, Brain, BookOpen, Smartphone, Zap, Flame, Smile, Heart, Star,
};

// ─── Insight config ─────────────────────────────────────────────────────────

const INSIGHT_ICONS: Record<string, any> = {
  health_correlation: Heart,
  spending_trend:     DollarSign,
  reminder:           AlertTriangle,
  streak:             Flame,
  anomaly:            AlertTriangle,
  suggestion:         Lightbulb,
  habit_streak:       Flame,
  obligation_due:     CreditCard,
  mood_trend:         BookHeart,
};

const INSIGHT_COLORS: Record<string, string> = {
  positive: "text-green-500 bg-green-500/10",
  negative: "text-red-500 bg-red-500/10",
  warning:  "text-yellow-500 bg-yellow-500/10",
  info:     "text-blue-500 bg-blue-500/10",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d: string | Date) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDow(d: string) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2);
}

// ─── Collapsible Section Wrapper ──────────────────────────────────────────────

function CollapsibleSection({
  icon: Icon, label, count, sub, onAdd, children, defaultOpen = true,
  testId, noPadding, headerRight,
}: {
  icon: any; label: string; count?: number; sub?: string; onAdd?: () => void;
  children: React.ReactNode; defaultOpen?: boolean; testId?: string; noPadding?: boolean;
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
            {onAdd && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 shrink-0"
                onClick={onAdd}
                data-testid={`btn-add-${label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 shrink-0 text-muted-foreground"
              onClick={() => setOpen(v => !v)}
              data-testid={`btn-toggle-${label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {open && <CardContent className={noPadding ? "px-3 pb-2.5 pt-0" : "px-3 pb-2.5 pt-0"}>{children}</CardContent>}
    </Card>
  );
}

// ─── Mini Stat (compact inline metric) ──────────────────────────────────────

function MiniStat({
  icon: Icon, label, value, sub, color, onClick, trend,
}: { icon: any; label: string; value: string | number; sub?: string; color?: string; onClick?: () => void; trend?: "up" | "down" | "flat" }) {
  return (
    <div
      className={`flex items-center gap-2 p-2.5 rounded-lg border border-border/50 transition-all duration-200 ${onClick ? "cursor-pointer hover:bg-muted/50 hover:border-primary/30 hover:scale-[1.02] hover:shadow-sm active:scale-[0.98]" : "hover:scale-[1.01]"}`}
      onClick={onClick}
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
      {onClick && <Eye className="h-2.5 w-2.5 text-muted-foreground/40 shrink-0" />}
    </div>
  );
}

function SkeletonGrid({ cols = 4, rows = 1, h = "h-14" }: { cols?: number; rows?: number; h?: string }) {
  return (
    <div className={`grid grid-cols-2 md:grid-cols-${cols} gap-2`}>
      {Array.from({ length: cols * rows }).map((_, i) => (
        <Skeleton key={i} className={`${h} rounded-lg`} />
      ))}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ViewFullPageLink({ onClose, href }: { onClose: () => void; href: string }) {
  const [, navigate] = useLocation();
  return (
    <Button variant="ghost" size="sm" className="ml-auto h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground" onClick={() => { onClose(); navigate(href); }}>
      View Full Page <ExternalLink className="h-3 w-3 ml-1" />
    </Button>
  );
}

// ─── Stat Popup Dialogs ──────────────────────────────────────────────────────

function ProfilesListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: profiles = [], isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [addProfileOpen, setAddProfileOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Profile deleted" });
    },
  });

  const PROFILE_TYPE_ICONS: Record<string, any> = {
    person: Users, pet: Heart, vehicle: Star, account: DollarSign,
    property: Building2, subscription: CreditCard, medical: CheckSquare,
    self: Smile, loan: CreditCard, investment: TrendingUp, asset: Star,
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-profiles-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            All Profiles
            <Badge variant="secondary" className="ml-1">{profiles.length}</Badge>
            <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 p-0" onClick={() => setAddProfileOpen(true)} data-testid="button-add-profile">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No profiles yet. Use Chat to create one.</p>
          ) : (
            <div className="space-y-0.5">
              {profiles.map(p => {
                const Icon = PROFILE_TYPE_ICONS[p.type] || Users;
                return (
                  <div
                    key={p.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                    data-testid={`popup-profile-${p.id}`}
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      {p.avatar ? (
                        <img src={p.avatar} alt={p.name} className="w-8 h-8 rounded-full object-cover" />
                      ) : (
                        <Icon className="h-3.5 w-3.5 text-primary" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="text-[9px] h-3.5 px-1">{p.type}</Badge>
                        {p.tags.slice(0, 2).map((t, i) => (
                          <span key={i} className="text-[9px] text-muted-foreground">#{t}</span>
                        ))}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{fmtDate(p.createdAt)}</span>
                    <Button
                      size="sm" variant="ghost"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(p.id); }}
                      data-testid={`button-delete-profile-${p.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
        <ProfileAddDialog open={addProfileOpen} onClose={() => setAddProfileOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ProfileAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", type: "person" });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/profiles", { name: form.name, type: form.type, fields: {}, tags: [], notes: "" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Profile created" });
      onClose();
      setForm({ name: "", type: "person" });
    },
    onError: () => toast({ title: "Error", description: "Failed to create profile", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-add-profile">
        <DialogHeader><DialogTitle>Add Profile</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Mom, Max, Netflix" required data-testid="input-add-profile-name" /></div>
          <div className="space-y-1"><Label>Type</Label>
            <Select value={form.type} onValueChange={v => setForm(f => ({...f, type: v}))}>
              <SelectTrigger data-testid="select-add-profile-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["person","pet","vehicle","account","property","subscription","medical","loan","investment","asset"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TrackerAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", category: "health", unit: "" });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/trackers", { name: form.name, category: form.category, fields: [{ name: form.unit || "value", type: "number" }], tags: [], entries: [] });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Tracker created" });
      onClose();
      setForm({ name: "", category: "health", unit: "" });
    },
    onError: () => toast({ title: "Error", description: "Failed to create tracker", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-add-tracker">
        <DialogHeader><DialogTitle>Add Tracker</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={form.name} onChange={e => setForm((f: any) => ({...f, name: e.target.value}))} placeholder="e.g. Weight, Blood Pressure" required data-testid="input-add-tracker-name" /></div>
          <div className="space-y-1"><Label>Category</Label>
            <Select value={form.category} onValueChange={v => setForm((f: any) => ({...f, category: v}))}>
              <SelectTrigger data-testid="select-add-tracker-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["health","fitness","nutrition","sleep","finance","custom"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>Unit</Label><Input value={form.unit} onChange={e => setForm((f: any) => ({...f, unit: e.target.value}))} placeholder="e.g. kg, bpm, hours" data-testid="input-add-tracker-unit" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TrackersListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: trackers = [], isLoading } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers"],
    queryFn: () => apiRequest("GET", "/api/trackers").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [addTrackerOpen, setAddTrackerOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/trackers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Tracker deleted" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-trackers-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4 text-primary" />
            All Trackers
            <Badge variant="secondary" className="ml-1">{trackers.length}</Badge>
            <Button size="sm" variant="ghost" className="ml-auto h-6 w-6 p-0" onClick={() => setAddTrackerOpen(true)} data-testid="button-add-tracker">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
          ) : trackers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No trackers yet. Use Chat to create one.</p>
          ) : (
            <div className="space-y-0.5">
              {trackers.map(t => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                  data-testid={`popup-tracker-${t.id}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <BarChart3 className="h-3.5 w-3.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px] h-3.5 px-1">{t.category}</Badge>
                      <span className="text-[10px] text-muted-foreground">{t.entries.length} entries</span>
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{t.fields.length} {t.fields.length === 1 ? 'field' : 'fields'}</span>
                  <Button
                    size="sm" variant="ghost"
                    className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteMutation.mutate(t.id)}
                    data-testid={`button-delete-tracker-${t.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        <TrackerAddDialog open={addTrackerOpen} onClose={() => setAddTrackerOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function TasksListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
    enabled: open,
  });
  const { toast } = useToast();
  const [editTask, setEditTask] = useState<Task | null>(null);

  const toggleMutation = useMutation({
    mutationFn: async (task: Task) => {
      const newStatus = task.status === "done" ? "todo" : "done";
      const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: newStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Task deleted" });
    },
  });

  const active = tasks.filter(t => t.status !== "done");
  const done = tasks.filter(t => t.status === "done");

  return (
    <>
      <Dialog open={open && !editTask} onOpenChange={o => { if (!o) onClose(); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-tasks-list">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ListTodo className="h-4 w-4 text-primary" />
              All Tasks
              <Badge variant="secondary" className="ml-1">{tasks.length}</Badge>
              <span className="text-xs text-muted-foreground font-normal ml-1">{active.length} active</span>
              <ViewFullPageLink onClose={onClose} href="/dashboard/tasks" />
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-2">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
            ) : tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No tasks yet.</p>
            ) : (
              <div className="space-y-0.5">
                {active.length > 0 && (
                  <p className="text-[10px] font-semibold uppercase text-muted-foreground px-2 pt-1 pb-1">Active</p>
                )}
                {active.map(t => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-muted/40 transition-colors group"
                    data-testid={`popup-task-${t.id}`}
                  >
                    <Checkbox
                      checked={false}
                      onCheckedChange={() => toggleMutation.mutate(t)}
                      className="shrink-0"
                    />
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditTask(t)}>
                      <p className="text-sm leading-tight">{t.title}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[t.priority]}`} />
                        <span className={`text-[10px] ${PRIORITY_BADGE[t.priority]}`}>{t.priority}</span>
                        {t.dueDate && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Calendar className="h-2.5 w-2.5" />{fmtDate(t.dueDate)}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm" variant="ghost"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => deleteMutation.mutate(t.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                {done.length > 0 && (
                  <p className="text-[10px] font-semibold uppercase text-muted-foreground px-2 pt-3 pb-1">Completed</p>
                )}
                {done.map(t => (
                  <div
                    key={t.id}
                    className="flex items-center gap-2.5 py-1.5 px-2 rounded-lg hover:bg-muted/40 transition-colors opacity-50 group"
                    data-testid={`popup-task-done-${t.id}`}
                  >
                    <Checkbox
                      checked={true}
                      onCheckedChange={() => toggleMutation.mutate(t)}
                      className="shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-tight line-through text-muted-foreground">{t.title}</p>
                    </div>
                    <Button
                      size="sm" variant="ghost"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => deleteMutation.mutate(t.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
      {editTask && (
        <TaskDialog
          open={!!editTask}
          onClose={() => { setEditTask(null); }}
          initial={{
            title: editTask.title,
            description: editTask.description ?? "",
            priority: editTask.priority,
            dueDate: editTask.dueDate ?? "",
          }}
          taskId={editTask.id}
        />
      )}
    </>
  );
}

function SpendingListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: expenses = [], isLoading } = useQuery<Expense[]>({
    queryKey: ["/api/expenses"],
    queryFn: () => apiRequest("GET", "/api/expenses").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [editExpense, setEditExpense] = useState<any>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/expenses/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Expense deleted" });
    },
  });

  const sorted = [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const total = expenses.reduce((s, e) => s + e.amount, 0);

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-spending-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <DollarSign className="h-4 w-4 text-primary" />
            All Expenses
            <Badge variant="secondary" className="ml-1">{expenses.length}</Badge>
            <span className="text-xs text-muted-foreground font-normal ml-1">${total.toFixed(2)} total</span>
            <ViewFullPageLink onClose={onClose} href="/dashboard/finance" />
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No expenses logged yet.</p>
          ) : (
            <div className="space-y-0.5">
              {sorted.map(e => (
                <div
                  key={e.id}
                  className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                  data-testid={`popup-expense-${e.id}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center shrink-0">
                    <DollarSign className="h-3.5 w-3.5 text-orange-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{e.description}</p>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px] h-3.5 px-1">{e.category}</Badge>
                      {e.vendor && <span className="text-[10px] text-muted-foreground">{e.vendor}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold">${e.amount.toFixed(2)}</p>
                    <p className="text-[10px] text-muted-foreground">{fmtDate(e.date)}</p>
                  </div>
                  <Button
                    size="sm" variant="ghost"
                    className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground shrink-0"
                    onClick={() => setEditExpense(e)}
                    data-testid={`button-edit-expense-${e.id}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteMutation.mutate(e.id)}
                    data-testid={`button-delete-expense-${e.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
      {editExpense && <ExpenseEditDialog open={!!editExpense} onClose={() => setEditExpense(null)} expense={editExpense} />}
    </Dialog>
  );
}

type ExpenseFormData = { amount: string; description: string; category: string; vendor: string };

function ExpenseEditDialog({ open, onClose, expense }: { open: boolean; onClose: () => void; expense: any }) {
  const { toast } = useToast();
  const [form, setForm] = useState<ExpenseFormData>({
    amount: expense?.amount?.toString() ?? "",
    description: expense?.description ?? "",
    category: expense?.category ?? "general",
    vendor: expense?.vendor ?? "",
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/expenses/${expense.id}`, {
        amount: parseFloat(form.amount), description: form.description, category: form.category, vendor: form.vendor,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Expense updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-expense">
        <DialogHeader><DialogTitle>Edit Expense</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Amount</Label><Input type="number" step="0.01" value={form.amount} onChange={e => setForm((f: any) => ({...f, amount: e.target.value}))} data-testid="input-edit-expense-amount" /></div>
            <div className="space-y-1"><Label>Category</Label>
              <Select value={form.category} onValueChange={v => setForm((f: any) => ({...f, category: v}))}>
                <SelectTrigger data-testid="select-edit-expense-cat"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["food","transport","entertainment","utilities","housing","health","shopping","general"].map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1"><Label>Description</Label><Input value={form.description} onChange={e => setForm((f: any) => ({...f, description: e.target.value}))} data-testid="input-edit-expense-desc" /></div>
          <div className="space-y-1"><Label>Vendor</Label><Input value={form.vendor} onChange={e => setForm((f: any) => ({...f, vendor: e.target.value}))} data-testid="input-edit-expense-vendor" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HabitsListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: habits = [], isLoading } = useQuery<Habit[]>({
    queryKey: ["/api/habits"],
    queryFn: () => apiRequest("GET", "/api/habits").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [editHabit, setEditHabit] = useState<any>(null);
  const [addHabitOpen, setAddHabitOpen] = useState(false);

  const checkinMutation = useMutation({
    mutationFn: async (habit: Habit) => {
      const today = new Date().toISOString().slice(0, 10);
      await apiRequest("POST", `/api/habits/${habit.id}/checkin`, { date: today });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/habits/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Habit deleted" });
    },
  });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-habits-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Flame className="h-4 w-4 text-orange-500" />
            All Habits
            <Badge variant="secondary" className="ml-1">{habits.length}</Badge>
            <ViewFullPageLink onClose={onClose} href="/dashboard/habits" />
            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => setAddHabitOpen(true)} data-testid="button-add-habit"><Plus className="h-3 w-3 mr-0.5" />Add</Button>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
          ) : habits.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No habits yet.</p>
          ) : (
            <div className="space-y-0.5">
              {habits.map(h => {
                const Icon = HABIT_ICONS[h.icon || ""] || Flame;
                const color = h.color || "#4F98A3";
                const checkedToday = h.checkins.some(c => c.date === today);
                const last7 = Array.from({ length: 7 }, (_, i) => {
                  const d = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
                  return { date: d, done: h.checkins.some(c => c.date === d) };
                });

                return (
                  <div
                    key={h.id}
                    className="flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                    data-testid={`popup-habit-${h.id}`}
                  >
                    <div className="p-1.5 rounded-md shrink-0" style={{ backgroundColor: `${color}20` }}>
                      <Icon className="h-3.5 w-3.5" style={{ color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{h.name}</span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5 shrink-0">
                          <Flame className="h-2.5 w-2.5 text-orange-500" />{h.currentStreak}d
                        </span>
                      </div>
                      <div className="flex gap-0.5 mt-1">
                        {last7.map((d, i) => (
                          <div
                            key={i}
                            className="w-3 h-3 rounded-sm flex items-center justify-center"
                            style={{
                              backgroundColor: d.done ? color : "var(--muted)",
                              opacity: d.done ? 1 : 0.25,
                            }}
                          >
                            {d.done && <Check className="h-2 w-2 text-white" />}
                          </div>
                        ))}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={checkedToday ? "secondary" : "default"}
                      disabled={checkedToday || checkinMutation.isPending}
                      onClick={() => checkinMutation.mutate(h)}
                      className="h-6 text-[10px] px-2"
                    >
                      {checkedToday ? <><Check className="h-2.5 w-2.5 mr-0.5" />Done</> : "Check In"}
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground shrink-0"
                      onClick={() => setEditHabit(h)}
                      data-testid={`button-edit-habit-${h.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => deleteMutation.mutate(h.id)}
                      data-testid={`button-delete-habit-${h.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
      {editHabit && <HabitEditDialog open={!!editHabit} onClose={() => setEditHabit(null)} habit={editHabit} />}
      {addHabitOpen && <HabitAddDialog open={addHabitOpen} onClose={() => setAddHabitOpen(false)} />}
    </Dialog>
  );
}

function HabitAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: "", frequency: "daily" });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/habits", { name: form.name, frequency: form.frequency });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Habit created" });
      onClose();
      setForm({ name: "", frequency: "daily" });
    },
    onError: () => toast({ title: "Error", description: "Failed to create habit", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-add-habit">
        <DialogHeader><DialogTitle>Add Habit</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Morning Run, Read 30min" required data-testid="input-add-habit-name" /></div>
          <div className="space-y-1"><Label>Frequency</Label>
            <Select value={form.frequency} onValueChange={v => setForm(f => ({...f, frequency: v}))}>
              <SelectTrigger data-testid="select-add-habit-freq"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["daily","weekly","custom"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function HabitEditDialog({ open, onClose, habit }: { open: boolean; onClose: () => void; habit: any }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ name: habit?.name ?? "", frequency: habit?.frequency ?? "daily" });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/habits/${habit.id}`, { name: form.name, frequency: form.frequency });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Habit updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-habit">
        <DialogHeader><DialogTitle>Edit Habit</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={form.name} onChange={e => setForm(f => ({...f, name: e.target.value}))} required data-testid="input-edit-habit-name" /></div>
          <div className="space-y-1"><Label>Frequency</Label>
            <Select value={form.frequency} onValueChange={v => setForm(f => ({...f, frequency: v}))}>
              <SelectTrigger data-testid="select-edit-habit-freq"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["daily","weekly","custom"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ObligationsListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: obligations = [], isLoading } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"],
    queryFn: () => apiRequest("GET", "/api/obligations").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [payOb, setPayOb] = useState<Obligation | null>(null);
  const [editOb, setEditOb] = useState<any>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/obligations/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Obligation deleted" });
    },
  });

  const sorted = [...obligations].sort((a, b) =>
    new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()
  );
  const monthlyTotal = obligations.reduce((s, o) => {
    switch (o.frequency) {
      case "weekly":    return s + o.amount * 4.33;
      case "biweekly":  return s + o.amount * 2.17;
      case "monthly":   return s + o.amount;
      case "quarterly": return s + o.amount / 3;
      case "yearly":    return s + o.amount / 12;
      default: return s;
    }
  }, 0);

  return (
    <>
      <Dialog open={open && !payOb} onOpenChange={o => { if (!o) onClose(); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-obligations-list">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CreditCard className="h-4 w-4 text-primary" />
              Bills & Obligations
              <Badge variant="secondary" className="ml-1">{obligations.length}</Badge>
              <span className="text-xs text-muted-foreground font-normal ml-1">{formatMoney(monthlyTotal)}/mo</span>
              <ViewFullPageLink onClose={onClose} href="/dashboard/obligations" />
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh] pr-2">
            {isLoading ? (
              <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
            ) : sorted.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No obligations yet.</p>
            ) : (
              <div className="space-y-0.5">
                {sorted.map(ob => {
                  const Icon = OB_ICONS[ob.category] || DollarSign;
                  const dueDate = new Date(ob.nextDueDate);
                  const now = new Date();
                  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
                  const isOverdue = daysUntilDue < 0;
                  const isDueSoon = daysUntilDue >= 0 && daysUntilDue <= 7;

                  return (
                    <div
                      key={ob.id}
                      className={`flex items-center gap-2.5 p-2.5 rounded-lg transition-colors border group ${isOverdue ? "border-red-500/40 bg-red-500/5" : isDueSoon ? "border-yellow-500/30 bg-yellow-500/5" : "border-transparent hover:bg-muted/50"}`}
                      data-testid={`popup-obligation-${ob.id}`}
                    >
                      <div className={`p-1.5 rounded-md shrink-0 ${isOverdue ? "bg-red-500/10" : isDueSoon ? "bg-yellow-500/10" : "bg-primary/10"}`}>
                        <Icon className={`h-3.5 w-3.5 ${isOverdue ? "text-red-500" : isDueSoon ? "text-yellow-500" : "text-primary"}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate">{ob.name}</span>
                          {ob.autopay && <span className="text-[9px] text-green-600">autopay</span>}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-sm font-semibold">${ob.amount.toLocaleString()}</span>
                          <span className="text-[10px] text-muted-foreground">{fmtDate(ob.nextDueDate)}</span>
                          {isOverdue && <Badge variant="destructive" className="text-[9px] h-3.5">{Math.abs(daysUntilDue)}d overdue</Badge>}
                          {isDueSoon && !isOverdue && <Badge className="text-[9px] h-3.5 bg-yellow-500/20 text-yellow-600 border-yellow-500/30">{daysUntilDue === 0 ? "Today" : `${daysUntilDue}d`}</Badge>}
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="h-6 text-[10px] shrink-0" onClick={() => setPayOb(ob)}>
                        Pay
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground shrink-0"
                        onClick={() => setEditOb(ob)}
                        data-testid={`button-edit-obligation-${ob.id}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm" variant="ghost"
                        className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => deleteMutation.mutate(ob.id)}
                        data-testid={`button-delete-obligation-${ob.id}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
      {payOb && <PayObligationDialog open={!!payOb} onClose={() => setPayOb(null)} obligation={payOb} />}
      {editOb && <ObligationEditDialog open={!!editOb} onClose={() => setEditOb(null)} obligation={editOb} />}
    </>
  );
}

function ObligationEditDialog({ open, onClose, obligation }: { open: boolean; onClose: () => void; obligation: any }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: obligation?.name ?? "", amount: obligation?.amount?.toString() ?? "",
    frequency: obligation?.frequency ?? "monthly", category: obligation?.category ?? "general",
    nextDueDate: obligation?.nextDueDate?.slice(0, 10) ?? "", autopay: obligation?.autopay ?? false,
    notes: obligation?.notes ?? "",
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/obligations/${obligation.id}`, {
        name: form.name, amount: parseFloat(form.amount), frequency: form.frequency,
        category: form.category, nextDueDate: form.nextDueDate, autopay: form.autopay, notes: form.notes,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Obligation updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-obligation">
        <DialogHeader><DialogTitle>Edit Obligation</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Name</Label><Input value={form.name} onChange={e => setForm((f: any) => ({...f, name: e.target.value}))} required data-testid="input-edit-ob-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Amount ($)</Label><Input type="number" step="0.01" value={form.amount} onChange={e => setForm((f: any) => ({...f, amount: e.target.value}))} required data-testid="input-edit-ob-amount" /></div>
            <div className="space-y-1"><Label>Frequency</Label>
              <Select value={form.frequency} onValueChange={v => setForm((f: any) => ({...f, frequency: v}))}>
                <SelectTrigger data-testid="select-edit-ob-freq"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["weekly","biweekly","monthly","quarterly","yearly"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Category</Label>
              <Select value={form.category} onValueChange={v => setForm((f: any) => ({...f, category: v}))}>
                <SelectTrigger data-testid="select-edit-ob-cat"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["housing","loan","insurance","health","investment","subscription","utilities","general"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1"><Label>Due Date</Label><Input type="date" value={form.nextDueDate} onChange={e => setForm((f: any) => ({...f, nextDueDate: e.target.value}))} data-testid="input-edit-ob-due" /></div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={form.autopay} onCheckedChange={v => setForm((f: any) => ({...f, autopay: v}))} data-testid="switch-edit-ob-autopay" />
            <Label>Autopay</Label>
          </div>
          <div className="space-y-1"><Label>Notes</Label><Textarea value={form.notes} onChange={e => setForm((f: any) => ({...f, notes: e.target.value}))} rows={2} data-testid="input-edit-ob-notes" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function JournalListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: entries = [], isLoading } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal"],
    queryFn: () => apiRequest("GET", "/api/journal").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [editEntry, setEditEntry] = useState<any>(null);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/journal/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Entry deleted" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-journal-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BookHeart className="h-4 w-4 text-primary" />
            Journal Entries
            <Badge variant="secondary" className="ml-1">{entries.length}</Badge>
            <ViewFullPageLink onClose={onClose} href="/dashboard/journal" />
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No journal entries yet.</p>
          ) : (
            <div className="space-y-0.5">
              {entries.map(entry => {
                const cfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
                const MoodIcon = cfg.icon;
                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2.5 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                    data-testid={`popup-journal-${entry.id}`}
                  >
                    <div className={`p-1.5 rounded-lg shrink-0 ${cfg.bg}`}>
                      <MoodIcon className="h-3.5 w-3.5" style={{ color: cfg.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-xs font-semibold" style={{ color: cfg.color }}>{cfg.label}</span>
                        <span className="text-[10px] text-muted-foreground">{fmtDate(entry.createdAt)}</span>
                        {entry.energy && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Zap className="h-2.5 w-2.5" />{entry.energy}/5
                          </span>
                        )}
                      </div>
                      {entry.content && (
                        <p className="text-xs text-foreground/80 line-clamp-2">{entry.content}</p>
                      )}
                    </div>
                    <Button
                      size="sm" variant="ghost"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground shrink-0"
                      onClick={() => setEditEntry(entry)}
                      data-testid={`button-edit-journal-${entry.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => deleteMutation.mutate(entry.id)}
                      data-testid={`button-delete-journal-${entry.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
      {editEntry && <JournalEditDialog open={!!editEntry} onClose={() => setEditEntry(null)} entry={editEntry} />}
    </Dialog>
  );
}

function JournalEditDialog({ open, onClose, entry }: { open: boolean; onClose: () => void; entry: any }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    content: entry?.content ?? "", mood: entry?.mood ?? "neutral",
    tags: (entry?.tags || []).join(", "), energy: entry?.energy?.toString() ?? "",
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/journal/${entry.id}`, {
        content: form.content, mood: form.mood,
        tags: form.tags.split(",").map((t: string) => t.trim()).filter(Boolean),
        energy: form.energy ? parseInt(form.energy) : undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Journal entry updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-journal">
        <DialogHeader><DialogTitle>Edit Journal Entry</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Mood</Label>
            <Select value={form.mood} onValueChange={v => setForm(f => ({...f, mood: v}))}>
              <SelectTrigger data-testid="select-edit-journal-mood"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["great","good","neutral","bad","terrible"].map(v => <SelectItem key={v} value={v}>{v.charAt(0).toUpperCase()+v.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>Content</Label><Textarea value={form.content} onChange={e => setForm(f => ({...f, content: e.target.value}))} rows={4} data-testid="input-edit-journal-content" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Energy (1-5)</Label><Input type="number" min="1" max="5" value={form.energy} onChange={e => setForm(f => ({...f, energy: e.target.value}))} data-testid="input-edit-journal-energy" /></div>
            <div className="space-y-1"><Label>Tags (comma-separated)</Label><Input value={form.tags} onChange={e => setForm(f => ({...f, tags: e.target.value}))} data-testid="input-edit-journal-tags" /></div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactsListDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: artifacts = [], isLoading } = useQuery<Artifact[]>({
    queryKey: ["/api/artifacts"],
    queryFn: () => apiRequest("GET", "/api/artifacts").then(r => r.json()),
    enabled: open,
  });
  const { toast } = useToast();
  const [editArtifact, setEditArtifact] = useState<any>(null);
  const [addArtifactOpen, setAddArtifactOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/artifacts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Artifact deleted" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" data-testid="dialog-artifacts-list">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CheckSquare className="h-4 w-4 text-primary" />
            Artifacts & Notes
            <Badge variant="secondary" className="ml-1">{artifacts.length}</Badge>
            <ViewFullPageLink onClose={onClose} href="/dashboard/artifacts" />
            <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={() => setAddArtifactOpen(true)} data-testid="button-add-artifact"><Plus className="h-3 w-3 mr-0.5" />Add</Button>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-2">
          {isLoading ? (
            <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
          ) : artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No artifacts yet.</p>
          ) : (
            <div className="space-y-0.5">
              {artifacts.map(a => (
                <div
                  key={a.id}
                  className="flex items-center gap-2.5 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                  data-testid={`popup-artifact-${a.id}`}
                >
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${a.type === "checklist" ? "bg-blue-500/10" : "bg-primary/10"}`}>
                    {a.type === "checklist" ? <CheckSquare className="h-3.5 w-3.5 text-blue-500" /> : <FileText className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium truncate">{a.title}</p>
                      {a.pinned && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 shrink-0" />}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="text-[9px] h-3.5 px-1">{a.type}</Badge>
                      {a.type === "checklist" && (
                        <span className="text-[10px] text-muted-foreground">
                          {a.items.filter(i => i.checked).length}/{a.items.length}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{fmtDate(a.createdAt)}</span>
                  <Button
                    size="sm" variant="ghost"
                    className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground shrink-0"
                    onClick={() => setEditArtifact(a)}
                    data-testid={`button-edit-artifact-${a.id}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm" variant="ghost"
                    className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => deleteMutation.mutate(a.id)}
                    data-testid={`button-delete-artifact-${a.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
      {editArtifact && <ArtifactEditDialog open={!!editArtifact} onClose={() => setEditArtifact(null)} artifact={editArtifact} />}
      {addArtifactOpen && <ArtifactAddDialog open={addArtifactOpen} onClose={() => setAddArtifactOpen(false)} />}
    </Dialog>
  );
}

function ArtifactAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ title: "", type: "note" as "note" | "checklist", content: "" });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/artifacts", {
        title: form.title, type: form.type,
        content: form.type === "note" ? form.content : "",
        items: form.type === "checklist" ? form.content.split("\n").filter(Boolean).map(t => ({ text: t.trim(), checked: false })) : [],
        tags: [], pinned: false,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Artifact created" });
      onClose();
      setForm({ title: "", type: "note", content: "" });
    },
    onError: () => toast({ title: "Error", description: "Failed to create", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-add-artifact">
        <DialogHeader><DialogTitle>Add Artifact</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Title</Label><Input value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))} required data-testid="input-add-artifact-title" /></div>
          <div className="space-y-1"><Label>Type</Label>
            <Select value={form.type} onValueChange={v => setForm(f => ({...f, type: v as any}))}>
              <SelectTrigger data-testid="select-add-artifact-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="checklist">Checklist</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>{form.type === "checklist" ? "Items (one per line)" : "Content"}</Label><Textarea value={form.content} onChange={e => setForm(f => ({...f, content: e.target.value}))} rows={4} data-testid="input-add-artifact-content" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactEditDialog({ open, onClose, artifact }: { open: boolean; onClose: () => void; artifact: any }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    title: artifact?.title ?? "",
    content: artifact?.type === "checklist"
      ? (artifact?.items || []).map((i: any) => i.text).join("\n")
      : artifact?.content ?? "",
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const payload: any = { title: form.title };
      if (artifact.type === "checklist") {
        payload.items = form.content.split("\n").filter(Boolean).map((t: string, i: number) => ({
          text: t.trim(),
          checked: artifact.items[i]?.checked ?? false,
        }));
      } else {
        payload.content = form.content;
      }
      const res = await apiRequest("PATCH", `/api/artifacts/${artifact.id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Artifact updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-artifact">
        <DialogHeader><DialogTitle>Edit Artifact</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Title</Label><Input value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))} required data-testid="input-edit-artifact-title" /></div>
          <div className="space-y-1"><Label>{artifact.type === "checklist" ? "Items (one per line)" : "Content"}</Label><Textarea value={form.content} onChange={e => setForm(f => ({...f, content: e.target.value}))} rows={4} data-testid="input-edit-artifact-content" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── KEY STATS ROW (compact 4-card row) ─────────────────────────────────────

type StatDialogType = "profiles" | "trackers" | "tasks" | "spending" | "habits" | "obligations" | "journal" | "artifacts" | null;

function KeyStatsRow({ stats }: { stats: DashboardStats }) {
  const [openDialog, setOpenDialog] = useState<StatDialogType>(null);
  const moodCfg = stats.currentMood ? MOOD_CONFIG[stats.currentMood] : null;

  return (
    <>
      {/* Row 1: 4 primary metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MiniStat icon={ListTodo} label="Active Tasks" value={stats.activeTasks} sub={`${stats.totalTasks} total`} onClick={() => setOpenDialog("tasks")} />
        <MiniStat icon={DollarSign} label="Spent This Mo" value={`${formatMoney(stats.monthlySpend)}`} onClick={() => setOpenDialog("spending")} />
        <MiniStat icon={Flame} label="Habits" value={`${stats.habitCompletionRate}%`} sub={`${stats.totalHabits} active`} color="#FF6B2B" onClick={() => setOpenDialog("habits")} />
        <MiniStat icon={CreditCard} label="Bills Due" value={stats.upcomingObligations} sub={`${formatMoney(stats.monthlyObligationTotal)}/mo`} color="#BB653B" onClick={() => setOpenDialog("obligations")} />
      </div>
      {/* Row 2: 4 secondary metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MiniStat icon={Users} label="Profiles" value={stats.totalProfiles} onClick={() => setOpenDialog("profiles")} />
        <MiniStat icon={BarChart3} label="Trackers" value={stats.totalTrackers} sub={`${stats.weeklyEntries} entries/wk`} onClick={() => setOpenDialog("trackers")} />
        <MiniStat icon={BookHeart} label="Journal" value={`${stats.journalStreak}d streak`} sub={moodCfg?.label} color={moodCfg?.color} onClick={() => setOpenDialog("journal")} />
        <MiniStat icon={CheckSquare} label="Artifacts" value={stats.totalArtifacts} sub={`${stats.totalMemories} memories`} onClick={() => setOpenDialog("artifacts")} />
      </div>

      {/* Popup dialogs */}
      <ProfilesListDialog open={openDialog === "profiles"} onClose={() => setOpenDialog(null)} />
      <TrackersListDialog open={openDialog === "trackers"} onClose={() => setOpenDialog(null)} />
      <TasksListDialog open={openDialog === "tasks"} onClose={() => setOpenDialog(null)} />
      <SpendingListDialog open={openDialog === "spending"} onClose={() => setOpenDialog(null)} />
      <HabitsListDialog open={openDialog === "habits"} onClose={() => setOpenDialog(null)} />
      <ObligationsListDialog open={openDialog === "obligations"} onClose={() => setOpenDialog(null)} />
      <JournalListDialog open={openDialog === "journal"} onClose={() => setOpenDialog(null)} />
      <ArtifactsListDialog open={openDialog === "artifacts"} onClose={() => setOpenDialog(null)} />
    </>
  );
}

// ─── ALERTS BANNER ─────────────────────────────────────────────────────────

function AlertsBanner({ enhanced }: { enhanced: any }) {
  const alerts: { icon: any; text: string; severity: "red" | "yellow" | "blue" }[] = [];

  // Expiring documents
  if (enhanced.expiringDocuments?.length > 0) {
    for (const doc of enhanced.expiringDocuments.slice(0, 3)) {
      if (doc.status === "expired") {
        alerts.push({ icon: FileWarning, text: `${doc.documentName} — ${doc.fieldName.replace(/_/g, " ")} expired ${Math.abs(doc.daysUntil)}d ago`, severity: "red" });
      } else if (doc.status === "expiring_soon") {
        alerts.push({ icon: FileWarning, text: `${doc.documentName} — ${doc.fieldName.replace(/_/g, " ")} expires in ${doc.daysUntil}d`, severity: "yellow" });
      } else {
        alerts.push({ icon: CalendarClock, text: `${doc.documentName} — ${doc.fieldName.replace(/_/g, " ")} in ${doc.daysUntil}d`, severity: "blue" });
      }
    }
  }

  // Overdue tasks
  if (enhanced.overdueTasks?.length > 0) {
    for (const t of enhanced.overdueTasks.slice(0, 2)) {
      alerts.push({ icon: AlertCircle, text: `Task overdue: ${t.title} (due ${fmtDate(t.dueDate)})`, severity: "red" });
    }
  }

  if (alerts.length === 0) return null;

  const severityStyles = {
    red: "bg-red-500/8 border-red-500/30 text-red-700 dark:text-red-400",
    yellow: "bg-yellow-500/8 border-yellow-500/30 text-yellow-700 dark:text-yellow-400",
    blue: "bg-blue-500/8 border-blue-500/30 text-blue-700 dark:text-blue-400",
  };

  return (
    <div className="space-y-1.5" data-testid="alerts-banner">
      {alerts.map((alert, i) => {
        const Icon = alert.icon;
        return (
          <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${severityStyles[alert.severity]}`}>
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{alert.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── HEALTH SNAPSHOT ───────────────────────────────────────────────────────

function HealthSnapshot({ data }: { data: any[] }) {
  if (!data || data.length === 0) return null;

  const TrendIcon = ({ trend }: { trend: string }) => {
    if (trend === "up") return <ArrowUp className="h-3 w-3 text-green-500" />;
    if (trend === "down") return <ArrowDown className="h-3 w-3 text-red-500" />;
    return <Minus className="h-3 w-3 text-muted-foreground" />;
  };

  return (
    <CollapsibleSection icon={HeartPulse} label="Health Snapshot" count={data.length} testId="section-health-snapshot">
      <div className="grid grid-cols-2 gap-2">
        {data.slice(0, 6).map(item => (
          <div key={item.trackerId} className="flex items-center gap-2 p-2 rounded-lg bg-muted/40">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-muted-foreground truncate">{item.name}</p>
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
            <span className="text-[9px] text-muted-foreground">avg {item.average}</span>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// ─── FINANCE SNAPSHOT (Enhanced Spending Analytics) ──────────────────────────

const CATEGORY_COLORS = [
  "#20808D", // Teal
  "#A84B2F", // Terra
  "#1B474D", // Dark teal
  "#BCE2E7", // Light cyan
  "#944454", // Mauve
  "#FFC553", // Gold
  "#848456", // Olive
  "#6E522B", // Brown
];

const DEFAULT_BUDGET_CATEGORIES = [
  "groceries", "dining", "gas", "entertainment", "shopping",
  "health", "transportation", "utilities", "subscriptions", "other",
];

function FinanceSnapshot({ data: legacyData }: { data: any }) {
  const [budgetDialogOpen, setBudgetDialogOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  const { toast } = useToast();

  const { data: analytics, isLoading } = useQuery<any>({
    queryKey: ["/api/analytics/spending"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/analytics/spending?months=6");
      return res.json();
    },
  });

  const { data: savedBudgets } = useQuery<Record<string, number>>({
    queryKey: ["/api/budgets"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/budgets");
      return res.json();
    },
  });

  const saveBudgetsMutation = useMutation({
    mutationFn: async (budgets: Record<string, number>) => {
      await apiRequest("PUT", "/api/budgets", { budgets });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/budgets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/spending"] });
      setBudgetDialogOpen(false);
      toast({ title: "Budgets saved" });
    },
  });

  const openBudgetDialog = () => {
    const draft: Record<string, string> = {};
    // Pre-populate with existing budgets + known categories from spending
    const allCats = new Set([
      ...DEFAULT_BUDGET_CATEGORIES,
      ...Object.keys(savedBudgets || {}),
      ...(analytics?.currentMonth?.byCategory?.map((c: any) => c.category) || []),
    ]);
    for (const cat of allCats) {
      draft[cat] = String((savedBudgets as any)?.[cat] || "");
    }
    setBudgetDraft(draft);
    setBudgetDialogOpen(true);
  };

  const handleSaveBudgets = () => {
    const budgets: Record<string, number> = {};
    for (const [cat, val] of Object.entries(budgetDraft)) {
      const num = parseFloat(val);
      if (!isNaN(num) && num > 0) budgets[cat] = num;
    }
    saveBudgetsMutation.mutate(budgets);
  };

  // Loading state
  if (isLoading) {
    return (
      <CollapsibleSection icon={Wallet} label="Finance Snapshot" testId="section-finance-snapshot">
        <div className="space-y-3">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </CollapsibleSection>
    );
  }

  // Empty state: no analytics data or zero spending
  if (!analytics || (analytics.currentMonth.total === 0 && analytics.monthlyTrend.every((m: any) => m.total === 0))) {
    if (!legacyData) return null;
    // Fallback to simple legacy display if there's legacy data but no analytics
    return (
      <CollapsibleSection icon={Wallet} label="Finance Snapshot" testId="section-finance-snapshot">
        <p className="text-xs text-muted-foreground">No spending data yet. Log expenses to see analytics.</p>
      </CollapsibleSection>
    );
  }

  const { currentMonth, monthlyTrend, budgets, insights } = analytics;

  // Format month label
  const fmtMonth = (m: string) => {
    const [y, mo] = m.split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[parseInt(mo) - 1]} '${y.slice(2)}`;
  };

  return (
    <CollapsibleSection icon={Wallet} label="Finance Snapshot" testId="section-finance-snapshot">
      <div className="space-y-4">
        {/* Row 1: Key Metrics */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="spending-key-metrics">
          <div>
            <p className="text-[10px] text-muted-foreground">This Month</p>
            <p className="text-lg font-bold tabular-nums" data-testid="text-monthly-total">
              ${currentMonth.total.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">vs Last Month</p>
            <div className="flex items-center gap-1" data-testid="text-vs-last-month">
              {insights.vsLastMonth.change > 0 ? (
                <ArrowUp className="h-3.5 w-3.5 text-red-500" />
              ) : insights.vsLastMonth.change < 0 ? (
                <ArrowDown className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Minus className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={`text-sm font-semibold tabular-nums ${
                insights.vsLastMonth.change > 0 ? "text-red-500" : insights.vsLastMonth.change < 0 ? "text-green-500" : "text-muted-foreground"
              }`}>
                {insights.vsLastMonth.percentChange !== 0
                  ? `${Math.abs(insights.vsLastMonth.percentChange)}%`
                  : "—"}
              </span>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Daily Avg</p>
            <p className="text-sm font-semibold tabular-nums" data-testid="text-daily-avg">
              ${currentMonth.avgPerDay.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Projected</p>
            <p className="text-sm font-semibold tabular-nums" data-testid="text-projected-total">
              ${currentMonth.projectedMonthTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </p>
          </div>
        </div>

        {/* Row 2: Category Breakdown - Stacked Bar */}
        {currentMonth.byCategory.length > 0 && (
          <div data-testid="spending-category-breakdown">
            <p className="text-[10px] font-medium text-muted-foreground uppercase mb-2">Spending by Category</p>
            <div className="w-full h-5 rounded-full overflow-hidden flex" data-testid="category-stacked-bar">
              {currentMonth.byCategory.map((c: any, i: number) => (
                <div
                  key={c.category}
                  className="h-full transition-all"
                  style={{
                    width: `${c.percentage}%`,
                    backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
                    minWidth: c.percentage > 0 ? "2px" : "0",
                  }}
                  title={`${c.category}: $${c.amount} (${c.percentage}%)`}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {currentMonth.byCategory.map((c: any, i: number) => (
                <div key={c.category} className="flex items-center gap-1.5 text-[11px]" data-testid={`category-legend-${c.category}`}>
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                  />
                  <span className="capitalize">{c.category}</span>
                  <span className="text-muted-foreground tabular-nums">
                    ${c.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} ({c.percentage}%)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Row 3: Monthly Trend Line Chart */}
        {monthlyTrend.length > 1 && (
          <div data-testid="spending-monthly-trend">
            <p className="text-[10px] font-medium text-muted-foreground uppercase mb-2">Monthly Trend</p>
            <div className="w-full h-32">
              <SpendingTrendChart data={monthlyTrend} fmtMonth={fmtMonth} />
            </div>
          </div>
        )}

        {/* Row 4: Budget Progress */}
        <div data-testid="spending-budget-section">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-medium text-muted-foreground uppercase">Budget Tracking</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={openBudgetDialog}
              data-testid="btn-set-budgets"
            >
              <Settings className="h-3 w-3 mr-1" />
              {budgets.length > 0 ? "Edit" : "Set Budgets"}
            </Button>
          </div>
          {budgets.length > 0 ? (
            <div className="space-y-2">
              {budgets.map((b: any) => {
                const pct = Math.min(b.percentUsed, 100);
                const color = pct > 90 ? "bg-red-500" : pct > 75 ? "bg-amber-500" : "bg-green-500";
                return (
                  <div key={b.category} className="space-y-0.5" data-testid={`budget-progress-${b.category}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] capitalize">{b.category}</span>
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        ${b.spent.toLocaleString(undefined, { maximumFractionDigits: 0 })} / ${b.limit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${color}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">No budgets set. Click "Set Budgets" to add spending limits by category.</p>
          )}
        </div>

        {/* Row 5: Top Vendors */}
        {currentMonth.byVendor.length > 0 && (
          <div data-testid="spending-top-vendors">
            <p className="text-[10px] font-medium text-muted-foreground uppercase mb-1.5">Top Vendors</p>
            <div className="space-y-0.5">
              {currentMonth.byVendor.slice(0, 5).map((v: any) => (
                <div key={v.vendor} className="flex items-center gap-2 py-1 text-[11px]" data-testid={`vendor-row-${v.vendor}`}>
                  <span className="flex-1 truncate">{v.vendor}</span>
                  <span className="text-muted-foreground tabular-nums">{v.count}x</span>
                  <span className="font-medium tabular-nums">
                    ${v.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Budget Dialog */}
      <Dialog open={budgetDialogOpen} onOpenChange={setBudgetDialogOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-budgets">
          <DialogHeader>
            <DialogTitle className="text-sm">Set Monthly Budgets</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Set spending limits per category. Leave blank to remove.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[350px]">
            <div className="space-y-2 pr-3">
              {Object.entries(budgetDraft).sort(([a], [b]) => a.localeCompare(b)).map(([cat, val]) => (
                <div key={cat} className="flex items-center gap-2">
                  <Label className="text-xs capitalize flex-1 min-w-0 truncate">{cat}</Label>
                  <div className="relative w-28">
                    <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                    <Input
                      type="number"
                      placeholder="0"
                      className="h-7 text-xs pl-6 tabular-nums"
                      value={val}
                      onChange={(e) => setBudgetDraft(prev => ({ ...prev, [cat]: e.target.value }))}
                      data-testid={`input-budget-${cat}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              size="sm"
              className="text-xs"
              onClick={handleSaveBudgets}
              disabled={saveBudgetsMutation.isPending}
              data-testid="btn-save-budgets"
            >
              {saveBudgetsMutation.isPending ? "Saving..." : "Save Budgets"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CollapsibleSection>
  );
}

function SpendingTrendChart({ data, fmtMonth }: { data: any[]; fmtMonth: (m: string) => string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id="spendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#20808D" stopOpacity={0.2} />
            <stop offset="95%" stopColor="#20808D" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="month"
          tickFormatter={fmtMonth}
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10 }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
        />
        <RechartsTooltip
          formatter={(value: number) => [`$${value.toLocaleString()}`, "Total"]}
          labelFormatter={fmtMonth}
          contentStyle={{ fontSize: 11, borderRadius: 8, border: '1px solid hsl(var(--border))' }}
        />
        <Area
          type="monotone"
          dataKey="total"
          stroke="#20808D"
          strokeWidth={2}
          fill="url(#spendFill)"
          dot={{ r: 3, fill: "#20808D", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── GOOGLE CALENDAR SYNC BUTTON ─────────────────────────────────────────

function CalendarSyncButton() {
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/calendar/sync");
      const data = await res.json();
      toast({
        title: "Calendar Synced",
        description: data.message,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/sync-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
    } catch (err) {
      toast({
        title: "Sync Failed",
        description: "Could not connect to Google Calendar. Try again later.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-xs gap-1.5"
      onClick={handleSync}
      disabled={syncing}
      data-testid="btn-calendar-sync"
    >
      <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
      {syncing ? "Syncing..." : "Sync Google Calendar"}
    </Button>
  );
}

// ─── TODAY'S SCHEDULE ──────────────────────────────────────────────────────

function TodaySchedule({ events }: { events: any[] }) {
  if (!events || events.length === 0) return null;

  return (
    <CollapsibleSection icon={CalendarClock} label="Today's Schedule" count={events.length} testId="section-today-schedule" headerRight={<CalendarSyncButton />}>
      <div className="space-y-1">
        {events.map(evt => (
          <div key={evt.id} className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/40">
            <div className="w-1 h-6 rounded-full bg-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{evt.title}</p>
              {evt.location && <p className="text-[10px] text-muted-foreground flex items-center gap-0.5"><MapPin className="h-2 w-2" />{evt.location}</p>}
            </div>
            {evt.time && (
              <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{evt.time}{evt.endTime ? ` – ${evt.endTime}` : ""}</span>
            )}
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// ─── MOOD + HABITS QUICK ROW ────────────────────────────────────────────────

function MoodHabitsRow({ stats }: { stats: DashboardStats }) {
  const moodCfg = stats.currentMood ? MOOD_CONFIG[stats.currentMood] : null;
  const MoodIcon = moodCfg?.icon || Meh;
  const pct = stats.habitCompletionRate;

  return (
    <div className="grid grid-cols-2 gap-2">
      {/* Mood */}
      <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border/50 bg-card">
        <div className={`p-2 rounded-full shrink-0 ${moodCfg?.bg || "bg-muted"}`}>
          <MoodIcon className="h-5 w-5" style={{ color: moodCfg?.color || "#797876" }} />
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Mood</p>
          <p className="text-sm font-semibold" style={{ color: moodCfg?.color }}>{moodCfg?.label || "None"}</p>
          {stats.journalStreak > 0 && (
            <p className="text-[9px] text-muted-foreground flex items-center gap-0.5">
              <Flame className="h-2 w-2 text-orange-500" />{stats.journalStreak}d streak
            </p>
          )}
        </div>
      </div>

      {/* Habit ring */}
      <div className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border/50 bg-card">
        <div className="relative shrink-0 w-10 h-10">
          <svg viewBox="0 0 36 36" className="w-10 h-10 -rotate-90">
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none" stroke="currentColor" strokeWidth="3.5"
              className="text-muted opacity-30"
            />
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none" stroke="#FF6B2B" strokeWidth="3.5"
              strokeDasharray={`${pct}, 100`}
              strokeLinecap="round"
              className="transition-all duration-700"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold">{pct}%</span>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">Habits</p>
          <p className="text-sm font-semibold">{stats.totalHabits} active</p>
          {stats.streaks.length > 0 && (
            <p className="text-[9px] text-muted-foreground flex items-center gap-0.5">
              <Trophy className="h-2 w-2" />{stats.streaks[0]?.name}: {stats.streaks[0]?.days}d
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── FORM DIALOGS ──────────────────────────────────────────────────────────

interface TaskFormData {
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  dueDate: string;
}

function TaskDialog({
  open,
  onClose,
  initial,
  taskId,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<TaskFormData>;
  taskId?: string;
}) {
  const { toast } = useToast();
  const isEdit = !!taskId;

  const [form, setForm] = useState<TaskFormData>({
    title: initial?.title ?? "",
    description: initial?.description ?? "",
    priority: initial?.priority ?? "medium",
    dueDate: initial?.dueDate ?? "",
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: any = {
        title: form.title,
        priority: form.priority,
      };
      if (form.description) payload.description = form.description;
      if (form.dueDate) payload.dueDate = form.dueDate;

      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/tasks", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: isEdit ? "Task updated" : "Task created" });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save task", variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid={isEdit ? "dialog-edit-task" : "dialog-add-task"}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Task" : "Add Task"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={form.title}
              onChange={e => setForm((f: any) => ({ ...f, title: e.target.value }))}
              placeholder="Task title"
              required
              data-testid="input-task-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={form.description}
              onChange={e => setForm((f: any) => ({ ...f, description: e.target.value }))}
              placeholder="Optional description"
              rows={2}
              data-testid="input-task-description"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <Select
                value={form.priority}
                onValueChange={v => setForm((f: any) => ({ ...f, priority: v as "low" | "medium" | "high" }))}
              >
                <SelectTrigger id="task-priority" data-testid="select-task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-duedate">Due Date</Label>
              <Input
                id="task-duedate"
                type="date"
                value={form.dueDate}
                onChange={e => setForm((f: any) => ({ ...f, dueDate: e.target.value }))}
                data-testid="input-task-duedate"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="btn-save-task">
              {mutation.isPending ? "Saving…" : isEdit ? "Save Changes" : "Add Task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TaskRow({
  task,
  onEdit,
}: {
  task: Task;
  onEdit: (task: Task) => void;
}) {
  const { toast } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const newStatus = task.status === "done" ? "todo" : "done";
      const res = await apiRequest("PATCH", `/api/tasks/${task.id}`, { status: newStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/tasks/${task.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Task deleted" });
      setConfirmDelete(false);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete task", variant: "destructive" });
    },
  });

  const done = task.status === "done";

  return (
    <>
      <div
        className={`flex items-start gap-2.5 py-1.5 px-2.5 rounded-lg hover:bg-muted/40 transition-colors group ${done ? "opacity-50" : ""}`}
        data-testid={`row-task-${task.id}`}
      >
        <Checkbox
          checked={done}
          onCheckedChange={() => toggleMutation.mutate()}
          disabled={toggleMutation.isPending}
          className="mt-0.5 shrink-0"
          data-testid={`checkbox-task-${task.id}`}
        />
        <div
          className="flex-1 min-w-0 cursor-pointer"
          onClick={() => onEdit(task)}
          data-testid={`text-task-${task.id}`}
        >
          <p className={`text-xs leading-tight ${done ? "line-through text-muted-foreground" : ""}`}>
            {task.title}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${PRIORITY_DOT[task.priority]}`} />
            <span className={`text-[9px] ${PRIORITY_BADGE[task.priority]}`}>{task.priority}</span>
            {task.dueDate && (
              <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                <Calendar className="h-2 w-2" />
                {fmtDate(task.dueDate)}
              </span>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          data-testid={`btn-delete-task-${task.id}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent data-testid={`dialog-delete-task-${task.id}`}>
          <DialogHeader>
            <DialogTitle>Delete Task?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{task.title}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
              data-testid={`btn-confirm-delete-task-${task.id}`}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DocumentsVault() {
  const { data: documents = [], isLoading } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  const DOC_ICONS: Record<string, any> = {
    drivers_license: IdCard,
    passport: Shield,
    medical_report: Stethoscope,
    insurance: ShieldAlert,
    receipt: FileText,
    other: FileText,
  };

  const DOC_COLORS: Record<string, string> = {
    drivers_license: "text-blue-500 bg-blue-50 dark:bg-blue-950/40",
    passport: "text-indigo-500 bg-indigo-50 dark:bg-indigo-950/40",
    medical_report: "text-red-500 bg-red-50 dark:bg-red-950/40",
    insurance: "text-amber-500 bg-amber-50 dark:bg-amber-950/40",
    receipt: "text-green-500 bg-green-50 dark:bg-green-950/40",
    other: "text-muted-foreground bg-muted",
  };

  // Check for expiring documents
  const getExpirationStatus = (doc: Document) => {
    const data = doc.extractedData || {};
    const expirationKey = Object.keys(data).find(k =>
      /expir|exp_date|valid.*until|expiration/i.test(k)
    );
    if (!expirationKey) return null;
    const expDate = new Date(data[expirationKey]);
    if (isNaN(expDate.getTime())) return null;
    const daysUntil = Math.ceil((expDate.getTime() - Date.now()) / 86400000);
    if (daysUntil < 0) return { status: "expired", days: Math.abs(daysUntil), color: "text-red-500" };
    if (daysUntil <= 30) return { status: "expiring", days: daysUntil, color: "text-amber-500" };
    return { status: "valid", days: daysUntil, color: "text-green-500" };
  };

  const sorted = [...documents].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <CollapsibleSection
      icon={FileCheck}
      label="Documents"
      count={documents.length}
      testId="section-documents"
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-4">
          <Upload className="h-6 w-6 text-muted-foreground mx-auto mb-1.5" />
          <p className="text-xs text-muted-foreground">No documents yet</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Upload documents via Chat</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {sorted.map(doc => {
            const DocIcon = DOC_ICONS[doc.type] || FileText;
            const colorClass = DOC_COLORS[doc.type] || DOC_COLORS.other;
            const expStatus = getExpirationStatus(doc);
            const extractedKeys = Object.keys(doc.extractedData || {}).filter(k => !/file|image|raw/i.test(k));

            return (
              <div
                key={doc.id}
                className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors group"
                data-testid={`doc-${doc.id}`}
              >
                <div className={`p-1.5 rounded-md shrink-0 ${colorClass}`}>
                  <DocIcon className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">{doc.name}</span>
                    {doc.tags?.length > 0 && (
                      <Badge variant="outline" className="text-[8px] h-3.5 px-1 shrink-0">
                        {doc.tags[0]}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[9px] text-muted-foreground capitalize">
                      {doc.type.replace(/_/g, " ")}
                    </span>
                    {extractedKeys.length > 0 && (
                      <span className="text-[9px] text-muted-foreground">
                        • {extractedKeys.length} fields extracted
                      </span>
                    )}
                  </div>
                </div>
                {expStatus && (
                  <div className={`text-right shrink-0 ${expStatus.color}`}>
                    <span className="text-[9px] font-medium">
                      {expStatus.status === "expired"
                        ? `Expired ${expStatus.days}d ago`
                        : expStatus.status === "expiring"
                        ? `${expStatus.days}d left`
                        : `Valid`}
                    </span>
                  </div>
                )}
                {!expStatus && (
                  <span className="text-[9px] text-muted-foreground shrink-0">
                    {new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}


function ProfilesSnapshot() {
  const { data: profiles = [], isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const PROFILE_ICONS: Record<string, any> = {
    person: Users,
    pet: PawPrint,
    vehicle: Car,
    self: Heart,
    property: HomeIcon,
    medical: Stethoscope,
    account: Building2,
    subscription: Repeat,
    loan: Landmark,
    investment: TrendingUp,
    asset: Package,
  };

  const PROFILE_COLORS: Record<string, string> = {
    person: "text-blue-500 bg-blue-50 dark:bg-blue-950/40",
    pet: "text-orange-500 bg-orange-50 dark:bg-orange-950/40",
    vehicle: "text-slate-500 bg-slate-100 dark:bg-slate-900/40",
    self: "text-rose-500 bg-rose-50 dark:bg-rose-950/40",
    property: "text-emerald-500 bg-emerald-50 dark:bg-emerald-950/40",
    medical: "text-red-500 bg-red-50 dark:bg-red-950/40",
    account: "text-purple-500 bg-purple-50 dark:bg-purple-950/40",
    subscription: "text-cyan-500 bg-cyan-50 dark:bg-cyan-950/40",
    loan: "text-amber-500 bg-amber-50 dark:bg-amber-950/40",
    investment: "text-green-500 bg-green-50 dark:bg-green-950/40",
    asset: "text-indigo-500 bg-indigo-50 dark:bg-indigo-950/40",
  };

  // Get key info from profile fields
  const getKeyInfo = (p: Profile) => {
    const f = p.fields || {};
    const info: string[] = [];
    // Common useful fields
    if (f.breed) info.push(f.breed);
    if (f.relationship) info.push(f.relationship);
    if (f.make && f.model) info.push(`${f.make} ${f.model}`);
    else if (f.make) info.push(f.make);
    if (f.year) info.push(String(f.year));
    if (f.phone) info.push(f.phone);
    if (f.email) info.push(f.email);
    if (f.age) info.push(`Age: ${f.age}`);
    if (f.weight) info.push(`${f.weight} lbs`);
    if (f.address) info.push(f.address);
    if (f.balance) info.push(`$${Number(f.balance).toLocaleString()}`);
    if (f.value) info.push(`$${Number(f.value).toLocaleString()}`);
    return info.slice(0, 2);
  };

  const sorted = [...profiles].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <CollapsibleSection
      icon={Users}
      label="Profiles"
      count={profiles.length}
      testId="section-profiles"
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-4">
          <Users className="h-6 w-6 text-muted-foreground mx-auto mb-1.5" />
          <p className="text-xs text-muted-foreground">No profiles yet</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Add people, pets, vehicles via Chat</p>
        </div>
      ) : (
        <div className="space-y-0.5">
          {sorted.map(p => {
            const PIcon = PROFILE_ICONS[p.type] || Users;
            const colorClass = PROFILE_COLORS[p.type] || PROFILE_COLORS.person;
            const keyInfo = getKeyInfo(p);
            const linkedCount = (p.documents?.length || 0) + (p.linkedTrackers?.length || 0) + 
                               (p.linkedExpenses?.length || 0) + (p.linkedTasks?.length || 0);

            return (
              <div
                key={p.id}
                className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors"
                data-testid={`profile-card-${p.id}`}
              >
                {p.avatar ? (
                  <img src={p.avatar} alt={p.name} className="h-8 w-8 rounded-full object-cover shrink-0" />
                ) : (
                  <div className={`p-1.5 rounded-full shrink-0 ${colorClass}`}>
                    <PIcon className="h-3.5 w-3.5" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium truncate">{p.name}</span>
                    <Badge variant="outline" className="text-[8px] h-3.5 px-1 capitalize shrink-0">
                      {p.type}
                    </Badge>
                  </div>
                  {keyInfo.length > 0 && (
                    <p className="text-[9px] text-muted-foreground truncate mt-0.5">
                      {keyInfo.join(" • ")}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  {p.tags?.length > 0 && (
                    <Badge variant="secondary" className="text-[8px] h-3.5 px-1">
                      {p.tags[0]}
                    </Badge>
                  )}
                  {linkedCount > 0 && (
                    <p className="text-[9px] text-muted-foreground mt-0.5">{linkedCount} linked</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

type ObligationFormData = {
  name: string;
  amount: string;
  frequency: string;
  category: string;
  nextDueDate: string;
  autopay: boolean;
};

function ObligationDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<ObligationFormData>({
    name: "",
    amount: "",
    frequency: "monthly",
    category: "general",
    nextDueDate: "",
    autopay: false,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/obligations", {
        name: form.name,
        amount: parseFloat(form.amount),
        frequency: form.frequency,
        category: form.category,
        nextDueDate: form.nextDueDate,
        autopay: form.autopay,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Obligation added" });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to add obligation", variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.amount || !form.nextDueDate) return;
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-add-obligation">
        <DialogHeader>
          <DialogTitle>Add Obligation</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ob-name">Name</Label>
            <Input
              id="ob-name"
              value={form.name}
              onChange={e => setForm((f: any) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Rent, Netflix, Car Insurance"
              required
              data-testid="input-obligation-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ob-amount">Amount ($)</Label>
              <Input
                id="ob-amount"
                type="number"
                step="0.01"
                min="0"
                value={form.amount}
                onChange={e => setForm((f: any) => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                required
                data-testid="input-obligation-amount"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-frequency">Frequency</Label>
              <Select
                value={form.frequency}
                onValueChange={v => setForm((f: any) => ({ ...f, frequency: v }))}
              >
                <SelectTrigger id="ob-frequency" data-testid="select-obligation-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Bi-weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                  <SelectItem value="once">Once</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ob-category">Category</Label>
              <Select
                value={form.category}
                onValueChange={v => setForm((f: any) => ({ ...f, category: v }))}
              >
                <SelectTrigger id="ob-category" data-testid="select-obligation-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="housing">Housing</SelectItem>
                  <SelectItem value="loan">Loan</SelectItem>
                  <SelectItem value="insurance">Insurance</SelectItem>
                  <SelectItem value="health">Health</SelectItem>
                  <SelectItem value="investment">Investment</SelectItem>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="utilities">Utilities</SelectItem>
                  <SelectItem value="general">General</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-duedate">Next Due Date</Label>
              <Input
                id="ob-duedate"
                type="date"
                value={form.nextDueDate}
                onChange={e => setForm((f: any) => ({ ...f, nextDueDate: e.target.value }))}
                required
                data-testid="input-obligation-duedate"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="ob-autopay"
              checked={form.autopay}
              onCheckedChange={v => setForm((f: any) => ({ ...f, autopay: v }))}
              data-testid="switch-obligation-autopay"
            />
            <Label htmlFor="ob-autopay">Autopay enabled</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="btn-save-obligation">
              {mutation.isPending ? "Saving…" : "Add Obligation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface PaymentFormData {
  amount: string;
  method: string;
  confirmationNumber: string;
}

function PayObligationDialog({
  open,
  onClose,
  obligation,
}: {
  open: boolean;
  onClose: () => void;
  obligation: Obligation;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<PaymentFormData>({
    amount: String(obligation.amount),
    method: "",
    confirmationNumber: "",
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/obligations/${obligation.id}/pay`, {
        amount: parseFloat(form.amount),
        method: form.method || undefined,
        confirmationNumber: form.confirmationNumber || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: `Payment recorded for ${obligation.name}` });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to record payment", variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid={`dialog-pay-obligation-${obligation.id}`}>
        <DialogHeader>
          <DialogTitle>Mark as Paid — {obligation.name}</DialogTitle>
          <DialogDescription>Confirm payment details</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount">Amount ($)</Label>
            <Input
              id="pay-amount"
              type="number"
              step="0.01"
              min="0"
              value={form.amount}
              onChange={e => setForm((f: any) => ({ ...f, amount: e.target.value }))}
              required
              data-testid="input-pay-amount"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-method">Payment Method</Label>
            <Input
              id="pay-method"
              value={form.method}
              onChange={e => setForm((f: any) => ({ ...f, method: e.target.value }))}
              placeholder="e.g. Chase Checking, Venmo"
              data-testid="input-pay-method"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-confirmation">Confirmation #</Label>
            <Input
              id="pay-confirmation"
              value={form.confirmationNumber}
              onChange={e => setForm((f: any) => ({ ...f, confirmationNumber: e.target.value }))}
              placeholder="Optional confirmation number"
              data-testid="input-pay-confirmation"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="btn-confirm-payment">
              {mutation.isPending ? "Recording…" : "Mark Paid"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ObligationRow({
  ob,
  onDelete,
}: {
  ob: Obligation;
  onDelete: (ob: Obligation) => void;
}) {
  const [payOpen, setPayOpen] = useState(false);
  const Icon = OB_ICONS[ob.category] || DollarSign;
  const dueDate = new Date(ob.nextDueDate);
  const now = new Date();
  const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);
  const isOverdue  = daysUntilDue < 0;
  const isDueSoon  = daysUntilDue >= 0 && daysUntilDue <= 7;

  return (
    <>
      <div
        className={`flex items-center gap-2.5 py-2 px-2.5 rounded-lg border group ${isOverdue ? "border-red-500/40 bg-red-500/5" : isDueSoon ? "border-yellow-500/30 bg-yellow-500/5" : "border-transparent hover:border-border hover:bg-muted/30"} transition-colors`}
        data-testid={`row-obligation-${ob.id}`}
      >
        <div className={`p-1.5 rounded-md shrink-0 ${isOverdue ? "bg-red-500/10" : isDueSoon ? "bg-yellow-500/10" : "bg-primary/10"}`}>
          <Icon className={`h-3 w-3 ${isOverdue ? "text-red-500" : isDueSoon ? "text-yellow-500" : "text-primary"}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium truncate">{ob.name}</span>
            {ob.autopay && (
              <span className="text-[9px] text-green-600 shrink-0">auto</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-semibold">${ob.amount.toLocaleString()}</span>
            <span className="text-[9px] text-muted-foreground">{fmtDate(ob.nextDueDate)}</span>
            {isOverdue && (
              <Badge variant="destructive" className="text-[8px] h-3.5 px-1">{Math.abs(daysUntilDue)}d late</Badge>
            )}
            {isDueSoon && !isOverdue && (
              <Badge className="text-[8px] h-3.5 px-1 bg-yellow-500/20 text-yellow-600 border-yellow-500/30">
                {daysUntilDue === 0 ? "Today" : `${daysUntilDue}d`}
              </Badge>
            )}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPayOpen(true)}
          className="h-6 text-[10px] shrink-0"
          data-testid={`button-pay-${ob.id}`}
        >
          Pay
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(ob)}
          data-testid={`btn-delete-obligation-${ob.id}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {payOpen && (
        <PayObligationDialog
          open={payOpen}
          onClose={() => setPayOpen(false)}
          obligation={ob}
        />
      )}
    </>
  );
}

function ObligationsSection() {
  const [addOpen, setAddOpen] = useState(false);
  const [deleteOb, setDeleteOb] = useState<Obligation | null>(null);
  const { toast } = useToast();

  const { data: obligations = [], isLoading } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"],
    queryFn: () => apiRequest("GET", "/api/obligations").then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/obligations/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Obligation deleted" });
      setDeleteOb(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete obligation", variant: "destructive" });
    },
  });

  const sorted = [...obligations].sort((a, b) =>
    new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()
  );

  return (
    <>
      <CollapsibleSection
        icon={CreditCard}
        label="Obligations"
        count={obligations.length}
        onAdd={() => setAddOpen(true)}
        testId="section-obligations"
      >
        {isLoading ? (
          <div className="space-y-1.5">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">No obligations yet.</p>
        ) : (
          <div className="space-y-0.5">
            {sorted.map(ob => (
              <ObligationRow key={ob.id} ob={ob} onDelete={setDeleteOb} />
            ))}
          </div>
        )}
      </CollapsibleSection>

      {addOpen && <ObligationDialog open={addOpen} onClose={() => setAddOpen(false)} />}

      <Dialog open={!!deleteOb} onOpenChange={o => { if (!o) setDeleteOb(null); }}>
        <DialogContent data-testid="dialog-delete-obligation">
          <DialogHeader>
            <DialogTitle>Delete Obligation?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteOb?.name}"? Payment history will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOb(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteOb && deleteMutation.mutate(deleteOb.id)}
              data-testid="btn-confirm-delete-obligation"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Journal Section ──────────────────────────────────────────────────────

interface JournalFormData {
  mood: MoodLevel;
  content: string;
  tags: string;
  energy: string;
}

function JournalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState<JournalFormData>({
    mood: "good",
    content: "",
    tags: "",
    energy: "3",
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const tagsArr = form.tags
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      const res = await apiRequest("POST", "/api/journal", {
        mood: form.mood,
        content: form.content,
        tags: tagsArr,
        energy: parseInt(form.energy),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Journal entry saved" });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save journal entry", variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const moods: MoodLevel[] = ["amazing", "good", "neutral", "bad", "awful"];

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-add-journal">
        <DialogHeader>
          <DialogTitle>New Journal Entry</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>How are you feeling?</Label>
            <div className="flex gap-2 justify-between">
              {moods.map(m => {
                const cfg = MOOD_CONFIG[m];
                const MoodIcon = cfg.icon;
                const selected = form.mood === m;
                return (
                  <button
                    key={m}
                    type="button"
                    className={`flex flex-col items-center gap-1 p-2 rounded-lg border-2 transition-all flex-1 ${selected ? "border-primary" : "border-transparent hover:border-border"}`}
                    onClick={() => setForm((f: any) => ({ ...f, mood: m }))}
                    data-testid={`mood-btn-${m}`}
                    style={selected ? { borderColor: cfg.color } : {}}
                  >
                    <div className={`p-1.5 rounded-full ${cfg.bg}`}>
                      <MoodIcon className="h-4 w-4" style={{ color: cfg.color }} />
                    </div>
                    <span className="text-[9px] text-muted-foreground">{cfg.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="journal-content">What's on your mind?</Label>
            <Textarea
              id="journal-content"
              value={form.content}
              onChange={e => setForm((f: any) => ({ ...f, content: e.target.value }))}
              placeholder="Write about your day…"
              rows={3}
              data-testid="input-journal-content"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="journal-tags">Tags</Label>
              <Input
                id="journal-tags"
                value={form.tags}
                onChange={e => setForm((f: any) => ({ ...f, tags: e.target.value }))}
                placeholder="work, health"
                data-testid="input-journal-tags"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="journal-energy">Energy (1-5)</Label>
              <Select
                value={form.energy}
                onValueChange={v => setForm((f: any) => ({ ...f, energy: v }))}
              >
                <SelectTrigger id="journal-energy" data-testid="select-journal-energy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 — Very Low</SelectItem>
                  <SelectItem value="2">2 — Low</SelectItem>
                  <SelectItem value="3">3 — Moderate</SelectItem>
                  <SelectItem value="4">4 — High</SelectItem>
                  <SelectItem value="5">5 — Very High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="btn-save-journal">
              {mutation.isPending ? "Saving…" : "Save Entry"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function JournalSection() {
  const [addOpen, setAddOpen] = useState(false);
  const [deleteEntry, setDeleteEntry] = useState<JournalEntry | null>(null);
  const { toast } = useToast();

  const { data: entries = [], isLoading } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal"],
    queryFn: () => apiRequest("GET", "/api/journal").then(r => r.json()),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/journal/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Entry deleted" });
      setDeleteEntry(null);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete entry", variant: "destructive" });
    },
  });

  const last7 = Array.from({ length: 7 }, (_, i) => {
    const dateStr = new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10);
    const entry = entries.find(e => e.date === dateStr);
    return { date: dateStr, mood: entry?.mood };
  });

  const recent = entries.slice(0, 3);

  return (
    <>
      <CollapsibleSection
        icon={BookHeart}
        label="Journal"
        count={entries.length}
        onAdd={() => setAddOpen(true)}
        testId="section-journal"
      >
        {/* 7-day mood strip */}
        <div className="flex gap-1.5 justify-start mb-2">
          {last7.map((day, i) => {
            const cfg = day.mood ? MOOD_CONFIG[day.mood] : null;
            const MIcon = cfg?.icon || Meh;
            return (
              <div key={i} className="flex flex-col items-center gap-0.5">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center ${cfg ? cfg.bg : "bg-muted"}`}
                  title={day.date + (day.mood ? ` — ${day.mood}` : " — no entry")}
                >
                  <MIcon className="h-3 w-3" style={{ color: cfg?.color || "#797876" }} />
                </div>
                <span className="text-[8px] text-muted-foreground">{fmtDow(day.date)}</span>
              </div>
            );
          })}
        </div>

        {isLoading ? (
          <div className="space-y-1.5">
            {[1, 2].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}
          </div>
        ) : recent.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">No entries yet.</p>
        ) : (
          <div className="space-y-1">
            {recent.map(entry => {
              const cfg = MOOD_CONFIG[entry.mood] || MOOD_CONFIG.neutral;
              const MoodIcon = cfg.icon;
              return (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 p-2 rounded-lg bg-muted/40 group"
                  data-testid={`row-journal-${entry.id}`}
                >
                  <div className={`p-1 rounded-lg shrink-0 ${cfg.bg}`}>
                    <MoodIcon className="h-3 w-3" style={{ color: cfg.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[10px] font-semibold" style={{ color: cfg.color }}>{cfg.label}</span>
                      <span className="text-[9px] text-muted-foreground">{fmtDate(entry.createdAt)}</span>
                    </div>
                    {entry.content && (
                      <p className="text-[10px] text-foreground/80 line-clamp-2">{entry.content}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteEntry(entry)}
                    data-testid={`btn-delete-journal-${entry.id}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>

      {addOpen && <JournalDialog open={addOpen} onClose={() => setAddOpen(false)} />}

      <Dialog open={!!deleteEntry} onOpenChange={o => { if (!o) setDeleteEntry(null); }}>
        <DialogContent data-testid="dialog-delete-journal">
          <DialogHeader>
            <DialogTitle>Delete Journal Entry?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this entry from {deleteEntry ? fmtDate(deleteEntry.createdAt) : ""}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteEntry(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteEntry && deleteMutation.mutate(deleteEntry.id)}
              data-testid="btn-confirm-delete-journal"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── AI Insights ───────────────────────────────────────────────────────────

// ─── AI Digest Types ────────────────────────────────────────────────────────

interface AIDigestSection {
  title: string;
  icon: string;
  insight: string;
  recommendation: string;
  severity: "positive" | "neutral" | "warning" | "critical";
}

interface AIDigestCorrelation {
  insight: string;
  entities: string[];
}

interface AIDigestWeekSummary {
  tasksCompleted: number;
  tasksCreated: number;
  habitsCheckedIn: number;
  totalHabitDays: number;
  expensesTotal: number;
  topExpenseCategory: string;
  trackerEntries: number;
  journalEntries: number;
  avgMood: string;
  documentsUploaded: number;
}

interface AIDigestData {
  headline: string;
  score: number;
  generatedAt: string;
  sections: AIDigestSection[];
  correlations: AIDigestCorrelation[];
  weekSummary: AIDigestWeekSummary;
}

const DIGEST_SECTION_ICONS: Record<string, any> = {
  heart: HeartPulse,
  dollar: Wallet,
  brain: Brain,
  flame: Flame,
  calendar: CalendarClock,
  target: Target,
};

const SEVERITY_STYLES: Record<string, { border: string; text: string; bg: string; dot: string }> = {
  positive: { border: "border-green-500/30", text: "text-green-600 dark:text-green-400", bg: "bg-green-500/10", dot: "bg-green-500" },
  neutral:  { border: "border-border", text: "text-muted-foreground", bg: "bg-muted/50", dot: "bg-muted-foreground" },
  warning:  { border: "border-amber-500/30", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-500/10", dot: "bg-amber-500" },
  critical: { border: "border-red-500/30", text: "text-red-600 dark:text-red-400", bg: "bg-red-500/10", dot: "bg-red-500" },
};

function ScoreRing({ score, size = 56 }: { score: number; size?: number }) {
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const color = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";

  return (
    <svg width={size} height={size} className="-rotate-90" data-testid="digest-score-ring">
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke="currentColor" strokeWidth={3}
        className="text-muted/30"
      />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        fill="none" stroke={color} strokeWidth={3}
        strokeDasharray={`${progress} ${circumference - progress}`}
        strokeLinecap="round"
      />
      <text
        x={size / 2} y={size / 2}
        textAnchor="middle" dominantBaseline="central"
        className="rotate-90 origin-center fill-foreground"
        fontSize={size * 0.3} fontWeight="bold"
      >
        {score}
      </text>
    </svg>
  );
}

const INSIGHT_BORDER: Record<string, string> = {
  positive: "border-l-green-500",
  negative: "border-l-red-500",
  warning:  "border-l-amber-500",
  info:     "border-l-blue-500",
};

const INSIGHT_NAV: Record<string, string> = {
  reminder: "/",
  spending_trend: "/dashboard",
  habit_streak: "/dashboard",
  obligation_due: "/dashboard",
  health_correlation: "/trackers",
  anomaly: "/trackers",
  mood_trend: "/dashboard",
  streak: "/dashboard",
  suggestion: "/dashboard",
};

function AIDigestFallback() {
  const { data: insights = [], isLoading } = useQuery<Insight[]>({
    queryKey: ["/api/insights"],
    queryFn: () => apiRequest("GET", "/api/insights").then(r => r.json()),
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
  });

  if (!isLoading && insights.length === 0) return null;

  return (
    <CollapsibleSection
      icon={Brain}
      label="AI Insights"
      count={insights.length}
      testId="section-insights-fallback"
    >
      {isLoading ? (
        <div className="space-y-1.5">
          {[1, 2].map(i => <Skeleton key={i} className="h-10 rounded-lg" />)}
        </div>
      ) : (
        <div className="space-y-1.5">
          {insights.map(insight => {
            const Icon = INSIGHT_ICONS[insight.type] || Lightbulb;
            const colorClass = INSIGHT_COLORS[insight.severity] || INSIGHT_COLORS.info;
            const borderClass = INSIGHT_BORDER[insight.severity] || INSIGHT_BORDER.info;
            const isCritical = insight.severity === "negative" || insight.severity === "warning";
            const navTarget = INSIGHT_NAV[insight.type];
            return (
              <div
                key={insight.id}
                className={`flex items-start gap-2 p-2 rounded-lg bg-muted/50 border-l-[3px] ${borderClass} ${navTarget ? "cursor-pointer hover:bg-muted/80 transition-colors" : ""}`}
                data-testid={`insight-${insight.id}`}
                onClick={navTarget ? () => { window.location.hash = navTarget; } : undefined}
              >
                <div className={`p-1 rounded-md shrink-0 ${colorClass} relative`}>
                  <Icon className="h-3 w-3" />
                  {isCritical && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium">{insight.title}</p>
                  <p className="text-[9px] text-muted-foreground line-clamp-2 mt-0.5">{insight.description}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ─── Goal Type Config ──────────────────────────────────────────────────────

const GOAL_TYPE_LABELS: Record<string, string> = {
  weight_loss: "Weight Loss",
  weight_gain: "Weight Gain",
  savings: "Savings",
  habit_streak: "Habit Streak",
  spending_limit: "Spending Limit",
  fitness_distance: "Fitness Distance",
  fitness_frequency: "Fitness Frequency",
  tracker_target: "Tracker Target",
  custom: "Custom",
};

const GOAL_TYPE_COLORS: Record<string, string> = {
  weight_loss: "bg-green-500/10 text-green-600 dark:text-green-400",
  weight_gain: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  savings: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  habit_streak: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  spending_limit: "bg-red-500/10 text-red-600 dark:text-red-400",
  fitness_distance: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  fitness_frequency: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  tracker_target: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  custom: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

function GoalEditDialog({ open, onClose, goal }: { open: boolean; onClose: () => void; goal: any }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    title: goal?.title ?? "", target: goal?.target?.toString() ?? "",
    deadline: goal?.deadline?.slice(0, 10) ?? "", current: goal?.current?.toString() ?? "0",
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/goals/${goal.id}`, {
        title: form.title, target: parseFloat(form.target),
        deadline: form.deadline || undefined, current: parseFloat(form.current) || 0,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Goal updated" });
      onClose();
    },
    onError: () => toast({ title: "Error", description: "Failed to update", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent data-testid="dialog-edit-goal">
        <DialogHeader><DialogTitle>Edit Goal</DialogTitle></DialogHeader>
        <form onSubmit={e => { e.preventDefault(); if (!form.title.trim()) { toast({ title: "Title required", description: "Enter a goal title", variant: "destructive" }); return; } if (!form.target || parseFloat(form.target) <= 0) { toast({ title: "Invalid target", description: "Target must be greater than 0", variant: "destructive" }); return; } mutation.mutate(); }} className="space-y-3">
          <div className="space-y-1"><Label>Title</Label><Input value={form.title} onChange={e => setForm(f => ({...f, title: e.target.value}))} required data-testid="input-edit-goal-title" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><Label>Target</Label><Input type="number" step="0.1" value={form.target} onChange={e => setForm(f => ({...f, target: e.target.value}))} required data-testid="input-edit-goal-target" /></div>
            <div className="space-y-1"><Label>Current</Label><Input type="number" step="0.1" value={form.current} onChange={e => setForm(f => ({...f, current: e.target.value}))} data-testid="input-edit-goal-current" /></div>
          </div>
          <div className="space-y-1"><Label>Deadline</Label><Input type="date" value={form.deadline} onChange={e => setForm(f => ({...f, deadline: e.target.value}))} data-testid="input-edit-goal-deadline" /></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GoalsSection() {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editGoal, setEditGoal] = useState<any>(null);
  const [logProgressGoal, setLogProgressGoal] = useState<any>(null);
  const [logAmount, setLogAmount] = useState("");
  const [form, setForm] = useState({
    title: "",
    type: "custom" as Goal["type"],
    target: "",
    unit: "",
    startValue: "",
    deadline: "",
    trackerId: "",
    habitId: "",
    category: "",
  });

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ["/api/goals"],
    queryFn: () => apiRequest("GET", "/api/goals").then(r => r.json()),
  });

  const { data: trackers = [] } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers"],
    queryFn: () => apiRequest("GET", "/api/trackers").then(r => r.json()),
  });

  const { data: habits = [] } = useQuery<Habit[]>({
    queryKey: ["/api/habits"],
    queryFn: () => apiRequest("GET", "/api/habits").then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/goals", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Goal created" });
      setAddOpen(false);
      setForm({ title: "", type: "custom", target: "", unit: "", startValue: "", deadline: "", trackerId: "", habitId: "", category: "" });
    },
    onError: () => toast({ title: "Failed to create goal", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => apiRequest("PATCH", `/api/goals/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/goals/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Goal deleted" });
    },
  });

  const handleSubmit = () => {
    if (!form.title.trim()) { toast({ title: "Title required", description: "Enter a goal title", variant: "destructive" }); return; }
    if (!form.target || parseFloat(form.target) <= 0) { toast({ title: "Invalid target", description: "Target must be greater than 0", variant: "destructive" }); return; }
    createMutation.mutate({
      title: form.title,
      type: form.type,
      target: parseFloat(form.target),
      unit: form.unit || "units",
      startValue: form.startValue ? parseFloat(form.startValue) : undefined,
      deadline: form.deadline || undefined,
      trackerId: form.trackerId || undefined,
      habitId: form.habitId || undefined,
      category: form.category || undefined,
    });
  };

  const showTrackerLink = ["weight_loss", "weight_gain", "fitness_distance", "fitness_frequency", "tracker_target"].includes(form.type);
  const showHabitLink = form.type === "habit_streak";
  const showCategoryLink = form.type === "spending_limit";

  function getProgressPercent(goal: Goal): number {
    if (goal.type === "weight_loss" && goal.startValue) {
      const totalChange = goal.startValue - goal.target;
      const currentChange = goal.startValue - goal.current;
      return totalChange > 0 ? Math.min(100, Math.max(0, (currentChange / totalChange) * 100)) : 0;
    }
    if (goal.type === "spending_limit") {
      // For spending limits, progress = how much budget used (inverse)
      return goal.target > 0 ? Math.min(100, (goal.current / goal.target) * 100) : 0;
    }
    return goal.target > 0 ? Math.min(100, Math.max(0, (goal.current / goal.target) * 100)) : 0;
  }

  function getProgressColor(goal: Goal): string {
    const pct = getProgressPercent(goal);
    if (goal.type === "spending_limit") {
      return pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-green-500";
    }
    if (!goal.deadline) return pct >= 75 ? "bg-green-500" : pct >= 40 ? "bg-amber-500" : "bg-slate-400";
    const now = new Date();
    const deadlineDate = new Date(goal.deadline);
    const created = new Date(goal.createdAt);
    const totalDays = Math.max(1, (deadlineDate.getTime() - created.getTime()) / 86400000);
    const daysElapsed = Math.max(0, (now.getTime() - created.getTime()) / 86400000);
    const expectedPct = (daysElapsed / totalDays) * 100;
    if (pct >= expectedPct * 0.9) return "bg-green-500";
    if (pct >= expectedPct * 0.6) return "bg-amber-500";
    return "bg-red-500";
  }

  function getDeadlineText(goal: Goal): string | null {
    if (!goal.deadline) return null;
    const now = new Date();
    const dl = new Date(goal.deadline);
    const daysLeft = Math.ceil((dl.getTime() - now.getTime()) / 86400000);
    if (daysLeft < 0) return "Overdue";
    if (daysLeft === 0) return "Due today";
    if (daysLeft === 1) return "1 day left";
    return `${daysLeft} days left`;
  }

  const activeGoals = goals.filter(g => g.status === "active");
  const completedGoals = goals.filter(g => g.status === "completed");

  return (
    <CollapsibleSection
      label="Goals"
      icon={Target}
      count={activeGoals.length > 0 ? activeGoals.length : undefined}
      defaultOpen
      onAdd={() => setAddOpen(true)}
      testId="section-goals"
    >
      {isLoading ? (
        <div className="space-y-2" data-testid="goals-loading">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : activeGoals.length === 0 && completedGoals.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground" data-testid="goals-empty">
          <Target className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-xs font-medium">Set your first goal</p>
          <p className="text-[10px] mt-1">Try telling the AI: "I want to lose 10 lbs by summer"</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="goals-list">
          {activeGoals.map(goal => {
            const pct = getProgressPercent(goal);
            const barColor = getProgressColor(goal);
            const deadlineTxt = getDeadlineText(goal);
            const isOverdue = deadlineTxt === "Overdue";
            return (
              <div key={goal.id} className="p-2.5 rounded-lg border bg-card" data-testid={`goal-card-${goal.id}`}>
                <div className="flex items-start justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-medium truncate" data-testid={`goal-title-${goal.id}`}>{goal.title}</span>
                    <Badge variant="secondary" className={`text-[9px] px-1 py-0 shrink-0 ${GOAL_TYPE_COLORS[goal.type] || ""}`} data-testid={`goal-type-${goal.id}`}>
                      {GOAL_TYPE_LABELS[goal.type] || goal.type}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {goal.status === "active" && (
                      <>
                        <Button variant="ghost" size="sm" className="h-5 px-1 text-[9px] gap-0.5 text-primary" onClick={() => { setLogProgressGoal(goal); setLogAmount(""); }} data-testid={`goal-log-${goal.id}`}>
                          <Plus className="h-3 w-3" /> Log
                        </Button>
                        <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => updateMutation.mutate({ id: goal.id, data: { status: "completed" } })} data-testid={`goal-complete-${goal.id}`}>
                          <Check className="h-3 w-3 text-green-500" />
                        </Button>
                      </>
                    )}
                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setEditGoal(goal)} data-testid={`goal-edit-${goal.id}`}>
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => deleteMutation.mutate(goal.id)} data-testid={`goal-delete-${goal.id}`}>
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="relative h-2 rounded-full bg-muted overflow-hidden mb-1" data-testid={`goal-progress-bar-${goal.id}`}>
                  <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
                  {/* Milestones as dots */}
                  {goal.milestones?.map((m, i) => {
                    const mPct = goal.type === "weight_loss" && goal.startValue
                      ? ((goal.startValue - m.value) / (goal.startValue - goal.target)) * 100
                      : (m.value / goal.target) * 100;
                    return (
                      <div
                        key={i}
                        className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full border border-background ${m.reached ? "bg-green-500" : "bg-muted-foreground/40"}`}
                        style={{ left: `${Math.min(98, mPct)}%` }}
                        title={m.label}
                        data-testid={`goal-milestone-${goal.id}-${i}`}
                      />
                    );
                  })}
                </div>

                {/* Stats row */}
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span data-testid={`goal-current-${goal.id}`}>
                    {goal.type === "weight_loss" || goal.type === "weight_gain"
                      ? `${goal.current} ${goal.unit} (target: ${goal.target})`
                      : `${Math.round(goal.current * 10) / 10} / ${goal.target} ${goal.unit}`
                    }
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium" data-testid={`goal-pct-${goal.id}`}>{Math.round(pct)}%</span>
                    {deadlineTxt && (
                      <span className={isOverdue ? "text-red-500 font-medium" : ""} data-testid={`goal-deadline-${goal.id}`}>
                        {deadlineTxt}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Completed goals - collapsed */}
          {completedGoals.length > 0 && (
            <div className="pt-1">
              <p className="text-[10px] text-muted-foreground mb-1">{completedGoals.length} completed</p>
              {completedGoals.slice(0, 3).map(goal => (
                <div key={goal.id} className="flex items-center justify-between text-[10px] text-muted-foreground py-0.5" data-testid={`goal-completed-${goal.id}`}>
                  <span className="flex items-center gap-1">
                    <Check className="h-3 w-3 text-green-500" />
                    <span className="line-through">{goal.title}</span>
                  </span>
                  <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => deleteMutation.mutate(goal.id)} data-testid={`goal-delete-completed-${goal.id}`}>
                    <Trash2 className="h-2.5 w-2.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Goal Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-add-goal">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Goal</DialogTitle>
            <DialogDescription className="text-xs">Set a measurable goal to track your progress.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-xs">Title</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm((f: any) => ({ ...f, title: e.target.value }))}
                placeholder="e.g., Lose 10 lbs"
                className="text-xs h-8 mt-1"
                data-testid="input-goal-title"
              />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((f: any) => ({ ...f, type: v as Goal["type"] }))}>
                <SelectTrigger className="text-xs h-8 mt-1" data-testid="select-goal-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(GOAL_TYPE_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Target</Label>
                <Input
                  type="number"
                  value={form.target}
                  onChange={(e) => setForm((f: any) => ({ ...f, target: e.target.value }))}
                  placeholder="e.g., 175"
                  className="text-xs h-8 mt-1"
                  data-testid="input-goal-target"
                />
              </div>
              <div>
                <Label className="text-xs">Unit</Label>
                <Input
                  value={form.unit}
                  onChange={(e) => setForm((f: any) => ({ ...f, unit: e.target.value }))}
                  placeholder="lbs, $, miles"
                  className="text-xs h-8 mt-1"
                  data-testid="input-goal-unit"
                />
              </div>
            </div>
            {(form.type === "weight_loss" || form.type === "weight_gain") && (
              <div>
                <Label className="text-xs">Start Value (current weight)</Label>
                <Input
                  type="number"
                  value={form.startValue}
                  onChange={(e) => setForm((f: any) => ({ ...f, startValue: e.target.value }))}
                  placeholder="e.g., 185"
                  className="text-xs h-8 mt-1"
                  data-testid="input-goal-start-value"
                />
              </div>
            )}
            <div>
              <Label className="text-xs">Deadline (optional)</Label>
              <Input
                type="date"
                value={form.deadline}
                onChange={(e) => setForm((f: any) => ({ ...f, deadline: e.target.value }))}
                className="text-xs h-8 mt-1"
                data-testid="input-goal-deadline"
              />
            </div>
            {showTrackerLink && (
              <div>
                <Label className="text-xs">Link Tracker</Label>
                <Select value={form.trackerId} onValueChange={(v) => setForm((f: any) => ({ ...f, trackerId: v }))}>
                  <SelectTrigger className="text-xs h-8 mt-1" data-testid="select-goal-tracker">
                    <SelectValue placeholder="Select tracker..." />
                  </SelectTrigger>
                  <SelectContent>
                    {trackers.map(t => (
                      <SelectItem key={t.id} value={t.id} className="text-xs">{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showHabitLink && (
              <div>
                <Label className="text-xs">Link Habit</Label>
                <Select value={form.habitId} onValueChange={(v) => setForm((f: any) => ({ ...f, habitId: v }))}>
                  <SelectTrigger className="text-xs h-8 mt-1" data-testid="select-goal-habit">
                    <SelectValue placeholder="Select habit..." />
                  </SelectTrigger>
                  <SelectContent>
                    {habits.map(h => (
                      <SelectItem key={h.id} value={h.id} className="text-xs">{h.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {showCategoryLink && (
              <div>
                <Label className="text-xs">Expense Category</Label>
                <Input
                  value={form.category}
                  onChange={(e) => setForm((f: any) => ({ ...f, category: e.target.value }))}
                  placeholder="e.g., food, entertainment"
                  className="text-xs h-8 mt-1"
                  data-testid="input-goal-category"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button size="sm" className="text-xs" onClick={handleSubmit} disabled={createMutation.isPending || !form.title || !form.target} data-testid="btn-save-goal">
              {createMutation.isPending ? "Saving..." : "Save Goal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {editGoal && <GoalEditDialog open={!!editGoal} onClose={() => setEditGoal(null)} goal={editGoal} />}

      {/* Log Progress Dialog */}
      <Dialog open={!!logProgressGoal} onOpenChange={(v) => { if (!v) setLogProgressGoal(null); }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Log Progress</DialogTitle>
            <DialogDescription className="text-xs">
              {logProgressGoal?.title} — currently {logProgressGoal?.current} / {logProgressGoal?.target} {logProgressGoal?.unit}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => {
            e.preventDefault();
            const amount = parseFloat(logAmount);
            if (isNaN(amount) || amount === 0) { toast({ title: "Invalid amount", description: "Enter a non-zero value", variant: "destructive" }); return; }
            if (amount < 0) { toast({ title: "Negative value", description: "Progress amount must be positive", variant: "destructive" }); return; }
            const newCurrent = (logProgressGoal?.current || 0) + amount;
            updateMutation.mutate({ id: logProgressGoal.id, data: { current: newCurrent } });
            toast({ title: "Progress logged", description: `Added ${amount} ${logProgressGoal?.unit || ""} to ${logProgressGoal?.title}` });
            setLogProgressGoal(null);
          }}>
            <Input type="number" step="any" placeholder={`Amount to add (${logProgressGoal?.unit || ""})`} value={logAmount} onChange={e => setLogAmount(e.target.value)} className="mb-3" autoFocus data-testid="input-log-goal-amount" />
            <Button type="submit" className="w-full h-8 text-xs" disabled={!logAmount || parseFloat(logAmount) === 0} data-testid="btn-submit-goal-progress">
              Log {logAmount ? `+${logAmount} ${logProgressGoal?.unit || ""}` : "Progress"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </CollapsibleSection>
  );
}

function InsightsSection() {
  const { data: digest, isLoading, isError, refetch, isFetching } = useQuery<AIDigestData>({
    queryKey: ["/api/ai-digest"],
    queryFn: async () => {
      try {
        const res = await fetch('/api/ai-digest');
        if (res.ok) return res.json();
        return null;
      } catch { return null; }
    },
    retry: false,
  });

  const handleRefresh = () => {
    apiRequest("GET", "/api/ai-digest?force=true")
      .then(r => r.json())
      .then(data => {
        queryClient.setQueryData(["/api/ai-digest"], data);
      })
      .catch(() => {});
  };

  // Fallback to static insights on error
  if (isError) {
    return <AIDigestFallback />;
  }

  // Loading / shimmer state
  if (isLoading) {
    return (
      <CollapsibleSection icon={Sparkles} label="AI Insights" testId="section-insights">
        <div className="space-y-2" data-testid="digest-loading">
          <div className="flex items-center gap-3">
            <Skeleton className="h-14 w-14 rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 rounded-lg" />)}
          <Skeleton className="h-8 rounded-lg" />
        </div>
      </CollapsibleSection>
    );
  }

  if (!digest) return null;

  const generatedAt = new Date(digest.generatedAt);
  const minutesAgo = Math.round((Date.now() - generatedAt.getTime()) / 60000);
  const timeLabel = minutesAgo < 1 ? "Just now" : minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.round(minutesAgo / 60)}h ago`;

  const ws = digest.weekSummary;
  const moodEmoji: Record<string, string> = { amazing: "🤩", good: "😊", neutral: "😐", bad: "😞", awful: "😢", none: "—" };

  return (
    <CollapsibleSection icon={Sparkles} label="AI Insights" testId="section-insights">
      <div className="space-y-2.5" data-testid="digest-content">

        {/* Header: Headline + Score */}
        <div className="flex items-center gap-3 p-2.5 rounded-lg bg-card border border-border" data-testid="digest-header">
          <ScoreRing score={digest.score} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold leading-tight" data-testid="digest-headline">{digest.headline}</p>
            <p className="text-[9px] text-muted-foreground mt-0.5">Life Score · Week of {new Date(Date.now() - 7 * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" })} – {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
          </div>
        </div>

        {/* Section Cards */}
        <div className="grid grid-cols-1 gap-1.5" data-testid="digest-sections">
          {digest.sections.map((section, idx) => {
            const Icon = DIGEST_SECTION_ICONS[section.icon] || Brain;
            const style = SEVERITY_STYLES[section.severity] || SEVERITY_STYLES.neutral;
            return (
              <div
                key={idx}
                className={`p-2 rounded-lg bg-card border ${style.border}`}
                data-testid={`digest-section-${idx}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <div className={`p-0.5 rounded ${style.bg}`}>
                    <Icon className={`h-3 w-3 ${style.text}`} />
                  </div>
                  <span className="text-[10px] font-semibold">{section.title}</span>
                  <div className={`ml-auto h-1.5 w-1.5 rounded-full ${style.dot}`} />
                </div>
                <p className="text-[10px] text-foreground/80 leading-snug">{section.insight}</p>
                <p className="text-[9px] text-muted-foreground mt-1 italic">→ {section.recommendation}</p>
              </div>
            );
          })}
        </div>

        {/* Correlations */}
        {digest.correlations.length > 0 && (
          <div className="space-y-1" data-testid="digest-correlations">
            <div className="flex items-center gap-1 px-0.5">
              <Link2 className="h-3 w-3 text-primary/60" />
              <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider">Connections</span>
            </div>
            {digest.correlations.map((c, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 p-2 rounded-lg bg-primary/5 border border-primary/10"
                data-testid={`digest-correlation-${idx}`}
              >
                <Link2 className="h-3 w-3 text-primary shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-foreground/80 leading-snug">{c.insight}</p>
                  <div className="flex gap-1 mt-1">
                    {c.entities.map((e, i) => (
                      <Badge key={i} variant="outline" className="text-[8px] px-1 py-0 h-3.5">{e}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Week Summary Stats */}
        <div className="grid grid-cols-5 gap-1 p-2 rounded-lg bg-muted/30 border border-border/50" data-testid="digest-week-summary">
          <div className="text-center">
            <p className="text-[10px] font-bold">{ws.tasksCompleted}<span className="text-muted-foreground font-normal">/{ws.tasksCreated}</span></p>
            <p className="text-[8px] text-muted-foreground">Tasks ✓</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold">{ws.habitsCheckedIn}<span className="text-muted-foreground font-normal">/{ws.totalHabitDays}</span></p>
            <p className="text-[8px] text-muted-foreground">Habits 🔥</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold">{formatMoney(ws.expensesTotal)}</p>
            <p className="text-[8px] text-muted-foreground">Spent 💰</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold">{moodEmoji[ws.avgMood] || "—"}</p>
            <p className="text-[8px] text-muted-foreground">Mood</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] font-bold">{ws.trackerEntries}</p>
            <p className="text-[8px] text-muted-foreground">Entries 📊</p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-0.5" data-testid="digest-footer">
          <p className="text-[9px] text-muted-foreground">Generated {timeLabel}</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-[9px] px-1.5 gap-1"
            onClick={handleRefresh}
            disabled={isFetching}
            data-testid="btn-refresh-digest"
          >
            <RefreshCw className={`h-2.5 w-2.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>
    </CollapsibleSection>
  );
}

// ─── Recent Activity ───────────────────────────────────────────────────────

const ACTIVITY_ICONS: Record<string, any> = {
  task: ListTodo, habit: Flame, journal: BookHeart, obligation: CreditCard,
  event: Calendar, expense: DollarSign, tracker: BarChart3, artifact: FileText,
  profile: Users, note: FileText,
};

function RecentActivity({ stats }: { stats: DashboardStats }) {
  const recent = (stats.recentActivity || []).slice(0, 8);

  return (
    <CollapsibleSection
      icon={Activity}
      label="Recent Activity"
      count={recent.length}
      defaultOpen={false}
      testId="section-recent-activity"
    >
      {recent.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">No recent activity.</p>
      ) : (
        <div className="space-y-0">
          {recent.map((a, i) => {
            const Icon = ACTIVITY_ICONS[a.type] || Activity;
            return (
              <div key={i} className="flex items-start gap-2 py-1.5 border-b border-border/30 last:border-0">
                <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <Icon className="h-2.5 w-2.5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-foreground/80 leading-snug">{a.description}</p>
                  <p className="text-[9px] text-muted-foreground">
                    {new Date(a.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ─── Quick Actions ─────────────────────────────────────────────────────────

function QuickActionsRow() {
  const { toast } = useToast();
  const [logWeightOpen, setLogWeightOpen] = useState(false);
  const [addExpenseOpen, setAddExpenseOpen] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);

  // Log Weight — uses direct tracker API (not chat, which requires AI)
  const [weightVal, setWeightVal] = useState("");
  const weightMut = useMutation({
    mutationFn: async () => {
      // Find or create the Weight tracker
      const trackersRes = await apiRequest("GET", "/api/trackers");
      const trackers = await trackersRes.json();
      let weightTracker = trackers.find((t: any) => t.name.toLowerCase() === "weight");
      if (!weightTracker) {
        const createRes = await apiRequest("POST", "/api/trackers", {
          name: "Weight", category: "health", unit: "lbs",
          fields: [{ name: "weight", type: "number", isPrimary: true }],
        });
        weightTracker = await createRes.json();
      }
      const primaryField = weightTracker.fields?.[0]?.name || "weight";
      const entryRes = await apiRequest("POST", `/api/trackers/${weightTracker.id}/entries`, {
        values: { [primaryField]: parseFloat(weightVal) },
      });
      return entryRes.json();
    },
    onSuccess: () => {
      toast({ title: "Weight logged", description: `${weightVal} lbs recorded.` });
      setLogWeightOpen(false);
      setWeightVal("");
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to log weight", description: err.message, variant: "destructive" });
    },
  });

  // Add Expense
  const [expAmount, setExpAmount] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expCategory, setExpCategory] = useState("general");
  const expMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/expenses", {
      amount: parseFloat(expAmount) || 0,
      description: expDesc || "Expense",
      category: expCategory,
      tags: [],
    }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Expense added", description: `$${expAmount} — ${expDesc || "Expense"}` });
      setAddExpenseOpen(false);
      setExpAmount(""); setExpDesc(""); setExpCategory("general");
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
    },
  });

  // Quick Task
  const [taskTitle, setTaskTitle] = useState("");
  const [taskPriority, setTaskPriority] = useState("medium");
  const taskMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tasks", {
      title: taskTitle,
      priority: taskPriority,
      tags: [],
    }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Task created", description: taskTitle });
      setQuickTaskOpen(false);
      setTaskTitle(""); setTaskPriority("medium");
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  // Journal Entry
  const [journalContent, setJournalContent] = useState("");
  const [journalMood, setJournalMood] = useState<string>("neutral");
  const journalMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/journal", {
      mood: journalMood,
      content: journalContent,
      tags: [],
    }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Journal entry saved" });
      setJournalOpen(false);
      setJournalContent(""); setJournalMood("neutral");
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
    },
  });

  // Listen for keyboard shortcut events from KeyboardShortcuts component
  useEffect(() => {
    const onTask = () => setQuickTaskOpen(true);
    const onJournal = () => setJournalOpen(true);
    window.addEventListener("lifeos:quick-task", onTask);
    window.addEventListener("lifeos:quick-journal", onJournal);
    return () => {
      window.removeEventListener("lifeos:quick-task", onTask);
      window.removeEventListener("lifeos:quick-journal", onJournal);
    };
  }, []);

  const btnStyle = "h-9 text-xs gap-1.5 transition-all hover:scale-[1.02] hover:shadow-sm";

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="quick-actions-row">
        <Button variant="outline" className={btnStyle} onClick={() => setLogWeightOpen(true)} data-testid="btn-quick-weight">
          <HeartPulse className="h-3.5 w-3.5" /> Log Weight
        </Button>
        <Button variant="outline" className={btnStyle} onClick={() => setAddExpenseOpen(true)} data-testid="btn-quick-expense">
          <DollarSign className="h-3.5 w-3.5" /> Add Expense
        </Button>
        <Button variant="outline" className={btnStyle} onClick={() => setQuickTaskOpen(true)} data-testid="btn-quick-task">
          <ListTodo className="h-3.5 w-3.5" /> Quick Task
        </Button>
        <Button variant="outline" className={btnStyle} onClick={() => setJournalOpen(true)} data-testid="btn-quick-journal">
          <BookHeart className="h-3.5 w-3.5" /> Journal
        </Button>
      </div>

      {/* Log Weight Dialog */}
      <Dialog open={logWeightOpen} onOpenChange={setLogWeightOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Log Weight</DialogTitle>
            <DialogDescription className="text-xs">Enter your current weight</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); const w = parseFloat(weightVal); if (!w || w <= 0 || w > 1500) { toast({ title: "Invalid weight", description: "Enter a value between 0.1 and 1500 lbs", variant: "destructive" }); return; } weightMut.mutate(); }}>
            <Input type="number" step="0.1" min="0" max="2000" placeholder="e.g. 183.5" value={weightVal} onChange={e => setWeightVal(e.target.value)} className="mb-3" autoFocus data-testid="input-quick-weight" />
            <Button type="submit" className="w-full h-8 text-xs" disabled={!weightVal || weightMut.isPending} data-testid="btn-submit-weight">
              {weightMut.isPending ? "Logging..." : "Log Weight"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Expense Dialog */}
      <Dialog open={addExpenseOpen} onOpenChange={setAddExpenseOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Expense</DialogTitle>
            <DialogDescription className="text-xs">Log a new expense</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (!expAmount || parseFloat(expAmount) <= 0) { toast({ title: "Invalid amount", description: "Enter a positive dollar amount", variant: "destructive" }); return; } if (!expDesc.trim()) { toast({ title: "Description required", description: "Enter a short description", variant: "destructive" }); return; } expMut.mutate(); }} className="space-y-2">
            <Input type="number" step="0.01" placeholder="Amount" value={expAmount} onChange={e => setExpAmount(e.target.value)} autoFocus data-testid="input-quick-expense-amount" />
            <Input placeholder="Description" value={expDesc} onChange={e => setExpDesc(e.target.value)} data-testid="input-quick-expense-desc" />
            <Select value={expCategory} onValueChange={setExpCategory}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-quick-expense-cat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["general", "food", "transport", "health", "entertainment", "shopping", "utilities", "other"].map(c => (
                  <SelectItem key={c} value={c} className="text-xs">{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" className="w-full h-8 text-xs" disabled={!expAmount || expMut.isPending} data-testid="btn-submit-expense">
              {expMut.isPending ? "Adding..." : "Add Expense"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Quick Task Dialog */}
      <Dialog open={quickTaskOpen} onOpenChange={setQuickTaskOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-sm">Quick Task</DialogTitle>
            <DialogDescription className="text-xs">Create a new task</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (!taskTitle.trim()) { toast({ title: "Title required", description: "Enter a task title", variant: "destructive" }); return; } taskMut.mutate(); }} className="space-y-2">
            <Input placeholder="Task title" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} autoFocus data-testid="input-quick-task-title" />
            <Select value={taskPriority} onValueChange={setTaskPriority}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-quick-task-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low" className="text-xs">Low</SelectItem>
                <SelectItem value="medium" className="text-xs">Medium</SelectItem>
                <SelectItem value="high" className="text-xs">High</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" className="w-full h-8 text-xs" disabled={!taskTitle || taskMut.isPending} data-testid="btn-submit-task">
              {taskMut.isPending ? "Creating..." : "Create Task"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Journal Entry Dialog */}
      <Dialog open={journalOpen} onOpenChange={setJournalOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Journal Entry</DialogTitle>
            <DialogDescription className="text-xs">How are you feeling?</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (!journalContent.trim()) { toast({ title: "Write something", description: "Journal entry cannot be empty", variant: "destructive" }); return; } journalMut.mutate(); }} className="space-y-2">
            <div className="flex gap-1.5 justify-center">
              {(["amazing", "good", "neutral", "bad", "awful"] as const).map(mood => {
                const cfg = MOOD_CONFIG[mood];
                const MoodIcon = cfg.icon;
                return (
                  <button
                    key={mood}
                    type="button"
                    className={`p-2 rounded-lg border transition-all ${journalMood === mood ? "border-primary bg-primary/10 scale-110" : "border-border hover:border-primary/30"}`}
                    onClick={() => setJournalMood(mood)}
                    data-testid={`btn-mood-${mood}`}
                  >
                    <MoodIcon className="h-5 w-5" style={{ color: cfg.color }} />
                  </button>
                );
              })}
            </div>
            <Textarea placeholder="What's on your mind?" value={journalContent} onChange={e => setJournalContent(e.target.value)} rows={3} data-testid="input-quick-journal" />
            <Button type="submit" className="w-full h-8 text-xs" disabled={journalMut.isPending} data-testid="btn-submit-journal">
              {journalMut.isPending ? "Saving..." : "Save Entry"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Activity Timeline (from /api/activity) ─────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  create_profile: "Created profile",
  update_profile: "Updated profile",
  delete_profile: "Deleted profile",
  create_task: "Created task",
  complete_task: "Completed task",
  update_task: "Updated task",
  delete_task: "Deleted task",
  log_tracker_entry: "Logged",
  create_tracker: "Created tracker",
  create_expense: "Logged expense",
  delete_expense: "Deleted expense",
  create_event: "Created event",
  update_event: "Updated event",
  delete_event: "Deleted event",
  create_habit: "Created habit",
  checkin_habit: "Checked in",
  update_habit: "Updated habit",
  delete_habit: "Deleted habit",
  create_obligation: "Created bill",
  pay_obligation: "Paid bill",
  update_obligation: "Updated bill",
  delete_obligation: "Deleted bill",
  journal_entry: "Journal entry",
  create_artifact: "Created note",
  delete_artifact: "Deleted note",
  save_memory: "Saved memory",
  delete_memory: "Deleted memory",
  create_goal: "Created goal",
  update_goal: "Updated goal",
  delete_goal: "Deleted goal",
  sync_calendar: "Synced calendar",
  bulk_complete_tasks: "Bulk completed tasks",
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function ActivityTimeline() {
  const { data: activities = [] } = useQuery<Array<{ timestamp: string; action: string; type: string; entityName: string; entityId?: string }>>({
    queryKey: ["/api/activity"],
    queryFn: () => apiRequest("GET", "/api/activity").then(r => r.json()),
    refetchInterval: 30 * 1000,
  });

  return (
    <CollapsibleSection
      icon={Activity}
      label="Recent Activity"
      count={activities.length}
      defaultOpen={false}
      testId="section-activity-timeline"
    >
      {activities.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-3">No recent activity. Use the chat to get started.</p>
      ) : (
        <div className="relative pl-4" data-testid="activity-timeline">
          {/* Vertical timeline line */}
          <div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />
          {activities.slice().reverse().map((a, i) => {
            const Icon = ACTIVITY_ICONS[a.type] || Activity;
            const label = ACTION_LABELS[a.action] || a.action.replace(/_/g, " ");
            return (
              <div key={i} className="flex items-start gap-2.5 pb-2.5 last:pb-0 relative">
                {/* Dot on the line */}
                <div className="absolute left-[-12px] top-1 w-2.5 h-2.5 rounded-full bg-primary/60 border-2 border-background z-10" />
                <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Icon className="h-2.5 w-2.5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-foreground/80 leading-snug">
                    {label} <span className="font-medium">{a.entityName}</span>
                  </p>
                  <p className="text-[9px] text-muted-foreground">{timeAgo(a.timestamp)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

// ─── Dashboard Section Config ────────────────────────────────────────────────

interface DashboardSection {
  id: string;
  label: string;
  icon: any;
  visible: boolean;
  column: "left" | "right" | "full";
}

const DEFAULT_SECTIONS: DashboardSection[] = [
  { id: "insights", label: "AI Insights", icon: Sparkles, visible: true, column: "full" },
  { id: "quick_actions", label: "Quick Actions", icon: Zap, visible: true, column: "full" },
  { id: "alerts", label: "Alerts", icon: AlertTriangle, visible: true, column: "full" },
  { id: "stats", label: "Key Stats", icon: BarChart3, visible: true, column: "full" },
  { id: "mood_habits", label: "Mood & Habits", icon: Flame, visible: true, column: "full" },
  { id: "schedule", label: "Today's Schedule", icon: CalendarClock, visible: true, column: "full" },
  { id: "goals", label: "Goals", icon: Target, visible: true, column: "full" },
  { id: "documents", label: "Documents", icon: FileText, visible: true, column: "left" },
  { id: "profiles", label: "Profiles", icon: Users, visible: true, column: "left" },
  { id: "journal", label: "Journal", icon: BookHeart, visible: true, column: "left" },
  { id: "finance", label: "Finance", icon: Wallet, visible: true, column: "right" },
  { id: "obligations", label: "Obligations", icon: CreditCard, visible: true, column: "right" },
  { id: "health", label: "Health", icon: HeartPulse, visible: true, column: "right" },

  { id: "activity", label: "Recent Activity", icon: Activity, visible: true, column: "full" },
];

function parseSavedLayout(saved: string | null): DashboardSection[] | null {
  if (!saved) return null;
  try {
    const parsed = JSON.parse(saved) as DashboardSection[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    // Restore icon references from DEFAULT_SECTIONS
    const iconMap = new Map(DEFAULT_SECTIONS.map(s => [s.id, s.icon]));
    return parsed.map(s => ({ ...s, icon: iconMap.get(s.id) || Activity })).filter(s => iconMap.has(s.id));
  } catch {
    return null;
  }
}

function serializeLayout(sections: DashboardSection[]): string {
  return JSON.stringify(sections.map(({ id, label, visible, column }) => ({ id, label, visible, column })));
}

// ─── Customize Dialog ─────────────────────────────────────────────────────────

function CustomizeDialog({
  open,
  onOpenChange,
  sections,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: DashboardSection[];
  onSave: (sections: DashboardSection[]) => void;
}) {
  const [draft, setDraft] = useState<DashboardSection[]>(sections);
  const prevOpenRef = useRef(false);

  // Sync draft when dialog opens
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setDraft([...sections]);
    }
    prevOpenRef.current = open;
  }, [open, sections]);

  const toggleVisibility = (id: string) => {
    setDraft(d => d.map(s => s.id === id ? { ...s, visible: !s.visible } : s));
  };

  const moveUp = (id: string) => {
    setDraft(d => {
      const idx = d.findIndex(s => s.id === id);
      if (idx <= 0) return d;
      const next = [...d];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };

  const moveDown = (id: string) => {
    setDraft(d => {
      const idx = d.findIndex(s => s.id === id);
      if (idx < 0 || idx >= d.length - 1) return d;
      const next = [...d];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  };

  const cycleColumn = (id: string) => {
    setDraft(d => d.map(s => {
      if (s.id !== id) return s;
      const order: Array<"full" | "left" | "right"> = ["full", "left", "right"];
      const next = order[(order.indexOf(s.column) + 1) % order.length];
      return { ...s, column: next };
    }));
  };

  const resetToDefault = () => {
    setDraft(DEFAULT_SECTIONS.map(s => ({ ...s })));
  };

  const handleSave = () => {
    onSave(draft);
    onOpenChange(false);
  };

  const columnLabel = (col: string) => {
    switch (col) {
      case "full": return "Full";
      case "left": return "Left";
      case "right": return "Right";
      default: return col;
    }
  };

  const columnBadgeColor = (col: string) => {
    switch (col) {
      case "full": return "bg-primary/10 text-primary";
      case "left": return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
      case "right": return "bg-purple-500/10 text-purple-600 dark:text-purple-400";
      default: return "";
    }
  };

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
                <div
                  key={section.id}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    section.visible
                      ? "bg-muted/50"
                      : "bg-muted/20 opacity-50"
                  }`}
                  data-testid={`section-item-${section.id}`}
                >
                  <GripVertical className="h-3 w-3 text-muted-foreground shrink-0" />
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className={`flex-1 truncate ${!section.visible ? "line-through text-muted-foreground" : ""}`}>
                    {section.label}
                  </span>
                  <button
                    onClick={() => cycleColumn(section.id)}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${columnBadgeColor(section.column)}`}
                    title="Click to cycle column placement"
                    data-testid={`btn-column-${section.id}`}
                  >
                    {columnLabel(section.column)}
                  </button>
                  <button
                    onClick={() => toggleVisibility(section.id)}
                    className="shrink-0 p-1 rounded hover:bg-muted"
                    title={section.visible ? "Hide section" : "Show section"}
                    data-testid={`btn-toggle-${section.id}`}
                  >
                    {section.visible ? (
                      <Eye className="h-3.5 w-3.5 text-foreground/70" />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                  <button
                    onClick={() => moveUp(section.id)}
                    className="shrink-0 p-1 rounded hover:bg-muted disabled:opacity-30"
                    disabled={idx === 0}
                    title="Move up"
                    data-testid={`btn-moveup-${section.id}`}
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => moveDown(section.id)}
                    className="shrink-0 p-1 rounded hover:bg-muted disabled:opacity-30"
                    disabled={idx === draft.length - 1}
                    title="Move down"
                    data-testid={`btn-movedown-${section.id}`}
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
        <DialogFooter className="flex-row items-center justify-between sm:justify-between gap-2 pt-3 border-t">
          <button
            onClick={resetToDefault}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            data-testid="btn-reset-layout"
          >
            <RotateCcw className="h-3 w-3" /> Reset to Default
          </button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onOpenChange(false)}
              data-testid="btn-cancel-customize"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={handleSave}
              data-testid="btn-save-layout"
            >
              Save Layout
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Dashboard ──────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { toast } = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/stats"],
    queryFn: () => apiRequest("GET", "/api/stats").then(r => r.json()),
  });

  const { data: enhanced } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced"],
    queryFn: async () => {
      try {
        const res = await fetch('/api/dashboard-enhanced');
        if (res.ok) return res.json();
        return null;
      } catch { return null; }
    },
    retry: false,
  });

  // Load saved dashboard layout
  const { data: savedLayoutData } = useQuery<{ value: string } | null>({
    queryKey: ["/api/preferences", "dashboard_layout"],
    queryFn: async () => {
      try {
        const res = await fetch('/api/preferences/dashboard_layout');
        if (res.ok) return res.json();
        return null;
      } catch { return null; }
    },
  });

  const sections: DashboardSection[] =
    parseSavedLayout(savedLayoutData?.value ?? null) || DEFAULT_SECTIONS;

  const saveMutation = useMutation({
    mutationFn: (layout: DashboardSection[]) =>
      apiRequest("PUT", "/api/preferences/dashboard_layout", {
        value: serializeLayout(layout),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/preferences"] });
      toast({ title: "Layout saved", description: "Your dashboard layout has been updated." });
    },
    onError: () => {
      toast({ title: "Failed to save layout", variant: "destructive" });
    },
  });

  const handleExport = async () => {
    try {
      const res = await apiRequest("GET", "/api/export");
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lifeos-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Export complete", description: `Backed up ${data.profiles?.length || 0} profiles, ${data.trackers?.length || 0} trackers, ${data.tasks?.length || 0} tasks, and more.` });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
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
        const counts = result.imported;
        const total = Object.values(counts).reduce((s: number, v: any) => s + v, 0);
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
      case "alerts":
        content = enhanced ? <AlertsBanner enhanced={enhanced} /> : null;
        break;
      case "stats":
        content = statsLoading ? (
          <>
            <SkeletonGrid cols={4} h="h-14" />
            <SkeletonGrid cols={4} h="h-14" />
          </>
        ) : stats ? (
          <KeyStatsRow stats={stats} />
        ) : null;
        break;
      case "mood_habits":
        content = stats ? <MoodHabitsRow stats={stats} /> : null;
        break;
      case "schedule":
        content = enhanced?.todaysEvents ? <TodaySchedule events={enhanced.todaysEvents} /> : null;
        break;
      case "goals":
        content = <GoalsSection />;
        break;
      case "documents":
        content = <DocumentsVault />;
        break;
      case "profiles":
        content = <ProfilesSnapshot />;
        break;
      case "journal":
        content = <JournalSection />;
        break;
      case "finance":
        content = enhanced ? <FinanceSnapshot data={enhanced.financeSnapshot} /> : null;
        break;
      case "obligations":
        content = <ObligationsSection />;
        break;
      case "health":
        content = enhanced ? <HealthSnapshot data={enhanced.healthSnapshot} /> : null;
        break;
      case "insights":
        content = <InsightsSection />;
        break;
      case "quick_actions":
        content = <QuickActionsRow />;
        break;
      case "activity":
        content = <ActivityTimeline />;
        break;
      default:
        content = null;
    }
    return content ? <SectionErrorBoundary name={id}>{content}</SectionErrorBoundary> : null;
  }

  const fullWidthSections = sections.filter(s => s.visible && s.column === "full");
  const leftSections = sections.filter(s => s.visible && s.column === "left");
  const rightSections = sections.filter(s => s.visible && s.column === "right");

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-3 md:p-4 space-y-2.5 max-w-full" data-testid="page-dashboard">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Dashboard</h1>
          <p className="text-[10px] text-muted-foreground">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="outline" size="icon" className="h-7 w-7 sm:w-auto sm:px-2 sm:gap-1" onClick={() => setCustomizeOpen(true)} data-testid="btn-customize">
            <Settings className="h-3 w-3" /><span className="hidden sm:inline text-xs">Customize</span>
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7 sm:w-auto sm:px-2 sm:gap-1" onClick={handleExport} data-testid="btn-export">
            <Download className="h-3 w-3" /><span className="hidden sm:inline text-xs">Export</span>
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7 sm:w-auto sm:px-2 sm:gap-1" onClick={() => setImportOpen(true)} data-testid="btn-import">
            <UploadCloud className="h-3 w-3" /><span className="hidden sm:inline text-xs">Import</span>
          </Button>
        </div>
      </div>

      {/* Import Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Import Backup</DialogTitle>
            <DialogDescription>Upload a Portol backup JSON file to restore your data. New items will be added alongside existing data.</DialogDescription>
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
      <CustomizeDialog
        open={customizeOpen}
        onOpenChange={setCustomizeOpen}
        sections={sections}
        onSave={(layout) => saveMutation.mutate(layout)}
      />

      {/* Full-width sections (top) */}
      {fullWidthSections.map(s => (
        <div key={s.id}>{renderSection(s.id)}</div>
      ))}

      {/* Two-column layout for md+ */}
      {(leftSections.length > 0 || rightSections.length > 0) && (
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-3">
            {leftSections.map(s => (
              <div key={s.id}>{renderSection(s.id)}</div>
            ))}
          </div>
          <div className="space-y-3">
            {rightSections.map(s => (
              <div key={s.id}>{renderSection(s.id)}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
