import { useState, useRef, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { hashNavigate } from "@/lib/hashNavigate";
import { stopProp } from "@/lib/event-utils";

// ── Lazy-loaded heavy components ─────────────────────────────────────────────
// chat.tsx is the EAGER home page (imported non-lazy in App.tsx). Anything
// imported statically here lands in the cold-load main bundle, so the heavy,
// conditionally-rendered pieces are code-split:
//  - ArtifactPanel pulls in recharts (~400KB) — only mounts when a chat
//    message produces an artifact and the user opens it.
//  - ChatChartRenderer owns the direct recharts usage for inline charts —
//    only fetched when a message actually contains a chart/report.
//  - SmartFillDialog (600-line PDF form-fill flow) — only mounts when the
//    user starts a Smart Fill.
//  - DocumentViewer (1200-line viewer + share/link stack) — only mounts when
//    a message carries a document preview.
const ArtifactPanel = lazy(() =>
  import("@/components/ArtifactPanel").then((m) => ({ default: m.ArtifactPanel }))
);
const SmartFillDialog = lazy(() =>
  import("@/components/SmartFillDialog").then((m) => ({ default: m.SmartFillDialog }))
);
const DocumentViewer = lazy(() => import("@/components/DocumentViewer"));
const ChatChartBody = lazy(() => import("@/components/ChatChartRenderer"));
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  FilePlus2,
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
  BarChart3,
  CheckCircle,
  PiggyBank,
  Brain,
  ChevronUp,
  ChevronDown,
  Table as TableIcon,
  FileBarChart,
  Mic,
  Search,
  Copy,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import type { ChatMessage, ParsedAction, Profile } from "@shared/schema";
// Type-only import — erased at compile time, does NOT pull recharts into the bundle.
import type { ChartSpec2 } from "@/components/ChatChartRenderer";
// ChartCard lazy-loads the recharts body itself, so importing it here stays light.
import ChartCard from "@/components/ChartCard";

// Keyboard activation helper for non-<button> clickable elements (a11y):
// makes Enter/Space behave like a click on role="button" divs.
const onEnterOrSpace = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

// Table/report spec types (inline — schema was reverted)
interface TableColumn2 { key:string; label:string; align?:"left"|"center"|"right"; format?:"currency"|"date"|"number"|"percent"|"text"; }
interface TableSpec2 { title:string; subtitle?:string; columns:TableColumn2[]; rows:Array<Record<string,any>>; summary?:Record<string,any>; }
interface ReportMetric2 { label:string; value:string|number; change?:string; changeType?:"positive"|"negative"|"neutral"; }
interface ReportSection2 { heading:string; content?:string; chart?:ChartSpec2; table?:TableSpec2; metrics?:ReportMetric2[]; }
interface ReportSpec2 { title:string; subtitle?:string; sections:ReportSection2[]; generatedAt:string; }

// ─── Copy-to-clipboard button ──────────────────────────────────────────────
// Lightweight, reusable copy control used across chat (messages, extracted data,
// tables). Shows a transient check on success. No new features — purely a
// convenience affordance for content already on screen.
function CopyButton({
  value,
  label = "Copy",
  className = "",
  iconOnly = false,
}: {
  value: string | (() => string);
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = typeof value === "function" ? value() : value;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors ${iconOnly ? "p-1" : "px-1.5 py-0.5"} ${className}`}
      aria-label={label}
      title={copied ? "Copied" : label}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {!iconOnly && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}

// ─── Rich Visual Components ────────────────────────────────────────────────────────────────────────
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
  // Shared, polished chart card (KPI strip + chart + notes/key + copy button)
  // — identical to what the Artifacts tab renders for the saved copy.
  return <ChartCard spec={spec} />;
}

function ChatTable({ spec }: { spec: TableSpec2 }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-3 rounded-xl border border-border bg-card/60 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} table: ${spec.title}`}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/30"
        onClick={()=>setOpen(o=>!o)}
        onKeyDown={onEnterOrSpace(()=>setOpen(o=>!o))}
      >
        <div className="flex items-center gap-2">
          <TableIcon className="h-3.5 w-3.5 text-primary"/>
          <span className="text-xs font-semibold">{spec.title}</span>
          <span className="text-xs text-muted-foreground">({spec.rows.length} rows)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <CopyButton
            value={() =>
              spec.columns.map(c => c.label).join("\t") + "\n" +
              spec.rows.map(row => spec.columns.map(c => fmtVal(row[c.key], c.format)).join("\t")).join("\n")
            }
            iconOnly
          />
          {open?<ChevronUp className="h-3.5 w-3.5 text-muted-foreground"/>:<ChevronDown className="h-3.5 w-3.5 text-muted-foreground"/>}
        </div>
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
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} report: ${spec.title}`}
        className="flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-muted/30 bg-muted/10"
        onClick={()=>setOpen(o=>!o)}
        onKeyDown={onEnterOrSpace(()=>setOpen(o=>!o))}
      >
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
              <div
                role="button"
                tabIndex={0}
                aria-expanded={expanded[si]!==false}
                aria-label={`${expanded[si]===false ? "Expand" : "Collapse"} section: ${sec.heading}`}
                className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/10"
                onClick={()=>setExpanded(p=>({...p,[si]:!p[si]}))}
                onKeyDown={onEnterOrSpace(()=>setExpanded(p=>({...p,[si]:!p[si]})))}
              >
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

// ── "+ New" doc/sheet button in the chat composer ────────────────────────────
// Lives next to the paperclip. Opens a small popover with two tiles; clicking
// either navigates to /editor/new/<type>?source=chat. The editor itself saves
// to /api/artifacts and (on save) surfaces both as a chat preview card and on
// the Artifacts page.
function NewDocSheetButton({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const go = (type: "doc" | "sheet") => {
    setOpen(false);
    hashNavigate(`/editor/new/${type}?source=chat`);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          disabled={disabled}
          title="Create document or spreadsheet"
          aria-label="Create document or spreadsheet"
          data-testid="button-new-doc-sheet"
          className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <FilePlus2 className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-56 p-2">
        <div className="text-xs font-medium text-muted-foreground px-2 pt-1 pb-2">Create new…</div>
        <button
          onClick={() => go("doc")}
          data-testid="button-new-doc"
          className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-sm hover:bg-muted/60 transition-colors text-left"
        >
          <FileText className="h-4 w-4 text-blue-500 shrink-0" />
          <div>
            <div className="font-medium">Document</div>
            <div className="text-xs text-muted-foreground">Rich-text Word-style</div>
          </div>
        </button>
        <button
          onClick={() => go("sheet")}
          data-testid="button-new-sheet"
          className="w-full flex items-center gap-3 px-2 py-2 rounded-md text-sm hover:bg-muted/60 transition-colors text-left"
        >
          <TableIcon className="h-4 w-4 text-green-600 shrink-0" />
          <div>
            <div className="font-medium">Spreadsheet</div>
            <div className="text-xs text-muted-foreground">Excel-style grid</div>
          </div>
        </button>
      </PopoverContent>
    </Popover>
  );
}

// ── Inline artifact preview in chat messages ─────────────────────────────
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
function LazyDocumentPreview({
  id, name, mimeType, data, extractedData,
}: {
  id: string; name: string; mimeType: string; data: string;
  extractedData?: Record<string, any>;
}) {
  const isPdf = mimeType === "application/pdf";
  // DocumentViewer (inline mode) already knows how to handle data==="__LAZY_LOAD__":
  // it fetches the binary via GET /api/documents/:id/file as a blob URL. We just
  // need to give it a parent with a real height so its h-full doesn't collapse.
  const fields = extractedData
    ? Object.entries(extractedData).filter(([k, v]) => {
        if (!v && v !== 0) return false;
        if (k.startsWith("_")) return false;
        // Skip nested objects like { value, confidence }
        const val = (v && typeof v === "object" && "value" in (v as any)) ? (v as any).value : v;
        return val !== null && val !== undefined && String(val).trim().length > 0;
      })
    : [];

  const formatKey = (k: string) =>
    k.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim().replace(/\b\w/g, c => c.toUpperCase());
  const formatVal = (v: any) => {
    const val = (v && typeof v === "object" && "value" in (v as any)) ? (v as any).value : v;
    return String(val);
  };

  return (
    <div className="mt-2 space-y-2">
      <div style={{ height: isPdf ? 480 : 360 }}>
        {/* DocumentViewer is code-split — same-size skeleton while the chunk loads */}
        <Suspense
          fallback={
            <div className="h-full w-full rounded-xl border border-border bg-muted/30 animate-pulse flex items-center justify-center" aria-label="Loading document viewer">
              <FileText className="h-8 w-8 text-muted-foreground/50" />
            </div>
          }
        >
          <DocumentViewer id={id} name={name} mimeType={mimeType} data={data} inline />
        </Suspense>
      </div>
      {fields.length > 0 && (
        <div className="rounded-xl border border-border bg-muted/10 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/20">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Extracted data · {fields.length} field{fields.length === 1 ? "" : "s"}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2.5">
            {fields.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <p className="text-[10px] text-muted-foreground">{formatKey(k)}</p>
                <p className="text-xs font-medium truncate" title={formatVal(v)}>{formatVal(v)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChatDocumentPreviews({
  documentPreview,
  documentPreviews,
}: {
  documentPreview?: ChatMessage["documentPreview"];
  documentPreviews?: ChatMessage["documentPreviews"];
}) {
  const allPreviews: Array<{ id: string; name: string; mimeType: string; data: string; extractedData?: Record<string, any> }> = [];
  const seen = new Set<string>();

  if (documentPreviews && documentPreviews.length > 0) {
    for (const p of documentPreviews) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        allPreviews.push(p as any);
      }
    }
  } else if (documentPreview) {
    allPreviews.push(documentPreview as any);
  }

  if (allPreviews.length === 0) return null;

  return (
    <div className="space-y-2">
      {allPreviews.map((doc) => (
        <LazyDocumentPreview
          key={doc.id}
          id={doc.id}
          name={doc.name}
          mimeType={doc.mimeType}
          data={doc.data}
          extractedData={doc.extractedData}
        />
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
  // Track which trackable PROFILE fields (height, weight, etc.) should ALSO be turned
  // into a time-series tracker entry. Bug fix: previously "create tracker for height"
  // checkbox had no effect because height was hard-coded as a profile-only field.
  const TRACKABLE_PROFILE_KEYS = new Set([
    'height', 'weight', 'bmi', 'bodyFat', 'bodyFatPercentage',
    'systolic', 'diastolic', 'bloodPressure', 'heartRate', 'pulse',
    'temperature', 'bodyTemperature', 'restingHeartRate', 'oxygenSaturation', 'spo2',
    'glucose', 'bloodGlucose', 'cholesterol', 'totalCholesterol', 'ldl', 'hdl', 'triglycerides',
    'a1c', 'hba1c'
  ]);
  const isTrackableField = (key: string) =>
    TRACKABLE_PROFILE_KEYS.has(key) || /^(height|weight|bp|bmi|temperature|heart_?rate)$/i.test(key);
  const [alsoTrack, setAlsoTrack] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const f of extraction.extractedFields) {
      // Default to ON for trackable fields — user almost always wants the time-series too.
      if (isTrackableField(f.key)) init[f.key] = true;
    }
    return init;
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(extraction.targetProfile?.id);
  const [createExpense, setCreateExpense] = useState(!!extraction.pendingFinancial?.expense);
  const [createObligation, setCreateObligation] = useState(!!extraction.pendingFinancial?.obligation);

  // Fetch profiles for the dropdown
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
  });

  // Default the linked profile to "my profile" (the self profile) whenever the
  // extraction didn't already target someone specific. Runs once profiles load.
  useEffect(() => {
    if (selectedProfileId) return;
    if (extraction.targetProfile?.id) return;
    const self = allProfiles.find((p: any) => p.type === "self");
    if (self) setSelectedProfileId(self.id);
  }, [allProfiles, selectedProfileId, extraction.targetProfile?.id]);

  const toggleField = (idx: number) => {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, selected: !f.selected } : f));
  };

  // Bulk toggle for the review-table header. If every row is currently
  // selected we treat the next click as a Deselect All; otherwise we Select
  // All. This is the same affordance spreadsheets give you — one click to
  // flip the entire column.
  const allSelected = fields.length > 0 && fields.every((f) => f.selected);
  const toggleAllFields = () => {
    const next = !allSelected;
    setFields((prev) => prev.map((f) => ({ ...f, selected: next })));
    // Mirror the bulk action onto the tracker entry checkboxes so the user's
    // single click clears (or restores) the whole review pane at once.
    setSelectedTrackers((prev) => prev.map(() => next));
  };

  // Heuristic: when the upstream classifier did NOT route this document as an
  // expense, but the user can still see a money-shaped "Total" / "Amount"
  // field in the extracted table, we want a one-click way to push that
  // number into Finance. We scan for a numeric value on a field whose
  // key/label sounds like a charge — only used when
  // extraction.pendingFinancial.expense is absent. This is the missing
  // "Add to Finance" button the user asked for.
  const moneyFieldCandidate = useMemo(() => {
    if (extraction.pendingFinancial?.expense) return null;
    const moneyKeyRe = /(total|amount|price|charge|fee|cost|payment|balance|due|paid|subtotal|grand_?total)/i;
    let best: { amount: number; label: string; key: string; __rank: number } | null = null;
    for (const f of fields) {
      const keyStr = String(f.key || '');
      const labelStr = String(f.label || '');
      if (!moneyKeyRe.test(keyStr) && !moneyKeyRe.test(labelStr)) continue;
      const raw = String(f.value ?? '').replace(/[$,€£¥₹₩]/g, '').trim();
      const num = parseFloat(raw);
      if (!isNaN(num) && num > 0) {
        // Prefer "total" > "amount/paid" > anything else when multiple match.
        const rank = /total|grand/i.test(keyStr + labelStr) ? 0 : /amount|paid/i.test(keyStr + labelStr) ? 1 : 2;
        if (!best || rank < best.__rank) {
          best = { amount: num, label: labelStr || keyStr, key: keyStr, __rank: rank };
        }
      }
    }
    return best;
  }, [fields, extraction.pendingFinancial]);
  // "Add to Finance" toggle state — only meaningful when moneyFieldCandidate exists.
  const [addManualExpense, setAddManualExpense] = useState(false);

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
    // Build synthetic tracker entries from the trackable profile fields the user opted into.
    // This makes the inline "Also track over time" checkbox actually create a tracker, fixing
    // the silent drop where height/weight checkboxes did nothing because they're personal keys.
    const syntheticTrackerEntries = fields
      .filter((f) => f.selected && f.key && alsoTrack[f.key])
      .map((f) => {
        const rawStr = String(f.value ?? '').trim();
        // Try to parse height like 5'10" → 70 (inches)
        let numValue: number | null = null;
        let unit = '';
        if (/^(\d+)'\s*(\d+)?\"?$/.test(rawStr)) {
          const m = rawStr.match(/^(\d+)'\s*(\d+)?\"?$/)!;
          numValue = parseInt(m[1], 10) * 12 + parseInt(m[2] || '0', 10);
          unit = 'in';
        } else if (/^(\d+(\.\d+)?)\s*(lbs?|kg|cm|in|mmHg|bpm|°F|°C|mg\/dL|%)?$/i.test(rawStr)) {
          const m = rawStr.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z%°\/]*)$/)!;
          numValue = parseFloat(m[1]);
          unit = (m[2] || '').toLowerCase();
        } else if (/^\d+\/\d+$/.test(rawStr)) {
          // Blood pressure like 120/80 — store both
          const [sys, dia] = rawStr.split('/').map((n) => parseInt(n, 10));
          return {
            trackerName: 'Blood Pressure',
            values: { systolic: sys, diastolic: dia },
            unit: 'mmHg',
            category: 'health',
            __fromProfileField: f.key,
          };
        } else {
          const n = parseFloat(rawStr);
          if (!isNaN(n)) numValue = n;
        }
        if (numValue === null) return null;
        // Default units when unparseable
        if (!unit) {
          if (/height/i.test(f.key)) unit = 'in';
          else if (/weight/i.test(f.key)) unit = 'lbs';
          else if (/temperature/i.test(f.key)) unit = '°F';
          else if (/heart_?rate|pulse/i.test(f.key)) unit = 'bpm';
        }
        const niceName = (f.label || f.key).replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
        return {
          trackerName: niceName,
          values: { value: numValue },
          unit,
          category: 'health',
          __fromProfileField: f.key,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    // Build the expense payload. Prefer the classifier-produced one. If the
    // classifier didn't produce a pendingFinancial.expense but the user opted
    // in via the manual "Add to Finance" toggle, synthesize one from the
    // money-shaped field we detected.
    let expensePayload: any = createExpense ? extraction.pendingFinancial?.expense : undefined;
    if (!expensePayload && addManualExpense && moneyFieldCandidate) {
      const vendorField = fields.find((f) => /vendor|merchant|company|provider|payee/i.test(String(f.key || '')));
      const dateField = fields.find((f) => /transaction.?date|date$|paid/i.test(String(f.key || '')));
      expensePayload = {
        description: `${vendorField?.value || extraction.label || extraction.fileName} - ${moneyFieldCandidate.label}`,
        amount: moneyFieldCandidate.amount,
        category: 'general',
        vendor: vendorField?.value ? String(vendorField.value) : undefined,
        date: dateField?.value
          ? String(dateField.value)
          : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
      };
    }

    const success = await onConfirm({
      extractionId: extraction.extractionId,
      confirmedFields,
      targetProfileId: selectedProfileId || extraction.targetProfile?.id,
      createCalendarEvents,
      trackerEntries: [
        ...(extraction.trackerEntries || []).filter((_: any, i: number) => selectedTrackers[i]),
        ...syntheticTrackerEntries,
      ],
      createExpense: expensePayload,
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

  // Excel/spreadsheet-friendly TSV (Field<TAB>Value) of all extracted fields so
  // the user can paste the whole table straight into a sheet.
  const buildTsv = () =>
    "Field\tValue\n" +
    fields.map((f) => {
      const v = typeof f.value === 'object' && f.value !== null
        ? JSON.stringify(f.value)
        : String(f.value ?? '');
      return `${f.label || f.key}\t${v}`;
    }).join("\n");

  return (
    <div className="mt-3 rounded-lg bg-muted/40 border border-border overflow-hidden text-foreground">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-muted/60 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Review extracted data · {fields.length}
        </span>
        <button
          type="button"
          onClick={toggleAllFields}
          className="text-[11px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted text-foreground transition-colors"
          data-testid="button-toggle-all-fields"
          title={allSelected ? 'Deselect every row' : 'Select every row'}
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <CopyButton value={buildTsv} label="Copy" />
          <select
            className="text-[11px] bg-background border border-border rounded px-1 py-0.5 text-foreground max-w-[150px]"
            value={selectedProfileId || ""}
            onChange={(e) => setSelectedProfileId(e.target.value || undefined)}
            data-testid="select-extraction-profile"
          >
            <option value="">Link to profile…</option>
            {allProfiles.slice().sort((a: any, b: any) => (a.name || '').localeCompare(b.name || '')).map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}{p.type === 'self' ? ' (me)' : ` (${p.type})`}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Excel-style grid: tight rows, column lines, header row */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="w-7 border-b border-border px-1 py-1 font-medium"></th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Field</th>
              <th className="border-b border-border px-2 py-1 text-left font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field, idx) => {
              const strVal = typeof field.value === 'object' && field.value !== null
                ? JSON.stringify(field.value).replace(/[{}"/]/g, '').replace(/,/g, ', ')
                : String(field.value ?? '');
              const isDateField = field.category === 'DATE' || field.isDate;
              const isBoolField = strVal === 'true' || strVal === 'false' || strVal === 'True' || strVal === 'False';
              const isNumField = !isDateField && !isBoolField && /^-?\$?[\d,]+(\.[\d]+)?$/.test(strVal.trim());
              return (
                <tr
                  key={field.key}
                  className={`border-b border-border/60 last:border-0 ${field.selected ? '' : 'opacity-50'}`}
                >
                  <td className="border-r border-border/60 px-1 py-0.5 text-center align-middle">
                    <Checkbox
                      checked={field.selected}
                      onCheckedChange={() => toggleField(idx)}
                      className="h-3.5 w-3.5"
                    />
                  </td>
                  <td className="border-r border-border/60 px-2 py-0.5 align-middle">
                    <div className="flex items-center gap-1">
                      <span className="font-medium capitalize">{field.label}</span>
                      {field.isDate && field.suggestedEvent && (
                        <Calendar className="h-3 w-3 text-blue-500 shrink-0" />
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-0.5 align-middle">
                    {isBoolField ? (
                      <div className="flex items-center gap-1.5">
                        <Checkbox
                          checked={strVal === 'true' || strVal === 'True'}
                          onCheckedChange={(checked) => {
                            const newFields = [...fields];
                            newFields[idx] = { ...newFields[idx], value: String(!!checked) };
                            setFields(newFields);
                          }}
                          className="h-3.5 w-3.5"
                        />
                        <span className="text-muted-foreground">{strVal === 'true' || strVal === 'True' ? 'Yes' : 'No'}</span>
                      </div>
                    ) : (
                      <input
                        type={isDateField ? 'date' : isNumField ? 'number' : 'text'}
                        className="w-full bg-transparent text-foreground focus:outline-none focus:bg-primary/5 rounded px-0.5 py-0.5"
                        value={strVal}
                        onChange={(e) => {
                          const newFields = [...fields];
                          newFields[idx] = { ...newFields[idx], value: e.target.value };
                          setFields(newFields);
                        }}
                      />
                    )}
                    {field.isDate && field.suggestedEvent && field.selected && (
                      <div className="text-[10px] text-blue-600 dark:text-blue-400 leading-tight">
                        → {field.suggestedEvent}
                      </div>
                    )}
                    {field.selected && field.key && isTrackableField(field.key) && (
                      <label
                        className="flex items-center gap-1 mt-0.5 cursor-pointer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={!!alsoTrack[field.key]}
                          onCheckedChange={(checked) =>
                            setAlsoTrack((prev) => ({ ...prev, [field.key]: !!checked }))
                          }
                          className="h-3 w-3"
                          data-testid={`also-track-${field.key}`}
                        />
                        <span className="text-[10px] text-muted-foreground">Also track over time</span>
                      </label>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="p-2.5 pt-2 space-y-2">

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

      {/* Manual “Add to Finance” affordance — only when the classifier did NOT
          already produce a pendingFinancial.expense AND we detect a money-
          shaped field (Total / Amount / Price…) in the extracted table. This
          is the missing button the user asked for: a parking receipt with a
          $130.29 Total Amount should always have a one-click path to Finance,
          even if the classifier missed it. */}
      {!extraction.pendingFinancial?.expense && moneyFieldCandidate && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">💰 Add to Finance</span>
          <label className="flex items-center gap-2 cursor-pointer ml-1 py-1" data-testid="manual-add-expense">
            <Checkbox checked={addManualExpense} onCheckedChange={() => setAddManualExpense(!addManualExpense)} className="h-3.5 w-3.5" />
            <span className={`text-xs ${addManualExpense ? 'text-foreground' : 'text-muted-foreground'}`}>
              Save ${moneyFieldCandidate.amount.toFixed(2)} as an expense ({moneyFieldCandidate.label})
            </span>
          </label>
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
    </div>
  );
}

// ── Attachment type ──────────────────────────────────────────────────────────
interface StagedAttachment {
  name: string;
  mimeType: string;
  data: string; // base64 — empty string while processing
  previewUrl: string;
  profileId: string; // "none" | profileId
  processing?: boolean; // true while image is being EXIF-corrected/compressed
}

// ── Single-file Attachment staging panel (shown before send) ─────────────────
interface AttachmentPanelProps {
  attachment: {
    name: string;
    mimeType: string;
    data: string;
    previewUrl: string;
    processing?: boolean;
  };
  profiles: Profile[];
  profilesLoading: boolean;
  selectedProfileId: string;
  onProfileChange: (id: string) => void;
  onRemove: () => void;
  note: string;
  onNoteChange: (v: string) => void;
  onSend: () => void;
  onSaveOnly?: () => void;
  isSending: boolean;
  onSmartFill?: () => void;
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
  onSaveOnly,
  isSending,
  onSmartFill,
}: AttachmentPanelProps) {
  const isImage = attachment.mimeType.startsWith("image/");
  const isPdf = attachment.mimeType === "application/pdf";
  const isProcessing = !!attachment.processing;
  const actionsDisabled = isSending || isProcessing;

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

          {/* Action buttons — three clear choices */}
          <div className="space-y-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
              {isProcessing ? "Preparing photo…" : "What do you want to do with this file?"}
            </p>

            {/* 1. SAVE TO PROFILE — most common, primary action */}
            {onSaveOnly && (
              <Button
                type="button"
                onClick={onSaveOnly}
                disabled={actionsDisabled}
                className="w-full rounded-xl justify-start h-auto py-2.5"
                data-testid="button-save-only"
              >
                <div className="flex items-center gap-2.5 w-full">
                  <div className="h-8 w-8 rounded-lg bg-primary-foreground/15 flex items-center justify-center shrink-0">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="text-sm font-semibold leading-tight">{isProcessing ? "Preparing…" : "Save to Profile"}</div>
                    <div className="text-[11px] opacity-80 leading-tight mt-0.5">Just store the file. No AI processing.</div>
                  </div>
                </div>
              </Button>
            )}

            {/* 2. EXTRACT TEXT — the AI-extraction path (formerly "Send") */}
            <Button
              type="button"
              variant="outline"
              onClick={onSend}
              disabled={actionsDisabled}
              className="w-full rounded-xl justify-start h-auto py-2.5"
              data-testid="button-send-attachment"
            >
              <div className="flex items-center gap-2.5 w-full">
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className="text-sm font-semibold leading-tight">{isSending ? "Working…" : "Extract text & save"}</div>
                  <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">AI reads the file, pulls fields, you confirm.</div>
                </div>
              </div>
            </Button>

            {/* 3. SMART FILL — only for forms (PDF/image) */}
            {(isPdf || isImage) && onSmartFill && (
              <Button
                type="button"
                variant="outline"
                onClick={onSmartFill}
                disabled={actionsDisabled}
                className="w-full rounded-xl justify-start h-auto py-2.5"
                data-testid="button-smart-fill-pdf"
              >
                <div className="flex items-center gap-2.5 w-full">
                  <div className="h-8 w-8 rounded-lg bg-amber-500/15 flex items-center justify-center shrink-0">
                    <Sparkles className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <div className="text-sm font-semibold leading-tight">{isPdf ? "Fill this form (PDF)" : "Fill this form (image)"}</div>
                    <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">AI fills blanks from your saved data, you review.</div>
                  </div>
                </div>
              </Button>
            )}
          </div>
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
  onSmartFill?: (index: number) => void;
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
  onSmartFill,
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
                      className="w-full aspect-square rounded-lg bg-muted flex flex-col items-center justify-center gap-1.5 relative"
                      data-testid={`batch-pdf-icon-${idx}`}
                    >
                      <FileText className="h-7 w-7 text-muted-foreground" />
                      {att.mimeType === "application/pdf" && onSmartFill && (
                        <button
                          type="button"
                          onClick={() => onSmartFill(idx)}
                          disabled={isSending}
                          className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-center gap-1 text-[10px] font-medium px-1.5 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary disabled:opacity-50 transition-colors"
                          data-testid={`batch-smart-fill-${idx}`}
                        >
                          <Sparkles className="h-3 w-3" />
                          Smart Fill
                        </button>
                      )}
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
      // Optimistically remove from cache. Note: TanStack queryKey matching is structural,
      // but we only need a hint here — the invalidateQueries below covers all variants.
      // Use prefix match (exact: false is default) to update any keys starting with the same path.
      queryClient.setQueriesData({ queryKey: [`/api/${endpoint}`] }, (old: any) =>
        Array.isArray(old) ? old.filter((item: any) => item?.id !== entityId) : old
      );
      toast({ title: "Removed" });
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
    // Surgical invalidation — only the affected entity + dashboard rollups
    queryClient.invalidateQueries({ queryKey: [`/api/${endpoint}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
                aria-label="Edit"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            {entityId && endpoint && (
              <button
                onClick={handleUndo}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                title="Undo / Remove"
                aria-label="Undo / Remove"
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
  const [activeArtifact, setActiveArtifact] = useState<any>(null);

  // Attachments: array supports both single and batch
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("none");

  // Smart Fill PDF — staged PDF that will be passed to the dialog
  const [smartFillFile, setSmartFillFile] = useState<{ name: string; mimeType: string; base64: string } | null>(null);

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

  // Inline editing of a logged tracker-entry directly from its chat result
  // card (change duration / intensity / calories, add or remove a field).
  // Keyed by the entry id so only one card is open at a time.
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [entryEditVals, setEntryEditVals] = useState<Record<string, any>>({});
  const [entryNewField, setEntryNewField] = useState<{ name: string; value: string }>({ name: "", value: "" });
  const coerceVal = (raw: string): any => {
    const t = raw.trim();
    const n = Number(t);
    return t !== "" && !isNaN(n) && String(n) === t ? n : raw;
  };
  const saveEntryEdit = async (action: any, entryId: string) => {
    const orig = Object.keys(action?.data?.values || {}).filter((k) => k !== "_notes");
    const valuesToDelete = orig.filter((k) => !(k in entryEditVals));
    try {
      await apiRequest("PATCH", `/api/tracker-entries/${entryId}`, { values: entryEditVals, valuesToDelete });
      // Reflect on the card immediately…
      action.data = { ...action.data, values: { ...entryEditVals } };
      setMessages((prev) => prev.map((m) => ({ ...m, actions: m.actions ? [...m.actions] : m.actions })));
      // …and across the app (trackers list, dashboard, stats).
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"], refetchType: "all" });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"], refetchType: "all" });
      setEditingEntryId(null);
      toast({ title: "Entry updated" });
    } catch (e: any) {
      toast({ title: "Update failed", description: e?.message || "Try again", variant: "destructive" });
    }
  };

  const { data: profiles = [], isLoading: profilesLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  // Default the attachment link target to "my profile" (the self profile) on first
  // load, so anything the user attaches is linked to them unless they pick otherwise.
  const didDefaultProfile = useRef(false);
  useEffect(() => {
    if (didDefaultProfile.current || profiles.length === 0) return;
    if (selectedProfileId !== "none") { didDefaultProfile.current = true; return; }
    const self = profiles.find((p) => p.type === "self");
    if (self) {
      setSelectedProfileId(self.id);
      didDefaultProfile.current = true;
    }
  }, [profiles, selectedProfileId]);

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      // Build conversation history for multi-step context.
      // Bug fix: setMessages is async, so the `messages` closure here still reflects state
      // BEFORE the user message was appended in handleSend. So we DON'T need slice(0,-1) —
      // the user msg isn't in `messages` yet. Previously slice(0,-1) was dropping the
      // previous assistant reply instead, breaking multi-turn context.
      const history = messages
        .filter(m => m.id !== "welcome")
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
        artifact: data.artifact,
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

  // Save-only mutation (no AI extraction, just link file to profile)
  const saveOnlyMutation = useMutation({
    mutationFn: async (payload: {
      fileName: string;
      mimeType: string;
      fileData: string;
      profileIds: string[];
      note?: string;
    }) => {
      const res = await apiRequest("POST", "/api/upload/save-only", payload);
      return res.json();
    },
    onSuccess: (data: {
      documentId: string;
      documentName: string;
      linkedProfiles: Array<{ id: string; name: string }>;
      savedAt: string;
    }) => {
      const profileNames = (data.linkedProfiles || []).map((p) => p.name).filter(Boolean);
      const profileStr =
        profileNames.length > 0 ? ` linked to ${profileNames.join(", ")}` : "";
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Saved **${data.documentName}**${profileStr}. No AI processing applied — you can find it in your Documents anytime.`,
        timestamp: new Date().toISOString(),
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
          content: `Failed to save the file: ${err.message || "Network error"}. Please try again.`,
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
    // After a chat write the server has already busted its response cache, so
    // we must refetch EVERY data query — not a hand-maintained subset — or a
    // logged entry won't appear until the user manually refreshes. A predicate
    // over all "/api/*" keys (excluding heavy binary file fetches) with
    // refetchType:"all" refreshes active AND inactive queries, so the data is
    // fresh whether the user stays on /chat or navigates to /trackers next.
    const isData = (q: any) => {
      const k = String(q.queryKey?.[0] || "");
      return k.startsWith("/api/") && !k.includes("/file");
    };
    // Pass 1 — refetch everything (active + inactive) so any page is fresh.
    queryClient.invalidateQueries({ predicate: isData, refetchType: "all" });
    // Pass 2 — the chat handler finalizes its cross-instance cache-version bump
    // right as the response is sent, so an instant refetch can race it and read
    // pre-write data. A short, light follow-up over only the VISIBLE queries
    // guarantees the current view settles on fresh data without a manual
    // refresh — without firing a second full background storm.
    setTimeout(() => queryClient.invalidateQueries({ predicate: isData, refetchType: "active" }), 1200);
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
      // Partial success: server returns success=false when ANY step failed, but
      // saved[] may still contain things that DID save (e.g. document fields
      // saved, only the tracker write failed). Treat any non-empty saved[] as
      // a successful confirmation — we still show a warning toast so the user
      // knows something fell off.
      const savedSomething = Array.isArray(result.saved) && result.saved.length > 0;
      if (result.success || savedSomething) {
        invalidateAll();
        if (result.success) {
          toast({ title: "Extraction confirmed", description: "Data has been saved." });
        } else {
          toast({
            title: "Saved with warnings",
            description: `Some pieces didn't save: ${Array.isArray(result.failures) ? result.failures.join("; ") : "see logs"}`,
          });
        }
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
      // Truly nothing saved — surface the actual reason from the server.
      const reason = (result.failures && result.failures.length > 0)
        ? result.failures.join("; ")
        : (result.message || result.error || "The server could not save the data.");
      toast({ title: "Extraction failed", description: reason, variant: "destructive" });
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
  }, [messages, chatMutation.isPending, uploadMutation.isPending, batchUploadMutation.isPending, saveOnlyMutation.isPending]);

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

        // ALWAYS process through canvas: applies EXIF rotation AND keeps the
        // upload under Vercel's ~4.5MB body limit. We prefer HIGH resolution and
        // quality so faint document text (e.g. a vet schedule) stays legible for
        // the vision model — degrading the image is a top cause of misreads —
        // and only step down if the encoded size exceeds the budget.
        const img = new Image();
        img.onload = () => {
          const renderAt = (maxDim: number): HTMLCanvasElement => {
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              const scale = maxDim / Math.max(w, h);
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
            ctx.imageSmoothingEnabled = true;
            (ctx as any).imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);
            return canvas;
          };

          const sizeMB = (b64: string) => b64.length * 0.75 / 1024 / 1024;
          const BUDGET_MB = 3.6; // stay safely under Vercel's ~4.5MB request body limit
          // Highest quality first; fall back only if the encoded image is too big.
          const attempts: Array<{ dim: number; q: number }> = [
            { dim: 3072, q: 0.92 },
            { dim: 3072, q: 0.85 },
            { dim: 2048, q: 0.85 },
            { dim: 1600, q: 0.8 },
          ];
          let compressed = '';
          for (const a of attempts) {
            compressed = renderAt(a.dim).toDataURL('image/jpeg', a.q).split(',')[1];
            if (sizeMB(compressed) <= BUDGET_MB) break;
          }
          console.log(`[upload] Image processed: ${img.width}x${img.height} → base64 ${sizeMB(compressed).toFixed(1)}MB`);
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

      // IMMEDIATELY add a placeholder attachment so the 3-button panel shows up
      // right away with the preview. Heavy EXIF/canvas work happens after.
      const previewUrl = URL.createObjectURL(file);
      const isImage = file.type.startsWith('image/');
      const placeholderName = file.name;
      const placeholder: StagedAttachment = {
        name: placeholderName,
        mimeType: isImage ? 'image/jpeg' : file.type,
        data: "",
        previewUrl,
        profileId: "none",
        processing: true,
      };
      setAttachments((prev) => [...prev, placeholder]);

      // Process the file (async) and swap the data in when ready
      (async () => {
        try {
          let base64: string;
          if (isImage) {
            base64 = await correctImageOrientation(file);
          } else {
            base64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve((reader.result as string).split(",")[1]);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
          }
          setAttachments((prev) =>
            prev.map((att) =>
              att.previewUrl === previewUrl && att.processing
                ? { ...att, data: base64, processing: false }
                : att
            )
          );
        } catch (err) {
          console.error(`[upload] Failed to process "${placeholderName}":`, err);
          toast({
            title: `Failed to read "${placeholderName}"`,
            description: "Could not process this image. Try a different photo.",
            variant: "destructive",
          });
          // Remove the failed placeholder so the user can try again
          setAttachments((prev) => prev.filter((att) => att.previewUrl !== previewUrl));
        }
      })();
    }

    // Reset so same file can be selected again
    e.target.value = "";
  };

  // Single file: send using existing upload endpoint
  const handleAttachmentSend = () => {
    if (attachments.length !== 1 || uploadMutation.isPending) return;
    const att = attachments[0];
    if (att.processing || !att.data) {
      toast({ title: "Still preparing the photo… try again in a moment." });
      return;
    }
    const note = input.trim();

    // ✨ If user wrote a Smart Fill intent in the note AND attached a form file,
    // skip the normal upload and open Smart Fill directly. Still post the user
    // message + an assistant chip so there is in-thread context.
    if (note && SMART_FILL_INTENT_RE.test(note) && isFormFile(att.mimeType)) {
      const stripped = att.data.includes(",") ? att.data.split(",").pop() || att.data : att.data;
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: note,
        timestamp: new Date().toISOString(),
        attachment: { name: att.name, mimeType: att.mimeType, data: att.data, previewUrl: att.previewUrl },
      };
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `On it — reading **${att.name}** and matching fields to your saved data. Review every value before saving.`,
        timestamp: new Date().toISOString(),
        smartFillSuggestion: {
          fileName: att.name,
          mimeType: att.mimeType,
          base64: stripped,
          label: att.mimeType.startsWith("image/") ? "Open Smart Fill (image form)" : "Open Smart Fill",
        },
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setSmartFillFile({ name: att.name, mimeType: att.mimeType, base64: stripped });
      setAttachments([]);
      setSelectedProfileId("none");
      setInput("");
      return;
    }

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

  // Save-only handler: store file linked to profile(s) with no AI processing
  const handleSaveOnly = () => {
    if (attachments.length !== 1 || saveOnlyMutation.isPending) return;
    const att = attachments[0];
    if (att.processing || !att.data) {
      toast({ title: "Still preparing the photo… try again in a moment." });
      return;
    }
    const note = input.trim();

    // Resolve profile IDs from per-attachment selection or global selection
    const rawProfileSel = att.profileId !== "none" ? att.profileId : selectedProfileId;
    const profileIds = (rawProfileSel || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((id) => id !== "none");

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: note || `Save to profile: ${att.name}`,
      timestamp: new Date().toISOString(),
      attachment: {
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
        previewUrl: att.previewUrl,
      },
    };
    setMessages((prev) => [...prev, userMsg]);

    saveOnlyMutation.mutate({
      fileName: att.name,
      mimeType: att.mimeType,
      fileData: att.data,
      profileIds,
      note: note || undefined,
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

  // ── Smart Fill intent detection ────────────────────────────────────────────
  // If the user types something like "fill this out" / "smart fill this" /
  // "complete this form for me" and we have a recent PDF or image-of-form
  // attached in the last few user messages, intercept and surface a Smart
  // Fill chip instead of routing to the normal chat call.
  const SMART_FILL_INTENT_RE =
    /(\bsmart\s*fill\b|\bfill\s+(this|that|it|out|in|the\s+form|the\s+pdf)|\bfill\s+for\s+me\b|\bcomplete\s+(this|that|the)\s+(form|pdf)|\bauto[- ]?fill\b|\bcan you fill\b)/i;
  const isFormFile = (mt: string) =>
    mt === "application/pdf" || mt.startsWith("image/");
  const findRecentFormAttachment = () => {
    for (let i = messages.length - 1; i >= 0 && i >= messages.length - 8; i--) {
      const m = messages[i];
      if (m.role === "user" && m.attachment && isFormFile(m.attachment.mimeType)) {
        return m.attachment;
      }
    }
    return null;
  };

  const handleSend = () => {
    const msg = input.trim();
    const isPending = chatMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending || saveOnlyMutation.isPending;
    if (isPending) return;
    if (!msg) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: msg,
      timestamp: new Date().toISOString(),
    };

    // ✨ Smart Fill in-thread: if intent + recent PDF/image attached, surface chip.
    if (SMART_FILL_INTENT_RE.test(msg)) {
      const recent = findRecentFormAttachment();
      if (recent) {
        const stripped = recent.data.includes(",") ? recent.data.split(",").pop() || recent.data : recent.data;
        const isImg = recent.mimeType.startsWith("image/");
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: isImg
            ? `Got it — I'll read **${recent.name}**, match every field to your saved profile data, and show you a review before anything is saved.`
            : `Got it — I'll read **${recent.name}**, match every field to your saved data, then show you a review before generating a filled copy.`,
          timestamp: new Date().toISOString(),
          smartFillSuggestion: {
            fileName: recent.name,
            mimeType: recent.mimeType,
            base64: stripped,
            label: isImg ? "Open Smart Fill (image form)" : "Open Smart Fill",
          },
        };
        setMessages((prev) => [...prev, userMsg, assistantMsg]);
        setInput("");
        // Auto-open the dialog so the user can begin immediately.
        setSmartFillFile({ name: recent.name, mimeType: recent.mimeType, base64: stripped });
        return;
      }
    }

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

  const isPending = chatMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending || saveOnlyMutation.isPending;
  const hasAttachments = attachments.length > 0;
  const isBatch = attachments.length > 1;

  return (
    <div className="flex h-full overflow-x-hidden max-w-full" data-testid="page-chat">
      {/* Chat area */}
      <div className={`flex-1 flex flex-col min-w-0 ${activeArtifact ? 'w-1/2' : 'w-full'} transition-all`}>
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
        <div className={`max-w-2xl mx-auto space-y-4 ${messages.length <= 1 ? 'min-h-[72vh] flex flex-col justify-end' : ''}`}>

          {/* Empty-state brand hero — fills the space above the welcome bubble
              with the Portol logo centred in the middle of the chat page. */}
          {messages.length <= 1 && !searchOpen && (
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-6" data-testid="chat-brand-hero">
              <img
                src="/portol-logo-clean.png"
                alt="Portol"
                className="w-24 h-24 sm:w-28 sm:h-28 object-contain"
                style={{ filter: 'drop-shadow(0 0 24px rgba(0,200,220,0.45))' }}
              />
              <div>
                <p className="text-xl font-bold tracking-tight text-foreground">Portol</p>
                <p className="text-sm text-muted-foreground">Your AI-powered life command center</p>
              </div>
            </div>
          )}

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
              {searchQuery && <button onClick={() => setSearchQuery('')} aria-label="Clear search" className="h-8 w-8 flex items-center justify-center text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
              <button onClick={() => { setSearchOpen(false); setSearchQuery(''); }} className="text-muted-foreground hover:text-foreground text-xs">Done</button>
            </div>
          )}
          {(() => {
            const trimmedQuery = searchQuery.trim();
            const filteredMessages = messages.filter(msg => !trimmedQuery || msg.content.toLowerCase().includes(trimmedQuery.toLowerCase()));
            if (searchOpen && trimmedQuery && filteredMessages.length === 0) {
              return (
                <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground gap-2" data-testid="chat-search-empty">
                  <Search className="h-5 w-5 opacity-60" />
                  <div>No messages match “<span className="font-medium text-foreground">{trimmedQuery}</span>”.</div>
                  <button
                    onClick={() => setSearchQuery('')}
                    className="mt-1 text-xs px-2.5 py-1 rounded-md border border-border/50 hover:bg-muted/60 text-foreground"
                    data-testid="button-chat-search-clear"
                  >
                    Clear search
                  </button>
                </div>
              );
            }
            return null;
          })()}
          {messages
            .filter(msg => !searchQuery.trim() || msg.content.toLowerCase().includes(searchQuery.trim().toLowerCase()))
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
                    {msg.content?.trim() && (
                      <CopyButton value={msg.content} iconOnly className="ml-auto opacity-60 hover:opacity-100" />
                    )}
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

                <div className={`text-sm whitespace-pre-wrap leading-relaxed [&_ul]:ml-4 [&_ol]:ml-4 [&_li]:ml-2 ${msg.role === "user" ? "text-primary-foreground" : "text-foreground"}`}>
                  {msg.content}
                </div>

                {msg.role === "user" && msg.content?.trim() && (
                  <div className="flex justify-end mt-1">
                    <CopyButton
                      value={msg.content}
                      iconOnly
                      className="opacity-60 hover:opacity-100 text-primary-foreground/80 hover:text-primary-foreground hover:bg-primary-foreground/10"
                    />
                  </div>
                )}

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

                {/* Artifact preview card */}
                {(msg as any).artifact && (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`View artifact: ${(msg as any).artifact.title}`}
                    className="mt-2 border border-primary/30 rounded-lg overflow-hidden cursor-pointer"
                    onClick={() => setActiveArtifact((msg as any).artifact)}
                    onKeyDown={onEnterOrSpace(() => setActiveArtifact((msg as any).artifact))}
                  >
                    <div className="flex items-center gap-2 px-3 py-2 bg-primary/5">
                      <BarChart3 className="h-4 w-4 text-primary" />
                      <span className="text-sm font-medium">{(msg as any).artifact.title}</span>
                      <Badge variant="outline" className="text-xs ml-auto">{(msg as any).artifact.type}</Badge>
                    </div>
                    <div className="px-3 py-2 text-xs text-muted-foreground">Click to view artifact</div>
                  </div>
                )}

                {/* Extraction confirmation UI */}
                {msg.pendingExtraction && msg.pendingExtraction.extractedFields.length > 0 && (
                  <ExtractionConfirmation
                    extraction={msg.pendingExtraction}
                    onConfirm={handleConfirmExtraction}
                    onSkip={() => { if (msg.pendingExtraction?.extractionId) handleSkipExtraction(msg.pendingExtraction.extractionId); }}
                  />
                )}

                {/* Smart Fill chip — inline action on assistant message */}
                {msg.smartFillSuggestion && (
                  <button
                    type="button"
                    onClick={() => setSmartFillFile({
                      name: msg.smartFillSuggestion!.fileName,
                      mimeType: msg.smartFillSuggestion!.mimeType,
                      base64: msg.smartFillSuggestion!.base64,
                    })}
                    className="mt-3 w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border border-primary/30 bg-primary/5 hover:bg-primary/10 transition text-left"
                    data-testid="chip-smart-fill"
                  >
                    <Sparkles className="h-4 w-4 text-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{msg.smartFillSuggestion.label || "Open Smart Fill"}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{msg.smartFillSuggestion.fileName}</div>
                    </div>
                    <span className="text-[11px] font-medium text-primary">Open →</span>
                  </button>
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
                      // update_profile is reverted in-place by re-applying previous fields,
                      // not by deleting the row. Detect it separately so the action card can
                      // render a Revert button.
                      const previousState = (action.data as any)?._previousState;
                      const canRevert = action.type === 'update_profile' && !isUndone && previousState && previousState.profileId;
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
                            {/* Edit button — tracker entries only (change duration,
                                intensity, calories; add/remove fields). Persists via the
                                lenient PATCH-by-entry-id endpoint and reflects app-wide. */}
                            {isTrackerEntry && entityId && !isUndone && (
                              <button
                                className="shrink-0 h-7 px-2.5 rounded-lg text-xs font-bold border border-primary/50 text-primary bg-primary/5 hover:bg-primary/15 active:scale-95 transition-all"
                                title="Edit this entry"
                                data-testid={`button-edit-entry-${i}`}
                                onClick={stopProp(() => {
                                  if (editingEntryId === entityId) { setEditingEntryId(null); return; }
                                  const v: Record<string, any> = {};
                                  for (const [k, val] of Object.entries(action.data?.values || {})) { if (k !== "_notes") v[k] = val; }
                                  setEntryEditVals(v);
                                  setEntryNewField({ name: "", value: "" });
                                  setEditingEntryId(entityId);
                                })}
                              >
                                ✎ Edit
                              </button>
                            )}
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
                                    // Optimistically remove from cache (prefix match).
                                    queryClient.setQueriesData({ queryKey: [`/api/${ep}`] }, (old: any) =>
                                      Array.isArray(old) ? old.filter((item: any) => item?.id !== entityId) : old
                                    );
                                    // Surgical invalidation — affected list + dashboard rollups
                                    queryClient.invalidateQueries({ queryKey: [`/api/${ep}`] });
                                    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                                    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
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
                            {/* Revert button — update_profile only. Re-applies the field
                                values that were overwritten so the change is undone in place. */}
                            {canRevert && (
                              <button
                                className="shrink-0 h-7 px-2.5 rounded-lg text-xs font-bold border border-amber-500/50 text-amber-600 bg-amber-500/5 hover:bg-amber-500/15 active:scale-95 transition-all"
                                title="Restore the previous values"
                                data-testid={`button-revert-${action.type}-${i}`}
                                onClick={stopProp(async () => {
                                  const ps = (action.data as any)?._previousState;
                                  if (!ps?.profileId) return;
                                  try {
                                    // Fetch current profile so we can compose a precise revert
                                    // (strip keys that didn't exist before, restore those that did).
                                    const cur = await apiRequest("GET", `/api/profiles/${ps.profileId}`).then(r => r.json());
                                    const restoredFields: Record<string, any> = { ...(cur?.fields || {}) };
                                    // P1 universal-delete: storage now MERGES the incoming `fields`
                                    // onto the existing record (so a missing key is a no-op, not a
                                    // delete). To actually remove keys during a revert we must
                                    // pass them in `fieldsToDelete` instead of relying on shallow
                                    // overwrite. Track keys to delete as we walk the previous state.
                                    const fieldsToDelete: string[] = [];
                                    for (const [k, v] of Object.entries(ps.fields || {})) {
                                      if (v === undefined) {
                                        delete restoredFields[k];
                                        fieldsToDelete.push(k);
                                      } else {
                                        restoredFields[k] = v;
                                      }
                                    }
                                    const body: any = { fields: restoredFields };
                                    if (fieldsToDelete.length > 0) body.fieldsToDelete = fieldsToDelete;
                                    if (ps.notes !== undefined) body.notes = ps.notes;
                                    if (ps.tags !== undefined) body.tags = ps.tags;
                                    if (ps.type !== undefined) body.type = ps.type;
                                    await apiRequest("PATCH", `/api/profiles/${ps.profileId}`, body);
                                    action.data = { ...action.data, _undone: true };
                                    setMessages(prev => prev.map(m => ({
                                      ...m,
                                      actions: m.actions ? [...m.actions] : m.actions,
                                    })));
                                    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
                                    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
                                    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
                                    toast({
                                      title: "Reverted",
                                      description: `Restored ${cur?.name || 'profile'} to its previous state`,
                                    });
                                  } catch {
                                    toast({ title: "Revert failed — try again", variant: "destructive" });
                                  }
                                })}
                              >
                                ↶ Revert
                              </button>
                            )}
                          </div>
                          {/* Inline entry editor — appears under the card when Edit is tapped */}
                          {isTrackerEntry && editingEntryId === entityId && (
                            <div className="mt-1 rounded-xl border border-primary/30 bg-primary/5 p-2.5 space-y-1.5" data-testid={`entry-editor-${i}`}>
                              {Object.keys(entryEditVals).filter((k) => k !== "_notes").map((k) => (
                                <div key={k} className="flex items-center gap-1.5">
                                  <label className="text-[10px] text-muted-foreground w-24 shrink-0 truncate" title={k}>{k}</label>
                                  <input
                                    className="flex-1 h-7 px-2 text-xs rounded bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                                    value={entryEditVals[k] ?? ""}
                                    onChange={(e) => { const val = coerceVal(e.target.value); setEntryEditVals((p) => ({ ...p, [k]: val })); }}
                                    data-testid={`entry-edit-field-${k}`}
                                  />
                                  <button
                                    type="button"
                                    className="p-1 rounded hover:bg-destructive/15"
                                    title={`Remove "${k}"`}
                                    onClick={() => setEntryEditVals((p) => { const n = { ...p }; delete n[k]; return n; })}
                                  >
                                    <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                                  </button>
                                </div>
                              ))}
                              {/* Add a field */}
                              <div className="flex items-center gap-1.5 border-t border-border/40 pt-1.5">
                                <input
                                  className="w-24 h-7 px-2 text-xs rounded bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                                  placeholder="field"
                                  value={entryNewField.name}
                                  onChange={(e) => setEntryNewField((p) => ({ ...p, name: e.target.value }))}
                                />
                                <input
                                  className="flex-1 h-7 px-2 text-xs rounded bg-background border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                                  placeholder="value"
                                  value={entryNewField.value}
                                  onChange={(e) => setEntryNewField((p) => ({ ...p, value: e.target.value }))}
                                  onKeyDown={(e) => { if (e.key === "Enter" && entryNewField.name.trim()) { setEntryEditVals((p) => ({ ...p, [entryNewField.name.trim()]: coerceVal(entryNewField.value) })); setEntryNewField({ name: "", value: "" }); } }}
                                />
                                <button
                                  type="button"
                                  className="shrink-0 h-7 px-2 rounded-lg text-xs font-semibold border border-border hover:bg-muted disabled:opacity-40"
                                  disabled={!entryNewField.name.trim()}
                                  onClick={() => { const name = entryNewField.name.trim(); if (!name) return; setEntryEditVals((p) => ({ ...p, [name]: coerceVal(entryNewField.value) })); setEntryNewField({ name: "", value: "" }); }}
                                >
                                  + Add
                                </button>
                              </div>
                              <div className="flex items-center justify-end gap-1.5">
                                <button type="button" className="h-7 px-2.5 rounded-lg text-xs font-semibold text-muted-foreground hover:bg-muted" onClick={() => setEditingEntryId(null)}>Cancel</button>
                                <button type="button" className="h-7 px-3 rounded-lg text-xs font-bold border border-primary/50 text-primary bg-primary/10 hover:bg-primary/20" onClick={() => saveEntryEdit(action, entityId)} data-testid={`entry-editor-save-${i}`}>Save</button>
                              </div>
                            </div>
                          )}
                          {/* Inline artifact preview */}
                          {isArtifact && (() => {
                            // Find the saved artifact by id (server returns it on the
                            // action) so clicks open the real artifact rather than just
                            // bouncing to the Artifacts list. Fallback: navigate to /artifacts.
                            const aid = (action.data as any)?.id || (action.data as any)?.artifactId;
                            const atype = (action.data as any)?.type;
                            const open = () => {
                              if (atype === "doc" || atype === "sheet") {
                                if (aid) hashNavigate(`/editor/${aid}`);
                                else hashNavigate("/artifacts");
                                return;
                              }
                              // Other types: open the side panel viewer directly when we
                              // have the full payload, else go to /artifacts.
                              if (action.data) setActiveArtifact(action.data as any);
                              else hashNavigate("/artifacts");
                            };
                            return (
                            <div
                              role="button"
                              tabIndex={0}
                              aria-label="Open artifact"
                              className="border border-green-500/25 border-t-0 rounded-b-xl overflow-hidden cursor-pointer"
                              onClick={open}
                              onKeyDown={onEnterOrSpace(open)}
                            >
                              <div className="p-3 max-h-[200px] overflow-hidden relative bg-card">
                                <ArtifactPreview data={action.data} />
                                <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-card to-transparent" />
                              </div>
                              <div className="px-3 py-1.5 bg-muted/30 border-t border-border/30 flex items-center justify-between">
                                <button
                                  className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                                  onClick={(e) => { e.stopPropagation(); open(); }}
                                >
                                  Open artifact →
                                </button>
                                <span className="text-[10px] text-muted-foreground">click anywhere to open</span>
                              </div>
                            </div>
                            );
                          })()}
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

      {/* Suggestions — show on first load, and recall any time the input is empty
          (mid-session) so users can grab a starter prompt again. Hidden while
          composing or when an attachment is staged. */}
      {!hasAttachments && (messages.length <= 1 || input.trim().length === 0) && (
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
          onSaveOnly={handleSaveOnly}
          isSending={uploadMutation.isPending || saveOnlyMutation.isPending}
          onSmartFill={() => {
            const a = attachments[0];
            if (!a) return;
            if (a.processing || !a.data) {
              toast({ title: "Still preparing the photo… try again in a moment." });
              return;
            }
            const stripped = a.data.includes(",") ? a.data.split(",").pop() || a.data : a.data;
            setSmartFillFile({ name: a.name, mimeType: a.mimeType, base64: stripped });
          }}
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
          onSmartFill={(idx) => {
            const a = attachments[idx];
            if (!a) return;
            const stripped = a.data.includes(",") ? a.data.split(",").pop() || a.data : a.data;
            setSmartFillFile({ name: a.name, mimeType: a.mimeType, base64: stripped });
          }}
        />
      )}

      {/* Smart Fill PDF dialog — lazy: only fetch/mount the 600-line dialog once
          the user actually stages a file for Smart Fill */}
      {smartFillFile && (
        <Suspense fallback={null}>
          <SmartFillDialog
            open={!!smartFillFile}
            onOpenChange={(o) => { if (!o) setSmartFillFile(null); }}
            file={smartFillFile}
          />
        </Suspense>
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
                    aria-label="Attach file or image"
                    data-testid="button-attach"
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                  >
                    <Paperclip className="h-4 w-4" />
                  </button>
                  {/* Doc/Sheet creator — opens a popover with two tiles, then
                      navigates to /editor/new/<type>?source=chat. The editor
                      saves to the existing artifacts table; on save it surfaces
                      both as a chat preview card and on the Artifacts page. */}
                  <NewDocSheetButton disabled={isPending} />
                  <button
                    className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                    onClick={() => {
                      // On mobile, opens camera. On desktop where `capture` is
                      // ignored, this falls through to a normal image picker.
                      const camera = document.getElementById('camera-capture') as HTMLInputElement | null;
                      if (camera) {
                        // Reset value so re-selecting the same photo re-fires onChange
                        camera.value = '';
                        camera.click();
                      }
                    }}
                    disabled={isPending}
                    title="Take photo / pick image"
                    aria-label="Take photo or pick image"
                    data-testid="button-camera"
                  >
                    <Camera className="h-4 w-4" />
                  </button>
                  {/* Search button */}
                  <button
                    onClick={() => setSearchOpen(v => !v)}
                    title="Search messages"
                    aria-label="Search messages"
                    data-testid="button-chat-search"
                    className={`h-8 w-8 rounded-lg flex items-center justify-center transition-colors ${
                      searchOpen ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                    }`}
                  >
                    <Search className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => speech.listening ? speech.stop() : speech.start()}
                    title={!speech.supported ? 'Voice input not supported in this browser. Use Chrome or Safari.' : speech.listening ? 'Recording… click to stop' : 'Voice input'}
                    aria-label={speech.listening ? 'Stop recording' : 'Start voice input'}
                    data-testid="button-voice-input"
                    className={`h-8 rounded-lg flex items-center justify-center transition-colors ${
                      speech.listening
                        ? 'px-2 gap-1 text-red-500 bg-red-500/10 ring-1 ring-red-500/40'
                        : 'w-8 ' + (!speech.supported
                          ? 'text-muted-foreground/40 cursor-not-allowed'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60')
                    }`}
                  >
                    {speech.listening ? (
                      <>
                        {/* Animated waveform bars to show the mic is live */}
                        <span className="flex items-end gap-0.5" aria-hidden="true">
                          <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-1" style={{ height: 6 }} />
                          <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-2" style={{ height: 10 }} />
                          <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-3" style={{ height: 14 }} />
                          <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-2" style={{ height: 10 }} />
                          <span className="w-0.5 bg-red-500 rounded-full animate-voice-bar-1" style={{ height: 6 }} />
                        </span>
                        <span className="text-[10px] font-medium uppercase tracking-wide">Rec</span>
                      </>
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
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
                      aria-label="Reset chat"
                      title="Reset chat"
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

      {/* Artifact panel — lazy boundary only mounts when a chat has an artifact
          open, so recharts + the artifact rendering stack stay out of the
          cold-load bundle */}
      {activeArtifact && (
        <div className="w-1/2 border-l border-border">
          <Suspense
            fallback={
              <div className="h-full flex flex-col bg-background border-l border-border" aria-label="Loading artifact panel">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                  <div className="h-4 w-40 rounded bg-muted/60 animate-pulse" />
                  <div className="h-7 w-7 rounded bg-muted/60 animate-pulse" />
                </div>
                <div className="flex-1 p-4 space-y-3">
                  <div className="h-24 rounded-lg bg-muted/40 animate-pulse" />
                  <div className="h-40 rounded-lg bg-muted/40 animate-pulse" />
                  <div className="h-24 rounded-lg bg-muted/40 animate-pulse" />
                </div>
              </div>
            }
          >
            <ArtifactPanel artifact={activeArtifact} onClose={() => setActiveArtifact(null)} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
