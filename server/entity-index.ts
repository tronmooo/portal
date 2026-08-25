// server/entity-index.ts — a snapshot of what already exists.
//
// `planExtractionActions` (shared/extraction-actions.ts) is pure: it never
// touches storage, because the CLIENT re-runs it as the user edits values in
// the review pane and both sides have to reach the identical plan. That is only
// possible if the records it resolves against travel WITH the extraction, so
// this builds that snapshot once on the server and ships it.
//
// It is read evidence, never a write target, and it is deliberately thin: names,
// types, identifiers and the few fields resolution actually reads. Shipping
// whole profiles would put a user's entire record set into a chat payload for
// no gain.
//
// The one rule that matters here: this is how "resolution precedes creation"
// becomes possible at all. Without it the planner has nothing to match against
// and every entity in every document looks new.

import { storage } from "./storage";
import type { EntityIndex, IndexedProfile } from "@shared/extraction-actions";
import { emptyEntityIndex } from "@shared/extraction-actions";
import { logger } from "./logger";

const CAT = "entity-index";

/**
 * Fields resolution reads off a profile. Everything else is noise in the
 * payload — but note this is a MINIMUM, not a whitelist of what may match:
 * identifier matching scans every scalar field, because a policy number can be
 * stored under any spelling and half the point of matching on identifiers is
 * that we do not have to know which one.
 */
const RESOLUTION_FIELDS = [
  "address", "streetAddress", "propertyAddress", "vin", "policyNumber",
  "loanNumber", "accountNumber", "accountNumberLast4", "serialNumber",
  "parcelNumber", "licenseNumber", "microchipNumber", "membershipNumber",
  "lender", "carrier", "insuranceProvider",
  // Bundled-cost detection reads these to answer "is this already paid for
  // inside something else?" — the escrow case.
  "escrowMonthly", "escrowIncludesInsurance", "homeownersInsurance", "propertyTaxes",
];

/** Keep scalar fields only, and cap the payload so one odd record cannot bloat it. */
function thinFields(fields: unknown): Record<string, any> {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const out: Record<string, any> = {};
  let n = 0;
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;             // reserved provenance metadata
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") {
      // One level of nesting: `insurance.policyNumber` is exactly the kind of
      // place an identifier hides, so flatten it rather than dropping it.
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        if (nv === null || nv === undefined || nv === "" || typeof nv === "object") continue;
        if (n++ > 200) break;
        out[`${k}.${nk}`] = nv;
      }
      continue;
    }
    if (n++ > 200) break;
    out[k] = v;
  }
  // Make sure the fields resolution specifically looks for survived the cap.
  for (const key of RESOLUTION_FIELDS) {
    const v = (fields as Record<string, any>)[key];
    if (v !== undefined && v !== null && v !== "" && typeof v !== "object") out[key] = v;
  }
  return out;
}

/**
 * Build the snapshot. Never throws: a document must still be reviewable when a
 * read fails, it just resolves against less and proposes more "where does this
 * go?" rows — which is the honest degradation, not a broken upload.
 */
export async function buildEntityIndex(): Promise<EntityIndex> {
  const index = emptyEntityIndex();

  try {
    const profiles = await storage.getProfiles();
    index.profiles = (profiles || [])
      .filter((p: any) => p && p.id && !p.deletedAt)
      .map((p: any): IndexedProfile => ({
        id: p.id,
        type: String(p.type || ""),
        typeKey: p.type_key ? String(p.type_key) : undefined,
        name: String(p.name || ""),
        fields: thinFields(p.fields),
      }));
  } catch (e: any) {
    logger.warn(CAT, `profiles unavailable: ${e?.message || e}`);
  }

  try {
    const obligations = await storage.getObligations();
    index.obligations = (obligations || []).map((o: any) => ({
      id: o.id,
      name: String(o.name || ""),
      category: o.category ? String(o.category) : undefined,
      amount: typeof o.amount === "number" ? o.amount : undefined,
      frequency: o.frequency ? String(o.frequency) : undefined,
      linkedAssetId: o.linkedAssetId ?? null,
      linkedLiabilityId: o.linkedLiabilityId ?? null,
      linkedDocumentId: o.linkedDocumentId ?? null,
      linkedProfiles: Array.isArray(o.linkedProfiles) ? o.linkedProfiles : [],
      fields: o.fields && typeof o.fields === "object" ? o.fields : undefined,
    }));
  } catch (e: any) {
    logger.warn(CAT, `obligations unavailable: ${e?.message || e}`);
  }

  try {
    // Only recent expenses: the dedupe question is "did this document already
    // produce this charge", and a two-year-old row cannot be the answer.
    const expenses = await storage.getExpenses();
    const cutoff = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    index.expenses = (expenses || [])
      .filter((e: any) => !e?.date || String(e.date) >= cutoff)
      .map((e: any) => ({
        id: e.id,
        description: e.description ? String(e.description) : undefined,
        amount: typeof e.amount === "number" ? e.amount : undefined,
        date: e.date ? String(e.date) : undefined,
        linkedProfiles: Array.isArray(e.linkedProfiles) ? e.linkedProfiles : [],
      }));
  } catch (e: any) {
    logger.warn(CAT, `expenses unavailable: ${e?.message || e}`);
  }

  try {
    const trackers = await storage.getTrackers();
    index.trackers = (trackers || []).map((t: any) => ({
      id: t.id,
      name: String(t.name || ""),
      unit: t.unit ? String(t.unit) : undefined,
      category: t.category ? String(t.category) : undefined,
    }));
  } catch (e: any) {
    logger.warn(CAT, `trackers unavailable: ${e?.message || e}`);
  }

  // Links that already exist, so the planner does not propose one twice. Both
  // link tables are read through their own try — MemStorage returns [] for the
  // liability tables rather than implementing them, and a dev run must not
  // differ from production in whether the review pane renders.
  try {
    const liabilityLinks = await storage.getLiabilityAssetLinks();
    for (const l of liabilityLinks || []) {
      index.links.push({ from: (l as any).liabilityProfileId, to: (l as any).assetProfileId, type: "financed_by" });
    }
  } catch { /* optional */ }
  try {
    const partyLinks = await storage.getAssetPartyLinks();
    for (const l of partyLinks || []) {
      index.links.push({ from: (l as any).partyProfileId, to: (l as any).assetProfileId, type: "owns" });
    }
  } catch { /* optional */ }

  return index;
}
