import { useState, useRef, useCallback, useEffect } from "react";
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
  Link2,
  ChevronDown,
  AlertCircle,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  const isImage = doc.mimeType.startsWith("image/");
  const isPdf = doc.mimeType === "application/pdf";
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    zoom, rotation, isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  } = useViewerControls();

  const dataUrl = `data:${doc.mimeType};base64,${doc.fileData}`;

  return (
    <div className="flex flex-col h-full rounded-xl border border-border bg-card overflow-hidden">
      {/* Zoom toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border bg-muted/10 shrink-0">
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomOut} disabled={zoom <= 0.25}
          data-testid="btn-doc-zoom-out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs font-mono w-12 text-center tabular-nums" data-testid="text-zoom-level">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomIn} disabled={zoom >= 5}
          data-testid="btn-doc-zoom-in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border mx-0.5" />
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={rotate}
          data-testid="btn-doc-rotate"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Preview */}
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
            data-testid="preview-image"
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
          <div ref={containerRef} className="h-full overflow-auto" onWheel={handleWheel} data-testid="preview-pdf">
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
                style={{ height: "calc(100vh - 250px)", minHeight: "400px" }}
              >
                <div className="flex flex-col items-center justify-center p-8 text-center">
                  <FileText className="h-12 w-12 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium mb-1">{doc.name}</p>
                  <p className="text-xs text-muted-foreground">PDF preview not available</p>
                </div>
              </object>
            </div>
          </div>
        )}
        {!isImage && !isPdf && (
          <div className="h-full flex flex-col items-center justify-center gap-3" data-testid="preview-other">
            <FileText className="h-16 w-16 text-muted-foreground" />
            <p className="text-sm font-medium">{doc.name}</p>
            <p className="text-xs text-muted-foreground">{doc.mimeType}</p>
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
  const [linkingProfile, setLinkingProfile] = useState(false);
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

  const linkProfile = (profileId: string) => {
    const already = doc.linkedProfiles || [];
    if (already.includes(profileId)) return;
    onUpdate({ linkedProfiles: [...already, profileId] });
    setLinkingProfile(false);
  };

  const unlinkProfile = (profileId: string) => {
    onUpdate({ linkedProfiles: (doc.linkedProfiles || []).filter((p) => p !== profileId) });
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

  const linkedProfileObjects = profiles.filter((p) => (doc.linkedProfiles || []).includes(p.id));
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
                      className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-destructive mt-1"
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

            {linkedProfileObjects.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2" data-testid="linked-profiles-list">
                {linkedProfileObjects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-1 bg-muted rounded-full px-2.5 py-0.5"
                    data-testid={`badge-profile-${p.id}`}
                  >
                    <span className="text-xs font-medium">{p.name}</span>
                    <button
                      onClick={() => unlinkProfile(p.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors ml-0.5"
                      data-testid={`btn-unlink-profile-${p.id}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {linkedProfileObjects.length === 0 && (
              <p className="text-xs text-muted-foreground italic mb-2">No profiles linked</p>
            )}

            {linkingProfile ? (
              <div className="rounded-md border border-border bg-card overflow-hidden shadow-sm" data-testid="link-profile-dropdown">
                <p className="text-xs px-3 py-1.5 border-b border-border text-muted-foreground font-semibold uppercase tracking-wide bg-muted/10">
                  Select a profile
                </p>
                {profiles.filter((p) => !(doc.linkedProfiles || []).includes(p.id)).length === 0 && (
                  <p className="text-xs px-3 py-2 text-muted-foreground italic">All profiles already linked</p>
                )}
                {profiles
                  .filter((p) => !(doc.linkedProfiles || []).includes(p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      className="flex items-center gap-2 px-3 py-2 text-xs w-full hover:bg-muted/50 transition-colors text-left"
                      onClick={() => linkProfile(p.id)}
                      data-testid={`btn-link-profile-${p.id}`}
                    >
                      <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto capitalize">{p.type}</span>
                    </button>
                  ))}
                <div className="border-t border-border p-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs w-full"
                    onClick={() => setLinkingProfile(false)}
                    data-testid="btn-cancel-link-profile"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs gap-1.5 border-dashed"
                onClick={() => setLinkingProfile(true)}
                data-testid="btn-link-to-profile"
                disabled={isUpdating}
              >
                <Link2 className="h-3 w-3" />
                Link to Profile
                <ChevronDown className="h-3 w-3 ml-auto" />
              </Button>
            )}
          </section>

          {/* Tags */}
          {doc.tags && doc.tags.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Tags</h3>
              <div className="flex flex-wrap gap-1" data-testid="tags-list">
                {doc.tags.map((tag) => (
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

  const { data: doc, isLoading, error } = useQuery<Document>({
    queryKey: ["/api/documents", id],
    queryFn: () => apiRequest("GET", `/api/documents/${id}`).then((r) => r.json()),
    enabled: !!id,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<Document>) =>
      apiRequest("PATCH", `/api/documents/${id}`, patch).then((r) => r.json()),
    onSuccess: (updated) => {
      queryClient.setQueryData(["/api/documents", id], updated);
      queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
      toast({ title: "Saved", description: "Document updated" });
    },
    onError: () => {
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
        <Button variant="outline" size="sm" onClick={() => navigate("/dashboard")} data-testid="btn-back-error">
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
          Back to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="page-document-detail">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background/80 backdrop-blur-sm shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 h-8 px-2 text-xs"
          onClick={() => navigate("/dashboard")}
          data-testid="btn-back-to-dashboard"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
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

      {/* Main two-column layout */}
      <div className="flex flex-1 overflow-hidden gap-4 p-4">
        {/* Left: document preview (60%) */}
        <div className="flex-[3] min-w-0 overflow-hidden">
          <PreviewPanel doc={doc} />
        </div>

        {/* Right: editable data panel (40%) */}
        <div className="flex-[2] min-w-0 overflow-hidden">
          <DataPanel
            doc={doc}
            onUpdate={(patch) => mutation.mutate(patch)}
            isUpdating={mutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}
