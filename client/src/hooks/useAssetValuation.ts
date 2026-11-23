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
import type { ValuationHistoryEntry, ValuationSnapshot, ValuationStatusRow } from "@shared/valuation/types";
import { perfMark, perfMeasure } from "@/lib/perf-marks";
import { syncLog } from "@shared/sync-log";

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
/** Did the last refresh of this asset land a different estimate? (the server's `changed`) */
const lastRunChanged = new Map<string, boolean>();

/** Test hook: forget throttle + in-flight state. */
export function __resetValuationRefreshState(): void {
  inFlight.clear();
  lastAttemptAt.clear();
  lastRunChanged.clear();
}

function snapshotStamp(s: ValuationSnapshot | null | undefined): number {
  const r: any = s?.record;
  const raw = r?.valuedAt || r?.checkedAt;
  const t = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/**
 * May `incoming` replace `cached`? Yes unless both are stamped and the
 * incoming estimate was made strictly earlier. Exported for the regression
 * test (tests/sync-rules-valuation.test.ts).
 */
export function isSnapshotNewerOrEqual(incoming: ValuationSnapshot | null | undefined, cached: ValuationSnapshot | null | undefined): boolean {
  const a = snapshotStamp(incoming);
  const b = snapshotStamp(cached);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a >= b;
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
    perfMark(`valuation:start:${profileId}`);
    let res: Response;
    try {
      // apiRequest applies the write manifest before resolving: the mirrored
      // profile row is already patched into every cached list (Assets cards,
      // ownership rollups) and the asset-derived aggregates (net worth, KPI
      // strip) are already refetching by the time we get here.
      res = await apiRequest("POST", `/api/profiles/${profileId}/valuation/refresh`, { force: !!opts.force });
    } catch {
      return null; // network failure — the stored estimate stays on screen
    }
    perfMeasure(`valuation:complete:${profileId}`, `valuation:start:${profileId}`);
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    let snapshot: ValuationSnapshot | null = body?.snapshot ?? null;
    lastRunChanged.set(profileId, body?.changed === true);
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
      // Rule 7: a slower, older run (the sweep's, another tab's, a polled
      // snapshot) must not put an older estimate back over a newer one.
      const cached = queryClient.getQueryData<ValuationSnapshot>(valuationQueryKey(profileId));
      if (!isSnapshotNewerOrEqual(snapshot, cached)) {
        syncLog("stale-reject", "older valuation snapshot ignored", { valuedAt: snapshot.record?.valuedAt, cachedAt: cached?.record?.valuedAt });
        return cached ?? snapshot;
      }
      syncLog("valuation", "valuation landed", { value: snapshot.record?.value ?? null, valuedAt: snapshot.record?.valuedAt ?? null });
      queryClient.setQueryData(valuationQueryKey(profileId), snapshot);
      queryClient.invalidateQueries({ queryKey: valuationHistoryQueryKey(profileId) });
      perfMark(`valuation:cache-updated:${profileId}`);
    }
    return snapshot;
  })().finally(() => { inFlight.delete(profileId); });
  inFlight.set(profileId, run);
  return run;
}

// ─── The Assets-tab sweep ────────────────────────────────────────────────────
// OPEN ASSETS → the list renders from stored values at once → one cheap
// status call lists every owned thing → EVERY asset with "Track value
// automatically" on is re-valued, all at once (bounded) → each completion
// patches its own row and the aggregates as it lands, never waiting for the
// rest. Opening the tab is the request for current values; nobody has to open
// each asset. Only an asset checked within the last day is skipped, so
// reloading the tab doesn't re-buy the same lookups.

/** How many AI summaries are re-written at once after a sweep. */
export const SUMMARY_CONCURRENCY = 2;

/**
 * Re-write the AI summary of each asset whose estimate just changed, so it is
 * ready when its profile is opened (owner, 2026-11-23). An ordinary read: the
 * server regenerates a summary whose value fingerprint no longer matches and
 * answers from its cache otherwise, so an unchanged asset costs nothing and is
 * not asked. Failures are ignored — the profile fetches its own on open.
 */
async function refreshSummaries(ids: string[]): Promise<void> {
  await runBounded(ids, SUMMARY_CONCURRENCY, async (id) => {
    try {
      const res = await apiRequest("GET", `/api/profiles/${id}/ai-summary`);
      const body = await res.json();
      if (body && typeof body === "object" && typeof body.summary === "string") {
        queryClient.setQueryData(["/api/profiles", id, "ai-summary"], body);
      }
    } catch { /* the profile asks again when it opens */ }
  });
}

/** How many valuations run at once from one tab. */
export const SWEEP_CONCURRENCY = 8;
/**
 * An asset the estimator looked at more recently than this is not re-run.
 * A day (owner, 2026-11-23: "everything is just taking way too long"): one
 * estimate is ~40 s of live web research, and re-running it every ten minutes
 * made every open slow while the value only wobbled. Opening still refreshes
 * on its own, once a day; the Refresh button runs one now.
 */
export const SWEEP_RECHECK_MS = 24 * 60 * 60_000;
/** Don't re-sweep the same list more often than this from one tab. */
const SWEEP_THROTTLE_MS = 60_000;
let lastSweepAt = 0;
let sweepInFlight: Promise<void> | null = null;

export interface SweepProgress {
  /** Stale assets found by the status call. */
  total: number;
  done: number;
  running: boolean;
  failed: number;
}

export function __resetSweepState(): void { lastSweepAt = 0; sweepInFlight = null; }

async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Sweep every owned thing when the Assets tab is open: re-value every stale
 * or automatically-tracked asset with bounded concurrency, and report progress. One asset's
 * failure or slowness never holds the others; a second mount while a sweep
 * is running joins it instead of starting another.
 */
export function useAssetsValuationSweep(enabled: boolean): SweepProgress {
  const [progress, setProgress] = useState<SweepProgress>({ total: 0, done: 0, running: false, failed: 0 });
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!enabled) return;
    if (sweepInFlight) { setProgress(p => ({ ...p, running: true })); sweepInFlight.finally(() => { if (mounted.current) setProgress(p => ({ ...p, running: false })); }); return; }
    if (Date.now() - lastSweepAt < SWEEP_THROTTLE_MS) return;
    lastSweepAt = Date.now();
    const update = (patch: Partial<SweepProgress>) => { if (mounted.current) setProgress(p => ({ ...p, ...patch })); };
    sweepInFlight = (async () => {
      perfMark("assets:sweep:start");
      let rows: ValuationStatusRow[] = [];
      try {
        const res = await apiRequest("GET", "/api/valuations/status");
        rows = (await res.json())?.rows || [];
      } catch {
        return; // the list already shows stored values; nothing to sweep
      }
      const now = Date.now();
      const due = (r: ValuationStatusRow) => {
        if (!r.fresh) return true;
        // A fresh row is re-valued only when the server says tracking is on
        // (manual assets also report fresh) and it wasn't just checked.
        if (r.auto !== true) return false;
        const checked = r.checkedAt ? new Date(r.checkedAt).getTime() : NaN;
        return !Number.isFinite(checked) || now - checked >= SWEEP_RECHECK_MS;
      };
      const stale = rows.filter(due).map(r => r.profileId)
        .filter(id => !inFlight.has(id) && now - (lastAttemptAt.get(id) || 0) >= ATTEMPT_THROTTLE_MS);
      update({ total: stale.length, done: 0, failed: 0, running: stale.length > 0 });
      if (stale.length === 0) return;
      let done = 0, failed = 0;
      const changed: string[] = [];
      await runBounded(stale, SWEEP_CONCURRENCY, async (id) => {
        // force: a record still inside its freshness window is re-valued too.
        const snap = await refreshAssetValuation(id, { force: true });
        done++;
        if (!snap || snap.record?.status === "error") failed++;
        else if (lastRunChanged.get(id)) changed.push(id);
        update({ done, failed });
      });
      // After the values: the summaries of the assets that moved. Not awaited
      // by the indicator — the values are what the list shows.
      if (changed.length > 0) void refreshSummaries(changed);
      perfMeasure("assets:sweep:complete", "assets:sweep:start");
    })().finally(() => { sweepInFlight = null; update({ running: false }); });
  }, [enabled]);

  return progress;
}

/**
 * Should opening this asset ask for a current estimate? Yes when the server
 * says the stored one is stale — and, for an asset Portol tracks, whenever it
 * has not been checked in the last day (owner, 2026-11-23: "check for
 * updated market values whenever an asset profile opens"; then, same day, a
 * day and not ten minutes — see SWEEP_RECHECK_MS). The same window
 * the Assets-tab sweep uses, so opening the tab and then a profile asks once.
 * `force` says the server's own freshness window should not hold it back.
 */
export function refreshOnOpen(snapshot: ValuationSnapshot | null | undefined, now: number = Date.now()): { refresh: boolean; force: boolean } {
  if (!snapshot || !snapshot.supported) return { refresh: false, force: false };
  if (!snapshot.freshness.fresh) return { refresh: true, force: false };
  if (snapshot.mode === "manual") return { refresh: false, force: false };
  const r: any = snapshot.record;
  const checked = Date.parse(String(r?.checkedAt || r?.valuedAt || ""));
  const due = !Number.isFinite(checked) || now - checked >= SWEEP_RECHECK_MS;
  return { refresh: due, force: due };
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

  // A refresh that is ALREADY running when this card mounts (the Assets-tab
  // sweep, or one started on a previous visit) is followed to its end. The
  // flag used to be seeded true from `inFlight` and cleared only by a refresh
  // this hook started itself; with a fresh snapshot the effect below returns
  // early, so the card said "Estimating… Refreshing…" forever beside a value.
  useEffect(() => {
    const running = profileId ? inFlight.get(profileId) : undefined;
    if (running) track(running);
    else setRefreshing(false);
  }, [profileId, track]);

  // FRESHNESS CHECK → BACKGROUND REFRESH: after the stored estimate is on
  // screen, kick off one refresh when the server said it is stale, or when a
  // tracked asset has not been checked in the last few minutes (refreshOnOpen).
  useEffect(() => {
    if (!enabled || !profileId || !data) return;
    const due = refreshOnOpen(data);
    if (!due.refresh) return;
    if (inFlight.has(profileId)) { track(inFlight.get(profileId)!); return; }
    const last = lastAttemptAt.get(profileId) || 0;
    if (Date.now() - last < ATTEMPT_THROTTLE_MS) return;
    track(refreshAssetValuation(profileId, { force: due.force }));
  }, [enabled, profileId, data?.supported, data?.freshness?.fresh, data?.freshness?.reason, data?.mode, track]);

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
