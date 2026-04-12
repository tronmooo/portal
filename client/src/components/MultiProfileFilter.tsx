import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { normalizeFilter } from "@/lib/filter-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  getProfileFilter, setFilterEveryone, setFilterSelected, toggleFilterProfile, getFilterLabel,
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
  // CRITICAL: separate state per UI — shared state causes the Sheet overlay to
  // mount on desktop and block ALL page clicks, making tabs unresponsive.
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
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
      // Verify each stored ID matches a real profile AND the name matches
      let needsFix = false;
      const correctedIds: string[] = [];
      const correctedNames: string[] = [];
      for (let i = 0; i < current.selectedIds.length; i++) {
        const storedId = current.selectedIds[i];
        const storedName = current.selectedNames[i] || "";
        const profile = profiles.find(p => p.id === storedId);
        if (!profile) {
          needsFix = true; // ID doesn't exist
          continue;
        }
        // Check if stored name matches the profile's actual name
        if (profile.name !== storedName) {
          needsFix = true; // Name mismatch — could be wrong ID stored under wrong name
        }
        correctedIds.push(storedId);
        correctedNames.push(profile.name);
      }
      if (needsFix) {
        if (correctedIds.length === 0) {
          setFilterEveryone();
        } else {
          setFilterSelected(correctedIds, correctedNames);
        }
        notify();
      }
    }
  }, [profiles]);

  const typeFiltered = (profiles || []).filter(p => {
    if (profileTypes && profileTypes.length > 0) {
      return profileTypes.some(t => normalizeFilter(t) === normalizeFilter(p.type));
    }
    // Only show primary profile types — not assets, vehicles, subscriptions, etc.
    return ["person", "self", "pet"].some(t => normalizeFilter(t) === normalizeFilter(p.type));
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
        className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-sm transition-all active:scale-[0.97] ${
          isEveryone ? 'bg-primary/10 text-primary font-medium border border-primary/30' : 'hover:bg-accent active:bg-accent border border-transparent'
        }`}
        onClick={handleEveryone}
        style={{ minHeight: '52px', WebkitTapHighlightColor: 'transparent' }}
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

      {sorted.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-3 px-3">No profiles to filter by</p>
      )}

      {sorted.map(p => {
        const checked = filter.selectedIds.includes(p.id);
        const Icon = TYPE_ICONS[p.type] || User;
        return (
          <button
            key={p.id}
            className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-sm transition-all active:scale-[0.97] ${
              checked ? 'bg-primary/10 font-medium border border-primary/30' : 'hover:bg-accent active:bg-accent border border-transparent'
            }`}
            onClick={() => handleToggle(p.id, p.name)}
            data-testid={`filter-profile-${p.id}`}
            style={{ minHeight: '52px', WebkitTapHighlightColor: 'transparent' }}
          >
            <Checkbox
              checked={checked}
              className="h-5 w-5 pointer-events-none shrink-0"
              tabIndex={-1}
            />
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="flex-1 truncate">{p.name}</span>
            <span className="text-xs text-muted-foreground/50 shrink-0">{p.type}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      {/* Desktop: Popover dropdown (desktopOpen state — isolated from Sheet) */}
      <div className="hidden md:block">
        <Popover open={desktopOpen} onOpenChange={setDesktopOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size={compact ? "sm" : "default"}
              className={`gap-1.5 ${compact ? "h-8 text-xs px-2.5" : "h-9 text-sm px-3"} ${!isEveryone ? "border-primary/50 bg-primary/5" : ""}`}
              data-testid="button-profile-filter"
            >
              <Filter className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4"} ${!isEveryone ? "text-primary" : "text-muted-foreground"}`} />
              <span className="truncate max-w-[100px]">{label}</span>
              {selectedCount > 0 && (
                <Badge variant="secondary" className="h-4 px-1 text-xs-tight ml-0.5">{selectedCount}</Badge>
              )}
              <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-2 max-h-[400px] overflow-y-auto z-50">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Filter by Person</span>
              {!isEveryone && (
                <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5 gap-1" onClick={() => { handleEveryone(); setDesktopOpen(false); }}>
                  <X className="h-3 w-3" /> Clear
                </Button>
              )}
            </div>
            <div onClick={() => setDesktopOpen(false)}>
              {listContent}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* Mobile: Bottom sheet (mobileOpen state — isolated from Popover) */}
      <div className="md:hidden">
        <Button
          variant="outline"
          size={compact ? "sm" : "default"}
          className={`gap-1.5 ${compact ? "h-8 text-xs px-2.5" : "h-9 text-sm px-3"} ${!isEveryone ? "border-primary/50 bg-primary/5" : ""}`}
          onClick={() => setMobileOpen(true)}
          data-testid="button-profile-filter-mobile"
        >
          <Filter className={`${compact ? "h-3.5 w-3.5" : "h-4 w-4"} ${!isEveryone ? "text-primary" : "text-muted-foreground"}`} />
          <span className="truncate max-w-[100px]">{label}</span>
          {selectedCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-xs-tight ml-0.5">{selectedCount}</Badge>
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
        </Button>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
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
            <div className="overflow-y-auto min-h-0 flex-1 -mx-2 px-2 overscroll-contain">
              {listContent}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}
