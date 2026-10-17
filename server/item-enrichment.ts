// ─── Item Identity Layer: the server side ────────────────────────────────────
//
// The general form of server/nutrition-enrichment.ts. A chat turn that saved
// a record naming a specific item — a medication dose, a supplement, a pet's
// food, a vehicle or device profile, a subscription or account — carries a
// candidate the client posts back AFTER the reply renders. This module
// identifies the item (curated tables first, a bounded model call for the
// rest), keeps only the attributes identity materially changes for that kind
// (shared/item-identity ITEM_ATTRIBUTE_POLICY), and writes them onto the
// record with provenance — never over a value the user supplied.
//
// Three targets, one contract:
//   tracker entry → values gain the safe attributes; provenance on computed.item
//   profile       → fields gain the attributes; provenance on fields._itemEnrichment
//   obligation    → amount is filled only when missing; provenance on its fields
//
// Nothing here is needed to save the record, and every failure here is a
// reported outcome, never a 500 and never a change to what the agent saved.

import type { IStorage } from "./storage";
import type { Tracker } from "@shared/schema";
import {
  ITEM_ATTRIBUTE_POLICY,
  ITEM_ENRICHMENT_FIELD_KEY,
  attributeSpec,
  buildAttributePatch,
  classifyItemSpecificity,
  decideItemEnrichment,
  identifyMedication,
  inferItemKind,
  parseDoseText,
  itemAppliesAutomatically,
  medicationAttributes,
  overallItemConfidence,
  summarizeItemEnrichment,
  userProvidedAttributeKeys,
  type EnrichmentConfidence,
  type EnrichmentMode,
  type ItemContext,
  type ItemEnrichment,
  type ItemIdentity,
  type ItemKind,
  type ItemSpecificity,
  type ProvenancedAttribute,
} from "@shared/item-identity";
import { isNutritionTrackerLike } from "@shared/nutrition-enrichment";
import { lookupNutritionDb } from "@shared/nutrition-db";
import { itemTextOf, planEnrichmentCandidate, readEnrichmentMode, type NutritionEnrichmentCandidate } from "./nutrition-enrichment";
export { readEnrichmentMode };
import { getAnthropicClient } from "./anthropic-client";
import { logger } from "./logger";

// ─── Candidates ──────────────────────────────────────────────────────────────

export type EnrichmentTarget = "trackerEntry" | "profile" | "obligation";

/** What a chat turn attaches to a saved record for the client to post back. */
export interface ItemEnrichmentCandidate {
  target: EnrichmentTarget;
  id: string;
  trackerId?: string;
  trackerName?: string;
  kind: ItemKind;
  item: string;
  specificity: ItemSpecificity;
  message?: string;
}

/** The text a profile names its item with: the name plus the identifying fields. */
export function profileItemText(profile: { name?: string | null; fields?: Record<string, any> | null; type?: string | null }): string {
  const f = profile.fields || {};
  const parts = [f.year, f.make, f.model, f.trim, f.brand, f.plan, f.planTier].filter((v) => v != null && String(v).trim() !== "").map(String);
  const name = String(profile.name || "").trim();
  const extra = parts.filter((p) => !name.toLowerCase().includes(p.toLowerCase()));
  return [name, ...extra].join(" ").trim();
}

/** Plan a candidate for a saved tracker entry — nutrition keeps its own planner. */
export function planTrackerEntryCandidate(
  entry: { id: string; values?: Record<string, any> | null } | null | undefined,
  tracker: { id: string; name: string; category?: string | null } | null | undefined,
  userMessage: string | null | undefined,
): ItemEnrichmentCandidate | NutritionEnrichmentCandidate | null {
  if (!entry || !tracker) return null;
  if (isNutritionTrackerLike(tracker)) return planEnrichmentCandidate(entry, tracker, userMessage);
  const message = String(userMessage || "").trim().slice(0, 600);
  const v = entry.values || {};
  const item = String(v.drug || v.drugName || v.medication || v.supplement || v.name || v.item || v.product || v.food || "").trim() || tracker.name;
  const ctx: ItemContext = { trackerName: tracker.name, trackerCategory: tracker.category };
  const kind = inferItemKind(`${item} ${message}`, ctx);
  if (kind === "food" || kind === "beverage" || kind === "other") return null;
  const specificity = classifyItemSpecificity(`${item} ${message}`.trim(), kind);
  if (!decideItemEnrichment("auto", kind, specificity).attempt) return null;
  return { target: "trackerEntry", id: entry.id, trackerId: tracker.id, trackerName: tracker.name, kind, item, specificity, message: message || undefined };
}

export function planProfileCandidate(
  profile: { id: string; name: string; type?: string | null; fields?: Record<string, any> | null } | null | undefined,
  userMessage: string | null | undefined,
): ItemEnrichmentCandidate | null {
  if (!profile) return null;
  const type = String(profile.type || "");
  if (!["vehicle", "asset", "account", "subscription", "pet"].includes(type)) return null;
  const item = profileItemText(profile);
  const message = String(userMessage || "").trim().slice(0, 600);
  const kind = inferItemKind(`${item} ${message}`, { profileType: type });
  if (type === "pet") return null; // a pet is a person, not a product; its food is logged on a tracker
  if (kind === "food" || kind === "beverage" || kind === "other") return null;
  const specificity = classifyItemSpecificity(item, kind);
  if (!decideItemEnrichment("auto", kind, specificity).attempt) return null;
  return { target: "profile", id: profile.id, kind, item, specificity, message: message || undefined };
}

export function planObligationCandidate(
  ob: { id: string; name: string; category?: string | null; amount?: number | null } | null | undefined,
  userMessage: string | null | undefined,
): ItemEnrichmentCandidate | null {
  if (!ob) return null;
  const message = String(userMessage || "").trim().slice(0, 600);
  const kind = inferItemKind(`${ob.name} ${message}`, { obligationCategory: ob.category });
  if (kind !== "subscription") return null;
  const specificity = classifyItemSpecificity(ob.name, kind);
  if (!decideItemEnrichment("auto", kind, specificity).attempt) return null;
  return { target: "obligation", id: ob.id, kind, item: ob.name, specificity, message: message || undefined };
}

// ─── Providers (injectable) ──────────────────────────────────────────────────

export interface ModelIdentification {
  identity: ItemIdentity;
  attributes: Array<{ key: string; value: string | number | boolean | string[]; confidence: EnrichmentConfidence | string; basis?: string }>;
}

export interface ItemEnrichmentDeps {
  /** Model knowledge of a product, filtered by the kind's attribute policy. Null when it declines. */
  modelIdentify?: (input: { kind: ItemKind; item: string; message: string; allowed: Array<{ key: string; label: string; unit?: string; type: string }>; known: Record<string, any> }) => Promise<ModelIdentification | null>;
  now?: () => string;
}

const MODEL_IDENTIFY_SYSTEM = `You identify a specific product a person named and report its factual attributes as JSON.
Rules:
- Return ONLY a JSON object: {"identity":{"name":string,"brand":string|null,"model":string|null,"variant":string|null,"family":string|null},"attributes":[{"key":string,"value":string|number|boolean|string[],"confidence":"exact"|"high"|"medium"|"low","basis":string}]}
- Use ONLY the attribute keys you are given, with the units given (numbers as plain numbers in that unit). Omit any attribute you do not know for THIS exact product/configuration. Never invent a value to fill a key.
- "exact": the manufacturer's published figure for this exact configuration and you are certain. "high": published figure, minor configuration uncertainty. "medium": typical for the model line, configuration unknown. "low": a guess — prefer omitting.
- Prices and plan fees change: report them at most "medium" and name the period you know in "basis".
- Medication strengths: never guess when several strengths exist; omit strengthMg and set strengthAmbiguous true.
- Do not restate values the person already provided (listed as known); do not contradict them.`;

export async function modelIdentifyItem(
  input: { kind: ItemKind; item: string; message: string; allowed: Array<{ key: string; label: string; unit?: string; type: string }>; known: Record<string, any> },
  timeoutMs = 9000,
): Promise<ModelIdentification | null> {
  if (process.env.NUTRITION_LOOKUP_DISABLE === "1" || process.env.ITEM_LOOKUP_DISABLE === "1") return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = getAnthropicClient("standard");
  const model = process.env.ITEM_IDENTIFY_MODEL || process.env.NUTRITION_ESTIMATE_MODEL || "claude-haiku-4-5-20251001";
  const user = `Kind: ${input.kind}\nItem as named: ${JSON.stringify(input.item)}\nPerson's message (context only): ${JSON.stringify(input.message || "")}\nKnown (already provided, do not repeat): ${JSON.stringify(input.known)}\nAllowed attributes: ${JSON.stringify(input.allowed)}`;
  try {
    const resp = await client.messages.create(
      { model, max_tokens: 900, system: MODEL_IDENTIFY_SYSTEM, messages: [{ role: "user", content: user }] },
      { timeout: timeoutMs, maxRetries: 0 },
    );
    const text = resp.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!parsed || typeof parsed !== "object" || !parsed.identity) return null;
    return {
      identity: {
        name: String(parsed.identity.name || input.item),
        brand: parsed.identity.brand ? String(parsed.identity.brand) : undefined,
        model: parsed.identity.model ? String(parsed.identity.model) : undefined,
        variant: parsed.identity.variant ? String(parsed.identity.variant) : undefined,
        family: parsed.identity.family ? String(parsed.identity.family) : undefined,
      },
      attributes: Array.isArray(parsed.attributes) ? parsed.attributes.filter((a: any) => a && typeof a.key === "string" && a.value !== undefined && a.value !== null) : [],
    };
  } catch (e: any) {
    logger.warn("item-enrichment", `model identification unavailable: ${e?.message || e}`);
    return null;
  }
}

const defaultDeps = (): ItemEnrichmentDeps => ({ modelIdentify: (i) => modelIdentifyItem(i), now: () => new Date().toISOString() });

// ─── Identification ladder ───────────────────────────────────────────────────

const CONF_RANK = { exact: 4, high: 3, medium: 2, low: 1 } as const;
function clampConfidence(raw: string, ceiling: EnrichmentConfidence): EnrichmentConfidence {
  const c = (["exact", "high", "medium", "low"].includes(raw) ? raw : "medium") as EnrichmentConfidence;
  return CONF_RANK[c] > CONF_RANK[ceiling] ? ceiling : c;
}

function attributesFromModel(kind: ItemKind, m: ModelIdentification, now: string, known: Record<string, any>): Record<string, ProvenancedAttribute> {
  const out: Record<string, ProvenancedAttribute> = {};
  for (const a of m.attributes) {
    const spec = attributeSpec(kind, a.key);
    if (!spec) continue;
    if (known[a.key] != null && String(known[a.key]).trim() !== "") continue;
    let value: ProvenancedAttribute["value"] = a.value;
    if (spec.type === "number") { const n = typeof value === "number" ? value : parseFloat(String(value)); if (!isFinite(n)) continue; value = n; }
    if (spec.type === "boolean") value = value === true || String(value).toLowerCase() === "true";
    if (spec.type === "list") value = Array.isArray(value) ? value.map(String) : String(value).split(/,\s*/);
    if (spec.type === "text") value = String(value);
    // Model knowledge is never "exact" for a price/fee; specs it is certain of may be.
    const ceiling: EnrichmentConfidence = spec.effect === "price" || spec.effect === "recurring_cost" ? "medium" : "exact";
    const confidence = clampConfidence(String(a.confidence || "medium"), ceiling);
    if (confidence === "low") continue;
    out[a.key] = {
      value, unit: spec.unit, label: spec.label,
      source: `model knowledge: ${m.identity.name}${a.basis ? ` (${a.basis})` : ""}`,
      sourceType: "model_estimate", confidence, calculatedOrDirect: "direct", effect: spec.effect, enrichedAt: now,
    };
  }
  return out;
}

/** Supplement rows of the internal nutrition reference carry serving + omega-3 data. */
function supplementAttributes(item: string, message: string, now: string): { identity: ItemIdentity; attrs: Record<string, ProvenancedAttribute> } | null {
  const m = lookupNutritionDb(`${item} ${message}`) || lookupNutritionDb(item);
  if (!m || m.item.kind !== "supplement") return null;
  const attrs: Record<string, ProvenancedAttribute> = {};
  const put = (key: string, value: ProvenancedAttribute["value"], conf: EnrichmentConfidence, calc: "direct" | "calculated" = "direct") => {
    const spec = attributeSpec("supplement", key);
    if (!spec) return;
    attrs[key] = { value, unit: spec.unit, label: spec.label, source: m.item.source, sourceType: m.item.sourceType, confidence: conf, calculatedOrDirect: calc, effect: spec.effect, enrichedAt: now };
  };
  put("servingSize", m.item.serving.label, m.item.confidence);
  if (m.item.perServing.omega3 != null) put("omega3Mg", m.item.perServing.omega3, m.item.confidence);
  if (m.item.perServing.epa != null) put("epaMg", m.item.perServing.epa, m.item.confidence);
  if (m.item.perServing.dha != null) put("dhaMg", m.item.perServing.dha, m.item.confidence);
  const parsed = parseDoseText(`${item} ${message}`);
  const n = parsed.count ?? NaN;
  if (isFinite(n)) {
    put("unitCount", n, "exact");
    if (m.item.perServing.omega3 != null) put("omega3Mg", Math.round((m.item.perServing.omega3 / m.item.serving.amount) * n), m.item.confidence, "calculated");
  }
  return { identity: { name: m.item.name, brand: m.item.brand }, attrs };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export interface ItemEnrichOptions {
  target: EnrichmentTarget;
  id: string;
  trackerId?: string;
  message?: string;
  mode?: EnrichmentMode;
  intent?: "auto" | "preview" | "force" | "reject";
  deps?: ItemEnrichmentDeps;
}

export interface ItemEnrichOutcome {
  status: ItemEnrichment["status"];
  reason?: string;
  enrichment?: ItemEnrichment;
  record?: any;
  target: EnrichmentTarget;
  id: string;
  ms: number;
}

interface LoadedRecord {
  text: string;
  known: Record<string, any>;
  ctx: ItemContext;
  existing: ItemEnrichment | undefined;
  write: (attrs: Record<string, ProvenancedAttribute>, enrichment: ItemEnrichment, apply: boolean) => Promise<{ record: any; applied: string[] }>;
}

async function loadRecord(storage: IStorage, opts: ItemEnrichOptions): Promise<LoadedRecord | null> {
  if (opts.target === "trackerEntry") {
    const entry: any = await storage.getTrackerEntry(opts.id);
    if (!entry) return null;
    const trackerId = opts.trackerId || entry.trackerId;
    let tracker: Tracker | undefined = trackerId ? await storage.getTracker(trackerId) : undefined;
    if (!tracker) tracker = (await storage.getTrackers()).find((t) => (t.entries || []).some((e: any) => e?.id === entry.id));
    if (!tracker) return null;
    const v = entry.values || {};
    const text = String(v.drug || v.drugName || v.medication || v.supplement || v.name || v.item || v.product || itemTextOf(v) || "").trim() || tracker.name;
    return {
      text,
      known: v,
      ctx: { trackerName: tracker.name, trackerCategory: tracker.category },
      existing: entry.computed?.item,
      write: async (attrs, enrichment, apply) => {
        const applied: string[] = [];
        const patch: Record<string, any> = {};
        if (apply) {
          // Only values that cannot mislead on a dose tracker: identity text
          // and a computed total. The tracker's own `dosage` is the user's.
          for (const [k, a] of Object.entries(attrs)) {
            if (["activeIngredient", "totalDoseMg", "unitCount", "omega3Mg", "epaMg", "dhaMg", "kcalPerCup"].includes(k) && (v[k] == null || v[k] === "")) { patch[k] = a.value; applied.push(k); }
          }
        }
        const t = tracker!;
        const computedPatch: Record<string, any> = { item: { ...enrichment, applied } };
        const record = await storage.updateTrackerEntry(t.id, entry.id, { ...(Object.keys(patch).length ? { values: patch } : {}), computed: computedPatch } as any);
        return { record, applied };
      },
    };
  }
  if (opts.target === "profile") {
    const profile: any = await storage.getProfile(opts.id);
    if (!profile) return null;
    return {
      text: profileItemText(profile),
      known: profile.fields || {},
      ctx: { profileType: profile.type },
      existing: profile.fields?.[ITEM_ENRICHMENT_FIELD_KEY],
      write: async (attrs, enrichment, apply) => {
        const kind = enrichment.kind;
        const patch = apply ? buildAttributePatch(kind, attrs, enrichment.userProvided, "high") : {};
        const applied = Object.keys(patch);
        const record = await storage.updateProfile(profile.id, { fields: { ...patch, [ITEM_ENRICHMENT_FIELD_KEY]: { ...enrichment, applied } } } as any);
        return { record, applied };
      },
    };
  }
  const ob: any = await storage.getObligation(opts.id);
  if (!ob) return null;
  return {
    text: ob.name,
    known: { ...(ob.fields || {}), price: ob.amount > 0 ? ob.amount : undefined, billingFrequency: ob.frequency },
    ctx: { obligationCategory: ob.category },
    existing: ob.fields?.[ITEM_ENRICHMENT_FIELD_KEY],
    write: async (attrs, enrichment, apply) => {
      const applied: string[] = [];
      const patch: Record<string, any> = {};
      if (apply) {
        for (const k of ["planTier", "annualCost", "planFeatures"]) {
          if (attrs[k] && (ob.fields?.[k] == null)) { patch[k] = attrs[k].value; applied.push(k); }
        }
      }
      const provenance = { ...enrichment, applied };
      // A price is filled only into an obligation that has none — an estimate
      // never replaces a figure the user gave, and it is flagged as estimated.
      let record: any = ob;
      if (apply && attrs.price && !(ob.amount > 0) && typeof attrs.price.value === "number") {
        record = (await storage.updateObligation(ob.id, { amount: attrs.price.value } as any)) || ob;
        patch.amountEstimated = true;
        applied.push("price");
      }
      // In the Supabase store an obligation IS a liability profile; its fields
      // merge through updateProfile. The in-memory store keeps a plain object.
      const asProfile = await storage.getProfile(ob.id).catch(() => undefined);
      if (asProfile) {
        await storage.updateProfile(ob.id, { fields: { ...patch, [ITEM_ENRICHMENT_FIELD_KEY]: provenance } } as any);
      } else {
        record = (await storage.updateObligation(ob.id, { fields: { ...(ob.fields || {}), ...patch, [ITEM_ENRICHMENT_FIELD_KEY]: provenance } } as any)) || record;
      }
      return { record: (await storage.getObligation(ob.id)) || record, applied };
    },
  };
}

/**
 * Identify the item behind one saved record and write the attributes identity
 * changes for its kind. Idempotent: an applied enrichment is returned as-is
 * unless the intent is force/reject. Never throws for a lookup failure.
 */
export async function enrichItem(storage: IStorage, opts: ItemEnrichOptions): Promise<ItemEnrichOutcome> {
  const started = Date.now();
  const deps = { ...defaultDeps(), ...(opts.deps || {}) };
  const now = deps.now!();
  const done = (o: Omit<ItemEnrichOutcome, "ms" | "target" | "id">): ItemEnrichOutcome => ({ ...o, target: opts.target, id: opts.id, ms: Date.now() - started });

  let loaded: LoadedRecord | null;
  try { loaded = await loadRecord(storage, opts); } catch (e: any) { return done({ status: "failed", reason: `could not read the record: ${e?.message || e}` }); }
  if (!loaded) return done({ status: "failed", reason: "record not found" });

  const mode: EnrichmentMode = opts.mode ?? await readEnrichmentMode(storage);
  const intent = opts.intent ?? "auto";
  const existing = loaded.existing;
  if (mode === "off" && intent === "auto") return done({ status: "skipped", reason: "Enhanced Item Lookup is off" });

  if (existing && (intent === "force" || intent === "reject")) {
    if (intent === "reject") {
      const skipped: ItemEnrichment = { ...existing, status: "skipped", reason: "user kept the record as saved", enrichedAt: now };
      try {
        const { record } = await loaded.write(existing.attributes, skipped, false);
        return done({ status: "skipped", reason: skipped.reason, enrichment: skipped, record });
      } catch (e: any) { return done({ status: "failed", reason: `could not write: ${e?.message || e}`, enrichment: existing }); }
    }
    try {
      const { record, applied } = await loaded.write(existing.attributes, { ...existing, status: "applied", reason: undefined, enrichedAt: now }, true);
      return done({ status: "applied", enrichment: { ...existing, status: "applied", applied, reason: undefined, enrichedAt: now }, record });
    } catch (e: any) { return done({ status: "failed", reason: `could not write: ${e?.message || e}`, enrichment: existing }); }
  }
  if (existing?.status === "applied" && intent === "auto") return done({ status: "applied", enrichment: existing, reason: "already enriched" });

  const message = String(opts.message || "").trim();
  const text = loaded.text || message;
  const kind = inferItemKind(`${text} ${message}`, loaded.ctx);
  const specificity = classifyItemSpecificity(`${text} ${message}`.trim(), kind);
  const decision = decideItemEnrichment(mode === "off" ? "auto" : mode, kind, specificity);
  if (!decision.attempt) return done({ status: "skipped", reason: decision.reason });

  const userProvided = userProvidedAttributeKeys(kind, loaded.known);
  let identity: ItemIdentity = { name: text };
  let attrs: Record<string, ProvenancedAttribute> = {};
  let viaModel = false;

  try {
    if (kind === "medication") {
      const med = identifyMedication(`${text} ${message}`);
      if (med) {
        identity = { name: med.product.brand, brand: med.product.brand, family: med.genericName, variant: med.variantNote ? med.variantNote.split(" is ")[0] : undefined };
        attrs = medicationAttributes(med, now);
      }
    } else if (kind === "supplement") {
      const sup = supplementAttributes(text, message, now);
      if (sup) { identity = sup.identity; attrs = sup.attrs; }
    }
    if (Object.keys(attrs).length === 0 && deps.modelIdentify && specificity.level !== "category") {
      const allowed = ITEM_ATTRIBUTE_POLICY[kind].map((a) => ({ key: a.key, label: a.label, unit: a.unit, type: a.type }));
      const known: Record<string, any> = {};
      for (const k of userProvided) known[k] = loaded.known[k];
      const m = await deps.modelIdentify({ kind, item: text, message, allowed, known });
      if (m) { viaModel = true; identity = { ...m.identity, name: m.identity.name || text }; attrs = attributesFromModel(kind, m, now, known); }
    }
  } catch (e: any) {
    logger.warn("item-enrichment", `identification failed for ${opts.target}/${opts.id}: ${e?.message || e}`);
    return done({ status: "failed", reason: "identification failed" });
  }
  for (const k of userProvided) delete attrs[k];
  if (Object.keys(attrs).length === 0) return done({ status: "skipped", reason: `nothing identified for "${text.slice(0, 80)}"` });

  const confidence = overallItemConfidence(attrs);
  // What decides the write is the attributes that CLEAR the floor, not the
  // weakest one: a medium oil-change interval rides along display-only while
  // the exact MPG figures are written. Ask mode still waits unless everything
  // is exact.
  const writable = Object.values(attrs).some((a) => itemAppliesAutomatically("auto", a.confidence));
  const autoApplies = mode === "ask" ? itemAppliesAutomatically("ask", confidence) : (mode !== "off" && writable);
  const enrichment: ItemEnrichment = {
    version: 1, kind, status: "proposed", mode, specificity, sourceText: text, identity, attributes: attrs,
    userProvided, applied: [], confidence, summary: summarizeItemEnrichment({ identity, attributes: attrs }), enrichedAt: now,
  };
  const shouldApply = intent === "force" || (intent === "auto" && autoApplies);
  try {
    if (!shouldApply) {
      enrichment.reason = intent === "preview" ? "preview" : mode === "ask" ? "waiting for the user" : `confidence ${confidence} — stored, not written onto the record`;
      const { record } = await loaded.write(attrs, enrichment, false);
      return done({ status: "proposed", reason: enrichment.reason, enrichment, record });
    }
    const { record, applied } = await loaded.write(attrs, { ...enrichment, status: "applied" }, true);
    const final = { ...enrichment, status: "applied" as const, applied };
    logger.info("item-enrichment", `${opts.target}/${opts.id.slice(0, 8)} ${kind}: ${final.summary} [${confidence}${viaModel ? ", model" : ", table"}] in ${Date.now() - started}ms`);
    return done({ status: "applied", enrichment: final, record });
  } catch (e: any) {
    logger.warn("item-enrichment", `write refused for ${opts.target}/${opts.id}: ${e?.message || e}`);
    return done({ status: "failed", reason: `could not write the attributes: ${String(e?.message || e).slice(0, 160)}`, enrichment });
  }
}
