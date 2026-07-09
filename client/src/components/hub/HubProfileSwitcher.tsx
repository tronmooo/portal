// ── Hub profile switcher ─────────────────────────────────────────────────────
// "My dashboard ▾" dropdown in the hub shell. A restyled front-end for the
// SAME global filter store MultiProfileFilter uses (lib/profileFilter.ts) —
// it writes through the store's public API only, so every existing subscriber
// (dashboard, trackers, finance, calendar, ...) rescopes automatically and
// the two UIs can never disagree.
//
// IMPORTANT: never writes the store on mount — initDefaultProfileFilter()
// (dashboard.tsx) seeds the Self profile on first load and a mount-time write
// here would race it.
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Gem, Users } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import {
  reconcileProfileFilter, setFilterEveryone, setFilterSelected, toggleFilterProfile,
} from "@/lib/profileFilter";

interface LiteProfile { id: string; type: string; name: string; avatar?: string }

export function HubProfileSwitcher() {
  const [, navigate] = useLocation();
  const scope = useProfileScope();

  // Same key + fallback pattern as MultiProfileFilter so the two share a cache.
  const fullProfilesCache = queryClient.getQueryData<any[]>(["/api/profiles"]);
  const { data: profiles } = useQuery<LiteProfile[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    initialData: fullProfilesCache as LiteProfile[] | undefined,
    staleTime: 30_000,
  });
  const people = (profiles || []).filter(p => ["self", "person", "pet"].includes(p.type));

  // Heal a persisted scope pointing at deleted/recreated profile ids (the
  // "header says Mike, every tile says 0" state). /api/profiles/lite returns
  // ALL live profiles, so a loaded non-empty list is authoritative;
  // reconcileProfileFilter no-ops when every selected id still resolves.
  useEffect(() => {
    if (profiles && profiles.length > 0) reconcileProfileFilter(profiles);
  }, [profiles]);

  const label = (() => {
    if (scope.mode === "everyone") return "Everyone";
    if (scope.selectedIds.length === 1) {
      const p = people.find(x => x.id === scope.selectedIds[0]);
      if (p?.type === "self") return "My dashboard";
      return scope.selectedNames[0] || p?.name || "My dashboard";
    }
    if (scope.selectedIds.length > 1) {
      return `${scope.selectedNames[0] || "Selected"} +${scope.selectedIds.length - 1}`;
    }
    return "My dashboard";
  })();

  const isChecked = (id: string) => scope.mode === "selected" && scope.selectedIds.includes(id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-lg px-2.5 text-xs font-semibold" data-testid="hub-profile-switcher">
          <Gem className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[9rem] truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => setFilterEveryone()} data-testid="hub-switch-everyone">
          <Users className="h-3.5 w-3.5 mr-2" />
          <span className="flex-1">Everyone</span>
          {scope.mode === "everyone" && <Check className="h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {people.map(p => (
          <DropdownMenuItem
            key={p.id}
            onClick={() => setFilterSelected([p.id], [p.name])}
            data-testid={`hub-switch-${p.id}`}
          >
            <span className="w-5 h-5 mr-2 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold overflow-hidden">
              {p.avatar
                ? <img src={p.avatar} alt="" className="w-full h-full object-cover" />
                : (p.name || "?").charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 truncate">{p.type === "self" ? `${p.name} (me)` : p.name}</span>
            {/* Checkbox zone: build a multi-select without closing semantics
                changing — same toggleFilterProfile the chip UI uses. */}
            <span
              role="checkbox"
              aria-checked={isChecked(p.id)}
              aria-label={`Include ${p.name}`}
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleFilterProfile(p.id, p.name); }}
              className={`ml-2 w-4 h-4 rounded border flex items-center justify-center ${isChecked(p.id) ? "bg-primary border-primary text-primary-foreground" : "border-border"}`}
            >
              {isChecked(p.id) && <Check className="h-3 w-3" />}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/profiles")} data-testid="hub-switch-manage">
          View everyone’s info…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
