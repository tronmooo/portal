import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { stopProp } from "@/lib/event-utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Send,
  Activity,
  User,
  ListTodo,
  DollarSign,
  CalendarDays,
  Sparkles,
  Bot,
  Paperclip,
  FileText,
  X,
  Plus,
  Loader2,
  Check,
  Calendar,
  Camera,
  Target,
  Flame,
  BookOpen,
  RotateCcw,
  Pencil,
  Moon,
  Heart,
  BarChart2,
  CheckCircle,
  PiggyBank,
  Brain,
  ChevronUp,
  ChevronDown,
  Table as TableIcon,
  FileBarChart,
  Mic,
  Search,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import type { ChatMessage, ParsedAction, Profile } from "@shared/schema";
import DocumentViewer, { ShareButton } from "@/components/DocumentViewer";
import {
  PieChart, Pie, Cell,
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// Chart types (inline — schema was reverted)
type ChartType2 = "line"|"bar"|"area"|"pie"|"scatter"|"composed"|"radar";
interface ChartSeries2 { dataKey:string; name:string; color?:string; type?:"line"|"bar"|"area"; stackId?:string; }
interface ChartSpec2 { type:ChartType2; title:string; subtitle?:string; data:Array<Record<string,any>>; series:ChartSeries2[]; xAxisKey:string; xAxisLabel?:string; yAxisLabel?:string; showLegend?:boolean; showGrid?:boolean; height?:number; nameKey?:string; valueKey?:string; }
interface TableColumn2 { key:string; label:string; align?:"left"|"center"|"right"; format?:"currency"|"date"|"number"|"percent"|"text"; }
interface TableSpec2 { title:string; subtitle?:string; columns:TableColumn2[]; rows:Array<Record<string,any>>; summary?:Record<string,any>; }
interface ReportMetric2 { label:string; value:string|number; change?:string; changeType?:"positive"|"negative"|"neutral"; }
interface ReportSection2 { heading:string; content?:string; chart?:ChartSpec2; table?:TableSpec2; metrics?:ReportMetric2[]; }
interface ReportSpec2 { title:string; subtitle?:string; sections:ReportSection2[]; generatedAt:string; }

// ─── Rich Visual Components ────────────────────────────────────────────────────────────────────────
const CHART_PALETTE = ["hsl(188 55% 50%)","#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16"];

function fmtVal(v:any, fmt?:string): string {
  if (v===null||v===undefined||v==="") return "\u2014";
  switch(fmt) {
    case "currency": return typeof v==="number"?`$${v.toFixed(2)}`:`$${v}`;
    case "percent": return `${v}%`;
    case "date": try { return new Date(v).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); } catch { return String(v); }
    case "number": return typeof v==="number"?v.toLocaleString():String(v);
    default: return String(v);
  }
}

function ChatChart({ spec }: { spec: ChartSpec2 }) {
  const [open, setOpen] = useState(true);
  const h = spec.height || 260;
  const tts = { backgroundColor:"hsl(var(--card))", border:"1px solid hsl(var(--border))", borderRadius:8, color:"hsl(var(--foreground))", fontSize:12 };
  
  function renderChart() {
    if (spec.type==="pie") {
      return (
        <PieChart>
          <Pie data={spec.data} dataKey={spec.valueKey||"amount"} nameKey={spec.nameKey||"category"} cx="50%" cy="50%" outerRadius="75%" label={({name,percent}:{name:string;percent:number})=>percent>0.04?`${name} ${(percent*100).toFixed(0)}%`:""} labelLine={false}>
            {spec.data.map((e,i)=><Cell key={i} fill={e.fill||CHART_PALETTE[i%CHART_PALETTE.length]}/>)}
          </Pie>
          <Tooltip contentStyle={tts} formatter={(v:any)=>[typeof v==="number"?`$${Number(v).toFixed(2)}`:v,""]}/>
          {spec.showLegend!==false&&<Legend/>}
        </PieChart>
      );
    }
    if (spec.type==="radar") {
      return (
        <RadarChart data={spec.data} cx="50%" cy="50%" outerRadius="70%">
          <PolarGrid stroke="hsl(var(--border))"/>
          <PolarAngleAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>
          {spec.series.map((s,i)=><Radar key={i} name={s.name} dataKey={s.dataKey} stroke={s.color||CHART_PALETTE[i]} fill={s.color||CHART_PALETTE[i]} fillOpacity={0.25}/>)}
          <Tooltip contentStyle={tts}/>
        </RadarChart>
      );
    }
    if (spec.type==="bar") {
      return (
        <BarChart data={spec.data} barCategoryGap="30%">
          {spec.showGrid!==false&&<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false}/>}
          <XAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}} interval="preserveStartEnd" allowDuplicatedCategory={false}/>
          <YAxis tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>
          <Tooltip contentStyle={tts}/>
          {spec.series.map((s,i)=><Bar key={i} dataKey={s.dataKey} name={s.name} fill={s.color||CHART_PALETTE[i]} radius={[3,3,0,0] as any}/>)}
          {spec.showLegend&&<Legend/>}
        </BarChart>
      );
    }
    if (spec.type==="area") {
      return (
        <AreaChart data={spec.data}>
          {spec.showGrid!==false&&<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/>}
          <XAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}} interval="preserveStartEnd" allowDuplicatedCategory={false}/>
          <YAxis tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>
          <Tooltip contentStyle={tts}/>
          {spec.series.map((s,i)=><Area key={i} type="monotone" dataKey={s.dataKey} name={s.name} stroke={s.color||CHART_PALETTE[i]} fill={s.color||CHART_PALETTE[i]} fillOpacity={0.15} strokeWidth={2}/>)}
          {spec.showLegend&&<Legend/>}
        </AreaChart>
      );
    }
    // Default: line
    return (
      <LineChart data={spec.data}>
        {spec.showGrid!==false&&<CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))"/>}
        <XAxis dataKey={spec.xAxisKey} tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}} interval="preserveStartEnd" allowDuplicatedCategory={false}/>
        <YAxis tick={{fontSize:11,fill:"hsl(var(--muted-foreground))"}}/>
        <Tooltip contentStyle={tts}/>
        {spec.series.map((s,i)=><Line key={i} type="monotone" dataKey={s.dataKey} name={s.name} stroke={s.color||CHART_PALETTE[i]} strokeWidth={2.5} dot={{r:3}} activeDot={{r:5}}/>)}
        {spec.showLegend&&<Legend/>}
      </LineChart>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/30" onClick={()=>setOpen(o=>!o)}>
        <div className="flex items-center gap-2">
          <BarChart2 className="h-3.5 w-3.5 text-primary"/>
          <span className="text-xs font-semibold">{spec.title}</span>
          {spec.subtitle&&<span className="text-xs text-muted-foreground hidden sm:inline">\u2014 {spec.subtitle}</span>}
        </div>
        {open?<ChevronUp className="h-3.5 w-3.5 text-muted-foreground"/>:<ChevronDown className="h-3.5 w-3.5 text-muted-foreground"/>}
      </div>
      {open&&(
        <div className="px-2 pb-3">
          <ResponsiveContainer width="100%" height={h}>{renderChart()}</ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function ChatTable({ spec }: { spec: TableSpec2 }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3 rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/30" onClick={()=>setOpen(o=>!o)}>
        <div className="flex items-center gap-2">
          <TableIcon className="h-3.5 w-3.5 text-primary"/>
          <span className="text-xs font-semibold">{spec.title}</span>
          <span className="text-xs text-muted-foreground">({spec.rows.length} rows)</span>
        </div>
        {open?<ChevronUp className="h-3.5 w-3.5 text-muted-foreground"/>:<ChevronDown className="h-3.5 w-3.5 text-muted-foreground"/>}
      </div>
      {open&&(
        <div className="overflow-x-auto max-h-72">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/70">
              <tr>{spec.columns.map(c=><th key={c.key} className={`px-3 py-2 font-semibold text-muted-foreground border-b border-border whitespace-nowrap ${c.align==="right"?"text-right":c.align==="center"?"text-center":"text-left"}`}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {spec.rows.map((row,ri)=>(
                <tr key={ri} className="border-b border-border/30 hover:bg-muted/10">
                  {spec.columns.map(c=><td key={c.key} className={`px-3 py-1.5 ${c.align==="right"?"text-right":c.align==="center"?"text-center":"text-left"} ${c.format==="currency"?"font-mono":""}`}>{fmtVal(row[c.key],c.format)}</td>)}
                </tr>
              ))}
              {spec.summary&&(
                <tr className="border-t-2 border-border bg-muted/20 font-semibold">
                  {spec.columns.map(c=><td key={c.key} className={`px-3 py-2 ${c.align==="right"?"text-right":c.align==="center"?"text-center":"text-left"}`}>{spec.summary![c.key]!==undefined?fmtVal(spec.summary![c.key],c.format):""}</td>)}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChatReport({ spec }: { spec: ReportSpec2 }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<number,boolean>>({});
  return (
    <div className="mt-3 rounded-xl border border-border bg-card/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-muted/30 bg-muted/10" onClick={()=>setOpen(o=>!o)}>
        <div className="flex items-center gap-2">
          <FileBarChart className="h-3.5 w-3.5 text-primary"/>
          <span className="text-xs font-bold">{spec.title}</span>
        </div>
        {open?<ChevronUp className="h-3.5 w-3.5 text-muted-foreground"/>:<ChevronDown className="h-3.5 w-3.5 text-muted-foreground"/>}
      </div>
      {open&&(
        <div className="divide-y divide-border/40">
          {spec.sections.map((sec,si)=>(
            <div key={si}>
              <div className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/10" onClick={()=>setExpanded(p=>({...p,[si]:!p[si]}))}>
                <span className="text-xs font-semibold">{sec.heading}</span>
                {expanded[si]===false?<ChevronDown className="h-3 w-3 text-muted-foreground"/>:<ChevronUp className="h-3 w-3 text-muted-foreground"/>}
              </div>
              {expanded[si]!==false&&(
                <div className="px-3 pb-3 space-y-2">
                  {sec.metrics&&sec.metrics.length>0&&(
                    <div className="grid grid-cols-2 gap-2">
                      {sec.metrics.map((m,mi)=>(
                        <div key={mi} className={`rounded-lg px-3 py-2 border ${m.changeType==="positive"?"border-green-500/20 bg-green-500/5":m.changeType==="negative"?"border-red-500/20 bg-red-500/5":"border-border bg-muted/30"}`}>
                          <div className="text-xs text-muted-foreground">{m.label}</div>
                          <div className={`text-sm font-bold ${m.changeType==="positive"?"text-green-500":m.changeType==="negative"?"text-red-400":""}`}>{m.value}</div>
                          {m.change&&<div className="text-xs text-muted-foreground mt-0.5">{m.change}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {sec.content&&<p className="text-xs text-foreground/80 leading-relaxed">{sec.content}</p>}
                  {sec.chart&&<ChatChart spec={sec.chart}/>}
                  {sec.table&&<ChatTable spec={sec.table}/>}
                </div>
              )}
            </div>
          ))}
          <div className="px-3 py-1.5">
            <span className="text-xs text-muted-foreground/50">Generated {new Date(spec.generatedAt).toLocaleString("en-US",{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "I ate a chicken sandwich and ran 2 miles",
  "Track my blood pressure",
  "Spent $50 on groceries",
  "Add my cat Luna",
  "Remind me to call the dentist by Friday",
  "What's my weight trend?",
  "Open my drivers license",
  "Log sleep: 7.5 hours",
];

const PROFILE_TYPE_COLORS: Record<string, string> = {
  person: "bg-primary/10 text-primary",
  self: "bg-primary/10 text-primary",
  pet: "bg-chart-3/10 text-chart-3",
  vehicle: "bg-chart-2/10 text-chart-2",
  asset: "bg-chart-4/10 text-chart-4",
  loan: "bg-destructive/10 text-destructive",
  investment: "bg-chart-3/10 text-chart-3",
  subscription: "bg-chart-5/10 text-chart-5",
  medical: "bg-destructive/10 text-destructive",
  account: "bg-chart-1/10 text-chart-1",
  property: "bg-chart-1/10 text-chart-1",
};

function ProfileTypeBadge({ type }: { type: string }) {
  const colorClass = PROFILE_TYPE_COLORS[type] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colorClass}`}>
      {type}
    </span>
  );
}


function actionIcon(type: string) {
  switch (type) {
    case "create_tracker":
    case "log_entry":
    case "delete_tracker_entry":
    case "update_tracker_entry":
      return <Activity className="h-3 w-3" />;
    case "create_profile":
    case "update_profile":
      return <User className="h-3 w-3" />;
    case "create_task":
    case "complete_task":
    case "delete_task":
      return <ListTodo className="h-3 w-3" />;
    case "log_expense":
      return <DollarSign className="h-3 w-3" />;
    case "create_event":
    case "complete_event":
      return <CalendarDays className="h-3 w-3" />;
    case "create_goal":
      return <Target className="h-3 w-3" />;
    case "create_habit":
    case "checkin_habit":
    case "uncomplete_habit":
    case "delete_habit":
      return <Flame className="h-3 w-3" />;
    case "journal_entry":
      return <BookOpen className="h-3 w-3" />;
    case "create_obligation":
    case "pay_obligation":
      return <DollarSign className="h-3 w-3" />;
    case "create_artifact":
      return <FileText className="h-3 w-3" />;
    default:
      return <Sparkles className="h-3 w-3" />;
  }
}

const ACTION_LABELS: Record<string, string> = {
  create_task: "Create Task",
  complete_task: "Complete Task",
  delete_task: "Delete Task",
  create_habit: "Create Habit",
  checkin_habit: "Checkin Habit",
  uncomplete_habit: "Undo Habit",
  delete_habit: "Delete Habit",
  create_goal: "Create Goal",
  create_event: "Create Event",
  complete_event: "Complete Event",
  log_entry: "Log Entry",
  create_tracker: "Create Tracker",
  delete_tracker_entry: "Delete Entry",
  update_tracker_entry: "Update Entry",
  journal_entry: "Journal Entry",
  log_expense: "Log Expense",
  create_profile: "Create Profile",
  update_profile: "Update Profile",
  create_obligation: "Add Bill",
  pay_obligation: "Pay Bill",
  save_memory: "Remember",
  retrieve: "Retrieve",
  create_artifact: "Create Artifact",
};

function actionLabel(type: string) {
  return ACTION_LABELS[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Inline artifact preview in chat messages ─────────────────────────────────
function ArtifactPreview({ data }: { data: any }) {
  if (!data) return null;
  const { type, content, items, language } = data;

  // Checklist items (structured)
  if (type === "checklist" && items?.length > 0) {
    return (
      <div className="space-y-1">
        {items.slice(0, 5).map((item: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="rounded" readOnly defaultChecked={item.checked} />
            <span>{item.text}</span>
          </div>
        ))}
        {items.length > 5 && <span className="text-xs text-muted-foreground">+{items.length - 5} more...</span>}
      </div>
    );
  }

  if (type === "code" && content) {
    return (
      <pre className="text-xs font-mono bg-zinc-900 text-zinc-300 p-2 rounded overflow-hidden whitespace-pre-wrap">
        <code>{content.slice(0, 500)}</code>
      </pre>
    );
  }

  if (type === "markdown" && content) {
    return <div className="text-xs text-muted-foreground whitespace-pre-wrap">{content.slice(0, 300)}</div>;
  }

  // Default: show text content preview
  if (content) {
    return <div className="text-xs text-muted-foreground whitespace-pre-wrap">{content.slice(0, 300)}</div>;
  }

  return <div className="text-xs text-muted-foreground italic">No preview available</div>;
}

// ── Inline document previews in chat messages ─────────────────────────────────
function LazyDocumentPreview({ id, name, mimeType, data }: { id: string; name: string; mimeType: string; data: string }) {
  const [imageData, setImageData] = useState<string>(data === "__LAZY_LOAD__" ? "" : data);
  const [loading, setLoading] = useState(data === "__LAZY_LOAD__");

  useEffect(() => {
    if (data === "__LAZY_LOAD__" && !imageData) {
      apiRequest("GET", `/api/documents/${id}`)
        .then(res => res.json())
        .then(doc => {
          if (doc.fileData) setImageData(doc.fileData);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [id, data]);

  if (loading) {
    return (
      <div className="mt-3 rounded-xl border border-border bg-muted/10 p-8 flex items-center justify-center">
        <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
        <span className="ml-2 text-xs text-muted-foreground">Loading {name}...</span>
      </div>
    );
  }

  if (!imageData) return null;

  return <DocumentViewer id={id} name={name} mimeType={mimeType} data={imageData} inline />;
}

function ChatDocumentPreviews({
  documentPreview,
  documentPreviews,
}: {
  documentPreview?: ChatMessage["documentPreview"];
  documentPreviews?: ChatMessage["documentPreviews"];
}) {
  const allPreviews: Array<{ id: string; name: string; mimeType: string; data: string }> = [];
  const seen = new Set<string>();

  if (documentPreviews && documentPreviews.length > 0) {
    for (const p of documentPreviews) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        allPreviews.push(p);
      }
    }
  } else if (documentPreview) {
    allPreviews.push(documentPreview);
  }

  if (allPreviews.length === 0) return null;

  return (
    <div className="space-y-2">
      {allPreviews.map((doc) => (
        <LazyDocumentPreview key={doc.id} id={doc.id} name={doc.name} mimeType={doc.mimeType} data={doc.data} />
      ))}
    </div>
  );
}

// ── Extraction Confirmation UI (two-phase extraction) ───────────────────────
function ExtractionConfirmation({
  extraction,
  onConfirm,
  onSkip,
}: {
  extraction: NonNullable<ChatMessage["pendingExtraction"]>;
  onConfirm: (data: {
    extractionId: string;
    confirmedFields: Array<{ key: string; value: any }>;
    targetProfileId?: string;
    createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
    trackerEntries: any[];
    createExpense?: any;
    createObligation?: any;
  }) => Promise<boolean>;
  onSkip: () => void;
}) {
  const [fields, setFields] = useState(
    () => extraction.extractedFields.map((f) => ({ ...f }))
  );
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Track which tracker entries the user wants to create (all selected by default)
  const [selectedTrackers, setSelectedTrackers] = useState<boolean[]>(
    () => (extraction.trackerEntries || []).map(() => true)
  );
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(extraction.targetProfile?.id);
  const [createExpense, setCreateExpense] = useState(!!extraction.pendingFinancial?.expense);
  const [createObligation, setCreateObligation] = useState(!!extraction.pendingFinancial?.obligation);

  // Fetch profiles for the dropdown
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
  });

  const toggleField = (idx: number) => {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, selected: !f.selected } : f));
  };

  const handleConfirm = async () => {
    setConfirming(true);
    // Include ALL selected fields (date fields now save to profile AND optionally create calendar events)
    const confirmedFields = fields.filter((f) => f.selected && f.key).map((f) => {
      const key = f.key === 'dob' ? 'dateOfBirth' : f.key;
      return { key, value: f.value };
    });
    const createCalendarEvents = fields
      .filter((f) => f.selected && f.isDate && f.suggestedEvent && f.key && f.value)
      .map((f) => ({
        field: f.key,
        date: String(f.value),
        title: f.suggestedEvent!,
        category: /expir|renew/i.test(f.key || "") ? "finance" : /appoint|visit/i.test(f.key || "") ? "health" : "other",
      }));
    const success = await onConfirm({
      extractionId: extraction.extractionId,
      confirmedFields,
      targetProfileId: selectedProfileId || extraction.targetProfile?.id,
      createCalendarEvents,
      trackerEntries: (extraction.trackerEntries || []).filter((_: any, i: number) => selectedTrackers[i]),
      createExpense: createExpense ? extraction.pendingFinancial?.expense : undefined,
      createObligation: createObligation ? extraction.pendingFinancial?.obligation : undefined,
    });
    if (success) {
      setConfirmed(true);
    }
    setConfirming(false);
  };

  if (confirmed) {
    return (
      <div className="mt-2 p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-xs font-medium">
          <Check className="h-3.5 w-3.5" />
          Extraction confirmed and saved
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">
          Review extracted data
        </span>
        <select
          className="text-xs bg-muted border border-border rounded px-1.5 py-0.5 text-foreground max-w-[140px]"
          value={selectedProfileId || ""}
          onChange={(e) => setSelectedProfileId(e.target.value || undefined)}
          data-testid="select-extraction-profile"
        >
          <option value="">Link to profile...</option>
          {allProfiles.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((p: any) => (
            <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        {fields.map((field, idx) => (
          <label
            key={field.key}
            className="flex items-start gap-2 cursor-pointer group"
          >
            <Checkbox
              checked={field.selected}
              onCheckedChange={() => toggleField(idx)}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground capitalize">
                  {field.label}
                </span>
                {field.isDate && field.suggestedEvent && (
                  <Calendar className="h-3 w-3 text-blue-500" />
                )}
              </div>
              {/* Type-specific input rendering */}
              {(() => {
                const strVal = typeof field.value === 'object' && field.value !== null
                  ? JSON.stringify(field.value).replace(/[{}"/]/g, '').replace(/,/g, ', ')
                  : String(field.value ?? '');
                const isDateField = field.category === 'DATE' || field.isDate;
                const isBoolField = strVal === 'true' || strVal === 'false' || strVal === 'True' || strVal === 'False';
                const isNumField = !isDateField && !isBoolField && /^-?\$?[\d,]+(\.[\d]+)?$/.test(strVal.trim());

                if (isBoolField) {
                  return (
                    <div className="flex items-center gap-1.5 py-0.5" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={strVal === 'true' || strVal === 'True'}
                        onCheckedChange={(checked) => {
                          const newFields = [...fields];
                          newFields[idx] = { ...newFields[idx], value: String(!!checked) };
                          setFields(newFields);
                        }}
                        className="h-3.5 w-3.5"
                      />
                      <span className="text-xs text-muted-foreground">{strVal === 'true' || strVal === 'True' ? 'Yes' : 'No'}</span>
                    </div>
                  );
                }

                return (
                  <input
                    type={isDateField ? 'date' : isNumField ? 'number' : 'text'}
                    className="text-xs text-muted-foreground bg-transparent border-b border-transparent hover:border-border focus:border-primary focus:outline-none w-full py-0.5 transition-colors"
                    value={strVal}
                    onChange={(e) => {
                      const newFields = [...fields];
                      newFields[idx] = { ...newFields[idx], value: e.target.value };
                      setFields(newFields);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                );
              })()}
              {field.isDate && field.suggestedEvent && field.selected && (
                <span className="text-xs text-blue-600 dark:text-blue-400">
                  Will create: {field.suggestedEvent}
                </span>
              )}
            </div>
          </label>
        ))}
      </div>

      {extraction.trackerEntries && extraction.trackerEntries.length > 0 && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">Tracker entries (uncheck to skip):</span>
          {extraction.trackerEntries.map((entry: any, idx: number) => (
            <label key={idx} className="flex items-center gap-2 cursor-pointer ml-1 py-0.5">
              <Checkbox
                checked={selectedTrackers[idx] ?? true}
                onCheckedChange={() => {
                  const next = [...selectedTrackers];
                  next[idx] = !next[idx];
                  setSelectedTrackers(next);
                }}
                className="h-3.5 w-3.5"
              />
              <span className={`text-xs ${selectedTrackers[idx] ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                {(entry.trackerName || '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())}:
                {' '}{Object.entries(entry.values || {}).map(([k, v]) => `${v}`).join(', ')} {entry.unit || ''}
              </span>
            </label>
          ))}
        </div>
      )}

      {extraction.pendingFinancial && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">💰 Financial Records</span>
          {extraction.pendingFinancial.expense && (
            <label className="flex items-center gap-2 cursor-pointer ml-1 py-1">
              <Checkbox checked={createExpense} onCheckedChange={() => setCreateExpense(!createExpense)} className="h-3.5 w-3.5" />
              <span className={`text-xs ${createExpense ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                Create expense: ${extraction.pendingFinancial.expense.amount.toFixed(2)} — {extraction.pendingFinancial.expense.description}
              </span>
            </label>
          )}
          {extraction.pendingFinancial.obligation && (
            <label className="flex items-center gap-2 cursor-pointer ml-1 py-1">
              <Checkbox checked={createObligation} onCheckedChange={() => setCreateObligation(!createObligation)} className="h-3.5 w-3.5" />
              <span className={`text-xs ${createObligation ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                Create recurring bill: ${extraction.pendingFinancial.obligation.amount.toFixed(2)}/mo — {extraction.pendingFinancial.obligation.name}
              </span>
            </label>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => handleConfirm()}
          disabled={confirming || fields.every((f) => !f.selected)}
        >
          {confirming ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onSkip}
          disabled={confirming}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}

// ── Attachment type ──────────────────────────────────────────────────────────
interface StagedAttachment {
  name: string;
  mimeType: string;
  data: string; // base64
  previewUrl: string;
  profileId: string; // "none" | profileId
}

// ── Single-file Attachment staging panel (shown before send) ─────────────────
interface AttachmentPanelProps {
  attachment: {
    name: string;
    mimeType: string;
    data: string;
    previewUrl: string;
  };
  profiles: Profile[];
  profilesLoading: boolean;
  selectedProfileId: string;
  onProfileChange: (id: string) => void;
  onRemove: () => void;
  note: string;
  onNoteChange: (v: string) => void;
  onSend: () => void;
  isSending: boolean;
}

function AttachmentPanel({
  attachment,
  profiles,
  profilesLoading,
  selectedProfileId,
  onProfileChange,
  onRemove,
  note,
  onNoteChange,
  onSend,
  isSending,
}: AttachmentPanelProps) {
  const isImage = attachment.mimeType.startsWith("image/");

  return (
    <div
      className="px-4 pb-3"
      data-testid="attachment-panel"
    >
      <div className="max-w-2xl mx-auto">
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          {/* File preview */}
          <div className="flex items-start gap-3">
            <div className="shrink-0">
              {isImage ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-16 w-16 rounded-lg object-cover border border-border"
                  data-testid="attachment-image-preview"
                />
              ) : (
                <div
                  className="h-16 w-16 rounded-lg border border-border bg-muted flex items-center justify-center"
                  data-testid="attachment-pdf-icon"
                >
                  <FileText className="h-7 w-7 text-muted-foreground" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{attachment.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {attachment.mimeType}
              </p>
            </div>
            <button
              onClick={onRemove}
              className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
              data-testid="button-remove-attachment"
              aria-label="Remove attachment"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* Profile selector — multi-select checkboxes */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Link to profiles
            </label>
            <div className="rounded-lg border border-border max-h-[200px] overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
              {profiles.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((profile) => {
                const isChecked = selectedProfileId.split(",").filter(Boolean).includes(profile.id);
                return (
                  <label
                    key={profile.id}
                    className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0 ${isChecked ? "bg-primary/5" : ""}`}
                    data-testid={`select-profile-${profile.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        const current = selectedProfileId.split(",").filter(Boolean);
                        const next = isChecked
                          ? current.filter(id => id !== profile.id)
                          : [...current, profile.id];
                        onProfileChange(next.length > 0 ? next.join(",") : "none");
                      }}
                      className="h-4 w-4 rounded border-border accent-primary"
                      disabled={isSending}
                    />
                    <span className="text-sm flex-1">{profile.name}</span>
                    <ProfileTypeBadge type={profile.type} />
                  </label>
                );
              })}
            </div>
            {selectedProfileId !== "none" && selectedProfileId !== "" && (
              <p className="text-xs text-muted-foreground">
                {selectedProfileId.split(",").filter(Boolean).length} profile(s) selected
              </p>
            )}
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Notes (optional)
            </label>
            <Textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Add a note about this file..."
              className="min-h-[60px] max-h-[100px] resize-none rounded-xl bg-background text-sm"
              rows={2}
              disabled={isSending}
              data-testid="input-attachment-note"
            />
          </div>

          {/* Send button */}
          <Button
            onClick={onSend}
            disabled={isSending}
            className="w-full rounded-xl"
            data-testid="button-send-attachment"
          >
            <Send className="h-4 w-4 mr-2" />
            {isSending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Batch Attachment Panel (multiple files) ──────────────────────────────────
interface BatchAttachmentPanelProps {
  attachments: StagedAttachment[];
  profiles: Profile[];
  profilesLoading: boolean;
  onProfileChange: (index: number, profileId: string) => void;
  onGlobalProfileChange: (profileId: string) => void;
  onRemove: (index: number) => void;
  onAddMore: () => void;
  note: string;
  onNoteChange: (v: string) => void;
  onSend: () => void;
  isSending: boolean;
  processedCount: number;
}

function BatchAttachmentPanel({
  attachments,
  profiles,
  profilesLoading,
  onProfileChange,
  onGlobalProfileChange,
  onRemove,
  onAddMore,
  note,
  onNoteChange,
  onSend,
  isSending,
  processedCount,
}: BatchAttachmentPanelProps) {
  return (
    <div className="px-4 pb-3" data-testid="batch-attachment-panel">
      <div className="max-w-2xl mx-auto">
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          {/* Header with count and global profile selector */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium" data-testid="text-batch-count">
                {attachments.length} file{attachments.length !== 1 ? "s" : ""} ready to upload
              </span>
            </div>
            <button
              onClick={onAddMore}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
              data-testid="button-add-more-files"
              disabled={isSending}
            >
              <Plus className="h-3 w-3" />
              Add more
            </button>
          </div>

          {/* Global "Link all to" selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Link all to:
            </label>
            <Select
              onValueChange={onGlobalProfileChange}
              disabled={profilesLoading || isSending}
            >
              <SelectTrigger
                className="w-full h-8 text-xs"
                data-testid="select-batch-global-profile"
              >
                <SelectValue placeholder="Individual assignment (default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" data-testid="select-batch-profile-none">
                  Don't link to a profile
                </SelectItem>
                {profiles.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((profile) => (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    data-testid={`select-batch-profile-${profile.id}`}
                  >
                    <span className="flex items-center gap-2">
                      {profile.name}
                      <ProfileTypeBadge type={profile.type} />
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* File grid */}
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${attachments.some(a => !a.mimeType.startsWith("image/")) ? 2 : Math.min(attachments.length, 4)}, 1fr)`,
            }}
            data-testid="batch-file-grid"
          >
            {attachments.map((att, idx) => {
              const isImage = att.mimeType.startsWith("image/");
              return (
                <div
                  key={`${att.name}-${idx}`}
                  className="relative bg-background border border-border rounded-xl p-2 space-y-1.5 group"
                  data-testid={`batch-file-tile-${idx}`}
                >
                  {/* Remove button */}
                  <button
                    onClick={() => onRemove(idx)}
                    className="absolute -top-1.5 -right-1.5 p-0.5 bg-card border border-border rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
                    data-testid={`button-remove-batch-file-${idx}`}
                    aria-label={`Remove ${att.name}`}
                    disabled={isSending}
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>

                  {/* Thumbnail */}
                  {isImage ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="w-full aspect-square object-cover rounded-lg"
                      data-testid={`batch-image-preview-${idx}`}
                    />
                  ) : (
                    <div
                      className="w-full aspect-square rounded-lg bg-muted flex items-center justify-center"
                      data-testid={`batch-pdf-icon-${idx}`}
                    >
                      <FileText className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}

                  {/* Filename (truncated) */}
                  <p
                    className="text-xs-loose font-medium truncate px-0.5"
                    title={att.name}
                    data-testid={`text-batch-filename-${idx}`}
                  >
                    {att.name}
                  </p>

                  {/* Per-file profile selector */}
                  <Select
                    value={att.profileId}
                    onValueChange={(val) => onProfileChange(idx, val)}
                    disabled={profilesLoading || isSending}
                  >
                    <SelectTrigger
                      className="w-full h-7 text-xs"
                      data-testid={`select-batch-file-profile-${idx}`}
                    >
                      <SelectValue placeholder="No profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No profile</SelectItem>
                      {profiles.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          <span className="flex items-center gap-1">
                            {profile.name}
                            <ProfileTypeBadge type={profile.type} />
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Notes (optional)
            </label>
            <Textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Add a note about these files..."
              className="min-h-[50px] max-h-[80px] resize-none rounded-xl bg-background text-sm"
              rows={2}
              disabled={isSending}
              data-testid="input-batch-note"
            />
          </div>

          {/* Upload All button */}
          <Button
            onClick={onSend}
            disabled={isSending}
            className="w-full rounded-xl"
            data-testid="button-upload-all"
          >
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing {processedCount}/{attachments.length}…
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Upload All ({attachments.length} file{attachments.length !== 1 ? "s" : ""})
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main chat page ────────────────────────────────────────────────────────────
// Module-level chat history cache — persists across navigation without localStorage
function SlowResponseHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 10000);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return <span className="text-xs text-muted-foreground animate-in fade-in">Still working… complex requests take longer</span>;
}

const WELCOME_MSG: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content: "Hi! I'm your Portol AI. Ask me to log health data, track expenses, create events, add tasks, open documents, and more. What would you like to do?",
  timestamp: new Date().toISOString(),
};
// Persist chat history to sessionStorage so it survives page reloads
function loadChatHistory(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem("portol_chat_history");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore parse errors */ }
  return [WELCOME_MSG];
}
function saveChatHistory(messages: ChatMessage[]) {
  try {
    // Keep last 100 messages to avoid storage bloat
    const toSave = messages.slice(-100);
    sessionStorage.setItem("portol_chat_history", JSON.stringify(toSave));
  } catch { /* storage full — ignore */ }
}
let _chatCache: ChatMessage[] = loadChatHistory();

/** Clear module-level chat cache — must be called on sign-out to prevent data leakage between users */
export function clearChatCache() {
  _chatCache = [WELCOME_MSG];
  try { sessionStorage.removeItem("portol_chat_history"); } catch {}
}

// ─────────────────────────────────────────────
// Confirmation card with inline Edit + Undo
// ─────────────────────────────────────────────
function ConfirmationCard({ name, type, amount, date, profile, warnings, entityId, endpoint, isDeleted, result, onDeleted }: {
  name: string; type: string; amount: string | null; date: string; profile: string;
  warnings: string[]; entityId?: string; endpoint: string | null; isDeleted?: boolean;
  result: any; onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editAmount, setEditAmount] = useState(result?.amount?.toString() || "");
  const [editDate, setEditDate] = useState(date?.slice(0, 10) || "");
  const [saving, setSaving] = useState(false);
  const [deleted, setDeleted] = useState(!!isDeleted);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  if (deleted) {
    return (
      <div className="flex items-center gap-2 text-xs bg-destructive/5 rounded-lg px-3 py-2 border border-destructive/20 opacity-60">
        <X className="h-3 w-3 text-destructive" />
        <span className="line-through text-muted-foreground">{name} {amount && `(${amount})`} — undone</span>
      </div>
    );
  }

  const handleSave = async () => {
    if (!entityId || !endpoint) return;
    setSaving(true);
    try {
      const patch: any = {};
      if (endpoint === "expenses") {
        patch.description = editName;
        patch.amount = parseFloat(editAmount);
        if (editDate) patch.date = editDate;
      } else if (endpoint === "tasks") {
        patch.title = editName;
      } else if (endpoint === "obligations") {
        patch.name = editName;
        patch.amount = parseFloat(editAmount);
      } else if (endpoint === "events") {
        patch.title = editName;
        if (editDate) patch.date = editDate;
      }
      await apiRequest("PATCH", `/api/${endpoint}/${entityId}`, patch);
      // Update display values
      result.title = editName; result.name = editName; result.description = editName;
      result.amount = parseFloat(editAmount) || result.amount;
      result.date = editDate || result.date;
      queryClient.invalidateQueries({ queryKey: [`/api/${endpoint}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Updated" });
      setEditing(false);
    } catch { toast({ title: "Failed to update", variant: "destructive" }); }
    setSaving(false);
  };

  const handleUndo = async () => {
    if (!entityId || !endpoint) return;
    setDeleted(true); // Optimistic — show immediately
    try {
      await apiRequest("DELETE", `/api/${endpoint}/${entityId}`);
      onDeleted();
      // Optimistically remove from cache
      queryClient.setQueryData([`/api/${endpoint}`], (old: any[]) => old?.filter(item => item.id !== entityId));
      toast({ title: "Removed" });
      // Invalidate outside try so we don't catch its errors
    } catch (err: any) {
      setDeleted(false); // Roll back on real failure
      const msg = err?.message || "";
      toast({
        title: "Could not undo",
        description: msg.includes("401") ? "Session expired — try signing out and back in" : msg.includes("404") ? "Already removed" : "Please try again",
        variant: "destructive"
      });
      return;
    }
    queryClient.invalidateQueries();
  };

  return (
    <div className="text-xs bg-muted/30 rounded-lg border border-border/30 overflow-hidden" data-testid="confirmation-card">
      {editing ? (
        <div className="px-3 py-2 space-y-2">
          <input
            autoFocus
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-medium text-foreground"
            placeholder="Name / description"
          />
          <div className="flex gap-1.5">
            {(endpoint === "expenses" || endpoint === "obligations") && (
              <input
                value={editAmount}
                onChange={e => setEditAmount(e.target.value)}
                type="number"
                step="0.01"
                className="w-24 bg-background border border-border rounded px-2 py-1 text-xs tabular-nums"
                placeholder="Amount"
              />
            )}
            {(endpoint === "expenses" || endpoint === "events") && (
              <input
                value={editDate}
                onChange={e => setEditDate(e.target.value)}
                type="date"
                className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs"
              />
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-medium"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1 rounded text-xs border border-border hover:bg-muted/60 text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 px-3 py-2">
          <div className="flex-1 min-w-0 space-y-0.5">
            <div className="font-medium text-foreground truncate">{editName}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              {type && <span className="capitalize">{type}</span>}
              {editAmount && parseFloat(editAmount) > 0 && <span className="tabular-nums text-green-500">${parseFloat(editAmount).toFixed(2)}</span>}
              {editDate && <span>{editDate.slice(0, 10)}</span>}
              {typeof profile === "string" && profile && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(profile) && <span className="text-primary/80">→ {profile.slice(0, 20)}</span>}
            </div>
            {warnings.length > 0 && <div className="text-amber-500">⚠ {warnings.join(", ")}</div>}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-1">
            {entityId && endpoint && (
              <button
                onClick={() => setEditing(true)}
                className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                title="Edit"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            {entityId && endpoint && (
              <button
                onClick={handleUndo}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                title="Undo / Remove"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function useSpeechInput(onResult: (text: string) => void, onError?: (title: string, description?: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const start = useCallback(async () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      onError?.("Voice input not supported", "Use Chrome or Safari for voice input.");
      return;
    }

    // If running in Capacitor, request native mic permission
    if ((window as any).Capacitor?.isNativePlatform()) {
      try {
        // Dynamic import with variable to prevent Rollup from resolving at build time
        const modPath = '@capacitor-community/microphone';
        const mod = await (Function('p', 'return import(p)'))(modPath);
        const permission = await mod.Microphone.requestPermission();
        if (permission.microphone !== 'granted') {
          onError?.("Microphone permission required", "Enable microphone access in your device settings.");
          return;
        }
      } catch { /* Capacitor plugin not installed, fallback to web */ }
    }

    // Check browser microphone permission
    if (navigator.permissions) {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        if (result.state === 'denied') {
          onError?.("Microphone access denied", "Enable microphone in your browser settings.");
          return;
        }
      } catch { /* permissions API not supported for microphone in this browser */ }
    }

    const rec = new SpeechRecognition();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      onResult(transcript);
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }, [onResult, onError]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const supported = typeof window !== 'undefined' && (
    !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition
  );

  return { listening, start, stop, supported };
}

export default function ChatPage() {
  useEffect(() => { document.title = "Chat — Portol"; }, []);
  useEffect(() => {
    return () => { if (batchIntervalRef.current) clearInterval(batchIntervalRef.current); };
  }, []);
  const { toast } = useToast();
  const [messages, setMessagesRaw] = useState<ChatMessage[]>(_chatCache);
  // Wrap setMessages to also persist to module-level cache
  const setMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      _chatCache = next; // Persist across navigation
      saveChatHistory(next); // Persist across page reloads
      return next;
    });
  };
  const [input, setInput] = useState("");
  // Read prefill set by popup AI buttons (sessionStorage approved for this use)
  useEffect(() => {
    try {
      const prefill = sessionStorage.getItem('portol_chat_prefill');
      if (prefill) { setInput(prefill); sessionStorage.removeItem('portol_chat_prefill'); }
    } catch {}
  }, []);
  const speech = useSpeechInput(
    (text) => setInput(prev => prev ? prev + ' ' + text : text),
    (title, description) => toast({ title, description, variant: 'destructive' }),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);

  // Attachments: array supports both single and batch
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("none");

  // Track batch processing progress
  const [batchProcessedCount, setBatchProcessedCount] = useState(0);

  // Ref to hold attachments at batch-send time so onSettled can revoke URLs and clear state
  const pendingBatchAttachmentsRef = useRef<typeof attachments>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMoreFileInputRef = useRef<HTMLInputElement>(null);
  const batchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  // Fetch profiles for the selector
  const { data: profiles = [], isLoading: profilesLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      // Build conversation history for multi-step context.
      // Exclude the LAST message — it's the one we just added to state and are sending as `message`.
      // Without this, the AI receives the user's message twice (once in history, once as the prompt).
      const history = messages
        .filter(m => m.id !== "welcome")
        .slice(0, -1)  // drop the last message (current user message already in `message` param)
        .slice(-10)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
      const res = await apiRequest("POST", "/api/chat", { message, history });
      return res.json();
    },
    onSuccess: (data) => {
      const assistantMsg: any = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
        actions: data.actions,
        results: data.results,
        documentPreview: data.documentPreview,
        documentPreviews: data.documentPreviews,
        charts: data.charts,
        tables: data.tables,
        report: data.report,
      };
      setMessages((prev: any) => [...prev, assistantMsg]);
      invalidateAll();
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Something went wrong: ${err.message || "Network error"}. Please try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (payload: {
      fileName: string;
      mimeType: string;
      fileData: string;
      profileId?: string;
      message?: string;
    }) => {
      const res = await apiRequest("POST", "/api/upload", payload);
      return res.json();
    },
    onSuccess: (data) => {
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
        actions: data.actions,
        results: data.results,
        documentPreview: data.documentPreview,
        documentPreviews: data.documentPreviews,
        pendingExtraction: data.pendingExtraction,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      invalidateAll();
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Failed to process the uploaded file: ${err.message || "Network error"}. Please try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    },
  });

  // Batch upload mutation
  const batchUploadMutation = useMutation({
    mutationFn: async (payload: {
      files: Array<{ fileName: string; mimeType: string; fileData: string; profileId?: string }>;
      message?: string;
    }) => {
      const res = await apiRequest("POST", "/api/upload/batch", payload);
      return res.json();
    },
    onSuccess: (data: {
      results: Array<{
        fileName: string;
        reply: string;
        actions: ParsedAction[];
        results: any[];
        documentId?: string;
        documentPreview?: { id: string; name: string; mimeType: string; data: string };
        suggestedProfile?: { id: string; name: string } | null;
        documentType?: string;
        pendingExtraction?: any;
      }>;
      summary: string;
    }) => {
      // Create ONE combined assistant message
      let content = data.summary + "\n\n";
      for (const r of data.results) {
        content += `📄 ${r.fileName}: ${r.reply}\n\n`;
      }
      // Collect all document previews
      const allPreviews = data.results
        .filter((r) => r.documentPreview)
        .map((r) => r.documentPreview!);

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
        actions: data.results.flatMap((r) => r.actions || []),
        results: data.results.flatMap((r) => r.results || []),
        documentPreviews: allPreviews,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Create separate extraction messages for each file with pending extraction
      const extractionMsgs: ChatMessage[] = data.results
        .filter((r) => r.pendingExtraction?.extractedFields?.length > 0)
        .map((r, idx) => ({
          id: `${crypto.randomUUID()}-extraction-${idx}`,
          role: "assistant" as const,
          content: `Review extracted data for "${r.fileName}":`,
          timestamp: new Date().toISOString(),
          pendingExtraction: r.pendingExtraction,
        }));
      if (extractionMsgs.length > 0) {
        setMessages((prev) => [...prev, ...extractionMsgs]);
      }

      setBatchProcessedCount(0);
      invalidateAll();
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Failed to process the batch upload: ${err.message || "Network error"}. Please try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
      setBatchProcessedCount(0);
    },
    onSettled: () => {
      // Revoke object URLs and clear attachments after mutation completes (success or error)
      pendingBatchAttachmentsRef.current.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      pendingBatchAttachmentsRef.current = [];
      setAttachments([]);
    },
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
    queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
    queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
    queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/insights"] });
    queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
    queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ai-digest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
  }

  const handleConfirmExtraction = async (data: {
    extractionId: string;
    confirmedFields: Array<{ key: string; value: any }>;
    targetProfileId?: string;
    createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
    trackerEntries: any[];
    createExpense?: any;
    createObligation?: any;
  }): Promise<boolean> => {
    try {
      const res = await apiRequest("POST", "/api/chat/confirm-extraction", data);
      const result = await res.json();
      if (result.success) {
        invalidateAll();
        toast({ title: "Extraction confirmed", description: "Data has been saved." });
        // Remove pendingExtraction from the message
        setMessages((prev) =>
          prev.map((m) =>
            m.pendingExtraction?.extractionId === data.extractionId
              ? { ...m, pendingExtraction: undefined }
              : m
          )
        );
        return true;
      }
      toast({ title: "Extraction failed", description: "The server could not save the data.", variant: "destructive" });
      return false;
    } catch (err) {
      console.error("Confirm extraction failed:", err);
      toast({ title: "Extraction failed", description: "Something went wrong — please try again.", variant: "destructive" });
      return false;
    }
  };

  const handleSkipExtraction = (extractionId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.pendingExtraction?.extractionId === extractionId
          ? { ...m, pendingExtraction: undefined }
          : m
      )
    );
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, chatMutation.isPending, uploadMutation.isPending, batchUploadMutation.isPending]);

  // Process image: correct EXIF orientation + resize/compress to fit upload limits
  // ALWAYS runs through canvas to ensure images stay under ~3MB base64 (Vercel body limit safety)
  const correctImageOrientation = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        const dataView = new DataView(arrayBuffer);
        
        // Read EXIF orientation
        let orientation = 1;
        try {
          if (dataView.getUint16(0, false) === 0xFFD8) { // JPEG
            let offset = 2;
            while (offset < dataView.byteLength - 2) {
              const marker = dataView.getUint16(offset, false);
              offset += 2;
              if (marker === 0xFFE1) { // APP1 (EXIF)
                const exifOffset = offset + 2;
                if (dataView.getUint32(exifOffset, false) === 0x45786966) { // "Exif"
                  const tiffOffset = exifOffset + 6;
                  const littleEndian = dataView.getUint16(tiffOffset, false) === 0x4949;
                  const ifdOffset = tiffOffset + dataView.getUint32(tiffOffset + 4, littleEndian);
                  const entries = dataView.getUint16(ifdOffset, littleEndian);
                  for (let i = 0; i < entries; i++) {
                    const entryOffset = ifdOffset + 2 + i * 12;
                    if (entryOffset + 12 > dataView.byteLength) break;
                    if (dataView.getUint16(entryOffset, littleEndian) === 0x0112) { // Orientation tag
                      orientation = dataView.getUint16(entryOffset + 8, littleEndian);
                      break;
                    }
                  }
                }
                break;
              } else if ((marker & 0xFF00) === 0xFF00) {
                offset += dataView.getUint16(offset, false);
              } else break;
            }
          }
        } catch { /* keep orientation = 1 if parsing fails */ }

        // ALWAYS process through canvas: applies EXIF rotation AND resizes large images
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          
          // Cap at 2048px on longest side — enough for document extraction
          // This prevents massive Gemini/AI-generated PNGs from exceeding upload limits
          const MAX_DIM = 2048;
          if (w > MAX_DIM || h > MAX_DIM) {
            const scale = MAX_DIM / Math.max(w, h);
            w = Math.round(w * scale);
            h = Math.round(h * scale);
          }

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;
          
          // Set canvas size based on rotation
          if (orientation >= 5) { canvas.width = h; canvas.height = w; }
          else { canvas.width = w; canvas.height = h; }
          
          // Apply EXIF transform
          switch (orientation) {
            case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
            case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
            case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
            case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
            case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
            case 7: ctx.transform(0, -1, -1, 0, h, w); break;
            case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
          }
          
          ctx.drawImage(img, 0, 0, w, h);
          // Export as JPEG at 85% quality — good enough for document text extraction
          // while keeping file size well under Vercel's ~4.5MB request body limit
          const compressed = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
          console.log(`[upload] Image processed: ${img.width}x${img.height} → ${w}x${h}, base64 length: ${compressed.length} (${(compressed.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`);
          resolve(compressed);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        toast({ title: `File "${file.name}" is too large (max 10MB)`, variant: "destructive" });
        continue;
      }

      try {
        let base64: string;
        if (file.type.startsWith('image/')) {
          // Correct orientation for images (handles rotated iPhone photos)
          base64 = await correctImageOrientation(file);
        } else {
          // Non-images: read as-is
          base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve((reader.result as string).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        }
        const newAttachment: StagedAttachment = {
          name: file.name,
          mimeType: file.type.startsWith('image/') ? 'image/jpeg' : file.type, // Corrected images are always JPEG
          data: base64,
          previewUrl: URL.createObjectURL(file),
          profileId: "none",
        };
        setAttachments((prev) => [...prev, newAttachment]);
      } catch {
        toast({ title: `Failed to read "${file.name}"`, variant: "destructive" });
      }
    }

    // Reset so same file can be selected again
    e.target.value = "";
  };

  // Single file: send using existing upload endpoint
  const handleAttachmentSend = () => {
    if (attachments.length !== 1 || uploadMutation.isPending) return;
    const att = attachments[0];

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim() || `Uploaded: ${att.name}`,
      timestamp: new Date().toISOString(),
      attachment: {
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
        previewUrl: att.previewUrl,
      },
    };
    setMessages((prev) => [...prev, userMsg]);

    const profileToSend = att.profileId !== "none" ? att.profileId : (selectedProfileId !== "none" ? selectedProfileId : undefined);

    uploadMutation.mutate({
      fileName: att.name,
      mimeType: att.mimeType,
      fileData: att.data,
      profileId: profileToSend,
      message: input.trim() || undefined,
    });

    setAttachments([]);
    setSelectedProfileId("none");
    setInput("");
  };

  // Batch upload: send using batch endpoint
  const handleBatchSend = () => {
    if (attachments.length < 2 || batchUploadMutation.isPending) return;

    const fileNames = attachments.map((a) => a.name).join(", ");
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim() || `Uploaded ${attachments.length} files: ${fileNames}`,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setBatchProcessedCount(0);

    batchUploadMutation.mutate({
      files: attachments.map((att) => ({
        fileName: att.name,
        mimeType: att.mimeType,
        fileData: att.data,
        profileId: att.profileId !== "none" ? att.profileId : undefined,
      })),
      message: input.trim() || undefined,
    });

    // Capture attachments in a ref so onSettled can revoke URLs and clear state
    // (attachments must remain visible during upload to show progress)
    pendingBatchAttachmentsRef.current = attachments;
    const currentAttachmentCount = attachments.length;
    // Simulate progress updates
    let count = 0;
    if (batchIntervalRef.current) clearInterval(batchIntervalRef.current);
    batchIntervalRef.current = setInterval(() => {
      count++;
      if (count >= currentAttachmentCount) {
        if (batchIntervalRef.current) clearInterval(batchIntervalRef.current);
        batchIntervalRef.current = null;
      }
      setBatchProcessedCount((prev) => Math.min(prev + 1, currentAttachmentCount));
    }, 2000);

    // Clear input immediately; attachments will be cleared in onSettled after mutation completes
    setSelectedProfileId("none");
    setInput("");
  };

  const handleSend = () => {
    const msg = input.trim();
    const isPending = chatMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending;
    if (isPending) return;
    if (!msg) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: msg,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    chatMutation.mutate(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestion = (s: string) => {
    setInput(s);
    inputRef.current?.focus();
  };

  // Batch panel handlers
  const handleBatchProfileChange = (index: number, profileId: string) => {
    setAttachments((prev) =>
      prev.map((att, i) => (i === index ? { ...att, profileId } : att))
    );
  };

  const handleGlobalProfileChange = (profileId: string) => {
    setAttachments((prev) => prev.map((att) => ({ ...att, profileId })));
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => {
      const newArr = [...prev];
      // Revoke the object URL to avoid memory leaks
      if (newArr[index]?.previewUrl) {
        URL.revokeObjectURL(newArr[index].previewUrl);
      }
      newArr.splice(index, 1);
      return newArr;
    });
  };

  const isPending = chatMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending;
  const hasAttachments = attachments.length > 0;
  const isBatch = attachments.length > 1;

  return (
    <div className="flex flex-col h-full overflow-x-hidden" data-testid="page-chat">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-file"
      />
      <input
        ref={addMoreFileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-file-add-more"
      />
      {/* Camera capture input (mobile) */}
      <input
        id="camera-capture"
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-camera"
      />

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        <div className={`max-w-2xl mx-auto space-y-4 ${messages.length <= 1 ? 'min-h-[40vh] flex flex-col justify-end' : ''}`}>

          {/* Search bar */}
          {searchOpen && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-xl bg-muted/50 border border-border/50 mb-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search messages..."
                className="flex-1 bg-transparent text-sm outline-none text-foreground placeholder:text-muted-foreground"
                data-testid="input-chat-search"
              />
              {searchQuery && <button onClick={() => setSearchQuery('')} className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
              <button onClick={() => { setSearchOpen(false); setSearchQuery(''); }} className="text-muted-foreground hover:text-foreground text-xs">Done</button>
            </div>
          )}
          {messages
            .filter(msg => !searchQuery || msg.content.toLowerCase().includes(searchQuery.toLowerCase()))
            .map((msg) => (
            <div
              key={msg.id}
              className={`message-in flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border"
                }`}
                data-testid={`message-${msg.role}-${msg.id}`}
              >
                {msg.role === "assistant" && (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                    <span className="text-xs font-medium text-primary">
                      Portol
                    </span>
                  </div>
                )}

                {/* Attachment preview in user message */}
                {msg.attachment &&
                  msg.attachment.mimeType.startsWith("image/") && (
                    <div className="mb-2 rounded-lg overflow-hidden">
                      <img
                        src={
                          msg.attachment.previewUrl ||
                          `data:${msg.attachment.mimeType};base64,${msg.attachment.data}`
                        }
                        alt={msg.attachment.name}
                        className="max-h-48 w-auto rounded-lg"
                      />
                    </div>
                  )}
                {msg.attachment &&
                  !msg.attachment.mimeType.startsWith("image/") && (
                    <div className="mb-2 flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <span className="text-xs truncate">
                        {msg.attachment.name}
                      </span>
                    </div>
                  )}

                <div className="text-sm whitespace-pre-wrap leading-relaxed [&_ul]:ml-4 [&_ol]:ml-4 [&_li]:ml-2 text-foreground">
                  {msg.content}
                </div>

                {/* Document previews - inline with zoom & share */}
                <ChatDocumentPreviews
                  documentPreview={msg.documentPreview}
                  documentPreviews={msg.documentPreviews}
                />

                {/* Inline charts */}
                {(msg as any).charts?.length > 0 && (
                  <div className="space-y-1">
                    {(msg as any).charts.map((chart: ChartSpec2, ci: number) => <ChatChart key={ci} spec={chart} />)}
                  </div>
                )}

                {/* Inline tables */}
                {(msg as any).tables?.length > 0 && (
                  <div className="space-y-1">
                    {(msg as any).tables.map((table: TableSpec2, ti: number) => <ChatTable key={ti} spec={table} />)}
                  </div>
                )}

                {/* Inline report */}
                {(msg as any).report && <ChatReport spec={(msg as any).report as ReportSpec2} />}

                {/* Extraction confirmation UI */}
                {msg.pendingExtraction && msg.pendingExtraction.extractedFields.length > 0 && (
                  <ExtractionConfirmation
                    extraction={msg.pendingExtraction}
                    onConfirm={handleConfirmExtraction}
                    onSkip={() => { if (msg.pendingExtraction?.extractionId) handleSkipExtraction(msg.pendingExtraction.extractionId); }}
                  />
                )}

                {/* Action badges */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-3 space-y-1.5">
                    {msg.actions.filter(a => [
                      'log_entry', 'log_tracker_entry', 'add_tracker_entry',
                      'log_expense', 'create_task', 'create_event',
                      'create_habit', 'checkin_habit', 'create_obligation',
                      'create_goal', 'create_profile', 'update_profile',
                      'create_tracker', 'journal_entry', 'create_artifact',
                      'complete_task', 'complete_event', 'pay_obligation',
                      'delete_task', 'delete_habit', 'delete_tracker_entry',
                      'update_tracker_entry', 'uncomplete_habit', 'save_memory',
                    ].includes(a.type)).map((action, i) => {
                      const entityId = action.data?._entityId;
                      const isUndone = action.data?._undone;
                      // All create/log actions can be undone
                      // Mapping covers BOTH the raw tool name AND the mapped ParsedAction type
                      const undoEndpoints: Record<string, string> = {
                        // By ParsedAction type (what gets stored in action.type)
                        create_task: "tasks",
                        log_expense: "expenses",
                        create_event: "events",
                        create_habit: "habits",
                        create_obligation: "obligations",
                        create_goal: "goals",
                        create_profile: "profiles",
                        journal_entry: "journal",
                        create_artifact: "artifacts",
                        create_tracker: "trackers",
                        log_entry: "tracker-entries",      // log_tracker_entry maps to log_entry
                        // Also by raw tool name (fallback)
                        log_tracker_entry: "tracker-entries",
                        add_tracker_entry: "tracker-entries",
                      };
                      const canUndo = !!(entityId && !isUndone && undoEndpoints[action.type]);
                      // Build a meaningful title — always uppercase tracker/type label
                      const isTrackerEntry = action.type === 'log_entry' || (action.type as string) === 'log_tracker_entry';
                      const trackerName = (action.data?.trackerName || '').toUpperCase();
                      const whoFor = action.data?.forProfile
                        ? String(action.data.forProfile).charAt(0).toUpperCase() + String(action.data.forProfile).slice(1)
                        : 'You';
                      // Format values: "250 cal, 31g carbs, 4g protein"
                      const entryValues = isTrackerEntry && action.data?.values
                        ? Object.entries(action.data.values as Record<string,any>)
                            .filter(([k]) => k !== '_notes' && k !== 'item')
                            .map(([k, v]) => `${v} ${k}`)
                            .slice(0, 4).join(' · ')
                        : '';
                      const entryItem = isTrackerEntry && action.data?.values?.item
                        ? String(action.data.values.item) : '';
                      const entityTitle = isTrackerEntry
                        ? (entryItem || trackerName || 'Entry')
                        : (action.data?.title || action.data?.name || action.data?.description || action.data?.content || (action as any).title || '').toUpperCase() || actionLabel(action.type).toUpperCase();
                      const entityDetails = isTrackerEntry
                        ? entryValues
                        : action.data?.amount
                          ? `$${Number(action.data.amount).toFixed(2)}`
                          : '';
                      const isArtifact = action.type === 'create_artifact' && action.data && !isUndone;
                      return (
                        <div key={i} data-testid={`action-card-${action.type}-${i}`}>
                          <div
                            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border transition-all ${
                              isUndone
                                ? "border-red-500/20 bg-red-500/5 opacity-60"
                                : "border-green-500/25 bg-green-500/6"
                            } ${isArtifact ? 'rounded-b-none border-b-0' : ''}`}
                          >
                            {/* Status icon */}
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                              isUndone ? "bg-red-500/15" : "bg-green-500/15"
                            }`}>
                              {isUndone
                                ? <X className="h-3.5 w-3.5 text-red-500" />
                                : <Check className="h-3.5 w-3.5 text-green-600" />}
                            </div>
                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <p className={`text-xs font-semibold ${
                                  isUndone ? 'line-through text-muted-foreground' : 'text-foreground'
                                }`}>
                                  {entityTitle || actionLabel(action.type).toUpperCase()}
                                </p>
                                {/* WHO badge — always show */}
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                                  whoFor === 'You' ? 'bg-primary/15 text-primary' : 'bg-amber-500/15 text-amber-600'
                                }`}>
                                  {whoFor.toUpperCase()}
                                </span>
                                {isTrackerEntry && trackerName && (
                                  <span className="text-[9px] text-muted-foreground/60 font-medium">
                                    via {trackerName}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {entityDetails || actionLabel(action.type)}
                                {isUndone && ' · DELETED'}
                              </p>
                            </div>
                            {/* Undo button */}
                            {canUndo && (
                              <button
                                className="shrink-0 h-7 px-2.5 rounded-lg text-xs font-bold border border-destructive/50 text-destructive bg-destructive/5 hover:bg-destructive/15 active:scale-95 transition-all"
                                title="Delete this entry"
                                data-testid={`button-undo-${action.type}-${i}`}
                                onClick={stopProp(async () => {
                                  const ep = undoEndpoints[action.type];
                                  if (!ep || !entityId) return;
                                  try {
                                    await apiRequest("DELETE", `/api/${ep}/${entityId}`);
                                    action.data = { ...action.data, _undone: true };
                                    // Force re-render by creating new array
                                    setMessages(prev => prev.map(m => ({
                                      ...m,
                                      actions: m.actions ? [...m.actions] : m.actions
                                    })));
                                    // Optimistically remove from cache
                                    queryClient.setQueryData([`/api/${ep}`], (old: any[]) => old?.filter(item => item.id !== entityId));
                                    queryClient.invalidateQueries();
                                    toast({
                                      title: `Deleted: ${entityTitle || actionLabel(action.type)}`,
                                      description: `Removed from ${whoFor}'s ${trackerName || 'data'}`,
                                    });
                                  } catch {
                                    toast({ title: "Delete failed — try again", variant: "destructive" });
                                  }
                                })}
                              >
                                × Delete
                              </button>
                            )}
                          </div>
                          {/* Inline artifact preview */}
                          {isArtifact && (
                            <div className="border border-green-500/25 border-t-0 rounded-b-xl overflow-hidden">
                              <div className="p-3 max-h-[200px] overflow-hidden relative bg-card">
                                <ArtifactPreview data={action.data} />
                                <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent" />
                              </div>
                              <div className="px-3 py-1.5 bg-muted/30 border-t border-border/30">
                                <button
                                  className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                                  onClick={() => { window.location.hash = '#/artifacts'; }}
                                >
                                  Open in Artifacts →
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Structured confirmation cards */}
                {msg.results && msg.results.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {msg.results.slice(0, 10).map((result: any, ri: number) => {
                      if (!result || result.error) return null;
                      const name = result.title || result.name || result.description || "";
                      const type = result.type || result.category || "";
                      const amount = result.amount != null ? `$${Number(result.amount).toFixed(2)}` : null;
                      const date = result.date || result.dueDate || result.nextDueDate || "";
                      const profile = result.forProfile || result.linkedProfiles?.[0] || "";
                      const warnings = result._validationWarnings || [];
                      const entityId = result.id;
                      const isDeleted = result._deleted;
                      
                      if (!name && !amount) return null;
                      
                      // Determine entity endpoint for edit/undo
                      const ep = result.status !== undefined ? "tasks"
                        : result.amount !== undefined ? "expenses"
                        : result.frequency !== undefined ? "obligations"
                        : result.date !== undefined ? "events"
                        : null;
                      
                      return (
                        <ConfirmationCard
                          key={`${ri}-${entityId}`}
                          name={name}
                          type={type}
                          amount={amount}
                          date={date}
                          profile={profile}
                          warnings={warnings}
                          entityId={entityId}
                          endpoint={ep}
                          isDeleted={isDeleted}
                          result={result}
                          onDeleted={() => { result._deleted = true; setMessages(prev => prev.map(m => ({ ...m }))); }}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Timestamp */}
                <div className="mt-1.5 flex justify-end">
                  <span className="text-xs text-muted-foreground/60">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isPending && (
            <div className="flex items-start gap-2">
              <div className="bg-muted rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay: '0ms'}} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay: '150ms'}} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay: '300ms'}} />
                  </div>
                  <SlowResponseHint />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Suggestions (show only when few messages) */}
      {messages.length <= 1 && !hasAttachments && (
        <div className="px-3 pb-2">
          <div className="max-w-2xl mx-auto flex flex-wrap gap-1.5">
            {SUGGESTIONS.slice(0, 6).map((s) => (
              <button
                key={s}
                onClick={() => handleSuggestion(s)}
                className="text-xs px-3 py-1.5 rounded-full border border-border/50 bg-card/60 hover:bg-muted/60 active:scale-95 transition-all text-muted-foreground hover:text-foreground"
                data-testid={`button-suggestion-${s.slice(0, 20)}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Single attachment staging panel */}
      {attachments.length === 1 && (
        <AttachmentPanel
          attachment={attachments[0]}
          profiles={profiles}
          profilesLoading={profilesLoading}
          selectedProfileId={attachments[0].profileId}
          onProfileChange={(id) => {
            setAttachments((prev) =>
              prev.map((att, i) => (i === 0 ? { ...att, profileId: id } : att))
            );
            setSelectedProfileId(id);
          }}
          onRemove={() => {
            if (attachments[0]?.previewUrl) {
              URL.revokeObjectURL(attachments[0].previewUrl);
            }
            setAttachments([]);
            setSelectedProfileId("none");
            setInput("");
          }}
          note={input}
          onNoteChange={setInput}
          onSend={handleAttachmentSend}
          isSending={uploadMutation.isPending}
        />
      )}

      {/* Batch attachment staging panel */}
      {isBatch && (
        <BatchAttachmentPanel
          attachments={attachments}
          profiles={profiles}
          profilesLoading={profilesLoading}
          onProfileChange={handleBatchProfileChange}
          onGlobalProfileChange={handleGlobalProfileChange}
          onRemove={handleRemoveAttachment}
          onAddMore={() => addMoreFileInputRef.current?.click()}
          note={input}
          onNoteChange={setInput}
          onSend={handleBatchSend}
          isSending={batchUploadMutation.isPending}
          processedCount={batchProcessedCount}
        />
      )}

      {/* Text input area (only shown when no attachment pending) */}
      {!hasAttachments && (
        <div className="px-3 pt-2 pb-[env(safe-area-inset-bottom,12px)] bg-background/95 backdrop-blur-sm border-t border-border/40">
          <div className="max-w-2xl mx-auto">
            {/* Large prominent input box */}
            <div className="relative rounded-2xl border border-border bg-card shadow-sm focus-within:border-primary/40 focus-within:shadow-md transition-all duration-200">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask me anything..."
                maxLength={10000}
                className="min-h-[96px] max-h-[280px] resize-none border-0 bg-transparent px-4 pt-3.5 pb-14 text-sm leading-relaxed focus-visible:ring-0 focus-visible:ring-offset-0 rounded-2xl"
                rows={3}
                data-testid="input-chat"
              />
              {/* Action row inside the box */}
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 pb-3">
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isPending}
                    title="Attach file or image"
                    data-testid="button-attach"
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  <button
                    className="h-8 w-8 rounded-lg md:hidden flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                    onClick={() => document.getElementById('camera-capture')?.click()}
                    disabled={isPending}
                    data-testid="button-camera"
                  >
                    <Camera className="h-4 w-4" />
                  </button>
                  {/* Search button */}
                  <button
                    onClick={() => setSearchOpen(v => !v)}
                    title="Search messages"
                    data-testid="button-chat-search"
                    className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
                      searchOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                    }`}
                  >
                    <Search className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => speech.listening ? speech.stop() : speech.start()}
                    title={!speech.supported ? 'Voice input not supported in this browser. Use Chrome or Safari.' : speech.listening ? 'Stop' : 'Voice input'}
                    data-testid="button-voice-input"
                    className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
                      speech.listening
                        ? 'text-red-500 bg-red-500/10'
                        : !speech.supported
                          ? 'text-muted-foreground/40 cursor-not-allowed'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                    }`}
                  >
                    {speech.listening
                      ? <span className="w-3.5 h-3.5 rounded-sm bg-red-500 animate-pulse" />
                      : <Mic className="h-4 w-4" />}
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  {input.length > 9000 && (
                    <span className={`text-xs tabular-nums ${input.length >= 10000 ? 'text-red-500 font-medium' : 'text-muted-foreground'}`} data-testid="chat-char-count">
                      {input.length.toLocaleString()}/10,000
                    </span>
                  )}
                  {messages.length > 1 && (
                    <button
                      onClick={() => { clearChatCache(); setMessagesRaw([WELCOME_MSG]); }}
                      className="h-8 px-2.5 rounded-xl text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors flex items-center gap-1"
                      data-testid="button-reset-chat"
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                  <Button
                    onClick={handleSend}
                    disabled={!input.trim() || isPending}
                    size="sm"
                    className="h-8 px-4 rounded-xl text-xs font-semibold gap-1.5 hover:scale-105 active:scale-95 transition-transform"
                    data-testid="button-send"
                  >
                    {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Send className="h-3.5 w-3.5" /> Send</>}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
