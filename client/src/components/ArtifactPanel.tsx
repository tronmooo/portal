import { useState, useEffect, useRef, useMemo } from "react";
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
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 shrink-0">
          <X className="h-4 w-4" />
        </Button>
      </div>
      
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <ArtifactRenderer type={artifact.type} data={artifact.data} />
      </div>
    </div>
  );
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
function ArtifactRenderer({ type, data }: { type: string; data: any }) {
  switch (type) {
    case "chart": return <ChartArtifact data={data} />;
    case "summary_report": return <SummaryReportArtifact data={data} />;
    case "kpi_cards": return <KpiCardsArtifact data={data} />;
    case "checklist": return <ChecklistArtifact data={data} />;
    case "structured_plan": return <StructuredPlanArtifact data={data} />;
    case "calculator": return <CalculatorArtifact data={data} />;
    case "quick_entry_form": return <QuickEntryFormArtifact data={data} />;
    default: return <div className="text-sm text-muted-foreground">Unknown artifact type: {type}</div>;
  }
}

// ═══════════════════════════════════════════════
// 1. CHART
// ═══════════════════════════════════════════════
function ChartArtifact({ data }: { data: any }) {
  const { chartType = "bar", series = [], source, annotations = [], insight } = data;
  
  // Fetch data from source if available
  const { data: chartData = [] } = useQuery({
    queryKey: ["/api/trackers", source?.ref],
    enabled: !!source?.ref,
  });
  
  // Use inline data if source doesn't provide
  const displayData = useMemo(() => {
    if (chartData && Array.isArray(chartData) && chartData.length > 0) return chartData;
    if (data.data && Array.isArray(data.data)) return data.data;
    return [];
  }, [chartData, data.data]);
  
  if (displayData.length === 0) return <div className="text-muted-foreground text-sm">No data available for chart</div>;
  
  const primaryKey = series[0]?.key || "value";
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
              <Line key={i} type="monotone" dataKey={s.key} stroke={COLORS[s.color as keyof typeof COLORS] || COLORS.primary} strokeWidth={2} dot={{ r: 3 }} />
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
function ChecklistArtifact({ data }: { data: any }) {
  const { intro, items = [], convert_to_tasks } = data;
  const [checked, setChecked] = useState<boolean[]>(() => items.map(() => false));
  return (
    <div className="space-y-2">
      {intro && <p className="text-sm text-muted-foreground">{intro}</p>}
      {items.map((item: any, i: number) => (
        <label key={i} className="flex items-start gap-2 cursor-pointer py-0.5">
          <Checkbox checked={checked[i]} onCheckedChange={() => { const next = [...checked]; next[i] = !next[i]; setChecked(next); }} className="mt-0.5" />
          <div className="flex-1 min-w-0">
            <span className={`text-sm ${checked[i] ? "line-through text-muted-foreground" : ""}`}>{item.text}</span>
            {item.due && <span className="text-xs text-muted-foreground ml-2">Due: {item.due}</span>}
          </div>
          {item.priority && <Badge variant={item.priority === "high" ? "destructive" : "outline"} className="text-xs shrink-0">{item.priority}</Badge>}
        </label>
      ))}
      {convert_to_tasks && <Button variant="outline" size="sm" className="mt-2">Create as Tasks</Button>}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 5. STRUCTURED PLAN
// ═══════════════════════════════════════════════
function StructuredPlanArtifact({ data }: { data: any }) {
  const { planKind, duration, overview, sections = [], actions = [] } = data;
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
        <div className="flex gap-2 mt-2">{actions.map((a: any, i: number) => <Button key={i} variant="outline" size="sm">{a.label}</Button>)}</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 6. CALCULATOR
// ═══════════════════════════════════════════════
function CalculatorArtifact({ data }: { data: any }) {
  const { calcKind, inputs = [], outputs_schema = [], narrative } = data;
  const [values, setValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    inputs.forEach((i: any) => { if (i.value != null) init[i.key] = i.value; });
    return init;
  });
  return (
    <div className="space-y-3">
      {narrative && <p className="text-sm text-muted-foreground">{narrative}</p>}
      <div className="space-y-2">
        {inputs.map((inp: any) => (
          <div key={inp.key}>
            <Label className="text-xs">{inp.label}</Label>
            <Input type="number" value={values[inp.key] || ""} onChange={e => setValues({ ...values, [inp.key]: parseFloat(e.target.value) || 0 })} disabled={!inp.editable} className="h-8 text-sm" />
          </div>
        ))}
      </div>
      {outputs_schema.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {outputs_schema.map((out: any) => (
            <div key={out.key} className="flex justify-between text-sm">
              <span className="text-muted-foreground">{out.label}</span>
              <span className="font-semibold">—</span>
            </div>
          ))}
          <p className="text-xs text-muted-foreground italic">Calculation runs client-side when inputs change</p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 7. QUICK ENTRY FORM
// ═══════════════════════════════════════════════
function QuickEntryFormArtifact({ data }: { data: any }) {
  const { target, fields = [], submit_label = "Submit" } = data;
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    fields.forEach((f: any) => { if (f.default != null) init[f.key] = f.default; });
    return init;
  });
  return (
    <div className="space-y-3">
      {fields.map((f: any) => (
        <div key={f.key}>
          <Label className="text-xs">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</Label>
          {f.type === "boolean" ? (
            <Checkbox checked={!!values[f.key]} onCheckedChange={v => setValues({ ...values, [f.key]: v })} />
          ) : f.type === "textarea" ? (
            <textarea value={values[f.key] || ""} onChange={e => setValues({ ...values, [f.key]: e.target.value })} className="w-full h-20 text-sm rounded-md border border-input bg-background px-3 py-2" />
          ) : (
            <Input type={f.type === "number" || f.type === "currency" ? "number" : f.type === "date" || f.type === "datetime" ? "date" : "text"} value={values[f.key] || ""} onChange={e => setValues({ ...values, [f.key]: e.target.value })} className="h-8 text-sm" />
          )}
        </div>
      ))}
      <Button size="sm">{submit_label}</Button>
    </div>
  );
}
