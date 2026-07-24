// ── useSeededList — "render from cache at frame 1, refine in background" ─────
// The Executive tab has already fetched /api/tasks, /api/habits, /api/goals …
// under these exact query keys with a 30s staleTime. A panel that fetches them
// again from scratch shows a spinner over data the app is literally already
// holding. Seeding from the cache makes the panel paint real rows on the first
// frame; the background refetch swaps them silently.
//
// This replaces the previous `invalidateQueries` on open, which threw the warm
// cache away and guaranteed a network round-trip — and therefore a spinner —
// every single time a popup was opened. Freshness is preserved by the existing
// `invalidateDomain()` cache bus, which already fires after in-app and AI-chat
// mutations; it does not need an extra invalidate at the point of *reading*.
import { keepPreviousData, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface SeededListOptions {
  /** Panel `open` flag — gates the query so a closed panel fetches nothing. */
  open: boolean;
  /** Defaults to 30s, matching the briefing's own staleTime. */
  staleTime?: number;
}

export function useSeededList<T = any>(
  key: QueryKey,
  fetcher: () => Promise<T[]>,
  { open, staleTime = 30_000 }: SeededListOptions,
) {
  const qc = useQueryClient();
  return useQuery<T[]>({
    queryKey: key,
    queryFn: fetcher,
    enabled: open,
    // The briefing's copy, if present. `initialDataUpdatedAt` carries the
    // original fetch time so react-query still decides staleness correctly —
    // without it, seeded data would look brand new and never refetch.
    initialData: () => qc.getQueryData<T[]>(key),
    initialDataUpdatedAt: () => qc.getQueryState(key)?.dataUpdatedAt,
    placeholderData: keepPreviousData,
    staleTime,
  });
}

/** Same contract for a plain GET path with the dashboard's profile scope. */
export function useSeededScopedList<T = any>(
  path: string,
  scope: { filterMode: string; filterIds: string[] },
  options: SeededListOptions,
) {
  const param = scope.filterMode === "selected" && scope.filterIds.length > 0
    ? `?profileIds=${scope.filterIds.join(",")}` : "";
  return useSeededList<T>(
    [path, scope.filterMode, ...scope.filterIds],
    () => apiRequest("GET", `${path}${param}`).then(r => r.json()),
    options,
  );
}
