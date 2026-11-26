// The one renderer for a saved artifact's body — used by the Artifacts tab,
// the full-screen viewer opened from chat, and the public share page, so an
// artifact looks (and behaves) the same wherever it is opened.
//
// Interactive where the artifact is: a checklist's boxes are written to the
// stored row (the server's per-item toggle — Rule 6), a chart has tooltips and
// a chart-type switch (a view, never saved), an HTML artifact runs in a
// sandboxed frame with scripts but no access to this origin, code copies.
// Opening one writes nothing (Rule 3).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { copyText } from "@/lib/clipboard";
import { Copy, Check as CheckIcon, CheckCircle2, Circle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// The async-light build: the full Prism entry bundles every refractor
// grammar (582KB of the 659KB artifacts chunk) and evaluating it stalled the
// main thread for ~350ms on every open of this page, diagram or not. The
// light build ships no grammars and fetches the one a code artifact needs.
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import DOMPurify from "dompurify";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import ChartCard from "@/components/ChartCard";
import type { ChartSpec2 } from "@/components/ChatChartRenderer";
import { decodeSheetData, sheetCellDisplayValue } from "@shared/sheet-data";

// ─── Chart-spec coercion ─────────────────────────────────────
// BUG-2 fix: some artifacts (e.g. the "Weight Trend" AI Note) store a full
// chart spec as their `content` JSON but carry a non-"chart" DB type, so the
// renderer's default branch used to dump the raw `{"type":"line",...}` string
// on screen. Detect that shape and route it to the same polished ChartCard the
// chat uses. Falls back to null (→ text summary) when the content isn't a chart.
const CHART_SPEC_TYPES = new Set(["line", "bar", "area", "pie", "scatter", "composed", "radar"]);

export function coerceChartSpec(raw: any): ChartSpec2 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!CHART_SPEC_TYPES.has(raw.type)) return null;
  if (!Array.isArray(raw.data) || raw.data.length === 0) return null;
  const xAxisKey = raw.xAxisKey || raw.nameKey || "name";
  let series = Array.isArray(raw.series) ? raw.series : [];
  // Older/partial specs saved without an explicit series list: synthesize one
  // from the numeric keys on the first row so the chart still renders.
  if (series.length === 0 && raw.type !== "pie") {
    const first = raw.data[0] || {};
    series = Object.keys(first)
      .filter(k => k !== xAxisKey && typeof first[k] === "number")
      .map(k => ({ dataKey: k, name: k }));
    if (series.length === 0) {
      const vk = raw.valueKey || "value";
      series = [{ dataKey: vk, name: vk }];
    }
  }
  return { ...raw, series, xAxisKey, title: raw.title || "Chart" } as ChartSpec2;
}

export function tryParseChartSpec(content: string): ChartSpec2 | null {
  if (!content) return null;
  const t = content.trim();
  if (!t.startsWith("{")) return null;
  try { return coerceChartSpec(JSON.parse(t)); } catch { return null; }
}

// Human-readable card preview. For chart-spec notes this yields the chart's
// title/subtitle instead of the raw JSON blob (BUG-2).
export function previewForContent(content?: string | null): string {
  if (!content) return "";
  const spec = tryParseChartSpec(content);
  if (spec) return [spec.title, spec.subtitle].filter(Boolean).join(" — ").slice(0, 100);
  return content.slice(0, 100);
}

// ─── Artifact Renderers ──────────────────────────────────────
// Round 9 fix: checklist checkboxes were `defaultChecked` with no `onChange`,
// so toggling them never persisted. Now controlled + wired to a mutation.
// `artifactId` is required for the items-array path (uses the server's
// per-item toggle endpoint). For the legacy string-content path we PATCH
// the full content with `[ ]`/`[x]` flipped on the matching line.
// `readOnly` (the public share page) draws the same body with nothing to tap.
export function ArtifactContent({ artifact, artifactId, isArtifact, readOnly, fill }: {
  artifact: any;
  artifactId?: string;
  isArtifact?: boolean;
  readOnly?: boolean;
  /** Full-screen viewer: frames (HTML) take the height they are given. */
  fill?: boolean;
}) {
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
        old ? old.map(a => a.id === id ? {
          ...a,
          items: (a.items || []).map((it: any) => it.id === itemId ? { ...it, checked: !it.checked } : it),
        } : a) : old
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
        old ? old.map(a => a.id === id ? { ...a, content } : a) : old
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["/api/artifacts"], ctx.prev); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["/api/artifacts"] }); },
  });

  if (!artifact) return null;
  const { type, content, language, dataBindings, items } = artifact;
  const chartType = (artifact as any).chartType as "bar" | "line" | "area" | "pie" | undefined;
  const canWrite = !readOnly && !!artifactId && !!isArtifact;

  // Handle checklist items array (from Artifact.items)
  if (type === "checklist" && items?.length > 0) {
    return (
      <ChecklistView
        items={items.map((item: any, i: number) => ({ key: item.id || String(i), text: item.text, checked: !!item.checked, canToggle: canWrite && !!item.id }))}
        onToggle={(i) => {
          const item = items[i];
          if (canWrite && item?.id) toggleItemMut.mutate({ id: artifactId!, itemId: item.id });
        }}
      />
    );
  }

  switch (type) {
    case "markdown":
    // ai_report is markdown too — it used to fall through to `default` and
    // render as pre-wrapped text, so every table came out as raw pipes.
    case "ai_report":
      return <Markdown content={content || ""} />;

    case "code":
      return <CodeRenderer content={content || ""} language={language} />;

    case "html":
      // Scripts run so an HTML artifact (a calculator, a mini app) is usable,
      // but WITHOUT allow-same-origin: the frame is an opaque origin and can
      // reach neither this page, its storage nor the signed-in session.
      return (
        <iframe
          srcDoc={content}
          sandbox="allow-scripts allow-forms allow-modals"
          className={`w-full rounded-xl border border-border bg-white ${fill ? "h-[calc(100dvh-11rem)] min-h-[420px]" : "h-[420px]"}`}
          title="HTML artifact"
          referrerPolicy="no-referrer"
          data-testid="artifact-html-frame"
        />
      );

    case "svg": {
      const sanitized = DOMPurify.sanitize(content || "", { USE_PROFILES: { svg: true } });
      return <div className="flex justify-center p-4 [&_svg]:max-w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: sanitized }} />;
    }

    case "mermaid":
      return <MermaidRenderer content={content || ""} />;

    case "chart": {
      // Charts saved from chat embed their full spec (data + KPIs + notes) in
      // `content` — render them with the SAME polished card as the chat, so the
      // saved copy looks identical. Legacy charts fall back to the re-querying
      // ChartRenderer.
      const savedSpec = tryParseChartSpec(content || "");
      if (savedSpec) return <ChartCard spec={savedSpec} defaultOpen />;
      return <ChartRenderer content={content || ""} dataBindings={dataBindings} chartType={chartType} chartData={(artifact as any).chartData} />;
    }

    case "doc": {
      // A generated document is sanitized HTML (the editor's own list, W10).
      const html = DOMPurify.sanitize(content || "", { USE_PROFILES: { html: true } });
      if (!html.replace(/<[^>]+>/g, "").trim()) return <p className="text-sm text-muted-foreground">This document is empty.</p>;
      return (
        <div
          className="prose prose-sm dark:prose-invert max-w-none rounded-xl bg-card/60 border border-border/60 p-4 sm:p-6 [&_img]:max-w-full [&_table]:w-full"
          data-testid="artifact-doc-html"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }

    case "sheet":
      return <SheetTable sheetData={(artifact as any).sheetData} />;

    case "checklist": {
      const lines = (content || "").split("\n").filter(Boolean);
      return (
        <ChecklistView
          items={lines.map((ln: string, i: number) => ({
            key: String(i),
            text: ln.replace(/^\s*(?:[-*]\s*)?\[[ xX]\]\s*/, ""),
            checked: /^\s*(?:[-*]\s*)?\[[xX]\]/.test(ln),
            canToggle: canWrite,
          }))}
          onToggle={(i) => {
            if (!canWrite) return;
            const next = lines.map((ln: string, idx: number) => {
              if (idx !== i) return ln;
              if (/\[[xX]\]/.test(ln)) return ln.replace(/\[[xX]\]/, "[ ]");
              if (/\[ \]/.test(ln)) return ln.replace(/\[ \]/, "[x]");
              // No checkbox prefix — add one (checked, since the user tapped it)
              return `[x] ${ln}`;
            }).join("\n");
            patchContentMut.mutate({ id: artifactId!, content: next });
          }}
        />
      );
    }

    default: { // note
      // BUG-2: an AI Note may actually hold a chart spec in its content. Render
      // it as a chart rather than leaking the raw JSON; fall back to text.
      const chartSpec = tryParseChartSpec(content || "");
      if (chartSpec) return <ChartCard spec={chartSpec} defaultOpen />;
      // Notes are authored as plain text OR markdown and we can't tell which,
      // so render markdown: plain text passes through unchanged, and a note
      // that does contain a table or heading no longer shows its syntax.
      return <Markdown content={content || ""} />;
    }
  }
}

// A checklist with its progress. Each row is a real button when the stored
// row can be written; otherwise (share page, unsaved preview) it only shows.
function ChecklistView({ items, onToggle }: {
  items: { key: string; text: string; checked: boolean; canToggle: boolean }[];
  onToggle: (index: number) => void;
}) {
  const done = items.filter(i => i.checked).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return (
    <div className="space-y-3" data-testid="artifact-checklist">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs font-medium text-muted-foreground tabular-nums">{done} of {items.length} done</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={item.key}>
            <button
              type="button"
              disabled={!item.canToggle}
              onClick={() => onToggle(i)}
              aria-pressed={item.checked}
              className={`w-full flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                item.checked ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/60 bg-card/40 hover:bg-muted/40"
              } disabled:cursor-default`}
              data-testid={`artifact-checklist-item-${i}`}
            >
              {item.checked
                ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                : <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />}
              <span className={item.checked ? "line-through text-muted-foreground" : ""}>{item.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A spreadsheet artifact, read as a table (the editor is where it is changed).
function SheetTable({ sheetData }: { sheetData: any }) {
  const decoded = useMemo(() => decodeSheetData(sheetData), [sheetData]);
  // Draw only the used area: the last row/column that holds a value.
  let maxR = -1, maxC = -1;
  for (const key of Object.keys(decoded.cells || {})) {
    const [r, c] = key.split(",").map(Number);
    if (sheetCellDisplayValue(decoded.cells[key]) !== "") { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
  }
  if (maxR < 0) return <p className="text-sm text-muted-foreground">This spreadsheet is empty.</p>;
  const rows = Math.min(maxR + 1, 500);
  const cols = Math.min(maxC + 1, 50);
  const colName = (c: number) => { let s = ""; let n = c + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  return (
    <div className="overflow-auto rounded-xl border border-border max-h-[70dvh]" data-testid="artifact-sheet-table">
      <table className="text-xs border-collapse min-w-full">
        <thead className="sticky top-0 bg-muted">
          <tr>
            <th className="w-8 border border-border px-1.5 py-1 text-muted-foreground font-medium" />
            {Array.from({ length: cols }, (_, c) => (
              <th key={c} className="border border-border px-2 py-1 text-muted-foreground font-medium">{colName(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              <td className="border border-border px-1.5 py-1 text-muted-foreground text-center bg-muted/50">{r + 1}</td>
              {Array.from({ length: cols }, (_, c) => (
                <td key={c} className="border border-border px-2 py-1 whitespace-nowrap">{sheetCellDisplayValue(decoded.cells[`${r},${c}`])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Markdown artifacts arrive from the AI with GFM tables — without remark-gfm
// those render as literal pipe characters, which is what the 2026-07-25 audit
// saw. Tables get explicit classes because Tailwind Typography styles them
// only when the `prose` plugin's table styles aren't reset by the app theme.
export function Markdown({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none" data-testid="artifact-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-muted/50 px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1 align-top">{children}</td>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline">{children}</a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeRenderer({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void copyText(content);
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
export function prefetchMermaid() {
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

function staticChartRows(content: string, chartData?: any[]): any[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch { /* not JSON */ }
  return Array.isArray(chartData) ? chartData : [];
}

const CHART_KINDS = ["bar", "line", "area", "pie"] as const;

function ChartRenderer({ content, dataBindings, chartType, chartData }: { content: string; dataBindings?: any; chartType?: "bar" | "line" | "area" | "pie"; chartData?: any[] }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // The chart-type switch is a VIEW of the same rows — never saved.
  const [kind, setKind] = useState<(typeof CHART_KINDS)[number]>(chartType || "bar");

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
        setData(staticChartRows(content, chartData));
      });
    } else {
      // No dataBindings — use static content
      setData(staticChartRows(content, chartData));
    }
  }, [content, dataBindings, chartData]);

  if (loading) return <div className="text-sm text-muted-foreground animate-pulse">Loading chart data...</div>;
  if (data.length === 0) return <div className="text-sm text-muted-foreground">No chart data</div>;

  // Detect series keys: every key on the first row that isn't `name` is a numeric series.
  const first = data[0] || {};
  const seriesKeys = Object.keys(first).filter(k => k !== "name" && typeof first[k] !== "object");
  // If no series keys found (older data with just name/value), fall back to value.
  const series = seriesKeys.length > 0 ? seriesKeys : ["value"];
  const ct = kind;
  const switcher = (
    <div className="flex gap-1 mb-3" role="group" aria-label="Chart type" data-swipe-ignore>
      {CHART_KINDS.map(k => (
        <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
          className={`px-2.5 py-1 rounded-full text-xs font-medium capitalize transition-colors ${kind === k ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground hover:bg-muted"}`}>
          {k}
        </button>
      ))}
    </div>
  );

  if (ct === "line") {
    return (
    <>{switcher}
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
    </>
    );
  }
  if (ct === "area") {
    return (
    <>{switcher}
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
    </>
    );
  }
  if (ct === "pie") {
    // Pie expects a single series; use the first numeric key.
    const key = series[0];
    return (
    <>{switcher}
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={data} dataKey={key} nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
            {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </>
    );
  }
  // Default: bar (supports multi-series too).
  return (
  <>{switcher}
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
  </>
  );
}
