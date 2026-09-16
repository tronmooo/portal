// ─── Provider registry + runner ─────────────────────────────────────────────
// Runs every applicable provider in parallel under its own time budget and
// collects evidence + failures. A slow or broken source costs at most its
// budget and never fails the valuation as a whole.

import type { ValuationContext, ValuationEvidence, ValuationPlan } from "@shared/valuation/types";
import type { EvidenceProvider, ProviderRunResult } from "./types";
import { marketQuoteProvider } from "./market-quote";
import { liveSearchProvider } from "./live-search";

const DEFAULT_PROVIDERS: EvidenceProvider[] = [marketQuoteProvider, liveSearchProvider];
let providers: EvidenceProvider[] = DEFAULT_PROVIDERS;

export function getEvidenceProviders(): EvidenceProvider[] { return providers; }
/** Test seam: swap the provider set (null restores the defaults). */
export function setEvidenceProvidersForTest(list: EvidenceProvider[] | null): void {
  providers = list ?? DEFAULT_PROVIDERS;
}

/** Per-provider budgets. The live search is the slow one (web search + model). */
export function providerTimeoutMs(id: string): number {
  if (id === "live-search") return Number(process.env.VALUATION_LIVE_SEARCH_TIMEOUT_MS) || 38_000;
  if (id === "market-quote") return Number(process.env.VALUATION_QUOTE_TIMEOUT_MS) || 8_000;
  return 15_000;
}

export async function runProviders(
  ctx: ValuationContext,
  plan: ValuationPlan,
  now: Date,
  opts: { overallTimeoutMs?: number } = {},
): Promise<ProviderRunResult> {
  const started = Date.now();
  const applicable = getEvidenceProviders().filter(p => plan.providers.includes(p.id) && p.supports(ctx, plan));
  const failures: Record<string, string> = {};
  const succeeded: string[] = [];
  const evidence: ValuationEvidence[] = [];
  const overall = opts.overallTimeoutMs ?? 40_000;

  await Promise.all(applicable.map(async (p) => {
    const timeoutMs = Math.min(providerTimeoutMs(p.id), overall);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as any).unref?.();
    try {
      const out = await p.fetch({ ctx, plan, now, signal: controller.signal, timeoutMs });
      evidence.push(...out.map(e => ({ ...e, provider: e.provider || p.id })));
      succeeded.push(p.id);
    } catch (err: any) {
      failures[p.id] = controller.signal.aborted
        ? `timed out after ${timeoutMs}ms`
        : String(err?.message || err || "failed").slice(0, 200);
    } finally {
      clearTimeout(timer);
    }
  }));

  return { evidence, failures, succeeded, elapsedMs: Date.now() - started };
}
