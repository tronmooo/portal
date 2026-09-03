// hooks/useProfileFilterCtx.ts — ONE way to build the context for the shared
// profile-filter rule (shared/profile-filter.ts) in a component.
//
// The rule reaches a row through the owner chain (a person's car) and through
// co-ownership (asset_party_links). Pages that built the context inline with
// only `{ selectedIds, allProfiles }` silently dropped the co-ownership half:
// Linda's 50% of the car showed its fuel on Finance (which passed the links)
// but not its trackers, habits or recurring events (which did not). Every
// page now gets the links from the same cached query, and the memoised
// context re-renders when they load.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { ProfileFilterContext } from "@shared/profile-filter";

const EMPTY: any[] = [];

/** The user's asset_party_links (co-ownership shares), cached for 5 minutes. */
export function useAssetPartyLinks(): any[] {
  const { data } = useQuery<any[]>({
    queryKey: ["/api/asset-party-links"],
    queryFn: () => apiRequest("GET", "/api/asset-party-links").then(r => r.json()),
    staleTime: 5 * 60_000,
  });
  return Array.isArray(data) ? data : EMPTY;
}

type ProfileLite = { id: string; type?: string; parentProfileId?: string | null };

/**
 * The memoised context for `passesProfileFilter`: the active selection, the
 * profile tree (id/type/parent) and the co-ownership links.
 */
export function useProfileFilterCtx(
  selectedIds: string[],
  profiles: ReadonlyArray<ProfileLite> | null | undefined,
): ProfileFilterContext {
  const assetPartyLinks = useAssetPartyLinks();
  return useMemo(() => ({
    selectedIds,
    allProfiles: (profiles || []).map(p => ({ id: p.id, type: p.type, parentProfileId: (p as any).parentProfileId ?? null })),
    assetPartyLinks,
  }), [selectedIds, profiles, assetPartyLinks]);
}
