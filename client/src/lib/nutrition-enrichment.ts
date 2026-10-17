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
import { ITEM_ENRICHMENT_PREF_KEY } from "@shared/item-identity";

export type EnrichmentTarget = "trackerEntry" | "profile" | "obligation";

export interface PendingEnrichmentCandidate {
  /** Absent on older servers: a tracker entry. */
  target?: EnrichmentTarget;
  /** A tracker entry's id (nutrition / item candidates on entries). */
  entryId?: string;
  /** A profile's or obligation's id (item candidates on those). */
  id?: string;
  trackerId?: string;
  trackerName?: string;
  kind?: string;
  item?: string;
  message?: string;
}

/** What the server answered for one record — the card's data. */
export interface NutritionEnrichmentCardData {
  target?: EnrichmentTarget;
  /** The record's id (the entry id for tracker entries). */
  entryId: string;
  trackerId?: string;
  trackerName?: string;
  kind?: string;
  status: NutritionEnrichment["status"];
  reason?: string;
  /** A nutrition enrichment (has `components`) or an item enrichment (has `attributes`). */
  enrichment?: any;
  /** The record as the server left it (a tracker entry's `values`, a profile's `fields`). */
  record?: any;
}

const recordIdOf = (c: PendingEnrichmentCandidate): string => String(c.id || c.entryId || "");
const targetOf = (c: PendingEnrichmentCandidate): EnrichmentTarget => c.target || "trackerEntry";
const TARGET_PATH: Record<EnrichmentTarget, string> = { trackerEntry: "tracker-entry", profile: "profile", obligation: "obligation" };

const PREF_KEY = [`/api/preferences/${ITEM_ENRICHMENT_PREF_KEY}`];
const LEGACY_PREF_KEY = [`/api/preferences/${NUTRITION_ENRICHMENT_PREF_KEY}`];

async function readPref(key: string[]): Promise<string | null> {
  const data = await queryClient.fetchQuery<{ value: string | null }>({
    queryKey: key,
    queryFn: async () => {
      const r = await apiRequest("GET", key[0]);
      if (!r.ok) throw new Error(`preference read failed: ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  return data?.value ?? null;
}

/**
 * The user's Enhanced Item Lookup setting, from the cached preference query
 * (`item_enrichment`, falling back to the nutrition-only key it generalizes).
 * A failed read is the default, never "off".
 */
export async function enrichmentMode(): Promise<EnrichmentMode> {
  try {
    const item = await readPref(PREF_KEY);
    if (item != null && String(item).trim()) return parseEnrichmentMode(item);
    return parseEnrichmentMode(await readPref(LEGACY_PREF_KEY));
  } catch {
    return "auto";
  }
}

async function postEnrich(c: PendingEnrichmentCandidate, intent: "auto" | "force" | "reject"): Promise<NutritionEnrichmentCardData> {
  const id = recordIdOf(c);
  const target = targetOf(c);
  const res = await apiRequest("POST", `/api/enrich/${TARGET_PATH[target]}/${encodeURIComponent(id)}`, {
    trackerId: c.trackerId,
    message: c.message,
    intent,
  });
  if (!res.ok) throw new Error(`enrich failed: ${res.status}`);
  const out = await res.json();
  return {
    target,
    entryId: id,
    trackerId: out?.trackerId || c.trackerId,
    trackerName: out?.trackerName || c.trackerName,
    kind: out?.enrichment?.kind || c.kind,
    status: out?.status || "failed",
    reason: out?.reason,
    enrichment: out?.enrichment,
    record: out?.entry || out?.record,
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
  const queue = candidates.filter((c) => recordIdOf(c));
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
  if (touched) await invalidateDomains("trackers", "profiles", "obligations", "dashboard");
}

/** "Use exact match" / "Use generic estimate" on a proposal card. */
export async function chooseEnrichment(data: NutritionEnrichmentCardData, choice: "exact" | "generic"): Promise<NutritionEnrichmentCardData> {
  const out = await postEnrich(
    { target: data.target, entryId: data.entryId, id: data.entryId, trackerId: data.trackerId || "", trackerName: data.trackerName || "" },
    choice === "exact" ? "force" : "reject",
  );
  await invalidateDomains("trackers", "profiles", "obligations", "dashboard");
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
  return { ...data, status: enrichment?.status || data.status, enrichment: enrichment || data.enrichment, record: out?.entry || data.record };
}
