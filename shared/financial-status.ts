// shared/financial-status.ts — is this money a transaction that HAPPENED?
//
// RULE 3: never turn extracted information into a financial transaction
// without transaction evidence. A quote, an estimate, an invoice and a
// statement all carry a dollar amount, and none of them is proof that money
// moved. Only a receipt, a payment confirmation, or a field that says "paid"
// is. Every extracted financial item therefore carries a `financialStatus`,
// and an expense is only ever created from a "paid" one.
//
// RULE 4: an explicit user instruction beats everything the engine infers.
// "Nothing has been paid. Do not create an expense." is a decision, not a
// hint, and it is enforced here — before any write layer — not in a prompt.
//
// Priority ladder (decideExpenseCreation):
//   explicit user instruction > existing structured data > deterministic rule > AI inference
//
// Pure and dependency-free so all three write paths (auto-create at upload,
// the legacy confirm body, the reviewed action plan) share one decision.

export type FinancialStatus =
  | "estimated"   // a projection — a number about the future
  | "quoted"      // a price offered, not accepted or paid
  | "invoiced"    // a bill issued, balance outstanding
  | "unpaid"      // the document (or the user) says it has not been paid
  | "scheduled"   // a payment committed for a future date
  | "pending"     // in flight, or nothing says either way
  | "paid"        // money moved — the only status that becomes an expense
  | "refunded";   // money came back — never an expense

export const FINANCIAL_STATUSES: readonly FinancialStatus[] = [
  "estimated", "quoted", "invoiced", "unpaid", "scheduled", "pending", "paid", "refunded",
] as const;

const STATUS_SET: ReadonlySet<string> = new Set(FINANCIAL_STATUSES);

export function isFinancialStatus(v: unknown): v is FinancialStatus {
  return typeof v === "string" && STATUS_SET.has(v);
}

export type FinancialDocKind =
  | "quote"
  | "estimate"
  | "invoice"
  | "receipt"
  | "bill"
  | "payment_confirmation"
  | "statement"
  | "contract"
  | "unknown";

export const FINANCIAL_DOC_KINDS: readonly FinancialDocKind[] = [
  "quote", "estimate", "invoice", "receipt", "bill", "payment_confirmation", "statement", "contract", "unknown",
] as const;

const DOC_KIND_SET: ReadonlySet<string> = new Set(FINANCIAL_DOC_KINDS);

export function isFinancialDocKind(v: unknown): v is FinancialDocKind {
  return typeof v === "string" && DOC_KIND_SET.has(v);
}

export type ExpenseInstruction = "forbid" | "require";

export type ExpenseDecisionSource = "explicit_instruction" | "structured_data" | "deterministic_rule";

export interface ExpenseDecision {
  create: boolean;
  reason: string;
  source: ExpenseDecisionSource;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extraction values arrive as raw scalars or `{ value, confidence }` wrappers. */
function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>).value;
  }
  return v;
}

/** "Total Amount Due" / "total_amount_due" / "totalAmountDue" → "totalamountdue". */
function normKey(k: string): string {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function toNumber(v: unknown): number | null {
  const raw = unwrap(v);
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return null;
  const cleaned = String(raw).replace(/[$€£¥,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

/** Word-form of a snake/camel/kebab identifier: "vehicle_service_receipt" → "vehicle service receipt". */
function words(s: unknown): string {
  return String(s ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-/.]+/g, " ")
    .toLowerCase()
    .trim();
}

/** Flattened lookup of an extraction record by normalised key. */
function fieldIndex(extractedData: Record<string, any> | null | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (obj: any, depth: number) => {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("_")) continue;
      const nk = normKey(k);
      const uv = unwrap(v);
      if (uv && typeof uv === "object" && !Array.isArray(uv)) {
        if (!out.has(nk)) out.set(nk, uv);
        walk(uv, depth + 1);
      } else if (!out.has(nk)) {
        out.set(nk, uv);
      }
    }
  };
  walk(extractedData, 0);
  return out;
}

function firstField(index: Map<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = index.get(normKey(k));
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function firstNumber(index: Map<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const n = toNumber(index.get(normKey(k)));
    if (n !== null) return n;
  }
  return null;
}

/** Every scalar value in the record, as one lowercase blob for phrase checks. */
function recordText(extractedData: Record<string, any> | null | undefined): string {
  const parts: string[] = [];
  const walk = (obj: any, depth: number) => {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("_")) continue;
      const uv = unwrap(v);
      if (Array.isArray(uv)) {
        for (const item of uv.slice(0, 50)) {
          if (item && typeof item === "object") walk(item, depth + 1);
          else if (item !== null && item !== undefined) parts.push(`${words(k)}: ${String(item)}`);
        }
      } else if (uv && typeof uv === "object") {
        walk(uv, depth + 1);
      } else if (uv !== null && uv !== undefined && uv !== "") {
        parts.push(`${words(k)}: ${String(uv)}`);
      }
    }
  };
  walk(extractedData, 0);
  return parts.join("\n").toLowerCase();
}

// ─── Document kind ───────────────────────────────────────────────────────────

/**
 * Kind patterns in PRECEDENCE order for unordered text (field values). For
 * ordered text (OCR / title) the EARLIEST match wins instead — the heading of
 * a document names what it is, and a line item mentioning "estimate" further
 * down does not make an invoice a quote.
 */
const KIND_PATTERNS: Array<{ kind: FinancialDocKind; re: RegExp }> = [
  { kind: "payment_confirmation", re: /\b(payment (confirmation|received|receipt|successful|complete[d]?)|confirmation of (your )?payment|thank you for your payment|receipt of payment|remittance advice)\b/ },
  { kind: "receipt", re: /\breceipt\b/ },
  { kind: "quote", re: /\b(quote|quotation|price quote)\b/ },
  { kind: "estimate", re: /\b(estimate|estimated cost|proposal|pro[\s-]?forma)\b/ },
  { kind: "invoice", re: /\binvoice\b/ },
  { kind: "statement", re: /\bstatement\b/ },
  { kind: "contract", re: /\b(contract|agreement|lease|terms of service)\b/ },
  { kind: "bill", re: /\b(bill|billing notice|amount due notice|utility notice)\b/ },
];

function kindByPrecedence(text: string): FinancialDocKind | null {
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(text)) return kind;
  }
  return null;
}

function kindByPosition(text: string): FinancialDocKind | null {
  let best: { kind: FinancialDocKind; at: number } | null = null;
  for (const { kind, re } of KIND_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (!best || m.index < best.at) best = { kind, at: m.index };
  }
  return best?.kind ?? null;
}

/**
 * What KIND of money document this is: quote / estimate / invoice / receipt /
 * bill / payment confirmation / statement / contract. Deterministic — the
 * declared type wins, then the document's own title fields, then the text.
 */
export function classifyFinancialDocKind(
  documentType: unknown,
  extractedData: Record<string, any> | null | undefined,
  ocrText?: string,
): FinancialDocKind {
  const data = extractedData && typeof extractedData === "object" ? extractedData : {};
  const index = fieldIndex(data);

  // 0. An already-classified kind stored on the record is authoritative.
  const stored = unwrap(index.get("documentkind"));
  if (isFinancialDocKind(stored) && stored !== "unknown") return stored;

  // 1. The declared document type ("vehicle_service_receipt", "invoice").
  const typeText = words(documentType);
  if (typeText) {
    const k = kindByPrecedence(typeText);
    if (k) return k;
  }

  // 2. Title-like fields the extractor filled in.
  const titleText = ["title", "documenttitle", "documenttype", "doctype", "type", "kind", "label", "heading", "subject", "description"]
    .map((k) => index.get(k))
    .map((v) => unwrap(v))
    .filter((v) => typeof v === "string")
    .map((v) => words(v))
    .join(" \n ");
  if (titleText.trim()) {
    const k = kindByPosition(titleText);
    if (k) return k;
  }

  // 3. The document's own words — earliest mention wins (it is the heading).
  const ocr = String(ocrText || "").toLowerCase();
  if (ocr.trim()) {
    const k = kindByPosition(ocr.slice(0, 20_000));
    if (k) return k;
  }

  // 4. Field NAMES as a last resort ("invoiceNumber", "quoteNumber", "receiptNumber").
  const keyText = Array.from(index.keys()).join(" ");
  if (/\b(quotenumber|quoteno|quoteid|quotedate)\b/.test(keyText)) return "quote";
  if (/\b(estimatenumber|estimateno|estimateid|estimatedate|estimatetotal)\b/.test(keyText)) return "estimate";
  if (/\b(invoicenumber|invoiceno|invoiceid|invoicedate|invoicetotal)\b/.test(keyText)) return "invoice";
  if (/\b(receiptnumber|receiptno|receiptid|receiptdate)\b/.test(keyText)) return "receipt";
  if (/\b(statementdate|statementperiod|statementbalance)\b/.test(keyText)) return "statement";
  if (/\b(contractnumber|contractdate|agreementdate)\b/.test(keyText)) return "contract";
  if (/\b(billdate|billingperiod|billnumber)\b/.test(keyText)) return "bill";

  return "unknown";
}

// ─── Status inference ────────────────────────────────────────────────────────

/**
 * The document, or the user, saying OUTRIGHT that nothing has been paid.
 * These beat numbers: "Nothing paid" next to a total is still nothing paid.
 */
const EXPLICIT_UNPAID_RE =
  /\b(nothing (has been |was |is )?paid|no payments? (has been |have been |was |were |is |are )?(made|received|recorded|posted)|\bunpaid\b|not (yet )?(been )?paid|hasn'?t been paid|haven'?t (been )?paid|have not (been )?paid|has not been paid|wasn'?t paid|isn'?t paid|not paid yet|past due|overdue|awaiting payment|outstanding balance|balance outstanding)\b/;

/**
 * Payment-terms boilerplate ("please remit", "due upon receipt"). Evidence of
 * a request for payment, but weaker than a positive amount-paid field — an
 * invoice keeps its terms after it is paid.
 */
const DUE_TERMS_RE =
  /\b(payment (is |now )?due|due (up)?on receipt|please (pay|remit)|remit (payment|to)|pay this amount|make (your |a )?payment|payment required)\b/;

/** Strong, unambiguous language that money was received. */
const STRONG_PAID_RE =
  /\b(paid in full|payment received|payment (was )?(successful|completed|processed|confirmed)|thank you for your payment|we have received your payment|your payment of \$?[\d,.]+ (was|has been) received|has been paid|was paid|marked (as )?paid)\b/;

/** The user saying this money is a done deal. */
const USER_PAID_RE =
  /\b((i|we) (already |just )?paid (this|it|that|the (bill|invoice|full amount)|in full)|(this|it|that) (is|was|has been) (already )?paid|already paid|paid in full|mark (it |this |that )?(as )?paid)\b/;

const REFUND_RE = /\b(refund(ed)? (issued|processed|complete[d]?|applied)|has been refunded|was refunded|refund of \$?[\d,.]+|money back)\b/;

function statusFieldValue(index: Map<string, unknown>): string {
  const v = firstField(index, ["paymentStatus", "status", "paid", "isPaid", "paymentState", "invoiceStatus", "billStatus"]);
  if (v === undefined) return "";
  if (typeof v === "boolean") return v ? "paid" : "unpaid";
  return String(v).trim().toLowerCase();
}

export interface InferFinancialStatusInput {
  docKind: FinancialDocKind;
  extractedData: Record<string, any> | null | undefined;
  ocrText?: string;
  /**
   * The message the user attached at upload. An explicit "nothing has been
   * paid" or "I paid this" here outranks anything the document says.
   */
  userMessage?: string;
}

export interface FinancialStatusResult {
  status: FinancialStatus;
  /** Why — in words the user could read on the row. */
  evidence: string;
  /** 0..1. Paid needs strong evidence; anything below 0.8 is never "paid". */
  confidence: number;
  /** Who decided: the user's own words, a status already on the record, or the document. */
  source: "user_instruction" | "record" | "document";
}

/**
 * Infer the payment state of the money on a document.
 *
 * "paid" requires STRONG evidence: a positive amount-paid field, a payment
 * date, a status field that says paid, a payment confirmation, or a receipt
 * with nothing left due. A dollar amount on its own is never evidence that
 * it was paid — that is the whole point.
 */
export function inferFinancialStatus(input: InferFinancialStatusInput): FinancialStatusResult {
  const data = input.extractedData && typeof input.extractedData === "object" ? input.extractedData : {};
  const index = fieldIndex(data);
  const userMsg = String(input.userMessage || "").toLowerCase();

  // 1. The user, explicitly. Rule 4: this outranks the document.
  if (userMsg) {
    if (EXPLICIT_UNPAID_RE.test(userMsg)) {
      return { status: "unpaid", evidence: "You said this has not been paid", confidence: 0.98, source: "user_instruction" };
    }
    if (USER_PAID_RE.test(userMsg)) {
      return { status: "paid", evidence: "You said this was paid", confidence: 0.98, source: "user_instruction" };
    }
  }

  // 2. A status already stored on the record is structured data and stands.
  const stored = unwrap(index.get("financialstatus"));
  if (isFinancialStatus(stored)) {
    return { status: stored, evidence: "Status recorded on the document", confidence: 0.95, source: "record" };
  }

  // 3. The document itself.
  return { ...inferFromDocument(input.docKind, data, index, String(input.ocrText || "")), source: "document" };
}

function inferFromDocument(
  kind: FinancialDocKind,
  data: Record<string, any>,
  index: Map<string, unknown>,
  ocrText: string,
): Omit<FinancialStatusResult, "source"> {
  const docText = `${ocrText}\n${recordText(data)}`.toLowerCase();

  const amountPaid = firstNumber(index, ["amountPaid", "totalPaid", "paidAmount", "paymentAmount", "amountTendered", "amtTendered", "paymentTotal", "amountReceived"]);
  const amountDue = firstNumber(index, ["amountDue", "balanceDue", "totalDue", "totalAmountDue", "amountDueToday", "totalDueAmount", "outstandingBalance", "amountOwed", "remainingBalance", "balanceRemaining", "balance"]);
  const paymentDate = firstField(index, ["paymentDate", "paidOn", "paidDate", "datePaid", "paidAt", "paymentReceivedDate"]);
  const refundAmount = firstNumber(index, ["refundAmount", "amountRefunded", "refundTotal"]);
  const statusField = statusFieldValue(index);

  // 2. Refunds — money came back. Never an expense here.
  if ((refundAmount !== null && refundAmount > 0) || /refund/.test(statusField) || REFUND_RE.test(docText)) {
    return { status: "refunded", evidence: "The document records a refund", confidence: 0.9 };
  }

  // 3. A status field is structured data the extractor read off the page.
  if (statusField) {
    if (/^(paid|settled|complete[d]?|payment received|closed|paid in full|success(ful)?)$/.test(statusField) || /\bpaid in full\b/.test(statusField)) {
      if (!(amountDue !== null && amountDue > 0)) {
        return { status: "paid", evidence: `Status field says "${statusField}"`, confidence: 0.95 };
      }
    }
    if (/schedul/.test(statusField)) {
      return { status: "scheduled", evidence: `Status field says "${statusField}"`, confidence: 0.9 };
    }
    if (/pending|processing|in progress|submitted/.test(statusField)) {
      return { status: "pending", evidence: `Status field says "${statusField}"`, confidence: 0.9 };
    }
    if (/unpaid|not paid|due|open|outstanding|overdue|owed|owing|balance/.test(statusField)) {
      return { status: "unpaid", evidence: `Status field says "${statusField}"`, confidence: 0.9 };
    }
  }

  // 4. The document says outright that it has not been paid.
  if (EXPLICIT_UNPAID_RE.test(docText)) {
    const m = docText.match(EXPLICIT_UNPAID_RE);
    const base = kind === "invoice" ? "invoiced" : "unpaid";
    return { status: base, evidence: `Document says "${(m?.[0] || "unpaid").trim()}"`, confidence: 0.9 };
  }

  // 5. Money recorded as paid — the strong signal.
  if (amountPaid !== null && amountPaid > 0) {
    if (amountDue !== null && amountDue > 0) {
      return { status: "unpaid", evidence: `Paid $${amountPaid} but $${amountDue} still due`, confidence: 0.85 };
    }
    return { status: "paid", evidence: `Amount paid $${amountPaid}`, confidence: 0.92 };
  }
  if (amountPaid !== null && amountPaid === 0 && kind !== "receipt") {
    return { status: kind === "invoice" ? "invoiced" : "unpaid", evidence: "Amount paid is $0", confidence: 0.85 };
  }
  if (paymentDate !== undefined && String(paymentDate).trim()) {
    if (amountDue !== null && amountDue > 0) {
      return { status: "unpaid", evidence: `A payment was made but $${amountDue} is still due`, confidence: 0.8 };
    }
    return { status: "paid", evidence: `Payment date ${String(paymentDate)}`, confidence: 0.88 };
  }

  const strongPaid = STRONG_PAID_RE.test(docText);
  const dueRemains = amountDue !== null && amountDue > 0;

  // 5b. Payment terms with no payment recorded: a request for money.
  if (DUE_TERMS_RE.test(docText) && !strongPaid && kind !== "receipt" && kind !== "payment_confirmation") {
    const m = docText.match(DUE_TERMS_RE);
    return {
      status: kind === "invoice" ? "invoiced" : kind === "quote" ? "quoted" : kind === "estimate" ? "estimated" : "unpaid",
      evidence: `Document says "${(m?.[0] || "payment due").trim()}"`,
      confidence: 0.8,
    };
  }

  // 6. What the KIND of document implies.
  switch (kind) {
    case "quote":
      return { status: "quoted", evidence: "This is a quote — a price offered, not a charge", confidence: 0.9 };
    case "estimate":
      return { status: "estimated", evidence: "This is an estimate — a projection, not a charge", confidence: 0.9 };
    case "payment_confirmation":
      return { status: "paid", evidence: "This is a payment confirmation", confidence: 0.9 };
    case "receipt":
      if (dueRemains) {
        return { status: "unpaid", evidence: `Receipt shows $${amountDue} still due`, confidence: 0.8 };
      }
      return { status: "paid", evidence: "A receipt is proof of payment", confidence: 0.85 };
    case "invoice":
      if (strongPaid && !dueRemains) {
        return { status: "paid", evidence: "Invoice is marked paid", confidence: 0.85 };
      }
      return { status: "invoiced", evidence: dueRemains ? `Invoice with $${amountDue} due` : "An invoice is a request for payment", confidence: 0.85 };
    case "bill":
      if (strongPaid && !dueRemains) {
        return { status: "paid", evidence: "Bill is marked paid", confidence: 0.85 };
      }
      return { status: "unpaid", evidence: dueRemains ? `Bill with $${amountDue} due` : "A bill is a request for payment", confidence: 0.8 };
    case "statement":
      return { status: "pending", evidence: "A statement summarises an account; it is not a charge", confidence: 0.8 };
    case "contract":
      return { status: "scheduled", evidence: "A contract commits future payments; nothing has moved yet", confidence: 0.8 };
    case "unknown":
    default:
      if (dueRemains) {
        return { status: "unpaid", evidence: `$${amountDue} shown as due`, confidence: 0.75 };
      }
      if (strongPaid) {
        return { status: "paid", evidence: "Document says the payment was received", confidence: 0.8 };
      }
      return { status: "pending", evidence: "No evidence of payment on the document", confidence: 0.4 };
  }
}

// ─── Explicit user instruction ───────────────────────────────────────────────

const VERB = "(create|creating|add|adding|log|logging|record|recording|make|making|book|booking|enter|entering|file|filing|save|saving|track|tracking|post|posting)";
const NOUN = "(expense|expenses|charge|charges|transaction|transactions|payment|payments|spending|purchase)";

const FORBID_EXPENSE_RE = new RegExp(
  [
    // "do not create an expense", "don't log this as a charge", "never record a transaction"
    `\\b(do not|don'?t|never|please don'?t|please do not|no need to|without|not)\\s+${VERB}\\s+(an?\\s+|the\\s+|this\\s+|that\\s+|it\\s+)?(as\\s+an?\\s+)?(new\\s+)?${NOUN}\\b`,
    // "no expense", "not an expense", "skip the expense", "no expense entry"
    `\\b(no|not an?|skip(ping)? (the|this|that)|leave out (the|this)|without (an?|the))\\s+${NOUN}\\b`,
    `\\bnot\\s+(an?\\s+)?${NOUN}\\b`,
    // "nothing has been paid", "haven't paid", "not paid yet", "unpaid"
    `\\bnothing (has been |was |is |has )?(been )?paid\\b`,
    `\\b(haven'?t|have not|hasn'?t|has not|didn'?t|did not|never)\\s+(been\\s+)?paid\\b`,
    `\\bnot (yet )?(been )?paid( yet)?\\b`,
    `\\b(it'?s|this is|that is|it is|this was|it was)\\s+(still\\s+)?(unpaid|not paid|outstanding|only an? (estimate|quote))\\b`,
    `\\bunpaid\\b`,
    `\\b(just|only) an? (estimate|quote|quotation|proposal)\\b`,
  ].join("|"),
  "i",
);

const REQUIRE_EXPENSE_RE = new RegExp(
  [
    // "log this as an expense", "add it as an expense", "create an expense", "record the expense"
    `\\b${VERB}\\s+(this|it|that|the\\s+\\w+|these|them)?\\s*(as\\s+)?(an?\\s+|the\\s+|my\\s+)?(new\\s+)?${NOUN}\\b`,
    `\\b(as|to)\\s+(an?\\s+)?expense\\b`,
    // "I paid this", "we already paid it", "this was paid", "paid in full", "mark it paid"
    `\\b(i|we)\\s+(already\\s+|just\\s+|have\\s+|'ve\\s+)?paid\\b`,
    `\\b(this|it|that)\\s+(is|was|has been|got)\\s+(already\\s+)?paid\\b`,
    `\\balready paid\\b`,
    `\\bpaid in full\\b`,
    `\\bmark (it|this|that)?\\s*(as\\s+)?paid\\b`,
  ].join("|"),
  "i",
);

/**
 * Did the user say, in so many words, whether an expense should be created?
 *
 * Conservative on purpose: only explicit phrasing fires. A message that merely
 * mentions money, or asks a question, returns null and the deterministic
 * rules decide. Negations are checked first, so "do not log this as an
 * expense" is a veto even though it contains "log this as an expense".
 */
export function detectExpenseInstruction(userMessage: string): ExpenseInstruction | null {
  const m = String(userMessage || "").trim();
  if (!m) return null;
  if (FORBID_EXPENSE_RE.test(m)) return "forbid";
  if (REQUIRE_EXPENSE_RE.test(m)) return "require";
  return null;
}

// ─── The decision ────────────────────────────────────────────────────────────

export interface DecideExpenseInput {
  financialStatus: FinancialStatus;
  userInstruction: ExpenseInstruction | null;
  /**
   * Existing STRUCTURED data about this money — e.g. a bill occurrence the app
   * already tracks as paid (true) or unpaid (false). Outranks inference, never
   * the user.
   */
  structuredPaid?: boolean;
}

const STATUS_REASON: Record<FinancialStatus, string> = {
  estimated: "This is an estimate — a projection, not a charge. It stays on the document until you record the payment.",
  quoted: "This is a quote — a price offered, not money spent. It stays on the document until you record the payment.",
  invoiced: "This is an unpaid invoice — it stays on the document until you record the payment.",
  unpaid: "Nothing has been paid yet — it stays on the document until you record the payment.",
  scheduled: "This payment is scheduled, not made — it stays on the document until it goes through.",
  pending: "No evidence this was paid — it stays on the document until you record the payment.",
  paid: "The document shows this was paid.",
  refunded: "This money was refunded — a refund is not an expense.",
};

/**
 * Should an expense be created from this money?
 *
 *   explicit user instruction > existing structured data > deterministic rule
 *
 * The deterministic rule is the whole of Rule 3: only "paid" becomes an
 * expense. "refunded" never does, whatever the ladder above it says short of
 * the user asking for it outright.
 */
export function decideExpenseCreation(input: DecideExpenseInput): ExpenseDecision {
  if (input.userInstruction === "forbid") {
    return {
      create: false,
      source: "explicit_instruction",
      reason: "You said not to record an expense for this — nothing was created.",
    };
  }
  if (input.userInstruction === "require") {
    return {
      create: true,
      source: "explicit_instruction",
      reason: "You asked for this to be recorded as an expense.",
    };
  }
  if (typeof input.structuredPaid === "boolean") {
    return input.structuredPaid
      ? { create: true, source: "structured_data", reason: "Your records already show this as paid." }
      : { create: false, source: "structured_data", reason: "Your records show this has not been paid — it stays on the document until you record the payment." };
  }
  const status = isFinancialStatus(input.financialStatus) ? input.financialStatus : "pending";
  return {
    create: status === "paid",
    source: "deterministic_rule",
    reason: STATUS_REASON[status],
  };
}

/** One call for the common case: kind + status + decision from raw inputs. */
export function assessExpenseFromDocument(input: {
  documentType: unknown;
  extractedData: Record<string, any> | null | undefined;
  ocrText?: string;
  userMessage?: string;
  structuredPaid?: boolean;
}): {
  docKind: FinancialDocKind;
  status: FinancialStatusResult;
  instruction: ExpenseInstruction | null;
  decision: ExpenseDecision;
} {
  const docKind = classifyFinancialDocKind(input.documentType, input.extractedData, input.ocrText);
  const status = inferFinancialStatus({
    docKind,
    extractedData: input.extractedData,
    ocrText: input.ocrText,
    userMessage: input.userMessage,
  });
  const instruction = detectExpenseInstruction(input.userMessage || "");
  const decision = decideExpenseCreation({
    financialStatus: status.status,
    userInstruction: instruction,
    structuredPaid: input.structuredPaid,
  });
  return { docKind, status, instruction, decision };
}
