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
} from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { ProfileDetail, Profile, Document, TimelineEntry, Tracker } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ShareButton } from "@/components/DocumentViewer";
import { DocumentViewerDialog } from "@/components/DocumentViewer";
import { Skeleton } from "@/components/ui/skeleton";

// ============================================================
// HELPERS
// ============================================================

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
      staleTime: 0,
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
        <p className="text-[10px] text-muted-foreground pt-1" data-testid="text-ai-summary-generated">
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
              <Badge variant="secondary" className="text-[10px]">{entry.data.computed.caloriesBurned} cal burned</Badge>
            )}
            {entry.data.computed.pace && (
              <Badge variant="secondary" className="text-[10px]">{entry.data.computed.pace}</Badge>
            )}
            {entry.data.computed.heartRateZone && (
              <Badge variant="secondary" className="text-[10px] capitalize">{entry.data.computed.heartRateZone.replace("_", " ")}</Badge>
            )}
            {entry.data.computed.caloriesConsumed && (
              <Badge variant="secondary" className="text-[10px]">{entry.data.computed.caloriesConsumed} cal</Badge>
            )}
            {entry.data.computed.sleepQuality && (
              <Badge variant="secondary" className="text-[10px] capitalize">{entry.data.computed.sleepQuality} sleep</Badge>
            )}
            {entry.data.computed.bloodPressureCategory && (
              <Badge variant="secondary" className="text-[10px] capitalize">{entry.data.computed.bloodPressureCategory.replace(/_/g, " ")}</Badge>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {new Date(entry.timestamp).toLocaleDateString(undefined, {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          })}
        </p>
      </div>
      <Badge variant="secondary" className="text-[10px] capitalize shrink-0 h-fit">{entry.type}</Badge>
    </div>
  );
}

// ============================================================
// INFO TAB — Universal with type-specific enrichments
// ============================================================

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      setEditing(false);
    },
    onError: () => {
      toast({ title: "Failed to update", variant: "destructive" });
      setValue(fieldValue);
      setEditing(false);
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

  return (
    <div
      className="flex items-center justify-between py-2 border-b border-border last:border-0 cursor-pointer hover:bg-muted/30 -mx-2 px-2 rounded transition-colors group"
      onClick={() => setEditing(true)}
    >
      <span className="text-xs text-muted-foreground shrink-0 min-w-[80px]">{formatKey(fieldKey)}</span>
      <div className="flex items-center gap-1.5 min-w-0 justify-end">
        <span className="text-sm font-medium text-right break-words">{fieldValue}</span>
        <Pencil className="h-2.5 w-2.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </div>
    </div>
  );
}

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
      toast({ title: "Failed to add field", description: err.message, variant: "destructive" });
    },
  });

  const fields = Object.entries(profile.fields).filter(([_, v]) => v != null && v !== "" && typeof v !== "object");

  // Separate identity fields from internal/system fields
  const identityFieldKeys = new Set(['phone', 'email', 'birthday', 'relationship', 'bloodType', 'allergies', 'height', 'weight', 'breed', 'species', 'color', 'microchipId', 'make', 'model', 'year', 'vin', 'mileage', 'licensePlate', 'address', 'website', 'social', 'employer', 'title', 'gender', 'age']);
  const identityFields = fields.filter(([k]) => identityFieldKeys.has(k));
  const otherFields = fields.filter(([k]) => !identityFieldKeys.has(k) && !k.startsWith('_'));

  return (
    <div className="space-y-3">
      {/* ── 1. Core Identity Card ── */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-semibold">Identity</CardTitle>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onEdit} data-testid="button-edit-profile">
            <Edit className="h-3 w-3" /> Edit
          </Button>
        </CardHeader>
        <CardContent>
          {identityFields.length > 0 ? (
            <div className="space-y-0">
              {identityFields.map(([key, val]) => (
                <InlineEditField key={key} profileId={profile.id} fieldKey={key} fieldValue={String(val)} allFields={profile.fields} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-3 text-center">No identity details yet. Add info via chat or the edit button.</p>
          )}
        </CardContent>
      </Card>

      {/* ── 2. Additional Details (non-identity fields) ── */}
      {otherFields.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs font-semibold">Other Details</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-2.5 pt-0">
            <div className="space-y-0">
              {otherFields.map(([key, val]) => (
                <InlineEditField key={key} profileId={profile.id} fieldKey={key} fieldValue={String(val)} allFields={profile.fields} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 3. Add Custom Field ── */}
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

      {/* ── 4. Notes ── */}
      {profile.notes && (
        <Card>
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" /> Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-2.5 pt-0">
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{profile.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* ── 5. Tags ── */}
      {profile.tags.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
              {profile.tags.map(tag => (
                <Badge key={tag} variant="outline" className="text-[10px]">{tag}</Badge>
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
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
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
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
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
              <button onClick={() => setDocTypeFilter("all")} className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${docTypeFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>All ({documents.length})</button>
              {docTypes.map(t => (
                <button key={t} onClick={() => setDocTypeFilter(t)} className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize transition-colors ${docTypeFilter === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{t} ({documents.filter(d => d.type === t).length})</button>
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
                          {doc.mimeType.startsWith("image/") ? <Eye className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                        </div>
                      );
                    })()}
                    <button className="flex-1 min-w-0 text-left" onClick={() => setViewingDoc(doc)}>
                      <p className="text-sm font-medium truncate text-primary hover:underline">{doc.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <Badge variant="secondary" className="text-[10px] capitalize">{doc.type}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                        {expStatus === "expired" && expDate && (
                          <Badge variant="destructive" className="text-[10px] gap-0.5">
                            <AlertCircle className="h-2.5 w-2.5" /> Expired {new Date(expDate as string).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </Badge>
                        )}
                        {expStatus === "soon" && expDate && (
                          <Badge className="text-[10px] gap-0.5 bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 border-yellow-500/30">
                            <AlertCircle className="h-2.5 w-2.5" /> Expires {new Date(expDate as string).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                          </Badge>
                        )}
                        {doc.extractedData && Object.keys(doc.extractedData).length > 0 && (
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
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
                        onClick={() => setViewingDoc(doc)}
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
                          <span className="text-[10px] text-muted-foreground capitalize">{key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim()}</span>
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
  const expenses = profile.relatedExpenses;
  const obligations = profile.relatedObligations;
  const { toast } = useToast();
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ProfileDetail["relatedExpenses"][number] | null>(null);
  const [deleteExpenseId, setDeleteExpenseId] = useState<string | null>(null);
  const [expDesc, setExpDesc] = useState("");
  const [expAmount, setExpAmount] = useState("");
  const [expCategory, setExpCategory] = useState("general");
  const [expVendor, setExpVendor] = useState("");
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));

  const totalSpent = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);

  const expensesByMonth: Record<string, number> = {};
  for (const exp of expenses) {
    const d = new Date(exp.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    expensesByMonth[key] = (expensesByMonth[key] || 0) + (exp.amount || 0);
  }
  const sortedMonths = Object.keys(expensesByMonth).sort();
  const barData = sortedMonths.map(m => ({
    month: new Date(m + "-01").toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
    amount: expensesByMonth[m],
  }));
  const avgPerMonth = sortedMonths.length > 0 ? totalSpent / sortedMonths.length : 0;

  const isLoan = profile.type === "loan";
  const isInvestment = profile.type === "investment";
  const isSubscription = profile.type === "subscription";

  const performanceHistory: any[] = Array.isArray(profile.fields.performanceHistory) ? profile.fields.performanceHistory : [];
  const perfChartData = performanceHistory
    .filter(p => p.date && p.value != null)
    .map(p => ({ date: new Date(p.date).toLocaleDateString(undefined, { month: "short", year: "2-digit" }), value: Number(p.value) }));

  const createExpenseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/expenses", {
        description: expDesc, amount: Number(expAmount), category: expCategory, vendor: expVendor || undefined, date: expDate,
      });
      const expense = await res.json();
      // Link to this profile
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "expense", entityId: expense.id });
      return expense;
    },
    onSuccess: () => {
      toast({ title: "Expense added" });
      setShowAddExpense(false);
      setExpDesc(""); setExpAmount(""); setExpCategory("general"); setExpVendor(""); setExpDate(new Date().toISOString().slice(0, 10));
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const updateExpenseMutation = useMutation({
    mutationFn: async () => {
      if (!editingExpense) return;
      await apiRequest("PATCH", `/api/expenses/${editingExpense.id}`, {
        description: expDesc, amount: Number(expAmount), category: expCategory, vendor: expVendor || undefined, date: expDate,
      });
    },
    onSuccess: () => {
      toast({ title: "Expense updated" });
      setEditingExpense(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const deleteExpenseMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/expenses/${id}`);
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "expense", entityId: id });
    },
    onSuccess: () => {
      toast({ title: "Expense deleted" });
      setDeleteExpenseId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  function openEdit(expense: ProfileDetail["relatedExpenses"][number]) {
    setExpDesc(expense.description); setExpAmount(String(expense.amount)); setExpCategory(expense.category || "general");
    setExpVendor(expense.vendor || ""); setExpDate(expense.date?.slice(0, 10) || new Date().toISOString().slice(0, 10));
    setEditingExpense(expense);
  }

  function openAdd() {
    setExpDesc(""); setExpAmount(""); setExpCategory("general"); setExpVendor(""); setExpDate(new Date().toISOString().slice(0, 10));
    setShowAddExpense(true);
  }

  const expenseCategories = ["general", "food", "transport", "housing", "utilities", "entertainment", "health", "education", "shopping", "insurance", "pet", "vehicle", "travel", "other"];

  return (
    <div className="space-y-4">
      {/* Add Expense Button */}
      <div className="flex justify-end">
        <Button size="sm" className="gap-1.5 h-8 text-xs" onClick={openAdd} data-testid="button-add-expense">
          <Plus className="h-3.5 w-3.5" /> Add Expense
        </Button>
      </div>

      {/* Loan: Prominent Balance Card */}
      {isLoan && (profile.fields.remainingBalance || profile.fields.balance || profile.fields.originalAmount) && (
        <Card className="border-orange-500/30">
          <CardContent className="p-4">
            <div className="grid grid-cols-3 gap-3">
              {profile.fields.originalAmount && (
                <div className="text-center">
                  <p className="text-[11px] text-muted-foreground">Original</p>
                  <p className="text-base font-semibold tabular-nums">{formatCurrency(Number(profile.fields.originalAmount))}</p>
                </div>
              )}
              {(profile.fields.remainingBalance || profile.fields.balance) && (
                <div className="text-center">
                  <p className="text-[11px] text-muted-foreground">Remaining</p>
                  <p className="text-base font-semibold tabular-nums text-orange-600">{formatCurrency(Number(profile.fields.remainingBalance || profile.fields.balance))}</p>
                </div>
              )}
              {(profile.fields.interestRate || profile.fields.rate) && (
                <div className="text-center">
                  <p className="text-[11px] text-muted-foreground">Rate</p>
                  <p className="text-base font-semibold tabular-nums">{String(profile.fields.interestRate || profile.fields.rate)}%</p>
                </div>
              )}
            </div>
            {(profile.fields.monthlyPayment) && (
              <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Monthly Payment</span>
                <span className="text-sm font-semibold tabular-nums">{formatCurrency(Number(profile.fields.monthlyPayment))}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Investment: Current Balance + Performance Chart */}
      {isInvestment && profile.fields.balance && (
        <Card className="border-green-500/30">
          <CardContent className="p-4">
            <div className="grid grid-cols-2 gap-4 mb-3">
              <div>
                <p className="text-xs text-muted-foreground">Current Balance</p>
                <p className="text-xl font-semibold tabular-nums text-green-600">{formatCurrency(Number(profile.fields.balance))}</p>
              </div>
              {(profile.fields.contributions || profile.fields.ytdContributions) && (
                <div>
                  <p className="text-xs text-muted-foreground">YTD Contributions</p>
                  <p className="text-xl font-semibold tabular-nums">{formatCurrency(Number(profile.fields.contributions || profile.fields.ytdContributions))}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Investment: Performance Chart */}
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

      {/* Subscription: Billing Info */}
      {isSubscription && (profile.fields.cost || profile.fields.price) && (
        <Card className="border-pink-500/30">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Billing Amount</p>
                <p className="text-xl font-semibold tabular-nums">{formatCurrency(Number(profile.fields.cost || profile.fields.price))}</p>
              </div>
              {profile.fields.frequency && (
                <Badge variant="secondary" className="capitalize text-sm px-3 py-1">{String(profile.fields.frequency)}</Badge>
              )}
            </div>
            {profile.fields.nextBillingDate && (
              <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Next Billing Date</span>
                <span className="text-sm font-medium">{String(profile.fields.nextBillingDate)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Spending Summary */}
      {expenses.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Total Spent</p>
                <p className="text-xl font-semibold tabular-nums">{formatCurrency(totalSpent)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Avg / Month</p>
                <p className="text-xl font-semibold tabular-nums">{formatCurrency(avgPerMonth)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Spending by Month Bar Chart */}
      {barData.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BarChart2 className="h-4 w-4 text-muted-foreground" /> Spending by Month
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={barData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={v => `$${v}`} />
                <Tooltip
                  contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                  formatter={(val: number) => [formatCurrency(val), "Spent"]}
                />
                <Bar dataKey="amount" fill="#20808D" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Linked Obligations with Payment Schedule */}
      {obligations.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              {isSubscription ? "Billing Schedule" : isLoan ? "Payment Obligations" : "Obligations"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {obligations.map(ob => (
              <div key={ob.id} className="py-2.5 border-b border-border last:border-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">{ob.name}</p>
                  <span className="text-sm font-semibold tabular-nums">{formatCurrency(ob.amount)}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary" className="text-[10px]">{ob.frequency}</Badge>
                  <span className="text-xs text-muted-foreground">Next: {ob.nextDueDate}</span>
                  {ob.autopay && <Badge variant="outline" className="text-[10px]">Autopay</Badge>}
                </div>
                {ob.payments.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Recent payments</p>
                    {ob.payments.slice(-3).reverse().map(p => (
                      <div key={p.id} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{p.date}</span>
                        <span className="font-medium">{formatCurrency(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Expense History with edit/delete */}
      {expenses.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" /> Expense History
            </CardTitle>
          </CardHeader>
          <CardContent>
            {expenses.slice(0, 20).map(expense => (
              <div key={expense.id} className="flex items-center justify-between py-2 border-b border-border last:border-0 group" data-testid={`row-expense-${expense.id}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{expense.description}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-xs text-muted-foreground">{new Date(expense.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                    {expense.category && <Badge variant="secondary" className="text-[10px]">{expense.category}</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="text-sm font-semibold tabular-nums">{formatCurrency(expense.amount)}</span>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={() => openEdit(expense)} data-testid={`button-edit-expense-${expense.id}`}>
                    <Edit className="h-3 w-3" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive" onClick={() => setDeleteExpenseId(expense.id)} data-testid={`button-delete-expense-${expense.id}`}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {expenses.length === 0 && obligations.length === 0 && performanceHistory.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <DollarSign className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No financial data yet</p>
            <p className="text-xs text-muted-foreground mt-1">Add an expense above or use chat</p>
          </CardContent>
        </Card>
      )}

      {/* Add Expense Dialog */}
      <Dialog open={showAddExpense} onOpenChange={setShowAddExpense}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid="dialog-add-expense">
          <DialogHeader>
            <DialogTitle>Add Expense</DialogTitle>
            <DialogDescription>Add a new expense linked to this profile.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input className="mt-1" value={expDesc} onChange={e => setExpDesc(e.target.value)} placeholder="e.g. Vet visit" data-testid="input-expense-desc" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Amount ($)</label>
              <Input className="mt-1" type="number" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} placeholder="0.00" data-testid="input-expense-amount" />
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
            <Button onClick={() => createExpenseMutation.mutate()} disabled={createExpenseMutation.isPending || !expDesc || !expAmount} data-testid="button-save-expense">
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
              onClick={() => deleteExpenseId && deleteExpenseMutation.mutate(deleteExpenseId)}
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
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
                <Badge variant="secondary" className="text-[10px]">{tracker.category}</Badge>
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
          <Button variant="secondary" size="sm" className="h-6 text-[10px] px-2 gap-1" onClick={() => onLogEntry(tracker.id)} data-testid={`button-log-entry-${tracker.id}`}>
            <Plus className="h-3 w-3" /> Log Entry
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2 gap-1 text-muted-foreground" onClick={() => onUnlink(tracker.id)} data-testid={`button-unlink-tracker-${tracker.id}`}>
            <Unlink className="h-3 w-3" /> Unlink
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2 gap-1 text-destructive" onClick={() => onDeleteTracker(tracker.id)} data-testid={`button-delete-tracker-${tracker.id}`}>
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
                    <span className="text-muted-foreground text-[10px]">
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
                className="mt-1 h-6 text-[10px] w-full flex items-center gap-1 text-muted-foreground"
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

  // All trackers for linking
  const { data: allTrackers } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers"],
    queryFn: async () => { const res = await apiRequest("GET", "/api/trackers"); return res.json(); },
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
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
    onError: (err: Error) => toast({ title: "Failed to delete tracker", description: err.message, variant: "destructive" }),
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
    onSuccess: () => {
      toast({ title: "Entry logged" });
      setShowLogEntry(null);
      setEntryValue(""); setEntryNotes("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
      <Dialog open={showCreateTracker} onOpenChange={setShowCreateTracker}>
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
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onCreated();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
  const healthCats = ["health", "fitness", "weight", "sleep", "wellness", "nutrition"];
  const healthTrackers = profile.relatedTrackers.filter((t: any) =>
    healthCats.some(c => (t.category || "").toLowerCase().includes(c) || (t.name || "").toLowerCase().includes(c))
  );

  // Extract latest vitals from trackers
  const vitals: { name: string; value: string; unit: string; trend: "up" | "down" | "flat" }[] = [];
  for (const t of healthTrackers.slice(0, 6)) {
    const pf = t.fields?.find((f: any) => f.isPrimary) || t.fields?.[0];
    const fn = pf?.name || "value";
    const sorted = [...(t.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const latest = sorted[0]?.values?.[fn];
    const prev = sorted[1]?.values?.[fn];
    if (latest == null) continue;
    const trend: "up" | "down" | "flat" = typeof latest === "number" && typeof prev === "number"
      ? latest > prev ? "up" : latest < prev ? "down" : "flat" : "flat";
    vitals.push({ name: t.name, value: String(latest), unit: pf?.unit || t.unit || "", trend });
  }

  // Group trackers by category
  const groups: Record<string, typeof healthTrackers> = {};
  for (const t of healthTrackers) {
    const cat = (t.category || "custom").toLowerCase();
    const group = cat.includes("fitness") ? "Fitness" : cat.includes("nutrition") ? "Nutrition" : cat.includes("sleep") ? "Sleep" : "Vitals";
    (groups[group] ||= []).push(t);
  }

  if (healthTrackers.length === 0) {
    return (
      <div className="space-y-3">
        <Card>
          <CardContent className="py-8 text-center">
            <HeartPulse className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No health data yet</p>
            <p className="text-xs text-muted-foreground mt-2 mb-4">Create a health tracker to start logging data</p>
            <div className="flex flex-wrap gap-2 justify-center">
              <QuickHealthButton profileId={profile.id} name="Weight" unit={profile.type === 'pet' ? 'lbs' : 'lbs'} field="weight" category="health" onCreated={onChanged} />
              <QuickHealthButton profileId={profile.id} name="Blood Pressure" unit="mmHg" field="systolic" category="health" onCreated={onChanged} />
              <QuickHealthButton profileId={profile.id} name="Medication" unit="" field="medication" category="health" fieldType="text" onCreated={onChanged} />
              {profile.type === 'pet' && (
                <QuickHealthButton profileId={profile.id} name="Vaccination" unit="" field="vaccine" category="health" fieldType="text" onCreated={onChanged} />
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Vitals Summary */}
      {vitals.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
              <Heart className="h-3.5 w-3.5 text-primary" /> Latest Vitals
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-2.5 pt-0">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {vitals.map(v => (
                <div key={v.name} className="flex items-center gap-2 p-2 rounded-lg bg-muted/40">
                  <div className="flex-1 min-w-0">
                    <p className="text-[9px] text-muted-foreground truncate">{v.name}</p>
                    <div className="flex items-center gap-1">
                      <span className="text-sm font-bold tabular-nums">{v.value}</span>
                      {v.unit && <span className="text-[10px] text-muted-foreground">{v.unit}</span>}
                      {v.trend === "up" && <ArrowUp className="h-2.5 w-2.5 text-green-500" />}
                      {v.trend === "down" && <ArrowDown className="h-2.5 w-2.5 text-red-500" />}
                      {v.trend === "flat" && <Minus className="h-2.5 w-2.5 text-muted-foreground" />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Grouped Trackers */}
      {Object.entries(groups).map(([group, trks]) => (
        <div key={group}>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 px-1">{group}</p>
          <TrackersTab trackers={trks} profileId={profile.id} onChanged={onChanged} />
        </div>
      ))}
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
              <Badge variant="secondary" className="text-[9px] h-4 px-1 ml-0.5">{typeCounts[f]}</Badge>
            )}
          </Button>
        ))}
      </div>

      {/* Grouped entries */}
      {groups.filter(g => g.items.length > 0).map(g => (
        <div key={g.label}>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 px-1">{g.label}</p>
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
    mutationFn: async ({ taskId, status }: { taskId: string; status: "todo" | "done" }) => {
      const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update task", description: err.message, variant: "destructive" });
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
      toast({ title: "Task created" });
      setShowAddTask(false);
      setTaskTitle(""); setTaskDesc(""); setTaskPriority("medium"); setTaskDueDate("");
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "task", entityId: id });
    },
    onSuccess: () => {
      toast({ title: "Task deleted" });
      setDeleteTaskId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
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
                    onClick={() => toggleMutation.mutate({ taskId: task.id, status: isDone ? "todo" : "done" })}
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
                        <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium capitalize border ${PRIORITY_BADGE[task.priority] || "bg-muted text-muted-foreground"}`}>
                          {task.priority}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      {task.status && !isDone && (
                        <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium capitalize ${statusBadge(task.status)}`}>
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
      <Dialog open={showAddTask} onOpenChange={setShowAddTask}>
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
              onClick={() => deleteTaskId && deleteTaskMutation.mutate(deleteTaskId)}
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
      toast({ title: "Profile updated" });
      onSaved();
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const editableFieldKeys = Object.entries(profile.fields)
    .filter(([_, v]) => v != null && typeof v !== "object")
    .map(([k]) => k);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto" data-testid="dialog-edit-profile">
        <DialogHeader>
          <DialogTitle>Edit Profile</DialogTitle>
          <DialogDescription>Update profile details below.</DialogDescription>
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
          <div>
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <Input
              className="mt-1"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              data-testid="input-profile-notes"
            />
          </div>
          {editableFieldKeys.map(key => (
            <div key={key}>
              <label className="text-xs font-medium text-muted-foreground">{formatKey(key)}</label>
              <Input
                className="mt-1"
                value={fields[key] ?? ""}
                onChange={e => setFields(prev => ({ ...prev, [key]: e.target.value }))}
                data-testid={`input-field-${key}`}
              />
            </div>
          ))}
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

// Dynamic entity-specific tab configs — each entity type gets tabs that make sense for it
const ENTITY_TABS: Record<string, TabDef[]> = {
  // Person / Self — full life hub
  person: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "health", label: "Health", testId: "tab-health" },
    { value: "finances", label: "Finance", testId: "tab-finances" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "tasks", label: "Tasks", testId: "tab-tasks" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  self: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "health", label: "Health", testId: "tab-health" },
    { value: "finances", label: "Finance", testId: "tab-finances" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "tasks", label: "Tasks", testId: "tab-tasks" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Pet — health + care focused
  pet: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "health", label: "Health", testId: "tab-health" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "tasks", label: "Tasks", testId: "tab-tasks" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Vehicle — maintenance + cost focused
  vehicle: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "tasks", label: "Tasks", testId: "tab-tasks" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Loan — payment focused
  loan: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "finances", label: "Payments", testId: "tab-finances" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Investment
  investment: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "finances", label: "Performance", testId: "tab-finances" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Subscription
  subscription: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "finances", label: "Billing", testId: "tab-finances" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Medical provider
  medical: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "health", label: "Health", testId: "tab-health" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Property / Home
  property: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "tasks", label: "Tasks", testId: "tab-tasks" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
  // Asset (laptop, device, etc.)
  asset: [
    { value: "info", label: "Profile", testId: "tab-info" },
    { value: "finances", label: "Expenses", testId: "tab-finances" },
    { value: "trackers", label: "Linked", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "tasks", label: "Tasks", testId: "tab-tasks" },
    { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  ],
};

// Fallback for any type not explicitly defined
const DEFAULT_TABS: TabDef[] = [
  { value: "info", label: "Profile", testId: "tab-info" },
  { value: "finances", label: "Finance", testId: "tab-finances" },
  { value: "notes", label: "Notes", testId: "tab-notes" },
  { value: "trackers", label: "Linked", testId: "tab-trackers" },
  { value: "timeline", label: "Timeline", testId: "tab-timeline" },
];

function getTabsForType(type: string, profile?: any): TabDef[] {
  const baseTabs = ENTITY_TABS[type] || DEFAULT_TABS;
  
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
        case "trackers": return true; // Linked tab always prominent — it's the hub for docs, trackers, and child profiles
        case "finances": return (profile.relatedExpenses || []).length > 0;
        case "tasks": return (profile.relatedTasks || []).length > 0;
        case "documents": return (profile.relatedDocuments || []).length > 0;
        case "notes": return !!(profile.notes && profile.notes.trim());
        case "timeline": return ((profile.relatedEvents || []).length + (profile.relatedTasks || []).length) > 0;
        default: return false;
      }
    })();
    
    if (hasData) {
      withData.push(tab);
    } else {
      withoutData.push(tab);
    }
  }
  
  // Data tabs first, then empty tabs (still accessible but deprioritized)
  return [...withData, ...withoutData];
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
      toast({ title: "Notes saved" });
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to save notes", description: err.message, variant: "destructive" }),
  });

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Notes</h3>
            {updatedAt && (
              <span className="text-[10px] text-muted-foreground">
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
            <p className="text-[10px] text-muted-foreground mt-1 text-right">{notes.length} characters</p>
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

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [linkedFilter, setLinkedFilter] = useState<"all" | "profiles" | "trackers" | "documents">("all");

  const { data: profile, isLoading, refetch } = useQuery<ProfileDetail>({
    queryKey: ["/api/profiles", id, "detail"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${id}/detail`);
      return res.json();
    },
    enabled: !!id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Profile deleted" });
      // Cascade: profile delete also removes linked obligations, events, expenses, etc.
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      navigate("/profiles");
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  function handleSaved() {
    queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    refetch();
  }

  if (isLoading || !profile) {
    return (
      <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full">
        <div className="h-8 w-32 rounded skeleton-shimmer" />
        <div className="h-32 rounded-lg skeleton-shimmer" />
        <div className="h-48 rounded-lg skeleton-shimmer" />
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full pb-24" data-testid="page-profile-detail">
      {/* Hero Header */}
      <div className={`bg-gradient-to-b ${profileGradient(profile.type)} px-4 md:px-6 pt-4 pb-6`}>
        <div className="flex items-center justify-between mb-3">
          <Link href="/profiles" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors" data-testid="button-back-profiles">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Profiles
          </Link>
          <div className="flex gap-1.5">
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
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${profileAccent(profile.type)}`}>
            {profileIcon(profile.type)}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-semibold" data-testid="text-profile-detail-name">{profile.name}</h1>
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Badge variant="secondary" className="text-xs capitalize">{profile.type}</Badge>
              {profile.tags.map(tag => (
                <Badge key={tag} variant="outline" className="text-[10px]">
                  <Tag className="h-2.5 w-2.5 mr-0.5" />{tag}
                </Badge>
              ))}
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
          if (tabSet.has("trackers"))  stats.push({ label: "Linked", value: profile.relatedTrackers.length + (profile.childProfiles || []).length });
          if (tabSet.has("finances"))  stats.push({ label: ptype === 'subscription' ? "Billing" : "Expenses", value: profile.relatedExpenses.length });
          if (tabSet.has("tasks"))     stats.push({ label: "Tasks",    value: profile.relatedTasks.length });
          if (tabSet.has("documents")) stats.push({ label: "Docs",     value: profile.relatedDocuments.length });
          const gridCls = stats.length <= 3 ? "grid-cols-3" : stats.length <= 4 ? "grid-cols-4" : "grid-cols-5";
          return (
            <div className={`grid ${gridCls} gap-2 mt-4`}>
              {stats.map(stat => (
                <div key={stat.label} className="text-center py-2 rounded-lg bg-background/60 backdrop-blur-sm">
                  <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
                  <p className="text-[10px] text-muted-foreground">{stat.label}</p>
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

      {/* Type-specific Tabs */}
      <div className="px-4 md:px-6 pb-6">
        {(() => {
          const tabs = getTabsForType(profile.type, profile);
          const tabValues = new Set(tabs.map(t => t.value));
          return (
            <Tabs defaultValue="info" className="mt-4">
              <div className="overflow-x-auto -mx-4 px-4 pb-1 sticky top-0 z-20 bg-background border-b border-border/50" style={{WebkitOverflowScrolling: 'touch'}}>
                <TabsList className="inline-flex h-9 w-max gap-1 p-1">
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
                </TabsContent>
              )}

              {tabValues.has("health") && (
                <TabsContent value="health" className="mt-4 px-1 sm:px-0">
                  <HealthTabView profile={profile} onChanged={handleSaved} />
                </TabsContent>
              )}

              {tabValues.has("trackers") && (
                <TabsContent value="trackers" className="mt-4 px-1 sm:px-0">
                  {/* Filter pills for Linked tab */}
                  {(() => {
                    const childCount = (profile.childProfiles || []).length;
                    const trackerCount = profile.relatedTrackers.length;
                    const docCount = profile.relatedDocuments.length;
                    const total = childCount + trackerCount + docCount;
                    // Only show filter pills if there are items in multiple sections
                    const nonEmptySections = [childCount > 0, trackerCount > 0, docCount > 0].filter(Boolean).length;
                    if (nonEmptySections <= 1) return null;
                    return (
                      <div className="flex items-center gap-1 mb-3 flex-wrap" data-testid="linked-tab-filters">
                        <button onClick={() => setLinkedFilter("all")} className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${linkedFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>All ({total})</button>
                        {childCount > 0 && <button onClick={() => setLinkedFilter("profiles")} className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${linkedFilter === "profiles" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>Assets ({childCount})</button>}
                        {trackerCount > 0 && <button onClick={() => setLinkedFilter("trackers")} className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${linkedFilter === "trackers" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>Trackers ({trackerCount})</button>}
                        {docCount > 0 && <button onClick={() => setLinkedFilter("documents")} className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${linkedFilter === "documents" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>Documents ({docCount})</button>}
                      </div>
                    );
                  })()}
                  {/* Child profiles (assets, subscriptions, loans nested under this profile) */}
                  {(linkedFilter === "all" || linkedFilter === "profiles") && (profile.childProfiles || []).length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">Linked Profiles</p>
                      <div className="space-y-2">
                        {(profile.childProfiles || []).map(child => {
                          const childFields = Object.entries(child.fields || {}).filter(([k, v]) => v != null && v !== '' && !k.startsWith('_'));
                          const iconMap: Record<string, any> = { subscription: CreditCard, vehicle: Car, asset: Star, loan: CreditCard, investment: TrendingUp, property: Building2 };
                          const Icon = iconMap[child.type] || Link2;
                          return (
                            <div key={child.id} className="rounded-lg border bg-card overflow-hidden">
                              <div className="flex items-center gap-3 p-3">
                                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                  <Icon className="h-4 w-4 text-primary" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium">{child.name}</p>
                                  <p className="text-[10px] text-muted-foreground capitalize">{child.type}{child.fields?.cost ? ` · $${child.fields.cost}` : ''}{child.fields?.frequency ? `/${child.fields.frequency}` : ''}</p>
                                </div>
                                <Link href={`/profiles/${child.id}`}>
                                  <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0">View</Button>
                                </Link>
                              </div>
                              {childFields.length > 0 && (
                                <div className="px-3 pb-2.5 border-t border-border/50">
                                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2">
                                    {childFields.slice(0, 6).map(([k, v]) => (
                                      <div key={k} className="flex justify-between items-center">
                                        <span className="text-[10px] text-muted-foreground capitalize">{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                                        <span className="text-[10px] font-medium">{String(v)}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {/* Trackers */}
                  {(linkedFilter === "all" || linkedFilter === "trackers") && (
                    <TrackersTab trackers={profile.relatedTrackers} profileId={profile.id} onChanged={handleSaved} />
                  )}
                  {/* Documents — always show with upload capability */}
                  {(linkedFilter === "all" || linkedFilter === "documents") && (
                    <div className="mt-4">
                      <DocumentsTab
                        documents={profile.relatedDocuments}
                        profileId={profile.id}
                        childProfiles={profile.childProfiles}
                        onUploaded={handleSaved}
                      />
                    </div>
                  )}
                </TabsContent>
              )}

              {tabValues.has("finances") && (
                <TabsContent value="finances" className="mt-4 px-1 sm:px-0">
                  <FinancesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
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
