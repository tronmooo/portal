import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  ChevronDown,
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
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import type { Tracker, TrackerEntry, TrackerField, ComputedData, Profile } from "@shared/schema";
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

function StatsRow({ entries, primaryField, unit }: { entries: TrackerEntry[]; primaryField: string; unit?: string }) {
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
          <StatsRow entries={filteredEntries} primaryField={primaryField} unit={tracker.unit} />
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
                  value={values[f.name] ?? ""}
                  onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
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
}: {
  tracker: Tracker;
  onDelete: (id: string) => void;
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
  const lastVal = lastEntry?.values[primaryField];
  const prevVal = prevEntry?.values[primaryField];
  const trend = typeof lastVal === "number" && typeof prevVal === "number" ? lastVal - prevVal : null;

  const sparklineData = tracker.entries.slice(-10).map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value: typeof e.values[primaryField] === "number" ? e.values[primaryField] : 0,
  }));

  // Entries sorted newest first for the expanded list
  const sortedEntries = [...tracker.entries].reverse();

  const specialization = detectSpecialization(tracker);
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
            <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
              {specIcon && <span className="text-muted-foreground">{specIcon}</span>}
              {tracker.name}
            </CardTitle>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge variant="secondary" className="text-[10px] capitalize">{tracker.category}</Badge>
              <span className="text-[10px] text-muted-foreground">{tracker.entries.length} {tracker.entries.length === 1 ? 'entry' : 'entries'}</span>
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

  return (
    <div
      className="flex items-start justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs bg-muted/30"
      data-testid={`entry-row-${entry.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="font-medium tabular-nums">
            {primaryVal !== undefined ? String(primaryVal) : "—"}
          </span>
          {tracker.unit && (
            <span className="text-muted-foreground text-[10px]">{tracker.unit}</span>
          )}
          {otherFields.map((f) => {
            const v = entry.values[f.name];
            if (v === undefined || v === "") return null;
            return (
              <span key={f.name} className="text-muted-foreground text-[10px]">
                {f.name}: {String(v)}{f.unit ? ` ${f.unit}` : ""}
              </span>
            );
          })}
        </div>
        {entry.notes && (
          <p className="text-muted-foreground mt-0.5 truncate">{entry.notes}</p>
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
    { name: "", type: "number", unit: "", options: "" },
  ]);

  const mutation = useMutation({
    mutationFn: async () => {
      const builtFields = fields
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
      setFields([{ name: "", type: "number", unit: "", options: "" }]);
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
    setFields([{ name: "", type: "number", unit: "", options: "" }]);
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
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="tracker-summary">
      {/* Weekly entries */}
      <Card className="p-3" data-testid="summary-weekly-entries">
        <div className="flex items-center gap-2 mb-1">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">This Week</span>
        </div>
        <div className="text-xl font-semibold tabular-nums" style={{ color: CHART_COLORS.primary }}>
          {weeklyEntries}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{weeklyEntries === 1 ? 'entry' : 'entries'} logged</div>
      </Card>

      {/* Most active */}
      <Card className="p-3" data-testid="summary-most-active">
        <div className="flex items-center gap-2 mb-1">
          <BarChart2 className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Most Active</span>
        </div>
        <div className="text-sm font-semibold truncate" style={{ color: CHART_COLORS.tertiary }}>
          {mostActive.count > 0 ? mostActive.name : "—"}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {mostActive.count > 0 ? `${mostActive.count} ${mostActive.count === 1 ? 'entry' : 'entries'} this week` : "No entries yet"}
        </div>
      </Card>

      {/* Best streak */}
      <Card className="p-3" data-testid="summary-best-streak">
        <div className="flex items-center gap-2 mb-1">
          <Trophy className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Best Streak</span>
        </div>
        <div className="text-xl font-semibold tabular-nums" style={{ color: CHART_COLORS.gold }}>
          {bestStreak.streak > 0 ? `${bestStreak.streak}d` : "—"}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 truncate">
          {bestStreak.name || "No streak yet"}
        </div>
      </Card>

      {/* Health score */}
      <Card className="p-3" data-testid="summary-health-score">
        <div className="flex items-center gap-2 mb-1">
          <Flame className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Health Score</span>
        </div>
        <div className={`text-xl font-semibold tabular-nums ${healthScoreColor}`}>
          {healthScore !== null ? `${healthScore}` : "—"}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {healthScore !== null
            ? healthScore >= 80 ? "Excellent"
              : healthScore >= 60 ? "Good"
              : "Needs attention"
            : "No health data"}
        </div>
      </Card>
    </div>
  );
}

// ── TrackerDetailDialog ──────────────────────────────────────────────────────

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
  const sortedEntries = [...tracker.entries].reverse();

  // ── Compute stats from numeric primary field ──
  const numericValues = tracker.entries
    .map((e) => e.values[primaryField])
    .filter((v): v is number => typeof v === "number");
  const hasNumeric = numericValues.length > 0;
  const min = hasNumeric ? Math.min(...numericValues) : null;
  const max = hasNumeric ? Math.max(...numericValues) : null;
  const avg = hasNumeric ? numericValues.reduce((s, v) => s + v, 0) / numericValues.length : null;
  const latest = numericValues.length > 0 ? numericValues[numericValues.length - 1] : null;
  const prev = numericValues.length > 1 ? numericValues[numericValues.length - 2] : null;
  const trendDelta = latest != null && prev != null ? latest - prev : null;

  // ── Chart data (last 20 entries, chronological) ──
  const chartEntries = tracker.entries.slice(-20);
  const chartData = chartEntries.map((e) => ({
    date: new Date(e.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    value: typeof e.values[primaryField] === "number" ? e.values[primaryField] : 0,
  }));

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0" data-testid="tracker-detail-dialog">
          {/* ── Header ── */}
          <div className="px-5 pt-5 pb-3 border-b">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="text-base font-semibold">{tracker.name}</DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  {tracker.entries.length} {tracker.entries.length === 1 ? "entry" : "entries"}
                  {tracker.unit ? ` · ${tracker.unit}` : ""}
                  {" · "}<span className="capitalize">{tracker.category}</span>
                </DialogDescription>
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" onClick={() => setAddEntryOpen(true)} data-testid="button-add-entry-detail" className="h-7 text-xs">
                  <Plus className="w-3 h-3 mr-1" /> Add Entry
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteTrackerOpen(true)}
                  data-testid="button-delete-tracker-detail"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>

          {/* ── Stats Row ── */}
          {hasNumeric && (
            <div className="grid grid-cols-4 gap-px bg-border mx-5 mt-3 rounded-lg overflow-hidden" data-testid="tracker-stats-row">
              <div className="bg-card p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Latest</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">
                  {latest != null ? latest : "—"}
                  {trendDelta != null && (
                    <span className={`text-[10px] ml-1 ${trendDelta < 0 ? "text-green-600" : trendDelta > 0 ? "text-orange-500" : "text-muted-foreground"}`}>
                      {trendDelta > 0 ? "+" : ""}{trendDelta.toFixed(1)}
                    </span>
                  )}
                </p>
              </div>
              <div className="bg-card p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Average</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">{avg != null ? avg.toFixed(1) : "—"}</p>
              </div>
              <div className="bg-card p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Min</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">{min != null ? min : "—"}</p>
              </div>
              <div className="bg-card p-2.5 text-center">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Max</p>
                <p className="text-sm font-semibold tabular-nums mt-0.5">{max != null ? max : "—"}</p>
              </div>
            </div>
          )}

          {/* ── Mini Chart ── */}
          {hasNumeric && chartData.length >= 2 && (
            <div className="mx-5 mt-3 h-[120px]" data-testid="tracker-mini-chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="detailGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" />
                  <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid hsl(var(--border))" }}
                    formatter={(val: number) => [`${val} ${tracker.unit || ""}`, primaryField]}
                  />
                  {avg != null && <ReferenceLine y={avg} stroke={CHART_COLORS.secondary} strokeDasharray="4 4" label={{ value: "avg", fontSize: 9, fill: CHART_COLORS.secondary }} />}
                  <Area type="monotone" dataKey="value" stroke={CHART_COLORS.primary} strokeWidth={2} fill="url(#detailGrad)" dot={{ r: 2.5, fill: CHART_COLORS.primary }} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Entry List ── */}
          <div className="flex-1 overflow-y-auto px-5 pb-5 mt-3 space-y-1.5" data-testid="tracker-entry-list">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-2">All Entries</p>
            {sortedEntries.length === 0 ? (
              <div className="text-center py-8">
                <Activity className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No entries yet</p>
                <p className="text-xs text-muted-foreground mt-1">Click "Add Entry" to start logging data.</p>
              </div>
            ) : (
              sortedEntries.map((entry, idx) => {
                const val = entry.values[primaryField];
                const displayVal = val != null
                  ? `${val} ${tracker.unit || ""}`
                  : Object.entries(entry.values).map(([k, v]) => `${k}: ${v}`).join(", ");
                // Show delta vs previous entry
                const nextEntry = sortedEntries[idx + 1]; // next = older
                const nextVal = nextEntry?.values[primaryField];
                const entryDelta = typeof val === "number" && typeof nextVal === "number" ? val - nextVal : null;

                return (
                  <div
                    key={entry.id}
                    className="group flex items-center justify-between py-2 px-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors text-sm"
                    data-testid={`entry-row-${entry.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono font-semibold tabular-nums text-sm">{displayVal}</span>
                      {entryDelta != null && entryDelta !== 0 && (
                        <span className={`text-[10px] font-medium tabular-nums ${entryDelta < 0 ? "text-green-600" : "text-orange-500"}`}>
                          {entryDelta > 0 ? "+" : ""}{entryDelta.toFixed(1)}
                        </span>
                      )}
                      {entry.notes && (
                        <span className="text-[10px] text-muted-foreground truncate max-w-[120px]" title={entry.notes}>
                          {entry.notes}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        {" "}
                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <DeleteEntryButton trackerId={tracker.id} entryId={entry.id} />
                    </div>
                  </div>
                );
              })
            )}
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
              data-testid="button-delete-tracker-confirm"
            >
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
  const { data: trackers, isLoading } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers"],
  });

  const { data: profiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [selectedTrackerId, setSelectedTrackerId] = useState<string | null>(null);
  // Resolve selectedTracker from the live query cache so it refreshes after mutations
  const selectedTracker = selectedTrackerId ? (trackers || []).find(t => t.id === selectedTrackerId) || null : null;
  // Default to "all" so all trackers are visible
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");

  // Auto-resolve "me" to the actual self profile ID once profiles load
  const selfProfile = (profiles || []).find(p => p.type === "self");
  const resolvedFilter = profileFilter === "me" ? (selfProfile?.id || "me") : profileFilter;

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
  const profilesWithTrackers = (profiles || []).filter(p =>
    p.type === "self" || (trackers || []).some(t => t.linkedProfiles?.includes(p.id))
  );

  // Sort so "self" (Me) comes first
  const sortedFilterProfiles = [...profilesWithTrackers].sort((a, b) => {
    if (a.type === "self") return -1;
    if (b.type === "self") return 1;
    return a.name.localeCompare(b.name);
  });

  // Apply profile filter
  const filteredTrackers = (trackers || []).filter(t => {
    if (resolvedFilter === "all") return true;
    return t.linkedProfiles?.includes(resolvedFilter);
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
    <div className="p-4 md:p-6 space-y-4 overflow-y-auto h-full" data-testid="page-trackers">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <Link href="/">
              <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </button>
            </Link>
            <h1 className="text-xl font-semibold" data-testid="text-trackers-title">Trackers</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {(trackers || []).length === 0
              ? "Create a tracker to start logging data"
              : filteredTrackers.length === (trackers || []).length
                ? `${(trackers || []).length} tracker${(trackers || []).length !== 1 ? 's' : ''}`
                : `${filteredTrackers.length} of ${(trackers || []).length} trackers shown`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 border rounded-md p-0.5">
            <button
              onClick={() => setViewMode("table")}
              className={`p-1.5 rounded ${viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              data-testid="view-table"
            >
              <Table2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("cards")}
              className={`p-1.5 rounded ${viewMode === "cards" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              data-testid="view-cards"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            size="sm"
            data-testid="button-create-tracker"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            New Tracker
          </Button>
        </div>
      </div>

      {/* Profile Filter Bar — always shown when profiles exist */}
      {sortedFilterProfiles.length > 0 && (
        <div className="space-y-1.5" data-testid="profile-filter-bar">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" />
            <span className="font-medium">Filter by Profile</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {/* All chip */}
            <button
              onClick={() => setProfileFilter("all")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                resolvedFilter === "all"
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
              }`}
              data-testid="filter-all"
            >
              <Activity className="h-3 w-3" />
              All
              <span className={`text-[10px] px-1 py-0 rounded-full ${resolvedFilter === "all" ? "bg-primary-foreground/20" : "bg-muted-foreground/20"}`}>
                {(trackers || []).length}
              </span>
            </button>

            {/* One chip per profile that has trackers — "Me" always first */}
            {sortedFilterProfiles.map(p => {
              const Icon = PROFILE_TYPE_ICONS[p.type] || User;
              const count = countForProfile(p.id);
              const isActive = resolvedFilter === p.id;
              // For self profile, clicking when active goes to "all"; for others, toggle
              const handleClick = () => {
                if (isActive) {
                  setProfileFilter("all");
                } else if (p.type === "self") {
                  setProfileFilter("me");
                } else {
                  setProfileFilter(p.id);
                }
              };
              return (
                <button
                  key={p.id}
                  onClick={handleClick}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    isActive
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                  }`}
                  data-testid={`filter-profile-${p.id}`}
                >
                  {p.avatar ? (
                    <img src={p.avatar} alt={p.name} className="h-3.5 w-3.5 rounded-full object-cover" />
                  ) : (
                    <Icon className="h-3 w-3" />
                  )}
                  {p.name}
                  <span className={`text-[10px] px-1 py-0 rounded-full ${isActive ? "bg-primary-foreground/20" : "bg-muted-foreground/20"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Summary cards */}
      {filteredTrackers.length > 0 && (
        <TrackerSummary trackers={filteredTrackers} />
      )}

      {(!trackers || trackers.length === 0) ? (
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
            No trackers linked to {(profiles || []).find(p => p.id === resolvedFilter)?.name || "this profile"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setProfileFilter("all")}
            data-testid="button-clear-filter"
          >
            Show All Trackers
          </Button>
        </div>
      ) : viewMode === "table" ? (
        <div className="border rounded-lg overflow-hidden" data-testid="tracker-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 border-b">
                <th className="text-left p-3 font-medium min-w-[150px]">Tracker</th>
                <th className="text-left p-3 font-medium">Category</th>
                <th className="text-left p-3 font-medium">Latest Value</th>
                <th className="text-left p-3 font-medium">Last Updated</th>
                <th className="text-left p-3 font-medium">Entries</th>
                <th className="text-left p-3 font-medium">Linked To</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrackers.map((tracker) => {
                const lastEntry = tracker.entries[tracker.entries.length - 1];
                const primaryField = tracker.fields.find((f) => f.isPrimary)?.name || tracker.fields[0]?.name || "value";
                const latestValue = lastEntry?.values?.[primaryField]
                  ?? (lastEntry?.values ? Object.values(lastEntry.values).find(v => typeof v === 'number') : null)
                  ?? (lastEntry?.values ? Object.values(lastEntry.values)[0] : null);
                const unit = tracker.unit || "";
                const linkedProfile = profiles?.find(p => tracker.linkedProfiles?.includes(p.id));
                return (
                  <tr
                    key={tracker.id}
                    className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                    data-testid={`tracker-row-${tracker.id}`}
                    onClick={() => setSelectedTrackerId(tracker.id)}
                  >
                    <td className="p-3 font-medium">{tracker.name}</td>
                    <td className="p-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted">{tracker.category}</span>
                    </td>
                    <td className="p-3 font-mono tabular-nums">
                      {latestValue != null ? `${latestValue} ${unit}` : "—"}
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {lastEntry ? new Date(lastEntry.timestamp).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-3 text-muted-foreground">{tracker.entries.length}</td>
                    <td className="p-3">
                      {linkedProfile ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                          {linkedProfile.name}
                        </span>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                />
              ))}
            </div>
          </div>
        ))
      )}

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
    </div>
  );
}
