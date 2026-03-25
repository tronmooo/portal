import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import type { ProfileDetail, Document, TimelineEntry, Tracker } from "@shared/schema";
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

function InfoTab({
  profile,
  onEdit,
}: {
  profile: ProfileDetail;
  onEdit: () => void;
}) {
  const [customFields, setCustomFields] = useState<{ key: string; value: string }[]>([]);
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

  // Type-specific field groups
  const medicalKeys = ["allergies", "medicalHistory", "medications", "conditions", "bloodType", "height", "weight"];
  const vetKeys = ["vetName", "vetPhone", "vetAddress", "lastVisit", "nextAppointment", "vetClinic"];
  const healthKeys = ["vaccinations", "medications", "conditions", "dietNotes"];
  const insuranceKeys = ["insuranceProvider", "policyNumber", "premium", "coverage", "deductible", "insuranceExpiration", "insurer", "policyExpiry"];
  const maintenanceHistory: any[] = Array.isArray(profile.fields.maintenanceHistory) ? profile.fields.maintenanceHistory : [];
  const warrantyKeys = ["warrantyProvider", "warrantyExpiration", "warrantyCoverage", "warrantyExpiry", "warrantyMonths"];

  const isPerson = profile.type === "person" || profile.type === "self";
  const isPet = profile.type === "pet";
  const isVehicle = profile.type === "vehicle";
  const isAsset = profile.type === "asset";
  const isLoan = profile.type === "loan";
  const isInvestment = profile.type === "investment";
  const isSubscription = profile.type === "subscription";

  const hasInsuranceFields = isVehicle && Object.entries(profile.fields).some(
    ([k, v]) => (insuranceKeys.includes(k) || k.toLowerCase().includes("insurance") || k.toLowerCase().includes("policy")) && v != null && v !== "" && typeof v !== "object"
  );
  const hasMedicalFields = isPerson && medicalKeys.some(k => profile.fields[k]);
  const hasVetFields = isPet && vetKeys.some(k => profile.fields[k]);
  const hasHealthFields = isPet && healthKeys.some(k => profile.fields[k]);
  const hasWarrantyFields = isAsset && Object.entries(profile.fields).some(
    ([k, v]) => (warrantyKeys.includes(k) || k.toLowerCase().includes("warrant")) && v != null && v !== "" && typeof v !== "object"
  );

  return (
    <div className="space-y-4">
      {/* Main Details */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-semibold">Details</CardTitle>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onEdit} data-testid="button-edit-profile">
            <Edit className="h-3 w-3" /> Edit
          </Button>
        </CardHeader>
        <CardContent>
          {fields.length > 0 ? (
            <div className="space-y-0">
              {fields.map(([key, val]) => (
                <div key={key} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <span className="text-xs text-muted-foreground">{formatKey(key)}</span>
                  <span className="text-sm font-medium text-right max-w-[60%] truncate">{String(val)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">No details yet. Add info via chat.</p>
          )}

          {/* Add custom field */}
          {addingField ? (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              <div className="flex gap-2">
                <Input
                  placeholder="Field name"
                  value={newFieldKey}
                  onChange={e => setNewFieldKey(e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-new-field-key"
                />
                <Input
                  placeholder="Value"
                  value={newFieldValue}
                  onChange={e => setNewFieldValue(e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-new-field-value"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { setAddingField(false); setNewFieldKey(""); setNewFieldValue(""); }} data-testid="button-cancel-add-field">
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!newFieldKey.trim() || saveCustomFieldMutation.isPending}
                  onClick={() => saveCustomFieldMutation.mutate({ key: newFieldKey.trim(), value: newFieldValue })}
                  data-testid="button-save-new-field"
                >
                  {saveCustomFieldMutation.isPending ? "Saving..." : "Add"}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 text-xs gap-1 text-muted-foreground hover:text-foreground w-full"
              onClick={() => setAddingField(true)}
              data-testid="button-add-custom-field"
            >
              <Plus className="h-3 w-3" /> Add Field
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {profile.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" /> Notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{profile.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Tags */}
      {profile.tags.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Tag className="h-4 w-4 text-muted-foreground" /> Tags
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {profile.tags.map(tag => (
                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Person/Self: Medical Info */}
      {hasMedicalFields && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Heart className="h-4 w-4 text-muted-foreground" /> Medical Info
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {medicalKeys.filter(k => profile.fields[k]).map(k => (
                <div key={k} className="flex items-start justify-between py-2 border-b border-border last:border-0">
                  <span className="text-xs text-muted-foreground">{formatKey(k)}</span>
                  <span className="text-sm font-medium text-right max-w-[60%]">{String(profile.fields[k])}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pet: Vet Info */}
      {hasVetFields && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Stethoscope className="h-4 w-4 text-muted-foreground" /> Veterinarian
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {vetKeys.filter(k => profile.fields[k]).map(k => (
                <div key={k} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {k.toLowerCase().includes("phone") && <Phone className="h-3 w-3" />}
                    {k.toLowerCase().includes("address") && <MapPin className="h-3 w-3" />}
                    {k.toLowerCase().includes("appoint") && <Calendar className="h-3 w-3" />}
                    {formatKey(k)}
                  </div>
                  <span className="text-sm font-medium text-right max-w-[60%] truncate">{String(profile.fields[k])}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pet: Health Fields */}
      {hasHealthFields && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Heart className="h-4 w-4 text-muted-foreground" /> Health Information
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {healthKeys.filter(k => profile.fields[k]).map(k => (
                <div key={k} className="flex items-start justify-between py-2 border-b border-border last:border-0">
                  <span className="text-xs text-muted-foreground">{formatKey(k)}</span>
                  <span className="text-sm font-medium text-right max-w-[60%]">{String(profile.fields[k])}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Vehicle: Insurance Info */}
      {hasInsuranceFields && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" /> Insurance Policy
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {Object.entries(profile.fields)
                .filter(([k, v]) => (insuranceKeys.includes(k) || k.toLowerCase().includes("insurance") || k.toLowerCase().includes("policy")) && v != null && v !== "" && typeof v !== "object")
                .map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                    <span className="text-xs text-muted-foreground">{formatKey(k)}</span>
                    <span className="text-sm font-medium text-right max-w-[60%] truncate">{String(v)}</span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Vehicle: Maintenance History */}
      {isVehicle && maintenanceHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Wrench className="h-4 w-4 text-muted-foreground" /> Maintenance History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {maintenanceHistory.map((item: any, idx: number) => (
                <div key={idx} className="border border-border rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">{item.type || "Service"}</p>
                    {item.cost != null && (
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(Number(item.cost))}</span>
                    )}
                  </div>
                  <div className="flex gap-3 mt-1.5 flex-wrap">
                    {item.date && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Calendar className="h-3 w-3" />{item.date}
                      </span>
                    )}
                    {item.mileage && (
                      <span className="text-xs text-muted-foreground">{item.mileage} mi</span>
                    )}
                  </div>
                  {item.notes && <p className="text-xs text-muted-foreground mt-1">{item.notes}</p>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Asset: Warranty Info */}
      {hasWarrantyFields && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" /> Warranty Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-0">
              {Object.entries(profile.fields)
                .filter(([k, v]) => (warrantyKeys.includes(k) || k.toLowerCase().includes("warrant")) && v != null && v !== "" && typeof v !== "object")
                .map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                    <span className="text-xs text-muted-foreground">{formatKey(k)}</span>
                    <span className="text-sm font-medium text-right max-w-[60%] truncate">{String(v)}</span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loan: Balance Summary */}
      {isLoan && (profile.fields.remainingBalance || profile.fields.balance || profile.fields.originalAmount) && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 gap-4">
              {profile.fields.originalAmount && (
                <div>
                  <p className="text-xs text-muted-foreground">Original Amount</p>
                  <p className="text-lg font-semibold tabular-nums">{formatCurrency(Number(profile.fields.originalAmount))}</p>
                </div>
              )}
              {(profile.fields.remainingBalance || profile.fields.balance) && (
                <div>
                  <p className="text-xs text-muted-foreground">Remaining Balance</p>
                  <p className="text-lg font-semibold tabular-nums text-orange-600">
                    {formatCurrency(Number(profile.fields.remainingBalance || profile.fields.balance))}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Investment: Balance Summary */}
      {isInvestment && (profile.fields.balance || profile.fields.contributions) && (
        <Card>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 gap-4">
              {profile.fields.balance && (
                <div>
                  <p className="text-xs text-muted-foreground">Current Balance</p>
                  <p className="text-xl font-semibold tabular-nums text-green-600">{formatCurrency(Number(profile.fields.balance))}</p>
                </div>
              )}
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

      {/* Subscription: Billing Summary */}
      {isSubscription && (profile.fields.cost || profile.fields.price) && profile.fields.frequency && (
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Billing</p>
              <p className="text-xl font-semibold tabular-nums">{formatCurrency(Number(profile.fields.cost || profile.fields.price))}</p>
            </div>
            <Badge variant="secondary" className="capitalize">{String(profile.fields.frequency)}</Badge>
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
  onUploaded,
}: {
  documents: ProfileDetail["relatedDocuments"];
  profileId: string;
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

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
      const res = await apiRequest("POST", "/api/upload", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded", description: "File has been linked to this profile." });
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
      <div className="flex justify-end mb-3">
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

      {documents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No linked documents</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a file to get started</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {documents.map(doc => {
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
                <CardContent className="p-3 flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                    doc.mimeType.startsWith("image/") ? "bg-blue-500/10 text-blue-500" : "bg-red-500/10 text-red-500"
                  }`}>
                    {doc.mimeType.startsWith("image/") ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{doc.name}</p>
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
                    </div>
                  </div>
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
        <DialogContent className="max-w-md" data-testid="dialog-add-expense">
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
        <DialogContent className="max-w-md" data-testid="dialog-edit-expense">
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
        <DialogContent className="max-w-md" data-testid="dialog-create-tracker">
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
        <DialogContent className="max-w-md" data-testid="dialog-link-tracker">
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
        <DialogContent className="max-w-md" data-testid="dialog-log-entry">
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

function TimelineTab({ timeline }: { timeline: TimelineEntry[] }) {
  return timeline.length === 0 ? (
    <Card>
      <CardContent className="py-8 text-center">
        <Clock className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No activity yet</p>
      </CardContent>
    </Card>
  ) : (
    <Card>
      <CardContent className="pt-4">
        <div className="divide-y divide-border">
          {timeline.slice(0, 30).map(entry => (
            <TimelineItem key={entry.id} entry={entry} />
          ))}
        </div>
      </CardContent>
    </Card>
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
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const open = tasks.filter(t => t.status !== "done");
  const done = tasks.filter(t => t.status === "done");

  function priorityDot(priority: string) {
    const colors: Record<string, string> = {
      high: "bg-red-500",
      medium: "bg-amber-500",
      low: "bg-green-500",
      urgent: "bg-red-600",
    };
    return colors[priority] || "bg-muted-foreground";
  }

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
      {/* Add Task Button */}
      <div className="flex justify-end">
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

      {/* Open tasks */}
      {open.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Circle className="h-4 w-4 text-muted-foreground" /> Open ({open.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            {open.map(task => (
              <div
                key={task.id}
                className="flex items-start gap-3 py-2.5 border-b border-border last:border-0 group"
                data-testid={`row-task-${task.id}`}
              >
                <button
                  onClick={() => toggleMutation.mutate({ taskId: task.id, status: "done" })}
                  disabled={toggleMutation.isPending}
                  className="mt-0.5 shrink-0 w-4 h-4 rounded-full border border-border hover:border-primary hover:bg-primary/10 transition-colors"
                  data-testid={`button-complete-task-${task.id}`}
                  aria-label="Mark complete"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{task.title}</span>
                    {task.priority && (
                      <div className={`w-2 h-2 rounded-full shrink-0 ${priorityDot(task.priority)}`} title={task.priority} />
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    {task.status && (
                      <span className={`text-[10px] rounded-full px-1.5 py-0.5 font-medium capitalize ${statusBadge(task.status)}`}>
                        {task.status.replace("-", " ")}
                      </span>
                    )}
                    {task.dueDate && (
                      <span className={`text-xs flex items-center gap-1 ${new Date(task.dueDate) < new Date() ? "text-red-500" : "text-muted-foreground"}`}>
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
            ))}
          </CardContent>
        </Card>
      )}

      {/* Done tasks */}
      {done.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-muted-foreground">
              <CheckCheck className="h-4 w-4" /> Completed ({done.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-0">
            {done.map(task => (
              <div
                key={task.id}
                className="flex items-start gap-3 py-2.5 border-b border-border last:border-0 opacity-60 group"
                data-testid={`row-task-done-${task.id}`}
              >
                <button
                  onClick={() => toggleMutation.mutate({ taskId: task.id, status: "todo" })}
                  disabled={toggleMutation.isPending}
                  className="mt-0.5 shrink-0"
                  data-testid={`button-reopen-task-${task.id}`}
                  aria-label="Mark incomplete"
                >
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                </button>
                <div className="flex-1 min-w-0">
                  <span className="text-sm line-through text-muted-foreground">{task.title}</span>
                  {task.dueDate && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Due {new Date(task.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </p>
                  )}
                </div>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive" onClick={() => setDeleteTaskId(task.id)} data-testid={`button-delete-done-task-${task.id}`}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Add Task Dialog */}
      <Dialog open={showAddTask} onOpenChange={setShowAddTask}>
        <DialogContent className="max-w-md" data-testid="dialog-add-task">
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

  const mutation = useMutation({
    mutationFn: async () => {
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
// UNIVERSAL TABS DEFINITION
// ============================================================

const UNIVERSAL_TABS = [
  { value: "info", label: "Info", testId: "tab-info" },
  { value: "health", label: "Health", testId: "tab-health" },
  { value: "trackers", label: "Trackers", testId: "tab-trackers" },
  { value: "documents", label: "Documents", testId: "tab-documents" },
  { value: "finances", label: "Finances", testId: "tab-finances" },
  { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  { value: "tasks", label: "Tasks", testId: "tab-tasks" },
] as const;

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

  const { data: profile, isLoading, refetch } = useQuery<ProfileDetail>({
    queryKey: ["/api/profiles", id, "detail"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${id}/detail`);
      return res.json();
    },
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Profile deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
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
    <div className="overflow-y-auto h-full" data-testid="page-profile-detail">
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

        {/* Quick stats */}
        <div className="grid grid-cols-4 gap-2 mt-4">
          {[
            { label: "Health", value: profile.relatedTrackers.length },
            { label: "Expenses", value: profile.relatedExpenses.length },
            { label: "Tasks", value: profile.relatedTasks.length },
            { label: "Docs", value: profile.relatedDocuments.length },
          ].map(stat => (
            <div key={stat.label} className="text-center py-2 rounded-lg bg-background/60 backdrop-blur-sm">
              <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
              <p className="text-[10px] text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* AI Summary Card */}
      <div className="px-4 md:px-6 pt-4">
        <AISummaryCard profileId={id} profileType={profile.type} />
      </div>

      {/* Universal Tabs */}
      <div className="px-4 md:px-6 pb-6">
        <Tabs defaultValue="info" className="mt-4">
          <div className="overflow-x-auto -mx-1 px-1">
            <TabsList className="w-full grid grid-cols-6 h-9">
              {UNIVERSAL_TABS.map(tab => (
                <TabsTrigger
                  key={tab.value}
                  value={tab.value}
                  className="text-xs"
                  data-testid={tab.testId}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="info" className="mt-4 px-1 sm:px-0">
            <InfoTab profile={profile} onEdit={() => setShowEditDialog(true)} />
          </TabsContent>

          <TabsContent value="health" className="mt-4 px-1 sm:px-0">
            <TrackersTab trackers={profile.relatedTrackers.filter((t: any) => ['health','fitness','weight','sleep','wellness','nutrition'].some(c => (t.category || '').toLowerCase().includes(c) || (t.name || '').toLowerCase().includes(c)))} profileId={profile.id} onChanged={handleSaved} />
          </TabsContent>

          <TabsContent value="trackers" className="mt-4 px-1 sm:px-0">
            <TrackersTab trackers={profile.relatedTrackers} profileId={profile.id} onChanged={handleSaved} />
          </TabsContent>

          <TabsContent value="documents" className="mt-4 px-1 sm:px-0">
            <DocumentsTab
              documents={profile.relatedDocuments}
              profileId={profile.id}
              onUploaded={handleSaved}
            />
          </TabsContent>

          <TabsContent value="finances" className="mt-4 px-1 sm:px-0">
            <FinancesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
          </TabsContent>

          <TabsContent value="timeline" className="mt-4 px-1 sm:px-0">
            <TimelineTab timeline={profile.timeline} />
          </TabsContent>

          <TabsContent value="tasks" className="mt-4 px-1 sm:px-0">
            <TasksTab
              tasks={profile.relatedTasks}
              profileId={profile.id}
              onChanged={handleSaved}
            />
          </TabsContent>
        </Tabs>
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
