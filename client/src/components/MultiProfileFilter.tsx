import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { seedDashboardCaches } from "@/lib/bootstrap-seed";
import { normalizeFilter } from "@/lib/filter-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  getProfileFilter, setFilterEveryone, setFilterSelected, toggleFilterProfile,
  subscribeProfileFilter,
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
  /** Hide the "Everyone" option entirely (and the Clear shortcut that maps to it).
   *  Used by the Dashboard where global/unfiltered view is disallowed. Other pages
   *  leave this unset so their Everyone behavior is preserved. */
  hideEveryone?: boolean;
}

export function MultiProfileFilter({ onChange, profileTypes, compact, hideEveryone }: Props) {
  // PERF (2026-05-29): use the slim /api/profiles/lite endpoint — the chip
  // only renders id/type/name/avatar, so we drop the heavy jsonb columns
  // (fields, documents, linked_*) the full endpoint returns. Falls back to
  // the full endpoint's cache via initialData when it's already populated
  // so we don't double-fetch on pages that already loaded /api/profiles.
  // Key shape ["/api/profiles", "lite"] so scoped invalidations of ["/api/profiles"]
  // (prefix match) also refresh the chip after any mutation.
  const fullProfilesCache = queryClient.getQueryData<any[]>(["/api/profiles"]);
  const { data: profiles } = useQuery<any[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/profiles/lite");
      return res.json();
    },
    initialData: fullProfilesCache,
    staleTime: 30_000,
  });
  // CRITICAL: separate state per UI — shared state causes the Sheet overlay to
  // mount on desktop and block ALL page clicks, making tabs unresponsive.
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [filter, setFilter] = useState(getProfileFilter);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    // Sync initial state
    setFilter(getProfileFilter());
    // BUG-006/025: subscribe so the label/checks stay in sync when ANOTHER
    // component on the page (or another tab via storage event) mutates the
    // shared filter — the label used to be read via getFilterLabel() each
    // render, which is non-reactive and could go stale.
    const unsub = subscribeProfileFilter((next) => {
      setFilter({ ...next });
      onChangeRef.current({ mode: next.mode, selectedIds: next.selectedIds });
    });
    return unsub;
  }, []);

  const notify = useCallback(() => {
    const f = getProfileFilter();
    setFilter(f);
    onChangeRef.current({ mode: f.mode, selectedIds: f.selectedIds });
  }, []);

  const handleEveryone = useCallback(() => {
    setFilterEveryone();
    notify();
    // "Everyone" is a terminal choice (clears all selection) so close the popup
    // afterwards. Multi-select toggles below intentionally keep the popup open.
    setDesktopOpen(false);
    setMobileOpen(false);
  }, [notify]);

  const handleToggle = useCallback((id: string, name: string) => {
    toggleFilterProfile(id, name);
    notify();
  }, [notify]);

  // PROFILE-SWITCH PREFETCH (2026-07-16, user report "switching between
  // profiles is very slow"): warm the dashboard-bootstrap cache for a profile
  // BEFORE the user commits the switch — on hover (desktop) and when the
  // picker opens (mobile has no hover; warm the first few rows). The key +
  // URL mirror dashboard.tsx's bootstrap query exactly, and the fetched
  // payload seeds the same sibling caches, so completing the switch renders
  // from cache instead of a 3-5s cold aggregation.
  const prefetched = useRef(new Set<string>());
  const prefetchProfileDashboard = useCallback((id: string) => {
    if (!id || prefetched.current.has(id)) return;
    prefetched.current.add(id);
    const currentMonth = new Date().toISOString().slice(0, 7);
    void queryClient.prefetchQuery({
      queryKey: ["/api/dashboard-bootstrap", "selected", id, currentMonth],
      queryFn: async () => {
        const r = await apiRequest("GET", `/api/dashboard-bootstrap?profileIds=${id}&month=${currentMonth}`);
        const b = await r.json();
        seedDashboardCaches(b, "selected", [id], currentMonth);
        return b ?? null;
      },
      staleTime: 60_000,
    });
  }, []);
  // NOTE (2026-07-16 audit): prefetching the top-4 profiles' bootstraps when
  // the picker OPENED pushed ~700KB of JSON down the pipe at once — actively
  // harmful on weak mobile links (it competed with whatever the user was
  // actually loading). Prefetch is now per-row only, on hover/touch, which
  // fires for exactly the profile the user is about to pick.

  // Validate stored filter IDs against actual profiles — only refresh display names
  // when the underlying profile name changed. Never drop IDs based on a transient
  // empty/incomplete profiles list (that's how we lost Jane Doe from the filter
  // selection while keeping her in the label).
  useEffect(() => {
    if (!profiles || profiles.length === 0) return;
    const current = getProfileFilter();
    if (current.mode !== "selected" || current.selectedIds.length === 0) return;
    // Only act when EVERY currently-selected id resolves to a profile in the list.
    const allFound = current.selectedIds.every(id => profiles.some(p => p.id === id));
    if (!allFound) return; // profiles list isn't fully loaded yet — leave state alone
    // Refresh display names if any profile was renamed
    let nameChanged = false;
    const refreshedNames = current.selectedIds.map((id, i) => {
      const prof = profiles.find(p => p.id === id);
      const newName = prof?.name || current.selectedNames[i] || "";
      if (newName !== current.selectedNames[i]) nameChanged = true;
      return newName;
    });
    if (nameChanged) {
      setFilterSelected([...current.selectedIds], refreshedNames);
      notify();
    }
  }, [profiles]);

  const sorted = useMemo(() => {
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
    return Array.from(deduped.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [profiles, profileTypes]);

  const isEveryone = filter.mode === "everyone";
  // BUG-006/025: derive label from the reactive `filter` state, not from a
  // direct call into the module — the module is only re-read on event, so
  // reading on every render risked tearing between trigger button and list.
  const label = useMemo(() => {
    if (filter.mode === "everyone") return "Everyone";
    const names = filter.selectedNames || [];
    if (names.length === 1) return names[0];
    if (names.length === 2) return names.join(" & ");
    if (names.length > 2) return `${names[0]} +${names.length - 1}`;
    return "Everyone";
  }, [filter]);
  const selectedCount = filter.selectedIds.length;
  // Tri-state for the "Everyone" master row: some (but not all-as-everyone)
  // profiles are actively selected.
  const someSelected = !isEveryone && selectedCount > 0;

  // ── Shared list content ──────────────────────────────────
  const listContent = (
    <div className="space-y-0.5">
      {/* Everyone option — hidden when `hideEveryone` (e.g. Dashboard). */}
      {!hideEveryone && (<>
      {/* BUG-7: "Everyone" is a tri-state master. Checked = no filter (all).
          When specific people are selected it shows an indeterminate dash so
          it's obvious a filter is active (previously it read as fully
          unchecked, which was indistinguishable from "nothing selected"). */}
      <button
        className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left text-sm transition-all active:scale-[0.97] ${
          isEveryone ? 'bg-primary/10 text-primary font-medium border border-primary/30' : 'hover:bg-accent active:bg-accent border border-transparent'
        }`}
        onClick={handleEveryone}
        style={{ minHeight: '52px', WebkitTapHighlightColor: 'transparent' }}
        data-testid="filter-everyone"
        aria-checked={isEveryone ? "true" : (someSelected ? "mixed" : "false")}
        role="checkbox"
      >
        <div className={`h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 ${isEveryone || someSelected ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
          {isEveryone && (
            <svg className="h-3 w-3 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
          {!isEveryone && someSelected && (
            <svg className="h-3 w-3 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M2.5 6h7" />
            </svg>
          )}
        </div>
        <Users className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1">Everyone</span>
        {someSelected && (
          <span className="text-[11px] text-muted-foreground shrink-0">{selectedCount} selected</span>
        )}
      </button>

      <div className="h-px bg-border my-1.5 mx-3" />
      </>)}

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
            onMouseEnter={() => prefetchProfileDashboard(p.id)}
            onTouchStart={() => prefetchProfileDashboard(p.id)}
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
                <Badge variant="secondary" className="h-4 px-1 text-xs-tight ml-1.5">{selectedCount}</Badge>
              )}
              <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-60 p-2 max-h-[400px] overflow-y-auto z-50">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Filter by Person</span>
              <div className="flex items-center gap-1">
                {!isEveryone && !hideEveryone && (
                  <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5 gap-1" onClick={() => { handleEveryone(); setDesktopOpen(false); }}>
                    <X className="h-3 w-3" /> Clear
                  </Button>
                )}
                <Button variant="ghost" size="sm" className="h-6 text-xs px-1.5" onClick={() => setDesktopOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
            {/* IMPORTANT: do NOT auto-close on every click here. The previous
                wrapper <div onClick={close}> made multi-select impossible —
                tapping any profile slammed the popover shut after a single
                toggle. Users now click profiles freely; the popover closes on
                Done, Clear, Everyone, or by clicking outside (Radix default). */}
            {listContent}
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
            <Badge variant="secondary" className="h-4 px-1 text-xs-tight ml-1.5">{selectedCount}</Badge>
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
        </Button>
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="bottom" className="max-h-[70vh] rounded-t-2xl px-2 pb-6 flex flex-col">
            <SheetHeader className="px-2 pb-2 shrink-0">
              <div className="flex items-center justify-between">
                <SheetTitle className="text-sm">Filter by Profile</SheetTitle>
                {!isEveryone && !hideEveryone && (
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
