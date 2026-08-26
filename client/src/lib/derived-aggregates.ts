// ─── Aggregates that move on the write, not on the refetch ──────────────────
//
// Net worth, total assets and total liabilities are computed by the server,
// because only the server sees party links and parent-residual ownership; the
// client's walk over the profiles list is parent-only and diverges on
// co-owned things. That contract is correct and this file does not break it.
//
// But it had a cost. Those numbers live in /api/dashboard-enhanced, an
// aggregate payload no row can be patched into, so after a write the tile kept
// rendering the pre-write number until a fresh recompute came back. Recording a
// $200 payment moved the balance on the liability card instantly and left net
// worth unchanged for seconds — the same page disagreeing with itself.
//
// The fix keeps the server as the source of the LEVEL and lets the client
// supply the DELTA:
//
//     shown = serverValue + (derivedNow − derivedWhenServerValueWasComputed)
//
// At rest the two derived values are identical, so the tile shows the server's
// number exactly — no drift, no flicker, no second opinion. The moment a write
// patches the profiles cache, the delta is the change the client can see, and
// the tile moves by it immediately. When the recompute lands, the baseline
// resyncs and the server is authoritative again.
//
// The client's walk being imperfect is fine here in a way it is not for the
// level: an ownership share the client models differently makes the delta the
// wrong SIZE for a moment, never the wrong number for long — the refetch
// corrects it either way, and a number that moves and then settles beats a
// number that sits still while the user wonders whether the payment saved.
import { useRef } from "react";
import { useIsFetching } from "@tanstack/react-query";

export interface TotalBaseline {
  server: number;
  derived: number;
}

/**
 * Pure core, exported for tests.
 *
 * `baseline` is what the pair looked like the last time the server payload was
 * settled. Null (nothing settled yet) means we have nothing to offset from, so
 * the server value is shown unchanged.
 */
export function reconcileTotal(
  serverValue: number | undefined,
  derived: number,
  baseline: TotalBaseline | null,
): number {
  if (typeof serverValue !== "number" || !Number.isFinite(serverValue)) return derived;
  if (!baseline || !Number.isFinite(baseline.derived) || !Number.isFinite(derived)) return serverValue;
  return serverValue + (derived - baseline.derived);
}

/**
 * Render a server-owned total that reacts to local writes immediately.
 *
 * `derived` must be computed from the CACHED entity rows (the profiles list),
 * with the shared helpers — shared/asset-value.ts, shared/net-worth.ts — so it
 * moves the instant a write patches that cache.
 */
export function useLiveTotal(
  serverValue: number | undefined,
  derived: number,
  aggregateKey: readonly unknown[],
): number {
  const fetching = useIsFetching({ queryKey: aggregateKey as unknown[] }) > 0;
  const baseline = useRef<TotalBaseline | null>(null);

  // Resync while the server payload is settled. Writing a ref during render is
  // deliberate: this is a cache of the last agreed pair, it is idempotent, and
  // it must be up to date for THIS render — an effect would resync one frame
  // late, which is one frame of the wrong number every time a refetch lands.
  if (!fetching && typeof serverValue === "number" && Number.isFinite(serverValue) && Number.isFinite(derived)) {
    baseline.current = { server: serverValue, derived };
  }

  return reconcileTotal(serverValue, derived, baseline.current);
}
