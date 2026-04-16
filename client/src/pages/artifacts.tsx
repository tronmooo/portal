import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import {
  Archive, FileText, BookOpen, Brain, Camera, File, Heart,
  Shield, CreditCard, Scale, Folder, Search, X,
} from "lucide-react";
import type { Artifact } from "@shared/schema";
import type { JournalEntry } from "@shared/schema";
import type { Document } from "@shared/schema";
import type { Profile } from "@shared/schema";

// ─── Unified artifact type ──────────────────────────────────
interface UnifiedArtifact {
  id: string;
  title: string;
  type: "document" | "note" | "ai_report" | "scan";
  typeLabel: string;
  date: string;
  preview: string;
  profileName: string;
  source: any;
}

// ─── Filter tabs ─────────────────────────────────────────────
type FilterTab = "all" | "documents" | "notes" | "ai_reports" | "scans";

const FILTER_TABS: { key: FilterTab; label: string; icon: React.ElementType }[] = [
  { key: "all",        label: "All",        icon: Archive },
  { key: "documents",  label: "Documents",  icon: FileText },
  { key: "notes",      label: "Notes",      icon: BookOpen },
  { key: "ai_reports", label: "AI Reports", icon: Brain },
  { key: "scans",      label: "Scans",      icon: Camera },
];

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

// ─── Type icons ──────────────────────────────────────────────
function typeIcon(type: UnifiedArtifact["type"]) {
  switch (type) {
    case "document": return <FileText className="h-4 w-4 text-blue-500" />;
    case "note":     return <BookOpen className="h-4 w-4 text-amber-500" />;
    case "ai_report": return <Brain className="h-4 w-4 text-purple-500" />;
    case "scan":     return <Camera className="h-4 w-4 text-emerald-500" />;
    default:         return <File className="h-4 w-4 text-muted-foreground" />;
  }
}

function typeIconBg(type: UnifiedArtifact["type"]) {
  switch (type) {
    case "document": return "bg-blue-500/10";
    case "note":     return "bg-amber-500/10";
    case "ai_report": return "bg-purple-500/10";
    case "scan":     return "bg-emerald-500/10";
    default:         return "bg-muted/50";
  }
}

// ─── Date formatting ─────────────────────────────────────────
function formatDate(dateStr: string) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

// ─── Mood emoji helper ───────────────────────────────────────
const MOOD_EMOJI: Record<string, string> = {
  amazing: "🤩", great: "😊", good: "🙂", okay: "😐",
  neutral: "😶", bad: "😞", awful: "😢", terrible: "😫",
};

// ─── Artifact card ───────────────────────────────────────────
function ArtifactCard({ item }: { item: UnifiedArtifact }) {
  const handleClick = () => {
    if (item.type === "document") {
      window.location.hash = `#/documents/${item.id}`;
    } else if (item.type === "note") {
      window.location.hash = "#/dashboard/journal";
    }
    // AI reports: could open a detail view in the future
  };

  return (
    <div
      className="p-3 rounded-lg border border-border/50 bg-card hover:bg-accent/5 cursor-pointer transition-colors"
      onClick={handleClick}
      data-testid={`artifact-card-${item.id}`}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-md shrink-0 ${typeIconBg(item.type)}`}>
          {typeIcon(item.type)}
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium truncate">{item.title}</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {item.typeLabel} · {formatDate(item.date)}
          </p>
          {item.preview && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.preview}</p>
          )}
        </div>
        {item.profileName && (
          <Badge variant="outline" className="text-xs shrink-0 ml-1">
            {item.profileName}
          </Badge>
        )}
      </div>
    </div>
  );
}

// ─── Document group section ──────────────────────────────────
function DocumentGroup({ label, icon: Icon, items }: { label: string; icon: React.ElementType; items: UnifiedArtifact[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(item => <ArtifactCard key={`${item.type}-${item.id}`} item={item} />)}
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────
export default function ArtifactsPage() {
  useEffect(() => { document.title = "Artifacts — Portol"; }, []);

  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");

  // Fetch all three data sources in parallel
  const { data: documents = [], isLoading: docsLoading } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });

  const { data: journal = [], isLoading: journalLoading } = useQuery<JournalEntry[]>({
    queryKey: ["/api/journal"],
    queryFn: () => apiRequest("GET", "/api/journal").then(r => r.json()),
  });

  const { data: artifacts = [], isLoading: artifactsLoading } = useQuery<Artifact[]>({
    queryKey: ["/api/artifacts"],
    queryFn: () => apiRequest("GET", "/api/artifacts").then(r => r.json()),
  });

  // Fetch profiles for name resolution
  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });

  const profileMap = useMemo(() => {
    const map: Record<string, string> = {};
    profiles.forEach(p => { map[p.id] = p.name; });
    return map;
  }, [profiles]);

  // Helper to resolve first linked profile name
  const resolveProfile = (linkedProfiles?: string[]) => {
    if (!linkedProfiles || linkedProfiles.length === 0) return "";
    return profileMap[linkedProfiles[0]] || "";
  };

  // Merge all into unified list
  const allItems = useMemo(() => {
    const items: UnifiedArtifact[] = [
      ...documents
        .filter(d => !d.deletedAt)
        .map(d => ({
          id: d.id,
          title: d.title || d.name,
          type: (d.mimeType?.startsWith("image/") ? "scan" : "document") as UnifiedArtifact["type"],
          typeLabel: d.mimeType?.startsWith("image/")
            ? "Scan"
            : (getDocGroup(d.type).label || "Document"),
          date: d.createdAt,
          preview: d.extractedData
            ? Object.entries(d.extractedData).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(" · ").slice(0, 100)
            : "",
          profileName: resolveProfile(d.linkedProfiles),
          source: d,
        })),
      ...journal.map(j => ({
        id: j.id,
        title: j.mood
          ? `${MOOD_EMOJI[j.mood] || ""} ${j.mood.charAt(0).toUpperCase() + j.mood.slice(1)} · ${formatDate(j.date)}`
          : formatDate(j.date),
        type: "note" as const,
        typeLabel: "Journal Entry",
        date: j.date || j.createdAt,
        preview: j.content?.slice(0, 100) || "",
        profileName: resolveProfile(j.linkedProfiles),
        source: j,
      })),
      ...artifacts.map(a => ({
        id: a.id,
        title: a.title,
        type: "ai_report" as const,
        typeLabel: a.type === "checklist" ? "Checklist" : "AI Note",
        date: a.createdAt,
        preview: a.content?.slice(0, 100) || (a.items?.length > 0 ? a.items.map(i => i.text).join(", ").slice(0, 100) : ""),
        profileName: resolveProfile(a.linkedProfiles),
        source: a,
      })),
    ];
    return items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [documents, journal, artifacts, profileMap]);

  // Apply tab filter
  const tabFiltered = useMemo(() => {
    switch (activeTab) {
      case "documents": return allItems.filter(i => i.type === "document");
      case "notes":     return allItems.filter(i => i.type === "note");
      case "ai_reports": return allItems.filter(i => i.type === "ai_report");
      case "scans":     return allItems.filter(i => i.type === "scan");
      default:          return allItems;
    }
  }, [allItems, activeTab]);

  // Apply search filter
  const filtered = useMemo(() => {
    if (!search.trim()) return tabFiltered;
    const q = search.toLowerCase();
    return tabFiltered.filter(i =>
      i.title.toLowerCase().includes(q) ||
      i.typeLabel.toLowerCase().includes(q) ||
      i.preview.toLowerCase().includes(q) ||
      i.profileName.toLowerCase().includes(q)
    );
  }, [tabFiltered, search]);

  const isLoading = docsLoading || journalLoading || artifactsLoading;

  // Group documents by type when Documents tab is active
  const documentGroups = useMemo(() => {
    if (activeTab !== "documents") return null;
    const groups: Record<string, UnifiedArtifact[]> = {};
    const order = ["Identity", "Medical", "Insurance", "Financial", "Legal", "Other"];
    for (const item of filtered) {
      const src = item.source as Document;
      const group = getDocGroup(src.type || "other");
      if (!groups[group.label]) groups[group.label] = [];
      groups[group.label].push(item);
    }
    return order.filter(l => groups[l]?.length > 0).map(l => ({
      label: l,
      icon: Object.values(DOC_TYPE_GROUPS).find(g => g.label === l)?.icon || Folder,
      items: groups[l],
    }));
  }, [filtered, activeTab]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4 pb-24">
      {/* Header */}
      <div>
        <h1 className="text-lg font-semibold">Artifacts</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          {allItems.length} items · Documents, notes & AI reports in one place
        </p>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search artifacts..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9 h-9"
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

      {/* Filter pills */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
        {FILTER_TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const Icon = tab.icon;
          const count = tab.key === "all"
            ? allItems.length
            : allItems.filter(i =>
                tab.key === "documents" ? i.type === "document" :
                tab.key === "notes" ? i.type === "note" :
                tab.key === "ai_reports" ? i.type === "ai_report" :
                tab.key === "scans" ? i.type === "scan" : true
              ).length;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              }`}
              data-testid={`filter-${tab.key}`}
            >
              <Icon className="h-3 w-3" />
              {tab.label}
              <span className={`text-xs ${isActive ? "text-primary-foreground/70" : "text-muted-foreground/60"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={search ? Search : Archive}
          title={search ? "No results found" : "No artifacts yet"}
          description={
            search
              ? `Nothing matches "${search}". Try a different search term.`
              : "Upload documents, write journal entries, or chat with AI to generate reports."
          }
        />
      ) : activeTab === "documents" && documentGroups ? (
        // Documents tab: grouped by type
        <div className="space-y-5">
          {documentGroups.map(g => (
            <DocumentGroup key={g.label} label={g.label} icon={g.icon} items={g.items} />
          ))}
        </div>
      ) : (
        // All other tabs: flat grid sorted by date
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(item => (
            <ArtifactCard key={`${item.type}-${item.id}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
