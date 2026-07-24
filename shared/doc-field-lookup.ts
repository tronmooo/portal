// ============================================================
// doc-field-lookup.ts — deterministic, type-scoped document field retrieval
// ============================================================
// WHY (2026-07 report): "What is my driver's license number?" was answered
// with the vehicle's license PLATE. Root cause: retrieval treated every
// document's extracted fields as one flat pool, and on a vehicle registration
// the plate is literally printed as "License Number" — a lookalike label from
// the WRONG document type that outranked the actual driver's license.
//
// THE RULE THIS IMPLEMENTS (for document-specific questions):
//   1. Detect the DOCUMENT TYPE + FIELD being asked about (deterministic).
//   2. Read the structured extracted fields of documents of THAT TYPE first.
//   3. If the structured fields miss, scan the document's raw OCR text.
//   4. Only after both miss does the model fall back to broad search
//      (recall_memory / search_documents) — enforced by the prompt block
//      ai-engine builds from this module's result.
// Broad/semantic search is the LAST resort, never the first.
//
// Everything here is pure and synchronous so it can run on the already-loaded
// document list before the LLM sees anything (no extra I/O, nothing to cache).

import { normalizeForMatch } from "./recall-match";

export interface DocFieldIntent {
  /** Document-kind slug, e.g. "drivers_license". */
  docKind: string;
  /** Human label for the document, e.g. "driver's license". */
  docLabel: string;
  /** Field-kind slug, e.g. "number" | "expiration" | "dateOfBirth". */
  fieldKind: string;
  /** Human label for the field, e.g. "license number". */
  fieldLabel: string;
  /** Matches normalized extracted-field key paths. */
  keyMatch: RegExp;
  /** Rejects lookalike keys from the wrong concept (plate/vin/sticker…). */
  keyExclude?: RegExp;
}

export interface DocForLookup {
  id: string;
  name: string;
  type?: string | null;
  extractedData?: any;
  createdAt?: string | null;
  /** Resolved linked-profile names, for provenance in the answer. */
  ownerNames?: string[];
}

export interface DocFieldMatch {
  docId: string;
  docName: string;
  docType: string;
  ownerNames: string[];
  fieldKey: string;
  value: string;
  /** "structured" = extracted field; "ocr" = scraped from raw OCR text. */
  source: "structured" | "ocr";
}

export interface DocFieldLookupResult {
  status: "found" | "field_missing" | "no_document";
  intent: DocFieldIntent;
  /** All hits, best document first (there may be one per owner). */
  matches: DocFieldMatch[];
  /** Documents of the right type that were checked (provenance for misses). */
  checkedDocs: Array<{ docId: string; docName: string; docType: string; ownerNames: string[] }>;
  totalDocs: number;
}

// ── Document kinds ───────────────────────────────────────────────────────────
// `mention` runs against the normalized user message ("driver's" → "driver s").
// `docMatch`/`docExclude` run against the normalized "<type> <name>" of a
// stored document ("drivers_license" → "drivers license").
interface DocKindSpec {
  kind: string;
  label: string;
  mention: RegExp;
  docMatch: RegExp;
  docExclude?: RegExp;
  numberField?: { label: string; keyMatch: RegExp; keyExclude?: RegExp };
  /** The mention itself names the value ("what's my license plate / ssn") —
   *  treat a bare mention as asking for the number field. */
  defaultToNumber?: boolean;
}

const DOC_KINDS: DocKindSpec[] = [
  {
    kind: "drivers_license",
    label: "driver's license",
    mention: /\b(?:driver s|drivers|driver) licen[cs]e\b|\bdl number\b|\bmy dl\b/,
    docMatch: /\bdriver s licen[cs]e\b|\bdrivers licen[cs]e\b|\bdriver licen[cs]e\b|\bdrivers licen[cs]e card\b/,
    docExclude: /\bregistration\b|\bplate\b/,
    numberField: {
      label: "license number",
      keyMatch: /licen[cs]e (?:number|no)\b|\bdl number\b|\bdl\b|driver s? (?:licen[cs]e )?number|document number|customer (?:id|number)|\bid number\b/,
      keyExclude: /plate|tag|sticker|vin\b|vehicle|registration|issue|expir/,
    },
  },
  {
    // The plate lives on the REGISTRATION (often printed as "License Number"),
    // so plate questions are scoped to registration/title docs — the mirror
    // image of the drivers-license rule above.
    kind: "license_plate",
    label: "license plate",
    mention: /\blicen[cs]e plates?\b|\bnumber plates?\b|\bplate number\b|\btag number\b|\bmy plates?\b/,
    docMatch: /\bregistration\b|\bplate\b|\btitle\b/,
    docExclude: /\bdriver/,
    numberField: {
      label: "plate number",
      keyMatch: /licen[cs]e plate|plate number|\bplate\b|licen[cs]e (?:number|no)\b|tag number/,
      keyExclude: /driver|vin\b|sticker|issue|expir/,
    },
    defaultToNumber: true,
  },
  {
    kind: "vehicle_registration",
    label: "vehicle registration",
    mention: /\b(?:vehicle |car |auto )?registration\b/,
    docMatch: /\bregistration\b/,
    docExclude: /\bdriver/,
    numberField: {
      label: "registration number",
      keyMatch: /registration (?:number|no)\b|licen[cs]e (?:number|no)\b|document number/,
      keyExclude: /driver|vin\b|sticker/,
    },
  },
  {
    kind: "passport",
    label: "passport",
    mention: /\bpassport\b/,
    docMatch: /\bpassport\b/,
    numberField: {
      label: "passport number",
      keyMatch: /passport (?:number|no)\b|document (?:number|no)\b/,
      keyExclude: /issue|expir/,
    },
  },
  {
    kind: "insurance",
    label: "insurance card/policy",
    mention: /\binsurance\b|\bpolicy number\b/,
    docMatch: /\binsurance\b|\bpolicy\b/,
    numberField: {
      label: "policy number",
      keyMatch: /policy (?:number|no)\b|\bpolicy\b|member (?:id|number)\b|group (?:number|no)\b/,
      keyExclude: /holder|issue|expir|premium/,
    },
  },
  {
    kind: "social_security",
    label: "social security card",
    mention: /\bsocial security\b|\bssn\b/,
    docMatch: /\bsocial security\b|\bssn\b/,
    numberField: {
      label: "social security number",
      keyMatch: /social security (?:number|no)\b|\bssn\b/,
    },
    defaultToNumber: true,
  },
  {
    kind: "birth_certificate",
    label: "birth certificate",
    mention: /\bbirth certificate\b/,
    docMatch: /\bbirth certificate\b/,
    numberField: {
      label: "certificate number",
      keyMatch: /certificate (?:number|no)\b|document (?:number|no)\b|registration (?:number|no)\b/,
    },
  },
  {
    kind: "vehicle_title",
    label: "vehicle title",
    mention: /\b(?:car|vehicle) title\b/,
    docMatch: /\btitle\b/,
    docExclude: /\bdriver/,
    numberField: {
      label: "title number",
      keyMatch: /title (?:number|no)\b|document (?:number|no)\b/,
    },
  },
];

// ── Generic (cross-document) field kinds ─────────────────────────────────────
interface FieldKindSpec {
  kind: string;
  label: string;
  mention: RegExp;
  keyMatch: RegExp;
  keyExclude?: RegExp;
}

const GENERIC_FIELDS: FieldKindSpec[] = [
  {
    kind: "expiration",
    label: "expiration date",
    mention: /\bexpir\w*\b|\bexpires?\b|\bvalid until\b|\brenew\w*\b/,
    keyMatch: /expir|valid until|renewal/,
  },
  {
    kind: "issueDate",
    label: "issue date",
    mention: /\bissued?\b.*\b(?:date|on|when)\b|\bwhen\b.*\bissued?\b|\bissue date\b/,
    keyMatch: /issue/,
    keyExclude: /expir/,
  },
  {
    kind: "dateOfBirth",
    label: "date of birth",
    mention: /\bdate of birth\b|\bdob\b|\bbirth ?date\b/,
    keyMatch: /date of birth|\bdob\b|birth ?date|birthday/,
  },
  {
    kind: "address",
    label: "address",
    mention: /\baddress\b/,
    keyMatch: /address/,
  },
  {
    kind: "fullName",
    label: "name on the document",
    mention: /\bname on\b|\bfull name\b/,
    keyMatch: /\bname\b/,
    keyExclude: /file ?name|nick ?name/,
  },
];

const NUMBER_MENTION = /\bnumber\b|\bnum\b/;

function buildIntent(dk: DocKindSpec, fieldKind: string): DocFieldIntent | null {
  if (fieldKind === "number") {
    if (!dk.numberField) return null;
    return {
      docKind: dk.kind, docLabel: dk.label, fieldKind: "number",
      fieldLabel: dk.numberField.label,
      keyMatch: dk.numberField.keyMatch, keyExclude: dk.numberField.keyExclude,
    };
  }
  const gf = GENERIC_FIELDS.find(f => f.kind === fieldKind);
  if (!gf) return null;
  return {
    docKind: dk.kind, docLabel: dk.label, fieldKind: gf.kind,
    fieldLabel: gf.label, keyMatch: gf.keyMatch, keyExclude: gf.keyExclude,
  };
}

// A mention preceded by a corrective/possessive-dismissal ("that's my license
// plate, I want my driver's license number") is the thing being RULED OUT,
// not asked for — prefer the non-negated kind.
const NEGATION_TAIL = /(?:\bthat s|\bthats|\bnot|\bisn t|\bis not|\bno)\s+(?:my |the |a |just )*$/;

/**
 * Deterministically detect a document-specific field question. Returns null
 * for anything that isn't clearly "field X from document-type Y".
 */
export function detectDocFieldIntent(message: string): DocFieldIntent | null {
  const norm = normalizeForMatch(message);
  if (!norm) return null;

  // Which document kinds does the message name — and where?
  const fired: Array<{ dk: DocKindSpec; index: number; negated: boolean }> = [];
  for (const dk of DOC_KINDS) {
    const m = dk.mention.exec(norm);
    if (!m) continue;
    const before = norm.slice(Math.max(0, m.index - 16), m.index);
    fired.push({ dk, index: m.index, negated: NEGATION_TAIL.test(before) });
  }
  if (fired.length === 0) return null;

  // Prefer a non-negated mention; among those, the one mentioned LAST (the
  // correction/clarification usually comes after the ruled-out term).
  fired.sort((a, b) => (Number(a.negated) - Number(b.negated)) || (b.index - a.index));
  const chosen = fired[0].dk;

  // Which field is being asked about?
  const gf = GENERIC_FIELDS.find(f => f.mention.test(norm));
  if (gf) return buildIntent(chosen, gf.kind);
  if (NUMBER_MENTION.test(norm)) return buildIntent(chosen, "number");
  if (chosen.defaultToNumber) return buildIntent(chosen, "number");
  return null;
}

// Follow-up detection: short corrections ("no, my DRIVER'S license") carry the
// intent themselves, but bare follow-ups ("so what is it then?") don't — pull
// the subject from the most recent user turn that had one, so the model never
// has to ask "what information are you referring to?".
const FOLLOWUP_SIGNAL = /\b(?:no|not|nope|wrong|actually|that s|thats|it|again|still|so|then|one more time|i (?:said|meant|mean|want|asked))\b/;

export function detectDocFieldIntentWithHistory(
  message: string,
  history?: Array<{ role: string; content: string }>,
): { intent: DocFieldIntent; fromHistory: boolean } | null {
  const direct = detectDocFieldIntent(message);
  if (direct) return { intent: direct, fromHistory: false };
  if (!history || history.length === 0) return null;
  const norm = normalizeForMatch(message);
  if (!norm || !FOLLOWUP_SIGNAL.test(norm)) return null;
  const recentUserTurns = history
    .filter(m => m && m.role === "user" && typeof m.content === "string")
    .slice(-3)
    .reverse();
  for (const t of recentUserTurns) {
    const past = detectDocFieldIntent(t.content);
    if (past) return { intent: past, fromHistory: true };
  }
  return null;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

const MAX_VALUE_LEN = 160;

function isScalar(v: any): v is string | number | boolean {
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean";
}

// Walk extractedData depth-first, emitting (dotted key path, scalar value)
// pairs. Unwraps `{ value: x }` leaves (extractor output shape) and skips
// private keys and the raw OCR blob (scanned separately, as the fallback).
function collectFields(extracted: any): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const walk = (obj: any, path: string[]) => {
    if (obj === null || obj === undefined) return;
    if (isScalar(obj)) {
      const s = String(obj).trim();
      if (s && s.length <= 2000) out.push({ key: path.join("."), value: s });
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (typeof obj === "object") {
      if (isScalar((obj as any).value) && Object.keys(obj).length <= 3) {
        walk((obj as any).value, path);
        return;
      }
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("_") || k === "rawText") continue;
        walk(v, [...path, k]);
      }
    }
  };
  walk(extracted, []);
  return out;
}

function fieldMatches(intent: DocFieldIntent, keyPath: string): boolean {
  const norm = normalizeForMatch(keyPath);
  if (!intent.keyMatch.test(norm)) return false;
  if (intent.keyExclude && intent.keyExclude.test(norm)) return false;
  return true;
}

// OCR fallback: find a "<label>: <value>" line in the raw text whose label
// matches the intent. Deliberately conservative — a labeled line only, never
// a bare value guess.
function scanRawText(intent: DocFieldIntent, raw: string): { key: string; value: string } | null {
  const lines = String(raw).split(/\r?\n/, 400);
  for (const line of lines) {
    const sep = line.search(/[:#]/);
    if (sep <= 0) continue;
    const label = normalizeForMatch(line.slice(0, sep));
    if (!label || !intent.keyMatch.test(label)) continue;
    if (intent.keyExclude && intent.keyExclude.test(label)) continue;
    const value = line.slice(sep + 1).trim();
    if (value && value.length >= 2 && value.length <= MAX_VALUE_LEN) {
      return { key: `${line.slice(0, sep).trim()} (OCR)`, value };
    }
  }
  return null;
}

/**
 * Structured-fields-first lookup, scoped to documents of the intent's type.
 * Order per matching document: extracted fields, then raw OCR text. Documents
 * of OTHER types are never consulted — that's the whole point.
 */
export function lookupDocField(docs: DocForLookup[], intent: DocFieldIntent): DocFieldLookupResult {
  const spec = DOC_KINDS.find(k => k.kind === intent.docKind);
  const candidates = docs
    .map(d => {
      const typeNorm = normalizeForMatch(d.type || "");
      const nameNorm = normalizeForMatch(d.name || "");
      const combined = `${typeNorm} ${nameNorm}`.trim();
      if (!spec) return null;
      if (!spec.docMatch.test(combined)) return null;
      if (spec.docExclude && spec.docExclude.test(combined)) return null;
      return { doc: d, typeMatch: spec.docMatch.test(typeNorm) };
    })
    .filter(Boolean) as Array<{ doc: DocForLookup; typeMatch: boolean }>;

  // Documents whose stored TYPE matches outrank name-only matches; newest first.
  candidates.sort((a, b) =>
    (Number(b.typeMatch) - Number(a.typeMatch)) ||
    (new Date(b.doc.createdAt || 0).getTime() - new Date(a.doc.createdAt || 0).getTime()));

  const checkedDocs = candidates.map(c => ({
    docId: c.doc.id, docName: c.doc.name, docType: c.doc.type || "document",
    ownerNames: c.doc.ownerNames || [],
  }));

  if (candidates.length === 0) {
    return { status: "no_document", intent, matches: [], checkedDocs, totalDocs: docs.length };
  }

  const matches: DocFieldMatch[] = [];
  for (const { doc } of candidates) {
    const fields = collectFields(doc.extractedData);
    const structured = fields.find(f => fieldMatches(intent, f.key) && f.value.length <= MAX_VALUE_LEN);
    if (structured) {
      matches.push({
        docId: doc.id, docName: doc.name, docType: doc.type || "document",
        ownerNames: doc.ownerNames || [],
        fieldKey: structured.key, value: structured.value, source: "structured",
      });
      continue;
    }
    const raw = doc.extractedData && typeof doc.extractedData === "object"
      ? (doc.extractedData as any).rawText : undefined;
    if (typeof raw === "string" && raw) {
      const ocr = scanRawText(intent, raw);
      if (ocr) {
        matches.push({
          docId: doc.id, docName: doc.name, docType: doc.type || "document",
          ownerNames: doc.ownerNames || [],
          fieldKey: ocr.key, value: ocr.value, source: "ocr",
        });
      }
    }
  }

  return {
    status: matches.length > 0 ? "found" : "field_missing",
    intent, matches, checkedDocs, totalDocs: docs.length,
  };
}
