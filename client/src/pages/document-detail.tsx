import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { DetailValueCells } from "@/components/details/DetailValueCells";
import { DocumentLinkPicker } from "@/components/DocumentLinkPicker";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { getUserToday } from "@shared/timezone";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  FileText,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  Plus,
  X,
  Check,
  AlertCircle,
  Clock,
  ShieldCheck,
  ExternalLink,
  Loader2,
  Sparkles,
  Layers,
  List,
  Home,
  Calendar,
  CreditCard,
  Landmark,
  Shield,
  Hash,
  User,
  Maximize2,
  ChevronRight,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { stringifyField, stringifyFieldFor, isMoneyFieldKey, previewUnrenderable, isLineItemArray, formatLineItem } from "@/lib/field-display";
import { formatFullDate, formatMoney } from "@/lib/format";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { DOCUMENT_UPLOAD_ACCEPT, invalidateDocumentBlob, prefetchDocument, useDocumentBlobUrl, classifyDocument, type DocumentBlobState, wasFileDiscarded } from "@/lib/document-preview";
import { userVisibleTags } from "@shared/system-tags";
import { documentHasFile } from "@shared/document-file";
import EditableTitle from "@/components/EditableTitle";
import { hashNavigate } from "@/lib/hashNavigate";
import { classifyDateField, bareDateOf, daysBetweenISO, countdownLabel } from "@shared/date-rules";
import { UPCOMING_WINDOW_DAYS } from "@shared/extraction-calendar";

// PDF.js renderer is code-split — only loaded when a PDF is actually viewed.
const PdfCanvas = lazy(() => import("@/components/PdfCanvas"));

// ─── Types ────────────────────────────────────────────────────────────────────

interface Document {
  id: string;
  name: string;
  type: string;
  mimeType: string;
  fileData: string;
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

/**
 * The status of one dated field on this document — expiring, due, overdue.
 *
 * This used to be a private vocabulary: an `expir|valid_until` regex, a
 * `new Date(value)` parse and a hard-coded 30-day window. It could not see a
 * DUE date at all, which is how a parking citation's "Due 09/25/2026" rendered
 * as an ordinary, unremarkable row. It reads the ONE Date Rule engine now, so
 * this page agrees with the calendar, Upcoming and the Executive tab about
 * what a date means — and it reports the real days remaining rather than a
 * fixed label.
 */
function getDateFieldStatus(key: string, value: any, docContext?: string): {
  tone: "past" | "soon" | "ok";
  label: string;
} | null {
  const iso = bareDateOf(value);
  if (!iso) return null;
  const cls = classifyDateField(key, docContext);
  if (!cls.actionable) return null;
  const today = getUserToday(BROWSER_TIMEZONE);
  const days = daysBetweenISO(today, iso);
  return {
    tone: days < 0 ? "past" : days <= UPCOMING_WINDOW_DAYS ? "soon" : "ok",
    label: countdownLabel(iso, today, cls.ruleType),
  };
}

function DateFieldBadge({ status }: { status: NonNullable<ReturnType<typeof getDateFieldStatus>> }) {
  if (status.tone === "past") {
    return (
      <Badge variant="destructive" className="text-xs px-1.5 py-0 gap-1">
        <AlertCircle className="h-2.5 w-2.5" />
        {status.label}
      </Badge>
    );
  }
  if (status.tone === "soon") {
    return (
      <Badge className="text-xs px-1.5 py-0 gap-1 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30">
        <Clock className="h-2.5 w-2.5" />
        {status.label}
      </Badge>
    );
  }
  return (
    <Badge className="text-xs px-1.5 py-0 gap-1 bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30">
      <ShieldCheck className="h-2.5 w-2.5" />
      {status.label}
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

// ─── Zoom/Pan logic ────────────────────────────────────────────────────────────

function useViewerControls(minZoom = 0.25) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.25, 5)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.25, minZoom)), [minZoom]);
  const rotate = useCallback(() => setRotation((r) => (r + 90) % 360), []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
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
          if (diff > 5) zoomIn();
          else if (diff < -5) zoomOut();
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
        setTranslate({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
      }
    },
    [isDragging, dragStart]
  );
  const handleMouseUp = useCallback(() => setIsDragging(false), []);

  return {
    zoom, rotation, isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  };
}

// ─── How a field reads ────────────────────────────────────────────────────────

/** A stored `YYYY-MM-DD` and nothing else: the only shape shown as a date. */
function isoDayOf(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const t = val.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && bareDateOf(t) ? t : null;
}

/** "dwelling_limit: 520000" is an amount of coverage, not a count. */
const COVERAGE_AMOUNT_RE = /(limit|coverage|coverage_amount|sum_insured)$/i;

function isAmountField(key: string, val: unknown): boolean {
  if (isMoneyFieldKey(key)) return true;
  const k = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return COVERAGE_AMOUNT_RE.test(k) && /^\d+(\.\d+)?$/.test(String(val ?? "").trim()) && Number(val) >= 1000;
}

/**
 * A field's value as the page prints it: a stored day as "Jun 1, 2025", an
 * amount as money. Display only — editing still opens the stored value.
 */
function displayFieldValue(key: string, val: any): string {
  if (val !== null && typeof val === "object") return stringifyField(val) || previewUnrenderable(val);
  const iso = isoDayOf(val);
  if (iso) return formatFullDate(iso);
  if (!isMoneyFieldKey(key) && isAmountField(key, val)) return formatMoney(Number(val));
  return stringifyFieldFor(key, val);
}

function fieldIcon(key: string, val: unknown) {
  const k = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (isoDayOf(val) || /(^|_)(date|expir\w*|due|issued|effective)(_|$)/.test(k)) return Calendar;
  if (/address|property|location/.test(k)) return Home;
  if (/mortgagee|lender|bank|lienholder/.test(k)) return Landmark;
  if (isAmountField(key, val)) return CreditCard;
  if (/carrier|insurer|company|provider|issuer|agency|agent|coverage/.test(k)) return Shield;
  if (/(^|_)(number|no|id|code)(_|$)/.test(k)) return Hash;
  if (/name|insured|holder|owner|patient/.test(k)) return User;
  return FileText;
}

function docTypeLabel(type: string | undefined): string {
  return (type || "other").replace(/_/g, " ");
}

function docDateLabel(createdAt: string | undefined): string {
  return createdAt
    ? new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";
}

type DocTab = "overview" | "data" | "file";

// ─── File view ────────────────────────────────────────────────────────────────
// The whole page below the tabs belongs to the file: no card, no side panel,
// the controls float over it.

function PreviewPanel({ doc, file, noFile, onDownload }: { doc: Document; file: DocumentBlobState; noFile: boolean; onDownload: () => void }) {
  const fileDiscarded = wasFileDiscarded(doc);
  const kind = classifyDocument(doc.mimeType);
  const isImage = kind === "image";
  const isPdf = kind === "pdf";
  const {
    zoom, rotation, isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  } = useViewerControls(isPdf ? 0.5 : 0.25);
  const { url: previewUrl, blob, error: blobError } = file;
  const zoomable = !noFile && !!previewUrl && !blobError && (isImage || isPdf);

  return (
    <div className="relative h-full overflow-hidden bg-muted/20" data-testid="doc-file-view">
      {fileDiscarded ? (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="preview-discarded">
          <FileText className="h-12 w-12 text-muted-foreground" />
          <p className="text-sm font-medium">{doc.name}</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            This file wasn't kept. You chose to extract only, so it was read
            once to pull its fields and then discarded.
          </p>
        </div>
      ) : noFile ? (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="preview-no-file">
          <FileText className="h-12 w-12 text-muted-foreground" />
          <p className="text-sm font-medium">{doc.name}</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            This document was added without a file attached. Only its extracted details are saved.
          </p>
          <label className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/50 cursor-pointer text-xs font-medium">
            <input
              type="file"
              accept={DOCUMENT_UPLOAD_ACCEPT}
              className="hidden"
              data-testid="input-attach-file"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (!picked) return;
                const reader = new FileReader();
                reader.onload = async () => {
                  const base64 = String(reader.result).split(",")[1];
                  try {
                    await apiRequest("PATCH", `/api/documents/${doc.id}`, { fileData: base64, mimeType: picked.type });
                    // The document's bytes just changed — drop anything the
                    // blob cache is holding for this id.
                    invalidateDocumentBlob(doc.id);
                    void invalidateDomains("documents");
                  } catch (err) {
                    console.error("Upload failed", err);
                  }
                };
                reader.readAsDataURL(picked);
              }}
            />
            Attach a file
          </label>
        </div>
      ) : blobError ? (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="preview-error">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <p className="text-sm font-medium">{doc.name}</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            This file couldn't be loaded for preview. You can still download it.
          </p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={onDownload}>
            <Download className="h-3.5 w-3.5" />
            Download
          </Button>
        </div>
      ) : !previewUrl ? (
        <div className="h-full flex items-center justify-center text-muted-foreground" data-testid="preview-loading">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : isImage ? (
        <div
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
          data-testid="preview-image"
        >
          <img
            src={previewUrl}
            alt={doc.name}
            className="w-full h-full object-contain transition-transform duration-150"
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg) translate(${translate.x / zoom}px, ${translate.y / zoom}px)`,
              transformOrigin: "center center",
            }}
            draggable={false}
          />
        </div>
      ) : isPdf ? (
        // Zoom changes the page's WIDTH, not a transform: the page is
        // re-rasterized sharp at the new size and scrolls in both directions.
        <div className="h-full overflow-auto overscroll-contain pb-16" data-testid="preview-pdf">
          <div className="mx-auto" style={{ width: `calc(min(100%, 1100px) * ${zoom})` }}>
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
      ) : (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="preview-other">
          <FileText className="h-16 w-16 text-muted-foreground" />
          <p className="text-sm font-medium break-words">{doc.name}</p>
          <p className="text-xs text-muted-foreground">{doc.mimeType}</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            This file type can't be previewed in the browser. Open or download it to view.
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" asChild>
              <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={onDownload}>
              <Download className="h-3.5 w-3.5" />
              Download
            </Button>
          </div>
        </div>
      )}

      {/* Floating controls — only when there is a file to zoom. An extract-only
          upload kept no bytes, and zoom buttons over "This file wasn't kept"
          promised something that cannot happen (QA 2026-09-18, F-66). */}
      {!fileDiscarded && (
      <div data-testid="doc-zoom-toolbar" className={cn("absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-0.5 rounded-full border border-border bg-background/90 backdrop-blur px-1.5 py-1 shadow-lg", !zoomable && "hidden")}>
        <Button
          variant="ghost" size="icon" className="h-9 w-9 rounded-full"
          onClick={zoomOut} disabled={zoom <= (isPdf ? 0.5 : 0.25)}
          data-testid="btn-doc-zoom-out"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <span className="text-xs font-mono w-12 text-center tabular-nums" data-testid="text-zoom-level">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost" size="icon" className="h-9 w-9 rounded-full"
          onClick={zoomIn} disabled={zoom >= 5}
          aria-label="Zoom in"
          data-testid="btn-doc-zoom-in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        {/* Rotation turns an image; a PDF page is drawn upright. */}
        {isImage && (
          <Button
            variant="ghost" size="icon" className="h-9 w-9 rounded-full"
            onClick={rotate}
            data-testid="btn-doc-rotate"
            aria-label="Rotate"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        )}
        <div className="w-px h-4 bg-border mx-0.5" />
        <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" asChild>
          <a href={previewUrl ?? undefined} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </div>
      )}
    </div>
  );
}

// ─── Overview ─────────────────────────────────────────────────────────────────
// Everything here is read from the document's own fields; nothing is stored
// for this tab, so it cannot disagree with the Extracted Data tab.

const TONE_CLASS = {
  past: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  soon: "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  ok: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400",
} as const;
const TONE_ORDER = { past: 0, soon: 1, ok: 2 } as const;

function OverviewPanel({
  doc,
  file,
  fileLabel,
  noFile,
  onOpenTab,
}: {
  doc: Document;
  noFile: boolean;
  file: DocumentBlobState;
  fileLabel: string;
  onOpenTab: (tab: DocTab) => void;
}) {
  const fileDiscarded = wasFileDiscarded(doc);
  const kind = classifyDocument(doc.mimeType);
  const entries = Object.entries(doc.extractedData || {});
  // A field the overview can print on one line.
  const simple = entries.filter(([, v]) => v !== null && v !== undefined && typeof v !== "object" && String(v).trim() !== "");

  const statuses = simple
    .map(([key, val]) => ({ key, val, status: getDateFieldStatus(key, val, `${doc.type ?? ""} ${doc.name ?? ""}`) }))
    .filter((s): s is { key: string; val: any; status: NonNullable<ReturnType<typeof getDateFieldStatus>> } => !!s.status)
    .sort((x, y) => TONE_ORDER[x.status.tone] - TONE_ORDER[y.status.tone])
    .slice(0, 3);

  const isHeadline = ([k, v]: [string, any]) => !!isoDayOf(v) || isAmountField(k, v);
  const facts = simple
    .filter((e) => !isHeadline(e) && displayFieldValue(e[0], e[1]).length <= 60)
    .slice(0, 4);
  const tiles = [...simple.filter(isHeadline), ...simple.filter((e) => !isHeadline(e))]
    .filter(([k, v]) => displayFieldValue(k, v).length <= 28)
    .slice(0, 6);
  const previewRows = entries.slice(0, 8);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4" data-testid="doc-overview">
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:grid-cols-[220px_minmax(0,1fr)] gap-3 sm:gap-4">
        {/* Thumbnail — opens the full-page file view. */}
        {fileDiscarded || noFile || !(kind === "pdf" || kind === "image") || file.error ? (
          <div className="bubble aspect-[3/4] flex flex-col items-center justify-center gap-2 p-3 text-center" data-testid="doc-thumbnail-none">
            <FileText className="h-8 w-8 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {fileDiscarded ? "File not kept" : noFile ? "No file attached" : file.error ? "Preview unavailable" : "No preview"}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onOpenTab("file")}
            className="bubble bubble-interactive relative aspect-[3/4] overflow-hidden p-2 text-left"
            aria-label={`Open the ${fileLabel} view`}
            data-testid="doc-thumbnail"
          >
            <div className="h-full w-full overflow-hidden rounded-xl bg-white">
              {kind === "image" && file.url ? (
                <img src={file.url} alt="" className="h-full w-full object-cover object-top" draggable={false} />
              ) : kind === "pdf" && file.blob ? (
                <Suspense fallback={null}>
                  <PdfCanvas blob={file.blob} />
                </Suspense>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                </div>
              )}
            </div>
            <span className="absolute bottom-3 right-3 flex h-7 w-7 items-center justify-center rounded-lg bg-background/90 border border-border shadow">
              <Maximize2 className="h-3.5 w-3.5" />
            </span>
          </button>
        )}

        <section className="min-w-0" data-testid="doc-key-insights">
          <h2 className="flex items-center gap-2 text-base font-semibold mb-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Key Insights
          </h2>
          <div className="space-y-2">
            {statuses.map(({ key, val, status }) => (
              <div
                key={key}
                className={cn("flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium", TONE_CLASS[status.tone])}
                data-testid={`insight-${key}`}
              >
                {status.tone === "past" ? <AlertCircle className="h-4 w-4 shrink-0" /> : status.tone === "soon" ? <Clock className="h-4 w-4 shrink-0" /> : <ShieldCheck className="h-4 w-4 shrink-0" />}
                <span className="min-w-0 break-words">
                  {status.label}
                  <span className="font-normal opacity-80"> · {displayFieldValue(key, val)}</span>
                </span>
              </div>
            ))}
            {facts.length > 0 && (
              <ul className="divide-y divide-border/60">
                {facts.map(([key, val]) => {
                  const Icon = fieldIcon(key, val);
                  return (
                    <li key={key} className="flex items-start gap-2.5 py-1.5 text-sm" title={formatFieldLabel(key)}>
                      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 break-words">{displayFieldValue(key, val)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {statuses.length === 0 && facts.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing has been extracted from this document.</p>
            )}
          </div>
        </section>
      </div>

      {tiles.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3" data-testid="doc-tiles">
          {tiles.map(([key, val]) => {
            const Icon = fieldIcon(key, val);
            return (
              <div key={key} className="bubble flex items-start gap-2.5 p-3 min-w-0" data-testid={`tile-${key}`}>
                <Icon className="h-5 w-5 mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground truncate">{formatFieldLabel(key)}</p>
                  <p className="text-base font-semibold leading-snug break-words">{displayFieldValue(key, val)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <section className="bubble overflow-hidden" data-testid="doc-extracted-preview">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/60">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <List className="h-4 w-4 text-muted-foreground" />
            Extracted Data
          </h2>
          <button
            type="button"
            onClick={() => onOpenTab("data")}
            className="flex items-center gap-1 text-sm font-medium text-primary"
            data-testid="btn-view-all-fields"
          >
            {entries.length > 0 ? `View All (${entries.length})` : "Add a field"}
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        {previewRows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No extracted data</p>
        ) : (
          <ul className="divide-y divide-border/50 px-4">
            {previewRows.map(([key, val]) => {
              const Icon = fieldIcon(key, val);
              return (
                <li key={key} className="flex items-start justify-between gap-4 py-2 text-sm">
                  <span className="flex items-center gap-2.5 shrink-0 text-muted-foreground">
                    <Icon className="h-4 w-4 shrink-0" />
                    {formatFieldLabel(key)}
                  </span>
                  <span className="min-w-0 text-right break-words">{displayFieldValue(key, val) || "—"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* User-defined characteristics (shared/record-details): Status, Signed,
          Counterparty, Renewal date… as structured, reportable values. */}
      <DetailValueCells entityType="document" entityId={doc.id} className="grid grid-cols-2 sm:grid-cols-3 gap-2" />
    </div>
  );
}

// ─── Data panel ───────────────────────────────────────────────────────────────

function DataPanel({
  doc,
  onUpdate,
  isUpdating,
}: {
  doc: Document;
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
    onUpdate({ extractedData: { ...doc.extractedData, [key]: editingValue } });
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
    onUpdate({ extractedData: { ...doc.extractedData, [newFieldKey.trim()]: newFieldValue } });
    setNewFieldKey("");
    setNewFieldValue("");
    setAddingField(false);
  };

  const contextProfileId = useMemo(
    () => (doc.linkedProfiles && doc.linkedProfiles.length > 0 ? doc.linkedProfiles[0] : null),
    [doc.linkedProfiles]
  );

  const extractedEntries = Object.entries(doc.extractedData || {});

  return (
    <div className="mx-auto w-full max-w-3xl p-4" data-testid="doc-data-panel">
      <div className="bubble">
        <div className="px-4 py-4 space-y-5">

          {/* Extracted fields */}
          <section>
            <h3 className="micro-label text-muted-foreground mb-2">
              Extracted Fields
            </h3>
            <div className="space-y-1" data-testid="extracted-data-list">
              {extractedEntries.length === 0 && (
                <p className="text-xs text-muted-foreground italic py-2">No extracted data</p>
              )}
              {extractedEntries.map(([key, val]) => {
                const expStatus = getDateFieldStatus(key, val, `${doc.type ?? ""} ${doc.name ?? ""}`);
                const isEditing = editingKey === key;
                return (
                  <div
                    key={key}
                    className={cn(
                      "group flex items-start gap-2 rounded-md px-2 py-2 transition-colors",
                      expStatus?.tone === "past" && "bg-red-500/8 border border-red-500/20",
                      expStatus?.tone === "soon" && "bg-yellow-500/8 border border-yellow-500/20",
                      expStatus?.tone === "ok" && "bg-green-500/5 border border-transparent",
                      !expStatus && "hover:bg-muted/30 border border-transparent"
                    )}
                    data-testid={`field-row-${key}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                        <span className="micro-label text-muted-foreground">
                          {formatFieldLabel(key)}
                        </span>
                        {expStatus && <DateFieldBadge status={expStatus} />}
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
                        <div className="text-sm text-foreground/90" data-testid={`value-field-${key}`}>
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
                          className="text-sm text-left w-full hover:text-foreground text-foreground/90 transition-colors"
                          data-testid={`value-field-${key}`}
                        >
                          {displayFieldValue(key, val) || "—"}
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
              <div className="mt-2 space-y-1.5 rounded-md border border-border p-2.5 bg-muted/20" data-testid="add-field-form">
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
                  <Button
                    size="sm"
                    className="h-6 text-xs px-2 gap-1"
                    onClick={addField}
                    data-testid="btn-confirm-add-field"
                  >
                    <Check className="h-3 w-3" /> Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs px-2"
                    onClick={() => setAddingField(false)}
                    data-testid="btn-cancel-add-field"
                  >
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
          </section>

          {/* Linked profiles */}
          <section>
            <h3 className="micro-label text-muted-foreground mb-2">
              Linked Profiles
            </h3>
            <DocumentLinkPicker
              profiles={profiles}
              linkedProfileIds={doc.linkedProfiles || []}
              contextProfileId={contextProfileId}
              onSave={(ids) => onUpdate({ linkedProfiles: ids })}
              disabled={isUpdating}
            />
          </section>

          {/* Tags */}
          {userVisibleTags(doc.tags).length > 0 && (
            <section>
              <h3 className="micro-label text-muted-foreground mb-2">Tags</h3>
              <div className="flex flex-wrap gap-1" data-testid="tags-list">
                {/* System tags (sha256: dedupe hash, image-discarded) are internal, never shown */}
                {userVisibleTags(doc.tags).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0">{tag}</Badge>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="flex flex-col h-full p-4 gap-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-5 w-48" />
      </div>
      <Skeleton className="h-10 rounded-full" />
      <Skeleton className="flex-1 rounded-xl" />
    </div>
  );
}

// ─── Document body: header, tabs, the three views ─────────────────────────────

/**
 * Where the document view is shown. The view is the same in all three; only
 * the way out differs: a page goes Back, a dialog closes, and the copy inside
 * a chat message opens the full page.
 */
export type DocumentWorkspaceVariant = "page" | "dialog" | "embedded";

function DocumentBody({
  doc,
  onUpdate,
  isUpdating,
  onBack,
  variant,
  fileData,
}: {
  doc: Document;
  onUpdate: (patch: Partial<Document>) => void;
  isUpdating: boolean;
  onBack: () => void;
  variant: DocumentWorkspaceVariant;
  /** Bytes the opener already holds (a just-uploaded file), base64. */
  fileData?: string;
}) {
  const { toast } = useToast();
  const fileDiscarded = wasFileDiscarded(doc);
  const inlineData = doc.fileData || (fileData && fileData !== "__LAZY_LOAD__" ? fileData : "") || "";
  // Added without a file (not "extract only", which says so itself).
  const noFile = !fileDiscarded && !documentHasFile({ ...doc, fileData: inlineData || undefined });
  const viewable = !fileDiscarded && !noFile;
  // Opening a document shows the document: the file tab comes first whenever
  // there is a file to show ("open my driver's license" lands on the licence,
  // not on a summary of it).
  const [tab, setTab] = useState<DocTab>(viewable ? "file" : "overview");
  const kind = classifyDocument(doc.mimeType);
  const fileLabel = kind === "pdf" ? "PDF" : kind === "image" ? "Image" : "File";

  // The server strips fileData from /api/documents/:id (only /file returns the
  // binary), and native <img>/<object> loads can't carry the bearer token /file
  // requires. They're also blocked by the CSP unless they point at a same-origin
  // blob: URL. The shared hook resolves a blob: URL — from inline base64 when a
  // freshly-uploaded doc still has it, otherwise via the authenticated /file
  // endpoint. Resolved once here: the thumbnail and the file view share it.
  const file = useDocumentBlobUrl(doc.id, doc.mimeType, inlineData || undefined, viewable);

  const downloadFile = async () => {
    // Build the download from the bytes already resolved for the preview, else
    // from the authenticated /file endpoint (works for base64 + Supabase-Storage
    // docs alike) rather than the now-empty doc.fileData. An image is PREVIEWED
    // from a phone-sized variant, so its download always fetches the original.
    try {
      let href: string;
      let revoke: string | null = null;
      if (file.url && kind !== "image") {
        href = file.url;
      } else if (inlineData) {
        href = inlineData.startsWith("data:") ? inlineData : `data:${doc.mimeType};base64,${inlineData}`;
      } else {
        const blob = await apiRequest("GET", `/api/documents/${doc.id}/file`).then((r) => r.blob());
        href = URL.createObjectURL(blob);
        revoke = href;
      }
      const link = document.createElement("a");
      link.href = href;
      link.download = doc.name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      if (revoke) setTimeout(() => URL.revokeObjectURL(revoke!), 10_000);
      toast({ title: "Download started", description: doc.name });
    } catch {
      toast({ title: "Download failed", description: doc.name, variant: "destructive" });
    }
  };

  // Send the FILE itself to somebody: the phone's own share sheet (Messages,
  // Mail, AirDrop…) with the document attached. The old Share menu opened an
  // email or text with a sentence about the document and nothing attached.
  const [sending, setSending] = useState(false);
  const sendFile = async () => {
    if (sending) return;
    setSending(true);
    try {
      // A PDF's bytes are already here; an image is previewed from a
      // phone-sized variant, so the original is fetched to send.
      const blob = file.blob && kind !== "image"
        ? file.blob
        : await apiRequest("GET", `/api/documents/${doc.id}/file`).then((r) => r.blob()).catch(() => file.blob);
      if (!blob) throw new Error("no file");
      const type = blob.type || doc.mimeType || "application/octet-stream";
      const ext = type === "application/pdf" ? "pdf" : type === "image/jpeg" ? "jpg" : type.startsWith("image/") ? type.slice(6).split("+")[0] : "";
      const filename = !ext || new RegExp(`\\.${ext === "jpg" ? "jpe?g" : ext}$`, "i").test(doc.name) ? doc.name : `${doc.name}.${ext}`;
      const shared = new File([blob], filename, { type });
      const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (typeof nav.share === "function" && nav.canShare?.({ files: [shared] })) {
        await nav.share({ files: [shared], title: doc.name });
      } else {
        // No share sheet in this browser: hand over the file to attach.
        await downloadFile();
        toast({ title: "Sharing isn't available in this browser", description: "The file was downloaded so you can attach it to a message." });
      }
    } catch (err: any) {
      // Closing the share sheet without sending is not a failure.
      if (err?.name !== "AbortError") toast({ title: "Couldn't send the file", description: doc.name, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };
  const sendButton = (testId: string, className: string, variant: "ghost" | "outline") => (
    <Button variant={variant} size="icon" className={className} onClick={sendFile} disabled={sending} aria-label="Send to someone" title="Send to someone" data-testid={testId}>
      {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
    </Button>
  );

  const tabs: { id: DocTab; label: string; icon: typeof FileText }[] = [
    { id: "overview", label: "Overview", icon: Sparkles },
    { id: "data", label: "Extracted Data", icon: Layers },
    { id: "file", label: fileLabel, icon: FileText },
  ];
  const date = docDateLabel(doc.createdAt);

  // The way out, by where the view is shown.
  const leave =
    variant === "dialog" ? { label: "Close", icon: X, run: onBack }
    : variant === "embedded" ? { label: "Open full page", icon: Maximize2, run: () => hashNavigate(`/documents/${doc.id}`) }
    : { label: "Back", icon: ArrowLeft, run: onBack };
  const LeaveIcon = leave.icon;

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="page-document-detail" data-variant={variant}>
      {/* Header — folded away on the file tab, which gets the whole view;
          the way out and Download move into the tab row there. */}
      <div className={cn("flex items-start gap-2 px-3 sm:px-4 pt-3 pb-2 shrink-0", tab === "file" && "hidden")} data-testid="doc-header">
        {/* BUG-D01: use history.back() so the back button returns to wherever
            the user came from (Documents tab, Linked page, Trackers, etc.),
            not always hardcoded to the Dashboard. Falls back to Dashboard if
            there is no history entry to pop. */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-9 px-2 text-sm shrink-0"
          onClick={leave.run}
          aria-label={leave.label}
          title={leave.label}
          data-testid="btn-back-to-dashboard"
        >
          <LeaveIcon className="h-4 w-4" />
          {variant === "page" && "Back"}
        </Button>
        <FileText className="h-5 w-5 mt-2 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-tight break-words">
            <EditableTitle
              value={doc.name}
              testId="heading-doc-name"
              className="max-w-full"
              textClassName="line-clamp-2 break-words"
              onSave={(name) => onUpdate({ name })}
            />
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            <span className="capitalize" data-testid="badge-doc-type">{docTypeLabel(doc.type)}</span>
            {date && <span data-testid="text-doc-date"> • {date}</span>}
            {isUpdating && <span className="ml-2 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Saving…</span>}
          </p>
        </div>
        {/* No file — sharing or downloading it can only fail. */}
        {viewable && (
          <div className="flex items-center gap-1.5 shrink-0">
            {sendButton("btn-send-doc", "h-9 w-9 rounded-xl shrink-0", "outline")}
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-xl shrink-0"
              onClick={downloadFile}
              data-testid="btn-download-doc"
              title="Download file"
              aria-label="Download file"
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {/* On the file tab the name is one slim line: it is the first thing
          shown when a document opens, so it still has to say what it is. */}
      {tab === "file" && (
        <p className="px-4 pt-2 text-xs text-muted-foreground text-center truncate shrink-0" data-testid="text-doc-name">{doc.name}</p>
      )}

      {/* Tabs */}
      <div className={cn("flex items-center shrink-0", tab === "file" ? "gap-0.5 px-2 sm:gap-1 sm:px-4 py-2" : "gap-1 px-3 sm:px-4 pb-3")}>
        {tab === "file" && (
          <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-9 sm:w-9 rounded-full shrink-0" onClick={leave.run} aria-label={leave.label} title={leave.label} data-testid="btn-back-from-file">
            <LeaveIcon className="h-4 w-4" />
          </Button>
        )}
        <div role="tablist" aria-label="Document views" className="flex flex-1 min-w-0 rounded-full border border-border bg-muted/30 p-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                // Sized by its label (not thirds), and a label that still
                // cannot fit is cut with an ellipsis: it never runs over the
                // tab beside it.
                "flex-auto min-w-0 overflow-hidden flex items-center justify-center gap-1.5 rounded-full px-1.5 sm:px-2 py-2 text-[13px] sm:text-sm font-medium transition-colors",
                tab === id ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"
              )}
              data-testid={`tab-doc-${id}`}
            >
              {id !== "overview" && <Icon className="hidden sm:block h-4 w-4 shrink-0" />}
              {/* The file tab's row also holds the way out, Send and
                  Download, so on a phone the middle label is shortened. */}
              {id === "data" && tab === "file" ? (
                <span className="truncate"><span className="sm:hidden">Data</span><span className="hidden sm:inline">{label}</span></span>
              ) : (
                <span className="truncate">{label}</span>
              )}
            </button>
          ))}
        </div>
        {tab === "file" && viewable && sendButton("btn-send-from-file", "h-8 w-8 sm:h-9 sm:w-9 rounded-full shrink-0", "ghost")}
        {tab === "file" && viewable && (
          <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-9 sm:w-9 rounded-full shrink-0" onClick={downloadFile} aria-label="Download file" title="Download file" data-testid="btn-download-from-file">
            <Download className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Each view is isolated: a decode/render crash in the file view, or
          malformed extractedData, leaves the other tabs usable. */}
      {tab === "file" ? (
        <div className="flex-1 min-h-0 border-t border-border">
          <SectionErrorBoundary name="document-preview" inline>
            <PreviewPanel doc={doc} file={file} noFile={noFile} onDownload={downloadFile} />
          </SectionErrorBoundary>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === "overview" ? (
            <SectionErrorBoundary name="document-overview" inline>
              <OverviewPanel doc={doc} file={file} fileLabel={fileLabel} noFile={noFile} onOpenTab={setTab} />
            </SectionErrorBoundary>
          ) : (
            <SectionErrorBoundary name="document-data-panel" inline>
              <DataPanel doc={doc} onUpdate={onUpdate} isUpdating={isUpdating} />
            </SectionErrorBoundary>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Document workspace ───────────────────────────────────────────────────────
// The ONE document view. The /documents/:id page, the dialog a profile's
// Documents tab opens, and the copy inside a chat message all render this, so
// a document looks and behaves the same wherever it is opened.

export function DocumentWorkspace({
  id,
  variant,
  onBack,
  fileData,
  mimeType = "",
}: {
  id: string;
  variant: DocumentWorkspaceVariant;
  onBack: () => void;
  fileData?: string;
  /** Known before the metadata answers: lets the PDF renderer warm up early. */
  mimeType?: string;
}) {
  const { toast } = useToast();

  // PERF: start pulling the binary from the id alone, in parallel with the
  // metadata query. The preview can't mount until `doc` resolves, but its
  // bytes don't depend on that response — so there's no reason to wait for it.
  useEffect(() => { if (id) prefetchDocument(id, mimeType); }, [id, mimeType]);

  const { data: doc, isLoading, error } = useQuery<Document>({
    queryKey: ["/api/documents", id],
    queryFn: () => apiRequest("GET", `/api/documents/${id}`).then((r) => r.json()),
    enabled: !!id,
    staleTime: 60_000,
  });

  const mutation = useMutation<Document, Error, Partial<Document>, { prevDetail: unknown; prevList: [readonly unknown[], unknown][] }>({
    mutationFn: (patch: Partial<Document>) =>
      apiRequest("PATCH", `/api/documents/${id}`, patch).then((r) => r.json()),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ["/api/documents", id] });
      await queryClient.cancelQueries({ queryKey: ["/api/documents"] });
      const prevDetail = queryClient.getQueryData(["/api/documents", id]);
      const prevList = queryClient.getQueriesData({ queryKey: ["/api/documents"] });
      // Optimistically merge into the single detail object
      queryClient.setQueryData(["/api/documents", id], (old: any) => old ? { ...old, ...patch } : old);
      // Optimistically merge into list queries that contain this doc
      queryClient.setQueriesData({ queryKey: ["/api/documents"] }, (old: any) => {
        if (!old) return old;
        if (Array.isArray(old)) return old.map((d: any) => d.id === id ? { ...d, ...patch } : d);
        return old;
      });
      return { prevDetail, prevList };
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["/api/documents", id], updated);
      // The documents domain also covers the owner's profile embed, the
      // calendar/date-rules (an expiration is a date) and the notification
      // bell — a bare /api/documents bust left all of them on the old value.
      void invalidateDomains("documents");
      toast({ title: "Saved", description: "Document updated" });
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prevDetail) queryClient.setQueryData(["/api/documents", id], ctx.prevDetail);
      if (ctx?.prevList) { for (const [key, data] of ctx.prevList) queryClient.setQueryData(key, data); }
      toast({ title: "Error", description: "Failed to save changes", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="h-full overflow-hidden" data-testid="page-document-detail-loading">
        <PageSkeleton />
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3" data-testid="page-document-detail-error">
        <FileText className="h-12 w-12 text-muted-foreground" />
        <p className="text-sm font-medium">Document not found</p>
        {variant !== "embedded" && (
          <Button variant="outline" size="sm" onClick={onBack} data-testid="btn-back-error">
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            {variant === "dialog" ? "Close" : "Back"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <DocumentBody
      // A different document is a different view: its tab starts over.
      key={doc.id}
      doc={doc}
      onUpdate={(patch) => mutation.mutate(patch)}
      isUpdating={mutation.isPending}
      onBack={onBack}
      variant={variant}
      fileData={fileData}
    />
  );
}

// ─── Document Detail Page ─────────────────────────────────────────────────────

export default function DocumentDetailPage() {
  useEffect(() => { document.title = "Document — Portol"; }, []);
  const [, params] = useRoute("/documents/:id");
  const [, navigate] = useLocation();
  return (
    <DocumentWorkspace
      id={params?.id ?? ""}
      variant="page"
      onBack={() => {
        if (window.history.length > 1) window.history.back();
        else navigate("/dashboard");
      }}
    />
  );
}
