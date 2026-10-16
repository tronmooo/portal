// ─── Item Enrichment Layer: client side ──────────────────────────────────────
//
// A chat turn that logged a specific food returns `pendingEnrichment`
// candidates beside the reply. The reply renders first; THEN this module posts
// each candidate to the enrichment endpoint, and the result (a refined entry,
// or a proposal for the user to accept) attaches to the assistant message as a
// card. The chat round-trip never waits for a product lookup.
import { apiRequest, queryClient } from "./queryClient";
import { invalidateDomains } from "./cache-bus";
import {
  NUTRITION_ENRICHMENT_PREF_KEY,
  parseEnrichmentMode,
  type EnrichmentMode,
  type NutritionEnrichment,
} from "@shared/nutrition-enrichment";

export interface PendingEnrichmentCandidate {
  entryId: string;
  trackerId: string;
  trackerName: string;
  item?: string;
  message?: string;
}

/** What the server answered for one entry — the card's data. */
export interface NutritionEnrichmentCardData {
  entryId: string;
  trackerId?: string;
  trackerName?: string;
  status: NutritionEnrichment["status"];
  reason?: string;
  enrichment?: NutritionEnrichment;
}

const PREF_KEY = [`/api/preferences/${NUTRITION_ENRICHMENT_PREF_KEY}`];

/** The user's setting, from the cached preference query (a failure reads as the default, never as "off"). */
export async function enrichmentMode(): Promise<EnrichmentMode> {
  try {
    const data = await queryClient.fetchQuery<{ value: string | null }>({
      queryKey: PREF_KEY,
      queryFn: async () => {
        const r = await apiRequest("GET", PREF_KEY[0]);
        if (!r.ok) throw new Error(`preference read failed: ${r.status}`);
        return r.json();
      },
      staleTime: 5 * 60_000,
    });
    return parseEnrichmentMode(data?.value);
  } catch {
    return "auto";
  }
}

async function postEnrich(c: PendingEnrichmentCandidate, intent: "auto" | "force" | "reject"): Promise<NutritionEnrichmentCardData> {
  const res = await apiRequest("POST", `/api/tracker-entries/${encodeURIComponent(c.entryId)}/enrich`, {
    trackerId: c.trackerId,
    message: c.message,
    intent,
  });
  if (!res.ok) throw new Error(`enrich failed: ${res.status}`);
  const out = await res.json();
  return {
    entryId: c.entryId,
    trackerId: out?.trackerId || c.trackerId,
    trackerName: out?.trackerName || c.trackerName,
    status: out?.status || "failed",
    reason: out?.reason,
    enrichment: out?.enrichment,
  };
}

/**
 * Run every candidate of a turn, a few at a time. `onResult` fires per entry
 * as soon as it settles so cards appear one by one. Only outcomes that changed
 * something or need the user (applied / proposed) are reported — a skipped or
 * failed lookup is silent: the base entry already stands.
 */
export async function runPendingEnrichment(
  candidates: PendingEnrichmentCandidate[],
  onResult: (data: NutritionEnrichmentCardData) => void,
): Promise<void> {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  const mode = await enrichmentMode();
  if (mode === "off") return;
  let touched = false;
  const queue = [...candidates];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      try {
        const data = await postEnrich(c, "auto");
        if (data.status === "applied" || data.status === "proposed") {
          onResult(data);
          if (data.status === "applied") touched = true;
        }
      } catch { /* optional layer — the entry is already saved */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  if (touched) await invalidateDomains("trackers", "dashboard");
}

/** "Use exact match" / "Use generic estimate" on a proposal card. */
export async function chooseEnrichment(data: NutritionEnrichmentCardData, choice: "exact" | "generic"): Promise<NutritionEnrichmentCardData> {
  const out = await postEnrich(
    { entryId: data.entryId, trackerId: data.trackerId || "", trackerName: data.trackerName || "" },
    choice === "exact" ? "force" : "reject",
  );
  await invalidateDomains("trackers", "dashboard");
  return out;
}

/** "Edit serving size": one in-place rescale of the entry and everything derived from it. */
export async function rescaleEntry(data: NutritionEnrichmentCardData, factor: number): Promise<NutritionEnrichmentCardData> {
  const res = await apiRequest("POST", `/api/tracker-entries/${encodeURIComponent(data.entryId)}/rescale`, { trackerId: data.trackerId, factor });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `rescale failed: ${res.status}`);
  }
  const out = await res.json();
  await invalidateDomains("trackers", "dashboard");
  const enrichment = out?.entry?.computed?.nutrition as NutritionEnrichment | undefined;
  return { ...data, status: enrichment?.status || data.status, enrichment: enrichment || data.enrichment };
}
