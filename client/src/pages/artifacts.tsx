import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { formatListDate, formatTimeAgo } from "@/lib/format";
import { hashNavigate } from "@/lib/hashNavigate";
import { formatFieldKey, stringifyFieldFor } from "@/lib/field-display";
import { userVisibleTags } from "@shared/system-tags";
import { libraryPurposeOf } from "@shared/domain/documents-artifacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { SmartFillTrigger } from "@/components/SmartFillTrigger";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { SectionErrorBoundary } from "@/components/ErrorBoundary";
import { useProfileScope } from "@/hooks/useProfileScope";
import { passesProfileFilter } from "@shared/profile-filter";
import { useProfileFilterCtx } from "@/hooks/useProfileFilterCtx";
import {
  Archive, FileText, Brain, Camera, Heart, Layers, StickyNote, BarChart3, ListChecks,
  Shield, CreditCard, Scale, Folder, Search, X, Star, Tag, Trash2, Pencil, Plus,
  LayoutGrid, List as ListIcon, Image as ImageIcon, ChevronDown, MoreHorizontal,
  MessageSquare, Sparkles, Table2, Share2, ExternalLink,
} from "lucide-react";
import type { Artifact } from "@shared/schema";
import type { Document } from "@shared/schema";
import type { Profile } from "@shared/schema";
import { documentHasFile } from "@shared/document-file";
import { previewForContent, prefetchMermaid, tryParseChartSpec } from "@/components/artifacts/ArtifactContent";
import { ArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { ArtifactShareMenu } from "@/components/artifacts/ArtifactShareMenu";
import { ArtifactThumb, chartThumbData } from "@/components/artifacts/ArtifactThumb";
import { KindBadge, artifactKind, displayTypeOf } from "@/components/artifacts/artifact-kinds";

// ─── Unified artifact type ──────────────────────────────────
interface UnifiedArtifact {
  id: string;
  title: string;
  type: "document" | "note" | "ai_report" | "scan";
  typeLabel: string;
  /** Last change (an artifact's updatedAt, a document's upload). Sorts and labels. */
  date: string;
  preview: string;
  /** First owner's name — kept for search; the card renders `owners`. */
  profileName: string;
  /**
   * QA 2026-09-18 BUG-14: EVERY linked owner, in link order. A shared
   * document (Sarah Miller + Poop) used to show one chip — the first id —
   * so Artifacts said "Sarah Miller" while the Info tab and the calendar
   * said it was Poop's too.
   */
  owners: string[];
  source: any;
  // Wave 8: star (pin) + tag metadata. Only artifacts (not Documents) carry
  // these; for Document rows pinned is always false.
  pinned?: boolean;
  tags?: string[];
  /** True for Artifact rows (where we can call PATCH /api/artifacts/:id). */
  isArtifact?: boolean;
}

/** The kind a card is drawn as: an artifact's own type, or document / scan. */
function kindKeyOf(item: UnifiedArtifact): string {
  return item.isArtifact ? displayTypeOf(item.source) : item.type;
}

// ─── Filter tabs ─────────────────────────────────────────────
// Journal entries live on their own page and don't belong in this list.
// Documents + AI Outputs partition All; the others are narrower cuts.
type FilterTab = "all" | "documents" | "ai_reports" | "notes" | "charts" | "checklists" | "scans" | "starred";

const FILTER_TABS: { key: FilterTab; label: string; icon: React.ElementType }[] = [
  { key: "all",        label: "All",        icon: LayoutGrid },
  { key: "documents",  label: "Documents",  icon: FileText },
  { key: "ai_reports", label: "AI Outputs", icon: Brain },
  { key: "notes",      label: "Notes",      icon: StickyNote },
  { key: "charts",     label: "Charts",     icon: BarChart3 },
  { key: "checklists", label: "Checklists", icon: ListChecks },
  { key: "scans",      label: "Scans",      icon: Camera },
  { key: "starred",    label: "Starred",    icon: Star },
];

/** The type filter a link asks for: `/artifacts?type=documents` (Settings →
 *  Documents opens the list already filtered). The URL is the only place this
 *  filter is read from — it is never stored (Rule 4), and a chip tap changes
 *  the view only. The hash router keeps the query inside the location
 *  ("/artifacts?type=documents"); the hash itself is read as a fallback. */
export function typeFilterFromLocation(location: string): FilterTab | null {
  const readType = (q: string): FilterTab | null => {
    const t = new URLSearchParams(q).get("type");
    return t && FILTER_TABS.some(f => f.key === t) ? (t as FilterTab) : null;
  };
  try {
    const q = location.includes("?") ? location.split("?")[1] : "";
    if (q) return readType(q);
    if (typeof window !== "undefined") {
      const hash = window.location.hash || "";
      const hq = hash.includes("?") ? hash.split("?")[1] : "";
      if (hq) return readType(hq);
    }
  } catch { /* malformed query: no filter */ }
  return null;
}

// ─── Document sub-type grouping ─────────────────────────────
const DOC_TYPE_GROUPS: Record<string, { label: string; icon: React.ElementType }> = {
  drivers_license: { label: "Identity", icon: Shield },
  passport:        { label: "Identity", icon: Shield },
  identity:        { label: "Identity", icon: Shield },
  medical_report:  { label: "Medical",  icon: Heart },
  medical:         { label: "Medical",  icon: Heart },
  lab_report:      { label: "Medical",  icon: Heart },
  insurance:       { label: "Insurance", icon: Shield },
  receipt:         { label: "Financial", icon: CreditCard },
  financial:       { label: "Financial", icon: CreditCard },
  legal:           { label: "Legal",     icon: Scale },
  other:           { label: "Other",     icon: Folder },
};

function getDocGroup(docType: string) {
  return DOC_TYPE_GROUPS[docType] || DOC_TYPE_GROUPS.other;
}

// ─── Date formatting ─────────────────────────────────────────
function formatDate(dateStr: string) {
  // Calendar-day relative label (lib/format): the rolling-24h version called
  // an 11 PM save "Today" at 1 AM the next morning.
  if (!dateStr) return "";
  if (isNaN(new Date(dateStr).getTime())) return dateStr;
  return formatListDate(dateStr);
}

function updatedLabel(dateStr: string) {
  if (!dateStr || isNaN(new Date(dateStr).getTime())) return "";
  return `Updated ${formatTimeAgo(dateStr)}`;
}

// ─── View + sort (per-device conveniences; neither hides a row) ─────────────
type ViewMode = "grid" | "list" | "gallery";
type SortMode = "recent" | "oldest" | "az" | "starred";
const SORT_LABELS: Record<SortMode, string> = { recent: "Recent", oldest: "Oldest", az: "A–Z", starred: "Starred first" };
function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch { return fallback; }
}
function writePref(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* private mode */ } }

interface CardActions {
  onOpen: (item: UnifiedArtifact) => void;
  onTogglePin: (item: UnifiedArtifact) => void;
  onDelete: (item: UnifiedArtifact) => void;
}

function shareTargetOf(item: UnifiedArtifact) {
  if (item.isArtifact) return { artifact: item.source };
  return {
    artifact: { title: item.title, type: "note", content: `${item.typeLabel}\n${item.preview}` },
    documentFile: documentHasFile(item.source as any)
      ? { id: item.id, name: item.source?.name || item.title, mimeType: item.source?.mimeType }
      : undefined,
  };
}

function CardMenu({ item, actions }: { item: UnifiedArtifact; actions: CardActions }) {
  const t = item.isArtifact ? displayTypeOf(item.source) : item.type;
  const editable = item.isArtifact && (t === "note" || t === "doc" || t === "sheet");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          aria-label={`More for ${item.title}`}
          data-testid={`button-more-${item.id}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => actions.onOpen(item)}>
          <ExternalLink className="h-4 w-4 mr-2" /> Open
        </DropdownMenuItem>
        {item.isArtifact && (
          <DropdownMenuItem
            onSelect={() => hashNavigate(`/chat?artifact=${encodeURIComponent(item.id)}`)}
            data-testid={`button-open-in-chat-${item.id}`}
          >
            <MessageSquare className="h-4 w-4 mr-2" /> Open in Chat
          </DropdownMenuItem>
        )}
        {editable && (
          <DropdownMenuItem
            onSelect={() => t === "note"
              ? hashNavigate(`/workspace/notes?note=${encodeURIComponent(item.id)}&from=artifacts`)
              : hashNavigate(`/editor/${item.id}`)}
          >
            <Pencil className="h-4 w-4 mr-2" /> Edit
          </DropdownMenuItem>
        )}
        {item.isArtifact && (
          <DropdownMenuItem onSelect={() => actions.onTogglePin(item)}>
            <Star className="h-4 w-4 mr-2" /> {item.pinned ? "Remove star" : "Star"}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => actions.onDelete(item)}
          data-testid={`button-delete-${item.id}`}
        >
          <Trash2 className="h-4 w-4 mr-2" /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StarButton({ item, actions, size = "h-8 w-8" }: { item: UnifiedArtifact; actions: CardActions; size?: string }) {
  if (!item.isArtifact) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); actions.onTogglePin(item); }}
      className={`${size} rounded-full flex items-center justify-center hover:bg-muted/60 transition-colors`}
      title={item.pinned ? "Remove star" : "Star"}
      aria-label={item.pinned ? `Remove star from ${item.title}` : `Star ${item.title}`}
      aria-pressed={!!item.pinned}
      data-testid={`button-pin-${item.id}`}
    >
      <Star className={`h-4 w-4 ${item.pinned ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
    </button>
  );
}

function OwnerChips({ item }: { item: UnifiedArtifact }) {
  // BUG-14: every owner, not just the first. Two names fit on a card; beyond
  // that a "+N" chip carries the rest (full list in the title tooltip).
  if (item.owners.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" title={item.owners.join(", ")} data-testid={`artifact-owners-${item.id}`}>
      {item.owners.slice(0, 2).map(name => (
        <span key={name} className="text-[11px] px-1.5 py-0.5 rounded-full border border-border/70 text-muted-foreground max-w-[8rem] truncate">{name}</span>
      ))}
      {item.owners.length > 2 && <span className="text-[11px] px-1.5 py-0.5 rounded-full border border-border/70 text-muted-foreground">+{item.owners.length - 2}</span>}
    </div>
  );
}

const shareTrigger = (
  <span className="h-8 w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors">
    <Share2 className="h-4 w-4" />
  </span>
);

// ─── Artifact card (grid / gallery) ──────────────────────────
function ArtifactCard({ item, actions, large }: { item: UnifiedArtifact; actions: CardActions; large?: boolean }) {
  const kindKey = kindKeyOf(item);
  const kind = artifactKind(kindKey);
  const Icon = kind.icon;
  const share = shareTargetOf(item);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      className="bubble bubble-interactive group flex flex-col !rounded-2xl p-2.5 cursor-pointer pressable min-w-0"
      style={{ ["--accent-hsl" as any]: kind.hsl, borderColor: `hsl(${kind.hsl} / 0.32)`, boxShadow: `0 8px 24px -12px hsl(${kind.hsl} / 0.5)` }}
      onClick={() => actions.onOpen(item)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); actions.onOpen(item); }
      }}
      data-testid={`artifact-card-${item.id}`}
    >
      <div className="relative">
        <ArtifactThumb type={kindKey} source={item.source} preview={item.preview} large={large} />
        <span
          className="absolute left-2 top-2 h-8 w-8 rounded-lg flex items-center justify-center border backdrop-blur"
          style={{ background: `hsl(${kind.hsl} / 0.18)`, borderColor: `hsl(${kind.hsl} / 0.45)` }}
        >
          <Icon className="h-4 w-4" style={{ color: `hsl(${kind.hsl})` }} />
        </span>
      </div>
      <div className="flex-1 min-w-0 px-1 pt-2.5 space-y-1.5">
        <h4 className={`${large ? "text-base" : "text-sm"} font-semibold leading-snug line-clamp-2`}>{item.title}</h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge type={kindKey} label={item.isArtifact ? undefined : item.typeLabel.split(" · ")[0]} />
          <OwnerChips item={item} />
        </div>
        {item.preview && <p className="text-xs text-muted-foreground line-clamp-2">{item.preview}</p>}
        <p className="text-[11px] text-muted-foreground truncate">{updatedLabel(item.date)}</p>
      </div>
      <div className="flex items-center justify-end gap-0.5 pt-1 -mr-1">
        <StarButton item={item} actions={actions} />
        <ArtifactShareMenu artifact={share.artifact} documentFile={share.documentFile} trigger={shareTrigger} />
        <CardMenu item={item} actions={actions} />
      </div>
    </div>
  );
}

// ─── Artifact row (list) ─────────────────────────────────────
function ArtifactRow({ item, actions }: { item: UnifiedArtifact; actions: CardActions }) {
  const kindKey = kindKeyOf(item);
  const kind = artifactKind(kindKey);
  const Icon = kind.icon;
  const share = shareTargetOf(item);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.title}`}
      className="bubble bubble-interactive flex items-center gap-3 !rounded-xl px-3 py-2.5 cursor-pointer pressable"
      style={{ ["--accent-hsl" as any]: kind.hsl }}
      onClick={() => actions.onOpen(item)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); actions.onOpen(item); }
      }}
      data-testid={`artifact-card-${item.id}`}
    >
      <span className="h-10 w-10 shrink-0 rounded-xl flex items-center justify-center border" style={{ background: `hsl(${kind.hsl} / 0.14)`, borderColor: `hsl(${kind.hsl} / 0.35)` }}>
        <Icon className="h-5 w-5" style={{ color: `hsl(${kind.hsl})` }} />
      </span>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold truncate">{item.title}</h4>
        <p className="text-xs text-muted-foreground truncate">
          {item.typeLabel} · {formatDate(item.date)}{item.preview ? ` · ${item.preview}` : ""}
        </p>
        <div className="mt-1"><OwnerChips item={item} /></div>
      </div>
      <StarButton item={item} actions={actions} />
      <ArtifactShareMenu artifact={share.artifact} documentFile={share.documentFile} trigger={shareTrigger} />
      <CardMenu item={item} actions={actions} />
    </div>
  );
}

function CardsView({ items, view, actions }: { items: UnifiedArtifact[]; view: ViewMode; actions: CardActions }) {
  if (view === "list") {
    return <div className="space-y-2">{items.map(item => <ArtifactRow key={`${item.type}-${item.id}`} item={item} actions={actions} />)}</div>;
  }
  return (
    <div className={view === "gallery" ? "grid gap-3 sm:grid-cols-2" : "grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"}>
      {items.map(item => <ArtifactCard key={`${item.type}-${item.id}`} item={item} actions={actions} large={view === "gallery"} />)}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────
export default function ArtifactsPage() {
  useEffect(() => { document.title = "Artifacts — Portol"; }, []);

  const [search, setSearch] = useState("");
  const [location] = useLocation();
  const linkedType = typeFilterFromLocation(location);
  const [activeTab, setActiveTab] = useState<FilterTab>(() => linkedType ?? "all");
  // A fresh link to the already-open page (?type=…) moves the chip too.
  useEffect(() => { if (linkedType) setActiveTab(linkedType); }, [linkedType]);
  const [selectedArtifact, setSelectedArtifact] = useState<UnifiedArtifact | null>(null);
  const [view, setView] = useState<ViewMode>(() => readPref("portol_artifacts_view", ["grid", "list", "gallery"] as const, "grid"));
  const [sort, setSort] = useState<SortMode>(() => readPref("portol_artifacts_sort", ["recent", "oldest", "az", "starred"] as const, "recent"));

  // Doc/sheet artifacts open in their editor; uploaded documents in the
  // document page; everything else in the full-screen viewer.
  const handleSelect = (item: UnifiedArtifact) => {
    if (!item.isArtifact) { hashNavigate(`/documents/${item.id}`); return; }
    const t = item.source?.type;
    if (t === "doc" || t === "sheet") { hashNavigate(`/editor/${item.id}`); return; }
    setSelectedArtifact(item);
  };

  // Profile filter — single source of truth, read reactively.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();

  // Wave 8: tag filter (acts as virtual folders).
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Star (pin) mutation. Optimistic update against the artifacts cache.
  const qc = useQueryClient();
  const pinMut = useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const res = await apiRequest("PATCH", `/api/artifacts/${id}`, { pinned });
      return res.json();
    },
    onMutate: async ({ id, pinned }) => {
      await qc.cancelQueries({ queryKey: ["/api/artifacts"] });
      const prev = qc.getQueryData<Artifact[]>(["/api/artifacts"]);
      qc.setQueryData<Artifact[]>(["/api/artifacts"], (old) =>
        old ? old.map(a => a.id === id ? { ...a, pinned } : a) : old
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["/api/artifacts"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
    },
  });

  // Wave 17.1: delete mutation. Routes to the right endpoint based on whether
  // the row is an Artifact (notes/AI reports/docs/sheets/checklists) or a
  // legacy Document/scan.
  const deleteMut = useMutation({
    mutationFn: async (item: UnifiedArtifact) => {
      const url = item.isArtifact ? `/api/artifacts/${item.id}` : `/api/documents/${item.id}`;
      await apiRequest("DELETE", url);
      return item;
    },
    onMutate: async (item) => {
      const key = item.isArtifact ? ["/api/artifacts"] : ["/api/documents"];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<any[]>(key);
      qc.setQueryData<any[]>(key, (old) => old ? old.filter(a => a.id !== item.id) : old);
      return { prev, key };
    },
    onError: (_err, _item, ctx) => {
      if (ctx?.prev && ctx?.key) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, item) => {
      // Whole domain: a deleted document must also leave the owner's Info tab
      // embed, the calendar/date-rules and the bell; the dashboard widgets
      // read /api/dashboard-enhanced.
      void invalidateDomains(item?.isArtifact ? "artifacts" : "documents", "dashboard");
    },
    onSuccess: () => { setPendingDelete(null); },
  });
  // Controlled AlertDialog state — replaces window.confirm() so rapid double
  // clicks can’t race past the modal and trigger two deletes (Rule 8).
  const [pendingDelete, setPendingDelete] = useState<UnifiedArtifact | null>(null);

  const actions: CardActions = {
    onOpen: handleSelect,
    onTogglePin: (item) => { if (item.isArtifact) pinMut.mutate({ id: item.id, pinned: !item.pinned }); },
    onDelete: (item) => setPendingDelete(item),
  };

  // Fetch all three data sources in parallel
  const { data: documents = [], isLoading: docsLoading, isError: docsFailed, refetch: refetchDocs, data: documentsData } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  // Journal entries deliberately NOT fetched here — they have their own page.
  const { data: artifacts = [], isLoading: artifactsLoading, isError: artifactsFailed, refetch: refetchArtifacts, data: artifactsData } = useQuery<Artifact[]>({
    queryKey: ["/api/artifacts"],
    queryFn: () => apiRequest("GET", "/api/artifacts").then(r => r.json()),
  });
  // Warm the mermaid chunk in the background so opening a diagram is instant —
  // but only when there is a diagram to open. Evaluating the 624KB chunk on
  // every visit was a 345ms main-thread stall on a page with no mermaid
  // artifact at all.
  const hasMermaid = Array.isArray(artifacts) && artifacts.some((a: any) => a?.type === "mermaid");
  useEffect(() => { if (hasMermaid) prefetchMermaid(); }, [hasMermaid]);


  // Fetch profiles for name resolution
  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  // Co-ownership widens a person's scope to the assets they co-own (shared/profile-filter).
  const scopeCtx = useProfileFilterCtx(filterIds, profiles);

  const profileMap = useMemo(() => {
    const map: Record<string, string> = {};
    profiles.forEach(p => { map[p.id] = p.name; });
    return map;
  }, [profiles]);

  // BUG-14: every linked owner's name, in link order (unknown ids skipped).
  const resolveOwners = (linkedProfiles?: string[] | null): string[] => {
    if (!Array.isArray(linkedProfiles)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of linkedProfiles) {
      const name = profileMap[id];
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  };
  const resolveProfile = (linkedProfiles?: string[] | null) => resolveOwners(linkedProfiles)[0] || "";

  // Merge all into unified list
  const allItems = useMemo(() => {
    const items: UnifiedArtifact[] = [
      ...documents
        .filter(d => !d.deletedAt)
        .map(d => ({
          id: d.id,
          title: d.title || d.name,
          type: (d.mimeType?.startsWith("image/") ? "scan" : "document") as UnifiedArtifact["type"],
          // QA 2026-09-18 BUG-31: a row whose photo was not kept (extract-only
          // upload) says so here, with the same predicate the viewer's
          // "no file attached" card uses, instead of advertising a "Scan".
          typeLabel: (d.mimeType?.startsWith("image/")
            ? "Scan"
            : (getDocGroup(d.type).label || "Document"))
            + (documentHasFile(d as any) ? "" : " · no file, extracted details only"),
          date: d.createdAt,
          // stringifyField, not `${v}` — extracted values include objects and
          // arrays (a receipt's line items), and template interpolation
          // rendered those as "[object Object],[object Object]".
          preview: d.extractedData
            ? Object.entries(d.extractedData)
                .slice(0, 3)
                .map(([k, v]) => `${formatFieldKey(k)}: ${stringifyFieldFor(k, v)}`)
                .filter(pair => !pair.endsWith(": "))
                .join(" · ")
                .slice(0, 100)
            : "",
          profileName: resolveProfile(d.linkedProfiles),
          owners: resolveOwners(d.linkedProfiles),
          source: d,
          pinned: false,
          // Never the dedupe hash, the extract-only marker or any other
          // internal tag (sha256:…, image-discarded, _…): they are not folders
          // and never reach the card, the chips or the filter (F-55 / BUG-30).
          tags: userVisibleTags((d as any).tags),
          isArtifact: false,
        })),
      ...artifacts.map(a => ({
        id: a.id,
        title: a.title,
        // Documents are UPLOADED source files; artifacts are created outputs
        // (shared/domain/documents-artifacts). A generated doc or sheet is an
        // artifact and lists under Artifacts, never beside a scanned policy.
        type: (libraryPurposeOf(a as any) === "document" ? "document" : "ai_report") as "document" | "ai_report",
        typeLabel: artifactKind(displayTypeOf(a)).label,
        date: a.updatedAt || a.createdAt,
        preview: a.type === "doc"
          ? (a.content?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "")
          : a.type === "sheet"
            ? `${a.sheetData?.rows ?? 0} × ${a.sheetData?.cols ?? 0} grid`
            : a.type === "checklist" && a.items?.length > 0
              ? `${a.items.filter(i => i.checked).length} of ${a.items.length} done · ${a.items.map(i => i.text).join(", ")}`.slice(0, 100)
              : a.type === "html" ? "Interactive — opens and runs full screen"
              : a.type === "svg" ? "Graphic — opens full size"
              : a.type === "mermaid" ? "Diagram — opens full size"
              : a.type === "chart" && !tryParseChartSpec(a.content || "")
                ? (() => { const c = chartThumbData(a); return c ? `${c.kind === "pie" ? "Pie" : c.kind === "line" ? "Line" : "Bar"} chart · ${c.values.length} data points` : "Chart"; })()
              : (previewForContent(a.content)?.replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim() || ""),
        profileName: resolveProfile(a.linkedProfiles),
        owners: resolveOwners(a.linkedProfiles),
        source: a,
        pinned: !!a.pinned,
        tags: userVisibleTags(a.tags),
        isArtifact: true,
      })),
    ];
    return items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [documents, artifacts, profileMap]);

  // Apply profile filter. P2.4 remediation: use the unified passesProfileFilter
  // rule (shared/profile-filter.ts) instead of an inline `linked.some(...)` so
  // orphan items (no linkedProfiles) still show when the selection includes a
  // self profile — matching finance/journal/server semantics.
  const profileFiltered = useMemo(() => {
    if (filterMode === "everyone" || filterIds.length === 0) return allItems;
    return allItems.filter(item => passesProfileFilter(item.source?.linkedProfiles, scopeCtx));
  }, [allItems, filterMode, filterIds, scopeCtx]);

  // ── ONE filter pipeline, one set of counts ─────────────────────────────────
  //
  // Every number on this page — the summary tiles, the type chips, the tag
  // chips and the rendered cards — is derived HERE, from `profileFiltered`,
  // using these three predicates. A count that comes from a different set
  // than the list it labels is always eventually wrong (user report
  // 2026-08-17).
  //
  // The rule each chip follows: a chip's count excludes ONLY its own dimension,
  // so pressing it always yields exactly that many cards.
  // A scan IS a document — it is a row in the documents table whose file
  // happens to be an image (user report 2026-09-04). The chips overlap rather
  // than partition, which is fine — each chip's count equals the cards
  // pressing it yields.
  const matchesType = (i: UnifiedArtifact, tab: FilterTab) =>
    tab === "documents" ? (i.type === "document" || i.type === "scan")
    : tab === "ai_reports" ? i.type === "ai_report"
    : tab === "scans" ? i.type === "scan"
    : tab === "notes" ? (!!i.isArtifact && (i.source?.type === "note" || i.source?.type === "markdown") && kindKeyOf(i) !== "chart")
    : tab === "charts" ? kindKeyOf(i) === "chart"
    : tab === "checklists" ? kindKeyOf(i) === "checklist"
    : tab === "starred" ? !!i.pinned
    : true;  // "all"
  const matchesTag = (i: UnifiedArtifact, tag: string | null) =>
    !tag || (i.tags || []).some(x => x.toLowerCase() === tag.toLowerCase());
  const matchesSearch = (i: UnifiedArtifact, q: string) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return i.title.toLowerCase().includes(s)
      || i.typeLabel.toLowerCase().includes(s)
      || i.preview.toLowerCase().includes(s)
      || i.owners.some(n => n.toLowerCase().includes(s))
      || (i.tags || []).some(t => t.toLowerCase().includes(s));
  };

  /** THE rendered set. "Total" is this length, by definition. */
  const filtered = useMemo(
    () => profileFiltered.filter(i =>
      matchesType(i, activeTab) && matchesTag(i, activeTag) && matchesSearch(i, search)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileFiltered, activeTab, activeTag, search],
  );

  /** The same set, in the chosen order — ordering never hides a row. */
  const sorted = useMemo(() => {
    const out = [...filtered];
    const time = (d: string) => new Date(d).getTime() || 0;
    if (sort === "oldest") out.sort((a, b) => time(a.date) - time(b.date));
    else if (sort === "az") out.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "starred") out.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || time(b.date) - time(a.date));
    else out.sort((a, b) => time(b.date) - time(a.date));
    return out;
  }, [filtered, sort]);

  /** Type-chip counts: scope + tag + search, broken down by type. Excludes the
   *  type filter itself so each chip predicts its own result. */
  const typeCounts = useMemo(() => {
    const base = profileFiltered.filter(i => matchesTag(i, activeTag) && matchesSearch(i, search));
    const counts = {
      all: base.length,
      documents: base.filter(i => i.type === "document" || i.type === "scan").length,
    } as Record<FilterTab, number>;
    for (const t of FILTER_TABS) if (counts[t.key] == null) counts[t.key] = base.filter(i => matchesType(i, t.key)).length;
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileFiltered, activeTag, search]);

  // Tag chips: scope + TYPE + search, counted per tag. Excludes the tag filter
  // itself so each chip predicts its own result.
  const allTags = useMemo(() => {
    const base = profileFiltered.filter(i => matchesType(i, activeTab) && matchesSearch(i, search));
    const counts = new Map<string, number>();
    for (const i of base) {
      for (const t of (i.tags || [])) {
        if (!t) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    // The active tag always stays visible even when the current type excludes
    // it — otherwise the chip you just pressed vanishes and you cannot unpress
    // it. It shows its true count here: 0.
    if (activeTag && !counts.has(activeTag)) counts.set(activeTag, 0);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileFiltered, activeTab, activeTag, search]);

  const isLoading = docsLoading || artifactsLoading;
  // A list that failed with nothing cached is not an empty library (Rule 7),
  // and a list still loading has no count yet: "0 artifacts" over a skeleton
  // read as "your saved records are gone" until they appeared (2026-11-24).
  const loadFailed = (docsFailed && documentsData === undefined) || (artifactsFailed && artifactsData === undefined);
  const countsReady = !isLoading && !loadFailed;

  // Group documents by type when Documents tab is active
  const documentGroups = useMemo(() => {
    if (activeTab !== "documents") return null;
    const groups: Record<string, UnifiedArtifact[]> = {};
    const order = ["Generated", "Identity", "Medical", "Insurance", "Financial", "Legal", "Other"];
    for (const item of sorted) {
      const label = item.isArtifact ? "Generated" : getDocGroup((item.source as Document).type || "other").label;
      if (!groups[label]) groups[label] = [];
      groups[label].push(item);
    }
    return order.filter(l => groups[l]?.length > 0).map(l => ({
      label: l,
      icon: l === "Generated" ? Sparkles : (Object.values(DOC_TYPE_GROUPS).find(g => g.label === l)?.icon || Folder),
      items: groups[l],
    }));
  }, [sorted, activeTab]);

  // Summary band — every tile describes THE VISIBLE SET (Rule 1/4):
  // · Total            = `filtered.length` — exactly the cards rendered below.
  // · Files            = visible rows from the documents table (uploads + scans)
  // · Notes & reports  = visible rows authored in-app; Files + this === Total.
  // · Charts / Starred = narrower cuts of the same set.
  // F-59: no tile borrows the page's word "Artifacts" for a partial count.
  const stats = [
    { label: "Total", value: filtered.length, icon: Layers, color: "205 90% 60%", testId: "artifacts-stat-showing" },
    { label: "Files", value: filtered.filter(i => !i.isArtifact).length, icon: FileText, color: "268 75% 66%", testId: "artifacts-stat-files" },
    { label: "Notes & reports", value: filtered.filter(i => i.isArtifact).length, icon: StickyNote, color: "42 92% 56%", testId: "artifacts-stat-artifacts" },
    { label: "Charts", value: filtered.filter(i => kindKeyOf(i) === "chart").length, icon: BarChart3, color: "152 65% 48%", testId: "artifacts-stat-charts" },
    { label: "Starred", value: filtered.filter(i => i.pinned).length, icon: Star, color: "190 80% 55%", testId: "artifacts-stat-starred" },
  ];

  const liveSelected = selectedArtifact
    ? (allItems.find(it => it.id === selectedArtifact.id) || selectedArtifact)
    : null;

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      {/* Header — title, what the page holds, and + Create. */}
      <div className="flex items-center gap-3">
        <span
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border"
          style={{ background: "linear-gradient(145deg, hsl(268 75% 66% / 0.28), hsl(268 75% 66% / 0.08))", borderColor: "hsl(268 75% 66% / 0.45)", boxShadow: "0 0 22px hsl(268 75% 66% / 0.3)" }}
        >
          <Archive className="h-6 w-6" style={{ color: "hsl(268 75% 72%)" }} />
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold leading-tight tracking-tight">Artifacts</h1>
          {/* QA 2026-09-18 F-59 / BUG-30: the header uses the PAGE's word,
              "artifacts", for the whole set, and says "N of M" only when a
              filter narrows what is showing. */}
          <p className="text-xs text-muted-foreground truncate" data-testid="artifacts-header-count">
            {!countsReady
              ? (isLoading ? "Loading your artifacts…" : "Couldn't load your artifacts")
              : <>{filtered.length !== profileFiltered.length ? `${filtered.length} of ` : ""}
                {profileFiltered.length} artifact{profileFiltered.length === 1 ? "" : "s"}</>} · Everything you've created with AI and beyond
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="shrink-0 inline-flex items-center gap-1.5 h-10 px-4 rounded-xl text-sm font-semibold text-white shadow-lg"
              style={{ background: "linear-gradient(135deg, hsl(268 80% 62%), hsl(290 80% 58%))", boxShadow: "0 6px 20px -6px hsl(268 80% 60% / 0.7)" }}
              data-testid="button-artifacts-create"
            >
              <Plus className="h-4 w-4" /> Create
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Create new…</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => hashNavigate("/editor/new/doc")}><FileText className="h-4 w-4 mr-2 text-blue-500" /> Document</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => hashNavigate("/editor/new/sheet")}><Table2 className="h-4 w-4 mr-2 text-green-600" /> Spreadsheet</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => hashNavigate("/workspace/notes")}><StickyNote className="h-4 w-4 mr-2 text-amber-500" /> Note</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                try { sessionStorage.setItem("portol_chat_prefill", "Make me a chart of "); } catch { /* private mode */ }
                hashNavigate("/chat");
              }}
            >
              <Sparkles className="h-4 w-4 mr-2 text-purple-500" /> Ask AI to make one
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-5 gap-1.5 sm:gap-2" data-testid="artifacts-summary">
        {stats.map(s => {
          const Icon = s.icon;
          return (
            <div
              key={s.label}
              className="bubble !rounded-2xl px-1 py-2.5 text-center min-w-0"
              style={{ ["--accent-hsl" as any]: s.color, borderColor: `hsl(${s.color} / 0.45)`, boxShadow: `0 0 16px -6px hsl(${s.color} / 0.55), inset 0 0 18px -12px hsl(${s.color} / 0.6)` }}
              data-testid={s.testId}
            >
              <Icon className="h-4 w-4 mx-auto" style={{ color: `hsl(${s.color})` }} />
              <p className="mt-1 text-xl font-bold leading-none tabular-nums" aria-busy={isLoading || undefined}>{countsReady ? s.value : "—"}</p>
              <p className="mt-1 text-[11px] sm:text-xs text-muted-foreground leading-tight">{s.label}</p>
            </div>
          );
        })}
      </div>

      {/* Search · Smart Fill · profile filter */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative basis-full sm:basis-auto sm:flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search artifacts..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-10 rounded-xl"
            data-testid="input-artifacts-search"
          />
          {search && (
            <button
              className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        <div className="flex-1 sm:flex-none flex items-center justify-end gap-2 min-w-0">
          <SmartFillTrigger />
          <MultiProfileFilter onChange={() => {}} compact />
        </div>
      </div>

      {/* Type chips — the count on each is exactly what pressing it shows. */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide" data-swipe-ignore>
        {FILTER_TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const Icon = tab.icon;
          const count = typeCounts[tab.key];
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              aria-pressed={isActive}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-colors border ${
                isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-[0_0_14px_-4px_hsl(var(--primary))]"
                  : "bg-card/50 text-muted-foreground border-border/70 hover:bg-muted"
              }`}
              data-testid={`filter-${tab.key}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
              <span className={`text-xs ${isActive ? "text-primary-foreground/80" : "text-muted-foreground/70"}`}>
                {countsReady ? `(${count})` : ""}
              </span>
            </button>
          );
        })}
      </div>

      {/* Wave 8: Tag filter chip strip (virtual folders). BUG-30: wraps. */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-1 -mx-1 px-1 items-center" data-testid="artifacts-tag-strip">
          <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
          <button
            onClick={() => setActiveTag(null)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
              activeTag === null
                ? "bg-primary/10 text-primary border border-primary/30"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 border border-transparent"
            }`}
            data-testid="tag-filter-all"
          >
            All tags
          </button>
          {allTags.slice(0, 24).map(({ tag, count }) => {
            const isActive = activeTag?.toLowerCase() === tag.toLowerCase();
            return (
              <button
                key={tag}
                onClick={() => setActiveTag(isActive ? null : tag)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                  isActive
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted/70 border border-transparent"
                }`}
                data-testid={`tag-filter-${tag}`}
              >
                #{tag}
                <span className="text-muted-foreground/70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* View + sort */}
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-xl border border-border/70 bg-muted/30 p-0.5" role="group" aria-label="View">
          {([
            { key: "grid", label: "Grid", icon: LayoutGrid },
            { key: "list", label: "List", icon: ListIcon },
            { key: "gallery", label: "Gallery", icon: ImageIcon },
          ] as const).map(v => {
            const Icon = v.icon;
            const on = view === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => { setView(v.key); writePref("portol_artifacts_view", v.key); }}
                aria-pressed={on}
                className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium transition-colors ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`view-${v.key}`}
              >
                <Icon className="h-3.5 w-3.5" /> {v.label}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-border/70 bg-muted/30 text-xs font-medium" data-testid="button-artifacts-sort">
              {SORT_LABELS[sort]} <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => { setSort(v as SortMode); writePref("portol_artifacts_sort", v); }}>
              {(Object.keys(SORT_LABELS) as SortMode[]).map(k => (
                <DropdownMenuRadioItem key={k} value={k}>{SORT_LABELS[k]}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content — a single malformed item can no longer blank the whole page
          (SectionErrorBoundary shows an inline retry). */}
      <SectionErrorBoundary name="artifacts-list" inline>
      {isLoading ? (
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-3" data-testid="artifacts-loading">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-52 rounded-2xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : loadFailed ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-center space-y-2" role="alert" data-testid="artifacts-load-error">
          <p className="text-sm font-medium">Couldn't load your artifacts</p>
          <p className="text-xs text-muted-foreground">Nothing was deleted. Check your connection and try again.</p>
          <Button size="sm" variant="outline" onClick={() => { void refetchDocs(); void refetchArtifacts(); }} data-testid="artifacts-load-retry">Try again</Button>
        </div>
      ) : filtered.length === 0 ? (
        // "No artifacts yet" is reserved for a genuinely empty scope. When the
        // library HAS records and the current filters simply exclude them all,
        // say that instead and offer the way out (user report 2026-08-17).
        profileFiltered.length === 0 ? (
          <EmptyState scope="global"
            icon={Archive}
            label="No artifacts yet"
            hint="Upload documents, write notes, or ask the AI in chat for a chart, report or checklist."
            testId="artifacts-empty-none"
          />
        ) : (
          <EmptyState scope="global"
            icon={Search}
            label="No items match these filters"
            hint={[
              activeTab !== "all" ? FILTER_TABS.find(t => t.key === activeTab)?.label : null,
              activeTag ? `#${activeTag}` : null,
              search.trim() ? `"${search.trim()}"` : null,
            ].filter(Boolean).join(" · ") + ` — ${profileFiltered.length} item${profileFiltered.length === 1 ? "" : "s"} in this profile.`}
            ctaLabel="Clear filters"
            onCta={() => { setActiveTab("all"); setActiveTag(null); setSearch(""); }}
            testId="artifacts-empty-filtered"
          />
        )
      ) : activeTab === "documents" && documentGroups ? (
        <div className="space-y-5">
          {documentGroups.map(g => {
            const Icon = g.icon;
            return (
              <div key={g.label} className="space-y-2">
                <div className="flex items-center gap-2 px-1">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="micro-label text-muted-foreground">{g.label}</span>
                  <span className="text-xs text-muted-foreground">({g.items.length})</span>
                </div>
                <CardsView items={g.items} view={view} actions={actions} />
              </div>
            );
          })}
        </div>
      ) : (
        <CardsView items={sorted} view={view} actions={actions} />
      )}
      </SectionErrorBoundary>

      {/* The full-screen viewer — the live row, its own controls, Share, X. */}
      <ArtifactViewer
        artifact={liveSelected?.source ?? null}
        owners={liveSelected?.owners}
        from="artifacts"
        onClose={() => setSelectedArtifact(null)}
      />

      {/* Controlled delete confirmation — the second tap (Rule 8). */}
      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => { if (!o && !deleteMut.isPending) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the file and any history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMut.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMut.isPending}
              onClick={(e) => { e.preventDefault(); if (pendingDelete) deleteMut.mutate(pendingDelete); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-artifact-delete-confirm"
            >
              {deleteMut.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
