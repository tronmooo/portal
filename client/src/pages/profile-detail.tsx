import { formatApiError } from "@/lib/formatError";
// Phase 1–9 asset rebuild (2026-05-26): all new pieces live in this module so
// profile-detail stays under control. The legacy ChildAssetsCard /
// ValueRollupCard / MaintenanceCard below still exist and are still used for
// non-asset profiles; for asset types we delegate to the rebuild.
import {
  ProfileBreadcrumb as RebuildBreadcrumb,
  OwnershipTree as RebuildOwnershipTree,
  // AssetSummaryCard and TopChildrenPreview removed from imports 2026-05-26 —
  // Overview is now identity-only; their data lives on Money/Financials/Contained
  // tabs already. The components remain exported in asset-overview.tsx in case
  // we need them again.
  FinancialsBreakdown as RebuildFinancials,
  OwnerControl as RebuildOwnerControl,
  AdoptAsChildDialog as RebuildAdoptDialog,
  ChildActionsMenu as RebuildChildActions,
  PathPreviewLine as RebuildPathPreview,
} from "@/components/asset/asset-overview";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { isPast, parseDate, relativeDayLabel, daysFromToday } from "@/lib/dates";
import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SmartFillTrigger } from "@/components/SmartFillTrigger";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  Flame,
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
  BookOpen,
  Users,
  Network,
  Link as LinkIcon,
  Cake,
  Droplet,
  Briefcase,
} from "lucide-react";
import { categoryTheme, type CategoryTheme } from "@/lib/category-theme";
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
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { calculateStreak } from "@shared/streak";
import { getUserToday, toLocalDateStr } from "@shared/timezone";
import { useToast } from "@/hooks/use-toast";
import { ShareButton } from "@/components/DocumentViewer";
import { DocumentViewerDialog } from "@/components/DocumentViewer";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import EditableTitle from "@/components/EditableTitle";
import { LinkedSheetView, LinkedViewToggle, useLinkedView, type SheetColumn } from "@/components/LinkedSheetView";
import { LiabilityProfilePage } from "@/pages/liability-detail";
// DynamicProfileDetail import removed — registry system not yet integrated (see registry/index.ts)

// ============================================================
// HELPERS
// ============================================================

// Keyboard activation helper for non-<button> clickable elements (a11y):
// makes Enter/Space behave like a click on role="button" divs.
const onEnterOrSpace = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

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
    journal: BookOpen,
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

// Safely stringify a profile field for display. Profile fields can be primitives,
// nested objects (legacy AI-extracted blobs), or arrays. Never render "[object Object]".
function stringifyField(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value.map(v => stringifyField(v)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const preferredKeys = ["value", "name", "label", "display", "text", "title"];
    for (const k of preferredKeys) {
      if (value[k] !== undefined && (typeof value[k] === "string" || typeof value[k] === "number")) {
        return String(value[k]);
      }
    }
    const entries = Object.entries(value)
      .filter(([_, v]) => v !== null && v !== undefined && v !== "" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
      .slice(0, 2)
      .map(([k, v]) => `${formatKey(k)}: ${v}`);
    if (entries.length) return entries.join(", ");
    return "";
  }
  try { return String(value); } catch { return ""; }
}

function formatCurrency(val: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(val);
}

// ============================================================
// NESTED ASSETS — ASSET ROLLUP HELPER
// DEFERRED: @shared/asset-rollup exists but walks fewer nested namespaces
// (e.g. it doesn't read fields.housing.currentValue, fields.vehicles.*, or
// sum a `loans[]` array). Swapping would regress value extraction for
// finance / housing / vehicles. Unify only after the shared helper covers
// every legacy path the local extractor handles.
// ============================================================

const NESTED_ASSET_TYPES = ["vehicle", "property", "investment", "asset", "account"] as const;
type NestedAssetType = typeof NESTED_ASSET_TYPES[number];

interface AssetRollup {
  baseValue: number;
  nestedValue: number;
  totalValue: number;
  baseLoans: number;
  nestedLoans: number;
  totalLoans: number;
  netValue: number;
  childCount: number;
  descendantCount: number;
  /** Sum of monthly recurring expenses on this profile + all descendants. */
  monthlyExpense: number;
  /** Sum of maintenance / service costs on this profile + all descendants. */
  maintenanceCost: number;
}

interface TreeNode {
  id: string;
  name: string;
  type: string;
  fields: any;
  parentProfileId?: string;
  children: TreeNode[];
}

// Walk every known camelCase + snake_case + nested storage path. Different
// code paths (form save, AI extraction, find-value, legacy migrations) wrote
// to different keys. Without nested coverage, profiles like Roth IRA (stored
// at fields.finance.balance) or Honda CRV (fields.other.purchase_price) report
// $0 in the rollup even though their values render in the Trackers grid.
function parseMoneyVal(v: any): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  return 0;
}
function firstPositive(...vals: any[]): number {
  for (const v of vals) {
    const n = parseMoneyVal(v);
    if (n > 0) return n;
  }
  return 0;
}
function getAssetBaseValue(fields: any): number {
  if (!fields) return 0;
  const f = fields, h = f.housing || {}, o = f.other || {}, fin = f.finance || {}, v = f.vehicle || {}, vs = f.vehicles || {}, inv = f.investment || {};
  return firstPositive(
    f.currentValue, f.current_value, h.currentValue, h.current_value, o.currentValue, o.current_value,
    f.marketValue, f.market_value, h.marketValue, h.market_value, o.marketValue, o.market_value,
    f.estimatedValue, f.estimated_value,
    f.value, o.value,
    f.purchasePrice, f.purchase_price, o.purchasePrice, o.purchase_price, h.purchasePrice, h.purchase_price,
    f.cost, o.cost, f.amount, o.amount, f.price, o.price,
    f.balance, fin.balance, fin.currentValue, fin.current_value, fin.value, fin.marketValue, fin.market_value,
    f.accountBalance, fin.accountBalance, fin.account_balance,
    v.purchasePrice, v.purchase_price, v.currentValue, v.current_value, v.value,
    vs.purchasePrice, vs.purchase_price, vs.currentValue, vs.current_value, vs.value,
    inv.balance, inv.value, inv.currentValue, inv.current_value
  );
}

function getAssetLoanValue(fields: any): number {
  if (!fields) return 0;
  const f = fields, fin = f.finance || {}, ln = f.loan || {}, o = f.other || {};
  const direct = firstPositive(
    f.loanBalance, f.loan_balance, f.remainingBalance, f.remaining_balance,
    f.outstandingBalance, f.outstanding_balance, f.mortgageBalance, f.mortgage_balance,
    fin.loanBalance, fin.loan_balance, fin.remainingBalance, fin.remaining_balance,
    fin.outstandingBalance, fin.outstanding_balance, fin.mortgageBalance, fin.mortgage_balance,
    ln.balance, ln.remainingBalance, ln.remaining_balance, ln.outstandingBalance, ln.outstanding_balance,
    o.remainingBalance, o.remaining_balance, o.balance
  );
  if (direct > 0) return direct;
  // Sum nested loans[] entries created by AI extraction
  const loans = Array.isArray(fin.loans) ? fin.loans : Array.isArray(f.loans) ? f.loans : [];
  if (loans.length > 0) {
    return loans.reduce((s: number, l: any) => s + parseMoneyVal(l?.balance || l?.remainingBalance || l?.remaining_balance), 0);
  }
  return 0;
}

function flattenTreeNodes(node: TreeNode): TreeNode[] {
  const result: TreeNode[] = [];
  for (const child of node.children) {
    result.push(child);
    result.push(...flattenTreeNodes(child));
  }
  return result;
}

// Pull a recurring monthly expense from a fields object, normalising yearly
// to monthly. Returns 0 if none found.
function getMonthlyExpense(fields: any): number {
  if (!fields || typeof fields !== "object") return 0;
  const direct = parseMoneyVal(
    fields.monthlyCost ?? fields.monthly_cost ??
    fields.monthlyExpense ?? fields.monthly_expense ??
    fields.monthlyPayment ?? fields.monthly_payment ??
    fields?.finance?.monthlyPayment ?? fields?.finance?.monthly_payment ??
    fields?.maintenance?.monthlyCost ?? fields?.expense?.monthlyCost,
  );
  if (direct > 0) return direct;
  const cost = parseMoneyVal(fields.cost ?? fields.amount ?? fields.price);
  const freq = String(fields.frequency || "").toLowerCase();
  if (cost > 0 && freq) {
    if (freq.startsWith("month")) return cost;
    if (freq.startsWith("year") || freq.startsWith("annual")) return cost / 12;
    if (freq.startsWith("week")) return cost * 4.345;
    if (freq.startsWith("day")) return cost * 30.44;
    if (freq.startsWith("quarter")) return cost / 3;
  }
  return 0;
}

// Pull a maintenance / service cost number from a fields object.
function getMaintenanceCost(fields: any): number {
  if (!fields || typeof fields !== "object") return 0;
  return parseMoneyVal(
    fields.maintenanceCost ?? fields.maintenance_cost ??
    fields.serviceCost ?? fields.service_cost ??
    fields.upkeepCost ?? fields.upkeep_cost ??
    fields?.maintenance?.totalCost ?? fields?.maintenance?.cost ??
    fields?.service?.totalCost ?? fields?.service?.cost,
  );
}

// computeAssetRollup is the SINGLE source of truth for asset value rollups
// across the entire app. Imported from shared/ so server, hooks, dashboard,
// detail page, and Financials tab all compute identical numbers. Previously
// there was an inline copy here that could drift from the shared version —
// removed 2026-05-27.
import { computeAssetRollup as sharedComputeAssetRollup } from "@shared/asset-rollup";
import { resolveAssetValue, resolveLiabilityBalance } from "@shared/asset-value";
function computeAssetRollup(profile: any, descendants: TreeNode[]): AssetRollup {
  // The shared function ignores everything except `fields` and
  // `parentProfileId`, which is exactly what TreeNode carries, so we can
  // pass them through as-is.
  const result = sharedComputeAssetRollup(profile, descendants as any);
  // Strip `breakdown` from the result — the local AssetRollup interface
  // doesn't declare it and the page doesn't render it (the new Financials
  // tab does, via asset-overview.tsx which has its own rollup call).
  return {
    baseValue: result.baseValue,
    nestedValue: result.nestedValue,
    totalValue: result.totalValue,
    baseLoans: result.baseLoans,
    nestedLoans: result.nestedLoans,
    totalLoans: result.totalLoans,
    netValue: result.netValue,
    childCount: result.childCount,
    descendantCount: result.descendantCount,
    monthlyExpense: result.monthlyExpense,
    maintenanceCost: result.maintenanceCost,
  };
}

// ============================================================
// NESTED ASSETS — BELONGS-TO EDITOR (Section 1)
// ============================================================

function BelongsToEditor({
  profile,
  allProfiles,
  onSaved,
}: {
  profile: ProfileDetail;
  allProfiles: any[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { toast } = useToast();

  // Fetch tree to know descendants (to exclude)
  const { data: treeData } = useQuery<TreeNode>({
    queryKey: ["/api/profiles", profile.id, "tree"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profile.id}/tree`);
      return res.json();
    },
    enabled: open,
    retry: false,
  });

  const descendantIds = useMemo(() => {
    if (!treeData) return new Set<string>();
    const ids = new Set<string>();
    const collect = (node: TreeNode) => {
      for (const c of node.children) {
        ids.add(c.id);
        collect(c);
      }
    };
    collect(treeData);
    return ids;
  }, [treeData]);

  // Candidate profiles: asset types + person/self/pet, not soft-deleted, not self, not descendants
  const candidateTypes = [...NESTED_ASSET_TYPES, "person", "self", "pet"];
  const candidates = useMemo(() => {
    return allProfiles
      .filter((p: any) =>
        candidateTypes.includes(p.type) &&
        p.id !== profile.id &&
        !descendantIds.has(p.id) &&
        !p.fields?.deleted
      )
      .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
  }, [allProfiles, descendantIds, profile.id]);

  const filtered = useMemo(() => {
    if (!search.trim()) return candidates;
    const q = search.toLowerCase();
    return candidates.filter((p: any) =>
      (p.name || "").toLowerCase().includes(q) || p.type.toLowerCase().includes(q)
    );
  }, [candidates, search]);

  const currentParentId = profile.parentProfileId || null;
  const currentParent = allProfiles.find((p: any) => p.id === currentParentId);

  const patchParent = useMutation({
    mutationFn: async (newParentId: string | null) => {
      const res = await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        parentProfileId: newParentId,
      });
      return res.json();
    },
    onSuccess: (_data, newParentId) => {
      toast({ title: newParentId ? "Parent updated" : "Detached from parent" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      if (currentParentId) {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", currentParentId, "detail"] });
      }
      if (newParentId && newParentId !== currentParentId) {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", newParentId, "detail"] });
      }
      onSaved();
      setOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <>
      <div className="flex items-center gap-2 py-1" data-testid="belongs-to-row">
        <span className="text-xs text-muted-foreground shrink-0">Located in:</span>
        <span className="text-xs font-medium flex-1 truncate">
          {currentParent ? currentParent.name : <span className="text-muted-foreground italic">None (top-level)</span>}
        </span>
        <button
          className="h-[44px] w-[44px] flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted active:bg-muted/80 shrink-0"
          onClick={() => setOpen(true)}
          aria-label="Edit parent"
          data-testid="button-edit-belongs-to"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm max-h-[80vh] flex flex-col" data-testid="dialog-belongs-to">
          <DialogHeader>
            <DialogTitle>Set Location</DialogTitle>
            <DialogDescription>Choose where this asset is located. This is its parent in the asset tree — not its owner. Use the Ownership editor to set ownership shares.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
            {/* Current path preview — shows where this asset currently lives */}
            <div className="px-2 py-2 rounded-md bg-muted/40 border" data-testid="belongs-to-current-path">
              <p className="text-[10px] text-muted-foreground mb-0.5">Currently:</p>
              <RebuildPathPreview
                parent={currentParent || null}
                allProfiles={allProfiles}
                childName={profile.name}
              />
            </div>
            <Input
              placeholder="Search profiles..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-xs"
              data-testid="input-belongs-to-search"
            />
            <div className="flex-1 overflow-y-auto space-y-1 pr-1" data-testid="list-belongs-to-candidates">
              {/* None option */}
              <button
                className={`w-full text-left px-3 py-3 rounded-lg text-xs hover:bg-muted transition-colors min-h-[44px] flex items-center gap-2 ${
                  !currentParentId ? "bg-primary/10 text-primary font-semibold" : ""
                }`}
                onClick={() => patchParent.mutate(null)}
                disabled={patchParent.isPending}
                data-testid="option-belongs-to-none"
              >
                <X className="h-3.5 w-3.5 shrink-0" />
                None (top-level)
              </button>
              {filtered.map((p: any) => (
                <button
                  key={p.id}
                  className={`w-full text-left px-3 py-3 rounded-lg text-xs hover:bg-muted transition-colors min-h-[44px] flex items-center gap-2 ${
                    p.id === currentParentId ? "bg-primary/10 text-primary font-semibold" : ""
                  }`}
                  onClick={() => patchParent.mutate(p.id)}
                  disabled={patchParent.isPending}
                  data-testid={`option-belongs-to-${p.id}`}
                >
                  <div className="h-5 w-5 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    {profileIcon(p.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="text-muted-foreground capitalize">{p.type}</p>
                  </div>
                  {p.id === currentParentId && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No matching profiles</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} className="h-[44px]">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ============================================================
// NESTED ASSETS — LOCATION EDITOR (Section 2)
// ============================================================

function LocationEditor({
  profile,
  onSaved,
}: {
  profile: ProfileDetail;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(profile.fields?.location || ""));
  const { toast } = useToast();

  const locationMut = useMutation({
    mutationFn: async (loc: string) => {
      const res = await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        fields: { ...profile.fields, location: loc },
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Location updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      onSaved();
      setEditing(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update location", description: err.message, variant: "destructive" });
    },
  });

  const currentLocation = String(profile.fields?.location || "");

  return (
    <div className="space-y-1" data-testid="location-editor">
      <div className="flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {editing ? (
          <div className="flex items-center gap-1 flex-1">
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. Kitchen, Garage, Safe..."
              className="h-8 text-xs flex-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") locationMut.mutate(value.trim());
                if (e.key === "Escape") { setValue(currentLocation); setEditing(false); }
              }}
              data-testid="input-location"
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-[44px] w-[44px] p-0"
              onClick={() => locationMut.mutate(value.trim())}
              disabled={locationMut.isPending}
              aria-label="Save location"
            >
              <Check className="h-3.5 w-3.5 text-green-500" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-[44px] w-[44px] p-0"
              onClick={() => { setValue(currentLocation); setEditing(false); }}
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-1">
            <span className="text-xs flex-1">
              {currentLocation || <span className="text-muted-foreground italic">No location set</span>}
            </span>
            <button
              className="h-[44px] w-[44px] flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted active:bg-muted/80 shrink-0"
              onClick={() => setEditing(true)}
              aria-label="Edit location"
              data-testid="button-edit-location"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      {currentLocation && (
        <p className="text-[11px] text-muted-foreground pl-5">
          If you later add an asset named &quot;{currentLocation}&quot; under the same parent, this item will move under it automatically.
        </p>
      )}
    </div>
  );
}

// ============================================================
// NESTED ASSETS — CHILD ASSETS CARD (Section 3)
// ============================================================

function ChildAssetsCard({
  profile,
  onChildAdded,
}: {
  profile: ProfileDetail;
  onChildAdded: () => void;
}) {
  const [showAddChild, setShowAddChild] = useState(false);
  const [childName, setChildName] = useState("");
  const [childType, setChildType] = useState<NestedAssetType>("asset");
  // ADOPT-AS-CHILD (2026-05-26 redesign): the inline picker that used to live
  // here was renamed to "Adopt as Child" and moved into a dedicated component
  // with a preview + two-step confirm flow. That removes the reversed-parent
  // footgun that bit the user on 2026-05-26.
  const [showAdopt, setShowAdopt] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { view: assetView, setView: setAssetView } = useLinkedView(); // Wave 15
  // NESTED-DEPTH (2026-05-25): the user wants infinite nesting (Home →
  // Furniture → Couch → Screws). Previously only direct children showed,
  // so reaching a deep node took N clicks. Toggle "Direct / Full tree"
  // lets the user see the whole subtree from any level with depth indent.
  const [treeMode, setTreeMode] = useState<"direct" | "full">("direct");

  const directChildren = useMemo(() => {
    const all = ((profile as any).childProfiles || []) as any[];
    return all.filter((c) => NESTED_ASSET_TYPES.includes(c.type as NestedAssetType));
  }, [profile]);

  // Fetch the entire subtree so we can render "Full tree" view on demand.
  // Server endpoint already exists — used elsewhere for rollup math.
  const { data: subtreeData } = useQuery<TreeNode>({
    queryKey: ["/api/profiles", profile.id, "tree"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profile.id}/tree`);
      return res.json();
    },
    retry: false,
  });

  // Flatten subtree into rows with depth, skipping the root (== profile itself).
  // Only asset-type nodes are rendered as children — person nodes don't belong
  // in this card.
  type DepthRow = { id: string; name: string; type: string; fields: any; depth: number; ownershipPct?: number };
  const subtreeRows = useMemo((): DepthRow[] => {
    if (!subtreeData) return [];
    const rows: DepthRow[] = [];
    const walk = (node: TreeNode, depth: number) => {
      for (const child of (node.children || [])) {
        if (NESTED_ASSET_TYPES.includes(child.type as NestedAssetType)) {
          rows.push({ id: child.id, name: child.name, type: child.type, fields: child.fields, depth });
        }
        walk(child, depth + 1);
      }
    };
    walk(subtreeData, 0);
    return rows;
  }, [subtreeData]);

  const hasDeepDescendants = subtreeRows.length > directChildren.length;
  const visibleChildren: DepthRow[] = treeMode === "full" && hasDeepDescendants
    ? subtreeRows
    : directChildren.map((c: any) => ({ id: c.id, name: c.name, type: c.type, fields: c.fields, depth: 0, ownershipPct: c._ownershipPercentage }));

  // ADOPT-AS-CHILD redesign (2026-05-26): the previous inline picker / mutation
  // (allProfilesForLink, linkCandidates, filteredLinkCandidates, linkExistingMut,
  // inline Link Existing Dialog) have been removed. The Adopt-as-Child UX now
  // lives in the dedicated <RebuildAdoptDialog> component which provides a
  // two-step confirm flow with path preview and cycle protection.

  // Fetch all profiles for path preview inside the Add Child dialog. This was
  // previously fetched only when the Link dialog opened — now it's used to
  // show the path preview line inline above the Create button.
  const { data: allProfilesForPreview } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: showAddChild,
  });

  const createChildMut = useMutation({
    mutationFn: async () => {
      if (!childName.trim()) throw new Error("Name required");
      const res = await apiRequest("POST", "/api/profiles", {
        name: childName.trim(),
        type: childType,
        parentProfileId: profile.id,
        tags: [],
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: `"${childName}" created` });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      setChildName("");
      setChildType("asset");
      setShowAddChild(false);
      onChildAdded();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add child asset", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Card data-testid="card-child-assets">
      <CardHeader className="pb-2">
        {/* Mobile: title row, then action row wraps cleanly.
            Desktop (sm+): title and actions on one row. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-wrap">
            <Package className="h-4 w-4 text-muted-foreground" /> Child Assets
            {hasDeepDescendants && (
              <span className="text-[10px] font-normal text-muted-foreground ml-1" data-testid="child-assets-counts">
                {directChildren.length} direct · {subtreeRows.length} total
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-1.5 flex-wrap">
            {hasDeepDescendants && assetView === "list" && (
              <div className="inline-flex rounded-md border bg-card text-[10px] font-medium" data-testid="tree-mode-toggle">
                <button
                  className={`px-2 py-1 ${treeMode === "direct" ? "bg-primary text-primary-foreground rounded-l-md" : "text-muted-foreground"}`}
                  onClick={() => setTreeMode("direct")}
                  data-testid="tree-mode-direct"
                >Direct</button>
                <button
                  className={`px-2 py-1 ${treeMode === "full" ? "bg-primary text-primary-foreground rounded-r-md" : "text-muted-foreground"}`}
                  onClick={() => setTreeMode("full")}
                  data-testid="tree-mode-full"
                >Full tree</button>
              </div>
            )}
            {directChildren.length > 0 && <LinkedViewToggle view={assetView} onChange={setAssetView} />}
            <Button
              size="sm"
              variant="ghost"
              className="h-9 text-xs gap-1 px-2"
              onClick={() => setShowAdopt(true)}
              data-testid="button-adopt-as-child"
              title="Adopt an existing asset as a child of this one"
              aria-label="Adopt as Child"
            >
              <LinkIcon className="h-3.5 w-3.5" /> Adopt
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-9 text-xs gap-1 px-2"
              onClick={() => setShowAddChild(true)}
              data-testid="button-add-child-asset"
              aria-label="Add Child"
            >
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {directChildren.length === 0 ? (
          <div className="py-4 text-center" data-testid="child-assets-empty">
            <p className="text-sm text-muted-foreground">No child assets yet.</p>
          </div>
        ) : assetView === "sheet" ? (
          // Wave 15: Spreadsheet view of child assets
          <LinkedSheetView
            rows={directChildren.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))}
            columns={[
              { key: "name", label: "Name", width: "minmax(140px, 1.5fr)", render: (c: any) => <span className="font-medium">{c.name}</span> },
              { key: "type", label: "Type", width: "100px", render: (c: any) => <span className="capitalize">{c.type}</span> },
              { key: "value", label: "Value", width: "110px", align: "right", render: (c: any) => {
                const v = getAssetBaseValue(c.fields);
                return <span className="tabular-nums">{v > 0 ? formatCurrency(v) : "—"}</span>;
              } },
              { key: "loan", label: "Loan Balance", width: "110px", align: "right", render: (c: any) => {
                const v = getAssetLoanValue(c.fields);
                return <span className="tabular-nums">{v > 0 ? formatCurrency(v) : "—"}</span>;
              } },
              { key: "net", label: "Net", width: "110px", align: "right", render: (c: any) => {
                const v = getAssetBaseValue(c.fields) - getAssetLoanValue(c.fields);
                return <span className="tabular-nums font-semibold">{formatCurrency(v)}</span>;
              } },
              { key: "actions", label: "", width: "48px", align: "right", render: (c: any) => (
                <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                  <RebuildChildActions child={c as any} parent={profile as any} onChanged={onChildAdded} />
                </div>
              ) },
            ]}
            onRowClick={(c: any) => setLocation(`/profiles/${c.id}`)}
            emptyMessage="No child assets"
            testId="child-assets-sheet"
          />
        ) : (
          <div className="space-y-1" data-testid="child-assets-list">
            {(treeMode === "full"
                // Preserve depth-first order from the tree walk so Furniture
                // appears above its own Couch above its own Screws.
                ? visibleChildren
                // Direct view — alphabetical sort for predictability.
                : visibleChildren.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")))
              .map((child) => {
                const grossValue = getAssetBaseValue(child.fields);
                // Co-ownership: when this profile owns a fractional share, show
                // their share of the value and badge the %. Full/undefined = 100%.
                const ownPct = typeof child.ownershipPct === "number" ? child.ownershipPct : 100;
                const childValue = grossValue * ownPct / 100;
                const isShared = ownPct < 100;
                // 14px indent per nesting level. We cap visual indent at
                // 6 levels (84px) so deep trees stay readable inside the
                // card width — depth is still tracked accurately for sort.
                const visualDepth = Math.min(child.depth, 6);
                return (
                  <div
                    key={child.id}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg border hover:bg-muted/30 transition-colors text-left min-h-[44px] cursor-pointer"
                    style={{ marginLeft: visualDepth * 14 }}
                    onClick={() => setLocation(`/profiles/${child.id}`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setLocation(`/profiles/${child.id}`);
                      }
                    }}
                    data-testid={`child-asset-row-${child.id}`}
                    data-depth={child.depth}
                  >
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      {profileIcon(child.type)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{child.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {child.type}{child.depth > 0 ? ` · level ${child.depth + 1}` : ""}
                        {isShared ? ` · owns ${ownPct}%` : ""}
                      </p>
                    </div>
                    {isShared && (
                      <span className="text-[10px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary" data-testid={`child-asset-ownership-${child.id}`}>
                        {ownPct}%
                      </span>
                    )}
                    {childValue > 0 && (
                      <span className="text-xs font-semibold tabular-nums shrink-0" title={isShared ? `${formatCurrency(grossValue)} total · your ${ownPct}% share` : undefined}>
                        {formatCurrency(childValue)}
                      </span>
                    )}
                    <div
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                      data-testid={`child-asset-actions-${child.id}`}
                    >
                      <RebuildChildActions
                        child={child as any}
                        parent={profile as any}
                        onChanged={onChildAdded}
                      />
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  </div>
                );
              })}
          </div>
        )}
      </CardContent>

      {/* Add Child Dialog */}
      <Dialog open={showAddChild} onOpenChange={setShowAddChild}>
        <DialogContent className="max-w-sm" data-testid="dialog-add-child-asset">
          <DialogHeader>
            <DialogTitle>Add Child Asset</DialogTitle>
            <DialogDescription>Create a new asset nested under &quot;{profile.name}&quot;.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="child-asset-name">Name</label>
              <Input
                id="child-asset-name"
                placeholder="e.g. Refrigerator, Samsung TV..."
                value={childName}
                onChange={(e) => setChildName(e.target.value)}
                className="h-[44px] text-sm"
                onKeyDown={(e) => { if (e.key === "Enter") createChildMut.mutate(); }}
                data-testid="input-child-asset-name"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium" htmlFor="child-asset-type">Type</label>
              <Select value={childType} onValueChange={(v) => setChildType(v as NestedAssetType)}>
                <SelectTrigger id="child-asset-type" className="h-[44px]" data-testid="select-child-asset-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NESTED_ASSET_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Path preview — shows the user where this new child will live */}
            <RebuildPathPreview
              parent={profile as any}
              allProfiles={(allProfilesForPreview || []) as any[]}
              childName={childName.trim() || undefined}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-[44px]" onClick={() => setShowAddChild(false)}>Cancel</Button>
            <Button
              size="sm"
              className="h-[44px]"
              onClick={() => createChildMut.mutate()}
              disabled={createChildMut.isPending || !childName.trim()}
              data-testid="button-confirm-add-child-asset"
            >
              {createChildMut.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Adopt-as-Child Dialog (replaces the legacy inline Link Existing picker) */}
      <RebuildAdoptDialog
        profile={profile as any}
        open={showAdopt}
        onOpenChange={setShowAdopt}
        onAdopted={onChildAdded}
      />
    </Card>
  );
}

// ============================================================
// NESTED ASSETS — VALUE ROLLUP CARD (Section 4)
// ============================================================

function ValueRollupCard({ profile }: { profile: ProfileDetail }) {
  const { data: treeData } = useQuery<TreeNode>({
    queryKey: ["/api/profiles", profile.id, "tree"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profile.id}/tree`);
      return res.json();
    },
    retry: false,
  });

  const hasChildren = ((profile as any).childProfiles || []).some(
    (c: any) => NESTED_ASSET_TYPES.includes(c.type as NestedAssetType)
  );
  const ownValue = getAssetBaseValue(profile.fields);

  // Only show if profile has own value or children
  if (!hasChildren && ownValue === 0) return null;

  const descendants = treeData ? flattenTreeNodes(treeData) : [];
  const rollup = computeAssetRollup(profile, descendants);

  return (
    <Card data-testid="card-value-rollup">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-primary" /> Value Rollup
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-2" data-testid="rollup-grid">
          <div className="rounded-lg bg-muted/30 p-2.5 text-center">
            <p className="text-base font-bold tabular-nums">{formatCurrency(rollup.baseValue)}</p>
            <p className="text-[11px] text-muted-foreground">Base Value</p>
          </div>
          <div className="rounded-lg bg-muted/30 p-2.5 text-center">
            <p className="text-base font-bold tabular-nums">{formatCurrency(rollup.nestedValue)}</p>
            <p className="text-[11px] text-muted-foreground">Nested Assets</p>
          </div>
          <div className="rounded-lg bg-green-500/8 border border-green-500/20 p-2.5 text-center col-span-2">
            <p className="text-lg font-bold tabular-nums text-green-600 dark:text-green-400">
              {formatCurrency(rollup.totalValue)}
            </p>
            <p className="text-[11px] text-muted-foreground">Total Combined</p>
          </div>
          {rollup.totalLoans > 0 && (
            <>
              <div className="rounded-lg bg-red-500/8 border border-red-500/20 p-2.5 text-center">
                <p className="text-base font-bold tabular-nums text-red-500">{formatCurrency(rollup.totalLoans)}</p>
                <p className="text-[11px] text-muted-foreground">Total Loans</p>
              </div>
              <div className="rounded-lg bg-muted/30 p-2.5 text-center">
                <p className={`text-base font-bold tabular-nums ${rollup.netValue >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                  {formatCurrency(rollup.netValue)}
                </p>
                <p className="text-[11px] text-muted-foreground">Net Value</p>
              </div>
            </>
          )}
          {rollup.monthlyExpense > 0 && (
            <div className="rounded-lg bg-orange-500/8 border border-orange-500/20 p-2.5 text-center" data-testid="rollup-monthly-expense">
              <p className="text-base font-bold tabular-nums text-orange-600 dark:text-orange-400">
                {formatCurrency(rollup.monthlyExpense)}<span className="text-[10px] font-normal text-muted-foreground">/mo</span>
              </p>
              <p className="text-[11px] text-muted-foreground">Total Monthly</p>
            </div>
          )}
          {rollup.maintenanceCost > 0 && (
            <div className="rounded-lg bg-blue-500/8 border border-blue-500/20 p-2.5 text-center" data-testid="rollup-maintenance">
              <p className="text-base font-bold tabular-nums text-blue-600 dark:text-blue-400">
                {formatCurrency(rollup.maintenanceCost)}
              </p>
              <p className="text-[11px] text-muted-foreground">Maintenance</p>
            </div>
          )}
        </div>
        {rollup.descendantCount > 0 && (
          <p className="text-[11px] text-muted-foreground mt-2 text-center">
            Across {rollup.descendantCount} nested asset{rollup.descendantCount !== 1 ? "s" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// MAINTENANCE CARD — Section 5 of NestedAssetSections
// ============================================================

const MAINT_RE = /maintenance|service|repair|warranty|filter|oil change|cleaning|inspection/i;

// Default date helper: today + N days → "YYYY-MM-DD"
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Difference in whole days: target - now (positive = future)
function daysDiff(dateStr: string): number {
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function formatRelDays(n: number): string {
  if (n === 0) return "today";
  if (n > 0) return `in ${n} day${n === 1 ? "" : "s"}`;
  return `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"} ago`;
}

const RECURRENCE_LABELS: Record<string, string> = {
  none: "One-time",
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  yearly: "Yearly",
};

function MaintenanceCard({
  profile,
}: {
  profile: ProfileDetail;
}) {
  const { toast } = useToast();
  const [collapsed, setCollapsed] = useState(true);
  const [repairExpanded, setRepairExpanded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [warrantyEditing, setWarrantyEditing] = useState(false);
  const [warrantyInput, setWarrantyInput] = useState("");

  // Add reminder form state
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDate, setReminderDate] = useState(daysFromNow(7));
  const [reminderRecurrence, setReminderRecurrence] = useState<string>("none");

  // ── Section A: Warranty ──
  const f = profile.fields || {};
  const rawWarranty: string | undefined =
    f.warrantyExpiry || f.warrantyEndDate || f.warranty || undefined;

  const warrantyDays = rawWarranty ? daysDiff(rawWarranty) : null;

  let warrantyTint = "";
  let warrantyMsg = "";
  if (rawWarranty && warrantyDays !== null) {
    if (warrantyDays > 30) {
      warrantyTint = "bg-green-500/10 text-green-700 dark:text-green-400";
      warrantyMsg = `Warranty active · expires in ${warrantyDays} days`;
    } else if (warrantyDays > 0) {
      warrantyTint = "bg-orange-500/10 text-orange-700 dark:text-orange-400";
      warrantyMsg = `Warranty expires soon · in ${warrantyDays} days`;
    } else {
      warrantyTint = "bg-red-500/10 text-red-700 dark:text-red-400";
      warrantyMsg = `Warranty expired ${Math.abs(warrantyDays)} days ago`;
    }
  }

  // ── Section B: Upcoming reminders (next 90 days) ──
  // Use relatedEvents from the profile (already loaded) and supplement with tree fetch
  const { data: treeDataMaint } = useQuery<TreeNode>({
    queryKey: ["/api/profiles", profile.id, "tree"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profile.id}/tree`);
      return res.json();
    },
    retry: false,
    staleTime: 60000,
  });

  // Also fetch all events to filter by linkedProfiles for descendant matching
  const { data: allEvents } = useQuery<any[]>({
    queryKey: ["/api/events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/events");
      return res.json();
    },
    staleTime: 60000,
  });

  const descendantsMaint = treeDataMaint ? flattenTreeNodes(treeDataMaint) : [];
  const descendantIdsMaint = useMemo(
    () => new Set(descendantsMaint.map((d) => d.id)),
    [descendantsMaint]
  );
  const descendantNameMapMaint = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of descendantsMaint) m.set(d.id, d.name);
    return m;
  }, [descendantsMaint]);

  const now = Date.now();
  const cutoff90 = now + 90 * 86400000;

  const upcomingEvents = useMemo(() => {
    const evts = allEvents || [];
    const seen = new Set<string>();
    const result: Array<{ event: any; fromChildName?: string }> = [];

    for (const ev of evts) {
      if (!ev.date) continue;
      const ts = new Date(ev.date).getTime();
      if (ts < now || ts > cutoff90) continue;
      if (!MAINT_RE.test(ev.title || "") && !MAINT_RE.test(ev.category || "")) continue;

      // Direct link to this profile
      const linkedIds: string[] = ev.linkedProfiles || [];
      if (linkedIds.includes(profile.id)) {
        if (!seen.has(ev.id)) { seen.add(ev.id); result.push({ event: ev }); }
        continue;
      }

      // Link via descendants
      const childMatch = linkedIds.find((lid) => descendantIdsMaint.has(lid));
      if (childMatch) {
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          result.push({ event: ev, fromChildName: descendantNameMapMaint.get(childMatch) });
        }
      }
    }

    result.sort((a, b) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime());
    return result.slice(0, 5);
  }, [allEvents, profile.id, descendantIdsMaint, descendantNameMapMaint, now, cutoff90]);

  // ── Section C: Repair history (last 90 days) ──
  const past90 = now - 90 * 86400000;

  const directRepairs = useMemo(() => {
    return (profile.relatedExpenses || []).filter((e: any) => {
      if (!e.date) return false;
      const ts = new Date(e.date).getTime();
      if (ts < past90 || ts > now) return false;
      const cat = (e.category || "").toLowerCase();
      const desc = (e.description || "").toLowerCase();
      return (
        MAINT_RE.test(cat) ||
        MAINT_RE.test(desc) ||
        cat === "warranty_claim" ||
        cat === "warranty"
      );
    });
  }, [profile.relatedExpenses, past90, now]);

  // Descendant repairs: use childProfiles' relatedExpenses where available
  const descendantRepairs = useMemo(() => {
    const result: Array<{ expense: any; childName: string }> = [];
    const childProfs = (profile.childProfiles || []) as any[];
    for (const cp of childProfs) {
      if (!descendantIdsMaint.has(cp.id) && cp.id !== profile.id) continue;
      const cpExpenses: any[] = cp.relatedExpenses || [];
      for (const e of cpExpenses) {
        if (!e.date) continue;
        const ts = new Date(e.date).getTime();
        if (ts < past90 || ts > now) continue;
        const cat = (e.category || "").toLowerCase();
        const desc = (e.description || "").toLowerCase();
        if (MAINT_RE.test(cat) || MAINT_RE.test(desc) || cat === "warranty_claim" || cat === "warranty") {
          result.push({ expense: e, childName: cp.name });
        }
      }
    }
    return result;
  }, [profile.childProfiles, descendantIdsMaint, past90, now, profile.id]);

  const allRepairs = useMemo(() => {
    const direct = directRepairs.map((e: any) => ({ expense: e, childName: undefined as string | undefined }));
    return [...direct, ...descendantRepairs].sort((a, b) => new Date(b.expense.date).getTime() - new Date(a.expense.date).getTime());
  }, [directRepairs, descendantRepairs]);

  const repairTotal = allRepairs.reduce((sum, r) => sum + (Number(r.expense.amount) || 0), 0);

  // ── Warranty save mutation ──
  const warrantySaveMut = useMutation({
    mutationFn: async (dateVal: string) => {
      const res = await apiRequest("PATCH", `/api/profiles/${profile.id}`, {
        fields: { warrantyExpiry: dateVal },
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Warranty date saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      // Bug fix: dashboard's Expiring Documents/Warranties cards read from
      // /api/dashboard-enhanced; without these invalidations they stayed
      // stale for up to 5 minutes after a warranty edit.
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setWarrantyEditing(false);
    },
    onError: (err: Error) =>
      toast({ title: "Failed to save warranty", description: formatApiError(err), variant: "destructive" }),
  });

  // ── Add reminder mutation ──
  const addReminderMut = useMutation({
    mutationFn: async () => {
      // Schema supports: none|daily|weekly|biweekly|monthly|yearly
      // "Every 6 months" is not natively supported — we use "monthly" with a note
      // (recurrenceInterval is not in the schema, so we can't pass it)
      let recurrence = reminderRecurrence;
      if (recurrence === "every6months") {
        // NOTE: Schema only supports monthly. User will need to skip 5 occurrences.
        recurrence = "monthly";
      }
      const res = await apiRequest("POST", "/api/events", {
        title: reminderTitle.trim(),
        date: reminderDate,
        allDay: true,
        category: "other", // EventCategory doesn't include 'maintenance'; closest is 'other'
        recurrence,
        linkedProfiles: [profile.id],
        source: "manual",
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Reminder created", description: reminderTitle });
      setAddOpen(false);
      setReminderTitle("");
      setReminderDate(daysFromNow(7));
      setReminderRecurrence("none");
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
    },
    onError: (err: Error) =>
      toast({ title: "Failed to create reminder", description: formatApiError(err), variant: "destructive" }),
  });

  // Total content rows to decide if we need the chevron collapse
  const totalRows = upcomingEvents.length + allRepairs.length;
  const needsCollapse = totalRows > 5;

  const bodyVisible = !needsCollapse || !collapsed;

  return (
    <Card data-testid="maintenance-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" />
            🛠️ Maintenance &amp; Reminders
          </span>
          {needsCollapse && (
            <button
              type="button"
              className="p-1 rounded hover:bg-muted transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "Expand maintenance" : "Collapse maintenance"}
              data-testid="maintenance-collapse-toggle"
            >
              {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </button>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* ── Section A: Warranty Status ── */}
        <div data-testid="warranty-status" className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Warranty</p>
          {!rawWarranty && !warrantyEditing && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">No warranty on file.</span>
              <button
                type="button"
                onClick={() => { setWarrantyInput(daysFromNow(365)); setWarrantyEditing(true); }}
                className="text-xs text-primary underline min-h-[44px] px-1"
                data-testid="warranty-add-btn"
              >
                + Add
              </button>
            </div>
          )}
          {warrantyEditing && (
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                type="date"
                value={warrantyInput}
                onChange={(e) => setWarrantyInput(e.target.value)}
                className="h-9 w-auto text-sm"
                data-testid="warranty-date-input"
              />
              <Button
                size="sm"
                className="h-9"
                onClick={() => warrantySaveMut.mutate(warrantyInput)}
                disabled={!warrantyInput || warrantySaveMut.isPending}
                data-testid="warranty-save-btn"
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9"
                onClick={() => setWarrantyEditing(false)}
              >
                Cancel
              </Button>
            </div>
          )}
          {rawWarranty && !warrantyEditing && (
            <div className={`rounded-md px-3 py-2 text-sm flex items-center justify-between gap-2 ${warrantyTint}`}>
              <span>{warrantyMsg}</span>
              <span className="text-xs opacity-70">
                {new Date(rawWarranty).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            </div>
          )}
        </div>

        {/* ── Section B: Upcoming reminders (next 90 days) ── */}
        {bodyVisible && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Upcoming (90 days)</p>
            {upcomingEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="no-upcoming-maintenance">
                No upcoming maintenance scheduled.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="upcoming-reminders-list">
                {upcomingEvents.map(({ event, fromChildName }) => (
                  <li
                    key={event.id}
                    className="rounded-md bg-muted/40 px-3 py-2 flex flex-col gap-0.5"
                    data-testid={`upcoming-reminder-${event.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium leading-snug">{event.title}</span>
                      <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
                        {formatRelDays(daysDiff(event.date))}
                      </span>
                    </div>
                    {fromChildName && (
                      <span className="text-[11px] text-muted-foreground">
                        from {fromChildName}
                      </span>
                    )}
                    {event.recurrence && event.recurrence !== "none" && (
                      <span className="text-[11px] text-primary/70">
                        {RECURRENCE_LABELS[event.recurrence] || event.recurrence}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Section C: Repair history (last 90 days) ── */}
        {bodyVisible && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Repair History (90 days)</p>
            {allRepairs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No repair expenses recorded.</p>
            ) : (
              <div className="space-y-1.5" data-testid="repair-history">
                <button
                  type="button"
                  className="flex items-center gap-2 text-sm font-medium w-full text-left min-h-[44px] px-3 py-2 rounded-md bg-muted/40 hover:bg-muted/60 transition-colors"
                  onClick={() => setRepairExpanded((x) => !x)}
                  data-testid="repair-history-toggle"
                >
                  <span className="flex-1">
                    {allRepairs.length} repair{allRepairs.length !== 1 ? "s" : ""} · {formatCurrency(repairTotal)} in last 90 days
                  </span>
                  {repairExpanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
                </button>
                {repairExpanded && (
                  <ul className="space-y-1 pl-1">
                    {allRepairs.map(({ expense: e, childName }) => (
                      <li
                        key={e.id}
                        className="rounded-md bg-muted/20 px-3 py-2 flex flex-col gap-0.5"
                        data-testid={`repair-item-${e.id}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm leading-snug">{e.description}</span>
                          <span className="text-sm font-medium tabular-nums shrink-0">{formatCurrency(Number(e.amount) || 0)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {new Date(e.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                          </span>
                          {childName && (
                            <span className="text-[11px] text-muted-foreground">· {childName}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Section D: Add reminder (collapsible form) ── */}
        <div className="border-t border-border/30 pt-2">
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm text-primary font-medium min-h-[44px] w-full text-left"
            onClick={() => setAddOpen((x) => !x)}
            data-testid="add-reminder-toggle"
            aria-expanded={addOpen}
          >
            <Plus className="h-4 w-4" />
            Add reminder
            {addOpen ? <ChevronUp className="h-3.5 w-3.5 ml-auto" /> : <ChevronDown className="h-3.5 w-3.5 ml-auto" />}
          </button>

          {addOpen && (
            <form
              className="space-y-2 mt-2"
              data-testid="add-reminder-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reminderTitle.trim() || !reminderDate) return;
                addReminderMut.mutate();
              }}
            >
              <Input
                placeholder="Title (required)"
                value={reminderTitle}
                onChange={(e) => setReminderTitle(e.target.value)}
                required
                className="h-10"
                data-testid="reminder-title-input"
              />
              <Input
                type="date"
                value={reminderDate}
                onChange={(e) => setReminderDate(e.target.value)}
                required
                className="h-10"
                data-testid="reminder-date-input"
              />
              <Select value={reminderRecurrence} onValueChange={setReminderRecurrence}>
                <SelectTrigger className="h-10" data-testid="reminder-recurrence-select">
                  <SelectValue placeholder="Recurrence" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">One-time</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  {/* Every 6 months: schema has no recurrenceInterval, so we use monthly and note the limitation */}
                  <SelectItem value="every6months">Every 6 months (stored as monthly)</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
              {reminderRecurrence === "every6months" && (
                <p className="text-[11px] text-muted-foreground">
                  Note: stored as monthly recurrence — skip the intermediate 5 occurrences manually.
                </p>
              )}
              <Button
                type="submit"
                size="sm"
                className="w-full h-10"
                disabled={!reminderTitle.trim() || !reminderDate || addReminderMut.isPending}
                data-testid="reminder-submit-btn"
              >
                {addReminderMut.isPending ? "Saving…" : "Save Reminder"}
              </Button>
            </form>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// NESTED ASSETS — COMBINED SECTION WRAPPER (inject into InfoTab)
// ============================================================

function NestedAssetSections({
  profile,
  allProfiles,
  onSaved,
  mode = "full",
}: {
  profile: ProfileDetail;
  allProfiles: any[];
  onSaved: () => void;
  /** "full" — legacy stacked layout (Location + BelongsTo + Children + Rollup + Maintenance).
   *  "location-only" — just the Location + BelongsTo card. Used on the new asset
   *    Overview where the rest moves to dedicated tabs and child rollup is already
   *    shown by RebuildSummary.
   *  "children" — just the ChildAssetsCard. Used on the new Contained tab.
   *  "financials" — just the ValueRollupCard. Used on the new Financials tab.
   *  "maintenance" — just the MaintenanceCard. Used on the existing Maintenance tab. */
  mode?: "full" | "location-only" | "children" | "financials" | "maintenance";
}) {
  const isAssetType = NESTED_ASSET_TYPES.includes(profile.type as NestedAssetType);
  if (!isAssetType) return null;

  if (mode === "location-only") {
    // Asset Overview shows ONLY the physical-location editor here.
    // The parent-in-tree picker ("Located in: <parent>") moved to the
    // Contained tab where the Ownership Tree already displays the same
    // information — keeping both was redundant and confusing.
    return (
      <Card data-testid="card-location">
        <CardContent className="p-3 space-y-1.5">
          <LocationEditor profile={profile} onSaved={onSaved} />
        </CardContent>
      </Card>
    );
  }
  if (mode === "children") {
    return <ChildAssetsCard profile={profile} onChildAdded={onSaved} />;
  }
  if (mode === "financials") {
    return <ValueRollupCard profile={profile} />;
  }
  if (mode === "maintenance") {
    return <MaintenanceCard profile={profile} />;
  }

  return (
    <div className="space-y-3" data-testid="nested-asset-sections">
      {/* Section 1: Physical location only.
          Belongs-to (parent-in-tree picker) moved to the Contained tab
          alongside the Ownership Tree which already shows the same
          relationship — keeping both was redundant. Asset nesting is
          still fully supported via the Contained tab. */}
      <Card data-testid="card-location">
        <CardContent className="p-3 space-y-1.5">
          <LocationEditor profile={profile} onSaved={onSaved} />
        </CardContent>
      </Card>

      {/* Section 3: Child Assets — the primary way to attach things that
          BELONG to this asset. For a vehicle: tires, rims, dashcam, roof
          rack, stereo, child seat. For a property: solar panels, hot tub,
          appliances. For a generic asset: any sub-item. Kept on every
          asset-like type — 'Linked Assets' (sibling cross-links between
          two top-level assets) was the redundant section and is now hidden
          on vehicles where it was almost never meaningful. */}
      <ChildAssetsCard profile={profile} onChildAdded={onSaved} />

      {/* Section 4: Value Rollup */}
      <ValueRollupCard profile={profile} />

      {/* Section 5: Maintenance & Reminders */}
      <MaintenanceCard profile={profile} />
    </div>
  );
}

// ── Field flattening (nested → top-level) ───────────────────────────────────
// Storage paths used by the app:
//   fields.vehicles.{licensePlate,vin,make,model,year,mileage,color,trim,registrationExpiration}
//   fields.insurance.{insurer,policyNumber,coverage,coverageType,monthlyPremium,deductible}
//   fields.housing.{currentValue,address,beds,baths,sqft}
//   fields.other.{purchasePrice,valuationDate,valuationMethod,valuationRange,valuationConfidence}
//   fields.finance.{balance,monthlyPayment,interestRate,loans:[{balance}]}
//   fields.subscriptions.{cost,frequency,monthlyCost,renewalDate,status}
// Older / manual edits write the same keys at the top level. We promote nested
// keys to the top level so every reader (`f.licensePlate`, `f.currentValue`,
// etc.) works, with top-level winning if both exist. Numeric strings like "699"
// are left as-is — Number(...) at the call site coerces them.
function flattenProfileFields(rawFields: any): any {
  if (!rawFields || typeof rawFields !== "object") return rawFields || {};
  const NESTED_GROUPS = [
    // financial / asset groups
    "vehicles", "insurance", "housing", "other", "finance", "subscriptions", "utilities",
    // person / self groups
    "personal", "identity", "health", "contact", "emergency",
    // pet groups
    "pets", "pet",
  ];
  // Aliases so UI keys match storage keys.
  // Storage key (left) → UI key (right). When we promote a nested key, also
  // mirror it under the UI alias if the alias slot is empty.
  const KEY_ALIASES: Record<string, string> = {
    dateOfBirth: "birthday",
    dob: "birthday",
    licenseNumber: "license",
    licenseClass: "licenseClass",
    issuingAuthority: "licenseState",
    expirationDate: "licenseExpiration",
    patientName: "name",
    primaryPhone: "phone",
    homePhone: "phone",
    cellPhone: "phone",
    homeAddress: "address",
    serviceAddress: "address",
  };
  const out: any = {};
  // Case-insensitive presence tracking so "Weight" and "weight" don't both end
  // up as separate rows. First write wins; matches storage's schema (lowercase).
  const seenLC: Record<string, string> = {}; // lowercased key -> canonical key already in out
  const setIfEmpty = (key: string, val: any) => {
    if (val === undefined || val === null || val === "") return;
    const lc = key.toLowerCase();
    const existingKey = seenLC[lc];
    if (existingKey !== undefined) {
      const cur = out[existingKey];
      if (cur === undefined || cur === null || cur === "") out[existingKey] = val;
      return;
    }
    out[key] = val;
    seenLC[lc] = key;
  };
  // First, copy nested-group keys up
  for (const group of NESTED_GROUPS) {
    const nested = rawFields[group];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested)) {
        if (v === undefined || v === null || v === "") continue;
        setIfEmpty(k, v);
        const alias = KEY_ALIASES[k];
        if (alias && alias !== k) setIfEmpty(alias, v);
      }
    }
  }
  // Then, top-level keys win
  for (const [k, v] of Object.entries(rawFields)) {
    if (NESTED_GROUPS.includes(k)) {
      // Preserve the original nested object too so existing code that reads
      // fields.vehicles.* / fields.personal.* etc. keeps working
      out[k] = v;
      continue;
    }
    if (v === undefined || v === null || v === "") continue;
    const lc = k.toLowerCase();
    const existingKey = seenLC[lc];
    if (existingKey !== undefined && existingKey !== k) {
      // Top-level wins over a nested-promoted duplicate — replace under the
      // top-level key and drop the previously-promoted alias row.
      delete out[existingKey];
      out[k] = v;
      seenLC[lc] = k;
    } else {
      out[k] = v;
      seenLC[lc] = k;
    }
  }
  // Liability fallback: if no top-level balance but finance.loans[] has one, sum them
  const finance = rawFields.finance;
  if (finance && Array.isArray(finance.loans) && finance.loans.length > 0) {
    const loanSum = finance.loans.reduce(
      (s: number, l: any) => s + (Number(l?.balance) || 0),
      0,
    );
    if (loanSum > 0 && (out.balance == null || out.balance === "")) {
      out.balance = loanSum;
    }
  }
  return out;
}

// Apply flattening to a profile and (recursively) its child profiles.
function flattenProfile<T extends { fields?: any; childProfiles?: any[] } | null | undefined>(p: T): T {
  if (!p) return p;
  const flat: any = { ...p, fields: flattenProfileFields((p as any).fields) };
  if (Array.isArray((p as any).childProfiles)) {
    flat.childProfiles = (p as any).childProfiles.map((c: any) =>
      c ? { ...c, fields: flattenProfileFields(c.fields) } : c,
    );
  }
  return flat as T;
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

function AISummaryCard({ profileId, profileType, profileUpdatedAt }: { profileId: string; profileType: string; profileUpdatedAt?: string }) {
  const { data: aiSummary, isLoading, isError, isFetching } = useQuery<AISummaryData>({
    queryKey: ["/api/profiles", profileId, "ai-summary"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/ai-summary`);
      return res.json();
    },
    enabled: !!profileId,
    retry: false,
  });

  // When the underlying profile changes (any field edit, AI write, etc) refetch
  // the summary. The server clears its 2h cache on PATCH, so this triggers a
  // fresh generation reflecting the latest values (e.g. updated mileage).
  // Skip on first render (when aiSummary hasn't loaded yet) to avoid a double-fetch.
  useEffect(() => {
    if (!profileUpdatedAt) return;
    if (!aiSummary) return;
    const summaryAt = new Date(aiSummary.generatedAt).getTime();
    const profileAt = new Date(profileUpdatedAt).getTime();
    // If the profile was updated after the summary was generated, refetch.
    if (Number.isFinite(profileAt) && Number.isFinite(summaryAt) && profileAt > summaryAt) {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "ai-summary"] });
    }
  }, [profileUpdatedAt, profileId, aiSummary]);

  const handleRefresh = useCallback(async () => {
    // Force refresh bypassing server cache
    queryClient.setQueryData(["/api/profiles", profileId, "ai-summary"], undefined);
    queryClient.fetchQuery({
      queryKey: ["/api/profiles", profileId, "ai-summary"],
      queryFn: async () => {
        const res = await apiRequest("GET", `/api/profiles/${profileId}/ai-summary?force=true`);
        return res.json();
      },
    });
  }, [profileId]);

  // Wave 9: Look up current market value via web search + AI.
  // Only shown for asset-like profile types (asset/vehicle/property/investment).
  const canLookupValue = ["asset", "vehicle", "property", "investment"].includes(profileType);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupResult, setLookupResult] = useState<null | { value: number; confidence: string; method: string; range: string; previousValue: number }>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const handleLookupValue = useCallback(async () => {
    setLookupBusy(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const res = await apiRequest("POST", `/api/profiles/${profileId}/lookup-value`);
      const data = await res.json();
      if (!res.ok) {
        setLookupError(data.error || "Lookup failed");
      } else {
        setLookupResult({
          value: data.currentValue,
          confidence: data.confidence,
          method: data.method,
          range: data.range,
          previousValue: data.previousValue,
        });
        // Refresh the profile detail and AI summary so the new value flows everywhere.
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "ai-summary"] });
      }
    } catch (e: any) {
      setLookupError(e?.message || "Lookup failed");
    } finally {
      setLookupBusy(false);
    }
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
          <div className="flex items-center gap-1">
            {canLookupValue && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                onClick={handleLookupValue}
                disabled={lookupBusy}
                data-testid="button-lookup-value"
                title="Estimate current market value from live web data"
              >
                {lookupBusy
                  ? <RefreshCw className="h-3 w-3 animate-spin" />
                  : <Search className="h-3 w-3" />}
                {lookupBusy ? "Looking up…" : "Look up value"}
              </Button>
            )}
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
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary text */}
        <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-ai-summary">
          {aiSummary.summary}
        </p>

        {/* Wave 9: Lookup result/error banner */}
        {lookupError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="text-lookup-error">
            {lookupError}
          </div>
        )}
        {lookupResult && (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs space-y-1" data-testid="text-lookup-result">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Estimated current value</span>
              <span className="font-semibold tabular-nums">${lookupResult.value.toLocaleString()}</span>
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
              {lookupResult.range && <span>Range: {lookupResult.range}</span>}
              <span>Confidence: {lookupResult.confidence}</span>
              <span>Source: {lookupResult.method}</span>
              {lookupResult.previousValue > 0 && lookupResult.previousValue !== lookupResult.value && (
                <span>
                  vs prior ${lookupResult.previousValue.toLocaleString()}{" "}
                  ({lookupResult.value > lookupResult.previousValue ? "+" : ""}
                  ${(lookupResult.value - lookupResult.previousValue).toLocaleString()})
                </span>
              )}
            </div>
          </div>
        )}

        {/* Highlights row */}
        {(aiSummary.highlights?.length ?? 0) > 0 && (
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
        {(aiSummary.actionItems?.length ?? 0) > 0 && (
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

// Memoised: rendered once per timeline entry (can be hundreds of rows) and its
// only prop is the entry object, whose reference is stable between parent
// re-renders (comes straight from react-query data). No callback props.
const TimelineItem = memo(function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const colors: Record<string, string> = {
    tracker: "bg-chart-1/10 text-chart-1",
    expense: "bg-chart-4/10 text-chart-4",
    task: "bg-chart-3/10 text-chart-3",
    event: "bg-chart-2/10 text-chart-2",
    document: "bg-primary/10 text-primary",
    habit: "bg-rose-500/10 text-rose-500",
    obligation: "bg-orange-500/10 text-orange-500",
    journal: "bg-violet-500/10 text-violet-500",
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
});

// ============================================================
// INFO TAB — Universal with type-specific enrichments
// ============================================================

// Legacy InlineEditField (used internally by old field lists)
function InlineEditField({ profileId, fieldKey, fieldValue, allFields }: {
  profileId: string; fieldKey: string; fieldValue: string; allFields: Record<string, any>;
}) {
  const [editing, setEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleSave} disabled={mutation.isPending} aria-label="Save">
            <Check className="h-3 w-3 text-green-500" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { setValue(fieldValue); setEditing(false); }} aria-label="Cancel">
            <X className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  const deleteMut = useMutation({
    // P1 universal-delete: send explicit `fieldsToDelete: [key]` instead of a
    // shallow-PATCH `{ fields: rest }`. The storage layer's mergeAndApplyDeletes
    // honors the deletion signal so the key is actually removed from the JSONB.
    // Shallow PATCH no longer works because storage merges incoming fields onto
    // the existing record (a missing key is a no-op, not a delete).
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fieldsToDelete: [fieldKey] });
    },
    onMutate: async () => {
      // Optimistic: snapshot prev for rollback, then remove the field from cache.
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      const prev = queryClient.getQueryData(["/api/profiles", profileId, "detail"]);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.fields) return old;
        const { [fieldKey]: _, ...rest } = old.fields;
        return { ...old, fields: rest };
      });
      return { prev };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "ai-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Field removed" });
    },
    onError: (_err, _vars, ctx) => {
      // Roll back optimistic cache to the pre-mutation snapshot — invalidating
      // alone leaves the user staring at the field re-appearing several hundred
      // ms later, which makes the UI feel broken.
      const c = ctx as { prev?: unknown } | undefined;
      if (c?.prev) queryClient.setQueryData(["/api/profiles", profileId, "detail"], c.prev);
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
          className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-md opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 text-red-400 hover:text-red-600 hover:bg-red-500/10 active:bg-red-500/20"
          onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
          data-testid={`delete-field-${fieldKey}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{formatKey(fieldKey)}"?</AlertDialogTitle>
            <AlertDialogDescription>This field will be permanently removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { deleteMut.mutate(); setShowDeleteConfirm(false); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
  const displayValue = stringifyField(value);
  const [draft, setDraft] = useState(displayValue);
  const [saving, setSaving] = useState(false);
  const [finding, setFinding] = useState(false);
  const [foundValue, setFoundValue] = useState<{ estimatedValue: number; confidence: string; explanation: string; range?: { low: number; high: number } } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { toast } = useToast();

  // Delete this field
  // P1 universal-delete: send explicit `fieldsToDelete: [key]` instead of
  // shallow-PATCH `{ fields: rest }`. Storage now treats missing keys as
  // no-op (merge) so the only reliable way to remove a key is to send the
  // explicit deletion signal. Also snapshot prev for rollback on error.
  const deleteField = async () => {
    await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
    const prev = queryClient.getQueryData(["/api/profiles", profileId, "detail"]);
    queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
      if (!old?.fields) return old;
      const { [fieldKey]: _, ...rest } = old.fields;
      return { ...old, fields: rest };
    });
    try {
      await apiRequest("PATCH", `/api/profiles/${profileId}`, { fieldsToDelete: [fieldKey] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "ai-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onSaved();
      toast({ title: `"${label}" removed` });
    } catch {
      // Roll back cache to pre-mutation snapshot so the field doesn't briefly
      // disappear and re-appear after invalidation refetch — feels broken.
      if (prev) queryClient.setQueryData(["/api/profiles", profileId, "detail"], prev);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
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
      // Any field edit (mileage, currentValue, etc) can change the AI summary's
      // narrative — invalidate so the next render refetches a fresh summary
      // (server also clears its 2h cache on PATCH).
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "ai-summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
        role="button"
        tabIndex={0}
        aria-label={`Edit ${label}`}
        className="flex items-center justify-between py-2 border-b border-border/30 last:border-0 group cursor-pointer hover:bg-muted/20 px-2 -mx-2 rounded"
        onClick={() => { setDraft(displayValue); setEditing(true); }}
        onKeyDown={onEnterOrSpace(() => { setDraft(displayValue); setEditing(true); })}
      >
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          {isValueField && (
            <button
              onClick={stopProp(findValue)}
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
            {displayValue !== ""
              ? (isValueField && !isNaN(Number(displayValue)) ? `$${Number(displayValue).toLocaleString()}` : displayValue)
              : <span className="text-muted-foreground/40 italic">tap to add</span>}
          </span>
          {/* Delete button — always visible on mobile */}
          {value != null && value !== "" && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
              className="w-9 h-9 flex items-center justify-center rounded-md opacity-50 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 text-red-400 hover:text-red-500 hover:bg-red-500/10 active:bg-red-500/20"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete "{label}"?</AlertDialogTitle>
              <AlertDialogDescription>This field will be permanently removed.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { deleteField(); setShowDeleteConfirm(false); }}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
// Canonical address group reused across profile types. Lists every common
// address key the AI extractor / form writers emit so structured address data
// always lands in a real "Address" group instead of the "Other" catch-all.
const ADDRESS_FIELD_GROUP: { title: string; fields: { key: string; label: string }[] }[] = [
  { title: "Address", fields: [
    { key: "address", label: "Address" },
    { key: "addressLine1", label: "Address Line 1" },
    { key: "addressLine2", label: "Address Line 2" },
    { key: "street", label: "Street" },
    { key: "streetAddress", label: "Street Address" },
    { key: "city", label: "City" },
    { key: "state", label: "State" },
    { key: "stateCode", label: "State Code" },
    { key: "stateName", label: "State Name" },
    { key: "zip", label: "ZIP" },
    { key: "zipCode", label: "ZIP Code" },
    { key: "postalCode", label: "Postal Code" },
    { key: "county", label: "County" },
    { key: "country", label: "Country" },
  ]},
];
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
      { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
    ]},
    // Address group — every common address component the extractor produces.
    // Without these keys, city/state/zip dump into "Other (N)", which is the
    // exact mis-categorization users hit with driver's licenses & IDs.
    ...ADDRESS_FIELD_GROUP,
    { title: "Personal Details", fields: [
      { key: "birthday", label: "Birthday" }, { key: "relationship", label: "Relationship" },
      { key: "bloodType", label: "Blood Type" }, { key: "height", label: "Height" }, { key: "weight", label: "Weight" },
    ]},
    // Identification / Driver's license group — fields most commonly extracted
    // from a linked driver's license / state ID. Without this group these fields
    // dump into "Other (N)" which is confusing for the user.
    { title: "Identification", fields: [
      { key: "license", label: "License #" },
      { key: "licenseNumber", label: "License Number" },
      { key: "licenseExpiration", label: "License Expiration" },
      { key: "expirationDate", label: "Expiration Date" },
      { key: "issueDate", label: "Issue Date" },
      { key: "class", label: "Class" },
      { key: "licenseClass", label: "License Class" },
      { key: "endorsements", label: "Endorsements" },
      { key: "restrictions", label: "Restrictions" },
      { key: "sex", label: "Sex" },
      { key: "eyeColor", label: "Eye Color" },
      { key: "height", label: "Height" },
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
    { title: "Contact", fields: [
      { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
    ]},
    ...ADDRESS_FIELD_GROUP,
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
    } else if (t === "loan" || t === "liability") {
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
  const openTasksCount = (profile.relatedTasks || []).filter((t: any) => normalizeFilter(t.status) !== normalizeFilter("done") && normalizeFilter(t.status) !== normalizeFilter("completed")).length;
  const trackersCount = (profile.relatedTrackers || []).length;

  // ── Field groups ──
  const assetSub = profile.type === "asset" ? (profile.fields?.assetSubtype || null) : null;
  const groups = (assetSub && FIELD_GROUPS[assetSub]) ? FIELD_GROUPS[assetSub] : (FIELD_GROUPS[profile.type] ?? []);
  const groupedKeys = new Set(groups.flatMap(g => g.fields.map(f => f.key)));
  // Keys that are already displayed elsewhere on the page (or are internal)
  // and should NOT also appear under the "Other" catch-all section. `name`
  // is the profile name rendered at the top of the page; alias keys for
  // commonly-edited fields like birthday/phone/address are already promoted
  // via the flatten step so their canonical key is what the user sees.
  const ALWAYS_HIDDEN_FROM_OTHER = new Set([
    "name",
    "dateOfBirth", "dob", "date_of_birth",
    "primaryPhone", "homePhone", "cellPhone",
    "homeAddress", "serviceAddress",
    "patientName",
    "issuingAuthority",
  ]);
  const extraFields = Object.entries(profile.fields).filter(
    ([k, v]) => !groupedKeys.has(k) && !ALWAYS_HIDDEN_FROM_OTHER.has(k) && !k.startsWith("_") && v != null && v !== "" && typeof v !== "object"
  );

  const handleSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  };

  // ── Fetch all profiles for BelongsToEditor candidate list ──
  // Now enabled for liabilities too — they need to nest under a parent asset
  // (e.g. a service plan liability under a TV).
  const isNestedAsset = NESTED_ASSET_TYPES.includes(profile.type as NestedAssetType);
  const isNestableLiability = profile.type === "liability" || profile.type === "loan" || profile.type === "subscription";
  const { data: allProfilesForNesting } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: isNestedAsset || isNestableLiability,
  });

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

      {/* ── Nested Asset Sections — asset types now only render the Location +
          Belongs-to editor here. The Children/Rollup/Maintenance moved to
          dedicated tabs (Contained / Financials / Maintenance) so this
          Overview stays lean per the 2026-05-26 redesign. ── */}
      {isNestedAsset && (
        <NestedAssetSections
          profile={profile}
          allProfiles={allProfilesForNesting || []}
          onSaved={handleSaved}
          mode="location-only"
        />
      )}

      {/* ── Belongs-to for liabilities ──
         Lets the user nest a standalone liability under an asset
         (e.g. "Sony TV extended warranty" under the Sony TV). When nested,
         this liability disappears from the top-level Linked page and only
         appears inside its parent asset's "Linked Liabilities" section. */}
      {isNestableLiability && (
        <Card data-testid="card-liability-belongs-to">
          <CardContent className="p-3">
            <BelongsToEditor
              profile={profile}
              allProfiles={allProfilesForNesting || []}
              onSaved={handleSaved}
            />
          </CardContent>
        </Card>
      )}

      {/* ── Person Highlights ── Show the most personal at-a-glance card up
          front for person/self/pet profiles. Replaces the old Linked People
          block that was hogging the Overview real-estate. */}
      {["self","person","pet"].includes(profile.type) && (() => {
        const f: any = profile.fields || {};
        const birthdayRaw = f.birthday || f.dateOfBirth || f.dob || f.date_of_birth || null;
        const ageFromBirthday = (() => {
          if (!birthdayRaw) return null;
          const d = new Date(typeof birthdayRaw === "string" ? `${birthdayRaw}T12:00:00` : birthdayRaw);
          if (isNaN(d.getTime())) return null;
          const now = new Date();
          let age = now.getFullYear() - d.getFullYear();
          const m = now.getMonth() - d.getMonth();
          if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
          return age >= 0 && age < 130 ? age : null;
        })();
        const daysToBirthday = (() => {
          if (!birthdayRaw) return null;
          const d = new Date(typeof birthdayRaw === "string" ? `${birthdayRaw}T12:00:00` : birthdayRaw);
          if (isNaN(d.getTime())) return null;
          const now = new Date();
          const next = new Date(now.getFullYear(), d.getMonth(), d.getDate());
          if (next.getTime() < new Date(now.setHours(0,0,0,0)).getTime()) next.setFullYear(next.getFullYear() + 1);
          return Math.ceil((next.getTime() - Date.now()) / 86400000);
        })();
        const birthdayLabel = (() => {
          if (!birthdayRaw) return null;
          const d = new Date(typeof birthdayRaw === "string" ? `${birthdayRaw}T12:00:00` : birthdayRaw);
          if (isNaN(d.getTime())) return null;
          return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        })();
        const phone = f.phone || f.primaryPhone || f.cellPhone || f.homePhone || null;
        const email = f.email || null;
        const address = (() => {
          const parts = [f.streetAddress || f.homeAddress || f.serviceAddress || f.address, f.city, f.state || f.region, f.zip || f.zipCode || f.postalCode].filter(Boolean);
          return parts.length ? parts.join(", ") : null;
        })();
        const relationship = f.relationship || null;
        const occupation = f.occupation || f.jobTitle || f.role || null;
        const company = f.employer || f.company || null;
        const bloodType = f.bloodType || null;
        const allergies = f.allergies || null;
        const heightVal = f.height || null;
        const weightVal = f.weight || null;
        const notes = f.notes || f.about || f.bio || null;
        const species = f.species || null;
        const breed = f.breed || null;
        const accentHsl = profile.type === "pet" ? "20 88% 55%" : profile.type === "self" ? "183 98% 32%" : "271 70% 55%";
        const accent = `hsl(${accentHsl})`;
        const accentSoft = `hsl(${accentHsl} / 0.10)`;
        const accentBorder = `hsl(${accentHsl} / 0.35)`;
        const Pill = ({ icon: Icon, label, value }: { icon: any; label: string; value: React.ReactNode }) => (
          <div
            className="flex items-start gap-2 rounded-lg border p-2.5 transition-colors hover:shadow-sm"
            style={{ borderColor: accentBorder, background: accentSoft }}
          >
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
              style={{ background: `hsl(${accentHsl} / 0.22)`, color: accent }}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="text-xs font-semibold mt-0.5 truncate" title={typeof value === "string" ? value : undefined}>{value}</p>
            </div>
          </div>
        );
        const items: React.ReactNode[] = [];
        if (relationship) items.push(<Pill key="rel" icon={Heart} label="Relationship" value={String(relationship)} />);
        if (species || breed) {
          const speciesBreed = [species, breed].filter(Boolean).join(" · ");
          items.push(<Pill key="sb" icon={PawPrint} label="Species" value={speciesBreed} />);
        }
        if (ageFromBirthday != null) items.push(<Pill key="age" icon={Cake} label="Age" value={`${ageFromBirthday} ${ageFromBirthday === 1 ? "year" : "years"}`} />);
        if (birthdayLabel) {
          const sub = daysToBirthday != null ? (daysToBirthday === 0 ? "Today" : daysToBirthday <= 30 ? `in ${daysToBirthday}d` : null) : null;
          items.push(<Pill key="bd" icon={Calendar} label="Birthday" value={sub ? `${birthdayLabel} · ${sub}` : birthdayLabel} />);
        }
        if (phone) items.push(<Pill key="phone" icon={Phone} label="Phone" value={String(phone)} />);
        if (email) items.push(<Pill key="email" icon={Mail} label="Email" value={String(email)} />);
        if (address) items.push(<Pill key="addr" icon={MapPin} label="Address" value={address} />);
        if (occupation) items.push(<Pill key="occ" icon={Briefcase} label="Occupation" value={company ? `${occupation} · ${company}` : String(occupation)} />);
        if (bloodType) items.push(<Pill key="blood" icon={Droplet} label="Blood Type" value={String(bloodType)} />);
        if (heightVal || weightVal) {
          const hw = [heightVal && `${heightVal}`, weightVal && `${weightVal}`].filter(Boolean).join(" · ");
          items.push(<Pill key="hw" icon={Activity} label="Vitals" value={hw} />);
        }
        if (allergies) items.push(<Pill key="alg" icon={AlertTriangle} label="Allergies" value={String(allergies)} />);
        if (items.length === 0 && !notes) return null;
        return (
          <Card
            className="overflow-hidden border"
            style={{ borderColor: accentBorder, background: `linear-gradient(135deg, ${accentSoft} 0%, hsl(var(--card)) 60%)` }}
          >
            <CardContent className="p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-md" style={{ background: `hsl(${accentHsl} / 0.20)`, color: accent }}>
                  <Sparkles className="h-3 w-3" />
                </span>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
                  {profile.type === "pet" ? "Pet Highlights" : "Personal Highlights"}
                </p>
              </div>
              {items.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{items}</div>
              )}
              {notes && (
                <div className="rounded-lg border bg-card/60 p-2.5" style={{ borderColor: accentBorder }}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">About</p>
                  <p className="text-xs leading-relaxed text-foreground/90">{String(notes)}</p>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}

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
      {/* Only show a group if at least one of its fields has a value. This keeps
          large reference groups (e.g. the comprehensive Address group) from
          rendering a wall of empty "tap to add" rows on profiles that don't use
          them, while a group surfaces automatically the moment extraction or a
          manual edit fills any of its fields. */}
      {groups.length > 0 ? (
        groups
          .filter(group => group.fields.some(({ key }) => {
            const v = profile.fields[key];
            return v != null && v !== "" && !(typeof v === "object" && Object.keys(v).length === 0);
          }))
          .slice().sort((a, b) => a.title.localeCompare(b.title)).map(group => {
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
                .sort(([a], [b]) => a.localeCompare(b))
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
              {extraFields.slice().sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => (
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
              <div className="flex-1">
                <label htmlFor="new-field-key" className="sr-only">Field name</label>
                <Input id="new-field-key" placeholder="Field name" aria-label="Field name" value={newFieldKey} onChange={e => setNewFieldKey(e.target.value)} className="h-7 text-xs" data-testid="input-new-field-key" />
              </div>
              <div className="flex-1">
                <label htmlFor="new-field-value" className="sr-only">Value</label>
                <Input id="new-field-value" placeholder="Value" aria-label="Value" value={newFieldValue} onChange={e => setNewFieldValue(e.target.value)} className="h-7 text-xs" data-testid="input-new-field-value" />
              </div>
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

      {/* ── 5b. Liabilities (Phase 1: liabilities are nested profiles) ── */}
      {(() => {
        const kids = (profile.childProfiles || []) as any[];
        const liabilities = kids.filter(c => c.type === "liability" || c.type === "loan");
        if (liabilities.length === 0) return null;
        const liabPct = (l: any) => typeof l._ownershipPercentage === "number" ? l._ownershipPercentage : 100;
        const totalBalance = liabilities.reduce((s: number, l: any) => {
          const f = l.fields || {}; const fin = f.finance || {};
          const v = Number(f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
          // Sum only THIS profile's share of each debt.
          return s + (Number.isFinite(v) ? v * liabPct(l) / 100 : 0);
        }, 0);
        const fmt = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
        return (
          <Card data-testid="profile-liabilities-section">
            <CardHeader className="py-2.5 px-4 flex flex-row items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Wallet className="h-3.5 w-3.5 text-orange-500" />
                <CardTitle className="text-xs font-semibold">Liabilities <span className="text-muted-foreground font-normal">({liabilities.length})</span></CardTitle>
              </div>
              {totalBalance > 0 && (
                <span className="text-xs font-bold tabular-nums text-red-500">{fmt(totalBalance)}</span>
              )}
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 space-y-1.5">
              {liabilities.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((l: any) => {
                const f = l.fields || {}; const fin = f.finance || {};
                const grossBal = Number(f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
                const pct = liabPct(l);
                const bal = grossBal * pct / 100;
                const isShared = pct < 100;
                const apr = f.apr ?? f.interestRate ?? fin.apr ?? fin.interestRate;
                const monthly = f.monthlyPayment ?? fin.monthlyPayment;
                const subtypeRaw = (l.type_key || l.fields?.subtype || "").toString().replace(/_/g, " ");
                return (
                  <Link key={l.id} href={`/profiles/${l.id}`}>
                    <div className="flex items-center gap-2.5 p-2.5 rounded-lg border hover:bg-muted/30 transition-colors cursor-pointer" data-testid={`liability-row-${l.id}`}>
                      <div className="h-7 w-7 rounded-full bg-orange-500/10 flex items-center justify-center shrink-0">
                        <Wallet className="h-3.5 w-3.5 text-orange-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{l.name}</p>
                        <p className="text-xs text-muted-foreground truncate capitalize">
                          {subtypeRaw || "loan"}{apr ? ` · ${apr}${String(apr).includes("%") ? "" : "%"} APR` : ""}{monthly ? ` · ${fmt(Number(monthly))}/mo` : ""}{isShared ? ` · owes ${pct}%` : ""}
                        </p>
                      </div>
                      {isShared && (
                        <span className="text-[10px] font-semibold tabular-nums shrink-0 px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400">{pct}%</span>
                      )}
                      {bal > 0 && (
                        <span className="text-xs font-bold tabular-nums text-red-500 shrink-0" title={isShared ? `${fmt(grossBal)} total · your ${pct}% share` : undefined}>{fmt(bal)}</span>
                      )}
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    </div>
                  </Link>
                );
              })}
            </CardContent>
          </Card>
        );
      })()}

      {/* ── 6. Child Profiles (people/pets only — assets & liabilities have their own sections) ── */}
      {(() => {
        const assetLikeTypes = new Set(["asset","vehicle","property","subscription","investment","insurance","account","liability","loan"]);
        const nonAssetChildren = (profile.childProfiles || []).filter((c: any) => !assetLikeTypes.has(c.type));
        if (nonAssetChildren.length === 0) return null;
        return (
        <Card>
          <CardHeader className="py-2.5 px-4">
            <CardTitle className="text-xs font-semibold">Linked Profiles</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0 space-y-1.5">
            {nonAssetChildren.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((child: any) => {
              const iconMap: Record<string, any> = { subscription: CreditCard, vehicle: Car, asset: Package, loan: Wallet, liability: Wallet, investment: TrendingUp, property: Home, person: User, pet: PawPrint };
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
        );
      })()}

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
      {(profile.tags?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
              {(profile.tags ?? []).slice().sort((a, b) => a.localeCompare(b)).map(tag => (
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

// Habits tab — read-focused view of every habit linked to this profile.
// Data comes from the server embed (profile.relatedHabits), which is filtered
// by the same JSONB linked_profiles containment as documents/trackers/etc., so
// a habit assigned to this person always appears here. Creation/check-in
// management lives on the Habits page (linked below) to keep this surface
// focused on "what habits does this profile have + how are they doing".
// Memoised: pure presentation of the linked-habits list; props are a stable
// react-query array + a string, with no callback props to invalidate the memo.
const ProfileHabitsTab = memo(function ProfileHabitsTab({ habits, profileName }: { habits: any[]; profileName: string }) {
  const today = new Date().toISOString().slice(0, 10);
  if (!habits || habits.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Flame className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No habits linked to {profileName}</p>
          <p className="text-xs text-muted-foreground mt-1">Create a habit on the Habits page and link it to this profile</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {habits.map((h: any) => {
        const checkins = Array.isArray(h.checkins) ? h.checkins : [];
        const doneToday = checkins.some((c: any) => c.date === today);
        const streak = Number(h.currentStreak) || 0;
        return (
          <Card key={h.id} data-testid={`profile-habit-${h.id}`}>
            <CardContent className="py-3 px-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${doneToday ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"}`}>
                  {doneToday ? <Check className="h-4 w-4" /> : <Flame className="h-4 w-4" />}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{h.name}</p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {(h.frequency || "daily")}{Number(h.targetPerDay) > 1 ? ` · ${h.targetPerDay}×/day` : ""}
                    {doneToday ? " · done today" : ""}
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="flex items-center gap-1 justify-end text-sm font-bold tabular-nums">
                  <Flame className={`h-3.5 w-3.5 ${streak > 0 ? "text-orange-500" : "text-muted-foreground/40"}`} />
                  {streak}
                </div>
                <p className="text-[10px] text-muted-foreground">day streak</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
      <Link href="/habits" className="block text-center text-xs text-primary hover:underline py-2" data-testid="link-manage-habits">Manage habits →</Link>
    </div>
  );
});

function DocumentsTab({
  documents: embeddedDocuments,
  profileId,
  profileName,
  childProfiles,
  profileType,
  onUploaded,
}: {
  documents: ProfileDetail["relatedDocuments"];
  profileId: string;
  profileName: string;
  childProfiles?: Profile[];
  profileType?: string;
  onUploaded: () => void;
}) {
  // Smart Fill: pre-select this profile/asset/liability as a source so AI uses its fields
  const smartFillKind: "profile" | "asset" | "liability" =
    profileType === "asset" || profileType === "vehicle" || profileType === "property" ? "asset"
    : profileType === "liability" || profileType === "loan" ? "liability"
    : "profile";
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docSearch, setDocSearch] = useState("");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  const [linkTarget, setLinkTarget] = useState<string>("profile"); // "profile" or a child profile ID
  const { view: docView, setView: setDocView } = useLinkedView(); // Wave 15: list/sheet toggle

  // SINGLE SOURCE OF TRUTH for documents: the canonical `/api/documents` list,
  // filtered by `linkedProfiles` — the exact source + filter the global Linked
  // page uses. Previously this tab relied ONLY on the server `relatedDocuments`
  // embed, so a doc could show on the Linked page (filtered by linkedProfiles)
  // yet be missing here if the embed and the list ever diverged. We now union
  // the embed with the live list so any document linked to this profile (or a
  // child profile) ALWAYS appears. See ARCHITECTURE.md §2 (Documents).
  const { data: allDocsRaw } = useQuery<any[]>({
    queryKey: ["/api/documents"],
    queryFn: async () => (await apiRequest("GET", "/api/documents")).json(),
  });
  const documents = useMemo(() => {
    const byId = new Map<string, any>();
    for (const d of (embeddedDocuments || [])) byId.set(d.id, d);
    for (const d of (allDocsRaw || [])) {
      const linked: string[] = (d.linkedProfiles || []) as string[];
      if (linked.includes(profileId)) byId.set(d.id, { ...byId.get(d.id), ...d });
    }
    return Array.from(byId.values());
  }, [embeddedDocuments, allDocsRaw, profileId]);

  // ── Child-asset documents (Section 5) ──
  const isAssetTypeForDocs = profileType ? NESTED_ASSET_TYPES.includes(profileType as NestedAssetType) : false;
  const { data: treeDataForDocs } = useQuery<TreeNode>({
    queryKey: ["/api/profiles", profileId, "tree"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/tree`);
      return res.json();
    },
    enabled: isAssetTypeForDocs,
    retry: false,
  });

  // Build map of profileId -> childProfile name for attribution
  const childProfileNameMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!treeDataForDocs) return map;
    const collect = (node: TreeNode) => {
      map.set(node.id, node.name);
      for (const c of node.children) collect(c);
    };
    for (const c of treeDataForDocs.children) collect(c);
    return map;
  }, [treeDataForDocs]);

  const descendantIdSetForDocs = useMemo(() => new Set(childProfileNameMap.keys()), [childProfileNameMap]);

  // Direct doc ids (to dedupe from child docs)
  const directDocIds = useMemo(() => new Set(documents.map(d => d.id)), [documents]);

  // Child docs: from childProfiles' relatedDocuments if available, or we get them from tree
  // Since we only have childProfiles from the parent detail endpoint (flat, no docs),
  // we need to use the childProfiles prop's document links.
  // NOTE: The approach here: we fetch child detail lazily only when tree available.
  // For now, we use childProfiles documents if present, filtered by descendantIds.
  const childAssetDocs = useMemo(() => {
    if (!isAssetTypeForDocs || descendantIdSetForDocs.size === 0) return [];
    // childProfiles may carry relatedDocuments in ProfileDetail context
    // We filter to those whose profileId is a descendant
    return (childProfiles || [])
      .filter((cp: any) => descendantIdSetForDocs.has(cp.id))
      .flatMap((cp: any) => {
        const cpDocs = (cp as any).relatedDocuments || [];
        return cpDocs.map((d: any) => ({ ...d, _fromProfileId: cp.id, _fromProfileName: cp.name }));
      })
      .filter((d: any) => !directDocIds.has(d.id))
      // Dedupe by document id
      .filter((d: any, idx: number, arr: any[]) => arr.findIndex((x: any) => x.id === d.id) === idx);
  }, [isAssetTypeForDocs, descendantIdSetForDocs, childProfiles, directDocIds]);

  // Get unique doc types for filter
  const docTypes = useMemo(() => [...new Set(documents.map(d => d.type))].sort(), [documents]);
  // Filter documents
  const filteredDocs = useMemo(() => documents.filter(d => {
    if (docTypeFilter !== "all" && normalizeFilter(d.type) !== normalizeFilter(docTypeFilter)) return false;
    if (docSearch) {
      const q = docSearch.toLowerCase();
      return d.name.toLowerCase().includes(q) || d.type.toLowerCase().includes(q) || (d.tags || []).some((t: string) => t.toLowerCase().includes(q));
    }
    return true;
  }), [documents, docTypeFilter, docSearch]);

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
      // Use /api/upload/save-only — stores the file immediately and links it to
      // the profile without running Claude vision extraction. AI extraction on
      // a multi-MB image can easily exceed Vercel's 60s function timeout,
      // leaving the UI stuck on "Uploading..." indefinitely. Users uploading
      // from a profile's Documents tab want the file SAVED — they can run AI
      // extraction explicitly from the chat / batch upload flow if needed.
      const profileIds = linkTarget === "profile" ? [profileId] : [targetProfileId, profileId];
      const res = await apiRequest("POST", "/api/upload/save-only", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileIds,
      });
      return res.json();
    },
    onSuccess: () => {
      const childName = childProfiles?.find(c => c.id === linkTarget)?.name;
      toast({ title: "Document uploaded", description: childName ? `Linked to ${childName}` : "Linked to this profile." });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  // BUG-20260528-mutation-onmutate-rollback: setQueryData moved to onMutate
  // with snapshot/rollback. See ARCHITECTURE.md §5.3.
  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onMutate: async (docId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/documents"] });
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      const prevDocs = queryClient.getQueryData<any[]>(["/api/documents"]);
      const prevDetail = queryClient.getQueryData<any>(["/api/profiles", profileId, "detail"]);
      queryClient.setQueryData<any[]>(["/api/documents"], (old) => (old || []).filter((d: any) => d.id !== docId));
      queryClient.setQueryData<any>(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.documents) return old;
        return { ...old, documents: old.documents.filter((d: any) => d.id !== docId) };
      });
      return { prevDocs, prevDetail };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Document deleted" });
      setDeletingDocId(null);
      onUploaded();
    },
    onError: (err: Error, _docId, ctx: any) => {
      if (ctx?.prevDocs !== undefined) queryClient.setQueryData(["/api/documents"], ctx.prevDocs);
      if (ctx?.prevDetail !== undefined) queryClient.setQueryData(["/api/profiles", profileId, "detail"], ctx.prevDetail);
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
              {childProfiles.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map(c => (
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
          <SmartFillTrigger
            preselectedSources={[{ id: profileId, kind: smartFillKind, name: profileName }]}
            label="Smart Fill PDF"
            testId="profile-doc-smart-fill"
            className="gap-1.5 text-xs h-8"
          />
        </div>
      </div>

      {/* Search and Filter */}
      {documents.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Search documents..."
              value={docSearch}
              onChange={e => setDocSearch(e.target.value)}
              className="flex-1 h-8 px-3 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <LinkedViewToggle view={docView} onChange={setDocView} />
          </div>
          {docTypes.length > 1 && (
            <div className="flex items-center gap-1 flex-wrap">
              <button onClick={() => setDocTypeFilter("all")} className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${docTypeFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>All ({documents.length})</button>
              {docTypes.map(t => (
                <button key={t} onClick={() => setDocTypeFilter(t)} className={`px-2 py-0.5 rounded text-xs font-medium capitalize transition-colors ${normalizeFilter(docTypeFilter) === normalizeFilter(t) ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{t} ({documents.filter(d => normalizeFilter(d.type) === normalizeFilter(t)).length})</button>
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
      ) : docView === "sheet" ? (
        // Wave 15: Spreadsheet view of documents
        <LinkedSheetView
          rows={filteredDocs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))}
          columns={[
            { key: "name", label: "Name", width: "minmax(180px, 2fr)", render: (d: any) => <span className="font-medium truncate inline-block max-w-full">{d.name}</span> },
            { key: "type", label: "Type", width: "120px", render: (d: any) => <span className="capitalize">{d.type || "—"}</span> },
            { key: "size", label: "Size", width: "80px", align: "right", render: (d: any) => d.size ? `${(d.size / 1024).toFixed(0)} KB` : "—" },
            { key: "uploaded", label: "Uploaded", width: "110px", render: (d: any) => d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "—" },
            { key: "expiration", label: "Expires", width: "110px", render: (d: any) => {
              const exp = d.extractedData?.expirationDate || d.extractedData?.expiry || d.extractedData?.expiration;
              if (!exp) return "—";
              const status = getExpirationStatus(d);
              return <span className={status === "expired" ? "text-red-500" : status === "soon" ? "text-amber-500" : ""}>{new Date(exp).toLocaleDateString()}</span>;
            } },
            { key: "tags", label: "Tags", width: "140px", render: (d: any) => (d.tags || []).slice(0, 3).join(", ") || "—" },
          ]}
          onRowClick={(d: any) => setViewingDoc(d)}
          emptyMessage="No documents match your search"
          testId="linked-docs-sheet"
        />
      ) : (
        <div className="space-y-2">
          {filteredDocs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(doc => {
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
                    {/* Outer wrapper is intentionally a div (not a button)
                        because EditableTitle renders its own buttons inside.
                        Nested <button> elements are invalid HTML and break
                        the rename click in some browsers. We bind onClick
                        on the div and add role/tabIndex for accessibility. */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                      onClick={async () => {
                        try {
                          const res = await apiRequest("GET", `/api/documents/${doc.id}`);
                          const fullDoc = await res.json();
                          setViewingDoc(fullDoc);
                        } catch { setViewingDoc(doc); }
                      }}
                      onKeyDown={async (e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        try {
                          const res = await apiRequest("GET", `/api/documents/${doc.id}`);
                          const fullDoc = await res.json();
                          setViewingDoc(fullDoc);
                        } catch { setViewingDoc(doc); }
                      }}
                    >
                      <div className="text-sm font-medium text-primary" onClick={(e) => e.stopPropagation()}>
                        <EditableTitle
                          value={doc.name}
                          onSave={async (newName) => {
                            await apiRequest("PATCH", `/api/documents/${doc.id}`, { name: newName });
                            queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
                            queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
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
                    </div>
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
                        aria-label={`View ${doc.name}`}
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
                        aria-label={`Delete ${doc.name}`}
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

      {/* Section 5: From child assets (asset-type profiles only, read-only) */}
      {isAssetTypeForDocs && childAssetDocs.length > 0 && (
        <div className="mt-4" data-testid="section-child-docs">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">
            From child assets ({childAssetDocs.length})
          </p>
          <div className="space-y-2">
            {childAssetDocs.map((doc: any) => (
              <Card key={doc.id} data-testid={`card-child-doc-${doc.id}`}>
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
                      {doc.mimeType?.startsWith("image/") ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{doc.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        From: {doc._fromProfileName}
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-xs capitalize shrink-0">{doc.type}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
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

  // ── shared liabilities (person/self only) ──────────────────────
  // Fetches liability_profile_links rows where party_profile_id = this profile.
  // Each link is then resolved to its liability profile via the global /api/profiles cache.
  const isPersonOrSelf = profile.type === "person" || profile.type === "self";
  const { data: sharedLiabilityLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/parties", profileId, "liabilities"],
    queryFn: () => apiRequest("GET", `/api/parties/${profileId}/liabilities`).then(r => r.json()),
    enabled: isPersonOrSelf,
  });
  const { data: allProfilesForLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: isPersonOrSelf && sharedLiabilityLinks.length > 0,
  });
  // Resolve links to liability profiles, dedupe with childProfiles to avoid double-counting.
  // BUG-20260528-perf-memo: wrapped in useMemo so unrelated FinancesTab state updates
  // don't re-run these reduces. Resolver uses canonical shared resolveLiabilityBalance
  // so balance extraction matches every other surface.
  const childProfileIds = useMemo(
    () => new Set((profile.childProfiles || []).map((c: any) => c.id)),
    [profile.childProfiles],
  );
  const sharedLiabilities = useMemo(
    () => (sharedLiabilityLinks || [])
      .map((link: any) => {
        const lp = (allProfilesForLinks || []).find((p: any) => p.id === link.liabilityProfileId);
        if (!lp) return null;
        const ownership = Number(link.ownershipPercentage ?? 100);
        return { link, profile: lp, ownership };
      })
      .filter((x: any) => x && !childProfileIds.has(x.profile.id)),
    [sharedLiabilityLinks, allProfilesForLinks, childProfileIds],
  );
  const sharedLiabilitiesUserShare = useMemo(
    () => sharedLiabilities.reduce((s: number, x: any) => {
      const bal = resolveLiabilityBalance(x.profile.fields || {});
      return s + (bal * (x.ownership / 100));
    }, 0),
    [sharedLiabilities],
  );
  const sharedMonthlyShare = useMemo(
    () => sharedLiabilities.reduce((s: number, x: any) => {
      const f = x.profile.fields || {};
      const fin = f.finance || {};
      const m = Number(f.monthlyPayment ?? fin.monthlyPayment ?? 0);
      return s + (m * (x.ownership / 100));
    }, 0),
    [sharedLiabilities],
  );

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
  // Phase 8: loans live as fields inside an asset profile (not as their own type).
  // Detect loan-shaped data either at top level OR in a nested fields.loan / fields.finance object.
  const loanSub: Record<string, any> = (profile.fields as any)?.loan || (profile.fields as any)?.finance || {};
  const isLoan = profile.type === "loan" || profile.type === "liability" ||
    !!(profile.fields.interestRate || profile.fields.loanBalance || profile.fields.monthlyPayment ||
       loanSub.interestRate || loanSub.apr || loanSub.originalAmount || loanSub.remainingBalance || loanSub.monthlyPayment);
  const isInvestment = profile.type === "investment";
  const isSubscription = profile.type === "subscription";

  // ── expense categories ─────────────────────────────────────────
  const expenseCategories = [
    "education", "entertainment", "food", "general", "health",
    "housing", "insurance", "other", "pet", "shopping",
    "transport", "travel", "utilities", "vehicle",
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

  // Helper: parse "4.29%" or "60 months" or 4.29 into a number.
  const num = (v: any): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const m = String(v).match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  };
  const loanPrincipal = num(profile.fields.originalAmount || profile.fields.loanBalance || profile.fields.remainingBalance || profile.fields.balance || loanSub.originalAmount || loanSub.loanBalance || loanSub.remainingBalance || loanSub.balance);
  const loanRate = num(profile.fields.interestRate || profile.fields.rate || profile.fields.apr || loanSub.interestRate || loanSub.rate || loanSub.apr);
  const loanTerm = num(profile.fields.termMonths || profile.fields.loanTerm || profile.fields.term || loanSub.termMonths || loanSub.loanTerm || loanSub.term);
  const loanMonthlyPayment = num(profile.fields.monthlyPayment || loanSub.monthlyPayment);

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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to update expense", description: formatApiError(err), variant: "destructive" }),
  });

  // BUG-20260528-mutation-onmutate-rollback: previously did setQueryData in
  // onSuccess, which races with concurrent refetches. Moving to onMutate +
  // snapshot/rollback per ARCHITECTURE.md §5.3.
  const deleteExpenseMutation = useMutation({
    mutationFn: async ({ id, desc }: { id: string; desc?: string }) => {
      await apiRequest("DELETE", `/api/expenses/${id}`);
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "expense", entityId: id });
      return { desc };
    },
    onMutate: async ({ id }: { id: string; desc?: string }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/expenses"] });
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      const prevExpenses = queryClient.getQueryData<any[]>(["/api/expenses"]);
      const prevDetail = queryClient.getQueryData<any>(["/api/profiles", profileId, "detail"]);
      queryClient.setQueryData<any[]>(["/api/expenses"], (old) => (old || []).filter((e: any) => e.id !== id));
      queryClient.setQueryData<any>(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.relatedExpenses) return old;
        return { ...old, relatedExpenses: old.relatedExpenses.filter((e: any) => e.id !== id) };
      });
      return { prevExpenses, prevDetail };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.desc || "Expense"}" deleted` });
      setDeleteExpenseId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error, _vars, ctx: any) => {
      if (ctx?.prevExpenses !== undefined) queryClient.setQueryData(["/api/expenses"], ctx.prevExpenses);
      if (ctx?.prevDetail !== undefined) queryClient.setQueryData(["/api/profiles", profileId, "detail"], ctx.prevDetail);
      toast({ title: "Failed", description: formatApiError(err), variant: "destructive" });
    },
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

      {/* SECTION 0 removed (June 2026): the Financial Overview card
          (Net Worth hero + Assets/Liabilities/Shared Liabilities/Monthly
          burn) duplicated content that now lives exclusively on the
          Overview tab via NetWorthStrip + LinkedAssetsTab +
          LinkedLiabilitiesTab. FinancesTab is now expenses-only. */}

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
      {(() => {
        // Normalize every obligation to a monthly $ figure so the header
        // can sum a single "per month" total across mixed frequencies.
        const toMonthly = (amount: number, freq: string | undefined) => {
          const f = (freq || "monthly").toLowerCase();
          if (f === "yearly" || f === "annual" || f === "annually") return amount / 12;
          if (f === "quarterly") return amount / 3;
          if (f === "weekly") return amount * (52 / 12);
          if (f === "biweekly" || f === "bi-weekly") return amount * (26 / 12);
          if (f === "daily") return amount * (365 / 12);
          return amount; // monthly default
        };
        const subs = (obligations || []).filter((o: any) => (o.category || "").toLowerCase() === "subscription");
        const bills = (obligations || []).filter((o: any) => (o.category || "").toLowerCase() !== "subscription");
        const subsMonthly = subs.reduce((s, o) => s + toMonthly(Number(o.amount) || 0, o.frequency), 0);
        const billsMonthly = bills.reduce((s, o) => s + toMonthly(Number(o.amount) || 0, o.frequency), 0);
        const totalMonthly = subsMonthly + billsMonthly;
        return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground" /> Subscriptions &amp; Bills
            </span>
            {obligations.length > 0 && (
              <span className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs font-normal tabular-nums" data-testid="subs-bills-total">{formatCurrency(totalMonthly)}/mo</Badge>
              </span>
            )}
          </CardTitle>
          {obligations.length > 0 && (subsMonthly > 0 || billsMonthly > 0) && (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1">
              {subsMonthly > 0 && <span data-testid="subs-monthly"><span className="font-medium tabular-nums">{formatCurrency(subsMonthly)}/mo</span> subscriptions · {subs.length}</span>}
              {billsMonthly > 0 && <span data-testid="bills-monthly"><span className="font-medium tabular-nums">{formatCurrency(billsMonthly)}/mo</span> bills · {bills.length}</span>}
            </div>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          {obligations.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No recurring bills</p>
          ) : (
            <div className="divide-y divide-border">
              {obligations.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(ob => {
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
        );
      })()}

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
      <Dialog open={!!editingExpense} onOpenChange={(open) => { if (!open) { setExpDesc(""); setExpAmount(""); setExpCategory("general"); setExpVendor(""); setExpDate(new Date().toISOString().slice(0, 10)); } setEditingExpense(open ? editingExpense : null); }}>
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
              <Input className="mt-1" type="number" inputMode="decimal" step="0.01" value={expAmount} onChange={e => setExpAmount(e.target.value)} data-testid="input-edit-expense-amount" />
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
            <Button onClick={() => updateExpenseMutation.mutate()} disabled={updateExpenseMutation.isPending || !expDesc || !expAmount || parseFloat(expAmount) <= 0} data-testid="button-update-expense">
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

  // Guard: tracker.entries may be undefined when the API returns a
  // tracker shape that omits the array. Reading .slice/.length on
  // undefined crashes the whole profile detail page.
  const allEntries: any[] = Array.isArray(tracker.entries) ? tracker.entries : [];
  const last10 = allEntries.slice(-10);

  // Find the first numeric field. Each entry's `values` may be missing
  // when an entry was created by an older path — always treat it as a
  // possibly-undefined dict.
  const numericField = tracker.fields?.find(
    (f: any) => last10.some(e => typeof (e?.values?.[f.name]) === "number")
  );
  const firstEntryVals = last10[0]?.values;
  const fieldName = numericField?.name
    || (firstEntryVals && typeof firstEntryVals === "object" ? Object.keys(firstEntryVals)[0] : null)
    || null;

  const chartData = last10.map((e, i) => {
    const raw = fieldName != null ? e?.values?.[fieldName] : undefined;
    const num = typeof raw === "number" ? raw : Number(raw);
    return {
      i,
      val: isNaN(num) ? 0 : num,
      date: e?.timestamp ? new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "",
    };
  }).filter(d => d.val !== 0 || fieldName == null);

  const latestEntry = last10[last10.length - 1];
  const latestVal = latestEntry && fieldName != null ? latestEntry?.values?.[fieldName] ?? null : null;

  let trend: "up" | "down" | "flat" = "flat";
  if (chartData.length >= 2) {
    const first = chartData[0].val as number;
    const last = chartData[chartData.length - 1].val as number;
    if (last > first * 1.01) trend = "up";
    else if (last < first * 0.99) trend = "down";
  }

  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : Minus;
  const trendColor = trend === "up" ? "text-green-500" : trend === "down" ? "text-red-500" : "text-muted-foreground";

  const sortedEntries = [...allEntries].reverse();

  const deleteEntryMutation = useMutation({
    mutationFn: async (entryId: string) => {
      await apiRequest("DELETE", `/api/trackers/${tracker.id}/entries/${entryId}`);
    },
    onSuccess: (_data, entryId) => {
      queryClient.setQueriesData({ queryKey: ["/api/trackers"] }, (old: any) =>
        Array.isArray(old) ? old.map((t: any) => t.id === tracker.id
          ? { ...t, entries: (t.entries || []).filter((e: any) => e.id !== entryId) }
          : t
        ) : old
      );
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.trackers) return old;
        return { ...old, trackers: old.trackers.map((t: any) => t.id === tracker.id
          ? { ...t, entries: (t.entries || []).filter((e: any) => e.id !== entryId) }
          : t
        )};
      });
      toast({ title: "Entry deleted" });
      setDeleteEntryId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
              <span className="text-xs text-muted-foreground">{allEntries.length} entries</span>
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
        {allEntries.length > 0 ? (
          <>
            {/* Always show last 3 entries */}
            <div className="space-y-0 mt-1">
              {(expanded ? sortedEntries : sortedEntries.slice(0, 3)).map(entry => (
                <div key={entry.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0 text-xs" data-testid={`entry-row-${entry.id}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    {(() => {
                      // Inline tracker row renderer.
                      // Bug fix (PR #18, June 2026): the old code dumped every
                      // entry value comma-joined regardless of type, producing
                      // junk like "2 · 20 · 10:00 · 200 · moderate" on a Running
                      // tracker. Mirror the trackers.tsx insight logic: prefer a
                      // numeric primary field with the tracker's unit; only fall
                      // back to other fields if there is no numeric value; and
                      // suppress string values that just repeat the tracker name.
                      const trackerName = (tracker.name || "").toLowerCase().trim();
                      const pf = tracker.fields?.find((f: any) => f.isPrimary)?.name || tracker.fields?.[0]?.name;
                      const vals = (entry && typeof entry.values === "object" && entry.values !== null) ? entry.values : {};
                      const pv = pf ? vals[pf] : undefined;
                      const isMeaningful = (v: any) => {
                        if (v == null || v === "") return false;
                        if (typeof v === "string" && v.toLowerCase().trim() === trackerName) return false;
                        return true;
                      };
                      const isNumeric = (v: any) => v != null && v !== "" && !isNaN(Number(v));
                      // Prefer the primary field when it's numeric.
                      if (isNumeric(pv)) {
                        const num = Number(pv).toLocaleString(undefined, { maximumFractionDigits: 2 });
                        return <span className="font-mono font-semibold text-sm tabular-nums">{num}{tracker.unit ? ` ${tracker.unit}` : ""}</span>;
                      }
                      // Otherwise find the first numeric field across all values.
                      const numericPair = Object.entries(vals).find(([, v]) => isNumeric(v));
                      if (numericPair) {
                        const num = Number(numericPair[1]).toLocaleString(undefined, { maximumFractionDigits: 2 });
                        return <span className="font-mono font-semibold text-sm tabular-nums">{num}{tracker.unit ? ` ${tracker.unit}` : ""}</span>;
                      }
                      // No numeric data: prefer the primary string field if it's
                      // meaningful, then any meaningful string field.
                      if (typeof pv === "string" && isMeaningful(pv)) {
                        return <span className="font-medium">{pv}</span>;
                      }
                      const meaningfulPair = Object.entries(vals).find(([, v]) => isMeaningful(v));
                      if (meaningfulPair) {
                        return <span className="font-medium">{String(meaningfulPair[1])}</span>;
                      }
                      return <span className="text-muted-foreground italic">(no value)</span>;
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
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const unlinkTrackerMutation = useMutation({
    mutationFn: async (trackerId: string) => {
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "tracker", entityId: trackerId });
    },
    onSuccess: (_data, trackerId) => {
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.trackers) return old;
        return { ...old, trackers: old.trackers.filter((t: any) => t.id !== trackerId) };
      });
      toast({ title: "Tracker unlinked" });
      setUnlinkTrackerId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const deleteTrackerMutation = useMutation({
    mutationFn: async (trackerId: string) => {
      await apiRequest("DELETE", `/api/trackers/${trackerId}`);
    },
    onSuccess: (_data, trackerId) => {
      queryClient.setQueryData(["/api/trackers"], (old: any[]) =>
        old?.filter((t: any) => t.id !== trackerId) || []
      );
      queryClient.setQueriesData({ queryKey: ["/api/trackers"] }, (old: any) =>
        Array.isArray(old) ? old.filter((t: any) => t.id !== trackerId) : old
      );
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.trackers) return old;
        return { ...old, trackers: old.trackers.filter((t: any) => t.id !== trackerId) };
      });
      toast({ title: "Tracker deleted" });
      setDeleteTrackerId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to log entry", description: formatApiError(err), variant: "destructive" }),
  });

  const trackerCategories = ["custom", "finance", "fitness", "health", "mood", "nutrition", "other", "productivity", "sleep", "weight"];

  return (
    <div className="space-y-3">
      {/* Action buttons — "+ New Tracker" removed 2026-05-21 (chat-only).
          "Link Existing" stays because it only attaches an already-created
          tracker to this profile (no creation happens). */}
      <div className="flex gap-2 justify-end">
        {unlinkableTrackers.length > 0 && (
          <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs" onClick={() => setShowLinkTracker(true)} data-testid="button-link-tracker">
            <Link2 className="h-3.5 w-3.5" /> Link Existing
          </Button>
        )}
      </div>

      {trackers.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Activity className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">No linked trackers</p>
            <p className="text-xs text-muted-foreground mt-1">Ask Portol in chat to create one, then link it here.</p>
          </CardContent>
        </Card>
      ) : (
        trackers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(tracker => (
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
              unlinkableTrackers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(tracker => (
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
      <Dialog open={!!showLogEntry} onOpenChange={(open) => { if (!open) { setEntryValue(""); setEntryNotes(""); } setShowLogEntry(open ? showLogEntry : null); }}>
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
      // CRITICAL: Pass linkedProfiles in the POST body so the server attaches
      // the new tracker to THIS profile (not to Self by default). Without this,
      // createTracker() auto-links to Self when linkedProfiles is empty, then
      // the subsequent /link call is silently REJECTED by the PROFILE_EXCLUSIVE
      // isolation guard (trackers can only belong to one profile).
      const res = await apiRequest("POST", "/api/trackers", {
        name, unit: unit || undefined, category,
        fields: [{ name: field, type: fieldType, isPrimary: true }],
        linkedProfiles: [profileId],
        skipDupCheck: true, // quick-add buttons should always succeed for this profile
      });
      const tracker = await res.json();
      // Belt-and-suspenders: also ensure junction row exists. (createTracker
      // already loops and calls linkProfileTo, but this is harmless if it's a
      // no-op.)
      await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "tracker", entityId: tracker.id });
      return tracker;
    },
    onSuccess: (tracker) => {
      toast({ title: `${name} tracker created` });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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

function HealthTabView({ profile, onChanged, includeAll = false }: { profile: ProfileDetail; onChanged: () => void; includeAll?: boolean }) {
  const { toast } = useToast();
  const profileId = profile.id;

  // ── state ──────────────────────────────────────────────────
  const [expandedTrackers, setExpandedTrackers] = useState<Set<string>>(new Set());
  const [logOpen, setLogOpen] = useState<string | null>(null);
  // Per-field values for the inline Log Entry form. Keyed by field name so
  // we can support multi-field trackers (e.g. Blood Pressure needs both
  // systolic and diastolic; Running needs distance + duration).
  const [logFieldVals, setLogFieldVals] = useState<Record<string, string>>({});
  const [logNotes, setLogNotes] = useState("");
  const [notLoggedOpen, setNotLoggedOpen] = useState(false);

  // ── filter trackers ────────────────────────────────────────
  // When `includeAll` is true (aggregate Health & Trackers tab) we surface
  // every linked tracker — not just health-categorized ones. This is what
  // the user sees in the screenshots (Bench Press, Running, Wellness, etc.
  // all sit together).
  const healthCats = ["health", "fitness", "weight", "sleep", "wellness", "nutrition", "medical", "vitals", "diet", "calories", "water", "blood"];
  const healthTrackers = includeAll
    ? (profile.relatedTrackers || [])
    : (profile.relatedTrackers || []).filter((t: any) =>
        healthCats.some(c => (t.category || "").toLowerCase().includes(c) || (t.name || "").toLowerCase().includes(c))
      );

  // ── category accent (color + icon) ─────────────────────────
  // Delegates to the central theme system — see lib/category-theme.ts.
  function categoryAccent(t: any): CategoryTheme {
    return categoryTheme(t?.category, t?.name);
  }

  // ── helpers ───────────────────────────────────────────────
  function getPrimaryField(tracker: any): string {
    return tracker.fields?.find((f: any) => f.isPrimary)?.name || tracker.fields?.[0]?.name || "value";
  }

  function getLatestValue(tracker: any): number | string | null {
    const pf = getPrimaryField(tracker);
    const sorted = [...(tracker.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const v = sorted[0]?.values?.[pf];
    if (v == null || v === "") return null;
    const num = Number(v);
    return isNaN(num) ? String(v) : num;
  }

  // ── Entry value formatting ────────────────────────────────
  // A tracker entry stores arbitrary fields in `values`. The bare value of
  // the primary field is rarely informative on its own (e.g. a "Running"
  // tracker that just records the literal string "running", or a Hydration
  // tracker whose primary field is named "value" with no unit attached).
  // This helper renders a single human-readable line per entry that:
  //   • formats blood-pressure as "125/80 mmHg"
  //   • formats numeric values with the appropriate unit (field.unit or
  //     tracker.unit)
  //   • drops values that just repeat the tracker name ("running", "guitar")
  //     in favour of secondary fields and notes
  //   • joins all useful secondary fields (duration, distance, calories, …)
  //     so a Running entry shows e.g. "3.2 mi · 28 min · 320 cal"
  function formatEntryDisplay(tracker: any, entry: any): { primary: string; secondary: string } {
    const fields: any[] = Array.isArray(tracker.fields) ? tracker.fields : [];
    const vals: Record<string, any> = entry?.values || {};
    const trackerNameLower = String(tracker.name || "").toLowerCase().trim();

    // Blood pressure: render systolic/diastolic
    const sys = vals["systolic"] ?? vals["systolic_pressure"] ?? vals["sbp"];
    const dia = vals["diastolic"] ?? vals["diastolic_pressure"] ?? vals["dbp"];
    if (sys != null && dia != null && !isNaN(Number(sys)) && !isNaN(Number(dia))) {
      return { primary: `${Number(sys)}/${Number(dia)} mmHg`, secondary: "" };
    }

    const primaryFieldName = getPrimaryField(tracker);
    // Helper: format a single field value with its unit (or the tracker's
    // unit when the field has none). Numbers get locale-formatted; durations
    // are nudged toward "min" if no unit is set.
    const fmtField = (f: any): string | null => {
      const v = vals[f.name];
      if (v == null || v === "") return null;
      const num = Number(v);
      // Field-level unit wins. Fall back to the tracker-level unit only for
      // the primary field (so Hydration whose tracker.unit is "oz" renders
      // "90 oz" instead of bare "90"). Duration fields default to "min".
      const fallbackUnit = f.name === primaryFieldName ? (tracker.unit || "") : "";
      const unit = (f.unit || fallbackUnit || (f.type === "duration" ? "min" : "") || "").trim();
      if (!isNaN(num) && typeof v !== "boolean") {
        const formatted = num.toLocaleString(undefined, { maximumFractionDigits: 2 });
        return unit ? `${formatted} ${unit}` : formatted;
      }
      if (typeof v === "boolean") return v ? "yes" : "no";
      const s = String(v).trim();
      if (!s) return null;
      // Drop literal repeats of the tracker name ("running", "guitar")
      if (s.toLowerCase() === trackerNameLower) return null;
      return s;
    };

    // Collect useful fields, primary first. Skip internal notes field.
    const ordered = [
      ...fields.filter((f: any) => f.name === primaryFieldName),
      ...fields.filter((f: any) => f.name !== primaryFieldName && f.name !== "_notes"),
    ];
    const parts: string[] = [];
    for (const f of ordered) {
      const piece = fmtField(f);
      if (piece) parts.push(piece);
    }

    // Fallback: include any free-form values from `values` not declared as
    // fields (e.g. ad-hoc keys saved from chat).
    if (parts.length === 0) {
      for (const [k, v] of Object.entries(vals)) {
        if (k === "_notes" || v == null || v === "") continue;
        if (fields.some((f: any) => f.name === k)) continue;
        const s = typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v).trim();
        if (!s) continue;
        if (s.toLowerCase() === trackerNameLower) continue;
        parts.push(`${k}: ${s}`);
      }
    }

    // Notes get appended as secondary detail (or become the primary when no
    // value could be derived — better to show "30 min practice" than "—").
    const notes = (vals["_notes"] as string | undefined) || entry?.notes || "";
    if (parts.length === 0) {
      return notes ? { primary: notes, secondary: "" } : { primary: "\u2014", secondary: "" };
    }
    return { primary: parts.join(" \u00b7 "), secondary: notes };
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

  function relativeLastLog(days: number | null): string | null {
    if (days == null) return null;
    if (days === 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function getStreak(tracker: any): number {
    if (!tracker.entries?.length) return 0;
    const dates = tracker.entries.map((e: any) => toLocalDateStr(new Date(e.timestamp), BROWSER_TIMEZONE));
    return calculateStreak(dates, { today: getUserToday(BROWSER_TIMEZONE) }).current;
  }

  // ── log entry mutation ────────────────────────────────────
  // Optimistic so the new entry appears in the expanded list and the
  // header value the instant the user clicks Save — the server round-trip
  // and cache invalidation just confirm what we already drew.
  const logMutation = useMutation<
    unknown,
    Error,
    { trackerId: string; values: Record<string, any>; notes: string },
    { prevDetail: any; tempId: string }
  >({
    mutationFn: async ({ trackerId, values, notes }) => {
      await apiRequest("POST", `/api/trackers/${trackerId}/entries`, { values, notes });
    },
    onMutate: async ({ trackerId, values, notes }) => {
      const detailKey = ["/api/profiles", profileId, "detail"];
      await queryClient.cancelQueries({ queryKey: detailKey });
      const prevDetail = queryClient.getQueryData<any>(detailKey);
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const optimisticEntry = {
        id: tempId,
        trackerId,
        values,
        notes,
        timestamp: new Date().toISOString(),
      };
      queryClient.setQueryData<any>(detailKey, (old: any) => {
        if (!old || !Array.isArray(old.relatedTrackers)) return old;
        return {
          ...old,
          relatedTrackers: old.relatedTrackers.map((t: any) =>
            t.id === trackerId
              ? { ...t, entries: [...(t.entries || []), optimisticEntry] }
              : t,
          ),
        };
      });
      return { prevDetail, tempId };
    },
    onSuccess: () => {
      toast({ title: "Entry logged" });
      setLogOpen(null); setLogFieldVals({}); setLogNotes("");
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prevDetail) {
        queryClient.setQueryData(["/api/profiles", profileId, "detail"], ctx.prevDetail);
      }
      toast({ title: "Failed", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
  });

  // ── empty state ───────────────────────────────────────────
  if (healthTrackers.length === 0) {
    return (
      <div className="space-y-3">
        <Card className="overflow-hidden border-dashed">
          <CardContent className="py-10 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-rose-500/10 text-rose-500 mb-3">
              <HeartPulse className="h-6 w-6" />
            </div>
            <p className="text-sm font-semibold">No trackers yet</p>
            <p className="text-xs text-muted-foreground mt-1.5 max-w-xs mx-auto">Ask Portol in chat to start one — try “track my weight” or “log my workouts”.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Section 1: Vital cards ──
  const vitalCards = healthTrackers.map((t: any) => {
    const pf = getPrimaryField(t);
    const latest = getLatestValue(t);
    const prev = getPrevValue(t);
    const avg7 = get7DayAvg(t);
    const trend = getTrend(t);
    // Sparkline data: most-recent 14 entries, oldest first so the line
    // reads left-to-right chronologically.
    const sparkData = [...(t.entries || [])]
      .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
      .slice(-14)
      .map((e: any) => ({ v: Number(e.values?.[pf] ?? 0) }));
    const sorted = [...(t.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const daysSince = sorted[0]?.timestamp ? Math.floor((Date.now() - new Date(sorted[0].timestamp).getTime()) / 86400000) : null;
    const accent = categoryAccent(t);
    return { tracker: t, pf, latest, prev, avg7, trend, sparkData, daysSince, accent };
  }).filter((v: any) => typeof v.latest === 'number' && !isNaN(v.latest)).sort((a: any, b: any) => (a.tracker.name || '').localeCompare(b.tracker.name || ''));

  // ── Section 2: Top 3 trend charts ──
  // Only trackers whose primary field actually produces ≥2 numeric data
  // points qualify — otherwise the area chart was rendering with “NaN”
  // as the latest value (e.g. a Calories tracker that only stored the
  // literal string “calories”).
  const topChartTrackers = [...healthTrackers]
    .map((t: any) => {
      const pf = getPrimaryField(t);
      const numericCount = (t.entries || []).filter((e: any) => {
        const v = e.values?.[pf];
        return v != null && v !== "" && !isNaN(Number(v));
      }).length;
      return { t, numericCount };
    })
    .filter((x) => x.numericCount >= 2)
    .sort((a, b) => b.numericCount - a.numericCount)
    .slice(0, 3)
    .map((x) => x.t);

  // ── Section 5: Insights ──
  const insights: { key: string; text: string; level: "warn" | "info" | "good" }[] = [];
  for (const t of healthTrackers) {
    const latest = getLatestValue(t);
    const avg7 = get7DayAvg(t);
    const trend = getTrend(t);
    const days = getDaysSinceLastEntry(t);
    const streak = getStreak(t);
    const nameLower = (t.name || "").toLowerCase();
    if (nameLower.includes("weight") && trend === "up" && latest != null && avg7 != null) {
      insights.push({ key: `weight-up-${t.id}`, text: `Weight trending up — ${Number(latest).toFixed(1)} ${t.unit || ""} vs ${Number(avg7).toFixed(1)} ${t.unit || ""} (7-day avg)`, level: "warn" });
    }
    if ((nameLower.includes("blood pressure") || nameLower.includes("bp")) && latest != null && Number(latest) > 130) {
      insights.push({ key: `bp-${t.id}`, text: `Blood pressure reading is elevated (${latest} ${t.unit || "mmHg"})`, level: "warn" });
    }
    if (days != null && days >= 3 && t.entries?.length > 0) {
      insights.push({ key: `no-log-${t.id}`, text: `No ${t.name} logged in ${days} day${days !== 1 ? "s" : ""}`, level: "info" });
    }
    if (streak >= 3) {
      insights.push({ key: `streak-${t.id}`, text: `${t.name}: ${streak}-day logging streak`, level: "good" });
    }
  }

  return (
    <div className="space-y-5">

      {/* ── Section 1: Vitals Dashboard ── */}
      {vitalCards.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1.5">
            <span className="inline-flex w-4 h-4 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-500">
              <Sparkles className="h-2.5 w-2.5" />
            </span>
            At a Glance
          </p>
          {/*
            Auto-fit grid so cards stretch to fill any leftover space
            instead of leaving a stranded card on its own row. Each card
            wants ≥ 200px; the grid will pack as many as fit per row.
          */}
          <div
            className="grid gap-2.5"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
          >
            {vitalCards.map(({ tracker, latest, avg7, trend, sparkData, daysSince, accent }: any) => {
              const trendColor = trend === "up" ? "text-emerald-500" : trend === "down" ? "text-rose-500" : "text-muted-foreground";
              const lineColor = `hsl(${accent.hsl})`;
              const fillId = `vital-fill-${tracker.id}`;
              const lastLogRel = relativeLastLog(daysSince);
              const Icon = accent.icon;
              return (
                <div
                  key={tracker.id}
                  className="relative rounded-xl border p-3 flex flex-col gap-1.5 overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-md"
                  style={{
                    borderColor: `hsl(${accent.hsl} / 0.30)`,
                    background: `linear-gradient(135deg, hsl(${accent.hsl} / 0.12) 0%, hsl(var(--card)) 70%)`,
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className="inline-flex w-5 h-5 items-center justify-center rounded-md shrink-0"
                      style={{ background: `hsl(${accent.hsl} / 0.22)`, color: lineColor }}
                    >
                      <Icon className="h-3 w-3" />
                    </span>
                    <p className="text-xs font-semibold truncate flex-1" title={tracker.name}>{tracker.name}</p>
                  </div>
                  <div className="flex items-end justify-between">
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold tabular-nums leading-none" style={{ color: lineColor }}>
                        {typeof latest === "number" ? Number(latest).toLocaleString(undefined, { maximumFractionDigits: 1 }) : latest}
                      </span>
                      {tracker.unit && <span className="text-[10px] text-muted-foreground font-medium">{tracker.unit}</span>}
                    </div>
                    <div className={`flex items-center gap-0.5 text-[10px] font-bold ${trendColor}`}>
                      {trend === "up" && <ArrowUp className="h-3 w-3" />}
                      {trend === "down" && <ArrowDown className="h-3 w-3" />}
                      {trend === "flat" && <Minus className="h-3 w-3" />}
                    </div>
                  </div>
                  {sparkData.length >= 2 ? (
                    <div style={{ width: "100%", height: 30 }}>
                      <ResponsiveContainer width="100%" height={30}>
                        <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={lineColor} stopOpacity={0.55} />
                              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <Area type="monotone" dataKey="v" stroke={lineColor} fill={`url(#${fillId})`} strokeWidth={1.75} dot={false} isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="h-[30px] flex items-center">
                      <div className="w-full h-px bg-gradient-to-r from-transparent via-muted-foreground/30 to-transparent" />
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="font-medium">{avg7 != null ? `7d avg ${avg7.toFixed(1)}` : ""}</span>
                    {lastLogRel && <span>{lastLogRel}</span>}
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
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1.5">
            <span className="inline-flex w-4 h-4 items-center justify-center rounded-md bg-violet-500/15 text-violet-500">
              <BarChart2 className="h-2.5 w-2.5" />
            </span>
            Trends
          </p>
          <div className="space-y-2.5">
            {topChartTrackers.map((t: any) => {
              const pf = getPrimaryField(t);
              const accent = categoryAccent(t);
              const lineColor = `hsl(${accent.hsl})`;
              const fillId = `trend-fill-${t.id}`;
              // Oldest to newest so the time axis reads left-to-right.
              // Drop entries whose primary field isn’t numeric (e.g. a
              // “Running” tracker that only stored the literal text
              // “running”) so Number() doesn’t produce NaN and surface
              // “NaN” as the latest value or break the area chart.
              const chartData = [...(t.entries || [])]
                .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                .slice(-30)
                .map((e: any) => {
                  const raw = e.values?.[pf];
                  const num = raw == null || raw === "" ? NaN : Number(raw);
                  return {
                    date: new Date(e.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                    value: isNaN(num) ? null : num,
                  };
                })
                .filter((d: any) => d.value !== null);
              const latest: number | null = chartData.length ? (chartData[chartData.length - 1].value as number) : null;
              return (
                <Card
                  key={t.id}
                  className="overflow-hidden border"
                  style={{ borderColor: `hsl(${accent.hsl} / 0.25)` }}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="inline-flex w-5 h-5 items-center justify-center rounded-md"
                          style={{ background: `hsl(${accent.hsl} / 0.22)`, color: lineColor }}
                        >
                          <accent.icon className="h-3 w-3" />
                        </span>
                        <p className="text-xs font-semibold">{t.name}</p>
                      </div>
                      {latest != null && !isNaN(latest) && (
                        <span className="text-sm font-bold tabular-nums" style={{ color: lineColor }}>
                          {latest.toLocaleString(undefined, { maximumFractionDigits: 1 })}{t.unit ? <span className="text-[10px] text-muted-foreground ml-0.5 font-medium">{t.unit}</span> : null}
                        </span>
                      )}
                    </div>
                    <ResponsiveContainer width="100%" height={120}>
                      <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 4 }}>
                        <defs>
                          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={lineColor} stopOpacity={0.5} />
                            <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                          tickLine={false}
                          axisLine={false}
                          interval="preserveStartEnd"
                          minTickGap={24}
                        />
                        <YAxis
                          tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                          tickLine={false}
                          axisLine={false}
                          width={32}
                          domain={["auto", "auto"]}
                        />
                        <Tooltip
                          contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: `1px solid hsl(${accent.hsl} / 0.4)`, borderRadius: 8, padding: "6px 10px" }}
                          labelStyle={{ color: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          formatter={(val: number) => [`${val.toLocaleString(undefined, { maximumFractionDigits: 1 })}${t.unit ? " " + t.unit : ""}`, t.name]}
                        />
                        <Area type="monotone" dataKey="value" stroke={lineColor} fill={`url(#${fillId})`} strokeWidth={2.25} isAnimationActive={false} dot={{ r: 2.5, fill: lineColor, strokeWidth: 0 }} activeDot={{ r: 4, fill: lineColor, stroke: "hsl(var(--card))", strokeWidth: 2 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Section 3: All Trackers ── */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1.5">
          <span className="inline-flex w-4 h-4 items-center justify-center rounded-md bg-sky-500/15 text-sky-500">
            <Activity className="h-2.5 w-2.5" />
          </span>
          All Trackers
          <span className="text-[10px] font-medium text-muted-foreground normal-case tracking-normal">({healthTrackers.length})</span>
        </p>
        {(() => {
          // ── Partition trackers ────────────────────────────────────────
          const sortedAll = healthTrackers.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
          type Bucket = "active" | "label" | "empty";
          const buckets: Record<Bucket, any[]> = { active: [], label: [], empty: [] };
          for (const t of sortedAll) {
            const v = getLatestValue(t);
            if (v == null || (t.entries?.length || 0) === 0) buckets.empty.push(t);
            else if (typeof v === "number") buckets.active.push(t);
            else buckets.label.push(t);
          }

          // Per-tracker row renderer (numeric or full card).
          const renderRow = (t: any) => {
            const pf = getPrimaryField(t);
            const latest = getLatestValue(t);
            const sortedEntries = [...(t.entries || [])].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            const lastEntry = sortedEntries[0];
            const lastDate = lastEntry ? new Date(lastEntry.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
            const isExpanded = expandedTrackers.has(t.id);
            const isLogging = logOpen === t.id;
            const accent = categoryAccent(t);
            const lineColor = `hsl(${accent.hsl})`;
            const Icon = accent.icon;
            // Render the latest entry through formatEntryDisplay so the
            // collapsed header shows e.g. "125/80 mmHg" for BP, "3.2 mi
            // · 28 min" for a Run, or "30 min practice" for a Guitar
            // entry — never just the tracker name or a bare number.
            const latestFormatted = lastEntry ? formatEntryDisplay(t, lastEntry) : null;
            const headerValue = latestFormatted?.primary && latestFormatted.primary !== "\u2014"
              ? latestFormatted.primary
              : null;
            const isNumericHeader = typeof latest === "number";

            return (
              <Card
                key={t.id}
                className="overflow-hidden border transition-shadow hover:shadow-sm"
                style={{ borderColor: `hsl(${accent.hsl} / 0.25)` }}
              >
                <CardContent className="p-0">
                  <button
                    className="w-full flex items-center gap-3 text-left p-3 transition-colors hover:bg-muted/30"
                    onClick={() => setExpandedTrackers(prev => {
                      const s = new Set(prev);
                      if (s.has(t.id)) s.delete(t.id); else s.add(t.id);
                      return s;
                    })}
                    data-testid={`button-tracker-${t.id}`}
                  >
                    <span
                      className="inline-flex w-9 h-9 items-center justify-center rounded-lg shrink-0"
                      style={{ background: `hsl(${accent.hsl} / 0.18)`, color: lineColor }}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{t.name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        {t.category && (
                          <span
                            className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: `hsl(${accent.hsl} / 0.15)`, color: lineColor }}
                          >
                            {t.category}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">{t.entries?.length || 0} entries</span>
                        {lastDate && <span className="text-[11px] text-muted-foreground">· last {lastDate}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 min-w-0">
                      {headerValue && (
                        <span
                          className={isNumericHeader
                            ? "text-base font-bold tabular-nums whitespace-nowrap"
                            : "text-xs text-muted-foreground max-w-[180px] truncate"}
                          style={{ color: isNumericHeader ? lineColor : undefined }}
                          title={headerValue}
                        >
                          {headerValue}
                        </span>
                      )}
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-3 pt-1 border-t border-border/30 space-y-3">
                      {sortedEntries.length > 0 ? (
                        <div className="space-y-0">
                          {sortedEntries.slice(0, 10).map((entry: any) => {
                            const formatted = formatEntryDisplay(t, entry);
                            return (
                              <div key={entry.id} className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-0 text-xs gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                  <span className="font-mono font-semibold tabular-nums truncate" style={{ color: lineColor }} title={formatted.primary}>
                                    {formatted.primary}
                                  </span>
                                  {formatted.secondary && (
                                    <span className="text-muted-foreground truncate" title={formatted.secondary}>
                                      {formatted.secondary}
                                    </span>
                                  )}
                                </div>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {new Date(entry.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground text-center py-2">No entries yet — tap “Log Entry” to start.</p>
                      )}

                      {isLogging ? (() => {
                        // One input per declared field so multi-field
                        // trackers (BP → systolic + diastolic, Running →
                        // distance + duration) can be logged in one shot.
                        // Fall back to a single "value" field for legacy
                        // trackers with no fields declared.
                        const formFields: any[] = Array.isArray(t.fields) && t.fields.length > 0
                          ? t.fields.filter((f: any) => f.name !== "_notes")
                          : [{ name: pf, type: "number", unit: t.unit || "" }];
                        const canSave = !logMutation.isPending && (
                          formFields.some((f: any) => {
                            const raw = logFieldVals[f.name];
                            return raw !== undefined && raw !== "";
                          }) || !!logNotes.trim()
                        );
                        const submit = () => {
                          if (!canSave) return;
                          const values: Record<string, any> = {};
                          for (const f of formFields) {
                            const raw = logFieldVals[f.name];
                            if (raw === undefined || raw === "") continue;
                            if (f.type === "number" || f.type === "duration") {
                              const num = Number(raw);
                              if (!isNaN(num)) values[f.name] = num;
                            } else if (f.type === "boolean") {
                              values[f.name] = raw === "true" || raw === "yes";
                            } else {
                              values[f.name] = raw;
                            }
                          }
                          logMutation.mutate({ trackerId: t.id, values, notes: logNotes });
                        };
                        return (
                          <div
                            className="flex flex-col gap-2 p-2.5 rounded-lg border bg-muted/30"
                            style={{ borderColor: `hsl(${accent.hsl} / 0.35)` }}
                            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
                          >
                            <p className="text-xs font-medium">Log Entry — {t.name}</p>
                            <div className="grid grid-cols-2 gap-2">
                              {formFields.map((f: any, idx: number) => {
                                const fieldUnit = f.unit || (f.name === pf ? (t.unit || "") : "") || (f.type === "duration" ? "min" : "");
                                const isNumeric = f.type === "number" || f.type === "duration";
                                return (
                                  <Input
                                    key={f.name}
                                    type={isNumeric ? "number" : "text"}
                                    inputMode={isNumeric ? "decimal" : undefined}
                                    className="h-7 text-xs"
                                    placeholder={`${f.name}${fieldUnit ? ` (${fieldUnit})` : ""}`}
                                    value={logFieldVals[f.name] ?? ""}
                                    onChange={(e) => setLogFieldVals(prev => ({ ...prev, [f.name]: e.target.value }))}
                                    autoFocus={idx === 0}
                                  />
                                );
                              })}
                              <Input
                                type="text"
                                className="h-7 text-xs col-span-2"
                                placeholder="Notes (optional)"
                                value={logNotes}
                                onChange={e => setLogNotes(e.target.value)}
                              />
                            </div>
                            <div className="flex gap-1.5">
                              <Button
                                size="sm"
                                className="h-7 text-xs flex-1"
                                style={{ background: lineColor, color: "white" }}
                                disabled={!canSave}
                                onClick={submit}
                                data-testid={`button-save-log-${t.id}`}
                              >
                                {logMutation.isPending ? "Saving..." : "Save"}
                              </Button>
                              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setLogOpen(null); setLogFieldVals({}); setLogNotes(""); }}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        );
                      })() : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs w-full gap-1"
                          style={{ borderColor: `hsl(${accent.hsl} / 0.4)`, color: lineColor }}
                          onClick={() => { setLogOpen(t.id); setLogFieldVals({}); setLogNotes(""); }}
                          data-testid={`button-log-entry-${t.id}`}
                        >
                          <Plus className="h-3.5 w-3.5" /> Log Entry
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          };

          return (
            <div className="space-y-2">
              {/* Active numeric trackers */}
              {buckets.active.map(renderRow)}

              {/* String-valued / label trackers — small italic style */}
              {buckets.label.length > 0 && (
                <>
                  {buckets.active.length > 0 && (
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pt-2 px-0.5">Labels</p>
                  )}
                  {buckets.label.map(renderRow)}
                </>
              )}

              {/* Not yet logged — collapsible */}
              {buckets.empty.length > 0 && (
                <div className="pt-1">
                  <button
                    className="w-full flex items-center justify-between text-left px-3 py-2 rounded-lg border border-dashed border-border/60 hover:bg-muted/30 transition-colors"
                    onClick={() => setNotLoggedOpen(v => !v)}
                    data-testid="button-toggle-not-logged"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Not yet logged ({buckets.empty.length})
                    </span>
                    {notLoggedOpen
                      ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                  {notLoggedOpen && (
                    <div className="space-y-2 mt-2">
                      {buckets.empty.map(renderRow)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      </div>

            {/* ── Section 5: Insights ── */}
      {insights.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-0.5 flex items-center gap-1.5">
            <span className="inline-flex w-4 h-4 items-center justify-center rounded-md bg-amber-500/15 text-amber-500">
              <Sparkles className="h-2.5 w-2.5" />
            </span>
            Insights
          </p>
          <div className="space-y-1.5">
            {insights.map(ins => (
              <div key={ins.key} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                ins.level === "warn" ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300" :
                ins.level === "good" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" :
                "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300"
              }`}>
                {ins.level === "warn" && <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                {ins.level === "good" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                {ins.level === "info" && <Activity className="h-3.5 w-3.5 shrink-0 mt-0.5" />}
                <span className="font-medium">{ins.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

// Memoised: groups/sorts the full timeline on every render; its only prop is
// the timeline array (stable react-query reference), so memo skips that work
// when unrelated page state changes.
const TimelineTab = memo(function TimelineTab({ timeline }: { timeline: TimelineEntry[] }) {
  const [filter, setFilter] = useState<string>("all");

  const TIMELINE_ICONS: Record<string, any> = {
    tracker: HeartPulse, expense: DollarSign, task: ListTodo,
    event: Calendar, document: FileText, note: FileText,
    habit: Activity, obligation: CreditCard, journal: FileText,
  };

  const typeCounts: Record<string, number> = {};
  for (const e of timeline) typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;

  const filtered = filter === "all" ? timeline : timeline.filter(e => normalizeFilter(e.type) === normalizeFilter(filter));

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

  const filterTypes = ["all", ...Object.keys(typeCounts).sort((a, b) => a.localeCompare(b))];

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
                {g.items.slice().sort((a, b) => {
                  // Within same date group, keep date-sorted but within same timestamp, sort alphabetically
                  const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                  if (timeDiff !== 0) return timeDiff;
                  return (a.title || '').localeCompare(b.title || '');
                }).map(entry => (
                  <TimelineItem key={entry.id} entry={entry} />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
});

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
    // Optimistic update — flip the status immediately in the profile detail cache
    // so the checkbox/UI snaps without waiting for the network round trip.
    onMutate: async ({ taskId, status }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      const prev = queryClient.getQueryData<any>(["/api/profiles", profileId, "detail"]);
      if (prev) {
        queryClient.setQueryData(["/api/profiles", profileId, "detail"], {
          ...prev,
          tasks: Array.isArray(prev.tasks)
            ? prev.tasks.map((t: any) => t.id === taskId ? { ...t, status } : t)
            : prev.tasks,
        });
      }
      // Same for the bare /api/tasks list — cover all variant keys.
      queryClient.setQueriesData({ queryKey: ["/api/tasks"] }, (old: any) =>
        Array.isArray(old) ? old.map((t: any) => t.id === taskId ? { ...t, status } : t) : old
      );
      return { prev };
    },
    onSuccess: (_data, variables) => {
      toast({ title: variables.status === "done" ? `"${variables.title || "Task"}" completed` : `"${variables.title || "Task"}" reopened` });
      onChanged();
    },
    onError: (err: Error, variables, context: any) => {
      // Roll back the optimistic update on failure
      if (context?.prev) queryClient.setQueryData(["/api/profiles", profileId, "detail"], context.prev);
      toast({ title: `Failed to update "${variables.title || "task"}"`, description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // Reconcile with server to catch any drift
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to create task", description: formatApiError(err), variant: "destructive" }),
  });

  // BUG-20260528-mutation-onmutate-rollback: setQueryData moved to onMutate
  // with snapshot/rollback. See ARCHITECTURE.md §5.3.
  const deleteTaskMutation = useMutation({
    mutationFn: async ({ id, title }: { id: string; title?: string }) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
      await apiRequest("POST", `/api/profiles/${profileId}/unlink`, { entityType: "task", entityId: id });
      return { title };
    },
    onMutate: async ({ id }: { id: string; title?: string }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/tasks"] });
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      // Snapshot all /api/tasks query slots since we use setQueriesData
      const prevTasksAll = queryClient.getQueriesData<any>({ queryKey: ["/api/tasks"] });
      const prevDetail = queryClient.getQueryData<any>(["/api/profiles", profileId, "detail"]);
      queryClient.setQueriesData({ queryKey: ["/api/tasks"] }, (old: any) =>
        Array.isArray(old) ? old.filter((t: any) => t.id !== id) : old
      );
      queryClient.setQueryData<any>(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.tasks) return old;
        return { ...old, tasks: old.tasks.filter((t: any) => t.id !== id) };
      });
      return { prevTasksAll, prevDetail };
    },
    onSuccess: (_data, variables) => {
      toast({ title: `"${variables.title || "Task"}" deleted` });
      setDeleteTaskId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error, _vars, ctx: any) => {
      if (ctx?.prevTasksAll) {
        for (const [key, val] of ctx.prevTasksAll) queryClient.setQueryData(key, val);
      }
      if (ctx?.prevDetail !== undefined) queryClient.setQueryData(["/api/profiles", profileId, "detail"], ctx.prevDetail);
      toast({ title: "Failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  // Default to "open" so completed tasks don't clutter the main view.
  // User explicitly requested on 2026-05-21: "I completed the task however
  // it still shows up it should be removed." Completed tasks remain
  // accessible via the "Completed" filter chip but are hidden by default.
  const [taskFilter, setTaskFilter] = useState<"all" | "open" | "done">("open");

  const open = tasks.filter(t => normalizeFilter(t.status) !== normalizeFilter("done"));
  const done = tasks.filter(t => normalizeFilter(t.status) === normalizeFilter("done"));
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

  /* ST8: re-seed form fields whenever the underlying profile changes
     (different id OR mutated in the cache by another flow). The initial
     useState seed only runs on first mount — without this effect, opening
     the dialog for profile B after editing profile A would briefly show
     A's values, and AI-driven mutations to the open profile would be
     overwritten on save. */
  useEffect(() => {
    setName(profile.name);
    setNotes(profile.notes || "");
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(profile.fields || {})) {
      if (v != null && typeof v !== "object") result[k] = String(v);
    }
    setFields(result);
  }, [profile.id, open]);

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
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
  const allFieldKeys = [...new Set([...existingFieldKeys, ...suggested.map(s => s.key)])].sort((a, b) => a.localeCompare(b));
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
  // Person / Self — restructured June 2026 to give every piece of data
  // exactly one home and eliminate cross-tab duplication.
  //
  //   Overview   → profile summary + net worth + assets + liabilities
  //                (everything you own and owe lives here, nowhere else).
  //   Finance    → expenses, budgets, recurring costs, payments only
  //                (no asset/liability rollup — that's Overview).
  //   Trackers   → trackers only (was previously mixed with Documents).
  //   Documents  → documents only (was previously labeled "Documents"
  //                but actually routed to a tab that ALSO showed Notes).
  //   History    → activity feed: tasks, events, expenses, recent changes.
  //   Habits     → habits only.
  //
  // Belongings tab was removed entirely (June 2026) — it duplicated
  // assets/liabilities/finance with the new Overview + Finance split.
  person: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finance", label: "Finance", testId: "tab-finance" },
    { value: "person-trackers", label: "Trackers", testId: "tab-person-trackers" },
    { value: "person-documents", label: "Documents", testId: "tab-person-documents" },
    { value: "habits", label: "Habits", testId: "tab-habits" },
    { value: "person-history", label: "History", testId: "tab-person-history" },
  ],
  self: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "finance", label: "Finance", testId: "tab-finance" },
    { value: "person-trackers", label: "Trackers", testId: "tab-person-trackers" },
    { value: "person-documents", label: "Documents", testId: "tab-person-documents" },
    { value: "habits", label: "Habits", testId: "tab-habits" },
    { value: "person-history", label: "History", testId: "tab-person-history" },
  ],
  // Pet — care focused. "Health & Vet" tab removed 2026-05-21: it contained
  // quick-create tracker buttons (Weight/BP/Sleep/Calories/Water/Vaccination)
  // which violated the chat-only tracker-creation rule. All pet trackers
  // now live under the single Trackers tab (chat creates them, this tab
  // shows them). No ownership-history tab (pets aren't financial assets).
  pet: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "all-trackers", label: "Trackers", testId: "tab-all-trackers" },
    { value: "habits", label: "Habits", testId: "tab-habits" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "tasks", label: "Reminders", testId: "tab-tasks" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
  ],
  // Vehicle — maintenance + money focused. Loan + Costs collapsed into Money.
  // Note: "history" (ownership) and "timeline" (activity) were previously BOTH
  // labeled "History" — deduped by renaming timeline to "Activity".
  vehicle: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "history", label: "History", testId: "tab-history" },
    { value: "tasks", label: "Maintenance", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Loan — payment focused. Loan + Payments collapsed into Money.
  loan: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  // Investment
  investment: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  // Subscription — Billing + Details collapsed into Money; Impact stays separate.
  subscription: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "impact", label: "Impact", testId: "tab-impact" },
  ],
  // Medical provider
  medical: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "health", label: "Records", testId: "tab-health" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Visits", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  // Property / Home. Loan + Costs collapsed into Money.
  property: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "history", label: "History", testId: "tab-history" },
    { value: "tasks", label: "Maintenance", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
  ],
  // Asset (laptop, device, etc.) — Loan + Costs collapsed into Money.
  asset: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "history", label: "History", testId: "tab-history" },
    { value: "tasks", label: "Maintenance", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
  ],
  // Account
  account: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
};

// Fallback for any type not explicitly defined. Money tab fuses loan + finances.
const DEFAULT_TABS: TabDef[] = [
  { value: "info", label: "Overview", testId: "tab-info" },
  { value: "money", label: "Money", testId: "tab-money" },
  { value: "trackers", label: "Documents", testId: "tab-trackers" },
  { value: "activity", label: "Activity", testId: "tab-activity" },
  { value: "timeline", label: "Timeline", testId: "tab-timeline" },
  { value: "notes", label: "Notes", testId: "tab-notes" },
  { value: "history", label: "History", testId: "tab-history" },
];

// ── Asset subtype tab configs ──
// Phase 8: every asset subtype includes a Loan tab. Anything you own —
// iPhone, refrigerator, laptop, collectible, business, even a bank account —
// can be financed, so the Loan tab is universal.
const ASSET_SUBTYPE_TABS: Record<string, TabDef[]> = {
  // 2026-05-26 fix: every asset subtype now includes Contained + Financials
  // so child assets and the value rollup are reachable regardless of
  // subtype. The Money tab already exposes a "Linked liabilities" section
  // for any asset/vehicle/property profile, so liability linking is
  // reachable from Money on every subtype.
  bank_account: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "linked-subs", label: "Subscriptions", testId: "tab-linked-subs" },
    { value: "trackers", label: "Statements", testId: "tab-trackers" },
    { value: "insights", label: "Insights", testId: "tab-insights" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  credit_card: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "payments", label: "Payments", testId: "tab-payments" },
    { value: "rewards", label: "Rewards", testId: "tab-rewards" },
    { value: "trackers", label: "Statements", testId: "tab-trackers" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  digital_asset: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "access", label: "Access", testId: "tab-access" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  business: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "tasks", label: "Operations", testId: "tab-tasks" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "insights", label: "Insights", testId: "tab-insights" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  collectible: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "valuation", label: "Valuation", testId: "tab-valuation" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  loan_receivable: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "notes", label: "Notes", testId: "tab-notes" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
  high_value_item: [
    { value: "info", label: "Overview", testId: "tab-info" },
    { value: "contained", label: "Contained", testId: "tab-contained" },
    { value: "financials", label: "Financials", testId: "tab-financials" },
    { value: "money", label: "Money", testId: "tab-money" },
    { value: "warranty", label: "Warranty", testId: "tab-warranty" },
    { value: "trackers", label: "Documents", testId: "tab-trackers" },
    { value: "timeline", label: "Activity", testId: "tab-timeline" },
    { value: "history", label: "History", testId: "tab-history" },
  ],
};

// ─── Loan Tab ─────────────────────────────────────────────────────────
function LoanTab({ profile, obligations, hideEmptyEditor }: { profile: any; obligations: any[]; hideEmptyEditor?: boolean }) {
  const { toast } = useToast();
  // Walk every known camelCase + snake_case + nested storage path. Loans created
  // by the AI engine store at fields.finance.{lender,apr,term,monthlyPayment,...},
  // not at the top level. Without nested coverage the LoanTab shows zeros.
  const f = profile.fields || {};
  const fin = f.finance || {};
  const ln = f.loan || {};
  // Strip $, commas, %, spaces and parse to number
  const num = (v: any): number => {
    if (v == null || v === '') return 0;
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/[$,%\s]/g, ''));
      return isFinite(n) ? n : 0;
    }
    return 0;
  };
  const firstNum = (...vals: any[]): number => {
    for (const v of vals) { const n = num(v); if (n > 0) return n; }
    return 0;
  };
  const firstStr = (...vals: any[]): string => {
    for (const v of vals) { if (v != null && v !== '') return String(v); }
    return '';
  };
  // For loan balance, prefer remaining over original (so the displayed “balance” reflects payoff progress)
  const loanBalance = firstNum(
    f.remainingBalance, f.remaining_balance, fin.remainingBalance, fin.remaining_balance, ln.remainingBalance, ln.remaining_balance,
    f.loanBalance, f.loan_balance, fin.loanBalance, fin.loan_balance,
    f.outstandingBalance, f.outstanding_balance, fin.outstandingBalance, fin.outstanding_balance,
    f.originalAmount, f.original_amount, fin.originalAmount, fin.original_amount,
    f.balance, fin.balance, ln.balance
  );
  const interestRate = firstNum(
    f.interestRate, f.interest_rate, f.rate, f.apr,
    fin.interestRate, fin.interest_rate, fin.rate, fin.apr,
    ln.interestRate, ln.interest_rate, ln.rate, ln.apr
  );
  const monthlyPayment = firstNum(
    f.monthlyPayment, f.monthly_payment, fin.monthlyPayment, fin.monthly_payment, ln.monthlyPayment, ln.monthly_payment
  );
  const termMonths = firstNum(
    f.termMonths, f.term_months, f.loanTerm, f.loan_term, f.term,
    fin.termMonths, fin.term_months, fin.loanTerm, fin.loan_term, fin.term,
    ln.termMonths, ln.term_months, ln.term
  );
  const lender = firstStr(
    f.lender, f.bank, fin.lender, fin.bank, ln.lender, ln.bank
  );
  const startDate = firstStr(
    f.loanStartDate, f.loan_start_date, f.startDate, f.start_date, f.purchaseDate, f.purchase_date,
    fin.loanStartDate, fin.loan_start_date, fin.startDate, fin.start_date,
    ln.startDate, ln.start_date
  );

  const hasLoanData = loanBalance > 0 || interestRate > 0 || monthlyPayment > 0;

  // Payoff calculator state — must be at component top level (hook rule)
  const [extraPmt, setExtraPmt] = useState(0);
  // Wave 13: amortization show-all toggle (hook must live at top level)
  const [showAllSchedule, setShowAllSchedule] = useState(false);

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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" }),
  });
  const clearLoanMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields: { originalAmount: null, loanBalance: null, interestRate: null, termMonths: null, monthlyPayment: null, lender: null, loanStartDate: null } });
    },
    onSuccess: () => { toast({ title: "Loan data cleared" }); queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/profiles"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); },
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

  // Wave 13: Paid-to-date stats. If a startDate is set, infer how many months
  // have elapsed and split the schedule into paid vs remaining.
  const monthsElapsed = (() => {
    if (!startDate) return 0;
    const start = new Date(startDate);
    const now = new Date();
    if (isNaN(start.getTime())) return 0;
    const months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    return Math.max(0, Math.min(schedule.length, months));
  })();
  const paidSlice = schedule.slice(0, monthsElapsed);
  const remainingSlice = schedule.slice(monthsElapsed);
  const principalPaid = paidSlice.reduce((s, r) => s + r.principal, 0);
  const interestPaid = paidSlice.reduce((s, r) => s + r.interest, 0);
  const totalPaid = principalPaid + interestPaid;
  const principalRemaining = remainingSlice.reduce((s, r) => s + r.principal, 0);
  const interestRemaining = remainingSlice.reduce((s, r) => s + r.interest, 0);
  const remainingBalanceComputed = remainingSlice.length > 0 ? remainingSlice[0].balance + remainingSlice[0].principal : loanBalance;
  const percentPaid = loanBalance > 0 ? Math.min(100, (principalPaid / loanBalance) * 100) : 0;

  // Linked obligations (existing payments)
  const linkedObs = obligations.filter((o: any) =>
    o.linkedProfiles?.includes(profile.id) || o.name?.toLowerCase().includes(profile.name?.toLowerCase())
  );

  // Wave 13: Auto-create a recurring monthly bill linked to this loan.
  const hasLinkedMonthlyBill = linkedObs.some((o: any) => o.frequency === "monthly" && o.linkedProfiles?.includes(profile.id));
  const createBillMutation = useMutation({
    mutationFn: async () => {
      if (!monthlyPayment || monthlyPayment <= 0) throw new Error("Monthly payment is required");
      // Compute next due date: same day-of-month as startDate, next occurrence.
      const due = (() => {
        const today = new Date();
        const ref = startDate ? new Date(startDate) : today;
        const day = ref.getDate();
        const next = new Date(today.getFullYear(), today.getMonth(), day);
        if (next <= today) next.setMonth(next.getMonth() + 1);
        return next.toISOString().slice(0, 10);
      })();
      const billName = `${profile.name || lender || "Loan"} payment`;
      await apiRequest("POST", "/api/obligations", {
        name: billName,
        amount: Math.round(monthlyPayment * 100) / 100,
        frequency: "monthly",
        category: "loan",
        nextDueDate: due,
        autopay: false,
        linkedProfiles: [profile.id],
      });
    },
    onSuccess: () => {
      toast({ title: "Monthly bill created", description: "This loan will now appear in your bills." });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      // Calendar uses keys like ["/api/calendar/timeline", start, end, mode, ...ids]
      // — match by exact first key so all variants are refreshed.
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    },
    onError: (err: Error) => toast({ title: "Failed to create bill", description: formatApiError(err), variant: "destructive" }),
  });

  // Wave 17: Mark Paid + Early Payoff for the linked monthly bill.
  const [earlyPayoffOpen, setEarlyPayoffOpen] = useState(false);
  const [earlyPayoffAmount, setEarlyPayoffAmount] = useState("");
  const linkedMonthlyBill = linkedObs.find((o: any) => o.frequency === "monthly" && o.linkedProfiles?.includes(profile.id));
  const markPaidMutation = useMutation({
    mutationFn: async (amount?: number) => {
      if (!linkedMonthlyBill) throw new Error("No linked bill");
      const body: any = {};
      if (amount && amount > 0) body.amount = Math.round(amount * 100) / 100;
      await apiRequest("POST", `/api/obligations/${linkedMonthlyBill.id}/pay`, body);
      // If paying more than monthly payment, reduce the loan balance accordingly.
      const paid = amount && amount > 0 ? amount : monthlyPayment;
      if (paid > 0) {
        // Reduce the principal balance by the principal portion (pmt minus interest)
        // For early payoff (paid > monthlyPayment), the extra goes 100% to principal.
        const interestThisMonth = (loanBalance * (interestRate / 100)) / 12;
        const principalPortion = Math.max(0, paid - interestThisMonth);
        const newBalance = Math.max(0, loanBalance - principalPortion);
        const fields: any = { ...(profile.fields || {}) };
        // Write to the same path the loan tab reads from.
        if (fields.loan && typeof fields.loan === "object") {
          fields.loan = { ...fields.loan, remainingBalance: Math.round(newBalance * 100) / 100, balance: Math.round(newBalance * 100) / 100 };
        } else if (fields.finance && typeof fields.finance === "object") {
          fields.finance = { ...fields.finance, balance: Math.round(newBalance * 100) / 100 };
        } else {
          fields.loanBalance = Math.round(newBalance * 100) / 100;
        }
        await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields });
      }
    },
    onSuccess: (_d, paid) => {
      const isEarly = paid && paid > monthlyPayment * 1.01;
      toast({
        title: isEarly ? "Early payment recorded" : "Payment marked paid",
        description: isEarly ? `Extra principal applied to your loan balance.` : `${formatCurrency(monthlyPayment)} payment recorded.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      setEarlyPayoffOpen(false);
      setEarlyPayoffAmount("");
    },
    onError: (err: Error) => toast({ title: "Payment failed", description: formatApiError(err), variant: "destructive" }),
  });

  // When liabilities are linked to this asset, the linked liability's profile
  // owns the canonical loan data — suppress the empty "Add Loan Details" form
  // on the asset itself so the user doesn't see a confusing blank editor.
  if (!editing && !hasLoanData && hideEmptyEditor) {
    return null;
  }

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
                type="number" inputMode="decimal" placeholder="e.g. 25000" value={formBalance}
                onChange={e => setFormBalance(e.target.value)}
                data-testid="input-loan-balance"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Interest Rate (%)</label>
              <Input
                type="number" inputMode="decimal" step="0.01" placeholder="e.g. 5.5" value={formRate}
                onChange={e => setFormRate(e.target.value)}
                data-testid="input-loan-rate"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Term (months)</label>
              <Input
                type="number" inputMode="numeric" placeholder="e.g. 60" value={formTerm}
                onChange={e => setFormTerm(e.target.value)}
                data-testid="input-loan-term"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Monthly Payment ($)</label>
              <Input
                type="number" inputMode="decimal" step="0.01" placeholder="e.g. 477" value={formPayment}
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
              <p className="text-sm font-bold">{remainingSlice.length}</p>
            </div>
          </div>
          {/* Progress bar — uses principal paid so far */}
          <div className="mt-3">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Paid off</span>
              <span>{percentPaid > 0 ? `${percentPaid.toFixed(1)}%` : "—"}</span>
            </div>
            <Progress value={percentPaid} className="h-2" />
          </div>
        </Card>
      )}

      {/* Wave 13: Paid-to-date breakdown — only when we have a start date */}
      {schedule.length > 0 && monthsElapsed > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold">Paid to Date</h3>
            <span className="text-[10px] text-muted-foreground">{monthsElapsed} of {schedule.length} months</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border/50 p-3">
              <p className="text-[10px] text-muted-foreground">Total paid</p>
              <p className="text-base font-bold tabular-nums">{formatCurrency(totalPaid)}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <span className="text-green-500">● Principal</span>
                  <p className="font-semibold tabular-nums">{formatCurrency(principalPaid)}</p>
                </div>
                <div>
                  <span className="text-red-400">● Interest</span>
                  <p className="font-semibold tabular-nums">{formatCurrency(interestPaid)}</p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-border/50 p-3">
              <p className="text-[10px] text-muted-foreground">Remaining</p>
              <p className="text-base font-bold tabular-nums">{formatCurrency(principalRemaining + interestRemaining)}</p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <span className="text-green-500">● Principal</span>
                  <p className="font-semibold tabular-nums">{formatCurrency(principalRemaining)}</p>
                </div>
                <div>
                  <span className="text-red-400">● Interest</span>
                  <p className="font-semibold tabular-nums">{formatCurrency(interestRemaining)}</p>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Current balance</span>
            <span className="font-semibold tabular-nums">{formatCurrency(remainingBalanceComputed)}</span>
          </div>
        </Card>
      )}

      {/* Wave 13: Auto-create monthly bill */}
      {hasLoanData && monthlyPayment > 0 && !hasLinkedMonthlyBill && (
        <Card className="p-4 border-dashed border-primary/40">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold mb-1">Track this loan in Bills</h3>
              <p className="text-[10px] text-muted-foreground">Creates a recurring monthly obligation of {formatCurrency(monthlyPayment)} so it shows up on your dashboard and calendar.</p>
            </div>
            <Button
              size="sm"
              className="shrink-0 h-8 text-xs"
              onClick={() => createBillMutation.mutate()}
              disabled={createBillMutation.isPending}
              data-testid="button-create-loan-bill"
            >
              {createBillMutation.isPending ? "Adding…" : "Add monthly bill"}
            </Button>
          </div>
        </Card>
      )}

      {/* Wave 17: Mark Paid + Early Payoff. Shown only when a linked bill exists. */}
      {linkedMonthlyBill && monthlyPayment > 0 && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-xs font-semibold mb-0.5">Payment Tracker</h3>
              <p className="text-[10px] text-muted-foreground">
                Next due {linkedMonthlyBill.nextDueDate?.slice(0, 10)} · {formatCurrency(linkedMonthlyBill.amount || monthlyPayment)}
              </p>
            </div>
            <Badge variant="outline" className="text-[10px]">{Math.round(percentPaid)}% paid</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="default"
              className="h-8 text-xs"
              onClick={() => markPaidMutation.mutate(undefined)}
              disabled={markPaidMutation.isPending}
              data-testid="button-mark-paid"
            >
              {markPaidMutation.isPending && !earlyPayoffOpen ? "Recording…" : `Mark this month paid`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => setEarlyPayoffOpen(o => !o)}
              data-testid="button-early-payoff-toggle"
            >
              {earlyPayoffOpen ? "Cancel" : "Pay extra / pay off early"}
            </Button>
          </div>
          {earlyPayoffOpen && (
            <div className="mt-3 pt-3 border-t border-border">
              <label className="text-[10px] text-muted-foreground mb-1 block">
                Amount to pay (current balance: {formatCurrency(loanBalance)})
              </label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  placeholder={`e.g. ${Math.max(monthlyPayment, loanBalance)}`}
                  value={earlyPayoffAmount}
                  onChange={e => setEarlyPayoffAmount(e.target.value)}
                  data-testid="input-early-payoff-amount"
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-[10px] shrink-0"
                  onClick={() => setEarlyPayoffAmount(String(loanBalance.toFixed(2)))}
                  data-testid="button-fill-payoff"
                  type="button"
                >
                  Pay off
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-[10px] shrink-0"
                  onClick={() => {
                    const v = parseFloat(earlyPayoffAmount);
                    if (!v || v <= 0) {
                      toast({ title: "Enter an amount", variant: "destructive" });
                      return;
                    }
                    markPaidMutation.mutate(v);
                  }}
                  disabled={markPaidMutation.isPending || !earlyPayoffAmount}
                  data-testid="button-submit-early-payoff"
                >
                  {markPaidMutation.isPending ? "…" : "Submit"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                Extra above this month’s interest goes straight to principal, shortening your payoff date.
              </p>
            </div>
          )}
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

      {/* Wave 13: Full amortization schedule with show-all toggle and current-month highlight */}
      {schedule.length > 0 && (() => {
        const visible = showAllSchedule ? schedule : (() => {
          // Default view: first 12 + ... + last 3 (existing behavior)
          if (schedule.length <= 15) return schedule;
          return [...schedule.slice(0, 12), null as any, ...schedule.slice(-3)];
        })();
        const startDateObj = startDate ? new Date(startDate) : null;
        return (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold">Amortization Schedule</h3>
              {schedule.length > 15 && (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowAllSchedule(s => !s)} data-testid="button-toggle-schedule">
                  {showAllSchedule ? `Collapse` : `Show all ${schedule.length} months`}
                </Button>
              )}
            </div>
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-1 pr-2">#</th>
                    <th className="text-left py-1 px-2">Date</th>
                    <th className="text-right py-1 px-2">Payment</th>
                    <th className="text-right py-1 px-2">Principal</th>
                    <th className="text-right py-1 px-2">Interest</th>
                    <th className="text-right py-1 pl-2">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, idx) => {
                    if (row === null) {
                      return (
                        <tr key="sep"><td colSpan={6} className="text-center py-2 text-muted-foreground">… {schedule.length - 15} more months …</td></tr>
                      );
                    }
                    const isPaid = row.month <= monthsElapsed;
                    const isCurrent = row.month === monthsElapsed + 1;
                    const dateStr = startDateObj ? (() => {
                      const d = new Date(startDateObj.getTime());
                      d.setMonth(d.getMonth() + row.month);
                      return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
                    })() : "—";
                    return (
                      <tr key={`${row.month}-${idx}`} className={`border-b border-border/30 ${isCurrent ? "bg-primary/8" : isPaid ? "opacity-60" : ""}`}>
                        <td className="py-1 pr-2 text-muted-foreground">{row.month}{isCurrent ? " · now" : ""}</td>
                        <td className="py-1 px-2 text-muted-foreground">{dateStr}</td>
                        <td className="text-right py-1 px-2">{formatCurrency(row.payment)}</td>
                        <td className="text-right py-1 px-2 text-green-500">{formatCurrency(row.principal)}</td>
                        <td className="text-right py-1 px-2 text-red-400">{formatCurrency(row.interest)}</td>
                        <td className="text-right py-1 pl-2 font-medium">{formatCurrency(row.balance)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })()}

      {/* Linked Obligations */}
      {linkedObs.length > 0 && (
        <Card className="p-4">
          <h3 className="text-xs font-semibold mb-2">Linked Payments</h3>
          <div className="space-y-2">
            {linkedObs.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((ob: any) => (
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
  const { toast } = useToast();
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
    onSuccess: () => { toast({ title: "Claim added" }); queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); setShowAdd(false); setClaimDesc(""); setClaimAmt(""); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed to add claim", description: formatApiError(err), variant: "destructive" }),
  });
  const deleteClaimMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: (_data, id) => {
      queryClient.setQueryData(["/api/expenses"], (old: any[]) => old?.filter((e: any) => e.id !== id) || []);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.relatedExpenses) return old;
        return { ...old, relatedExpenses: old.relatedExpenses.filter((e: any) => e.id !== id) };
      });
      toast({ title: "Claim deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to delete claim", description: formatApiError(err), variant: "destructive" }),
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
            {!showAdd && <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-claim"><Plus className="h-3 w-3" />Add Claim</Button>}
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
  const { toast } = useToast();
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
    onSuccess: () => { toast({ title: "Redemption added" }); queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); setShowAdd(false); setRedDesc(""); setRedPts(""); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed to add redemption", description: formatApiError(err), variant: "destructive" }),
  });
  const deleteRedemptionMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: (_data, id) => {
      queryClient.setQueryData(["/api/expenses"], (old: any[]) => old?.filter((e: any) => e.id !== id) || []);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.relatedExpenses) return old;
        return { ...old, relatedExpenses: old.relatedExpenses.filter((e: any) => e.id !== id) };
      });
      toast({ title: "Redemption deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to delete redemption", description: formatApiError(err), variant: "destructive" }),
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
            {!showAdd && <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-redemption"><Plus className="h-3 w-3" />Record Redemption</Button>}
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
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setShowApiKey(!showApiKey)} data-testid="button-toggle-apikey">
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
  const { toast } = useToast();
  const credentials: { label: string; username: string; url: string }[] = (() => { try { return Array.isArray(fields.credentials) ? fields.credentials : JSON.parse(fields.credentials || "[]"); } catch { return []; } })();
  const [showAdd, setShowAdd] = useState(false);
  const [cLabel, setCLabel] = useState("");
  const [cUser, setCUser] = useState("");
  const [cUrl, setCUrl] = useState("");
  const saveMutation = useMutation({
    mutationFn: async (updatedCreds: any[]) => { await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { ...fields, credentials: updatedCreds } }); },
    onSuccess: () => { toast({ title: "Credentials updated" }); queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed to save credentials", description: formatApiError(err), variant: "destructive" }),
  });
  const handleAdd = () => { saveMutation.mutate([...credentials, { label: cLabel, username: cUser, url: cUrl }]); setShowAdd(false); setCLabel(""); setCUser(""); setCUrl(""); };
  const handleDelete = (idx: number) => { saveMutation.mutate(credentials.filter((_, i) => i !== idx)); };
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Saved Credentials ({credentials.length})</p>
          {!showAdd && <Button variant="outline" size="sm" className="h-8 text-xs gap-1" onClick={() => setShowAdd(true)} data-testid="button-add-credential"><Plus className="h-3 w-3" />Add Credential</Button>}
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
  const { toast } = useToast();
  const appraisals: { date: string; value: string; source: string }[] = (() => { try { return Array.isArray(fields.appraisals) ? fields.appraisals : JSON.parse(fields.appraisals || "[]"); } catch { return []; } })();
  const [showAdd, setShowAdd] = useState(false);
  const [aDate, setADate] = useState(new Date().toISOString().slice(0, 10));
  const [aValue, setAValue] = useState("");
  const [aSource, setASource] = useState("");
  const saveMutation = useMutation({
    mutationFn: async (updated: any[]) => { await apiRequest("PATCH", `/api/profiles/${profileId}`, { fields: { ...fields, appraisals: updated } }); },
    onSuccess: () => { toast({ title: "Appraisal updated" }); queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed to save appraisal", description: formatApiError(err), variant: "destructive" }),
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
  const [, navigate] = useLocation();
  const { view, setView } = useLinkedView();
  const children = (profile.childProfiles || []).filter((c: any) => c.type === "subscription");
  const sortedChildren = children.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''));
  const totalMonthly = children.reduce((sum: number, c: any) => sum + (Number(c.fields?.cost) || 0), 0);

  const subColumns: SheetColumn<any>[] = [
    { key: "name", label: "Name", width: "minmax(140px, 1.5fr)", render: (s) => <span className="font-medium">{s.name || "—"}</span> },
    { key: "cost", label: "Cost", width: "100px", align: "right", render: (s) => <span className="tabular-nums">{s.fields?.cost ? formatCurrency(Number(s.fields.cost)) : "—"}</span> },
    { key: "frequency", label: "Frequency", width: "100px", render: (s) => s.fields?.frequency || "monthly" },
    { key: "category", label: "Category", width: "120px", render: (s) => s.fields?.category || "—" },
    { key: "renewal", label: "Next Renewal", width: "120px", render: (s) => s.fields?.renewalDate ? new Date(s.fields.renewalDate).toLocaleDateString() : "—" },
  ];

  return (
    <div className="space-y-3" data-testid="linked-subs-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Linked Subscriptions</span>
            <div className="flex items-center gap-2">
              {totalMonthly > 0 && <Badge variant="outline" className="text-xs">{formatCurrency(totalMonthly)}/mo</Badge>}
              {sortedChildren.length > 0 && <LinkedViewToggle view={view} onChange={setView} />}
            </div>
          </div>
          {sortedChildren.length > 0 ? (
            view === "sheet" ? (
              <LinkedSheetView
                rows={sortedChildren}
                columns={subColumns}
                onRowClick={(s) => navigate(`/profiles/${s.id}`)}
                emptyMessage="No subscriptions linked"
                testId="linked-subs-sheet"
              />
            ) : (
              <div className="divide-y divide-border/30">
                {sortedChildren.map((sub: any) => (
                  <div key={sub.id} role="button" tabIndex={0} aria-label={`Open subscription: ${sub.name}`} className="flex items-center justify-between py-2 cursor-pointer hover:bg-muted/30 -mx-3 px-3 rounded" onClick={() => navigate(`/profiles/${sub.id}`)} onKeyDown={onEnterOrSpace(() => navigate(`/profiles/${sub.id}`))}>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{sub.name}</p>
                      <p className="text-xs text-muted-foreground">{sub.fields?.frequency || "monthly"}</p>
                    </div>
                    <span className="text-xs font-medium tabular-nums">{sub.fields?.cost ? formatCurrency(Number(sub.fields.cost)) : "—"}</span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">No subscriptions linked to this account</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// LinkedLiabilitiesTab — person/self profile tab
// Shows every liability this person owns / co-owns (via
// liability_profile_links). Each row reveals collateral assets and all
// co-owners with their ownership %, and exposes inline CRUD:
//   • Add / edit / delete co-owner links (people)
//   • Add / delete collateral asset links
//   • Link an existing liability to this person (with ownership %)
//   • Unlink a liability
// All edits invalidate the relevant queries so dashboards stay in sync.
// ────────────────────────────────────────────────────────────────────
function LinkedLiabilitiesTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // ── data: links + all profiles (for resolving names + picker options) ──
  const { data: partyLinks = [], refetch: refetchPartyLinks } = useQuery<any[]>({
    queryKey: ["/api/parties", profileId, "liabilities"],
    queryFn: () => apiRequest("GET", `/api/parties/${profileId}/liabilities`).then(r => r.json()),
  });
  const { data: allProfiles = [], refetch: refetchAllProfiles } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Resolve link rows → liability profiles. The server now returns BOTH
  // direct ownership rows AND propagated rows (reached via an asset the
  // person owns part of). If the same liability appears in both lists —
  // e.g. Jane is both a direct co-borrower AND a 50% owner of the
  // securing asset — we keep the direct row and drop the propagated
  // duplicate so totals aren't double-counted.
  const dedupByLiab = new Map<string, any>();
  for (const link of (partyLinks || [])) {
    const existing = dedupByLiab.get(link.liabilityProfileId);
    if (!existing) { dedupByLiab.set(link.liabilityProfileId, link); continue; }
    // Prefer direct over via-asset.
    if (existing.source === "via-asset" && link.source !== "via-asset") {
      dedupByLiab.set(link.liabilityProfileId, link);
    }
  }
  const liabilities = Array.from(dedupByLiab.values())
    .map((link: any) => {
      const lp = (allProfiles || []).find((p: any) => p.id === link.liabilityProfileId);
      if (!lp) return null;
      return { link, profile: lp };
    })
    .filter(Boolean) as Array<{ link: any; profile: any }>;
  liabilities.sort((a, b) => (a.profile.name || "").localeCompare(b.profile.name || ""));

  // ── totals (this person's share) ───────────────────────────────────
  const userBalanceShare = liabilities.reduce((s, x) => {
    const f = x.profile.fields || {};
    const fin = f.finance || {};
    const bal = Number(f.currentBalance ?? f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
    const pct = Number(x.link.ownershipPercentage ?? 100);
    return s + (bal * pct) / 100;
  }, 0);
  const userMonthlyShare = liabilities.reduce((s, x) => {
    const f = x.profile.fields || {};
    const fin = f.finance || {};
    const m = Number(f.monthlyPayment ?? fin.monthlyPayment ?? 0);
    const pct = Number(x.link.ownershipPercentage ?? 100);
    return s + (m * pct) / 100;
  }, 0);

  // ── unlink (remove the current person from a liability) ───────────
  const unlinkMutation = useMutation({
    mutationFn: async (linkId: string) => {
      await apiRequest("DELETE", `/api/liability-profile-links/${linkId}`);
    },
    onSuccess: () => {
      toast({ title: "Unlinked" });
      refetchPartyLinks();
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to unlink", description: formatApiError(err), variant: "destructive" }),
  });

  // ── link existing liability to this person ────────────────────────
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkPct, setLinkPct] = useState("100");
  const [pendingLiabilityId, setPendingLiabilityId] = useState<string | null>(null);

  const linkedIds = new Set(liabilities.map(x => x.profile.id));
  const candidateLiabilities = (allProfiles || [])
    .filter((p: any) => p.type === "liability" || p.type === "loan")
    .filter((p: any) => !linkedIds.has(p.id))
    .filter((p: any) => !linkSearch.trim() || (p.name || "").toLowerCase().includes(linkSearch.toLowerCase()))
    .slice(0, 50);

  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!pendingLiabilityId) throw new Error("No liability selected");
      const pct = Math.max(0, Math.min(100, Number(linkPct) || 100));
      await apiRequest("POST", "/api/liability-profile-links", {
        liabilityProfileId: pendingLiabilityId,
        partyProfileId: profileId,
        ownershipPercentage: pct,
        role: "owner",
      });
    },
    onSuccess: () => {
      toast({ title: "Liability linked" });
      setLinkDialogOpen(false);
      setPendingLiabilityId(null);
      setLinkPct("100");
      setLinkSearch("");
      refetchPartyLinks();
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to link", description: formatApiError(err), variant: "destructive" }),
  });

  // ── empty state ────────────────────────────────────────────────────
  if (liabilities.length === 0) {
    return (
      <div className="space-y-3" data-testid="linked-liabilities-tab">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Liabilities</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLinkDialogOpen(true)} data-testid="button-link-liability-empty">
                <Plus className="h-3 w-3 mr-1" /> Link Liability
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center py-6">
              No liabilities linked. Connect mortgages, car loans, credit cards, or other debts that this person owns or co-owns.
            </p>
          </CardContent>
        </Card>
        <LinkLiabilityDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          search={linkSearch}
          setSearch={setLinkSearch}
          candidates={candidateLiabilities}
          pendingId={pendingLiabilityId}
          setPendingId={setPendingLiabilityId}
          pct={linkPct}
          setPct={setLinkPct}
          onSubmit={() => linkMutation.mutate()}
          submitting={linkMutation.isPending}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="linked-liabilities-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Liabilities</span>
              <Badge variant="outline" className="text-xs" data-testid="badge-liabilities-count">{liabilities.length}</Badge>
              {userBalanceShare > 0 && (
                <Badge variant="outline" className="text-xs text-red-500 border-red-500/30" data-testid="badge-liabilities-share">
                  Your share: {formatCurrency(userBalanceShare)}
                </Badge>
              )}
              {userMonthlyShare > 0 && (
                <Badge variant="outline" className="text-xs" data-testid="badge-liabilities-monthly">
                  {formatCurrency(userMonthlyShare)}/mo
                </Badge>
              )}
            </div>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLinkDialogOpen(true)} data-testid="button-link-liability">
              <Plus className="h-3 w-3 mr-1" /> Link
            </Button>
          </div>
          <div className="divide-y divide-border/30">
            {liabilities.map(({ link, profile: lp }) => (
              <LiabilityRow
                key={link.id}
                link={link}
                liability={lp}
                allProfiles={allProfiles}
                refetchAll={() => { refetchPartyLinks(); refetchAllProfiles(); onChanged(); }}
                onUnlink={() => unlinkMutation.mutate(link.id)}
                onOpenLiability={() => navigate(`/profiles/${lp.id}`)}
              />
            ))}
          </div>
        </CardContent>
      </Card>
      <LinkLiabilityDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        search={linkSearch}
        setSearch={setLinkSearch}
        candidates={candidateLiabilities}
        pendingId={pendingLiabilityId}
        setPendingId={setPendingLiabilityId}
        pct={linkPct}
        setPct={setLinkPct}
        onSubmit={() => linkMutation.mutate()}
        submitting={linkMutation.isPending}
      />
    </div>
  );
}

// ── Per-liability expandable row ─────────────────────────────────────
function LiabilityRow({ link, liability, allProfiles, refetchAll, onUnlink, onOpenLiability }: {
  link: any; liability: any; allProfiles: any[]; refetchAll: () => void; onUnlink: () => void; onOpenLiability: () => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const f = liability.fields || {};
  const fin = f.finance || {};
  const bal = Number(f.currentBalance ?? f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
  const pct = Number(link.ownershipPercentage ?? 100);
  const monthly = Number(f.monthlyPayment ?? fin.monthlyPayment ?? 0);
  const userShare = (bal * pct) / 100;

  // Co-owners + collateral (loaded only when expanded)
  const { data: coOwners = [], refetch: refetchCoOwners } = useQuery<any[]>({
    queryKey: ["/api/liabilities", liability.id, "parties"],
    queryFn: () => apiRequest("GET", `/api/liabilities/${liability.id}/parties`).then(r => r.json()),
    enabled: expanded,
  });
  const { data: collateral = [], refetch: refetchCollateral } = useQuery<any[]>({
    queryKey: ["/api/liabilities", liability.id, "assets"],
    queryFn: () => apiRequest("GET", `/api/liabilities/${liability.id}/assets`).then(r => r.json()),
    enabled: expanded,
  });

  return (
    <div className="py-2" data-testid={`row-liability-${liability.id}`}>
      {/* Header row.
          Propagated rows (link.source === "via-asset") come from the
          server walking person -> owned asset -> liability collateralized
          by that asset. They can't be unlinked here (the link lives on
          the asset), so we surface a chip explaining the path and hide
          the unlink button. */}
      <div className="flex items-center justify-between gap-2 -mx-3 px-3 py-1 rounded">
        <button
          className="flex-1 min-w-0 flex items-center gap-2 hover:bg-muted/30 rounded px-1 -mx-1 py-1 text-left"
          onClick={() => setExpanded(v => !v)}
          data-testid={`button-expand-liability-${liability.id}`}
        >
          <Pencil className="h-3 w-3 text-muted-foreground shrink-0" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <p className="text-xs font-medium truncate">{liability.name}</p>
              {link.source === "via-asset" && (() => {
                const viaAsset = (allProfiles || []).find((p: any) => p.id === link.viaAssetId);
                const viaName = viaAsset?.name || "asset";
                return (
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0" data-testid={`badge-via-asset-${liability.id}`}>
                    via {viaName}
                  </Badge>
                );
              })()}
            </div>
            <p className="text-xs text-muted-foreground">
              {pct.toFixed(pct % 1 === 0 ? 0 : 1)}% · {formatCurrency(userShare)} of {formatCurrency(bal)}
              {monthly > 0 && ` · ${formatCurrency((monthly * pct) / 100)}/mo`}
            </p>
          </div>
        </button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onOpenLiability} data-testid={`button-open-liability-${liability.id}`}>
          Open
        </Button>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="mt-2 ml-5 space-y-3 border-l-2 border-border/50 pl-3" data-testid={`detail-liability-${liability.id}`}>
          {/* Co-owners */}
          <CoOwnersEditor
            liabilityId={liability.id}
            coOwners={coOwners}
            allProfiles={allProfiles}
            onChanged={() => { refetchCoOwners(); refetchAll(); }}
          />
          {/* Collateral assets */}
          <CollateralEditor
            liabilityId={liability.id}
            collateral={collateral}
            allProfiles={allProfiles}
            onChanged={() => { refetchCollateral(); refetchAll(); }}
          />
          {/* Unlink current person — hidden for propagated rows because
              the relationship lives on the asset, not the person. */}
          {link.source !== "via-asset" && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500 hover:text-red-600" onClick={() => setConfirmUnlink(true)} data-testid={`button-unlink-${liability.id}`}>
                <Trash2 className="h-3 w-3 mr-1" /> Remove from this person
              </Button>
            </div>
          )}
          {link.source === "via-asset" && (
            <p className="text-xs text-muted-foreground italic">This liability is attached to an asset you own a share of. Change it by editing the asset’s collateral.</p>
          )}
        </div>
      )}

      {/* Unlink confirmation */}
      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink liability?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the ownership link only — the liability itself, its payments, and other co-owners are unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { onUnlink(); setConfirmUnlink(false); }} className="bg-red-500 hover:bg-red-600">
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AssetLinkedLiabilitiesTab
// ─────────────────────────────────────────────────────────────────────
// Shown on asset / vehicle / property profiles. Lists every liability whose
// `liability_asset_links` row points to *this* asset (many-to-many: a single
// liability can be linked to multiple assets, and an asset can carry multiple
// liabilities). Mirrors the LinkedLiabilitiesTab but uses the asset-side reverse
// query and the liability_asset_links endpoints (collateral / secured_by) instead
// of the party (ownership) endpoints.
// ─────────────────────────────────────────────────────────────────────
function AssetLinkedLiabilitiesTab({ profile, profileId, onChanged }: { profile: any; profileId: string; onChanged: () => void }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  // Reverse query: every link row whose asset_profile_id is this profile.
  const { data: assetLinks = [], refetch: refetchAssetLinks } = useQuery<any[]>({
    queryKey: ["/api/assets", profileId, "liabilities"],
    queryFn: () => apiRequest("GET", `/api/assets/${profileId}/liabilities`).then(r => r.json()),
  });
  const { data: allProfiles = [], refetch: refetchAllProfiles } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  // Resolve link rows -> liability profiles. Drop dangling rows (deleted liability).
  const liabilities = (assetLinks || [])
    .map((link: any) => {
      const lp = (allProfiles || []).find((p: any) => p.id === link.liabilityProfileId);
      if (!lp) return null;
      return { link, profile: lp };
    })
    .filter(Boolean) as Array<{ link: any; profile: any }>;
  liabilities.sort((a, b) => (a.profile.name || "").localeCompare(b.profile.name || ""));

  // ── totals (debt this asset secures) ────────────────────────────────
  // Each link can specify a fractional ownership_percentage that scales how
  // much of the liability balance this asset "secures". Sum that share so the
  // header totals make sense even when one liability is split across two
  // pieces of collateral (e.g. 60% car / 40% boat).
  const totalSecuredBalance = liabilities.reduce((s, x) => {
    const f = x.profile.fields || {};
    const fin = f.finance || {};
    const bal = Number(f.currentBalance ?? f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
    const pct = Number(x.link.ownershipPercentage ?? 100);
    return s + (bal * pct) / 100;
  }, 0);
  const totalSecuredMonthly = liabilities.reduce((s, x) => {
    const f = x.profile.fields || {};
    const fin = f.finance || {};
    const m = Number(f.monthlyPayment ?? fin.monthlyPayment ?? 0);
    const pct = Number(x.link.ownershipPercentage ?? 100);
    return s + (m * pct) / 100;
  }, 0);

  // ── unlink (remove the asset from a liability) ─────────────────────
  const unlinkMutation = useMutation({
    mutationFn: async (linkId: string) => {
      await apiRequest("DELETE", `/api/liability-asset-links/${linkId}`);
    },
    onSuccess: () => {
      toast({ title: "Unlinked" });
      refetchAssetLinks();
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to unlink", description: formatApiError(err), variant: "destructive" }),
  });

  // ── link existing liability to this asset ──────────────────────────
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkPct, setLinkPct] = useState("100");
  const [pendingLiabilityId, setPendingLiabilityId] = useState<string | null>(null);

  const linkedIds = new Set(liabilities.map(x => x.profile.id));
  const candidateLiabilities = (allProfiles || [])
    .filter((p: any) => p.type === "liability" || p.type === "loan")
    .filter((p: any) => !linkedIds.has(p.id))
    .filter((p: any) => !linkSearch.trim() || (p.name || "").toLowerCase().includes(linkSearch.toLowerCase()))
    .slice(0, 50);

  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!pendingLiabilityId) throw new Error("No liability selected");
      const pct = Math.max(0, Math.min(100, Number(linkPct) || 100));
      await apiRequest("POST", "/api/liability-asset-links", {
        liabilityProfileId: pendingLiabilityId,
        assetProfileId: profileId,
        ownershipPercentage: pct,
        role: "collateral",
      });
    },
    onSuccess: () => {
      toast({ title: "Liability linked to asset" });
      setLinkDialogOpen(false);
      setPendingLiabilityId(null);
      setLinkPct("100");
      setLinkSearch("");
      refetchAssetLinks();
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to link", description: formatApiError(err), variant: "destructive" }),
  });

  // ── empty state ────────────────────────────────────────────────────
  if (liabilities.length === 0) {
    return (
      <div className="space-y-3" data-testid="asset-liabilities-tab">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Liabilities</span>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLinkDialogOpen(true)} data-testid="button-link-asset-liability-empty">
                <Plus className="h-3 w-3 mr-1" /> Link Liability
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center py-6">
              No liabilities linked to this asset. Connect a mortgage, auto loan, financing plan, or any debt that this asset secures.
            </p>
          </CardContent>
        </Card>
        <LinkLiabilityDialog
          open={linkDialogOpen}
          onOpenChange={setLinkDialogOpen}
          search={linkSearch}
          setSearch={setLinkSearch}
          candidates={candidateLiabilities}
          pendingId={pendingLiabilityId}
          setPendingId={setPendingLiabilityId}
          pct={linkPct}
          setPct={setLinkPct}
          onSubmit={() => linkMutation.mutate()}
          submitting={linkMutation.isPending}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="asset-liabilities-tab">
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Liabilities</span>
              <Badge variant="outline" className="text-xs" data-testid="badge-asset-liabilities-count">{liabilities.length}</Badge>
              {totalSecuredBalance > 0 && (
                <Badge variant="outline" className="text-xs text-red-500 border-red-500/30" data-testid="badge-asset-liabilities-balance">
                  Secures {formatCurrency(totalSecuredBalance)}
                </Badge>
              )}
              {totalSecuredMonthly > 0 && (
                <Badge variant="outline" className="text-xs" data-testid="badge-asset-liabilities-monthly">
                  {formatCurrency(totalSecuredMonthly)}/mo
                </Badge>
              )}
            </div>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLinkDialogOpen(true)} data-testid="button-link-asset-liability">
              <Plus className="h-3 w-3 mr-1" /> Link
            </Button>
          </div>
          <div className="divide-y divide-border/30">
            {liabilities.map(({ link, profile: lp }) => (
              <AssetLiabilityRow
                key={link.id}
                link={link}
                liability={lp}
                allProfiles={allProfiles}
                refetchAll={() => { refetchAssetLinks(); refetchAllProfiles(); onChanged(); }}
                onUnlink={() => unlinkMutation.mutate(link.id)}
                onOpenLiability={() => navigate(`/profiles/${lp.id}`)}
              />
            ))}
          </div>
        </CardContent>
      </Card>
      <LinkLiabilityDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        search={linkSearch}
        setSearch={setLinkSearch}
        candidates={candidateLiabilities}
        pendingId={pendingLiabilityId}
        setPendingId={setPendingLiabilityId}
        pct={linkPct}
        setPct={setLinkPct}
        onSubmit={() => linkMutation.mutate()}
        submitting={linkMutation.isPending}
      />
    </div>
  );
}

// ── Per-liability row on the asset side ─────────────────────────────
// Same shape as LiabilityRow, but the bottom action says "Unlink from this
// asset" so the user understands they're only severing the collateral
// relationship — not deleting the liability or its other links.
function AssetLiabilityRow({ link, liability, allProfiles: _allProfiles, refetchAll: _refetchAll, onUnlink, onOpenLiability }: {
  link: any; liability: any; allProfiles: any[]; refetchAll: () => void; onUnlink: () => void; onOpenLiability: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const f = liability.fields || {};
  const fin = f.finance || {};
  const bal = Number(f.currentBalance ?? f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
  const pct = Number(link.ownershipPercentage ?? 100);
  const monthly = Number(f.monthlyPayment ?? fin.monthlyPayment ?? 0);
  const securedShare = (bal * pct) / 100;
  const role = String(link.role || "collateral");

  return (
    <div className="py-2" data-testid={`row-asset-liability-${liability.id}`}>
      <div className="flex items-center justify-between gap-2 -mx-3 px-3 py-1 rounded">
        {/* Primary tap target — navigates to the liability's detail page.
            The user expects "tap a liability row" to open the liability,
            not to expand an inline editor (the small chevron handles that). */}
        <button
          className="flex-1 min-w-0 flex items-center gap-2 hover:bg-muted/30 rounded px-1 -mx-1 py-1 text-left"
          onClick={onOpenLiability}
          data-testid={`button-open-asset-liability-${liability.id}`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">{liability.name}</p>
            <p className="text-xs text-muted-foreground">
              <span className="capitalize">{role.replace(/_/g, ' ')}</span> · {pct}% · {formatCurrency(securedShare)} of {formatCurrency(bal)}
              {monthly > 0 && ` · ${formatCurrency((monthly * pct) / 100)}/mo`}
            </p>
          </div>
        </button>
        {/* Secondary affordance — expand inline quick-edit (lender / APR /
            monthly / unlink) without leaving the asset page. */}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setExpanded(v => !v)}
          data-testid={`button-expand-asset-liability-${liability.id}`}
          aria-label={expanded ? "Hide details" : "Show details"}
        >
          <Pencil className="h-3 w-3" style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }} />
        </Button>
      </div>

      {expanded && (
        <div className="mt-2 ml-5 space-y-3 border-l-2 border-border/50 pl-3" data-testid={`detail-asset-liability-${liability.id}`}>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">Lender</p>
              <p className="font-medium">{f.lender || fin.lender || '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">APR</p>
              <p className="font-medium">{(() => {
                const apr = Number(f.annualInterestRate ?? f.apr ?? fin.annualInterestRate ?? 0);
                if (!apr) return '—';
                return `${(apr < 1 ? apr * 100 : apr).toFixed(2)}%`;
              })()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Monthly</p>
              <p className="font-medium">{monthly > 0 ? formatCurrency(monthly) : '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Role on this asset</p>
              <p className="font-medium capitalize">{role.replace(/_/g, ' ')}</p>
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" className="h-7 text-xs text-red-500 hover:text-red-600" onClick={() => setConfirmUnlink(true)} data-testid={`button-unlink-asset-${liability.id}`}>
              <Trash2 className="h-3 w-3 mr-1" /> Unlink from this asset
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink liability from this asset?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the collateral link only — the liability itself, its payments, and any other linked assets are unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { onUnlink(); setConfirmUnlink(false); }} className="bg-red-500 hover:bg-red-600">
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Co-owners editor ────────────────────────────────────────────────
function CoOwnersEditor({ liabilityId, coOwners, allProfiles, onChanged }: {
  liabilityId: string; coOwners: any[]; allProfiles: any[]; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [pickPersonId, setPickPersonId] = useState("");
  // Default a new co-owner's share to whatever is left to reach 100% (NOT a
  // hardcoded 50%). 0 if already full.
  const remainingPctDefault = () => String(Math.max(0, 100 - coOwners.reduce((s: number, l: any) => s + Number(l.ownershipPercentage ?? 0), 0)));
  const [pickPct, setPickPct] = useState(remainingPctDefault());

  const totalPct = coOwners.reduce((s, l) => s + Number(l.ownershipPercentage ?? 0), 0);
  const linkedPersonIds = new Set(coOwners.map((l: any) => l.partyProfileId));
  const personCandidates = (allProfiles || [])
    .filter((p: any) => (p.type === "person" || p.type === "self") && !linkedPersonIds.has(p.id));

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!pickPersonId) throw new Error("Select a person");
      const pct = Math.max(0, Math.min(100, Number(pickPct) || 0));
      await apiRequest("POST", "/api/liability-profile-links", {
        liabilityProfileId: liabilityId,
        partyProfileId: pickPersonId,
        ownershipPercentage: pct,
        role: "owner",
      });
    },
    onSuccess: () => { toast({ title: "Co-owner added" }); setAdding(false); setPickPersonId(""); setPickPct(remainingPctDefault()); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: async ({ id, pct }: { id: string; pct: number }) => {
      await apiRequest("PATCH", `/api/liability-profile-links/${id}`, { ownershipPercentage: pct });
    },
    onSuccess: () => { toast({ title: "Updated" }); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });
  const removeMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/liability-profile-links/${id}`); },
    onSuccess: () => { toast({ title: "Removed" }); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <div data-testid="coowners-editor">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Co-owners</span>
        <div className="flex items-center gap-1">
          <Badge variant="outline" className={`text-[10px] h-5 px-1.5 ${totalPct === 100 ? "" : "text-yellow-600 border-yellow-500/30"}`} data-testid="badge-total-ownership">
            Total: {totalPct}%
          </Badge>
          {!adding && (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => setAdding(true)} data-testid="button-add-coowner">
              <Plus className="h-3 w-3" /> Add
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1">
        {coOwners.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">No co-owners on record yet.</p>
        ) : (
          coOwners.map((l: any) => {
            const person = allProfiles.find((p: any) => p.id === l.partyProfileId);
            return (
              <div key={l.id} className="flex items-center gap-2 py-1" data-testid={`coowner-${l.id}`}>
                <span className="text-xs flex-1 truncate">{person?.name || "Unknown"}</span>
                <Input
                  type="number"
                  defaultValue={Number(l.ownershipPercentage ?? 0)}
                  className="h-7 w-16 text-xs text-right"
                  min={0}
                  max={100}
                  onBlur={(e) => {
                    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                    if (v !== Number(l.ownershipPercentage)) updateMutation.mutate({ id: l.id, pct: v });
                  }}
                  data-testid={`input-coowner-pct-${l.id}`}
                />
                <span className="text-xs text-muted-foreground">%</span>
                <button onClick={() => removeMutation.mutate(l.id)} className="text-muted-foreground hover:text-red-500" data-testid={`button-remove-coowner-${l.id}`}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
        {adding && (
          <div className="flex items-center gap-2 py-1 bg-muted/30 px-2 rounded" data-testid="add-coowner-row">
            <select
              value={pickPersonId}
              onChange={(e) => setPickPersonId(e.target.value)}
              className="h-7 flex-1 text-xs bg-background border border-border rounded px-2"
              data-testid="select-new-coowner"
            >
              <option value="">Select person…</option>
              {personCandidates.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <Input
              type="number"
              value={pickPct}
              onChange={(e) => setPickPct(e.target.value)}
              className="h-7 w-16 text-xs text-right"
              min={0}
              max={100}
              data-testid="input-new-coowner-pct"
            />
            <span className="text-xs text-muted-foreground">%</span>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={() => addMutation.mutate()} disabled={!pickPersonId || addMutation.isPending} data-testid="button-confirm-add-coowner">
              Add
            </Button>
            <button onClick={() => { setAdding(false); setPickPersonId(""); }} className="text-muted-foreground hover:text-foreground" data-testid="button-cancel-add-coowner">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Collateral (asset) editor ───────────────────────────────────────
function CollateralEditor({ liabilityId, collateral, allProfiles, onChanged }: {
  liabilityId: string; collateral: any[]; allProfiles: any[]; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [pickAssetId, setPickAssetId] = useState("");

  const linkedAssetIds = new Set(collateral.map((l: any) => l.assetProfileId));
  const assetCandidates = (allProfiles || [])
    .filter((p: any) => p.type === "asset" || p.type === "vehicle" || p.type === "property")
    .filter((p: any) => !linkedAssetIds.has(p.id));

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!pickAssetId) throw new Error("Select an asset");
      await apiRequest("POST", "/api/liability-asset-links", {
        liabilityProfileId: liabilityId,
        assetProfileId: pickAssetId,
        ownershipPercentage: 100,
        role: "collateral",
      });
    },
    onSuccess: () => { toast({ title: "Collateral linked" }); setAdding(false); setPickAssetId(""); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });
  const removeMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/liability-asset-links/${id}`); },
    onSuccess: () => { toast({ title: "Unlinked" }); onChanged(); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <div data-testid="collateral-editor">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Collateral / Linked Assets</span>
        {!adding && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => setAdding(true)} data-testid="button-add-collateral">
            <Plus className="h-3 w-3" /> Add
          </Button>
        )}
      </div>
      <div className="space-y-1">
        {collateral.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">No assets linked as collateral.</p>
        ) : (
          collateral.map((l: any) => {
            const asset = allProfiles.find((p: any) => p.id === l.assetProfileId);
            return (
              <div key={l.id} className="flex items-center gap-2 py-1" data-testid={`collateral-${l.id}`}>
                <span className="text-xs flex-1 truncate">{asset?.name || "Unknown asset"}</span>
                <Badge variant="outline" className="text-[10px] h-5 px-1.5">{l.role || "collateral"}</Badge>
                <button onClick={() => removeMutation.mutate(l.id)} className="text-muted-foreground hover:text-red-500" data-testid={`button-remove-collateral-${l.id}`}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
        {adding && (
          <div className="flex items-center gap-2 py-1 bg-muted/30 px-2 rounded" data-testid="add-collateral-row">
            <select
              value={pickAssetId}
              onChange={(e) => setPickAssetId(e.target.value)}
              className="h-7 flex-1 text-xs bg-background border border-border rounded px-2"
              data-testid="select-new-collateral"
            >
              <option value="">Select asset…</option>
              {assetCandidates.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <Button size="sm" className="h-7 px-2 text-xs" onClick={() => addMutation.mutate()} disabled={!pickAssetId || addMutation.isPending} data-testid="button-confirm-add-collateral">
              Add
            </Button>
            <button onClick={() => { setAdding(false); setPickAssetId(""); }} className="text-muted-foreground hover:text-foreground" data-testid="button-cancel-add-collateral">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Link-existing-liability dialog ──────────────────────────────────
function LinkLiabilityDialog({ open, onOpenChange, search, setSearch, candidates, pendingId, setPendingId, pct, setPct, onSubmit, submitting }: {
  open: boolean; onOpenChange: (b: boolean) => void;
  search: string; setSearch: (s: string) => void;
  candidates: any[]; pendingId: string | null; setPendingId: (id: string | null) => void;
  pct: string; setPct: (s: string) => void;
  onSubmit: () => void; submitting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col" data-testid="dialog-link-liability">
        <DialogHeader>
          <DialogTitle>Link Liability</DialogTitle>
          <DialogDescription>Connect an existing liability to this person and set their ownership share.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
          <Input
            placeholder="Search liabilities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
            data-testid="input-link-liability-search"
          />
          <div className="flex-1 overflow-y-auto space-y-1 pr-1" data-testid="list-link-liability-candidates">
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">No liabilities available to link.</p>
            ) : candidates.map((p: any) => (
              <button
                key={p.id}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-muted transition-colors flex items-center gap-2 ${
                  p.id === pendingId ? "bg-primary/10 text-primary font-semibold" : ""
                }`}
                onClick={() => setPendingId(p.id)}
                data-testid={`option-link-liability-${p.id}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="text-muted-foreground text-[10px]">
                    {p.fields?.lender || p.fields?.subtype || "liability"}
                    {p.fields?.currentBalance ? ` · ${formatCurrency(Number(p.fields.currentBalance))}` : ""}
                  </p>
                </div>
                {p.id === pendingId && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t pt-2">
            <span className="text-xs text-muted-foreground">Ownership</span>
            <Input
              type="number"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              className="h-8 w-20 text-xs text-right"
              min={0}
              max={100}
              data-testid="input-link-liability-pct"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} disabled={!pendingId || submitting} data-testid="button-confirm-link-liability">
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Link-existing-asset dialog (mirrors LinkLiabilityDialog) ──────────
// Used on a person/self profile to attach an existing asset (vehicle,
// property, investment, etc.) with an ownership share. POSTs to
// /api/asset-party-links — the same endpoint the asset-side owner picker
// already uses, so both directions write the same junction row.
function LinkAssetDialog({ open, onOpenChange, search, setSearch, candidates, pendingId, setPendingId, pct, setPct, onSubmit, submitting }: {
  open: boolean; onOpenChange: (b: boolean) => void;
  search: string; setSearch: (s: string) => void;
  candidates: any[]; pendingId: string | null; setPendingId: (id: string | null) => void;
  pct: string; setPct: (s: string) => void;
  onSubmit: () => void; submitting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col" data-testid="dialog-link-asset">
        <DialogHeader>
          <DialogTitle>Link Asset</DialogTitle>
          <DialogDescription>Connect an existing asset to this person and set their ownership share.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
          <Input
            placeholder="Search assets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
            data-testid="input-link-asset-search"
          />
          <div className="flex-1 overflow-y-auto space-y-1 pr-1" data-testid="list-link-asset-candidates">
            {candidates.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">No assets available to link.</p>
            ) : candidates.map((p: any) => {
              const value = p.currentValue ?? p.fields?.currentValue ?? p.fields?.value ?? p.fields?.marketValue;
              return (
                <button
                  key={p.id}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-muted transition-colors flex items-center gap-2 ${
                    p.id === pendingId ? "bg-primary/10 text-primary font-semibold" : ""
                  }`}
                  onClick={() => setPendingId(p.id)}
                  data-testid={`option-link-asset-${p.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="text-muted-foreground text-[10px]">
                      {p.type || p.fields?.assetSubtype || "asset"}
                      {value != null && !isNaN(Number(value)) ? ` · ${formatCurrency(Number(value))}` : ""}
                    </p>
                  </div>
                  {p.id === pendingId && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 border-t pt-2">
            <span className="text-xs text-muted-foreground">Ownership</span>
            <Input
              type="number"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              className="h-8 w-20 text-xs text-right"
              min={0}
              max={100}
              data-testid="input-link-asset-pct"
            />
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} disabled={!pendingId || submitting} data-testid="button-confirm-link-asset">
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      // Server has no POST /api/profiles/:id/expenses route. Use the
      // POST /api/expenses + POST /api/profiles/:id/link pattern instead
      // (same pattern used elsewhere in this file).
      const created = await apiRequest("POST", "/api/expenses", {
        description: `Payment - ${profile.name}`, amount: payAmt, date: payDate, category: "payment",
      }).then(r => r.json());
      if (created?.id) {
        await apiRequest("POST", `/api/profiles/${profileId}/link`, { entityType: "expense", entityId: created.id });
      }
    },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
      setShowRecord(false);
      setPayAmt("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });
  const deletePayMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: (_data, id) => {
      queryClient.setQueryData(["/api/expenses"], (old: any[]) => old?.filter((e: any) => e.id !== id) || []);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.relatedExpenses) return old;
        return { ...old, relatedExpenses: old.relatedExpenses.filter((e: any) => e.id !== id) };
      });
      toast({ title: "Payment deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to delete payment", description: formatApiError(err), variant: "destructive" }),
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
                <Button size="sm" className="h-7 text-xs px-2" onClick={() => recordMutation.mutate()} disabled={recordMutation.isPending || !payAmt || parseFloat(payAmt) <= 0} data-testid="button-save-payment">
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


// ============================================================
// PHASE 2 — Linked Assets / People / Liabilities (rel tabs)
// ============================================================

function typeKeyIcon(typeKey: string) {
  if (typeKey === "property") return <Home className="h-4 w-4" />;
  if (typeKey === "vehicle") return <Car className="h-4 w-4" />;
  if (typeKey === "liability" || typeKey === "loan") return <CreditCard className="h-4 w-4" />;
  if (typeKey === "person" || typeKey === "self") return <User className="h-4 w-4" />;
  if (typeKey === "business") return <Building2 className="h-4 w-4" />;
  if (typeKey === "asset") return <Package className="h-4 w-4" />;
  return <Package className="h-4 w-4" />;
}

function rolePillColor(role: string) {
  const r = (role || "").toLowerCase();
  if (r.includes("owner")) return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
  if (r.includes("collateral") || r.includes("secured")) return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  if (r.includes("beneficiary")) return "bg-purple-500/15 text-purple-700 dark:text-purple-400";
  return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
}

// Generic party card shown in rel-* tabs
function RelPartyCard({
  id, name, typeKey, role, ownershipPercentage, linkId, totalParties,
  onEdit, onRemove,
}: {
  id: string; name: string; typeKey: string; role: string;
  ownershipPercentage: number | null; linkId: string; totalParties: number;
  onEdit: (linkId: string, role: string, pct: number) => void;
  onRemove: (linkId: string) => void;
}) {
  const pct = ownershipPercentage ?? 100;
  const sharedLabel = totalParties <= 1 ? "Sole" : `Shared ${totalParties}-way`;
  return (
    <Card style={{height: 160}} className="overflow-hidden">
      <CardContent className="p-3 h-full flex flex-col justify-between">
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground mt-0.5">{typeKeyIcon(typeKey)}</span>
          <div className="flex-1 min-w-0">
            <a href={`#/profiles/${id}`} className="text-sm font-semibold hover:underline truncate block">{name}</a>
            <span className={`inline-block mt-0.5 text-xs px-1.5 py-0.5 rounded-full ${rolePillColor(role)}`}>
              {role || "Owner"}
            </span>
          </div>
          <Badge variant="outline" className="text-xs shrink-0">{sharedLabel}</Badge>
        </div>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full" style={{width: `${pct}%`}} />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">{pct}%</span>
          </div>
          <div className="flex gap-1 justify-end">
            <Button size="sm" variant="ghost" className="h-6 text-xs px-2"
              onClick={() => onEdit(linkId, role, pct)}>
              <Edit className="h-3 w-3 mr-1" />Edit
            </Button>
            <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-destructive hover:text-destructive"
              onClick={() => onRemove(linkId)}>
              <Trash2 className="h-3 w-3 mr-1" />Remove
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Asset card shown in rel-assets tab — simpler (no ownership editing for graph-sourced)
// The card defensively renders nothing if the underlying profile no longer
// exists (deleted/orphaned link) so we don't show ghost "Asset / Asset"
// cards that 404 when clicked. The parent (LinkedAssetsTab) is responsible
// for hydrating `name` from the live profile list; if it's still empty we
// fall back to a humanised version of `typeKey` rather than the literal
// word "Asset" so it at least reads naturally.
function RelAssetCard({ id, name, typeKey, sharePct, currentValue }: { id: string; name: string; typeKey: string; sharePct?: number; currentValue?: number | null }) {
  const safeName = (name && name.trim()) ? name.trim() : (
    typeKey === "vehicle" ? "Untitled vehicle" :
    typeKey === "property" ? "Untitled property" :
    typeKey === "investment" ? "Untitled investment" :
    "Untitled item"
  );
  // sharePct + currentValue come from the enriched /api/parties/:id/assets
  // endpoint. When present we surface the per-owner share inline so the
  // user can see "Jane: 50% • $X" right on the card without a click.
  const pct = sharePct != null ? Number(sharePct) : null;
  const share = (pct != null && currentValue != null) ? (Number(currentValue) * pct) / 100 : null;
  return (
    <Card style={{height: 160}} className="overflow-hidden">
      <CardContent className="p-3 h-full flex flex-col justify-between">
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground mt-0.5">{typeKeyIcon(typeKey)}</span>
          <div className="flex-1 min-w-0">
            <a href={`#/profiles/${id}`} className="text-sm font-semibold hover:underline truncate block">{safeName}</a>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground capitalize">{typeKey}</span>
              {pct != null && pct < 100 && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5" data-testid={`badge-asset-share-${id}`}>
                  {pct.toFixed(pct % 1 === 0 ? 0 : 1)}% owner
                </Badge>
              )}
            </div>
            {share != null && (
              <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                Your share: <span className="font-medium text-foreground">{formatCurrency(share)}</span>
              </p>
            )}
          </div>
        </div>
        <div>
          <Button size="sm" variant="ghost" className="h-6 text-xs px-2" asChild>
            <a href={`#/profiles/${id}`}><ExternalLink className="h-3 w-3 mr-1" />View</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Edit link modal (for asset-party links in rel-people tab on asset profiles)
function EditAssetPartyLinkModal({
  open, linkId, initialRole, initialPct,
  onClose, onSaved,
}: {
  open: boolean; linkId: string; initialRole: string; initialPct: number;
  onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [role, setRole] = useState(initialRole);
  const [pct, setPct] = useState(String(initialPct));

  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/asset-party-links/${linkId}`, {
        role,
        ownershipPercentage: Math.max(0, Math.min(100, Number(pct) || 0)),
      });
    },
    onSuccess: () => {
      toast({ title: "Updated" });
      onSaved();
      onClose();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Link</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium">Role</label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["Owner","Co-Owner","Beneficiary","Trustee","Manager","Guarantor"].map(r =>
                  <SelectItem key={r} value={r.toLowerCase().replace(/ /g,"-")}>{r}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Ownership %</label>
            <Input type="number" min={0} max={100} value={pct}
              onChange={e => setPct(e.target.value)} className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Linked People tab ──
// On asset/liability profiles this fetches /api/(assets|liabilities)/:id/parties
// and renders co-owners with role + ownership%. On person/self profiles it
// pulls /api/profiles and surfaces every OTHER person/self/pet — the user's
// people network — with avatar + relationship pill + click-through. This
// replaces the old graph-BFS path which only returned people who happened
// to share an asset/liability with the root (so a brand-new person profile
// always showed "No linked people").
export function LinkedPeopleTab({ profileId, profileType, onChanged }: { profileId: string; profileType: string; onChanged: () => void }) {
  const { toast } = useToast();
  const isAsset = ["asset","vehicle","property"].includes(profileType);
  const isLiability = profileType === "liability" || profileType === "loan";
  const isPerson = profileType === "person" || profileType === "self";

  const partiesQueryKey: any[] = isAsset
    ? ["/api/assets", profileId, "parties"]
    : isLiability
    ? ["/api/liabilities", profileId, "parties"]
    : ["/api/profiles", "people-network", profileId];

  const { data: parties = [], refetch } = useQuery<any[]>({
    queryKey: partiesQueryKey,
    queryFn: async () => {
      if (isAsset) {
        return apiRequest("GET", `/api/assets/${profileId}/parties`).then(r => r.json());
      } else if (isLiability) {
        return apiRequest("GET", `/api/liabilities/${profileId}/parties`).then(r => r.json());
      } else {
        // Person/self: show every other person/self/pet in the user's network.
        // We project them into the shape the renderer expects: { id, party: {…} }.
        const profs: any[] = await apiRequest("GET", "/api/profiles").then(r => r.json());
        const personLikeTypes = new Set(["person", "self", "pet"]);
        return (profs || [])
          .filter((p: any) => p.id !== profileId && personLikeTypes.has(p.type))
          .map((p: any) => ({
            id: p.id,
            party: {
              id: p.id,
              name: p.name,
              type: p.type,
              profileType: p.type,
              avatar: p.avatar,
              relationship: p?.fields?.relationship || null,
            },
          }));
      }
    },
  });

  const [editState, setEditState] = useState<{linkId:string;role:string;pct:number}|null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Fetch all profiles so we can offer eligible people in the picker.
  // Only asset + liability profile types need this; person/self read-only view.
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: isAsset || isLiability,
  });

  const linkedIds = new Set(
    (parties || []).map((p: any) => (p.party?.id) || p.partyProfileId || p.id)
  );
  const availablePeople = (allProfiles || [])
    .filter((p: any) => ["self", "person"].includes(p.type))
    .filter((p: any) => !linkedIds.has(p.id));

  const removeMutation = useMutation({
    mutationFn: async (linkId: string) => {
      if (isAsset) {
        await apiRequest("DELETE", `/api/asset-party-links/${linkId}`);
      } else if (isLiability) {
        await apiRequest("DELETE", `/api/liability-profile-links/${linkId}`);
      }
    },
    onSuccess: () => {
      toast({ title: "Removed" });
      refetch();
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  const canAdd = (isAsset || isLiability) && availablePeople.length > 0;

  // ── PERSON/SELF render path ─────────────────────────────────────────────────
  // Rich avatar + relationship pill + clickable navigation. Goes through
  // hashNavigate via wouter <Link>, NOT through asset-party-link APIs.
  if (isPerson) {
    if (parties.length === 0) {
      return (
        <div className="text-center py-10 rounded-xl border border-dashed border-border/60 bg-muted/10">
          <User className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No other people in your network yet</p>
          <p className="text-xs text-muted-foreground/70 mt-0.5">Add a person from the Profiles page to see them here</p>
          <Link href="/profiles">
            <Button size="sm" variant="outline" className="mt-3 h-7 text-xs gap-1">
              <Plus className="h-3 w-3" /> Manage People
            </Button>
          </Link>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {parties.length} {parties.length === 1 ? "person" : "people"} in your network
          </span>
          <Link href="/profiles">
            <Button size="sm" variant="ghost" className="h-6 text-xs gap-1 px-2">
              <Plus className="h-3 w-3" /> Manage
            </Button>
          </Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {parties.map((item: any) => {
            const person = item.party || item;
            const typeKey = person.profileType || person.type || "person";
            const accent = typeKey === "pet" ? "20 88% 55%" : typeKey === "self" ? "183 98% 32%" : "271 70% 55%";
            const initials = (person.name || "?").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
            const relationship = person.relationship;
            return (
              <Link key={person.id} href={`/profiles/${person.id}`}>
                <div
                  className="group flex items-center gap-3 p-2.5 rounded-xl border transition-all cursor-pointer hover:shadow-md hover:-translate-y-px"
                  style={{
                    background: `linear-gradient(135deg, hsl(${accent} / 0.10) 0%, hsl(var(--card)) 60%)`,
                    borderColor: `hsl(${accent} / 0.25)`,
                  }}
                  data-testid={`linked-person-${person.id}`}
                >
                  {person.avatar ? (
                    <img
                      src={person.avatar}
                      alt={person.name}
                      className="w-10 h-10 rounded-full object-cover shrink-0 border-2"
                      style={{ borderColor: `hsl(${accent} / 0.4)` }}
                      loading="lazy"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white text-xs font-bold"
                      style={{ background: `linear-gradient(135deg, hsl(${accent}), hsl(${accent} / 0.7))` }}
                    >
                      {initials}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{person.name}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {relationship ? (
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize"
                          style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}
                        >
                          {relationship}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground capitalize">{typeKey}</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground transition-colors shrink-0" />
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    );
  }

  // ── ASSET / LIABILITY render path (unchanged behaviour) ─────────────────────
  if (parties.length === 0) {
    return (
      <div className="space-y-3">
        <div className="text-center py-10">
          <User className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No linked people</p>
          {canAdd && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-7 text-xs gap-1"
              onClick={() => setAddOpen(true)}
              data-testid="button-add-linked-person"
            >
              <Plus className="h-3 w-3" /> Add Person
            </Button>
          )}
        </div>
        {addOpen && (isAsset || isLiability) && (
          <AddLinkedPersonModal
            open={addOpen}
            mode={isAsset ? "asset" : "liability"}
            entityId={profileId}
            availablePeople={availablePeople}
            onClose={() => setAddOpen(false)}
            onSaved={() => { refetch(); onChanged(); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {editState && isAsset && (
        <EditAssetPartyLinkModal
          open={true}
          linkId={editState.linkId}
          initialRole={editState.role}
          initialPct={editState.pct}
          onClose={() => setEditState(null)}
          onSaved={() => { refetch(); onChanged(); }}
        />
      )}
      {addOpen && (isAsset || isLiability) && (
        <AddLinkedPersonModal
          open={addOpen}
          mode={isAsset ? "asset" : "liability"}
          entityId={profileId}
          availablePeople={availablePeople}
          onClose={() => setAddOpen(false)}
          onSaved={() => { refetch(); onChanged(); }}
        />
      )}
      {canAdd && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => setAddOpen(true)}
            data-testid="button-add-linked-person"
          >
            <Plus className="h-3 w-3" /> Add Person
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {parties.map((item: any) => {
          const person = item.party || item;
          const linkId = item.linkId || item.id || "";
          const role = item.role || "owner";
          const pct = item.ownershipPercentage ?? 100;
          const typeKey = person.profileType || person.type || "person";
          return (
            <RelPartyCard
              key={linkId}
              id={person.id}
              name={person.name || "Unknown"}
              typeKey={typeKey}
              role={role}
              ownershipPercentage={pct}
              linkId={linkId}
              totalParties={parties.length}
              onEdit={(lId, r, p) => setEditState({linkId: lId, role: r, pct: p})}
              onRemove={(lId) => {
                if (confirm("Remove this link?")) removeMutation.mutate(lId);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// Unified add-linked-person modal used by LinkedPeopleTab on both asset and
// liability profiles. Replaces the separate header Owners popover + Belongs-to
// parent picker so there's only one place to add owners on a profile.
function AddLinkedPersonModal({
  open, mode, entityId, availablePeople, onClose, onSaved,
}: {
  open: boolean;
  mode: "asset" | "liability";
  entityId: string;
  availablePeople: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [personId, setPersonId] = useState<string>(availablePeople[0]?.id || "");
  const [role, setRole] = useState<string>("owner");
  const [pct, setPct] = useState<string>("100");

  const mutation = useMutation({
    mutationFn: async () => {
      const ownershipPercentage = Math.max(0, Math.min(100, Number(pct) || 0));
      if (mode === "asset") {
        await apiRequest("POST", "/api/asset-party-links", {
          assetProfileId: entityId,
          partyProfileId: personId,
          ownershipPercentage,
          role,
        });
      } else {
        await apiRequest("POST", "/api/liability-profile-links", {
          liabilityProfileId: entityId,
          partyProfileId: personId,
          ownershipPercentage,
          role,
        });
      }
    },
    onSuccess: () => {
      toast({ title: "Person linked" });
      onSaved();
      onClose();
    },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add Linked Person</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium">Person</label>
            <Select value={personId} onValueChange={setPersonId}>
              <SelectTrigger className="mt-1" data-testid="select-add-linked-person">
                <SelectValue placeholder="Choose a person" />
              </SelectTrigger>
              <SelectContent>
                {availablePeople.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Role</label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["Owner","Co-Owner","Beneficiary","Trustee","Manager","Guarantor"].map(r =>
                  <SelectItem key={r} value={r.toLowerCase().replace(/ /g,"-")}>{r}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium">Ownership %</label>
            <Input type="number" min={0} max={100} value={pct}
              onChange={e => setPct(e.target.value)} className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!personId || mutation.isPending}
            data-testid="button-save-add-linked-person"
          >
            {mutation.isPending ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// NetWorthStrip
// ----------------------------------------------------------------------
// Lightweight per-person net-worth header. Reads the same two enriched
// endpoints that drive the Belongings sections so the headline matches
// the detail rows. Numbers update live via the existing react-query
// cache (no separate subscription needed) — a refetch on the assets or
// liabilities lists automatically refreshes this strip.
function NetWorthStrip({ profileId }: { profileId: string }) {
  const { data: assetRows = [] } = useQuery<any[]>({
    queryKey: ["/api/parties", profileId, "assets"],
    queryFn: () => apiRequest("GET", `/api/parties/${profileId}/assets`).then(r => r.json()),
  });
  const { data: liabRows = [] } = useQuery<any[]>({
    queryKey: ["/api/parties", profileId, "liabilities"],
    queryFn: () => apiRequest("GET", `/api/parties/${profileId}/liabilities`).then(r => r.json()),
  });

  const totalAssets = (assetRows || []).reduce((s: number, r: any) => {
    const v = Number(r?.asset?.currentValue ?? 0);
    const pct = Number(r?.ownershipPercentage ?? 100);
    return s + (v * pct) / 100;
  }, 0);
  // Dedupe liabilities by liability id (direct beats propagated) so we
  // don't double-count when someone is both a direct borrower and an
  // owner of the collateral asset.
  const seen = new Map<string, any>();
  for (const r of (liabRows || [])) {
    const id = r?.liabilityProfileId; if (!id) continue;
    const cur = seen.get(id);
    if (!cur || (cur.source === "via-asset" && r.source !== "via-asset")) seen.set(id, r);
  }
  const totalLiab = Array.from(seen.values()).reduce((s: number, r: any) => {
    const bal = Number(r?.liability?.currentBalance ?? 0);
    const pct = Number(r?.ownershipPercentage ?? 100);
    return s + (bal * pct) / 100;
  }, 0);
  const monthly = Array.from(seen.values()).reduce((s: number, r: any) => {
    const m = Number(r?.liability?.monthlyPayment ?? 0);
    const pct = Number(r?.ownershipPercentage ?? 100);
    return s + (m * pct) / 100;
  }, 0);
  const netWorth = totalAssets - totalLiab;

  if ((assetRows?.length || 0) === 0 && (liabRows?.length || 0) === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="net-worth-strip">
      <div className="rounded-lg border border-border/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Assets</p>
        <p className="text-sm font-bold tabular-nums">{formatCurrency(totalAssets)}</p>
      </div>
      <div className="rounded-lg border border-border/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Liabilities</p>
        <p className="text-sm font-bold tabular-nums text-red-500">{formatCurrency(totalLiab)}</p>
      </div>
      <div className="rounded-lg border border-border/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Net Worth</p>
        <p className={`text-sm font-bold tabular-nums ${netWorth >= 0 ? "text-emerald-500" : "text-red-500"}`}>{formatCurrency(netWorth)}</p>
      </div>
      <div className="rounded-lg border border-border/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Monthly debt</p>
        <p className="text-sm font-bold tabular-nums">{formatCurrency(monthly)}</p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// CostOfOwnershipCard
//
// For asset / vehicle / property profiles. Sums the last 12 months of
// linked expenses (via profile.relatedExpenses) plus normalized monthly
// obligations whose category matches the asset type, into a single
// "cost of ownership" card. This is the read-only side of the relationship
// the audit flagged: expenses ARE linked to assets via `linked_profiles`
// but the asset profile never surfaced the total.
// ────────────────────────────────────────────────────────────────────
function CostOfOwnershipCard({ profile }: { profile: any }) {
  const expenses = (profile.relatedExpenses || []) as any[];
  const obligations = (profile.relatedObligations || []) as any[];
  const now = new Date();
  const twelveMonthsAgo = new Date(now); twelveMonthsAgo.setMonth(now.getMonth() - 12);

  const trailing12 = expenses.filter(e => {
    const d = e?.date ? new Date(e.date) : null;
    return d && d >= twelveMonthsAgo && d <= now;
  });
  const trailing12Total = trailing12.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const expensesMonthlyAvg = trailing12Total / 12;

  // Recurring monthly obligations linked to this asset (insurance premium,
  // HOA, lease payment, fuel card subscription, etc.). Normalize each to
  // a per-month amount so the rollup is comparable.
  const toMonthly = (amount: number, freq: string | undefined) => {
    const f = (freq || "monthly").toLowerCase();
    if (f === "yearly" || f === "annual" || f === "annually") return amount / 12;
    if (f === "quarterly") return amount / 3;
    if (f === "weekly") return amount * (52 / 12);
    if (f === "biweekly" || f === "bi-weekly") return amount * (26 / 12);
    if (f === "daily") return amount * (365 / 12);
    return amount;
  };
  const recurringMonthly = obligations.reduce((s, o) => s + toMonthly(Number(o.amount) || 0, o.frequency), 0);

  if (expenses.length === 0 && obligations.length === 0) return null;

  return (
    <Card data-testid="cost-of-ownership-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" /> Cost of ownership
          </span>
          <Badge variant="outline" className="text-xs font-normal tabular-nums">
            {formatCurrency(expensesMonthlyAvg + recurringMonthly)}/mo
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-2 rounded-lg bg-muted/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Trailing 12mo</p>
            <p className="text-sm font-bold tabular-nums">{formatCurrency(trailing12Total)}</p>
            <p className="text-[10px] text-muted-foreground/70">{trailing12.length} expenses</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-muted/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg / month</p>
            <p className="text-sm font-bold tabular-nums">{formatCurrency(expensesMonthlyAvg)}</p>
            <p className="text-[10px] text-muted-foreground/70">from expenses</p>
          </div>
          <div className="text-center p-2 rounded-lg bg-muted/30">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Recurring</p>
            <p className="text-sm font-bold tabular-nums">{formatCurrency(recurringMonthly)}/mo</p>
            <p className="text-[10px] text-muted-foreground/70">{obligations.length} bill{obligations.length !== 1 ? "s" : ""}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LinkedAssetsTab({ profileId, profileType }: { profileId: string; profileType: string }) {
  const { toast } = useToast();
  const isLiability = profileType === "liability" || profileType === "loan";
  const isPerson = profileType === "person" || profileType === "self";
  const isAsset = ["asset","vehicle","property"].includes(profileType);

  // Picker state (person/self profiles can attach an existing asset and
  // set their ownership share — mirrors the liability picker pattern).
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerPendingId, setPickerPendingId] = useState<string | null>(null);
  const [pickerPct, setPickerPct] = useState("100");

  // Live profiles list is used to (a) filter out orphan links pointing at
  // deleted profiles — clicking those used to land the user on a "Profile
  // not found" screen — and (b) recover the canonical name when the link
  // record only has an empty/stale name field (that was producing the
  // ghost "Asset / Asset" cards in the screenshot).
  const { data: liveProfiles = [] } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const liveById = new Map<string, any>(liveProfiles.map((p: any) => [p.id, p]));

  const { data: rawItems = [], refetch } = useQuery<any[]>({
    queryKey: ["/api/rel-assets", profileType, profileId],
    queryFn: async () => {
      if (isLiability) {
        // Server endpoint is /assets (not /asset-links).
        const links = await apiRequest("GET", `/api/liabilities/${profileId}/assets`).then(r => r.json());
        return links.map((l: any) => ({ id: l.assetProfileId || l.id, name: l.assetName || l.name || "", typeKey: l.assetType || "asset" }));
      } else if (isPerson) {
        // Server now enriches each row with `asset: { id, name, type, currentValue }`
        // and drops orphan rows whose asset profile was deleted. We pass through
        // the share % so cards can render "50% owner" chips, and surface the
        // link row id so the unlink (×) button on each card can DELETE it.
        const rows = await apiRequest("GET", `/api/parties/${profileId}/assets`).then(r => r.json());
        return (rows || []).filter((a: any) => a?.asset?.id).map((a: any) => ({
          id: a.asset.id,
          linkId: a.id, // asset_party_links.id — needed for DELETE
          name: a.asset.name || "",
          typeKey: a.asset.type || "asset",
          sharePct: Number(a.ownershipPercentage ?? 100),
          currentValue: a.asset.currentValue ?? null,
          role: a.role || "owner",
        }));
      } else {
        // Asset: ONLY show assets directly linked via a shared liability (co-collateral).
        // We deliberately do NOT bridge through owner/person nodes — co-ownership does
        // not make two assets "linked". Direct co-collateral via the same liability does.
        const liabs = await apiRequest("GET", `/api/assets/${profileId}/liabilities`).then(r => r.json()).catch(() => []);
        if (!Array.isArray(liabs) || liabs.length === 0) return [];
        const liabIds = Array.from(new Set(liabs.map((l: any) => l.liabilityProfileId).filter(Boolean)));
        const peers: Record<string, { id: string; name: string; typeKey: string }> = {};
        for (const lid of liabIds) {
          try {
            const assetLinks = await apiRequest("GET", `/api/liabilities/${lid}/assets`).then(r => r.json());
            for (const al of (assetLinks || [])) {
              const aid = al.assetProfileId;
              if (!aid || aid === profileId) continue;
              if (peers[aid]) continue;
              peers[aid] = { id: aid, name: al.assetName || al.name || "Asset", typeKey: al.assetType || "asset" };
            }
          } catch { /* ignore */ }
        }
        return Object.values(peers);
      }
    },
  });

  // Filter out orphan links (profile id no longer exists in /api/profiles)
  // and hydrate the display name + type from the live profile so we never
  // render a placeholder "Asset" card again. Preserve sharePct from the
  // ownership row, and prefer live currentValue (kept fresh by edits) over
  // the snapshot in the link payload.
  // Asset-like profile types (top-level Belongings/Assets section should
  // only show these, not liabilities/loans/subscriptions). Netflix is
  // type="subscription" so it must be excluded from a person's Assets tab.
  const ASSET_LIKE_TYPES = ["asset", "vehicle", "property", "investment", "account"];

  const items = (rawItems || [])
    .filter((it: any) => it && it.id && liveById.has(it.id))
    .filter((it: any) => {
      // For person/self profiles only: restrict the Assets section to
      // genuine top-level assets the person owns/co-owns.
      //   1) Exclude liabilities, loans, subscriptions (e.g. Netflix).
      //   2) Exclude assets that are nested under another asset — they
      //      already appear under their parent (top-level only here).
      if (!isPerson) return true;
      const live = liveById.get(it.id);
      if (!live) return false;
      if (!ASSET_LIKE_TYPES.includes(live.type)) return false;
      const parentId = live.parentProfileId;
      if (parentId) {
        const parent = liveById.get(parentId);
        if (parent && ASSET_LIKE_TYPES.includes(parent.type)) return false;
      }
      return true;
    })
    .map((it: any) => {
      const live = liveById.get(it.id);
      const liveValue = live?.currentValue ?? live?.fields?.currentValue ?? live?.fields?.value ?? null;
      return {
        id: it.id,
        linkId: it.linkId,
        name: (live?.name || it.name || "").trim(),
        typeKey: live?.type || it.typeKey || "asset",
        sharePct: it.sharePct,
        currentValue: liveValue != null ? Number(liveValue) : (it.currentValue ?? null),
      };
    });

  // Asset candidates for person picker: all asset-type profiles not
  // already linked to this person. Pulls from /api/profiles (cached).
  const linkedAssetIds = useMemo(() => new Set(items.map((i: any) => i.id).filter(Boolean)), [items]);
  const assetCandidates = useMemo(() => {
    return (liveProfiles || [])
      .filter((p: any) => ["asset", "vehicle", "property"].includes(p.type))
      .filter((p: any) => !linkedAssetIds.has(p.id))
      .filter((p: any) => !pickerSearch.trim() || (p.name || "").toLowerCase().includes(pickerSearch.toLowerCase()))
      .slice(0, 50);
  }, [liveProfiles, linkedAssetIds, pickerSearch]);

  // Link mutation — POST /api/asset-party-links and invalidate every
  // downstream cache so the new card shows up immediately on both sides.
  const linkMut = useMutation({
    mutationFn: async () => {
      if (!pickerPendingId) throw new Error("No asset selected");
      const pct = Math.max(0, Math.min(100, Number(pickerPct) || 100));
      await apiRequest("POST", "/api/asset-party-links", {
        assetProfileId: pickerPendingId,
        partyProfileId: profileId,
        ownershipPercentage: pct,
        role: "owner",
      });
    },
    onSuccess: (_data, _vars) => {
      toast({ title: "Asset linked" });
      const linkedAssetId = pickerPendingId; // capture before reset
      setPickerOpen(false);
      setPickerPendingId(null);
      setPickerPct("100");
      setPickerSearch("");
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/parties", profileId, "assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      // Bug #2: also invalidate the asset's own party-links view so the asset's
      // Linked-People panel reflects the new owner immediately.
      if (linkedAssetId) {
        queryClient.invalidateQueries({ queryKey: ["/api/assets", linkedAssetId, "parties"] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", linkedAssetId, "detail"] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/asset-party-links"] });
    },
    onError: (err: Error) => toast({ title: "Failed to link", description: formatApiError(err), variant: "destructive" }),
  });

  const unlinkMut = useMutation({
    mutationFn: async (linkId: string) => { await apiRequest("DELETE", `/api/asset-party-links/${linkId}`); },
    onSuccess: () => {
      toast({ title: "Unlinked" });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/parties", profileId, "assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      // Bug #14: the unlinked asset's own party-links query is keyed by the
      // asset id (not the person id), and we don't have the asset id in scope
      // from just the link id. Broadly invalidate every [/api/assets, *, parties]
      // query so the asset's Linked-People view refreshes wherever it's mounted.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          return Array.isArray(k) && k[0] === "/api/assets" && k[2] === "parties";
        },
      });
      queryClient.invalidateQueries({ queryKey: ["/api/asset-party-links"] });
    },
    onError: (err: Error) => toast({ title: "Failed to unlink", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <>
      {isPerson && (
        <div className="flex justify-end mb-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPickerOpen(true)} data-testid="button-link-asset">
            <Plus className="h-3.5 w-3.5 mr-1" /> Link Asset
          </Button>
        </div>
      )}
      {items.length === 0 ? (
        <div className="text-center py-10" data-testid="linked-assets-empty">
          <Package className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No linked assets</p>
          {isPerson && (
            <p className="text-xs text-muted-foreground/70 mt-1">
              Tap “Link Asset” above to attach an existing vehicle, property, or investment.
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {items.map((item: any, i: number) => (
            <div key={item.id || i} className="relative">
              <RelAssetCard
                id={item.id}
                name={item.name}
                typeKey={item.typeKey}
                sharePct={item.sharePct}
                currentValue={item.currentValue}
              />
              {isPerson && item.linkId && (
                <button
                  className="absolute top-1.5 right-1.5 h-6 w-6 rounded-md hover:bg-muted/70 inline-flex items-center justify-center text-muted-foreground hover:text-foreground"
                  onClick={() => { if (confirm("Unlink this asset from this person?")) unlinkMut.mutate(item.linkId); }}
                  data-testid={`btn-unlink-asset-${item.id}`}
                  aria-label="Unlink asset"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <LinkAssetDialog
        open={pickerOpen}
        onOpenChange={(b) => { setPickerOpen(b); if (!b) { setPickerPendingId(null); setPickerSearch(""); } }}
        search={pickerSearch}
        setSearch={setPickerSearch}
        candidates={assetCandidates}
        pendingId={pickerPendingId}
        setPendingId={setPickerPendingId}
        pct={pickerPct}
        setPct={setPickerPct}
        onSubmit={() => linkMut.mutate()}
        submitting={linkMut.isPending}
      />
    </>
  );
}

// ── Linked Liabilities tab (rel-liabilities) ──
function LinkedLiabilitiesRelTab({ profileId, profileType }: { profileId: string; profileType: string }) {
  const { toast } = useToast();
  const isLiability = profileType === "liability" || profileType === "loan";
  const isPerson = profileType === "person" || profileType === "self";
  const isAsset = ["asset","vehicle","property"].includes(profileType);

  // Picker state (asset profiles can link an existing liability to themselves)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerPendingId, setPickerPendingId] = useState<string | null>(null);
  const [pickerPct, setPickerPct] = useState("100");

  const { data: items = [], refetch } = useQuery<any[]>({
    queryKey: ["/api/rel-liabilities", profileType, profileId],
    queryFn: async () => {
      if (isPerson) {
        const links = await apiRequest("GET", `/api/parties/${profileId}/liabilities`).then(r => r.json());
        return links.map((l: any) => ({
          id: l.liabilityProfileId || l.id,
          name: l.liabilityName || l.name || "Liability",
          typeKey: l.liabilityType || "liability",
        }));
      } else if (isAsset) {
        const links = await apiRequest("GET", `/api/assets/${profileId}/liabilities`).then(r => r.json());
        return links.map((l: any) => ({
          id: l.liabilityProfileId || l.id,
          linkId: l.id,
          name: l.liabilityName || l.name || "Liability",
          typeKey: l.liabilityType || "liability",
        }));
      } else {
        // Liability profile: nothing to show here (we don't bridge through owners).
        return [];
      }
    },
  });

  // Candidates: all user liabilities not already linked
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    enabled: isAsset && pickerOpen,
  });
  const linkedLiabIds = useMemo(() => new Set((items || []).map((i: any) => i.id).filter(Boolean)), [items]);
  const candidates = useMemo(() => {
    return (allProfiles || [])
      .filter((p: any) => (p.type === "liability" || p.type === "loan") && !linkedLiabIds.has(p.id))
      .filter((p: any) => !pickerSearch.trim() || (p.name || "").toLowerCase().includes(pickerSearch.toLowerCase()));
  }, [allProfiles, linkedLiabIds, pickerSearch]);

  const linkMut = useMutation({
    mutationFn: async () => {
      if (!pickerPendingId) return;
      await apiRequest("POST", "/api/liability-asset-links", {
        liabilityProfileId: pickerPendingId,
        assetProfileId: profileId,
        role: "collateral",
        ownershipPercentage: Number(pickerPct) || 100,
      });
    },
    onSuccess: () => {
      toast({ title: "Liability linked" });
      setPickerOpen(false);
      setPickerPendingId(null);
      setPickerPct("100");
      setPickerSearch("");
      refetch();
    },
    onError: (err: Error) => toast({ title: "Failed to link", description: formatApiError(err), variant: "destructive" }),
  });

  const unlinkMut = useMutation({
    mutationFn: async (linkId: string) => { await apiRequest("DELETE", `/api/liability-asset-links/${linkId}`); },
    onSuccess: () => { toast({ title: "Unlinked" }); refetch(); },
    onError: (err: Error) => toast({ title: "Failed", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <>
      {isAsset && (
        <div className="flex justify-end mb-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setPickerOpen(true)} data-testid="btn-link-liability">
            <Plus className="h-3.5 w-3.5 mr-1" /> Link Liability
          </Button>
        </div>
      )}
      {items.length === 0 ? (
        <div className="text-center py-10">
          <CreditCard className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No linked liabilities</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {items.map((item: any, i: number) => (
            <Card key={item.id || i} style={{height: 160}} className="overflow-hidden">
              <CardContent className="p-3 h-full flex flex-col justify-between">
                <div className="flex items-start gap-2">
                  <span className="text-muted-foreground mt-0.5">{typeKeyIcon(item.typeKey)}</span>
                  <div className="flex-1 min-w-0">
                    <a href={`#/profiles/${item.id}`} className="text-sm font-semibold hover:underline truncate block">{item.name}</a>
                    <span className="text-xs text-muted-foreground capitalize">{item.typeKey}</span>
                  </div>
                  {isAsset && item.linkId && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      onClick={() => { if (confirm("Unlink this liability?")) unlinkMut.mutate(item.linkId); }}
                      data-testid={`btn-unlink-liability-${item.id}`}
                      aria-label={`Unlink ${item.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <div>
                  <Button size="sm" variant="ghost" className="h-6 text-xs px-2" asChild>
                    <a href={`#/profiles/${item.id}`}><ExternalLink className="h-3 w-3 mr-1" />View</a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <LinkLiabilityDialog
        open={pickerOpen}
        onOpenChange={(b) => { setPickerOpen(b); if (!b) { setPickerPendingId(null); setPickerSearch(""); } }}
        search={pickerSearch}
        setSearch={setPickerSearch}
        candidates={candidates}
        pendingId={pickerPendingId}
        setPendingId={setPickerPendingId}
        pct={pickerPct}
        setPct={setPickerPct}
        onSubmit={() => linkMut.mutate()}
        submitting={linkMut.isPending}
      />
    </>
  );
}

// ConnectionsTab and HistoryTab are defined in ProfileSharedTabs.tsx
// (extracted to avoid circular imports with liability-detail.tsx)
export { ConnectionsTab, HistoryTab } from "@/components/ProfileSharedTabs";
import { ConnectionsTab, HistoryTab } from "@/components/ProfileSharedTabs";

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
        case "habits": return (profile.relatedHabits || []).length > 0; // Habits tab — show if any habit is linked
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
        case "linked-liabilities": return true;
        case "contained": return true;
        case "financials": return true;
        case "payments": return true;
        // New aggregate tabs for person/self profiles — always show because
        // they're the primary navigation, not optional data-driven tabs.
        case "belongings": return true;
        case "health-trackers": return true;
        case "tasks-schedule": return true;
        default: return false;
      }
    })();
    
    if (hasData) {
      withData.push(tab);
    } else {
      // Hide truly empty low-value tabs; keep high-value ones with CTAs
      const alwaysShow = ["info", "finances", "trackers", "tasks", "activity", "health", "loan-detail", "billing", "impact", "details", "warranty", "rewards", "access", "insights", "valuation", "linked-subs", "linked-liabilities", "contained", "financials", "payments", "history", "belongings", "health-trackers", "tasks-schedule"];
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to add payment", description: formatApiError(err), variant: "destructive" }),
  });

  const calendarSyncMutation = useMutation({
    mutationFn: async () => {
      // Bug fix: server insertEventSchema uses `category` (not `type`) and
      // `recurrence` (not `recurring`). Previously both fields were dropped
      // by zod safeParse so the event landed with default category=personal
      // and recurrence=none instead of a recurring finance event.
      const freq = (f.frequency || "monthly").toLowerCase();
      const validRecurrence = ["none", "daily", "weekly", "biweekly", "monthly", "yearly"];
      const recurrence = validRecurrence.includes(freq) ? freq : "monthly";
      await apiRequest("POST", "/api/events", {
        title: `\u{1F4B0} ${profile.name} billing`,
        date: f.renewalDate || new Date().toISOString().slice(0, 10),
        category: "finance",
        linkedProfiles: [profileId],
        recurrence,
      });
    },
    onSuccess: () => {
      toast({ title: "Calendar event created" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to sync", description: formatApiError(err), variant: "destructive" }),
  });
  const deleteSubPayMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/expenses/${id}`); },
    onSuccess: (_data, id) => {
      queryClient.setQueryData(["/api/expenses"], (old: any[]) => old?.filter((e: any) => e.id !== id) || []);
      queryClient.setQueryData(["/api/profiles", profileId, "detail"], (old: any) => {
        if (!old?.relatedExpenses) return old;
        return { ...old, relatedExpenses: old.relatedExpenses.filter((e: any) => e.id !== id) };
      });
      toast({ title: "Payment deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/expenses"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); onChanged();
    },
    onError: (err: Error) => toast({ title: "Failed to delete payment", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <div className="space-y-4" data-testid="subscription-billing-tab">
      {/* Billing Info */}
      <Card>
        <div className="w-full flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Billing Info</span>
        </div>
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
          {events.length > 0 ? (() => {
            const sorted = [...events].sort((a: any, b: any) => (parseDate(a.date)?.getTime() || 0) - (parseDate(b.date)?.getTime() || 0));
            const upcoming = sorted.filter((ev: any) => !isPast(ev.date)).slice(0, 5);
            const recentPast = sorted.filter((ev: any) => isPast(ev.date)).reverse().slice(0, 3);
            if (upcoming.length === 0 && recentPast.length === 0) {
              return <p className="text-xs text-muted-foreground py-2">No calendar events linked yet</p>;
            }
            return (
              <div className="space-y-1">
                {upcoming.map((ev: any) => (
                  <div key={ev.id} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Calendar className="h-3 w-3 text-emerald-500 shrink-0" />
                      <span className="text-xs truncate">{ev.title}</span>
                    </div>
                    <span className="text-xs font-medium tabular-nums shrink-0">{relativeDayLabel(ev.date) || "\u2014"}</span>
                  </div>
                ))}
                {recentPast.length > 0 && upcoming.length > 0 && (
                  <div className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground/60 pt-1.5">Past</div>
                )}
                {recentPast.map((ev: any) => (
                  <div key={ev.id} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0 opacity-60">
                    <div className="flex items-center gap-2 min-w-0">
                      <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-xs truncate text-muted-foreground">{ev.title}</span>
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{relativeDayLabel(ev.date) || "\u2014"}</span>
                  </div>
                ))}
              </div>
            );
          })() : (
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
      <Dialog open={showAddPayment} onOpenChange={(open) => { if (!open) { setPayDesc(""); setPayAmount(""); setPayDate(new Date().toISOString().slice(0, 10)); setPayCategory("subscription"); } setShowAddPayment(open); }}>
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
              <Input className="mt-1 h-8 text-xs" type="number" inputMode="decimal" step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)} placeholder="0.00" data-testid="input-payment-amount" />
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
                  {["entertainment", "other", "software", "subscription", "utilities"].map(c => (
                    <SelectItem key={c} value={c} className="text-xs capitalize">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" className="h-8 text-xs" onClick={() => createPaymentMutation.mutate()} disabled={!payAmount || parseFloat(payAmount) <= 0 || new Date(payDate) > new Date() || createPaymentMutation.isPending} data-testid="button-submit-payment">
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
    queryFn: async () => { const res = await apiRequest("GET", `/api/profiles/${parentId}/detail`); return flattenProfile(await res.json()); },
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
    onSettled: () => { queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] }); queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] }); queryClient.invalidateQueries({ queryKey: ["/api/stats"] }); },
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => { const reader = new FileReader(); reader.onload = () => res((reader.result as string).split(",")[1]); reader.onerror = rej; reader.readAsDataURL(f); });
      const fileData = await toBase64(file);
      // Switch to save-only — same Vercel-60s reasoning as the main Documents tab.
      const res = await apiRequest("POST", "/api/upload/save-only", {
        fileName: file.name, mimeType: file.type, fileData, profileIds: [profileId],
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
              {documents.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((doc) => (
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
        <div className="w-full flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Terms & Cancellation</span>
        </div>
        <CardContent className="px-4 pb-3 pt-0">
          {termsFields.map(({ key, label }) => (
            <GroupedInlineField key={key} profileId={profileId} fieldKey={key} label={label} value={f[key]} onSaved={onChanged} />
          ))}
        </CardContent>
      </Card>

      {/* Support Info */}
      <Card>
        <div className="w-full flex items-center justify-between px-4 py-2.5">
          <span className="text-xs font-semibold">Support Info</span>
        </div>
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
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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

  // Document title is set dynamically below once the profile loads, so the
  // browser tab reflects the actual entity (e.g. "Scrappy · Pet — Portol")
  // instead of a generic "Profile — Portol". Falls back to the generic title
  // while loading or if the fetch fails.
  useEffect(() => { document.title = "Profile — Portol"; }, []);

  // PERF (2026-05-28): single-shot bootstrap. /api/profile-bootstrap/:id returns
  // detail + tree + allProfiles + assetPartyLinks + liabilityProfileLinks in
  // ONE round-trip. We pre-fill the react-query cache so the individual
  // useQuery hooks below resolve from cache without firing extra network
  // calls. Without this, the page fired ~10 parallel network calls and the
  // skeleton stayed up for several seconds on cold loads.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    apiRequest("GET", `/api/profile-bootstrap/${id}`)
      .then(r => r.json())
      .then((b: any) => {
        if (cancelled || !b || typeof b !== "object") return;
        if (b.detail) queryClient.setQueryData(["/api/profiles", id, "detail"], flattenProfile(b.detail));
        if (b.tree) queryClient.setQueryData(["/api/profiles", id, "tree"], b.tree);
        if (b.profiles) queryClient.setQueryData(["/api/profiles"], b.profiles);
        if (b.assetPartyLinks) queryClient.setQueryData(["/api/asset-party-links"], b.assetPartyLinks);
        if (b.liabilityProfileLinks) queryClient.setQueryData(["/api/liability-profile-links"], b.liabilityProfileLinks);
      })
      .catch(() => { /* non-fatal — individual queries will fetch on their own */ });
    return () => { cancelled = true; };
  }, [id]);

  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [linkedFilter, setLinkedFilter] = useState<"all" | "profiles" | "trackers" | "documents">("all");
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Upload to Supabase Storage via /api/profiles/:id/photo so the avatar column
  // stores a small public URL (not a multi-MB base64 blob).
  const avatarMutation = useMutation({
    mutationFn: async (payload: { fileData: string; mimeType: string }) => {
      await apiRequest("POST", `/api/profiles/${id}/photo`, payload);
    },
    onSuccess: () => {
      toast({ title: "Profile picture updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    },
    onError: (err: Error) => toast({ title: "Failed to update picture", description: formatApiError(err), variant: "destructive" }),
  });

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Please choose an image under 5MB", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // result is a data URI like "data:image/jpeg;base64,..." — split it.
      const mimeType = file.type || "image/jpeg";
      const fileData = result.includes(",") ? result.split(",")[1] : result;
      avatarMutation.mutate({ fileData, mimeType });
    };
    reader.readAsDataURL(file);
  };

  const { data: profile, isLoading, error } = useQuery<ProfileDetail>({
    queryKey: ["/api/profiles", id, "detail"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${id}/detail`);
      const raw = await res.json();
      // Flatten nested storage paths (fields.vehicles.*, fields.insurance.*,
      // fields.housing.*, fields.other.*, fields.finance.*) up to top level so
      // every reader (`f.licensePlate`, `f.currentValue`, `f.year`, etc.) works
      // regardless of how the value was originally written. Top-level keys win.
      return flattenProfile(raw);
    },
    enabled: !!id,
    refetchOnMount: true,
  });

  // Page-level all-profiles — powers the new breadcrumb + summary + tree.
  // Shared across all child queries via the same queryKey so React Query
  // dedupes the network request.
  const { data: allProfilesPage = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: !!id,
  });

  // Tree for the current profile — used by Overview rebuild + Financials tab.
  const { data: pageTreeData } = useQuery<any>({
    queryKey: ["/api/profiles", id, "tree"],
    queryFn: () => apiRequest("GET", `/api/profiles/${id}/tree`).then(r => r.json()),
    enabled: !!id,
  });

  // Once the profile loads, refine the browser-tab title so it reflects the
  // actual entity ("iPhone 15 · Asset — Portol", "Scrappy · Pet — Portol",
  // "Bob Robertson — Portol"). Resets on unmount so other pages can claim
  // their own title.
  useEffect(() => {
    if (!profile?.name) return;
    const niceType = profile.type === "self" || profile.type === "person"
      ? ""
      : ` · ${profile.type.charAt(0).toUpperCase() + profile.type.slice(1)}`;
    document.title = `${profile.name}${niceType} — Portol`;
  }, [profile?.name, profile?.type]);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/profiles/${id}`);
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/profiles"], (old: any[]) =>
        old?.filter((p: any) => p.id !== id) || []
      );
      toast({ title: `Profile deleted`, description: "All linked data has been removed" });
      // Cascade: profile delete also removes linked obligations, events, expenses, etc.
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
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
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  }

  // ── Owner dropdown (asset / vehicle / loan / subscription etc.) ───────────────
  // ── Multi-owner popover state ─────────────────────────────────────────────
  const [ownerPopoverOpen, setOwnerPopoverOpen] = useState(false);

  const assetTypes = ["vehicle","asset","subscription","loan","investment","property","insurance","medical","account"];
  const isAssetProfile = !!profile && assetTypes.includes(profile.type);

  const { data: ownerCandidates } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
    enabled: isAssetProfile,
  });
  const personOptions = (ownerCandidates || []).filter((p: any) =>
    ["self","person"].includes(p.type) && !p.parentProfileId
  );

  // Fetch current asset-party links so we know who is already linked
  const { data: currentPartyLinks = [], refetch: refetchPartyLinks } = useQuery<any[]>({
    queryKey: ["/api/assets", id, "parties"],
    queryFn: () => apiRequest("GET", `/api/assets/${id}/parties`).then(r => r.json()),
    enabled: isAssetProfile && !!id,
  });

  // Build checked set from current links (partyProfileId set)
  const linkedPersonIdSet = useMemo(() =>
    new Set((currentPartyLinks || []).map((l: any) => l.partyProfileId || l.party?.id)),
    [currentPartyLinks]
  );

  // Local checked state for the popover (initialise from server data when popover opens)
  const [checkedOwnerIds, setCheckedOwnerIds] = useState<Set<string>>(new Set());

  // Sync checked state when popover opens. If no links exist yet, default to
  // the user's self profile so a single Save click confirms self-ownership.
  useEffect(() => {
    if (ownerPopoverOpen) {
      if (linkedPersonIdSet.size === 0) {
        const self = (personOptions || []).find((p: any) => p.type === "self");
        setCheckedOwnerIds(self ? new Set([self.id]) : new Set());
      } else {
        setCheckedOwnerIds(new Set(linkedPersonIdSet));
      }
    }
  }, [ownerPopoverOpen, linkedPersonIdSet, personOptions]);

  const saveOwnersMutation = useMutation({
    mutationFn: async (selectedIds: string[]) => {
      const pct = selectedIds.length > 0 ? Math.round(10000 / selectedIds.length) / 100 : 100;
      // Determine which links to add and which to remove
      const toAdd = selectedIds.filter(sid => !linkedPersonIdSet.has(sid));
      const toRemove = (currentPartyLinks || []).filter((l: any) => {
        const lid = l.partyProfileId || l.party?.id;
        return lid && !selectedIds.includes(lid);
      });
      // Delete removed links
      for (const link of toRemove) {
        await apiRequest("DELETE", `/api/asset-party-links/${link.id || link.linkId}`);
      }
      // Add new links
      for (const sid of toAdd) {
        await apiRequest("POST", "/api/asset-party-links", {
          assetProfileId: id,
          partyProfileId: sid,
          ownershipPercentage: pct,
          role: "owner",
        });
      }
      // Update ownership pct for existing kept links to equalize
      const toKeep = (currentPartyLinks || []).filter((l: any) => {
        const lid = l.partyProfileId || l.party?.id;
        return lid && selectedIds.includes(lid);
      });
      for (const link of toKeep) {
        await apiRequest("PATCH", `/api/asset-party-links/${link.id || link.linkId}`, {
          ownershipPercentage: pct,
        });
      }
      // Update ownerName display fallback and parent column for single-owner case.
      // Note: ownerProfileId is intentionally NOT written — no reader consumes it
      // (party-link rows are the source of truth). ownerName is still kept as a
      // display fallback at line ~10533 when no party links exist yet.
      const firstName = selectedIds.length === 1
        ? (personOptions.find((p: any) => p.id === selectedIds[0])?.name || null)
        : null;
      await apiRequest("PATCH", `/api/profiles/${id}`, {
        fields: {
          ...(profile?.fields || {}),
          ownerName: firstName,
        },
        parentProfileId: selectedIds.length === 1 ? selectedIds[0] : (profile?.parentProfileId || null),
      });
      // Return the union of old + new owners so onSuccess can invalidate each
      // affected person's caches (their assets list must refresh too).
      const oldOwnerIds = (currentPartyLinks || [])
        .map((l: any) => l.partyProfileId || l.party?.id)
        .filter(Boolean) as string[];
      return Array.from(new Set([...oldOwnerIds, ...selectedIds]));
    },
    onSuccess: (affectedOwnerIds: string[] = []) => {
      toast({ title: "Ownership updated" });
      refetchPartyLinks();
      handleSaved();
      // Bug #1 + #15: invalidate every cache key the new ownership affects so
      // the UI is consistent without a refresh. Each affected person's profile
      // detail + their assets list, the global profile list, the dashboard,
      // the asset's own party links query, and the bulk party-links endpoint.
      queryClient.invalidateQueries({ queryKey: ["/api/rel-people"] }); // legacy key (still invalidated by ProfileSharedTabs)
      queryClient.invalidateQueries({ queryKey: ["/api/assets", id, "parties"] });
      queryClient.invalidateQueries({ queryKey: ["/api/liabilities", id, "parties"] });
      queryClient.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === "/api/relationships/graph" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/asset-party-links"] });
      for (const ownerId of affectedOwnerIds) {
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", ownerId, "detail"] });
        queryClient.invalidateQueries({ queryKey: ["/api/parties", ownerId, "assets"] });
      }
      setOwnerPopoverOpen(false);
    },
    onError: (err: Error) => toast({ title: "Failed to update ownership", description: formatApiError(err), variant: "destructive" }),
  });

  // Derive display label for the owner button. When no party links exist yet,
  // fall back to (in order) fields.ownerName, the user's self profile name, or
  // "Set owner" — never leave it ambiguous since the user is the implicit owner.
  const ownerButtonLabel = useMemo(() => {
    const linked = (currentPartyLinks || []).map((l: any) => l.party?.name || personOptions.find((p: any) => p.id === (l.partyProfileId || l.party?.id))?.name).filter(Boolean);
    if (linked.length === 0) {
      if (profile?.fields?.ownerName) return profile.fields.ownerName;
      const self = (personOptions || []).find((p: any) => p.type === "self");
      if (self?.name) return self.name;
      return "Set owner";
    }
    if (linked.length === 1) return linked[0];
    if (linked.length === 2) return `Shared · ${linked[0]} + ${linked[1]}`;
    return `Shared · ${linked.length} people`;
  }, [currentPartyLinks, personOptions, profile]);

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
        <Link href="/profiles" className="inline-flex items-center justify-center rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 px-3 text-xs font-medium" data-testid="button-back-to-profiles" aria-label="Back to Profiles">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Profiles
        </Link>
      </div>
    );
  }

  // Liability profiles get a dedicated, fully-interactive profile page —
  // overview, details, payments, amortization (Phase 2). Legacy 'loan' rows
  // that haven't been migrated yet still flow through here too.
  if (profile.type === "liability" || profile.type === "loan") {
    return <LiabilityProfilePage profile={profile as any} />;
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
          <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-white/80 hover:text-white transition-colors" data-testid="button-back">
            <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
          </Link>
          <div className="flex items-center gap-1.5">
            {/* Owner picker removed from header — the single source of truth
                for owners is the Linked People section in the Overview. */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 bg-white/15 hover:bg-white/25 text-white border-white/30 backdrop-blur-sm"
              onClick={() => setShowEditDialog(true)}
              data-testid="button-header-edit-profile"
            >
              <Edit className="h-3 w-3" /> Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1 bg-white/15 hover:bg-red-500/30 text-white border-white/30 backdrop-blur-sm"
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
            className={`relative w-20 h-20 rounded-2xl flex items-center justify-center overflow-hidden group cursor-pointer ring-2 ring-white/40 shadow-lg ${profileAccent(profile.type)}`}
            onClick={() => avatarInputRef.current?.click()}
            disabled={avatarMutation.isPending}
            title="Change profile picture"
            data-testid="button-avatar-upload"
          >
            {profile.avatar ? (
              <img src={profile.avatar} alt={profile.name} className="w-full h-full object-cover" />
            ) : (
              <span className="scale-150">{profileIcon(profile.type)}</span>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Camera className="h-5 w-5 text-white" />
            </div>
            {avatarMutation.isPending && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <RefreshCw className="h-5 w-5 text-white animate-spin" />
              </div>
            )}
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-white drop-shadow-sm" data-testid="text-profile-detail-name">{profile.name}</h1>
            {/* Phase 2 breadcrumb — only renders when this profile has a parent chain. */}
            {(NESTED_ASSET_TYPES.includes(profile.type as NestedAssetType) ||
              ((profile.type as string) === "liability") ||
              ((profile.type as string) === "loan") ||
              ((profile.type as string) === "subscription")) && (
              <RebuildBreadcrumb
                profile={profile as any}
                allProfiles={allProfilesPage as any}
                className="mt-1"
              />
            )}
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <Badge variant="secondary" className="text-xs capitalize bg-white/20 text-white border-white/30 backdrop-blur-sm hover:bg-white/30">{profile.type}</Badge>
              {(profile.tags ?? []).slice().sort((a, b) => a.localeCompare(b)).map(tag => (
                <Badge key={tag} variant="outline" className="text-xs bg-white/10 text-white/90 border-white/25">
                  <Tag className="h-2.5 w-2.5 mr-0.5" />{tag}
                </Badge>
              ))}
              {/* owner is now shown in the top-right dropdown button — no badge needed here */}
            </div>
            {profile.notes && (
              <p className="text-xs text-white/75 mt-2 line-clamp-2">{profile.notes}</p>
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
                <div key={stat.label} className="text-center py-2.5 rounded-lg bg-white/15 backdrop-blur-md border border-white/20 shadow-sm">
                  <p className="text-lg font-bold tabular-nums text-white">{stat.value}</p>
                  <p className="text-[10px] uppercase tracking-wider text-white/80 font-medium">{stat.label}</p>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* AI Summary Card — isolated so a malformed summary payload (e.g. a
          stale cached entry missing highlights/actionItems) degrades to a
          compact inline error instead of blanking the whole profile page. */}
      <div className="px-4 md:px-6 pt-4">
        <SectionErrorBoundary name="profile-ai-summary" inline>
          <AISummaryCard profileId={id} profileType={profile.type} profileUpdatedAt={profile.updatedAt} />
        </SectionErrorBoundary>
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
                  {/* Person/Self Overview — single home for net worth, assets,
                      and liabilities (June 2026 restructure). The Finance tab
                      no longer shows asset/liability rollups; the Belongings
                      tab was removed entirely. */}
                  {["person", "self"].includes(profile.type) && (
                    <div className="mt-4 space-y-6" data-testid="person-overview-financials">
                      <NetWorthStrip profileId={profile.id} />
                      <section>
                        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Assets</p>
                        <LinkedAssetsTab profileId={profile.id} profileType={profile.type} />
                      </section>
                      <section>
                        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Liabilities</p>
                        <LinkedLiabilitiesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                      </section>
                    </div>
                  )}
                  {/* Linked People moved off Overview (2026-06-10): the Linked
                      tab in the bottom nav and the per-profile "Linked" tab
                      already surface this; duplicating it on Overview just
                      pushed the actual person details below the fold. */}
                  {/* Non-person profiles — identity-only Overview (2026-05-26 redo):
                      Overview tab now answers ONE question: "what is this thing?"
                      Money/value/liabilities  → Money tab
                      Full rollup with kids    → Financials tab
                      Ownership tree + owner   → Contained tab (merged)
                      Linked Liabilities       → Money tab
                      Only trackers stay here because they describe the asset
                      itself (mileage, weight, value-over-time, etc.). */}
                  {!(["person", "self"].includes(profile.type)) && ["asset","vehicle","property","investment","account"].includes(profile.type) && (
                    <div className="mt-4 space-y-3" data-testid="asset-overview-identity-only">
                      {profile.relatedTrackers.length > 0 && (
                        <Card>
                          <CardContent className="p-3">
                            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Trackers ({profile.relatedTrackers.length})</p>
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
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}
                  {/* Non-asset, non-person profiles (loan/subscription/insurance/medical/etc.)
                      keep the legacy Overview layout. Their detail pages haven't
                      been redesigned yet — future phase. */}
                  {!(["person", "self","asset","vehicle","property","investment","account"].includes(profile.type)) && (
                    <>
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
                    </>
                  )}
                </TabsContent>
              )}

              {/* ── Phase 3 (2026-05-26): dedicated tabs for asset profiles ──
                  Contained = full Child Assets list (the Adopt-as-Child entry +
                  per-row Move/Remove actions live here).
                  Financials = ValueRollupCard + itemised per-child breakdown. */}
              {tabValues.has("contained") && (
                <TabsContent value="contained" className="mt-4 px-1 sm:px-0 space-y-3">
                  {/* Contained tab — merged ownership + containment (2026-05-26):
                      Holds everything about how this asset relates to its parent,
                      owner, children, AND any liabilities secured against it.
                      Overview is identity-only; this tab is "where does it sit
                      in the hierarchy, what's inside it, and what's owed against it". */}
                  {["asset","vehicle","property","investment","account"].includes(profile.type) && (
                    <>
                      <RebuildOwnershipTree
                        profile={profile as any}
                        allProfiles={allProfilesPage as any}
                        treeData={pageTreeData as any}
                      />
                      <RebuildOwnerControl
                        profile={profile as any}
                        allProfiles={allProfilesPage as any}
                        onSaved={handleSaved}
                      />
                    </>
                  )}
                  <NestedAssetSections
                    profile={profile}
                    allProfiles={allProfilesPage as any}
                    onSaved={handleSaved}
                    mode="children"
                  />
                  {/* Linked Liabilities used to live here too — removed
                      (2026-06-11) because the same section also renders on
                      the Financials tab and showing it twice was confusing.
                      A liability is a financial obligation, so Financials
                      is the more natural home. */}
                </TabsContent>
              )}
              {tabValues.has("financials") && (
                <TabsContent value="financials" className="mt-4 px-1 sm:px-0 space-y-3">
                  <NestedAssetSections
                    profile={profile}
                    allProfiles={allProfilesPage as any}
                    onSaved={handleSaved}
                    mode="financials"
                  />
                  <RebuildFinancials profile={profile as any} treeData={pageTreeData as any} />
                  {/* Liabilities also surface on Financials — they're a core
                      component of the rollup. Same component as Contained so the
                      user can link/unlink from either tab. */}
                  {["asset","vehicle","property","investment","account"].includes(profile.type) && (
                    <section>
                      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Linked Liabilities</p>
                      <AssetLinkedLiabilitiesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                    </section>
                  )}
                </TabsContent>
              )}

              {/* Person/Self "Finance" tab (June 2026 restructure) --
                  Expenses, budgets, recurring costs, payments only.
                  Asset/liability rollup has been stripped from FinancesTab
                  itself; those now live exclusively on the Overview tab. */}
              {tabValues.has("finance") && (
                <TabsContent value="finance" className="mt-4 px-1 sm:px-0">
                  <FinancesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {/* Person/Self "Trackers" tab (June 2026 restructure) --
                  Trackers only. The previous layout buried trackers under
                  Health and used the value="trackers" tab for Documents,
                  which was a value/label mismatch bug. */}
              {tabValues.has("person-trackers") && (
                <TabsContent value="person-trackers" className="mt-4 px-1 sm:px-0">
                  {profile.relatedTrackers.length > 0 ? (
                    <TrackersTab trackers={profile.relatedTrackers} profileId={profile.id} onChanged={handleSaved} />
                  ) : (
                    <Card>
                      <CardContent className="py-8 text-center">
                        <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                        <p className="text-sm text-muted-foreground">No trackers yet</p>
                        <p className="text-xs text-muted-foreground mt-1">Create trackers via chat, then link them here</p>
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              )}

              {/* Person/Self "Documents" tab (June 2026 restructure) --
                  Documents only. Notes fold in as a small section so the
                  freeform Notes editor still has a home. */}
              {tabValues.has("person-documents") && (
                <TabsContent value="person-documents" className="mt-4 px-1 sm:px-0">
                  <DocumentsTab
                    documents={profile.relatedDocuments}
                    profileId={profile.id}
                    profileName={profile.name}
                    childProfiles={profile.childProfiles}
                    profileType={profile.type}
                    onUploaded={handleSaved}
                  />
                  <section className="mt-6">
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Notes</p>
                    <NotesTab profileId={id} currentNotes={profile.notes || ""} updatedAt={profile.updatedAt} onChanged={handleSaved} />
                  </section>
                </TabsContent>
              )}

              {/* Person/Self "History" tab (June 2026 restructure) --
                  Tasks, upcoming events, past activity, and the profile
                  change log. Replaces Tasks & Schedule and folds in the
                  change history. */}
              {tabValues.has("person-history") && (
                <TabsContent value="person-history" className="mt-4 px-1 sm:px-0 space-y-6">
                  <section>
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Tasks &amp; Goals</p>
                    <TasksTab
                      tasks={profile.relatedTasks}
                      profileId={profile.id}
                      onChanged={handleSaved}
                    />
                  </section>
                  <section>
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Schedule &amp; Activity</p>
                    {(() => {
                      type FeedItem = { date: string; type: string; title: string; subtitle?: string; color: string };
                      const feed: FeedItem[] = [];
                      for (const t of (profile.relatedTasks || [])) {
                        feed.push({ date: t.dueDate || (t as any).createdAt || '', type: 'task', title: t.title, subtitle: t.status, color: '#8b5cf6' });
                      }
                      for (const ev of (profile.relatedEvents || [])) {
                        feed.push({ date: (ev as any).date || '', type: 'event', title: (ev as any).title, subtitle: (ev as any).time, color: '#3b82f6' });
                      }
                      for (const e of (profile.relatedExpenses || [])) {
                        feed.push({ date: e.date || (e as any).createdAt || '', type: 'expense', title: e.description || 'Expense', subtitle: `$${Number(e.amount).toFixed(2)}`, color: '#f59e0b' });
                      }
                      if (feed.length === 0) {
                        return (
                          <div className="text-center py-10 rounded-xl border border-dashed border-border/60 bg-muted/10">
                            <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                            <p className="text-sm text-muted-foreground">No activity yet</p>
                            <p className="text-xs text-muted-foreground/70 mt-0.5">Linked tasks, events, and expenses will appear here</p>
                          </div>
                        );
                      }
                      const upcoming: FeedItem[] = [];
                      const past: FeedItem[] = [];
                      for (const item of feed) {
                        const isDoneTask = item.type === 'task' && item.subtitle === 'done';
                        if (isDoneTask || isPast(item.date)) past.push(item);
                        else upcoming.push(item);
                      }
                      upcoming.sort((a, b) => (parseDate(a.date)?.getTime() || 0) - (parseDate(b.date)?.getTime() || 0));
                      past.sort((a, b) => (parseDate(b.date)?.getTime() || 0) - (parseDate(a.date)?.getTime() || 0));
                      const renderItem = (item: FeedItem, i: number, variant: 'upcoming' | 'past') => {
                        const labelDate = parseDate(item.date);
                        const rel = relativeDayLabel(item.date);
                        const isMuted = variant === 'past';
                        return (
                          <div
                            key={`${variant}-${i}`}
                            className={`flex items-start gap-3 p-2.5 rounded-lg border transition-colors ${
                              isMuted
                                ? 'border-border/40 bg-muted/20 hover:bg-muted/30 opacity-80'
                                : 'border-border/70 bg-card hover:bg-muted/40 shadow-sm'
                            }`}
                          >
                            <div
                              className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                              style={{ background: item.color, boxShadow: `0 0 0 3px ${item.color}1F` }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className={`text-xs font-medium truncate ${isMuted ? 'text-muted-foreground' : ''}`}>{item.title}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <Badge variant="outline" className="h-4 px-1 text-[10px] capitalize">{item.type}</Badge>
                                {item.subtitle && (
                                  <span className="text-[10px] text-muted-foreground truncate">{item.subtitle}</span>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className={`text-[11px] font-semibold tabular-nums ${
                                isMuted ? 'text-muted-foreground' : 'text-foreground'
                              }`}>{rel || '\u2014'}</p>
                              {labelDate && (
                                <p className="text-[9px] text-muted-foreground/70 tabular-nums">
                                  {labelDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      };
                      return (
                        <div className="space-y-4 pb-4">
                          <div>
                            <div className="flex items-center gap-2 mb-1.5 px-0.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                              <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Upcoming</p>
                              <span className="text-[10px] text-muted-foreground">({upcoming.length})</span>
                            </div>
                            {upcoming.length === 0 ? (
                              <p className="text-xs text-muted-foreground italic px-2.5 py-3 rounded-lg bg-muted/10 border border-dashed border-border/40">No upcoming items scheduled</p>
                            ) : (
                              <div className="space-y-1.5">
                                {upcoming.slice(0, 25).map((it, i) => renderItem(it, i, 'upcoming'))}
                              </div>
                            )}
                          </div>
                          {past.length > 0 && (
                            <div>
                              <div className="flex items-center gap-2 mb-1.5 px-0.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Past</p>
                                <span className="text-[10px] text-muted-foreground">({past.length})</span>
                              </div>
                              <div className="space-y-1.5">
                                {past.slice(0, 25).map((it, i) => renderItem(it, i, 'past'))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </section>
                  <section>
                    <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Changes</p>
                    <HistoryTab profileId={profile.id} />
                  </section>
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

              {tabValues.has("habits") && (
                <TabsContent value="habits" className="mt-4 px-1 sm:px-0">
                  <ProfileHabitsTab habits={profile.relatedHabits || []} profileName={profile.name} />
                </TabsContent>
              )}

              {tabValues.has("trackers") && (
                <TabsContent value="trackers" className="mt-4 px-1 sm:px-0">
                  {/* Documents tab — ONLY documents, no trackers or child profiles */}
                  <DocumentsTab
                    documents={profile.relatedDocuments}
                    profileId={profile.id}
                    profileName={profile.name}
                    childProfiles={profile.childProfiles}
                    profileType={profile.type}
                    onUploaded={handleSaved}
                  />
                  {/* For person/self profiles fold Notes here so the
                      standalone Notes tab can disappear — keeps freeform
                      writing next to formal docs, where users actually
                      look for it. */}
                  {["person", "self"].includes(profile.type) && (
                    <section className="mt-6">
                      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2 px-0.5">Notes</p>
                      <NotesTab profileId={id} currentNotes={profile.notes || ""} updatedAt={profile.updatedAt} onChanged={handleSaved} />
                    </section>
                  )}
                </TabsContent>
              )}

              {tabValues.has("loan-detail") && (
                <TabsContent value="loan-detail" className="mt-4 px-1 sm:px-0">
                  {/* Single source of truth for liability+loan info on asset profiles.
                      Shows linked liability cards (Secures $X, $Y/mo) at top, then the
                      inline loan editor / amortization below. Liability profiles still
                      see only the LoanTab editor since they have no liabilities to link. */}
                  {["asset","vehicle","property"].includes(profile.type) && (
                    <AssetLinkedLiabilitiesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                  )}
                  <LoanTab
                    profile={profile}
                    obligations={profile.relatedObligations || []}
                    hideEmptyEditor={["asset","vehicle","property"].includes(profile.type)}
                  />
                </TabsContent>
              )}

              {tabValues.has("finances") && (
                <TabsContent value="finances" className="mt-4 px-1 sm:px-0">
                  <FinancesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                </TabsContent>
              )}

              {/* MONEY — consolidated finance tab. Replaces the separate Loan + Costs
                  (or Loan + Payments / Loan + Transactions / Billing + Details) pair
                  across asset, vehicle, property, loan, subscription and account types.
                  For subscriptions it renders the billing + details editors stacked;
                  for everything else it renders linked-liabilities + loan + bills. */}
              {tabValues.has("money") && (
                <TabsContent value="money" className="mt-4 px-1 sm:px-0 space-y-6">
                  {profile.type === "subscription" ? (
                    <>
                      <section>
                        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Billing</h3>
                        <SubscriptionBillingTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                      </section>
                      <section>
                        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Plan details</h3>
                        <SubscriptionDetailsTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                      </section>
                    </>
                  ) : (
                    <>
                      {["asset","vehicle","property"].includes(profile.type) && (
                        <section>
                          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Linked liabilities</h3>
                          <AssetLinkedLiabilitiesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                        </section>
                      )}
                      <section>
                        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Loan</h3>
                        <LoanTab
                          profile={profile}
                          obligations={profile.relatedObligations || []}
                          hideEmptyEditor={["asset","vehicle","property"].includes(profile.type)}
                        />
                      </section>
                      <section>
                        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-0.5">Bills &amp; expenses</h3>
                        <FinancesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
                      </section>
                    </>
                  )}
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

              {tabValues.has("linked-liabilities") && (
                <TabsContent value="linked-liabilities" className="mt-4 px-1 sm:px-0">
                  <LinkedLiabilitiesTab profile={profile} profileId={profile.id} onChanged={handleSaved} />
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

              {tabValues.has("history") && (
                <TabsContent value="history" className="mt-4 px-1 sm:px-0">
                  <HistoryTab profileId={profile.id} />
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
