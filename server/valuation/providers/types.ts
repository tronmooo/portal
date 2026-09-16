// ─── Evidence provider abstraction ──────────────────────────────────────────
//
// A provider turns ONE external (or expensive internal) source into
// normalized ValuationEvidence. The service decides which providers to run
// from the plan; a provider decides for itself whether it can serve a given
// asset. Adding a pricing source is one file that implements this interface
// and one line in the registry — no route, engine or UI change.

import type { ValuationContext, ValuationEvidence, ValuationPlan } from "@shared/valuation/types";

export interface ProviderRun {
  ctx: ValuationContext;
  plan: ValuationPlan;
  now: Date;
  /** Aborts when the provider's time budget is spent. */
  signal: AbortSignal;
  timeoutMs: number;
}

export interface EvidenceProvider {
  /** Stable id the planner names: "market-quote", "live-search", … */
  id: string;
  /** Can this provider say anything about THIS asset under THIS plan? */
  supports(ctx: ValuationContext, plan: ValuationPlan): boolean;
  /** Fetch evidence. Throw (or reject) on failure — the runner records it. */
  fetch(run: ProviderRun): Promise<ValuationEvidence[]>;
}

export interface ProviderRunResult {
  evidence: ValuationEvidence[];
  /** provider id → error message, for every provider that failed or timed out. */
  failures: Record<string, string>;
  /** provider ids that ran successfully (possibly returning no evidence). */
  succeeded: string[];
  elapsedMs: number;
}
