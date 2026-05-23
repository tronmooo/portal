import { formatApiError } from "@/lib/formatError";
import { stopProp } from "@/lib/event-utils";
import { normalizeFilter } from "@/lib/filter-utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getProfileFilter, subscribeProfileFilter } from "@/lib/profileFilter";
import EditableTitle from "@/components/EditableTitle";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { CreateProfileDialog } from "@/pages/profiles";
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
} from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Tracker, TrackerEntry, TrackerField, ComputedData, Profile, Document } from "@shared/schema";
import { ShareButton, DocumentViewerDialog } from "@/components/DocumentViewer";
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

export function getCategoryAccent(category: string): string {
  return TRACKER_CATEGORY_ACCENT[category?.toLowerCase()] || TRACKER_CATEGORY_ACCENT.general;
}

// ── Canonical Category Groups ──────────────────────────────────────────────────
// Map raw DB categories → canonical display groups
const CANONICAL_GROUP_MAP: Record<string, string> = {
  // Health (body vitals, medical, sleep, nutrition, mental, lab work)
  health:       "Health",
  sleep:        "Health",
  nutrition:    "Health",
  mental:       "Mental & Wellness",
  medical:      "Health",
  vitals:       "Health",
  hydration:    "Health",
  diet:         "Health",
  mood:         "Mental & Wellness",
  physical:     "Health",
  // Lab panels / blood work / clinical results all roll up into Health
  "metabolic panel":      "Health",
  "complete blood count": "Health",
  "lipid panel":          "Health",
  "lipid profile":        "Health",
  "thyroid panel":        "Health",
  "liver panel":          "Health",
  "kidney panel":         "Health",
  "basic metabolic":      "Health",
  "comprehensive metabolic": "Health",
  "cbc":                  "Health",
  "bmp":                  "Health",
  "cmp":                  "Health",
  "lab":                  "Health",
  "labs":                 "Health",
  "lab results":          "Health",
  "lab work":             "Health",
  "blood":                "Health",
  "blood work":           "Health",
  "cholesterol":          "Health",
  "glucose":              "Health",
  "hormone":              "Health",
  "hormones":             "Health",
  "hormone panel":        "Health",
  "vitamin":              "Health",
  "vitamins":             "Health",
  "urinalysis":           "Health",
  "endocrine":            "Health",
  "immunology":           "Health",
  "hematology":           "Health",
  "chemistry":            "Health",
  // Fitness (movement, exercise, performance)
  fitness:      "Fitness",
  exercise:     "Fitness",
  workout:      "Fitness",
  sport:        "Fitness",
  running:      "Fitness",
  cardio:       "Fitness",
  strength:     "Fitness",
  steps:        "Fitness",
  activity:     "Fitness",
  weight:       "Fitness",
  // Finance
  finance:      "Finance",
  budget:       "Finance",
  savings:      "Finance",
  investment:   "Finance",
  // Habits & Routines
  habit:        "Habits & Routines",
  routine:      "Habits & Routines",
  daily:        "Habits & Routines",
  // Productivity
  productivity: "Productivity",
  work:         "Productivity",
  education:    "Productivity",
  // Medication
  medication:   "Medication",
  prescription: "Medication",
  supplement:   "Medication",
  drug:         "Medication",
  // Mental & Wellness
  meditation:   "Mental & Wellness",
  mindfulness:  "Mental & Wellness",
  anxiety:      "Mental & Wellness",
  stress:       "Mental & Wellness",
  journal:      "Mental & Wellness",
  // Lifestyle
  lifestyle:    "Lifestyle",
  pet:          "Lifestyle",
  plant:        "Lifestyle",
  social:       "Lifestyle",
  screen:       "Lifestyle",
  reading:      "Lifestyle",
  // Gaming/entertainment exact-match (added 2026-05-21 — see PR for Gaming
  // tracker mis-bucketing bug).
  gaming:       "Lifestyle",
  game:         "Lifestyle",
  entertainment:"Lifestyle",
  leisure:      "Lifestyle",
  hobby:        "Lifestyle",
  // Other
  custom:       "Other",
  general:      "Other",
};

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

function getCanonicalGroup(category: string): string {
  const c = (category || "").toLowerCase().trim();
  if (!c) return "Other";
  // Exact match first
  const exact = CANONICAL_GROUP_MAP[c];
  if (exact) return exact;
  // Keyword fallback — categories like "Metabolic Panel - Fasting" or
  // "Vitals (morning)" should still land in Health.
  const healthKw = ["panel", "blood", "lab", "vital", "metabolic", "cbc", "bmp", "cmp", "glucose", "cholesterol", "hormone", "thyroid", "vitamin", "medical", "clinical", "health", "diet", "nutrition", "sleep", "hydration"];
  if (healthKw.some(k => c.includes(k))) return "Health";
  const fitnessKw = ["workout", "exercise", "run", "cardio", "strength", "sport", "steps", "gym", "yoga", "hike"];
  if (fitnessKw.some(k => c.includes(k))) return "Fitness";
  const financeKw = ["finance", "money", "budget", "saving", "invest", "spend", "income"];
  if (financeKw.some(k => c.includes(k))) return "Finance";
  const medKw = ["med", "prescription", "supplement", "drug", "dose"];
  if (medKw.some(k => c.includes(k))) return "Medication";
  const mentalKw = ["mood", "anxiety", "stress", "meditation", "journal", "therapy"];
  if (mentalKw.some(k => c.includes(k))) return "Mental & Wellness";
  const habitKw = ["habit", "routine", "daily"];
  if (habitKw.some(k => c.includes(k))) return "Habits & Routines";
  // Lifestyle keyword fallback — gaming/leisure/entertainment trackers
  // were silently bucketed into "Other" before this branch was added
  // (reported 2026-05-21: AI logged a Gaming tracker the user couldn’t find).
  const lifestyleKw = ["gaming","game","console","playstation","xbox","nintendo","steam","leisure","entertainment","hobby","screen","reading","book","social","tv","movie","streaming","netflix","pet ","plant"];
  if (lifestyleKw.some(k => c.includes(k))) return "Lifestyle";
  return "Other";
}

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
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">Connected Categories</span>
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
                  className="relative rounded-lg bg-card/60 border border-border/40 p-2 text-left hover:bg-muted/40 active:scale-[0.98] transition-all overflow-hidden"
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
  if (cat === "medication" || cat === "prescription" || cat === "supplement") return "medication";
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
  const drugName = getFieldDefault('drugName') || tracker.name;
  const dosage = getFieldDefault('dosage') || tracker.unit || '';
  const frequency = getFieldDefault('frequency') || '';
  const refillDate = getFieldDefault('refillDate') || '';
  const prescriber = getFieldDefault('prescriber') || '';

  // Log dose mutation
  const logDoseMut = useMutation({
    mutationFn: () => apiRequest('POST', `/api/trackers/${tracker.id}/entries`, {
      values: { drugName, dosage, timeTaken: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), adherence: 'taken', frequency },
      notes: `Dose taken at ${new Date().toLocaleTimeString()}`
    }),
    onSuccess: () => {
      // BUG-T05/UI01: refetchType:"all" so the count badge updates even when
      // the page-level trackers query is technically inactive at the moment.
      qc.invalidateQueries({ queryKey: ['/api/trackers'], refetchType: "all" });
      qc.invalidateQueries({ queryKey: ['/api/stats'], refetchType: "all" });
      qc.invalidateQueries({ queryKey: ['/api/dashboard-enhanced'], refetchType: "all" });
      toast({ title: `${drugName} logged`, description: `${dosage} taken at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` });
    },
    onError: () => toast({ title: 'Failed to log dose', variant: 'destructive' }),
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
            {dosage && <p className="text-sm text-muted-foreground mt-1">Dosage: <span className="font-medium text-foreground">{dosage}</span></p>}
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
          {logDoseMut.isPending ? 'Logging...' : `Log ${dosage} ${drugName} Now`}
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
                  <span>{e.values?.dosage || dosage}</span>
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

  const mutation = useMutation<any,Error,void>({
    mutationFn: async () => {
      const coerced: Record<string, any> = {};
      for (const f of tracker.fields) {
        const raw = values[f.name];
        if (f.type === "number") {
          coerced[f.name] = raw !== undefined && raw !== "" ? parseFloat(raw) : undefined;
        } else if (f.type === "boolean") {
          coerced[f.name] = raw === true || raw === "true";
        } else {
          coerced[f.name] = raw ?? "";
        }
      }
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
        notes: notes.trim() || undefined,
      });
      return res.json();
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData<any[]>({ queryKey: ["/api/trackers"] });
      const coerced: Record<string, any> = {};
      for (const f of tracker.fields) {
        const raw = values[f.name];
        if (f.type === "number") coerced[f.name] = raw !== undefined && raw !== "" ? parseFloat(raw) : undefined;
        else if (f.type === "boolean") coerced[f.name] = raw === true || raw === "true";
        else coerced[f.name] = raw ?? "";
      }
      const tempEntry = { id: 'temp-' + Date.now(), values: coerced, notes: notes.trim() || undefined, timestamp: new Date().toISOString(), computed: {} };
      queryClient.setQueriesData<any[]>({ queryKey: ["/api/trackers"] }, (old) =>
        (old || []).map((t: any) => t.id === tracker.id
          ? { ...t, entries: [...(t.entries || []), tempEntry] }
          : t
        )
      );
      return { prev };
    },
    onSuccess: () => {
      setValues({});
      setNotes("");
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
      // newest entry was already on the server.
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"], refetchType: "all" });
    },
  });

  const handleClose = () => {
    setValues({});
    setNotes("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent data-testid={`dialog-add-entry-${tracker.id}`}>
        <DialogHeader>
          <DialogTitle>Log Entry: {tracker.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {tracker.fields.map((f) => (
            <div key={f.name}>
              <Label className="text-xs font-medium text-muted-foreground capitalize">
                {f.name}
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
                  placeholder={`Enter ${f.name}`}
                  className="mt-1"
                  data-testid={`input-entry-${f.name}`}
                />
              )}
              {f.type === "text" && (
                <Input
                  type="text"
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                  placeholder={`Enter ${f.name}`}
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
                    {f.name}
                  </label>
                </div>
              )}
              {f.type === "select" && f.options && (
                <Select
                  value={values[f.name] ?? ""}
                  onValueChange={(v) => setValues((p) => ({ ...p, [f.name]: v }))}
                >
                  <SelectTrigger className="mt-1" data-testid={`select-entry-${f.name}`}>
                    <SelectValue placeholder={`Select ${f.name}`} />
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
            onClick={() => mutation.mutate()}
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
}: {
  trackerId: string;
  entryId: string;
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
      toast({ title: "Entry deleted" });
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) queryClient.setQueryData(key, data); }
      toast({ title: "Failed to delete entry", description: formatApiError(err), variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
      >
        <Trash2 className="h-3 w-3" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent data-testid={`alert-delete-entry-${entryId}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The entry will be permanently removed.
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

function TrackerCard({ tracker, onDelete, onOpenDetail }: { tracker: Tracker; onDelete: (id: string) => void; onOpenDetail?: (id: string) => void }) {
  const { data: allProfiles } = useQuery<Profile[]>({ queryKey: ["/api/profiles"], queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()) });
  const linkedNames = (tracker.linkedProfiles || []).map(pid => (allProfiles || []).find(p => p.id === pid)?.name).filter(Boolean);
  const profileLabel = linkedNames.length > 0 ? linkedNames[0] : '';

  const entries = tracker.entries || [];
  const lastEntry = entries[entries.length - 1];
  const primaryField = tracker.fields.find(f => f.isPrimary)?.name || tracker.fields.find(f => f.type === 'number')?.name || tracker.fields[0]?.name || 'value';
  const spec = detectSpecialization(tracker);
  const catAccent = getCategoryAccent(tracker.category);
  const ac = `hsl(${catAccent})`;
  const isBP = spec === 'bloodpressure';

  const recentVals = entries.slice(-14).map(e => {
    if (isBP) return (e.values['systolic'] ?? e.values['systolic_pressure']) as number;
    return e.values[primaryField] as number;
  }).filter((v): v is number => typeof v === 'number');

  const timeAgo = lastEntry ? timeAgoShort(lastEntry.timestamp) : null;
  const status = getTrackerStatus(tracker, spec, lastEntry, primaryField);

  const specIcon = spec === 'medication' ? <Pill className="h-3.5 w-3.5" />
    : spec === 'bloodpressure' ? <Heart className="h-3.5 w-3.5" />
    : spec === 'sleep' ? <Moon className="h-3.5 w-3.5" />
    : spec === 'running' ? <Zap className="h-3.5 w-3.5" />
    : spec === 'weight' ? <Activity className="h-3.5 w-3.5" />
    : tracker.category?.toLowerCase() === 'nutrition' ? <Flame className="h-3.5 w-3.5" />
    : tracker.category?.toLowerCase() === 'fitness' ? <Dumbbell className="h-3.5 w-3.5" />
    : <Activity className="h-3.5 w-3.5" />;

  // ── Compute big metric value + unit (uniform across categories) ──
  let bigValue: string = '—';
  let bigUnit: string = '';

  if (isBP) {
    const sys = lastEntry?.values['systolic'] ?? lastEntry?.values['systolic_pressure'];
    const dia = lastEntry?.values['diastolic'] ?? lastEntry?.values['diastolic_pressure'];
    bigValue = `${sys ?? '—'}/${dia ?? '—'}`;
    bigUnit = 'mmHg';
  } else {
    const v = lastEntry?.values[primaryField];
    if (typeof v === 'number') {
      // Format: 1 decimal for small numbers, none for large
      bigValue = v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v % 1 === 0 ? 0 : 1);
    } else if (v != null) {
      bigValue = String(v).slice(0, 12);
    }
    const f = tracker.fields.find(ff => ff.name === primaryField);
    bigUnit = f?.unit || tracker.unit || '';
  }

  return (
    <div
      data-testid={`card-tracker-${tracker.id}`}
      className="rounded-2xl overflow-hidden cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] flex flex-col relative"
      style={{
        height: 180,
        background: `linear-gradient(160deg, hsl(${catAccent} / 0.14) 0%, hsl(var(--card)) 45%)`,
        border: `1px solid hsl(${catAccent} / 0.2)`,
        boxShadow: `0 2px 16px hsl(${catAccent} / 0.07), inset 0 1px 0 hsl(${catAccent} / 0.1)`,
      }}
      onClick={() => onOpenDetail?.(tracker.id)}
    >
      {/* Header: icon + title */}
      <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${catAccent} / 0.2)`, color: ac }}>
          {specIcon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground truncate leading-tight">
            {profileLabel ? `${profileLabel}: ` : ''}{tracker.name}
          </p>
        </div>
      </div>

      {/* Big metric */}
      <div className="px-3 pt-1 pb-0">
        <div className="flex items-baseline gap-1">
          <span className="text-[28px] leading-none font-black tabular-nums text-foreground" style={{ color: ac }}>
            {bigValue}
          </span>
          {bigUnit && <span className="text-[11px] font-medium text-muted-foreground">{bigUnit}</span>}
        </div>
      </div>

      {/* Dominant sparkline filling remaining space */}
      <div className="flex-1 px-2 pt-1 min-h-0 flex items-end">
        {recentVals.length >= 2 ? (
          <Sparkline values={recentVals} color={ac} h={56} />
        ) : entries.length > 0 ? (
          <div className="w-full opacity-50"><Sparkline values={[1, 1]} color={ac} h={56} /></div>
        ) : (
          <div className="w-full text-center text-[10px] text-muted-foreground/60 italic pb-2">No data yet</div>
        )}
      </div>

      {/* Footer: status pill (left) + time-ago (right) */}
      <div className="px-3 pb-2.5 pt-1 flex items-center justify-between">
        {status ? (
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{ backgroundColor: status.bg, color: status.fg }}
          >
            {status.label}
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

function EntryRow({
  entry,
  tracker,
  primaryField,
}: {
  entry: TrackerEntry;
  tracker: Tracker;
  primaryField: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editVals, setEditVals] = useState<Record<string, any>>({});

  const editMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/trackers/${tracker.id}/entries/${entry.id}`, { values: editVals }),
    // Optimistic: patch the entry inside cached trackers immediately so the
    // edit feels instant. Roll back if the server rejects.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/trackers"] });
      const prev = queryClient.getQueriesData({ queryKey: ["/api/trackers"] });
      queryClient.setQueriesData({ queryKey: ["/api/trackers"] }, (old: any) => {
        if (!Array.isArray(old)) return old;
        return old.map((t: any) => {
          if (t.id !== tracker.id) return t;
          if (!Array.isArray(t.entries)) return t;
          return { ...t, entries: t.entries.map((e: any) => e.id === entry.id ? { ...e, values: { ...e.values, ...editVals } } : e) };
        });
      });
      return { prev };
    },
    onSuccess: () => {
      setEditing(false);
      toast({ title: "Entry updated" });
    },
    onError: (err: Error, _vars, context: any) => {
      if (context?.prev) {
        for (const [key, value] of context.prev) queryClient.setQueryData(key, value);
      }
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
  });

  const startEdit = () => {
    setEditVals({ ...entry.values });
    setEditing(true);
  };

  const primaryVal = entry.values[primaryField];
  const otherFields = tracker.fields.filter((f) => f.name !== primaryField);
  // BP detection for display
  const bpS = entry.values["systolic"] ?? entry.values["systolic_pressure"] ?? entry.values["sbp"];
  const bpD = entry.values["diastolic"] ?? entry.values["diastolic_pressure"] ?? entry.values["dbp"];
  const isEntryBP = typeof bpS === "number" && typeof bpD === "number";
  const entryNotes = (entry.values["_notes"] as string | undefined) || entry.notes;

  if (editing) {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-md border border-primary/30 px-2.5 py-1.5 text-xs bg-primary/5"
        data-testid={`entry-row-edit-${entry.id}`}
      >
        <div className="flex flex-wrap gap-1.5">
          {tracker.fields.filter(f => f.name !== "_notes").map(f => (
            <div key={f.name} className="flex items-center gap-1">
              <label className="text-muted-foreground text-xs">{f.name}:</label>
              {f.type === "boolean" ? (
                <Checkbox
                  checked={!!editVals[f.name]}
                  onCheckedChange={(v) => setEditVals(prev => ({ ...prev, [f.name]: !!v }))}
                />
              ) : (
                <Input
                  className="h-6 w-20 text-xs px-1"
                  type={f.type === "number" ? "number" : "text"}
                  value={editVals[f.name] ?? ""}
                  onChange={e => setEditVals(prev => ({ ...prev, [f.name]: f.type === "number" ? (e.target.value === "" ? "" : parseFloat(e.target.value)) : e.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 justify-end">
          <Button size="sm" variant="ghost" className="h-5 px-2 text-xs" onClick={() => setEditing(false)}>Cancel</Button>
          <Button size="sm" className="h-5 px-2 text-xs" onClick={() => editMutation.mutate()} disabled={editMutation.isPending}>
            <Check className="h-3 w-3 mr-1" />Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs bg-muted/30"
      data-testid={`entry-row-${entry.id}`}
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
                {f.name}: {String(v)}{f.unit ? ` ${f.unit}` : ""}
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
      <div className="flex items-center gap-0.5">
        <button onClick={startEdit} className="p-0.5 rounded hover:bg-muted transition-colors" title="Edit entry">
          <Pencil className="h-3 w-3 text-muted-foreground hover:text-foreground" />
        </button>
        <DeleteEntryButton trackerId={tracker.id} entryId={entry.id} />
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

  const mutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) { toast({ title: "Name required", description: "Enter a tracker name", variant: "destructive" }); throw new Error("Name required"); }
      const INVALID_NAMES = ["tracker", "log", "new tracker", "custom tracker", "my tracker", "track"];
      if (INVALID_NAMES.includes(name.trim().toLowerCase())) {
        toast({ title: "Be more specific", description: "Give this tracker a descriptive name like 'Blood Pressure' or 'Morning Run'", variant: "destructive" });
        throw new Error("Generic name");
      }
      let builtFields = fields
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
        builtFields = [{ name: "value", type: "number", unit: unit.trim() || undefined, isPrimary: true, options: undefined }];
      }

      const res = await apiRequest("POST", "/api/trackers", {
        name: name.trim(),
        category,
        unit: unit.trim() || undefined,
        fields: builtFields,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      setName("");
      setCategory("custom");
      setUnit("");
      setFields([{ name: "value", type: "number", unit: "", options: "" }]);
      onOpenChange(false);
      toast({ title: "Tracker created" });
    },
    onError: (err: Error) => {
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
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="dialog-create-tracker">
        <DialogHeader>
          <DialogTitle>Create New Tracker</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
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
            onClick={() => mutation.mutate()}
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
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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

function computeHealthScore(trackers: Tracker[]): number | null {
  const healthTrackers = trackers.filter((t) => getCanonicalGroup(t.category) === "Health" || getCanonicalGroup(t.category) === "Fitness");
  if (healthTrackers.length === 0) return null;

  let score = 0;
  let factors = 0;

  for (const t of healthTrackers) {
    if (t.entries.length === 0) continue;
    const last = t.entries[t.entries.length - 1];

    // BMI score
    if (last.computed?.bmi) {
      const bmi = last.computed.bmi;
      const bmiScore = bmi >= 18.5 && bmi <= 25 ? 100
        : bmi > 25 && bmi <= 30 ? 70
        : bmi > 30 ? 40
        : 50; // underweight
      score += bmiScore;
      factors++;
    }

    // Sleep quality
    if (last.computed?.sleepQuality) {
      const q = last.computed.sleepQuality;
      const qScore = q === "excellent" ? 100 : q === "good" ? 80 : q === "fair" ? 55 : 30;
      score += qScore;
      factors++;
    }

    // Blood pressure
    if (last.computed?.bloodPressureCategory) {
      const c = last.computed.bloodPressureCategory;
      const bpScore = c === "normal" ? 100 : c === "elevated" ? 70 : c === "high_stage1" ? 45 : c === "high_stage2" ? 25 : 10;
      score += bpScore;
      factors++;
    }

    // Activity (any entry in last 3 days = bonus)
    const threeDaysAgo = Date.now() - 3 * 86400000;
    const recentEntry = t.entries.some((e) => new Date(e.timestamp).getTime() > threeDaysAgo);
    if (recentEntry) {
      score += 75;
      factors++;
    }
  }

  return factors > 0 ? Math.round(score / factors) : null;
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
function OverviewTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const [timeRange, setTimeRange] = useState<TimeRange>("30d");
  const specialization = detectSpecialization(tracker);
  const filtered = filterEntriesByRange(tracker.entries, timeRange);
  // Force Recharts to remount when data changes (ResponsiveContainer caching issue)
  const chartKey = `${tracker.id}-${tracker.entries.length}-${timeRange}`;
  const stats = computeFieldStats(filtered, primaryField);
  const streak = computeStreak(tracker.entries);

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
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {stats && (
          <>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Latest</p>
              <p className="text-lg font-bold tabular-nums">{typeof stats.latest === "number" ? stats.latest.toFixed(1) : stats.latest}</p>
              <p className="text-xs text-muted-foreground">{tracker.unit || ""}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Average</p>
              <p className="text-lg font-bold tabular-nums">{stats.avg.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">{timeRange === "all" ? "all time" : timeRange}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Trend</p>
              <div className="flex items-center justify-center gap-1">
                {stats.trendPct > 1 ? <ArrowUpRight className="w-4 h-4 text-orange-500" /> :
                 stats.trendPct < -1 ? <ArrowDownRight className="w-4 h-4 text-green-500" /> :
                 <MinusIcon className="w-4 h-4 text-muted-foreground" />}
                <span className="text-lg font-bold tabular-nums">{Math.abs(stats.trendPct).toFixed(1)}%</span>
              </div>
              <p className="text-xs text-muted-foreground">{stats.trendPct > 1 ? "up" : stats.trendPct < -1 ? "down" : "stable"}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Streak</p>
              <p className="text-lg font-bold tabular-nums">{streak}</p>
              <p className="text-xs text-muted-foreground">{streak === 1 ? "day" : "days"}</p>
            </div>
          </>
        )}
      </div>

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
          {specialization === "standard" && <StandardDetailChart entries={filtered} primaryField={primaryField} unit={tracker.unit} />}
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
            {numericFields.map(f => <SelectItem key={f.name} value={f.name}>{f.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">vs</span>
        <Select value={fieldB} onValueChange={setFieldB}>
          <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {numericFields.map(f => <SelectItem key={f.name} value={f.name}>{f.name}</SelectItem>)}
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
          const val = entry.values[primaryField];
          const allVals = Object.entries(entry.values).filter(([k, v]) => v != null && v !== "" && k !== "_notes" && k !== "item");
          const notes = entry.values["_notes"] as string | undefined;
          const itemName = entry.values["item"] as string | undefined;
          const bpS = entry.values["systolic"] ?? entry.values["systolic_pressure"];
          const bpD = entry.values["diastolic"] ?? entry.values["diastolic_pressure"];
          const isBPEntry = typeof bpS === "number" && typeof bpD === "number";
          const isNutrition = tracker.category === "nutrition" || tracker.name.toLowerCase().includes("nutrition") || tracker.name.toLowerCase().includes("calorie");
          const displayVal = isBPEntry ? `${bpS}/${bpD} mmHg`
            : isNutrition && itemName ? `${itemName} — ${val ?? "?"} ${tracker.unit || "cal"}`
            : val != null ? `${val} ${tracker.unit || ""}`
            : allVals.length > 0 ? allVals.map(([k, v]) => `${k}: ${v}`).join(", ")
            : "(empty)";
          const nextEntry = filtered[idx + 1];
          const nextVal = nextEntry?.values[primaryField];
          const delta = typeof val === "number" && typeof nextVal === "number" ? val - nextVal : null;

          return (
            <div key={entry.id} className="group flex items-center justify-between py-2 px-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors text-sm gap-2" data-testid={`entry-row-${entry.id}`}>
              <div className="flex items-center gap-2 min-w-0 flex-wrap flex-1">
                <span className="font-mono font-semibold tabular-nums text-sm">{displayVal}</span>
                {delta != null && delta !== 0 && (
                  <span className={`text-xs font-medium tabular-nums ${delta < 0 ? "text-green-600" : "text-orange-500"}`}>
                    {delta > 0 ? "+" : ""}{delta.toFixed(1)}
                  </span>
                )}
                {!isBPEntry && allVals.filter(([k]) => k !== primaryField).length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {allVals.filter(([k]) => k !== primaryField).map(([k, v]) => `${k}: ${v}`).join(", ")}
                  </span>
                )}
                {(notes || entry.notes) && (
                  <span className="text-xs text-muted-foreground italic truncate max-w-[140px]">"{notes || entry.notes}"</span>
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
                <DeleteEntryButton trackerId={tracker.id} entryId={entry.id} />
              </div>
            </div>
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
  const { data: allGoals = [] } = useQuery<any[]>({
    queryKey: ["/api/goals"],
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
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      const name = formTitle;
      setCreating(false); resetForm();
      toast({ title: `"${name}" goal created`, description: formTarget ? `Target: ${formTarget} ${formUnit}` : undefined });
    },
    onError: (e: Error) => toast({ title: "Failed to create goal", description: formatApiError(e), variant: "destructive" }),
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, title, ...data }: any) => apiRequest("PATCH", `/api/goals/${id}`, { title, ...data }).then(r => r.json()),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setEditGoal(null); resetForm();
      toast({ title: `"${variables.title || "Goal"}" updated` });
    },
    onError: (e: Error) => toast({ title: "Failed to update goal", description: formatApiError(e), variant: "destructive" }),
  });
  const deleteMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title?: string }) => apiRequest("DELETE", `/api/goals/${id}`),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["/api/goals"] });
      const prev = queryClient.getQueryData<any[]>(["/api/goals"]);
      queryClient.setQueryData<any[]>(["/api/goals"], (old) => old?.filter((g: any) => g.id !== variables.id));
      return { prev };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setEditGoal(null);
      toast({ title: `"${variables.title || "Goal"}" deleted` });
    },
    onError: (e: Error, _v: any, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/goals"], ctx.prev);
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
              <div key={g.id} className="rounded-lg border p-3 space-y-2 cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => openEdit(g)} data-testid={`tracker-goal-${g.id}`}>
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
      qc.invalidateQueries({ queryKey: ["/api/trackers"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
      qc.invalidateQueries({ queryKey: ["/api/trackers"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
      <AddEntryDialog
        tracker={tracker}
        open={addEntryOpen}
        onOpenChange={(v) => {
          setAddEntryOpen(v);
          if (!v) {
            queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
            queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
            queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
          }
        }}
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
  const { data: trackers, isLoading } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/trackers${trackerProfileParam}`).then(r => r.json()),
  });
  // Delay skeleton — if data loads from cache in <200ms the skeleton never flashes
  const [showTrackerSkeleton, setShowTrackerSkeleton] = useState(false);
  useEffect(() => {
    if (!isLoading) { setShowTrackerSkeleton(false); return; }
    const tid = setTimeout(() => setShowTrackerSkeleton(true), 200);
    return () => clearTimeout(tid);
  }, [isLoading]);

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

  // Build O(1) lookups: for any given party (profile id), which asset/liability
  // ids does it (co-)own? Used by the visibility predicates below.
  const assetsByOwner = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of assetPartyLinks || []) {
      const pid = l.partyProfileId; const aid = l.assetProfileId;
      if (!pid || !aid) continue;
      if (!m.has(pid)) m.set(pid, new Set());
      m.get(pid)!.add(aid);
    }
    return m;
  }, [assetPartyLinks]);
  const liabilitiesByOwner = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of liabilityProfileLinks || []) {
      const pid = l.partyProfileId; const lid = l.liabilityProfileId;
      if (!pid || !lid) continue;
      if (!m.has(pid)) m.set(pid, new Set());
      m.get(pid)!.add(lid);
    }
    return m;
  }, [liabilityProfileLinks]);

  // Visibility helper: an asset is visible to the selected filter set if it's
  // (a) directly selected, (b) parented to a selected profile, or (c) the
  // selected profile appears as a co-owner via asset_party_links. Same logic
  // for liabilities. Returns true when filterMode is "everyone".
  const isAssetVisible = (assetId: string, parentId: string | null | undefined): boolean => {
    if (filterMode === "everyone") return true;
    if (filterIds.length === 0) return true;
    if (filterIds.includes(assetId)) return true;
    if (parentId && filterIds.includes(parentId)) return true;
    for (const fid of filterIds) {
      const owned = assetsByOwner.get(fid);
      if (owned && owned.has(assetId)) return true;
    }
    return false;
  };
  const isLiabilityVisible = (liabId: string, parentId: string | null | undefined): boolean => {
    if (filterMode === "everyone") return true;
    if (filterIds.length === 0) return true;
    if (filterIds.includes(liabId)) return true;
    if (parentId && filterIds.includes(parentId)) return true;
    for (const fid of filterIds) {
      const owned = liabilitiesByOwner.get(fid);
      if (owned && owned.has(liabId)) return true;
    }
    return false;
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
  // Resolve selectedTracker from the live query cache so it refreshes after mutations
  const selectedTracker = selectedTrackerId ? (trackers || []).find(t => t.id === selectedTrackerId) || null : null;
  const [viewMode, setViewMode] = useState<"table" | "cards">("cards");
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
          queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
          queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
    onError: (err: Error, _v: any, ctx: any) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/documents"], ctx.prev);
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
    },
  });

  // Profile-filtered documents (before type filter, so type pills don't disappear)
  const profileFilteredDocs = useMemo(() => allDocuments.filter(d => {
    if (filterMode === "selected" && filterIds.length > 0) {
      const linkedIds = d.linkedProfiles || [];
      return linkedIds.some(id => filterIds.includes(id));
    }
    return true;
  }), [allDocuments, filterMode, filterIds]);

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
      const pParent = p.fields?._parentProfileId || (p as any).parentProfileId;
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
  }, [profiles, filterMode, filterIds, assetsByOwner]);

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
      const pParent = (p.fields as any)?._parentProfileId || (p as any).parentProfileId;
      return isLiabilityVisible(p.id, pParent);
    });
    const counts: Record<string, number> = {};
    for (const s of liabs) {
      const c = liabilitySubcategoryOf(s);
      counts[c] = (counts[c] || 0) + 1;
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [profiles, filterMode, filterIds, liabilitiesByOwner]);

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
      const linkedIds = t.linkedProfiles || [];
      if (!linkedIds.some(id => filterIds.includes(id))) return false;
    }
    // The tracker-category chip filter only applies when the user is actually
    // on the Trackers tab. If they’re viewing "All" or some other section, a
    // stale category selection from a previous visit would silently hide
    // trackers without showing the chip row — which is exactly the
    // “why isn’t my data showing?” bug. Scope it to the active section.
    if (sectionFilter === "trackers" && trackerCatFilter !== "all" && normalizeFilter(getCanonicalGroup(t.category)) !== normalizeFilter(trackerCatFilter)) return false;
    return true;
  }).sort((a, b) => cleanTrackerName(a.name).toLowerCase().localeCompare(cleanTrackerName(b.name).toLowerCase())
  ), [trackers, filterMode, filterIds, trackerCatFilter, sectionFilter]);

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

  // Skeleton loading state — MUST be after all hooks
  if (showTrackerSkeleton && !trackers) {
    return (
      <div className="p-3 md:p-5 space-y-3">
        <div className="h-7 w-32 rounded skeleton-shimmer" />
        <div className="flex gap-2 overflow-x-hidden">
          {[...Array(4)].map((_, i) => <div key={i} className="h-7 w-20 rounded-full skeleton-shimmer shrink-0" />)}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {[...Array(8)].map((_, i) => <div key={i} className="h-16 rounded-lg skeleton-shimmer" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 py-2 md:p-4 space-y-2 overflow-y-auto h-full pb-24" data-testid="page-trackers">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href="/dashboard" className="inline-flex items-center justify-center rounded-md w-7 h-7 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back">
            <ArrowLeft className="w-3.5 h-3.5" />
          </Link>

          <span className="text-xs text-muted-foreground">
            {sectionFilter === "trackers" ? `${filteredTrackers.length} trackers`
             : sectionFilter === "documents" ? `${filteredDocuments.length} documents`
             : sectionFilter === "all" ? `${filteredTrackers.length + filteredDocuments.length} items`
             : sectionFilter === "liabilities" ? "liabilities"
             : sectionFilter === "profiles" ? "assets"
             : `${filteredTrackers.length} trackers`}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex items-center border rounded-md p-0.5">
            <button onClick={() => setViewMode("table")} className={`p-1 rounded ${viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} data-testid="view-table">
              <Table2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode("cards")} className={`p-1 rounded ${viewMode === "cards" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`} data-testid="view-cards">
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

      {/* ── Filter Bar ── */}
      <div className="space-y-2" data-testid="filter-bar">
        {/* Profile filter (page level) + Section pills */}
        <div className="flex items-center gap-2 overflow-x-auto flex-nowrap scrollbar-hide pb-1" style={{ WebkitOverflowScrolling: 'touch' }}>
          {/* Profile filter */}
          <MultiProfileFilter
            onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
            compact
          />
          <div className="h-4 w-px bg-border" />
          {/* Section filter pills */}
          {(() => {
            // Compute filtered asset/subscription counts using the SAME filter logic as the sections
            const childTypeSet = new Set(["vehicle", "asset", "investment", "property"]);
            const isShowAllForCounts = filterMode === "everyone";
            // BUG-A02: the chip count must use IDENTICAL filtering to the rendered
            // asset list — otherwise the user sees e.g. "Assets (3)" in the chip but
            // 5 cards below (or vice versa) depending on the nesting filter selected
            // on the Assets tab. Mirror the list's filter logic exactly, including
            // the assetNestingFilter modes.
            const labelForTypeCount = (t: string) => t === "vehicle" ? "Vehicles" : t === "property" ? "Properties" : t === "investment" ? "Investments" : t === "asset" ? "Assets" : t;
            const filteredAssetCount = (profiles || []).filter(p => {
              if (!childTypeSet.has(p.type)) return false;
              const pParent = p.fields?._parentProfileId || p.parentProfileId;
              const parentProfile = pParent ? (profiles || []).find(x => x.id === pParent) : null;
              const parentIsAsset = !!parentProfile && childTypeSet.has(parentProfile.type);
              // Profile-filter scope — include co-owners via asset_party_links.
              const inScope = isShowAllForCounts || isAssetVisible(p.id, pParent as string | null | undefined);
              if (!inScope) return false;
              // Asset type chip filter — only applies on the Assets tab
              if (sectionFilter === "profiles" && assetTypeFilter !== "all" && labelForTypeCount(p.type) !== assetTypeFilter) return false;
              // Nesting filter — must match the list view exactly
              const nestingFilter = sectionFilter === "profiles" ? assetNestingFilter : "all";
              if (nestingFilter === "all" || nestingFilter === "topLevel") {
                if (parentIsAsset) return false;
              } else if (nestingFilter === "hasChildren") {
                const hasAssetChild = (profiles || []).some(x => x.id !== p.id && childTypeSet.has(x.type) && (x.fields?._parentProfileId || x.parentProfileId) === p.id);
                if (!hasAssetChild) return false;
              } else if (nestingFilter === "nested") {
                if (!parentIsAsset) return false;
              }
              return true;
            }).length;
            // Liabilities count — includes "liability" (canonical), legacy "loan",
            // AND "subscription" (recurring bills are liabilities too — Netflix,
            // rent, utilities all behave like recurring debts you owe).
            const filteredLiabilityCount = (profiles || []).filter(p => {
              if (!isLiabilityLikeProfile(p)) return false;
              if (isShowAllForCounts) return true;
              const pParent = (p.fields as any)?._parentProfileId || p.parentProfileId;
              return isLiabilityVisible(p.id, pParent);
            }).length;
            return (["all", "trackers", "documents", "profiles", "liabilities"] as const).map(s => {
            const labels: Record<string, string> = { all: "All", trackers: "Trackers", documents: "Documents", profiles: "Assets", liabilities: "Liabilities" };
            const counts: Record<string, number> = {
              all: filteredTrackers.length + filteredDocuments.length + filteredLiabilityCount + filteredAssetCount,
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
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 pr-4" data-testid="category-filter-chips-trackers">
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
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 pr-4" data-testid="category-filter-chips-documents">
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
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 pr-4" data-testid="category-filter-chips-assets">
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
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 pr-4" data-testid="category-filter-chips-liabilities">
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
        type Row = { id: string; kind: "asset" | "liability" | "document" | "tracker"; name: string; subtitle: string; meta: string; href: string; ownerIds: string[]; };
        const rows: Row[] = [];
        const childTypeSet = new Set(["vehicle", "asset", "investment", "property"]);
        const isShowAll = filterMode === "everyone";
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
            const parentId = cur.fields?._parentProfileId || cur.parentProfileId;
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
        // Assets
        if (sectionFilter === "all" || sectionFilter === "profiles") {
          (profiles || []).forEach(p => {
            if (!childTypeSet.has(p.type)) return;
            const pParent = p.fields?._parentProfileId || p.parentProfileId;
            // Include co-owners via asset_party_links (Home shows for Jane).
            if (!isShowAll && !isAssetVisible(p.id, pParent)) return;
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
            const pParent = (p.fields as any)?._parentProfileId || p.parentProfileId;
            // Include co-owners via liability_profile_links.
            if (!isShowAll && !isLiabilityVisible(p.id, pParent)) return;
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
            const linked: string[] = ((d as any).linkedProfiles || []) as string[];
            const ownerIds = linked.filter(id => personById.has(id));
            // If no person is linked, attribute to self so the user sees
            // it under their own section rather than "Unassigned".
            const finalOwners = ownerIds.length > 0 ? ownerIds : (selfProfileId ? [selfProfileId] : []);
            if (!isShowAll) {
              const inScope = linked.some(id => filterIds.includes(id));
              if (!inScope) return;
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
            const pf = t.fields.find(fld => fld.isPrimary)?.name || t.fields[0]?.name || "value";
            const v = last?.values?.[pf];
            const meta = v != null ? `${typeof v === 'number' ? Number(v).toFixed(1) : String(v)}${t.unit ? ' ' + t.unit : ''}` : "—";
            const linked: string[] = (t.linkedProfiles || []) as string[];
            const ownerIds = linked.filter(id => personById.has(id));
            const finalOwners = ownerIds.length > 0 ? ownerIds : (selfProfileId ? [selfProfileId] : []);
            rows.push({ id: t.id, kind: "tracker", name: t.name, subtitle: sub, meta, href: `/trackers/${t.id}`, ownerIds: finalOwners });
          });
        }
        if (rows.length === 0) {
          return (
            <div className="rounded-lg border bg-card p-8 text-center" data-testid="linked-list-empty">
              <p className="text-sm text-muted-foreground">Nothing to list here yet</p>
            </div>
          );
        }
        const kindIcons: Record<Row["kind"], any> = { asset: Star, liability: TrendingDown, document: FileText, tracker: Activity };
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
        return (
          <div className="space-y-3" data-testid="linked-list-view">
            {sortedGroups.map(group => (
              <div key={group.ownerId} className="rounded-lg border border-border/40 overflow-hidden bg-card" data-testid={`linked-list-group-${group.ownerId}`}>
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
                {/* Column headers (within group, smaller so they don't dominate) */}
                <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 px-3 py-1 border-b border-border/40 bg-muted/20 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                  <span className="w-5" />
                  <span>Name</span>
                  <span className="text-right">Type</span>
                  <span className="text-right min-w-[80px]">Value</span>
                </div>
                {group.rows.map(r => {
                  const Icon = kindIcons[r.kind];
                  // Icon color = person hue (so the icon column tells you
                  // "whose item" before you read anything). Type badge keeps
                  // its own kind-based hue so you can still scan asset vs
                  // liability vs tracker at a glance.
                  const ac = group.accent;
                  return (
                    <Link key={`${r.kind}-${r.id}`} href={r.href}>
                      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 px-3 py-2 border-b border-border/30 last:border-b-0 cursor-pointer hover:bg-muted/40 transition-colors" data-testid={`linked-list-row-${r.kind}-${r.id}`}>
                        <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: `hsl(${ac} / 0.18)`, color: `hsl(${ac})` }}>
                          <Icon className="h-3 w-3" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{r.name}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{r.subtitle}</p>
                        </div>
                        <span className="text-[9px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: `hsl(${ac} / 0.14)`, color: `hsl(${ac})` }}>{r.kind}</span>
                        <span className="text-sm font-bold tabular-nums text-foreground text-right min-w-[80px]">{r.meta}</span>
                      </div>
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
        const childProfiles = (profiles || []).filter(p => {
          if (!childTypeSet.has(p.type)) return false;
          if (isShowAll || (p.fields?._parentProfileId || p.parentProfileId) && filterIds.includes((p.fields?._parentProfileId || p.parentProfileId) as string)) {
            // Asset type chip filter — only applies on the Assets tab.
            // "all" means no chip-level filter; everything passes.
            if (sectionFilter === "profiles" && assetTypeFilter !== "all" && labelForType(p.type) !== assetTypeFilter) return false;
            // Asset nesting filter — applies on BOTH the "All" tab and the "Assets" tab.
            // Bug fix: previously this check was gated on sectionFilter === "profiles",
            // so nested assets (e.g. Samsung refrigerator under Home) leaked into the
            // "All" view's asset row even though the rule says they should only live
            // inside their parent's detail page. Apply it universally — only the
            // explicit "Nested" / "Has children" chips on the Assets tab override it.
            const pParentId = p.fields?._parentProfileId || p.parentProfileId;
            const parentProfile = pParentId ? (profiles || []).find(x => x.id === pParentId) : null;
            const parentIsAsset = !!parentProfile && childTypeSet.has(parentProfile.type);
            const nestingFilter = sectionFilter === "profiles" ? assetNestingFilter : "all";
            if (nestingFilter === "all" || nestingFilter === "topLevel") {
              // Hide assets whose parent is itself an asset-type profile.
              // Children of a person/self/pet still appear (they're top-level relative to assets).
              if (parentIsAsset) return false;
            } else if (nestingFilter === "hasChildren") {
              // Pass if at least one other profile has this profile as parent AND is an asset type
              const hasAssetChild = (profiles || []).some(x => x.id !== p.id && childTypeSet.has(x.type) && (x.fields?._parentProfileId || x.parentProfileId) === p.id);
              if (!hasAssetChild) return false;
            } else if (nestingFilter === "nested") {
              // Pass only if parent is itself an asset-type profile
              if (!parentIsAsset) return false;
            }
            return true;
          }
          return false;
        });
        if (childProfiles.length === 0) return (
          <div className="rounded-lg border bg-card p-6 text-center">
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
            <button onClick={() => toggleSection("profiles")} className="flex items-center gap-3 w-full px-1 py-1 rounded-xl" style={{ background: 'linear-gradient(135deg, hsl(262 60% 62% / 0.06) 0%, transparent 50%)' }} data-testid="section-toggle-profiles">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'hsl(262 60% 62% / 0.15)' }}>
                <Car className="h-4 w-4" style={{ color: 'hsl(262 60% 62%)' }} />
              </div>
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold" style={{ color: 'hsl(262 60% 62%)' }}>Assets & Vehicles</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'hsl(262 60% 62% / 0.15)', color: 'hsl(262 60% 62%)' }}>{childProfiles.length}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">Vehicles, property, investments and more</p>
              </div>
              {collapsedSections.has("profiles") ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" /> : <ChevronUp className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
            </button>
            {!collapsedSections.has("profiles") && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 items-start" style={{ gridAutoRows: 160 }}>
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
                    <Link key={child.id} href={`/profiles/${child.id}`} className="block" style={{ height: 160 }}>
                      <div
                        className="rounded-xl overflow-hidden cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] grid"
                        style={{
                          height: 160,
                          minHeight: 160,
                          maxHeight: 160,
                          boxSizing: 'border-box',
                          background: `linear-gradient(160deg, hsl(${accentHsl} / 0.14) 0%, hsl(var(--card)) 45%)`,
                          border: `1px solid hsl(${accentHsl} / 0.2)`,
                          boxShadow: `0 2px 16px hsl(${accentHsl} / 0.07)`,
                          gridTemplateRows: 'auto 1fr auto',
                        }}
                        data-testid={`button-view-child-${child.id}`}
                      >
                        {/* Header: icon + name */}
                        <div className="px-2.5 pt-2 pb-1 flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${accentHsl} / 0.2)`, color: ac }}>
                            <Icon className="h-3.5 w-3.5" />
                          </div>
                          <p className="text-[11px] font-bold text-foreground truncate">{child.name}</p>
                        </div>

                        {/* Body: value + 2 fixed meta slots (empty slots reserve space so heights align) */}
                        <div className="px-2.5 flex flex-col justify-start gap-1">
                          <div className="h-7 flex items-baseline gap-1">
                            {displayValue != null ? (
                              <>
                                <span className="text-xl font-black tabular-nums text-foreground leading-none">${displayValue.toLocaleString()}</span>
                                {valueLabel && <span className="text-[8px] text-muted-foreground">{valueLabel}</span>}
                              </>
                            ) : (
                              <span className="text-[11px] text-muted-foreground/60 italic">Tap to add value</span>
                            )}
                          </div>
                          <div className="h-4">
                            {metaLines[0] ? <KpiLine label={metaLines[0].label} value={metaLines[0].value} /> : <span className="block h-full" aria-hidden="true" />}
                          </div>
                          <div className="h-4">
                            {metaLines[1] ? <KpiLine label={metaLines[1].label} value={metaLines[1].value} /> : <span className="block h-full" aria-hidden="true" />}
                          </div>
                        </div>

                        {/* Footer: type chip pinned bottom-left, year pinned bottom-right */}
                        <div className="px-2.5 pb-2 pt-1 flex items-center justify-between">
                          <span className="text-[8px] font-semibold capitalize px-1.5 py-0.5 rounded" style={{ backgroundColor: `hsl(${accentHsl} / 0.12)`, color: ac }}>{child.type}</span>
                          {year ? <span className="text-[8px] text-muted-foreground">{year}</span> : <span aria-hidden="true" />}
                        </div>
                      </div>
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
        const liabs = (profiles || []).filter(p => {
          if (!isLiabilityLikeProfile(p)) return false;
          // Profile-level scope first — liability is in scope if it's directly
          // selected, parented to a selected profile, or the user is on "everyone".
          let inScope = isShowAll;
          if (!inScope) {
            if (filterIds.includes(p.id)) inScope = true;
            const pParent = (p.fields as any)?._parentProfileId || p.parentProfileId;
            if (pParent && filterIds.includes(pParent)) inScope = true;
          }
          if (!inScope) return false;
          // Type chip filter — only applies on the Liabilities tab.
          if (sectionFilter === "liabilities" && subCatFilter !== "all") {
            if (liabilitySubcategoryOf(p) !== subCatFilter) return false;
          }
          return true;
        });
        if (liabs.length === 0) return (
          <div className="rounded-lg border bg-card p-6 text-center">
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
            <button onClick={() => toggleSection("liabilities")} className="flex items-center gap-3 w-full px-1 py-1 rounded-xl" style={{ background: `linear-gradient(135deg, hsl(${accentHsl} / 0.06) 0%, transparent 50%)` }} data-testid="section-toggle-liabilities">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: `hsl(${accentHsl} / 0.15)` }}>
                <TrendingDown className="h-4 w-4" style={{ color: ac }} />
              </div>
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold" style={{ color: ac }}>Liabilities</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: `hsl(${accentHsl} / 0.15)`, color: ac }}>{liabs.length}</span>
                  {totalBalance > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">${Math.round(totalBalance).toLocaleString()} total</span>}
                  {totalMonthly > 0 && <span className="text-[10px] text-muted-foreground tabular-nums">· ${Math.round(totalMonthly).toLocaleString()}/mo</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">Mortgages, loans, credit cards, subscriptions, and recurring bills</p>
              </div>
              {collapsedSections.has("liabilities") ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" /> : <ChevronUp className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
            </button>
            {!collapsedSections.has("liabilities") && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {liabs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(liab => {
                  const fields: any = liab.fields || {};
                  const fin = fields.finance || {};
                  const isSubscription = liab.type === "subscription";
                  const balance = toNumLiab(fields.currentBalance ?? fields.remainingBalance ?? fields.loanBalance ?? fields.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance);
                  // For subscriptions, surface the recurring cost in the
                  // "Monthly" KPI line so the card still tells you what it
                  // costs you each month.
                  const subFreq = String(fields.frequency || "monthly").toLowerCase();
                  const subCost = toNumLiab(fields.cost ?? fields.amount);
                  const subMonthly = isSubscription && subCost != null
                    ? (subFreq.startsWith("y") ? subCost / 12 : subFreq.startsWith("w") ? subCost * 52 / 12 : subFreq.startsWith("q") ? subCost / 3 : subFreq.startsWith("b") ? subCost * 26 / 12 : subCost)
                    : null;
                  const monthly = isSubscription ? subMonthly : toNumLiab(fields.monthlyPayment ?? fin.monthlyPayment);
                  const apr = toNumLiab(fields.annualInterestRate ?? fields.apr ?? fin.annualInterestRate);
                  const lender = fields.lender || fin.lender || fields.provider || '';
                  const subtype = liabilitySubcategoryOf(liab);
                  const original = toNumLiab(fields.originalBalance ?? fin.originalBalance);
                  const paidPct = (original && balance != null && original > 0) ? Math.max(0, Math.min(1, 1 - (balance / original))) : 0;
                  return (
                    // BUG-LT05: navigation goes through wouter's <Link> only.
                    // Earlier QA reported the global profile filter flipping
                    // from "Everyone" → the liability owner on card click — we
                    // could not reproduce a listener that does this in the
                    // current code, but the symptom is consistent with stale
                    // localStorage filter state lingering after navigation.
                    // The route-aware filter reset in BUG-LT03 now clears any
                    // such carryover on each route change.
                    <Link key={liab.id} href={`/profiles/${liab.id}`} className="block">
                      <div
                        className="rounded-xl overflow-hidden cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] flex flex-col"
                        style={{ height: 160, background: `linear-gradient(160deg, hsl(${accentHsl} / 0.14) 0%, hsl(var(--card)) 45%)`, border: `1px solid hsl(${accentHsl} / 0.2)`, boxShadow: `0 2px 16px hsl(${accentHsl} / 0.07)` }}
                        data-testid={`liab-card-${liab.id}`}
                      >
                        <div className="px-2.5 pt-2 pb-1 flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${accentHsl} / 0.2)`, color: ac }}><TrendingDown className="h-3.5 w-3.5" /></div>
                          <p className="text-[10px] font-bold text-foreground truncate" title={liab.name}>{liab.name}</p>
                        </div>
                        <div className="px-2.5 pb-1 flex-1 flex flex-col gap-0.5">
                          {balance != null && balance > 0 ? (
                            <div className="flex items-center justify-between">
                              <div className="flex items-baseline gap-0.5">
                                <span className="text-xl font-black tabular-nums text-foreground">${Math.round(balance).toLocaleString()}</span>
                                <span className="text-[9px] text-muted-foreground">bal</span>
                              </div>
                              {original && original > 0 && <Donut pct={paidPct} color={ac} size={32} label={`${Math.round(paidPct * 100)}%`} />}
                            </div>
                          ) : isSubscription && subCost != null && subCost > 0 ? (
                            // Subscriptions don't have a payoff balance — show
                            // the recurring price as the headline number.
                            <div className="flex items-baseline gap-0.5">
                              <span className="text-xl font-black tabular-nums text-foreground">${Math.round(subCost).toLocaleString()}</span>
                              <span className="text-[9px] text-muted-foreground">/{subFreq.startsWith('y') ? 'yr' : subFreq.startsWith('w') ? 'wk' : subFreq.startsWith('q') ? 'qtr' : 'mo'}</span>
                            </div>
                          ) : <span className="text-[10px] text-muted-foreground/50 italic">No balance set</span>}
                          {/* For subscriptions we already showed the cost as
                              the headline, so don't repeat it on a Monthly
                              line unless the freq isn't already monthly. */}
                          {monthly != null && monthly > 0 && !(isSubscription && subFreq.startsWith('m')) && <KpiLine label="Monthly" value={`$${Math.round(monthly).toLocaleString()}/mo`} />}
                          {apr != null && apr > 0 && <KpiLine label="APR" value={`${apr < 1 ? (apr * 100).toFixed(2) : apr.toFixed(2)}%`} />}
                          {lender && <KpiLine label="Lender" value={String(lender).slice(0, 18)} />}
                        </div>
                        <div className="px-2.5 pb-2 pt-0.5 flex items-center justify-between">
                          <span className="text-[7px] font-semibold px-1.5 py-0.5 rounded capitalize" style={{ backgroundColor: `hsl(${accentHsl} / 0.12)`, color: ac }}>{subtype}</span>
                          {original && original > 0 && balance != null && <span className="text-[7px] text-muted-foreground tabular-nums">of ${Math.round(original).toLocaleString()}</span>}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Documents Section */}
      {viewMode === "cards" && (sectionFilter === "all" || sectionFilter === "documents") && <div className="space-y-2">
        <div className="flex items-center justify-between">
          <button onClick={() => toggleSection("documents")} className="flex items-center gap-3 w-full px-1 py-1 rounded-xl" style={{ background: 'linear-gradient(135deg, hsl(25 80% 54% / 0.06) 0%, transparent 50%)' }} data-testid="section-toggle-documents">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'hsl(25 80% 54% / 0.15)' }}>
                <FileText className="h-4 w-4" style={{ color: 'hsl(25 80% 54%)' }} />
              </div>
              <div className="flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold" style={{ color: 'hsl(25 80% 54%)' }}>Documents</span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'hsl(25 80% 54% / 0.15)', color: 'hsl(25 80% 54%)' }}>{filteredDocuments.length}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">IDs, insurance, contracts, and more</p>
              </div>
              {collapsedSections.has("documents") ? <ChevronDown className="h-4 w-4 text-muted-foreground/60 shrink-0" /> : <ChevronUp className="h-4 w-4 text-muted-foreground/60 shrink-0" />}
            </button>
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
              accept="image/*,application/pdf,.doc,.docx,.txt"
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
        {!collapsedSections.has("documents") && (
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
        {!collapsedSections.has("documents") && (filteredDocuments.length === 0 ? (
          <div className="rounded-lg border bg-card p-6 text-center">
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
                      <h4 className="text-xs font-semibold uppercase tracking-wider mt-3 mb-1.5 flex items-center gap-1.5" style={{ color: `hsl(${accentHslForType})` }}>
                        <span>{DOC_TYPE_EMOJI[docType] || '📄'}</span> {docType.replace(/_/g, ' ')} <span className="text-muted-foreground font-normal">({docs.length})</span>
                      </h4>
                    )}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                      {docs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(doc => {
                        const accentHsl = DOC_TYPE_HSL[doc.type] || '25 80% 54%';
                        const ac = `hsl(${accentHsl})`;
                        const linkedNames = (doc.linkedProfiles || []).map((pid: string) => (profiles || []).find(p => p.id === pid)?.name).filter(Boolean);
                        const createdDate = new Date(doc.createdAt);
                        const daysSince = Math.floor((Date.now() - createdDate.getTime()) / 86400000);
                        const mimeShort = doc.mimeType?.includes('pdf') ? 'PDF' : doc.mimeType?.includes('image') ? 'Image' : doc.mimeType?.includes('word') || doc.mimeType?.includes('doc') ? 'Word' : 'File';
                        return (
                          <div key={doc.id} className="rounded-xl overflow-hidden cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] flex flex-col" style={{ height: 160, background: `linear-gradient(160deg, hsl(${accentHsl} / 0.14) 0%, hsl(var(--card)) 45%)`, border: `1px solid hsl(${accentHsl} / 0.2)`, boxShadow: `0 2px 16px hsl(${accentHsl} / 0.07)` }} data-testid={`global-doc-${doc.id}`} onClick={() => setViewingDoc(doc)}>
                            <div className="px-2.5 pt-2 pb-1 flex items-center gap-1.5">
                              <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: `hsl(${accentHsl} / 0.2)`, color: ac }}><FileText className="h-3.5 w-3.5" /></div>
                              <p className="text-[10px] font-bold text-foreground truncate">{doc.name}</p>
                            </div>
                            <div className="px-2.5 pb-1 flex-1 flex flex-col gap-0.5">
                              <span className="text-base font-black text-foreground capitalize">{doc.type?.replace(/_/g, ' ') || 'Document'}</span>
                              <KpiLine label="Format" value={mimeShort} />
                              <KpiLine label="Added" value={createdDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} />
                              {linkedNames.length > 0 && <KpiLine label="Owner" value={linkedNames.join(', ')} />}
                              {daysSince <= 7 && <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-500 font-bold self-start mt-0.5">New</span>}
                            </div>
                            <div className="px-2.5 pb-2 pt-0.5 flex items-center justify-between">
                              <span className="text-[7px] font-semibold capitalize px-1.5 py-0.5 rounded" style={{ backgroundColor: `hsl(${accentHsl} / 0.12)`, color: ac }}>{doc.type?.replace(/_/g, ' ') || 'doc'}</span>
                              <div className="flex gap-1">
                                <button onClick={stopProp(() => handleShareDoc(doc))} className="text-muted-foreground/60 hover:text-foreground"><Share2 className="h-3 w-3" /></button>
                                <button onClick={stopProp(() => setDocDeleteConfirmId(doc.id))} className="text-muted-foreground/60 hover:text-destructive"><X className="h-3 w-3" /></button>
                              </div>
                            </div>
                          </div>
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
                // Group trackers by canonical category within each person
                const trackersByCategory: Record<string, typeof g.trackers> = {};
                for (const t of g.trackers) {
                  const cat = getCanonicalGroup(t.category);
                  (trackersByCategory[cat] = trackersByCategory[cat] || []).push(t);
                }
                // Sort category groups by CANONICAL_GROUPS.order
                const sortedCatKeys = Object.keys(trackersByCategory).sort((a, b) => {
                  const oa = CANONICAL_GROUPS[a]?.order ?? 99;
                  const ob = CANONICAL_GROUPS[b]?.order ?? 99;
                  return oa - ob || a.localeCompare(b);
                });
                return (
                  <div key={pk}>
                    <div className="flex items-center gap-2 mb-2 px-0.5">
                      <span className="text-sm">{icon}</span>
                      <span className="text-xs font-bold text-foreground">{g.type === 'self' ? 'Me' : g.name}</span>
                      <span className="text-[10px] text-muted-foreground">({g.trackers.length})</span>
                    </div>
                    {sortedCatKeys.map(catName => {
                      const catTrackers = trackersByCategory[catName];
                      const gDef = CANONICAL_GROUPS[catName];
                      const gAccent = gDef?.accent || "240 20% 60%";
                      return (
                        <div key={catName} className="mb-2.5">
                          <h4 className="text-xs font-semibold uppercase tracking-wider mt-3 mb-1.5 flex items-center gap-1.5" style={{ color: `hsl(${gAccent})` }}>
                            <span>{categoryGroupEmoji(catName)}</span> {catName} <span className="text-muted-foreground font-normal">({catTrackers.length})</span>
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                            {catTrackers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(tracker => (
                              <TrackerCard key={tracker.id} tracker={tracker} onDelete={(id) => setDeleteTargetId(id)} onOpenDetail={(id) => setSelectedTrackerId(id)} />
                            ))}
                          </div>
                        </div>
                      );
                    })}
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
