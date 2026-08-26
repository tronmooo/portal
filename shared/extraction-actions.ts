// shared/extraction-actions.ts — from meaning to a reviewable plan of writes.
// =============================================================================
//
// The second half of the document pipeline:
//
//   Document → Extract → Understand → Identify Entities → Identify
//   Relationships → Classify Facts → [Infer Actions → Resolve Existing Records
//   → Validate] → Present Review → Save
//                  └──────────── this file ────────────┘
//
// `shared/semantic-document.ts` carries a reasoner's answer about what a
// document MEANS. This module turns that answer into what will HAPPEN, and it
// is deliberately the deterministic half of the split:
//
//   A model reasons. Deterministic code holds the invariants.
//
// The invariants, each of which exists because the alternative is a specific
// kind of wrong record in the user's data:
//
//   • Every fact has a SUBJECT (never "whatever profile was selected").
//   • Resolution precedes creation — CREATE is the last option, not the first.
//   • One recurrence produces exactly ONE financial record. Its appearances
//     under the asset, in Finance, on the Calendar and on the Dashboard are
//     VIEWS over that record, reached by links, never copies.
//   • A date reaches the calendar only if the rule engine agrees it is
//     actionable. A model may not talk a signature date onto the calendar.
//   • A `stable` fact that disagrees with stored data is a CONFLICT to surface,
//     never a silent overwrite.
//   • A derived number is labelled as derived and never presented as printed.
//   • Confidence controls automation, not retention: a low-confidence value is
//     kept and ASKED about rather than routed by a guess.
//
// There is not one document type in this file. Insurance, receipts, leases,
// prescriptions and deeds are fixtures for this engine, not branches in it.
//
// Pure: no I/O, no clock beyond an injected `today`. Pinned by
// tests/extraction-actions.test.ts and the fixture suite that runs the same
// invariants over every document type.
// =============================================================================

import {
  type SemanticDocument,
  type SemanticEntity,
  type SemanticEntityKind,
  type SemanticFact,
  type SemanticRole,
  type RecurrencePattern,
  type SemanticRelationship,
  confidenceTier,
  entityByRef,
  recurrenceAmounts,
  CONFIDENCE_MEDIUM,
} from "./semantic-document";
import { type ExtractionDestination, type ExtractionItem } from "./extraction-destinations";
import { classifyDateField } from "./date-rules";
import { normalizeDateString } from "./extraction-normalize";
import { rankByName, sameEntityName } from "./entity-resolution";
import { trackerIdentityKey } from "./tracker-identity";

// ─── Operations ──────────────────────────────────────────────────────────────

/**
 * What happens to the target record. Creation is deliberately last in this
 * list and last in the resolver's preference order: a document that mentions a
 * house the app already knows about must UPDATE that house, not mint a second.
 */
export type ActionOperation =
  | "UPDATE" | "APPEND" | "LINK" | "MERGE" | "CREATE" | "RECORD" | "NO_ACTION";

export const OPERATION_LABEL: Record<ActionOperation, string> = {
  UPDATE: "Update",
  APPEND: "Add to",
  LINK: "Link",
  MERGE: "Merge into",
  CREATE: "Create",
  RECORD: "Record",
  NO_ACTION: "Keep on document",
};

// ─── Targets ─────────────────────────────────────────────────────────────────

export type TargetKind =
  | "profile" | "obligation" | "expense" | "income" | "event" | "task"
  | "tracker" | "note" | "document" | "relationship" | "liability_payment"
  | "none";

/**
 * The record an action writes to.
 *
 * `id` present  → an existing record was resolved; the action updates it.
 * `id` absent   → either a genuinely new record (an obligation this document
 *                 establishes) or an entity we could not place, in which case
 *                 the action is degraded to `reference` and asks the user.
 */
export interface TargetRef {
  kind: TargetKind;
  id?: string | null;
  /** What the review row prints: "Property: 123 Evergreen Ln". */
  name: string;
  /** Profile type when kind is "profile" — property, person, liability… */
  profileType?: string;
  /** Namespaced group within `profile.fields` ("insurance", "loan"). */
  group?: string;
  matchConfidence?: number;
  /** Why we think this is the record: "policyNumber exact", "name fuzzy 0.7". */
  matchReason?: string;
  /** The semantic entity this target came from. */
  entityRef?: string;
}

// ─── Warnings ────────────────────────────────────────────────────────────────

export type ActionWarningCode =
  | "stable_field_conflict"   // a value that should not change, changed
  | "value_conflict"          // a changeable value differs from what is stored
  | "date_incoherent"         // dates that cannot all be true at once
  | "amount_mismatch"         // a total that does not match its parts
  | "duplicate_record"        // a record like this already exists
  | "double_count"            // this would count one real-world fact twice
  | "unresolved_target"       // we could not find the record this is about
  | "low_confidence"          // we are not sure what this represents
  | "derived_value";          // this number was calculated, not printed

export interface ActionWarning {
  code: ActionWarningCode;
  message: string;
  /** true → the action starts UNTICKED and waits for a human. */
  blocking: boolean;
  /** For conflicts: what is stored now, and what the document says. */
  existing?: unknown;
  incoming?: unknown;
  field?: string;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * Why an inferred action cannot be saved.
 *
 * These are NOT errors and they are NOT reasons to hide the action. The user
 * asked for every valid consequence to be inferred and shown; a consequence
 * with nowhere to go is still worth seeing, and saying so plainly is more
 * useful than silently dropping it or — far worse — forcing it into a record
 * that means something else.
 */
export type UnsupportedReasonCode =
  | "would_create_entity"     // creating a profile/asset/liability is never allowed
  | "no_record_type"          // the app has no record that means this
  | "no_matching_record"      // it would update something we could not find
  | "not_a_ledger_event";     // a projection or quote, not a transaction

export interface ProposedAction {
  id: string;
  operation: ActionOperation;
  destination: ExtractionDestination;
  destinationOptions: ExtractionDestination[];
  target: TargetRef;
  roles: SemanticRole[];
  /** "Create recurring obligation — $1,672/yr". */
  title: string;
  /** "Frequency: yearly · next 06/01/2026". */
  detail?: string;
  /** The semantic facts behind this — the relationship, made visible. */
  factIds: string[];
  /** The raw extraction rows behind those facts — the evidence. */
  itemIds: string[];
  payload: Record<string, any>;
  /** Did the document SAY this, or does it merely justify it? */
  origin: "stated" | "implied" | "manual";
  selected: boolean;
  confidence: number;
  warnings: ActionWarning[];
  /** Write ordering: entities, then records, then links, then dates. */
  stage: 1 | 2 | 3 | 4;
  /** Idempotency. Two runs over one document produce the same key. */
  dedupeKey: string;

  /**
   * Can this actually be written?
   *
   * False means the engine understood the consequence and has nowhere
   * compatible to put it. The row still renders — with its reason, and with
   * Save disabled — because "I worked out that this is a refund and this app
   * has no refund record" is real information, and quietly inventing an
   * expense instead would be a lie the user only finds later.
   */
  savable: boolean;
  unsupportedCode?: UnsupportedReasonCode;
  /** Shown on the row: "No save destination — this app has no refund record." */
  unsupportedReason?: string;
  /**
   * Exactly what record this will create or change, in the app's own words —
   * "Expense · $84.19 · housing", "Liability payment against Cascade Auto Loan".
   * Shown BEFORE the user saves, so Save is never a surprise.
   */
  writesLabel?: string;
}

/**
 * What an action builder returns. `destinationOptions`, `savable` and
 * `writesLabel` are filled in by the single `push` gate, so no builder can
 * accidentally declare itself savable — that decision is made in one place.
 */
export type PushInput =
  Omit<ProposedAction, "destinationOptions" | "savable" | "writesLabel">
  & {
    destinationOptions?: ExtractionDestination[];
    savable?: boolean;
    writesLabel?: string;
  };

export interface ActionGroup {
  destination: ExtractionDestination;
  label: string;
  actions: ProposedAction[];
}

export interface PlanWarning {
  code: string;
  message: string;
}

export interface DocumentUnderstanding {
  documentType: string;
  primarySubject?: TargetRef;
  relatedEntities: TargetRef[];
  summary: string;
  confidence: number;
  /** "Annual premium · yearly · next 06/01/2026" — the recurrences in one line. */
  recurrenceSummary?: string;
}

export interface ActionPlan {
  understanding: DocumentUnderstanding;
  actions: ProposedAction[];
  groups: ActionGroup[];
  /** The raw rows, annotated with roles/subject/action links. */
  items: ExtractionItem[];
  warnings: PlanWarning[];
  /** Rows the engine could not interpret — asked about, never guessed at. */
  unresolvedItemIds: string[];
}

// ─── The index of what already exists ────────────────────────────────────────

export interface IndexedProfile {
  id: string;
  type: string;              // ProfileType
  typeKey?: string;
  name: string;
  fields?: Record<string, any>;
}

export interface IndexedObligation {
  id: string;
  name: string;
  category?: string;
  amount?: number;
  frequency?: string;
  linkedAssetId?: string | null;
  linkedLiabilityId?: string | null;
  linkedDocumentId?: string | null;
  linkedProfiles?: string[];
  fields?: Record<string, any>;
}

export interface IndexedExpense {
  id: string;
  description?: string;
  amount?: number;
  date?: string;
  linkedProfiles?: string[];
}

export interface IndexedTracker {
  id: string;
  name: string;
  unit?: string;
  category?: string;
}

export interface IndexedLink {
  from: string;
  to: string;
  type: string;
}

/**
 * A snapshot of the records an action could target. Built once on the server
 * and shipped with the extraction so the CLIENT can re-run the planner as the
 * user edits values and get the identical answer — the same trick
 * `extractionDateRows` already uses. Nothing here is written to; it is read
 * evidence for resolution.
 */
export interface EntityIndex {
  profiles: IndexedProfile[];
  obligations: IndexedObligation[];
  expenses: IndexedExpense[];
  trackers: IndexedTracker[];
  links: IndexedLink[];
}

export function emptyEntityIndex(): EntityIndex {
  return { profiles: [], obligations: [], expenses: [], trackers: [], links: [] };
}

// ─── Entity kind ↔ profile type ──────────────────────────────────────────────

/**
 * Which stored profile types can hold a given semantic entity.
 *
 * `organization` and `business` map to NOTHING on purpose: the carrier that
 * issued a policy and the clinic that ran a lab are real entities in the
 * document and are worth naming, but they are not records this app keeps. Their
 * facts attach to the subject they describe, as a namespaced group (below).
 */
const KIND_TO_PROFILE_TYPES: Record<SemanticEntityKind, string[]> = {
  person: ["self", "person"],
  property: ["property", "asset"],
  vehicle: ["vehicle", "asset"],
  pet: ["pet"],
  asset: ["asset", "property", "vehicle", "investment"],
  liability: ["liability", "loan"],
  account: ["account", "investment"],
  investment: ["investment", "account"],
  business: [],
  organization: [],
};

/**
 * The `profile.fields` group a third-party entity's facts land in, chosen from
 * the RELATIONSHIP rather than from the document type.
 *
 * This is an adapter between two universal vocabularies — the relationship
 * types in semantic-document.ts and the nested groups
 * `shared/profile-field-identity.ts` already promotes — not a per-document
 * rule. An insurer reached by `insured_by` writes `insurance.*` whether the
 * page was a homeowners declaration, a pet policy or a travel certificate.
 */
/**
 * Target kinds that ARE a stored entity — a profile, and therefore also an
 * asset, a liability or a recurring bill, since this app models all of them as
 * profiles discriminated by type. Creating any of these from a document is
 * forbidden; see the gate in `push`.
 */
const ENTITY_TARGET_KINDS: ReadonlySet<string> = new Set(["profile", "obligation"]);

/** Profile types that carry debt terms — a payment amount, a rate, a balance. */
const LIABILITY_PROFILE_TYPES: ReadonlySet<string> = new Set(["liability", "loan"]);

const RELATIONSHIP_TO_GROUP: Partial<Record<SemanticRelationship["type"], string>> = {
  insured_by: "insurance",
  insures: "insurance",
  covers: "insurance",
  financed_by: "loan",
  finances: "loan",
  owes: "loan",
  held_in: "finance",
  employed_by: "personal",
  treats: "health",
  prescribed: "health",
};

// ─── Small helpers ───────────────────────────────────────────────────────────

const alnum = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const slug = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

/** A short, stable, order-independent digest. Same inputs → same key, always. */
function stableKey(parts: Array<string | number | undefined | null>): string {
  const s = parts.map((p) => String(p ?? "")).join("|");
  // FNV-1a: tiny, dependency-free, and deterministic across server and client —
  // which is what makes a dedupeKey computed in the browser match the one the
  // confirm route checks against.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const money = (n: number): string =>
  `$${Math.round(n * 100) / 100 === Math.round(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CADENCE_WORD: Record<string, string> = {
  daily: "daily", weekly: "weekly", biweekly: "every 2 weeks", monthly: "monthly",
  quarterly: "quarterly", semiannual: "twice a year", yearly: "yearly",
  per_installment: "per installment",
};

/**
 * Cadence → the `recur:` tag vocabulary a repeating TASK uses
 * (shared/recurrence). Only the frequencies tasks actually support appear;
 * anything else falls back to the nearest one a task can express, because a
 * task that repeats slightly wrong still beats no task at all.
 */
const CADENCE_TO_TASK_RECURRENCE: Record<string, string> = {
  daily: "daily", weekly: "weekly", biweekly: "weekly", monthly: "monthly",
  quarterly: "monthly", semiannual: "yearly", yearly: "yearly",
  per_installment: "monthly",
};

/**
 * How many days of warning a recurrence deserves.
 *
 * One number, not a list of intervals: the app escalates every date through a
 * single attention ladder (shared/attention — overdue, within 7 days,
 * upcoming), so the ladder already provides the "warn me as it approaches"
 * behaviour. This sets the one knob that is genuinely per-record — how far out
 * it starts mattering — and a yearly renewal deserves far more notice than a
 * monthly bill.
 */
function leadDaysFor(p: RecurrencePattern): number {
  switch (p.cadence) {
    case "yearly": return 30;
    case "semiannual": return 21;
    case "quarterly": return 14;
    case "monthly": return 5;
    default: return 3;
  }
}

/** Map our cadence vocabulary onto the Obligation frequency enum. */
const CADENCE_TO_FREQUENCY: Record<string, string> = {
  daily: "weekly",           // no daily bills in the schema; weekly is the floor
  weekly: "weekly", biweekly: "biweekly", monthly: "monthly",
  quarterly: "quarterly", semiannual: "quarterly", yearly: "yearly",
  per_installment: "monthly",
};

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface ResolutionOutcome {
  target: TargetRef;
  /** Absent when nothing plausible was found. */
  matched: boolean;
}

/**
 * Find the existing record a semantic entity names.
 *
 * The ladder, strongest first:
 *   1. A shared IDENTIFIER — VIN, policy number, loan number, account last-4.
 *      Exact on alnum-stripped strings. This is the only rung that is not a
 *      guess, which is why it runs before names: "Pinnacle Home Loans" is fuzzy
 *      and a loan number is not.
 *   2. Exact normalized NAME within a compatible profile type.
 *   3. Fuzzy name, through the same `rankByName` ladder chat uses to resolve
 *      "my Honda", scored down so it lands in the medium tier and gets flagged.
 *
 * Nothing above 0.6 is treated as found. Below that the caller degrades the
 * action to `reference` and asks — a wrong record written is worse than a
 * question asked.
 */
export function resolveEntity(entity: SemanticEntity, index: EntityIndex): ResolutionOutcome {
  const allowed = KIND_TO_PROFILE_TYPES[entity.kind] ?? [];
  const base: TargetRef = {
    kind: "profile",
    name: entity.name,
    entityRef: entity.ref,
    profileType: allowed[0],
  };

  if (allowed.length === 0) {
    // An issuer or a counterparty. Real, named, and not a record we keep.
    return { target: { ...base, kind: "none", id: null, matchConfidence: 0, matchReason: "not a stored record kind" }, matched: false };
  }

  const candidates = index.profiles.filter((p) => allowed.includes(p.type));

  // 1 ── identifiers
  const wanted = Object.entries(entity.identifiers || {})
    .map(([k, v]) => [alnum(k), alnum(v)] as const)
    .filter(([, v]) => v.length >= 4);           // "1", "A" are not identifiers
  if (wanted.length > 0) {
    for (const p of candidates) {
      const fields = p.fields || {};
      const haystack = new Map<string, string>();
      for (const [k, v] of Object.entries(fields)) {
        if (v === null || v === undefined || typeof v === "object") continue;
        haystack.set(alnum(k), alnum(v));
      }
      for (const [key, val] of wanted) {
        // Match the identifier's VALUE anywhere on the record, and prefer a
        // same-named field. A policy number stored under `policyNumber` or
        // `insurance.policyNumber` is the same evidence either way.
        for (const [hk, hv] of haystack) {
          if (hv !== val) continue;
          const strongKey = hk.includes(key) || key.includes(hk);
          return {
            matched: true,
            target: {
              ...base, kind: "profile", id: p.id, name: p.name, profileType: p.type,
              matchConfidence: strongKey ? 0.98 : 0.9,
              matchReason: `${key} exact match`,
            },
          };
        }
      }
    }
  }

  // 2 ── exact name
  for (const p of candidates) {
    if (sameEntityName(p.name, entity.name)) {
      return {
        matched: true,
        target: { ...base, id: p.id, name: p.name, profileType: p.type, matchConfidence: 0.92, matchReason: "name exact" },
      };
    }
  }

  // 3 ── fuzzy name
  const ranked = rankByName(candidates, entity.name, (p) => p.name);
  if (ranked.length > 0) {
    const best = ranked[0];
    // Ambiguity is not a match. Two plausible houses means ASK, not pick.
    const ambiguous = ranked.length > 1 && sameEntityName(ranked[1].name, ranked[0].name);
    const conf = ambiguous ? 0.5 : 0.7;
    return {
      matched: conf >= 0.6,
      target: {
        ...base, id: conf >= 0.6 ? best.id : null, name: conf >= 0.6 ? best.name : entity.name,
        profileType: best.type, matchConfidence: conf,
        matchReason: ambiguous ? "several records match this name" : "name similar",
      },
    };
  }

  return { target: { ...base, id: null, matchConfidence: 0, matchReason: "no matching record" }, matched: false };
}

// ─── Conflict detection ──────────────────────────────────────────────────────

const looseEq = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  const sa = String(a ?? "").trim().toLowerCase();
  const sb = String(b ?? "").trim().toLowerCase();
  if (!sa || !sb) return true;                 // an empty side never conflicts
  if (sa === sb) return true;
  const na = Number(String(a).replace(/[^0-9.-]/g, ""));
  const nb = Number(String(b).replace(/[^0-9.-]/g, ""));
  if (isFinite(na) && isFinite(nb) && na !== 0) return Math.abs(na - nb) / Math.abs(na) < 0.005;
  return alnum(a) === alnum(b);
};

/** Read a field off a profile, looking in nested groups too. */
function readField(fields: Record<string, any> | undefined, key: string, group?: string): unknown {
  if (!fields) return undefined;
  const want = alnum(key);
  if (group && fields[group] && typeof fields[group] === "object") {
    for (const [k, v] of Object.entries(fields[group] as Record<string, any>)) {
      if (alnum(k) === want) return v;
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "object") continue;
    if (alnum(k) === want) return v;
  }
  return undefined;
}

/**
 * What a NEW value for an existing field means, decided by whether the property
 * is expected to change.
 *
 * A weight of 300 lb over a stored 180 lb is a later measurement, not an error.
 * A blood type of AB- over a stored O+ is not a change — blood type does not
 * change — so it is surfaced, blocking, with both values shown. Getting this
 * backwards either buries real corrections behind a prompt or silently
 * destroys data the user typed.
 */
function conflictFor(fact: SemanticFact, existing: unknown, key: string): ActionWarning | null {
  if (existing === undefined || existing === null || String(existing).trim() === "") return null;
  if (looseEq(existing, fact.value)) return null;
  if (fact.volatility === "historical") return null;
  if (fact.volatility === "changeable") {
    return {
      code: "value_conflict", blocking: false, field: key,
      existing, incoming: fact.value,
      message: `Was ${String(existing)} — this document says ${String(fact.value)}.`,
    };
  }
  return {
    code: "stable_field_conflict", blocking: true, field: key,
    existing, incoming: fact.value,
    message: `${fact.label} is not expected to change. Stored: ${String(existing)}. This document says: ${String(fact.value)}. Pick one.`,
  };
}

// ─── The planner ─────────────────────────────────────────────────────────────

/**
 * The record this document was filed under, chosen by a person BEFORE the
 * upload. It already exists. It is the immovable context for everything the
 * document implies, and nothing in the document can replace it, duplicate it,
 * or cause a second one to be made.
 *
 * This is what makes rule 1 enforceable rather than merely true-by-accident: a
 * statement filed under "2025 Dodge Ram Auto Loan" has that liability as
 * context, and no amount of confident reasoning about the words "Dodge Ram Auto
 * Loan" on the page may produce a second liability beside it.
 */
export interface ExtractionContext {
  entityId: string;
  /** ProfileType — property, vehicle, liability, person, asset… */
  entityType: string;
  entityName: string;
  /** The person who owns it, when the context is an asset or a liability. */
  ownerId?: string;
}

export interface PlanInput {
  semantic: SemanticDocument;
  /** The raw extraction rows, so actions can cite their evidence. */
  items: ExtractionItem[];
  index: EntityIndex;
  /** The record this document was filed under. See ExtractionContext. */
  context?: ExtractionContext;
  /** The profile the upload already filed this document under. */
  primaryProfileId?: string;
  /** The person who owns that profile. */
  ownerProfileId?: string;
  /** The document being confirmed — every write records it as its source. */
  documentId: string;
  documentName?: string;
  today: string;
}

/**
 * Turn meaning into a reviewable plan.
 *
 * Reads as one pass per KIND of consequence, in write order, because the order
 * is the dependency graph: a record has to exist before something can link to
 * it, and a recurrence has to be claimed before a stray amount can be proposed
 * as a one-off expense (which is how one premium became both a bill and a
 * charge).
 */
export function planExtractionActions(input: PlanInput): ActionPlan {
  const { semantic, index, documentId, today } = input;
  const actions: ProposedAction[] = [];
  const warnings: PlanWarning[] = [];
  const items = input.items.map((i) => ({ ...i }));
  const itemById = new Map(items.map((i) => [i.id, i]));

  // ── Resolve every entity once ──
  // ── RULE 1: the parent is the context, and it is never duplicated ────────
  //
  // A person chose this record before the upload. Any entity in the document
  // that plausibly IS that record resolves to it — not to a lookalike, not to a
  // "where does this go?" row, and never to something new.
  const contextProfile = input.context
    ? index.profiles.find((p) => p.id === input.context!.entityId)
    : input.primaryProfileId
      ? index.profiles.find((p) => p.id === input.primaryProfileId)
      : undefined;

  const contextTarget: TargetRef | undefined = contextProfile
    ? {
        kind: "profile", id: contextProfile.id, name: contextProfile.name,
        profileType: contextProfile.type, matchConfidence: 1,
        matchReason: "you filed this document here",
      }
    : undefined;

  /**
   * Is this entity the record we are already filed under?
   *
   * Deliberately generous, because the cost of the two answers is not
   * symmetric. Saying yes when the document merely names the parent again
   * costs nothing — the writes land where they were always going. Saying no
   * produces either a duplicate or an unnecessary question about a record the
   * user already picked.
   *
   * The one thing that overrides it is a stronger claim elsewhere: an entity
   * carrying an identifier that exactly matches a DIFFERENT record is that
   * other record, whatever its name looks like.
   */
  const isTheContext = (e: SemanticEntity, resolved: TargetRef): boolean => {
    if (!contextProfile || !contextTarget) return false;
    if (resolved.id === contextProfile.id) return true;
    // An identifier match on some other record wins — it is not a guess.
    if (resolved.id && resolved.id !== contextProfile.id
      && (resolved.matchConfidence ?? 0) >= 0.9) return false;
    const allowed = KIND_TO_PROFILE_TYPES[e.kind] ?? [];
    if (!allowed.includes(contextProfile.type)) return false;
    // Same kind as the context, and nothing stronger claimed it.
    return !resolved.id || (resolved.matchConfidence ?? 0) < 0.9;
  };

  const targets = new Map<string, TargetRef>();
  for (const e of semantic.entities) {
    const { target } = resolveEntity(e, index);
    if (isTheContext(e, target)) {
      targets.set(e.ref, { ...contextTarget!, entityRef: e.ref });
      continue;
    }
    targets.set(e.ref, target);
  }

  /** The nested field group a non-record entity's facts belong in. */
  const groupForEntity = (ref: string): string | undefined => {
    for (const r of semantic.relationships) {
      if (r.from === ref || r.to === ref) {
        const g = RELATIONSHIP_TO_GROUP[r.type];
        if (g) return g;
      }
    }
    return undefined;
  };

  /**
   * Where a fact about `ref` actually lands. When the subject is a record we
   * keep, that record. When it is an issuer or counterparty, the SUBJECT of the
   * document, under a namespaced group — which is how a carrier's policy number
   * becomes `insurance.policyNumber` on the house rather than a phantom profile.
   */
  const landingFor = (ref: string): { target: TargetRef; group?: string } => {
    const t = targets.get(ref);
    if (t && t.kind === "profile" && t.id) return { target: t };
    const group = groupForEntity(ref);
    const primary = semantic.primarySubject ? targets.get(semantic.primarySubject) : undefined;
    if (group && primary && primary.id) {
      return { target: { ...primary, group }, group };
    }
    return { target: t ?? { kind: "none", name: ref, id: null } };
  };

  // Facts already spoken for, so nothing is written twice.
  const claimedFacts = new Set<string>();
  const usedDedupeKeys = new Set<string>();

  const push = (a: PushInput) => {
    // INVARIANT: no two actions may share a dedupeKey. A collision means one
    // real-world fact is about to be written twice — the exact failure the
    // "never double-count" rule exists to prevent — so the second is dropped
    // and the plan says so out loud rather than quietly producing two bills.
    if (usedDedupeKeys.has(a.dedupeKey)) {
      warnings.push({
        code: "double_count_suppressed",
        message: `Suppressed a second action for "${a.title}" — it would have recorded the same thing twice.`,
      });
      return;
    }
    usedDedupeKeys.add(a.dedupeKey);

    // ── RULE 1, ENFORCED IN ONE PLACE ────────────────────────────────────
    // Every action passes through here, so this is the only gate that has to
    // hold. Creating a profile, asset or liability is never allowed — not at
    // high confidence, not for an unfamiliar document, not when the record
    // obviously "should" exist. The selected record already exists; the
    // engine's job is consequences, not entities.
    //
    // Note this catches more than it looks: in this app a recurring bill IS a
    // liability profile (supabase-storage.createObligation → createProfile
    // type:"liability"), so "create an obligation" is caught by the same rule
    // rather than needing its own.
    let savable = a.savable ?? true;
    let unsupportedCode = a.unsupportedCode;
    let unsupportedReason = a.unsupportedReason;
    if (a.operation === "CREATE" && ENTITY_TARGET_KINDS.has(a.target?.kind ?? "none")) {
      savable = false;
      unsupportedCode = "would_create_entity";
      unsupportedReason =
        `This would create a new ${a.target.profileType || "record"}. Document extraction never creates profiles, assets or liabilities — it only updates the ones you already have.`;
    }

    const action: ProposedAction = {
      ...a,
      savable,
      unsupportedCode,
      unsupportedReason,
      writesLabel: a.writesLabel ?? describeWrite(a.destination, a.operation, a.payload, a.target),
      // Nothing that cannot be written is ever ticked. An unsavable row is
      // information, not an instruction.
      selected: savable ? a.selected : false,
      destinationOptions: a.destinationOptions ?? defaultOptionsFor(a.destination),
    };
    actions.push(action);
    for (const fid of action.factIds) claimedFacts.add(fid);
    for (const iid of action.itemIds) {
      const it = itemById.get(iid);
      if (it) {
        it.actionIds = [...(it.actionIds || []), action.id];
        it.actionLabel = `${OPERATION_LABEL[action.operation]} ${targetLabel(action.target)}`;
      }
    }
  };

  // ═══ 1. Recurrences — FIRST, because they claim their facts ══════════════
  //
  // A premium is claimed here so the financial pass below cannot also propose
  // it as a one-off expense. One real-world commitment, one record.
  //
  // WHERE A RECURRENCE CAN GO, and why the obvious answer is wrong:
  //
  // "This recurs" reads like it should create a recurring bill. In this app a
  // recurring bill IS a liability profile — supabase-storage.createObligation
  // ends in createProfile({ type: "liability" }) — so creating one from a
  // document would be creating a liability from a document, which is exactly
  // what rule 1 forbids. The three honest homes are:
  //
  //   • an EXISTING bill or liability the recurrence describes → update it
  //   • a recurring DUTY with no money attached (renew, inspect, file,
  //     return, service) → a repeating task, which is not an entity
  //   • a new recurring PAYMENT with no record behind it → nowhere. Shown,
  //     explained, Save disabled.
  for (const p of semantic.recurrences) {
    const subject = p.subjectRef ? landingFor(p.subjectRef) : { target: primaryTarget(semantic, targets) };
    const amounts = recurrenceAmounts(p);
    const per = amounts.perOccurrence;
    const annual = amounts.annual;
    const cadence = CADENCE_WORD[p.cadence] || p.cadence;
    const nextDue = normalizeDateString(p.nextOccurrence) || undefined;
    const amount = per ?? annual ?? null;
    const isMoney = amount !== null && amount > 0;

    const w: ActionWarning[] = [];
    if (amounts.perOccurrenceDerived && per !== null) {
      w.push({
        code: "derived_value", blocking: false,
        message: `${money(per)} ${cadence} is calculated from the ${money(annual ?? 0)} annual figure — the document did not print it.`,
      });
    }

    const subjectId = subject.target.kind === "profile" ? subject.target.id ?? undefined : undefined;

    // Does a bill already exist for this? Then this is an UPDATE — the whole
    // point of "prefer updating over creating".
    const existing = index.obligations.find((o) => {
      const sameDoc = o.linkedDocumentId && o.linkedDocumentId === documentId;
      const sameSubject = subjectId && (o.id === subjectId || o.linkedAssetId === subjectId
        || (o.linkedProfiles || []).includes(subjectId));
      const sameAmount = amount != null && o.amount != null
        && Math.abs(o.amount - amount) <= Math.max(1, amount * 0.25);
      return Boolean(sameDoc || (sameSubject && (sameAmount || o.id === subjectId)));
    });

    // A cost already carried inside something else — a premium bundled into a
    // mortgage escrow — is genuinely owed once. Recording it again doubles it.
    const bundled = bundledCarrier(semantic, targets, index, p, subject.target);
    if (bundled) {
      w.push({
        code: "double_count", blocking: true,
        message: `${bundled} already includes this cost. Adding it again would count it twice.`,
      });
    }

    const dedupeKey = stableKey([documentId, "recurrence", subjectId ?? subject.target.name, p.id]);
    const commonPayload = {
      name: p.label,
      amount: amount ?? undefined,
      frequency: CADENCE_TO_FREQUENCY[p.cadence] || "monthly",
      nextDueDate: nextDue,
      recurrenceEnd: normalizeDateString(p.endsOn) || undefined,
      annualizedTotal: annual ?? undefined,
      linkedDocumentId: documentId,
      _source: { documentId, factIds: [...p.factIds] },
    };
    const detail = [
      `Frequency: ${cadence}`,
      nextDue ? `next ${nextDue}` : null,
      annual !== null && per !== null && annual !== per
        ? `${money(annual)}/year total${amounts.annualDerived ? " (calculated)" : ""}`
        : null,
      subject.target.id ? targetLabel(subject.target) : null,
    ].filter(Boolean).join(" · ");

    // ── (a) An existing bill or liability: update it ──
    if (existing) {
      w.push({
        code: "duplicate_record", blocking: false,
        message: `"${existing.name}" already tracks this — it will be updated, not duplicated.`,
      });
      push({
        id: `act-recurrence-${slug(p.id)}`,
        operation: "UPDATE",
        destination: "obligation",
        target: { kind: "obligation", id: existing.id, name: existing.name, entityRef: p.subjectRef },
        roles: ["recurring_obligation", "financial"],
        title: `Update recurring bill — ${isMoney ? money(amount!) : ""} ${cadence}`.replace(/\s+/g, " ").trim(),
        detail,
        factIds: [...p.factIds],
        itemIds: itemIdsForFacts(semantic, p.factIds),
        payload: { ...commonPayload, existingObligationId: existing.id, leadTimeDays: leadDaysFor(p) },
        origin: p.stated === "both" ? "stated" : "implied",
        selected: !w.some((x) => x.blocking) && confidenceTier(p.confidence) !== "low",
        confidence: p.confidence,
        warnings: w,
        stage: 2,
        dedupeKey,
      });
      continue;
    }

    // ── (a2) The subject IS an existing liability: update ITS terms ──
    // A loan statement filed under an auto loan describes that loan's payment,
    // not a new bill beside it. The payment amount, the frequency and the next
    // due date are fields on the liability we already have — updating them is
    // both the correct write and the one that cannot create anything.
    const subjectProfile = subjectId
      ? index.profiles.find((x) => x.id === subjectId)
      : undefined;
    if (isMoney && subjectProfile && LIABILITY_PROFILE_TYPES.has(subjectProfile.type)) {
      const fields: Record<string, any> = {
        monthlyPayment: amount,
        frequency: CADENCE_TO_FREQUENCY[p.cadence] || "monthly",
      };
      if (nextDue) { fields.nextDueDate = nextDue; fields.dueDate = nextDue; }
      if (commonPayload.recurrenceEnd) fields.maturityDate = commonPayload.recurrenceEnd;
      push({
        id: `act-recurrence-${slug(p.id)}`,
        operation: "UPDATE",
        destination: "entity_field",
        target: subject.target,
        roles: ["recurring_obligation", "financial"],
        title: `Update payment terms on ${subjectProfile.name} — ${money(amount!)} ${cadence}`,
        detail,
        factIds: [...p.factIds],
        itemIds: itemIdsForFacts(semantic, p.factIds),
        payload: {
          profileId: subjectProfile.id,
          fields,
          leadTimeDays: leadDaysFor(p),
          _source: { documentId, factIds: [...p.factIds] },
        },
        origin: p.stated === "both" ? "stated" : "implied",
        selected: !w.some((x) => x.blocking) && confidenceTier(p.confidence) !== "low",
        confidence: p.confidence,
        warnings: w,
        stage: 2,
        dedupeKey,
      });
      continue;
    }

    // ── (b) No money attached: a repeating duty is a repeating TASK ──
    // A task is not an entity, so this is always allowed — and it is the right
    // shape anyway for "renew the registration", "file the return", "service
    // it again in six months".
    if (!isMoney) {
      push({
        id: `act-recurrence-${slug(p.id)}`,
        operation: "CREATE",
        destination: "task",
        target: { kind: "task", id: null, name: p.label },
        roles: ["recurring_obligation"],
        title: `Repeating task — ${p.label}`,
        detail,
        factIds: [...p.factIds],
        itemIds: itemIdsForFacts(semantic, p.factIds),
        payload: {
          title: p.label,
          dueDate: nextDue,
          recurrence: CADENCE_TO_TASK_RECURRENCE[p.cadence],
          recurrenceEnd: normalizeDateString(p.endsOn) || undefined,
          linkedProfileId: subjectId,
          _source: { documentId, factIds: [...p.factIds] },
        },
        origin: "implied",
        selected: confidenceTier(p.confidence) !== "low",
        confidence: p.confidence,
        warnings: w,
        stage: 2,
        dedupeKey,
      });
      continue;
    }

    // ── (c) A recurring payment with no record behind it ──
    // Understood, and nowhere to put it. Shown with the reason rather than
    // dropped, and rather than being forced into a record that means something
    // else.
    push({
      id: `act-recurrence-${slug(p.id)}`,
      operation: "CREATE",
      destination: "unsupported",
      target: { kind: "none", id: null, name: p.label },
      roles: ["recurring_obligation", "financial"],
      title: `Recurring payment — ${money(amount!)} ${cadence}`,
      detail,
      factIds: [...p.factIds],
      itemIds: itemIdsForFacts(semantic, p.factIds),
      payload: commonPayload,
      origin: "implied",
      selected: false,
      confidence: p.confidence,
      warnings: w,
      stage: 2,
      dedupeKey,
      savable: false,
      unsupportedCode: "would_create_entity",
      unsupportedReason:
        `A new recurring bill is stored as a liability, and document extraction never creates one. Attach this to an existing bill or liability and it will update that instead.`,
      writesLabel: "Nothing — no compatible record exists",
    });
  }
  // ═══ 2. Facts, grouped by where they land ════════════════════════════════
  const fieldBuckets = new Map<string, {
    target: TargetRef; group?: string; facts: SemanticFact[]; roles: Set<SemanticRole>;
  }>();

  for (const fact of semantic.facts) {
    if (claimedFacts.has(fact.id)) continue;
    const roles = fact.roles;

    // ── Reference-only and document metadata: kept, never acted on ──
    if (roles.includes("reference_only") || roles.includes("document_metadata")) {
      push(referenceAction(fact, semantic, documentId, itemById));
      continue;
    }

    // ── Narrative: a note against its subject ──
    if (roles.includes("narrative") && !roles.includes("measurement")) {
      const landing = landingFor(fact.subject.entityRef);
      push({
        id: `act-note-${slug(fact.id)}`,
        operation: "CREATE",
        destination: "note",
        target: { ...landing.target, kind: "note" },
        roles: ["narrative"],
        title: `Save note — ${fact.label}`,
        detail: targetLabel(landing.target),
        factIds: [fact.id],
        itemIds: [...fact.itemIds],
        payload: { title: fact.label, content: String(fact.value ?? ""), _source: { documentId, factIds: [fact.id] } },
        origin: "stated",
        selected: true,
        confidence: fact.confidence,
        warnings: [],
        stage: 2,
        dedupeKey: stableKey([documentId, "note", fact.label]),
      });
      continue;
    }

    // ── Measurements: a point in a time series ──
    if (roles.includes("measurement")) {
      push(measurementAction(fact, landingFor(fact.subject.entityRef).target, index, documentId, today));
      continue;
    }

    // ── Actionable dates: only if the rule engine agrees ──
    //
    // A date is ONE write, not two. The calendar action for a date the record
    // carries IS the field write — its payload holds the key and the value —
    // which is exactly what makes the calendar entry a DERIVED rule instead of
    // a disconnected second copy. Falling through to the field bucket as well
    // would put the same date in two actions and, downstream, on two surfaces.
    if (roles.includes("actionable_date")) {
      push(dateActionFor(fact, landingFor(fact.subject.entityRef), semantic, documentId, itemById));
      continue;
    }

    // ── Everything else is a field on a record ──
    const landing = landingFor(fact.subject.entityRef);
    if (!landing.target.id) {
      // We do not know what this belongs to. Keep the value; ask.
      push(unresolvedAction(fact, landing.target, documentId, itemById));
      continue;
    }
    const bucketKey = `${landing.target.id}::${landing.group ?? ""}`;
    const bucket = fieldBuckets.get(bucketKey) ?? {
      target: landing.target, group: landing.group, facts: [], roles: new Set<SemanticRole>(),
    };
    bucket.facts.push(fact);
    for (const r of roles) bucket.roles.add(r);
    fieldBuckets.set(bucketKey, bucket);
  }

  // One action per (record, group) — "Update 6 property fields", never six rows.
  for (const [key, bucket] of fieldBuckets) {
    const profile = index.profiles.find((p) => p.id === bucket.target.id);
    const fields: Record<string, any> = {};
    const w: ActionWarning[] = [];
    for (const f of bucket.facts) {
      const fieldKey = fieldKeyFor(f, itemById);
      fields[fieldKey] = f.value;
      const existing = readField(profile?.fields, fieldKey, bucket.group);
      const c = conflictFor(f, existing, fieldKey);
      if (c) w.push(c);
      if (confidenceTier(f.confidence) === "medium") {
        w.push({
          code: "low_confidence", blocking: false, field: fieldKey,
          message: `Not fully sure "${f.label}" belongs here — worth a look.`,
        });
      }
    }
    const isPerson = bucket.target.profileType === "person" || bucket.target.profileType === "self";
    const destination: ExtractionDestination = bucket.group
      ? "entity_record"
      : isPerson ? "profile" : "entity_field";
    const n = Object.keys(fields).length;
    const blocking = w.some((x) => x.blocking);
    push({
      id: `act-fields-${slug(key)}`,
      operation: "UPDATE",
      destination,
      target: bucket.target,
      roles: [...bucket.roles],
      title: `Update ${n} field${n === 1 ? "" : "s"} on ${bucket.target.name}`,
      detail: bucket.group ? `Stored under ${bucket.group}` : targetLabel(bucket.target),
      factIds: bucket.facts.map((f) => f.id),
      itemIds: bucket.facts.flatMap((f) => f.itemIds),
      payload: {
        profileId: bucket.target.id,
        group: bucket.group,
        fields,
        _source: { documentId, factIds: bucket.facts.map((f) => f.id) },
      },
      origin: "stated",
      selected: !blocking,
      confidence: avg(bucket.facts.map((f) => f.confidence)),
      warnings: w,
      stage: 2,
      dedupeKey: stableKey([documentId, "fields", bucket.target.id, bucket.group]),
    });
  }

  // ═══ 3. Relationships ════════════════════════════════════════════════════
  for (const rel of semantic.relationships) {
    const from = targets.get(rel.from);
    const to = targets.get(rel.to);
    if (!from?.id || !to?.id) continue;                     // nothing to link
    const already = index.links.some(
      (l) => l.type === rel.type && l.from === from.id && l.to === to.id,
    );
    if (already) continue;
    const fromName = entityByRef(semantic, rel.from)?.name ?? from.name;
    const toName = entityByRef(semantic, rel.to)?.name ?? to.name;
    push({
      id: `act-link-${slug(rel.from)}-${rel.type}-${slug(rel.to)}`,
      operation: "LINK",
      destination: "relationship_link",
      target: { kind: "relationship", id: null, name: `${fromName} → ${toName}` },
      roles: ["relationship"],
      title: `Link ${fromName} ${rel.type.replace(/_/g, " ")} ${toName}`,
      factIds: [],
      itemIds: [],
      payload: { fromId: from.id, toId: to.id, type: rel.type, _source: { documentId } },
      origin: "stated",
      selected: confidenceTier(rel.confidence) !== "low",
      confidence: rel.confidence,
      warnings: [],
      stage: 3,
      dedupeKey: stableKey([documentId, "link", from.id, rel.type, to.id]),
    });
  }

  // ═══ 4. File the document against every subject it is about ══════════════
  const attachTo = new Set<string>();
  for (const t of targets.values()) if (t.kind === "profile" && t.id) attachTo.add(t.id);
  for (const id of attachTo) {
    const p = index.profiles.find((x) => x.id === id);
    if (!p) continue;
    push({
      id: `act-attach-${slug(id)}`,
      operation: "LINK",
      destination: "document_attach",
      target: { kind: "document", id, name: p.name, profileType: p.type },
      roles: [],
      title: `File this document under ${p.name}`,
      factIds: [],
      itemIds: [],
      payload: { profileId: id, documentId },
      origin: "implied",
      selected: true,
      confidence: 1,
      warnings: [],
      stage: 3,
      dedupeKey: stableKey([documentId, "attach", id]),
    });
  }

  // ── Understanding header ──
  const primary = semantic.primarySubject ? targets.get(semantic.primarySubject) : undefined;
  const understanding: DocumentUnderstanding = {
    documentType: semantic.documentType,
    primarySubject: primary,
    relatedEntities: semantic.entities
      .filter((e) => e.ref !== semantic.primarySubject)
      .map((e) => targets.get(e.ref) ?? { kind: "none", name: e.name, id: null }),
    summary: semantic.summary,
    confidence: semantic.confidence,
    recurrenceSummary: semantic.recurrences.length
      ? semantic.recurrences.map((p) => {
          const a = recurrenceAmounts(p);
          const amt = a.perOccurrence ?? a.annual;
          return `${p.label}${amt !== null ? ` · ${money(amt)}` : ""} · ${CADENCE_WORD[p.cadence] || p.cadence}`;
        }).join(" · ")
      : undefined,
  };

  const unresolvedItemIds = actions
    .filter((a) => a.destination === "reference" && a.warnings.some((w) => w.code === "unresolved_target" || w.code === "low_confidence"))
    .flatMap((a) => a.itemIds);

  return {
    understanding,
    actions,
    groups: groupActions(actions),
    items,
    warnings,
    unresolvedItemIds,
  };
}

// ─── Action builders ─────────────────────────────────────────────────────────

function referenceAction(fact: SemanticFact, doc: SemanticDocument, documentId: string, rows?: Map<string, ExtractionItem>): PushInput {
  return {
    id: `act-ref-${slug(fact.id)}`,
    operation: "NO_ACTION",
    destination: "reference",
    target: { kind: "document", id: documentId, name: doc.documentType || "this document" },
    roles: fact.roles,
    title: fact.label,
    detail: "Reference only — no calendar event, no record created",
    factIds: [fact.id],
    itemIds: [...fact.itemIds],
    payload: { key: fieldKeyFor(fact, rows), value: fact.value, calendarOptOut: true },
    origin: "stated",
    selected: true,
    confidence: fact.confidence,
    warnings: [],
    stage: 4,
    dedupeKey: stableKey([documentId, "reference", fact.id]),
  };
}

function unresolvedAction(fact: SemanticFact, target: TargetRef, documentId: string, rows?: Map<string, ExtractionItem>): PushInput {
  return {
    id: `act-ask-${slug(fact.id)}`,
    operation: "NO_ACTION",
    destination: "reference",
    target,
    roles: fact.roles,
    title: fact.label,
    detail: `Found this, but not sure where it belongs${target.name ? ` — it seems to be about ${target.name}` : ""}.`,
    factIds: [fact.id],
    itemIds: [...fact.itemIds],
    payload: { key: fieldKeyFor(fact, rows), value: fact.value },
    origin: "stated",
    selected: false,
    confidence: fact.confidence,
    warnings: [{
      code: "unresolved_target", blocking: true,
      message: target.name
        ? `No record found for "${target.name}". Pick where this should go.`
        : "Pick where this should go.",
    }],
    stage: 4,
    dedupeKey: stableKey([documentId, "ask", fact.id]),
  };
}

/**
 * A measurement becomes a point on a tracker.
 *
 * Tracker IDENTITY is resolved through the same key the rest of the app uses,
 * so "Body Weight", "Weight" and "Weight [lbs]" all find one tracker instead of
 * minting a third. Appending to an existing tracker is an APPEND; a genuinely
 * new concept is a CREATE the user can see and decline.
 */
function measurementAction(
  fact: SemanticFact,
  target: TargetRef,
  index: EntityIndex,
  documentId: string,
  today: string,
): PushInput {
  const wanted = trackerIdentityKey(fact.label);
  const existing = index.trackers.find((t) => trackerIdentityKey(t.name) === wanted);
  const num = Number(fact.value);
  const value = isFinite(num) ? num : fact.value;
  const when = normalizeDateString(fact.date) || today;
  return {
    id: `act-measure-${slug(fact.id)}`,
    operation: existing ? "APPEND" : "CREATE",
    destination: "tracker",
    target: existing
      ? { kind: "tracker", id: existing.id, name: existing.name }
      : { kind: "tracker", id: null, name: fact.label },
    roles: fact.roles,
    title: existing
      ? `Add to ${existing.name} — ${String(value)}${fact.unit ? ` ${fact.unit}` : ""}`
      : `Start tracking ${fact.label} — ${String(value)}${fact.unit ? ` ${fact.unit}` : ""}`,
    detail: [targetLabel(target), when].filter(Boolean).join(" · "),
    factIds: [fact.id],
    itemIds: [...fact.itemIds],
    payload: {
      trackerId: existing?.id,
      trackerName: existing?.name ?? fact.label,
      values: { value },
      unit: fact.unit || existing?.unit || "",
      date: when,
      profileId: target.kind === "profile" ? target.id : undefined,
      source: documentId,
      _source: { documentId, factIds: [fact.id] },
    },
    origin: "stated",
    selected: confidenceTier(fact.confidence) !== "low",
    confidence: fact.confidence,
    warnings: confidenceTier(fact.confidence) === "low"
      ? [{ code: "low_confidence", blocking: true, message: `Not sure what "${fact.label}" measures. Confirm before tracking it.` }]
      : [],
    stage: 2,
    dedupeKey: stableKey([documentId, "tracker", existing?.id ?? wanted, when]),
  };
}

/**
 * A date the reasoner called actionable, checked against the rule engine that
 * actually owns dates.
 *
 * The engine gets the last word in BOTH directions. If it says the field is
 * informational, the date is downgraded to reference no matter how confident
 * the reasoner was — this is what stops a signature date becoming an annual
 * May 20th event. If it says the field is actionable, the date reaches the
 * calendar by being ON the record (a derived rule), so no standalone event is
 * proposed and there is nothing to duplicate.
 */
function dateActionFor(
  fact: SemanticFact,
  landing: { target: TargetRef; group?: string },
  doc: SemanticDocument,
  documentId: string,
  rows?: Map<string, ExtractionItem>,
): PushInput {
  const key = fieldKeyFor(fact, rows);
  const iso = normalizeDateString(fact.value) || normalizeDateString(fact.date);
  const cls = classifyDateField(key, doc.documentType);

  if (!iso || !cls.actionable || fact.volatility === "historical") {
    return {
      ...referenceAction(fact, doc, documentId, rows),
      detail: iso
        ? `${fact.label} is a historical date — kept on the document, no calendar entry.`
        : "Reference only — no calendar event, no record created",
    };
  }

  const onRecord = Boolean(landing.target.id && landing.target.kind === "profile");
  return {
    id: `act-date-${slug(fact.id)}`,
    operation: onRecord ? "UPDATE" : "CREATE",
    destination: onRecord ? "calendar" : "calendar",
    target: onRecord
      ? { ...landing.target, kind: "profile" }
      : { kind: "event", id: null, name: fact.label },
    roles: fact.roles,
    title: `${cls.ruleType === "expiration" ? "Expiration" : cls.ruleType === "renewal" ? "Renewal" : cls.ruleType === "payment" ? "Payment" : "Date"} rule — ${fact.label}`,
    detail: onRecord
      ? `${iso} · derived from ${landing.target.name}, no duplicate event`
      : `${iso} · standalone reminder`,
    factIds: [fact.id],
    itemIds: [...fact.itemIds],
    payload: {
      key, date: iso, ruleType: cls.ruleType,
      profileId: onRecord ? landing.target.id : undefined,
      group: landing.group,
      derived: onRecord,
      // The field write this rule is derived FROM. Writing it is what puts the
      // date on the calendar; there is no separate event to create, and so
      // nothing that can fall out of step with the record.
      fields: onRecord ? { [key]: iso } : undefined,
      title: `${fact.label} — ${doc.documentType || "document"}`,
      _source: { documentId, factIds: [fact.id] },
    },
    origin: "implied",
    selected: true,
    confidence: fact.confidence,
    warnings: [],
    stage: 4,
    dedupeKey: stableKey([documentId, "date", landing.target.id ?? "", key, cls.ruleType]),
  };
}

// ─── Bundled-cost detection ──────────────────────────────────────────────────

/**
 * Is this recurring cost already carried inside something else the user pays?
 *
 * Stated universally: a liability related to the same subject that already
 * records a bundled figure is paying this cost on the user's behalf. A
 * homeowners premium inside a mortgage escrow is the case that motivated it,
 * but the shape — "a related obligation already includes this" — is the same
 * for an HOA fee inside a lease, or a service plan inside a lease payment.
 */
function bundledCarrier(
  doc: SemanticDocument,
  targets: Map<string, TargetRef>,
  index: EntityIndex,
  pattern: RecurrencePattern,
  subject: TargetRef,
): string | null {
  if (!subject.id) return null;
  const BUNDLE_FIELDS = ["escrowmonthly", "escrowincludesinsurance", "homeownersinsurance", "bundledcosts"];
  for (const p of index.profiles) {
    if (p.type !== "liability" && p.type !== "loan") continue;
    const fields = p.fields || {};
    const relatesToSubject =
      alnum(fields.propertyAddress) === alnum(subject.name) ||
      (index.links || []).some(
        (l) => (l.from === p.id && l.to === subject.id) || (l.to === p.id && l.from === subject.id),
      );
    if (!relatesToSubject) continue;
    for (const [k, v] of Object.entries(fields)) {
      if (!BUNDLE_FIELDS.includes(alnum(k))) continue;
      if (v === true) return p.name;
      const n = Number(v);
      if (isFinite(n) && n > 0) return p.name;
    }
  }
  return null;
}

// ─── Presentation ────────────────────────────────────────────────────────────

/**
 * Exactly what record this action will create or change, in the app's own
 * vocabulary. Shown on the row BEFORE the user saves, so pressing Save is never
 * a surprise about which part of the app just changed.
 */
function describeWrite(
  destination: ExtractionDestination,
  operation: ActionOperation,
  payload: Record<string, any> | undefined,
  target: TargetRef | undefined,
): string {
  const p = payload || {};
  const on = target?.name ? ` on ${target.name}` : "";
  switch (destination) {
    case "profile":
    case "entity_field":
      return `Updates ${Object.keys(p.fields || {}).length} field(s)${on}`;
    case "entity_record":
      return `Updates ${Object.keys(p.fields || {}).length} field(s) under "${p.group}"${on}`;
    case "structured_append":
      return `Adds ${(p.rows || []).length} row(s) to ${p.arrayKey}${on}`;
    case "obligation":
      return operation === "UPDATE"
        ? `Updates the recurring bill${on}`
        : "Would create a recurring bill";
    case "liability_payment":
      return `Records a payment of ${money(Number(p.amount) || 0)}${on}, and updates the balance`;
    case "expense":
      return `Creates an expense · ${money(Number(p.amount) || 0)} · ${p.category || "general"}`;
    case "income":
      return `Creates an income entry · ${money(Number(p.amount) || 0)}`;
    case "tracker":
    case "profile_tracker":
      return operation === "APPEND"
        ? `Adds an entry to the ${target?.name} tracker`
        : `Creates a ${target?.name} tracker and its first entry`;
    case "calendar":
      return p.derived
        ? `Sets ${p.key} — the reminder follows from the record, no separate event`
        : `Creates a calendar event on ${p.date}`;
    case "task":
      return p.recurrence
        ? `Creates a repeating task (${p.recurrence})${p.dueDate ? ` from ${p.dueDate}` : ""}`
        : `Creates a task${p.dueDate ? ` due ${p.dueDate}` : ""}`;
    case "note":
      return `Saves a note${on}`;
    case "relationship_link":
      return `Links two records (${p.type})`;
    case "document_attach":
      return `Files this document under ${target?.name}`;
    case "reference":
      return "Kept on the document only — nothing else changes";
    default:
      return "";
  }
}

function targetLabel(t: TargetRef | undefined): string {
  if (!t || !t.name) return "";
  const kind = t.profileType
    ? t.profileType.charAt(0).toUpperCase() + t.profileType.slice(1)
    : t.kind === "profile" ? "Profile" : "";
  return kind ? `${kind}: ${t.name}` : t.name;
}

function primaryTarget(doc: SemanticDocument, targets: Map<string, TargetRef>): TargetRef {
  return (doc.primarySubject && targets.get(doc.primarySubject)) || { kind: "none", name: "", id: null };
}

function itemIdsForFacts(doc: SemanticDocument, factIds: string[]): string[] {
  const want = new Set(factIds);
  const out: string[] = [];
  for (const f of doc.facts) {
    if (!want.has(f.id)) continue;
    for (const i of f.itemIds) if (!out.includes(i)) out.push(i);
  }
  return out;
}

/**
 * The `profile.fields` key a fact writes to.
 *
 * Taken from the extracted ROW, never from the row's id. An item id is
 * `field-${slug(key)}` and slugging lowercases — so deriving the key from the
 * id turned `yearBuilt` into `yearbuilt` and wrote a second, differently-spelled
 * copy of a field the profile already had. The row carries the real key; use it.
 *
 * Only a fact with no row behind it (a derived total) falls back to camel-casing
 * its label.
 */
function fieldKeyFor(fact: SemanticFact, rows?: Map<string, ExtractionItem>): string {
  for (const id of fact.itemIds) {
    const key = rows?.get(id)?.key;
    if (key) return String(key);
  }
  return String(fact.label || fact.id)
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("") || fact.id;
}

function avg(ns: number[]): number {
  if (ns.length === 0) return 0;
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

/** Where a row may be re-routed. Notes, reference and ignore are universal. */
function defaultOptionsFor(d: ExtractionDestination): ExtractionDestination[] {
  const base: ExtractionDestination[] = ["note", "reference", "ignore"];
  const byDestination: Partial<Record<ExtractionDestination, ExtractionDestination[]>> = {
    obligation: ["obligation", "expense", "income", "calendar", "task"],
    expense: ["expense", "obligation", "income"],
    income: ["income", "expense", "obligation"],
    tracker: ["tracker", "profile_tracker", "profile", "entity_field"],
    profile: ["profile", "profile_tracker", "entity_field", "tracker"],
    entity_field: ["entity_field", "entity_record", "profile", "tracker"],
    entity_record: ["entity_record", "entity_field", "profile"],
    calendar: ["calendar", "task", "reference"],
    relationship_link: ["relationship_link"],
    document_attach: ["document_attach"],
    structured_append: ["structured_append", "entity_record", "note"],
    reference: ["reference", "profile", "entity_field", "calendar", "task", "expense"],
  };
  const primary = byDestination[d] ?? [d];
  const out: ExtractionDestination[] = [];
  for (const x of [...primary, ...base]) if (!out.includes(x)) out.push(x);
  return out;
}

const GROUP_ORDER: ExtractionDestination[] = [
  "entity_record", "entity_field", "profile", "profile_tracker", "tracker",
  "structured_append", "obligation", "liability_payment", "expense", "income",
  "calendar", "task", "allergy", "medication", "medical_history", "note",
  "relationship_link", "document_attach", "reference", "unsupported", "ignore",
];

function groupActions(actions: ProposedAction[]): ActionGroup[] {
  const byDest = new Map<ExtractionDestination, ProposedAction[]>();
  for (const a of actions) {
    const list = byDest.get(a.destination) ?? [];
    list.push(a);
    byDest.set(a.destination, list);
  }
  const seen = new Set<ExtractionDestination>();
  const out: ActionGroup[] = [];
  for (const d of [...GROUP_ORDER, ...byDest.keys()]) {
    if (seen.has(d) || !byDest.has(d)) continue;
    seen.add(d);
    out.push({ destination: d, label: GROUP_LABEL[d] ?? d, actions: byDest.get(d)! });
  }
  return out;
}

const GROUP_LABEL: Partial<Record<ExtractionDestination, string>> = {
  entity_record: "Entity records",
  entity_field: "Entity data",
  profile: "Profile updates",
  profile_tracker: "Profile + tracker",
  tracker: "Tracker updates",
  structured_append: "Structured lists",
  obligation: "Recurring obligations",
  expense: "Expenses",
  income: "Income",
  calendar: "Calendar rules",
  task: "Tasks",
  note: "Notes",
  relationship_link: "Relationships",
  document_attach: "Document filing",
  liability_payment: "Payments",
  reference: "Reference only",
  unsupported: "Understood, but nowhere to save it",
};

/**
 * The one-line count sentence at the top of the review pane.
 *
 * Pure and exported so the exact wording is pinned by a unit test rather than
 * assembled in JSX where nothing can assert on it.
 */
export function summarizeActions(actions: ProposedAction[]): string {
  const live = actions.filter((a) => a.selected && a.operation !== "NO_ACTION");
  const counts = new Map<string, number>();
  const bump = (label: string, n = 1) => counts.set(label, (counts.get(label) ?? 0) + n);

  for (const a of live) {
    switch (a.destination) {
      case "profile":
        bump("Profile update", countFields(a)); break;
      case "entity_field":
      case "entity_record":
        bump("Entity field update", countFields(a)); break;
      case "tracker":
      case "profile_tracker":
        bump("Tracker update"); break;
      case "obligation": bump("Recurring bill update"); break;
      case "liability_payment": bump("Payment"); break;
      case "expense": bump("Expense"); break;
      case "income": bump("Income entry"); break;
      case "calendar": bump("Calendar rule"); break;
      case "task": bump("Task"); break;
      case "note": bump("Note"); break;
      case "relationship_link": bump("Relationship link"); break;
      case "document_attach": bump("Document filing"); break;
      case "structured_append": bump("List entry"); break;
      default: bump("Update"); break;
    }
  }
  const referenced = actions.filter((a) => a.destination === "reference").length;
  // Named separately and never counted as something that will happen: the
  // whole point of an unsavable row is that it will NOT be written.
  const unsavable = actions.filter((a) => !a.savable).length;

  const parts = [...counts.entries()].map(([label, n]) => `${n} ${label}${n === 1 ? "" : "s"}`);
  if (referenced > 0) parts.push(`${referenced} kept as reference only`);
  if (unsavable > 0) parts.push(`${unsavable} understood but not savable`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing to save";
}

function countFields(a: ProposedAction): number {
  const f = a.payload?.fields;
  return f && typeof f === "object" ? Object.keys(f).length : 1;
}

/** Actions the user left on, in write order. What the confirm route executes. */
export function selectedActions(plan: ActionPlan): ProposedAction[] {
  return plan.actions
    .filter((a) => a.selected && a.operation !== "NO_ACTION")
    .sort((a, b) => a.stage - b.stage);
}
