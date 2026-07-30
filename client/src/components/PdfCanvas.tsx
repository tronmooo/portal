// Cross-platform PDF renderer.
//
// Mobile WebKit (iOS Safari / WKWebView, which every iOS browser uses) refuses
// to render PDFs inside <iframe>/<object> — the embed just shows blank white.
// The only reliable way to display a PDF inline on every platform is to
// rasterize it with PDF.js onto <canvas> elements, which is what this does.
//
// PDF.js (pdfjs-dist) is heavy (~1MB), so it's loaded lazily the first time a
// PDF is actually viewed. The PDF bytes are passed in directly (via the Blob),
// so PDF.js never fetches a URL — that keeps it clear of the app's strict
// `connect-src` CSP, and the worker is a same-origin bundled asset
// (`worker-src 'self'`).

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";

// Lazy, memoized PDF.js loader. Resolves the library with its worker wired up.
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist");
      // Vite resolves `?url` to a hashed, same-origin asset path.
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })().catch((e) => {
      // Reset so a later mount can retry after a transient chunk-load failure.
      pdfjsPromise = null;
      throw e;
    });
  }
  return pdfjsPromise;
}

/**
 * Start loading PDF.js + its worker before any PDF bytes have arrived.
 *
 * Called from `preloadPdfRenderer()` the moment we know a PDF is about to be
 * viewed, so the ~1MB chunk downloads in parallel with the file instead of
 * after it.
 */
export function preloadPdfjs() {
  loadPdfjs().catch(() => { /* best-effort warm-up; render() retries + reports */ });
}

export default function PdfCanvas({
  blob,
  className,
}: {
  blob: Blob;
  /** Extra classes for the canvas host (e.g. spacing). */
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const seqRef = useRef(0);
  const lastWidthRef = useRef(0);

  const render = useCallback(async () => {
    const host = hostRef.current;
    if (!host) return;
    const seq = ++seqRef.current;
    const width = host.clientWidth || host.parentElement?.clientWidth || 600;
    lastWidthRef.current = width;
    setStatus("loading");

    try {
      const pdfjs = await loadPdfjs();
      const buf = await blob.arrayBuffer();
      if (seq !== seqRef.current) return;

      const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
      if (seq !== seqRef.current) { pdf.destroy(); return; }

      const numPages = pdf.numPages;
      // Cap backing-store resolution so a high-DPI phone doesn't allocate huge
      // canvases for a many-page document.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      // PERF: pages are appended AS THEY RASTERIZE and the spinner clears after
      // page 1. The previous version buffered every page into a fragment and
      // swapped it in at the end, so a 10-page PDF showed nothing but a spinner
      // until the last page finished — even though page 1 was ready in a
      // fraction of that. Time-to-first-page is what the reader actually feels.
      for (let n = 1; n <= numPages; n++) {
        const page = await pdf.getPage(n);
        if (seq !== seqRef.current) { pdf.destroy(); return; }
        const base = page.getViewport({ scale: 1 });
        const fitScale = Math.max(width / base.width, 0.1);
        const viewport = page.getViewport({ scale: fitScale * dpr });

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = "100%";
        canvas.style.height = "auto";
        canvas.style.display = "block";
        canvas.className = "mb-3 bg-white rounded shadow-sm";
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        await page.render({ canvasContext: ctx, viewport }).promise;
        if (seq !== seqRef.current) { pdf.destroy(); return; }
        // First page replaces whatever the previous render left behind; the
        // rest stream in underneath it.
        if (n === 1) {
          host.replaceChildren(canvas);
          setStatus("ready");
        } else {
          host.appendChild(canvas);
          // Yield between pages so scrolling/pinching the page already on
          // screen stays responsive while the tail of the document renders.
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          if (seq !== seqRef.current) { pdf.destroy(); return; }
        }
      }

      pdf.destroy();
      if (seq !== seqRef.current) return;
      setStatus("ready");
    } catch (e) {
      console.error("[PdfCanvas] failed to render PDF:", e);
      if (seq === seqRef.current) setStatus("error");
    }
  }, [blob]);

  useEffect(() => { render(); }, [render]);

  // Re-render at a new width on orientation/resize so text stays crisp.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth || 0;
      if (Math.abs(w - lastWidthRef.current) < 24) return; // ignore minor jitter
      clearTimeout(t);
      t = setTimeout(() => render(), 250);
    });
    ro.observe(host);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [render]);

  return (
    <div className="w-full">
      <div ref={hostRef} className={className} />
      {status === "loading" && (
        <div className="flex items-center justify-center py-10 text-muted-foreground" data-testid="pdf-canvas-loading">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
      {status === "error" && (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground" data-testid="pdf-canvas-error">
          <AlertCircle className="h-8 w-8" />
          <p className="text-xs">Couldn't render this PDF inline.</p>
        </div>
      )}
    </div>
  );
}
