// ─── useAssetValuation ──────────────────────────────────────────────────────
//
//   CACHE FIRST → DISPLAY → FRESHNESS CHECK → BACKGROUND REFRESH → UI UPDATE
//
// The profile bootstrap already carries the stored estimate and a freshness
// verdict (seeded into ["/api/profiles", id, "valuation"] by the page's
// queryFn), so the first render shows it with the rest of the asset. If the
// verdict says the record is stale, this hook fires ONE background refresh
// and writes the result straight into the query cache; the server's write
// manifest handles every other screen that shows the value.
//
// Nothing here blocks rendering. Opening the same asset repeatedly does not
// repeat the refresh: the server answers a fresh record with `ran: false`
// without running a provider, and the client throttles attempts per asset
// so rapid switching between profiles cannot fan out a burst of requests.

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { ValuationHistoryEntry, ValuationSnapshot } from "@shared/valuation/types";

export function valuationQueryKey(profileId: string) {
  return ["/api/profiles", profileId, "valuation"] as const;
}
export function valuationHistoryQueryKey(profileId: string) {
  return ["/api/profiles", profileId, "valuation", "history"] as const;
}

/** A refresh attempt per asset at most this often from this tab (ms). */
const ATTEMPT_THROTTLE_MS = 60_000;
/** While the server reports another refresh running, poll the snapshot this often. */
const LOCKED_POLL_MS = 4_000;
const LOCKED_POLL_MAX = 8;

const inFlight = new Map<string, Promise<ValuationSnapshot | null>>();
const lastAttemptAt = new Map<string, number>();

/** Test hook: forget throttle + in-flight state. */
export function __resetValuationRefreshState(): void {
  inFlight.clear();
  lastAttemptAt.clear();
}

async function fetchSnapshot(profileId: string): Promise<ValuationSnapshot> {
  const res = await apiRequest("GET", `/api/profiles/${profileId}/valuation`);
  return res.json();
}

/**
 * Run (or join) the background refresh for one asset. Resolves with the
 * snapshot the server returned, after it has been written into the cache.
 */
export function refreshAssetValuation(profileId: string, opts: { force?: boolean } = {}): Promise<ValuationSnapshot | null> {
  const existing = inFlight.get(profileId);
  if (existing) return existing;
  const run = (async () => {
    lastAttemptAt.set(profileId, Date.now());
    let res: Response;
    try {
      res = await apiRequest("POST", `/api/profiles/${profileId}/valuation/refresh`, { force: !!opts.force });
    } catch {
      return null; // network failure — the stored estimate stays on screen
    }
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    let snapshot: ValuationSnapshot | null = body?.snapshot ?? null;
    if (res.status === 202 || body?.locked) {
      // Another request (another tab, another open) is already valuing this
      // asset. Poll the cheap snapshot until it lands, bounded.
      for (let i = 0; i < LOCKED_POLL_MAX; i++) {
        await new Promise(r => setTimeout(r, LOCKED_POLL_MS));
        try {
          snapshot = await fetchSnapshot(profileId);
          if (snapshot && !snapshot.refreshing && snapshot.freshness.fresh) break;
        } catch { /* keep polling */ }
      }
    }
    if (snapshot) {
      queryClient.setQueryData(valuationQueryKey(profileId), snapshot);
      queryClient.invalidateQueries({ queryKey: valuationHistoryQueryKey(profileId) });
    }
    return snapshot;
  })().finally(() => { inFlight.delete(profileId); });
  inFlight.set(profileId, run);
  return run;
}

export interface UseAssetValuation {
  snapshot: ValuationSnapshot | undefined;
  isLoading: boolean;
  /** A background refresh is running for this asset right now. */
  refreshing: boolean;
  /** Force a re-valuation (the user pressed Refresh). */
  refresh: () => Promise<void>;
}

export function useAssetValuation(profileId: string | undefined, opts: { enabled?: boolean } = {}): UseAssetValuation {
  const enabled = !!profileId && (opts.enabled ?? true);
  const { data, isLoading } = useQuery<ValuationSnapshot>({
    queryKey: valuationQueryKey(profileId || "none"),
    queryFn: () => fetchSnapshot(profileId!),
    enabled,
    // The bootstrap seeds this key; a seeded value is used as-is. Between
    // opens the manifest invalidation keeps it honest.
    staleTime: 60_000,
    gcTime: 10 * 60 * 1000,
    refetchOnMount: false,
  });
  const [refreshing, setRefreshing] = useState(() => !!profileId && inFlight.has(profileId));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const track = useCallback((p: Promise<unknown>) => {
    setRefreshing(true);
    p.finally(() => { if (mounted.current) setRefreshing(false); });
  }, []);

  // FRESHNESS CHECK → BACKGROUND REFRESH: after the stored estimate is on
  // screen, kick off one refresh when the server said it is stale.
  useEffect(() => {
    if (!enabled || !profileId || !data) return;
    if (!data.supported || data.freshness.fresh) return;
    if (inFlight.has(profileId)) { track(inFlight.get(profileId)!); return; }
    const last = lastAttemptAt.get(profileId) || 0;
    if (Date.now() - last < ATTEMPT_THROTTLE_MS) return;
    track(refreshAssetValuation(profileId));
  }, [enabled, profileId, data?.supported, data?.freshness?.fresh, data?.freshness?.reason, track]);

  const refresh = useCallback(async () => {
    if (!profileId) return;
    const p = refreshAssetValuation(profileId, { force: true });
    track(p);
    await p;
  }, [profileId, track]);

  return { snapshot: data, isLoading, refreshing, refresh };
}

export function useAssetValuationHistory(profileId: string | undefined, enabled = true) {
  return useQuery<ValuationHistoryEntry[]>({
    queryKey: valuationHistoryQueryKey(profileId || "none"),
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles/${profileId}/valuation?history=1`);
      const body = await res.json();
      return Array.isArray(body?.history) ? body.history : [];
    },
    enabled: !!profileId && enabled,
    staleTime: 60_000,
  });
}
