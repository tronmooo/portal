// The form's pages, drawn with PDF.js, each with a layer on top for the
// fields (client/src/pages/workspace-fill.tsx). A field's box is a fraction
// of its page, so the layer needs nothing but the page's own size.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { loadPdfjs } from "@/components/PdfCanvas";
import type { TextPage } from "@shared/fill-fields";

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const bin = atob(clean.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A PDF's text layer, as the server's blank-finder reads it (top-left origin, page units). */
export async function extractTextPages(base64: string, maxPages = 40): Promise<TextPage[]> {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: base64ToBytes(base64) }).promise;
  const pages: TextPage[] = [];
  try {
    for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        width: vp.width, height: vp.height,
        items: (content.items as any[]).filter((it) => typeof it.str === "string" && it.str.trim() !== "").slice(0, 6000)
          .map((it) => ({ str: it.str, x: it.transform[4], y: vp.height - it.transform[5] - it.height, w: it.width, h: it.height })),
      });
    }
  } finally { void pdf.destroy(); }
  return pages;
}

export interface PageBox { widthPx: number; heightPx: number }

export function FillPdfPages({
  base64, overlay, maxWidth = 900,
}: {
  base64: string;
  /** The field layer for one page. */
  overlay: (pageIndex: number, box: PageBox) => ReactNode;
  maxWidth?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const pdfRef = useRef<any>(null);
  const [sizes, setSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(maxWidth, Math.floor(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        const pdf = await pdfjs.getDocument({ data: base64ToBytes(base64) }).promise;
        if (cancelled) { void pdf.destroy(); return; }
        const out: Array<{ w: number; h: number }> = [];
        for (let i = 1; i <= pdf.numPages; i++) { const vp = (await pdf.getPage(i)).getViewport({ scale: 1 }); out.push({ w: vp.width, h: vp.height }); }
        if (cancelled) { void pdf.destroy(); return; }
        pdfRef.current?.destroy?.();
        pdfRef.current = pdf;
        setSizes(out);
        setStatus("ready");
      } catch { if (!cancelled) setStatus("error"); }
    })();
    return () => { cancelled = true; };
  }, [base64]);
  useEffect(() => () => { pdfRef.current?.destroy?.(); }, []);

  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || status !== "ready" || width <= 0) return;
    let cancelled = false;
    const tasks: any[] = [];
    (async () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 0; i < sizes.length; i++) {
        const canvas = canvases.current[i];
        if (!canvas || cancelled) continue;
        const page = await pdf.getPage(i + 1);
        const vp = page.getViewport({ scale: (width / sizes[i].w) * dpr });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const task = page.render({ canvasContext: ctx, viewport: vp });
        tasks.push(task);
        try { await task.promise; } catch { /* a newer render replaced this one */ }
      }
    })();
    return () => { cancelled = true; tasks.forEach((t) => { try { t.cancel(); } catch { /* done */ } }); };
  }, [sizes, width, status]);

  return (
    <div ref={host} className="w-full" data-testid="fill-pages">
      {status === "loading" && <p className="p-6 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Opening the form…</p>}
      {status === "error" && <p className="p-6 text-xs text-destructive flex items-center gap-2"><AlertCircle className="h-4 w-4" /> This file could not be shown. Its fields are still listed under "List".</p>}
      {status === "ready" && width > 0 && sizes.map((s, i) => {
        const heightPx = (width * s.h) / s.w;
        return (
          <div key={i} className="relative mx-auto mb-3 bg-white shadow-sm border border-border" style={{ width, height: heightPx }} data-testid={`fill-page-${i}`} data-fill-page={i}>
            <canvas ref={(el) => { canvases.current[i] = el; }} className="absolute inset-0 w-full h-full" />
            <div className="absolute inset-0">{overlay(i, { widthPx: width, heightPx })}</div>
          </div>
        );
      })}
    </div>
  );
}
