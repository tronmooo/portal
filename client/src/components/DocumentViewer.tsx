import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Link2,
  Check,
  ChevronDown,
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
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

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

  const downloadDoc = (name: string, mimeType: string, data: string) => {
    const link = document.createElement("a");
    link.href = `data:${mimeType};base64,${data}`;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast({ title: "Download started", description: name });
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
          onClick={() => downloadDoc(name, mimeType, data)}
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
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    zoom, rotation, expanded, setExpanded,
    isDragging, translate,
    zoomIn, zoomOut, rotate,
    handleWheel, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
  } = useViewerControls();

  // For large files, fetch as blob and create object URL (data URLs > 500KB crash mobile browsers)
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (data && data !== "__LAZY_LOAD__" && data.length <= 500000) return; // Small enough for data URL
    // Fetch the file as a blob via the authenticated API
    let cancelled = false;
    apiRequest("GET", `/api/documents/${id}/file`)
      .then(res => res.blob())
      .then(blob => {
        if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id, data]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => { if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [blobUrl]);

  const dataUrl = blobUrl
    || (data && data !== "__LAZY_LOAD__" && data.length > 0 ? `data:${mimeType};base64,${data}` : "");

  const ZoomControls = () => (
    <div className="flex items-center gap-1 bg-background/90 backdrop-blur-sm rounded-lg border border-border p-1 shadow-sm">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={zoomOut}
        disabled={zoom <= 0.25}
        data-testid={`btn-zoom-out-${id}`}
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
      >
        <RotateCw className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setExpanded(!expanded)}
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

  const renderImage = (maxH: string) => (
    <div
      ref={containerRef}
      className={`relative overflow-hidden rounded-lg bg-muted/30 ${
        isDragging ? "cursor-grabbing" : zoom > 1 ? "cursor-grab" : ""
      }`}
      style={{ maxHeight: maxH }}
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
        className="w-full h-auto transition-transform duration-150"
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
      className="relative overflow-hidden rounded-lg bg-muted/30 flex flex-col"
      style={{ height: maxH }}
      onWheel={handleWheel}
    >
      <div
        className="flex-1 transition-transform duration-150"
        style={{
          transform: `scale(${zoom})`,
          transformOrigin: "top center",
          width: zoom > 1 ? `${100 / zoom}%` : "100%",
          height: "100%",
        }}
      >
        <object
          data={dataUrl}
          type="application/pdf"
          className="w-full h-full"
          style={{ minHeight: "100%" }}
        >
          {/* Fallback: try iframe for better browser support */}
          <iframe
            src={dataUrl}
            title={name}
            className="w-full h-full border-0"
            style={{ minHeight: "100%" }}
          />
        </object>
      </div>
    </div>
  );

  // Inline mode (inside chat bubble or document dialog)
  if (inline) {
    // PDFs fill their parent container; images keep explicit heights
    const maxH = expanded ? "85vh" : "480px";
    return (
      <div
        className="rounded-xl overflow-hidden border border-border bg-muted/10 flex flex-col"
        style={isPdf ? { height: '100%', minHeight: '400px' } : undefined}
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
          {isImage && renderImage(maxH)}
          {isPdf && renderPdf("100%")}
          {!isImage && !isPdf && (
            <div className="p-6 text-center">
              <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm">{name}</p>
              <p className="text-xs text-muted-foreground mt-1">{mimeType}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Card mode
  return (
    <div
      className="rounded-xl border border-border bg-card overflow-hidden"
      data-testid={`doc-card-${id}`}
    >
      <div className="relative">
        {isImage && (
          <div className="overflow-hidden" style={{ maxHeight: compact ? "120px" : "200px" }}>
            <img
              src={dataUrl}
              alt={name}
              className="w-full h-auto object-cover"
              draggable={false}
            />
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
  // Fetch full document (file data + extracted data) on-demand
  const [fetchedData, setFetchedData] = useState<string | null>(null);
  const [extractedData, setExtractedData] = useState<Record<string, any> | null>(null);
  const [docType, setDocType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      // Always fetch fresh data when dialog opens
      setLoading(true);
      setFetchedData(null);
      setExtractedData(null);
      apiRequest("GET", `/api/documents/${id}`)
        .then(res => res.json())
        .then(doc => {
          if (doc.fileData) setFetchedData(doc.fileData);
          if (doc.extractedData && Object.keys(doc.extractedData).length > 0) {
            setExtractedData(doc.extractedData);
          }
          if (doc.type) setDocType(doc.type);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [open, id]);

  const displayData = data || fetchedData || "";
  const formatFieldKey = (key: string) => key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[96vw] md:max-w-6xl h-[92vh] flex flex-col overflow-hidden p-0" data-testid={`dialog-doc-viewer-${id}`}>
        <DialogHeader className="px-4 py-3 border-b border-border shrink-0">
          <DialogTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {name}
            {docType && <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-normal">{docType.replace(/_/g, ' ')}</span>}
            {displayData && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2"
                onClick={() => {
                  const link = document.createElement("a");
                  const prefix = mimeType === "application/pdf" ? "data:application/pdf;base64," : `data:${mimeType};base64,`;
                  link.href = displayData.startsWith("data:") ? displayData : prefix + displayData;
                  link.download = name;
                  link.click();
                }}
              >
                <Download className="h-3.5 w-3.5 mr-1" />
                Download
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center flex-1">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
            <span className="ml-3 text-sm text-muted-foreground">Loading document...</span>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Document preview — takes all available space */}
            <div className="flex-1 min-h-0 px-4 pb-2" style={{ display: 'flex', flexDirection: 'column' }}>
              {displayData ? (
                <div className="flex-1 min-h-0" style={{ height: '100%' }}>
                  <DocumentViewer id={id} name={name} mimeType={mimeType} data={displayData} inline />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <FileText className="h-10 w-10 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-xs text-muted-foreground mt-1">No preview available.</p>
                </div>
              )}
            </div>

            {/* Extracted data section — collapsed at bottom */}
            {extractedData && Object.keys(extractedData).length > 0 && (
              <div className="shrink-0 border-t border-border px-4 py-2 bg-muted/10 max-h-[20vh] overflow-y-auto">
                <p className="text-xs-tight font-semibold text-muted-foreground uppercase tracking-wider mb-1">Extracted Data</p>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3">
                  {Object.entries(extractedData)
                    .filter(([_, v]) => v != null && v !== '')
                    .map(([key, rawVal]) => {
                      const val = (rawVal && typeof rawVal === 'object' && 'value' in rawVal) ? rawVal.value : rawVal;
                      const display = typeof val === 'object' ? JSON.stringify(val) : String(val);
                      if (!display || display === 'null' || display === 'undefined') return null;
                      return (
                        <div key={key} className="flex justify-between items-baseline py-[2px] gap-1">
                          <span className="text-xs-tight text-muted-foreground shrink-0 truncate">{formatFieldKey(key)}</span>
                          <span className="text-xs-tight font-medium text-foreground text-right truncate">{display}</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        )}
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

  const linkedProfileObjects = profiles.filter((p) =>
    (doc.linkedProfiles || []).includes(p.id)
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
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
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
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
              Linked Profiles
            </p>
            {linkedProfileObjects.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2" data-testid="linked-profiles-list">
                {linkedProfileObjects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-1 bg-muted rounded-full px-2 py-0.5"
                    data-testid={`badge-profile-${p.id}`}
                  >
                    <span className="text-xs">{p.name}</span>
                    <button
                      onClick={() => unlinkProfile(p.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
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

            {/* Link to profile dropdown */}
            {linkingProfile ? (
              <div className="rounded-md border border-border bg-muted/20 overflow-hidden" data-testid="link-profile-dropdown">
                <p className="text-xs px-2 py-1 border-b border-border text-muted-foreground font-medium">
                  Select a profile
                </p>
                {profiles.filter((p) => !(doc.linkedProfiles || []).includes(p.id)).length === 0 && (
                  <p className="text-xs px-2 py-2 text-muted-foreground italic">All profiles already linked</p>
                )}
                {profiles
                  .filter((p) => !(doc.linkedProfiles || []).includes(p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      className="flex items-center gap-2 px-2 py-1.5 text-xs w-full hover:bg-muted/50 transition-colors text-left"
                      onClick={() => linkProfile(p.id)}
                      data-testid={`btn-link-profile-${p.id}`}
                    >
                      <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{p.name}</span>
                      <span className="text-xs text-muted-foreground ml-auto capitalize">{p.type}</span>
                    </button>
                  ))}
                <div className="border-t border-border p-1">
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
          </div>

          {/* Tags */}
          {doc.tags && doc.tags.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">Tags</p>
              <div className="flex flex-wrap gap-1" data-testid="tags-list">
                {doc.tags.map((tag) => (
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

  return (
    <div className="flex flex-col h-full bg-muted/10">
      {/* Zoom toolbar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomOut} disabled={zoom <= 0.25}
          data-testid={`btn-preview-zoom-out-${doc.id}`}
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs font-mono w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={zoomIn} disabled={zoom >= 5}
          data-testid={`btn-preview-zoom-in-${doc.id}`}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <div className="w-px h-4 bg-border mx-0.5" />
        <Button
          variant="ghost" size="icon" className="h-7 w-7"
          onClick={rotate}
          data-testid={`btn-preview-rotate-${doc.id}`}
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
                style={{ height: "calc(100vh - 200px)", minHeight: "400px" }}
              >
                <iframe
                  src={dataUrl}
                  title={doc.name}
                  className="w-full border-0"
                  style={{ height: "calc(100vh - 200px)", minHeight: "400px" }}
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
