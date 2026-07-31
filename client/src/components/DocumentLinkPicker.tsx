import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  User,
  Building,
  Car,
  Home,
  Box,
  CreditCard,
  Link2,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Profile {
  id: string;
  name: string;
  type: string;
}

export interface DocumentLinkPickerProps {
  profiles: Profile[];
  linkedProfileIds: string[];
  contextProfileId?: string | null;
  onSave: (newLinkedProfileIds: string[]) => void;
  disabled?: boolean;
}

// ─── Category helpers ──────────────────────────────────────────────────────────

type Category = "people" | "assets" | "liabilities" | "other";

const PEOPLE_TYPES = new Set(["person", "self"]);
const ASSET_TYPES = new Set(["asset", "vehicle", "property", "investment", "account"]);
const LIABILITY_TYPES = new Set(["liability", "loan"]);

function getCategory(type: string): Category {
  const t = (type || "").toLowerCase();
  if (PEOPLE_TYPES.has(t)) return "people";
  if (ASSET_TYPES.has(t)) return "assets";
  if (LIABILITY_TYPES.has(t)) return "liabilities";
  return "other";
}

function getTypeIcon(type: string) {
  const t = (type || "").toLowerCase();
  const cls = "h-3.5 w-3.5 shrink-0 text-muted-foreground";
  if (t === "person" || t === "self") return <User className={cls} />;
  if (t === "vehicle") return <Car className={cls} />;
  if (t === "property") return <Home className={cls} />;
  if (t === "building") return <Building className={cls} />;
  if (t === "liability" || t === "loan") return <CreditCard className={cls} />;
  if (t === "asset" || t === "investment" || t === "account") return <Building className={cls} />;
  return <Box className={cls} />;
}

function getTypeBadgeColor(type: string): string {
  const t = (type || "").toLowerCase();
  if (t === "person" || t === "self") return "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20";
  if (t === "vehicle") return "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20";
  if (t === "property") return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20";
  if (t === "liability" || t === "loan") return "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20";
  if (t === "asset" || t === "investment" || t === "account") return "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20";
  return "bg-muted text-muted-foreground";
}

const CATEGORY_ORDER: Category[] = ["people", "assets", "liabilities", "other"];
const CATEGORY_LABELS: Record<Category, string> = {
  people: "People",
  assets: "Assets",
  liabilities: "Liabilities",
  other: "Other",
};

// ─── Relationship graph hook ────────────────────────────────────────────────────

interface GraphNode {
  id: string;
}

interface RelationshipGraph {
  nodes: GraphNode[];
}

function useRelationshipGraph(profileId: string | null | undefined) {
  return useQuery<RelationshipGraph>({
    queryKey: ["/api/relationships/graph", profileId],
    queryFn: () =>
      apiRequest("GET", `/api/relationships/graph/${profileId}?hops=2`).then((r) =>
        r.json()
      ),
    enabled: !!profileId,
    staleTime: 5 * 60 * 1000,
  });
}

// ─── Group section ─────────────────────────────────────────────────────────────

function GroupSection({
  label,
  profiles,
  checkedIds,
  relatedIds,
  hasContext,
  onToggle,
  searchActive,
}: {
  label: string;
  profiles: Profile[];
  checkedIds: Set<string>;
  relatedIds: Set<string>;
  hasContext: boolean;
  onToggle: (id: string) => void;
  searchActive: boolean;
}) {
  const related = hasContext ? profiles.filter((p) => relatedIds.has(p.id)) : [];
  const others = hasContext ? profiles.filter((p) => !relatedIds.has(p.id)) : profiles;

  return (
    <div className="mb-1">
      <div className="flex items-center gap-1.5 px-2 pt-3 pb-1">
        <span className="micro-label text-muted-foreground">
          {label} ({profiles.length})
        </span>
      </div>

      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground italic px-2 py-1.5">
          {searchActive ? "No matches" : "No items in this category"}
        </p>
      ) : (
        <>
          {hasContext && related.length > 0 && (
            <>
              <p className="micro-label text-muted-foreground/60 px-2 pt-1 pb-0.5">
                Related
              </p>
              {related.map((p) => (
                <ProfileRow
                  key={p.id}
                  profile={p}
                  checked={checkedIds.has(p.id)}
                  onToggle={onToggle}
                />
              ))}
            </>
          )}
          {hasContext && related.length > 0 && others.length > 0 && (
            <p className="micro-label text-muted-foreground/60 px-2 pt-2 pb-0.5">
              All others
            </p>
          )}
          {others.map((p) => (
            <ProfileRow
              key={p.id}
              profile={p}
              checked={checkedIds.has(p.id)}
              onToggle={onToggle}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ─── Profile row ───────────────────────────────────────────────────────────────

function ProfileRow({
  profile,
  checked,
  onToggle,
}: {
  profile: Profile;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      key={profile.id}
      htmlFor={`link-picker-${profile.id}`}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer transition-colors",
        "hover:bg-muted/50",
        checked && "bg-emerald-500/10"
      )}
      data-testid={`picker-row-${profile.id}`}
    >
      <Checkbox
        id={`link-picker-${profile.id}`}
        checked={checked}
        onCheckedChange={() => onToggle(profile.id)}
        className="shrink-0"
      />
      {getTypeIcon(profile.type)}
      <span className="text-xs flex-1 truncate">{profile.name}</span>
      <Badge
        className={cn(
          "text-[11px] px-1 py-0 capitalize border shrink-0",
          getTypeBadgeColor(profile.type)
        )}
      >
        {(profile.type || "other").replace(/_/g, " ")}
      </Badge>
    </label>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function DocumentLinkPicker({
  profiles,
  linkedProfileIds,
  contextProfileId,
  onSave,
  disabled = false,
}: DocumentLinkPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(linkedProfileIds));

  // Re-sync checked state when popover opens so it reflects latest linkedProfileIds
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setChecked(new Set(linkedProfileIds));
      setSearch("");
    }
    setOpen(next);
  };

  // Relationship graph for context-aware sub-grouping
  const { data: graph } = useRelationshipGraph(contextProfileId);
  const relatedIds = useMemo<Set<string>>(() => {
    if (!graph?.nodes) return new Set();
    return new Set(graph.nodes.map((n) => n.id));
  }, [graph]);

  const hasContext = !!contextProfileId && relatedIds.size > 0;

  // Filter profiles by search
  const filtered = useMemo(() => {
    if (!search.trim()) return profiles;
    const q = search.toLowerCase();
    return profiles.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, search]);

  // Group filtered profiles by category
  const grouped = useMemo(() => {
    const map: Record<Category, Profile[]> = {
      people: [],
      assets: [],
      liabilities: [],
      other: [],
    };
    for (const p of filtered) {
      map[getCategory(p.type)].push(p);
    }
    return map;
  }, [filtered]);

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = () => {
    onSave(Array.from(checked));
    setOpen(false);
  };

  const linkedCount = linkedProfileIds.length;
  const searchActive = search.trim().length > 0;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7 text-xs gap-1.5 border-dashed justify-start"
          disabled={disabled}
          data-testid="btn-link-to-profile"
        >
          <Link2 className="h-3 w-3 shrink-0" />
          <span className="truncate">
            {linkedCount > 0
              ? `Linked to ${linkedCount} ${linkedCount === 1 ? "entity" : "entities"}`
              : "Link to entity"}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="p-0 w-80"
        align="start"
        data-testid="link-profile-dropdown"
      >
        {/* Search */}
        <div className="flex items-center gap-2 px-2 py-2 border-b border-border">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            placeholder="Search entities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-6 text-xs border-0 p-0 focus-visible:ring-0 bg-transparent"
            data-testid="picker-search"
            autoFocus
          />
        </div>

        {/* Groups */}
        <ScrollArea className="max-h-72">
          <div className="px-1 pb-1">
            {CATEGORY_ORDER.map((cat) => (
              <GroupSection
                key={cat}
                label={CATEGORY_LABELS[cat]}
                profiles={grouped[cat]}
                checkedIds={checked}
                relatedIds={relatedIds}
                hasContext={hasContext}
                onToggle={toggle}
                searchActive={searchActive}
              />
            ))}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-2 py-2 border-t border-border">
          <span className="text-xs text-muted-foreground">
            {checked.size} selected
          </span>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs px-2"
              onClick={() => setOpen(false)}
              data-testid="btn-cancel-link-profile"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6 text-xs px-3"
              onClick={handleSave}
              data-testid="btn-save-link-profiles"
            >
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
