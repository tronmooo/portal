import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, BarChart3, FileText, CheckSquare, Calculator, LayoutGrid, ClipboardList, Zap, TrendingUp, TrendingDown, Minus, ChevronRight } from "lucide-react";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { apiRequest } from "@/lib/queryClient";

// Color tokens for charts
const COLORS = {
  primary: "hsl(var(--primary))",
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
  muted: "hsl(var(--muted-foreground))",
};

// ═══════════════════════════════════════════════
// ARTIFACT PANEL — the right-side split pane
// ═══════════════════════════════════════════════
export function ArtifactPanel({ artifact, onClose }: { artifact: any; onClose: () => void }) {
  if (!artifact) return null;
  
  return (
    <div className="h-full flex flex-col bg-background border-l border-border">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {typeIcon(artifact.type)}
          <h3 className="text-sm font-semibold truncate">{artifact.title}</h3>
          <Badge variant="outline" className="text-xs shrink-0">{artifact.type}</Badge>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 shrink-0" aria-label="Close artifact panel">
          <X className="h-4 w-4" />
        </Button>
      </div>
      
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <ArtifactRenderer type={artifact.type} data={artifact.data} artifactKey={artifactStateKey(artifact)} />
      </div>
    </div>
  );
}

/**
 * A stable per-artifact key for view state that belongs to the reader rather
 * than to the record — which, for a chat checklist, is what a tick is.
 *
 * Derived from the content, not from an id: a chat artifact is rendered
 * straight off the assistant's turn and may never have been persisted, so
 * there is no id to key on. The same checklist reopened later hashes the same;
 * two different checklists never collide.
 */
function artifactStateKey(artifact: any): string | undefined {
  try {
    const items = Array.isArray(artifact?.data?.items) ? artifact.data.items : null;
    if (!items) return undefined;
    const seed = [artifact?.type, artifact?.title, ...items.map((i: any) => String(i?.text ?? ""))].join("\u0001");
    // djb2 — short, stable, and this only has to distinguish, not to secure.
    let h = 5381;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
    return `portol_checklist_${(h >>> 0).toString(36)}`;
  } catch {
    return undefined;
  }
}

function typeIcon(type: string) {
  const iconClass = "h-4 w-4 text-primary";
  switch (type) {
    case "chart": return <BarChart3 className={iconClass} />;
    case "summary_report": return <FileText className={iconClass} />;
    case "checklist": return <CheckSquare className={iconClass} />;
    case "calculator": return <Calculator className={iconClass} />;
    case "kpi_cards": return <LayoutGrid className={iconClass} />;
    case "structured_plan": return <ClipboardList className={iconClass} />;
    case "quick_entry_form": return <Zap className={iconClass} />;
    default: return <FileText className={iconClass} />;
  }
}

// ═══════════════════════════════════════════════
// RENDERER — dispatches to type-specific component
// ═══════════════════════════════════════════════
function ArtifactRenderer({ type, data, artifactKey }: { type: string; data: any; artifactKey?: string }) {
  switch (type) {
    case "chart": return <ChartArtifact data={data} />;
    case "summary_report": return <SummaryReportArtifact data={data} />;
    case "kpi_cards": return <KpiCardsArtifact data={data} />;
    case "checklist": return <ChecklistArtifact data={data} artifactKey={artifactKey} />;
    case "structured_plan": return <StructuredPlanArtifact data={data} />;
    case "calculator": return <CalculatorArtifact data={data} />;
    case "quick_entry_form": return <QuickEntryFormArtifact data={data} />;
    default: return <div className="text-sm text-muted-foreground">Unknown artifact type: {type}</div>;
  }
}

// ═══════════════════════════════════════════════
// 1. CHART
// ═══════════════════════════════════════════════
export function chartSourceRequestPath(source: any): string | null {
  const kind = typeof source?.kind === "string" ? source.kind.trim().toLowerCase() : "";
  const ref = typeof source?.ref === "string" ? source.ref.trim() : "";
  if ((kind !== "tracker" && kind !== "trackers") || !ref) return null;
  return `/api/trackers/${encodeURIComponent(ref)}`;
}

export function normalizeChartSourceRows(payload: any, series: any[] = []): any[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.entries)
      ? payload.entries
      : [];
  const seriesKeys = series
    .map((item: any) => item?.key || item?.dataKey)
    .filter((key: unknown): key is string => typeof key === "string" && key.length > 0);

  return rows.flatMap((row: any, index: number) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const values = row.values && typeof row.values === "object" && !Array.isArray(row.values)
      ? row.values
      : {};
    const normalized = { ...row, ...values };
    normalized.name = normalized.name
      ?? normalized.label
      ?? normalized.date
      ?? normalized.timestamp
      ?? String(index + 1);
    const usableKeys = seriesKeys.length > 0
      ? seriesKeys
      : Object.keys(normalized).filter(key => key !== "name" && typeof normalized[key] === "number");
    return usableKeys.some(key => normalized[key] !== undefined && normalized[key] !== null)
      ? [normalized]
      : [];
  });
}

export function selectChartDisplayData(sourcePayload: any, inlineData: any, series: any[] = []): any[] {
  const sourceRows = normalizeChartSourceRows(sourcePayload, series);
  if (sourceRows.length > 0) return sourceRows;
  return Array.isArray(inlineData) ? inlineData : [];
}

function ChartArtifact({ data }: { data: any }) {
  const { chartType = "bar", series = [], source, insight } = data;

  const sourcePath = chartSourceRequestPath(source);
  // A tracker reference identifies one tracker resource. The default query
  // function intentionally uses only queryKey[0], so putting the ref in a
  // second key slot used to fetch the whole tracker list instead.
  const { data: sourcePayload } = useQuery({
    queryKey: [sourcePath || "artifact-chart-inline"],
    queryFn: async () => (await apiRequest("GET", sourcePath!)).json(),
    enabled: !!sourcePath,
  });

  // Tracker detail responses wrap chartable rows in `.entries`. A failed,
  // malformed, or empty source must never displace valid inline chart data.
  const displayData = useMemo(() => {
    return selectChartDisplayData(sourcePayload, data.data, series);
  }, [sourcePayload, data.data, series]);
  
  if (displayData.length === 0) return <div className="text-muted-foreground text-sm">No data available for chart</div>;
  
  const primaryKey = series[0]?.key || series[0]?.dataKey || "value";
  const primaryColor = COLORS[series[0]?.color as keyof typeof COLORS] || COLORS.primary;
  
  return (
    <div className="space-y-3">
      <ResponsiveContainer width="100%" height={280}>
        {chartType === "line" ? (
          <LineChart data={displayData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            {series.map((s: any, i: number) => (
              <Line key={i} type="monotone" dataKey={s.key || s.dataKey} stroke={COLORS[s.color as keyof typeof COLORS] || COLORS.primary} strokeWidth={2} dot={{ r: 3 }} />
            ))}
          </LineChart>
        ) : chartType === "area" ? (
          <AreaChart data={displayData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Area type="monotone" dataKey={primaryKey} stroke={primaryColor} fill={primaryColor} fillOpacity={0.2} />
          </AreaChart>
        ) : chartType === "pie" ? (
          <PieChart>
            <Pie data={displayData} dataKey={primaryKey} nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
              {displayData.map((_: any, i: number) => (
                <Cell key={i} fill={Object.values(COLORS)[i % 5]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        ) : (
          <BarChart data={displayData}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip />
            <Bar dataKey={primaryKey} fill={primaryColor} radius={[4,4,0,0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
      {insight && <p className="text-xs text-muted-foreground italic">{insight}</p>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 2. SUMMARY REPORT
// ═══════════════════════════════════════════════
function SummaryReportArtifact({ data }: { data: any }) {
  const { period, sections = [], highlights = [], recommendations = [] } = data;
  const trendIcon = (t: string) => t === "up" ? <TrendingUp className="h-3.5 w-3.5 text-green-500" /> : t === "down" ? <TrendingDown className="h-3.5 w-3.5 text-red-500" /> : <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  
  return (
    <div className="space-y-4">
      {period?.label && <Badge variant="outline">{period.label}</Badge>}
      {sections.map((s: any, i: number) => (
        <Card key={i}>
          <CardHeader className="py-2 px-3"><CardTitle className="text-sm">{s.heading}</CardTitle></CardHeader>
          <CardContent className="px-3 pb-3 space-y-2">
            {s.stats?.map((stat: any, j: number) => (
              <div key={j} className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{stat.label}</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">{stat.unit === "currency" ? `$${stat.value.toLocaleString()}` : stat.value}{stat.unit === "percent" ? "%" : ""}</span>
                  {stat.trend && trendIcon(stat.trend)}
                  {stat.delta_pct != null && <span className="text-xs text-muted-foreground">{stat.delta_pct > 0 ? "+" : ""}{stat.delta_pct}%</span>}
                </div>
              </div>
            ))}
            {s.narrative && <p className="text-xs text-muted-foreground mt-1">{s.narrative}</p>}
          </CardContent>
        </Card>
      ))}
      {highlights.length > 0 && (
        <div><p className="text-xs font-semibold text-muted-foreground mb-1">Highlights</p>{highlights.map((h: string, i: number) => <p key={i} className="text-xs flex items-start gap-1.5"><ChevronRight className="h-3 w-3 mt-0.5 text-primary shrink-0" />{h}</p>)}</div>
      )}
      {recommendations.length > 0 && (
        <div><p className="text-xs font-semibold text-muted-foreground mb-1">Recommendations</p>{recommendations.map((r: any, i: number) => <p key={i} className="text-xs flex items-start gap-1.5"><ChevronRight className="h-3 w-3 mt-0.5 text-yellow-500 shrink-0" />{typeof r === "string" ? r : r.text}</p>)}</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 3. KPI CARDS
// ═══════════════════════════════════════════════
function KpiCardsArtifact({ data }: { data: any }) {
  const { cards = [] } = data;
  const trendIcon = (t: string) => t === "up" ? <TrendingUp className="h-3 w-3 text-green-500" /> : t === "down" ? <TrendingDown className="h-3 w-3 text-red-500" /> : null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {cards.map((c: any, i: number) => (
        <Card key={i} className="p-3">
          <p className="text-xs text-muted-foreground">{c.label}</p>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <span className="text-lg font-bold">{c.unit === "currency" ? "$" : ""}{typeof c.value === "number" ? c.value.toLocaleString() : c.value}{c.unit === "percent" ? "%" : ""}</span>
            {c.trend && trendIcon(c.trend)}
            {c.delta_pct != null && <span className="text-xs text-muted-foreground">{c.delta_pct > 0 ? "+" : ""}{c.delta_pct}%</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 4. CHECKLIST
// ═══════════════════════════════════════════════

/** Stored ticks for one checklist, sized to the list as it is NOW. */
function readChecked(artifactKey: string | undefined, length: number): boolean[] {
  const empty = new Array(length).fill(false);
  if (!artifactKey) return empty;
  try {
    const raw = localStorage.getItem(artifactKey);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return empty;
    // A stored array from a shorter/longer version of the list is padded or
    // truncated rather than trusted wholesale — never carried across lists.
    return empty.map((_, i) => parsed[i] === true);
  } catch {
    return empty;
  }
}
function ChecklistArtifact({ data, artifactKey }: { data: any; artifactKey?: string }) {
  const { intro, items = [], convert_to_tasks } = data;

  /* Ticks used to be `useState(() => items.map(() => false))` and nothing else:
     seeded ONCE from whatever items were present on first render, never
     resynced, never stored. Two things followed. Close the panel and reopen it
     and every tick was gone — the one piece of state on this screen the user
     actually created. And because the array never resynced, a DIFFERENT
     checklist rendered into the same panel inherited the previous one's ticks,
     item for item, until its own length happened to differ.

     Keyed by content (see artifactStateKey) and mirrored to localStorage: the
     ticks survive close/reopen and reload, follow the checklist they belong
     to, and stay where they belong — with this reader, on this device. They
     are not a record; nothing else in the account reads them. */
  const [checked, setChecked] = useState<boolean[]>(() => readChecked(artifactKey, items.length));
  // Re-seed whenever the checklist itself changes identity or length.
  useEffect(() => {
    setChecked(readChecked(artifactKey, items.length));
  }, [artifactKey, items.length]);

  const setAt = (i: number) => {
    setChecked((prev) => {
      const next = prev.length === items.length ? [...prev] : new Array(items.length).fill(false);
      next[i] = !next[i];
      if (artifactKey) {
        try { localStorage.setItem(artifactKey, JSON.stringify(next)); } catch { /* private browsing */ }
      }
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {intro && <p className="text-sm text-muted-foreground">{intro}</p>}
      {items.map((item: any, i: number) => (
        <label key={i} className="flex items-start gap-2 cursor-pointer py-0.5">
          <Checkbox checked={!!checked[i]} onCheckedChange={() => setAt(i)} className="mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className={`text-sm ${checked[i] ? "line-through text-muted-foreground" : ""}`}>{item.text}</span>
            {item.due && <span className="text-xs text-muted-foreground ml-2">Due: {item.due}</span>}
          </div>
          {item.priority && <Badge variant={item.priority === "high" ? "destructive" : "outline"} className="text-xs shrink-0">{item.priority}</Badge>}
        </label>
      ))}
      {convert_to_tasks && (
        <p className="text-xs text-muted-foreground rounded-md border border-dashed px-2.5 py-2 mt-2" role="note" data-testid="artifact-checklist-preview-only">
          Task conversion is preview only. Create tasks from the Tasks page.
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 5. STRUCTURED PLAN
// ═══════════════════════════════════════════════
function StructuredPlanArtifact({ data }: { data: any }) {
  const { duration, overview, sections = [], actions = [] } = data;
  return (
    <div className="space-y-3">
      {overview && <p className="text-sm">{overview}</p>}
      {duration && <Badge variant="outline">{duration.value} {duration.unit}</Badge>}
      {sections.map((s: any, i: number) => (
        <div key={i}>
          <h4 className="text-sm font-semibold mb-1">{s.heading}</h4>
          <div className="space-y-1 ml-2">
            {(s.items || []).map((item: any, j: number) => (
              <div key={j} className="text-xs">
                <span className="font-medium">{item.title}</span>
                {item.detail && <span className="text-muted-foreground ml-1">— {item.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {actions.length > 0 && (
        <div className="space-y-1.5 mt-2" role="note" data-testid="artifact-plan-preview-only">
          <p className="text-xs text-muted-foreground">Suggested actions are preview only.</p>
          <div className="flex flex-wrap gap-2">
            {actions.map((a: any, i: number) => (
              <span key={i} className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground" aria-label={`${a.label} (preview only)`}>
                {a.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 6. CALCULATOR
// ═══════════════════════════════════════════════
function CalculatorArtifact({ data }: { data: any }) {
  const { inputs = [], outputs_schema = [], narrative } = data;
  return (
    <div className="space-y-3">
      {narrative && <p className="text-sm text-muted-foreground">{narrative}</p>}
      <p className="text-xs text-muted-foreground rounded-md border border-dashed px-2.5 py-2" role="note" data-testid="artifact-calculator-preview-only">
        Calculator preview only. Live calculations are not available here.
      </p>
      <div className="space-y-2">
        {inputs.map((inp: any) => (
          <div key={inp.key}>
            <Label className="text-xs">{inp.label}</Label>
            <Input
              type="number"
              value={inp.value ?? ""}
              readOnly
              disabled
              aria-label={`${inp.label} (preview only)`}
              className="h-8 text-sm"
            />
          </div>
        ))}
      </div>
      {outputs_schema.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {outputs_schema.map((out: any) => (
            <div key={out.key} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{out.label}</span>
              <span className="font-semibold text-muted-foreground">Not calculated</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 7. QUICK ENTRY FORM
// ═══════════════════════════════════════════════
function QuickEntryFormArtifact({ data }: { data: any }) {
  const { fields = [], submit_label = "Submit" } = data;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground rounded-md border border-dashed px-2.5 py-2" role="note" data-testid="artifact-form-preview-only">
        Form preview only. {submit_label} is not available here.
      </p>
      {fields.map((f: any) => (
        <div key={f.key}>
          <Label className="text-xs">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</Label>
          {f.type === "boolean" ? (
            <Checkbox checked={!!f.default} disabled aria-label={`${f.label} (preview only)`} />
          ) : f.type === "textarea" ? (
            <textarea defaultValue={f.default ?? ""} disabled aria-label={`${f.label} (preview only)`} className="w-full h-20 text-sm rounded-md border border-input bg-background px-3 py-2" />
          ) : (
            <Input type={f.type === "number" || f.type === "currency" ? "number" : f.type === "date" || f.type === "datetime" ? "date" : "text"} value={f.default ?? ""} readOnly disabled aria-label={`${f.label} (preview only)`} className="h-8 text-sm" />
          )}
        </div>
      ))}
    </div>
  );
}
