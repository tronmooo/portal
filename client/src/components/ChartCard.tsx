// Shared, polished presentation for an AI-generated chart — used both inline in
// chat and in the Artifacts tab so a saved chart looks identical to the one in
// the conversation. Renders: a KPI strip (the headline numbers), the chart
// itself, a "key / notes" panel (provenance + what each value means + gaps), a
// confidence badge, and a Copy button that yields clean paste-able markdown.
import { Suspense, lazy, useState } from "react";
import { BarChart2, ChevronDown, ChevronUp, Copy, Check, Loader2 } from "lucide-react";
import type { ChartSpec2 } from "@/components/ChatChartRenderer";

const ChatChartBody = lazy(() => import("@/components/ChatChartRenderer"));

// Build a clean markdown representation a user can paste anywhere.
export function chartToMarkdown(spec: ChartSpec2): string {
  const lines: string[] = [];
  lines.push(`## ${spec.title}`);
  if (spec.subtitle) lines.push(`_${spec.subtitle}_`);
  if (spec.kpis?.length) {
    lines.push("");
    lines.push(spec.kpis.map(k => `**${k.label}:** ${k.value}`).join("  ·  "));
  }
  // Data table: x-axis column + one column per series.
  const cols = [spec.xAxisKey, ...spec.series.map(s => s.dataKey)];
  const headerLabels = [spec.xAxisLabel || spec.xAxisKey, ...spec.series.map(s => s.name)];
  if (spec.data?.length) {
    lines.push("");
    lines.push(`| ${headerLabels.join(" | ")} |`);
    lines.push(`| ${cols.map(() => "---").join(" | ")} |`);
    for (const row of spec.data) {
      lines.push(`| ${cols.map(c => (row[c] == null ? "—" : row[c])).join(" | ")} |`);
    }
  }
  if (spec.notes?.length) {
    lines.push("");
    for (const n of spec.notes) lines.push(`- ${n}`);
  }
  if (typeof spec.confidence === "number") {
    lines.push("");
    lines.push(`_Confidence: ${Math.round(spec.confidence * 100)}%_`);
  }
  return lines.join("\n");
}

export default function ChartCard({ spec, defaultOpen = true }: { spec: ChartSpec2; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const h = spec.height || 260;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(chartToMarkdown(spec));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — no-op */ }
  };

  const conf = spec.confidence;
  const confClass = conf == null ? "" :
    conf >= 0.75 ? "bg-emerald-500/15 text-emerald-500" :
    conf >= 0.5 ? "bg-amber-500/15 text-amber-500" : "bg-red-500/15 text-red-500";

  return (
    <div className="mt-3 bubble overflow-hidden">
      {/* Header: title + copy + collapse */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} chart: ${spec.title}`}
          className="flex items-center gap-2 min-w-0 text-left"
          onClick={() => setOpen(o => !o)}
        >
          <BarChart2 className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-xs font-semibold truncate">{spec.title}</span>
          {spec.subtitle && <span className="text-xs text-muted-foreground hidden sm:inline truncate">— {spec.subtitle}</span>}
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-muted/40"
            aria-label="Copy chart as text"
          >
            {copied ? <><Check className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
          </button>
          <button type="button" onClick={() => setOpen(o => !o)} aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="px-2 pb-3">
          {/* KPI strip — the headline numbers */}
          {spec.kpis && spec.kpis.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-1 pt-3 pb-1">
              {spec.kpis.map((k, i) => (
                <div key={i} className="rounded-lg bg-muted/40 px-2.5 py-2 min-w-0">
                  <div className="micro-label text-muted-foreground truncate">{k.label}</div>
                  <div className="text-sm font-semibold text-foreground truncate" title={k.value}>{k.value}</div>
                </div>
              ))}
            </div>
          )}

          <Suspense
            fallback={
              <div className="w-full rounded-lg bg-muted/40 animate-pulse flex items-center justify-center" style={{ height: h }} aria-label="Loading chart">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/60" />
              </div>
            }
          >
            <ChatChartBody spec={spec} />
          </Suspense>

          {/* Key / rubric: provenance + coverage + confidence */}
          {((spec.notes && spec.notes.length > 0) || typeof spec.confidence === "number") && (
            <div className="mt-2 px-2 pt-2 border-t border-border/60">
              {typeof spec.confidence === "number" && (
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="micro-label text-muted-foreground">Confidence</span>
                  <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded ${confClass}`}>{Math.round((conf as number) * 100)}%</span>
                </div>
              )}
              {spec.notes?.map((n, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground leading-snug">
                  <span className="text-primary mt-[1px]">•</span>
                  <span>{n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
