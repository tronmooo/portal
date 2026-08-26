// ── Overview contract (2026-08-26) ───────────────────────────────────────────
// The structured definition an Asset / Liability profile's Overview tab is
// rendered from. Pure types + a strict normalizer; no I/O, no React.
//
// WHY THIS EXISTS
// The Overview used to be a hardcoded per-type field list (FIELD_GROUPS in
// profile-detail.tsx): a house rendered "Location / Value", a vehicle rendered
// "Vehicle Identity", and anything the app had never heard of (a boat, a
// patent, a guitar, a solar install) fell through to an alphabetical dump of
// every stored key. That is backwards. What belongs on an Overview depends on
// what the entity IS and what we actually know about it, not on which template
// someone remembered to write.
//
// So the pipeline is:
//
//   entity data → semantic classification → entity schema → composition → render
//   (canonical)   (overview-semantics)      (roles+ranks)   (overview-compose)  (DynamicOverview)
//
// and the thing that crosses the wire is a DEFINITION (this file), never
// markup and never prose. The AI layer may only fill in / re-rank parts of
// this structure — it can never introduce a component the renderer doesn't
// already know how to draw, which is what keeps a dynamic Overview visually
// consistent with the rest of the app.
//
// TWO HALVES, DELIBERATELY SEPARATE
//   * composition (which sections exist, in what order, holding which
//     semantic keys) — depends on the entity's SHAPE, changes rarely, and is
//     the only part the AI is consulted about (and is cached by shape).
//   * data (the values inside those slots) — always resolved fresh from
//     canonical storage at request time. A stale layout must never be able to
//     show a stale number.
//
// Pinned by tests/overview-compose.test.ts.

/** Presentation primitives the frontend renderer implements. The AI picks
 *  FROM this list; it never invents one. Anything unknown is dropped. */
export const OVERVIEW_COMPONENTS = [
  "hero",                 // identity + status + the single headline value
  "keyMetric",            // one large number with a label
  "metricRow",            // 2–4 metrics side by side
  "fieldRow",             // label → value
  "groupedDetails",       // a card of fieldRows under a title
  "statusBadge",          // lifecycle / condition chip
  "dateCard",             // a meaningful date + what it means + urgency
  "financialSummary",     // value / debt / equity style money block
  "ownershipSummary",     // who owns it and how much
  "relationshipSummary",  // a linked entity summarized, not flattened
  "miniTimeline",         // a few dated events
  "valuationSummary",     // current value + basis + confidence
  "progressIndicator",    // paydown / warranty / term progress
  "documentSummary",      // what's on file
  "maintenanceSummary",   // service state
  "attentionCard",        // something needs action
  "aiInsight",            // model-written observation, labeled as such
  "missingInfo",          // "complete this profile" suggestions
] as const;
export type OverviewComponent = (typeof OVERVIEW_COMPONENTS)[number];

/** How much of the reader's attention a piece of information deserves.
 *  Only primary/secondary reach the Overview; the rest name where the
 *  information lives instead. */
export const IMPORTANCE_LEVELS = ["primary", "secondary", "detailed", "administrative"] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

/** Where a value came from. Drives whether it renders as fact or estimate. */
export const PROVENANCE_KINDS = ["user", "document", "linked", "calculated", "external", "ai"] as const;
export type Provenance = (typeof PROVENANCE_KINDS)[number];

/** How a scalar should be formatted. The renderer owns the actual typography. */
export const DISPLAY_TYPES = [
  "text", "longText", "money", "moneyPerMonth", "percent", "number",
  "date", "relativeDate", "identifier", "badge", "list", "url", "duration",
] as const;
export type DisplayType = (typeof DISPLAY_TYPES)[number];

/** What a date MEANS, so it can be rendered as more than a string. */
export const DATE_MEANINGS = [
  "expiration", "renewal", "payment", "warranty", "registration", "maturity",
  "lease_end", "inspection", "maintenance", "tax", "purchase", "start",
  "generic",
] as const;
export type DateMeaning = (typeof DATE_MEANINGS)[number];

/** Where a displayed value is actually owned. A relationship-derived number
 *  (a property showing its mortgage balance) points at the OTHER entity — the
 *  Overview displays it, the linked entity owns it. */
export interface SourceReference {
  kind: "field" | "relationship" | "derived" | "document" | "aggregate";
  /** Canonical field key on the owning entity, when kind === "field". */
  fieldKey?: string;
  /** Owning entity, when the value belongs to a linked record. */
  entityId?: string;
  entityName?: string;
  entityKind?: string;
  /** For derived values: the semantic keys that fed the calculation. */
  inputs?: string[];
}

export interface OverviewValue {
  /** Stable semantic identity ("currentValue", "linkedDebtBalance"). */
  semanticKey: string;
  label: string;
  /** Already-resolved canonical value. Null means "known to be absent". */
  value: string | number | null;
  displayType: DisplayType;
  importance: Importance;
  provenance: Provenance;
  /** 0–1. Only set where confidence is genuinely meaningful (estimates). */
  confidence?: number;
  sourceReference: SourceReference;
  /** Short qualifier: "as of Mar 2026", "estimated from 3 comparables". */
  note?: string;
  /** Editing affordance: which profile + field an inline edit should write. */
  editable?: { profileId: string; fieldKey: string };
  dateMeaning?: DateMeaning;
  /** Positive/negative framing for deltas (appreciation vs depreciation). */
  tone?: "positive" | "negative" | "neutral" | "warning";
}

/** A linked entity summarized on this Overview. The values stay owned by the
 *  linked entity — this is a view, never a copy. */
export interface OverviewRelationship {
  relation: string;             // "financing" | "insurance" | "owner" | "contains" | …
  label: string;                // "Mortgage"
  entityId: string;
  entityName: string;
  entityKind: string;           // profile type / type_key
  href?: string;
  facts: OverviewValue[];       // balance, payment — sourceReference points at entityId
}

export interface OverviewSection {
  id: string;
  component: OverviewComponent;
  title?: string;
  /** Lower sorts first. Composition assigns these from importance + category. */
  priority: number;
  /** Rendered collapsed; the reader opens it. */
  collapsed?: boolean;
  values?: OverviewValue[];
  relationships?: OverviewRelationship[];
  /** Free-form structured payload for components with their own shape
   *  (progressIndicator, miniTimeline, documentSummary). Never markup. */
  data?: Record<string, unknown>;
}

export interface OverviewAttentionItem {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail?: string;
  /** ISO date this is about, when it is date-driven. */
  date?: string;
  daysUntil?: number;
  sourceReference?: SourceReference;
}

export interface OverviewMissingItem {
  semanticKey: string;
  label: string;
  /** Why THIS entity would benefit — never a generic "you could add more". */
  reason: string;
  importance: Importance;
  /** The metric this unlocks, when that's the reason it's worth asking for. */
  unlocks?: string;
  fieldKey: string;
}

export interface OverviewIdentity {
  profileId: string;
  name: string;
  /** Human label for what this is: "Single-family home", "Auto loan". */
  entityLabel: string;
  entityClass: "asset" | "liability" | "other";
  semanticCategory: string;
  subtype?: string;
  subtitle?: string;
  status?: { label: string; tone: "positive" | "neutral" | "warning" | "critical" };
  /** The one headline number, if the entity has one. */
  headline?: OverviewValue;
}

export interface OverviewSpec {
  identity: OverviewIdentity;
  summaryMetrics: OverviewValue[];
  sections: OverviewSection[];
  attentionItems: OverviewAttentionItem[];
  missingInformation: OverviewMissingItem[];
  insights: Array<{ id: string; title: string; detail: string; confidence?: number }>;
  meta: {
    /** Structural fingerprint the composition was built for. */
    signature: string;
    /** "deterministic" when composed with no model input. */
    schemaSource: "deterministic" | "ai-assisted";
    composedAt: string;
    /** Semantic keys deliberately routed elsewhere, with their destination. */
    routedElsewhere?: Array<{ semanticKey: string; destination: string }>;
  };
}

// ── AI hint contract ─────────────────────────────────────────────────────────
// The model NEVER returns an OverviewSpec. It returns hints: what kind of
// thing this is, which fields matter, how to group them, what's missing. The
// composition engine holds the pen, so a hallucinated field key or a made-up
// number cannot reach the screen.

export interface OverviewFieldHint {
  label?: string;
  importance?: Importance;
  group?: string;
  displayType?: DisplayType;
  dateMeaning?: DateMeaning;
}

export interface OverviewSchemaHints {
  entityLabel?: string;
  semanticCategory?: string;
  subtype?: string;
  /** Field key → presentation hint. Keys not present on the entity are dropped. */
  fieldHints?: Record<string, OverviewFieldHint>;
  /** Field keys the model considers headline-worthy, best first. */
  summaryMetricKeys?: string[];
  /** Group titles in the order they should appear. */
  sectionOrder?: string[];
  missingInformation?: Array<{ semanticKey: string; label?: string; reason?: string; importance?: Importance }>;
  insights?: Array<{ title: string; detail: string; confidence?: number }>;
}

function oneOf<T extends string>(allowed: readonly T[], v: unknown): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function cleanString(v: unknown, max = 160): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  return s ? s.slice(0, max) : undefined;
}

/**
 * Strict normalizer for model output. Everything unrecognized is DROPPED, not
 * coerced: an unknown component, an invented importance level, a field key
 * that isn't on the entity, a 400-word "insight". `knownFieldKeys` is the
 * whitelist of keys the entity actually carries — hints for anything else are
 * discarded so the model cannot conjure a field into existence.
 */
export function normalizeSchemaHints(
  raw: unknown,
  knownFieldKeys: readonly string[] = [],
): OverviewSchemaHints {
  const out: OverviewSchemaHints = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, any>;
  const known = new Set(knownFieldKeys);

  out.entityLabel = cleanString(r.entityLabel, 60);
  out.semanticCategory = cleanString(r.semanticCategory, 40)?.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  out.subtype = cleanString(r.subtype, 40);

  if (r.fieldHints && typeof r.fieldHints === "object") {
    const hints: Record<string, OverviewFieldHint> = {};
    for (const [key, val] of Object.entries(r.fieldHints as Record<string, any>)) {
      if (known.size > 0 && !known.has(key)) continue;
      if (!val || typeof val !== "object") continue;
      const hint: OverviewFieldHint = {};
      hint.label = cleanString(val.label, 40);
      hint.importance = oneOf(IMPORTANCE_LEVELS, val.importance);
      hint.group = cleanString(val.group, 40);
      hint.displayType = oneOf(DISPLAY_TYPES, val.displayType);
      hint.dateMeaning = oneOf(DATE_MEANINGS, val.dateMeaning);
      if (Object.values(hint).some(v => v !== undefined)) hints[key] = hint;
    }
    if (Object.keys(hints).length) out.fieldHints = hints;
  }

  if (Array.isArray(r.summaryMetricKeys)) {
    const keys = r.summaryMetricKeys
      .filter((k: unknown): k is string => typeof k === "string")
      .filter((k: string) => known.size === 0 || known.has(k))
      .slice(0, 6);
    if (keys.length) out.summaryMetricKeys = keys;
  }

  if (Array.isArray(r.sectionOrder)) {
    const order = r.sectionOrder
      .map((s: unknown) => cleanString(s, 40))
      .filter((s): s is string => !!s)
      .slice(0, 12);
    if (order.length) out.sectionOrder = order;
  }

  if (Array.isArray(r.missingInformation)) {
    const missing = r.missingInformation
      .map((m: any) => {
        const semanticKey = cleanString(m?.semanticKey, 60);
        if (!semanticKey) return null;
        // A field the entity already has is not missing.
        if (known.has(semanticKey)) return null;
        return {
          semanticKey,
          label: cleanString(m?.label, 40),
          reason: cleanString(m?.reason, 140),
          importance: oneOf(IMPORTANCE_LEVELS, m?.importance),
        };
      })
      .filter(Boolean)
      .slice(0, 6) as OverviewSchemaHints["missingInformation"];
    if (missing && missing.length) out.missingInformation = missing;
  }

  if (Array.isArray(r.insights)) {
    const insights = r.insights
      .map((i: any) => {
        const title = cleanString(i?.title, 60);
        const detail = cleanString(i?.detail, 220);
        if (!title || !detail) return null;
        const c = Number(i?.confidence);
        return { title, detail, confidence: Number.isFinite(c) && c >= 0 && c <= 1 ? c : undefined };
      })
      .filter(Boolean)
      .slice(0, 3) as OverviewSchemaHints["insights"];
    if (insights && insights.length) out.insights = insights;
  }

  return out;
}

/**
 * Structural fingerprint of an entity: what it is, what keys it carries, what
 * it is linked to. Deliberately excludes VALUES — editing a balance must not
 * invalidate a cached composition, while adding a new field (or a first
 * mortgage link) must. This is what makes "regenerate the layout when the
 * shape changes, resolve the numbers every time" enforceable.
 */
export function overviewSignature(input: {
  type?: string | null;
  typeKey?: string | null;
  fieldKeys: readonly string[];
  relationKinds?: readonly string[];
  hasDocuments?: boolean;
}): string {
  const parts = [
    `t:${(input.type || "").toLowerCase()}`,
    `k:${(input.typeKey || "").toLowerCase()}`,
    `f:${[...new Set(input.fieldKeys)].filter(k => !k.startsWith("_")).sort().join(",")}`,
    `r:${[...new Set(input.relationKinds || [])].sort().join(",")}`,
    `d:${input.hasDocuments ? 1 : 0}`,
  ];
  const joined = parts.join("|");
  // Small stable hash — this is a cache key, not a security primitive.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `ov1_${h1.toString(36)}${h2.toString(36)}`;
}
