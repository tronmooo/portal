import { formatApiError } from "@/lib/formatError";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  User,
  PawPrint,
  Car,
  Building2,
  Home,
  CreditCard,
  Stethoscope,
  Tag,
  FileText,
  Activity,
  DollarSign,
  ListTodo,
  Calendar,
  Clock,
  Edit,
  Trash2,
  Upload,
  Eye,
  X,
  TrendingUp,
  TrendingDown,
  Minus,
  Shield,
  Wrench,
  Phone,
  MapPin,
  Heart,
  Wallet,
  Package,
  BarChart2,
  Plus,
  CheckCircle2,
  Circle,
  AlertCircle,
  CheckCheck,
  Sparkles,
  RefreshCw,
  Unlink,
  Link2,
  ChevronDown,
  ChevronUp,
  Pencil,
  Check,
  HeartPulse,
  AlertTriangle,
  FileWarning,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Camera,
  Image as ImageIcon,
  Star,
  Pause,
  Play,
  Ban,
  CalendarPlus,
  Globe,
  Mail,
  ExternalLink,
  Receipt,
  Zap,
  Target,
  Search,
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { Slider } from "@/components/ui/slider";
import type { ProfileDetail, Profile, Document, TimelineEntry, Tracker } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ShareButton } from "@/components/DocumentViewer";
import { DocumentViewerDialog } from "@/components/DocumentViewer";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import EditableTitle from "@/components/EditableTitle";
// DynamicProfileDetail import removed — registry system not yet integrated (see registry/index.ts)

// ============================================================
// HELPERS
// ============================================================

function getProfileBanner(type: string): string {
  const banners: Record<string, string> = {
    self:         'linear-gradient(135deg, hsl(188 55% 30%), hsl(262 65% 35%))',
    person:       'linear-gradient(135deg, hsl(215 70% 30%), hsl(262 55% 35%))',
    pet:          'linear-gradient(135deg, hsl(43 85% 35%), hsl(25 80% 35%))',
    vehicle:      'linear-gradient(135deg, hsl(220 20% 20%), hsl(220 15% 28%))',
    asset:        'linear-gradient(135deg, hsl(43 75% 30%), hsl(155 55% 25%))',
    investment:   'linear-gradient(135deg, hsl(155 60% 25%), hsl(188 65% 25%))',
    subscription: 'linear-gradient(135deg, hsl(310 45% 25%), hsl(262 55% 28%))',
    medical:      'linear-gradient(135deg, hsl(0 70% 30%), hsl(25 75% 30%))',
    account:      'linear-gradient(135deg, hsl(188 65% 25%), hsl(155 55% 25%))',
    property:     'linear-gradient(135deg, hsl(262 55% 28%), hsl(215 65% 30%))',
    loan:         'linear-gradient(135deg, hsl(0 72% 28%), hsl(25 75% 28%))',
  };
  return banners[type] || 'linear-gradient(135deg, hsl(40 5% 20%), hsl(40 5% 28%))';
}

function profileIcon(type: string) {
  const icons: Record<string, any> = {
    person: User,
    self: User,
    pet: PawPrint,
    vehicle: Car,
    account: Building2,
    property: Home,
    subscription: CreditCard,
    medical: Stethoscope,
    loan: Wallet,
    investment: TrendingUp,
    asset: Package,
  };
  const Icon = icons[type] || User;
  return <Icon className="h-5 w-5" />;
}

function profileGradient(type: string) {
  const gradients: Record<string, string> = {
    person: "from-blue-500/20 to-blue-600/5",
    self: "from-blue-500/20 to-blue-600/5",
    pet: "from-amber-500/20 to-amber-600/5",
    vehicle: "from-slate-500/20 to-slate-600/5",
    account: "from-emerald-500/20 to-emerald-600/5",
    property: "from-purple-500/20 to-purple-600/5",
    subscription: "from-pink-500/20 to-pink-600/5",
    medical: "from-red-500/20 to-red-600/5",
    loan: "from-orange-500/20 to-orange-600/5",
    investment: "from-green-500/20 to-green-600/5",
    asset: "from-cyan-500/20 to-cyan-600/5",
  };
  return gradients[type] || "from-muted to-background";
}

function profileAccent(type: string) {
  const accents: Record<string, string> = {
    person: "text-blue-600 dark:text-blue-400 bg-blue-500/10",
    self: "text-blue-600 dark:text-blue-400 bg-blue-500/10",
    pet: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
    vehicle: "text-slate-600 dark:text-slate-400 bg-slate-500/10",
    account: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
    property: "text-purple-600 dark:text-purple-400 bg-purple-500/10",
    subscription: "text-pink-600 dark:text-pink-400 bg-pink-500/10",
    medical: "text-red-600 dark:text-red-400 bg-red-500/10",
    loan: "text-orange-600 dark:text-orange-400 bg-orange-500/10",
    investment: "text-green-600 dark:text-green-400 bg-green-500/10",
    asset: "text-cyan-600 dark:text-cyan-400 bg-cyan-500/10",
  };
  return accents[type] || "text-muted-foreground bg-muted";
}

function timelineIcon(type: string) {
  const icons: Record<string, any> = {
    tracker: Activity,
    expense: DollarSign,
    task: ListTodo,
    event: Calendar,
    document: FileText,
    note: FileText,
    habit: Heart,
    obligation: CreditCard,
  };
  const Icon = icons[type] || Clock;
  return <Icon className="h-3.5 w-3.5" />;
}

function formatKey(key: string) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(val);
}

function getExpirationStatus(doc: Document): "expired" | "soon" | "ok" | null {
  const expField = doc.extractedData?.expirationDate || doc.extractedData?.expiry || doc.extractedData?.expiration;
  if (!expField) return null;
  const exp = new Date(expField as string);
  if (isNaN(exp.getTime())) return null;
  const now = new Date();
  const diffDays = (exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return "expired";
  if (diffDays <= 30) return "soon";
  return "ok";
}

// ============================================================
// AI SUMMARY CARD
// ============================================================

interface AISummaryData {
  summary: string;
  actionItems: string[];
  highlights: Array<{
    label: string;
    value: string;
    trend?: "up" | "down" | "stable";
  }>;
  generatedAt: string;
}

function AISummaryCard({ profileId, profileType }: { profileId: string; profileType: string }) {
  const { data: aiSummary, isLoading, isError, isFetching } = useQuery<AISummaryData>({
    queryKey: ["/api/profiles", profileId, "ai-summary"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/ai-summary`);
      return res.json();
    },
    enabled: !!profileId,
    retry: false,
    staleTime: 1000 * 60 * 60, // 1 hour on client side
  });

  const handleRefresh = useCallback(async () => {
    // Force refresh bypassing server cache
    queryClient.setQueryData(["/api/profiles", profileId, "ai-summary"], undefined);
    queryClient.fetchQuery({
      queryKey: ["/api/profiles", profileId, "ai-summary"],
      queryFn: async () => {
        const res = await apiRequest("GET", `/api/profiles/${profileId}/ai-summary?force=true`);
        return res.json();
      },
      staleTime: 10000, // 10s
    });
  }, [profileId]);

  // Graceful degradation: if AI fails, just don't show the card
  if (isError) return null;

  // Loading skeleton
  if (isLoading) {
    return (
      <Card className="overflow-hidden" data-testid="card-ai-summary-loading">
        <div className={`h-1 bg-gradient-to-r ${profileGradient(profileType).replace(/\/20/g, '/60').replace(/\/5/g, '/30')}`} />
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <div className="flex gap-2 mt-3">
            <Skeleton className="h-14 flex-1 rounded-lg" />
            <Skeleton className="h-14 flex-1 rounded-lg" />
            <Skeleton className="h-14 flex-1 rounded-lg" />
          </div>
          <Skeleton className="h-4 w-1/2 mt-2" />
        </CardContent>
      </Card>
    );
  }

  if (!aiSummary) return null;

  const generatedAgo = aiSummary.generatedAt
    ? formatTimeAgo(new Date(aiSummary.generatedAt))
    : "just now";

  return (
    <Card className="overflow-hidden" data-testid="card-ai-summary">
      {/* Gradient header strip */}
      <div className={`h-1 bg-gradient-to-r ${profileGradient(profileType).replace(/\/20/g, '/60').replace(/\/5/g, '/30')}`} />
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">AI Summary</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
            onClick={handleRefresh}
            disabled={isFetching}
            data-testid="button-refresh-ai-summary"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary text */}
        <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-ai-summary">
          {aiSummary.summary}
        </p>

        {/* Highlights row */}
        {aiSummary.highlights.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="ai-summary-highlights">
            {aiSummary.highlights.map((h, i) => (
              <div
                key={i}
                className="flex-1 min-w-[100px] rounded-lg border border-border bg-muted/30 px-3 py-2 text-center"
                data-testid={`ai-highlight-${i}`}
              >
                <p className="text-xs text-muted-foreground">{h.label}</p>
                <div className="flex items-center justify-center gap-1 mt-0.5">
                  <p className="text-sm font-semibold tabular-nums">{h.value}</p>
                  {h.trend === "up" && <TrendingUp className="h-3 w-3 text-green-500" />}
                  {h.trend === "down" && <TrendingDown className="h-3 w-3 text-red-500" />}
                  {h.trend === "stable" && <Minus className="h-3 w-3 text-muted-foreground" />}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Action items */}
        {aiSummary.actionItems.length > 0 && (
          <div className="space-y-1.5" data-testid="ai-summary-actions">
            <p className="text-xs font-medium text-muted-foreground">Action Items</p>
            {aiSummary.actionItems.map((item, i) => (
              <div key={i} className="flex items-start gap-2" data-testid={`ai-action-${i}`}>
                <Circle className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                <p className="text-xs text-foreground">{item}</p>
              </div>
            ))}
          </div>
        )}

        {/* Generated timestamp */}
        <p className="text-xs text-muted-foreground pt-1" data-testid="text-ai-summary-generated">
          Generated {generatedAgo}
        </p>
      </CardContent>
    </Card>
  );
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ============================================================
// TIMELINE ITEM
// ============================================================

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const colors: Record<string, string> = {
    tracker: "bg-chart-1/10 text-chart-1",
    expense: "bg-chart-4/10 text-chart-4",
    task: "bg-chart-3/10 text-chart-3",
    event: "bg-chart-2/10 text-chart-2",
    document: "bg-primary/10 text-primary",
    habit: "bg-rose-500/10 text-rose-500",
    obligation: "bg-orange-500/10 text-orange-500",
  };
  const color = colors[entry.type] || "bg-muted text-muted-foreground";

  return (
    <div className="flex gap-3 py-3">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${color}`}>
        {timelineIcon(entry.type)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{entry.title}</p>
        {entry.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{entry.description}</p>
        )}
        {entry.data?.computed && Object.keys(entry.data.computed).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {entry.data.computed.caloriesBurned && (
              <Badge variant="secondary" className="text-xs">{entry.data.computed.caloriesBurned} cal burned</Badge>
            )}
            {entry.data.computed.pace && (
              <Badge variant="secondary" className="text-xs">{entry.data.computed.pace}</Badge>
            )}
            {entry.data.computed.heartRateZone && (
              <Badge variant="secondary" className="text-xs capitalize">{entry.data.computed.heartRateZone.replace("_", " ")}</Badge>
            )}
            {entry.data.computed.caloriesConsumed && (
              <Badge variant="secondary" className="text-xs">{entry.data.computed.caloriesConsumed} cal</Badge>
            )}
            {entry.data.computed.sleepQuality && (
              <Badge variant="secondary" className="text-xs capitalize">{entry.data.computed.sleepQuality} sleep</Badge>
            )}
            {entry.data.computed.bloodPressureCategory && (
              <Badge variant="secondary" className="text-xs capitalize">{entry.data.computed.bloodPressureCategory.replace(/_/g, " ")}</Badge>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {new Date(entry.timestamp).toLocaleDateString(undefined, {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          })}
        </p>
      </div>
      <Badge variant="secondary" className="text-xs capitalize shrink-0 h-fit">{entry.type}</Badge>
    </div>
  );
}

// ============================================================
// INFO TAB — Universal with type-specific enrichments
// ============================================================

// Legacy InlineEditField (used internally by old field lists)
function InlineEditField({ profileId, fieldKey, fieldValue, allFields }: {
  profileId: string; fieldKey: string; fieldValue: string; allFields: Record<string, any>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fieldValue);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: async (newVal: string) => {
      const num = Number(newVal);
      const parsed = newVal !== "" && !isNaN(num) && newVal.trim() !== "" ? num : newVal;
      const res = await apiRequest("PATCH", `/api/profiles/${profileId}`, {
        fields: { ...allFields, [fieldKey]: parsed },
      });
      return res.json();
    },
    onMutate: async (newVal: string) => {
      // Optimistic: update cache immediately so UI feels instant
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      const prev = queryClient.getQueryData(["/api/profiles", profileId, "detail"]);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old) return old;
        const num = Number(newVal);
        const parsed = newVal !== "" && !isNaN(num) && newVal.trim() !== "" ? num : newVal;
        return { ...old, fields: { ...old.fields, [fieldKey]: parsed } };
      });
      setEditing(false);
      return { prev };
    },
    onError: (_err: any, _val: string, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/profiles", profileId, "detail"], ctx.prev);
      toast({ title: "Failed to update", variant: "destructive" });
      setValue(fieldValue);
    },
    onSettled: () => {
      // Background refetch to sync with server
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
    },
  });

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const handleSave = () => {
    if (value.trim() === fieldValue) { setEditing(false); return; }
    mutation.mutate(value.trim());
  };

  if (editing) {
    return (
      <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 gap-2">
        <span className="text-xs text-muted-foreground shrink-0">{formatKey(fieldKey)}</span>
        <div className="flex items-center gap-1 flex-1 justify-end">
          <Input ref={inputRef} value={value} onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setValue(fieldValue); setEditing(false); } }}
            className="h-7 text-xs text-right max-w-[200px]" />
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleSave} disabled={mutation.isPending}>
            <Check className="h-3 w-3 text-green-500" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { setValue(fieldValue); setEditing(false); }}>
            <X className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  const deleteMut = useMutation({
    mutationFn: async () => {
      const { [fieldKey]: _, ...rest } = allFields;
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: rest });
    },
    onMutate: async () => {
      // Optimistic: immediately update cache to remove the field
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.fields) return old;
        const { [fieldKey]: _, ...rest } = old.fields;
        return { ...old, fields: rest };
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      toast({ title: "Field removed" });
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      toast({ title: "Failed to delete", variant: "destructive" });
    },
  });

  return (
    <div
      className="flex items-center justify-between py-2 border-b border-border last:border-0 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors group"
    >
      <span className="text-xs text-muted-foreground shrink-0 min-w-[80px] cursor-pointer" onClick={() => setEditing(true)}>{formatKey(fieldKey)}</span>
      <div className="flex items-center gap-1.5 min-w-0 justify-end">
        <span className="text-sm font-medium text-right break-words cursor-pointer" onClick={() => setEditing(true)}>{fieldValue}</span>
        <button
          className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-md opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-md opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 text-red-400 hover:text-red-600 hover:bg-red-500/10 active:bg-red-500/20"
          onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${formatKey(fieldKey)}"?`)) deleteMut.mutate(); }}
          data-testid={`delete-field-${fieldKey}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Inline-editable field row for grouped sections ──
// ── Subscription Quick Actions (used in Insights card) ──
function SubscriptionQuickActions({ profileId, status, onChanged, onEdit }: { profileId: string; status: string; onChanged: () => void; onEdit: () => void }) {
  const { toast } = useToast();
  const statusMutation = useMutation({
    mutationFn: async (newStatus: string) => {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { status: newStatus } });
    },
    onSuccess: (_d, newStatus) => {
      toast({ title: `Subscription ${newStatus}` });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to update status", description: formatApiError(err), variant: "destructive" }),
  });
  return (
    <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-border/30">
      {status === "paused" ? (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1" onClick={() => statusMutation.mutate("active")} disabled={statusMutation.isPending} data-testid="button-resume-subscription">
          <Play className="h-3 w-3" /> Resume
        </Button>
      ) : status !== "canceled" ? (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1" onClick={() => statusMutation.mutate("paused")} disabled={statusMutation.isPending} data-testid="button-pause-subscription">
          <Pause className="h-3 w-3" /> Pause
        </Button>
      ) : null}
      {status !== "canceled" && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1 text-destructive hover:text-destructive" onClick={() => statusMutation.mutate("canceled")} disabled={statusMutation.isPending} data-testid="button-cancel-subscription">
          <Ban className="h-3 w-3" /> Cancel
        </Button>
      )}
      {status === "canceled" && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1" onClick={() => statusMutation.mutate("active")} disabled={statusMutation.isPending} data-testid="button-reactivate-subscription">
          <Play className="h-3 w-3" /> Reactivate
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1" onClick={onEdit} data-testid="button-edit-subscription">
        <Pencil className="h-3 w-3" /> Edit
      </Button>
    </div>
  );
}

function GroupedInlineField({ profileId, fieldKey, label, value, onSaved, allFields }: {
  profileId: string;
  fieldKey: string;
  label: string;
  value: any;
  onSaved: () => void;
  allFields?: Record<string, any>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ""));
  const [saving, setSaving] = useState(false);
  const [finding, setFinding] = useState(false);
  const [foundValue, setFoundValue] = useState<{ estimatedValue: number; confidence: string; explanation: string; range?: { low: number; high: number } } | null>(null);
  const { toast } = useToast();

  // Delete this field
  const deleteField = async () => {
    if (!confirm(`Delete "${label}"?`)) return;
    try {
      const rest = { ...(allFields || {}) };
      delete rest[fieldKey];
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: rest });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onSaved();
      toast({ title: `"${label}" removed` });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  };
  const isValueField = fieldKey === "currentValue";

  const save = async () => {
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, {
        fields: { [fieldKey]: draft },
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onSaved();
      setEditing(false);
      setFoundValue(null);
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const findValue = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setFinding(true);
    try {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/find-value`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setFoundValue(data);
      setDraft(String(Math.round(data.estimatedValue)));
      setEditing(true);
    } catch (err: any) {
      toast({ title: err.message || "Could not find value", variant: "destructive" });
    } finally {
      setFinding(false);
    }
  };

  if (!editing) {
    return (
      <div
        className="flex items-center justify-between py-2 border-b border-border/30 last:border-0 group cursor-pointer hover:bg-muted/20 px-2 -mx-2 rounded"
        onClick={() => { setDraft(String(value ?? "")); setEditing(true); }}
      >
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          {isValueField && (
            <button
              onClick={findValue}
              disabled={finding}
              className="opacity-0 group-hover:opacity-100 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition-all flex items-center gap-1 shrink-0"
              title="Find current market value using AI"
            >
              {finding ? (
                <><span className="h-2.5 w-2.5 rounded-full border-2 border-primary/40 border-t-primary animate-spin inline-block" /> Finding…</>
              ) : (
                <><Search className="h-2.5 w-2.5" /> Find Value</>
              )}
            </button>
          )}
          <span className="text-xs font-medium max-w-[180px] truncate text-right">
            {value != null && value !== ""
              ? (isValueField && !isNaN(Number(value)) ? `$${Number(value).toLocaleString()}` : String(value))
              : <span className="text-muted-foreground/40 italic">tap to add</span>}
          </span>
          {/* Delete button — always visible on mobile */}
          {value != null && value !== "" && (
            <button
              onClick={(e) => { e.stopPropagation(); deleteField(); }}
              className="w-7 h-7 flex items-center justify-center rounded-md opacity-50 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 text-red-400 hover:text-red-500 hover:bg-red-500/10 active:bg-red-500/20"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="py-1.5 px-2 -mx-2 bg-muted/20 rounded space-y-1.5">
      {foundValue && (
        <div className="text-xs bg-primary/5 border border-primary/20 rounded px-2 py-1.5">
          <div className="flex items-center justify-between">
            <span className="font-medium text-primary">
              AI estimate: ${foundValue.estimatedValue.toLocaleString()}
              {foundValue.range && <span className="text-muted-foreground font-normal ml-1">(${foundValue.range.low.toLocaleString()}–${foundValue.range.high.toLocaleString()})</span>}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${foundValue.confidence === "high" ? "bg-green-500/15 text-green-600" : foundValue.confidence === "medium" ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground"}`}>
              {foundValue.confidence}
            </span>
          </div>
          <p className="text-muted-foreground mt-0.5">{foundValue.explanation}</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground shrink-0 w-24">{label}</span>
        <Input
          className="h-7 text-xs flex-1"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") { setEditing(false); setFoundValue(null); }
          }}
          autoFocus
        />
        <Button size="sm" className="h-6 text-xs px-2" onClick={save} disabled={saving}>{saving ? "…" : "Save"}</Button>
        <Button size="sm" variant="ghost" className="h-6 text-xs px-1" onClick={() => { setEditing(false); setFoundValue(null); }} disabled={saving}>✕</Button>
      </div>
    </div>
  );
}

// ── Field groups by profile type ──
const FIELD_GROUPS: Record<string, { title: string; fields: { key: string; label: string }[] }[]> = {
  vehicle: [
    { title: "Vehicle Identity", fields: [
      { key: "make", label: "Make" }, { key: "model", label: "Model" }, { key: "year", label: "Year" },
      { key: "trim", label: "Trim" }, { key: "vin", label: "VIN" }, { key: "licensePlate", label: "License Plate" },
      { key: "color", label: "Color" },
      // Also match extracted PDF keys
      { key: "vehicleMake", label: "Make" }, { key: "vehicleType", label: "Type" },
      { key: "vehicleYear", label: "Year" }, { key: "vehicleVIN", label: "VIN" },
    ]},
    { title: "Purchase & Value", fields: [
      { key: "purchaseDate", label: "Purchase Date" }, { key: "purchasePrice", label: "Purchase Price" },
      { key: "currentValue", label: "Current Value" }, { key: "mileage", label: "Mileage" },
    ]},
    { title: "Insurance", fields: [
      { key: "insurer", label: "Insurer" }, { key: "insurerCode", label: "Insurer Code" },
      { key: "policyNumber", label: "Policy Number" }, { key: "coverageType", label: "Coverage Type" },
      { key: "namedInsured", label: "Named Insured" }, { key: "niacNumber", label: "NAIC Number" },
      { key: "premium", label: "Premium" }, { key: "deductible", label: "Deductible" },
      { key: "effectiveDate", label: "Effective Date" }, { key: "expirationDate", label: "Expiration Date" },
      { key: "insurance", label: "Insurance" },
    ]},
    { title: "Financial", fields: [
      { key: "accountType", label: "Account Type" }, { key: "institution", label: "Institution" },
      { key: "totalDebits", label: "Total Debits" }, { key: "totalCredits", label: "Total Credits" },
      { key: "balance", label: "Balance" }, { key: "paymentMethod", label: "Payment Method" },
    ]},
    { title: "Status", fields: [
      { key: "condition", label: "Condition" }, { key: "location", label: "Location" },
      { key: "registration", label: "Registration Exp" },
      { key: "ownerName", label: "Owner Name" },
    ]},
  ],
  person: [
    { title: "Contact Info", fields: [
      { key: "phone", label: "Phone" }, { key: "email", label: "Email" }, { key: "address", label: "Address" },
    ]},
    { title: "Personal Details", fields: [
      { key: "birthday", label: "Birthday" }, { key: "relationship", label: "Relationship" },
      { key: "bloodType", label: "Blood Type" }, { key: "height", label: "Height" }, { key: "weight", label: "Weight" },
    ]},
    { title: "Emergency", fields: [
      { key: "emergencyContact", label: "Emergency Contact" }, { key: "allergies", label: "Allergies" },
      { key: "medications", label: "Medications" },
    ]},
  ],
  pet: [
    { title: "Pet Identity", fields: [
      { key: "species", label: "Species" }, { key: "breed", label: "Breed" }, { key: "color", label: "Color" },
      { key: "birthday", label: "Birthday" }, { key: "gender", label: "Gender" },
    ]},
    { title: "Health & Care", fields: [
      { key: "weight", label: "Weight" }, { key: "microchip", label: "Microchip #" },
      { key: "vetName", label: "Vet" }, { key: "vetPhone", label: "Vet Phone" },
      { key: "diet", label: "Diet" }, { key: "allergies", label: "Allergies" },
    ]},
  ],
  self: [
    { title: "Personal Details", fields: [
      { key: "dateOfBirth", label: "Date of Birth" }, { key: "height", label: "Height" },
      { key: "weight", label: "Weight" }, { key: "bloodType", label: "Blood Type" },
      { key: "sex", label: "Sex" },
    ]},
    { title: "Contact & Location", fields: [
      { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
      { key: "address", label: "Address" }, { key: "state", label: "State" },
    ]},
  ],
  loan: [
    { title: "Loan Details", fields: [
      { key: "lender", label: "Lender" }, { key: "loanBalance", label: "Balance" },
      { key: "interestRate", label: "Interest Rate" }, { key: "monthlyPayment", label: "Monthly Payment" },
      { key: "originalAmount", label: "Original Amount" }, { key: "termMonths", label: "Term (months)" },
    ]},
    { title: "Status", fields: [
      { key: "remainingBalance", label: "Remaining" }, { key: "loanStartDate", label: "Start Date" },
      { key: "maturityDate", label: "Maturity Date" },
    ]},
  ],
  subscription: [
    { title: "Subscription", fields: [
      { key: "provider", label: "Provider" }, { key: "cost", label: "Monthly Cost" },
      { key: "frequency", label: "Billing Cycle" }, { key: "plan", label: "Plan" },
      { key: "status", label: "Status" },
    ]},
    { title: "Dates", fields: [
      { key: "startDate", label: "Start Date" }, { key: "renewalDate", label: "Next Billing" },
      { key: "endDate", label: "End Date" },
    ]},
  ],
  asset: [
    { title: "Asset Details", fields: [
      { key: "brand", label: "Brand" }, { key: "model", label: "Model" },
      { key: "purchaseDate", label: "Purchase Date" }, { key: "purchasePrice", label: "Purchase Price" },
      { key: "currentValue", label: "Current Value" }, { key: "serialNumber", label: "Serial #" },
    ]},
    { title: "Status", fields: [
      { key: "condition", label: "Condition" }, { key: "location", label: "Location" },
      { key: "warranty", label: "Warranty Until" },
    ]},
  ],
  // Asset subtype overrides
  bank_account: [
    { title: "Account", fields: [
      { key: "bankName", label: "Bank" }, { key: "accountType", label: "Account Type" },
      { key: "accountNumber", label: "Account #" }, { key: "routingNumber", label: "Routing #" },
      { key: "balance", label: "Balance" }, { key: "interestRate", label: "APY" },
    ]},
  ],
  credit_card: [
    { title: "Card Details", fields: [
      { key: "issuer", label: "Issuer" }, { key: "lastFour", label: "Last 4" },
      { key: "creditLimit", label: "Credit Limit" }, { key: "balance", label: "Balance" },
      { key: "apr", label: "APR" }, { key: "annualFee", label: "Annual Fee" },
    ]},
    { title: "Rewards", fields: [
      { key: "rewardsType", label: "Rewards Type" }, { key: "rewardsBalance", label: "Rewards Balance" },
    ]},
  ],
  digital_asset: [
    { title: "Digital Asset", fields: [
      { key: "domain", label: "Domain/URL" }, { key: "platform", label: "Platform" },
      { key: "status", label: "Status" }, { key: "currentValue", label: "Est. Value" },
    ]},
    { title: "Access", fields: [
      { key: "loginUrl", label: "Login URL" }, { key: "username", label: "Username" },
      { key: "registrar", label: "Registrar" }, { key: "expirationDate", label: "Expiration" },
    ]},
  ],
  business: [
    { title: "Business", fields: [
      { key: "businessName", label: "Business Name" }, { key: "ownershipPercent", label: "Ownership %" },
      { key: "valuation", label: "Valuation" }, { key: "entityType", label: "Entity Type" },
      { key: "ein", label: "EIN" }, { key: "industry", label: "Industry" },
    ]},
  ],
  collectible: [
    { title: "Item", fields: [
      { key: "category", label: "Category" }, { key: "brand", label: "Brand/Artist" },
      { key: "purchasePrice", label: "Purchase Price" }, { key: "currentValue", label: "Current Value" },
      { key: "condition", label: "Condition" }, { key: "rarity", label: "Rarity" },
    ]},
    { title: "Provenance", fields: [
      { key: "purchaseDate", label: "Acquired" }, { key: "seller", label: "Seller" },
      { key: "authenticationId", label: "Auth. ID" },
    ]},
  ],
  loan_receivable: [
    { title: "Loan", fields: [
      { key: "borrower", label: "Borrower" }, { key: "loanBalance", label: "Balance Owed" },
      { key: "interestRate", label: "Interest Rate" }, { key: "monthlyPayment", label: "Monthly Payment" },
      { key: "originalAmount", label: "Original Amount" }, { key: "termMonths", label: "Term (months)" },
    ]},
    { title: "Status", fields: [
      { key: "loanStartDate", label: "Start Date" }, { key: "maturityDate", label: "Due Date" },
      { key: "status", label: "Status" },
    ]},
  ],
  insurance: [
    { title: "Policy", fields: [
      { key: "provider", label: "Provider" }, { key: "premium", label: "Premium" },
      { key: "deductible", label: "Deductible" }, { key: "coverageLimit", label: "Coverage Limit" },
      { key: "policyNumber", label: "Policy #" },
    ]},
    { title: "Status", fields: [
      { key: "renewalDate", label: "Renewal Date" }, { key: "startDate", label: "Start Date" },
    ]},
  ],
  property: [
    { title: "Location", fields: [
      { key: "address", label: "Address" }, { key: "city", label: "City" },
      { key: "state", label: "State" }, { key: "zip", label: "ZIP" },
    ]},
    { title: "Details", fields: [
      { key: "bedrooms", label: "Bedrooms" }, { key: "bathrooms", label: "Bathrooms" },
      { key: "sqFt", label: "Sq Ft" }, { key: "yearBuilt", label: "Year Built" },
    ]},
    { title: "Value", fields: [
      { key: "purchasePrice", label: "Purchase Price" }, { key: "currentValue", label: "Current Value" },
    ]},
  ],
};

function InfoTab({
  profile,
  onEdit,
}: {
  profile: ProfileDetail;
  onEdit: () => void;
}) {
  const [addingField, setAddingField] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  const saveCustomFieldMutation = useMutation({
    mutationFn: async (field: { key: string; value: string }) => {
      const res = await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        fields: { ...profile.fields, [field.key]: field.value },
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Field added" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      setAddingField(false);
      setNewFieldKey("");
      setNewFieldValue("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add field", description: formatApiError(err), variant: "destructive" });
    },
  });

  const toggleSection = (title: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  };

  // ── Key value for header display ──
  const keyValueEntry = (() => {
    const f = profile.fields;
    if (f.current_value != null) return { label: "Value", value: typeof f.current_value === "number" ? formatCurrency(f.current_value) : String(f.current_value) };
    if (f.currentValue != null) return { label: "Value", value: typeof f.currentValue === "number" ? formatCurrency(f.currentValue) : String(f.currentValue) };
    if (f.loan_balance != null) return { label: "Balance", value: typeof f.loan_balance === "number" ? formatCurrency(f.loan_balance) : String(f.loan_balance) };
    if (f.loanBalance != null) return { label: "Balance", value: typeof f.loanBalance === "number" ? formatCurrency(f.loanBalance) : String(f.loanBalance) };
    if (f.cost != null) return { label: "Cost", value: typeof f.cost === "number" ? formatCurrency(f.cost) : String(f.cost) };
    if (f.premium != null) return { label: "Premium", value: typeof f.premium === "number" ? formatCurrency(f.premium) : String(f.premium) };
    return null;
  })();

  // ── Summary subtitle fields ──
  const subtitleParts: string[] = (() => {
    const f = profile.fields;
    const t = profile.type;
    const parts: string[] = [];
    if (t === "vehicle") {
      if (f.year) parts.push(String(f.year));
      if (f.make) parts.push(String(f.make));
      if (f.model) parts.push(String(f.model));
    } else if (t === "pet") {
      if (f.species) parts.push(String(f.species));
      if (f.breed) parts.push(String(f.breed));
    } else if (t === "person" || t === "self") {
      if (f.relationship) parts.push(String(f.relationship));
      if (f.email) parts.push(String(f.email));
    } else if (t === "loan") {
      if (f.lender) parts.push(String(f.lender));
      if (f.interestRate) parts.push(`${f.interestRate}% APR`);
    } else if (t === "subscription") {
      if (f.provider) parts.push(String(f.provider));
      if (f.frequency) parts.push(String(f.frequency));
    } else if (t === "property") {
      if (f.address) parts.push(String(f.address));
      if (f.city) parts.push(String(f.city));
    } else if (t === "asset") {
      if (f.brand) parts.push(String(f.brand));
      if (f.model) parts.push(String(f.model));
    }
    return parts.slice(0, 3);
  })();

  // ── Stats from related data ──
  const docsCount = (profile.relatedDocuments || []).length;
  const expensesTotal = (profile.relatedExpenses || []).reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const openTasksCount = (profile.relatedTasks || []).filter((t: any) => t.status !== "done" && t.status !== "completed").length;
  const trackersCount = (profile.relatedTrackers || []).length;

  // ── Field groups ──
  const assetSub = profile.type === "asset" ? (profile.fields?.assetSubtype || null) : null;
  const groups = (assetSub && FIELD_GROUPS[assetSub]) ? FIELD_GROUPS[assetSub] : (FIELD_GROUPS[profile.type] ?? []);
  const groupedKeys = new Set(groups.flatMap(g => g.fields.map(f => f.key)));
  const extraFields = Object.entries(profile.fields).filter(
    ([k, v]) => !groupedKeys.has(k) && !k.startsWith("_") && v != null && v !== "" && typeof v !== "object"
  );

  const handleSaved = () => {};

  return (
    <div className="space-y-3">
      {/* ── Header summary row (no name repetition — hero already shows that) ── */}
      {/* Show subtitle details + key value if relevant */}
      {(subtitleParts.length > 0 || keyValueEntry) && (
        <div className="flex items-center justify-between px-1 pb-1 border-b border-border/30">
          <p className="text-xs text-muted-foreground">{subtitleParts.join(" · ")}</p>
          {keyValueEntry && (
            <div className="text-right">
              <p className="text-[10px] text-muted-foreground">{keyValueEntry.label}</p>
              <p className="text-sm font-bold tabular-nums">{keyValueEntry.value}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Stats Row ── Only for person/self/pet — hero already shows these stats for asset types */}
      {["self","person","pet"].includes(profile.type) && (
        <div className="grid grid-cols-4 gap-2">
          <Card className="p-2.5 text-center">
            <p className="text-base font-bold">{docsCount}</p>
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-0.5">
              <FileText className="h-2.5 w-2.5" /> Docs
            </p>
          </Card>
          <Card className="p-2.5 text-center">
            <p className="text-base font-bold">
              {expensesTotal > 0 ? `$${expensesTotal.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "0"}
            </p>
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-0.5">
              <DollarSign className="h-2.5 w-2.5" /> Spent
            </p>
          </Card>
          <Card className="p-2.5 text-center">
            <p className="text-base font-bold">{openTasksCount}</p>
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-0.5">
              <ListTodo className="h-2.5 w-2.5" /> Tasks
            </p>
          </Card>
          <Card className="p-2.5 text-center">
            <p className="text-base font-bold">{trackersCount}</p>
            <p className="text-xs text-muted-foreground flex items-center justify-center gap-0.5">
              <Activity className="h-2.5 w-2.5" /> Trackers
            </p>
          </Card>
        </div>
      )}

      {/* ── Subscription Insights ── */}
      {profile.type === "subscription" && (() => {
        const cost = Number(profile.fields?.monthlyCost || profile.fields?.cost || profile.fields?.amount || 0);
        const startDate = profile.fields?.startDate;
        const renewalDate = profile.fields?.renewalDate;
        const subStatus = (profile.fields?.status as string || "active").toLowerCase();
        const monthsActive = startDate ? Math.max(0, Math.floor((Date.now() - new Date(startDate).getTime()) / (30.44 * 86400000))) : 0;
        const totalPaid = cost * monthsActive;
        const daysUntilRenewal = renewalDate ? Math.ceil((new Date(renewalDate).getTime() - Date.now()) / 86400000) : null;
        const statusColor = subStatus === "active" ? "bg-green-500/15 text-green-400" : subStatus === "paused" ? "bg-amber-500/15 text-amber-400" : "bg-red-500/15 text-red-400";
        return (
          <Card className="p-3" data-testid="card-subscription-insights">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase">Subscription Insights</p>
              <Badge variant="secondary" className={`text-xs capitalize ${statusColor}`} data-testid="badge-subscription-status">{subStatus}</Badge>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-sm font-bold tabular-nums">${cost.toLocaleString()}/mo</p>
                <p className="text-xs text-muted-foreground">Monthly Cost</p>
              </div>
              <div>
                <p className="text-sm font-bold tabular-nums">${Math.round(totalPaid).toLocaleString()}</p>
                <p className="text-xs text-muted-foreground">Total Paid ({monthsActive}mo)</p>
              </div>
              <div>
                <p className="text-sm font-bold tabular-nums">{daysUntilRenewal != null ? (daysUntilRenewal > 0 ? `${daysUntilRenewal}d` : "Due") : "—"}</p>
                <p className="text-xs text-muted-foreground">Until Renewal</p>
              </div>
            </div>
            <SubscriptionQuickActions profileId={profile.id} status={subStatus} onChanged={handleSaved} onEdit={onEdit} />
          </Card>
        );
      })()}

      {/* ── Asset Valuation Card ── */}
      {["vehicle", "asset", "property", "investment"].includes(profile.type) && profile.fields?.currentValue != null && profile.fields?.valuationMethod && (() => {
        const f = profile.fields;
        const currentVal = Number(f.currentValue) || 0;
        const purchaseVal = Number(f.purchasePrice) || 0;
        const change = purchaseVal > 0 ? currentVal - purchaseVal : 0;
        const changePct = purchaseVal > 0 ? ((change / purchaseVal) * 100) : 0;
        const confidenceColor = f.valuationConfidence === "high" ? "bg-green-500/15 text-green-400" : f.valuationConfidence === "medium" ? "bg-amber-500/15 text-amber-400" : "bg-muted text-muted-foreground";
        return (
          <Card className="p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase">AI Valuation</p>
              {f.valuationConfidence && (
                <Badge variant="secondary" className={`text-xs capitalize ${confidenceColor}`}>
                  {f.valuationConfidence} confidence
                </Badge>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-lg font-bold tabular-nums">{formatCurrency(currentVal)}</p>
              {change !== 0 && (
                <span className={`text-xs font-medium flex items-center gap-0.5 ${change > 0 ? "text-green-500" : "text-red-500"}`}>
                  {change > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {change > 0 ? "+" : ""}{changePct.toFixed(1)}%
                </span>
              )}
            </div>
            <div className="mt-2 space-y-0.5">
              {f.valuationMethod && <p className="text-xs-loose text-muted-foreground">Method: {f.valuationMethod}</p>}
              {f.valuationRange && <p className="text-xs-loose text-muted-foreground">Range: {f.valuationRange}</p>}
              {f.valuationDate && <p className="text-xs-loose text-muted-foreground">Valued: {f.valuationDate}</p>}
            </div>
          </Card>
        );
      })()}

      {/* ── 3. Grouped Field Sections (type-aware) ── */}
      {groups.length > 0 ? (
        groups.map(group => {
          const isCollapsed = collapsedSections.has(group.title);
          return (
            <Card key={group.title}>
              <button
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 transition-colors"
                onClick={() => toggleSection(group.title)}
              >
                <span className="text-xs font-semibold">{group.title}</span>
                {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
              {!isCollapsed && (
                <CardContent className="px-4 pb-3 pt-0">
                  {group.fields.map(({ key, label }) => (
                    <GroupedInlineField
                      key={key}
                      profileId={profile.id}
                      fieldKey={key}
                      label={label}
                      value={profile.fields[key]}
                      onSaved={handleSaved}
                      allFields={profile.fields}
                    />
                  ))}
                </CardContent>
              )}
            </Card>
          );
        })
      ) : (
        // Fallback: flat list for unknown types
        Object.entries(profile.fields)
          .filter(([k, v]) => !k.startsWith("_") && v != null && v !== "" && typeof v !== "object")
          .length > 0 && (
          <Card>
            <CardHeader className="py-2.5 px-4">
              <CardTitle className="text-xs font-semibold">Details</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0">
              {Object.entries(profile.fields)
                .filter(([k, v]) => !k.startsWith("_") && v != null && v !== "" && typeof v !== "object")
                .map(([key, val]) => (
                  <GroupedInlineField
                    key={key}
                    profileId={profile.id}
                    fieldKey={key}
                    label={formatKey(key)}
                    value={val}
                    onSaved={handleSaved}
                    allFields={profile.fields}
                  />
                ))}
            </CardContent>
          </Card>
        )
      )}

      {/* ── 4. Extra / Other Fields (not covered by group config) ── */}
      {groups.length > 0 && extraFields.length > 0 && (
        <Card>
          <button
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/20 transition-colors"
            onClick={() => toggleSection("__other__")}
          >
            <span className="text-xs font-semibold">Other ({extraFields.length})</span>
            {collapsedSections.has("__other__")
              ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
          {!collapsedSections.has("__other__") && (
            <CardContent className="px-4 pb-3 pt-0">
              {extraFields.map(([key, val]) => (
                <GroupedInlineField
                  key={key}
                  profileId={profile.id}
                  fieldKey={key}
                  label={formatKey(key)}
                  value={val}
                  onSaved={handleSaved}
                  allFields={profile.fields}
                />
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── 5. Add Custom Field ── */}
      {addingField ? (
        <Card>
          <CardContent className="p-3 space-y-2">
            <div className="flex gap-2">
              <Input placeholder="Field name" value={newFieldKey} onChange={e => setNewFieldKey(e.target.value)} className="h-7 text-xs" data-testid="input-new-field-key" />
              <Input placeholder="Value" value={newFieldValue} onChange={e => setNewFieldValue(e.target.value)} className="h-7 text-xs" data-testid="input-new-field-value" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setAddingField(false); setNewFieldKey(""); setNewFieldValue(""); }}>Cancel</Button>
              <Button size="sm" className="h-7 text-xs" disabled={!newFieldKey.trim() || saveCustomFieldMutation.isPending}
                onClick={() => saveCustomFieldMutation.mutate({ key: newFieldKey.trim(), value: newFieldValue })}>
                {saveCustomFieldMutation.isPending ? "Saving..." : "Add"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground w-full"
          onClick={() => setAddingField(true)} data-testid="button-add-custom-field">
          <Plus className="h-3 w-3" /> Add Field
        </Button>
      )}

      {/* ── 6. Child Profiles ── */}
      {(profile.childProfiles || []).length > 0 && (
        <Card>
          <CardHeader className="py-2.5 px-4">
            <CardTitle className="text-xs font-semibold">Linked Profiles</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0 space-y-1.5">
            {(profile.childProfiles || []).map((child: any) => {
              const iconMap: Record<string, any> = { subscription: CreditCard, vehicle: Car, asset: Package, loan: Wallet, investment: TrendingUp, property: Home, person: User, pet: PawPrint };
              const ChildIcon = iconMap[child.type] || Link2;
              return (
                <Link key={child.id} href={`/profiles/${child.id}`}>
                  <div className="flex items-center gap-2.5 p-2.5 rounded-lg border hover:bg-muted/30 transition-colors cursor-pointer">
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <ChildIcon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{child.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {child.type}{child.fields?.cost ? ` · $${child.fields.cost}` : child.fields?.currentValue ? ` · $${child.fields.currentValue}` : ""}
                      </p>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </div>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ── 7. Notes ── */}
      {profile.notes && (
        <Card>
          <CardHeader className="py-2 px-4">
            <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" /> Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{profile.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* ── 8. Tags ── */}
      {profile.tags.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
              {profile.tags.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// DOCUMENTS TAB — with expiration highlighting
// ============================================================

function DocumentsTab({
  documents,
  profileId,
  childProfiles,
  onUploaded,
}: {
  documents: ProfileDetail["relatedDocuments"];
  profileId: string;
  childProfiles?: Profile[];
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docSearch, setDocSearch] = useState("");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  const [linkTarget, setLinkTarget] = useState<string>("profile"); // "profile" or a child profile ID

  // Get unique doc types for filter
  const docTypes = [...new Set(documents.map(d => d.type))].sort();
  // Filter documents
  const filteredDocs = documents.filter(d => {
    if (docTypeFilter !== "all" && d.type !== docTypeFilter) return false;
    if (docSearch) {
      const q = docSearch.toLowerCase();
      return d.name.toLowerCase().includes(q) || d.type.toLowerCase().includes(q) || (d.tags || []).some(t => t.toLowerCase().includes(q));
    }
    return true;
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(f);
        });
      const fileData = await toBase64(file);
      const targetProfileId = linkTarget === "profile" ? profileId : linkTarget;
      const res = await apiRequest("POST", "/api/upload", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileId: targetProfileId,
      });
      // Also link to parent profile if uploaded to a child
      if (linkTarget !== "profile") {
        try {
          const doc = await res.json();
          await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "document", entityId: doc.document?.id || doc.id });
          return doc;
        } catch { /* non-critical */ }
      }
      return res.json();
    },
    onSuccess: () => {
      const childName = childProfiles?.find(c => c.id === linkTarget)?.name;
      toast({ title: "Document uploaded", description: childName ? `Linked to ${childName}` : "Linked to this profile." });
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onSuccess: () => {
      toast({ title: "Document deleted" });
      setDeletingDocId(null);
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadMutation.mutate(file);
    e.target.value = "";
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3 gap-2">
        {/* Link target selector: attach photo to profile or a child asset */}
        {childProfiles && childProfiles.length > 0 && (
          <Select value={linkTarget} onValueChange={setLinkTarget}>
            <SelectTrigger className="w-[180px] h-8 text-xs" data-testid="select-photo-target">
              <SelectValue placeholder="Link to..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="profile">This profile</SelectItem>
              {childProfiles.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  <span className="flex items-center gap-1.5">
                    {c.name} <span className="text-muted-foreground capitalize">({c.type})</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
            data-testid="input-upload-document"
            accept="image/*,application/pdf,.doc,.docx,.txt"
          />
          <Button
            size="sm"
            className="gap-1.5 text-xs h-8"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadMutation.isPending}
            data-testid="button-upload-document"
          >
            <Upload className="h-3.5 w-3.5" />
            {uploadMutation.isPending ? "Uploading..." : "Upload Document"}
          </Button>
        </div>
      </div>

      {/* Search and Filter */}
      {documents.length > 0 && (
        <div className="space-y-2">
          <input
            type="text"
            placeholder="Search documents..."
            value={docSearch}
            onChange={e => setDocSearch(e.target.value)}
            className="w-full h-8 px-3 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {docTypes.length > 1 && (
            <div className="flex items-center gap-1 flex-wrap">
              <button onClick={() => setDocTypeFilter("all")} className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${docTypeFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>All ({documents.length})</button>
              {docTypes.map(t => (
                <button key={t} onClick={() => setDocTypeFilter(t)} className={`px-2 py-0.5 rounded text-xs font-medium capitalize transition-colors ${docTypeFilter === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{t} ({documents.filter(d => d.type === t).length})</button>
              ))}
            </div>
          )}
        </div>
      )}

      {filteredDocs.length === 0 && documents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No linked documents</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a file to get started</p>
          </CardContent>
        </Card>
      ) : filteredDocs.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center">
            <p className="text-sm text-muted-foreground">No documents match your search</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredDocs.map(doc => {
            const expStatus = getExpirationStatus(doc);
            const expDate = doc.extractedData?.expirationDate || doc.extractedData?.expiry || doc.extractedData?.expiration;
            return (
              <Card
                key={doc.id}
                className={
                  expStatus === "expired"
                    ? "border-red-500/50 bg-red-500/5"
                    : expStatus === "soon"
                    ? "border-yellow-500/50 bg-yellow-500/5"
                    : ""
                }
                data-testid={`card-document-${doc.id}`}
              >
                <CardContent className="p-0">
                  <div className="p-3 flex items-center gap-3">
                    {(() => {
                      const DOC_TYPE_COLORS: Record<string, string> = {
                        medical: "bg-red-500/10 text-red-500",
                        insurance: "bg-blue-500/10 text-blue-500",
                        legal: "bg-purple-500/10 text-purple-500",
                        financial: "bg-green-500/10 text-green-500",
                        identity: "bg-amber-500/10 text-amber-500",
                        warranty: "bg-orange-500/10 text-orange-500",
                        receipt: "bg-emerald-500/10 text-emerald-500",
                      };
                      const colorClass = DOC_TYPE_COLORS[doc.type] || (doc.mimeType.startsWith("image/") ? "bg-blue-500/10 text-blue-500" : "bg-slate-500/10 text-slate-500");
                      return (
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${colorClass}`}>
                          {doc.mimeType.startsWith("image/") ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                        </div>
                      );
                    })()}
                    <button className="flex-1 min-w-0 text-left" onClick={async () => {
                      try {
                        const res = await apiRequest("GET", `/api/documents/${doc.id}`);
                        const fullDoc = await res.json();
                        setViewingDoc(fullDoc);
                      } catch { setViewingDoc(doc); }
                    }}>
                      <div className="text-sm font-medium text-primary" onClick={(e) => e.stopPropagation()}>
                        <EditableTitle
                          value={doc.name}
                          onSave={async (newName) => {
                            await apiRequest("PATCH", `/api/documents/${doc.id}`, { name: newName });
                            queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
                            toast({ title: `Renamed to "${newName}"` });
                          }}
                        />
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <Badge variant="secondary" className="text-xs capitalize">{doc.type}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                        {expStatus === "expired" && expDate && (
                          <Badge variant="destructive" className="text-xs gap-0.5">
                            <AlertCircle className="h-2.5 w-2.5" /> Expired {new Date(expDate as string).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </Badge>
                        )}
                        {expStatus === "soon" && expDate && (
                          <Badge className="text-xs gap-0.5 bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 border-yellow-500/30">
                            <AlertCircle className="h-2.5 w-2.5" /> Expires {new Date(expDate as string).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </Badge>
                        )}
                        {doc.extractedData && Object.keys(doc.extractedData).length > 0 && (
                          <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                            {expandedDocId === doc.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            {Object.keys(doc.extractedData).length} fields
                          </span>
                        )}
                      </div>
                    </button>
                    <div className="flex gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={async () => {
                          // Fetch full document with file data on-demand
                          try {
                            const res = await apiRequest("GET", `/api/documents/${doc.id}`);
                            const fullDoc = await res.json();
                            setViewingDoc(fullDoc);
                          } catch {
                            setViewingDoc(doc); // Fallback to what we have
                          }
                        }}
                        data-testid={`button-view-doc-${doc.id}`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                      <ShareButton
                        id={doc.id}
                        name={doc.name}
                        mimeType={doc.mimeType}
                        data={doc.fileData}
                        size="icon"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeletingDocId(doc.id)}
                        data-testid={`button-delete-doc-${doc.id}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  {expandedDocId === doc.id && doc.extractedData && Object.keys(doc.extractedData).length > 0 && (
                    <div className="border-t bg-muted/30 px-4 py-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {Object.entries(doc.extractedData).map(([key, value]) => (
                        <div key={key} className="min-w-0">
                          <span className="text-xs text-muted-foreground capitalize">{key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim()}</span>
                          <p className="text-xs font-medium truncate">{String(value)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {viewingDoc && (
        <DocumentViewerDialog
          open={!!viewingDoc}
          onOpenChange={() => setViewingDoc(null)}
          id={viewingDoc.id}
          name={viewingDoc.name}
          mimeType={viewingDoc.mimeType}
          data={viewingDoc.fileData}
        />
      )}

      <AlertDialog open={!!deletingDocId} onOpenChange={() => setDeletingDocId(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-document">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-document">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingDocId && deleteMutation.mutate(deletingDocId)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-document"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================
// FINANCES TAB — Universal with type-specific enrichments
// ============================================================

function FinancesTab({ profile, profileId, onChanged }: { profile: ProfileDetail; profileId: string; onChanged: () => void }) {
  // ── state ──────────────────────────────────────────────────────
  const { toast } = useToast();
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ProfileDetail["relatedExpenses"][number] | null>(null);
  const [deleteExpenseId, setDeleteExpenseId] = useState<string | null>(null);
  const [expDesc, setExpDesc] = useState("");
  const [expAmount, setExpAmount] = useState("");
  const [expCategory, setExpCategory] = useState("general");
  const [expVendor, setExpVendor] = useState("");
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));
  const [expandedExpenseId, setExpandedExpenseId] = useState<string | null>(null);
  const [amortTableOpen, setAmortTableOpen] = useState(false);
  const [extraPayment, setExtraPayment] = useState(0);

  const expenses = profile.relatedExpenses;
  const obligations = profile.relatedObligations;

  // ── type flags ─────────────────────────────────────────────────
  const isLoan = profile.type === "loan" ||
    !!(profile.fields.interestRate || profile.fields.loanBalance || profile.fields.monthlyPayment);
  const isInvestment = profile.type === "investment";
  const isSubscription = profile.type === "subscription";

  // ── expense categories ─────────────────────────────────────────
  const expenseCategories = [
    "general", "food", "transport", "housing", "utilities",
    "entertainment", "health", "education", "shopping",
    "insurance", "pet", "vehicle", "travel", "other",
  ];

  const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

  // ── summary calculations ────────────────────────────────────────
  const totalSpent = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = expenses
    .filter(e => {
      const d = new Date(e.date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === currentMonthKey;
    })
    .reduce((sum, e) => sum + (e.amount || 0), 0);

  const expensesByMonth: Record<string, number> = {};
  for (const exp of expenses) {
    const d = new Date(exp.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    expensesByMonth[key] = (expensesByMonth[key] || 0) + (exp.amount || 0);
  }
  const sortedMonths = Object.keys(expensesByMonth).sort();
  const avgPerMonth = sortedMonths.length > 0 ? totalSpent / sortedMonths.length : 0;

  const monthlyObligations = obligations.reduce((sum, ob) => {
    const freq = (ob.frequency || "").toLowerCase();
    const amt = ob.amount || 0;
    if (freq === "weekly") return sum + amt * 4.33;
    if (freq === "biweekly") return sum + amt * 2.17;
    if (freq === "quarterly") return sum + amt / 3;
    if (freq === "annual" || freq === "yearly") return sum + amt / 12;
    return sum + amt; // monthly default
  }, 0);
  const monthlyBurn = monthlyObligations + avgPerMonth;

  const outstanding =
    Number(profile.fields.remainingBalance || profile.fields.loanBalance || profile.fields.balance || 0) ||
    obligations.reduce((sum, ob) => sum + (ob.amount || 0), 0);

  // ── loan / amortization ────────────────────────────────────────
  type AmortRow = { month: number; payment: number; principal: number; interest: number; balance: number; cumPrincipal: number; cumInterest: number };

  function calculateAmortization(principal: number, annualRate: number, termMonths: number): AmortRow[] {
    if (!principal || !annualRate || !termMonths) return [];
    const monthlyRate = annualRate / 100 / 12;
    const payment = monthlyRate === 0
      ? principal / termMonths
      : principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);
    const rows: AmortRow[] = [];
    let balance = principal;
    let cumPrincipal = 0;
    let cumInterest = 0;
    for (let month = 1; month <= termMonths && balance > 0.005; month++) {
      const interest = balance * monthlyRate;
      const principalPaid = Math.min(payment - interest, balance);
      balance -= principalPaid;
      cumPrincipal += principalPaid;
      cumInterest += interest;
      rows.push({
        month,
        payment,
        principal: principalPaid,
        interest,
        balance: Math.max(0, balance),
        cumPrincipal,
        cumInterest,
      });
    }
    return rows;
  }

  const loanPrincipal = Number(profile.fields.originalAmount || profile.fields.loanBalance || profile.fields.remainingBalance || profile.fields.balance || 0);
  const loanRate = Number(profile.fields.interestRate || profile.fields.rate || profile.fields.apr || 0);
  const loanTerm = Number(profile.fields.termMonths || profile.fields.loanTerm || profile.fields.term || 0);
  const loanMonthlyPayment = Number(profile.fields.monthlyPayment || 0);

  // Derive term from monthly payment if not provided
  const derivedTerm = loanTerm || (() => {
    if (!loanPrincipal || !loanRate || !loanMonthlyPayment) return 0;
    const r = loanRate / 100 / 12;
    if (r === 0) return Math.round(loanPrincipal / loanMonthlyPayment);
    return Math.round(-Math.log(1 - (loanPrincipal * r) / loanMonthlyPayment) / Math.log(1 + r));
  })();

  const amortRows = isLoan ? calculateAmortization(loanPrincipal, loanRate, derivedTerm) : [];
  const totalInterest = amortRows.reduce((s, r) => s + r.interest, 0);
  const payoffDate = amortRows.length > 0
    ? new Date(now.getFullYear(), now.getMonth() + amortRows.length, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : null;

  // Amortization chart — sample every N months so chart is not too dense
  const amortChartSample = amortRows.filter((_, i) => {
    const step = Math.max(1, Math.floor(amortRows.length / 24));
    return i % step === 0 || i === amortRows.length - 1;
  }).map(r => ({
    month: r.month,
    balance: Math.round(r.balance),
    cumPrincipal: Math.round(r.cumPrincipal),
    cumInterest: Math.round(r.cumInterest),
  }));

  // ── payoff simulator ───────────────────────────────────────────
  // Simple simulation: recalc with extra payment
  function simulatePayoff(extra: number): { months: number; totalInterest: number } {
    if (!loanPrincipal || !loanRate) return { months: 0, totalInterest: 0 };
    const r = loanRate / 100 / 12;
    const basePayment = amortRows.length > 0 ? amortRows[0].payment : loanMonthlyPayment;
    const payment = basePayment + extra;
    let balance = loanPrincipal;
    let months = 0;
    let totalInt = 0;
    while (balance > 0.005 && months < 1200) {
      const interest = balance * r;
      const principalPaid = Math.min(payment - interest, balance);
      balance -= principalPaid;
      totalInt += interest;
      months++;
    }
    return { months, totalInterest: totalInt };
  }

  const baseSim = simulatePayoff(0);
  const extraSim = simulatePayoff(extraPayment);
  const monthsSaved = Math.max(0, baseSim.months - extraSim.months);
  const interestSaved = Math.max(0, baseSim.totalInterest - extraSim.totalInterest);
  const newPayoffDate = extraSim.months > 0
    ? new Date(now.getFullYear(), now.getMonth() + extraSim.months, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : null;

  // ── spending by category ───────────────────────────────────────
  const categoryTotals: Record<string, number> = {};
  for (const exp of expenses) {
    const cat = exp.category || "general";
    categoryTotals[cat] = (categoryTotals[cat] || 0) + (exp.amount || 0);
  }
  const pieData = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }));

  // ── investment ─────────────────────────────────────────────────
  const performanceHistory: any[] = Array.isArray(profile.fields.performanceHistory) ? profile.fields.performanceHistory : [];
  const perfChartData = performanceHistory
    .filter(p => p.date && p.value != null)
    .map(p => ({ date: new Date(p.date).toLocaleDateString(undefined, { month: "short", year: "2-digit" }), value: Number(p.value) }));

  // ── mutations ──────────────────────────────────────────────────
  const createExpenseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/expenses", {
        description: expDesc, amount: Number(expAmount), category: expCategory,
        vendor: expVendor || undefined, date: expDate,
      });
      const expense = await res.json();
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "expense", entityId: expense.id });
      return expense;
    },
    onSuccess: () => {
      const saved = expDesc;
      toast({ title: `$${Number(expAmount).toFixed(2)} expense added`, description: saved });
      setShowAddExpense(false);
      setExpDesc(""); setExpAmount(""); setExpCategory("general"); setExpVendor("");
      setExpDate(new Date().toISOString().slice(0, 10));
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to add expense", description: formatApiError(err), variant: "destructive" }),
  });

  const updateExpenseMutation = useMutation({
    mutationFn: async () => {
      if (!editingExpense) return;
      await apiRequest("PATCH", `/api/expenses/${editingExpense.id}`, {
        description: expDesc, amount: Number(expAmount), category: expCategory,
        vendor: expVendor || undefined, date: expDate,
      });
    },
    onSuccess: () => {
      toast({ title: `"${expDesc}" expense updated`, description: `$${Number(expAmount).toFixed(2)}` });
      setEditingExpense(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to update expense", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: async ({ id, desc }: { id: string; desc?: string }) => {
      await apiRequest("DELETE", `/api/expenses/${id}`);
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "expense", entityId: id });
      return { desc };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.desc || "Expense"}" deleted` });
      setDeleteExpenseId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  function openEdit(expense: ProfileDetail["relatedExpenses"][number]) {
    setExpDesc(expense.description);
    setExpAmount(String(expense.amount));
    setExpCategory(expense.category || "general");
    setExpVendor(expense.vendor || "");
    setExpDate(expense.date?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    setEditingExpense(expense);
  }

  function openAdd() {
    setExpDesc(""); setExpAmount(""); setExpCategory("general"); setExpVendor("");
    setExpDate(new Date().toISOString().slice(0, 10));
    setShowAddExpense(true);
  }

  // ── sorted expenses ────────────────────────────────────────────
  const sortedExpenses = [...expenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // ── obligation urgency helper ──────────────────────────────────
  function obligationUrgency(ob: ProfileDetail["relatedObligations"][number]): "overdue" | "soon" | "ok" {
    if (!ob.nextDueDate) return "ok";
    const due = new Date(ob.nextDueDate);
    const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays < 0) return "overdue";
    if (diffDays <= 7) return "soon";
    return "ok";
  }

  // (ownership is now handled by the top-right dropdown in the page header)

  // ── spending chart data (monthly bar chart) ──────────────────
  const monthlyBarData = sortedMonths.slice(-12).map(m => ({
    month: new Date(m + "-01").toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    amount: expensesByMonth[m] || 0,
  }));

  // ── render ─────────────────────────────────────────────────────
  return (
    <div className="space-y-4">

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 0 — Net Worth Overview (person/self only)       */}
      {/* ═══════════════════════════════════════════════════════ */}
      {["self","person"].includes(profile.type) && (() => {
        const children = (profile as any).childProfiles || [];
        // Assets: vehicles, property, investments, banking with a value field
        const assetTypes = ["vehicle","property","investment","asset","account","banking"];
        const assets = children.filter((c: any) => assetTypes.includes(c.type));
        const totalAssets = assets.reduce((s: number, c: any) => {
          const val = Number(c.fields?.currentValue || c.fields?.value || c.fields?.purchasePrice || c.fields?.balance || c.fields?.accountBalance || 0);
          return s + val;
        }, 0);
        // Liabilities: loans with a balance
        const loans = children.filter((c: any) => c.type === "loan" || c.fields?.loanBalance || c.fields?.remainingBalance);
        const totalLiabilities = loans.reduce((s: number, c: any) => {
          const bal = Number(c.fields?.remainingBalance || c.fields?.loanBalance || c.fields?.balance || 0);
          return s + bal;
        }, 0);
        const netWorth = totalAssets - totalLiabilities;
        // Monthly subscriptions
        const subs = children.filter((c: any) => c.type === "subscription" || c.type === "insurance");
        const monthlySubscriptions = subs.reduce((s: number, c: any) => {
          const cost = Number(c.fields?.monthlyCost || c.fields?.cost || c.fields?.monthlyPremium || 0);
          return s + cost;
        }, 0);

        return (
          <Card className="bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" /> Financial Overview
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {/* Net Worth Hero */}
              <div className={`rounded-xl p-3 mb-3 ${
                netWorth >= 0 ? "bg-green-500/8 border border-green-500/20" : "bg-red-500/8 border border-red-500/20"
              }`}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-0.5">Net Worth</p>
                <p className={`text-2xl font-bold tabular-nums ${netWorth >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                  {netWorth < 0 ? "-" : ""}{formatCurrency(Math.abs(netWorth))}
                </p>
                {(totalAssets > 0 || totalLiabilities > 0) && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {formatCurrency(totalAssets)} assets − {formatCurrency(totalLiabilities)} liabilities
                  </p>
                )}
              </div>
              {/* 3-col metrics */}
              <div className="grid grid-cols-3 gap-2">
                <div className="text-center p-2 rounded-lg bg-muted/30">
                  <p className="text-base font-bold tabular-nums text-foreground">{formatCurrency(totalAssets)}</p>
                  <p className="text-[11px] text-muted-foreground">Assets</p>
                  <p className="text-[10px] text-muted-foreground/70">{assets.length} items</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-muted/30">
                  <p className="text-base font-bold tabular-nums text-red-500">{formatCurrency(totalLiabilities)}</p>
                  <p className="text-[11px] text-muted-foreground">Liabilities</p>
                  <p className="text-[10px] text-muted-foreground/70">{loans.length} loan{loans.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="text-center p-2 rounded-lg bg-muted/30">
                  <p className="text-base font-bold tabular-nums text-foreground">{formatCurrency(monthlySubscriptions)}/mo</p>
                  <p className="text-[11px] text-muted-foreground">Subscriptions</p>
                  <p className="text-[10px] text-muted-foreground/70">{subs.length} active</p>
                </div>
              </div>
              {/* Asset list */}
              {assets.length > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Assets</p>
                  {assets.slice(0, 6).map((c: any) => (
                    <div key={c.id} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs truncate max-w-[140px]">{c.name}</span>
                        <Badge variant="outline" className="text-[10px] px-1 py-0 capitalize">{c.type}</Badge>
                      </div>
                      <span className="text-xs font-semibold tabular-nums">
                        {formatCurrency(Number(c.fields?.currentValue || c.fields?.value || c.fields?.purchasePrice || c.fields?.balance || 0))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Loan/liability list */}
              {loans.length > 0 && (
                <div className="mt-3 space-y-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Liabilities</p>
                  {loans.slice(0, 4).map((c: any) => (
                    <div key={c.id} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                      <span className="text-xs truncate max-w-[160px]">{c.name}</span>
                      <span className="text-xs font-semibold tabular-nums text-red-500">
                        -{formatCurrency(Number(c.fields?.remainingBalance || c.fields?.loanBalance || c.fields?.balance || 0))}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Monthly burn */}
              {(monthlyBurn > 0 || monthlySubscriptions > 0) && (
                <div className="mt-3 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Monthly burn rate</span>
                    <span className="text-xs font-semibold tabular-nums">{formatCurrency(monthlyBurn + monthlySubscriptions)}/mo</span>
                  </div>
                  {monthlySubscriptions > 0 && (
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-[11px] text-muted-foreground">Subscriptions</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{formatCurrency(monthlySubscriptions)}/mo</span>
                    </div>
                  )}
                  {avgPerMonth > 0 && (
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-[11px] text-muted-foreground">Avg expenses</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{formatCurrency(avgPerMonth)}/mo</span>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 1 — Summary stat cards                         */}
      {/* ═══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs-loose text-muted-foreground uppercase tracking-wide mb-1">Total Spent</p>
            <p className="text-xl font-bold tabular-nums text-foreground">{formatCurrency(totalSpent)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs-loose text-muted-foreground uppercase tracking-wide mb-1">This Month</p>
            <p className="text-xl font-bold tabular-nums text-foreground">{formatCurrency(thisMonth)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs-loose text-muted-foreground uppercase tracking-wide mb-1">Monthly Burn</p>
            <p className="text-xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{formatCurrency(monthlyBurn)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs-loose text-muted-foreground uppercase tracking-wide mb-1">Outstanding</p>
            <p className="text-xl font-bold tabular-nums text-red-600 dark:text-red-400">{formatCurrency(outstanding)}</p>
          </CardContent>
        </Card>
      </div>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 2 — Expenses list                              */}
      {/* ═══════════════════════════════════════════════════════ */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" /> Expenses
            </CardTitle>
            <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={openAdd} data-testid="button-add-expense">
              <Plus className="h-3.5 w-3.5" /> Add Expense
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {sortedExpenses.length === 0 ? (
            <div className="py-8 text-center">
              <DollarSign className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No expenses yet. Add one or tell the AI.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {sortedExpenses.map(expense => (
                <div key={expense.id} data-testid={`row-expense-${expense.id}`}>
                  <button
                    className="w-full text-left py-2.5 group"
                    onClick={() => setExpandedExpenseId(expandedExpenseId === expense.id ? null : expense.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{expense.description}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-xs text-muted-foreground">
                            {new Date(expense.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </span>
                          {expense.category && (
                            <Badge variant="secondary" className="text-xs px-1.5 py-0">{expense.category}</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-3">
                        <span className="text-sm font-bold tabular-nums">{formatCurrency(expense.amount)}</span>
                        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expandedExpenseId === expense.id ? "rotate-180" : ""}`} />
                      </div>
                    </div>
                  </button>
                  {expandedExpenseId === expense.id && (
                    <div className="pb-3 pl-1 space-y-2">
                      {expense.vendor && (
                        <p className="text-xs text-muted-foreground">Vendor: <span className="text-foreground">{expense.vendor}</span></p>
                      )}
                      <p className="text-xs text-muted-foreground">Date: <span className="text-foreground">{expense.date}</span></p>
                      <p className="text-xs text-muted-foreground">Category: <span className="text-foreground">{expense.category || "general"}</span></p>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs gap-1"
                          onClick={() => openEdit(expense)}
                          data-testid={`button-edit-expense-${expense.id}`}
                        >
                          <Edit className="h-3 w-3" /> Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs gap-1 text-destructive border-destructive/40 hover:bg-destructive/10"
                          onClick={() => setDeleteExpenseId(expense.id)}
                          data-testid={`button-delete-expense-${expense.id}`}
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 3 — Subscriptions & Bills                      */}
      {/* ═══════════════════════════════════════════════════════ */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" /> Subscriptions &amp; Bills
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {obligations.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No recurring bills</p>
          ) : (
            <div className="divide-y divide-border">
              {obligations.map(ob => {
                const urgency = obligationUrgency(ob);
                const rowClass =
                  urgency === "overdue" ? "bg-red-500/5" :
                  urgency === "soon" ? "bg-amber-500/5" : "";
                return (
                  <div key={ob.id} className={`py-3 px-1 rounded-sm ${rowClass}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{ob.name}</p>
                          {ob.autopay && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0 text-green-600 border-green-500/40">Autopay</Badge>
                          )}
                          {urgency === "overdue" && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0 text-red-600 border-red-500/40">Overdue</Badge>
                          )}
                          {urgency === "soon" && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0 text-amber-600 border-amber-500/40">Due soon</Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" className="text-xs">{ob.frequency}</Badge>
                          {ob.nextDueDate && (
                            <span className="text-xs text-muted-foreground">Next: {ob.nextDueDate}</span>
                          )}
                        </div>
                      </div>
                      <span className="text-sm font-bold tabular-nums shrink-0">{formatCurrency(ob.amount)}</span>
                    </div>
                    {ob.payments && ob.payments.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Recent payments</p>
                        {ob.payments.slice(-3).reverse().map(p => (
                          <div key={p.id} className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">{p.date}</span>
                            <span className="font-medium">{formatCurrency(p.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 4 — Loan Amortization (loans only)             */}
      {/* ═══════════════════════════════════════════════════════ */}
      {isLoan && loanPrincipal > 0 && loanRate > 0 && derivedTerm > 0 && (
        <Card className="border-orange-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Wallet className="h-4 w-4 text-muted-foreground" /> Loan Amortization
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Key stats row */}
            <div className="grid grid-cols-3 gap-3">
              <div className="text-center">
                <p className="text-xs-loose text-muted-foreground mb-1">Monthly Payment</p>
                <p className="text-lg font-bold tabular-nums text-orange-600 dark:text-orange-400">
                  {amortRows.length > 0 ? formatCurrency(amortRows[0].payment) : "—"}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs-loose text-muted-foreground mb-1">Total Interest</p>
                <p className="text-lg font-bold tabular-nums text-red-600 dark:text-red-400">{formatCurrency(totalInterest)}</p>
              </div>
              <div className="text-center">
                <p className="text-xs-loose text-muted-foreground mb-1">Payoff Date</p>
                <p className="text-base font-bold text-foreground">{payoffDate || "—"}</p>
              </div>
            </div>

            {/* Area chart: balance / cumulative principal / cumulative interest */}
            {amortChartSample.length > 1 && (
              <div>
                <p className="text-xs-loose text-muted-foreground mb-2">Balance &amp; Cumulative Paid Over Time</p>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={amortChartSample} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradBalance" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gradPrincipal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gradInterest" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} label={{ value: "Month", position: "insideBottom", offset: -2, fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                    <Tooltip
                      contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                      formatter={(val: number, name: string) => [formatCurrency(val), name === "balance" ? "Remaining Balance" : name === "cumPrincipal" ? "Principal Paid" : "Interest Paid"]}
                    />
                    <Area type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} fill="url(#gradBalance)" />
                    <Area type="monotone" dataKey="cumPrincipal" stroke="#10b981" strokeWidth={2} fill="url(#gradPrincipal)" />
                    <Area type="monotone" dataKey="cumInterest" stroke="#ef4444" strokeWidth={2} fill="url(#gradInterest)" />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="flex items-center gap-4 justify-center mt-1">
                  <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-blue-500 inline-block" /><span className="text-xs-loose text-muted-foreground">Remaining Balance</span></div>
                  <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500 inline-block" /><span className="text-xs-loose text-muted-foreground">Principal Paid</span></div>
                  <div className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-500 inline-block" /><span className="text-xs-loose text-muted-foreground">Interest Paid</span></div>
                </div>
              </div>
            )}

            {/* Collapsible amortization table */}
            {amortRows.length > 0 && (
              <div>
                <button
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setAmortTableOpen(!amortTableOpen)}
                >
                  {amortTableOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {amortTableOpen ? "Hide" : "Show"} amortization schedule
                </button>
                {amortTableOpen && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs tabular-nums">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground">
                          <th className="text-left py-1.5 pr-3 font-medium">Month</th>
                          <th className="text-right py-1.5 pr-3 font-medium">Payment</th>
                          <th className="text-right py-1.5 pr-3 font-medium">Principal</th>
                          <th className="text-right py-1.5 pr-3 font-medium">Interest</th>
                          <th className="text-right py-1.5 font-medium">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {[
                          ...amortRows.slice(0, 12),
                          ...(amortRows.length > 13 ? [null] : []),
                          ...(amortRows.length > 12 ? [amortRows[amortRows.length - 1]] : []),
                        ].map((row, i) =>
                          row === null ? (
                            <tr key="ellipsis">
                              <td colSpan={5} className="text-center text-muted-foreground py-1">…</td>
                            </tr>
                          ) : (
                            <tr key={row.month} className={i >= 12 ? "text-muted-foreground" : ""}>
                              <td className="py-1.5 pr-3">{row.month}</td>
                              <td className="text-right py-1.5 pr-3">{formatCurrency(row.payment)}</td>
                              <td className="text-right py-1.5 pr-3 text-green-600">{formatCurrency(row.principal)}</td>
                              <td className="text-right py-1.5 pr-3 text-red-500">{formatCurrency(row.interest)}</td>
                              <td className="text-right py-1.5">{formatCurrency(row.balance)}</td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 5 — Payoff Simulator (loans only)              */}
      {/* ═══════════════════════════════════════════════════════ */}
      {isLoan && loanPrincipal > 0 && loanRate > 0 && baseSim.months > 0 && (
        <Card className="border-blue-500/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingDown className="h-4 w-4 text-muted-foreground" /> Payoff Simulator
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">Extra monthly payment</span>
                <span className="text-sm font-bold tabular-nums text-blue-600">${extraPayment}/mo</span>
              </div>
              <Slider
                min={0}
                max={500}
                step={10}
                value={[extraPayment]}
                onValueChange={([v]) => setExtraPayment(v)}
                className="mb-3"
              />
              <div className="grid grid-cols-3 gap-3 mt-2">
                <div className="text-center p-3 rounded-lg bg-muted/50">
                  <p className="text-xs-loose text-muted-foreground mb-1">New Payoff</p>
                  <p className="text-sm font-bold text-foreground">{newPayoffDate || "—"}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-green-500/10">
                  <p className="text-xs-loose text-muted-foreground mb-1">Months Saved</p>
                  <p className="text-sm font-bold text-green-600">{monthsSaved}</p>
                </div>
                <div className="text-center p-3 rounded-lg bg-green-500/10">
                  <p className="text-xs-loose text-muted-foreground mb-1">Interest Saved</p>
                  <p className="text-sm font-bold text-green-600">{formatCurrency(interestSaved)}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 6 — Spending by Category (non-loan profiles)   */}
      {/* ═══════════════════════════════════════════════════════ */}
      {!isLoan && pieData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" /> Spending by Category
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <ResponsiveContainer width={180} height={180}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {pieData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                    formatter={(val: number) => [formatCurrency(val)]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-1.5 w-full">
                {pieData.map((item, index) => (
                  <div key={item.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ background: CHART_COLORS[index % CHART_COLORS.length] }}
                      />
                      <span className="text-xs capitalize text-muted-foreground">{item.name}</span>
                    </div>
                    <span className="text-xs font-semibold tabular-nums">{formatCurrency(item.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════ */}
      {/* SECTION 7 — Monthly Spending Trend (bar chart)          */}
      {/* ═══════════════════════════════════════════════════════ */}
      {!isLoan && !isInvestment && monthlyBarData.length >= 2 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" /> Monthly Spending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={monthlyBarData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval={monthlyBarData.length > 6 ? 1 : 0} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={38} tickFormatter={v => `$${v >= 1000 ? (v/1000).toFixed(0)+'k' : v}`} />
                <Tooltip
                  contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  formatter={(val: number) => [formatCurrency(val), "Spent"]}
                />
                <Bar dataKey="amount" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} maxBarSize={32} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Investment performance chart (preserved) */}
      {isInvestment && perfChartData.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-muted-foreground" /> Performance History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={perfChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  formatter={(val: number) => [formatCurrency(val), "Balance"]}
                />
                <Line type="monotone" dataKey="value" stroke="#20808D" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════ */}
      {/* Dialogs                                                 */}
      {/* ═══════════════════════════════════════════════════════ */}

      {/* Add Expense Dialog */}
      <Dialog open={showAddExpense} onOpenChange={(open) => {
        setShowAddExpense(open);
        if (!open) { setExpDesc(""); setExpAmount(""); setExpCategory("general"); setExpVendor(""); setExpDate(new Date().toISOString().slice(0, 10)); }
      }}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-add-expense">
          <DialogHeader>
            <DialogTitle>Add Expense</DialogTitle>
            <DialogDescription>Add a new expense linked to this profile.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input
                className={`mt-1 ${showAddExpense && expDesc.trim() === "" ? "border-destructive focus-visible:ring-destructive" : ""}`}
                value={expDesc}
                onChange={e => setExpDesc(e.target.value)}
                placeholder="e.g. Vet visit"
                data-testid="input-expense-desc"
              />
              {showAddExpense && expDesc.trim() === "" && (
                <p className="text-xs text-destructive mt-1">Description is required</p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input
                className={`mt-1 ${showAddExpense && (expAmount === "" || Number(expAmount) <= 0) ? "border-destructive focus-visible:ring-destructive" : ""}`}
                type="number"
                step="0.01"
                value={expAmount}
                onChange={e => setExpAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-expense-amount"
              />
              {showAddExpense && (expAmount === "" || Number(expAmount) <= 0) && (
                <p className="text-xs text-destructive mt-1">Amount must be greater than 0</p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <Select value={expCategory} onValueChange={setExpCategory}>
                <SelectTrigger className="mt-1" data-testid="select-expense-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {expenseCategories.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Vendor</label>
              <Input className="mt-1" value={expVendor} onChange={e => setExpVendor(e.target.value)} placeholder="Optional" data-testid="input-expense-vendor" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input className="mt-1" type="date" value={expDate} onChange={e => setExpDate(e.target.value)} data-testid="input-expense-date" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddExpense(false)}>Cancel</Button>
            <Button
              onClick={() => createExpenseMutation.mutate()}
              disabled={createExpenseMutation.isPending || !expDesc.trim() || !expAmount || Number(expAmount) <= 0}
              data-testid="button-save-expense"
            >
              {createExpenseMutation.isPending ? "Saving..." : "Add Expense"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Expense Dialog */}
      <Dialog open={!!editingExpense} onOpenChange={() => setEditingExpense(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-edit-expense">
          <DialogHeader>
            <DialogTitle>Edit Expense</DialogTitle>
            <DialogDescription>Update this expense.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input className="mt-1" value={expDesc} onChange={e => setExpDesc(e.target.value)} data-testid="input-edit-expense-desc" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input className="mt-1" type="number" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} data-testid="input-edit-expense-amount" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <Select value={expCategory} onValueChange={setExpCategory}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {expenseCategories.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Vendor</label>
              <Input className="mt-1" value={expVendor} onChange={e => setExpVendor(e.target.value)} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input className="mt-1" type="date" value={expDate} onChange={e => setExpDate(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingExpense(null)}>Cancel</Button>
            <Button onClick={() => updateExpenseMutation.mutate()} disabled={updateExpenseMutation.isPending || !expDesc || !expAmount} data-testid="button-update-expense">
              {updateExpenseMutation.isPending ? "Saving..." : "Update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Expense Confirmation */}
      <AlertDialog open={!!deleteExpenseId} onOpenChange={() => setDeleteExpenseId(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-expense">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Expense?</AlertDialogTitle>
            <AlertDialogDescription>This expense will be permanently deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteExpenseId) { const e = expenses.find(x => x.id === deleteExpenseId); deleteExpenseMutation.mutate({ id: deleteExpenseId, desc: e?.description }); } }}
              disabled={deleteExpenseMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-expense"
            >
              {deleteExpenseMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================
// TRACKERS TAB — Upgraded with Recharts sparklines
// ============================================================

function TrackerCard_Profile({
  tracker,
  profileId,
  onChanged,
  onLogEntry,
  onUnlink,
  onDeleteTracker,
}: {
  tracker: ProfileDetail["relatedTrackers"][number];
  profileId: string;
  onChanged: () => void;
  onLogEntry: (trackerId: string) => void;
  onUnlink: (trackerId: string) => void;
  onDeleteTracker: (trackerId: string) => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [deleteEntryId, setDeleteEntryId] = useState<string | null>(null);

  const last10 = tracker.entries.slice(-10);

  // Find the first numeric field
  const numericField = tracker.fields?.find(
    (f: any) => last10.some(e => typeof e.values[f.name] === "number")
  );
  const fieldName = numericField?.name || (last10[0] ? Object.keys(last10[0].values)[0] : null);

  const chartData = last10.map((e, i) => ({
    i,
    val: fieldName != null ? (typeof e.values[fieldName] === "number" ? e.values[fieldName] : Number(e.values[fieldName])) : 0,
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  })).filter(d => !isNaN(d.val as number));

  const latestEntry = last10[last10.length - 1];
  const latestVal = latestEntry && fieldName != null ? latestEntry.values[fieldName] : null;

  let trend: "up" | "down" | "flat" = "flat";
  if (chartData.length >= 2) {
    const first = chartData[0].val as number;
    const last = chartData[chartData.length - 1].val as number;
    if (last > first * 1.01) trend = "up";
    else if (last < first * 0.99) trend = "down";
  }

  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = trend === "up" ? "text-green-500" : trend === "down" ? "text-red-500" : "text-muted-foreground";

  const sortedEntries = [...tracker.entries].reverse();

  const deleteEntryMutation = useMutation({
    mutationFn: async (entryId: string) => {
      await apiRequest("DELETE", `/api/trackers/${tracker.id}/entries/${entryId}`);
    },
    onSuccess: () => {
      toast({ title: "Entry deleted" });
      setDeleteEntryId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Card data-testid={`card-tracker-${tracker.id}`}>
      <CardContent className="p-3">
        {/* Header: name, badges, latest value, action buttons */}
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{tracker.name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              {tracker.category && (
                <Badge variant="secondary" className="text-xs">{tracker.category}</Badge>
              )}
              <span className="text-xs text-muted-foreground">{tracker.entries.length} entries</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {latestVal != null && (
              <span className="text-base font-semibold tabular-nums">
                {typeof latestVal === "number" ? latestVal.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(latestVal)}
                {tracker.unit && <span className="text-xs text-muted-foreground ml-0.5">{tracker.unit}</span>}
              </span>
            )}
            <TrendIcon className={`h-4 w-4 ${trendColor}`} />
          </div>
        </div>

        {/* Action buttons row - always visible */}
        <div className="flex gap-1.5 mb-2">
          <Button variant="secondary" size="sm" className="h-6 text-xs px-2 gap-1" onClick={() => onLogEntry(tracker.id)} data-testid={`button-log-entry-${tracker.id}`}>
            <Plus className="h-3 w-3" /> Log Entry
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-xs px-2 gap-1 text-muted-foreground" onClick={() => onUnlink(tracker.id)} data-testid={`button-unlink-tracker-${tracker.id}`}>
            <Unlink className="h-3 w-3" /> Unlink
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-xs px-2 gap-1 text-destructive" onClick={() => onDeleteTracker(tracker.id)} data-testid={`button-delete-tracker-${tracker.id}`}>
            <Trash2 className="h-3 w-3" /> Delete
          </Button>
        </div>

        {/* Chart if 2+ data points */}
        {chartData.length >= 2 && (
          <ResponsiveContainer width="100%" height={60}>
            <LineChart data={chartData} margin={{ top: 2, right: 2, left: 0, bottom: 2 }}>
              <Line type="monotone" dataKey="val" stroke="#20808D" strokeWidth={1.5} dot={false} />
              <Tooltip
                contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 4 }}
                labelFormatter={(_, payload) => payload?.[0]?.payload?.date || ""}
                formatter={(val: number) => [
                  `${val.toLocaleString(undefined, { maximumFractionDigits: 1 })}${tracker.unit ? " " + tracker.unit : ""}`,
                  tracker.name,
                ]}
              />
            </LineChart>
          </ResponsiveContainer>
        )}

        {/* Entries list: always show recent, expand for all */}
        {tracker.entries.length > 0 ? (
          <>
            {/* Always show last 3 entries */}
            <div className="space-y-0 mt-1">
              {(expanded ? sortedEntries : sortedEntries.slice(0, 3)).map(entry => (
                <div key={entry.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-xs" data-testid={`entry-row-${entry.id}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {(() => {
                      const pf = tracker.fields?.find((f: any) => f.isPrimary)?.name || tracker.fields?.[0]?.name;
                      const pv = pf ? entry.values[pf] : undefined;
                      const allVals = Object.entries(entry.values).filter(([, v]) => v != null && v !== "");
                      if (pv != null) {
                        return <span className="font-mono font-semibold text-sm tabular-nums">{pv}{tracker.unit ? ` ${tracker.unit}` : ""}</span>;
                      } else if (allVals.length > 0) {
                        return <span className="font-medium">{allVals.map(([k, v]) => `${v}${tracker.unit ? " " + tracker.unit : ""}`).join(", ")}</span>;
                      } else {
                        return <span className="text-muted-foreground italic">(no value)</span>;
                      }
                    })()}
                    {entry.notes && <span className="text-muted-foreground truncate max-w-[100px]" title={entry.notes}>{entry.notes}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    <span className="text-muted-foreground text-xs">
                      {new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteEntryId(entry.id)}
                      data-testid={`button-delete-entry-${entry.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {/* Expand/collapse button if more than 3 entries */}
            {sortedEntries.length > 3 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-6 text-xs w-full flex items-center gap-1 text-muted-foreground"
                onClick={() => setExpanded(v => !v)}
                data-testid={`button-expand-${tracker.id}`}
              >
                {expanded ? (
                  <><ChevronUp className="h-3 w-3" /> Hide entries</>
                ) : (
                  <><ChevronDown className="h-3 w-3" /> View all {sortedEntries.length} entries</>
                )}
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground py-2 text-center">No entries yet — tap "Log Entry" to add one</p>
        )}
      </CardContent>

      {/* Delete Entry Confirmation */}
      <AlertDialog open={!!deleteEntryId} onOpenChange={() => setDeleteEntryId(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-entry">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>This entry will be permanently removed from the tracker.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteEntryId && deleteEntryMutation.mutate(deleteEntryId)}
              disabled={deleteEntryMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-entry"
            >
              {deleteEntryMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function TrackersTab({
  trackers,
  profileId,
  onChanged,
}: {
  trackers: ProfileDetail["relatedTrackers"];
  profileId: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [showCreateTracker, setShowCreateTracker] = useState(false);
  const [showLinkTracker, setShowLinkTracker] = useState(false);
  const [showLogEntry, setShowLogEntry] = useState<string | null>(null);
  const [unlinkTrackerId, setUnlinkTrackerId] = useState<string | null>(null);
  const [deleteTrackerId, setDeleteTrackerId] = useState<string | null>(null);

  // Create tracker form
  const [newTrackerName, setNewTrackerName] = useState("");
  const [newTrackerUnit, setNewTrackerUnit] = useState("");
  const [newTrackerCategory, setNewTrackerCategory] = useState("custom");
  const [newFieldName, setNewFieldName] = useState("value");
  const [newFieldType, setNewFieldType] = useState<"number" | "text">("number");

  // Log entry form
  const [entryValue, setEntryValue] = useState("");
  const [entryNotes, setEntryNotes] = useState("");

  // All trackers for linking — always refetch to include newly created trackers
  const { data: allTrackers } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers"],
    queryFn: async () => { const res = await apiRequest("GET", "/api/trackers"); return res.json(); },
    staleTime: 10000, // 10s
  });

  const linkedIds = new Set(trackers.map(t => t.id));
  const unlinkableTrackers = (allTrackers || []).filter(t => !linkedIds.has(t.id));

  const createTrackerMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/trackers", {
        name: newTrackerName,
        unit: newTrackerUnit || undefined,
        category: newTrackerCategory,
        fields: [{ name: newFieldName || "value", type: newFieldType, isPrimary: true }],
      });
      const tracker = await res.json();
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "tracker", entityId: tracker.id });
      return tracker;
    },
    onSuccess: () => {
      toast({ title: "Tracker created and linked" });
      setShowCreateTracker(false);
      setNewTrackerName(""); setNewTrackerUnit(""); setNewTrackerCategory("custom"); setNewFieldName("value"); setNewFieldType("number");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const linkTrackerMutation = useMutation({
    mutationFn: async (trackerId: string) => {
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "tracker", entityId: trackerId });
    },
    onSuccess: () => {
      toast({ title: "Tracker linked" });
      setShowLinkTracker(false);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const unlinkTrackerMutation = useMutation({
    mutationFn: async (trackerId: string) => {
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "tracker", entityId: trackerId });
    },
    onSuccess: () => {
      toast({ title: "Tracker unlinked" });
      setUnlinkTrackerId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteTrackerMutation = useMutation({
    mutationFn: async (trackerId: string) => {
      await apiRequest("DELETE", `/api/trackers/${trackerId}`);
    },
    onSuccess: () => {
      toast({ title: "Tracker deleted" });
      setDeleteTrackerId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to delete tracker", description: formatApiError(err), variant: "destructive" }),
  });

  const logEntryMutation = useMutation({
    mutationFn: async (trackerId: string) => {
      const tracker = trackers.find(t => t.id === trackerId);
      const primaryField = tracker?.fields?.find((f: any) => f.isPrimary)?.name || tracker?.fields?.[0]?.name || "value";
      const numVal = Number(entryValue);
      const values: Record<string, any> = { [primaryField]: isNaN(numVal) ? entryValue : numVal };
      await apiRequest("POST", `/api/trackers/${trackerId}/entries`, {
        trackerId, values, notes: entryNotes || undefined,
      });
    },
    onSuccess: (_data, trackerId) => {
      const tracker = trackers.find(t => t.id === trackerId);
      toast({ title: `Entry logged to "${tracker?.name || "tracker"}"`, description: entryValue ? `Value: ${entryValue}` : undefined });
      setShowLogEntry(null);
      setEntryValue(""); setEntryNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to log entry", description: formatApiError(err), variant: "destructive" }),
  });

  const trackerCategories = ["custom", "health", "fitness", "finance", "productivity", "nutrition", "sleep", "mood", "weight", "other"];

  return (
    <div className="space-y-3">
      {/* Action buttons */}
      <div className="flex gap-2 justify-end">
        {unlinkableTrackers.length > 0 && (
          <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" onClick={() => setShowLinkTracker(true)} data-testid="button-link-tracker">
            <Link2 className="h-3.5 w-3.5" /> Link Existing
          </Button>
        )}
        <Button size="sm" className="gap-1.5 h-8 text-xs" onClick={() => setShowCreateTracker(true)} data-testid="button-create-tracker">
          <Plus className="h-3.5 w-3.5" /> New Tracker
        </Button>
      </div>

      {trackers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Activity className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No linked trackers</p>
            <p className="text-xs text-muted-foreground mt-1">Create or link a tracker above</p>
          </CardContent>
        </Card>
      ) : (
        trackers.map(tracker => (
          <TrackerCard_Profile
            key={tracker.id}
            tracker={tracker}
            profileId={profileId}
            onChanged={onChanged}
            onLogEntry={(id) => { setEntryValue(""); setEntryNotes(""); setShowLogEntry(id); }}
            onUnlink={(id) => setUnlinkTrackerId(id)}
            onDeleteTracker={(id) => setDeleteTrackerId(id)}
          />
        ))
      )}

      {/* Create Tracker Dialog */}
      <Dialog open={showCreateTracker} onOpenChange={(open) => {
        setShowCreateTracker(open);
        if (!open) { setNewTrackerName(""); setNewTrackerUnit(""); setNewTrackerCategory("custom"); setNewFieldName("value"); setNewFieldType("number"); }
      }}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-create-tracker">
          <DialogHeader>
            <DialogTitle>New Tracker</DialogTitle>
            <DialogDescription>Create a new tracker linked to this profile.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input className="mt-1" value={newTrackerName} onChange={e => setNewTrackerName(e.target.value)} placeholder="e.g. Weight" data-testid="input-tracker-name" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Unit</label>
              <Input className="mt-1" value={newTrackerUnit} onChange={e => setNewTrackerUnit(e.target.value)} placeholder="e.g. lbs, kg, hours" data-testid="input-tracker-unit" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Category</label>
              <Select value={newTrackerCategory} onValueChange={setNewTrackerCategory}>
                <SelectTrigger className="mt-1" data-testid="select-tracker-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {trackerCategories.map(c => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Primary Field Name</label>
              <Input className="mt-1" value={newFieldName} onChange={e => setNewFieldName(e.target.value)} placeholder="value" data-testid="input-tracker-field-name" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Field Type</label>
              <Select value={newFieldType} onValueChange={v => setNewFieldType(v as "number" | "text")}>
                <SelectTrigger className="mt-1" data-testid="select-tracker-field-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="number">Number</SelectItem>
                  <SelectItem value="text">Text</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateTracker(false)}>Cancel</Button>
            <Button onClick={() => createTrackerMutation.mutate()} disabled={createTrackerMutation.isPending || !newTrackerName} data-testid="button-save-tracker">
              {createTrackerMutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Link Existing Tracker Dialog */}
      <Dialog open={showLinkTracker} onOpenChange={setShowLinkTracker}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-link-tracker">
          <DialogHeader>
            <DialogTitle>Link Tracker</DialogTitle>
            <DialogDescription>Link an existing tracker to this profile.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-[300px] overflow-y-auto">
            {unlinkableTrackers.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">All trackers are already linked</p>
            ) : (
              unlinkableTrackers.map(tracker => (
                <div key={tracker.id} className="flex items-center justify-between p-2 rounded-lg border border-border hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{tracker.name}</p>
                    <p className="text-xs text-muted-foreground">{tracker.category} {tracker.unit ? `(${tracker.unit})` : ""}</p>
                  </div>
                  <Button size="sm" className="h-7 text-xs" onClick={() => linkTrackerMutation.mutate(tracker.id)} disabled={linkTrackerMutation.isPending} data-testid={`button-link-${tracker.id}`}>
                    Link
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Log Entry Dialog */}
      <Dialog open={!!showLogEntry} onOpenChange={() => setShowLogEntry(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-log-entry">
          <DialogHeader>
            <DialogTitle>Log Entry</DialogTitle>
            <DialogDescription>Add a new entry to {trackers.find(t => t.id === showLogEntry)?.name || "this tracker"}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Value {trackers.find(t => t.id === showLogEntry)?.unit ? `(${trackers.find(t => t.id === showLogEntry)?.unit})` : ""}
              </label>
              <Input className="mt-1" value={entryValue} onChange={e => setEntryValue(e.target.value)} placeholder="Enter value" data-testid="input-entry-value" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
              <Input className="mt-1" value={entryNotes} onChange={e => setEntryNotes(e.target.value)} placeholder="Any notes" data-testid="input-entry-notes" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowLogEntry(null)}>Cancel</Button>
            <Button onClick={() => showLogEntry && logEntryMutation.mutate(showLogEntry)} disabled={logEntryMutation.isPending || !entryValue} data-testid="button-save-entry">
              {logEntryMutation.isPending ? "Logging..." : "Log Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unlink Confirmation */}
      <AlertDialog open={!!unlinkTrackerId} onOpenChange={() => setUnlinkTrackerId(null)}>
        <AlertDialogContent data-testid="dialog-confirm-unlink-tracker">
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink Tracker?</AlertDialogTitle>
            <AlertDialogDescription>This will remove the tracker from this profile. The tracker itself will not be deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unlinkTrackerId && unlinkTrackerMutation.mutate(unlinkTrackerId)}
              disabled={unlinkTrackerMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-unlink-tracker"
            >
              {unlinkTrackerMutation.isPending ? "Unlinking..." : "Unlink"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Tracker Confirmation */}
      <AlertDialog open={!!deleteTrackerId} onOpenChange={() => setDeleteTrackerId(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-tracker">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tracker Permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the tracker "{trackers.find(t => t.id === deleteTrackerId)?.name}" and all its entries. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTrackerId && deleteTrackerMutation.mutate(deleteTrackerId)}
              disabled={deleteTrackerMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-tracker"
            >
              {deleteTrackerMutation.isPending ? "Deleting..." : "Delete Permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================
// TIMELINE TAB
// ============================================================

// ============================================================
// HEALTH TAB VIEW — summary + grouped trackers
// ============================================================

// Quick-add health tracker button for empty health tab
function QuickHealthButton({ profileId, name, unit, field, category, fieldType = "number", onCreated }: {
  profileId: string; name: string; unit: string; field: string; category: string; fieldType?: "number" | "text"; onCreated: () => void;
}) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/trackers", {
        name, unit: unit || undefined, category,
        fields: [{ name: field, type: fieldType, isPrimary: true }],
      });
      const tracker = await res.json();
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "tracker", entityId: tracker.id });
      // Also update tracker's linkedProfiles
      await apiRequest("PATCH", `/api/trackers/${tracker.id}`, { linkedProfiles: [profileId] });
      return tracker;
    },
    onSuccess: (tracker) => {
      toast({ title: `${name} tracker created` });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onCreated();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      data-testid={`quick-health-${name.toLowerCase().replace(/\s/g, '-')}`}>
      <Plus className="h-3 w-3" />
      {mutation.isPending ? "Creating..." : name}
    </Button>
  );
}

function HealthTabView({ profile, onChanged }: { profile: ProfileDetail; onChanged: () => void }) {
  const { toast } = useToast();
  const profileId = profile.id;

  // ── state ──────────────────────────────────────────────────
  const [expandedTrackers, setExpandedTrackers] = useState<Set<string>>(new Set());
  const [logOpen, setLogOpen] = useState<string | null>(null); // trackerId
  const [logValue, setLogValue] = useState("");
  const [logNotes, setLogNotes] = useState("");


  // ── filter health trackers ─────────────────────────────────
  const healthCats = ["health", "fitness", "weight", "sleep", "wellness", "nutrition", "medical", "vitals", "diet", "calories", "water", "blood"];
  const healthTrackers = profile.relatedTrackers.filter((t: any) =>
    healthCats.some(c => (t.category || "").toLowerCase().includes(c) || (t.name || "").toLowerCase().includes(c))
  );

  // ── helpers ───────────────────────────────────────────────
  function getPrimaryField(tracker: any): string {
    return tracker.fields?.find((f: any) => f.isPrimary)?.name || tracker.fields?.[0]?.name || "value";
  }

  function getLatestValue(tracker: any): number | string | null {
    const pf = getPrimaryField(tracker);
    const sorted = [...(tracker.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const v = sorted[0]?.values?.[pf];
    if (v == null) return null;
    const num = Number(v);
    return isNaN(num) ? String(v) : num;
  }

  function getPrevValue(tracker: any): number | null {
    const pf = getPrimaryField(tracker);
    const sorted = [...(tracker.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const v = sorted[1]?.values?.[pf];
    if (v == null) return null;
    const num = Number(v);
    return isNaN(num) ? null : num;
  }

  function get7DayAvg(tracker: any): number | null {
    const pf = getPrimaryField(tracker);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = (tracker.entries || []).filter((e: any) => new Date(e.timestamp).getTime() >= since);
    if (recent.length === 0) return null;
    const nums = recent.map((e: any) => Number(e.values?.[pf])).filter((n: number) => !isNaN(n));
    if (nums.length === 0) return null;
    return nums.reduce((a: number, b: number) => a + b, 0) / nums.length;
  }

  function getTrend(tracker: any): "up" | "down" | "flat" {
    const latest = getLatestValue(tracker);
    const prev = getPrevValue(tracker);
    if (latest == null || prev == null) return "flat";
    if (Number(latest) > Number(prev)) return "up";
    if (Number(latest) < Number(prev)) return "down";
    return "flat";
  }

  function getDaysSinceLastEntry(tracker: any): number | null {
    if (!tracker.entries?.length) return null;
    const sorted = [...tracker.entries].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const ms = Date.now() - new Date(sorted[0].timestamp).getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
  }

  function getStreak(tracker: any): number {
    if (!tracker.entries?.length) return 0;
    const sorted = [...tracker.entries].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    let streak = 0;
    let prevDate = new Date();
    prevDate.setHours(0, 0, 0, 0);
    for (const e of sorted) {
      const d = new Date(e.timestamp);
      d.setHours(0, 0, 0, 0);
      const diffDays = Math.round((prevDate.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
      if (diffDays <= 1) { streak++; prevDate = d; }
      else break;
    }
    return streak;
  }

  // ── log entry mutation ────────────────────────────────────
  const logMutation = useMutation({
    mutationFn: async ({ trackerId, values, notes }: { trackerId: string; values: Record<string, number>; notes: string }) => {
      await apiRequest("POST", `/api/trackers/${trackerId}/entries`, { values, notes });
    },
    onSuccess: () => {
      toast({ title: "Entry logged" });
      setLogOpen(null); setLogValue(""); setLogNotes("");
      setLogOpen(null); setLogValue("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  // ── empty state ───────────────────────────────────────────
  if (healthTrackers.length === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <CardContent className="py-10 text-center">
            <HeartPulse className="h-12 w-12 text-muted-foreground/25 mx-auto mb-3" />
            <p className="text-sm font-semibold text-muted-foreground">No health data yet</p>
            <p className="text-xs text-muted-foreground mt-1.5 mb-5">Create a health tracker to start logging data</p>
            <div className="flex flex-wrap gap-2 justify-center">
              <QuickHealthButton profileId={profile.id} name="Weight" unit="lbs" field="weight" category="health" onCreated={onChanged} />
              <QuickHealthButton profileId={profile.id} name="Blood Pressure" unit="mmHg" field="systolic" category="health" onCreated={onChanged} />
              <QuickHealthButton profileId={profile.id} name="Sleep" unit="hrs" field="hours" category="sleep" onCreated={onChanged} />
              <QuickHealthButton profileId={profile.id} name="Calories" unit="kcal" field="calories" category="nutrition" onCreated={onChanged} />
              <QuickHealthButton profileId={profile.id} name="Water" unit="oz" field="oz" category="health" onCreated={onChanged} />
              {profile.type === "pet" && (
                <QuickHealthButton profileId={profile.id} name="Vaccination" unit="" field="vaccine" category="health" fieldType="text" onCreated={onChanged} />
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Section 1: Vitals Dashboard ───────────────────────────
  const vitalCards = healthTrackers.map((t: any) => {
    const pf = getPrimaryField(t);
    const latest = getLatestValue(t);
    const prev = getPrevValue(t);
    const avg7 = get7DayAvg(t);
    const trend = getTrend(t);
    const sparkData = (t.entries || []).slice(-10).map((e: any) => ({
      v: Number(e.values?.[pf] ?? 0),
    }));
    const sorted = [...(t.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const lastDate = sorted[0]?.timestamp ? new Date(sorted[0].timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
    return { tracker: t, pf, latest, prev, avg7, trend, sparkData, lastDate };
  }).filter((v: any) => v.latest != null);

  // ── Section 2: Top 3 trackers by entry count (trend charts) ─
  const topChartTrackers = [...healthTrackers]
    .sort((a: any, b: any) => (b.entries?.length || 0) - (a.entries?.length || 0))
    .slice(0, 3)
    .filter((t: any) => (t.entries?.length || 0) >= 2);

  // Quick log removed — use the inline "Log Entry" form within each tracker card instead

  // ── Section 5: AI Health Insights ────────────────────────
  const insights: { key: string; text: string; level: "warn" | "info" | "good" }[] = [];

  for (const t of healthTrackers) {
    const pf = getPrimaryField(t);
    const latest = getLatestValue(t);
    const avg7 = get7DayAvg(t);
    const trend = getTrend(t);
    const days = getDaysSinceLastEntry(t);
    const streak = getStreak(t);
    const nameLower = t.name.toLowerCase();

    // Weight trending up
    if (nameLower.includes("weight") && trend === "up" && latest != null && avg7 != null) {
      insights.push({ key: `weight-up-${t.id}`, text: `Weight trending up — ${Number(latest).toFixed(1)} ${t.unit || ""} vs ${Number(avg7).toFixed(1)} ${t.unit || ""} (7-day avg)`, level: "warn" });
    }
    // BP elevated
    if ((nameLower.includes("blood pressure") || nameLower.includes("bp")) && latest != null && Number(latest) > 130) {
      insights.push({ key: `bp-${t.id}`, text: `Blood pressure reading is elevated (${latest} ${t.unit || "mmHg"})`, level: "warn" });
    }
    // No entries in 3+ days
    if (days != null && days >= 3 && t.entries?.length > 0) {
      insights.push({ key: `no-log-${t.id}`, text: `No ${t.name} logged in ${days} day${days !== 1 ? "s" : ""}`, level: "info" });
    }
    // Good streak
    if (streak >= 3) {
      insights.push({ key: `streak-${t.id}`, text: `${t.name}: ${streak}-day logging streak`, level: "good" });
    }
  }

  return (
    <div className="space-y-4">

      {/* ── Section 1: Vitals Dashboard ── */}
      {vitalCards.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1">
            <Heart className="h-3 w-3" /> Latest Vitals
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {vitalCards.map(({ tracker, latest, prev, avg7, trend, sparkData, lastDate }: any) => {
              const trendColor = trend === "up" ? "text-green-500" : trend === "down" ? "text-red-500" : "text-muted-foreground";
              return (
                <div key={tracker.id} className="rounded-lg border bg-card p-3 flex flex-col gap-1.5">
                  <p className="text-xs text-muted-foreground truncate font-medium">{tracker.name}</p>
                  <div className="flex items-end justify-between">
                    <div className="flex items-baseline gap-1">
                      <span className="text-xl font-bold tabular-nums leading-none">
                        {typeof latest === "number" ? latest.toLocaleString(undefined, { maximumFractionDigits: 1 }) : latest}
                      </span>
                      {tracker.unit && <span className="text-xs text-muted-foreground">{tracker.unit}</span>}
                    </div>
                    <div className={`flex items-center gap-0.5 text-xs font-medium ${trendColor}`}>
                      {trend === "up" && <ArrowUp className="h-3 w-3" />}
                      {trend === "down" && <ArrowDown className="h-3 w-3" />}
                      {trend === "flat" && <Minus className="h-3 w-3" />}
                    </div>
                  </div>
                  {sparkData.length >= 2 && (
                    <div style={{ width: "100%", height: 22 }}>
                      <ResponsiveContainer width="100%" height={22}>
                        <AreaChart data={sparkData} margin={{ top: 1, right: 0, left: 0, bottom: 1 }}>
                          <Area type="monotone" dataKey="v" stroke="#20808D" fill="#20808D22" strokeWidth={1.5} dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    {avg7 != null && (
                      <span className="text-xs-tight text-muted-foreground">7d avg {avg7.toFixed(1)}</span>
                    )}
                    {lastDate && (
                      <span className="text-xs-tight text-muted-foreground ml-auto">{lastDate}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Section 2: Trend Charts ── */}
      {topChartTrackers.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1">
            <Activity className="h-3 w-3" /> Trends
          </p>
          <div className="space-y-2">
            {topChartTrackers.map((t: any) => {
              const pf = getPrimaryField(t);
              const chartData = (t.entries || []).slice(-30).map((e: any) => ({
                date: new Date(e.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                value: Number(e.values?.[pf] ?? 0),
              }));
              return (
                <Card key={t.id}>
                  <CardHeader className="py-2 px-3">
                    <CardTitle className="text-xs font-semibold">{t.name}</CardTitle>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 pt-0">
                    <ResponsiveContainer width="100%" height={100}>
                      <LineChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="date" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 9 }} tickLine={false} axisLine={false} width={36} />
                        <Tooltip
                          contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                          formatter={(val: number) => [`${val.toLocaleString(undefined, { maximumFractionDigits: 1 })}${t.unit ? " " + t.unit : ""}`, t.name]}
                        />
                        <Line type="monotone" dataKey="value" stroke="#20808D" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}



      {/* ── Section 3: All Trackers (expandable) ── */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1">
          <HeartPulse className="h-3 w-3" /> All Trackers
        </p>
        <div className="space-y-2">
          {healthTrackers.map((t: any) => {
            const pf = getPrimaryField(t);
            const latest = getLatestValue(t);
            const sortedEntries = [...(t.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            const lastEntry = sortedEntries[0];
            const lastDate = lastEntry ? new Date(lastEntry.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
            const isExpanded = expandedTrackers.has(t.id);
            const isLogging = logOpen === t.id;

            return (
              <Card key={t.id}>
                <CardContent className="p-3">
                  {/* Collapsed header */}
                  <button
                    className="w-full flex items-center justify-between gap-2 text-left"
                    onClick={() => setExpandedTrackers(prev => {
                      const s = new Set(prev);
                      if (s.has(t.id)) s.delete(t.id); else s.add(t.id);
                      return s;
                    })}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{t.name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {t.category && <Badge variant="secondary" className="text-xs-tight py-0">{t.category}</Badge>}
                        <span className="text-xs text-muted-foreground">{t.entries?.length || 0} entries</span>
                        {lastDate && <span className="text-xs text-muted-foreground">· last {lastDate}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {latest != null && (
                        <span className="text-base font-bold tabular-nums">
                          {latest.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                          {t.unit && <span className="text-xs text-muted-foreground ml-0.5 font-normal">{t.unit}</span>}
                        </span>
                      )}
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="mt-3 space-y-3">
                      {/* Last 10 entries */}
                      {sortedEntries.length > 0 ? (
                        <div className="space-y-0">
                          {sortedEntries.slice(0, 10).map((entry: any) => (
                            <div key={entry.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-xs">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono font-semibold tabular-nums">
                                  {entry.values?.[pf] != null
                                    ? `${Number(entry.values[pf]).toLocaleString(undefined, { maximumFractionDigits: 1 })}${t.unit ? ` ${t.unit}` : ""}`
                                    : Object.values(entry.values || {}).filter(Boolean).join(", ") || "—"}
                                </span>
                                {entry.notes && <span className="text-muted-foreground truncate max-w-[100px]" title={entry.notes}>{entry.notes}</span>}
                              </div>
                              <span className="text-xs text-muted-foreground shrink-0 ml-2">
                                {new Date(entry.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground text-center py-2">No entries yet</p>
                      )}

                      {/* Log Entry inline form */}
                      {isLogging ? (
                        <div className="flex flex-col gap-2 p-2 rounded-lg border bg-muted/30">
                          <p className="text-xs font-medium">Log Entry — {t.name}</p>
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              className="h-7 text-xs flex-1"
                              placeholder={`Value${t.unit ? ` (${t.unit})` : ""}`}
                              value={logValue}
                              onChange={e => setLogValue(e.target.value)}
                              autoFocus
                            />
                            <Input
                              type="text"
                              className="h-7 text-xs flex-1"
                              placeholder="Notes (optional)"
                              value={logNotes}
                              onChange={e => setLogNotes(e.target.value)}
                            />
                          </div>
                          <div className="flex gap-1.5">
                            <Button
                              size="sm" className="h-7 text-xs flex-1"
                              disabled={!logValue || logMutation.isPending}
                              onClick={() => {
                                logMutation.mutate({ trackerId: t.id, values: { [pf]: Number(logValue) }, notes: logNotes });
                              }}
                            >
                              {logMutation.isPending ? "Saving..." : "Save"}
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setLogOpen(null); setLogValue(""); setLogNotes(""); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button variant="secondary" size="sm" className="h-7 text-xs w-full gap-1"
                          onClick={() => { setLogOpen(t.id); setLogValue(""); setLogNotes(""); }}>
                          <Plus className="h-3.5 w-3.5" /> Log Entry
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Section 5: AI Health Insights ── */}
      {insights.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1">
            <Sparkles className="h-3 w-3" /> Insights
          </p>
          <div className="space-y-1.5">
            {insights.map(ins => (
              <div key={ins.key} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                ins.level === "warn" ? "border-yellow-500/30 bg-yellow-500/5 text-yellow-700 dark:text-yellow-400" :
                ins.level === "good" ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400" :
                "border-border bg-muted/30 text-muted-foreground"
              }`}>
                {ins.level === "warn" && <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                {ins.level === "good" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                {ins.level === "info" && <Activity className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                <span>{ins.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

function TimelineTab({ timeline }: { timeline: TimelineEntry[] }) {
  const [filter, setFilter] = useState<string>("all");

  const TIMELINE_ICONS: Record<string, any> = {
    tracker: HeartPulse, expense: DollarSign, task: ListTodo,
    event: Calendar, document: FileText, note: FileText,
    habit: Activity, obligation: CreditCard, journal: FileText,
  };

  const typeCounts: Record<string, number> = {};
  for (const e of timeline) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;

  const filtered = filter === "all" ? timeline : timeline.filter(e => e.type === filter);

  // Group by relative date
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const weekAgo = new Date(now.getTime() - 7 * 86400000).getTime();

  const groups: { label: string; items: TimelineEntry[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "This Week", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const e of filtered.slice(0, 50)) {
    const d = e.timestamp.slice(0, 10);
    const t = new Date(e.timestamp).getTime();
    if (d === todayStr) groups[0].items.push(e);
    else if (d === yesterday) groups[1].items.push(e);
    else if (t >= weekAgo) groups[2].items.push(e);
    else groups[3].items.push(e);
  }

  const filterTypes = ["all", ...Object.keys(typeCounts)];

  if (timeline.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No activity yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter buttons */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {filterTypes.map(f => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} className="h-7 text-xs capitalize gap-1"
            onClick={() => setFilter(f)}>
            {f !== "all" && (() => { const FI = TIMELINE_ICONS[f] || Activity; return <FI className="h-3 w-3" />; })()}
            {f === "all" ? "All" : f}
            {f !== "all" && typeCounts[f] && (
              <Badge variant="secondary" className="text-xs-tight h-4 px-1 ml-0.5">{typeCounts[f]}</Badge>
            )}
          </Button>
        ))}
      </div>

      {/* Grouped entries */}
      {groups.filter(g => g.items.length > 0).map(g => (
        <div key={g.label}>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 px-1">{g.label}</p>
          <Card>
            <CardContent className="pt-3 pb-1">
              <div className="divide-y divide-border">
                {g.items.map(entry => (
                  <TimelineItem key={entry.id} entry={entry} />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// TASKS TAB — New standalone tab
// ============================================================

function TasksTab({
  tasks,
  profileId,
  onChanged,
}: {
  tasks: ProfileDetail["relatedTasks"];
  profileId: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [showAddTask, setShowAddTask] = useState(false);
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDesc, setTaskDesc] = useState("");
  const [taskPriority, setTaskPriority] = useState<"low" | "medium" | "high">("medium");
  const [taskDueDate, setTaskDueDate] = useState("");

  const toggleMutation = useMutation({
    mutationFn: async ({ taskId, status, title }: { taskId: string; status: "todo" | "done"; title?: string }) => {
      const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, { status });
      return { ...(await res.json()), _title: title };
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({ title: variables.status === "done" ? `"${variables.title || "Task"}" completed` : `"${variables.title || "Task"}" reopened` });
      onChanged();
    },
    onError: (err: Error, variables) => {
      toast({ title: `Failed to update "${variables.title || "task"}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/tasks", {
        title: taskTitle,
        description: taskDesc || undefined,
        priority: taskPriority,
        dueDate: taskDueDate || undefined,
      });
      const task = await res.json();
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "task", entityId: task.id });
      return task;
    },
    onSuccess: () => {
      const saved = taskTitle;
      toast({ title: `"${saved}" created`, description: taskDueDate ? `Due ${new Date(taskDueDate + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : undefined });
      setShowAddTask(false);
      setTaskTitle(""); setTaskDesc(""); setTaskPriority("medium"); setTaskDueDate("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to create task", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async ({ id, title }: { id: string; title?: string }) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "task", entityId: id });
      return { title };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.title || "Task"}" deleted` });
      setDeleteTaskId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("all");

  const open = tasks.filter(t => t.status !== "done");
  const done = tasks.filter(t => t.status === "done");
  const filtered = taskFilter === "open" ? open : taskFilter === "done" ? done : tasks;

  const PRIORITY_BADGE: Record<string, string> = {
    urgent: "bg-red-600/15 text-red-600 dark:text-red-400 border-red-500/30",
    high: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
    medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    low: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  };

  function statusBadge(status: string) {
    const map: Record<string, string> = {
      todo: "bg-muted text-muted-foreground",
      "in-progress": "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      done: "bg-green-500/10 text-green-600 dark:text-green-400",
      blocked: "bg-red-500/10 text-red-600 dark:text-red-400",
    };
    return map[status] || "bg-muted text-muted-foreground";
  }

  return (
    <div className="space-y-4">
      {/* Header row: filters + add button */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(["all", "open", "done"] as const).map(f => {
            const count = f === "all" ? tasks.length : f === "open" ? open.length : done.length;
            const label = f === "all" ? "All" : f === "open" ? "Open" : "Completed";
            return (
              <button
                key={f}
                onClick={() => setTaskFilter(f)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  taskFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>
        <Button size="sm" className="gap-1.5 h-8 text-xs" onClick={() => { setTaskTitle(""); setTaskDesc(""); setTaskPriority("medium"); setTaskDueDate(""); setShowAddTask(true); }} data-testid="button-add-task">
          <Plus className="h-3.5 w-3.5" /> Add Task
        </Button>
      </div>

      {tasks.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <ListTodo className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No linked tasks</p>
            <p className="text-xs text-muted-foreground mt-1">Add a task above or use chat</p>
          </CardContent>
        </Card>
      )}

      {tasks.length > 0 && filtered.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">No {taskFilter === "open" ? "open" : "completed"} tasks</p>
          </CardContent>
        </Card>
      )}

      {filtered.length > 0 && (
        <Card>
          <CardContent className="space-y-0 p-0">
            {filtered.map(task => {
              const isDone = task.status === "done";
              return (
                <div
                  key={task.id}
                  className={`flex items-start gap-3 py-2.5 px-4 border-b border-border last:border-0 group ${isDone ? "opacity-60" : ""}`}
                  data-testid={`row-task-${task.id}`}
                >
                  <button
                    onClick={() => toggleMutation.mutate({ taskId: task.id, status: isDone ? "todo" : "done", title: task.title })}
                    disabled={toggleMutation.isPending}
                    className="mt-0.5 shrink-0"
                    data-testid={`button-toggle-task-${task.id}`}
                    aria-label={isDone ? "Mark incomplete" : "Mark complete"}
                  >
                    {isDone ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-border hover:border-primary hover:bg-primary/10 transition-colors" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-medium ${isDone ? "line-through text-muted-foreground" : ""}`}>{task.title}</span>
                      {task.priority && (
                        <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium capitalize border ${PRIORITY_BADGE[task.priority] || "bg-muted text-muted-foreground"}`}>
                          {task.priority}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {task.status && !isDone && (
                        <span className={`text-xs rounded-full px-1.5 py-0.5 font-medium capitalize ${statusBadge(task.status)}`}>
                          {task.status.replace("-", " ")}
                        </span>
                      )}
                      {task.dueDate && (
                        <span className={`text-xs flex items-center gap-1 ${new Date(task.dueDate) < new Date() && !isDone ? "text-red-500" : "text-muted-foreground"}`}>
                          <Calendar className="h-3 w-3" />
                          {new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive" onClick={() => setDeleteTaskId(task.id)} data-testid={`button-delete-task-${task.id}`}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Add Task Dialog */}
      <Dialog open={showAddTask} onOpenChange={(open) => {
        setShowAddTask(open);
        if (!open) { setTaskTitle(""); setTaskDesc(""); setTaskPriority("medium"); setTaskDueDate(""); }
      }}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-add-task">
          <DialogHeader>
            <DialogTitle>Add Task</DialogTitle>
            <DialogDescription>Create a new task linked to this profile.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input className="mt-1" value={taskTitle} onChange={e => setTaskTitle(e.target.value)} placeholder="e.g. Schedule vet appointment" data-testid="input-task-title" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
              <Input className="mt-1" value={taskDesc} onChange={e => setTaskDesc(e.target.value)} placeholder="Additional details" data-testid="input-task-desc" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Priority</label>
              <Select value={taskPriority} onValueChange={v => setTaskPriority(v as "low" | "medium" | "high")}>
                <SelectTrigger className="mt-1" data-testid="select-task-priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Due Date (optional)</label>
              <Input className="mt-1" type="date" value={taskDueDate} onChange={e => setTaskDueDate(e.target.value)} data-testid="input-task-due-date" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddTask(false)}>Cancel</Button>
            <Button onClick={() => createTaskMutation.mutate()} disabled={createTaskMutation.isPending || !taskTitle} data-testid="button-save-task">
              {createTaskMutation.isPending ? "Creating..." : "Add Task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Task Confirmation */}
      <AlertDialog open={!!deleteTaskId} onOpenChange={() => setDeleteTaskId(null)}>
        <AlertDialogContent data-testid="dialog-confirm-delete-task">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Task?</AlertDialogTitle>
            <AlertDialogDescription>This task will be permanently deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTaskId) { const t = tasks.find(x => x.id === deleteTaskId); deleteTaskMutation.mutate({ id: deleteTaskId, title: t?.title }); } }}
              disabled={deleteTaskMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-task"
            >
              {deleteTaskMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================
// EDIT PROFILE DIALOG
// ============================================================

function EditProfileDialog({
  open,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  profile: ProfileDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(profile.name);
  const [notes, setNotes] = useState(profile.notes || "");
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile.fields)) {
      if (v != null && typeof v !== "object") result[k] = String(v);
    }
    return result;
  });

  const validateFields = (): boolean => {
    const emailKeys = Object.keys(fields).filter(k => k.toLowerCase().includes("email"));
    for (const key of emailKeys) {
      if (fields[key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields[key])) {
        toast({ title: "Invalid email", description: `Enter a valid email address for ${key}`, variant: "destructive" });
        return false;
      }
    }
    const phoneKeys = Object.keys(fields).filter(k => k.toLowerCase().includes("phone"));
    for (const key of phoneKeys) {
      if (fields[key] && !/^\+?[\d\s()-]{7,15}$/.test(fields[key])) {
        toast({ title: "Invalid phone", description: `Enter a valid phone number for ${key}`, variant: "destructive" });
        return false;
      }
    }
    if (!name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return false;
    }
    return true;
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!validateFields()) throw new Error("Validation failed");
      const parsedFields: Record<string, any> = {};
      for (const [k, v] of Object.entries(fields)) {
        const num = Number(v);
        parsedFields[k] = v !== "" && !isNaN(num) && v.trim() !== "" ? num : v;
      }
      const res = await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        name,
        notes,
        fields: { ...profile.fields, ...parsedFields },
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: `"${name}" updated` });
      onSaved();
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: `Failed to update "${name}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  // Type-specific suggested fields that should always be available for editing
  const SUGGESTED_FIELDS: Record<string, { key: string; label: string; placeholder: string }[]> = {
    pet: [
      { key: "species", label: "Species", placeholder: "Dog, Cat, Bird..." },
      { key: "breed", label: "Breed", placeholder: "Golden Retriever, Tabby..." },
      { key: "age", label: "Age", placeholder: "3 years" },
      { key: "weight", label: "Weight", placeholder: "45 lbs" },
      { key: "color", label: "Color", placeholder: "Golden, Black..." },
      { key: "vet", label: "Vet", placeholder: "Dr. Smith" },
      { key: "microchipId", label: "Microchip ID", placeholder: "" },
      { key: "birthday", label: "Birthday", placeholder: "YYYY-MM-DD" },
    ],
    vehicle: [
      { key: "make", label: "Make", placeholder: "Honda, Toyota..." },
      { key: "model", label: "Model", placeholder: "CR-V, Camry..." },
      { key: "year", label: "Year", placeholder: "2021" },
      { key: "color", label: "Color", placeholder: "White, Black..." },
      { key: "VIN", label: "VIN", placeholder: "" },
      { key: "licensePlate", label: "License Plate", placeholder: "" },
      { key: "mileage", label: "Mileage", placeholder: "45,000" },
      { key: "registrationExpiration", label: "Registration Exp.", placeholder: "YYYY-MM-DD" },
    ],
    person: [
      { key: "email", label: "Email", placeholder: "" },
      { key: "phone", label: "Phone", placeholder: "" },
      { key: "birthday", label: "Birthday", placeholder: "YYYY-MM-DD" },
      { key: "address", label: "Address", placeholder: "" },
      { key: "relationship", label: "Relationship", placeholder: "Spouse, Parent, Friend..." },
    ],
    self: [
      { key: "email", label: "Email", placeholder: "" },
      { key: "phone", label: "Phone", placeholder: "" },
      { key: "birthday", label: "Birthday", placeholder: "YYYY-MM-DD" },
      { key: "address", label: "Address", placeholder: "" },
      { key: "bloodType", label: "Blood Type", placeholder: "A+, O-..." },
      { key: "height", label: "Height", placeholder: "5'10\"" },
      { key: "emergencyContact", label: "Emergency Contact", placeholder: "" },
    ],
    subscription: [
      { key: "cost", label: "Monthly Cost", placeholder: "9.99" },
      { key: "frequency", label: "Billing Cycle", placeholder: "monthly, yearly" },
      { key: "renewalDate", label: "Next Billing", placeholder: "YYYY-MM-DD" },
      { key: "status", label: "Status", placeholder: "active, paused, canceled" },
      { key: "plan", label: "Plan", placeholder: "Premium, Basic..." },
      { key: "category", label: "Category", placeholder: "entertainment, utilities..." },
      { key: "paymentMethod", label: "Payment Method", placeholder: "Visa *1234" },
    ],
    property: [
      { key: "address", label: "Address", placeholder: "" },
      { key: "sqft", label: "Square Feet", placeholder: "1,500" },
      { key: "bedrooms", label: "Bedrooms", placeholder: "3" },
      { key: "bathrooms", label: "Bathrooms", placeholder: "2" },
      { key: "yearBuilt", label: "Year Built", placeholder: "1995" },
      { key: "purchaseDate", label: "Purchase Date", placeholder: "YYYY-MM-DD" },
      { key: "purchasePrice", label: "Purchase Price", placeholder: "" },
    ],
    loan: [
      { key: "lender", label: "Lender", placeholder: "" },
      { key: "principal", label: "Principal", placeholder: "" },
      { key: "interestRate", label: "Interest Rate", placeholder: "4.5%" },
      { key: "monthlyPayment", label: "Monthly Payment", placeholder: "" },
      { key: "startDate", label: "Start Date", placeholder: "YYYY-MM-DD" },
      { key: "endDate", label: "End Date", placeholder: "YYYY-MM-DD" },
    ],
    asset: [
      { key: "assetSubtype", label: "Asset Type", placeholder: "high_value_item, bank_account, credit_card, digital_asset, business, collectible, loan_receivable" },
      { key: "brand", label: "Brand", placeholder: "Apple, Samsung..." },
      { key: "model", label: "Model", placeholder: "" },
      { key: "purchaseDate", label: "Purchase Date", placeholder: "YYYY-MM-DD" },
      { key: "purchasePrice", label: "Purchase Price", placeholder: "" },
      { key: "currentValue", label: "Current Value", placeholder: "" },
      { key: "serialNumber", label: "Serial #", placeholder: "" },
    ],
  };

  // Merge existing fields + suggested fields for this type
  const existingFieldKeys = Object.entries(profile.fields)
    .filter(([_, v]) => v != null && typeof v !== "object")
    .map(([k]) => k);
  const suggested = SUGGESTED_FIELDS[profile.type] || [];
  const allFieldKeys = [...new Set([...existingFieldKeys, ...suggested.map(s => s.key)])];
  // Initialize fields state with suggested fields that are empty
  for (const sf of suggested) {
    if (!(sf.key in fields)) fields[sf.key] = "";
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-edit-profile">
        <DialogHeader>
          <DialogTitle>Edit {profile.type === "self" ? "My Profile" : profile.name}</DialogTitle>
          <DialogDescription className="capitalize">{profile.type} profile</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input
              className="mt-1"
              value={name}
              onChange={e => setName(e.target.value)}
              data-testid="input-profile-name"
            />
          </div>
          {allFieldKeys.filter(k => !k.startsWith("_")).map(key => {
            const sg = suggested.find(s => s.key === key);
            return (
              <div key={key}>
                <label className="text-xs font-medium text-muted-foreground">{sg?.label || formatKey(key)}</label>
                <Input
                  className="mt-1"
                  value={fields[key] ?? ""}
                  placeholder={sg?.placeholder || ""}
                  onChange={e => setFields(prev => ({ ...prev, [key]: e.target.value }))}
                  data-testid={`input-field-${key}`}
                />
              </div>
            );
          })}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <Input
              className="mt-1"
              value={notes}
              placeholder="Any additional notes..."
              onChange={e => setNotes(e.target.value)}
              data-testid="input-profile-notes"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-edit-profile">Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} data-testid="button-save-profile">
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// TYPE-SPECIFIC TABS DEFINITION
// ============================================================

// Type-specific tab configurations — each profile type gets its own relevant tabs
type TabDef = { value: string; label: string; testId: string };

// Context-aware tab configs — each profile type gets tabs that reflect its life, not a generic database
const ENTITY_TABS: Record<string, TabDef[]> = {
  // Person / Self — full life hub
  person: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "health", label: "Health", testId: "tab-health" },
    { value: "all-trackers", label: "Trackers", testId: "tab-all-trackers" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "finances", label: "Finance", testId: "tab-finances" },
    { value: "tasks", label: "Goals & Tasks", testId: "tab-tasks" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  self: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "health", label: "Health", testId: "tab-health" },
    { value: "all-trackers", label: "Trackers", testId: "tab-all-trackers" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "finances", label: "Finance", testId: "tab-finances" },
    { value: "tasks", label: "Goals & Tasks", testId: "tab-tasks" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Pet — health + care focused
  pet: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "health", label: "Health & Vet", testId: "tab-health" },
    { value: "all-trackers", label: "Trackers", testId: "tab-all-trackers" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "tasks", label: "Reminders", testId: "tab-tasks" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
  ],
  // Vehicle — maintenance + cost focused
  vehicle: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "loan-detail", label: "Loan", testId: "tab-loan" },
    { value: "tasks", label: "Maintenance", testId: "tab-tasks" },
    { value: "finances", label: "Costs", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "History", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Loan — payment focused
  loan: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "loan-detail", label: "Loan", testId: "tab-loan" },
    { value: "finances", label: "Payments", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "History", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Investment
  investment: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Performance", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "History", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Subscription
  subscription: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "billing", label: "Billing", testId: "tab-billing" },
    { value: "impact", label: "Impact", testId: "tab-impact" },
    { value: "details", label: "Details", testId: "tab-details" },
  ],
  // Medical provider
  medical: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "health", label: "Records", testId: "tab-health" },
    { value: "finances", label: "Billing", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Visits", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Property / Home
  property: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "loan-detail", label: "Loan", testId: "tab-loan" },
    { value: "finances", label: "Costs", testId: "tab-finances" },
    { value: "tasks", label: "Maintenance", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "History", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Asset (laptop, device, etc.)
  asset: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Costs", testId: "tab-finances" },
    { value: "tasks", label: "Maintenance", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "History", testId: "tab-timeline" },
  ],
  // Account
  account: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Transactions", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "History", testId: "tab-timeline" },
  ],
};

// Fallback for any type not explicitly defined
const DEFAULT_TABS: TabDef[] = [
  { value: "info", label: "Overview", testId: "tab-info" },
  { value: "finances", label: "Finance", testId: "tab-finances" },
  { value: "trackers", label: "Documents", testId: "tab-trackers" },
  { value: "activity", label: "Activity", testId: "tab-activity" },
  { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  { value: "notes", label: "Notes", testId: "tab-notes" },
];

// ── Asset subtype tab configs ──
const ASSET_SUBTYPE_TABS: Record<string, TabDef[]> = {
  bank_account: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Transactions", testId: "tab-finances" },
    { value: "linked-subs", label: "Subscriptions", testId: "tab-linked-subs" },
    { value: "trackers", label: "Statements", testId: "tab-trackers" },
    { value: "insights", label: "Insights", testId: "tab-insights" },
  ],
  credit_card: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Transactions", testId: "tab-finances" },
    { value: "payments", label: "Payments", testId: "tab-payments" },
    { value: "rewards", label: "Rewards", testId: "tab-rewards" },
    { value: "trackers", label: "Statements", testId: "tab-trackers" },
  ],
  digital_asset: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "access", label: "Access", testId: "tab-access" },
    { value: "billing", label: "Billing", testId: "tab-billing" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  business: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Financials", testId: "tab-finances" },
    { value: "tasks", label: "Operations", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "insights", label: "Insights", testId: "tab-insights" },
  ],
  collectible: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "valuation", label: "Valuation", testId: "tab-valuation" },
    { value: "finances", label: "History", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
  ],
  loan_receivable: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "loan-detail", label: "Amortization", testId: "tab-loan" },
    { value: "finances", label: "Payments", testId: "tab-finances" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  high_value_item: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "warranty", label: "Warranty", testId: "tab-warranty" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
  ],
};

// ─── Loan Tab ─────────────────────────────────────────────────────────
function LoanTab({ profile, obligations }: { profile: any; obligations: any[] }) {
  const { toast } = useToast();
  // Normalized field access — check all possible field names
  const loanBalance = Number(profile.fields?.originalAmount || profile.fields?.loanBalance || profile.fields?.remainingBalance || profile.fields?.balance || 0);
  const interestRate = Number(profile.fields?.interestRate || profile.fields?.rate || profile.fields?.apr || 0);
  const monthlyPayment = Number(profile.fields?.monthlyPayment || 0);
  const termMonths = Number(profile.fields?.termMonths || profile.fields?.loanTerm || profile.fields?.term || 0);
  const lender = profile.fields?.lender || "";
  const startDate = profile.fields?.loanStartDate || profile.fields?.startDate || profile.fields?.purchaseDate || "";

  const hasLoanData = loanBalance > 0 || interestRate > 0 || monthlyPayment > 0;

  // Payoff calculator state — must be at component top level (hook rule)
  const [extraPmt, setExtraPmt] = useState(0);

  // Inline edit form state
  const [editing, setEditing] = useState(false);
  const [formBalance, setFormBalance] = useState(String(loanBalance || ""));
  const [formRate, setFormRate] = useState(String(interestRate || ""));
  const [formTerm, setFormTerm] = useState(String(termMonths || ""));
  const [formPayment, setFormPayment] = useState(String(monthlyPayment || ""));
  const [formLender, setFormLender] = useState(lender);
  const [formStartDate, setFormStartDate] = useState(startDate);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const fields: Record<string, any> = {};
      if (formBalance) fields.originalAmount = formBalance;
      if (formBalance) fields.loanBalance = formBalance;
      if (formRate) fields.interestRate = formRate;
      if (formTerm) fields.termMonths = formTerm;
      if (formPayment) fields.monthlyPayment = formPayment;
      if (formLender) fields.lender = formLender;
      if (formStartDate) fields.loanStartDate = formStartDate;
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields });
    },
    onSuccess: () => {
      toast({ title: "Loan details saved" });
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" }),
  });
  const clearLoanMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields: { originalAmount: null, loanBalance: null, interestRate: null, termMonths: null, monthlyPayment: null, lender: null, loanStartDate: null } });
    },
    onSuccess: () => { toast({ title: "Loan data cleared" }); queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/profiles"] }); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  // Derive term from monthly payment if not provided
  const derivedTermLocal = termMonths || (() => {
    if (!loanBalance || !interestRate || !monthlyPayment) return 0;
    const r = interestRate / 100 / 12;
    if (r === 0) return Math.round(loanBalance / monthlyPayment);
    return Math.round(-Math.log(1 - (loanBalance * r) / monthlyPayment) / Math.log(1 + r));
  })();

  // Calculate amortization schedule
  const schedule: { month: number; payment: number; principal: number; interest: number; balance: number }[] = [];
  if (loanBalance > 0 && interestRate > 0 && derivedTermLocal > 0) {
    const monthlyRate = interestRate / 100 / 12;
    const calcPayment = monthlyRate === 0
      ? loanBalance / derivedTermLocal
      : loanBalance * (monthlyRate * Math.pow(1 + monthlyRate, derivedTermLocal)) / (Math.pow(1 + monthlyRate, derivedTermLocal) - 1);
    let remaining = loanBalance;
    for (let month = 1; month <= derivedTermLocal && remaining > 0.005; month++) {
      const interestCharge = remaining * monthlyRate;
      const principalPaid = Math.min(calcPayment - interestCharge, remaining);
      remaining = Math.max(0, remaining - principalPaid);
      schedule.push({
        month,
        payment: Math.round((principalPaid + interestCharge) * 100) / 100,
        principal: Math.round(principalPaid * 100) / 100,
        interest: Math.round(interestCharge * 100) / 100,
        balance: Math.round(remaining * 100) / 100,
      });
    }
  }

  const totalInterest = schedule.reduce((s, r) => s + r.interest, 0);
  const totalCost = loanBalance + totalInterest;
  const payoffDate = schedule.length > 0 ? (() => {
    const d = new Date(startDate || new Date());
    d.setMonth(d.getMonth() + schedule.length);
    return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  })() : null;

  // Linked obligations (existing payments)
  const linkedObs = obligations.filter((o: any) =>
    o.linkedProfiles?.includes(profile.id) || o.name?.toLowerCase().includes(profile.name?.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {/* Inline edit form / KPIs */}
      {editing || !hasLoanData ? (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold">{hasLoanData ? "Edit Loan Details" : "Add Loan Details"}</h3>
            {hasLoanData && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)} data-testid="button-cancel-loan-edit">
                Cancel
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Loan Balance ($)</label>
              <Input
                type="number" placeholder="e.g. 25000" value={formBalance}
                onChange={e => setFormBalance(e.target.value)}
                data-testid="input-loan-balance"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Interest Rate (%)</label>
              <Input
                type="number" step="0.01" placeholder="e.g. 5.5" value={formRate}
                onChange={e => setFormRate(e.target.value)}
                data-testid="input-loan-rate"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Term (months)</label>
              <Input
                type="number" placeholder="e.g. 60" value={formTerm}
                onChange={e => setFormTerm(e.target.value)}
                data-testid="input-loan-term"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Monthly Payment ($)</label>
              <Input
                type="number" step="0.01" placeholder="e.g. 477" value={formPayment}
                onChange={e => setFormPayment(e.target.value)}
                data-testid="input-loan-payment"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Lender</label>
              <Input
                placeholder="e.g. Chase" value={formLender}
                onChange={e => setFormLender(e.target.value)}
                data-testid="input-loan-lender"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Start Date</label>
              <Input
                type="date" value={formStartDate}
                onChange={e => setFormStartDate(e.target.value)}
                data-testid="input-loan-start-date"
              />
            </div>
          </div>
          <Button
            size="sm" className="w-full mt-3 h-8 text-xs"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || (!formBalance && !formRate)}
            data-testid="button-save-loan-details"
          >
            {saveMutation.isPending ? "Saving..." : "Save Loan Details"}
          </Button>
        </Card>
      ) : (
        <>
          {/* Loan Summary KPIs */}
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-muted-foreground">Loan Summary</h3>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => {
                setFormBalance(String(loanBalance || ""));
                setFormRate(String(interestRate || ""));
                setFormTerm(String(termMonths || ""));
                setFormPayment(String(monthlyPayment || ""));
                setFormLender(lender);
                setFormStartDate(startDate);
                setEditing(true);
              }} data-testid="button-edit-loan">
                <Pencil className="h-3 w-3" /> Edit
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-destructive hover:text-destructive" onClick={() => clearLoanMutation.mutate()} disabled={clearLoanMutation.isPending} data-testid="button-clear-loan">
                <Trash2 className="h-3 w-3" /> {clearLoanMutation.isPending ? "Clearing..." : "Clear"}
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Card className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Balance</p>
              <p className="text-sm font-bold tabular-nums">{formatCurrency(loanBalance)}</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Rate</p>
              <p className="text-sm font-bold tabular-nums">{interestRate}%</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Monthly</p>
              <p className="text-sm font-bold tabular-nums">{formatCurrency(monthlyPayment)}</p>
            </Card>
            <Card className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Payoff</p>
              <p className="text-sm font-bold tabular-nums">{payoffDate || "—"}</p>
            </Card>
          </div>
        </>
      )}

      {/* Payoff Summary */}
      {schedule.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold mb-2">Payoff Summary</h3>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-xs text-muted-foreground">Total Interest</p>
              <p className="text-sm font-bold text-red-400">{formatCurrency(totalInterest)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Cost</p>
              <p className="text-sm font-bold">{formatCurrency(totalCost)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Months Left</p>
              <p className="text-sm font-bold">{schedule.length}</p>
            </div>
          </div>
          {/* Progress bar */}
          <div className="mt-3">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Paid off</span>
              <span>{derivedTermLocal > 0 ? `${Math.round((1 - schedule.length / derivedTermLocal) * 100)}%` : "—"}</span>
            </div>
            <Progress value={derivedTermLocal > 0 ? Math.round((1 - schedule.length / derivedTermLocal) * 100) : 0} className="h-2" />
          </div>
        </Card>
      )}

      {/* Visual Charts */}
      {schedule.length > 0 && (() => {
        // Sample every N months so chart isn't too dense (max ~24 points)
        const step = Math.max(1, Math.floor(schedule.length / 24));
        const chartData = schedule
          .filter((_, i) => i % step === 0 || i === schedule.length - 1)
          .map(r => ({
            month: r.month,
            balance: Math.round(r.balance),
            principal: Math.round(r.principal),
            interest: Math.round(r.interest),
          }));
        const pieData2 = [
          { name: 'Principal', value: Math.round(loanBalance) },
          { name: 'Total Interest', value: Math.round(totalInterest) },
        ];
        const COLORS2 = ['#10b981', '#ef4444'];
        return (
          <>
            {/* Balance paydown + P/I split */}
            <Card className="p-4">
              <h3 className="text-xs font-semibold mb-3">Balance Paydown</h3>
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="lgBal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '11px' }}
                    formatter={(v: any) => [`$${Number(v).toLocaleString()}`, 'Balance']}
                  />
                  <Area type="monotone" dataKey="balance" stroke="#3b82f6" fill="url(#lgBal)" strokeWidth={2} name="Balance" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            {/* Principal vs Interest per payment stacked bar */}
            <Card className="p-4">
              <h3 className="text-xs font-semibold mb-1">Principal vs Interest Per Payment</h3>
              <p className="text-[10px] text-muted-foreground mb-3">Green = principal paid · Red = interest charged</p>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '11px' }}
                    formatter={(v: any, n: string) => [`$${Number(v).toFixed(0)}`, n]}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="principal" name="Principal" fill="#10b981" stackId="a" radius={[0,0,0,0]} />
                  <Bar dataKey="interest" name="Interest" fill="#ef4444" stackId="a" radius={[3,3,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            {/* Principal vs Total Interest donut */}
            <Card className="p-4">
              <div className="flex items-center gap-4">
                <ResponsiveContainer width={120} height={120}>
                  <PieChart>
                    <Pie data={pieData2} cx="50%" cy="50%" innerRadius={30} outerRadius={50} paddingAngle={3} dataKey="value">
                      {pieData2.map((_, i) => <Cell key={i} fill={COLORS2[i % COLORS2.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '11px' }} formatter={(v: any) => `$${Number(v).toLocaleString()}`} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  <div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-green-500 shrink-0" /><span className="text-xs">Principal</span></div>
                    <p className="text-sm font-bold tabular-nums ml-4">{formatCurrency(loanBalance)}</p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-red-500 shrink-0" /><span className="text-xs">Total Interest</span></div>
                    <p className="text-sm font-bold tabular-nums text-red-400 ml-4">{formatCurrency(totalInterest)}</p>
                  </div>
                  <div className="pt-1 border-t border-border/40">
                    <p className="text-xs text-muted-foreground">Total Cost</p>
                    <p className="text-sm font-bold tabular-nums">{formatCurrency(totalCost)}</p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Extra Payment Calculator */}
            {loanBalance > 0 && interestRate > 0 && (() => {
              function simPayoff(extra: number) {
                const r = interestRate / 100 / 12;
                const base = schedule.length > 0 ? schedule[0].payment : monthlyPayment;
                const pmt = base + extra;
                let bal = loanBalance; let months = 0; let totInt = 0;
                while (bal > 0.005 && months < 1200) {
                  const intCharge = bal * r; const prin = Math.min(pmt - intCharge, bal);
                  bal -= prin; totInt += intCharge; months++;
                }
                return { months, totInt };
              }
              const base = simPayoff(0);
              const extra = simPayoff(extraPmt);
              const saved = Math.max(0, base.months - extra.months);
              const intSaved = Math.max(0, base.totInt - extra.totInt);
              return (
                <Card className="p-4">
                  <h3 className="text-xs font-semibold mb-3">Payoff Calculator</h3>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Extra monthly payment</span>
                      <span className="text-sm font-bold text-primary">${extraPmt}/mo</span>
                    </div>
                    <input
                      type="range" min={0} max={Math.round(monthlyPayment || 500)} step={25}
                      value={extraPmt}
                      onChange={e => setExtraPmt(Number(e.target.value))}
                      className="w-full accent-primary"
                    />
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div className="rounded-xl bg-green-500/8 border border-green-500/20 p-3 text-center">
                        <p className="text-[10px] text-muted-foreground mb-1">Months saved</p>
                        <p className="text-xl font-bold text-green-500">{saved}</p>
                        <p className="text-[9px] text-muted-foreground">Pay off {extra.months > 0 ? (() => { const d = new Date(new Date(startDate || new Date()).getTime()); d.setMonth(d.getMonth() + extra.months); return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); })() : '—'}</p>
                      </div>
                      <div className="rounded-xl bg-red-500/8 border border-red-500/20 p-3 text-center">
                        <p className="text-[10px] text-muted-foreground mb-1">Interest saved</p>
                        <p className="text-lg font-bold text-red-400">{formatCurrency(intSaved)}</p>
                        <p className="text-[9px] text-muted-foreground">Total left: {formatCurrency(extra.totInt)}</p>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })()}
          </>
        );
      })()}

      {/* Amortization Schedule (first 12 + last 3) */}
      {schedule.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold mb-2">Amortization Schedule</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-1 pr-2">#</th>
                  <th className="text-right py-1 px-2">Payment</th>
                  <th className="text-right py-1 px-2">Principal</th>
                  <th className="text-right py-1 px-2">Interest</th>
                  <th className="text-right py-1 pl-2">Balance</th>
                </tr>
              </thead>
              <tbody>
                {schedule.slice(0, 12).map(row => (
                  <tr key={row.month} className="border-b border-border/30">
                    <td className="py-1 pr-2 text-muted-foreground">{row.month}</td>
                    <td className="text-right py-1 px-2">{formatCurrency(row.payment)}</td>
                    <td className="text-right py-1 px-2 text-green-500">{formatCurrency(row.principal)}</td>
                    <td className="text-right py-1 px-2 text-red-400">{formatCurrency(row.interest)}</td>
                    <td className="text-right py-1 pl-2 font-medium">{formatCurrency(row.balance)}</td>
                  </tr>
                ))}
                {schedule.length > 15 && (
                  <tr><td colSpan={5} className="text-center py-2 text-muted-foreground">... {schedule.length - 15} more months ...</td></tr>
                )}
                {schedule.length > 12 && schedule.slice(-3).map(row => (
                  <tr key={row.month} className="border-b border-border/30">
                    <td className="py-1 pr-2 text-muted-foreground">{row.month}</td>
                    <td className="text-right py-1 px-2">{formatCurrency(row.payment)}</td>
                    <td className="text-right py-1 px-2 text-green-500">{formatCurrency(row.principal)}</td>
                    <td className="text-right py-1 px-2 text-red-400">{formatCurrency(row.interest)}</td>
                    <td className="text-right py-1 pl-2 font-medium">{formatCurrency(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Linked Obligations */}
      {linkedObs.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold mb-2">Linked Payments</h3>
          <div className="space-y-2">
            {linkedObs.map((ob: any) => (
              <div key={ob.id} className="flex items-center justify-between text-xs">
                <span>{ob.name}</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium">${ob.amount}/mo</span>
                  <Badge variant="outline" className="text-xs-tight">{ob.frequency}</Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// ASSET SUBTYPE TAB COMPONENTS
// ============================================================

function WarrantyTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const f = profile.fields || {};
  const endDate = f.warrantyEndDate || f.warranty;
  const isActive = endDate ? new Date(endDate) > new Date() : false;
  const claims = (profile.relatedExpenses || []).filter((e: any) => (e.category || "").toLowerCase().includes("warranty"));
  const [showAdd, setShowAdd] = useState(false);
  const [claimDesc, setClaimDesc] = useState("");
  const [claimAmt, setClaimAmt] = useState("");
  const [claimDate, setClaimDate] = useState(new Date().toISOString().slice(0, 10));
  const addClaimMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/expenses", { description: claimDesc || "Warranty Claim", amount: Number(claimAmt), date: claimDate, category: "warranty_claim", linkedProfiles: [profileId] });
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); setShowAdd(false); setClaimDesc(""); setClaimAmt(""); onChanged(); },
  });
  const deleteClaimMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); onChanged(); },
  });
  const warrantyFields = [
    { key: "warrantyEndDate", label: "Warranty Until" },
    { key: "warrantyProvider", label: "Provider" },
    { key: "coverageType", label: "Coverage" },
    { key: "protectionPlan", label: "Protection Plan" },
    { key: "purchaseDate", label: "Purchase Date" },
    { key: "purchasePrice", label: "Purchase Price" },
  ];
  return (
    <div className="space-y-3" data-testid="warranty-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Warranty Status</span>
            <Badge variant={isActive ? "default" : "destructive"} className="text-xs">
              {isActive ? "Active" : endDate ? "Expired" : "Unknown"}
            </Badge>
          </div>
          {warrantyFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Warranty Claims ({claims.length})</p>
            {!showAdd && <Button variant="outline" size="sm" className="h-6 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-claim"><Plus className="h-3 w-3" />Add Claim</Button>}
          </div>
          {showAdd && (
            <div className="flex items-center gap-2 mb-2">
              <Input className="h-7 text-xs flex-1" placeholder="Description" value={claimDesc} onChange={e => setClaimDesc(e.target.value)} data-testid="input-claim-desc" />
              <Input className="h-7 text-xs w-20" placeholder="Amount" value={claimAmt} onChange={e => setClaimAmt(e.target.value)} data-testid="input-claim-amount" />
              <Input className="h-7 text-xs w-28" type="date" value={claimDate} onChange={e => setClaimDate(e.target.value)} data-testid="input-claim-date" />
              <Button size="sm" className="h-7 text-xs px-2" onClick={() => addClaimMutation.mutate()} disabled={addClaimMutation.isPending} data-testid="button-save-claim">Save</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs px-1" onClick={() => setShowAdd(false)} data-testid="button-cancel-claim">✕</Button>
            </div>
          )}
          {claims.length > 0 ? claims.map((c: any) => (
            <div key={c.id} className="group flex justify-between items-center py-1.5 border-b border-border/30 last:border-0">
              <span className="text-xs">{c.description || "Claim"}</span>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{c.amount ? formatCurrency(Number(c.amount)) : "—"}</span>
                <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => deleteClaimMutation.mutate(c.id)} data-testid={`button-delete-claim-${c.id}`}><Trash2 className="h-3 w-3 text-destructive" /></button>
              </div>
            </div>
          )) : !showAdd && <p className="text-xs text-muted-foreground text-center py-2">No claims recorded</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function RewardsTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const f = profile.fields || {};
  const rewardsFields = [
    { key: "rewardsType", label: "Rewards Type" },
    { key: "rewardsBalance", label: "Rewards Balance" },
    { key: "pointsPerDollar", label: "Points per Dollar" },
  ];
  const balance = Number(f.rewardsBalance) || 0;
  const ppd = Number(f.pointsPerDollar) || 1;
  const redemptionValue = ppd > 0 ? (balance / (ppd * 100)).toFixed(2) : "0.00";
  const redemptions = (profile.relatedExpenses || []).filter((e: any) => (e.category || "").toLowerCase().includes("reward") || (e.category || "").toLowerCase().includes("redemption"));
  const [showAdd, setShowAdd] = useState(false);
  const [redDesc, setRedDesc] = useState("");
  const [redPts, setRedPts] = useState("");
  const [redDate, setRedDate] = useState(new Date().toISOString().slice(0, 10));
  const addRedemptionMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/expenses", { description: redDesc || "Rewards Redemption", amount: Number(redPts), date: redDate, category: "rewards_redemption", linkedProfiles: [profileId] });
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); setShowAdd(false); setRedDesc(""); setRedPts(""); onChanged(); },
  });
  const deleteRedemptionMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); onChanged(); },
  });
  return (
    <div className="space-y-3" data-testid="rewards-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Rewards Program</p>
          {rewardsFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
          {balance > 0 && (
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/30">
              <span className="text-xs text-muted-foreground">Est. Redemption Value</span>
              <span className="text-sm font-bold text-green-600">${redemptionValue}</span>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Redemptions ({redemptions.length})</p>
            {!showAdd && <Button variant="outline" size="sm" className="h-6 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-redemption"><Plus className="h-3 w-3" />Record Redemption</Button>}
          </div>
          {showAdd && (
            <div className="flex items-center gap-2 mb-2">
              <Input className="h-7 text-xs flex-1" placeholder="Description" value={redDesc} onChange={e => setRedDesc(e.target.value)} data-testid="input-redemption-desc" />
              <Input className="h-7 text-xs w-20" placeholder="Points" value={redPts} onChange={e => setRedPts(e.target.value)} data-testid="input-redemption-points" />
              <Input className="h-7 text-xs w-28" type="date" value={redDate} onChange={e => setRedDate(e.target.value)} data-testid="input-redemption-date" />
              <Button size="sm" className="h-7 text-xs px-2" onClick={() => addRedemptionMutation.mutate()} disabled={addRedemptionMutation.isPending} data-testid="button-save-redemption">Save</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs px-1" onClick={() => setShowAdd(false)} data-testid="button-cancel-redemption">✕</Button>
            </div>
          )}
          {redemptions.length > 0 ? redemptions.map((r: any) => (
            <div key={r.id} className="group flex justify-between items-center py-1.5 border-b border-border/30 last:border-0">
              <div className="min-w-0 flex-1">
                <span className="text-xs">{r.description || "Redemption"}</span>
                <span className="text-xs text-muted-foreground ml-2">{r.date ? new Date(r.date).toLocaleDateString() : ""}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium tabular-nums">{r.amount ? formatCurrency(Number(r.amount)) : "—"}</span>
                <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => deleteRedemptionMutation.mutate(r.id)} data-testid={`button-delete-redemption-${r.id}`}><Trash2 className="h-3 w-3 text-destructive" /></button>
              </div>
            </div>
          )) : !showAdd && <p className="text-xs text-muted-foreground text-center py-2">No redemptions recorded</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function AccessTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const f = profile.fields || {};
  const [showApiKey, setShowApiKey] = useState(false);
  const accessFields = [
    { key: "loginUrl", label: "Login URL" },
    { key: "username", label: "Username" },
    { key: "registrar", label: "Registrar" },
    { key: "hostingProvider", label: "Hosting" },
    { key: "dnsProvider", label: "DNS Provider" },
  ];
  return (
    <div className="space-y-3" data-testid="access-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Access & Credentials</p>
          {f.loginUrl && (
            <div className="flex items-center justify-between py-2 border-b border-border/30">
              <span className="text-xs text-muted-foreground">Login URL</span>
              <a href={String(f.loginUrl).startsWith("http") ? String(f.loginUrl) : `https://${f.loginUrl}`} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-primary hover:underline flex items-center gap-1" data-testid="link-login-url">
                {String(f.loginUrl).replace(/^https?:\/\//, "").slice(0, 30)}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          {accessFields.filter(af => af.key !== "loginUrl").map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
          {f.apiKey && (
            <div className="flex items-center justify-between py-2 border-b border-border/30">
              <span className="text-xs text-muted-foreground">API Key</span>
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono">{showApiKey ? String(f.apiKey) : "••••••••••••"}</span>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => setShowApiKey(!showApiKey)} data-testid="button-toggle-apikey">
                  <Eye className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
          {!f.loginUrl && (
            <GroupedInlineField profileId={profileId} fieldKey="loginUrl" label="Login URL" value={f.loginUrl} onSaved={onChanged} />
          )}
          <GroupedInlineField profileId={profileId} fieldKey="apiKey" label="API Key" value={f.apiKey} onSaved={onChanged} />
        </CardContent>
      </Card>
      <CredentialsList profileId={profileId} fields={f} onChanged={onChanged} />
    </div>
  );
}

function CredentialsList({ profileId, fields, onChanged }: { profileId: string; fields: any; onChanged: () => void }) {
  const credentials: { label: string; username: string; url: string }[] = (() => { try { return Array.isArray(fields.credentials) ? fields.credentials : JSON.parse(fields.credentials || "[]"); } catch { return []; } })();
  const [showAdd, setShowAdd] = useState(false);
  const [cLabel, setCLabel] = useState("");
  const [cUser, setCUser] = useState("");
  const [cUrl, setCUrl] = useState("");
  const saveMutation = useMutation({
    mutationFn: async (updatedCreds: any[]) => { await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { ...fields, credentials: updatedCreds } }); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); onChanged(); },
  });
  const handleAdd = () => { saveMutation.mutate([...credentials, { label: cLabel, username: cUser, url: cUrl }]); setShowAdd(false); setCLabel(""); setCUser(""); setCUrl(""); };
  const handleDelete = (idx: number) => { saveMutation.mutate(credentials.filter((_, i) => i !== idx)); };
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Saved Credentials ({credentials.length})</p>
          {!showAdd && <Button variant="outline" size="sm" className="h-6 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-credential"><Plus className="h-3 w-3" />Add Credential</Button>}
        </div>
        {showAdd && (
          <div className="flex items-center gap-2 mb-2">
            <Input className="h-7 text-xs flex-1" placeholder="Label" value={cLabel} onChange={e => setCLabel(e.target.value)} data-testid="input-cred-label" />
            <Input className="h-7 text-xs flex-1" placeholder="Username" value={cUser} onChange={e => setCUser(e.target.value)} data-testid="input-cred-username" />
            <Input className="h-7 text-xs flex-1" placeholder="URL" value={cUrl} onChange={e => setCUrl(e.target.value)} data-testid="input-cred-url" />
            <Button size="sm" className="h-7 text-xs px-2" onClick={handleAdd} disabled={saveMutation.isPending || !cLabel} data-testid="button-save-credential">Save</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs px-1" onClick={() => setShowAdd(false)} data-testid="button-cancel-credential">✕</Button>
          </div>
        )}
        {credentials.length > 0 ? credentials.map((c, i) => (
          <div key={i} className="group flex justify-between items-center py-1.5 border-b border-border/30 last:border-0">
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium">{c.label}</span>
              {c.username && <span className="text-xs text-muted-foreground ml-2">{c.username}</span>}
            </div>
            <div className="flex items-center gap-2">
              {c.url && <a href={c.url.startsWith("http") ? c.url : `https://${c.url}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline" data-testid={`link-cred-${i}`}><ExternalLink className="h-3 w-3" /></a>}
              <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => handleDelete(i)} data-testid={`button-delete-cred-${i}`}><Trash2 className="h-3 w-3 text-destructive" /></button>
            </div>
          </div>
        )) : !showAdd && <p className="text-xs text-muted-foreground text-center py-2">No saved credentials</p>}
      </CardContent>
    </Card>
  );
}

function InsightsTab({ profile }: { profile: any }) {
  const f = profile.fields || {};
  const expenses = profile.relatedExpenses || [];
  const isBank = f.assetSubtype === "bank_account";

  // Group expenses by category
  const catMap: Record<string, number> = {};
  expenses.forEach((e: any) => {
    const cat = e.category || "Uncategorized";
    catMap[cat] = (catMap[cat] || 0) + (Number(e.amount) || 0);
  });
  const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);

  return (
    <div className="space-y-3" data-testid="insights-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            {isBank ? "Spending Breakdown" : "Revenue & Expenses"}
          </p>
          {sorted.length > 0 ? (
            <div className="space-y-1.5">
              {sorted.slice(0, 8).map(([cat, amt]) => (
                <div key={cat} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="h-2 rounded-full bg-primary/60" style={{ width: `${Math.max(8, (amt / (total || 1)) * 100)}%` }} />
                    <span className="text-xs truncate">{cat}</span>
                  </div>
                  <span className="text-xs font-medium tabular-nums ml-2">{formatCurrency(amt)}</span>
                </div>
              ))}
              <div className="flex justify-between pt-2 mt-1 border-t border-border/30">
                <span className="text-xs font-semibold">Total</span>
                <span className="text-xs font-bold tabular-nums">{formatCurrency(total)}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">No expense data yet</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ValuationTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const f = profile.fields || {};
  const purchase = Number(f.purchasePrice) || 0;
  const current = Number(f.currentValue) || 0;
  const change = current - purchase;
  const changePct = purchase > 0 ? ((change / purchase) * 100).toFixed(1) : null;
  const valuationFields = [
    { key: "currentValue", label: "Current Value" },
    { key: "purchasePrice", label: "Purchase Price" },
    { key: "condition", label: "Condition" },
    { key: "lastAppraisedDate", label: "Last Appraised" },
    { key: "marketNotes", label: "Market Notes" },
  ];
  return (
    <div className="space-y-3" data-testid="valuation-tab">
      {purchase > 0 && current > 0 && (
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Value Change</p>
                <p className={`text-lg font-bold tabular-nums ${change >= 0 ? "text-green-600" : "text-red-500"}`}>
                  {change >= 0 ? "+" : ""}{formatCurrency(change)}
                </p>
              </div>
              {changePct && (
                <Badge variant={change >= 0 ? "default" : "destructive"} className="text-xs">
                  {change >= 0 ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                  {changePct}%
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Valuation Details</p>
          {valuationFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
        </CardContent>
      </Card>
      <AppraisalsList profileId={profileId} fields={f} onChanged={onChanged} />
    </div>
  );
}

function AppraisalsList({ profileId, fields, onChanged }: { profileId: string; fields: any; onChanged: () => void }) {
  const appraisals: { date: string; value: string; source: string }[] = (() => { try { return Array.isArray(fields.appraisals) ? fields.appraisals : JSON.parse(fields.appraisals || "[]"); } catch { return []; } })();
  const [showAdd, setShowAdd] = useState(false);
  const [aDate, setADate] = useState(new Date().toISOString().slice(0, 10));
  const [aValue, setAValue] = useState("");
  const [aSource, setASource] = useState("");
  const saveMutation = useMutation({
    mutationFn: async (updated: any[]) => { await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { ...fields, appraisals: updated } }); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); onChanged(); },
  });
  const handleAdd = () => { saveMutation.mutate([...appraisals, { date: aDate, value: aValue, source: aSource }]); setShowAdd(false); setAValue(""); setASource(""); };
  const handleDelete = (idx: number) => { saveMutation.mutate(appraisals.filter((_, i) => i !== idx)); };
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Appraisals ({appraisals.length})</p>
          {!showAdd && <Button variant="outline" size="sm" className="h-6 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-appraisal"><Plus className="h-3 w-3" />Add Appraisal</Button>}
        </div>
        {showAdd && (
          <div className="flex items-center gap-2 mb-2">
            <Input className="h-7 text-xs w-28" type="date" value={aDate} onChange={e => setADate(e.target.value)} data-testid="input-appraisal-date" />
            <Input className="h-7 text-xs w-24" placeholder="Value" value={aValue} onChange={e => setAValue(e.target.value)} data-testid="input-appraisal-value" />
            <Input className="h-7 text-xs flex-1" placeholder="Source" value={aSource} onChange={e => setASource(e.target.value)} data-testid="input-appraisal-source" />
            <Button size="sm" className="h-7 text-xs px-2" onClick={handleAdd} disabled={saveMutation.isPending || !aValue} data-testid="button-save-appraisal">Save</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs px-1" onClick={() => setShowAdd(false)} data-testid="button-cancel-appraisal">✕</Button>
          </div>
        )}
        {appraisals.length > 0 ? appraisals.map((a, i) => (
          <div key={i} className="group flex justify-between items-center py-1.5 border-b border-border/30 last:border-0">
            <div className="min-w-0 flex-1">
              <span className="text-xs font-medium">{a.value ? `$${a.value}` : "—"}</span>
              {a.source && <span className="text-xs text-muted-foreground ml-2">{a.source}</span>}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">{a.date ? new Date(a.date).toLocaleDateString() : ""}</span>
              <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => handleDelete(i)} data-testid={`button-delete-appraisal-${i}`}><Trash2 className="h-3 w-3 text-destructive" /></button>
            </div>
          </div>
        )) : !showAdd && <p className="text-xs text-muted-foreground text-center py-2">No appraisals recorded</p>}
      </CardContent>
    </Card>
  );
}

function LinkedSubsTab({ profile }: { profile: any }) {
  const children = (profile.childProfiles || []).filter((c: any) => c.type === "subscription");
  const totalMonthly = children.reduce((sum: number, c: any) => sum + (Number(c.fields?.cost) || 0), 0);
  return (
    <div className="space-y-3" data-testid="linked-subs-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Linked Subscriptions</span>
            {totalMonthly > 0 && <Badge variant="outline" className="text-xs">{formatCurrency(totalMonthly)}/mo</Badge>}
          </div>
          {children.length > 0 ? (
            <div className="divide-y divide-border/30">
              {children.map((sub: any) => (
                <div key={sub.id} className="flex items-center justify-between py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{sub.name}</p>
                    <p className="text-xs text-muted-foreground">{sub.fields?.frequency || "monthly"}</p>
                  </div>
                  <span className="text-xs font-medium tabular-nums">{sub.fields?.cost ? formatCurrency(Number(sub.fields.cost)) : "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">No subscriptions linked to this account</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PaymentsTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const { toast } = useToast();
  const f = profile.fields || {};
  const paymentFields = [
    { key: "nextPaymentDate", label: "Next Due" },
    { key: "minimumPayment", label: "Minimum Payment" },
    { key: "autopay", label: "Autopay" },
  ];
  const paymentHistory = (profile.relatedExpenses || []).filter((e: any) =>
    (e.category || "").toLowerCase().includes("payment")
  ).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const [showRecord, setShowRecord] = useState(false);
  const [payAmt, setPayAmt] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));

  const recordMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/profiles/${profileId}/expenses`, {
        description: `Payment - ${profile.name}`, amount: payAmt, date: payDate, category: "payment",
      });
    },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onChanged();
      setShowRecord(false);
      setPayAmt("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });
  const deletePayMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); onChanged(); },
  });

  return (
    <div className="space-y-3" data-testid="payments-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Payment Info</p>
          {paymentFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
          <div className="mt-3">
            {!showRecord ? (
              <Button variant="outline" size="sm" className="w-full text-xs h-7" onClick={() => setShowRecord(true)} data-testid="button-record-payment">
                <Plus className="h-3 w-3 mr-1" /> Record Payment
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Input className="h-7 text-xs flex-1" placeholder="Amount" value={payAmt} onChange={e => setPayAmt(e.target.value)} data-testid="input-payment-amount" />
                <Input className="h-7 text-xs w-28" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} data-testid="input-payment-date" />
                <Button size="sm" className="h-7 text-xs px-2" onClick={() => recordMutation.mutate()} disabled={recordMutation.isPending || !payAmt} data-testid="button-save-payment">
                  {recordMutation.isPending ? "…" : "Save"}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs px-1" onClick={() => setShowRecord(false)}>✕</Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {paymentHistory.length > 0 && (
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Payment History</p>
            <div className="divide-y divide-border/30">
              {paymentHistory.slice(0, 10).map((p: any) => (
                <div key={p.id} className="group flex justify-between items-center py-1.5">
                  <span className="text-xs text-muted-foreground">{p.date ? new Date(p.date).toLocaleDateString() : "—"}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium tabular-nums">{p.amount ? formatCurrency(Number(p.amount)) : "—"}</span>
                    <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => deletePayMutation.mutate(p.id)} data-testid={`button-delete-payment-${p.id}`}><Trash2 className="h-3 w-3 text-destructive" /></button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function getTabsForType(type: string, profile?: any): TabDef[] {
  const assetSubtype = type === "asset" && profile?.fields?.assetSubtype ? String(profile.fields.assetSubtype) : null;
  const baseTabs = assetSubtype
    ? (ASSET_SUBTYPE_TABS[assetSubtype] || ASSET_SUBTYPE_TABS.high_value_item)
    : (ENTITY_TABS[type] || DEFAULT_TABS);
  
  // If no profile data provided, return all tabs for this type
  if (!profile) return baseTabs;
  
  // Data-driven filtering: prioritize tabs with data, but still show empty ones (just reorder)
  // Overview always first
  const withData: TabDef[] = [];
  const withoutData: TabDef[] = [];
  
  for (const tab of baseTabs) {
    if (tab.value === "info") {
      withData.unshift(tab); // Overview always first
      continue;
    }
    
    const hasData = (() => {
      switch (tab.value) {
        case "health": return (profile.relatedTrackers || []).some((t: any) => 
          ['health','fitness','weight','sleep','wellness','nutrition','blood'].some(c => 
            (t.category || '').toLowerCase().includes(c) || (t.name || '').toLowerCase().includes(c)));
        case "trackers": return (profile.relatedDocuments || []).length > 0; // Documents tab — show if docs exist
        case "finances": return (profile.relatedExpenses || []).length > 0;
        case "tasks": return (profile.relatedTasks || []).length > 0;
        case "activity": return ((profile.relatedExpenses || []).length + (profile.relatedTasks || []).length + (profile.relatedEvents || []).length) > 0;
        case "documents": return (profile.relatedDocuments || []).length > 0;
        case "loan-detail": return !!(profile.fields?.interestRate || profile.fields?.loanBalance ||
          profile.fields?.monthlyPayment || (profile.relatedObligations || []).length > 0);
        case "notes": return !!(profile.notes && profile.notes.trim());
        case "timeline": return ((profile.relatedEvents || []).length + (profile.relatedTasks || []).length) > 0;
        case "billing": return true;
        case "impact": return true;
        case "details": return true;
        case "warranty": return true;
        case "rewards": return true;
        case "access": return true;
        case "insights": return true;
        case "valuation": return true;
        case "linked-subs": return true;
        case "payments": return true;
        default: return false;
      }
    })();
    
    if (hasData) {
      withData.push(tab);
    } else {
      // Hide truly empty low-value tabs; keep high-value ones with CTAs
      const alwaysShow = ["info", "finances", "trackers", "tasks", "activity", "health", "loan-detail", "billing", "impact", "details", "warranty", "rewards", "access", "insights", "valuation", "linked-subs", "payments"];
      if (alwaysShow.includes(tab.value)) {
        withoutData.push(tab);
      }
      // Notes and timeline are hidden when empty
    }
  }
  
  // Data tabs first, then empty tabs (still accessible but deprioritized)
  return [...withData, ...withoutData];
}

// ============================================================
// SUBSCRIPTION BILLING TAB
// ============================================================

function SubscriptionBillingTab({ profile, profileId, onChanged }: { profile: ProfileDetail; profileId: string; onChanged: () => void }) {
  const { toast } = useToast();
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [payDesc, setPayDesc] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payCategory, setPayCategory] = useState("subscription");

  const f = profile.fields || {};
  const expenses = [...(profile.relatedExpenses || [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const events = profile.relatedEvents || [];

  const billingFields = [
    { key: "frequency", label: "Billing Cycle" },
    { key: "startDate", label: "Start Date" },
    { key: "renewalDate", label: "Next Billing" },
    { key: "endDate", label: "End Date" },
    { key: "paymentMethod", label: "Payment Method" },
  ];

  const createPaymentMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/expenses", {
        description: payDesc || `${profile.name} payment`,
        amount: Number(payAmount),
        category: payCategory,
        date: payDate,
      });
      const expense = await res.json();
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "expense", entityId: expense.id });
      return expense;
    },
    onSuccess: () => {
      toast({ title: `$${Number(payAmount).toFixed(2)} payment recorded` });
      setShowAddPayment(false);
      setPayDesc(""); setPayAmount(""); setPayDate(new Date().toISOString().slice(0, 10));
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to add payment", description: formatApiError(err), variant: "destructive" }),
  });

  const calendarSyncMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/events", {
        title: `\u{1F4B0} ${profile.name} billing`,
        date: f.renewalDate || new Date().toISOString().slice(0, 10),
        type: "subscription",
        linkedProfiles: [profileId],
        recurring: f.frequency || "monthly",
      });
    },
    onSuccess: () => {
      toast({ title: "Calendar event created" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to sync", description: formatApiError(err), variant: "destructive" }),
  });
  const deleteSubPayMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); onChanged(); },
  });

  return (
    <div className="space-y-4" data-testid="subscription-billing-tab">
      {/* Billing Info */}
      <Card>
        <button className="w-full flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Billing Info</span>
        </button>
        <CardContent className="px-4 pb-3 pt-0">
          {billingFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
        </CardContent>
      </Card>

      {/* Calendar Events */}
      <Card>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Calendar Events</span>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => calendarSyncMutation.mutate()} disabled={calendarSyncMutation.isPending} data-testid="button-sync-calendar">
            <CalendarPlus className="h-3 w-3" /> {calendarSyncMutation.isPending ? "Syncing..." : "Sync to Calendar"}
          </Button>
        </div>
        <CardContent className="px-4 pb-3 pt-0">
          {events.length > 0 ? (
            <div className="space-y-1">
              {events.slice(0, 5).map((ev: any) => (
                <div key={ev.id} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs truncate">{ev.title}</span>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">{ev.date ? new Date(ev.date).toLocaleDateString() : "—"}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-2">No calendar events linked yet</p>
          )}
        </CardContent>
      </Card>

      {/* Payment History */}
      <Card>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Payment History ({expenses.length})</span>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowAddPayment(true)} data-testid="button-add-payment">
            <Plus className="h-3 w-3" /> Add Payment
          </Button>
        </div>
        <CardContent className="px-4 pb-3 pt-0">
          {expenses.length > 0 ? (
            <div className="space-y-0.5">
              {expenses.map((exp) => (
                <div key={exp.id} className="group flex items-center justify-between py-1.5 border-b border-border/30 last:border-0" data-testid={`payment-row-${exp.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{exp.description || "Payment"}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{new Date(exp.date).toLocaleDateString()}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold tabular-nums">${(exp.amount || 0).toFixed(2)}</span>
                    <button className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => deleteSubPayMutation.mutate(exp.id)} data-testid={`button-delete-sub-payment-${exp.id}`}><Trash2 className="h-3 w-3 text-destructive" /></button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-2">No payments recorded yet</p>
          )}
        </CardContent>
      </Card>

      {/* Add Payment Dialog */}
      <Dialog open={showAddPayment} onOpenChange={setShowAddPayment}>
        <DialogContent className="max-w-sm" data-testid="dialog-add-payment">
          <DialogHeader>
            <DialogTitle className="text-sm">Add Payment</DialogTitle>
            <DialogDescription>Record a payment for {profile.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs text-muted-foreground">Description</label>
              <Input className="mt-1 h-8 text-xs" value={payDesc} onChange={e => setPayDesc(e.target.value)} placeholder={`${profile.name} payment`} data-testid="input-payment-desc" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Amount</label>
              <Input className="mt-1 h-8 text-xs" type="number" step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" data-testid="input-payment-amount" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Date</label>
              <Input className="mt-1 h-8 text-xs" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} data-testid="input-payment-date" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Category</label>
              <Select value={payCategory} onValueChange={setPayCategory}>
                <SelectTrigger className="h-8 text-xs mt-1" data-testid="select-payment-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["subscription", "entertainment", "utilities", "software", "other"].map(c => (
                    <SelectItem key={c} value={c} className="text-xs capitalize">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" className="h-8 text-xs" onClick={() => createPaymentMutation.mutate()} disabled={!payAmount || createPaymentMutation.isPending} data-testid="button-submit-payment">
              {createPaymentMutation.isPending ? "Saving..." : "Add Payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// SUBSCRIPTION IMPACT TAB
// ============================================================

function SubscriptionImpactTab({ profile, profileId }: { profile: ProfileDetail; profileId: string }) {
  const f = profile.fields || {};
  const cost = Number(f.monthlyCost || f.cost || f.amount || 0);
  const freq = (f.frequency || "monthly").toLowerCase();
  const monthlyCost = freq === "yearly" || freq === "annual" ? cost / 12 : freq === "quarterly" ? cost / 3 : freq === "weekly" ? cost * 4.33 : cost;
  const expenses = profile.relatedExpenses || [];

  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const currentYear = now.getFullYear();

  const thisMonthTotal = expenses
    .filter(e => { const d = new Date(e.date); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === currentMonthKey; })
    .reduce((sum, e) => sum + (e.amount || 0), 0);

  const thisYearTotal = expenses
    .filter(e => new Date(e.date).getFullYear() === currentYear)
    .reduce((sum, e) => sum + (e.amount || 0), 0);

  const startDate = f.startDate ? new Date(f.startDate) : null;
  const monthsSinceStart = startDate ? Math.max(1, Math.floor((Date.now() - startDate.getTime()) / (30.44 * 86400000))) : 0;
  const lifetimeEstimate = expenses.length > 0
    ? expenses.reduce((sum, e) => sum + (e.amount || 0), 0)
    : monthlyCost * monthsSinceStart;

  const projection12 = monthlyCost * 12;
  const category = f.category || "";

  // Monthly totals for cost trend
  const monthlyTotals: Record<string, number> = {};
  for (const exp of expenses) {
    const d = new Date(exp.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyTotals[key] = (monthlyTotals[key] || 0) + (exp.amount || 0);
  }
  const sortedMonths = Object.entries(monthlyTotals).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);

  // Parent profile
  const parentId = f.parentProfileId;
  const parentQuery = useQuery<any>({
    queryKey: ["/api/profiles", parentId, "detail"],
    queryFn: async () => { const res = await apiRequest("GET", `/api/profiles/${parentId}/detail`); return res.json(); },
    enabled: !!parentId,
  });

  return (
    <div className="space-y-4" data-testid="subscription-impact-tab">
      {/* Spending Summary */}
      <Card className="p-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Spending Summary</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-sm font-bold tabular-nums">{thisMonthTotal > 0 ? `$${thisMonthTotal.toFixed(2)}` : "—"}</p>
            <p className="text-xs text-muted-foreground">This Month</p>
          </div>
          <div>
            <p className="text-sm font-bold tabular-nums">{thisYearTotal > 0 ? `$${thisYearTotal.toFixed(2)}` : "—"}</p>
            <p className="text-xs text-muted-foreground">This Year</p>
          </div>
          <div>
            <p className="text-sm font-bold tabular-nums">{lifetimeEstimate > 0 ? `$${Math.round(lifetimeEstimate).toLocaleString()}` : "—"}</p>
            <p className="text-xs text-muted-foreground">Lifetime</p>
          </div>
        </div>
      </Card>

      {/* 12-Month Projection */}
      <Card className="p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-muted-foreground uppercase">12-Month Projection</p>
          <Target className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <p className="text-lg font-bold tabular-nums mt-1" data-testid="text-12mo-projection">
          {monthlyCost > 0 ? `$${Math.round(projection12).toLocaleString()}` : "—"}
        </p>
        {monthlyCost > 0 && (
          <p className="text-xs text-muted-foreground">${monthlyCost.toFixed(2)}/mo × 12 months</p>
        )}
      </Card>

      {/* Category */}
      {category && (
        <Card className="p-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Category</p>
          <Badge variant="secondary" className="text-xs capitalize" data-testid="badge-sub-category">{category}</Badge>
        </Card>
      )}

      {/* Cost Over Time */}
      {sortedMonths.length >= 3 && (
        <Card className="p-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Cost Over Time</p>
          <div className="space-y-1">
            {sortedMonths.map(([month, total]) => {
              const maxVal = Math.max(...sortedMonths.map(m => m[1]));
              const pct = maxVal > 0 ? (total / maxVal) * 100 : 0;
              return (
                <div key={month} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-14 shrink-0 tabular-nums">{month}</span>
                  <div className="flex-1 h-4 bg-muted/30 rounded overflow-hidden">
                    <div className="h-full bg-pink-500/40 rounded" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-medium tabular-nums w-16 text-right">${total.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Linked To */}
      {parentId && parentQuery.data && (
        <Card className="p-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Linked To</p>
          <Link href={`/profiles/${parentId}`} className="text-xs font-medium text-primary hover:underline" data-testid="link-parent-profile">
            {parentQuery.data.name || "Parent Profile"}
          </Link>
          <p className="text-xs text-muted-foreground capitalize">{parentQuery.data.type}</p>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// SUBSCRIPTION DETAILS TAB
// ============================================================

function SubscriptionDetailsTab({ profile, profileId, onChanged }: { profile: ProfileDetail; profileId: string; onChanged: () => void }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState(profile.notes || "");
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const f = profile.fields || {};
  const documents = profile.relatedDocuments || [];

  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { notes });
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      const prev = queryClient.getQueryData(["/api/profiles", profileId, "detail"]);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => old ? { ...old, notes } : old);
      setIsEditingNotes(false);
      toast({ title: "Notes saved" });
      return { prev };
    },
    onError: (_err: Error, _v: void, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/profiles", profileId, "detail"], ctx.prev);
      toast({ title: "Failed to save notes", variant: "destructive" });
    },
    onSettled: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => { const reader = new FileReader(); reader.onload = () => res((reader.result as string).split(",")[1]); reader.onerror = rej; reader.readAsDataURL(f); });
      const fileData = await toBase64(file);
      const res = await apiRequest("POST", "/api/upload", { fileName: file.name, mimeType: file.type, fileData, profileId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Upload failed", description: formatApiError(err), variant: "destructive" }),
  });

  const termsFields = [
    { key: "cancellationPolicy", label: "Cancellation Policy" },
    { key: "trialEndDate", label: "Trial End Date" },
    { key: "contractEndDate", label: "Contract End Date" },
  ];

  const supportFields = [
    { key: "supportUrl", label: "Support URL" },
    { key: "supportPhone", label: "Support Phone" },
    { key: "supportEmail", label: "Support Email" },
    { key: "accountEmail", label: "Account Email" },
    { key: "loginUrl", label: "Login URL" },
  ];

  return (
    <div className="space-y-4" data-testid="subscription-details-tab">
      {/* Notes */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold">Notes</span>
            {!isEditingNotes ? (
              <Button size="sm" variant="outline" className="h-6 text-xs gap-1" onClick={() => setIsEditingNotes(true)} data-testid="button-edit-detail-notes">
                <Pencil className="h-2.5 w-2.5" /> Edit
              </Button>
            ) : (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => { setNotes(profile.notes || ""); setIsEditingNotes(false); }}>Cancel</Button>
                <Button size="sm" className="h-6 text-xs" onClick={() => saveNotesMutation.mutate()} disabled={saveNotesMutation.isPending} data-testid="button-save-detail-notes">
                  {saveNotesMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            )}
          </div>
          {isEditingNotes ? (
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="min-h-[120px] text-xs" placeholder="Add notes about this subscription..." data-testid="textarea-detail-notes" />
          ) : (profile.notes ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-xs whitespace-pre-wrap">{profile.notes}</div>
          ) : (
            <p className="text-xs text-muted-foreground italic py-2">No notes — tap Edit to add</p>
          ))}
        </CardContent>
      </Card>

      {/* Documents */}
      <Card>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Documents ({documents.length})</span>
          <div>
            <input type="file" ref={fileInputRef} className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) uploadMutation.mutate(file); e.target.value = ""; }} />
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending} data-testid="button-add-document">
              <Upload className="h-3 w-3" /> {uploadMutation.isPending ? "Uploading..." : "Add Document"}
            </Button>
          </div>
        </div>
        <CardContent className="px-4 pb-3 pt-0">
          {documents.length > 0 ? (
            <div className="space-y-0.5">
              {documents.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0" data-testid={`document-row-${doc.id}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{doc.name}</p>
                      <p className="text-xs text-muted-foreground">{doc.type}{doc.expirationDate ? ` · Exp: ${new Date(doc.expirationDate).toLocaleDateString()}` : ""}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground py-2">No documents linked yet</p>
          )}
        </CardContent>
      </Card>

      {/* Terms & Cancellation */}
      <Card>
        <button className="w-full flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Terms & Cancellation</span>
        </button>
        <CardContent className="px-4 pb-3 pt-0">
          {termsFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
        </CardContent>
      </Card>

      {/* Support Info */}
      <Card>
        <button className="w-full flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Support Info</span>
        </button>
        <CardContent className="px-4 pb-3 pt-0">
          {supportFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// NOTES TAB — full CRUD for profile notes
// ============================================================

function NotesTab({ profileId, currentNotes, updatedAt, onChanged }: { profileId: string; currentNotes: string; updatedAt?: string; onChanged: () => void }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState(currentNotes);
  const [isEditing, setIsEditing] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { notes });
    },
    onSuccess: () => {
      toast({ title: "Notes saved for this profile" });
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to save notes", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Notes</h3>
            {updatedAt && (
              <span className="text-xs text-muted-foreground">
                Last edited {new Date(updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
          </div>
          {!isEditing ? (
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setIsEditing(true)} data-testid="button-edit-notes">
              <Pencil className="h-3 w-3" /> Edit
            </Button>
          ) : (
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setNotes(currentNotes); setIsEditing(false); }}>Cancel</Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-notes">
                {saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>
        {isEditing ? (
          <div>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-[200px] text-sm"
              placeholder="Add notes about this profile..."
              data-testid="textarea-notes"
            />
            <p className="text-xs text-muted-foreground mt-1 text-right">{notes.length} characters</p>
          </div>
        ) : currentNotes ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm whitespace-pre-wrap min-h-[100px]">
            {currentNotes}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No notes yet</p>
            <Button size="sm" variant="outline" className="mt-3 h-7 text-xs gap-1" onClick={() => setIsEditing(true)}>
              <Pencil className="h-3 w-3" /> Add Notes
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function ProfileDetailPage() {
  const [, params] = useRoute("/profiles/:id");
  const [, navigate] = useLocation();
  const id = (params as { id?: string } | null)?.id || "";
  const { toast } = useToast();

  useEffect(() => { document.title = "Profile — Portol"; }, []);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [linkedFilter, setLinkedFilter] = useState<"all" | "profiles" | "trackers" | "documents">("all");
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const avatarMutation = useMutation({
    mutationFn: async (base64: string) => {
      await apiRequest("PATCH", `/api/profiles/${id}`, { avatar: base64 });
    },
    onSuccess: () => {
      toast({ title: "Profile picture updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
    onError: (err: Error) => toast({ title: "Failed to update picture", description: formatApiError(err), variant: "destructive" }),
  });

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Please choose an image under 2MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      avatarMutation.mutate(result);
    };
    reader.readAsDataURL(file);
  };

  const { data: profile, isLoading, error, refetch } = useQuery<ProfileDetail>({
    queryKey: ["/api/profiles", id, "detail"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${id}/detail`);
      return res.json();
    },
    enabled: !!id,
    staleTime: 5000, // 5s — prevents re-fetch on rapid tab switches. Mutations invalidate immediately.
    refetchOnMount: true,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      toast({ title: `Profile deleted`, description: "All linked data has been removed" });
      // Cascade: profile delete also removes linked obligations, events, expenses, etc.
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      navigate("/profiles");
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  function handleSaved() {
    queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    refetch();
  }

  // ── Owner dropdown (asset / vehicle / loan / subscription etc.) ───────────────
  const [showOwnerMenu, setShowOwnerMenu] = useState(false);
  const ownerMenuRef = useRef<HTMLDivElement>(null);

  const assetTypes = ["vehicle","asset","subscription","loan","investment","property","insurance","medical","account"];
  const isAssetProfile = !!profile && assetTypes.includes(profile.type);

  const { data: ownerCandidates } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: isAssetProfile,
    staleTime: 60000,
  });
  const personOptions = (ownerCandidates || []).filter((p: any) =>
    ["self","person"].includes(p.type) && !p.fields?._parentProfileId
  );
  const currentOwnerLabel = profile?.fields?.ownerName || null;

  const setOwnerMutation = useMutation({
    mutationFn: async (ownerProfile: any | null) => {
      const res = await apiRequest("PATCH", `/api/profiles/${id}`, {
        fields: {
          ...(profile?.fields || {}),
          ownerProfileId: ownerProfile?.id || null,
          ownerName: ownerProfile?.name || null,
          // _parentProfileId drives ALL filter queries (dashboard, linked, profiles pages)
          // — must be kept in sync with the owner so filtering works correctly
          _parentProfileId: ownerProfile?.id || null,
        },
      });
      return res.json();
    },
    onSuccess: (_, ownerProfile) => {
      toast({ title: ownerProfile ? `Owned by ${ownerProfile.name}` : "Set to Shared" });
      handleSaved();
    },
    onError: (err: Error) => toast({ title: "Failed to update owner", description: formatApiError(err), variant: "destructive" }),
  });

  useEffect(() => {
    if (!showOwnerMenu) return;
    const close = (e: MouseEvent) => {
      if (ownerMenuRef.current && !ownerMenuRef.current.contains(e.target as Node)) setShowOwnerMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showOwnerMenu]);

  if (isLoading) {
    return (
      <div className="overflow-y-auto h-full pb-24">
        {/* Hero skeleton */}
        <div className="px-4 md:px-6 pt-4 pb-6 bg-muted/20 animate-pulse">
          <div className="flex items-center justify-between mb-3">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="flex gap-1.5">
              <div className="h-7 w-12 rounded bg-muted" />
              <div className="h-7 w-16 rounded bg-muted" />
            </div>
          </div>
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-muted" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-5 w-36 rounded bg-muted" />
              <div className="h-4 w-16 rounded bg-muted" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-4">
            {[1,2,3].map(i => <div key={i} className="h-14 rounded-lg bg-muted" />)}
          </div>
        </div>
        {/* Content skeleton */}
        <div className="px-4 md:px-6 pt-4 space-y-3">
          <div className="h-8 rounded-lg bg-muted/50" />
          <div className="h-32 rounded-xl bg-muted/30" />
          <div className="h-20 rounded-xl bg-muted/30" />
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="p-4 md:p-6 text-center overflow-y-auto h-full">
        <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
        <p className="text-sm text-destructive mb-1">Profile not found</p>
        <p className="text-xs text-muted-foreground mb-3">This profile may have been deleted or the URL is invalid.</p>
        <Link href="/profiles">
          <Button variant="outline" size="sm"><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Profiles</Button>
        </Link>
      </div>
    );
  }

  const linkedTypes = ["vehicle", "asset", "subscription", "loan", "investment", "property", "insurance"];
  const isLinkedType = linkedTypes.includes(profile.type);
  const backHref = isLinkedType ? "/trackers" : "/profiles";
  const backLabel = isLinkedType ? "Back to Linked" : "Back to Profiles";

  return (
    <div className="overflow-y-auto h-full pb-24" data-testid="page-profile-detail">
      {/* Hero Header */}
      <div className="px-4 md:px-6 pt-4 pb-6" style={{ background: getProfileBanner(profile?.type || '') }}>
        <div className="flex items-center justify-between mb-3">
          <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back">
            <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
          </Link>
          <div className="flex items-center gap-1.5">
            {/* Owner dropdown — only on asset / vehicle / loan / subscription etc. */}
            {isAssetProfile && personOptions.length > 0 && (
              <div className="relative" ref={ownerMenuRef}>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 bg-background/60 backdrop-blur-sm font-medium"
                  onClick={() => setShowOwnerMenu(v => !v)}
                  data-testid="button-owner-dropdown"
                >
                  <User className="h-3 w-3" />
                  {currentOwnerLabel || "Shared"}
                  <ChevronDown className="h-2.5 w-2.5 opacity-70" />
                </Button>
                {showOwnerMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 min-w-[130px] rounded-lg border border-border/80 bg-card shadow-lg overflow-hidden py-1">
                    <button
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted/70 transition-colors ${
                        !currentOwnerLabel ? "text-primary font-semibold" : "text-foreground"
                      }`}
                      onClick={() => { setOwnerMutation.mutate(null); setShowOwnerMenu(false); }}
                    >
                      Shared
                    </button>
                    <div className="mx-2 my-0.5 border-t border-border/40" />
                    {personOptions.map(p => (
                      <button
                        key={p.id}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted/70 transition-colors ${
                          currentOwnerLabel === p.name ? "text-primary font-semibold" : "text-foreground"
                        }`}
                        onClick={() => { setOwnerMutation.mutate(p); setShowOwnerMenu(false); }}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 bg-background/60 backdrop-blur-sm"
              onClick={() => setShowEditDialog(true)}
              data-testid="button-header-edit-profile"
            >
              <Edit className="h-3 w-3" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 text-destructive hover:text-destructive bg-background/60 backdrop-blur-sm"
              onClick={() => setShowDeleteDialog(true)}
              data-testid="button-delete-profile"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </Button>
          </div>
        </div>

        <div className="flex items-start gap-4">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
            data-testid="input-avatar-upload"
          />
          <button
            className={`relative w-14 h-14 rounded-2xl flex items-center justify-center overflow-hidden group cursor-pointer ${profileAccent(profile.type)}`}
            onClick={() => avatarInputRef.current?.click()}
            disabled={avatarMutation.isPending}
            title="Change profile picture"
            data-testid="button-avatar-upload"
          >
            {profile.avatar ? (
              <img src={profile.avatar} alt={profile.name} className="w-full h-full object-cover" />
            ) : (
              profileIcon(profile.type)
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Camera className="h-4 w-4 text-white" />
            </div>
            {avatarMutation.isPending && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <RefreshCw className="h-4 w-4 text-white animate-spin" />
              </div>
            )}
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold" data-testid="text-profile-detail-name">{profile.name}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Badge variant="secondary" className="text-xs capitalize">{profile.type}</Badge>
              {profile.tags.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">
                  <Tag className="h-2.5 w-2.5 mr-0.5" />{tag}
                </Badge>
              ))}
              {/* owner is now shown in the top-right dropdown button — no badge needed here */}
            </div>
            {profile.notes && (
              <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{profile.notes}</p>
            )}
          </div>
        </div>

        {/* Quick stats — type-aware */}
        {(() => {
          const ptype = profile.type;
          const stats: { label: string; value: number }[] = [];
          const tabSet = new Set(getTabsForType(ptype, profile).map(t => t.value));
          if (tabSet.has("health"))    stats.push({ label: "Health",  value: profile.relatedTrackers.filter((t: any) => ['health','fitness','weight','sleep','wellness','nutrition'].some(c => (t.category || '').toLowerCase().includes(c) || (t.name || '').toLowerCase().includes(c))).length });
          if (tabSet.has("all-trackers")) stats.push({ label: "Trackers", value: profile.relatedTrackers.length });
          if (tabSet.has("trackers"))  stats.push({ label: "Docs", value: profile.relatedDocuments.length });
          if (tabSet.has("finances"))  stats.push({ label: ptype === 'subscription' ? "Billing" : "Expenses", value: profile.relatedExpenses.length });
          if (tabSet.has("tasks"))     stats.push({ label: "Tasks",    value: profile.relatedTasks.length });
          const gridCls = stats.length <= 3 ? "grid-cols-3" : stats.length <= 4 ? "grid-cols-4" : "grid-cols-5";
          return (
            <div className={`grid ${gridCls} gap-2 mt-4`}>
              {stats.map(stat => (
                <div key={stat.label} className="text-center py-2 rounded-lg bg-background/60 backdrop-blur-sm">
                  <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
                  <p className="text-xs text-muted-foreground">{stat.label}</p>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* AI Summary Card */}
      <div className="px-4 md:px-6 pt-4">
        <AISummaryCard profileId={id} profileType={profile.type} />
      </div>

      {/* Profile Tabs — always use the full tab system */}
      <div className="px-4 md:px-6 pb-6">
        {(() => {
          const tabs = getTabsForType(profile.type, profile);
          const tabValues = new Set(tabs.map(t => t.value));
          return (
            <Tabs defaultValue="info" className="mt-3">
              <div className="overflow-x-auto pb-1 border-b border-border/50 -mx-1 px-1" style={{WebkitOverflowScrolling: 'touch'}}>
                <TabsList className="inline-flex h-8 w-max gap-0.5 p-0.5 bg-muted/50">
                  {tabs.map(tab => (
                    <TabsTrigger
                      key={tab.value}
                      value={tab.value}
                      className="text-xs px-3 whitespace-nowrap"
                      data-testid={tab.testId}
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              {tabValues.has("info") && (
                <TabsContent value="info" className="mt-4 px-1 sm:px-0">
                  <InfoTab profile={profile} onEdit={() => setShowEditDialog(true)} />
                  {/* All trackers at bottom of Overview */}
                  {profile.relatedTrackers.length > 0 && (
                    <div className="mt-4">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Trackers ({profile.relatedTrackers.length})</p>
                      <div className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden">
                        {profile.relatedTrackers.map((t: any) => {
                          const pf = t.fields?.find((f: any) => f.isPrimary)?.name || t.fields?.[0]?.name || "value";
                          const latest = t.entries?.length > 0 ? t.entries[t.entries.length - 1]?.values?.[pf] : null;
                          const displayVal = latest != null ? (isNaN(Number(latest)) ? String(latest) : Number(latest).toLocaleString(undefined, { maximumFractionDigits: 1 })) : "—";
                          return (
                            <div key={t.id} className="flex items-center gap-2 px-2.5 py-2 hover:bg-muted/30 transition-colors">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-medium truncate">{t.name}</p>
                                <p className="text-xs text-muted-foreground">{t.category} · {t.entries?.length || 0} entries</p>
                              </div>
                              <span className="text-sm font-bold tabular-nums">{displayVal}</span>
                              {t.unit && <span className="text-xs text-muted-foreground">{t.unit}</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </TabsContent>
              )}

              {tabValues.has("health") && (
                <TabsContent value="health" className="mt-4 px-1 sm:px-0">
                  <HealthTabView profile={profile} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("all-trackers") && (
                <TabsContent value="all-trackers" className="mt-4 px-1 sm:px-0">
                  {profile.relatedTrackers.length > 0 ? (
                    <TrackersTab trackers={profile.relatedTrackers} profileId={profile.id} onChanged={handleSaved} />
                  ) : (
                    <Card>
                      <CardContent className="py-8 text-center">
                        <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No trackers linked to this profile</p>
                        <p className="text-xs text-muted-foreground mt-1">Create trackers via chat or the Linked page, then link them here</p>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              )}

              {tabValues.has("trackers") && (
                <TabsContent value="trackers" className="mt-4 px-1 sm:px-0">
                  {/* Documents tab — ONLY documents, no trackers or child profiles */}
                  <DocumentsTab
                    documents={profile.relatedDocuments}
                    profileId={profile.id}
                    childProfiles={profile.childProfiles}
                    onUploaded={handleSaved}
                  />
                </TabsContent>
              )}

              {tabValues.has("loan-detail") && (
                <TabsContent value="loan-detail" className="mt-4 px-1 sm:px-0">
                  <LoanTab profile={profile} obligations={profile.relatedObligations || []} />
                </TabsContent>
              )}

              {tabValues.has("finances") && (
                <TabsContent value="finances" className="mt-4 px-1 sm:px-0">
                  <FinancesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("billing") && (
                <TabsContent value="billing" className="mt-4 px-1 sm:px-0">
                  <SubscriptionBillingTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("impact") && (
                <TabsContent value="impact" className="mt-4 px-1 sm:px-0">
                  <SubscriptionImpactTab profile={profile} profileId={profile.id} />
                </TabsContent>
              )}

              {tabValues.has("details") && (
                <TabsContent value="details" className="mt-4 px-1 sm:px-0">
                  <SubscriptionDetailsTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("warranty") && (
                <TabsContent value="warranty" className="mt-4 px-1 sm:px-0">
                  <WarrantyTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("rewards") && (
                <TabsContent value="rewards" className="mt-4 px-1 sm:px-0">
                  <RewardsTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("access") && (
                <TabsContent value="access" className="mt-4 px-1 sm:px-0">
                  <AccessTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("insights") && (
                <TabsContent value="insights" className="mt-4 px-1 sm:px-0">
                  <InsightsTab profile={profile} />
                </TabsContent>
              )}

              {tabValues.has("valuation") && (
                <TabsContent value="valuation" className="mt-4 px-1 sm:px-0">
                  <ValuationTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("linked-subs") && (
                <TabsContent value="linked-subs" className="mt-4 px-1 sm:px-0">
                  <LinkedSubsTab profile={profile} />
                </TabsContent>
              )}

              {tabValues.has("payments") && (
                <TabsContent value="payments" className="mt-4 px-1 sm:px-0">
                  <PaymentsTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("activity") && (
                <TabsContent value="activity" className="mt-4 px-1 sm:px-0">
                  {(() => {
                    const feed: Array<{date: string; type: string; title: string; subtitle?: string; color: string}> = [];
                    
                    for (const e of (profile.relatedExpenses || [])) {
                      feed.push({ date: e.date || (e as any).createdAt || '', type: 'expense', title: e.description || 'Expense', subtitle: `$${Number(e.amount).toFixed(2)}`, color: '#f59e0b' });
                    }
                    for (const t of (profile.relatedTasks || [])) {
                      feed.push({ date: (t as any).createdAt || t.dueDate || '', type: 'task', title: t.title, subtitle: t.status, color: '#8b5cf6' });
                    }
                    for (const ev of (profile.relatedEvents || [])) {
                      feed.push({ date: (ev as any).date || '', type: 'event', title: (ev as any).title, subtitle: (ev as any).time, color: '#3b82f6' });
                    }
                    
                    feed.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                    
                    if (feed.length === 0) {
                      return (
                        <div className="text-center py-8">
                          <Activity className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                          <p className="text-xs text-muted-foreground">No activity yet</p>
                        </div>
                      );
                    }
                    
                    return (
                      <div className="space-y-1.5 pb-4">
                        {feed.slice(0, 50).map((item, i) => (
                          <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg bg-muted/30 hover:bg-muted/50">
                            <div className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: item.color }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium truncate">{item.title}</p>
                              {item.subtitle && <p className="text-xs text-muted-foreground">{item.subtitle}</p>}
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {item.date ? new Date(item.date).toLocaleDateString('en-US', {month:'short', day:'numeric'}) : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </TabsContent>
              )}

              {tabValues.has("timeline") && (
                <TabsContent value="timeline" className="mt-4 px-1 sm:px-0">
                  <TimelineTab timeline={profile.timeline} />
                </TabsContent>
              )}

              {tabValues.has("notes") && (
                <TabsContent value="notes" className="mt-4 px-1 sm:px-0">
                  <NotesTab profileId={id} currentNotes={profile.notes || ""} updatedAt={profile.updatedAt} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("tasks") && (
                <TabsContent value="tasks" className="mt-4 px-1 sm:px-0">
                  <TasksTab
                    tasks={profile.relatedTasks}
                    profileId={profile.id}
                    onChanged={handleSaved}
                  />
                </TabsContent>
              )}
            </Tabs>
          );
        })()}
      </div>

      {/* Edit Dialog */}
      {showEditDialog && (
        <EditProfileDialog
          open={showEditDialog}
          profile={profile}
          onClose={() => setShowEditDialog(false)}
          onSaved={handleSaved}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent data-testid="dialog-confirm-delete-profile">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{profile.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this profile and all its data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-profile">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-profile"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Profile"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
