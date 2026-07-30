import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { DocumentLinkPicker } from "@/components/DocumentLinkPicker";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { useDocumentBlobUrl, classifyDocument, prefetchDocumentBlob } from "@/lib/document-preview";

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

function getExpirationStatus(key: string, value: any): "expired" | "soon" | "valid" | null {
  const lower = key.toLowerCase();
  if (!lower.includes("expir") && !lower.includes("valid_until") && !lower.includes("expiration")) {
    return null;
  }
  if (!value) return null;
  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    if (date < now) return "expired";
    if (date < thirtyDays) return "soon";
    return "valid";
  } catch {
    return null;
  }
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

// ─── Zoom/Pan logic ────────────────────────────────────────────────────────────

function useViewerControls() {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.25, 5)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.25, 0.25)), []);
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

// ─── Preview panel ─────────────────────────────────────────────────────────────

function PreviewPanel({ doc }: { doc: Document }) {
  const kind = classifyDocument(doc.mimeType);
  const isImage = kind === "image";
  const isPdf = kind === "pdf";
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    zoom, rotation, isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  } = useViewerControls();

  // The server strips fileData from /api/documents/:id (only /file returns the
  // binary), and native <img>/<object> loads can't carry the bearer token /file
  // requires. They're also blocked by the CSP unless they point at a same-origin
  // blob: URL. The shared hook resolves a blob: URL — from inline base64 when a
  // freshly-uploaded doc still has it, otherwise via the authenticated /file
  // endpoint.
  const { url: previewUrl, blob, loading: blobLoading, error: blobError } =
    useDocumentBlobUrl(doc.id, doc.mimeType, (doc as any).fileData);

  const downloadFromBlob = useCallback(() => {
    if (!previewUrl) return;
    const a = document.createElement("a");
    a.href = previewUrl;
    a.download = doc.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [previewUrl, doc.name]);

  return (
    <div className="flex flex-col h-full rounded-xl border border-border bg-card overflow-hidden">
      {/* Zoom toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-muted/10 shrink-0">
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomOut} disabled={zoom <= 0.25}
          data-testid="btn-doc-zoom-out"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs font-mono w-12 text-center tabular-nums" data-testid="text-zoom-level">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomIn} disabled={zoom >= 5}
          aria-label="Zoom in"
          data-testid="btn-doc-zoom-in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border mx-0.5" />
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={rotate}
          data-testid="btn-doc-rotate"
          aria-label="Rotate"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Preview */}
      <div className="flex-1 overflow-hidden relative">
        {blobError ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center" data-testid="preview-error">
            <AlertCircle className="h-12 w-12 text-muted-foreground" />
            <p className="text-sm font-medium">{doc.name}</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              This file couldn't be loaded for preview. You can still download it.
            </p>
          </div>
        ) : !previewUrl ? (
          <div className="h-full flex items-center justify-center text-muted-foreground" data-testid="preview-loading">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : isImage ? (
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
          <div ref={containerRef} className="h-full flex flex-col" data-testid="preview-pdf">
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
            <div className="shrink-0 flex items-center justify-center gap-2 border-t border-border/60 bg-background/60 px-2 py-1.5">
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" asChild>
                <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open full screen
                </a>
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={downloadFromBlob}>
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
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
              <Button variant="outline" size="sm" className="gap-1.5" onClick={downloadFromBlob}>
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          </div>
        )}
      </div>
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

  const downloadFile = async () => {
    // The server strips fileData from /api/documents/:id, so build the download
    // from the authenticated /file endpoint (works for base64 + Supabase-Storage
    // docs alike) rather than the now-empty doc.fileData.
    try {
      let href: string;
      let revoke: string | null = null;
      if (doc.fileData) {
        href = `data:${doc.mimeType};base64,${doc.fileData}`;
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

  const contextProfileId = useMemo(
    () => (doc.linkedProfiles && doc.linkedProfiles.length > 0 ? doc.linkedProfiles[0] : null),
    [doc.linkedProfiles]
  );

  const extractedEntries = Object.entries(doc.extractedData || {});

  return (
    <div className="flex flex-col h-full rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/10 shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate" data-testid="text-doc-name">{doc.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-doc-date">
              {doc.createdAt
                ? new Date(doc.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : ""}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Badge
              className={cn("text-xs px-1.5 py-0 capitalize border", getDocTypeBadgeColor(doc.type))}
              data-testid="badge-doc-type"
            >
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
        <div className="px-4 py-4 space-y-5">

          {/* Extracted fields */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Extracted Fields
            </h3>
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
                      <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
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
                      ) : (
                        <button
                          onClick={() => startEdit(key, val)}
                          className="text-xs text-left w-full hover:text-foreground text-foreground/80 transition-colors"
                          data-testid={`value-field-${key}`}
                        >
                          {String(val ?? "—")}
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
            <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
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
          {doc.tags && doc.tags.some((t) => !t.startsWith("sha256:")) && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Tags</h3>
              <div className="flex flex-wrap gap-1" data-testid="tags-list">
                {/* sha256: tags are the upload-dedupe content hash — internal, never shown */}
                {doc.tags.filter((tag) => !tag.startsWith("sha256:")).map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs px-1.5 py-0">{tag}</Badge>
                ))}
              </div>
            </section>
          )}
        </div>
      </ScrollArea>
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
      <div className="flex gap-4 flex-1">
        <Skeleton className="flex-1 rounded-xl" />
        <Skeleton className="w-80 rounded-xl" />
      </div>
    </div>
  );
}

// ─── Document Detail Page ─────────────────────────────────────────────────────

export default function DocumentDetailPage() {
  useEffect(() => { document.title = "Document — Portol"; }, []);
  const [, params] = useRoute("/documents/:id");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const id = params?.id ?? "";

  // PERF: start pulling the binary from the route id alone, in parallel with
  // the metadata query. The preview can't mount until `doc` resolves, but its
  // bytes don't depend on that response — so there's no reason to wait for it.
  useEffect(() => { if (id) prefetchDocumentBlob(id); }, [id]);

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
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
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
        <Button variant="outline" size="sm" onClick={() => {
          if (window.history.length > 1) window.history.back();
          else navigate("/dashboard");
        }} data-testid="btn-back-error">
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="page-document-detail">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background/80 backdrop-blur-sm shrink-0">
        {/* BUG-D01: use history.back() so the back button returns to wherever
            the user came from (Documents tab, Linked page, Trackers, etc.),
            not always hardcoded to the Dashboard. Falls back to Dashboard if
            there is no history entry to pop. */}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-8 px-2 text-xs"
          onClick={() => {
            if (window.history.length > 1) window.history.back();
            else navigate("/dashboard");
          }}
          data-testid="btn-back-to-dashboard"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
          <h1 className="text-sm font-semibold truncate" data-testid="heading-doc-name">{doc.name}</h1>
        </div>
        {mutation.isPending && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <div className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            Saving…
          </div>
        )}
      </div>

      {/* Main two-column layout — stacks vertically below md so the metadata
          panel never gets squeezed into a sliver. On md+ split 55/45 so the
          right column has room for label + value pairs without truncation. */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden gap-4 p-4">
        {/* Left: document preview — renders PDFs/images from binary payloads;
            isolated so a decode/render crash leaves the data panel usable. */}
        <div className="flex-1 md:flex-[11] min-w-0 min-h-[280px] md:min-h-0 overflow-hidden">
          <SectionErrorBoundary name="document-preview" inline>
            <PreviewPanel doc={doc} />
          </SectionErrorBoundary>
        </div>

        {/* Right: editable data panel — isolated so malformed extractedData
            can't take the preview down with it. */}
        <div className="flex-1 md:flex-[9] min-w-0 md:min-w-[320px] overflow-hidden">
          <SectionErrorBoundary name="document-data-panel" inline>
            <DataPanel
              doc={doc}
              onUpdate={(patch) => mutation.mutate(patch)}
              isUpdating={mutation.isPending}
            />
          </SectionErrorBoundary>
        </div>
      </div>
    </div>
  );
}
