// shared/semantic-document.ts — the universal vocabulary of document meaning.
// =============================================================================
//
// Why this file exists (user directive, 2026-08-25):
//
//   "Do not build document-specific routing rules. Build a semantic reasoning
//    system."
//
// Extraction used to end when fields had been read off the page. A homeowners
// declarations page produced 75 rows of `Field | Value | Calendar`: 75 facts,
// with no notion of what any of them MEANT, who they were ABOUT, how they
// RELATED, or what they should CAUSE. Routing was a per-field regex cascade
// (`suggestDestination`), which by construction cannot see two fields at once —
// so `Annual Premium` + `Payment Plan` + `Next Payment Due` could never add up
// to one recurring obligation.
//
// The fix is NOT another routing table keyed on insurance field names. That way
// lies fixing insurance today, medical reports tomorrow, leases on Wednesday.
// This module is the vocabulary a reasoning stage speaks instead, and it
// deliberately contains NO document types: insurance, receipts, prescriptions,
// deeds and leases are fixtures for one engine, not eight code paths.
//
// The pipeline this vocabulary sits in the middle of:
//
//   Document → Extract → Understand → Identify Entities → Identify
//   Relationships → Classify Facts → Infer Actions → Resolve Existing Records
//   → Validate → Present Review → Save
//
// This file owns "Understand" through "Classify Facts" as DATA, plus the
// validation that decides whether a reasoner's answer may be trusted at all.
// `shared/extraction-actions.ts` owns "Infer Actions" onward, deterministically.
//
// THE DIVISION OF LABOUR THAT MATTERS:
//   • A model reasons — meaning, subjects, entities, relationships, roles,
//     recurrence, and what is implied.
//   • Deterministic code holds every invariant — validation, entity resolution,
//     dedupe, double-count prevention, calendar gating, conflict detection,
//     provenance, confidence gating, and every write.
// The model proposes. It never authors a write. `validateSemanticDocument`
// below is the border between the two, and it DROPS what it cannot verify
// rather than repairing it — a repaired hallucination is still a hallucination.
//
// Pure: no I/O, no clock. Pinned by tests/semantic-envelope.test.ts.
// =============================================================================

import { MAX_TRANSACTION_AMOUNT } from "./schema";

// ─── Semantic roles ──────────────────────────────────────────────────────────

/**
 * What a fact IS. A fact may carry several roles at once — a vehicle's odometer
 * reading is both `entity_data` (an attribute of the car) and `measurement`
 * (a point in a time series), which is why this is a list and not an enum field.
 *
 * `reference_only` is load-bearing and is NOT a synonym for junk: it means
 * "useful information that must cause nothing". A signature date is real,
 * worth keeping, and must never become a recurring May 20th calendar event.
 * `document_metadata` is the issuer/number/form-code layer around the content.
 */
export type SemanticRole =
  | "profile_data"          // persistent information about a person
  | "entity_data"           // attributes of an asset/vehicle/property/liability/pet/account
  | "measurement"           // a value meaningful across time → tracker
  | "financial"             // income, expense, balance, payment, premium, fee, tax, value
  | "recurring_obligation"  // something expected to happen repeatedly
  | "actionable_date"       // a date requiring future awareness
  | "relationship"          // ownership, lender, insurer, provider, employer…
  | "narrative"             // meaningful unstructured information
  | "status_change"         // the document says an existing record's state is now X
  | "event_occurred"        // the document is PROOF something already happened
  | "document_metadata"     // issuer, document number, creation/signature info
  | "reference_only";       // keep it, act on nothing

export const ALL_SEMANTIC_ROLES: readonly SemanticRole[] = [
  "profile_data", "entity_data", "measurement", "financial",
  "recurring_obligation", "actionable_date", "relationship", "narrative",
  "status_change", "event_occurred", "document_metadata", "reference_only",
] as const;

const ROLE_SET: ReadonlySet<string> = new Set(ALL_SEMANTIC_ROLES);

/** Human labels for the review pane's grouping. */
export const SEMANTIC_ROLE_LABEL: Record<SemanticRole, string> = {
  profile_data: "Profile data",
  entity_data: "Entity data",
  measurement: "Measurement",
  financial: "Financial",
  recurring_obligation: "Recurring obligation",
  actionable_date: "Actionable date",
  relationship: "Relationship",
  narrative: "Note",
  status_change: "Status change",
  event_occurred: "Already happened",
  document_metadata: "Document metadata",
  reference_only: "Reference only",
};

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * The kinds of thing a document can be ABOUT or MENTION. These mirror the
 * `ProfileType` union in schema.ts (people, properties, vehicles, pets, assets,
 * liabilities, accounts, investments) plus the two kinds that appear in
 * documents without ever becoming a profile of their own — a `business` the
 * user deals with and an `organization` that merely issued the paper.
 */
export type SemanticEntityKind =
  | "person" | "property" | "vehicle" | "pet" | "asset" | "liability"
  | "account" | "investment" | "business" | "organization";

export const ALL_ENTITY_KINDS: readonly SemanticEntityKind[] = [
  "person", "property", "vehicle", "pet", "asset", "liability",
  "account", "investment", "business", "organization",
] as const;

const ENTITY_KIND_SET: ReadonlySet<string> = new Set(ALL_ENTITY_KINDS);

export interface SemanticEntity {
  /** Local to this document ("e1"). Never a database id — resolution comes later. */
  ref: string;
  kind: SemanticEntityKind;
  name: string;
  /**
   * The strings that make this entity findable in existing records: VIN, policy
   * number, loan number, account last-4, license number, microchip. Resolution
   * matches on these BEFORE it matches on names, because "Pinnacle Home Loans"
   * is fuzzy and a loan number is not.
   */
  identifiers: Record<string, string>;
  /** The part it plays HERE: "insured", "lender", "provider", "issuer". */
  role?: string;
  confidence: number;
}

// ─── Relationships ───────────────────────────────────────────────────────────

/**
 * Documents describe relationships, not only isolated facts. These are what let
 * later reasoning answer "what insures this house?" without re-reading the PDF.
 */
export type SemanticRelationshipType =
  | "owns" | "owes" | "insures" | "insured_by" | "treats" | "prescribed"
  | "pays" | "covers" | "issued_by" | "financed_by" | "finances"
  | "employed_by" | "held_in" | "supports" | "beneficiary_of";

export const ALL_RELATIONSHIP_TYPES: readonly SemanticRelationshipType[] = [
  "owns", "owes", "insures", "insured_by", "treats", "prescribed",
  "pays", "covers", "issued_by", "financed_by", "finances",
  "employed_by", "held_in", "supports", "beneficiary_of",
] as const;

const RELATIONSHIP_SET: ReadonlySet<string> = new Set(ALL_RELATIONSHIP_TYPES);

export interface SemanticRelationship {
  /** Entity refs, both local to this document. */
  from: string;
  to: string;
  type: SemanticRelationshipType;
  confidence: number;
}

// ─── Facts ───────────────────────────────────────────────────────────────────

/**
 * For a fact with the `financial` role: WHAT KIND of money this is.
 *
 * An amount alone is not enough to route anything. $612 on a loan statement is
 * a PAYMENT against the balance; $612 on a repair invoice is a CHARGE; $612 on
 * a settlement letter is a REFUND. Without this distinction the planner has to
 * guess, and the guesses are the ones that hurt: a loan payment filed as an
 * expense double-counts the month's outgoings, and a refund filed as income
 * inflates earnings.
 *
 * `estimate` is deliberately separate from every other kind. A payoff quote or
 * a projected annual total is a CALCULATION about the future, not a ledger
 * event, and it must never become a transaction.
 */
export type FinancialKind =
  | "charge"    // a cost incurred — an expense
  | "payment"   // money paid out, possibly against a liability
  | "refund"    // money coming back — NOT income
  | "credit"    // an account credit — NOT income
  | "transfer"  // moved between the user's own records — neither
  | "income"    // money genuinely earned or received as income
  | "balance"   // what is owed or held right now — a field, and a point in time
  | "rate"      // APR, interest rate, percentage — a field
  | "fee"       // a late fee or penalty — a charge, worth naming as one
  | "estimate"; // a quote or projection — never a ledger row

export const ALL_FINANCIAL_KINDS: readonly FinancialKind[] = [
  "charge", "payment", "refund", "credit", "transfer",
  "income", "balance", "rate", "fee", "estimate",
] as const;

const FINANCIAL_KIND_SET: ReadonlySet<string> = new Set(ALL_FINANCIAL_KINDS);

/**
 * For a fact with the `status_change` role: what the document says a record's
 * state now IS.
 *
 * A statement stamped PAID, a policy marked CANCELLED, a permit marked APPROVED
 * — the document is evidence about an existing record's lifecycle, not a new
 * record.
 */
export type StatusValue =
  | "active" | "paid" | "overdue" | "cancelled" | "renewed" | "expired"
  | "closed" | "completed" | "approved" | "denied" | "pending" | "suspended";

export const ALL_STATUS_VALUES: readonly StatusValue[] = [
  "active", "paid", "overdue", "cancelled", "renewed", "expired",
  "closed", "completed", "approved", "denied", "pending", "suspended",
] as const;

const STATUS_VALUE_SET: ReadonlySet<string> = new Set(ALL_STATUS_VALUES);

/**
 * Whether a property is expected to change, and therefore what a NEW value for
 * it means:
 *
 *   • `stable`     — blood type, VIN, date of birth, year built. A different
 *                    value is a CONFLICT to surface, never a silent overwrite.
 *   • `changeable` — weight, balance, mileage, asset value. A later-dated value
 *                    is simply the current one, and the old one is history.
 *   • `historical` — a signature date, a past transaction. It describes a moment
 *                    and overwrites nothing, ever.
 */
export type FactVolatility = "stable" | "changeable" | "historical";

const VOLATILITY_SET: ReadonlySet<string> = new Set(["stable", "changeable", "historical"]);

/** Every extracted fact has a SUBJECT. Nothing defaults to "the selected profile". */
export interface FactSubject {
  /** Entity ref into `SemanticDocument.entities`. */
  entityRef: string;
  confidence: number;
}

export interface SemanticFact {
  id: string;
  /**
   * The raw extraction rows this fact was read from — its evidence. The review
   * pane shows these under the action, and validation requires every one of
   * them to actually exist in the extraction, which is what stops a reasoner
   * from asserting a fact the document never printed.
   */
  itemIds: string[];
  label: string;
  value: unknown;
  roles: SemanticRole[];
  subject: FactSubject;
  volatility: FactVolatility;
  unit?: string;
  /** When the fact was TRUE (a lab draw date), not when the paper was printed. */
  date?: string;
  /**
   * For a `financial` fact: what kind of money. Routing depends on it entirely
   * — see FinancialKind. A financial fact without one is treated as unknown and
   * asked about rather than guessed at.
   */
  financialKind?: FinancialKind;
  /** For a `status_change` fact: the state the document says the record is in. */
  status?: StatusValue;
  /**
   * For an `actionable_date`: how many days ahead the user wants warning. The
   * app escalates every date through one attention ladder, so this is a single
   * lead time, not a list of intervals — see the planner for why.
   */
  reminderDaysBefore?: number;
  confidence: number;
  /**
   * Set when the value was CALCULATED rather than printed. "$960/yr — derived
   * from $80 × 12". A derived value is always labelled as such in the UI and
   * never presented as something the document said.
   */
  derivedFrom?: { factIds: string[]; formula: string };
}

// ─── Recurrence ──────────────────────────────────────────────────────────────

export type RecurrenceCadence =
  | "daily" | "weekly" | "biweekly" | "monthly"
  | "quarterly" | "semiannual" | "yearly" | "per_installment";

export const ALL_CADENCES: readonly RecurrenceCadence[] = [
  "daily", "weekly", "biweekly", "monthly",
  "quarterly", "semiannual", "yearly", "per_installment",
] as const;

const CADENCE_SET: ReadonlySet<string> = new Set(ALL_CADENCES);

/** How many times a cadence occurs in a year. `per_installment` is unknowable. */
export const OCCURRENCES_PER_YEAR: Record<RecurrenceCadence, number | null> = {
  daily: 365, weekly: 52, biweekly: 26, monthly: 12,
  quarterly: 4, semiannual: 2, yearly: 1, per_installment: null,
};

/**
 * A recurring commitment found in a document.
 *
 * THE TRAP THIS SHAPE EXISTS TO AVOID: annual cost is not annual payment. A
 * $2,400/year policy paid at $200/month is ONE obligation with two true
 * numbers — a $200 cash obligation every month and a $2,400 annual total. Both
 * are useful; adding them together is nonsense. Keeping them in named fields,
 * plus `stated` recording which one the page actually printed, is what lets the
 * planner emit the right figure per surface and lets rule 16 (never invent)
 * be checked: a page that printed only an annual total must not sprout a
 * monthly payment schedule.
 */
export interface RecurrencePattern {
  id: string;
  /** Facts that established this pattern — the relationship, made explicit. */
  factIds: string[];
  label: string;
  /** What this recurrence is FOR (entity ref). */
  subjectRef?: string;
  cadence: RecurrenceCadence;
  /** The cash obligation per occurrence. */
  amountPerOccurrence?: number;
  /** The annualized total. */
  annualizedTotal?: number;
  nextOccurrence?: string;
  endsOn?: string;
  /** Which figure the document actually stated. Guards against fabrication. */
  stated: "per_occurrence" | "annual" | "both";
  confidence: number;
}

const STATED_SET: ReadonlySet<string> = new Set(["per_occurrence", "annual", "both"]);

// ─── Narrative ───────────────────────────────────────────────────────────────

export interface SemanticNarrative {
  title: string;
  body: string;
  /** Entity ref this prose is about, when it is about one. */
  subjectRef?: string;
}

// ─── The envelope ────────────────────────────────────────────────────────────

export interface SemanticDocument {
  /** Free-form, in the document's own terms. Deliberately NOT an enum. */
  documentType: string;
  /** Entity ref of what the document is chiefly about. */
  primarySubject?: string;
  entities: SemanticEntity[];
  relationships: SemanticRelationship[];
  facts: SemanticFact[];
  recurrences: RecurrencePattern[];
  narrative: SemanticNarrative[];
  confidence: number;
  summary: string;
}

/** An empty, valid envelope — what a failed reasoning pass degrades to. */
export function emptySemanticDocument(documentType = "", summary = ""): SemanticDocument {
  return {
    documentType, primarySubject: undefined, entities: [], relationships: [],
    facts: [], recurrences: [], narrative: [], confidence: 0, summary,
  };
}

/** True when the envelope carries nothing worth planning from. */
export function isEmptySemanticDocument(doc: SemanticDocument | null | undefined): boolean {
  if (!doc) return true;
  return doc.facts.length === 0 && doc.recurrences.length === 0 && doc.narrative.length === 0;
}

// ─── Confidence tiers ────────────────────────────────────────────────────────

/**
 * Confidence controls automation, it does not control whether we keep the data.
 *
 *   high   — propose the action, ticked.
 *   medium — propose the action, ticked, and VISIBLY flagged for review.
 *   low    — keep the value, invent no destination: ask what it represents.
 *
 * "I found this, but I'm not confident what it represents" is a valid answer
 * and a better one than a confident guess.
 */
export type ConfidenceTier = "high" | "medium" | "low";

export const CONFIDENCE_HIGH = 0.85;
export const CONFIDENCE_MEDIUM = 0.55;

export function confidenceTier(c: number | null | undefined): ConfidenceTier {
  const n = typeof c === "number" && isFinite(c) ? c : 0;
  if (n >= CONFIDENCE_HIGH) return "high";
  if (n >= CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * What a validation pass threw away, so a failure is visible in logs and tests
 * instead of looking like a document that simply had nothing in it.
 */
export interface ValidationReport {
  ok: boolean;
  droppedEntities: string[];
  droppedFacts: string[];
  droppedRelationships: string[];
  droppedRecurrences: string[];
  reasons: string[];
}

export interface ValidateOptions {
  /**
   * The ids of the raw extraction rows that actually exist. Every fact must cite
   * at least one of them. Omit to skip the check (used by fixture tests that
   * carry no raw rows).
   */
  knownItemIds?: ReadonlySet<string>;
  /** Ceiling for any monetary figure. Defaults to the shared transaction cap. */
  maxAmount?: number;
}

const clampConfidence = (v: unknown): number => {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim();

/**
 * Decide whether a reasoner's answer may be trusted, and return only the part
 * that may.
 *
 * The contract is DROP, NEVER REPAIR. A fact citing an entity that was never
 * declared is not evidence of a near-miss to be patched up — it is evidence the
 * reasoner was writing fiction about that fact, and keeping it would put a
 * fabricated subject on a real write. Same for a fact citing an extraction row
 * that does not exist, a relationship pointing at nothing, or a cadence outside
 * the closed set.
 *
 * Everything that survives is structurally sound: refs resolve, enums are in
 * range, numbers are finite and bounded, confidences are 0..1.
 */
export function validateSemanticDocument(
  raw: unknown,
  opts: ValidateOptions = {},
): { doc: SemanticDocument; report: ValidationReport } {
  const report: ValidationReport = {
    ok: true, droppedEntities: [], droppedFacts: [],
    droppedRelationships: [], droppedRecurrences: [], reasons: [],
  };
  const fail = (reason: string) => { report.ok = false; report.reasons.push(reason); };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("envelope is not an object");
    return { doc: emptySemanticDocument(), report };
  }
  const src = raw as Record<string, any>;
  const maxAmount = opts.maxAmount ?? MAX_TRANSACTION_AMOUNT;

  // ── Entities first: everything else refers to them ──
  const entities: SemanticEntity[] = [];
  const entityRefs = new Set<string>();
  for (const e of Array.isArray(src.entities) ? src.entities : []) {
    const ref = str(e?.ref);
    const name = str(e?.name);
    const kind = str(e?.kind);
    if (!ref || entityRefs.has(ref)) {
      report.droppedEntities.push(ref || "(no ref)");
      fail(`entity "${ref || "(no ref)"}": missing or duplicate ref`);
      continue;
    }
    if (!ENTITY_KIND_SET.has(kind)) {
      report.droppedEntities.push(ref);
      fail(`entity "${ref}": unknown kind "${kind}"`);
      continue;
    }
    if (!name) {
      report.droppedEntities.push(ref);
      fail(`entity "${ref}": no name`);
      continue;
    }
    const identifiers: Record<string, string> = {};
    if (e?.identifiers && typeof e.identifiers === "object" && !Array.isArray(e.identifiers)) {
      for (const [k, v] of Object.entries(e.identifiers as Record<string, unknown>)) {
        const key = str(k), val = str(v);
        if (key && val) identifiers[key] = val;
      }
    }
    entityRefs.add(ref);
    entities.push({
      ref, kind: kind as SemanticEntityKind, name, identifiers,
      role: str(e?.role) || undefined,
      confidence: clampConfidence(e?.confidence),
    });
  }

  // ── Facts ──
  const facts: SemanticFact[] = [];
  const factIds = new Set<string>();
  for (const f of Array.isArray(src.facts) ? src.facts : []) {
    const id = str(f?.id);
    if (!id || factIds.has(id)) {
      report.droppedFacts.push(id || "(no id)");
      fail(`fact "${id || "(no id)"}": missing or duplicate id`);
      continue;
    }
    const roles = (Array.isArray(f?.roles) ? f.roles : [])
      .map(str).filter((r: string) => ROLE_SET.has(r)) as SemanticRole[];
    if (roles.length === 0) {
      report.droppedFacts.push(id);
      fail(`fact "${id}": no recognised role`);
      continue;
    }
    const subjectRef = str(f?.subject?.entityRef);
    if (!entityRefs.has(subjectRef)) {
      // Rule 2: every fact has a subject. A dangling one is fiction, not a
      // near-miss — dropping it is what keeps a fabricated subject off a write.
      report.droppedFacts.push(id);
      fail(`fact "${id}": subject "${subjectRef}" is not a declared entity`);
      continue;
    }
    const itemIds = (Array.isArray(f?.itemIds) ? f.itemIds : []).map(str).filter(Boolean);
    if (opts.knownItemIds) {
      const known = itemIds.filter((i: string) => opts.knownItemIds!.has(i));
      if (known.length === 0) {
        report.droppedFacts.push(id);
        fail(`fact "${id}": cites no extraction row that exists`);
        continue;
      }
      itemIds.length = 0;
      itemIds.push(...known);
    }
    const volatility = str(f?.volatility);
    if (!VOLATILITY_SET.has(volatility)) {
      report.droppedFacts.push(id);
      fail(`fact "${id}": unknown volatility "${volatility}"`);
      continue;
    }
    // A financial fact's value must be a real, bounded number.
    let value = f?.value;
    if (roles.includes("financial") && typeof value !== "string") {
      const n = Number(value);
      if (!isFinite(n) || Math.abs(n) > maxAmount) {
        report.droppedFacts.push(id);
        fail(`fact "${id}": financial value out of range`);
        continue;
      }
      value = n;
    }

    // What KIND of money. An unrecognised kind is dropped rather than defaulted:
    // defaulting to "charge" is how a loan payment becomes an expense and the
    // month's outgoings double. With no kind at all the planner asks instead.
    const rawKind = str(f?.financialKind);
    let financialKind: FinancialKind | undefined;
    if (rawKind) {
      if (!FINANCIAL_KIND_SET.has(rawKind)) {
        fail(`fact "${id}": unknown financialKind "${rawKind}" — dropped, will be asked about`);
      } else {
        financialKind = rawKind as FinancialKind;
      }
    }

    // A status the app does not model cannot be applied to a record.
    const rawStatus = str(f?.status);
    let status: StatusValue | undefined;
    if (rawStatus) {
      if (!STATUS_VALUE_SET.has(rawStatus)) {
        fail(`fact "${id}": unknown status "${rawStatus}"`);
      } else {
        status = rawStatus as StatusValue;
      }
    }
    if (roles.includes("status_change") && !status) {
      // A status change that names no status says nothing actionable.
      report.droppedFacts.push(id);
      fail(`fact "${id}": status_change with no recognised status`);
      continue;
    }

    // A lead time must be a sane number of days. A "remind me 4000 days early"
    // is not a preference, it is a parse failure.
    const rawLead = Number(f?.reminderDaysBefore);
    const reminderDaysBefore =
      isFinite(rawLead) && rawLead >= 0 && rawLead <= 365 ? Math.round(rawLead) : undefined;
    let derivedFrom: SemanticFact["derivedFrom"];
    if (f?.derivedFrom && typeof f.derivedFrom === "object") {
      const from = (Array.isArray(f.derivedFrom.factIds) ? f.derivedFrom.factIds : []).map(str).filter(Boolean);
      const formula = str(f.derivedFrom.formula);
      if (from.length > 0 && formula) derivedFrom = { factIds: from, formula };
    }
    factIds.add(id);
    facts.push({
      id, itemIds, label: str(f?.label) || id, value, roles,
      subject: { entityRef: subjectRef, confidence: clampConfidence(f?.subject?.confidence) },
      volatility: volatility as FactVolatility,
      unit: str(f?.unit) || undefined,
      date: str(f?.date) || undefined,
      financialKind,
      status,
      reminderDaysBefore,
      confidence: clampConfidence(f?.confidence),
      derivedFrom,
    });
  }

  // Derived facts may only cite facts that survived. A derivation resting on a
  // dropped fact is a formula over nothing.
  for (let i = facts.length - 1; i >= 0; i--) {
    const d = facts[i].derivedFrom;
    if (!d) continue;
    if (d.factIds.some((fid) => !factIds.has(fid))) {
      fail(`fact "${facts[i].id}": derived from a fact that did not survive`);
      report.droppedFacts.push(facts[i].id);
      factIds.delete(facts[i].id);
      facts.splice(i, 1);
    }
  }

  // ── Relationships ──
  const relationships: SemanticRelationship[] = [];
  for (const r of Array.isArray(src.relationships) ? src.relationships : []) {
    const from = str(r?.from), to = str(r?.to), type = str(r?.type);
    if (!entityRefs.has(from) || !entityRefs.has(to)) {
      report.droppedRelationships.push(`${from}→${to}`);
      fail(`relationship "${from}→${to}": endpoint is not a declared entity`);
      continue;
    }
    if (!RELATIONSHIP_SET.has(type)) {
      report.droppedRelationships.push(`${from}→${to}`);
      fail(`relationship "${from}→${to}": unknown type "${type}"`);
      continue;
    }
    if (from === to) {
      report.droppedRelationships.push(`${from}→${to}`);
      fail(`relationship "${from}→${to}": an entity cannot relate to itself`);
      continue;
    }
    relationships.push({
      from, to, type: type as SemanticRelationshipType,
      confidence: clampConfidence(r?.confidence),
    });
  }

  // ── Recurrences ──
  const recurrences: RecurrencePattern[] = [];
  const recurrenceIds = new Set<string>();
  for (const p of Array.isArray(src.recurrences) ? src.recurrences : []) {
    const id = str(p?.id);
    const cadence = str(p?.cadence);
    if (!id || recurrenceIds.has(id)) {
      report.droppedRecurrences.push(id || "(no id)");
      fail(`recurrence "${id || "(no id)"}": missing or duplicate id`);
      continue;
    }
    if (!CADENCE_SET.has(cadence)) {
      report.droppedRecurrences.push(id);
      fail(`recurrence "${id}": unknown cadence "${cadence}"`);
      continue;
    }
    const stated = str(p?.stated);
    if (!STATED_SET.has(stated)) {
      report.droppedRecurrences.push(id);
      fail(`recurrence "${id}": unknown stated "${stated}"`);
      continue;
    }
    const cited = (Array.isArray(p?.factIds) ? p.factIds : []).map(str).filter((x: string) => factIds.has(x));
    if (cited.length === 0) {
      report.droppedRecurrences.push(id);
      fail(`recurrence "${id}": rests on no surviving fact`);
      continue;
    }
    const num = (v: unknown): number | undefined => {
      const n = Number(v);
      if (v === null || v === undefined || v === "" || !isFinite(n)) return undefined;
      if (n < 0 || n > maxAmount) return undefined;
      return n;
    };
    const perOccurrence = num(p?.amountPerOccurrence);
    const annual = num(p?.annualizedTotal);

    // RULE 16, ENFORCED: a page that stated only an annual figure cannot sprout
    // a per-occurrence payment schedule. Inference explains what is known; it
    // does not authorise fabrication. The annual total stays, the invented
    // instalment does not.
    const perOccurrenceKept = stated === "annual" ? undefined : perOccurrence;
    if (stated === "annual" && perOccurrence !== undefined) {
      fail(`recurrence "${id}": per-occurrence amount invented from an annual-only figure`);
    }
    // Symmetrically, an annual total from a per-occurrence page is fine, but it
    // is DERIVED — and must agree with the arithmetic, or it is a guess.
    let annualKept = annual;
    if (stated === "per_occurrence" && annual !== undefined && perOccurrenceKept !== undefined) {
      const per = OCCURRENCES_PER_YEAR[cadence as RecurrenceCadence];
      if (per !== null && Math.abs(annual - perOccurrenceKept * per) > Math.max(1, annual * 0.02)) {
        annualKept = undefined;
        fail(`recurrence "${id}": annual total does not match ${perOccurrenceKept} × ${per}`);
      }
    }
    if (perOccurrenceKept === undefined && annualKept === undefined) {
      report.droppedRecurrences.push(id);
      fail(`recurrence "${id}": no usable amount`);
      continue;
    }
    recurrenceIds.add(id);
    recurrences.push({
      id, factIds: cited, label: str(p?.label) || id,
      subjectRef: entityRefs.has(str(p?.subjectRef)) ? str(p.subjectRef) : undefined,
      cadence: cadence as RecurrenceCadence,
      amountPerOccurrence: perOccurrenceKept,
      annualizedTotal: annualKept,
      nextOccurrence: str(p?.nextOccurrence) || undefined,
      endsOn: str(p?.endsOn) || undefined,
      stated: stated as RecurrencePattern["stated"],
      confidence: clampConfidence(p?.confidence),
    });
  }

  // ── Narrative ──
  const narrative: SemanticNarrative[] = [];
  for (const n of Array.isArray(src.narrative) ? src.narrative : []) {
    const body = str(n?.body);
    if (!body) continue;
    narrative.push({
      title: str(n?.title) || "Note",
      body,
      subjectRef: entityRefs.has(str(n?.subjectRef)) ? str(n.subjectRef) : undefined,
    });
  }

  const primarySubject = entityRefs.has(str(src.primarySubject)) ? str(src.primarySubject) : undefined;
  if (str(src.primarySubject) && !primarySubject) {
    fail(`primarySubject "${str(src.primarySubject)}" is not a declared entity`);
  }

  return {
    doc: {
      documentType: str(src.documentType),
      primarySubject,
      entities, relationships, facts, recurrences, narrative,
      confidence: clampConfidence(src.confidence),
      summary: str(src.summary),
    },
    report,
  };
}

// ─── Reading helpers ─────────────────────────────────────────────────────────

/** The entity a ref names, or null. */
export function entityByRef(
  doc: SemanticDocument,
  ref: string | null | undefined,
): SemanticEntity | null {
  if (!ref) return null;
  return doc.entities.find((e) => e.ref === ref) ?? null;
}

/** Every fact whose subject is this entity. */
export function factsForEntity(doc: SemanticDocument, ref: string): SemanticFact[] {
  return doc.facts.filter((f) => f.subject.entityRef === ref);
}

/** Every fact carrying this role. */
export function factsWithRole(doc: SemanticDocument, role: SemanticRole): SemanticFact[] {
  return doc.facts.filter((f) => f.roles.includes(role));
}

/** The entity refs a document actually writes about, primary subject first. */
export function subjectRefs(doc: SemanticDocument): string[] {
  const out: string[] = [];
  if (doc.primarySubject) out.push(doc.primarySubject);
  for (const f of doc.facts) {
    const r = f.subject.entityRef;
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * The cash figure to show for a recurrence on a per-occurrence surface (a bill,
 * a calendar payment), and the annual figure for a cost surface — computed, so
 * no caller has to remember which one the document stated.
 *
 * Returns `derived: true` on whichever half had to be calculated, so the UI can
 * label it rather than passing arithmetic off as something the page printed.
 */
export function recurrenceAmounts(p: RecurrencePattern): {
  perOccurrence: number | null;
  annual: number | null;
  perOccurrenceDerived: boolean;
  annualDerived: boolean;
} {
  const per = OCCURRENCES_PER_YEAR[p.cadence];
  let perOccurrence = p.amountPerOccurrence ?? null;
  let annual = p.annualizedTotal ?? null;
  let perOccurrenceDerived = false;
  let annualDerived = false;

  if (annual === null && perOccurrence !== null && per !== null) {
    annual = Math.round(perOccurrence * per * 100) / 100;
    annualDerived = true;
  }
  // Only ever derive an instalment when the page gave us a cadence to divide by
  // AND did not state an annual-only figure — see rule 16 above.
  if (perOccurrence === null && annual !== null && per !== null && p.stated !== "annual") {
    perOccurrence = Math.round((annual / per) * 100) / 100;
    perOccurrenceDerived = true;
  }
  return { perOccurrence, annual, perOccurrenceDerived, annualDerived };
}
