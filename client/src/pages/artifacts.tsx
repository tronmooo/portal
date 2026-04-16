import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog, DialogContent, DialogTitle,
} from "@/components/ui/dialog";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { getProfileFilter } from "@/lib/profileFilter";
import {
  Archive, FileText, BookOpen, Brain, Camera, File, Heart,
  Shield, CreditCard, Scale, Folder, Search, X, Copy, Check as CheckIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import DOMPurify from "dompurify";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
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

// ─── Artifact Renderers ──────────────────────────────────────
function ArtifactRenderer({ artifact }: { artifact: any }) {
  if (!artifact) return null;
  const { type, content, language, dataBindings, items } = artifact;

  // Handle checklist items array (from Artifact.items)
  if (type === "checklist" && items?.length > 0) {
    return (
      <div className="space-y-1">
        {items.map((item: any, i: number) => (
          <label key={item.id || i} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="rounded" defaultChecked={item.checked} />
            <span>{item.text}</span>
          </label>
        ))}
      </div>
    );
  }

  switch (type) {
    case "markdown":
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{content || ""}</ReactMarkdown>
        </div>
      );

    case "code":
      return <CodeRenderer content={content || ""} language={language} />;

    case "html":
      return (
        <iframe
          srcDoc={content}
          sandbox=""
          className="w-full h-[400px] rounded-lg border border-border"
          title="HTML Preview"
          referrerPolicy="no-referrer"
        />
      );

    case "svg": {
      const sanitized = DOMPurify.sanitize(content || "", { USE_PROFILES: { svg: true } });
      return <div className="flex justify-center p-4" dangerouslySetInnerHTML={{ __html: sanitized }} />;
    }

    case "mermaid":
      return <MermaidRenderer content={content || ""} />;

    case "chart":
      return <ChartRenderer content={content || ""} dataBindings={dataBindings} />;

    case "checklist":
      return (
        <div className="space-y-1">
          {(content || "").split("\n").filter(Boolean).map((item: string, i: number) => (
            <label key={i} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="rounded" defaultChecked={item.startsWith("[x]")} />
              <span>{item.replace(/^\[[ x]\]\s*/, "")}</span>
            </label>
          ))}
        </div>
      );

    default: // note
      return <div className="text-sm whitespace-pre-wrap">{content || ""}</div>;
  }
}

function CodeRenderer({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800 text-xs text-zinc-400">
        <span>{language || "code"}</span>
        <button onClick={handleCopy} className="flex items-center gap-1 hover:text-white transition-colors">
          {copied ? <><CheckIcon className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
        </button>
      </div>
      <SyntaxHighlighter language={language || "javascript"} style={oneDark} customStyle={{ margin: 0, borderRadius: 0 }}>
        {content}
      </SyntaxHighlighter>
    </div>
  );
}

function MermaidRenderer({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("mermaid").then((m) => {
      if (cancelled) return;
      m.default.initialize({ startOnLoad: false, theme: "dark" });
      m.default.render("mermaid-" + Date.now(), content).then(({ svg }) => {
        if (ref.current && !cancelled) ref.current.innerHTML = svg;
      }).catch((e) => { if (!cancelled) setError(String(e)); });
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [content]);
  if (error) return <div className="text-sm text-destructive">Mermaid error: {error}</div>;
  return <div ref={ref} className="flex justify-center" />;
}

function ChartRenderer({ content, dataBindings }: { content: string; dataBindings?: any }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // If dataBindings exist, fetch fresh data from the API (with profile isolation)
    if (dataBindings?.tool && dataBindings?.params) {
      setLoading(true);
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(dataBindings.params)) {
        if (v != null) params.set(k, String(v));
      }
      // Profile isolation: dataBindings.params should include profileId
      // This ensures one person's chart can't show another person's data
      apiRequest("POST", "/api/chat", {
        message: `Use the ${dataBindings.tool} tool with params: ${JSON.stringify(dataBindings.params)}`,
        history: []
      }).then(r => r.json()).then(result => {
        // Try to extract chart data from the AI response
        const chartData = result?.charts?.[0]?.data || result?.results?.[0]?.data;
        if (chartData) setData(chartData);
        setLoading(false);
      }).catch(() => {
        setLoading(false);
        // Fallback to static content
        try {
          const parsed = JSON.parse(content);
          setData(Array.isArray(parsed) ? parsed : []);
        } catch { setData([]); }
      });
    } else {
      // No dataBindings — use static content
      try {
        const parsed = JSON.parse(content);
        setData(Array.isArray(parsed) ? parsed : []);
      } catch { setData([]); }
    }
  }, [content, dataBindings]);

  if (loading) return <div className="text-sm text-muted-foreground animate-pulse">Loading chart data...</div>;
  if (data.length === 0) return <div className="text-sm text-muted-foreground">No chart data</div>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data}>
        <XAxis dataKey="name" />
        <YAxis />
        <Tooltip />
        <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Artifact card ───────────────────────────────────────────
function ArtifactCard({ item, onSelect }: { item: UnifiedArtifact; onSelect?: (item: UnifiedArtifact) => void }) {
  const handleClick = () => {
    if (item.type === "ai_report") {
      onSelect?.(item);
    } else if (item.type === "document") {
      window.location.hash = `#/documents/${item.id}`;
    } else if (item.type === "note") {
      window.location.hash = "#/dashboard/journal";
    }
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
function DocumentGroup({ label, icon: Icon, items, onSelect }: { label: string; icon: React.ElementType; items: UnifiedArtifact[]; onSelect?: (item: UnifiedArtifact) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="text-xs text-muted-foreground">({items.length})</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(item => <ArtifactCard key={`${item.type}-${item.id}`} item={item} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────
export default function ArtifactsPage() {
  useEffect(() => { document.title = "Artifacts — Portol"; }, []);

  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [selectedArtifact, setSelectedArtifact] = useState<UnifiedArtifact | null>(null);

  // Profile filter state
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);

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

  // Apply profile filter
  const profileFiltered = useMemo(() => {
    if (filterMode === "everyone" || filterIds.length === 0) return allItems;
    return allItems.filter(item => {
      const linked = item.source?.linkedProfiles || [];
      return linked.some((id: string) => filterIds.includes(id));
    });
  }, [allItems, filterMode, filterIds]);

  // Apply tab filter
  const tabFiltered = useMemo(() => {
    switch (activeTab) {
      case "documents": return profileFiltered.filter(i => i.type === "document");
      case "notes":     return profileFiltered.filter(i => i.type === "note");
      case "ai_reports": return profileFiltered.filter(i => i.type === "ai_report");
      case "scans":     return profileFiltered.filter(i => i.type === "scan");
      default:          return profileFiltered;
    }
  }, [profileFiltered, activeTab]);

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
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Artifacts</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {profileFiltered.length} items · Documents, notes & AI reports in one place
          </p>
        </div>
        <MultiProfileFilter
          onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
          compact
        />
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
            ? profileFiltered.length
            : profileFiltered.filter(i =>
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
            <DocumentGroup key={g.label} label={g.label} icon={g.icon} items={g.items} onSelect={setSelectedArtifact} />
          ))}
        </div>
      ) : (
        // All other tabs: flat grid sorted by date
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(item => (
            <ArtifactCard key={`${item.type}-${item.id}`} item={item} onSelect={setSelectedArtifact} />
          ))}
        </div>
      )}

      {/* Artifact detail dialog */}
      <Dialog open={!!selectedArtifact} onOpenChange={() => setSelectedArtifact(null)}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogTitle>{selectedArtifact?.title}</DialogTitle>
          {selectedArtifact?.source && (
            <div className="mt-2">
              <div className="flex items-center gap-2 mb-4">
                <Badge variant="outline" className="text-xs">{selectedArtifact.source.type}</Badge>
                {selectedArtifact.profileName && (
                  <Badge variant="secondary" className="text-xs">{selectedArtifact.profileName}</Badge>
                )}
                <span className="text-xs text-muted-foreground">{formatDate(selectedArtifact.date)}</span>
              </div>
              <ArtifactRenderer artifact={selectedArtifact.source} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
