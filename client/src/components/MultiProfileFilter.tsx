import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  getProfileFilter, setFilterEveryone, toggleFilterProfile, getFilterLabel,
  type FilterMode,
} from "@/lib/profileFilter";
import { Filter, Users, User, Dog, Car, CreditCard, Package, Stethoscope, Building, Landmark, ChevronDown, X } from "lucide-react";

const TYPE_ICONS: Record<string, any> = {
  person: User,
  self: User,
  pet: Dog,
  vehicle: Car,
  subscription: CreditCard,
  asset: Package,
  medical: Stethoscope,
  property: Building,
  loan: Landmark,
  account: Landmark,
  investment: Landmark,
};

interface Props {
  /** Called whenever the filter changes so the parent can re-render */
  onChange: (filter: { mode: FilterMode; selectedIds: string[] }) => void;
  /** Only show these profile types in the filter (default: all) */
  profileTypes?: string[];
  /** Compact mode for inline placement */
  compact?: boolean;
}

export function MultiProfileFilter({ onChange, profileTypes, compact }: Props) {
  const { data: profiles } = useQuery<any[]>({ queryKey: ["/api/profiles"] });
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(getProfileFilter);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    setFilter(getProfileFilter());
  }, []);

  const notify = useCallback(() => {
    const f = getProfileFilter();
    setFilter(f);
    onChangeRef.current({ mode: f.mode, selectedIds: f.selectedIds });
  }, []);

  const handleEveryone = useCallback(() => {
    setFilterEveryone();
    notify();
  }, [notify]);

  const handleToggle = useCallback((id: string, name: string) => {
    toggleFilterProfile(id, name);
    notify();
  }, [notify]);

  // Validate stored filter IDs against actual profiles — fix corrupted localStorage
  useEffect(() => {
    if (!profiles || profiles.length === 0) return;
    const current = getProfileFilter();
    if (current.mode === "selected" && current.selectedIds.length > 0) {
      const validIds = profiles.map(p => p.id);
      const validSelected = current.selectedIds.filter(id => validIds.includes(id));
      if (validSelected.length !== current.selectedIds.length) {
        // Some stored IDs don't match any profile — clear the filter
        console.warn("[Filter] Clearing invalid stored filter IDs");
        setFilterEveryone();
        notify();
      } else {
        // Verify names match (fix name/ID mismatch)
        const correctedNames = validSelected.map(id => {
          const p = profiles.find(pr => pr.id === id);
          return p?.name || "Unknown";
        });
        const namesChanged = correctedNames.some((n, i) => n !== current.selectedNames[i]);
        if (namesChanged) {
          setFilterSelected(validSelected, correctedNames);
          notify();
        }
      }
    }
  }, [profiles]);

  const typeFiltered = (profiles || []).filter(p => {
    if (profileTypes && profileTypes.length > 0) {
      return profileTypes.includes(p.type);
    }
    // Only show primary profile types — not assets, vehicles, subscriptions, etc.
    return ["person", "self", "pet"].includes(p.type);
  });

  // Deduplicate by name+type — keep the one with the most linked data
  const deduped = new Map<string, any>();
  for (const p of typeFiltered) {
    const key = `${p.type}::${p.name}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, p);
    } else {
      // Keep the profile with more linked data (documents, expenses, tasks, etc.)
      const score = (prof: any) =>
        (prof.documents?.length || 0) + (prof.expenses?.length || 0) + (prof.tasks?.length || 0);
      if (score(p) > score(existing)) deduped.set(key, p);
    }
  }
  const filteredProfiles = Array.from(deduped.values());

  const sortOrder: Record<string, number> = { self: 0, person: 1, pet: 2 };
  const sorted = [...filteredProfiles].sort((a, b) => (sortOrder[a.type] ?? 5) - (sortOrder[b.type] ?? 5));

  const isEveryone = filter.mode === "everyone";
  const label = getFilterLabel();
  const selectedCount = filter.selectedIds.length;

  // ── Shared list content ──────────────────────────────────
  const listContent = (
    <div className="space-y-0.5">
      {/* Everyone option */}
      <button
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${isEveryone ? "bg-primary/10 text-primary font-medium" : "hover:bg-accent active:bg-accent"}`}
        onClick={handleEveryone}
        data-testid="filter-everyone"
      >
        <div className={`h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 ${isEveryone ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
          {isEveryone && (
            <svg className="h-3 w-3 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
        </div>
        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1">Everyone</span>
      </button>

      <div className="h-px bg-border my-1.5 mx-3" />

      {sorted.map(p => {
        const checked = filter.selectedIds.includes(p.id);
        const Icon = TYPE_ICONS[p.type] || User;
        return (
          <button
            key={p.id}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${checked ? "bg-primary/10 font-medium" : "hover:bg-accent active:bg-accent"}`}
            onClick={() => handleToggle(p.id, p.name)}
            data-testid={`filter-profile-${p.id}`}
          >
            <Checkbox
              checked={checked}
              className="h-5 w-5 pointer-events-none shrink-0"
              tabIndex={-1}
            />
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="flex-1 truncate">{p.name}</span>
            <span className="text-[10px] text-muted-foreground/50 shrink-0">{p.type}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <Button
        variant="outline"
        size={compact ? "sm" : "default"}
        className={`gap-1.5 ${compact ? "h-8 text-xs px-2.5" : "h-9 text-sm px-3"} ${!isEveryone ? "border-primary/50 bg-primary/5" : ""}`}
        onClick={() => setOpen(true)}
        data-testid="button-profile-filter"
      >
        <Filter className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4"} ${!isEveryone ? "text-primary" : "text-muted-foreground"}`} />
        <span className="truncate max-w-[100px]">{label}</span>
        {selectedCount > 0 && (
          <Badge variant="secondary" className="h-4 px-1 text-[9px] ml-0.5">
            {selectedCount}
          </Badge>
        )}
        <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
      </Button>

      {/* Bottom sheet for filter — reliable scrolling on all devices */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[70vh] rounded-t-2xl px-2 pb-6 flex flex-col">
          <SheetHeader className="px-2 pb-2 shrink-0">
            <div className="flex items-center justify-between">
              <SheetTitle className="text-sm">Filter by Profile</SheetTitle>
              {!isEveryone && (
                <Button variant="ghost" size="sm" className="h-7 text-xs px-2 gap-1" onClick={handleEveryone}>
                  <X className="h-3 w-3" /> Clear
                </Button>
              )}
            </div>
          </SheetHeader>
          <div
            className="overflow-y-auto min-h-0 flex-1 -mx-2 px-2 overscroll-contain"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            {listContent}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
