// A real preview of an uploaded document for the Artifacts lists: a PDF's first
// page, a photo or scan as itself. The bytes come through the authenticated
// blob loader every viewer uses (`useDocumentBlobUrl`, shared LRU cache), and
// only once the card is on screen — a long library does not download every
// file on open. A file that was not kept, a kind that has no picture, or a
// failed load falls back to the drawn preview (`fallback`). Reads only.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { classifyDocument, documentHasFile, useDocumentBlobUrl } from "@/lib/document-preview";

const PdfCanvas = lazy(() => import("@/components/PdfCanvas"));

/** True once the element has come within ~200px of the viewport. */
function useNearViewport<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Whether a document row can be drawn as its own picture. */
export function documentHasPicture(doc: any): boolean {
  const kind = classifyDocument(doc?.mimeType || "");
  return (kind === "pdf" || kind === "image") && documentHasFile(doc);
}

export function DocumentThumb({ doc, className = "", fallback }: {
  doc: { id: string; mimeType?: string; [k: string]: any };
  className?: string;
  fallback: React.ReactNode;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const kind = classifyDocument(doc.mimeType || "");
  const can = documentHasPicture(doc);
  const file = useDocumentBlobUrl(doc.id, doc.mimeType || "", undefined, can && near);
  if (!can || file.error) return <>{fallback}</>;
  return (
    <div
      ref={ref}
      className={`relative overflow-hidden rounded-xl border border-white/10 bg-white ${className}`}
      aria-hidden
      data-testid={`doc-thumb-${doc.id}`}
    >
      {kind === "image" && file.url ? (
        <img src={file.url} alt="" className="h-full w-full object-cover object-top" draggable={false} loading="lazy" />
      ) : kind === "pdf" && file.blob ? (
        <Suspense fallback={null}>
          {/* Page 1 only, at the box's width; the box shows its top. */}
          <div className="pointer-events-none [&_canvas]:!mb-0 [&_canvas]:!shadow-none [&_canvas]:!rounded-none">
            <PdfCanvas blob={file.blob} maxPages={1} />
          </div>
        </Suspense>
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted/40">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
