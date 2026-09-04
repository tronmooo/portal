// ============================================================
// fact-lookup.ts — TIER 1: deterministic structured-fact retrieval
// ============================================================
// WHY THIS EXISTS (2026-09 performance audit):
//
//   "What is my license plate number?"  →  20-120 seconds.
//
// The value was a plain string sitting in a document's extracted_data the
// whole time. It was slow because EVERY chat message — including a one-field
// read — took the full agentic path:
//
//   getCachedContextData()  → 12 full-table reads
//   context assembly        → formats the entire account into ~40 KB of prose,
//                             plus N+1 link reads per liability
//   Anthropic round-trip    → ~160 KB of tool schema + ~90 KB system prompt
//   tool loop               → up to 15 sequential model round-trips,
//                             typically recall_memory → search_documents →
//                             get_document → answer
//
// shared/doc-field-lookup.ts ALREADY resolved these questions deterministically
// and in-process — but only to build a *prompt block*. The model still ran, so
// the deterministic answer paid the full agentic bill anyway.
//
// This module closes that loop. It is the Tier-1 resolver of the tiered
// retrieval strategy:
//
//   Tier 1  deterministic structured lookup   ← this file (no model, no I/O)
//   Tier 2  indexed / extracted-data scan     ← this file (no model, no I/O)
//   Tier 3  semantic retrieval                ← recall_memory / search_documents
//   Tier 4  reasoning / synthesis             ← the Claude tool loop
//
// It escalates rather than guesses. Every gate below is biased toward
// returning null: a miss costs the old (slow) path, a false hit costs the user
// a WRONG answer about their own records. Speed is never bought with accuracy.
//
// Pure, synchronous, dependency-free (beyond other shared/ modules) so it can
// run on already-loaded rows, be unit-tested without a database or API key,
// and be reused by the client, the server, and the tests alike.
// ============================================================

import {
  buildRecallTerms,
  recallMatchScore,
  normalizeForMatch,
  type RecallTerms,
} from "./recall-match";
import {
  detectDocFieldIntent,
  detectDocFieldIntentWithHistory,
  lookupDocField,
  type DocForLookup,
  type DocFieldLookupResult,
} from "./doc-field-lookup";
import { resolveAssetValue, resolveLiabilityBalance } from "./asset-value";

// ── Shapes ──────────────────────────────────────────────────────────────────

export type FactSourceKind =
  | "document_field"
  | "profile_field"
  | "tracker_latest"
  | "asset_value"
  | "liability_balance"
  | "liability_payment"
  | "liability_due";

/** What the question is asking for, beyond a plain named field. */
export type FactKind =
  | "field"          // a stored string/date: plate, VIN, policy number, birthday…
  | "asset_value"    // "what's my truck worth"
  | "liability_balance" // "how much do I owe on the mortgage"
  | "liability_payment" // "what's my car payment"
  | "due_date"       // "when is the internet bill due"
  | "tracker_latest";// "what's my latest weight"

export interface FactQuestion {
  kind: FactKind;
  /** Alias-expanded terms used for scoring stored field keys. */
  terms: RecallTerms;
  /** Human label for the thing asked about, used in the answer sentence. */
  fieldLabel: string;
  /** Name-ish tokens that should scope the answer to one entity/person. */
  subject: string[];
  /** The normalized message, carried so logs are self-contained. */
  norm: string;
}

export interface FactCandidate {
  source: FactSourceKind;
  /** The record the value came from ("2021 Honda CR-V", "Bob Smith", "Weight"). */
  entityName: string;
  entityId: string;
  /** Stored key path, e.g. "licensePlate" or "extractedData.plateNumber". */
  fieldKey: string;
  /** Display-ready value. */
  value: string;
  /** Higher is better. Used only to rank within a source. */
  score: number;
  /** Extractor confidence when the source recorded one (documents only). */
  confidence?: number;
}

export interface FactAnswer {
  /** The one-line answer, already formatted for the chat reply. */
  reply: string;
  /** The winning candidate. */
  candidate: FactCandidate;
  /** Every candidate considered, best first — carried for telemetry/debug. */
  considered: FactCandidate[];
  question: FactQuestion;
}

/** Why Tier 1 declined. Recorded so slow turns can be explained, not guessed at. */
export type FactMissReason =
  | "not_a_fact_question"   // shape/intent gate rejected it
  | "no_candidate"          // nothing stored matched
  | "ambiguous"             // several DIFFERENT values, no way to choose
  | "low_confidence";       // best hit was too weak to answer on

export interface FactLookupOutcome {
  answer: FactAnswer | null;
  missReason?: FactMissReason;
  /** Candidates found even when we declined — makes an escalation explainable. */
  considered: FactCandidate[];
  question: FactQuestion | null;
}

export interface FactProfile {
  id: string;
  name?: string | null;
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  fields?: Record<string, any> | null;
  linkedProfiles?: string[] | null;
}

export interface FactTracker {
  id: string;
  name?: string | null;
  category?: string | null;
  unit?: string | null;
  entries?: Array<{ date?: string | null; values?: Record<string, any> | null }> | null;
  linkedProfiles?: string[] | null;
}

export interface FactSources {
  profiles: FactProfile[];
  documents: DocForLookup[];
  trackers: FactTracker[];
}

// ── Gate 1: is this a pure READ of a stored fact? ───────────────────────────
//
// Anything that could write, could be conversational, or could need reasoning
// is rejected here and falls through to the existing agentic path unchanged.

/** Any hint of a mutation. A false positive here is free; a false negative
 *  would answer a write request with a read and silently drop the user's data. */
const MUTATION_SIGNAL =
  /\b(add|log|logged|create|new|update|edit|change|set|delete|remove|clear|rename|mark|complete|completed|finish|pay|paid|spend|spent|buy|bought|book|schedule|remind|snooze|start|stop|save|upload|attach|link|move|assign|split|merge|rename|import|export|send|share)\b/;

/** Reasoning/synthesis words — these genuinely need Tier 4. */
const REASONING_SIGNAL =
  /\b(why|should|recommend|suggest|advice|analy[sz]e|compare|summar|explain|plan|forecast|predict|trend|insight|help me|what if|better|worse|best|worst|average|total|sum|across|breakdown|vs|versus|between)\b/;

/** Read-shaped openings. A fact question looks like a question. */
const READ_SHAPE =
  /^(?:what(?:'|’)?s?|whats|when(?:'|’)?s?|whens|who(?:'|’)?s?|whos|where(?:'|’)?s?|wheres|which|how much|tell me|remind me|do you know|look up|lookup)\b/;

/** Plural/collection asks are list queries, not single-fact reads. */
const COLLECTION_SIGNAL =
  /\b(all|every|list|each|show me all|how many)\b/;

/** Words that mean "the number/value of", stripped before subject extraction. */
const FIELD_NOISE = new Set([
  "what", "whats", "when", "whens", "who", "whos", "where", "wheres", "which",
  "how", "much", "many", "is", "are", "was", "were", "the", "a", "an", "my",
  "our", "his", "her", "their", "its", "of", "for", "on", "in", "at", "to",
  "do", "does", "did", "you", "know", "tell", "me", "remind", "again", "s",
  "number", "no", "num", "value", "amount", "date", "please", "look", "up",
  "lookup", "again", "currently", "current", "latest", "last", "most", "recent",
]);

const MAX_WORDS = 14;

/**
 * Detect a single-fact read question. Returns null for anything else —
 * mutations, multi-clause messages, list queries, reasoning, and small talk.
 */
export function detectFactQuestion(
  message: string,
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>,
): FactQuestion | null {
  const raw = String(message ?? "").trim();
  if (!raw) return null;

  const norm = normalizeForMatch(raw);
  if (!norm) return null;

  const words = norm.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return null;

  // Multi-clause messages ("what's my plate and log a coffee") are never Tier 1.
  if (/\b(and|then|also|plus)\b/.test(norm) && MUTATION_SIGNAL.test(norm)) return null;
  if (MUTATION_SIGNAL.test(norm)) return null;
  if (REASONING_SIGNAL.test(norm)) return null;
  if (COLLECTION_SIGNAL.test(norm)) return null;
  if (!READ_SHAPE.test(norm)) return null;

  const terms = buildRecallTerms(raw);
  if (terms.isEmpty) return null;

  const kind = detectFactKind(norm);

  // A bare "what's my balance" with no subject is an aggregate question, not a
  // single-record read — the dashboard owns that, and Tier 4 phrases it.
  const subject = extractSubject(words);

  return {
    kind,
    terms,
    fieldLabel: buildFieldLabel(norm, kind),
    subject,
    norm,
  };
}

function detectFactKind(norm: string): FactKind {
  if (/\b(worth|value|valued|valuation|apprais\w*)\b/.test(norm)) return "asset_value";
  if (/\b(owe|owed|balance|payoff|remaining|principal)\b/.test(norm)) return "liability_balance";
  if (/\b(payment|monthly payment|installment|premium|bill amount|cost per month)\b/.test(norm)) return "liability_payment";
  if (/\b(due|due date|next payment|when.*due)\b/.test(norm)) return "due_date";
  if (/\b(latest|last|current|most recent)\b/.test(norm) && /\b(weight|reading|entry|value|level|bp|blood pressure|glucose|steps|sleep|mood)\b/.test(norm)) return "tracker_latest";
  return "field";
}

/** Name-ish tokens: the words left after the field vocabulary is removed. */
function extractSubject(words: string[]): string[] {
  return words.filter((w) => w.length >= 2 && !FIELD_NOISE.has(w));
}

function buildFieldLabel(norm: string, kind: FactKind): string {
  switch (kind) {
    case "asset_value": return "value";
    case "liability_balance": return "balance";
    case "liability_payment": return "monthly payment";
    case "due_date": return "due date";
    case "tracker_latest": return "latest entry";
    default: {
      // Use the meaningful tail of the question as the label ("license plate").
      const tail = norm.replace(READ_SHAPE, "").replace(/^\s*(?:is|are|was|were)?\s*(?:my|the|our|a|an)?\s*/, "").trim();
      return tail || "value";
    }
  }
}

// ── Gate 2: resolve, from cheapest and most authoritative source outward ────

/** A value must look like a real stored fact, not a placeholder. */
function usableValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return null; // nested objects are not single facts
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 200) return null; // prose, not a field
  const lower = s.toLowerCase();
  if (["n/a", "na", "none", "unknown", "null", "undefined", "-", "--", "tbd", "not set", "not provided"].includes(lower)) return null;
  return s;
}

/** Scores below this are noise — never answered on. */
const MIN_FIELD_SCORE = 6;
/** A winner must beat the runner-up (with a DIFFERENT value) by this much. */
const DECISIVE_MARGIN = 4;

/**
 * Tier 1 + Tier 2 resolution over already-loaded rows. Pure and synchronous.
 *
 * Order of authority:
 *   1. Type-scoped document extraction (shared/doc-field-lookup) — the strictest
 *      matcher we have, and the one that already knows a registration's
 *      "License Number" is a plate, not a driver's-license number.
 *   2. Structured profile fields — the user's own hand-entered canonical values.
 *   3. Typed record values — asset value, liability balance/payment/due date.
 *   4. Latest tracker entry.
 *
 * Returns an outcome, never throws. `answer: null` means "escalate", and
 * `missReason` says why, so a slow turn can be explained rather than guessed at.
 */
export function resolveFact(
  question: FactQuestion,
  sources: FactSources,
  opts?: { conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>; originalMessage?: string },
): FactLookupOutcome {
  const considered: FactCandidate[] = [];

  // ── 1. Documents, type-scoped ────────────────────────────────────────────
  const docCandidates = collectDocumentCandidates(question, sources.documents, opts);
  considered.push(...docCandidates);

  // ── 2. Profile structured fields ─────────────────────────────────────────
  considered.push(...collectProfileFieldCandidates(question, sources.profiles));

  // ── 3. Typed record values ───────────────────────────────────────────────
  considered.push(...collectTypedValueCandidates(question, sources.profiles));

  // ── 4. Latest tracker entry ──────────────────────────────────────────────
  considered.push(...collectTrackerCandidates(question, sources.trackers));

  considered.sort((a, b) => b.score - a.score);

  if (considered.length === 0) {
    return { answer: null, missReason: "no_candidate", considered, question };
  }

  const best = considered[0];
  if (best.score < MIN_FIELD_SCORE) {
    return { answer: null, missReason: "low_confidence", considered, question };
  }

  // Ambiguity gate — the single most important guard in this module.
  //
  // Two people's birthdays, two vehicles' plates, the same field on three
  // documents. If the runner-up holds a DIFFERENT value and is close in score,
  // we cannot pick without guessing, so we escalate and let Tier 4 ask.
  // Identical values from several sources are corroboration, not ambiguity.
  const bestVal = normalizeForMatch(best.value);
  const rival = considered.find((c) => normalizeForMatch(c.value) !== bestVal);
  if (rival && best.score - rival.score < DECISIVE_MARGIN) {
    return { answer: null, missReason: "ambiguous", considered, question };
  }

  return {
    answer: {
      reply: renderFactReply(question, best, considered),
      candidate: best,
      considered,
      question,
    },
    considered,
    question,
  };
}

// ── Source collectors ───────────────────────────────────────────────────────

function collectDocumentCandidates(
  question: FactQuestion,
  documents: DocForLookup[],
  opts?: { conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>; originalMessage?: string },
): FactCandidate[] {
  if (!documents || documents.length === 0) return [];
  const message = opts?.originalMessage ?? question.norm;

  // Reuse the strict, type-scoped detector. It is the module that already
  // knows plate ≠ driver's-license number, so nothing here re-derives that.
  const detected =
    detectDocFieldIntentWithHistory(message, opts?.conversationHistory) ||
    (detectDocFieldIntent(message) ? { intent: detectDocFieldIntent(message)!, fromHistory: false } : null);
  if (!detected) return [];

  let lookup: DocFieldLookupResult;
  try {
    lookup = lookupDocField(documents, detected.intent);
  } catch {
    return [];
  }
  if (lookup.status !== "found") return [];

  return lookup.matches
    .map((m): FactCandidate | null => {
      const value = usableValue(m.value);
      if (!value) return null;
      // A structured extracted field is the strongest evidence we have.
      // OCR/summary hits are real but weaker, and an OCR CONFLICT means the
      // extractor and the page disagree — never answer Tier 1 on that.
      if (m.verification === "ocr_conflict") return null;
      const base = m.source === "structured" ? 14 : m.source === "ocr" ? 10 : 8;
      const confPenalty = m.confidence !== undefined && m.confidence < 0.7 ? 3 : 0;
      return {
        source: "document_field",
        entityName: m.docName,
        entityId: m.docId,
        fieldKey: m.fieldKey,
        value,
        score: base - confPenalty,
        confidence: m.confidence,
      };
    })
    .filter((c): c is FactCandidate => c !== null);
}

function collectProfileFieldCandidates(question: FactQuestion, profiles: FactProfile[]): FactCandidate[] {
  if (question.kind !== "field") return [];
  const out: FactCandidate[] = [];
  for (const p of profiles || []) {
    const name = String(p?.name || "").trim();
    const fields = p?.fields || {};
    if (!fields || typeof fields !== "object") continue;
    const subjectBonus = subjectMatchBonus(question.subject, name);
    // A named subject that matches NO profile name must not silently answer
    // from a different profile — that is the "whose plate is this?" bug class.
    if (question.subject.length > 0 && subjectBonus === 0 && namesAnyProfile(question.subject, profiles)) continue;

    for (const [key, raw] of Object.entries(fields)) {
      if (key.startsWith("_")) continue;
      const value = usableValue(raw);
      if (!value) continue;
      const score = recallMatchScore(question.terms, key, raw);
      if (score < MIN_FIELD_SCORE) continue;
      out.push({
        source: "profile_field",
        entityName: name || "profile",
        entityId: String(p.id),
        fieldKey: key,
        value,
        // Hand-entered profile fields are canonical, so they outrank a
        // same-strength document hit.
        score: score + 4 + subjectBonus,
      });
    }
  }
  return out;
}

function collectTypedValueCandidates(question: FactQuestion, profiles: FactProfile[]): FactCandidate[] {
  const k = question.kind;
  if (k !== "asset_value" && k !== "liability_balance" && k !== "liability_payment" && k !== "due_date") return [];

  const out: FactCandidate[] = [];
  for (const p of profiles || []) {
    const name = String(p?.name || "").trim();
    if (!name) continue;
    const subjectBonus = subjectMatchBonus(question.subject, name);
    // These questions are always ABOUT a named thing ("what's the truck worth").
    // Without a name match there is nothing to scope to, so escalate.
    if (subjectBonus === 0) continue;
    const fields = (p?.fields || {}) as Record<string, any>;

    if (k === "asset_value") {
      const n = resolveAssetValue(p);
      if (Number.isFinite(n) && n > 0) {
        out.push({ source: "asset_value", entityName: name, entityId: String(p.id), fieldKey: "value", value: formatMoney(n), score: 12 + subjectBonus });
      }
    } else if (k === "liability_balance") {
      const n = resolveLiabilityBalance(p);
      if (Number.isFinite(n) && n > 0) {
        out.push({ source: "liability_balance", entityName: name, entityId: String(p.id), fieldKey: "balance", value: formatMoney(n), score: 12 + subjectBonus });
      }
    } else if (k === "liability_payment") {
      const v = usableValue(fields.monthlyPayment ?? fields.monthlyAmount ?? fields.amount ?? fields.monthlyCost);
      if (v) {
        const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
        out.push({ source: "liability_payment", entityName: name, entityId: String(p.id), fieldKey: "monthlyPayment", value: Number.isFinite(n) ? formatMoney(n) : v, score: 12 + subjectBonus });
      }
    } else if (k === "due_date") {
      const v = usableValue(fields.dueDate ?? fields.nextDueDate ?? fields.due_date ?? fields.dueDay);
      if (v) {
        out.push({ source: "liability_due", entityName: name, entityId: String(p.id), fieldKey: "dueDate", value: v, score: 12 + subjectBonus });
      }
    }
  }
  return out;
}

function collectTrackerCandidates(question: FactQuestion, trackers: FactTracker[]): FactCandidate[] {
  if (question.kind !== "tracker_latest") return [];
  const out: FactCandidate[] = [];
  for (const t of trackers || []) {
    const name = String(t?.name || "").trim();
    if (!name) continue;
    const entries = Array.isArray(t.entries) ? t.entries : [];
    if (entries.length === 0) continue;
    // Name OR category must be named in the question — a bare "what's my
    // latest reading" has no tracker to point at.
    const nameScore = recallMatchScore(question.terms, name, t.category || "");
    const subjectBonus = subjectMatchBonus(question.subject, name);
    if (nameScore < MIN_FIELD_SCORE && subjectBonus === 0) continue;

    const last = entries[entries.length - 1];
    const values = last?.values || {};
    const parts = Object.entries(values)
      .filter(([k, v]) => !k.startsWith("_") && usableValue(v))
      .map(([k, v]) => `${k}: ${usableValue(v)}`);
    if (parts.length === 0) continue;
    out.push({
      source: "tracker_latest",
      entityName: name,
      entityId: String(t.id),
      fieldKey: "latest",
      value: parts.join(", ") + (last?.date ? ` (${String(last.date).slice(0, 10)})` : ""),
      score: Math.max(nameScore, 8) + subjectBonus,
    });
  }
  return out;
}

// ── Subject scoping ─────────────────────────────────────────────────────────

/** Does any subject token appear in this record's name? */
function subjectMatchBonus(subject: string[], name: string): number {
  if (!subject || subject.length === 0) return 0;
  const n = normalizeForMatch(name);
  if (!n) return 0;
  const nameWords = new Set(n.split(" ").filter(Boolean));
  let hits = 0;
  for (const s of subject) {
    if (nameWords.has(s) || (s.length >= 4 && n.includes(s))) hits++;
  }
  return hits > 0 ? 3 + hits * 2 : 0;
}

/** Do the subject tokens name SOME profile? If so, an unmatched profile is
 *  the wrong one and must not answer. If they name none, they were probably
 *  field vocabulary, not a name, and scoping would wrongly suppress the hit. */
function namesAnyProfile(subject: string[], profiles: FactProfile[]): boolean {
  return (profiles || []).some((p) => subjectMatchBonus(subject, String(p?.name || "")) > 0);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function formatMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The reply. Deliberately short, always says WHERE the value came from, and
 * never claims more certainty than the source supports — an unverified
 * low-confidence extraction says so rather than reading as a settled fact.
 */
export function renderFactReply(question: FactQuestion, best: FactCandidate, considered: FactCandidate[]): string {
  const label = humanFieldKey(best.fieldKey, question);
  const where =
    best.source === "document_field" ? `from ${best.entityName}`
    : best.source === "profile_field" ? `on ${best.entityName}`
    : best.source === "tracker_latest" ? `— latest ${best.entityName} entry`
    : `on ${best.entityName}`;

  const corroborated = considered.filter(
    (c) => c !== best && normalizeForMatch(c.value) === normalizeForMatch(best.value),
  ).length;

  const caveat =
    best.confidence !== undefined && best.confidence < 0.7
      ? " (read from a low-confidence extraction — worth double-checking against the document)"
      : "";

  const also = corroborated > 0 ? ` It matches ${corroborated} other record${corroborated > 1 ? "s" : ""}.` : "";

  return `Your ${label} is **${best.value}** ${where}.${also}${caveat}`;
}

function humanFieldKey(key: string, question: FactQuestion): string {
  switch (question.kind) {
    case "asset_value": return "current value";
    case "liability_balance": return "balance";
    case "liability_payment": return "monthly payment";
    case "due_date": return "due date";
    case "tracker_latest": return "latest entry";
    default: {
      const n = normalizeForMatch(key);
      return n || question.fieldLabel;
    }
  }
}

// ── One-call entry point ────────────────────────────────────────────────────

/**
 * Detect + resolve in one call. This is what the chat engine uses.
 * Returns `{ answer: null }` for anything that is not an unambiguous,
 * high-confidence single-fact read — the caller then runs the normal pipeline.
 */
export function lookupStoredFact(
  message: string,
  sources: FactSources,
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>,
): FactLookupOutcome {
  const question = detectFactQuestion(message, conversationHistory);
  if (!question) return { answer: null, missReason: "not_a_fact_question", considered: [], question: null };
  return resolveFact(question, sources, { conversationHistory, originalMessage: message });
}
