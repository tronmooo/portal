import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { SmartFillTrigger } from "@/components/SmartFillTrigger";
import {
  Dialog, DialogContent, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileScope } from "@/hooks/useProfileScope";
import { passesProfileFilter } from "@shared/profile-filter";
import {
  Archive, FileText, BookOpen, Brain, Camera, File, Heart,
  Shield, CreditCard, Scale, Folder, Search, X, Copy, Check as CheckIcon,
  Pin, PinOff, Tag, Trash2, Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import DOMPurify from "dompurify";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import type { Artifact } from "@shared/schema";
import ChartCard from "@/components/ChartCard";
import type { JournalEntry } from "@shared/schema";
import type { Document } from "@shared/schema";
import type { Profile } from "@shared/schema";

// ─── Unified artifact type ──────────────────────────────────
interface UnifiedArtifact {
  id: string;
  title: string;
  type: "document" | "note" | "ai_report" | "scan";
  typeLabel: string;
  date: string;
  preview: string;
  profileName: string;
  source: any;
  // Wave 8: pin + tag metadata. Only artifacts (not Documents) carry these;
  // for Document rows pinned is always false and tags is empty.
  pinned?: boolean;
  tags?: string[];
  /** True for Artifact rows (where we can call PATCH /api/artifacts/:id). */
  isArtifact?: boolean;
}

// ─── Filter tabs ─────────────────────────────────────────────
// "notes" tab removed — journal entries live on their own page (/dashboard/journal)
// and don't belong in the Artifacts list.
type FilterTab = "all" | "documents" | "ai_reports" | "scans";

const FILTER_TABS: { key: FilterTab; label: string; icon: React.ElementType }[] = [
  { key: "all",        label: "All",        icon: Archive },
  { key: "documents",  label: "Documents",  icon: FileText },
  { key: "ai_reports", label: "AI Reports", icon: Brain },
  { key: "scans",      label: "Scans",      icon: Camera },
];

// ─── Document sub-type grouping ─────────────────────────────
const DOC_TYPE_GROUPS: Record<string, { label: string; icon: React.ElementType }> = {
  drivers_license: { label: "Identity", icon: Shield },
  passport:        { label: "Identity", icon: Shield },
  identity:        { label: "Identity", icon: Shield },
  medical_report:  { label: "Medical",  icon: Heart },
  medical:         { label: "Medical",  icon: Heart },
  lab_report:      { label: "Medical",  icon: Heart },
  insurance:       { label: "Insurance", icon: Shield },
  receipt:         { label: "Financial", icon: CreditCard },
  financial:       { label: "Financial", icon: CreditCard },
  legal:           { label: "Legal",     icon: Scale },
  other:           { label: "Other",     icon: Folder },
};

function getDocGroup(docType: string) {
  return DOC_TYPE_GROUPS[docType] || DOC_TYPE_GROUPS.other;
}

// ─── Type icons ──────────────────────────────────────────────
function typeIcon(type: UnifiedArtifact["type"]) {
  switch (type) {
    case "document": return <FileText className="h-4 w-4 text-blue-500" />;
    case "note":     return <BookOpen className="h-4 w-4 text-amber-500" />;
    case "ai_report": return <Brain className="h-4 w-4 text-purple-500" />;
    case "scan":     return <Camera className="h-4 w-4 text-emerald-500" />;
    default:         return <File className="h-4 w-4 text-muted-foreground" />;
  }
}

function typeIconBg(type: UnifiedArtifact["type"]) {
  switch (type) {
    case "document": return "bg-blue-500/10";
    case "note":     return "bg-amber-500/10";
    case "ai_report": return "bg-purple-500/10";
    case "scan":     return "bg-emerald-500/10";
    default:         return "bg-muted/50";
  }
}

// ─── Date formatting ─────────────────────────────────────────
function formatDate(dateStr: string) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

// ─── Mood emoji helper ───────────────────────────────────────
const MOOD_EMOJI: Record<string, string> = {
  amazing: "🤩", great: "😊", good: "🙂", okay: "😐",
  neutral: "😶", bad: "😞", awful: "😢", terrible: "😫",
};

// ─── Artifact Renderers ──────────────────────────────────────
// Round 9 fix: checklist checkboxes were `defaultChecked` with no `onChange`,
// so toggling them never persisted. Now controlled + wired to a mutation.
// `artifactId` is required for the items-array path (uses the server's
// per-item toggle endpoint). For the legacy string-content path we PATCH
// the full content with `[ ]`/`[x]` flipped on the matching line.
function ArtifactRenderer({ artifact, artifactId, isArtifact }: { artifact: any; artifactId?: string; isArtifact?: boolean }) {
  const qc = useQueryClient();

  // Per-item toggle (preferred path — uses structured items[])
  const toggleItemMut = useMutation({
    mutationFn: async ({ id, itemId }: { id: string; itemId: string }) => {
      const res = await apiRequest("POST", `/api/artifacts/${id}/toggle/${itemId}`);
      return res.json();
    },
    onMutate: async ({ id, itemId }) => {
      await qc.cancelQueries({ queryKey: ["/api/artifacts"] });
      const prev = qc.getQueryData<any[]>(["/api/artifacts"]);
      qc.setQueryData<any[]>(["/api/artifacts"], (old) =>
        (old || []).map(a => a.id === id ? {
          ...a,
          items: (a.items || []).map((it: any) => it.id === itemId ? { ...it, checked: !it.checked } : it),
        } : a)
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["/api/artifacts"], ctx.prev); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["/api/artifacts"] }); },
  });

  // Content-string PATCH (legacy `[ ]`/`[x]` checklist)
  const patchContentMut = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      const res = await apiRequest("PATCH", `/api/artifacts/${id}`, { content });
      return res.json();
    },
    onMutate: async ({ id, content }) => {
      await qc.cancelQueries({ queryKey: ["/api/artifacts"] });
      const prev = qc.getQueryData<any[]>(["/api/artifacts"]);
      qc.setQueryData<any[]>(["/api/artifacts"], (old) =>
        (old || []).map(a => a.id === id ? { ...a, content } : a)
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["/api/artifacts"], ctx.prev); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["/api/artifacts"] }); },
  });

  if (!artifact) return null;
  const { type, content, language, dataBindings, items } = artifact;
  const chartType = (artifact as any).chartType as "bar" | "line" | "area" | "pie" | undefined;

  // Handle checklist items array (from Artifact.items)
  if (type === "checklist" && items?.length > 0) {
    return (
      <div className="space-y-1">
        {items.map((item: any, i: number) => (
          <label key={item.id || i} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="rounded"
              checked={!!item.checked}
              disabled={!artifactId || !isArtifact || !item.id}
              onChange={() => {
                if (artifactId && isArtifact && item.id) {
                  toggleItemMut.mutate({ id: artifactId, itemId: item.id });
                }
              }}
            />
            <span className={item.checked ? "line-through text-muted-foreground" : ""}>{item.text}</span>
          </label>
        ))}
      </div>
    );
  }

  switch (type) {
    case "markdown":
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{content || ""}</ReactMarkdown>
        </div>
      );

    case "code":
      return <CodeRenderer content={content || ""} language={language} />;

    case "html":
      return (
        <iframe
          srcDoc={content}
          sandbox=""
          className="w-full h-[400px] rounded-lg border border-border"
          title="HTML Preview"
          referrerPolicy="no-referrer"
        />
      );

    case "svg": {
      const sanitized = DOMPurify.sanitize(content || "", { USE_PROFILES: { svg: true } });
      return <div className="flex justify-center p-4" dangerouslySetInnerHTML={{ __html: sanitized }} />;
    }

    case "mermaid":
      return <MermaidRenderer content={content || ""} />;

    case "chart": {
      // Charts saved from chat embed their full spec (data + KPIs + notes) in
      // `content` — render them with the SAME polished card as the chat, so the
      // saved copy looks identical. Legacy charts fall back to the re-querying
      // ChartRenderer.
      const savedSpec = (() => {
        try { const s = JSON.parse(content || ""); return (s && Array.isArray(s.series) && Array.isArray(s.data)) ? s : null; } catch { return null; }
      })();
      if (savedSpec) return <ChartCard spec={savedSpec} defaultOpen />;
      return <ChartRenderer content={content || ""} dataBindings={dataBindings} chartType={chartType} />;
    }

    case "checklist": {
      const lines = (content || "").split("\n").filter(Boolean);
      return (
        <div className="space-y-1">
          {lines.map((item: string, i: number) => {
            const isChecked = item.startsWith("[x]") || item.startsWith("[X]");
            return (
              <label key={i} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded"
                  checked={isChecked}
                  disabled={!artifactId || !isArtifact}
                  onChange={() => {
                    if (!artifactId || !isArtifact) return;
                    const next = lines.map((ln: string, idx: number) => {
                      if (idx !== i) return ln;
                      if (/^\[[ xX]\]/.test(ln)) {
                        return ln.startsWith("[x]") || ln.startsWith("[X]")
                          ? ln.replace(/^\[[xX]\]/, "[ ]")
                          : ln.replace(/^\[ \]/, "[x]");
                      }
                      // No checkbox prefix — add one (default to checked since user clicked)
                      return `[x] ${ln}`;
                    }).join("\n");
                    patchContentMut.mutate({ id: artifactId, content: next });
                  }}
                />
                <span className={isChecked ? "line-through text-muted-foreground" : ""}>
                  {item.replace(/^\[[ xX]\]\s*/, "")}
                </span>
              </label>
            );
          })}
        </div>
      );
    }

    default: // note
      return <div className="text-sm whitespace-pre-wrap">{content || ""}</div>;
  }
}

function CodeRenderer({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800 text-xs text-zinc-400">
        <span>{language || "code"}</span>
        <button onClick={handleCopy} className="flex items-center gap-1 hover:text-white transition-colors">
          {copied ? <><CheckIcon className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
        </button>
      </div>
      <SyntaxHighlighter language={language || "javascript"} style={oneDark} customStyle={{ margin: 0, borderRadius: 0 }}>
        {content}
      </SyntaxHighlighter>
    </div>
  );
}

// Prefetch the mermaid chunk while the browser is idle so opening a diagram
// artifact doesn't blank for 1–2s on the dynamic import. Call once on page mount.
function prefetchMermaid() {
  const load = () => { import("mermaid").catch(() => { /* offline / chunk error — render path will surface it */ }); };
  if (typeof (window as any).requestIdleCallback === "function") {
    (window as any).requestIdleCallback(load, { timeout: 3000 });
  } else {
    setTimeout(load, 1500);
  }
}

function MermaidRenderer({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const m = await import("mermaid");
        if (cancelled) return;
        m.default.initialize({ startOnLoad: false, theme: "dark" });
        // mermaid.render can throw synchronously OR reject on malformed
        // diagrams — both paths land in this catch instead of crashing/blanking.
        const { svg } = await m.default.render("mermaid-" + Date.now(), content);
        if (ref.current && !cancelled) ref.current.innerHTML = svg;
        if (!cancelled) setLoading(false);
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ? String(e.message) : String(e));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [content]);
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-2" role="alert">
        <p className="text-sm font-medium text-destructive">Couldn't render this diagram</p>
        <p className="text-xs text-muted-foreground break-words">{error}</p>
        <pre className="text-xs font-mono bg-muted/40 rounded p-2 overflow-x-auto max-h-48 whitespace-pre-wrap">{content}</pre>
      </div>
    );
  }
  return (
    <div>
      {loading && (
        <div className="flex flex-col items-center justify-center gap-2 py-10 animate-pulse" aria-label="Rendering diagram">
          <div className="h-32 w-full max-w-md rounded-lg bg-muted/50" />
          <span className="text-xs text-muted-foreground">Rendering diagram…</span>
        </div>
      )}
      <div ref={ref} className="flex justify-center" />
    </div>
  );
}

// Palette used for multi-series charts and pie slices. Tailwind-tinted to match the app.
const CHART_COLORS = [
  "hsl(var(--primary))",
  "hsl(217 91% 60%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(0 84% 60%)",
  "hsl(280 70% 60%)",
];

function ChartRenderer({ content, dataBindings, chartType }: { content: string; dataBindings?: any; chartType?: "bar" | "line" | "area" | "pie" }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // If dataBindings exist, fetch fresh data from the API (with profile isolation)
    if (dataBindings?.tool && dataBindings?.params) {
      setLoading(true);
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(dataBindings.params)) {
        if (v != null) params.set(k, String(v));
      }
      // Profile isolation: dataBindings.params should include profileId
      // This ensures one person's chart can't show another person's data
      apiRequest("POST", "/api/chat", {
        message: `Use the ${dataBindings.tool} tool with params: ${JSON.stringify(dataBindings.params)}`,
        history: []
      }).then(r => r.json()).then(result => {
        // Try to extract chart data from the AI response
        const chartData = result?.charts?.[0]?.data || result?.results?.[0]?.data;
        if (chartData) setData(chartData);
        setLoading(false);
      }).catch(() => {
        setLoading(false);
        // Fallback to static content
        try {
          const parsed = JSON.parse(content);
          setData(Array.isArray(parsed) ? parsed : []);
        } catch { setData([]); }
      });
    } else {
      // No dataBindings — use static content
      try {
        const parsed = JSON.parse(content);
        setData(Array.isArray(parsed) ? parsed : []);
      } catch { setData([]); }
    }
  }, [content, dataBindings]);

  if (loading) return <div className="text-sm text-muted-foreground animate-pulse">Loading chart data...</div>;
  if (data.length === 0) return <div className="text-sm text-muted-foreground">No chart data</div>;

  // Detect series keys: every key on the first row that isn't `name` is a numeric series.
  const first = data[0] || {};
  const seriesKeys = Object.keys(first).filter(k => k !== "name" && typeof first[k] !== "object");
  // If no series keys found (older data with just name/value), fall back to value.
  const series = seriesKeys.length > 0 ? seriesKeys : ["value"];
  const ct = chartType || "bar";

  if (ct === "line") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          {series.length > 1 && <Legend />}
          {series.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }
  if (ct === "area") {
    return (
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          {series.length > 1 && <Legend />}
          {series.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k} stroke={CHART_COLORS[i % CHART_COLORS.length]} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.3} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  if (ct === "pie") {
    // Pie expects a single series; use the first numeric key.
    const key = series[0];
    return (
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={data} dataKey={key} nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }
  // Default: bar (supports multi-series too).
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        {series.length > 1 && <Legend />}
        {series.map((k, i) => (
          <Bar key={k} dataKey={k} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Artifact card ───────────────────────────────────────────
function ArtifactCard({ item, onSelect, onTogglePin, onDelete }: { item: UnifiedArtifact; onSelect?: (item: UnifiedArtifact) => void; onTogglePin?: () => void; onDelete?: () => void }) {
  const handleClick = () => {
    // Doc/sheet Artifact rows route through parent's handleSelect (which sends
    // them to /editor/:id). Legacy Document/scan rows go to /documents/:id. AI
    // reports/charts/code/markdown open the dialog. Notes route to the journal page.
    // Wave 17: every artifact type must do *something* on click — the previous
    // version silently dropped scans and unknown types.
    if (item.type === "document" || item.type === "scan") {
      // Legacy documents/scans (not Artifact rows) live under /documents/:id.
      if (item.isArtifact) onSelect?.(item);
      else hashNavigate(`/documents/${item.id}`);
    } else if (item.type === "note") {
      hashNavigate("/dashboard/journal");
    } else {
      // ai_report, chart, code, markdown, html, react, svg, mermaid, checklist —
      // all open the dialog renderer.
      onSelect?.(item);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      className="p-3 rounded-lg border border-border/50 bg-card hover:bg-accent/5 cursor-pointer transition-colors group"
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      data-testid={`artifact-card-${item.id}`}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-md shrink-0 ${typeIconBg(item.type)}`}>
          {typeIcon(item.type)}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium truncate">{item.title}</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {item.typeLabel} · {formatDate(item.date)}
          </p>
          {item.preview && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.preview}</p>
          )}
          {item.tags && item.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {item.tags.slice(0, 3).map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">#{t}</span>
              ))}
              {item.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">+{item.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0 ml-1">
          {item.profileName && (
            <Badge variant="outline" className="text-xs">
              {item.profileName}
            </Badge>
          )}
          {onTogglePin && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              className={`p-1 rounded transition-opacity ${
                item.pinned ? "text-primary opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100 text-muted-foreground"
              }`}
              title={item.pinned ? "Unpin" : "Pin"}
              aria-label={item.pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
              data-testid={`button-pin-${item.id}`}
            >
              {item.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // Open a controlled AlertDialog instead of window.confirm() —
                // prevents double-fire from rapid clicks and lets us disable
                // the action button while the mutation is in-flight.
                onDelete();
              }}
              className="p-1 rounded opacity-0 group-hover:opacity-70 hover:!opacity-100 hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
              title="Delete"
              aria-label={`Delete ${item.title}`}
              data-testid={`button-delete-${item.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Document group section ──────────────────────────────────
function DocumentGroup({ label, icon: Icon, items, onSelect, onTogglePin, onDelete }: { label: string; icon: React.ElementType; items: UnifiedArtifact[]; onSelect?: (item: UnifiedArtifact) => void; onTogglePin?: (item: UnifiedArtifact) => void; onDelete?: (item: UnifiedArtifact) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(item => (
          <ArtifactCard
            key={`${item.type}-${item.id}`}
            item={item}
            onSelect={onSelect}
            onTogglePin={item.isArtifact && onTogglePin ? () => onTogglePin(item) : undefined}
            onDelete={onDelete ? () => onDelete(item) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────
export default function ArtifactsPage() {
  useEffect(() => { document.title = "Artifacts — Portol"; }, []);
  // Warm the mermaid chunk in the background so opening a diagram is instant.
  useEffect(() => { prefetchMermaid(); }, []);

  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [selectedArtifact, setSelectedArtifact] = useState<UnifiedArtifact | null>(null);
  // For doc/sheet artifacts, route to /editor/:id instead of opening the dialog.
  const handleSelect = (item: UnifiedArtifact) => {
    const t = item.source?.type;
    if (t === "doc" || t === "sheet") {
      hashNavigate(`/editor/${item.id}`);
      return;
    }
    setSelectedArtifact(item);
  };

  // Profile filter — single source of truth, read reactively.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();

  // Wave 8: tag filter (acts as virtual folders).
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Wave 8: pin/unpin mutation. Optimistic update against the artifacts cache.
  const qc = useQueryClient();
  const pinMut = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const res = await apiRequest("PATCH", `/api/artifacts/${id}`, { pinned });
      return res.json();
    },
    onMutate: async ({ id, pinned }) => {
      await qc.cancelQueries({ queryKey: ["/api/artifacts"] });
      const prev = qc.getQueryData<Artifact[]>(["/api/artifacts"]);
      qc.setQueryData<Artifact[]>(["/api/artifacts"], (old) =>
        (old || []).map(a => a.id === id ? { ...a, pinned } : a)
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["/api/artifacts"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
    },
  });

  // Wave 17.1: delete mutation. Routes to the right endpoint based on whether
  // the row is an Artifact (notes/AI reports/docs/sheets/checklists) or a
  // legacy Document/scan.
  const deleteMut = useMutation({
    mutationFn: async (item: UnifiedArtifact) => {
      const url = item.isArtifact ? `/api/artifacts/${item.id}` : `/api/documents/${item.id}`;
      await apiRequest("DELETE", url);
      return item;
    },
    onMutate: async (item) => {
      const key = item.isArtifact ? ["/api/artifacts"] : ["/api/documents"];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<any[]>(key);
      qc.setQueryData<any[]>(key, (old) => (old || []).filter(a => a.id !== item.id));
      return { prev, key };
    },
    onError: (_err, _item, ctx) => {
      if (ctx?.prev && ctx?.key) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, item) => {
      qc.invalidateQueries({ queryKey: item?.isArtifact ? ["/api/artifacts"] : ["/api/documents"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      // Dashboard "Recent" / artifacts widgets read from /api/dashboard-enhanced —
      // include it so the deleted row disappears from the dashboard too.
      qc.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
    onSuccess: () => { setPendingDelete(null); },
  });
  // Controlled AlertDialog state — replaces window.confirm() so rapid double
  // clicks can’t race past the modal and trigger two deletes.
  const [pendingDelete, setPendingDelete] = useState<UnifiedArtifact | null>(null);
  const handleDelete = (item: UnifiedArtifact) => setPendingDelete(item);

  // Fetch all three data sources in parallel
  const { data: documents = [], isLoading: docsLoading } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  // Journal entries deliberately NOT fetched here — they have their own page.
  const { data: artifacts = [], isLoading: artifactsLoading } = useQuery<Artifact[]>({
    queryKey: ["/api/artifacts"],
    queryFn: () => apiRequest("GET", "/api/artifacts").then(r => r.json()),
  });

  // Fetch profiles for name resolution
  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const profileMap = useMemo(() => {
    const map: Record<string, string> = {};
    profiles.forEach(p => { map[p.id] = p.name; });
    return map;
  }, [profiles]);

  // Helper to resolve first linked profile name
  const resolveProfile = (linkedProfiles?: string[]) => {
    if (!linkedProfiles || linkedProfiles.length === 0) return "";
    return profileMap[linkedProfiles[0]] || "";
  };

  // Merge all into unified list
  const allItems = useMemo(() => {
    const items: UnifiedArtifact[] = [
      ...documents
        .filter(d => !d.deletedAt)
        .map(d => ({
          id: d.id,
          title: d.title || d.name,
          type: (d.mimeType?.startsWith("image/") ? "scan" : "document") as UnifiedArtifact["type"],
          typeLabel: d.mimeType?.startsWith("image/")
            ? "Scan"
            : (getDocGroup(d.type).label || "Document"),
          date: d.createdAt,
          preview: d.extractedData
            ? Object.entries(d.extractedData).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(" · ").slice(0, 100)
            : "",
          profileName: resolveProfile(d.linkedProfiles),
          source: d,
          pinned: false,
          tags: Array.isArray((d as any).tags) ? ((d as any).tags as string[]) : [],
          isArtifact: false,
        })),
      ...artifacts.map(a => ({
        id: a.id,
        title: a.title,
        // Doc/Sheet behave more like documents than "AI Reports"; tag them so
        // they show up in the Documents tab too.
        type: (a.type === "doc" || a.type === "sheet" ? "document" : "ai_report") as "document" | "ai_report",
        typeLabel: a.type === "checklist" ? "Checklist"
                 : a.type === "doc" ? "Document"
                 : a.type === "sheet" ? "Spreadsheet"
                 : "AI Note",
        date: a.createdAt,
        preview: a.type === "doc"
          ? (a.content?.replace(/<[^>]+>/g, " ").trim().slice(0, 100) || "")
          : a.type === "sheet"
            ? `${a.sheetData?.rows ?? 0} × ${a.sheetData?.cols ?? 0} grid`
            : (a.content?.slice(0, 100) || (a.items?.length > 0 ? a.items.map(i => i.text).join(", ").slice(0, 100) : "")),
        profileName: resolveProfile(a.linkedProfiles),
        source: a,
        pinned: !!a.pinned,
        tags: Array.isArray(a.tags) ? a.tags : [],
        isArtifact: true,
      })),
    ];
    return items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [documents, artifacts, profileMap]);

  // Apply profile filter. P2.4 remediation: use the unified passesProfileFilter
  // rule (shared/profile-filter.ts) instead of an inline `linked.some(...)` so
  // orphan items (no linkedProfiles) still show when the selection includes a
  // self profile — matching finance/journal/server semantics.
  const profileFiltered = useMemo(() => {
    if (filterMode === "everyone" || filterIds.length === 0) return allItems;
    const ctx = {
      selectedIds: filterIds,
      allProfiles: profiles.map(p => ({ id: p.id, type: p.type })),
    };
    return allItems.filter(item => passesProfileFilter(item.source?.linkedProfiles, ctx));
  }, [allItems, filterMode, filterIds, profiles]);

  // Apply tab filter
  const tabFiltered = useMemo(() => {
    switch (activeTab) {
      case "documents": return profileFiltered.filter(i => i.type === "document");
      case "ai_reports": return profileFiltered.filter(i => i.type === "ai_report");
      case "scans":     return profileFiltered.filter(i => i.type === "scan");
      default:          return profileFiltered;
    }
  }, [profileFiltered, activeTab]);

  // Wave 8: apply tag filter (case-insensitive). When a tag is selected we
  // restrict to items carrying that tag — acts as a virtual folder.
  const tagFiltered = useMemo(() => {
    if (!activeTag) return tabFiltered;
    const t = activeTag.toLowerCase();
    return tabFiltered.filter(i => (i.tags || []).some(x => x.toLowerCase() === t));
  }, [tabFiltered, activeTag]);

  // Apply search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return tagFiltered;
    const q = search.toLowerCase();
    return tagFiltered.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.typeLabel.toLowerCase().includes(q) ||
      i.preview.toLowerCase().includes(q) ||
      i.profileName.toLowerCase().includes(q) ||
      (i.tags || []).some(t => t.toLowerCase().includes(q))
    );
  }, [tagFiltered, search]);

  // Wave 8: pinned shelf items — always drawn from the post-profile list so it
  // honors the active profile filter, but ignores tab/tag/search so users can
  // always see their pins.
  const pinnedItems = useMemo(
    () => profileFiltered.filter(i => i.pinned),
    [profileFiltered],
  );

  // Wave 8: aggregate the tag universe (sorted by frequency desc) for the
  // filter chip strip. Drawn from profile-filtered items so chip counts match
  // what's actually selectable.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of profileFiltered) {
      for (const t of (i.tags || [])) {
        if (!t) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }));
  }, [profileFiltered]);

  const isLoading = docsLoading || artifactsLoading;

  // Group documents by type when Documents tab is active
  const documentGroups = useMemo(() => {
    if (activeTab !== "documents") return null;
    const groups: Record<string, UnifiedArtifact[]> = {};
    const order = ["Identity", "Medical", "Insurance", "Financial", "Legal", "Other"];
    for (const item of filtered) {
      const src = item.source as Document;
      const group = getDocGroup(src.type || "other");
      if (!groups[group.label]) groups[group.label] = [];
      groups[group.label].push(item);
    }
    return order.filter(l => groups[l]?.length > 0).map(l => ({
      label: l,
      icon: Object.values(DOC_TYPE_GROUPS).find(g => g.label === l)?.icon || Folder,
      items: groups[l],
    }));
  }, [filtered, activeTab]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Artifacts</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {profileFiltered.length} items · Documents, notes & AI reports in one place
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SmartFillTrigger />
          <MultiProfileFilter
            onChange={() => {}}
            compact
          />
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search artifacts..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9 h-9"
          data-testid="input-artifacts-search"
        />
        {search && (
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
            onClick={() => setSearch("")}
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
        {FILTER_TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const Icon = tab.icon;
          const count = tab.key === "all"
            ? profileFiltered.length
            : profileFiltered.filter(i =>
                tab.key === "documents" ? i.type === "document" :
                tab.key === "ai_reports" ? i.type === "ai_report" :
                tab.key === "scans" ? i.type === "scan" : true
              ).length;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              }`}
              data-testid={`filter-${tab.key}`}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
              <span className={`text-xs ${isActive ? "text-primary-foreground/70" : "text-muted-foreground/60"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Wave 8: Tag filter chip strip (virtual folders) */}
      {allTags.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide items-center">
          <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
          <button
            onClick={() => setActiveTag(null)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              activeTag === null
                ? "bg-primary/10 text-primary border border-primary/30"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 border border-transparent"
            }`}
            data-testid="tag-filter-all"
          >
            All tags
          </button>
          {allTags.slice(0, 24).map(({ tag, count }) => {
            const isActive = activeTag?.toLowerCase() === tag.toLowerCase();
            return (
              <button
                key={tag}
                onClick={() => setActiveTag(isActive ? null : tag)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted/70 border border-transparent"
                }`}
                data-testid={`tag-filter-${tag}`}
              >
                #{tag}
                <span className="text-muted-foreground/70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Wave 8: Pinned artifacts shelf (horizontal scroll) */}
      {pinnedItems.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 px-1">
            <Pin className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Pinned</span>
            <span className="text-[11px] text-muted-foreground">({pinnedItems.length})</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
            {pinnedItems.map(item => (
              <div key={`pinned-${item.id}`} className="shrink-0 w-64">
                <ArtifactCard
                  item={item}
                  onSelect={handleSelect}
                  onTogglePin={item.isArtifact ? () => pinMut.mutate({ id: item.id, pinned: !item.pinned }) : undefined}
                  onDelete={() => handleDelete(item)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={search ? Search : Archive}
          title={search ? "No results found" : "No artifacts yet"}
          description={
            search
              ? `Nothing matches "${search}". Try a different search term.`
              : "Upload documents, write journal entries, or chat with AI to generate reports."
          }
        />
      ) : activeTab === "documents" && documentGroups ? (
        // Documents tab: grouped by type
        <div className="space-y-5">
          {documentGroups.map(g => (
            <DocumentGroup
              key={g.label}
              label={g.label}
              icon={g.icon}
              items={g.items}
              onSelect={handleSelect}
              onTogglePin={(item) => pinMut.mutate({ id: item.id, pinned: !item.pinned })}
              onDelete={handleDelete}
            />
          ))}
        </div>
      ) : (
        // All other tabs: flat grid sorted by date
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(item => (
            <ArtifactCard
              key={`${item.type}-${item.id}`}
              item={item}
              onSelect={handleSelect}
              onTogglePin={item.isArtifact ? () => pinMut.mutate({ id: item.id, pinned: !item.pinned }) : undefined}
              onDelete={() => handleDelete(item)}
            />
          ))}
        </div>
      )}

      {/* Artifact detail dialog — re-derive from allItems so optimistic
          cache updates (e.g. checklist toggles) reflect immediately in the
          open dialog instead of being frozen at click time. */}
      {(() => {
        const liveSelected = selectedArtifact
          ? (allItems.find(it => it.id === selectedArtifact.id) || selectedArtifact)
          : null;
        return (
          <Dialog open={!!selectedArtifact} onOpenChange={() => setSelectedArtifact(null)}>
            <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
              <DialogTitle>{liveSelected?.title}</DialogTitle>
              {liveSelected?.source && (
                <div className="mt-2">
                  <div className="flex items-center gap-2 mb-4">
                    <Badge variant="outline" className="text-xs">{liveSelected.source.type}</Badge>
                    {liveSelected.profileName && (
                      <Badge variant="secondary" className="text-xs">{liveSelected.profileName}</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{formatDate(liveSelected.date)}</span>
                  </div>
                  <ArtifactRenderer
                    artifact={liveSelected.source}
                    artifactId={liveSelected.id}
                    isArtifact={liveSelected.isArtifact}
                  />
                </div>
              )}
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* Controlled delete confirmation — replaces window.confirm() so rapid
          double-clicks can’t race the modal. Action button is disabled while
          the mutation is pending. */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => { if (!o && !deleteMut.isPending) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the file and any history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMut.isPending}
              onClick={(e) => { e.preventDefault(); if (pendingDelete) deleteMut.mutate(pendingDelete); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-artifact-delete-confirm"
            >
              {deleteMut.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
