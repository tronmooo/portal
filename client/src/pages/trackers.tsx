import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getProfileFilter } from "@/lib/profileFilter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
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
} from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { Link } from "wouter";
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

const CHART_COLORS = {
  primary: "#20808D",
  secondary: "#A84B2F",
  tertiary: "#1B474D",
  light: "#BCE2E7",
  warning: "#944454",
  gold: "#FFC553",
};

// ── Time Range Filter ──────────────────────────────────────────────────────────

type TimeRange = "7d" | "30d" | "90d" | "all";

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
        <span key={b.label} className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium capitalize ${b.color}`}>
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
            <div className="text-[10px] text-muted-foreground">{s.label}</div>
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
          <div className="text-[10px] text-muted-foreground">{s.label}</div>
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

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
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

  return (
    <div className="space-y-3">
      {/* Weight line chart */}
      <div>
        <p className="text-[10px] text-muted-foreground font-medium mb-1 uppercase tracking-wide">Weight Trend</p>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} width={40} tickFormatter={(v) => `${v}${unit ? ` ${unit}` : ""}`} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="weight" stroke={CHART_COLORS.primary} strokeWidth={2} dot={{ r: 3, fill: CHART_COLORS.primary }} activeDot={{ r: 5 }} connectNulls name={`Weight${unit ? ` (${unit})` : ""}`} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* BMI trend with normal range shading */}
      {chartData.some((d) => d.bmi !== null) && (
        <div>
          <p className="text-[10px] text-muted-foreground font-medium mb-1 uppercase tracking-wide">BMI Trend</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
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
          <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
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
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
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
      <div className="flex gap-3 mt-2 text-[10px] text-muted-foreground">
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
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
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
      <div className="flex gap-3 mt-2 text-[10px] text-muted-foreground">
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
          <p className="text-[10px] text-muted-foreground font-medium mb-1 uppercase tracking-wide">Pace Trend (lower = faster)</p>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
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
          <p className="text-[10px] text-muted-foreground font-medium mb-1 uppercase tracking-wide">Cumulative Distance (mi)</p>
          <ResponsiveContainer width="100%" height={130}>
            <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
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
          <p className="text-[10px] text-muted-foreground font-medium mb-1 uppercase tracking-wide">Calories Burned</p>
          <ResponsiveContainer width="100%" height={120}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
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

type TrackerSpecialization = "weight" | "bloodpressure" | "sleep" | "running" | "standard";

function detectSpecialization(tracker: Tracker): TrackerSpecialization {
  const name = tracker.name.toLowerCase();
  const cat = tracker.category.toLowerCase();
  if (cat === "health" && name.includes("weight")) return "weight";
  if (name.includes("blood") || name.includes("pressure")) return "bloodpressure";
  if (cat === "sleep") return "sleep";
  if (cat === "fitness" && name.includes("run")) return "running";
  return "standard";
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
            className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors ${
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
        <span className="text-[10px] text-muted-foreground ml-2">
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

  const mutation = useMutation({
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setValues({});
      setNotes("");
      onOpenChange(false);
      toast({ title: "Entry logged", description: `Added entry to ${tracker.name}` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to log entry", description: err.message, variant: "destructive" });
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
          <p className="text-[10px] text-muted-foreground">
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

  const mutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/trackers/${trackerId}/entries/${entryId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Entry deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete entry", description: err.message, variant: "destructive" });
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

function TrackerCard({
  tracker,
  onDelete,
  onOpenDetail,
}: {
  tracker: Tracker;
  onDelete: (id: string) => void;
  onOpenDetail?: (id: string) => void;
}) {
  // Read cached profiles (already fetched by TrackersPage)
  const { data: allProfiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const linkedProfileNames = (tracker.linkedProfiles || []).map(pid =>
    (allProfiles || []).find(p => p.id === pid)
  ).filter(Boolean) as Profile[];

  const [addEntryOpen, setAddEntryOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);

  const lastEntry = tracker.entries[tracker.entries.length - 1];
  const prevEntry = tracker.entries.length > 1 ? tracker.entries[tracker.entries.length - 2] : null;

  const primaryField = tracker.fields.find((f) => f.isPrimary)?.name || tracker.fields[0]?.name || "value";
  const specialization = detectSpecialization(tracker);
  const isBP = specialization === "bloodpressure";
  const lastVal = isBP && lastEntry
    ? `${lastEntry.values["systolic"] ?? lastEntry.values["systolic_pressure"] ?? lastEntry.values["sbp"] ?? "-"}/${lastEntry.values["diastolic"] ?? lastEntry.values["diastolic_pressure"] ?? lastEntry.values["dbp"] ?? "-"}`
    : lastEntry?.values[primaryField];
  const prevVal = prevEntry?.values[primaryField];
  const trend = !isBP && typeof lastEntry?.values[primaryField] === "number" && typeof prevVal === "number" ? (lastEntry.values[primaryField] as number) - (prevVal as number) : null;

  const sparklineData = tracker.entries.slice(-10).map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value: typeof e.values[primaryField] === "number" ? e.values[primaryField] : 0,
  }));

  // Entries sorted newest first for the expanded list
  const sortedEntries = [...tracker.entries].reverse();

  const specIcon = specialization === "weight" ? <Activity className="h-3 w-3" />
    : specialization === "bloodpressure" ? <Heart className="h-3 w-3" />
    : specialization === "sleep" ? <Moon className="h-3 w-3" />
    : specialization === "running" ? <Zap className="h-3 w-3" />
    : null;

  return (
    <Card data-testid={`card-tracker-${tracker.id}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle
              className="text-sm font-semibold flex items-center gap-1.5 cursor-pointer hover:text-primary transition-colors"
              onClick={() => onOpenDetail?.(tracker.id)}
              data-testid={`tracker-name-link-${tracker.id}`}
            >
              {specIcon && <span className="text-muted-foreground">{specIcon}</span>}
              {tracker.name}
            </CardTitle>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {(() => {
                const last = tracker.entries[tracker.entries.length - 1];
                const pf = tracker.fields?.[0]?.name || Object.keys(last?.values || {})[0] || "value";
                const lastVal = last?.values?.[pf];
                if (lastVal != null) {
                  return <span className="text-xs font-semibold tabular-nums">{typeof lastVal === 'number' ? lastVal.toFixed(1) : lastVal}{tracker.unit ? ` ${tracker.unit}` : ''}</span>;
                }
                return null;
              })()}
              <span className="text-[10px] text-muted-foreground">· {tracker.entries.length} {tracker.entries.length === 1 ? 'entry' : 'entries'}</span>
              {linkedProfileNames.map(p => {
                const PIcon = PROFILE_TYPE_ICONS[p.type] || User;
                return (
                  <span key={p.id} className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-md" data-testid={`badge-profile-${p.id}`}>
                    {p.avatar ? (
                      <img src={p.avatar} alt={p.name} className="h-2.5 w-2.5 rounded-full object-cover" />
                    ) : (
                      <PIcon className="h-2.5 w-2.5" />
                    )}
                    {p.name}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {tracker.entries.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() => setDetailExpanded((v) => !v)}
                title={detailExpanded ? "Collapse chart" : "Expand chart"}
                data-testid={`button-detail-expand-${tracker.id}`}
              >
                {detailExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setAddEntryOpen(true)}
              data-testid={`button-log-${tracker.id}`}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  data-testid={`button-menu-${tracker.id}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDelete(tracker.id)}
                  data-testid={`menuitem-delete-tracker-${tracker.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Delete Tracker
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {lastEntry ? (
          <div>
            <div className="flex items-baseline gap-2">
              <span
                className="text-2xl font-semibold tabular-nums"
                data-testid={`text-tracker-value-${tracker.id}`}
              >
                {lastVal ?? "—"}
              </span>
              {tracker.unit && <span className="text-xs text-muted-foreground">{tracker.unit}</span>}
              {trend !== null && (
                <span
                  className={`flex items-center gap-0.5 text-xs font-medium ${
                    trend >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"
                  }`}
                >
                  {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  {trend > 0 ? "+" : ""}
                  {typeof trend === "number" ? trend.toFixed(1) : trend}
                </span>
              )}
            </div>

            <ComputedBadges computed={lastEntry.computed} />

            {/* Compact sparkline (default, shown when detail NOT expanded) */}
            {!detailExpanded && sparklineData.length > 1 && (
              <div className="mt-3 h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparklineData}>
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke={CHART_COLORS.primary}
                      strokeWidth={1.5}
                      dot={false}
                    />
                    <XAxis dataKey="date" hide />
                    <YAxis hide domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Full expanded detail view */}
            {detailExpanded && (
              <ExpandedDetailView tracker={tracker} primaryField={primaryField} />
            )}

            <p className="text-[10px] text-muted-foreground mt-2">
              Last:{" "}
              {new Date(lastEntry.timestamp).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>

            {/* Expand/collapse entries */}
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 text-xs w-full flex items-center gap-1 text-muted-foreground"
              onClick={() => setExpanded((v) => !v)}
              data-testid={`button-expand-${tracker.id}`}
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-3 w-3" /> Hide entries
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" /> View all entries
                </>
              )}
            </Button>

            {expanded && (
              <div
                className="mt-2 space-y-1 max-h-56 overflow-y-auto"
                data-testid={`entries-list-${tracker.id}`}
              >
                {sortedEntries.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    tracker={tracker}
                    primaryField={primaryField}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-center">
            <Hash className="h-8 w-8 text-muted-foreground/40 mx-auto mb-1" />
            <p className="text-xs text-muted-foreground">No entries yet</p>
          </div>
        )}
      </CardContent>

      <AddEntryDialog
        tracker={tracker}
        open={addEntryOpen}
        onOpenChange={setAddEntryOpen}
      />
    </Card>
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
  const primaryVal = entry.values[primaryField];
  const otherFields = tracker.fields.filter((f) => f.name !== primaryField);
  // BP detection for display
  const bpS = entry.values["systolic"] ?? entry.values["systolic_pressure"] ?? entry.values["sbp"];
  const bpD = entry.values["diastolic"] ?? entry.values["diastolic_pressure"] ?? entry.values["dbp"];
  const isEntryBP = typeof bpS === "number" && typeof bpD === "number";
  const entryNotes = (entry.values["_notes"] as string | undefined) || entry.notes;

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
            <span className="text-muted-foreground text-[10px]">mmHg</span>
          ) : tracker.unit ? (
            <span className="text-muted-foreground text-[10px]">{tracker.unit}</span>
          ) : null}
          {!isEntryBP && otherFields.map((f) => {
            const v = entry.values[f.name];
            if (v === undefined || v === "" || f.name === "_notes") return null;
            return (
              <span key={f.name} className="text-muted-foreground text-[10px]">
                {f.name}: {String(v)}{f.unit ? ` ${f.unit}` : ""}
              </span>
            );
          })}
        </div>
        {entryNotes && (
          <p className="text-muted-foreground mt-0.5 truncate">{entryNotes}</p>
        )}
        <ComputedBadges computed={entry.computed} />
        <span className="text-muted-foreground text-[10px]">
          {new Date(entry.timestamp).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <DeleteEntryButton trackerId={tracker.id} entryId={entry.id} />
    </div>
  );
}

// ── CreateTrackerDialog ────────────────────────────────────────────────────────

const CATEGORIES = ["health", "fitness", "nutrition", "finance", "sleep", "habit", "custom"] as const;
const FIELD_TYPES = ["number", "text", "boolean", "select", "duration"] as const;

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
      setName("");
      setCategory("custom");
      setUnit("");
      setFields([{ name: "value", type: "number", unit: "", options: "" }]);
      onOpenChange(false);
      toast({ title: "Tracker created" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create tracker", description: err.message, variant: "destructive" });
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
                    <p className="text-[10px] text-muted-foreground">Primary field (used for chart & main value)</p>
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      onOpenChange(false);
      toast({ title: "Tracker deleted", description: `${trackerName} has been removed` });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete tracker", description: err.message, variant: "destructive" });
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
  const healthTrackers = trackers.filter((t) => t.category === "health" || t.category === "sleep" || t.category === "fitness");
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

function TrackerSummary({ trackers }: { trackers: Tracker[] }) {
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
      return count > best.count ? { name: t.name, count } : best;
    },
    { name: "", count: 0 }
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
        <span className="text-[9px] text-muted-foreground">This Week</span>
      </div>
      <div className="flex flex-col items-center p-1.5 rounded-md border border-border/30" data-testid="summary-most-active">
        <span className="text-[10px] font-bold truncate w-full text-center" style={{ color: CHART_COLORS.tertiary }}>{mostActive.count > 0 ? mostActive.name : "—"}</span>
        <span className="text-[9px] text-muted-foreground">{mostActive.count > 0 ? `${mostActive.count} entries` : "Most Active"}</span>
      </div>
      <div className="flex flex-col items-center p-1.5 rounded-md border border-border/30" data-testid="summary-best-streak">
        <span className="text-sm font-bold tabular-nums" style={{ color: CHART_COLORS.gold }}>{bestStreak.streak > 0 ? `${bestStreak.streak}d` : "—"}</span>
        <span className="text-[9px] text-muted-foreground truncate w-full text-center">{bestStreak.name || "Streak"}</span>
      </div>
      <div className="flex flex-col items-center p-1.5 rounded-md border border-border/30" data-testid="summary-health-score">
        <span className={`text-sm font-bold tabular-nums ${healthScoreColor}`}>{healthScore !== null ? healthScore : "—"}</span>
        <span className="text-[9px] text-muted-foreground">{healthScore !== null ? (healthScore >= 80 ? "Excellent" : healthScore >= 60 ? "Good" : "Low") : "Health"}</span>
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
  const stats = computeFieldStats(filtered, primaryField);
  const streak = computeStreak(tracker.entries);

  const timeRangeBtns: { label: string; value: TimeRange }[] = [
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d" },
    { label: "90d", value: "90d" },
    { label: "All", value: "all" },
  ];

  return (
    <div className="space-y-4">
      {/* KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {stats && (
          <>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Latest</p>
              <p className="text-lg font-bold tabular-nums">{typeof stats.latest === "number" ? stats.latest.toFixed(1) : stats.latest}</p>
              <p className="text-[10px] text-muted-foreground">{tracker.unit || ""}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Average</p>
              <p className="text-lg font-bold tabular-nums">{stats.avg.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">{timeRange === "all" ? "all time" : timeRange}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Trend</p>
              <div className="flex items-center justify-center gap-1">
                {stats.trendPct > 1 ? <ArrowUpRight className="w-4 h-4 text-orange-500" /> :
                 stats.trendPct < -1 ? <ArrowDownRight className="w-4 h-4 text-green-500" /> :
                 <MinusIcon className="w-4 h-4 text-muted-foreground" />}
                <span className="text-lg font-bold tabular-nums">{Math.abs(stats.trendPct).toFixed(1)}%</span>
              </div>
              <p className="text-[10px] text-muted-foreground">{stats.trendPct > 1 ? "up" : stats.trendPct < -1 ? "down" : "stable"}</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Streak</p>
              <p className="text-lg font-bold tabular-nums">{streak}</p>
              <p className="text-[10px] text-muted-foreground">{streak === 1 ? "day" : "days"}</p>
            </div>
          </>
        )}
      </div>

      {/* Time range selector */}
      <div className="flex items-center gap-1">
        {timeRangeBtns.map(btn => (
          <button key={btn.value}
            className={`px-2.5 py-0.5 rounded text-[11px] font-medium transition-colors ${timeRange === btn.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            onClick={() => setTimeRange(btn.value)}>
            {btn.label}
          </button>
        ))}
        <span className="text-[10px] text-muted-foreground ml-2">{filtered.length} entries</span>
      </div>

      {/* Chart */}
      {filtered.length > 0 && (
        <div className="h-[200px]">
          {specialization === "weight" && <WeightDetailChart entries={filtered} primaryField={primaryField} unit={tracker.unit} />}
          {specialization === "bloodpressure" && <BloodPressureDetailChart entries={filtered} />}
          {specialization === "sleep" && <SleepDetailChart entries={filtered} primaryField={primaryField} />}
          {specialization === "running" && <RunningDetailChart entries={filtered} primaryField={primaryField} />}
          {specialization === "standard" && <StandardDetailChart entries={filtered} primaryField={primaryField} unit={tracker.unit} />}
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
            <p className="text-[10px] text-muted-foreground uppercase">This Week Avg</p>
            <p className="text-lg font-bold tabular-nums">{thisWeekAvg.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{tracker.unit || ""}</span></p>
            <p className="text-[10px] text-muted-foreground">{thisWeek.length} entries</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3">
            <p className="text-[10px] text-muted-foreground uppercase">Last Week Avg</p>
            <p className="text-lg font-bold tabular-nums">{lastWeekAvg.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{tracker.unit || ""}</span></p>
            <p className="text-[10px] text-muted-foreground">{lastWeek.length} entries</p>
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
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
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
            <p className="text-[10px] text-muted-foreground uppercase">Avg Protein</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.protein / entries.length).toFixed(0) : 0}g</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase">Avg Carbs</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.carbs / entries.length).toFixed(0) : 0}g</p>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-[10px] text-muted-foreground uppercase">Avg Fat</p>
            <p className="text-base font-bold tabular-nums">{entries.length > 0 ? (macroTotals.fat / entries.length).toFixed(0) : 0}g</p>
          </div>
        </div>
        {macroTotals.sugar > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase">Total Sugar</p>
              <p className="text-base font-bold tabular-nums">{macroTotals.sugar.toFixed(0)}g</p>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase">Total Fiber</p>
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
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
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
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
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
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
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
              <p className="text-[10px] text-muted-foreground uppercase">{s.field}</p>
              <p className="text-base font-bold tabular-nums">{s.avg?.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">min: {s.min?.toFixed(1)} / max: {s.max?.toFixed(1)}</p>
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
function HistoryTabContent({ tracker, primaryField }: { tracker: Tracker; primaryField: string }) {
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState<"all" | "7d" | "30d" | "90d">("all");
  const sortedEntries = [...tracker.entries].reverse();

  const now = Date.now();
  const dateFilterMs: Record<string, number> = { "7d": 7*86400000, "30d": 30*86400000, "90d": 90*86400000 };
  const dateFiltered = dateFilter === "all" ? sortedEntries :
    sortedEntries.filter(e => now - new Date(e.timestamp).getTime() <= (dateFilterMs[dateFilter] || Infinity));
  const searchLower = search.toLowerCase();
  const filtered = searchLower
    ? dateFiltered.filter(e => {
        const vals = Object.values(e.values).map(v => String(v ?? "").toLowerCase()).join(" ");
        const dateStr = new Date(e.timestamp).toLocaleDateString();
        const notes = (e.values["_notes"] as string || e.notes || "").toLowerCase();
        return vals.includes(searchLower) || dateStr.includes(searchLower) || notes.includes(searchLower);
      })
    : dateFiltered;

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">({filtered.length})</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {(["all", "7d", "30d", "90d"] as const).map(range => (
            <button key={range}
              onClick={() => setDateFilter(range)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${dateFilter === range ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
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
          const allVals = Object.entries(entry.values).filter(([k, v]) => v != null && v !== "" && k !== "_notes");
          const notes = entry.values["_notes"] as string | undefined;
          const bpS = entry.values["systolic"] ?? entry.values["systolic_pressure"];
          const bpD = entry.values["diastolic"] ?? entry.values["diastolic_pressure"];
          const isBPEntry = typeof bpS === "number" && typeof bpD === "number";
          const displayVal = isBPEntry ? `${bpS}/${bpD} mmHg`
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
                  <span className={`text-[10px] font-medium tabular-nums ${delta < 0 ? "text-green-600" : "text-orange-500"}`}>
                    {delta > 0 ? "+" : ""}{delta.toFixed(1)}
                  </span>
                )}
                {!isBPEntry && allVals.filter(([k]) => k !== primaryField).length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {allVals.filter(([k]) => k !== primaryField).map(([k, v]) => `${k}: ${v}`).join(", ")}
                  </span>
                )}
                {(notes || entry.notes) && (
                  <span className="text-[10px] text-muted-foreground italic truncate max-w-[140px]">"{notes || entry.notes}"</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="text-right">
                  <span className="text-[10px] text-muted-foreground tabular-nums block">
                    {new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                  <span className="text-[9px] text-muted-foreground/70 tabular-nums block">
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
      setCreating(false); resetForm();
      toast({ title: "Goal created" });
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
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
                  <Badge variant={g.status === "completed" ? "default" : "secondary"} className="text-[10px] capitalize">{g.status}</Badge>
                </div>
                <Progress value={pct} className="h-2" />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
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
              <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => deleteMutation.mutate(editGoal.id)} data-testid="btn-delete-tracker-goal">
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

  const deleteTrackerMut = useMutation({
    mutationFn: async () => {
      if (!tracker) return;
      await apiRequest("DELETE", `/api/trackers/${tracker.id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/trackers"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Tracker deleted" });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete tracker", description: err.message, variant: "destructive" });
    },
  });

  if (!tracker) return null;

  const primaryField = tracker.fields.find((f) => f.isPrimary)?.name || tracker.fields[0]?.name || "value";
  const tabs = generateDynamicTabs(tracker);

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-2xl h-[90vh] max-h-[90vh] flex flex-col p-0" data-testid="tracker-detail-dialog">
          {/* ── Header ── */}
          <div className="px-5 pt-5 pb-3 pr-12 border-b shrink-0">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <DialogTitle className="text-base font-semibold truncate">{tracker.name}</DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  {tracker.entries.length} {tracker.entries.length === 1 ? "entry" : "entries"}
                  {tracker.unit ? ` · ${tracker.unit}` : ""}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button size="sm" onClick={() => setAddEntryOpen(true)} data-testid="button-add-entry-detail" className="h-7 text-xs">
                  <Plus className="w-3 h-3 mr-1" /> Add
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" data-testid="button-tracker-detail-menu">
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
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
                        <TabsTrigger key={tab.id} value={tab.id} className="text-[11px] px-2.5 py-1 h-7 gap-1 data-[state=active]:bg-background" data-testid={`tab-${tab.id}`}>
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
                  <HistoryTabContent tracker={tracker} primaryField={primaryField} />
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
  useEffect(() => { document.title = "Linked — Portol"; }, []);
  const { data: trackers, isLoading } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers"],
  });

  const { data: profiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const { data: allDocuments = [] } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [selectedTrackerId, setSelectedTrackerId] = useState<string | null>(null);
  // Resolve selectedTracker from the live query cache so it refreshes after mutations
  const selectedTracker = selectedTrackerId ? (trackers || []).find(t => t.id === selectedTrackerId) || null : null;
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [viewingDoc, setViewingDoc] = useState<Document | null>(null);
  const [docSearch, setDocSearch] = useState("");
  const docFileInputRef = useRef<HTMLInputElement>(null);
  const [uploadProfileId, setUploadProfileId] = useState<string>("");
  // Unified section filter: which sections to show
  const [sectionFilter, setSectionFilter] = useState<"all" | "profiles" | "subscriptions" | "documents" | "trackers">("all");
  // Document type filter
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");
  // Tracker category filter
  const [trackerCatFilter, setTrackerCatFilter] = useState<string>("all");
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
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const docDeleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onSuccess: () => {
      toast({ title: "Document deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // Filter documents by search + type filter + profile filter
  const filteredDocuments = allDocuments.filter(d => {
    // Profile filter
    if (filterMode === "selected" && filterIds.length > 0) {
      const linkedIds = d.linkedProfiles || [];
      const matchesProfile = linkedIds.some(id => filterIds.includes(id));
      const isOrphan = hasSelf && linkedIds.length === 0;
      if (!matchesProfile && !isOrphan) return false;
    }
    // Doc type filter
    if (docTypeFilter !== "all" && d.type !== docTypeFilter) return false;
    // Search
    if (docSearch) {
      const s = docSearch.toLowerCase();
      return d.name.toLowerCase().includes(s) || d.type?.toLowerCase().includes(s);
    }
    return true;
  });

  // Unique doc types for filter chips
  const docTypes = [...new Set(allDocuments.map(d => d.type).filter(Boolean))].sort();

  // Unique tracker categories for filter chips
  const allTrackerCats = [...new Set((trackers || []).map(t => t.category).filter(Boolean))].sort();

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 space-y-4">
        <div className="h-8 w-40 rounded skeleton-shimmer" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 rounded-lg skeleton-shimmer" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-44 rounded-lg skeleton-shimmer" />
          ))}
        </div>
      </div>
    );
  }

  // Build the list of profiles that have linked trackers OR are the "self" profile (always show "Me")
  // Show self, person, and pet profiles in filter (not vehicles/assets)
  const profilesWithTrackers = (profiles || []).filter(p =>
    ["self", "person", "pet"].includes(p.type)
  );

  // Sort so "self" (Me) comes first
  const sortedFilterProfiles = [...profilesWithTrackers].sort((a, b) => {
    if (a.type === "self") return -1;
    if (b.type === "self") return 1;
    return a.name.localeCompare(b.name);
  });

  // Apply profile filter — when hasSelf, also include orphaned trackers (no linked profiles)
  const filteredTrackers = (trackers || []).filter(t => {
    // Profile filter
    if (filterMode === "selected" && filterIds.length > 0) {
      const linkedIds = t.linkedProfiles || [];
      const matchesProfile = linkedIds.some(id => filterIds.includes(id));
      const isOrphan = hasSelf && linkedIds.length === 0;
      if (!matchesProfile && !isOrphan) return false;
    }
    // Category filter
    if (trackerCatFilter !== "all" && t.category !== trackerCatFilter) return false;
    return true;
  });

  // Group by category
  const grouped = filteredTrackers.reduce((acc: Record<string, Tracker[]>, t) => {
    (acc[t.category] = acc[t.category] || []).push(t);
    return acc;
  }, {});
  const catOrder = ["health", "fitness", "nutrition", "sleep", "habit", "finance", "custom"];
  const sortedCats = Object.keys(grouped).sort((a, b) => {
    const ai = catOrder.indexOf(a);
    const bi = catOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Count trackers per profile for badges
  const countForProfile = (profileId: string) =>
    (trackers || []).filter(t => t.linkedProfiles?.includes(profileId)).length;

  return (
    <div className="px-2 py-2 md:p-4 space-y-2 overflow-y-auto h-full pb-24" data-testid="page-trackers">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href="/dashboard">
            <button className="inline-flex items-center justify-center rounded-md w-7 h-7 hover:bg-muted transition-colors" data-testid="button-back" aria-label="Back">
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          </Link>
          <h1 className="text-sm font-semibold" data-testid="text-trackers-title">Linked</h1>
          <span className="text-[10px] text-muted-foreground">{filteredTrackers.length} trackers</span>
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
          <Button onClick={() => setCreateOpen(true)} size="icon" className="h-7 w-7" data-testid="button-create-tracker">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="space-y-2" data-testid="filter-bar">
        {/* Profile filter (page level) + Section pills */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Profile filter */}
          <MultiProfileFilter
            onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
            compact
          />
          <div className="h-4 w-px bg-border" />
          {/* Section filter pills */}
          {(["all", "trackers", "documents", "profiles", "subscriptions"] as const).map(s => {
            const subCount = (profiles || []).filter(p => p.type === "subscription").length;
            const assetCount = (profiles || []).filter(p => ["vehicle", "asset", "loan", "investment", "account", "property"].includes(p.type)).length;
            const labels: Record<string, string> = { all: "All", trackers: "Trackers", documents: "Documents", profiles: "Assets", subscriptions: "Subscriptions" };
            const counts: Record<string, number> = {
              all: filteredTrackers.length + filteredDocuments.length + subCount + assetCount,
              trackers: filteredTrackers.length,
              documents: filteredDocuments.length,
              profiles: assetCount,
              subscriptions: subCount,
            };
            return (
              <button
                key={s}
                onClick={() => setSectionFilter(s)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${sectionFilter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted border border-border/50"}`}
                data-testid={`filter-section-${s}`}
              >
                {labels[s]}
                {s !== "all" && <span className="ml-1 opacity-70">{counts[s]}</span>}
              </button>
            );
          })}
        </div>


      </div>

      {/* Summary cards */}
      {(sectionFilter === "all" || sectionFilter === "trackers") && filteredTrackers.length > 0 && (
        <TrackerSummary trackers={filteredTrackers} />
      )}

      {/* Assets & Vehicles — grouped by type */}
      {(sectionFilter === "all" || sectionFilter === "profiles") && (() => {
        const childTypeSet = new Set(["vehicle", "asset", "loan", "investment", "account", "property"]);
        const isShowAll = filterMode === "everyone" || hasSelf;
        const childProfiles = (profiles || []).filter(p => {
          if (!childTypeSet.has(p.type)) return false;
          if (isShowAll) return true;
          const pParent = p.fields?._parentProfileId || p.parentProfileId;
          return filterIds.includes(pParent);
        });
        if (childProfiles.length === 0) return null;

        // Group by type
        const typeGroups: Record<string, typeof childProfiles> = {};
        for (const p of childProfiles) {
          const group = p.type === "vehicle" ? "Vehicles" : p.type === "asset" ? "Assets" : p.type === "property" ? "Properties" : p.type === "loan" ? "Loans" : p.type === "investment" ? "Investments" : "Other";
          (typeGroups[group] = typeGroups[group] || []).push(p);
        }
        const groupOrder = ["Vehicles", "Assets", "Properties", "Loans", "Investments", "Other"];
        const sortedGroups = Object.entries(typeGroups).sort(([a], [b]) => groupOrder.indexOf(a) - groupOrder.indexOf(b));
        const typeIcons: Record<string, any> = { vehicle: Car, asset: Star, loan: CreditCard, investment: TrendingUp, property: Building2, account: CreditCard };

        return (
          <div className="space-y-1.5">
            <button onClick={() => toggleSection("profiles")} className="flex items-center gap-1.5 w-full" data-testid="section-toggle-profiles">
              <h2 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Assets & Vehicles ({childProfiles.length})</h2>
              {collapsedSections.has("profiles") ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronUp className="h-3 w-3 text-muted-foreground" />}
            </button>
            {!collapsedSections.has("profiles") && (
              <div className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden">
                {sortedGroups.map(([groupName, items]) => (
                  items.map(child => {
                    const Icon = typeIcons[child.type] || Star;
                    const fields = child.fields || {};
                    const price = fields.cost || fields.purchasePrice || fields.amount;
                    const year = fields.year || fields.purchaseDate?.slice(0, 4);
                    const detail = [fields.make, fields.model, fields.brand].filter(Boolean).join(' ');
                    return (
                      <Link key={child.id} href={`/profiles/${child.id}`}>
                        <div className="flex items-center gap-2 px-2 py-[6px] hover:bg-muted/40 active:bg-muted/60 cursor-pointer transition-colors" data-testid={`button-view-child-${child.id}`}>
                          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-[11px] font-medium truncate flex-1">{child.name}</span>
                          {detail && <span className="text-[9px] text-muted-foreground truncate max-w-[80px]">{detail}</span>}
                          {year && <span className="text-[9px] text-muted-foreground tabular-nums">{year}</span>}
                          {price && <span className="text-[10px] font-medium tabular-nums">${Number(price).toLocaleString()}</span>}
                          <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
                        </div>
                      </Link>
                    );
                  })
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Subscriptions Section */}
      {(sectionFilter === "all" || sectionFilter === "subscriptions") && (() => {
        const isShowAll = filterMode === "everyone" || hasSelf;
        const subs = (profiles || []).filter(p => {
          if (p.type !== "subscription") return false;
          if (isShowAll) return true;
          const pParent = p.fields?._parentProfileId || p.parentProfileId;
          return filterIds.includes(pParent);
        });
        if (subs.length === 0) return null;
        return (
          <div className="space-y-2">
            <button onClick={() => toggleSection("subscriptions")} className="flex items-center gap-1.5 w-full" data-testid="section-toggle-subscriptions">
              <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Subscriptions ({subs.length})</h2>
              {collapsedSections.has("subscriptions") ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronUp className="h-3 w-3 text-muted-foreground" />}
            </button>
            {!collapsedSections.has("subscriptions") && (
              <div className="rounded-lg border border-border/40 divide-y divide-border/30 overflow-hidden">
                {subs.map(sub => {
                  const fields = sub.fields || {};
                  const cost = fields.cost || fields.amount || fields.price;
                  const freq = fields.frequency || fields.billing || "monthly";
                  return (
                    <Link key={sub.id} href={`/profiles/${sub.id}`}>
                      <div className="flex items-center gap-2 px-2 py-[6px] hover:bg-muted/40 active:bg-muted/60 cursor-pointer transition-colors" data-testid={`sub-card-${sub.id}`}>
                        <CreditCard className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="text-[11px] font-medium truncate flex-1">{sub.name}</span>
                        {cost && <span className="text-[10px] font-medium tabular-nums">${cost}/{String(freq).slice(0, 3)}</span>}
                        <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
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
      {(sectionFilter === "all" || sectionFilter === "documents") && <div className="space-y-2">
        <div className="flex items-center justify-between">
          <button onClick={() => toggleSection("documents")} className="flex items-center gap-1.5" data-testid="section-toggle-documents">
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Documents ({filteredDocuments.length})</h2>
            {collapsedSections.has("documents") ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronUp className="h-3 w-3 text-muted-foreground" />}
          </button>
          <div className="flex items-center gap-2">
            {/* Profile selector for upload — link doc to a specific profile */}
            <Select value={uploadProfileId} onValueChange={setUploadProfileId}>
              <SelectTrigger className="w-[120px] h-7 text-[10px]" data-testid="select-upload-profile">
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
            {docTypes.length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  onClick={() => setDocTypeFilter("all")}
                  className={`px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${docTypeFilter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                  data-testid="filter-doctype-all"
                >All ({filteredDocuments.length})</button>
                {docTypes.map(t => {
                  const count = allDocuments.filter(d => d.type === t).length;
                  return (
                    <button
                      key={t}
                      onClick={() => setDocTypeFilter(t)}
                      className={`px-2.5 py-1 rounded-full text-[10px] font-medium capitalize transition-colors ${docTypeFilter === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
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
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {filteredDocuments.map(doc => {
              const DOC_TYPE_COLORS: Record<string, string> = {
                medical: "bg-red-500/10 text-red-500",
                insurance: "bg-blue-500/10 text-blue-500",
                legal: "bg-purple-500/10 text-purple-500",
                financial: "bg-green-500/10 text-green-500",
                identity: "bg-amber-500/10 text-amber-500",
                warranty: "bg-orange-500/10 text-orange-500",
                receipt: "bg-emerald-500/10 text-emerald-500",
              };
              const colorClass = DOC_TYPE_COLORS[doc.type] || "bg-slate-500/10 text-slate-500";
              return (
                <div key={doc.id} className="rounded-lg border bg-card overflow-hidden" data-testid={`global-doc-${doc.id}`}>
                  <div className="flex items-center gap-3 p-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${colorClass}`}>
                      {doc.mimeType?.startsWith("image/") ? <Eye className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                    </div>
                    <button className="flex-1 min-w-0 text-left" onClick={() => setViewingDoc(doc)}>
                      <p className="text-sm font-medium truncate text-primary hover:underline">{doc.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <Badge variant="secondary" className="text-[10px] capitalize">{doc.type?.replace(/_/g, " ")}</Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(doc.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                        {doc.linkedProfiles?.length > 0 && (() => {
                          const linkedNames = doc.linkedProfiles.map((pid: string) => (profiles || []).find(p => p.id === pid)?.name).filter(Boolean);
                          return linkedNames.length > 0 ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                              {linkedNames.join(", ")}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </button>
                    <div className="flex gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setViewingDoc(doc)} data-testid={`button-view-doc-global-${doc.id}`}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => docDeleteMutation.mutate(doc.id)} data-testid={`button-delete-doc-global-${doc.id}`}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>}

      {/* Trackers Section */}
      {(sectionFilter === "all" || sectionFilter === "trackers") && ((!trackers || trackers.length === 0) ? (
        <div className="text-center py-16">
          <Activity className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No trackers yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Click "New Tracker" or ask Portol to create one.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => setCreateOpen(true)}
            data-testid="button-create-tracker-empty"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Create First Tracker
          </Button>
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
      ) : viewMode === "table" ? (
        <div className="space-y-3" data-testid="tracker-table">
          {filteredTrackers.map((tracker) => {
            const entries = tracker.entries;
            const spec = detectSpecialization(tracker);
            const pf = tracker.fields.find(f => f.isPrimary)?.name || tracker.fields[0]?.name || "value";
            const unit = tracker.unit || "";
            const last = entries[entries.length - 1];
            const rv = last?.values;
            const pv = typeof rv === 'string' ? (() => { try { return JSON.parse(rv); } catch { return null; } })() : rv;
            const latestVal = pv?.[pf] ?? (pv ? Object.values(pv).find(v => typeof v === 'number') : null);

            // Compute stats
            const numEntries = entries.filter(e => {
              const v = e.values?.[pf]; return typeof v === 'number';
            });
            const vals = numEntries.map(e => Number(e.values[pf]));
            const avg7d = (() => {
              const week = entries.filter(e => Date.now() - new Date(e.timestamp).getTime() < 7 * 86400000);
              const wv = week.map(e => Number(e.values?.[pf])).filter(v => !isNaN(v));
              return wv.length > 0 ? wv.reduce((a, b) => a + b, 0) / wv.length : null;
            })();
            const prevWeek = (() => {
              const pw = entries.filter(e => {
                const age = Date.now() - new Date(e.timestamp).getTime();
                return age >= 7 * 86400000 && age < 14 * 86400000;
              });
              const wv = pw.map(e => Number(e.values?.[pf])).filter(v => !isNaN(v));
              return wv.length > 0 ? wv.reduce((a, b) => a + b, 0) / wv.length : null;
            })();
            const trend = avg7d != null && prevWeek != null && prevWeek !== 0
              ? ((avg7d - prevWeek) / Math.abs(prevWeek)) * 100 : null;
            const trendDir: "up" | "down" | "flat" = trend != null ? (trend > 2 ? "up" : trend < -2 ? "down" : "flat") : "flat";

            // Sparkline data (last 14 entries)
            const sparkData = entries.slice(-14).map(e => {
              const v = Number(e.values?.[pf]);
              return { v: isNaN(v) ? 0 : v };
            });

            // Last updated
            const lastUpdated = last ? (() => {
              const diff = Date.now() - new Date(last.timestamp).getTime();
              const mins = Math.floor(diff / 60000);
              if (mins < 60) return `${mins}m ago`;
              const hrs = Math.floor(mins / 60);
              if (hrs < 24) return `${hrs}h ago`;
              const days = Math.floor(hrs / 24);
              return days === 1 ? "yesterday" : `${days}d ago`;
            })() : null;

            // This week total (for activity trackers)
            const thisWeekEntries = entries.filter(e => Date.now() - new Date(e.timestamp).getTime() < 7 * 86400000);
            const thisWeekTotal = thisWeekEntries.reduce((sum, e) => sum + (Number(e.values?.[pf]) || 0), 0);

            // Type-specific display
            let primaryDisplay = "";
            let secondaryLine = "";
            let trendText = "";
            let statusBadge: { label: string; color: string } | null = null;

            if (spec === "bloodpressure" || spec === "bp") {
              const sys = pv?.systolic || pv?.sys || latestVal;
              const dia = pv?.diastolic || pv?.dia;
              primaryDisplay = dia ? `${sys}/${dia}` : String(sys || "—");
              if (avg7d != null) secondaryLine = `7d avg: ${avg7d.toFixed(0)}`;
              if (typeof sys === 'number') {
                if (sys >= 140) statusBadge = { label: "High", color: "text-red-500 bg-red-500/10" };
                else if (sys >= 130) statusBadge = { label: "Elevated", color: "text-amber-500 bg-amber-500/10" };
                else statusBadge = { label: "Normal", color: "text-green-500 bg-green-500/10" };
              }
            } else if (spec === "weight") {
              primaryDisplay = latestVal != null ? `${Number(latestVal).toFixed(1)}` : "—";
              if (avg7d != null) secondaryLine = `7d avg: ${avg7d.toFixed(1)} ${unit}`;
              if (trend != null) trendText = `${trend > 0 ? "+" : ""}${trend.toFixed(1)}% this week`;
            } else if (spec === "sleep") {
              primaryDisplay = latestVal != null ? `${Number(latestVal).toFixed(1)}` : "—";
              if (avg7d != null) secondaryLine = `7d avg: ${avg7d.toFixed(1)} hrs`;
            } else if (spec === "running" || tracker.category === "fitness") {
              primaryDisplay = latestVal != null ? `${Number(latestVal).toFixed(1)}` : "—";
              secondaryLine = `This week: ${thisWeekTotal.toFixed(1)} ${unit} · ${thisWeekEntries.length} sessions`;
            } else if (tracker.name.toLowerCase().includes("practice") || tracker.name.toLowerCase().includes("gaming")) {
              primaryDisplay = latestVal != null ? `${Number(latestVal).toFixed(0)}` : "—";
              secondaryLine = `This week: ${thisWeekTotal.toFixed(0)} ${unit} · ${thisWeekEntries.length} sessions`;
            } else if (tracker.category === "nutrition") {
              primaryDisplay = latestVal != null ? `${Number(latestVal).toFixed(0)}` : "—";
              secondaryLine = `Today's total · 7d avg: ${avg7d != null ? avg7d.toFixed(0) : "—"} ${unit}`;
            } else {
              primaryDisplay = latestVal != null ? `${typeof latestVal === 'number' ? Number(latestVal).toFixed(1) : latestVal}` : "—";
              if (entries.length > 1 && avg7d != null) secondaryLine = `7d avg: ${avg7d.toFixed(1)} ${unit}`;
            }

            // Generic trend text if not set
            if (!trendText && trend != null) {
              trendText = `${trend > 0 ? "↑" : trend < 0 ? "↓" : "→"} ${Math.abs(trend).toFixed(0)}% vs last week`;
            }

            // AI insight (simple client-side version)
            let insight = "";
            if (entries.length >= 5) {
              if (trendDir === "up" && (spec === "weight" || spec === "sleep" || tracker.category === "fitness")) {
                insight = spec === "weight" ? "Trending up — check if this aligns with your goal" : "Improving this week";
              } else if (trendDir === "down" && spec === "weight") {
                insight = "Trending down — on track if losing weight";
              } else if (trendDir === "flat") {
                insight = "Holding steady";
              } else if (entries.length >= 10) {
                const streak = computeStreak(entries);
                if (streak >= 3) insight = `${streak}-day logging streak`;
              }
            } else if (entries.length === 1) {
              insight = "Just started tracking";
            } else if (entries.length === 0) {
              insight = "No entries yet";
            }

            const linkedProfile = profiles?.find(p => tracker.linkedProfiles?.includes(p.id));

            return (
              <div
                key={tracker.id}
                className="rounded-xl border bg-card p-3.5 hover:bg-muted/20 cursor-pointer transition-colors"
                data-testid={`tracker-row-${tracker.id}`}
                onClick={() => setSelectedTrackerId(tracker.id)}
              >
                {/* Row 1: Name + badges */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold truncate">{tracker.name}</span>
                    {linkedProfile && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">{linkedProfile.name}</span>
                    )}
                  </div>
                  {statusBadge && (
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${statusBadge.color}`}>{statusBadge.label}</span>
                  )}
                </div>

                {/* Row 2: Primary metric + sparkline */}
                <div className="flex items-end justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xl font-bold tabular-nums">{primaryDisplay}</span>
                      <span className="text-[10px] text-muted-foreground">{unit}</span>
                    </div>
                    {secondaryLine && <p className="text-[10px] text-muted-foreground mt-0.5">{secondaryLine}</p>}
                    {trendText && (
                      <p className={`text-[10px] mt-0.5 ${trendDir === 'up' ? 'text-green-500' : trendDir === 'down' ? 'text-orange-500' : 'text-muted-foreground'}`}>
                        {trendText}
                      </p>
                    )}
                  </div>
                  {/* Sparkline */}
                  {sparkData.length >= 2 && (
                    <div className="w-20 h-10 shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={sparkData} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                          <defs>
                            <linearGradient id={`spark-${tracker.id}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                              <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <Area type="monotone" dataKey="v" stroke={CHART_COLORS.primary} strokeWidth={1.5} fill={`url(#spark-${tracker.id})`} dot={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                {/* Row 3: Insight + last updated */}
                {(insight || lastUpdated) && (
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/50">
                    {insight && <p className="text-[10px] text-muted-foreground italic truncate">{insight}</p>}
                    {lastUpdated && <p className="text-[9px] text-muted-foreground/70 shrink-0 ml-2">{lastUpdated}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        sortedCats.map((cat) => (
          <div key={cat}>
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 capitalize">
              {cat} ({grouped[cat].length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {grouped[cat].map((tracker) => (
                <TrackerCard
                  key={tracker.id}
                  tracker={tracker}
                  onDelete={(id) => setDeleteTargetId(id)}
                  onOpenDetail={(id) => setSelectedTrackerId(id)}
                />
              ))}
            </div>
          </div>
        ))
      ))}

      {/* Create tracker dialog */}
      <CreateTrackerDialog open={createOpen} onOpenChange={setCreateOpen} />

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

      {/* Document viewer dialog */}
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
