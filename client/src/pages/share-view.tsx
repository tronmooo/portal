// Public read-only share viewer for artifacts. No auth required — server returns
// only artifacts whose metadata.shareToken matches the URL token. Renders docs
// (sanitized HTML), sheets (read-only react-spreadsheet), notes/markdown/code,
// and checklists. Print/PDF works via the browser's native dialog.
import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import DOMPurify from "dompurify";
import Spreadsheet from "react-spreadsheet";
import { Loader2, Printer } from "lucide-react";
import { decodeSheetData, sheetCellDisplayValue } from "@shared/sheet-data";

interface PublicArtifact {
  id: string;
  type: string;
  title: string;
  content: string;
  items: Array<{ id?: string; text: string; checked: boolean; order?: number }>;
  language?: string;
  sheetData?: { rows: number; cols: number; cells: Record<string, { v?: any; f?: string }> };
  chartData?: any[];
  createdAt: string;
  updatedAt: string;
}

function sheetToMatrix(sd: PublicArtifact["sheetData"]) {
  if (!sd) return [];
  const decoded = decodeSheetData(sd);
  const rows: Array<Array<{ value: any }>> = [];
  for (let r = 0; r < decoded.rows; r++) {
    const row: Array<{ value: any }> = [];
    for (let c = 0; c < decoded.cols; c++) {
      row.push({ value: sheetCellDisplayValue(decoded.cells[`${r},${c}`]) });
    }
    rows.push(row);
  }
  return rows;
}

export default function ShareViewPage() {
  const [match, params] = useRoute<{ token: string }>("/share/:token");
  const token = match ? params?.token : undefined;
  const [artifact, setArtifact] = useState<PublicArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/public/artifacts/${encodeURIComponent(token)}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
        return r.json();
      })
      .then(data => { if (!cancelled) { setArtifact(data); setError(null); } })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (artifact?.title) document.title = `${artifact.title} · Portol`;
  }, [artifact?.title]);

  const cleanHtml = useMemo(() => {
    if (!artifact || artifact.type !== "doc") return "";
    return DOMPurify.sanitize(artifact.content || "", {
      ADD_ATTR: ["target", "rel"],
    });
  }, [artifact]);

  const sheetMatrix = useMemo(() => sheetToMatrix(artifact?.sheetData), [artifact?.sheetData]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error || !artifact) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <div className="text-lg font-semibold mb-2">This link isn't available</div>
          <div className="text-sm text-muted-foreground">
            {error === "Not found" ? "The share link was revoked or never existed." : (error || "Unable to load this artifact.")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b print:hidden">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Shared via Portol</div>
            <div className="font-semibold truncate">{artifact.title}</div>
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border hover:bg-muted"
            data-testid="button-share-print"
          >
            <Printer className="h-4 w-4" />
            Print / Save as PDF
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold mb-6 print:mb-4">{artifact.title}</h1>

        {artifact.type === "doc" && (
          <div
            className="prose prose-sm sm:prose max-w-none"
            dangerouslySetInnerHTML={{ __html: cleanHtml }}
          />
        )}

        {artifact.type === "sheet" && artifact.sheetData && (
          <div className="overflow-auto rounded border">
            <Spreadsheet
              data={sheetMatrix as any}
              onChange={() => {}}
              className="readonly-sheet"
            />
          </div>
        )}

        {(artifact.type === "note" || artifact.type === "markdown") && (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{artifact.content}</pre>
        )}

        {artifact.type === "code" && (
          <pre className="rounded bg-muted p-4 text-xs overflow-auto">
            <code>{artifact.content}</code>
          </pre>
        )}

        {artifact.type === "checklist" && (
          <ul className="space-y-2">
            {(artifact.items || []).map((it, i) => (
              <li key={it.id || i} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!it.checked} disabled className="opacity-70" />
                <span className={it.checked ? "line-through text-muted-foreground" : ""}>{it.text}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-12 pt-6 border-t text-xs text-muted-foreground print:hidden">
          Last updated {new Date(artifact.updatedAt).toLocaleString()} · This is a read-only public view.
        </div>
      </main>
    </div>
  );
}
