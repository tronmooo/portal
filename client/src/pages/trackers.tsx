import { formatApiError } from "@/lib/formatError";
import { warmProfileDetail } from "@/lib/scope-prefetch";
import { StuckLoadingGuard } from "@/components/StuckLoadingGuard";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain, invalidateDomains } from "@/lib/cache-bus";
import { showUndoToast, recreateDeleted } from "@/lib/undo-delete";
import { getProfileFilter, subscribeProfileFilter } from "@/lib/profileFilter";
import { goalsQueryKey } from "@shared/query-keys";
import { isInScope, ownerCandidatesForProfile } from "@shared/scope";
import { liabilityFamily } from "@shared/liability-types";
import { passesProfileFilter } from "@shared/profile-filter";
import {
  type TrackerMetricDefinition,
  getDefaultMetricDefinition,
} from "@shared/tracker-metric-definition";
import { classifyTrackerPresentation, type TrackerPresentation } from "@shared/tracker-presentation";
import { resolveTrackerUnit } from "@shared/tracker-units";
import { inferTrackerShapeId } from "@shared/tracker-shapes";
import { trackerFieldLabel, humanizeFieldName } from "@shared/field-label";
import EditableTitle from "@/components/EditableTitle";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useHubChrome } from "@/components/hub/hub-context";
import { RadialGauge, RingProgress, LinearZoneGauge, ChecklistMini, MultiMetricBars, AreaChart as TrendArea, ZoneAreaChart, WeekdayBars, KIND_EMOJI, type GaugeZone, type PanelMetric } from "@/components/tracker-viz";
import { CreateProfileDialog } from "@/components/CreateProfileDialog";
// One card shape and one heading treatment for every hub tab — the Executive
// tab's, so Assets / Liabilities / Documents stop reading as three products.
import { EntityCard } from "@/components/ui/entity-card";
import { SectionHeading } from "@/components/ui/section-heading";
import { Medallion, Pill as StatusPill, toneForDays } from "@/components/dashboard/visuals";
import { dayLabel } from "@shared/now-rank";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Activity,
  Plus,
  TrendingUp,
  TrendingDown,
  Hash,
  MoreHorizontal,
  Trash2,
  ChevronDown, ChevronRight,
  ChevronUp,
  X,
  Maximize2,
  Minimize2,
  Flame,
  Heart,
  Moon,
  Zap,
  Trophy,
  Calendar,
  BarChart2,
  Users,
  User,
  PawPrint,
  Car,
  Building2,
  CreditCard,
  Stethoscope,
  Star,
  Smile,
  Unlink,
  ArrowLeft,
  Table2,
  LayoutGrid,
  Target,
  Brain,
  ArrowUpRight,
  ArrowDownRight,
  Minus as MinusIcon,
  Clock,
  ChartLine,
  ListChecks,
  PieChart as PieChartIcon,
  Lightbulb,
  FileText,
  Upload,
  Eye,
  AlertCircle,
  HeartPulse,
  Box,
  Pencil,
  Check,
  Dumbbell,
  Link2,
  Mail,
  Share2,
  Loader2,
  Pill,
  TreePine,
  Footprints,
  Droplet,
  BookOpen,
  Gamepad2,
  Music,
  Bike,
} from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";

// Keyboard activation helper for non-<button> clickable elements (a11y):
// makes Enter/Space behave like a click on role="button" divs.
const onEnterOrSpace = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};
import { Link, useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Tracker, TrackerEntry, TrackerField, ComputedData, Profile, Document, Goal } from "@shared/schema";
import { ShareButton, DocumentViewerDialog } from "@/components/DocumentViewer";
import { prefetchDocument } from "@/lib/document-preview";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
  Legend,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  ZAxis,
  ComposedChart,
} from "recharts";
import { useToast } from "@/hooks/use-toast";

// ── Chart Color Scheme ─────────────────────────────────────────────────────────

import { CHART_COLORS } from "@/lib/chart-colors";

// ── Category Visual Identity ─────────────────────────────────────────────────
// Each tracker category gets a distinct accent color (HSL) and a matching icon.

export const TRACKER_CATEGORY_ACCENT: Record<string, string> = {
  health:       "173 60% 44%",   // teal — medical/vitals
  fitness:      "25 85% 55%",    // orange — energy/movement
  exercise:     "25 85% 55%",
  workout:      "25 85% 55%",
  running:      "25 85% 55%",
  weight:       "25 75% 52%",    // slightly different orange for body weight
  nutrition:    "94  60% 42%",
  sleep:        "262 60% 62%",
  mental:       "310 50% 58%",
  finance:      "43  85% 52%",
  productivity: "215 70% 58%",
  education:    "188 65% 48%",
  social:       "25  80% 54%",
  environment:  "155 45% 40%",
  habit:        "155 58% 46%",
  routine:      "155 58% 46%",
  medication:   "340 70% 55%",
  prescription: "340 70% 55%",
  supplement:   "155 55% 48%",
  drug:         "340 70% 55%",
  lifestyle:    "120 45% 45%",
  mood:         "280 60% 55%",
  anxiety:      "310 50% 58%",
  custom:       "240 20% 60%",
  general:      "240 20% 60%",
  work:         "215 65% 55%",
  budget:       "43  80% 50%",
  savings:      "43  75% 48%",
};

// Icon names for each category (lucide-react)
export const TRACKER_CATEGORY_LABEL: Record<string, string> = {
  health:      "Health",
  fitness:     "Fitness",
  nutrition:   "Nutrition",
  sleep:       "Sleep",
  mental:      "Mental",
  finance:     "Finance",
  productivity:"Productivity",
  education:   "Education",
  social:      "Social",
  environment: "Environment",
  custom:      "Custom",
  general:     "General",
};

// Central theme delegate — see lib/category-theme.ts. Falls through to the
// legacy palette only for categories the central system doesn't yet cover.
import { categoryTheme as _categoryTheme } from "@/lib/category-theme";
export function getCategoryAccent(category: string): string {
  const direct = TRACKER_CATEGORY_ACCENT[category?.toLowerCase()];
  if (direct) return direct;
  return _categoryTheme(category).hsl;
}

// ── Canonical Category Groups ────────────────────────────────────────────────
// CANONICAL_GROUP_MAP + getCanonicalGroup + computeHealthScore live in
// @/lib/tracker-health (extracted 2026-07-08) so the eagerly-loaded hub KPI
// strip can classify trackers without pulling this page chunk. Only the
// icon/accent presentation metadata (CANONICAL_GROUPS below) stays here.
import { getCanonicalGroup, computeHealthScore } from "@/lib/tracker-health";

// Canonical group definitions with icons and accents
const CANONICAL_GROUPS: Record<string, {
  icon: any;
  accent: string;
  description: string;
  order: number;
  connectedGroups?: string[]; // groups this one shares data relationships with
}> = {
  "Health":             { icon: HeartPulse, accent: "173 60% 44%", description: "Vitals, sleep, nutrition, mental", order: 1, connectedGroups: ["Fitness"] },
  "Fitness":            { icon: Dumbbell,   accent: "25 85% 55%",  description: "Exercise, workouts, performance",  order: 2, connectedGroups: ["Health"] },
  "Finance":            { icon: TrendingUp, accent: "43 85% 52%",  description: "Spending, saving, investing",       order: 3 },
  "Habits & Routines":  { icon: Flame,      accent: "155 60% 44%", description: "Daily habits and routines",         order: 4, connectedGroups: ["Health", "Fitness"] },
  "Productivity":       { icon: Target,     accent: "262 65% 62%", description: "Work, learning, focus",             order: 5 },
  "Medication":         { icon: Pill,       accent: "340 70% 55%", description: "Medications, supplements, prescriptions", order: 0 },
  "Mental & Wellness":  { icon: Brain,      accent: "280 60% 55%", description: "Mood, meditation, anxiety, stress",  order: 4.5 },
  "Lifestyle":          { icon: TreePine,   accent: "120 45% 45%", description: "Pets, reading, screen time, social", order: 5.5 },
  "Other":              { icon: Box,        accent: "240 20% 60%", description: "Custom and uncategorized",          order: 7 },
};


// Emoji icon for each canonical category group
const CATEGORY_GROUP_EMOJI: Record<string, string> = {
  "Health": "🏥",
  "Fitness": "🏋️",
  "Medication": "💊",
  "Nutrition": "🍎",
  "Mental & Wellness": "🧠",
  "Finance": "💰",
  "Habits & Routines": "🔥",
  "Productivity": "🎯",
  "Lifestyle": "🌿",
  "Other": "📊",
};

function categoryGroupEmoji(group: string): string {
  return CATEGORY_GROUP_EMOJI[group] || "📊";
}

// ── DocInlinePreview ───────────────────────────────────────────────────
// Fetches file data with auth then renders inline (img/PDF/etc)
function DocInlinePreview({ docId, mimeType, name, onOpen }: {
  docId: string; mimeType: string; name: string; onOpen: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    setLoading(true); setError(false); setBlobUrl(null);
    // apiRequest goes through the auth interceptor — sends Authorization header
    apiRequest('GET', `/api/documents/${docId}/file`)
      .then(res => res.blob())
      .then(blob => {
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [docId]);

  const isImg = mimeType?.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  return (
    <div className="border-t border-border/50 bg-muted/20 p-2">
      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {!loading && error && (
        <div className="flex flex-col items-center py-5 gap-2">
          <FileText className="h-8 w-8 text-muted-foreground/30" />
          <p className="text-xs text-muted-foreground">Could not load preview</p>
          <Button size="sm" variant="outline" className="text-xs gap-1.5" onClick={onOpen}>
            <Eye className="h-3.5 w-3.5" /> Open Full View
          </Button>
        </div>
      )}
      {!loading && !error && blobUrl && (
        isImg ? (
          <img src={blobUrl} alt={name} className="w-full rounded-lg object-contain max-h-80" />
        ) : isPdf ? (
          <div className="rounded-lg overflow-hidden">
            <iframe src={blobUrl} title={name} className="w-full rounded-lg border-0" style={{ height: '420px' }} />
          </div>
        ) : (
          <div className="flex flex-col items-center py-5 gap-2">
            <FileText className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">{name}</p>
            <Button size="sm" variant="outline" className="text-xs gap-1.5" onClick={onOpen}>
              <Eye className="h-3.5 w-3.5" /> Open Full View
            </Button>
          </div>
        )
      )}
    </div>
  );
}

// ── Cross-Group Connection Panel ──────────────────────────────────────────────
// Shows mini sparklines of trackers from a connected group,
// visualizing cross-category relationships (e.g. sleep vs fitness performance)
function CrossGroupPanel({ fromGroup, allTrackers, onSelectTracker }: {
  fromGroup: string;
  allTrackers: Tracker[];
  onSelectTracker: (t: Tracker) => void;
}) {
  const def = CANONICAL_GROUPS[fromGroup];
  if (!def?.connectedGroups?.length) return null;

  const connected = def.connectedGroups
    .map(g => ({
      groupName: g,
      def: CANONICAL_GROUPS[g],
      trackers: allTrackers.filter(t => getCanonicalGroup(t.category) === g).slice(0, 4),
    }))
    .filter(c => c.trackers.length > 0);

  if (connected.length === 0) return null;

  return (
    <div className="mt-3 rounded-xl border border-border/40 bg-muted/20 overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border/30">
        <Link2 className="h-3 w-3 text-muted-foreground/60" />
        <span className="micro-label text-muted-foreground/60">Connected Categories</span>
      </div>
      {connected.map(({ groupName, def: gDef, trackers: gTrackers }) => (
        <div key={groupName} className="px-3 py-2">
          <div className="flex items-center gap-1.5 mb-2">
            {gDef && <gDef.icon className="h-3 w-3" style={{ color: `hsl(${gDef.accent})` }} />}
            <span className="text-xs font-semibold" style={{ color: `hsl(${gDef?.accent})` }}>{groupName}</span>
            <span className="text-[9px] text-muted-foreground/50 ml-1">{gDef?.description}</span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {gTrackers.map(t => {
              const recentEntries = (t.entries || []).slice(-14);
              const vals = recentEntries
                .map(e => { const keys = Object.keys(e.values || {}); return keys.length ? e.values[keys[0]] : null; })
                .filter((v): v is number => typeof v === 'number');
              const latest = vals[vals.length - 1];
              const sparkMax = Math.max(...vals, 1);
              const sparkMin = Math.min(...vals, 0);
              const sparkRange = sparkMax - sparkMin || 1;
              const tAccent = TRACKER_CATEGORY_ACCENT[t.category?.toLowerCase()] || gDef?.accent || '240 20% 60%';
              return (
                <button
                  key={t.id}
                  onClick={() => onSelectTracker(t)}
                  className="bubble relative p-2 text-left hover:bg-muted/40 active:scale-[0.98] transition-all overflow-hidden"
                >
                  <div className="absolute left-0 top-0 bottom-0 w-0.5" style={{ background: `hsl(${tAccent})` }} />
                  <div className="pl-1.5">
                    <p className="text-[10px] font-semibold truncate text-foreground/80">{t.name}</p>
                    {latest != null && (
                      <p className="text-xs font-bold tabular-nums" style={{ color: `hsl(${tAccent})` }}>
                        {typeof latest === 'number' ? (latest % 1 === 0 ? latest : latest.toFixed(1)) : latest}
                        {t.fields?.[0]?.unit ? ` ${t.fields[0].unit}` : ''}
                      </p>
                    )}
                    {/* Mini sparkline */}
                    {vals.length > 1 && (
                      <svg width="100%" height="16" viewBox={`0 0 ${vals.length * 6} 16`} preserveAspectRatio="none" className="mt-0.5 opacity-60">
                        <polyline
                          points={vals.map((v, i) => `${i * 6},${16 - ((v - sparkMin) / sparkRange) * 14}`).join(' ')}
                          fill="none" stroke={`hsl(${tAccent})`} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Time Range Filter ──────────────────────────────────────────────────────────

type TimeRange = "7d" | "30d" | "90d" | "all";

/** Strip " - ProfileName" suffix from tracker display names.
 *  The owner badge already shows who it belongs to, so the suffix is redundant. */
function cleanTrackerName(name: string, profiles?: { id: string; name: string }[], linkedProfiles?: string[]): string {
  if (!profiles || !linkedProfiles) return name;
  for (const pid of linkedProfiles) {
    const p = profiles.find(pr => pr.id === pid);
    if (p) {
      const suffix = new RegExp(`\\s*-\\s*${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
      const cleaned = name.replace(suffix, '');
      if (cleaned !== name) return cleaned;
    }
  }
  return name;
}

function filterEntriesByRange(entries: TrackerEntry[], range: TimeRange): TrackerEntry[] {
  if (range === "all") return entries;
  const now = Date.now();
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return entries.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
}

// ── ComputedBadges ─────────────────────────────────────────────────────────────

function ComputedBadges({ computed }: { computed?: ComputedData }) {
  if (!computed) return null;
  const badges: { label: string; color: string }[] = [];

  if (computed.caloriesBurned) badges.push({ label: `${computed.caloriesBurned} cal`, color: "bg-orange-500/10 text-orange-600 dark:text-orange-400" });
  if (computed.pace) badges.push({ label: computed.pace, color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" });
  if (computed.heartRateZone) badges.push({ label: computed.heartRateZone.replace("_", " "), color: "bg-red-500/10 text-red-600 dark:text-red-400" });
  if (computed.intensity) badges.push({ label: computed.intensity, color: "bg-purple-500/10 text-purple-600 dark:text-purple-400" });
  if (computed.caloriesConsumed) badges.push({ label: `${computed.caloriesConsumed} kcal`, color: "bg-green-500/10 text-green-600 dark:text-green-400" });
  if (computed.macros) badges.push({ label: `P:${computed.macros.protein}g C:${computed.macros.carbs}g F:${computed.macros.fat}g`, color: "bg-teal-500/10 text-teal-600 dark:text-teal-400" });
  if (computed.sleepQuality) badges.push({ label: `${computed.sleepQuality} sleep`, color: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" });
  if (computed.bloodPressureCategory) badges.push({ label: computed.bloodPressureCategory.replace(/_/g, " "), color: "bg-rose-500/10 text-rose-600 dark:text-rose-400" });
  if (computed.bmi) badges.push({ label: `BMI ${computed.bmi}`, color: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400" });

  if (badges.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {badges.map(b => (
        <span key={b.label} className={`text-xs px-1.5 py-0.5 rounded-md font-medium capitalize ${b.color}`}>
          {b.label}
        </span>
      ))}
    </div>
  );
}

// ── Chart Tooltip ──────────────────────────────────────────────────────────────

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "8px",
  fontSize: "12px",
  color: "hsl(var(--foreground))",
};

// ── Stats Row ──────────────────────────────────────────────────────────────────

function StatsRow({ entries, primaryField, unit, isBP }: { entries: TrackerEntry[]; primaryField: string; unit?: string; isBP?: boolean }) {
  // Blood pressure: show systolic/diastolic format
  if (isBP) {
    const bpEntries = entries.map(e => ({
      s: (e.values["systolic"] ?? e.values["systolic_pressure"] ?? e.values["sbp"]) as number | undefined,
      d: (e.values["diastolic"] ?? e.values["diastolic_pressure"] ?? e.values["dbp"]) as number | undefined,
    })).filter(v => typeof v.s === "number" && typeof v.d === "number") as { s: number; d: number }[];
    if (bpEntries.length === 0) return null;
    const latest = bpEntries[bpEntries.length - 1];
    const avgS = Math.round(bpEntries.reduce((a, b) => a + b.s, 0) / bpEntries.length);
    const avgD = Math.round(bpEntries.reduce((a, b) => a + b.d, 0) / bpEntries.length);
    const stats = [
      { label: "Latest", value: `${latest.s}/${latest.d}` },
      { label: "Avg", value: `${avgS}/${avgD}` },
      { label: "High", value: `${Math.max(...bpEntries.map(e => e.s))}/${Math.max(...bpEntries.map(e => e.d))}` },
      { label: "Low", value: `${Math.min(...bpEntries.map(e => e.s))}/${Math.min(...bpEntries.map(e => e.d))}` },
      { label: "Entries", value: String(entries.length) },
    ];
    return (
      <div className="grid grid-cols-5 gap-1 mt-3" data-testid="stats-row">
        {stats.map((s) => (
          <div key={s.label} className="text-center rounded-md bg-muted/40 px-1.5 py-1.5">
            <div className="text-xs text-muted-foreground">{s.label}</div>
            <div className="text-xs font-semibold tabular-nums mt-0.5">{s.value}</div>
          </div>
        ))}
      </div>
    );
  }

  const nums = entries
    .map((e) => e.values[primaryField])
    .filter((v): v is number => typeof v === "number");

  if (nums.length === 0) return null;

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  const latest = nums[nums.length - 1];
  const unitLabel = unit ? ` ${unit}` : "";

  const stats = [
    { label: "Min", value: `${min.toFixed(1)}${unitLabel}` },
    { label: "Max", value: `${max.toFixed(1)}${unitLabel}` },
    { label: "Avg", value: `${avg.toFixed(1)}${unitLabel}` },
    { label: "Entries", value: String(entries.length) },
    { label: "Latest", value: `${latest.toFixed(1)}${unitLabel}` },
  ];

  return (
    <div className="grid grid-cols-5 gap-1 mt-3" data-testid="stats-row">
      {stats.map((s) => (
        <div key={s.label} className="text-center rounded-md bg-muted/40 px-1.5 py-1.5">
          <div className="text-xs text-muted-foreground">{s.label}</div>
          <div className="text-xs font-semibold tabular-nums mt-0.5">{s.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Standard Detail Chart ──────────────────────────────────────────────────────

// Reference "normal" range for a measurement metric, so a heart-rate / glucose
// / temperature chart shows a healthy band instead of a bare line.
function measurementZone(field: string): { low: number; high: number; label: string } | null {
  const f = String(field || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/(heartrate|^hr$|bpm|pulse)/.test(f)) return { low: 60, high: 100, label: "Normal resting" };
  if (/(glucose|bloodsugar|bloodglucose)/.test(f)) return { low: 70, high: 140, label: "Normal" };
  if (/(spo2|oxygen)/.test(f)) return { low: 95, high: 100, label: "Normal" };
  if (/(temperature|temp)/.test(f)) return { low: 97, high: 99, label: "Normal" };
  if (/(systolic)/.test(f)) return { low: 90, high: 120, label: "Normal" };
  if (/(diastolic)/.test(f)) return { low: 60, high: 80, label: "Normal" };
  return null;
}

function StandardDetailChart({
  entries,
  primaryField,
  unit,
  goalValue,
}: {
  entries: TrackerEntry[];
  primaryField: string;
  unit?: string;
  goalValue?: number;
}) {
  const chartData = entries.map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value: typeof e.values[primaryField] === "number" ? (e.values[primaryField] as number) : null,
  }));

  // A single data point can't form a trend — drawing a line/area for it renders
  // as a misleading vertical streak across the whole panel. Show the reading +
  // a nudge instead, so a brand-new tracker looks intentional, not broken.
  const realPoints = chartData.filter((d) => typeof d.value === "number");
  if (realPoints.length < 2) {
    const v = realPoints[realPoints.length - 1]?.value;
    return (
      <div className="h-[200px] flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        {typeof v === "number" ? (
          <>
            <p className="text-3xl font-bold tabular-nums">{v}{unit ? <span className="text-base font-normal text-muted-foreground ml-1">{unit}</span> : null}</p>
            <p className="text-xs text-muted-foreground mt-1">Your first reading{realPoints.length === 1 ? "" : "s"} — log a few more and a trend line appears here.</p>
          </>
        ) : (
          <>
            <BarChart2 className="h-7 w-7 text-muted-foreground/30 mb-2" />
            <p className="text-sm text-muted-foreground">No numeric data yet — tap “+ Add” to log one.</p>
          </>
        )}
      </div>
    );
  }
  // Append a "today" sentinel point with a null value so the X-axis extends
  // to the current date even when the most recent entry is days/weeks old.
  // Without this the axis terminates at the last entry date and the user is
  // shown a stale-looking range (e.g. "Apr 29 → May 5" when today is May 20).
  (() => {
    const todayLabel = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (chartData.length === 0 || chartData[chartData.length - 1].date !== todayLabel) {
      chartData.push({ date: todayLabel, value: null });
    }
  })();

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
        {(() => {
          const z = measurementZone(primaryField);
          return z ? (
            <ReferenceArea
              y1={z.low} y2={z.high} fill="#10b981" fillOpacity={0.08} strokeOpacity={0}
              label={{ value: z.label, position: "insideTopRight", fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
            />
          ) : null;
        })()}
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          allowDuplicatedCategory={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          domain={["auto", "auto"]}
          width={36}
          tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`}
        />
        <Tooltip contentStyle={tooltipStyle} />
        {goalValue !== undefined && (
          <ReferenceLine
            y={goalValue}
            stroke={CHART_COLORS.gold}
            strokeDasharray="4 4"
            label={{ value: "Goal", position: "right", fontSize: 10, fill: CHART_COLORS.gold }}
          />
        )}
        <Line
          type="monotone"
          dataKey="value"
          stroke={CHART_COLORS.primary}
          strokeWidth={2}
          dot={{ r: 3, fill: CHART_COLORS.primary }}
          activeDot={{ r: 5 }}
          connectNulls
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Weight / BMI Chart ─────────────────────────────────────────────────────────

function WeightDetailChart({
  entries,
  primaryField,
  unit,
}: {
  entries: TrackerEntry[];
  primaryField: string;
  unit?: string;
}) {
  const chartData = entries.map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    weight: typeof e.values[primaryField] === "number" ? (e.values[primaryField] as number) : null,
    bmi: e.computed?.bmi ?? null,
  }));
  // Append a "today" sentinel point so the X-axis extends to the current date
  // even when the most recent entry is days/weeks old. Without this the axis
  // terminates at the last entry date and the trend looks stale.
  (() => {
    const todayLabel = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (chartData.length === 0 || chartData[chartData.length - 1].date !== todayLabel) {
      chartData.push({ date: todayLabel, weight: null, bmi: null });
    }
  })();

  return (
    <div className="space-y-3">
      {/* Weight line chart */}
      <div>
        <p className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wide">Weight Trend</p>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
            <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} width={40} tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="weight" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name={`Weight${unit ? ` (${unit})` : ""}`} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* BMI trend with normal range shading */}
      {chartData.some((d) => d.bmi !== null) && (
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wide">BMI Trend</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[14, 35]} width={28} />
              <Tooltip contentStyle={tooltipStyle} />
              {/* Normal BMI range shading: 18.5 – 25 */}
              <ReferenceArea y1={18.5} y2={25} fill="#20808D" fillOpacity={0.08} />
              <ReferenceLine y={18.5} stroke={CHART_COLORS.primary} strokeDasharray="4 3" label={{ value: "18.5", fontSize: 9, fill: CHART_COLORS.primary }} />
              <ReferenceLine y={25} stroke={CHART_COLORS.gold} strokeDasharray="4 3" label={{ value: "25", fontSize: 9, fill: CHART_COLORS.gold }} />
              <ReferenceLine y={30} stroke={CHART_COLORS.secondary} strokeDasharray="4 3" label={{ value: "30", fontSize: 9, fill: CHART_COLORS.secondary }} />
              <Line type="monotone" dataKey="bmi" stroke={CHART_COLORS.tertiary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.tertiary }} activeDot={{ r: 5 }} connectNulls name="BMI" />
            </LineChart>
          </ResponsiveContainer>
          <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.primary }} className="inline-block w-2 h-2 rounded-sm opacity-40" />Normal (18.5–25)</span>
            <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.gold }} className="inline-block w-2 h-2 rounded-sm opacity-70" />Overweight (25–30)</span>
            <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.secondary }} className="inline-block w-2 h-2 rounded-sm opacity-70" />Obese (30+)</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Blood Pressure Chart ───────────────────────────────────────────────────────

function BloodPressureDetailChart({ entries }: { entries: TrackerEntry[] }) {
  const chartData = entries.map((e) => {
    const systolic = e.values["systolic"] ?? e.values["systolic_pressure"] ?? e.values["sbp"] ?? null;
    const diastolic = e.values["diastolic"] ?? e.values["diastolic_pressure"] ?? e.values["dbp"] ?? null;
    // Try to find numeric fields automatically if named fields not found
    const numericVals = Object.values(e.values).filter((v) => typeof v === "number") as number[];
    return {
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      systolic: systolic !== null ? Number(systolic) : numericVals[0] ?? null,
      diastolic: diastolic !== null ? Number(diastolic) : numericVals[1] ?? null,
      category: e.computed?.bloodPressureCategory ?? null,
    };
  });

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
          <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[50, 180]} width={32} />
          <Tooltip contentStyle={tooltipStyle} />
          {/* Color zones */}
          <ReferenceArea y1={50} y2={120} fill="#20808D" fillOpacity={0.05} label={{ value: "Normal", position: "insideTopLeft", fontSize: 9, fill: CHART_COLORS.primary, dy: 4 }} />
          <ReferenceArea y1={120} y2={130} fill="#FFC553" fillOpacity={0.12} />
          <ReferenceArea y1={130} y2={180} fill="#A84B2F" fillOpacity={0.07} />
          <ReferenceLine y={120} stroke={CHART_COLORS.gold} strokeDasharray="4 3" label={{ value: "Elevated", fontSize: 9, fill: CHART_COLORS.gold, position: "right" }} />
          <ReferenceLine y={130} stroke={CHART_COLORS.secondary} strokeDasharray="4 3" label={{ value: "High", fontSize: 9, fill: CHART_COLORS.secondary, position: "right" }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="systolic" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.secondary }} activeDot={{ r: 5 }} connectNulls name="Systolic" />
          <Line type="monotone" dataKey="diastolic" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name="Diastolic" />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span style={{ background: "#20808D" }} className="inline-block w-2 h-2 rounded-sm opacity-30" />Normal (&lt;120/80)</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.gold }} className="inline-block w-2 h-2 rounded-sm opacity-60" />Elevated (120–129)</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.secondary }} className="inline-block w-2 h-2 rounded-sm opacity-60" />High (≥130)</span>
      </div>
    </div>
  );
}

// ── Sleep Chart ────────────────────────────────────────────────────────────────

function SleepDetailChart({ entries, primaryField }: { entries: TrackerEntry[]; primaryField: string }) {
  const chartData = entries.map((e) => {
    const rawVal = e.values[primaryField];
    const hours = typeof rawVal === "number" ? rawVal : null;
    const quality = e.computed?.sleepQuality ?? null;
    return {
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      hours,
      qualityScore: quality === "excellent" ? 4 : quality === "good" ? 3 : quality === "fair" ? 2 : quality === "poor" ? 1 : null,
      quality,
    };
  });

  const qualityColor = (q: string | null) => {
    if (q === "excellent") return CHART_COLORS.primary;
    if (q === "good") return CHART_COLORS.tertiary;
    if (q === "fair") return CHART_COLORS.gold;
    return CHART_COLORS.secondary;
  };

  return (
    <div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
          <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, 12]} width={24} />
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value: number, name: string, props: any) => {
              const q = props.payload?.quality;
              return [`${value}h${q ? ` (${q})` : ""}`, "Sleep"];
            }}
          />
          {/* Target sleep zone: 7–8 hours */}
          <ReferenceArea y1={7} y2={8} fill={CHART_COLORS.primary} fillOpacity={0.12} />
          <ReferenceLine y={7} stroke={CHART_COLORS.primary} strokeDasharray="4 3" label={{ value: "7h", fontSize: 9, fill: CHART_COLORS.primary }} />
          <ReferenceLine y={8} stroke={CHART_COLORS.tertiary} strokeDasharray="4 3" label={{ value: "8h", fontSize: 9, fill: CHART_COLORS.tertiary }} />
          <Bar dataKey="hours" radius={[3, 3, 0, 0]} name="Hours slept">
            {chartData.map((entry, index) => (
              <rect key={`bar-${index}`} fill={qualityColor(entry.quality)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.primary }} className="inline-block w-2 h-2 rounded-sm" />Excellent</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.tertiary }} className="inline-block w-2 h-2 rounded-sm" />Good</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.gold }} className="inline-block w-2 h-2 rounded-sm" />Fair</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.secondary }} className="inline-block w-2 h-2 rounded-sm" />Poor</span>
        <span className="flex items-center gap-1"><span style={{ background: CHART_COLORS.primary, opacity: 0.3 }} className="inline-block w-2 h-2 rounded-sm" />Target zone (7–8h)</span>
      </div>
    </div>
  );
}

// ── Running Chart ──────────────────────────────────────────────────────────────

function RunningDetailChart({ entries, primaryField }: { entries: TrackerEntry[]; primaryField: string }) {
  let cumulativeDistance = 0;
  const chartData = entries.map((e) => {
    const dist = e.computed?.distanceMiles ?? null;
    if (dist !== null) cumulativeDistance += dist;
    return {
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      pace: e.computed?.paceSeconds ?? null,
      distance: dist,
      cumulativeDistance: dist !== null ? parseFloat(cumulativeDistance.toFixed(2)) : null,
      calories: e.computed?.caloriesBurned ?? null,
    };
  });

  const paceFormatter = (secs: number) => {
    if (!secs) return "";
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, "0")}/mi`;
  };

  return (
    <div className="space-y-3">
      {/* Pace trend */}
      {chartData.some((d) => d.pace !== null) && (
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wide">Pace Trend (lower = faster)</p>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} width={52} tickFormatter={paceFormatter} reversed />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [paceFormatter(v), "Pace"]} />
              <Line type="monotone" dataKey="pace" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name="Pace" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Cumulative distance */}
      {chartData.some((d) => d.cumulativeDistance !== null) && (
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wide">Cumulative Distance (mi)</p>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, "auto"]} width={32} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} mi`, "Total Distance"]} />
              <defs>
                <linearGradient id="distGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="cumulativeDistance" stroke={CHART_COLORS.primary} strokeWidth={2} fill="url(#distGradient)" connectNulls name="Cumulative Distance" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Calories burned */}
      {chartData.some((d) => d.calories !== null) && (
        <div>
          <p className="text-xs text-muted-foreground font-medium mb-1 uppercase tracking-wide">Calories Burned</p>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, "auto"]} width={32} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v} cal`, "Calories"]} />
              <Bar dataKey="calories" fill={CHART_COLORS.secondary} radius={[3, 3, 0, 0]} name="Calories" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ── Detect Tracker Specialization ─────────────────────────────────────────────

type TrackerSpecialization = "weight" | "bloodpressure" | "sleep" | "running" | "medication" | "standard";

function detectSpecialization(tracker: Tracker): TrackerSpecialization {
  const name = tracker.name.toLowerCase();
  const cat = tracker.category.toLowerCase();
  const fieldNames = (tracker.fields || []).map(f => String(f.name).toLowerCase());
  // A tracker is a medication/supplement if its CATEGORY says so, its FIELDS
  // are dose-shaped (dosage + taken/adherence/drug), or its NAME is a known
  // supplement/drug. This is what makes "Fish Oil"/"Multivitamin" (logged with
  // drug/dosage/taken fields but mis-categorized as custom/health) render with
  // the rich Medication suite instead of a boring empty line chart.
  const hasDoseFields =
    (fieldNames.includes("dosage") || fieldNames.includes("dose")) &&
    (fieldNames.includes("taken") || fieldNames.includes("adherence") ||
     fieldNames.includes("drug") || fieldNames.includes("drugname"));
  const SUPPLEMENT_RE = /\b(fish ?oil|omega|multivitamin|vitamin|creatine|magnesium|zinc|melatonin|probiotic|biotin|collagen|glucosamine|turmeric|ashwagandha|calcium|iron supplement|supplement|softgel|capsule|lozenge|gummy)\b/;
  if (cat === "medication" || cat === "prescription" || cat === "supplement" || hasDoseFields || SUPPLEMENT_RE.test(name)) return "medication";
  if (cat === "health" && name.includes("weight")) return "weight";
  if (name.includes("blood") || name.includes("pressure")) return "bloodpressure";
  if (cat === "sleep") return "sleep";
  if (cat === "fitness" && name.includes("run")) return "running";
  return "standard";
}

// ── Medication Overview Component ─────────────────────────────────────────────
function MedicationOverview({ tracker }: { tracker: Tracker }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = new Date().toLocaleDateString('en-CA');
  const todayEntries = tracker.entries.filter(e => new Date(e.timestamp).toLocaleDateString('en-CA') === today);
  const takenToday = todayEntries.some(e => e.values?.adherence === 'taken' || e.values?.taken === true);

  // Extract medication details from fields defaults or latest entry
  const latestEntry = tracker.entries[tracker.entries.length - 1];
  const getFieldDefault = (name: string) => {
    const field = tracker.fields.find(f => f.name === name);
    return (field as any)?.default || latestEntry?.values?.[name] || '';
  };
  const drugName = getFieldDefault('drug') || getFieldDefault('drugName') || tracker.name;
  // `dosage` is a NUMERIC field (strength), `unit` on that field is the unit
  // (mg). The old code fell back to `tracker.unit` for the VALUE, so a med with
  // no strength set logged `dosage: "mg"` — which the server rejects as a
  // non-numeric value ("Failed to log dose"). Derive a real number for the value
  // and a separate human label for display.
  const dosageField = tracker.fields.find(f => f.name === 'dosage');
  const dosageUnit = (dosageField as any)?.unit || '';
  const rawDosage = getFieldDefault('dosage');
  const dosageNum = (() => {
    if (rawDosage === '' || rawDosage == null) return null;
    const n = parseFloat(String(rawDosage).replace(/[^0-9.]/g, ''));
    return isFinite(n) && /\d/.test(String(rawDosage)) ? n : null;
  })();
  const dosageLabel = dosageNum != null ? `${dosageNum}${dosageUnit ? ` ${dosageUnit}` : ''}` : '';
  const frequency = getFieldDefault('frequency') || '';
  const refillDate = getFieldDefault('refillDate') || '';
  const prescriber = getFieldDefault('prescriber') || '';

  // Build the values for a dose log. Only include `dosage` when it's a real
  // number — never the bare unit — so the numeric-field check can't 400.
  const buildLogValues = () => {
    const v: Record<string, any> = {
      drug: drugName,
      timeTaken: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      adherence: 'taken',
    };
    if (dosageNum != null) v.dosage = dosageNum;
    if (frequency) v.frequency = frequency;
    return v;
  };

  // Log dose mutation — optimistic so the "Taken today" badge flips instantly
  // and the day count rolls up before the network round-trip completes.
  const logDoseMut = useMutation<any, Error, void, { prev: [readonly unknown[], unknown][]; tempId: string }>({
    mutationFn: () => apiRequest('POST', `/api/trackers/${tracker.id}/entries`, {
      values: buildLogValues(),
      notes: `Dose taken at ${new Date().toLocaleTimeString()}`
    }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ['/api/trackers'] });
      const prev = qc.getQueriesData({ queryKey: ['/api/trackers'] });
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const nowIso = new Date().toISOString();
      const tempEntry: any = {
        id: tempId,
        trackerId: tracker.id,
        timestamp: nowIso,
        values: buildLogValues(),
        notes: `Dose taken at ${new Date().toLocaleTimeString()}`,
        _optimistic: true,
      };
      // Inject the new entry into every cached tracker list that contains this
      // tracker so all surfaces (page, dashboard hero) update at the same time.
      qc.setQueriesData({ queryKey: ['/api/trackers'] }, (old: any) => {
        if (!old) return old;
        if (Array.isArray(old)) {
          return old.map((t: any) => t?.id === tracker.id
            ? { ...t, entries: Array.isArray(t.entries) ? [tempEntry, ...t.entries] : [tempEntry] }
            : t);
        }
        if (old && typeof old === 'object' && old.id === tracker.id) {
          return { ...old, entries: Array.isArray(old.entries) ? [tempEntry, ...old.entries] : [tempEntry] };
        }
        return old;
      });
      return { prev, tempId };
    },
    onSuccess: () => {
      // BUG-T05/UI01: refetchType:"all" so the count badge updates even when
      // the page-level trackers query is technically inactive at the moment.
      // (The bus uses "active", so this one key keeps its stronger refetch.)
      qc.invalidateQueries({ queryKey: ['/api/trackers'], refetchType: "all" });
      // Cache bus: ripples to stats, dashboard, goals, activity, insights.
      invalidateDomain("trackers");
      toast({ title: `${drugName} logged`, description: `${dosageLabel ? `${dosageLabel} ` : ''}taken at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` });
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) qc.setQueryData(key, data); }
      toast({ title: 'Failed to log dose', variant: 'destructive' });
    },
  });

  // Adherence this week
  const weekAgo = Date.now() - 7 * 86400000;
  const weekEntries = tracker.entries.filter(e => new Date(e.timestamp).getTime() > weekAgo);
  const weekTaken = weekEntries.filter(e => e.values?.adherence === 'taken' || e.values?.taken === true).length;
  const adherencePct = weekEntries.length > 0 ? Math.round((weekTaken / Math.max(7, weekEntries.length)) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Medication Card */}
      <div className="rounded-xl border border-border/60 bg-gradient-to-br from-rose-500/10 via-transparent to-pink-500/5 p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Pill className="h-5 w-5 text-rose-500" />
              <h3 className="font-bold text-lg">{drugName}</h3>
            </div>
            {dosageLabel && <p className="text-sm text-muted-foreground mt-1">Dosage: <span className="font-medium text-foreground">{dosageLabel}</span></p>}
            {frequency && <p className="text-sm text-muted-foreground">Frequency: <span className="font-medium text-foreground">{frequency}</span></p>}
            {prescriber && <p className="text-sm text-muted-foreground">Prescriber: <span className="font-medium text-foreground">{prescriber}</span></p>}
            {refillDate && <p className="text-sm text-muted-foreground">Refill: <span className="font-medium text-foreground">{refillDate}</span></p>}
          </div>
          {/* Today's status badge */}
          <div className={`px-3 py-1.5 rounded-full text-xs font-bold ${
            takenToday ? 'bg-green-500/20 text-green-500' : 'bg-amber-500/20 text-amber-500'
          }`}>
            {takenToday ? '✓ Taken today' : 'Not taken yet'}
          </div>
        </div>
      </div>

      {/* Quick Log Button */}
      {!takenToday && (
        <button
          onClick={() => logDoseMut.mutate()}
          disabled={logDoseMut.isPending}
          className="w-full py-3 rounded-xl bg-rose-500 hover:bg-rose-600 active:bg-rose-700 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2"
        >
          <Pill className="h-4 w-4" />
          {logDoseMut.isPending ? 'Logging...' : `Log ${dosageLabel ? `${dosageLabel} ` : ''}${drugName} Now`}
        </button>
      )}

      {/* Weekly Adherence */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Adherence</p>
          <p className="text-2xl font-bold tabular-nums">{adherencePct}%</p>
          <p className="text-xs text-muted-foreground">this week</p>
        </div>
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Doses Logged</p>
          <p className="text-2xl font-bold tabular-nums">{tracker.entries.length}</p>
          <p className="text-xs text-muted-foreground">total</p>
        </div>
      </div>

      {/* 7-day adherence strip */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Last 7 Days</p>
        <div className="flex gap-1">
          {Array.from({ length: 7 }).map((_, i) => {
            const d = new Date();
            d.setDate(d.getDate() - (6 - i));
            const dateStr = d.toLocaleDateString('en-CA');
            const dayEntries = tracker.entries.filter(e => new Date(e.timestamp).toLocaleDateString('en-CA') === dateStr);
            const taken = dayEntries.some(e => e.values?.adherence === 'taken' || e.values?.taken === true);
            const dayLabel = d.toLocaleDateString('en-US', { weekday: 'narrow' });
            return (
              <div key={i} className="flex-1 text-center">
                <div className={`h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                  taken ? 'bg-green-500/20 text-green-500' : dateStr === today ? 'bg-amber-500/15 text-amber-500 border border-amber-500/30' : 'bg-muted/50 text-muted-foreground/40'
                }`}>
                  {taken ? '✓' : dateStr === today ? '•' : '–'}
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">{dayLabel}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Entries */}
      {tracker.entries.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Recent Doses</p>
          <div className="space-y-1.5">
            {tracker.entries.slice(-5).reverse().map((e, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/30 text-sm">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${e.values?.adherence === 'taken' || e.values?.taken ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span>{(() => {
                    const d = e.values?.dosage;
                    const num = typeof d === 'number' ? d : (d != null && /\d/.test(String(d)) ? parseFloat(String(d).replace(/[^0-9.]/g, '')) : null);
                    if (num != null && isFinite(num)) return `${num}${dosageUnit ? ` ${dosageUnit}` : ''}`;
                    return e.values?.drug || drugName || 'Dose taken';
                  })()}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {e.values?.timeTaken || new Date(e.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  {' · '}
                  {new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Expanded Detail View ───────────────────────────────────────────────────────

function ExpandedDetailView({
  tracker,
  primaryField,
}: {
  tracker: Tracker;
  primaryField: string;
}) {
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const specialization = detectSpecialization(tracker);

  const filteredEntries = filterEntriesByRange(tracker.entries, timeRange);

  const timeRangeBtns: { label: string; value: TimeRange }[] = [
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
    { label: "All", value: "all" },
  ];

  // Find goal value from fields if any field is named "goal"
  const goalField = tracker.fields.find((f) => f.name.toLowerCase().includes("goal"));
  const goalValue = goalField
    ? (tracker.entries[tracker.entries.length - 1]?.values[goalField.name] as number | undefined)
    : undefined;

  return (
    <div className="mt-3 border-t pt-3 space-y-3" data-testid={`expanded-detail-${tracker.id}`}>
      {/* Time range filter */}
      <div className="flex items-center gap-1" data-testid={`timerange-filter-${tracker.id}`}>
        {timeRangeBtns.map((btn) => (
          <button
            key={btn.value}
            className={`px-2.5 py-0.5 rounded text-xs-loose font-medium transition-colors ${
              timeRange === btn.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            onClick={() => setTimeRange(btn.value)}
            data-testid={`timerange-btn-${btn.value}-${tracker.id}`}
          >
            {btn.label}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">
          {filteredEntries.length} entries
        </span>
      </div>

      {filteredEntries.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">No entries in this range</p>
      ) : (
        <>
          {/* Specialized or standard chart */}
          {specialization === "weight" && (
            <WeightDetailChart entries={filteredEntries} primaryField={primaryField} unit={tracker.unit} />
          )}
          {specialization === "bloodpressure" && (
            <BloodPressureDetailChart entries={filteredEntries} />
          )}
          {specialization === "sleep" && (
            <SleepDetailChart entries={filteredEntries} primaryField={primaryField} />
          )}
          {specialization === "running" && (
            <RunningDetailChart entries={filteredEntries} primaryField={primaryField} />
          )}
          {specialization === "standard" && (
            <StandardDetailChart
              entries={filteredEntries}
              primaryField={primaryField}
              unit={tracker.unit}
              goalValue={goalValue}
            />
          )}

          {/* Stats row */}
          <StatsRow entries={filteredEntries} primaryField={primaryField} unit={tracker.unit} isBP={specialization === "bloodpressure"} />
        </>
      )}
    </div>
  );
}

// ── AddEntryDialog ─────────────────────────────────────────────────────────────

function AddEntryDialog({
  tracker,
  open,
  onOpenChange,
}: {
  tracker: Tracker;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, any>>({});
  const [notes, setNotes] = useState("");
  // Ad-hoc fields the user adds that aren't part of the tracker's schema — same
  // "add any field" power the per-entry editor has.
  const [customFields, setCustomFields] = useState<Record<string, any>>({});
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  const addCustomField = () => {
    const name = newFieldName.trim();
    if (!name) return;
    const raw = newFieldValue.trim();
    const num = Number(raw);
    const val = raw !== "" && !isNaN(num) && String(num) === raw ? num : newFieldValue;
    setCustomFields((p) => ({ ...p, [name]: val }));
    setNewFieldName("");
    setNewFieldValue("");
  };
  const removeCustomField = (k: string) =>
    setCustomFields((p) => { const n = { ...p }; delete n[k]; return n; });
  // FLUSH a pending "add a field" the user typed but didn't tap "+ Add" on — so
  // hitting "Log Entry" never silently drops it (same fix as the per-entry editor).
  const collectCustomFields = (): Record<string, any> => {
    const out = { ...customFields };
    const pn = newFieldName.trim();
    if (pn) {
      const raw = newFieldValue.trim();
      const num = Number(raw);
      out[pn] = raw !== "" && !isNaN(num) && String(num) === raw ? num : newFieldValue;
    }
    return out;
  };

  // RACE FIX (user report: entry logging failed on a filled form): the submit
  // called mutate() then synchronously reset values/notes; React Query re-reads
  // the mutationFn closure after that reset re-render, so it coerced an EMPTY
  // form. The coerced payload is now built by buildEntryPayload() in the click
  // handler and passed as mutation VARIABLES — immune to the reset.
  const buildEntryPayload = (): { values: Record<string, any>; notes?: string } => {
    const coerced: Record<string, any> = {};
    for (const f of tracker.fields) {
      const raw = values[f.name];
      if (f.type === "number") coerced[f.name] = raw !== undefined && raw !== "" ? parseFloat(raw) : undefined;
      else if (f.type === "boolean") coerced[f.name] = raw === true || raw === "true";
      else coerced[f.name] = raw ?? "";
    }
    // Merge any ad-hoc custom fields the user added (including a pending one).
    for (const [k, v] of Object.entries(collectCustomFields())) coerced[k] = v;
    return { values: coerced, notes: notes.trim() || undefined };
  };
  const mutation = useMutation<any, Error, { values: Record<string, any>; notes?: string }>({
    mutationFn: async (vars) => {
      const coerced = vars.values;
      // Prevent empty entries
      const hasValue = Object.values(coerced).some(v => v !== undefined && v !== "" && v !== null);
      if (!hasValue) throw new Error("Please fill in at least one field");
      // Reject negative numeric values
      const hasNegative = Object.values(coerced).some(v => typeof v === "number" && v < 0);
      if (hasNegative) throw new Error("Values must be positive numbers");
      // Reject NaN values
      const hasNaN = Object.values(coerced).some(v => typeof v === "number" && isNaN(v));
      if (hasNaN) throw new Error("All fields must be valid numbers");
      const res = await apiRequest("POST", `/api/trackers/${tracker.id}/entries`, {
        values: coerced,
        notes: vars.notes,
      });
      return res.json();
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/trackers"] });
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tempEntry = { id: tempId, values: vars.values, notes: vars.notes, timestamp: new Date().toISOString(), computed: {} };
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
        (old || []).map((t: any) => t.id === tracker.id
          ? { ...t, entries: [...(t.entries || []), tempEntry] }
          : t
        )
      );
      return { prev, tempId };
    },
    onSuccess: (created: any, _vars, ctx: any) => {
      // Swap the optimistic temp entry for the real server entry (real id) so
      // deleting it right away works before the background refetch settles.
      if (created?.id && ctx?.tempId) {
        queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
          (old || []).map((t: any) => t.id === tracker.id
            ? { ...t, entries: (t.entries || []).map((e: any) => e?.id === ctx.tempId ? { ...e, ...created } : e) }
            : t
          )
        );
      }
      setValues({});
      setNotes("");
      setCustomFields({});
      setNewFieldName("");
      setNewFieldValue("");
      onOpenChange(false);
      toast({ title: "Entry logged", description: `Added entry to ${tracker.name}` });
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to log entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // BUG-T05/UI01: force a network refetch so the entry count badge (which
      // reads tracker.entries.length straight from the cached list) updates
      // immediately after a log. The default invalidate only marks queries as
      // stale — inactive list queries on the trackers page wouldn't refetch
      // until the user re-focused the page, leaving "3 entries" stuck while the
      // newest entry was already on the server. (Bus uses "active" — keep this
      // one key at "all"; the bus handles the cross-surface ripple.)
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"], refetchType: "all" });
      invalidateDomain("trackers");
    },
  });

  const handleClose = () => {
    setValues({});
    setNotes("");
    setCustomFields({});
    setNewFieldName("");
    setNewFieldValue("");
    onOpenChange(false);
  };

  // Kind-aware one-tap logging. Additive trackers (water, minutes) get +amount
  // chips; categorical (mood/rating) gets a 1–N picker. Both log instantly.
  const pres = classifyTrackerPresentation(tracker as any);
  const quickField = pres.primaryField;
  const quickInc: number[] = (() => {
    if (pres.metricKind === "categorical") return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const u = (pres.unit || "").toLowerCase();
    if (/oz|ounce/.test(u)) return [8, 12, 16, 24];
    if (/cup|glass/.test(u)) return [1, 2, 3];
    if (/ml/.test(u)) return [250, 500, 750];
    if (/^l$|liter|litre/.test(u)) return [0.25, 0.5, 1];
    if (/min/.test(u)) return [10, 20, 30, 45];
    if (/mi|km|step/.test(u)) return [1, 2, 5];
    if (/cal/.test(u)) return [100, 250, 500];
    return [1, 5, 10];
  })();
  const quickLog = useMutation<any, Error, number, { prev: [readonly unknown[], unknown][]; tempId: string }>({
    mutationFn: async (amount: number) => {
      const res = await apiRequest("POST", `/api/trackers/${tracker.id}/entries`, { values: { [quickField as string]: amount } });
      return res.json();
    },
    onMutate: async (amount) => {
      // Optimistic insert so the entry/count paints immediately (same pattern
      // as the full entry form above).
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/trackers"] });
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tempEntry = { id: tempId, values: { [quickField as string]: amount }, timestamp: new Date().toISOString(), computed: {} };
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
        (old || []).map((t: any) => t.id === tracker.id
          ? { ...t, entries: [...(t.entries || []), tempEntry] }
          : t
        )
      );
      return { prev, tempId };
    },
    onSuccess: (created, amount, ctx) => {
      // Swap the temp entry for the real server row.
      if (created?.id && ctx?.tempId) {
        queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
          (old || []).map((t: any) => t.id === tracker.id
            ? { ...t, entries: (t.entries || []).map((e: any) => e?.id === ctx.tempId ? { ...e, ...created } : e) }
            : t
          )
        );
      }
      toast({ title: pres.metricKind === "categorical" ? `Logged ${amount}` : `+${amount}${pres.unit ? " " + pres.unit : ""} logged` });
      onOpenChange(false);
    },
    onError: (err, _amount, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to log", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      // BUG-T05/UI01 (see entry form above): trackers key stays at "all".
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"], refetchType: "all" });
      invalidateDomain("trackers");
    },
  });
  const showQuick = !!quickField && (pres.metricKind === "additive" || pres.metricKind === "categorical");

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent data-testid={`dialog-add-entry-${tracker.id}`}>
        <DialogHeader>
          <DialogTitle>Log Entry: {tracker.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {showQuick && (
            <div>
              <Label className="text-xs font-medium text-muted-foreground">
                {pres.metricKind === "categorical" ? "Quick rate" : "Quick add"}
              </Label>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {quickInc.map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={quickLog.isPending}
                    onClick={() => quickLog.mutate(n)}
                    className="px-3 py-1.5 rounded-full border border-primary/40 text-primary text-sm font-medium hover:bg-primary/10 active:scale-95 transition-all disabled:opacity-50"
                    data-testid={`quick-log-${n}`}
                  >
                    {pres.metricKind === "categorical" ? n : `+${n}${pres.unit ? ` ${pres.unit}` : ""}`}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">One tap to log · or fill the form below for details.</p>
            </div>
          )}
          {tracker.fields.map((f) => (
            <div key={f.name}>
              <Label className="text-xs font-medium text-muted-foreground">
                {trackerFieldLabel(f)}
                {(f.unit || tracker.unit) ? ` (${f.unit || tracker.unit})` : ""}
              </Label>
              {f.type === "number" && (
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                  onKeyDown={(e) => { if (['e','E','+','-'].includes(e.key)) e.preventDefault(); }}
                  placeholder={`Enter ${trackerFieldLabel(f).toLowerCase()}`}
                  className="mt-1"
                  data-testid={`input-entry-${f.name}`}
                />
              )}
              {f.type === "text" && (
                <Input
                  type="text"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                  placeholder={`Enter ${trackerFieldLabel(f).toLowerCase()}`}
                  className="mt-1"
                  data-testid={`input-entry-${f.name}`}
                />
              )}
              {f.type === "boolean" && (
                <div className="flex items-center gap-2 mt-1">
                  <Checkbox
                    id={`check-${f.name}`}
                    checked={!!values[f.name]}
                    onCheckedChange={(v) => setValues((p) => ({ ...p, [f.name]: v }))}
                    data-testid={`checkbox-entry-${f.name}`}
                  />
                  <label htmlFor={`check-${f.name}`} className="text-sm">
                    {trackerFieldLabel(f)}
                  </label>
                </div>
              )}
              {f.type === "select" && f.options && (
                <Select
                  value={values[f.name] ?? ""}
                  onValueChange={(v) => setValues((p) => ({ ...p, [f.name]: v }))}
                >
                  <SelectTrigger className="mt-1" data-testid={`select-entry-${f.name}`}>
                    <SelectValue placeholder={`Select ${trackerFieldLabel(f).toLowerCase()}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {f.type === "duration" && (
                <Input
                  type="text"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                  placeholder="e.g. 1:30:00"
                  className="mt-1"
                  data-testid={`input-entry-${f.name}`}
                />
              )}
            </div>
          ))}
          {/* Ad-hoc custom fields — add anything not in the tracker's schema */}
          {Object.keys(customFields).length > 0 && (
            <div className="space-y-1.5">
              {Object.entries(customFields).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-24 shrink-0 truncate" title={k}>{humanizeFieldName(k)}</span>
                  <span className="text-sm flex-1 truncate">{String(v)}</span>
                  <button
                    type="button"
                    onClick={() => removeCustomField(k)}
                    className="p-0.5 rounded hover:bg-destructive/15 transition-colors"
                    title={`Remove "${k}"`}
                    aria-label={`Remove field ${k}`}
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div>
            <Label className="text-xs font-medium text-muted-foreground">Add a field</Label>
            <div className="flex items-center gap-1.5 mt-1">
              <Input
                className="w-28 text-sm"
                placeholder="field"
                value={newFieldName}
                onChange={(e) => setNewFieldName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomField(); } }}
                data-testid="add-custom-field-name"
              />
              <Input
                className="flex-1 text-sm"
                placeholder="value"
                value={newFieldValue}
                onChange={(e) => setNewFieldValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustomField(); } }}
                data-testid="add-custom-field-value"
              />
              <Button type="button" size="sm" variant="outline" className="h-9 px-2 text-xs" onClick={addCustomField} disabled={!newFieldName.trim()}>
                <Plus className="h-3.5 w-3.5 mr-0.5" />Add
              </Button>
            </div>
          </div>
          <div>
            <Label className="text-xs font-medium text-muted-foreground">Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any additional notes..."
              className="mt-1 text-sm"
              rows={2}
              data-testid="textarea-entry-notes"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Secondary data (calories, pace, etc.) will be computed automatically.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} data-testid="button-entry-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => {
              // Snapshot the payload BEFORE any state reset (race fix).
              const payload = buildEntryPayload();
              // Validate before close so we don't dismiss the dialog on an invalid entry
              const hasValue = Object.values(payload.values).some(v => v !== undefined && v !== "" && v !== null);
              if (!hasValue) {
                mutation.mutate(payload); // will throw "Please fill in at least one field"
                return;
              }
              mutation.mutate(payload);
              // Close immediately — optimistic update has already added the entry to the chart
              setValues({});
              setNotes("");
              onOpenChange(false);
            }}
            disabled={mutation.isPending}
            data-testid="button-entry-submit"
          >
            {mutation.isPending ? "Logging..." : "Log Entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── DeleteEntryButton ──────────────────────────────────────────────────────────

function DeleteEntryButton({
  trackerId,
  entryId,
  entry,
}: {
  trackerId: string;
  entryId: string;
  /** Full entry row — captured so the delete toast can offer Undo (P2). */
  entry?: any;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const mutation = useMutation<any,Error,void>({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/trackers/${trackerId}/entries/${entryId}`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/trackers"] });
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
        (old || []).map((t: any) => t.id === trackerId
          ? { ...t, entries: (t.entries || []).filter((e: any) => e.id !== entryId) }
          : t
        )
      );
      return { prev };
    },
    onSuccess: () => {
      // P2 undo: re-create the entry via the existing POST endpoint. The
      // insert schema accepts values/notes/mood/tags/profile/timestamp, so
      // nothing user-entered is lost (id + computed are re-derived server-side).
      if (entry) {
        showUndoToast({
          title: "Entry deleted",
          onUndo: () => recreateDeleted({
            url: `/api/trackers/${trackerId}/entries`,
            body: {
              values: entry.values || {},
              notes: entry.notes || undefined,
              mood: entry.mood || undefined,
              tags: entry.tags || undefined,
              forProfile: entry.forProfile || undefined,
              profileId: entry.profileId || undefined,
              timestamp: entry.timestamp || undefined,
            },
            domains: ["trackers"],
            queryKeyHead: "/api/trackers",
            applyOptimistic: (old: any) => Array.isArray(old)
              ? old.map((t: any) => t.id === trackerId
                  ? { ...t, entries: [...(t.entries || []), entry] }
                  : t)
              : old,
            successTitle: "Entry restored",
            errorTitle: "Couldn't restore entry",
          }),
        });
      } else {
        toast({ title: "Entry deleted" });
      }
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to delete entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      invalidateDomain("trackers");
    },
  });

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-muted-foreground hover:text-destructive"
        onClick={() => setOpen(true)}
        data-testid={`button-delete-entry-${entryId}`}
        aria-label="Delete entry"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid={`alert-delete-entry-${entryId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              The entry will be removed. You can undo this action briefly after deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-entry-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => mutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-entry-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── TrackerCard ────────────────────────────────────────────────────────────────
// Information-dense tiles: multiple KPIs, mini charts, stats text per card.
// Each tracker type renders a completely different rich interior.

function timeAgoShort(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// Sparkline with area fill
function Sparkline({ values, color, h = 28 }: { values: number[]; color: string; h?: number }) {
  if (values.length < 2) return null;
  const w = 100;
  const mn = Math.min(...values), mx = Math.max(...values), rng = mx - mn || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - 2 - ((v - mn) / rng) * (h - 4);
    return `${x},${y}`;
  });
  const uid = `sp${color.replace(/[^a-z0-9]/gi,'')}`;
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs><linearGradient id={uid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.25" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`M0,${h} L${pts.join(' L')} L${w},${h}Z`} fill={`url(#${uid})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 7-day mini bars
function WeekBars({ entries, color }: { entries: TrackerEntry[]; color: string }) {
  const days = Array.from({ length: 7 }).map((_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (6 - i));
    return entries.filter(e => new Date(e.timestamp).toLocaleDateString('en-CA') === d.toLocaleDateString('en-CA')).length;
  });
  const mx = Math.max(...days, 1);
  return (
    <div className="flex items-end gap-[2px] h-5">
      {days.map((c, i) => <div key={i} className="flex-1 rounded-sm" style={{ height: c > 0 ? `${Math.max(3, (c / mx) * 18)}px` : '2px', backgroundColor: c > 0 ? color : 'hsl(var(--muted-foreground) / 0.1)', opacity: c > 0 ? 0.85 : 0.3 }} />)}
    </div>
  );
}

// Donut
function Donut({ pct, color, size = 32, label }: { pct: number; color: string; size?: number; label?: string }) {
  const r = (size - 5) / 2, circ = 2 * Math.PI * r;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="hsl(var(--muted-foreground) / 0.08)" strokeWidth="3" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${Math.min(1, pct) * circ} ${circ}`} transform={`rotate(-90 ${size/2} ${size/2})`} />
      </svg>
      {label && <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold" style={{ color }}>{label}</span>}
    </div>
  );
}

// Progress bar
function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1 rounded-full bg-muted/30 overflow-hidden w-full">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }} />
    </div>
  );
}

// Stat line: label + value
function KpiLine({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-[9px] text-muted-foreground truncate">{label}</span>
      <span className="text-[9px] font-bold tabular-nums text-foreground shrink-0" style={accent ? { color: accent } : undefined}>{value}</span>
    </div>
  );
}

// ── Status helper: returns Apple-Health-style status pill {label, color} ──
function getTrackerStatus(
  tracker: Tracker,
  spec: ReturnType<typeof detectSpecialization>,
  lastEntry: TrackerEntry | undefined,
  primaryField: string,
): { label: string; bg: string; fg: string } | null {
  if (!lastEntry) return null;
  const v = lastEntry.values[primaryField] as number | undefined;

  const GREEN = { bg: 'rgba(34,197,94,0.15)', fg: '#16a34a' };
  const YELLOW = { bg: 'rgba(234,179,8,0.18)', fg: '#ca8a04' };
  const RED = { bg: 'rgba(239,68,68,0.15)', fg: '#dc2626' };
  const BLUE = { bg: 'rgba(59,130,246,0.15)', fg: '#2563eb' };

  // Blood pressure: AHA categories
  if (spec === 'bloodpressure') {
    const sys = (lastEntry.values['systolic'] ?? lastEntry.values['systolic_pressure']) as number | undefined;
    const dia = (lastEntry.values['diastolic'] ?? lastEntry.values['diastolic_pressure']) as number | undefined;
    if (sys == null || dia == null) return null;
    if (sys >= 180 || dia >= 120) return { label: 'Crisis', ...RED };
    if (sys >= 140 || dia >= 90) return { label: 'High', ...RED };
    if (sys >= 130 || dia >= 80) return { label: 'Elevated', ...YELLOW };
    if (sys < 90 || dia < 60) return { label: 'Low', ...YELLOW };
    return { label: 'In range', ...GREEN };
  }

  // Sleep: hours per night
  if (spec === 'sleep' && typeof v === 'number') {
    if (v >= 7 && v <= 9) return { label: 'In range', ...GREEN };
    if (v >= 6 && v < 7) return { label: 'Moderate', ...YELLOW };
    return { label: 'Low', ...RED };
  }

  // Medication: today's dose taken?
  if (spec === 'medication') {
    const today = new Date().toLocaleDateString('en-CA');
    const entries = tracker.entries || [];
    const takenToday = entries.some(e => new Date(e.timestamp).toLocaleDateString('en-CA') === today);
    return takenToday ? { label: 'Taken', ...GREEN } : { label: 'Due', ...YELLOW };
  }

  // Weight / Running / generic: freshness-based status
  const ageMs = Date.now() - new Date(lastEntry.timestamp).getTime();
  const ageDays = ageMs / 86400000;
  if (ageDays <= 1) return { label: 'Today', ...GREEN };
  if (ageDays <= 7) return { label: 'This week', ...BLUE };
  if (ageDays <= 30) return { label: 'This month', ...YELLOW };
  return { label: 'Stale', ...RED };
}


// ── Insight-driven tracker display ────────────────────────────────────────────
// Turns a raw tracker + its latest entry into the structured pieces a card
// needs so we *never* render bare/ambiguous numbers like "90" or "Running 2".
//
// Returns:
//   hasData      – false when the tracker has no entries (caller hides the card
//                  behind the "No Data" collapsible pile)
//   importance   – "large" | "normal" | "compact"; controls grid column span
//   bigPrimary   – the big front-of-card value, already unit-formatted
//                  (e.g. "125/80", "3.2", "7,000", "30")
//   bigUnit      – the unit string shown next to bigPrimary (e.g. "mmHg",
//                  "miles", "steps", "minutes"). Empty string when no unit
//                  could be inferred (rare).
//   subline      – contextual second line, e.g. "32 min · 9:42 pace" for a
//                  Run, "Goal 10,000 · 70%" for Walking, "5-day streak" for
//                  Guitar, "Previous: 122/78" for BP. Empty for trackers that
//                  don't have a meaningful second line.
//   insight      – the human-readable sentence we surface in the card body,
//                  e.g. "Ran 3.2 mi today in 32 min. Up 12% vs last week."
//   progressPct  – 0-100 when a daily/weekly goal exists (Walking/Hydration),
//                  otherwise null. Drives the progress bar.
//   statusBadge  – {label, fg, bg} pill ("In range", "Elevated", "Today",
//                  etc.). null when no status applies.
//   sparkValues  – numeric series for the sparkline (empty array when not
//                  enough data points or non-numeric primary).
//   trendPct     – % change vs previous comparable period (null when N/A).
//   trendDir     – "up" | "down" | "flat" derived from trendPct.
//
type InsightKind =
  | "bloodpressure"
  | "weight"
  | "sleep"
  | "running"
  | "walking"
  | "hydration"
  | "calories"
  | "guitar"
  | "reading"
  | "gaming"
  | "meditation"
  | "bench"
  | "duration"
  | "habit"
  | "generic";

interface TrackerInsight {
  hasData: boolean;
  kind: InsightKind;
  importance: "large" | "normal" | "compact";
  bigPrimary: string;
  bigUnit: string;
  subline: string;
  insight: string;
  progressPct: number | null;
  statusBadge: { label: string; fg: string; bg: string } | null;
  sparkValues: number[];
  trendPct: number | null;
  trendDir: "up" | "down" | "flat";
  iconKind: "bp" | "weight" | "sleep" | "run" | "walk" | "drop" | "flame"
          | "music" | "book" | "game" | "brain" | "dumbbell" | "activity"
          | "bike";
}

// Display unit for a tracker field. Thin wrapper over the ONE canonical
// resolver in shared/tracker-units.ts so the history tab, card, chart, and
// overview can never show different units for the same field. Do NOT add unit
// guessing here — extend shared/tracker-units.ts instead (enforced by a
// contract test).
function inferUnit(tracker: Tracker, fieldName: string, _fieldUnit?: string | undefined): string {
  return resolveTrackerUnit(tracker as any, fieldName);
}

// Find the most likely numeric measurement in an entry, even when the
// field name is generic ("activity", "value") or doesn't match the
// tracker.fields schema. Returns null if no usable number exists.
// Reserved/structured keys (BP components, item names, notes) are
// skipped — those are handled by callers.
function findAnyNumericValue(
  values: Record<string, any> | undefined,
): { key: string; num: number } | null {
  if (!values) return null;
  const skip = new Set([
    "_notes", "notes", "item",
    "systolic", "diastolic", "systolic_pressure", "diastolic_pressure",
    "sbp", "dbp",
  ]);
  for (const [k, v] of Object.entries(values)) {
    if (skip.has(k) || k.startsWith("_")) continue;
    if (v == null || v === "" || typeof v === "object") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!isNaN(n) && isFinite(n)) return { key: k, num: n };
  }
  return null;
}

function pickNum(values: Record<string, any> | undefined, ...keys: string[]): number | null {
  if (!values) return null;
  for (const k of keys) {
    const v = values[k];
    if (v == null || v === "") continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!isNaN(n) && isFinite(n)) return n;
  }
  return null;
}

function pickStr(values: Record<string, any> | undefined, ...keys: string[]): string | null {
  if (!values) return null;
  for (const k of keys) {
    const v = values[k];
    if (v == null || v === "") continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

function fmtNum(n: number, max = 1): string {
  if (n >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n - Math.round(n)) < 0.05) return Math.round(n).toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

function isSameDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

// Canonical shape ID -> insight template. The taxonomy itself lives in
// shared/tracker-shapes.ts (ordered, specific-before-generic, with a
// vehicle-vs-health domain guard); this table only says how to RENDER each
// known shape. Shapes with no entry fall through to the name heuristics.
const SHAPE_TO_INSIGHT: Record<string, InsightKind> = {
  bench_press: "bench", squat: "bench", deadlift: "bench",
  overhead: "bench", row: "bench", curl: "bench", lifting: "bench",
  pushup: "bench", plank: "duration",
  running: "running", cycling: "running", swimming: "running",
  steps: "walking",
  weight: "weight", weight_solo: "weight",
  sleep: "sleep",
  hydration: "hydration",
  nutrition: "calories",
  blood_pressure: "bloodpressure",
  meditation: "meditation", stretching: "meditation",
  // Vehicle + medication shapes render through the generic path, which prints
  // the primary field with its declared unit ("35 PSI", "10 mg") instead of
  // borrowing another domain's sentence.
  tire_pressure: "generic", fuel: "generic", odometer: "generic",
  oil_change: "generic", ev_charge: "generic", vehicle_service: "generic",
  mileage: "generic", medication: "generic", supplement: "generic",
  expense: "generic", mood: "generic", heart_rate: "generic", body_fat: "generic",
};

// Whole-word test. The old classifier used bare `includes`, so "Tire
// Pressure" matched "press" and rendered as a bench-press tracker
// ("Lifted 35 lbs"), and "Treadmill" matched "read" and rendered as reading.
const hasWord = (name: string, ...stems: string[]) =>
  stems.some((stem) => new RegExp(`\\b${stem}`, "i").test(name));

// Classify a tracker by name + category. The kind drives which insight
// template we render.
function classifyTracker(tracker: Tracker): InsightKind {
  const name = (tracker.name || "").toLowerCase();
  const cat = (tracker.category || "").toLowerCase();

  // 1) The canonical taxonomy decides first, so every surface classifies the
  //    same tracker the same way.
  const shapeId = inferTrackerShapeId(tracker.name || "", tracker.category || undefined);
  if (shapeId && SHAPE_TO_INSIGHT[shapeId]) return SHAPE_TO_INSIGHT[shapeId];

  // 2) Name heuristics for trackers the catalog doesn't know, on whole words.
  if (hasWord(name, "blood pressure") || /(^|\s)bp(\s|$)/.test(name)) return "bloodpressure";
  if (hasWord(name, "weigh")) return "weight";
  if (hasWord(name, "sleep", "nap")) return "sleep";
  if (hasWord(name, "run", "jog", "sprint")) return "running";
  if (hasWord(name, "walk", "step", "hike")) return "walking";
  if (hasWord(name, "hydrat", "water", "drink")) return "hydration";
  if (hasWord(name, "calorie", "kcal")) return "calories";
  if (hasWord(name, "guitar", "piano", "instrument", "violin", "drum")) return "guitar";
  if (hasWord(name, "read", "book", "reading")) return "reading";
  if (hasWord(name, "gaming", "game", "chess", "videogame")) return "gaming";
  if (hasWord(name, "meditat", "mindful", "yoga", "breathwork")) return "meditation";
  if (hasWord(name, "bench", "squat", "deadlift", "lift", "press")) return "bench";
  if (hasWord(name, "bike", "cycl", "biking")) return "running"; // distance/duration shape
  // Generic categorical fallbacks
  if (cat === "habit" || cat === "routine") return "habit";
  return "generic";
}

function iconKindFor(kind: InsightKind): TrackerInsight["iconKind"] {
  switch (kind) {
    case "bloodpressure": return "bp";
    case "weight": return "weight";
    case "sleep": return "sleep";
    case "running": return "run";
    case "walking": return "walk";
    case "hydration": return "drop";
    case "calories": return "flame";
    case "guitar": return "music";
    case "reading": return "book";
    case "gaming": return "game";
    case "meditation": return "brain";
    case "bench": return "dumbbell";
    default: return "activity";
  }
}

function importanceFor(kind: InsightKind): "large" | "normal" | "compact" {
  if (kind === "weight" || kind === "bloodpressure" || kind === "sleep" || kind === "running" || kind === "walking") return "large";
  if (kind === "hydration" || kind === "calories" || kind === "bench") return "normal";
  return "compact";
}

function statusColors() {
  return {
    GREEN: { bg: "rgba(34,197,94,0.15)", fg: "#16a34a" },
    YELLOW: { bg: "rgba(234,179,8,0.18)", fg: "#ca8a04" },
    RED: { bg: "rgba(239,68,68,0.15)", fg: "#dc2626" },
    BLUE: { bg: "rgba(59,130,246,0.15)", fg: "#2563eb" },
    MUTED: { bg: "rgba(120,120,120,0.18)", fg: "hsl(var(--muted-foreground))" },
  };
}

function buildTrackerInsight(tracker: Tracker, goals: Goal[] = []): TrackerInsight {
  // PR J: Resolve a *real* user-created goal for this tracker. We only show
  // goal-based UI (progress bar, 'Goal X · Y%' subline, 'to go' insight,
  // 'Goal met' badge) when this is non-null. Otherwise the card shows the
  // value + freshness/trend without fabricating targets.
  const realGoal: Goal | undefined = goals.find(
    g => g && g.trackerId === tracker.id && g.status === "active" && typeof g.target === "number"
  );
  const C = statusColors();
  const kind = classifyTracker(tracker);
  const iconKind = iconKindFor(kind);
  const importance = importanceFor(kind);
  const entries = (tracker.entries || []).slice().sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  // Headline reads the latest entry — but if that entry has no usable numeric
  // value (e.g. a malformed sleep log that stored a clock time instead of
  // hours), fall back to the most recent entry that DOES, so one bad row can't
  // make a tracker with real history show up as "No Data".
  const latestEntry = entries[0];
  const hasNumericVal = (e: any) => !!e && Object.values(e.values || {}).some(v => typeof v === "number" && isFinite(v as number));
  const last = (hasNumericVal(latestEntry) ? latestEntry : entries.find(hasNumericVal)) || latestEntry;

  // ── No-data short-circuit ─────────────────────────────────────────────
  if (!last) {
    return {
      hasData: false, kind, importance, iconKind,
      bigPrimary: "—", bigUnit: "", subline: "",
      insight: "No entries yet — tap to log your first one.",
      progressPct: null, statusBadge: null, sparkValues: [], trendPct: null, trendDir: "flat",
    };
  }

  const lastDate = new Date(latestEntry.timestamp);
  const todayLogged = isSameDay(lastDate, new Date());
  const sevenAgo = Date.now() - 7 * 86400000;
  const fourteenAgo = Date.now() - 14 * 86400000;
  const todayKey = new Date().toLocaleDateString("en-CA");

  // Helpers scoped to this tracker
  const primaryField =
    tracker.fields.find(f => f.isPrimary)?.name ||
    tracker.fields.find(f => f.type === "number")?.name ||
    tracker.fields[0]?.name || "value";
  const primaryUnit = inferUnit(tracker,
    primaryField,
    tracker.fields.find(f => f.name === primaryField)?.unit);
  const numericValues = entries.map(e => Number(e.values?.[primaryField]))
    .filter(v => !isNaN(v) && isFinite(v));
  const sparkValues = numericValues.slice(0, 14).reverse(); // oldest→newest
  const last7 = entries.filter(e => new Date(e.timestamp).getTime() >= sevenAgo);
  const prev7 = entries.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return t < sevenAgo && t >= fourteenAgo;
  });
  const sum7 = last7.reduce((a, e) => a + (Number(e.values?.[primaryField]) || 0), 0);
  const sumPrev7 = prev7.reduce((a, e) => a + (Number(e.values?.[primaryField]) || 0), 0);
  let trendPct: number | null = null;
  if (sumPrev7 > 0) trendPct = ((sum7 - sumPrev7) / sumPrev7) * 100;
  const trendDir: "up" | "down" | "flat" = trendPct == null || Math.abs(trendPct) < 2 ? "flat" : (trendPct > 0 ? "up" : "down");

  // Last-N-readings status for freshness (used when a kind has no clinical
  // status of its own).
  const ageMs = Date.now() - lastDate.getTime();
  const ageDays = ageMs / 86400000;
  const freshness = ageDays <= 1 ? { label: "Today", ...C.GREEN }
                  : ageDays <= 7 ? { label: "This week", ...C.BLUE }
                  : ageDays <= 30 ? { label: "This month", ...C.YELLOW }
                  : { label: "Stale", ...C.MUTED };

  // ── Per-kind formatting ───────────────────────────────────────────────
  if (kind === "bloodpressure") {
    const sys = pickNum(last.values, "systolic", "systolic_pressure", "sbp");
    const dia = pickNum(last.values, "diastolic", "diastolic_pressure", "dbp");
    if (sys == null || dia == null) {
      // Incomplete reading — refuse to display half a number.
      return {
        hasData: true, kind, importance, iconKind, sparkValues,
        bigPrimary: "—", bigUnit: "mmHg", subline: "Incomplete reading",
        insight: "Last entry is missing one of the systolic/diastolic values. Log a complete reading.",
        progressPct: null, statusBadge: { label: "Incomplete", ...C.YELLOW },
        trendPct: null, trendDir: "flat",
      };
    }
    let status = { label: "In range", ...C.GREEN };
    if (sys >= 180 || dia >= 120) status = { label: "Crisis", ...C.RED };
    else if (sys >= 140 || dia >= 90) status = { label: "High", ...C.RED };
    else if (sys >= 130 || dia >= 80) status = { label: "Elevated", ...C.YELLOW };
    else if (sys < 90 || dia < 60) status = { label: "Low", ...C.YELLOW };
    const prev = entries[1];
    const prevSys = prev ? pickNum(prev.values, "systolic", "systolic_pressure", "sbp") : null;
    const prevDia = prev ? pickNum(prev.values, "diastolic", "diastolic_pressure", "dbp") : null;
    const prevStr = (prevSys != null && prevDia != null) ? `Previous: ${prevSys}/${prevDia}` : "";
    const insight = status.label === "In range"
      ? `Blood pressure is ${sys}/${dia} — within a normal range.`
      : status.label === "Elevated"
        ? `Slightly elevated at ${sys}/${dia}. Worth keeping an eye on.`
        : status.label === "High" || status.label === "Crisis"
          ? `${sys}/${dia} is elevated — consider talking to your doctor.`
          : `${sys}/${dia} is on the low side.`;
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: `${sys}/${dia}`, bigUnit: "mmHg",
      subline: prevStr, insight, progressPct: null, statusBadge: status,
      sparkValues: entries.map(e => pickNum(e.values, "systolic", "systolic_pressure", "sbp"))
        .filter((v): v is number => v != null).slice(0, 14).reverse(),
      trendPct, trendDir,
    };
  }

  if (kind === "weight") {
    const w = pickNum(last.values, primaryField, "weight", "value") ?? (findAnyNumericValue(last.values)?.num ?? null);
    if (w == null) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: primaryUnit || "lbs",
        subline: "", insight: "No weight logged.", progressPct: null, statusBadge: null,
        sparkValues, trendPct: null, trendDir: "flat" };
    }
    const monthAgo = Date.now() - 30 * 86400000;
    const monthEntries = entries.filter(e => new Date(e.timestamp).getTime() >= monthAgo);
    const oldest = monthEntries[monthEntries.length - 1];
    const oldestW = oldest ? pickNum(oldest.values, primaryField, "weight", "value") : null;
    const delta = oldestW != null ? w - oldestW : null;
    const unit = primaryUnit || "lbs";
    const subline = delta != null
      ? (Math.abs(delta) < 0.5 ? "Holding steady this month"
         : `${delta > 0 ? "+" : ""}${fmtNum(delta, 1)} ${unit} this month`)
      : "";
    const insight = delta != null
      ? (Math.abs(delta) < 0.5
          ? `Weight is steady around ${fmtNum(w, 1)} ${unit}.`
          : `Weight is ${fmtNum(w, 1)} ${unit}, ${delta > 0 ? "up" : "down"} ${fmtNum(Math.abs(delta), 1)} ${unit} over the past month.`)
      : `Logged ${fmtNum(w, 1)} ${unit}.`;
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: fmtNum(w, 1), bigUnit: unit,
      subline, insight, progressPct: null, statusBadge: freshness,
      sparkValues, trendPct, trendDir,
    };
  }

  if (kind === "sleep") {
    const h = pickNum(last.values, primaryField, "hours", "hours_slept", "duration", "value") ?? (findAnyNumericValue(last.values)?.num ?? null);
    if (h == null) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: "hr",
        subline: "", insight: "No sleep logged.", progressPct: null, statusBadge: null,
        sparkValues, trendPct: null, trendDir: "flat" };
    }
    let status = h >= 7 && h <= 9 ? { label: "In range", ...C.GREEN }
              : h >= 6 ? { label: "Moderate", ...C.YELLOW }
              : { label: "Low", ...C.RED };
    const avg = numericValues.length ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : null;
    const subline = avg != null ? `Avg ${fmtNum(avg, 1)} hr / night` : "";
    // PR J: don't fabricate an 8h goal progress bar. Sleep range badges
    // (Low / Moderate / In range) reflect the CDC 7-9h adult norm, not a
    // user-set goal. progressPct is only set when a real Goal exists.
    const insight = h >= 7
      ? `Slept ${fmtNum(h, 1)} hours.`
      : `Slept ${fmtNum(h, 1)} hours.`;
    const goalPct = realGoal ? Math.min(100, (h / realGoal.target) * 100) : null;
    const goalSubline = realGoal
      ? `Goal ${realGoal.target} ${realGoal.unit || "hr"} · ${Math.round(goalPct!)}%`
      : subline;
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: fmtNum(h, 1), bigUnit: "hr",
      subline: goalSubline, insight,
      progressPct: goalPct,
      statusBadge: realGoal && goalPct! >= 100 ? { label: "Goal met", ...C.GREEN } : status,
      sparkValues, trendPct, trendDir,
    };
  }

  if (kind === "running") {
    // Prefer explicit distance/duration fields; fall back to primary
    const dist = pickNum(last.values, "distance", "miles", "mi", "km") ?? pickNum(last.values, primaryField) ?? (findAnyNumericValue(last.values)?.num ?? null);
    const mins = pickNum(last.values, "duration", "minutes", "mins", "time");
    const distUnit = (() => {
      const f = tracker.fields.find(f => ["distance", "miles", "mi", "km"].includes(f.name));
      if (f?.unit) return f.unit;
      if (primaryUnit && /mi|km/.test(primaryUnit)) return primaryUnit;
      return "mi";
    })();
    if (dist == null && mins == null) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: "miles",
        subline: "", insight: "Log a distance or duration to see your run.",
        progressPct: null, statusBadge: null, sparkValues, trendPct: null, trendDir: "flat" };
    }
    const big = dist != null ? fmtNum(dist, 2) : fmtNum(mins!, 0);
    const bigUnit = dist != null ? distUnit : "min";
    const paceStr = (dist != null && mins != null && dist > 0)
      ? (() => {
          const pace = mins / dist; // min/mi or min/km
          const m = Math.floor(pace); const s = Math.round((pace - m) * 60);
          return `${m}:${String(s).padStart(2, "0")} pace`;
        })()
      : "";
    const sublineParts: string[] = [];
    if (mins != null && dist != null) sublineParts.push(`${fmtNum(mins, 0)} min`);
    if (paceStr) sublineParts.push(paceStr);
    const subline = sublineParts.join(" · ");
    const weekTotal = last7.reduce((a, e) => a + (Number(e.values?.distance) || Number(e.values?.miles) || Number(e.values?.[primaryField]) || 0), 0);
    const trendNote = trendPct != null && Math.abs(trendPct) >= 5
      ? ` ${trendPct > 0 ? "Up" : "Down"} ${Math.abs(Math.round(trendPct))}% vs last week.`
      : "";
    const insight = dist != null
      ? `Ran ${fmtNum(dist, 2)} ${distUnit}${mins != null ? ` in ${fmtNum(mins, 0)} min` : ""}.${trendNote}${weekTotal > 0 ? ` ${fmtNum(weekTotal, 1)} ${distUnit} this week.` : ""}`
      : `Ran for ${fmtNum(mins!, 0)} minutes.${trendNote}`;
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: big, bigUnit, subline,
      insight, progressPct: null, statusBadge: freshness,
      sparkValues: entries.map(e => Number(e.values?.distance) || Number(e.values?.miles) || Number(e.values?.[primaryField])).filter(v => !isNaN(v) && isFinite(v)).slice(0, 14).reverse(),
      trendPct, trendDir,
    };
  }

  if (kind === "walking") {
    const steps = pickNum(last.values, "steps", "step_count", primaryField, "value") ?? (findAnyNumericValue(last.values)?.num ?? null);
    if (steps == null) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: "steps",
        subline: "", insight: "Log steps to track your walking.",
        progressPct: null, statusBadge: null, sparkValues, trendPct: null, trendDir: "flat" };
    }
    // PR J: only render a goal if the user actually created one for this tracker.
    if (realGoal) {
      const goalTarget = realGoal.target;
      const goalUnit = realGoal.unit || "steps";
      const pct = Math.min(100, (steps / goalTarget) * 100);
      const subline = `Goal ${goalTarget.toLocaleString()} · ${Math.round(pct)}%`;
      const insight = pct >= 100
        ? `Hit ${steps.toLocaleString()} ${goalUnit} — past the ${goalTarget.toLocaleString()} goal.`
        : `${steps.toLocaleString()} ${goalUnit} so far — ${(goalTarget - steps).toLocaleString()} to go.`;
      return {
        hasData: true, kind, importance, iconKind,
        bigPrimary: steps.toLocaleString(), bigUnit: goalUnit,
        subline, insight, progressPct: pct,
        statusBadge: pct >= 100 ? { label: "Goal met", ...C.GREEN } : freshness,
        sparkValues, trendPct, trendDir,
      };
    }
    // No goal set — show just the value + trend, no fabricated target.
    const trendNote = trendPct != null && Math.abs(trendPct) >= 5
      ? ` ${trendPct > 0 ? "Up" : "Down"} ${Math.abs(Math.round(trendPct))}% vs last week.`
      : "";
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: steps.toLocaleString(), bigUnit: "steps",
      subline: "",
      insight: `Logged ${steps.toLocaleString()} steps.${trendNote}`,
      progressPct: null,
      statusBadge: freshness,
      sparkValues, trendPct, trendDir,
    };
  }

  if (kind === "hydration") {
    // Sum all of today's entries so a tracker logged in 8-oz cups still shows
    // the total intake. Detect the unit from the primary field name.
    const todayEntries = entries.filter(e => new Date(e.timestamp).toLocaleDateString("en-CA") === todayKey);
    const todayTotal = todayEntries.reduce((s, e) => s + (Number(e.values?.[primaryField]) || 0), 0);
    if (todayTotal === 0 && numericValues.length === 0) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: primaryUnit || "oz",
        subline: "", insight: "Log your first drink to start tracking hydration.",
        progressPct: null, statusBadge: null, sparkValues, trendPct: null, trendDir: "flat" };
    }
    const unit = primaryUnit || "oz";
    const big = todayTotal > 0 ? fmtNum(todayTotal, 1) : fmtNum(Number(last.values?.[primaryField]) || 0, 1);
    // PR J: only show goal UI when the user created a real Goal.
    if (realGoal) {
      const goalTarget = realGoal.target;
      const goalUnit = realGoal.unit || unit;
      const pct = Math.min(100, (todayTotal / goalTarget) * 100);
      const subline = `Goal ${goalTarget} ${goalUnit} · ${Math.round(pct)}%`;
      const insight = pct >= 100
        ? `Hit hydration goal — ${big} ${goalUnit} today.`
        : todayTotal > 0
          ? `${big} ${goalUnit} today — ${fmtNum(goalTarget - todayTotal, 1)} ${goalUnit} to go.`
          : `Last logged ${big} ${goalUnit}.`;
      return {
        hasData: true, kind, importance, iconKind,
        bigPrimary: big, bigUnit: goalUnit,
        subline, insight, progressPct: pct,
        statusBadge: pct >= 100 ? { label: "Goal met", ...C.GREEN } : freshness,
        sparkValues, trendPct, trendDir,
      };
    }
    // No goal — descriptive only.
    const insight = todayTotal > 0
      ? `${big} ${unit} today.`
      : `Last logged ${big} ${unit}.`;
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: big, bigUnit: unit,
      subline: "", insight, progressPct: null,
      statusBadge: freshness,
      sparkValues, trendPct, trendDir,
    };
  }

  if (kind === "calories") {
    const cals = pickNum(last.values, primaryField, "calories", "kcal", "value") ?? (findAnyNumericValue(last.values)?.num ?? null);
    if (cals == null) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: "cal",
        subline: "", insight: "Log a meal or workout to start tracking calories.",
        progressPct: null, statusBadge: null, sparkValues, trendPct: null, trendDir: "flat" };
    }
    const avg = numericValues.length ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : null;
    const subline = avg != null ? `Avg ${fmtNum(avg, 0)} cal` : "";
    const insight = `${fmtNum(cals, 0)} cal logged.${avg != null ? ` Average is ${fmtNum(avg, 0)}.` : ""}`;
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: fmtNum(cals, 0), bigUnit: "cal",
      subline, insight, progressPct: null, statusBadge: freshness,
      sparkValues, trendPct, trendDir,
    };
  }

  if (kind === "guitar" || kind === "reading" || kind === "meditation" || kind === "gaming") {
    // Duration-style trackers — the primary value is minutes. Fall back to
    // any numeric field in the entry so generically-named fields like
    // "activity" still surface as a real value.
    const mins = pickNum(last.values, primaryField, "duration", "minutes", "mins", "time", "value")
      ?? (findAnyNumericValue(last.values)?.num ?? null);
    const noteStr = pickStr(last.values, "_notes", "notes") || (last as any).notes || "";
    if (mins == null && !noteStr) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: "min",
        subline: "", insight: "Log a session to start a streak.",
        progressPct: null, statusBadge: null, sparkValues, trendPct: null, trendDir: "flat" };
    }
    const verb = kind === "guitar" ? "of practice"
              : kind === "reading" ? "reading"
              : kind === "meditation" ? "meditation"
              : "gaming";
    const subline = mins != null && mins > 0
      ? `${fmtNum(mins, 0)} min ${verb}`
      : (noteStr ? noteStr.slice(0, 40) : "");
    // Streak: count consecutive days back from today with at least one entry.
    const daySet = new Set(entries.map(e => new Date(e.timestamp).toLocaleDateString("en-CA")));
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      if (daySet.has(d.toLocaleDateString("en-CA"))) streak++;
      else if (i > 0) break;
    }
    const insight = mins != null && mins > 0
      ? `${fmtNum(mins, 0)} minutes ${verb} on ${lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}.${streak >= 2 ? ` ${streak}-day streak.` : ""}`
      : (noteStr || `Logged on ${lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`);
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: mins != null && mins > 0 ? fmtNum(mins, 0) : (noteStr ? noteStr.slice(0, 8) : "—"),
      bigUnit: mins != null && mins > 0 ? "min" : "",
      subline, insight, progressPct: null,
      statusBadge: streak >= 3 ? { label: `${streak}-day streak`, ...C.GREEN } : freshness,
      sparkValues, trendPct, trendDir,
    };
  }

  if (kind === "bench") {
    const w = pickNum(last.values, "weight", "lbs", primaryField, "value") ?? (findAnyNumericValue(last.values)?.num ?? null);
    const reps = pickNum(last.values, "reps", "rep_count");
    const sets = pickNum(last.values, "sets", "set_count");
    if (w == null && reps == null && sets == null) {
      return { hasData: false, kind, importance, iconKind, bigPrimary: "—", bigUnit: "lbs",
        subline: "", insight: "Log a set to start tracking.",
        progressPct: null, statusBadge: null, sparkValues, trendPct: null, trendDir: "flat" };
    }
    const subParts: string[] = [];
    if (reps != null) subParts.push(`${reps} reps`);
    if (sets != null) subParts.push(`${sets} sets`);
    const subline = subParts.join(" · ");
    const unit = (tracker.fields.find(f => f.name === "weight")?.unit) || tracker.unit || "lbs";
    const big = w != null ? fmtNum(w, 0) : (reps != null ? `${reps}` : "—");
    const bigUnit = w != null ? unit : (reps != null ? "reps" : "");
    const insight = w != null
      ? `Lifted ${fmtNum(w, 0)} ${unit}${reps != null ? ` × ${reps}` : ""}${sets != null ? ` × ${sets} sets` : ""}.`
      : (reps != null ? `${reps} reps logged.` : "Session logged.");
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: big, bigUnit, subline,
      insight, progressPct: null, statusBadge: freshness,
      sparkValues, trendPct, trendDir,
    };
  }

  // ── Generic fallback ──────────────────────────────────────────────────
  // Last-ditch path: still try to format something useful instead of bare
  // text. Strings that just repeat the tracker name ("running", "guitar")
  // are suppressed in favour of a note.
  // Prefer the declared primary field, but if it has no value, scan the
  // entry for ANY numeric measurement before giving up. This is what
  // catches custom trackers whose fields are named generically.
  let rawPrim: any = last.values?.[primaryField];
  let rawPrimKey = primaryField;
  if (rawPrim == null || rawPrim === "") {
    const any = findAnyNumericValue(last.values);
    if (any) { rawPrim = any.num; rawPrimKey = any.key; }
  }
  const trackerNameLower = (tracker.name || "").toLowerCase().trim();
  const isRepeatedLabel = typeof rawPrim === "string" && rawPrim.trim().toLowerCase() === trackerNameLower;
  if (rawPrim == null || rawPrim === "" || isRepeatedLabel) {
    // Fall back to notes or any other declared field.
    const note = pickStr(last.values, "_notes", "notes") || (last as any).notes || "";
    const fallbackPiece = (() => {
      for (const f of tracker.fields) {
        if (f.name === primaryField || f.name === "_notes") continue;
        const v = last.values?.[f.name];
        if (v == null || v === "") continue;
        const u = inferUnit(tracker, f.name, f.unit);
        return typeof v === "number" || !isNaN(Number(v))
          ? { primary: fmtNum(Number(v), 1), unit: u || f.name }
          : { primary: String(v).slice(0, 12), unit: "" };
      }
      return null;
    })();
    if (fallbackPiece) {
      return {
        hasData: true, kind, importance, iconKind,
        bigPrimary: fallbackPiece.primary, bigUnit: fallbackPiece.unit,
        subline: note ? note.slice(0, 60) : "",
        insight: `Logged on ${lastDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`,
        progressPct: null, statusBadge: freshness, sparkValues, trendPct, trendDir,
      };
    }
    return {
      hasData: !!note, kind, importance, iconKind,
      bigPrimary: note ? note.slice(0, 18) : "—",
      bigUnit: "",
      subline: note ? "" : "",
      insight: note || "Entry logged with no measurable value.",
      progressPct: null, statusBadge: freshness, sparkValues: [], trendPct: null, trendDir: "flat",
    };
  }
  // Phase 2: spec-driven generic card. For an ADDITIVE metric (water, calories,
  // minutes, custom quantities), the headline should be TODAY's running total —
  // not the last single entry (the "0 oz / wrong number" dashboard bug).
  const presCard = classifyTrackerPresentation(tracker as any);
  if (presCard.metricKind === "additive" && (typeof rawPrim === "number" || !isNaN(Number(rawPrim)))) {
    const fld = presCard.primaryField || rawPrimKey;
    const unitA = presCard.unit || inferUnit(tracker, fld, tracker.fields.find(f => f.name === fld)?.unit) || "";
    const todayKey = new Date().toLocaleDateString("en-CA");
    let todayTotal = 0, anyToday = false;
    for (const e of tracker.entries) {
      if (new Date(e.timestamp).toLocaleDateString("en-CA") !== todayKey) continue;
      const v = Number(e.values?.[fld]);
      if (isFinite(v)) { todayTotal += v; anyToday = true; }
    }
    const headline = anyToday ? todayTotal : Number(rawPrim);
    return {
      hasData: true, kind, importance, iconKind,
      bigPrimary: fmtNum(headline, headline % 1 === 0 ? 0 : 1), bigUnit: unitA,
      subline: anyToday ? "today" : "last entry",
      insight: anyToday
        ? `${fmtNum(todayTotal, todayTotal % 1 === 0 ? 0 : 1)}${unitA ? " " + unitA : ""} logged today.`
        : `Latest: ${fmtNum(Number(rawPrim), 1)}${unitA ? " " + unitA : ""}.`,
      progressPct: null, statusBadge: freshness, sparkValues, trendPct, trendDir,
    };
  }

  const isNum = typeof rawPrim === "number" || !isNaN(Number(rawPrim));
  const big = isNum ? fmtNum(Number(rawPrim), 1) : String(rawPrim).slice(0, 14);
  // Use the inferred unit for whichever key actually held the number, so
  // generic field names like "activity" still get a real unit from the
  // tracker name (Guitar → min, Walking → steps, etc.).
  const unit = isNum
    ? inferUnit(tracker, rawPrimKey, tracker.fields.find(f => f.name === rawPrimKey)?.unit)
    : "";
  const avg = numericValues.length >= 2 ? numericValues.reduce((a, b) => a + b, 0) / numericValues.length : null;
  const subline = avg != null ? `Avg ${fmtNum(avg, 1)}${unit ? " " + unit : ""}` : "";
  const insight = isNum
    ? `Latest reading is ${big}${unit ? " " + unit : ""}.${avg != null ? ` Average is ${fmtNum(avg, 1)}${unit ? " " + unit : ""}.` : ""}`
    : `Latest entry: ${big}.`;
  return {
    hasData: true, kind, importance, iconKind,
    bigPrimary: big, bigUnit: unit, subline,
    insight, progressPct: null, statusBadge: freshness,
    sparkValues, trendPct, trendDir,
  };
}

// Map an iconKind to its lucide component (TrackerCard renders it).
function iconForKind(k: TrackerInsight["iconKind"]) {
  switch (k) {
    case "bp": return Heart;
    case "weight": return Activity;
    case "sleep": return Moon;
    case "run": return Zap;
    case "walk": return Footprints;
    case "drop": return Droplet;
    case "flame": return Flame;
    case "music": return Music;
    case "book": return BookOpen;
    case "game": return Gamepad2;
    case "brain": return Brain;
    case "dumbbell": return Dumbbell;
    case "bike": return Bike;
    default: return Activity;
  }
}


// ── NoDataPile ────────────────────────────────────────────────────────────────
// Collapses empty trackers behind a single pill so they don't clutter the
// dashboard. Tapping expands an inline list of names that link into the
// tracker detail — exactly what the user asked for ("8 Trackers With No Data,
// click to expand").
function NoDataPile({ trackers, onOpenDetail }: { trackers: any[]; onOpenDetail: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (trackers.length === 0) return null;
  return (
    <div className="mb-2.5 mt-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg border border-border/40 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        data-testid="no-data-pile-toggle"
      >
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground/40" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">No Data</span>
          <span className="text-[10px] text-muted-foreground font-normal normal-case tracking-normal">
            ({trackers.length} {trackers.length === 1 ? 'tracker' : 'trackers'} without entries)
          </span>
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {open && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 mt-1.5">
          {trackers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((t: any) => {
            const catAccent = getCategoryAccent(t.category);
            const Icon = iconForKind(buildTrackerInsight(t).iconKind);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpenDetail(t.id)}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border border-border/40 hover:bg-muted/40 transition-colors text-left"
                style={{ borderColor: `hsl(${catAccent} / 0.25)` }}
              >
                <span
                  className="w-4 h-4 rounded flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `hsl(${catAccent} / 0.18)`, color: `hsl(${catAccent})` }}
                >
                  <Icon className="h-2.5 w-2.5" />
                </span>
                <span className="text-[11px] font-medium text-foreground truncate flex-1">{t.name}</span>
                <span className="text-[9px] text-muted-foreground shrink-0">log</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Card visual selection ──────────────────────────────────────────────────
// Reference ranges for common health measurements, so a card can show a banded
// gauge ("Healthy" / "Elevated") instead of a lone number. Matched by the
// tracker name OR primary field. Returns null for metrics without a range.
function getMeasurementRange(name: string, field: string): { min: number; max: number; zones: GaugeZone[] } | null {
  const s = `${name} ${field}`.toLowerCase();
  const has = (re: RegExp) => re.test(s);
  const G = "#16a34a", A = "#f59e0b", R = "#dc2626", B = "#2563eb";
  if (has(/\bbmi\b/)) return { min: 12, max: 40, zones: [{ to: 18.5, color: A, label: "Underweight" }, { to: 25, color: G, label: "Healthy" }, { to: 30, color: A, label: "Overweight" }, { to: 40, color: R, label: "Obese" }] };
  if (has(/body\s*fat|bodyfat/)) return { min: 5, max: 40, zones: [{ to: 8, color: B, label: "Low" }, { to: 20, color: G, label: "Healthy" }, { to: 25, color: A, label: "Elevated" }, { to: 40, color: R, label: "High" }] };
  if (has(/glucose|blood\s*sugar|bloodsugar/)) return { min: 50, max: 200, zones: [{ to: 70, color: A, label: "Low" }, { to: 100, color: G, label: "Normal" }, { to: 125, color: A, label: "Pre-diabetic" }, { to: 200, color: R, label: "High" }] };
  if (has(/\bhdl\b/)) return { min: 20, max: 100, zones: [{ to: 40, color: R, label: "Low" }, { to: 60, color: A, label: "OK" }, { to: 100, color: G, label: "Optimal" }] };
  if (has(/\bldl\b/)) return { min: 50, max: 200, zones: [{ to: 100, color: G, label: "Optimal" }, { to: 130, color: A, label: "Near optimal" }, { to: 160, color: A, label: "Borderline" }, { to: 200, color: R, label: "High" }] };
  if (has(/triglyceride/)) return { min: 50, max: 500, zones: [{ to: 150, color: G, label: "Normal" }, { to: 200, color: A, label: "Borderline" }, { to: 500, color: R, label: "High" }] };
  if (has(/cholesterol/)) return { min: 120, max: 300, zones: [{ to: 200, color: G, label: "Desirable" }, { to: 240, color: A, label: "Borderline" }, { to: 300, color: R, label: "High" }] };
  if (has(/\b(alt|sgpt)\b/)) return { min: 0, max: 80, zones: [{ to: 35, color: G, label: "Normal" }, { to: 55, color: A, label: "Elevated" }, { to: 80, color: R, label: "High" }] };
  if (has(/\b(ast|sgot)\b/)) return { min: 0, max: 80, zones: [{ to: 35, color: G, label: "Normal" }, { to: 55, color: A, label: "Elevated" }, { to: 80, color: R, label: "High" }] };
  if (has(/spo2|oxygen|o2\s*sat/)) return { min: 85, max: 100, zones: [{ to: 90, color: R, label: "Low" }, { to: 94, color: A, label: "Mild" }, { to: 100, color: G, label: "Normal" }] };
  if (has(/temperature|\btemp\b/)) return { min: 95, max: 104, zones: [{ to: 97, color: B, label: "Low" }, { to: 99, color: G, label: "Normal" }, { to: 100.4, color: A, label: "Elevated" }, { to: 104, color: R, label: "Fever" }] };
  if (has(/systolic/)) return { min: 80, max: 200, zones: [{ to: 90, color: A, label: "Low" }, { to: 120, color: G, label: "Normal" }, { to: 130, color: A, label: "Elevated" }, { to: 140, color: A, label: "Stage 1" }, { to: 200, color: R, label: "Stage 2" }] };
  if (has(/resting\s*(heart|hr)|heart\s*rate|\bpulse\b|\bbpm\b/)) return { min: 40, max: 120, zones: [{ to: 60, color: B, label: "Athletic" }, { to: 100, color: G, label: "Normal" }, { to: 120, color: A, label: "Elevated" }] };
  return null;
}

// A 0–10 / 0–100 wellness-style score that reads best as a radial gauge.
function scoreMaxFor(name: string, field: string, value: number): number | null {
  const s = `${name} ${field}`.toLowerCase();
  if (!/\b(wellness|readiness|overall\s*health|health\s*score|mood|sleep\s*score|index|score|rating)\b/.test(s)) return null;
  if (value <= 10) return 10;
  if (value <= 100) return 100;
  return null;
}

const MED_RE = /medication|supplement|vitamin|\bpill\b|prescription|\brx\b|\bdose\b|omega|fish\s*oil|multivitamin|lisinopril|metformin|statin|creatine|probiotic/i;

type CardVisual =
  | { type: "spark" }
  | { type: "ring"; pct: number }
  | { type: "gauge"; value: number; min: number; max: number; zones: GaugeZone[] }
  | { type: "radial"; value: number; max: number }
  | { type: "checklist" }
  | { type: "panel"; metrics: PanelMetric[] }
  | { type: "areaZone"; values: number[]; min: number; max: number; zones: GaugeZone[] }
  | { type: "activity" };

const ACTIVITY_KINDS = new Set(["guitar", "reading", "gaming", "meditation", "duration"]);

// Sum the primary numeric field per day over the last 7 days — the data behind
// the WeekdayBars on activity/duration cards.
function weeklyByDay(entries: TrackerEntry[], field: string): { label: string; value: number; today?: boolean }[] {
  const LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
  const todayKey = new Date().toLocaleDateString("en-CA");
  const out: { label: string; value: number; today?: boolean }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-CA");
    const value = (entries || [])
      .filter((e) => new Date(e.timestamp).toLocaleDateString("en-CA") === key)
      .reduce((s, e) => s + (typeof (e.values as any)[field] === "number" ? (e.values as any)[field] : 0), 0);
    out.push({ label: LETTERS[d.getDay()], value, today: key === todayKey });
  }
  return out;
}

// Collect numeric fields in the latest entry that each have a clinical range —
// panel-style trackers (lipid HDL/LDL/triglycerides) read best as several bars.
function rangedMetricsFor(tracker: Tracker, lastEntry: TrackerEntry | undefined): PanelMetric[] {
  if (!lastEntry) return [];
  const out: PanelMetric[] = [];
  for (const f of tracker.fields || []) {
    const v = (lastEntry.values as any)?.[f.name];
    if (typeof v !== "number") continue;
    const range = getMeasurementRange(tracker.name || "", f.name);
    if (range) out.push({ label: f.name, value: v, min: range.min, max: range.max, zones: range.zones });
  }
  return out;
}

// Pick the most informative visual for a card from data we already have.
// Order: meds checklist → panel bars → goal ring → range gauge → score radial → spark.
function chooseCardVisual(
  tracker: Tracker,
  insight: TrackerInsight,
  primary: { field: string; num: number } | null,
  lastEntry?: TrackerEntry,
): CardVisual {
  // Blood pressure keeps its "120/80" + status pill; a single-value gauge can't
  // represent two components.
  if (insight.kind === "bloodpressure") return { type: "spark" };
  const name = tracker.name || "";
  if (MED_RE.test(`${name} ${tracker.category || ""}`)) return { type: "checklist" };
  // Multi-metric lab panel: ≥2 reference-ranged numeric fields in the entry.
  const ranged = rangedMetricsFor(tracker, lastEntry);
  if (ranged.length >= 2) return { type: "panel", metrics: ranged };
  const field = primary?.field || tracker.fields?.[0]?.name || "";
  if (primary) {
    const range = getMeasurementRange(name, field);
    if (range) {
      // With enough history, show a lush trend with clinical zone bands behind
      // it (the dominant lab-card look); otherwise a band-position gauge.
      if (insight.sparkValues && insight.sparkValues.length >= 3) {
        return { type: "areaZone", values: insight.sparkValues, min: range.min, max: range.max, zones: range.zones };
      }
      return { type: "gauge", value: primary.num, min: range.min, max: range.max, zones: range.zones };
    }
  }
  if (insight.progressPct != null) return { type: "ring", pct: insight.progressPct };
  if (primary) {
    const max = scoreMaxFor(name, field, primary.num);
    if (max) return { type: "radial", value: primary.num, max };
  }
  // Duration / activity trackers (Chess, Basketball, Meditation, Reading, …):
  // a weekly-minutes bar chart + session stats reads far richer than a number.
  const isActivity = ACTIVITY_KINDS.has(insight.kind) ||
    (!!primary && (insight.bigUnit === "min" || /\b(min|minute|duration|session|game|match|practice)\b/.test(`${name} ${field}`.toLowerCase())));
  if (isActivity && primary) return { type: "activity" };
  return { type: "spark" };
}

function TrackerCard({ tracker, onDelete, onOpenDetail, sizeOverride, hideProfilePrefix }: {
  tracker: Tracker;
  onDelete: (id: string) => void;
  onOpenDetail?: (id: string) => void;
  // When the parent grid already partitioned by importance, it can force
  // every card to render at the same "compact" height so a row of mixed
  // kinds (Guitar + Reading + Gaming) doesn't ladder.
  sizeOverride?: "large" | "normal" | "compact";
  // When the parent already shows a profile header (e.g. the Linked page
  // groups by "Me" / each person), the per-card "<name>: <tracker>" prefix
  // is redundant noise. Set true to render the tracker name on its own.
  hideProfilePrefix?: boolean;
}) {
  const { data: allProfiles } = useQuery<Profile[]>({ queryKey: ["/api/profiles"], queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()) });
  const linkedNames = (tracker.linkedProfiles || []).map(pid => (allProfiles || []).find(p => p.id === pid)?.name).filter(Boolean);
  const profileLabel = linkedNames.length > 0 ? linkedNames[0] : '';
  // PR J: fetch the user's goals so insight builder only shows targets the
  // user actually set — no more fabricated 10k step / 64oz / 8h defaults.
  const { data: allGoals = [] } = useQuery<Goal[]>({ queryKey: goalsQueryKey([]) });

  const insight = buildTrackerInsight(tracker, allGoals);
  const catAccent = getCategoryAccent(tracker.category);
  const ac = `hsl(${catAccent})`;
  const Icon = iconForKind(insight.iconKind);
  const entries = tracker.entries || [];
  const lastEntry = entries.length ? [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] : undefined;
  const timeAgo = lastEntry ? timeAgoShort(lastEntry.timestamp) : null;

  const importance = sizeOverride || insight.importance;
  const cardHeight = importance === "large" ? 196 : importance === "normal" ? 180 : 156;

  // Pick a kind-appropriate visual (gauge / ring / radial / sparkline).
  const primaryNum = (() => {
    if (!lastEntry) return null;
    const pf = tracker.fields?.[0]?.name;
    if (pf && typeof (lastEntry.values as any)[pf] === "number") return { field: pf, num: (lastEntry.values as any)[pf] as number };
    const found = findAnyNumericValue(lastEntry.values);
    return found ? { field: found.key, num: found.num } : null;
  })();
  const visual = chooseCardVisual(tracker, insight, primaryNum, lastEntry);
  const gaugeSize = importance === "large" ? 84 : importance === "compact" ? 58 : 70;
  // Medication/supplement checklist row (taken vs due today).
  const medChecklist = (() => {
    if (visual.type !== "checklist") return null;
    const today = new Date().toLocaleDateString("en-CA");
    const takenToday = entries.some((e) => new Date(e.timestamp).toLocaleDateString("en-CA") === today);
    const doseField = tracker.fields?.find((f) => /dose|dosage|amount|qty|quantity|pill|tablet|capsule/i.test(f.name));
    const doseVal = doseField && lastEntry ? (lastEntry.values as any)[doseField.name] : undefined;
    const label = doseVal != null ? `${doseVal}${doseField?.unit ? ` ${doseField.unit}` : ""}` : "Daily dose";
    return [{ label, done: takenToday }];
  })();
  const kindEmoji = KIND_EMOJI[insight.iconKind];
  // Sports / fitness trends get the layered "effort zone" area look.
  const useZoneArea = insight.kind === "running" || insight.kind === "walking" || tracker.category === "fitness";
  // Score cards (radial) can show their other numeric sub-fields as mini bars
  // (e.g. Wellness → Mental / Activity), echoing the design references.
  const subMetrics = (visual.type === "radial" && lastEntry)
    ? Object.entries(lastEntry.values)
        .filter(([k, v]) => typeof v === "number" && k !== primaryNum?.field && !String(k).startsWith("_"))
        .slice(0, 3)
        .map(([k, v]) => ({ label: k, value: v as number, pct: (v as number) <= 10 ? (v as number) * 10 : (v as number) <= 100 ? (v as number) : 100 }))
    : [];
  // Weekly bars + session stats for activity/duration cards.
  const activityData = (() => {
    if (visual.type !== "activity") return null;
    const f = primaryNum?.field || tracker.fields?.[0]?.name || "value";
    const series = weeklyByDay(entries, f);
    const total = series.reduce((s, d) => s + d.value, 0);
    const sevenAgo = Date.now() - 7 * 86400000;
    const sessions = entries.filter((e) => new Date(e.timestamp).getTime() >= sevenAgo).length;
    const unit = insight.bigUnit || "min";
    const avg = sessions > 0 ? Math.round(total / sessions) : 0;
    return { series, total, sessions, unit, avg };
  })();
  // Effort/intensity chips for sport sessions (avg HR, calories, distance,
  // intensity, reps) — pulled from the latest entry so a logged soccer/chess
  // session reads richer, approaching the HR-zone sport cards in the design.
  const activityChips = (() => {
    if (visual.type !== "activity" || !lastEntry) return [] as { emoji: string; label: string }[];
    const v = lastEntry.values as Record<string, any>;
    const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
    const num = (re: RegExp) => { for (const k of Object.keys(v)) { if (re.test(norm(k)) && typeof v[k] === "number" && isFinite(v[k])) return v[k] as number; } return undefined; };
    const str = (re: RegExp) => { for (const k of Object.keys(v)) { if (re.test(norm(k)) && typeof v[k] === "string" && v[k].trim()) return v[k] as string; } return undefined; };
    const chips: { emoji: string; label: string }[] = [];
    const hr = num(/^(avghr|heartrate|bpm|pulse|hr)$/) ?? num(/(avghr|heartrate|bpm)/);
    if (hr != null) chips.push({ emoji: "❤️", label: `${Math.round(hr)} bpm` });
    const cal = num(/(caloriesburned|calories|kcal|^cal$)/);
    if (cal != null) chips.push({ emoji: "🔥", label: `${Math.round(cal)} cal` });
    const dist = num(/(distance|miles|^mi$|^km$)/);
    if (dist != null) chips.push({ emoji: "📏", label: `${dist} mi` });
    const intensityStr = str(/(intensity|effort|zone|level)/);
    const intensityNum = num(/(intensity|effort|zone|rpe)/);
    if (intensityStr) chips.push({ emoji: "⚡", label: intensityStr });
    else if (intensityNum != null) chips.push({ emoji: "⚡", label: `Zone ${intensityNum}` });
    const reps = num(/(^reps$|reps)/);
    if (chips.length < 2 && reps != null) chips.push({ emoji: "🔁", label: `${reps} reps` });
    // Cap at 2 chips: on the narrow 2-column grid, 3 chips wrap to a second line
    // and overflow the fixed-height card, colliding with the value above.
    return chips.slice(0, 2);
  })();

  return (
    <div
      data-testid={`card-tracker-${tracker.id}`}
      // The bubble owns the surface — radius, gradient wash, layered shadow —
      // driven by --accent-hsl. Setting background/border/shadow inline here is
      // what kept this card looking flat while the rest of the app moved.
      className="bubble bubble-interactive overflow-hidden cursor-pointer flex flex-col relative pressable"
      style={{ ["--accent-hsl" as any]: catAccent, height: cardHeight }}
      onClick={() => onOpenDetail?.(tracker.id)}
      role="button"
      tabIndex={0}
      aria-label={`Open tracker: ${tracker.name}`}
      onKeyDown={onEnterOrSpace(() => onOpenDetail?.(tracker.id))}
    >
      {/* Faint oversized kind glyph for personality (coffee / heart / pill …). */}
      {kindEmoji && (
        <span aria-hidden className="pointer-events-none absolute -top-1 right-1 select-none" style={{ fontSize: 44, opacity: 0.08, lineHeight: 1 }}>
          {kindEmoji}
        </span>
      )}
      {/* Header: icon + title */}
      <div className="relative px-3 pt-2.5 pb-1 flex items-center gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${catAccent} / 0.2)`, color: ac }}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground truncate leading-tight">
            {/* Strip the " - <ProfileName>" suffix that some trackers have
                baked into their stored name (e.g. "Blood Pressure - Joe",
                "Running - Rex"). When the parent already groups by profile,
                the suffix is redundant noise. cleanTrackerName is a no-op
                when the tracker has no matching suffix. */}
            {(!hideProfilePrefix && profileLabel) ? `${profileLabel}: ` : ''}
            {hideProfilePrefix
              ? cleanTrackerName(tracker.name, allProfiles, tracker.linkedProfiles)
              : tracker.name}
          </p>
          {insight.subline && (
            <p className="text-[10px] text-muted-foreground truncate leading-tight mt-0.5">
              {insight.subline}
            </p>
          )}
        </div>
      </div>

      {visual.type === "radial" ? (
        /* Score hero: radial gauge carries the value; insight sits beside it. */
        <div className="flex-1 px-3 pt-1 min-h-0 flex items-center gap-3">
          <RadialGauge value={visual.value} max={visual.max} color={ac} size={gaugeSize} unit={insight.bigUnit || `/ ${visual.max}`} />
          <div className="min-w-0 flex-1">
            {subMetrics.length > 0 ? (
              <div className="space-y-1.5">
                {subMetrics.map((m) => (
                  <div key={m.label}>
                    <div className="flex items-center justify-between leading-none mb-0.5">
                      <span className="text-[9px] capitalize text-muted-foreground truncate">{m.label}</span>
                      <span className="text-[9px] font-bold tabular-nums" style={{ color: ac }}>{Math.round(m.pct)}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, m.pct)}%`, backgroundColor: ac }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {insight.trendPct != null && Math.abs(insight.trendPct) >= 2 && (
                  <span className="text-[10px] font-semibold flex items-center gap-0.5" style={{ color: insight.trendDir === "up" ? "#16a34a" : insight.trendDir === "down" ? "#dc2626" : "hsl(var(--muted-foreground))" }}>
                    {insight.trendDir === "up" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {Math.abs(Math.round(insight.trendPct))}%
                  </span>
                )}
                {insight.hasData && (
                  <p className="text-[10px] text-muted-foreground leading-snug line-clamp-3 mt-0.5">{insight.insight}</p>
                )}
              </>
            )}
          </div>
        </div>
      ) : visual.type === "checklist" ? (
        /* Medication / supplement: taken-vs-due rows. */
        <div className="flex-1 px-3 pt-1 min-h-0 flex flex-col justify-center gap-2">
          {medChecklist && <ChecklistMini items={medChecklist} color={ac} />}
          {importance !== "compact" && insight.hasData && (
            <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">{insight.insight}</p>
          )}
        </div>
      ) : visual.type === "panel" ? (
        /* Lab panel: several reference-ranged metrics as labeled zone bars. */
        <div className="flex-1 px-3 pt-1.5 min-h-0 flex flex-col justify-center">
          <MultiMetricBars metrics={visual.metrics} />
        </div>
      ) : visual.type === "activity" && activityData ? (
        /* Activity/duration: latest value + weekly session bars + week stats. */
        <>
          <div className="px-3 pt-1 flex items-baseline gap-1 shrink-0">
            <span className={`leading-none font-black tabular-nums ${importance === "compact" ? "text-[22px]" : "text-[28px]"}`} style={{ color: ac }}>
              {insight.bigPrimary}
            </span>
            {insight.bigUnit && <span className="text-[11px] font-medium text-muted-foreground">{insight.bigUnit}</span>}
          </div>
          {/* overflow-hidden so a tight card clips here instead of bleeding the
              chips up over the value line; chips stay on ONE line (no wrap). */}
          <div className="flex-1 min-h-0 flex flex-col justify-end overflow-hidden">
            {activityChips.length > 0 && (
              <div className="px-3 flex items-center gap-1.5 flex-nowrap overflow-hidden mb-1.5">
                {activityChips.map((c, i) => (
                  <span key={i} className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5 shrink-0 whitespace-nowrap" style={{ background: `hsl(${catAccent} / 0.14)`, color: ac }}>
                    <span aria-hidden>{c.emoji}</span><span className="font-medium tabular-nums">{c.label}</span>
                  </span>
                ))}
              </div>
            )}
            <p className="px-3 text-[10px] text-muted-foreground mb-1.5 truncate">
              This week: <span className="font-semibold text-foreground">{activityData.total} {activityData.unit}</span>
              {" · "}{activityData.sessions} session{activityData.sessions === 1 ? "" : "s"}
              {activityData.sessions > 0 ? ` · ~${activityData.avg}/session` : ""}
            </p>
            <div className="px-3 pb-2"><WeekdayBars data={activityData.series} color={ac} height={importance === "large" ? 52 : importance === "compact" ? 34 : 44} /></div>
          </div>
        </>
      ) : (
        <>
          {/* Big metric (+ goal ring on the right for goal-based trackers) */}
          <div className="px-3 pt-1 pb-0 flex items-start justify-between gap-2">
            <div className="flex items-baseline gap-1 min-w-0">
              <span
                className={`leading-none font-black tabular-nums ${importance === "compact" ? "text-[22px]" : "text-[28px]"}`}
                style={{ color: ac }}
              >
                {insight.bigPrimary}
              </span>
              {insight.bigUnit && (
                <span className="text-[11px] font-medium text-muted-foreground">{insight.bigUnit}</span>
              )}
              {insight.trendPct != null && Math.abs(insight.trendPct) >= 2 && (
                <span
                  className="ml-1 text-[10px] font-semibold flex items-center gap-0.5"
                  style={{ color: insight.trendDir === "up" ? "#16a34a" : insight.trendDir === "down" ? "#dc2626" : "hsl(var(--muted-foreground))" }}
                >
                  {insight.trendDir === "up" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                  {Math.abs(Math.round(insight.trendPct))}%
                </span>
              )}
            </div>
            {visual.type === "ring" && (
              <RingProgress pct={visual.pct} color={ac} size={importance === "compact" ? 46 : 54} centerLabel={`${Math.round(visual.pct)}%`} />
            )}
          </div>

          {/* Body: insight sentence + a lush full-bleed chart (or padded gauge) */}
          <div className="flex-1 min-h-0 flex flex-col justify-end overflow-hidden">
            {importance !== "compact" && insight.hasData && (
              <p className="px-3 text-[10px] text-muted-foreground leading-snug line-clamp-1 mb-1">
                {insight.insight}
              </p>
            )}
            {visual.type === "gauge" ? (
              <div className="px-3 pb-2"><LinearZoneGauge value={visual.value} min={visual.min} max={visual.max} zones={visual.zones} /></div>
            ) : visual.type === "areaZone" ? (
              <div className="w-full"><TrendArea values={visual.values} color={ac} min={visual.min} max={visual.max} zones={visual.zones} height={importance === "large" ? 58 : importance === "compact" ? 34 : 46} /></div>
            ) : visual.type === "spark" && insight.sparkValues.length >= 2 ? (
              <div className="w-full">
                {useZoneArea
                  ? <ZoneAreaChart values={insight.sparkValues} color={ac} height={importance === "large" ? 58 : importance === "compact" ? 34 : 46} />
                  : <TrendArea values={insight.sparkValues} color={ac} height={importance === "large" ? 58 : importance === "compact" ? 34 : 46} />}
              </div>
            ) : visual.type === "spark" && insight.hasData ? (
              <div className="px-3 pb-2"><div className="w-full h-px bg-gradient-to-r from-transparent via-muted-foreground/20 to-transparent" /></div>
            ) : null}
          </div>
        </>
      )}

      {/* Footer: status pill (left) + time-ago (right) */}
      <div className="px-3 pb-2.5 pt-1 flex items-center justify-between">
        {insight.statusBadge ? (
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: insight.statusBadge.bg, color: insight.statusBadge.fg }}
          >
            {insight.statusBadge.label}
          </span>
        ) : (
          <span
            className="text-[10px] font-semibold capitalize px-2 py-0.5 rounded-full"
            style={{ backgroundColor: `hsl(${catAccent} / 0.15)`, color: ac }}
          >
            {tracker.category || 'custom'}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground tabular-nums">{timeAgo || `${entries.length} entries`}</span>
      </div>
    </div>
  );
}
// ── EntryRow ───────────────────────────────────────────────────────────────────

// ── EntryEditor ─────────────────────────────────────────────────────────────
// Shared per-entry editor: edit ANY field's value, delete individual fields,
// add brand-new fields, and edit the note — for EVERY tracker entry regardless
// of how its row is displayed (compact row, blood-pressure row, history row).
// The backend PATCH honors `values` (upsert) + `valuesToDelete` (remove).
function EntryEditor({
  entry,
  tracker,
  onClose,
}: {
  entry: TrackerEntry;
  tracker: Tracker;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Seed the editor with EVERY field this tracker uses — the schema fields plus
  // any field that appears on ANY of its entries — so common fields (e.g.
  // "intensity") show as fillable inputs even on an entry that doesn't have them
  // yet. Previously the editor only showed fields already on THIS entry, which
  // forced users into the clunky "add a field" box (and that box silently
  // dropped values if you hit Save before tapping "+ Add").
  const seed = () => {
    const v: Record<string, any> = {};
    for (const f of tracker.fields || []) {
      if (f?.name && f.name !== "_notes") v[f.name] = "";
    }
    for (const e of tracker.entries || []) {
      for (const k of Object.keys(e.values || {})) {
        if (k !== "_notes" && !(k in v)) v[k] = "";
      }
    }
    for (const [k, val] of Object.entries(entry.values || {})) {
      if (k !== "_notes") v[k] = val;
    }
    return v;
  };
  const [editVals, setEditVals] = useState<Record<string, any>>(seed);
  const [editNotes, setEditNotes] = useState<string>((entry.values?._notes as string) || (entry as any).notes || "");
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");

  const editMutation = useMutation<any, Error, Record<string, any>, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: (vals: Record<string, any>) => {
      // Keys that existed on the entry but are gone from the final values →
      // explicit delete signal. Remaining keys are upserted.
      const orig = Object.keys(entry.values || {}).filter((k) => k !== "_notes");
      const valuesToDelete = orig.filter((k) => !(k in vals));
      return apiRequest("PATCH", `/api/trackers/${tracker.id}/entries/${entry.id}`, {
        values: vals,
        valuesToDelete,
        notes: editNotes,
      });
    },
    // Optimistic: rebuild the entry's values from the final values so adds, edits
    // AND deletes reflect instantly. Roll back if the server rejects. Handles
    // both array caches (the tracker lists) and single-object caches so the
    // detail view refreshes the moment Save is tapped — no waiting on a refetch.
    onMutate: async (vals: Record<string, any>) => {
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/trackers"] });
      const patchEntry = (e: any) => {
        if (e?.id !== entry.id) return e;
        const nv: any = { ...vals };
        if (editNotes) nv._notes = editNotes;
        return { ...e, values: nv, notes: editNotes };
      };
      const patchTracker = (t: any) => {
        if (t?.id !== tracker.id || !Array.isArray(t.entries)) return t;
        return { ...t, entries: t.entries.map(patchEntry) };
      };
      queryClient.setQueriesData({ queryKey: ["/api/trackers"] }, (old: any) => {
        if (Array.isArray(old)) return old.map(patchTracker);
        if (old && typeof old === "object" && old.id === tracker.id) return patchTracker(old);
        return old;
      });
      return { prev };
    },
    onSuccess: () => {
      onClose();
      toast({ title: "Entry updated" });
    },
    onError: (err: Error, _vars, context) => {
      if (context?.prev) {
        for (const [key, value] of context.prev) queryClient.setQueryData(key, value);
      }
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      // Cache bus uses refetchType "active" — same semantics this site wanted.
      invalidateDomain("trackers");
    },
  });

  // Build the final values and submit. Critically, this FLUSHES a pending
  // "add a field" the user typed but didn't tap "+ Add" — the bug that silently
  // dropped "intensity = extreme" — and strips empty inputs so blank fields
  // aren't written.
  const handleSave = () => {
    const merged: Record<string, any> = { ...editVals };
    const pendingName = newFieldName.trim();
    if (pendingName) {
      const raw = newFieldValue.trim();
      const num = Number(raw);
      merged[pendingName] = raw !== "" && !isNaN(num) && String(num) === raw ? num : newFieldValue;
    }
    const cleaned: Record<string, any> = {};
    for (const [k, val] of Object.entries(merged)) {
      if (val === "" || val === null || val === undefined) continue;
      cleaned[k] = val;
    }
    editMutation.mutate(cleaned);
  };

  const fieldIsNumeric = (k: string) => {
    const def = tracker.fields.find((f) => f.name.toLowerCase() === k.toLowerCase());
    if (def) return def.type === "number";
    return typeof entry.values[k] === "number";
  };
  const setField = (k: string, raw: string) =>
    setEditVals((prev) => ({ ...prev, [k]: fieldIsNumeric(k) ? (raw === "" ? "" : parseFloat(raw)) : raw }));
  const removeField = (k: string) =>
    setEditVals((prev) => { const n = { ...prev }; delete n[k]; return n; });
  const addField = () => {
    const name = newFieldName.trim();
    if (!name) return;
    const raw = newFieldValue.trim();
    const num = Number(raw);
    const val = raw !== "" && !isNaN(num) && String(num) === raw ? num : newFieldValue;
    setEditVals((prev) => ({ ...prev, [name]: val }));
    setNewFieldName("");
    setNewFieldValue("");
  };

  const keys = Object.keys(editVals);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-primary/30 px-2.5 py-2 text-xs bg-primary/5"
      data-testid={`entry-row-edit-${entry.id}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Existing fields — edit value or delete the field */}
      <div className="flex flex-col gap-1.5">
        {keys.length === 0 && (
          <span className="text-muted-foreground italic">No fields — add one below.</span>
        )}
        {keys.map((k) => {
          const def = tracker.fields.find((f) => f.name.toLowerCase() === k.toLowerCase());
          const selectOptions = def?.type === "select" && Array.isArray((def as any).options) ? ((def as any).options as string[]).filter(Boolean) : null;
          return (
          <div key={k} className="flex items-center gap-1.5">
            <label className="text-muted-foreground w-24 shrink-0 truncate" title={k}>{humanizeFieldName(k)}</label>
            {typeof editVals[k] === "boolean" ? (
              <Checkbox
                checked={!!editVals[k]}
                onCheckedChange={(v) => setEditVals((prev) => ({ ...prev, [k]: !!v }))}
              />
            ) : selectOptions && selectOptions.length > 0 ? (
              <Select value={String(editVals[k] ?? "")} onValueChange={(val) => setEditVals((prev) => ({ ...prev, [k]: val }))}>
                <SelectTrigger className="h-6 flex-1 text-xs px-1.5" data-testid={`entry-field-${k}`}><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {selectOptions.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                className="h-6 flex-1 text-xs px-1.5"
                type={fieldIsNumeric(k) ? "number" : "text"}
                value={editVals[k] ?? ""}
                onChange={(e) => setField(k, e.target.value)}
                data-testid={`entry-field-${k}`}
              />
            )}
            <button
              type="button"
              onClick={() => removeField(k)}
              className="p-0.5 rounded hover:bg-destructive/15 transition-colors"
              title={`Remove "${k}"`}
              aria-label={`Remove field ${k}`}
              data-testid={`entry-field-delete-${k}`}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
            </button>
          </div>
          );
        })}
      </div>

      {/* Notes */}
      <div className="flex items-center gap-1.5">
        <label className="text-muted-foreground w-24 shrink-0">notes</label>
        <Input
          className="h-6 flex-1 text-xs px-1.5"
          value={editNotes}
          placeholder="Optional note"
          onChange={(e) => setEditNotes(e.target.value)}
        />
      </div>

      {/* Add a new field */}
      <div className="flex items-center gap-1.5 border-t border-border/50 pt-1.5">
        <Input
          className="h-6 w-24 text-xs px-1.5"
          placeholder="new field"
          value={newFieldName}
          onChange={(e) => setNewFieldName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addField(); }}
          data-testid="entry-new-field-name"
        />
        <Input
          className="h-6 flex-1 text-xs px-1.5"
          placeholder="value"
          value={newFieldValue}
          onChange={(e) => setNewFieldValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addField(); }}
          data-testid="entry-new-field-value"
        />
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={addField} disabled={!newFieldName.trim()}>
          <Plus className="h-3 w-3 mr-0.5" />Add
        </Button>
      </div>

      <div className="flex items-center gap-1 justify-end">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onClose}>Cancel</Button>
        <Button size="sm" className="h-6 px-2 text-xs" onClick={handleSave} disabled={editMutation.isPending} data-testid={`entry-save-${entry.id}`}>
          <Check className="h-3 w-3 mr-1" />Save
        </Button>
      </div>
    </div>
  );
}

// ── EntryRow ───────────────────────────────────────────────────────────────────

function EntryRow({
  entry,
  tracker,
  primaryField,
}: {
  entry: TrackerEntry;
  tracker: Tracker;
  primaryField: string;
}) {
  const [editing, setEditing] = useState(false);

  const primaryVal = entry.values[primaryField];
  const otherFields = tracker.fields.filter((f) => f.name !== primaryField);
  const bpS = entry.values["systolic"] ?? entry.values["systolic_pressure"] ?? entry.values["sbp"];
  const bpD = entry.values["diastolic"] ?? entry.values["diastolic_pressure"] ?? entry.values["dbp"];
  const isEntryBP = typeof bpS === "number" && typeof bpD === "number";
  const entryNotes = (entry.values["_notes"] as string | undefined) || (entry as any).notes;

  if (editing) {
    return <EntryEditor entry={entry} tracker={tracker} onClose={() => setEditing(false)} />;
  }

  return (
    <div
      className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer"
      data-testid={`entry-row-${entry.id}`}
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
      title="Tap to edit, add, or remove fields"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="font-medium tabular-nums">
            {isEntryBP ? `${bpS}/${bpD}` : (primaryVal !== undefined ? String(primaryVal) : "—")}
          </span>
          {isEntryBP ? (
            <span className="text-muted-foreground text-xs">mmHg</span>
          ) : tracker.unit ? (
            <span className="text-muted-foreground text-xs">{tracker.unit}</span>
          ) : null}
          {!isEntryBP && otherFields.map((f) => {
            const v = entry.values[f.name];
            if (v === undefined || v === "" || f.name === "_notes") return null;
            return (
              <span key={f.name} className="text-muted-foreground text-xs">
                {trackerFieldLabel(f)}: {String(v)}{f.unit ? ` ${f.unit}` : ""}
              </span>
            );
          })}
        </div>
        {entryNotes && (
          <p className="text-muted-foreground mt-0.5 truncate">{entryNotes}</p>
        )}
        <ComputedBadges computed={entry.computed} />
        <span className="text-muted-foreground text-xs">
          {new Date(entry.timestamp).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setEditing(true)} className="p-0.5 rounded hover:bg-muted transition-colors" title="Edit entry">
          <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        </button>
        <DeleteEntryButton trackerId={tracker.id} entryId={entry.id} entry={entry} />
      </div>
    </div>
  );
}

// ── CreateTrackerDialog ────────────────────────────────────────────────────────

const CATEGORIES = ["custom", "finance", "fitness", "habit", "health", "nutrition", "sleep"] as const;
const FIELD_TYPES = ["boolean", "duration", "number", "select", "text"] as const;

type FieldDraft = {
  name: string;
  type: "number" | "text" | "boolean" | "select" | "duration";
  unit: string;
  options: string; // comma-separated for select
};

// Starter templates for the create flow — one tap pre-fills name, category,
// unit, and fields so a new tracker looks polished immediately (and so the
// right card visual is chosen). "Custom" keeps the manual builder.
type TrackerTemplate = {
  id: string;
  label: string;
  iconKind: TrackerInsight["iconKind"];
  category: string;
  unit: string;
  fields: FieldDraft[];
  sample: number;
};
const TRACKER_TEMPLATES: TrackerTemplate[] = [
  { id: "weight", label: "Weight", iconKind: "weight", category: "health", unit: "lbs", sample: 170, fields: [{ name: "weight", type: "number", unit: "lbs", options: "" }] },
  { id: "bloodpressure", label: "Blood Pressure", iconKind: "bp", category: "health", unit: "mmHg", sample: 118, fields: [{ name: "systolic", type: "number", unit: "mmHg", options: "" }, { name: "diastolic", type: "number", unit: "mmHg", options: "" }] },
  { id: "heartrate", label: "Heart Rate", iconKind: "activity", category: "health", unit: "bpm", sample: 72, fields: [{ name: "heart rate", type: "number", unit: "bpm", options: "" }] },
  { id: "glucose", label: "Blood Sugar", iconKind: "drop", category: "health", unit: "mg/dL", sample: 95, fields: [{ name: "glucose", type: "number", unit: "mg/dL", options: "" }] },
  { id: "bmi", label: "BMI", iconKind: "weight", category: "health", unit: "", sample: 24, fields: [{ name: "bmi", type: "number", unit: "", options: "" }] },
  { id: "cholesterol", label: "Cholesterol", iconKind: "activity", category: "health", unit: "mg/dL", sample: 180, fields: [{ name: "ldl", type: "number", unit: "mg/dL", options: "" }, { name: "hdl", type: "number", unit: "mg/dL", options: "" }] },
  { id: "sleep", label: "Sleep", iconKind: "sleep", category: "sleep", unit: "hr", sample: 7.5, fields: [{ name: "hours", type: "number", unit: "hr", options: "" }] },
  { id: "steps", label: "Steps", iconKind: "walk", category: "fitness", unit: "steps", sample: 8200, fields: [{ name: "steps", type: "number", unit: "steps", options: "" }] },
  { id: "hydration", label: "Hydration", iconKind: "drop", category: "health", unit: "oz", sample: 64, fields: [{ name: "ounces", type: "number", unit: "oz", options: "" }] },
  { id: "calories", label: "Calories", iconKind: "flame", category: "nutrition", unit: "cal", sample: 2000, fields: [{ name: "calories", type: "number", unit: "cal", options: "" }] },
  { id: "running", label: "Running", iconKind: "run", category: "fitness", unit: "mi", sample: 3, fields: [{ name: "distance", type: "number", unit: "mi", options: "" }, { name: "duration", type: "duration", unit: "min", options: "" }] },
  { id: "mood", label: "Mood", iconKind: "brain", category: "health", unit: "/ 10", sample: 8, fields: [{ name: "mood", type: "number", unit: "", options: "" }] },
  { id: "strength", label: "Strength", iconKind: "dumbbell", category: "fitness", unit: "lbs", sample: 185, fields: [{ name: "weight", type: "number", unit: "lbs", options: "" }, { name: "reps", type: "number", unit: "reps", options: "" }] },
  { id: "reading", label: "Reading", iconKind: "book", category: "habit", unit: "min", sample: 30, fields: [{ name: "minutes", type: "number", unit: "min", options: "" }, { name: "pages", type: "number", unit: "pages", options: "" }] },
  { id: "meditation", label: "Meditation", iconKind: "brain", category: "health", unit: "min", sample: 15, fields: [{ name: "minutes", type: "number", unit: "min", options: "" }] },
  { id: "activity", label: "Activity / Sport", iconKind: "activity", category: "fitness", unit: "min", sample: 30, fields: [{ name: "minutes", type: "number", unit: "min", options: "" }] },
];

// Live, static preview of how the finished tracker card will look — mirrors
// TrackerCard's shell and reuses the same visual selector + viz primitives so
// what the user sees here is what they get on the board.
function TrackerCardPreview({ name, category, unit, fields, sample }: {
  name: string; category: string; unit: string; fields: FieldDraft[]; sample: number;
}) {
  const catAccent = getCategoryAccent(category);
  const ac = `hsl(${catAccent})`;
  const Icon = iconForKind("activity");
  const primaryField = fields.find(f => f.name.trim() && (f.type === "number" || f.type === "duration"))?.name.trim() || fields[0]?.name.trim() || "value";
  const fakeTracker = { name: name || "New Tracker", category, unit, fields: fields.map(f => ({ name: f.name, type: f.type, unit: f.unit })) } as any;
  const fakeInsight = { kind: "generic", progressPct: null } as unknown as TrackerInsight;
  // Synthetic latest entry so panel/checklist previews can resolve.
  const fakeEntry = { timestamp: new Date().toISOString(), values: Object.fromEntries(fields.filter(f => f.name.trim() && (f.type === "number" || f.type === "duration")).map(f => [f.name.trim(), sample])) } as any;
  const visual = chooseCardVisual(fakeTracker, fakeInsight, { field: primaryField, num: sample }, fakeEntry);
  const bigPrimary = Number.isInteger(sample) ? sample.toLocaleString() : sample.toFixed(1);
  const series = [sample * 0.92, sample * 0.97, sample, sample * 1.01, sample * 0.99, sample];
  return (
    <div
      className="rounded-xl overflow-hidden flex flex-col relative"
      style={{ ["--accent-hsl" as any]: catAccent, height: 150 }}
    >
      <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${catAccent} / 0.2)`, color: ac }}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="text-[13px] font-semibold text-foreground truncate leading-tight flex-1">{name || "New Tracker"}</p>
      </div>
      {visual.type === "radial" ? (
        <div className="flex-1 px-3 pt-1 min-h-0 flex items-center gap-3">
          <RadialGauge value={visual.value} max={visual.max} color={ac} size={70} unit={unit || `/ ${visual.max}`} />
          <p className="text-[10px] text-muted-foreground leading-snug">Looking good — this is how your score will read.</p>
        </div>
      ) : visual.type === "checklist" ? (
        <div className="flex-1 px-3 pt-1 min-h-0 flex flex-col justify-center gap-2">
          <ChecklistMini items={[{ label: unit ? `Daily dose (${unit})` : "Daily dose", done: true }]} color={ac} />
          <p className="text-[10px] text-muted-foreground leading-snug">Check off each dose as you take it.</p>
        </div>
      ) : visual.type === "panel" ? (
        <div className="flex-1 px-3 pt-1.5 min-h-0 flex flex-col justify-center">
          <MultiMetricBars metrics={visual.metrics} />
        </div>
      ) : visual.type === "activity" ? (
        <>
          <div className="px-3 pt-1 flex items-baseline gap-1">
            <span className="leading-none font-black tabular-nums text-[28px]" style={{ color: ac }}>{bigPrimary}</span>
            {unit && <span className="text-[11px] font-medium text-muted-foreground">{unit}</span>}
          </div>
          <div className="flex-1 min-h-0 flex flex-col justify-end">
            <div className="px-3 flex items-center gap-1.5 mb-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5" style={{ background: `hsl(${catAccent} / 0.14)`, color: ac }}>⚡ <span className="font-medium">Moderate</span></span>
              <span className="inline-flex items-center gap-1 text-[10px] rounded-full px-1.5 py-0.5" style={{ background: `hsl(${catAccent} / 0.14)`, color: ac }}>❤️ <span className="font-medium">—</span></span>
            </div>
            <p className="px-3 text-[10px] text-muted-foreground mb-1.5">This week: <span className="font-semibold text-foreground">{sample} {unit || "min"}</span> · 1 session</p>
            <div className="px-3 pb-2"><WeekdayBars data={[0, sample * 0.5, 0, sample * 0.8, sample * 0.4, 0, sample].map((v, i) => ({ label: ["S", "M", "T", "W", "T", "F", "S"][i], value: Math.round(v), today: i === 6 }))} color={ac} height={44} /></div>
          </div>
        </>
      ) : (
        <>
          <div className="px-3 pt-1 flex items-start justify-between gap-2">
            <div className="flex items-baseline gap-1 min-w-0">
              <span className="leading-none font-black tabular-nums text-[28px]" style={{ color: ac }}>{bigPrimary}</span>
              {unit && <span className="text-[11px] font-medium text-muted-foreground">{unit}</span>}
            </div>
            {visual.type === "ring" && <RingProgress pct={visual.pct} color={ac} size={54} centerLabel={`${Math.round(visual.pct)}%`} />}
          </div>
          <div className="flex-1 min-h-0 flex flex-col justify-end">
            {visual.type === "gauge" ? (
              <div className="px-3 pb-2"><LinearZoneGauge value={visual.value} min={visual.min} max={visual.max} zones={visual.zones} /></div>
            ) : visual.type === "areaZone" ? (
              <div className="w-full"><TrendArea values={visual.values} color={ac} min={visual.min} max={visual.max} zones={visual.zones} height={46} /></div>
            ) : (
              <div className="w-full"><TrendArea values={series} color={ac} height={46} /></div>
            )}
          </div>
        </>
      )}
      <div className="px-3 pb-2.5 pt-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold capitalize px-2 py-0.5 rounded-full" style={{ backgroundColor: `hsl(${catAccent} / 0.15)`, color: ac }}>{category || "custom"}</span>
        <span className="text-[10px] text-muted-foreground">Preview</span>
      </div>
    </div>
  );
}

function CreateTrackerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("custom");
  const [unit, setUnit] = useState("");
  const [fields, setFields] = useState<FieldDraft[]>([
    { name: "value", type: "number", unit: "", options: "" },
  ]);
  // Which starter template is selected (null = Custom / manual builder).
  const [templateId, setTemplateId] = useState<string | null>(null);
  const applyTemplate = (t: TrackerTemplate | null) => {
    setTemplateId(t?.id ?? null);
    if (!t) return; // Custom: leave current fields/name as-is for manual entry
    setName(t.label);
    setCategory(t.category);
    setUnit(t.unit);
    setFields(t.fields.map(f => ({ ...f })));
  };
  // Sample value used to render the live preview.
  const previewSample = TRACKER_TEMPLATES.find(t => t.id === templateId)?.sample ?? 100;

  // RACE FIX: name/category/unit/fields are snapshotted into mutation VARIABLES
  // by the submit handler — the old no-arg mutationFn read component state that
  // the handler reset immediately after mutate(), so the request was built from
  // an emptied form ("Name required" on a filled form).
  type NewTrackerVars = { name: string; category: string; unit: string; fields: typeof fields };
  const mutation = useMutation<any, Error, NewTrackerVars, { prev: [readonly unknown[], unknown][]; tempId: string } | undefined>({
    mutationFn: async (vars) => {
      if (!vars.name.trim()) { toast({ title: "Name required", description: "Enter a tracker name", variant: "destructive" }); throw new Error("Name required"); }
      const INVALID_NAMES = ["tracker", "log", "new tracker", "custom tracker", "my tracker", "track"];
      if (INVALID_NAMES.includes(vars.name.trim().toLowerCase())) {
        toast({ title: "Be more specific", description: "Give this tracker a descriptive name like 'Blood Pressure' or 'Morning Run'", variant: "destructive" });
        throw new Error("Generic name");
      }
      let builtFields = vars.fields
        .filter((f) => f.name.trim())
        .map((f, i) => ({
          name: f.name.trim(),
          type: f.type,
          unit: f.unit.trim() || undefined,
          isPrimary: i === 0,
          options:
            f.type === "select" && f.options
              ? f.options.split(",").map((o) => o.trim()).filter(Boolean)
              : undefined,
        }));
      // If no fields defined, create a default "value" field
      if (builtFields.length === 0) {
        builtFields = [{ name: "value", type: "number", unit: vars.unit.trim() || undefined, isPrimary: true, options: undefined }];
      }

      // PR H: attach canonical metric definition derived from category, with
      // user-supplied name and unit applied as surface overrides.
      const baseDef = getDefaultMetricDefinition(vars.category);
      const metricDefinition: TrackerMetricDefinition = {
        ...baseDef,
        metric: vars.name.trim() || baseDef.metric,
        unit: vars.unit.trim() || baseDef.unit,
        unitDisplay: vars.unit.trim() || baseDef.unitDisplay,
      };
      const res = await apiRequest("POST", "/api/trackers", {
        name: vars.name.trim(),
        category: vars.category,
        unit: vars.unit.trim() || undefined,
        fields: builtFields,
        metricDefinition,
      });
      return res.json();
    },
    onMutate: async (vars) => {
      // Optimistic create: prepend a temp tracker so the list updates instantly.
      // Skip validation errors here — mutationFn will throw them and we'll roll back.
      if (!vars.name.trim()) return undefined;
      const INVALID_NAMES = ["tracker", "log", "new tracker", "custom tracker", "my tracker", "track"];
      if (INVALID_NAMES.includes(vars.name.trim().toLowerCase())) return undefined;

      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/trackers"] });
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const builtFields = vars.fields
        .filter((f) => f.name.trim())
        .map((f, i) => ({
          name: f.name.trim(),
          type: f.type,
          unit: f.unit.trim() || undefined,
          isPrimary: i === 0,
          options: f.type === "select" && f.options
            ? f.options.split(",").map((o) => o.trim()).filter(Boolean)
            : undefined,
        }));
      const tempTracker: any = {
        id: tempId,
        name: vars.name.trim(),
        category: vars.category,
        unit: vars.unit.trim() || undefined,
        fields: builtFields.length > 0 ? builtFields : [{ name: "value", type: "number", unit: vars.unit.trim() || undefined, isPrimary: true }],
        entries: [],
        createdAt: new Date().toISOString(),
        _optimistic: true,
      };
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
        Array.isArray(old) ? [tempTracker, ...old] : old
      );
      return { prev, tempId };
    },
    onSuccess: () => {
      invalidateDomain("trackers");
      setName("");
      setCategory("custom");
      setUnit("");
      setFields([{ name: "value", type: "number", unit: "", options: "" }]);
      setTemplateId(null);
      onOpenChange(false);
      toast({ title: "Tracker created" });
    },
    onError: (err: Error, _vars, ctx) => {
      // Rollback optimistic insert
      if (ctx?.prev) {
        for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data);
      }
      // BUG-CRUD01: surface a clearer, more actionable toast when the server
      // says the tracker name already exists (409) so the user knows their
      // click did register but was deduplicated, instead of seeing a silent
      // failure or a generic "Failed" message.
      const msg = formatApiError(err);
      const isDup = /already exists/i.test(msg);
      toast({
        title: isDup ? "Tracker already exists" : "Failed to create tracker",
        description: isDup
          ? `A tracker with this name already exists for the selected profile. Open the existing one or rename this one.`
          : msg,
        variant: "destructive",
      });
    },
  });

  const updateField = (i: number, patch: Partial<FieldDraft>) => {
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  };

  const addField = () => {
    setFields((prev) => [...prev, { name: "", type: "number", unit: "", options: "" }]);
  };

  const removeField = (i: number) => {
    setFields((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleClose = () => {
    setName("");
    setCategory("custom");
    setUnit("");
    setFields([{ name: "value", type: "number", unit: "", options: "" }]);
    setTemplateId(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-create-tracker">
        <DialogHeader>
          <DialogTitle>Create New Tracker</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Template picker — one tap pre-fills name/category/unit/fields */}
          <div>
            <Label className="text-xs font-medium">Start from a template</Label>
            <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2" data-testid="tracker-template-grid">
              {TRACKER_TEMPLATES.map((t) => {
                const TIcon = iconForKind(t.iconKind);
                const tAccent = getCategoryAccent(t.category);
                const selected = templateId === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    data-testid={`tracker-template-${t.id}`}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-1.5 py-2 transition-all hover:scale-[1.03] ${selected ? "ring-2" : ""}`}
                    style={{
                      borderColor: `hsl(${tAccent} / ${selected ? 0.6 : 0.25})`,
                      background: `hsl(${tAccent} / ${selected ? 0.16 : 0.07})`,
                      ...(selected ? { boxShadow: `0 0 0 2px hsl(${tAccent} / 0.4)` } : {}),
                    }}
                  >
                    <span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `hsl(${tAccent} / 0.2)`, color: `hsl(${tAccent})` }}>
                      <TIcon className="h-4 w-4" />
                    </span>
                    <span className="text-[10px] font-medium text-center leading-tight">{t.label}</span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => applyTemplate(null)}
                data-testid="tracker-template-custom"
                className={`flex flex-col items-center gap-1 rounded-xl border border-dashed px-1.5 py-2 transition-all hover:scale-[1.03] ${templateId === null ? "ring-2 ring-primary/40 bg-muted/40" : "bg-muted/20"}`}
              >
                <span className="w-7 h-7 rounded-lg flex items-center justify-center bg-muted/50 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </span>
                <span className="text-[10px] font-medium">Custom</span>
              </button>
            </div>
          </div>

          {/* Live preview of the finished card */}
          <div>
            <Label className="text-xs font-medium">Preview</Label>
            <div className="mt-2">
              <TrackerCardPreview name={name} category={category} unit={unit} fields={fields} sample={previewSample} />
            </div>
          </div>

          {/* Name */}
          <div>
            <Label htmlFor="tracker-name" className="text-xs font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="tracker-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Blood Pressure, Weight, Sleep"
              className="mt-1"
              data-testid="input-tracker-name"
            />
          </div>

          {/* Category */}
          <div>
            <Label className="text-xs font-medium">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="mt-1" data-testid="select-tracker-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c} className="capitalize">
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Unit */}
          <div>
            <Label htmlFor="tracker-unit" className="text-xs font-medium">
              Unit (optional)
            </Label>
            <Input
              id="tracker-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="e.g. lbs, hours, mmHg"
              className="mt-1"
              data-testid="input-tracker-unit"
            />
            <p className="text-xs text-muted-foreground mt-1">Optional — e.g., lbs, miles, hours</p>
          </div>

          {/* Fields builder */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs font-medium">Fields</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={addField}
                data-testid="button-add-field"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Field
              </Button>
            </div>

            <div className="space-y-3">
              {fields.map((f, i) => (
                <div
                  key={i}
                  className="rounded-md border p-3 space-y-2 bg-muted/30"
                  data-testid={`field-row-${i}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Input
                        value={f.name}
                        onChange={(e) => updateField(i, { name: e.target.value })}
                        placeholder="Field name"
                        className="h-8 text-sm"
                        data-testid={`input-field-name-${i}`}
                      />
                    </div>
                    <Select
                      value={f.type}
                      onValueChange={(v: any) => updateField(i, { type: v })}
                    >
                      <SelectTrigger className="w-28 h-8 text-xs" data-testid={`select-field-type-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className="text-xs capitalize">
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => removeField(i)}
                        data-testid={`button-remove-field-${i}`}
                        aria-label={`Remove field ${i + 1}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>

                  {/* Unit for this field */}
                  {(f.type === "number" || f.type === "duration") && (
                    <Input
                      value={f.unit}
                      onChange={(e) => updateField(i, { unit: e.target.value })}
                      placeholder="Unit (optional, e.g. kg, min)"
                      className="h-7 text-xs"
                      data-testid={`input-field-unit-${i}`}
                    />
                  )}

                  {/* Options for select type */}
                  {f.type === "select" && (
                    <Input
                      value={f.options}
                      onChange={(e) => updateField(i, { options: e.target.value })}
                      placeholder="Options (comma-separated, e.g. good, fair, poor)"
                      className="h-7 text-xs"
                      data-testid={`input-field-options-${i}`}
                    />
                  )}

                  {i === 0 && (
                    <p className="text-xs text-muted-foreground">Primary field (used for chart & main value)</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={handleClose} data-testid="button-create-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!name.trim()) return;
              const INVALID_NAMES = ["tracker", "log", "new tracker", "custom tracker", "my tracker", "track"];
              const isGeneric = INVALID_NAMES.includes(name.trim().toLowerCase());
              // Snapshot the payload BEFORE resetting the form (race fix).
              mutation.mutate({ name, category, unit, fields });
              // Close immediately when input is valid — optimistic update has
              // already prepended the tracker. If the name is generic, keep the dialog
              // open so the user can fix it (mutationFn will toast the error).
              if (!isGeneric) {
                setName("");
                setCategory("custom");
                setUnit("");
                setFields([{ name: "value", type: "number", unit: "", options: "" }]);
                onOpenChange(false);
              }
            }}
            disabled={mutation.isPending || !name.trim()}
            data-testid="button-create-submit"
          >
            {mutation.isPending ? "Creating..." : "Create Tracker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── DeleteTrackerDialog ────────────────────────────────────────────────────────

function DeleteTrackerDialog({
  trackerId,
  trackerName,
  open,
  onOpenChange,
}: {
  trackerId: string;
  trackerName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/trackers/${trackerId}`);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueryData<any[]>(["/api/trackers"]);
      queryClient.setQueryData<any[]>(["/api/trackers"], (old) => old?.filter((t: any) => t.id !== trackerId));
      return { prev };
    },
    onSuccess: () => {
      invalidateDomain("trackers");
      onOpenChange(false);
      toast({ title: "Tracker deleted", description: `${trackerName} has been removed` });
    },
    onError: (err: Error, _v: void, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/trackers"], ctx.prev);
      toast({ title: "Failed to delete tracker", description: formatApiError(err), variant: "destructive" });
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={`alert-delete-tracker-${trackerId}`}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{trackerName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete this tracker and all its entries. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-delete-tracker-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutation.mutate()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            data-testid="button-delete-tracker-confirm"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? "Deleting..." : "Delete Tracker"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Tracker Summary ────────────────────────────────────────────────────────────

function computeBestStreak(trackers: Tracker[]): { name: string; streak: number } {
  let best = { name: "", streak: 0 };
  for (const t of trackers) {
    if (t.entries.length === 0) continue;
    // Get unique days with entries
    const days = new Set(
      t.entries.map((e) => new Date(e.timestamp).toDateString())
    );
    const sorted = Array.from(days)
      .map((d) => new Date(d).getTime())
      .sort((a, b) => b - a); // newest first

    let streak = 1;
    let maxStreak = 1;
    const MS_PER_DAY = 86400000;
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i - 1] - sorted[i];
      if (diff <= MS_PER_DAY + 3600000) {
        // within ~1 day tolerance
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 1;
      }
    }
    if (maxStreak > best.streak) {
      best = { name: t.name, streak: maxStreak };
    }
  }
  return best;
}

function TrackerSummary({ trackers, profiles, onTrackerClick }: { trackers: Tracker[]; profiles?: { id: string; name: string }[]; onTrackerClick?: (trackerId: string) => void }) {
  if (trackers.length === 0) return null;

  // Entries this week
  const weekAgo = Date.now() - 7 * 86400000;
  const weeklyEntries = trackers.reduce(
    (sum, t) => sum + t.entries.filter((e) => new Date(e.timestamp).getTime() >= weekAgo).length,
    0
  );

  // Most active tracker
  const mostActive = trackers.reduce(
    (best, t) => {
      const count = t.entries.filter((e) => new Date(e.timestamp).getTime() >= weekAgo).length;
      return count > best.count ? { name: t.name, count, lp: t.linkedProfiles } : best;
    },
    { name: "", count: 0, lp: [] as string[] }
  );

  // Best streak
  const bestStreak = computeBestStreak(trackers);

  // Health score
  const healthScore = computeHealthScore(trackers);

  const healthScoreColor =
    healthScore === null ? "text-muted-foreground"
      : healthScore >= 80 ? "text-green-600 dark:text-green-400"
      : healthScore >= 60 ? "text-yellow-600 dark:text-yellow-400"
      : "text-red-600 dark:text-red-400";

  return (
    <div className="grid grid-cols-4 gap-1.5" data-testid="tracker-summary">
      <div className="flex flex-col items-center p-1.5 rounded-md border border-border/30" data-testid="summary-weekly-entries">
        <span className="text-sm font-bold tabular-nums" style={{ color: CHART_COLORS.primary }}>{weeklyEntries}</span>
        <span className="text-xs-tight text-muted-foreground">This Week</span>
      </div>
      <button
        className="flex flex-col items-center p-1.5 rounded-md border border-border/30 hover:bg-muted/40 active:scale-95 transition-all cursor-pointer"
        data-testid="summary-most-active"
        onClick={() => { const t = trackers.find(t => t.name === mostActive.name); if (t && onTrackerClick) onTrackerClick(t.id); }}
        title={mostActive.count > 0 ? `Open ${mostActive.name}` : undefined}
      >
        <span className="text-xs font-bold truncate w-full text-center" style={{ color: CHART_COLORS.tertiary }}>{mostActive.count > 0 ? cleanTrackerName(mostActive.name, profiles, mostActive.lp) : "—"}</span>
        <span className="text-xs-tight text-muted-foreground">{mostActive.count > 0 ? `${mostActive.count} entries` : "Most Active"}</span>
      </button>
      <div className="flex flex-col items-center p-1.5 rounded-md border border-border/30" data-testid="summary-best-streak">
        <span className="text-sm font-bold tabular-nums" style={{ color: CHART_COLORS.gold }}>{bestStreak.streak > 0 ? `${bestStreak.streak}d` : "—"}</span>
        <span className="text-xs-tight text-muted-foreground truncate w-full text-center">{bestStreak.name ? cleanTrackerName(bestStreak.name, profiles) : "Streak"}</span>
      </div>
      <div className="flex flex-col items-center p-1.5 rounded-md border border-border/30" data-testid="summary-health-score">
        <span className={`text-sm font-bold tabular-nums ${healthScoreColor}`}>{healthScore !== null ? healthScore : "—"}</span>
        <span className="text-xs-tight text-muted-foreground">{healthScore !== null ? (healthScore >= 80 ? "Excellent" : healthScore >= 60 ? "Good" : "Low") : "Health"}</span>
      </div>
      {/* Canonical group breakdown */}
      <div className="col-span-4 flex flex-wrap gap-1.5 pt-1">
        {Object.entries(
          trackers.reduce((acc: Record<string, number>, t) => {
            const g = getCanonicalGroup(t.category);
            acc[g] = (acc[g] || 0) + 1;
            return acc;
          }, {})
        ).sort(([a], [b]) => (CANONICAL_GROUPS[a]?.order ?? 99) - (CANONICAL_GROUPS[b]?.order ?? 99))
        .map(([group, count]) => {
          const def = CANONICAL_GROUPS[group];
          const Ico = def?.icon || Box;
          const accent = def?.accent || "240 20% 60%";
          return (
            <span key={group} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
                  style={{ background: `hsl(${accent} / 0.12)`, color: `hsl(${accent})` }}>
              <Ico className="h-2.5 w-2.5" />
              {group} ({count})
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── TrackerDetailDialog — Fully Dynamic Tabs ─────────────────────────────────

type DynamicTab = {
  id: string;
  label: string;
  icon: any;
};

function generateDynamicTabs(tracker: Tracker): DynamicTab[] {
  const tabs: DynamicTab[] = [{ id: "overview", label: "Overview", icon: BarChart2 }];
  const entries = tracker.entries;
  const numericFields = tracker.fields.filter(f => f.type === "number");
  const spec = detectSpecialization(tracker);
  const cat = tracker.category.toLowerCase();
  const name = tracker.name.toLowerCase();

  // Trends tab: show when enough data
  if (entries.length >= 5) {
    tabs.push({ id: "trends", label: "Trends", icon: ChartLine });
  }

  // Breakdown tab: for multi-field trackers (nutrition, BP, exercise)
  const isNutrition = cat === "nutrition" || name.includes("nutrition") || name.includes("food") || name.includes("diet");
  const isBP = spec === "bloodpressure";
  const isExercise = spec === "running" || cat === "fitness";
  const isSleep = spec === "sleep";
  if ((isNutrition || isBP || isExercise || isSleep) && entries.length >= 2) {
    tabs.push({ id: "breakdown", label: "Breakdown", icon: PieChartIcon });
  }

  // Correlations: 2+ numeric fields with enough data
  if (numericFields.length >= 2 && entries.length >= 5) {
    tabs.push({ id: "correlations", label: "Correlations", icon: Brain });
  }

  // History always shows
  if (entries.length > 0) {
    tabs.push({ id: "history", label: "History", icon: ListChecks });
  }

  // Insights: when enough data for pattern detection
  if (entries.length >= 3) {
    tabs.push({ id: "insights", label: "Insights", icon: Lightbulb });
  }

  // Goals tab always shows
  tabs.push({ id: "goals", label: "Goals", icon: Target });

  return tabs;
}

// -- Helper: compute stats for a numeric field over entries
function computeFieldStats(entries: TrackerEntry[], field: string) {
  const nums = entries.map(e => typeof e.values[field] === "number" ? e.values[field] as number : NaN).filter(n => !isNaN(n));
  if (nums.length === 0) return null;
  const latest = nums[nums.length - 1];
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  // Trend: compare last 25% avg to first 25% avg
  const q = Math.max(1, Math.floor(nums.length / 4));
  const recentAvg = nums.slice(-q).reduce((a, b) => a + b, 0) / q;
  const earlyAvg = nums.slice(0, q).reduce((a, b) => a + b, 0) / q;
  const trendPct = earlyAvg !== 0 ? ((recentAvg - earlyAvg) / earlyAvg) * 100 : 0;
  return { latest, avg, min, max, trendPct, count: nums.length };
}

// -- Helper: compute 7-day moving average
function movingAverage(entries: TrackerEntry[], field: string, window = 7): { date: string; value: number; ma: number | null }[] {
  const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const result: { date: string; value: number; ma: number | null }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const val = typeof sorted[i].values[field] === "number" ? sorted[i].values[field] as number : NaN;
    if (isNaN(val)) continue;
    const windowEntries = sorted.slice(Math.max(0, i - window + 1), i + 1);
    const windowNums = windowEntries.map(e => typeof e.values[field] === "number" ? e.values[field] as number : NaN).filter(n => !isNaN(n));
    const ma = windowNums.length >= Math.min(3, window) ? windowNums.reduce((a, b) => a + b, 0) / windowNums.length : null;
    result.push({
      date: new Date(sorted[i].timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: val,
      ma,
    });
  }
  return result;
}

// -- Helper: compute logging streak
function computeStreak(entries: TrackerEntry[]): number {
  if (entries.length === 0) return 0;
  const dates = [...new Set(entries.map(e => new Date(e.timestamp).toDateString()))].sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < dates.length; i++) {
    const d = new Date(dates[i]);
    d.setHours(0, 0, 0, 0);
    const expected = new Date(today);
    expected.setDate(expected.getDate() - i);
    if (d.getTime() === expected.getTime()) {
      streak++;
    } else if (i === 0 && d.getTime() === new Date(today.getTime() - 86400000).getTime()) {
      // Allow streak to start from yesterday
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// -- Overview Tab
// Dynamic KPI cards derived from the tracker's metric kind (the presentation
// engine). Additive metrics (water, calories, miles) summarize as a daily
// TOTAL; measurements (weight, heart rate, glucose) as latest + range.
function computeDynamicKpis(
  entries: TrackerEntry[],
  primaryField: string,
  pres: TrackerPresentation,
  timeRange: TimeRange,
): { label: string; value: string; sub: string }[] {
  const unit = pres.unit || "";
  const fmt = (n: number) => {
    const r = Math.round(n * 100) / 100;
    return unit === "$" ? `$${r.toLocaleString()}` : `${r.toLocaleString()}`;
  };
  const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const nums = sorted.map(e => Number(e.values?.[primaryField])).filter(v => !isNaN(v) && isFinite(v));
  if (nums.length === 0) return [];
  const rangeSub = timeRange === "all" ? "all time" : timeRange;

  if (pres.metricKind === "additive") {
    const byDay = new Map<string, number>();
    for (const e of sorted) {
      const v = Number(e.values?.[primaryField]);
      if (!isFinite(v)) continue;
      const k = new Date(e.timestamp).toLocaleDateString("en-CA");
      byDay.set(k, (byDay.get(k) || 0) + v);
    }
    const totals = [...byDay.values()];
    const total = totals.reduce((a, b) => a + b, 0);
    const days = byDay.size || 1;
    return [
      { label: "Total", value: fmt(total), sub: unit || rangeSub },
      { label: "Avg / day", value: fmt(total / days), sub: unit || rangeSub },
      { label: "Peak", value: fmt(Math.max(...totals)), sub: `${unit || "day"} max` },
      { label: "Days logged", value: String(byDay.size), sub: rangeSub },
    ];
  }
  // measurement / categorical / dual / unknown → latest reading + range
  return [
    { label: "Latest", value: fmt(nums[nums.length - 1]), sub: unit },
    { label: "Average", value: fmt(nums.reduce((a, b) => a + b, 0) / nums.length), sub: unit || rangeSub },
    { label: "Low", value: fmt(Math.min(...nums)), sub: unit },
    { label: "High", value: fmt(Math.max(...nums)), sub: unit },
  ];
}

// Phase 3: per-metric-kind accent colour so each tracker reads as its own thing.
const KIND_ACCENT: Record<string, string> = {
  additive: "text-cyan-500",
  measurement: "text-violet-500",
  dual: "text-rose-500",
  adherence: "text-red-500",
  categorical: "text-amber-500",
  unknown: "text-foreground",
};

// Phase 4: one-line, kind-aware insight summarising the data.
function dynamicOverviewInsight(entries: TrackerEntry[], primaryField: string, pres: TrackerPresentation): string {
  const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const nums = sorted.map(e => Number(e.values?.[primaryField])).filter(v => !isNaN(v) && isFinite(v));
  if (nums.length === 0) return "";
  const u = pres.unit ? ` ${pres.unit}` : "";
  const round = (n: number) => (n % 1 === 0 ? n : Math.round(n * 10) / 10);
  if (pres.metricKind === "additive") {
    const byDay = new Map<string, number>();
    for (const e of sorted) { const v = Number(e.values?.[primaryField]); if (!isFinite(v)) continue; const k = new Date(e.timestamp).toLocaleDateString("en-CA"); byDay.set(k, (byDay.get(k) || 0) + v); }
    const total = [...byDay.values()].reduce((a, b) => a + b, 0);
    const days = byDay.size || 1;
    return `Averaging ${round(total / days)}${u} per day across ${days} day${days === 1 ? "" : "s"}.`;
  }
  if (nums.length < 2) return `First reading: ${round(nums[0])}${u}.`;
  const q = Math.max(1, Math.floor(nums.length / 4));
  const recent = nums.slice(-q).reduce((a, b) => a + b, 0) / q;
  const early = nums.slice(0, q).reduce((a, b) => a + b, 0) / q;
  const diff = early !== 0 ? ((recent - early) / early) * 100 : 0;
  const dir = Math.abs(diff) < 2 ? "holding steady" : diff > 0 ? `up ${round(Math.abs(diff))}%` : `down ${round(Math.abs(diff))}%`;
  return `Latest ${round(nums[nums.length - 1])}${u} · ${dir} vs earlier.`;
}

// Daily-total bar chart for additive metrics (water/calories/miles/minutes).
function AdditiveDailyBars({ entries, primaryField, unit, goalValue }: { entries: TrackerEntry[]; primaryField: string; unit?: string; goalValue?: number }) {
  const byDay = new Map<string, number>();
  for (const e of entries) {
    const v = Number(e.values?.[primaryField]);
    if (!isFinite(v)) continue;
    byDay.set(new Date(e.timestamp).toLocaleDateString("en-CA"), (byDay.get(new Date(e.timestamp).toLocaleDateString("en-CA")) || 0) + v);
  }
  const data = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ date: new Date(k + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }), value: Math.round(v * 100) / 100 }));
  if (data.length === 0) {
    return (
      <div className="h-[200px] flex flex-col items-center justify-center text-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        <BarChart2 className="h-7 w-7 text-muted-foreground/30 mb-2" />
        <p className="text-sm text-muted-foreground">No numeric data yet — tap “+ Add” to log one.</p>
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [`${v}${unit ? ` ${unit}` : ""}`, "Daily total"]} />
        {typeof goalValue === "number" && goalValue > 0 && (
          <ReferenceLine y={goalValue} stroke={CHART_COLORS.gold} strokeDasharray="4 4" label={{ value: "Goal", position: "right", fontSize: 10, fill: CHART_COLORS.gold }} />
        )}
        <Bar dataKey="value" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0] as any} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function OverviewTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const specialization = detectSpecialization(tracker);
  // Dynamic presentation spec — drives KPI cards, chart style, units by metric
  // kind (additive/measurement/dual/…) instead of one-size-fits-all.
  const pres = classifyTrackerPresentation(tracker as any);
  const filtered = filterEntriesByRange(tracker.entries, timeRange);
  // Force Recharts to remount when data changes (ResponsiveContainer caching issue)
  const chartKey = `${tracker.id}-${tracker.entries.length}-${timeRange}`;
  const stats = computeFieldStats(filtered, primaryField);
  const streak = computeStreak(tracker.entries);
  const dynamicKpis = computeDynamicKpis(filtered, primaryField, pres, timeRange);
  // Additive standard trackers (hydration, calories, steps…) render daily-total
  // bars; everything else keeps its line/specialized chart.
  const useAdditiveBars = specialization === "standard" && pres.metricKind === "additive";

  // Goal ring — only when the user actually created a goal for this tracker.
  const { data: overviewGoals = [] } = useQuery<Goal[]>({ queryKey: goalsQueryKey([]) });
  const trackerGoal = overviewGoals.find((g) => g && g.trackerId === tracker.id && g.status === "active" && typeof g.target === "number");
  const goalProgress = (() => {
    if (!trackerGoal || !pres.primaryField || trackerGoal.target <= 0) return null;
    const fld = pres.primaryField;
    let current = 0;
    let scope = "latest";
    if (pres.metricKind === "additive") {
      const todayKey = new Date().toLocaleDateString("en-CA");
      current = tracker.entries
        .filter((e) => new Date(e.timestamp).toLocaleDateString("en-CA") === todayKey)
        .reduce((s, e) => { const v = Number(e.values?.[fld]); return s + (isFinite(v) ? v : 0); }, 0);
      scope = "today";
    } else {
      const sorted = [...filtered].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const nums = sorted.map((e) => Number(e.values?.[fld])).filter((v) => isFinite(v));
      current = nums.length ? nums[nums.length - 1] : 0;
    }
    const pct = Math.max(0, Math.min(100, Math.round((current / trackerGoal.target) * 100)));
    return { current, target: trackerGoal.target, pct, scope, unit: trackerGoal.unit || pres.unit, met: current >= trackerGoal.target };
  })();

  const timeRangeBtns: { label: string; value: TimeRange }[] = [
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
    { label: "All", value: "all" },
  ];

  // Medication trackers get their own specialized view
  if (specialization === 'medication') return <MedicationOverview tracker={tracker} />;

  return (
    <div className="space-y-4">
      {/* KPI Row — dynamic by metric kind (Phase 1), accent-coloured (Phase 3) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {dynamicKpis.length > 0 ? (
          dynamicKpis.map((k, i) => (
            <div key={i} className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider truncate">{k.label}</p>
              <p className={`text-lg font-bold tabular-nums truncate ${i === 0 ? (KIND_ACCENT[pres.metricKind] || "text-foreground") : ""}`} title={k.value}>{k.value}</p>
              <p className="text-xs text-muted-foreground truncate">{k.sub}</p>
            </div>
          ))
        ) : (
          <div className="col-span-2 sm:col-span-4 bg-muted/30 rounded-lg p-3 text-center text-xs text-muted-foreground">
            No numeric data yet — log an entry to see summaries.
          </div>
        )}
      </div>

      {/* Phase 4: dynamic, kind-aware insight line */}
      {dynamicKpis.length > 0 && (() => {
        const insight = dynamicOverviewInsight(filtered, primaryField, pres);
        return insight ? (
          <div className={`text-xs rounded-md px-3 py-2 bg-muted/40 flex items-center gap-1.5`}>
            <span className={KIND_ACCENT[pres.metricKind] || "text-primary"}>●</span>
            <span className="text-muted-foreground">{insight}</span>
          </div>
        ) : null;
      })()}

      {/* Goal ring/progress — only when a real goal exists for this tracker */}
      {goalProgress && (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Goal · {goalProgress.scope}</span>
            <span className={`text-xs font-bold ${goalProgress.met ? "text-emerald-500" : "text-primary"}`}>
              {goalProgress.met ? "✓ Goal met" : `${goalProgress.pct}%`}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${goalProgress.met ? "bg-emerald-500" : "bg-primary"}`}
              style={{ width: `${goalProgress.pct}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            {Math.round(goalProgress.current * 10) / 10}{goalProgress.unit ? ` ${goalProgress.unit}` : ""} of {goalProgress.target}{goalProgress.unit ? ` ${goalProgress.unit}` : ""} goal
            {!goalProgress.met && goalProgress.target > goalProgress.current ? ` · ${Math.round((goalProgress.target - goalProgress.current) * 10) / 10} to go` : ""}
          </p>
        </div>
      )}

      {/* Time range selector */}
      <div className="flex items-center gap-1">
        {timeRangeBtns.map(btn => (
          <button key={btn.value}
            className={`px-2.5 py-0.5 rounded text-xs-loose font-medium transition-colors ${timeRange === btn.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            onClick={() => setTimeRange(btn.value)}>
            {btn.label}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">{filtered.length} entries</span>
      </div>

      {/* Chart */}
      {filtered.length > 0 ? (
        <div className="h-[200px]" key={chartKey}>
          {specialization === "weight" && <WeightDetailChart entries={filtered} primaryField={primaryField} unit={tracker.unit} />}
          {specialization === "bloodpressure" && <BloodPressureDetailChart entries={filtered} />}
          {specialization === "sleep" && <SleepDetailChart entries={filtered} primaryField={primaryField} />}
          {specialization === "running" && <RunningDetailChart entries={filtered} primaryField={primaryField} />}
          {specialization === "standard" && (useAdditiveBars
            ? <AdditiveDailyBars entries={filtered} primaryField={primaryField} unit={pres.unit} goalValue={trackerGoal?.target} />
            : <StandardDetailChart entries={filtered} primaryField={primaryField} unit={pres.unit || tracker.unit} goalValue={trackerGoal?.target} />)}
        </div>
      ) : (
        <div className="text-center py-8">
          <BarChart2 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No entries in this time range</p>
        </div>
      )}

      {/* Stats summary */}
      {filtered.length > 0 && (
        <StatsRow entries={filtered} primaryField={primaryField} unit={tracker.unit} isBP={specialization === "bloodpressure"} />
      )}
    </div>
  );
}

// -- Trends Tab
function TrendsTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const maData = useMemo(() => movingAverage(tracker.entries, primaryField, 7), [tracker.entries, primaryField]);

  // Period comparison
  const now = Date.now();
  const thisWeek = tracker.entries.filter(e => now - new Date(e.timestamp).getTime() < 7 * 86400000);
  const lastWeek = tracker.entries.filter(e => {
    const diff = now - new Date(e.timestamp).getTime();
    return diff >= 7 * 86400000 && diff < 14 * 86400000;
  });
  const thisWeekAvg = (() => {
    const nums = thisWeek.map(e => typeof e.values[primaryField] === "number" ? e.values[primaryField] as number : NaN).filter(n => !isNaN(n));
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  })();
  const lastWeekAvg = (() => {
    const nums = lastWeek.map(e => typeof e.values[primaryField] === "number" ? e.values[primaryField] as number : NaN).filter(n => !isNaN(n));
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  })();
  const weekDiff = thisWeekAvg != null && lastWeekAvg != null && lastWeekAvg !== 0
    ? ((thisWeekAvg - lastWeekAvg) / lastWeekAvg * 100) : null;

  return (
    <div className="space-y-4">
      {/* Period comparison */}
      {thisWeekAvg != null && lastWeekAvg != null && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-muted/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground uppercase">This Week Avg</p>
            <p className="text-lg font-bold tabular-nums">{thisWeekAvg.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{tracker.unit || ""}</span></p>
            <p className="text-xs text-muted-foreground">{thisWeek.length} entries</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground uppercase">Last Week Avg</p>
            <p className="text-lg font-bold tabular-nums">{lastWeekAvg.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{tracker.unit || ""}</span></p>
            <p className="text-xs text-muted-foreground">{lastWeek.length} entries</p>
          </div>
        </div>
      )}
      {weekDiff != null && (
        <div className={`text-xs rounded-md px-3 py-2 ${weekDiff > 0 ? "bg-orange-500/10 text-orange-600" : weekDiff < 0 ? "bg-green-500/10 text-green-600" : "bg-muted text-muted-foreground"}`}>
          {Math.abs(weekDiff) < 1 ? "Holding steady week-over-week" :
           `${weekDiff > 0 ? "Up" : "Down"} ${Math.abs(weekDiff).toFixed(1)}% from last week`}
        </div>
      )}

      {/* Moving average chart */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">7-Day Moving Average</p>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={maData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
              <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40} domain={["auto", "auto"]} />
              <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
              <Bar dataKey="value" fill={CHART_COLORS.light} radius={[2, 2, 0, 0]} name="Value" />
              <Line dataKey="ma" stroke={CHART_COLORS.primary} strokeWidth={2.5} dot={false} name="7d Avg" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Trend analysis text */}
      {(() => {
        const allStats = computeFieldStats(tracker.entries, primaryField);
        if (!allStats) return null;
        return (
          <div className="text-xs text-muted-foreground space-y-1 bg-muted/30 rounded-md p-3">
            <p>Range: {allStats.min.toFixed(1)} – {allStats.max.toFixed(1)} {tracker.unit || ""} across {allStats.count} readings</p>
            <p>Overall trend: {allStats.trendPct > 1 ? `increasing (+${allStats.trendPct.toFixed(1)}%)` : allStats.trendPct < -1 ? `decreasing (${allStats.trendPct.toFixed(1)}%)` : "stable"}</p>
          </div>
        );
      })()}
    </div>
  );
}

// -- Breakdown Tab (nutrition macros, BP distribution, etc.)
function BreakdownTabContent({ tracker }: { tracker: Tracker }) {
  const spec = detectSpecialization(tracker);
  const cat = tracker.category.toLowerCase();
  const name = tracker.name.toLowerCase();
  const isNutrition = cat === "nutrition" || name.includes("nutrition") || name.includes("food") || name.includes("diet");
  const entries = tracker.entries;

  if (isNutrition) {
    // Macros breakdown
    const macroTotals = entries.reduce((acc, e) => {
      acc.protein += (typeof e.values.protein === "number" ? e.values.protein : 0);
      acc.carbs += (typeof e.values.carbs === "number" ? e.values.carbs : 0);
      acc.fat += (typeof e.values.fat === "number" ? e.values.fat : 0);
      acc.sugar += (typeof e.values.sugar === "number" ? e.values.sugar : 0);
      acc.fiber += (typeof e.values.fiber === "number" ? e.values.fiber : 0);
      acc.calories += (typeof e.values.calories === "number" ? e.values.calories : 0);
      return acc;
    }, { protein: 0, carbs: 0, fat: 0, sugar: 0, fiber: 0, calories: 0 });
    const macroTotal = macroTotals.protein + macroTotals.carbs + macroTotals.fat;
    const pieData = [
      { name: "Protein", value: macroTotals.protein, color: CHART_COLORS.primary },
      { name: "Carbs", value: macroTotals.carbs, color: CHART_COLORS.gold },
      { name: "Fat", value: macroTotals.fat, color: CHART_COLORS.secondary },
    ].filter(d => d.value > 0);

    // Daily calorie chart
    const dailyCals = entries.reduce((acc: Record<string, number>, e) => {
      const d = new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      acc[d] = (acc[d] || 0) + (typeof e.values.calories === "number" ? e.values.calories : 0);
      return acc;
    }, {});
    const calData = Object.entries(dailyCals).map(([date, cal]) => ({ date, calories: Math.round(cal) }));

    return (
      <div className="space-y-5">
        {/* Macro averages */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground uppercase">Avg Protein</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.protein / entries.length).toFixed(0) : 0}g</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground uppercase">Avg Carbs</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.carbs / entries.length).toFixed(0) : 0}g</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-xs text-muted-foreground uppercase">Avg Fat</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.fat / entries.length).toFixed(0) : 0}g</p>
          </div>
        </div>
        {macroTotals.sugar > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase">Total Sugar</p>
              <p className="text-base font-bold tabular-nums">{macroTotals.sugar.toFixed(0)}g</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase">Total Fiber</p>
              <p className="text-base font-bold tabular-nums">{macroTotals.fiber.toFixed(0)}g</p>
            </div>
          </div>
        )}

        {/* Macro distribution pie */}
        {pieData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Macro Distribution</p>
            <div className="h-[180px] flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}
                    label={({ name, value }) => `${name}: ${macroTotal > 0 ? Math.round(value / macroTotal * 100) : 0}%`}>
                    {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(value: number) => `${value.toFixed(0)}g`} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Daily calories bar */}
        {calData.length > 1 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Daily Calories</p>
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={calData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40} />
                  <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Bar dataKey="calories" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (spec === "bloodpressure") {
    // BP category distribution
    const categories = entries.map(e => e.computed?.bloodPressureCategory || "unknown").filter(c => c !== "unknown");
    const catCounts = categories.reduce((acc: Record<string, number>, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {});
    const catColors: Record<string, string> = { normal: CHART_COLORS.primary, elevated: CHART_COLORS.gold, high_stage1: CHART_COLORS.secondary, high_stage2: CHART_COLORS.warning, crisis: "#dc2626" };
    const bpPieData = Object.entries(catCounts).map(([name, value]) => ({
      name: name.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
      value,
      color: catColors[name] || CHART_COLORS.tertiary,
    }));

    // Sys vs Dia comparison
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const bpLineData = sorted.slice(-20).map(e => ({
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      systolic: typeof e.values.systolic === "number" ? e.values.systolic : null,
      diastolic: typeof e.values.diastolic === "number" ? e.values.diastolic : null,
    }));

    return (
      <div className="space-y-5">
        {bpPieData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">BP Category Distribution</p>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={bpPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}
                    label={({ name, value }) => `${name}: ${value}`}>
                    {bpPieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        {bpLineData.length > 1 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Systolic vs Diastolic</p>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={bpLineData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
                  <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40} />
                  <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Line type="monotone" dataKey="systolic" stroke={CHART_COLORS.secondary} strokeWidth={2} dot={{ r: 3 }} name="Systolic" />
                  <Line type="monotone" dataKey="diastolic" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3 }} name="Diastolic" />
                  <Legend />
                  <ReferenceLine y={120} stroke={CHART_COLORS.gold} strokeDasharray="5 5" label={{ value: "Normal", fontSize: 10 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (spec === "sleep") {
    // Sleep quality distribution
    const qualities = entries.map(e => e.computed?.sleepQuality || "unknown").filter(q => q !== "unknown");
    const qCounts = qualities.reduce((acc: Record<string, number>, q) => { acc[q] = (acc[q] || 0) + 1; return acc; }, {});
    const qColors: Record<string, string> = { excellent: CHART_COLORS.primary, good: CHART_COLORS.tertiary, fair: CHART_COLORS.gold, poor: CHART_COLORS.secondary };
    const qPieData = Object.entries(qCounts).map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value, color: qColors[name] || CHART_COLORS.tertiary }));

    return (
      <div className="space-y-5">
        {qPieData.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Sleep Quality Distribution</p>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={qPieData} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}
                    label={({ name, value }) => `${name}: ${value}`}>
                    {qPieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (spec === "running" || cat === "fitness") {
    const sorted = [...entries].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const runData = sorted.slice(-20).map(e => ({
      date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      distance: typeof e.values.distance === "number" ? e.values.distance : null,
      caloriesBurned: typeof e.values.caloriesBurned === "number" ? e.values.caloriesBurned : (e.computed?.caloriesBurned || null),
    }));

    return (
      <div className="space-y-5">
        {runData.length > 1 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Distance vs Calories Burned</p>
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={runData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} interval="preserveStartEnd" allowDuplicatedCategory={false} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={35} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={35} />
                  <Tooltip contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Bar yAxisId="right" dataKey="caloriesBurned" fill={CHART_COLORS.light} radius={[2, 2, 0, 0]} name="Calories" />
                  <Line yAxisId="left" type="monotone" dataKey="distance" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3 }} name="Distance" />
                  <Legend />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Generic multi-field breakdown
  const numericFields = tracker.fields.filter(f => f.type === "number");
  if (numericFields.length >= 2) {
    const fieldStats = numericFields.map(f => {
      const s = computeFieldStats(entries, f.name);
      return { field: f.name, ...s };
    }).filter(s => s.count != null && s.count > 0);

    return (
      <div className="space-y-3">
        <p className="text-xs font-medium text-muted-foreground">Field Averages</p>
        <div className="grid grid-cols-2 gap-2">
          {fieldStats.map(s => (
            <div key={s.field} className="bg-muted/50 rounded-lg p-3">
              <p className="text-xs text-muted-foreground uppercase">{s.field}</p>
              <p className="text-base font-bold tabular-nums">{s.avg?.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">min: {s.min?.toFixed(1)} / max: {s.max?.toFixed(1)}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return <p className="text-sm text-muted-foreground">No breakdown data available for this tracker type.</p>;
}

// -- Correlations Tab
function CorrelationsTabContent({ tracker }: { tracker: Tracker }) {
  const numericFields = tracker.fields.filter(f => f.type === "number");
  const [fieldA, setFieldA] = useState(numericFields[0]?.name || "");
  const [fieldB, setFieldB] = useState(numericFields[1]?.name || "");

  const scatterData = tracker.entries.map(e => {
    const a = typeof e.values[fieldA] === "number" ? e.values[fieldA] as number : null;
    const b = typeof e.values[fieldB] === "number" ? e.values[fieldB] as number : null;
    return a != null && b != null ? { x: a, y: b } : null;
  }).filter(Boolean) as { x: number; y: number }[];

  // Simple correlation coefficient
  const corr = (() => {
    if (scatterData.length < 3) return null;
    const n = scatterData.length;
    const sumX = scatterData.reduce((s, d) => s + d.x, 0);
    const sumY = scatterData.reduce((s, d) => s + d.y, 0);
    const sumXY = scatterData.reduce((s, d) => s + d.x * d.y, 0);
    const sumX2 = scatterData.reduce((s, d) => s + d.x * d.x, 0);
    const sumY2 = scatterData.reduce((s, d) => s + d.y * d.y, 0);
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={fieldA} onValueChange={setFieldA}>
          <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {numericFields.map(f => <SelectItem key={f.name} value={f.name}>{trackerFieldLabel(f)}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">vs</span>
        <Select value={fieldB} onValueChange={setFieldB}>
          <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {numericFields.map(f => <SelectItem key={f.name} value={f.name}>{trackerFieldLabel(f)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {corr != null && (
        <div className="text-xs bg-muted/30 rounded-md p-3">
          Correlation: <span className="font-bold tabular-nums">{corr.toFixed(3)}</span>
          {" — "}
          {Math.abs(corr) > 0.7 ? "Strong" : Math.abs(corr) > 0.4 ? "Moderate" : Math.abs(corr) > 0.2 ? "Weak" : "No"}
          {corr > 0.2 ? " positive" : corr < -0.2 ? " negative" : ""} relationship
        </div>
      )}

      {scatterData.length > 0 ? (
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="x" name={fieldA} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                label={{ value: fieldA, position: "bottom", fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <YAxis dataKey="y" name={fieldB} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} width={40}
                label={{ value: fieldB, angle: -90, position: "insideLeft", fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }}
                contentStyle={{ fontSize: 12, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
              <Scatter data={scatterData} fill={CHART_COLORS.primary} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-8">Not enough matching data points</p>
      )}
    </div>
  );
}

// One row in the History list. Shows the polished read-only summary; tapping it
// (anywhere but the trash) swaps to the shared EntryEditor so the user can edit
// values, delete fields, or add new fields — full CRUD on every entry.
function HistoryEntryRow({
  entry,
  tracker,
  displayVal,
  delta,
  secondaryText,
  noteText,
}: {
  entry: TrackerEntry;
  tracker: Tracker;
  displayVal: string;
  delta: number | null;
  secondaryText: string;
  noteText: string;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <EntryEditor entry={entry} tracker={tracker} onClose={() => setEditing(false)} />;
  }

  return (
    <div
      className="group flex items-center justify-between py-2 px-3 bubble hover:bg-muted/30 transition-colors text-sm gap-2 cursor-pointer pressable"
      data-testid={`entry-row-${entry.id}`}
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
      title="Tap to edit, add, or remove fields"
    >
      <div className="flex items-center gap-2 min-w-0 flex-wrap flex-1">
        <span className="font-mono font-semibold tabular-nums text-sm">{displayVal}</span>
        {delta != null && delta !== 0 && (
          <span className={`text-xs font-medium tabular-nums ${delta < 0 ? "text-green-600" : "text-orange-500"}`}>
            {delta > 0 ? "+" : ""}{delta.toFixed(1)}
          </span>
        )}
        {secondaryText && (
          <span className="text-xs text-muted-foreground">{secondaryText}</span>
        )}
        {noteText && (
          <span className="text-xs text-muted-foreground italic truncate max-w-[140px]">"{noteText}"</span>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="text-right">
          <span className="text-xs text-muted-foreground tabular-nums block">
            {new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
          <span className="text-xs-tight text-muted-foreground/70 tabular-nums block">
            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        {/* Explicit button (not a hover-revealed icon): real <button> elements
            register on the FIRST tap on iOS, where a hover-styled div often
            needs two taps. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setEditing(true); }}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label="Edit entry"
          title="Edit entry"
          data-testid={`edit-entry-${entry.id}`}
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground transition-colors" />
        </button>
        <div onClick={(e) => e.stopPropagation()}>
          <DeleteEntryButton trackerId={tracker.id} entryId={entry.id} entry={entry} />
        </div>
      </div>
    </div>
  );
}

// -- History Tab
function HistoryTabContent({ tracker, primaryField, profiles }: { tracker: Tracker; primaryField: string; profiles?: { id: string; name: string }[] }) {
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<"all" | "7d" | "30d" | "90d">("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const sortedEntries = [...tracker.entries].reverse();

  // Profile filter: only show entries for selected profile
  const profileFiltered = profileFilter === "all" ? sortedEntries
    : sortedEntries.filter(e => normalizeFilter((e as any).forProfile) === normalizeFilter(profileFilter));

  const now = Date.now();
  const dateFilterMs: Record<string, number> = { "7d": 7*86400000, "30d": 30*86400000, "90d": 90*86400000 };
  const dateFiltered = dateFilter === "all" ? profileFiltered :
    profileFiltered.filter(e => now - new Date(e.timestamp).getTime() <= (dateFilterMs[dateFilter] || Infinity));
  const searchLower = search.toLowerCase();
  const filtered = searchLower
    ? dateFiltered.filter(e => {
        const vals = Object.values(e.values).map(v => String(v ?? "").toLowerCase()).join(" ");
        const dateStr = new Date(e.timestamp).toLocaleDateString();
        const notes = (e.values["_notes"] as string || e.notes || "").toLowerCase();
        return vals.includes(searchLower) || dateStr.includes(searchLower) || notes.includes(searchLower);
      })
    : dateFiltered;

  // Determine which profiles have entries in this tracker
  const profileIdsInEntries = [...new Set(sortedEntries.map(e => (e as any).forProfile).filter(Boolean))];
  const hasMultipleProfiles = profileIdsInEntries.length > 0;

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">({filtered.length})</span>
        {/* Profile filter chips */}
        {hasMultipleProfiles && profiles && (
          <div className="flex items-center gap-1 overflow-x-auto flex-nowrap max-w-[60vw] scrollbar-hide" style={{ WebkitOverflowScrolling: 'touch' }}>
            <button onClick={() => setProfileFilter("all")}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${profileFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
              All
            </button>
            {profileIdsInEntries.map(pid => {
              const p = profiles.find(pr => pr.id === pid);
              return p ? (
                <button key={pid} onClick={() => setProfileFilter(pid)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${profileFilter === pid ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                  {p.name}
                </button>
              ) : null;
            })}
          </div>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {(["all", "7d", "30d", "90d"] as const).map(range => (
            <button key={range}
              onClick={() => setDateFilter(range)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${dateFilter === range ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
              {range === "all" ? "All" : range}
            </button>
          ))}
        </div>
      </div>
      {sortedEntries.length > 5 && (
        <input type="text" placeholder="Search entries..." value={search} onChange={e => setSearch(e.target.value)}
          className="w-full h-7 px-2.5 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          data-testid="entry-search-input" />
      )}

      {/* Entry list */}
      <div className="space-y-1.5">
        {filtered.length === 0 ? (
          <div className="text-center py-8">
            <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{search ? "No matching entries" : "No entries yet"}</p>
          </div>
        ) : filtered.map((entry, idx) => {
          const notes = entry.values["_notes"] as string | undefined;
          const itemName = entry.values["item"] as string | undefined;
          const bpS = entry.values["systolic"] ?? entry.values["systolic_pressure"];
          const bpD = entry.values["diastolic"] ?? entry.values["diastolic_pressure"];
          const isBPEntry = typeof bpS === "number" && typeof bpD === "number";
          const isNutrition = tracker.category === "nutrition" || tracker.name.toLowerCase().includes("nutrition") || tracker.name.toLowerCase().includes("calorie");
          // Resolve the primary value robustly: prefer the declared
          // primary field, but if it has no number, scan the entry for
          // any numeric measurement. This is what stops history rows
          // from rendering "activity: 30" — the field key is just
          // metadata, not a label users should see.
          const declaredPrim = entry.values[primaryField];
          const anyNum = (declaredPrim == null || declaredPrim === "")
            ? findAnyNumericValue(entry.values)
            : null;
          const effectivePrimKey = anyNum ? anyNum.key : primaryField;
          const val = anyNum ? anyNum.num : declaredPrim;
          // Adherence (medication/supplement): the "unit" is the dose form the
          // user logged (tablet/softgel/capsule), read from the entry — never a
          // physical unit guessed from the name (the "Fish Oil → qt" bug).
          const isAdherenceEntry = classifyTrackerPresentation(tracker as any).metricKind === "adherence";
          const effectiveUnit = isAdherenceEntry
            ? String(entry.values["unit"] ?? entry.values["form"] ?? entry.values["doseForm"] ?? "").trim()
            : inferUnit(
                tracker,
                effectivePrimKey,
                tracker.fields.find(f => f.name === effectivePrimKey)?.unit,
              );
          // Secondary fields: skip the primary, notes, item, BP
          // components, AND any string field whose value just repeats
          // the tracker name ("activity: guitar" on a Guitar tracker).
          const trackerNameLower = (tracker.name || "").toLowerCase().trim();
          const secondaryVals = Object.entries(entry.values).filter(([k, v]) => {
            if (v == null || v === "") return false;
            // Reserved metadata keys and structured objects (e.g. the
            // estimation engine's provenance blob) never render as chips —
            // "_enrichment: [object Object]" was showing on history rows.
            if (k.startsWith("_") || typeof v === "object") return false;
            if (k === "notes" || k === "item") return false;
            if (k === effectivePrimKey) return false;
            if (k === "systolic" || k === "diastolic"
                || k === "systolic_pressure" || k === "diastolic_pressure") return false;
            // PR S: "unit" was wrongly stored as a value key on legacy entries; never echo it as a secondary label.
            if (k === "unit" || k === "_unit") return false;
            if (typeof v === "string" && v.trim().toLowerCase() === trackerNameLower) return false;
            return true;
          });
          const displayVal = isBPEntry ? `${bpS}/${bpD} mmHg`
            : isNutrition && itemName ? `${itemName} — ${val ?? "?"} ${tracker.unit || "cal"}`
            : val != null && val !== "" ? `${val}${effectiveUnit ? " " + effectiveUnit : (tracker.unit ? " " + tracker.unit : "")}`
            : (notes || entry.notes) ? (notes || entry.notes!)
            : "(empty)";
          const nextEntry = filtered[idx + 1];
          const nextDeclared = nextEntry?.values[primaryField];
          const nextFallback = (nextDeclared == null || nextDeclared === "") && nextEntry
            ? findAnyNumericValue(nextEntry.values)
            : null;
          const nextKey = nextFallback ? nextFallback.key : primaryField;
          const nextAny = nextFallback ? nextFallback.num : (typeof nextDeclared === "number" ? nextDeclared : null);
          // Only diff same-unit values: comparing this row's duration against
          // the next row's miles produced garbage deltas like "+58.0".
          const delta = typeof val === "number" && typeof nextAny === "number" && effectivePrimKey === nextKey
            ? val - nextAny
            : null;

          return (
            <HistoryEntryRow
              key={entry.id}
              entry={entry}
              tracker={tracker}
              displayVal={displayVal}
              delta={delta}
              secondaryText={!isBPEntry && secondaryVals.length > 0 ? secondaryVals.map(([k, v]) => `${k}: ${v}`).join(", ") : ""}
              noteText={notes || entry.notes || ""}
            />
          );
        })}
      </div>
    </div>
  );
}

// -- Insights Tab (client-side pattern detection)
function InsightsTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const insights = useMemo(() => {
    const result: { icon: string; text: string; type: "positive" | "neutral" | "warning" }[] = [];
    const entries = tracker.entries;
    const streak = computeStreak(entries);
    const stats = computeFieldStats(entries, primaryField);

    // Streak insight
    if (streak >= 3) {
      result.push({ icon: "🔥", text: `You've logged ${streak} days in a row. Keep it up.`, type: "positive" });
    } else if (streak === 0 && entries.length > 0) {
      result.push({ icon: "⏰", text: `You haven't logged today. Last entry was ${new Date(entries[entries.length - 1].timestamp).toLocaleDateString()}.`, type: "warning" });
    }

    // Trend insight
    if (stats && Math.abs(stats.trendPct) > 3) {
      const dir = stats.trendPct > 0 ? "increasing" : "decreasing";
      result.push({ icon: stats.trendPct > 0 ? "📈" : "📉", text: `${tracker.name} has been ${dir} by ${Math.abs(stats.trendPct).toFixed(1)}% overall.`, type: "neutral" });
    }

    // Best/worst
    if (stats && stats.count >= 5) {
      const sorted = [...entries].sort((a, b) => {
        const av = typeof a.values[primaryField] === "number" ? a.values[primaryField] as number : -Infinity;
        const bv = typeof b.values[primaryField] === "number" ? b.values[primaryField] as number : -Infinity;
        return bv - av;
      });
      const best = sorted[0];
      if (best) {
        result.push({ icon: "🏆", text: `Best reading: ${best.values[primaryField]} ${tracker.unit || ""} on ${new Date(best.timestamp).toLocaleDateString()}.`, type: "positive" });
      }
    }

    // Frequency insight
    if (entries.length >= 7) {
      const first = new Date(entries[0].timestamp).getTime();
      const last = new Date(entries[entries.length - 1].timestamp).getTime();
      const weeks = Math.max(1, (last - first) / (7 * 86400000));
      const perWeek = entries.length / weeks;
      result.push({ icon: "📅", text: `You log this tracker ~${perWeek.toFixed(1)} times per week on average.`, type: "neutral" });
    }

    // Anomaly detection
    if (stats && stats.count >= 7) {
      const nums = entries.map(e => typeof e.values[primaryField] === "number" ? e.values[primaryField] as number : NaN).filter(n => !isNaN(n));
      const stdDev = Math.sqrt(nums.reduce((sum, n) => sum + Math.pow(n - stats.avg, 2), 0) / nums.length);
      const recentOutliers = entries.slice(-10).filter(e => {
        const v = typeof e.values[primaryField] === "number" ? e.values[primaryField] as number : NaN;
        return !isNaN(v) && Math.abs(v - stats.avg) > 2 * stdDev;
      });
      if (recentOutliers.length > 0) {
        const o = recentOutliers[0];
        result.push({ icon: "⚠️", text: `Unusual reading on ${new Date(o.timestamp).toLocaleDateString()}: ${o.values[primaryField]} ${tracker.unit || ""} (${Math.abs((o.values[primaryField] as number) - stats.avg).toFixed(1)} away from average).`, type: "warning" });
      }
    }

    // Entry count
    result.push({ icon: "📊", text: `${entries.length} total entries since ${entries.length > 0 ? new Date(entries[0].timestamp).toLocaleDateString() : "never"}.`, type: "neutral" });

    return result;
  }, [tracker, primaryField]);

  return (
    <div className="space-y-2">
      {insights.map((insight, idx) => (
        <div key={idx} className={`flex items-start gap-3 p-3 rounded-lg border ${
          insight.type === "positive" ? "bg-green-500/5 border-green-500/20" :
          insight.type === "warning" ? "bg-orange-500/5 border-orange-500/20" :
          "bg-muted/30 border-border/50"
        }`}>
          <span className="text-base">{insight.icon}</span>
          <p className="text-sm">{insight.text}</p>
        </div>
      ))}
    </div>
  );
}

// -- Goals Tab Content (inside tracker detail)
function GoalsTabContent({ tracker }: { tracker: Tracker }) {
  // Canonical key shared with dashboard.tsx GoalsSection — see
  // shared/query-keys.ts and ARCHITECTURE.md §3. BUG-20260528-goals-key-shape
  const goalsKey = goalsQueryKey([]);
  const { data: allGoals = [] } = useQuery<any[]>({
    queryKey: goalsKey,
    queryFn: () => apiRequest("GET", "/api/goals").then(r => r.json()),
  });
  const trackerGoals = allGoals.filter(g => g.trackerId === tracker.id);
  const [creating, setCreating] = useState(false);
  const [editGoal, setEditGoal] = useState<any>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formTarget, setFormTarget] = useState("");
  const [formUnit, setFormUnit] = useState(tracker.unit || "");
  const [formDeadline, setFormDeadline] = useState("");
  const { toast } = useToast();

  // Auto-suggest goal type from tracker
  const suggestType = () => {
    const name = tracker.name.toLowerCase();
    const cat = tracker.category.toLowerCase();
    if (name.includes("weight")) return "weight_loss";
    if (name.includes("run") || name.includes("distance") || cat === "fitness") return "fitness_distance";
    if (name.includes("saving") || cat === "finance") return "savings";
    if (name.includes("sleep") || name.includes("bp") || cat === "health") return "tracker_target";
    return "tracker_target";
  };

  const createMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/goals", data).then(r => r.json()),
    onSuccess: () => {
      // Cache bus: goals + trackers domains cover goal lists, tracker links,
      // dashboard KPIs and stats in one ripple.
      invalidateDomains("goals", "trackers");
      const name = formTitle;
      setCreating(false); resetForm();
      toast({ title: `"${name}" goal created`, description: formTarget ? `Target: ${formTarget} ${formUnit}` : undefined });
    },
    onError: (e: Error) => toast({ title: "Failed to create goal", description: formatApiError(e), variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, title, ...data }: any) => apiRequest("PATCH", `/api/goals/${id}`, { title, ...data }).then(r => r.json()),
    onSuccess: (_data, variables) => {
      invalidateDomains("goals", "trackers");
      setEditGoal(null); resetForm();
      toast({ title: `"${variables.title || "Goal"}" updated` });
    },
    onError: (e: Error) => toast({ title: "Failed to update goal", description: formatApiError(e), variant: "destructive" }),
  });
  const deleteMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title?: string }) => apiRequest("DELETE", `/api/goals/${id}`),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["/api/goals"] });
      const prev = queryClient.getQueryData<any[]>(goalsKey);
      queryClient.setQueryData<any[]>(goalsKey, (old) => old?.filter((g: any) => g.id !== variables.id));
      return { prev };
    },
    onSuccess: (_data, variables) => {
      invalidateDomains("goals", "trackers");
      setEditGoal(null);
      toast({ title: `"${variables.title || "Goal"}" deleted` });
    },
    onError: (e: Error, _v: any, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(goalsKey, ctx.prev);
      toast({ title: "Failed to delete goal", description: formatApiError(e), variant: "destructive" });
    },
  });

  const resetForm = () => { setFormTitle(""); setFormTarget(""); setFormUnit(tracker.unit || ""); setFormDeadline(""); };
  const openCreate = () => { resetForm(); setCreating(true); };
  const openEdit = (g: any) => { setEditGoal(g); setFormTitle(g.title); setFormTarget(String(g.target)); setFormUnit(g.unit); setFormDeadline(g.deadline || ""); };

  const handleSave = () => {
    if (!formTitle.trim() || !formTarget) return;
    const payload = {
      title: formTitle.trim(), type: suggestType(), target: Number(formTarget),
      unit: formUnit || tracker.unit || "units", deadline: formDeadline || undefined,
      trackerId: tracker.id,
    };
    if (editGoal) updateMutation.mutate({ id: editGoal.id, ...payload });
    else createMutation.mutate(payload);
  };

  return (
    <div className="px-5 py-4 space-y-4">
      {trackerGoals.length === 0 && !creating ? (
        <div className="text-center py-6">
          <Target className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No goals for this tracker yet</p>
          <Button size="sm" variant="outline" className="mt-3 h-8 text-xs" onClick={openCreate} data-testid="btn-create-tracker-goal">
            <Target className="h-3 w-3 mr-1" /> Create Goal
          </Button>
        </div>
      ) : (
        <>
          {trackerGoals.map(g => {
            const pct = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
            const daysLeft = g.deadline ? Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 86400000) : null;
            return (
              <div key={g.id} role="button" tabIndex={0} aria-label={`Edit goal: ${g.title}`} className="rounded-lg border p-3 space-y-2 cursor-pointer hover:bg-muted/30 transition-colors pressable" onClick={() => openEdit(g)} onKeyDown={onEnterOrSpace(() => openEdit(g))} data-testid={`tracker-goal-${g.id}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{g.title}</span>
                  <Badge variant={g.status === "completed" ? "default" : "secondary"} className="text-xs capitalize">{g.status}</Badge>
                </div>
                <Progress value={pct} className="h-2" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{g.current} / {g.target} {g.unit} ({pct}%)</span>
                  {daysLeft != null && daysLeft > 0 && <span>{daysLeft} days left</span>}
                </div>
              </div>
            );
          })}
          <Button size="sm" variant="outline" className="w-full h-8 text-xs" onClick={openCreate} data-testid="btn-add-tracker-goal">
            <Plus className="h-3 w-3 mr-1" /> Add Goal
          </Button>
        </>
      )}

      {/* Create/Edit Goal inline form */}
      {(creating || editGoal) && (
        <div className="rounded-lg border p-3 space-y-3 bg-muted/20">
          <p className="text-xs font-medium">{editGoal ? "Edit Goal" : "New Goal"}</p>
          <Input value={formTitle} onChange={e => setFormTitle(e.target.value)} placeholder="Goal title" className="h-8 text-sm" data-testid="input-tracker-goal-title" />
          <div className="grid grid-cols-3 gap-2">
            <Input type="number" value={formTarget} onChange={e => setFormTarget(e.target.value)} placeholder="Target" className="h-8 text-sm" data-testid="input-tracker-goal-target" />
            <Input value={formUnit} onChange={e => setFormUnit(e.target.value)} placeholder="Unit" className="h-8 text-sm" />
            <Input type="date" value={formDeadline} onChange={e => setFormDeadline(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs flex-1" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending} data-testid="btn-save-tracker-goal">
              {editGoal ? "Update" : "Create"}
            </Button>
            {editGoal && (
              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deleteMutation.mutate({ id: editGoal.id, title: editGoal.title })} data-testid="btn-delete-tracker-goal">
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setCreating(false); setEditGoal(null); resetForm(); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// -- Main TrackerDetailDialog
function TrackerDetailDialog({
  tracker,
  open,
  onClose,
}: {
  tracker: Tracker | null;
  open: boolean;
  onClose: () => void;
}) {
  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [deleteTrackerOpen, setDeleteTrackerOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: allProfiles } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const [isRenaming, setIsRenaming] = useState(false);

  const renameMutation = useMutation({
    mutationFn: async ({ name }: { name: string }) => {
      if (!tracker) return;
      await apiRequest("PATCH", `/api/trackers/${tracker.id}`, { name });
    },
    onSuccess: () => {
      invalidateDomain("trackers");
      toast({ title: "Tracker renamed" });
      setIsRenaming(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to rename tracker", description: formatApiError(err), variant: "destructive" });
    },
  });

  const deleteTrackerMut = useMutation({
    mutationFn: async () => {
      if (!tracker) return;
      await apiRequest("DELETE", `/api/trackers/${tracker.id}`);
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = qc.getQueryData<any[]>(["/api/trackers"]);
      if (tracker) {
        qc.setQueryData<any[]>(["/api/trackers"], (old) => old?.filter((t: any) => t.id !== tracker.id));
      }
      return { prev };
    },
    onSuccess: () => {
      invalidateDomain("trackers");
      toast({ title: "Tracker deleted" });
      onClose();
    },
    onError: (err: Error, _v: void, ctx: any) => {
      if (ctx?.prev) qc.setQueryData(["/api/trackers"], ctx.prev);
      toast({ title: "Failed to delete tracker", description: formatApiError(err), variant: "destructive" });
    },
  });

  if (!tracker) return null;

  const primaryField = tracker.fields.find((f) => f.isPrimary)?.name || tracker.fields.find((f) => f.type === "number")?.name || tracker.fields[0]?.name || "value";
  const tabs = generateDynamicTabs(tracker);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) { setAddEntryOpen(false); setDeleteTrackerOpen(false); onClose(); } }}>
        <DialogContent className="max-w-2xl h-[90vh] max-h-[90vh] flex flex-col p-0" data-testid="tracker-detail-dialog">
          {/* ── Header ── */}
          <div className="px-5 pt-5 pb-3 pr-12 border-b shrink-0">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <DialogTitle className="text-base font-semibold truncate">
                  <EditableTitle
                    value={cleanTrackerName(tracker.name, allProfiles, tracker.linkedProfiles)}
                    onSave={(newName) => renameMutation.mutateAsync({ name: newName })}
                    editing={isRenaming}
                    onEditingChange={setIsRenaming}
                    className="text-base font-semibold"
                  />
                </DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  {tracker.entries.length} {tracker.entries.length === 1 ? "entry" : "entries"}
                  {tracker.unit ? ` · ${tracker.unit}` : ""}
                  {tracker.category ? ` · ${tracker.category}` : ""}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" onClick={() => setAddEntryOpen(true)} data-testid="button-add-entry-detail" className="h-7 text-xs">
                  <Plus className="w-3 h-3 mr-1" /> Add
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" data-testid="button-tracker-detail-menu" aria-label="Tracker actions">
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setIsRenaming(true)} data-testid="button-rename-tracker-detail">
                      <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDeleteTrackerOpen(true)} data-testid="button-delete-tracker-detail">
                      <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete Tracker
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          {/* ── Dynamic Tabbed Content ── */}
          <div className="flex-1 overflow-y-auto min-h-0" style={{ WebkitOverflowScrolling: "touch" }}>
            <Tabs defaultValue="overview" className="h-full flex flex-col">
              <div className="px-5 pt-2 sticky top-0 z-20 bg-background border-b border-border/50">
                <div className="overflow-x-auto -mx-1 px-1 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
                  <TabsList className="inline-flex h-8 w-max gap-0.5 p-0.5 bg-muted/50">
                    {tabs.map(tab => {
                      const Icon = tab.icon;
                      return (
                        <TabsTrigger key={tab.id} value={tab.id} className="text-xs-loose px-2.5 py-1 h-7 gap-1 data-[state=active]:bg-background" data-testid={`tab-${tab.id}`}>
                          <Icon className="w-3 h-3" />
                          {tab.label}
                        </TabsTrigger>
                      );
                    })}
                  </TabsList>
                </div>
              </div>

              <div className="flex-1 px-5 py-4">
                <TabsContent value="overview" className="mt-0">
                  <OverviewTabContent tracker={tracker} primaryField={primaryField} />
                </TabsContent>
                <TabsContent value="trends" className="mt-0">
                  <TrendsTabContent tracker={tracker} primaryField={primaryField} />
                </TabsContent>
                <TabsContent value="breakdown" className="mt-0">
                  <BreakdownTabContent tracker={tracker} />
                </TabsContent>
                <TabsContent value="correlations" className="mt-0">
                  <CorrelationsTabContent tracker={tracker} />
                </TabsContent>
                <TabsContent value="history" className="mt-0">
                  <HistoryTabContent tracker={tracker} primaryField={primaryField} profiles={allProfiles} />
                </TabsContent>
                <TabsContent value="insights" className="mt-0">
                  <InsightsTabContent tracker={tracker} primaryField={primaryField} />
                </TabsContent>
                <TabsContent value="goals" className="mt-0">
                  <GoalsTabContent tracker={tracker} />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Add Entry sub-dialog ── */}
      {/* Note: do NOT invalidate queries on close — the mutation's onSettled already does this.
          Invalidating here would race with the optimistic update and wipe the temp entry
          before the server response arrives. */}
      <AddEntryDialog
        tracker={tracker}
        open={addEntryOpen}
        onOpenChange={setAddEntryOpen}
      />

      {/* ── Delete Tracker confirmation ── */}
      <AlertDialog open={deleteTrackerOpen} onOpenChange={setDeleteTrackerOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{tracker.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this tracker and all {tracker.entries.length} entries. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTrackerMut.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-tracker-confirm">
              {deleteTrackerMut.isPending ? "Deleting..." : "Delete Tracker"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── TrackersPage ───────────────────────────────────────────────────────────────

// ── Profile filter icon map ──────────────────────────────────────────────────

const PROFILE_TYPE_ICONS: Record<string, any> = {
  person: User,
  pet: PawPrint,
  vehicle: Car,
  account: CreditCard,
  property: Building2,
  subscription: CreditCard,
  medical: Stethoscope,
  self: Smile,
  loan: CreditCard,
  investment: TrendingUp,
  asset: Star,
};

export default function TrackersPage() {
  // Hub consolidation (2026-07): true when rendered under the hub shell,
  // which then owns the profile switcher + section navigation.
  const hubEmbedded = useHubChrome();
  // Title reflects the actual route the user landed on. Both /trackers and
  // /linked render this same component. The app uses wouter path-based routing,
  // so we read window.location.pathname (NOT hash, which is always empty here).
  const [pageLoc] = useLocation();
  useEffect(() => {
    const path = pageLoc || window.location.pathname || '';
    const isLinkedRoute = path.startsWith('/linked');
    document.title = isLinkedRoute ? "Linked — Portol" : "Trackers — Portol";
  }, [pageLoc]);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  // Always keep page-local filter state in lockstep with the global filter store,
  // even if the dropdown's onChange callback is stale or batched. This guarantees
  // multi-profile selections (e.g. Test + Jane Doe) are honored end-to-end.
  useEffect(() => {
    const unsub = subscribeProfileFilter(state => {
      setFilterMode(state.mode);
      setFilterIds([...state.selectedIds]);
    });
    // Re-sync once on mount in case state changed before listeners attached
    const cur = getProfileFilter();
    setFilterMode(cur.mode);
    setFilterIds([...cur.selectedIds]);
    return unsub;
  }, []);
  const trackerProfileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  // PERF: use isPending (no data ever) instead of isLoading. With
  // placeholderData:keepPreviousData on the global client, a filter switch
  // keeps prior data while refetching — isPending stays false, the skeleton
  // never flashes, and the page updates in place when the new response arrives.
  const { data: trackers, isPending } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/trackers${trackerProfileParam}`).then(r => r.json()),
  });
  const [showTrackerSkeleton, setShowTrackerSkeleton] = useState(false);
  useEffect(() => {
    if (!isPending || trackers) { setShowTrackerSkeleton(false); return; }
    const tid = setTimeout(() => setShowTrackerSkeleton(true), 200);
    return () => clearTimeout(tid);
  }, [isPending, trackers]);

  const { data: profiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const { data: allDocuments = [] } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  // Co-ownership link tables. The parent-profile rule alone misses assets/
  // liabilities where the active filter profile is a CO-OWNER via
  // asset_party_links / liability_profile_links — e.g. Home is parented to
  // Test but Jane owns 50%, so a filter on Jane must still show Home.
  // These two endpoints are cheap user-scoped queries.
  const { data: assetPartyLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/asset-party-links"],
    queryFn: () => apiRequest("GET", "/api/asset-party-links").then(r => r.json()),
  });
  const { data: liabilityProfileLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/liability-profile-links"],
    queryFn: () => apiRequest("GET", "/api/liability-profile-links").then(r => r.json()),
  });

  // Visibility helper: an asset is visible to the selected filter set if it's
  // (a) directly selected, (b) parented to a selected profile, or (c) the
  // selected profile appears as a co-owner via asset_party_links. Same logic
  // for liabilities. Returns true when filterMode is "everyone".
  // P4.1 remediation: route through the canonical ownerCandidatesForProfile +
  // isInScope primitives (shared/scope.ts) instead of a hand-rolled predicate
  // so this page can never drift from the dashboard / net-worth scope rule.
  const emptySelfIds = useMemo(() => new Set<string>(), []);
  const isAssetVisible = (assetId: string, parentId: string | null | undefined): boolean => {
    if (filterMode === "everyone") return true;
    if (filterIds.length === 0) return true;
    return isInScope(
      ownerCandidatesForProfile({ id: assetId, parentProfileId: parentId ?? null }, assetPartyLinks, null),
      { selectedIds: filterIds, selfIds: emptySelfIds },
      "out_of_scope",
    );
  };
  const isLiabilityVisible = (liabId: string, parentId: string | null | undefined): boolean => {
    if (filterMode === "everyone") return true;
    if (filterIds.length === 0) return true;
    return isInScope(
      ownerCandidatesForProfile({ id: liabId, parentProfileId: parentId ?? null }, null, liabilityProfileLinks),
      { selectedIds: filterIds, selfIds: emptySelfIds },
      "out_of_scope",
    );
  };

  // `createOpen` is retained only so the CreateTrackerDialog component
  // (still mounted below) compiles. All UI affordances that opened it
  // were removed 2026-05-21 — trackers can only be created via chat.
  const [createOpen, setCreateOpen] = useState(false);
  // The auto-open-on-?new=1 effect was removed at the same time; the
  // command palette "New tracker" shortcut was deleted upstream, so the
  // URL contract no longer exists.
  useEffect(() => {
    const hash = window.location.hash || "";
    const q = hash.includes("?") ? hash.split("?")[1] : "";
    if (q && new URLSearchParams(q).get("new")) {
      // Strip the query so the URL stays clean, but do NOT open the dialog.
      const cleaned = hash.split("?")[0];
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${cleaned}`);
    }
  }, []);
  // Profile creation dialog (used for Asset/Loan/Subscription tabs)
  const [createProfileOpen, setCreateProfileOpen] = useState(false);
  const [createProfileFilter, setCreateProfileFilter] = useState<string | string[] | undefined>(undefined);
  const [createProfileTitle, setCreateProfileTitle] = useState<string | undefined>(undefined);
  const [, navigate] = useLocation();
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [selectedTrackerId, setSelectedTrackerId] = useState<string | null>(null);
  // Deep-link from chat action cards: /trackers?tracker=<id> auto-opens that
  // tracker's detail view (2026-07-15 user request: tapping a tracker card in
  // chat should bring you to the tracker). The param is stripped afterwards so
  // back/refresh doesn't keep re-opening it.
  useEffect(() => {
    if (!trackers || trackers.length === 0) return;
    try {
      const hash = window.location.hash || "";
      const q = hash.includes("?") ? hash.split("?")[1] : (window.location.search || "").replace(/^\?/, "");
      const tid = q ? new URLSearchParams(q).get("tracker") : null;
      if (tid && trackers.some((t) => t.id === tid)) {
        setSelectedTrackerId(tid);
        const cleanedHash = hash.includes("?") ? hash.split("?")[0] : hash;
        window.history.replaceState(null, "", `${window.location.pathname}${cleanedHash}`);
      }
    } catch { /* malformed URL — ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackers?.length]);
  // Resolve selectedTracker from the live query cache so it refreshes after mutations
  const selectedTracker = selectedTrackerId ? (trackers || []).find(t => t.id === selectedTrackerId) || null : null;
  // Linked-page view mode. Persisted so the user's choice (compact list vs
  // cards) sticks as their default across sessions — "make compact list the
  // default if I want" (2026-06-25).
  const [viewMode, setViewModeRaw] = useState<"table" | "cards">(() => {
    if (typeof window === "undefined") return "cards";
    const saved = window.localStorage.getItem("portol:linkedViewMode");
    return saved === "table" || saved === "cards" ? saved : "cards";
  });
  const setViewMode = (v: "table" | "cards") => {
    setViewModeRaw(v);
    try { window.localStorage.setItem("portol:linkedViewMode", v); } catch { /* private mode */ }
  };
  const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docDeleteConfirmId, setDocDeleteConfirmId] = useState<string | null>(null);
  const [sendDocId, setSendDocId] = useState<string | null>(null); // kept for legacy ref cleanup
  const [shareLoadingId, setShareLoadingId] = useState<string | null>(null);
  const [docSearch, setDocSearch] = useState("");
  const docFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProfileId, setUploadProfileId] = useState<string>("");
  // ── Native document sharing ──────────────────────────────────────
  // Tapping the share button fetches the file and opens the device’s native
  // share sheet (iOS/Android).  Picking Mail attaches the file automatically.
  // On desktop without Web Share API, the file downloads instead.
  const handleShareDoc = async (doc: Document) => {
    setShareLoadingId(doc.id);
    try {
      const resp = await apiRequest("GET", `/api/documents/${doc.id}/file`);
      const blob = await resp.blob();
      const mime = doc.mimeType || blob.type || "application/octet-stream";
      const extMap: Record<string, string> = {
        "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/jpg": ".jpg",
        "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp",
        "text/plain": ".txt", "text/csv": ".csv",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      };
      const ext = extMap[mime] || "";
      const filename = doc.name.includes(".") ? doc.name : `${doc.name}${ext}`;
      const file = new File([blob], filename, { type: mime });

      // iOS/Android: Web Share API — opens native share sheet including Mail
      if (typeof navigator !== "undefined" && navigator.share &&
          (navigator as any).canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: doc.name });
        toast({ title: "Share sheet opened" });
      } else {
        // Desktop fallback: download the file
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: filename });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast({ title: `"${filename}" downloaded`, description: "Open your email client and attach the file." });
      }
    } catch (err: any) {
      toast({ title: "Could not share", description: err?.message || "Unknown error", variant: "destructive" });
    } finally {
      setShareLoadingId(null);
    }
  };

  // Unified section filter: which sections to show
  // Phase 8 Liabilities: "subscriptions" filter renamed to "liabilities". The
  // legacy stored value is silently migrated so users with stale sessionStorage
  // don't land on a filter that no longer exists.
  // BUG-LT01/LT02/LT03/LT04/UI02: derive a default section from the active
  // route + query string. Route changes always reset the section so direct
  // links to /trackers or /dashboard/health behave predictably and
  // navigating away/back to /linked returns the user to a clean "All" view.
  const getRouteDefaultSection = (path: string): "all" | "profiles" | "liabilities" | "documents" | "trackers" => {
    const p = (path || "").toLowerCase();
    if (p.startsWith("/trackers") || p.startsWith("/dashboard/health") || p.startsWith("/health")) return "trackers";
    if (p.startsWith("/liabilities")) return "liabilities";
    return "all";
  };
  const getQuerySection = (): "all" | "profiles" | "liabilities" | "documents" | "trackers" | null => {
    try {
      const hash = window.location.hash || "";
      const q = hash.includes("?") ? hash.split("?")[1] : (window.location.search || "").replace(/^\?/, "");
      if (!q) return null;
      const tab = new URLSearchParams(q).get("tab");
      if (tab === "assets") return "profiles";
      if (tab && ["all", "trackers", "documents", "liabilities", "profiles"].includes(tab)) return tab as any;
    } catch {}
    return null;
  };
  const [sectionFilter, setSectionFilterRaw] = useState<"all" | "profiles" | "liabilities" | "documents" | "trackers">(() => {
    return getQuerySection() || getRouteDefaultSection(pageLoc || (typeof window !== "undefined" ? window.location.pathname : ""));
  });
  // BUG-LT01/LT02/LT03/LT04/UI02: reset section whenever the route changes
  // so /trackers, /dashboard/health, and /linked never reuse a stale tab.
  useEffect(() => {
    const qSection = getQuerySection();
    if (qSection) {
      setSectionFilterRaw(qSection);
      return;
    }
    setSectionFilterRaw(getRouteDefaultSection(pageLoc || (typeof window !== "undefined" ? window.location.pathname : "")));
  }, [pageLoc]);
  const setSectionFilter = (val: "all" | "profiles" | "liabilities" | "documents" | "trackers") => {
    setSectionFilterRaw(val);
  };
  // Document type filter
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  // Tracker category filter
  const [trackerCatFilter, setTrackerCatFilter] = useState<string>("all");
  // Asset type filter (Vehicles, Properties, Investments, Assets…)
  const [assetTypeFilter, setAssetTypeFilter] = useState<string>("all");
  // Asset nesting filter (Top-level / Has children / Nested)
  const [assetNestingFilter, setAssetNestingFilter] = useState<"all" | "topLevel" | "hasChildren" | "nested">(() => {
    try { return (sessionStorage.getItem("portol_asset_nesting_filter") as any) || "all"; } catch { return "all"; }
  });
  const setAssetNesting = (val: "all" | "topLevel" | "hasChildren" | "nested") => {
    setAssetNestingFilter(val);
    try { sessionStorage.setItem("portol_asset_nesting_filter", val); } catch {};
  };
  // Subscription category filter
  const [subCatFilter, setSubCatFilter] = useState<string>("all");
  // Collapsible sections
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) => setCollapsedSections(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  // Find self profile for orphan detection
  const selfProfile = (profiles || []).find(p => p.type === "self");
  // hasSelf: true when filter includes the self profile (or is everyone)
  const hasSelf = filterMode === "everyone" || filterIds.includes(selfProfile?.id || "");

  // On mount, migrate any unlinked trackers to the "self" profile
  const migrationDone = useRef(false);
  useEffect(() => {
    if (!migrationDone.current && trackers && profiles) {
      const hasUnlinked = trackers.some(t => !t.linkedProfiles || t.linkedProfiles.length === 0);
      if (hasUnlinked) {
        migrationDone.current = true;
        apiRequest("POST", "/api/trackers/migrate-to-self").then(() => {
          invalidateDomains("trackers", "profiles");
        }).catch(() => {});
      }
    }
  }, [trackers, profiles]);

  const deleteTarget = deleteTargetId
    ? (trackers || []).find((t) => t.id === deleteTargetId)
    : null;

  const { toast } = useToast();

  const docUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(f);
        });
      const fileData = await toBase64(file);
      const body: any = {
        fileName: file.name,
        mimeType: file.type,
        fileData,
      };
      if (uploadProfileId && uploadProfileId !== "auto") body.profileId = uploadProfileId;
      const res = await apiRequest("POST", "/api/upload", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded & processing" });
      // Extraction can create trackers and touch profiles — bust all three
      // domains via the bus.
      invalidateDomains("documents", "trackers", "profiles");
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  const docDeleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onMutate: async (docId: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/documents"] });
      const prev = queryClient.getQueryData<any[]>(["/api/documents"]);
      queryClient.setQueryData<any[]>(["/api/documents"], (old) => old?.filter((d: any) => d.id !== docId));
      return { prev };
    },
    onSuccess: () => {
      toast({ title: "Document deleted" });
      invalidateDomains("documents", "trackers", "profiles");
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/documents"], ctx.prev);
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  // Profile-filtered documents (before type filter, so type pills don't disappear)
  const profileFilteredDocs = useMemo(() => allDocuments.filter(d => {
    if (filterMode === "selected" && filterIds.length > 0) {
      // Canonical rule (orphan docs with no linkedProfiles belong to self) —
      // the inline `.some(includes)` used to hide them when filtering to self.
      return passesProfileFilter(d.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles || [] });
    }
    return true;
  }), [allDocuments, filterMode, filterIds, profiles]);

  // Unique doc types for filter chips — derived from profile-filtered docs (NOT type-filtered)
  const docTypes = useMemo(() => [...new Set(profileFilteredDocs.map(d => d.type).filter(Boolean))].sort(), [profileFilteredDocs]);

  // Fully filtered documents (profile + type + search)
  // docTypeFilter only applies on the Documents tab so a stale type filter doesn't silently hide docs on other tabs
  const filteredDocuments = useMemo(() => profileFilteredDocs.filter(d => {
    if (sectionFilter === "documents" && docTypeFilter !== "all" && normalizeFilter(d.type) !== normalizeFilter(docTypeFilter)) return false;
    if (docSearch) {
      const s = docSearch.toLowerCase();
      return d.name.toLowerCase().includes(s) || d.type?.toLowerCase().includes(s);
    }
    return true;
  }), [profileFilteredDocs, docTypeFilter, docSearch, sectionFilter]);

  // Unique canonical groups for filter chips
  const allTrackerCats = useMemo(() => [...new Set((trackers || []).map(t => getCanonicalGroup(t.category)))]
    .sort((a, b) => a.localeCompare(b)), [trackers]);

  // Asset/vehicle/property type list (after profile filter) for the Assets tab chip row.
  const assetTypeOptions = useMemo(() => {
    const childTypeSet = new Set(["vehicle", "asset", "investment", "property"]);
    const isShowAll = filterMode === "everyone";
    const visible = (profiles || []).filter(p => {
      if (!childTypeSet.has(p.type)) return false;
      if (isShowAll) return true;
      const pParent = (p as any).parentProfileId;
      // Visible if directly selected, parented to selected profile, OR
      // co-owned via asset_party_links (Home shows under Jane even though
      // it's parented to Test).
      return isAssetVisible(p.id, pParent);
    });
    const labelFor = (t: string) => t === "vehicle" ? "Vehicles" : t === "property" ? "Properties" : t === "investment" ? "Investments" : t === "asset" ? "Assets" : t;
    const counts: Record<string, number> = {};
    for (const p of visible) {
      const lab = labelFor(p.type);
      counts[lab] = (counts[lab] || 0) + 1;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [profiles, filterMode, filterIds, assetPartyLinks]);

  // Subscriptions/recurring bills are conceptually liabilities (things you owe
  // every month) so they live in the same Liabilities bucket alongside loans,
  // mortgages, and credit cards. Anything in this set shows up in the
  // Liabilities chip count, the Liabilities cards section, and the unified
  // table view.
  const isLiabilityLikeProfile = (p: any) => p?.type === "liability" || p?.type === "loan" || p?.type === "subscription";
  const liabilitySubcategoryOf = (p: any): string => {
    const f = (p?.fields as any) || {};
    if (p?.type === "subscription") {
      const c = (f.subtype || f.kind || f.category || "Subscription") as string;
      return String(c).trim().replace(/_/g, " ") || "Subscription";
    }
    const c = (f.subtype || f.liabilityType || f.kind || f.type || f.category || "Other") as string;
    return String(c).trim().replace(/_/g, " ") || "Other";
  };

  // Liability category list (after profile filter) for the Liabilities tab chip row.
  // Categories come from the liability subtype (mortgage, auto, credit_card,
  // etc.) and from subscription kinds (Subscription, Utility, Rent...).
  const liabilityCategoryOptions = useMemo(() => {
    const isShowAll = filterMode === "everyone";
    const liabs = (profiles || []).filter(p => {
      if (!isLiabilityLikeProfile(p)) return false;
      if (isShowAll) return true;
      // Visible if directly selected, parented to selected profile, OR
      // co-owned via liability_profile_links.
      const pParent = (p as any).parentProfileId;
      return isLiabilityVisible(p.id, pParent);
    });
    const counts: Record<string, number> = {};
    for (const s of liabs) {
      const c = liabilitySubcategoryOf(s);
      counts[c] = (counts[c] || 0) + 1;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [profiles, filterMode, filterIds, liabilityProfileLinks]);

  // Build the list of profiles that have linked trackers OR are the "self" profile (always show "Me")
  const sortedFilterProfiles = useMemo(() => {
    const profilesWithTrackers = (profiles || []).filter(p =>
      ["self", "person", "pet"].includes(p.type)
    );
    return [...profilesWithTrackers].sort((a, b) => {
      if (a.type === "self") return -1;
      if (b.type === "self") return 1;
      return a.name.localeCompare(b.name);
    });
  }, [profiles]);

  // Apply profile filter — memoized
  const filteredTrackers = useMemo(() => (trackers || []).filter(t => {
    if (filterMode === "selected" && filterIds.length > 0) {
      // Canonical rule so orphan trackers (no linkedProfiles) still show for self.
      if (!passesProfileFilter(t.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles || [] })) return false;
    }
    // The tracker-category chip filter only applies when the user is actually
    // on the Trackers tab. If they’re viewing "All" or some other section, a
    // stale category selection from a previous visit would silently hide
    // trackers without showing the chip row — which is exactly the
    // “why isn’t my data showing?” bug. Scope it to the active section.
    if (sectionFilter === "trackers" && trackerCatFilter !== "all" && normalizeFilter(getCanonicalGroup(t.category)) !== normalizeFilter(trackerCatFilter)) return false;
    return true;
  }).sort((a, b) => cleanTrackerName(a.name).toLowerCase().localeCompare(cleanTrackerName(b.name).toLowerCase())
  ), [trackers, filterMode, filterIds, trackerCatFilter, sectionFilter, profiles]);

  // Group trackers by canonical group — memoized
  const { grouped, sortedCats } = useMemo(() => {
    const g = filteredTrackers.reduce((acc: Record<string, Tracker[]>, t) => {
      const group = getCanonicalGroup(t.category);
      (acc[group] = acc[group] || []).push(t);
      return acc;
    }, {});
    const s = Object.keys(g).sort((a, b) => a.localeCompare(b));
    return { grouped: g, sortedCats: s };
  }, [filteredTrackers]);

  // Count trackers per profile for badges — memoized
  const profileCounts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const t of trackers || []) {
      for (const pid of t.linkedProfiles || []) map[pid] = (map[pid] || 0) + 1;
    }
    return map;
  }, [trackers]);
  const countForProfile = (profileId: string) => profileCounts[profileId] || 0;

  // BUG-3: single source of truth for the Linked section counts. Previously the
  // header showed only trackers+documents ("35 items") while the list/table view
  // also rendered assets + liabilities (65 rows) and the section chips computed
  // their own totals — three surfaces, three numbers. Derive the asset and
  // liability counts once here (identical filtering to the rendered lists) and
  // bind the header, the "All" chip total, and the per-section chips to them.
  const {
    filteredAssetCount,
    filteredLiabilityCount,
    allItemsCount,
  } = useMemo(() => {
    const childTypeSet = new Set(["vehicle", "asset", "investment", "property"]);
    const isShowAll = filterMode === "everyone";
    const byId = new Map<string, any>();
    (profiles || []).forEach(p => byId.set(p.id, p));
    const hasAssetAncestor = (p: any): boolean => {
      let cur: any = p;
      for (let i = 0; i < 32 && cur; i++) {
        const pid = cur.parentProfileId;
        if (!pid) return false;
        const par = byId.get(pid);
        if (!par) return false;
        if (childTypeSet.has(par.type)) return true;
        cur = par;
      }
      return false;
    };
    const labelForType = (t: string) => t === "vehicle" ? "Vehicles" : t === "property" ? "Properties" : t === "investment" ? "Investments" : t === "asset" ? "Assets" : t;
    const assets = (profiles || []).filter(p => {
      if (!childTypeSet.has(p.type)) return false;
      const pParent = p.parentProfileId;
      const parentIsAsset = hasAssetAncestor(p);
      const inScope = isShowAll || isAssetVisible(p.id, pParent as string | null | undefined);
      if (!inScope) return false;
      if (sectionFilter === "profiles" && assetTypeFilter !== "all" && labelForType(p.type) !== assetTypeFilter) return false;
      const nestingFilter = sectionFilter === "profiles" ? assetNestingFilter : "all";
      if (nestingFilter === "all" || nestingFilter === "topLevel") {
        if (parentIsAsset) return false;
      } else if (nestingFilter === "hasChildren") {
        const hasAssetChild = (profiles || []).some(x => x.id !== p.id && childTypeSet.has(x.type) && (x.parentProfileId) === p.id);
        if (!hasAssetChild) return false;
      } else if (nestingFilter === "nested") {
        if (!parentIsAsset) return false;
      }
      return true;
    }).length;
    const liabilities = (profiles || []).filter(p => {
      if (!isLiabilityLikeProfile(p)) return false;
      if (hasAssetAncestor(p)) return false;
      if (isShowAll) return true;
      return isLiabilityVisible(p.id, p.parentProfileId);
    }).length;
    return {
      filteredAssetCount: assets,
      filteredLiabilityCount: liabilities,
      allItemsCount: filteredTrackers.length + filteredDocuments.length + assets + liabilities,
    };
  }, [profiles, filterMode, sectionFilter, assetTypeFilter, assetNestingFilter, filteredTrackers, filteredDocuments]);

  // Skeleton loading state — MUST be after all hooks
  if (showTrackerSkeleton && !trackers && isPending) {
    return (
      <StuckLoadingGuard active>
        <div className="p-3 md:p-5 space-y-3">
          <div className="h-7 w-32 rounded skeleton-shimmer" />
          <div className="flex gap-2 overflow-x-hidden">
            {[...Array(4)].map((_, i) => <div key={i} className="h-7 w-20 rounded-full skeleton-shimmer shrink-0" />)}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {[...Array(8)].map((_, i) => <div key={i} className="h-16 rounded-lg skeleton-shimmer" />)}
          </div>
        </div>
      </StuckLoadingGuard>
    );
  }

  return (
    <div className="px-2 py-2 md:p-4 space-y-2 overflow-y-auto h-full pb-24" data-testid="page-trackers">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Hub-embedded: the shell owns navigation — hide the back arrow. */}
          {!hubEmbedded && (
          <Link href="/dashboard" className="inline-flex items-center justify-center rounded-md w-7 h-7 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back">
            <ArrowLeft className="w-3.5 h-3.5" />
          </Link>
          )}

          <span className="text-xs text-muted-foreground">
            {sectionFilter === "trackers" ? `${filteredTrackers.length} trackers`
             : sectionFilter === "documents" ? `${filteredDocuments.length} documents`
             : sectionFilter === "all" ? `${allItemsCount} items`
             : sectionFilter === "liabilities" ? "liabilities"
             : sectionFilter === "profiles" ? "assets"
             : `${filteredTrackers.length} trackers`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center border rounded-md p-0.5">
            <button onClick={() => setViewMode("table")} title="Compact list — saved as your default" aria-label="Compact list view" className={`p-1 rounded ${viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} data-testid="view-table">
              <Table2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode("cards")} title="Card view — saved as your default" aria-label="Card view" className={`p-1 rounded ${viewMode === "cards" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} data-testid="view-cards">
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
          {(() => {
            // ─── Smart + button: routes to the right creation flow based on the active section ───
            const openAssetDialog = () => { setCreateProfileFilter(["assets", "investments", "property"]); setCreateProfileTitle("Add Asset"); setCreateProfileOpen(true); };
            // Subscriptions live inside the Liabilities bucket now, so the
            // Liability create dialog should also offer subscription types
            // (Netflix, Spotify, rent, utilities, gym membership, etc.).
            const openLiabilityDialog = () => { setCreateProfileFilter(["liabilities", "subscriptions"]); setCreateProfileTitle("Add Liability"); setCreateProfileOpen(true); };
            const openDocumentUpload = () => navigate("/dashboard/artifacts");

            // Direct routes for tab-specific filters
            if (sectionFilter === "profiles") {
              return (
                <Button onClick={openAssetDialog} size="icon" className="h-7 w-7" data-testid="button-create-asset" aria-label="Add Asset">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              );
            }
            if (sectionFilter === "liabilities") {
              return (
                <Button onClick={openLiabilityDialog} size="icon" className="h-7 w-7" data-testid="button-create-liability" aria-label="Add Liability">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              );
            }
            if (sectionFilter === "trackers") {
              // Trackers can only be created through the chat (Portol AI).
              // The manual "+ Tracker" button was removed per user request
              // 2026-05-21 — do NOT re-add a UI affordance here. Server-side
              // createTracker is still used by the AI tool path.
              return null;
            }
            if (sectionFilter === "documents") {
              return (
                <Button onClick={openDocumentUpload} size="icon" className="h-7 w-7" data-testid="button-add-document" aria-label="Upload Document">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              );
            }
            // "all" — show a chooser so the user picks what to create
            return (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" className="h-7 w-7" data-testid="button-create-menu" aria-label="Create">
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={openAssetDialog} data-testid="menu-add-asset">
                    <Building2 className="h-3.5 w-3.5 mr-2" /> Asset
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={openLiabilityDialog} data-testid="menu-add-liability">
                    <TrendingDown className="h-3.5 w-3.5 mr-2" /> Liability
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Tracker creation is chat-only — button removed 2026-05-21. */}
                  <DropdownMenuItem onClick={openDocumentUpload} data-testid="menu-add-document">
                    <FileText className="h-3.5 w-3.5 mr-2" /> Document
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            );
          })()}
        </div>
      </div>

      {/* ── Filter Bar ──
          Hub-embedded (2026-07): the shell owns the profile switcher and the
          section tabs (Trackers/Assets/Liabilities/Documents chips navigate
          here with the right route/?tab=), so both are hidden — EXCEPT the
          section pills on the legacy "All" view (plain /linked deep links),
          where they're the only way to move between sections. */}
      <div className="space-y-2" data-testid="filter-bar">
        {/* Profile filter (page level) + Section pills */}
        <div className="flex flex-wrap items-center gap-2 pb-1">
          {!hubEmbedded && (<>
          {/* Profile filter */}
          <MultiProfileFilter
            onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
            compact
          />
          <div className="h-4 w-px bg-border" />
          </>)}
          {/* Section filter pills */}
          {(!hubEmbedded || sectionFilter === "all") && (() => {
            // Counts come from the hoisted single source of truth (see BUG-3
            // above) so the chips, the header "N items", and the rendered lists
            // can never disagree.
            return (["all", "trackers", "documents", "profiles", "liabilities"] as const).map(s => {
            const labels: Record<string, string> = { all: "All", trackers: "Trackers", documents: "Documents", profiles: "Assets", liabilities: "Liabilities" };
            const counts: Record<string, number> = {
              all: allItemsCount,
              trackers: filteredTrackers.length,
              documents: filteredDocuments.length,
              profiles: filteredAssetCount,
              liabilities: filteredLiabilityCount,
            };
            return (
              <button
                key={s}
                onClick={() => setSectionFilter(s)}
                className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${sectionFilter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
                data-testid={`filter-section-${s}`}
              >
                {labels[s]}
                {s !== "all" && <span className="ml-1 opacity-70">{counts[s]}</span>}
              </button>
            );
          });
          })()}
        </div>


      </div>

      {/* ── Section-specific filter chips ──
          The previous version showed the tracker "All Groups / Fitness / Health…"
          chip row on every tab, including "All", which made it look like a
          global filter. Each section now owns its own contextual chips so the
          row reflects whatever data the user is currently looking at. The
          "All" tab intentionally has no chip row — it would be ambiguous which
          dataset it filters. */}
      {sectionFilter === "trackers" && allTrackerCats.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-0.5" data-testid="category-filter-chips-trackers">
          <button
            onClick={() => setTrackerCatFilter("all")}
            className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${trackerCatFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
          >
            All Groups
          </button>
          {allTrackerCats.map(group => {
            const gDef = CANONICAL_GROUPS[group];
            const GIco = gDef?.icon || Box;
            const gAccent = gDef?.accent || "240 20% 60%";
            const isActive = trackerCatFilter === group;
            return (
              <button
                key={group}
                onClick={() => setTrackerCatFilter(isActive ? "all" : group)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${isActive ? "ring-1 ring-offset-1" : "hover:bg-muted border border-border/50"}`}
                style={isActive ? { background: `hsl(${gAccent} / 0.18)`, color: `hsl(${gAccent})`, borderColor: `hsl(${gAccent} / 0.4)` } : { color: `hsl(${gAccent})` }}
              >
                <GIco className="h-2.5 w-2.5" />
                {group}
              </button>
            );
          })}
        </div>
      )}

      {sectionFilter === "documents" && docTypes.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-0.5" data-testid="category-filter-chips-documents">
          <button
            onClick={() => setDocTypeFilter("all")}
            className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${docTypeFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
            data-testid="filter-doctype-all-top"
          >
            All Types
          </button>
          {docTypes.map(t => {
            const count = profileFilteredDocs.filter(d => normalizeFilter(d.type) === normalizeFilter(t)).length;
            const isActive = docTypeFilter === t;
            return (
              <button
                key={t}
                onClick={() => setDocTypeFilter(isActive ? "all" : t)}
                className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
                data-testid={`filter-doctype-top-${t}`}
              >
                {t.replace(/_/g, " ")} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {sectionFilter === "profiles" && assetTypeOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-0.5" data-testid="category-filter-chips-assets">
          <button
            onClick={() => { setAssetTypeFilter("all"); setAssetNesting("all"); }}
            className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${assetTypeFilter === "all" && assetNestingFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
          >
            All Types
          </button>
          {assetTypeOptions.map(([label, count]) => {
            const isActive = assetTypeFilter === label;
            return (
              <button
                key={label}
                onClick={() => setAssetTypeFilter(isActive ? "all" : label)}
                className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
                data-testid={`filter-asset-type-${label}`}
              >
                {label} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
          {/* Nesting chips — mutually exclusive with each other */}
          {([
            { value: "topLevel" as const, label: "Top-level" },
            { value: "hasChildren" as const, label: "Has children" },
            { value: "nested" as const, label: "Nested" },
          ]).map(({ value, label }) => {
            const isActive = assetNestingFilter === value;
            return (
              <button
                key={value}
                onClick={() => { setAssetTypeFilter("all"); setAssetNesting(isActive ? "all" : value); }}
                className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
                data-testid={`filter-asset-nesting-${value}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {sectionFilter === "liabilities" && liabilityCategoryOptions.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-0.5" data-testid="category-filter-chips-liabilities">
          <button
            onClick={() => setSubCatFilter("all")}
            className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${subCatFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
          >
            All Types
          </button>
          {liabilityCategoryOptions.map(([cat, count]) => {
            const isActive = subCatFilter === cat;
            return (
              <button
                key={cat}
                onClick={() => setSubCatFilter(isActive ? "all" : cat)}
                className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
                data-testid={`filter-liability-cat-${cat}`}
              >
                {cat} <span className="opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Summary cards intentionally hidden — they duplicated the group filter
          chips above and added noise (the "This Week / Most Active / Streak /
          Health Score" KPI strip plus a second group pill row). Tap a group
          chip above to scope the trackers list. */}

      {/* ── Unified List View ── (Phase 8)
          When the user toggles list view (viewMode==='table'), render every
          linked item as a single flat table regardless of section. This
          replaces the per-section card grids below. */}
      {viewMode === "table" && (() => {
        // ── Person-grouped list view ──
        // Every asset, liability, document and tracker has at least one
        // "owner" — the person profile it belongs to (the user themselves,
        // or a family member / dependent). The previous flat list lost that
        // information so the user couldn't tell which Blood Pressure reading
        // belonged to whom. We now group rows by their primary owner, give
        // each person a deterministic hue, and color the row icon by that
        // hue so the visual scan answers "whose data is this?" at a glance.
        type Row = { id: string; kind: "asset" | "liability" | "document" | "tracker"; name: string; subtitle: string; meta: string; href: string; ownerIds: string[]; category?: string; lastLogged?: string; };
        // Compact relative time ("Today", "3d", "2w", "5mo") for the tracker
        // "Last" column — more applicable than repeating the category.
        const relTime = (iso?: string | number | Date | null): string => {
          if (!iso) return "—";
          const then = new Date(iso).getTime();
          if (!isFinite(then)) return "—";
          const diff = Date.now() - then;
          if (diff < 0) return "Today";
          const d = Math.floor(diff / 86400000);
          if (d <= 0) return "Today";
          if (d === 1) return "1d";
          if (d < 7) return `${d}d`;
          if (d < 30) return `${Math.floor(d / 7)}w`;
          if (d < 365) return `${Math.floor(d / 30)}mo`;
          return `${Math.floor(d / 365)}y`;
        };
        const rows: Row[] = [];
        const childTypeSet = new Set(["vehicle", "asset", "investment", "property"]);
        const isShowAll = filterMode === "everyone";
        // NESTED-HIDE (2026-05-25): walk the parent chain (up to 32 levels — far
        // beyond any realistic nesting depth) and return true if any ancestor
        // is itself an asset-type profile. This is what powers the rule
        // "once an item is nested under an asset, it disappears from the
        // top-level Linked page — even if it's nested 5 levels deep."
        // Examples: Home → Furniture → Couch → Screws — only Home appears
        // at top level; the rest are reachable by drilling into Home.
        const profileById = new Map<string, any>();
        (profiles || []).forEach(p => profileById.set(p.id, p));
        const hasAssetAncestor = (p: any): boolean => {
          let cur: any = p;
          for (let i = 0; i < 32 && cur; i++) {
            const parentId = cur.parentProfileId;
            if (!parentId) return false;
            const parent = profileById.get(parentId);
            if (!parent) return false;
            if (childTypeSet.has(parent.type)) return true;
            cur = parent;
          }
          return false;
        };
        const toNum = (v: any): number | null => {
          if (v == null || v === '') return null;
          if (typeof v === 'number' && isFinite(v)) return v;
          if (typeof v === 'string') { const n = parseFloat(v.replace(/[$,\s]/g, '')); return isFinite(n) ? n : null; }
          return null;
        };
        // Build a fast lookup of all person-like profiles so we can resolve
        // owner ids → display names without scanning the whole list each time.
        const personProfiles = (profiles || []).filter(p => p.type === "self" || p.type === "person" || p.type === "pet");
        const personById = new Map<string, { id: string; name: string; type: string }>();
        personProfiles.forEach(p => personById.set(p.id, { id: p.id, name: p.name || "Unnamed", type: p.type }));
        const selfProfileId = personProfiles.find(p => p.type === "self")?.id || "";
        // Walks up parent chain on an asset/liability profile to find the
        // first person-type ancestor. Assets are often nested under other
        // assets (e.g. a TV under a Home), so the immediate parent is not
        // always a person.
        const resolveOwnerFromProfile = (p: any): string | null => {
          let cur: any = p;
          for (let i = 0; i < 8 && cur; i++) {
            const parentId = cur.parentProfileId;
            if (!parentId) break;
            const parent = (profiles || []).find(x => x.id === parentId);
            if (!parent) break;
            if (parent.type === "self" || parent.type === "person" || parent.type === "pet") return parent.id;
            cur = parent;
          }
          // No person ancestor found — fall back to the self profile so the
          // user can still find their own untagged items.
          return selfProfileId || null;
        };
        // Maps a raw profile type to the same label used by the asset-type
        // chip row, so the list view can honor the active sub-filter. Without
        // this the highlighted "Properties"/"Vehicles" chip did nothing in
        // list view — the chip lit up but the list still showed every asset
        // (2026-06-25 user report).
        const labelForAssetType = (t: string) =>
          t === "vehicle" ? "Vehicles" : t === "property" ? "Properties" : t === "investment" ? "Investments" : t === "asset" ? "Assets" : t;
        // Assets
        if (sectionFilter === "all" || sectionFilter === "profiles") {
          (profiles || []).forEach(p => {
            if (!childTypeSet.has(p.type)) return;
            // Honor the asset-type sub-filter (Properties / Vehicles / …) — only
            // active on the Assets section, mirroring the card view exactly.
            if (sectionFilter === "profiles" && assetTypeFilter !== "all" && labelForAssetType(p.type) !== assetTypeFilter) return;
            const pParent = p.parentProfileId;
            // Include co-owners via asset_party_links (Home shows for Jane).
            if (!isShowAll && !isAssetVisible(p.id, pParent)) return;
            // Hide nested assets unless the user explicitly chose the
            // "Nested" chip. "all" / "topLevel" both mean "top-level only".
            const nestingFilterList = sectionFilter === "profiles" ? assetNestingFilter : "all";
            if (nestingFilterList === "all" || nestingFilterList === "topLevel") {
              if (hasAssetAncestor(p)) return;
            } else if (nestingFilterList === "nested") {
              if (!hasAssetAncestor(p)) return;
            } else if (nestingFilterList === "hasChildren") {
              const hasChild = (profiles || []).some(x => x.id !== p.id && childTypeSet.has(x.type) && (x.parentProfileId) === p.id);
              if (!hasChild) return;
            }
            const f = p.fields || {}; const fin = f.finance || {}; const housing = f.housing || {}; const other = f.other || {};
            const cv = toNum(f.currentValue) ?? toNum(housing.currentValue) ?? toNum(other.currentValue) ?? toNum(other.value) ?? toNum(fin.balance) ?? toNum(f.value);
            const sub = p.type.charAt(0).toUpperCase() + p.type.slice(1);
            const owner = resolveOwnerFromProfile(p);
            rows.push({ id: p.id, kind: "asset", name: p.name, subtitle: sub, meta: cv != null ? `$${cv.toLocaleString()}` : "—", href: `/profiles/${p.id}`, ownerIds: owner ? [owner] : [] });
          });
        }
        // Liabilities — includes loans/mortgages/credit cards AND subscriptions.
        if (sectionFilter === "all" || sectionFilter === "liabilities") {
          (profiles || []).forEach(p => {
            if (!isLiabilityLikeProfile(p)) return;
            // Honor the liability sub-category sub-filter in list view too.
            if (sectionFilter === "liabilities" && subCatFilter !== "all" && liabilitySubcategoryOf(p) !== subCatFilter) return;
            const pParent = p.parentProfileId;
            // Include co-owners via liability_profile_links.
            if (!isShowAll && !isLiabilityVisible(p.id, pParent)) return;
            // Hide liabilities nested under an asset (e.g. "Service plan for
            // Sony TV" nested under TV — shows only inside the TV detail page).
            if (hasAssetAncestor(p)) return;
            const f = (p.fields as any) || {}; const fin = f.finance || {};
            const bal = toNum(f.currentBalance) ?? toNum(f.remainingBalance) ?? toNum(f.loanBalance) ?? toNum(f.balance) ?? toNum(fin.remainingBalance) ?? toNum(fin.loanBalance) ?? toNum(fin.balance);
            const cost = toNum(f.cost) ?? toNum(f.amount) ?? toNum(f.monthlyPayment) ?? toNum(fin.monthlyPayment);
            const freq = (f.frequency || "monthly").toString();
            const sub = liabilitySubcategoryOf(p);
            const meta = bal != null && bal > 0
              ? `$${Math.round(bal).toLocaleString()}`
              : (cost != null && cost > 0 ? `$${Math.round(cost).toLocaleString()}/${freq.startsWith('y') ? 'yr' : freq.startsWith('w') ? 'wk' : 'mo'}` : "—");
            const owner = resolveOwnerFromProfile(p);
            rows.push({ id: p.id, kind: "liability", name: p.name, subtitle: sub, meta, href: `/profiles/${p.id}`, ownerIds: owner ? [owner] : [] });
          });
        }
        // Documents — linkedProfiles[] tells us which people the doc is for.
        if (sectionFilter === "all" || sectionFilter === "documents") {
          (allDocuments || []).forEach(d => {
            // Honor the document-type sub-filter in list view too.
            if (sectionFilter === "documents" && docTypeFilter !== "all" && normalizeFilter((d as any).type) !== normalizeFilter(docTypeFilter)) return;
            const linked: string[] = ((d as any).linkedProfiles || []) as string[];
            const ownerIds = linked.filter(id => personById.has(id));
            // If no person is linked, attribute to self so the user sees
            // it under their own section rather than "Unassigned".
            const finalOwners = ownerIds.length > 0 ? ownerIds : (selfProfileId ? [selfProfileId] : []);
            if (!isShowAll) {
              // Canonical rule: orphan docs (no linked person) belong to self —
              // consistent with finalOwners above, which already attributes them
              // to self. The old `.some(includes)` hid them when filtering to self.
              if (!passesProfileFilter(linked, { selectedIds: filterIds, allProfiles: profiles || [] })) return;
            }
            const sub = ((d as any).type || "Document").toString();
            const dt = d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "";
            rows.push({ id: d.id, kind: "document", name: d.name || "Untitled", subtitle: sub, meta: dt, href: `/documents/${d.id}`, ownerIds: finalOwners });
          });
        }
        // Trackers — linkedProfiles[] tells us who each tracker is for.
        if (sectionFilter === "all" || sectionFilter === "trackers") {
          (filteredTrackers || []).forEach(t => {
            const sub = t.category || "Tracker";
            const last = t.entries?.[t.entries.length - 1];
            // Pick a meaningful "Latest" value: prefer the primary field, then
            // ANY numeric field on the latest entry. Skip a text value that just
            // echoes the tracker name (e.g. a "Lisinopril" drug field on the
            // Lisinopril tracker) — that reads as a useless repeat.
            const pf = t.fields.find(fld => fld.isPrimary)?.name || t.fields[0]?.name || "value";
            const vals = (last?.values || {}) as Record<string, any>;
            let primary: any = vals[pf];
            if (primary == null || (typeof primary === "string" && primary.trim().toLowerCase() === t.name.trim().toLowerCase())) {
              const numEntry = Object.entries(vals).find(([k, val]) => k !== "_notes" && typeof val === "number" && isFinite(val));
              primary = numEntry ? numEntry[1] : (typeof primary === "string" ? primary : undefined);
            }
            const meta = primary != null && !(typeof primary === "string" && primary.trim().toLowerCase() === t.name.trim().toLowerCase())
              ? `${typeof primary === 'number' ? Number(primary).toFixed(1) : String(primary)}${typeof primary === 'number' && t.unit ? ' ' + t.unit : ''}`
              : (t.entries && t.entries.length > 0 ? `${t.entries.length} log${t.entries.length === 1 ? '' : 's'}` : "No data");
            const linked: string[] = (t.linkedProfiles || []) as string[];
            const ownerIds = linked.filter(id => personById.has(id));
            const finalOwners = ownerIds.length > 0 ? ownerIds : (selfProfileId ? [selfProfileId] : []);
            rows.push({ id: t.id, kind: "tracker", name: t.name, subtitle: sub, meta, href: `/trackers/${t.id}`, ownerIds: finalOwners, category: t.category || undefined, lastLogged: relTime(last?.timestamp) });
          });
        }
        if (rows.length === 0) {
          return (
            <div className="bubble p-8 text-center" data-testid="linked-list-empty">
              <p className="text-sm text-muted-foreground">Nothing to list here yet</p>
            </div>
          );
        }
        const kindIcons: Record<Row["kind"], any> = { asset: Star, liability: TrendingDown, document: FileText, tracker: Activity };
        // Per-row visual accent. Trackers are colored by their CATEGORY (so
        // nutrition is orange, fitness green, medication pink, finance amber…)
        // which is what gives the list its scan-at-a-glance variety — the prior
        // version colored every row by person, so a single-person account
        // rendered as one flat green wall. Assets/liabilities/documents keep a
        // stable kind hue. This is the single source of truth (getCategoryAccent
        // + central category-theme), never an inline color.
        const KIND_ACCENT: Record<Row["kind"], string> = {
          asset: "199 89% 48%",      // sky — owned things
          liability: "0 72% 51%",    // red — money owed
          document: "220 9% 55%",    // slate — paperwork
          tracker: "142 71% 45%",    // (unused; trackers resolve by category)
        };
        const rowVisual = (r: Row): { accent: string; Icon: any; typeLabel: string } => {
          if (r.kind === "tracker") {
            const theme = _categoryTheme(r.category, r.name);
            return {
              accent: getCategoryAccent(r.category || ""),
              Icon: theme.icon,
              // Show the category (e.g. "nutrition", "fitness") rather than the
              // redundant word "tracker" — the section filter already tells the
              // user they're looking at trackers.
              typeLabel: r.category || theme.label || "general",
            };
          }
          return { accent: KIND_ACCENT[r.kind], Icon: kindIcons[r.kind], typeLabel: r.subtitle || r.kind };
        };
        // Deterministic per-person hue. We hash the person id into a hue in
        // [0, 360) so the same person always gets the same color across
        // sessions, but different people get visually distinct colors.
        // Saturation/lightness are fixed so contrast stays uniform.
        const hueForPerson = (id: string): number => {
          let h = 0;
          for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
          // Spread across the wheel but avoid the muddy yellow-green band
          // around 60-80° which is hard to read on dark cards.
          const raw = h % 320;
          return raw < 60 ? raw : raw + 30;
        };
        const personAccent = (id: string) => `${hueForPerson(id)} 65% 58%`;
        // Group rows by primary owner. "Unassigned" catches anything that
        // truly has no person attribution.
        type Group = { ownerId: string; ownerName: string; accent: string; rows: Row[] };
        const groupsMap = new Map<string, Group>();
        const orderedOwnerIds: string[] = [];
        rows.forEach(r => {
          const primary = r.ownerIds[0] || "__unassigned__";
          if (!groupsMap.has(primary)) {
            orderedOwnerIds.push(primary);
            const person = personById.get(primary);
            groupsMap.set(primary, {
              ownerId: primary,
              ownerName: person?.name || "Unassigned",
              accent: primary === "__unassigned__" ? "220 10% 50%" : personAccent(primary),
              rows: [],
            });
          }
          groupsMap.get(primary)!.rows.push(r);
        });
        // Always render the self profile first if present, then other people
        // sorted alphabetically, with Unassigned last.
        const sortedGroups = orderedOwnerIds
          .map(id => groupsMap.get(id)!)
          .sort((a, b) => {
            if (a.ownerId === selfProfileId) return -1;
            if (b.ownerId === selfProfileId) return 1;
            if (a.ownerId === "__unassigned__") return 1;
            if (b.ownerId === "__unassigned__") return -1;
            return a.ownerName.localeCompare(b.ownerName);
          });
        const initials = (name: string) => name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
        // On the dedicated Trackers section every row is a tracker, so the
        // middle/right columns become tracker-applicable ("Last" logged +
        // "Latest" reading) instead of a redundant category badge + value.
        const trackerCols = sectionFilter === "trackers";
        return (
          <div className="space-y-3" data-testid="linked-list-view">
            {sortedGroups.map(group => (
              <div key={group.ownerId} className="bubble overflow-hidden" data-testid={`linked-list-group-${group.ownerId}`}>
                {/* Person header with avatar + count */}
                <div
                  className="flex items-center gap-2.5 px-3 py-2 border-b border-border/40"
                  style={{ background: `linear-gradient(135deg, hsl(${group.accent} / 0.14) 0%, hsl(${group.accent} / 0.04) 100%)` }}
                >
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                    style={{ backgroundColor: `hsl(${group.accent} / 0.25)`, color: `hsl(${group.accent})`, border: `1px solid hsl(${group.accent} / 0.4)` }}
                  >
                    {initials(group.ownerName)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-foreground truncate" style={{ color: `hsl(${group.accent})` }}>{group.ownerName}</p>
                  </div>
                  <span
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0"
                    style={{ backgroundColor: `hsl(${group.accent} / 0.18)`, color: `hsl(${group.accent})` }}
                  >
                    {group.rows.length} {group.rows.length === 1 ? "item" : "items"}
                  </span>
                </div>
                {/* Column headers — compact, spreadsheet-style. */}
                <div className="grid grid-cols-[20px_1fr_auto_72px] items-center gap-2 px-2.5 py-1 border-b border-border/40 bg-muted/20 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                  <span />
                  <span>Name</span>
                  <span className="text-right">{trackerCols ? "Last" : "Type"}</span>
                  <span className="text-right">{trackerCols ? "Latest" : "Value"}</span>
                </div>
                {group.rows.map((r, ri) => {
                  // Color the row by CATEGORY (trackers) / kind (everything
                  // else) so the list reads like a color-coded spreadsheet
                  // instead of a single-hue wall. Zebra striping + a thin
                  // category rail on the left make rows easy to scan and tell
                  // apart. The person grouping (header above) still answers
                  // "whose data" — color now answers "what kind".
                  const { accent: ac, Icon, typeLabel } = rowVisual(r);
                  const rowInner = (
                    <div
                      className={`grid grid-cols-[20px_1fr_auto_72px] items-center gap-2 pl-2.5 pr-2.5 py-1 border-b border-border/20 last:border-b-0 cursor-pointer hover:bg-muted/50 transition-colors ${ri % 2 === 1 ? "bg-muted/15" : ""}`}
                      style={{ boxShadow: `inset 2px 0 0 hsl(${ac} / 0.6)` }}
                      data-testid={`linked-list-row-${r.kind}-${r.id}`}
                    >
                      <div className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${ac} / 0.16)`, color: `hsl(${ac})` }}>
                        <Icon className="h-3 w-3" />
                      </div>
                      <p className="text-[13px] font-medium text-foreground truncate leading-tight">{r.name}</p>
                      {trackerCols && r.kind === "tracker" ? (
                        <span className="text-[11px] tabular-nums text-muted-foreground text-right whitespace-nowrap">{r.lastLogged || "—"}</span>
                      ) : (
                        <span className="text-[9px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded whitespace-nowrap" style={{ backgroundColor: `hsl(${ac} / 0.14)`, color: `hsl(${ac})` }}>{typeLabel}</span>
                      )}
                      <span className="text-[13px] font-semibold tabular-nums text-foreground text-right truncate">{r.meta}</span>
                    </div>
                  );
                  // Trackers open in the detail dialog — there is no /trackers/:id
                  // route, so navigating to r.href ("/trackers/<id>") would land on
                  // the NotFound page. The card view opens the same dialog via
                  // setSelectedTrackerId; mirror that here so list-view rows work.
                  if (r.kind === "tracker") {
                    return (
                      <div
                        key={`${r.kind}-${r.id}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => setSelectedTrackerId(r.id)}
                        onKeyDown={onEnterOrSpace(() => setSelectedTrackerId(r.id))}
                      >
                        {rowInner}
                      </div>
                    );
                  }
                  return (
                    // PERF (2026-07-17 live drive): opening an asset/liability
                    // detail cold measured ~8s — warm the server's
                    // profile-bootstrap cache the moment the user aims at a row.
                    <Link
                      key={`${r.kind}-${r.id}`}
                      href={r.href}
                      onMouseEnter={() => warmProfileDetail(r.id)}
                      onTouchStart={() => warmProfileDetail(r.id)}
                    >
                      {rowInner}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Assets & Vehicles — grouped by type */}
      {viewMode === "cards" && (sectionFilter === "all" || sectionFilter === "profiles") && (() => {
        // Only show actual assets and vehicles here — NOT loans/obligations (those belong in Bills)
        const childTypeSet = new Set(["vehicle", "asset", "investment", "property"]);
        const isShowAll = filterMode === "everyone";
        const labelForType = (t: string) => t === "vehicle" ? "Vehicles" : t === "property" ? "Properties" : t === "investment" ? "Investments" : t === "asset" ? "Assets" : t;
        // Walk full parent chain (up to 32 levels) so an asset nested at ANY
        // depth — Home → Furniture → Couch → Screws — is hidden from the
        // top-level Linked page. Previously only the direct parent was checked,
        // so a Couch under Furniture under Home would still leak through.
        const _profileByIdCards = new Map<string, any>();
        (profiles || []).forEach(p => _profileByIdCards.set(p.id, p));
        const _hasAssetAncestorCards = (p: any): boolean => {
          let cur: any = p;
          for (let i = 0; i < 32 && cur; i++) {
            const pid = cur.parentProfileId;
            if (!pid) return false;
            const par = _profileByIdCards.get(pid);
            if (!par) return false;
            if (childTypeSet.has(par.type)) return true;
            cur = par;
          }
          return false;
        };
        const childProfiles = (profiles || []).filter(p => {
          if (!childTypeSet.has(p.type)) return false;
          // Visible if (a) no filter, (b) directly selected, (c) parented to
          // selected profile, OR (d) co-owned via asset_party_links. Route
          // through the canonical isAssetVisible helper so this cards view
          // matches the list view, the chip counts, and every other surface.
          // Previously this branch only checked parentProfileId, which made
          // co-owned assets (e.g. Home parented to Mike but 50% owned by
          // Test) silently disappear when filtering on the co-owner.
          const pParent = p.parentProfileId as string | null | undefined;
          if (!isShowAll && !isAssetVisible(p.id, pParent)) return false;
          // Asset type chip filter — only applies on the Assets tab.
          // "all" means no chip-level filter; everything passes.
          if (sectionFilter === "profiles" && assetTypeFilter !== "all" && labelForType(p.type) !== assetTypeFilter) return false;
          // Asset nesting filter — applies on BOTH the "All" tab and the "Assets" tab.
          const parentIsAssetChain = _hasAssetAncestorCards(p);
          const nestingFilter = sectionFilter === "profiles" ? assetNestingFilter : "all";
          if (nestingFilter === "all" || nestingFilter === "topLevel") {
            if (parentIsAssetChain) return false;
          } else if (nestingFilter === "hasChildren") {
            const hasAssetChild = (profiles || []).some(x => x.id !== p.id && childTypeSet.has(x.type) && (x.parentProfileId) === p.id);
            if (!hasAssetChild) return false;
          } else if (nestingFilter === "nested") {
            if (!parentIsAssetChain) return false;
          }
          return true;
        });
        if (childProfiles.length === 0) return (
          <div className="bubble p-6 text-center">
            <Star className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No assets or vehicles yet</p>
            <p className="text-xs text-muted-foreground mt-1">Add vehicles, property, or investments to track them here</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-8 text-xs"
              onClick={() => { setCreateProfileFilter(["assets", "investments", "property"]); setCreateProfileTitle("Add Asset"); setCreateProfileOpen(true); }}
              data-testid="btn-empty-add-asset"
            >
              <Plus className="h-3 w-3 mr-1" /> Add Asset
            </Button>
          </div>
        );

        // Group by type
        const typeGroups: Record<string, typeof childProfiles> = {};
        for (const p of childProfiles) {
          // Phase 1 Liabilities: liabilities/loans intentionally excluded from Trackers — they live inside asset/person profile pages only.
          const group = p.type === "vehicle" ? "Vehicles" : p.type === "asset" ? "Assets" : p.type === "property" ? "Properties" : p.type === "investment" ? "Investments" : "Other";
          (typeGroups[group] = typeGroups[group] || []).push(p);
        }
        const sortedGroups = Object.entries(typeGroups).sort(([a], [b]) => a.localeCompare(b));
        const typeIcons: Record<string, any> = { vehicle: Car, asset: Star, loan: CreditCard, investment: TrendingUp, property: Building2, account: CreditCard };

        return (
          <div className="space-y-1.5">
            {/* Hub single-section view: the active tab chip already names this
                section, so its redundant title/toggle is hidden (frees space). */}
            {!(hubEmbedded && sectionFilter !== "all") && (
            <button onClick={() => toggleSection("profiles")} className="pressable flex items-center gap-3 w-full px-1 py-1 rounded-xl text-left" data-testid="section-toggle-profiles">
              <Medallion icon={Car} accent="262 60% 62%" size="sm" />
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold tracking-tight" style={{ color: 'hsl(262 60% 62%)' }}>Assets & Vehicles</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'hsl(262 60% 62% / 0.15)', color: 'hsl(262 60% 62%)' }}>{childProfiles.length}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">Vehicles, property, investments and more</p>
              </div>
              {collapsedSections.has("profiles") ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" /> : <ChevronUp className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
            </button>
            )}
            {(!collapsedSections.has("profiles") || (hubEmbedded && sectionFilter !== "all")) && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 items-stretch" style={{ gridAutoRows: 178 }}>
                {sortedGroups.flatMap(([, items]) => items.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''))).map(child => {
                  const Icon = typeIcons[child.type] || Star;
                  const fields = child.fields || {};
                  // Robust value resolver — historical data is stored under several
                  // inconsistent paths (fields.currentValue, fields.housing.currentValue,
                  // fields.other.purchasePrice, fields.finance.balance, etc.). Walk the
                  // common locations so legacy and new entries both render correctly.
                  const toNum = (v: any): number | null => {
                    if (v == null || v === '') return null;
                    if (typeof v === 'number' && isFinite(v)) return v;
                    if (typeof v === 'string') {
                      const n = parseFloat(v.replace(/[$,\s]/g, ''));
                      return isFinite(n) ? n : null;
                    }
                    return null;
                  };
                  const housing = fields.housing || {};
                  const other = fields.other || {};
                  const finance = fields.finance || {};
                  const currentVal =
                    toNum(fields.currentValue) ??
                    toNum(housing.currentValue) ??
                    toNum(other.currentValue) ??
                    toNum(other.value) ??
                    toNum(finance.balance) ??
                    toNum(fields.value);
                  const purchaseVal =
                    toNum(fields.purchasePrice) ??
                    toNum(other.purchasePrice) ??
                    toNum(other.purchase_price) ??
                    toNum(fields.cost) ??
                    toNum(other.cost) ??
                    toNum(fields.amount) ??
                    toNum(fields.price) ??
                    toNum(other.price);
                  const vehicleFields = fields.vehicles || {};
                  const year = fields.year || vehicleFields.year || other.year || (fields.purchaseDate || other.purchaseDate || '')?.toString().slice(0, 4);
                  const make = fields.make || vehicleFields.make || other.make || '';
                  const model = fields.model || vehicleFields.model || other.model || '';
                  const mileage = fields.mileage || vehicleFields.mileage || other.mileage || fields.odometer || vehicleFields.odometer || other.odometer;
                  // Safely stringify potentially-object fields (legacy AI extractions can store objects)
                  const safeStr = (v: any): string => {
                    if (v == null || v === '') return '';
                    if (typeof v === 'string' || typeof v === 'number') return String(v);
                    if (typeof v === 'object') {
                      for (const k of ['provider', 'name', 'value', 'label', 'company']) {
                        if (typeof v[k] === 'string' || typeof v[k] === 'number') return String(v[k]);
                      }
                      return '';
                    }
                    return '';
                  };
                  const insuranceFields = fields.insurance || {};
                  const insurance = safeStr(fields.insuranceProvider) || safeStr(fields.insurance) || safeStr(insuranceFields.insurance) || safeStr(insuranceFields.insurer) || safeStr(insuranceFields.provider) || '';
                  const accentHsl = child.type === 'vehicle' ? '262 60% 62%' : child.type === 'investment' ? '142 60% 45%' : child.type === 'property' ? '220 60% 55%' : '262 60% 62%';
                  const ac = `hsl(${accentHsl})`;
                  // ─── Build a UNIFIED 2-line meta strip so every card has identical height ───
                  // Pick the two most relevant KPIs for this card. If a slot is empty,
                  // we still render a placeholder div so heights line up across the grid.
                  const metaLines: { label: string; value: string }[] = [];
                  const pushMeta = (label: string, value: string | undefined | null) => {
                    if (value != null && String(value).trim() !== '' && metaLines.length < 2) {
                      metaLines.push({ label, value: String(value) });
                    }
                  };
                  if (child.type === 'vehicle') {
                    pushMeta('Make/Model', [make, model].filter(Boolean).join(' ') || undefined);
                    pushMeta('Year', year ? String(year) : undefined);
                    pushMeta('Mileage', mileage ? `${Number(mileage).toLocaleString()} mi` : undefined);
                    pushMeta('Insurance', insurance ? insurance.slice(0, 16) : undefined);
                  } else if (child.type === 'property') {
                    pushMeta('Address', safeStr(fields.address) || safeStr(housing.address));
                    pushMeta('Type', safeStr(fields.propertyType) || safeStr(housing.propertyType));
                    pushMeta('Year', year ? String(year) : undefined);
                  } else if (child.type === 'investment') {
                    pushMeta('Account', safeStr(fields.accountType) || safeStr(finance.accountType));
                    pushMeta('Ticker', safeStr(fields.ticker) || safeStr(finance.ticker));
                    pushMeta('Institution', safeStr(fields.institution) || safeStr(finance.institution));
                  } else {
                    // Generic fallback (electronics, other)
                    pushMeta('Make/Model', [make, model].filter(Boolean).join(' ') || undefined);
                    pushMeta('Year', year ? String(year) : undefined);
                  }

                  const displayValue = (currentVal != null && currentVal > 0) ? currentVal
                                     : (purchaseVal != null && purchaseVal > 0) ? purchaseVal
                                     : null;
                  const valueLabel = (currentVal == null || currentVal === 0) && purchaseVal != null && purchaseVal > 0 ? 'purchase' : null;

                  return (
                    <Link key={child.id} href={`/profiles/${child.id}`} className="block h-full" onMouseEnter={() => warmProfileDetail(child.id)} onTouchStart={() => warmProfileDetail(child.id)}>
                      <EntityCard
                        interactive
                        accent={accentHsl}
                        icon={Icon}
                        title={child.name}
                        value={displayValue != null ? `$${displayValue.toLocaleString()}` : undefined}
                        valueUnit={valueLabel ?? undefined}
                        emptyValue="Tap to add value"
                        meta={metaLines}
                        // Type and year were an 8px chip and an 8px string in the
                        // dead strip at the bottom. Same facts, in the app's one
                        // pill treatment.
                        pills={
                          <>
                            <StatusPill accent={accentHsl} className="capitalize">{child.type}</StatusPill>
                            {year && <StatusPill tone="neutral">{year}</StatusPill>}
                          </>
                        }
                        data-testid={`button-view-child-${child.id}`}
                      />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}


      {/* Liabilities Section (replaces Subscriptions) */}
      {viewMode === "cards" && (sectionFilter === "all" || sectionFilter === "liabilities") && (() => {
        const isShowAll = filterMode === "everyone";
        const _assetTypes = new Set(["vehicle", "asset", "investment", "property"]);
        const _profileByIdLiab = new Map<string, any>();
        (profiles || []).forEach(p => _profileByIdLiab.set(p.id, p));
        const _liabHasAssetAncestor = (p: any): boolean => {
          let cur: any = p;
          for (let i = 0; i < 32 && cur; i++) {
            const pid = cur.parentProfileId;
            if (!pid) return false;
            const par = _profileByIdLiab.get(pid);
            if (!par) return false;
            if (_assetTypes.has(par.type)) return true;
            cur = par;
          }
          return false;
        };
        const liabs = (profiles || []).filter(p => {
          if (!isLiabilityLikeProfile(p)) return false;
          // Hide liabilities nested under an asset — they live inside the
          // parent asset's detail page (Linked Liabilities section).
          if (_liabHasAssetAncestor(p)) return false;
          // Profile-level scope — route through canonical isLiabilityVisible
          // so co-owners via liability_profile_links are also visible (matches
          // every other surface and the chip counts).
          const pParent = p.parentProfileId as string | null | undefined;
          if (!isShowAll && !isLiabilityVisible(p.id, pParent)) return false;
          // Type chip filter — only applies on the Liabilities tab.
          if (sectionFilter === "liabilities" && subCatFilter !== "all") {
            if (liabilitySubcategoryOf(p) !== subCatFilter) return false;
          }
          return true;
        });
        if (liabs.length === 0) return (
          <div className="bubble p-6 text-center">
            <TrendingDown className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No liabilities yet</p>
            <p className="text-xs text-muted-foreground mt-1">Track mortgages, loans, credit cards, subscriptions, and recurring bills here</p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 h-8 text-xs"
              onClick={() => { setCreateProfileFilter(["liabilities", "subscriptions"]); setCreateProfileTitle("Add Liability"); setCreateProfileOpen(true); }}
              data-testid="btn-empty-add-liability"
            >
              <Plus className="h-3 w-3 mr-1" /> Add Liability
            </Button>
          </div>
        );
        // Compute totals — helps the user see total debt + monthly burden at a glance.
        const toNumLiab = (v: any): number | null => {
          if (v == null || v === '') return null;
          if (typeof v === 'number' && isFinite(v)) return v;
          if (typeof v === 'string') { const n = parseFloat(v.replace(/[$,\s\/a-zA-Z]/g, '')); return isFinite(n) ? n : null; }
          return null;
        };
        const totalBalance = liabs.reduce((s, l) => {
          // Subscriptions don't carry a payoff balance — only sum balances on
          // actual debt instruments so the header total stays meaningful.
          if (l.type === "subscription") return s;
          const f: any = l.fields || {}; const fin = f.finance || {};
          return s + (toNumLiab(f.currentBalance ?? f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance) || 0);
        }, 0);
        const totalMonthly = liabs.reduce((s, l) => {
          const f: any = l.fields || {}; const fin = f.finance || {};
          // Subscription per-period cost normalised to monthly.
          if (l.type === "subscription") {
            const cost = toNumLiab(f.cost ?? f.amount) || 0;
            const freq = String(f.frequency || "monthly").toLowerCase();
            const monthly = freq.startsWith("y") ? cost / 12 : freq.startsWith("w") ? cost * 52 / 12 : freq.startsWith("q") ? cost / 3 : freq.startsWith("b") ? cost * 26 / 12 : cost;
            return s + monthly;
          }
          return s + (toNumLiab(f.monthlyPayment ?? fin.monthlyPayment) || 0);
        }, 0);
        // Red-tinted accent because liabilities are debt; a pure-red would feel
        // alarmist on a calm dashboard, so we soften with the same lightness as
        // the Assets purple to keep visual weight balanced.
        const accentHsl = '0 72% 55%';
        const ac = `hsl(${accentHsl})`;
        return (
          <div className="space-y-2">
            {!(hubEmbedded && sectionFilter !== "all") && (
            <button onClick={() => toggleSection("liabilities")} className="pressable flex items-center gap-3 w-full px-1 py-1 rounded-xl text-left" data-testid="section-toggle-liabilities">
              <Medallion icon={TrendingDown} accent={accentHsl} size="sm" />
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold tracking-tight" style={{ color: ac }}>Liabilities</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: `hsl(${accentHsl} / 0.15)`, color: ac }}>{liabs.length}</span>
                  {totalBalance > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">${Math.round(totalBalance).toLocaleString()} total</span>}
                  {totalMonthly > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">· ${Math.round(totalMonthly).toLocaleString()}/mo</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">Mortgages, loans, credit cards, subscriptions, and recurring bills</p>
              </div>
              {collapsedSections.has("liabilities") ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" /> : <ChevronUp className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
            </button>
            )}
            {(!collapsedSections.has("liabilities") || (hubEmbedded && sectionFilter !== "all")) && (() => {
              // Photo-4 layout: split into FIXED (amortizing loans — mortgage,
              // auto, student, personal) vs VARIABLE (revolving cards, one-time
              // debt, recurring bills) using the shared family classifier, and
              // render each as a labeled card (Type / Creditor / Balance / Due
              // Date + payoff progress bar).
              const sortByName = (a: any, b: any) => (a.name || '').localeCompare(b.name || '');
              const fixed = liabs.filter(l => liabilityFamily(l.type_key) === 'amortizing').sort(sortByName);
              const variable = liabs.filter(l => liabilityFamily(l.type_key) !== 'amortizing').sort(sortByName);
              const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
              const parseDue = (raw: any): Date | null => {
                if (!raw) return null;
                const d = new Date(String(raw).slice(0, 10) + "T00:00:00");
                return isNaN(d.getTime()) ? null : d;
              };
              const fmtDue = (raw: any): string | null => {
                const d = parseDue(raw);
                return d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
              };
              // Whole days from today to the due date — drives the countdown pill
              // in the footer, which is what now fills the space these cards used
              // to leave blank.
              const daysUntilDue = (raw: any): number | null => {
                const d = parseDue(raw);
                if (!d) return null;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                return Math.round((d.getTime() - today.getTime()) / 86400000);
              };
              const renderCard = (liab: any) => {
                const fields: any = liab.fields || {};
                const fin = fields.finance || {};
                const isSubscription = liab.type === "subscription";
                const balance = toNumLiab(fields.currentBalance ?? fields.remainingBalance ?? fields.loanBalance ?? fields.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance);
                const subFreq = String(fields.frequency || fields.billingFrequency || "monthly").toLowerCase();
                const subCost = toNumLiab(fields.cost ?? fields.monthlyAmount ?? fields.amount);
                const apr = toNumLiab(fields.annualInterestRate ?? fields.apr ?? fin.annualInterestRate);
                const lender = fields.lender || fin.lender || fields.provider || fields.creditor || fin.creditor || '';
                const subtype = liabilitySubcategoryOf(liab);
                const original = toNumLiab(fields.originalBalance ?? fin.originalBalance ?? fields.originalLoanAmount ?? fin.originalLoanAmount ?? fields.creditLimit ?? fin.creditLimit);
                const paidPct = (original && balance != null && original > 0) ? Math.max(0, Math.min(1, 1 - (balance / original))) : 0;
                const rawDue = fields.dueDate ?? fields.nextDueDate ?? fields.due_date ?? fin.dueDate;
                const due = fmtDue(rawDue);
                const dueIn = daysUntilDue(rawDue);
                const freqUnit = subFreq.startsWith('y') ? 'yr' : subFreq.startsWith('w') ? 'wk' : subFreq.startsWith('q') ? 'qtr' : 'mo';
                const isRecurring = isSubscription || liabilityFamily(liab.type_key) === 'recurring';
                const hasProgress = original != null && original > 0 && balance != null;

                // Headline: current balance (debt) or the recurring amount (bills).
                const headline = (balance != null && balance > 0)
                  ? { value: fmtMoney(balance), unit: "bal" }
                  : (isRecurring && subCost != null && subCost > 0)
                    ? { value: fmtMoney(subCost), unit: `/${freqUnit}` }
                    : null;

                const meta: { label: string; value: React.ReactNode }[] = [
                  { label: "Type", value: <span className="capitalize">{subtype}</span> },
                ];
                if (lender) meta.push({ label: "Creditor", value: String(lender) });
                if (apr != null && apr > 0) meta.push({ label: "APR", value: `${apr < 1 ? (apr * 100).toFixed(2) : apr.toFixed(2)}%` });
                if (due && !hasProgress) meta.push({ label: "Due", value: due });

                return (
                  <Link key={liab.id} href={`/profiles/${liab.id}`} className="block h-full" onMouseEnter={() => warmProfileDetail(liab.id)} onTouchStart={() => warmProfileDetail(liab.id)}>
                    <EntityCard
                      interactive
                      accent={accentHsl}
                      icon={TrendingDown}
                      title={liab.name}
                      value={headline?.value}
                      valueUnit={headline?.unit}
                      emptyValue="No balance set"
                      meta={meta}
                      progress={hasProgress ? {
                        value: paidPct,
                        left: `${Math.round(paidPct * 100)}% paid`,
                        right: `of ${fmtMoney(original!)}`,
                      } : undefined}
                      // The countdown is the one thing you actually want off a
                      // liability card at a glance, and it fills the bottom third
                      // that used to be blank.
                      pills={dueIn != null
                        ? <StatusPill tone={toneForDays(dueIn)}>{dayLabel(dueIn)}</StatusPill>
                        : <StatusPill tone="neutral">No due date</StatusPill>}
                      actions={<Pencil className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden="true" />}
                      data-testid={`liab-card-${liab.id}`}
                    />
                  </Link>
                );
              };
              const Group = ({ title, items }: { title: string; items: any[] }) => items.length === 0 ? null : (
                <div>
                  <SectionHeading title={title} icon={TrendingDown} accent={accentHsl} count={items.length} />
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 items-stretch" style={{ gridAutoRows: 178 }}>{items.map(renderCard)}</div>
                </div>
              );
              return (
                <div className="space-y-4">
                  <Group title="Fixed Liabilities" items={fixed} />
                  <Group title="Variable Liabilities" items={variable} />
                </div>
              );
            })()}
          </div>
        );
      })()}

      {/* Documents Section */}
      {viewMode === "cards" && (sectionFilter === "all" || sectionFilter === "documents") && <div className="space-y-2">
        <div className="flex items-center justify-between">
          {!(hubEmbedded && sectionFilter !== "all") && (
          <button onClick={() => toggleSection("documents")} className="pressable flex items-center gap-3 w-full px-1 py-1 rounded-xl text-left" data-testid="section-toggle-documents">
              <Medallion icon={FileText} accent="25 80% 54%" size="sm" />
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold tracking-tight" style={{ color: 'hsl(25 80% 54%)' }}>Documents</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'hsl(25 80% 54% / 0.15)', color: 'hsl(25 80% 54%)' }}>{filteredDocuments.length}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">IDs, insurance, contracts, and more</p>
              </div>
              {collapsedSections.has("documents") ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" /> : <ChevronUp className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
            </button>
            )}
          <div className="flex items-center gap-2">
            {/* Profile selector for upload — link doc to a specific profile */}
            <Select value={uploadProfileId} onValueChange={setUploadProfileId}>
              <SelectTrigger className="w-[120px] h-7 text-xs" data-testid="select-upload-profile">
                <SelectValue placeholder="For: Auto-detect" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto"><span className="text-muted-foreground">Auto-detect</span></SelectItem>
                {(profiles || []).filter(p => ["self", "person", "pet", "vehicle", "asset"].includes(p.type)).sort((a, b) => {
                  if (a.type === "self") return -1;
                  if (b.type === "self") return 1;
                  return a.name.localeCompare(b.name);
                }).map(p => {
                  const Icon = PROFILE_TYPE_ICONS[p.type] || User;
                  return <SelectItem key={p.id} value={p.id}><span className="flex items-center gap-1.5"><Icon className="h-3 w-3" /> {p.type === "self" ? "Me" : p.name}</span></SelectItem>;
                })}
              </SelectContent>
            </Select>
            <input
              ref={docFileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) docUploadMutation.mutate(file);
                e.target.value = "";
              }}
              data-testid="input-upload-document-global"
              accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.rtf,.json,text/*"
            />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-xs h-7"
              onClick={() => docFileInputRef.current?.click()}
              disabled={docUploadMutation.isPending}
              data-testid="button-upload-document-global"
            >
              <Upload className="h-3 w-3" />
              {docUploadMutation.isPending ? "Processing..." : "Upload"}
            </Button>
          </div>
        </div>
        {(!collapsedSections.has("documents") || (hubEmbedded && sectionFilter !== "all")) && (
          <div className="space-y-2">
            {allDocuments.length > 3 && (
              <input
                type="text"
                placeholder="Search documents..."
                value={docSearch}
                onChange={e => setDocSearch(e.target.value)}
                className="w-full h-8 px-3 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                data-testid="input-search-documents-global"
              />
            )}
            {/* Only show the inline doc-type chips on the "All" tab. When the
                user is already on the Documents tab, the contextual filter row
                at the top of the page handles type filtering, and showing it
                twice would be noisy. */}
            {sectionFilter === "all" && docTypes.length > 1 && (
              <div className="flex items-center gap-1.5 overflow-x-auto flex-nowrap scrollbar-hide" style={{ WebkitOverflowScrolling: 'touch' }}>
                <button
                  onClick={() => setDocTypeFilter("all")}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${docTypeFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  data-testid="filter-doctype-all"
                >All ({profileFilteredDocs.length})</button>
                {docTypes.map(t => {
                  const count = profileFilteredDocs.filter(d => normalizeFilter(d.type) === normalizeFilter(t)).length;
                  return (
                    <button
                      key={t}
                      onClick={() => setDocTypeFilter(t)}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 ${docTypeFilter === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                      data-testid={`filter-doctype-${t}`}
                    >
                      {t.replace(/_/g, " ")} ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {(!collapsedSections.has("documents") || (hubEmbedded && sectionFilter !== "all")) && (filteredDocuments.length === 0 ? (
          <div className="bubble p-6 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{allDocuments.length === 0 ? "No documents yet" : "No documents match your search"}</p>
            <p className="text-xs text-muted-foreground mt-1">Upload files or ask Portol to save documents</p>
          </div>
        ) : (() => {
          const DOC_TYPE_HSL: Record<string, string> = {
            medical: '0 72% 51%', insurance: '213 72% 51%', legal: '270 60% 55%',
            financial: '142 60% 45%', identity: '38 92% 50%', warranty: '25 80% 54%',
            receipt: '160 60% 45%', drivers_license: '38 92% 50%',
          };
          const DOC_TYPE_EMOJI: Record<string, string> = {
            medical: '🏥', insurance: '🛡️', legal: '⚖️', financial: '💰',
            identity: '🆔', warranty: '🛠️', receipt: '🧾', drivers_license: '🚗',
          };
          const DOC_TYPE_ORDER: Record<string, number> = {
            identity: 0, medical: 1, insurance: 2, legal: 3, financial: 4,
            warranty: 5, receipt: 6, drivers_license: 7,
          };
          // Group documents by type
          const docsByType: Record<string, typeof filteredDocuments> = {};
          for (const doc of filteredDocuments) {
            const t = doc.type || 'other';
            (docsByType[t] = docsByType[t] || []).push(doc);
          }
          const sortedDocTypes = Object.keys(docsByType).sort((a, b) => {
            const oa = DOC_TYPE_ORDER[a] ?? 99;
            const ob = DOC_TYPE_ORDER[b] ?? 99;
            return oa - ob || a.localeCompare(b);
          });
          // If only one type group, skip the sub-headers
          const showTypeHeaders = sortedDocTypes.length > 1;
          return (
            <div className="space-y-2">
              {sortedDocTypes.map(docType => {
                const docs = docsByType[docType];
                const accentHslForType = DOC_TYPE_HSL[docType] || '25 80% 54%';
                return (
                  <div key={docType}>
                    {showTypeHeaders && (
                      <div className="mt-3">
                        <SectionHeading
                          title={docType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                          icon={FileText}
                          accent={accentHslForType}
                          count={docs.length}
                        />
                      </div>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 items-stretch" style={{ gridAutoRows: 196 }}>
                      {docs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(doc => {
                        const accentHsl = DOC_TYPE_HSL[doc.type] || '25 80% 54%';
                        const linkedNames = (doc.linkedProfiles || []).map((pid: string) => (profiles || []).find(p => p.id === pid)?.name).filter(Boolean);
                        const createdDate = new Date(doc.createdAt);
                        const daysSince = Math.floor((Date.now() - createdDate.getTime()) / 86400000);
                        const mimeShort = doc.mimeType?.includes('pdf') ? 'PDF' : doc.mimeType?.includes('image') ? 'Image' : doc.mimeType?.includes('word') || doc.mimeType?.includes('doc') ? 'Word' : 'File';
                        const docMeta = [
                          { label: "Format", value: mimeShort },
                          { label: "Added", value: createdDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) },
                          ...(linkedNames.length > 0 ? [{ label: "Owner", value: linkedNames.join(', ') }] : []),
                        ];
                        return (
                          <EntityCard
                            key={doc.id}
                            interactive
                            accent={accentHsl}
                            icon={FileText}
                            title={doc.name}
                            // No headline: a document has no number worth
                            // shouting, and the type it used to shout is
                            // already in the section heading above and in the
                            // footer pill below.
                            meta={docMeta}
                            pills={
                              <>
                                <StatusPill accent={accentHsl} className="capitalize">{doc.type?.replace(/_/g, ' ') || 'doc'}</StatusPill>
                                {daysSince <= 7
                                  ? <StatusPill tone="good">New</StatusPill>
                                  : <StatusPill tone="neutral">{daysSince}d ago</StatusPill>}
                              </>
                            }
                            actions={
                              <>
                                <button onClick={stopProp(() => handleShareDoc(doc))} aria-label={`Share ${doc.name}`} className="text-muted-foreground/70 hover:text-foreground"><Share2 className="h-3.5 w-3.5" /></button>
                                <button onClick={stopProp(() => setDocDeleteConfirmId(doc.id))} aria-label={`Delete ${doc.name}`} className="text-muted-foreground/70 hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                              </>
                            }
                            data-testid={`global-doc-${doc.id}`}
                            onPointerDown={() => prefetchDocument(doc.id, doc.mimeType)}
                            onClick={() => setViewingDoc(doc)}
                            role="button"
                            tabIndex={0}
                            aria-label={`View document: ${doc.name}`}
                            onKeyDown={onEnterOrSpace(() => setViewingDoc(doc))}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })())}
      </div>}

      {/* Trackers Section */}
      {viewMode === "cards" && (sectionFilter === "all" || sectionFilter === "trackers") && ((!trackers || trackers.length === 0) ? (
        <div className="text-center py-16">
          <Activity className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No trackers yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Ask Portol in chat to create one — e.g. “track my weight”.
          </p>
        </div>
      ) : filteredTrackers.length === 0 ? (
        <div className="text-center py-12">
          <Users className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            No trackers match the current filter
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => { setFilterMode("everyone"); setFilterIds([]); }}
            data-testid="button-clear-filter"
          >
            Show All Trackers
          </Button>
        </div>
      ) : ((viewMode as string) === "table") ? (
        <div className="rounded-lg border border-border/40 overflow-hidden" data-testid="tracker-table">
          {/* Dynamic KPI rows — grouped by canonical group */}
          {sortedCats.map(groupName => {
            const gDef = CANONICAL_GROUPS[groupName];
            const GIcon = gDef?.icon || Box;
            const gAccent = gDef?.accent || "240 20% 60%";
            return (
              <div key={groupName}>
                {/* Group header row */}
                <div className="flex items-center gap-2 px-2 py-1.5 sticky top-0 z-10 backdrop-blur-sm"
                     style={{ background: `hsl(${gAccent} / 0.08)` }}>
                  <GIcon className="h-3 w-3" style={{ color: `hsl(${gAccent})` }} />
                  <span className="text-xs font-bold uppercase tracking-wider" style={{ color: `hsl(${gAccent})` }}>
                    {groupName}
                  </span>
                  <span className="text-xs text-muted-foreground">({grouped[groupName].length})</span>
                </div>
                {/* Trackers in this group */}
                {grouped[groupName].map((tracker) => {
            const entries = tracker.entries;
            const spec = detectSpecialization(tracker);
            const pf = tracker.fields.find(f => f.isPrimary)?.name || tracker.fields[0]?.name || "value";
            const unit = tracker.unit || "";
            const last = entries[entries.length - 1];
            const rv = last?.values;
            const pv = typeof rv === 'string' ? (() => { try { return JSON.parse(rv); } catch { return null; } })() : rv;
            const latestVal = pv?.[pf] ?? (pv ? Object.values(pv).find(v => typeof v === 'number') : null);
            const latestItem = pv?.["item"] as string | undefined;
            const isNutritionTracker = tracker.category === "nutrition" || tracker.name.toLowerCase().includes("nutrition") || tracker.name.toLowerCase().includes("calorie");

            // 7d average
            const week = entries.filter(e => Date.now() - new Date(e.timestamp).getTime() < 7 * 86400000);
            const wv = week.map(e => Number(e.values?.[pf])).filter(v => !isNaN(v));
            const avg7d = wv.length > 0 ? wv.reduce((a, b) => a + b, 0) / wv.length : null;

            // Previous week for trend
            const pw = entries.filter(e => {
              const age = Date.now() - new Date(e.timestamp).getTime();
              return age >= 7 * 86400000 && age < 14 * 86400000;
            });
            const pwv = pw.map(e => Number(e.values?.[pf])).filter(v => !isNaN(v));
            const prevAvg = pwv.length > 0 ? pwv.reduce((a, b) => a + b, 0) / pwv.length : null;
            const trendPct = avg7d != null && prevAvg != null && prevAvg !== 0
              ? ((avg7d - prevAvg) / Math.abs(prevAvg)) * 100 : null;

            // All numeric values for range/stats
            const vals = entries.map(e => Number(e.values?.[pf])).filter(v => !isNaN(v) && v !== 0);

            // BP display
            let displayVal = "—";
            if (spec === "bloodpressure" && pv) {
              const sys = pv.systolic || pv.sys || latestVal;
              const dia = pv.diastolic || pv.dia;
              displayVal = dia ? `${sys}/${dia}` : String(sys || "—");
            } else if (isNutritionTracker && latestItem) {
              displayVal = latestItem;
            } else if (latestVal != null) {
              displayVal = typeof latestVal === 'number' ? Number(latestVal).toFixed(1) : String(latestVal);
            }

            // Status badge
            let statusLabel = ""; let statusColor = "";
            if (spec === "bloodpressure" && pv) {
              const sys = Number(pv.systolic || pv.sys || latestVal || 0);
              if (sys >= 140) { statusLabel = "High"; statusColor = "text-red-500"; }
              else if (sys >= 130) { statusLabel = "Elevated"; statusColor = "text-amber-500"; }
              else if (sys > 0) { statusLabel = "Normal"; statusColor = "text-green-500"; }
            } else if (entries.length === 0) {
              statusLabel = "No data"; statusColor = "text-muted-foreground";
            } else if (entries.length < 3) {
              statusLabel = "New"; statusColor = "text-blue-500";
            } else {
              statusLabel = trendPct != null ? (trendPct > 2 ? "↑" : trendPct < -2 ? "↓" : "→") : "•";
              statusColor = trendPct != null ? (trendPct > 2 ? "text-green-500" : trendPct < -2 ? "text-orange-500" : "text-muted-foreground") : "text-muted-foreground";
            }

            // Last updated
            const lastUpdated = last ? (() => {
              const diff = Date.now() - new Date(last.timestamp).getTime();
              const mins = Math.floor(diff / 60000);
              if (mins < 60) return `${mins}m`;
              const hrs = Math.floor(mins / 60);
              if (hrs < 24) return `${hrs}h`;
              return `${Math.floor(hrs / 24)}d`;
            })() : "—";

            // Per-person trackers: each tracker has exactly ONE owner profile.
            // Use the first (and only) linked profile for the owner badge.
            const linkedProfile = profiles?.find(p => tracker.linkedProfiles?.includes(p.id));

            // === Dynamic KPIs per tracker type ===
            type KPI = { label: string; value: string; color?: string };
            const kpis: KPI[] = [];

            if (spec === "bloodpressure" && last) {
              const sys = Number(pv?.systolic || pv?.sys || 0);
              const dia = Number(pv?.diastolic || pv?.dia || 0);
              kpis.push({ label: "BP", value: dia ? `${sys}/${dia}` : `${sys}`, color: sys >= 140 ? "text-red-500" : sys >= 130 ? "text-amber-500" : "text-green-500" });
              if (avg7d != null) kpis.push({ label: "7d Avg", value: avg7d.toFixed(0) + " mmHg" });
              const range = vals.length >= 2 ? `${Math.min(...vals)}-${Math.max(...vals)}` : null;
              if (range) kpis.push({ label: "Range", value: range });
              kpis.push({ label: "Readings", value: String(entries.length) });
            } else if (spec === "weight") {
              kpis.push({ label: "Current", value: displayVal + " " + unit });
              if (avg7d != null) kpis.push({ label: "7d Avg", value: avg7d.toFixed(1) + " " + unit });
              if (vals.length >= 2) {
                const change = vals[vals.length - 1] - vals[0];
                kpis.push({ label: "Change", value: `${change > 0 ? "+" : ""}${change.toFixed(1)} ${unit}`, color: change > 0 ? "text-amber-500" : "text-green-500" });
              }
              kpis.push({ label: "Logged", value: `${entries.length}x` });
            } else if (spec === "running" || tracker.category === "fitness") {
              if (last?.values?.distance) kpis.push({ label: "Last Run", value: `${Number(last.values.distance).toFixed(1)} mi` });
              else kpis.push({ label: "Latest", value: displayVal + " " + unit });
              const weekEntries = entries.filter(e => Date.now() - new Date(e.timestamp).getTime() < 7 * 86400000);
              const weekTotal = weekEntries.reduce((s, e) => s + (Number(e.values?.distance || e.values?.[pf]) || 0), 0);
              kpis.push({ label: "This Week", value: `${weekTotal.toFixed(1)} ${unit || "mi"} · ${weekEntries.length}x` });
              if (last?.values?.pace) kpis.push({ label: "Pace", value: `${last.values.pace} min/mi` });
              if (last?.values?.caloriesBurned) kpis.push({ label: "Burned", value: `${last.values.caloriesBurned} cal` });
              if (kpis.length < 4) kpis.push({ label: "Total", value: `${entries.length} sessions` });
            } else if (spec === "sleep") {
              kpis.push({ label: "Last Night", value: displayVal + " hrs" });
              if (avg7d != null) kpis.push({ label: "7d Avg", value: avg7d.toFixed(1) + " hrs", color: avg7d >= 7 ? "text-green-500" : avg7d >= 6 ? "text-amber-500" : "text-red-500" });
              if (vals.length >= 2) kpis.push({ label: "Best", value: Math.max(...vals).toFixed(1) + " hrs" });
              kpis.push({ label: "Logged", value: `${entries.length} nights` });
            } else if (tracker.category === "nutrition" || tracker.name.toLowerCase().includes("calorie")) {
              const todayEntries = entries.filter(e => e.timestamp.startsWith(new Date().toISOString().slice(0, 10)));
              const todayTotal = todayEntries.reduce((s, e) => s + (Number(e.values?.[pf]) || 0), 0);
              kpis.push({ label: "Today", value: `${todayTotal.toLocaleString()} ${unit}` });
              if (avg7d != null) kpis.push({ label: "Daily Avg", value: `${avg7d.toFixed(0)} ${unit}` });
              kpis.push({ label: "Entries", value: `${entries.length}` });
              if (vals.length >= 2) kpis.push({ label: "High", value: `${Math.max(...vals).toLocaleString()} ${unit}` });
            } else if (tracker.name.toLowerCase().includes("hydration") || tracker.name.toLowerCase().includes("water")) {
              const todayEntries = entries.filter(e => e.timestamp.startsWith(new Date().toISOString().slice(0, 10)));
              const todayTotal = todayEntries.reduce((s, e) => s + (Number(e.values?.[pf]) || 0), 0);
              kpis.push({ label: "Today", value: `${todayTotal} ml`, color: todayTotal >= 2000 ? "text-green-500" : todayTotal >= 1000 ? "text-amber-500" : "text-red-400" });
              if (avg7d != null) kpis.push({ label: "Daily Avg", value: `${avg7d.toFixed(0)} ml` });
              kpis.push({ label: "Goal", value: todayTotal >= 2000 ? "✓ Met" : `${2000 - todayTotal}ml left`, color: todayTotal >= 2000 ? "text-green-500" : undefined });
            } else if (tracker.name.toLowerCase().includes("heart rate") || tracker.name.toLowerCase().includes("hr")) {
              kpis.push({ label: "Latest", value: displayVal + " bpm" });
              if (avg7d != null) kpis.push({ label: "Resting Avg", value: avg7d.toFixed(0) + " bpm" });
              if (vals.length >= 2) kpis.push({ label: "Range", value: `${Math.min(...vals)}-${Math.max(...vals)} bpm` });
              kpis.push({ label: "Readings", value: String(entries.length) });
            } else if (tracker.name.toLowerCase().includes("medication")) {
              const todayDoses = entries.filter(e => e.timestamp.startsWith(new Date().toISOString().slice(0, 10))).length;
              kpis.push({ label: "Today", value: `${todayDoses} dose${todayDoses !== 1 ? "s" : ""}`, color: todayDoses > 0 ? "text-green-500" : "text-muted-foreground" });
              kpis.push({ label: "This Week", value: `${entries.filter(e => Date.now() - new Date(e.timestamp).getTime() < 7 * 86400000).length} doses` });
              kpis.push({ label: "Total", value: `${entries.length} logged` });
            } else if (tracker.name.toLowerCase().includes("tire") || tracker.name.toLowerCase().includes("pressure")) {
              if (last?.values?.front) kpis.push({ label: "Front", value: `${last.values.front} psi` });
              if (last?.values?.rear) kpis.push({ label: "Rear", value: `${last.values.rear} psi` });
              kpis.push({ label: "Checked", value: `${entries.length}x` });
            } else if (tracker.name.toLowerCase().includes("mood") || tracker.name.toLowerCase().includes("stress")) {
              kpis.push({ label: "Latest", value: displayVal });
              if (avg7d != null) kpis.push({ label: "7d Avg", value: avg7d.toFixed(1) + "/10" });
              kpis.push({ label: "Logged", value: `${entries.length}x` });
            } else if (tracker.name.toLowerCase().includes("pain")) {
              kpis.push({ label: "Current", value: displayVal + "/10", color: Number(latestVal) >= 7 ? "text-red-500" : Number(latestVal) >= 4 ? "text-amber-500" : "text-green-500" });
              if (avg7d != null) kpis.push({ label: "7d Avg", value: avg7d.toFixed(1) + "/10" });
              kpis.push({ label: "Reports", value: String(entries.length) });
            } else {
              // Generic fallback
              kpis.push({ label: "Latest", value: displayVal + (unit ? " " + unit : "") });
              if (avg7d != null) kpis.push({ label: "7d Avg", value: avg7d.toFixed(1) + (unit ? " " + unit : "") });
              if (trendPct != null) kpis.push({ label: "Trend", value: `${trendPct > 0 ? "+" : ""}${trendPct.toFixed(0)}%`, color: trendPct > 2 ? "text-green-500" : trendPct < -2 ? "text-orange-500" : undefined });
              kpis.push({ label: "Entries", value: String(entries.length) });
            }

            // Dynamic insight
            let insight = "";
            if (entries.length === 0) insight = "No data yet — log your first entry";
            else if (entries.length === 1) insight = "Just started tracking";
            else if (spec === "bloodpressure" && Number(pv?.systolic || 0) >= 140) insight = "⚠️ Blood pressure is high — consult your doctor";
            else if (spec === "bloodpressure" && Number(pv?.systolic || 0) >= 130) insight = "Slightly elevated — monitor closely";
            else if (spec === "weight" && trendPct != null && trendPct > 5) insight = "Weight trending up this week";
            else if (spec === "weight" && trendPct != null && trendPct < -5) insight = "Weight trending down this week";
            else if (spec === "sleep" && avg7d != null && avg7d < 6) insight = "⚠️ Below recommended 7+ hours";
            else if (spec === "sleep" && avg7d != null && avg7d >= 7) insight = "✓ Meeting sleep goal";
            else if (tracker.name.toLowerCase().includes("hydration")) {
              const todayH = entries.filter(e => e.timestamp.startsWith(new Date().toISOString().slice(0, 10))).reduce((s, e) => s + (Number(e.values?.[pf]) || 0), 0);
              if (todayH >= 2000) insight = "✓ Hydration goal met today";
              else if (todayH > 0) insight = `${2000 - todayH}ml to go today`;
            } else if (trendPct != null && Math.abs(trendPct) > 10) insight = `${trendPct > 0 ? "Increasing" : "Decreasing"} ${Math.abs(trendPct).toFixed(0)}% vs last week`;
            else if (entries.length >= 7) {
              const streak = computeStreak(entries);
              if (streak >= 3) insight = `${streak}-day logging streak 🔥`;
            }

            return (
              <div
                key={tracker.id}
                className="border-b border-border/20 hover:bg-muted/30 cursor-pointer transition-all px-2.5 py-2 flex items-center gap-2 relative overflow-hidden"
                data-testid={`tracker-row-${tracker.id}`}
                style={{ background: `linear-gradient(90deg, hsl(${getCategoryAccent(tracker.category)} / 0.08) 0%, transparent 40%)` }}
                onClick={() => setSelectedTrackerId(tracker.id)}
                role="button"
                tabIndex={0}
                aria-label={`Open tracker: ${tracker.name}`}
                onKeyDown={onEnterOrSpace(() => setSelectedTrackerId(tracker.id))}
              >
                {/* Category accent left bar */}
                <div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-l" style={{ background: `hsl(${getCategoryAccent(tracker.category)})` }} />
                {/* Left: Name + category badge */}
                <div className="min-w-0 w-[120px] md:w-[160px] shrink-0 pl-1">
                  <p className="text-xs-loose font-medium truncate leading-tight">
                    {cleanTrackerName(tracker.name, profiles || undefined, tracker.linkedProfiles)}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5">
                    {linkedProfile && <span className="text-2xs px-1 rounded bg-primary/10 text-primary">{linkedProfile.name}</span>}
                    <span
                      className="text-2xs px-1.5 py-0.5 rounded-full font-medium capitalize"
                      style={{ background: `hsl(${getCategoryAccent(tracker.category)} / 0.15)`, color: `hsl(${getCategoryAccent(tracker.category)})` }}
                    >
                      {tracker.category}
                    </span>
                  </div>
                </div>
                {/* Middle: KPI chips (scrollable) */}
                <div className="flex items-center gap-1.5 flex-1 overflow-x-auto min-w-0 scrollbar-hide">
                  {kpis.slice(0, 4).map((kpi, ki) => (
                    <div key={ki} className="flex items-center gap-0.5 bg-muted/40 rounded px-1.5 py-0.5 shrink-0">
                      <span className="text-2xs text-muted-foreground">{kpi.label}</span>
                      <span className={`text-xs-tight font-bold tabular-nums ${kpi.color || ""}`}>{kpi.value}</span>
                    </div>
                  ))}
                </div>
                {/* Right: Updated */}
                <span className="text-2xs text-muted-foreground shrink-0 w-8 text-right">{lastUpdated}</span>
              </div>
            );
          })}
              </div>
            );
          })}
        </div>
      ) : (
        /* ── PERSON-GROUPED CARD GRID ── */
        (() => {
          const allTrackersList = sortedCats.flatMap((cat) => grouped[cat]);
          const personGroups: Record<string, { name: string; type: string; trackers: typeof allTrackersList }> = {};
          const selfProfile = (profiles || []).find(p => p.type === 'self');
          const selfId = selfProfile?.id || '';
          // When a profile filter is active, only group under filtered profile IDs
          const activeFilterIds = (filterMode === "selected" && filterIds.length > 0) ? new Set(filterIds) : null;
          for (const t of allTrackersList) {
            const lp = t.linkedProfiles || [];
            if (lp.length === 0) {
              const key = selfId || '__me__';
              if (!activeFilterIds || activeFilterIds.has(key)) {
                if (!personGroups[key]) personGroups[key] = { name: selfProfile?.name || 'Me', type: 'self', trackers: [] };
                personGroups[key].trackers.push(t);
              }
            } else {
              for (const pid of lp) {
                // Skip person groups that don't match the active filter
                if (activeFilterIds && !activeFilterIds.has(pid)) continue;
                const prof = (profiles || []).find(p => p.id === pid);
                if (!personGroups[pid]) personGroups[pid] = { name: prof?.name || 'Unknown', type: prof?.type || 'person', trackers: [] };
                personGroups[pid].trackers.push(t);
              }
            }
          }
          const typeOrder: Record<string, number> = { self: 0, person: 1, pet: 2 };
          const sortedKeys = Object.keys(personGroups).sort((a, b) => {
            const ta = typeOrder[personGroups[a].type] ?? 3;
            const tb = typeOrder[personGroups[b].type] ?? 3;
            return ta - tb || personGroups[a].name.localeCompare(personGroups[b].name);
          });
          return (
            <div className="space-y-4">
              {sortedKeys.map(pk => {
                const g = personGroups[pk];
                const icon = g.type === 'self' ? '👤' : g.type === 'pet' ? '🐾' : '👥';
                // ── Bucket by activity ────────────────────────────────────
                // Previously trackers were sliced into Health/Fitness/Lifestyle/
                // Other regardless of whether they had data. Empty trackers
                // filled the dashboard with placeholder cards. We now sort
                // every tracker into one of four piles based on its last
                // entry timestamp and whether it has a clinical concern. The
                // "No Data" pile collapses behind a single pill.
                type Bucket = "active" | "recent" | "attention" | "empty";
                const buckets: Record<Bucket, typeof g.trackers> = { active: [], recent: [], attention: [], empty: [] };
                const todayKey = new Date().toLocaleDateString('en-CA');
                const SEVEN_DAYS = 7 * 86400000;
                for (const t of g.trackers) {
                  const ins = buildTrackerInsight(t);
                  if (!ins.hasData) { buckets.empty.push(t); continue; }
                  // Attention: any tracker whose insight produced a red/yellow
                  // status badge OR an incomplete BP reading.
                  const sb = ins.statusBadge;
                  const isAttention = sb && (
                    sb.label === 'High' || sb.label === 'Crisis' ||
                    sb.label === 'Elevated' || sb.label === 'Low' ||
                    sb.label === 'Incomplete' || sb.label === 'Stale'
                  );
                  if (isAttention) { buckets.attention.push(t); continue; }
                  const entries = (t.entries || []);
                  const last = entries.length
                    ? [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]
                    : null;
                  const lastTs = last ? new Date(last.timestamp).getTime() : 0;
                  const lastDay = last ? new Date(last.timestamp).toLocaleDateString('en-CA') : '';
                  if (lastDay === todayKey) buckets.active.push(t);
                  else if (Date.now() - lastTs <= SEVEN_DAYS) buckets.recent.push(t);
                  else buckets.attention.push(t); // stale → also "needs attention"
                }
                // Sort within each bucket: by importance first (large→compact),
                // then by name. Pushes Weight / Sleep / BP to the top of their
                // row so high-value metrics anchor each section.
                const importanceWeight: Record<string, number> = { large: 0, normal: 1, compact: 2 };
                const sortByImportance = (a: any, b: any) => {
                  const ai = importanceWeight[buildTrackerInsight(a).importance];
                  const bi = importanceWeight[buildTrackerInsight(b).importance];
                  return (ai - bi) || (a.name || '').localeCompare(b.name || '');
                };
                (Object.keys(buckets) as Bucket[]).forEach(k => buckets[k].sort(sortByImportance));

                // Bucket metadata (label + dot color).
                const BUCKET_DEFS: { key: Bucket; label: string; dot: string }[] = [
                  { key: 'active', label: 'Active Today', dot: '#16a34a' },
                  { key: 'attention', label: 'Needs Attention', dot: '#dc2626' },
                  { key: 'recent', label: 'Recently Logged', dot: '#2563eb' },
                ];
                const visibleBuckets = BUCKET_DEFS.filter(b => buckets[b.key].length > 0);

                return (
                  <div key={pk}>
                    <div className="flex items-center gap-2 mb-2 px-0.5">
                      <span className="text-sm">{icon}</span>
                      <span className="text-xs font-bold text-foreground">{g.type === 'self' ? 'Me' : g.name}</span>
                      <span className="text-[10px] text-muted-foreground">({g.trackers.length})</span>
                    </div>
                    {visibleBuckets.map(b => {
                      const bt = buckets[b.key];
                      return (
                        <div key={b.key} className="mb-3">
                          <h4 className="text-xs font-semibold uppercase tracking-wider mt-3 mb-1.5 flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: b.dot }} />
                            <span style={{ color: b.dot }}>{b.label}</span>
                            <span className="text-muted-foreground font-normal">({bt.length})</span>
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                            {bt.map(tracker => {
                              const imp = buildTrackerInsight(tracker).importance;
                              // Large trackers (Weight/Sleep/BP/Run/Walk) take
                              // 2 columns on md+ so they read like the hero
                              // metrics they are. Compact trackers stay
                              // single-column. "col-span-1" is the default —
                              // we only need to override for large.
                              const span = imp === 'large' ? 'sm:col-span-2 md:col-span-2' : '';
                              return (
                                <div key={tracker.id} className={span}>
                                  <TrackerCard tracker={tracker} hideProfilePrefix onDelete={(id) => setDeleteTargetId(id)} onOpenDetail={(id) => setSelectedTrackerId(id)} />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    {buckets.empty.length > 0 && (
                      <NoDataPile
                        trackers={buckets.empty}
                        onOpenDetail={(id) => setSelectedTrackerId(id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()
      ))}

      {/* Create tracker dialog */}
      <CreateTrackerDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CreateProfileDialog
        open={createProfileOpen}
        onClose={() => setCreateProfileOpen(false)}
        initialCategoryFilter={createProfileFilter}
        titleOverride={createProfileTitle}
      />

      {/* Delete tracker confirmation */}
      {deleteTarget && (
        <DeleteTrackerDialog
          trackerId={deleteTarget.id}
          trackerName={deleteTarget.name}
          open={!!deleteTargetId}
          onOpenChange={(v) => { if (!v) setDeleteTargetId(null); }}
        />
      )}

      {/* Tracker detail dialog */}
      <TrackerDetailDialog
        tracker={selectedTracker}
        open={!!selectedTracker}
        onClose={() => setSelectedTrackerId(null)}
      />

      {/* Document delete confirmation */}
      {docDeleteConfirmId && (() => {
        const docName = allDocuments.find(d => d.id === docDeleteConfirmId)?.name || "this document";
        return (
          <AlertDialog open onOpenChange={(open) => { if (!open) setDocDeleteConfirmId(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete document?</AlertDialogTitle>
                <AlertDialogDescription>
                  <span className="font-medium text-foreground">"{docName}"</span> will be permanently deleted and cannot be recovered.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setDocDeleteConfirmId(null)}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  onClick={() => { docDeleteMutation.mutate(docDeleteConfirmId); setDocDeleteConfirmId(null); setExpandedDocId(null); }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        );
      })()}

      {/* Send Dialog removed — now uses native share sheet (Web Share API) */}

      {viewingDoc && (
        <DocumentViewerDialog
          id={viewingDoc.id}
          name={viewingDoc.name}
          mimeType={viewingDoc.mimeType}
          data={viewingDoc.fileData}
          open={!!viewingDoc}
          onOpenChange={(open) => { if (!open) setViewingDoc(null); }}
        />
      )}
    </div>
  );
}
