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
import { prefetchScopeBootstrap } from "@/lib/scope-prefetch";
import { modalJustClosed } from "@/lib/modal-history";

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

  /* The LIVE name wins over the remembered one.
     `selectedNames` is a snapshot taken when the scope was chosen and kept in
     localStorage. reconcileProfileFilter refreshes it, but returns early the
     moment every selected id still resolves — which is exactly the case after
     a RENAME — so the stored name could sit here indefinitely, across reloads,
     while the profile itself was called something else everywhere in the app.
     Preferring `p?.name` makes the rename show up the moment the profile list
     does; the stored name stays as the fallback for a list that hasn't loaded
     (or a scope pointing at something not in `people`, e.g. an asset). */
  const nameOf = (id: string, i: number) =>
    (profiles || []).find(x => x.id === id)?.name || scope.selectedNames[i] || "";
  const label = (() => {
    if (scope.mode === "everyone") return "Everyone";
    if (scope.selectedIds.length === 1) {
      const p = people.find(x => x.id === scope.selectedIds[0]);
      if (p?.type === "self") return "My dashboard";
      return nameOf(scope.selectedIds[0], 0) || "My dashboard";
    }
    if (scope.selectedIds.length > 1) {
      return `${nameOf(scope.selectedIds[0], 0) || "Selected"} +${scope.selectedIds.length - 1}`;
    }
    return "My dashboard";
  })();

  const isChecked = (id: string) => scope.mode === "selected" && scope.selectedIds.includes(id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline" size="sm"
          className="h-8 gap-1.5 rounded-lg px-2.5 text-xs font-semibold"
          // Ghost-click shield: the switcher sits at the same screen position
          // as a dialog's X, so the tap that dismissed a modal could fall
          // through onto it and open the menu (2026-07-29 tester report:
          // accidental profile switches). Swallow opens within 350ms of any
          // modal closing — Radix respects defaultPrevented on pointerdown.
          onPointerDown={(e) => { if (modalJustClosed()) e.preventDefault(); }}
          data-testid="hub-profile-switcher">
          <Gem className="h-3.5 w-3.5 text-primary" />
          <span className="max-w-[9rem] truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          onClick={() => setFilterEveryone()}
          // Everyone is the heaviest scope (aggregates every profile) and is
          // never the boot-time scope, so it was always cold — measured 7s of
          // skeletons on the 2026-07-17 live drive. Warm it like the person rows.
          onMouseEnter={() => prefetchScopeBootstrap("everyone", [])}
          onTouchStart={() => prefetchScopeBootstrap("everyone", [])}
          data-testid="hub-switch-everyone"
        >
          <Users className="h-3.5 w-3.5 mr-2" />
          <span className="flex-1">Everyone</span>
          {scope.mode === "everyone" && <Check className="h-3.5 w-3.5 text-primary" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {people.map(p => (
          <DropdownMenuItem
            key={p.id}
            onClick={() => setFilterSelected([p.id], [p.name])}
            // PERF Phase 2.1: warm this person's dashboard-bootstrap BEFORE the
            // click commits the switch (hover on desktop, touchstart on mobile
            // — same pattern as MultiProfileFilter, which got this in df6f0ec
            // while this switcher, the one actually on screen, did not).
            // prefetchScopeBootstrap dedupes, so hover+click costs one request.
            onMouseEnter={() => prefetchScopeBootstrap("selected", [p.id])}
            onTouchStart={() => prefetchScopeBootstrap("selected", [p.id])}
            data-testid={`hub-switch-${p.id}`}
          >
            <span className="w-5 h-5 mr-2 rounded-full bg-muted flex items-center justify-center text-[11px] font-bold overflow-hidden">
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
        {/* Says "everyone", so it selects everyone. The Info screen renders the
            people in the current scope (like every other hub tab), so landing
            there with one person still selected would have shown exactly that
            one person under a menu item promising the opposite. */}
        <DropdownMenuItem
          onClick={() => { setFilterEveryone(); navigate("/profiles"); }}
          data-testid="hub-switch-manage">
          View everyone’s info…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
