import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import EditableTitle from "@/components/EditableTitle";
import { DocumentLinkPicker } from "@/components/DocumentLinkPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stopProp } from "@/lib/event-utils";
import { stringifyField, previewUnrenderable, isLineItemArray, formatLineItem } from "@/lib/field-display";
import {
  FileText,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  Share2,
  Mail,
  MessageSquare,
  X,
  Maximize2,
  Minimize2,
  Plus,
  Check,
  AlertCircle,
  Clock,
  ShieldCheck,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { fieldExpiryStatus } from "@shared/date-rules";
import { getUserToday } from "@shared/timezone";
import { cn } from "@/lib/utils";
import {
  useDocumentBlobUrl,
  wasFileDiscarded,
  DISCARDED_FILE_TAG,
  classifyDocument,
  DOCUMENT_UPLOAD_ACCEPT,
  prefetchDocument,
  invalidateDocumentBlob,
} from "@/lib/document-preview";

// PDF.js renderer is code-split — only pulled in when a PDF is actually viewed.
const PdfCanvas = lazy(() => import("@/components/PdfCanvas"));

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocumentViewerProps {
  id: string;
  name: string;
  mimeType: string;
  data: string; // base64
  inline?: boolean; // true = render inside chat bubble, false = card style
  compact?: boolean; // smaller version for lists
}

interface Document {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  fileData: string; // base64
  extractedData: Record<string, any>;
  linkedProfiles: string[];
  tags: string[];
  createdAt: string;
}

interface Profile {
  id: string;
  name: string;
  type: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatFieldLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^\s/, "")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getExpirationStatus(key: string, value: any): "expired" | "soon" | "valid" | null {
  return fieldExpiryStatus(key, value, getUserToday(BROWSER_TIMEZONE));
}

function ExpirationBadge({ status }: { status: "expired" | "soon" | "valid" }) {
  if (status === "expired") {
    return (
      <Badge variant="destructive" className="text-xs px-1.5 py-0 gap-1">
        <AlertCircle className="h-2.5 w-2.5" />
        EXPIRED
      </Badge>
    );
  }
  if (status === "soon") {
    return (
      <Badge className="text-xs px-1.5 py-0 gap-1 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30">
        <Clock className="h-2.5 w-2.5" />
        Expiring Soon
      </Badge>
    );
  }
  return (
    <Badge className="text-xs px-1.5 py-0 gap-1 bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30">
      <ShieldCheck className="h-2.5 w-2.5" />
      Valid
    </Badge>
  );
}

function getDocTypeBadgeColor(type: string): string {
  const map: Record<string, string> = {
    drivers_license: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
    passport: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
    medical_report: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
    insurance: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
    receipt: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    other: "bg-muted text-muted-foreground",
  };
  return map[type] || map.other;
}

// ─── Shared logic ─────────────────────────────────────────────────────────────

function useDocumentShare() {
  const { toast } = useToast();

  const shareViaEmail = (name: string, id: string) => {
    const subject = encodeURIComponent(`Document: ${name}`);
    const body = encodeURIComponent(
      `Here is the document "${name}" from Portol.\n\nView it in the app or download the attached file.`
    );
    window.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
    toast({ title: "Email client opened", description: `Sharing "${name}" via email` });
  };

  const shareViaSMS = (name: string, id: string) => {
    const body = encodeURIComponent(`Check out this document from Portol: "${name}"`);
    window.open(`sms:?body=${body}`, "_blank");
    toast({ title: "Messaging opened", description: `Sharing "${name}" via text` });
  };

  const downloadDoc = async (name: string, mimeType: string, data: string, id?: string) => {
    try {
      let href: string;
      let revoke: string | null = null;
      const hasInline = data && data !== "__LAZY_LOAD__" && data.length > 0;
      if (hasInline) {
        href = `data:${mimeType};base64,${data}`;
      } else if (id) {
        // No inline base64 (lazy-loaded doc) — pull the binary from the
        // authenticated endpoint and download via a blob URL.
        const blob = await apiRequest("GET", `/api/documents/${id}/file`).then((r) => r.blob());
        href = URL.createObjectURL(blob);
        revoke = href;
      } else {
        toast({ title: "Download unavailable", description: name, variant: "destructive" });
        return;
      }
      const link = document.createElement("a");
      link.href = href;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      if (revoke) setTimeout(() => URL.revokeObjectURL(revoke!), 10_000);
      toast({ title: "Download started", description: name });
    } catch {
      toast({ title: "Download failed", description: name, variant: "destructive" });
    }
  };

  return { shareViaEmail, shareViaSMS, downloadDoc };
}

// ─── Share button ─────────────────────────────────────────────────────────────

export function ShareButton({
  id,
  name,
  mimeType,
  data,
  size = "sm",
}: {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  size?: "sm" | "icon" | "default";
}) {
  const { shareViaEmail, shareViaSMS, downloadDoc } = useDocumentShare();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          className="gap-1.5"
          data-testid={`btn-share-${id}`}
        >
          <Share2 className="h-3.5 w-3.5" />
          {size !== "icon" && <span className="text-xs">Share</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onClick={() => shareViaEmail(name, id)}
          data-testid={`btn-share-email-${id}`}
        >
          <Mail className="h-4 w-4 mr-2" />
          Send via Email
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => shareViaSMS(name, id)}
          data-testid={`btn-share-sms-${id}`}
        >
          <MessageSquare className="h-4 w-4 mr-2" />
          Send via Text
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => downloadDoc(name, mimeType, data, id)}
          data-testid={`btn-download-${id}`}
        >
          <Download className="h-4 w-4 mr-2" />
          Download
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Zoom + pan viewer logic (shared) ─────────────────────────────────────────

function useViewerControls() {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.1, 5)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.1, 0.25)), []);
  const resetZoom = useCallback(() => {
    setZoom(1);
    setTranslate({ x: 0, y: 0 });
    setRotation(0);
  }, []);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  // Debounced wheel zoom — accumulate delta to prevent hyper-sensitivity
  const wheelAccum = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      wheelAccum.current += e.deltaY;
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        if (wheelAccum.current < -30) zoomIn();
        else if (wheelAccum.current > 30) zoomOut();
        wheelAccum.current = 0;
      }, 80);
    },
    [zoomIn, zoomOut]
  );

  const lastTouchDist = useRef<number | null>(null);
  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastTouchDist.current !== null) {
          const diff = dist - lastTouchDist.current;
          if (diff > 15) zoomIn();
          else if (diff < -15) zoomOut();
        }
        lastTouchDist.current = dist;
      }
    },
    [zoomIn, zoomOut]
  );
  const handleTouchEnd = useCallback(() => {
    lastTouchDist.current = null;
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom > 1) {
        setIsDragging(true);
        setDragStart({ x: e.clientX - translate.x, y: e.clientY - translate.y });
      }
    },
    [zoom, translate]
  );
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        setTranslate({
          x: e.clientX - dragStart.x,
          y: e.clientY - dragStart.y,
        });
      }
    },
    [isDragging, dragStart]
  );
  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  return {
    zoom, rotation, expanded, setExpanded,
    isDragging, translate,
    zoomIn, zoomOut, resetZoom, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  };
}

// ─── DocumentViewer (main export) ─────────────────────────────────────────────

export default function DocumentViewer({
  id,
  name,
  mimeType,
  data,
  inline = false,
  compact = false,
}: DocumentViewerProps) {
  const kind = classifyDocument(mimeType);
  const isImage = kind === "image";
  const isPdf = kind === "pdf";
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    zoom, rotation, expanded, setExpanded,
    isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  } = useViewerControls();

  // Everything is rendered from a same-origin blob: URL — required because the
  // CSP only allows `frame-src`/`object-src` of `'self' blob:` (PDFs embed via
  // <object>/<iframe>), and because native <img>/<object> loads can't carry the
  // bearer token the /file endpoint needs. The hook decodes inline base64
  // locally when available, else fetches the authenticated /file endpoint.
  const { url: blobUrl, blob, loading: blobLoading, error: blobError } =
    useDocumentBlobUrl(id, mimeType, data);
  const dataUrl = blobUrl || "";

  const downloadFromBlob = useCallback(async () => {
    // Images render from the phone-sized preview variant — a download must
    // deliver the ORIGINAL bytes, so pull them from the plain /file endpoint.
    if (id && isImage) {
      try {
        const orig = await apiRequest("GET", `/api/documents/${id}/file`).then((r) => r.blob());
        const href = URL.createObjectURL(orig);
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
        return;
      } catch { /* fall back to the rendered blob below */ }
    }
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [dataUrl, name, id, isImage]);

  const ZoomControls = () => (
    <div className="flex items-center gap-1 bg-background/90 backdrop-blur-sm rounded-lg border border-border p-1 shadow-sm">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={zoomOut}
        disabled={zoom <= 0.25}
        data-testid={`btn-zoom-out-${id}`}
        aria-label="Zoom out"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <span className="text-xs font-mono w-12 text-center tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={zoomIn}
        disabled={zoom >= 5}
        data-testid={`btn-zoom-in-${id}`}
        aria-label="Zoom in"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
      <div className="w-px h-4 bg-border mx-0.5" />
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={rotate}
        data-testid={`btn-rotate-${id}`}
        aria-label="Rotate"
      >
        <RotateCw className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setExpanded(!expanded)}
        aria-label={expanded ? "Exit full screen" : "Expand to full screen"}
        data-testid={`btn-expand-${id}`}
      >
        {expanded ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );

  // Wave 11: Image renderer scales to fit its container (object-contain) so a
  // tall mobile screenshot never pushes the dialog past the viewport. The
  // wrapper fills its parent's height and the image scales down to fit — prior
  // version used `w-full h-auto` which caused vertical overflow whenever the
  // image's aspect ratio was taller than the available box.
  const renderImage = (maxH: string) => (
    <div
      ref={containerRef}
      className={`relative overflow-hidden rounded-lg bg-muted/30 flex items-center justify-center ${
        isDragging ? "cursor-grabbing" : zoom > 1 ? "cursor-grab" : ""
      }`}
      style={{ height: "100%", maxHeight: maxH, minHeight: inline ? 0 : "200px" }}
      onWheel={handleWheel}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <img
        src={dataUrl}
        alt={name}
        className="max-w-full max-h-full w-auto h-auto object-contain transition-transform duration-150"
        style={{
          transform: `scale(${zoom}) rotate(${rotation}deg) translate(${translate.x / zoom}px, ${translate.y / zoom}px)`,
          transformOrigin: "center center",
        }}
        draggable={false}
      />
    </div>
  );

  const renderPdf = (maxH: string) => (
    <div
      ref={containerRef}
      className="relative rounded-lg bg-muted/30 flex flex-col"
      style={{ height: maxH }}
    >
      {/* Scrollable page column — PdfCanvas rasterizes every page so it renders
          identically on iOS/Android/desktop (native <iframe> PDF is blank on
          iOS WebKit). Zoom is applied via CSS transform on the inner column. */}
      <div className="flex-1 min-h-0 overflow-auto p-2 flex justify-center">
        <div
          className="transition-transform duration-150"
          style={{
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
            transformOrigin: "top center",
            width: "100%",
            maxWidth: 900,
          }}
        >
          {blob ? (
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              }
            >
              <PdfCanvas blob={blob} />
            </Suspense>
          ) : (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
        </div>
      </div>
      {/* Always-available escape hatch (esp. mobile): open the PDF full-screen
          in the OS PDF viewer, or download it. */}
      {dataUrl && (
        <div className="shrink-0 flex items-center justify-center gap-2 border-t border-border/60 bg-background/60 px-2 py-1.5">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" asChild>
            <a href={dataUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              Open full screen
            </a>
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={downloadFromBlob}>
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
        </div>
      )}
    </div>
  );

  // Unified content renderer — handles loading/error first, then dispatches to
  // the type-specific renderer. PDFs render from a same-origin blob: URL (CSP
  // allows object/frame 'self' blob:); non-previewable types fall back to a
  // download/open card; text renders inline.
  const renderPreview = (maxH: string) => {
    if (blobError) {
      return (
        <NonRenderablePreview
          name={name}
          mimeType={mimeType}
          kind={kind}
          blobUrl={null}
          loadFailed
          onDownload={downloadFromBlob}
        />
      );
    }
    if (!dataUrl) {
      return (
        <div className="h-full min-h-[160px] flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      );
    }
    if (isImage) return renderImage(maxH);
    if (isPdf) return renderPdf(maxH);
    return (
      <NonRenderablePreview
        name={name}
        mimeType={mimeType}
        kind={kind}
        blobUrl={dataUrl}
        onDownload={downloadFromBlob}
      />
    );
  };

  // Inline mode (inside chat bubble or document dialog)
  if (inline) {
    // Fill the parent container — the dialog (or chat bubble) decides the
    // height. Using a hardcoded 480px here caused the image to overflow the
    // dialog's preview half. "100%" lets the renderImage flex box scale the
    // <img> via object-contain.
    const maxH = expanded ? "85vh" : "100%";
    return (
      <div
        className="rounded-xl overflow-hidden border border-border bg-muted/10 flex flex-col h-full"
        data-testid={`doc-viewer-${id}`}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium truncate">{name}</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ZoomControls />
            <ShareButton id={id} name={name} mimeType={mimeType} data={data} size="icon" />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {renderPreview(maxH)}
        </div>
      </div>
    );
  }

  // Card mode
  return (
    <div
      className="bubble overflow-hidden"
      data-testid={`doc-card-${id}`}
    >
      <div className="relative">
        {isImage && dataUrl && (
          <div className="overflow-hidden" style={{ maxHeight: compact ? "120px" : "200px" }}>
            <img
              src={dataUrl}
              alt={name}
              className="w-full h-auto object-cover"
              draggable={false}
            />
          </div>
        )}
        {isImage && !dataUrl && (
          <div className="h-24 bg-muted/30 flex items-center justify-center">
            {blobError
              ? <FileText className="h-10 w-10 text-muted-foreground" />
              : <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
          </div>
        )}
        {isPdf && (
          <div className="h-24 bg-muted/30 flex items-center justify-center">
            <FileText className="h-10 w-10 text-red-500/60" />
          </div>
        )}
        {!isImage && !isPdf && (
          <div className="h-24 bg-muted/30 flex items-center justify-center">
            <FileText className="h-10 w-10 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium truncate">{name}</p>
          <p className="text-xs text-muted-foreground uppercase">{isPdf ? "PDF" : mimeType.split("/")[1]}</p>
        </div>
        <ShareButton id={id} name={name} mimeType={mimeType} data={data} size="icon" />
      </div>
    </div>
  );
}

// ─── NonRenderablePreview ─────────────────────────────────────────────────────
// Renderer for anything the browser can't show in an <img>/<iframe>: Office
// docs, archives, unknown binaries (download/open card) and text-like files
// (rendered inline). Also used as the error state for any document whose blob
// failed to load.

function NonRenderablePreview({
  name,
  mimeType,
  kind,
  blobUrl,
  loadFailed = false,
  onDownload,
}: {
  name: string;
  mimeType: string;
  kind: "image" | "pdf" | "text" | "other";
  blobUrl: string | null;
  loadFailed?: boolean;
  onDownload: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState(false);

  useEffect(() => {
    if (kind !== "text" || !blobUrl) { setText(null); return; }
    let cancelled = false;
    setTextError(false);
    fetch(blobUrl)
      .then((r) => r.text())
      // Cap at ~200KB so a huge log/csv can't lock the main thread on render.
      .then((t) => { if (!cancelled) setText(t.length > 200_000 ? t.slice(0, 200_000) + "\n…(truncated)" : t); })
      .catch(() => { if (!cancelled) setTextError(true); });
    return () => { cancelled = true; };
  }, [blobUrl, kind]);

  if (kind === "text" && !loadFailed) {
    if (textError) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
          <AlertCircle className="h-8 w-8" />
          <p className="text-sm">Couldn't read this text file.</p>
        </div>
      );
    }
    if (text == null) {
      return (
        <div className="h-full min-h-[160px] flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      );
    }
    return (
      <ScrollArea className="h-full w-full">
        <pre className="text-xs whitespace-pre-wrap break-words p-4 font-mono leading-relaxed">{text}</pre>
      </ScrollArea>
    );
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="preview-nonrenderable">
      {loadFailed
        ? <AlertCircle className="h-12 w-12 text-muted-foreground" />
        : <FileText className="h-12 w-12 text-muted-foreground" />}
      <div>
        <p className="text-sm font-medium break-words">{name}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{mimeType || "Unknown type"}</p>
      </div>
      <p className="text-xs text-muted-foreground max-w-xs">
        {loadFailed
          ? "This file couldn't be loaded for preview. You can still download it."
          : "This file type can't be previewed in the browser. Download or open it to view."}
      </p>
      <div className="flex items-center gap-2">
        {blobUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" asChild>
            <a href={blobUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </a>
          </Button>
        )}
        {blobUrl && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onDownload}>
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── DocumentViewerDialog ─────────────────────────────────────────────────────

export function DocumentViewerDialog({
  open,
  onOpenChange,
  id,
  name,
  mimeType,
  data,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string;
  name: string;
  mimeType: string;
  data: string;
}) {
  // liveName tracks the displayed title locally so the rename feels
  // instant even before parent caches invalidate. Synced from `name`
  // when it changes from the outside.
  const [liveName, setLiveName] = useState<string>(name);
  useEffect(() => { setLiveName(name); }, [name]);
  const { toast } = useToast();

  // PERF: the binary download and the PDF.js chunk start the instant the dialog
  // opens — in parallel with the metadata query below, and without waiting for
  // the viewer subtree to mount. Previously the chain was strictly serial
  // (metadata → file → renderer chunk → first page), so the user watched a
  // spinner through three round-trips they could have paid for at once.
  useEffect(() => {
    if (open && id) prefetchDocument(id, mimeType);
  }, [open, id, mimeType]);

  // Metadata (extracted fields, type, whether a binary exists). Served without
  // the binary, and cached by React Query so reopening the same document
  // renders its details immediately instead of re-fetching every time.
  const { data: meta, isLoading: metaLoading } = useQuery<any>({
    queryKey: ["/api/documents", id],
    queryFn: () => apiRequest("GET", `/api/documents/${id}`).then((r) => r.json()),
    enabled: open && !!id,
    staleTime: 60_000,
  });

  // Locally attached file (see the "Attach a file" flow below) wins over the
  // server's answer until the query refetches.
  const [attachedData, setAttachedData] = useState<string | null>(null);
  useEffect(() => { if (!open) setAttachedData(null); }, [open]);

  const extractedData: Record<string, any> | null =
    meta?.extractedData && Object.keys(meta.extractedData).length > 0 ? meta.extractedData : null;
  const docType: string | null = meta?.type ?? null;
  const actualMime: string = meta?.mimeType || mimeType;

  // The inline viewer always has the id and will fetch the binary via /file when needed.
  const displayData = data || attachedData || "";
  // Render the preview optimistically: `hasFile` only ever gates it AFTER the
  // metadata query has answered. Waiting for that answer first is what made
  // opening a document feel slow — the viewer can start fetching bytes now and
  // fall back to the "no file attached" card in the rare case there are none.
  const knownNoFile = !!meta && meta.hasFile === false && !displayData;
  const shouldShowPreview = !knownNoFile;
  const hasFile = meta?.hasFile === true;
  const formatFieldKey = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wave 11: Cap dialog at 85vh on desktop, 90vh on mobile, with a tighter
          max-w on wide displays so it never feels like it eats the viewport.
          Header is single-row (title + Download + close) instead of stacked. */}
      <DialogContent className="max-w-[96vw] md:max-w-5xl lg:max-w-6xl xl:max-w-[1400px] max-h-[90vh] sm:h-[90vh] flex flex-col overflow-hidden p-0" data-testid={`dialog-doc-viewer-${id}`}>
        <DialogHeader className="px-3 py-2 border-b border-border shrink-0">
          <div className="flex items-center justify-between gap-2">
            {/* Title is inline-editable here so the user doesn't have to
                close the viewer just to rename. EditableTitle stops click
                propagation internally so the dialog won't close on edit
                clicks. Saves via the same PATCH /api/documents/:id route
                used elsewhere and refreshes both the dialog title and any
                lists that show this document. */}
            <DialogTitle className="text-sm flex items-center gap-2 min-w-0 flex-1" asChild>
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FileText className="h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <EditableTitle
                    value={liveName}
                    inputClassName="text-sm"
                    onSave={async (newName) => {
                      await apiRequest("PATCH", `/api/documents/${id}`, { name: newName });
                      setLiveName(newName);
                      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
                      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
                      toast({ title: `Renamed to “${newName}”` });
                    }}
                  />
                </div>
                {docType && <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-normal shrink-0">{docType.replace(/_/g, ' ')}</span>}
              </div>
            </DialogTitle>
            {/* Shown optimistically for the same reason the preview is: the
                only state that hides it is a metadata answer of "no file". */}
            {(displayData || hasFile || !meta) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 shrink-0"
                onClick={async () => {
                  try {
                    let href: string;
                    let revoke: string | null = null;
                    if (displayData) {
                      const prefix = `data:${actualMime};base64,`;
                      href = displayData.startsWith("data:") ? displayData : prefix + displayData;
                    } else {
                      // Lazy-loaded doc: fetch the binary from the authenticated endpoint.
                      const blob = await apiRequest("GET", `/api/documents/${id}/file`).then((r) => r.blob());
                      href = URL.createObjectURL(blob);
                      revoke = href;
                    }
                    const link = document.createElement("a");
                    link.href = href;
                    link.download = liveName;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    if (revoke) setTimeout(() => URL.revokeObjectURL(revoke!), 10_000);
                  } catch {
                    toast({ title: "Download failed", description: liveName, variant: "destructive" });
                  }
                }}
              >
                <Download className="h-3.5 w-3.5 mr-1" />
                Download
              </Button>
            )}
          </div>
        </DialogHeader>

        {/* Real-app layout: side-by-side on desktop (extracted data on the left
            sidebar, document preview takes the rest), stacked on mobile.
            Each pane scrolls independently so neither one squishes the other.

            PERF: this is rendered immediately — there is no full-dialog
            "Loading document..." gate any more. The preview pane starts
            resolving its bytes on mount while the details pane fills in, so the
            two costs overlap instead of stacking. */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          {/* ── Left sidebar: Extracted Data ────────────────────────────── */}
          <aside className="shrink-0 md:w-[40%] md:max-w-[480px] md:min-w-[320px] border-b md:border-b-0 md:border-r border-border bg-muted/30 flex flex-col min-h-0 max-h-[35vh] md:max-h-none">
            <div className="shrink-0 px-4 pt-3 pb-2 border-b border-border/60 bg-background/40">
              <p className="micro-label text-muted-foreground">
                Extracted Data
              </p>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
              {extractedData && Object.keys(extractedData).length > 0 ? (
                <div className="space-y-2">
                  {Object.entries(extractedData)
                    .filter(([_, v]) => v != null && v !== '')
                    .map(([key, rawVal]) => {
                      const val = (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal) && 'value' in rawVal) ? (rawVal as any).value : rawVal;
                      // A receipt's line items get a row each — one long
                      // "2 x A - $4 . 1 x B - $9" line is unreadable, and
                      // JSON.stringify (what this used to do for any object)
                      // is worse.
                      if (isLineItemArray(val)) {
                        return (
                          <div key={key} className="flex flex-col gap-0.5">
                            <span className="micro-label text-muted-foreground/80">{formatFieldKey(key)}</span>
                            <ul className="space-y-0.5">
                              {(val as any[]).map((item, i) => (
                                <li key={i} className="text-sm font-medium text-foreground break-words">{formatLineItem(item)}</li>
                              ))}
                            </ul>
                          </div>
                        );
                      }
                      const display = stringifyField(val) || previewUnrenderable(val);
                      if (!display || display === 'null' || display === 'undefined') return null;
                      return (
                        <div key={key} className="flex flex-col gap-0.5">
                          <span className="micro-label text-muted-foreground/80">{formatFieldKey(key)}</span>
                          <span className="text-sm font-medium text-foreground break-words" title={display}>{display}</span>
                        </div>
                      );
                    })}
                </div>
              ) : metaLoading ? (
                // Skeleton rather than a blocking spinner — the preview next
                // to it is already loading its bytes.
                <div className="space-y-3 py-1" aria-label="Loading document details">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="space-y-1.5">
                      <div className="h-2 w-20 rounded bg-muted-foreground/15 animate-pulse" />
                      <div className="h-3.5 w-32 rounded bg-muted-foreground/10 animate-pulse" />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground py-3">No extracted data for this document.</p>
              )}
            </div>
          </aside>

          {/* ── Right pane: Document preview ────────────────────────────── */}
          <div className="flex-1 min-h-0 flex flex-col bg-neutral-900/40 dark:bg-black/30">
            {shouldShowPreview ? (
              <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center p-4">
                <div className="w-full h-full max-w-full">
                  <DocumentViewer id={id} name={name} mimeType={actualMime} data={displayData} inline />
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center py-8 text-center px-4">
                <FileText className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="text-sm font-medium">{name}</p>
                <p className="text-xs text-muted-foreground mt-2 max-w-md">
                  This document was added without a file attached — only the extracted details on the left are saved.
                </p>
                <label className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/50 cursor-pointer text-xs font-medium">
                  <input
                    type="file"
                    accept={DOCUMENT_UPLOAD_ACCEPT}
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = async () => {
                        const base64 = String(reader.result).split(",")[1];
                        try {
                          await apiRequest("PATCH", `/api/documents/${id}`, { fileData: base64, mimeType: file.type });
                          // The document's bytes just changed — drop anything
                          // the blob cache is holding for this id.
                          invalidateDocumentBlob(id);
                          setAttachedData(base64);
                          queryClient.invalidateQueries({ queryKey: ["/api/documents", id] });
                        } catch (err) {
                          console.error("Upload failed", err);
                        }
                      };
                      reader.readAsDataURL(file);
                    }}
                  />
                  Attach a file
                </label>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Editable Extracted Data Panel ────────────────────────────────────────────

function ExtractedDataPanel({
  document: doc,
  onUpdate,
  isUpdating,
}: {
  document: Document;
  onUpdate: (patch: Partial<Document>) => void;
  isUpdating: boolean;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");
  const [addingField, setAddingField] = useState(false);
  const [newFieldKey, setNewFieldKey] = useState("");
  const [newFieldValue, setNewFieldValue] = useState("");
  const { toast } = useToast();

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });

  const startEdit = (key: string, val: any) => {
    setEditingKey(key);
    setEditingValue(String(val ?? ""));
  };

  const commitEdit = (key: string) => {
    if (editingKey !== key) return;
    const updated = { ...doc.extractedData, [key]: editingValue };
    onUpdate({ extractedData: updated });
    setEditingKey(null);
  };

  const deleteField = (key: string) => {
    const updated = { ...doc.extractedData };
    delete updated[key];
    onUpdate({ extractedData: updated });
  };

  const addField = () => {
    if (!newFieldKey.trim()) {
      toast({ title: "Field name required", variant: "destructive" });
      return;
    }
    const updated = { ...doc.extractedData, [newFieldKey.trim()]: newFieldValue };
    onUpdate({ extractedData: updated });
    setNewFieldKey("");
    setNewFieldValue("");
    setAddingField(false);
  };

  const downloadFile = () => {
    const link = document.createElement("a");
    link.href = `data:${doc.mimeType};base64,${doc.fileData}`;
    link.download = doc.name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast({ title: "Download started", description: doc.name });
  };

  const contextProfileId = useMemo(
    () => (doc.linkedProfiles && doc.linkedProfiles.length > 0 ? doc.linkedProfiles[0] : null),
    [doc.linkedProfiles]
  );

  const extractedEntries = Object.entries(doc.extractedData || {});

  return (
    <div className="flex flex-col gap-0 h-full">
      {/* Document metadata header */}
      <div className="px-4 py-3 border-b border-border bg-muted/20 shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate" data-testid="text-doc-name">{doc.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {doc.createdAt ? new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge className={cn("text-xs px-1.5 py-0 capitalize border", getDocTypeBadgeColor(doc.type))} data-testid="badge-doc-type">
              {(doc.type || "other").replace(/_/g, " ")}
            </Badge>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={downloadFile}
              data-testid="btn-download-doc"
              title="Download file"
              aria-label="Download file"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="px-4 py-3 space-y-4">

          {/* Extracted data fields */}
          <div>
            <p className="micro-label text-muted-foreground mb-2">
              Extracted Fields
            </p>
            <div className="space-y-1" data-testid="extracted-data-list">
              {extractedEntries.length === 0 && (
                <p className="text-xs text-muted-foreground italic py-2">No extracted data</p>
              )}
              {extractedEntries.map(([key, val]) => {
                const expStatus = getExpirationStatus(key, val);
                const isEditing = editingKey === key;
                return (
                  <div
                    key={key}
                    className={cn(
                      "group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors",
                      expStatus === "expired" && "bg-red-500/8 border border-red-500/20",
                      expStatus === "soon" && "bg-yellow-500/8 border border-yellow-500/20",
                      expStatus === "valid" && "bg-green-500/5 border border-transparent",
                      !expStatus && "hover:bg-muted/30 border border-transparent"
                    )}
                    data-testid={`field-row-${key}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="micro-label text-muted-foreground">
                          {formatFieldLabel(key)}
                        </span>
                        {expStatus && <ExpirationBadge status={expStatus} />}
                      </div>
                      {isEditing ? (
                        <Input
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onBlur={() => commitEdit(key)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(key);
                            if (e.key === "Escape") setEditingKey(null);
                          }}
                          className="h-6 text-xs py-0 px-1.5"
                          autoFocus
                          data-testid={`input-field-${key}`}
                        />
                      ) : val !== null && typeof val === "object" ? (
                        // Structured values (a receipt's line items, an
                        // extracted address) render as text, not through a
                        // single-line input: `String(val)` printed
                        // "[object Object]", and committing that string back
                        // would overwrite the structure with it.
                        <div className="text-xs text-foreground/80" data-testid={`value-field-${key}`}>
                          {isLineItemArray(val) ? (
                            <ul className="space-y-0.5">
                              {(val as any[]).map((item, i) => (
                                <li key={i} className="break-words">{formatLineItem(item)}</li>
                              ))}
                            </ul>
                          ) : (
                            <span className="break-words">{stringifyField(val) || previewUnrenderable(val)}</span>
                          )}
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(key, val)}
                          className="text-xs text-left w-full hover:text-foreground text-foreground/80 transition-colors"
                          data-testid={`value-field-${key}`}
                        >
                          {stringifyField(val) || "—"}
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => deleteField(key)}
                      className="opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-destructive mt-1"
                      data-testid={`btn-delete-field-${key}`}
                      title="Delete field"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Add field */}
            {addingField ? (
              <div className="mt-2 space-y-1.5 rounded-md border border-border p-2 bg-muted/20" data-testid="add-field-form">
                <Input
                  placeholder="Field name"
                  value={newFieldKey}
                  onChange={(e) => setNewFieldKey(e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-new-field-key"
                  autoFocus
                />
                <Input
                  placeholder="Value"
                  value={newFieldValue}
                  onChange={(e) => setNewFieldValue(e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-new-field-value"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addField();
                    if (e.key === "Escape") setAddingField(false);
                  }}
                />
                <div className="flex gap-1.5">
                  <Button size="sm" className="h-6 text-xs px-2 gap-1" onClick={addField} data-testid="btn-confirm-add-field">
                    <Check className="h-3 w-3" /> Add
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => setAddingField(false)} data-testid="btn-cancel-add-field">
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="mt-2 w-full h-7 text-xs gap-1.5 border-dashed"
                onClick={() => setAddingField(true)}
                data-testid="btn-add-field"
                disabled={isUpdating}
              >
                <Plus className="h-3 w-3" />
                Add Field
              </Button>
            )}
          </div>

          {/* Linked profiles */}
          <div>
            <p className="micro-label text-muted-foreground mb-2">
              Linked Profiles
            </p>
            <DocumentLinkPicker
              profiles={profiles}
              linkedProfileIds={doc.linkedProfiles || []}
              contextProfileId={contextProfileId}
              onSave={(ids) => onUpdate({ linkedProfiles: ids })}
              disabled={isUpdating}
            />
          </div>

          {/* Tags */}
          {doc.tags && doc.tags.some((t) => !t.startsWith("sha256:") && t !== DISCARDED_FILE_TAG) && (
            <div>
              <p className="micro-label text-muted-foreground mb-2">Tags</p>
              <div className="flex flex-wrap gap-1" data-testid="tags-list">
                {/* sha256: tags are the upload-dedupe content hash — internal, never shown */}
                {doc.tags.filter((tag) => !tag.startsWith("sha256:") && tag !== DISCARDED_FILE_TAG).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0">{tag}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ─── Preview panel (left side) ────────────────────────────────────────────────

function DocumentPreviewPanel({
  doc,
  height = "full",
}: {
  doc: Document;
  height?: "full" | "auto";
}) {
  const isImage = doc.mimeType.startsWith("image/");
  const isPdf = doc.mimeType === "application/pdf";
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    zoom, rotation,
    isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  } = useViewerControls();

  const dataUrl = `data:${doc.mimeType};base64,${doc.fileData}`;

  // Extract-only upload: there is no file behind this row. Say so instead of
  // rendering a zoom toolbar over an empty frame.
  if (wasFileDiscarded(doc)) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center bg-muted/10" data-testid={`preview-discarded-${doc.id}`}>
        <FileText className="h-12 w-12 text-muted-foreground" />
        <p className="text-sm font-medium break-words">{doc.name}</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          This file wasn't kept. You chose to extract only, so it was read once
          to pull the fields beside it and then discarded.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-muted/10">
      {/* Zoom toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomOut} disabled={zoom <= 0.25}
          data-testid={`btn-preview-zoom-out-${doc.id}`}
          aria-label="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs font-mono w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomIn} disabled={zoom >= 5}
          aria-label="Zoom in"
          data-testid={`btn-preview-zoom-in-${doc.id}`}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border mx-0.5" />
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={rotate}
          data-testid={`btn-preview-rotate-${doc.id}`}
          aria-label="Rotate"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Preview content */}
      <div className="flex-1 overflow-hidden relative">
        {isImage && (
          <div
            ref={containerRef}
            className={cn(
              "h-full overflow-hidden",
              isDragging ? "cursor-grabbing" : zoom > 1 ? "cursor-grab" : "cursor-default"
            )}
            onWheel={handleWheel}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            data-testid={`preview-image-${doc.id}`}
          >
            <img
              src={dataUrl}
              alt={doc.name}
              className="w-full h-full object-contain transition-transform duration-150"
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg) translate(${translate.x / zoom}px, ${translate.y / zoom}px)`,
                transformOrigin: "center center",
              }}
              draggable={false}
            />
          </div>
        )}
        {isPdf && (
          <div
            ref={containerRef}
            className="h-full overflow-auto"
            onWheel={handleWheel}
            data-testid={`preview-pdf-${doc.id}`}
          >
            <div
              className="transition-transform duration-150"
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "top center",
                width: zoom > 1 ? `${100 / zoom}%` : "100%",
              }}
            >
              <object
                data={dataUrl}
                type="application/pdf"
                className="w-full"
                style={{ height: "calc(100dvh - 200px)", minHeight: "400px" }}
              >
                <iframe
                  src={dataUrl}
                  title={doc.name}
                  className="w-full border-0"
                  style={{ height: "calc(100dvh - 200px)", minHeight: "400px" }}
                />
              </object>
            </div>
          </div>
        )}
        {!isImage && !isPdf && (
          <div className="h-full flex flex-col items-center justify-center gap-3" data-testid={`preview-other-${doc.id}`}>
            <FileText className="h-16 w-16 text-muted-foreground" />
            <p className="text-sm font-medium">{doc.name}</p>
            <p className="text-xs text-muted-foreground">{doc.mimeType}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DocumentDetailDialog ─────────────────────────────────────────────────────

export function DocumentDetailDialog({
  open,
  onOpenChange,
  documentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string;
}) {
  const { toast } = useToast();

  const { data: doc, isLoading } = useQuery<Document>({
    queryKey: ["/api/documents", documentId],
    queryFn: () => apiRequest("GET", `/api/documents/${documentId}`).then((r) => r.json()),
    enabled: !!documentId && open,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<Document>) =>
      apiRequest("PATCH", `/api/documents/${documentId}`, patch).then((r) => r.json()),
    onSuccess: (updated) => {
      queryClient.setQueryData(["/api/documents", documentId], updated);
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      toast({ title: "Saved", description: "Document updated" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save changes", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-5xl w-full max-h-[90vh] p-0 overflow-hidden"
        data-testid={`dialog-doc-detail-${documentId}`}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{doc?.name ?? "Document Detail"}</DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center h-64">
            <div className="h-6 w-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          </div>
        )}

        {!isLoading && doc && (
          <div className="flex h-[80vh]">
            {/* Left: preview (60%) */}
            <div className="w-[60%] border-r border-border">
              <DocumentPreviewPanel doc={doc} />
            </div>
            {/* Right: data panel (40%) */}
            <div className="w-[40%] flex flex-col">
              <ExtractedDataPanel
                document={doc}
                onUpdate={(patch) => mutation.mutate(patch)}
                isUpdating={mutation.isPending}
              />
            </div>
          </div>
        )}

        {!isLoading && !doc && (
          <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
            Document not found
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
