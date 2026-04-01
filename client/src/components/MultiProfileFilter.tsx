import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
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
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(getProfileFilter);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Sync external filter state → local state on mount
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

  // Group profiles by type for better organization
  const filteredProfiles = (profiles || []).filter(p => {
    if (profileTypes && profileTypes.length > 0) {
      return profileTypes.includes(p.type);
    }
    // Default: show people, pets, vehicles, assets (not subscriptions/loans which are child profiles)
    return ["person", "self", "pet", "vehicle", "asset"].includes(p.type);
  });

  // Sort: self first, then people, then pets, then everything else
  const sortOrder: Record<string, number> = { self: 0, person: 1, pet: 2, vehicle: 3, asset: 4 };
  const sorted = [...filteredProfiles].sort((a, b) => (sortOrder[a.type] ?? 5) - (sortOrder[b.type] ?? 5));

  const isEveryone = filter.mode === "everyone";
  const label = getFilterLabel();
  const selectedCount = filter.selectedIds.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={compact ? "sm" : "default"}
          className={`gap-1.5 ${compact ? "h-7 text-xs px-2" : "h-8 text-xs px-3"} ${!isEveryone ? "border-primary/50 bg-primary/5" : ""}`}
          data-testid="button-profile-filter"
        >
          <Filter className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} ${!isEveryone ? "text-primary" : "text-muted-foreground"}`} />
          <span className="truncate max-w-[120px]">{label}</span>
          {selectedCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[9px] ml-0.5">
              {selectedCount}
            </Badge>
          )}
          <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-64 p-0 z-50" align="start" sideOffset={4} collisionPadding={16}>
        <div className="p-2 border-b">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground">Filter by Profile</p>
            {!isEveryone && (
              <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5 gap-0.5" onClick={handleEveryone}>
                <X className="h-2.5 w-2.5" /> Clear
              </Button>
            )}
          </div>
        </div>

        <div className="overflow-y-auto max-h-[60vh] overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="p-1.5">
            {/* Everyone option */}
            <button
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${isEveryone ? "bg-primary/10 text-primary font-medium" : "hover:bg-accent"}`}
              onClick={handleEveryone}
              data-testid="filter-everyone"
            >
              <div className={`h-4 w-4 rounded border flex items-center justify-center ${isEveryone ? "bg-primary border-primary" : "border-muted-foreground/30"}`}>
                {isEveryone && (
                  <svg className="h-2.5 w-2.5 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <Users className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Everyone</span>
            </button>

            {/* Divider */}
            <div className="h-px bg-border my-1" />

            {/* Individual profiles */}
            {sorted.map(p => {
              const checked = filter.selectedIds.includes(p.id);
              const Icon = TYPE_ICONS[p.type] || User;
              return (
                <button
                  key={p.id}
                  className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left text-xs transition-colors ${checked ? "bg-primary/10 font-medium" : "hover:bg-accent"}`}
                  onClick={() => handleToggle(p.id, p.name)}
                  data-testid={`filter-profile-${p.id}`}
                >
                  <Checkbox
                    checked={checked}
                    className="h-4 w-4 pointer-events-none"
                    tabIndex={-1}
                  />
                  <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{p.name}</span>
                  <Badge variant="outline" className="ml-auto text-[9px] py-0 px-1 opacity-50">{p.type}</Badge>
                </button>
              );
            })}

            {sorted.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-3">No profiles found</p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
