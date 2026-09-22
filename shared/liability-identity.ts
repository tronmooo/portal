// shared/liability-identity.ts — ONE liability = ONE profile.
//
// Why this file exists (user report 2026-09-22): the Liabilities tab listed
// "Dodge Ram 2025 Auto Loan" under Fixed AND "Dodge Ram 2025 Auto Loan payment"
// under Variable. Two rows, one debt. Worse, the two disagreed about the debt
// itself: the loan carried the amortizing subtype and a $47,979.70 balance, the
// twin carried a generic bill subtype and a $912.40 monthly amount — so the
// SAME payment was fixed on one card and variable on the other, and whichever
// surface happened to read the twin reported the wrong shape of obligation.
//
// The twin was minted by `create_liability` (server/ai-engine), which wrote a
// companion "<name> payment" obligation beside every loan — and an obligation
// in this app IS a liability profile (supabase-storage.createObligation ends in
// createProfile({ type: "liability" })). Nothing downstream could tell the two
// apart because nothing upstream had ever defined what makes two liability
// records the SAME liability. That definition lives here.
//
// The rule, in one line: a liability is identified by its ACCOUNT (the loan /
// policy / card number the creditor knows it by) and, failing that, by its
// NAME under its OWNER — with the "… payment" spelling folded away, because
// "Car Loan payment" and "Car Loan" are one debt described twice.
//
// The deliberate exception: two genuinely separate obligations against the same
// asset (a first and a second mortgage, two loans on one truck) stay separate.
// They are told apart by the only things that can honestly tell them apart —
// disagreeing account identifiers, disagreeing creditors, or simply different
// names. A second loan that shares its sibling's name AND its account number
// AND its creditor is not a second loan.
//
// Pure + dependency-light so the storage chokepoint, the AI tools, the import
// path and the client all decide identity the same way.

import { identifiersAgree } from "./entity-shape";
import {
  isRecurringBill, isRecurringBillProfile, liabilityFamily, normalizeLiabilityName,
} from "./liability-types";

/** The shape every door can produce: a stored profile or an about-to-be-stored one. */
export interface LiabilityRecord {
  id?: string;
  name?: string | null;
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  parentProfileId?: string | null;
  fields?: Record<string, any> | null;
  deletedAt?: unknown;
}

/** Profile types this app stores debts and bills under. */
const LIABILITY_TYPES = new Set(["liability", "loan", "subscription"]);

/** True when a record is stored in the liability namespace at all. */
export function isLiabilityRecord(rec: LiabilityRecord | null | undefined): boolean {
  return !!rec && LIABILITY_TYPES.has(String(rec.type || "").toLowerCase());
}

const typeKeyOf = (rec: LiabilityRecord | null | undefined): string =>
  String((rec as any)?.type_key ?? (rec as any)?.typeKey ?? "").trim().toLowerCase();

// ─── Identifiers ─────────────────────────────────────────────────────────────

/**
 * Field spellings that carry the creditor's own handle on the account. Every
 * door spells it differently (a statement import writes `accountNumber`, the
 * loan registry writes `loanNumber`, an insurance bill writes `policyNumber`),
 * so identity reads all of them rather than insisting on one.
 */
export const LIABILITY_IDENTIFIER_FIELDS: readonly string[] = [
  "loanNumber", "loanAccountNumber", "loanId",
  "accountNumber", "acctNumber", "accountNo", "accountNumberLast4", "accountLast4",
  "policyNumber", "policyNo", "policyId",
  "cardNumber", "last4",
];

/** Sub-objects an identifier hides inside when a door nests its fields. */
const NESTED_FIELD_GROUPS = ["finance", "loan", "insurance", "account"];

/** Masking characters a statement prints in front of a last-four. */
const stripMask = (v: string): string => v.replace(/^[*x•·\s-]+/i, "");

/**
 * Every account identifier a record carries, normalized for comparison.
 * Values shorter than 4 characters are dropped — "1" and "A" identify nothing.
 */
export function liabilityIdentifiers(rec: LiabilityRecord | null | undefined): string[] {
  const fields = (rec?.fields && typeof rec.fields === "object") ? rec.fields as Record<string, any> : {};
  const out: string[] = [];
  const take = (v: unknown) => {
    if (v === null || v === undefined || typeof v === "object") return;
    const s = stripMask(String(v).trim());
    if (s.replace(/[^a-z0-9]/gi, "").length < 4) return;
    out.push(s);
  };
  for (const key of LIABILITY_IDENTIFIER_FIELDS) take(fields[key]);
  for (const group of NESTED_FIELD_GROUPS) {
    const nested = fields[group];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    for (const key of LIABILITY_IDENTIFIER_FIELDS) take((nested as Record<string, any>)[key]);
  }
  return out;
}

/** The creditor a record names, normalized. Empty when it names none. */
export function liabilityCreditor(rec: LiabilityRecord | null | undefined): string {
  const fields = (rec?.fields && typeof rec.fields === "object") ? rec.fields as Record<string, any> : {};
  const finance = (fields.finance && typeof fields.finance === "object") ? fields.finance as Record<string, any> : {};
  const raw = fields.lender ?? fields.creditor ?? fields.servicer ?? fields.carrier
    ?? fields.provider ?? fields.institution
    ?? finance.lender ?? finance.creditor ?? finance.servicer;
  return String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * True when both records name an account and NONE of the names agree — the
 * signal that says "these are two different obligations", which is exactly
 * what keeps a first and a second mortgage on one house apart.
 */
export function identifiersConflict(a: LiabilityRecord, b: LiabilityRecord): boolean {
  const ia = liabilityIdentifiers(a), ib = liabilityIdentifiers(b);
  if (ia.length === 0 || ib.length === 0) return false;   // nothing to disagree about
  return !ia.some((x) => ib.some((y) => identifiersAgree(x, y)));
}

/** True when both records name an account and at least one pair agrees. */
export function identifiersMatch(a: LiabilityRecord, b: LiabilityRecord): boolean {
  const ia = liabilityIdentifiers(a), ib = liabilityIdentifiers(b);
  if (ia.length === 0 || ib.length === 0) return false;
  return ia.some((x) => ib.some((y) => identifiersAgree(x, y)));
}

/**
 * True when both records name a creditor and the two disagree. A shared
 * account number across two different creditors is a coincidence, not an
 * identity — "Chase auto loan #4471" is not "Ally personal loan #4471".
 */
export function creditorsConflict(a: LiabilityRecord, b: LiabilityRecord): boolean {
  const ca = liabilityCreditor(a), cb = liabilityCreditor(b);
  if (!ca || !cb) return false;
  return !(ca === cb || ca.includes(cb) || cb.includes(ca));
}

// ─── Name + owner ────────────────────────────────────────────────────────────

/**
 * The name two records must share to be the same liability. Folds away the
 * "… payment" / "… bill payment" spelling (shared/liability-types) and the
 * articles a model sometimes prefixes, so every door's phrasing of one debt
 * lands on one key.
 */
export function liabilityNameKey(name: string | null | undefined): string {
  return normalizeLiabilityName(String(name ?? "").replace(/^\s*(?:the|my|our)\s+/i, ""));
}

export interface OwnerScope {
  /** The user's own profile id — a null parent and Self are the same owner. */
  selfProfileId?: string | null;
}

const ownerKey = (rec: LiabilityRecord, scope: OwnerScope | undefined): string => {
  const parent = (rec as any)?.parentProfileId ?? null;
  if (parent == null) return "self";
  if (scope?.selfProfileId && parent === scope.selfProfileId) return "self";
  return String(parent);
};

/**
 * True when two liability records are the SAME liability.
 *
 * Order matters: a disagreeing account number or creditor vetoes the match
 * before any name is considered, which is what makes the "two loans on one
 * asset" exception structural rather than a special case someone has to
 * remember to code around.
 */
export function sameLiability(
  a: LiabilityRecord | null | undefined,
  b: LiabilityRecord | null | undefined,
  scope?: OwnerScope,
): boolean {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (!isLiabilityRecord(a) || !isLiabilityRecord(b)) return false;
  if (a.deletedAt || b.deletedAt) return false;
  if (creditorsConflict(a, b)) return false;
  if (identifiersConflict(a, b)) return false;
  // The creditor's own handle on the account settles it outright: a statement
  // import that spells the name differently still lands on the right debt.
  if (identifiersMatch(a, b)) return true;
  const key = liabilityNameKey(a.name);
  if (!key || key !== liabilityNameKey(b.name)) return false;
  return ownerKey(a, scope) === ownerKey(b, scope);
}

/**
 * The record `candidate` IS, if one already exists. Returns undefined when the
 * candidate is genuinely new — which is the answer every create path needs
 * before it inserts.
 *
 * Prefers the most authoritative twin: a real debt instrument outranks a bill
 * shell of the same name, so a loan created after its payment bill absorbs the
 * bill instead of hiding behind it.
 */
export function findCanonicalLiability<T extends LiabilityRecord>(
  candidate: LiabilityRecord | null | undefined,
  existing: readonly T[] | null | undefined,
  scope?: OwnerScope,
): T | undefined {
  if (!candidate || !isLiabilityRecord(candidate)) return undefined;
  const matches = (existing || []).filter(
    (p) => p && p.id && p.id !== candidate.id && sameLiability(candidate, p, scope),
  );
  if (matches.length === 0) return undefined;
  return matches.slice().sort((x, y) => classificationRank(y) - classificationRank(x))[0];
}

// ─── Canonical classification ────────────────────────────────────────────────

/** Subtypes that say nothing beyond "this is a liability". */
const GENERIC_TYPE_KEYS = new Set(["liability", "debt", "other", "general", "bill", "obligation"]);

/** Values a door writes into a classification field that carry no subtype. */
const GENERIC_CLASSIFICATION_VALUES = new Set([
  "liability", "loan_payment", "debt", "other", "general", "obligation", "bill", "payment",
]);

/**
 * How much a record's subtype actually says, 0 (nothing) to 3 (a named debt
 * instrument). This is the precedence that keeps ONE canonical answer to
 * "is this payment fixed or variable?": the more specific subtype wins, and a
 * generic bill shell can never demote a mortgage into a monthly bill.
 */
export function classificationRank(rec: LiabilityRecord | null | undefined): number {
  const key = typeKeyOf(rec);
  if (!key) return String(rec?.type || "").toLowerCase() === "subscription" ? 2 : 0;
  if (GENERIC_TYPE_KEYS.has(key)) return 1;
  if (key === "loan") return 2;                     // real, but the vaguest loan there is
  if (isRecurringBill(key)) return 2;
  return 3;                                          // mortgage, auto_loan, credit_card…
}

/**
 * The subtype the merged record keeps. Ties go to the record that already
 * exists, so identity is stable: re-running an import does not flip a loan's
 * classification back and forth.
 */
export function preferLiabilityTypeKey(
  canonical: LiabilityRecord,
  incoming: LiabilityRecord,
): string | undefined {
  const winner = classificationRank(incoming) > classificationRank(canonical) ? incoming : canonical;
  return typeKeyOf(winner) || typeKeyOf(canonical) || typeKeyOf(incoming) || undefined;
}

/** The profile `type` the merged record keeps — never demote a debt to a subscription. */
export function preferLiabilityType(canonical: LiabilityRecord, incoming: LiabilityRecord): string {
  const c = String(canonical.type || "").toLowerCase();
  const i = String(incoming.type || "").toLowerCase();
  if (c === "liability" || i === "liability") return "liability";
  return c || i || "liability";
}

/** Classification fields a bill shell must not overwrite on a real debt. */
const CLASSIFICATION_FIELDS = ["category", "subtype", "liabilityType", "kind"];

/** Fields that describe WHERE a value came from, never merged over. */
const PROVENANCE_FIELDS = ["source", "_import"];

const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * The payment amount the whole app reads, in every spelling it reads it under.
 *
 * The duplicate pair disagreed about this: the loan stored `monthlyPayment`,
 * the twin stored `monthlyAmount`/`amount`, and a reader that happened to know
 * only one spelling saw either a payment or nothing. After a merge all three
 * carry the same number, so no surface can report a different one.
 */
export function reconcileLiabilityPaymentFields(
  fields: Record<string, any>,
  typeKey?: string | null,
): Record<string, any> {
  const out = { ...fields };
  const recurring = isRecurringBill(typeKey);
  // A debt's scheduled installment is authoritative; a bill's is its amount.
  const order = recurring
    ? ["monthlyAmount", "amount", "monthlyPayment"]
    : ["monthlyPayment", "monthlyAmount", "amount"];
  let canonical: number | undefined;
  for (const key of order) {
    const n = Number(out[key]);
    if (Number.isFinite(n) && n > 0) { canonical = n; break; }
  }
  if (canonical === undefined) return out;
  for (const key of ["monthlyPayment", "monthlyAmount", "amount"]) {
    if (key === "amount" && !recurring && isEmptyValue(out.amount)) continue; // don't invent a bill amount on a loan
    out[key] = canonical;
  }
  return out;
}

/**
 * Fold `incoming` into the record it turned out to be.
 *
 * Incoming values fill blanks and refresh real values, with three exceptions
 * that exist because the incoming record is often the LESS informed of the two:
 *   • classification fields keep the canonical answer when it has one, and
 *     never take a placeholder like `category: "liability"`;
 *   • provenance is never overwritten;
 *   • empty values never erase stored ones.
 */
export function mergeLiabilityRecords(
  canonical: LiabilityRecord,
  incoming: LiabilityRecord,
): { name: string; type: string; type_key?: string; fields: Record<string, any> } {
  const canonicalFields = (canonical.fields && typeof canonical.fields === "object") ? { ...canonical.fields } : {};
  const incomingFields = (incoming.fields && typeof incoming.fields === "object") ? incoming.fields : {};
  const merged: Record<string, any> = { ...canonicalFields };

  for (const [key, value] of Object.entries(incomingFields)) {
    if (isEmptyValue(value)) continue;
    if (PROVENANCE_FIELDS.includes(key) && !isEmptyValue(merged[key])) continue;
    if (CLASSIFICATION_FIELDS.includes(key)) {
      if (!isEmptyValue(merged[key])) continue;
      if (GENERIC_CLASSIFICATION_VALUES.has(String(value).trim().toLowerCase())) continue;
    }
    merged[key] = value;
  }

  const typeKey = preferLiabilityTypeKey(canonical, incoming);
  return {
    // The more specific record names it: a bare "Car Loan payment" never
    // renames the loan it pays.
    name: preferLiabilityName(canonical, incoming),
    type: preferLiabilityType(canonical, incoming),
    ...(typeKey ? { type_key: typeKey } : {}),
    fields: reconcileLiabilityPaymentFields(merged, typeKey),
  };
}

/** The name the merged record keeps — never the "… payment" spelling of itself. */
export function preferLiabilityName(canonical: LiabilityRecord, incoming: LiabilityRecord): string {
  const c = String(canonical.name ?? "").trim();
  const i = String(incoming.name ?? "").trim();
  if (!c) return i;
  if (!i) return c;
  const cIsPaymentSpelling = liabilityNameKey(c) !== c.toLowerCase();
  const iIsPaymentSpelling = liabilityNameKey(i) !== i.toLowerCase();
  if (cIsPaymentSpelling && !iIsPaymentSpelling) return i;
  return c;
}

/**
 * The subtype a surface should LABEL a liability with — read from the registry
 * key first, so a card and a filter chip cannot disagree with the family that
 * decides whether the same liability is fixed or variable. `fields.subtype` is
 * only a fallback for rows written before the key existed.
 */
export function liabilitySubtypeKey(rec: LiabilityRecord | null | undefined): string {
  const key = typeKeyOf(rec);
  if (key && !GENERIC_TYPE_KEYS.has(key)) return key;
  const fields = (rec?.fields && typeof rec.fields === "object") ? rec.fields as Record<string, any> : {};
  for (const candidate of [fields.subtype, fields.liabilityType, fields.kind, fields.category]) {
    const s = String(candidate ?? "").trim().toLowerCase();
    if (s && !GENERIC_CLASSIFICATION_VALUES.has(s)) return s;
  }
  return key || "other";
}

/** Whether the merged record's payment is fixed (amortizing) or variable. */
export function liabilityPaymentShape(rec: LiabilityRecord | null | undefined): "fixed" | "variable" {
  return liabilityFamily(typeKeyOf(rec) || undefined) === "amortizing" ? "fixed" : "variable";
}

/** True when a record is a bill shell rather than a debt instrument. */
export function isBillShell(rec: LiabilityRecord | null | undefined): boolean {
  return isRecurringBillProfile(rec as any) || classificationRank(rec) <= 1;
}
