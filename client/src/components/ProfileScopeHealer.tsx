import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { reconcileProfileFilter } from "@/lib/profileFilter";

/**
 * Keeps the persisted profile scope pointing at profiles that still exist, and
 * calling them by their current names — on every screen, not just two.
 *
 * The scope lives in localStorage, so it outlives the profiles it names. Delete
 * the person you were scoped to and every list correctly returns nothing for a
 * dead id: the header still says "Mike" and the entire app reads as empty
 * rather than as broken. Rename them and the label keeps the old name.
 *
 * `reconcileProfileFilter` has always fixed both — but it was only ever CALLED
 * from the Dashboard and from the hub's profile switcher. On any other route,
 * or with the hub chrome hidden, nothing healed the scope and the empty app
 * stayed empty until the user happened to navigate somewhere that did.
 *
 * Mounting the call app-wide costs nothing: it uses the same query key and
 * fallback the switcher does, so where the switcher is on screen this is a
 * cache hit, and reconcile is a no-op when the selection is already correct.
 *
 * Renders nothing.
 */
export function ProfileScopeHealer() {
  // Same key + fallback pattern as HubProfileSwitcher and MultiProfileFilter so
  // all three share one cache entry and one request.
  const fullProfilesCache = queryClient.getQueryData<any[]>(["/api/profiles"]);
  const { data: profiles } = useQuery<Array<{ id: string; name?: string; type?: string }>>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    initialData: fullProfilesCache as Array<{ id: string; name?: string; type?: string }> | undefined,
    staleTime: 30_000,
  });

  useEffect(() => {
    // A non-empty list is authoritative; an empty or errored one is not, and
    // reconcile guards that itself (never widen a scope on a partial fetch).
    if (profiles && profiles.length > 0) reconcileProfileFilter(profiles);
  }, [profiles]);

  return null;
}
