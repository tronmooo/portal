// server/semantic-reasoner.ts — the "Understand" stage of document processing.
// =============================================================================
//
// Extraction reads values off a page. This reads MEANING off the same page, and
// it is the stage the pipeline was missing:
//
//   Document → Extract → [Understand → Identify Entities → Identify
//   Relationships → Classify Facts] → Infer Actions → Resolve Existing Records
//   → Validate → Present Review → Save
//                └──────────── this file ────────────┘
//
// It runs for EVERY document, not as a fallback for ones a table did not
// recognise. That is the whole design: there is no table. A boat club
// membership certificate and a homeowners declarations page go through the
// same call and come back described in the same vocabulary
// (shared/semantic-document.ts).
//
// WHAT THIS FILE MAY AND MAY NOT DO
//
// It may decide what a document means, who it is about, how the entities in it
// relate, which facts are permanent and which are measurements, what recurs,
// which dates matter, and what is implied by explicit evidence.
//
// It may NOT author a write. Its output is data, it passes through
// `validateSemanticDocument` before anyone looks at it, and every actual
// decision about records — resolution, dedupe, calendar gating, conflict
// handling — belongs to shared/extraction-actions.ts, which is deterministic
// and testable. A reasoner that could write would be a reasoner whose mistakes
// land in someone's finances.
//
// DEGRADATION IS A FEATURE. If the call fails, times out, or returns something
// that does not survive validation, `reasonAboutDocument` returns an empty
// envelope and the review falls back to per-field routing with a visible
// banner. An upload is never blocked by this stage.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import {
  validateSemanticDocument,
  emptySemanticDocument,
  type SemanticDocument,
  type ValidationReport,
} from "@shared/semantic-document";

const CAT = "semantic-reasoner";

/**
 * The questions the stage answers, written as questions rather than as a
 * schema of one document type.
 *
 * Every rule in here is stated in terms of MEANING, never in terms of field
 * names or document classes. "A date is actionable when it means due, expires,
 * renews…" works for an insurance expiration, a warranty expiration, a lease
 * end and a boat club membership expiry without naming any of them.
 */
const REASONER_PROMPT = `You have already read the raw values off this document. Now work out what it MEANS.

Do not classify fields one at a time. Reason about the document as a whole and about how its fields relate to each other. Meaning comes from fields TOGETHER:
- An amount plus a schedule plus a next-due date is one recurring commitment, not three facts.
- A measurement plus a unit plus a subject plus a date is a point in a time series.
- A counterparty name plus an account or loan number is a relationship to an existing record.
- An expiration date on a credential is a thing to be reminded about.

Answer these questions:

1. WHAT IS THIS DOCUMENT? Name it in its own terms. Do not pick from a list.
2. WHO OR WHAT IS IT ABOUT? A document may be about several things at once — a person, a property, a vehicle, a pet, an asset, a liability, an account.
3. WHAT ENTITIES ARE MENTIONED? People, companies, assets, accounts, providers, lenders, issuers. Include the ones that are only counterparties.
4. HOW ARE THEY RELATED? owns, owes, insures, insured_by, treats, prescribed, pays, covers, issued_by, financed_by, finances, employed_by, held_in, supports, beneficiary_of.
5. FOR EVERY FACT: what is it, who is it about, and what KIND of thing is it?

THIS DOCUMENT IS ALREADY FILED SOMEWHERE. The record it belongs to was chosen by a person before the upload and it ALREADY EXISTS. Never describe it as something new. If the page names it again — a loan statement repeating the loan's name, a policy repeating the address — that is the SAME record, not a second one. Your job is what the document IMPLIES about records that exist, never which records should exist.

ROLES — a fact may have several:
- profile_data: persistent information about a person.
- entity_data: an attribute of an asset, vehicle, property, liability, pet or account.
- measurement: a value that is meaningful across time (weight, balance, glucose, mileage, valuation).
- financial: a price, premium, balance, payment, income, fee, tax or value.
- recurring_obligation: part of something expected to happen repeatedly.
- actionable_date: a date that requires future awareness.
- relationship: it establishes a link between entities.
- narrative: meaningful unstructured prose worth keeping as a note.
- status_change: the document says an existing record's state is now something — paid, cancelled, renewed, approved, denied, expired, closed, suspended. Put that word in "status".
- event_occurred: the document is PROOF something already happened — a payment made, an inspection passed, a service performed, a claim filed.
- document_metadata: issuer, document number, form code, printing information.
- reference_only: useful, but must cause nothing.

MONEY — every financial fact MUST say what KIND of money it is, in "financialKind". An amount alone cannot be routed, and the wrong guess moves a number the user relies on:
- charge: a cost incurred — a purchase, repair, premium, service, tax, medical bill.
- payment: money paid out. Against a debt this reduces a balance; it is NOT a new expense.
- refund: money coming back. NOT income.
- credit: an account credit applied. NOT income.
- transfer: moved between the user's own accounts or records. Neither income nor expense.
- income: money genuinely earned or received as income.
- balance: what is owed or held right now. Also mark it "measurement" — a balance is both the current number and a point in its history.
- rate: an APR, interest rate or percentage.
- fee: a late fee or penalty — a charge, worth naming as one.
- estimate: a payoff quote, a projected total, an annualized figure. A CALCULATION, never a transaction.

If you cannot tell which kind an amount is, leave financialKind out and give the fact a low confidence. It will be kept and asked about. Guessing "charge" for a loan payment doubles the user's outgoings for that month.

REMINDERS — when an actionable date deserves advance warning, set "reminderDaysBefore" to ONE number of days. Not a list: this app escalates every date as it approaches, so the only thing worth saying is how far out it starts mattering. A yearly renewal deserves ~30; a monthly bill ~3-5.

VOLATILITY — decide, for every fact, whether the property is expected to change:
- stable: blood type, VIN, date of birth, year built, parcel number. A different value later is a CONFLICT, not an update.
- changeable: weight, balance, mileage, market value, roof type, premium.
- historical: a signature date, a past transaction, a date of service. It describes a moment and overwrites nothing.

FACTS ARE NOT ACTIONS. "Premium: $1,672/year" is a financial fact that may justify a recurring obligation. "Signature date: May 20" is a historical fact that justifies nothing at all. Never mark a signature, printing, processing, notarisation or issue date as actionable.

DATES. A date is actionable when it means: due, expires, renews, appointment, deadline, payment, maturity, inspection, a scheduled occurrence, or a required follow-up. It is NOT actionable when it records when the document was created, signed, printed, processed, or when a past transaction or examination happened — unless the document plainly makes it so.

RECURRENCE. Look for it semantically: daily, weekly, monthly, annually, every 6 months, each paycheck, per installment, subscription, renewal, recurring treatment, payment schedule.
ANNUAL COST IS NOT ANNUAL PAYMENT. A $2,400/year policy paid at $200/month is ONE recurrence with two true numbers: amountPerOccurrence 200 and annualizedTotal 2400. Report both when the document supports both, and set "stated" to which one the page actually printed.

INFER WHAT IS IMPLIED, INVENT NOTHING. If a document establishes $120 + monthly + due on the 15th, that IS a recurring obligation even though the page never says so. But if it gives an annual figure and no frequency, you may NOT invent instalments — set stated to "annual" and leave amountPerOccurrence out. A number you calculated goes in derivedFrom with the formula you used.

CONFIDENCE. Be honest. If you do not know what a value represents, give it a low confidence and a best-guess role. "I found this but I'm not sure what it is" is a better answer than a confident wrong one — a low-confidence fact is kept and asked about, never silently filed.

EVERY FACT MUST CITE THE EXTRACTED ROWS IT CAME FROM, by their exact ids, in itemIds. A fact citing no real row will be discarded.
EVERY FACT MUST NAME A SUBJECT that is one of the entity refs you declared. A fact whose subject you did not declare will be discarded.

BE COMPACT. Every token you emit is time the person waits on this upload.
- OMIT any key that does not apply. Never emit "unit":"", "date":"", "status":"" or a 0 placeholder just because the shape below shows the key.
- You do NOT need a fact for every row. A row whose only significance is that it was printed — a form code, a page or barcode number, a layout label, an issuer's internal reference — is kept and shown by the app on its own. Leave it out rather than writing a fact that says nothing.
- One fact per real-world fact, not per printed row: rows that together state one thing (an amount, its schedule, its next due date) are one fact set feeding one recurrence, exactly as described above.

Return ONE valid JSON object and nothing else:
{
  "documentType": "<what this is, in its own terms>",
  "primarySubject": "<entity ref>",
  "entities": [{"ref":"e1","kind":"person|property|vehicle|pet|asset|liability|account|investment|business|organization","name":"...","identifiers":{"policyNumber":"...","vin":"..."},"role":"insured|lender|issuer|provider|...","confidence":0.0}],
  "relationships": [{"from":"e1","to":"e2","type":"owns","confidence":0.0}],
  "facts": [{"id":"f1","itemIds":["<extracted row id>"],"label":"...","value":"...","roles":["..."],"subject":{"entityRef":"e1","confidence":0.0},"volatility":"stable|changeable|historical","unit":"...","date":"YYYY-MM-DD","financialKind":"charge|payment|refund|credit|transfer|income|balance|rate|fee|estimate","status":"active|paid|overdue|cancelled|renewed|expired|closed|completed|approved|denied|pending|suspended","reminderDaysBefore":0,"confidence":0.0,"derivedFrom":{"factIds":["f2"],"formula":"f2 × 12"}}],
  "recurrences": [{"id":"r1","factIds":["f1","f2"],"label":"...","subjectRef":"e1","cadence":"daily|weekly|biweekly|monthly|quarterly|semiannual|yearly|per_installment","amountPerOccurrence":0,"annualizedTotal":0,"nextOccurrence":"YYYY-MM-DD","endsOn":"YYYY-MM-DD","stated":"per_occurrence|annual|both","confidence":0.0}],
  "narrative": [{"title":"...","body":"...","subjectRef":"e1"}],
  "confidence": 0.0,
  "summary": "<one sentence on what this document is and what it establishes>"
}

No prose, no markdown fences.`;

export interface ReasonInput {
  /**
   * The extracted rows, each with the id the review pane uses. Facts cite these,
   * which is what ties every claim back to something actually on the page.
   */
  rows: Array<{ id: string; key: string; label: string; value: unknown }>;
  /** What the classifier already decided — free context, already paid for. */
  documentType?: string;
  documentLabel?: string;
  domainHint?: string;
  /** What the user said when they attached it. */
  userMessage?: string;
  /**
   * The record this document was filed under, already chosen by a person. Told
   * to the reasoner so it describes that record as EXISTING rather than as
   * something the document introduces.
   */
  filedUnder?: string;
  /** The page itself, when we have it — layout carries meaning text loses. */
  content?: Anthropic.MessageParam["content"];
  /** Model override — the caller downgrades to a faster model when the upload
   *  has already burned most of its latency budget. */
  model?: string;
  /** Deadline override, same reason. */
  timeoutMs?: number;
}

export interface ReasonResult {
  semantic: SemanticDocument;
  report: ValidationReport;
  /** False when the stage could not interpret the document at all. */
  ok: boolean;
  /** What to tell the user when it could not. */
  degradedReason?: string;
}

const MODEL = () => process.env.ANTHROPIC_REASONER_MODEL || "claude-sonnet-4-6";
// A stage that degrades gracefully must not be allowed to dominate the wall
// clock it degrades to protect: at 60s a single stalled call cost more than
// the entire rest of the upload. 40s still clears a slow large document.
const TIMEOUT_MS = Number(process.env.SEMANTIC_REASONER_TIMEOUT_MS || 40_000);
// Thinking tokens are generated serially, so the budget is a direct latency
// ceiling. 2,000 is enough to group rows into recurrences and pick subjects;
// the original 4,000 mostly bought wall-clock time. Tunable without a deploy.
const THINKING_BUDGET = () => {
  const n = Number(process.env.SEMANTIC_REASONER_THINKING || 2_000);
  return isFinite(n) && n >= 1024 ? Math.round(n) : 2_000;
};

/**
 * Ask what a document means, and return only the part of the answer that
 * survives validation.
 *
 * Never throws. Every failure path returns an empty envelope with a reason,
 * because a document the reasoner could not interpret must still upload, still
 * save, and still be reviewable field by field.
 */
export async function reasonAboutDocument(
  client: Anthropic,
  input: ReasonInput,
): Promise<ReasonResult> {
  const rows = (input.rows || []).filter((r) => r && r.id);
  if (rows.length === 0) {
    return {
      semantic: emptySemanticDocument(input.documentType, ""),
      report: { ok: false, droppedEntities: [], droppedFacts: [], droppedRelationships: [], droppedRecurrences: [], reasons: ["no extracted rows"] },
      ok: false,
      degradedReason: "nothing was extracted to reason about",
    };
  }

  // The rows go in as a table keyed by the SAME ids the review pane uses, so a
  // fact's `itemIds` can be checked against reality rather than trusted.
  const rowTable = rows
    .map((r) => `${r.id}\t${r.label || r.key}\t${valueForPrompt(r.value)}`)
    .join("\n");

  const context = [
    input.documentType ? `A classifier called this a "${input.documentType}".` : "",
    input.documentLabel ? `Its title looks like "${input.documentLabel}".` : "",
    input.domainHint ? `Hint from the classifier: ${input.domainHint}` : "",
    input.filedUnder
      ? `This document is filed under an EXISTING record: ${input.filedUnder}. That record already exists — describe what the document implies about it, never propose it as something new.`
      : "",
    input.userMessage ? `The user attached it saying: "${input.userMessage}"` : "",
  ].filter(Boolean).join("\n");

  const prompt = `${REASONER_PROMPT}

${context}

These are the rows already extracted from the document. Use these exact ids in itemIds:

id\tlabel\tvalue
${rowTable}`;

  try {
    const content: any[] = [];
    // The original page, when we have it: a table's alignment, a section
    // heading and a signature block are meaning that a flat key/value list has
    // already thrown away.
    if (input.content && Array.isArray(input.content)) content.push(...input.content);
    content.push({ type: "text", text: prompt });

    const response = await withTimeout(
      client.messages.create({
        model: input.model || MODEL(),
        max_tokens: 8000,
        // Reasoning about which fields belong together is exactly the kind of
        // work thinking helps with — it is how five separate rows become one
        // recurring commitment instead of five independent guesses.
        thinking: { type: "enabled", budget_tokens: THINKING_BUDGET() },
        messages: [{ role: "user", content }],
      }),
      input.timeoutMs ?? TIMEOUT_MS,
    );

    const text = (response.content.find((b: any) => b.type === "text") as any)?.text ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn(CAT, "no JSON in response");
      return degraded(input, "the reasoning step returned nothing usable");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch (e: any) {
      logger.warn(CAT, `unparseable JSON: ${e?.message}`);
      return degraded(input, "the reasoning step returned malformed output");
    }

    const knownItemIds = new Set(rows.map((r) => r.id));
    const { doc, report } = validateSemanticDocument(parsed, { knownItemIds });

    if (report.reasons.length > 0) {
      // Not an error — this is the border doing its job. Logged in full because
      // a pattern of drops is how a prompt regression becomes visible.
      logger.info(
        CAT,
        `dropped ${report.droppedFacts.length} fact(s), ` +
        `${report.droppedEntities.length} entity(ies), ` +
        `${report.droppedRelationships.length} relationship(s), ` +
        `${report.droppedRecurrences.length} recurrence(s): ${report.reasons.slice(0, 8).join("; ")}`,
      );
    }

    if (doc.facts.length === 0) {
      return degraded(input, "the reasoning step could not place any of the extracted values");
    }

    logger.info(
      CAT,
      `"${doc.documentType}" — ${doc.entities.length} entities, ` +
      `${doc.facts.length} facts, ${doc.relationships.length} relationships, ` +
      `${doc.recurrences.length} recurrences, confidence ${doc.confidence.toFixed(2)}`,
    );
    return { semantic: doc, report, ok: true };
  } catch (err: any) {
    logger.warn(CAT, `failed: ${err?.message || err}`);
    return degraded(input, "the reasoning step did not complete");
  }
}

function degraded(input: ReasonInput, reason: string): ReasonResult {
  return {
    semantic: emptySemanticDocument(input.documentType, ""),
    report: { ok: false, droppedEntities: [], droppedFacts: [], droppedRelationships: [], droppedRecurrences: [], reasons: [reason] },
    ok: false,
    degradedReason: reason,
  };
}

/** Values go into the prompt readable and bounded — a giant blob helps nobody. */
function valueForPrompt(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\s+/g, " ").trim().slice(0, 400);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
