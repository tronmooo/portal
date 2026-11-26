// A small picture of what an artifact holds, drawn from its own content —
// never a stock image. Charts draw their real rows (bars, a line or a donut),
// a checklist its first items, a document its first lines, code its first
// lines, a sheet a grid. Pure presentation: no requests, no writes.
import { useMemo } from "react";
import DOMPurify from "dompurify";
import { artifactKind } from "./artifact-kinds";
import { tryParseChartSpec } from "./ArtifactContent";
import { CheckSquare, Square } from "lucide-react";

const PALETTE = ["#3b82f6", "#22c55e", "#a855f7", "#f59e0b", "#ec4899", "#06b6d4"];

/** The numbers a chart artifact would draw, and how. */
export function chartThumbData(src: any): { kind: "bar" | "line" | "pie"; values: number[] } | null {
  const content = typeof src?.content === "string" ? src.content : "";
  const spec = tryParseChartSpec(content);
  let rows: any[] = [];
  let kind: "bar" | "line" | "pie" = "bar";
  let key: string | undefined;
  if (spec) {
    rows = spec.data || [];
    kind = spec.type === "pie" ? "pie" : spec.type === "line" || spec.type === "area" ? "line" : "bar";
    key = (spec.series?.[0] as any)?.dataKey || (spec as any).valueKey;
  } else {
    try { const p = JSON.parse(content); if (Array.isArray(p)) rows = p; } catch { /* not JSON */ }
    if (rows.length === 0 && Array.isArray(src?.chartData)) rows = src.chartData;
    const ct = src?.chartType;
    kind = ct === "pie" ? "pie" : ct === "line" || ct === "area" ? "line" : "bar";
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0] || {};
  const k = key && typeof first[key] === "number" ? key
    : Object.keys(first).find(x => x !== "name" && typeof first[x] === "number");
  if (!k) return null;
  const values = rows.map(r => Number(r?.[k])).filter(v => Number.isFinite(v)).slice(0, 12);
  return values.length ? { kind, values } : null;
}

function MiniChart({ data }: { data: { kind: "bar" | "line" | "pie"; values: number[] } }) {
  const { kind, values } = data;
  if (kind === "pie") {
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let acc = 0;
    const stops = values.slice(0, 6).map((v, i) => {
      const from = (acc / total) * 360; acc += Math.max(0, v);
      const to = (acc / total) * 360;
      return `${PALETTE[i % PALETTE.length]} ${from}deg ${to}deg`;
    }).join(", ");
    return (
      <div className="h-full w-full flex items-center justify-center gap-3">
        <div className="relative h-[70%] aspect-square rounded-full" style={{ background: `conic-gradient(${stops})` }}>
          <div className="absolute inset-[28%] rounded-full bg-card" />
        </div>
        <div className="space-y-1.5">
          {values.slice(0, 3).map((_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: PALETTE[i] }} />
              <span className="h-1 w-8 rounded bg-muted-foreground/30" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  const max = Math.max(...values, 0) || 1;
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  if (kind === "line") {
    const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${100 - ((v - min) / range) * 85 - 7}`).join(" ");
    return (
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
        <defs>
          <linearGradient id="thumb-line" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#3b82f6" stopOpacity="0.35" />
            <stop offset="1" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,100 ${pts} 100,100`} fill="url(#thumb-line)" />
        <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <div className="h-full w-full flex items-end gap-[6%] px-1">
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t-sm"
          style={{
            height: `${Math.max(6, ((v - Math.min(min, 0)) / (max - Math.min(min, 0) || 1)) * 100)}%`,
            background: `linear-gradient(to top, #2563eb, ${i % 3 === 2 ? "#a855f7" : "#60a5fa"})`,
          }}
        />
      ))}
    </div>
  );
}

function textLines(src: any): string[] {
  const type = src?.type;
  let text = typeof src?.content === "string" ? src.content : "";
  if (type === "doc" || type === "html") text = text.replace(/<\/(p|div|h\d|li)>/gi, "\n").replace(/<[^>]+>/g, " ");
  return text
    .split("\n")
    .map((l: string) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`|]/g, "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function ArtifactThumb({ type, source, preview, large, compact, title, className = "" }: {
  /** The artifact's own type (chart, doc, note…), or document/scan. */
  type: string;
  source: any;
  preview?: string;
  large?: boolean;
  /** List row: no icon chip over it, a small title line on top, fills its box. */
  compact?: boolean;
  /** The artifact's title, drawn as that line in compact mode. */
  title?: string;
  className?: string;
}) {
  const kind = artifactKind(type);
  const chart = useMemo(() => (type === "chart" || type === "note" || type === "markdown" ? chartThumbData(source) : null), [type, source]);
  const h = compact ? "h-full" : large ? "h-40" : "h-24";
  const frame = `relative ${h} ${compact ? "" : "w-full"} overflow-hidden rounded-xl border border-white/10 ${compact ? "p-2" : "p-3"} ${className}`;
  // Compact (list row): the icon chip is not drawn over the picture, so the
  // content starts at the top under a one-line title.
  const pad = compact ? "" : "!pt-12";
  const head = compact && title
    ? <p className="text-[11px] font-semibold text-foreground/90 truncate mb-1">{title}</p>
    : null;
  const bg = { background: `linear-gradient(160deg, hsl(${kind.hsl} / 0.16), hsl(${kind.hsl} / 0.04) 60%, transparent)` };

  if (chart) {
    return compact
      ? <div className={`${frame} flex flex-col`} style={bg} aria-hidden>{head}<div className="flex-1 min-h-0"><MiniChart data={chart} /></div></div>
      : <div className={frame} style={bg} aria-hidden><MiniChart data={chart} /></div>;
  }
  if (type === "checklist") {
    const items: { text: string; checked: boolean }[] = Array.isArray(source?.items) && source.items.length
      ? source.items
      : String(source?.content || "").split("\n").filter(Boolean).map((l: string) => ({ text: l.replace(/^\s*(?:[-*]\s*)?\[[ xX]\]\s*/, ""), checked: /\[[xX]\]/.test(l) }));
    return (
      <div className={`${frame} ${pad} space-y-1.5`} style={bg} aria-hidden>
        {head}
        {items.slice(0, large ? 5 : compact ? 3 : 2).map((it, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {it.checked ? <CheckSquare className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <Square className="h-3.5 w-3.5 shrink-0" />}
            <span className={`truncate ${it.checked ? "line-through opacity-70" : ""}`}>{it.text}</span>
          </div>
        ))}
      </div>
    );
  }
  if (type === "code") {
    return (
      <div className={`${frame} ${pad} bg-zinc-950/80`} aria-hidden>
        <pre className="text-[11px] leading-snug font-mono text-emerald-300/80 whitespace-pre overflow-hidden">{String(source?.content || "").split("\n").slice(0, large ? 9 : 5).join("\n")}</pre>
      </div>
    );
  }
  if (type === "svg") {
    const svg = DOMPurify.sanitize(String(source?.content || ""), { USE_PROFILES: { svg: true } });
    return <div className={`${frame} flex items-center justify-center [&_svg]:max-h-full [&_svg]:max-w-full`} style={bg} aria-hidden dangerouslySetInnerHTML={{ __html: svg }} />;
  }
  if (type === "sheet") {
    return (
      <div className={frame} style={bg} aria-hidden>
        <div className="grid grid-cols-4 gap-px h-full rounded-md overflow-hidden bg-emerald-500/20">
          {Array.from({ length: large ? 24 : 12 }, (_, i) => (
            <div key={i} className={i < 4 ? "bg-emerald-500/25" : "bg-card/80"} />
          ))}
        </div>
      </div>
    );
  }
  const lines = textLines(source);
  const Icon = kind.icon;
  return (
    <div className={`${frame} ${lines.length > 0 || preview ? pad : ""}`} style={bg} aria-hidden>
      {lines.length > 0 || preview ? (
        <div className="space-y-1">
          {(lines.length ? lines : [preview || ""]).slice(0, large ? 6 : compact ? 4 : 2).map((l, i) => (
            <p key={i} className={`truncate ${i === 0 ? "text-[11px] font-semibold text-foreground/80" : "text-[11px] text-muted-foreground"}`}>{l}</p>
          ))}
        </div>
      ) : (
        <div className="h-full flex items-center justify-center">
          <Icon className="h-8 w-8 opacity-60" style={{ color: `hsl(${kind.hsl})` }} />
        </div>
      )}
    </div>
  );
}
