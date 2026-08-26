// ── Overview engine (2026-08-26) ─────────────────────────────────────────────
// Assembles the canonical context an Asset / Liability Overview is composed
// from, optionally asks the model to reason about SHAPE, and returns the
// composed OverviewSpec.
//
// Division of labour, deliberately:
//
//   this file      gathers canonical data (profile, links, owners, docs,
//                  obligations, expense rollups) — the only place that reads
//   the model      answers "what kind of thing is this and what matters about
//                  it?" and returns HINTS (labels, importance, grouping,
//                  missing-info suggestions) — never values, never markup
//   compose        holds the pen: resolves every displayed value from the
//                  canonical data on every single request
//
// So the AI's answer is cached by the entity's STRUCTURAL SIGNATURE (type +
// field keys + relationship kinds), and the values are not cached at all. Edit
// a balance and the next Overview shows the new balance with the same layout;
// add a field or link a mortgage and the layout itself is re-reasoned.

import type { IStorage } from "./storage";
import { getAnthropicClient } from "./anthropic-client";
import { selectModel, callModel } from "./model-router";
import { logger } from "./logger";
import {
  composeOverview,
  type ComposeDocument,
  type ComposeInput,
  type ComposeObligation,
  type ComposeOwner,
  type ComposeRelated,
  type RelationKind,
} from "@shared/overview-compose";
import { classifyOverviewEntity } from "@shared/overview-semantics";
import {
  normalizeSchemaHints,
  overviewSignature,
  type OverviewSchemaHints,
  type OverviewSpec,
} from "@shared/overview-spec";
import { isAssetTabProfile, isLiabilityTabProfile, parseMoney } from "@shared/asset-value";

const SCHEMA_CACHE_PREFIX = "overview_schema_";
/** A composition is re-reasoned when the entity's shape changes; this ceiling
 *  just keeps a very old answer from outliving improvements to the prompt. */
const SCHEMA_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface CachedSchema {
  signature: string;
  hints: OverviewSchemaHints;
  generatedAt: string;
}

/** Insurance / warranty-ish links read as coverage; a loan against the thing
 *  reads as financing. Everything else is a plain link. */
function relationFor(related: { type?: string | null; type_key?: string | null; role?: string | null }): RelationKind {
  const key = `${related.type_key || ""} ${related.type || ""} ${related.role || ""}`.toLowerCase();
  if (/insur|policy/.test(key)) return "insurance";
  if (/warrant|protection plan|service plan/.test(key)) return "warranty";
  if (/mortgage|loan|lease|credit|heloc|note|financ/.test(key)) return "financing";
  return "linked";
}

/** Monthly average spend over the window the expenses actually span, so a
 *  single 3-year-old repair doesn't read as a monthly cost. */
function monthlyAverage(expenses: Array<{ amount?: any; date?: string | null }>): number | null {
  const rows = expenses
    .map(e => ({ amount: parseMoney(e.amount), time: e.date ? new Date(e.date).getTime() : NaN }))
    .filter(r => Number.isFinite(r.amount) && Number.isFinite(r.time));
  if (rows.length < 2) return null;
  const times = rows.map(r => r.time);
  const spanMonths = Math.max(1, (Math.max(...times) - Math.min(...times)) / (30.44 * 86_400_000));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return total / spanMonths;
}

/**
 * Read every canonical source that could inform this entity's Overview.
 * Returns null when the profile doesn't exist. Link lookups are best-effort:
 * a storage backend that doesn't implement one (the in-memory dev store
 * returns []) degrades the Overview, it never fails it.
 */
export async function buildOverviewInput(
  storage: IStorage,
  profileId: string,
  now: Date = new Date(),
): Promise<ComposeInput | null> {
  const detail = await storage.getProfileDetail(profileId);
  if (!detail) return null;

  const isLiability = isLiabilityTabProfile(detail as any);
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p; } catch { return fallback; }
  };

  // ── Linked assets / liabilities across the junction tables ────────────────
  const [assetLinks, liabilityLinks, assetParties, liabilityParties] = await Promise.all([
    safe(storage.getLiabilityAssetLinksForAsset(profileId), [] as any[]),
    safe(storage.getLiabilityAssetLinks(profileId), [] as any[]),
    safe(storage.getAssetPartyLinks(profileId), [] as any[]),
    safe(storage.getLiabilityProfileLinks(profileId), [] as any[]),
  ]);

  const counterpartIds = new Set<string>();
  for (const l of assetLinks) counterpartIds.add(l.liabilityProfileId);
  for (const l of liabilityLinks) counterpartIds.add(l.assetProfileId);
  const partyIds = new Set<string>([
    ...assetParties.map((p: any) => p.partyProfileId),
    ...liabilityParties.map((p: any) => p.profileId || p.partyProfileId),
  ].filter(Boolean));

  const neededIds = [...new Set([...counterpartIds, ...partyIds])];
  const linkedProfiles = new Map<string, any>();
  await Promise.all(neededIds.map(async id => {
    const p = await safe(storage.getProfile(id), undefined as any);
    if (p) linkedProfiles.set(id, p);
  }));

  const related: ComposeRelated[] = [];
  for (const id of counterpartIds) {
    const p = linkedProfiles.get(id);
    if (!p) continue;
    // From an asset, a linked liability is (usually) its financing. From a
    // liability, the linked asset is what it is secured by.
    const relation: RelationKind = isLiability
      ? "containedBy"
      : relationFor(p) === "linked" && isLiabilityTabProfile(p) ? "financing" : relationFor(p);
    related.push({ id: p.id, name: p.name, kind: p.type_key || p.type, relation, fields: p.fields });
  }

  // Nested profiles: a child liability (a service plan under a TV) is
  // financing/coverage; a child asset is contained.
  for (const child of detail.childProfiles || []) {
    const relation: RelationKind = isLiabilityTabProfile(child as any)
      ? (relationFor(child as any) === "linked" ? "financing" : relationFor(child as any))
      : "contains";
    if (related.some(r => r.id === child.id)) continue;
    related.push({ id: child.id, name: child.name, kind: (child as any).type_key || child.type, relation, fields: child.fields });
  }

  const owners: ComposeOwner[] = [
    ...assetParties
      .filter((p: any) => (p.role || "owner") === "owner")
      .map((p: any) => ({
        profileId: p.partyProfileId,
        name: linkedProfiles.get(p.partyProfileId)?.name || "Owner",
        percentage: Number(p.ownershipPercentage) || 0,
      })),
    ...liabilityParties
      .filter((p: any) => (p.role || "owner") === "owner" || (p.role || "") === "borrower")
      .map((p: any) => ({
        profileId: p.profileId || p.partyProfileId,
        name: linkedProfiles.get(p.profileId || p.partyProfileId)?.name || "Owner",
        percentage: Number(p.ownershipPercentage) || 0,
      })),
  ].filter(o => o.percentage > 0);

  const documents: ComposeDocument[] = (detail.relatedDocuments || []).map(d => ({
    id: d.id, name: d.name, type: d.type, createdAt: d.createdAt,
  }));

  const obligations: ComposeObligation[] = (detail.relatedObligations || []).map(o => ({
    id: o.id, name: o.name, amount: o.amount, frequency: o.frequency,
    nextDueDate: o.nextDueDate, autopay: (o as any).autopay,
  }));

  const expenseRows = detail.relatedExpenses || [];
  const expenses = expenseRows.length
    ? {
        count: (detail as any).relatedExpensesTotal ?? expenseRows.length,
        total: (detail as any).relatedExpensesSum ?? expenseRows.reduce((s, e) => s + parseMoney(e.amount), 0),
        monthlyAverage: monthlyAverage(expenseRows as any),
      }
    : undefined;

  // Service state, read from whatever the entity actually records: explicit
  // fields first, then the most recent maintenance-shaped timeline entry.
  const f: Record<string, any> = detail.fields || {};
  const maintenanceEvent = (detail.timeline || [])
    .filter(t => /service|maintenance|repair|oil change|inspection/i.test(t.title || ""))
    .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))[0];
  const maintenance = (f.lastServiceDate || f.nextServiceDate || maintenanceEvent)
    ? {
        lastServiceDate: f.lastServiceDate || maintenanceEvent?.timestamp?.slice(0, 10) || null,
        nextServiceDate: f.nextServiceDate || f.nextServiceDue || null,
        openItems: (detail.relatedTasks || []).filter(t =>
          /service|maintenance|repair/i.test(t.title || "") && t.status !== "done").length,
      }
    : null;

  return {
    entity: {
      id: detail.id,
      name: detail.name,
      type: detail.type,
      type_key: (detail as any).type_key,
      tags: detail.tags,
      fields: detail.fields,
      notes: detail.notes,
      updatedAt: detail.updatedAt,
    },
    owners,
    related,
    documents,
    obligations,
    expenses,
    maintenance,
    timeline: (detail.timeline || []).slice(0, 6).map(t => ({
      title: t.title, timestamp: t.timestamp, type: t.type,
    })),
    now,
  };
}

/** True when this profile is one the dynamic Overview is meant to drive. */
export function isOverviewEntity(profile: { type?: string | null; type_key?: string | null; fields?: any }): boolean {
  return isAssetTabProfile(profile as any) || isLiabilityTabProfile(profile as any);
}

// ── The model pass ───────────────────────────────────────────────────────────

const SCHEMA_SYSTEM_PROMPT = `You are the schema engine for Portol's entity Overview.

You are given ONE entity: what the app thinks it is, the field KEYS it stores
(with short value shapes, never full values), what it is linked to, and what
kind of records hang off it. Decide what a person opening this profile would
reasonably expect to see FIRST.

You return a JSON object describing PRESENTATION SHAPE ONLY. You never return
values, prose, HTML, or component code. The renderer supplies all of that.

Rules:
- Reason from what this entity IS. Do not apply a template from another kind of
  entity, and do not assume a field exists because similar things usually have
  it.
- importance: "primary" (essential to understanding this entity at a glance),
  "secondary" (useful context), "detailed" (belongs in a deeper tab),
  "administrative" (internal bookkeeping — keep it off the Overview).
- group: a short human title for the card a field belongs in ("Location",
  "Financial", "Coverage", "Identity", "Characteristics", "Dates", "Usage").
  Reuse titles across fields that belong together.
- summaryMetricKeys: at most 4 field keys that deserve top-of-page prominence.
  Only keys present in the entity's field list.
- missingInformation: at most 3 fields this SPECIFIC entity would be materially
  more useful with. Never suggest a field it already has. Never suggest a long
  list of theoretically possible fields. Give a one-line reason each.
- insights: at most 2 short observations that are true given the shape of the
  data you were shown. If nothing is genuinely notable, return an empty array.
  Never state a number you were not given.

Return ONLY valid JSON, no markdown fences, matching:
{
  "entityLabel": "short human label for what this is",
  "semanticCategory": "snake_case family, e.g. real_estate, vehicle, marine_vessel, intellectual_property",
  "subtype": "optional finer label",
  "fieldHints": { "<fieldKey>": { "label": "...", "importance": "...", "group": "...", "displayType": "...", "dateMeaning": "..." } },
  "summaryMetricKeys": ["<fieldKey>"],
  "sectionOrder": ["Group title", "..."],
  "missingInformation": [{ "semanticKey": "camelCaseKey", "label": "...", "reason": "...", "importance": "..." }],
  "insights": [{ "title": "...", "detail": "...", "confidence": 0.0 }]
}`;

/** Describe a value without disclosing it: the model reasons about shape, and
 *  a summary built from shapes cannot leak a balance into a cache key. */
function describeShape(v: unknown): string {
  if (v == null) return "empty";
  if (Array.isArray(v)) return `list[${v.length}]`;
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "object") return "object";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return "date";
  if (/^\$?[\d,]+(\.\d+)?$/.test(s)) return "number";
  if (/^https?:\/\//.test(s)) return "url";
  return s.length > 60 ? "long text" : "text";
}

function buildSchemaPrompt(input: ComposeInput): string {
  const e = input.entity;
  const classification = classifyOverviewEntity({
    type: e.type, type_key: e.type_key, name: e.name, tags: e.tags, fields: e.fields,
  });
  const fieldShapes = Object.entries(e.fields || {})
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `  ${k}: ${describeShape(v)}`)
    .join("\n");
  const relations = (input.related || [])
    .map(r => `  ${r.relation}: ${r.kind}`)
    .join("\n") || "  (none)";
  return [
    `Entity name: ${e.name}`,
    `App type: ${e.type}${e.type_key ? ` / ${e.type_key}` : ""}`,
    `Class: ${classification.entityClass}`,
    `Tags: ${(e.tags || []).join(", ") || "(none)"}`,
    ``,
    `Stored fields (key: value shape):`,
    fieldShapes || "  (none)",
    ``,
    `Linked records:`,
    relations,
    ``,
    `Attached: ${(input.documents || []).length} document(s), ` +
      `${(input.obligations || []).length} recurring obligation(s), ` +
      `${input.expenses?.count || 0} expense(s)`,
  ].join("\n");
}

/**
 * The cached shape answer for this entity, re-reasoned only when the entity's
 * structural signature changes. Returns null when no model is configured or
 * the call fails — the Overview composes fine without it.
 */
export async function getSchemaHints(
  storage: IStorage,
  profileId: string,
  input: ComposeInput,
  opts: { refresh?: boolean; allowModel?: boolean } = {},
): Promise<OverviewSchemaHints | null> {
  const signature = overviewSignature({
    type: input.entity.type,
    typeKey: input.entity.type_key,
    fieldKeys: Object.keys(input.entity.fields || {}),
    relationKinds: (input.related || []).map(r => r.relation),
    hasDocuments: (input.documents || []).length > 0,
  });
  const cacheKey = `${SCHEMA_CACHE_PREFIX}${profileId}`;

  if (!opts.refresh) {
    try {
      const raw = await storage.getPreference(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw) as CachedSchema;
        const age = Date.now() - new Date(cached.generatedAt).getTime();
        // Signature mismatch = the entity's SHAPE changed. The layout is stale
        // even though the numbers are always fresh, so re-reason it.
        if (cached.signature === signature && age < SCHEMA_MAX_AGE_MS) {
          return normalizeSchemaHints(cached.hints, Object.keys(input.entity.fields || {}));
        }
      }
    } catch (err: any) {
      logger.warn("overview", `schema cache read failed: ${err?.message || err}`);
    }
  }

  if (opts.allowModel === false || !process.env.ANTHROPIC_API_KEY) return null;

  try {
    const spec = selectModel("fast");
    const text = await callModel({
      spec,
      system: SCHEMA_SYSTEM_PROMPT,
      user: buildSchemaPrompt(input),
      maxTokens: 1200,
      anthropicClient: spec.provider === "anthropic" ? getAnthropicClient("standard") : undefined,
    });
    let jsonStr = text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const hints = normalizeSchemaHints(JSON.parse(jsonStr), Object.keys(input.entity.fields || {}));
    const payload: CachedSchema = { signature, hints, generatedAt: new Date().toISOString() };
    await storage.setPreference(cacheKey, JSON.stringify(payload)).catch(() => {});
    return hints;
  } catch (err: any) {
    logger.warn("overview", `schema generation failed for ${profileId}: ${err?.message || err}`);
    return null;
  }
}

/**
 * The whole pipeline. `allowModel: false` gives a purely deterministic
 * Overview — used by tests and by any caller that must not spend a model call.
 */
export async function buildOverviewSpec(
  storage: IStorage,
  profileId: string,
  opts: { refresh?: boolean; allowModel?: boolean; now?: Date } = {},
): Promise<OverviewSpec | null> {
  const input = await buildOverviewInput(storage, profileId, opts.now);
  if (!input) return null;
  const hints = await getSchemaHints(storage, profileId, input, opts);
  return composeOverview({ ...input, hints });
}
