import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { X, BarChart3, FileText, CheckSquare, Calculator, LayoutGrid, ClipboardList, Zap, TrendingUp, TrendingDown, Minus, ChevronRight, Loader2, Check } from "lucide-react";
import { BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { invalidateDomains } from "@/lib/cache-bus";

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
  const [done, setDone] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();

  const createTasksMutation = useMutation({
    mutationFn: async () => {
      for (const item of items as any[]) {
        await apiRequest("POST", "/api/tasks", {
          title: item.text,
          status: "todo",
          priority: item.priority === "high" ? "high" : item.priority === "low" ? "low" : "medium",
          dueDate: item.due || null,
        });
      }
    },
    onSuccess: () => {
      setDone(true);
      toast({ title: `${items.length} task${items.length !== 1 ? "s" : ""} created` });
      void invalidateDomains("tasks", "dashboard");
    },
    onError: () => toast({ title: "Failed to create tasks", variant: "destructive" }),
  });

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
      {convert_to_tasks && (
        <Button
          variant={done ? "secondary" : "outline"}
          size="sm"
          className="mt-2 gap-1.5"
          onClick={() => !done && createTasksMutation.mutate()}
          disabled={createTasksMutation.isPending || done}
        >
          {createTasksMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : done ? <Check className="h-3.5 w-3.5" /> : null}
          {done ? "Tasks created" : "Create as Tasks"}
        </Button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 5. STRUCTURED PLAN
// ═══════════════════════════════════════════════

// Map planKind keywords to hash-navigation destinations
function planKindToHash(planKind: string = "", label: string = ""): string | null {
  const s = (planKind + " " + label).toLowerCase();
  if (s.match(/tracker|workout|exercise|fitness|health|water|sleep|weight/)) return "#/trackers";
  if (s.match(/budget|spend|expense|saving|finance|money|income/)) return "#/finance";
  if (s.match(/goal|milestone|objective/)) return "#/profiles";
  if (s.match(/task|todo|checklist|action|step/)) return "#/tasks";
  if (s.match(/habit|routine|daily|weekly/)) return "#/habits";
  if (s.match(/calendar|schedule|event|meeting|appointment/)) return "#/calendar";
  if (s.match(/document|note|document|report/)) return "#/editor";
  return null;
}

function StructuredPlanArtifact({ data }: { data: any }) {
  const { planKind, duration, overview, sections = [], actions = [] } = data;
  const { toast } = useToast();

  const handleAction = (a: any) => {
    // Support explicit href from AI
    if (a.href) {
      window.location.hash = a.href.startsWith("#") ? a.href.slice(1) : a.href;
      return;
    }
    if (a.navigate) {
      window.location.hash = a.navigate.startsWith("#") ? a.navigate.slice(1) : a.navigate;
      return;
    }
    // Infer destination from planKind / action label
    const dest = planKindToHash(planKind, a.label);
    if (dest) {
      window.location.hash = dest.slice(1); // strip leading #
      return;
    }
    toast({ title: a.label, description: "Open the relevant section in the sidebar to take this action." });
  };

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
        <div className="flex gap-2 mt-2 flex-wrap">
          {actions.map((a: any, i: number) => (
            <Button key={i} variant="outline" size="sm" onClick={() => handleAction(a)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 6. CALCULATOR — live computation from inputs
// ═══════════════════════════════════════════════

function fmt(v: number, unit?: string): string {
  if (!isFinite(v)) return "—";
  if (unit === "currency" || unit === "$") return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === "percent" || unit === "%") return `${v.toFixed(2)}%`;
  if (unit === "months") return `${Math.round(v)} mo`;
  if (unit === "years") return `${v.toFixed(1)} yr`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function computeOutputs(
  calcKind: string,
  vals: Record<string, number>,
  outputKeys: string[]
): Record<string, number> {
  const g = (keys: string[], fallback = 0) => {
    for (const k of keys) if (vals[k] != null && vals[k] !== 0) return vals[k];
    return fallback;
  };

  const kind = (calcKind || "").toLowerCase();

  if (kind.match(/mortgage|loan|amort/)) {
    const P = g(["principal","loan_amount","amount","home_price"], 0);
    const annualR = g(["rate","interest_rate","annual_rate"], 0);
    const years = g(["years","term_years","loan_term"], 30);
    const months = g(["months","term_months"], years * 12);
    const r = annualR / 100 / 12;
    const n = months || years * 12;
    const pmt = r === 0
      ? (n > 0 ? P / n : 0)
      : P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
    const total = pmt * n;
    return { monthly_payment: pmt, total_payment: total, total_interest: total - P, payoff_months: n };
  }

  if (kind.match(/roi|return/)) {
    const gain = g(["gain","profit","net_gain"]) || (g(["current_value","exit_value"]) - g(["initial_investment","cost","investment"]));
    const cost = g(["cost","initial_investment","investment","initial_value"], 1);
    const years = g(["years","holding_period"], 1);
    const roi = cost > 0 ? (gain / cost) * 100 : 0;
    return { roi, annualized_roi: years > 0 ? roi / years : roi, net_profit: gain };
  }

  if (kind.match(/compound|savings|future|growth/)) {
    const P = g(["principal","initial_deposit","amount","starting_balance"], 0);
    const r = g(["rate","annual_rate","interest_rate"], 0) / 100;
    const years = g(["years","term"], 10);
    const n = g(["compounding","n"], 12);
    const monthly = g(["monthly_contribution","monthly_deposit","contribution"], 0);
    const fvLump = P * Math.pow(1 + r / n, n * years);
    const rn = r / n;
    const fvPeriodic = monthly > 0 && rn > 0
      ? monthly * (Math.pow(1 + rn, n * years) - 1) / rn
      : monthly * n * years;
    const fv = fvLump + fvPeriodic;
    const totalContrib = P + monthly * 12 * years;
    return { future_value: fv, total_interest: fv - totalContrib, total_contributions: totalContrib };
  }

  if (kind.match(/budget|cashflow|cash.?flow/)) {
    const income = g(["income","monthly_income","net_income"], 0);
    const expenses = g(["expenses","monthly_expenses","total_expenses"], 0);
    const savings = income - expenses;
    return {
      monthly_savings: savings,
      savings_rate: income > 0 ? (savings / income) * 100 : 0,
      annual_savings: savings * 12,
    };
  }

  if (kind.match(/retire|fire/)) {
    const expenses = g(["monthly_expenses","annual_expenses"]) || g(["monthly_expenses"]) * 12;
    const annualExp = expenses > 10000 ? expenses : expenses * 12;
    const savings = g(["current_savings","portfolio","net_worth"], 0);
    const monthlyContrib = g(["monthly_contribution","monthly_savings"], 0);
    const r = g(["expected_return","annual_return","rate"], 7) / 100;
    const target = annualExp * 25; // 4% rule
    const gap = Math.max(0, target - savings);
    const months = r > 0 && monthlyContrib > 0
      ? Math.log(1 + gap * (r / 12) / monthlyContrib) / Math.log(1 + r / 12)
      : gap / (monthlyContrib || 1);
    return { fire_number: target, years_to_fire: months / 12, monthly_gap: gap / Math.max(months, 1) };
  }

  if (kind.match(/break.?even/)) {
    const fixed = g(["fixed_costs","fixed_cost"], 0);
    const price = g(["price","selling_price","revenue_per_unit"], 1);
    const variable = g(["variable_cost","variable_cost_per_unit","cost_per_unit"], 0);
    const margin = price - variable;
    const units = margin > 0 ? fixed / margin : 0;
    return { breakeven_units: units, breakeven_revenue: units * price, contribution_margin: margin };
  }

  if (kind.match(/tip/)) {
    const bill = g(["bill","subtotal","amount"], 0);
    const tipPct = g(["tip_percent","tip","gratuity"], 18);
    const people = g(["people","guests","split"], 1);
    const tipAmt = bill * tipPct / 100;
    const total = bill + tipAmt;
    return { tip_amount: tipAmt, total: total, per_person: people > 0 ? total / people : total };
  }

  // Generic fallback — any output key that matches an arithmetic expression
  return {};
}

function CalculatorArtifact({ data }: { data: any }) {
  const { calcKind, inputs = [], outputs_schema = [], narrative } = data;
  const [values, setValues] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    inputs.forEach((i: any) => { if (i.value != null) init[i.key] = Number(i.value); });
    return init;
  });

  const computed = useMemo(
    () => computeOutputs(calcKind, values, outputs_schema.map((o: any) => o.key)),
    [calcKind, values, outputs_schema]
  );

  return (
    <div className="space-y-3">
      {narrative && <p className="text-sm text-muted-foreground">{narrative}</p>}
      <div className="space-y-2">
        {inputs.map((inp: any) => (
          <div key={inp.key}>
            <Label className="text-xs">{inp.label}{inp.unit ? ` (${inp.unit})` : ""}</Label>
            <Input
              type="number"
              value={values[inp.key] ?? ""}
              onChange={e => setValues(prev => ({ ...prev, [inp.key]: parseFloat(e.target.value) || 0 }))}
              disabled={inp.editable === false}
              className="h-8 text-sm"
              placeholder={inp.placeholder || String(inp.value ?? "")}
            />
          </div>
        ))}
      </div>
      {outputs_schema.length > 0 && (
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Results</p>
          {outputs_schema.map((out: any) => {
            const raw = computed[out.key];
            const display = raw != null ? fmt(raw, out.unit) : "—";
            return (
              <div key={out.key} className="flex justify-between items-baseline">
                <span className="text-sm text-muted-foreground">{out.label}</span>
                <span className={`text-sm font-semibold tabular-nums ${display === "—" ? "text-muted-foreground" : ""}`}>
                  {display}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════
// 7. QUICK ENTRY FORM — routes to correct API
// ═══════════════════════════════════════════════

type SubmitResult = "idle" | "pending" | "success" | "error";

async function submitQuickEntry(target: any, values: Record<string, any>): Promise<void> {
  const kind: string = (target?.kind || "").toLowerCase();
  const ref: string = target?.ref || "";

  const toNum = (v: any) => v !== "" && v != null ? Number(v) : undefined;
  const toStr = (v: any) => v != null ? String(v) : undefined;

  if (kind === "expense") {
    await apiRequest("POST", "/api/expenses", {
      description: toStr(values.description || values.title || values.name) || "Expense",
      amount: toNum(values.amount),
      date: values.date || new Date().toISOString().slice(0, 10),
      category: values.category || "general",
      ...values,
    });
    await invalidateDomains("expenses", "dashboard");
    return;
  }

  if (kind === "task") {
    await apiRequest("POST", "/api/tasks", {
      title: toStr(values.title || values.task || values.name) || "Task",
      status: "todo",
      priority: values.priority || "medium",
      dueDate: values.dueDate || values.due_date || null,
      ...values,
    });
    await invalidateDomains("tasks", "dashboard");
    return;
  }

  if (kind === "tracker_entry" || kind === "log_entry") {
    if (!ref) throw new Error("Tracker ID required for tracker_entry");
    await apiRequest("POST", `/api/trackers/${ref}/entries`, { values });
    await invalidateDomains("trackers", "dashboard");
    return;
  }

  if (kind === "habit_checkin") {
    const id = ref || values.id;
    if (!id) throw new Error("Habit ID required");
    await apiRequest("POST", `/api/habits/${id}/checkins`, { date: values.date || new Date().toISOString().slice(0, 10) });
    await invalidateDomains("habits", "dashboard");
    return;
  }

  if (kind === "journal" || kind === "journal_entry") {
    await apiRequest("POST", "/api/journal", {
      content: toStr(values.content || values.text || values.entry) || "",
      mood: values.mood,
      date: values.date || new Date().toISOString().slice(0, 10),
    });
    await invalidateDomains("journal", "dashboard");
    return;
  }

  if (kind === "event" || kind === "calendar_event") {
    await apiRequest("POST", "/api/events", {
      title: toStr(values.title || values.name) || "Event",
      date: values.date || new Date().toISOString().slice(0, 10),
      allDay: values.allDay ?? true,
      ...values,
    });
    await invalidateDomains("events", "dashboard");
    return;
  }

  if (kind === "income") {
    await apiRequest("POST", "/api/paychecks", {
      source: toStr(values.source || values.employer || values.name) || "Income",
      amount: toNum(values.amount),
      date: values.date || new Date().toISOString().slice(0, 10),
      ...values,
    });
    await invalidateDomains("incomes", "dashboard");
    return;
  }

  // Generic fallback: PATCH the ref'd profile's fields
  if (ref) {
    await apiRequest("PATCH", `/api/profiles/${ref}`, { fields: values });
    await invalidateDomains("profiles", "dashboard");
    return;
  }

  throw new Error(`Unknown form target kind: "${kind}". Please describe what you want to save.`);
}

function QuickEntryFormArtifact({ data }: { data: any }) {
  const { target, fields = [], submit_label = "Submit" } = data;
  const [values, setValues] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    fields.forEach((f: any) => { if (f.default != null) init[f.key] = f.default; });
    return init;
  });
  const [status, setStatus] = useState<SubmitResult>("idle");
  const { toast } = useToast();

  const handleSubmit = async () => {
    // Validate required fields
    const missing = (fields as any[]).filter(f => f.required && !values[f.key] && values[f.key] !== 0);
    if (missing.length) {
      toast({ title: `Please fill in: ${missing.map((f: any) => f.label).join(", ")}`, variant: "destructive" });
      return;
    }
    setStatus("pending");
    try {
      await submitQuickEntry(target, values);
      setStatus("success");
      toast({ title: "Saved" });
      // Reset form after success
      setTimeout(() => setStatus("idle"), 3000);
    } catch (err: any) {
      setStatus("error");
      toast({ title: "Save failed", description: err?.message || "Unknown error", variant: "destructive" });
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <div className="space-y-3">
      {fields.map((f: any) => (
        <div key={f.key}>
          <Label className="text-xs">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</Label>
          {f.type === "boolean" ? (
            <Checkbox checked={!!values[f.key]} onCheckedChange={v => setValues(prev => ({ ...prev, [f.key]: v }))} />
          ) : f.type === "textarea" ? (
            <textarea
              value={values[f.key] || ""}
              onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value }))}
              className="w-full h-20 text-sm rounded-md border border-input bg-background px-3 py-2 resize-none"
            />
          ) : f.type === "select" && Array.isArray(f.options) ? (
            <select
              value={values[f.key] || ""}
              onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value }))}
              className="w-full h-8 text-sm rounded-md border border-input bg-background px-2"
            >
              <option value="">Select…</option>
              {f.options.map((opt: any) => (
                <option key={opt.value ?? opt} value={opt.value ?? opt}>{opt.label ?? opt}</option>
              ))}
            </select>
          ) : (
            <Input
              type={
                f.type === "number" || f.type === "currency" ? "number" :
                f.type === "date" || f.type === "datetime" ? "date" : "text"
              }
              value={values[f.key] ?? ""}
              onChange={e => setValues(prev => ({ ...prev, [f.key]: e.target.value }))}
              className="h-8 text-sm"
              placeholder={f.placeholder || ""}
            />
          )}
        </div>
      ))}
      <Button
        size="sm"
        onClick={handleSubmit}
        disabled={status === "pending" || status === "success"}
        className="gap-1.5"
      >
        {status === "pending" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {status === "success" && <Check className="h-3.5 w-3.5" />}
        {status === "success" ? "Saved!" : status === "error" ? "Retry" : submit_label}
      </Button>
    </div>
  );
}
