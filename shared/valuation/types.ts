// ─── Universal asset valuation: the shared contract ──────────────────────────
//
// Every layer of the valuation pipeline speaks these shapes:
//
//   Asset Data Resolver (server)  → AssetDataBundle
//   Valuation Context Builder     → ValuationContext   (shared/valuation/context.ts)
//   Valuation Strategy Planner    → ValuationPlan      (shared/valuation/planner.ts)
//   Evidence providers (server)   → ValuationEvidence[]
//   Valuation Engine              → ValuationRecord    (shared/valuation/engine.ts)
//   Cache + history + refresh     → ValuationSnapshot  (shared/valuation/freshness.ts)
//
// Nothing here names an asset type. The plan is chosen from the EVIDENCE an
// asset can offer (a tradable symbol, a purchase, a user value, a searchable
// description…), never from `type === "vehicle"`.

/** What kind of observation a piece of evidence is. */
export type EvidenceKind =
  | "market_quote"          // a live price for a tradable instrument (× quantity)
  | "live_market_search"    // a blended figure from live listings / AVMs / comps
  | "comparable"            // one comparable sale or listing
  | "transaction"           // the asset's own purchase / sale
  | "user_value"            // a value the user typed in
  | "document_appraisal"    // an appraisal / assessment found in a linked document
  | "prior_valuation"       // a previous valuation record (trend input only)
  | "trajectory"            // purchase price projected along an expected drift
  | "income_based"          // capitalized income the asset produces
  | "model_estimate";       // an appraiser-model estimate with no live data behind it

export interface ValuationEvidence {
  /** Stable within a result: "user:currentValue", "doc:<id>", "perplexity:1". */
  id: string;
  kind: EvidenceKind;
  /** Human-readable origin: "Zillow / Redfin (live search)", "Yahoo Finance". */
  source: string;
  /** Provider id that produced it (see server/valuation/providers). */
  provider: string;
  /** When the observation is FROM (a quote's time, an appraisal's date). */
  observedAt: string;
  /** When we fetched / derived it. */
  fetchedAt: string;
  /** Point estimate in `currency`, or null when the evidence is qualitative. */
  value: number | null;
  low?: number | null;
  high?: number | null;
  currency: string;
  /** 0..1 — how trustworthy the SOURCE is in general. */
  reliability: number;
  /** 0..1 — how well this observation matches THIS asset (comparable relevance). */
  relevance: number;
  /** How quickly this observation goes stale. Weight halves every halfLifeMs. */
  halfLifeMs: number;
  /** Geographic scope of the observation when it matters ("Los Angeles, CA"). */
  geographic?: string | null;
  /** URL / ticker / document id / listing id. */
  reference?: string | null;
  /** One line a person can read: "80,000 miles reduces value ~$2,000". */
  note?: string;
  /** Small provider extras (never whole responses). */
  raw?: Record<string, unknown>;
}

export type MethodologyId =
  | "direct_market_pricing"
  | "underlying_security_pricing"
  | "comparable_market_analysis"
  | "recent_transaction"
  | "value_trajectory"
  | "replacement_value"
  | "income_based"
  | "user_verified_value"
  | "document_appraisal"
  | "historical_trend"
  | "external_pricing"
  | "model_estimate";

export interface PlannedMethod {
  id: MethodologyId;
  /** Relative weight the engine gives evidence produced under this method. */
  weight: number;
  rationale: string;
  /** Provider ids the server should run to feed this method (empty = internal). */
  providers: string[];
  evidenceKinds: EvidenceKind[];
}

export interface ValuationPlan {
  methods: PlannedMethod[];
  /** Union of providers to run, deduped, in priority order. */
  providers: string[];
  needsExternal: boolean;
  /** The semantic understanding step would materially improve the plan. */
  needsAi: boolean;
  /** How old external market evidence may get before it no longer counts as current. */
  marketFreshnessMs: number;
  /** True when the description is specific enough to search the market for. */
  searchable: boolean;
  rationale: string[];
  /** Why nothing can be valued, when methods is empty. */
  unsupportedReason?: string;
}

/** The model's (or the deterministic pre-pass's) understanding of what the
 *  asset is and what drives its value. Cached by structural signature. */
export interface AssetUnderstanding {
  source: "deterministic" | "ai";
  /** Free text: "used mid-size SUV", "residential single-family home", "vintage synthesizer". */
  kind: string;
  /** Characteristics that drive value for THIS asset, best first. */
  valueDrivers: string[];
  /** How fast its market moves. Drives evidence freshness. */
  volatility: "low" | "medium" | "high";
  /** Typical yearly change when nothing better is known (−0.15 = loses 15%/yr). */
  expectedAnnualChangePct: number | null;
  /** Rough useful life in years for wear-driven assets; null when not applicable. */
  usefulLifeYears: number | null;
  /** Whether a live market search could find comparable pricing. */
  searchable: boolean;
  /** A search query the market provider should use, when searchable. */
  searchQuery: string | null;
  /** A tradable ticker / pair when the asset is (or holds) a listed instrument. */
  tradableSymbol: string | null;
  /** Methodologies the model considers appropriate, best first. */
  methodologyHints: MethodologyId[];
  /** Facts that would tighten the estimate. */
  missingInfo: string[];
  /** Structural signature this understanding was computed for. */
  signature: string;
  generatedAt: string;
}

export interface AssetDataBundle {
  profile: {
    id: string;
    name: string;
    type: string;
    type_key?: string | null;
    tags?: string[] | null;
    fields: Record<string, any>;
    notes?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
  documents?: Array<{ id: string; name?: string | null; type?: string | null; extractedData?: Record<string, any> | null; createdAt?: string | null }>;
  expenses?: Array<{ id?: string; description?: string | null; amount?: number | string | null; category?: string | null; date?: string | null }>;
  incomes?: Array<{ amount?: number | string | null; frequency?: string | null; description?: string | null }>;
  timeline?: Array<{ type?: string; title?: string; timestamp?: string }>;
  children?: Array<{ id: string; name: string; type: string; fields?: Record<string, any> }>;
  linked?: Array<{ id: string; name: string; type: string; relation: string; fields?: Record<string, any> }>;
  owners?: Array<{ profileId: string; percentage: number }>;
  history?: ValuationHistoryEntry[];
  aiSummary?: string | null;
  understanding?: AssetUnderstanding | null;
}

export interface ValuationContext {
  profileId: string;
  name: string;
  entityClass: "asset" | "liability" | "other";
  classification: { semanticCategory: string; entityLabel: string; confidence: "high" | "medium" | "low" };
  /** Material characteristics, canonical keys, scalar values. */
  attributes: Record<string, string | number | boolean>;
  identifiers: { symbol?: string; vin?: string; address?: string; serial?: string; modelNumber?: string };
  quantity: number | null;
  /** A value the user entered themselves (never an estimator-written one). */
  userValue: { value: number; asOf: string | null; key: string } | null;
  /** The estimator-owned value currently mirrored into the profile, if any. */
  estimatorValue: number | null;
  purchase: { price: number | null; date: string | null };
  appraisals: Array<{ value: number; date: string | null; source: string; label: string }>;
  improvements: { upgradesTotal: number; repairsTotal: number; count: number; lastServiceDate: string | null };
  income: { monthly: number } | null;
  condition: string | null;
  ageYears: number | null;
  usage: Record<string, number>;
  /** Search-friendly one-line description of the asset. */
  description: string;
  notesSignals: string[];
  history: ValuationHistoryEntry[];
  understanding: AssetUnderstanding | null;
  /** The facts the fingerprint is computed over — what the valuation depends on. */
  materialInputs: Record<string, unknown>;
  inputFingerprint: string;
  /** Fingerprint over the profile-row facts only (no linked records) — computable from the profiles list. */
  profileFingerprint: string;
  /** Structural signature (keys, not values) for caching the semantic understanding. */
  signature: string;
  /** 0..1 — how much usable information there is. */
  dataQuality: number;
  sparse: boolean;
  /** Free-form context that only the live-search provider needs (notes, docs, expenses). */
  dossier: {
    notes: string | null;
    aiSummary: string | null;
    expenses: Array<{ description?: string | null; amount?: number | string | null; category?: string | null; date?: string | null }>;
    documents: Array<{ name?: string | null; type?: string | null; extractedData?: Record<string, any> | null }>;
    timeline: Array<{ type?: string; title?: string; timestamp?: string }>;
    fields: Record<string, any>;
    type: string;
  };
}

export type ValuationStatus = "valued" | "insufficient_data" | "unsupported" | "error";

export type RefreshReason =
  | "first_valuation"
  | "inputs_changed"
  | "market_evidence_stale"
  | "scheduled"
  | "user_requested"
  | "retry_after_error"
  | "model_version";

export interface ValuationRecord {
  schemaVersion: 1;
  /** Calculation / model version. A bump re-values everything on next open. */
  modelVersion: string;
  profileId: string;
  status: ValuationStatus;
  currency: string;
  /** Estimated current value; null unless status === "valued". */
  value: number | null;
  low: number | null;
  high: number | null;
  /** 0..1, reflecting evidence weight, agreement and freshness. */
  confidence: number;
  confidenceLabel: "high" | "medium" | "low" | "none";
  methodology: MethodologyId[];
  /** Short human summary of how the number was produced. */
  methodSummary: string;
  evidence: ValuationEvidence[];
  materialInputs: Record<string, unknown>;
  inputFingerprint: string;
  /** See ValuationContext.profileFingerprint. Absent on records written before it existed. */
  profileFingerprint?: string;
  /** Newest observation time among market evidence; null when none was used. */
  marketDataAsOf: string | null;
  /** How old market evidence may get before this record is stale. */
  marketFreshnessMs: number;
  valuedAt: string;
  /** Last time the freshness check ran (a check that found nothing changed). */
  checkedAt: string;
  nextRefreshAt: string;
  refreshReason: RefreshReason;
  factors: string[];
  missingInfo: string[];
  understanding: { kind: string; source: "deterministic" | "ai"; valueDrivers: string[] } | null;
  /** Consecutive failed attempts (drives retry backoff). */
  errorCount: number;
  error?: string | null;
  /** Wall-clock cost of the run that produced this record. */
  computeMs?: number;
}

export interface ValuationHistoryEntry {
  valuedAt: string;
  status: ValuationStatus;
  value: number | null;
  low: number | null;
  high: number | null;
  confidence: number;
  methodology: MethodologyId[];
  inputFingerprint: string;
  refreshReason: RefreshReason;
}

export interface FreshnessVerdict {
  fresh: boolean;
  /** Why a refresh is due; null when fresh. */
  reason: RefreshReason | null;
  /** A refresh already running elsewhere would make this moot. */
  detail: string;
}

/** One row of the Assets-tab sweep: what is stored and whether it needs a refresh. */
export interface ValuationStatusRow {
  profileId: string;
  status: ValuationStatus | "none";
  value: number | null;
  valuedAt: string | null;
  confidenceLabel: ValuationRecord["confidenceLabel"];
  fresh: boolean;
  reason: RefreshReason | null;
}

export interface ValuationSnapshot {
  record: ValuationRecord | null;
  freshness: FreshnessVerdict;
  /** The fingerprint of the CURRENT inputs (what a refresh would value). */
  inputFingerprint: string;
  /** True when the profile is one the valuation system can value at all. */
  supported: boolean;
  /** A refresh is currently running (lock held). */
  refreshing?: boolean;
}

/** Bump when the engine's math changes in a way that should re-value stored records. */
export const VALUATION_MODEL_VERSION = "valuation-v1";
export const DEFAULT_CURRENCY = "USD";
